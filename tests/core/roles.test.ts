import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { RoleLensSchema } from '../../src/domain/schemas';
import {
  assignLenses,
  RoleAssignmentSchema,
  roleCatalogue,
  selectLenses,
  type MotionMetadata,
} from '../../src/roles/allocator';

const ARCHITECTURE_MOTION = {
  domains: ['architecture'],
  impact: 'high',
  contested: true,
} satisfies MotionMetadata;

const SEAT_IDS = ['anthropic', 'openai', 'xai', 'google', 'deepseek'];

function roleFixture() {
  return selectLenses(ARCHITECTURE_MOTION, SEAT_IDS.length);
}

describe('role catalogue and selection', () => {
  test('ships the governed catalogue through the shared role schema', () => {
    expect(z.array(RoleLensSchema).parse(roleCatalogue)).toHaveLength(12);
    expect(roleCatalogue.map(({ name }) => name)).toEqual([
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
      "devil's advocate",
    ]);
  });

  test('includes every required category for a high-impact architecture motion', () => {
    const categories = selectLenses(ARCHITECTURE_MOTION, 5).map(({ category }) => category);

    expect(new Set(categories)).toEqual(
      new Set(['domain', 'maintainer', 'risk', 'systems', 'contrarian']),
    );
  });

  test('applies baseline coverage and the conditional systems rule exactly', () => {
    expect(
      selectLenses({ domains: ['product'], impact: 'low', contested: false }, 4).map(
        ({ category }) => category,
      ),
    ).toEqual(['domain', 'maintainer', 'risk', 'contrarian']);
    expect(
      selectLenses({ domains: ['product'], impact: 'medium', contested: false }, 4).map(
        ({ category }) => category,
      ),
    ).toEqual(['domain', 'maintainer', 'risk', 'contrarian']);
    expect(
      selectLenses({ domains: ['architecture'], impact: 'low', contested: false }, 5).map(
        ({ category }) => category,
      ),
    ).toEqual(['domain', 'maintainer', 'risk', 'systems', 'contrarian']);
    expect(
      selectLenses({ domains: ['product'], impact: 'low', contested: true }, 4).map(
        ({ category }) => category,
      ),
    ).toEqual(['domain', 'maintainer', 'risk', 'contrarian']);
  });

  test('fills seats with motion-relevant lenses only', () => {
    const architecture = selectLenses(
      { domains: ['architecture'], impact: 'low', contested: false },
      5,
    );
    const product = selectLenses({ domains: ['product'], impact: 'low', contested: false }, 4);

    expect(architecture.map(({ name }) => name)).toEqual([
      'architect',
      'maintainer',
      'security',
      'systems',
      'critic',
    ]);
    expect(product.map(({ name }) => name)).toEqual([
      'designer',
      'maintainer',
      'security',
      'critic',
    ]);
    expect(architecture.some(({ category }) => category === 'risk')).toBe(true);
    expect(product.some(({ category }) => category === 'systems')).toBe(false);
  });

  test('fills every supported provider seat with a relevant governed lens', () => {
    const lenses = selectLenses({ domains: ['general'], impact: 'low', contested: false }, 6);

    expect(lenses).toHaveLength(6);
    expect(new Set(lenses.map(({ name }) => name))).toHaveLength(6);
    expect(
      lenses.every(
        ({ applicability }) =>
          applicability.domains.includes('*') || applicability.impacts.includes('low'),
      ),
    ).toBe(true);
    const categories = new Set(lenses.map(({ category }) => category));
    expect(categories.has('domain')).toBe(true);
    expect(categories.has('maintainer')).toBe(true);
    expect(categories.has('risk')).toBe(true);
    expect(categories.has('contrarian')).toBe(true);
  });

  test('rejects invalid metadata, impossible category coverage and invalid seat counts', () => {
    expect(() => selectLenses({ domains: [' '], impact: 'low', contested: false }, 1)).toThrow();
    expect(() => selectLenses(ARCHITECTURE_MOTION, 0)).toThrow();
    expect(() => selectLenses(ARCHITECTURE_MOTION, 4)).toThrow();
  });
});

