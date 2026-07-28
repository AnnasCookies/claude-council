import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface CliRequest {
  executable: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  cwd: string;
  env?: Record<string, string>;
}

export type CliStatus = 'ok' | 'failed' | 'timed-out';
export type CliErrorCode =
  | 'executable-not-found'
  | 'repository-executable'
  | 'invalid-request'
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'timeout';

export interface CliResult {
  status: CliStatus;
  executable: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  treeTerminated: boolean;
  errorCode: CliErrorCode | null;
}

const repositoryRoot = resolve(import.meta.dir, '..', '..');
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

  const workingDirectory = await mkdtemp(join(resolve(request.cwd), 'claude-council-cli-'));
  try {
    let processHandle;
    try {
      processHandle = Bun.spawn([executable, ...request.args], {
        cwd: workingDirectory,
        env: isolatedEnvironment(request.env),
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

    let timedOut = false;
    let treeTerminated = false;
    const terminateTree = () => {
      timedOut = true;
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
    const timer = setTimeout(terminateTree, request.timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
      ]);
      if (timedOut) {
        return {
          status: 'timed-out',
          executable,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          treeTerminated,
          errorCode: 'timeout',
        };
      }
      return {
        status: exitCode === 0 ? 'ok' : 'failed',
        executable,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        treeTerminated: false,
        errorCode: exitCode === 0 ? null : 'non-zero-exit',
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
