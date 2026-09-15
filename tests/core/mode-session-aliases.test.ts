import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModeSessionIdSchema,
  ModeSessionKeySchema,
  ModeSessionStore,
} from '../../src/substrate/records/mode-sessions';

const NOW = '2026-09-15T10:00:00.000Z';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-mode-aliases-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('mode session aliases', () => {
  test('binds a harness key to a minted id once and finds it again', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      expect(await store.lookupAlias('advisor', 'claude:6a07f29b')).toBeUndefined();
      const first = await store.bindAlias('advisor', 'claude:6a07f29b', 'ad', NOW);
      expect(first.created).toBe(true);
      expect(ModeSessionIdSchema.safeParse(first.sessionId).success).toBe(true);
      expect(first.sessionId.startsWith('ad-2026-09-15-')).toBe(true);
      const again = await store.bindAlias('advisor', 'claude:6a07f29b', 'ad', NOW);
      expect(again).toEqual({ sessionId: first.sessionId, created: false });
      expect(await store.lookupAlias('advisor', 'claude:6a07f29b')).toBe(first.sessionId);
      expect(store.aliasPath('advisor')).toBe(
        join(root, 'general', 'modes', 'advisor', 'index.json'),
      );
      expect(await Bun.file(store.aliasPath('advisor')).json()).toEqual({
        schemaVersion: 1,
        aliases: { 'claude:6a07f29b': first.sessionId },
      });
      // The atomic write leaves no temporary file behind and the lock file is cleaned up.
      expect(await readdir(join(root, 'general', 'modes', 'advisor'))).toEqual(['index.json']);
    });
  });

  test('keeps keys apart per mode and per scope', async () => {
    await withRoot(async (root) => {
      const general = ModeSessionStore.open(root);
      const project = ModeSessionStore.open(root, { scope: 'project', projectId: 'alpha' });
      const a = await general.bindAlias('advisor', 'k', 'ad', NOW);
      const b = await general.bindAlias('ideation', 'k', 'id', NOW);
      const c = await project.bindAlias('advisor', 'k', 'ad', NOW);
      expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
      expect(project.aliasPath('advisor')).toBe(
        join(root, 'projects', 'alpha', 'modes', 'advisor', 'index.json'),
      );
    });
  });

  test('refuses an unusable key, a bad prefix and a corrupt index before writing', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      expect(ModeSessionKeySchema.safeParse('').success).toBe(false);
      expect(ModeSessionKeySchema.safeParse('a\u0000b').success).toBe(false);
      expect(ModeSessionKeySchema.safeParse('x'.repeat(257)).success).toBe(false);
      expect(ModeSessionKeySchema.safeParse('6a07f29b-a0a5-4f23-91ab-2b6b2dbee514').success).toBe(
        true,
      );
      await expect(store.bindAlias('advisor', '', 'ad', NOW)).rejects.toThrow();
      await expect(store.bindAlias('advisor', 'k', 'ADVISOR', NOW)).rejects.toThrow();
      const corrupt = '{"schemaVersion":1,"aliases":{"k":"not-an-id"}}';
      await Bun.write(store.aliasPath('advisor'), corrupt);
      await expect(store.lookupAlias('advisor', 'k')).rejects.toThrow();
      await expect(store.bindAlias('advisor', 'other', 'ad', NOW)).rejects.toThrow();
      expect(await Bun.file(store.aliasPath('advisor')).text()).toBe(corrupt);
    });
  });

  test('a key named after an Object property is read from the index, never the prototype', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      // A harness session key is opaque, so nothing stops one being `__proto__` or `constructor`.
      // Indexing the parsed object without an own-property check answered both from
      // `Object.prototype`, handing back an object or a function typed as a session id.
      for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect([key, await store.lookupAlias('advisor', key)]).toEqual([key, undefined]);
      }
      const bound = new Map<string, string>();
      for (const key of ['__proto__', 'constructor', 'claude:ordinary']) {
        bound.set(key, (await store.bindAlias('advisor', key, 'ad', NOW)).sessionId);
      }
      expect(new Set(bound.values()).size).toBe(3);
      for (const [key, sessionId] of bound) {
        // Binding stays idempotent for these keys too: a key the index could not read back would
        // mint a fresh id on every call and split one harness session across many logs.
        expect([key, await store.lookupAlias('advisor', key)]).toEqual([key, sessionId]);
        expect([key, await store.bindAlias('advisor', key, 'ad', NOW)]).toEqual([
          key,
          { sessionId, created: false },
        ]);
      }
      expect(await store.lookupAlias('advisor', 'toString')).toBeUndefined();
    });
  });

  test('serialises concurrent binds of one new key to a single id', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.bindAlias('advisor', 'race', 'ad', NOW)),
      );
      expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    });
  });
});
