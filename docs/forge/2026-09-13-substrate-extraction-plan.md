# Substrate Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Committee and second opinion become registered modes on an explicit substrate, every run returns the result envelope, and a terminal record is committed before the run reports success, with `/council`, `/second-opinion`, `/ask`, `/result` and `/status` behaving as before.

**Architecture:** One mechanical move puts every kernel module under `src/substrate/` behind a single index. New substrate modules add the spend ledger, the result envelope, the execution patterns, the session helpers lifted out of the CLI, record commits and minutes rendering. `src/modes/` holds a registry with `committee` and `second-opinion` definitions that own defaults, pattern, spend policy, preparation (the committee health preflight) and output shape. `src/cli.ts` parses flags, dispatches through the registry, builds the envelope, persists and prints.

**Tech Stack:** Bun 1.3.14 or later, TypeScript strict with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, Zod 4, `bun:test`, `proper-lockfile`, Prettier and ESLint via `bun run lint`.

**Spec:** `docs/forge/2026-09-12-substrate-extraction-brief.md`, which cites `docs/vision.md` and `docs/modes.md`. Read all three before starting.

## Global Constraints

- British English in prose, comments and identifiers you create. Never respell an existing identifier.
- Credentials are `COUNCIL_`-prefixed. A new environment variable is added to `.env.example` in the same change. The kernel never calls Atlas and has no provider data tiers.
- Branch `refactor/substrate-extraction`, never `main`. Conventional-commit subjects. Every commit message ends with the two attribution lines given in the session's system reminder (`Co-Authored-By` and `Claude-Session`).
- `bun run lint` must be green before every commit: run `bunx prettier --write <changed files>` first. `bun run check` is the release gate and must be green at the end of Task 1 and Task 11.
- The installed runtime is `bun --no-install dist/cli.js`, built from `src/cli.ts`. The build entry does not move.
- Linux and Windows portability: `node:path` joins, no shell composition inside the product, `Bun.spawn` with argv arrays.
- No new modes beyond `committee` and `second-opinion`, no streaming implementation, no rename to `convene`, no distribution change, no change to quorum, classification, lens allocation, adjudication or migration semantics.
- Record file layout changes only by the additive optional `envelope` field on session records.
- The run output's `records` object must stay exactly `{ session: true, decisionState, dataAvailability }`; facade tests assert it with `toEqual`.
- Run ids are derived as `deterministicId('run', command, motion, now)` from the CLI command string. Keep passing the command string, never the mode name, or recorded ids change.
- The string produced by `autoReducedQuorumWarning` must stay byte-identical; `tests/core/cli-facade.test.ts` holds a verbatim copy.
- `tests/core/*.test.ts` must keep passing with only import-path changes. Do not delete or weaken an existing test.
- Do not read or print `.env`, `.env.example` contents or any credential value in a shell command. Create or edit `.env.example` with the file Write or Edit tool only.

## File Structure

After Task 1 the tree is:

```text
src/cli.ts                         parse flags, dispatch through the registry, envelope, persist, print
src/index.ts                       export * from './substrate' and './modes'
src/substrate/index.ts             the single public entry of the substrate (moved from src/index.ts)
src/substrate/domain/              classification, quorum, run-state, schemas (moved)
src/substrate/evidence/            normalise, schema (moved)
src/substrate/execution/           cli, http, provider, runner (moved)
src/substrate/health/              baseline, doctor, probe (moved)
src/substrate/models/              registry.ts, registry.json (moved)
src/substrate/policy/              data-guard, secrets (moved)
src/substrate/providers/           adapters per family (moved)
src/substrate/records/             migrate-general, project-id, store (moved)
src/substrate/roles/               allocator.ts, catalogue.json (moved)
```

New files added by later tasks:

```text
src/substrate/spend.ts             spend policy, ledger, effective billing mode
src/substrate/envelope.ts          result envelope schema, seats mapping, unanimity, spend summary
src/substrate/patterns/index.ts    rounds and parallel patterns; streaming declared only
src/substrate/session.ts           session options, quorum policy, manifest and assignment building,
                                   health preflight, preflight shape, persistence (lifted from cli.ts)
src/substrate/records/commit.ts    commit record files in the records repository
src/substrate/records/minutes.ts   render and write a minutes file
src/modes/types.ts                 ModeDefinition and related types
src/modes/index.ts                 registry, getMode, resolveModeForCommand
src/modes/committee/index.ts       committee definition
src/modes/second-opinion/index.ts  second-opinion definition
tests/core/dependency-direction.test.ts
tests/core/envelope.test.ts
tests/core/spend.test.ts
tests/core/patterns.test.ts
tests/core/modes.test.ts
tests/core/records-commit.test.ts
tests/core/minutes.test.ts
```

Dependency rule, enforced by a test from Task 2 onward: `src/modes/**` imports the substrate only through `src/substrate/index.ts`; `src/substrate/**` never imports `src/modes/**` or `src/cli.ts`; one mode never imports another mode's directory.

---

### Task 0: Make the two host-environment tests portable

**Files:**

- Modify: `tests/core/cli.test.ts:2` (imports) and `:142` (the hard link)
- Modify: `tests/core/version.test.ts:123-160` (the `--registry overrides` test)

**Interfaces:** none.

- [ ] **Step 1: Reproduce the failures on this host**

Run: `bun test tests/core/cli.test.ts tests/core/version.test.ts`
Expected on the Linux rig: 2 fail. `EXDEV: cross-device link not permitted` in `cli.test.ts`, and `effective: "subscription-cli"` where `"http"` was expected in `version.test.ts`. On a host where both already pass, continue anyway; the changes are still correct.

- [ ] **Step 2: Replace the hard link with a copy**

In `tests/core/cli.test.ts` change line 2 to:

```ts
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
```

and replace the line `await link(process.execPath, externalExecutable);` with:

```ts
// A hard link fails with EXDEV when the temp directory sits on a different filesystem from
// the bun binary, which is the layout on this project's Linux rig. A copy behaves the same
// for this test and works across devices.
await copyFile(process.execPath, externalExecutable);
await chmod(externalExecutable, 0o755);
```

- [ ] **Step 3: Isolate PATH in the registry-override test**

In `tests/core/version.test.ts`, inside the `withIsolatedHome` callback of the test named `--registry overrides the records-root default and reports its exact SHA-256`, wrap the existing body. The first lines of the callback become:

```ts
    await withIsolatedHome(async ({ directory, home }) => {
      // The xAI seat prefers a `grok` CLI found on the process PATH. This assertion is about the
      // metered fallback, so the host PATH must not leak a real subscription CLI into the fixture.
      const originalPath = process.env.PATH;
      process.env.PATH = home;
      try {
```

Indent the existing body (from `const recordsRoot = join(directory, 'records');` to the last `expect(...)`) by one level inside the `try`, and close it with:

```ts
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });
```

- [ ] **Step 4: Run the two files**

Run: `bun test tests/core/cli.test.ts tests/core/version.test.ts`
Expected: 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `bun run test`
Expected: 236 tests, 0 fail. If a single deadline-sensitive test fails once and passes on rerun, record its name in the commit body; do not retry until green without recording it.

- [ ] **Step 6: Commit**

```bash
bunx prettier --write tests/core/cli.test.ts tests/core/version.test.ts
git add tests/core/cli.test.ts tests/core/version.test.ts
git commit -m "test(core): make the bundle and registry tests independent of the host filesystem and PATH"
```

---

### Task 1: Move the kernel under `src/substrate/`

**Files:**

- Move: `src/domain`, `src/evidence`, `src/execution`, `src/health`, `src/models`, `src/policy`, `src/providers`, `src/records`, `src/roles` to `src/substrate/<same name>`
- Move: `src/index.ts` to `src/substrate/index.ts`
- Create: `src/index.ts`
- Modify: `src/cli.ts:6-71` (import specifiers only)
- Modify: `tests/core/*.ts` (import specifiers and two path strings in `tests/core/cli.test.ts`)

**Interfaces:**

- Produces: `src/substrate/index.ts` re-exporting everything the old `src/index.ts` did, at the same names. `src/index.ts` re-exports `./substrate`.

- [ ] **Step 1: Move the directories with git**

```bash
mkdir -p src/substrate
git mv src/domain src/substrate/domain
git mv src/evidence src/substrate/evidence
git mv src/execution src/substrate/execution
git mv src/health src/substrate/health
git mv src/models src/substrate/models
git mv src/policy src/substrate/policy
git mv src/providers src/substrate/providers
git mv src/records src/substrate/records
git mv src/roles src/substrate/roles
git mv src/index.ts src/substrate/index.ts
```

Every import inside the moved tree is relative to a sibling, so the moved files need no edits. `src/substrate/index.ts` keeps its content unchanged because its `./domain/...` specifiers now resolve beside it.

- [ ] **Step 2: Write the new public index**

Create `src/index.ts`:

```ts
export * from './substrate';
```

- [ ] **Step 3: Rewrite the CLI and test import specifiers**

```bash
sed -i -E "s#from '\./(domain|evidence|execution|health|models|policy|providers|records|roles)#from './substrate/\1#g" src/cli.ts
sed -i -E "s#(from '|import\(')\.\./\.\./src/(domain|evidence|execution|health|models|policy|providers|records|roles)#\1../../src/substrate/\2#g" tests/core/*.ts
sed -i "s#'\.\./\.\./src/execution/cli\.ts'#'../../src/substrate/execution/cli.ts'#g" tests/core/cli.test.ts
```

Then confirm nothing still points at the old locations:

```bash
rg -n "from '\./(domain|evidence|execution|health|models|policy|providers|records|roles)" src/cli.ts
rg -n "src/(domain|evidence|execution|health|models|policy|providers|records|roles)/" tests/core src/cli.ts
```

Expected: both searches print nothing. The path `'../../src/cli.ts'` in `tests/core/cli.test.ts` is correct and must stay.

- [ ] **Step 4: Type-check, format, and run the gate**

Run: `bun run check:types`
Expected: no errors.

Run: `bunx prettier --write src/cli.ts src/index.ts src/substrate/index.ts tests/core`

Run: `bun run check`
Expected: types, lint, tests (236 pass), release checks and the package self-check all pass. The self-check proves the bundle still resolves `registry.json` and `catalogue.json` from their new locations.

- [ ] **Step 5: Commit**

```bash
git add -A src tests/core
git commit -m "refactor(substrate): move the kernel modules under src/substrate behind one index"
```

---

### Task 2: Dependency-direction test

**Files:**

- Create: `tests/core/dependency-direction.test.ts`

**Interfaces:** none. The test encodes the rule every later task must satisfy.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const sourceRoot = resolve(import.meta.dir, '../../src');
const substrateRoot = join(sourceRoot, 'substrate');
const modesRoot = join(sourceRoot, 'modes');
const substrateIndex = join(substrateRoot, 'index.ts');
const cliEntry = join(sourceRoot, 'cli.ts');

async function typescriptFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

