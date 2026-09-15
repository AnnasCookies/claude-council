import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import type { HandlerModeDefinition } from '../../src/modes';
import {
  ProviderFamilySchema,
  ResultEnvelopeSchema,
  loadModelRegistry,
  newModeSessionId,
  panelEnvelopeSeats,
  runPanel,
  spreadSeats,
  withCredentialFallback,
  type PanelLens,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
} from '../../src/substrate';

const NOW = '2026-07-28T12:00:00.000Z';
const VoteSchema = z.strictObject({ vote: z.enum(['yes', 'no']), note: z.string().min(1) });

/**
 * The smallest handler mode that exercises the whole path: a panel over the chosen families,
 * one session event, the envelope fields the CLI cannot know. It lives only in this test.
 */
const audience: HandlerModeDefinition = {
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
  flags: { value: ['voices'], boolean: ['quiet'] },
  outputSchema: z.strictObject({
    quiet: z.boolean(),
    votes: z.array(z.strictObject({ seat: z.string(), vote: z.enum(['yes', 'no']) })),
  }),
  async handle(input) {
    const voices = Number(input.flags.get('voices')?.[0] ?? '3');
    const lenses: PanelLens[] = Array.from({ length: voices }, (_, index) => ({
      name: `voice-${index + 1}`,
      description: `Reader ${index + 1} reacts to the draft.`,
    }));
    const seats = spreadSeats(input.options.providerFamilies, lenses, input.context.registry);
    const panel = await runPanel(
      { adapters: input.adapters, context: input.context },
      {
        seats,
        prompt: (seat) => `${seat.lens.description}\n\nDraft:\n${input.options.motion ?? ''}`,
        answer: {
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
        },
        spend: input.spend,
      },
    );
    const session = input.options.sessionId ?? newModeSessionId('au', input.now());
    const paths =
      input.sessions === null
        ? []
        : (
            await input.sessions.append('audience', session, {
              at: input.now(),
              kind: 'reactions',
              data: panel.seats,
            })
          ).paths;
    const complete = panel.answered === seats.length;
    return {
      kind: 'result',
      status: complete ? 'completed' : 'degraded',
      session,
      pattern: 'parallel',
      rounds: 1,
      seats: panelEnvelopeSeats(panel.seats),
      output: {
        quiet: input.flags.has('quiet'),
        votes: panel.seats.flatMap((seat) =>
          seat.status === 'ok' ? [{ seat: seat.id, vote: seat.answer.vote }] : [],
        ),
      },
      synthesis: null,
      dissent: null,
      unanimous: false,
      degraded: complete ? [] : ['voices-missing'],
      spend: panel.spend,
      record: {
        session: input.sessions === null ? null : input.sessions.recordPath('audience', session),
        paths,
      },
    };
  },
};

