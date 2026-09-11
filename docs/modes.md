# Modes

Each mode is a named setting of the five knobs from `docs/vision.md`, plus its own invariants,
its own `output` shape inside the shared result envelope, and an example invocation. The
substrate underneath is shared and described first.

`council` is the working CLI name until the rename. Examples show the CLI form; the skill, slash
command or hook in each harness wraps it and holds no logic of its own. Flags marked _new_ do not
exist yet. Everything else in an example already runs today.

## The substrate every mode uses

| Part       | Today                                                                                                                            | Change the suite needs                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Seats      | A seat is a provider family plus a model; identity verified per seat                                                             | A seat becomes model plus lens. Lens from `src/roles/catalogue.json` or a persona list supplied with the call                    |
| Transports | Subscription CLI first, metered API fallback recorded as `credentialFallback`; billing modes `sub-first`, `sub-only`, `api-only` | A per-session spend cap. Fast modes pin `sub-only`                                                                               |
| Execution  | One runner: blind round, rebuttal round, optional refinement                                                                     | Three patterns: **streaming** (advisor), **parallel** (one blind round), **rounds** (rebuttal). The existing runner is the third |
| Records    | Store scopes `general/` and `projects/<id>/`, each with sessions, resolutions, ledger; append-only, atomic writes                | Each mode declares what it writes. The envelope is the record; see Records and memory                                            |
| Policy     | Fail-closed project policy, secrets guard                                                                                        | No data tiers (vision). Risk classes for advisor holds                                                                           |
| Health     | `doctor`, `health`, `self-check` per seat                                                                                        | Unchanged; report lens support and spend cap state                                                                               |

## The result envelope

Every mode returns one envelope, validated with Zod before anything is rendered or returned.
An envelope that fails validation is a failed run, not a partial one.

```json
{
  "mode": "second-opinion",
  "session": "so-2026-09-10-…",
  "caller": { "kind": "human", "harness": "claude-code", "purpose": "choose an ORM" },
  "pattern": "parallel",
  "rounds": 1,
  "seats": [
    {
      "id": "anthropic/claude-opus-5#risk",
      "family": "anthropic",
      "model": {
        "requested": "claude-opus-5",
        "verified": "claude-opus-5",
        "verification": "verified"
      },
      "lens": "risk",
      "transport": "subscription",
      "fallback": false,
      "status": "ok",
      "reason": null
    }
  ],
  "output": {},
  "synthesis": { "by": "anthropic/claude-opus-5#synthesiser", "text": "…" },
  "dissent": [{ "seat": "…", "position": "…" }],
  "unanimous": false,
  "spend": {
    "billing": "sub-first",
    "cap": "mode-default",
    "used": 0,
    "fallbacks": 0,
    "stoppedAtCap": false
  },
  "degraded": [],
  "record": "projects/claude-council/sessions/so-2026-09-10-….json"
}
```

- `caller.kind` is `human` or `agent`. It is set by the wrapper, never inferred.
- `synthesis` is always attributed. Where the caller is an agent, "My take" and "Recommendation"
  are written by the caller and appended by the wrapper, and the envelope names that author.
- `unanimous` is a flag to be suspicious of, not a success signal.
- `spend.used` is counted in calls per transport; a cost estimate is attached only where the
  transport reports one. No invented figures.
- `degraded` lists every reason the run is weaker than the mode's default: skipped seats, reduced
  families, unverified identity.

## Records and memory

Two stores, one role each. Neither replaces the other.

- **Durability is git.** The records root lives inside a git-synced directory (today
  `~/.claude/council` in dotclaude, whose sessions are already on GitHub). A terminal record is
  committed in that repository before the run reports success. For the advisor the terminal
  record is the session's note log, committed when the session ends. Push stays with the existing
  dotclaude sync; the kernel never pushes.
