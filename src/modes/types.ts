import type { z } from 'zod';
import type {
  BillingMode,
  Caller,
  CouncilRunResult,
  DataClassification,
  EnvelopeSeat,
  ExecutionPattern,
  ModeSessionStore,
  MotionImpact,
  PanelSpend,
  PersistedDecisionState,
  PolicyDecision,
  ProjectPolicy,
  ProviderAdapter,
  ProviderContext,
  ProviderFamily,
  SessionOptions,
  Spend,
  SpendPolicy,
  UnavailableProvider,
} from '../substrate';

/** The modes this build registers. A mode PR adds its name here when it adds its definition. */
export const MODE_NAMES = ['committee', 'second-opinion'] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/**
 * The eight modes docs/modes.md specifies. A name here is a subcommand the CLI knows how to
 * route, not a registration: `modes` lists only what this build can run, and a specified mode
 * that is not registered is refused by name.
 */
export const SPECIFIED_MODE_NAMES = [
  'committee',
  'second-opinion',
  'advisor',
  'ideation',
  'consultants',
  'forum',
  'triage',
  'audience',
] as const;
export type SpecifiedModeName = (typeof SPECIFIED_MODE_NAMES)[number];

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

/**
 * A mode that runs on the council runner: one seat per family, quorum, blind and rebuttal
 * rounds. `kind` is optional so the two shipped definitions stay exactly as written; absent
 * means runner, and `isHandlerMode` is the only place the discriminant is read.
 */
export interface RunnerModeDefinition {
  readonly kind?: 'runner';
  readonly name: ModeName;
  readonly knobs: ModeKnobs;
  readonly pattern: ExecutionPattern;
  readonly defaults: ModeDefaults;
  readonly spend: ModeSpend;
  readonly outputSchema: z.ZodType<Record<string, unknown>>;
  /** Everything between policy preflight and seating: for the committee, the health preflight. */
  prepare(input: ModePrepareInput): Promise<ModePrepareOutcome>;
  /** The mode-specific `output` block of the result envelope. Must satisfy `outputSchema`. */
  output(input: ModeOutputInput): Record<string, unknown>;
}

/** The mode's own flags, added to the common set the CLI parses for every handler command. */
export interface HandlerModeFlags {
  readonly value: readonly string[];
  readonly boolean: readonly string[];
}

/** What the CLI resolved from the common flags before the handler ran. */
export interface HandlerCommonOptions {
  readonly caller: Caller;
  readonly scope: 'general' | 'project';
  readonly projectId?: string;
  readonly projectPolicy?: ProjectPolicy;
  readonly classification: DataClassification;
  readonly eligibleProviderFamilies: readonly ProviderFamily[];
  readonly providerFamilies: readonly ProviderFamily[];
  readonly motion?: string;
  /** From `--session`, already validated against the session id pattern. */
  readonly sessionId?: string;
  /**
   * From `--session` for a mode declared `session: 'key'`: the harness's own session identity,
   * verbatim. The mode maps it to a store session id itself (the advisor uses the alias index).
   */
  readonly sessionKey?: string;
  readonly timeoutMs: number;
  /** After the mode's spend policy was applied: never-metered modes always see `sub-only`. */
  readonly billingMode: BillingMode;
  readonly recordsRoot?: string;
}

export interface HandlerInput {
  readonly command: string;
  readonly options: HandlerCommonOptions;
  /** The mode's own flags as parsed, keyed without the leading dashes. */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
  readonly stdin?: string;
  readonly adapters: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly context: ProviderContext;
  /** The outbound policy decision over the motion, already known to be `allowed`. */
  readonly policyDecision: PolicyDecision;
  /**
   * The same outbound policy over payloads the CLI could not see at preflight — a draft, a
   * transcript window, a batch of items. A blocked decision must stop the handler before any
   * seat is invoked.
   *
   * Precisely what is and is not already covered. The CLI's preflight scans `--motion` and nothing
   * else, so every other payload a mode reads — a file, stdin, a prior session's events, a batch of
   * items — has been scanned by no one until this is called on it. The classification and
   * project-policy destination checks always run, whether or not a mode calls this, because they
   * are decided from the flags rather than from the text. `runPanel` applies the hard-secret
   * backstop to every prompt unconditionally, so a mode that skips this on its own payloads
   * under-reports redactions on the record rather than leaking a key to a provider.
   */
  readonly guard: (payloads: readonly string[]) => PolicyDecision;
  /** Null when no records root is configured; a mode that needs records must say so. */
  readonly sessions: ModeSessionStore | null;
  /**
   * The spend the CLI built from the mode's policy and `--spend-cap`: `never-metered` carries no
   * ledger, `capped` carries the one the session's metered fallbacks must reserve from. Pass it
   * straight to `runPanel`, so the cap the caller asked for is the cap the seats are held to and
   * the envelope's `spend.cap` is that same ledger's.
   */
  readonly spend: PanelSpend;
  readonly now: () => string;
}

export type HandlerOutcome =
  | {
      readonly kind: 'blocked';
      readonly status: 'blocked-policy' | 'blocked-quorum';
      readonly message: string;
      readonly decision?: PolicyDecision;
    }
  | {
      readonly kind: 'result';
      readonly status: 'completed' | 'degraded';
      readonly session: string;
      readonly pattern: ExecutionPattern;
      readonly rounds: number;
      readonly seats: readonly EnvelopeSeat[];
      /** Must satisfy the mode's `outputSchema`; the CLI parses it before the envelope is built. */
      readonly output: Record<string, unknown>;
      readonly synthesis: { readonly by: string; readonly text: string } | null;
      readonly dissent: readonly { readonly seat: string; readonly position: string }[] | null;
      readonly unanimous: boolean;
      readonly degraded: readonly string[];
      readonly spend: Spend;
      /** `session` is the records-root-relative path; `paths` are the files to commit. */
      readonly record: { readonly session: string | null; readonly paths: readonly string[] };
    };

/**
 * A mode that owns its execution: a panel, a note log, rounds of its own. The CLI parses the
 * common flags, runs the policy preflight, hands over the adapters and the store, and builds,
 * validates, commits and renders what comes back.
 */
export interface HandlerModeDefinition {
  readonly kind: 'handler';
  readonly name: SpecifiedModeName;
  readonly knobs: ModeKnobs;
  readonly pattern: ExecutionPattern;
  readonly spend: ModeSpend;
  readonly flags: HandlerModeFlags;
  readonly outputSchema: z.ZodType<Record<string, unknown>>;
  /**
   * How `--session` is read. `'id'` (the default) is a store session id the CLI validates before
   * it can become a path. `'key'` is an opaque harness session key handed to the mode verbatim,
   * for a mode that is called from a hook which knows only the harness's own id.
   */
  readonly session?: 'id' | 'key';
  /** Whether bare arguments are passed through in `HandlerInput.positionals` rather than refused. */
  readonly acceptsPositionals?: boolean;
  handle(input: HandlerInput): Promise<HandlerOutcome>;
}

export type ModeDefinition = RunnerModeDefinition | HandlerModeDefinition;

export function isHandlerMode(mode: ModeDefinition): mode is HandlerModeDefinition {
  return mode.kind === 'handler';
}
