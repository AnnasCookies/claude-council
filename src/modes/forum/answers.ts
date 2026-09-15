import { z } from 'zod';
import type { PanelAnswer } from '../../substrate';

/** Eight words is the label's whole budget; the argument belongs in `text`. */
const MAX_POSITION_WORDS = 8;

const NonEmptyStringSchema = z.string().trim().min(1);

const PositionLabelSchema = NonEmptyStringSchema.max(160).refine(
  (label) => label.split(/\s+/u).filter((word) => word.length > 0).length <= MAX_POSITION_WORDS,
  `A position label is at most ${MAX_POSITION_WORDS} words`,
);

/** Motion ids are minted by the forum, never by a seat, so a reference is matched, not trusted. */
export const ForumMotionIdSchema = z.string().regex(/^m-[1-9][0-9]{0,2}$/);

export const ForumStanceSchema = z.enum(['hold', 'revise', 'rebut']);
export type ForumStance = z.infer<typeof ForumStanceSchema>;

const ForumMotionTextSchema = z.strictObject({ text: NonEmptyStringSchema.max(2_000) });

/**
 * Round one is blind, so there is nothing to revise or rebut and nobody to reply to: the stance is
 * fixed and `inReplyTo` is not on the wire at all. A seat that answers off-shape is recorded as an
 * invalid seat with its raw text kept, which is the panel's behaviour and not this mode's.
 */
export const ForumOpeningAnswerSchema = z.strictObject({
  position: PositionLabelSchema,
  stance: z.literal('hold'),
  text: NonEmptyStringSchema.max(20_000),
  motion: ForumMotionTextSchema.optional(),
});
export type ForumOpeningAnswer = z.infer<typeof ForumOpeningAnswerSchema>;

/**
 * Rounds two and later. This is also the one shape the ledger and the aggregation read, so an
 * opening answer is widened into it by {@link openingAsAnswer} rather than handled separately
 * everywhere downstream.
 */
export const ForumAnswerSchema = z.strictObject({
  position: PositionLabelSchema,
  stance: ForumStanceSchema,
  text: NonEmptyStringSchema.max(20_000),
  inReplyTo: NonEmptyStringSchema.max(200).nullable(),
  motion: ForumMotionTextSchema.optional(),
  supports: z.array(ForumMotionIdSchema).max(64).optional(),
  opposes: z.array(ForumMotionIdSchema).max(64).optional(),
});
export type ForumAnswer = z.infer<typeof ForumAnswerSchema>;

export function openingAsAnswer(value: ForumOpeningAnswer): ForumAnswer {
  return {
    position: value.position,
    stance: value.stance,
    text: value.text,
    // Nobody had spoken, so there is nobody this answers: null is the fact, not a default.
    inReplyTo: null,
    ...(value.motion === undefined ? {} : { motion: value.motion }),
  };
}

const MOTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1 } },
} as const;

export const forumOpeningAnswer: PanelAnswer<ForumOpeningAnswer> = {
  schema: ForumOpeningAnswerSchema,
  instruction:
    'Return exactly one JSON object with these keys: position (a label of at most eight words naming the position you hold), stance (exactly "hold"), text (your argument as one or more plain sentences, no markdown), and optionally motion ({ "text": "…" }) to put a motion before the forum. Do not wrap it in prose.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['position', 'stance', 'text'],
    properties: {
      position: { type: 'string', minLength: 1, maxLength: 160 },
      stance: { type: 'string', enum: ['hold'] },
      text: { type: 'string', minLength: 1 },
      motion: MOTION_JSON_SCHEMA,
    },
  },
};

export const forumReplyAnswer: PanelAnswer<ForumAnswer> = {
  schema: ForumAnswerSchema,
  instruction:
    'Return exactly one JSON object with these keys: position (a label of at most eight words naming the position you now hold), stance ("hold", "revise" or "rebut"), text (your argument as one or more plain sentences, no markdown), inReplyTo (the seat id you are answering, or null), and optionally motion ({ "text": "…" }), supports (a list of motion ids) and opposes (a list of motion ids). Do not wrap it in prose.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['position', 'stance', 'text', 'inReplyTo'],
    properties: {
      position: { type: 'string', minLength: 1, maxLength: 160 },
      stance: { type: 'string', enum: ['hold', 'revise', 'rebut'] },
      text: { type: 'string', minLength: 1 },
      // Nullable is spelled as a two-member type list because that is what every transport that
      // constrains decoding accepts; `null` is the honest answer when a seat replies to nobody.
      inReplyTo: { type: ['string', 'null'] },
      motion: MOTION_JSON_SCHEMA,
      supports: { type: 'array', items: { type: 'string' } },
      opposes: { type: 'array', items: { type: 'string' } },
    },
  },
};
