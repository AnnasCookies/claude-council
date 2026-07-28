#!/usr/bin/env bun
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

type Source = 'tracked' | 'package' | 'fixture';
type Entry = { path: string; content: string; source: Source };
type FindingKind =
  'credential' | 'private-absolute-path' | 'private-artifact-path' | 'private-material';
type Finding = { kind: FindingKind; path: string; line: number; source: Source; evidence: string };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Privacy scanner fixture failure: ${message}`);
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

const placeholderUsers: Record<string, true> = {
  user: true,
  username: true,
  'your-name': true,
  yourname: true,
  example: true,
  'first last': true,
  'jane doe': true,
  'john doe': true,
};

function scanEntry(entry: Entry): Finding[] {
  const findings: Finding[] = [];
  const add = (kind: FindingKind, index: number, evidence: string) =>
    findings.push({
      kind,
      path: entry.path,
      line: lineAt(entry.content, index),
      source: entry.source,
      evidence,
    });

  const windowsHomes =
    /\b([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]([A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)*)[\\/])/gi;
  for (const match of entry.content.matchAll(windowsHomes)) {
    if (!placeholderUsers[match[2]!.toLowerCase()])
      add('private-absolute-path', match.index, match[1]!);
  }

  const posixHomes = /(^|[\s`"'(])((?:\/home|\/Users)\/([A-Za-z0-9._-]+)\/)/gm;
  for (const match of entry.content.matchAll(posixHomes)) {
    if (!placeholderUsers[match[3]!.toLowerCase()])
      add('private-absolute-path', match.index + match[1]!.length, match[2]!);
  }

  const credentialPatterns = [
    /\b(?:sk-(?:proj-)?|xai-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ];
  for (const pattern of credentialPatterns) {
    for (const match of entry.content.matchAll(pattern))
      add('credential', match.index, 'redacted credential-shaped value');
  }

  const normalPath = entry.path.replaceAll('\\', '/');
  if (
    /(^|\/)\.claude\/council\/(?:general|projects?|records?)\/(?:.+\/)?(?:charter|ledger|record)(?:\.[^/]+)?$/i.test(
      normalPath,
    )
  ) {
    add('private-artifact-path', 0, normalPath);
  }

  const privateMaterial = /^private-council-(identity|project|record|charter|ledger):\s*\S.+$/gim;
  for (const match of entry.content.matchAll(privateMaterial))
    add('private-material', match.index, match[0]!.slice(0, 120));

  return findings;
}

function assertFixtureCoverage(): void {
  const privateUserPath = [
    'C:',
    'Users',
    'PrivatePerson',
    '.claude',
    'council',
    'general',
    'ledger.md',
  ].join('/');
  const secret = ['sk', 'live', 'A'.repeat(28)].join('-');
  const forbidden: Array<[FindingKind, Entry]> = [
    [
      'private-absolute-path',
      { path: 'fixture/path.txt', content: `source=${privateUserPath}`, source: 'fixture' },
    ],
    ['credential', { path: 'fixture/secret.txt', content: `token=${secret}`, source: 'fixture' }],
    [
      'private-artifact-path',
      {
        path: ['.claude', 'council', 'projects', 'client-a', 'ledger.md'].join('/'),
        content: 'fixture',
        source: 'fixture',
      },
    ],
    [
      'private-material',
      {
        path: 'fixture/material.txt',
        content: ['private-council', 'record: motion-42 owner=person'].join('-'),
        source: 'fixture',
      },
    ],
  ];
  for (const [kind, entry] of forbidden) {
    invariant(
      scanEntry(entry).some((finding) => finding.kind === kind),
      `seeded ${kind} control was not detected`,
    );
  }

  const benign: Entry[] = [
    {
      path: 'README.md',
      content: 'OPENAI_API_KEY=your-key\nHOME=$HOME/.claude/council',
      source: 'fixture',
    },
    {
      path: 'CHANGELOG.md',
      content: 'Windows example: C:\\Users\\First Last\\.claude',
      source: 'fixture',
    },
    {
      path: 'NOTICE',
      content: 'Historical upstream: https://github.com/hex/claude-council',
      source: 'fixture',
    },
    {
      path: 'docs/design.md',
      content: 'Generic charter, ledger and record contracts are public documentation.',
      source: 'fixture',
    },
  ];
  for (const entry of benign)
    invariant(scanEntry(entry).length === 0, `benign control was flagged: ${entry.path}`);
}

