import { describe, expect, test } from 'bun:test';
import {
  createSpendLedger,
  effectiveBillingMode,
  spendCapExhaustedMessage,
} from '../../src/substrate/spend';

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
