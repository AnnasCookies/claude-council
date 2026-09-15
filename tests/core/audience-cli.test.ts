import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import {
  ProviderFamilySchema,
  ResultEnvelopeSchema,
  loadModelRegistry,
  type Availability,
  type HealthResult,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
  type SeatResponse,
} from '../../src/substrate';

const NOW = '2026-09-15T10:00:00.000Z';
const PERSONAS = 'ops-manager,new-starter,sceptic';
const DRAFT = '# Announcement\n\nThe rota changes on Monday. Confirm your shifts by Friday.\n';
const registry = await loadModelRegistry();

function reaction(persona: string): string {
  return JSON.stringify({
    clear: persona !== 'sceptic',
    wouldAct: persona === 'ops-manager',
    stoppedAt: persona === 'sceptic' ? 'paragraph 3' : 'the end',
    quote: `The ${persona} says the rota line is the only part that matters.`,
  });
}

async function fixture(
  cwd: string,
  failing: readonly ProviderFamily[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<{ environment: CliFacadeEnvironment; calls: () => number }> {
  let calls = 0;
  const adapters = Object.fromEntries(
    ProviderFamilySchema.options.map((provider) => [
      provider,
      {
        family: provider,
        transport: registry[provider].transport,
        async availability(): Promise<Availability> {
          return {
            status: 'available',
            provider,
            model: registry[provider].primary,
            reason: '',
          };
        },
        async invoke(request: ProviderRequest): Promise<SeatResponse> {
          calls += 1;
          if (failing.includes(provider)) {
            return {
              status: 'failed',
              seatId: request.seatId,
              provider,
              requestedModel: registry[provider].primary,
              role: request.role,
              latencyMs: 1,
              error: {
                code: 'quota-exhausted',
                message: 'Deterministic subscription exhaustion.',
                retryable: false,
              },
            };
          }
          return {
            status: 'ok',
            seatId: request.seatId,
            provider,
            requestedModel: registry[provider].primary,
            actualModel: registry[provider].primary,
            modelIdentity: 'verified',
            route: 'primary',
            role: request.role,
            latencyMs: 1,
            credentialPath: 'subscription',
            answer: reaction(request.role),
          };
        },
        async probe(): Promise<HealthResult> {
          return {
            status: 'healthy',
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
    environment: { registry, adapters, cwd, env, now: () => NOW },
    calls: () => calls,
  };
}

async function withDraft(
  run: (directory: string) => Promise<void>,
  text: string = DRAFT,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'convene-audience-cli-'));
  try {
    await writeFile(join(directory, 'announcement.md'), text);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The throwaway identity records-commit.test.ts uses; GIT_CONFIG_GLOBAL points at a file that does
// not exist so the machine's own global configuration cannot reach the temporary repository.
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

describe('the audience subcommand', () => {
  test('runs end to end and returns a validated envelope', async () => {
    await withDraft(async (directory) => {
      const harness = await fixture(directory);
      const result = await runCliFacade(
        [
          'audience',
          '--personas',
          PERSONAS,
          '--draft',
          'announcement.md',
          '--question',
          'Will an ops manager act on this?',
          '--caller',
          'human',
          '--harness',
          'test',
        ],
        harness.environment,
      );
      // No --records-root is given, so this run degrades even though every voice answered: exit 4,
      // not 0, matches every other handler mode's rule that a non-empty `degraded` is not
      // `completed`.
      expect(result.exitCode).toBe(4);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ command: 'audience', mode: 'audience', status: 'degraded' });
      expect(payload.session).toMatch(/^au-2026-09-15-[a-f0-9]{6}$/);
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.mode).toBe('audience');
      expect(envelope.pattern).toBe('parallel');
      expect(envelope.rounds).toBe(1);
      expect(envelope.caller).toEqual({ kind: 'human', harness: 'test', declared: true });
      expect(envelope.seats.map((seat) => [seat.family, seat.lens])).toEqual([
        ['anthropic', 'ops-manager'],
        ['openai', 'new-starter'],
        ['xai', 'sceptic'],
      ]);
      expect(envelope.output.personas).toEqual(['ops-manager', 'new-starter', 'sceptic']);
      expect(envelope.output.tallies).toEqual({
        answered: 3,
        clear: { yes: 2, no: 1 },
        wouldAct: { yes: 1, no: 2 },
      });
      expect(envelope.spend).toMatchObject({
        billing: 'sub-only',
        policy: 'never-metered',
        used: 0,
        cap: 0,
      });
      // The CLI selected five families; the mode will not seat the metered-only one and says so.
      expect(payload.preflight.selectedProviders).toEqual([
        'anthropic',
        'openai',
        'xai',
        'google',
        'deepseek',
      ]);
      expect(envelope.degraded).toEqual([
        'metered-only-families-unseated: deepseek',
        'records-not-kept: no records root is configured',
      ]);
      expect(envelope.record).toEqual({ session: null });
      expect(harness.calls()).toBe(3);
    });
  });

  test('writes, commits and renders the session log under a records root', async () => {
    await withDraft(async (directory) => {
      const root = await mkdtemp(join(tmpdir(), 'convene-audience-records-'));
      try {
        expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0);
        const harness = await fixture(directory, [], {
          ...gitIdentity(root),
          COUNCIL_MINUTES_DIR: join(root, 'minutes'),
        });
        const result = await runCliFacade(
          [
            'audience',
            '--personas',
            PERSONAS,
            '--draft',
            'announcement.md',
            '--providers',
            'anthropic,openai,xai',
            '--records-root',
            root,
            '--session',
            'au-2026-09-15-0a1b2c',
            '--caller',
            'human',
            '--harness',
            'test',
          ],
          harness.environment,
        );
        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        // Every voice answered and the records root took the log: a clean run, nothing degraded.
        expect(payload.status).toBe('completed');
        expect(payload.session).toBe('au-2026-09-15-0a1b2c');
        expect(payload.envelope.record.session).toBe(
          'general/modes/audience/au-2026-09-15-0a1b2c.jsonl',
        );
        expect(payload.envelope.record.committed).toBe(true);
        expect(payload.envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
        expect(payload.envelope.degraded).toEqual([]);
        expect(await readFile(payload.envelope.record.minutes, 'utf8')).toContain(
          '# Minutes: audience au-2026-09-15-0a1b2c',
        );

        const log = await readFile(
          join(root, 'general', 'modes', 'audience', 'au-2026-09-15-0a1b2c.jsonl'),
          'utf8',
        );
        const lines = log.trimEnd().split('\n');
        expect(lines).toHaveLength(4);
        const events = lines.map((line) => JSON.parse(line));
        expect(events.map((event) => event.kind)).toEqual([
          'draft',
          'reaction',
          'reaction',
          'reaction',
        ]);
        expect(events[0].data).toEqual({
          path: 'announcement.md',
          sha256: payload.envelope.output.draft.sha256,
        });
        expect(events[1].data).toMatchObject({ persona: 'ops-manager', status: 'ok' });
        const shown = Bun.spawnSync({
          cmd: ['git', 'show', '--name-only', '--format=%s', 'HEAD'],
          cwd: root,
          env: { ...process.env, ...gitIdentity(root) },
        });
        expect(shown.stdout.toString()).toContain('audience: record au-2026-09-15-0a1b2c');
        expect(shown.stdout.toString()).toContain(
          'general/modes/audience/au-2026-09-15-0a1b2c.jsonl',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  test('a missing voice exits 4, is skipped under never-metered and is named in degraded', async () => {
    await withDraft(async (directory) => {
      const harness = await fixture(directory, ['xai']);
      const result = await runCliFacade(
        [
          'audience',
          '--personas',
          PERSONAS,
          '--draft',
          'announcement.md',
          '--providers',
          'anthropic,openai,xai',
          '--caller',
          'human',
          '--harness',
          'test',
        ],
        harness.environment,
      );
      expect(result.exitCode).toBe(4);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('degraded');
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.seats[2]).toMatchObject({
        family: 'xai',
        status: 'skipped',
        transport: null,
      });
      expect(envelope.seats[2]?.reason).toContain('never-metered');
      expect(envelope.degraded).toContain('missing-voices');
      expect(envelope.output.tallies).toMatchObject({ answered: 2 });
      expect(envelope.output.personas).toHaveLength(3);
    });
  });

  test('a draft carrying a high-confidence secret exits 3 before any seat is invoked', async () => {
    const secret = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      'cHJpdmF0ZS1rZXktbWF0ZXJpYWw=',
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    await withDraft(async (directory) => {
      const harness = await fixture(directory);
      const result = await runCliFacade(
        ['audience', '--personas', PERSONAS, '--draft', 'announcement.md'],
        harness.environment,
      );
      expect(result.exitCode).toBe(3);
      const payload = JSON.parse(result.stderr);
      expect(payload).toMatchObject({
        command: 'audience',
        mode: 'audience',
        status: 'blocked-policy',
      });
      expect(payload.message).toContain('announcement.md');
      expect(result.stderr).not.toContain('cHJpdmF0ZS1rZXktbWF0ZXJpYWw=');
      expect(harness.calls()).toBe(0);
    }, `# Deploy notes\n\nkey = "${secret}"\n`);
  });

  test('usage mistakes exit 2 before any seat is invoked', async () => {
    await withDraft(async (directory) => {
      const harness = await fixture(directory);
      const cases: [string[], string][] = [
        [['audience', '--personas', PERSONAS], 'requires --draft'],
        [['audience', '--draft', 'announcement.md'], '--personas <list> or --personas-file'],
        [
          [
            'audience',
            '--personas',
            PERSONAS,
            '--personas-file',
            'readers.json',
            '--draft',
            'announcement.md',
          ],
          'not both',
        ],
        [['audience', '--personas', PERSONAS, '--draft', 'absent.md'], 'No draft found'],
        [['audience', '--personas', PERSONAS, '--draft', 'huge.md'], 'the limit is 262144 bytes'],
        [
          ['audience', '--personas', PERSONAS, '--draft', 'announcement.md', '--voices', '3'],
          'Unknown option',
        ],
        [
          [
            'audience',
            '--personas',
            PERSONAS,
            '--draft',
            'announcement.md',
            '--billing',
            'api-only',
          ],
          'never spends a metered key',
        ],
        [
          ['audience', '--personas', PERSONAS, '--draft', 'announcement.md', '--session', 'nope'],
          'session',
        ],
        [
          ['audience', 'extra', '--personas', PERSONAS, '--draft', 'announcement.md'],
          'options only',
        ],
      ];
      await writeFile(join(directory, 'huge.md'), 'x'.repeat(256 * 1024 + 1));
      for (const [argv, message] of cases) {
        const result = await runCliFacade(argv, harness.environment);
        expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 2]);
        expect(result.stderr).toContain(message);
      }
      expect(harness.calls()).toBe(0);
    });
  });

  test('--help describes the audience flags without running it', async () => {
    await withDraft(async (directory) => {
      const harness = await fixture(directory);
      const result = await runCliFacade(['audience', '--help'], harness.environment);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ command: 'audience', mode: 'audience', pattern: 'parallel' });
      expect(payload.spend).toEqual({ policy: 'never-metered' });
      expect(payload.flags.value).toEqual(['draft', 'personas', 'personas-file', 'question']);
      expect(payload.flags.boolean).toEqual([]);
      expect(payload.flags.common).toContain('session');
      expect(harness.calls()).toBe(0);
    });
  });

  test('the modes listing names audience as a registered handler mode', async () => {
    const payload = JSON.parse((await runCliFacade(['modes'])).stdout);
    expect(
      payload.modes.map((mode: { name: string; kind: string }) => [mode.name, mode.kind]),
    ).toEqual([
      ['committee', 'runner'],
      ['second-opinion', 'runner'],
      ['advisor', 'handler'],
      ['audience', 'handler'],
    ]);
    const audience = payload.modes.find((mode: { name: string }) => mode.name === 'audience');
    expect(audience).toMatchObject({ pattern: 'parallel', spend: { policy: 'never-metered' } });
    expect(audience.defaults).toBeUndefined();
  });
});
