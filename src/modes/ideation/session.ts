import { z } from 'zod';
import { EnvelopeSeatSchema, type ModeSessionEvent } from '../../substrate';
import { ClusterIdSchema, ClusterSchema, IdeaIdSchema, type Cluster } from './cluster';

/** The mode name the session store files under, and the prefix its session ids carry. */
export const IDEATION_MODE = 'ideation';
export const IDEATION_SESSION_PREFIX = 'id';

export const PASS_EVENT_KIND = 'pass';
export const CLUSTER_EVENT_KIND = 'cluster';

const NonEmptyStringSchema = z.string().trim().min(1);

export const IdeaSchema = z.strictObject({
  id: IdeaIdSchema,
  seat: NonEmptyStringSchema,
  lens: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
});
export type Idea = z.infer<typeof IdeaSchema>;

/** `all` is the whole room; a list names the clusters a human asked this pass to expand. */
export const PassScopeSchema = z.union([z.literal('all'), z.array(ClusterIdSchema).min(1)]);
export type PassScope = z.infer<typeof PassScopeSchema>;

export const IdeationPassSchema = z.strictObject({
  n: z.number().int().min(1),
  scope: PassScopeSchema,
  ideas: z.array(IdeaSchema),
});
export type IdeationPass = z.infer<typeof IdeationPassSchema>;

/**
 * The mode's `output` block, exactly as docs/modes.md specifies it. There is no score, no rank and
 * no order but arrival order and first-idea order, and `raw` is always the complete list, so a
 * reader who distrusts the grouping can ignore it entirely.
 */
export const IdeationOutputSchema = z.strictObject({
  prompt: NonEmptyStringSchema,
  passes: z.array(IdeationPassSchema).min(1),
  clusters: z.array(ClusterSchema),
  raw: z.array(IdeaIdSchema),
});
export type IdeationOutput = z.infer<typeof IdeationOutputSchema>;

/**
 * One line per pass. It carries more than the output does — the prompt it was run on, the seats as
 * the envelope saw them, and the raw text of any answer that did not validate — because the log is
 * the record and the output is a view of it.
 */
export const IdeationPassEventSchema = z.strictObject({
  n: z.number().int().min(1),
  scope: PassScopeSchema,
  prompt: NonEmptyStringSchema,
  ideasPerSeat: z.number().int().min(1),
  seats: z.array(EnvelopeSeatSchema),
  invalid: z.array(z.strictObject({ seat: NonEmptyStringSchema, raw: z.string() })),
  ideas: z.array(IdeaSchema),
});

export const IdeationClusterEventSchema = z.strictObject({
  n: z.number().int().min(1),
  clusters: z.array(ClusterSchema),
  nextClusterNumber: z.number().int().min(1),
});

export interface IdeationSessionState {
  readonly prompt: string;
  readonly passes: readonly IdeationPass[];
  /** Every idea the session holds, in arrival order across passes. */
  readonly ideas: readonly Idea[];
  readonly clusters: readonly Cluster[];
  readonly nextClusterNumber: number;
  readonly nextIdeaNumber: number;
}

/**
 * Rebuild a session from its log. Every line is validated on the way in, and a log that cannot be
 * read is refused rather than half-read: a pass out of sequence, an idea out of arrival order, a
 * second prompt or an event this mode did not write all mean the file is not the session it claims
 * to be, and continuing would append to a record nobody can reproduce.
 *
 * A pass whose cluster event is missing — a crash between the two appends — is not an error: the
 * last cluster event recorded still governs the numbering, and the next pass re-clusters every idea
 * anyway, so the only thing that must survive is the counter that stops a retired id coming back.
 */
export function readIdeationSession(events: readonly ModeSessionEvent[]): IdeationSessionState {
  const passes: IdeationPass[] = [];
  const ideas: Idea[] = [];
  let prompt: string | null = null;
  let clusters: readonly Cluster[] = [];
  let nextClusterNumber = 1;

  for (const [index, event] of events.entries()) {
    if (event.kind === PASS_EVENT_KIND) {
      const data = IdeationPassEventSchema.parse(event.data);
      if (prompt === null) prompt = data.prompt;
      else if (prompt !== data.prompt) {
        throw new Error(
          `Ideation session line ${index + 1} changes the prompt; this is not one session`,
        );
      }
      if (data.n !== passes.length + 1) {
        throw new Error(
          `Ideation session line ${index + 1} is out of sequence: expected pass ${passes.length + 1}, recorded ${data.n}`,
        );
      }
      passes.push(IdeationPassSchema.parse({ n: data.n, scope: data.scope, ideas: data.ideas }));
      ideas.push(...data.ideas);
      continue;
    }
    if (event.kind === CLUSTER_EVENT_KIND) {
      const data = IdeationClusterEventSchema.parse(event.data);
      clusters = data.clusters;
      nextClusterNumber = data.nextClusterNumber;
      continue;
    }
    throw new Error(`Unknown ideation event at line ${index + 1}: ${event.kind}`);
  }

  if (prompt === null) throw new Error('This ideation session has no recorded pass');
  ideas.forEach((idea, index) => {
    if (idea.id !== `i-${index + 1}`) {
      throw new Error(`Ideation session ids are out of order at ${idea.id}`);
    }
  });

  return {
    prompt,
    passes,
    ideas,
    clusters,
    nextClusterNumber,
    // Contiguous from one, which the check above enforces, so the count is the high-water mark.
    nextIdeaNumber: ideas.length + 1,
  };
}
