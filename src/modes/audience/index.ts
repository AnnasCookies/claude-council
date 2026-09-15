import { z } from 'zod';
import {
  PanelLensSchema,
  newModeSessionId,
  panelEnvelopeSeats,
  runPanel,
  spreadSeats,
  type ModelRegistry,
  type PanelLens,
  type PanelSeat,
  type ProviderFamily,
} from '../../substrate';
import type { HandlerInput, HandlerModeDefinition, HandlerOutcome } from '../types';
import { readDraft, type AudienceDraft } from './draft';
import { MAX_PERSONAS, parsePersonaList, readPersonaFile } from './personas';
import {
  AUDIENCE_ANSWER,
  MAX_QUOTE_LENGTH,
  buildReactionPrompt,
  truncateQuote,
  type AudienceReaction,
} from './reaction';
import { AudienceTalliesSchema, tallyReactions } from './tally';

// The same lens-name rule `PanelLensSchema` already enforces on every persona; reused rather than
// duplicated so the two never drift apart.
const PersonaNameSchema = PanelLensSchema.shape.name;
const NonEmptyStringSchema = z.string().trim().min(1);

/**
 * The shape docs/modes.md specifies for this mode, and nothing beyond it: the draft by path and
 * hash, the personas as supplied, one reaction per answering seat, and counts. `tallies` holds
 * every number the mode produces, which is what keeps "no model estimates a percentage" checkable
 * rather than merely stated.
 */
