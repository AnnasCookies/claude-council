import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyGeneralMigration,
  planGeneralMigration,
  type MigrationPlan,
} from '../../src/records/migrate-general';

const SOURCE_LEDGER =
  '# General ledger\n\n' +
  '## Harness release governance\n\n' +
  '**Scope:** general\n\n' +
  'Keep release verification generic.\n\n' +
  '## Project Alpha architecture decision\n\n' +
  '**Project:** project-alpha\n\n' +
  'Use the event-driven design.\n\n' +
  '## Project Beta retrieval decision\n\n' +
  '**Project:** project-beta\n\n' +
  'Retain source provenance.\n';

const REAL_LEDGER_SHAPE =
  '# Ledger: General\n\n' +
  '## Open action items\n\n' +
  '- [ ] Project Alpha follow-up.\n' +
  '- [ ] General harness action.\n\n' +
  '## Resolutions\n\n' +
  '### Project Alpha architecture decision\n\n' +
  '**Resolution:** Use the event-driven design.\n\n' +
  '### Harness release governance\n\n' +
  '**Resolution:** Keep release verification generic.\n';

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

async function withMigrationFixture(
  run: (root: string, sourcePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-migration-'));
  const sourcePath = join(root, 'general', 'ledger.md');
  await mkdir(join(root, 'general'), { recursive: true });
  await Bun.write(sourcePath, SOURCE_LEDGER);

  try {
    await run(root, sourcePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function approve(plan: MigrationPlan): MigrationPlan {
  return {
    ...plan,
    approval: {
      approved: true,
      planSha256: plan.planSha256,
      approvedBy: 'test-reviewer',
      approvedAt: '2026-07-27T11:00:00.000Z',
      reason: 'The three deterministic destinations were reviewed.',
    },
  };
}

describe('general ledger migration', () => {
  test('plans mixed history without writing and exposes every proposed destination', async () => {
    await withMigrationFixture(async (root, sourcePath) => {
      const sourceBefore = await Bun.file(sourcePath).bytes();
      const plan = planGeneralMigration({
        root,
        sourceRelativePath: 'general/ledger.md',
        sourceContent: SOURCE_LEDGER,
        plannedAt: '2026-07-27T10:00:00.000Z',
        rules: [
          {
            id: 'harness-general',
            contains: '**Scope:** general',
            destination: { scope: 'general' },
          },
          {
            id: 'project-alpha-rule',
            contains: '**Project:** project-alpha',
            destination: { scope: 'project', projectId: 'project-alpha' },
          },
          {
            id: 'project-beta-rule',
            contains: '**Project:** project-beta',
            destination: { scope: 'project', projectId: 'project-beta' },
          },
        ],
      });

      expect(plan.approval).toBeUndefined();
      expect(plan.items.map((item) => item.destination)).toEqual([
        { scope: 'general' },
        { scope: 'project', projectId: 'project-alpha' },
        { scope: 'project', projectId: 'project-beta' },
      ]);
      expect(plan.unresolved).toEqual([]);
      expect(await Bun.file(sourcePath).bytes()).toEqual(sourceBefore);
      expect(await Bun.file(join(root, plan.archiveRelativePath)).exists()).toBe(false);
      expect(await Bun.file(join(root, 'projects', 'project-alpha', 'ledger.md')).exists()).toBe(
        false,
      );
    });
  });

  test('classifies action and resolution entries independently in a real ledger shape', () => {
    const plan = planGeneralMigration({
      root: 'C:/council',
      sourceContent: REAL_LEDGER_SHAPE,
      plannedAt: '2026-07-27T10:00:00.000Z',
      rules: [
        {
          id: 'open-actions-general',
          contains: '## Open action items',
          destination: { scope: 'general' },
        },
        {
          id: 'project-alpha-action',
          contains: '- [ ] Project Alpha follow-up.',
          destination: { scope: 'project', projectId: 'project-alpha' },
        },
        {
          id: 'general-action',
          contains: '- [ ] General harness action.',
          destination: { scope: 'general' },
        },
        {
          id: 'resolutions-container-general',
          contains: '## Resolutions',
          destination: { scope: 'general' },
        },
        {
          id: 'project-alpha-rule',
          contains: '### Project Alpha architecture decision',
          destination: { scope: 'project', projectId: 'project-alpha' },
        },
        {
          id: 'harness-general',
          contains: '### Harness release governance',
          destination: { scope: 'general' },
        },
      ],
    });

    expect(plan.counts).toEqual({
      sourceEntries: 6,
      generalEntries: 4,
      projectEntries: 2,
      unresolvedEntries: 0,
    });
    expect(
      plan.items.filter((item) => item.destination.scope === 'project').map((item) => item.heading),
    ).toEqual(['Project Alpha follow-up.', 'Project Alpha architecture decision']);
  });

  test('requires explicit approval before any migration write', async () => {
    await withMigrationFixture(async (root, sourcePath) => {
      const plan = planGeneralMigration({
        root,
        sourceContent: SOURCE_LEDGER,
        plannedAt: '2026-07-27T10:00:00.000Z',
        rules: [
          {
            id: 'everything-general',
            contains: '## ',
            destination: { scope: 'general' },
          },
        ],
      });
      const sourceBefore = await Bun.file(sourcePath).bytes();

      await expect(applyGeneralMigration(plan)).rejects.toThrow(/approval/i);

      expect(await Bun.file(sourcePath).bytes()).toEqual(sourceBefore);
      expect(await Bun.file(join(root, plan.archiveRelativePath)).exists()).toBe(false);
    });
  });

  test('archives the byte-identical source, copies projects with provenance and rebuilds general', async () => {
    await withMigrationFixture(async (root, sourcePath) => {
      const originalBytes = await Bun.file(sourcePath).bytes();
      const originalHash = sha256(originalBytes);
      const plan = planGeneralMigration({
        root,
        sourceRelativePath: 'general/ledger.md',
        sourceContent: SOURCE_LEDGER,
        plannedAt: '2026-07-27T10:00:00.000Z',
        rules: [
          {
            id: 'harness-general',
            contains: '**Scope:** general',
            destination: { scope: 'general' },
          },
          {
            id: 'project-alpha-rule',
            contains: '**Project:** project-alpha',
            destination: { scope: 'project', projectId: 'project-alpha' },
          },
          {
            id: 'project-beta-rule',
            contains: '**Project:** project-beta',
            destination: { scope: 'project', projectId: 'project-beta' },
          },
        ],
      });
      expect(plan.archiveRelativePath).toStartWith('archive/2026-07-27-general/');

      const manifest = await applyGeneralMigration(approve(plan));
      const archivePath = join(root, plan.archiveRelativePath);
      const archiveBytes = await Bun.file(archivePath).bytes();
      const activeGeneral = await Bun.file(sourcePath).text();
      const alphaLedger = await Bun.file(
        join(root, 'projects', 'project-alpha', 'ledger.md'),
      ).text();
      const betaLedger = await Bun.file(join(root, 'projects', 'project-beta', 'ledger.md')).text();

      expect(archiveBytes).toEqual(originalBytes);
      expect(manifest.source.sha256).toBe(originalHash);
      expect(manifest.source.archiveSha256).toBe(originalHash);
      expect(activeGeneral).toContain('Harness release governance');
      const generalItem = plan.items.find((item) => item.destination.scope === 'general');
      expect(generalItem).toBeDefined();
      expect(activeGeneral).toContain(`source-sha256: ${originalHash}`);
      expect(activeGeneral).toContain(`plan-sha256: ${plan.planSha256}`);
      expect(activeGeneral).toContain(
        `<!-- council-migration:${plan.planSha256}:${generalItem?.sha256} -->`,
      );
      expect(activeGeneral).not.toContain('Project Alpha architecture decision');
      expect(activeGeneral).not.toContain('Project Beta retrieval decision');
      expect(alphaLedger).toContain(`source-sha256: ${originalHash}`);
      expect(alphaLedger).toContain(`plan-sha256: ${plan.planSha256}`);
      expect(alphaLedger).toContain('Project Alpha architecture decision');
      expect(betaLedger).toContain('Project Beta retrieval decision');

      for (const destination of manifest.destinations) {
        const bytes = await Bun.file(join(root, destination.relativePath)).bytes();
        expect(destination.sha256).toBe(sha256(bytes));
      }

      expect(await Bun.file(archivePath).bytes()).toEqual(originalBytes);
    });
  });

  test('fails closed when a plan has unresolved entries', async () => {
    await withMigrationFixture(async (root, sourcePath) => {
      const plan = planGeneralMigration({
        root,
        sourceContent: SOURCE_LEDGER,
        plannedAt: '2026-07-27T10:00:00.000Z',
        rules: [],
      });
      const sourceBefore = await Bun.file(sourcePath).bytes();

      expect(plan.unresolved).toHaveLength(3);
      await expect(applyGeneralMigration(approve(plan))).rejects.toThrow(/unresolved/i);
      expect(await Bun.file(sourcePath).bytes()).toEqual(sourceBefore);
      expect(await Bun.file(join(root, plan.archiveRelativePath)).exists()).toBe(false);
    });
  });
});
