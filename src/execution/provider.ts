import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ProviderFamily, SeatResponse } from '../domain/schemas';
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
  readonly transport: 'http' | 'cli';
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
const OpenAIResponseSchema = z.object({
  model: z.string().min(1),
  output: z.array(
    z.object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    }),
  ),
});
const GoogleResponseSchema = z.object({
  modelVersion: z.string().min(1),
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string() })) }) }))
    .min(1),
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
): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stripOuterJsonFence(scanAndRedact(rawAnswer).redacted));
  } catch {
    capture(request, family, 'invalid-structured-answer', rawAnswer);
    return undefined;
  }
  const parsed = CouncilAnswerSchema.safeParse(value);
  if (!parsed.success) {
    capture(request, family, 'invalid-structured-answer', rawAnswer);
    return undefined;
  }
  return JSON.stringify(parsed.data);
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
): SeatResponse {
  return {
    status,
    seatId: request.seatId,
    provider: family,
    requestedModel,
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
  const status =
    response.status === 'skipped'
      ? response.error.code === 'unsafe-transport'
        ? 'unsafe-transport'
        : 'unconfigured'
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
  family: Exclude<ProviderFamily, 'anthropic' | 'google'>;
  credential: string;
  endpoint: string;
  responseKind: 'chat' | 'openai-responses';
  allowRegistryFallback: boolean;
}

function httpPayload(
  kind: HttpAdapterConfig['responseKind'],
  model: string,
  prompt: string,
): string {
  if (kind === 'openai-responses') {
    return JSON.stringify({
      model,
      input: structuredPrompt(prompt),
      max_output_tokens: 32768,
      reasoning: { effort: 'high' },
    });
  }
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: structuredPrompt(prompt) }],
    max_tokens: 32768,
  });
}

function extractHttpAnswer(
  kind: HttpAdapterConfig['responseKind'],
  body: unknown,
): { actualModel: string; rawAnswer: string } | undefined {
  if (kind === 'openai-responses') {
    const parsed = OpenAIResponseSchema.safeParse(body);
    if (!parsed.success) return undefined;
    const rawAnswer = parsed.data.output
      .flatMap((item) => item.content)
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text ?? '')
      .join('');
    return { actualModel: parsed.data.model, rawAnswer };
  }
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
            body: httpPayload(config.responseKind, model, request.prompt),
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

      const extracted = extractHttpAnswer(config.responseKind, providerResult.body);
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

export function createGoogleAdapter(
  transport: HttpTransport = nativeHttpTransport,
): ProviderAdapter {
  const family = 'google' as const;
  const adapter: ProviderAdapter = {
    family,
    transport: 'http',
    async availability(context) {
      return {
        status: context.env.GEMINI_API_KEY ? 'available' : 'unconfigured',
        provider: family,
        model: context.registry.google.primary,
        reason: context.env.GEMINI_API_KEY ? '' : 'missing GEMINI_API_KEY',
      };
    },
    async invoke(request) {
      const startedAt = Date.now();
      const route = request.context.registry.google;
      const credential = request.context.env.GEMINI_API_KEY;
      if (!credential) {
        return seatError(
          request,
          family,
          route.primary,
          'skipped',
          'missing-credential',
          'missing GEMINI_API_KEY',
          0,
        );
      }
      const invokeModel = (model: string) =>
        transport.request(
          {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': credential },
            body: JSON.stringify({
              contents: [{ parts: [{ text: structuredPrompt(request.prompt) }] }],
              generationConfig: { maxOutputTokens: 32768 },
            }),
          },
          defaultRetryPolicy(request.context.timeoutMs),
        );

      let model = route.primary;
      let providerResult = await invokeModel(model);
      let seatRoute: 'primary' | 'same-provider-fallback' = 'primary';
      const fallback = route.fallbacks[0];
      if (providerResult.errorCode === 'model-not-found' && fallback !== undefined) {
        model = fallback;
        seatRoute = 'same-provider-fallback';
        providerResult = await invokeModel(model);
      }
      const latencyMs = Date.now() - startedAt;
      if (providerResult.status !== 'ok') {
        return seatError(
          request,
          family,
          route.primary,
          providerResult.status === 'timed-out' ? 'timed-out' : 'failed',
          providerResult.errorCode ?? 'provider-failed',
          safeExternalMessage(providerResult.message, 'provider request failed'),
          latencyMs,
        );
      }
      const parsed = GoogleResponseSchema.safeParse(providerResult.body);
      if (!parsed.success) {
        capture(
          request,
          family,
          'invalid-provider-response',
          serialiseUnknown(providerResult.body),
        );
        return seatError(
          request,
          family,
          route.primary,
          'failed',
          'invalid-provider-response',
          'provider response did not contain verified model metadata and text',
          latencyMs,
        );
      }
      const rawAnswer =
        parsed.data.candidates[0]?.content.parts.map((part) => part.text).join('') ?? '';
      const answer = parseAnswer(request, family, rawAnswer);
      if (!answer) {
        return seatError(
          request,
          family,
          route.primary,
          'failed',
          'invalid-structured-answer',
          'provider answer did not match the council schema',
          latencyMs,
        );
      }
      return seatSuccess(
        request,
        family,
        route.primary,
        parsed.data.modelVersion,
        seatRoute,
        answer,
        latencyMs,
      );
    },
    async probe(context) {
      return healthFromResponse(
        await adapter.invoke({
          context,
          seatId: 'health-google',
          role: 'health',
          prompt: healthPrompt,
        }),
      );
    },
  };
  return adapter;
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
