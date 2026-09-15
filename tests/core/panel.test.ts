import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type {
  ModelTransport,
  ProviderFamily,
  SeatResponse,
} from '../../src/substrate/domain/schemas';
import {
  withCredentialFallback,
  type Availability,
  type HealthResult,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDiagnostic,
  type ProviderRequest,
} from '../../src/substrate/execution/provider';
import type { ModelRegistry } from '../../src/substrate/models/registry';
import {
  runPanel,
  spreadSeats,
  untrustedBlock,
  type PanelLens,
  type PanelSpend,
} from '../../src/substrate/patterns/panel';
import { createSpendLedger } from '../../src/substrate/spend';

const registry: ModelRegistry = {
  anthropic: { primary: 'anthropic-primary', fallbacks: [], transport: 'subscription-cli' },
  openai: { primary: 'openai-primary', fallbacks: [], transport: 'subscription-cli' },
  xai: { primary: 'xai-primary', fallbacks: [], transport: 'subscription-cli' },
  google: { primary: 'google-primary', fallbacks: [], transport: 'subscription-cli' },
  deepseek: { primary: 'deepseek-primary', fallbacks: [], transport: 'http' },
  moonshot: { primary: 'moonshot-primary', fallbacks: [], transport: 'http' },
};

function context(diagnostics: ProviderDiagnostic[] = []): ProviderContext {
  return {
    registry,
    env: {},
    cwd: 'C:/isolated/panel',
    timeoutMs: 1_000,
    captureDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
}

type FakeReply = (request: ProviderRequest) => SeatResponse | Promise<SeatResponse>;

class FakeAdapter implements ProviderAdapter {
  readonly calls: ProviderRequest[] = [];

  constructor(
    readonly family: ProviderFamily,
    private readonly reply: FakeReply,
    readonly transport: ModelTransport = registry[family].transport,
  ) {}

  async availability(): Promise<Availability> {
    return {
      status: 'available',
      provider: this.family,
      model: registry[this.family].primary,
      reason: '',
    };
  }

  async invoke(request: ProviderRequest): Promise<SeatResponse> {
    this.calls.push(request);
    return this.reply(request);
  }

  async probe(): Promise<HealthResult> {
    return {
      status: 'healthy',
      provider: this.family,
      requestedModel: registry[this.family].primary,
      actualModel: registry[this.family].primary,
      latencyMs: 1,
      reason: '',
    };
  }
}

function ok(
  request: ProviderRequest,
  family: ProviderFamily,
  answer: string,
  extra: Partial<Extract<SeatResponse, { status: 'ok' }>> = {},
): SeatResponse {
  return {
    status: 'ok',
    seatId: request.seatId,
    provider: family,
    requestedModel: registry[family].primary,
    actualModel: registry[family].primary,
    modelIdentity: 'verified',
    route: 'primary',
    role: request.role,
    latencyMs: 5,
    answer,
    credentialPath: 'subscription',
    ...extra,
  };
}

function unsuccessful(
  request: ProviderRequest,
  family: ProviderFamily,
  status: 'failed' | 'skipped' | 'timed-out',
  code: string,
  message = `${code} happened`,
): SeatResponse {
  return {
    status,
    seatId: request.seatId,
    provider: family,
    requestedModel: registry[family].primary,
    role: request.role,
    latencyMs: 1,
    error: { code, message, retryable: false },
  };
}

const VoteSchema = z.strictObject({ vote: z.enum(['yes', 'no']), note: z.string().min(1) });
const answer = {
  schema: VoteSchema,
  instruction:
    'Return exactly one JSON object with these keys: vote ("yes" or "no"), note (string). Do not wrap it in prose.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['vote', 'note'],
    properties: {
      vote: { type: 'string', enum: ['yes', 'no'] },
      note: { type: 'string', minLength: 1 },
    },
  },
};

function lenses(count: number): PanelLens[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `lens-${index + 1}`,
    description: `Lens ${index + 1} looks at the motion from angle ${index + 1}.`,
  }));
}

function capped(cap = 3): PanelSpend {
  return { policy: 'capped', billing: 'sub-first', ledger: createSpendLedger(cap) };
}

