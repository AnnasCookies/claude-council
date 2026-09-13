import {
  RunManifestSchema,
  type DataClassification,
  type ModelRegistryProvenance,
  type ProjectPolicy,
  type ProviderFamily,
  type RefinementTrigger,
  type RunManifest,
} from './domain/schemas';
import type { Caller, ResultEnvelope } from './envelope';
import type { BillingMode, ProviderAdapter, ProviderContext } from './execution/provider';
import type { CouncilRunResult, CouncilSeatAssignment } from './execution/runner';
import { probeRoster, type ProviderProbe } from './health/probe';
import type { ModelRegistry } from './models/registry';
import type { PolicyDecision } from './policy/data-guard';
import {
  CouncilStore,
  type CurrentSessionRecord,
  type PersistedDecisionState,
} from './records/store';
import {
  AssignmentHistorySchema,
  assignLenses,
  selectLenses,
  type AssignmentHistory,
  type RoleAssignment,
} from './roles/allocator';

export const DEFAULT_SEAT_COUNT = 5;
export const DEFAULT_COUNCIL_MINIMUM_FAMILIES = 4;
export const REDUCED_COUNCIL_MINIMUM_FAMILIES = 3;
export const REDUCED_QUORUM_WARNING =
  'REDUCED-QUORUM COUNCIL: minimum 3 distinct provider families (standing default: 4). This council is weaker than the standing default.';

export type UnavailableProviderReason =
  'missing key' | 'unconfigured' | 'unhealthy' | 'identity-unverified' | 'unsafe-transport';

export interface UnavailableProvider {
  readonly provider: ProviderFamily;
  readonly reason: UnavailableProviderReason;
  readonly detail: string;
}

/**
 * Everything a mode needs to run one session. `chaired` is what `council` used to mean at the
 * command level: the standing four-family floor, the explicit or automatic reduced quorum, and
 * the health preflight before seating. The mode name is carried separately so the same options
 * can describe a committee that was reached through the legacy `run` alias without a chair.
 */
export interface SessionOptions {
  readonly mode: string;
  readonly chaired: boolean;
  readonly caller: Caller;
  readonly dryRun: boolean;
  readonly scope: 'general' | 'project';
  readonly classification: DataClassification;
  readonly motion: string;
  readonly motionId: string;
  readonly runId: string;
  readonly projectId?: string;
  readonly projectPolicy?: ProjectPolicy;
  readonly eligibleProviderFamilies: readonly ProviderFamily[];
  readonly providerFamilies: readonly ProviderFamily[];
  readonly impact: 'low' | 'medium' | 'high';
  readonly contested: boolean;
  readonly domains: readonly string[];
  readonly rounds: number;
  readonly refinementTrigger?: RefinementTrigger;
  readonly timeoutMs: number;
  readonly minimumFamilies?: number;
  readonly reducedQuorumWarning?: string;
  readonly recordsRoot?: string;
  readonly billingMode: BillingMode;
  readonly spendCap?: number;
}

export function quorumPolicy(options: SessionOptions): RunManifest['quorumPolicy'] {
  const significant = options.chaired || options.impact === 'high' || options.contested;
  const minimumDistinctFamilies = options.chaired
    ? (options.minimumFamilies ?? DEFAULT_COUNCIL_MINIMUM_FAMILIES)
    : significant
      ? 4
      : 3;
  return {
    minimumDistinctFamilies,
    requiresContrarian: significant,
    ...(options.chaired && minimumDistinctFamilies < DEFAULT_COUNCIL_MINIMUM_FAMILIES
      ? {
          reducedQuorum: {
            standingDefaultMinimumDistinctFamilies: DEFAULT_COUNCIL_MINIMUM_FAMILIES,
            weakerThanStandingDefault: true as const,
            warning: options.reducedQuorumWarning ?? REDUCED_QUORUM_WARNING,
          },
        }
      : {}),
  };
}

