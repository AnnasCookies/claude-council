import { describe, expect, test } from 'bun:test';
import {
  AudienceTalliesSchema,
  tallyReactions,
  type AudienceCountableFields,
} from '../../src/modes/audience/tally';

/** Every number in a value, by path, so "no number but a count" is checked rather than asserted. */
function numericPaths(value: unknown, path: readonly string[] = []): string[] {
  if (typeof value === 'number') return [path.join('.')];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => numericPaths(entry, [...path, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => numericPaths(entry, [...path, key]));
  }
  return [];
}

const reactions: AudienceCountableFields[] = [
  { clear: true, wouldAct: true },
  { clear: true, wouldAct: false },
  { clear: false, wouldAct: false },
];

describe('audience tallies', () => {
  test('counts the structured fields, and counting is all it does', () => {
    expect(tallyReactions(reactions)).toEqual({
      answered: 3,
      clear: { yes: 2, no: 1 },
      wouldAct: { yes: 1, no: 2 },
    });
  });

  test('no voices is zero, not an error and not an average', () => {
    expect(tallyReactions([])).toEqual({
      answered: 0,
      clear: { yes: 0, no: 0 },
      wouldAct: { yes: 0, no: 0 },
    });
  });

  test('each pair sums to the number of voices that answered', () => {
    const tallies = tallyReactions(reactions);
    expect(tallies.clear.yes + tallies.clear.no).toBe(tallies.answered);
    expect(tallies.wouldAct.yes + tallies.wouldAct.no).toBe(tallies.answered);
  });

  test('the only numbers are the five counts, and the schema admits no others', () => {
    expect(numericPaths(tallyReactions(reactions)).sort()).toEqual([
      'answered',
      'clear.no',
      'clear.yes',
      'wouldAct.no',
      'wouldAct.yes',
    ]);
    const tallies = tallyReactions(reactions);
    expect(AudienceTalliesSchema.safeParse(tallies).success).toBe(true);
    expect(AudienceTalliesSchema.safeParse({ ...tallies, share: 0.66 }).success).toBe(false);
    expect(AudienceTalliesSchema.safeParse({ ...tallies, answered: 2.5 }).success).toBe(false);
    expect(AudienceTalliesSchema.safeParse({ ...tallies, answered: -1 }).success).toBe(false);
    expect(
      AudienceTalliesSchema.safeParse({ ...tallies, clear: { yes: 2, no: 1, percentage: 66 } })
        .success,
    ).toBe(false);
  });
});
