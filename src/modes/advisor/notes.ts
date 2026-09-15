import { z } from 'zod';
import { EnvelopeSeatSchema, type EnvelopeSeat, type ModeSessionEvent } from '../../substrate';

const TimestampSchema = z.string().datetime({ offset: true });

/**
 * The only tool-call classes a hold may name. The class is chosen by the harness hook from its
 * configuration and validated here; the kernel never infers one from the tool text.
 */
export const RISK_CLASSES = [
  'destructive-git',
  'delete',
  'deploy',
  'payment',
  'credential',
] as const;
export const RiskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const NoteTriggerSchema = z.enum(['cadence', 'ask', 'hold', 'external']);
export type NoteTrigger = z.infer<typeof NoteTriggerSchema>;
export const NoteSeveritySchema = z.enum(['info', 'caution', 'stop']);
export type NoteSeverity = z.infer<typeof NoteSeveritySchema>;
export const HeededSchema = z.enum(['yes', 'no', 'unknown']);
export type Heeded = z.infer<typeof HeededSchema>;
export const NoteStatusSchema = z.enum(['ok', 'skipped', 'no-advice']);
export type NoteStatus = z.infer<typeof NoteStatusSchema>;
export const NoteIdSchema = z.string().regex(/^n-[1-9]\d*$/, 'A note id is n-<sequence>');

/** Seats are told the limit and the kernel truncates anyway, so a verbose seat cannot flood the agent. */
export const NOTE_TEXT_LIMIT = 600;
/** The record keeps an excerpt of what a note referred to, never the whole input. */
export const TOOL_CALL_EXCERPT_LIMIT = 200;
export const QUESTION_EXCERPT_LIMIT = 500;
export const HARNESS_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const AdvisorNoteSchema = z.strictObject({
  id: NoteIdSchema,
  trigger: NoteTriggerSchema,
  severity: NoteSeveritySchema,
  text: z.string().max(NOTE_TEXT_LIMIT),
  refersTo: z.strictObject({
    toolCall: z.string().max(TOOL_CALL_EXCERPT_LIMIT).optional(),
    question: z.string().max(QUESTION_EXCERPT_LIMIT).optional(),
  }),
  heeded: HeededSchema,
  status: NoteStatusSchema,
  reason: z.string().nullable(),
  /** The panel seat that answered, the harness that posted, or null when no seat was reached. */
  seat: z.string().min(1).nullable(),
  at: TimestampSchema,
});
export type AdvisorNote = z.infer<typeof AdvisorNoteSchema>;

export const StartedEventSchema = z.strictObject({ key: z.string().nullable() });
export const NoteEventSchema = z.strictObject({
  note: AdvisorNoteSchema,
  seat: EnvelopeSeatSchema.nullable(),
});
export const HeedEventSchema = z.strictObject({ note: NoteIdSchema, heeded: HeededSchema });
export const EndedEventSchema = z.strictObject({ notes: z.number().int().nonnegative() });

export interface AdvisorLog {
  readonly started: boolean;
  readonly ended: boolean;
  /** Every note in log order, with the latest `heed` applied. */
  readonly notes: readonly AdvisorNote[];
  /** Every seat that was consulted, once each, in first-seen order. */
  readonly seats: readonly EnvelopeSeat[];
  /** Cadence passes asked for so far, including the ones cadence itself skipped. */
  readonly cadenceCalls: number;
}

/**
 * The log is append-only, so `--heed` cannot edit a note: it appends a `heed` event and every
 * reader folds the latest one onto the note. A line whose data does not parse fails the read,
 * matching the store's own refusal to extend a log it cannot read back.
 */
export function readAdvisorLog(events: readonly ModeSessionEvent[]): AdvisorLog {
  let started = false;
  let ended = false;
  const notes = new Map<string, AdvisorNote>();
  const seats = new Map<string, EnvelopeSeat>();
  let cadenceCalls = 0;
  for (const [index, event] of events.entries()) {
    const line = index + 1;
    switch (event.kind) {
      case 'started':
        StartedEventSchema.parse(event.data);
        started = true;
        break;
      case 'note': {
        const { note, seat } = NoteEventSchema.parse(event.data);
        if (notes.has(note.id)) {
          throw new Error(`Duplicate advisor note id at line ${line}: ${note.id}`);
        }
        notes.set(note.id, note);
        if (seat !== null && !seats.has(seat.id)) seats.set(seat.id, seat);
        if (note.trigger === 'cadence') cadenceCalls += 1;
        break;
      }
      case 'heed': {
        const heed = HeedEventSchema.parse(event.data);
        const note = notes.get(heed.note);
        if (note === undefined) {
          throw new Error(`Heed for an unknown advisor note at line ${line}: ${heed.note}`);
        }
        notes.set(heed.note, { ...note, heeded: heed.heeded });
        break;
      }
      case 'ended':
        EndedEventSchema.parse(event.data);
        ended = true;
        break;
      default:
        throw new Error(`Unknown advisor event kind at line ${line}: ${event.kind}`);
    }
  }
  return { started, ended, notes: [...notes.values()], seats: [...seats.values()], cadenceCalls };
}

export function nextNoteId(log: AdvisorLog): string {
  return `n-${log.notes.length + 1}`;
}

/**
 * The cadence pass consults the seat on every Nth call. The call count comes from the log, so
 * the hook keeps no counter of its own and a restarted hook cannot drift from the record.
 */
export function cadenceDue(log: AdvisorLog, every: number): boolean {
  return (log.cadenceCalls + 1) % every === 0;
}

export function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
