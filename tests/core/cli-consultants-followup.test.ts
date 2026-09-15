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
  type ConsultantsFixture,
  type ConsultantsFixtureOptions,
} from './fixtures/consultants';

const registry = await loadModelRegistry();

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'convene-consult-followup-project-'));
  await Bun.write(join(root, 'src', 'auth.ts'), 'export const login = () => "todo";\n');
  await Bun.write(
    join(root, 'personas.json'),
    JSON.stringify([{ name: 'ux', description: 'Judge what the reader sees and can act on.' }]),
  );
  return root;
}

async function briefed(
  root: string,
  cwd: string,
  options: ConsultantsFixtureOptions = {},
): Promise<ConsultantsFixture> {
  const fixture = await consultantsFixture({ ...options, cwd, env: gitIdentity(root) });
  const result = await runCliFacade(
    [
      'consult',
      '--records-root',
      root,
      '--session',
      BRIEF_SESSION,
      '--lens',
      'security,ux',
      '--personas',
      join(cwd, 'personas.json'),
      '--context',
      'src',
      '--motion',
      'Is this login path safe to ship?',
      ...(options.spendCapArgument ?? []),
    ],
    fixture.environment,
  );
  if (result.exitCode !== 0 && result.exitCode !== 4) {
    throw new Error(`The brief fixture failed: ${result.stderr}`);
  }
  return fixture;
}

