import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { link, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_OUTPUT_LIMIT_BYTES, runIsolatedCli } from '../../src/execution/cli';

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

  test('resolves generated arguments and private files inside the owned cwd', async () => {
    const root = await makeEmptyTempDirectory();
    try {
      const result = await runIsolatedCli({
        executable: process.execPath,
        args: [
          join(fixtures, 'cli-ok.ts'),
          (workingDirectory) => join(workingDirectory, 'council-prompt.txt'),
          (workingDirectory) => join(workingDirectory, 'settings.json'),
        ],
        stdin: '',
        timeoutMs: 10_000,
        cwd: root,
        files: {
          'council-prompt.txt': 'private prompt',
          'settings.json': (workingDirectory) => JSON.stringify({ workingDirectory }),
        },
        workingDirectoryEnv: ['TEST_WORKING_DIRECTORY'],
      });

      expect(result.status).toBe('ok');
      const output = JSON.parse(result.stdout) as {
        cwd: string;
        files: Record<string, string>;
        workingDirectoryEnv: string;
      };
      expect(output.files).toEqual({
        [join(output.cwd, 'council-prompt.txt')]: 'private prompt',
        [join(output.cwd, 'settings.json')]: JSON.stringify({ workingDirectory: output.cwd }),
      });
      expect(output.workingDirectoryEnv).toBe(output.cwd);
      if (process.platform === 'win32') expect(output.cwd).not.toMatch(/~\d/);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('rejects staged paths that escape the owned cwd', async () => {
    const root = await makeEmptyTempDirectory();
    try {
      const result = await runIsolatedCli({
        executable: process.execPath,
        args: [join(fixtures, 'cli-ok.ts')],
        stdin: '',
        timeoutMs: 10_000,
        cwd: root,
        files: { '../outside.txt': 'must not be written' },
      });

      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('invalid-request');
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

  test('bundled execution resolves the package root rather than its parent', async () => {
    const stagingRoot = await realpath(await makeEmptyTempDirectory());
    const packageRoot = join(stagingRoot, 'claude-council');
    const outputDirectory = join(packageRoot, 'dist');
    const externalExecutable = join(stagingRoot, basename(process.execPath));
    try {
      await mkdir(outputDirectory, { recursive: true });
      await Bun.write(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'claude-council', type: 'module' }),
      );
      await link(process.execPath, externalExecutable);
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../src/execution/cli.ts')],
        outdir: outputDirectory,
        target: 'bun',
        format: 'esm',
      });
      expect(build.success).toBe(true);

      const bundled = (await import(
        `${pathToFileURL(join(outputDirectory, 'cli.js')).href}?test=${Date.now()}`
      )) as typeof import('../../src/execution/cli');
      const result = await bundled.runIsolatedCli({
        executable: externalExecutable,
        args: [join(fixtures, 'cli-ok.ts')],
        stdin: 'motion from bundled execution',
        timeoutMs: 10_000,
        cwd: packageRoot,
      });

      expect(result.status).toBe('ok');
    } finally {
      await rm(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    test(`accepts ${stream} exactly at the byte limit`, async () => {
      const root = await makeEmptyTempDirectory();
      try {
        const result = await runIsolatedCli({
          executable: process.execPath,
          args: ['-e', `process.${stream}.write('x'.repeat(${CLI_OUTPUT_LIMIT_BYTES}))`],
          stdin: '',
          timeoutMs: 10_000,
          cwd: root,
        });

        expect(result.status).toBe('ok');
        expect(Buffer.byteLength(result[stream])).toBe(CLI_OUTPUT_LIMIT_BYTES);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });

    test(`terminates ${stream} at one byte over the limit`, async () => {
      const root = await makeEmptyTempDirectory();
      try {
        const result = await runIsolatedCli({
          executable: process.execPath,
          args: ['-e', `process.${stream}.write('x'.repeat(${CLI_OUTPUT_LIMIT_BYTES + 1}))`],
          stdin: '',
          timeoutMs: 10_000,
          cwd: root,
        });

        expect(result.status).toBe('failed');
        expect(result.errorCode).toBe('output-limit');
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('CLI output exceeded the byte limit');
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  }
});
