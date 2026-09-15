import { z } from 'zod';
import {
  EVIDENCE_BOUNDARY_INSTRUCTION,
  panelEnvelopeSeats,
  runPanel,
  untrustedBlock,
  type PanelAnswer,
  type PanelLens,
} from '../../substrate';
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
  PASS_EVENT_KIND,
  readIdeationSession,
  type Idea,
  type IdeationSessionState,
  type PassScope,
} from './session';

const DEFAULT_SEATS = 12;
/**
 * The panel dispatches every seat at once and has no pool, so this is what one machine can hold
 * open rather than a view about how large a room should be. Raising it needs pooling first.
 */
const MAX_SEATS = 24;
const DEFAULT_IDEAS_PER_SEAT = 3;
const MAX_IDEAS_PER_SEAT = 10;

type Flags = HandlerInput['flags'];

function oneValue(flags: Flags, name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

function integerValue(
  flags: Flags,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = oneValue(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Option --${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function listValue(flags: Flags, name: string): string[] | undefined {
  const raw = oneValue(flags, name);
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) throw new Error(`Option --${name} needs at least one value`);
  return items;
}

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
  if (prompt === undefined || prompt.length === 0)
    throw new Error('A non-blank motion is required');
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

  let number = prior?.nextIdeaNumber ?? 1;
  const ideas: Idea[] = [];
  const invalid: { seat: string; raw: string }[] = [];
  for (const seat of panel.seats) {
    if (seat.status === 'invalid') invalid.push({ seat: seat.id, raw: seat.raw });
    if (seat.status !== 'ok') continue;
    for (const idea of seat.answer.ideas.slice(0, ideasPerSeat)) {
      ideas.push(
        IdeaSchema.parse({ id: `i-${number}`, seat: seat.id, lens: seat.lens, text: idea.text }),
      );
      number += 1;
    }
  }

  const allIdeas = [...(prior?.ideas ?? []), ...ideas];
  // Every idea from every pass is re-grouped together, so a cluster reflects the whole session
  // rather than the pass that happened to create it.
  const clustered = clusterIdeas(
    allIdeas.map((idea) => ({ id: idea.id, text: idea.text })),
    prior === null
      ? undefined
      : { clusters: prior.clusters, nextClusterNumber: prior.nextClusterNumber },
  );

  const passNumber = (prior?.passes.length ?? 0) + 1;
  const pass = { n: passNumber, scope, ideas };
  const at = input.now();
  const passWrite = await sessions.append(IDEATION_MODE, sessionId, {
    at,
    kind: PASS_EVENT_KIND,
    data: IdeationPassEventSchema.parse({
      ...pass,
      prompt,
      ideasPerSeat,
      seats: panelEnvelopeSeats(panel.seats),
      invalid,
    }),
  });
  const clusterWrite = await sessions.append(IDEATION_MODE, sessionId, {
    at,
    kind: CLUSTER_EVENT_KIND,
    data: IdeationClusterEventSchema.parse({
      n: passNumber,
      clusters: clustered.clusters,
      nextClusterNumber: clustered.nextClusterNumber,
    }),
  });

  const output: Record<string, unknown> = {
    prompt,
    passes: [...(prior?.passes ?? []), pass],
    clusters: clustered.clusters,
    raw: allIdeas.map((idea) => idea.id),
  };
  // Parsed here as well as by the CLI: a mode that cannot satisfy its own schema should fail where
  // the defect is, not two layers up.
  IdeationOutputSchema.parse(output);

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
      // Both appends land on the same file; the CLI commits a path list, not a write list.
      paths: [...new Set([...passWrite.paths, ...clusterWrite.paths])],
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
    // its lenses into seats — so this is sized on families, not seats. Every seat sharing a family
    // shares that family's metered credential, so one refusal per family bounds what a pass can
    // spend regardless of how many lenses land on it, and the round count plays no part in that.
    defaultCap: (families: number) => families,
  },
  flags: {
    value: ['seats', 'lenses', 'personas', 'ideas-per-seat', 'models', 'expand'],
    boolean: [],
  },
  outputSchema: IdeationOutputSchema,
  handle,
};
