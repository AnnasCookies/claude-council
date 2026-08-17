import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import packageManifest from '../package.json';
import {
  DataClassificationSchema,
  MotionImpactSchema,
  ModelRegistryProvenanceSchema,
  ProjectPolicySchema,
  CouncilScopeSchema,
  ProviderFamilySchema,
  RefinementTriggerSchema,
  RunManifestSchema,
  type DataClassification,
  type ModelRegistryProvenance,
  type ProjectPolicy,
  type ProviderFamily,
  type RefinementTrigger,
  type RunManifest,
} from './domain/schemas';
import {
  BillingModeSchema,
  DEFAULT_BILLING_MODE,
  type BillingMode,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDiagnostic,
  type ProviderTransportResolution,
} from './execution/provider';
import {
  CouncilRunner,
  type CouncilRunResult,
  type CouncilSeatAssignment,
} from './execution/runner';
import { snapshot } from './health/baseline';
import { doctor } from './health/doctor';
import { probeRoster, type ProviderProbe } from './health/probe';
import {
  loadModelRegistryWithProvenance,
  ModelRegistrySchema,
  resolveModelRegistry,
  type LoadedModelRegistry,
  type ModelRegistry,
} from './models/registry';
import { evaluateOutbound, type PolicyDecision } from './policy/data-guard';
import { scanAndRedact } from './policy/secrets';
import { createProviderRoster, type ProviderRoster } from './providers';
import {
  MigrationPlanSchema,
  MigrationRuleSchema,
  applyGeneralMigration,
  planGeneralMigration,
} from './records/migrate-general';
import {
  CouncilStore,
  SessionRecordSchema,
  type CurrentSessionRecord,
  type PersistedDecisionState,
  type SessionRecord,
  writeTextAtomically,
} from './records/store';
import {
  AssignmentHistorySchema,
  assignLenses,
  inferMotionDomains,
  roleCatalogue,
  selectLenses,
  type AssignmentHistory,
  type RoleAssignment,
} from './roles/allocator';

export const ADAPTER_CONTRACT_VERSION = 1 as const;
const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_SEAT_COUNT = 5;
const DEFAULT_COUNCIL_MINIMUM_FAMILIES = 4;
const REDUCED_COUNCIL_MINIMUM_FAMILIES = 3;
const REDUCED_QUORUM_WARNING =
  'REDUCED-QUORUM COUNCIL: minimum 3 distinct provider families (standing default: 4). This council is weaker than the standing default.';

type UnavailableProviderReason =
  'missing key' | 'unconfigured' | 'unhealthy' | 'identity-unverified' | 'unsafe-transport';

interface UnavailableProvider {
  readonly provider: ProviderFamily;
  readonly reason: UnavailableProviderReason;
  readonly detail: string;
}
const PACKAGE_VERSION = z.string().trim().min(1).parse(packageManifest.version);
const EXECUTABLE_PATH = resolve(import.meta.main ? Bun.main : import.meta.path);
const INSTALLER_PROVENANCE_VALUE_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');
const SAFE_STORAGE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const BOOLEAN_FLAGS = new Set([
  'dry-run',
  'json',
  'contested',
  'help',
  'accept-degraded',
  'dissent-acknowledged',
  'no-dissent',
]);
const COMMON_RUN_FLAGS = new Set([
  'billing',
  'classification',
  'contested',
  'domain',
  'dry-run',
  'help',
  'impact',
  'json',
  'motion',
  'motion-id',
  'project-id',
  'project-policy',
  'providers',
  'refinement-question',
  'registry',
  'records-root',
  'rounds',
  'run-id',
  'scope',
  'timeout-ms',
]);
const COUNCIL_RUN_FLAGS = new Set([...COMMON_RUN_FLAGS, 'min-families']);
const REGISTRY_REPORT_FLAGS = new Set(['help', 'json', 'records-root', 'registry', 'billing']);
const ADJUDICATE_FLAGS = new Set([
  'help',
  'json',
  'records-root',
  'scope',
  'project-id',
  'run-id',
  'decision',
  'rationale',
  'authorised-by',
  'followed-seats',
  'set-aside-seats',
  'dissent-acknowledged',
  'no-dissent',
  'accept-degraded',
  'acceptance-rationale',
  'ruling-id',
  'resolution-id',
]);

