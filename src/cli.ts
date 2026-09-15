import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import packageManifest from '../package.json';
import { getMode, modes, resolveModeForCommand, type ModeName } from './modes';
import {
  DataClassificationSchema,
  MotionImpactSchema,
  ModelRegistryProvenanceSchema,
  ProjectPolicySchema,
  CouncilScopeSchema,
  ProviderFamilySchema,
  RefinementTriggerSchema,
  type ModelRegistryProvenance,
  type ProjectPolicy,
  type ProviderFamily,
} from './substrate/domain/schemas';
import {
  CallerSchema,
  ResultEnvelopeSchema,
  UNDECLARED_CALLER,
  buildEnvelope,
  spendFromRounds,
  type Caller,
  type ResultEnvelope,
} from './substrate/envelope';
import {
  BillingModeSchema,
  DEFAULT_BILLING_MODE,
  type BillingMode,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDiagnostic,
  type ProviderTransportResolution,
} from './substrate/execution/provider';
import { CouncilRunner } from './substrate/execution/runner';
import { snapshot } from './substrate/health/baseline';
import { doctor } from './substrate/health/doctor';
import { probeRoster } from './substrate/health/probe';
import {
  loadModelRegistryWithProvenance,
  ModelRegistrySchema,
  resolveModelRegistry,
  type LoadedModelRegistry,
  type ModelRegistry,
} from './substrate/models/registry';
import { executePattern } from './substrate/patterns';
import { evaluateOutbound } from './substrate/policy/data-guard';
import { scanAndRedact } from './substrate/policy/secrets';
import { createProviderRoster, type ProviderRoster } from './substrate/providers';
import { commitRecordFiles, type RecordCommitOutcome } from './substrate/records/commit';
import {
  MigrationPlanSchema,
  MigrationRuleSchema,
  applyGeneralMigration,
  planGeneralMigration,
} from './substrate/records/migrate-general';
import { minutesDirectory, writeMinutes } from './substrate/records/minutes';
import {
  CouncilStore,
  SessionRecordSchema,
  type PersistedDecisionState,
  type SessionRecord,
  writeTextAtomically,
} from './substrate/records/store';
import {
  inferMotionDomains,
  roleCatalogue,
  type AssignmentHistory,
} from './substrate/roles/allocator';
import {
  DEFAULT_COUNCIL_MINIMUM_FAMILIES,
  DEFAULT_SEAT_COUNT,
  REDUCED_COUNCIL_MINIMUM_FAMILIES,
  buildManifestAndAssignments,
  buildPreflight,
  loadAssignmentHistory,
  persistSession,
  publicExecution,
  sessionRecordPath,
  type SessionOptions,
  type UnavailableProvider,
} from './substrate/session';
import {
  createSpendLedger,
  effectiveBillingMode,
  spendCapExhaustedMessage,
} from './substrate/spend';

export const ADAPTER_CONTRACT_VERSION = 1 as const;
const SCHEMA_VERSION = 1;
// Whole-run budget, which the runner then divides PER ROUND (see runner.ts): a two-round
// council gives each seat half of it. At the previous 300_000 that was 150s per seat, which
// this engine's own settings cannot meet — codex is invoked at xhigh and claude at effort
// max, and on a substantial motion both reliably exceeded it, timing out whichever seat was
// asked to think hardest. Every provider then looked broken in turn while the fast seats
// passed, which is exactly how the failure presented. 1_200_000 leaves 10 minutes per seat
// per round; --timeout-ms still overrides, up to the one-hour ceiling.
const DEFAULT_TIMEOUT_MS = 1_200_000;
const PACKAGE_VERSION = z.string().trim().min(1).parse(packageManifest.version);
const EXECUTABLE_PATH = resolve(import.meta.main ? Bun.main : import.meta.path);
// dist/cli.js and src/cli.ts both sit one directory below the kernel repository root.
const KERNEL_ROOT = resolve(dirname(EXECUTABLE_PATH), '..');
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
  'caller',
  'classification',
  'contested',
  'domain',
  'dry-run',
  'harness',
  'help',
  'impact',
  'json',
  'motion',
  'motion-id',
  'project-id',
  'project-policy',
  'providers',
  'purpose',
  'refinement-question',
  'registry',
  'records-root',
  'rounds',
  'run-id',
  'scope',
  'spend-cap',
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

/** The commands this facade routes. `help` prints this list and an unknown command echoes it. */
const COMMANDS = [
  'run',
  'council',
  'second-opinion',
  'modes',
  'result',
  'jobs',
  'cancel',
  'adjudicate',
  'health',
  'doctor',
  'migrate-general',
  'version',
  'self-check',
] as const;

