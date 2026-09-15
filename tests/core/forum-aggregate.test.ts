import { describe, expect, test } from 'bun:test';
import {
  ForumOutputSchema,
  aggregateForum,
  buildMoved,
  buildPositionMap,
  collectMotions,
  normalisePosition,
  type ForumRoundRecord,
  type ForumSeatAnswer,
} from '../../src/modes/forum/aggregate';
import type { ForumStance } from '../../src/modes/forum/answers';

const ALPHA = 'anthropic/anthropic-primary#critic';
const BETA = 'openai/openai-primary#operator';
const GAMMA = 'xai/xai-primary#security';

interface SaidExtra {
  readonly stance?: ForumStance;
  readonly inReplyTo?: string;
  readonly motion?: { readonly text: string };
  readonly supports?: string[];
  readonly opposes?: string[];
}

// Written out rather than spread from a Partial: `exactOptionalPropertyTypes` makes an absent
// optional key and a key set to undefined different things.
function said(
  seat: string,
  position: string,
  text: string,
  extra: SaidExtra = {},
): ForumSeatAnswer {
  return {
    seat,
    answer: {
      position,
      stance: extra.stance ?? 'hold',
      text,
      inReplyTo: extra.inReplyTo ?? null,
      ...(extra.motion === undefined ? {} : { motion: extra.motion }),
      ...(extra.supports === undefined ? {} : { supports: extra.supports }),
      ...(extra.opposes === undefined ? {} : { opposes: extra.opposes }),
    },
  };
}

function round(n: number, ...answers: ForumSeatAnswer[]): ForumRoundRecord {
  return { n, answers };
}

describe('position labels', () => {
  test('normalisation is case, whitespace and trailing punctuation only', () => {
    expect(normalisePosition('Keep the sidecar.')).toBe('keep the sidecar');
    expect(normalisePosition('  KEEP   the   sidecar ')).toBe('keep the sidecar');
    expect(normalisePosition('Keep the sidecar!?')).toBe('keep the sidecar');
    expect(normalisePosition('Keep the sidecar, for now')).toBe('keep the sidecar, for now');
    expect(normalisePosition('Sidecar')).not.toBe(normalisePosition('Harness'));
  });
});

describe('the position map', () => {
  test('groups the final round only, keeping each holder and the first wording written', () => {
    const rounds = [
      round(1, said(ALPHA, 'Harness', 'a'), said(BETA, 'Keep the sidecar', 'b')),
      round(
        2,
        said(ALPHA, 'Keep the sidecar.', 'a2'),
        said(BETA, 'keep   the sidecar', 'b2'),
        said(GAMMA, 'Harness, with a hook', 'c2'),
      ),
    ];
    const map = buildPositionMap(rounds[1]);
    expect(map).toEqual([
      { position: 'Keep the sidecar.', holders: [ALPHA, BETA] },
      { position: 'Harness, with a hook', holders: [GAMMA] },
    ]);
    expect(buildPositionMap(undefined)).toEqual([]);
    expect(buildPositionMap(round(3))).toEqual([]);
  });
});

describe('who moved', () => {
  test('a move is attributed to a seat and a round, with the reason that round gave', () => {
    const rounds = [
      round(1, said(ALPHA, 'Keep the sidecar', 'opening'), said(BETA, 'Harness', 'opening')),
      round(
        2,
        said(ALPHA, 'Keep the sidecar.', 'unchanged'),
        said(BETA, 'Sidecar, with a hook', 'the hook answers it', { stance: 'revise' }),
      ),
      round(3, said(ALPHA, 'Harness after all', 'the cost argument lands', { stance: 'revise' })),
    ];
    expect(buildMoved(rounds)).toEqual([
      {
        seat: BETA,
        round: 2,
        from: 'Harness',
        to: 'Sidecar, with a hook',
        why: 'the hook answers it',
      },
      {
        seat: ALPHA,
        round: 3,
        from: 'Keep the sidecar.',
        to: 'Harness after all',
        why: 'the cost argument lands',
      },
    ]);
  });

  test('a seat that missed a round is compared with its own last answer, not with silence', () => {
    const rounds = [
      round(1, said(ALPHA, 'Keep the sidecar', 'opening')),
      round(2),
      round(3, said(ALPHA, 'Harness after all', 'round three', { stance: 'revise' })),
    ];
    expect(buildMoved(rounds)).toEqual([
      {
        seat: ALPHA,
        round: 3,
        from: 'Keep the sidecar',
        to: 'Harness after all',
        why: 'round three',
      },
    ]);
  });

  test('a seat that moves and moves back records both moves', () => {
    const rounds = [
      round(1, said(ALPHA, 'Sidecar', 'one')),
      round(2, said(ALPHA, 'Harness', 'two', { stance: 'revise' })),
      round(3, said(ALPHA, 'Sidecar', 'three', { stance: 'revise' })),
    ];
    expect(buildMoved(rounds).map((move) => [move.round, move.from, move.to])).toEqual([
      [2, 'Sidecar', 'Harness'],
      [3, 'Harness', 'Sidecar'],
    ]);
  });
});

