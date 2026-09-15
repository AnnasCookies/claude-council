import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  MAX_ENVELOPE_ROUNDS,
  createSpendLedger,
  newModeSessionId,
  panelEnvelopeSeats,
  roleCatalogue,
  runPanel,
  spreadSeats,
  type BillingMode,
  type PanelLens,
  type PanelResult,
  type PanelSeat,
  type PanelSpend,
  type ProviderContext,
  type Spend,
  type SpendLedger,
} from '../../substrate';
import type { HandlerInput, HandlerModeDefinition, HandlerOutcome } from '../types';
import { forumOpeningAnswer, forumReplyAnswer, openingAsAnswer, type ForumAnswer } from './answers';
import {
  ForumOutputSchema,
  aggregateForum,
  collectMotions,
  type ForumRoundRecord,
} from './aggregate';
import { buildOpeningPrompt, buildReplyPrompt } from './prompts';

const MODE = 'forum';
const SESSION_PREFIX = 'fo';
const DEFAULT_SEATS = 6;
const MIN_SEATS = 2;
const MAX_SEATS = 24;
const DEFAULT_ROUNDS = 3;
const MIN_ROUNDS = 1;

/** One metered fallback per seat per round, which is the cap every capped mode defaults to. */
function forumDefaultCap(seats: number, rounds: number): number {
  return seats * rounds;
}

