import { z } from 'zod';
import {
  EVIDENCE_BOUNDARY_INSTRUCTION,
  panelEnvelopeSeats,
  runPanel,
  scanAndRedact,
  spreadSeats,
  untrustedBlock,
  type EnvelopeSeat,
  type ModelRegistry,
  type PanelAnswer,
  type PanelLens,
  type PanelResult,
  type PanelSeat,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderFamily,
  type Spend,
} from '../../substrate';
import {
  NOTE_TEXT_LIMIT,
  NoteSeveritySchema,
  safeExcerpt,
  type NoteSeverity,
  type NoteStatus,
  type RiskClass,
} from './notes';

export const AdvisorAnswerSchema = z.strictObject({
  severity: NoteSeveritySchema,
  text: z.string(),
});
export type AdvisorAnswer = z.infer<typeof AdvisorAnswerSchema>;

export const ADVISOR_ANSWER: PanelAnswer<AdvisorAnswer> = {
  schema: AdvisorAnswerSchema,
  instruction: `Return exactly one JSON object with these keys: severity ("info", "caution" or "stop"), text (a string of at most ${NOTE_TEXT_LIMIT} characters, empty when you have nothing worth saying). Do not wrap it in prose.`,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['severity', 'text'],
    properties: {
      severity: { type: 'string', enum: ['info', 'caution', 'stop'] },
      text: { type: 'string', maxLength: NOTE_TEXT_LIMIT },
    },
  },
};

export const ADVISOR_LENS: PanelLens = {
  name: 'advisor',
  description:
    'A second pair of eyes beside a working agent: notice what the agent is about to get wrong, and say nothing when there is nothing to say.',
};

export const NEVER_METERED_SPEND: Spend = Object.freeze({
  billing: 'sub-only',
  policy: 'never-metered',
  cap: 0,
  used: 0,
  fallbacks: 0,
  refused: 0,
  stoppedAtCap: false,
});

/**
 * Families the advisor may seat: any with a subscription transport. A metered-only family
 * (DeepSeek, Moonshot) could never answer under `never-metered`, so offering it a seat would
 * only ever record a skip.
 */
export function subscriptionFamilies(
  families: readonly ProviderFamily[],
  registry: ModelRegistry,
): ProviderFamily[] {
  return families.filter((family) => registry[family].transport !== 'http');
}

export type FamilySelection =
  | { readonly family: ProviderFamily; readonly reason: null }
  | { readonly family: null; readonly reason: string };

