import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  ModeSessionIdSchema,
  ProviderFamilySchema,
  type EnvelopeSeat,
  type ModeSessionStore,
  type ProviderFamily,
  type Spend,
} from '../../substrate';
import type { HandlerInput, HandlerModeDefinition, HandlerOutcome } from '../types';
import {
  AdvisorNoteSchema,
  HARNESS_NAME_PATTERN,
  HeededSchema,
  NOTE_TEXT_LIMIT,
  NoteIdSchema,
  QUESTION_EXCERPT_LIMIT,
  RISK_CLASSES,
  RiskClassSchema,
  TOOL_CALL_EXCERPT_LIMIT,
  cadenceDue,
  nextNoteId,
  readAdvisorLog,
  safeExcerpt,
  type AdvisorLog,
  type AdvisorNote,
  type NoteTrigger,
  type RiskClass,
} from './notes';
import {
  NEVER_METERED_SPEND,
  advisorPrompt,
  consultSeat,
  selectSeatFamily,
  subscriptionFamilies,
} from './seat';

export const ADVISOR_MODE = 'advisor';
const SESSION_PREFIX = 'ad';
/**
 * What the envelope reports when `--status` was asked about a harness key no log is bound to.
 * The envelope's `session` is a store session id and its schema refuses an empty string, and the
 * harness key is neither: echoing it there put a foreign identifier in the field every other
 * envelope fills with an id of this engine's own making. The status block already says
 * `exists: false`, so this is a placeholder, not a fact being hidden.
 */
const UNBOUND_SESSION = 'unknown';
const DEFAULT_EVERY = 3;
const DEFAULT_WINDOW_MS = 8_000;
const MIN_WINDOW_MS = 100;
const MAX_WINDOW_MS = 60_000;
/** Cadence and ask passes stay bounded even under the CLI's twenty-minute default run timeout. */
const SEAT_CEILING_MS = 120_000;
/** The tail is what the agent is doing now; an unbounded window would cost a whole session per pass. */
const WINDOW_CHARS = 24_000;
/** How much of a `--transcript <path>` file is read at all, comfortably above `WINDOW_CHARS`. */
const WINDOW_TAIL_BYTES = 256 * 1024;

const VERBS = ['watch', 'hold', 'ask', 'heed', 'note', 'start', 'end', 'status'] as const;
type Verb = (typeof VERBS)[number];
type NoteVerb = Extract<Verb, 'watch' | 'hold' | 'ask' | 'note'>;

/** The verbs that produce a note, and so the ones whose own flags `readRequest` validates. */
function isNoteVerb(verb: Verb): verb is NoteVerb {
  return verb === 'watch' || verb === 'hold' || verb === 'ask' || verb === 'note';
}

/**
 * The only verbs that read a bare argument: `--note` takes the note text and `--heed` takes the
 * answer. `acceptsPositionals` turns the CLI's own refusal off for the whole `advise` command,
 * which is what a per-verb rule needs, so the rule has to live here — without it `advise --status
 * oops` exits 0 and silently does something other than what was typed.
 */
const POSITIONAL_VERBS: ReadonlySet<Verb> = new Set<Verb>(['note', 'heed']);

export const AdvisorOutputSchema = z.union([
  z.strictObject({ note: AdvisorNoteSchema }),
  z.strictObject({ heeded: z.strictObject({ id: NoteIdSchema, value: HeededSchema }) }),
  z.strictObject({ started: z.strictObject({ session: ModeSessionIdSchema }) }),
  z.strictObject({
    // `closed`, not `committed`: this says the log had not already ended and this call appended
    // the `ended` line. Whether the record was then committed to a repository is the CLI's own
    // step, taken after the mode returns and free to fail — a records root outside a git work
    // tree reports `record.committed: false` — so the commit fact is `record.committed` alone.
    ended: z.strictObject({ notes: z.number().int().nonnegative(), closed: z.boolean() }),
  }),
  z.strictObject({
    status: z.strictObject({
      exists: z.boolean(),
      notes: z.number().int().nonnegative(),
      last: AdvisorNoteSchema.nullable(),
    }),
  }),
]);

