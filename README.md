# convene

An explicit standing multi-model council for consequential or contested decisions. The plugin runs independent, tool-free provider seats through one Bun/TypeScript core, applies fail-closed outbound policy before transmission, records exact provider/model identity and preserves quorum failure rather than manufacturing consensus.

No hook starts a council automatically.

## Requirements

- Bun 1.3.14 or later
- Claude Code for the `anthropic` seat (`claude` must resolve to a trusted absolute executable)
- Codex CLI (`codex`) for the `openai` seat, authenticated with `codex login`. The seat runs
  `codex exec` directly — it no longer depends on an OMP profile. The former OMP transport is
  still exported as `createOpenAiSubscriptionAdapter` for anyone who prefers it, but it requires
  the `claude-council` OMP profile to hold its own credentials, which is what used to break.
- Antigravity CLI (`agy`) for the optional `google` seat
- Optional HTTP credentials from `.env.example`

The prebuilt `dist/cli.js` bundle is the only runtime entry point. Cached installs require neither `node_modules` nor automatic package installation.

## Install from this repository

```bash
claude plugin marketplace add /path/to/convene --scope user
claude plugin install convene@annascookies-plugins --scope user
claude plugin validate /path/to/convene
```

For development, build and verify the offline runtime:

```bash
bun install
bun run build
bun --no-install dist/cli.js self-check --json
```

`self-check` validates bundled schemas, model routes and the governed lens catalogue. It performs no provider probe or network request.

## Commands

```bash
# Five selected seats, one ordinary round
bun --no-install dist/cli.js second-opinion \
  --classification public \
  --caller human --harness "Claude Code" \
  --motion "Compare JSON and SQLite for a local decision log"

# Declare who is asking; wrappers always do. Absent, the envelope says caller-undeclared.
bun --no-install dist/cli.js second-opinion \
  --classification public \
  --caller agent --harness omp --purpose "choose an ORM" \
  --spend-cap 2 \
  --motion "Drizzle or Kysely for this service?"

# List the registered modes and their knobs
bun --no-install dist/cli.js modes

# Six seats argue a motion over three rounds; nobody rules
bun --no-install dist/cli.js forum \
  --records-root ~/.claude/council \
  --seats 6 --rounds 3 \
  --caller human --harness "Claude Code" \
  --motion "Should the advisor live in the harness or a sidecar?"

# One consultant per lens, briefed on the same material; the session stays open
bun --no-install dist/cli.js consult \
  --records-root ~/.claude/council \
  --caller human --harness "Claude Code" \
  --lens security,privacy,maintainer \
  --context docs/modes.md --context README.md \
  --motion "Is this login path safe to ship?"

# Ask one of them a follow-up, forwarding another consultant's report only if you choose to
bun --no-install dist/cli.js consult \
  --records-root ~/.claude/council \
  --session cs-2026-09-15-3f9a1c \
  --ask security --forward privacy \
  "Does the fallback path leak the key in logs?"

# Significant, multi-round council with contrarian quorum
bun --no-install dist/cli.js council \
  --classification public \
  --caller human --harness "Claude Code" \
  --motion "Should this cross-platform CLI use an append-only record store?"

# Deliberate reduced quorum: weaker than the standing four-family default
bun --no-install dist/cli.js council \
  --classification public \
  --providers anthropic,openai,google \
  --min-families 3 \
  --motion "Should this bounded change proceed with a reduced council?"

# Policy preflight and destinations only; no provider call
bun --no-install dist/cli.js run --dry-run \
  --classification public \
  --motion "Choose an authentication architecture"

# Record the chair's ruling on an executed run, and the resolution that follows from it.
# A run never resolves itself; this is the only path from deliberation to a decision.
bun --no-install dist/cli.js adjudicate \
  --records-root ~/.claude/council \
  --run-id run-abc123 \
  --decision "Adopt the append-only record store." \
  --rationale "Three families agreed on durability; the cost objection was noted and accepted." \
  --authorised-by "council-chair" \
  --dissent-acknowledged

# Customer work: every seat on a metered key, nothing on a personal subscription
bun --no-install dist/cli.js council \
  --classification internal \
  --billing api-only \
  --motion "Which integration boundary should this client service expose?"

# A room for divergence: twelve cheap seats, one lens each, grouped but never ranked
bun --no-install dist/cli.js ideate \
  --records-root ~/.claude/council \
  --caller human --harness "Claude Code" \
  --seats 12 --ideas-per-seat 3 \
  --motion "Ways to make advisor notes visible without interrupting flow"

# Go deeper inside the groups you picked; only their ideas are shown to the seats
bun --no-install dist/cli.js ideate \
  --records-root ~/.claude/council \
  --session id-2026-09-15-3f9a1c --expand k-2,k-5

# Live route diagnostics
bun --no-install dist/cli.js doctor --json

# Secret-free route baseline
bun --no-install dist/cli.js health --json
```

