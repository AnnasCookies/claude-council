# Brief: extract the substrate, committee as the first mode

Build order step 1 from `docs/modes.md`. This brief cites `docs/vision.md` and `docs/modes.md`;
both were accepted on 2026-09-12. A run whose output cannot be mapped to a mode in
`docs/modes.md` stops and asks.

**Mode mapping.** Everything this brief produces maps to two rows of the modes table: Committee
and Second opinion, both with their existing behaviour, now returned inside the result envelope.
No other mode is built here.

## Goal

Turn the committee kernel into a substrate with modes on top, without changing what `/council`,
`/second-opinion`, `/ask`, `/result` and `/status` do. After this PR:

- committee and second opinion are registered modes running on the substrate;
- every run returns the result envelope from `docs/modes.md`, and `--json` prints it;
- adding a mode means adding files under `src/modes/` and never editing another mode's runner;
- a terminal record is committed in the records repository before the run reports success.

## Scope

### 1. Substrate boundary

Create `src/substrate/` with one public entry, `src/substrate/index.ts`. Modes import the
substrate only through that entry. The substrate never imports `src/modes/**` or `src/cli.ts`.
Suggested layout, which may differ if the dependency rule holds:

| Substrate part | Today                                                              | Under the substrate                                                 |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| seats          | `src/roles/` (catalogue, allocator), `src/models/registry.ts`      | `src/substrate/seats/`; a `Seat` is family, model, lens, transport  |
| transports     | `src/providers/`, `src/execution/provider.ts`, `cli.ts`, `http.ts` | `src/substrate/transports/`                                         |
| policy         | `src/policy/`, `src/evidence/`                                     | `src/substrate/policy/`, `src/substrate/evidence/`                  |
| records        | `src/records/`                                                     | `src/substrate/records/`                                            |
| health         | `src/health/`                                                      | `src/substrate/health/`                                             |
| patterns       | `src/execution/runner.ts`                                          | `src/substrate/patterns/`: `rounds` (existing) and `parallel` (new) |
| domain         | `src/domain/`                                                      | `src/substrate/domain/`                                             |

`parallel` is one blind round with no rebuttal: the existing runner's round one, exposed on its
own. `rounds` is the existing blind, rebuttal, optional refinement sequence. `streaming` is
declared as a type in the patterns module and not implemented; the advisor brief implements it.

### 2. Modes registry

Create `src/modes/` with a `ModeDefinition` (name, the five knobs, pattern, spend policy,
output schema, a run function) and a registry in `src/modes/index.ts`. Register:

- `committee` at `src/modes/committee/`: today's `council` command, unchanged semantics, quorum,
  classification, lens allocation, rounds and chair adjudication as they are.
- `second-opinion` at `src/modes/second-opinion/`: today's one-round command, unchanged, on the
  `parallel` pattern. Its synthesis rework is a later brief.

The CLI dispatches through the registry. `council council`, `council second-opinion` and
`council run` keep their names and flags. An unknown mode name fails with the list of registered
modes.

### 3. Result envelope

Implement the envelope from `docs/modes.md` as a Zod schema in the substrate. Fields: `mode`,
`session`, `caller`, `pattern`, `rounds`, `seats[]` (id, family, model requested and verified and
verification state, lens, transport, fallback, status, reason), `output`, `synthesis` (attributed),
`dissent`, `unanimous`, `spend`, `degraded`, `record`.

- Every run returns an envelope. An envelope that fails validation is a failed run: non-zero
  exit, no partial record.
- The persisted session record gains an `envelope` field. Existing fields are unchanged.
  Records written before this change still load, and `result` and `jobs` still render them.
- `caller` comes from new flags `--caller human|agent`, `--harness <name>` and
  `--purpose <text>`. When `--caller` is absent the envelope carries
  `caller: { kind: "human", harness: "unknown", declared: false }` and `degraded` contains
  `caller-undeclared`. The bundled `commands/*.md` pass `--caller human --harness claude-code`.
  Nothing infers the caller from context.

### 4. Spend

`spend` in the envelope records billing mode, cap, metered calls used, fallbacks and
`stoppedAtCap`. A mode declares its spend policy as `never-metered` or `capped`.

- `never-metered` pins `sub-only`; a metered path is unreachable, not merely avoided.
- `capped` takes a per-session cap on metered fallback calls from `--spend-cap <n>`, defaulting
  to the mode's default. Committee and second opinion default to today's behaviour: at most one
  metered retry per seat.
- At the cap the run stops, the envelope has `stoppedAtCap: true`, the exit is non-zero and the
  message names the flag that raises the cap. Nothing asks interactively.

