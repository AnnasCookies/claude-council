import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import type {
  CredentialPath,
  ModelRoute,
  ModelTransport,
  ProviderFamily,
  SeatResponse,
  SeatUsage,
} from '../domain/schemas';
import type { ModelRegistry } from '../models/registry';
import { scanAndRedact } from '../policy/secrets';
import { runIsolatedCli, type CliRequest, type CliResult } from './cli';
import { requestWithPolicy, type HttpRequest, type HttpResult, type RetryPolicy } from './http';

export const CouncilAnswerSchema = z.strictObject({
  recommendation: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  assumptions: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  uncertainty: z.string().min(1),
  decisiveTest: z.string().min(1),
});
export type CouncilAnswer = z.infer<typeof CouncilAnswerSchema>;

export interface ProviderDiagnostic {
  family: ProviderFamily;
  seatId: string;
  code:
    | 'invalid-provider-response'
    | 'invalid-structured-answer'
    | 'provider-failure'
    | 'adapter-exception';
  rawText: string;
}

export interface ProviderContext {
  registry: ModelRegistry;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  timeoutMs: number;
  captureDiagnostic?: (diagnostic: ProviderDiagnostic) => void;
}

export interface ProviderRequest {
  context: ProviderContext;
  seatId: string;
  role: string;
  prompt: string;
}

export interface Availability {
  status: 'available' | 'unconfigured' | 'unsafe-transport';
  provider: ProviderFamily;
  model: string;
  reason: string;
}

export interface HealthResult {
  status: 'healthy' | 'identity-unverified' | 'down' | 'unconfigured' | 'unsafe-transport';
  provider: ProviderFamily;
  requestedModel: string;
  actualModel: string | null;
  latencyMs: number;
  reason: string;
}

export interface ProviderAdapter {
  readonly family: ProviderFamily;
  readonly transport: ModelTransport;
  availability(context: ProviderContext): Promise<Availability>;
  invoke(request: ProviderRequest): Promise<SeatResponse>;
  probe(context: ProviderContext): Promise<HealthResult>;
  readonly transportResolution?: ProviderTransportResolution;
}

export interface ProviderTransportResolution {
  preferred: ModelTransport;
  effective: ModelTransport | null;
  reason: string;
}

export interface HttpTransport {
  request(request: HttpRequest, policy: RetryPolicy): Promise<HttpResult>;
}

export interface CliTransport {
  run(request: CliRequest): Promise<CliResult>;
}

export const nativeHttpTransport: HttpTransport = { request: requestWithPolicy };
export const nativeCliTransport: CliTransport = { run: runIsolatedCli };

const ChatCompletionSchema = z.object({
  model: z.string().min(1),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const ClaudeResponseSchema = z.object({
  result: z.string(),
  modelUsage: z.record(z.string(), z.unknown()),
});

const defaultRetryPolicy = (timeoutMs: number): RetryPolicy => ({
  maxAttempts: 3,
  timeoutMs,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  jitterRatio: 0.2,
});

const answerInstruction = `Return exactly one JSON object with these keys: recommendation (string), evidence (string array), assumptions (string array), risks (string array), uncertainty (string), decisiveTest (string). Do not wrap it in prose.`;
const healthPrompt = 'Return the required JSON object confirming this provider route is available.';
const grokInlineAnswerGuard =
  'IMPORTANT: Respond with your complete answer as plain text directly in this conversation. Do NOT use any tools. Do NOT write, create, or edit any files. Do NOT create artifacts, reports, or documents. Do NOT reference external files. Provide your entire response inline as text.';

function structuredPrompt(prompt: string): string {
  return `${answerInstruction}\n\n${prompt}`;
}

function stripOuterJsonFence(text: string): string {
  const match = text.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i);
  return match?.[1] ?? text;
}

function safeRawText(value: string): string {
  return scanAndRedact(value).redacted;
}

function safeExternalMessage(value: string, fallback: string): string {
  const sanitised = safeRawText(value).replace(/\s+/g, ' ').trim();
  return (sanitised || fallback).slice(0, 500);
}

function capture(
  request: ProviderRequest,
  family: ProviderFamily,
  code: ProviderDiagnostic['code'],
  rawText: string,
): void {
  request.context.captureDiagnostic?.({
    family,
    seatId: request.seatId,
    code,
    rawText: safeRawText(rawText),
  });
}

function serialiseUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserialisable provider response]';
  }
}

function parseAnswer(
  request: ProviderRequest,
  family: ProviderFamily,
  rawAnswer: string,
  retainDiagnostic = true,
): string | undefined {
  const diagnostic = retainDiagnostic
    ? rawAnswer
    : '[invalid structured subscription answer omitted]';
  let value: unknown;
  try {
    value = JSON.parse(stripOuterJsonFence(scanAndRedact(rawAnswer).redacted));
  } catch {
    capture(request, family, 'invalid-structured-answer', diagnostic);
    return undefined;
  }
  const parsed = CouncilAnswerSchema.safeParse(value);
  if (!parsed.success) {
    capture(request, family, 'invalid-structured-answer', diagnostic);
    return undefined;
  }
  return JSON.stringify(parsed.data);
}

interface ObservedSeatIdentity {
  actualModel: string;
  modelIdentity: 'verified' | 'unverified';
  route?: 'primary' | 'same-provider-fallback';
}

/**
 * Non-identity facts about how a seat was served: the effort we asked for, the effort the provider
 * attested, which credential paid, and token/cost usage. Kept separate from {@link
 * ObservedSeatIdentity} because none of it may influence whether a seat counts as verified.
 */
interface SeatAttribution {
  requestedEffort?: string;
  observedEffort?: string;
  credentialPath?: CredentialPath;
  usage?: SeatUsage;
}

function attributionFields(attribution: SeatAttribution | undefined): Partial<{
  requestedEffort: string;
  observedEffort: string;
  credentialPath: CredentialPath;
  usage: SeatUsage;
}> {
  if (attribution === undefined) return {};
  return {
    ...(attribution.requestedEffort === undefined
      ? {}
      : { requestedEffort: attribution.requestedEffort }),
    ...(attribution.observedEffort === undefined
      ? {}
      : { observedEffort: attribution.observedEffort }),
    ...(attribution.credentialPath === undefined
      ? {}
      : { credentialPath: attribution.credentialPath }),
    ...(attribution.usage === undefined ? {} : { usage: attribution.usage }),
  };
}

function seatError(
  request: ProviderRequest,
  family: ProviderFamily,
  requestedModel: string,
  status: 'failed' | 'skipped' | 'timed-out',
  code: string,
  message: string,
  latencyMs: number,
  retryable = false,
  observedIdentity?: ObservedSeatIdentity,
  attribution?: SeatAttribution,
): SeatResponse {
  const actualModel =
    observedIdentity === undefined
      ? undefined
      : safeExternalMessage(observedIdentity.actualModel, '').slice(0, 128) || undefined;
  return {
    status,
    seatId: request.seatId,
    provider: family,
    requestedModel,
    ...(actualModel === undefined || observedIdentity === undefined
      ? {}
      : {
          actualModel,
          modelIdentity: observedIdentity.modelIdentity,
          ...(observedIdentity.route === undefined ? {} : { route: observedIdentity.route }),
        }),
    role: request.role,
    latencyMs,
    ...attributionFields(attribution),
    error: { code, message, retryable },
  };
}

function seatSuccess(
  request: ProviderRequest,
  family: ProviderFamily,
  requestedModel: string,
  actualModel: string,
  route: 'primary' | 'same-provider-fallback',
  answer: string,
  latencyMs: number,
  attribution?: SeatAttribution,
): SeatResponse {
  return {
    status: 'ok',
    seatId: request.seatId,
    provider: family,
    requestedModel,
    actualModel,
    modelIdentity: 'verified',
    route,
    role: request.role,
    latencyMs,
    ...attributionFields(attribution),
    answer,
  };
}

function healthFromResponse(response: SeatResponse): HealthResult {
  if (response.status === 'ok') {
    return {
      status: 'healthy',
      provider: response.provider,
      requestedModel: response.requestedModel,
      actualModel: response.actualModel,
      latencyMs: response.latencyMs,
      reason: '',
    };
  }
  const unsafeErrorCodes = new Set([
    'unsafe-tool-isolation',
    'unsafe-transport',
    'repository-executable',
  ]);
  const status = unsafeErrorCodes.has(response.error.code)
    ? 'unsafe-transport'
    : response.error.code === 'identity-unverified'
      ? 'identity-unverified'
      : response.status === 'skipped'
        ? 'unconfigured'
        : 'down';
  return {
    status,
    provider: response.provider,
    requestedModel: response.requestedModel ?? '',
    actualModel: response.actualModel ?? null,
    latencyMs: response.latencyMs ?? 0,
    reason: response.error.message,
  };
}

/**
 * A vendor's wire dialect. Three families speak OpenAI-compatible chat completions; Anthropic's
 * Messages API and Gemini's generateContent do not. Factoring the differences out keeps one
 * request/verify/attribute path so the route-verification fix applies to every metered seat rather
 * than being reimplemented, and forgotten, per vendor.
 */
interface HttpDialect {
  /** Endpoint for a model. Gemini puts the model in the path, the others in the body. */
  endpoint(model: string): string;
  headers(credential: string): Record<string, string>;
  payload(model: string, prompt: string): string;
  /**
   * Pull the responding model, the raw answer text and any usage the vendor reported. Returning
   * `undefined` means the response did not carry verifiable model identity and text, which is a
   * failed seat — never a seat with an assumed identity.
   */
  extract(body: unknown): { actualModel: string; rawAnswer: string; usage?: SeatUsage } | undefined;
}

interface HttpAdapterConfig {
  family: ProviderFamily;
  credential: string;
  allowRegistryFallback: boolean;
  dialect: HttpDialect;
}