The plugin slash commands are `/convene:council`, `/convene:second-opinion`, `/convene:ask`, `/convene:advise`, `/convene:ideate`, `/convene:forum`, `/convene:triage`, `/convene:status` and `/convene:result`. The compatibility `/ask --debate` path maps to `council`; ordinary `/ask` maps to `second-opinion`.

Every execution is explicit. Command Markdown invokes `bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js`; it does not contain provider logic.

### Triage

`triage` sorts a batch of items against a declared schema and returns a route for each one. It
never takes the route: the calling agent does.

```bash
# One seat, the built-in pr-comment schema
bun --no-install dist/cli.js triage \
  --records-root ~/.claude/council --caller agent --harness claude-code \
  --in comments.json

# Two seats for a disagreement check, four items in flight at a time
bun --no-install dist/cli.js triage \
  --records-root ~/.claude/council --caller agent --harness claude-code \
  --schema pr-comment --in comments.json \
  --seats 2 --providers anthropic,openai --concurrency 4 --json

# A schema of your own
bun --no-install dist/cli.js triage \
  --records-root ~/.claude/council --schema-file schemas/issue.json --in issues.json
```

`--in` points at a JSON array of items, each `{ "id": string, "text": string }`, ids unique, at
most 500 to a batch:

```json
[
  { "id": "c1", "text": "This dereferences a null pointer when the list is empty." },
  { "id": "c2", "text": "Nit: trailing whitespace." }
]
```

The built-in `pr-comment` schema declares:

| Field        | Terms                                                   |
| ------------ | ------------------------------------------------------- |
| `classes`    | `bug`, `style`, `question`, `nit`, `praise`, `security` |
| `severities` | `low`, `medium`, `high`                                 |
| `routes`     | `fix`, `discuss`, `ignore`, `human`                     |

`--schema-file` takes the same JSON shape — `{ "name", "classes", "severities", "routes" }`, every
list non-empty, unique and lower-case — and `human` is appended to its routes when absent, because
a disagreement has to have somewhere to go.

Each item is sorted on its own text alone, by one seat by default or two under `--seats 2` (which
needs two provider families; `--providers` sets the order they are taken in). Two seats that agree
on class and route route there; two that disagree route to `human` with `agreed: false`, and both
verdicts stay in the output — a disagreement is never averaged. `agreed` says only that no valid
verdict contradicted another, not that two seats concurred: with one seat, agreement is trivial.
An item nobody could read is listed in `unprocessed` with its reason — `policy` when the secrets
guard blocked its text, `no-seat` when no subscription seat was available, `no-verdict` for an
item with no valid verdict — and is never routed.

Triage never falls back to a metered key: `--billing api-only` is refused, a family whose only
route is metered is never given a seat, and a seat a fallback would have rescued is recorded as
skipped. `--concurrency` bounds how many items are in flight (default 4, at most 8) and
`--timeout-ms` bounds each item. The routed batch is appended to
`<records-root>/general/modes/triage/<session>.jsonl`, one event per item carrying every seat's
verdict or failure including the raw text of an answer that did not validate, and committed before
the run reports success.

