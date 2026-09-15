import { z } from 'zod';
import { MAX_ENVELOPE_ROUNDS } from '../../substrate';
import {
  ForumMotionIdSchema,
  ForumStanceSchema,
  NonEmptyStringSchema,
  type ForumAnswer,
} from './answers';

export interface ForumSeatAnswer {
  readonly seat: string;
  readonly answer: ForumAnswer;
}

/** One round as the ledger holds it: the answers that validated, in seat order. */
export interface ForumRoundRecord {
  readonly n: number;
  readonly answers: readonly ForumSeatAnswer[];
}

/**
 * The forum's whole result. Every field is a record of what seats said or a deterministic grouping
 * of it: there is no synthesis, no ranking and no field for a decision or a winner, and the strict
 * objects make an attempt to add one a validation failure rather than a silent extra key.
 */
export const ForumOutputSchema = z.strictObject({
  rounds: z.array(
    z.strictObject({
      n: z.number().int().min(1).max(MAX_ENVELOPE_ROUNDS),
      positions: z.array(
        z.strictObject({
          seat: NonEmptyStringSchema,
          stance: ForumStanceSchema,
          text: NonEmptyStringSchema,
          inReplyTo: NonEmptyStringSchema.nullable(),
        }),
      ),
    }),
  ),
  map: z.array(
    z.strictObject({
      position: NonEmptyStringSchema,
      holders: z.array(NonEmptyStringSchema).min(1),
    }),
  ),
  moved: z.array(
    z.strictObject({
      seat: NonEmptyStringSchema,
      // A move needs an earlier answer to have moved from, so the earliest possible round is two.
      round: z.number().int().min(2).max(MAX_ENVELOPE_ROUNDS),
      from: NonEmptyStringSchema,
      to: NonEmptyStringSchema,
      why: NonEmptyStringSchema,
    }),
  ),
  motions: z.array(
    z.strictObject({
      id: ForumMotionIdSchema,
      by: NonEmptyStringSchema,
      text: NonEmptyStringSchema,
      support: z.array(NonEmptyStringSchema),
      opposed: z.array(NonEmptyStringSchema),
    }),
  ),
});
export type ForumOutput = z.infer<typeof ForumOutputSchema>;
export type ForumMapEntry = ForumOutput['map'][number];
export type ForumMove = ForumOutput['moved'][number];
export type ForumMotion = ForumOutput['motions'][number];

/**
 * Grouping key only. Two seats that wrote the same label with different capitalisation, spacing or
 * a full stop hold the same position; anything else is a different position, because deciding that
 * two differently worded labels mean the same thing would be the engine taking a view.
 */
export function normalisePosition(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.,;:!?]+$/u, '')
    .trim();
}

/**
 * The final round's positions, grouped. The label shown is the first holder's own wording in seat
 * order: the engine groups, it never rewrites a seat's words into a label nobody wrote.
 */
export function buildPositionMap(round: ForumRoundRecord | undefined): ForumMapEntry[] {
  const entries = new Map<string, { position: string; holders: string[] }>();
  for (const { seat, answer } of round?.answers ?? []) {
    const key = normalisePosition(answer.position);
    const existing = entries.get(key);
    if (existing === undefined) {
      entries.set(key, { position: answer.position, holders: [seat] });
    } else if (!existing.holders.includes(seat)) {
      existing.holders.push(seat);
    }
  }
  return [...entries.values()];
}

/**
 * Every seat whose label changed, in round order. A seat is compared with its own most recent
 * answer rather than strictly with the previous round, so a seat that fell silent for a round and
 * came back with a different position is still recorded as having moved.
 */
export function buildMoved(rounds: readonly ForumRoundRecord[]): ForumMove[] {
  const moved: ForumMove[] = [];
  const previousLabel = new Map<string, string>();
  for (const round of rounds) {
    for (const { seat, answer } of round.answers) {
      const previous = previousLabel.get(seat);
      if (
        previous !== undefined &&
        normalisePosition(previous) !== normalisePosition(answer.position)
      ) {
        moved.push({
          seat,
          round: round.n,
          from: previous,
          to: answer.position,
          why: answer.text,
        });
      }
      previousLabel.set(seat, answer.position);
    }
  }
  return moved;
}

interface RaisedMotion {
  readonly id: string;
  readonly by: string;
  readonly round: number;
  readonly text: string;
}

function raisedMotions(rounds: readonly ForumRoundRecord[]): RaisedMotion[] {
  const raised: RaisedMotion[] = [];
  for (const round of rounds) {
    for (const { seat, answer } of round.answers) {
      if (answer.motion === undefined) continue;
      raised.push({
        id: `m-${raised.length + 1}`,
        by: seat,
        round: round.n,
        text: answer.motion.text,
      });
    }
  }
  return raised;
}

/**
 * Every motion raised, with who supported and who opposed it. Nothing is decided and no tally is
 * turned into an outcome. A seat is only recorded as supporting or opposing a motion raised in an
 * earlier round than its own answer: prompts carry motions from earlier rounds only, so a
 * reference to anything else is an invention, and an unknown id is dropped for the same reason.
 * Raising a motion is not supporting it; that would be the engine inferring a position.
 */
export function collectMotions(rounds: readonly ForumRoundRecord[]): ForumMotion[] {
  const raised = raisedMotions(rounds);
  const byId = new Map(raised.map((motion) => [motion.id, motion] as const));
  const support = new Map<string, string[]>();
  const opposed = new Map<string, string[]>();

  function record(table: Map<string, string[]>, id: string, seat: string, round: number): void {
    const motion = byId.get(id);
    if (motion === undefined || motion.round >= round) return;
    const seats = table.get(id) ?? [];
    if (!seats.includes(seat)) seats.push(seat);
    table.set(id, seats);
  }

  for (const round of rounds) {
    for (const { seat, answer } of round.answers) {
      for (const id of answer.supports ?? []) record(support, id, seat, round.n);
      for (const id of answer.opposes ?? []) record(opposed, id, seat, round.n);
    }
  }

  return raised.map((motion) => ({
    id: motion.id,
    by: motion.by,
    text: motion.text,
    support: support.get(motion.id) ?? [],
    opposed: opposed.get(motion.id) ?? [],
  }));
}

export interface ForumAggregateInput {
  readonly seats: readonly string[];
  readonly rounds: readonly ForumRoundRecord[];
}

export function aggregateForum(input: ForumAggregateInput): ForumOutput {
  const sat = new Set(input.seats);
  const rounds = input.rounds.map((round) => ({
    n: round.n,
    positions: round.answers.map(({ seat, answer }) => ({
      seat,
      stance: answer.stance,
      text: answer.text,
      // A seat may name a reply target that never sat in this forum. The claim is kept verbatim in
      // the session ledger; the output carries it only when it names a seat that did sit.
      inReplyTo: answer.inReplyTo !== null && sat.has(answer.inReplyTo) ? answer.inReplyTo : null,
    })),
  }));
  return ForumOutputSchema.parse({
    rounds,
    map: buildPositionMap(input.rounds.at(-1)),
    moved: buildMoved(input.rounds),
    motions: collectMotions(input.rounds),
  });
}
