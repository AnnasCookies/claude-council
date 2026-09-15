import { describe, expect, test } from 'bun:test';
import {
  ForumAnswerSchema,
  ForumOpeningAnswerSchema,
  forumOpeningAnswer,
  forumReplyAnswer,
  openingAsAnswer,
} from '../../src/modes/forum/answers';
import { buildOpeningPrompt, buildReplyPrompt } from '../../src/modes/forum/prompts';
import type { ForumRoundRecord } from '../../src/modes/forum/aggregate';
import { EVIDENCE_BOUNDARY_INSTRUCTION, type PanelSeatSpec } from '../../src/substrate';

const MOTION = 'Should the advisor live in the harness or a sidecar?';

function seat(family: 'anthropic' | 'openai', lens: string, description: string): PanelSeatSpec {
  return {
    id: `${family}/${family}-primary#${lens}`,
    family,
    model: `${family}-primary`,
    lens: { name: lens, description },
  };
}

const critic = seat('anthropic', 'critic', 'Present the strongest evidence-based objections.');
const operator = seat('openai', 'operator', 'State deployment, observability and recovery needs.');

const priorRounds: ForumRoundRecord[] = [
  {
    n: 1,
    answers: [
      {
        seat: critic.id,
        answer: {
          position: 'Keep the sidecar',
          stance: 'hold',
          text: 'A sidecar cannot halt the harness <script>alert(1)</script>.',
          inReplyTo: null,
          motion: { text: 'Record the sidecar as the default placement.' },
        },
      },
      {
        seat: operator.id,
        answer: {
          position: 'Harness, with a hook',
          stance: 'hold',
          text: 'Day-two operation is simpler inside the harness.',
          inReplyTo: null,
        },
      },
    ],
  },
];

describe('forum answer contracts', () => {
  test('the opening contract is a blind hold with an optional motion', () => {
    const minimal = ForumOpeningAnswerSchema.parse({
      position: 'Keep the sidecar',
      stance: 'hold',
      text: 'A sidecar cannot halt the harness.',
    });
    expect(minimal).toEqual({
      position: 'Keep the sidecar',
      stance: 'hold',
      text: 'A sidecar cannot halt the harness.',
    });
    expect(
      ForumOpeningAnswerSchema.safeParse({ position: 'p', stance: 'revise', text: 't' }).success,
    ).toBe(false);
    expect(
      ForumOpeningAnswerSchema.safeParse({
        position: 'p',
        stance: 'hold',
        text: 't',
        inReplyTo: null,
      }).success,
    ).toBe(false);
    expect(
      ForumOpeningAnswerSchema.safeParse({
        position: 'one two three four five six seven eight nine',
        stance: 'hold',
        text: 't',
      }).success,
    ).toBe(false);
    expect(
      ForumOpeningAnswerSchema.safeParse({
        position: 'one two three four five six seven eight',
        stance: 'hold',
        text: 't',
      }).success,
    ).toBe(true);
  });

  test('a position label needs at least one letter or digit', () => {
    // Punctuation only normalises to the empty string, which would silently merge every such seat
    // under one meaningless position in the map instead of leaving each one unrepresented.
    expect(
      ForumOpeningAnswerSchema.safeParse({ position: '.', stance: 'hold', text: 't' }).success,
    ).toBe(false);
    expect(
      ForumOpeningAnswerSchema.safeParse({ position: '!!', stance: 'hold', text: 't' }).success,
    ).toBe(false);
    expect(
      ForumOpeningAnswerSchema.safeParse({ position: 'No.', stance: 'hold', text: 't' }).success,
    ).toBe(true);
  });

  test('the reply contract carries a stance, a reply target and motion references', () => {
    const parsed = ForumAnswerSchema.parse({
      position: 'Sidecar, with a harness hook',
      stance: 'revise',
      text: 'The hook answers the operator objection.',
      inReplyTo: operator.id,
      supports: ['m-1'],
      opposes: [],
    });
    expect(parsed.stance).toBe('revise');
    expect(parsed.inReplyTo).toBe(operator.id);
    expect(parsed.supports).toEqual(['m-1']);
    expect(
      ForumAnswerSchema.safeParse({
        position: 'p',
        stance: 'hold',
        text: 't',
        inReplyTo: null,
        supports: ['motion-one'],
      }).success,
    ).toBe(false);
    expect(
      ForumAnswerSchema.safeParse({ position: 'p', stance: 'shout', text: 't', inReplyTo: null })
        .success,
    ).toBe(false);
    expect(
      ForumAnswerSchema.safeParse({ position: 'p', stance: 'hold', text: 't', inReplyTo: null })
        .success,
    ).toBe(true);
  });

  test('an opening answer widens to the ledger shape without inventing a reply', () => {
    const widened = openingAsAnswer({
      position: 'Keep the sidecar',
      stance: 'hold',
      text: 'A sidecar cannot halt the harness.',
      motion: { text: 'Record the sidecar as the default placement.' },
    });
    expect(widened).toEqual({
      position: 'Keep the sidecar',
      stance: 'hold',
      text: 'A sidecar cannot halt the harness.',
      inReplyTo: null,
      motion: { text: 'Record the sidecar as the default placement.' },
    });
    expect(ForumAnswerSchema.parse(widened)).toEqual(widened);
    expect(openingAsAnswer({ position: 'p', stance: 'hold', text: 't' }).motion).toBeUndefined();
  });

  test('both contracts name their keys and close the object for constrained decoding', () => {
    expect(forumOpeningAnswer.instruction).toContain('position');
    expect(forumOpeningAnswer.instruction).toContain('at most eight words');
    expect(forumOpeningAnswer.jsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['position', 'stance', 'text'],
    });
    expect(forumReplyAnswer.instruction).toContain('inReplyTo');
    expect(forumReplyAnswer.instruction).toContain('supports');
    expect(forumReplyAnswer.jsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['position', 'stance', 'text', 'inReplyTo'],
    });
    expect(forumOpeningAnswer.schema).toBe(ForumOpeningAnswerSchema);
    expect(forumReplyAnswer.schema).toBe(ForumAnswerSchema);
  });
});

