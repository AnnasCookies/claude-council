import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoundExecutionSchema } from '../../src/execution/runner';
import {
  CouncilStore,
  CurrentSessionRecordSchema,
  PersistedRoundSchema,
  SessionRecordSchema,
  sessionDataAvailability,
  writeTextAtomically,
  type ChairAcceptanceRecord,
  type ChairRulingRecord,
  type CurrentSessionRecord,
  type ExecutionSnapshot,
  type ResolutionRecord,
} from '../../src/records/store';
const GENERAL_LEDGER = '# General ledger\n';
const STARTED_AT = '2026-07-27T09:00:00.000Z';
const ORDINARY_PROTOCOL = {
  requestedRounds: 1,
  quorumPolicy: {
    minimumDistinctFamilies: 3,
    requiresContrarian: false,
  },
} as const;
const COMPLETED_AT = '2026-07-27T09:05:00.000Z';

/**
 * The smallest execution snapshot that satisfies the v2 contract: three verified seats from three
 * distinct families, a passing quorum consistent with its own evidence, and no retries. Written out
 * rather than generated so a change in the persisted shape shows up as a test diff.
 */
const EXECUTION_SNAPSHOT: ExecutionSnapshot = {
  rounds: [
    {
      round: 1,
      phase: 'analysis',
      responses: [
        {
          status: 'ok',
          seatId: 'anthropic-seat',
          provider: 'anthropic',
          requestedModel: 'claude-opus-5',
          actualModel: 'claude-opus-5',
          modelIdentity: 'verified',
          route: 'primary',
          role: 'maintainer',
          latencyMs: 1200,
          answer: '{"recommendation":"append-only"}',
          requestedEffort: 'max',
          credentialPath: 'subscription',
        },
        {
          status: 'ok',
          seatId: 'openai-seat',
          provider: 'openai',
          requestedModel: 'gpt-5.6-sol',
          actualModel: 'gpt-5.6-sol',
          modelIdentity: 'verified',
          route: 'primary',
          role: 'risk',
          latencyMs: 1400,
          answer: '{"recommendation":"append-only"}',
          requestedEffort: 'xhigh',
          observedEffort: 'xhigh',
          credentialPath: 'subscription',
        },
        {
          status: 'ok',
          seatId: 'google-seat',
          provider: 'google',
          requestedModel: 'gemini-3.1-pro-high',
          actualModel: 'gemini-3.1-pro-high',
          modelIdentity: 'verified',
          route: 'primary',
          role: 'systems',
          latencyMs: 1100,
          answer: '{"recommendation":"append-only"}',
          credentialPath: 'subscription',
        },
      ],
      retries: [],
    },
  ],
  quorum: {
    passed: true,
    minimumDistinctFamilies: 3,
    successfulFamilies: ['anthropic', 'openai', 'google'],
    requiresContrarian: false,
    contrarianSatisfied: false,
    failureReasons: [],
  },
  rebuttalObligation: {
    minimumSuccessfulResponses: 0,
    successfulResponses: 0,
    satisfied: true,
  },
  synthesisEligible: true,
};

function generalSession(overrides: Partial<CurrentSessionRecord> = {}): CurrentSessionRecord {
  return CurrentSessionRecordSchema.parse({
    schemaVersion: 2,
    runId: 'run-general',
    motionId: 'motion-general',
    scope: 'general',
    status: 'completed',
    motion: 'Choose a harness-wide release gate.',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    decisionState: 'awaiting-adjudication',
    policyDecision: {
      kind: 'allowed',
      classification: 'public',
      reasonCodes: [],
    },
    destinations: [],
    protocol: ORDINARY_PROTOCOL,
    execution: EXECUTION_SNAPSHOT,
    summary: 'Keep the release gate generic.',
    ...overrides,
  });
}

function generalRuling(overrides: Partial<ChairRulingRecord> = {}): ChairRulingRecord {
  return {
    rulingId: 'ruling-general',
    runId: 'run-general',
    motionId: 'motion-general',
    scope: 'general',
    title: 'Harness-wide release gate',
    decision: 'Keep the release gate generic.',
    rationale: 'No seat argued for a scope-specific gate.',
    authorisedBy: 'chair',
    followedSeats: [],
    setAsideSeats: [],
    dissentAcknowledged: false,
    createdAt: COMPLETED_AT,
    ...overrides,
  } as ChairRulingRecord;
}

