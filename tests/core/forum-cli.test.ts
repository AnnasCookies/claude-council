import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import {
  ProviderFamilySchema,
  ResultEnvelopeSchema,
  loadModelRegistry,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
} from '../../src/substrate';

const NOW = '2026-09-15T10:00:00.000Z';

function roundOf(prompt: string): number {
  const match = /This is round (\d+) of/u.exec(prompt);
  return match === null ? 0 : Number(match[1]);
}

function forumAnswer(request: ProviderRequest): string {
  const seat = request.seatId;
  if (roundOf(request.prompt) === 1) {
    return JSON.stringify({
      position: 'Keep the sidecar',
      stance: 'hold',
      text: `Opening from ${seat}.`,
      ...(seat.startsWith('anthropic')
        ? { motion: { text: 'Record the sidecar as the default placement.' } }
        : {}),
    });
  }
  return JSON.stringify(
    seat.startsWith('openai')
      ? {
          position: 'Sidecar, with a harness hook',
          stance: 'revise',
          text: `Reply from ${seat}.`,
          inReplyTo: null,
          supports: ['m-1'],
        }
      : {
          position: 'Keep the sidecar.',
          stance: 'hold',
          text: `Reply from ${seat}.`,
          inReplyTo: null,
        },
  );
}

async function fixtureEnvironment(): Promise<{
  environment: CliFacadeEnvironment;
  calls: () => number;
}> {
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
            answer: forumAnswer(request),
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
    environment: { registry, adapters, cwd: 'C:/fixture/project', env: {}, now: () => NOW },
    calls: () => calls,
  };
}

