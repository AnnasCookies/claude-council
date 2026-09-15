import { describe, expect, test } from 'bun:test';
import {
  EnvelopeSeatSchema,
  ResultEnvelopeSchema,
  UNDECLARED_CALLER,
  buildEnvelope,
  type EnvelopeSeat,
} from '../../src/substrate/envelope';
import { panelEnvelopeSeats, type PanelSeat } from '../../src/substrate/patterns/panel';

const model = {
  requested: 'anthropic-primary',
  verified: 'anthropic-primary',
  verification: 'verified',
} as const;
const unverified = {
  requested: 'xai-primary',
  verified: null,
  verification: 'unverified',
} as const;

const panelSeats: PanelSeat<{ vote: string }>[] = [
  {
    id: 'anthropic/anthropic-primary#lens-1',
    family: 'anthropic',
    model,
    lens: 'lens-1',
    transport: 'subscription',
    fallback: false,
    latencyMs: 5,
    status: 'ok',
    answer: { vote: 'yes' },
    raw: '{"vote":"yes"}',
    code: null,
    reason: null,
  },
  {
    id: 'openai/openai-primary#lens-2',
    family: 'openai',
    model: { ...model, requested: 'openai-primary', verified: 'openai-primary' },
    lens: 'lens-2',
    transport: 'api',
    fallback: true,
    latencyMs: 7,
    status: 'invalid',
    raw: 'prose',
    code: 'invalid-answer',
    reason: 'answer is not valid JSON',
  },
  {
    id: 'xai/xai-primary#lens-3',
    family: 'xai',
    model: unverified,
    lens: 'lens-3',
    transport: null,
    fallback: false,
    latencyMs: null,
    status: 'skipped',
    code: 'missing-executable',
    reason: 'grok executable not found',
  },
];

describe('panel seats in the envelope', () => {
  test('maps panel seats to envelope seats, keeping invalid as its own status', () => {
    const seats = panelEnvelopeSeats(panelSeats);
    expect(seats).toHaveLength(3);
    expect(seats[0]).toEqual({
      id: 'anthropic/anthropic-primary#lens-1',
      family: 'anthropic',
      model,
      lens: 'lens-1',
      transport: 'subscription',
      fallback: false,
      status: 'ok',
      reason: null,
    });
    expect(seats[1]).toMatchObject({ status: 'invalid', transport: 'api', fallback: true });
    expect(seats[2]).toMatchObject({ status: 'skipped', reason: 'grok executable not found' });
    for (const seat of seats) expect(EnvelopeSeatSchema.parse(seat)).toEqual(seat);
  });

  test('builds a validated envelope from a handler outcome', () => {
    const seats: EnvelopeSeat[] = panelEnvelopeSeats(panelSeats);
    const envelope = buildEnvelope({
      mode: 'audience',
      session: 'au-2026-09-15-0a1b2c',
      caller: { kind: 'agent', harness: 'test', declared: true },
      pattern: 'parallel',
      rounds: 1,
      seats,
      output: { reactions: [] },
      synthesis: { by: 'anthropic/anthropic-primary#lens-1', text: 'One voice answered.' },
      dissent: [{ seat: 'openai/openai-primary#lens-2', position: 'unreadable' }],
      unanimous: false,
      spend: {
        billing: 'sub-only',
        policy: 'never-metered',
        cap: 0,
        used: 0,
        fallbacks: 0,
        refused: 0,
        stoppedAtCap: false,
      },
      degraded: ['one-voice-missing'],
      record: { session: 'general/modes/audience/au-2026-09-15-0a1b2c.jsonl' },
    });
    expect(envelope.rounds).toBe(1);
    expect(envelope.seats).toHaveLength(3);
    expect(envelope.synthesis?.by).toBe('anthropic/anthropic-primary#lens-1');
    expect(envelope.dissent).toHaveLength(1);
    expect(envelope.unanimous).toBe(false);
    expect(ResultEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => buildEnvelope({ ...envelopeInput(seats), rounds: 4 })).toThrow();
  });

  test('the runner-backed input still derives seats and unanimity itself', () => {
    const envelope = buildEnvelope({
      mode: 'second-opinion',
      session: 'run-1',
      caller: UNDECLARED_CALLER,
      pattern: 'parallel',
      rounds: [],
      assignments: [],
      output: {},
      spend: {
        billing: 'sub-first',
        policy: 'capped',
        cap: 1,
        used: 0,
        fallbacks: 0,
        refused: 0,
        stoppedAtCap: false,
      },
      degraded: [],
      record: { session: null },
    });
    expect(envelope.rounds).toBe(0);
    expect(envelope.seats).toEqual([]);
    expect(envelope.unanimous).toBe(false);
    expect(envelope.synthesis).toBeNull();
  });
});

function envelopeInput(seats: EnvelopeSeat[]) {
  return {
    mode: 'audience',
    session: 'au-2026-09-15-0a1b2c',
    caller: UNDECLARED_CALLER,
    pattern: 'parallel' as const,
    rounds: 1,
    seats,
    output: {},
    synthesis: null,
    dissent: null,
    unanimous: false,
    spend: {
      billing: 'sub-only' as const,
      policy: 'never-metered' as const,
      cap: 0,
      used: 0,
      fallbacks: 0,
      refused: 0,
      stoppedAtCap: false,
    },
    degraded: [],
    record: { session: null },
  };
}