function gitPaths(args: string[]): string[] {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', root, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  invariant(
    result.exitCode === 0,
    `git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`,
  );
  return result.stdout.toString().split('\0').filter(Boolean);
}

function archiveEntries(): Entry[] {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'council-package-index-'));
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryRoot, 'index'),
  };

  try {
    for (const args of [
      ['read-tree', 'HEAD'],
      ['add', '--all', '--', '.'],
    ]) {
      const result = Bun.spawnSync({
        cmd: ['git', '-C', root, ...args],
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      invariant(
        result.exitCode === 0,
        `git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`,
      );
    }

    const treeResult = Bun.spawnSync({
      cmd: ['git', '-C', root, 'write-tree'],
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    invariant(
      treeResult.exitCode === 0,
      `git write-tree failed: ${treeResult.stderr.toString().trim()}`,
    );
    const tree = treeResult.stdout.toString().trim();
    invariant(/^[a-f0-9]{40,64}$/.test(tree), 'git write-tree returned an invalid object id');

    const result = Bun.spawnSync({
      cmd: ['git', '-C', root, 'archive', '--format=tar', tree],
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    invariant(result.exitCode === 0, `git archive failed: ${result.stderr.toString().trim()}`);

    const archive = new Uint8Array(result.stdout);
    const decoder = new TextDecoder();
    const entries: Entry[] = [];
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (start: number, end: number) =>
        decoder.decode(header.subarray(start, end)).replace(/\0.*$/s, '').trim();
      const name = field(0, 100);
      const prefix = field(345, 500);
      const path = prefix ? `${prefix}/${name}` : name;
      const sizeText = field(124, 136);
      const size = Number.parseInt(sizeText || '0', 8);
      invariant(Number.isSafeInteger(size) && size >= 0, `invalid tar size for ${path}`);
      const contentStart = offset + 512;
      const contentEnd = contentStart + size;
      invariant(contentEnd <= archive.length, `truncated tar entry: ${path}`);
      const type = header[156];
      if ((type === 0 || type === 48) && path) {
        const content = decoder.decode(archive.subarray(contentStart, contentEnd));
        if (!content.includes('\0')) entries.push({ path, content, source: 'package' });
      }
      offset = contentStart + Math.ceil(size / 512) * 512;
    }
    return entries;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function repositoryEntries(): Promise<Entry[]> {
  const tracked = gitPaths(['ls-files', '-z', '--cached']).sort();
  const entries: Entry[] = archiveEntries();
  for (const path of tracked) {
    const absolute = resolve(root, path);
    invariant(
      isAbsolute(absolute) &&
        (absolute === root || absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`)),
      `candidate escaped checkout: ${path}`,
    );
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const content = await Bun.file(absolute).text();
    if (content.includes('\0')) continue;
    entries.push({ path, content, source: 'tracked' });
  }
  return entries;
}

assertFixtureCoverage();
const findings = (await repositoryEntries())
  .flatMap(scanEntry)
  .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.kind.localeCompare(b.kind));

if (findings.length > 0) {
  console.error('Repository privacy gate failed:');
  for (const finding of findings) {
    console.error(
      `- ${finding.source} ${finding.path}:${finding.line} [${finding.kind}] ${finding.evidence}`,
    );
  }
  process.exit(1);
}

console.log(
  'Repository privacy gate passed: tracked working-tree files and the canonical git-archive package contain no forbidden private material.',
);
