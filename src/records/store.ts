import { randomUUID } from 'node:crypto';
import { dirname, basename, join, resolve } from 'node:path';
import { link, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { z } from 'zod';
import { lock } from 'proper-lockfile';
import { QuorumEvaluationSchema } from '../domain/quorum';
import {
  CouncilScopeSchema,
  DataClassificationSchema,
  ProviderFamilySchema,
  QuorumPolicySchema,
  RefinementTriggerSchema,
  SeatErrorSchema,
  SeatResponseSchema,
} from '../domain/schemas';
import type { CouncilScope } from '../domain/schemas';
import { AssignmentHistorySchema, type AssignmentHistory } from '../roles/allocator';

const NonEmptyStringSchema = z.string().trim().min(1);
const SingleLineStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');
const TimestampSchema = z.string().datetime({ offset: true });
const StorageIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
  .refine((value) => value !== '.' && value !== '..', 'must be a safe storage identifier');

export const ExternalDestinationRecordSchema = z.strictObject({
  provider: ProviderFamilySchema,
  model: SingleLineStringSchema,
  endpoint: z.string().url().optional(),
});
export type ExternalDestinationRecord = z.infer<typeof ExternalDestinationRecordSchema>;

export const PersistedPolicyDecisionSchema = z.strictObject({
  kind: z.enum(['allowed', 'blocked']),
  classification: DataClassificationSchema,
  reasonCodes: z.array(SingleLineStringSchema),
});
export type PersistedPolicyDecision = z.infer<typeof PersistedPolicyDecisionSchema>;

export const SessionStatusSchema = z.enum([
  'completed',
  'degraded',
  'blocked-quorum',
  'failed',
  'cancelled',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionProtocolSchema = z
  .strictObject({
    requestedRounds: z.number().int().min(1).max(3),
    refinementTrigger: RefinementTriggerSchema.optional(),
    quorumPolicy: QuorumPolicySchema,
  })
  .superRefine(({ requestedRounds, refinementTrigger, quorumPolicy }, context) => {
    if (quorumPolicy.requiresContrarian && requestedRounds < 2) {
      context.addIssue({
        code: 'custom',
        path: ['requestedRounds'],
        message: 'Significant sessions require a rebuttal round',
      });
    }
    if (!quorumPolicy.requiresContrarian && requestedRounds !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['requestedRounds'],
        message: 'Ordinary sessions require exactly one blind round',
      });
    }
    if (requestedRounds === 3 && refinementTrigger === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['refinementTrigger'],
        message: 'Three-round sessions require their refinement trigger',
      });
    }
    if (requestedRounds !== 3 && refinementTrigger !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['refinementTrigger'],
        message: 'Only three-round sessions may persist a refinement trigger',
      });
    }
  });
export type SessionProtocol = z.infer<typeof SessionProtocolSchema>;

/**
 * Persisted round shape. Deliberately pinned here rather than imported from the runner: a record
 * format must not change meaning because a runtime type was refactored. `tests/core/records.test.ts`
 * asserts a real `RoundExecution` still parses as a `PersistedRound`, so drift is caught by a test
 * instead of by a corrupted archive.
 */
export const PersistedSeatRetrySchema = z.strictObject({
  seatId: NonEmptyStringSchema,
  provider: ProviderFamilySchema,
  role: NonEmptyStringSchema,
  attempt: z.literal(2),
  reason: z.strictObject({
    status: z.enum(['failed', 'timed-out', 'cancelled']),
    error: SeatErrorSchema,
  }),
});
export type PersistedSeatRetry = z.infer<typeof PersistedSeatRetrySchema>;

export const PersistedRoundSchema = z.strictObject({
  round: z.number().int().min(1).max(3),
  phase: z.enum(['analysis', 'rebuttal', 'refinement']),
  responses: z.array(SeatResponseSchema).min(1),
  retries: z.array(PersistedSeatRetrySchema),
});
export type PersistedRound = z.infer<typeof PersistedRoundSchema>;

/**
 * Everything needed to audit a decision rather than merely a configuration: what each seat actually
 * said, which model actually answered, whether that identity verified, what was retried and why,
 * and what the quorum evaluation concluded. Required on every v2 write.
 */
