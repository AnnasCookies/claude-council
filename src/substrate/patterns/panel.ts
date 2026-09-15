import { z } from 'zod';
import {
  ProviderFamilySchema,
  SeatResponseSchema,
  type ProviderFamily,
  type SeatResponse,
} from '../domain/schemas';
import type { EnvelopeSeat, Spend } from '../envelope';
import { escapeUntrustedPromptText } from '../evidence/normalise';
import {
  permitsCredentialFallback,
  type BillingMode,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
} from '../execution/provider';
import type { ModelRegistry } from '../models/registry';
import { scanAndRedact } from '../policy/secrets';
import { createSpendLedger, type SpendLedger } from '../spend';

const LensNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'A lens name is 1 to 64 characters of letters, digits, dot, underscore or hyphen',
  );

export const PanelLensSchema = z.strictObject({
  name: LensNameSchema,
  description: z.string().trim().min(1),
});
export type PanelLens = z.infer<typeof PanelLensSchema>;

export const PanelSeatSpecSchema = z.strictObject({
  id: z.string().min(1),
  family: ProviderFamilySchema,
  model: z.string().min(1),
  lens: PanelLensSchema,
});
export type PanelSeatSpec = z.infer<typeof PanelSeatSpecSchema>;

const PanelSeatSpecsSchema = z
  .array(PanelSeatSpecSchema)
  .min(1)
  .superRefine((seats, context) => {
    const seen = new Set<string>();
    for (const [index, seat] of seats.entries()) {
      if (seen.has(seat.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate seat identifier: ${seat.id}`,
        });
      }
      seen.add(seat.id);
    }
  });

export function panelSeatId(family: ProviderFamily, model: string, lens: string): string {
  return `${family}/${model}#${lens}`;
}

/**
 * One seat per lens, families dealt round-robin in the order given: twelve lenses over four
 * families is three seats per family, and the first lens always lands on the first family so a
 * caller can reason about the spread. The model is the family's registered primary, which is the
 * requested identity the adapter later verifies. Only the primary: a mode that wants a family's
 * cheaper or larger model for some seats hand-builds its {@link PanelSeatSpec}s instead of
 * calling this.
 */
export function spreadSeats(
  families: readonly ProviderFamily[],
  lenses: readonly PanelLens[],
  registry: ModelRegistry,
): PanelSeatSpec[] {
  const parsedFamilies = z.array(ProviderFamilySchema).min(1).parse(families);
  if (new Set(parsedFamilies).size !== parsedFamilies.length) {
    throw new Error('Panel families must be distinct');
  }
  const parsedLenses = z.array(PanelLensSchema).min(1).parse(lenses);
  const seats = parsedLenses.map((lens, index) => {
    const family = parsedFamilies[index % parsedFamilies.length];
    if (family === undefined) throw new Error('Panel family spread produced no family');
    const model = registry[family].primary;
    return { id: panelSeatId(family, model, lens.name), family, model, lens };
  });
  return PanelSeatSpecsSchema.parse(seats);
}

/** The default bound on seats in flight, and the range a caller may ask for instead. */
export const DEFAULT_PANEL_CONCURRENCY = 6;
const PanelConcurrencySchema = z.number().int().min(1).max(24).default(DEFAULT_PANEL_CONCURRENCY);

export type PanelSpend =
  | { readonly policy: 'never-metered' }
  | { readonly policy: 'capped'; readonly billing: BillingMode; readonly ledger: SpendLedger };

export interface PanelAnswer<T> {
  readonly schema: z.ZodType<T>;
  /** Prepended to the prompt by the adapter, where the council instruction goes today. */
  readonly instruction: string;
  /** Given to the transports that constrain decoding; hand-written like the council schema. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

export interface PanelInput<T> {
  readonly seats: readonly PanelSeatSpec[];
  /**
   * Built by the caller for one seat at a time. Nothing another seat produced may appear in it
   * except as data wrapped by {@link untrustedBlock}; the panel adds only the answer contract's
   * instruction, inside the adapter, so the prompt on the wire is this text plus that line.
   */
  readonly prompt: (seat: PanelSeatSpec) => string;
  readonly answer: PanelAnswer<T>;
  readonly spend: PanelSpend;
  /**
   * How many seats may be in flight at once. Default six, which is the widest family roster; a
   * twelve-voice panel would otherwise start twelve provider processes together and the machine,
   * not the panel, pays for that. One to twenty-four, validated.
   */
  readonly concurrency?: number;
}

export interface PanelConfig {
  readonly adapters: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly context: ProviderContext;
}

export interface PanelSeatModel {
  readonly requested: string;
  readonly verified: string | null;
  readonly verification: 'verified' | 'unverified';
}

interface PanelSeatBase {
  readonly id: string;
  readonly family: ProviderFamily;
  readonly model: PanelSeatModel;
  readonly lens: string;
  readonly transport: 'subscription' | 'api' | null;
  readonly fallback: boolean;
  readonly latencyMs: number | null;
}

export type PanelSeat<T> = PanelSeatBase &
  (
    | {
        readonly status: 'ok';
        readonly answer: T;
        readonly raw: string;
        readonly code: null;
        readonly reason: null;
      }
    | {
        readonly status: 'invalid';
        readonly raw: string;
        readonly code: 'invalid-answer';
        readonly reason: string;
      }
    | { readonly status: 'skipped'; readonly code: string; readonly reason: string }
    | { readonly status: 'failed'; readonly code: string; readonly reason: string }
  );

export interface PanelResult<T> {
  readonly seats: readonly PanelSeat<T>[];
  /** Seats whose answer validated. */
  readonly answered: number;
  /** Distinct families among the answered seats, in seat order. */
  readonly families: readonly ProviderFamily[];
  readonly spend: Spend;
}

interface PreparedSeat {
  readonly seat: PanelSeatSpec;
  readonly prompt: string;
}

/**
 * Prompts are built and scanned before any seat is invoked, so a hard-blocked secret stops the
 * whole panel rather than reaching whichever families were dispatched first.
 */
function prepareSeats<T>(seats: readonly PanelSeatSpec[], input: PanelInput<T>): PreparedSeat[] {
  return seats.map((seat) => {
    const scan = scanAndRedact(input.prompt(seat));
    if (scan.hardBlocked) {
      throw new Error(`Panel prompt for seat ${seat.id} contains a hard-blocked secret`);
    }
    return { seat, prompt: scan.redacted };
  });
}

function seatModel(seat: PanelSeatSpec, response: SeatResponse | undefined): PanelSeatModel {
  // The runner attests model identity independently of whether the seat's answer was usable: a
  // subscription seat can verify its model and then fail with `invalid-structured-answer`, and
  // that verification must survive here rather than being discarded because the overall status
  // was not `ok`. `verified` therefore reads the runner's own `modelIdentity`/`actualModel`, and
  // falls back to unverified only when the runner itself did not attest either.
  const verified =
    response?.status === 'ok'
      ? response.actualModel
      : ((response?.modelIdentity === 'verified' ? response.actualModel : undefined) ?? null);
  return {
    requested: seat.model,
    verified,
    verification: verified === null ? 'unverified' : 'verified',
  };
}

function seatTransport(response: SeatResponse | undefined): 'subscription' | 'api' | null {
  if (response?.credentialPath === undefined) return null;
  return response.credentialPath === 'api-key' ? 'api' : 'subscription';
}

function baseSeat(seat: PanelSeatSpec, response: SeatResponse | undefined): PanelSeatBase {
  return {
    id: seat.id,
    family: seat.family,
    model: seatModel(seat, response),
    lens: seat.lens.name,
    transport: seatTransport(response),
    fallback: response?.credentialFallback !== undefined,
    latencyMs: response?.latencyMs ?? null,
  };
}

function unservedSeat<T>(
  seat: PanelSeatSpec,
  status: 'skipped' | 'failed',
  code: string,
  reason: string,
  response?: SeatResponse,
): PanelSeat<T> {
  return { ...baseSeat(seat, response), status, code, reason };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
}

function judgeAnswer<T>(
  seat: PanelSeatSpec,
  response: Extract<SeatResponse, { status: 'ok' }>,
  answer: PanelAnswer<T>,
): PanelSeat<T> {
  const base = baseSeat(seat, response);
  const raw = response.answer;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      ...base,
      status: 'invalid',
      raw,
      code: 'invalid-answer',
      reason: 'answer is not valid JSON',
    };
  }
  const parsed = answer.schema.safeParse(value);
  if (!parsed.success) {
    return {
      ...base,
      status: 'invalid',
      raw,
      code: 'invalid-answer',
      reason: describeIssues(parsed.error),
    };
  }
  return { ...base, status: 'ok', answer: parsed.data, raw, code: null, reason: null };
}

/**
 * Under `never-metered` a seat whose subscription could not answer is unavailable, not broken:
 * the failures a metered key would have fixed, and the refusal the zero-cap ledger produces in
 * their place, are recorded as `skipped` so a fast mode's record reads "this voice was missing"
 * rather than "this voice errored". Integrity failures stay `failed`.
 */
function unavailableUnderNeverMetered(response: SeatResponse): boolean {
  if (response.status === 'ok') return false;
  return permitsCredentialFallback(response) || response.error.code === 'spend-cap';
}

async function invokeSeat<T>(
  config: PanelConfig,
  input: PanelInput<T>,
  prepared: PreparedSeat,
  ledger: SpendLedger,
  deadline: number,
): Promise<PanelSeat<T>> {
  const { seat, prompt } = prepared;
  const adapter = config.adapters[seat.family];
  if (adapter === undefined) {
    return unservedSeat(
      seat,
      'skipped',
      'adapter-unconfigured',
      'No configured adapter is available for this provider family.',
    );
  }
  const route = config.context.registry[seat.family];
  if (
    adapter.transport !== route.transport &&
    !route.alternateTransports?.includes(adapter.transport)
  ) {
    return unservedSeat(
      seat,
      'failed',
      'unsafe-transport',
      'The provider adapter transport does not match the governed route.',
    );
  }
  const remainingMs = Math.floor(deadline - Date.now());
  if (remainingMs <= 0) {
    return unservedSeat(
      seat,
      'failed',
      'timeout',
      'The panel deadline was reached before this seat could be invoked.',
    );
  }
  const request: ProviderRequest = {
    context: { ...config.context, timeoutMs: remainingMs, spend: ledger },
    seatId: seat.id,
    role: seat.lens.name,
    prompt,
    answer: { instruction: input.answer.instruction, jsonSchema: input.answer.jsonSchema },
  };

  let response: SeatResponse;
  try {
    const parsed = SeatResponseSchema.safeParse(await adapter.invoke(request));
    if (!parsed.success) {
      return unservedSeat(
        seat,
        'failed',
        'invalid-adapter-response',
        'The provider adapter returned an invalid seat response.',
      );
    }
    response = parsed.data;
  } catch (error) {
    const diagnostic =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Non-error value thrown';
    config.context.captureDiagnostic?.({
      family: seat.family,
      seatId: seat.id,
      code: 'adapter-exception',
      rawText: scanAndRedact(diagnostic).redacted,
    });
    return unservedSeat(
      seat,
      'failed',
      'adapter-exception',
      'The provider adapter invocation failed.',
    );
  }

  if (
    response.seatId !== seat.id ||
    response.provider !== seat.family ||
    response.role !== seat.lens.name
  ) {
    return unservedSeat(
      seat,
      'failed',
      'adapter-seat-mismatch',
      'The provider adapter response did not match its assigned seat.',
      response,
    );
  }
  if (response.status === 'ok') return judgeAnswer(seat, response, input.answer);
  if (response.status === 'skipped') {
    return unservedSeat(seat, 'skipped', response.error.code, response.error.message, response);
  }
  if (input.spend.policy === 'never-metered' && unavailableUnderNeverMetered(response)) {
    return unservedSeat(
      seat,
      'skipped',
      response.error.code,
      `metered fallback is disabled under the never-metered policy: ${response.error.message}`,
      response,
    );
  }
  return unservedSeat(seat, 'failed', response.error.code, response.error.message, response);
}

/**
 * A bounded worker pool rather than one `Promise.all` over every prepared seat. Workers draw the
 * next index from a shared cursor and write their result back at that index, so the returned array
 * stays in `seats` order however the seats interleave, and at most `concurrency` seats — and so at
 * most `concurrency` provider processes — are ever live.
 */
async function invokeSeats<T>(
  config: PanelConfig,
  input: PanelInput<T>,
  prepared: readonly PreparedSeat[],
  ledger: SpendLedger,
  deadline: number,
  concurrency: number,
): Promise<PanelSeat<T>[]> {
  const results: PanelSeat<T>[] = new Array<PanelSeat<T>>(prepared.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let index = next; index < prepared.length; index = next) {
      next += 1;
      const entry = prepared[index];
      if (entry === undefined) return;
      results[index] = await invokeSeat(config, input, entry, ledger, deadline);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, prepared.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function panelSpend<T>(spend: PanelSpend, seats: readonly PanelSeat<T>[]): Spend {
  const used = seats.filter((seat) => seat.transport === 'api').length;
  const fallbacks = seats.filter((seat) => seat.fallback).length;
  if (spend.policy === 'never-metered') {
    // No metered call was ever offered, so none was refused: a seat a fallback would have
    // rescued is recorded as skipped, and `used` stays honest if an adapter reports a metered
    // path regardless.
    return {
      billing: 'sub-only',
      policy: 'never-metered',
      cap: 0,
      used,
      fallbacks,
      refused: 0,
      stoppedAtCap: false,
    };
  }
  return {
    billing: spend.billing,
    policy: 'capped',
    cap: spend.ledger.cap,
    used,
    fallbacks,
    refused: spend.ledger.refused,
    stoppedAtCap: spend.ledger.refused > 0,
  };
}

/**
 * One blind round over N seats. Seats are invoked concurrently, up to `input.concurrency` at a
 * time, each with the prompt the caller built for it, so no seat can see another's output from
 * this round; the caller carries prior material as data through {@link untrustedBlock}. Each reply
 * is parsed as JSON and validated against the caller's schema, and a miss keeps the raw text as an
 * `invalid` seat. The panel deadline is shared: it starts before the first seat, so a seat the
 * pool reaches after it has passed fails as `timeout` rather than running past it.
 */
export async function runPanel<T>(
  config: PanelConfig,
  input: PanelInput<T>,
): Promise<PanelResult<T>> {
  const seats = PanelSeatSpecsSchema.parse(input.seats);
  const concurrency = PanelConcurrencySchema.parse(input.concurrency);
  if (input.answer.instruction.trim().length === 0) {
    throw new Error('A panel answer contract needs a non-blank instruction');
  }
  for (const family of new Set(seats.map((seat) => seat.family))) {
    const adapter = config.adapters[family];
    if (adapter !== undefined && adapter.family !== family) {
      throw new TypeError(
        `Provider adapter family mismatch: configured as ${family}, reports ${adapter.family}`,
      );
    }
  }
  const prepared = prepareSeats(seats, input);
  // `never-metered` is enforced with a ledger that has nothing to spend: every credential
  // fallback consults it through withCredentialFallback and refuses before the metered adapter
  // is touched, so a roster built with fallbacks still cannot reach a metered key from here.
  const ledger = input.spend.policy === 'capped' ? input.spend.ledger : createSpendLedger(0);
  const deadline = Date.now() + config.context.timeoutMs;
  const results = await invokeSeats(config, input, prepared, ledger, deadline, concurrency);
  const answered = results.filter((seat) => seat.status === 'ok');
  return {
    seats: results,
    answered: answered.length,
    families: [...new Set(answered.map((seat) => seat.family))],
    spend: panelSpend(input.spend, results),
  };
}

const UntrustedTagSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/**
 * Wrap material from an earlier pass or another seat as data. The text is escaped so nothing
 * inside can close the block or read as markup. Put `EVIDENCE_BOUNDARY_INSTRUCTION` once at the
 * top of any prompt that carries one of these.
 */
export function untrustedBlock(tag: string, text: string): string {
  const safeTag = UntrustedTagSchema.parse(tag);
  return `<untrusted-${safeTag}>\n${escapeUntrustedPromptText(text)}\n</untrusted-${safeTag}>`;
}

/** The envelope's view of a panel: the same fields the runner's seats carry, minus the answer. */
export function panelEnvelopeSeats(seats: readonly PanelSeat<unknown>[]): EnvelopeSeat[] {
  return seats.map((seat) => ({
    id: seat.id,
    family: seat.family,
    model: seat.model,
    lens: seat.lens,
    transport: seat.transport,
    fallback: seat.fallback,
    status: seat.status,
    reason: seat.reason,
  }));
}
