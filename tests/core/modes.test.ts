import { describe, expect, test } from 'bun:test';
import { MODE_NAMES, getMode, modes, resolveModeForCommand } from '../../src/modes';
import type { ModeResultView } from '../../src/modes/types';
import type {
  Availability,
  HealthResult,
  ModelRegistry,
  PolicyDecision,
  ProviderAdapter,
  ProviderContext,
  SeatResponse,
  SessionOptions,
} from '../../src/substrate';

function adapter(
  family: ProviderAdapter['family'],
  health: HealthResult['status'],
): ProviderAdapter {
  return {
    family,
    transport: 'http',
    async availability(): Promise<Availability> {
      return { status: 'available', provider: family, model: 'm', reason: 'stub' };
    },
    async invoke(): Promise<SeatResponse> {
      throw new Error('prepare must not invoke seats');
    },
    async probe(): Promise<HealthResult> {
      return {
        status: health,
        provider: family,
        requestedModel: 'm',
        actualModel: health === 'healthy' ? 'm' : null,
        latencyMs: 1,
        reason: health === 'healthy' ? 'ok' : 'down for the test',
      };
    },
  };
}

// `resolveHealthyProviders` reads each family's configured route while probing, so the fixture
// needs a real route per family rather than an empty registry; every route uses the mock
// adapters' own 'http' transport so the transport-safety check in `probeAdapter` never trips.
const registry: ModelRegistry = {
  anthropic: { primary: 'm', fallbacks: [], transport: 'http' },
  openai: { primary: 'm', fallbacks: [], transport: 'http' },
  xai: { primary: 'm', fallbacks: [], transport: 'http' },
  google: { primary: 'm', fallbacks: [], transport: 'http' },
  deepseek: { primary: 'm', fallbacks: [], transport: 'http' },
  moonshot: { primary: 'm', fallbacks: [], transport: 'http' },
};

const context: ProviderContext = {
  registry,
  env: {},
  cwd: 'C:/isolated',
  timeoutMs: 1_000,
};

const policyDecision = {
  kind: 'allowed',
  reasonCodes: [],
  blockedProviders: [],
  dispositions: [],
  redactions: [],
} as unknown as PolicyDecision;

function options(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    mode: 'committee',
    chaired: true,
    caller: { kind: 'human', harness: 'test', declared: true },
    dryRun: false,
    scope: 'general',
    classification: 'public',
    motion: 'motion',
    motionId: 'motion-1',
    runId: 'run-1',
    eligibleProviderFamilies: ['anthropic', 'openai', 'xai', 'google'],
    providerFamilies: ['anthropic', 'openai', 'xai', 'google'],
    impact: 'high',
    contested: true,
    domains: [],
    rounds: 2,
    timeoutMs: 1_000,
    billingMode: 'sub-first',
    ...overrides,
  };
}

