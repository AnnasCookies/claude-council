import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import {
  ProviderFamilySchema,
  ResultEnvelopeSchema,
  loadModelRegistry,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
} from '../../src/substrate';

const NOW = '2026-09-15T12:00:00.000Z';

/**
 * Each seat answers with the same verdict by default, so a batch of agreeing items is the common
 * case; a test that wants a disagreement swaps one family's reply in on top of this.
 */
function fixtureAnswer(request: ProviderRequest): string {
  void request;
  return JSON.stringify({
    class: 'bug',
    severity: 'high',
    route: 'fix',
    confidence: 0.7,
    reason: 'It dereferences a null pointer.',
  });
}

async function fixtureEnvironment(
  answers: Partial<Record<ProviderFamily, (request: ProviderRequest) => string>> = {},
): Promise<{
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
          const answer = (answers[provider] ?? fixtureAnswer)(request);
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
            answer,
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
    environment: { registry, adapters, cwd: tmpdir(), env: {}, now: () => NOW },
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

async function batchFile(root: string, raw: string): Promise<string> {
  const path = join(root, 'comments.json');
  await writeFile(path, raw, 'utf8');
  return path;
}

const BATCH = JSON.stringify([
  { id: 'c1', text: 'This dereferences a null pointer.' },
  { id: 'c2', text: 'This also dereferences a null pointer.' },
]);

/** A records root as a git repository, so the mode's own commit succeeds. */
async function recordsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'convene-cli-triage-'));
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0);
  return root;
}

