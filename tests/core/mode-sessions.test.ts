import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModeSessionIdSchema,
  ModeSessionStore,
  newModeSessionId,
  type ModeSessionEvent,
} from '../../src/substrate/records/mode-sessions';

const NOW = '2026-09-15T10:00:00.000Z';

function event(kind: string, data: unknown, at = NOW): ModeSessionEvent {
  return { at, kind, data };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-mode-sessions-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('mode session ids', () => {
  test('are prefix, day and six hex characters', () => {
    const id = newModeSessionId('ad', NOW);
    expect(id).toMatch(/^ad-2026-09-15-[a-f0-9]{6}$/);
    expect(ModeSessionIdSchema.safeParse(id).success).toBe(true);
    expect(newModeSessionId('ad', NOW)).not.toBe(id);
    expect(() => newModeSessionId('AD', NOW)).toThrow();
    expect(() => newModeSessionId('advisor-x', NOW)).toThrow();
    expect(() => newModeSessionId('ad', 'today')).toThrow();
    expect(ModeSessionIdSchema.safeParse('../etc').success).toBe(false);
    expect(ModeSessionIdSchema.safeParse('ad-2026-09-15-ZZZZZZ').success).toBe(false);
  });
});

describe('ModeSessionStore', () => {
  test('appends events under the scope directory and reads them back in order', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('ad', NOW);
      expect(await store.exists('advisor', id)).toBe(false);
      expect(store.recordPath('advisor', id)).toBe(`general/modes/advisor/${id}.jsonl`);
      expect(store.absolutePath('advisor', id)).toBe(
        join(root, 'general', 'modes', 'advisor', `${id}.jsonl`),
      );

      const first = await store.append('advisor', id, event('note', { text: 'one' }));
      expect(first).toEqual({ paths: [store.absolutePath('advisor', id)] });
      await store.append('advisor', id, event('note', { text: 'two' }, '2026-09-15T10:00:01.000Z'));
      await store.append('advisor', id, event('heed', { note: 'n-1', heeded: 'yes' }));

      expect(await store.exists('advisor', id)).toBe(true);
      const events = await store.read('advisor', id);
      expect(events.map((entry) => entry.kind)).toEqual(['note', 'note', 'heed']);
      expect(events[1]).toEqual({
        at: '2026-09-15T10:00:01.000Z',
        kind: 'note',
        data: { text: 'two' },
      });
      const text = await Bun.file(store.absolutePath('advisor', id)).text();
      expect(text.split('\n')).toHaveLength(4);
      expect(text.endsWith('\n')).toBe(true);
      // The atomic write leaves no temporary file behind.
      expect(await readdir(join(root, 'general', 'modes', 'advisor'))).toEqual([`${id}.jsonl`]);
    });
  });

  test('scopes project sessions under the project directory', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root, { scope: 'project', projectId: 'alpha' });
      const id = store.newSessionId('id', NOW);
      await store.append('ideation', id, event('pass', { n: 1 }));
      expect(store.recordPath('ideation', id)).toBe(`projects/alpha/modes/ideation/${id}.jsonl`);
      expect(
        await Bun.file(
          join(root, 'projects', 'alpha', 'modes', 'ideation', `${id}.jsonl`),
        ).exists(),
      ).toBe(true);
      expect(() => ModeSessionStore.open(root, { scope: 'project', projectId: '../x' })).toThrow();
    });
  });

  test('validates the session id, mode and event before touching the disk', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('ad', NOW);
      await expect(store.append('advisor', '../escape', event('note', {}))).rejects.toThrow();
      await expect(store.append('Advisor', id, event('note', {}))).rejects.toThrow();
      await expect(store.append('advisor', id, event('Note!', {}))).rejects.toThrow();
      await expect(
        store.append('advisor', id, { at: 'yesterday', kind: 'note', data: {} }),
      ).rejects.toThrow();
      expect(existsSync(join(root, 'general'))).toBe(false);
      await expect(store.read('advisor', id)).rejects.toThrow(/Unknown mode session/);
    });
  });

  test('refuses data that cannot round-trip through JSON, before the file is touched', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('ad', NOW);
      // `undefined` used to pass the input parse, then vanish from the written line and fail the
      // store's own read-back — a file-level error for a caller-level mistake.
      await expect(store.append('advisor', id, event('note', undefined))).rejects.toThrow(
        /JSON-serialisable data/,
      );
      expect(existsSync(join(root, 'general'))).toBe(false);
      await store.append('advisor', id, event('note', null));
      expect((await store.read('advisor', id))[0]).toEqual({ at: NOW, kind: 'note', data: null });
    });
  });

  test('refuses to extend a log it cannot read back', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('ad', NOW);
      await store.append('advisor', id, event('note', { text: 'one' }));
      const path = store.absolutePath('advisor', id);
      const intact = await Bun.file(path).text();
      await Bun.write(path, `${intact}{"at":"${NOW}","kind":"note"`);
      await expect(store.append('advisor', id, event('note', { text: 'two' }))).rejects.toThrow(
        /Torn mode session log|Invalid mode session event/,
      );
      await expect(store.read('advisor', id)).rejects.toThrow();
      expect(await Bun.file(path).text()).toBe(`${intact}{"at":"${NOW}","kind":"note"`);
    });
  });

  test('appendDerived decides from the log under the same lock that writes it', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('fo', NOW);
      // Each caller numbers its own event from the log it was handed. Outside the lock ten
      // overlapping callers would all read an empty log and all write event one.
      await Promise.all(
        Array.from({ length: 10 }, () =>
          store.appendDerived('forum', id, (events) => event('turn', { n: events.length + 1 })),
        ),
      );
      const events = await store.read('forum', id);
      expect(events.map((entry) => (entry.data as { n: number }).n)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      // A derivation that decides the log already settled the question writes nothing at all.
      expect(await store.appendDerived('forum', id, () => null)).toEqual({ paths: [] });
      expect(await store.read('forum', id)).toHaveLength(10);
    });
  });

  test('publishes a derivation of several events in one write, or none of them', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('id', NOW);
      // Ten callers, each appending a pair. A caller that took the lock between somebody else's
      // two lines would see a half-written step; the pairs below prove nobody can.
      await Promise.all(
        Array.from({ length: 10 }, () =>
          store.appendDerived('ideation', id, (events) => {
            const n = events.length / 2 + 1;
            return [event('pass', { n }), event('cluster', { n })];
          }),
        ),
      );
      const events = await store.read('ideation', id);
      expect(events.map((entry) => entry.kind)).toEqual(
        Array.from({ length: 10 }, () => ['pass', 'cluster']).flat(),
      );
      expect(events.map((entry) => (entry.data as { n: number }).n)).toEqual([
        1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
      ]);

      // A derivation that throws writes none of its events, not the ones it had already built.
      await expect(
        store.appendDerived('ideation', id, () => {
          throw new Error('the log refuses this step');
        }),
      ).rejects.toThrow(/the log refuses this step/);
      expect(await store.read('ideation', id)).toHaveLength(20);
      // An empty list says the same thing as null: nothing to add.
      expect(await store.appendDerived('ideation', id, () => [])).toEqual({ paths: [] });
      expect(await store.read('ideation', id)).toHaveLength(20);
    });
  });

  test('serialises concurrent appends so every event lands once', async () => {
    await withRoot(async (root) => {
      const store = ModeSessionStore.open(root);
      const id = store.newSessionId('fo', NOW);
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          store.append('forum', id, event('position', { seat: index })),
        ),
      );
      const events = await store.read('forum', id);
      expect(events).toHaveLength(10);
      const seen = events
        .map((entry) => (entry.data as { seat: number }).seat)
        .sort((a, b) => a - b);
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });
});
