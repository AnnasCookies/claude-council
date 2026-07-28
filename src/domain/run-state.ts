export type RunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked-policy' | 'blocked-quorum';

const transitions = {
  queued: new Set<RunStatus>(['running', 'cancelled', 'blocked-policy']),
  running: new Set<RunStatus>([
    'completed',
    'failed',
    'cancelled',
    'blocked-policy',
    'blocked-quorum',
  ]),
} as const;

const terminalStatuses = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
  'blocked-policy',
  'blocked-quorum',
]);

export function transitionRun(current: RunStatus, next: RunStatus): RunStatus {
  if (terminalStatuses.has(current)) {
    throw new Error(`run state '${current}' is terminal`);
  }
  const allowed = current === 'queued' ? transitions.queued : transitions.running;
  if (!allowed.has(next)) {
    throw new Error(`invalid run-state transition: ${current} -> ${next}`);
  }
  return next;
}
