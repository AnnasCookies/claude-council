import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DRAFT_BYTES, readDraft } from '../../src/modes/audience/draft';
import {
  MAX_PERSONAS,
  defaultPersonaDescription,
  parsePersonaFile,
  parsePersonaList,
  readPersonaFile,
} from '../../src/modes/audience/personas';
import { sha256Hex } from '../../src/substrate';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'convene-audience-input-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('persona lists', () => {
  test('keeps the supplied order and gives a bare name the default brief', () => {
    const personas = parsePersonaList('ops-manager, new-starter:Three weeks into the job, sceptic');
    expect(personas.map((persona) => persona.name)).toEqual([
      'ops-manager',
      'new-starter',
      'sceptic',
    ]);
    expect(personas[0]?.description).toBe(defaultPersonaDescription('ops-manager'));
    expect(personas[1]?.description).toBe('Three weeks into the job');
    expect(personas[2]?.description).toBe(defaultPersonaDescription('sceptic'));
  });

  test('refuses an empty list, a duplicate name, an unusable name and a crowd', () => {
    expect(() => parsePersonaList('   ')).toThrow(/at least one persona/);
    expect(() => parsePersonaList('sceptic,sceptic')).toThrow(/Duplicate persona: sceptic/);
    expect(() => parsePersonaList('ops manager')).toThrow();
    const crowd = Array.from({ length: MAX_PERSONAS + 1 }, (_, index) => `reader-${index}`);
    expect(() => parsePersonaList(crowd.join(','))).toThrow(/At most 24 personas/);
    expect(parsePersonaList(crowd.slice(0, MAX_PERSONAS).join(','))).toHaveLength(MAX_PERSONAS);
  });

  test('a persona file is a JSON array of name and description', () => {
    expect(
      parsePersonaFile(
        JSON.stringify([{ name: 'ops-manager', description: 'Runs the rota, reads on a phone.' }]),
      ),
    ).toEqual([{ name: 'ops-manager', description: 'Runs the rota, reads on a phone.' }]);
    expect(() => parsePersonaFile('not json')).toThrow(/JSON array/);
    expect(() => parsePersonaFile(JSON.stringify([{ name: 'ops-manager' }]))).toThrow();
    expect(() => parsePersonaFile(JSON.stringify([]))).toThrow(/At least one persona/);
  });

  test('reads a persona file from disk, relative to the working directory', async () => {
    await withDirectory(async (directory) => {
      await writeFile(
        join(directory, 'readers.json'),
        JSON.stringify([{ name: 'sceptic', description: 'Assumes the worst, politely.' }]),
      );
      expect(await readPersonaFile('readers.json', directory)).toEqual([
        { name: 'sceptic', description: 'Assumes the worst, politely.' },
      ]);
      await expect(readPersonaFile('absent.json', directory)).rejects.toThrow(/No persona file/);
      await expect(readPersonaFile('.', directory)).rejects.toThrow(/is not a file/);
    });
  });
});

describe('the draft', () => {
  test('hashes the bytes on disk and keeps the path as the caller wrote it', async () => {
    await withDirectory(async (directory) => {
      const text = '# Announcement\n\nThe rota changes on Monday.\n';
      await writeFile(join(directory, 'announcement.md'), text);
      const draft = await readDraft('announcement.md', directory);
      expect(draft.path).toBe('announcement.md');
      expect(draft.text).toBe(text);
      expect(draft.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(draft.sha256).toBe(sha256Hex(new TextEncoder().encode(text)));
    });
  });

  test('a changed draft is a different hash', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, 'first.md'), 'The rota changes on Monday.\n');
      await writeFile(join(directory, 'second.md'), 'The rota changes on Tuesday.\n');
      const first = await readDraft('first.md', directory);
      const second = await readDraft('second.md', directory);
      expect(first.sha256).not.toBe(second.sha256);
      expect(await readDraft('first.md', directory)).toEqual(first);
    });
  });

  test('refuses a missing file, a directory, an empty draft and an oversize one', async () => {
    await withDirectory(async (directory) => {
      await expect(readDraft('absent.md', directory)).rejects.toThrow(
        /No draft found at absent.md/,
      );
      await expect(readDraft('.', directory)).rejects.toThrow(/is not a file/);
      await expect(readDraft('   ', directory)).rejects.toThrow(/needs a path/);
      await writeFile(join(directory, 'blank.md'), '   \n');
      await expect(readDraft('blank.md', directory)).rejects.toThrow(/is empty/);
      await writeFile(join(directory, 'huge.md'), 'x'.repeat(MAX_DRAFT_BYTES + 1));
      await expect(readDraft('huge.md', directory)).rejects.toThrow(/the limit is 262144 bytes/);
    });
  });
});
