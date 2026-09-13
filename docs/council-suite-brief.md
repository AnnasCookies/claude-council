# Council suite — handover brief

Written 2026-09-09 to start a fresh session. Read all of it before doing anything.
The first session's job is to **brainstorm and write the spec with the user, not to build**.

## What the user wants

A suite for collaboration between multiple model perspectives, covering the forms humans
use when they think together: an ambient advisor, a second opinion, a panel of consultants,
a forum or senate, a committee with a ruling, an ideation room, a triage desk, an audience
reacting to a draft. Robust, flexible, scalable, versatile, and above all built to get the
best out of several perspectives. Real-time advisory (like omp's advisor seat) as much as
slow deliberation.

The user came up with `/council` before any upstream project existed. What exists today is a
deeper version of one form only. That is the thing to correct.

## What exists today, precisely

- `~/Documents/Dev/GitHub/claude-council` — a checkout of the GitHub fork
  `AnnasCookies/claude-council` (forked from `hex/claude-council` at v2026.7.9, July 2026).
  Since the fork point the user's 11 commits replaced upstream's 70-file shell plugin with a
  10.8k-line Bun/TypeScript kernel (`src/`: cli, domain, evidence, execution, health, models,
  policy, providers, records, roles; 20 test files). Nothing upstream since July is in it;
  nothing of it went upstream. It is a different program under a borrowed name.
- What the kernel does well and must be kept as the **substrate**: verified model identity
  per seat; subscription CLI seats (`claude`, `codex exec`, `agy`) with HTTP providers
  (xAI, Google, DeepSeek, Moonshot) alongside; fail-closed policy and secrets guard;
  append-only session records; health, doctor and self-check; the 2026.8.19 invariant that a
  run never resolves itself (identical short answers under a shared prompt are a measurement
  artefact, so a human chair adjudicates and dissent is recorded).
- What it is not: anything other than the committee form. Quorum, classification, rounds and
  chair rulings are committee invariants. They are wrong for ideation (which wants
  divergence) and irrelevant for an advisor (which wants latency).
- Distribution: installed as `claude-council@annascookies-plugins`; the user's `/council` and
  `/second-opinion` skills in dotagents (`shared/skills/council`, `shared/skills/second-opinion`)
  delegate to it; `dotagents/bootstrap/update-council-engine.sh` updates the engine. Read the
  dotagents skills `shipping-council-kernel-changes` and `diagnosing-council-provider-failures`
  before touching distribution or seats.
- omp already has an advisor seat configured (`~/.omp/agent/config.yml`, `advisor:` model).
  That is the reference feel for the real-time form.

## How the drift happened, so it does not repeat

The fork's PR #1 (2026-07-28) came out of a Forge run whose brief said "replace the legacy
shell-driven council with a standing-council kernel" and "migrate history". The pipeline
built exactly that, in its most governance-heavy reading, and nothing checked it back against
the wider intent because the wider intent was never written down. Rule for this project:
**one-page vision and a modes spec first; every brief cites them; a run that cannot map its
output to a mode in the spec stops and asks.**

## The frame to design against

Every form is one substrate with five knobs.

| Form           | Participants              | Pattern                  | Aggregation                | Tempo       |
| -------------- | ------------------------- | ------------------------ | -------------------------- | ----------- |
| Advisor        | one or two seats, ambient | streaming, may interrupt | none                       | seconds     |
| Second opinion | several families, blind   | one parallel round       | attributed synthesis       | a minute    |
| Consultants    | seats chosen by lens      | brief, then Q&A          | per-lens reports           | minutes     |
| Forum / senate | many seats                | rounds with rebuttal     | dissent preserved          | long        |
| Committee      | fixed seats, quorum       | rounds, then a ruling    | chair adjudication, record | long        |
| Ideation       | many cheap, diverse seats | divergent, no cross-talk | cluster, never converge    | minutes     |
| Triage         | one or two seats          | structured, per item     | sort and route             | fast, batch |
| Audience       | many cheap voices         | react to a draft         | tallies and quotes         | minutes     |

Substrate (seats, identity, transport, records, health) is shared. A mode is a named
configuration of the five knobs plus its own invariants. The synthesis format the user already
likes for second opinions: Panel (attributed) → Agreement → Disagreement → My take →
Recommendation; treat unanimity with suspicion.

## Requirements the user has stated

- **Subscriptions first, API keys as fallback.** Seats run on the user's subscriptions
  (Claude Code, Codex, agy, Grok, omp/pi providers) and fall back to the same family's API
  key when the subscription is out of usage or the CLI is unavailable. Fallback must be
  explicit in the record (which transport answered) and never silent about cost.
- Works from every harness the user runs (Claude Code, omp, pi, codex), not only Claude Code.
- Records are a property of the mode: a committee keeps a ledger, an advisor keeps nothing.
- The existing `/council` and `/second-opinion` entry points keep working through any change.

## House rules that apply

Bun and TypeScript strict; British English; no secrets in the repo, credentials via
`COUNCIL_`-prefixed env with `.env.example`; branch and PR, never push to `main`; conventional
commits; `bun run lint` green; distribution through `annascookies-plugins` and dotagents.
Atlas project slug for memory: `claude-council` (rename with the project).

## First session: do this, in order

1. Run the `superpowers:brainstorming` skill with the user on the vision. Do not build.
2. Produce `docs/vision.md` (one page: who, what, the forms, what it is not) and
   `docs/modes.md` (each mode as a row of the five knobs plus invariants and an example
   invocation). Get both accepted before any code.
3. Decide with the user: the project's own name and repo (it should stop being "a fork of
   hex/claude-council"; keep a one-line credit to upstream as the starting scaffold), and which
   two modes ship first. Advisor and ideation are the ones furthest from what exists.
4. Only then write a brief for the first build, citing the two docs, sized to one mode.

## Decisions only the user can make

- The name.
- Whether the committee kernel is refactored in place or the substrate is extracted first.
- Which subscriptions count as primary per family, and the per-family API fallback.
- Whether advisor mode lives inside the harness (omp-style seat) or as a sidecar the
  harnesses call.
