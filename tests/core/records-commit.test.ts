import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitRecordFiles, type CommandRunner } from '../../src/substrate/records/commit';

const identity = {
  GIT_AUTHOR_NAME: 'Council Test',
  GIT_AUTHOR_EMAIL: 'council-test@example.invalid',
  GIT_COMMITTER_NAME: 'Council Test',
  GIT_COMMITTER_EMAIL: 'council-test@example.invalid',
};

const runner: CommandRunner = async (argv, cwd) => {
  const child = Bun.spawn({
    cmd: [...argv],
    cwd,
    env: { ...process.env, ...identity },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

async function withTempDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-commit-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('record commits', () => {
  test('commits only the named record files in a Git work tree and reports the sha', async () => {
    await withTempDirectory(async (root) => {
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      await mkdir(join(root, 'general', 'sessions'), { recursive: true });
      await writeFile(join(root, 'general', 'sessions', 'run-1.json'), '{}\n');
      await writeFile(join(root, 'general', 'sessions', 'run-1.md'), '# run-1\n');
      await writeFile(join(root, 'unrelated.txt'), 'not part of the record\n');

      const outcome = await commitRecordFiles({
        root,
        paths: [
          join(root, 'general', 'sessions', 'run-1.json'),
          join(root, 'general', 'sessions', 'run-1.md'),
        ],
        message: 'council: record run-1',
        run: runner,
      });
      expect(outcome.committed).toBe(true);
      if (!outcome.committed) throw new Error('unreachable');
      expect(outcome.sha).toMatch(/^[a-f0-9]{40}$/);

      const shown = await runner(['git', 'show', '--name-only', '--format=%s', 'HEAD'], root);
      expect(shown.stdout).toContain('council: record run-1');
      expect(shown.stdout).toContain('general/sessions/run-1.json');
      expect(shown.stdout).not.toContain('unrelated.txt');
      const status = await runner(['git', 'status', '--porcelain'], root);
      expect(status.stdout).toContain('unrelated.txt');
    });
  });

  test('reports not committed when the root is not a Git work tree', async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, 'record.json'), '{}\n');
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'record.json')],
        message: 'council: record x',
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason).toContain('not inside a Git work tree');
    });
  });

  test('refuses to commit into the kernel repository itself', async () => {
    await withTempDirectory(async (root) => {
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      await writeFile(join(root, 'record.json'), '{}\n');
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'record.json')],
        message: 'council: record x',
        forbiddenRoot: root,
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason).toContain('kernel repository');
    });
  });

  test('reports a failed git command without throwing', async () => {
    await withTempDirectory(async (root) => {
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'missing.json')],
        message: 'council: record x',
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason.length).toBeGreaterThan(0);
    });
  });
});
