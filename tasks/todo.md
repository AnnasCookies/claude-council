# Build the remaining six modes

Spec: `docs/modes.md` and `docs/vision.md` (accepted 2026-09-12). User instruction 2026-09-15:
build everything without acceptance stops; merge each PR on green CI; test afterwards.
Baseline: `main` at `f6d4743` (engine `2026.9.6`, plugin `convene@annascookies-plugins`).

## Goal

Advisor, ideation, consultants, forum, triage and audience run as registered modes on the
substrate, each returning the result envelope, each with a CLI subcommand, a slash-command
wrapper, records committed before success, tests, and docs. The engine ships as `2026.9.7` and
is cut over on the rig.

## Approach

- [ ] 0. Foundation PR: panel primitive (N seats, many per family, lens or persona each, blind,
      parallel, structured JSON answer validated per mode, spend policy honoured), mode session
      store (append-only JSONL per session under the records root, committed and rendered as
      minutes), handler-style modes in the registry, CLI dispatch for them.
- [ ] 1. Advisor: `advise --watch|--hold|--ask|--heed|--note|--end`, note log, `sub-only`, risk
      classes, bounded hold; Claude Code hook in dotagents; sidecar script for the other harnesses.
- [ ] 2. Ideation: `ideate`, many cheap seats one lens each, deterministic near-duplicate
      clustering labelled as the engine's grouping, expansion passes by cluster id, raw list always.
- [ ] 3. Consultants: `consult`, seats by lens, brief and reports, conflicts listed by a named
      synthesiser seat, Q&A to one consultant, session stays open, cap covers the session.
- [ ] 4. Forum: `forum`, many seats, rounds with rebuttal, structured stance per seat, position
      map, moved, motions with support and opposition, no ruling ever.
- [ ] 5. Triage: `triage`, schema-bound per-item verdicts, one or two seats, disagreement routed
      to a human, `sub-only`, `unprocessed` never routed.
- [ ] 6. Audience: `audience`, persona seats react to a hashed draft, structured fields, tallies
      as counts, verbatim attributed quotes, `sub-only`.
- [ ] 7. Release: bump `2026.9.7`, CHANGELOG, README and ARCHITECTURE; cut over the rig through
      the updater; verify through the shim.

## Files

Per PR, listed in its plan under `docs/superpowers/plans/`. Wrappers in `commands/`, skills in
`skills/`, harness hooks in dotagents.

## Risks

- The runner is built for one seat per family with quorum; the new modes need many seats per
  family and no quorum. The panel primitive is new code beside the runner, not a change to it.
- Structured answers from subscription CLIs fail on retries (lesson 2026-09-09): ask for small
  JSON, keep the raw answer, mark the seat `invalid` rather than drop it.
- Six PRs in sequence each wait on three CI legs; merges happen on green, as authorised.
- Harness hooks outside Claude Code vary; the kernel contract is the same everywhere and the
  wiring is documented per harness with what each supports.