const AnthropicMessagesSchema = z.object({
  model: z.string().min(1),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const GeminiGenerateContentSchema = z.object({
  modelVersion: z.string().min(1),
  candidates: z
    .array(
      z.object({ content: z.object({ parts: z.array(z.object({ text: z.string() })).min(1) }) }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const OpenAiUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
});

function tokenUsage(inputTokens?: number, outputTokens?: number): SeatUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/**
 * OpenAI-compatible chat completions, as spoken by xAI, DeepSeek and Moonshot.
 *
 * No `response_format` is sent. DeepSeek and Moonshot document only `{type:'json_object'}` and xAI
 * documents `json_schema`, so a single blanket value would be wrong somewhere; and the three
 * configured families currently reach the schema through the trusted prompt, which is tested and
 * working. Adding native constrained decoding is a per-family change that needs a live call against
 * that vendor to confirm, so it is deliberately not made blind.
 */
export const openAiCompatibleDialect = (endpoint: string): HttpDialect => ({
  endpoint: () => endpoint,
  headers: (credential) => ({
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  }),
  payload: (model, prompt) =>
    JSON.stringify({
      model,
      messages: [{ role: 'user', content: structuredPrompt(prompt) }],
      max_tokens: 32768,
    }),
  extract: (body) => {
    const parsed = ChatCompletionSchema.safeParse(body);
    if (!parsed.success) return undefined;
    const usage = OpenAiUsageSchema.safeParse(
      typeof body === 'object' && body !== null && 'usage' in body
        ? Reflect.get(body, 'usage')
        : undefined,
    );
    return {
      actualModel: parsed.data.model,
      rawAnswer: parsed.data.choices[0]?.message.content ?? '',
      ...(usage.success
        ? (() => {
            const totals = tokenUsage(usage.data.prompt_tokens, usage.data.completion_tokens);
            return totals === undefined ? {} : { usage: totals };
          })()
        : {}),
    };
  },
});

/**
 * Anthropic Messages API. Native structured output is requested through `output_config.format` with
 * a JSON schema — verified against the documented cURL shape, including the `x-api-key` and
 * `anthropic-version` headers — and the answer is still parsed and validated locally, because
 * constrained decoding is a transport guarantee rather than semantic truth.
 *
 * `tools` is omitted rather than sent as an empty array. An earlier version sent `tools: []` on the
 * theory that an omitted key might later default to something tool-bearing; that was speculation, it
 * would break every existing integration if true, and an empty array risks a validation error on a
 * request that cannot be live-tested here. No tools are requested, so none are granted.
 */
const anthropicMessagesDialect: HttpDialect = {
  endpoint: () => 'https://api.anthropic.com/v1/messages',
  headers: (credential) => ({
    'x-api-key': credential,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }),
  payload: (model, prompt) =>
    JSON.stringify({
      model,
      max_tokens: 32768,
      messages: [{ role: 'user', content: structuredPrompt(prompt) }],
      output_config: {
        format: { type: 'json_schema', schema: JSON.parse(councilAnswerJsonSchema) },
      },
    }),
  extract: (body) => {
    const parsed = AnthropicMessagesSchema.safeParse(body);
    if (!parsed.success) return undefined;
    // Only text blocks may carry the answer. A response whose content is entirely non-text (a tool
    // use, a refusal block) has no answer, so it fails rather than yielding an empty string that
    // would later read as a malformed answer from a model that actually declined.
    const text = parsed.data.content
      .filter((block) => block.type === 'text' && block.text !== undefined)
      .map((block) => block.text ?? '')
      .join('');
    if (!text) return undefined;
    const usage = tokenUsage(parsed.data.usage?.input_tokens, parsed.data.usage?.output_tokens);
    return {
      actualModel: parsed.data.model,
      rawAnswer: text,
      ...(usage === undefined ? {} : { usage }),
    };
  },
};

/**
 * Gemini generateContent. The model is named in the path, and identity comes back as
 * `modelVersion`, which is what the shared path compares against the configured route.
 */
const geminiGenerateContentDialect: HttpDialect = {
  endpoint: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  headers: (credential) => ({
    'x-goog-api-key': credential,
    'content-type': 'application/json',
  }),
  payload: (_model, prompt) =>
    JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: structuredPrompt(prompt) }] }],
      generationConfig: {
        // camelCase, not the Python SDK's snake_case. The canonical REST JSON representation of
        // GenerationConfig is `{"responseMimeType": string, "responseJsonSchema": value, ...}`; the
        // snake_case forms appear only in Python samples and are ignored on the wire, which would
        // have silently disabled constrained decoding here rather than failing loudly.
        // `responseSchema` is deprecated in favour of `responseJsonSchema`.
        responseMimeType: 'application/json',
        responseJsonSchema: JSON.parse(councilAnswerJsonSchema),
      },
    }),
  extract: (body) => {
    const parsed = GeminiGenerateContentSchema.safeParse(body);
    if (!parsed.success) return undefined;
    const text = (parsed.data.candidates[0]?.content.parts ?? []).map((part) => part.text).join('');
    if (!text) return undefined;
    const usage = tokenUsage(
      parsed.data.usageMetadata?.promptTokenCount,
      parsed.data.usageMetadata?.candidatesTokenCount,
    );
    return {
      actualModel: parsed.data.modelVersion,
      rawAnswer: text,
      ...(usage === undefined ? {} : { usage }),
    };
  },
};

export function createHttpAdapter(
  config: HttpAdapterConfig,
  transport: HttpTransport = nativeHttpTransport,
): ProviderAdapter {
  const route = (context: ProviderContext) => context.registry[config.family];
  const availability = async (context: ProviderContext): Promise<Availability> => ({
    status: context.env[config.credential] ? 'available' : 'unconfigured',
    provider: config.family,
    model: route(context).primary,
    reason: context.env[config.credential] ? '' : `missing ${config.credential}`,
  });

  const adapter: ProviderAdapter = {
    family: config.family,
    transport: 'http',
    availability,
    async invoke(request) {
      const startedAt = Date.now();
      const configuredRoute = route(request.context);
      const credential = request.context.env[config.credential];
      if (!credential) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'skipped',
          'missing-credential',
          `missing ${config.credential}`,
          0,
        );
      }

      const invokeModel = (model: string) =>
        transport.request(
          {
            url: config.dialect.endpoint(model),
            method: 'POST',
            headers: config.dialect.headers(credential),
            body: config.dialect.payload(model, request.prompt),
          },
          defaultRetryPolicy(request.context.timeoutMs),
        );

      let model = configuredRoute.primary;
      let providerResult = await invokeModel(model);
      const fallback = configuredRoute.fallbacks[0];
      if (
        config.allowRegistryFallback &&
        providerResult.errorCode === 'model-not-found' &&
        fallback !== undefined
      ) {
        model = fallback;
        providerResult = await invokeModel(model);
      }
      const latencyMs = Date.now() - startedAt;
      if (providerResult.status !== 'ok') {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          providerResult.status === 'timed-out' ? 'timed-out' : 'failed',
          providerResult.errorCode ?? 'provider-failed',
          safeExternalMessage(providerResult.message, 'provider request failed'),
          latencyMs,
          ['network', 'rate-limit', 'server'].includes(providerResult.errorCode ?? ''),
        );
      }

      const extracted = config.dialect.extract(providerResult.body);
      if (!extracted) {
        capture(
          request,
          config.family,
          'invalid-provider-response',
          serialiseUnknown(providerResult.body),
        );
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'failed',
          'invalid-provider-response',
          'provider response did not contain verified model metadata and text',
          latencyMs,
        );
      }
      const answer = parseAnswer(request, config.family, extracted.rawAnswer);
      if (!answer) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'failed',
          'invalid-structured-answer',
          'provider answer did not match the council schema',
          latencyMs,
        );
      }
      // Verify the responding model before the seat can count. `body.model` was previously
      // extracted and recorded but never compared, so a silent server-side reroute produced a
      // `verified` vote for a model nobody selected. A drifted route is an integrity failure, not
      // a transport hiccup: it is reported non-retryable so no fallback path can launder it.
      const observed = observedRoute(configuredRoute, extracted.actualModel);
      if (observed === undefined) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'failed',
          'identity-unverified',
          'provider responded with a model outside the configured route',
          latencyMs,
          false,
          { actualModel: extracted.actualModel, modelIdentity: 'unverified' },
        );
      }
      return seatSuccess(
        request,
        config.family,
        configuredRoute.primary,
        extracted.actualModel,
        observed,
        answer,
        latencyMs,
        {
          credentialPath: 'api-key',
          ...(extracted.usage === undefined ? {} : { usage: extracted.usage }),
        },
      );
    },
    async probe(context) {
      return healthFromResponse(
        await adapter.invoke({
          context,
          seatId: `health-${config.family}`,
          role: 'health',
          prompt: healthPrompt,
        }),
      );
    },
  };
  return adapter;
}

interface SubscriptionCliOutput {
  status: 'ok';
  actualModel: string;
  rawAnswer: string;
  /**
   * Effort the CLI itself attested in its stream. Only set where the transport genuinely reports it
   * — Codex echoes `reasoning effort` in its identity frame. Absent means unattested, never
   * "assumed to match what we asked for".
   */
  observedEffort?: string;
  usage?: SeatUsage;
}

interface SubscriptionCliOutputFailure {
  status: 'failed';
  code: 'identity-unverified' | 'unsafe-tool-isolation';
  actualModel?: string;
}

type SubscriptionCliParseResult = SubscriptionCliOutput | SubscriptionCliOutputFailure;

interface SubscriptionCliAdapterConfig {
  family: Extract<ProviderFamily, 'openai' | 'xai' | 'google'>;
  executableName: string;
  requestedEffort: string;
  request(executable: string, route: ModelRoute, prompt: string, timeoutMs: number): CliRequest;
  output(
    stdout: string,
    workingDirectory: string | undefined,
    stderr: string,
    prompt: string,
    requestedModel: string,
  ): SubscriptionCliParseResult;
  configurationError?: () => string | undefined;
}