- **Findability is Atlas.** Each terminal record is also rendered as a minutes file into the
  vault's raw writing tree, where the existing ingest picks it up as a `document`. The kernel
  never calls Atlas directly; the vault pipeline does the work.
- **Decisions are distilled.** A committee ruling is written to Atlas as a `decision` naming the
  run id and record path. Any other mode's synthesis goes to Atlas only when the caller asks.
- **Raw harness transcripts never enter the store.** What a harness sends a seat as input is not
  what the store keeps. The store keeps what the seats said.

## Invariants shared by every mode

1. Every seat's model identity is verified or the seat is marked `unverified`. The mode says
   whether unverified seats count towards its participants.
2. Seats speak, never act. No tool calls, no file edits, no halting a harness.
3. Every fallback to a metered key is recorded on the seat. Fast modes never fall back.
4. No mode resolves itself. Selection, ruling and action belong to a human or the calling agent.
5. In a blind round no seat sees another seat's output from that round. Prior-round content is
   carried as untrusted data.
6. Where a mode keeps records they are append-only and written atomically.
7. The envelope validates or the run fails.
8. A terminal record is committed in the records repository before the run reports success.

## The eight modes at a glance

| Mode           | Participants                      | Pattern                                          | Aggregation                            | Tempo                       | Records                   | Consumer | Spend            |
| -------------- | --------------------------------- | ------------------------------------------------ | -------------------------------------- | --------------------------- | ------------------------- | -------- | ---------------- |
| Advisor        | one seat, two at most             | streaming, cadence plus on demand, advisory hold | none                                   | seconds                     | note log                  | agent    | never falls back |
| Second opinion | three or more families, blind     | parallel                                         | attributed synthesis                   | about a minute              | session                   | either   | cap              |
| Consultants    | seats chosen by lens              | brief, reports, then Q&A rounds                  | per-lens reports plus conflicts        | minutes, session stays open | session with Q&A          | either   | cap              |
| Forum          | many seats, no quorum             | rounds with rebuttal                             | position map, dissent preserved        | long                        | full ledger               | human    | cap              |
| Committee      | fixed seats, quorum               | rounds, then a human ruling                      | chair adjudication, decision record    | long                        | ledger and resolutions    | human    | cap              |
| Ideation       | many cheap seats, one lens each   | parallel, blind, expansion passes                | clusters, never ranked                 | minutes                     | every idea, every pass    | human    | cap              |
| Triage         | one or two seats                  | parallel, per item, schema-bound                 | sort and route, disagreements surfaced | fast, batch                 | routed batch              | agent    | never falls back |
| Audience       | many cheap voices, persona lenses | parallel, blind, react to a draft                | tallies and verbatim quotes            | minutes                     | reactions with draft hash | human    | never falls back |

## Advisor

**Purpose.** A seat that sits beside the working agent, reads the transcript on a cadence, answers
when asked, and may ask for a short pause before a risky tool call. It speaks; the agent decides.

**Knobs.** Participants: one seat, optionally a second cheaper one for the cadence pass. Pattern:
streaming; triggered by cadence (every N agent turns), by question, or by a hold before a tool
call in a named risk class. Aggregation: none; each note stands alone. Tempo: seconds. Records: a
note log per session, nothing else.

**Consumer.** The agent. You read the note log afterwards.

**Spend.** `sub-only`. If the seat's subscription is exhausted or its CLI is down, the note is
skipped and the log records `skipped` with the reason.

**Invariants.**

- Speaks, never acts. No tool calls, no halting.
- A hold is bounded: the hook waits at most the configured window, then proceeds. Silence is
  recorded as `no-advice`. Default window 8 seconds, configurable per harness.
- Holds fire only on named risk classes: `destructive-git`, `delete`, `deploy`, `payment`,
  `credential`. The class list is configuration, not inference.
- Off by default. Enabled per session or per project.
- Every note is logged with its trigger, and `heeded` is set to `yes`, `no` or `unknown` by the
  wrapper: a hold knows whether the call went ahead; a cadence note is `unknown` unless the agent
  acknowledges it.
