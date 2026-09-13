# Brief: rename to convene

Build order step 2 from `docs/modes.md`. This brief cites `docs/vision.md` and `docs/modes.md`,
both accepted on 2026-09-12, and executes decision 1 under "Decisions taken" there: the project is
named `convene` for the repository, the CLI, the plugin id and the Atlas project slug, with a
one-line credit to `hex/claude-council` as the starting scaffold.

**Mode mapping.** None. This is a chore: no mode is built, no behaviour changes, and every
existing test keeps passing with only name strings edited. A change that alters what a command
does is out of scope and stops the run.

Baseline: `main` at `c06fff9` (PR #13 merged 2026-09-13), CI green on ubuntu, macos and windows.

## Goal

After this chore, on every machine:

- the repository is `AnnasCookies/convene`, the package and its `bin` are `convene`, and the
  installed plugin is `convene@annascookies-plugins`;
- `/council`, `/second-opinion`, `/ask`, `/result` and `/status` do exactly what they did, and
  their namespaced forms are `/convene:council`, `/convene:second-opinion`, `/convene:ask`,
  `/convene:result` and `/convene:status`;
- the records root `~/.claude/council`, the `COUNCIL_*` variables, `providers.env`, the CLI
  subcommands (`council`, `second-opinion`, `run`, `adjudicate`, `result`, `jobs`, `doctor`,
  `health`, `modes`) and the `claude-council` OMP profile name are untouched;
- the README and the CHANGELOG credit `hex/claude-council` in one line each;
- `bootstrap/update-council-engine.sh` in dotagents cuts a machine over from the old plugin id to
  the new one and is a no-op on a machine already cut over.

## Scope

### 1. Repository, package and manifests (this repository)

| Surface                                 | Today                                                        | After                                                                          |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| GitHub repository                       | `AnnasCookies/claude-council`                                | `AnnasCookies/convene`; GitHub redirects the old name                          |
| `package.json` `name`, `bin`            | `claude-council`                                             | `convene`; `bun install` refreshes the lockfile's workspace name               |
| `.claude-plugin/plugin.json`            | `name`, `homepage`, `repository` name the old id             | `convene`, new URLs; description and keywords say what it is                   |
| `.claude-plugin/marketplace.json`       | plugin entry `claude-council`                                | plugin entry `convene`; the marketplace name stays `annascookies-plugins`      |
| `src/cli.ts` help                       | `name: 'claude-council'`                                     | `name: 'convene'`                                                              |
| `src/substrate/execution/cli.ts`        | package-root error text and the `claude-council-cli-` prefix | `convene`                                                                      |
| `.github/workflows/tests.yml`           | adds `upstream` as `hex/claude-council`                      | unchanged: upstream is the scaffold's real name                                |
| `tests/release/repository-ownership.ts` | `expectedOrigin = 'AnnasCookies/claude-council'`             | `'AnnasCookies/convene'`; fixtures follow; upstream stays `hex/claude-council` |
| `tests/containment-loader.test.ts`      | expects `plugin claude-council` with 5 commands              | expects `plugin convene` with 5 commands                                       |
| `tests/core/cli.test.ts`                | package fixture named `claude-council`                       | `convene`                                                                      |
| temp-directory prefixes in tests        | `claude-council-*`                                           | `convene-*` (cosmetic; may be left)                                            |

Kept on purpose, with a comment saying why:

- `ompCouncilProfile = 'claude-council'` in `src/substrate/execution/provider.ts`. It names an
  OMP profile that already holds credentials on the user's machines; renaming it would silently
  drop that seat. An alias to a `convene` profile is a later change, not this one.
- The `Historical upstream` fixture in `tests/security/repository-privacy.ts`.

### 2. Documentation

- `README.md`: title, the install lines (`claude plugin install convene@annascookies-plugins`),
  the namespaced command list, and the fork paragraph, which becomes the credit line: this is
  `convene`, started from `hex/claude-council`; the upstream MIT licence and notices are retained.
  The OMP profile sentence keeps the old profile name because that is the profile's name.
- `CHANGELOG.md`: the header sentence names `convene`; an `Unreleased` entry records the rename,
  the credit, and the cutover command for an installed machine.
- `docs/vision.md` and `docs/modes.md`: the two paragraphs that say the rename is pending now say
  it has landed and that examples use the `convene` CLI form. Nothing else in either document
  changes.
- `docs/ARCHITECTURE.md`: name strings only.
- `skills/council/SKILL.md` and `skills/second-opinion/SKILL.md` link to `src/evidence/schema.ts`
  and `src/evidence/normalise.ts`, which moved under `src/substrate/` in step 1. Fix the two links
  while editing these files; it is documentation only and was found while scoping this brief.
- Left as history: `docs/council-suite-brief.md`, everything under `docs/forge/`, and the
  CHANGELOG entries that describe the earlier `hex-plugins` to `annascookies-plugins` rename.

### 3. Distribution cutover (companion PR in `AnnasCookies/dotagents`)

The engine updater already handled one rename, `hex-plugins` to `annascookies-plugins` in engine
2026.8.16, by removing the stale registration before add-or-update. Follow the same shape.

- `bootstrap/update-council-engine.sh`: `PLUGIN=convene`, `MARKETPLACE_SOURCE=AnnasCookies/convene`,
  a `STALE_PLUGIN=claude-council` step that uninstalls the old plugin id from `claude` and `omp`
  when it is present, and a re-point of the marketplace source when the registered one still
  names the old repository. Report-only mode shows the plan; `--apply` does it.
- `harness/claude/templates/scripts/council-runtime.ts` and its test resolve the plugin cache
  path `annascookies-plugins/<plugin>/<version>`; they take the new id. Same for
  `skill-api-health.ts`, `scripts/verify-session-notes.sh` and `tests/council-wrapper-stdin.test.ts`.
- `shared/skills/council/SKILL.md` names the installed plugin id; update it. The lessons files
  and `archive/` keep the old name because they describe the past.
- Machines: the Linux rig, both Windows laptops, for `claude` and `omp`. `known_marketplaces.json`
  on each currently points at `AnnasCookies/claude-council`; GitHub's redirect keeps
  `marketplace update` working, and the updater re-points it so nothing depends on the redirect.

### 4. Atlas project slug

The session receipt derives `project` at session start; after the checkout directory and remote
are renamed it should read `project=convene`. This session did not verify how the slug is derived,
so the acceptance step is the first receipt after the rename. Memories written under
`claude-council` stay under that slug; cross-session searches use both slugs until Atlas offers a
merge. No code in this repository.

### 5. Release

Bump to `2026.9.6` and ship through the `shipping-distributed-artefacts` skill in dotagents. The
`Unreleased` section already carries the substrate entry from step 1; this is the first release
under the new id, so the CHANGELOG entry says which command an installed machine runs to cut over.

## Sequence

Order matters because the ownership check reads the checkout's `origin` remote and CI's checkout
names the repository as GitHub knows it at run time.

1. User: close sessions and worktrees on the checkout; `gh repo rename convene`; rename the local
   directory to `~/Documents/Dev/GitHub/convene`; `git remote set-url origin` on every checkout.
   The old URL redirects, so nothing breaks in between.
2. This repository's PR, opened after step 1 so its CI runs against the renamed repository.
3. Release.
4. The dotagents PR, then `update-council-engine.sh --apply` on each machine.
5. First session in the renamed checkout: confirm the Atlas receipt.

## Non-goals

- No change to the records root, `COUNCIL_*` names, `providers.env`, `models.json` lookup, CLI
  subcommands, wrapper behaviour or the OMP profile name.
- No mode work and no behaviour change of any kind.
- No rewriting of archives: forge briefs, the handover, CHANGELOG history, dotagents `archive/`
  and lessons.
- No history rewrite on GitHub; the redirect stays in place.

## Invariants that must hold, each with a test

1. Behaviour parity: `tests/core` unchanged except name strings; `bun run check` green.
2. Ownership: `tests/release/repository-ownership.ts` accepts origin `AnnasCookies/convene` and
   upstream `hex/claude-council`, and rejects the old origin.
3. No half-rename: a release check (`tests/release/naming.ts`) scans the repository for the literal
   `claude-council` outside an explicit allow-list (CHANGELOG history, `docs/forge/`,
   `docs/council-suite-brief.md`, the README credit and OMP sentences, the upstream remote in CI
   and tests, the OMP profile constant). The allow-list is the test's own table, so a new stray
   reference fails the check.
4. The plugin loads as `convene` with five commands (`tests/containment-loader.test.ts`).
5. Cutover idempotence: the updater's report-only mode on the rig before `--apply` lists the
   uninstall and install; a second report-only run after `--apply` lists nothing.

## Acceptance evidence

- `bun run check` green on the PR, on a CI checkout whose origin is the new name.
- `bun --no-install dist/cli.js self-check --json` and `help` report `name: convene`.
- `claude plugin validate .` passes.
- On the rig after `--apply`: `claude plugin list` shows `convene@annascookies-plugins` and not
  `claude-council@annascookies-plugins`; `/convene:status` returns the doctor result; `/status`
  still resolves.
- The first Atlas receipt in the renamed checkout reads `project=convene`.

## Decisions Forge must not make

Renaming the records root, the `COUNCIL_*` surface, a CLI subcommand or the OMP profile; changing
the marketplace name; editing anything listed as history. Each is a blocker, not an assumption.

## House rules

Bun and TypeScript strict; British English; branch and PR, never `main`; conventional commits;
`bun run lint` green; Linux and Windows portability; the installed runtime is
`bun --no-install dist/cli.js`; no push to a remote and no plugin uninstall on a machine without
the user's go-ahead.

## Sizing

One PR here, one in dotagents, one release, and a per-machine `--apply`. A single sitting once the
GitHub rename is done. Suggested stages for the PR here: manifests and source strings; tests and
the naming check; documentation; bundle and self-check.
