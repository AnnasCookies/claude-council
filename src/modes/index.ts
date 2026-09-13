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
