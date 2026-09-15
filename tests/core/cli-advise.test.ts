import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import {
  ModeSessionStore,
  ProviderFamilySchema,
  ResultEnvelopeSchema,
  loadModelRegistry,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
} from '../../src/substrate';

const NOW = '2026-07-28T12:00:00.000Z';
const KEY = 'claude:6a07f29b-a0a5-4f23-91ab-2b6b2dbee514';

async function fixtureEnvironment(
  root: string,
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
            answer: JSON.stringify({
              severity: 'caution',
              text: `${provider}: that command is hard to undo; confirm the target first.`,
            }),
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
    environment: { registry, adapters, cwd: root, env: {}, now: () => NOW },
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

function advise(root: string, ...args: string[]): string[] {
  return [
    'advise',
    '--records-root',
    root,
    '--caller',
    'agent',
    '--harness',
    'claude-code',
    ...args,
  ];
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-advise-cli-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('advise through the CLI', () => {
  test('--hold returns a validated envelope with the note and commits nothing', async () => {
    await withRoot(async (root) => {
      const fixture = await fixtureEnvironment(root);
      const result = await runCliFacade(
        advise(root, '--session', KEY, '--hold', '--class', 'delete', '--tool', 'rm -rf build'),
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ command: 'advise', mode: 'advisor', status: 'completed' });
      expect(payload.session).toMatch(/^ad-2026-07-28-[a-f0-9]{6}$/);
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.pattern).toBe('streaming');
      expect(envelope.rounds).toBe(1);
      expect(envelope.caller).toEqual({ kind: 'agent', harness: 'claude-code', declared: true });
      expect(envelope.output).toMatchObject({
        note: {
          id: 'n-1',
          trigger: 'hold',
          severity: 'caution',
          status: 'ok',
          heeded: 'unknown',
          refersTo: { toolCall: 'rm -rf build' },
          seat: `anthropic/${fixture.environment.registry?.anthropic.primary}#advisor`,
        },
      });
      expect(envelope.seats).toHaveLength(1);
      expect(envelope.spend).toMatchObject({
        policy: 'never-metered',
        billing: 'sub-only',
        used: 0,
      });
      expect(envelope.degraded).toEqual([]);
      expect(envelope.record).toEqual({
        session: `general/modes/advisor/${payload.session}.jsonl`,
      });
      expect(fixture.calls()).toBe(1);
      const log = await Bun.file(
        ModeSessionStore.open(root).absolutePath('advisor', payload.session),
      ).text();
      expect(log.trimEnd().split('\n')).toHaveLength(1);
      expect(await ModeSessionStore.open(root).lookupAlias('advisor', KEY)).toBe(payload.session);
    });
  });

  test('--watch on stdin consults every Nth call and the window never leaves the process', async () => {
    await withRoot(async (root) => {
      const fixture = await fixtureEnvironment(root);
      // Two sentinels: one in the text the agent typed, one in what it was about to do. Neither is
      // a secret, so nothing redacts them — if either reaches the log or an envelope it is because
      // the window itself was recorded, which is the whole point of the excerpt-only contract.
      const sentinels = ['WINDOW-SENTINEL-PROMPT', 'WINDOW-SENTINEL-PLAN'];
      const window = `user: migrate the table ${sentinels[0]}\nassistant: I will drop and recreate it ${sentinels[1]}`;
      const statuses: string[] = [];
      const envelopes: string[] = [];
      let session = '';
      for (let turn = 0; turn < 3; turn += 1) {
        const result = await runCliFacade(
          advise(root, '--session', KEY, '--watch', '--every', '3', '--transcript', '-'),
          { ...fixture.environment, stdin: window },
        );
        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        session = payload.session;
        statuses.push(payload.envelope.output.note.status);
        envelopes.push(JSON.stringify(ResultEnvelopeSchema.parse(payload.envelope)));
      }
      expect(statuses).toEqual(['skipped', 'skipped', 'ok']);
      expect(fixture.calls()).toBe(1);
      const log = await Bun.file(
        ModeSessionStore.open(root).absolutePath('advisor', session),
      ).text();
      for (const sentinel of sentinels) {
        expect(log).not.toContain(sentinel);
        for (const envelope of envelopes) expect(envelope).not.toContain(sentinel);
      }
    });
  });

  test('--ask, --note, --heed and --status round-trip through the log', async () => {
    await withRoot(async (root) => {
      const fixture = await fixtureEnvironment(root);
      const asked = await runCliFacade(
        advise(root, '--session', KEY, '--ask', 'Is there a simpler route than a migration?'),
        fixture.environment,
      );
      expect(asked.exitCode).toBe(0);
      expect(JSON.parse(asked.stdout).envelope.output.note).toMatchObject({
        id: 'n-1',
        trigger: 'ask',
        status: 'ok',
      });
      const posted = await runCliFacade(
        advise(root, '--session', KEY, '--note', '--from', 'omp', 'check the lockfile'),
        fixture.environment,
      );
      expect(posted.exitCode).toBe(0);
      expect(JSON.parse(posted.stdout).envelope.output.note).toMatchObject({
        id: 'n-2',
        trigger: 'external',
        seat: 'omp',
        text: 'check the lockfile',
      });
      const heeded = await runCliFacade(
        advise(root, '--session', KEY, '--heed', 'n-1', 'yes'),
        fixture.environment,
      );
      expect(heeded.exitCode).toBe(0);
      expect(JSON.parse(heeded.stdout).envelope.output).toEqual({
        heeded: { id: 'n-1', value: 'yes' },
      });
      const status = await runCliFacade(
        advise(root, '--session', KEY, '--status'),
        fixture.environment,
      );
      expect(status.exitCode).toBe(0);
      const block = JSON.parse(status.stdout).envelope.output.status;
      expect(block.exists).toBe(true);
      expect(block.notes).toBe(2);
      expect(block.last).toMatchObject({ id: 'n-2', trigger: 'external' });
      const unknown = await runCliFacade(
        advise(root, '--session', 'claude:nobody', '--status'),
        fixture.environment,
      );
      expect(unknown.exitCode).toBe(0);
      const unbound = JSON.parse(unknown.stdout);
      expect(unbound.envelope.output).toEqual({
        status: { exists: false, notes: 0, last: null },
      });
      // No log is bound to the key, so there is no session id to report — and the harness key is
      // not one, so it does not go in the field every other envelope fills with an id of ours.
      expect(unbound.envelope.session).toBe('unknown');
      expect(unbound.envelope.session).not.toContain('claude:nobody');
      expect(fixture.calls()).toBe(1);
    });
  });

  test('--end commits the log, renders minutes with the output block, and ends only once', async () => {
    await withRoot(async (root) => {
      expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0);
      const fixture = await fixtureEnvironment(root);
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: { ...gitIdentity(root), COUNCIL_MINUTES_DIR: join(root, 'minutes') },
      };
      const hold = await runCliFacade(
        advise(root, '--session', KEY, '--hold', '--class', 'deploy', '--tool', 'wrangler deploy'),
        environment,
      );
      expect(hold.exitCode).toBe(0);
      const session = JSON.parse(hold.stdout).session;
      const ended = await runCliFacade(advise(root, '--session', KEY, '--end'), environment);
      expect(ended.exitCode).toBe(0);
      const payload = JSON.parse(ended.stdout);
      expect(payload.envelope.output).toEqual({ ended: { notes: 1, committed: true } });
      expect(payload.envelope.record.session).toBe(`general/modes/advisor/${session}.jsonl`);
      expect(payload.envelope.record.committed).toBe(true);
      expect(payload.envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(payload.envelope.seats.map((seat: { id: string }) => seat.id)).toEqual([
        `anthropic/${fixture.environment.registry?.anthropic.primary}#advisor`,
      ]);
      const minutes = await Bun.file(payload.envelope.record.minutes).text();
      expect(minutes).toContain(`# Minutes: advisor ${session}`);
      expect(minutes).toContain('## Output');
      expect(minutes).toContain('"notes": 1');
      expect(minutes).toContain(`general/modes/advisor/${session}.jsonl`);
      expect(minutes).not.toContain('wrangler deploy');
      const shown = Bun.spawnSync({
        cmd: ['git', 'show', '--name-only', '--format=%s', 'HEAD'],
        cwd: root,
        env: { ...process.env, ...gitIdentity(root) },
      });
      expect(shown.stdout.toString()).toContain(`advise: record ${session}`);
      expect(shown.stdout.toString()).toContain(`general/modes/advisor/${session}.jsonl`);
      const again = await runCliFacade(advise(root, '--session', KEY, '--end'), environment);
      expect(again.exitCode).toBe(0);
      const repeated = JSON.parse(again.stdout);
      expect(repeated.envelope.output).toEqual({ ended: { notes: 1, committed: false } });
      expect(repeated.envelope.record).toEqual({
        session: `general/modes/advisor/${session}.jsonl`,
      });
      const late = await runCliFacade(advise(root, '--session', KEY, '--ask', 'q'), environment);
      expect(late.exitCode).toBe(2);
      expect(late.stderr).toContain('has ended');
    });
  });

  test('usage and policy mistakes exit 2 before any seat is invoked', async () => {
    await withRoot(async (root) => {
      const fixture = await fixtureEnvironment(root);
      const cases: [string[], string][] = [
        [
          advise(root, '--session', KEY, '--hold', '--class', 'network', '--tool', 'curl'),
          'destructive-git, delete, deploy, payment, credential',
        ],
        [advise(root, '--session', KEY, '--hold', '--class', 'delete'), '--tool'],
        [advise(root, '--session', KEY, '--watch', '--every', '3'), '--transcript'],
        [advise(root, '--session', KEY), 'exactly one of'],
        [
          advise(root, '--session', KEY, '--ask', 'q', '--billing', 'api-only'),
          'never spends a metered key',
        ],
        [advise(root, '--ask', 'q'), '--session'],
        [['advise', '--session', KEY, '--ask', 'q'], '--records-root'],
        [advise(root, '--session', KEY, '--heed', 'n-1', 'yes'), 'Unknown advisor session'],
        [advise(root, '--session', KEY, '--bogus', '1'), 'Unknown option'],
      ];
      for (const [argv, message] of cases) {
        const result = await runCliFacade(argv, fixture.environment);
        expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 2]);
        expect(result.stderr).toContain(message);
      }
      expect(fixture.calls()).toBe(0);
    });
  });

  test('help, modes and --help describe the advisor', async () => {
    await withRoot(async (root) => {
      const help = JSON.parse((await runCliFacade(['help'])).stdout);
      expect(help.commands).toContain('advise');
      expect(help.handlerOptions['--session <id>']).toContain('advise');
      const modes = JSON.parse((await runCliFacade(['modes'])).stdout);
      expect(modes.modes).toContainEqual(
        expect.objectContaining({
          name: 'advisor',
          kind: 'handler',
          pattern: 'streaming',
          spend: { policy: 'never-metered' },
        }),
      );
      const fixture = await fixtureEnvironment(root);
      const described = await runCliFacade(['advise', '--help'], fixture.environment);
      expect(described.exitCode).toBe(0);
      const payload = JSON.parse(described.stdout);
      expect(payload.flags.boolean).toEqual(['watch', 'hold', 'note', 'start', 'end', 'status']);
      expect(payload.flags.value).toContain('window-ms');
      expect(fixture.calls()).toBe(0);
    });
  });
});
