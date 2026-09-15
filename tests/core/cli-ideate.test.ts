import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import { IdeationOutputSchema } from '../../src/modes/ideation/session';
import {
  ProviderFamilySchema,
  ResultEnvelopeSchema,
  loadModelRegistry,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
} from '../../src/substrate';

const NOW = '2026-09-15T10:00:00.000Z';
const SESSION = 'id-2026-09-15-0a1b2c';

async function fixtureEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Promise<{ environment: CliFacadeEnvironment; calls: () => ProviderRequest[] }> {
  const registry = await loadModelRegistry();
  const calls: ProviderRequest[] = [];
  const cheap = (family: ProviderFamily) =>
    registry[family].fallbacks[0] ?? registry[family].primary;
  const adapters = Object.fromEntries(
    ProviderFamilySchema.options.map((family) => [
      family,
      {
        family,
        transport: registry[family].transport,
        async availability() {
          return {
            status: 'available' as const,
            provider: family,
            model: cheap(family),
            reason: '',
          };
        },
        async invoke(request: ProviderRequest) {
          calls.push(request);
          return {
            status: 'ok' as const,
            seatId: request.seatId,
            provider: family,
            requestedModel: cheap(family),
            actualModel: cheap(family),
            modelIdentity: 'verified' as const,
            route: 'primary' as const,
            role: request.role,
            latencyMs: 1,
            credentialPath: 'subscription' as const,
            answer: JSON.stringify({
              ideas: [{ text: `${request.role} one` }, { text: 'shared idea about notes' }],
            }),
          };
        },
        async probe() {
          return {
            status: 'healthy' as const,
            provider: family,
            requestedModel: cheap(family),
            actualModel: cheap(family),
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
      env: { ...extra },
      now: () => NOW,
    },
    calls: () => calls,
  };
}

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

async function gitRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'council-ideate-'));
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0);
  return root;
}