async function withCouncilFixture(
  run: (root: string, store: CouncilStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-records-'));
  await mkdir(join(root, 'general'), { recursive: true });
  await Bun.write(join(root, 'general', 'ledger.md'), GENERAL_LEDGER);

  try {
    await run(root, CouncilStore.open(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function projectSession(
  projectId = 'project-alpha',
  overrides: Partial<CurrentSessionRecord> = {},
): CurrentSessionRecord {
  return CurrentSessionRecordSchema.parse({
    schemaVersion: 2,
    runId: 'run-1',
    motionId: 'motion-1',
    scope: 'project',
    projectId,
    projectDisplayName: 'Project Alpha',
    status: 'completed',
    motion: 'Choose the durable record store.',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    decisionState: 'awaiting-adjudication',
    policyDecision: {
      kind: 'allowed',
      classification: 'internal',
      reasonCodes: [],
    },
    protocol: ORDINARY_PROTOCOL,
    destinations: [{ provider: 'anthropic', model: 'claude-opus-5' }],
    execution: EXECUTION_SNAPSHOT,
    summary: 'Use an append-only scoped store.',
    ...overrides,
  });
}

function projectRuling(
  projectId = 'project-alpha',
  overrides: Partial<ChairRulingRecord> = {},
): ChairRulingRecord {
  return {
    rulingId: 'ruling-1',
    runId: 'run-1',
    motionId: 'motion-1',
    scope: 'project',
    projectId,
    title: 'Durable record store',
    decision: 'Use an append-only scoped store.',
    rationale: 'Two seats agreed on durability; the dissent on cost was noted and accepted.',
    authorisedBy: 'chair',
    followedSeats: ['anthropic-seat'],
    setAsideSeats: ['google-seat'],
    dissentAcknowledged: true,
    createdAt: COMPLETED_AT,
    ...overrides,
  } as ChairRulingRecord;
}

function projectResolution(
  projectId = 'project-alpha',
  overrides: Partial<ResolutionRecord> = {},
): ResolutionRecord {
  return {
    resolutionId: 'resolution-1',
    runId: 'run-1',
    motionId: 'motion-1',
    rulingId: 'ruling-1',
    scope: 'project',
    projectId,
    title: 'Durable record store',
    decision: 'Use an append-only scoped store.',
    createdAt: COMPLETED_AT,
    ...overrides,
  } as ResolutionRecord;
}

describe('versioned session records', () => {
  test('reads a legacy record and reports its evidence as unavailable', () => {
    // The eight records written before the execution snapshot existed carry no schemaVersion. They
    // must stay readable, and must never be back-filled: a caller has to be able to tell "never
    // captured" from "captured and empty", or an evaluation counts missing evidence as a result.
    const legacy = {
      runId: 'run-legacy',
      motionId: 'motion-legacy',
      scope: 'general',
      status: 'completed',
      motion: 'A motion recorded before evidence capture existed.',
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      policyDecision: { kind: 'allowed', classification: 'public', reasonCodes: [] },
      destinations: [],
      protocol: ORDINARY_PROTOCOL,
      summary: 'Recorded without decision-level evidence.',
    };
    const parsed = SessionRecordSchema.parse(legacy);
    expect('schemaVersion' in parsed).toBe(false);
    expect(sessionDataAvailability(parsed)).toBe('unavailable');
  });

  test('a current record reports its evidence as captured', () => {
    expect(sessionDataAvailability(projectSession())).toBe('captured');
  });

  test('refuses a legacy record carrying a partial execution snapshot', () => {
    // Half-migrated records are the dangerous shape: they would read as legacy while claiming to
    // hold evidence. Strict objects on both arms of the union reject them outright.
    expect(() =>
      SessionRecordSchema.parse({
        runId: 'run-partial',
        motionId: 'motion-partial',
        scope: 'general',
        status: 'completed',
        motion: 'A record with an execution field but no version.',
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        policyDecision: { kind: 'allowed', classification: 'public', reasonCodes: [] },
        destinations: [],
        protocol: ORDINARY_PROTOCOL,
        execution: EXECUTION_SNAPSHOT,
      }),
    ).toThrow();
  });

  test('refuses a current record whose decision state contradicts its status', () => {
    expect(() =>
      CurrentSessionRecordSchema.parse({
        ...projectSession(),
        status: 'blocked-quorum',
        decisionState: 'awaiting-adjudication',
      }),
    ).toThrow(/must persist decisionState not-adjudicable/i);
  });

  test('refuses a record whose completion precedes its start', () => {
    // Both timestamps used to be the same post-run value, so nothing guarded ordering.
    expect(() =>
      CurrentSessionRecordSchema.parse({
        ...projectSession(),
        startedAt: COMPLETED_AT,
        completedAt: STARTED_AT,
      }),
    ).toThrow(/completedAt must not precede startedAt/i);
  });

  test('a real runner round still satisfies the persisted round contract', () => {
    // The persistence shape is pinned separately from the runtime type on purpose. This is the guard
    // that turns that decision into a caught test failure rather than a corrupted archive.
    const runtimeRound = RoundExecutionSchema.parse({
      round: 1,
      phase: 'analysis',
      responses: EXECUTION_SNAPSHOT.rounds[0]?.responses,
      retries: [
        {
          seatId: 'openai-seat',
          provider: 'openai',
          role: 'risk',
          attempt: 2,
          reason: {
            status: 'failed',
            error: { code: 'network', message: 'transient reset', retryable: true },
          },
        },
      ],
    });
    expect(() => PersistedRoundSchema.parse(runtimeRound)).not.toThrow();
  });
});

describe('CouncilStore', () => {
  test('publishes an append-only destination exactly once under concurrent writers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'council-atomic-record-'));
    const destination = join(root, 'records', 'shared.json');
    const first = '{"writer":"first"}\n';
    const second = '{"writer":"second"}\n';

    try {
      const results = await Promise.allSettled([
        writeTextAtomically(destination, first, { replace: false }),
        writeTextAtomically(destination, second, { replace: false }),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      const persisted = await Bun.file(destination).text();

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect([first, second]).toContain(persisted);
      expect(rejected[0]?.reason).toBeInstanceOf(Error);
      expect(String(rejected[0]?.reason)).toMatch(/append-only record/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('project writes cannot mutate general history', async () => {
    await withCouncilFixture(async (root, store) => {
      const record = projectSession();
      await store.writeSession(record);

      const jsonPath = join(root, 'projects', 'project-alpha', 'sessions', 'run-1.json');
      const markdownPath = join(root, 'projects', 'project-alpha', 'sessions', 'run-1.md');
      expect(await Bun.file(jsonPath).exists()).toBe(true);
      expect(JSON.parse(await Bun.file(jsonPath).text())).toEqual(record);
      expect(await Bun.file(join(root, 'general', 'ledger.md')).text()).toBe(GENERAL_LEDGER);
      expect(await Bun.file(markdownPath).text()).toBe(
        '# Council session run-1\n\n' +
          '- Motion ID: `motion-1`\n' +
          '- Scope: `project`\n' +
          '- Project ID: `project-alpha`\n' +
          '- Project: Project Alpha\n' +
          '- Status: `completed`\n' +
          `- Started: ${STARTED_AT}\n` +
          `- Completed: ${COMPLETED_AT}\n` +
          '- Policy: `allowed`\n' +
          '- Classification: `internal`\n' +
          '- Destinations: `anthropic/claude-opus-5`\n\n' +
          '## Motion\n\n' +
          'Choose the durable record store.\n\n' +
          '## Summary\n\n' +
          'Use an append-only scoped store.\n',
      );
    });
  });

  test('general records stay in the general scope', async () => {
    await withCouncilFixture(async (root, store) => {
      await store.writeSession(generalSession());

      expect(await Bun.file(join(root, 'general', 'sessions', 'run-general.json')).exists()).toBe(
        true,
      );
      expect(await Bun.file(join(root, 'projects', 'run-general.json')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'general', 'ledger.md')).text()).toBe(GENERAL_LEDGER);
    });
  });

  test('keeps general and project resolutions in separate ledgers', async () => {
    await withCouncilFixture(async (root, store) => {
      await store.writeSession(projectSession());
      await store.writeSession(generalSession({ motion: 'Choose the harness-wide release gate.' }));

      await store.appendChairRuling(projectRuling());
      await store.appendResolution(projectResolution());
      await store.appendChairRuling(generalRuling());
      await store.appendResolution({
        resolutionId: 'resolution-general',
        runId: 'run-general',
        motionId: 'motion-general',
        rulingId: 'ruling-general',
        scope: 'general',
        title: 'Harness-wide release gate',
        decision: 'Keep the release gate generic.',
        createdAt: COMPLETED_AT,
      });

      const projectLedger = await Bun.file(
        join(root, 'projects', 'project-alpha', 'ledger.md'),
      ).text();
      const generalLedger = await Bun.file(join(root, 'general', 'ledger.md')).text();

      expect(projectLedger).toContain('<!-- council-resolution:resolution-1 -->');
      expect(projectLedger).not.toContain('resolution-general');
      expect(generalLedger).toContain('<!-- council-resolution:resolution-general -->');
      expect(generalLedger).not.toContain('resolution-1');
    });
  });

  test('schema-invalid persisted JSON fails closed before mutation', async () => {
    await withCouncilFixture(async (root, store) => {
      const sessions = join(root, 'projects', 'project-alpha', 'sessions');
      await mkdir(sessions, { recursive: true });
      await Bun.write(join(sessions, 'broken.json'), '{"runId":"broken"}');

      await expect(
        store.writeSession(
          projectSession('project-alpha', {
            runId: 'run-2',
            motionId: 'motion-2',
          }),
        ),
      ).rejects.toThrow(/invalid persisted session/i);

      expect(await Bun.file(join(sessions, 'run-2.json')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'general', 'ledger.md')).text()).toBe(GENERAL_LEDGER);
    });
  });

  test('appends only identity-stable retries of one motion', async () => {
    await withCouncilFixture(async (root, store) => {
      const assignmentsFor = (runId: string, lensName = 'architect') => [
        {
          runId,
          motionId: 'motion-1',
          seatId: 'openai-seat',
          lensName,
          chairOverride: null,
        },
      ];
      await store.writeSession(
        projectSession('project-alpha', {
          assignments: assignmentsFor('run-1'),
        }),
      );
      const priorPath = join(root, 'projects', 'project-alpha', 'sessions', 'run-1.json');
      const priorBytes = await Bun.file(priorPath).bytes();

      await store.writeSession(
        projectSession('project-alpha', {
          runId: 'run-2',
          assignments: assignmentsFor('run-2'),
        }),
      );

      expect(await Bun.file(priorPath).bytes()).toEqual(priorBytes);
      const retry = JSON.parse(
        await Bun.file(join(root, 'projects', 'project-alpha', 'sessions', 'run-2.json')).text(),
      );
      expect(retry).toMatchObject({
        runId: 'run-2',
        motionId: 'motion-1',
      });

      await expect(
        store.writeSession(
          projectSession('project-alpha', {
            runId: 'run-3',
            assignments: assignmentsFor('run-3', 'maintainer'),
          }),
        ),
      ).rejects.toThrow(/different role assignments/i);
      await expect(
        store.writeSession(
          projectSession('project-alpha', {
            runId: 'run-4',
            motion: 'Choose a different recovery policy.',
            assignments: assignmentsFor('run-4'),
          }),
        ),
      ).rejects.toThrow(/different motion/i);
      for (const runId of ['run-3', 'run-4']) {
        expect(
          await Bun.file(
            join(root, 'projects', 'project-alpha', 'sessions', `${runId}.json`),
          ).exists(),
        ).toBe(false);
      }
    });
  });

  test('fails closed on schema-valid persisted motion identity drift', async () => {
    await withCouncilFixture(async (root, store) => {
      const assignment = (runId: string, lensName: string) => ({
        runId,
        motionId: 'motion-1',
        seatId: 'openai-seat',
        lensName,
        chairOverride: null,
      });
      await store.writeSession(
        projectSession('project-alpha', {
          assignments: [assignment('run-1', 'architect')],
        }),
      );
      const sessions = join(root, 'projects', 'project-alpha', 'sessions');
      await Bun.write(
        join(sessions, 'run-2.json'),
        `${JSON.stringify(
          projectSession('project-alpha', {
            runId: 'run-2',
            assignments: [assignment('run-2', 'maintainer')],
          }),
          null,
          2,
        )}\n`,
      );

      await expect(
        store.readAssignmentHistory(
          'project',
          {
            motionId: 'motion-1',
            motion: 'Choose the durable record store.',
          },
          'project-alpha',
        ),
      ).rejects.toThrow(/inconsistent persisted motion identity/i);
    });
  });

  test('requires a persisted chair acceptance before resolving a degraded session', async () => {
    await withCouncilFixture(async (root, store) => {
      await store.writeSession(projectSession('project-alpha', { status: 'degraded' }));
      const resolution = projectResolution();

      await expect(store.appendResolution(resolution)).rejects.toThrow(/chair acceptance/i);

      const acceptance: ChairAcceptanceRecord = {
        acceptanceId: 'acceptance-1',
        runId: 'run-1',
        motionId: 'motion-1',
        scope: 'project',
        projectId: 'project-alpha',
        rationale: 'The remaining uncertainty is explicitly accepted.',
        authorisedBy: 'council-chair',
        createdAt: COMPLETED_AT,
      };
      await store.appendChairAcceptance(acceptance);
      await store.appendChairRuling(projectRuling());
      await store.appendResolution(resolution);

      expect(
        JSON.parse(
          await Bun.file(
            join(root, 'projects', 'project-alpha', 'chair-acceptances', 'acceptance-1.json'),
          ).text(),
        ),
      ).toEqual(acceptance);
      expect(
        await Bun.file(
          join(root, 'projects', 'project-alpha', 'resolutions', 'resolution-1.json'),
        ).exists(),
      ).toBe(true);
    });
  });

  test('permits only one resolution across completed retries of a motion', async () => {
    await withCouncilFixture(async (root, store) => {
      await store.writeSession(projectSession());
      await store.writeSession(
        projectSession('project-alpha', {
          runId: 'run-2',
        }),
      );
      await store.appendChairRuling(projectRuling());
      await store.appendResolution(projectResolution());
      await store.appendChairRuling(
        projectRuling('project-alpha', { rulingId: 'ruling-2', runId: 'run-2' }),
      );
      const retryResolution = projectResolution('project-alpha', {
        resolutionId: 'resolution-2',
        runId: 'run-2',
        rulingId: 'ruling-2',
      });

      await expect(store.appendResolution(retryResolution)).rejects.toThrow(
        /motion already has a resolution/i,
      );
      const resolutions = join(root, 'projects', 'project-alpha', 'resolutions');
      expect(await Bun.file(join(resolutions, 'resolution-2.json')).exists()).toBe(false);

      await Bun.write(
        join(resolutions, 'resolution-2.json'),
        `${JSON.stringify(retryResolution, null, 2)}\n`,
      );
      await expect(
        store.readAssignmentHistory(
          'project',
          {
            motionId: 'motion-1',
            motion: 'Choose the durable record store.',
          },
          'project-alpha',
        ),
      ).rejects.toThrow(/duplicate persisted resolution motion/i);
    });
  });

  test('serialises concurrent resolution appends without losing either ledger entry', async () => {
    await withCouncilFixture(async (root, store) => {
      await Promise.all([
        store.writeSession(projectSession()),
        CouncilStore.open(root).writeSession(
          projectSession('project-alpha', {
            runId: 'run-2',
            motionId: 'motion-2',
            motion: 'Choose the recovery policy.',
          }),
        ),
      ]);

      await store.appendChairRuling(projectRuling());
      await store.appendChairRuling(
        projectRuling('project-alpha', {
          rulingId: 'ruling-2',
          runId: 'run-2',
          motionId: 'motion-2',
          title: 'Recovery policy',
          decision: 'Use bounded recovery.',
        }),
      );

      await Promise.all([
        store.appendResolution(projectResolution()),
        CouncilStore.open(root).appendResolution(
          projectResolution('project-alpha', {
            resolutionId: 'resolution-2',
            runId: 'run-2',
            motionId: 'motion-2',
            rulingId: 'ruling-2',
            title: 'Recovery policy',
            decision: 'Use bounded recovery.',
          }),
        ),
      ]);

      const ledger = await Bun.file(join(root, 'projects', 'project-alpha', 'ledger.md')).text();
      expect(ledger).toContain('<!-- council-resolution:resolution-1 -->');
      expect(ledger).toContain('<!-- council-resolution:resolution-2 -->');
      expect(ledger).toContain('Use an append-only scoped store.');
      expect(ledger).toContain('Use bounded recovery.');
    });
  });

  test('appends a ledger resolution only for a validated completed session', async () => {
    await withCouncilFixture(async (root, store) => {
      await store.writeSession(projectSession());
      await store.appendChairRuling(projectRuling());
      await store.appendResolution(projectResolution());

      const projectLedger = await Bun.file(
        join(root, 'projects', 'project-alpha', 'ledger.md'),
      ).text();
      expect(projectLedger).toContain('<!-- council-resolution:resolution-1 -->');
      expect(projectLedger).toContain('## Durable record store');
      expect(projectLedger).toContain('Use an append-only scoped store.');
      expect(await Bun.file(join(root, 'general', 'ledger.md')).text()).toBe(GENERAL_LEDGER);

      await store.writeSession(
        projectSession('blocked-project', {
          runId: 'run-blocked',
          motionId: 'motion-blocked',
          projectDisplayName: 'Blocked project',
          status: 'blocked-quorum',
          decisionState: 'not-adjudicable',
          completedAt: undefined,
          summary: undefined,
        }),
      );

      await expect(
        store.appendResolution({
          resolutionId: 'resolution-blocked',
          runId: 'run-blocked',
          motionId: 'motion-blocked',
          rulingId: 'ruling-blocked',
          scope: 'project',
          projectId: 'blocked-project',
          title: 'Must not be recorded',
          decision: 'Accept a result without quorum.',
          createdAt: COMPLETED_AT,
        }),
      ).rejects.toThrow(/accepted session/i);

      expect(await Bun.file(join(root, 'projects', 'blocked-project', 'ledger.md')).exists()).toBe(
        false,
      );
    });
  });
});
