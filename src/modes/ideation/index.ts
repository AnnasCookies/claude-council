import { z } from 'zod';
import {
  EVIDENCE_BOUNDARY_INSTRUCTION,
  panelEnvelopeSeats,
  runPanel,
  untrustedBlock,
  type ModeSessionEvent,
  type PanelAnswer,
  type PanelLens,
} from '../../substrate';
import { integerValue, listValue, oneValue } from '../flags';
import type { HandlerInput, HandlerModeDefinition, HandlerOutcome } from '../types';
import { clusterIdeas } from './cluster';
import {
  catalogueLens,
  ideationRegistry,
  ideationSeats,
  loadPersonaLenses,
  parseModelOverrides,
  resolveSeatLenses,
} from './seats';
import {
  CLUSTER_EVENT_KIND,
  IDEATION_MODE,
  IDEATION_SESSION_PREFIX,
  IdeaSchema,
  IdeationClusterEventSchema,
  IdeationOutputSchema,
  IdeationPassEventSchema,
  IdeationPassSchema,
  PASS_EVENT_KIND,
  readIdeationSession,
  type Idea,
  type IdeationOutput,
  type IdeationSessionState,
  type PassScope,
} from './session';

const DEFAULT_SEATS = 12;
/**
 * The panel holds a bounded number of seats open at once — six by default, and its own ceiling is
 * 24 — so this is not the concurrency limit. It is a bound on the room: every seat costs a call
 * whether or not it is in flight, and every idea it returns is re-clustered against every other
 * on this pass and on every later one. Raising it is a decision about cost and about how much a
 * human can read back, not about what one machine can hold open.
 */
const MAX_SEATS = 24;
const DEFAULT_IDEAS_PER_SEAT = 3;
const MAX_IDEAS_PER_SEAT = 10;

/**
 * The seat's answer. The schema deliberately sets no maximum: a seat that returns more than it was
 * asked for has been generous, not wrong, and the handler keeps the first `ideasPerSeat`. Only an
 * empty list is an invalid answer, because a seat that offered nothing contributed nothing.
 */
export const IdeationAnswerSchema = z.strictObject({
  ideas: z.array(z.strictObject({ text: z.string().trim().min(1) })).min(1),
});
export type IdeationAnswer = z.infer<typeof IdeationAnswerSchema>;

export function ideationAnswer(ideasPerSeat: number): PanelAnswer<IdeationAnswer> {
  return {
    schema: IdeationAnswerSchema,
    instruction: `Return exactly one JSON object of the form {"ideas":[{"text":"..."}]} holding at most ${ideasPerSeat} ideas. Each text is one short sentence. Do not rank, score or number them, and do not wrap the object in prose.`,
    // The transports that constrain decoding are told the maximum; the schema above still accepts
    // more, so a transport that cannot constrain does not cost the seat its answer.
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ideas'],
      properties: {
        ideas: {
          type: 'array',
          minItems: 1,
          maxItems: ideasPerSeat,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: { text: { type: 'string', minLength: 1 } },
          },
        },
      },
    },
  };
}

export interface IdeationPromptInput {
  readonly lens: PanelLens;
  readonly prompt: string;
  readonly ideasPerSeat: number;
  /** Ideas from earlier passes, only from the clusters this pass expands. Empty on a first pass. */
  readonly scoped: readonly { readonly cluster: string; readonly text: string }[];
}

/**
 * Pure, and the only place a seat's text is assembled. It can carry prior material only because a
 * caller handed it in, and the handler hands in the expanded clusters' ideas and nothing else — so
 * "no seat sees another seat's output within a pass" is a property of this signature, not a rule
 * somebody has to remember. Prior ideas arrive wrapped and escaped, under the evidence boundary.
 */
