import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  ProviderFamilySchema,
  type ProjectPolicy,
  type ProviderFamily,
} from '../../src/substrate/domain/schemas';
import {
  withCredentialFallback,
  type Availability,
  type HealthResult,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
} from '../../src/substrate/execution/provider';
import { loadModelRegistry } from '../../src/substrate/models/registry';
import {
  runCliFacade,
  shouldReadStdin,
  type CliFacadeEnvironment,
  type CliFacadeResult,
} from '../../src/cli';
import { assignLenses, selectLenses } from '../../src/substrate/roles/allocator';
import { ResultEnvelopeSchema } from '../../src/substrate/envelope';

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

  test('result reports the derived decision state, not the stale persisted one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-result-state-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        recommendation: 'Proceed with the bounded change.',
      });
      const common = ['--records-root', root, '--run-id', 'run-derived-state'];
      await runCliFacade(
        [
          'run',
          '--scope',
          'general',
          '--classification',
          'public',
          '--providers',
          'anthropic,openai,xai,google',
          ...common,
          '--motion-id',
          'motion-derived-state',
          '--motion',
          'Check that a ruled motion stops reading as unruled',
        ],
        fixture.environment,
      );

      const before = JSON.parse(
        (await runCliFacade(['result', '--scope', 'general', ...common], fixture.environment))
          .stdout,
      );
      expect(before.session.decisionState).toBe('awaiting-adjudication');
      expect(before.decision.state).toBe('awaiting-adjudication');
      expect(before.decision.rulingId).toBeUndefined();

      await runCliFacade(
        [
          'adjudicate',
          ...common,
          '--decision',
          'Adopt it.',
          '--rationale',
          'The panel was unanimous and the chair agrees on the evidence.',
          '--authorised-by',
          'council-chair',
          '--no-dissent',
        ],
        fixture.environment,
      );

      const after = JSON.parse(
        (await runCliFacade(['result', '--scope', 'general', ...common], fixture.environment))
          .stdout,
      );
      // The persisted field is immutable and still says awaiting; the derived state must not.
      // Reporting only the persisted value would tell an auditor a ruled motion is unruled.
      expect(after.session.decisionState).toBe('awaiting-adjudication');
      expect(after.decision.state).toBe('adjudicated');
      expect(after.decision.rulingId).toBeDefined();
      expect(after.decision.resolutionId).toBeDefined();
      expect(after.decision.dataAvailability).toBe('captured');
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

  test('every executed run returns a validated envelope and names its mode', async () => {
    const fixture = await fixtureEnvironment(undefined, true);
    const council = await runCliFacade(
      ['council', '--classification', 'public', '--motion', 'Envelope for a council'],
      fixture.environment,
    );
    expect(council.exitCode).toBe(0);
    const councilPayload = JSON.parse(council.stdout);
    expect(councilPayload.mode).toBe('committee');
    const councilEnvelope = ResultEnvelopeSchema.parse(councilPayload.envelope);
    expect(councilEnvelope.mode).toBe('committee');
    expect(councilEnvelope.pattern).toBe('rounds');
    expect(councilEnvelope.rounds).toBe(2);
    expect(councilEnvelope.caller).toEqual({ kind: 'human', harness: 'unknown', declared: false });
    expect(councilEnvelope.degraded).toContain('caller-undeclared');
    expect(councilEnvelope.seats.length).toBeGreaterThanOrEqual(4);
    expect(councilEnvelope.spend).toMatchObject({
      policy: 'capped',
      billing: 'sub-first',
      stoppedAtCap: false,
    });
    expect(councilEnvelope.record).toEqual({ session: null });

    const opinion = await runCliFacade(
      [
        'second-opinion',
        '--classification',
        'public',
        '--caller',
        'agent',
        '--harness',
        'omp',
        '--purpose',
        'choose a library',
        '--motion',
        'Envelope for a second opinion',
      ],
      fixture.environment,
    );
    expect(opinion.exitCode).toBe(0);
    const opinionPayload = JSON.parse(opinion.stdout);
    expect(opinionPayload.mode).toBe('second-opinion');
    const opinionEnvelope = ResultEnvelopeSchema.parse(opinionPayload.envelope);
    expect(opinionEnvelope.pattern).toBe('parallel');
    expect(opinionEnvelope.rounds).toBe(1);
    expect(opinionEnvelope.caller).toEqual({
      kind: 'agent',
      harness: 'omp',
      purpose: 'choose a library',
      declared: true,
    });
    expect(opinionEnvelope.degraded).not.toContain('caller-undeclared');
    expect(Array.isArray(opinionEnvelope.output.panel)).toBe(true);
  });

  test('the legacy run alias is marked when it resolves to the committee', async () => {
    const fixture = await fixtureEnvironment(undefined, true);
    const result = await runCliFacade(
      [
        'run',
        '--classification',
        'public',
        '--impact',
        'high',
        '--rounds',
        '2',
        '--motion',
        'Legacy alias',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.mode).toBe('committee');
    expect(payload.envelope.degraded).toContain('legacy-run-alias');
  });

  test('a significant second opinion takes the committee and is marked', async () => {
    const fixture = await fixtureEnvironment(undefined, true);
    const result = await runCliFacade(
      [
        'second-opinion',
        '--classification',
        'public',
        '--impact',
        'high',
        '--rounds',
        '2',
        '--motion',
        'Significant second opinion',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.mode).toBe('committee');
    expect(payload.envelope.pattern).toBe('rounds');
    expect(payload.envelope.rounds).toBe(2);
    expect(payload.envelope.degraded).toContain('legacy-significant-second-opinion');
    expect(payload.manifest.quorumPolicy.minimumDistinctFamilies).toBe(4);
  });

  test('--harness and --purpose require --caller, and the spend cap must be a whole number', async () => {
    const fixture = await fixtureEnvironment(undefined, true);
    const harnessOnly = await runCliFacade(
      ['second-opinion', '--classification', 'public', '--harness', 'omp', '--motion', 'm'],
      fixture.environment,
    );
    expect(harnessOnly.exitCode).toBe(2);
    expect(harnessOnly.stderr).toContain('--caller');
    const badCap = await runCliFacade(
      ['second-opinion', '--classification', 'public', '--spend-cap', '-1', '--motion', 'm'],
      fixture.environment,
    );
    expect(badCap.exitCode).toBe(2);
  });

  test('the persisted session record carries the envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-envelope-record-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true);
      const result = await runCliFacade(
        [
          'second-opinion',
          '--classification',
          'public',
          '--records-root',
          root,
          '--motion',
          'Persist the envelope',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.records).toEqual({
        session: true,
        decisionState: 'awaiting-adjudication',
        dataAvailability: 'captured',
      });
      expect(payload.envelope.record.session).toBe(`general/sessions/${payload.runId}.json`);
      const persisted = JSON.parse(
        await Bun.file(join(root, payload.envelope.record.session)).text(),
      );
      expect(ResultEnvelopeSchema.parse(persisted.envelope).session).toBe(payload.runId);
      expect(persisted.envelope.record).toEqual({ session: payload.envelope.record.session });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the modes command lists the registered modes', async () => {
    const result = await runCliFacade(['modes']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.modes.map((mode: { name: string }) => mode.name)).toEqual([
      'committee',
      'second-opinion',
      'advisor',
      'ideation',
    ]);
    expect(payload.modes[0]).toMatchObject({ pattern: 'rounds', spend: { policy: 'capped' } });
    const positional = await runCliFacade(['modes', 'version']);
    expect(positional.exitCode).toBe(2);
    expect(positional.stderr).toContain('modes accepts no positional arguments');
  });

  test('a dry run names its mode and echoes the declared caller', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      [
        'second-opinion',
        '--dry-run',
        '--classification',
        'public',
        '--caller',
        'agent',
        '--harness',
        'omp',
        '--motion',
        'm',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.mode).toBe('second-opinion');
    expect(payload.caller).toEqual({ kind: 'agent', harness: 'omp', declared: true });
    expect(fixture.providerCalls()).toBe(0);
  });

  test('a blocked-policy result names the mode it would have run', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      ['council', '--scope', 'project', '--motion', 'Review this private design'],
      fixture.environment,
    );
    expect(result.exitCode).toBe(3);
    const payload = JSON.parse(result.stderr);
    expect(payload.status).toBe('blocked-policy');
    expect(payload.mode).toBe('committee');
    expect(fixture.providerCalls()).toBe(0);
  });

  test('an exhausted spend cap refuses the metered fallback and stops the run short', async () => {
    const registry = await loadModelRegistry();
    // One family's subscription seat is spent, so its seat can only answer through the metered
    // fallback. That is the single call the session cap is there to allow or refuse.
    const runWithCap = async (cap: string): Promise<CliFacadeResult> => {
      const fixture = await fixtureEnvironment(undefined, true);
      const metered = fixture.environment.adapters?.xai;
      if (metered === undefined) throw new Error('The fixture must provide an xai adapter');
      const exhausted: ProviderAdapter = {
        ...metered,
        async invoke(request: ProviderRequest) {
          return {
            status: 'failed' as const,
            seatId: request.seatId,
            provider: 'xai' as const,
            requestedModel: registry.xai.primary,
            role: request.role,
            latencyMs: 1,
            error: {
              code: 'quota-exhausted',
              message: 'The subscription quota is spent.',
              retryable: true,
            },
          };
        },
      };
      return runCliFacade(
        ['second-opinion', '--classification', 'public', '--spend-cap', cap, '--motion', 'Cap me'],
        {
          ...fixture.environment,
          adapters: {
            ...fixture.environment.adapters,
            xai: withCredentialFallback(exhausted, () => metered, 'http'),
          },
        },
      );
    };
    const xaiSeat = (payload: { envelope: { seats: { family: string }[] } }) => {
      const seat = payload.envelope.seats.find(({ family }) => family === 'xai');
      if (seat === undefined) throw new Error('The envelope must carry the xai seat');
      return seat as { family: string; status: string; reason: string | null; fallback: boolean };
    };

    const refused = await runWithCap('0');
    const refusedPayload = JSON.parse(refused.stdout);
    // The other four families still make quorum, so the run completed: the non-zero exit is the
    // spend cap alone, which is the distinction this asserts.
    expect(refusedPayload.status).toBe('completed');
    expect(refused.exitCode).toBe(4);
    expect(refusedPayload.spendWarning).toContain('--spend-cap');
    expect(refusedPayload.envelope.spend.stoppedAtCap).toBe(true);
    expect(refusedPayload.envelope.spend.refused).toBe(1);
    expect(refusedPayload.envelope.degraded).toContain('spend-cap-reached');
    expect(xaiSeat(refusedPayload).status).toBe('failed');
    expect(xaiSeat(refusedPayload).reason).toContain('spend-cap');

    const allowed = await runWithCap('1');
    expect(allowed.exitCode).toBe(0);
    const allowedPayload = JSON.parse(allowed.stdout);
    expect(allowedPayload.status).toBe('completed');
    expect(allowedPayload.spendWarning).toBeUndefined();
    expect(allowedPayload.envelope.spend.stoppedAtCap).toBe(false);
    expect(allowedPayload.envelope.spend.refused).toBe(0);
    expect(allowedPayload.envelope.degraded).not.toContain('spend-cap-reached');
    expect(xaiSeat(allowedPayload).fallback).toBe(true);
  });

  test('the health preflight does not draw on the execution spend budget', async () => {
    const registry = await loadModelRegistry();
    const fixture = await fixtureEnvironment(undefined, true);
    const metered = fixture.environment.adapters?.xai;
    if (metered === undefined) throw new Error('The fixture must provide an xai adapter');
    // This family's subscription path fails for every call, so its health probe AND both of its
    // council rounds go through the metered fallback. The cap of 2 covers the two rounds exactly;
    // a ledger shared with the preflight would spend one of them on the probe and refuse a round.
    const exhausted: ProviderAdapter = {
      ...metered,
      async invoke(request: ProviderRequest) {
        return {
          status: 'failed' as const,
          seatId: request.seatId,
          provider: 'xai' as const,
          requestedModel: registry.xai.primary,
          role: request.role,
          latencyMs: 1,
          error: {
            code: 'quota-exhausted',
            message: 'The subscription quota is spent.',
            retryable: true,
          },
        };
      },
    };
    const result = await runCliFacade(
      ['council', '--classification', 'public', '--spend-cap', '2', '--motion', 'Probe budget'],
      {
        ...fixture.environment,
        adapters: {
          ...fixture.environment.adapters,
          xai: withCredentialFallback(exhausted, () => metered, 'http'),
        },
      },
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.preflight.selectedProviders).toContain('xai');
    expect(payload.envelope.spend.stoppedAtCap).toBe(false);
    expect(payload.envelope.spend.refused).toBe(0);
  });

  test('a persisted run commits its record in a Git records root and writes minutes when configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-commit-facade-'));
    try {
      const init = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
      expect(init.exitCode).toBe(0);
      const fixture = await fixtureEnvironment(undefined, true);
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: {
          COUNCIL_MINUTES_DIR: join(root, 'minutes'),
          GIT_AUTHOR_NAME: 'Council Test',
          GIT_AUTHOR_EMAIL: 'council-test@example.invalid',
          GIT_COMMITTER_NAME: 'Council Test',
          GIT_COMMITTER_EMAIL: 'council-test@example.invalid',
          // A GIT_CONFIG_GLOBAL that does not exist keeps the machine's own global configuration
          // — hooks, templates, a `commit.gpgsign` — out of this temporary repository.
          GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
        },
      };
      const result = await runCliFacade(
        [
          'second-opinion',
          '--classification',
          'public',
          '--records-root',
          root,
          '--motion',
          'Commit me',
        ],
        environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.envelope.record.committed).toBe(true);
      expect(payload.envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(payload.envelope.record.minutes).toContain(join(root, 'minutes'));
      expect(await Bun.file(payload.envelope.record.minutes).text()).toContain(
        '# Minutes: second-opinion',
      );
      expect(payload.envelope.degraded).not.toContainEqual(
        expect.stringContaining('records-not-committed'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a persisted run in a plain directory reports records-not-committed and still succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-nocommit-facade-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true);
      const result = await runCliFacade(
        [
          'second-opinion',
          '--classification',
          'public',
          '--records-root',
          root,
          '--motion',
          'No git here',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.envelope.record.committed).toBe(false);
      expect(payload.envelope.record.minutes).toBeNull();
      expect(payload.envelope.degraded).toContainEqual(
        expect.stringContaining('records-not-committed'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an unwritable minutes directory degrades the run instead of failing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-minutes-facade-'));
    try {
      // A regular file where the minutes directory should be, so creating the directory fails
      // after the record has already been written.
      const blocked = join(root, 'minutes');
      await Bun.write(blocked, 'not a directory\n');
      const fixture = await fixtureEnvironment(undefined, true);
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: { COUNCIL_MINUTES_DIR: blocked },
      };
      const result = await runCliFacade(
        [
          'second-opinion',
          '--classification',
          'public',
          '--records-root',
          root,
          '--motion',
          'Minutes cannot be written',
        ],
        environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.envelope.record.minutes).toBeNull();
      expect(payload.envelope.degraded).toContainEqual(
        expect.stringMatching(/^minutes-not-written: /),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('adjudicate commits the ruling and resolution it appended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-adjudicate-facade-'));
    try {
      const init = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
      expect(init.exitCode).toBe(0);
      const fixture = await fixtureEnvironment(undefined, true);
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: {
          GIT_AUTHOR_NAME: 'Council Test',
          GIT_AUTHOR_EMAIL: 'council-test@example.invalid',
          GIT_COMMITTER_NAME: 'Council Test',
          GIT_COMMITTER_EMAIL: 'council-test@example.invalid',
          // A GIT_CONFIG_GLOBAL that does not exist keeps the machine's own global configuration
          // — hooks, templates, a `commit.gpgsign` — out of this temporary repository.
          GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
        },
      };
      const run = await runCliFacade(
        [
          'second-opinion',
          '--classification',
          'public',
          '--records-root',
          root,
          '--motion',
          'Adjudicate me',
        ],
        environment,
      );
      expect(run.exitCode).toBe(0);
      const runPayload = JSON.parse(run.stdout);
      expect(runPayload.status).toBe('completed');

      const adjudicated = await runCliFacade(
        [
          'adjudicate',
          '--records-root',
          root,
          '--run-id',
          runPayload.runId,
          '--decision',
          'Adopt the proposal.',
          '--rationale',
          'The panel informed the chair; the chair decided.',
          '--authorised-by',
          'council-chair',
          '--no-dissent',
        ],
        environment,
      );
      expect(adjudicated.exitCode).toBe(0);
      const payload = JSON.parse(adjudicated.stdout);
      expect(payload.records.committed).toBe(true);
      expect(payload.records.commitSha).toMatch(/^[a-f0-9]{40}$/);

      const subject = Bun.spawnSync({
        cmd: ['git', 'log', '--format=%s', '-1'],
        cwd: root,
        stdout: 'pipe',
      });
      expect(subject.stdout.toString()).toContain(`council: ruling ${payload.rulingId}`);
      expect(subject.stdout.toString()).toContain(`resolution ${payload.resolutionId}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stdin consumption', () => {
  // Reading stdin unconditionally blocked every command behind an open pipe, which is how
  // agent harnesses and CI invoke a CLI. It cost a 16-hour silent hang on a council whose
  // motion was already supplied as a flag.
  test('a motion-taking command with no --motion still reads stdin', () => {
    expect(shouldReadStdin(['council', '--scope', 'general'], false)).toBe(true);
    expect(shouldReadStdin(['second-opinion'], false)).toBe(true);
    expect(shouldReadStdin(['run'], false)).toBe(true);
  });

  test('an explicit --motion means stdin is never consumed', () => {
    expect(shouldReadStdin(['council', '--motion', 'x'], false)).toBe(false);
    expect(shouldReadStdin(['council', '--motion=x'], false)).toBe(false);
  });

  test('commands that never take a motion do not touch stdin', () => {
    for (const command of ['doctor', 'health', 'version', 'jobs', 'result', 'self-check']) {
      expect(shouldReadStdin([command], false)).toBe(false);
    }
    expect(shouldReadStdin([], false)).toBe(false);
  });

  test('an interactive terminal never blocks', () => {
    expect(shouldReadStdin(['council'], true)).toBe(false);
  });

  test('advise reads stdin only when the transcript window is piped', () => {
    const watch = ['advise', '--session', 's1', '--watch', '--every', '3'];
    expect(shouldReadStdin([...watch, '--transcript', '-'], false)).toBe(true);
    expect(shouldReadStdin([...watch, '--transcript=-'], false)).toBe(true);
    expect(shouldReadStdin([...watch, '--transcript', 'window.txt'], false)).toBe(false);
    expect(shouldReadStdin([...watch], false)).toBe(false);
    expect(
      shouldReadStdin(
        ['advise', '--session', 's1', '--hold', '--class', 'delete', '--tool', 'rm -rf build'],
        false,
      ),
    ).toBe(false);
    expect(shouldReadStdin(['advise', '--session', 's1', '--ask', 'q'], false)).toBe(false);
    expect(shouldReadStdin(['advise', '--session', 's1', '--status'], false)).toBe(false);
    expect(shouldReadStdin([...watch, '--transcript', '-'], true)).toBe(false);
  });
});
