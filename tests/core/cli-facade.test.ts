import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  ProviderFamilySchema,
  type ProjectPolicy,
  type ProviderFamily,
} from '../../src/domain/schemas';
import type {
  Availability,
  HealthResult,
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
} from '../../src/execution/provider';
import { loadModelRegistry } from '../../src/models/registry';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import { assignLenses, selectLenses } from '../../src/roles/allocator';

const NOW = '2026-07-28T12:00:00.000Z';
const REDUCED_QUORUM_WARNING =
  'REDUCED-QUORUM COUNCIL: minimum 3 distinct provider families (standing default: 4). This council is weaker than the standing default.';
const AUTO_REDUCED_QUORUM_WARNING =
  'REDUCED-QUORUM COUNCIL: running with 3 configured, reachable provider families; the standing default is 4. This council is weaker than the standing default. Unavailable families: xai — missing key (missing COUNCIL_XAI_API_KEY); deepseek — identity-unverified (provider response did not expose actual model identity).';

interface FixtureProviderState {
  readonly availability?: Availability['status'];
  readonly availabilityReason?: string;
  readonly health?: HealthResult['status'];
  readonly healthReason?: string;
}

interface FixtureBehaviour {
  readonly recommendation?: string;
  readonly failInvocation?: (provider: ProviderFamily, request: ProviderRequest) => boolean;
  readonly providerStates?: Partial<Record<ProviderFamily, FixtureProviderState>>;
}

async function fixtureEnvironment(
  projectPolicy?: ProjectPolicy,
  live = false,
  behaviour: FixtureBehaviour = {},
): Promise<{ environment: CliFacadeEnvironment; providerCalls: () => number }> {
  const registry = await loadModelRegistry();
  let calls = 0;
  const adapters = Object.fromEntries(
    ProviderFamilySchema.options.map((provider) => [
      provider,
      {
        family: provider,
        transport: registry[provider].transport,
        async availability(_context: ProviderContext) {
          const state = behaviour.providerStates?.[provider];
          const status = state?.availability ?? 'available';
          return {
            status,
            provider,
            model: registry[provider].primary,
            reason: state?.availabilityReason ?? (status === 'available' ? '' : 'unconfigured'),
          };
        },
        async invoke(request: ProviderRequest) {
          calls += 1;
          if (!live) throw new Error('dry-run must not invoke providers');
          if (behaviour.failInvocation?.(provider, request)) {
            return {
              status: 'failed' as const,
              seatId: request.seatId,
              provider,
              requestedModel: registry[provider].primary,
              role: request.role,
              latencyMs: 1,
              error: {
                code: 'fixture-failed',
                message: 'Deterministic failed fixture.',
                retryable: false,
              },
            };
          }
          return {
            status: 'ok' as const,
            seatId: request.seatId,
            provider,
            requestedModel: registry[provider].primary,
            actualModel: registry[provider].primary,
            modelIdentity: 'verified' as const,
            route: 'primary' as const,
            role: request.role,
            latencyMs: 1,
            answer: JSON.stringify({
              recommendation: behaviour.recommendation ?? `${provider} recommendation`,
              evidence: ['Deterministic fixture evidence.'],
              assumptions: ['The fixture models a valid provider response.'],
              risks: ['The decision remains contestable.'],
              uncertainty: 'Low.',
              decisiveTest: 'Exercise the selected path.',
            }),
          };
        },
        async probe() {
          if (!live) throw new Error('dry-run must not probe providers');
          const state = behaviour.providerStates?.[provider];
          const status = state?.health ?? 'healthy';
          return {
            status,
            provider,
            requestedModel: registry[provider].primary,
            actualModel: status === 'healthy' ? registry[provider].primary : null,
            latencyMs: 1,
            reason:
              state?.healthReason ??
              (status === 'healthy' ? '' : 'Deterministic unhealthy provider fixture.'),
          };
        },
      } satisfies ProviderAdapter,
    ]),
  ) as Partial<Record<ProviderFamily, ProviderAdapter>>;

  return {
    environment: {
      registry,
      adapters,
      ...(projectPolicy === undefined ? {} : { projectPolicy }),
      cwd: 'C:/fixture/project',
      env: {},
      now: () => NOW,
    },
    providerCalls: () => calls,
  };
}