No registered mode is `never-metered` yet; the policy exists so the advisor brief can use it.

### 5. Records durability and minutes

- After a terminal record is written, if the records root is inside a Git work tree, the kernel
  stages and commits the record files with a message naming the run id. It never pushes. If the
  root is not a Git work tree, `degraded` contains `records-not-committed` with the reason.
- New environment variable `COUNCIL_MINUTES_DIR`, added to `.env.example`. When set, each
  terminal record is also rendered as a Markdown minutes file there (title, mode, caller, seats
  table, rounds and answers, synthesis, dissent, spend, record path). When unset the envelope's
  `record` block says minutes were not configured. The kernel never calls Atlas.

### 6. Documentation

`docs/ARCHITECTURE.md` rewritten around substrate and modes. `README.md` gains the new flags
and the spend and records behaviour. `CHANGELOG.md` entry.

## Non-goals

- No advisor, ideation, consultants, forum, triage or audience.
- No streaming pattern implementation.
- No change to quorum, classification, lens allocation, adjudication or migration semantics.
- No change to record file layout beyond the additive `envelope` field.
- No rename to `convene`, and no distribution change: plugin cache, marketplace, dotagents
  skills and the `dist/` cutover are a separate release step through the
  `shipping-council-kernel-changes` skill.
- No Atlas calls from the kernel, and no provider data tiers.

## Invariants that must hold, each with a test

1. Dependency direction: `src/modes/**` imports the substrate only via `src/substrate/index.ts`;
   `src/substrate/**` never imports `src/modes/**` or `src/cli.ts`. Static import scan.
2. Behaviour parity: existing `tests/core` pass with only import-path changes, and the CLI flag
   surface is a superset of today's.
3. The envelope validates or the run fails with no partial record.
4. Seats never act: seats remain tool-free and stateless.
5. Fallback is recorded per seat; a `never-metered` mode cannot reach a metered transport.
6. A terminal record is committed before success when the records root is a Git work tree.
7. Records written before this change load and render.

## Acceptance evidence

- `bun run check` green: types, lint, tests, release checks, package self-check.
- Baseline on `main` at `67eac5b`: 233 pass, 3 fail, 236 tests across 19 files. The three
  failures are pre-existing; the first stage triages each one and either fixes it inside scope or
  records it as pre-existing with the reason. See "Baseline failures" below.
- New tests: envelope schema, registry dispatch and unknown-mode error, dependency direction,
  caller default and `degraded`, spend cap stop, records commit in a temporary Git repository,
  minutes rendering, pre-change record compatibility.
- Manual: `/council` and `/second-opinion` from Claude Code produce the same visible result as
  before, and `--json` shows the envelope.

## Baseline failures

Measured on `67eac5b` on the Linux rig, three full runs. CI on the same commit is green on
ubuntu, macos and windows, so both stable failures are host-environment leaks in tests, not
product defects. Stage 1 fixes them as test-portability changes.

| Test                                                                                               | Cause on this host                                                                                                              | Fix in scope                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tests/core/cli.test.ts` bundled execution resolves the package root rather than its parent        | `link(process.execPath, …)` fails with `EXDEV`: `/usr/bin` and the temp directory are on different filesystems                  | copy the executable instead of hard-linking it                                   |
| `tests/core/version.test.ts` --registry overrides the records-root default and reports its SHA-256 | a `grok` CLI is on the host `PATH`, so xAI resolves `subscription-cli`; the test assumes no subscription CLI and expects `http` | run the facade with an isolated `PATH` so host CLIs cannot leak into the fixture |

The first of the three runs took 273 seconds and reported one further failure that the two later
runs (9 and 5 seconds) did not reproduce. Its name was not captured. Treat it as a suspected
deadline-sensitive test under load, and if it recurs during the run, record its name and cause
rather than retrying until green.

## Decisions Forge must not make

A change to record layout, quorum, adjudication, spend semantics beyond this brief, or the
`COUNCIL_` credential surface is a blocker, not an assumption.

## House rules

Bun and TypeScript strict; British English; `COUNCIL_`-prefixed credentials and `.env.example`;
branch and PR, never `main`; conventional commits; `bun run lint` green; Linux and Windows
portability; the installed runtime is `bun --no-install dist/cli.js`.

## Sizing

One Forge run. Suggested stages, for Forge to derive from rather than copy: envelope, registry and
caller with committee and second opinion registered; substrate boundary and the dependency test;
patterns split; spend; records commit and minutes; documentation.
