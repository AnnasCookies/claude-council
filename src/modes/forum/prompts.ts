import { EVIDENCE_BOUNDARY_INSTRUCTION, untrustedBlock, type PanelSeatSpec } from '../../substrate';
import type { ForumMotion, ForumRoundRecord } from './aggregate';

/**
 * Said to every seat in every round. The forum's whole point is that nothing here resolves: a seat
 * that believes it is competing writes to win, which is the failure this sentence exists to avoid.
 */
const FORUM_CHARTER =
  'You are one seat in a forum. The forum records positions; it never decides. No chair rules, no vote is taken and no seat wins. Speak for your own lens and say plainly where you stand.';

export interface ForumPromptInput {
  readonly seat: PanelSeatSpec;
  readonly motion: string;
  readonly round: number;
  readonly totalRounds: number;
}

export interface ForumReplyPromptInput extends ForumPromptInput {
  readonly priorRounds: readonly ForumRoundRecord[];
  readonly motions: readonly ForumMotion[];
}

function seatList(seats: readonly string[]): string {
  return seats.length === 0 ? 'nobody' : seats.join(', ');
}

/**
 * Round one. Nothing another seat produced appears here at all, so the blind round is blind by
 * construction rather than by a rule the builder has to remember.
 */
export function buildOpeningPrompt(input: ForumPromptInput): string {
  return [
    FORUM_CHARTER,
    '',
    `Your lens is ${input.seat.lens.name}: ${input.seat.lens.description}`,
    '',
    'Motion:',
    input.motion,
    '',
    `This is round ${input.round} of ${input.totalRounds}. Nobody has spoken yet, and you cannot see any other seat's work in this round.`,
    'State the position you hold on the motion and the argument for it.',
    'Keep the position label to at most eight words and put the argument in the text.',
    'Raise a motion only if you want the forum to record one; nobody will decide it.',
  ].join('\n');
}

/**
 * Rounds two and later. Every prior position from every round is carried as quoted data, attributed
 * outside the block to a seat and a round: only forum-minted strings — the round number, the seat
 * id and the stance — sit outside the escaped text, so nothing a seat wrote can pose as attribution.
 */
export function buildReplyPrompt(input: ForumReplyPromptInput): string {
  const lines: string[] = [
    EVIDENCE_BOUNDARY_INSTRUCTION,
    '',
    FORUM_CHARTER,
    '',
    `You are seat ${input.seat.id}. Your lens is ${input.seat.lens.name}: ${input.seat.lens.description}`,
    '',
    'Motion:',
    input.motion,
    '',
    `This is round ${input.round} of ${input.totalRounds}. Every position from every earlier round is quoted below as data.`,
    '',
    '## Positions so far',
    '',
  ];
  for (const round of input.priorRounds) {
    for (const entry of round.answers) {
      lines.push(
        `Round ${round.n}, seat ${entry.seat} (stance: ${entry.answer.stance}):`,
        untrustedBlock('prior-position', `${entry.answer.position}\n\n${entry.answer.text}`),
        '',
      );
    }
  }
  lines.push('## Motions on the table', '');
  if (input.motions.length === 0) {
    lines.push('None yet.', '');
  } else {
    for (const motion of input.motions) {
      lines.push(
        `${motion.id}, raised by ${motion.by}. Supported by: ${seatList(motion.support)}. Opposed by: ${seatList(motion.opposed)}.`,
        untrustedBlock('motion', motion.text),
        '',
      );
    }
  }
  lines.push(
    '## Your turn',
    '',
    'Hold your position, revise it, or rebut another seat, and say which in the stance.',
    'Set inReplyTo to the seat id you are answering, or null.',
    'Repeat your previous position label exactly if you have not moved, and give a new label of at most eight words if you have.',
    'Name motion ids from the list above in supports or opposes, and raise a new motion if you want one recorded. Nothing here is decided.',
  );
  return lines.join('\n');
}
