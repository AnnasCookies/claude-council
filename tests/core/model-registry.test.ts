import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  loadModelRegistry,
  loadModelRegistryWithProvenance,
  resolveModelRegistry,
} from '../../src/models/registry';

async function withRegistryOverride<T>(
  override: unknown,
  assertion: (path: string) => Promise<T>,
): Promise<T> {
  return withRegistryOverrideText(JSON.stringify(override), assertion);
}

async function withRegistryOverrideText<T>(
  contents: string,
  assertion: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-council-registry-'));
  const path = join(directory, 'models.json');

  try {
    await Bun.write(path, contents);
    return await assertion(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('model registry', () => {
  test('loads approved exact routes', async () => {
    const registry = await loadModelRegistry();

    expect(registry.anthropic.primary).toBe('claude-opus-5');
    expect(registry.openai.primary).toBe('gpt-5.6-sol');
    expect(registry.xai.primary).toBe('grok-4.6');
    expect(registry.xai.fallbacks).toEqual(['grok-4.5']);
    expect(registry.google.primary).toBe('gemini-3.1-pro-high');
    expect(registry.google.fallbacks).toEqual(['gemini-3.6-flash-high']);
    expect(registry.openai.transport).toBe('subscription-cli');
    expect(registry.google.transport).toBe('subscription-cli');
    expect(registry.deepseek.primary).toBe('deepseek-v4-pro');
    expect(registry.deepseek.fallbacks).toEqual(['deepseek-v4-flash']);
    expect(registry.moonshot.primary).toBe('kimi-k3');
  });

  test('merges an override for one family without changing the other routes', async () => {
    const builtIn = await loadModelRegistry();
    await withRegistryOverride({ xai: { primary: 'grok-5' } }, async (path) => {
      const registry = await loadModelRegistry(path);

      expect(registry.xai).toEqual({ ...builtIn.xai, primary: 'grok-5' });
      expect(registry.xai.alternateTransports).toEqual(['subscription-cli']);
      expect(registry.anthropic).toEqual(builtIn.anthropic);
      expect(registry.openai).toEqual(builtIn.openai);
      expect(registry.google).toEqual(builtIn.google);
      expect(registry.deepseek).toEqual(builtIn.deepseek);
      expect(registry.moonshot).toEqual(builtIn.moonshot);
    });
  });

  test('rejects an unknown family and names both the file and offending key', async () => {
    await withRegistryOverride(
      {
        openai: { primary: 'gpt-5.6-sol-pinned' },
        unrecognised: { primary: 42, transport: 'socket' },
      },
      async (path) => {
        const error = await loadModelRegistry(path).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error('Expected registry loading to fail');
        expect(error.message).toContain(resolve(path));
        expect(error.message).toContain('unrecognised');
      },
    );
  });

  test('rejects malformed JSON and names the override file', async () => {
    await withRegistryOverrideText('{"xai":{"primary":"grok-5"}', async (path) => {
      const error = await loadModelRegistry(path).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected registry loading to fail');
      expect(error.message).toContain(resolve(path));
      expect(error.message).toContain('Invalid model registry override');
    });
  });

  test('reports the exact override SHA-256 and per-route provenance', async () => {
    const contents = '{"xai":{"primary":"grok-5"}}\n';
    await withRegistryOverrideText(contents, async (path) => {
      const loaded = await loadModelRegistryWithProvenance(path);

      expect(loaded.provenance).toEqual({
        kind: 'override',
        overridePath: resolve(path),
        overrideSha256: createHash('sha256').update(contents).digest('hex'),
        routes: {
          anthropic: 'built-in',
          openai: 'built-in',
          xai: 'override',
          google: 'built-in',
          deepseek: 'built-in',
          moonshot: 'built-in',
        },
      });
    });
  });

  test('prefers --registry equivalent input over records-root and home defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-council-registry-precedence-'));
    const recordsRoot = join(directory, 'records');
    const home = join(directory, 'home');
    const homeRegistryDirectory = join(home, '.claude', 'council');
    const explicitPath = join(directory, 'explicit-models.json');

    try {
      await mkdir(recordsRoot, { recursive: true });
      await mkdir(homeRegistryDirectory, { recursive: true });
      await Bun.write(join(recordsRoot, 'models.json'), '{"xai":{"primary":"records-grok"}}');
      await Bun.write(
        join(homeRegistryDirectory, 'models.json'),
        '{"xai":{"primary":"home-grok"}}',
      );
      await Bun.write(explicitPath, '{"xai":{"primary":"explicit-grok"}}');

      const fromRecordsRoot = await resolveModelRegistry({
        recordsRoot,
        cwd: directory,
        env: { HOME: home },
      });
      expect(fromRecordsRoot.registry.xai.primary).toBe('records-grok');
      expect(fromRecordsRoot.provenance).toMatchObject({
        kind: 'override',
        overridePath: resolve(recordsRoot, 'models.json'),
      });

      const fromExplicitPath = await resolveModelRegistry({
        overridePath: explicitPath,
        recordsRoot,
        cwd: directory,
        env: { HOME: home },
      });
      expect(fromExplicitPath.registry.xai.primary).toBe('explicit-grok');
      expect(fromExplicitPath.provenance).toMatchObject({
        kind: 'override',
        overridePath: resolve(explicitPath),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('falls back to the user-level registry when the records root has no override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-council-registry-home-'));
    const recordsRoot = join(directory, 'records');
    const home = join(directory, 'home');
    const homeRegistryDirectory = join(home, '.claude', 'council');

    try {
      await mkdir(recordsRoot, { recursive: true });
      await mkdir(homeRegistryDirectory, { recursive: true });
      await Bun.write(
        join(homeRegistryDirectory, 'models.json'),
        '{"xai":{"primary":"home-grok"}}',
      );

      const loaded = await resolveModelRegistry({
        recordsRoot,
        cwd: directory,
        env: { HOME: home },
      });

      expect(loaded.registry.xai.primary).toBe('home-grok');
      expect(loaded.provenance).toMatchObject({
        kind: 'override',
        overridePath: resolve(homeRegistryDirectory, 'models.json'),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects an invalid recognised provider override after merging', async () => {
    await withRegistryOverride({ xai: { transport: 'socket' } }, async (path) => {
      await expect(loadModelRegistry(path)).rejects.toThrow(resolve(path));
    });
  });
});
