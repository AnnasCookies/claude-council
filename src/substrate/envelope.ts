import { z } from 'zod';
import { ProviderFamilySchema, type SeatResponse } from './domain/schemas';
import { BillingModeSchema, CouncilAnswerSchema } from './execution/provider';
import type { CouncilSeatAssignment, RoundExecution } from './execution/runner';
import { SpendPolicySchema } from './spend';

const NonEmptyStringSchema = z.string().trim().min(1);

export const CallerKindSchema = z.enum(['human', 'agent']);
export type CallerKind = z.infer<typeof CallerKindSchema>;

/**
 * Who asked, declared by the wrapper and never inferred. `declared: false` is the honest default
 * when a caller passed no `--caller`, and it is surfaced in `degraded` so nobody mistakes an
 * assumption for a fact.
 */
export const CallerSchema = z.strictObject({
  kind: CallerKindSchema,
  harness: NonEmptyStringSchema,
  purpose: NonEmptyStringSchema.optional(),
  declared: z.boolean(),
});
export type Caller = z.infer<typeof CallerSchema>;

export const UNDECLARED_CALLER: Caller = Object.freeze({
  kind: 'human',
  harness: 'unknown',
  declared: false,
});

export const ExecutionPatternSchema = z.enum(['streaming', 'parallel', 'rounds']);
export type ExecutionPattern = z.infer<typeof ExecutionPatternSchema>;

export const SpendSchema = z.strictObject({
  billing: BillingModeSchema,
  policy: SpendPolicySchema,
  cap: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  stoppedAtCap: z.boolean(),
});
export type Spend = z.infer<typeof SpendSchema>;

export const EnvelopeSeatSchema = z.strictObject({
  id: NonEmptyStringSchema,
  family: ProviderFamilySchema,
  model: z.strictObject({
    requested: NonEmptyStringSchema.nullable(),
    verified: NonEmptyStringSchema.nullable(),
    verification: z.enum(['verified', 'unverified']),
  }),
  lens: NonEmptyStringSchema,
  transport: z.enum(['subscription', 'api']).nullable(),
  fallback: z.boolean(),
  status: z.enum(['ok', 'skipped', 'failed', 'timed-out', 'cancelled']),
  reason: z.string().nullable(),
});
export type EnvelopeSeat = z.infer<typeof EnvelopeSeatSchema>;

/**
 * `session` is the record path relative to the records root, known before the record is written.
 * `committed`, `commitSha` and `minutes` are facts that exist only after the write, so they appear
 * on the emitted envelope and not inside the persisted one.
 */
export const EnvelopeRecordSchema = z.strictObject({
  session: z.string().nullable(),
  committed: z.boolean().optional(),
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{7,40}$/)
    .optional(),
  minutes: z.string().nullable().optional(),
});
export type EnvelopeRecord = z.infer<typeof EnvelopeRecordSchema>;

export const ResultEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  caller: CallerSchema,
  pattern: ExecutionPatternSchema,
  rounds: z.number().int().min(0).max(3),
  seats: z.array(EnvelopeSeatSchema),
  output: z.record(z.string(), z.unknown()),
  synthesis: z.strictObject({ by: NonEmptyStringSchema, text: NonEmptyStringSchema }).nullable(),
  dissent: z
    .array(z.strictObject({ seat: NonEmptyStringSchema, position: NonEmptyStringSchema }))
    .nullable(),
  unanimous: z.boolean(),
  spend: SpendSchema,
  degraded: z.array(NonEmptyStringSchema),
  record: EnvelopeRecordSchema,
});
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

export interface EnvelopeSeatsSource {
  readonly assignments: readonly CouncilSeatAssignment[];
  readonly rounds: readonly RoundExecution[];
}

function responsesFor(seatId: string, rounds: readonly RoundExecution[]): SeatResponse[] {
  return rounds.flatMap((round) =>
    round.responses.filter((response) => response.seatId === seatId),
  );
}

export function envelopeSeats(source: EnvelopeSeatsSource): EnvelopeSeat[] {
  return source.assignments.map((assignment) => {
    const responses = responsesFor(assignment.seatId, source.rounds);
    const last = responses.at(-1);
    const verified = responses.find((response) => response.status === 'ok');
    const requested = last?.requestedModel ?? null;
    return {
      id: `${assignment.provider}/${requested ?? 'unresolved'}#${assignment.lensName}`,
      family: assignment.provider,
      model: {
        requested,
        verified: verified?.actualModel ?? null,
        verification: verified === undefined ? 'unverified' : 'verified',
      },
      lens: assignment.lensName,
      transport:
        last?.credentialPath === undefined
          ? null
          : last.credentialPath === 'api-key'
            ? 'api'
            : 'subscription',
      fallback: responses.some((response) => response.credentialFallback !== undefined),
      status: last === undefined ? 'skipped' : last.status,
      reason:
        last === undefined
          ? 'no response recorded'
          : last.status === 'ok'
            ? null
            : last.error.message,
    };
  });
}

/**
 * Identical short recommendations under a shared prompt are a measurement artefact, so unanimity
 * is a flag to be suspicious of rather than a success signal. Only the final round counts, only
 * verified answers count, and one answer alone is not unanimity.
 */
export function detectUnanimity(rounds: readonly RoundExecution[]): boolean {
  const final = rounds.at(-1);
  if (final === undefined) return false;
  const recommendations = final.responses.flatMap((response) => {
    if (response.status !== 'ok') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.answer);
    } catch {
      return [];
    }
    const answer = CouncilAnswerSchema.safeParse(parsed);
    return answer.success ? [answer.data.recommendation.trim().toLowerCase()] : [];
  });
  const first = recommendations[0];
  return (
    recommendations.length >= 2 &&
    first !== undefined &&
    recommendations.every((recommendation) => recommendation === first)
  );
}

export function spendFromRounds(
  rounds: readonly RoundExecution[],
  input: Readonly<{
    billing: Spend['billing'];
    policy: Spend['policy'];
    cap: number;
    refused: number;
  }>,
): Spend {
  const responses = rounds.flatMap((round) => round.responses);
  return {
    billing: input.billing,
    policy: input.policy,
    cap: input.cap,
    used: responses.filter((response) => response.credentialPath === 'api-key').length,
    fallbacks: responses.filter((response) => response.credentialFallback !== undefined).length,
    refused: input.refused,
    stoppedAtCap: input.refused > 0,
  };
}

export interface BuildEnvelopeInput {
  readonly mode: string;
  readonly session: string;
  readonly caller: Caller;
  readonly pattern: ExecutionPattern;
  readonly rounds: readonly RoundExecution[];
  readonly assignments: readonly CouncilSeatAssignment[];
  readonly output: Record<string, unknown>;
  readonly spend: Spend;
  readonly degraded: readonly string[];
  readonly record: EnvelopeRecord;
}

export function buildEnvelope(input: BuildEnvelopeInput): ResultEnvelope {
  return ResultEnvelopeSchema.parse({
    schemaVersion: 1,
    mode: input.mode,
    session: input.session,
    caller: input.caller,
    pattern: input.pattern,
    rounds: input.rounds.length,
    seats: envelopeSeats({ assignments: input.assignments, rounds: input.rounds }),
    output: input.output,
    synthesis: null,
    dissent: null,
    unanimous: detectUnanimity(input.rounds),
    spend: input.spend,
    degraded: [...input.degraded],
    record: input.record,
  });
}
