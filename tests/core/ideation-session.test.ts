import { describe, expect, test } from 'bun:test';
import {
  CLUSTER_EVENT_KIND,
  IdeationOutputSchema,
  PASS_EVENT_KIND,
  readIdeationSession,
  type IdeationOutput,
} from '../../src/modes/ideation/session';
import type { ModeSessionEvent } from '../../src/substrate';

const AT = '2026-09-15T10:00:00.000Z';

function seat(id: string): unknown {
  return {
    id,
    family: 'xai',
    model: { requested: 'xai-lite', verified: 'xai-lite', verification: 'verified' },
    lens: 'strategist',
    transport: 'subscription',
    fallback: false,
    status: 'ok',
    reason: null,
  };
}

function passEvent(data: Record<string, unknown>): ModeSessionEvent {
  return { at: AT, kind: PASS_EVENT_KIND, data };
}

function clusterEvent(data: Record<string, unknown>): ModeSessionEvent {
  return { at: AT, kind: CLUSTER_EVENT_KIND, data };
}

const firstPass = passEvent({
  n: 1,
  scope: 'all',
  prompt: 'Ways to make advisor notes visible',
  ideasPerSeat: 2,
  seats: [seat('xai/xai-lite#strategist')],
  invalid: [],
  ideas: [
    { id: 'i-1', seat: 'xai/xai-lite#strategist', lens: 'strategist', text: 'alpha beta gamma' },
    { id: 'i-2', seat: 'xai/xai-lite#strategist', lens: 'strategist', text: 'omega psi chi' },
  ],
});

const firstClusters = clusterEvent({
  n: 1,
  nextClusterNumber: 3,
  clusters: [
    { id: 'k-1', label: 'alpha beta gamma', ideaIds: ['i-1'] },
    { id: 'k-2', label: 'omega psi chi', ideaIds: ['i-2'] },
  ],
});

const secondPass = passEvent({
  n: 2,
  scope: ['k-1'],
  prompt: 'Ways to make advisor notes visible',
  ideasPerSeat: 2,
  seats: [seat('google/google-lite#architect')],
  invalid: [{ seat: 'xai/xai-lite#strategist', raw: 'not json at all' }],
  ideas: [
    {
      id: 'i-3',
      seat: 'google/google-lite#architect',
      lens: 'architect',
      text: 'alpha beta delta',
    },
  ],
});

describe('ideation output shape', () => {
  test('is strict, carries no score, and takes either scope form', () => {
    // Annotated so the literal's `scope: 'all'` narrows instead of widening to `string`: without
    // it the object literal's own inferred type would already fail every check below.
    const output: IdeationOutput = {
      prompt: 'p',
      passes: [
        { n: 1, scope: 'all', ideas: [{ id: 'i-1', seat: 's', lens: 'l', text: 't' }] },
        { n: 2, scope: ['k-1', 'k-2'], ideas: [] },
      ],
      clusters: [{ id: 'k-1', label: 'l', ideaIds: ['i-1'] }],
      raw: ['i-1'],
    };
    expect(IdeationOutputSchema.parse(output)).toEqual(output);
    expect(() => IdeationOutputSchema.parse({ ...output, rank: [] })).toThrow();
    expect(() =>
      IdeationOutputSchema.parse({
        ...output,
        clusters: [{ id: 'k-1', label: 'l', ideaIds: ['i-1'], score: 1 }],
      }),
    ).toThrow();
    expect(() =>
      IdeationOutputSchema.parse({ ...output, passes: [{ n: 1, scope: [], ideas: [] }] }),
    ).toThrow();
  });
});

describe('readIdeationSession', () => {
  test('rebuilds the prompt, every pass, every idea and the cluster state', () => {
    const state = readIdeationSession([firstPass, firstClusters, secondPass]);
    expect(state.prompt).toBe('Ways to make advisor notes visible');
    expect(state.passes.map((pass) => [pass.n, pass.scope])).toEqual([
      [1, 'all'],
      [2, ['k-1']],
    ]);
    expect(state.ideas.map((idea) => idea.id)).toEqual(['i-1', 'i-2', 'i-3']);
    expect(state.nextIdeaNumber).toBe(4);
    // The second pass was cut off before its cluster event, so the last recorded cluster state
    // still governs: the numbering survives a torn write, and the next pass re-clusters anyway.
    expect(state.clusters.map((cluster) => cluster.id)).toEqual(['k-1', 'k-2']);
    expect(state.nextClusterNumber).toBe(3);
  });

  test('a session with no pass, a foreign event or a changed prompt is refused', () => {
    expect(() => readIdeationSession([])).toThrow(/no recorded pass/);
    expect(() => readIdeationSession([{ at: AT, kind: 'note', data: {} }])).toThrow(
      /Unknown ideation event at line 1: note/,
    );
    expect(() =>
      readIdeationSession([
        firstPass,
        firstClusters,
        passEvent({
          n: 2,
          scope: 'all',
          prompt: 'A different question entirely',
          ideasPerSeat: 2,
          seats: [],
          invalid: [],
          ideas: [],
        }),
      ]),
    ).toThrow(/changes the prompt/);
  });

  test('a malformed or out-of-order log is refused rather than half-read', () => {
    expect(() => readIdeationSession([passEvent({ n: 1, scope: 'all' })])).toThrow();
    expect(() =>
      readIdeationSession([
        firstPass,
        firstClusters,
        passEvent({
          n: 2,
          scope: 'all',
          prompt: 'Ways to make advisor notes visible',
          ideasPerSeat: 2,
          seats: [],
          invalid: [],
          ideas: [{ id: 'i-9', seat: 's', lens: 'l', text: 't' }],
        }),
      ]),
    ).toThrow(/out of order at i-9/);
    expect(() =>
      readIdeationSession([
        firstPass,
        firstClusters,
        passEvent({
          n: 4,
          scope: 'all',
          prompt: 'Ways to make advisor notes visible',
          ideasPerSeat: 2,
          seats: [],
          invalid: [],
          ideas: [],
        }),
      ]),
    ).toThrow(/expected pass 2, recorded 4/);
  });

  test('keeps the raw text of a seat whose answer did not validate', () => {
    const state = readIdeationSession([firstPass, firstClusters, secondPass]);
    expect(state.passes).toHaveLength(2);
    // The invalid answer is evidence on the log, not in the output: the envelope's seat already
    // says the seat was `invalid`, and the raw text belongs with the record.
    expect(Object.keys(state.passes[1] ?? {}).sort()).toEqual(['ideas', 'n', 'scope']);
  });
});