export const ExecutionSnapshotSchema = z.strictObject({
  rounds: z.array(PersistedRoundSchema).min(1).max(3),
  quorum: QuorumEvaluationSchema,
  rebuttalObligation: z.strictObject({
    minimumSuccessfulResponses: z.number().int().nonnegative(),
    successfulResponses: z.number().int().nonnegative(),
    satisfied: z.boolean(),
  }),
  synthesisEligible: z.boolean(),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

/**
 * Whether a record carries decision-level evidence. Legacy records predate the execution snapshot
 * and are marked `unavailable` rather than being back-filled: "never captured" must stay
 * distinguishable from "legitimately empty", or an evaluation built on this archive silently treats
 * missing evidence as a negative result.
 */
export const DataAvailabilitySchema = z.enum(['unavailable', 'captured']);
export type DataAvailability = z.infer<typeof DataAvailabilitySchema>;

/**
 * Decision state as persisted. Only two values are reachable at write time, because a run cannot
 * adjudicate itself — that is the whole point of deleting textual auto-resolution. `adjudicated` is
 * derived at read time from the presence of a chair ruling, so no record is ever mutated after the
 * fact.
 */
export const PersistedDecisionStateSchema = z.enum(['awaiting-adjudication', 'not-adjudicable']);
export type PersistedDecisionState = z.infer<typeof PersistedDecisionStateSchema>;

export const DecisionStateSchema = z.enum([
  'awaiting-adjudication',
  'adjudicated',
  'not-adjudicable',
]);
export type DecisionState = z.infer<typeof DecisionStateSchema>;

const SessionRecordShape = {
  runId: StorageIdSchema,
  motionId: StorageIdSchema,
  status: SessionStatusSchema,
  motion: NonEmptyStringSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  policyDecision: PersistedPolicyDecisionSchema,
  destinations: z.array(ExternalDestinationRecordSchema),
  protocol: SessionProtocolSchema,
  assignments: AssignmentHistorySchema.default([]),
  summary: NonEmptyStringSchema.optional(),
};

const CurrentSessionRecordShape = {
  ...SessionRecordShape,
  schemaVersion: z.literal(2),
  decisionState: PersistedDecisionStateSchema,
  execution: ExecutionSnapshotSchema,
};

const LegacyGeneralSessionRecordSchema = z.strictObject({
  ...SessionRecordShape,
  scope: z.literal('general'),
});

const LegacyProjectSessionRecordSchema = z.strictObject({
  ...SessionRecordShape,
  scope: z.literal('project'),
  projectId: StorageIdSchema,
  projectDisplayName: SingleLineStringSchema.optional(),
});

const CurrentGeneralSessionRecordSchema = z.strictObject({
  ...CurrentSessionRecordShape,
  scope: z.literal('general'),
});

const CurrentProjectSessionRecordSchema = z.strictObject({
  ...CurrentSessionRecordShape,
  scope: z.literal('project'),
  projectId: StorageIdSchema,
  projectDisplayName: SingleLineStringSchema.optional(),
});

function refineSessionRecord(
  record: z.infer<typeof SessionRecordSchema>,
  context: z.RefinementCtx,
): void {
  if (record.status === 'completed' && record.completedAt === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'completed sessions require completedAt',
    });
  }
  if (
    record.completedAt !== undefined &&
    Date.parse(record.completedAt) < Date.parse(record.startedAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'completedAt must not precede startedAt',
    });
  }

  const seatIds = new Set<string>();
  const lensNames = new Set<string>();
  for (const [index, assignment] of record.assignments.entries()) {
    if (assignment.runId !== record.runId) {
      context.addIssue({
        code: 'custom',
        path: ['assignments', index, 'runId'],
        message: 'session assignments must match the session runId',
      });
    }
    if (assignment.motionId !== record.motionId) {
      context.addIssue({
        code: 'custom',
        path: ['assignments', index, 'motionId'],
        message: 'session assignments must match the session motionId',
      });
    }
    if (seatIds.has(assignment.seatId)) {
      context.addIssue({
        code: 'custom',
        path: ['assignments', index, 'seatId'],
        message: 'session assignments must use unique seats',
      });
    }
    if (lensNames.has(assignment.lensName)) {
      context.addIssue({
        code: 'custom',
        path: ['assignments', index, 'lensName'],
        message: 'session assignments must use unique lenses',
      });
    }
    seatIds.add(assignment.seatId);
    lensNames.add(assignment.lensName);
  }

  if (!('schemaVersion' in record)) return;
  // A blocked or failed run has nothing for a chair to rule on; anything that produced a quorum
  // outcome is awaiting adjudication until a chair rules. Getting this backwards would either hide
  // real decisions or invite rulings on runs that never reached a verdict.
  const adjudicable = record.status === 'completed' || record.status === 'degraded';
  const expected: PersistedDecisionState = adjudicable
    ? 'awaiting-adjudication'
    : 'not-adjudicable';
  if (record.decisionState !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['decisionState'],
      message: `sessions with status ${record.status} must persist decisionState ${expected}`,
    });
  }
}

/**
 * Reads both record generations and writes only the current one. v2 is tried first: `strictObject`
 * means a v2 payload cannot masquerade as legacy (its extra keys are rejected) and a legacy payload
 * cannot masquerade as v2 (`schemaVersion` is missing), so the union cannot mis-classify.
 */
export const SessionRecordSchema = z
  .union([
    z.discriminatedUnion('scope', [
      CurrentGeneralSessionRecordSchema,
      CurrentProjectSessionRecordSchema,
    ]),
    z.discriminatedUnion('scope', [
      LegacyGeneralSessionRecordSchema,
      LegacyProjectSessionRecordSchema,
    ]),
  ])
  .superRefine(refineSessionRecord);
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const CurrentSessionRecordSchema = z
  .discriminatedUnion('scope', [
    CurrentGeneralSessionRecordSchema,
    CurrentProjectSessionRecordSchema,
  ])
  .superRefine(refineSessionRecord);
export type CurrentSessionRecord = z.infer<typeof CurrentSessionRecordSchema>;

export function sessionDataAvailability(record: SessionRecord): DataAvailability {
  return 'schemaVersion' in record ? 'captured' : 'unavailable';
}

const ChairAcceptanceRecordShape = {
  acceptanceId: StorageIdSchema,
  runId: StorageIdSchema,
  motionId: StorageIdSchema,
  rationale: NonEmptyStringSchema,
  authorisedBy: SingleLineStringSchema,
  createdAt: TimestampSchema,
};