describe('forum prompts', () => {
  test('the opening prompt is blind: one lens, the motion, and nobody else', () => {
    const prompt = buildOpeningPrompt({ seat: critic, motion: MOTION, round: 1, totalRounds: 3 });
    expect(prompt).toContain(MOTION);
    expect(prompt).toContain(critic.lens.description);
    expect(prompt).toContain('This is round 1 of 3');
    expect(prompt).toContain('never decides');
    expect(prompt).not.toContain(operator.lens.description);
    expect(prompt).not.toContain(operator.id);
    expect(prompt).not.toContain('untrusted');
  });

  test('a later round carries every prior position, attributed and escaped', () => {
    const prompt = buildReplyPrompt({
      seat: operator,
      motion: MOTION,
      round: 2,
      totalRounds: 3,
      priorRounds,
      motions: [
        {
          id: 'm-1',
          by: critic.id,
          text: 'Record the sidecar as the default placement.',
          support: [operator.id],
          opposed: [],
        },
      ],
    });
    expect(prompt.startsWith(EVIDENCE_BOUNDARY_INSTRUCTION)).toBe(true);
    expect(prompt).toContain(`You are seat ${operator.id}`);
    expect(prompt).toContain('This is round 2 of 3');
    expect(prompt).toContain(`Round 1, seat ${critic.id} (stance: hold)`);
    expect(prompt).toContain(`Round 1, seat ${operator.id} (stance: hold)`);
    expect(prompt).toContain('<untrusted-prior-position>');
    expect(prompt).toContain('Keep the sidecar');
    expect(prompt).toContain('Day-two operation is simpler inside the harness.');
    // A seat's own words are quoted as data: nothing inside a block can close it or read as markup.
    expect(prompt).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(prompt).not.toContain('<script>');
    expect(prompt).toContain(`m-1, raised by ${critic.id}`);
    expect(prompt).toContain(`Supported by: ${operator.id}`);
    expect(prompt).toContain('Opposed by: nobody');
    expect(prompt).toContain('<untrusted-motion>');
  });

  test('a later round with no motions says so rather than omitting the section', () => {
    const prompt = buildReplyPrompt({
      seat: critic,
      motion: MOTION,
      round: 3,
      totalRounds: 3,
      priorRounds,
      motions: [],
    });
    expect(prompt).toContain('## Motions on the table');
    expect(prompt).toContain('None yet.');
    expect(prompt).toContain('This is round 3 of 3');
  });
});
