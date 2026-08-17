# Forge run, 2026-07-27 — abandoned and reconciled

`2026-07-27-standing-council-kernel-spec.md` is a live design document. The **pipeline** that was
started against it is not, and its state has been removed rather than left to look in-flight.

## What the run was

A five-stage Forge pipeline (`standing-council-kernel`) with 286 extracted acceptance criteria:

| Stage | Name                          |
| ----: | ----------------------------- |
|     1 | Public Containment            |
|     2 | Domain and Policy Foundation  |
|     3 | Provider Runtime              |
|     4 | Facades and Release Candidate |
|     5 | Legacy Removal and Acceptance |

## Why it was abandoned

It recorded itself as blocked, and its own blocker explains why it could not continue:

> Forge records Stage 1 as planning at revision 3, but commit `e752d42` contains the completed
> cross-stage implementation. This run cannot retroactively absorb or certify those edits.

The implementation overtook the pipeline. Its declared worktree
(`C:/tmp/forge-standing-council-public`) no longer exists, Stage 1 was blocked after one attempt,
and Stages 2–5 never started. Nothing in the tree referenced `.forge/` except `.audit/`, which is
untracked.

The work itself shipped by ordinary pull request instead — `2026.8.14` through `2026.8.18` (direct
Codex seat and reduced quorum, xAI dual transport and engine identity, marketplace rename, the Grok
subscription seat, `COUNCIL_`-prefixed credentials), and then chair adjudication, per-seat route
verification and versioned decision-level records.

## Why the state was deleted rather than reconciled

Reconciling would mean marking stages complete from work the pipeline never observed. Its own
blocker rules that out, and a certification invented after the fact is worth less than no
certification. So the honest options were "abandoned" or "certified dishonestly", and this is the
first.

## Recovering it

Nothing is lost; it is in git history.

```bash
git show c239827:.forge/state.json
git checkout c239827 -- .forge          # restore the whole directory
```

Starting fresh against the same spec is a new `forge init`, not a resumption of this run.