describe('spreadSeats', () => {
  test('deals lenses over families round-robin, one seat per lens', () => {
    const seats = spreadSeats(['anthropic', 'openai', 'xai', 'google'], lenses(12), registry);
    expect(seats).toHaveLength(12);
    const perFamily = new Map<string, number>();
    for (const seat of seats) perFamily.set(seat.family, (perFamily.get(seat.family) ?? 0) + 1);
    expect([...perFamily.entries()]).toEqual([
      ['anthropic', 3],
      ['openai', 3],
      ['xai', 3],
      ['google', 3],
    ]);
    expect(seats[0]).toEqual({
      id: 'anthropic/anthropic-primary#lens-1',
      family: 'anthropic',
      model: 'anthropic-primary',
      lens: lenses(1)[0]!,
    });
    expect(seats[4]?.family).toBe('anthropic');
    expect(seats[4]?.lens.name).toBe('lens-5');
  });

  test('rejects empty inputs, duplicate families and a lens repeated on one family', () => {
    expect(() => spreadSeats([], lenses(2), registry)).toThrow();
    expect(() => spreadSeats(['anthropic'], [], registry)).toThrow();
    expect(() => spreadSeats(['anthropic', 'anthropic'], lenses(2), registry)).toThrow(/distinct/);
    const repeated = [lenses(1)[0]!, lenses(1)[0]!];
    expect(() => spreadSeats(['anthropic'], repeated, registry)).toThrow(
      /Duplicate seat identifier/,
    );
    expect(() =>
      spreadSeats(['anthropic'], [{ name: 'bad name', description: 'x' }], registry),
    ).toThrow();
  });
});