const GeneralChairAcceptanceRecordSchema = z.strictObject({
  ...ChairAcceptanceRecordShape,
  scope: z.literal('general'),
});

const ProjectChairAcceptanceRecordSchema = z.strictObject({
  ...ChairAcceptanceRecordShape,
  scope: z.literal('project'),
  projectId: StorageIdSchema,
});

export const ChairAcceptanceRecordSchema = z.discriminatedUnion('scope', [
  GeneralChairAcceptanceRecordSchema,
  ProjectChairAcceptanceRecordSchema,
]);
export type ChairAcceptanceRecord = z.infer<typeof ChairAcceptanceRecordSchema>;

/**
 * A named human's ruling on a motion. This is the only thing that may create a resolution: the
 * panel informs the chair, it never out-votes them. `dissentAcknowledged` is required rather than
 * defaulted because unanimity across a shared schema and prompt is a prompt-quality warning, so a
 * chair recording a ruling must state positively whether dissent existed and was considered.
 */
const ChairRulingRecordShape = {
  rulingId: StorageIdSchema,
  runId: StorageIdSchema,
  motionId: StorageIdSchema,
  title: SingleLineStringSchema,
  decision: NonEmptyStringSchema,
  rationale: NonEmptyStringSchema,
  authorisedBy: SingleLineStringSchema,
  followedSeats: z.array(NonEmptyStringSchema),
  setAsideSeats: z.array(NonEmptyStringSchema),
  dissentAcknowledged: z.boolean(),
  createdAt: TimestampSchema,
};

const GeneralChairRulingRecordSchema = z.strictObject({
  ...ChairRulingRecordShape,
  scope: z.literal('general'),
});

const ProjectChairRulingRecordSchema = z.strictObject({
  ...ChairRulingRecordShape,
  scope: z.literal('project'),
  projectId: StorageIdSchema,
});

export const ChairRulingRecordSchema = z
  .discriminatedUnion('scope', [GeneralChairRulingRecordSchema, ProjectChairRulingRecordSchema])
  .superRefine((record, context) => {
    const overlap = record.followedSeats.filter((seat) => record.setAsideSeats.includes(seat));
    if (overlap.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['setAsideSeats'],
        message: `a seat cannot be both followed and set aside: ${overlap.join(', ')}`,
      });
    }
  });
export type ChairRulingRecord = z.infer<typeof ChairRulingRecordSchema>;

const ResolutionRecordShape = {
  resolutionId: StorageIdSchema,
  runId: StorageIdSchema,
  motionId: StorageIdSchema,
  rulingId: StorageIdSchema,
  title: SingleLineStringSchema,
  decision: NonEmptyStringSchema,
  createdAt: TimestampSchema,
};

const GeneralResolutionRecordSchema = z.strictObject({
  ...ResolutionRecordShape,
  scope: z.literal('general'),
});

const ProjectResolutionRecordSchema = z.strictObject({
  ...ResolutionRecordShape,
  scope: z.literal('project'),
  projectId: StorageIdSchema,
});

export const ResolutionRecordSchema = z.discriminatedUnion('scope', [
  GeneralResolutionRecordSchema,
  ProjectResolutionRecordSchema,
]);
export type ResolutionRecord = z.infer<typeof ResolutionRecordSchema>;

interface PersistedScopeState {
  sessions: readonly SessionRecord[];
  chairAcceptances: readonly ChairAcceptanceRecord[];
  chairRulings: readonly ChairRulingRecord[];
  resolutions: readonly ResolutionRecord[];
}

export interface AtomicTextWriteOptions {
  replace?: boolean;
  validate?: (content: string) => void;
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES: Readonly<Record<string, true>> = {
  EACCES: true,
  EBADF: true,
  EINVAL: true,
  EISDIR: true,
  ENOTSUP: true,
  EPERM: true,
};

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

export function sha256Hex(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryWhereAvailable(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = systemErrorCode(error);
    if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES[code]) throw error;
  } finally {
    await handle?.close();
  }
}

async function removeTemporaryFile(path: string, originalError: unknown): Promise<never> {
  try {
    await rm(path, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `Atomic write failed and temporary file cleanup also failed: ${path}`,
    );
  }
  throw originalError;
}

/**
 * Publishes one complete sibling temporary file and verifies the final bytes before returning.
 * The final path is never opened for an in-place write.
 */
export async function writeTextAtomically(
  destination: string,
  content: string,
  options: AtomicTextWriteOptions = {},
): Promise<string> {
  const replaceExisting = options.replace ?? true;
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });

  if (!replaceExisting && (await Bun.file(destination).exists())) {
    throw new Error(`Refusing to replace append-only record: ${destination}`);
  }

  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  const intendedHash = sha256Hex(content);

  try {
    await Bun.write(temporary, content);
    await syncFile(temporary);

    const temporaryContent = await Bun.file(temporary).text();
    if (sha256Hex(temporaryContent) !== intendedHash) {
      throw new Error(`Temporary write hash verification failed: ${destination}`);
    }
    options.validate?.(temporaryContent);

    if (replaceExisting) {
      await rename(temporary, destination);
    } else {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (systemErrorCode(error) === 'EEXIST') {
          throw new Error(`Refusing to replace append-only record: ${destination}`, {
            cause: error,
          });
        }
        throw error;
      }
      await rm(temporary);
    }
    await syncDirectoryWhereAvailable(parent);

    const persistedContent = await Bun.file(destination).text();
    options.validate?.(persistedContent);
    if (sha256Hex(persistedContent) !== intendedHash) {
      throw new Error(`Persisted write hash verification failed: ${destination}`);
    }

    return intendedHash;
  } catch (error) {
    return removeTemporaryFile(temporary, error);
  }
}

