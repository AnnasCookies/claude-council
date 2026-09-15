import { describe, expect, test } from 'bun:test';
import {
  AdvisorNoteSchema,
  NOTE_TEXT_LIMIT,
  RISK_CLASSES,
  RiskClassSchema,
  TOOL_CALL_EXCERPT_LIMIT,
  cadenceDue,
  excerpt,
  nextNoteId,
  readAdvisorLog,
  type AdvisorNote,
} from '../../src/modes/advisor/notes';
import type { EnvelopeSeat, ModeSessionEvent } from '../../src/substrate';

const AT = '2026-09-15T10:00:00.000Z';

const seat: EnvelopeSeat = {
  id: 'anthropic/anthropic-primary#advisor',
  family: 'anthropic',
  model: {
    requested: 'anthropic-primary',
    verified: 'anthropic-primary',
    verification: 'verified',
  },
  lens: 'advisor',
  transport: 'subscription',
  fallback: false,
  status: 'ok',
  reason: null,
};

function note(id: string, overrides: Partial<AdvisorNote> = {}): AdvisorNote {
  return {
    id,
    trigger: 'cadence',
    severity: 'info',
    text: '',
    refersTo: {},
    heeded: 'unknown',
    status: 'skipped',
    reason: 'cadence',
    seat: null,
    at: AT,
    ...overrides,
  };
}

function event(kind: string, data: unknown): ModeSessionEvent {
  return { at: AT, kind, data };
}

describe('advisor notes', () => {
  test('the risk classes are exactly the five the spec names', () => {
    expect([...RISK_CLASSES]).toEqual([
      'destructive-git',
      'delete',
      'deploy',
      'payment',
      'credential',
    ]);
    expect(RiskClassSchema.safeParse('network').success).toBe(false);
  });

  test('a note validates with the fields the spec lists and nothing else', () => {
    const hold = note('n-1', {
      trigger: 'hold',
      severity: 'caution',
      text: 'Force-pushing main rewrites shared history.',
      refersTo: { toolCall: 'git push --force origin main' },
      status: 'ok',
      reason: null,
      seat: seat.id,
    });
    expect(AdvisorNoteSchema.parse(hold)).toEqual(hold);
    expect(AdvisorNoteSchema.safeParse({ ...hold, id: 'n-0' }).success).toBe(false);
    expect(
      AdvisorNoteSchema.safeParse({ ...hold, text: 'x'.repeat(NOTE_TEXT_LIMIT + 1) }).success,
    ).toBe(false);
    expect(AdvisorNoteSchema.safeParse({ ...hold, extra: true }).success).toBe(false);
    expect(AdvisorNoteSchema.safeParse({ ...hold, refersTo: { window: 'never' } }).success).toBe(
      false,
    );
  });

  test('reads a log, folds the latest heed onto each note and collects the seats once', () => {
    const log = readAdvisorLog([
      event('started', { key: 'claude:abc' }),
      event('note', { note: note('n-1'), seat: null }),
      event('note', {
        note: note('n-2', {
          trigger: 'hold',
          status: 'ok',
          reason: null,
          text: 'Careful.',
          seat: seat.id,
        }),
        seat,
      }),
      event('heed', { note: 'n-2', heeded: 'no' }),
      event('heed', { note: 'n-2', heeded: 'yes' }),
      event('note', {
        note: note('n-3', {
          trigger: 'cadence',
          status: 'ok',
          reason: null,
          text: 'Fine.',
          seat: seat.id,
        }),
        seat,
      }),
      event('ended', { notes: 3 }),
    ]);
    expect(log.started).toBe(true);
    expect(log.ended).toBe(true);
    expect(log.notes.map((entry) => [entry.id, entry.heeded])).toEqual([
      ['n-1', 'unknown'],
      ['n-2', 'yes'],
      ['n-3', 'unknown'],
    ]);
    expect(log.seats).toEqual([seat]);
    expect(log.cadenceCalls).toBe(2);
    expect(nextNoteId(log)).toBe('n-4');
  });

  test('an empty log is a fresh session', () => {
    const log = readAdvisorLog([]);
    expect(log).toEqual({ started: false, ended: false, notes: [], seats: [], cadenceCalls: 0 });
    expect(nextNoteId(log)).toBe('n-1');
  });

  test('refuses what it cannot read back rather than guessing', () => {
    expect(() => readAdvisorLog([event('heed', { note: 'n-9', heeded: 'yes' })])).toThrow(
      /unknown advisor note/,
    );
    expect(() =>
      readAdvisorLog([
        event('note', { note: note('n-1'), seat: null }),
        event('note', { note: note('n-1'), seat: null }),
      ]),
    ).toThrow(/Duplicate advisor note id/);
    expect(() => readAdvisorLog([event('window', { text: 'never' })])).toThrow(
      /Unknown advisor event kind/,
    );
    expect(() => readAdvisorLog([event('note', { note: { id: 'n-1' }, seat: null })])).toThrow();
  });

  test('cadence is due on every Nth call, counted from the log', () => {
    const calls = (count: number) =>
      readAdvisorLog(
        Array.from({ length: count }, (_, index) =>
          event('note', { note: note(`n-${index + 1}`), seat: null }),
        ),
      );
    expect(cadenceDue(calls(0), 3)).toBe(false);
    expect(cadenceDue(calls(1), 3)).toBe(false);
    expect(cadenceDue(calls(2), 3)).toBe(true);
    expect(cadenceDue(calls(5), 3)).toBe(true);
    expect(cadenceDue(calls(0), 1)).toBe(true);
  });

  test('excerpt flattens whitespace and marks a cut', () => {
    expect(excerpt('  git  push\n--force ', 40)).toBe('git push --force');
    expect(excerpt('abcdefghij', 5)).toBe('abcd…');
    expect(excerpt('abcde', 5)).toBe('abcde');
  });

  test('excerpt cuts on code points, never inside a surrogate pair', () => {
    const result = excerpt('abc😀fgh', 5);
    expect(result.endsWith('…')).toBe(true);
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });

  test('excerpt never exceeds the code units the note schema counts', () => {
    // The schema's `max` counts UTF-16 units. A cut that counted only code points returned a
    // 201-unit excerpt for a 200-unit limit whenever an emoji sat on the boundary, and the note
    // was then refused by the output schema after it had already been appended to the log.
    for (const offset of [196, 197, 198, 199, 200, 201]) {
      const cut = excerpt(`${'a'.repeat(offset)}😀${'b'.repeat(60)}`, TOOL_CALL_EXCERPT_LIMIT);
      expect([offset, cut.length <= TOOL_CALL_EXCERPT_LIMIT]).toEqual([offset, true]);
      // A half-cut surrogate pair would not survive a UTF-8 round trip.
      expect(Buffer.from(cut, 'utf8').toString('utf8')).toBe(cut);
      expect(
        AdvisorNoteSchema.safeParse(note('n-1', { refersTo: { toolCall: cut } })).success,
      ).toBe(true);
    }
    const allEmoji = excerpt('😀'.repeat(700), NOTE_TEXT_LIMIT);
    expect(allEmoji.length).toBeLessThanOrEqual(NOTE_TEXT_LIMIT);
    expect(Buffer.from(allEmoji, 'utf8').toString('utf8')).toBe(allEmoji);
    expect(AdvisorNoteSchema.safeParse(note('n-1', { text: allEmoji })).success).toBe(true);
  });
});
