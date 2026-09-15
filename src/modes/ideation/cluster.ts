import { z } from 'zod';

export const IdeaIdSchema = z
  .string()
  .regex(/^i-[1-9][0-9]*$/, 'An idea id is i-<n>, numbered from one in arrival order');

export const ClusterIdSchema = z.string().regex(/^k-[1-9][0-9]*$/, 'A cluster id is k-<n>');

export const ClusterSchema = z.strictObject({
  id: ClusterIdSchema,
  label: z.string().trim().min(1),
  ideaIds: z.array(IdeaIdSchema).min(1),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const ClusterableIdeaSchema = z.strictObject({
  id: IdeaIdSchema,
  text: z.string().trim().min(1),
});
export type ClusterableIdea = z.infer<typeof ClusterableIdeaSchema>;

/**
 * What a pass leaves behind for the next one: the clusters as they stand, and the first cluster
 * number that has never been issued. The counter is carried rather than re-derived because a
 * cluster that a merge retires must not see its number come back on a later pass.
 */
export interface ClusterState {
  readonly clusters: readonly Cluster[];
  readonly nextClusterNumber: number;
}

export const SIMILARITY_THRESHOLD = 0.5;

/**
 * Deliberately small and fixed. A larger list would quietly change which ideas group together
 * from one release to the next, and the grouping is a record the human reads back.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'about',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'let',
  'make',
  'more',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'out',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'use',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'you',
  'your',
]);

/**
 * Lower-case, then fold accents, then everything but a letter or a digit becomes a break, then
 * stopwords and one-character tokens go. Nothing is stemmed or singularised: a stemmer is a guess
 * about the language, and this grouping is meant to be reproducible rather than clever.
 *
 * The rule is Unicode-aware on purpose. An ASCII-only character class treats every accented letter
 * as a break, so `naïve` arrives as `na` and `ve`: one word becomes two fragments, it never groups
 * with the `naive` somebody else wrote, and the fragments compete for a place in the label. NFKD
 * decomposes an accented letter into its base plus a combining mark, `\p{M}` removes the mark, and
 * `\p{L}`/`\p{N}` keep every remaining letter and digit whatever the script, so both spellings
 * tokenise to the same folded form.
 */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Intersection over union. Two ideas with no usable tokens score 0, so they never group. */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

function rootOf(parent: number[], index: number): number {
  let root = index;
  for (;;) {
    const next = parent[root];
    if (next === undefined) throw new RangeError(`Cluster index out of range: ${root}`);
    if (next === root) break;
    root = next;
  }
  // Path compression: the structure is rebuilt on every call, so there is no shared state to
  // corrupt and the second pass stays cheap.
  let cursor = index;
  for (;;) {
    const next = parent[cursor];
    if (next === undefined || next === cursor) break;
    parent[cursor] = root;
    cursor = next;
  }
  return root;
}

/**
 * Union-find over every pair. A group always attaches to the lower index, so each group's root is
 * its earliest idea and the map below fills in arrival order — which is the cluster order the
 * spec requires, and the reason nothing here needs a sort.
 */
function groupIdeas(ideas: readonly ClusterableIdea[]): string[][] {
  const tokens = ideas.map((idea) => new Set(tokenise(idea.text)));
  const parent = ideas.map((_, index) => index);
  for (let left = 0; left < ideas.length; left += 1) {
    for (let right = left + 1; right < ideas.length; right += 1) {
      const leftTokens = tokens[left];
      const rightTokens = tokens[right];
      if (leftTokens === undefined || rightTokens === undefined) continue;
      if (jaccard(leftTokens, rightTokens) < SIMILARITY_THRESHOLD) continue;
      const leftRoot = rootOf(parent, left);
      const rightRoot = rootOf(parent, right);
      if (leftRoot === rightRoot) continue;
      parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    }
  }
  const groups = new Map<number, string[]>();
  for (const [index, idea] of ideas.entries()) {
    const root = rootOf(parent, index);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [idea.id]);
    else group.push(idea.id);
  }
  return [...groups.values()];
}

/**
 * A label is a handle, not a summary: the three tokens most of the cluster's ideas share, counted
 * once per idea so one verbose idea cannot name the group. `sort` is stable, so tokens that tie
 * keep first-appearance order and the label is the same on every machine. A single idea is its own
 * best description, so it labels itself.
 */
function labelFor(members: readonly ClusterableIdea[]): string {
  const first = members[0];
  if (first === undefined) throw new Error('A cluster always has at least one idea');
  if (members.length === 1) return first.text;
  const frequency = new Map<string, number>();
  for (const member of members) {
    for (const token of new Set(tokenise(member.text))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  const ranked = [...frequency.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0) {
    return members.reduce(
      (best, member) => (member.text.length < best.text.length ? member : best),
      first,
    ).text;
  }
  return ranked
    .slice(0, 3)
    .map(([token]) => token)
    .join(' ');
}

/**
 * Group every idea the session holds, then decide which groups inherit an existing id.
 *
 * Ids are carried forward by overlap. Previous clusters are considered in ascending numeric id
 * order, and each claims the unclaimed new group it shares the most ideas with; ties fall to the
 * group whose earliest idea arrived first, which is the first maximum found because the groups are
 * already in arrival order. A previous cluster whose every candidate group has been claimed — which
 * is what a merge looks like — is retired, and its number is never issued again because fresh ids
 * continue from `nextClusterNumber` rather than from the count. So a cluster keeps its id exactly
 * when it is the best surviving home for its members and no lower-numbered cluster took that home
 * first.
 *
 * Every idea ever recorded is re-grouped on every pass, which is why `ideas` must be the whole
 * session in arrival order; the check below refuses anything else rather than silently producing
 * a grouping nobody can reproduce.
 */
export function clusterIdeas(
  ideas: readonly ClusterableIdea[],
  previous?: ClusterState,
): ClusterState {
  const parsed = z.array(ClusterableIdeaSchema).parse(ideas);
  parsed.forEach((idea, index) => {
    if (idea.id !== `i-${index + 1}`) {
      throw new Error(`Ideas must arrive in order: expected i-${index + 1}, received ${idea.id}`);
    }
  });
  const byId = new Map(parsed.map((idea) => [idea.id, idea] as const));
  const groups = groupIdeas(parsed);
  const claimed = new Map<number, string>();
  const taken = new Set<number>();
  const previousClusters = [...(previous?.clusters ?? [])].sort(
    (left, right) => Number(left.id.slice(2)) - Number(right.id.slice(2)),
  );
  for (const cluster of previousClusters) {
    const members = new Set(cluster.ideaIds);
    let bestIndex = -1;
    let bestOverlap = 0;
    for (const [index, group] of groups.entries()) {
      if (taken.has(index)) continue;
      const overlap = group.filter((id) => members.has(id)).length;
      if (overlap > bestOverlap) {
        bestIndex = index;
        bestOverlap = overlap;
      }
    }
    if (bestIndex < 0) continue;
    claimed.set(bestIndex, cluster.id);
    taken.add(bestIndex);
  }
  let next = previous?.nextClusterNumber ?? 1;
  const clusters = groups.map((group, index) => {
    const id = claimed.get(index) ?? `k-${next++}`;
    const members = group.map((ideaId) => {
      const idea = byId.get(ideaId);
      if (idea === undefined) throw new Error(`Unknown idea in cluster: ${ideaId}`);
      return idea;
    });
    return ClusterSchema.parse({ id, label: labelFor(members), ideaIds: group });
  });
  return { clusters, nextClusterNumber: next };
}