function scopeDirectory(root: string, scope: CouncilScope, projectId?: string): string {
  if (scope === 'general') return join(root, 'general');
  if (!projectId) throw new Error('Project records require a projectId');
  return join(root, 'projects', projectId);
}

async function jsonFiles(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

async function parsePersistedJson<T>(
  path: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    throw new Error(`Invalid persisted ${label} JSON: ${path}`, { cause: error });
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid persisted ${label} record: ${path}`, { cause: result.error });
  }
  return result.data;
}

function fileStem(path: string): string {
  const name = basename(path);
  return name.slice(0, -'.json'.length);
}

async function validatePersistedScope(directory: string): Promise<PersistedScopeState> {
  const sessionPaths = await jsonFiles(join(directory, 'sessions'));
  const resolutionPaths = await jsonFiles(join(directory, 'resolutions'));
  const chairAcceptancePaths = await jsonFiles(join(directory, 'chair-acceptances'));
  const chairRulingPaths = await jsonFiles(join(directory, 'chair-rulings'));
  const sessions: SessionRecord[] = [];
  const resolutions: ResolutionRecord[] = [];
  const chairAcceptances: ChairAcceptanceRecord[] = [];
  const chairRulings: ChairRulingRecord[] = [];
  const runIds = new Set<string>();
  const resolutionIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  const rulingIds = new Set<string>();
  const ruledRunIds = new Set<string>();
  const acceptedRunIds = new Set<string>();
  const resolvedMotionIds = new Set<string>();
  const motions = new Map<
    string,
    Readonly<{ motion: string; assignments: string; protocol: string }>
  >();

  for (const path of sessionPaths) {
    const session = await parsePersistedJson(path, SessionRecordSchema, 'session');
    if (fileStem(path) !== session.runId) {
      throw new Error(`Persisted session filename does not match runId: ${path}`);
    }
    if (runIds.has(session.runId)) throw new Error(`Duplicate persisted run id: ${session.runId}`);
    const identity = {
      motion: session.motion,
      assignments: canonicalAssignments(session.assignments),
      protocol: JSON.stringify(session.protocol),
    };
    const priorIdentity = motions.get(session.motionId);
    if (
      priorIdentity !== undefined &&
      (priorIdentity.motion !== identity.motion ||
        priorIdentity.assignments !== identity.assignments ||
        priorIdentity.protocol !== identity.protocol)
    ) {
      throw new Error(`Inconsistent persisted motion identity: ${session.motionId}`);
    }
    motions.set(session.motionId, identity);
    runIds.add(session.runId);
    sessions.push(session);
  }

  for (const path of chairAcceptancePaths) {
    const acceptance = await parsePersistedJson(
      path,
      ChairAcceptanceRecordSchema,
      'chair acceptance',
    );
    if (fileStem(path) !== acceptance.acceptanceId) {
      throw new Error(`Persisted chair acceptance filename does not match acceptanceId: ${path}`);
    }
    if (acceptanceIds.has(acceptance.acceptanceId)) {
      throw new Error(`Duplicate persisted chair acceptance id: ${acceptance.acceptanceId}`);
    }
    if (acceptedRunIds.has(acceptance.runId)) {
      throw new Error(`Duplicate persisted chair acceptance for run: ${acceptance.runId}`);
    }
    acceptanceIds.add(acceptance.acceptanceId);
    acceptedRunIds.add(acceptance.runId);
    chairAcceptances.push(acceptance);
  }

  for (const path of chairRulingPaths) {
    const ruling = await parsePersistedJson(path, ChairRulingRecordSchema, 'chair ruling');
    if (fileStem(path) !== ruling.rulingId) {
      throw new Error(`Persisted chair ruling filename does not match rulingId: ${path}`);
    }
    if (rulingIds.has(ruling.rulingId)) {
      throw new Error(`Duplicate persisted chair ruling id: ${ruling.rulingId}`);
    }
    if (ruledRunIds.has(ruling.runId)) {
      throw new Error(`Duplicate persisted chair ruling for run: ${ruling.runId}`);
    }
    rulingIds.add(ruling.rulingId);
    ruledRunIds.add(ruling.runId);
    chairRulings.push(ruling);
  }

  for (const path of resolutionPaths) {
    const resolution = await parsePersistedJson(path, ResolutionRecordSchema, 'resolution');
    if (fileStem(path) !== resolution.resolutionId) {
      throw new Error(`Persisted resolution filename does not match resolutionId: ${path}`);
    }
    if (resolutionIds.has(resolution.resolutionId)) {
      throw new Error(`Duplicate persisted resolution id: ${resolution.resolutionId}`);
    }
    if (resolvedMotionIds.has(resolution.motionId)) {
      throw new Error(`Duplicate persisted resolution motion: ${resolution.motionId}`);
    }
    resolvedMotionIds.add(resolution.motionId);
    resolutionIds.add(resolution.resolutionId);
    resolutions.push(resolution);
  }

  for (const acceptance of chairAcceptances) {
    const session = sessions.find((candidate) => candidate.runId === acceptance.runId);
    if (
      !session ||
      session.status !== 'degraded' ||
      session.motionId !== acceptance.motionId ||
      session.scope !== acceptance.scope ||
      (session.scope === 'project' &&
        acceptance.scope === 'project' &&
        session.projectId !== acceptance.projectId)
    ) {
      throw new Error(
        `Persisted chair acceptance has no matching degraded session: ${acceptance.acceptanceId}`,
      );
    }
  }

  for (const ruling of chairRulings) {
    const session = sessions.find((candidate) => candidate.runId === ruling.runId);
    if (
      !session ||
      (session.status !== 'completed' && session.status !== 'degraded') ||
      session.motionId !== ruling.motionId ||
      session.scope !== ruling.scope ||
      (session.scope === 'project' &&
        ruling.scope === 'project' &&
        session.projectId !== ruling.projectId)
    ) {
      throw new Error(
        `Persisted chair ruling has no matching adjudicable session: ${ruling.rulingId}`,
      );
    }
    if (
      session.status === 'degraded' &&
      !chairAcceptances.some(({ runId }) => runId === ruling.runId)
    ) {
      throw new Error(
        `Persisted chair ruling on a degraded session requires a chair acceptance: ${ruling.rulingId}`,
      );
    }
  }

  // A resolution now requires a chair ruling that names the same motion and decision. This is the
  // structural half of deleting textual auto-resolution: even if some future path tried to append a
  // resolution directly, the archive itself refuses one that no human authorised.
  for (const resolution of resolutions) {
    const session = sessions.find((candidate) => candidate.runId === resolution.runId);
    if (
      !session ||
      (session.status !== 'completed' &&
        !(
          session.status === 'degraded' &&
          chairAcceptances.some(({ runId }) => runId === session.runId)
        )) ||
      session.motionId !== resolution.motionId ||
      session.scope !== resolution.scope ||
      (session.scope === 'project' &&
        resolution.scope === 'project' &&
        session.projectId !== resolution.projectId)
    ) {
      throw new Error(
        `Persisted resolution has no matching accepted session: ${resolution.resolutionId}`,
      );
    }
    const ruling = chairRulings.find((candidate) => candidate.rulingId === resolution.rulingId);
    if (
      !ruling ||
      ruling.runId !== resolution.runId ||
      ruling.motionId !== resolution.motionId ||
      ruling.decision !== resolution.decision
    ) {
      throw new Error(
        `Persisted resolution is not backed by a matching chair ruling: ${resolution.resolutionId}`,
      );
    }
  }

  return { sessions, chairAcceptances, chairRulings, resolutions };
}

function serialiseJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalAssignments(assignments: AssignmentHistory): string {
  return JSON.stringify(
    assignments
      .map(({ motionId, seatId, lensName, chairOverride }) => ({
        motionId,
        seatId,
        lensName,
        chairOverride,
      }))
      .sort((left, right) => left.seatId.localeCompare(right.seatId)),
  );
}

export function renderSessionMarkdown(record: SessionRecord): string {
  const lines = [
    `# Council session ${record.runId}`,
    '',
    `- Motion ID: \`${record.motionId}\``,
    `- Scope: \`${record.scope}\``,
  ];
  if (record.scope === 'project') {
    lines.push(`- Project ID: \`${record.projectId}\``);
    if (record.projectDisplayName) lines.push(`- Project: ${record.projectDisplayName}`);
  }
  lines.push(`- Status: \`${record.status}\``, `- Started: ${record.startedAt}`);
  if (record.completedAt) lines.push(`- Completed: ${record.completedAt}`);
  lines.push(
    `- Policy: \`${record.policyDecision.kind}\``,
    `- Classification: \`${record.policyDecision.classification}\``,
    record.destinations.length > 0
      ? `- Destinations: ${record.destinations
          .map((destination) => `\`${destination.provider}/${destination.model}\``)
          .join(', ')}`
      : '- Destinations: none',
    '',
    '## Motion',
    '',
    record.motion,
  );
  if (record.summary) lines.push('', '## Summary', '', record.summary);
  return `${lines.join('\n')}\n`;
}

export function renderChairAcceptanceMarkdown(record: ChairAcceptanceRecord): string {
  const lines = [
    `# Chair acceptance ${record.acceptanceId}`,
    '',
    `- Session: \`${record.runId}\``,
    `- Motion ID: \`${record.motionId}\``,
    `- Scope: \`${record.scope}\``,
  ];
  if (record.scope === 'project') lines.push(`- Project ID: \`${record.projectId}\``);
  lines.push(
    `- Authorised by: ${record.authorisedBy}`,
    `- Created: ${record.createdAt}`,
    '',
    '## Rationale',
    '',
    record.rationale,
  );
  return `${lines.join('\n')}\n`;
}

