# Substrate extraction, committee as the first mode

Spec: `docs/forge/2026-09-12-substrate-extraction-brief.md` (cites `docs/vision.md`,
`docs/modes.md`). Detailed plan: `docs/forge/2026-09-13-substrate-extraction-plan.md`.
Branch: `refactor/substrate-extraction`, cut from the docs branch; rebase onto `main` once PR #12
merges, before opening the PR.

## Goal

Committee and second opinion become registered modes on a substrate. Every run returns the
result envelope. `/council`, `/second-opinion`, `/ask`, `/result`, `/status` behave as before.

## Approach

- [ ] 0. Baseline: fix the two host-environment test failures (EXDEV hard link; grok on PATH).
- [ ] 1. Result envelope schema and `caller` flags; committee and second opinion return it.
- [ ] 2. Modes registry with `committee` and `second-opinion`; CLI dispatches through it.
- [ ] 3. Substrate boundary: move modules under `src/substrate/`, single public entry,
      dependency-direction test.
- [ ] 4. Patterns: `rounds` (existing) and `parallel` (one blind round) in the substrate;
      second opinion runs on `parallel`.
- [ ] 5. Spend: policy per mode, `--spend-cap`, `stoppedAtCap`, `never-metered` pin.
- [ ] 6. Records: commit terminal records in the records repo; `COUNCIL_MINUTES_DIR` minutes.
- [ ] 7. Docs: ARCHITECTURE.md, README.md, CHANGELOG.md, `.env.example`.
- [ ] 8. `bun run check` green on the branch; rebase onto main; open PR citing both docs.

## Files

New: `src/substrate/index.ts`, `src/substrate/envelope.ts`, `src/substrate/patterns/*`,
`src/substrate/spend.ts`, `src/substrate/records/commit.ts`, `src/substrate/records/minutes.ts`,
`src/modes/index.ts`, `src/modes/committee/*`, `src/modes/second-opinion/*`,
`tests/core/dependency-direction.test.ts`, `tests/core/envelope.test.ts`,
`tests/core/modes.test.ts`, `tests/core/spend.test.ts`, `tests/core/records-commit.test.ts`,
`tests/core/minutes.test.ts`.
Moved: `src/domain`, `src/evidence`, `src/execution`, `src/health`, `src/models`, `src/policy`,
`src/providers`, `src/records`, `src/roles` under `src/substrate/`.
Modified: `src/cli.ts`, `src/index.ts`, `commands/*.md`, `docs/ARCHITECTURE.md`, `README.md`,
`CHANGELOG.md`, `.env.example`, `tests/core/*` import paths.

## Risks

- Moving 10.9k lines: import churn. Mitigation: one mechanical move commit, `bun run check`
  after it, before any behaviour change.
- Record compatibility: the additive `envelope` field must not break old records. Mitigation:
  fixture from an existing `~/.claude/council/general/sessions` record, loaded in a test.
- Spend cap semantics: default must equal today's one metered retry per seat. Mitigation:
  test that the default cap reproduces the existing `credentialFallback` behaviour.
- Records commit runs `git` inside the records root: must never touch the product repo or push.
  Mitigation: temp-repo test; refuse when the root is inside the current repository work tree.
