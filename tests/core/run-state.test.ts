import { describe, expect, test } from 'bun:test';
import { transitionRun } from '../../src/domain/run-state';

describe('run-state transitions', () => {
  test('allows only declared queued and running transitions', () => {
    expect(transitionRun('queued', 'running')).toBe('running');
    expect(transitionRun('queued', 'cancelled')).toBe('cancelled');
    expect(transitionRun('queued', 'blocked-policy')).toBe('blocked-policy');
    expect(transitionRun('running', 'completed')).toBe('completed');
    expect(transitionRun('running', 'failed')).toBe('failed');
    expect(transitionRun('running', 'blocked-quorum')).toBe('blocked-quorum');
  });

  test('rejects undeclared transitions', () => {
    expect(() => transitionRun('queued', 'completed')).toThrow('invalid');
    expect(() => transitionRun('running', 'queued')).toThrow('invalid');
  });

  test('cancelled is terminal', () => {
    expect(() => transitionRun('cancelled', 'completed')).toThrow('terminal');
  });

  test('every completed or blocked state is terminal', () => {
    for (const status of ['completed', 'failed', 'blocked-policy', 'blocked-quorum'] as const) {
      expect(() => transitionRun(status, 'running')).toThrow('terminal');
    }
  });
});
