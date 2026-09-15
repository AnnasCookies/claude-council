import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CATALOGUE_LENSES,
  catalogueLens,
  ideationRegistry,
  ideationSeats,
  lensSlug,
  loadPersonaLenses,
  parseModelOverrides,
  resolveSeatLenses,
} from '../../src/modes/ideation/seats';
import { PanelLensSchema, type ModelRegistry } from '../../src/substrate';

const registry: ModelRegistry = {
  anthropic: { primary: 'anthropic-pro', fallbacks: [], transport: 'cli' },
  openai: { primary: 'openai-pro', fallbacks: [], transport: 'subscription-cli' },
  xai: {
    primary: 'xai-pro',
    fallbacks: ['xai-lite', 'xai-older'],
    transport: 'subscription-cli',
    alternateTransports: ['http'],
  },
  google: { primary: 'google-pro', fallbacks: ['google-lite'], transport: 'subscription-cli' },
  deepseek: { primary: 'deepseek-pro', fallbacks: ['deepseek-lite'], transport: 'http' },
  moonshot: { primary: 'moonshot-pro', fallbacks: [], transport: 'http' },
};

describe('ideation lenses', () => {
  test('the governed catalogue becomes twelve panel-safe lenses', () => {
    expect(CATALOGUE_LENSES.map((lens) => lens.name)).toEqual([
      'strategist',
      'architect',
      'designer',
      'researcher',
      'maintainer',
      'operator',
      'security',
      'privacy',
      'systems',
      'performance',
      'critic',
      'devils-advocate',
    ]);
    // The panel's lens-name rule allows no apostrophe and no space, so the catalogue's
    // "devil's advocate" could not be a seat at all without the slug.
    for (const lens of CATALOGUE_LENSES) expect(PanelLensSchema.parse(lens)).toEqual(lens);
    expect(CATALOGUE_LENSES[11]?.description).toContain('counter-case');
  });

  test('a lens can be named by its catalogue spelling or by its slug, and nothing else', () => {
    expect(catalogueLens("devil's advocate").name).toBe('devils-advocate');
    expect(catalogueLens('devils-advocate').name).toBe('devils-advocate');
    expect(catalogueLens('SECURITY').name).toBe('security');
    expect(() => catalogueLens('vibes')).toThrow(/Unknown lens: vibes.*strategist, architect/s);
    expect(() => lensSlug('!!!')).toThrow(/must contain letters or digits/);
  });

  test('the catalogue fills the room, cycling with a suffix when the room is larger', () => {
    expect(resolveSeatLenses({ seats: 3, named: null }).map((lens) => lens.name)).toEqual([
      'strategist',
      'architect',
      'designer',
    ]);
    const cycled = resolveSeatLenses({ seats: 14, named: null });
    expect(cycled).toHaveLength(14);
    expect(cycled.map((lens) => lens.name).slice(11)).toEqual([
      'devils-advocate',
      'strategist-2',
      'architect-2',
    ]);
    expect(cycled[12]?.description).toBe(CATALOGUE_LENSES[0]?.description);
    expect(new Set(cycled.map((lens) => lens.name)).size).toBe(14);
  });

  test('a named list is taken exactly, and a room smaller than the list is a usage error', () => {
    const named = [catalogueLens('security'), catalogueLens('operator')];
    expect(resolveSeatLenses({ seats: 4, named }).map((lens) => lens.name)).toEqual([
      'security',
      'operator',
      'security-2',
      'operator-2',
    ]);
    expect(() => resolveSeatLenses({ seats: 1, named })).toThrow(
      /--seats 1 is fewer than the 2 lenses named/,
    );
    expect(() => resolveSeatLenses({ seats: 0, named: null })).toThrow();
  });

  test('a persona whose slug collides with a cycle suffix is a usage error', async () => {
    // The pool is distinct, so the old check passed; the collision only appears once `security`
    // comes round a second time and is seated as `security-2` beside the persona of that name.
    const named = [
      PanelLensSchema.parse({ name: 'security', description: 'Look for the attack path.' }),
      PanelLensSchema.parse({ name: 'security-2', description: 'Look for the second one.' }),
    ];
    expect(resolveSeatLenses({ seats: 2, named }).map((lens) => lens.name)).toEqual([
      'security',
      'security-2',
    ]);
    expect(() => resolveSeatLenses({ seats: 4, named })).toThrow(/Duplicate lens name: security-2/);
    // The personas a caller would actually write, through the same slugging the loader uses.
    const root = await mkdtemp(join(tmpdir(), 'council-persona-cycle-'));
    try {
      const file = join(root, 'personas.json');
      await writeFile(
        file,
        JSON.stringify([
          { name: 'Security', description: 'Look for the attack path.' },
          { name: 'Security 2', description: 'Look for the second one.' },
        ]),
      );
      const lenses = await loadPersonaLenses(file, root);
      expect(lenses.map((lens) => lens.name)).toEqual(['security', 'security-2']);
      expect(() => resolveSeatLenses({ seats: 4, named: lenses })).toThrow(
        /Duplicate lens name: security-2/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a persona file supplies the lenses, validated and slugged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-personas-'));
    try {
      const good = join(root, 'personas.json');
      await writeFile(
        good,
        JSON.stringify([
          { name: 'Ops manager', description: 'Runs the rota and carries the pager.' },
          { name: 'New starter', description: 'Joined a fortnight ago and reads everything.' },
        ]),
      );
      const lenses = await loadPersonaLenses(good, root);
      expect(lenses.map((lens) => lens.name)).toEqual(['ops-manager', 'new-starter']);
      expect(lenses[0]?.description).toContain('pager');

      const duplicate = join(root, 'duplicate.json');
      await writeFile(
        duplicate,
        JSON.stringify([
          { name: 'Ops manager', description: 'One.' },
          { name: 'ops-manager', description: 'Two.' },
        ]),
      );
      await expect(loadPersonaLenses(duplicate, root)).rejects.toThrow(
        /Duplicate lens name: ops-manager/,
      );

      const malformed = join(root, 'malformed.json');
      await writeFile(malformed, '{"personas":[]}');
      await expect(loadPersonaLenses(malformed, root)).rejects.toThrow();
      await expect(loadPersonaLenses('missing.json', root)).rejects.toThrow(
        /Unable to read the persona list/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ideation models', () => {
  test('the first fallback is the cheap seat, and a family without one stays on its primary', () => {
    const cheap = ideationRegistry(registry, new Map());
    expect(cheap.xai.primary).toBe('xai-lite');
    expect(cheap.google.primary).toBe('google-lite');
    expect(cheap.deepseek.primary).toBe('deepseek-lite');
    expect(cheap.anthropic.primary).toBe('anthropic-pro');
    expect(cheap.moonshot.primary).toBe('moonshot-pro');
    // The dearer primary is dropped from the fallbacks: identity verification must not accept it
    // and quietly bill the model this mode exists to avoid.
    expect(cheap.xai.fallbacks).toEqual(['xai-older']);
    expect(cheap.google.fallbacks).toEqual([]);
    expect(cheap.xai.transport).toBe('subscription-cli');
    expect(cheap.xai.alternateTransports).toEqual(['http']);
  });

  test('--models overrides a family and is validated', () => {
    const overrides = parseModelOverrides('anthropic=anthropic-mini,google=google-nano');
    expect([...overrides.entries()]).toEqual([
      ['anthropic', 'anthropic-mini'],
      ['google', 'google-nano'],
    ]);
    const pinned = ideationRegistry(registry, overrides);
    expect(pinned.anthropic.primary).toBe('anthropic-mini');
    expect(pinned.google.primary).toBe('google-nano');
    expect(pinned.google.fallbacks).toEqual(['google-lite']);
    expect(parseModelOverrides(undefined).size).toBe(0);
    expect(() => parseModelOverrides('anthropic')).toThrow(/<family>=<model>/);
    expect(() => parseModelOverrides('nobody=x')).toThrow();
    expect(() => parseModelOverrides('xai=a,xai=b')).toThrow(/names xai twice/);
  });

  test('seats spread round-robin over the chosen families on the cheap models', () => {
    const seats = ideationSeats({
      families: ['xai', 'google'],
      lenses: resolveSeatLenses({ seats: 4, named: null }),
      registry: ideationRegistry(registry, new Map()),
    });
    expect(seats.map((seat) => seat.id)).toEqual([
      'xai/xai-lite#strategist',
      'google/google-lite#architect',
      'xai/xai-lite#designer',
      'google/google-lite#researcher',
    ]);
    expect(seats.map((seat) => seat.model)).toEqual([
      'xai-lite',
      'google-lite',
      'xai-lite',
      'google-lite',
    ]);
  });
});