export function renderResolutionMarkdown(record: ResolutionRecord): string {
  const lines = [
    `# Council resolution ${record.resolutionId}`,
    '',
    `- Session: \`${record.runId}\``,
    `- Motion ID: \`${record.motionId}\``,
    `- Scope: \`${record.scope}\``,
  ];
  if (record.scope === 'project') lines.push(`- Project ID: \`${record.projectId}\``);
  lines.push(`- Created: ${record.createdAt}`, '', `## ${record.title}`, '', record.decision);
  return `${lines.join('\n')}\n`;
}

function renderLedgerEntry(record: ResolutionRecord): string {
  return [
    `<!-- council-resolution:${record.resolutionId} -->`,
    `## ${record.title}`,
    '',
    `- Session: \`${record.runId}\``,
    `- Motion ID: \`${record.motionId}\``,
    `- Recorded: ${record.createdAt}`,
    '',
    record.decision,
    '',
  ].join('\n');
}

export function renderChairRulingMarkdown(record: ChairRulingRecord): string {
  const lines = [
    `# Chair ruling ${record.rulingId}`,
    '',
    `- Session: \`${record.runId}\``,
    `- Motion ID: \`${record.motionId}\``,
    `- Scope: \`${record.scope}\``,
  ];
  if (record.scope === 'project') lines.push(`- Project ID: \`${record.projectId}\``);
  lines.push(
    `- Authorised by: ${record.authorisedBy}`,
    `- Dissent acknowledged: ${record.dissentAcknowledged ? 'yes' : 'no'}`,
    record.followedSeats.length > 0
      ? `- Seats followed: ${record.followedSeats.map((seat) => `\`${seat}\``).join(', ')}`
      : '- Seats followed: none recorded',
    record.setAsideSeats.length > 0
      ? `- Seats set aside: ${record.setAsideSeats.map((seat) => `\`${seat}\``).join(', ')}`
      : '- Seats set aside: none',
    `- Created: ${record.createdAt}`,
    '',
    `## ${record.title}`,
    '',
    record.decision,
    '',
    '## Rationale',
    '',
    record.rationale,
  );
  return `${lines.join('\n')}\n`;
}