### Result envelope

Every executed run returns a validated `ResultEnvelope`, printed alongside the command's own
result and embedded in the session record: the mode, the session, the declared `caller`
(`--caller human|agent`, with `--harness` and `--purpose`; omitted, the envelope reports
`caller-undeclared` in `degraded`), the execution pattern and rounds, one entry per seat with its
verified identity and answering transport, the mode's own `output` block, synthesis and dissent,
a unanimity flag, `spend`, `degraded` reasons and the `record` location — including whether it was
committed and where its minutes file, if any, landed. `ResultEnvelopeSchema` in
`src/substrate/envelope.ts` is the field reference; the example under "The result envelope" in
`docs/modes.md` is illustrative rather than exhaustive. Run `modes` to list the registered modes
and their knobs.

A run that reaches the committee through an older front door is marked in `degraded` as well:
`run` adds `legacy-run-alias`, and a significant `second-opinion` — `--impact high` or
`--contested`, which has always taken the committee's quorum and rounds — adds
`legacy-significant-second-opinion`.

## Advisor

`advise` runs the advisor mode from `docs/modes.md`: one subscription seat beside the working agent that reads a transcript window on a cadence, answers a question, or takes a bounded hold before a tool call in a named risk class. It speaks; the agent decides. It never reaches a metered key: an exhausted subscription or a down CLI is recorded as a `skipped` note with the reason. The transcript window is input only and never enters the record; the record is the session's note log, one JSONL file per harness session under `<records-root>/<scope>/modes/advisor/`, committed when the session ends.

```bash
# --session takes the harness's own session key; the kernel maps it to a log on first use.
bun --no-install dist/cli.js advise --records-root ~/.claude/council --caller agent --harness claude-code \
  --session claude:6a07f29b --hold --class destructive-git --tool "git push --force origin main" --window-ms 6000

# Every third call consults the seat; the others return a note skipped for cadence.
cat window.txt | bun --no-install dist/cli.js advise --records-root ~/.claude/council --caller agent --harness claude-code \
  --session claude:6a07f29b --watch --every 3 --transcript -

bun --no-install dist/cli.js advise --records-root ~/.claude/council --caller human --harness claude-code \
  --session manual-2026-09-15 --ask "Is there a simpler route than a migration here?"
bun --no-install dist/cli.js advise --records-root ~/.claude/council --session claude:6a07f29b --heed n-42 yes
bun --no-install dist/cli.js advise --records-root ~/.claude/council --session claude:6a07f29b --note --from omp "the native seat's note"
bun --no-install dist/cli.js advise --records-root ~/.claude/council --session claude:6a07f29b --status
bun --no-install dist/cli.js advise --records-root ~/.claude/council --session claude:6a07f29b --end
```

Verbs: `--start` (create a log and print its id), `--watch --every N --transcript -|<path>` (cadence; `--cadence-family` names a cheaper seat), `--hold --class <destructive-git|delete|deploy|payment|credential> --tool "<text>" [--window-ms N]` (default window 8000 ms; on timeout the note is `no-advice`), `--ask "<question>"`, `--note --from <harness> "<text>"`, `--heed <note-id> yes|no|unknown`, `--status`, `--end`. Every note carries `id`, `trigger`, `severity`, `text`, `refersTo`, `heeded`, `status` (`ok`, `skipped`, `no-advice`), `reason`, `seat` and `at`. `--end` reports `ended.closed`, which says this call appended the `ended` line rather than finding the log already closed; whether the record reached a commit is the envelope's own `record.committed`. Exit `0` for every verb that ran, whatever the note's status — a transcript window or tool call the outbound guard blocks is still exit `0`, with a `skipped` note whose reason names the policy. Exit `2` for a usage error and for anything that throws while the verb runs, such as a corrupt note log or an unreadable transcript. Exit `3` comes only from the preflight guard, over a `--motion` or a destination the project policy forbids, which no advisor verb needs. The risk class is chosen by the harness hook from its configuration, never inferred by the kernel.

