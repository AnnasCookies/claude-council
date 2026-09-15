import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliFacadeEnvironment } from '../../../src/cli';
import { consultants } from '../../../src/modes/consultants';
import {
  ProviderFamilySchema,
  loadModelRegistry,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
} from '../../../src/substrate';
// Reached directly rather than through `../../../src/substrate`: the dependency-direction rule
// binds `src/modes`, not test fixtures, and `withCredentialFallback` is exactly how
// `tests/core/panel.test.ts` and `tests/core/cli-facade.test.ts` build a seat that must actually
// spend from the ledger to answer.
import { withCredentialFallback } from '../../../src/substrate/execution/provider';

export const NOW = '2026-07-28T12:00:00.000Z';
export const BRIEF_SESSION = 'cs-2026-07-28-0a1b2c';

export interface ConsultantsFixtureOptions {
  /** Extra arguments the brief helper appends, so a test can pin the session cap. */
  readonly spendCapArgument?: readonly string[];
  readonly cwd?: string;
  readonly recordsRoot?: string;
  readonly failing?: readonly ProviderFamily[];
  /**
   * Every seat's subscription leg fails `quota-exhausted` (a fallback-permitting code) and falls
   * back to a metered secondary through `withCredentialFallback`, exactly like a real dual-
   * credential family: this is what actually reserves from the session's spend ledger, so the cap
   * is reachable in a test. A plain `credentialPath: 'api-key'` seat that never touched the ledger
   * would leave `SpendLedger.used` at zero regardless of the cap.
   */
  readonly fallback?: boolean;
  /** Replaces the synthesiser's answer, to exercise a mis-shaped one. */
  readonly conflicts?: unknown;
  readonly env?: Record<string, string>;
}

export interface ConsultantsFixture {
  readonly environment: CliFacadeEnvironment;
  readonly prompts: () => readonly { readonly role: string; readonly prompt: string }[];
  readonly calls: () => number;
  /** Only meaningful under `fallback: true`: how many times a subscription leg was attempted. */
  readonly subscriptionCalls: () => number;
  /** Only meaningful under `fallback: true`: how many times a metered leg actually answered. */
  readonly meteredCalls: () => number;
}

function lensesInSynthesisPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/Report from the (\S+) consultant/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function fixtureAnswer(request: ProviderRequest, options: ConsultantsFixtureOptions): string {
  if (request.role === 'synthesiser') {
    if (options.conflicts !== undefined) return JSON.stringify(options.conflicts);
    const [first, second] = lensesInSynthesisPrompt(request.prompt);
    if (first === undefined || second === undefined) return JSON.stringify({ conflicts: [] });
    return JSON.stringify({
      conflicts: [
        {
          between: [first, second],
          about: 'how much the failure screen may say',
          positions: [
            { lens: first, holds: 'the detail leaks the key' },
            { lens: second, holds: 'the reader cannot act without it' },
          ],
        },
      ],
    });
  }
  if (request.prompt.includes('Follow-up question:')) {
    return JSON.stringify({ answer: `The ${request.role} consultant answers the follow-up.` });
  }
  return JSON.stringify({ report: `The ${request.role} consultant reports.` });
}

