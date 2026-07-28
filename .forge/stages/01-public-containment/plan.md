# Stage 1 Plan — Public Containment

## Outcome

Remove every automatic or repository-controlled council execution path, make the legacy compatibility lifecycle fail closed, preserve the first terminal state under races, and establish owned-fork/privacy release gates without starting the new standing-council core.

## Execution tier

Tier 2. One serial writer in an isolated worktree. The changes cross shell lifecycle, plugin registration, release metadata and tests, but share one compatibility boundary and cannot be split safely without duplicate edits to the legacy command paths.

## Tasks

### PUB-1 — Remove automatic execution surfaces

**Criteria:** AC-SEC-001, AC-SEC-002, AC-SEC-003, AC-SEC-004

- Delete the Stop-hook registration, implementation, prompt and obsolete Stop-gate tests, including the dedicated fake-CLI branch.
- Resolve the authoritative execution policy only from `$HOME/.claude/council-policy.json` using the closed enum `allow|strict|deny`. Ignore repository `.claude/council-policy.json`; repository content therefore cannot lower a user's `strict` or `deny` setting. `deny` blocks all current execution and `strict` permits only explicit manual invocation.
- Remove current documentation that advertises or registers repository-controlled automatic review, document the user-owned policy path, and preserve historical changelog entries as history.
- Add `tests/containment.bats` to prove passive plugin discovery makes no provider request, no Stop event is registered, repository fixtures cannot opt into execution, and a repository `allow` cannot weaken user `strict`/`deny`.

### PUB-2 — Harden the compatibility lifecycle boundary

**Criteria:** AC-SEC-005, AC-SEC-006, AC-SEC-007, AC-SEC-009, AC-LOGIC-001, AC-LOGIC-002

**Depends on:** PUB-1

- Add one shell containment library for bounded unsigned-integer, enum and lifecycle/status validation.
- Invoke that boundary before provider discovery, cache/retry/lifecycle arithmetic, status interpretation, process launch or job mutation. Provider names are validated in `scripts/lib/providers.sh` before any `${PROVIDERS_DIR}/${provider}.sh` path is built, and every current adapter receives validated bounded numeric inputs.
- Make job-state writes status-validated, atomic and first-terminal-state-wins. A late completion/failure callback cannot replace `timed-out` or `cancelled`; `scripts/run-council.sh` and `scripts/check-status.sh` consume only the validated state API.
- Keep provider and lifecycle values in quoted argv/data paths; reject metacharacter-shaped values before dispatch.
- Add `tests/lifecycle-security.bats` and `tests/terminal-race.bats` with marker-file and deterministic late-callback fixtures.

### PUB-3 — Establish owned-fork and privacy release gates

**Criteria:** AC-SEC-008, AC-OPS-002, AC-OPS-003, AC-OPS-004

**Depends on:** PUB-1

- Update current package/repository metadata to the owned fork while retaining explicit upstream MIT attribution.
- Add a side-effect-free ownership preflight and invoke it before release mutation, commit or tag creation.
- Add deterministic fixture scripts at `tests/release/repository-ownership.ts` and `tests/security/repository-privacy.ts`. The privacy scan covers tracked and packaged paths, recognises seeded controls, and rejects credentials or private record/identity/project/charter/ledger artefacts without flagging documented placeholder variable names.
- Replace the private absolute source path in the public Forge brief with a home-relative architectural reference.
- Wire both Bun gates into `.github/workflows/tests.yml` as blocking checks alongside the existing supported POSIX Bats suite.

### PUB-4 — Preserve compatible public behaviour

**Criteria:** AC-OPS-001

**Depends on:** PUB-2, PUB-3

- Update existing current documentation/tests only where Stop-gate removal or fail-closed validation changes the supported contract.
- Run the complete Bats regression suite on the supported POSIX runner. Native Windows is not a substitute for this criterion.

## Implementation order

1. PUB-1
2. PUB-2 and PUB-3 serially in the same writer worktree
3. PUB-4 compatibility reconciliation
4. Inline ownership, security-sentinel and specification-drift gates

## Milestone tests

- Primary local red milestone: `bun tests/security/repository-privacy.ts` for AC-SEC-008 — its assertions execute successfully and fail on the tracked private absolute path in `.forge/brief.md`.
- Additional frozen checks:
  - `bun tests/release/repository-ownership.ts`
  - `bash tests/run_tests.sh tests/containment.bats`
  - `bash tests/run_tests.sh tests/lifecycle-security.bats`
  - `bash tests/run_tests.sh tests/terminal-race.bats`
  - `bash tests/run_tests.sh`

The Bats commands are acceptance evidence from the supported POSIX CI leg. Native Windows cannot satisfy them, and a missing local Bats/jq environment is operational failure rather than red product evidence.

## Risks and controls

- **Race hidden by sequential tests:** terminal tests release a delayed completion only after the timeout/cancel transition is observable.
- **Portable locking:** use an atomic directory lock with bounded acquisition and explicit cleanup; do not assume `flock` on macOS.
- **Over-broad privacy scanning:** controls distinguish real secret material/private artefact paths from public placeholder variable names and historical upstream documentation.
- **Release mutation before ownership proof:** the preflight executes before version edits, commits or tags.
- **Scope creep into the Bun core:** no `src/` standing-council implementation belongs to this stage.