export const AudienceOutputSchema = z.strictObject({
  draft: z.strictObject({
    path: NonEmptyStringSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  personas: z.array(PersonaNameSchema).min(1).max(MAX_PERSONAS),
  reactions: z.array(
    z.strictObject({
      persona: PersonaNameSchema,
      seat: NonEmptyStringSchema,
      fields: z.strictObject({
        clear: z.boolean(),
        wouldAct: z.boolean(),
        stoppedAt: z.string(),
      }),
      quote: NonEmptyStringSchema.max(MAX_QUOTE_LENGTH),
    }),
  ),
  tallies: AudienceTalliesSchema,
});
export type AudienceOutput = z.infer<typeof AudienceOutputSchema>;

function oneFlag(flags: HandlerInput['flags'], name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

async function resolvePersonas(input: HandlerInput, cwd: string): Promise<PanelLens[]> {
  const list = oneFlag(input.flags, 'personas');
  const file = oneFlag(input.flags, 'personas-file');
  if (list !== undefined && file !== undefined) {
    throw new Error('audience takes either --personas or --personas-file, not both');
  }
  if (list !== undefined) return parsePersonaList(list);
  if (file !== undefined) return readPersonaFile(file, cwd);
  throw new Error('audience requires --personas <list> or --personas-file <path>');
}

/** --question, else the common --motion, else nothing: the draft on its own is a valid brief. */
function resolveQuestion(input: HandlerInput): string | undefined {
  const question = oneFlag(input.flags, 'question')?.trim();
  if (question !== undefined && question.length > 0) return question;
  const motion = input.options.motion?.trim();
  return motion === undefined || motion.length === 0 ? undefined : motion;
}

function hasSubscriptionRoute(registry: ModelRegistry, family: ProviderFamily): boolean {
  const route = registry[family];
  return [route.transport, ...(route.alternateTransports ?? [])].some(
    (transport) => transport !== 'http',
  );
}

interface Seating {
  readonly families: readonly ProviderFamily[];
  readonly unseated: readonly ProviderFamily[];
}

/**
 * `never-metered` disables the credential fallback but does not refuse a family whose only route
 * is metered, so a DeepSeek or Moonshot seat here could only ever be skipped. Seating one would
 * cost a persona its voice for nothing, so those families are left out and named in `degraded`:
 * the run reports which voices it declined to seat instead of reporting them mysteriously absent.
 */
function resolveSeating(input: HandlerInput): Seating {
  const selected = input.options.providerFamilies;
  const families = selected.filter((family) =>
    hasSubscriptionRoute(input.context.registry, family),
  );
  if (families.length === 0) {
    throw new Error(
      'audience runs on subscription transports only; choose --providers families with a subscription route',
    );
  }
  return { families, unseated: selected.filter((family) => !families.includes(family)) };
}

function reactionEventData(seat: PanelSeat<AudienceReaction>): Record<string, unknown> {
  const base = { persona: seat.lens, seat: seat.id, family: seat.family, status: seat.status };
  if (seat.status === 'ok') {
    return {
      ...base,
      fields: {
        clear: seat.answer.clear,
        wouldAct: seat.answer.wouldAct,
        stoppedAt: seat.answer.stoppedAt,
      },
      quote: truncateQuote(seat.answer.quote),
    };
  }
  return { ...base, code: seat.code, reason: seat.reason };
}

/**
 * The draft event opens the log, so whoever reads the record knows what was read before they read
 * what anyone said about it, and one reaction event follows per seat in seat order — including the
 * seats that did not answer, because a missing voice is part of the record. The appends are
 * sequential: the store serialises concurrent writes but does not order them.
 */
async function recordReactions(
  input: HandlerInput,
  session: string,
  draft: AudienceDraft,
  seats: readonly PanelSeat<AudienceReaction>[],
): Promise<string[]> {
  const sessions = input.sessions;
  if (sessions === null) return [];
  const written = new Set<string>();
  const draftWrite = await sessions.append('audience', session, {
    at: input.now(),
    kind: 'draft',
    data: { path: draft.path, sha256: draft.sha256 },
  });
  for (const path of draftWrite.paths) written.add(path);
  for (const seat of seats) {
    const write = await sessions.append('audience', session, {
      at: input.now(),
      kind: 'reaction',
      data: reactionEventData(seat),
    });
    for (const path of write.paths) written.add(path);
  }
  return [...written];
}

async function handle(input: HandlerInput): Promise<HandlerOutcome> {
  const cwd = input.context.cwd;
  const personas = await resolvePersonas(input, cwd);
  const draftPath = oneFlag(input.flags, 'draft');
  if (draftPath === undefined) throw new Error('audience requires --draft <path>');
  const draft = await readDraft(draftPath, cwd);
  const question = resolveQuestion(input);

  // The draft, the personas and the question are all payloads the CLI could not see at its own
  // preflight, so every one of them goes through the same outbound guard before a single seat is
  // invoked: a high-confidence secret in a persona file is a blocked run, not a prompt the panel
  // discovers and fails on mid-dispatch.
  const decision = input.guard([
    draft.text,
    ...(question === undefined ? [] : [question]),
    ...personas.flatMap((persona) => [persona.name, persona.description]),
  ]);
  if (decision.kind === 'blocked') {
    return {
      kind: 'blocked',
      status: 'blocked-policy',
      message: `The draft at ${draft.path} was refused by the outbound policy: ${decision.reasonCodes.join(', ')}`,
      decision,
    };
  }

  const seating = resolveSeating(input);
  const seats = spreadSeats(seating.families, personas, input.context.registry);
  const session = input.options.sessionId ?? newModeSessionId('au', input.now());
  if (
    input.options.sessionId !== undefined &&
    input.sessions !== null &&
    (await input.sessions.exists('audience', session))
  ) {
    // This mode is single-shot: one draft, one round, one log. Appending a second draft's
    // reactions to an existing log would leave `draft` events the reader cannot tell apart, so a
    // reused id is refused before any provider is called rather than silently appended to.
    throw new Error(
      `An audience session log already exists at ${input.sessions.recordPath('audience', session)}; choose another --session id`,
    );
  }
  const panel = await runPanel(
    { adapters: input.adapters, context: input.context },
    {
      seats,
      prompt: (seat) =>
        buildReactionPrompt({
          persona: seat.lens,
          draftText: draft.text,
          ...(question === undefined ? {} : { question }),
        }),
      answer: AUDIENCE_ANSWER,
      // The CLI built this from the mode's own `never-metered` policy; the mode never assembles
      // its own ledger, so the spend this panel is held to and the spend the envelope reports are
      // always the same object.
      spend: input.spend,
    },
  );

  const reactions = panel.seats.flatMap((seat) =>
    seat.status === 'ok'
      ? [
          {
            persona: seat.lens,
            seat: seat.id,
            fields: {
              clear: seat.answer.clear,
              wouldAct: seat.answer.wouldAct,
              stoppedAt: seat.answer.stoppedAt,
            },
            quote: truncateQuote(seat.answer.quote),
          },
        ]
      : [],
  );
  const output: AudienceOutput = {
    draft: { path: draft.path, sha256: draft.sha256 },
    // Straight from the call, never from the answers. A reader who did not answer is still one of
    // the readers this draft was put in front of, and the tallies say how many of them answered.
    personas: personas.map((persona) => persona.name),
    reactions,
    tallies: tallyReactions(reactions.map((reaction) => reaction.fields)),
  };

  const paths = await recordReactions(input, session, draft, panel.seats);

  const degraded: string[] = [];
  if (seating.unseated.length > 0) {
    degraded.push(`metered-only-families-unseated: ${seating.unseated.join(', ')}`);
  }
  if (panel.answered < seats.length) degraded.push('missing-voices');
  if (input.sessions === null) degraded.push('records-not-kept: no records root is configured');

  return {
    kind: 'result',
    // As every other handler mode derives it: any entry in `degraded` — a missing voice, a
    // metered-only family left unseated, or records this run could not keep — is a degraded run,
    // not just a short one.
    status: degraded.length === 0 ? 'completed' : 'degraded',
    session,
    pattern: 'parallel',
    rounds: 1,
    seats: panelEnvelopeSeats(panel.seats),
    output,
    // This mode counts; it does not synthesise. Agreement between readers is already in the
    // tallies, where a reader can check it against the reactions beside them, and unanimity is a
    // synthesis signal that would add nothing but a claim.
    synthesis: null,
    dissent: null,
    unanimous: false,
    degraded,
    spend: panel.spend,
    record: {
      session: input.sessions === null ? null : input.sessions.recordPath('audience', session),
      paths,
    },
  };
}

export const audience: HandlerModeDefinition = {
  kind: 'handler',
  name: 'audience',
  knobs: {
    participants: 'many cheap seats, one supplied persona each',
    pattern: 'parallel',
    aggregation: 'counts of the structured fields, and verbatim attributed quotes',
    tempo: 'minutes',
    records: 'the reactions with the draft hash',
  },
  pattern: 'parallel',
  spend: { policy: 'never-metered', defaultCap: () => 0 },
  flags: { value: ['draft', 'personas', 'personas-file', 'question'], boolean: [] },
  outputSchema: AudienceOutputSchema,
  handle,
};
