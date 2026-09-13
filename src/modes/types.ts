import type { z } from 'zod';
import type {
  CouncilRunResult,
  ExecutionPattern,
  MotionImpact,
  PersistedDecisionState,
  PolicyDecision,
  ProviderAdapter,
  ProviderContext,
  ProviderFamily,
  SessionOptions,
  SpendPolicy,
  UnavailableProvider,
} from '../substrate';

export const MODE_NAMES = ['committee', 'second-opinion'] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/** The five knobs from docs/vision.md, as a description of the mode rather than as behaviour. */
export interface ModeKnobs {
  readonly participants: string;
  readonly pattern: ExecutionPattern;
  readonly aggregation: string;
  readonly tempo: string;
  readonly records: string;
}

export interface ModeDefaults {
  readonly impact: MotionImpact;
  readonly contested: boolean;
  readonly rounds: number;
}

export interface ModeSpend {
  readonly policy: SpendPolicy;
  /** Default cap on metered fallback calls for a session with this many seats and rounds. */
  defaultCap(seats: number, rounds: number): number;
}

export interface ModePrepareInput {
  readonly options: SessionOptions;
  readonly adapters: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly context: ProviderContext;
  readonly policyDecision: PolicyDecision;
}

export type ModePrepareOutcome =
  | {
      readonly kind: 'ready';
      readonly options: SessionOptions;
      readonly unavailableProviders: readonly UnavailableProvider[];
    }
  | {
      readonly kind: 'blocked-quorum';
      readonly message: string;
      readonly selectedProviders: readonly ProviderFamily[];
      readonly unavailableProviders: readonly UnavailableProvider[];
    };

export type ModeResultView = Pick<
  CouncilRunResult,
  'outcome' | 'quorum' | 'rebuttalObligation' | 'synthesisEligible' | 'rounds'
>;

export interface ModeOutputInput {
  readonly result: ModeResultView;
  readonly decisionState: PersistedDecisionState | null;
}

export interface ModeDefinition {
  readonly name: ModeName;
  readonly knobs: ModeKnobs;
  readonly pattern: ExecutionPattern;
  readonly defaults: ModeDefaults;
  readonly spend: ModeSpend;
  readonly outputSchema: z.ZodTypeAny;
  /** Everything between policy preflight and seating: for the committee, the health preflight. */
  prepare(input: ModePrepareInput): Promise<ModePrepareOutcome>;
  /** The mode-specific `output` block of the result envelope. Must satisfy `outputSchema`. */
  output(input: ModeOutputInput): Record<string, unknown>;
}