describe('consult: follow-up questions', () => {
  test('a follow-up goes to one named consultant and rebuilds the whole session', async () => {
    const root = await temporaryRepository('convene-consult-ask-');
    const cwd = await project();
    try {
      const fixture = await briefed(root, cwd);
      const before = fixture.calls();
      const result = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--ask',
          'security',
          'Does the fallback path leak the key in logs?',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('completed');
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      // One consultant, one seat, one call: there is no broadcast.
      expect(fixture.calls() - before).toBe(1);
      expect(envelope.seats).toHaveLength(1);
      expect(envelope.seats[0]).toMatchObject({
        id: `anthropic/${registry.anthropic.primary}#security`,
        lens: 'security',
        status: 'ok',
      });
      expect(envelope.rounds).toBe(1);
      expect(envelope.synthesis).toBeNull();
      expect(envelope.output.qa).toEqual([
        {
          to: 'security',
          question: 'Does the fallback path leak the key in logs?',
          answer: 'The security consultant answers the follow-up.',
        },
      ]);
      // The whole session comes back, not just this command's answer.
      expect(envelope.output.reports).toHaveLength(2);
      expect(envelope.output.conflicts).toHaveLength(1);
      expect(envelope.output.brief).toMatchObject({ context: ['src/auth.ts'] });
      const prompt = fixture.prompts().at(-1)?.prompt ?? '';
      expect(prompt).toContain('Your earlier report');
      expect(prompt).toContain('The security consultant reports.');
      expect(prompt).not.toContain('The ux consultant reports.');
      const log = await Bun.file(
        join(root, 'general', 'modes', 'consultants', `${BRIEF_SESSION}.jsonl`),
      ).text();
      const kinds = log
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).kind);
      expect(kinds).toEqual(['brief', 'report', 'report', 'conflicts', 'spend', 'qa', 'spend']);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('another consultant is visible only when the caller forwards it', async () => {
    const root = await temporaryRepository('convene-consult-forward-');
    const cwd = await project();
    try {
      const fixture = await briefed(root, cwd);
      const result = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--ask',
          'security',
          '--forward',
          'ux',
          'Given what ux says, what has to change?',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const prompt = fixture.prompts().at(-1)?.prompt ?? '';
      expect(prompt).toContain("forwarded the ux consultant's report");
      expect(prompt).toContain('The ux consultant reports.');
      expect(prompt).toContain('<untrusted-report>');
      const log = await Bun.file(
        join(root, 'general', 'modes', 'consultants', `${BRIEF_SESSION}.jsonl`),
      ).text();
      expect(log).toContain('"forwarded":["ux"]');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('an unknown lens, or a brief flag, fails before any consultant is asked', async () => {
    const root = await temporaryRepository('convene-consult-ask-usage-');
    const cwd = await project();
    try {
      const fixture = await briefed(root, cwd);
      const before = fixture.calls();
      const base = ['consult', '--records-root', root, '--session', BRIEF_SESSION];
      const cases: [string[], string][] = [
        [[...base, '--ask', 'bogus', 'a question'], 'Unknown lens: bogus'],
        [[...base, '--ask', 'security'], 'one quoted argument'],
        [[...base, '--ask', 'security', '--lens', 'ux', 'a question'], '--lens belongs to a brief'],
        [
          [...base, '--ask', 'security', '--motion', 'a question'],
          'positional argument, not --motion',
        ],
        [
          [...base, '--ask', 'security', '--forward', 'legal', 'a question'],
          'Cannot forward legal',
        ],
        [
          [
            'consult',
            '--records-root',
            root,
            '--session',
            'cs-2026-07-28-ffffff',
            '--ask',
            'security',
            'q',
          ],
          'Unknown consultants session',
        ],
      ];
      for (const [argv, message] of cases) {
        const result = await runCliFacade(argv, fixture.environment);
        expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 2]);
        expect(result.stderr).toContain(message);
      }
      expect(fixture.calls()).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('the cap covers the session: a follow-up past it is skipped, not billed', async () => {
    const root = await temporaryRepository('convene-consult-cap-');
    const cwd = await project();
    try {
      // Every seat's subscription leg fails `quota-exhausted` and falls back to a metered
      // secondary through `withCredentialFallback` — the shape that actually reserves from the
      // session's ledger. Two report seats spend the cap of two; the synthesiser's own fallback
      // attempt is refused before it ever reaches the metered adapter.
      const fixture = await consultantsFixture({
        fallback: true,
        cwd,
        env: gitIdentity(root),
      });
      const briefResult = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--lens',
          'security,ux',
          '--personas',
          join(cwd, 'personas.json'),
          '--context',
          'src',
          '--motion',
          'Is this login path safe to ship?',
          '--spend-cap',
          '2',
        ],
        fixture.environment,
      );
      expect(briefResult.exitCode).toBe(4);
      const briefPayload = JSON.parse(briefResult.stdout);
      const briefEnvelope = ResultEnvelopeSchema.parse(briefPayload.envelope);
      expect(briefEnvelope.spend).toMatchObject({
        cap: 2,
        used: 2,
        refused: 1,
        stoppedAtCap: true,
      });
      expect(fixture.subscriptionCalls()).toBe(3);
      expect(fixture.meteredCalls()).toBe(2);

      const subscriptionBefore = fixture.subscriptionCalls();
      const meteredBefore = fixture.meteredCalls();
      const result = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--ask',
          'security',
          'One more question, please.',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(4);
      const payload = JSON.parse(result.stdout);
      expect(payload.status).toBe('degraded');
      expect(payload.spendWarning).toContain('spend cap of 2');
      const envelope = ResultEnvelopeSchema.parse(payload.envelope);
      expect(envelope.seats).toHaveLength(1);
      expect(envelope.seats[0]).toMatchObject({ lens: 'security', status: 'skipped' });
      expect(envelope.seats[0]?.reason).toContain('spend-cap');
      expect(envelope.spend).toMatchObject({ cap: 2, used: 2, stoppedAtCap: true });
      expect(envelope.degraded).toContainEqual('spend-cap-reached');
      expect(envelope.output.qa).toEqual([]);
      // No consultant was invoked, and the refusal is on the record.
      expect(fixture.subscriptionCalls()).toBe(subscriptionBefore);
      expect(fixture.meteredCalls()).toBe(meteredBefore);
      const log = await Bun.file(
        join(root, 'general', 'modes', 'consultants', `${BRIEF_SESSION}.jsonl`),
      ).text();
      expect(log.trimEnd().split('\n').at(-1)).toContain('"command":"ask"');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('--spend-cap on a follow-up raises the session cap rather than replacing it', async () => {
    const root = await temporaryRepository('convene-consult-cap-raise-');
    const cwd = await project();
    try {
      const fixture = await consultantsFixture({
        fallback: true,
        cwd,
        env: gitIdentity(root),
      });
      const briefResult = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--lens',
          'security,ux',
          '--personas',
          join(cwd, 'personas.json'),
          '--context',
          'src',
          '--motion',
          'Is this login path safe to ship?',
          '--spend-cap',
          '2',
        ],
        fixture.environment,
      );
      expect(briefResult.exitCode).toBe(4);
      const briefEnvelope = ResultEnvelopeSchema.parse(JSON.parse(briefResult.stdout).envelope);
      expect(briefEnvelope.spend).toMatchObject({ cap: 2, used: 2, refused: 1 });

      const subscriptionBefore = fixture.subscriptionCalls();
      const meteredBefore = fixture.meteredCalls();
      const result = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--spend-cap',
          '6',
          '--ask',
          'security',
          'One more question, please.',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(0);
      const envelope = ResultEnvelopeSchema.parse(JSON.parse(result.stdout).envelope);
      // The session was already at cap 2 with 2 spent; raising it to 6 leaves one more fallback
      // reservation for this run, spending 3 in total, and refuses nothing.
      expect(envelope.spend).toMatchObject({ cap: 6, used: 3, stoppedAtCap: false });
      expect(fixture.subscriptionCalls() - subscriptionBefore).toBe(1);
      expect(fixture.meteredCalls() - meteredBefore).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a follow-up may not lower the session cap', async () => {
    const root = await temporaryRepository('convene-consult-cap-lower-');
    const cwd = await project();
    try {
      const fixture = await briefed(root, cwd, { spendCapArgument: ['--spend-cap', '4'] });
      const result = await runCliFacade(
        [
          'consult',
          '--records-root',
          root,
          '--session',
          BRIEF_SESSION,
          '--spend-cap',
          '1',
          '--ask',
          'security',
          'One more question, please.',
        ],
        fixture.environment,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('may raise the session cap, not lower it');
      expect(result.stderr).toContain('capped at 4');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
