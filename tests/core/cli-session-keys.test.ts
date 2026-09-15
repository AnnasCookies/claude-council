import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { runCliFacade, type CliFacadeEnvironment } from '../../src/cli';
import type { HandlerModeDefinition } from '../../src/modes';
import { loadModelRegistry } from '../../src/substrate';

const NOW = '2026-07-28T12:00:00.000Z';

/** A handler mode that keys sessions by a harness id and takes a bare value, as the advisor will. */
const keyed: HandlerModeDefinition = {
  kind: 'handler',
  name: 'triage',
  knobs: {
    participants: 'one seat',
    pattern: 'parallel',
    aggregation: 'none',
    tempo: 'fast',
    records: 'none',
  },
  pattern: 'parallel',
  spend: { policy: 'never-metered', defaultCap: () => 0 },
  flags: { value: [], boolean: [] },
  session: 'key',
  acceptsPositionals: true,
  outputSchema: z.strictObject({
    sessionKey: z.string().nullable(),
    sessionId: z.string().nullable(),
    positionals: z.array(z.string()),
  }),
  async handle(input) {
    return {
      kind: 'result',
      status: 'completed',
      session: input.options.sessionKey ?? 'tr-2026-07-28-000000',
      pattern: 'parallel',
      rounds: 0,
      seats: [],
      output: {
        sessionKey: input.options.sessionKey ?? null,
        sessionId: input.options.sessionId ?? null,
        positionals: [...input.positionals],
      },
      synthesis: null,
      dissent: null,
      unanimous: false,
      degraded: [],
      spend: {
        billing: 'sub-only',
        policy: 'never-metered',
        cap: 0,
        used: 0,
        fallbacks: 0,
        refused: 0,
        stoppedAtCap: false,
      },
      record: { session: null, paths: [] },
    };
  },
};

const idBased: HandlerModeDefinition = { ...keyed, session: 'id', acceptsPositionals: false };

async function environment(mode: HandlerModeDefinition): Promise<CliFacadeEnvironment> {
  return {
    registry: await loadModelRegistry(),
    adapters: {},
    cwd: 'C:/fixture/project',
    env: {},
    now: () => NOW,
    modes: { triage: mode },
  };
}

describe('handler modes keyed by a harness session', () => {
  test('a key mode receives --session verbatim and its bare arguments', async () => {
    const result = await runCliFacade(
      ['triage', '--session', 'claude:6a07f29b-a0a5', 'yes'],
      await environment(keyed),
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.envelope.output).toEqual({
      sessionKey: 'claude:6a07f29b-a0a5',
      sessionId: null,
      positionals: ['yes'],
    });
    expect(payload.session).toBe('claude:6a07f29b-a0a5');
  });

  test('a key that happens to look like a store id is still passed as a key', async () => {
    const result = await runCliFacade(
      ['triage', '--session', 'ad-2026-07-28-0a1b2c'],
      await environment(keyed),
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).envelope.output).toEqual({
      sessionKey: 'ad-2026-07-28-0a1b2c',
      sessionId: null,
      positionals: [],
    });
  });

  test('a blank key is absent, not an empty string', async () => {
    const result = await runCliFacade(['triage', '--session', '   '], await environment(keyed));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).envelope.output.sessionKey).toBeNull();
  });

  test('an id mode keeps the foundation rules: validated ids, no bare arguments', async () => {
    const valid = await runCliFacade(
      ['triage', '--session', 'tr-2026-07-28-0a1b2c'],
      await environment(idBased),
    );
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout).envelope.output).toEqual({
      sessionKey: null,
      sessionId: 'tr-2026-07-28-0a1b2c',
      positionals: [],
    });
    const invalid = await runCliFacade(
      ['triage', '--session', 'claude:6a07f29b'],
      await environment(idBased),
    );
    expect(invalid.exitCode).toBe(2);
    const positional = await runCliFacade(['triage', 'yes'], await environment(idBased));
    expect(positional.exitCode).toBe(2);
    expect(positional.stderr).toContain('options only');
  });
});