export function ideationPrompt(input: IdeationPromptInput): string {
  const lines: string[] = [];
  if (input.scoped.length > 0) lines.push(EVIDENCE_BOUNDARY_INSTRUCTION, '');
  lines.push(
    `You hold one lens in a room generating options. Lens: ${input.lens.name}.`,
    input.lens.description,
    '',
    'The prompt:',
    input.prompt,
    '',
  );
  if (input.scoped.length > 0) {
    lines.push(
      'Ideas already recorded in the groups this pass expands:',
      untrustedBlock(
        'ideas',
        input.scoped.map((idea) => `${idea.cluster}: ${idea.text}`).join('\n'),
      ),
      '',
      'Add ideas that belong inside those groups. Do not repeat one that is already there.',
      '',
    );
  }
  lines.push(
    `Give at most ${input.ideasPerSeat} ideas, each one short sentence, each different from the others.`,
    'Do not rank, score or number them, and do not comment on any idea but your own.',
  );
  return lines.join('\n');
}

interface Expansion {
  readonly clusters: string[];
  /** The named clusters' ideas, in arrival order, each tagged with the cluster it came from. */
  readonly scoped: { readonly cluster: string; readonly text: string }[];
}

/**
 * Resolve `--expand` against the recorded clusters. An unknown id is a usage error and is raised
 * here, before the roster is built and long before a seat is invoked, so a typo costs nothing.
 */
function expansionScope(named: readonly string[], prior: IdeationSessionState | null): Expansion {
  if (prior === null) {
    throw new Error(
      '--expand continues an ideation session: pass --session <id> of a recorded one',
    );
  }
  const known = new Map(prior.clusters.map((cluster) => [cluster.id, cluster] as const));
  const seen = new Set<string>();
  const chosen = named.map((id) => {
    const cluster = known.get(id);
    if (cluster === undefined) {
      throw new Error(
        `Unknown cluster id: ${id}. This session has ${[...known.keys()].join(', ')}.`,
      );
    }
    if (seen.has(id)) throw new Error(`Option --expand names ${id} twice`);
    seen.add(id);
    return cluster;
  });
  const owner = new Map(
    chosen.flatMap((cluster) => cluster.ideaIds.map((id) => [id, cluster.id] as const)),
  );
  return {
    clusters: chosen.map((cluster) => cluster.id),
    // Arrival order, so the block a seat reads is ordered as the record holds it.
    scoped: prior.ideas.flatMap((idea) => {
      const cluster = owner.get(idea.id);
      return cluster === undefined ? [] : [{ cluster, text: idea.text }];
    }),
  };
}

async function namedLenses(input: HandlerInput): Promise<PanelLens[] | null> {
  const personaPath = oneValue(input.flags, 'personas');
  const lenses = listValue(input.flags, 'lenses');
  if (personaPath !== undefined && lenses !== undefined) {
    throw new Error('--personas supplies the seats itself; it cannot be combined with --lenses');
  }
  if (personaPath !== undefined) return loadPersonaLenses(personaPath, input.context.cwd);
  if (lenses !== undefined) return lenses.map(catalogueLens);
  return null;
}

/**
 * The mode's `output` block, which is a view of the session and nothing else: no field of it is
 * carried from the call, so what the caller is handed is what a later `--expand` will read back.
 */
function ideationOutput(state: IdeationSessionState): IdeationOutput {
  return {
    prompt: state.prompt,
    passes: [...state.passes],
    clusters: [...state.clusters],
    raw: state.ideas.map((idea) => idea.id),
  };
}