const RELATIVE_SPECIFIER = /(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g;

function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveSpecifier(file: string, specifier: string): string {
  const target = resolve(dirname(file), specifier);
  if (target.endsWith('.ts') || target.endsWith('.json')) return target;
  if (existsSync(`${target}.ts`)) return `${target}.ts`;
  return join(target, 'index.ts');
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function importsOf(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  return relativeSpecifiers(source).map((specifier) => resolveSpecifier(file, specifier));
}

describe('dependency direction', () => {
  test('the substrate exists', async () => {
    expect((await typescriptFiles(substrateRoot)).length).toBeGreaterThan(0);
  });

  test('the substrate never imports modes or the CLI entry', async () => {
    const violations: string[] = [];
    for (const file of await typescriptFiles(substrateRoot)) {
      for (const target of await importsOf(file)) {
        if (isInside(target, modesRoot) || target === cliEntry) {
          violations.push(`${file} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('modes import the substrate only through its index', async () => {
    const violations: string[] = [];
    for (const file of await typescriptFiles(modesRoot)) {
      for (const target of await importsOf(file)) {
        if (isInside(target, substrateRoot) && target !== substrateIndex) {
          violations.push(`${file} -> ${target}`);
        }
        if (target === cliEntry) violations.push(`${file} -> ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('one mode never imports another mode', async () => {
    const violations: string[] = [];
    for (const file of await typescriptFiles(modesRoot)) {
      const owner = dirname(file);
      if (owner === modesRoot) continue;
      for (const target of await importsOf(file)) {
        if (!isInside(target, modesRoot)) continue;
        const targetOwner = dirname(target);
        if (targetOwner !== modesRoot && targetOwner !== owner && !isInside(target, owner)) {
          violations.push(`${file} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/core/dependency-direction.test.ts`
Expected: 4 pass. The two mode tests are vacuous until Task 7 creates `src/modes/`; the substrate test is real now.

- [ ] **Step 3: Commit**

```bash
bunx prettier --write tests/core/dependency-direction.test.ts
git add tests/core/dependency-direction.test.ts
git commit -m "test(substrate): enforce the substrate and modes dependency direction"
```

---

### Task 3: Spend policy and the result envelope

**Files:**

- Create: `src/substrate/spend.ts`
- Create: `src/substrate/envelope.ts`
- Create: `tests/core/spend.test.ts`
- Create: `tests/core/envelope.test.ts`
- Modify: `src/substrate/index.ts` (two export lines)

**Interfaces:**

- Produces from `spend.ts`: `SpendPolicySchema`, `type SpendPolicy = 'never-metered' | 'capped'`, `interface SpendLedger { readonly cap: number; readonly used: number; readonly refused: number; reserve(): boolean }`, `createSpendLedger(cap: number): SpendLedger`, `effectiveBillingMode(policy: SpendPolicy, requested: BillingMode): BillingMode`, `spendCapExhaustedMessage(cap: number): string`.
- Produces from `envelope.ts`: `CallerSchema`, `type Caller`, `UNDECLARED_CALLER`, `ExecutionPatternSchema`, `type ExecutionPattern`, `SpendSchema`, `type Spend`, `EnvelopeSeatSchema`, `EnvelopeRecordSchema`, `type EnvelopeRecord`, `ResultEnvelopeSchema`, `type ResultEnvelope`, `envelopeSeats(source)`, `detectUnanimity(rounds)`, `spendFromRounds(rounds, input)`, `buildEnvelope(input)`.

- [ ] **Step 1: Write the spend test**

Create `tests/core/spend.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  createSpendLedger,
  effectiveBillingMode,
  spendCapExhaustedMessage,
} from '../../src/substrate/spend';

describe('spend ledger', () => {
  test('reserves up to the cap and counts refusals after it', () => {
    const ledger = createSpendLedger(2);
    expect(ledger.reserve()).toBe(true);
    expect(ledger.reserve()).toBe(true);
    expect(ledger.reserve()).toBe(false);
    expect(ledger.reserve()).toBe(false);
    expect(ledger.used).toBe(2);
    expect(ledger.refused).toBe(2);
    expect(ledger.cap).toBe(2);
  });

  test('a zero cap refuses every metered call', () => {
    const ledger = createSpendLedger(0);
    expect(ledger.reserve()).toBe(false);
    expect(ledger.used).toBe(0);
    expect(ledger.refused).toBe(1);
  });

  test('rejects a negative or fractional cap', () => {
    expect(() => createSpendLedger(-1)).toThrow(RangeError);
    expect(() => createSpendLedger(1.5)).toThrow(RangeError);
  });

  test('never-metered pins sub-only and refuses api-only', () => {
    expect(effectiveBillingMode('never-metered', 'sub-first')).toBe('sub-only');
    expect(effectiveBillingMode('never-metered', 'sub-only')).toBe('sub-only');
    expect(() => effectiveBillingMode('never-metered', 'api-only')).toThrow(
      /never spends a metered key/,
    );
  });

  test('capped keeps the requested billing mode', () => {
    expect(effectiveBillingMode('capped', 'sub-first')).toBe('sub-first');
    expect(effectiveBillingMode('capped', 'api-only')).toBe('api-only');
    expect(effectiveBillingMode('capped', 'sub-only')).toBe('sub-only');
  });

  test('the cap message names the flag that raises it', () => {
    expect(spendCapExhaustedMessage(3)).toContain('--spend-cap');
    expect(spendCapExhaustedMessage(3)).toContain('3');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/core/spend.test.ts`
Expected: FAIL, cannot resolve `../../src/substrate/spend`.

- [ ] **Step 3: Write `src/substrate/spend.ts`**

```ts
import { z } from 'zod';
import type { BillingMode } from './execution/provider';

/**
 * How a mode is allowed to pay for its seats. `never-metered` is for fast modes (advisor, triage,
 * audience): a metered key is unreachable, not merely avoided. `capped` is for slow modes: a
 * subscription seat may fall back to the same family's metered key until the session cap is spent.
 */
export const SpendPolicySchema = z.enum(['never-metered', 'capped']);
export type SpendPolicy = z.infer<typeof SpendPolicySchema>;

export interface SpendLedger {
  readonly cap: number;
  readonly used: number;
  readonly refused: number;
  /** Reserve one metered call. Returns false, and counts a refusal, once the cap is spent. */
  reserve(): boolean;
}

export function createSpendLedger(cap: number): SpendLedger {
  if (!Number.isInteger(cap) || cap < 0) {
    throw new RangeError(`Spend cap must be a non-negative integer; received ${cap}`);
  }
  let used = 0;
  let refused = 0;
  return {
    cap,
    get used() {
      return used;
    },
    get refused() {
      return refused;
    },
    reserve() {
      if (used >= cap) {
        refused += 1;
        return false;
      }
      used += 1;
      return true;
    },
  };
}

export function effectiveBillingMode(policy: SpendPolicy, requested: BillingMode): BillingMode {
  if (policy === 'never-metered') {
    if (requested === 'api-only') {
      throw new Error('This mode never spends a metered key; --billing api-only is not allowed');
    }
    return 'sub-only';
  }
  return requested;
}

export function spendCapExhaustedMessage(cap: number): string {
  return `Metered fallback refused: the session spend cap of ${cap} metered call(s) is exhausted. Raise it with --spend-cap <n>.`;
}
```

- [ ] **Step 4: Run the spend test**

Run: `bun test tests/core/spend.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Write the envelope test**

Create `tests/core/envelope.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { SeatResponse } from '../../src/substrate/domain/schemas';
import type { CouncilSeatAssignment, RoundExecution } from '../../src/substrate/execution/runner';
import {
  ResultEnvelopeSchema,
  UNDECLARED_CALLER,
  buildEnvelope,
  detectUnanimity,
  envelopeSeats,
  spendFromRounds,
} from '../../src/substrate/envelope';

function answer(recommendation: string): string {
  return JSON.stringify({
    recommendation,
    evidence: ['e'],
    assumptions: ['a'],
    risks: ['r'],
    uncertainty: 'low',
    decisiveTest: 'run it',
  });
}

function ok(
  seatId: string,
  provider: SeatResponse['provider'],
  recommendation: string,
  extra: Partial<Extract<SeatResponse, { status: 'ok' }>> = {},
): SeatResponse {
  return {
    status: 'ok',
    seatId,
    provider,
    requestedModel: `${provider}-primary`,
    actualModel: `${provider}-primary`,
    modelIdentity: 'verified',
    route: 'primary',
    role: 'architect',
    latencyMs: 10,
    answer: answer(recommendation),
    ...extra,
  };
}

function failed(seatId: string, provider: SeatResponse['provider'], code: string): SeatResponse {
  return {
    status: 'failed',
    seatId,
    provider,
    role: 'architect',
    error: { code, message: `${code} happened`, retryable: false },
  };
}

const assignments: CouncilSeatAssignment[] = [
  {
    seatId: 'anthropic-seat',
    provider: 'anthropic',
    lensName: 'architect',
    lensPrompt: 'p',
    lensCategory: 'domain',
  },
  {
    seatId: 'openai-seat',
    provider: 'openai',
    lensName: 'critic',
    lensPrompt: 'p',
    lensCategory: 'contrarian',
  },
  {
    seatId: 'xai-seat',
    provider: 'xai',
    lensName: 'security',
    lensPrompt: 'p',
    lensCategory: 'risk',
  },
];

const rounds: RoundExecution[] = [
  {
    round: 1,
    phase: 'analysis',
    retries: [],
    responses: [
      ok('anthropic-seat', 'anthropic', 'Adopt X', { credentialPath: 'subscription' }),
      ok('openai-seat', 'openai', 'adopt x ', {
        credentialPath: 'api-key',
        credentialFallback: {
          fromTransport: 'subscription-cli',
          toTransport: 'http',
          reason: 'quota-exhausted',
        },
      }),
      failed('xai-seat', 'xai', 'missing-executable'),
    ],
  },
];

describe('result envelope', () => {
  test('maps assignments and responses to seats', () => {
    const seats = envelopeSeats({ assignments, rounds });
    expect(seats).toHaveLength(3);
    expect(seats[0]).toEqual({
      id: 'anthropic/anthropic-primary#architect',
      family: 'anthropic',
      model: {
        requested: 'anthropic-primary',
        verified: 'anthropic-primary',
        verification: 'verified',
      },
      lens: 'architect',
      transport: 'subscription',
      fallback: false,
      status: 'ok',
      reason: null,
    });
    expect(seats[1]).toMatchObject({ transport: 'api', fallback: true, status: 'ok' });
    expect(seats[2]).toMatchObject({
      id: 'xai/unresolved#security',
      model: { requested: null, verified: null, verification: 'unverified' },
      transport: null,
      status: 'failed',
      reason: 'missing-executable happened',
    });
  });

  test('flags unanimity only when two or more verified answers agree after normalisation', () => {
    expect(detectUnanimity(rounds)).toBe(true);
    const split: RoundExecution[] = [
      {
        ...rounds[0]!,
        responses: [ok('a', 'anthropic', 'Adopt X'), ok('b', 'openai', 'Reject X')],
      },
    ];
    expect(detectUnanimity(split)).toBe(false);
    const lonely: RoundExecution[] = [
      { ...rounds[0]!, responses: [ok('a', 'anthropic', 'Adopt X')] },
    ];
    expect(detectUnanimity(lonely)).toBe(false);
    expect(detectUnanimity([])).toBe(false);
  });

  test('summarises spend from the credential paths actually used', () => {
    expect(
      spendFromRounds(rounds, { billing: 'sub-first', policy: 'capped', cap: 3, refused: 0 }),
    ).toEqual({
      billing: 'sub-first',
      policy: 'capped',
      cap: 3,
      used: 1,
      fallbacks: 1,
      refused: 0,
      stoppedAtCap: false,
    });
    expect(
      spendFromRounds(rounds, { billing: 'sub-first', policy: 'capped', cap: 0, refused: 2 })
        .stoppedAtCap,
    ).toBe(true);
  });

  test('builds a validated envelope and rejects an invalid one', () => {
    const envelope = buildEnvelope({
      mode: 'second-opinion',
      session: 'run-1',
      caller: UNDECLARED_CALLER,
      pattern: 'parallel',
      rounds,
      assignments,
      output: { outcome: 'completed' },
      spend: spendFromRounds(rounds, {
        billing: 'sub-first',
        policy: 'capped',
        cap: 3,
        refused: 0,
      }),
      degraded: ['caller-undeclared'],
      record: { session: null },
    });
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.rounds).toBe(1);
    expect(envelope.unanimous).toBe(true);
    expect(envelope.synthesis).toBeNull();
    expect(envelope.dissent).toBeNull();
    expect(ResultEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => ResultEnvelopeSchema.parse({ ...envelope, rounds: 4 })).toThrow();
    expect(() => ResultEnvelopeSchema.parse({ ...envelope, extra: true })).toThrow();
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `bun test tests/core/envelope.test.ts`
Expected: FAIL, cannot resolve `../../src/substrate/envelope`.

- [ ] **Step 7: Write `src/substrate/envelope.ts`**

```ts
import { z } from 'zod';
import { ProviderFamilySchema, type SeatResponse } from './domain/schemas';
import { BillingModeSchema, CouncilAnswerSchema } from './execution/provider';
import type { CouncilSeatAssignment, RoundExecution } from './execution/runner';
import { SpendPolicySchema } from './spend';

const NonEmptyStringSchema = z.string().trim().min(1);

export const CallerKindSchema = z.enum(['human', 'agent']);
export type CallerKind = z.infer<typeof CallerKindSchema>;

/**
 * Who asked, declared by the wrapper and never inferred. `declared: false` is the honest default
 * when a caller passed no `--caller`, and it is surfaced in `degraded` so nobody mistakes an
 * assumption for a fact.
 */
export const CallerSchema = z.strictObject({
  kind: CallerKindSchema,
  harness: NonEmptyStringSchema,
  purpose: NonEmptyStringSchema.optional(),
  declared: z.boolean(),
});
export type Caller = z.infer<typeof CallerSchema>;

export const UNDECLARED_CALLER: Caller = Object.freeze({
  kind: 'human',
  harness: 'unknown',
  declared: false,
});

export const ExecutionPatternSchema = z.enum(['streaming', 'parallel', 'rounds']);
export type ExecutionPattern = z.infer<typeof ExecutionPatternSchema>;

export const SpendSchema = z.strictObject({
  billing: BillingModeSchema,
  policy: SpendPolicySchema,
  cap: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  stoppedAtCap: z.boolean(),
});
export type Spend = z.infer<typeof SpendSchema>;

export const EnvelopeSeatSchema = z.strictObject({
  id: NonEmptyStringSchema,
  family: ProviderFamilySchema,
  model: z.strictObject({
    requested: NonEmptyStringSchema.nullable(),
    verified: NonEmptyStringSchema.nullable(),
    verification: z.enum(['verified', 'unverified']),
  }),
  lens: NonEmptyStringSchema,
  transport: z.enum(['subscription', 'api']).nullable(),
  fallback: z.boolean(),
  status: z.enum(['ok', 'skipped', 'failed', 'timed-out', 'cancelled']),
  reason: z.string().nullable(),
});
export type EnvelopeSeat = z.infer<typeof EnvelopeSeatSchema>;

/**
 * `session` is the record path relative to the records root, known before the record is written.
 * `committed`, `commitSha` and `minutes` are facts that exist only after the write, so they appear
 * on the emitted envelope and not inside the persisted one.
 */
export const EnvelopeRecordSchema = z.strictObject({
  session: z.string().nullable(),
  committed: z.boolean().optional(),
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{7,40}$/)
    .optional(),
  minutes: z.string().nullable().optional(),
});
export type EnvelopeRecord = z.infer<typeof EnvelopeRecordSchema>;

export const ResultEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  caller: CallerSchema,
  pattern: ExecutionPatternSchema,
  rounds: z.number().int().min(0).max(3),
  seats: z.array(EnvelopeSeatSchema),
  output: z.record(z.string(), z.unknown()),
  synthesis: z.strictObject({ by: NonEmptyStringSchema, text: NonEmptyStringSchema }).nullable(),
  dissent: z
    .array(z.strictObject({ seat: NonEmptyStringSchema, position: NonEmptyStringSchema }))
    .nullable(),
  unanimous: z.boolean(),
  spend: SpendSchema,
  degraded: z.array(NonEmptyStringSchema),
  record: EnvelopeRecordSchema,
});
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

export interface EnvelopeSeatsSource {
  readonly assignments: readonly CouncilSeatAssignment[];
  readonly rounds: readonly RoundExecution[];
}

function responsesFor(seatId: string, rounds: readonly RoundExecution[]): SeatResponse[] {
  return rounds.flatMap((round) =>
    round.responses.filter((response) => response.seatId === seatId),
  );
}

export function envelopeSeats(source: EnvelopeSeatsSource): EnvelopeSeat[] {
  return source.assignments.map((assignment) => {
    const responses = responsesFor(assignment.seatId, source.rounds);
    const last = responses.at(-1);
    const verified = responses.find((response) => response.status === 'ok');
    const requested = last?.requestedModel ?? null;
    return {
      id: `${assignment.provider}/${requested ?? 'unresolved'}#${assignment.lensName}`,
      family: assignment.provider,
      model: {
        requested,
        verified: verified?.actualModel ?? null,
        verification: verified === undefined ? 'unverified' : 'verified',
      },
      lens: assignment.lensName,
      transport:
        last?.credentialPath === undefined
          ? null
          : last.credentialPath === 'api-key'
            ? 'api'
            : 'subscription',
      fallback: responses.some((response) => response.credentialFallback !== undefined),
      status: last === undefined ? 'skipped' : last.status,
      reason:
        last === undefined
          ? 'no response recorded'
          : last.status === 'ok'
            ? null
            : last.error.message,
    };
  });
}

/**
 * Identical short recommendations under a shared prompt are a measurement artefact, so unanimity
 * is a flag to be suspicious of rather than a success signal. Only the final round counts, only
 * verified answers count, and one answer alone is not unanimity.
 */
export function detectUnanimity(rounds: readonly RoundExecution[]): boolean {
  const final = rounds.at(-1);
  if (final === undefined) return false;
  const recommendations = final.responses.flatMap((response) => {
    if (response.status !== 'ok') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.answer);
    } catch {
      return [];
    }
    const answer = CouncilAnswerSchema.safeParse(parsed);
    return answer.success ? [answer.data.recommendation.trim().toLowerCase()] : [];
  });
  const first = recommendations[0];
  return (
    recommendations.length >= 2 &&
    first !== undefined &&
    recommendations.every((recommendation) => recommendation === first)
  );
}

export function spendFromRounds(
  rounds: readonly RoundExecution[],
  input: Readonly<{
    billing: Spend['billing'];
    policy: Spend['policy'];
    cap: number;
    refused: number;
  }>,
): Spend {
  const responses = rounds.flatMap((round) => round.responses);
  return {
    billing: input.billing,
    policy: input.policy,
    cap: input.cap,
    used: responses.filter((response) => response.credentialPath === 'api-key').length,
    fallbacks: responses.filter((response) => response.credentialFallback !== undefined).length,
    refused: input.refused,
    stoppedAtCap: input.refused > 0,
  };
}

export interface BuildEnvelopeInput {
  readonly mode: string;
  readonly session: string;
  readonly caller: Caller;
  readonly pattern: ExecutionPattern;
  readonly rounds: readonly RoundExecution[];
  readonly assignments: readonly CouncilSeatAssignment[];
  readonly output: Record<string, unknown>;
  readonly spend: Spend;
  readonly degraded: readonly string[];
  readonly record: EnvelopeRecord;
}

export function buildEnvelope(input: BuildEnvelopeInput): ResultEnvelope {
  return ResultEnvelopeSchema.parse({
    schemaVersion: 1,
    mode: input.mode,
    session: input.session,
    caller: input.caller,
    pattern: input.pattern,
    rounds: input.rounds.length,
    seats: envelopeSeats({ assignments: input.assignments, rounds: input.rounds }),
    output: input.output,
    synthesis: null,
    dissent: null,
    unanimous: detectUnanimity(input.rounds),
    spend: input.spend,
    degraded: [...input.degraded],
    record: input.record,
  });
}
```

`synthesis` and `dissent` are `null` in this build: the kernel produces no synthesis (see the comment above `loadAssignmentHistory` in `src/cli.ts`) and dissent extraction belongs to the second-opinion synthesis brief. `null` means "not computed", which is different from an empty list.

- [ ] **Step 8: Export both modules from the substrate index**

Append to `src/substrate/index.ts`:

```ts
export * from './envelope';
export * from './spend';
```

- [ ] **Step 9: Run the tests and the type check**

Run: `bun test tests/core/envelope.test.ts tests/core/spend.test.ts && bun run check:types`
Expected: 10 pass, no type errors.

- [ ] **Step 10: Commit**

```bash
bunx prettier --write src/substrate/spend.ts src/substrate/envelope.ts src/substrate/index.ts tests/core/spend.test.ts tests/core/envelope.test.ts
git add src/substrate/spend.ts src/substrate/envelope.ts src/substrate/index.ts tests/core/spend.test.ts tests/core/envelope.test.ts
git commit -m "feat(substrate): add the spend policy ledger and the result envelope schema"
```

---

### Task 4: Enforce the spend cap at the metered fallback

**Files:**

- Modify: `src/substrate/execution/provider.ts:79-85` (`ProviderContext`), `:2196-2234` (`withCredentialFallback`)
- Modify: `tests/core/spend.test.ts` (append a describe block)

**Interfaces:**

- Consumes: `SpendLedger`, `spendCapExhaustedMessage` from `../spend`.
- Produces: `ProviderContext.spend?: SpendLedger`; `withCredentialFallback` becomes exported with its existing signature `(primary: ProviderAdapter, secondary: () => ProviderAdapter, fallbackTransport: ModelTransport): ProviderAdapter`.

- [ ] **Step 1: Append the failing test**

Append to `tests/core/spend.test.ts`:

```ts
import type {
  Availability,
  HealthResult,
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
} from '../../src/substrate/execution/provider';
import { withCredentialFallback } from '../../src/substrate/execution/provider';
import type { SeatResponse } from '../../src/substrate/domain/schemas';

function stubAdapter(
  reply: () => SeatResponse,
  transport: 'subscription-cli' | 'http',
): ProviderAdapter {
  return {
    family: 'xai',
    transport,
    async availability(): Promise<Availability> {
      return { status: 'available', provider: 'xai', model: 'grok', reason: 'stub' };
    },
    async invoke(): Promise<SeatResponse> {
      return reply();
    },
    async probe(): Promise<HealthResult> {
      return {
        status: 'healthy',
        provider: 'xai',
        requestedModel: 'grok',
        actualModel: 'grok',
        latencyMs: 1,
        reason: 'stub',
      };
    },
  };
}

function quotaExhausted(): SeatResponse {
  return {
    status: 'failed',
    seatId: 'xai-seat',
    provider: 'xai',
    role: 'architect',
    error: { code: 'quota-exhausted', message: 'subscription spent', retryable: false },
  };
}

function metered(): SeatResponse {
  return {
    status: 'ok',
    seatId: 'xai-seat',
    provider: 'xai',
    requestedModel: 'grok',
    actualModel: 'grok',
    modelIdentity: 'verified',
    route: 'primary',
    role: 'architect',
    latencyMs: 1,
    answer:
      '{"recommendation":"x","evidence":[],"assumptions":[],"risks":[],"uncertainty":"u","decisiveTest":"t"}',
    credentialPath: 'api-key',
  };
}

function request(spend?: ProviderContext['spend']): ProviderRequest {
  const context: ProviderContext = {
    registry: {} as ProviderContext['registry'],
    env: {},
    cwd: 'C:/isolated',
    timeoutMs: 1_000,
    ...(spend === undefined ? {} : { spend }),
  };
  return { context, seatId: 'xai-seat', role: 'architect', prompt: 'motion' };
}

describe('credential fallback under a spend cap', () => {
  test('without a ledger the fallback behaves as before', async () => {
    const adapter = withCredentialFallback(
      stubAdapter(quotaExhausted, 'subscription-cli'),
      () => stubAdapter(metered, 'http'),
      'http',
    );
    const response = await adapter.invoke(request());
    expect(response.status).toBe('ok');
    expect(response.credentialFallback).toEqual({
      fromTransport: 'subscription-cli',
      toTransport: 'http',
      reason: 'quota-exhausted',
    });
  });

  test('the ledger permits metered calls up to the cap and then refuses with spend-cap', async () => {
    const ledger = createSpendLedger(1);
    const adapter = withCredentialFallback(
      stubAdapter(quotaExhausted, 'subscription-cli'),
      () => stubAdapter(metered, 'http'),
      'http',
    );
    const first = await adapter.invoke(request(ledger));
    expect(first.status).toBe('ok');
    const second = await adapter.invoke(request(ledger));
    expect(second.status).toBe('failed');
    if (second.status !== 'failed') throw new Error('unreachable');
    expect(second.error.code).toBe('spend-cap');
    expect(second.error.message).toContain('--spend-cap');
    expect(second.error.message).toContain('quota-exhausted');
    expect(second.error.retryable).toBe(false);
    expect(ledger.used).toBe(1);
    expect(ledger.refused).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/core/spend.test.ts`
Expected: FAIL, `withCredentialFallback` is not exported.

- [ ] **Step 3: Add the ledger to the provider context and the fallback wrapper**

In `src/substrate/execution/provider.ts` add to the imports:

```ts
import { spendCapExhaustedMessage, type SpendLedger } from '../spend';
```

Change `ProviderContext` to:

```ts
export interface ProviderContext {
  registry: ModelRegistry;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  timeoutMs: number;
  captureDiagnostic?: (diagnostic: ProviderDiagnostic) => void;
  /** Session-wide budget for metered fallbacks. Absent means uncapped, which is today's behaviour. */
  spend?: SpendLedger;
}
```

Change the declaration `function withCredentialFallback(` to `export function withCredentialFallback(` and replace the start of its `invoke` with:

```ts
    async invoke(request) {
      const first = await primary.invoke(request);
      if (first.status === 'ok' || !permitsCredentialFallback(first)) return first;
      const ledger = request.context.spend;
      if (ledger !== undefined && !ledger.reserve()) {
        // The cap is a session-wide budget for metered fallbacks. Refusing here keeps the seat's
        // original failure visible and records that money was not spent, which is the point.
        return {
          ...first,
          error: {
            code: 'spend-cap',
            message: `${spendCapExhaustedMessage(ledger.cap)} Original failure: ${first.error.code}.`,
            retryable: false,
          },
        };
      }
      const second = await secondary().invoke(request);
```

The rest of the function is unchanged.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test tests/core/spend.test.ts tests/core/providers.test.ts && bun run check:types`
Expected: all pass. `providers.test.ts` proves the uncapped path is unchanged.

- [ ] **Step 5: Commit**

```bash
bunx prettier --write src/substrate/execution/provider.ts tests/core/spend.test.ts
git add src/substrate/execution/provider.ts tests/core/spend.test.ts
git commit -m "feat(substrate): enforce the session spend cap at the metered credential fallback"
```

---

### Task 5: Execution patterns

**Files:**

- Create: `src/substrate/patterns/index.ts`
- Create: `tests/core/patterns.test.ts`
- Modify: `src/substrate/index.ts` (one export line)

**Interfaces:**

- Consumes: `CouncilRunner`, `CouncilRunInput`, `CouncilRunResult` from `../execution/runner`; `ExecutionPatternSchema` from `../envelope`.
- Produces: `executeRounds(runner, input)`, `executeParallel(runner, input)`, `executeStreaming(): never`, `executePattern(pattern, runner, input)`.

- [ ] **Step 1: Write the failing test**

Create `tests/core/patterns.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { CouncilRunInput, CouncilRunner } from '../../src/substrate/execution/runner';
import {
  executeParallel,
  executePattern,
  executeRounds,
  executeStreaming,
} from '../../src/substrate/patterns';

function fakeRunner(): { runner: CouncilRunner; calls: CouncilRunInput[] } {
  const calls: CouncilRunInput[] = [];
  const runner = {
    async run(input: CouncilRunInput) {
      calls.push(input);
      return { runId: input.runId } as unknown as Awaited<ReturnType<CouncilRunner['run']>>;
    },
  } as unknown as CouncilRunner;
  return { runner, calls };
}

const base = {
  runId: 'run-1',
  motion: 'motion',
  assignments: [],
  quorumPolicy: { minimumDistinctFamilies: 3, requiresContrarian: false },
} as unknown as Omit<CouncilRunInput, 'rounds'>;

describe('execution patterns', () => {
  test('rounds delegates to the runner unchanged', async () => {
    const { runner, calls } = fakeRunner();
    await executeRounds(runner, { ...base, rounds: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rounds).toBe(2);
  });

  test('parallel is exactly one blind round', async () => {
    const { runner, calls } = fakeRunner();
    await executeParallel(runner, { ...base, rounds: 1 });
    expect(calls).toHaveLength(1);
    await expect(executeParallel(runner, { ...base, rounds: 2 })).rejects.toThrow(
      /exactly one blind round/,
    );
    expect(calls).toHaveLength(1);
  });

  test('streaming is declared and not implemented', () => {
    expect(() => executeStreaming()).toThrow(/not implemented/);
  });

  test('executePattern dispatches by name', async () => {
    const { runner, calls } = fakeRunner();
    await executePattern('parallel', runner, { ...base, rounds: 1 });
    await executePattern('rounds', runner, { ...base, rounds: 3 });
    expect(calls.map((call) => call.rounds)).toEqual([1, 3]);
    await expect(executePattern('streaming', runner, { ...base, rounds: 1 })).rejects.toThrow(
      /not implemented/,
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/core/patterns.test.ts`
Expected: FAIL, cannot resolve `../../src/substrate/patterns`.

- [ ] **Step 3: Write `src/substrate/patterns/index.ts`**

```ts
import { ExecutionPatternSchema, type ExecutionPattern } from '../envelope';
import type { CouncilRunInput, CouncilRunResult, CouncilRunner } from '../execution/runner';

export { ExecutionPatternSchema, type ExecutionPattern };

/** Blind analysis, rebuttal, optional refinement: the existing multi-round protocol. */
export async function executeRounds(
  runner: CouncilRunner,
  input: CouncilRunInput,
): Promise<CouncilRunResult> {
  return runner.run(input);
}

/** One blind round with no rebuttal. Seats never see each other's output. */
export async function executeParallel(
  runner: CouncilRunner,
  input: CouncilRunInput,
): Promise<CouncilRunResult> {
  if (input.rounds !== 1) {
    throw new Error(
      `The parallel pattern is exactly one blind round; received rounds=${input.rounds}`,
    );
  }
  return runner.run(input);
}

/** Declared for the advisor mode. Implemented by the advisor brief, not this one. */
export function executeStreaming(): never {
  throw new Error(
    'The streaming pattern is declared for the advisor mode and is not implemented in this build',
  );
}

export async function executePattern(
  pattern: ExecutionPattern,
  runner: CouncilRunner,
  input: CouncilRunInput,
): Promise<CouncilRunResult> {
  switch (pattern) {
    case 'rounds':
      return executeRounds(runner, input);
    case 'parallel':
      return executeParallel(runner, input);
    case 'streaming':
      return executeStreaming();
  }
}
```

Append to `src/substrate/index.ts`:

```ts
export * from './patterns';
```

- [ ] **Step 4: Run the test and the type check**

Run: `bun test tests/core/patterns.test.ts && bun run check:types`
Expected: 4 pass, no type errors.

- [ ] **Step 5: Commit**

```bash
bunx prettier --write src/substrate/patterns/index.ts src/substrate/index.ts tests/core/patterns.test.ts
git add src/substrate/patterns src/substrate/index.ts tests/core/patterns.test.ts
git commit -m "feat(substrate): expose the rounds and parallel execution patterns"
```

---

### Task 6: Lift the session helpers out of the CLI

**Files:**

- Create: `src/substrate/session.ts`
- Modify: `src/cli.ts`: delete the moved functions and types, import them, rename `RunOptions` usages to `SessionOptions` where the moved functions are called
- Modify: `src/substrate/index.ts` (one export line)

**Interfaces:**

- Produces from `session.ts`: `DEFAULT_SEAT_COUNT`, `DEFAULT_COUNCIL_MINIMUM_FAMILIES`, `REDUCED_COUNCIL_MINIMUM_FAMILIES`, `REDUCED_QUORUM_WARNING`, `type UnavailableProviderReason`, `interface UnavailableProvider`, `interface SessionOptions`, `quorumPolicy(options)`, `buildManifestAndAssignments(options, registry, provenance, history)`, `loadAssignmentHistory(options, override?)`, `unavailableProvider(probe)`, `autoReducedQuorumWarning(unavailable)`, `resolveHealthyProviders(options, adapters, context)`, `buildPreflight(input)`, `persistSession(...)`, `publicExecution(result)`, `sessionRecordPath(options)`.

This task is a move with one rename: the field `command` on the CLI's `RunOptions` does not travel; the moved functions read `options.chaired` instead of `options.command === 'council'`. Behaviour is identical because the CLI sets `chaired: command === 'council'`.

- [ ] **Step 1: Write `src/substrate/session.ts`**

```ts
import {
  RunManifestSchema,
  type DataClassification,
  type ModelRegistryProvenance,
  type ProjectPolicy,
  type ProviderFamily,
  type RefinementTrigger,
  type RunManifest,
} from './domain/schemas';
import type { Caller, ResultEnvelope } from './envelope';
import type { BillingMode, ProviderAdapter, ProviderContext } from './execution/provider';
import type { CouncilRunResult, CouncilSeatAssignment } from './execution/runner';
import { probeRoster, type ProviderProbe } from './health/probe';
import type { ModelRegistry } from './models/registry';
import type { PolicyDecision } from './policy/data-guard';
import {
  CouncilStore,
  type CurrentSessionRecord,
  type PersistedDecisionState,
} from './records/store';
import {
  AssignmentHistorySchema,
  assignLenses,
  selectLenses,
  type AssignmentHistory,
  type RoleAssignment,
} from './roles/allocator';

export const DEFAULT_SEAT_COUNT = 5;
export const DEFAULT_COUNCIL_MINIMUM_FAMILIES = 4;
export const REDUCED_COUNCIL_MINIMUM_FAMILIES = 3;
export const REDUCED_QUORUM_WARNING =
  'REDUCED-QUORUM COUNCIL: minimum 3 distinct provider families (standing default: 4). This council is weaker than the standing default.';

export type UnavailableProviderReason =
  'missing key' | 'unconfigured' | 'unhealthy' | 'identity-unverified' | 'unsafe-transport';

export interface UnavailableProvider {
  readonly provider: ProviderFamily;
  readonly reason: UnavailableProviderReason;
  readonly detail: string;
}

/**
 * Everything a mode needs to run one session. `chaired` is what `council` used to mean at the
 * command level: the standing four-family floor, the explicit or automatic reduced quorum, and
 * the health preflight before seating. The mode name is carried separately so the same options
 * can describe a committee that was reached through the legacy `run` alias without a chair.
 */
export interface SessionOptions {
  readonly mode: string;
  readonly chaired: boolean;
  readonly caller: Caller;
  readonly dryRun: boolean;
  readonly scope: 'general' | 'project';
  readonly classification: DataClassification;
  readonly motion: string;
  readonly motionId: string;
  readonly runId: string;
  readonly projectId?: string;
  readonly projectPolicy?: ProjectPolicy;
  readonly eligibleProviderFamilies: readonly ProviderFamily[];
  readonly providerFamilies: readonly ProviderFamily[];
  readonly impact: 'low' | 'medium' | 'high';
  readonly contested: boolean;
  readonly domains: readonly string[];
  readonly rounds: number;
  readonly refinementTrigger?: RefinementTrigger;
  readonly timeoutMs: number;
  readonly minimumFamilies?: number;
  readonly reducedQuorumWarning?: string;
  readonly recordsRoot?: string;
  readonly billingMode: BillingMode;
  readonly spendCap?: number;
}

export function quorumPolicy(options: SessionOptions): RunManifest['quorumPolicy'] {
  const significant = options.chaired || options.impact === 'high' || options.contested;
  const minimumDistinctFamilies = options.chaired
    ? (options.minimumFamilies ?? DEFAULT_COUNCIL_MINIMUM_FAMILIES)
    : significant
      ? 4
      : 3;
  return {
    minimumDistinctFamilies,
    requiresContrarian: significant,
    ...(options.chaired && minimumDistinctFamilies < DEFAULT_COUNCIL_MINIMUM_FAMILIES
      ? {
          reducedQuorum: {
            standingDefaultMinimumDistinctFamilies: DEFAULT_COUNCIL_MINIMUM_FAMILIES,
            weakerThanStandingDefault: true as const,
            warning: options.reducedQuorumWarning ?? REDUCED_QUORUM_WARNING,
          },
        }
      : {}),
  };
}

export function buildManifestAndAssignments(
  options: SessionOptions,
  registry: ModelRegistry,
  registryProvenance: ModelRegistryProvenance,
  history: AssignmentHistory,
): {
  manifest: RunManifest;
  assignments: CouncilSeatAssignment[];
  roleAssignments: RoleAssignment[];
} {
  const policy = quorumPolicy(options);
  const lenses = selectLenses(
    { domains: [...options.domains], impact: options.impact, contested: options.contested },
    options.providerFamilies.length,
    { allowReducedThreeSeatCoverage: policy.reducedQuorum !== undefined },
  );
  const seatIds = options.providerFamilies.map((provider) => `${provider}-seat`);
  const roleAssignments = assignLenses(options.runId, options.motionId, seatIds, lenses, history);
  const lensByName = new Map(lenses.map((lens) => [lens.name, lens] as const));
  const assignments = roleAssignments.map((assignment, index): CouncilSeatAssignment => {
    const provider = options.providerFamilies[index];
    const lens = lensByName.get(assignment.lensName);
    if (provider === undefined || lens === undefined) {
      throw new Error('Dynamic role assignment did not resolve a provider lens');
    }
    return {
      seatId: assignment.seatId,
      provider,
      lensName: lens.name,
      lensPrompt: lens.prompt,
      lensCategory: lens.category,
    };
  });
  const routes = Object.fromEntries(
    options.providerFamilies.map((provider) => [provider, registry[provider]] as const),
  );
  const manifest = RunManifestSchema.parse({
    motionId: options.motionId,
    scope: options.scope,
    classification: options.classification,
    routes,
    registryProvenance,
    lenses,
    rounds: options.rounds,
    ...(options.refinementTrigger === undefined
      ? {}
      : { refinementTrigger: options.refinementTrigger }),
    quorumPolicy: policy,
    evidenceReferences: [],
  });
  return { manifest, assignments, roleAssignments };
}

export function publicExecution(result: CouncilRunResult): Omit<CouncilRunResult, 'motion'> {
  const { motion: _motion, ...safeResult } = result;
  return safeResult;
}

export async function loadAssignmentHistory(
  options: SessionOptions,
  override?: AssignmentHistory,
): Promise<AssignmentHistory> {
  if (override !== undefined) return AssignmentHistorySchema.parse(override);
  if (options.recordsRoot === undefined) return [];
  return CouncilStore.open(options.recordsRoot).readAssignmentHistory(
    options.scope,
    { motionId: options.motionId, motion: options.motion },
    options.projectId,
  );
}

export function unavailableProvider(probe: ProviderProbe): UnavailableProvider {
  const reason: UnavailableProviderReason =
    probe.status === 'identity-unverified'
      ? 'identity-unverified'
      : probe.status === 'down'
        ? 'unhealthy'
        : probe.status === 'unsafe-transport'
          ? 'unsafe-transport'
          : /^missing\s+\S+/i.test(probe.reason)
            ? 'missing key'
            : 'unconfigured';
  return {
    provider: probe.provider,
    reason,
    detail: probe.reason || reason,
  };
}

export function autoReducedQuorumWarning(unavailable: readonly UnavailableProvider[]): string {
  const unavailableSummary = unavailable
    .map(({ provider, reason, detail }) => `${provider} — ${reason} (${detail})`)
    .join('; ');
  return `REDUCED-QUORUM COUNCIL: running with 3 configured, reachable provider families; the standing default is 4. This council is weaker than the standing default. Unavailable families: ${unavailableSummary}.`;
}

export async function resolveHealthyProviders(
  options: SessionOptions,
  adapters: Partial<Record<ProviderFamily, ProviderAdapter>>,
  context: ProviderContext,
): Promise<{
  providerFamilies: ProviderFamily[];
  unavailableProviders: UnavailableProvider[];
}> {
  const candidateAdapters = options.providerFamilies.flatMap((provider) => {
    const adapter = adapters[provider];
    return adapter === undefined ? [] : [adapter];
  });
  const probes = await probeRoster(candidateAdapters, context);
  const providerFamilies: ProviderFamily[] = [];
  const unavailableProviders: UnavailableProvider[] = [];
  let probeIndex = 0;

  for (const provider of options.providerFamilies) {
    const adapter = adapters[provider];
    if (adapter === undefined) {
      unavailableProviders.push({
        provider,
        reason: 'unhealthy',
        detail: 'provider adapter is unavailable',
      });
      continue;
    }
    const probe = probes[probeIndex];
    probeIndex += 1;
    if (probe === undefined || probe.provider !== provider) {
      unavailableProviders.push({
        provider,
        reason: 'unhealthy',
        detail: 'provider health result did not match the requested family',
      });
      continue;
    }
    if (probe.status === 'healthy') {
      providerFamilies.push(provider);
    } else {
      unavailableProviders.push(unavailableProvider(probe));
    }
  }

  return { providerFamilies, unavailableProviders };
}

export interface PreflightInput {
  readonly policyDecision: PolicyDecision;
  readonly requestedProviders: readonly ProviderFamily[];
  readonly selectedProviders: readonly ProviderFamily[];
  readonly unavailableProviders: readonly UnavailableProvider[];
  readonly eligibleProviders: readonly ProviderFamily[];
}

export function buildPreflight(input: PreflightInput) {
  return {
    classification: input.policyDecision.effectiveClassification,
    destinations: input.policyDecision.dispositions,
    requestedProviders: input.requestedProviders,
    selectedProviders: input.selectedProviders,
    unavailableProviders: input.unavailableProviders,
    eligibleProviders: input.eligibleProviders,
    omittedEligibleProviders: input.eligibleProviders.filter(
      (provider) => !input.requestedProviders.includes(provider),
    ),
    redactionCount: input.policyDecision.redactions.reduce(
      (count, redaction) => count + redaction.findings.length,
      0,
    ),
  };
}

/** Records-root-relative path of the session record, known before it is written. */
export function sessionRecordPath(options: SessionOptions): string | null {
  if (options.recordsRoot === undefined) return null;
  const scope =
    options.scope === 'general' ? 'general' : `projects/${options.projectId ?? 'unknown'}`;
  return `${scope}/sessions/${options.runId}.json`;
}

export interface PersistedSession {
  readonly records: {
    readonly session: true;
    readonly decisionState: PersistedDecisionState;
    readonly dataAvailability: 'captured';
  };
  readonly decisionState: PersistedDecisionState;
}

export async function persistSession(
  options: SessionOptions,
  decision: PolicyDecision,
  manifest: RunManifest,
  result: CouncilRunResult,
  roleAssignments: RoleAssignment[],
  startedAt: string,
  now: string,
  envelope: ResultEnvelope | undefined,
): Promise<PersistedSession | undefined> {
  if (options.recordsRoot === undefined) return undefined;
  if (options.scope === 'project' && options.projectId === undefined) {
    throw new Error('Project record persistence requires a project id');
  }
  const store = CouncilStore.open(options.recordsRoot);
  const status = result.outcome;
  const outcomeSummary =
    status === 'completed'
      ? `Quorum passed across ${result.quorum.successfulFamilies.length} provider families; a chair ruling is required before this becomes a resolution.`
      : status === 'degraded'
        ? `Degraded result across ${result.quorum.successfulFamilies.length} provider families; chair acceptance and a chair ruling are both required before resolution.`
        : `Quorum blocked: ${result.quorum.failureReasons.join(', ') || 'insufficient responses'}.`;
  const reducedQuorumWarning = result.quorumPolicy.reducedQuorum?.warning;
  const sessionSummary =
    reducedQuorumWarning === undefined
      ? outcomeSummary
      : `${reducedQuorumWarning} ${outcomeSummary}`;
  const decisionState: PersistedDecisionState =
    status === 'completed' || status === 'degraded' ? 'awaiting-adjudication' : 'not-adjudicable';
  const sessionBase = {
    schemaVersion: 2 as const,
    runId: options.runId,
    motionId: options.motionId,
    status,
    motion: options.motion,
    startedAt,
    completedAt: now,
    decisionState,
    policyDecision: {
      kind: decision.kind,
      classification: decision.effectiveClassification ?? options.classification,
      reasonCodes: decision.reasonCodes,
    },
    destinations: options.providerFamilies.map((provider) => ({
      provider,
      model: manifest.routes[provider]?.primary ?? 'unresolved',
    })),
    protocol: {
      requestedRounds: result.requestedRounds,
      ...(result.refinementTrigger === undefined
        ? {}
        : { refinementTrigger: result.refinementTrigger }),
      quorumPolicy: result.quorumPolicy,
    },
    // The decision-level evidence: every seat's actual answer, the model that really responded,
    // whether that identity verified, what was retried and why. Without this a record proves only
    // what was requested, never what was decided.
    execution: {
      rounds: result.rounds,
      quorum: result.quorum,
      rebuttalObligation: result.rebuttalObligation,
      synthesisEligible: result.synthesisEligible,
    },
    assignments: roleAssignments,
    summary: sessionSummary,
    ...(envelope === undefined ? {} : { envelope }),
  } as const;
  const session: CurrentSessionRecord =
    options.scope === 'general'
      ? { ...sessionBase, scope: 'general' }
      : {
          ...sessionBase,
          scope: 'project',
          projectId: options.projectId as string,
        };
  await store.writeSession(session);
  return {
    records: { session: true, decisionState, dataAvailability: 'captured' },
    decisionState,
  };
}
```

The `envelope` field on the session record does not exist until Task 8 adds it to the store schema. Until then always call `persistSession(..., undefined)` from the CLI, which spreads nothing.

- [ ] **Step 2: Remove the moved code from `src/cli.ts` and import it**

Delete from `src/cli.ts`: the constants `DEFAULT_SEAT_COUNT`, `DEFAULT_COUNCIL_MINIMUM_FAMILIES`, `REDUCED_COUNCIL_MINIMUM_FAMILIES`, `REDUCED_QUORUM_WARNING`; the types `UnavailableProviderReason` and `UnavailableProvider`; the functions `unavailableProvider`, `autoReducedQuorumWarning`, `quorumPolicy`, `buildManifestAndAssignments`, `publicExecution`, `loadAssignmentHistory`, `persistRun`, `resolveCouncilProviders`. Keep the block comment that begins `Deliberately absent: a \`consensusRecommendation()\``in`src/cli.ts`, placed above `runCouncilCommand`.

Add the import:

```ts
import {
  DEFAULT_COUNCIL_MINIMUM_FAMILIES,
  DEFAULT_SEAT_COUNT,
  REDUCED_COUNCIL_MINIMUM_FAMILIES,
  autoReducedQuorumWarning,
  buildManifestAndAssignments,
  buildPreflight,
  loadAssignmentHistory,
  persistSession,
  publicExecution,
  resolveHealthyProviders,
  type SessionOptions,
  type UnavailableProvider,
} from './substrate/session';
```

Change the `RunOptions` interface in `src/cli.ts` to extend the session options with the CLI-only command:

```ts
interface RunOptions extends SessionOptions {
  readonly command: 'run' | 'council' | 'second-opinion';
}
```

In `parseRunOptions`, add to the returned object (this task only; the caller and spend flags come in Task 8):

```ts
    mode: command === 'council' ? 'committee' : 'second-opinion',
    chaired: command === 'council',
    caller: UNDECLARED_CALLER,
```

with `import { UNDECLARED_CALLER } from './substrate/envelope';`. Remove the import of `probeRoster` from `src/cli.ts` only if `healthCommand` no longer uses it; it does (`probeRoster` is used by `health`), so keep it.

In `runCouncilCommand` replace each inline `preflight` literal with `buildPreflight({ policyDecision, requestedProviders: requestedProviderFamilies, selectedProviders: <the same value the literal used>, unavailableProviders: <the same>, eligibleProviders: options.eligibleProviderFamilies })`. The blocked-policy branch has no `classification`, `destinations` or `redactionCount` in its literal and carries `decision: policyDecision`; keep that literal as it is. Replace `resolveCouncilProviders(` with `resolveHealthyProviders(`, `loadAssignmentHistory(options, environment)` with `loadAssignmentHistory(options, environment.assignmentHistory)`, and `persistRun(executionOptions, policyDecision, manifest, execution, roleAssignments, startedAt, now)` with:

```ts
const persisted = await persistSession(
  executionOptions,
  policyDecision,
  manifest,
  execution,
  roleAssignments,
  startedAt,
  now,
  undefined,
);
const records = persisted?.records;
```

Append to `src/substrate/index.ts`:

```ts
export * from './session';
```

- [ ] **Step 3: Type-check and run the suite**

Run: `bun run check:types && bun run test`
Expected: no type errors; every test passes. The facade tests assert the preflight objects and the `records` object; both are byte-for-byte what they were.

- [ ] **Step 4: Commit**

```bash
bunx prettier --write src/cli.ts src/substrate/session.ts src/substrate/index.ts
git add src/cli.ts src/substrate/session.ts src/substrate/index.ts
git commit -m "refactor(substrate): lift the session helpers out of the CLI into the substrate"
```

---

### Task 7: Modes registry with committee and second opinion

**Files:**

- Create: `src/modes/types.ts`, `src/modes/index.ts`, `src/modes/committee/index.ts`, `src/modes/second-opinion/index.ts`
- Create: `tests/core/modes.test.ts`
- Modify: `src/index.ts` (add one export line)

**Interfaces:**

- Consumes from `../substrate` only: `SessionOptions`, `ProviderAdapter`, `ProviderContext`, `ProviderFamily`, `PolicyDecision`, `UnavailableProvider`, `resolveHealthyProviders`, `autoReducedQuorumWarning`, `DEFAULT_COUNCIL_MINIMUM_FAMILIES`, `REDUCED_COUNCIL_MINIMUM_FAMILIES`, `CouncilRunResult`, `CouncilOutcomeSchema`, `QuorumEvaluationSchema`, `RebuttalObligationSchema`, `PersistedDecisionStateSchema`, `PersistedDecisionState`, `ProviderFamilySchema`, `MotionImpact`, `ExecutionPattern`, `SpendPolicy`.
- Produces: `MODE_NAMES`, `type ModeName`, `interface ModeDefinition`, `modes`, `getMode(name)`, `resolveModeForCommand(command, significant)`.

- [ ] **Step 1: Write the failing test**

Create `tests/core/modes.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MODE_NAMES, getMode, modes, resolveModeForCommand } from '../../src/modes';
import type { ModeResultView } from '../../src/modes/types';
import type {
  Availability,
  HealthResult,
  PolicyDecision,
  ProviderAdapter,
  ProviderContext,
  SeatResponse,
  SessionOptions,
} from '../../src/substrate';

function adapter(
  family: ProviderAdapter['family'],
  health: HealthResult['status'],
): ProviderAdapter {
  return {
    family,
    transport: 'http',
    async availability(): Promise<Availability> {
      return { status: 'available', provider: family, model: 'm', reason: 'stub' };
    },
    async invoke(): Promise<SeatResponse> {
      throw new Error('prepare must not invoke seats');
    },
    async probe(): Promise<HealthResult> {
      return {
        status: health,
        provider: family,
        requestedModel: 'm',
        actualModel: health === 'healthy' ? 'm' : null,
        latencyMs: 1,
        reason: health === 'healthy' ? 'ok' : 'down for the test',
      };
    },
  };
}

const context: ProviderContext = {
  registry: {} as ProviderContext['registry'],
  env: {},
  cwd: 'C:/isolated',
  timeoutMs: 1_000,
};

const policyDecision = {
  kind: 'allowed',
  reasonCodes: [],
  blockedProviders: [],
  dispositions: [],
  redactions: [],
} as unknown as PolicyDecision;

function options(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    mode: 'committee',
    chaired: true,
    caller: { kind: 'human', harness: 'test', declared: true },
    dryRun: false,
    scope: 'general',
    classification: 'public',
    motion: 'motion',
    motionId: 'motion-1',
    runId: 'run-1',
    eligibleProviderFamilies: ['anthropic', 'openai', 'xai', 'google'],
    providerFamilies: ['anthropic', 'openai', 'xai', 'google'],
    impact: 'high',
    contested: true,
    domains: [],
    rounds: 2,
    timeoutMs: 1_000,
    billingMode: 'sub-first',
    ...overrides,
  };
}

describe('modes registry', () => {
  test('registers committee and second opinion', () => {
    expect([...MODE_NAMES]).toEqual(['committee', 'second-opinion']);
    expect(modes.committee.pattern).toBe('rounds');
    expect(modes['second-opinion'].pattern).toBe('parallel');
    expect(modes.committee.spend.defaultCap(5, 2)).toBe(10);
    expect(modes['second-opinion'].spend.defaultCap(5, 1)).toBe(5);
  });

  test('an unknown mode fails with the registered names', () => {
    expect(() => getMode('forum')).toThrow(/Unknown mode: forum.*committee, second-opinion/);
  });

  test('commands resolve to modes as they did before', () => {
    expect(resolveModeForCommand('council', true)).toBe('committee');
    expect(resolveModeForCommand('second-opinion', false)).toBe('second-opinion');
    expect(resolveModeForCommand('run', false)).toBe('second-opinion');
    expect(resolveModeForCommand('run', true)).toBe('committee');
  });

  test('committee skips the health preflight when unchaired', async () => {
    const outcome = await modes.committee.prepare({
      options: options({ chaired: false }),
      adapters: { anthropic: adapter('anthropic', 'down') },
      context,
      policyDecision,
    });
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('unreachable');
    expect(outcome.options.providerFamilies).toEqual(['anthropic', 'openai', 'xai', 'google']);
  });

  test('a chaired committee blocks below three healthy families and reduces at exactly three', async () => {
    const blocked = await modes.committee.prepare({
      options: options(),
      adapters: {
        anthropic: adapter('anthropic', 'healthy'),
        openai: adapter('openai', 'healthy'),
        xai: adapter('xai', 'down'),
        google: adapter('google', 'down'),
      },
      context,
      policyDecision,
    });
    expect(blocked.kind).toBe('blocked-quorum');

    const reduced = await modes.committee.prepare({
      options: options(),
      adapters: {
        anthropic: adapter('anthropic', 'healthy'),
        openai: adapter('openai', 'healthy'),
        xai: adapter('xai', 'healthy'),
        google: adapter('google', 'down'),
      },
      context,
      policyDecision,
    });
    expect(reduced.kind).toBe('ready');
    if (reduced.kind !== 'ready') throw new Error('unreachable');
    expect(reduced.options.minimumFamilies).toBe(3);
    expect(reduced.options.reducedQuorumWarning).toContain('REDUCED-QUORUM COUNCIL');
    expect(reduced.unavailableProviders.map(({ provider }) => provider)).toEqual(['google']);
  });

  test('second opinion never probes and reports the panel', async () => {
    const outcome = await modes['second-opinion'].prepare({
      options: options({
        mode: 'second-opinion',
        chaired: false,
        rounds: 1,
        impact: 'medium',
        contested: false,
      }),
      adapters: { anthropic: adapter('anthropic', 'down') },
      context,
      policyDecision,
    });
    expect(outcome.kind).toBe('ready');

    const result: ModeResultView = {
      outcome: 'completed',
      quorum: {
        passed: true,
        minimumDistinctFamilies: 3,
        successfulFamilies: ['anthropic'],
        requiresContrarian: false,
        contrarianSatisfied: true,
        failureReasons: [],
      },
      rebuttalObligation: {
        minimumSuccessfulResponses: 0,
        successfulResponses: 0,
        satisfied: true,
      },
      synthesisEligible: true,
      rounds: [
        {
          round: 1,
          phase: 'analysis',
          retries: [],
          responses: [
            {
              status: 'ok',
              seatId: 'anthropic-seat',
              provider: 'anthropic',
              requestedModel: 'm',
              actualModel: 'm',
              modelIdentity: 'verified',
              route: 'primary',
              role: 'architect',
              latencyMs: 1,
              answer: '{"recommendation":"x"}',
            },
          ],
        },
      ],
    };
    const output = modes['second-opinion'].output({
      result,
      decisionState: 'awaiting-adjudication',
    });
    expect(modes['second-opinion'].outputSchema.parse(output)).toEqual(output);
    expect(output).toMatchObject({
      outcome: 'completed',
      panel: [
        {
          seat: 'anthropic-seat',
          family: 'anthropic',
          lens: 'architect',
          answer: '{"recommendation":"x"}',
        },
      ],
    });
    const committee = modes.committee.output({ result, decisionState: 'awaiting-adjudication' });
    expect(modes.committee.outputSchema.parse(committee)).toEqual(committee);
    expect(committee).toMatchObject({
      outcome: 'completed',
      decisionState: 'awaiting-adjudication',
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/core/modes.test.ts`
Expected: FAIL, cannot resolve `../../src/modes`.

- [ ] **Step 3: Write `src/modes/types.ts`**

```ts
import type { z } from 'zod';
import type {
  CouncilRunResult,
  ExecutionPattern,
  MotionImpact,
  PersistedDecisionState,
  PolicyDecision,
  ProviderAdapter,
  ProviderContext,
  ProviderFamily,
  SessionOptions,
  SpendPolicy,
  UnavailableProvider,
} from '../substrate';

export const MODE_NAMES = ['committee', 'second-opinion'] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/** The five knobs from docs/vision.md, as a description of the mode rather than as behaviour. */
export interface ModeKnobs {
  readonly participants: string;
  readonly pattern: ExecutionPattern;
  readonly aggregation: string;
  readonly tempo: string;
  readonly records: string;
}

export interface ModeDefaults {
  readonly impact: MotionImpact;
  readonly contested: boolean;
  readonly rounds: number;
}

export interface ModeSpend {
  readonly policy: SpendPolicy;
  /** Default cap on metered fallback calls for a session with this many seats and rounds. */
  defaultCap(seats: number, rounds: number): number;
}

export interface ModePrepareInput {
  readonly options: SessionOptions;
  readonly adapters: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly context: ProviderContext;
  readonly policyDecision: PolicyDecision;
}

export type ModePrepareOutcome =
  | {
      readonly kind: 'ready';
      readonly options: SessionOptions;
      readonly unavailableProviders: readonly UnavailableProvider[];
    }
  | {
      readonly kind: 'blocked-quorum';
      readonly message: string;
      readonly selectedProviders: readonly ProviderFamily[];
      readonly unavailableProviders: readonly UnavailableProvider[];
    };

export type ModeResultView = Pick<
  CouncilRunResult,
  'outcome' | 'quorum' | 'rebuttalObligation' | 'synthesisEligible' | 'rounds'
>;

export interface ModeOutputInput {
  readonly result: ModeResultView;
  readonly decisionState: PersistedDecisionState | null;
}

export interface ModeDefinition {
  readonly name: ModeName;
  readonly knobs: ModeKnobs;
  readonly pattern: ExecutionPattern;
  readonly defaults: ModeDefaults;
  readonly spend: ModeSpend;
  readonly outputSchema: z.ZodTypeAny;
  /** Everything between policy preflight and seating: for the committee, the health preflight. */
  prepare(input: ModePrepareInput): Promise<ModePrepareOutcome>;
  /** The mode-specific `output` block of the result envelope. Must satisfy `outputSchema`. */
  output(input: ModeOutputInput): Record<string, unknown>;
}
```

- [ ] **Step 4: Write `src/modes/committee/index.ts`**

```ts
import { z } from 'zod';
import {
  CouncilOutcomeSchema,
  DEFAULT_COUNCIL_MINIMUM_FAMILIES,
  PersistedDecisionStateSchema,
  QuorumEvaluationSchema,
  REDUCED_COUNCIL_MINIMUM_FAMILIES,
  RebuttalObligationSchema,
  autoReducedQuorumWarning,
  resolveHealthyProviders,
} from '../../substrate';
import type { ModeDefinition, ModePrepareInput, ModePrepareOutcome } from '../types';

export const CommitteeOutputSchema = z.strictObject({
  outcome: CouncilOutcomeSchema,
  quorum: QuorumEvaluationSchema,
  rebuttalObligation: RebuttalObligationSchema,
  synthesisEligible: z.boolean(),
  decisionState: PersistedDecisionStateSchema.nullable(),
});

async function prepare(input: ModePrepareInput): Promise<ModePrepareOutcome> {
  if (!input.options.chaired) {
    return { kind: 'ready', options: input.options, unavailableProviders: [] };
  }
  const readiness = await resolveHealthyProviders(input.options, input.adapters, input.context);
  const minimumFamilies =
    input.options.minimumFamilies ??
    (readiness.providerFamilies.length >= DEFAULT_COUNCIL_MINIMUM_FAMILIES
      ? DEFAULT_COUNCIL_MINIMUM_FAMILIES
      : REDUCED_COUNCIL_MINIMUM_FAMILIES);
  if (readiness.providerFamilies.length < minimumFamilies) {
    return {
      kind: 'blocked-quorum',
      message: `Council requires at least ${minimumFamilies} configured, reachable provider families; found ${readiness.providerFamilies.length}.`,
      selectedProviders: readiness.providerFamilies,
      unavailableProviders: readiness.unavailableProviders,
    };
  }
  return {
    kind: 'ready',
    unavailableProviders: readiness.unavailableProviders,
    options: {
      ...input.options,
      providerFamilies: readiness.providerFamilies,
      minimumFamilies,
      ...(minimumFamilies === REDUCED_COUNCIL_MINIMUM_FAMILIES &&
      readiness.providerFamilies.length === REDUCED_COUNCIL_MINIMUM_FAMILIES &&
      readiness.unavailableProviders.length > 0
        ? { reducedQuorumWarning: autoReducedQuorumWarning(readiness.unavailableProviders) }
        : {}),
    },
  };
}

export const committee: ModeDefinition = {
  name: 'committee',
  knobs: {
    participants: 'fixed seats chosen by the lens allocator; quorum counted in distinct families',
    pattern: 'rounds',
    aggregation: 'chair adjudication; dissent recorded; decision record',
    tempo: 'long',
    records: 'ledger, sessions and resolutions',
  },
  pattern: 'rounds',
  defaults: { impact: 'high', contested: true, rounds: 2 },
  spend: { policy: 'capped', defaultCap: (seats, rounds) => seats * rounds },
  outputSchema: CommitteeOutputSchema,
  prepare,
  output({ result, decisionState }) {
    return {
      outcome: result.outcome,
      quorum: result.quorum,
      rebuttalObligation: result.rebuttalObligation,
      synthesisEligible: result.synthesisEligible,
      decisionState,
    };
  },
};
```

- [ ] **Step 5: Write `src/modes/second-opinion/index.ts`**

```ts
import { z } from 'zod';
import {
  CouncilOutcomeSchema,
  ProviderFamilySchema,
  QuorumEvaluationSchema,
} from '../../substrate';
import type { ModeDefinition } from '../types';

const NonEmptyStringSchema = z.string().trim().min(1);

export const SecondOpinionOutputSchema = z.strictObject({
  outcome: CouncilOutcomeSchema,
  quorum: QuorumEvaluationSchema,
  panel: z.array(
    z.strictObject({
      seat: NonEmptyStringSchema,
      family: ProviderFamilySchema,
      lens: NonEmptyStringSchema,
      answer: z.string(),
    }),
  ),
});

export const secondOpinion: ModeDefinition = {
  name: 'second-opinion',
  knobs: {
    participants: 'three or more distinct families, blind, one lens each',
    pattern: 'parallel',
    aggregation: 'attributed panel; synthesis is a later brief',
    tempo: 'about a minute',
    records: 'session with every seat answer',
  },
  pattern: 'parallel',
  defaults: { impact: 'medium', contested: false, rounds: 1 },
  spend: { policy: 'capped', defaultCap: (seats, rounds) => seats * rounds },
  outputSchema: SecondOpinionOutputSchema,
  async prepare({ options }) {
    return { kind: 'ready', options, unavailableProviders: [] };
  },
  output({ result }) {
    const first = result.rounds[0];
    const panel =
      first === undefined
        ? []
        : first.responses.flatMap((response) =>
            response.status === 'ok'
              ? [
                  {
                    seat: response.seatId,
                    family: response.provider,
                    lens: response.role,
                    answer: response.answer,
                  },
                ]
              : [],
          );
    return { outcome: result.outcome, quorum: result.quorum, panel };
  },
};
```

- [ ] **Step 6: Write `src/modes/index.ts`**

```ts
import { committee } from './committee';
import { secondOpinion } from './second-opinion';
import { MODE_NAMES, type ModeDefinition, type ModeName } from './types';

export * from './types';

export const modes: Readonly<Record<ModeName, ModeDefinition>> = Object.freeze({
  committee,
  'second-opinion': secondOpinion,
});

export function getMode(name: string): ModeDefinition {
  const mode = (modes as Readonly<Record<string, ModeDefinition | undefined>>)[name];
  if (mode === undefined) {
    throw new Error(`Unknown mode: ${name}. Registered modes: ${MODE_NAMES.join(', ')}`);
  }
  return mode;
}

/**
 * `council` was always the chaired committee and `second-opinion` one blind round. `run` is the
 * legacy classified alias: significant motions took the committee's quorum without its chair, so
 * they map to `committee` and the CLI marks the envelope `legacy-run-alias`.
 */
export function resolveModeForCommand(
  command: 'run' | 'council' | 'second-opinion',
  significant: boolean,
): ModeName {
  if (command === 'council') return 'committee';
  if (command === 'second-opinion') return 'second-opinion';
  return significant ? 'committee' : 'second-opinion';
}
```

Change `src/index.ts` to:

```ts
export * from './substrate';
export * from './modes';
```

- [ ] **Step 7: Run the tests, the dependency test and the type check**

Run: `bun test tests/core/modes.test.ts tests/core/dependency-direction.test.ts && bun run check:types`
Expected: all pass. If the dependency test fails, a mode file imported something other than `../../substrate`; fix the import, not the test.

- [ ] **Step 8: Commit**

```bash
bunx prettier --write src/modes src/index.ts tests/core/modes.test.ts
git add src/modes src/index.ts tests/core/modes.test.ts
git commit -m "feat(modes): add the registry with committee and second opinion as the first modes"
```

---

### Task 8: Dispatch through the registry, declare the caller, emit and persist the envelope

**Files:**

- Modify: `src/cli.ts`: flag sets, `RunOptions`, `commandDefaults`, `parseRunOptions`, `runCouncilCommand`, routing, help
- Modify: `src/substrate/records/store.ts:176-181` (`CurrentSessionRecordShape`)
- Modify: `commands/council.md:13`, `commands/second-opinion.md:13`, `commands/ask.md`
- Modify: `tests/core/cli-facade.test.ts` (append tests)
- Modify: `tests/core/records.test.ts` (append one test)

**Interfaces:**

- Consumes: `getMode`, `resolveModeForCommand`, `modes` from `./modes`; `buildEnvelope`, `spendFromRounds`, `CallerSchema`, `UNDECLARED_CALLER`, `ResultEnvelopeSchema`, `createSpendLedger`, `effectiveBillingMode`, `spendCapExhaustedMessage`, `executePattern`, `sessionRecordPath` from the substrate.
- Produces: run output gains `mode` and `envelope`; dry-run output gains `mode` and `caller`; new `modes` command; session records gain optional `envelope`.

- [ ] **Step 1: Append the facade tests**

Append inside the `describe('public CLI facade', ...)` block of `tests/core/cli-facade.test.ts`, after the last existing test in that block:

```ts
test('every executed run returns a validated envelope and names its mode', async () => {
  const fixture = await fixtureEnvironment(undefined, true);
  const council = await runCliFacade(
    ['council', '--classification', 'public', '--motion', 'Envelope for a council'],
    fixture.environment,
  );
  expect(council.exitCode).toBe(0);
  const councilPayload = JSON.parse(council.stdout);
  expect(councilPayload.mode).toBe('committee');
  const councilEnvelope = ResultEnvelopeSchema.parse(councilPayload.envelope);
  expect(councilEnvelope.mode).toBe('committee');
  expect(councilEnvelope.pattern).toBe('rounds');
  expect(councilEnvelope.rounds).toBe(2);
  expect(councilEnvelope.caller).toEqual({ kind: 'human', harness: 'unknown', declared: false });
  expect(councilEnvelope.degraded).toContain('caller-undeclared');
  expect(councilEnvelope.seats.length).toBeGreaterThanOrEqual(4);
  expect(councilEnvelope.spend).toMatchObject({
    policy: 'capped',
    billing: 'sub-first',
    stoppedAtCap: false,
  });
  expect(councilEnvelope.record).toEqual({ session: null });

  const opinion = await runCliFacade(
    [
      'second-opinion',
      '--classification',
      'public',
      '--caller',
      'agent',
      '--harness',
      'omp',
      '--purpose',
      'choose a library',
      '--motion',
      'Envelope for a second opinion',
    ],
    fixture.environment,
  );
  expect(opinion.exitCode).toBe(0);
  const opinionPayload = JSON.parse(opinion.stdout);
  expect(opinionPayload.mode).toBe('second-opinion');
  const opinionEnvelope = ResultEnvelopeSchema.parse(opinionPayload.envelope);
  expect(opinionEnvelope.pattern).toBe('parallel');
  expect(opinionEnvelope.rounds).toBe(1);
  expect(opinionEnvelope.caller).toEqual({
    kind: 'agent',
    harness: 'omp',
    purpose: 'choose a library',
    declared: true,
  });
  expect(opinionEnvelope.degraded).not.toContain('caller-undeclared');
  expect(Array.isArray(opinionEnvelope.output.panel)).toBe(true);
});

test('the legacy run alias is marked when it resolves to the committee', async () => {
  const fixture = await fixtureEnvironment(undefined, true);
  const result = await runCliFacade(
    [
      'run',
      '--classification',
      'public',
      '--impact',
      'high',
      '--rounds',
      '2',
      '--motion',
      'Legacy alias',
    ],
    fixture.environment,
  );
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.mode).toBe('committee');
  expect(payload.envelope.degraded).toContain('legacy-run-alias');
});

test('--harness and --purpose require --caller, and the spend cap must be a whole number', async () => {
  const fixture = await fixtureEnvironment(undefined, true);
  const harnessOnly = await runCliFacade(
    ['second-opinion', '--classification', 'public', '--harness', 'omp', '--motion', 'm'],
    fixture.environment,
  );
  expect(harnessOnly.exitCode).toBe(2);
  expect(harnessOnly.stderr).toContain('--caller');
  const badCap = await runCliFacade(
    ['second-opinion', '--classification', 'public', '--spend-cap', '-1', '--motion', 'm'],
    fixture.environment,
  );
  expect(badCap.exitCode).toBe(2);
});

test('the persisted session record carries the envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'council-envelope-record-'));
  try {
    const fixture = await fixtureEnvironment(undefined, true);
    const result = await runCliFacade(
      [
        'second-opinion',
        '--classification',
        'public',
        '--records-root',
        root,
        '--motion',
        'Persist the envelope',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.records).toEqual({
      session: true,
      decisionState: 'awaiting-adjudication',
      dataAvailability: 'captured',
    });
    expect(payload.envelope.record.session).toBe(`general/sessions/${payload.runId}.json`);
    const persisted = JSON.parse(
      await Bun.file(join(root, payload.envelope.record.session)).text(),
    );
    expect(ResultEnvelopeSchema.parse(persisted.envelope).session).toBe(payload.runId);
    expect(persisted.envelope.record).toEqual({ session: payload.envelope.record.session });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the modes command lists the registered modes', async () => {
  const result = await runCliFacade(['modes']);
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.modes.map((mode: { name: string }) => mode.name)).toEqual([
    'committee',
    'second-opinion',
  ]);
  expect(payload.modes[0]).toMatchObject({ pattern: 'rounds', spend: { policy: 'capped' } });
});
```

Add the imports the new tests need at the top of `tests/core/cli-facade.test.ts` (keep the existing ones):

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultEnvelopeSchema } from '../../src/substrate/envelope';
```

If `mkdtemp`, `rm`, `tmpdir` or `join` are already imported in that file, do not import them twice.

Append to `tests/core/records.test.ts`, inside its main `describe`:

```ts
test('a session record without an envelope still loads, and one with an envelope round-trips', async () => {
  await withCouncilFixture(async (_root, store) => {
    const bare = generalSession();
    await store.writeSession(bare);
    const withEnvelope = {
      ...generalSession(),
      runId: `${bare.runId}-env`,
      motionId: `${bare.motionId}-env`,
      envelope: {
        schemaVersion: 1,
        mode: 'second-opinion',
        session: `${bare.runId}-env`,
        caller: { kind: 'human', harness: 'test', declared: true },
        pattern: 'parallel',
        rounds: 1,
        seats: [],
        output: {},
        synthesis: null,
        dissent: null,
        unanimous: false,
        spend: {
          billing: 'sub-first',
          policy: 'capped',
          cap: 1,
          used: 0,
          fallbacks: 0,
          refused: 0,
          stoppedAtCap: false,
        },
        degraded: [],
        record: { session: null },
      },
    } as const;
    await store.writeSession(withEnvelope);
    const states = await store.readDecisionStates('general');
    expect(states.map(({ runId }) => runId).sort()).toEqual(
      [bare.runId, withEnvelope.runId].sort(),
    );
  });
});
```

If `generalSession()` in that file already fixes `runId` and `motionId` to constants, the spread above overrides them; if it takes arguments, pass distinct ids the same way its existing callers do.

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/core/cli-facade.test.ts tests/core/records.test.ts`
Expected: the new tests fail (`Unknown option: --caller`, `Unknown command: modes`, unrecognised `envelope` key in the strict session schema).

- [ ] **Step 3: Add the optional envelope to session records**

In `src/substrate/records/store.ts` add the import:

```ts
import { ResultEnvelopeSchema } from '../envelope';
```

and change `CurrentSessionRecordShape` to:

```ts
const CurrentSessionRecordShape = {
  ...SessionRecordShape,
  schemaVersion: z.literal(2),
  decisionState: PersistedDecisionStateSchema,
  execution: ExecutionSnapshotSchema,
  // Additive. Records written before the envelope existed stay valid, and the envelope is the
  // same object the caller received, so what an agent consumed and what is stored do not drift.
  envelope: ResultEnvelopeSchema.optional(),
};
```

- [ ] **Step 4: Wire the CLI**

In `src/cli.ts`:

1. Add to `COMMON_RUN_FLAGS`: `'caller'`, `'harness'`, `'purpose'`, `'spend-cap'`.
2. Add imports:

```ts
import { getMode, modes, resolveModeForCommand, type ModeName } from './modes';
import {
  CallerSchema,
  UNDECLARED_CALLER,
  buildEnvelope,
  spendFromRounds,
  type Caller,
  type ResultEnvelope,
} from './substrate/envelope';
import { executePattern } from './substrate/patterns';
import {
  createSpendLedger,
  effectiveBillingMode,
  spendCapExhaustedMessage,
} from './substrate/spend';
import { sessionRecordPath } from './substrate/session';
```

3. Replace `commandDefaults` with:

```ts
function commandDefaults(command: RunOptions['command']): {
  impact: RunOptions['impact'];
  contested: boolean;
  rounds: number;
} {
  return command === 'council' ? modes.committee.defaults : modes['second-opinion'].defaults;
}
```

4. In `parseRunOptions`, after `const significant = ...` add:

```ts
const callerKind = oneFlag(parsed, 'caller');
const harness = oneFlag(parsed, 'harness')?.trim();
const purpose = oneFlag(parsed, 'purpose')?.trim();
if (callerKind === undefined && (harness !== undefined || purpose !== undefined)) {
  throw new Error('--harness and --purpose require --caller human|agent');
}
const caller: Caller =
  callerKind === undefined
    ? UNDECLARED_CALLER
    : CallerSchema.parse({
        kind: callerKind,
        harness: harness ?? 'unknown',
        declared: true,
        ...(purpose === undefined || purpose.length === 0 ? {} : { purpose }),
      });
const spendCap = parsed.flags.has('spend-cap')
  ? integerFlag(parsed, 'spend-cap', 0, 0, 100_000)
  : undefined;
const mode: ModeName = resolveModeForCommand(command, significant);
```

and in the returned object replace the three lines added in Task 6 with:

```ts
    mode,
    chaired: command === 'council',
    caller,
    ...(spendCap === undefined ? {} : { spendCap }),
```

5. Rewrite the body of `runCouncilCommand` from the line `const adapters =` to the end of the function as:

```ts
const mode = getMode(options.mode);
const billingMode = effectiveBillingMode(mode.spend.policy, options.billingMode);
const adapters =
  environment.adapters ??
  createProviderRoster({
    env: environment.env ?? process.env,
    billingMode,
  });
const diagnostics: ProviderDiagnostic[] = [];
const spendCap =
  options.spendCap ?? mode.spend.defaultCap(options.providerFamilies.length, options.rounds);
const ledger = createSpendLedger(spendCap);
const context: ProviderContext = {
  registry,
  env: environment.env ?? process.env,
  cwd: environment.cwd ?? process.cwd(),
  timeoutMs: options.timeoutMs,
  captureDiagnostic: (diagnostic) => {
    diagnostics.push(diagnostic);
  },
  spend: ledger,
};

const prepared = await mode.prepare({ options, adapters, context, policyDecision });
if (prepared.kind === 'blocked-quorum') {
  return output(4, undefined, {
    schemaVersion: SCHEMA_VERSION,
    command,
    mode: mode.name,
    status: 'blocked-quorum',
    runId: options.runId,
    message: prepared.message,
    preflight: buildPreflight({
      policyDecision,
      requestedProviders: requestedProviderFamilies,
      selectedProviders: prepared.selectedProviders,
      unavailableProviders: prepared.unavailableProviders,
      eligibleProviders: options.eligibleProviderFamilies,
    }),
  });
}
const executionOptions: RunOptions = { ...prepared.options, command };
const unavailableProviders: UnavailableProvider[] = [...prepared.unavailableProviders];

const assignmentHistory = await loadAssignmentHistory(
  executionOptions,
  environment.assignmentHistory,
);
const { manifest, assignments, roleAssignments } = buildManifestAndAssignments(
  executionOptions,
  registry,
  configured.provenance,
  assignmentHistory,
);
const reducedQuorumWarning = manifest.quorumPolicy.reducedQuorum?.warning;
const preflight = buildPreflight({
  policyDecision,
  requestedProviders: requestedProviderFamilies,
  selectedProviders: executionOptions.providerFamilies,
  unavailableProviders,
  eligibleProviders: options.eligibleProviderFamilies,
});
const runner = new CouncilRunner({ adapters, context });
// Taken before execution so the record shows real elapsed time. Both timestamps were previously
// the same post-run value, which made every session look instantaneous.
const startedAt = (environment.now ?? (() => new Date().toISOString()))();
const execution = await executePattern(mode.pattern, runner, {
  runId: executionOptions.runId,
  motion: executionOptions.motion,
  rounds: executionOptions.rounds,
  assignments,
  quorumPolicy: manifest.quorumPolicy,
  ...(executionOptions.refinementTrigger === undefined
    ? {}
    : { refinementTrigger: executionOptions.refinementTrigger }),
});
const now = (environment.now ?? (() => new Date().toISOString()))();
const status = execution.outcome;
const decisionState: PersistedDecisionState =
  status === 'completed' || status === 'degraded' ? 'awaiting-adjudication' : 'not-adjudicable';
const degraded: string[] = [];
if (!options.caller.declared) degraded.push('caller-undeclared');
if (command === 'run' && mode.name === 'committee') degraded.push('legacy-run-alias');
if (ledger.refused > 0) degraded.push('spend-cap-reached');
const modeOutput = mode.outputSchema.parse(
  mode.output({ result: execution, decisionState }),
) as Record<string, unknown>;
const envelope: ResultEnvelope = buildEnvelope({
  mode: mode.name,
  session: executionOptions.runId,
  caller: options.caller,
  pattern: mode.pattern,
  rounds: execution.rounds,
  assignments,
  output: modeOutput,
  spend: spendFromRounds(execution.rounds, {
    billing: billingMode,
    policy: mode.spend.policy,
    cap: ledger.cap,
    refused: ledger.refused,
  }),
  degraded,
  record: { session: sessionRecordPath(executionOptions) },
});
const persisted = await persistSession(
  executionOptions,
  policyDecision,
  manifest,
  execution,
  roleAssignments,
  startedAt,
  now,
  envelope,
);
const records = persisted?.records;
// A run can no longer fail by failing to append a resolution, because it no longer appends one.
// Exit code 5 (`record-failure`) is retired: session write failures already throw, and adjudication
// is a separate command with its own exit status.
const stoppedAtCap = envelope.spend.stoppedAtCap;
return output(status === 'completed' && !stoppedAtCap ? 0 : 4, {
  schemaVersion: SCHEMA_VERSION,
  command,
  mode: mode.name,
  status,
  runId: executionOptions.runId,
  ...(reducedQuorumWarning === undefined ? {} : { warning: reducedQuorumWarning }),
  ...(stoppedAtCap ? { spendWarning: spendCapExhaustedMessage(ledger.cap) } : {}),
  manifest,
  preflight,
  execution: publicExecution(execution),
  diagnostics,
  envelope,
  ...(records === undefined ? {} : { records }),
});
```

Also add `mode: options.mode` and `caller: options.caller` to the dry-run payload (after `command`), and `mode: options.mode` to the blocked-policy payload.

6. Add the `modes` command. In `runCliFacade`'s routing add before the `version` case:

```ts
      case 'modes': {
        const parsed = parseArguments(args, new Set(['help', 'json']));
        void parsed;
        return output(0, {
          schemaVersion: SCHEMA_VERSION,
          modes: Object.values(modes).map((mode) => ({
            name: mode.name,
            knobs: mode.knobs,
            pattern: mode.pattern,
            defaults: mode.defaults,
            spend: { policy: mode.spend.policy },
          })),
        });
      }
```

Match the surrounding style: if routing is an `if` chain rather than a `switch`, add an equivalent `if (command === 'modes')` branch. Change the unknown-command error to:

```ts
throw new Error(`Unknown command: ${command}. Registered modes: ${Object.keys(modes).join(', ')}`);
```

and add `modes` to the command list printed by `help()`.

7. In `commands/council.md` line 13 and `commands/second-opinion.md` line 13 insert `--caller human --harness claude-code` immediately after `--classification <classification>`. In `commands/ask.md`, in the bullet that says how to invoke, add the sentence: `Always pass \`--caller human --harness claude-code\`.`

- [ ] **Step 5: Type-check, run the suite**

Run: `bun run check:types && bun run test`
Expected: no type errors; every test passes, including the four new facade tests, the records test and the modes test. If `providers.test.ts` or `runner.test.ts` constructs a `ProviderContext` literal, the new optional `spend` field does not affect it.

- [ ] **Step 6: Commit**

```bash
bunx prettier --write src/cli.ts src/substrate/records/store.ts commands tests/core/cli-facade.test.ts tests/core/records.test.ts
git add src/cli.ts src/substrate/records/store.ts commands tests/core/cli-facade.test.ts tests/core/records.test.ts
git commit -m "feat(cli): dispatch through the modes registry, declare the caller, and emit the result envelope"
```

---

### Task 9: Commit terminal records and render minutes

**Files:**

- Modify: `src/substrate/records/store.ts`: `writeSession`, `appendChairAcceptance`, `appendChairRuling`, `appendResolution` return the written paths
- Create: `src/substrate/records/commit.ts`, `src/substrate/records/minutes.ts`
- Create: `tests/core/records-commit.test.ts`, `tests/core/minutes.test.ts`
- Modify: `src/substrate/session.ts` (`persistSession` returns paths), `src/cli.ts` (run and adjudicate), `src/substrate/index.ts`
- Modify: `.env.example` (create if absent), `README.md` Credentials section

**Interfaces:**

- Produces: `interface RecordWrite { readonly paths: readonly string[] }`; every store write method returns `Promise<RecordWrite>`; `commitRecordFiles(input): Promise<RecordCommitOutcome>`; `renderMinutes(input): string`; `writeMinutes(input): Promise<string>`; `minutesDirectory(env, cwd): string | null`.

- [ ] **Step 1: Write the commit test**

Create `tests/core/records-commit.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitRecordFiles, type CommandRunner } from '../../src/substrate/records/commit';

const identity = {
  GIT_AUTHOR_NAME: 'Council Test',
  GIT_AUTHOR_EMAIL: 'council-test@example.invalid',
  GIT_COMMITTER_NAME: 'Council Test',
  GIT_COMMITTER_EMAIL: 'council-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const runner: CommandRunner = async (argv, cwd) => {
  const child = Bun.spawn({
    cmd: [...argv],
    cwd,
    env: { ...process.env, ...identity },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

async function withTempDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-commit-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('record commits', () => {
  test('commits only the named record files in a Git work tree and reports the sha', async () => {
    await withTempDirectory(async (root) => {
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      await mkdir(join(root, 'general', 'sessions'), { recursive: true });
      await writeFile(join(root, 'general', 'sessions', 'run-1.json'), '{}\n');
      await writeFile(join(root, 'general', 'sessions', 'run-1.md'), '# run-1\n');
      await writeFile(join(root, 'unrelated.txt'), 'not part of the record\n');

      const outcome = await commitRecordFiles({
        root,
        paths: [
          join(root, 'general', 'sessions', 'run-1.json'),
          join(root, 'general', 'sessions', 'run-1.md'),
        ],
        message: 'council: record run-1',
        run: runner,
      });
      expect(outcome.committed).toBe(true);
      if (!outcome.committed) throw new Error('unreachable');
      expect(outcome.sha).toMatch(/^[a-f0-9]{40}$/);

      const shown = await runner(['git', 'show', '--name-only', '--format=%s', 'HEAD'], root);
      expect(shown.stdout).toContain('council: record run-1');
      expect(shown.stdout).toContain('general/sessions/run-1.json');
      expect(shown.stdout).not.toContain('unrelated.txt');
      const status = await runner(['git', 'status', '--porcelain'], root);
      expect(status.stdout).toContain('unrelated.txt');
    });
  });

  test('reports not committed when the root is not a Git work tree', async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, 'record.json'), '{}\n');
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'record.json')],
        message: 'council: record x',
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason).toContain('not inside a Git work tree');
    });
  });

  test('refuses to commit into the kernel repository itself', async () => {
    await withTempDirectory(async (root) => {
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      await writeFile(join(root, 'record.json'), '{}\n');
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'record.json')],
        message: 'council: record x',
        forbiddenRoot: root,
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason).toContain('kernel repository');
    });
  });

  test('reports a failed git command without throwing', async () => {
    await withTempDirectory(async (root) => {
      expect((await runner(['git', 'init', '-q'], root)).exitCode).toBe(0);
      const outcome = await commitRecordFiles({
        root,
        paths: [join(root, 'missing.json')],
        message: 'council: record x',
        run: runner,
      });
      expect(outcome.committed).toBe(false);
      if (outcome.committed) throw new Error('unreachable');
      expect(outcome.reason.length).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/core/records-commit.test.ts`
Expected: FAIL, cannot resolve `../../src/substrate/records/commit`.

- [ ] **Step 3: Write `src/substrate/records/commit.ts`**

```ts
import { relative, resolve, sep } from 'node:path';
import { scanAndRedact } from '../policy/secrets';

export type CommandRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface RecordCommitInput {
  readonly root: string;
  readonly paths: readonly string[];
  readonly message: string;
  /** The kernel's own repository. Records must never be committed into it. */
  readonly forbiddenRoot?: string;
  readonly run?: CommandRunner;
}

export type RecordCommitOutcome =
  | { readonly committed: true; readonly sha: string }
  | { readonly committed: false; readonly reason: string };

const defaultRunner: CommandRunner = async (argv, cwd) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function redacted(text: string): string {
  return scanAndRedact(text).redacted.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function isInside(path: string, root: string): boolean {
  const relation = relative(root, path);
  return (
    relation === '' ||
    (!relation.startsWith('..') && !relation.startsWith(sep) && !/^[A-Za-z]:/.test(relation))
  );
}

/**
 * Commit the record files just written, and nothing else. Durability is Git: a terminal record is
 * committed before the run reports success, so a record cannot exist only on the machine that
 * wrote it. This never pushes and never sets authorship; the repository's own identity applies.
 */
export async function commitRecordFiles(input: RecordCommitInput): Promise<RecordCommitOutcome> {
  const run = input.run ?? defaultRunner;
  const root = resolve(input.root);
  const toplevel = await run(['git', 'rev-parse', '--show-toplevel'], root);
  if (toplevel.exitCode !== 0) {
    return { committed: false, reason: 'records root is not inside a Git work tree' };
  }
  const workTree = resolve(toplevel.stdout.trim());
  if (input.forbiddenRoot !== undefined && workTree === resolve(input.forbiddenRoot)) {
    return {
      committed: false,
      reason: 'records root is the kernel repository; refusing to commit records into it',
    };
  }
  const relativePaths = input.paths.map((path) => {
    const absolute = resolve(path);
    if (!isInside(absolute, workTree)) {
      throw new Error(`Record path is outside the records work tree: ${absolute}`);
    }
    return relative(workTree, absolute);
  });
  const added = await run(['git', 'add', '--', ...relativePaths], workTree);
  if (added.exitCode !== 0) {
    return { committed: false, reason: `git add failed: ${redacted(added.stderr)}` };
  }
  const committed = await run(
    ['git', 'commit', '--quiet', '--no-verify', '-m', input.message, '--', ...relativePaths],
    workTree,
  );
  if (committed.exitCode !== 0) {
    return {
      committed: false,
      reason: `git commit failed: ${redacted(committed.stderr || committed.stdout)}`,
    };
  }
  const head = await run(['git', 'rev-parse', 'HEAD'], workTree);
  if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
    return {
      committed: false,
      reason: `commit succeeded but HEAD could not be read: ${redacted(head.stderr)}`,
    };
  }
  return { committed: true, sha: head.stdout.trim() };
}
```

`--no-verify` skips the records repository's own hooks because a records commit is a mechanical append, and a hook that blocks it would leave the record uncommitted while the run had already succeeded.

- [ ] **Step 4: Run the commit test**

Run: `bun test tests/core/records-commit.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Write the minutes test**

Create `tests/core/minutes.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultEnvelope } from '../../src/substrate/envelope';
import type { RoundExecution } from '../../src/substrate/execution/runner';
import {
  minutesDirectory,
  minutesFileName,
  renderMinutes,
  writeMinutes,
} from '../../src/substrate/records/minutes';

const envelope: ResultEnvelope = {
  schemaVersion: 1,
  mode: 'second-opinion',
  session: 'run-1',
  caller: { kind: 'agent', harness: 'omp', purpose: 'pick a library', declared: true },
  pattern: 'parallel',
  rounds: 1,
  seats: [
    {
      id: 'anthropic/claude#architect',
      family: 'anthropic',
      model: { requested: 'claude', verified: 'claude', verification: 'verified' },
      lens: 'architect',
      transport: 'subscription',
      fallback: false,
      status: 'ok',
      reason: null,
    },
  ],
  output: { outcome: 'completed' },
  synthesis: null,
  dissent: null,
  unanimous: false,
  spend: {
    billing: 'sub-first',
    policy: 'capped',
    cap: 1,
    used: 0,
    fallbacks: 0,
    refused: 0,
    stoppedAtCap: false,
  },
  degraded: ['caller-undeclared'],
  record: { session: 'general/sessions/run-1.json' },
};

const rounds: RoundExecution[] = [
  {
    round: 1,
    phase: 'analysis',
    retries: [],
    responses: [
      {
        status: 'ok',
        seatId: 'anthropic-seat',
        provider: 'anthropic',
        requestedModel: 'claude',
        actualModel: 'claude',
        modelIdentity: 'verified',
        route: 'primary',
        role: 'architect',
        latencyMs: 1,
        answer: '{"recommendation":"Use X"}',
      },
    ],
  },
];

describe('minutes', () => {
  test('renders the sections the brief names', () => {
    const text = renderMinutes({
      envelope,
      rounds,
      motion: 'Which library?',
      startedAt: '2026-09-13T00:00:00.000Z',
      completedAt: '2026-09-13T00:01:00.000Z',
    });
    expect(text).toContain('# Minutes: second-opinion run-1');
    expect(text).toContain('Which library?');
    expect(text).toContain('| anthropic/claude#architect |');
    expect(text).toContain('## Round 1 (analysis)');
    expect(text).toContain('{"recommendation":"Use X"}');
    expect(text).toContain('## Spend');
    expect(text).toContain('general/sessions/run-1.json');
    expect(text).toContain('caller-undeclared');
  });

  test('names the file by date, mode and session', () => {
    expect(minutesFileName(envelope, '2026-09-13T00:00:00.000Z')).toBe(
      '2026-09-13-second-opinion-run-1.md',
    );
  });

  test('resolves the directory from COUNCIL_MINUTES_DIR relative to cwd', () => {
    expect(minutesDirectory({}, '/work')).toBeNull();
    expect(minutesDirectory({ COUNCIL_MINUTES_DIR: '   ' }, '/work')).toBeNull();
    expect(minutesDirectory({ COUNCIL_MINUTES_DIR: 'minutes' }, '/work')).toBe(
      join('/work', 'minutes'),
    );
  });

  test('writes once and refuses to overwrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'council-minutes-'));
    try {
      const path = await writeMinutes({
        directory,
        envelope,
        rounds,
        motion: 'm',
        startedAt: '2026-09-13T00:00:00.000Z',
        completedAt: '2026-09-13T00:01:00.000Z',
      });
      expect(path).toBe(join(directory, '2026-09-13-second-opinion-run-1.md'));
      expect(await Bun.file(path).text()).toContain('# Minutes');
      await expect(
        writeMinutes({
          directory,
          envelope,
          rounds,
          motion: 'm',
          startedAt: '2026-09-13T00:00:00.000Z',
          completedAt: '2026-09-13T00:01:00.000Z',
        }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `bun test tests/core/minutes.test.ts`
Expected: FAIL, cannot resolve `../../src/substrate/records/minutes`.

- [ ] **Step 7: Write `src/substrate/records/minutes.ts`**

````ts
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
````

- [ ] **Step 8: Run the minutes test**

Run: `bun test tests/core/minutes.test.ts`
Expected: 4 pass.

- [ ] **Step 9: Return written paths from the store**

In `src/substrate/records/store.ts` add near the top-level exports:

```ts
export interface RecordWrite {
  readonly paths: readonly string[];
}
```

Change the four signatures and add the return values:

- `async writeSession(input: CurrentSessionRecord): Promise<RecordWrite>`: the `withScopeWriteLock` callback ends with `return { paths: [markdownPath, jsonPath] };` after the `try`/`catch`, and the method body becomes `return withScopeWriteLock(directory, async () => { ... });`.
- `async appendChairAcceptance(input: ChairAcceptanceRecord): Promise<RecordWrite>`: same shape, returning `{ paths: [markdownPath, jsonPath] }`.
- `async appendChairRuling(input: ChairRulingRecord): Promise<RecordWrite>`: same, returning `{ paths: [markdownPath, jsonPath] }`.
- `async appendResolution(input: ResolutionRecord): Promise<RecordWrite>`: same, returning `{ paths: [markdownPath, jsonPath, ledgerPath] }`.

Existing callers that ignore the result keep compiling.

- [ ] **Step 10: Thread the paths through `persistSession` and the CLI**

In `src/substrate/session.ts` change `PersistedSession` to:

```ts
export interface PersistedSession {
  readonly records: {
    readonly session: true;
    readonly decisionState: PersistedDecisionState;
    readonly dataAvailability: 'captured';
  };
  readonly decisionState: PersistedDecisionState;
  readonly paths: readonly string[];
}
```

and the end of `persistSession` to:

```ts
const written = await store.writeSession(session);
return {
  records: { session: true, decisionState, dataAvailability: 'captured' },
  decisionState,
  paths: written.paths,
};
```

In `src/cli.ts` add the imports:

```ts
import { dirname } from 'node:path';
import { commitRecordFiles } from './substrate/records/commit';
import { minutesDirectory, writeMinutes } from './substrate/records/minutes';
```

and the constant (next to `EXECUTABLE_PATH`):

```ts
// dist/cli.js and src/cli.ts both sit one directory below the kernel repository root.
const KERNEL_ROOT = resolve(dirname(EXECUTABLE_PATH), '..');
```

In `runCouncilCommand`, after `const records = persisted?.records;` and before the `stoppedAtCap` line, add:

```ts
let emitted: ResultEnvelope = envelope;
if (persisted !== undefined && executionOptions.recordsRoot !== undefined) {
  const commit = await commitRecordFiles({
    root: executionOptions.recordsRoot,
    paths: persisted.paths,
    message: `council: record ${executionOptions.runId}`,
    forbiddenRoot: KERNEL_ROOT,
  });
  if (!commit.committed) degraded.push(`records-not-committed: ${commit.reason}`);
  const directory = minutesDirectory(
    environment.env ?? process.env,
    environment.cwd ?? process.cwd(),
  );
  const minutes =
    directory === null
      ? null
      : await writeMinutes({
          directory,
          envelope,
          rounds: execution.rounds,
          motion: executionOptions.motion,
          startedAt,
          completedAt: now,
        });
  emitted = {
    ...envelope,
    degraded: [...degraded],
    record: {
      session: envelope.record.session,
      committed: commit.committed,
      ...(commit.committed ? { commitSha: commit.sha } : {}),
      minutes,
    },
  };
}
```

and in the returned payload replace `envelope,` with `envelope: emitted,`.

In `adjudicateCommand`, capture each write:

```ts
const written: string[] = [];
```

before the degraded branch, then `written.push(...(await store.appendChairAcceptance(...)).paths)`, `written.push(...(await store.appendChairRuling(...)).paths)`, `written.push(...(await store.appendResolution(...)).paths)` in place of the three bare `await` calls, and before the final `return output(0, {...})`:

```ts
const commit = await commitRecordFiles({
  root: recordsRoot,
  paths: written,
  message: `council: ruling ${rulingId} and resolution ${resolutionId} for ${runId}`,
  forbiddenRoot: KERNEL_ROOT,
});
```

and add to that payload:

```ts
    records: commit.committed
      ? { committed: true, commitSha: commit.sha }
      : { committed: false, reason: commit.reason },
```

- [ ] **Step 11: Facade test for the commit and minutes path**

Append to `tests/core/cli-facade.test.ts` inside the main describe:

```ts
test('a persisted run commits its record in a Git records root and writes minutes when configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'council-commit-facade-'));
  try {
    const init = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
    expect(init.exitCode).toBe(0);
    const fixture = await fixtureEnvironment(undefined, true);
    const environment: CliFacadeEnvironment = {
      ...fixture.environment,
      env: {
        COUNCIL_MINUTES_DIR: join(root, 'minutes'),
        GIT_AUTHOR_NAME: 'Council Test',
        GIT_AUTHOR_EMAIL: 'council-test@example.invalid',
        GIT_COMMITTER_NAME: 'Council Test',
        GIT_COMMITTER_EMAIL: 'council-test@example.invalid',
      },
    };
    const result = await runCliFacade(
      [
        'second-opinion',
        '--classification',
        'public',
        '--records-root',
        root,
        '--motion',
        'Commit me',
      ],
      environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.envelope.record.committed).toBe(true);
    expect(payload.envelope.record.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(payload.envelope.record.minutes).toContain(join(root, 'minutes'));
    expect(await Bun.file(payload.envelope.record.minutes).text()).toContain(
      '# Minutes: second-opinion',
    );
    expect(payload.envelope.degraded).not.toContainEqual(
      expect.stringContaining('records-not-committed'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a persisted run in a plain directory reports records-not-committed and still succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'council-nocommit-facade-'));
  try {
    const fixture = await fixtureEnvironment(undefined, true);
    const result = await runCliFacade(
      [
        'second-opinion',
        '--classification',
        'public',
        '--records-root',
        root,
        '--motion',
        'No git here',
      ],
      fixture.environment,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.envelope.record.committed).toBe(false);
    expect(payload.envelope.record.minutes).toBeNull();
    expect(payload.envelope.degraded).toContainEqual(
      expect.stringContaining('records-not-committed'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

The default commit runner passes `process.env` through, so the `GIT_*` identity variables in the facade environment must reach the child process. Make the default runner in `commit.ts` merge an optional `env` from the input: add `readonly env?: Readonly<Record<string, string | undefined>>` to `RecordCommitInput`, pass `env: { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: '0' }` in `defaultRunner` by giving `defaultRunner` the input (`const run = input.run ?? ((argv, cwd) => defaultRunner(argv, cwd, input.env))`), and in `src/cli.ts` pass `env: environment.env ?? process.env` to both `commitRecordFiles` calls.

- [ ] **Step 12: Type-check and run the suite**

Run: `bun run check:types && bun run test`
Expected: all pass, including the two new facade tests. On a CI runner with no global git identity the first new facade test still passes because the identity is in the facade environment.

- [ ] **Step 13: Environment example and README**

Using the Write tool (not a shell command), create or extend `.env.example` at the repository root with:

```text
# Optional. When set, each terminal council record is also rendered as a Markdown minutes file in
# this directory, so the vault's ingest can find it. Relative paths resolve against the working
# directory. The kernel never calls Atlas itself.
COUNCIL_MINUTES_DIR=
```

If the tool reports the path as denied by permission settings, stop and report that to the user rather than working around it; then add the same text to `README.md` under the Credentials section so the variable is documented in this change either way.

Add to `README.md` under `### Credentials`, after the paragraph about `providers.env`:

```markdown
`COUNCIL_MINUTES_DIR` is optional and not a credential: when set, every terminal record is also
rendered as a Markdown minutes file there. See "Records and memory" in `docs/modes.md`.
```

- [ ] **Step 14: Commit**

```bash
bunx prettier --write src/cli.ts src/substrate/session.ts src/substrate/records src/substrate/index.ts tests/core/records-commit.test.ts tests/core/minutes.test.ts tests/core/cli-facade.test.ts README.md
git add src/cli.ts src/substrate/session.ts src/substrate/records src/substrate/index.ts tests/core/records-commit.test.ts tests/core/minutes.test.ts tests/core/cli-facade.test.ts README.md .env.example
git commit -m "feat(records): commit terminal records in the records repository and render minutes"
```

If `.env.example` could not be created, drop it from `git add` and say so in the commit body.

Also append to `src/substrate/index.ts`:

```ts
export * from './records/commit';
export * from './records/minutes';
```

and include it in the commit above.

---

### Task 10: Documentation

**Files:**

- Modify: `docs/ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1: Rewrite the architecture overview**

In `docs/ARCHITECTURE.md`, after `## Runtime boundary`, insert a new section:

```markdown
## Substrate and modes

`src/substrate/` is everything a mode needs and nothing a mode decides: seats and lenses
(`roles/`, `models/`), transports and provider adapters (`execution/`, `providers/`), policy and
secrets (`policy/`, `evidence/`), records (`records/`), health (`health/`), the execution
patterns (`patterns/`), the spend ledger (`spend.ts`), the result envelope (`envelope.ts`) and
the session helpers (`session.ts`). Its only public entry is `src/substrate/index.ts`.

`src/modes/` is a registry of `ModeDefinition`s. A mode declares the five knobs from
`docs/vision.md`, its execution pattern, its defaults, its spend policy, how it prepares a
session (the committee's health preflight lives here) and the shape of its `output` block.
`committee` and `second-opinion` are registered; `docs/modes.md` specifies the rest.

`src/cli.ts` parses flags, resolves the mode for the command, builds the envelope, persists the
session and prints. `tests/core/dependency-direction.test.ts` enforces that modes reach the
substrate only through its index, that the substrate never imports a mode or the CLI, and that no
mode imports another.

## Result envelope

Every executed run returns one `ResultEnvelope` (`src/substrate/envelope.ts`), validated before it
is printed or stored: mode, session, declared caller, pattern, rounds, one entry per seat with
verified identity and the transport that answered, the mode's `output`, attributed synthesis and
dissent (both `null` until the synthesis brief), a unanimity flag to be suspicious of, spend,
`degraded` reasons and the record location. The same object is embedded in the session record.

## Spend

A mode's spend policy is `capped` or `never-metered`. `never-metered` pins `sub-only`. `capped`
takes a per-session cap on metered fallback calls (`--spend-cap`, default one per seat per
round, which is the historical behaviour). The cap is enforced inside the credential fallback
wrapper, so a refused metered call shows as a `spend-cap` seat failure and the envelope reports
`stoppedAtCap` with a non-zero exit.

## Records and memory

A terminal record is committed in the records repository before the run reports success, with
`--no-verify`, never pushed, and never into the kernel's own repository. If the records root is
not a Git work tree the envelope says `records-not-committed` with the reason. When
`COUNCIL_MINUTES_DIR` is set, a Markdown minutes file is rendered beside it for the vault's ingest.
The kernel never calls Atlas.
```

Update the existing `## Records and migration` section's first paragraph to mention that write methods return the written paths. Replace the Mermaid diagram's node `L[Completed result / chair adjudication]` with `L[Envelope, record commit, minutes / chair adjudication]`.

- [ ] **Step 2: README**

In `README.md` under `## Commands`, add after the second-opinion example:

```bash
# Declare who is asking; wrappers always do. Absent, the envelope says caller-undeclared.
bun --no-install dist/cli.js second-opinion \
  --classification public \
  --caller agent --harness omp --purpose "choose an ORM" \
  --spend-cap 2 \
  --motion "Drizzle or Kysely for this service?"

# List the registered modes and their knobs
bun --no-install dist/cli.js modes
```

Add a short subsection `### Result envelope` after `## Commands` summarising the fields in one paragraph and pointing at `docs/modes.md`.

- [ ] **Step 3: Changelog**

Insert at the top of `CHANGELOG.md`, above `## 2026.9.5`:

```markdown
## Unreleased

### Added

- **Substrate and modes.** The kernel modules now live under `src/substrate/` behind one index,
  and `src/modes/` registers `committee` and `second-opinion` as the first modes. Behaviour of
  `council`, `second-opinion`, `run`, `adjudicate`, `result`, `jobs`, `doctor` and `health` is
  unchanged. See `docs/vision.md` and `docs/modes.md`.
- **Result envelope.** Every executed run returns a validated envelope, also embedded in the
  session record. New flags `--caller human|agent`, `--harness`, `--purpose`.
- **Spend cap.** `--spend-cap <n>` bounds metered fallback calls per session; the default equals
  the previous behaviour of one metered retry per seat per round.
- **Records committed before success.** Terminal records are committed in the records repository
  (never pushed). `COUNCIL_MINUTES_DIR` renders a Markdown minutes file per record.
- `modes` command listing the registered modes.

### Fixed

- Two tests depended on the host: a hard link across filesystems and a `grok` CLI on `PATH`.
```

- [ ] **Step 4: Gate and commit**

Run: `bun run lint`
Expected: pass.

```bash
bunx prettier --write docs/ARCHITECTURE.md README.md CHANGELOG.md
git add docs/ARCHITECTURE.md README.md CHANGELOG.md
git commit -m "docs: describe the substrate, modes, envelope, spend and records behaviour"
```

---

### Task 11: Full gate, rebase and pull request

**Files:** none new.

- [ ] **Step 1: Run the full gate**

Run: `bun run check`
Expected: types, lint, tests, release checks and package self-check all pass. Then run `bun --no-install dist/cli.js modes` and confirm the two modes print.

- [ ] **Step 2: Rebase onto main if PR #12 has merged**

```bash
git fetch origin
git log --oneline -1 origin/main
```

If `origin/main` contains the docs (the subject `docs(council): suite vision, modes spec and substrate brief (#12)`), run:

```bash
git rebase --onto origin/main docs/council-suite-vision-and-modes refactor/substrate-extraction
bun run check
```

If PR #12 is still open, leave the branch stacked on it and say so in the PR body.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin refactor/substrate-extraction
gh pr create --repo AnnasCookies/claude-council --base main --head refactor/substrate-extraction \
  --title "refactor(substrate): extract the substrate, committee and second opinion as the first modes" \
  --body-file <a file containing: what changed (one line per task), the spec citations docs/vision.md, docs/modes.md and docs/forge/2026-09-12-substrate-extraction-brief.md, the invariant-to-test table, the baseline-failure fixes, the two records decisions (no-verify; committed facts live on the emitted envelope), the .env.example note if it could not be written, and the attribution footer from the session>
```

Do not merge. Report `ready at <sha>` with the CI status.

---

## Self-review

**Spec coverage.** Substrate boundary and single entry: Task 1 and 2. Modes registry with committee and second opinion, unknown mode lists the registered names: Task 7 and 8 (`modes` command and the error text). Envelope with every named field, validation failure is a failed run, embedded in the record, old records load, caller flags with the undeclared default and `degraded`: Tasks 3 and 8. Spend policy, cap, `stoppedAtCap`, non-zero exit naming the flag, `never-metered` unreachable: Tasks 3, 4 and 8 (the `api-only` refusal is `effectiveBillingMode`). Patterns: Task 5. Records committed before success, never pushed, not a Git tree reported, minutes with `COUNCIL_MINUTES_DIR` and `.env.example`, kernel never calls Atlas: Task 9. Documentation: Task 10. Invariant tests: dependency direction (Task 2), parity (existing suite throughout), envelope validation (Task 3 and 8), seats never act (unchanged runner, covered by `runner.test.ts`), fallback recorded and cap (Task 4), commit before success (Task 9), old records load (Task 8). Baseline failures: Task 0. Non-goals: no file creates a third mode, no streaming implementation, no rename, no distribution change.

**Placeholder scan.** The PR body in Task 11 is described rather than written because it must quote the final commit list; every other step carries its content.

**Type consistency.** `SessionOptions` gains `mode`, `chaired`, `caller`, `spendCap` in Task 6 and Task 8 uses those names. `PersistedSession.paths` is added in Task 9 and read in Task 9's CLI change. `RecordWrite.paths` is returned by all four store methods and consumed by `persistSession` and `adjudicateCommand`. `ModeResultView` is the `result` type of `ModeDefinition.output` in Task 7 and the CLI passes a full `CouncilRunResult`, which satisfies the `Pick`. `EnvelopeRecordSchema` allows `committed`, `commitSha` and `minutes` as optional, which Task 9's emitted envelope sets and Task 8's persisted envelope omits.