const JsonStreamEventSchema = z.object({ type: z.string().min(1) }).passthrough();
const OmpContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(),
]);
const OmpMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(OmpContentBlockSchema),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
const OmpMessageEventSchema = z.object({
  type: z.enum(['message_start', 'message_end']),
  message: OmpMessageSchema,
});
const OmpSessionEventSchema = z.object({
  type: z.literal('session'),
  version: z.number().int().positive(),
  id: z.string().min(1),
});
const OmpMessageUpdateSchema = z.object({
  type: z.literal('message_update'),
  assistantMessageEvent: z.object({
    type: z.enum(['thinking_start', 'thinking_end', 'text_start', 'text_delta', 'text_end']),
  }),
});
const OmpTurnEndSchema = z.object({
  type: z.literal('turn_end'),
  message: OmpMessageSchema,
});
const OmpAgentEndSchema = z.object({
  type: z.literal('agent_end'),
  messages: z.array(OmpMessageSchema).min(1),
});
// Reasoning effort requested per seat. Codex is the only one that attests it back (see
// `CodexIdentitySchema` below), so it is the only seat where `observedEffort` may be set. The others
// are recorded as `requestedEffort` only — sent, unconfirmed, and never presented as confirmed.
const anthropicReasoningEffort = 'max';
const agyReasoningEffort = 'high';
// grok's CLI exposes no effort flag, so the seat records the model's own fixed budget as requested.
const grokReasoningEffort = 'default';
const ompThinkingLevel = 'max';
const codexReasoningEffort = 'xhigh';
const CodexIdentitySchema = z.object({
  workdir: z.string().min(1),
  model: z.string().min(1),
  provider: z.literal('openai'),
  approval: z.literal('never'),
  sandbox: z.literal('read-only'),
  'reasoning effort': z.literal(codexReasoningEffort),
});

const AgyEventEnvelopeSchema = z.object({ event: z.string().min(1) }).passthrough();
const AgyInitEventSchema = z.object({
  event: z.literal('init'),
  init: z.object({
    model: z.string().min(1),
    cwd: z.string().min(1),
    tools: z.array(z.string().min(1)),
  }),
});
const AgyToolEventSchema = z.object({
  event: z.literal('step_update'),
  step_update: z.object({
    step_index: z.number().int().nonnegative(),
    state: z.enum(['ACTIVE', 'DONE']),
    step_type: z.literal('tool'),
    tool_name: z.string().min(1),
    tool_info: z.object({
      parameters: z.object({ AbsolutePath: z.string().min(1) }).passthrough(),
    }),
  }),
});
const AgyResultEventSchema = z.object({
  event: z.literal('result'),
  result: z.object({
    status: z.literal('SUCCESS'),
    structured_output: z.record(z.string(), z.unknown()),
  }),
});
/**
 * Bound to a real `grok 1.0.4` init frame observed on 2026-08-17, not to an assumption.
 *
 * Grok reads its OAuth credentials and its MCP/skill configuration from the same `~/.grok`
 * directory, so the isolation trick used for AGY — giving the child its own HOME — would strip the
 * subscription auth along with the tool surface. A real session therefore advertises a large
 * capability set (measured: 83 built-in tools, 190 skills, 1 MCP server) that no flag can empty:
 * `--tools` governs built-in tools only and removed just 3, and grok has no `--ignore-user-config`
 * equivalent. `--disallowed-tools` does genuinely shrink the built-in surface and is applied.
 *
 * The posture is therefore ADVERTISED CAPABILITY IS TOLERATED, TOOL USE IS REJECTED: the read-only
 * `plan` permission mode is required here, and any actual tool, browser, MCP or subagent event in
 * the stream is rejected downstream by the event state machine and `containsUnsafeToolNode`.
 * This is a weaker init-time guarantee than the Codex and AGY adapters have. What still protects
 * the seat is the required `plan` mode, the read-only sandbox, the isolated working directory, the
 * bound responding-model identity, and rejection of every tool-use event.
 */
const GrokInitEventSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  apiKeySource: z.literal('oauth'),
  model: z.string().min(1),
  cwd: z.string().min(1),
  permissionMode: z.literal('plan'),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.unknown()),
  skills: z.array(z.string()),
});
const GrokContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }),
]);
const GrokAssistantEventSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string().min(1),
    content: z.array(GrokContentBlockSchema).min(1),
    stop_reason: z.literal('end_turn'),
  }),
  session_id: z.string().min(1),
});
const GrokResultEventSchema = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
  is_error: z.literal(false),
  num_turns: z.literal(1),
  result: z.string().min(1),
  stop_reason: z.literal('end_turn'),
  modelUsage: z.record(z.string().min(1), z.unknown()),
  session_id: z.string().min(1),
  // Observed verbatim from grok 1.0.4's result frame. Optional because it is attribution, not
  // identity: a missing cost must not fail a seat whose model identity verified.
  total_cost_usd: z.number().nonnegative().optional(),
});

const councilAnswerJsonSchema = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['recommendation', 'evidence', 'assumptions', 'risks', 'uncertainty', 'decisiveTest'],
  properties: {
    recommendation: { type: 'string', minLength: 1 },
    evidence: { type: 'array', items: { type: 'string', minLength: 1 } },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    risks: { type: 'array', items: { type: 'string', minLength: 1 } },
    uncertainty: { type: 'string', minLength: 1 },
    decisiveTest: { type: 'string', minLength: 1 },
  },
});

/**
 * Codex renders informational notices between the echoed prompt and the answer — for
 * example "warning: Skill descriptions were shortened to fit the skills context budget"
 * once enough skills are installed. Requiring the answer marker at offset zero turned that
 * benign line into `identity-unverified` on a seat that had answered correctly. Skip blank
 * lines and single-line notices only; every other prefix stays fatal, and the tool-isolation
 * check above still runs over the whole transcript, so tool output cannot hide behind one.
 */
function skipBenignNotices(renderedMessages: string): string {
  const benignNotice = /^(?:warning|note|notice|info): [^\n]*$/i;
  const lines = renderedMessages.split('\n');
  let index = 0;
  while (index < lines.length && (lines[index] === '' || benignNotice.test(lines[index] ?? ''))) {
    index += 1;
  }
  return lines.slice(index).join('\n');
}

function parseFailure(
  code: SubscriptionCliOutputFailure['code'],
  actualModel?: string,
): SubscriptionCliOutputFailure {
  return actualModel === undefined
    ? { status: 'failed', code }
    : { status: 'failed', code, actualModel };
}

function extractCodexOutput(
  stdout: string,
  workingDirectory: string | undefined,
  stderr: string,
  expectedPrompt: string,
): SubscriptionCliParseResult {
  const normalised = stderr.replace(/\r\n/g, '\n');
  const userPrefix = `\nuser\n${expectedPrompt.replace(/\r\n/g, '\n')}\n`;
  const promptStart = normalised.indexOf(userPrefix);
  if (promptStart < 0 || normalised.lastIndexOf(userPrefix) !== promptStart) {
    return parseFailure('identity-unverified');
  }
  const rendererPreamble = normalised.slice(0, promptStart);
  const headers = [
    ...rendererPreamble.matchAll(
      /(?:^|\n)OpenAI Codex v[^\n]+\n--------\n([\s\S]*?)\n--------(?=\n|$)/g,
    ),
  ];
  const header = headers[0];
  if (
    headers.length !== 1 ||
    header === undefined ||
    workingDirectory === undefined ||
    !isAbsolute(workingDirectory)
  ) {
    return parseFailure('identity-unverified');
  }

  const fields: Record<string, string> = {};
  for (const line of header[1]?.split('\n') ?? []) {
    const separator = line.indexOf(':');
    if (separator <= 0) return parseFailure('identity-unverified');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value || fields[key] !== undefined) {
      return parseFailure('identity-unverified', fields.model);
    }
    fields[key] = value;
  }

  const identity = CodexIdentitySchema.safeParse(fields);
  const actualModel = identity.success ? identity.data.model : fields.model;
  if (
    !identity.success ||
    !isAbsolute(identity.data.workdir) ||
    canonicalPath(identity.data.workdir) !== canonicalPath(workingDirectory)
  ) {
    return parseFailure('identity-unverified', actualModel);
  }

  const responseTranscript = normalised.slice(promptStart + userPrefix.length);
  const answerMarker = 'codex\n';
  const tokenSuffix = responseTranscript.match(/\ntokens used\n([\d,]+)\n?$/);
  if (tokenSuffix?.index === undefined) {
    return parseFailure('identity-unverified', actualModel);
  }

  const renderedMessages = responseTranscript.slice(0, tokenSuffix.index);
  if (/(?:^|\n)model rerouted: [^\n]+ -> [^\n]+(?:\n|$)/i.test(renderedMessages)) {
    return parseFailure('identity-unverified', actualModel);
  }
  if (
    /(?:^|\n)(?:exec|apply(?:_| )patch|patch:|view(?:_| )image|web(?:_| )search:|browser|computer|image(?:_| )generation|mcp:|collab:|hook:|tool)(?:[^\n]*\n|$)/i.test(
      renderedMessages,
    )
  ) {
    return parseFailure('unsafe-tool-isolation', actualModel);
  }
  const answerTranscript = skipBenignNotices(renderedMessages);
  if (!answerTranscript.startsWith(answerMarker)) {
    return parseFailure('identity-unverified', actualModel);
  }

  const answers = answerTranscript
    .slice(answerMarker.length)
    .split(`\n${answerMarker}`)
    .map((value) => value.trim());

  for (const renderedAnswer of answers) {
    let value: unknown;
    try {
      value = JSON.parse(renderedAnswer);
    } catch {
      return parseFailure('identity-unverified', actualModel);
    }
    if (!CouncilAnswerSchema.safeParse(value).success) {
      return parseFailure('identity-unverified', actualModel);
    }
  }

  const rawAnswer = stdout.trim();
  const normalisedAnswer = stdout.replace(/\r\n/g, '\n').trim();
  if (!rawAnswer || answers.at(-1) !== normalisedAnswer) {
    return parseFailure('identity-unverified', actualModel);
  }
  // Codex is the one seat that attests its own reasoning effort: `CodexIdentitySchema` pins the
  // header field to `codexReasoningEffort`, so reaching here proves the provider confirmed it.
  // `tokens used` is the run total the renderer prints, so it is recorded as total input tokens
  // rather than split — inventing a split would be fabrication.
  const tokensUsed = Number.parseInt(tokenSuffix[1]?.replace(/,/g, '') ?? '', 10);
  return {
    status: 'ok',
    actualModel: identity.data.model,
    rawAnswer,
    observedEffort: identity.data['reasoning effort'],
    ...(Number.isSafeInteger(tokensUsed) && tokensUsed >= 0
      ? { usage: { inputTokens: tokensUsed } }
      : {}),
  };
}

