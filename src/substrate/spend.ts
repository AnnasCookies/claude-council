import { z } from 'zod';
import type { BillingMode } from './execution/provider';

/**
 * How a mode is allowed to pay for its seats. `never-metered` is for fast modes (advisor, triage,
 * audience): a metered key is unreachable, not merely avoided. `capped` is for slow modes: a
 * subscription seat may fall back to the same family's metered key until the session cap is spent.
 */
export const SpendPolicySchema = z.enum(['never-metered', 'capped']);
export type SpendPolicy = z.infer<typeof SpendPolicySchema>;

export interface SpendLedger {
  readonly cap: number;
  readonly used: number;
  readonly refused: number;
  /** Reserve one metered call. Returns false, and counts a refusal, once the cap is spent. */
  reserve(): boolean;
}

export function createSpendLedger(cap: number): SpendLedger {
  if (!Number.isInteger(cap) || cap < 0) {
    throw new RangeError(`Spend cap must be a non-negative integer; received ${cap}`);
  }
  let used = 0;
  let refused = 0;
  return {
    cap,
    get used() {
      return used;
    },
    get refused() {
      return refused;
    },
    reserve() {
      if (used >= cap) {
        refused += 1;
        return false;
      }
      used += 1;
      return true;
    },
  };
}

export function effectiveBillingMode(policy: SpendPolicy, requested: BillingMode): BillingMode {
  if (policy === 'never-metered') {
    if (requested === 'api-only') {
      throw new Error('This mode never spends a metered key; --billing api-only is not allowed');
    }
    return 'sub-only';
  }
  return requested;
}

export function spendCapExhaustedMessage(cap: number): string {
  return `Metered fallback refused: the session spend cap of ${cap} metered call(s) is exhausted. Raise it with --spend-cap <n>.`;
}
