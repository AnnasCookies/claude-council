import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  DataClassificationSchema,
  MotionImpactSchema,
  ProjectPolicySchema,
  ProviderFamilySchema,
  RefinementTriggerSchema,
  RunManifestSchema,
  type DataClassification,
  type ProjectPolicy,
  type ProviderFamily,
  type RefinementTrigger,
  type RunManifest,
} from './domain/schemas';
import {
  CouncilAnswerSchema,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDiagnostic,
} from './execution/provider';
import {
  CouncilRunner,
  type CouncilRunResult,
  type CouncilSeatAssignment,
} from './execution/runner';
import { snapshot } from './health/baseline';
import { doctor } from './health/doctor';
import { probeRoster } from './health/probe';
import { loadModelRegistry, type ModelRegistry } from './models/registry';
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

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_SEAT_COUNT = 5;
const SAFE_STORAGE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'contested', 'help']);
const COMMON_RUN_FLAGS = new Set([
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
  'records-root',
  'rounds',
  'run-id',
  'scope',
  'timeout-ms',
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
  readonly recordsRoot?: string;
}

export interface CliFacadeEnvironment {
  readonly registry?: ModelRegistry;
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

async function parseRunOptions(
  command: RunOptions['command'],
  args: readonly string[],
  environment: CliFacadeEnvironment,
  registry: ModelRegistry,
): Promise<RunOptions> {
  const parsed = parseArguments(args, COMMON_RUN_FLAGS);
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
    ...(refinementTrigger === undefined ? {} : { refinementTrigger }),
    timeoutMs: integerFlag(parsed, 'timeout-ms', DEFAULT_TIMEOUT_MS, 1, 3_600_000),
    ...((oneFlag(parsed, 'records-root') ?? environment.recordsRoot) === undefined
      ? {}
      : { recordsRoot: oneFlag(parsed, 'records-root') ?? environment.recordsRoot }),
  };
}

function quorumPolicy(options: RunOptions): RunManifest['quorumPolicy'] {
  const significant =
    options.command === 'council' || options.impact === 'high' || options.contested;
  return {
    minimumDistinctFamilies: significant ? 4 : 3,
    requiresContrarian: significant,
  };
}

function buildManifestAndAssignments(
  options: RunOptions,
  registry: ModelRegistry,
  history: AssignmentHistory,
): {
  manifest: RunManifest;
  assignments: CouncilSeatAssignment[];
  roleAssignments: RoleAssignment[];
} {
  const lenses = selectLenses(
    { domains: [...options.domains], impact: options.impact, contested: options.contested },
    options.providerFamilies.length,
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
    lenses,
    rounds: options.rounds,
    ...(options.refinementTrigger === undefined
      ? {}
      : { refinementTrigger: options.refinementTrigger }),
    quorumPolicy: quorumPolicy(options),
    evidenceReferences: [],
  });
  return { manifest, assignments, roleAssignments };
}

function publicExecution(result: CouncilRunResult): Omit<CouncilRunResult, 'motion'> {
  const { motion: _motion, ...safeResult } = result;
  return safeResult;
}

function parseCouncilAnswer(value: string): z.infer<typeof CouncilAnswerSchema> | undefined {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch {
    return undefined;
  }
  return CouncilAnswerSchema.safeParse(parsedJson).data;
}

function consensusRecommendation(result: CouncilRunResult): string | undefined {
  const finalRound = result.rounds.at(-1);
  if (finalRound === undefined) return undefined;
  const recommendationsByFamily = new Map<ProviderFamily, string>();
  for (const response of finalRound.responses) {
    if (response.status !== 'ok') continue;
    const answer = parseCouncilAnswer(response.answer);
    if (answer === undefined) return undefined;
    const recommendation = answer.recommendation.trim();
    const priorRecommendation = recommendationsByFamily.get(response.provider);
    if (
      priorRecommendation !== undefined &&
      priorRecommendation.toLocaleLowerCase() !== recommendation.toLocaleLowerCase()
    ) {
      return undefined;
    }
    recommendationsByFamily.set(response.provider, recommendation);
  }
  if (recommendationsByFamily.size < result.quorum.minimumDistinctFamilies) return undefined;
  const recommendations = [...recommendationsByFamily.values()];
  const canonical = recommendations[0]?.toLocaleLowerCase();
  if (canonical === undefined) return undefined;
  return recommendations.every((recommendation) => recommendation.toLocaleLowerCase() === canonical)
    ? recommendations[0]
    : undefined;
}

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
  now: string,
): Promise<
  | {
      session: true;
      resolution: boolean;
      resolutionBlockReason?:
        'motion-already-resolved' | 'resolution-id-conflict' | 'resolution-append-failed';
    }
  | undefined
