import { advisor } from './advisor';
import { committee } from './committee';
import { ideation } from './ideation';
import { secondOpinion } from './second-opinion';
import {
  SPECIFIED_MODE_NAMES,
  isHandlerMode,
  type HandlerModeDefinition,
  type ModeDefinition,
  type ModeName,
  type RunnerModeDefinition,
  type SpecifiedModeName,
} from './types';

export * from './types';

/**
 * The shipped definitions are declared as the union; narrowing them once here keeps
 * `modes.committee.prepare` and `.defaults` typed for the CLI and the tests.
 */
function runnerMode(mode: ModeDefinition): RunnerModeDefinition {
  if (isHandlerMode(mode)) {
    throw new TypeError(`Mode ${mode.name} is a handler mode, not a runner mode`);
  }
  return mode;
}

/**
 * Typed per entry so the runner path keeps `modes.committee.prepare` and `.defaults` while a
 * handler mode sits beside them; `satisfies` proves every registered name has a definition.
 */
export const modes: Readonly<{
  readonly committee: RunnerModeDefinition;
  readonly 'second-opinion': RunnerModeDefinition;
  readonly advisor: HandlerModeDefinition;
  readonly ideation: HandlerModeDefinition;
}> = Object.freeze({
  committee: runnerMode(committee),
  'second-opinion': runnerMode(secondOpinion),
  advisor,
  ideation,
}) satisfies Readonly<Record<ModeName, ModeDefinition>>;

/** What a build can run, keyed by specified name. Tests inject one to register a fixture mode. */
export type ModeRegistry = Readonly<Partial<Record<SpecifiedModeName, ModeDefinition>>>;

export function getMode(name: string, registry: ModeRegistry = modes): ModeDefinition {
  const known = SPECIFIED_MODE_NAMES.find((candidate) => candidate === name);
  const mode = known === undefined ? undefined : registry[known];
  if (mode === undefined) {
    throw new Error(`Unknown mode: ${name}. Registered modes: ${Object.keys(registry).join(', ')}`);
  }
  return mode;
}

export function getRunnerMode(name: string, registry: ModeRegistry = modes): RunnerModeDefinition {
  return runnerMode(getMode(name, registry));
}

/**
 * A significant motion always takes the committee pattern, whichever front door asked for it: an
 * ordinary motion is one blind round, and a high-impact or contested one needs the committee's
 * quorum and its rebuttal round. `council` alone is chaired. `run` and `second-opinion` reach the
 * committee without a chair, and the CLI marks those envelopes `legacy-run-alias` and
 * `legacy-significant-second-opinion` respectively.
 */
export function resolveModeForCommand(
  command: 'run' | 'council' | 'second-opinion',
  significant: boolean,
): ModeName {
  if (command === 'council') return 'committee';
  return significant ? 'committee' : 'second-opinion';
}
