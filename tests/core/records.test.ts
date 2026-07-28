import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CouncilStore,
  SessionRecordSchema,
  writeTextAtomically,
  type ChairAcceptanceRecord,
  type ResolutionRecord,
  type SessionRecord,
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
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return SessionRecordSchema.parse({
    runId: 'run-1',
    motionId: 'motion-1',
    scope: 'project',
    projectId,
    projectDisplayName: 'Project Alpha',
    status: 'completed',
    motion: 'Choose the durable record store.',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    policyDecision: {
      kind: 'allowed',
      classification: 'internal',
      reasonCodes: [],
    },
    protocol: ORDINARY_PROTOCOL,
    destinations: [{ provider: 'anthropic', model: 'claude-opus-5' }],
    summary: 'Use an append-only scoped store.',
    ...overrides,
  });
}

function projectResolution(
  projectId = 'project-alpha',
  overrides: Partial<ResolutionRecord> = {},
): ResolutionRecord {
  return {
    resolutionId: 'resolution-1',
    runId: 'run-1',
    motionId: 'motion-1',
    scope: 'project',
    projectId,
    title: 'Durable record store',
    decision: 'Use an append-only scoped store.',
    createdAt: COMPLETED_AT,
    ...overrides,
  };
}

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
      await store.writeSession(
        SessionRecordSchema.parse({
          runId: 'run-general',
          motionId: 'motion-general',
          scope: 'general',
          status: 'completed',
          motion: 'Choose a harness-wide release gate.',
          startedAt: STARTED_AT,
          completedAt: COMPLETED_AT,
          policyDecision: {
            kind: 'allowed',
            classification: 'public',
            reasonCodes: [],
          },
          destinations: [],
          protocol: ORDINARY_PROTOCOL,
          summary: 'Keep the release gate generic.',
        }),
      );

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
      await store.writeSession(
        SessionRecordSchema.parse({
          runId: 'run-general',
          motionId: 'motion-general',
          scope: 'general',
          status: 'completed',
          motion: 'Choose the harness-wide release gate.',
          startedAt: STARTED_AT,
          completedAt: COMPLETED_AT,
          policyDecision: {
            kind: 'allowed',
            classification: 'public',
            reasonCodes: [],
          },
          destinations: [],
          protocol: ORDINARY_PROTOCOL,
          summary: 'Keep the release gate generic.',
        }),
      );

      await store.appendResolution(projectResolution());
      await store.appendResolution({
        resolutionId: 'resolution-general',
        runId: 'run-general',
        motionId: 'motion-general',
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
      await store.appendResolution(projectResolution());
      const retryResolution = projectResolution('project-alpha', {
        resolutionId: 'resolution-2',
        runId: 'run-2',
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

      await Promise.all([
        store.appendResolution(projectResolution()),
        CouncilStore.open(root).appendResolution(
          projectResolution('project-alpha', {
            resolutionId: 'resolution-2',
            runId: 'run-2',
            motionId: 'motion-2',
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
          completedAt: undefined,
          summary: undefined,
        }),
      );

      await expect(
        store.appendResolution({
          resolutionId: 'resolution-blocked',
          runId: 'run-blocked',
          motionId: 'motion-blocked',
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