export async function consultantsFixture(
  options: ConsultantsFixtureOptions = {},
): Promise<ConsultantsFixture> {
  const registry = await loadModelRegistry();
  const prompts: { role: string; prompt: string }[] = [];
  let calls = 0;
  let subscriptionCalls = 0;
  let meteredCalls = 0;

  function plainAdapter(provider: ProviderFamily): ProviderAdapter {
    return {
      family: provider,
      transport: registry[provider].transport,
      async availability() {
        return {
          status: 'available' as const,
          provider,
          model: registry[provider].primary,
          reason: '',
        };
      },
      async invoke(request: ProviderRequest) {
        calls += 1;
        prompts.push({ role: request.role, prompt: request.prompt });
        if (options.failing?.includes(provider) === true) {
          return {
            status: 'failed' as const,
            seatId: request.seatId,
            provider,
            requestedModel: registry[provider].primary,
            role: request.role,
            latencyMs: 1,
            error: {
              code: 'quota-exhausted',
              message: 'Deterministic quota fixture.',
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
          credentialPath: 'subscription' as const,
          answer: fixtureAnswer(request, options),
        };
      },
      async probe() {
        return {
          status: 'healthy' as const,
          provider,
          requestedModel: registry[provider].primary,
          actualModel: registry[provider].primary,
          latencyMs: 1,
          reason: '',
        };
      },
    };
  }

  /**
   * A subscription leg that always fails `quota-exhausted` — a fallback-permitting code — wrapped
   * with `withCredentialFallback` around a metered secondary that always answers. This is the only
   * shape that actually calls `SpendLedger.reserve()`, which is what the session cap governs.
   */
  function fallbackAdapter(provider: ProviderFamily): ProviderAdapter {
    const subscription: ProviderAdapter = {
      family: provider,
      transport: registry[provider].transport,
      async availability() {
        return {
          status: 'available' as const,
          provider,
          model: registry[provider].primary,
          reason: '',
        };
      },
      async invoke(request: ProviderRequest) {
        // Not counted in `calls` or recorded in `prompts`: it never answers, and
        // `withCredentialFallback` hands the fallback the same request object, so recording it
        // here would only duplicate whatever the metered leg logs for the same attempt.
        subscriptionCalls += 1;
        return {
          status: 'failed' as const,
          seatId: request.seatId,
          provider,
          requestedModel: registry[provider].primary,
          role: request.role,
          latencyMs: 1,
          error: {
            code: 'quota-exhausted',
            message: 'The subscription quota is spent.',
            retryable: true,
          },
        };
      },
      async probe() {
        return {
          status: 'healthy' as const,
          provider,
          requestedModel: registry[provider].primary,
          actualModel: registry[provider].primary,
          latencyMs: 1,
          reason: '',
        };
      },
    };
    const metered: ProviderAdapter = {
      family: provider,
      transport: registry[provider].transport,
      async availability() {
        return {
          status: 'available' as const,
          provider,
          model: registry[provider].primary,
          reason: '',
        };
      },
      async invoke(request: ProviderRequest) {
        meteredCalls += 1;
        calls += 1;
        prompts.push({ role: request.role, prompt: request.prompt });
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
          credentialPath: 'api-key' as const,
          answer: fixtureAnswer(request, options),
        };
      },
      async probe() {
        return {
          status: 'healthy' as const,
          provider,
          requestedModel: registry[provider].primary,
          actualModel: registry[provider].primary,
          latencyMs: 1,
          reason: '',
        };
      },
    };
    return withCredentialFallback(subscription, () => metered, 'http');
  }

  const adapters = Object.fromEntries(
    ProviderFamilySchema.options.map((provider) => [
      provider,
      options.fallback === true ? fallbackAdapter(provider) : plainAdapter(provider),
    ]),
  ) as Partial<Record<ProviderFamily, ProviderAdapter>>;

  return {
    environment: {
      registry,
      adapters,
      cwd: options.cwd ?? process.cwd(),
      env: { ...(options.env ?? {}) },
      now: () => NOW,
      modes: { consultants },
      ...(options.recordsRoot === undefined ? {} : { recordsRoot: options.recordsRoot }),
    },
    prompts: () => prompts,
    calls: () => calls,
    subscriptionCalls: () => subscriptionCalls,
    meteredCalls: () => meteredCalls,
  };
}

export async function temporaryRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const init = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
  if (init.exitCode !== 0) throw new Error('git init failed in the consultants fixture');
  return root;
}

// The throwaway identity records-commit.test.ts uses; GIT_CONFIG_GLOBAL points at a file that does
// not exist, so the machine's own global configuration cannot reach the temporary repository.
export function gitIdentity(root: string): Record<string, string> {
  const address = ['council-test', 'example.invalid'].join('@');
  return {
    GIT_AUTHOR_NAME: 'Council Test',
    GIT_AUTHOR_EMAIL: address,
    GIT_COMMITTER_NAME: 'Council Test',
    GIT_COMMITTER_EMAIL: address,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  };
}
