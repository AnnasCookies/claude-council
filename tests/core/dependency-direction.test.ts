import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const sourceRoot = resolve(import.meta.dir, '../../src');
const substrateRoot = join(sourceRoot, 'substrate');
const modesRoot = join(sourceRoot, 'modes');
const substrateIndex = join(substrateRoot, 'index.ts');
const cliEntry = join(sourceRoot, 'cli.ts');

async function typescriptFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

const RELATIVE_SPECIFIER = /(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g;

function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveSpecifier(file: string, specifier: string): string {
  const target = resolve(dirname(file), specifier);
  if (target.endsWith('.ts') || target.endsWith('.json')) return target;
  if (existsSync(`${target}.ts`)) return `${target}.ts`;
  return join(target, 'index.ts');
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function importsOf(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  return relativeSpecifiers(source).map((specifier) => resolveSpecifier(file, specifier));
}

describe('dependency direction', () => {
  test('the substrate exists', async () => {
    expect((await typescriptFiles(substrateRoot)).length).toBeGreaterThan(0);
  });

  test('the substrate never imports modes or the CLI entry', async () => {
    const violations: string[] = [];
    for (const file of await typescriptFiles(substrateRoot)) {
      for (const target of await importsOf(file)) {
        if (isInside(target, modesRoot) || target === cliEntry) {
          violations.push(`${file} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('modes import the substrate only through its index', async () => {
    const violations: string[] = [];
    for (const file of await typescriptFiles(modesRoot)) {
      for (const target of await importsOf(file)) {
        if (isInside(target, substrateRoot) && target !== substrateIndex) {
          violations.push(`${file} -> ${target}`);
        }
        if (target === cliEntry) violations.push(`${file} -> ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('one mode never imports another mode', async () => {
    const violations: string[] = [];
    for (const file of await typescriptFiles(modesRoot)) {
      const owner = dirname(file);
      if (owner === modesRoot) continue;
      for (const target of await importsOf(file)) {
        if (!isInside(target, modesRoot)) continue;
        const targetOwner = dirname(target);
        if (targetOwner !== modesRoot && targetOwner !== owner && !isInside(target, owner)) {
          violations.push(`${file} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
