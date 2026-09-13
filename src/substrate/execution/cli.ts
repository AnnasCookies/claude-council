import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type CliOwnedValue = string | ((workingDirectory: string) => string);

export interface CliRequest {
  executable: string;
  args: CliOwnedValue[];
  stdin: string;
  timeoutMs: number;
  cwd: string;
  env?: Record<string, string>;
  files?: Readonly<Record<string, CliOwnedValue>>;
  workingDirectoryEnv?: readonly string[];
}

export type CliStatus = 'ok' | 'failed' | 'timed-out';
export type CliErrorCode =
  | 'executable-not-found'
  | 'repository-executable'
  | 'invalid-request'
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'timeout'
  | 'output-limit';

export interface CliResult {
  status: CliStatus;
  executable: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  treeTerminated: boolean;
  errorCode: CliErrorCode | null;
  workingDirectory?: string;
}

export const CLI_OUTPUT_LIMIT_BYTES = 1024 * 1024;

interface BoundedOutput {
  text: string;
  exceeded: boolean;
}

function findPackageRoot(startDirectory: string): string {
  let candidate = realpathSync(startDirectory);
  while (true) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = resolve(candidate, '..');
    if (parent === candidate) {
      throw new Error('claude-council package root could not be resolved');
    }
    candidate = parent;
  }
}

const repositoryRoot = findPackageRoot(import.meta.dir);
const inheritedEnvironment = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function absoluteExecutable(executable: string): Promise<string | undefined> {
  const candidate = isAbsolute(executable) ? executable : Bun.which(executable);
  if (!candidate) return undefined;
  try {
    return await realpath(candidate);
  } catch {
    return resolve(candidate);
  }
}

function isolatedEnvironment(
  additions?: Record<string, string>,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const name of inheritedEnvironment) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (additions) {
    for (const [name, value] of Object.entries(additions)) environment[name] = value;
  }
  return environment;
}

function ownedPath(workingDirectory: string, requestedPath: string): string | undefined {
  if (!requestedPath || isAbsolute(requestedPath)) return undefined;
  const destination = resolve(workingDirectory, requestedPath);
  return inside(workingDirectory, destination) ? destination : undefined;
}

function resolveOwnedValue(value: CliOwnedValue, workingDirectory: string): string {
  return typeof value === 'function' ? value(workingDirectory) : value;
}

async function stageRequestFiles(request: CliRequest, workingDirectory: string): Promise<void> {
  for (const [requestedPath, value] of Object.entries(request.files ?? {})) {
    const destination = ownedPath(workingDirectory, requestedPath);
    if (!destination) throw new Error(`invalid staged file path: ${requestedPath}`);
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    await writeFile(destination, resolveOwnedValue(value, workingDirectory), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

function failedResult(
  executable: string,
  startedAt: number,
  errorCode: CliErrorCode,
  stderr: string,
): CliResult {
  return {
    status: 'failed',
    executable,
    exitCode: null,
    stdout: '',
    stderr,
    durationMs: Date.now() - startedAt,
    treeTerminated: false,
    errorCode,
  };
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<BoundedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { text: Buffer.concat(chunks, totalBytes).toString('utf8'), exceeded: false };
    if (totalBytes + value.byteLength > CLI_OUTPUT_LIMIT_BYTES) {
      onLimit();
      await reader.cancel().catch(() => undefined);
      return { text: '', exceeded: true };
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }
}

export async function runIsolatedCli(request: CliRequest): Promise<CliResult> {
  const startedAt = Date.now();
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    return failedResult(
      request.executable,
      startedAt,
      'invalid-request',
      'timeoutMs must be positive',
    );
  }

  const executable = await absoluteExecutable(request.executable);

  if (!executable) {
    return failedResult(
      request.executable,
      startedAt,
      'executable-not-found',
      'executable not found',
    );
  }
  if (inside(repositoryRoot, executable)) {
    return failedResult(
      executable,
      startedAt,
      'repository-executable',
      'repository-local executables are not permitted',
    );
  }

  const workingDirectory = await realpath(
    await mkdtemp(join(resolve(request.cwd), 'claude-council-cli-')),
  );
  try {
    let args: string[];
    try {
      await stageRequestFiles(request, workingDirectory);
      args = request.args.map((value) => resolveOwnedValue(value, workingDirectory));
    } catch (error) {
      return failedResult(
        executable,
        startedAt,
        'invalid-request',
        error instanceof Error ? error.message : 'failed to prepare CLI inputs',
      );
    }

    const environment = isolatedEnvironment(request.env);
    for (const name of request.workingDirectoryEnv ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return failedResult(
          executable,
          startedAt,
          'invalid-request',
          `invalid environment name: ${name}`,
        );
      }
      environment[name] = workingDirectory;
    }

    let processHandle;
    try {
      processHandle = Bun.spawn([executable, ...args], {
        cwd: workingDirectory,
        env: environment,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      return failedResult(
        executable,
        startedAt,
        'spawn-failed',
        error instanceof Error ? error.message : 'spawn failed',
      );
    }

    processHandle.stdin.write(request.stdin);
    processHandle.stdin.end();

    let terminationReason: 'timeout' | 'output-limit' | null = null;
    let treeTerminated = false;
    const terminateTree = (reason: 'timeout' | 'output-limit') => {
      if (terminationReason !== null) return;
      terminationReason = reason;
      if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
        if (systemRoot) {
          const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
          const termination = Bun.spawnSync([
            taskkill,
            '/T',
            '/F',
            '/PID',
            String(processHandle.pid),
          ]);
          treeTerminated = termination.exitCode === 0;
        }
        if (!treeTerminated) processHandle.kill('SIGKILL');
      } else {
        try {
          process.kill(-processHandle.pid, 'SIGKILL');
          treeTerminated = true;
        } catch {
          processHandle.kill('SIGKILL');
        }
      }
    };
    const timer = setTimeout(() => terminateTree('timeout'), request.timeoutMs);

    try {
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readBoundedOutput(processHandle.stdout, () => terminateTree('output-limit')),
        readBoundedOutput(processHandle.stderr, () => terminateTree('output-limit')),
        processHandle.exited,
      ]);
      if (terminationReason === 'output-limit' || stdoutResult.exceeded || stderrResult.exceeded) {
        return {
          status: 'failed',
          executable,
          exitCode,
          stdout: '',
          stderr: 'CLI output exceeded the byte limit',
          durationMs: Date.now() - startedAt,
          treeTerminated,
          errorCode: 'output-limit',
          workingDirectory,
        };
      }
      if (terminationReason === 'timeout') {
        return {
          status: 'timed-out',
          executable,
          exitCode,
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          durationMs: Date.now() - startedAt,
          treeTerminated,
          errorCode: 'timeout',
          workingDirectory,
        };
      }
      return {
        status: exitCode === 0 ? 'ok' : 'failed',
        executable,
        exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        durationMs: Date.now() - startedAt,
        treeTerminated: false,
        errorCode: exitCode === 0 ? null : 'non-zero-exit',
        workingDirectory,
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(workingDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
