import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MotionImpactSchema,
  RoleLensSchema,
  type MotionImpact,
  type RoleCategory,
  type RoleLens,
} from '../domain/schemas';
import shippedCatalogue from './catalogue.json';

const GOVERNED_LENS_NAMES: readonly string[] = [
  'strategist',
  'architect',
  'designer',
  'researcher',
  'maintainer',
  'operator',
  'security',
  'privacy',
  'systems',
  'performance',
  'critic',
  "devil's advocate",
];

const CATEGORY_BY_LENS: Readonly<Record<string, RoleCategory>> = {
  strategist: 'domain',
  architect: 'domain',
  designer: 'domain',
  researcher: 'domain',
  maintainer: 'maintainer',
  operator: 'maintainer',
  security: 'risk',
  privacy: 'risk',
  systems: 'systems',
  performance: 'systems',
  critic: 'contrarian',
  "devil's advocate": 'contrarian',
};

const NonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && value.trim().length > 0, {
    message: 'Must be a non-blank string without surrounding whitespace',
  });

export const RoleCatalogueSchema = z
  .array(RoleLensSchema)
  .length(GOVERNED_LENS_NAMES.length)
  .superRefine((lenses, context) => {
    const seenNames = new Set<string>();

    for (const [index, lens] of lenses.entries()) {
      const expectedName = GOVERNED_LENS_NAMES[index];
      if (lens.name !== expectedName) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `Expected governed lens ${expectedName ?? 'at this position'}`,
        });
      }

      if (seenNames.has(lens.name)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `Duplicate governed lens: ${lens.name}`,
        });
      }
      seenNames.add(lens.name);

      const expectedCategory = CATEGORY_BY_LENS[lens.name];
      if (expectedCategory !== lens.category) {
        context.addIssue({
          code: 'custom',
          path: [index, 'category'],
          message: `Lens ${lens.name} must map to ${expectedCategory ?? 'a governed category'}`,
        });
      }
    }
  });

const parsedRoleCatalogue = RoleCatalogueSchema.parse(shippedCatalogue);
for (const lens of parsedRoleCatalogue) {
  Object.freeze(lens.applicability.domains);
  Object.freeze(lens.applicability.impacts);
  Object.freeze(lens.applicability);
  Object.freeze(lens);
}
export const roleCatalogue: readonly RoleLens[] = Object.freeze(parsedRoleCatalogue);

const knownMotionDomains = new Set(
  roleCatalogue.flatMap(({ applicability }) =>
    applicability.domains.filter((domain) => domain !== '*'),
  ),
);

const MOTION_DOMAIN_ALIASES: Readonly<Record<string, string>> = {
  api: 'integration',
  architectural: 'architecture',
  auth: 'authentication',
  authenticate: 'authentication',
  authorization: 'authorisation',
  benchmark: 'performance',
  cpu: 'performance',
  credential: 'authentication',
  credentials: 'authentication',
  database: 'data',
  deploy: 'deployment',
  frontend: 'ui',
  incident: 'reliability',
  latency: 'performance',
  login: 'authentication',
  memory: 'performance',
  p95: 'performance',
  p99: 'performance',
  permission: 'authorisation',
  permissions: 'authorisation',
  recovery: 'reliability',
  scalable: 'performance',
  scaling: 'performance',
  signin: 'authentication',
  system: 'systems',
  threat: 'security',
  throughput: 'performance',
  uptime: 'reliability',
  vulnerability: 'security',
  webhook: 'integration',
};

/** Derives deterministic role-applicability domains from the motion when none are supplied. */
export function inferMotionDomains(motion: string): string[] {
  const input = NonBlankStringSchema.parse(motion);
  const inferred = new Set<string>();
  const tokens = input
    .normalize('NFKD')
    .toLowerCase()
    .match(/[a-z0-9]+/g);

  for (const token of tokens ?? []) {
    if (knownMotionDomains.has(token)) {
      inferred.add(token);
      continue;
    }
    const alias = MOTION_DOMAIN_ALIASES[token];
    if (alias !== undefined) inferred.add(alias);
  }

  return inferred.size > 0 ? [...inferred] : ['general'];
}

export const MotionMetadataSchema = z.strictObject({
  domains: z.array(NonBlankStringSchema).superRefine((domains, context) => {
    const seenDomains = new Set<string>();

    for (const [index, domain] of domains.entries()) {
      const canonicalDomain = domain.toLowerCase();
      if (seenDomains.has(canonicalDomain)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `Duplicate motion domain: ${domain}`,
        });
      }
      seenDomains.add(canonicalDomain);
    }
  }),
  impact: MotionImpactSchema,
  contested: z.boolean(),
});
export type MotionMetadata = z.infer<typeof MotionMetadataSchema>;