async function handle(input: HandlerInput): Promise<HandlerOutcome> {
  const sessions = input.sessions;
  if (sessions === null) {
    throw new Error(
      'ideate keeps every idea from every pass, so it needs somewhere to keep them: pass --records-root <path>',
    );
  }
  const ideasPerSeat = integerValue(
    input.flags,
    'ideas-per-seat',
    DEFAULT_IDEAS_PER_SEAT,
    1,
    MAX_IDEAS_PER_SEAT,
  );
  const expand = listValue(input.flags, 'expand');

  // The session is resolved first: an expansion names clusters only the log can resolve, and both
  // the unknown-id and the changed-prompt refusals must happen before anything is spent.
  const sessionId =
    input.options.sessionId ?? sessions.newSessionId(IDEATION_SESSION_PREFIX, input.now());
  const opened =
    input.options.sessionId === undefined ? false : await sessions.exists(IDEATION_MODE, sessionId);
  const prior = opened ? readIdeationSession(await sessions.read(IDEATION_MODE, sessionId)) : null;

  const motion = input.options.motion?.trim();
  const prompt = prior?.prompt ?? motion;
  if (prompt === undefined || prompt.length === 0) {
    throw new Error('ideate opens a room on a prompt: pass a non-blank --motion "<text>"');
  }
  if (prior !== null && motion !== undefined && motion !== prior.prompt) {
    throw new Error(
      'This session was opened on a different prompt; open a new session to ideate on another one',
    );
  }

  const expansion = expand === undefined ? null : expansionScope(expand, prior);
  const scope: PassScope = expansion === null ? 'all' : expansion.clusters;
  const scoped = expansion?.scoped ?? [];

  const named = await namedLenses(input);
  const seatCount = integerValue(
    input.flags,
    'seats',
    named?.length ?? DEFAULT_SEATS,
    1,
    MAX_SEATS,
  );
  const lenses = resolveSeatLenses({ seats: seatCount, named });

  // Personas and earlier ideas are payloads the CLI could not see at preflight, so they go through
  // the same outbound policy before any of them reaches a provider.
  const decision = input.guard([
    prompt,
    ...lenses.map((lens) => lens.description),
    ...scoped.map((idea) => idea.text),
  ]);
  if (decision.kind === 'blocked') {
    return {
      kind: 'blocked',
      status: 'blocked-policy',
      message: 'An ideation payload was blocked by the outbound data policy.',
      decision,
    };
  }

  const registry = ideationRegistry(
    input.context.registry,
    parseModelOverrides(oneValue(input.flags, 'models')),
  );
  const seats = ideationSeats({
    families: input.options.providerFamilies,
    lenses,
    registry,
  });
  // The CLI already built the ledger this session must spend from — sized from `--spend-cap` or
  // from `ideation.spend.defaultCap`, applied to the family count the CLI knew about before this
  // mode ever resolved a seat. Handing it to the panel unbuilt keeps the cap the caller asked for
  // and the cap the envelope reports the same ledger, rather than two numbers that happen to agree
  // in tests and drift apart the day a caller passes `--spend-cap` and this mode ignores it.
  const panel = await runPanel(
    { adapters: input.adapters, context: { ...input.context, registry } },
    {
      seats,
      prompt: (seat) => ideationPrompt({ lens: seat.lens, prompt, ideasPerSeat, scoped }),
      answer: ideationAnswer(ideasPerSeat),
      spend: input.spend,
    },
  );

  // What the seats offered, still without ids. Numbering them here would number them from the read
  // above, which is already stale by the time the panel returns.
  const offered: { seat: string; lens: string; text: string }[] = [];
  const invalid: { seat: string; raw: string }[] = [];
  for (const seat of panel.seats) {
    if (seat.status === 'invalid') invalid.push({ seat: seat.id, raw: seat.raw });
    if (seat.status !== 'ok') continue;
    for (const idea of seat.answer.ideas.slice(0, ideasPerSeat)) {
      offered.push({ seat: seat.id, lens: seat.lens, text: idea.text });
    }
  }

  const at = input.now();
  const envelopeSeats = panelEnvelopeSeats(panel.seats);
  // The derivation carries its output out through this list. It runs inside the store's write lock
  // and is the only place the pass is settled, so recomputing the output beside it from the read
  // above would be recomputing it from a log that may already have moved.
  const derived: IdeationOutput[] = [];
  // Everything that reads the log is decided in here: the idea numbering, the pass number, the
  // clustering over every idea the session holds, and the prompt this session was opened on. Two
  // `ideate` calls on one session would otherwise both derive from the same stale read, mint
  // overlapping idea ids, and leave a log `readIdeationSession` refuses to read back at all — so
  // the session could never again be expanded, read or rendered. The panel above ran outside the
  // lock; only the part of the decision that reads the log is in here, and it is synchronous.
  const write = await sessions.appendDerived(IDEATION_MODE, sessionId, (events) => {
    const settled = events.length === 0 ? null : readIdeationSession(events);
    if (settled !== null && settled.prompt !== prompt) {
      throw new Error(
        'This session was opened on a different prompt; open a new session to ideate on another one',
      );
    }
    let number = settled?.nextIdeaNumber ?? 1;
    const ideas: Idea[] = offered.map((idea) =>
      IdeaSchema.parse({ id: `i-${number++}`, seat: idea.seat, lens: idea.lens, text: idea.text }),
    );
    // Every idea from every pass is re-grouped together, so a cluster reflects the whole session
    // rather than the pass that happened to create it.
    const clustered = clusterIdeas(
      [...(settled?.ideas ?? []), ...ideas].map((idea) => ({ id: idea.id, text: idea.text })),
      settled === null
        ? undefined
        : { clusters: settled.clusters, nextClusterNumber: settled.nextClusterNumber },
    );
    const n = (settled?.passes.length ?? 0) + 1;
    const appended: ModeSessionEvent[] = [
      {
        at,
        kind: PASS_EVENT_KIND,
        data: IdeationPassEventSchema.parse({
          ...IdeationPassSchema.parse({ n, scope, ideas }),
          prompt,
          ideasPerSeat,
          seats: envelopeSeats,
          invalid,
        }),
      },
      {
        at,
        kind: CLUSTER_EVENT_KIND,
        data: IdeationClusterEventSchema.parse({
          n,
          clusters: clustered.clusters,
          nextClusterNumber: clustered.nextClusterNumber,
        }),
      },
    ];
    // The output is the session rebuilt from the log as it will stand once these two lines land,
    // and it is built and parsed before either of them is written. Validating it after the writes
    // — which is what this used to do — meant an output the schema refused had already been
    // recorded: the caller was told the pass failed while the log said it had happened.
    derived.push(
      IdeationOutputSchema.parse(ideationOutput(readIdeationSession([...events, ...appended]))),
    );
    return appended;
  });
  const output = derived.at(-1);
  if (output === undefined) throw new Error('The ideation pass was never derived');

  const unanswered = seats.length - panel.answered;
  const degraded = unanswered === 0 ? [] : [`seats-unanswered: ${unanswered}`];
  return {
    kind: 'result',
    status: degraded.length === 0 ? 'completed' : 'degraded',
    session: sessionId,
    pattern: 'parallel',
    // One blind pass per invocation. A session's passes live in `output.passes`: the envelope caps
    // `rounds` at three and a session may run more passes than that.
    rounds: 1,
    seats: panelEnvelopeSeats(panel.seats),
    output,
    // Ideation never compares positions, so there is nothing to synthesise, nothing to record as
    // dissent, and unanimity is not a question this mode can ask.
    synthesis: null,
    dissent: null,
    unanimous: false,
    degraded,
    spend: panel.spend,
    record: {
      session: sessions.recordPath(IDEATION_MODE, sessionId),
      // Both lines land on the same file in one write; the CLI commits a path list.
      paths: write.paths,
    },
  };
}

export const ideation: HandlerModeDefinition = {
  kind: 'handler',
  name: 'ideation',
  knobs: {
    participants: 'many cheap seats, one catalogue lens or supplied persona each, families spread',
    pattern: 'parallel',
    aggregation: "deterministic clusters labelled as the engine's grouping; never ranked",
    tempo: 'minutes',
    records: 'every idea from every pass, and the cluster labels',
  },
  pattern: 'parallel',
  spend: {
    policy: 'capped',
    // Called by the CLI with the eligible family count and one pass, before this mode has resolved
    // its lenses into seats — so this is sized on families, not seats, and the round count plays no
    // part in it. The ledger it sizes is one global counter, not one per family: the cap is at most
    // `families` metered calls per pass in total, whatever mix of families spends them. A family
    // count is simply the size chosen for it, on the reasoning that a room should not pay metered
    // rates more often than it has families to fall back on.
    defaultCap: (families: number) => families,
  },
  flags: {
    value: ['seats', 'lenses', 'personas', 'ideas-per-seat', 'models', 'expand'],
    boolean: [],
  },
  outputSchema: IdeationOutputSchema,
  handle,
};