describe('role assignment', () => {
  test('keeps one motion stable across run retries', () => {
    const lenses = roleFixture();
    const first = assignLenses('run-a', 'motion-a', SEAT_IDS, lenses, []);
    const retry = assignLenses('run-retry', 'motion-a', SEAT_IDS, lenses, first);

    expect(retry.map(({ seatId, lensName }) => ({ seatId, lensName }))).toEqual(
      first.map(({ seatId, lensName }) => ({ seatId, lensName })),
    );
    expect(retry.every(({ runId }) => runId === 'run-retry')).toBe(true);
    expect(retry.every(({ motionId }) => motionId === 'motion-a')).toBe(true);
  });

  test('rotates between motions', () => {
    const lenses = roleFixture();
    const first = assignLenses('run-a', 'motion-a', SEAT_IDS, lenses, []);
    const second = assignLenses('run-b', 'motion-b', SEAT_IDS, lenses, first);

    expect(second.map(({ seatId, lensName }) => ({ seatId, lensName }))).not.toEqual(
      first.map(({ seatId, lensName }) => ({ seatId, lensName })),
    );
  });

  test('penalises every previous cross-motion pairing when alternatives exist', () => {
    const lenses = roleFixture();
    const first = assignLenses('run-history', 'motion-history', SEAT_IDS, lenses, []);
    const second = assignLenses('run-penalised', 'motion-penalised', SEAT_IDS, lenses, first);
    const previousBySeat = new Map(first.map(({ seatId, lensName }) => [seatId, lensName]));

    for (const { seatId, lensName } of second) {
      expect(lensName).not.toBe(previousBySeat.get(seatId));
    }
  });

  test('assigns each seat and lens exactly once with explicit override state', () => {
    const lenses = roleFixture();
    const assignments = assignLenses('run-cardinality', 'motion-cardinality', SEAT_IDS, lenses, []);

    expect(assignments).toHaveLength(SEAT_IDS.length);
    expect(new Set(assignments.map(({ seatId }) => seatId))).toEqual(new Set(SEAT_IDS));
    expect(new Set(assignments.map(({ lensName }) => lensName))).toEqual(
      new Set(lenses.map(({ name }) => name)),
    );
    expect(assignments.every(({ runId }) => runId === 'run-cardinality')).toBe(true);
    expect(assignments.every(({ motionId }) => motionId === 'motion-cardinality')).toBe(true);
    expect(assignments.every(({ chairOverride }) => chairOverride === null)).toBe(true);
  });

  test('persists explicit and internally consistent chair override data', () => {
    const override = {
      runId: 'run-overridden',
      motionId: 'motion-overridden',
      seatId: 'anthropic',
      lensName: 'critic',
      chairOverride: {
        originalLensName: 'architect',
        replacementLensName: 'critic',
        reason: 'The motion needs a stronger challenge to its central assumption.',
      },
    };

    expect(RoleAssignmentSchema.parse(override)).toEqual(override);
    expect(() =>
      RoleAssignmentSchema.parse({
        ...override,
        lensName: 'maintainer',
      }),
    ).toThrow();
  });

  test('rejects invalid identifiers, duplicate seats and cardinality mismatches', () => {
    const lenses = roleFixture();

    expect(() => assignLenses('', 'motion-a', SEAT_IDS, lenses, [])).toThrow();
    expect(() => assignLenses('run-a', '', SEAT_IDS, lenses, [])).toThrow();
    expect(() =>
      assignLenses(
        'run-duplicate',
        'motion-duplicate',
        [...SEAT_IDS.slice(0, -1), 'anthropic'],
        lenses,
        [],
      ),
    ).toThrow();
    expect(() =>
      assignLenses('run-short', 'motion-short', SEAT_IDS.slice(0, -1), lenses, []),
    ).toThrow();
  });
});