interface ParsedArguments {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

interface RunOptions extends SessionOptions {
  readonly command: 'run' | 'council' | 'second-opinion';
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

/**
 * The single route by which this CLI commits records. Both callers must carry the same kernel-repository
 * guard and the same child environment, so neither is left to a call site to remember.
 */
async function commitRecords(
  root: string,
  paths: readonly string[],
  message: string,
  environment: CliFacadeEnvironment,
): Promise<RecordCommitOutcome> {
  return commitRecordFiles({
    root,
    paths,
    message,
    forbiddenRoot: KERNEL_ROOT,
    env: environment.env ?? process.env,
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = scanAndRedact(message).redacted.replace(/\s+/g, ' ').trim();
  return (redacted || 'Council command failed').slice(0, 500);
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
  return command === 'council' ? modes.committee.defaults : modes['second-opinion'].defaults;
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
  const callerKind = oneFlag(parsed, 'caller');
  const harness = oneFlag(parsed, 'harness')?.trim();
  const purpose = oneFlag(parsed, 'purpose')?.trim();
  if (callerKind === undefined && (harness !== undefined || purpose !== undefined)) {
    throw new Error('--harness and --purpose require --caller human|agent');
  }
  const caller: Caller =
    callerKind === undefined
      ? UNDECLARED_CALLER
      : CallerSchema.parse({
          kind: callerKind,
          harness: harness ?? 'unknown',
          declared: true,
          ...(purpose === undefined || purpose.length === 0 ? {} : { purpose }),
        });
  const spendCap = parsed.flags.has('spend-cap')
    ? integerFlag(parsed, 'spend-cap', 0, 0, 100_000)
    : undefined;
  const mode: ModeName = resolveModeForCommand(command, significant);
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
    mode,
    chaired: command === 'council',
    caller,
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
    ...(spendCap === undefined ? {} : { spendCap }),
  };
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
      mode: options.mode,
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
    const assignmentHistory = await loadAssignmentHistory(options, environment.assignmentHistory);
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
      mode: options.mode,
      caller: options.caller,
      status: 'dry-run',
      runId: options.runId,
      ...(reducedQuorumWarning === undefined ? {} : { warning: reducedQuorumWarning }),
      manifest,
      preflight: buildPreflight({
        policyDecision,
        requestedProviders: requestedProviderFamilies,
        selectedProviders: requestedProviderFamilies,
        unavailableProviders: [],
        eligibleProviders: options.eligibleProviderFamilies,
      }),
    });
  }

  const mode = getMode(options.mode);
  const billingMode = effectiveBillingMode(mode.spend.policy, options.billingMode);
  const adapters =
    environment.adapters ??
    createProviderRoster({
      env: environment.env ?? process.env,
      billingMode,
    });
  const diagnostics: ProviderDiagnostic[] = [];
  const prepareContext: ProviderContext = {
    registry,
    env: environment.env ?? process.env,
    cwd: environment.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs,
    captureDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };

  const prepared = await mode.prepare({
    options,
    adapters,
    context: prepareContext,
    policyDecision,
  });
  if (prepared.kind === 'blocked-quorum') {
    return output(4, undefined, {
      schemaVersion: SCHEMA_VERSION,
      command,
      mode: mode.name,
      status: 'blocked-quorum',
      runId: options.runId,
      message: prepared.message,
      preflight: buildPreflight({
        policyDecision,
        requestedProviders: requestedProviderFamilies,
        selectedProviders: prepared.selectedProviders,
        unavailableProviders: prepared.unavailableProviders,
        eligibleProviders: options.eligibleProviderFamilies,
      }),
    });
  }
  const executionOptions: RunOptions = { ...prepared.options, command };
  const unavailableProviders: UnavailableProvider[] = [...prepared.unavailableProviders];

  // Sized after preparation, and deliberately absent from the context `prepare` was given. The
  // `seats x rounds` budget describes execution, and preparation is where the seat count is still
  // being decided: a committee's health probes run through the same fallback wrapper, so a ledger
  // built before `prepare` would let unreachable families spend the execution budget on probes and
  // then refuse the seats that budget was for. Probes keep their pre-existing uncapped behaviour.
  const ledger = createSpendLedger(
    options.spendCap ??
      mode.spend.defaultCap(executionOptions.providerFamilies.length, executionOptions.rounds),
  );
  const context: ProviderContext = { ...prepareContext, spend: ledger };