export function buildManifestAndAssignments(
  options: SessionOptions,
  registry: ModelRegistry,
  registryProvenance: ModelRegistryProvenance,
  history: AssignmentHistory,
): {
  manifest: RunManifest;
  assignments: CouncilSeatAssignment[];
  roleAssignments: RoleAssignment[];
} {
  const policy = quorumPolicy(options);
  const lenses = selectLenses(
    { domains: [...options.domains], impact: options.impact, contested: options.contested },
    options.providerFamilies.length,
    { allowReducedThreeSeatCoverage: policy.reducedQuorum !== undefined },
  );
  const seatIds = options.providerFamilies.map((provider) => `${provider}-seat`);
  const roleAssignments = assignLenses(options.runId, options.motionId, seatIds, lenses, history);
  const lensByName = new Map(lenses.map((lens) => [lens.name, lens] as const));
  const assignments = roleAssignments.map((assignment, index): CouncilSeatAssignment => {
    const provider = options.providerFamilies[index];
    const lens = lensByName.get(assignment.lensName);
    if (provider === undefined || lens === undefined) {
      throw new Error('Dynamic role assignment did not resolve a provider lens');
    }
    return {
      seatId: assignment.seatId,
      provider,
      lensName: lens.name,
      lensPrompt: lens.prompt,
      lensCategory: lens.category,
    };
  });
  const routes = Object.fromEntries(
    options.providerFamilies.map((provider) => [provider, registry[provider]] as const),
  );
  const manifest = RunManifestSchema.parse({
    motionId: options.motionId,
    scope: options.scope,
    classification: options.classification,
    routes,
    registryProvenance,
    lenses,
    rounds: options.rounds,
    ...(options.refinementTrigger === undefined
      ? {}
      : { refinementTrigger: options.refinementTrigger }),
    quorumPolicy: policy,
    evidenceReferences: [],
  });
  return { manifest, assignments, roleAssignments };
}

export function publicExecution(result: CouncilRunResult): Omit<CouncilRunResult, 'motion'> {
  const { motion: _motion, ...safeResult } = result;
  return safeResult;
}

export async function loadAssignmentHistory(
  options: SessionOptions,
  override?: AssignmentHistory,
): Promise<AssignmentHistory> {
  if (override !== undefined) return AssignmentHistorySchema.parse(override);
  if (options.recordsRoot === undefined) return [];
  return CouncilStore.open(options.recordsRoot).readAssignmentHistory(
    options.scope,
    { motionId: options.motionId, motion: options.motion },
    options.projectId,
  );
}

export function unavailableProvider(probe: ProviderProbe): UnavailableProvider {
  const reason: UnavailableProviderReason =
    probe.status === 'identity-unverified'
      ? 'identity-unverified'
      : probe.status === 'down'
        ? 'unhealthy'
        : probe.status === 'unsafe-transport'
          ? 'unsafe-transport'
          : /^missing\s+\S+/i.test(probe.reason)
            ? 'missing key'
            : 'unconfigured';
  return {
    provider: probe.provider,
    reason,
    detail: probe.reason || reason,
  };
}

export function autoReducedQuorumWarning(unavailable: readonly UnavailableProvider[]): string {
  const unavailableSummary = unavailable
    .map(({ provider, reason, detail }) => `${provider} — ${reason} (${detail})`)
    .join('; ');
  return `REDUCED-QUORUM COUNCIL: running with 3 configured, reachable provider families; the standing default is 4. This council is weaker than the standing default. Unavailable families: ${unavailableSummary}.`;
}

export async function resolveHealthyProviders(
  options: SessionOptions,
  adapters: Partial<Record<ProviderFamily, ProviderAdapter>>,
  context: ProviderContext,
): Promise<{
  providerFamilies: ProviderFamily[];
  unavailableProviders: UnavailableProvider[];
}> {
  const candidateAdapters = options.providerFamilies.flatMap((provider) => {
    const adapter = adapters[provider];
    return adapter === undefined ? [] : [adapter];
  });
  const probes = await probeRoster(candidateAdapters, context);
  const providerFamilies: ProviderFamily[] = [];
  const unavailableProviders: UnavailableProvider[] = [];
  let probeIndex = 0;

  for (const provider of options.providerFamilies) {
    const adapter = adapters[provider];
    if (adapter === undefined) {
      unavailableProviders.push({
        provider,
        reason: 'unhealthy',
        detail: 'provider adapter is unavailable',
      });
      continue;
    }
    const probe = probes[probeIndex];
    probeIndex += 1;
    if (probe === undefined || probe.provider !== provider) {
      unavailableProviders.push({
        provider,
        reason: 'unhealthy',
        detail: 'provider health result did not match the requested family',
      });
      continue;
    }
    if (probe.status === 'healthy') {
      providerFamilies.push(provider);
    } else {
      unavailableProviders.push(unavailableProvider(probe));
    }
  }

  return { providerFamilies, unavailableProviders };
}