describe('modes registry', () => {
  test('registers committee, second opinion and the advisor', () => {
    expect([...MODE_NAMES]).toEqual(['committee', 'second-opinion', 'advisor']);
    expect(modes.committee.pattern).toBe('rounds');
    expect(modes['second-opinion'].pattern).toBe('parallel');
    expect(modes.committee.spend.defaultCap(5, 2)).toBe(10);
    expect(modes['second-opinion'].spend.defaultCap(5, 1)).toBe(5);
  });

  test('an unknown mode fails with the whole registered list', () => {
    // Anchored on both ends: a prefix match passed while the advisor was missing from the listing.
    expect(() => getMode('forum')).toThrow(
      /^Unknown mode: forum\. Registered modes: committee, second-opinion, advisor$/,
    );
  });

  test('commands resolve to modes as they did before', () => {
    expect(resolveModeForCommand('council', true)).toBe('committee');
    expect(resolveModeForCommand('second-opinion', false)).toBe('second-opinion');
    expect(resolveModeForCommand('second-opinion', true)).toBe('committee');
    expect(resolveModeForCommand('run', false)).toBe('second-opinion');
    expect(resolveModeForCommand('run', true)).toBe('committee');
  });

  test('committee skips the health preflight when unchaired', async () => {
    const outcome = await modes.committee.prepare({
      options: options({ chaired: false }),
      adapters: { anthropic: adapter('anthropic', 'down') },
      context,
      policyDecision,
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    expect(outcome.options.providerFamilies).toEqual(['anthropic', 'openai', 'xai', 'google']);
  });

  test('a chaired committee blocks below three healthy families and reduces at exactly three', async () => {
    const blocked = await modes.committee.prepare({
      options: options(),
      adapters: {
        anthropic: adapter('anthropic', 'healthy'),
        openai: adapter('openai', 'healthy'),
        xai: adapter('xai', 'down'),
        google: adapter('google', 'down'),
      },
      context,
      policyDecision,
    });
    expect(blocked.kind).toBe('blocked-quorum');

    const reduced = await modes.committee.prepare({
      options: options(),
      adapters: {
        anthropic: adapter('anthropic', 'healthy'),
        openai: adapter('openai', 'healthy'),
        xai: adapter('xai', 'healthy'),
        google: adapter('google', 'down'),
      },
      context,
      policyDecision,
    });
    expect(reduced.kind).toBe('ready');
    if (reduced.kind !== 'ready') throw new Error('unreachable');
    expect(reduced.options.minimumFamilies).toBe(3);
    expect(reduced.options.reducedQuorumWarning).toContain('REDUCED-QUORUM COUNCIL');
    expect(reduced.unavailableProviders.map(({ provider }) => provider)).toEqual(['google']);
  });

  test('second opinion never probes and reports the panel', async () => {
    const outcome = await modes['second-opinion'].prepare({
      options: options({
        mode: 'second-opinion',
        chaired: false,
        rounds: 1,
        impact: 'medium',
        contested: false,
      }),
      adapters: { anthropic: adapter('anthropic', 'down') },
      context,
      policyDecision,
    });
    expect(outcome.kind).toBe('ready');

    const result: ModeResultView = {
      outcome: 'completed',
      // One successful family against a floor of three: `QuorumEvaluationSchema` cross-validates
      // `passed`/`failureReasons` against `successfulFamilies`, so this must report the shortfall
      // rather than claim a pass the evidence does not support.
      quorum: {
        passed: false,
        minimumDistinctFamilies: 3,
        successfulFamilies: ['anthropic'],
        requiresContrarian: false,
        contrarianSatisfied: true,
        failureReasons: ['insufficient-provider-families'],
      },
      rebuttalObligation: {
        minimumSuccessfulResponses: 0,
        successfulResponses: 0,
        satisfied: true,
      },
      synthesisEligible: true,
      rounds: [
        {
          round: 1,
          phase: 'analysis',
          retries: [],
          responses: [
            {
              status: 'ok',
              seatId: 'anthropic-seat',
              provider: 'anthropic',
              requestedModel: 'm',
              actualModel: 'm',
              modelIdentity: 'verified',
              route: 'primary',
              role: 'architect',
              latencyMs: 1,
              answer: '{"recommendation":"x"}',
            },
          ],
        },
      ],
    };
    const output = modes['second-opinion'].output({
      result,
      decisionState: 'awaiting-adjudication',
    });
    expect(modes['second-opinion'].outputSchema.parse(output)).toEqual(output);
    expect(output).toMatchObject({
      outcome: 'completed',
      panel: [
        {
          seat: 'anthropic-seat',
          family: 'anthropic',
          lens: 'architect',
          answer: '{"recommendation":"x"}',
        },
      ],
    });
    const committee = modes.committee.output({ result, decisionState: 'awaiting-adjudication' });
    expect(modes.committee.outputSchema.parse(committee)).toEqual(committee);
    expect(committee).toMatchObject({
      outcome: 'completed',
      decisionState: 'awaiting-adjudication',
    });
  });
});
