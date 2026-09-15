# Rename to convene

Spec: `docs/forge/2026-09-13-rename-convene-brief.md`, amended 2026-09-15: no credit line and no
upstream references anywhere except the `LICENSE` copyright notice, which MIT requires.
Branch: `chore/rename-convene`, cut from `main` at `c06fff9`. Companion PR in dotagents.

## Goal

Repository, package, `bin`, plugin id and every user-facing string say `convene`. Behaviour of
every command is unchanged. Records root, `COUNCIL_*`, `providers.env`, CLI subcommands and the
OMP profile name stay. The engine ships as `2026.9.6`.

## Approach

- [ ] 1. GitHub rename, origin repointed, upstream remote dropped, branch cut from main.
- [ ] 2. Readers renamed: `package.json`, both plugin manifests, `src/cli.ts` help name,
      `src/substrate/execution/cli.ts` root error and temp prefix; `bun install` refreshes the lock.
- [ ] 3. Gates rewritten: ownership test (origin `AnnasCookies/convene`, no upstream, LICENSE
      notice still asserted), privacy fixture, containment loader expectations, CI workflow
      without the upstream step, new `tests/release/naming.ts` with an explicit allow-list.
- [ ] 4. Test fixtures and temp prefixes renamed; OMP profile constant kept with a comment.
- [ ] 5. Docs: README, CHANGELOG (`2026.9.6` section), vision, modes, brief amendment, two stale
      skill links.
- [ ] 6. Version `2026.9.6` in `package.json` and `plugin.json`; `bun run check`; rebuild `dist`.
- [ ] 7. Push, PR, CI green on three platforms; close PR #14 in favour of it.
- [ ] 8. dotagents PR: updater with stale-plugin cutover, runtime shim and its test, health script,
      session-notes script, wrapper test, council skill.

## Files

This repo: `package.json`, `bun.lock`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`src/cli.ts`, `src/substrate/execution/cli.ts`, `src/substrate/execution/provider.ts` (comment only),
`tests/release/repository-ownership.ts`, `tests/release/naming.ts` (new), `tests/security/repository-privacy.ts`,
`tests/containment-loader.test.ts`, `tests/core/cli.test.ts`, `tests/core/model-registry.test.ts`,
`tests/core/version.test.ts`, `.github/workflows/tests.yml`, `README.md`, `CHANGELOG.md`,
`docs/vision.md`, `docs/modes.md`, `docs/forge/2026-09-13-rename-convene-brief.md`,
`skills/council/SKILL.md`, `skills/second-opinion/SKILL.md`, `dist/cli.js`.

## Risks

- Package-root resolution may key on the package name: read the resolver before renaming the
  fixture, and keep the two in step.
- CI installs with `--frozen-lockfile`: the lock must carry the new workspace name.
- Old plugin id stays installed on every machine until the updater runs: state the one-line cutover
  in the CHANGELOG and both PR bodies.
- A new stray occurrence of the former name reaches `main` unnoticed: the naming gate fails closed.
