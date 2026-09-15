import {
  createSpendLedger,
  newModeSessionId,
  panelEnvelopeSeats,
  panelSeatId,
  runPanel,
  spreadSeats,
  type EnvelopeSeat,
  type EvidencePack,
  type ModeSessionStore,
  type PanelLens,
  type PanelSeatSpec,
  type Spend,
} from '../../substrate';
import type { HandlerInput, HandlerModeDefinition, HandlerOutcome } from '../types';
import { collectContext, renderContext, type ContextFile } from './context';
import { loadPersonas, parseLensNames, resolveLenses } from './lenses';
import {
  SYNTHESISER_LENS,
  conflictsAnswer,
  followUpAnswer,
  followUpPrompt,
  reportAnswer,
  reportPrompt,
  synthesisPrompt,
  type Conflict,
  type ReportReference,
} from './prompts';
import {
  CONSULTANTS_MODE,
  CONSULTANTS_SESSION_PREFIX,
  ConsultantsOutputSchema,
  historyFor,
  replaySession,
  sessionOutput,
} from './session';

export { ConsultantsOutputSchema } from './session';

function flagValues(input: HandlerInput, name: string): readonly string[] {
  return input.flags.get(name) ?? [];
}

function oneFlagValue(input: HandlerInput, name: string): string | undefined {
  const values = flagValues(input, name);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RenderedBrief =
  | { readonly ok: true; readonly pack: EvidencePack }
  | { readonly ok: false; readonly reason: string };

function renderBrief(files: readonly ContextFile[], at: string): RenderedBrief {
  try {
    return { ok: true, pack: renderContext(files, at) };
  } catch (error) {
    // The guard has already refused a hard-blocked secret, so anything left is a shape the
    // collector let through. It is still the caller's material, so the brief blocks rather than
    // throwing an unexplained error at a caller who can fix the file named in the message.
    return { ok: false, reason: describeError(error) };
  }
}

/** Collects the log paths each append reported, so the CLI commits exactly the files written. */
interface Recorder {
  readonly append: (kind: string, data: unknown) => Promise<void>;
  readonly paths: string[];
}

function recorder(input: HandlerInput, sessions: ModeSessionStore, session: string): Recorder {
  const paths: string[] = [];
  return {
    paths,
    async append(kind, data) {
      const write = await sessions.append(CONSULTANTS_MODE, session, {
        at: input.now(),
        kind,
        data,
      });
      for (const path of write.paths) if (!paths.includes(path)) paths.push(path);
    },
  };
}

async function readOutput(
  sessions: ModeSessionStore,
  session: string,
): Promise<Record<string, unknown>> {
  // The log is the session, so the output is rebuilt from it after every command rather than
  // assembled from what this process happens to hold.
  const state = replaySession(await sessions.read(CONSULTANTS_MODE, session));
  return { ...sessionOutput(state) };
}

async function brief(input: HandlerInput, sessions: ModeSessionStore): Promise<HandlerOutcome> {
  if (flagValues(input, 'forward').length > 0) {
    throw new Error('--forward belongs to a follow-up: pass it with --ask <lens>');
  }
  if (input.positionals.length > 0) {
    throw new Error(
      'A brief takes its question from --motion; the positional question belongs to --ask <lens> "<question>"',
    );
  }
  const question = input.options.motion;
  if (question === undefined) throw new Error('consult needs the brief question in --motion');
  const names = parseLensNames(flagValues(input, 'lens'));
  const personasPath = oneFlagValue(input, 'personas');
  const personas =
    personasPath === undefined ? [] : await loadPersonas(personasPath, input.context.cwd);
  const lenses = resolveLenses(names, personas);

  const session =
    input.options.sessionId ?? newModeSessionId(CONSULTANTS_SESSION_PREFIX, input.now());
  if (await sessions.exists(CONSULTANTS_MODE, session)) {
    throw new Error(
      `Session ${session} already holds a brief; ask a follow-up with --ask <lens> "<question>"`,
    );
  }

  const collected = await collectContext(flagValues(input, 'context'), input.context.cwd);
  // The whole brief passes the guard before a consultant exists, so a hard-blocked secret stops
  // the session rather than reaching whichever family was dispatched first. Lens names and
  // descriptions are included: a `--personas` file is caller-supplied text like any other, and a
  // secret sitting in a persona's description would otherwise reach a provider inside a report
  // prompt without ever having passed the outbound guard.
  const decision = input.guard([
    question,
    ...lenses.map((lens) => lens.name),
    ...lenses.map((lens) => lens.description),
    ...collected.files.map((file) => file.content),
  ]);
  if (decision.kind === 'blocked') {
    return {
      kind: 'blocked',
      status: 'blocked-policy',
      message:
        'The brief did not pass the outbound policy guard, so no consultant was briefed. Remove the flagged material from --motion or --context and run it again.',
      decision,
    };
  }
  const rendered = renderBrief(collected.files, input.now());
  if (!rendered.ok) {
    return {
      kind: 'blocked',
      status: 'blocked-policy',
      message: `The brief could not be rendered as evidence: ${rendered.reason}`,
      decision,
    };
  }
  const evidence = rendered.pack;

  const seats = spreadSeats(input.options.providerFamilies, lenses, input.context.registry);
  // The CLI already built the ledger this session must spend from, sized from `--spend-cap` or
  // from `consultants.spend.defaultCap` applied to the eligible family count. Both the report
  // round and the synthesiser seat draw from the same ledger, so the cap the caller asked for is
  // a session cap rather than a per-round one: a synthesiser that needed a metered fallback after
  // the report round had already spent it would otherwise see a cap nobody told it about.
  if (input.spend.policy !== 'capped') {
    throw new Error('consult is a capped-spend mode; the CLI must always hand it a ledger');
  }
  const ledger = input.spend.ledger;
  const panel = await runPanel(
    { adapters: input.adapters, context: input.context },
    {
      seats,
      prompt: (seat) => reportPrompt({ lens: seat.lens, question, evidence: evidence.rendered }),
      answer: reportAnswer(),
      spend: input.spend,
    },
  );

  const log = recorder(input, sessions, session);
  await log.append('brief', {
    question,
    context: evidence.sources.map((source) => ({
      locator: source.locator,
      sha256: source.sha256,
    })),
    lenses,
    seats: seats.map((seat) => ({
      lens: seat.lens.name,
      seat: seat.id,
      family: seat.family,
      model: seat.model,
    })),
  });

  const degraded: string[] = [...collected.skipped];
  const answered: ReportReference[] = [];
  for (const seat of panel.seats) {
    const outcome =
      seat.status === 'ok'
        ? { status: seat.status, report: seat.answer.report, reason: null }
        : { status: seat.status, report: null, reason: seat.reason };
    await log.append('report', {
      lens: seat.lens,
      seat: seat.id,
      family: seat.family,
      model: seat.model.requested,
      ...outcome,
    });
    if (seat.status === 'ok') {
      answered.push({ lens: seat.lens, seat: seat.id, report: seat.answer.report });
    } else {
      degraded.push(`report-missing: ${seat.lens} (${seat.code})`);
    }
  }

  let synthesis: { by: string; text: string } | null = null;
  let synthesisSeats: EnvelopeSeat[] = [];
  let synthesisFallbacks = 0;
  let synthesisUsed = 0;
  if (answered.length < 2) {
    // Two reports are the least that can conflict, so there is nothing for a synthesiser to read.
    const reason = `fewer than two consultants reported (${answered.length})`;
    degraded.push(`conflicts-unavailable: ${reason}`);
    await log.append('conflicts', { by: null, status: 'unavailable', conflicts: [], reason });
  } else {
    const first = panel.seats.find((seat) => seat.status === 'ok');
    if (first === undefined) throw new Error('A reporting seat disappeared between two reads');
    // The first family that actually answered is the first available one: it has just proved it.
    const family = first.family;
    const model = input.context.registry[family].primary;
    const lens: PanelLens = {
      name: SYNTHESISER_LENS,
      description: "Name the conflicts between the consultants' reports; never resolve one.",
    };
    const seat: PanelSeatSpec = {
      id: panelSeatId(family, model, SYNTHESISER_LENS),
      family,
      model,
      lens,
    };
    const synthesisPanel = await runPanel(
      { adapters: input.adapters, context: input.context },
      {
        seats: [seat],
        prompt: () => synthesisPrompt({ question, reports: answered }),
        answer: conflictsAnswer(answered.map((report) => report.lens)),
        spend: input.spend,
      },
    );
    synthesisSeats = panelEnvelopeSeats(synthesisPanel.seats);
    synthesisFallbacks = synthesisPanel.spend.fallbacks;
    synthesisUsed = synthesisPanel.spend.used;
    const synthesised = synthesisPanel.seats[0];
    if (synthesised === undefined) throw new Error('The synthesis panel returned no seat');
    if (synthesised.status === 'ok') {
      const conflicts: Conflict[] = [...synthesised.answer.conflicts];
      synthesis = { by: synthesised.id, text: JSON.stringify(conflicts) };
      await log.append('conflicts', {
        by: synthesised.id,
        status: 'ok',
        conflicts,
        reason: null,
      });
    } else {
      degraded.push(`conflicts-unavailable: ${synthesised.code}`);
      await log.append('conflicts', {
        by: synthesised.id,
        status: synthesised.status,
        conflicts: [],
        reason: synthesised.reason,
      });
    }
  }

  // `used` is `spend.used` the way every mode reports it: seats counted per transport, true under
  // `--billing api-only` too, where nothing ever reaches the ledger. `reserved` is the ledger's
  // own counter, which only grows when a subscription seat fails and a metered fallback is
  // attempted — the two coincide whenever every seat's only path to a metered key is that
  // fallback, and diverge the moment one is not (a seat metered from the start counts in `used`
  // and never touches the ledger). The session cap is a budget over `reserved`, not `used`, so a
  // follow-up's remaining-budget arithmetic must read the log's `reserved` field, not this one.
  const used = panel.spend.used + synthesisUsed;
  const fallbacks = panel.spend.fallbacks + synthesisFallbacks;
  await log.append('spend', {
    command: 'brief',
    cap: ledger.cap,
    used,
    reserved: ledger.used,
    fallbacks,
    refused: ledger.refused,
  });

  const spend: Spend = {
    billing: input.spend.billing,
    policy: 'capped',
    cap: ledger.cap,
    used,
    fallbacks,
    refused: ledger.refused,
    stoppedAtCap: ledger.refused > 0,
  };
  return {
    kind: 'result',
    status: degraded.length === 0 ? 'completed' : 'degraded',
    session,
    pattern: 'parallel',
    rounds: synthesisSeats.length === 0 ? 1 : 2,
    seats: [...panelEnvelopeSeats(panel.seats), ...synthesisSeats],
    output: await readOutput(sessions, session),
    synthesis,
    dissent: null,
    // Consultants answer different questions, so agreement between them is not a signal at all:
    // the conflicts list is where disagreement lives, and unanimity would mean nothing here.
    unanimous: false,
    degraded,
    spend,
    record: {
      session: sessions.recordPath(CONSULTANTS_MODE, session),
      paths: log.paths,
    },
  };
}

function forwardNames(input: HandlerInput, ask: string): string[] {
  const names = flagValues(input, 'forward')
    .flatMap((value) => value.split(','))
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of names) {
    if (name === ask) throw new Error(`--forward ${name} is the consultant being asked`);
  }
  return [...new Set(names)];
}

