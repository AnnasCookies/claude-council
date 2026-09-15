import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliFacade } from '../../src/cli';
import { ResultEnvelopeSchema, loadModelRegistry } from '../../src/substrate';
import {
  BRIEF_SESSION,
  consultantsFixture,
  gitIdentity,
  temporaryRepository,
} from './fixtures/consultants';

const registry = await loadModelRegistry();

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'convene-consult-project-'));
  await Bun.write(join(root, 'src', 'auth.ts'), 'export const login = () => "todo";\n');
  await Bun.write(join(root, 'docs', 'vision.md'), '# Vision\n\nOne substrate, many forms.\n');
  await Bun.write(
    join(root, 'personas.json'),
    JSON.stringify([{ name: 'ux', description: 'Judge what the reader sees and can act on.' }]),
  );
  return root;
}

function briefArguments(root: string, cwd: string): string[] {
  return [
    'consult',
    '--records-root',
    root,
    '--session',
    BRIEF_SESSION,
    '--lens',
    'security,ux',
    '--lens',
    'maintainer',
    '--personas',
    join(cwd, 'personas.json'),
    '--context',
    'src',
    '--context',
    'docs/vision.md',
    '--caller',
    'human',
    '--harness',
    'claude-code',
    '--motion',
    'Is this login path safe to ship?',
  ];
}