function safeText(value: string): string {
  return scanAndRedact(value).redacted.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * The first family, in the caller's order, whose adapter reports itself available. Availability
 * is a local fact (an executable on the path, a key in the environment), never a provider call,
 * so selection costs nothing and a down family is skipped with its reason in the note.
 */
export async function selectSeatFamily(
  families: readonly ProviderFamily[],
  adapters: Partial<Record<ProviderFamily, ProviderAdapter>>,
  context: ProviderContext,
): Promise<FamilySelection> {
  const candidates = subscriptionFamilies(families, context.registry);
  if (candidates.length === 0) {
    return { family: null, reason: 'no subscription-capable family among the selected providers' };
  }
  const reasons: string[] = [];
  for (const family of candidates) {
    const adapter = adapters[family];
    if (adapter === undefined) {
      reasons.push(`${family}: no adapter`);
      continue;
    }
    try {
      const availability = await adapter.availability(context);
      if (availability.status === 'available') return { family, reason: null };
      const detail = availability.reason.length === 0 ? '' : ` (${safeText(availability.reason)})`;
      reasons.push(`${family}: ${availability.status}${detail}`);
    } catch (error) {
      reasons.push(`${family}: availability check failed (${safeText(String(error))})`);
    }
  }
  return { family: null, reason: `no available seat: ${reasons.join('; ')}` };
}

export interface PromptInput {
  readonly trigger: 'cadence' | 'ask' | 'hold';
  /** The window, question or tool text, already passed through the outbound guard. */
  readonly material: string;
  readonly riskClass?: RiskClass;
  readonly budgetMs?: number;
}

const ROLE = [
  'You are an advisor sitting beside a working coding agent. You speak; the agent decides.',
  'You cannot run tools, edit files or stop the agent. Your note is read by the agent, so address',
  `it directly, in at most ${NOTE_TEXT_LIMIT} characters. Say only what the agent does not already`,
  'know and would change its next step; when there is nothing worth saying, return severity "info"',
  'and an empty text. Severity: "info" for a remark, "caution" for a real risk the agent should',
  'weigh, "stop" only when proceeding is very likely to cause loss.',
].join(' ');

export function advisorPrompt(input: PromptInput): string {
  const seconds = input.budgetMs === undefined ? undefined : Math.round(input.budgetMs / 1000);
  const framing =
    input.trigger === 'hold'
      ? `The agent is about to run a tool call in the "${input.riskClass ?? 'unnamed'}" risk class. Judge that call alone.${seconds === undefined ? '' : ` You have ${seconds} seconds.`}`
      : input.trigger === 'ask'
        ? 'The agent has asked you a question. Answer it.'
        : 'This is a routine cadence pass over the recent transcript. Comment only on a mistake, a missed risk or a clearly better route.';
  const tag =
    input.trigger === 'hold'
      ? 'tool-call'
      : input.trigger === 'ask'
        ? 'question'
        : 'transcript-window';
  return `${ROLE}\n\n${framing}\n\n${EVIDENCE_BOUNDARY_INSTRUCTION}\n\n${untrustedBlock(tag, input.material)}`;
}

export interface ConsultInput {
  readonly family: ProviderFamily;
  readonly adapters: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly context: ProviderContext;
  readonly prompt: string;
  /** The seat's whole budget in milliseconds: the hold window, or the cadence and ask ceiling. */
  readonly budgetMs: number;
}

export interface SeatConsultation {
  readonly status: NoteStatus;
  readonly severity: NoteSeverity;
  readonly text: string;
  readonly reason: string | null;
  readonly seatId: string;
  readonly seat: EnvelopeSeat | null;
  readonly spend: Spend;
}

const TIMEOUT_CODES: ReadonlySet<string> = new Set(['timeout', 'timed-out']);

function silent(
  seatId: string,
  seat: EnvelopeSeat | null,
  spend: Spend,
  status: 'skipped' | 'no-advice',
  reason: string,
): SeatConsultation {
  return { status, severity: 'info', text: '', reason, seatId, seat, spend };
}

function fromPanelSeat(seat: PanelSeat<AdvisorAnswer>, spend: Spend): SeatConsultation {
  const envelopeSeat = panelEnvelopeSeats([seat])[0] ?? null;
  switch (seat.status) {
    case 'ok': {
      // Redacted and surrogate-safe, like every other seat answer bound for the note log: a seat
      // reply is untrusted the same way as any other panel output, and it can end mid astral
      // character at the limit as readily as it can carry a secret.
      const text = safeExcerpt(seat.answer.text, NOTE_TEXT_LIMIT);
      // A seat that chose to say nothing is silence, the same outcome as a window that elapsed.
      if (text.length === 0)
        return silent(seat.id, envelopeSeat, spend, 'no-advice', 'seat-silent');
      return {
        status: 'ok',
        severity: seat.answer.severity,
        text,
        reason: null,
        seatId: seat.id,
        seat: envelopeSeat,
        spend,
      };
    }
    case 'invalid':
      return silent(seat.id, envelopeSeat, spend, 'skipped', `invalid-answer: ${seat.reason}`);
    case 'skipped':
      return silent(seat.id, envelopeSeat, spend, 'skipped', `${seat.code}: ${seat.reason}`);
    case 'failed':
      return TIMEOUT_CODES.has(seat.code)
        ? silent(seat.id, envelopeSeat, spend, 'no-advice', 'timeout')
        : silent(seat.id, envelopeSeat, spend, 'skipped', `${seat.code}: ${seat.reason}`);
  }
}

type Settled = { readonly result: PanelResult<AdvisorAnswer> } | { readonly error: unknown };

/**
 * One blind seat under `never-metered`, bounded twice on purpose: the context timeout lets the
 * CLI transport kill the provider process at the budget, and the race returns on time even if a
 * transport ignores its deadline. A late answer is discarded. A hold that waited longer than it
 * promised is worse than a hold that said nothing, because the agent is standing still for it.
 */
export async function consultSeat(input: ConsultInput): Promise<SeatConsultation> {
  const seats = spreadSeats([input.family], [ADVISOR_LENS], input.context.registry);
  const seat = seats[0];
  if (seat === undefined) throw new Error('The advisor seat spread produced no seat');
  const context: ProviderContext = { ...input.context, timeoutMs: input.budgetMs };
  const panel: Promise<Settled> = runPanel(
    { adapters: input.adapters, context },
    {
      seats,
      prompt: () => input.prompt,
      answer: ADVISOR_ANSWER,
      spend: { policy: 'never-metered' },
    },
  ).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<'elapsed'>((resolve) => {
    timer = setTimeout(() => resolve('elapsed'), input.budgetMs);
  });
  try {
    const outcome = await Promise.race([panel, elapsed]);
    if (outcome === 'elapsed') {
      return silent(seat.id, null, NEVER_METERED_SPEND, 'no-advice', 'window-elapsed');
    }
    if ('error' in outcome) {
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return silent(seat.id, null, NEVER_METERED_SPEND, 'skipped', `panel: ${safeText(message)}`);
    }
    const first = outcome.result.seats[0];
    if (first === undefined) throw new Error('The advisor panel returned no seat');
    return fromPanelSeat(first, outcome.result.spend);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
