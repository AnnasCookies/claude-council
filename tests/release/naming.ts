#!/usr/bin/env bun
// Release gate: the package was renamed from claude-council to convene on 2026-09-15. The former
// name may survive only where it is history, or where it names something that is not this package.
// Every allowance below says why, so a new stray occurrence fails the gate instead of joining them.
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const formerName = 'claude-council';

type Allowance = { path: string; reason: string; line?: RegExp };

// A path ending in '/' allows a tree. `line` narrows the allowance to matching lines only.
const allowances: Allowance[] = [
  { path: 'CHANGELOG.md', reason: 'release history' },
  { path: 'docs/forge/', reason: 'briefs and plans are dated records' },
  { path: 'docs/council-suite-brief.md', reason: 'handover written before the rename' },
  {
    path: 'README.md',
    reason: 'the OMP profile is named after the former package name',
    line: /OMP profile/,
  },
  {
    path: 'src/substrate/execution/provider.ts',
    reason: 'the OMP profile constant and its comment',
    line: /OMP|omp/,
  },
  { path: 'tests/core/providers.test.ts', reason: 'fixtures for that OMP profile' },
  {
    path: 'tests/release/repository-ownership.ts',
    reason: 'the former origin is a refused fixture',
  },
  { path: 'tests/release/naming.ts', reason: 'this gate' },
  { path: 'dist/cli.js', reason: 'the bundle carries the OMP profile constant' },
];

function allowance(path: string, line: string): Allowance | undefined {
  return allowances.find(
    (entry) =>
      (entry.path.endsWith('/') ? path.startsWith(entry.path) : path === entry.path) &&
      (entry.line === undefined || entry.line.test(line)),
  );
}

const listing = Bun.spawnSync({ cmd: ['git', '-C', root, 'ls-files', '-z'], stdout: 'pipe' });
if (listing.exitCode !== 0) {
  console.error('Naming gate could not list tracked files.');
  process.exit(1);
}
const tracked = listing.stdout
  .toString()
  .split('\0')
  .filter((path) => path.length > 0);

const strays: string[] = [];
const used = new Set<string>();
for (const path of tracked) {
  const file = Bun.file(resolve(root, path));
  if (!(await file.exists())) continue;
  const text = await file.text();
  if (!text.includes(formerName)) continue;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (!line.includes(formerName)) return;
    const entry = allowance(path, line);
    if (entry === undefined) strays.push(`${path}:${index + 1}: ${line.trim()}`);
    else used.add(entry.path);
  });
}

const unused = allowances.filter((entry) => !used.has(entry.path));

if (strays.length > 0 || unused.length > 0) {
  console.error('Naming gate failed:');
  for (const stray of strays) console.error(`- former name outside the allow-list: ${stray}`);
  for (const entry of unused) {
    console.error(`- allowance no longer needed, remove it: ${entry.path} (${entry.reason})`);
  }
  process.exit(1);
}

console.log(
  `Naming gate passed: the former name appears only where allowed (${used.size} places).`,
);