/**
 * One consultant, one question. The consultant is given its own report and its own Q&A history as
 * data, and another consultant's report only where the caller forwarded it: a follow-up is never
 * a broadcast, and no seat learns what another said by default.
 */
async function followUp(
  input: HandlerInput,
  sessions: ModeSessionStore,
  ask: string,
): Promise<HandlerOutcome> {
  for (const flag of ['lens', 'context', 'personas'] as const) {
    if (flagValues(input, flag).length > 0) {
      throw new Error(
        `--${flag} belongs to a brief; a follow-up takes --session, --ask, optional --forward and the question`,
      );
    }
  }
  if (input.options.motion !== undefined) {
    throw new Error(
      'A follow-up takes its question as the positional argument, not --motion: consult --session <id> --ask <lens> "<question>"',
    );
  }
  const session = input.options.sessionId;
  if (session === undefined) throw new Error('A follow-up needs --session <id>');
  if (!(await sessions.exists(CONSULTANTS_MODE, session))) {
    throw new Error(`Unknown consultants session: ${session}`);
  }
  const question = (input.positionals[0] ?? '').trim();
  if (question.length === 0) {
    throw new Error(
      'A follow-up needs its question as one quoted argument: consult --session <id> --ask <lens> "<question>"',
    );
  }

  const state = replaySession(await sessions.read(CONSULTANTS_MODE, session));
  const consultant = state.reports.find((report) => report.lens === ask);
  if (consultant === undefined) {
    throw new Error(
      `Unknown lens: ${ask}. This session seated: ${state.reports.map((report) => report.lens).join(', ')}`,
    );
  }
  const report = consultant.report;
  if (consultant.status !== 'ok' || report === null) {
    throw new Error(`The ${ask} consultant never reported in this session, so it cannot follow up`);
  }
  const forwarded: ReportReference[] = forwardNames(input, ask).map((name) => {
    const other = state.reports.find((entry) => entry.lens === name);
    if (other === undefined || other.status !== 'ok' || other.report === null) {
      throw new Error(`Cannot forward ${name}: this session has no report from that lens`);
    }
    return { lens: other.lens, seat: other.seat, report: other.report };
  });

  if (input.spend.policy !== 'capped') {
    throw new Error('consult is a capped-spend mode; the CLI must always hand it a ledger');
  }

  const decision = input.guard([question]);
  if (decision.kind === 'blocked') {
    return {
      kind: 'blocked',
      status: 'blocked-policy',
      message:
        'The follow-up question did not pass the outbound policy guard, so the consultant was not asked.',
      decision,
    };
  }

  const lens: PanelLens = state.brief.lenses.find((entry) => entry.name === ask) ?? {
    name: ask,
    description: `The ${ask} consultant on this brief.`,
  };
  // An explicit --spend-cap raises the session's cap, as the exhausted-cap message invites; it may
  // not lower it, because the earlier commands were already paid for under the higher one. The CLI
  // hands every command a freshly built ledger sized from `--spend-cap` when given or from the
  // mode's own default otherwise, so a follow-up with no `--spend-cap` of its own must not let that
  // default quietly override the cap the session already recorded: only a flag the caller actually
  // typed on this command can change it.
  const explicitCap = input.flags.has('spend-cap') ? input.spend.ledger.cap : undefined;
  if (explicitCap !== undefined && explicitCap < state.spend.cap) {
    throw new Error(
      `A follow-up may raise the session cap, not lower it: this session is already capped at ${state.spend.cap}`,
    );
  }
  const cap = explicitCap ?? state.spend.cap;
  // The budget is over reservations, not over transport-counted `used`: see the comment on the
  // `spend` event write in `brief()`.
  const remaining = Math.max(0, cap - state.spend.reserved);
  const log = recorder(input, sessions, session);

  if (remaining === 0) {
    // The cap covers the session, so an exhausted session does not quietly continue on the
    // subscription: the seat is skipped, the refusal is recorded, and the caller is told how to
    // raise the cap.
    await log.append('spend', {
      command: 'ask',
      cap,
      used: 0,
      reserved: 0,
      fallbacks: 0,
      refused: 1,
    });
    const seat: EnvelopeSeat = {
      id: consultant.seat,
      family: consultant.family,
      model: { requested: consultant.model, verified: null, verification: 'unverified' },
      lens: consultant.lens,
      transport: null,
      fallback: false,
      status: 'skipped',
      reason: `spend-cap: the session cap of ${cap} metered call(s) is spent; raise it with --spend-cap <n>`,
    };
    return {
      kind: 'result',
      status: 'degraded',
      session,
      pattern: 'parallel',
      rounds: 1,
      seats: [seat],
      output: await readOutput(sessions, session),
      synthesis: null,
      dissent: null,
      unanimous: false,
      degraded: [`answer-missing: ${ask} (spend-cap)`],
      spend: {
        billing: input.spend.billing,
        policy: 'capped',
        cap,
        used: state.spend.used,
        fallbacks: state.spend.fallbacks,
        refused: 1,
        stoppedAtCap: true,
      },
      record: { session: sessions.recordPath(CONSULTANTS_MODE, session), paths: log.paths },
    };
  }

  const ledger = createSpendLedger(remaining);
  const seat: PanelSeatSpec = {
    id: consultant.seat,
    family: consultant.family,
    model: consultant.model,
    lens,
  };
  const panel = await runPanel(
    { adapters: input.adapters, context: input.context },
    {
      seats: [seat],
      prompt: () =>
        followUpPrompt({
          lens,
          question: state.brief.question,
          report,
          history: historyFor(state, ask),
          forwarded,
          ask: question,
        }),
      answer: followUpAnswer(),
      spend: { policy: 'capped', billing: input.spend.billing, ledger },
    },
  );
  const answered = panel.seats[0];
  if (answered === undefined) throw new Error('The follow-up panel returned no seat');
  const degraded: string[] = [];
  if (answered.status === 'ok') {
    await log.append('qa', {
      to: ask,
      seat: answered.id,
      question,
      answer: answered.answer.answer,
      forwarded: forwarded.map((entry) => entry.lens),
    });
  } else {
    degraded.push(`answer-missing: ${ask} (${answered.code})`);
  }
  await log.append('spend', {
    command: 'ask',
    cap,
    used: panel.spend.used,
    reserved: ledger.used,
    fallbacks: panel.spend.fallbacks,
    refused: ledger.refused,
  });

  return {
    kind: 'result',
    status: degraded.length === 0 ? 'completed' : 'degraded',
    session,
    pattern: 'parallel',
    rounds: 1,
    seats: panelEnvelopeSeats(panel.seats),
    output: await readOutput(sessions, session),
    synthesis: null,
    dissent: null,
    unanimous: false,
    degraded,
    spend: {
      billing: input.spend.billing,
      policy: 'capped',
      cap,
      used: state.spend.used + panel.spend.used,
      fallbacks: state.spend.fallbacks + panel.spend.fallbacks,
      refused: ledger.refused,
      stoppedAtCap: ledger.refused > 0,
    },
    record: { session: sessions.recordPath(CONSULTANTS_MODE, session), paths: log.paths },
  };
}