**Off by default.** The harness hooks in dotagents enable themselves only when `CONVENE_ADVISOR=1` is set or a `.convene/advisor` file exists in the working directory. What each harness wires:

| Harness     | Hold before a tool call                                                            | Cadence                                              | Heed                 | Wired by                                                                               |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Claude Code | `PreToolUse` on `Bash`, note as `additionalContext`, always `allow`                | `Stop`, note as `additionalContext`                  | `PostToolUse`        | `~/.claude/scripts/convene-advisor-hook.ts` and `~/.claude/hooks/convene-advisor.json` |
| codex       | `[[hooks.PreToolUse]]`, same script and contract                                   | `[[hooks.Stop]]`                                     | `PostToolUse`        | the same script, registered in `~/.codex/config.toml`                                  |
| grok        | `[[hooks.PreToolUse]]`, `decision: "allow"`, note reaches the model after the call | recorded only (a Stop note would keep the turn open) | `PostToolUse`        | the same script with `--harness grok`, registered in `~/.grok/config.toml`             |
| omp, pi     | `tool_call` extension, never `block`, note as a steer message                      | `turn_end`, note queued for the next turn            | `tool_execution_end` | `agent/extensions/convene-advisor.ts`                                                  |
| agy         | none                                                                               | none                                                 | none                 | on demand only: `advise --ask`                                                         |

omp's native `advisor:` seat is not wired; `--note --from omp` is the contract for when it is.

## Ideation

`ideate` is a room for divergence. Many cheap seats, each holding one catalogue lens or a supplied
persona, answer the same prompt blind and in parallel; the engine groups what comes back and never
chooses. The selection is yours.