  const assignmentHistory = await loadAssignmentHistory(
    executionOptions,
    environment.assignmentHistory,
  );
  const { manifest, assignments, roleAssignments } = buildManifestAndAssignments(
    executionOptions,
    registry,
    configured.provenance,
    assignmentHistory,
  );
  const reducedQuorumWarning = manifest.quorumPolicy.reducedQuorum?.warning;
  const preflight = buildPreflight({
    policyDecision,
    requestedProviders: requestedProviderFamilies,
    selectedProviders: executionOptions.providerFamilies,
    unavailableProviders,
    eligibleProviders: options.eligibleProviderFamilies,
  });
  const runner = new CouncilRunner({ adapters, context });
  // Taken before execution so the record shows real elapsed time. Both timestamps were previously
  // the same post-run value, which made every session look instantaneous.
  const startedAt = (environment.now ?? (() => new Date().toISOString()))();
  const execution = await executePattern(mode.pattern, runner, {
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
  const status = execution.outcome;
  const decisionState: PersistedDecisionState =
    status === 'completed' || status === 'degraded' ? 'awaiting-adjudication' : 'not-adjudicable';
  const degraded: string[] = [];
  if (!options.caller.declared) degraded.push('caller-undeclared');
  if (command === 'run' && mode.name === 'committee') degraded.push('legacy-run-alias');
  if (command === 'second-opinion' && mode.name === 'committee') {
    degraded.push('legacy-significant-second-opinion');
  }
  if (ledger.refused > 0) degraded.push('spend-cap-reached');
  const modeOutput = mode.outputSchema.parse(
    mode.output({ result: execution, decisionState }),
  ) as Record<string, unknown>;
  const envelope: ResultEnvelope = buildEnvelope({
    mode: mode.name,
    session: executionOptions.runId,
    caller: options.caller,
    pattern: mode.pattern,
    rounds: execution.rounds,
    assignments,
    output: modeOutput,
    spend: spendFromRounds(execution.rounds, {
      billing: billingMode,
      policy: mode.spend.policy,
      cap: ledger.cap,
      refused: ledger.refused,
    }),
    degraded,
    record: { session: sessionRecordPath(executionOptions) },
  });
  const persisted = await persistSession(
    executionOptions,
    policyDecision,
    manifest,
    execution,
    roleAssignments,
    startedAt,
    now,
    envelope,
  );
  const records = persisted?.records;
  // Durability is Git: the terminal record is committed in the records repository before this run
  // reports success. A records root that is not a work tree is a degradation, not a failure — the
  // record is still on disk — so it is named in `degraded` rather than thrown.
  let emitted: ResultEnvelope = envelope;
  if (persisted !== undefined && executionOptions.recordsRoot !== undefined) {
    const commit = await commitRecords(
      executionOptions.recordsRoot,
      persisted.paths,
      `council: record ${executionOptions.runId}`,
      environment,
    );
    if (!commit.committed) degraded.push(`records-not-committed: ${commit.reason}`);
    const directory = minutesDirectory(
      environment.env ?? process.env,
      environment.cwd ?? process.cwd(),
    );
    // Minutes are a convenience copy for the vault's ingest. The record itself is already written
    // and, by this point, committed, so an unwritable minutes directory degrades the run in the
    // same way an uncommittable record does rather than failing it.
    let minutes: string | null = null;
    if (directory !== null) {
      try {
        minutes = await writeMinutes({
          directory,
          envelope,
          rounds: execution.rounds,
          motion: executionOptions.motion,
          startedAt,
          completedAt: now,
        });
      } catch (error) {
        degraded.push(`minutes-not-written: ${safeError(error)}`);
      }
    }
    const unvalidated = {
      ...envelope,
      degraded: [...degraded],
      record: {
        session: envelope.record.session,
        committed: commit.committed,
        ...(commit.committed ? { commitSha: commit.sha } : {}),
        minutes,
      },
    };
    // The record is already written and committed, so the documented invariant — a run that has
    // written and committed its record never fails afterwards — has to hold here too. A schema
    // failure at this point is a defect worth reporting, not a reason to discard a durable run.
    try {
      emitted = ResultEnvelopeSchema.parse(unvalidated);
    } catch (error) {
      degraded.push(`envelope-not-validated: ${safeError(error)}`);
      emitted = { ...unvalidated, degraded: [...degraded] };
    }
  }
  // A run can no longer fail by failing to append a resolution, because it no longer appends one.
  // Exit code 5 (`record-failure`) is retired: session write failures already throw, and adjudication
  // is a separate command with its own exit status.
  const stoppedAtCap = envelope.spend.stoppedAtCap;
  return output(status === 'completed' && !stoppedAtCap ? 0 : 4, {
    schemaVersion: SCHEMA_VERSION,
    command,
    mode: mode.name,
    status,
    runId: executionOptions.runId,
    ...(reducedQuorumWarning === undefined ? {} : { warning: reducedQuorumWarning }),
    ...(stoppedAtCap ? { spendWarning: spendCapExhaustedMessage(ledger.cap) } : {}),
    manifest,
    preflight,
    execution: publicExecution(execution),
    diagnostics,
    envelope: emitted,
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

  // Every file this adjudication writes, so the ruling and its resolution are committed together
  // rather than one record at a time.
  const written: string[] = [];

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
    written.push(
      ...(
        await store.appendChairAcceptance(
          scope === 'general'
            ? { ...acceptanceBase, scope: 'general' }
            : { ...acceptanceBase, scope: 'project', projectId: projectId as string },
        )
      ).paths,
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
  written.push(
    ...(
      await store.appendChairRuling(
        scope === 'general'
          ? { ...rulingBase, scope: 'general' }
          : { ...rulingBase, scope: 'project', projectId: projectId as string },
      )
    ).paths,
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
  written.push(
    ...(
      await store.appendResolution(
        scope === 'general'
          ? { ...resolutionBase, scope: 'general' }
          : { ...resolutionBase, scope: 'project', projectId: projectId as string },
      )
    ).paths,
  );

  const commit = await commitRecords(
    recordsRoot,
    written,
    `council: ruling ${rulingId} and resolution ${resolutionId} for ${runId}`,
    environment,
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
    records: commit.committed
      ? { committed: true, commitSha: commit.sha }
      : { committed: false, reason: commit.reason },
  });
}

function help(): CliFacadeResult {
  return output(0, {
    name: 'convene',
    commands: [...COMMANDS],
    invocation: 'All execution is explicit; no automatic hook starts a council.',
    defaultSeatCount: DEFAULT_SEAT_COUNT,
    runOptions: {
      '--caller human|agent':
        'Declare who is asking. Absent, the envelope reports caller-undeclared in degraded.',
      '--harness <name>': 'Name the harness the caller is running in. Requires --caller.',
      '--purpose <text>': 'State why the motion is being put. Requires --caller.',
      '--spend-cap <n>':
        'Bound metered fallback calls for this session. The default is seats x rounds; reaching the cap exits 4 and marks the envelope spend-cap-reached.',
    },
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
    if (command === 'modes') {
      const parsed = parseArguments(args, new Set(['help', 'json']));
      if (parsed.positionals.length > 0) throw new Error('modes accepts no positional arguments');
      return output(0, {
        schemaVersion: SCHEMA_VERSION,
        modes: Object.values(modes).map((mode) => ({
          name: mode.name,
          knobs: mode.knobs,
          pattern: mode.pattern,
          defaults: mode.defaults,
          spend: { policy: mode.spend.policy },
        })),
      });
    }
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
    throw new Error(
      `Unknown command: ${command}. Commands: ${COMMANDS.join(', ')}. Modes: ${Object.keys(
        modes,
      ).join(', ')}`,
    );
  } catch (error) {
    return output(2, undefined, {
      schemaVersion: SCHEMA_VERSION,
      status: 'invalid-command',
      message: safeError(error),
    });
  }
}

/** Commands that accept the motion on stdin when --motion is absent. */
const STDIN_MOTION_COMMANDS: ReadonlySet<string> = new Set(['run', 'council', 'second-opinion']);

/**
 * Whether this invocation should consume stdin.
 *
 * Reading stdin unconditionally makes every command block forever when stdin is an open
 * pipe that never reaches EOF — which is exactly how a CLI is invoked from an agent harness,
 * a CI step or `cmd &` with job control off. The failure is silent and total: no output, no
 * error, no timeout, because the process blocks before it has parsed a single argument.
 * Observed as a 16-hour hang on `council --motion ...`, where the motion was supplied on the
 * command line and stdin was never wanted in the first place.
 *
 * So read it only when it can actually be used: a motion-taking command with no --motion.
 */
export function shouldReadStdin(argv: readonly string[], isTty: boolean): boolean {
  if (isTty) return false;
  const command = argv[0];
  if (command === undefined || !STDIN_MOTION_COMMANDS.has(command)) return false;
  return !argv.some((argument) => argument === '--motion' || argument.startsWith('--motion='));
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const stdin = shouldReadStdin(argv, process.stdin.isTTY === true)
    ? await Bun.stdin.text()
    : undefined;
  const result = await runCliFacade(argv, stdin === undefined ? {} : { stdin });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (import.meta.main) process.exit(await main());