describe('convene ideate', () => {
  test('runs a first pass, commits the session log and renders minutes', async () => {
    const root = await gitRoot();
    try {
      const registry = await loadModelRegistry();
      const fixture = await fixtureEnvironment({
        ...gitIdentity(root),
        COUNCIL_MINUTES_DIR: join(root, 'minutes'),
      });
      const result = await runCliFacade(
        [
          'ideate',
          '--records-root',
          root,
          '--session',
          SESSION,
          '--providers',
          'anthropic,xai',
          '--seats',
          '2',
          '--ideas-per-seat',
          '2',
          '--caller',
          'human',
          '--harness',
          'claude-code',
          '--motion',
          'Ways to make advisor notes visible without interrupting flow',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        command: 'ideate',
        mode: 'ideation',
        status: 'completed',
        session: SESSION,
      });

      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.mode).toBe('ideation');
      expect(envelope.pattern).toBe('parallel');
      expect(envelope.rounds).toBe(1);
      expect(envelope.synthesis).toBeNull();
      expect(envelope.dissent).toBeNull();
      expect(envelope.unanimous).toBe(false);
      expect(envelope.degraded).toEqual([]);
      // Cheap seats: xai has a registered fallback and takes it, anthropic lists none and stays.
      expect(envelope.seats.map((seat) => seat.id)).toEqual([
        `anthropic/${registry.anthropic.primary}#strategist`,
        `xai/${registry.xai.fallbacks[0]}#architect`,
      ]);
      const xaiCheap = registry.xai.fallbacks[0] ?? registry.xai.primary;
      expect(envelope.seats.map((seat) => seat.model.requested)).toEqual([
        registry.anthropic.primary,
        xaiCheap,
      ]);
      // Drift from the brief: a capped mode's ledger is sized from every eligible family (the CLI's
      // widest roster, six by default with no project policy narrowing it), not the two families
      // this run selected — see the spend comment above `handlerModeCommand`'s ledger construction
      // in src/cli.ts.
      expect(envelope.spend).toMatchObject({
        billing: 'sub-first',
        policy: 'capped',
        cap: ProviderFamilySchema.options.length,
      });

      expect(envelope.output.raw).toEqual(['i-1', 'i-2', 'i-3', 'i-4']);
      expect(envelope.output.clusters).toEqual([
        { id: 'k-1', label: 'strategist one', ideaIds: ['i-1'] },
        { id: 'k-2', label: 'shared idea notes', ideaIds: ['i-2', 'i-4'] },
        { id: 'k-3', label: 'architect one', ideaIds: ['i-3'] },
      ]);

      expect(envelope.record.session).toBe(`general/modes/ideation/${SESSION}.jsonl`);
      expect(envelope.record.committed).toBe(true);
      expect(envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(await Bun.file(String(envelope.record.minutes)).text()).toContain(
        `# Minutes: ideation ${SESSION}`,
      );
      const shown = Bun.spawnSync({
        cmd: ['git', 'show', '--name-only', '--format=%s', 'HEAD'],
        cwd: root,
        env: { ...process.env, ...gitIdentity(root) },
      });
      expect(shown.stdout.toString()).toContain(`ideate: record ${SESSION}`);
      expect(shown.stdout.toString()).toContain(`general/modes/ideation/${SESSION}.jsonl`);
      expect(fixture.calls()).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an expansion pass continues the session and returns both passes', async () => {
    const root = await gitRoot();
    try {
      const first = await fixtureEnvironment(gitIdentity(root));
      const common = ['--records-root', root, '--session', SESSION, '--providers', 'anthropic,xai'];
      expect(
        (
          await runCliFacade(
            [
              ...['ideate'],
              ...common,
              '--seats',
              '2',
              '--ideas-per-seat',
              '2',
              '--motion',
              'Ways in',
            ],
            first.environment,
          )
        ).exitCode,
      ).toBe(0);

      const second = await fixtureEnvironment(gitIdentity(root));
      const result = await runCliFacade(
        ['ideate', ...common, '--seats', '2', '--ideas-per-seat', '1', '--expand', 'k-2'],
        second.environment,
      );
      expect(result.exitCode).toBe(0);
      const envelope = ResultEnvelopeSchema.parse(JSON.parse(result.stdout).envelope);
      const output = IdeationOutputSchema.parse(envelope.output);
      expect(output.passes).toHaveLength(2);
      expect(output.passes[1]).toMatchObject({ n: 2, scope: ['k-2'] });
      expect(output.raw).toHaveLength(6);
      // The expanded cluster's ideas reached the seats as bounded data; nothing else did.
      for (const request of second.calls()) {
        expect(request.prompt).toContain('k-2: shared idea about notes');
        expect(request.prompt).not.toContain('strategist one');
      }
      const lines = (
        await Bun.file(join(root, 'general', 'modes', 'ideation', `${SESSION}.jsonl`)).text()
      )
        .trimEnd()
        .split('\n');
      expect(lines).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an unknown cluster id is a usage error and costs nothing', async () => {
    const root = await gitRoot();
    try {
      const seed = await fixtureEnvironment(gitIdentity(root));
      await runCliFacade(
        [
          'ideate',
          '--records-root',
          root,
          '--session',
          SESSION,
          '--providers',
          'anthropic',
          '--seats',
          '1',
          '--motion',
          'Ways in',
        ],
        seed.environment,
      );
      const fixture = await fixtureEnvironment(gitIdentity(root));
      const result = await runCliFacade(
        [
          'ideate',
          '--records-root',
          root,
          '--session',
          SESSION,
          '--providers',
          'anthropic',
          '--seats',
          '1',
          '--expand',
          'k-1,k-9',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Unknown cluster id: k-9');
      expect(result.stderr).toContain('k-1, k-2');
      expect(fixture.calls()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses the usage mistakes this mode can make, before any seat is invoked', async () => {
    const root = await gitRoot();
    try {
      const personas = join(root, 'personas.json');
      await writeFile(
        personas,
        JSON.stringify([{ name: 'Ops manager', description: 'Carries the pager.' }]),
      );
      const fixture = await fixtureEnvironment(gitIdentity(root));
      const base = ['ideate', '--records-root', root, '--providers', 'anthropic'];
      const cases: [string[], string][] = [
        [
          [...base, '--lenses', 'security', '--personas', personas, '--motion', 'm'],
          'cannot be combined',
        ],
        [[...base, '--lenses', 'vibes', '--motion', 'm'], 'Unknown lens: vibes'],
        [[...base, '--seats', '0', '--motion', 'm'], '--seats must be an integer from 1 to 24'],
        [
          [...base, '--seats', '2', '--lenses', 'security,operator,critic', '--motion', 'm'],
          'fewer than the 3 lenses named',
        ],
        [
          [...base, '--ideas-per-seat', '99', '--motion', 'm'],
          '--ideas-per-seat must be an integer',
        ],
        [[...base, '--models', 'nobody=x', '--motion', 'm'], 'Invalid'],
        [[...base, '--expand', 'k-1', '--motion', 'm'], '--expand continues'],
        [['ideate', '--providers', 'anthropic', '--motion', 'm'], '--records-root'],
        [[...base, 'positional', '--motion', 'm'], 'options only'],
        [[...base, '--bogus', '1', '--motion', 'm'], 'Unknown option'],
        // `ideate` does not take its prompt on stdin, so a missing one must say which flag
        // to pass rather than describing a motion the caller never named.
        [[...base], 'pass a non-blank --motion'],
      ];
      for (const [argv, message] of cases) {
        const result = await runCliFacade(argv, fixture.environment);
        expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 2]);
        expect(result.stderr).toContain(message);
      }
      expect(fixture.calls()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--help describes the mode without running it, and modes lists it', async () => {
    const fixture = await fixtureEnvironment();
    const help = JSON.parse((await runCliFacade(['ideate', '--help'], fixture.environment)).stdout);
    expect(help).toMatchObject({ command: 'ideate', mode: 'ideation', pattern: 'parallel' });
    expect(help.flags.value).toEqual([
      'seats',
      'lenses',
      'personas',
      'ideas-per-seat',
      'models',
      'expand',
    ]);
    expect(help.flags.boolean).toEqual([]);
    expect(help.flags.common).toContain('session');
    expect(help.spend).toEqual({ policy: 'capped' });

    const listed = JSON.parse((await runCliFacade(['modes'], fixture.environment)).stdout);
    expect(
      listed.modes.map((mode: { name: string; kind: string }) => [mode.name, mode.kind]),
    ).toContainEqual(['ideation', 'handler']);
    expect(fixture.calls()).toHaveLength(0);
  });
});