| Flag                        | Default                           | What it does                                                                                                                                                                                             |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--seats <n>`               | 12, or the number of lenses named | How many seats, 1 to 24.                                                                                                                                                                                 |
| `--lenses <a,b,c>`          | the governed catalogue, cycled    | Catalogue lens names (`security`, `operator`, `devils-advocate`, …). Naming more lenses than seats is an error; a room larger than the list cycles it, and the second time round a lens is `security-2`. |
| `--personas <file>`         | —                                 | A JSON array of `{ "name", "description" }` supplied with the call, used instead of lenses. Its text is checked by the outbound policy before it reaches a provider.                                     |
| `--ideas-per-seat <n>`      | 3                                 | How many ideas to ask each seat for, 1 to 10. A seat that returns more is generous, not wrong: the first `n` are kept.                                                                                   |
| `--models <family>=<model>` | the cheap model per family        | Pin a model for a family.                                                                                                                                                                                |
| `--expand <k-2,k-5>`        | —                                 | With `--session`, run another pass scoped to those clusters.                                                                                                                                             |

Seats are cheap by default. The model registry records no cost, only a primary and same-family
fallbacks, so `ideate` takes each family's first registered fallback where it lists one and its
primary otherwise, and it drops the dearer primary from the fallbacks so a substituted model fails
identity verification rather than billing quietly.

Spend is `capped` under `sub-first`. Reaching the cap exits `4` even though the run completed. The
default cap is not sized on seats or rounds, because the panel resolves seats only after this mode
has run and the CLI cannot know the seat count yet: it is sized from the eligible provider
families instead, one metered-fallback refusal per family, so a larger room or more lenses on the
same family does not raise it. `--spend-cap <n>` overrides it.

Every idea from every pass is kept, including the ones you did not pick. `ideate` needs a records
root for that reason and exits `2` without one; each pass appends a `pass` line and a `cluster`
line to `<records-root>/<scope>/modes/ideation/<session>.jsonl`, and the terminal record is
committed before the run reports success.

The clustering is the engine's own and is labelled as such. Ideas are lowercased, stripped of
punctuation and stopwords, compared by Jaccard over their token sets and grouped at 0.5 by
union-find; a cluster's label is the three commonest tokens across its ideas, or the idea's own
text when it stands alone. Nothing is scored, ranked or voted on by a model or by the engine: the
cluster order is simply the order in which each group's first idea arrived, and `raw` — every idea
id in arrival order — is always in the output, so a reader who distrusts the grouping can ignore
it entirely. Clusters keep their ids across passes wherever a group is still the best home for its
members, and a number retired by a merge is never issued again.

### Consultants

`consult` seats one consultant per named lens, briefs them all on the same material, and keeps the
session open for follow-up questions. `--lens` is comma-separated and repeatable; a name is either
a catalogue lens (`strategist`, `architect`, `designer`, `researcher`, `maintainer`, `operator`,
`security`, `privacy`, `systems`, `performance`, `critic`) or a persona supplied with
`--personas <file>`, a JSON array of `{ "name", "description" }`. Seats are spread over the
families in `--providers` order. `--context <path>` takes one file or directory per occurrence: a
directory contributes up to 40 text files, each up to 64 KiB, and everything it sends is rendered
as untrusted evidence and passed through the secrets guard before any consultant is briefed.

Every report names its lens and its seat. A named synthesiser seat then lists the conflicts
between the lenses and never resolves one — there is no field for a resolution, and a synthesiser
that recommends one produces an `invalid` seat whose raw answer stays on the record. A follow-up
(`--session <id> --ask <lens> "<question>"`) reaches exactly one consultant, carrying its own
earlier report and its own questions as quoted data; another consultant's report reaches it only
through `--forward <lens>`. There is no broadcast.

The session is an append-only JSONL log under the records root
(`<records-root>/<scope>/modes/consultants/<session-id>.jsonl`), committed before the run reports
success, and every command returns the whole session rebuilt from it. The spend cap covers the
session rather than the command: it defaults to one reserved metered fallback call per eligible
provider family, shared by the report round, the synthesiser and every follow-up, and a follow-up
past it returns its seat as `skipped` with reason `spend-cap`, exit 4 and `spend-cap-reached` in
`degraded`. Raise it with `--spend-cap <n>` on the follow-up. Like every mode, the cap bounds
metered fallbacks and nothing else: it does not bound `--billing api-only`, where a seat is
metered from the start and never reaches the ledger the cap governs.

## Forum

`forum` puts a motion to many seats over several rounds and records what happened. Round one is
blind: each seat answers with a position label of at most eight words, the argument for it and,
optionally, a motion to record. In every later round each seat sees every prior position from every
round, quoted as untrusted data and attributed to its seat and round, and may hold, revise or rebut.

```bash
bun --no-install dist/cli.js forum \
  --records-root ~/.claude/council \
  --seats 6 --rounds 3 \
  --lenses strategist,architect,security,critic \
  --motion "Should the advisor live in the harness or a sidecar?"
