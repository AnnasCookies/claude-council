export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
}

export interface RetryPolicy {
  maxAttempts: number;
  timeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export type HttpStatus = 'ok' | 'failed' | 'timed-out';
export type HttpErrorCode =
  | 'authentication'
  | 'validation'
  | 'model-not-found'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'http'
  | 'timeout';

export interface HttpResult {
  status: HttpStatus;
  attempts: number;
  statusCode: number | null;
  body: unknown;
  errorCode: HttpErrorCode | null;
  message: string;
}

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function validatePolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  for (const [name, value] of [
    ['timeoutMs', policy.timeoutMs],
    ['baseDelayMs', policy.baseDelayMs],
    ['maxDelayMs', policy.maxDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  }
  if (policy.timeoutMs === 0) throw new RangeError('timeoutMs must be positive');
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError('maxDelayMs must not be less than baseDelayMs');
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new RangeError('jitterRatio must be between 0 and 1');
  }
}

function errorCodeForStatus(status: number): HttpErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'model-not-found';
  if (status === 400 || status === 409 || status === 422) return 'validation';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'http';
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const spread = exponential * policy.jitterRatio;
  const jittered = exponential + (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(jittered)));
}

export async function requestWithPolicy(
  request: HttpRequest,
  policy: RetryPolicy,
): Promise<HttpResult> {
  validatePolicy(policy);

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, policy.timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: request.method ?? 'GET',
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
      const body = await responseBody(response);
      if (response.ok) {
        return {
          status: 'ok',
          attempts: attempt,
          statusCode: response.status,
          body,
          errorCode: null,
          message: '',
        };
      }

      const errorCode = errorCodeForStatus(response.status);
      if (retryableStatuses.has(response.status) && attempt < policy.maxAttempts) {
        await Bun.sleep(retryDelay(attempt, policy));
        continue;
      }
      return {
        status: 'failed',
        attempts: attempt,
        statusCode: response.status,
        body,
        errorCode,
        message: `HTTP ${response.status}`,
      };
    } catch (error) {
      if (timedOut) {
        return {
          status: 'timed-out',
          attempts: attempt,
          statusCode: null,
          body: null,
          errorCode: 'timeout',
          message: `request timed out after ${policy.timeoutMs}ms`,
        };
      }
      if (attempt < policy.maxAttempts) {
        await Bun.sleep(retryDelay(attempt, policy));
        continue;
      }
      return {
        status: 'failed',
        attempts: attempt,
        statusCode: null,
        body: null,
        errorCode: 'network',
        message: error instanceof Error ? error.message : 'network request failed',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('retry loop exhausted without a result');
}