describe('the triage subcommand', () => {
  test('sorts a batch end to end, agrees, and commits the routed batch', async () => {
    const root = await recordsRoot();
    try {
      const fixture = await fixtureEnvironment();
      const registry = await loadModelRegistry();
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: { ...gitIdentity(root), COUNCIL_MINUTES_DIR: join(root, 'minutes') },
      };
      const result = await runCliFacade(
        [
          'triage',
          '--records-root',
          root,
          '--session',
          'tr-2026-09-15-0a1b2c',
          '--schema',
          'pr-comment',
          '--in',
          await batchFile(root, BATCH),
          '--seats',
          '2',
          '--caller',
          'agent',
          '--harness',
          'claude-code',
        ],
        environment,
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ command: 'triage', mode: 'triage', status: 'completed' });
      expect(payload.session).toBe('tr-2026-09-15-0a1b2c');
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.mode).toBe('triage');
      expect(envelope.pattern).toBe('parallel');
      expect(envelope.rounds).toBe(1);
      expect(envelope.unanimous).toBe(false);
      expect(envelope.degraded).toEqual([]);
      const anthropicSeat = `anthropic/${registry.anthropic.primary}#triage`;
      const openaiSeat = `openai/${registry.openai.primary}#triage`;
      expect(envelope.seats.map((seat) => seat.id)).toEqual([anthropicSeat, openaiSeat]);
      const verdict = (seat: string) => ({
        seat,
        class: 'bug',
        severity: 'high',
        route: 'fix',
        confidence: 0.7,
        reason: 'It dereferences a null pointer.',
      });
      expect(envelope.output).toEqual({
        schema: 'pr-comment',
        items: [
          {
            id: 'c1',
            verdicts: [verdict(anthropicSeat), verdict(openaiSeat)],
            agreed: true,
            route: 'fix',
          },
          {
            id: 'c2',
            verdicts: [verdict(anthropicSeat), verdict(openaiSeat)],
            agreed: true,
            route: 'fix',
          },
        ],
        unprocessed: [],
      });
      expect(envelope.spend).toMatchObject({
        billing: 'sub-only',
        policy: 'never-metered',
        cap: 0,
        used: 0,
      });
      expect(fixture.calls()).toBe(4);

      // Records are written and committed when a records root is configured, and the stdout
      // envelope carries the log path a caller would read.
      expect(envelope.record.session).toBe('general/modes/triage/tr-2026-09-15-0a1b2c.jsonl');
      expect(envelope.record.committed).toBe(true);
      expect(envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
      const minutesPath = envelope.record.minutes;
      if (minutesPath === null || minutesPath === undefined) {
        throw new Error('minutes path was not returned');
      }
      expect(await Bun.file(minutesPath).text()).toContain('# Minutes: triage');
      const log = await Bun.file(
        join(root, 'general', 'modes', 'triage', 'tr-2026-09-15-0a1b2c.jsonl'),
      ).text();
      const lines = log.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({
        at: NOW,
        kind: 'item',
        data: { schema: 'pr-comment', id: 'c1', status: 'routed', route: 'fix' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a disagreement between the two seats is routed to human, not averaged', async () => {
    const root = await recordsRoot();
    try {
      const fixture = await fixtureEnvironment({
        openai: () =>
          JSON.stringify({
            class: 'question',
            severity: 'low',
            route: 'discuss',
            confidence: 0.4,
            reason: 'This reads as a question, not a bug.',
          }),
      });
      const environment: CliFacadeEnvironment = {
        ...fixture.environment,
        env: { ...gitIdentity(root), COUNCIL_MINUTES_DIR: join(root, 'minutes') },
      };
      const result = await runCliFacade(
        [
          'triage',
          '--records-root',
          root,
          '--in',
          await batchFile(root, JSON.stringify([{ id: 'c1', text: 'Is this intentional?' }])),
          '--seats',
          '2',
          '--caller',
          'agent',
          '--harness',
          'claude-code',
        ],
        environment,
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('completed');
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.output.items).toHaveLength(1);
      const [item] = envelope.output.items as [{ agreed: boolean; route: string }];
      expect(item.agreed).toBe(false);
      expect(item.route).toBe('human');
      // A disagreement is surfaced as dissent too, so the minutes show who held what.
      expect(envelope.dissent).not.toBeNull();
      expect(envelope.dissent?.length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('no records root leaves the batch routed but degraded, and exits 4', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-cli-triage-degraded-'));
    try {
      const fixture = await fixtureEnvironment();
      const result = await runCliFacade(
        ['triage', '--in', await batchFile(root, BATCH), '--seats', '2'],
        fixture.environment,
      );
      expect(result.exitCode).toBe(4);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('degraded');
      expect(payload.envelope.degraded).toContain(
        'records-not-kept: no records root is configured',
      );
      expect(payload.envelope.record).toEqual({ session: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a malformed batch is invalid usage, before any seat is invoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-cli-triage-bad-'));
    try {
      const fixture = await fixtureEnvironment();
      const result = await runCliFacade(
        ['triage', '--in', await batchFile(root, '[{"id":"c1"}]')],
        fixture.environment,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Invalid triage batch');
      expect(result.stderr).toContain('comments.json');

      const missing = await runCliFacade(
        ['triage', '--in', join(root, 'absent.json')],
        fixture.environment,
      );
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain('Triage batch file not found');
      expect(fixture.calls()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a bad --concurrency is invalid usage, before any seat is invoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-cli-triage-concurrency-'));
    try {
      const fixture = await fixtureEnvironment();
      const result = await runCliFacade(
        ['triage', '--in', await batchFile(root, BATCH), '--concurrency', '0'],
        fixture.environment,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--concurrency');
      expect(fixture.calls()).toBe(0);

      const tooHigh = await runCliFacade(
        ['triage', '--in', await batchFile(root, BATCH), '--concurrency', '9'],
        fixture.environment,
      );
      expect(tooHigh.exitCode).toBe(2);
      expect(tooHigh.stderr).toContain('--concurrency');
      expect(fixture.calls()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('never spends a metered key, whatever the caller asks for', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-cli-triage-billing-'));
    try {
      const fixture = await fixtureEnvironment();
      const result = await runCliFacade(
        ['triage', '--in', await batchFile(root, BATCH), '--billing', 'api-only'],
        fixture.environment,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('never spends a metered key');
      expect(fixture.calls()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--help describes the desk and its own flags without running it', async () => {
    const fixture = await fixtureEnvironment();
    const result = await runCliFacade(['triage', '--help'], fixture.environment);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: 'triage',
      mode: 'triage',
      pattern: 'parallel',
      spend: { policy: 'never-metered' },
    });
    expect(payload.flags.value).toEqual(['in', 'schema', 'schema-file', 'seats', 'concurrency']);
    expect(payload.flags.boolean).toEqual([]);
    expect(fixture.calls()).toBe(0);
  });

  test('the modes listing reports triage as a registered handler mode', async () => {
    const payload = JSON.parse((await runCliFacade(['modes'])).stdout);
    const triageEntry = payload.modes.find((mode: { name: string }) => mode.name === 'triage') as {
      pattern: string;
      spend: { policy: string };
      knobs: { tempo: string };
      kind: string;
    };
    expect(triageEntry).toMatchObject({
      kind: 'handler',
      pattern: 'parallel',
      spend: { policy: 'never-metered' },
      knobs: { tempo: 'fast, batch' },
    });
  });
});