interface ParsedArguments {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

interface RunOptions {
  readonly command: 'run' | 'council' | 'second-opinion';
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
}

interface ConfiguredModelRegistry extends LoadedModelRegistry {
  readonly stateRoot?: string;
}

interface InstallerSuppliedProvenance {
  readonly value: string;
  readonly source: 'installer-supplied';
  readonly selfAttested: false;
}

interface EngineIdentityBase {
  readonly executablePath: string;
  readonly packageVersion: string;
  readonly stateRoot: string | null;
  readonly routes: ModelRegistry;
  readonly registryProvenance: ModelRegistryProvenance;
  readonly adapterContractVersion: typeof ADAPTER_CONTRACT_VERSION;
}

export type EngineIdentity = EngineIdentityBase &
  (
    | {
        readonly installerProvenance: InstallerSuppliedProvenance;
      }
    | {
        readonly installerProvenance: null;
        readonly reason: string;
      }
  );

export interface CliFacadeEnvironment {
  readonly registry?: ModelRegistry;
  readonly registryProvenance?: ModelRegistryProvenance;
  readonly adapters?: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly projectPolicy?: ProjectPolicy;
  readonly assignmentHistory?: AssignmentHistory;
  readonly recordsRoot?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly now?: () => string;
}

export interface CliFacadeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function output(exitCode: number, value?: unknown, error?: unknown): CliFacadeResult {
  return {
    exitCode,
    stdout: value === undefined ? '' : `${JSON.stringify(value)}\n`,
    stderr: error === undefined ? '' : `${JSON.stringify(error)}\n`,
  };
}

function parseArguments(
  args: readonly string[],
  allowedFlags: ReadonlySet<string>,
): ParsedArguments {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const name = argument.slice(2);
    if (!allowedFlags.has(name)) throw new Error(`Unknown option: --${name}`);
    const values = flags.get(name) ?? [];
    if (BOOLEAN_FLAGS.has(name)) {
      values.push('true');
    } else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option --${name} requires a value`);
      }
      values.push(value);
      index += 1;
    }
    flags.set(name, values);
  }

  return { flags, positionals };
}

function oneFlag(parsed: ParsedArguments, name: string): string | undefined {
  const values = parsed.flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

function hasFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.has(name);
}

function integerFlag(
  parsed: ParsedArguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = oneFlag(parsed, name);
  if (raw === undefined) return fallback;
  const parsedValue = Number(raw);
  if (!Number.isInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`Option --${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsedValue;
}

function resolvedRecordsRoot(
  parsed: ParsedArguments,
  environment: CliFacadeEnvironment,
): string | undefined {
  const value = oneFlag(parsed, 'records-root') ?? environment.recordsRoot;
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new Error('Records root must not be blank');
  const cwd = resolve(environment.cwd ?? process.cwd());
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

async function configuredModelRegistry(
  parsed: ParsedArguments,
  environment: CliFacadeEnvironment,
): Promise<ConfiguredModelRegistry> {
  const stateRoot = resolvedRecordsRoot(parsed, environment);
  const explicitOverride = oneFlag(parsed, 'registry');
  if (explicitOverride !== undefined || environment.registry === undefined) {
    const loaded = await resolveModelRegistry({
      ...(explicitOverride === undefined ? {} : { overridePath: explicitOverride }),
      ...(stateRoot === undefined ? {} : { recordsRoot: stateRoot }),
      cwd: environment.cwd ?? process.cwd(),
      env: environment.env ?? process.env,
    });
    return { ...loaded, ...(stateRoot === undefined ? {} : { stateRoot }) };
  }

  const registry = ModelRegistrySchema.parse(environment.registry);
  const builtIn = await loadModelRegistryWithProvenance();
  if (
    environment.registryProvenance === undefined &&
    JSON.stringify(registry) !== JSON.stringify(builtIn.registry)
  ) {
    throw new Error('An injected model registry requires explicit registry provenance');
  }
  const provenance = ModelRegistryProvenanceSchema.parse(
    environment.registryProvenance ?? builtIn.provenance,
  );
  return { registry, provenance, ...(stateRoot === undefined ? {} : { stateRoot }) };
}

function engineIdentity(
  configured: ConfiguredModelRegistry,
  environment: CliFacadeEnvironment,
): EngineIdentity {
  const base: EngineIdentityBase = {
    executablePath: EXECUTABLE_PATH,
    packageVersion: PACKAGE_VERSION,
    stateRoot: configured.stateRoot ?? null,
    routes: configured.registry,
    registryProvenance: configured.provenance,
    adapterContractVersion: ADAPTER_CONTRACT_VERSION,
  };
  const suppliedValue = (environment.env ?? process.env).COUNCIL_INSTALLER_PROVENANCE?.trim();
  if (!suppliedValue) {
    return {
      ...base,
      installerProvenance: null,
      reason:
        'COUNCIL_INSTALLER_PROVENANCE was not supplied; installer provenance cannot be self-attested.',
    };
  }

  return {
    ...base,
    installerProvenance: {
      value: INSTALLER_PROVENANCE_VALUE_SCHEMA.parse(suppliedValue),
      source: 'installer-supplied',
      selfAttested: false,
    },
  };
}

function safeStorageId(value: string, label: string): string {
  if (value.length > 128 || !SAFE_STORAGE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a safe storage identifier`);
  }
  return value;
}

function deterministicId(prefix: string, command: string, motion: string, now: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([prefix, command, motion, now]))
    .digest('hex')
    .slice(0, 16);
  return `${prefix}-${digest}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = scanAndRedact(message).redacted.replace(/\s+/g, ' ').trim();
  return (redacted || 'Council command failed').slice(0, 500);
}

function unavailableProvider(probe: ProviderProbe): UnavailableProvider {
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

function autoReducedQuorumWarning(unavailable: readonly UnavailableProvider[]): string {
  const unavailableSummary = unavailable
    .map(({ provider, reason, detail }) => `${provider} — ${reason} (${detail})`)
    .join('; ');
  return `REDUCED-QUORUM COUNCIL: running with 3 configured, reachable provider families; the standing default is 4. This council is weaker than the standing default. Unavailable families: ${unavailableSummary}.`;
}

function selectProviderFamilies(
  value: string | undefined,
  registry: ModelRegistry,
  policy: ProjectPolicy | undefined,
): {
  selected: ProviderFamily[];
  eligible: ProviderFamily[];
} {
  const eligible = [...(policy?.allowedProviders ?? ProviderFamilySchema.options)];
  const requested =
    value === undefined
      ? eligible.slice(0, DEFAULT_SEAT_COUNT)
      : value
          .split(',')
          .map((provider) => provider.trim())
          .filter((provider) => provider.length > 0);
  const families = z.array(ProviderFamilySchema).min(1).parse(requested);
  const selected = [...new Set(families)];
  for (const family of selected) {
    if (registry[family] === undefined)
      throw new Error(`No model route is registered for ${family}`);
  }
  return { selected, eligible };
}

function generalPolicy(now: string): ProjectPolicy {
  const allowedProviders = [...ProviderFamilySchema.options];
  return ProjectPolicySchema.parse({
    projectId: 'general',
    classification: 'public',
    allowedProviders,
    providerCeilings: Object.fromEntries(
      allowedProviders.map((provider) => [provider, 'public'] as const),
    ),
    createdAt: now,
    updatedAt: now,
  });
}

async function loadProjectPolicyFile(
  parsed: ParsedArguments,
  environment: CliFacadeEnvironment,
  cwd: string,
): Promise<ProjectPolicy | undefined> {
  const policyPath = oneFlag(parsed, 'project-policy');
  if (policyPath === undefined) return environment.projectPolicy;
  const absolutePath = isAbsolute(policyPath) ? policyPath : resolve(cwd, policyPath);
  let value: unknown;
  try {
    value = await Bun.file(absolutePath).json();
  } catch (error) {
    throw new Error(`Unable to read project policy: ${safeError(error)}`);
  }
  return ProjectPolicySchema.parse(value);
}

function commandDefaults(command: RunOptions['command']): {
  impact: RunOptions['impact'];
  contested: boolean;
  rounds: number;
} {
  if (command === 'council') return { impact: 'high', contested: true, rounds: 2 };
  if (command === 'second-opinion') return { impact: 'medium', contested: false, rounds: 1 };
  return { impact: 'medium', contested: false, rounds: 1 };
}

/**
 * Precedence: explicit `--billing` beats a project policy pin, which beats the `sub-first` default.
 *
 * The flag wins so an operator can override a pin for one deliberate run, but the pin exists so a
 * project's normal case does not depend on remembering the flag. A conflict is not an error: an
 * operator typing `--billing` has said something more specific than the file did.
 */
function resolveBillingMode(
  parsed: ParsedArguments,
  policy: ProjectPolicy | undefined,
): BillingMode {
  const flag = oneFlag(parsed, 'billing');
  if (flag !== undefined) return BillingModeSchema.parse(flag);
  return policy?.billingMode ?? DEFAULT_BILLING_MODE;
}

/**
 * `doctor`, `health`, `version` and `self-check` have no project policy in scope, so they honour
 * `--billing` alone. Without this they would always describe the `sub-first` roster and could report a
 * healthy subscription seat for a run that would actually take the metered path.
 */
function reportBillingMode(parsed: ParsedArguments): BillingMode {
  const flag = oneFlag(parsed, 'billing');
  return flag === undefined ? DEFAULT_BILLING_MODE : BillingModeSchema.parse(flag);
}

async function parseRunOptions(
  command: RunOptions['command'],
  parsed: ParsedArguments,
  environment: CliFacadeEnvironment,
  registry: ModelRegistry,
  recordsRoot: string | undefined,
): Promise<RunOptions> {
  if (parsed.positionals.length > 0) throw new Error('Run commands accept options only');
  const now = (environment.now ?? (() => new Date().toISOString()))();
  const cwd = environment.cwd ?? process.cwd();
  const defaults = commandDefaults(command);
  const scope = z.enum(['general', 'project']).parse(oneFlag(parsed, 'scope') ?? 'general');
  const classification = DataClassificationSchema.parse(
    oneFlag(parsed, 'classification') ?? 'public',
  );
  const motion = (oneFlag(parsed, 'motion') ?? environment.stdin ?? '').trim();
  if (motion.length === 0) throw new Error('A non-blank motion is required');
  const impact = MotionImpactSchema.parse(oneFlag(parsed, 'impact') ?? defaults.impact);
  const contested = hasFlag(parsed, 'contested') || defaults.contested;
  const rounds = integerFlag(parsed, 'rounds', defaults.rounds, 1, 3);
  const minimumFamilies =
    command === 'council' && parsed.flags.has('min-families')
      ? integerFlag(
          parsed,
          'min-families',
          DEFAULT_COUNCIL_MINIMUM_FAMILIES,
          REDUCED_COUNCIL_MINIMUM_FAMILIES,
          ProviderFamilySchema.options.length,
        )
      : undefined;
  const significant = command === 'council' || impact === 'high' || contested;
  if (!significant && rounds !== 1) {
    throw new Error('Ordinary motions require exactly one blind round');
  }
  if (significant && rounds < 2) {
    throw new Error('Significant motions require a rebuttal round');
  }
  const refinementQuestion = oneFlag(parsed, 'refinement-question')?.trim();
  if (rounds === 3 && !refinementQuestion) {
    throw new Error('Three-round execution requires --refinement-question');
  }
  if (rounds !== 3 && refinementQuestion !== undefined) {
    throw new Error('--refinement-question is valid only with --rounds 3');
  }
  const refinementTrigger =
    refinementQuestion === undefined
      ? undefined
      : RefinementTriggerSchema.parse({
          materialDisagreement: true,
          question: refinementQuestion,
        });
  const runId = safeStorageId(
    oneFlag(parsed, 'run-id') ?? deterministicId('run', command, motion, now),
    'Run id',
  );
  const motionId = safeStorageId(
    oneFlag(parsed, 'motion-id') ?? deterministicId('motion', command, motion, now),
    'Motion id',
  );
  const projectPolicy = await loadProjectPolicyFile(parsed, environment, cwd);
  if (scope === 'general' && projectPolicy !== undefined) {
    throw new Error('Project policy requires --scope project');
  }
  if (scope === 'general' && oneFlag(parsed, 'project-id') !== undefined) {
    throw new Error('Project id requires --scope project');
  }
  const projectIdValue = oneFlag(parsed, 'project-id') ?? projectPolicy?.projectId;
  const projectId =
    projectIdValue === undefined ? undefined : safeStorageId(projectIdValue, 'Project id');
  const policy = scope === 'project' ? projectPolicy : generalPolicy(now);
  if (scope === 'project' && projectId !== undefined && policy?.projectId !== projectId) {
    throw new Error('Project policy does not match --project-id');
  }
  const providerSelection = selectProviderFamilies(oneFlag(parsed, 'providers'), registry, policy);
  const domainFlags = parsed.flags.get('domain');
  const domains =
    domainFlags === undefined
      ? inferMotionDomains(motion)
      : domainFlags
          .flatMap((value) => value.split(','))
          .map((domain) => domain.trim())
          .filter((domain) => domain.length > 0);
  const uniqueDomains = [...new Set(domains.map((domain) => domain.toLowerCase()))];

  return {
    command,
    dryRun: hasFlag(parsed, 'dry-run'),
    scope,
    classification,
    motion,
    motionId,
    runId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(policy === undefined ? {} : { projectPolicy: policy }),
    eligibleProviderFamilies: providerSelection.eligible,
    providerFamilies: providerSelection.selected,
    impact,
    contested,
    domains: uniqueDomains,
    rounds,
    ...(minimumFamilies === undefined ? {} : { minimumFamilies }),
    ...(refinementTrigger === undefined ? {} : { refinementTrigger }),
    timeoutMs: integerFlag(parsed, 'timeout-ms', DEFAULT_TIMEOUT_MS, 1, 3_600_000),
    ...(recordsRoot === undefined ? {} : { recordsRoot }),
    billingMode: resolveBillingMode(parsed, policy),
  };
}

function quorumPolicy(options: RunOptions): RunManifest['quorumPolicy'] {
  const significant =
    options.command === 'council' || options.impact === 'high' || options.contested;
  const minimumDistinctFamilies =
    options.command === 'council'
      ? (options.minimumFamilies ?? DEFAULT_COUNCIL_MINIMUM_FAMILIES)
      : significant
        ? 4
        : 3;
  return {
    minimumDistinctFamilies,
    requiresContrarian: significant,
    ...(options.command === 'council' && minimumDistinctFamilies < DEFAULT_COUNCIL_MINIMUM_FAMILIES
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

function buildManifestAndAssignments(
  options: RunOptions,
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

function publicExecution(result: CouncilRunResult): Omit<CouncilRunResult, 'motion'> {
  const { motion: _motion, ...safeResult } = result;
  return safeResult;
}

/**
 * Deliberately absent: a `consensusRecommendation()` that lower-cased each family's
 * `answer.recommendation`, compared the strings, and appended a ledger resolution when they matched.
 *
 * It inverted three standing invariants at once — treat unanimity as a prompt-quality warning, the
 * panel informs rather than out-votes the chair, and do not adjudicate as consensus — and it
 * inspected only the final round, so earlier dissent could not affect the outcome. A shared answer
 * schema and a shared prompt can induce identical short categorical recommendations, which is a
 * measurement artefact rather than agreement.
 *
 * A decision now requires `council adjudicate`, which records a named chair's ruling. The archive
 * enforces the same rule structurally: `appendResolution` refuses a resolution that no ruling backs.
 */

async function loadAssignmentHistory(
  options: RunOptions,
  environment: CliFacadeEnvironment,
): Promise<AssignmentHistory> {
  if (environment.assignmentHistory !== undefined) {
    return AssignmentHistorySchema.parse(environment.assignmentHistory);
  }
  if (options.recordsRoot === undefined) return [];
  return CouncilStore.open(options.recordsRoot).readAssignmentHistory(
    options.scope,
    { motionId: options.motionId, motion: options.motion },
    options.projectId,
  );
}

async function persistRun(
  options: RunOptions,
  decision: PolicyDecision,
  manifest: RunManifest,
  result: CouncilRunResult,
  roleAssignments: RoleAssignment[],
  startedAt: string,
  now: string,
): Promise<
  | {
      session: true;
      decisionState: PersistedDecisionState;
      dataAvailability: 'captured';
    }
  | undefined
> {
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
  return { session: true, decisionState, dataAvailability: 'captured' };
}

async function resolveCouncilProviders(
  options: RunOptions,
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

async function runCouncilCommand(
  command: RunOptions['command'],
  args: readonly string[],
  environment: CliFacadeEnvironment,
): Promise<CliFacadeResult> {
  const parsed = parseArguments(args, command === 'council' ? COUNCIL_RUN_FLAGS : COMMON_RUN_FLAGS);
  const configured = await configuredModelRegistry(parsed, environment);
  const registry = configured.registry;
  const options = await parseRunOptions(
    command,
    parsed,
    environment,
    registry,
    configured.stateRoot,
  );
  const requestedProviderFamilies = options.providerFamilies;
  const destinations = requestedProviderFamilies.map((provider) => ({
    provider,
    model: registry[provider].primary,
  }));
  const policyDecision = evaluateOutbound({
    runId: options.runId,
    classification: options.classification,
    ...(options.projectPolicy === undefined ? {} : { policy: options.projectPolicy }),
    destinations,
    payloads: [
      options.motion,
      ...(options.refinementTrigger === undefined ? [] : [options.refinementTrigger.question]),
    ],
  });
  if (policyDecision.kind === 'blocked') {
    return output(3, undefined, {
      schemaVersion: SCHEMA_VERSION,
      command,
      status: 'blocked-policy',
      preflight: {
        requestedProviders: requestedProviderFamilies,
        selectedProviders: requestedProviderFamilies,
        unavailableProviders: [],
        eligibleProviders: options.eligibleProviderFamilies,
        omittedEligibleProviders: options.eligibleProviderFamilies.filter(
          (provider) => !requestedProviderFamilies.includes(provider),
        ),
        decision: policyDecision,
      },
    });
  }

  if (options.dryRun) {
    const assignmentHistory = await loadAssignmentHistory(options, environment);
    const { manifest } = buildManifestAndAssignments(
      options,
      registry,
      configured.provenance,
      assignmentHistory,
    );
    const reducedQuorumWarning = manifest.quorumPolicy.reducedQuorum?.warning;
    return output(0, {
      schemaVersion: SCHEMA_VERSION,
      command,
      status: 'dry-run',
      runId: options.runId,
      ...(reducedQuorumWarning === undefined ? {} : { warning: reducedQuorumWarning }),
      manifest,
      preflight: {
        classification: policyDecision.effectiveClassification,
        destinations: policyDecision.dispositions,
        requestedProviders: requestedProviderFamilies,
        selectedProviders: requestedProviderFamilies,
        unavailableProviders: [],
        eligibleProviders: options.eligibleProviderFamilies,
        omittedEligibleProviders: options.eligibleProviderFamilies.filter(
          (provider) => !requestedProviderFamilies.includes(provider),
        ),
        redactionCount: policyDecision.redactions.reduce(
          (count, redaction) => count + redaction.findings.length,
          0,
        ),
      },
    });
  }

  const adapters =
    environment.adapters ??
    createProviderRoster({
      env: environment.env ?? process.env,
      billingMode: options.billingMode,
    });
  const diagnostics: ProviderDiagnostic[] = [];
  const context: ProviderContext = {
    registry,
    env: environment.env ?? process.env,
    cwd: environment.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs,
    captureDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };
  let executionOptions = options;
  let unavailableProviders: UnavailableProvider[] = [];

  if (command === 'council') {
    const readiness = await resolveCouncilProviders(options, adapters, context);
    unavailableProviders = readiness.unavailableProviders;
    const minimumFamilies =
      options.minimumFamilies ??
      (readiness.providerFamilies.length >= DEFAULT_COUNCIL_MINIMUM_FAMILIES
        ? DEFAULT_COUNCIL_MINIMUM_FAMILIES
        : REDUCED_COUNCIL_MINIMUM_FAMILIES);
    const preflight = {
      classification: policyDecision.effectiveClassification,
      destinations: policyDecision.dispositions,
      requestedProviders: requestedProviderFamilies,
      selectedProviders: readiness.providerFamilies,
      unavailableProviders,
      eligibleProviders: options.eligibleProviderFamilies,
      omittedEligibleProviders: options.eligibleProviderFamilies.filter(
        (provider) => !requestedProviderFamilies.includes(provider),
      ),
      redactionCount: policyDecision.redactions.reduce(
        (count, redaction) => count + redaction.findings.length,
        0,
      ),
    };
    if (readiness.providerFamilies.length < minimumFamilies) {
      return output(4, undefined, {
        schemaVersion: SCHEMA_VERSION,
        command,
        status: 'blocked-quorum',
        runId: options.runId,
        message: `Council requires at least ${minimumFamilies} configured, reachable provider families; found ${readiness.providerFamilies.length}.`,
        preflight,
      });
    }
    executionOptions = {
      ...options,
      providerFamilies: readiness.providerFamilies,
      minimumFamilies,
      ...(minimumFamilies === REDUCED_COUNCIL_MINIMUM_FAMILIES &&
      readiness.providerFamilies.length === REDUCED_COUNCIL_MINIMUM_FAMILIES &&
      unavailableProviders.length > 0
        ? { reducedQuorumWarning: autoReducedQuorumWarning(unavailableProviders) }
        : {}),
    };
  }

  const assignmentHistory = await loadAssignmentHistory(executionOptions, environment);
  const { manifest, assignments, roleAssignments } = buildManifestAndAssignments(
    executionOptions,
    registry,
    configured.provenance,
    assignmentHistory,
  );
  const reducedQuorumWarning = manifest.quorumPolicy.reducedQuorum?.warning;
  const preflight = {
    classification: policyDecision.effectiveClassification,
    destinations: policyDecision.dispositions,
    requestedProviders: requestedProviderFamilies,
    selectedProviders: executionOptions.providerFamilies,
    unavailableProviders,
    eligibleProviders: options.eligibleProviderFamilies,
    omittedEligibleProviders: options.eligibleProviderFamilies.filter(
      (provider) => !requestedProviderFamilies.includes(provider),
    ),
    redactionCount: policyDecision.redactions.reduce(
      (count, redaction) => count + redaction.findings.length,
      0,
    ),
  };
  const runner = new CouncilRunner({ adapters, context });
  // Taken before execution so the record shows real elapsed time. Both timestamps were previously
  // the same post-run value, which made every session look instantaneous.
  const startedAt = (environment.now ?? (() => new Date().toISOString()))();
  const execution = await runner.run({
    runId: executionOptions.runId,
    motion: executionOptions.motion,
    rounds: executionOptions.rounds,
    assignments,
    quorumPolicy: manifest.quorumPolicy,
    ...(executionOptions.refinementTrigger === undefined
      ? {}
      : { refinementTrigger: executionOptions.refinementTrigger }),
  });
  const now = (environment.now ?? (() => new Date().toISOString()))();
  const records = await persistRun(
    executionOptions,
    policyDecision,
    manifest,
    execution,
    roleAssignments,
    startedAt,
    now,
  );
  // A run can no longer fail by failing to append a resolution, because it no longer appends one.
  // Exit code 5 (`record-failure`) is retired: session write failures already throw, and adjudication
  // is a separate command with its own exit status.
  const status = execution.outcome;
  return output(status === 'completed' ? 0 : 4, {
    schemaVersion: SCHEMA_VERSION,
    command,
    status,
    runId: executionOptions.runId,
    ...(reducedQuorumWarning === undefined ? {} : { warning: reducedQuorumWarning }),
    manifest,
    preflight,
    execution: publicExecution(execution),
    diagnostics,
    ...(records === undefined ? {} : { records }),
  });
}

async function providerContext(
  parsed: ParsedArguments,
  environment: CliFacadeEnvironment,
): Promise<{
  configured: ConfiguredModelRegistry;
  roster: ProviderRoster | Partial<Record<ProviderFamily, ProviderAdapter>>;
  context: ProviderContext;
}> {
  const configured = await configuredModelRegistry(parsed, environment);
  const roster =
    environment.adapters ??
    createProviderRoster({
      env: environment.env ?? process.env,
      billingMode: reportBillingMode(parsed),
    });
  return {
    configured,
    roster,
    context: {
      registry: configured.registry,
      env: environment.env ?? process.env,
      cwd: environment.cwd ?? process.cwd(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  };
}

function orderedAdapters(
  roster: Partial<Record<ProviderFamily, ProviderAdapter>>,
): ProviderAdapter[] {
  return ProviderFamilySchema.options.flatMap((provider) => {
    const adapter = roster[provider];
    return adapter === undefined ? [] : [adapter];
  });
}

function providerTransportResolution(
  provider: ProviderFamily,
  registry: ModelRegistry,
  roster: Partial<Record<ProviderFamily, ProviderAdapter>>,
): ProviderTransportResolution {
  const adapter = roster[provider];
  if (adapter === undefined) {
    return {
      preferred: registry[provider].transport,
      effective: null,
      reason: 'No adapter is available for this provider family.',
    };
  }
  if (adapter.transportResolution !== undefined) {
    return {
      ...adapter.transportResolution,
      preferred: registry[provider].transport,
    };
  }
  return {
    preferred: registry[provider].transport,
    effective: adapter.transport,
    reason: 'The adapter uses its governed preferred transport.',
  };
}

function selfCheckTransportResolutions(
  registry: ModelRegistry,
  roster: Partial<Record<ProviderFamily, ProviderAdapter>>,
): Record<ProviderFamily, ProviderTransportResolution> {
  return {
    anthropic: providerTransportResolution('anthropic', registry, roster),
    openai: providerTransportResolution('openai', registry, roster),
    xai: providerTransportResolution('xai', registry, roster),
    google: providerTransportResolution('google', registry, roster),
    deepseek: providerTransportResolution('deepseek', registry, roster),
    moonshot: providerTransportResolution('moonshot', registry, roster),
  };
}

async function healthCommand(
  command: 'health' | 'doctor',
  args: readonly string[],
  environment: CliFacadeEnvironment,
): Promise<CliFacadeResult> {
  const parsed = parseArguments(args, REGISTRY_REPORT_FLAGS);
  if (parsed.positionals.length > 0) throw new Error(`${command} accepts no positional arguments`);
  const providerConfiguration = await providerContext(parsed, environment);
  const adapters = orderedAdapters(providerConfiguration.roster);
  if (command === 'doctor') {
    const report = await doctor(
      adapters,
      providerConfiguration.context,
      (environment.now ?? (() => new Date().toISOString()))(),
      reportBillingMode(parsed),
    );
    return output(0, {
      ...report,
      engineIdentity: engineIdentity(providerConfiguration.configured, environment),
    });
  }
  const probes = await probeRoster(adapters, providerConfiguration.context);
  return output(0, {
    ...snapshot(probes, providerConfiguration.configured.registry),
    registryProvenance: providerConfiguration.configured.provenance,
  });
}

function recordsDirectory(root: string, scope: 'general' | 'project', projectId?: string): string {
  if (scope === 'general') return join(resolve(root), 'general', 'sessions');
  if (projectId === undefined) throw new Error('Project records require --project-id');
  return join(resolve(root), 'projects', safeStorageId(projectId, 'Project id'), 'sessions');
}

async function storedSessionCommand(
  command: 'jobs' | 'result' | 'cancel',
  args: readonly string[],
): Promise<CliFacadeResult> {
  const parsed = parseArguments(
    args,
    new Set(['help', 'json', 'project-id', 'records-root', 'run-id', 'scope']),
  );
  if (parsed.positionals.length > 0) throw new Error(`${command} accepts options only`);
  const root = oneFlag(parsed, 'records-root');
  if (root === undefined) throw new Error(`${command} requires --records-root`);
  const scope = z.enum(['general', 'project']).parse(oneFlag(parsed, 'scope') ?? 'general');
  const sessionsDirectory = recordsDirectory(root, scope, oneFlag(parsed, 'project-id'));

  if (command === 'jobs') {
    let names: string[];
    try {
      names = (await readdir(sessionsDirectory)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT') return output(0, { schemaVersion: SCHEMA_VERSION, sessions: [] });
      throw error;
    }
    const sessions = await Promise.all(
      names.map(async (name) =>
        SessionRecordSchema.parse(await Bun.file(join(sessionsDirectory, name)).json()),
      ),
    );
    sessions.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return output(0, { schemaVersion: SCHEMA_VERSION, sessions });
  }

  const runIdValue = oneFlag(parsed, 'run-id');
  if (runIdValue === undefined) throw new Error(`${command} requires --run-id`);
  const runId = safeStorageId(runIdValue, 'Run id');
  let session: SessionRecord;
  try {
    session = SessionRecordSchema.parse(
      await Bun.file(join(sessionsDirectory, `${runId}.json`)).json(),
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return output(4, undefined, { status: 'not-found', runId });
    throw error;
  }
  if (command === 'cancel') {
    return output(4, undefined, {
      status: 'not-cancellable',
      runId,
      reason: `Persisted session state '${session.status}' is terminal`,
    });
  }
  // The session's own `decisionState` is the state at write time and is never mutated, so after a
  // chair rules it still reads `awaiting-adjudication`. Reporting that alone would tell an auditor a
  // ruled motion is unruled. The current state is derived from the archive instead, and the ruling
  // and resolution ids are named so the ruling can be read.
  const store = CouncilStore.open(root);
  const states = await store.readDecisionStates(
    scope,
    scope === 'project'
      ? safeStorageId(oneFlag(parsed, 'project-id') as string, 'Project id')
      : undefined,
  );
  const current = states.find((candidate) => candidate.runId === runId);
  return output(0, {
    schemaVersion: SCHEMA_VERSION,
    session,
    ...(current === undefined
      ? {}
      : {
          decision: {
            state: current.decisionState,
            dataAvailability: current.dataAvailability,
            ...(current.rulingId === undefined ? {} : { rulingId: current.rulingId }),
            ...(current.resolutionId === undefined ? {} : { resolutionId: current.resolutionId }),
          },
        }),
  });
}

async function migrationCommand(
  args: readonly string[],
  environment: CliFacadeEnvironment,
): Promise<CliFacadeResult> {
  const parsed = parseArguments(
    args,
    new Set(['help', 'json', 'output', 'plan', 'root', 'rules', 'source']),
  );
  if (parsed.positionals.length !== 1) {
    throw new Error('migrate-general requires exactly one action: plan or apply');
  }
  const action = parsed.positionals[0];
  if (action === 'plan') {
    const root = oneFlag(parsed, 'root');
    const destination = oneFlag(parsed, 'output');
    if (root === undefined || destination === undefined) {
      throw new Error('migrate-general plan requires --root and --output');
    }
    const sourceRelativePath = oneFlag(parsed, 'source') ?? 'general/ledger.md';
    const sourceContent = await Bun.file(join(resolve(root), sourceRelativePath)).text();
    const rulesPath = oneFlag(parsed, 'rules');
    const rules =
      rulesPath === undefined
        ? []
        : z.array(MigrationRuleSchema).parse(await Bun.file(resolve(rulesPath)).json());
    const plan = planGeneralMigration({
      root,
      sourceRelativePath,
      sourceContent,
      plannedAt: (environment.now ?? (() => new Date().toISOString()))(),
      rules,
    });
    await writeTextAtomically(resolve(destination), `${JSON.stringify(plan, null, 2)}\n`);
    return output(0, {
      schemaVersion: SCHEMA_VERSION,
      status: 'planned',
      output: resolve(destination),
      planSha256: plan.planSha256,
      counts: plan.counts,
    });
  }
  if (action === 'apply') {
    const planPath = oneFlag(parsed, 'plan');
    if (planPath === undefined) throw new Error('migrate-general apply requires --plan');
    const plan = MigrationPlanSchema.parse(await Bun.file(resolve(planPath)).json());
    const manifest = await applyGeneralMigration(plan);
    return output(0, { schemaVersion: SCHEMA_VERSION, status: 'applied', manifest });
  }
  throw new Error(`Unknown migrate-general action: ${action}`);
}

/**
 * Record a chair's ruling on an executed motion, and the resolution that follows from it.
 *
 * This is the only path from a council run to a decision. It is deliberately a separate, explicit
 * command rather than a step inside `run`: the panel produces evidence, a named human produces the
 * decision, and the record has to show which of the two happened.
 */
async function adjudicateCommand(
  args: readonly string[],
  environment: CliFacadeEnvironment,
): Promise<CliFacadeResult> {
  const parsed = parseArguments(args, ADJUDICATE_FLAGS);
  if (hasFlag(parsed, 'help')) {
    return output(0, {
      command: 'adjudicate',
      summary: 'Record a chair ruling on an executed motion and append the resulting resolution.',
      required: ['--run-id', '--decision', '--rationale', '--authorised-by', '--records-root'],
      dissent:
        'Exactly one of --dissent-acknowledged or --no-dissent is required. A ruling must state whether the panel disagreed, because textual agreement across a shared schema is a prompt-quality signal rather than a mandate.',
      degraded:
        'A degraded session additionally requires --accept-degraded with --acceptance-rationale.',
      optional: ['--scope', '--project-id', '--followed-seats', '--set-aside-seats'],
    });
  }

  const recordsRoot = oneFlag(parsed, 'records-root');
  if (recordsRoot === undefined) throw new Error('adjudicate requires --records-root');
  const scope = CouncilScopeSchema.parse(oneFlag(parsed, 'scope') ?? 'general');
  const projectIdValue = oneFlag(parsed, 'project-id');
  if (scope === 'general' && projectIdValue !== undefined) {
    throw new Error('Project id requires --scope project');
  }
  if (scope === 'project' && projectIdValue === undefined) {
    throw new Error('Project scope requires --project-id');
  }
  const projectId =
    projectIdValue === undefined ? undefined : safeStorageId(projectIdValue, 'Project id');
  const runIdValue = oneFlag(parsed, 'run-id');
  if (runIdValue === undefined) throw new Error('adjudicate requires --run-id');
  const runId = safeStorageId(runIdValue, 'Run id');
  const decision = oneFlag(parsed, 'decision');
  const rationale = oneFlag(parsed, 'rationale');
  const authorisedBy = oneFlag(parsed, 'authorised-by');
  if (decision === undefined || rationale === undefined || authorisedBy === undefined) {
    throw new Error('adjudicate requires --decision, --rationale and --authorised-by');
  }

  // Forcing an explicit choice, rather than defaulting to false, is the point: a chair who never
  // considered whether the panel disagreed should not be able to produce a record that claims they
  // did, nor one that silently claims they did not.
  const acknowledged = hasFlag(parsed, 'dissent-acknowledged');
  const noDissent = hasFlag(parsed, 'no-dissent');
  if (acknowledged === noDissent) {
    throw new Error('adjudicate requires exactly one of --dissent-acknowledged or --no-dissent');
  }

  const seatList = (name: string): string[] => {
    const raw = parsed.flags.get(name);
    if (raw === undefined) return [];
    const seats = raw
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return [...new Set(seats)];
  };

  const store = CouncilStore.open(recordsRoot);
  const states = await store.readDecisionStates(scope, projectId);
  const state = states.find((candidate) => candidate.runId === runId);
  if (state === undefined) throw new Error(`No persisted session for run id: ${runId}`);
  if (state.decisionState === 'not-adjudicable') {
    throw new Error(
      `Run ${runId} has status ${state.status}; there is no quorum outcome to rule on. Re-run the motion instead.`,
    );
  }
  if (state.decisionState === 'adjudicated') {
    throw new Error(`Run ${runId} already has a chair ruling: ${state.rulingId}`);
  }

  const now = (environment.now ?? (() => new Date().toISOString()))();
  const title = decision
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);

  if (state.status === 'degraded') {
    const acceptanceRationale = oneFlag(parsed, 'acceptance-rationale');
    if (!hasFlag(parsed, 'accept-degraded') || acceptanceRationale === undefined) {
      throw new Error(
        `Run ${runId} is degraded; ruling on it requires --accept-degraded and --acceptance-rationale`,
      );
    }
    const acceptanceBase = {
      acceptanceId: deterministicId('acceptance', 'adjudicate', runId, now),
      runId,
      motionId: state.motionId,
      rationale: acceptanceRationale,
      authorisedBy,
      createdAt: now,
    } as const;
    await store.appendChairAcceptance(
      scope === 'general'
        ? { ...acceptanceBase, scope: 'general' }
        : { ...acceptanceBase, scope: 'project', projectId: projectId as string },
    );
  }

  const rulingId = safeStorageId(
    oneFlag(parsed, 'ruling-id') ?? deterministicId('ruling', 'adjudicate', runId, now),
    'Ruling id',
  );
  const rulingBase = {
    rulingId,
    runId,
    motionId: state.motionId,
    title,
    decision,
    rationale,
    authorisedBy,
    followedSeats: seatList('followed-seats'),
    setAsideSeats: seatList('set-aside-seats'),
    dissentAcknowledged: acknowledged,
    createdAt: now,
  } as const;
  await store.appendChairRuling(
    scope === 'general'
      ? { ...rulingBase, scope: 'general' }
      : { ...rulingBase, scope: 'project', projectId: projectId as string },
  );

  const resolutionId = safeStorageId(
    oneFlag(parsed, 'resolution-id') ?? deterministicId('resolution', 'adjudicate', runId, now),
    'Resolution id',
  );
  const resolutionBase = {
    resolutionId,
    runId,
    motionId: state.motionId,
    rulingId,
    title,
    decision,
    createdAt: now,
  } as const;
  await store.appendResolution(
    scope === 'general'
      ? { ...resolutionBase, scope: 'general' }
      : { ...resolutionBase, scope: 'project', projectId: projectId as string },
  );

  return output(0, {
    schemaVersion: SCHEMA_VERSION,
    command: 'adjudicate',
    status: 'adjudicated',
    runId,
    motionId: state.motionId,
    rulingId,
    resolutionId,
    decisionState: 'adjudicated',
    dataAvailability: state.dataAvailability,
    sessionStatus: state.status,
    dissentAcknowledged: acknowledged,
  });
}

function help(): CliFacadeResult {
  return output(0, {
    name: 'claude-council',
    commands: [
      'run',
      'council',
      'second-opinion',
      'result',
      'jobs',
      'cancel',
      'adjudicate',
      'health',
      'doctor',
      'migrate-general',
      'version',
      'self-check',
    ],
    invocation: 'All execution is explicit; no automatic hook starts a council.',
    defaultSeatCount: DEFAULT_SEAT_COUNT,
    councilOptions: {
      '--min-families <n>':
        'Explicit council family floor from 3 to 6. The standing floor is 4; the ordinary front door auto-reduces only when exactly 3 configured, reachable families remain, and marks that run as weaker.',
    },
    registryOptions: {
      '--registry <path>':
        'Use this strict partial registry override instead of the default locations.',
      '--records-root <path>':
        'Use <records-root>/models.json when present and report this resolved state root.',
    },
    registryPrecedence: [
      '--registry <path>',
      '<records-root>/models.json when present',
      '~/.claude/council/models.json when present',
      'built-in registry',
    ],
    installerProvenance:
      'Installers may set COUNCIL_INSTALLER_PROVENANCE; the engine reports it as installer-supplied and never self-attests a source commit.',
  });
}

export async function runCliFacade(
  argv: readonly string[],
  environment: CliFacadeEnvironment = {},
): Promise<CliFacadeResult> {
  try {
    const command = argv[0];
    const args = argv.slice(1);
    if (command === undefined || command === '--help' || command === 'help') return help();
    if (command === 'run' || command === 'council' || command === 'second-opinion') {
      return await runCouncilCommand(command, args, environment);
    }
    if (command === 'health' || command === 'doctor') {
      return await healthCommand(command, args, environment);
    }
    if (command === 'jobs' || command === 'result' || command === 'cancel') {
      return await storedSessionCommand(command, args);
    }
    if (command === 'migrate-general') return await migrationCommand(args, environment);
    if (command === 'version') {
      const parsed = parseArguments(args, REGISTRY_REPORT_FLAGS);
      if (parsed.positionals.length > 0) throw new Error('version accepts no positional arguments');
      const configured = await configuredModelRegistry(parsed, environment);
      return output(0, {
        schemaVersion: SCHEMA_VERSION,
        command,
        ...engineIdentity(configured, environment),
      });
    }
    if (command === 'adjudicate') return await adjudicateCommand(args, environment);
    if (command === 'self-check') {
      const parsed = parseArguments(args, REGISTRY_REPORT_FLAGS);
      if (parsed.positionals.length > 0)
        throw new Error('self-check accepts no positional arguments');
      const configured = await configuredModelRegistry(parsed, environment);
      const roster =
        environment.adapters ??
        createProviderRoster({
          env: environment.env ?? process.env,
          billingMode: reportBillingMode(parsed),
        });
      return output(0, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        providers: ProviderFamilySchema.options,
        routes: configured.registry,
        transportResolutions: selfCheckTransportResolutions(configured.registry, roster),
        registryProvenance: configured.provenance,
        lenses: roleCatalogue.map(({ name, category }) => ({ name, category })),
        runtimeDependencies: ['zod', 'proper-lockfile'],
      });
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    return output(2, undefined, {
      schemaVersion: SCHEMA_VERSION,
      status: 'invalid-command',
      message: safeError(error),
    });
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const stdin = process.stdin.isTTY ? undefined : await Bun.stdin.text();
  const result = await runCliFacade(argv, stdin === undefined ? {} : { stdin });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (import.meta.main) process.exit(await main());
