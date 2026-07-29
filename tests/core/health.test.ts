import { beforeEach, describe, expect, test } from 'bun:test';
import type { ModelTransport, SeatResponse } from '../../src/domain/schemas';
import type {
  Availability,
  HealthResult,
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
} from '../../src/execution/provider';
import { compareBaseline, snapshot } from '../../src/health/baseline';
import { probeRoster } from '../../src/health/probe';
import { loadModelRegistry, type ModelRegistry } from '../../src/models/registry';

const CAPTURED_AT = '2026-07-28T00:00:00.000Z';

class FakeAdapter implements ProviderAdapter {
  readonly transport: ModelTransport;
  availabilityCalls = 0;
  probeCalls = 0;

  constructor(
    readonly family: HealthResult['provider'],
    private readonly available: Availability,
    private readonly health: HealthResult,
    transport: ModelTransport = 'http',
  ) {
    this.transport = transport;
  }

  async availability(_context: ProviderContext): Promise<Availability> {
    this.availabilityCalls += 1;
    return this.available;
  }

  async invoke(_request: ProviderRequest): Promise<SeatResponse> {
    throw new Error('probeRoster must use the probe contract');
  }

  async probe(_context: ProviderContext): Promise<HealthResult> {
    this.probeCalls += 1;
    return this.health;
  }
}

let registry: ModelRegistry;
let context: ProviderContext;

beforeEach(async () => {
  registry = await loadModelRegistry();
  context = {
    registry,
    env: {},
    cwd: 'C:/private/project-root',
    timeoutMs: 1_000,
  };
});

function fakeAdapter(
  provider: HealthResult['provider'],
  health: Partial<HealthResult> & Pick<HealthResult, 'status'>,
): FakeAdapter {
  const requestedModel = registry[provider].primary;
  return new FakeAdapter(
    provider,
    { status: 'available', provider, model: requestedModel, reason: '' },
    {
      provider,
      requestedModel,
      actualModel: requestedModel,
      latencyMs: 10,
      reason: '',
      ...health,
    },
    registry[provider].transport,
  );
}

describe('provider health probes', () => {
  test('marks a successful route with no observable actual model as identity-unverified', async () => {
    const adapter = fakeAdapter('anthropic', {
      status: 'healthy',
      actualModel: null,
    });

    const [result] = await probeRoster([adapter], context);

    expect(result).toMatchObject({
      provider: 'anthropic',
      availability: 'available',
      status: 'identity-unverified',
      requestedModel: registry.anthropic.primary,
      actualModel: null,
    });
    expect(adapter.availabilityCalls).toBe(1);
    expect(adapter.probeCalls).toBe(1);
  });

  test('does not probe an unconfigured or unsafe transport', async () => {
    const unconfigured = new FakeAdapter(
      'openai',
      {
        status: 'unconfigured',
        provider: 'openai',
        model: registry.openai.primary,
        reason: 'missing OPENAI_API_KEY',
      },
      {
        status: 'healthy',
        provider: 'openai',
        requestedModel: registry.openai.primary,
        actualModel: registry.openai.primary,
        latencyMs: 1,
        reason: '',
      },
      'subscription-cli',
    );
    const unsafe = new FakeAdapter(
      'anthropic',
      {
        status: 'unsafe-transport',
        provider: 'anthropic',
        model: registry.anthropic.primary,
        reason: 'executable is not absolute',
      },
      {
        status: 'healthy',
        provider: 'anthropic',
        requestedModel: registry.anthropic.primary,
        actualModel: registry.anthropic.primary,
        latencyMs: 1,
        reason: '',
      },
      'cli',
    );

    const results = await probeRoster([unconfigured, unsafe], context);

    expect(results.map(({ status }) => status)).toEqual(['unconfigured', 'unsafe-transport']);
    expect(unconfigured.probeCalls).toBe(0);
    expect(unsafe.probeCalls).toBe(0);
  });
});