export const ChairOverrideSchema = z
  .strictObject({
    originalLensName: NonBlankStringSchema,
    replacementLensName: NonBlankStringSchema,
    reason: NonBlankStringSchema,
  })
  .refine(({ originalLensName, replacementLensName }) => originalLensName !== replacementLensName, {
    message: 'A chair override must change the assigned lens',
    path: ['replacementLensName'],
  });
export type ChairOverride = z.infer<typeof ChairOverrideSchema>;

export const RoleAssignmentSchema = z
  .strictObject({
    runId: NonBlankStringSchema,
    motionId: NonBlankStringSchema,
    seatId: NonBlankStringSchema,
    lensName: NonBlankStringSchema,
    chairOverride: ChairOverrideSchema.nullable(),
  })
  .superRefine(({ lensName, chairOverride }, context) => {
    if (chairOverride !== null && chairOverride.replacementLensName !== lensName) {
      context.addIssue({
        code: 'custom',
        path: ['chairOverride', 'replacementLensName'],
        message: 'The replacement lens must match the persisted assignment',
      });
    }
  });
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const AssignmentHistorySchema = z.array(RoleAssignmentSchema);
export type AssignmentHistory = z.infer<typeof AssignmentHistorySchema>;

const SeatIdsSchema = z
  .array(NonBlankStringSchema)
  .min(1)
  .superRefine((seatIds, context) => {
    const seenSeatIds = new Set<string>();

    for (const [index, seatId] of seatIds.entries()) {
      if (seenSeatIds.has(seatId)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `Duplicate seat identifier: ${seatId}`,
        });
      }
      seenSeatIds.add(seatId);
    }
  });

const AssignmentLensesSchema = z
  .array(RoleLensSchema)
  .min(1)
  .superRefine((lenses, context) => {
    const seenLensNames = new Set<string>();

    for (const [index, lens] of lenses.entries()) {
      if (lens.name.trim().length === 0 || lens.name.trim() !== lens.name) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: 'Lens names must be non-blank and have no surrounding whitespace',
        });
      }
      if (seenLensNames.has(lens.name)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `Duplicate lens name: ${lens.name}`,
        });
      }
      seenLensNames.add(lens.name);
    }
  });

interface RankedLens {
  readonly lens: RoleLens;
  readonly catalogueIndex: number;
  readonly applicabilityScore: number;
}

function scoreApplicability(
  lens: RoleLens,
  motionDomains: ReadonlySet<string>,
  impact: MotionImpact,
  contested: boolean,
): number {
  let score = 0;
  let exactDomainMatches = 0;
  let namedDomainCount = 0;

  for (const domain of lens.applicability.domains) {
    if (domain === '*') continue;
    namedDomainCount += 1;
    if (motionDomains.has(domain.toLowerCase())) exactDomainMatches += 1;
  }

  if (exactDomainMatches > 0) {
    score += 100 + exactDomainMatches * 10 - namedDomainCount;
  }
  if (lens.applicability.domains.includes('*') && motionDomains.size > 0) score += 1;
  if (lens.applicability.impacts.includes(impact)) score += 10;
  if (lens.applicability.contested && contested) score += 10;

  return score;
}

export function selectLenses(motion: MotionMetadata, seats: number): RoleLens[] {
  const parsedMotion = MotionMetadataSchema.parse(motion);
  const parsedSeatCount = z.number().int().min(1).max(roleCatalogue.length).parse(seats);
  const motionDomains = new Set(parsedMotion.domains.map((domain) => domain.toLowerCase()));
  const requiredCategories: RoleCategory[] = ['domain', 'maintainer', 'risk'];
  if (
    parsedMotion.domains.some((domain) =>
      ['architecture', 'infrastructure', 'performance'].includes(domain.toLowerCase()),
    )
  ) {
    requiredCategories.push('systems');
  }
  requiredCategories.push('contrarian');

  if (parsedSeatCount < requiredCategories.length) {
    throw new RangeError(
      `${parsedSeatCount} seats cannot cover ${requiredCategories.length} required role categories`,
    );
  }

  const rankedLenses = roleCatalogue
    .map((lens, catalogueIndex): RankedLens => ({
      lens,
      catalogueIndex,
      applicabilityScore: scoreApplicability(
        lens,
        motionDomains,
        parsedMotion.impact,
        parsedMotion.contested,
      ),
    }))
    .filter(({ applicabilityScore }) => applicabilityScore > 0)
    .sort(
      (left, right) =>
        right.applicabilityScore - left.applicabilityScore ||
        left.catalogueIndex - right.catalogueIndex,
    );

  if (rankedLenses.length < parsedSeatCount) {
    throw new RangeError(
      `Only ${rankedLenses.length} governed lenses apply to this motion; ${parsedSeatCount} requested`,
    );
  }

  const selectedLenses: RoleLens[] = [];
  const selectedNames = new Set<string>();

  for (const category of requiredCategories) {
    const candidate = rankedLenses.find(
      ({ lens }) => lens.category === category && !selectedNames.has(lens.name),
    );
    if (candidate === undefined) {
      throw new RangeError(`No governed ${category} lens applies to this motion`);
    }
    selectedLenses.push(candidate.lens);
    selectedNames.add(candidate.lens.name);
  }

  for (const { lens } of rankedLenses) {
    if (selectedLenses.length === parsedSeatCount) break;
    if (!selectedNames.has(lens.name)) {
      selectedLenses.push(lens);
      selectedNames.add(lens.name);
    }
  }

  return selectedLenses;
}