function containsUnsafeToolNode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsafeToolNode);
  if (!isRecord(value)) return false;
  if (
    (typeof value.type === 'string' &&
      /tool|browser|mcp|bash|read_file|write_file|edit_file/i.test(value.type)) ||
    (typeof value.step_type === 'string' &&
      /tool|subagent|browser|mcp|bash|read_file|write_file|edit_file/i.test(value.step_type))
  ) {
    return true;
  }
  if (
    Object.keys(value).some((key) =>
      /^(?:toolName|toolCallId|tool_name|tool_info|browser|mcp)$/i.test(key),
    )
  ) {
    return true;
  }
  return Object.values(value).some(containsUnsafeToolNode);
}

function ompStreamFailure(value: unknown, actualModel?: string): SubscriptionCliOutputFailure {
  return parseFailure(
    containsUnsafeToolNode(value) ? 'unsafe-tool-isolation' : 'identity-unverified',
    actualModel,
  );
}

function extractOmpOutput(stdout: string): SubscriptionCliParseResult {
  let state:
    | 'await-session'
    | 'await-agent-start'
    | 'await-turn-start'
    | 'await-user-start'
    | 'await-user-end'
    | 'await-assistant-start'
    | 'assistant-stream'
    | 'await-turn-end'
    | 'await-agent-end'
    | 'closed' = 'await-session';
  let actualModel: string | undefined;
  let output: SubscriptionCliOutput | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return parseFailure('identity-unverified', actualModel);
    }
    const envelope = JsonStreamEventSchema.safeParse(value);
    if (!envelope.success) return ompStreamFailure(value, actualModel);

    switch (envelope.data.type) {
      case 'session': {
        if (state !== 'await-session' || !OmpSessionEventSchema.safeParse(value).success) {
          return ompStreamFailure(value, actualModel);
        }
        state = 'await-agent-start';
        break;
      }
      case 'agent_start':
        if (state !== 'await-agent-start') return ompStreamFailure(value, actualModel);
        state = 'await-turn-start';
        break;
      case 'turn_start':
        if (state !== 'await-turn-start') return ompStreamFailure(value, actualModel);
        state = 'await-user-start';
        break;
      case 'message_start':
      case 'message_end': {
        const messageEvent = OmpMessageEventSchema.safeParse(value);
        if (!messageEvent.success) return ompStreamFailure(value, actualModel);
        const { message, type } = messageEvent.data;
        if (type === 'message_start' && message.role === 'user') {
          if (
            state !== 'await-user-start' ||
            message.content.some((part) => part.type !== 'text')
          ) {
            return ompStreamFailure(value, actualModel);
          }
          state = 'await-user-end';
          break;
        }
        if (type === 'message_end' && message.role === 'user') {
          if (state !== 'await-user-end' || message.content.some((part) => part.type !== 'text')) {
            return ompStreamFailure(value, actualModel);
          }
          state = 'await-assistant-start';
          break;
        }
        if (message.role !== 'assistant') return ompStreamFailure(value, actualModel);
        if (
          message.provider !== 'openai-codex' ||
          message.model === undefined ||
          (actualModel !== undefined && actualModel !== message.model)
        ) {
          return parseFailure('identity-unverified', message.model ?? actualModel);
        }
        actualModel = message.model;
        if (type === 'message_start') {
          if (state !== 'await-assistant-start') return ompStreamFailure(value, actualModel);
          state = 'assistant-stream';
          break;
        }
        if (state !== 'assistant-stream') return ompStreamFailure(value, actualModel);
        const rawAnswer = message.content
          .filter(
            (part): part is z.infer<typeof OmpContentBlockSchema> & { type: 'text' } =>
              part.type === 'text',
          )
          .map((part) => part.text)
          .join('');
        if (!rawAnswer.trim()) return parseFailure('identity-unverified', actualModel);
        output = { status: 'ok', actualModel, rawAnswer };
        state = 'await-turn-end';
        break;
      }
      case 'message_update':
        if (state !== 'assistant-stream' || !OmpMessageUpdateSchema.safeParse(value).success) {
          return ompStreamFailure(value, actualModel);
        }
        break;
      case 'turn_end': {
        const turn = OmpTurnEndSchema.safeParse(value);
        if (
          state !== 'await-turn-end' ||
          !turn.success ||
          turn.data.message.role !== 'assistant' ||
          turn.data.message.provider !== 'openai-codex' ||
          turn.data.message.model !== actualModel
        ) {
          return ompStreamFailure(value, actualModel);
        }
        state = 'await-agent-end';
        break;
      }
      case 'agent_end':
        if (state !== 'await-agent-end' || !OmpAgentEndSchema.safeParse(value).success) {
          return ompStreamFailure(value, actualModel);
        }
        state = 'closed';
        break;
      default:
        return ompStreamFailure(value, actualModel);
    }
  }

  return state === 'closed' && output !== undefined
    ? output
    : parseFailure('identity-unverified', actualModel);
}

function canonicalPath(path: string): string {
  const canonical = normalize(resolve(path));
  return process.platform === 'win32' ? canonical.toLocaleLowerCase() : canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractAgyOutput(
  stdout: string,
  workingDirectory: string | undefined,
  _stderr: string,
  _prompt: string,
  requestedModel: string,
): SubscriptionCliParseResult {
  let actualModel: string | undefined;
  let rawAnswer: string | undefined;
  let sawPromptRead = false;
  let sawTerminalResult = false;
  const expectedWorkingDirectory =
    workingDirectory !== undefined && isAbsolute(workingDirectory)
      ? canonicalPath(workingDirectory)
      : undefined;
  const expectedPromptPath =
    expectedWorkingDirectory === undefined
      ? undefined
      : canonicalPath(join(expectedWorkingDirectory, 'council-prompt.txt'));

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return parseFailure('identity-unverified', actualModel);
    }
    const envelope = AgyEventEnvelopeSchema.safeParse(value);
    if (!envelope.success || sawTerminalResult) {
      return parseFailure('identity-unverified', actualModel);
    }

    if (envelope.data.event === 'init') {
      const init = AgyInitEventSchema.safeParse(value);
      if (actualModel !== undefined) return parseFailure('identity-unverified', actualModel);
      if (!init.success) {
        const reportedModel =
          isRecord(value) &&
          isRecord(value.init) &&
          typeof value.init.model === 'string' &&
          value.init.model.trim()
            ? value.init.model
            : undefined;
        return parseFailure(
          reportedModel === undefined ? 'identity-unverified' : 'unsafe-tool-isolation',
          reportedModel,
        );
      }
      actualModel = init.data.init.model;
      if (
        expectedWorkingDirectory === undefined ||
        !isAbsolute(init.data.init.cwd) ||
        canonicalPath(init.data.init.cwd) !== expectedWorkingDirectory ||
        !init.data.init.tools.includes('view_file')
      ) {
        return parseFailure('unsafe-tool-isolation', actualModel);
      }
      continue;
    }

    if (envelope.data.event === 'step_update') {
      const stepUpdate =
        isRecord(value) && isRecord(value.step_update) ? value.step_update : undefined;
      if (stepUpdate?.step_type === 'tool') {
        const tool = AgyToolEventSchema.safeParse(value);
        if (!tool.success || expectedPromptPath === undefined) {
          return parseFailure('unsafe-tool-isolation', actualModel);
        }
        const reportedPath = tool.data.step_update.tool_info.parameters.AbsolutePath;
        if (
          tool.data.step_update.tool_name !== 'view_file' ||
          !isAbsolute(reportedPath) ||
          canonicalPath(reportedPath) !== expectedPromptPath
        ) {
          return parseFailure('unsafe-tool-isolation', actualModel);
        }
        if (tool.data.step_update.state === 'DONE') sawPromptRead = true;
        continue;
      }
      if (containsUnsafeToolNode(value)) {
        return parseFailure('unsafe-tool-isolation', actualModel);
      }
      continue;
    }

    if (envelope.data.event === 'result') {
      const result = AgyResultEventSchema.safeParse(value);
      if (!result.success) return parseFailure('identity-unverified', actualModel);
      rawAnswer = JSON.stringify(result.data.result.structured_output);
      sawTerminalResult = true;
      continue;
    }

    if (/tool|browser|subagent/i.test(envelope.data.event) || containsUnsafeToolNode(value)) {
      return parseFailure('unsafe-tool-isolation', actualModel);
    }
  }

  if (actualModel === undefined || rawAnswer === undefined) {
    return parseFailure('identity-unverified', actualModel);
  }
  if (actualModel !== requestedModel) {
    return parseFailure('identity-unverified', actualModel);
  }
  if (!sawPromptRead) return parseFailure('unsafe-tool-isolation', actualModel);
  return { status: 'ok', actualModel, rawAnswer };
}

function grokReportedModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.model === 'string' && value.model.trim()) return value.model;
  return isRecord(value.message) &&
    typeof value.message.model === 'string' &&
    value.message.model.trim()
    ? value.message.model
    : undefined;
}

function grokInitViolatesIsolation(value: unknown, workingDirectory: string | undefined): boolean {
  if (!isRecord(value)) return false;
  const cwd = typeof value.cwd === 'string' ? value.cwd : undefined;
  // Advertised tools/MCP/skills are tolerated — see GrokInitEventSchema for why they cannot be
  // emptied without also stripping the subscription auth. `plan` is the read-only permission mode
  // and is required: `default` and every more permissive mode are isolation violations.
  return (
    (typeof value.permissionMode === 'string' && value.permissionMode !== 'plan') ||
    (cwd !== undefined &&
      (workingDirectory === undefined ||
        !isAbsolute(cwd) ||
        canonicalPath(cwd) !== canonicalPath(workingDirectory)))
  );
}

