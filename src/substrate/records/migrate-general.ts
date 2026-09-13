import { chmod } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { sha256Hex, writeTextAtomically } from './store';

const NonEmptyStringSchema = z.string().trim().min(1);
const SingleLineStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');
const TimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StorageIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
  .refine((value) => value !== '.' && value !== '..', 'must be a safe storage identifier');
const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\\/g, '/').replace(/\/+/g, '/'))
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !win32.isAbsolute(value) &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'must be a safe relative path',
  );

const GeneralMigrationDestinationSchema = z.strictObject({
  scope: z.literal('general'),
});
const ProjectMigrationDestinationSchema = z.strictObject({
  scope: z.literal('project'),
  projectId: StorageIdSchema,
});
export const MigrationDestinationSchema = z.discriminatedUnion('scope', [
  GeneralMigrationDestinationSchema,
  ProjectMigrationDestinationSchema,
]);
export type MigrationDestination = z.infer<typeof MigrationDestinationSchema>;

export const MigrationRuleSchema = z.strictObject({
  id: StorageIdSchema,
  contains: NonEmptyStringSchema,
  caseSensitive: z.boolean().default(false),
  destination: MigrationDestinationSchema,
});
export type MigrationRule = z.infer<typeof MigrationRuleSchema>;

export const MigrationApprovalSchema = z.strictObject({
  approved: z.literal(true),
  planSha256: Sha256Schema,
  approvedBy: SingleLineStringSchema,
  approvedAt: TimestampSchema,
  reason: NonEmptyStringSchema,
});
export type MigrationApproval = z.infer<typeof MigrationApprovalSchema>;

export const MigrationPlanInputSchema = z
  .strictObject({
    root: NonEmptyStringSchema,
    sourceRelativePath: RelativePathSchema.default('general/ledger.md'),
    sourceContent: z.string(),
    plannedAt: TimestampSchema,
    rules: z.array(MigrationRuleSchema),
  })
  .superRefine((input, context) => {
    const ruleIds = new Set<string>();
    for (const [index, rule] of input.rules.entries()) {
      if (ruleIds.has(rule.id)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: 'migration rule ids must be unique',
        });
      }
      ruleIds.add(rule.id);
    }
  });
export type MigrationPlanInput = z.input<typeof MigrationPlanInputSchema>;

export const MigrationItemSchema = z.strictObject({
  sourceIndex: z.number().int().nonnegative(),
  heading: SingleLineStringSchema,
  markdown: NonEmptyStringSchema,
  sha256: Sha256Schema,
  matchedRuleId: StorageIdSchema,
  destination: MigrationDestinationSchema,
});
export type MigrationItem = z.infer<typeof MigrationItemSchema>;

export const UnresolvedMigrationItemSchema = z.strictObject({
  sourceIndex: z.number().int().nonnegative(),
  heading: SingleLineStringSchema,
  markdown: NonEmptyStringSchema,
  sha256: Sha256Schema,
  reason: z.enum(['no-match', 'ambiguous-match']),
  matchedRuleIds: z.array(StorageIdSchema),
});
export type UnresolvedMigrationItem = z.infer<typeof UnresolvedMigrationItemSchema>;

const MigrationCountsSchema = z.strictObject({
  sourceEntries: z.number().int().nonnegative(),
  generalEntries: z.number().int().nonnegative(),
  projectEntries: z.number().int().nonnegative(),
  unresolvedEntries: z.number().int().nonnegative(),
});

const MigrationPlanBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: NonEmptyStringSchema,
  sourceRelativePath: RelativePathSchema,
  sourceContent: z.string(),
  sourceSha256: Sha256Schema,
  plannedAt: TimestampSchema,
  archiveRelativePath: RelativePathSchema,
  rules: z.array(MigrationRuleSchema),
  items: z.array(MigrationItemSchema),
  unresolved: z.array(UnresolvedMigrationItemSchema),
  counts: MigrationCountsSchema,
});
type MigrationPlanBody = z.infer<typeof MigrationPlanBodySchema>;

const MigrationPlanObjectSchema = MigrationPlanBodySchema.extend({
  planSha256: Sha256Schema,
  approval: MigrationApprovalSchema.optional(),
});

