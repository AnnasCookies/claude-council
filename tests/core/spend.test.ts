import { describe, expect, test } from 'bun:test';
import {
  createSpendLedger,
  effectiveBillingMode,
  spendCapExhaustedMessage,
} from '../../src/substrate/spend';
import type {
  Availability,
  HealthResult,
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
} from '../../src/substrate/execution/provider';
import { withCredentialFallback } from '../../src/substrate/execution/provider';
import type { SeatResponse } from '../../src/substrate/domain/schemas';

describe('spend ledger', () => {
  test('reserves up to the cap and counts refusals after it', () => {
    const ledger = createSpendLedger(2);
    expect(ledger.reserve()).toBe(true);
    expect(ledger.reserve()).toBe(true);
    expect(ledger.reserve()).toBe(false);
    expect(ledger.reserve()).toBe(false);
    expect(ledger.used).toBe(2);
    expect(ledger.refused).toBe(2);
    expect(ledger.cap).toBe(2);
  });

  test('a zero cap refuses every metered call', () => {
    const ledger = createSpendLedger(0);
    expect(ledger.reserve()).toBe(false);
    expect(ledger.used).toBe(0);
    expect(ledger.refused).toBe(1);
  });

  test('rejects a negative or fractional cap', () => {
    expect(() => createSpendLedger(-1)).toThrow(RangeError);
    expect(() => createSpendLedger(1.5)).toThrow(RangeError);
  });

  test('never-metered pins sub-only and refuses api-only', () => {
    expect(effectiveBillingMode('never-metered', 'sub-first')).toBe('sub-only');
    expect(effectiveBillingMode('never-metered', 'sub-only')).toBe('sub-only');
    expect(() => effectiveBillingMode('never-metered', 'api-only')).toThrow(
      /never spends a metered key/,
    );
  });

  test('capped keeps the requested billing mode', () => {
    expect(effectiveBillingMode('capped', 'sub-first')).toBe('sub-first');
    expect(effectiveBillingMode('capped', 'api-only')).toBe('api-only');
    expect(effectiveBillingMode('capped', 'sub-only')).toBe('sub-only');
  });

  test('the cap message names the flag that raises it', () => {
    expect(spendCapExhaustedMessage(3)).toContain('--spend-cap');
    expect(spendCapExhaustedMessage(3)).toContain('3');
  });
});

function stubAdapter(
  reply: () => SeatResponse,
  transport: 'subscription-cli' | 'http',
): ProviderAdapter {
  return {
    family: 'xai',
    transport,
    async availability(): Promise<Availability> {
      return { status: 'available', provider: 'xai', model: 'grok', reason: 'stub' };
    },
    async invoke(): Promise<SeatResponse> {
      return reply();
    },
    async probe(): Promise<HealthResult> {
      return {
        status: 'healthy',
        provider: 'xai',
        requestedModel: 'grok',
        actualModel: 'grok',
        latencyMs: 1,
        reason: 'stub',
      };
    },
  };
}

function quotaExhausted(): SeatResponse {
  return {
    status: 'failed',
    seatId: 'xai-seat',
    provider: 'xai',
    role: 'architect',
    error: { code: 'quota-exhausted', message: 'subscription spent', retryable: false },
  };
}

function metered(): SeatResponse {
  return {
    status: 'ok',
    seatId: 'xai-seat',
    provider: 'xai',
    requestedModel: 'grok',
    actualModel: 'grok',
    modelIdentity: 'verified',
    route: 'primary',
    role: 'architect',
    latencyMs: 1,
    answer:
      '{"recommendation":"x","evidence":[],"assumptions":[],"risks":[],"uncertainty":"u","decisiveTest":"t"}',
    credentialPath: 'api-key',
  };
}

function request(spend?: ProviderContext['spend']): ProviderRequest {
  const context: ProviderContext = {
    registry: {} as ProviderContext['registry'],
    env: {},
    cwd: 'C:/isolated',
    timeoutMs: 1_000,
    ...(spend === undefined ? {} : { spend }),
  };
  return { context, seatId: 'xai-seat', role: 'architect', prompt: 'motion' };
}

describe('credential fallback under a spend cap', () => {
  test('without a ledger the fallback behaves as before', async () => {
    const adapter = withCredentialFallback(
      stubAdapter(quotaExhausted, 'subscription-cli'),
      () => stubAdapter(metered, 'http'),
      'http',
    );
    const response = await adapter.invoke(request());
    expect(response.status).toBe('ok');
    expect(response.credentialFallback).toEqual({
      fromTransport: 'subscription-cli',
      toTransport: 'http',
      reason: 'quota-exhausted',
    });
  });

  test('the ledger permits metered calls up to the cap and then refuses with spend-cap', async () => {
    const ledger = createSpendLedger(1);
    const adapter = withCredentialFallback(
      stubAdapter(quotaExhausted, 'subscription-cli'),
      () => stubAdapter(metered, 'http'),
      'http',
    );
    const first = await adapter.invoke(request(ledger));
    expect(first.status).toBe('ok');
    const second = await adapter.invoke(request(ledger));
    expect(second.status).toBe('failed');
    if (second.status !== 'failed') throw new Error('unreachable');
    expect(second.error.code).toBe('spend-cap');
    expect(second.error.message).toContain('--spend-cap');
    expect(second.error.message).toContain('quota-exhausted');
    expect(second.error.retryable).toBe(false);
    expect(ledger.used).toBe(1);
    expect(ledger.refused).toBe(1);
  });
});