async function removeCommittedFile(path: string, originalError: unknown): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `Record write failed and rollback also failed: ${path}`,
    );
  }
}

async function withScopeWriteLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, '.write.lock');
  const release = await lock(directory, {
    lockfilePath: lockPath,
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: 200,
      factor: 1,
      minTimeout: 10,
      maxTimeout: 50,
    },
  });

  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (cleanupError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, cleanupError],
          `Council write failed and scope lock cleanup also failed: ${lockPath}`,
        );
      }
      throw cleanupError;
    }
  }
}

export class CouncilStore {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static open(root: string): CouncilStore {
    return new CouncilStore(resolve(NonEmptyStringSchema.parse(root)));
  }

  async readAssignmentHistory(
    scope: CouncilScope,
    expectedMotion: Readonly<{ motionId: string; motion: string }>,
    projectId?: string,
  ): Promise<AssignmentHistory> {
    const directory = scopeDirectory(this.root, CouncilScopeSchema.parse(scope), projectId);
    const state = await validatePersistedScope(directory);
    const motionId = StorageIdSchema.parse(expectedMotion.motionId);
    const motion = NonEmptyStringSchema.parse(expectedMotion.motion);
    if (
      state.sessions.some((session) => session.motionId === motionId && session.motion !== motion)
    ) {
      throw new Error(`Motion id ${motionId} already identifies a different motion`);
    }
    return AssignmentHistorySchema.parse(state.sessions.flatMap(({ assignments }) => assignments));
  }

  async writeSession(input: CurrentSessionRecord): Promise<void> {
    const record = CurrentSessionRecordSchema.parse(input);
    const directory = scopeDirectory(
      this.root,
      CouncilScopeSchema.parse(record.scope),
      record.scope === 'project' ? record.projectId : undefined,
    );
    await withScopeWriteLock(directory, async () => {
      const state = await validatePersistedScope(directory);

      if (state.sessions.some((session) => session.runId === record.runId)) {
        throw new Error(`Duplicate session id: ${record.runId}`);
      }
      const priorMotion = state.sessions.find((session) => session.motionId === record.motionId);
      if (priorMotion !== undefined) {
        if (priorMotion.motion !== record.motion) {
          throw new Error(`Motion id ${record.motionId} already identifies a different motion`);
        }
        if (
          canonicalAssignments(priorMotion.assignments) !== canonicalAssignments(record.assignments)
        ) {
          throw new Error(`Motion id ${record.motionId} has different role assignments`);
        }
        if (JSON.stringify(priorMotion.protocol) !== JSON.stringify(record.protocol)) {
          throw new Error(`Motion id ${record.motionId} has a different execution protocol`);
        }
      }

      const sessionsDirectory = join(directory, 'sessions');
      const jsonPath = join(sessionsDirectory, `${record.runId}.json`);
      const markdownPath = join(sessionsDirectory, `${record.runId}.md`);
      if ((await Bun.file(jsonPath).exists()) || (await Bun.file(markdownPath).exists())) {
        throw new Error(`Duplicate session id: ${record.runId}`);
      }

      let markdownCommitted = false;
      try {
        await writeTextAtomically(markdownPath, renderSessionMarkdown(record), { replace: false });
        markdownCommitted = true;
        await writeTextAtomically(jsonPath, serialiseJson(record), {
          replace: false,
          validate: (content) => {
            let value: unknown;
            try {
              value = JSON.parse(content);
            } catch (error) {
              throw new Error('Session serialisation produced invalid JSON', { cause: error });
            }
            CurrentSessionRecordSchema.parse(value);
          },
        });
      } catch (error) {
        if (markdownCommitted) await removeCommittedFile(markdownPath, error);
        throw error;
      }
    });
  }

