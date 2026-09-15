import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { MAX_TRIAGE_BATCH, parseTriageBatch, readTriageBatch } from '../../src/modes/triage/items';

describe('the triage batch file', () => {
  test('parses a batch and trims each item', () => {
    expect(
      parseTriageBatch(
        JSON.stringify([
          { id: 'c1', text: '  Nit: trailing whitespace.  ' },
          { id: 'c2', text: 'This leaks a key into the log.' },
        ]),
        'comments.json',
      ),
    ).toEqual([
      { id: 'c1', text: 'Nit: trailing whitespace.' },
      { id: 'c2', text: 'This leaks a key into the log.' },
    ]);
  });

  test('refuses anything that is not a batch of items, naming the file', () => {
    const cases: [string, RegExp][] = [
      ['{ not json', /not valid JSON/],
      ['{"items":[]}', /Expected a JSON array/],
      ['[]', /at least one item/],
      ['[{"id":"c1"}]', /text/],
      ['[{"id":"c1","text":""}]', /text/],
      ['[{"id":"","text":"x"}]', /id/],
      ['[{"id":"c1","text":"x","extra":1}]', /Expected a JSON array/],
      ['[{"id":"c1","text":"x"},{"id":"c1","text":"y"}]', /Duplicate item id: c1/],
    ];
    for (const [raw, message] of cases) {
      expect(() => parseTriageBatch(raw, 'comments.json')).toThrow(message);
      expect(() => parseTriageBatch(raw, 'comments.json')).toThrow(/comments\.json/);
    }
  });

  test('a batch is bounded so one file cannot dial a provider for ever', () => {
    const items = Array.from({ length: MAX_TRIAGE_BATCH + 1 }, (_, index) => ({
      id: `c${index}`,
      text: 'x',
    }));
    expect(() => parseTriageBatch(JSON.stringify(items), 'comments.json')).toThrow(
      new RegExp(`at most ${MAX_TRIAGE_BATCH} items`),
    );
    expect(parseTriageBatch(JSON.stringify(items.slice(0, MAX_TRIAGE_BATCH)), 'x')).toHaveLength(
      MAX_TRIAGE_BATCH,
    );
  });

  test('reads a batch from disk and says when the file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-triage-items-'));
    try {
      const path = join(root, 'comments.json');
      await writeFile(path, JSON.stringify([{ id: 'c1', text: 'Looks fine.' }]), 'utf8');
      expect(await readTriageBatch(path)).toEqual([{ id: 'c1', text: 'Looks fine.' }]);
      await expect(readTriageBatch(join(root, 'missing.json'))).rejects.toThrow(
        /Triage batch file not found/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
