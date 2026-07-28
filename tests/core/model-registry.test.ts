import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModelRegistry } from '../../src/models/registry';

async function withRegistryOverride<T>(
  override: unknown,
  assertion: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-council-registry-'));
  const path = join(directory, 'registry.json');

  try {
    await Bun.write(path, JSON.stringify(override));
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
    expect(registry.xai.primary).toBe('grok-4.5');
    expect(registry.google.primary).toBe('gemini-3.1-pro-preview');
    expect(registry.google.fallbacks).toEqual(['gemini-3.6-flash']);
    expect(registry.deepseek.primary).toBe('deepseek-v4-pro');
    expect(registry.deepseek.fallbacks).toEqual(['deepseek-v4-flash']);
    expect(registry.moonshot.primary).toBe('kimi-k3');
  });

  test('merges and reparses recognised provider overrides', async () => {
    await withRegistryOverride(
      {
        google: { primary: 'gemini-3.6-flash', fallbacks: [] },
      },
      async (path) => {
        const registry = await loadModelRegistry(path);

        expect(registry.google).toEqual({
          primary: 'gemini-3.6-flash',
          fallbacks: [],
          transport: 'http',
        });
        expect(registry.anthropic.primary).toBe('claude-opus-5');
      },
    );
  });

  test('ignores unknown provider keys rather than admitting them', async () => {
    await withRegistryOverride(
      {
        openai: { primary: 'gpt-5.6-sol-pinned' },
        unrecognised: { primary: 42, transport: 'socket' },
      },
      async (path) => {
        const registry = await loadModelRegistry(path);

        expect(registry.openai.primary).toBe('gpt-5.6-sol-pinned');
        expect(Object.hasOwn(registry, 'unrecognised')).toBe(false);
      },
    );
  });

  test('rejects an invalid recognised provider override after merging', async () => {
    await withRegistryOverride({ xai: { transport: 'socket' } }, async (path) => {
      await expect(loadModelRegistry(path)).rejects.toThrow();
    });
  });
});
