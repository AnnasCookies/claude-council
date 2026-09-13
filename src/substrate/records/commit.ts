import { relative, resolve, sep } from 'node:path';
import { scanAndRedact } from '../policy/secrets';

export type CommandRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface RecordCommitInput {
  readonly root: string;
  readonly paths: readonly string[];
  readonly message: string;
  /** The kernel's own repository. Records must never be committed into it. */
  readonly forbiddenRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: CommandRunner;
}

export type RecordCommitOutcome =
  | { readonly committed: true; readonly sha: string }
  | { readonly committed: false; readonly reason: string };

const defaultRunner = async (
  argv: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  let child;
  try {
    child = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function redacted(text: string): string {
  return scanAndRedact(text).redacted.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function isInside(path: string, root: string): boolean {
  const relation = relative(root, path);
  return (
    relation === '' ||
    (!relation.startsWith('..') && !relation.startsWith(sep) && !/^[A-Za-z]:/.test(relation))
  );
}

/**
 * Commit the record files just written, and nothing else. Durability is Git: a terminal record is
 * committed before the run reports success, so a record cannot exist only on the machine that
 * wrote it. This never pushes and never sets authorship; the repository's own identity applies.
 */
export async function commitRecordFiles(input: RecordCommitInput): Promise<RecordCommitOutcome> {
  const run = input.run ?? ((argv, cwd) => defaultRunner(argv, cwd, input.env));
  const root = resolve(input.root);
  const toplevel = await run(['git', 'rev-parse', '--show-toplevel'], root);
  if (toplevel.exitCode !== 0) {
    return { committed: false, reason: 'records root is not inside a Git work tree' };
  }
  const workTree = resolve(toplevel.stdout.trim());
  if (input.forbiddenRoot !== undefined && workTree === resolve(input.forbiddenRoot)) {
    return {
      committed: false,
      reason: 'records root is the kernel repository; refusing to commit records into it',
    };
  }
  const relativePaths = input.paths.map((path) => {
    const absolute = resolve(path);
    if (!isInside(absolute, workTree)) {
      throw new Error(`Record path is outside the records work tree: ${absolute}`);
    }
    return relative(workTree, absolute);
  });
  const added = await run(['git', 'add', '--', ...relativePaths], workTree);
  if (added.exitCode !== 0) {
    return { committed: false, reason: `git add failed: ${redacted(added.stderr)}` };
  }
  // `--no-verify` skips the records repository's own hooks: a records commit is a mechanical
  // append, and a hook that blocked it would leave the record uncommitted after the run had
  // already reported success.
  const committed = await run(
    ['git', 'commit', '--quiet', '--no-verify', '-m', input.message, '--', ...relativePaths],
    workTree,
  );
  if (committed.exitCode !== 0) {
    return {
      committed: false,
      reason: `git commit failed: ${redacted(committed.stderr || committed.stdout)}`,
    };
  }
  const head = await run(['git', 'rev-parse', 'HEAD'], workTree);
  if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
    return {
      committed: false,
      reason: `commit succeeded but HEAD could not be read: ${redacted(head.stderr)}`,
    };
  }
  return { committed: true, sha: head.stdout.trim() };
}
