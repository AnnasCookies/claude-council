import { describe, expect, test } from 'bun:test';
import {
  ClusterSchema,
  SIMILARITY_THRESHOLD,
  clusterIdeas,
  jaccard,
  tokenise,
  type ClusterableIdea,
} from '../../src/modes/ideation/cluster';

function ideas(...texts: readonly string[]): ClusterableIdea[] {
  return texts.map((text, index) => ({ id: `i-${index + 1}`, text }));
}

describe('ideation tokens', () => {
  test('lower-cases, strips punctuation, drops stopwords and one-character tokens', () => {
    expect(tokenise("Don't rank the ideas!")).toEqual(['don', 'rank', 'ideas']);
    expect(tokenise('Show  the   advisor notes')).toEqual(['show', 'advisor', 'notes']);
    expect(tokenise('a of the and')).toEqual([]);
  });

  test('folds accents rather than breaking on them, whatever the script', () => {
    // An ASCII-only class broke `naïve` into `na` and `ve`: one word became two fragments, neither
    // of which matched anything anyone else had written.
    expect(tokenise('naïve plan')).toEqual(['naive', 'plan']);
    expect(tokenise('Résumé caché')).toEqual(['resume', 'cache']);
    // The composed and the decomposed spelling of one word are the same token.
    expect(tokenise('naïve')).toEqual(tokenise('naïve'));
    // A letter with no ASCII base is kept whole rather than discarded as punctuation.
    expect(tokenise('Ελληνικά σχέδιο')).toEqual(['ελληνικα', 'σχεδιο']);
    expect(tokenise('число 42')).toEqual(['число', '42']);
  });

  test('jaccard is intersection over union, and two empty sets are not similar', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd']))).toBe(0.5);
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c', 'd']))).toBeCloseTo(0.25, 10);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
    expect(SIMILARITY_THRESHOLD).toBe(0.5);
  });
});

describe('clusterIdeas', () => {
  test('unions at the threshold and leaves everything below it alone', () => {
    // Two shared tokens out of four distinct ones is exactly 0.5, which unions; one out of four
    // is 0.25, which does not.
    const atThreshold = clusterIdeas(ideas('alpha beta', 'alpha beta gamma delta'));
    expect(atThreshold.clusters.map((cluster) => cluster.ideaIds)).toEqual([['i-1', 'i-2']]);

    const belowThreshold = clusterIdeas(ideas('alpha beta', 'alpha gamma delta'));
    expect(belowThreshold.clusters.map((cluster) => cluster.ideaIds)).toEqual([['i-1'], ['i-2']]);
  });

  test('groups near-duplicates, keeps singletons, and labels each group', () => {
    const state = clusterIdeas(
      ideas(
        'Show advisor notes in the status line',
        'Show the advisor notes in a status line',
        'Batch notes into a digest at the end of the session',
        'Colour code notes by severity',
      ),
    );
    expect(state.clusters).toEqual([
      { id: 'k-1', label: 'show advisor notes', ideaIds: ['i-1', 'i-2'] },
      {
        id: 'k-2',
        label: 'Batch notes into a digest at the end of the session',
        ideaIds: ['i-3'],
      },
      { id: 'k-3', label: 'Colour code notes by severity', ideaIds: ['i-4'] },
    ]);
    expect(state.nextClusterNumber).toBe(4);
  });

  test('an accented spelling groups with its unaccented one, and the label is the folded form', () => {
    const state = clusterIdeas(
      ideas('A naïve plan the team préfère', 'A naive plan the team prefere', 'Colour code notes'),
    );
    // Before the tokeniser folded accents these two scored 1/5 and sat in separate groups, so the
    // record showed the same idea twice under two headings.
    expect(state.clusters).toEqual([
      { id: 'k-1', label: 'naive plan team', ideaIds: ['i-1', 'i-2'] },
      { id: 'k-2', label: 'Colour code notes', ideaIds: ['i-3'] },
    ]);
  });

  test('clusters are ordered by their earliest idea and carry no score of any kind', () => {
    const state = clusterIdeas(
      ideas('kappa lambda mu', 'alpha beta gamma', 'kappa lambda mu nu', 'alpha beta gamma delta'),
    );
    expect(state.clusters.map((cluster) => cluster.ideaIds[0])).toEqual(['i-1', 'i-2']);
    for (const cluster of state.clusters) {
      expect(Object.keys(cluster).sort()).toEqual(['id', 'ideaIds', 'label']);
      expect(ClusterSchema.parse(cluster)).toEqual(cluster);
    }
    // The shape is strict, so a score could not be smuggled onto a cluster even by a later caller.
    expect(() =>
      ClusterSchema.parse({ id: 'k-1', label: 'x', ideaIds: ['i-1'], score: 1 }),
    ).toThrow();
  });

  test('a second pass keeps the id of every cluster that is still the best home for its members', () => {
    const first = clusterIdeas(ideas('alpha beta gamma', 'alpha beta gamma delta'));
    expect(first.clusters.map((cluster) => cluster.id)).toEqual(['k-1']);

    const second = clusterIdeas(
      ideas(
        'alpha beta gamma',
        'alpha beta gamma delta',
        'alpha beta gamma epsilon',
        'omega psi chi',
      ),
      first,
    );
    expect(second.clusters).toEqual([
      { id: 'k-1', label: 'alpha beta gamma', ideaIds: ['i-1', 'i-2', 'i-3'] },
      { id: 'k-2', label: 'omega psi chi', ideaIds: ['i-4'] },
    ]);
    expect(second.nextClusterNumber).toBe(3);
  });

  test('a merge retires the higher id and the number is never issued again', () => {
    const first = clusterIdeas(
      ideas('alpha beta gamma', 'alpha beta gamma delta', 'kappa lambda mu', 'kappa lambda mu nu'),
    );
    expect(first.clusters.map((cluster) => [cluster.id, cluster.ideaIds])).toEqual([
      ['k-1', ['i-1', 'i-2']],
      ['k-2', ['i-3', 'i-4']],
    ]);

    const merged = clusterIdeas(
      ideas(
        'alpha beta gamma',
        'alpha beta gamma delta',
        'kappa lambda mu',
        'kappa lambda mu nu',
        'alpha beta gamma kappa lambda mu',
        'omega psi chi',
      ),
      first,
    );
    // k-1 sorts first and claims the merged group, so k-2 has no unclaimed home left and retires.
    // The new singleton takes k-3: k-2 is spent, never reused.
    expect(merged.clusters.map((cluster) => [cluster.id, cluster.ideaIds])).toEqual([
      ['k-1', ['i-1', 'i-2', 'i-3', 'i-4', 'i-5']],
      ['k-3', ['i-6']],
    ]);
    expect(merged.nextClusterNumber).toBe(4);
  });

  test('refuses ideas that are not in arrival order', () => {
    expect(() => clusterIdeas([{ id: 'i-2', text: 'out of order' }])).toThrow(
      /Ideas must arrive in order: expected i-1, received i-2/,
    );
    expect(() => clusterIdeas([{ id: 'idea-1', text: 'wrong shape' }])).toThrow();
    expect(() => clusterIdeas([{ id: 'i-1', text: '   ' }])).toThrow();
  });
});