describe('health baselines', () => {
  test('reports partial degradation without calling it a total outage', async () => {
    const baseline = snapshot(
      await probeRoster(
        [fakeAdapter('openai', { status: 'healthy' }), fakeAdapter('xai', { status: 'healthy' })],
        context,
      ),
      registry,
      CAPTURED_AT,
    );
    const current = snapshot(
      await probeRoster(
        [
          fakeAdapter('openai', { status: 'down', actualModel: null, reason: 'network failure' }),
          fakeAdapter('xai', { status: 'healthy', latencyMs: 250 }),
        ],
        context,
      ),
      registry,
      CAPTURED_AT,
    );

    const comparison = compareBaseline(baseline, current);

    expect(comparison.regression).toBe(true);
    expect(comparison.totalOutage).toBe(false);
    expect(comparison.newlyUnavailable).toEqual([
      { provider: 'openai', previousStatus: 'healthy', currentStatus: 'down' },
    ]);
  });

  test('reports a complete outage', async () => {
    const providers = ['openai', 'xai'] as const;
    const baseline = snapshot(
      await probeRoster(
        providers.map((provider) => fakeAdapter(provider, { status: 'healthy' })),
        context,
      ),
      registry,
      CAPTURED_AT,
    );
    const current = snapshot(
      await probeRoster(
        providers.map((provider) =>
          fakeAdapter(provider, { status: 'down', actualModel: null, reason: 'unreachable' }),
        ),
        context,
      ),
      registry,
      CAPTURED_AT,
    );

    const comparison = compareBaseline(baseline, current);

    expect(comparison.totalOutage).toBe(true);
    expect(comparison.newlyUnavailable.map(({ provider }) => provider)).toEqual([...providers]);
  });

  test('does not regress a healthy matching baseline because latency changed', async () => {
    const baseline = snapshot(
      await probeRoster([fakeAdapter('google', { status: 'healthy', latencyMs: 10 })], context),
      registry,
      CAPTURED_AT,
    );
    const current = snapshot(
      await probeRoster([fakeAdapter('google', { status: 'healthy', latencyMs: 900 })], context),
      registry,
      CAPTURED_AT,
    );

    expect(compareBaseline(baseline, current)).toMatchObject({
      regression: false,
      totalOutage: false,
      newlyUnavailable: [],
      actualModelChanges: [],
      routeChanges: [],
    });
  });

  test('reports configured-route and observed-model drift', async () => {
    const baseline = snapshot(
      await probeRoster([fakeAdapter('openai', { status: 'healthy' })], context),
      registry,
      CAPTURED_AT,
    );
    const changedRegistry: ModelRegistry = {
      ...registry,
      openai: { ...registry.openai, primary: 'gpt-5.7-sol' },
    };
    const changedContext = { ...context, registry: changedRegistry };
    const current = snapshot(
      await probeRoster(
        [
          new FakeAdapter(
            'openai',
            {
              status: 'available',
              provider: 'openai',
              model: 'gpt-5.7-sol',
              reason: '',
            },
            {
              status: 'healthy',
              provider: 'openai',
              requestedModel: 'gpt-5.7-sol',
              actualModel: 'gpt-5.7-sol',
              latencyMs: 10,
              reason: '',
            },
            'subscription-cli',
          ),
        ],
        changedContext,
      ),
      changedRegistry,
      CAPTURED_AT,
    );

    const comparison = compareBaseline(baseline, current);

    expect(comparison.regression).toBe(true);
    expect(comparison.routeChanges.map(({ provider }) => provider)).toEqual(['openai']);
    expect(comparison.actualModelChanges).toEqual([
      { provider: 'openai', previousActualModel: 'gpt-5.6-sol', currentActualModel: 'gpt-5.7-sol' },
    ]);
  });

  test('does not treat recovery or changes between unavailable states as regressions', async () => {
    const baseline = snapshot(
      await probeRoster(
        [fakeAdapter('deepseek', { status: 'down', actualModel: null, reason: 'unreachable' })],
        context,
      ),
      registry,
      CAPTURED_AT,
    );
    const current = snapshot(
      await probeRoster([fakeAdapter('deepseek', { status: 'healthy' })], context),
      registry,
      CAPTURED_AT,
    );

    expect(compareBaseline(baseline, current).regression).toBe(false);
  });
});
