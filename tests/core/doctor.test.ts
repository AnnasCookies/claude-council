import { beforeEach, describe, expect, test } from 'bun:test';
import type { SeatResponse } from '../../src/domain/schemas';
import type {
  Availability,
  HealthResult,
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
} from '../../src/execution/provider';
import { doctor } from '../../src/health/doctor';
import { loadModelRegistry, type ModelRegistry } from '../../src/models/registry';

const CAPTURED_AT = '2026-07-28T00:00:00.000Z';

class DiagnosticAdapter implements ProviderAdapter {
  constructor(
    readonly family: HealthResult['provider'],
    readonly transport: 'http' | 'cli',
    private readonly available: Availability,
    private readonly health: HealthResult,
  ) {}

  async availability(_context: ProviderContext): Promise<Availability> {
    return this.available;
  }

  async invoke(_request: ProviderRequest): Promise<SeatResponse> {
    throw new Error('doctor must use provider health contracts');
  }

  async probe(_context: ProviderContext): Promise<HealthResult> {
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

function diagnosticAdapter(
  provider: HealthResult['provider'],
  status: HealthResult['status'],
  reason = '',
): DiagnosticAdapter {
  const route = registry[provider];
  return new DiagnosticAdapter(
    provider,
    route.transport,
    { status: 'available', provider, model: route.primary, reason: '' },
    {
      status,
      provider,
      requestedModel: route.primary,
      actualModel: status === 'healthy' ? route.primary : null,
      latencyMs: 25,
      reason,
    },
  );
}

describe('doctor diagnostics', () => {
  test('returns structured diagnostics and remediation for partial degradation', async () => {
    const report = await doctor(
      [
        diagnosticAdapter('openai', 'healthy'),
        diagnosticAdapter('xai', 'down', 'provider unreachable'),
      ],
      context,
      CAPTURED_AT,
    );

    expect(report.status).toBe('degraded');
    expect(report.totalOutage).toBe(false);
    expect(report.diagnostics).toHaveLength(2);
    expect(report.diagnostics[0]).toMatchObject({
      provider: 'openai',
      resolution: { kind: 'endpoint', status: 'resolved' },
      toolIsolation: 'not-applicable',
      status: 'healthy',
      errorCategory: 'none',
    });
    expect(report.diagnostics[1]).toMatchObject({
      provider: 'xai',
      status: 'down',
      errorCategory: 'provider-down',
    });
    expect(report.remediations).toEqual([
      {
        provider: 'xai',
        code: 'restore-provider',
        action: 'Check provider reachability and retry the route probe.',
      },
    ]);
  });

  test('reports complete outage separately from partial degradation', async () => {
    const report = await doctor(
      [
        diagnosticAdapter('openai', 'down', 'network failure'),
        diagnosticAdapter('google', 'down', 'network failure'),
      ],
      context,
      CAPTURED_AT,
    );

    expect(report.status).toBe('unavailable');
    expect(report.totalOutage).toBe(true);
  });

  test('reports unknown actual model identity without claiming a healthy route', async () => {
    const report = await doctor(
      [diagnosticAdapter('anthropic', 'identity-unverified', 'model identity unavailable')],
      context,
      CAPTURED_AT,
    );

    expect(report.status).toBe('degraded');
    expect(report.diagnostics[0]).toMatchObject({
      status: 'identity-unverified',
      actualModel: null,
      identity: 'unverified',
      errorCategory: 'identity-unverified',
    });
    expect(report.remediations.map(({ code }) => code)).toEqual(['verify-model-identity']);
  });

  test('never serialises credentials from configuration or provider diagnostics', async () => {
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const secretRegistry: ModelRegistry = {
      ...registry,
      openai: { ...registry.openai, primary: secret },
    };
    const secretContext: ProviderContext = {
      ...context,
      registry: secretRegistry,
      env: { OPENAI_API_KEY: secret },
    };
    const adapter = new DiagnosticAdapter(
      'openai',
      'http',
      { status: 'available', provider: 'openai', model: secret, reason: `configured ${secret}` },
      {
        status: 'down',
        provider: 'openai',
        requestedModel: secret,
        actualModel: null,
        latencyMs: 10,
        reason: `provider rejected ${secret}`,
      },
    );

    const serialised = JSON.stringify(await doctor([adapter], secretContext, CAPTURED_AT));

    expect(serialised).not.toContain(secret);
    expect(serialised).toContain('<SECRET:OPENAI:');
    expect(serialised).not.toContain('OPENAI_API_KEY');
  });
});
