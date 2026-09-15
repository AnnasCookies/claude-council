#!/usr/bin/env bun
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const expectedOrigin = 'AnnasCookies/convene';

type Failure = { code: 'origin'; message: string };

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

function validateOrigin(origin: string | undefined): Failure[] {
  const slug = repositorySlug(origin);
  if (slug === expectedOrigin) return [];
  return [
    {
      code: 'origin',
      message: `origin resolved to ${slug ?? 'missing'}; expected ${expectedOrigin}`,
    },
  ];
}

function assertFixtureCoverage(): void {
  invariant(
    validateOrigin('https://github.com/AnnasCookies/convene.git').length === 0,
    'canonical HTTPS origin was rejected',
  );
  invariant(
    validateOrigin('git@github.com:AnnasCookies/convene.git').length === 0,
    'canonical SSH origin was rejected',
  );
  // The former name is refused on purpose: a checkout still pointing at it has not been repointed.
  const refused: Array<[string, string | undefined]> = [
    ['missing origin', undefined],
    ['the former name', 'https://github.com/AnnasCookies/claude-council.git'],
    ['another owner', 'https://github.com/example/convene'],
    ['a non-GitHub host', 'https://gitlab.com/AnnasCookies/convene'],
  ];
  for (const [name, origin] of refused) {
    invariant(validateOrigin(origin).length === 1, `${name} was not refused`);
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

const failures: string[] = validateOrigin(gitConfig('remote.origin.url')).map(
  (failure) => failure.message,
);

// The code was received under MIT, whose terms require its copyright notice to stay with it.
const licence = await readIfPresent('LICENSE');
const mitClauses = [
  /^MIT License/m,
  /Copyright \(c\) 2025-2026 hex/,
  /Permission is hereby granted, free of charge/,
  /THE SOFTWARE IS PROVIDED "AS IS"/,
];
if (!mitClauses.every((clause) => clause.test(licence))) {
  failures.push(
    'LICENSE does not retain the MIT notice and grant/disclaimer text the code was received under',
  );
}

const pluginText = await readIfPresent('.claude-plugin/plugin.json');
try {
  const plugin = JSON.parse(pluginText) as {
    author?: { name?: string; url?: string };
    homepage?: string;
    repository?: string;
  };
  const ownedUrl = 'https://github.com/AnnasCookies/convene';
  if (
    plugin.author?.name !== 'AnnasCookies' ||
    plugin.author.url !== 'https://github.com/AnnasCookies' ||
    plugin.homepage !== ownedUrl ||
    plugin.repository !== ownedUrl
  ) {
    failures.push('plugin metadata does not identify AnnasCookies/convene');
  }
} catch {
  failures.push('.claude-plugin/plugin.json is missing or invalid JSON');
}

if (failures.length > 0) {
  console.error('Repository ownership gate failed before any release mutation:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  'Repository ownership gate passed: owned origin, plugin metadata and the retained MIT notice are present.',
);
