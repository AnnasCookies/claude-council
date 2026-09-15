import { z } from 'zod';
import { PanelLensSchema, ProviderFamilySchema, type ModeSessionEvent } from '../../substrate';
import { ConflictSchema } from './prompts';

export const CONSULTANTS_MODE = 'consultants';
/** Session ids read `cs-2026-09-15-3f9a1c`. */
export const CONSULTANTS_SESSION_PREFIX = 'cs';

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const BriefEventSchema = z.strictObject({
  question: NonEmptyStringSchema,
  context: z.array(z.strictObject({ locator: NonEmptyStringSchema, sha256: Sha256Schema })),
  lenses: z.array(PanelLensSchema).min(1),
  seats: z
    .array(
      z.strictObject({
        lens: NonEmptyStringSchema,
        seat: NonEmptyStringSchema,
        family: ProviderFamilySchema,
        model: NonEmptyStringSchema,
      }),
    )
    .min(1),
});
export type BriefEvent = z.infer<typeof BriefEventSchema>;

/**
 * Every seat is recorded, answered or not: the envelope's seat list is not in this log, so a
 * session that lost a consultant must still say which one and why.
 */
export const ReportEventSchema = z.strictObject({
  lens: NonEmptyStringSchema,
  seat: NonEmptyStringSchema,
  family: ProviderFamilySchema,
  model: NonEmptyStringSchema,
  status: z.enum(['ok', 'invalid', 'skipped', 'failed']),
  report: NonEmptyStringSchema.nullable(),
  reason: z.string().nullable(),
});
export type ReportEvent = z.infer<typeof ReportEventSchema>;

export const ConflictsEventSchema = z.strictObject({
  by: NonEmptyStringSchema.nullable(),
  status: z.enum(['ok', 'invalid', 'skipped', 'failed', 'unavailable']),
  conflicts: z.array(ConflictSchema),
  reason: z.string().nullable(),
});
export type ConflictsEvent = z.infer<typeof ConflictsEventSchema>;

export const QaEventSchema = z.strictObject({
  to: NonEmptyStringSchema,
  seat: NonEmptyStringSchema,
  question: NonEmptyStringSchema,
  answer: NonEmptyStringSchema,
  forwarded: z.array(NonEmptyStringSchema),
});
export type QaEvent = z.infer<typeof QaEventSchema>;

/**
 * One per command, so the session cap is arithmetic over the log rather than a guess.
 *
 * `used` and `reserved` are different quantities that happen to coincide whenever a seat only
 * ever spends by falling back through the session's ledger. `used` is `spend.used` as every other
 * mode reports it — seats counted per transport, so it stays a true figure under `--billing
 * api-only`, where nothing ever calls the ledger. `reserved` is the ledger's own `used` counter,
 * which only grows when a subscription seat fails and a metered fallback is attempted: it is what
 * the session cap actually governs, and what a follow-up's remaining-budget arithmetic must read.
 */
export const SpendEventSchema = z.strictObject({
  command: z.enum(['brief', 'ask']),
  cap: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
});
export type SpendEvent = z.infer<typeof SpendEventSchema>;

export const ConsultantsOutputSchema = z.strictObject({
  brief: z.strictObject({
    question: NonEmptyStringSchema,
    context: z.array(NonEmptyStringSchema),
  }),
  reports: z.array(
    z.strictObject({
      lens: NonEmptyStringSchema,
      seat: NonEmptyStringSchema,
      report: NonEmptyStringSchema,
    }),
  ),
  conflicts: z.array(ConflictSchema),
  qa: z.array(
    z.strictObject({
      to: NonEmptyStringSchema,
      question: NonEmptyStringSchema,
      answer: NonEmptyStringSchema,
    }),
  ),
});
export type ConsultantsOutput = z.infer<typeof ConsultantsOutputSchema>;

export interface SessionState {
  readonly brief: BriefEvent;
  readonly reports: readonly ReportEvent[];
  readonly conflicts: ConflictsEvent | null;
  readonly qa: readonly QaEvent[];
  readonly spend: {
    readonly cap: number;
    readonly used: number;
    readonly reserved: number;
    readonly fallbacks: number;
  };
}

/**
 * The log is the session. Every command rebuilds the whole state from it rather than carrying
 * anything between commands, so what the caller is shown and what a later reader finds on disk
 * are the same object.
 */
export function replaySession(events: readonly ModeSessionEvent[]): SessionState {
  let brief: BriefEvent | null = null;
  let conflicts: ConflictsEvent | null = null;
  const reports: ReportEvent[] = [];
  const qa: QaEvent[] = [];
  let cap = 0;
  let used = 0;
  let reserved = 0;
  let fallbacks = 0;
  for (const [index, event] of events.entries()) {
    const line = index + 1;
    switch (event.kind) {
      case 'brief': {
        if (brief !== null) {
          throw new Error(`A consultants session has one brief; line ${line} carries a second`);
        }
        brief = BriefEventSchema.parse(event.data);
        break;
      }
      case 'report':
        reports.push(ReportEventSchema.parse(event.data));
        break;
      case 'conflicts':
        conflicts = ConflictsEventSchema.parse(event.data);
        break;
      case 'qa':
        qa.push(QaEventSchema.parse(event.data));
        break;
      case 'spend': {
        const spend = SpendEventSchema.parse(event.data);
        // The cap is the session's, raised only by an explicit --spend-cap on a later command.
        cap = Math.max(cap, spend.cap);
        used += spend.used;
        reserved += spend.reserved;
        fallbacks += spend.fallbacks;
        break;
      }
      default:
        throw new Error(`Unknown consultants session event at line ${line}: ${event.kind}`);
    }
  }
  if (brief === null) throw new Error('This consultants session has no brief');
  return { brief, reports, conflicts, qa, spend: { cap, used, reserved, fallbacks } };
}

export function sessionOutput(state: SessionState): ConsultantsOutput {
  return ConsultantsOutputSchema.parse({
    brief: {
      question: state.brief.question,
      context: state.brief.context.map((entry) => entry.locator),
    },
    reports: state.reports.flatMap((report) =>
      report.status === 'ok' && report.report !== null
        ? [{ lens: report.lens, seat: report.seat, report: report.report }]
        : [],
    ),
    conflicts: state.conflicts === null ? [] : state.conflicts.conflicts,
    qa: state.qa.map((entry) => ({
      to: entry.to,
      question: entry.question,
      answer: entry.answer,
    })),
  });
}

/** A consultant is given its own Q&A history and nobody else's. */
export function historyFor(
  state: SessionState,
  lens: string,
): { question: string; answer: string }[] {
  return state.qa
    .filter((entry) => entry.to === lens)
    .map((entry) => ({ question: entry.question, answer: entry.answer }));
}