describe('runPanel', () => {
  test('invokes every seat in parallel and blind with the prompt built for that seat', async () => {
    const seats = spreadSeats(['anthropic', 'openai'], lenses(3), registry);
    let received = 0;
    const { promise: everyoneArrived, resolve: release } = Promise.withResolvers<void>();
    const reply: FakeReply = async (request) => {
      received += 1;
      if (received === seats.length) release();
      // A seat that only answers once every seat has been called proves the calls were issued
      // together rather than one after another.
      await everyoneArrived;
      return ok(
        request,
        request.seatId.startsWith('anthropic') ? 'anthropic' : 'openai',
        '{"vote":"yes","note":"fine"}',
      );
    };
    const anthropic = new FakeAdapter('anthropic', reply);
    const openai = new FakeAdapter('openai', reply);
    const result = await runPanel(
      { adapters: { anthropic, openai }, context: context() },
      {
        seats,
        prompt: (seat) => `As ${seat.lens.name}: ${seat.lens.description}`,
        answer,
        spend: capped(),
      },
    );
    expect(result.answered).toBe(3);
    expect(result.families).toEqual(['anthropic', 'openai']);
    expect(result.seats.map((seat) => seat.status)).toEqual(['ok', 'ok', 'ok']);
    const first = result.seats[0];
    if (first?.status !== 'ok') throw new Error('unreachable');
    expect(first.answer).toEqual({ vote: 'yes', note: 'fine' });
    expect(first.raw).toBe('{"vote":"yes","note":"fine"}');
    const requests = [...anthropic.calls, ...openai.calls];
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const seat = seats.find((candidate) => candidate.id === request.seatId);
      if (seat === undefined) throw new Error(`unknown seat ${request.seatId}`);
      expect(request.role).toBe(seat.lens.name);
      expect(request.prompt).toBe(`As ${seat.lens.name}: ${seat.lens.description}`);
      for (const other of seats) {
        if (other.id !== seat.id) expect(request.prompt).not.toContain(other.lens.description);
      }
      expect(request.answer?.instruction).toBe(answer.instruction);
      expect(request.answer?.jsonSchema).toEqual(answer.jsonSchema);
    }
  });

  test('records ok, invalid, skipped and failed seats with identity, transport and the raw text', async () => {
    const seats = spreadSeats(['anthropic', 'openai', 'xai', 'google'], lenses(4), registry);
    const adapters = {
      anthropic: new FakeAdapter('anthropic', (request) =>
        ok(request, 'anthropic', '{"vote":"no","note":"risky"}', { credentialPath: 'api-key' }),
      ),
      openai: new FakeAdapter('openai', (request) => ok(request, 'openai', 'I would say yes.')),
      xai: new FakeAdapter('xai', (request) =>
        unsuccessful(request, 'xai', 'skipped', 'missing-executable'),
      ),
      google: new FakeAdapter('google', (request) =>
        unsuccessful(request, 'google', 'timed-out', 'timeout'),
      ),
    };
    const result = await runPanel(
      { adapters, context: context() },
      { seats, prompt: (seat) => seat.lens.description, answer, spend: capped() },
    );
    expect(result.answered).toBe(1);
    expect(result.families).toEqual(['anthropic']);
    expect(result.seats.map((seat) => seat.status)).toEqual(['ok', 'invalid', 'skipped', 'failed']);
    expect(result.seats[0]).toMatchObject({
      id: 'anthropic/anthropic-primary#lens-1',
      model: {
        requested: 'anthropic-primary',
        verified: 'anthropic-primary',
        verification: 'verified',
      },
      transport: 'api',
      fallback: false,
      latencyMs: 5,
    });
    const invalid = result.seats[1];
    if (invalid?.status !== 'invalid') throw new Error('unreachable');
    expect(invalid.raw).toBe('I would say yes.');
    expect(invalid.reason).toContain('not valid JSON');
    expect(invalid.model.verification).toBe('verified');
    expect(result.seats[2]).toMatchObject({
      status: 'skipped',
      code: 'missing-executable',
      reason: 'missing-executable happened',
      model: { requested: 'xai-primary', verified: null, verification: 'unverified' },
      transport: null,
    });
    expect(result.seats[3]).toMatchObject({ status: 'failed', code: 'timeout' });
    expect(result.spend).toEqual({
      billing: 'sub-first',
      policy: 'capped',
      cap: 3,
      used: 1,
      fallbacks: 0,
      refused: 0,
      stoppedAtCap: false,
    });
  });

  test('an answer that parses but misses the schema is invalid and names the issue', async () => {
    const seats = spreadSeats(['anthropic'], lenses(1), registry);
    const anthropic = new FakeAdapter('anthropic', (request) =>
      ok(request, 'anthropic', '{"vote":"maybe"}'),
    );
    const result = await runPanel(
      { adapters: { anthropic }, context: context() },
      { seats, prompt: () => 'p', answer, spend: capped() },
    );
    const seat = result.seats[0];
    if (seat?.status !== 'invalid') throw new Error('unreachable');
    expect(seat.raw).toBe('{"vote":"maybe"}');
    expect(seat.reason).toContain('vote');
    expect(seat.reason).toContain('note');
  });

  test('an unconfigured family, an unsafe transport, a throwing adapter and a mismatched echo never throw', async () => {
    const diagnostics: ProviderDiagnostic[] = [];
    const seats = spreadSeats(['anthropic', 'openai', 'xai', 'google'], lenses(4), registry);
    const adapters = {
      openai: new FakeAdapter(
        'openai',
        (request) => ok(request, 'openai', '{"vote":"yes","note":"n"}'),
        'http',
      ),
      xai: new FakeAdapter('xai', () => {
        throw new Error('boom');
      }),
      google: new FakeAdapter('google', (request) =>
        ok({ ...request, seatId: 'someone-else' }, 'google', '{"vote":"yes","note":"n"}'),
      ),
    };
    const result = await runPanel(
      { adapters, context: context(diagnostics) },
      { seats, prompt: () => 'p', answer, spend: capped() },
    );
    expect(result.seats.map((seat) => [seat.status, seat.code])).toEqual([
      ['skipped', 'adapter-unconfigured'],
      ['failed', 'unsafe-transport'],
      ['failed', 'adapter-exception'],
      ['failed', 'adapter-seat-mismatch'],
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['adapter-exception']);
    expect(result.answered).toBe(0);
  });

  test('never-metered cannot reach a metered transport: the seat is skipped, not served', async () => {
    const seats = spreadSeats(['xai'], lenses(1), registry);
    const metered = new FakeAdapter(
      'xai',
      (request) =>
        ok(request, 'xai', '{"vote":"yes","note":"paid"}', { credentialPath: 'api-key' }),
      'http',
    );
    const subscription = new FakeAdapter('xai', (request) =>
      unsuccessful(request, 'xai', 'failed', 'quota-exhausted', 'subscription spent'),
    );
    const xai = withCredentialFallback(subscription, () => metered, 'http');

    const refused = await runPanel(
      { adapters: { xai }, context: context() },
      { seats, prompt: () => 'p', answer, spend: { policy: 'never-metered' } },
    );
    expect(metered.calls).toHaveLength(0);
    expect(refused.seats[0]).toMatchObject({
      status: 'skipped',
      code: 'spend-cap',
      transport: null,
      fallback: false,
    });
    expect(refused.seats[0]?.reason).toContain('never-metered');
    expect(refused.seats[0]?.reason).toContain('quota-exhausted');
    expect(refused.spend).toEqual({
      billing: 'sub-only',
      policy: 'never-metered',
      cap: 0,
      used: 0,
      fallbacks: 0,
      refused: 0,
      stoppedAtCap: false,
    });

    const served = await runPanel(
      { adapters: { xai }, context: context() },
      { seats, prompt: () => 'p', answer, spend: capped(1) },
    );
    expect(metered.calls).toHaveLength(1);
    expect(served.seats[0]).toMatchObject({ status: 'ok', transport: 'api', fallback: true });
    expect(served.spend).toMatchObject({ used: 1, fallbacks: 1, refused: 0, stoppedAtCap: false });
  });

  test('a bare subscription failure under never-metered is skipped, an integrity failure stays failed', async () => {
    const seats = spreadSeats(['anthropic', 'openai'], lenses(2), registry);
    const adapters = {
      anthropic: new FakeAdapter('anthropic', (request) =>
        unsuccessful(request, 'anthropic', 'failed', 'quota-exhausted'),
      ),
      openai: new FakeAdapter('openai', (request) =>
        unsuccessful(request, 'openai', 'failed', 'identity-unverified'),
      ),
    };
    const result = await runPanel(
      { adapters, context: context() },
      { seats, prompt: () => 'p', answer, spend: { policy: 'never-metered' } },
    );
    expect(result.seats.map((seat) => [seat.status, seat.code])).toEqual([
      ['skipped', 'quota-exhausted'],
      ['failed', 'identity-unverified'],
    ]);
  });

  test('the capped ledger reaches every seat request', async () => {
    const seats = spreadSeats(['anthropic'], lenses(1), registry);
    const anthropic = new FakeAdapter('anthropic', (request) =>
      ok(request, 'anthropic', '{"vote":"yes","note":"n"}'),
    );
    const spend = capped(2);
    await runPanel(
      { adapters: { anthropic }, context: context() },
      { seats, prompt: () => 'p', answer, spend },
    );
    if (spend.policy !== 'capped') throw new Error('unreachable');
    expect(anthropic.calls[0]?.context.spend).toBe(spend.ledger);
    expect(anthropic.calls[0]?.context.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  test('a hard-blocked secret in any prompt stops the panel before any seat is invoked', async () => {
    const seats = spreadSeats(['anthropic', 'openai'], lenses(2), registry);
    const anthropic = new FakeAdapter('anthropic', (request) =>
      ok(request, 'anthropic', '{"vote":"yes","note":"n"}'),
    );
    const openai = new FakeAdapter('openai', (request) =>
      ok(request, 'openai', '{"vote":"yes","note":"n"}'),
    );
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    await expect(
      runPanel(
        { adapters: { anthropic, openai }, context: context() },
        {
          seats,
          prompt: (seat) => (seat.family === 'openai' ? `token=${secret}` : 'clean'),
          answer,
          spend: capped(),
        },
      ),
    ).rejects.toThrow(/hard-blocked secret/);
    expect(anthropic.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
  });

  test('rejects an adapter registered under the wrong family', async () => {
    const seats = spreadSeats(['anthropic'], lenses(1), registry);
    const mislabelled = new FakeAdapter('openai', (request) => ok(request, 'openai', '{}'));
    await expect(
      runPanel(
        { adapters: { anthropic: mislabelled }, context: context() },
        { seats, prompt: () => 'p', answer, spend: capped() },
      ),
    ).rejects.toThrow(/family mismatch/);
  });
});

describe('untrustedBlock', () => {
  test('escapes the text and names the block', () => {
    expect(untrustedBlock('prior-ideas', '<x> & "y"')).toBe(
      '<untrusted-prior-ideas>\n&lt;x&gt; &amp; &quot;y&quot;\n</untrusted-prior-ideas>',
    );
    expect(() => untrustedBlock('Prior Ideas', 'x')).toThrow();
  });
});