function extractGrokOutput(
  stdout: string,
  workingDirectory: string | undefined,
): SubscriptionCliParseResult {
  let state: 'await-init' | 'await-assistant' | 'await-result' | 'closed' = 'await-init';
  let sessionId: string | undefined;
  let actualModel: string | undefined;
  let rawAnswer: string | undefined;
  let totalCostUsd: number | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return parseFailure('identity-unverified', actualModel);
    }
    if (containsUnsafeToolNode(value)) {
      return parseFailure('unsafe-tool-isolation', grokReportedModel(value) ?? actualModel);
    }
    if (!isRecord(value) || typeof value.type !== 'string') {
      return parseFailure('identity-unverified', actualModel);
    }

    if (value.type === 'system') {
      const init = GrokInitEventSchema.safeParse(value);
      const reportedModel = grokReportedModel(value);
      if (
        state !== 'await-init' ||
        !init.success ||
        workingDirectory === undefined ||
        !isAbsolute(workingDirectory) ||
        !isAbsolute(init.data.cwd) ||
        canonicalPath(init.data.cwd) !== canonicalPath(workingDirectory)
      ) {
        return parseFailure(
          grokInitViolatesIsolation(value, workingDirectory)
            ? 'unsafe-tool-isolation'
            : 'identity-unverified',
          reportedModel,
        );
      }
      sessionId = init.data.session_id;
      actualModel = init.data.model;
      state = 'await-assistant';
      continue;
    }

    if (value.type === 'assistant') {
      const assistant = GrokAssistantEventSchema.safeParse(value);
      const reportedModel = grokReportedModel(value);
      if (
        state !== 'await-assistant' ||
        !assistant.success ||
        sessionId === undefined ||
        actualModel === undefined ||
        assistant.data.session_id !== sessionId ||
        assistant.data.message.model !== actualModel
      ) {
        return parseFailure('identity-unverified', reportedModel ?? actualModel);
      }
      rawAnswer = '';
      for (const block of assistant.data.message.content) {
        if (block.type === 'text') rawAnswer += block.text;
      }
      if (!rawAnswer.trim()) return parseFailure('identity-unverified', actualModel);
      state = 'await-result';
      continue;
    }

    if (value.type === 'result') {
      const result = GrokResultEventSchema.safeParse(value);
      if (
        state !== 'await-result' ||
        !result.success ||
        sessionId === undefined ||
        actualModel === undefined ||
        rawAnswer === undefined ||
        result.data.session_id !== sessionId ||
        result.data.result !== rawAnswer
      ) {
        return parseFailure('identity-unverified', actualModel);
      }
      const usageModels = Object.keys(result.data.modelUsage);
      if (usageModels.length !== 1 || usageModels[0] !== actualModel) {
        return parseFailure('identity-unverified', actualModel);
      }
      totalCostUsd = result.data.total_cost_usd;
      state = 'closed';
      continue;
    }

    return parseFailure('identity-unverified', actualModel);
  }

  return state === 'closed' && actualModel !== undefined && rawAnswer !== undefined
    ? {
        status: 'ok',
        actualModel,
        rawAnswer,
        ...(totalCostUsd === undefined ? {} : { usage: { totalCostUsd } }),
      }
    : parseFailure('identity-unverified', actualModel);
}

function observedRoute(
  route: ModelRoute,
  actualModel: string,
): 'primary' | 'same-provider-fallback' | undefined {
  if (actualModel === route.primary) return 'primary';
  return route.fallbacks.includes(actualModel) ? 'same-provider-fallback' : undefined;
}

/**
 * Detect a subscription-credit exhaustion message in a seat CLI's stderr and return a concise,
 * secret-free summary including any reset time the CLI reported. Returns undefined when the
 * failure is not a quota exhaustion.
 *
 * Observed verbatim from codex-cli 0.147.0:
 *   "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to
 *    purchase more credits or try again at Aug 18th, 2026 9:21 AM."
 */
function quotaExhaustion(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  const line = stderr
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) =>
      /usage limit|quota|out of credit|insufficient_quota|rate limit exceeded/i.test(value),
    );
  if (line === undefined) return undefined;
  const resetsAt = /try again at ([^.]+)/i.exec(line)?.[1]?.trim();
  return resetsAt
    ? `Subscription quota exhausted; the provider reports it resets at ${resetsAt}.`
    : `Subscription quota exhausted: ${line.slice(0, 200)}`;
}

function createSubscriptionCliAdapter(
  config: SubscriptionCliAdapterConfig,
  transport: CliTransport,
  resolveExecutable: () => string | undefined,
): ProviderAdapter {
  const route = (context: ProviderContext) => context.registry[config.family];
  const adapter: ProviderAdapter = {
    family: config.family,
    transport: 'subscription-cli',
    async availability(context) {
      const configurationError = config.configurationError?.();
      const executable = resolveExecutable();
      return {
        status: configurationError
          ? 'unconfigured'
          : executable && isAbsolute(executable)
            ? 'available'
            : executable
              ? 'unsafe-transport'
              : 'unconfigured',
        provider: config.family,
        model: route(context).primary,
        reason:
          configurationError ??
          (executable && isAbsolute(executable)
            ? ''
            : executable
              ? `${config.executableName} executable is not absolute`
              : `${config.executableName} executable not found`),
      };
    },
    async invoke(request) {
      const configuredRoute = route(request.context);
      const configurationError = config.configurationError?.();
      if (configurationError) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'skipped',
          'missing-subscription-profile',
          configurationError,
          0,
        );
      }
      const executable = resolveExecutable();
      if (!executable) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'skipped',
          'missing-executable',
          `${config.executableName} executable not found`,
          0,
        );
      }
      if (!isAbsolute(executable)) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'skipped',
          'unsafe-transport',
          `${config.executableName} executable is not absolute`,
          0,
        );
      }

      const result = await transport.run(
        config.request(executable, configuredRoute, request.prompt, request.context.timeoutMs),
      );
      if (result.status !== 'ok') {
        // A seat CLI that has run out of subscription credit exits non-zero with a usage-limit
        // message. That is neither a code fault nor a transient blip: retrying burns more calls
        // against an exhausted quota and the operator cannot act on "subscription CLI failed".
        // Surface it verbatim, with the reset time the CLI reports, so the cause is obvious.
        const quota = quotaExhaustion(result.stderr);
        if (quota !== undefined) {
          capture(request, config.family, 'provider-failure', quota);
          return seatError(
            request,
            config.family,
            configuredRoute.primary,
            'failed',
            'quota-exhausted',
            quota,
            result.durationMs,
          );
        }
        capture(
          request,
          config.family,
          'provider-failure',
          `[${config.executableName} stderr omitted]`,
        );
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          result.status === 'timed-out' ? 'timed-out' : 'failed',
          result.errorCode ?? 'provider-failed',
          `${config.executableName} subscription CLI failed`,
          result.durationMs,
        );
      }

      const output = config.output(
        result.stdout,
        result.workingDirectory,
        result.stderr,
        structuredPrompt(request.prompt),
        configuredRoute.primary,
      );
      if (output.status === 'failed') {
        capture(
          request,
          config.family,
          'invalid-provider-response',
          `[${config.executableName} output omitted]`,
        );
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'failed',
          output.code,
          output.code === 'unsafe-tool-isolation'
            ? `${config.executableName} violated the governed tool-isolation policy`
            : `${config.executableName} output did not include one verifiable model identity and answer`,
          result.durationMs,
          false,
          output.actualModel === undefined
            ? undefined
            : { actualModel: output.actualModel, modelIdentity: 'unverified' },
          { requestedEffort: config.requestedEffort, credentialPath: 'subscription' },
        );
      }
      const seatRoute = observedRoute(configuredRoute, output.actualModel);
      if (!seatRoute) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'failed',
          'identity-unverified',
          `${config.executableName} reported a model outside the approved route`,
          result.durationMs,
          false,
          { actualModel: output.actualModel, modelIdentity: 'unverified' },
          { requestedEffort: config.requestedEffort, credentialPath: 'subscription' },
        );
      }
      const answer = parseAnswer(request, config.family, output.rawAnswer, false);
      if (!answer) {
        return seatError(
          request,
          config.family,
          configuredRoute.primary,
          'failed',
          'invalid-structured-answer',
          'provider answer did not match the council schema',
          result.durationMs,
          false,
          {
            actualModel: output.actualModel,
            modelIdentity: 'verified',
            route: seatRoute,
          },
          { requestedEffort: config.requestedEffort, credentialPath: 'subscription' },
        );
      }
      return seatSuccess(
        request,
        config.family,
        configuredRoute.primary,
        output.actualModel,
        seatRoute,
        answer,
        result.durationMs,
        {
          requestedEffort: config.requestedEffort,
          ...(output.observedEffort === undefined ? {} : { observedEffort: output.observedEffort }),
          credentialPath: 'subscription',
          ...(output.usage === undefined ? {} : { usage: output.usage }),
        },
      );
    },
    async probe(context) {
      return healthFromResponse(
        await adapter.invoke({
          context,
          seatId: `health-${config.family}`,
          role: 'health',
          prompt: healthPrompt,
        }),
      );
    },
  };
  return adapter;
}

const ompCouncilProfile = 'claude-council';
const ompIsolationConfig = [
  'advisor:',
  '  enabled: false',
  'prewalk:',
  '  enabled: false',
  'disabledProviders:',
  '  - native',
  '  - claude',
  '  - codex',
  '  - gemini',
  '  - opencode',
  '  - github',
  '  - agents',
  '  - agents-md',
].join('\n');

function ompCouncilProfileConfigurationError(): string | undefined {
  const profileConfig = join(
    homedir(),
    '.omp',
    'profiles',
    ompCouncilProfile,
    'agent',
    'config.yml',
  );
  return existsSync(profileConfig)
    ? undefined
    : `OMP profile ${ompCouncilProfile} is not configured`;
}

/**
 * Direct Codex subscription transport. `read-only` is Codex's most restrictive usable sandbox;
 * ambient configuration and every stable external tool surface are disabled independently.
 */