const policy: ProjectPolicy = {
  projectId: 'fixture-project',
  classification: 'internal',
  allowedProviders: ['anthropic', 'openai', 'xai', 'google', 'deepseek'],
  providerCeilings: {
    anthropic: 'internal',
    openai: 'internal',
    xai: 'internal',
    google: 'internal',
    deepseek: 'internal',
  },
  createdAt: NOW,
  updatedAt: NOW,
};

describe('public CLI facade', () => {
  test('run dry-run prints destinations without contacting providers', async () => {
    const fixture = await fixtureEnvironment(policy);
    const result = await runCliFacade(
      [
        'run',
        '--dry-run',
        '--scope',
        'project',
        '--classification',
        'internal',
        '--motion',
        'Choose an authentication architecture',
      ],
      fixture.environment,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gpt-5.6-sol');
    expect(result.stdout).toContain('claude-opus-5');
    expect(result.stdout).toContain('allowed');
    expect(fixture.providerCalls()).toBe(0);
  });

  test('project run without policy blocks before providers', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      ['council', '--scope', 'project', '--motion', 'Review this private design'],
      fixture.environment,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('missing-project-policy');
    expect(fixture.providerCalls()).toBe(0);
  });

  test('rejects a project policy outside project scope before providers', async () => {
    const fixture = await fixtureEnvironment(policy);
    const result = await runCliFacade(
      [
        'council',
        '--dry-run',
        '--classification',
        'internal',
        '--motion',
        'Review this private design',
      ],
      fixture.environment,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Project policy requires --scope project');
    expect(fixture.providerCalls()).toBe(0);
  });

  test('infers motion domains so the role mix changes with the motion', async () => {
    const fixture = await fixtureEnvironment();
    const authentication = await runCliFacade(
      [
        'run',
        '--dry-run',
        '--scope',
        'general',
        '--classification',
        'public',
        '--motion',
        'Choose an authentication architecture',
      ],
      fixture.environment,
    );
    const performance = await runCliFacade(
      [
        'run',
        '--dry-run',
        '--scope',
        'general',
        '--classification',
        'public',
        '--motion',
        'Reduce p99 latency and memory use',
      ],
      fixture.environment,
    );

    const authenticationManifest = JSON.parse(authentication.stdout).manifest;
    const performanceManifest = JSON.parse(performance.stdout).manifest;
    const authenticationLenses = authenticationManifest.lenses.map(
      ({ name }: { name: string }) => name,
    );
    const performanceLenses = performanceManifest.lenses.map(({ name }: { name: string }) => name);

    expect(authentication.exitCode).toBe(0);
    expect(performance.exitCode).toBe(0);
    expect(authenticationLenses).toContain('architect');
    expect(performanceLenses).toContain('performance');
    expect(performanceLenses).not.toEqual(authenticationLenses);
    expect(performanceManifest.quorumPolicy).toEqual(authenticationManifest.quorumPolicy);
    expect(fixture.providerCalls()).toBe(0);
  });

  test('rotates assignments between motions and persists their association', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-history-'));
    const providers = ProviderFamilySchema.options.slice(0, 5);
    const seatIds = providers.map((provider) => `${provider}-seat`);
    const lenses = selectLenses(
      { domains: ['general'], impact: 'medium', contested: false },
      providers.length,
    );
    const firstRunId = 'run-history-a';
    const firstMotionId = 'motion-history-a';
    const retryRunId = 'run-history-retry';
    const secondRunId = 'run-history-b';
    const firstExpected = assignLenses(firstRunId, firstMotionId, seatIds, lenses, []);
    const firstBySeat = new Map(firstExpected.map(({ seatId, lensName }) => [seatId, lensName]));
    let secondMotionId: string | undefined;

    for (let index = 0; index < 1_000; index += 1) {
      const candidate = `motion-history-${index}`;
      const withoutHistory = assignLenses(secondRunId, candidate, seatIds, lenses, []);
      const withHistory = assignLenses(secondRunId, candidate, seatIds, lenses, firstExpected);
      const repeatsWithoutHistory = withoutHistory.some(
        ({ seatId, lensName }) => firstBySeat.get(seatId) === lensName,
      );
      const rotatesWithHistory = withHistory.every(
        ({ seatId, lensName }) => firstBySeat.get(seatId) !== lensName,
      );
      if (repeatsWithoutHistory && rotatesWithHistory) {
        secondMotionId = candidate;
        break;
      }
    }
    if (secondMotionId === undefined) throw new Error('No deterministic rotation fixture found');

    try {
      const fixture = await fixtureEnvironment(undefined, true);
      const first = await runCliFacade(
        [
          'run',
          '--scope',
          'general',
          '--classification',
          'public',
          '--records-root',
          root,
          '--run-id',
          firstRunId,
          '--motion-id',
          firstMotionId,
          '--motion',
          'Review a bounded general council choice',
        ],
        fixture.environment,
      );
      const retry = await runCliFacade(
        [
          'run',
          '--scope',
          'general',
          '--classification',
          'public',
          '--records-root',
          root,
          '--run-id',
          retryRunId,
          '--motion-id',
          firstMotionId,
          '--motion',
          'Review a bounded general council choice',
        ],
        fixture.environment,
      );
      const second = await runCliFacade(
        [
          'run',
          '--scope',
          'general',
          '--classification',
          'public',
          '--records-root',
          root,
          '--run-id',
          secondRunId,
          '--motion-id',
          secondMotionId,
          '--motion',
          'Review a bounded general council choice',
        ],
        fixture.environment,
      );

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(retry.exitCode).toBe(0);
      const firstAssignments = JSON.parse(first.stdout).execution.assignments;
      const retryAssignments = JSON.parse(retry.stdout).execution.assignments;
      const secondAssignments = JSON.parse(second.stdout).execution.assignments;
      const persistedRetry = JSON.parse(
        await Bun.file(join(root, 'general', 'sessions', `${retryRunId}.json`)).text(),
      );
      const persistedSecond = JSON.parse(
        await Bun.file(join(root, 'general', 'sessions', `${secondRunId}.json`)).text(),
      );
      const observedFirstBySeat = new Map(
        firstAssignments.map(({ seatId, lensName }: { seatId: string; lensName: string }) => [
          seatId,
          lensName,
        ]),
      );

      expect(firstAssignments).toEqual(
        firstExpected.map(({ seatId, lensName }) => expect.objectContaining({ seatId, lensName })),
      );
      expect(
        retryAssignments.map(({ seatId, lensName }: { seatId: string; lensName: string }) => ({
          seatId,
          lensName,
        })),
      ).toEqual(
        firstAssignments.map(({ seatId, lensName }: { seatId: string; lensName: string }) => ({
          seatId,
          lensName,
        })),
      );
      expect(persistedRetry.assignments).toEqual(
        retryAssignments.map(({ seatId, lensName }: { seatId: string; lensName: string }) => ({
          runId: retryRunId,
          motionId: firstMotionId,
          seatId,
          lensName,
          chairOverride: null,
        })),
      );
      for (const { seatId, lensName } of secondAssignments) {
        expect(lensName).not.toBe(observedFirstBySeat.get(seatId));
      }
      expect(persistedSecond.assignments).toEqual(
        secondAssignments.map(({ seatId, lensName }: { seatId: string; lensName: string }) => ({
          runId: secondRunId,
          motionId: secondMotionId,
          seatId,
          lensName,
          chairOverride: null,
        })),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ordinary council front door keeps the standing floor with five reachable families', async () => {
    const fixture = await fixtureEnvironment(undefined, true);
    const result = await runCliFacade(
      [
        'council',
        '--scope',
        'general',
        '--classification',
        'public',
        '--motion',
        'Review a bounded general council choice',
      ],
      fixture.environment,
    );
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe('completed');
    expect(payload.manifest.quorumPolicy).toEqual({
      minimumDistinctFamilies: 4,
      requiresContrarian: true,
    });
    expect(payload.warning).toBeUndefined();
    expect(payload.preflight.requestedProviders).toEqual([
      'anthropic',
      'openai',
      'xai',
      'google',
      'deepseek',
    ]);
    expect(payload.preflight.selectedProviders).toEqual(payload.preflight.requestedProviders);
    expect(payload.preflight.unavailableProviders).toEqual([]);
    expect(
      new Set(payload.manifest.lenses.map(({ category }: { category: string }) => category)),
    ).toEqual(new Set(['domain', 'maintainer', 'risk', 'contrarian']));
    expect(fixture.providerCalls()).toBe(10);
  });

  test('ordinary council front door auto-reduces to three reachable families with durable reasons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-auto-reduced-quorum-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        providerStates: {
          xai: {
            availability: 'unconfigured',
            availabilityReason: 'missing COUNCIL_XAI_API_KEY',
          },
          deepseek: {
            health: 'identity-unverified',
            healthReason: 'provider response did not expose actual model identity',
          },
        },
      });
      const result = await runCliFacade(
        [
          'council',
          '--scope',
          'general',
          '--classification',
          'public',
          '--records-root',
          root,
          '--run-id',
          'run-auto-reduced-quorum',
          '--motion-id',
          'motion-auto-reduced-quorum',
          '--motion',
          'Review a bounded general council choice',
        ],
        fixture.environment,
      );
      const payload = JSON.parse(result.stdout);
      const session = JSON.parse(
        await Bun.file(join(root, 'general', 'sessions', 'run-auto-reduced-quorum.json')).text(),
      );

      expect(result.exitCode).toBe(0);
      expect(payload.status).toBe('completed');
      expect(payload.warning).toBe(AUTO_REDUCED_QUORUM_WARNING);
      expect(payload.preflight.requestedProviders).toEqual([
        'anthropic',
        'openai',
        'xai',
        'google',
        'deepseek',
      ]);
      expect(payload.preflight.selectedProviders).toEqual(['anthropic', 'openai', 'google']);
      expect(payload.preflight.unavailableProviders).toEqual([
        { provider: 'xai', reason: 'missing key', detail: 'missing COUNCIL_XAI_API_KEY' },
        {
          provider: 'deepseek',
          reason: 'identity-unverified',
          detail: 'provider response did not expose actual model identity',
        },
      ]);
      expect(Object.keys(payload.manifest.routes)).toEqual(['anthropic', 'openai', 'google']);
      expect(payload.manifest.quorumPolicy).toEqual({
        minimumDistinctFamilies: 3,
        requiresContrarian: true,
        reducedQuorum: {
          standingDefaultMinimumDistinctFamilies: 4,
          weakerThanStandingDefault: true,
          warning: AUTO_REDUCED_QUORUM_WARNING,
        },
      });
      expect(
        payload.execution.assignments.some(
          ({ lensCategory }: { lensCategory: string }) => lensCategory === 'contrarian',
        ),
      ).toBe(true);
      expect(payload.execution.quorum.successfulFamilies).toEqual([
        'anthropic',
        'openai',
        'google',
      ]);
      expect(session.destinations.map(({ provider }: { provider: string }) => provider)).toEqual([
        'anthropic',
        'openai',
        'google',
      ]);
      expect(session.protocol.quorumPolicy).toEqual(payload.manifest.quorumPolicy);
      expect(session.summary).toContain(AUTO_REDUCED_QUORUM_WARNING);
      expect(fixture.providerCalls()).toBe(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('runs an explicitly reduced three-family council with a contrarian and durable warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-reduced-quorum-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true);
      const result = await runCliFacade(
        [
          'council',
          '--scope',
          'general',
          '--classification',
          'public',
          '--providers',
          'anthropic,openai,google',
          '--min-families',
          '3',
          '--records-root',
          root,
          '--run-id',
          'run-reduced-quorum',
          '--motion-id',
          'motion-reduced-quorum',
          '--motion',
          'Review a bounded general council choice',
        ],
        fixture.environment,
      );
      const payload = JSON.parse(result.stdout);
      const session = JSON.parse(
        await Bun.file(join(root, 'general', 'sessions', 'run-reduced-quorum.json')).text(),
      );

      expect(result.exitCode).toBe(0);
      expect(payload.status).toBe('completed');
      expect(payload.warning).toBe(REDUCED_QUORUM_WARNING);
      expect(payload.manifest.quorumPolicy).toEqual({
        minimumDistinctFamilies: 3,
        requiresContrarian: true,
        reducedQuorum: {
          standingDefaultMinimumDistinctFamilies: 4,
          weakerThanStandingDefault: true,
          warning: REDUCED_QUORUM_WARNING,
        },
      });
      expect(
        payload.execution.assignments.some(
          ({ lensCategory }: { lensCategory: string }) => lensCategory === 'contrarian',
        ),
      ).toBe(true);
      expect(payload.execution.quorum.successfulFamilies).toEqual([
        'anthropic',
        'openai',
        'google',
      ]);
      expect(session.protocol.quorumPolicy).toEqual(payload.manifest.quorumPolicy);
      expect(session.summary).toContain(REDUCED_QUORUM_WARNING);
      expect(fixture.providerCalls()).toBe(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ordinary council front door fails closed below three reachable families', async () => {
    const fixture = await fixtureEnvironment(undefined, true, {
      providerStates: {
        xai: {
          availability: 'unconfigured',
          availabilityReason: 'missing COUNCIL_XAI_API_KEY',
        },
        google: {
          health: 'down',
          healthReason: 'health check timed out',
        },
        deepseek: {
          health: 'identity-unverified',
          healthReason: 'provider response did not expose actual model identity',
        },
      },
    });
    const result = await runCliFacade(
      [
        'council',
        '--scope',
        'general',
        '--classification',
        'public',
        '--motion',
        'Review a bounded general council choice',
      ],
      fixture.environment,
    );
    const payload = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(4);
    expect(payload.status).toBe('blocked-quorum');
    expect(payload.message).toBe(
      'Council requires at least 3 configured, reachable provider families; found 2.',
    );
    expect(payload.preflight.selectedProviders).toEqual(['anthropic', 'openai']);
    expect(payload.preflight.unavailableProviders).toEqual([
      { provider: 'xai', reason: 'missing key', detail: 'missing COUNCIL_XAI_API_KEY' },
      { provider: 'google', reason: 'unhealthy', detail: 'health check timed out' },
      {
        provider: 'deepseek',
        reason: 'identity-unverified',
        detail: 'provider response did not expose actual model identity',
      },
    ]);
    expect(fixture.providerCalls()).toBe(0);
  });

  test('rejects a reduced council floor below three families', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      [
        'council',
        '--dry-run',
        '--scope',
        'general',
        '--classification',
        'public',
        '--min-families',
        '2',
        '--motion',
        'Review a bounded general council choice',
      ],
      fixture.environment,
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).message).toBe(
      'Option --min-families must be an integer from 3 to 6',
    );
    expect(fixture.providerCalls()).toBe(0);
  });

  test('enforces the CLI round matrix and scans the refinement question', async () => {
    const fixture = await fixtureEnvironment(undefined, true);
    const providers = 'anthropic,openai,xai,google';
    const ordinary = await runCliFacade(
      [
        'run',
        '--scope',
        'general',
        '--classification',
        'public',
        '--providers',
        providers,
        '--rounds',
        '2',
        '--motion',
        'Review a bounded ordinary choice',
      ],
      fixture.environment,
    );
    expect(ordinary.exitCode).toBe(2);
    expect(ordinary.stderr).toMatch(/ordinary.*one blind round/i);
    expect(fixture.providerCalls()).toBe(0);

    const refinementQuestion = 'Which reversible test resolves the remaining disagreement?';
    const refined = await runCliFacade(
      [
        'council',
        '--scope',
        'general',
        '--classification',
        'public',
        '--providers',
        providers,
        '--rounds',
        '3',
        '--refinement-question',
        refinementQuestion,
        '--motion',
        'Review a bounded significant choice',
      ],
      fixture.environment,
    );
    expect(refined.exitCode).toBe(0);
    expect(fixture.providerCalls()).toBe(12);
    expect(JSON.parse(refined.stdout).execution.refinementTrigger).toEqual({
      materialDisagreement: true,
      question: refinementQuestion,
    });

    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const callsBeforeSecret = fixture.providerCalls();
    const blocked = await runCliFacade(
      [
        'council',

        '--scope',
        'general',
        '--classification',
        'public',
        '--providers',
        providers,
        '--rounds',
        '3',
        '--refinement-question',
        `Resolve using token=${secret}`,
        '--motion',
        'Review another bounded significant choice',
      ],
      fixture.environment,
    );
    expect(blocked.exitCode).toBe(3);
    expect(JSON.parse(blocked.stderr).status).toBe('blocked-policy');
    expect(blocked.stderr).not.toContain(secret);
    expect(fixture.providerCalls()).toBe(callsBeforeSecret);
  });

  test('does not record consensus from a single surviving refinement seat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-final-round-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        recommendation: 'Proceed with the bounded change.',
        failInvocation: (provider, request) =>
          provider !== 'openai' && request.prompt.includes('Round 3: refinement'),
      });
      const result = await runCliFacade(
        [
          'council',
          '--scope',
          'general',
          '--classification',
          'public',
          '--providers',
          'anthropic,openai,xai,google,deepseek',
          '--rounds',
          '3',
          '--refinement-question',
          'Which bounded test resolves the remaining disagreement?',
          '--records-root',
          root,
          '--run-id',
          'run-refinement-single-survivor',
          '--motion-id',
          'motion-refinement-single-survivor',
          '--motion',
          'Review the bounded refinement decision',
        ],
        fixture.environment,
      );
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(payload.status).toBe('completed');
      expect(payload.records).toEqual({
        session: true,
        decisionState: 'awaiting-adjudication',
        dataAvailability: 'captured',
      });
      const session = JSON.parse(
        await Bun.file(
          join(root, 'general', 'sessions', 'run-refinement-single-survivor.json'),
        ).text(),
      );
      expect(session.protocol.refinementTrigger.question).toBe(
        'Which bounded test resolves the remaining disagreement?',
      );
      expect(await Bun.file(join(root, 'general', 'resolutions')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists a degraded result without recording a resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-degraded-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        failInvocation: (provider, request) =>
          provider === 'google' && request.prompt.includes('Round 1: analysis'),
      });
      const result = await runCliFacade(
        [
          'council',
          '--scope',
          'general',
          '--classification',
          'public',
          '--providers',
          'anthropic,openai,xai,google',
          '--rounds',
          '2',
          '--records-root',
          root,
          '--run-id',
          'run-degraded',
          '--motion-id',
          'motion-degraded',
          '--motion',
          'Review the bounded degraded outcome',
        ],
        fixture.environment,
      );
      const payload = JSON.parse(result.stdout);
      const session = JSON.parse(
        await Bun.file(join(root, 'general', 'sessions', 'run-degraded.json')).text(),
      );

      expect(result.exitCode).toBe(4);
      expect(payload.status).toBe('degraded');
      expect(payload.execution.outcome).toBe('degraded');
      expect(payload.records).toEqual({
        session: true,
        decisionState: 'awaiting-adjudication',
        dataAvailability: 'captured',
      });
      expect(session.status).toBe('degraded');
      expect(await Bun.file(join(root, 'general', 'resolutions')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a completed run records no resolution until a chair adjudicates it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-adjudicate-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        recommendation: 'Proceed with the bounded change.',
      });
      const run = await runCliFacade(
        [
          'run',
          '--scope',
          'general',
          '--classification',
          'public',
          '--providers',
          'anthropic,openai,xai,google',
          '--records-root',
          root,
          '--motion-id',
          'motion-adjudication',
          '--motion',
          'Choose the bounded retry policy',
          '--run-id',
          'run-adjudication',
        ],
        fixture.environment,
      );
      expect(run.stderr).toBe('');
      expect(run.exitCode).toBe(0);
      const runPayload = JSON.parse(run.stdout);
      expect(runPayload.records).toEqual({
        session: true,
        decisionState: 'awaiting-adjudication',
        dataAvailability: 'captured',
      });

      // Unanimous seats used to be enough to write a ledger resolution. They are not.
      expect(await Bun.file(join(root, 'general', 'resolutions')).exists()).toBe(false);

      const adjudication = await runCliFacade(
        [
          'adjudicate',
          '--records-root',
          root,
          '--run-id',
          'run-adjudication',
          '--decision',
          'Adopt the bounded retry policy.',
          '--rationale',
          'Three families agreed on the mechanism; the cost objection was noted and accepted.',
          '--authorised-by',
          'council-chair',
          '--dissent-acknowledged',
          '--followed-seats',
          'anthropic-seat,openai-seat',
          '--set-aside-seats',
          'google-seat',
        ],
        fixture.environment,
      );
      expect(adjudication.stderr).toBe('');
      expect(adjudication.exitCode).toBe(0);
      const ruled = JSON.parse(adjudication.stdout);
      expect(ruled.status).toBe('adjudicated');
      expect(ruled.decisionState).toBe('adjudicated');
      expect(ruled.dissentAcknowledged).toBe(true);
      expect(ruled.dataAvailability).toBe('captured');

      const ruling = JSON.parse(
        await Bun.file(join(root, 'general', 'chair-rulings', `${ruled.rulingId}.json`)).text(),
      );
      expect(ruling.authorisedBy).toBe('council-chair');
      expect(ruling.decision).toBe('Adopt the bounded retry policy.');
      expect(ruling.followedSeats).toEqual(['anthropic-seat', 'openai-seat']);
      expect(ruling.setAsideSeats).toEqual(['google-seat']);

      const ledger = await Bun.file(join(root, 'general', 'ledger.md')).text();
      expect(ledger).toContain('Adopt the bounded retry policy.');

      // One ruling per run: a second attempt must be refused rather than silently overwriting.
      const again = await runCliFacade(
        [
          'adjudicate',
          '--records-root',
          root,
          '--run-id',
          'run-adjudication',
          '--decision',
          'Reverse the earlier ruling.',
          '--rationale',
          'Attempting to re-rule the same run.',
          '--authorised-by',
          'council-chair',
          '--no-dissent',
        ],
        fixture.environment,
      );
      expect(again.exitCode).toBe(2);
      expect(JSON.parse(again.stderr).message).toMatch(/already has a chair ruling/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('adjudicate refuses a run with no quorum outcome to rule on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-adjudicate-blocked-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        failInvocation: (provider) => provider !== 'anthropic',
      });
      const run = await runCliFacade(
        [
          'council',
          '--scope',
          'general',
          '--classification',
          'public',
          '--providers',
          'anthropic,openai,xai,google',
          '--rounds',
          '2',
          '--records-root',
          root,
          '--run-id',
          'run-blocked-adjudication',
          '--motion-id',
          'motion-blocked-adjudication',
          '--motion',
          'Review a motion that cannot reach quorum',
        ],
        fixture.environment,
      );
      const runPayload = JSON.parse(run.stdout);
      expect(runPayload.status).toBe('blocked-quorum');
      expect(runPayload.records).toEqual({
        session: true,
        decisionState: 'not-adjudicable',
        dataAvailability: 'captured',
      });

      const attempt = await runCliFacade(
        [
          'adjudicate',
          '--records-root',
          root,
          '--run-id',
          'run-blocked-adjudication',
          '--decision',
          'Proceed anyway.',
          '--rationale',
          'Trying to rule on a blocked run.',
          '--authorised-by',
          'council-chair',
          '--no-dissent',
        ],
        fixture.environment,
      );
      expect(attempt.exitCode).toBe(2);
      expect(JSON.parse(attempt.stderr).message).toMatch(/no quorum outcome to rule on/i);
      expect(await Bun.file(join(root, 'general', 'resolutions')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('adjudicate requires an explicit dissent statement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-adjudicate-dissent-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true);
      const result = await runCliFacade(
        [
          'adjudicate',
          '--records-root',
          root,
          '--run-id',
          'run-anything',
          '--decision',
          'Adopt it.',
          '--rationale',
          'No dissent flag supplied.',
          '--authorised-by',
          'council-chair',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr).message).toMatch(
        /exactly one of --dissent-acknowledged or --no-dissent/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects reuse of a motion ID for different motion text before provider calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-motion-identity-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true);
      const sharedArguments = [
        '--scope',
        'general',
        '--classification',
        'public',
        '--records-root',
        root,
        '--providers',
        'anthropic,openai,xai,google',
        '--motion-id',
        'motion-stable-identity',
      ];
      const first = await runCliFacade(
        [
          'run',
          ...sharedArguments,
          '--run-id',
          'run-stable-identity-a',
          '--motion',
          'Choose the bounded recovery policy',
        ],
        fixture.environment,
      );
      const callsAfterFirst = fixture.providerCalls();
      const changed = await runCliFacade(
        [
          'run',
          ...sharedArguments,
          '--run-id',
          'run-stable-identity-b',
          '--motion',
          'Choose a different recovery policy',
        ],
        fixture.environment,
      );

      expect(first.exitCode).toBe(0);
      expect(changed.exitCode).toBe(2);
      expect(changed.stderr).toMatch(/different motion/i);
      expect(fixture.providerCalls()).toBe(callsAfterFirst);
      expect(
        await Bun.file(join(root, 'general', 'sessions', 'run-stable-identity-b.json')).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
