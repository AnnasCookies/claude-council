import { describe, expect, test } from 'bun:test';
import type { CouncilRunInput, CouncilRunner } from '../../src/substrate/execution/runner';
import {
  executeParallel,
  executePattern,
  executeRounds,
  executeStreaming,
} from '../../src/substrate/patterns';

function fakeRunner(): { runner: CouncilRunner; calls: CouncilRunInput[] } {
  const calls: CouncilRunInput[] = [];
  const runner = {
    async run(input: CouncilRunInput) {
      calls.push(input);
      return { runId: input.runId } as unknown as Awaited<ReturnType<CouncilRunner['run']>>;
    },
  } as unknown as CouncilRunner;
  return { runner, calls };
}

const base = {
  runId: 'run-1',
  motion: 'motion',
  assignments: [],
  quorumPolicy: { minimumDistinctFamilies: 3, requiresContrarian: false },
} as unknown as Omit<CouncilRunInput, 'rounds'>;

describe('execution patterns', () => {
  test('rounds delegates to the runner unchanged', async () => {
    const { runner, calls } = fakeRunner();
    await executeRounds(runner, { ...base, rounds: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rounds).toBe(2);
  });

  test('parallel is exactly one blind round', async () => {
    const { runner, calls } = fakeRunner();
    await executeParallel(runner, { ...base, rounds: 1 });
    expect(calls).toHaveLength(1);
    await expect(executeParallel(runner, { ...base, rounds: 2 })).rejects.toThrow(
      /exactly one blind round/,
    );
    expect(calls).toHaveLength(1);
  });

  test('streaming is declared and not implemented', () => {
    expect(() => executeStreaming()).toThrow(/not implemented/);
  });

  test('executePattern dispatches by name', async () => {
    const { runner, calls } = fakeRunner();
    await executePattern('parallel', runner, { ...base, rounds: 1 });
    await executePattern('rounds', runner, { ...base, rounds: 3 });
    expect(calls.map((call) => call.rounds)).toEqual([1, 3]);
    await expect(executePattern('streaming', runner, { ...base, rounds: 1 })).rejects.toThrow(
      /not implemented/,
    );
  });
});
