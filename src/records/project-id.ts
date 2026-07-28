import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);
const ProjectIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?-[a-f0-9]{12}$/);

const RemoteProjectIdentitySchema = z.strictObject({
  source: z.literal('remote'),
  projectId: ProjectIdSchema,
  displayName: NonEmptyStringSchema,
  root: NonEmptyStringSchema,
  canonicalRemote: NonEmptyStringSchema,
});

const PathProjectIdentitySchema = z.strictObject({
  source: z.literal('path'),
  projectId: ProjectIdSchema,
  displayName: NonEmptyStringSchema,
  root: NonEmptyStringSchema,
});

export const ProjectIdentitySchema = z.discriminatedUnion('source', [
  RemoteProjectIdentitySchema,
  PathProjectIdentitySchema,
]);
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');

  return slug || 'project';
}

function normaliseRemotePath(remotePath: string): string {
  const path = remotePath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '');

  if (path.length === 0 || !path.includes('/')) {
    throw new Error('Git remote must include an owner and repository path');
  }

  return path;
}

function hostFromUrl(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) {
    throw new Error('Git remote must include a host');
  }

  const protocol = url.protocol.toLowerCase();
  const defaultPort =
    (protocol === 'https:' && url.port === '443') ||
    (protocol === 'http:' && url.port === '80') ||
    ((protocol === 'ssh:' || protocol === 'git+ssh:') && url.port === '22') ||
    (protocol === 'git:' && url.port === '9418');

  return url.port.length > 0 && !defaultPort ? `${hostname}:${url.port}` : hostname;
}

/**
 * Converts transport-specific Git remote syntax into host/owner/path form.
 * Credentials and schemes are deliberately excluded from the repository identity.
 */
export function canonicaliseRemote(remote: string): string {
  const input = NonEmptyStringSchema.parse(remote);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error('Git remote URL is malformed');
    }

    return `${hostFromUrl(parsed)}/${normaliseRemotePath(parsed.pathname)}`;
  }
  const normalisedInput = input.replace(/\\/g, '/');
  const canonicalWithPort = /^(\[[^\]]+\]|[^/@:\s]+):(\d+)\/(.+\/.+)$/.exec(normalisedInput);
  if (canonicalWithPort) {
    const host = canonicalWithPort[1];
    const port = canonicalWithPort[2];
    const remotePath = canonicalWithPort[3];
    if (!host || !port || !remotePath) throw new Error('Canonical Git remote is malformed');
    return `${host.toLowerCase()}:${port}/${normaliseRemotePath(remotePath)}`;
  }

  const scpLike = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\\\s]+):(.+)$/.exec(input);
  if (scpLike) {
    const host = scpLike[1];
    const remotePath = scpLike[2];
    if (!host || !remotePath) {
      throw new Error('Git remote is malformed');
    }
    return `${host.toLowerCase()}/${normaliseRemotePath(remotePath)}`;
  }

  const separator = input.replace(/\\/g, '/').indexOf('/');
  if (separator <= 0) {
    throw new Error('Git remote must include a host and repository path');
  }

  const host = input.slice(0, separator).toLowerCase();
  const remotePath = input.slice(separator + 1);
  if (/\s|@/.test(host)) {
    throw new Error('Canonical Git remote host is malformed');
  }

  return `${host}/${normaliseRemotePath(remotePath)}`;
}

/** Derives a stable, human-recognisable key while hashing the full canonical remote. */
export function projectIdFromRemote(remote: string): string {
  const canonicalRemote = canonicaliseRemote(remote);
  return `${slugify(canonicalRemote)}-${sha256(canonicalRemote).slice(0, 12)}`;
}

function normaliseRootPath(root: string): string {
  const input = NonEmptyStringSchema.parse(root);
  const isWindowsPath = win32.isAbsolute(input);
  let absolute: string;

  if (isWindowsPath) {
    absolute = win32.normalize(input).replace(/\\/g, '/');
  } else {
    absolute = isAbsolute(input) ? posix.normalize(input) : posix.normalize(resolve(input));
  }

  absolute = absolute.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (absolute.length > 1) absolute = absolute.replace(/\/+$/g, '');

  // Drive-letter paths are case-insensitive repository identities on Windows.
  return /^[A-Za-z]:\//.test(absolute) ? absolute.toLowerCase() : absolute;
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string | undefined> {
  let processHandle;
  try {
    processHandle = Bun.spawn(['git', '-C', cwd, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
  } catch {
    return undefined;
  }

  const [stdout, , exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) return undefined;

  const output = stdout.trim();
  return output.length > 0 ? output : undefined;
}

async function isInsideGitWorktree(root: string): Promise<boolean> {
  let current = root;
  for (;;) {
    try {
      await stat(join(current, '.git'));
      return true;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        Reflect.get(error, 'code') !== 'ENOENT'
      ) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Resolves the repository root first, then prefers its origin or first named remote. */
export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const requestedRoot = NonEmptyStringSchema.parse(cwd);
  const requestedPhysicalRoot = await realpath(
    isAbsolute(requestedRoot) ? requestedRoot : resolve(requestedRoot),
  );
  const gitRoot = (await isInsideGitWorktree(requestedPhysicalRoot))
    ? await gitOutput(requestedPhysicalRoot, ['rev-parse', '--show-toplevel'])
    : undefined;
  const physicalRoot = gitRoot === undefined ? requestedPhysicalRoot : await realpath(gitRoot);
  const root = normaliseRootPath(physicalRoot);
  const displayName = basename(physicalRoot) || 'project';

  let remote = await gitOutput(physicalRoot, ['remote', 'get-url', 'origin']);
  if (!remote && gitRoot) {
    const names = await gitOutput(physicalRoot, ['remote']);
    const firstRemote = names
      ?.split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort()[0];
    if (firstRemote) remote = await gitOutput(physicalRoot, ['remote', 'get-url', firstRemote]);
  }

  if (remote) {
    const canonicalRemote = canonicaliseRemote(remote);
    return ProjectIdentitySchema.parse({
      source: 'remote',
      projectId: projectIdFromRemote(canonicalRemote),
      displayName,
      root,
      canonicalRemote,
    });
  }

  return ProjectIdentitySchema.parse({
    source: 'path',
    projectId: `${slugify(displayName)}-${sha256(root).slice(0, 12)}`,
    displayName,
    root,
  });
}