  async appendChairAcceptance(input: ChairAcceptanceRecord): Promise<void> {
    const record = ChairAcceptanceRecordSchema.parse(input);
    const directory = scopeDirectory(
      this.root,
      CouncilScopeSchema.parse(record.scope),
      record.scope === 'project' ? record.projectId : undefined,
    );
    await withScopeWriteLock(directory, async () => {
      const state = await validatePersistedScope(directory);
      const session = state.sessions.find((candidate) => candidate.runId === record.runId);
      if (
        !session ||
        session.status !== 'degraded' ||
        session.motionId !== record.motionId ||
        session.scope !== record.scope ||
        (session.scope === 'project' &&
          record.scope === 'project' &&
          session.projectId !== record.projectId)
      ) {
        throw new Error(`Chair acceptance requires a matching degraded session: ${record.runId}`);
      }
      if (state.chairAcceptances.some(({ acceptanceId }) => acceptanceId === record.acceptanceId)) {
        throw new Error(`Duplicate chair acceptance id: ${record.acceptanceId}`);
      }
      if (state.chairAcceptances.some(({ runId }) => runId === record.runId)) {
        throw new Error(`Session already has a chair acceptance: ${record.runId}`);
      }

      const acceptancesDirectory = join(directory, 'chair-acceptances');
      const jsonPath = join(acceptancesDirectory, `${record.acceptanceId}.json`);
      const markdownPath = join(acceptancesDirectory, `${record.acceptanceId}.md`);
      if ((await Bun.file(jsonPath).exists()) || (await Bun.file(markdownPath).exists())) {
        throw new Error(`Duplicate chair acceptance id: ${record.acceptanceId}`);
      }

      let markdownCommitted = false;
      try {
        await writeTextAtomically(markdownPath, renderChairAcceptanceMarkdown(record), {
          replace: false,
        });
        markdownCommitted = true;
        await writeTextAtomically(jsonPath, serialiseJson(record), {
          replace: false,
          validate: (content) => {
            let value: unknown;
            try {
              value = JSON.parse(content);
            } catch (error) {
              throw new Error('Chair acceptance serialisation produced invalid JSON', {
                cause: error,
              });
            }
            ChairAcceptanceRecordSchema.parse(value);
          },
        });
      } catch (error) {
        if (markdownCommitted) await removeCommittedFile(markdownPath, error);
        throw error;
      }
    });
  }

  /**
   * Record a named human's ruling on a motion. This is the only route by which a motion acquires a
   * decision: nothing in the execution path may write one. A degraded session must already carry a
   * chair acceptance, so accepting a weak result and ruling on it stay two deliberate acts.
   */
  async appendChairRuling(input: ChairRulingRecord): Promise<void> {
    const record = ChairRulingRecordSchema.parse(input);
    const directory = scopeDirectory(
      this.root,
      CouncilScopeSchema.parse(record.scope),
      record.scope === 'project' ? record.projectId : undefined,
    );
    await withScopeWriteLock(directory, async () => {
      const state = await validatePersistedScope(directory);
      const session = state.sessions.find((candidate) => candidate.runId === record.runId);
      if (
        !session ||
        (session.status !== 'completed' && session.status !== 'degraded') ||
        session.motionId !== record.motionId ||
        session.scope !== record.scope ||
        (session.scope === 'project' &&
          record.scope === 'project' &&
          session.projectId !== record.projectId)
      ) {
        throw new Error(`Chair ruling requires a matching adjudicable session: ${record.runId}`);
      }
      if (
        session.status === 'degraded' &&
        !state.chairAcceptances.some(({ runId }) => runId === record.runId)
      ) {
        throw new Error(
          `Chair ruling on a degraded session requires a chair acceptance first: ${record.runId}`,
        );
      }
      if (state.chairRulings.some(({ rulingId }) => rulingId === record.rulingId)) {
        throw new Error(`Duplicate chair ruling id: ${record.rulingId}`);
      }
      if (state.chairRulings.some(({ runId }) => runId === record.runId)) {
        throw new Error(`Session already has a chair ruling: ${record.runId}`);
      }

      const rulingsDirectory = join(directory, 'chair-rulings');
      const jsonPath = join(rulingsDirectory, `${record.rulingId}.json`);
      const markdownPath = join(rulingsDirectory, `${record.rulingId}.md`);
      if ((await Bun.file(jsonPath).exists()) || (await Bun.file(markdownPath).exists())) {
        throw new Error(`Duplicate chair ruling id: ${record.rulingId}`);
      }

      let markdownCommitted = false;
      try {
        await writeTextAtomically(markdownPath, renderChairRulingMarkdown(record), {
          replace: false,
        });
        markdownCommitted = true;
        await writeTextAtomically(jsonPath, serialiseJson(record), {
          replace: false,
          validate: (content) => {
            let value: unknown;
            try {
              value = JSON.parse(content);
            } catch (error) {
              throw new Error('Chair ruling serialisation produced invalid JSON', { cause: error });
            }
            ChairRulingRecordSchema.parse(value);
          },
        });
      } catch (error) {
        if (markdownCommitted) await removeCommittedFile(markdownPath, error);
        throw error;
      }
    });
  }