export function createOpenAiCodexAdapter(
  transport: CliTransport = nativeCliTransport,
  resolveExecutable: () => string | undefined = () => Bun.which('codex') ?? undefined,
): ProviderAdapter {
  return createSubscriptionCliAdapter(
    {
      family: 'openai',
      executableName: 'codex',
      requestedEffort: codexReasoningEffort,
      request: (executable, route, prompt, timeoutMs) => {
        const councilPrompt = structuredPrompt(prompt);
        return {
          executable,
          args: [
            'exec',
            '--skip-git-repo-check',
            '--strict-config',
            '--model',
            route.primary,
            '--output-schema',
            (workingDirectory) => join(workingDirectory, 'council-answer-schema.json'),
            '--sandbox',
            'read-only',
            '--ephemeral',
            '--ignore-user-config',
            '--ignore-rules',
            '-c',
            // `--ignore-user-config` discards the user's own reasoning-effort setting, so the
            // seat MUST set it explicitly or Codex runs at `reasoning effort: none`. Verified
            // against codex-cli 0.147.0: stderr reports `reasoning effort: xhigh`.
            `model_reasoning_effort="${codexReasoningEffort}"`,
            '-c',
            'web_search="disabled"',
            '--disable',
            'shell_tool',
            '--disable',
            'unified_exec',
            '--disable',
            'browser_use',
            '--disable',
            'browser_use_external',
            '--disable',
            'browser_use_full_cdp_access',
            '--disable',
            'computer_use',
            '--disable',
            'view_image',
            '--disable',
            'image_generation',
            '--disable',
            'apps',
            '--disable',
            'plugins',
            '--disable',
            'remote_plugin',
            '--disable',
            'multi_agent',
            '--disable',
            'hooks',
            '--disable',
            'skill_search',
            '--disable',
            'skill_mcp_dependency_install',
            '--disable',
            'workspace_dependencies',
            '--color',
            'never',
            '-',
          ],
          // Codex has no prompt-file flag: asking it to read this path would execute a tool.
          // Stage the bytes for isolation parity, then supply those same bytes through stdin.
          stdin: councilPrompt,
          timeoutMs,
          cwd: tmpdir(),
          files: {
            'council-prompt.txt': councilPrompt,
            'council-answer-schema.json': councilAnswerJsonSchema,
          },
        };
      },
      output: extractCodexOutput,
    },
    transport,
    resolveExecutable,
  );
}

/**
 * Legacy OMP transport, retained for callers with an authenticated `claude-council` OMP profile.
 * It is no longer the default because that isolated profile has its own expiring credential store.
 */
export function createOpenAiSubscriptionAdapter(
  transport: CliTransport = nativeCliTransport,
  resolveExecutable: () => string | undefined = () => Bun.which('omp') ?? undefined,
  profileConfigurationError: () => string | undefined = ompCouncilProfileConfigurationError,
): ProviderAdapter {
  return createSubscriptionCliAdapter(
    {
      family: 'openai',
      executableName: 'omp',
      requestedEffort: ompThinkingLevel,
      configurationError: profileConfigurationError,
      request: (executable, route, prompt, timeoutMs) => ({
        executable,
        args: [
          '-p',
          '--profile',
          ompCouncilProfile,
          '--mode',
          'json',
          '--model',
          `openai-codex/${route.primary}`,
          '--thinking',
          ompThinkingLevel,
          '--no-tools',
          '--no-lsp',
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-session',
          '--config',
          (workingDirectory) => join(workingDirectory, 'omp-isolation.yml'),
          '--no-prewalk',
          '--no-title',
          '--system-prompt',
          'You are a stateless tool-free council seat. Return only the requested JSON.',
          '@council-prompt.txt',
        ],
        stdin: '',
        timeoutMs,
        cwd: tmpdir(),
        files: {
          'council-prompt.txt': structuredPrompt(prompt),
          'omp-isolation.yml': ompIsolationConfig,
        },
      }),
      output: extractOmpOutput,
    },
    transport,
    resolveExecutable,
  );
}

function resolveAgyExecutable(): string | undefined {
  const onPath = Bun.which('agy');
  if (onPath) return onPath;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || process.platform !== 'win32') return undefined;
  const candidate = join(localAppData, 'agy', 'bin', 'agy.exe');
  return existsSync(candidate) ? candidate : undefined;
}