```

- `--seats <2-24>` seats are dealt round-robin over the selected families; `--rounds <1-6>` rounds.
- `--lenses <a,b,c>` names catalogue lenses (`self-check` lists them); the default is the catalogue
  in order. `--personas <file>` takes a JSON array of `{ "name", "description" }` instead. The two
  are mutually exclusive, and a list shorter than the seat count is dealt round and round, the
  repeats named `critic-2`, `critic-3`.
- Spend is `capped` under `sub-first`, defaulting to seats × rounds metered fallback calls. Reaching
  the cap stops the forum: the envelope reports the rounds actually run, `degraded` carries
  `spend-cap-reached` and `rounds-not-completed`, and the ledger's `closed` event names the reason.
- The output is `rounds` (every position, attributed), `map` (the final round's positions grouped by
  label, with their holders), `moved` (every seat whose label changed, with the round and the reason
  it gave) and `motions` (every motion raised, with its support and opposition). Nothing is scored,
  ranked or decided: `synthesis`, `dissent` and `unanimous` stay empty because the forum preserves
  every position rather than reducing them, and the output has no field for a winner or a decision.
- Records: the full ledger, one JSONL line per event at
  `<records-root>/<scope>/modes/forum/<session>.jsonl`, committed before the run reports success.

## Scope and project policy

General `public` motions use the built-in public-only policy. Any non-public general run or every project-scoped run needs an explicit policy. A project run without one exits before provider dispatch with `missing-project-policy`.

```json
{
  "projectId": "example-project",
  "classification": "internal",
  "allowedProviders": ["anthropic", "openai", "xai", "google"],
  "providerCeilings": {
    "anthropic": "internal",
    "openai": "internal",
    "xai": "internal",
    "google": "internal"
  },
  "createdAt": "2026-07-28T00:00:00.000Z",
  "updatedAt": "2026-07-28T00:00:00.000Z"
}
```

```bash
bun --no-install dist/cli.js council \
  --scope project \
  --project-id example-project \
  --project-policy ./council-policy.json \
  --classification internal \
  --motion "Review the private architecture"