describe('motions', () => {
  test('ids are minted in arrival order and support accumulates from later rounds', () => {
    const rounds = [
      round(
        1,
        said(ALPHA, 'Keep the sidecar', 'a', { motion: { text: 'Record the sidecar default.' } }),
        said(BETA, 'Harness', 'b', { motion: { text: 'Record a harness spike.' } }),
      ),
      round(
        2,
        said(ALPHA, 'Keep the sidecar', 'a2', { supports: ['m-1'], opposes: ['m-2'] }),
        said(BETA, 'Harness', 'b2', { supports: ['m-1', 'm-1'] }),
        said(GAMMA, 'Harness', 'c2', { opposes: ['m-1'] }),
      ),
    ];
    expect(collectMotions(rounds)).toEqual([
      {
        id: 'm-1',
        by: ALPHA,
        text: 'Record the sidecar default.',
        support: [ALPHA, BETA],
        opposed: [GAMMA],
      },
      { id: 'm-2', by: BETA, text: 'Record a harness spike.', support: [], opposed: [ALPHA] },
    ]);
  });

  test('a reference to a motion nobody could have seen is left out, never counted', () => {
    const rounds = [
      round(
        1,
        said(ALPHA, 'Keep the sidecar', 'a', { motion: { text: 'Record the sidecar default.' } }),
        // Raised in the same round, so BETA cannot have read it: the reference is an invention.
        said(BETA, 'Harness', 'b', { supports: ['m-1'] }),
      ),
      round(2, said(GAMMA, 'Harness', 'c2', { supports: ['m-9'] })),
    ];
    expect(collectMotions(rounds)).toEqual([
      { id: 'm-1', by: ALPHA, text: 'Record the sidecar default.', support: [], opposed: [] },
    ]);
  });

  test('raising a motion is not supporting it', () => {
    const rounds = [
      round(1, said(ALPHA, 'Keep the sidecar', 'a', { motion: { text: 'Record it.' } })),
    ];
    expect(collectMotions(rounds)[0]?.support).toEqual([]);
  });
});

describe('the forum output', () => {
  const rounds = [
    round(
      1,
      said(ALPHA, 'Keep the sidecar', 'a', { motion: { text: 'Record the sidecar default.' } }),
      said(BETA, 'Harness', 'b'),
    ),
    round(
      2,
      said(ALPHA, 'Keep the sidecar.', 'a2', { inReplyTo: BETA }),
      said(BETA, 'Sidecar, with a hook', 'b2', {
        stance: 'revise',
        inReplyTo: 'seat-that-never-sat',
      }),
    ),
  ];

  test('assembles rounds, map, moved and motions, and validates itself', () => {
    const output = aggregateForum({ seats: [ALPHA, BETA], rounds });
    expect(ForumOutputSchema.parse(output)).toEqual(output);
    expect(output.rounds.map((entry) => entry.n)).toEqual([1, 2]);
    expect(output.rounds[0]?.positions).toEqual([
      { seat: ALPHA, stance: 'hold', text: 'a', inReplyTo: null },
      { seat: BETA, stance: 'hold', text: 'b', inReplyTo: null },
    ]);
    // A reply target that names a seat which never sat is dropped from the output; the raw claim
    // stays in the session ledger.
    expect(output.rounds[1]?.positions[1]?.inReplyTo).toBeNull();
    expect(output.rounds[1]?.positions[0]?.inReplyTo).toBe(BETA);
    expect(output.map).toEqual([
      { position: 'Keep the sidecar.', holders: [ALPHA] },
      { position: 'Sidecar, with a hook', holders: [BETA] },
    ]);
    expect(output.moved).toEqual([
      { seat: BETA, round: 2, from: 'Harness', to: 'Sidecar, with a hook', why: 'b2' },
    ]);
    expect(output.motions).toEqual([
      { id: 'm-1', by: ALPHA, text: 'Record the sidecar default.', support: [], opposed: [] },
    ]);
  });

  test('has no field for a decision, a winner, a score or a rank', () => {
    const output = aggregateForum({ seats: [ALPHA, BETA], rounds });
    expect(ForumOutputSchema.safeParse({ ...output, decision: 'sidecar' }).success).toBe(false);
    expect(ForumOutputSchema.safeParse({ ...output, winner: ALPHA }).success).toBe(false);
    expect(
      ForumOutputSchema.safeParse({
        ...output,
        map: output.map.map((entry) => ({ ...entry, score: 1 })),
      }).success,
    ).toBe(false);
    expect(
      ForumOutputSchema.safeParse({
        ...output,
        motions: output.motions.map((motion) => ({ ...motion, decision: 'carried' })),
      }).success,
    ).toBe(false);
    expect(
      ForumOutputSchema.safeParse({
        ...output,
        moved: output.moved.map((move) => ({ ...move, rank: 1 })),
      }).success,
    ).toBe(false);

    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, nested] of Object.entries(value)) {
        keys.push(key);
        walk(nested);
      }
    };
    walk(output);
    expect(keys.filter((key) => /score|rank|winner|decision|verdict/iu.test(key))).toEqual([]);
  });
});
