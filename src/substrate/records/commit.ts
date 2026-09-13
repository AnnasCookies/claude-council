import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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

/**
 * Git's own environment overrides point the child at a different repository. They are set inside
 * hooks, `git rebase -x` and `git bisect run`, so a council invoked from one of those would
 * otherwise commit its records into whatever repository the outer Git was working on.
 */
const INHERITED_GIT_REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
] as const;

function childEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of INHERITED_GIT_REDIRECTS) delete merged[key];
  return merged;
}

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
      env: childEnvironment(env),
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

interface CanonicalPath {
  readonly path: string;
  /** False when `realpath` rejected and the path was only lexically resolved. */
  readonly canonical: boolean;
}

/**
 * `git rev-parse --show-toplevel` reports the physical path, with every symlink already resolved,
 * while `resolve` preserves them. Comparing the two forms makes a symlinked records root look as
 * though it lay outside its own work tree, so both sides are canonicalised here. A path that does
 * not exist yet cannot be canonicalised, and falls back to a lexical resolve.
 */
async function canonicalise(path: string): Promise<CanonicalPath> {
  try {
    return { path: await realpath(path), canonical: true };
  } catch {
    return { path: resolve(path), canonical: false };
  }
}

function isInside(path: string, root: string): boolean {
  const relation = relative(root, path);
  if (relation === '') return true;
  return !(relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation));
}

/**
 * Commit the record files just written, and nothing else. Durability is Git: a terminal record is
 * committed before the run reports success, so a record cannot exist only on the machine that
 * wrote it. This never pushes and never sets authorship; the repository's own identity applies.
 *
 * Every failure is reported, never thrown: the record is already on disk by the time this runs, so
 * an uncommittable record is a degradation of the run rather than the end of it.
 */
export async function commitRecordFiles(input: RecordCommitInput): Promise<RecordCommitOutcome> {
  const run = input.run ?? ((argv, cwd) => defaultRunner(argv, cwd, input.env));
  const root = (await canonicalise(input.root)).path;
  const toplevel = await run(['git', 'rev-parse', '--show-toplevel'], root);
  if (toplevel.exitCode !== 0) {
    return { committed: false, reason: 'records root is not inside a Git work tree' };
  }
  const workTree = await canonicalise(toplevel.stdout.trim());
  if (input.forbiddenRoot !== undefined) {
    const forbidden = await canonicalise(input.forbiddenRoot);
    if (workTree.path === forbidden.path) {
      return {
        committed: false,
        reason: 'records root is the kernel repository; refusing to commit records into it',
      };
    }
  }
  const relativePaths: string[] = [];
  for (const path of input.paths) {
    const record = await canonicalise(path);
    if (!isInside(record.path, workTree.path)) {
      const uncanonical = !record.canonical || !workTree.canonical;
      return {
        committed: false,
        reason: `record path is outside the records work tree: ${record.path}${
          uncanonical ? ' (compared without realpath, which rejected the path)' : ''
        }`,
      };
    }
    relativePaths.push(relative(workTree.path, record.path));
  }
  const added = await run(['git', 'add', '--', ...relativePaths], workTree.path);
  if (added.exitCode !== 0) {
    return { committed: false, reason: `git add failed: ${redacted(added.stderr)}` };
  }
  // `--no-verify` skips the records repository's own hooks: a records commit is a mechanical
  // append, and a hook that blocked it would leave the record uncommitted after the run had
  // already reported success.
  const committed = await run(
    ['git', 'commit', '--quiet', '--no-verify', '-m', input.message, '--', ...relativePaths],
    workTree.path,
  );
  if (committed.exitCode !== 0) {
    return {
      committed: false,
      reason: `git commit failed: ${redacted(committed.stderr || committed.stdout)}`,
    };
  }
  const head = await run(['git', 'rev-parse', 'HEAD'], workTree.path);
  if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
    return {
      committed: false,
      reason: `commit succeeded but HEAD could not be read: ${redacted(head.stderr)}`,
    };
  }
  return { committed: true, sha: head.stdout.trim() };
}