export function createGoogleSubscriptionAdapter(
  transport: CliTransport = nativeCliTransport,
  resolveExecutable: () => string | undefined = resolveAgyExecutable,
): ProviderAdapter {
  return createSubscriptionCliAdapter(
    {
      family: 'google',
      executableName: 'agy',
      requestedEffort: agyReasoningEffort,
      request: (executable, route, prompt, timeoutMs) => ({
        executable,
        args: [
          '--sandbox',
          '--mode',
          'plan',
          '--effort',
          agyReasoningEffort,
          '--output-format',
          'stream-json',
          '--json-schema',
          councilAnswerJsonSchema,
          '--model',
          route.primary,
          '--print-timeout',
          `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
          '-p',
          (workingDirectory) =>
            `Read ${join(workingDirectory, 'council-prompt.txt')}, follow it exactly, and do not use any other tool.`,
        ],
        stdin: '',
        timeoutMs,
        cwd: tmpdir(),
        files: {
          'council-prompt.txt': structuredPrompt(prompt),
          // This seat runs with HOME remapped to the isolation directory, so agy cannot
          // reach the operator's OAuth token and exits "authentication required" — which
          // surfaces as the opaque "agy subscription CLI failed". Stage a copy beside the
          // settings file: stageRequestFiles writes it 0600 into a 0700 directory that is
          // removed when the seat finishes. Omitted when the token is absent so an
          // unauthenticated host still reports agy's own error instead of throwing here.
          ...stagedAgyCredential(),
          '.gemini/antigravity-cli/settings.json': (workingDirectory) =>
            JSON.stringify({
              enableTelemetry: false,
              trustedWorkspaces: [workingDirectory],
              permissions: {
                allow: [`read_file(${join(workingDirectory, 'council-prompt.txt')})`],
              },
            }),
        },
        workingDirectoryEnv: ['HOME', 'USERPROFILE'],
      }),
      output: extractAgyOutput,
    },
    transport,
    resolveExecutable,
  );
}

/**
 * The operator's antigravity OAuth token, read at request time so a login performed after
 * this process started is picked up. Returns an empty map when unreadable.
 */
function stagedAgyCredential(): Record<string, string> {
  // Resolve the operator's home the way agy itself does, from the environment, so the
  // parent's real profile is used and a test can point this at a fixture directory.
  // Bun's os.homedir() ignores a reassigned HOME, which would otherwise read the live
  // credential during tests.
  const base = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const source = join(base, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  try {
    return { '.gemini/antigravity-cli/antigravity-oauth-token': readFileSync(source, 'utf8') };
  } catch {
    return {};
  }
}

function resolveGrokExecutable(): string | undefined {
  return Bun.which('grok') ?? undefined;
}

/**
 * Built-in grok tools removed explicitly. Measured on 1.0.4: passing these to
 * `--disallowed-tools` reduced the advertised built-in surface from 83 to 70. The remainder are
 * read-only or inert for a single-turn, sandboxed, plan-mode deliberation seat, and any actual use
 * of any tool is rejected by the stream validator regardless.
 */
const GROK_DISALLOWED_TOOLS = [
  'run_terminal_command',
  'write',
  'search_replace',
  'use_tool',
  'search_tool',
  'workflow',
  'monitor',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
] as const;

/**
 * Grok's Messages stream exposes the response model in its CLI-owned init, assistant and
 * model-usage frames. Plain and ordinary JSON output omit that identity and therefore cannot
 * satisfy the council's responding-model invariant.
 */
export function createXaiSubscriptionAdapter(
  transport: CliTransport = nativeCliTransport,
  resolveExecutable: () => string | undefined = resolveGrokExecutable,
  modelOverride: () => string | undefined = () => process.env.GROK_CLI_MODEL?.trim() || undefined,
): ProviderAdapter {
  return createSubscriptionCliAdapter(
    {
      family: 'xai',
      executableName: 'grok',
      requestedEffort: grokReasoningEffort,
      request: (executable, _route, prompt, timeoutMs) => {
        const councilPrompt = `${grokInlineAnswerGuard}\n\n${structuredPrompt(prompt)}`;
        const override = modelOverride()?.trim();
        return {
          executable,
          args: [
            '--no-auto-update',
            // Headless Grok has no stdin prompt source; the staged file keeps large prompts off argv.
            '--prompt-file',
            (workingDirectory) => join(workingDirectory, 'council-prompt.txt'),
            '--output-format',
            'streaming-messages-json',
            '--sandbox',
            'read-only',
            // `plan` is grok's read-only permission mode and the parser requires the init frame to
            // report it. Measured on 1.0.4: the init frame echoes `permissionMode: "plan"`.
            '--permission-mode',
            'plan',
            '--no-plan',
            '--no-subagents',
            '--no-memory',
            '--disable-web-search',
            // Measured on 1.0.4: `--tools <impossible-id>` removed only 3 of 83 built-ins, so it
            // was never the guard its previous comment claimed. `--disallowed-tools` genuinely
            // shrinks the surface (83 -> 70), so remove the mutating and side-effecting built-ins
            // explicitly. MCP and skill entries cannot be removed by any flag without also
            // stripping the OAuth credentials — tool USE is rejected downstream instead.
            '--disallowed-tools',
            GROK_DISALLOWED_TOOLS.join(','),
            '--max-turns',
            '1',
            '--verbatim',
            ...(override ? ['-m', override] : []),
          ],
          stdin: '',
          timeoutMs,
          cwd: tmpdir(),
          files: { 'council-prompt.txt': councilPrompt },
        };
      },
      output: extractGrokOutput,
    },
    transport,
    resolveExecutable,
  );
}

export interface XaiAdapterOptions {
  env?: Readonly<Record<string, string | undefined>> | undefined;
  httpTransport?: HttpTransport | undefined;
  cliTransport?: CliTransport | undefined;
  resolveExecutable?: (() => string | undefined) | undefined;
  modelOverride?: (() => string | undefined) | undefined;
  transportPreference?: 'http' | 'subscription-cli' | undefined;
  billingMode?: BillingMode | undefined;
}

function withTransportResolution(
  adapter: ProviderAdapter,
  transportResolution: ProviderTransportResolution,
): ProviderAdapter {
  return {
    ...adapter,
    transportResolution,
    async availability(context) {
      const availability = await adapter.availability(context);
      return availability.status === 'available'
        ? { ...availability, reason: transportResolution.reason }
        : availability;
    },
    async probe(context) {
      const health = await adapter.probe(context);
      return health.status === 'healthy'
        ? { ...health, reason: transportResolution.reason }
        : health;
    },
  };
}

/**
 * How a seat is allowed to pay for itself.
 *
 * - `sub-first` — spend an already-paid subscription; fall back to a metered key only if no
 *   subscription transport is available. The default, because the subscriptions are sunk cost.
 * - `api-only` — metered key only. For customer work, where every call must be attributable and
 *   chargeable; a subscription seat here would make the work unbillable and mix personal quota into
 *   a client engagement.
 * - `sub-only` — subscription only. Guarantees a run cannot incur metered spend.
 *
 * `api-only` and `sub-only` both fail closed to `unconfigured` rather than silently crossing to the
 * other path. That is the point: a billing mode that can be quietly overridden is not a control.
 */
export const BillingModeSchema = z.enum(['sub-first', 'api-only', 'sub-only']);
export type BillingMode = z.infer<typeof BillingModeSchema>;
export const DEFAULT_BILLING_MODE: BillingMode = 'sub-first';

interface DualCredentialSeat {
  family: ProviderFamily;
  /** Env var holding the metered key, named in operator-facing remediation text. */
  credential: string;
  /** How the subscription transport is obtained, for the same remediation text. */
  subscriptionHint: string;
  /**
   * Operator-facing name of the subscription transport in mid-sentence form, e.g.
   * "the grok subscription CLI". Kept per-family rather than generic: "the subscription transport is
   * available" tells an operator nothing about which binary was found, and these strings are what
   * `doctor` prints. Stored lower-case and capitalised only where it opens a sentence, so no message
   * can read "No The grok subscription CLI resolved".
   */
  subscriptionLabel: string;
  billingMode: BillingMode;
  /**
   * A soft preference for the metered path when a key is present. Distinct from
   * `billingMode: 'api-only'`, which is a requirement: a preference falls back to the subscription
   * when no key exists, a requirement fails closed. Conflating the two would silently turn an
   * existing "prefer HTTPS" option into "refuse to run without a key".
   */
  preferApi?: boolean;
  subscriptionAvailable: boolean;
  apiKeyPresent: boolean;
  subscription: () => ProviderAdapter;
  api: () => ProviderAdapter;
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function unconfiguredReason(seat: DualCredentialSeat): string {
  if (seat.billingMode === 'api-only') {
    return `billing mode api-only requires ${seat.credential} in ~/.claude/council/providers.env`;
  }
  if (seat.billingMode === 'sub-only') {
    return `billing mode sub-only requires ${seat.subscriptionHint}`;
  }
  return `set ${seat.credential} in ~/.claude/council/providers.env, or ${seat.subscriptionHint}`;
}

function createUnconfiguredSeatAdapter(seat: DualCredentialSeat): ProviderAdapter {
  const reason = unconfiguredReason(seat);
  const transportResolution: ProviderTransportResolution = {
    preferred: seat.billingMode === 'api-only' ? 'http' : 'subscription-cli',
    effective: null,
    reason,
  };
  const adapter: ProviderAdapter = {
    family: seat.family,
    transport: 'http',
    transportResolution,
    async availability(context) {
      return {
        status: 'unconfigured',
        provider: seat.family,
        model: context.registry[seat.family].primary,
        reason,
      };
    },
    async invoke(request) {
      return seatError(
        request,
        seat.family,
        request.context.registry[seat.family].primary,
        'skipped',
        `missing-${seat.family}-transport`,
        reason,
        0,
      );
    },
    async probe(context) {
      return healthFromResponse(
        await adapter.invoke({
          context,
          seatId: `health-${seat.family}`,
          role: 'health',
          prompt: healthPrompt,
        }),
      );
    },
  };
  return adapter;
}

/**
 * Error codes for which a seat MAY retry down the other credential path.
 *
 * The complement of this set is the load-bearing half. `identity-unverified`,
 * `unsafe-tool-isolation`, `invalid-structured-answer` and every policy or classification block are
 * absent deliberately: retrying an integrity failure on a second billing path would let a
 * misbehaving transport launder itself into a passing seat, which is strictly worse than a missing
 * vote. A security failure is a stop, not a routing hint.
 *
 * Transport-shaped failures (`spawn-failed`, `timeout`, `network`, `rate-limit`, `server`) are absent
 * for a different reason: the runner already retries those on the same seat, so admitting them here
 * would spend money on a fault that the cheaper retry is about to clear.
 */
const CREDENTIAL_FALLBACK_CODES: Readonly<Record<string, true>> = {
  'quota-exhausted': true,
  'missing-credential': true,
  'missing-executable': true,
  'auth-expired': true,
  'auth-missing': true,
};

function permitsCredentialFallback(response: SeatResponse): boolean {
  if (response.status === 'ok') return false;
  return CREDENTIAL_FALLBACK_CODES[response.error.code] === true;
}

/**
 * Try one credential path, then the other, but only for failures that a different credential could
 * actually fix.
 *
 * Only reachable under `sub-first`. `api-only` and `sub-only` are requirements rather than
 * preferences, so crossing paths there would defeat the control that made them worth having.
 */
function withCredentialFallback(
  primary: ProviderAdapter,
  secondary: () => ProviderAdapter,
  fallbackTransport: ModelTransport,
): ProviderAdapter {
  const adapter: ProviderAdapter = {
    ...primary,
    async invoke(request) {
      const first = await primary.invoke(request);
      if (!permitsCredentialFallback(first)) return first;
      const second = await secondary().invoke(request);
      if (second.status === 'ok') {
        return {
          ...second,
          // The fallback is recorded on the response so a record shows the credential actually spent
          // and the reason it changed. A silent substitution of a metered call for a subscription one
          // is exactly what the billing mode exists to make visible.
          credentialFallback: {
            fromTransport: primary.transport,
            toTransport: fallbackTransport,
            reason: first.status === 'ok' ? 'unknown' : first.error.code,
          },
        };
      }
      return second;
    },
    async probe(context) {
      return healthFromResponse(
        await adapter.invoke({
          context,
          seatId: `health-${primary.family}`,
          role: 'health',
          prompt: healthPrompt,
        }),
      );
    },
  };
  return adapter;
}

/**
 * Resolve one seat's credential path once, at construction. Shared by every dual-credential family
 * so precedence is defined in exactly one place — four copies of this would drift, and a seat that
 * silently picked a different billing path than its neighbours is the failure this prevents.
 */
function resolveDualCredentialSeat(seat: DualCredentialSeat): ProviderAdapter {
  if (seat.billingMode === 'api-only') {
    return seat.apiKeyPresent
      ? withTransportResolution(seat.api(), {
          preferred: 'http',
          effective: 'http',
          reason: `Billing mode api-only: using the metered ${seat.credential}. This call is billable and attributable.`,
        })
      : createUnconfiguredSeatAdapter(seat);
  }

  if (seat.billingMode === 'sub-only') {
    return seat.subscriptionAvailable
      ? withTransportResolution(seat.subscription(), {
          preferred: 'subscription-cli',
          effective: 'subscription-cli',
          reason: `Billing mode sub-only: using ${seat.subscriptionLabel}. Metered fallback is disabled${
            seat.apiKeyPresent ? `, so ${seat.credential} was deliberately ignored` : ''
          }.`,
        })
      : createUnconfiguredSeatAdapter(seat);
  }

  if (seat.preferApi === true && seat.apiKeyPresent) {
    return withTransportResolution(seat.api(), {
      preferred: 'http',
      effective: 'http',
      reason: `HTTPS was explicitly preferred and ${seat.credential} is set; ${seat.subscriptionLabel} was not used.`,
    });
  }

  if (seat.subscriptionAvailable) {
    // With a key also present the subscription seat gains a metered fallback, but only for failures
    // a different credential could fix — quota, auth and a missing executable. Everything else,
    // including every integrity failure, still fails the seat outright.
    const subscription = seat.apiKeyPresent
      ? withCredentialFallback(seat.subscription(), seat.api, 'http')
      : seat.subscription();
    return withTransportResolution(subscription, {
      preferred: 'subscription-cli',
      effective: 'subscription-cli',
      reason: seat.apiKeyPresent
        ? `${sentenceCase(seat.subscriptionLabel)} resolved on PATH and is preferred over the metered API key, which remains available if the subscription is exhausted or unauthenticated.`
        : `${sentenceCase(seat.subscriptionLabel)} resolved on PATH.`,
    });
  }

  if (seat.apiKeyPresent) {
    return withTransportResolution(seat.api(), {
      preferred: 'subscription-cli',
      effective: 'http',
      reason: `No ${seat.subscriptionLabel.replace(/^the /, '')} resolved on PATH; fell back to the metered ${seat.credential}. This call is billable.`,
    });
  }
  return createUnconfiguredSeatAdapter(seat);
}

/**
 * Resolves xAI once at adapter construction, **subscription first**.
 *
 * The owner holds paid subscriptions for personal work and uses metered API keys for customer work
 * so usage stays attributable and chargeable. The default must therefore spend the subscription he
 * has already paid for, and treat the API key as the fallback — not the reverse.
 *
 * `transportPreference: 'http'` remains a soft preference: it selects the metered path when a key is
 * present but still falls back to the CLI when one is not. `billingMode: 'api-only'` is the hard
 * control and fails closed instead.
 */
export function createXaiAdapter(options: XaiAdapterOptions = {}): ProviderAdapter {
  const env = options.env ?? process.env;
  const executable = (options.resolveExecutable ?? resolveGrokExecutable)();
  return resolveDualCredentialSeat({
    family: 'xai',
    credential: 'COUNCIL_XAI_API_KEY',
    subscriptionHint: 'install the grok CLI on PATH',
    subscriptionLabel: 'the grok subscription CLI',
    billingMode: options.billingMode ?? DEFAULT_BILLING_MODE,
    preferApi: options.transportPreference === 'http',
    subscriptionAvailable: Boolean(executable),
    apiKeyPresent: Boolean(env.COUNCIL_XAI_API_KEY),
    subscription: () =>
      createXaiSubscriptionAdapter(
        options.cliTransport,
        () => executable,
        options.modelOverride ?? (() => env.GROK_CLI_MODEL?.trim() || undefined),
      ),
    api: () =>
      createHttpAdapter(
        {
          family: 'xai',
          credential: 'COUNCIL_XAI_API_KEY',
          dialect: openAiCompatibleDialect('https://api.x.ai/v1/chat/completions'),
          allowRegistryFallback: false,
        },
        options.httpTransport,
      ),
  });
}

export function createAnthropicAdapter(
  transport: CliTransport = nativeCliTransport,
  resolveExecutable: () => string | undefined = () => Bun.which('claude') ?? undefined,
): ProviderAdapter {
  const family = 'anthropic' as const;
  const adapter: ProviderAdapter = {
    family,
    transport: 'cli',
    async availability(context) {
      const executable = resolveExecutable();
      return {
        status:
          executable && isAbsolute(executable)
            ? 'available'
            : executable
              ? 'unsafe-transport'
              : 'unconfigured',
        provider: family,
        model: context.registry.anthropic.primary,
        reason:
          executable && isAbsolute(executable)
            ? ''
            : executable
              ? 'claude executable is not absolute'
              : 'claude executable not found',
      };
    },
    async invoke(request) {
      const route = request.context.registry.anthropic;
      const executable = resolveExecutable();
      if (!executable) {
        return seatError(
          request,
          family,
          route.primary,
          'skipped',
          'missing-executable',
          'claude executable not found',
          0,
        );
      }
      if (!isAbsolute(executable)) {
        return seatError(
          request,
          family,
          route.primary,
          'skipped',
          'unsafe-transport',
          'claude executable is not absolute',
          0,
        );
      }
      const result = await transport.run({
        executable,
        args: [
          '-p',
          '--model',
          route.primary,
          '--effort',
          anthropicReasoningEffort,
          '--safe-mode',
          '--no-session-persistence',
          '--tools',
          '',
          // Constrain decoding to the council answer shape instead of asking for JSON in prose. The
          // prose-only form was observed failing a real motion with `invalid-structured-answer` while
          // the same seat passed the trivial health prompt, so the seat that always sits was the one
          // most exposed. The local strict parse still runs: native constrained decoding is a
          // transport guarantee, not semantic truth, and a non-conforming answer must still fail.
          '--json-schema',
          councilAnswerJsonSchema,
          '--output-format',
          'json',
        ],
        stdin: structuredPrompt(request.prompt),
        timeoutMs: request.context.timeoutMs,
        cwd: tmpdir(),
      });
      if (result.status !== 'ok') {
        if (result.stderr) capture(request, family, 'provider-failure', result.stderr);
        return seatError(
          request,
          family,
          route.primary,
          result.status === 'timed-out' ? 'timed-out' : 'failed',
          result.errorCode ?? 'provider-failed',
          safeExternalMessage(result.stderr, 'claude process failed'),
          result.durationMs,
        );
      }
      let output: unknown;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        capture(request, family, 'invalid-provider-response', result.stdout);
        return seatError(
          request,
          family,
          route.primary,
          'failed',
          'invalid-provider-response',
          'claude output was not valid JSON',
          result.durationMs,
        );
      }
      const parsed = ClaudeResponseSchema.safeParse(output);
      if (!parsed.success) {
        capture(request, family, 'invalid-provider-response', result.stdout);
        return seatError(
          request,
          family,
          route.primary,
          'failed',
          'identity-unverified',
          'claude output did not include model identity',
          result.durationMs,
        );
      }
      // `modelUsage` is keyed by every model the CLI billed for this turn, and more than one key is
      // NORMAL: observed live from claude 2.x, a tool-free `-p --model claude-opus-5` run bills
      // `claude-haiku-4-5-20251001` alongside `claude-opus-5`, because Claude Code uses a small model
      // for its own background work. Treating multi-key usage as ambiguity would therefore break the
      // one seat that always sits.
      //
      // Attribution comes from the configured route instead. Exactly one route member among the
      // billed models identifies the responder. None means the answer came from a model nobody
      // selected — the real defect, which previously passed as `verified` because the code fell back
      // to `actualModels[0]`. More than one route member is genuinely ambiguous, since the primary
      // and a declared fallback both running gives no way to say which produced `result`.
      const billedModels = Object.keys(parsed.data.modelUsage).sort();
      const routedModels = billedModels.filter(
        (model) => observedRoute(route, model) !== undefined,
      );
      const actualModel = routedModels[0];
      if (actualModel === undefined || routedModels.length !== 1) {
        const detail =
          billedModels.length === 0
            ? 'claude output did not include model identity'
            : routedModels.length === 0
              ? 'claude billed no model from the configured route'
              : 'claude billed more than one model from the configured route, so the responding model is not attributable';
        return seatError(
          request,
          family,
          route.primary,
          'failed',
          'identity-unverified',
          detail,
          result.durationMs,
          false,
          billedModels[0] === undefined
            ? undefined
            : { actualModel: billedModels[0], modelIdentity: 'unverified' },
          { requestedEffort: anthropicReasoningEffort, credentialPath: 'subscription' },
        );
      }
      const observed = observedRoute(route, actualModel);
      if (observed === undefined) {
        throw new Error('Route membership was established but could not be resolved');
      }
      const answer = parseAnswer(request, family, parsed.data.result);
      if (!answer) {
        return seatError(
          request,
          family,
          route.primary,
          'failed',
          'invalid-structured-answer',
          'provider answer did not match the council schema',
          result.durationMs,
        );
      }
      return seatSuccess(
        request,
        family,
        route.primary,
        actualModel,
        observed,
        answer,
        result.durationMs,
        // `--effort max` is sent but the CLI attests no effort in its JSON, so `observedEffort` is
        // deliberately absent rather than echoed back. An unattested request must never read as a
        // confirmation.
        { requestedEffort: anthropicReasoningEffort, credentialPath: 'subscription' },
      );
    },
    async probe(context) {
      return healthFromResponse(
        await adapter.invoke({
          context,
          seatId: 'health-anthropic',
          role: 'health',
          prompt: healthPrompt,
        }),
      );
    },
  };
  return adapter;
}

export interface DualCredentialAdapterOptions {
  env?: Readonly<Record<string, string | undefined>> | undefined;
  httpTransport?: HttpTransport | undefined;
  cliTransport?: CliTransport | undefined;
  resolveExecutable?: (() => string | undefined) | undefined;
  billingMode?: BillingMode | undefined;
}

/**
 * Anthropic with both credential paths: the claude CLI on a subscription, the Messages API on a
 * metered key.
 *
 * The subscription path is not merely preferred but materially stronger: the CLI adapter binds the
 * responding model from `modelUsage` and runs tool-free, whereas the API path can only bind what the
 * response body states. Both now verify the responding model against the configured route before a
 * seat counts, so neither can report a drifted model as confirmed — but the fallback exists for
 * availability, not because the paths are equivalent.
 */
export function createAnthropicDualAdapter(
  options: DualCredentialAdapterOptions = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const executable = (options.resolveExecutable ?? (() => Bun.which('claude') ?? undefined))();
  return resolveDualCredentialSeat({
    family: 'anthropic',
    credential: 'COUNCIL_ANTHROPIC_API_KEY',
    subscriptionHint: 'install the claude CLI on PATH',
    subscriptionLabel: 'the claude subscription CLI',
    billingMode: options.billingMode ?? DEFAULT_BILLING_MODE,
    // An executable that is not absolute is deliberately not treated as available: the CLI adapter
    // refuses it as `unsafe-transport`, and counting it here would resolve to a seat that can only
    // fail.
    subscriptionAvailable: Boolean(executable && isAbsolute(executable)),
    apiKeyPresent: Boolean(env.COUNCIL_ANTHROPIC_API_KEY),
    subscription: () => createAnthropicAdapter(options.cliTransport, () => executable),
    api: () =>
      createHttpAdapter(
        {
          family: 'anthropic',
          credential: 'COUNCIL_ANTHROPIC_API_KEY',
          dialect: anthropicMessagesDialect,
          allowRegistryFallback: false,
        },
        options.httpTransport,
      ),
  });
}

/**
 * OpenAI with both credential paths: the codex CLI on a subscription, chat completions on a metered
 * key.
 *
 * Codex is the only seat that attests its own reasoning effort, so the API path loses
 * `observedEffort` as well as the CLI's init-frame isolation evidence. That loss is recorded rather
 * than papered over: the API seat carries `requestedEffort` alone.
 */
export function createOpenAiDualAdapter(
  options: DualCredentialAdapterOptions = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const executable = (options.resolveExecutable ?? (() => Bun.which('codex') ?? undefined))();
  return resolveDualCredentialSeat({
    family: 'openai',
    credential: 'COUNCIL_OPENAI_API_KEY',
    subscriptionHint: 'install the codex CLI on PATH and sign in',
    subscriptionLabel: 'the codex subscription CLI',
    billingMode: options.billingMode ?? DEFAULT_BILLING_MODE,
    subscriptionAvailable: Boolean(executable),
    apiKeyPresent: Boolean(env.COUNCIL_OPENAI_API_KEY),
    subscription: () => createOpenAiCodexAdapter(options.cliTransport, () => executable),
    api: () =>
      createHttpAdapter(
        {
          family: 'openai',
          credential: 'COUNCIL_OPENAI_API_KEY',
          dialect: openAiCompatibleDialect('https://api.openai.com/v1/chat/completions'),
          allowRegistryFallback: false,
        },
        options.httpTransport,
      ),
  });
}

/**
 * Google with both credential paths: the agy CLI on a subscription, generateContent on a metered
 * key.
 *
 * Gemini reports identity as `modelVersion`, which is what the shared path compares against the
 * configured route. That matters here more than elsewhere: Gemini aliases (`-latest`, dated
 * snapshots) resolve server-side, so a configured alias that returns a dated version is a genuine
 * route mismatch and fails closed rather than being accepted as the same model.
 */
export function createGoogleDualAdapter(
  options: DualCredentialAdapterOptions = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const executable = (options.resolveExecutable ?? resolveAgyExecutable)();
  return resolveDualCredentialSeat({
    family: 'google',
    credential: 'COUNCIL_GEMINI_API_KEY',
    subscriptionHint: 'install the agy CLI on PATH',
    subscriptionLabel: 'the agy subscription CLI',
    billingMode: options.billingMode ?? DEFAULT_BILLING_MODE,
    subscriptionAvailable: Boolean(executable),
    apiKeyPresent: Boolean(env.COUNCIL_GEMINI_API_KEY),
    subscription: () => createGoogleSubscriptionAdapter(options.cliTransport, () => executable),
    api: () =>
      createHttpAdapter(
        {
          family: 'google',
          credential: 'COUNCIL_GEMINI_API_KEY',
          dialect: geminiGenerateContentDialect,
          allowRegistryFallback: false,
        },
        options.httpTransport,
      ),
  });
}
