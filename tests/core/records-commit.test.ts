import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitRecordFiles, type CommandRunner } from '../../src/substrate/records/commit';

/**
 * `GIT_CONFIG_GLOBAL` points at a file that does not exist inside the temporary directory, so the
 * machine's own global configuration — hooks, templates, a `commit.gpgsign` — cannot reach these
 * repositories. `GIT_CONFIG_SYSTEM` is deliberately left alone.
 */
function identityFor(root: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: 'Council Test',
    GIT_AUTHOR_EMAIL: 'council-test@example.invalid',
    GIT_COMMITTER_NAME: 'Council Test',
    GIT_COMMITTER_EMAIL: 'council-test@example.invalid',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  };
}

function runnerFor(root: string): CommandRunner {
  return async (argv, cwd) => {
    const child = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: { ...process.env, ...identityFor(root) },
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
}

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
      const runner = runnerFor(root);
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      await mkdir(join(root, 'general', 'sessions'), { recursive: true });
      await writeFile(join(root, 'general', 'sessions', 'run-1.json'), '{}\n');
      await writeFile(join(root, 'general', 'sessions', 'run-1.md'), '# run-1\n');
      await writeFile(join(root, 'unrelated.txt'), 'not part of the record\n');
      // Already staged by whoever was working in the records repository. A records commit must
      // neither include it nor unstage it.
      expect((await runner(['git', 'add', '--', 'unrelated.txt'], root)).exitCode).toBe(0);

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
      expect(status.stdout).toContain('A  unrelated.txt');
    });
  });

  test('reports not committed when the root is not a Git work tree', async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, 'record.json'), '{}\n');
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'record.json')],
        message: 'council: record x',
        run: runnerFor(root),
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason).toContain('not inside a Git work tree');
    });
  });

  test('refuses to commit into the kernel repository itself', async () => {
    await withTempDirectory(async (root) => {
      const runner = runnerFor(root);
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
      const runner = runnerFor(root);
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

  test('reports a record path outside the work tree instead of throwing', async () => {
    await withTempDirectory(async (root) => {
      const inside = join(root, 'records');
      const outside = join(root, 'elsewhere');
      await mkdir(inside, { recursive: true });
      await mkdir(outside, { recursive: true });
      const runner = runnerFor(root);
      expect((await runner(['git', 'init', '-q'], inside)).exitCode).toBe(0);
      await writeFile(join(outside, 'record.json'), '{}\n');
      const outcome = await commitRecordFiles({
        root: inside,
        paths: [join(outside, 'record.json')],
        message: 'council: record x',
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason).toContain('record path is outside the records work tree');
    });
  });

  // Symlink creation needs a privilege or developer mode on Windows, so this leg is skipped there.
  test.skipIf(process.platform === 'win32')(
    'commits through a symlinked records root, which Git reports by its physical path',
    async () => {
      await withTempDirectory(async (root) => {
        const physical = join(root, 'physical');
        const link = join(root, 'link');
        await mkdir(physical, { recursive: true });
        const runner = runnerFor(root);
        expect((await runner(['git', 'init', '-q'], physical)).exitCode).toBe(0);
        await symlink(physical, link, 'dir');
        await mkdir(join(link, 'general', 'sessions'), { recursive: true });
        await writeFile(join(link, 'general', 'sessions', 'run-3.json'), '{}\n');

        const outcome = await commitRecordFiles({
          root: link,
          paths: [join(link, 'general', 'sessions', 'run-3.json')],
          message: 'council: record run-3',
          run: runner,
        });
        expect(outcome.committed).toBe(true);
        if (!outcome.committed) throw new Error('unreachable');
        const shown = await runner(['git', 'show', '--name-only', '--format=%s', 'HEAD'], physical);
        expect(shown.stdout).toContain('general/sessions/run-3.json');
      });
    },
  );

  test('ignores an inherited GIT_DIR so the record lands in the records repository', async () => {
    await withTempDirectory(async (root) => {
      const records = join(root, 'records');
      const other = join(root, 'other');
      await mkdir(records, { recursive: true });
      await mkdir(other, { recursive: true });
      const runner = runnerFor(root);
      expect((await runner(['git', 'init', '-q'], records)).exitCode).toBe(0);
      expect((await runner(['git', 'init', '-q'], other)).exitCode).toBe(0);
      await writeFile(join(other, 'seed.txt'), 'seed\n');
      expect((await runner(['git', 'add', '--', 'seed.txt'], other)).exitCode).toBe(0);
      expect((await runner(['git', 'commit', '-q', '-m', 'seed'], other)).exitCode).toBe(0);
      const otherHead = (await runner(['git', 'rev-parse', 'HEAD'], other)).stdout.trim();
      expect(otherHead).toMatch(/^[a-f0-9]{40}$/);

      await mkdir(join(records, 'general', 'sessions'), { recursive: true });
      await writeFile(join(records, 'general', 'sessions', 'run-2.json'), '{}\n');

      // Deliberately no `run` override: the default runner is what strips the redirect.
      const outcome = await commitRecordFiles({
        root: records,
        paths: [join(records, 'general', 'sessions', 'run-2.json')],
        message: 'council: record run-2',
        env: { ...identityFor(root), GIT_DIR: join(other, '.git') },
      });
      expect(outcome.committed).toBe(true);
      if (!outcome.committed) throw new Error('unreachable');
      expect((await runner(['git', 'rev-parse', 'HEAD'], records)).stdout.trim()).toBe(outcome.sha);
      expect((await runner(['git', 'rev-parse', 'HEAD'], other)).stdout.trim()).toBe(otherHead);
    });
  });
});