export const MigrationPlanSchema = MigrationPlanObjectSchema.superRefine((plan, context) => {
  if (sha256Hex(plan.sourceContent) !== plan.sourceSha256) {
    context.addIssue({
      code: 'custom',
      path: ['sourceSha256'],
      message: 'sourceSha256 does not match sourceContent',
    });
  }

  const generalEntries = plan.items.filter((item) => item.destination.scope === 'general').length;
  const projectEntries = plan.items.length - generalEntries;
  const expectedCounts = {
    sourceEntries: plan.items.length + plan.unresolved.length,
    generalEntries,
    projectEntries,
    unresolvedEntries: plan.unresolved.length,
  };
  const countKeys = [
    'sourceEntries',
    'generalEntries',
    'projectEntries',
    'unresolvedEntries',
  ] satisfies readonly (keyof typeof expectedCounts)[];
  for (const key of countKeys) {
    if (plan.counts[key] !== expectedCounts[key]) {
      context.addIssue({
        code: 'custom',
        path: ['counts', key],
        message: `${key} does not match the planned entries`,
      });
    }
  }

  const rulesById = new Map(plan.rules.map((rule) => [rule.id, rule]));
  if (rulesById.size !== plan.rules.length) {
    context.addIssue({
      code: 'custom',
      path: ['rules'],
      message: 'migration rule ids must be unique',
    });
  }

  const sourceIndexes = new Set<number>();
  for (const [index, item] of plan.items.entries()) {
    if (sha256Hex(item.markdown) !== item.sha256) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'sha256'],
        message: 'item sha256 does not match its Markdown',
      });
    }
    const rule = rulesById.get(item.matchedRuleId);
    if (!rule || JSON.stringify(rule.destination) !== JSON.stringify(item.destination)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'matchedRuleId'],
        message: 'item does not match its declared migration rule',
      });
    }
    if (sourceIndexes.has(item.sourceIndex)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'sourceIndex'],
        message: 'source indexes must be unique',
      });
    }
    sourceIndexes.add(item.sourceIndex);
  }

  for (const [index, item] of plan.unresolved.entries()) {
    if (sha256Hex(item.markdown) !== item.sha256) {
      context.addIssue({
        code: 'custom',
        path: ['unresolved', index, 'sha256'],
        message: 'unresolved item sha256 does not match its Markdown',
      });
    }
    if (item.matchedRuleIds.some((ruleId) => !rulesById.has(ruleId))) {
      context.addIssue({
        code: 'custom',
        path: ['unresolved', index, 'matchedRuleIds'],
        message: 'unresolved item references an unknown migration rule',
      });
    }
    if (sourceIndexes.has(item.sourceIndex)) {
      context.addIssue({
        code: 'custom',
        path: ['unresolved', index, 'sourceIndex'],
        message: 'source indexes must be unique',
      });
    }
    sourceIndexes.add(item.sourceIndex);
  }

  for (let index = 0; index < plan.counts.sourceEntries; index += 1) {
    if (!sourceIndexes.has(index)) {
      context.addIssue({
        code: 'custom',
        path: ['counts', 'sourceEntries'],
        message: 'source indexes must be contiguous',
      });
      break;
    }
  }
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

const GeneralDestinationHashSchema = z.strictObject({
  scope: z.literal('general'),
  relativePath: RelativePathSchema,
  itemCount: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});
const ProjectDestinationHashSchema = z.strictObject({
  scope: z.literal('project'),
  projectId: StorageIdSchema,
  relativePath: RelativePathSchema,
  itemCount: z.number().int().positive(),
  sha256: Sha256Schema,
});
export const MigrationDestinationHashSchema = z.discriminatedUnion('scope', [
  GeneralDestinationHashSchema,
  ProjectDestinationHashSchema,
]);
export type MigrationDestinationHash = z.infer<typeof MigrationDestinationHashSchema>;