```

The default command seat count is five and the standing `council` quorum remains four distinct families. An allowlist defines eligibility, not mandatory participation: preflight reports selected, eligible and omitted eligible families. Use `--providers anthropic,openai,xai,google,moonshot` to select an explicit roster. When only three families are available, `council --min-families 3` deliberately selects a weaker reduced quorum; the manifest, top-level result warning and persisted session record all carry the reduced-quorum warning. Values below three are rejected. The CLI never substitutes a different provider family under a failed seat.

## Provider routes

| Family    | Exact primary         | Same-family fallback    | Subscription transport   | Metered fallback            |
| --------- | --------------------- | ----------------------- | ------------------------ | --------------------------- |
| Anthropic | `claude-opus-5`       | none                    | isolated `claude` CLI    | `COUNCIL_ANTHROPIC_API_KEY` |
| OpenAI    | `gpt-5.6-sol`         | none                    | isolated `codex exec`    | `COUNCIL_OPENAI_API_KEY`    |
| xAI       | `grok-4.6`            | `grok-4.5`              | isolated `grok` CLI      | `COUNCIL_XAI_API_KEY`       |
| Google    | `gemini-3.1-pro-high` | `gemini-3.6-flash-high` | isolated Antigravity CLI | `COUNCIL_GEMINI_API_KEY`    |
| DeepSeek  | `deepseek-v4-pro`     | `deepseek-v4-flash`     | none                     | `COUNCIL_DEEPSEEK_API_KEY`  |
| Moonshot  | `kimi-k3`             | none                    | none                     | `COUNCIL_MOONSHOT_API_KEY`  |

A family's identity is the same on both paths, so quorum still counts one vote per vendor. The
credential decides who pays, not who spoke.

### Billing: subscription first, metered API as the fallback

Four families have two governed credential paths. The effective path is resolved from observable
facts at construction, and reported per seat by `doctor`, `health`, `self-check` and `version`:

1. A subscription transport available → use it. **This is the default**, because a subscription is
   already paid for and a metered key is not.
2. Otherwise the family's `COUNCIL_*_API_KEY` → HTTPS. The resolution reason says plainly that the
   call is billable.
3. Otherwise `unconfigured`, naming both options.

`--billing` selects the mode per run, and a project policy may pin one with a `billingMode` field.
Precedence is flag, then policy, then default:

| Mode        | Behaviour                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| `sub-first` | Default. Subscription, falling back to a metered key.                        |
| `api-only`  | Metered key only. For customer work: every call attributable and chargeable. |
| `sub-only`  | Subscription only. Guarantees a run cannot incur metered spend.              |

`api-only` and `sub-only` fail closed to `unconfigured` rather than crossing to the other path. A
billing mode that can be quietly overridden is not a control.

**`--spend-cap <n>` bounds metered fallback calls, and its scope follows the billing mode.**
Under `sub-first`, the cap governs metered fallback and defaults to `seats × rounds` — the
historical one metered retry per seat per round. Under `--billing api-only` every call is metered
by deliberate choice rather than fallback, so the cap does not apply, though `envelope.spend.used`
still reports the true metered count. Under `sub-only` no metered call is possible, so there is
nothing for a cap to refuse. A run that reaches the cap exits **4** even when its outcome is
`completed`: the envelope carries `spend-cap-reached` in `degraded` and `stoppedAtCap: true` in
`spend`, and the command result adds a top-level `spendWarning`. Exit `0` requires both a
`completed` outcome and an unreached cap.

**Mid-run fallback is bounded, and the boundary is a safety property.** Under `sub-first` a seat whose
subscription is quota-exhausted, unauthenticated or missing its executable retries once on the
metered path, and the response records `credentialFallback` so the substitution is visible in the
archive. It does **not** fall back on `identity-unverified`, `unsafe-tool-isolation`,
`invalid-structured-answer`, a model reroute, or any policy block: retrying an integrity failure down
a second billing path would let a misbehaving transport launder itself into a passing seat, which is
strictly worse than a missing vote. Transport faults are excluded too, because the runner already
retries those on the same seat more cheaply.

Switching requires no edit: install or remove the binary, add or remove the key.
`ModelRoute.transport` plus `alternateTransports` in the registry — not adapter code — governs which
transports a family may use, and the runner and health probe still reject anything outside that set.

The Grok parser requires the read-only `plan` permission mode, one consistent model and session
identity across the init, assistant and `modelUsage` frames, and no tool-use event anywhere in the
stream; anything else is `identity-unverified` or `unsafe-tool-isolation`.

One honest caveat, measured on `grok 1.0.4`: grok reads its OAuth credentials and its MCP/skill
configuration from the same `~/.grok` directory, so the HOME-isolation trick used for Antigravity
would strip the subscription auth along with the tool surface. A real session therefore advertises a
large capability set (83 built-in tools, 190 skills, 1 MCP server) that no flag can empty:
`--tools` with an impossible id removed only 3 entries, and there is no `--ignore-user-config`
equivalent. `--disallowed-tools` does genuinely shrink it (83 → 70) and is applied. The posture is
therefore **advertised capability tolerated, tool use rejected** — a weaker init-time guarantee than
the Codex and Antigravity adapters have. What still protects the seat is the required `plan` mode,
the read-only sandbox, the isolated working directory, the bound responding-model identity, and
rejection of every tool-use event.

### Credentials

All six credentials are `COUNCIL_`-prefixed: `COUNCIL_ANTHROPIC_API_KEY`,
`COUNCIL_OPENAI_API_KEY`, `COUNCIL_GEMINI_API_KEY`, `COUNCIL_XAI_API_KEY`,
`COUNCIL_DEEPSEEK_API_KEY` and `COUNCIL_MOONSHOT_API_KEY`. Bare vendor names are
ambient — any harness or SDK that loads the surrounding directory will claim and
spend them — so the launcher rejects them rather than accepting them quietly.
Export them in the launch environment, or let the maintained Claude facade load the
same names from the machine-local, untracked `~/.claude/council/providers.env`.

`COUNCIL_MINUTES_DIR` is optional and not a credential: when set, every terminal record is also
rendered as a Markdown minutes file there. See "Records and memory" in `docs/modes.md`.

A run that has written and committed its record never fails afterwards. A commit that cannot
happen — the records root is not a Git work tree, a record path resolves outside that work tree,
or `git` itself errors — adds `records-not-committed: <reason>` to the envelope's `degraded`
rather than failing the run; an unwritable `COUNCIL_MINUTES_DIR` adds `minutes-not-written:
<reason>` and leaves `record.minutes` as `null`. Both still report success. The commit runs `git`
with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` stripped from its
environment, so running from inside a Git hook cannot redirect it at a different repository, and
paths are compared after resolving symlinks so a symlinked records root is not mistaken for lying
outside its own work tree. `adjudicate` commits its ruling, resolution and ledger update the same
way, and reports `records: { committed, commitSha }` on success or `records: { committed: false,
reason }` otherwise.

