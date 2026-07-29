import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import type { ModelRoute, ModelTransport, ProviderFamily, SeatResponse } from '../domain/schemas';
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

interface HttpAdapterConfig {
  family: Exclude<ProviderFamily, 'anthropic' | 'openai' | 'google'>;
  credential: string;
  endpoint: string;
  allowRegistryFallback: boolean;
}

function httpPayload(model: string, prompt: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: structuredPrompt(prompt) }],
    max_tokens: 32768,
  });
}

function extractHttpAnswer(body: unknown): { actualModel: string; rawAnswer: string } | undefined {
  const parsed = ChatCompletionSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return {
    actualModel: parsed.data.model,
    rawAnswer: parsed.data.choices[0]?.message.content ?? '',
  };
}

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
            url: config.endpoint,
            method: 'POST',
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            body: httpPayload(model, request.prompt),
          },
          defaultRetryPolicy(request.context.timeoutMs),
        );

      let model = configuredRoute.primary;
      let providerResult = await invokeModel(model);
      let seatRoute: 'primary' | 'same-provider-fallback' = 'primary';
      const fallback = configuredRoute.fallbacks[0];
      if (
        config.allowRegistryFallback &&
        providerResult.errorCode === 'model-not-found' &&
        fallback !== undefined
      ) {
        model = fallback;
        seatRoute = 'same-provider-fallback';
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

      const extracted = extractHttpAnswer(providerResult.body);
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
      return seatSuccess(
        request,
        config.family,
        configuredRoute.primary,
        extracted.actualModel,
        seatRoute,
        answer,
        latencyMs,
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
}

interface SubscriptionCliOutputFailure {
  status: 'failed';
  code: 'identity-unverified' | 'unsafe-tool-isolation';
  actualModel?: string;
}

type SubscriptionCliParseResult = SubscriptionCliOutput | SubscriptionCliOutputFailure;

interface SubscriptionCliAdapterConfig {
  family: Extract<ProviderFamily, 'openai' | 'google'>;
  executableName: string;
  request(executable: string, route: ModelRoute, prompt: string, timeoutMs: number): CliRequest;
  output(stdout: string, workingDirectory?: string): SubscriptionCliParseResult;
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

const AgyEventEnvelopeSchema = z.object({ event: z.string().min(1) }).passthrough();
const AgyInitEventSchema = z.object({
  event: z.literal('init'),
  init: z.object({
    model: z.string().min(1),
    cwd: z.string().min(1),
    tools: z.array(z.string().min(1)),
  }),
});
const AgyStepEventSchema = z.object({
  event: z.literal('step_update'),
  step_update: z.object({
    step_index: z.number().int().nonnegative(),
    state: z.string().min(1),
    step_type: z.string().min(1),
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
    response: z.string().min(1),
  }),
});

const agyAnswerSchema = JSON.stringify({
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

function parseFailure(
  code: SubscriptionCliOutputFailure['code'],
  actualModel?: string,
): SubscriptionCliOutputFailure {
  return actualModel === undefined
    ? { status: 'failed', code }
    : { status: 'failed', code, actualModel };
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

function extractAgyOutput(stdout: string, workingDirectory?: string): SubscriptionCliParseResult {
  let state: 'await-init' | 'before-read' | 'reading' | 'after-read' | 'finished' | 'terminal' =
    'await-init';
  let actualModel: string | undefined;
  let activeToolIndex: number | undefined;
  let rawAnswer: string | undefined;
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
    if (!envelope.success) return parseFailure('identity-unverified', actualModel);
    if (state === 'terminal') return parseFailure('identity-unverified', actualModel);

    if (envelope.data.event === 'init') {
      const init = AgyInitEventSchema.safeParse(value);
      if (!init.success || state !== 'await-init') {
        return parseFailure('unsafe-tool-isolation', actualModel);
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
      // AGY reports its compiled catalogue here; the ephemeral permission file is
      // the capability boundary. Every observed non-view_file tool still fails below.
      state = 'before-read';
      continue;
    }

    if (envelope.data.event === 'step_update') {
      const step = AgyStepEventSchema.safeParse(value);
      if (!step.success) {
        return parseFailure(
          containsUnsafeToolNode(value) ? 'unsafe-tool-isolation' : 'identity-unverified',
          actualModel,
        );
      }
      const update = step.data.step_update;
      if (update.step_type === 'tool') {
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
        if (
          tool.data.step_update.state === 'ACTIVE' &&
          state === 'before-read' &&
          activeToolIndex === undefined
        ) {
          activeToolIndex = tool.data.step_update.step_index;
          state = 'reading';
          continue;
        }
        if (
          tool.data.step_update.state === 'DONE' &&
          state === 'reading' &&
          activeToolIndex === tool.data.step_update.step_index
        ) {
          state = 'after-read';
          continue;
        }
        return parseFailure('unsafe-tool-isolation', actualModel);
      }

      if (
        state === 'before-read' &&
        update.state === 'DONE' &&
        ['user_input', 'unknown', 'agent_response'].includes(update.step_type)
      ) {
        continue;
      }
      if (
        state === 'after-read' &&
        update.state === 'DONE' &&
        ['checkpoint', 'agent_response'].includes(update.step_type)
      ) {
        continue;
      }
      if (state === 'after-read' && update.state === 'DONE' && update.step_type === 'finish') {
        state = 'finished';
        continue;
      }
      return parseFailure(
        containsUnsafeToolNode(value) || update.step_type === 'subagent'
          ? 'unsafe-tool-isolation'
          : 'identity-unverified',
        actualModel,
      );
    }

    if (envelope.data.event === 'result') {
      const result = AgyResultEventSchema.safeParse(value);
      if (!result.success || state !== 'finished') {
        return parseFailure('identity-unverified', actualModel);
      }
      rawAnswer = result.data.result.response;
      state = 'terminal';
      continue;
    }

    return parseFailure(
      /tool|browser|subagent/i.test(envelope.data.event) || containsUnsafeToolNode(value)
        ? 'unsafe-tool-isolation'
        : 'identity-unverified',
      actualModel,
    );
  }

  return state === 'terminal' && actualModel !== undefined && rawAnswer !== undefined
    ? { status: 'ok', actualModel, rawAnswer }
    : state === 'await-init' || state === 'finished'
      ? parseFailure('identity-unverified', actualModel)
      : parseFailure('unsafe-tool-isolation', actualModel);
}

function observedRoute(
  route: ModelRoute,
  actualModel: string,
): 'primary' | 'same-provider-fallback' | undefined {
  if (actualModel === route.primary) return 'primary';
  return route.fallbacks.includes(actualModel) ? 'same-provider-fallback' : undefined;
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

      const output = config.output(result.stdout, result.workingDirectory);
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

export function createOpenAiSubscriptionAdapter(
  transport: CliTransport = nativeCliTransport,
  resolveExecutable: () => string | undefined = () => Bun.which('omp') ?? undefined,
  profileConfigurationError: () => string | undefined = ompCouncilProfileConfigurationError,
): ProviderAdapter {
  return createSubscriptionCliAdapter(
    {
      family: 'openai',
      executableName: 'omp',
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
          'max',
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
      request: (executable, route, prompt, timeoutMs) => ({
        executable,
        args: [
          '--sandbox',
          '--mode',
          'plan',
          '--effort',
          'high',
          '--output-format',
          'stream-json',
          '--json-schema',
          agyAnswerSchema,
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
          'max',
          '--safe-mode',
          '--no-session-persistence',
          '--tools',
          '',
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
      const actualModels = Object.keys(parsed.data.modelUsage).sort();
      const actualModel = actualModels.includes(route.primary) ? route.primary : actualModels[0];
      if (!actualModel) {
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
        'primary',
        answer,
        result.durationMs,
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