describe('the forum subcommand', () => {
  test('argues a motion over two rounds under a records root and returns a validated envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-forum-cli-'));
    try {
      const fixture = await fixtureEnvironment();
      const registry = await loadModelRegistry();
      const result = await runCliFacade(
        [
          'forum',
          '--records-root',
          root,
          '--seats',
          '6',
          '--rounds',
          '2',
          '--caller',
          'human',
          '--harness',
          'test',
          '--motion',
          'Should the advisor live in the harness or a sidecar?',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ command: 'forum', mode: 'forum', status: 'completed' });
      expect(payload.session).toMatch(/^fo-2026-09-15-[a-f0-9]{6}$/);
      const session = payload.session as string;

      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.pattern).toBe('rounds');
      expect(envelope.rounds).toBe(2);
      expect(envelope.seats).toHaveLength(6);
      expect(envelope.seats.map((seat) => seat.family)).toEqual([
        'anthropic',
        'openai',
        'xai',
        'google',
        'deepseek',
        'anthropic',
      ]);
      expect(envelope.seats.map((seat) => seat.lens)).toEqual([
        'strategist',
        'architect',
        'designer',
        'researcher',
        'maintainer',
        'operator',
      ]);
      expect(envelope.synthesis).toBeNull();
      expect(envelope.dissent).toBeNull();
      expect(envelope.unanimous).toBe(false);
      expect(envelope.spend).toMatchObject({
        billing: 'sub-first',
        policy: 'capped',
        cap: 12,
        used: 0,
        stoppedAtCap: false,
      });
      expect(envelope.record.session).toBe(`general/modes/forum/${session}.jsonl`);
      // A plain temporary directory is not a git work tree, so the ledger lands on disk but the
      // run reports it as not committed rather than failing.
      expect(envelope.record.committed).toBe(false);
      expect(envelope.degraded).toContainEqual(expect.stringContaining('records-not-committed'));

      const output = envelope.output as {
        rounds: { n: number; positions: unknown[] }[];
        map: { position: string; holders: string[] }[];
        moved: { seat: string; round: number }[];
        motions: { id: string; support: string[] }[];
      };
      expect(output.rounds.map((round) => round.n)).toEqual([1, 2]);
      expect(output.rounds[1]?.positions).toHaveLength(6);
      expect(output.map.map((entry) => entry.holders.length)).toEqual([5, 1]);
      expect(output.moved).toHaveLength(1);
      expect(output.moved[0]?.round).toBe(2);
      expect(output.motions[0]?.id).toBe('m-1');
      expect(output.motions[0]?.support).toEqual([`openai/${registry.openai.primary}#architect`]);
      expect(fixture.calls()).toBe(12);

      const log = await Bun.file(
        join(root, 'general', 'modes', 'forum', `${session}.jsonl`),
      ).text();
      const events = log
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { at: string; kind: string; data: unknown });
      expect(events.map((event) => event.kind)).toEqual(['opened', 'round', 'round', 'closed']);
      expect(events.every((event) => event.at === NOW)).toBe(true);
      expect(events[3]?.data).toEqual({ rounds: 2, reason: 'round-limit' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('degrades with no records root configured and exits 4', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      [
        'forum',
        '--seats',
        '3',
        '--rounds',
        '1',
        '--caller',
        'human',
        '--harness',
        'test',
        '--motion',
        'No records root is configured for this run',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(4);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ command: 'forum', mode: 'forum', status: 'degraded' });
    expect(payload.envelope.record).toEqual({ session: null });
    expect(payload.envelope.degraded).toEqual(
      expect.arrayContaining([expect.stringMatching(/^records-not-kept/)]),
    );
  });

  test('refuses to reuse an existing forum session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-forum-session-'));
    try {
      const fixture = await fixtureEnvironment();
      const first = await runCliFacade(
        [
          'forum',
          '--records-root',
          root,
          '--session',
          'fo-2026-09-15-0a1b2c',
          '--seats',
          '3',
          '--rounds',
          '1',
          '--caller',
          'human',
          '--harness',
          'test',
          '--motion',
          'Commit the ledger',
        ],
        fixture.environment,
      );
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).session).toBe('fo-2026-09-15-0a1b2c');

      // The same session id cannot be handed a second forum: the ledger stays one argument.
      const again = await runCliFacade(
        [
          'forum',
          '--records-root',
          root,
          '--session',
          'fo-2026-09-15-0a1b2c',
          '--seats',
          '3',
          '--rounds',
          '1',
          '--motion',
          'Commit the ledger',
        ],
        fixture.environment,
      );
      expect(again.exitCode).toBe(2);
      expect(again.stderr).toContain('already exists');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an explicit --spend-cap is passed straight through as the envelope spend cap', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(
      [
        'forum',
        '--seats',
        '3',
        '--rounds',
        '2',
        '--spend-cap',
        '20',
        '--caller',
        'human',
        '--harness',
        'test',
        '--motion',
        'An explicit cap should reach the envelope untouched',
      ],
      fixture.environment,
    );
    const payload = JSON.parse(result.stdout);
    expect(payload.envelope.spend).toMatchObject({
      policy: 'capped',
      cap: 20,
      stoppedAtCap: false,
    });
  });

  test('takes named catalogue lenses and supplied personas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-forum-personas-'));
    try {
      const fixture = await fixtureEnvironment();
      const lensed = await runCliFacade(
        [
          'forum',
          '--records-root',
          root,
          '--seats',
          '3',
          '--rounds',
          '1',
          '--lenses',
          'critic,security',
          '--caller',
          'human',
          '--harness',
          'test',
          '--motion',
          'Two lenses over three seats',
        ],
        fixture.environment,
      );
      expect(lensed.exitCode).toBe(0);
      expect(
        JSON.parse(lensed.stdout).envelope.seats.map((seat: { lens: string }) => seat.lens),
      ).toEqual(['critic', 'security', 'critic-2']);

      const personas = join(root, 'personas.json');
      await Bun.write(
        personas,
        JSON.stringify([
          { name: 'Ops manager', description: 'Runs the rota and carries the pager.' },
          { name: 'New starter', description: 'Joined last week and knows none of the history.' },
        ]),
      );
      const withPersonas = await runCliFacade(
        [
          'forum',
          '--records-root',
          root,
          '--seats',
          '2',
          '--rounds',
          '1',
          '--personas',
          personas,
          '--caller',
          'human',
          '--harness',
          'test',
          '--motion',
          'Two readers',
        ],
        fixture.environment,
      );
      expect(withPersonas.exitCode).toBe(0);
      expect(
        JSON.parse(withPersonas.stdout).envelope.seats.map((seat: { lens: string }) => seat.lens),
      ).toEqual(['ops-manager', 'new-starter']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--help describes the forum without running it', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(['forum', '--help'], fixture.environment);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ command: 'forum', mode: 'forum', pattern: 'rounds' });
    expect(payload.spend).toEqual({ policy: 'capped' });
    expect(payload.flags.value).toEqual(['seats', 'rounds', 'lenses', 'personas']);
    expect(payload.flags.boolean).toEqual([]);
    expect(payload.flags.common).toContain('spend-cap');
    expect(fixture.calls()).toBe(0);
  });

  test('refuses bad usage before any seat is invoked', async () => {
    const fixture = await fixtureEnvironment();
    const cases: [string[], number, string][] = [
      [['forum', '--seats', '6'], 2, 'requires --motion'],
      [['forum', '--seats', '1', '--motion', 'm'], 2, '--seats must be an integer from 2 to 24'],
      [['forum', '--rounds', '7', '--motion', 'm'], 2, '--rounds must be an integer from 1 to 6'],
      [['forum', '--lenses', 'nobody', '--motion', 'm'], 2, 'Unknown lens: nobody'],
      [['forum', '--lenses', 'critic', '--personas', 'p.json', '--motion', 'm'], 2, 'not both'],
      [['forum', '--session', 'nope', '--motion', 'm'], 2, 'session'],
      [['forum', '--bogus', '1', '--motion', 'm'], 2, 'Unknown option'],
      [['forum', 'positional', '--motion', 'm'], 2, 'options only'],
      [['forum', '--scope', 'project', '--motion', 'm'], 3, 'missing-project-policy'],
    ];
    for (const [argv, exitCode, message] of cases) {
      const result = await runCliFacade(argv, fixture.environment);
      expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), exitCode]);
      expect(result.stderr).toContain(message);
    }
    expect(fixture.calls()).toBe(0);
  });
});