describe('consult: the brief', () => {
  test('seats one consultant per lens, lists conflicts and records the session', async () => {
    const root = await temporaryRepository('convene-consult-brief-');
    const cwd = await project();
    try {
      const fixture = await consultantsFixture({ cwd, env: gitIdentity(root) });
      const result = await runCliFacade(briefArguments(root, cwd), fixture.environment);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        command: 'consult',
        mode: 'consultants',
        status: 'completed',
        session: BRIEF_SESSION,
      });
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.pattern).toBe('parallel');
      expect(envelope.rounds).toBe(2);
      expect(envelope.seats.map((seat) => [seat.lens, seat.family, seat.status])).toEqual([
        ['security', 'anthropic', 'ok'],
        ['ux', 'openai', 'ok'],
        ['maintainer', 'xai', 'ok'],
        ['synthesiser', 'anthropic', 'ok'],
      ]);
      // Every report names its lens and its seat.
      expect(envelope.output.reports).toEqual([
        {
          lens: 'security',
          seat: `anthropic/${registry.anthropic.primary}#security`,
          report: 'The security consultant reports.',
        },
        {
          lens: 'ux',
          seat: `openai/${registry.openai.primary}#ux`,
          report: 'The ux consultant reports.',
        },
        {
          lens: 'maintainer',
          seat: `xai/${registry.xai.primary}#maintainer`,
          report: 'The maintainer consultant reports.',
        },
      ]);
      expect(envelope.output.brief).toEqual({
        question: 'Is this login path safe to ship?',
        context: ['src/auth.ts', 'docs/vision.md'],
      });
      expect(envelope.output.qa).toEqual([]);
      // Conflicts are listed, attributed to a named synthesiser seat, and never resolved.
      expect(envelope.synthesis?.by).toBe(`anthropic/${registry.anthropic.primary}#synthesiser`);
      expect(JSON.parse(envelope.synthesis?.text ?? 'null')).toEqual(envelope.output.conflicts);
      expect(envelope.output.conflicts).toEqual([
        {
          between: ['security', 'ux'],
          about: 'how much the failure screen may say',
          positions: [
            { lens: 'security', holds: 'the detail leaks the key' },
            { lens: 'ux', holds: 'the reader cannot act without it' },
          ],
        },
      ]);
      expect(envelope.dissent).toBeNull();
      expect(envelope.unanimous).toBe(false);
      expect(envelope.degraded).toEqual([]);
      expect(envelope.spend).toMatchObject({
        billing: 'sub-first',
        policy: 'capped',
        cap: 6,
        used: 0,
        stoppedAtCap: false,
      });
      expect(envelope.record.session).toBe(`general/modes/consultants/${BRIEF_SESSION}.jsonl`);
      expect(envelope.record.committed).toBe(true);

      const log = await Bun.file(
        join(root, 'general', 'modes', 'consultants', `${BRIEF_SESSION}.jsonl`),
      ).text();
      const lines = log
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines.map((line) => line.kind)).toEqual([
        'brief',
        'report',
        'report',
        'report',
        'conflicts',
        'spend',
      ]);
      expect(lines[0]?.data.context.map((entry: { locator: string }) => entry.locator)).toEqual([
        'src/auth.ts',
        'docs/vision.md',
      ]);
      expect(lines[5]?.data).toEqual({
        command: 'brief',
        cap: 6,
        used: 0,
        reserved: 0,
        fallbacks: 0,
        refused: 0,
      });
      expect(fixture.calls()).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('no consultant sees another consultant in the report round', async () => {
    const root = await temporaryRepository('convene-consult-blind-');
    const cwd = await project();
    try {
      const fixture = await consultantsFixture({ cwd, env: gitIdentity(root) });
      expect((await runCliFacade(briefArguments(root, cwd), fixture.environment)).exitCode).toBe(0);
      const reportPrompts = fixture.prompts().filter((entry) => entry.role !== 'synthesiser');
      expect(reportPrompts).toHaveLength(3);
      for (const entry of reportPrompts) {
        expect(entry.prompt).not.toContain('consultant reports.');
        expect(entry.prompt).not.toContain('<untrusted-report>');
        expect(entry.prompt).toContain('<untrusted-evidence ');
        expect(entry.prompt).toContain('locator="src/auth.ts"');
        expect(entry.prompt).toContain('Is this login path safe to ship?');
      }
      const synthesis = fixture.prompts().find((entry) => entry.role === 'synthesiser');
      expect(synthesis?.prompt).toContain('<untrusted-report>');
      expect(synthesis?.prompt).toContain('The security consultant reports.');
      expect(synthesis?.prompt).toContain('Never resolve a conflict');
      // The synthesiser reads reports; it is never given the repository material again.
      expect(synthesis?.prompt).not.toContain('<untrusted-evidence ');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a synthesiser that recommends a resolution is invalid, and nothing is resolved', async () => {
    const root = await temporaryRepository('convene-consult-resolution-');
    const cwd = await project();
    try {
      const fixture = await consultantsFixture({
        cwd,
        env: gitIdentity(root),
        conflicts: {
          conflicts: [
            {
              between: ['security', 'ux'],
              about: 'the failure screen',
              positions: [],
              resolution: 'security wins',
            },
          ],
        },
      });
      const result = await runCliFacade(briefArguments(root, cwd), fixture.environment);
      expect(result.exitCode).toBe(4);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('degraded');
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.seats[3]).toMatchObject({ lens: 'synthesiser', status: 'invalid' });
      expect(envelope.synthesis).toBeNull();
      expect(envelope.output.conflicts).toEqual([]);
      expect(envelope.degraded).toContainEqual(expect.stringContaining('conflicts-unavailable'));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a consultant that cannot answer degrades the brief and stays on the record', async () => {
    const root = await temporaryRepository('convene-consult-missing-');
    const cwd = await project();
    try {
      const fixture = await consultantsFixture({
        cwd,
        env: gitIdentity(root),
        failing: ['xai'],
      });
      const result = await runCliFacade(briefArguments(root, cwd), fixture.environment);
      expect(result.exitCode).toBe(4);
      const payload = JSON.parse(result.stdout);
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.seats[2]).toMatchObject({ lens: 'maintainer', status: 'failed' });
      expect(envelope.degraded).toContainEqual('report-missing: maintainer (quota-exhausted)');
      expect(envelope.output.reports).toHaveLength(2);
      const log = await Bun.file(
        join(root, 'general', 'modes', 'consultants', `${BRIEF_SESSION}.jsonl`),
      ).text();
      expect(log).toContain('"status":"failed"');
      expect(log).toContain('"lens":"maintainer"');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a secret in the context blocks the brief before any consultant is briefed', async () => {
    const root = await temporaryRepository('convene-consult-secret-');
    const cwd = await project();
    try {
      // No comment prefix: the outbound scanner's provider-assignment pattern anchors on the
      // start of a line, so the leak must sit there to be a high-confidence detection at all.
      const leak = ['ANTHROPIC_API_KEY', 'not-a-real-value-0001'].join('=');
      await Bun.write(join(cwd, 'src', 'env.ts'), `${leak}\n`);
      const fixture = await consultantsFixture({ cwd, env: gitIdentity(root) });
      const result = await runCliFacade(briefArguments(root, cwd), fixture.environment);
      expect(result.exitCode).toBe(3);
      const error = JSON.parse(result.stderr);
      expect(error.status).toBe('blocked-policy');
      expect(error.message).toContain('outbound policy');
      expect(fixture.calls()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('refuses its usage mistakes before any consultant is briefed', async () => {
    const root = await temporaryRepository('convene-consult-usage-');
    const cwd = await project();
    try {
      const fixture = await consultantsFixture({ cwd, env: gitIdentity(root) });
      const base = ['consult', '--records-root', root];
      const cases: [string[], string][] = [
        [[...base, '--lens', 'data-model', '--motion', 'm'], 'Unknown lens: data-model'],
        [[...base, '--motion', 'm'], 'at least one --lens'],
        [[...base, '--lens', 'security'], 'brief question in --motion'],
        [[...base, '--lens', 'security', '--motion', 'm', '--forward', 'ux'], '--forward belongs'],
        [
          [...base, '--lens', 'security', '--motion', 'm', '--context', 'nowhere'],
          '--context path not found',
        ],
        [['consult', '--lens', 'security', '--motion', 'm'], 'needs a records root'],
      ];
      for (const [argv, message] of cases) {
        const result = await runCliFacade(argv, fixture.environment);
        expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 2]);
        expect(result.stderr).toContain(message);
      }
      expect(fixture.calls()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('--help describes the consult flag surface without running anything', async () => {
    const fixture = await consultantsFixture();
    const result = await runCliFacade(['consult', '--help'], fixture.environment);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ command: 'consult', mode: 'consultants', pattern: 'parallel' });
    expect(payload.flags.value).toEqual(['ask', 'context', 'forward', 'lens', 'personas']);
    expect(payload.flags.boolean).toEqual([]);
    expect(payload.flags.common).toContain('session');
    expect(fixture.calls()).toBe(0);
  });
});
