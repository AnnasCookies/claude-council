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
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
} from '../../src/execution/provider';
import { loadModelRegistry } from '../../src/models/registry';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import { assignLenses, selectLenses } from '../../src/roles/allocator';

const NOW = '2026-07-28T12:00:00.000Z';

interface FixtureBehaviour {
  readonly recommendation?: string;
  readonly failInvocation?: (provider: ProviderFamily, request: ProviderRequest) => boolean;
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
          calls += 1;
          return {
            status: 'available' as const,
            provider,
            model: registry[provider].primary,
            reason: '',
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
          calls += 1;
          throw new Error('dry-run must not probe providers');
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
      expect(payload.records).toEqual({ session: true, resolution: false });
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
      expect(payload.records).toEqual({ session: true, resolution: false });
      expect(session.status).toBe('degraded');
      expect(await Bun.file(join(root, 'general', 'resolutions')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports an already-resolved retry without discarding its completed execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-cli-resolution-retry-'));
    try {
      const fixture = await fixtureEnvironment(undefined, true, {
        recommendation: 'Proceed with the bounded change.',
      });
      const common = [
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
        'motion-resolution-retry',
        '--motion',
        'Choose the bounded retry policy',
      ];
      const first = await runCliFacade(
        [...common, '--run-id', 'run-resolution-first'],
        fixture.environment,
      );
      const retry = await runCliFacade(
        [...common, '--run-id', 'run-resolution-retry'],
        fixture.environment,
      );
      expect(first.stderr).toBe('');
      expect(retry.stderr).toBe('');
      const firstPayload = JSON.parse(first.stdout);
      const retryPayload = JSON.parse(retry.stdout);

      expect(first.exitCode).toBe(0);
      expect(firstPayload.records).toEqual({ session: true, resolution: true });
      expect(retry.exitCode).toBe(0);
      expect(retryPayload.status).toBe('completed');
      expect(retryPayload.execution.outcome).toBe('completed');
      expect(retryPayload.records).toEqual({
        session: true,
        resolution: false,
        resolutionBlockReason: 'motion-already-resolved',
      });
      expect(
        await Bun.file(join(root, 'general', 'sessions', 'run-resolution-retry.json')).exists(),
      ).toBe(true);
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
