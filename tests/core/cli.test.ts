import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runIsolatedCli } from '../../src/execution/cli';

const fixtures = join(import.meta.dir, 'fixtures');
setDefaultTimeout(20_000);

async function makeEmptyTempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'council-cli-test-'));
}

describe('isolated CLI execution', () => {
  test('uses stdin, an absolute executable and an owned temporary cwd', async () => {
    const root = await makeEmptyTempDirectory();
    try {
      const result = await runIsolatedCli({
        executable: process.execPath,
        args: [join(fixtures, 'cli-ok.ts')],
        stdin: 'motion from stdin',
        timeoutMs: 10_000,
        cwd: root,
      });

      expect(result.status).toBe('ok');
      expect(isAbsolute(result.executable)).toBe(true);
      expect(JSON.parse(result.stdout)).toMatchObject({ stdin: 'motion from stdin' });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('kills a child process tree and reports timed-out', async () => {
    const root = await makeEmptyTempDirectory();
    try {
      const result = await runIsolatedCli({
        executable: process.execPath,
        args: [join(fixtures, 'cli-child-hang.ts')],
        stdin: 'motion',
        timeoutMs: 100,
        cwd: root,
      });

      expect(result.status).toBe('timed-out');
      expect(result.treeTerminated).toBe(true);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('rejects repository-local executables before spawning', async () => {
    const root = await makeEmptyTempDirectory();
    try {
      const result = await runIsolatedCli({
        executable: join(import.meta.dir, '../../src/cli.ts'),
        args: [],
        stdin: 'motion',
        timeoutMs: 100,
        cwd: root,
      });

      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('repository-executable');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