export const MigrationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planSha256: Sha256Schema,
  appliedAt: TimestampSchema,
  approval: MigrationApprovalSchema,
  source: z.strictObject({
    relativePath: RelativePathSchema,
    sha256: Sha256Schema,
    byteLength: z.number().int().nonnegative(),
    archiveRelativePath: RelativePathSchema,
    archiveSha256: Sha256Schema,
  }),
  destinations: z.array(MigrationDestinationHashSchema),
  counts: MigrationCountsSchema,
  manifestRelativePath: RelativePathSchema,
});
export type MigrationManifest = z.infer<typeof MigrationManifestSchema>;

interface ParsedLedgerEntry {
  sourceIndex: number;
  heading: string;
  markdown: string;
  sha256: string;
}

interface PendingDestination {
  destination: MigrationDestination;
  relativePath: string;
  content: string;
  itemCount: number;
}

function parseLedgerEntries(source: string): readonly ParsedLedgerEntry[] {
  const headings = Array.from(source.matchAll(/^(#{2,3})[ \t]+([^\r\n]+?)[ \t]*\r?$/gm));
  const markers: Array<{ index: number; heading: string }> = headings.flatMap((match) =>
    match.index === undefined || match[2] === undefined
      ? []
      : [{ index: match.index, heading: match[2].trim() }],
  );

  for (const [headingIndex, match] of headings.entries()) {
    if (
      match.index === undefined ||
      match[1] !== '##' ||
      match[2]?.trim().toLowerCase() !== 'open action items'
    ) {
      continue;
    }
    const nextLevelTwo = headings
      .slice(headingIndex + 1)
      .find((candidate) => candidate[1] === '##' && candidate.index !== undefined);
    const sectionStart = match.index + match[0].length;
    const sectionEnd = nextLevelTwo?.index ?? source.length;
    const section = source.slice(sectionStart, sectionEnd);
    for (const action of section.matchAll(/^- \[[ xX~]\][ \t]+([^\r\n]+?)[ \t]*\r?$/gm)) {
      if (action.index === undefined || action[1] === undefined) continue;
      markers.push({
        index: sectionStart + action.index,
        heading: action[1].trim(),
      });
    }
  }

  markers.sort((left, right) => left.index - right.index);
  return markers.map((marker, sourceIndex) => {
    const end = markers[sourceIndex + 1]?.index ?? source.length;
    const markdown = source.slice(marker.index, end).trim();
    return {
      sourceIndex,
      heading: marker.heading,
      markdown,
      sha256: sha256Hex(markdown),
    };
  });
}

function planBodyHash(body: MigrationPlanBody): string {
  return sha256Hex(JSON.stringify(MigrationPlanBodySchema.parse(body)));
}

/** Classifies Markdown entries entirely in memory; it performs no filesystem writes. */
export function planGeneralMigration(input: MigrationPlanInput): MigrationPlan {
  const parsed = MigrationPlanInputSchema.parse(input);
  const sourceSha256 = sha256Hex(parsed.sourceContent);
  const entries = parseLedgerEntries(parsed.sourceContent);
  const items: MigrationItem[] = [];
  const unresolved: UnresolvedMigrationItem[] = [];

  for (const entry of entries) {
    const matchingRules = parsed.rules.filter((rule) => {
      if (rule.caseSensitive) return entry.markdown.includes(rule.contains);
      return entry.markdown.toLowerCase().includes(rule.contains.toLowerCase());
    });

    if (matchingRules.length !== 1) {
      unresolved.push({
        ...entry,
        reason: matchingRules.length === 0 ? 'no-match' : 'ambiguous-match',
        matchedRuleIds: matchingRules.map((rule) => rule.id),
      });
      continue;
    }

    const matchedRule = matchingRules[0];
    if (!matchedRule) throw new Error('Migration rule resolution failed');
    items.push({
      ...entry,
      matchedRuleId: matchedRule.id,
      destination: matchedRule.destination,
    });
  }

  const date = parsed.plannedAt.slice(0, 10);
  const archiveRelativePath = `archive/${date}-general/ledger-${sourceSha256.slice(0, 12)}.md`;
  const body = MigrationPlanBodySchema.parse({
    schemaVersion: 1,
    root: resolve(parsed.root),
    sourceRelativePath: parsed.sourceRelativePath,
    sourceContent: parsed.sourceContent,
    sourceSha256,
    plannedAt: parsed.plannedAt,
    archiveRelativePath,
    rules: parsed.rules,
    items,
    unresolved,
    counts: {
      sourceEntries: entries.length,
      generalEntries: items.filter((item) => item.destination.scope === 'general').length,
      projectEntries: items.filter((item) => item.destination.scope === 'project').length,
      unresolvedEntries: unresolved.length,
    },
  });

  return MigrationPlanSchema.parse({
    ...body,
    planSha256: planBodyHash(body),
  });
}

function absolutePathInsideRoot(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const destination = resolve(absoluteRoot, relativePath);
  const fromRoot = relative(absoluteRoot, destination);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) return destination;
  throw new Error(`Migration path escapes its root: ${relativePath}`);
}

function appendMarkdownBlocks(headerOrExisting: string, blocks: readonly string[]): string {
  let output = headerOrExisting;
  for (const block of blocks) {
    const separator = output.endsWith('\n\n') ? '' : output.endsWith('\n') ? '\n' : '\n\n';
    output = `${output}${separator}${block.trim()}\n`;
  }
  return output;
}

function migrationProvenance(plan: MigrationPlan, item: MigrationItem): string {
  return [
    `<!-- council-migration:${plan.planSha256}:${item.sha256} -->`,
    '<!-- migration-provenance',
    `source: ${plan.sourceRelativePath}`,
    `source-sha256: ${plan.sourceSha256}`,
    `entry-index: ${item.sourceIndex}`,
    `entry-sha256: ${item.sha256}`,
    `plan-sha256: ${plan.planSha256}`,
    '-->',
    item.markdown,
  ].join('\n');
}

async function prepareDestinations(plan: MigrationPlan): Promise<readonly PendingDestination[]> {
  const generalItems = plan.items
    .filter((item) => item.destination.scope === 'general')
    .sort((left, right) => left.sourceIndex - right.sourceIndex);
  const projectItems = new Map<string, MigrationItem[]>();

  for (const item of plan.items) {
    if (item.destination.scope !== 'project') continue;
    const group = projectItems.get(item.destination.projectId) ?? [];
    group.push(item);
    projectItems.set(item.destination.projectId, group);
  }

  const pending: PendingDestination[] = [];
  for (const projectId of [...projectItems.keys()].sort()) {
    const items = projectItems.get(projectId);
    if (!items) continue;
    items.sort((left, right) => left.sourceIndex - right.sourceIndex);
    const relativePath = `projects/${projectId}/ledger.md`;
    const destinationPath = absolutePathInsideRoot(plan.root, relativePath);
    const exists = await Bun.file(destinationPath).exists();
    const existing = exists
      ? await Bun.file(destinationPath).text()
      : `# Project ledger: ${projectId}\n`;
    const blocks = items.map((item) => migrationProvenance(plan, item));

    for (const item of items) {
      const marker = `<!-- council-migration:${plan.planSha256}:${item.sha256} -->`;
      if (existing.includes(marker)) {
        throw new Error(`Migration item is already present in ${relativePath}`);
      }
    }

    pending.push({
      destination: { scope: 'project', projectId },
      relativePath,
      content: appendMarkdownBlocks(existing, blocks),
      itemCount: items.length,
    });
  }

  pending.push({
    destination: { scope: 'general' },
    relativePath: plan.sourceRelativePath,
    content: appendMarkdownBlocks(
      '# General ledger\n',
      generalItems.map((item) => migrationProvenance(plan, item)),
    ),
    itemCount: generalItems.length,
  });

  return pending;
}

function migrationPlanBody(plan: MigrationPlan): MigrationPlanBody {
  return MigrationPlanBodySchema.parse({
    schemaVersion: plan.schemaVersion,
    root: plan.root,
    sourceRelativePath: plan.sourceRelativePath,
    sourceContent: plan.sourceContent,
    sourceSha256: plan.sourceSha256,
    plannedAt: plan.plannedAt,
    archiveRelativePath: plan.archiveRelativePath,
    rules: plan.rules,
    items: plan.items,
    unresolved: plan.unresolved,
    counts: plan.counts,
  });
}

function parseManifestJson(content: string): void {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error('Migration manifest serialisation produced invalid JSON', { cause: error });
  }
  MigrationManifestSchema.parse(value);
}

/** Applies only a hash-matched, explicitly authorised plan and publishes the archive first. */
export async function applyGeneralMigration(input: MigrationPlan): Promise<MigrationManifest> {
  const plan = MigrationPlanSchema.parse(input);
  if (!plan.approval) throw new Error('Migration requires explicit approval');
  if (plan.unresolved.length > 0) {
    throw new Error('Migration cannot apply while unresolved entries remain');
  }

  const body = migrationPlanBody(plan);
  const expectedPlanHash = planBodyHash(body);
  if (expectedPlanHash !== plan.planSha256) {
    throw new Error('Migration plan hash is stale or invalid');
  }
  if (plan.approval.planSha256 !== plan.planSha256) {
    throw new Error('Migration approval does not match the plan hash');
  }

  const sourcePath = absolutePathInsideRoot(plan.root, plan.sourceRelativePath);
  if (!(await Bun.file(sourcePath).exists())) {
    throw new Error('Migration source ledger does not exist');
  }
  const sourceBytes = await Bun.file(sourcePath).bytes();
  const currentSourceHash = sha256Hex(sourceBytes);
  if (
    currentSourceHash !== plan.sourceSha256 ||
    sha256Hex(plan.sourceContent) !== plan.sourceSha256
  ) {
    throw new Error('Migration source ledger changed after planning');
  }

  const archivePath = absolutePathInsideRoot(plan.root, plan.archiveRelativePath);
  const manifestRelativePath = plan.archiveRelativePath.replace(/\.md$/, '.manifest.json');
  const manifestPath = absolutePathInsideRoot(plan.root, manifestRelativePath);
  if ((await Bun.file(archivePath).exists()) || (await Bun.file(manifestPath).exists())) {
    throw new Error('Migration archive or manifest already exists');
  }

  const pendingDestinations = await prepareDestinations(plan);

  await writeTextAtomically(archivePath, plan.sourceContent, { replace: false });
  const archiveHash = sha256Hex(await Bun.file(archivePath).bytes());
  if (archiveHash !== plan.sourceSha256) {
    throw new Error('Migration archive hash does not match the planned source');
  }
  await chmod(archivePath, 0o444);

  const destinations: MigrationDestinationHash[] = [];
  for (const pending of pendingDestinations) {
    await writeTextAtomically(
      absolutePathInsideRoot(plan.root, pending.relativePath),
      pending.content,
    );
    const persistedHash = sha256Hex(
      await Bun.file(absolutePathInsideRoot(plan.root, pending.relativePath)).bytes(),
    );
    const intendedHash = sha256Hex(pending.content);
    if (persistedHash !== intendedHash) {
      throw new Error(`Migration destination hash mismatch: ${pending.relativePath}`);
    }

    destinations.push(
      pending.destination.scope === 'general'
        ? {
            scope: 'general',
            relativePath: pending.relativePath,
            itemCount: pending.itemCount,
            sha256: persistedHash,
          }
        : {
            scope: 'project',
            projectId: pending.destination.projectId,
            relativePath: pending.relativePath,
            itemCount: pending.itemCount,
            sha256: persistedHash,
          },
    );
  }

  const destinationItemCount = destinations.reduce((total, item) => total + item.itemCount, 0);
  if (destinationItemCount !== plan.items.length) {
    throw new Error('Migration destination count does not match the approved plan');
  }

  const manifest = MigrationManifestSchema.parse({
    schemaVersion: 1,
    planSha256: plan.planSha256,
    appliedAt: plan.approval.approvedAt,
    approval: plan.approval,
    source: {
      relativePath: plan.sourceRelativePath,
      sha256: plan.sourceSha256,
      byteLength: sourceBytes.byteLength,
      archiveRelativePath: plan.archiveRelativePath,
      archiveSha256: archiveHash,
    },
    destinations,
    counts: plan.counts,
    manifestRelativePath,
  });

  await writeTextAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    replace: false,
    validate: parseManifestJson,
  });
  return manifest;
}