async function handle(input: HandlerInput): Promise<HandlerOutcome> {
  const sessions = input.sessions;
  if (sessions === null) {
    throw new Error(
      'consult keeps an open session, so it needs a records root: pass --records-root <path>',
    );
  }
  const askValue = oneFlagValue(input, 'ask');
  if (askValue === undefined) return brief(input, sessions);
  if (input.positionals.length > 1) {
    throw new Error('consult --ask takes one question: pass it as --ask <lens> "<question>"');
  }
  const ask = askValue.trim();
  if (ask.length === 0) throw new Error('--ask needs the lens name of one consultant');
  return followUp(input, sessions, ask);
}

export const consultants: HandlerModeDefinition = {
  kind: 'handler',
  name: 'consultants',
  knobs: {
    participants: 'one seat per named lens, from the catalogue or a supplied persona list',
    pattern: 'parallel',
    aggregation: 'per-lens reports plus cross-lens conflicts, never resolved',
    tempo: 'minutes; the session stays open for follow-ups',
    records: 'session log with the brief, the reports, the conflicts and the Q&A',
  },
  pattern: 'parallel',
  spend: {
    policy: 'capped',
    // Called by the CLI with the eligible family count and one round, before this mode has
    // resolved its lenses into seats: eligible is the widest roster its policy allows it to draw
    // from, and one reserved metered call per eligible family covers a brief's report round, the
    // synthesiser and a follow-up (task 5) from the one session-wide ledger they all share.
    defaultCap: (families: number) => families,
  },
  flags: { value: ['ask', 'context', 'forward', 'lens', 'personas'], boolean: [] },
  acceptsPositionals: true,
  outputSchema: ConsultantsOutputSchema,
  handle,
};