- The harness transcript window, yours and the working agent's, is input only and is never
  copied into the record. The advisor's notes are the record, and they follow the rules in
  Records and memory.

**Output.**

```json
{
  "note": {
    "id": "n-…",
    "trigger": "hold",
    "severity": "caution",
    "text": "…",
    "refersTo": { "toolCall": "…" },
    "heeded": "unknown"
  }
}
```

**Placement.** In-harness seat (omp style) or a sidecar the harnesses call is an open decision.
This spec is placement-neutral: transcript window in, note out, `heed` back.

**Example.**

```text
council advise --session s1 --watch --every 3 --transcript -            # new; window on stdin
council advise --session s1 --hold --class destructive-git --tool "git push --force origin main"   # new
council advise --session s1 --ask "Is there a simpler route than a migration here?"                # new
council advise --session s1 --heed n-42 yes                                                        # new
```

## Second opinion

**Purpose.** One blind round across families for a question you want checked before you act.

**Knobs.** Participants: three or more distinct families by default, one lens each (the question
as posed, or a lens per seat if named). Pattern: parallel, blind. Aggregation: attributed
synthesis in the order Panel, Agreement, Disagreement, My take, Recommendation. Tempo: about a
minute. Records: the session, every seat's full answer kept.

**Consumer.** Either. The `/second-opinion` skill sets `caller.kind` to `human`; an agent calling
the CLI sets `agent`.

**Spend.** `sub-first` under the cap.

**Invariants.**

- Fewer than three distinct families answering is a degraded result, marked as such; it still
  returns.
- Agreement and Disagreement are computed by a named synthesiser seat and attributed to it.
- My take and Recommendation are written by the caller when the caller is an agent, and by the
  synthesiser when a human calls the CLI directly. The envelope names the author.
- Unanimity sets `unanimous: true`; the synthesis must say so and say why it might be an artefact.

**Output.**

```json
{
  "panel": [{ "seat": "…", "answer": "…" }],
  "agreement": ["…"],
  "disagreement": [{ "point": "…", "positions": [{ "seat": "…", "holds": "…" }] }],
  "take": { "by": "caller", "text": "…" },
  "recommendation": { "by": "caller", "text": "…" }
}
```

**Example.** `/second-opinion` keeps working unchanged.

```text
council second-opinion --motion "Drizzle or Kysely for this service?" --json
```

## Consultants

**Purpose.** Seats chosen for their lens, briefed on the same material, each returning a report,
then available for follow-up questions one at a time.

**Knobs.** Participants: one seat per named lens (`security`, `data-model`, `ux`, and any
catalogue or supplied lens), families spread where the transports allow. Pattern: a brief, one
parallel report round, then Q&A rounds addressed to one consultant each. Aggregation: per-lens
reports plus a list of cross-lens conflicts, unresolved. Tempo: minutes, and the session stays
open for follow-ups. Records: the session with reports and the Q&A.

**Consumer.** Either.

**Spend.** `sub-first` under the cap. The cap covers the whole session including Q&A.

**Invariants.**

- Every report names its lens and its seat.
- Conflicts between lenses are listed, never resolved by the engine.
- A consultant sees another consultant's report only when the caller forwards it in a question.
- A follow-up goes to one named consultant. No broadcast.

**Output.**

```json
{
  "brief": { "question": "…", "context": ["src/…", "docs/…"] },
  "reports": [{ "lens": "security", "seat": "…", "report": "…" }],
  "conflicts": [{ "between": ["security", "ux"], "about": "…", "positions": [] }],
  "qa": [{ "to": "security", "question": "…", "answer": "…" }]
}
```

**Example.**

```text
council consult --lens security,data-model,ux --context src/ docs/vision.md --motion "…"   # new
council consult --session c7 --ask security "Does the fallback path leak the key in logs?"  # new
```

