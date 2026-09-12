# Vision: the council suite

The project is named **convene**. That name replaces `claude-council` for the repository, the CLI,
the plugin id and the Atlas project slug. The rename is its own chore PR after the substrate is
extracted, and until it lands the docs use `council` as the CLI name. Upstream `hex/claude-council`
is credited as the starting scaffold; this is a different program.

Written 2026-09-10 from the brainstorm on `docs/council-suite-brief.md`. Every build brief cites
this page and `docs/modes.md`. A run that cannot map its output to a mode in `modes.md` stops and
asks.

## Who it is for

Two consumers, and every call says which one it is.

- **You**, working from any harness you run (Claude Code, omp, pi, codex, agy, grok) on any of your
  machines,
  when you want more than one perspective before deciding, or a room to think in.
- **The agent you are working with**, when it needs a second view in seconds (an advisor) or a
  batch sorted (triage), and will act on the answer itself.

## What it is

One substrate, many forms. The substrate is what the kernel already does well and keeps: seats
with verified model identity; subscription CLI transports (`claude`, `codex exec`, `agy`, Grok)
with the same family's metered API as an explicit, recorded fallback; fail-closed policy and the
secrets guard; append-only records; health, doctor and self-check.

A **seat** is a model and a lens. The model axis is what identity verification checks. The lens is
a named brief, from the catalogue or supplied with the call, that any model can carry, so one cheap
model can hold several lenses in the same room. Perspective comes from both axes: different
training and different framing.

A **mode** is a named setting of five knobs, plus its own invariants and its own result shape.

| Knob         | What it sets                                                                       |
| ------------ | ---------------------------------------------------------------------------------- |
| Participants | how many seats, chosen by family, by lens, or both                                 |
| Pattern      | streaming, one blind parallel round, or rounds with rebuttal                       |
| Aggregation  | none, attributed synthesis, per-lens reports, clusters, tallies, or a human ruling |
| Tempo        | seconds, about a minute, minutes, or long                                          |
| Records      | a note log, through to a full ledger and decision record                           |

Eight forms are specified in `docs/modes.md`: advisor, second opinion, consultants, forum,
committee, ideation, triage, audience. The committee is what exists today. Advisor and ideation
are the furthest from it. They ship first, in that order, once the substrate is extracted and the
committee runs as the first mode on it.

## Principles

1. **Diversity is the product.** Any mode with more than one seat spreads across families by
   default. Unanimity is flagged, never celebrated: identical short answers under a shared prompt
   are a measurement artefact.
2. **Dissent is preserved, never averaged.** Every output is attributed to the seat that produced
   it. Synthesis names who agreed and who did not.
3. **Nothing resolves itself.** No model picks the winner. A human chair rules (committee), a
   human selects (ideation), the working agent decides (advisor).
4. **Seats speak, they never act.** No seat runs a tool, edits a file or halts a harness. The
   advisor may ask for a bounded pause before a risky action; silence means proceed.
5. **The result is machine-readable first.** Every mode returns one validated result envelope.
   The prose is rendered from it, and the envelope is the record, so what an agent consumed and
   what you trace later are the same object.
6. **Subscriptions first, spend explicit.** Fast modes (advisor, triage, audience) never fall back
   to a metered key: the seat is skipped and the record says so. Slow modes fall back under a
   per-session spend cap with a mode default, and at the cap they stop and ask. Every fallback
   names the transport that answered.
7. **Records belong to the mode, and outlive the machine.** An advisor keeps a note log. A
   committee keeps a ledger and a decision record. Ideation keeps every idea, including the ones
   you did not pick. The store lives in a git-synced directory and a terminal record is
   committed before a run reports success; minutes are rendered into the vault for Atlas to
   ingest, and a committee ruling is written to Atlas as a decision. Raw harness transcripts
   never enter the store.
8. **One CLI, every harness.** The engine is a Bun/TypeScript CLI with JSON in and out. Skills,
   slash commands and hooks in each harness are thin wrappers, and none holds logic the CLI does
   not.

## What it is not

- Not an agent framework. It runs no tools, edits no files, executes no plans.
- Not a policy engine. Deterministic hooks in the harness enforce hard rules; the advisor advises.
- Not a model router. A single-seat call is an advisor or a triage desk, not a council, and no
  mode exists to pick "the best model".
- Not a chat UI or a hosted service. It is a CLI with records on disk, fronted by the harnesses
  you already use.
- Not a data boundary. Any configured provider may receive anything a mode sends it; the secrets
  guard is the only filter. Decided 2026-09-10. A per-project provider allowlist can be added as
  policy later without changing the substrate.
- Not a fork of `hex/claude-council` in any sense but its starting scaffold.

## What done looks like

- Every recommendation in every mode traces to a seat, a verified model, a lens and the transport
  that answered.
- Each mode ships with its invariants as tests, and a run whose output cannot be mapped to a mode
  stops.
- `/council` and `/second-opinion` keep working through every change.
- An advisor session leaves a note log that shows what it said, when, and whether the agent
  heeded it.
- A terminal record from any mode is on GitHub and findable in Atlas without a manual step.
