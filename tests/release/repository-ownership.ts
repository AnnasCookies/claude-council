#!/usr/bin/env bun
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const expectedOrigin = 'AnnasCookies/claude-council';
const expectedUpstream = 'hex/claude-council';

type Remotes = { origin?: string; upstream?: string };
type FailureCode = 'origin' | 'upstream';
type Failure = { code: FailureCode; message: string };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Ownership fixture failure: ${message}`);
}

function repositorySlug(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const match = trimmed.match(
    /^(?:(?:https?|ssh|git):\/\/(?:git@)?github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/,
  );
  return match?.[1] ?? null;
}

function validateRemotes(remotes: Remotes): Failure[] {
  const failures: Failure[] = [];
  const origin = repositorySlug(remotes.origin);
  const upstream = repositorySlug(remotes.upstream);
  if (origin !== expectedOrigin) {
    failures.push({
      code: 'origin',
      message: `origin resolved to ${origin ?? 'missing'}; expected ${expectedOrigin}`,
    });
  }
  if (upstream !== expectedUpstream) {
    failures.push({
      code: 'upstream',
      message: `upstream resolved to ${upstream ?? 'missing'}; expected ${expectedUpstream}`,
    });
  }
  return failures;
}

function assertFixtureCoverage(): void {
  const validHttps = validateRemotes({
    origin: 'https://github.com/AnnasCookies/claude-council.git',
    upstream: 'https://github.com/hex/claude-council',
  });
  invariant(validHttps.length === 0, 'canonical HTTPS remotes were rejected');

  const validSsh = validateRemotes({
    origin: 'git@github.com:AnnasCookies/claude-council.git',
    upstream: 'git@github.com:hex/claude-council.git',
  });
  invariant(validSsh.length === 0, 'canonical SSH remotes were rejected');

  const fixtures: Array<[string, Remotes, FailureCode]> = [
    ['missing origin', { upstream: 'https://github.com/hex/claude-council' }, 'origin'],
    ['missing upstream', { origin: 'https://github.com/AnnasCookies/claude-council' }, 'upstream'],
    [
      'swapped remotes',
      {
        origin: 'https://github.com/hex/claude-council',
        upstream: 'https://github.com/AnnasCookies/claude-council',
      },
      'origin',
    ],
    [
      'foreign origin',
      {
        origin: 'https://github.com/example/claude-council',
        upstream: 'https://github.com/hex/claude-council',
      },
      'origin',
    ],
    [
      'foreign upstream',
      {
        origin: 'https://github.com/AnnasCookies/claude-council',
        upstream: 'https://github.com/example/claude-council',
      },
      'upstream',
    ],
  ];
  for (const [name, remotes, expectedCode] of fixtures) {
    invariant(
      validateRemotes(remotes).some((failure) => failure.code === expectedCode),
      `${name} was not refused`,
    );
  }
}

function gitConfig(key: string): string | undefined {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', root, 'config', '--get', key],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

async function readIfPresent(path: string): Promise<string> {
  const file = Bun.file(resolve(root, path));
  return (await file.exists()) ? file.text() : '';
}

assertFixtureCoverage();

const failures: string[] = validateRemotes({
  origin: gitConfig('remote.origin.url'),
  upstream: gitConfig('remote.upstream.url'),
}).map((failure) => failure.message);

const licence = await readIfPresent('LICENSE');
const mitClauses = [
  /^MIT License/m,
  /Copyright \(c\) 2025-2026 hex/,
  /Permission is hereby granted, free of charge/,
  /THE SOFTWARE IS PROVIDED "AS IS"/,
];
if (!mitClauses.every((clause) => clause.test(licence))) {
  failures.push('LICENSE does not retain the upstream hex MIT licence and grant/disclaimer text');
}

const pluginText = await readIfPresent('.claude-plugin/plugin.json');
try {
  const plugin = JSON.parse(pluginText) as {
    author?: { name?: string; url?: string };
    homepage?: string;
    repository?: string;
  };
  const ownedUrl = 'https://github.com/AnnasCookies/claude-council';
  if (
    plugin.author?.name !== 'AnnasCookies' ||
    plugin.author.url !== 'https://github.com/AnnasCookies' ||
    plugin.homepage !== ownedUrl ||
    plugin.repository !== ownedUrl
  ) {
    failures.push(
      'plugin metadata does not identify the maintained AnnasCookies/claude-council fork',
    );
  }
} catch {
  failures.push('.claude-plugin/plugin.json is missing or invalid JSON');
}

const attributionCandidates = await Promise.all([
  readIfPresent('README.md'),
  readIfPresent('NOTICE'),
  readIfPresent('LICENSE'),
  readIfPresent('.claude-plugin/plugin.json'),
  readIfPresent('package.json'),
]);
if (
  !attributionCandidates.some((content) =>
    /(?:https:\/\/)?github\.com\/hex\/claude-council(?:\.git)?\b/.test(content),
  )
) {
  failures.push('public metadata has no explicit attribution to hex/claude-council');
}

if (failures.length > 0) {
  console.error('Repository ownership gate failed before any release mutation:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  'Repository ownership gate passed: owned origin, canonical upstream and retained MIT attribution are present.',
);
