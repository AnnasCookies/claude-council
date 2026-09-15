import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  MODE_NAMES,
  SPECIFIED_MODE_NAMES,
  getMode,
  getRunnerMode,
  isHandlerMode,
  modes,
  type HandlerInput,
  type HandlerModeDefinition,
  type ModeRegistry,
} from '../../src/modes';
import type { ModelRegistry, PolicyDecision, ProviderContext } from '../../src/substrate';

const fixture: HandlerModeDefinition = {
  kind: 'handler',
  name: 'audience',
  knobs: {
    participants: 'many cheap seats, one persona each',
    pattern: 'parallel',
    aggregation: 'tallies and quotes',
    tempo: 'minutes',
    records: 'reactions with the draft hash',
  },
  pattern: 'parallel',
  spend: { policy: 'never-metered', defaultCap: () => 0 },
  flags: { value: ['personas'], boolean: ['quiet'] },
  outputSchema: z.strictObject({ personas: z.array(z.string()) }),
  async handle(input) {
    return {
      kind: 'result',
      status: 'completed',
      session: input.options.sessionId ?? 'au-2026-09-15-000000',
      pattern: 'parallel',
      rounds: 1,
      seats: [],
      output: { personas: input.flags.get('personas') ?? [] },
      synthesis: null,
      dissent: null,
      unanimous: false,
      degraded: [],
      spend: {
        billing: 'sub-only',
        policy: 'never-metered',
        cap: 0,
        used: 0,
        fallbacks: 0,
        refused: 0,
        stoppedAtCap: false,
      },
      record: { session: null, paths: [] },
    };
  },
};

const registry: ModelRegistry = {
  anthropic: { primary: 'm', fallbacks: [], transport: 'http' },
  openai: { primary: 'm', fallbacks: [], transport: 'http' },
  xai: { primary: 'm', fallbacks: [], transport: 'http' },
  google: { primary: 'm', fallbacks: [], transport: 'http' },
  deepseek: { primary: 'm', fallbacks: [], transport: 'http' },
  moonshot: { primary: 'm', fallbacks: [], transport: 'http' },
};

const context: ProviderContext = { registry, env: {}, cwd: 'C:/isolated', timeoutMs: 1_000 };

const allowed = {
  kind: 'allowed',
  reasonCodes: [],
  blockedProviders: [],
  dispositions: [],
  redactions: [],
} as unknown as PolicyDecision;

function input(overrides: Partial<HandlerInput> = {}): HandlerInput {
  return {
    command: 'audience',
    options: {
      caller: { kind: 'human', harness: 'test', declared: true },
      scope: 'general',
      classification: 'public',
      eligibleProviderFamilies: ['anthropic'],
      providerFamilies: ['anthropic'],
      timeoutMs: 1_000,
      billingMode: 'sub-only',
    },
    flags: new Map([['personas', ['sceptic', 'new-starter']]]),
    positionals: [],
    adapters: {},
    context,
    policyDecision: allowed,
    guard: () => allowed,
    sessions: null,
    spend: { policy: 'never-metered' },
    now: () => '2026-09-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('handler-style modes', () => {
  test('the specified names include the eight modes; the registered names are the eight this build carries', () => {
    expect([...SPECIFIED_MODE_NAMES]).toEqual([
      'committee',
      'second-opinion',
      'advisor',
      'ideation',
      'consultants',
      'forum',
      'triage',
      'audience',
    ]);
    expect([...MODE_NAMES]).toEqual([
      'committee',
      'second-opinion',
      'advisor',
      'ideation',
      'consultants',
      'forum',
      'triage',
      'audience',
    ]);
  });

  test('the runner modes and the handler modes are told apart by kind', () => {
    expect(isHandlerMode(modes.committee)).toBe(false);
    expect(isHandlerMode(modes['second-opinion'])).toBe(false);
    expect(isHandlerMode(modes.audience)).toBe(true);
    expect(isHandlerMode(fixture)).toBe(true);
    expect(getRunnerMode('committee').name).toBe('committee');
  });

  test('a registry override replaces a registered mode without touching the built-in one', () => {
    const registry: ModeRegistry = { ...modes, audience: fixture };
    expect(getMode('audience', registry)).toBe(fixture);
    expect(getMode('audience')).toBe(modes.audience);
    // `forum` is specified in docs/modes.md and not registered by this build, which is what the
    // refusal by name is for; `audience` is registered now and can no longer stand in for it.
    expect(() => getMode('forum')).toThrow(/Unknown mode: forum.*committee, second-opinion/);
    expect(() => getRunnerMode('audience', registry)).toThrow(/handler mode/);
    expect(getRunnerMode('second-opinion', registry).pattern).toBe('parallel');
  });

  test('a handler returns an outcome whose output satisfies its own schema', async () => {
    const outcome = await fixture.handle(
      input({ options: { ...input().options, sessionId: 'au-2026-09-15-0a1b2c' } }),
    );
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') throw new Error('unreachable');
    expect(outcome.session).toBe('au-2026-09-15-0a1b2c');
    expect(fixture.outputSchema.parse(outcome.output)).toEqual({
      personas: ['sceptic', 'new-starter'],
    });
  });
});
