# Testing

Claude Council has one cross-platform Bun/TypeScript verification path. Provider credentials and paid network routes are never required by the deterministic suite.

## Prerequisites

- Bun 1.3.14 or later
- Dependencies installed with `bun install --frozen-lockfile`
- Claude Code only for the plugin-loader containment check

## Deterministic verification

Run the release gate from the repository root:

```bash
bun run check
```

This performs, in order:

1. strict TypeScript checking;
2. Prettier and ESLint checks;
3. core, security and release tests;
4. a fresh bundle build; and
5. an offline self-check of `dist/cli.js` with package installation disabled.

Run narrower checks while developing:

```bash
bun run check:types
bun run lint
bun run test
bun run check:package
bun test tests/core/runner.test.ts
```

The committed CI workflow runs `bun run check` on Linux, macOS and Windows.

## Test ownership

| Area                     | Location                                                                                            | Contract                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Domain and schemas       | `tests/core/schemas.test.ts`, `tests/core/quorum.test.ts`, `tests/core/run-state.test.ts`           | Strict inputs, quorum floors and legal lifecycle transitions                                                 |
| Evidence and policy      | `tests/core/evidence.test.ts`, `tests/core/data-guard.test.ts`, `tests/core/secrets.test.ts`        | Trust labelling, provenance, identical evidence, classification ceilings and secret blocking/redaction       |
| Providers and execution  | `tests/core/providers.test.ts`, `tests/core/http.test.ts`, `tests/core/runner.test.ts`              | Exact routes, transport isolation, timeouts, partial failures, rounds and quorum-gated synthesis eligibility |
| Roles                    | `tests/core/roles.test.ts`                                                                          | Governed catalogue, deterministic dynamic assignment and contrarian requirements                             |
| Records                  | `tests/core/project-id.test.ts`, `tests/core/records.test.ts`, `tests/core/migrate-general.test.ts` | Stable project identity, scoped locking, append-only records and approved hash-matched migration             |
| Health                   | `tests/core/health.test.ts`, `tests/core/doctor.test.ts`                                            | Secret-free route probes, baseline comparison and structured remediation                                     |
| CLI                      | `tests/core/cli.test.ts`, `tests/core/cli-facade.test.ts`                                           | Explicit invocation, fail-closed flags, dry-run planning and public command contracts                        |
| Repository release gates | `tests/security/`, `tests/release/`                                                                 | No private residue, owned namespace and no upstream publication targets                                      |

`bun test` reports the authoritative current test count.

## Real plugin-loader containment

The loader test starts the installed Claude CLI with shadow provider executables and an isolated configuration directory. Plugin discovery must load the command facades without making a provider request:

```bash
bun test tests/containment-loader.test.ts
```

This check is deliberately separate from `bun run check` because Claude Code is not a package dependency and is not present on ordinary package CI runners.

## Manual smoke checks

Build first, then exercise only the bundled entry point:

```bash
bun run build
bun --no-install dist/cli.js self-check --json
bun --no-install dist/cli.js health --json
bun --no-install dist/cli.js doctor --json
bun --no-install dist/cli.js run --dry-run --scope general --classification public --motion "Choose an authentication architecture"
```

Expected properties:

- commands return structured JSON;
- self-check lists all governed provider families and role lenses;
- health and doctor output contains no credential values or raw provider payloads;
- dry-run resolves policy, exact model routes, dynamic roles and quorum without contacting a provider;
- no command installs dependencies at runtime.

## Optional live provider smoke

Live smoke is separate, explicit and credential-dependent. Use only a public, synthetic motion with no repository or customer data:

```bash
bun --no-install dist/cli.js council --scope general --classification public --motion "Compare two reversible approaches to a bounded example problem"
```

Verify the observed result rather than assuming success from process exit alone:

- each successful seat records its requested and actual provider/model identity;
- failed or unavailable families remain visible;
- quorum reflects distinct verified provider families in the blind analysis round;
- significant motions expose a separate three-response rebuttal obligation, and `degraded` or `blocked-quorum` outcomes remain ineligible for automatic synthesis;
- degraded resolutions require a persisted chair-acceptance record, and final-round consensus meets the distinct-family quorum floor;
- persisted output contains no high-confidence secret or raw diagnostic payload.

## Adding tests

- Defend an observable contract that could plausibly regress.
- Reproduce a bug with a failing test before changing production code.
- Keep fixtures local, deterministic and credential-free.
- Prefer the narrowest existing test file; create a new file only for a distinct contract boundary.
- Do not test source text, internal plumbing or incidental defaults.
- Run the focused test first, then `bun run check`.