**Setting one of the four subscription families' keys does not start spending it.**
Under the default `sub-first` mode the subscription CLI is preferred, and the key is
reached only when that subscription is exhausted, unauthenticated or absent. Use
`--billing api-only` when you want the metered path deliberately.

An unset credential disables only its own family. Failed, unavailable and
identity-unverified seats remain visible in the structured result. Cross-_provider_
fallback is prohibited: a family may change credential path, never identity.

### Adopting a new model without a release

Model routes are overridable per machine, so a newly released model does not need
a code change, a version bump or a plugin update:

```jsonc
// ~/.claude/council/models.json — or <records-root>/models.json, or --registry <path>
{ "xai": { "primary": "grok-5" } }
```

Overrides **merge per family**: supplying only `primary` preserves that family's
fallbacks and transports. An unknown family or route key fails closed naming the
file and the offending key, so a typo can never silently leave a stale model in
place. Precedence is `--registry <path>`, then `<records-root>/models.json`, then
`~/.claude/council/models.json`, then the built-in registry. See
`models.json.example`.

`council version --json` reports which engine is executing and where each route
came from — `executablePath`, `packageVersion`, `adapterContractVersion`, the
override path with its SHA-256, per-family provenance, and `installerProvenance`
(supplied by the installer, or `null` with a reason; the kernel never
self-attests a source commit). `doctor --json` embeds the same block, and every
run manifest records the registry provenance actually used.

## Evidence and data safety

- Scope and policy resolve before evidence collection.
- Repository and web material is untrusted evidence, never control instructions.
- One normalised evidence pack is supplied identically to every seat.
- High-confidence credentials, bearer tokens, private keys and session cookies hard-block before transmission.
- Claude, OpenAI, Google and xAI seats are tool-free or tool-restricted. Codex runs
  `--sandbox read-only --ephemeral` with ambient configuration, web, shell and browser access
  disabled. AGY runs in an ephemeral home and may read only its staged `council-prompt.txt`. Grok
  runs in the read-only `plan` permission mode with the mutating built-ins removed; it cannot be
  fully config-isolated without losing its subscription auth, so any tool-use event fails the seat
  closed instead. Malformed, additional or unowned tool events fail closed everywhere.
- Provider responses and diagnostics are redacted before output or persistence.
- Ordinary quorum requires three distinct verified provider families. Significant quorum defaults to four, including the explicitly categorised contrarian seat, plus at least three verified rebuttals. `council --min-families 3` is the only explicit reduction: it preserves the contrarian requirement and marks the run as weaker than the standing default throughout its manifest, output and session record.
- At explicit three-seat coverage, lens precedence is domain, risk and contrarian. Maintainer coverage yields; conditional systems coverage also yields when relevant. Four-or-more-seat selection is unchanged.
- Results below the selected quorum remain `degraded` at the two-family ordinary or three-family significant usability floor; lower results are `blocked-quorum`.

Project and general records are physically separate beneath a configured records root. Session, chair-acceptance and resolution files are schema-validated, atomically published and protected by scoped filesystem locks. Persisted protocol metadata includes rounds, quorum and any refinement trigger. Retries require unchanged canonical motion text, seat-to-lens assignments and execution protocol, while distinct motions rotate assignments. At most one resolution may be appended per motion. A degraded session requires a matching append-only chair acceptance before resolution; `blocked-quorum` can never resolve. Mixed general history is migrated only from a hash-matched plan carrying explicit approval.

## Development

```bash
bun run check
bun test tests/containment-loader.test.ts # requires the Claude CLI
```

`bun run check` runs the complete deterministic suite. Live provider smoke is separate because credentials and paid routes are optional.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for trust boundaries and module ownership.

## Licence

MIT. See `LICENSE`.
