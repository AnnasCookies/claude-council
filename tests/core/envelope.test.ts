import { describe, expect, test } from 'bun:test';
import type { SeatResponse } from '../../src/substrate/domain/schemas';
import type { CouncilSeatAssignment, RoundExecution } from '../../src/substrate/execution/runner';
import {
  MAX_ENVELOPE_ROUNDS,
  ResultEnvelopeSchema,
  UNDECLARED_CALLER,
  buildEnvelope,
  detectUnanimity,
  envelopeSeats,
  spendFromRounds,
} from '../../src/substrate/envelope';

function answer(recommendation: string): string {
  return JSON.stringify({
    recommendation,
    evidence: ['e'],
    assumptions: ['a'],
    risks: ['r'],
    uncertainty: 'low',
    decisiveTest: 'run it',
  });
}

function ok(
  seatId: string,
  provider: SeatResponse['provider'],
  recommendation: string,
  extra: Partial<Extract<SeatResponse, { status: 'ok' }>> = {},
): SeatResponse {
  return {
    status: 'ok',
    seatId,
    provider,
    requestedModel: `${provider}-primary`,
    actualModel: `${provider}-primary`,
    modelIdentity: 'verified',
    route: 'primary',
    role: 'architect',
    latencyMs: 10,
    answer: answer(recommendation),
    ...extra,
  };
}

function failed(seatId: string, provider: SeatResponse['provider'], code: string): SeatResponse {
  return {
    status: 'failed',
    seatId,
    provider,
    role: 'architect',
    error: { code, message: `${code} happened`, retryable: false },
  };
}

const assignments: CouncilSeatAssignment[] = [
  {
    seatId: 'anthropic-seat',
    provider: 'anthropic',
    lensName: 'architect',
    lensPrompt: 'p',
    lensCategory: 'domain',
  },
  {
    seatId: 'openai-seat',
    provider: 'openai',
    lensName: 'critic',
    lensPrompt: 'p',
    lensCategory: 'contrarian',
  },
  {
    seatId: 'xai-seat',
    provider: 'xai',
    lensName: 'security',
    lensPrompt: 'p',
    lensCategory: 'risk',
  },
];

const rounds: RoundExecution[] = [
  {
    round: 1,
    phase: 'analysis',
    retries: [],
    responses: [
      ok('anthropic-seat', 'anthropic', 'Adopt X', { credentialPath: 'subscription' }),
      ok('openai-seat', 'openai', 'adopt x ', {
        credentialPath: 'api-key',
        credentialFallback: {
          fromTransport: 'subscription-cli',
          toTransport: 'http',
          reason: 'quota-exhausted',
        },
      }),
      failed('xai-seat', 'xai', 'missing-executable'),
    ],
  },
];

describe('result envelope', () => {
  test('maps assignments and responses to seats', () => {
    const seats = envelopeSeats({ assignments, rounds });
    expect(seats).toHaveLength(3);
    expect(seats[0]).toEqual({
      id: 'anthropic/anthropic-primary#architect',
      family: 'anthropic',
      model: {
        requested: 'anthropic-primary',
        verified: 'anthropic-primary',
        verification: 'verified',
      },
      lens: 'architect',
      transport: 'subscription',
      fallback: false,
      status: 'ok',
      reason: null,
    });
    expect(seats[1]).toMatchObject({ transport: 'api', fallback: true, status: 'ok' });
    expect(seats[2]).toMatchObject({
      id: 'xai/unresolved#security',
      model: { requested: null, verified: null, verification: 'unverified' },
      transport: null,
      status: 'failed',
      reason: 'missing-executable happened',
    });
  });

  test('flags unanimity only when two or more verified answers agree after normalisation', () => {
    expect(detectUnanimity(rounds)).toBe(true);
    const split: RoundExecution[] = [
      {
        ...rounds[0]!,
        responses: [ok('a', 'anthropic', 'Adopt X'), ok('b', 'openai', 'Reject X')],
      },
    ];
    expect(detectUnanimity(split)).toBe(false);
    const lonely: RoundExecution[] = [
      { ...rounds[0]!, responses: [ok('a', 'anthropic', 'Adopt X')] },
    ];
    expect(detectUnanimity(lonely)).toBe(false);
    expect(detectUnanimity([])).toBe(false);
  });

  test('summarises spend from the credential paths actually used', () => {
    expect(
      spendFromRounds(rounds, { billing: 'sub-first', policy: 'capped', cap: 3, refused: 0 }),
    ).toEqual({
      billing: 'sub-first',
      policy: 'capped',
      cap: 3,
      used: 1,
      fallbacks: 1,
      refused: 0,
      stoppedAtCap: false,
    });
    expect(
      spendFromRounds(rounds, { billing: 'sub-first', policy: 'capped', cap: 0, refused: 2 })
        .stoppedAtCap,
    ).toBe(true);
  });

  test('builds a validated envelope and rejects an invalid one', () => {
    const envelope = buildEnvelope({
      mode: 'second-opinion',
      session: 'run-1',
      caller: UNDECLARED_CALLER,
      pattern: 'parallel',
      rounds,
      assignments,
      output: { outcome: 'completed' },
      spend: spendFromRounds(rounds, {
        billing: 'sub-first',
        policy: 'capped',
        cap: 3,
        refused: 0,
      }),
      degraded: ['caller-undeclared'],
      record: { session: null },
    });
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.rounds).toBe(1);
    expect(envelope.unanimous).toBe(true);
    expect(envelope.synthesis).toBeNull();
    expect(envelope.dissent).toBeNull();
    expect(ResultEnvelopeSchema.parse(envelope)).toEqual(envelope);
    // The runner keeps its own ceiling of three; the envelope carries a handler mode's own rounds
    // up to MAX_ENVELOPE_ROUNDS, and refuses a mode that has lost count beyond it.
    expect(MAX_ENVELOPE_ROUNDS).toBe(6);
    expect(ResultEnvelopeSchema.parse({ ...envelope, rounds: MAX_ENVELOPE_ROUNDS }).rounds).toBe(6);
    expect(() =>
      ResultEnvelopeSchema.parse({ ...envelope, rounds: MAX_ENVELOPE_ROUNDS + 1 }),
    ).toThrow();
    expect(() => ResultEnvelopeSchema.parse({ ...envelope, extra: true })).toThrow();
  });
});
