import { isAbsolute, join, resolve } from 'node:path';
import type { ResultEnvelope } from '../envelope';
import type { RoundExecution } from '../execution/runner';
import { writeTextAtomically } from './store';

export interface MinutesInput {
  readonly envelope: ResultEnvelope;
  readonly rounds: readonly RoundExecution[];
  readonly motion: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

function cell(value: string | null | boolean | number): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/**
 * A minutes file is the human-readable copy of a terminal record, written where the vault's
 * ingest will find it. Everything in it comes from the envelope and the recorded rounds, which are
 * already redacted upstream; nothing is fetched or recomputed here.
 */
export function renderMinutes(input: MinutesInput): string {
  const { envelope } = input;
  const lines: string[] = [
    `# Minutes: ${envelope.mode} ${envelope.session}`,
    '',
    `- Mode: ${envelope.mode} (${envelope.pattern}, ${envelope.rounds} round${envelope.rounds === 1 ? '' : 's'})`,
    `- Caller: ${envelope.caller.kind} via ${envelope.caller.harness}${envelope.caller.purpose === undefined ? '' : `, purpose: ${envelope.caller.purpose}`}${envelope.caller.declared ? '' : ' (undeclared)'}`,
    `- Started: ${input.startedAt}`,
    `- Completed: ${input.completedAt}`,
    `- Unanimous: ${envelope.unanimous ? 'yes, treat with suspicion' : 'no'}`,
    `- Degraded: ${envelope.degraded.length === 0 ? 'none' : envelope.degraded.join(', ')}`,
    `- Record: ${envelope.record.session ?? 'not persisted'}`,
    '',
    '## Motion',
    '',
    input.motion,
    '',
    '## Seats',
    '',
    '| Seat | Family | Lens | Model | Verification | Transport | Fallback | Status | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...envelope.seats.map(
      (seat) =>
        `| ${cell(seat.id)} | ${cell(seat.family)} | ${cell(seat.lens)} | ${cell(seat.model.verified ?? seat.model.requested)} | ${cell(seat.model.verification)} | ${cell(seat.transport)} | ${seat.fallback ? 'yes' : 'no'} | ${cell(seat.status)} | ${cell(seat.reason)} |`,
    ),
    '',
  ];
  for (const round of input.rounds) {
    lines.push(`## Round ${round.round} (${round.phase})`, '');
    for (const response of round.responses) {
      lines.push(`### ${response.seatId} (${response.provider}, ${response.role})`, '');
      if (response.status === 'ok') {
        lines.push('```json', response.answer, '```', '');
      } else {
        lines.push(
          `Status: ${response.status}. ${response.error.code}: ${response.error.message}`,
          '',
        );
      }
    }
  }
  lines.push(
    '## Synthesis',
    '',
    envelope.synthesis === null
      ? 'Not computed in this mode.'
      : `By ${envelope.synthesis.by}:\n\n${envelope.synthesis.text}`,
    '',
    '## Dissent',
    '',
    envelope.dissent === null
      ? 'Not computed in this mode.'
      : envelope.dissent.length === 0
        ? 'None recorded.'
        : envelope.dissent.map((entry) => `- ${entry.seat}: ${entry.position}`).join('\n'),
    '',
    '## Spend',
    '',
    `- Billing: ${envelope.spend.billing} (${envelope.spend.policy})`,
    `- Cap: ${envelope.spend.cap}; metered calls: ${envelope.spend.used}; fallbacks: ${envelope.spend.fallbacks}; refused: ${envelope.spend.refused}`,
    `- Stopped at cap: ${envelope.spend.stoppedAtCap ? 'yes' : 'no'}`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function minutesFileName(envelope: ResultEnvelope, startedAt: string): string {
  const day = startedAt.slice(0, 10);
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${day}-${safe(envelope.mode)}-${safe(envelope.session)}.md`;
}

export function minutesDirectory(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | null {
  const value = env.COUNCIL_MINUTES_DIR?.trim();
  if (value === undefined || value.length === 0) return null;
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export async function writeMinutes(
  input: MinutesInput & { readonly directory: string },
): Promise<string> {
  const path = join(input.directory, minutesFileName(input.envelope, input.startedAt));
  await writeTextAtomically(path, renderMinutes(input), { replace: false });
  return path;
}