> {
  if (options.recordsRoot === undefined) return undefined;
  if (options.scope === 'project' && options.projectId === undefined) {
    throw new Error('Project record persistence requires a project id');
  }
  const store = CouncilStore.open(options.recordsRoot);
  const status = result.outcome;
  const sessionBase = {
    runId: options.runId,
    motionId: options.motionId,
    status,
    motion: options.motion,
    startedAt: now,
    completedAt: now,
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
    assignments: roleAssignments,
    summary:
      status === 'completed'
        ? `Quorum passed across ${result.quorum.successfulFamilies.length} provider families.`
        : status === 'degraded'
          ? `Degraded result across ${result.quorum.successfulFamilies.length} provider families; chair acceptance is required before resolution.`
          : `Quorum blocked: ${result.quorum.failureReasons.join(', ') || 'insufficient responses'}.`,
  } as const;
  const session: SessionRecord =
    options.scope === 'general'
      ? { ...sessionBase, scope: 'general' }
      : {
          ...sessionBase,
          scope: 'project',
          projectId: options.projectId as string,
        };
  await store.writeSession(session);

  const recommendation = consensusRecommendation(result);
  if (status !== 'completed' || recommendation === undefined) {
    return { session: true, resolution: false };
  }
  const resolutionBase = {
    resolutionId: deterministicId('resolution', options.command, options.motion, now),
    runId: options.runId,
    motionId: options.motionId,
    title: options.motion
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 200),
    decision: recommendation,
    createdAt: now,
  } as const;
  try {
    await store.appendResolution(
      options.scope === 'general'
        ? { ...resolutionBase, scope: 'general' }
        : {
            ...resolutionBase,
            scope: 'project',
            projectId: options.projectId as string,
          },
    );
    return { session: true, resolution: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const resolutionBlockReason = /motion already has a resolution/i.test(message)
      ? 'motion-already-resolved'
      : /duplicate resolution id/i.test(message)
        ? 'resolution-id-conflict'
        : 'resolution-append-failed';
    return { session: true, resolution: false, resolutionBlockReason };
  }
}

async function runCouncilCommand(
  command: RunOptions['command'],
  args: readonly string[],
  environment: CliFacadeEnvironment,
): Promise<CliFacadeResult> {
  const registry = environment.registry ?? (await loadModelRegistry());
  const options = await parseRunOptions(command, args, environment, registry);
  const destinations = options.providerFamilies.map((provider) => ({
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
        selectedProviders: options.providerFamilies,
        eligibleProviders: options.eligibleProviderFamilies,
        omittedEligibleProviders: options.eligibleProviderFamilies.filter(
          (provider) => !options.providerFamilies.includes(provider),
        ),
        decision: policyDecision,
      },
    });
  }

  const assignmentHistory = await loadAssignmentHistory(options, environment);
  const { manifest, assignments, roleAssignments } = buildManifestAndAssignments(
    options,
    registry,
    assignmentHistory,
  );
  const preflight = {
    classification: policyDecision.effectiveClassification,
    destinations: policyDecision.dispositions,
    selectedProviders: options.providerFamilies,
    eligibleProviders: options.eligibleProviderFamilies,
    omittedEligibleProviders: options.eligibleProviderFamilies.filter(
      (provider) => !options.providerFamilies.includes(provider),
    ),
    redactionCount: policyDecision.redactions.reduce(
      (count, redaction) => count + redaction.findings.length,
      0,
    ),
  };
  if (options.dryRun) {
    return output(0, {
      schemaVersion: SCHEMA_VERSION,
      command,
      status: 'dry-run',
      runId: options.runId,
      manifest,
      preflight,
    });
  }

  const adapters = environment.adapters ?? createProviderRoster();
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
  const runner = new CouncilRunner({ adapters, context });
  const execution = await runner.run({
    runId: options.runId,
    motion: options.motion,
    rounds: options.rounds,
    assignments,
    quorumPolicy: manifest.quorumPolicy,
    ...(options.refinementTrigger === undefined
      ? {}
      : { refinementTrigger: options.refinementTrigger }),
  });
  const now = (environment.now ?? (() => new Date().toISOString()))();
  const records = await persistRun(
    options,
    policyDecision,
    manifest,
    execution,
    roleAssignments,
    now,
  );
  const resolutionPersistenceFailed = records?.resolutionBlockReason === 'resolution-append-failed';
  const status = resolutionPersistenceFailed ? 'record-failure' : execution.outcome;
  return output(resolutionPersistenceFailed ? 5 : status === 'completed' ? 0 : 4, {
    schemaVersion: SCHEMA_VERSION,
    command,
    status,
    runId: options.runId,
    manifest,
    preflight,
    execution: publicExecution(execution),
    diagnostics,
    ...(records === undefined ? {} : { records }),
  });
}

async function providerContext(environment: CliFacadeEnvironment): Promise<{
  registry: ModelRegistry;
  roster: ProviderRoster | Partial<Record<ProviderFamily, ProviderAdapter>>;
  context: ProviderContext;
}> {
  const registry = environment.registry ?? (await loadModelRegistry());
  const roster = environment.adapters ?? createProviderRoster();
  return {
    registry,
    roster,
    context: {
      registry,
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

async function healthCommand(
  command: 'health' | 'doctor',
  args: readonly string[],
  environment: CliFacadeEnvironment,
): Promise<CliFacadeResult> {
  const parsed = parseArguments(args, new Set(['help', 'json']));
  if (parsed.positionals.length > 0) throw new Error(`${command} accepts no positional arguments`);
  const configured = await providerContext(environment);
  const adapters = orderedAdapters(configured.roster);
  if (command === 'doctor') {
    const report = await doctor(adapters, configured.context);
    return output(0, report);
  }
  const probes = await probeRoster(adapters, configured.context);
  return output(0, snapshot(probes, configured.registry));
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
  return output(0, { schemaVersion: SCHEMA_VERSION, session });
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
      'health',
      'doctor',
      'migrate-general',
      'self-check',
    ],
    invocation: 'All execution is explicit; no automatic hook starts a council.',
    defaultSeatCount: DEFAULT_SEAT_COUNT,
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
    if (command === 'self-check') {
      const parsed = parseArguments(args, new Set(['help', 'json']));
      if (parsed.positionals.length > 0)
        throw new Error('self-check accepts no positional arguments');
      const registry = environment.registry ?? (await loadModelRegistry());
      return output(0, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        providers: ProviderFamilySchema.options,
        routes: registry,
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