## Forum

**Purpose.** Many seats argue a motion over rounds. Positions move and are seen to move. Nobody
rules.

**Knobs.** Participants: many seats across families and lenses, no quorum, no chair. Pattern:
round one blind positions; later rounds each seat sees all prior positions and may hold, revise or
rebut. Aggregation: a position map with holders, a record of who moved and why, and any motions
raised with support and opposition. Tempo: long. Records: the full ledger of every round.

**Consumer.** You.

**Spend.** `sub-first` under the cap. Rounds stop at the cap and the ledger says so.

**Invariants.**

- No ruling, ever. The forum ends by round limit, by the cap, or by you, never by consensus
  detection.
- Every revision is attributed to a seat and a round.
- Motions raised inside the forum are recorded with support and opposition, not decided.

**Output.**

```json
{
  "rounds": [
    { "n": 1, "positions": [{ "seat": "…", "stance": "hold", "text": "…", "inReplyTo": null }] }
  ],
  "map": [{ "position": "…", "holders": ["…"] }],
  "moved": [{ "seat": "…", "from": "…", "to": "…", "why": "…" }],
  "motions": [{ "by": "…", "text": "…", "support": ["…"], "opposed": ["…"] }]
}
```

**Example.**

```text
council forum --seats 6 --rounds 3 --motion "Should the advisor live in the harness or a sidecar?"   # new
```

## Committee

**Purpose.** What exists today: a standing council with quorum, classification, rounds and a human
chair's ruling. The governance form, for decisions that need a record.

**Knobs.** Participants: fixed seats chosen by the lens allocator, quorum counted in distinct
families (three ordinary, four significant plus a successful contrarian). Pattern: blind round,
rebuttal round, optional refinement. Aggregation: chair adjudication, dissent recorded, decision
record. Tempo: long. Records: ledger, sessions and resolutions in the store.

**Consumer.** You, as chair.

**Spend.** `sub-first` under the cap. `--billing` and project `billingMode` continue to work.

**Invariants.** Unchanged from the kernel.

- A run never resolves itself. The only path to a decision is the chair's ruling.
- Failed quorum disables synthesis; the facade cannot turn it into consensus.
- A reduced quorum is explicit, warned, and carried in the record.
- Identical short answers under a shared prompt are a measurement artefact and are recorded as
  dissent-free, not as agreement.

**Output.** The existing session and resolution records, unchanged, wrapped in the envelope.

**Example.** `/council` keeps working unchanged.

```text
council council --classification public --motion "Extract the substrate before adding modes?"
council adjudicate --run-id <id> --decision "…" --rationale "…" --authorised-by "council-chair"
```

## Ideation

**Purpose.** A room for divergence. Many cheap seats with different lenses answer the same prompt
blind. The engine groups; it never chooses.

**Knobs.** Participants: many cheap seats, each holding one lens from the catalogue or a supplied
persona list, families spread. Pattern: parallel and blind, then expansion passes inside clusters
you name. Aggregation: near-duplicates clustered and labelled, every idea attributed, nothing
ranked. Tempo: minutes. Records: every idea from every pass, and the cluster labels.

**Consumer.** You.

**Spend.** `sub-first` under the cap, cheap models by default.

**Invariants.**

- No seat sees another seat's output within a pass.
- Nothing is scored, ranked or voted on by a model.
- The only reduction is yours: an expansion pass takes the cluster ids you name and generates more
  inside them.
- Clustering is labelled as the engine's grouping; the raw unclustered list is always in the
  output.

**Output.**

```json
{
  "prompt": "…",
  "passes": [
    { "n": 1, "scope": "all", "ideas": [{ "id": "i-1", "seat": "…", "lens": "…", "text": "…" }] }
  ],
  "clusters": [{ "id": "k-1", "label": "…", "ideaIds": ["i-1", "i-7"] }],
  "raw": ["i-1", "i-2"]
}
```

