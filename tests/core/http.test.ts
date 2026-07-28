import { describe, expect, test } from 'bun:test';
import { requestWithPolicy, type RetryPolicy } from '../../src/execution/http';
import { fakeProvider, hangingProvider } from './fixtures/fake-provider';

const testRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 1_000,
  baseDelayMs: 1,
  maxDelayMs: 2,
  jitterRatio: 0,
};

describe('bounded HTTP execution', () => {
  test('retries 429 then succeeds and records attempts', async () => {
    using server = fakeProvider([{ status: 429 }, { status: 200, body: { answer: 'ok' } }]);

    const result = await requestWithPolicy({ url: server.url, method: 'POST' }, testRetryPolicy);

    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(result.body).toEqual({ answer: 'ok' });
  });

  test('does not retry authentication or validation failures', async () => {
    using server = fakeProvider([{ status: 401 }, { status: 200 }]);

    const result = await requestWithPolicy({ url: server.url }, testRetryPolicy);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.errorCode).toBe('authentication');
    expect(server.requests).toBe(1);
  });

  test('retries eligible server failures only up to the attempt cap', async () => {
    using server = fakeProvider([{ status: 503 }, { status: 503 }, { status: 503 }]);

    const result = await requestWithPolicy({ url: server.url }, testRetryPolicy);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(3);
    expect(result.errorCode).toBe('server');
  });

  test('does not retry a hard timeout', async () => {
    using server = hangingProvider();

    const result = await requestWithPolicy(
      { url: server.url, method: 'POST' },
      { ...testRetryPolicy, timeoutMs: 20 },
    );

    expect(result.status).toBe('timed-out');
    expect(result.attempts).toBe(1);
    expect(server.requests).toBe(1);
  });
});