const voteAnswer = {
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

/**
 * A capped mode whose subscription seat always fails and whose metered fallback would rescue it,
 * so whatever the CLI put in the ledger is what decides the seat. It exists to prove `--spend-cap`
 * reaches the handler path's seats rather than being parsed and dropped.
 */
const consultants: HandlerModeDefinition = {
  kind: 'handler',
  name: 'consultants',
  knobs: {
    participants: 'a few expensive seats',
    pattern: 'parallel',
    aggregation: 'one brief each',
    tempo: 'hours',
    records: 'the brief and its answers',
  },
  pattern: 'parallel',
  spend: { policy: 'capped', defaultCap: (seats, rounds) => seats * rounds },
  flags: { value: [], boolean: [] },
  outputSchema: z.strictObject({ answered: z.number() }),
  async handle(input) {
    const seats = spreadSeats(
      input.options.providerFamilies,
      [{ name: 'brief', description: 'The consultant reads the brief.' }],
      input.context.registry,
    );
    const panel = await runPanel(
      { adapters: input.adapters, context: input.context },
      {
        seats,
        prompt: () => input.options.motion ?? '',
        answer: voteAnswer,
        spend: input.spend,
      },
    );
    const complete = panel.answered === seats.length;
    return {
      kind: 'result',
      status: complete ? 'completed' : 'degraded',
      session: input.options.sessionId ?? newModeSessionId('co', input.now()),
      pattern: 'parallel',
      rounds: 1,
      seats: panelEnvelopeSeats(panel.seats),
      output: { answered: panel.answered },
      synthesis: null,
      dissent: null,
      unanimous: false,
      degraded: [],
      spend: panel.spend,
      record: { session: null, paths: [] },
    };
  },
};

/** One family, its subscription always exhausted and a metered key that would answer instead. */
async function cappedFixtureEnvironment(): Promise<{
  environment: CliFacadeEnvironment;
  metered: () => number;
}> {
  const registry = await loadModelRegistry();
  let metered = 0;
  const available = {
    status: 'available',
    provider: 'anthropic',
    model: registry.anthropic.primary,
    reason: '',
  } as const;
  const healthy = {
    status: 'healthy',
    provider: 'anthropic',
    requestedModel: registry.anthropic.primary,
    actualModel: registry.anthropic.primary,
    latencyMs: 1,
    reason: '',
  } as const;
  const subscription: ProviderAdapter = {
    family: 'anthropic',
    transport: registry.anthropic.transport,
    async availability() {
      return available;
    },
    async invoke(request: ProviderRequest) {
      return {
        status: 'failed',
        seatId: request.seatId,
        provider: 'anthropic',
        requestedModel: registry.anthropic.primary,
        role: request.role,
        latencyMs: 1,
        error: {
          code: 'quota-exhausted',
          message: 'Deterministic quota fixture.',
          retryable: false,
        },
      };
    },
    async probe() {
      return healthy;
    },
  };
  const api: ProviderAdapter = {
    family: 'anthropic',
    transport: 'http',
    async availability() {
      return available;
    },
    async invoke(request: ProviderRequest) {
      metered += 1;
      return {
        status: 'ok',
        seatId: request.seatId,
        provider: 'anthropic',
        requestedModel: registry.anthropic.primary,
        actualModel: registry.anthropic.primary,
        modelIdentity: 'verified',
        route: 'primary',
        role: request.role,
        latencyMs: 1,
        credentialPath: 'api-key',
        answer: JSON.stringify({ vote: 'yes', note: 'The metered key answered.' }),
      };
    },
    async probe() {
      return healthy;
    },
  };
  return {
    environment: {
      registry,
      adapters: { anthropic: withCredentialFallback(subscription, () => api, 'http') },
      cwd: 'C:/fixture/project',
      env: {},
      now: () => NOW,
      modes: { consultants },
    },
    metered: () => metered,
  };
}

async function fixtureEnvironment(
  failing: readonly ProviderFamily[] = [],
): Promise<{ environment: CliFacadeEnvironment; calls: () => number }> {
  const registry = await loadModelRegistry();
  let calls = 0;
  const adapters = Object.fromEntries(
    ProviderFamilySchema.options.map((provider) => [
      provider,
      {
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
          if (failing.includes(provider)) {
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
            answer: JSON.stringify({ vote: 'yes', note: `${provider} would act on this.` }),
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
      } satisfies ProviderAdapter,
    ]),
  ) as Partial<Record<ProviderFamily, ProviderAdapter>>;
  return {
    environment: {
      registry,
      adapters,
      cwd: 'C:/fixture/project',
      env: {},
      now: () => NOW,
      modes: { audience },
    },
    calls: () => calls,
  };
}

// The throwaway identity records-commit.test.ts uses; GIT_CONFIG_GLOBAL points at a file that
// does not exist so the machine's own global configuration cannot reach the temporary repository.
function gitIdentity(root: string): Record<string, string> {
  const address = ['council-test', 'example.invalid'].join('@');
  return {
    GIT_AUTHOR_NAME: 'Council Test',
    GIT_AUTHOR_EMAIL: address,
    GIT_COMMITTER_NAME: 'Council Test',
    GIT_COMMITTER_EMAIL: address,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  };
}

describe('handler mode dispatch', () => {
  test('runs a registered handler mode end to end and returns a validated envelope', async () => {
    const fixture = await fixtureEnvironment();
    const registry = await loadModelRegistry();
    const result = await runCliFacade(
      ['audience', '--motion', 'Ship the announcement', '--caller', 'agent', '--harness', 'test'],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ command: 'audience', mode: 'audience', status: 'completed' });
    expect(payload.session).toMatch(/^au-2026-07-28-[a-f0-9]{6}$/);
    const envelope = ResultEnvelopeSchema.parse(payload.envelope);
    expect(envelope.mode).toBe('audience');
    expect(envelope.session).toBe(payload.session);
    expect(envelope.caller).toEqual({ kind: 'agent', harness: 'test', declared: true });
    expect(envelope.seats.map((seat) => seat.id)).toEqual([
      `anthropic/${registry.anthropic.primary}#voice-1`,
      `openai/${registry.openai.primary}#voice-2`,
      `xai/${registry.xai.primary}#voice-3`,
    ]);
    expect(envelope.seats.every((seat) => seat.status === 'ok')).toBe(true);
    expect(envelope.output).toMatchObject({ quiet: false });
    expect(envelope.output.votes).toHaveLength(3);
    expect(envelope.spend).toMatchObject({ policy: 'never-metered', billing: 'sub-only', used: 0 });
    expect(envelope.degraded).toEqual([]);
    expect(envelope.record).toEqual({ session: null });
    expect(payload.preflight.selectedProviders).toEqual([
      'anthropic',
      'openai',
      'xai',
      'google',
      'deepseek',
    ]);
    expect(fixture.calls()).toBe(3);
  });

  test('spreads voices over the chosen families and honours the mode flags', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      [
        'audience',
        '--providers',
        'anthropic,openai,xai,google',
        '--voices',
        '12',
        '--quiet',
        '--motion',
        'Twelve readers',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const families = payload.envelope.seats.map((seat: { family: string }) => seat.family);
    expect(families.filter((family: string) => family === 'anthropic')).toHaveLength(3);
    expect(families.filter((family: string) => family === 'google')).toHaveLength(3);
    expect(payload.envelope.output.quiet).toBe(true);
    expect(payload.envelope.degraded).toEqual(['caller-undeclared']);
    expect(fixture.calls()).toBe(12);
  });

  test('a missing voice degrades the run and is recorded as skipped under never-metered', async () => {
    const fixture = await fixtureEnvironment(['xai']);
    const result = await runCliFacade(
      ['audience', '--motion', 'One voice short'],
      fixture.environment,
    );
    expect(result.exitCode).toBe(4);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe('degraded');
    const envelope = ResultEnvelopeSchema.parse(payload.envelope);
    expect(envelope.seats[2]).toMatchObject({ family: 'xai', status: 'skipped', transport: null });
    expect(envelope.seats[2]?.reason).toContain('never-metered');
    expect(envelope.degraded).toEqual(['caller-undeclared', 'voices-missing']);
  });

  test('--spend-cap binds the metered fallbacks a capped handler mode may take', async () => {
    const fixture = await cappedFixtureEnvironment();
    const result = await runCliFacade(
      ['consult', '--providers', 'anthropic', '--spend-cap', '0', '--motion', 'Bound the spend'],
      fixture.environment,
    );
    expect(result.exitCode).toBe(4);
    const payload = JSON.parse(result.stdout);
    const envelope = ResultEnvelopeSchema.parse(payload.envelope);
    expect(fixture.metered()).toBe(0);
    expect(envelope.spend).toEqual({
      billing: 'sub-first',
      policy: 'capped',
      cap: 0,
      used: 0,
      fallbacks: 0,
      refused: 1,
      stoppedAtCap: true,
    });
    // The runner path reports an exhausted cap the same way: the seat keeps its own failure, the
    // envelope is marked, and the command exits 4.
    expect(envelope.seats[0]).toMatchObject({ family: 'anthropic', status: 'failed' });
    expect(envelope.seats[0]?.reason).toContain('spend cap of 0');
    expect(envelope.degraded).toContain('spend-cap-reached');
    expect(payload.spendWarning).toContain('spend cap of 0');
  });

  test("without --spend-cap the ledger takes the mode's own default cap", async () => {
    const fixture = await cappedFixtureEnvironment();
    const result = await runCliFacade(
      ['consult', '--providers', 'anthropic', '--motion', 'Spend what the mode allows'],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const envelope = ResultEnvelopeSchema.parse(JSON.parse(result.stdout).envelope);
    // defaultCap(seats, rounds) over the six eligible families and the one round.
    expect(envelope.spend).toEqual({
      billing: 'sub-first',
      policy: 'capped',
      cap: 6,
      used: 1,
      fallbacks: 1,
      refused: 0,
      stoppedAtCap: false,
    });
    expect(fixture.metered()).toBe(1);
    expect(envelope.seats[0]).toMatchObject({ status: 'ok', transport: 'api', fallback: true });
  });

  test('commits the session log and writes minutes when a records root is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-handler-commit-'));
    try {
      expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0);
      const fixture = await fixtureEnvironment();
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: { ...gitIdentity(root), COUNCIL_MINUTES_DIR: join(root, 'minutes') },
      };
      const result = await runCliFacade(
        [
          'audience',
          '--records-root',
          root,
          '--session',
          'au-2026-07-28-0a1b2c',
          '--motion',
          'Commit me',
        ],
        environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.session).toBe('au-2026-07-28-0a1b2c');
      expect(payload.envelope.record.session).toBe(
        'general/modes/audience/au-2026-07-28-0a1b2c.jsonl',
      );
      expect(payload.envelope.record.committed).toBe(true);
      expect(payload.envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(payload.envelope.record.minutes).toContain(join(root, 'minutes'));
      expect(await Bun.file(payload.envelope.record.minutes).text()).toContain(
        '# Minutes: audience',
      );
      const log = await Bun.file(
        join(root, 'general', 'modes', 'audience', 'au-2026-07-28-0a1b2c.jsonl'),
      ).text();
      const lines = log.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ at: NOW, kind: 'reactions' });
      const shown = Bun.spawnSync({
        cmd: ['git', 'show', '--name-only', '--format=%s', 'HEAD'],
        cwd: root,
        env: { ...process.env, ...gitIdentity(root) },
      });
      expect(shown.stdout.toString()).toContain('audience: record au-2026-07-28-0a1b2c');
      expect(shown.stdout.toString()).toContain(
        'general/modes/audience/au-2026-07-28-0a1b2c.jsonl',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a plain records root reports records-not-committed and still succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-handler-nocommit-'));
    try {
      const fixture = await fixtureEnvironment();
      const result = await runCliFacade(
        ['audience', '--records-root', root, '--motion', 'No git here'],
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

  test('refuses the same usage mistakes the run commands refuse, before any seat is invoked', async () => {
    const fixture = await fixtureEnvironment();
    const cases: [string[], number, string][] = [
      [['audience', '--harness', 'x', '--motion', 'm'], 2, 'require --caller'],
      [['audience', '--session', 'nope', '--motion', 'm'], 2, 'session'],
      [['audience', '--billing', 'api-only', '--motion', 'm'], 2, 'never spends a metered key'],
      [['audience', '--bogus', '1', '--motion', 'm'], 2, 'Unknown option'],
      [['audience', 'positional', '--motion', 'm'], 2, 'options only'],
      [['audience', '--scope', 'project', '--motion', 'm'], 3, 'missing-project-policy'],
    ];
    for (const [argv, exitCode, message] of cases) {
      const result = await runCliFacade(argv, fixture.environment);
      expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), exitCode]);
      expect(result.stderr).toContain(message);
    }
    expect(fixture.calls()).toBe(0);
  });

  test('a specified mode this build does not register is refused by name', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(['audience', '--motion', 'm'], {
      ...fixture.environment,
      modes: {},
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('does not register');
    expect(result.stderr).toContain('audience');
    expect(fixture.calls()).toBe(0);
  });

  test('help, modes and the unknown-command message name the handler subcommands', async () => {
    const help = JSON.parse((await runCliFacade(['help'])).stdout);
    for (const command of ['advise', 'ideate', 'consult', 'forum', 'triage', 'audience']) {
      expect(help.commands).toContain(command);
    }
    expect(help.handlerCommands).toEqual({
      advise: { mode: 'advisor', registered: true },
      ideate: { mode: 'ideation', registered: true },
      consult: { mode: 'consultants', registered: false },
      forum: { mode: 'forum', registered: false },
      triage: { mode: 'triage', registered: false },
      audience: { mode: 'audience', registered: false },
    });
    const unknown = await runCliFacade(['bogus']);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('consult');

    const fixture = await fixtureEnvironment();
    // A build that registers the mode says so, so the listing never advertises six subcommands
    // that every one of them would refuse.
    const injectedHelp = JSON.parse((await runCliFacade(['help'], fixture.environment)).stdout);
    expect(injectedHelp.handlerCommands.audience).toEqual({ mode: 'audience', registered: true });
    expect(injectedHelp.handlerCommands.forum).toEqual({ mode: 'forum', registered: false });
    const injected = JSON.parse((await runCliFacade(['modes'], fixture.environment)).stdout);
    expect(
      injected.modes.map((mode: { name: string; kind: string }) => [mode.name, mode.kind]),
    ).toEqual([
      ['committee', 'runner'],
      ['second-opinion', 'runner'],
      ['advisor', 'handler'],
      ['ideation', 'handler'],
      ['audience', 'handler'],
    ]);
    const builtIn = JSON.parse((await runCliFacade(['modes'])).stdout);
    expect(builtIn.modes.map((mode: { name: string }) => mode.name)).toEqual([
      'committee',
      'second-opinion',
      'advisor',
      'ideation',
    ]);
  });

  test('--help describes a handler mode without running it', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(['audience', '--help'], fixture.environment);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ command: 'audience', mode: 'audience', pattern: 'parallel' });
    expect(payload.flags.value).toEqual(['voices']);
    expect(payload.flags.boolean).toEqual(['quiet']);
    expect(payload.flags.common).toContain('session');
    expect(fixture.calls()).toBe(0);
  });
});
