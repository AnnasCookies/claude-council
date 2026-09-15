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

- [x] 0. Foundation PR: panel primitive (N seats, many per family, lens or persona each, blind,
      parallel, structured JSON answer validated per mode, spend policy honoured), mode session
      store (append-only JSONL per session under the records root, committed and rendered as
      minutes), handler-style modes in the registry, CLI dispatch for them.
- [x] 1. Advisor: `advise --watch|--hold|--ask|--heed|--note|--end`, note log, `sub-only`, risk
      classes, bounded hold; Claude Code hook in dotagents; sidecar script for the other harnesses.
- [x] 2. Ideation: `ideate`, many cheap seats one lens each, deterministic near-duplicate
      clustering labelled as the engine's grouping, expansion passes by cluster id, raw list always.
- [x] 3. Consultants: `consult`, seats by lens, brief and reports, conflicts listed by a named
      synthesiser seat, Q&A to one consultant, session stays open, cap covers the session.
- [x] 4. Forum: `forum`, many seats, rounds with rebuttal, structured stance per seat, position
      map, moved, motions with support and opposition, no ruling ever.
- [x] 5. Triage: `triage`, schema-bound per-item verdicts, one or two seats, disagreement routed
      to a human, `sub-only`, `unprocessed` never routed.
- [x] 6. Audience: `audience`, persona seats react to a hashed draft, structured fields, tallies
      as counts, verbatim attributed quotes, `sub-only`.
- [x] 7. Release: bump `2026.9.7`, CHANGELOG, README and ARCHITECTURE; cut over the rig through
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

## Follow-ups parked by the reviews (2026-09-15)

Every mode shipped in engine `2026.9.7`; these are the minors each whole-branch review parked,
none of which blocks use. Details and file lines were in the SDD ledgers at the time.

- Ideation: `--expand` resolves cluster ids before the lock, so a concurrent pass can merge a
  named cluster away; idea text and `raw` in the log are unbounded; "cheap seats" is weaker than
  it reads for families with no registered fallback (anthropic, openai, moonshot).
- Consultants: `replaySession` does not cross-check a `qa` event's lens; event schemas do not
  correlate status with payload; `SessionState.spend` drops `refused` and the at-cap refusal event
  synthesises `refused: 1`; a brief refuses only the fallback at the cap while a follow-up refuses
  the seat outright (documented); the synthesiser lens description is inert; `--personas` is not
  containment-checked (deliberate, commented); `synthesis.text` renders as JSON in the minutes;
  the metered-from-the-start cap test should use two lenses and `--spend-cap 1`.
- Forum: the position map is empty when the final round produced no answers (documented);
  prior-position carry-over is unbounded (a lower forum text cap is the lever); the reused-session
  check runs before, not inside, the write lock.
- Triage: `memberOf` issues carry only the default `custom` code; `describeIssues` truncates to
  five silently (`panel.ts` has the same helper); `--spend-cap` is accepted and ignored under
  `never-metered` (shared with advisor); a `runPanel` throw mid-batch surfaces as exit 2;
  `seat.raw` reaches the committed log unredacted (shared convention with ideation).
- Audience: the reused-session check runs before the write lock; `hasSubscriptionRoute` lives
  in the mode; only the truncated quote is recorded; the bounded-read block is duplicated in
  `personas.ts` and `draft.ts`.
- CLI: `caller-undeclared` is pushed into `degraded` after the mode fixed `status`, so the two
  disagree there (a soft note by design); `{"aliases": []}` in the alias index normalises to an
  empty map rather than being refused.
- Harness (dotagents): omp and pi await the cadence spawn inside `turn_end` (wants a live check);
  a crashed Claude Code session leaves its small advisor state file behind; `(` in the class-map
  anchor classifies parenthesised prose (accepted).
