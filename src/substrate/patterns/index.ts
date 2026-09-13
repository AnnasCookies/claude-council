import { type ExecutionPattern } from '../envelope';
import type { CouncilRunInput, CouncilRunResult, CouncilRunner } from '../execution/runner';

/** Blind analysis, rebuttal, optional refinement: the existing multi-round protocol. */
export async function executeRounds(
  runner: CouncilRunner,
  input: CouncilRunInput,
): Promise<CouncilRunResult> {
  return runner.run(input);
}

/** One blind round with no rebuttal. Seats never see each other's output. */
export async function executeParallel(
  runner: CouncilRunner,
  input: CouncilRunInput,
): Promise<CouncilRunResult> {
  if (input.rounds !== 1) {
    throw new Error(
      `The parallel pattern is exactly one blind round; received rounds=${input.rounds}`,
    );
  }
  return runner.run(input);
}

/** Declared for the advisor mode. Implemented by the advisor brief, not this one. */
export function executeStreaming(): never {
  throw new Error(
    'The streaming pattern is declared for the advisor mode and is not implemented in this build',
  );
}

export async function executePattern(
  pattern: ExecutionPattern,
  runner: CouncilRunner,
  input: CouncilRunInput,
): Promise<CouncilRunResult> {
  switch (pattern) {
    case 'rounds':
      return executeRounds(runner, input);
    case 'parallel':
      return executeParallel(runner, input);
    case 'streaming':
      return executeStreaming();
  }
}