function oneFlag(input: HandlerInput, name: string): string | undefined {
  const values = input.flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

function requiredFlag(input: HandlerInput, name: string, usage: string): string {
  const value = oneFlag(input, name)?.trim();
  if (value === undefined || value.length === 0) throw new Error(usage);
  return value;
}

function integerFlag(
  input: HandlerInput,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = oneFlag(input, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Option --${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function verbOf(input: HandlerInput): Verb {
  const present = VERBS.filter((verb) => input.flags.has(verb));
  const [verb] = present;
  if (verb === undefined || present.length !== 1) {
    throw new Error(`advise takes exactly one of ${VERBS.map((name) => `--${name}`).join(', ')}`);
  }
  return verb;
}

interface ResolvedSession {
  readonly id: string;
  /** The harness key the id was reached through, or null when the caller passed the id itself. */
  readonly key: string | null;
  readonly exists: boolean;
}

/**
 * `--session` is the harness's own session key. A key that already is a store id is used as it
 * is; any other key goes through the alias index, which the note-producing verbs and `--start`
 * may extend and the read-only verbs may not.
 */
async function resolveSession(
  input: HandlerInput,
  sessions: ModeSessionStore,
  verb: Verb,
): Promise<ResolvedSession | null> {
  const key = input.options.sessionKey;
  if (verb === 'start' && key === undefined) {
    return { id: sessions.newSessionId(SESSION_PREFIX, input.now()), key: null, exists: false };
  }
  if (key === undefined) {
    throw new Error(
      'advise requires --session <key>: the harness session this note log belongs to',
    );
  }
  const direct = ModeSessionIdSchema.safeParse(key);
  if (direct.success) {
    return { id: direct.data, key: null, exists: await sessions.exists(ADVISOR_MODE, direct.data) };
  }
  const known = await sessions.lookupAlias(ADVISOR_MODE, key);
  if (known !== undefined) {
    return { id: known, key, exists: await sessions.exists(ADVISOR_MODE, known) };
  }
  if (verb === 'status') return null;
  if (verb === 'heed' || verb === 'end') throw new Error(`Unknown advisor session: ${key}`);
  const bound = await sessions.bindAlias(ADVISOR_MODE, key, SESSION_PREFIX, input.now());
  return { id: bound.sessionId, key, exists: false };
}

interface OutcomeInput {
  readonly session: string;
  readonly output: Record<string, unknown>;
  readonly recordPath: string | null;
  readonly seats?: readonly EnvelopeSeat[];
  readonly rounds?: number;
  readonly degraded?: readonly string[];
  readonly spend?: Spend;
  readonly paths?: readonly string[];
}

/** Every advisor verb completes: a note the seat did not give is a fact in the log, not a failure. */
function completed(input: OutcomeInput): HandlerOutcome {
  return {
    kind: 'result',
    status: 'completed',
    session: input.session,
    pattern: 'streaming',
    rounds: input.rounds ?? 0,
    seats: [...(input.seats ?? [])],
    output: input.output,
    synthesis: null,
    dissent: null,
    unanimous: false,
    degraded: [...(input.degraded ?? [])],
    spend: input.spend ?? NEVER_METERED_SPEND,
    record: { session: input.recordPath, paths: [...(input.paths ?? [])] },
  };
}

async function windowText(input: HandlerInput): Promise<string> {
  const source = requiredFlag(
    input,
    'transcript',
    'advise --watch requires --transcript - (the window on stdin) or --transcript <path>',
  );
  let text: string;
  if (source === '-') {
    if (input.stdin === undefined) {
      throw new Error('advise --watch --transcript - needs the transcript window on stdin');
    }
    text = input.stdin;
  } else {
    const path = isAbsolute(source) ? source : resolve(input.context.cwd, source);
    try {
      // Only the tail is ever used, and a harness transcript grows without bound, so the whole
      // file is never read: a hold has a window of seconds and reading hundreds of megabytes to
      // keep 24 000 characters would spend it on I/O. Slicing at a byte offset can cut a UTF-8
      // sequence in half, but the tail bound is far larger than the character bound below (a
      // character is at most four bytes, so 256 KiB is at least 65 536 characters), so the one
      // replacement character that could appear at the front is always cut off again.
      const file = Bun.file(path);
      const size = file.size;
      text = await (size > WINDOW_TAIL_BYTES ? file.slice(size - WINDOW_TAIL_BYTES) : file).text();
    } catch (error) {
      throw new Error(`Unable to read transcript window: ${source}`, { cause: error });
    }
  }
  return text.length <= WINDOW_CHARS ? text : text.slice(-WINDOW_CHARS);
}

function cadenceFamilies(input: HandlerInput): readonly ProviderFamily[] {
  const value = oneFlag(input, 'cadence-family');
  if (value === undefined) return input.options.providerFamilies;
  const parsed = ProviderFamilySchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error(`--cadence-family must be one of ${ProviderFamilySchema.options.join(', ')}`);
  }
  const family = parsed.data;
  if (!input.options.eligibleProviderFamilies.includes(family)) {
    throw new Error(`--cadence-family ${family} is not an eligible provider family`);
  }
  if (subscriptionFamilies([family], input.context.registry).length === 0) {
    throw new Error(
      `--cadence-family ${family} has no subscription transport; the advisor never spends a metered key`,
    );
  }
  return [family];
}

interface NoteRequest {
  readonly trigger: NoteTrigger;
  /** What the seat is shown; never written to the record. */
  readonly material: string;
  readonly refersTo: AdvisorNote['refersTo'];
  readonly families: readonly ProviderFamily[];
  readonly budgetMs: number;
  readonly riskClass?: RiskClass;
  readonly every?: number;
  readonly from?: string;
}

async function readRequest(verb: NoteVerb, input: HandlerInput): Promise<NoteRequest> {
  const ceiling = Math.min(input.options.timeoutMs, SEAT_CEILING_MS);
  switch (verb) {
    case 'watch':
      return {
        trigger: 'cadence',
        material: await windowText(input),
        refersTo: {},
        families: cadenceFamilies(input),
        budgetMs: ceiling,
        every: integerFlag(input, 'every', DEFAULT_EVERY, 1, 100),
      };
    case 'hold': {
      const classValue = requiredFlag(
        input,
        'class',
        `advise --hold requires --class <${RISK_CLASSES.join('|')}>`,
      );
      const riskClass = RiskClassSchema.safeParse(classValue);
      if (!riskClass.success) {
        throw new Error(`--class must be one of ${RISK_CLASSES.join(', ')}`);
      }
      const tool = requiredFlag(input, 'tool', 'advise --hold requires --tool "<text>"');
      return {
        trigger: 'hold',
        material: tool,
        refersTo: { toolCall: safeExcerpt(tool, TOOL_CALL_EXCERPT_LIMIT) },
        families: input.options.providerFamilies,
        budgetMs: integerFlag(input, 'window-ms', DEFAULT_WINDOW_MS, MIN_WINDOW_MS, MAX_WINDOW_MS),
        riskClass: riskClass.data,
      };
    }
    case 'ask': {
      const question = requiredFlag(input, 'ask', 'advise --ask requires a question');
      return {
        trigger: 'ask',
        material: question,
        refersTo: { question: safeExcerpt(question, QUESTION_EXCERPT_LIMIT) },
        families: input.options.providerFamilies,
        budgetMs: ceiling,
      };
    }
    case 'note': {
      const from = requiredFlag(input, 'from', 'advise --note requires --from <harness>');
      if (!HARNESS_NAME_PATTERN.test(from)) {
        throw new Error('--from must be a lower-case harness name such as omp');
      }
      const text = input.positionals.join(' ').trim();
      if (text.length === 0) throw new Error('advise --note requires the note text as an argument');
      return {
        trigger: 'external',
        material: text,
        refersTo: {},
        families: [],
        budgetMs: 0,
        from,
      };
    }
  }
}

interface Consulted {
  /** Everything but the id, which only the store's write lock can mint without a collision. */
  readonly note: Omit<AdvisorNote, 'id'>;
  readonly seat: EnvelopeSeat | null;
  readonly spend: Spend;
  readonly rounds: number;
}

function unserved(
  base: Pick<AdvisorNote, 'trigger' | 'refersTo' | 'at'>,
  status: 'skipped' | 'no-advice',
  reason: string,
): Consulted {
  return {
    note: { ...base, severity: 'info', text: '', heeded: 'unknown', status, reason, seat: null },
    seat: null,
    spend: NEVER_METERED_SPEND,
    rounds: 0,
  };
}

async function consult(
  input: HandlerInput,
  request: NoteRequest,
  log: AdvisorLog,
  at: string,
): Promise<Consulted> {
  const base = { trigger: request.trigger, refersTo: request.refersTo, at };
  if (request.every !== undefined && !cadenceDue(log, request.every)) {
    return unserved(base, 'skipped', 'cadence');
  }
  // The window, the tool text and a posted note all pass the same outbound guard the run
  // commands apply to a motion. A hard-blocked secret never reaches a seat or the record.
  const decision = input.guard([request.material]);
  if (decision.kind === 'blocked') {
    // What the guard refused does not reach the record either. The excerpt in `base.refersTo` was
    // cut from the very text it blocked, so the note keeps the reason and drops the excerpt: a
    // note that reads "policy: high-confidence-secret-detected" and then quotes the secret is the
    // leak the guard exists to prevent, and the log outlives the run.
    return unserved(
      { ...base, refersTo: {} },
      'skipped',
      `policy: ${decision.reasonCodes.join(', ')}`,
    );
  }
  if (request.trigger === 'external') {
    return {
      note: {
        ...base,
        severity: 'info',
        text: safeExcerpt(request.material, NOTE_TEXT_LIMIT),
        heeded: 'unknown',
        status: 'ok',
        reason: null,
        seat: request.from ?? null,
      },
      seat: null,
      spend: NEVER_METERED_SPEND,
      rounds: 0,
    };
  }
  const selection = await selectSeatFamily(request.families, input.adapters, input.context);
  if (selection.family === null) return unserved(base, 'skipped', selection.reason);
  // `input.spend` is deliberately not forwarded: `consultSeat` builds its own
  // `{ policy: 'never-metered' }` for `runPanel`, so "the advisor never spends a metered key" is
  // a property of the mode itself rather than of whatever spend the caller happened to assemble.
  const consultation = await consultSeat({
    family: selection.family,
    adapters: input.adapters,
    context: input.context,
    prompt: advisorPrompt({
      trigger: request.trigger,
      material: request.material,
      ...(request.riskClass === undefined ? {} : { riskClass: request.riskClass }),
      ...(request.trigger === 'hold' ? { budgetMs: request.budgetMs } : {}),
    }),
    budgetMs: request.budgetMs,
  });
  return {
    note: {
      ...base,
      severity: consultation.severity,
      text: consultation.text,
      heeded: 'unknown',
      status: consultation.status,
      reason: consultation.reason,
      seat: consultation.seatId,
    },
    seat: consultation.seat,
    spend: consultation.spend,
    rounds: 1,
  };
}

/**
 * What the envelope reports as degraded about a note. A cadence skip is not on the list: the
 * whole point of `--every N` is that N-1 calls in N do not consult a seat, so reporting it would
 * mark two of every three `--watch` calls degraded and leave the field saying nothing about the
 * runs that really were. A seat that was unavailable, refused or silent still is degradation.
 */
function degradationOf(note: AdvisorNote): readonly string[] {
  if (note.status === 'ok' || note.reason === 'cadence') return [];
  return [`note-${note.status}: ${note.reason ?? 'unknown'}`];
}

async function handle(input: HandlerInput): Promise<HandlerOutcome> {
  const sessions = input.sessions;
  if (sessions === null) {
    throw new Error('advise requires --records-root: the note log is the record');
  }
  const verb = verbOf(input);
  if (input.positionals.length > 0 && !POSITIONAL_VERBS.has(verb)) {
    throw new Error(`advise --${verb} accepts options only`);
  }
  // A note verb's own flags are read before the session is resolved, because resolving a harness
  // key binds an alias: a request about to be refused for a missing --tool or an unknown --class
  // must not leave a minted session id bound to the key behind it.
  const request = isNoteVerb(verb) ? await readRequest(verb, input) : null;
  const session = await resolveSession(input, sessions, verb);
  if (session === null) {
    return completed({
      session: UNBOUND_SESSION,
      output: { status: { exists: false, notes: 0, last: null } },
      recordPath: null,
    });
  }
  const log = readAdvisorLog(session.exists ? await sessions.read(ADVISOR_MODE, session.id) : []);
  const recordPath = sessions.recordPath(ADVISOR_MODE, session.id);
  const at = input.now();

  if (verb === 'status') {
    return completed({
      session: session.id,
      output: {
        status: { exists: session.exists, notes: log.notes.length, last: log.notes.at(-1) ?? null },
      },
      recordPath: session.exists ? recordPath : null,
      seats: log.seats,
    });
  }
  if (verb === 'start') {
    // An ended log is terminal and already committed, so `--start` on one cannot mean what it
    // says: it would report the session as started while every note verb on it is refused.
    if (log.ended) throw new Error(`Advisor session ${session.id} has ended; start a new session`);
    if (!session.exists) {
      await sessions.append(ADVISOR_MODE, session.id, {
        at,
        kind: 'started',
        data: { key: session.key },
      });
    }
    return completed({
      session: session.id,
      output: { started: { session: session.id } },
      recordPath,
    });
  }
  if (verb === 'end') {
    if (!session.exists) throw new Error(`Unknown advisor session: ${session.id}`);
    // The only verb that hands the log to the CLI's commit path: the session's note log is its
    // terminal record, committed once, when the session ends. Whether it had already ended is
    // decided from the log under the store's write lock rather than from the read above, so two
    // --end calls racing each other cannot both report that they closed the same log.
    let ended = { notes: log.notes.length, closed: false };
    let seats: readonly EnvelopeSeat[] = log.seats;
    const written = await sessions.appendDerived(ADVISOR_MODE, session.id, (events) => {
      const current = readAdvisorLog(events);
      seats = current.seats;
      ended = { notes: current.notes.length, closed: !current.ended };
      return current.ended ? null : { at, kind: 'ended', data: { notes: current.notes.length } };
    });
    return completed({
      session: session.id,
      output: { ended },
      recordPath,
      seats,
      paths: written.paths,
    });
  }
  if (log.ended) throw new Error(`Advisor session ${session.id} has ended; start a new session`);
  if (verb === 'heed') {
    if (!session.exists) throw new Error(`Unknown advisor session: ${session.id}`);
    const id = NoteIdSchema.parse(requiredFlag(input, 'heed', 'advise --heed requires a note id'));
    const [value, ...rest] = input.positionals;
    const heeded = HeededSchema.safeParse(value);
    if (!heeded.success || rest.length > 0) {
      throw new Error('advise --heed <note-id> takes exactly one of yes, no or unknown');
    }
    if (!log.notes.some((note) => note.id === id)) throw new Error(`Unknown advisor note: ${id}`);
    await sessions.append(ADVISOR_MODE, session.id, {
      at,
      kind: 'heed',
      data: { note: id, heeded: heeded.data },
    });
    return completed({
      session: session.id,
      output: { heeded: { id, value: heeded.data } },
      recordPath,
    });
  }
  // Every other verb has returned, so this one is a note verb and its request was read at the top
  // of the handler; the check is what tells the compiler so.
  if (request === null) throw new Error(`advise --${verb} carries no note request`);
  const consulted = await consult(input, request, log, at);
  // The note id is minted from the log inside the store's write lock, not from the read above.
  // Two hooks firing at once would otherwise both mint n-1, and a log carrying a duplicate id
  // fails every later read, so the session could never again be read, heeded or ended. The seat
  // is consulted before the lock is taken; only what depends on the log is decided under it.
  // It is the harness hook's own outer timeout, never --window-ms, that bounds how long a call
  // can take in total: the budget covers the seat, and the scope lock below can wait behind
  // another call in the same scope after the budget has already been spent.
  let note: AdvisorNote = { ...consulted.note, id: nextNoteId(log) };
  await sessions.appendDerived(ADVISOR_MODE, session.id, (events) => {
    const current = readAdvisorLog(events);
    if (current.ended) {
      throw new Error(`Advisor session ${session.id} has ended; start a new session`);
    }
    // Validated against the same schema the CLI validates the output with, and inside the lock,
    // so a note that schema would refuse is never appended. Refusing it here costs one note; the
    // log rejecting it afterwards costs every later verb on the session, which reads the log.
    note = AdvisorNoteSchema.parse({ ...consulted.note, id: nextNoteId(current) });
    return { at, kind: 'note', data: { note, seat: consulted.seat } };
  });
  return completed({
    session: session.id,
    output: { note },
    recordPath,
    seats: consulted.seat === null ? [] : [consulted.seat],
    rounds: consulted.rounds,
    spend: consulted.spend,
    degraded: degradationOf(note),
  });
}

export const advisor: HandlerModeDefinition = {
  kind: 'handler',
  name: ADVISOR_MODE,
  knobs: {
    participants: 'one subscription seat, optionally a second cheaper one for the cadence pass',
    pattern: 'streaming',
    aggregation: 'none; each note stands alone',
    tempo: 'seconds',
    records: 'a note log per harness session, committed when the session ends',
  },
  pattern: 'streaming',
  spend: { policy: 'never-metered', defaultCap: () => 0 },
  flags: {
    value: [
      'every',
      'transcript',
      'class',
      'tool',
      'ask',
      'heed',
      'from',
      'window-ms',
      'cadence-family',
    ],
    boolean: ['watch', 'hold', 'note', 'start', 'end', 'status'],
  },
  session: 'key',
  acceptsPositionals: true,
  outputSchema: AdvisorOutputSchema,
  handle,
};
