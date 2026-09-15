import { z } from 'zod';
import {
  EVIDENCE_BOUNDARY_INSTRUCTION,
  untrustedBlock,
  type PanelAnswer,
  type PanelLens,
} from '../../substrate';

/** A reaction is one or two sentences. A longer reply is cut by the mode, never discarded. */
export const MAX_QUOTE_LENGTH = 400;
const MAX_STOPPED_AT_LENGTH = 120;

export function truncateQuote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_QUOTE_LENGTH) return trimmed;
  // `slice` cuts on UTF-16 units, so it can land between the two halves of an astral character's
  // surrogate pair and leave a lone high surrogate immediately before the ellipsis. That unpaired
  // unit round-trips through JSON and into the session log, but a strict JSONL reader — or the
  // minutes — renders it back as U+FFFD, one silently corrupted character in an otherwise
  // verbatim quote. Dropping it costs at most one UTF-16 unit of the 400-unit bound.
  const sliced = trimmed.slice(0, MAX_QUOTE_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${sliced}…`;
}

/**
 * What one persona seat returns. The quote is bounded by the mode rather than by this schema: a
 * reader who answered in four sentences still said something, and truncating keeps that voice
 * where failing the seat would lose it altogether.
 */
export const AudienceReactionSchema = z.strictObject({
  clear: z.boolean(),
  wouldAct: z.boolean(),
  stoppedAt: z.string().trim().max(MAX_STOPPED_AT_LENGTH),
  quote: z.string().trim().min(1),
});
export type AudienceReaction = z.infer<typeof AudienceReactionSchema>;

/**
 * The contract the adapter prepends to the prompt and hands to the transports that constrain
 * decoding. It replaces the council answer shape for these seats: a reader is not a council seat
 * and has no recommendation, evidence or decisive test to give.
 */
export const AUDIENCE_ANSWER: PanelAnswer<AudienceReaction> = Object.freeze({
  schema: AudienceReactionSchema,
  instruction:
    'Return exactly one JSON object with these keys: clear (boolean: was the draft clear to you), wouldAct (boolean: would you do what it asks), stoppedAt (string: where you stopped reading, or "the end" if you read all of it), quote (string: one or two sentences in your own voice, at most 400 characters). Do not wrap it in prose.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['clear', 'wouldAct', 'stoppedAt', 'quote'],
    properties: {
      clear: { type: 'boolean' },
      wouldAct: { type: 'boolean' },
      stoppedAt: { type: 'string', maxLength: MAX_STOPPED_AT_LENGTH },
      quote: { type: 'string', minLength: 1, maxLength: MAX_QUOTE_LENGTH },
    },
  },
});

export interface ReactionPromptInput {
  readonly persona: PanelLens;
  readonly draftText: string;
  /** Why the draft exists, from --question or --motion. Quoted as data, never as an instruction. */
  readonly question?: string;
}

/**
 * One prompt per seat, built from the caller's material only: the persona's own brief, the
 * evidence boundary rule, and the draft inside an untrusted block. No seat's output from this
 * round can appear here, which is what keeps the round blind.
 */
export function buildReactionPrompt(input: ReactionPromptInput): string {
  const lines = [
    `You are one reader in an audience, and this answer carries your view alone. ${input.persona.description}`,
    '',
    EVIDENCE_BOUNDARY_INSTRUCTION,
    '',
    'Read the draft below once, as this reader, at the pace that reader would read it. You are not editing it: do not rewrite it, do not propose wording, and speak only for yourself.',
    '',
  ];
  if (input.question !== undefined) {
    lines.push(
      'The person who shared the draft says it is meant to do this:',
      '',
      untrustedBlock('purpose', input.question),
      '',
    );
  }
  lines.push(
    untrustedBlock('draft', input.draftText),
    '',
    'Answer for yourself: was it clear, would you act on it, where did you stop reading, and one or two sentences in your own voice.',
  );
  return lines.join('\n');
}