**Example.**

```text
council ideate --seats 12 --motion "Ways to make advisor notes visible without interrupting flow"   # new
council ideate --session i3 --expand k-2,k-5                                                          # new
```

## Triage

**Purpose.** A desk that sorts a batch of items into classes and routes them, item by item, against
a declared schema. Built for an agent pipeline such as review triage.

**Knobs.** Participants: one seat, or two for a disagreement check. Pattern: parallel over items,
each item scored against a schema (class, severity, route, confidence, reason). Aggregation: sort
and route; any item where two seats disagree is routed to a human. Tempo: fast, batch. Records:
the routed batch with per-item verdicts.

**Consumer.** The agent.

**Spend.** `sub-only`. If a seat is unavailable the batch runs with the remaining seat, or returns
every item as `unprocessed`. It never routes an item it did not read.

**Invariants.**

- Every verdict validates against the declared schema.
- The route is returned, never acted on.
- Disagreement between seats is always surfaced, never averaged.

**Output.**

```json
{
  "schema": "pr-comment",
  "items": [
    {
      "id": "…",
      "verdicts": [
        {
          "seat": "…",
          "class": "…",
          "severity": "…",
          "route": "…",
          "confidence": 0.8,
          "reason": "…"
        }
      ],
      "agreed": true,
      "route": "fix"
    }
  ],
  "unprocessed": []
}
```

**Example.**

```text
council triage --schema pr-comment --in comments.json --seats 2 --json   # new
```

## Audience

**Purpose.** Many cheap voices, each a reader persona, react to a draft. You get tallies of
structured reactions and verbatim quotes, not a rewrite.

**Knobs.** Participants: many cheap seats, one persona lens each, supplied with the call. Pattern:
parallel, blind, one round over the draft. Aggregation: tallies over structured fields (clear or
unclear, would act or not, where they stopped reading) and attributed quotes. Tempo: minutes.
Records: the reactions with the draft's hash.

**Consumer.** You.

**Spend.** `sub-only`. Missing voices are recorded, and the tallies say how many voices answered.

**Invariants.**

- Personas are declared in the result, never inferred.
- Tallies are counts of structured fields. No model estimates a percentage.
- Quotes are verbatim from a seat's response and attributed to its persona.
- The draft is hashed so a later run on a changed draft is a different record.

**Output.**

```json
{
  "draft": { "path": "docs/announcement.md", "sha256": "…" },
  "personas": ["ops-manager", "new-starter", "sceptic"],
  "reactions": [
    {
      "persona": "sceptic",
      "seat": "…",
      "fields": { "clear": false, "wouldAct": false, "stoppedAt": "paragraph 3" },
      "quote": "…"
    }
  ],
  "tallies": { "answered": 3, "clear": { "yes": 2, "no": 1 }, "wouldAct": { "yes": 1, "no": 2 } }
}
```

**Example.**

```text
council audience --personas ops-manager,new-starter,sceptic --draft docs/announcement.md   # new
```

## Entry points

| Entry point          | Today                                                    | Under the suite                                                        |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/council`           | committee run                                            | committee, unchanged                                                   |
| `/second-opinion`    | one blind round                                          | second opinion, unchanged                                              |
| `/ask`               | routes to committee with `--debate`, else second opinion | unchanged for now; may later route across modes                        |
| `/result`, `/status` | records and doctor                                       | unchanged                                                              |
| omp `advisor:` seat  | omp's own advisor                                        | reference feel for advisor mode; integration is the placement decision |
| new skills per mode  | none                                                     | named after the rename decision                                        |

## Open decisions

These are the user's, taken after this document is accepted, per the brief.

1. The project's name and repository.
2. Refactor the committee kernel in place, or extract the substrate first.
3. Which subscription is primary per family, and the metered fallback for each.
4. Advisor placement: in-harness seat or sidecar.
5. Which two modes ship first. The brief's candidates are advisor and ideation.