function oneValue(flags: HandlerInput['flags'], name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

function integerValue(
  flags: HandlerInput['flags'],
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

/** Catalogue names carry spaces and apostrophes; a lens name on a seat is a slug. */
function lensSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function catalogueLenses(requested: string | undefined): PanelLens[] {
  const available = roleCatalogue.map((lens) => ({
    name: lensSlug(lens.name),
    description: lens.prompt,
  }));
  if (requested === undefined) return available;
  const names = [
    ...new Set(
      requested
        .split(',')
        .map((name) => lensSlug(name.trim()))
        .filter((name) => name.length > 0),
    ),
  ];
  if (names.length === 0) throw new Error('Option --lenses needs at least one lens name');
  return names.map((name) => {
    const lens = available.find((candidate) => candidate.name === name);
    if (lens === undefined) {
      throw new Error(
        `Unknown lens: ${name}. Catalogue lenses: ${available.map((entry) => entry.name).join(', ')}`,
      );
    }
    return lens;
  });
}

const SuppliedPersonasSchema = z
  .array(
    z.strictObject({
      name: z.string().trim().min(1).max(64),
      description: z.string().trim().min(1).max(2_000),
    }),
  )
  .min(1)
  .max(MAX_SEATS);

async function suppliedPersonas(path: string, cwd: string): Promise<PanelLens[]> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  let value: unknown;
  try {
    value = await Bun.file(absolute).json();
  } catch (error) {
    throw new Error(
      `Unable to read the personas file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lenses = SuppliedPersonasSchema.parse(value).map((persona) => ({
    name: lensSlug(persona.name),
    description: persona.description,
  }));
  if (new Set(lenses.map((lens) => lens.name)).size !== lenses.length) {
    throw new Error('Persona names must stay distinct once they are slugged into lens names');
  }
  return lenses;
}

/**
 * Seats may outnumber the lens list, so the list is dealt round and round. A repeat is a distinct
 * seat holding the same brief and says so in its name (`critic-2`), which is also what keeps seat
 * ids unique when the same lens lands on the same family twice.
 */
function cycleLenses(base: readonly PanelLens[], seats: number): PanelLens[] {
  const first = base[0];
  if (first === undefined) throw new Error('A forum needs at least one lens');
  return Array.from({ length: seats }, (_, index) => {
    const lens = base[index % base.length] ?? first;
    const cycle = Math.floor(index / base.length) + 1;
    return cycle === 1 ? lens : { name: `${lens.name}-${cycle}`, description: lens.description };
  });
}

interface ForumRoundOutcome {
  readonly record: ForumRoundRecord;
  readonly seats: readonly PanelSeat<unknown>[];
  readonly spend: Spend;
  readonly answered: number;
}

function collectRound<TAnswer>(
  n: number,
  panel: PanelResult<TAnswer>,
  widen: (answer: TAnswer) => ForumAnswer,
): ForumRoundOutcome {
  const answers = panel.seats.flatMap((seat) =>
    seat.status === 'ok' ? [{ seat: seat.id, answer: widen(seat.answer) }] : [],
  );
  return {
    record: { n, answers },
    seats: panel.seats,
    spend: panel.spend,
    answered: panel.answered,
  };
}

/**
 * The panel reports one round's spend at a time; the cap is a session budget, so the calls are
 * summed across the rounds and the refusals are read from the shared ledger.
 */
function aggregateSpend(
  perRound: readonly Spend[],
  ledger: SpendLedger,
  billing: BillingMode,
): Spend {
  return {
    billing,
    policy: 'capped',
    cap: ledger.cap,
    used: perRound.reduce((total, spend) => total + spend.used, 0),
    fallbacks: perRound.reduce((total, spend) => total + spend.fallbacks, 0),
    refused: ledger.refused,
    stoppedAtCap: ledger.refused > 0,
  };
}

/**
 * The CLI cannot size a handler mode's ledger correctly on its own: it builds one from
 * `--spend-cap` when given, and otherwise from `defaultCap(eligibleFamilies, 1)`, because it does
 * not know how many rounds the forum will run. A round count above one therefore under-caps a
 * ledger the CLI sized for one round, so the forum rebuilds its own — sized on the same eligible
 * roster but the real round count — whenever the caller left the cap to the default. An explicit
 * `--spend-cap` is the caller's own number and is never second-guessed: it is passed straight
 * through, ledger and all, so the cap the caller asked for is the cap that is enforced.
 */
function resolveSpend(
  input: HandlerInput,
  roundCount: number,
): Extract<PanelSpend, { policy: 'capped' }> {
  if (input.spend.policy !== 'capped') {
    throw new Error('forum is a capped mode; it cannot run under a never-metered spend policy');
  }
  if (input.options.spendCap !== undefined) return input.spend;
  return {
    policy: 'capped',
    billing: input.spend.billing,
    ledger: createSpendLedger(
      forumDefaultCap(input.options.eligibleProviderFamilies.length, roundCount),
    ),
  };
}

async function handle(input: HandlerInput): Promise<HandlerOutcome> {
  const motion = input.options.motion;
  if (motion === undefined) {
    throw new Error('forum requires --motion "<the motion the forum argues>"');
  }
  if (input.flags.has('lenses') && input.flags.has('personas')) {
    throw new Error('Use --lenses or --personas, not both: a seat carries one brief');
  }
  const seatCount = integerValue(input.flags, 'seats', DEFAULT_SEATS, MIN_SEATS, MAX_SEATS);
  const roundCount = integerValue(
    input.flags,
    'rounds',
    DEFAULT_ROUNDS,
    MIN_ROUNDS,
    MAX_ENVELOPE_ROUNDS,
  );
  const personasPath = oneValue(input.flags, 'personas');
  const briefs =
    personasPath === undefined
      ? catalogueLenses(oneValue(input.flags, 'lenses'))
      : await suppliedPersonas(personasPath, input.context.cwd);
  if (personasPath !== undefined) {
    // The CLI's preflight saw the motion. A personas file is text only this mode has read, and it
    // reaches every provider inside the prompt, so it goes through the same outbound policy.
    const decision = input.guard(briefs.map((lens) => lens.description));
    if (decision.kind === 'blocked') {
      return {
        kind: 'blocked',
        status: 'blocked-policy',
        message: 'The supplied personas were refused by the outbound data policy.',
        decision,
      };
    }
  }

  const seats = spreadSeats(
    input.options.providerFamilies,
    cycleLenses(briefs, seatCount),
    input.context.registry,
  );
  const session = input.options.sessionId ?? newModeSessionId(SESSION_PREFIX, input.now());
  if (input.sessions !== null && (await input.sessions.exists(MODE, session))) {
    // A forum ledger is read as one argument from round one. Appending a second forum's rounds to
    // it would make its map and its moves unreadable, so the id is refused rather than reused.
    throw new Error(
      `A forum session log already exists at ${input.sessions.recordPath(MODE, session)}; choose another --session id`,
    );
  }

  const spend = resolveSpend(input, roundCount);
  const ledger = spend.ledger;
  const context: ProviderContext = {
    ...input.context,
    // The whole-run budget is divided per round exactly as the council runner divides it, so a
    // long first round cannot leave the later rounds with nothing to spend.
    timeoutMs: Math.max(1, Math.floor(input.options.timeoutMs / roundCount)),
  };
  const config = { adapters: input.adapters, context };

  const paths = new Set<string>();
  const append = async (kind: string, data: unknown): Promise<void> => {
    if (input.sessions === null) return;
    const write = await input.sessions.append(MODE, session, { at: input.now(), kind, data });
    for (const path of write.paths) paths.add(path);
  };

  await append('opened', {
    motion,
    rounds: roundCount,
    cap: ledger.cap,
    billing: input.options.billingMode,
    seats: seats.map((seat) => ({
      id: seat.id,
      family: seat.family,
      model: seat.model,
      lens: seat.lens.name,
    })),
  });

  const rounds: ForumRoundRecord[] = [];
  const perRoundSpend: Spend[] = [];
  let lastSeats: readonly PanelSeat<unknown>[] = [];
  let missingAnswers = false;
  let stopped: 'round-limit' | 'spend-cap' | 'no-opening-positions' = 'round-limit';

  for (let n = 1; n <= roundCount; n += 1) {
    let round: ForumRoundOutcome;
    if (n === 1) {
      const panel = await runPanel(config, {
        seats,
        prompt: (seat) => buildOpeningPrompt({ seat, motion, round: n, totalRounds: roundCount }),
        answer: forumOpeningAnswer,
        spend,
      });
      round = collectRound(n, panel, openingAsAnswer);
    } else {
      const motions = collectMotions(rounds);
      const priorRounds = [...rounds];
      const panel = await runPanel(config, {
        seats,
        prompt: (seat) =>
          buildReplyPrompt({
            seat,
            motion,
            round: n,
            totalRounds: roundCount,
            priorRounds,
            motions,
          }),
        answer: forumReplyAnswer,
        spend,
      });
      round = collectRound(n, panel, (answer: ForumAnswer) => answer);
    }

    rounds.push(round.record);
    perRoundSpend.push(round.spend);
    lastSeats = round.seats;
    if (round.answered < seats.length) missingAnswers = true;
    await append('round', { n, seats: round.seats, answers: round.record.answers });

    if (round.spend.stoppedAtCap) {
      stopped = 'spend-cap';
      break;
    }
    if (n === 1 && round.record.answers.length === 0) {
      // Nobody opened, so there is nothing for a later round to answer: spending on one would buy
      // a second blind round under a prompt that claims otherwise.
      stopped = 'no-opening-positions';
      break;
    }
  }

  await append('closed', { rounds: rounds.length, reason: stopped });

  const degraded: string[] = [];
  if (rounds.length < roundCount) {
    degraded.push(`rounds-not-completed: ran ${rounds.length} of ${roundCount}`);
  }
  if (stopped === 'no-opening-positions') degraded.push('no-opening-positions');
  if (missingAnswers) degraded.push('seat-answers-missing');
  if (input.sessions === null) {
    // A forum with nowhere to write is still worth running, but nothing survives the process: the
    // ledger of positions the mode exists to keep is gone the moment it exits, so that is degraded
    // rather than a silent `completed`.
    degraded.push('records-not-kept: no records root is configured');
  }

  return {
    kind: 'result',
    status: degraded.length === 0 ? 'completed' : 'degraded',
    session,
    pattern: 'rounds',
    rounds: rounds.length,
    seats: panelEnvelopeSeats(lastSeats),
    output: aggregateForum({ seats: seats.map((seat) => seat.id), rounds }),
    // The forum rules on nothing: no synthesis, no dissent list, and no unanimity. Every position
    // is kept attributed in `rounds` and grouped, unranked, in `map`.
    synthesis: null,
    dissent: null,
    unanimous: false,
    degraded,
    spend: aggregateSpend(perRoundSpend, ledger, input.options.billingMode),
    record: {
      session: input.sessions === null ? null : input.sessions.recordPath(MODE, session),
      paths: [...paths],
    },
  };
}

export const forum: HandlerModeDefinition = {
  kind: 'handler',
  name: 'forum',
  knobs: {
    participants: 'many seats across families and lenses; no quorum, no chair',
    pattern: 'rounds',
    aggregation: 'position map, who moved and why, motions with support and opposition',
    tempo: 'long',
    records: 'the full ledger of every round',
  },
  pattern: 'rounds',
  spend: { policy: 'capped', defaultCap: forumDefaultCap },
  flags: { value: ['seats', 'rounds', 'lenses', 'personas'], boolean: [] },
  outputSchema: ForumOutputSchema,
  handle,
};