export interface PreflightInput {
  readonly policyDecision: PolicyDecision;
  readonly requestedProviders: readonly ProviderFamily[];
  readonly selectedProviders: readonly ProviderFamily[];
  readonly unavailableProviders: readonly UnavailableProvider[];
  readonly eligibleProviders: readonly ProviderFamily[];
}

export function buildPreflight(input: PreflightInput) {
  return {
    classification: input.policyDecision.effectiveClassification,
    destinations: input.policyDecision.dispositions,
    requestedProviders: input.requestedProviders,
    selectedProviders: input.selectedProviders,
    unavailableProviders: input.unavailableProviders,
    eligibleProviders: input.eligibleProviders,
    omittedEligibleProviders: input.eligibleProviders.filter(
      (provider) => !input.requestedProviders.includes(provider),
    ),
    redactionCount: input.policyDecision.redactions.reduce(
      (count, redaction) => count + redaction.findings.length,
      0,
    ),
  };
}

/** Records-root-relative path of the session record, known before it is written. */
export function sessionRecordPath(options: SessionOptions): string | null {
  if (options.recordsRoot === undefined) return null;
  const scope =
    options.scope === 'general' ? 'general' : `projects/${options.projectId ?? 'unknown'}`;
  return `${scope}/sessions/${options.runId}.json`;
}

export interface PersistedSession {
  readonly records: {
    readonly session: true;
    readonly decisionState: PersistedDecisionState;
    readonly dataAvailability: 'captured';
  };
  readonly decisionState: PersistedDecisionState;
}

export async function persistSession(
  options: SessionOptions,
  decision: PolicyDecision,
  manifest: RunManifest,
  result: CouncilRunResult,
  roleAssignments: RoleAssignment[],
  startedAt: string,
  now: string,
  envelope: ResultEnvelope | undefined,
): Promise<PersistedSession | undefined> {
  if (options.recordsRoot === undefined) return undefined;
  if (options.scope === 'project' && options.projectId === undefined) {
    throw new Error('Project record persistence requires a project id');
  }
  const store = CouncilStore.open(options.recordsRoot);
  const status = result.outcome;
  const outcomeSummary =
    status === 'completed'
      ? `Quorum passed across ${result.quorum.successfulFamilies.length} provider families; a chair ruling is required before this becomes a resolution.`
      : status === 'degraded'
        ? `Degraded result across ${result.quorum.successfulFamilies.length} provider families; chair acceptance and a chair ruling are both required before resolution.`
        : `Quorum blocked: ${result.quorum.failureReasons.join(', ') || 'insufficient responses'}.`;
  const reducedQuorumWarning = result.quorumPolicy.reducedQuorum?.warning;
  const sessionSummary =
    reducedQuorumWarning === undefined
      ? outcomeSummary
      : `${reducedQuorumWarning} ${outcomeSummary}`;
  const decisionState: PersistedDecisionState =
    status === 'completed' || status === 'degraded' ? 'awaiting-adjudication' : 'not-adjudicable';
  const sessionBase = {
    schemaVersion: 2 as const,
    runId: options.runId,
    motionId: options.motionId,
    status,
    motion: options.motion,
    startedAt,
    completedAt: now,
    decisionState,
    policyDecision: {
      kind: decision.kind,
      classification: decision.effectiveClassification ?? options.classification,
      reasonCodes: decision.reasonCodes,
    },
    destinations: options.providerFamilies.map((provider) => ({
      provider,
      model: manifest.routes[provider]?.primary ?? 'unresolved',
    })),
    protocol: {
      requestedRounds: result.requestedRounds,
      ...(result.refinementTrigger === undefined
        ? {}
        : { refinementTrigger: result.refinementTrigger }),
      quorumPolicy: result.quorumPolicy,
    },
    // The decision-level evidence: every seat's actual answer, the model that really responded,
    // whether that identity verified, what was retried and why. Without this a record proves only
    // what was requested, never what was decided.
    execution: {
      rounds: result.rounds,
      quorum: result.quorum,
      rebuttalObligation: result.rebuttalObligation,
      synthesisEligible: result.synthesisEligible,
    },
    assignments: roleAssignments,
    summary: sessionSummary,
    ...(envelope === undefined ? {} : { envelope }),
  } as const;
  const session: CurrentSessionRecord =
    options.scope === 'general'
      ? { ...sessionBase, scope: 'general' }
      : {
          ...sessionBase,
          scope: 'project',
          projectId: options.projectId as string,
        };
  await store.writeSession(session);
  return {
    records: { session: true, decisionState, dataAvailability: 'captured' },
    decisionState,
  };
}
