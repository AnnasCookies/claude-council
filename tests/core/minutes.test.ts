import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultEnvelope } from '../../src/substrate/envelope';
import type { RoundExecution } from '../../src/substrate/execution/runner';
import {
  minutesDirectory,
  minutesFileName,
  renderMinutes,
  writeMinutes,
} from '../../src/substrate/records/minutes';

const envelope: ResultEnvelope = {
  schemaVersion: 1,
  mode: 'second-opinion',
  session: 'run-1',
  caller: { kind: 'agent', harness: 'omp', purpose: 'pick a library', declared: true },
  pattern: 'parallel',
  rounds: 1,
  seats: [
    {
      id: 'anthropic/claude#architect',
      family: 'anthropic',
      model: { requested: 'claude', verified: 'claude', verification: 'verified' },
      lens: 'architect',
      transport: 'subscription',
      fallback: false,
      status: 'ok',
      reason: null,
    },
  ],
  output: { outcome: 'completed' },
  synthesis: null,
  dissent: null,
  unanimous: false,
  spend: {
    billing: 'sub-first',
    policy: 'capped',
    cap: 1,
    used: 0,
    fallbacks: 0,
    refused: 0,
    stoppedAtCap: false,
  },
  degraded: ['caller-undeclared'],
  record: { session: 'general/sessions/run-1.json' },
};

const rounds: RoundExecution[] = [
  {
    round: 1,
    phase: 'analysis',
    retries: [],
    responses: [
      {
        status: 'ok',
        seatId: 'anthropic-seat',
        provider: 'anthropic',
        requestedModel: 'claude',
        actualModel: 'claude',
        modelIdentity: 'verified',
        route: 'primary',
        role: 'architect',
        latencyMs: 1,
        answer: '{"recommendation":"Use X"}',
      },
    ],
  },
];

describe('minutes', () => {
  test('renders the sections the brief names', () => {
    const text = renderMinutes({
      envelope,
      rounds,
      motion: 'Which library?',
      startedAt: '2026-09-13T00:00:00.000Z',
      completedAt: '2026-09-13T00:01:00.000Z',
    });
    expect(text).toContain('# Minutes: second-opinion run-1');
    expect(text).toContain('Which library?');
    expect(text).toContain('| anthropic/claude#architect |');
    expect(text).toContain('## Round 1 (analysis)');
    expect(text).toContain('{"recommendation":"Use X"}');
    expect(text).toContain('## Spend');
    expect(text).toContain('general/sessions/run-1.json');
    expect(text).toContain('caller-undeclared');
  });

  test('names the file by date, mode and session', () => {
    expect(minutesFileName(envelope, '2026-09-13T00:00:00.000Z')).toBe(
      '2026-09-13-second-opinion-run-1.md',
    );
  });

  test('resolves the directory from COUNCIL_MINUTES_DIR relative to cwd', () => {
    expect(minutesDirectory({}, '/work')).toBeNull();
    expect(minutesDirectory({ COUNCIL_MINUTES_DIR: '   ' }, '/work')).toBeNull();
    expect(minutesDirectory({ COUNCIL_MINUTES_DIR: 'minutes' }, '/work')).toBe(
      join('/work', 'minutes'),
    );
  });

  test('writes once and refuses to overwrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'council-minutes-'));
    try {
      const path = await writeMinutes({
        directory,
        envelope,
        rounds,
        motion: 'm',
        startedAt: '2026-09-13T00:00:00.000Z',
        completedAt: '2026-09-13T00:01:00.000Z',
      });
      expect(path).toBe(join(directory, '2026-09-13-second-opinion-run-1.md'));
      expect(await Bun.file(path).text()).toContain('# Minutes');
      await expect(
        writeMinutes({
          directory,
          envelope,
          rounds,
          motion: 'm',
          startedAt: '2026-09-13T00:00:00.000Z',
          completedAt: '2026-09-13T00:01:00.000Z',
        }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