interface PermutationItem<T> {
  readonly item: T;
  readonly digest: string;
  readonly identity: string;
}

function sha256Permutation<T>(
  runId: string,
  namespace: string,
  items: readonly T[],
  identityOf: (item: T) => string,
): T[] {
  return items
    .map((item): PermutationItem<T> => {
      const identity = identityOf(item);
      const digest = createHash('sha256')
        .update(JSON.stringify([runId, namespace, identity]), 'utf8')
        .digest('hex');
      return { item, digest, identity };
    })
    .sort((left, right) => {
      if (left.digest !== right.digest) return left.digest < right.digest ? -1 : 1;
      if (left.identity === right.identity) return 0;
      return left.identity < right.identity ? -1 : 1;
    })
    .map(({ item }) => item);
}

function numberAt(values: Float64Array | Int32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Internal assignment index ${index} is invalid`);
  return value;
}

function minimumCostMatching(costs: Float64Array, size: number): Int32Array {
  const rowPotentials = new Float64Array(size + 1);
  const columnPotentials = new Float64Array(size + 1);
  const matchedRowByColumn = new Int32Array(size + 1);
  const previousColumn = new Int32Array(size + 1);

  for (let row = 1; row <= size; row += 1) {
    matchedRowByColumn[0] = row;
    const minimumReducedCost = new Float64Array(size + 1);
    minimumReducedCost.fill(Number.POSITIVE_INFINITY);
    const usedColumns = new Uint8Array(size + 1);
    let currentColumn = 0;

    do {
      usedColumns[currentColumn] = 1;
      const currentRow = numberAt(matchedRowByColumn, currentColumn);
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;

      for (let column = 1; column <= size; column += 1) {
        if (usedColumns[column] === 1) continue;
        const reducedCost =
          numberAt(costs, (currentRow - 1) * size + column - 1) -
          numberAt(rowPotentials, currentRow) -
          numberAt(columnPotentials, column);
        if (reducedCost < numberAt(minimumReducedCost, column)) {
          minimumReducedCost[column] = reducedCost;
          previousColumn[column] = currentColumn;
        }
        if (numberAt(minimumReducedCost, column) < delta) {
          delta = numberAt(minimumReducedCost, column);
          nextColumn = column;
        }
      }

      for (let column = 0; column <= size; column += 1) {
        if (usedColumns[column] === 1) {
          const matchedRow = numberAt(matchedRowByColumn, column);
          rowPotentials[matchedRow] = numberAt(rowPotentials, matchedRow) + delta;
          columnPotentials[column] = numberAt(columnPotentials, column) - delta;
        } else {
          minimumReducedCost[column] = numberAt(minimumReducedCost, column) - delta;
        }
      }
      currentColumn = nextColumn;
    } while (numberAt(matchedRowByColumn, currentColumn) !== 0);

    do {
      const precedingColumn = numberAt(previousColumn, currentColumn);
      matchedRowByColumn[currentColumn] = numberAt(matchedRowByColumn, precedingColumn);
      currentColumn = precedingColumn;
    } while (currentColumn !== 0);
  }

  const matchedColumnByRow = new Int32Array(size);
  matchedColumnByRow.fill(-1);
  for (let column = 1; column <= size; column += 1) {
    const row = numberAt(matchedRowByColumn, column);
    matchedColumnByRow[row - 1] = column - 1;
  }
  return matchedColumnByRow;
}

export function assignLenses(
  runId: string,
  motionId: string,
  seatIds: readonly string[],
  lenses: readonly RoleLens[],
  history: AssignmentHistory,
): RoleAssignment[] {
  const parsedRunId = NonBlankStringSchema.parse(runId);
  const parsedMotionId = NonBlankStringSchema.parse(motionId);
  const parsedSeatIds = SeatIdsSchema.parse(seatIds);
  const parsedLenses = AssignmentLensesSchema.parse(lenses);
  const parsedHistory = AssignmentHistorySchema.parse(history);

  if (parsedSeatIds.length !== parsedLenses.length) {
    throw new RangeError(
      `Seat and lens cardinality must match: ${parsedSeatIds.length} seats, ${parsedLenses.length} lenses`,
    );
  }

  const sameMotionAssignments = parsedHistory.filter(
    (assignment) => assignment.motionId === parsedMotionId,
  );
  if (sameMotionAssignments.length > 0) {
    const priorBySeat = new Map<string, RoleAssignment>();
    for (const assignment of sameMotionAssignments) {
      const prior = priorBySeat.get(assignment.seatId);
      if (
        prior !== undefined &&
        (prior.lensName !== assignment.lensName ||
          JSON.stringify(prior.chairOverride) !== JSON.stringify(assignment.chairOverride))
      ) {
        throw new RangeError(`Conflicting assignment history for motion ${parsedMotionId}`);
      }
      priorBySeat.set(assignment.seatId, assignment);
    }

    const currentLensNames = new Set(parsedLenses.map(({ name }) => name));
    const reusedLensNames = new Set<string>();
    const reused = parsedSeatIds.map((seatId) => {
      const prior = priorBySeat.get(seatId);
      if (prior === undefined || !currentLensNames.has(prior.lensName)) {
        throw new RangeError(`Assignment history does not match motion ${parsedMotionId}`);
      }
      reusedLensNames.add(prior.lensName);
      return {
        ...prior,
        runId: parsedRunId,
        motionId: parsedMotionId,
      };
    });
    if (priorBySeat.size !== parsedSeatIds.length || reusedLensNames.size !== parsedLenses.length) {
      throw new RangeError(`Assignment history does not match motion ${parsedMotionId}`);
    }
    return z.array(RoleAssignmentSchema).parse(reused);
  }

  const permutedSeatIds = sha256Permutation(
    parsedMotionId,
    'seats',
    parsedSeatIds,
    (seatId) => seatId,
  );
  const permutedLenses = sha256Permutation(
    parsedMotionId,
    'lenses',
    parsedLenses,
    (lens) => lens.name,
  );
  const previousPairingCounts = new Map<string, number>();
  const countedHistoricalPairings = new Set<string>();

  for (const assignment of parsedHistory) {
    if (assignment.runId === parsedRunId || assignment.motionId === parsedMotionId) {
      continue;
    }
    const historicalKey = JSON.stringify([
      assignment.motionId,
      assignment.seatId,
      assignment.lensName,
    ]);
    if (countedHistoricalPairings.has(historicalKey)) continue;
    countedHistoricalPairings.add(historicalKey);
    const key = JSON.stringify([assignment.seatId, assignment.lensName]);
    previousPairingCounts.set(key, (previousPairingCounts.get(key) ?? 0) + 1);
  }

  const size = permutedSeatIds.length;
  const pairingPenalty = size * size + 1;
  const costs = new Float64Array(size * size);

  for (let row = 0; row < size; row += 1) {
    const seatId = permutedSeatIds[row];
    if (seatId === undefined) throw new RangeError(`Missing permuted seat at index ${row}`);

    for (let column = 0; column < size; column += 1) {
      const lens = permutedLenses[column];
      if (lens === undefined) throw new RangeError(`Missing permuted lens at index ${column}`);
      const previousCount = previousPairingCounts.get(JSON.stringify([seatId, lens.name])) ?? 0;
      const permutationDistance = column === row ? 0 : 1 + ((column - row + size) % size);
      costs[row * size + column] = previousCount * pairingPenalty + permutationDistance;
    }
  }

  const matchedColumnByRow = minimumCostMatching(costs, size);
  const lensNameBySeat = new Map<string, string>();
  for (let row = 0; row < size; row += 1) {
    const seatId = permutedSeatIds[row];
    const column = numberAt(matchedColumnByRow, row);
    const lens = permutedLenses[column];
    if (seatId === undefined || lens === undefined) {
      throw new RangeError(`Incomplete role assignment at row ${row}`);
    }
    lensNameBySeat.set(seatId, lens.name);
  }

  return z.array(RoleAssignmentSchema).parse(
    parsedSeatIds.map((seatId) => ({
      runId: parsedRunId,
      motionId: parsedMotionId,
      seatId,
      lensName: lensNameBySeat.get(seatId),
      chairOverride: null,
    })),
  );
}