  /**
   * Current decision state per session, derived rather than stored. `dataAvailability` reports
   * whether the session carries decision-level evidence at all, so a caller can tell "the chair has
   * not ruled" apart from "this record predates evidence capture and never can be audited".
   */
  async readDecisionStates(
    scope: CouncilScope,
    projectId?: string,
  ): Promise<
    readonly {
      runId: string;
      motionId: string;
      status: SessionStatus;
      decisionState: DecisionState;
      dataAvailability: DataAvailability;
      rulingId?: string;
      resolutionId?: string;
    }[]
  > {
    const directory = scopeDirectory(this.root, CouncilScopeSchema.parse(scope), projectId);
    const state = await validatePersistedScope(directory);
    return state.sessions.map((session) => {
      const ruling = state.chairRulings.find(({ runId }) => runId === session.runId);
      const resolution = state.resolutions.find(({ runId }) => runId === session.runId);
      const adjudicable = session.status === 'completed' || session.status === 'degraded';
      return {
        runId: session.runId,
        motionId: session.motionId,
        status: session.status,
        decisionState: ruling
          ? 'adjudicated'
          : adjudicable
            ? 'awaiting-adjudication'
            : 'not-adjudicable',
        dataAvailability: sessionDataAvailability(session),
        ...(ruling === undefined ? {} : { rulingId: ruling.rulingId }),
        ...(resolution === undefined ? {} : { resolutionId: resolution.resolutionId }),
      };
    });
  }

  async appendResolution(input: ResolutionRecord): Promise<void> {
    const record = ResolutionRecordSchema.parse(input);
    const directory = scopeDirectory(
      this.root,
      CouncilScopeSchema.parse(record.scope),
      record.scope === 'project' ? record.projectId : undefined,
    );
    await withScopeWriteLock(directory, async () => {
      const state = await validatePersistedScope(directory);
      const session = state.sessions.find((candidate) => candidate.runId === record.runId);

      if (!session) {
        throw new Error(`Resolution requires a validated session: ${record.runId}`);
      }
      if (
        session.status === 'degraded' &&
        !state.chairAcceptances.some(({ runId }) => runId === session.runId)
      ) {
        throw new Error(
          `Resolution requires chair acceptance for degraded session: ${record.runId}`,
        );
      }
      if (session.status !== 'completed' && session.status !== 'degraded') {
        throw new Error(`Resolution requires a validated accepted session: ${record.runId}`);
      }
      if (session.motionId !== record.motionId || session.scope !== record.scope) {
        throw new Error('Resolution does not match its accepted session');
      }
      if (
        session.scope === 'project' &&
        record.scope === 'project' &&
        session.projectId !== record.projectId
      ) {
        throw new Error('Resolution project does not match its accepted session');
      }
      if (state.resolutions.some((resolution) => resolution.motionId === record.motionId)) {
        throw new Error(`Motion already has a resolution: ${record.motionId}`);
      }
      if (state.resolutions.some((resolution) => resolution.resolutionId === record.resolutionId)) {
        throw new Error(`Duplicate resolution id: ${record.resolutionId}`);
      }
      // The load-bearing gate: a resolution must quote a chair ruling that names the same run,
      // motion and decision text. Textual agreement between seats used to be enough to append one
      // automatically, which let the panel out-vote the chair. Now nothing but a human ruling can.
      const ruling = state.chairRulings.find(({ rulingId }) => rulingId === record.rulingId);
      if (!ruling) {
        throw new Error(`Resolution requires an existing chair ruling: ${record.rulingId}`);
      }
      if (ruling.runId !== record.runId || ruling.motionId !== record.motionId) {
        throw new Error('Resolution does not match its chair ruling');
      }
      if (ruling.decision !== record.decision) {
        throw new Error('Resolution decision does not match its chair ruling');
      }

      const resolutionsDirectory = join(directory, 'resolutions');
      const jsonPath = join(resolutionsDirectory, `${record.resolutionId}.json`);
      const markdownPath = join(resolutionsDirectory, `${record.resolutionId}.md`);
      const ledgerPath = join(directory, 'ledger.md');
      if ((await Bun.file(jsonPath).exists()) || (await Bun.file(markdownPath).exists())) {
        throw new Error(`Duplicate resolution id: ${record.resolutionId}`);
      }

      const ledgerExists = await Bun.file(ledgerPath).exists();
      const currentLedger = ledgerExists
        ? await Bun.file(ledgerPath).text()
        : record.scope === 'general'
          ? '# General ledger\n'
          : `# Project ledger: ${record.projectId}\n`;
      const separator = currentLedger.endsWith('\n\n')
        ? ''
        : currentLedger.endsWith('\n')
          ? '\n'
          : '\n\n';
      const nextLedger = `${currentLedger}${separator}${renderLedgerEntry(record)}`;

      let markdownCommitted = false;
      let jsonCommitted = false;
      try {
        await writeTextAtomically(markdownPath, renderResolutionMarkdown(record), {
          replace: false,
        });
        markdownCommitted = true;
        await writeTextAtomically(jsonPath, serialiseJson(record), {
          replace: false,
          validate: (content) => {
            let value: unknown;
            try {
              value = JSON.parse(content);
            } catch (error) {
              throw new Error('Resolution serialisation produced invalid JSON', { cause: error });
            }
            ResolutionRecordSchema.parse(value);
          },
        });
        jsonCommitted = true;
        await writeTextAtomically(ledgerPath, nextLedger);
      } catch (error) {
        if (jsonCommitted) await removeCommittedFile(jsonPath, error);
        if (markdownCommitted) await removeCommittedFile(markdownPath, error);
        throw error;
      }
    });
  }
}
