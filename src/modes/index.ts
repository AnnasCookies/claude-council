import { committee } from './committee';
import { secondOpinion } from './second-opinion';
import { MODE_NAMES, type ModeDefinition, type ModeName } from './types';

export * from './types';

export const modes: Readonly<Record<ModeName, ModeDefinition>> = Object.freeze({
  committee,
  'second-opinion': secondOpinion,
});

export function getMode(name: string): ModeDefinition {
  const mode = (modes as Readonly<Record<string, ModeDefinition | undefined>>)[name];
  if (mode === undefined) {
    throw new Error(`Unknown mode: ${name}. Registered modes: ${MODE_NAMES.join(', ')}`);
  }
  return mode;
}

/**
 * `council` was always the chaired committee and `second-opinion` one blind round. `run` is the
 * legacy classified alias: significant motions took the committee's quorum without its chair, so
 * they map to `committee` and the CLI marks the envelope `legacy-run-alias`.
 */
export function resolveModeForCommand(
  command: 'run' | 'council' | 'second-opinion',
  significant: boolean,
): ModeName {
  if (command === 'council') return 'committee';
  if (command === 'second-opinion') return 'second-opinion';
  return significant ? 'committee' : 'second-opinion';
}
