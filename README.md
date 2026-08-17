# Claude Council

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
claude plugin marketplace add /path/to/claude-council --scope user
claude plugin install claude-council@annascookies-plugins --scope user
claude plugin validate /path/to/claude-council
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
  --motion "Compare JSON and SQLite for a local decision log"

# Significant, multi-round council with contrarian quorum
bun --no-install dist/cli.js council \
  --classification public \
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

# Live route diagnostics
bun --no-install dist/cli.js doctor --json

# Secret-free route baseline
bun --no-install dist/cli.js health --json
```

The plugin slash commands are `/claude-council:council`, `/claude-council:second-opinion`, `/claude-council:ask`, `/claude-council:status` and `/claude-council:result`. The compatibility `/ask --debate` path maps to `council`; ordinary `/ask` maps to `second-opinion`.

Every execution is explicit. Command Markdown invokes `bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js`; it does not contain provider logic.

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

| Family    | Exact primary         | Same-family fallback    | Transport                       | Credential                            |
| --------- | --------------------- | ----------------------- | ------------------------------- | ------------------------------------- |
| Anthropic | `claude-opus-5`       | none                    | isolated Claude CLI             | local Claude subscription             |
| OpenAI    | `gpt-5.6-sol`         | none                    | isolated `codex exec`           | local OpenAI subscription             |
| xAI       | `grok-4.6`            | `grok-4.5`              | isolated `grok` CLI, else HTTPS | xAI subscription **or** `XAI_API_KEY` |
| Google    | `gemini-3.1-pro-high` | `gemini-3.6-flash-high` | isolated Antigravity CLI        | local Google subscription             |
| DeepSeek  | `deepseek-v4-pro`     | `deepseek-v4-flash`     | HTTPS                           | `DEEPSEEK_API_KEY`                    |
| Moonshot  | `kimi-k3`             | none                    | HTTPS                           | `MOONSHOT_API_KEY`                    |

### xAI: subscription first, metered API as the fallback

xAI is the one family with two governed transports. The effective transport is resolved from
observable facts and reported in `doctor` and `self-check`:

1. A `grok` binary resolvable on `PATH` → isolated subscription CLI, using that subscription's
   OAuth session and no API key. **This is the default**, because a subscription is already paid
   for and a metered key is not.
2. Otherwise `XAI_API_KEY` present → HTTPS. The resolution reason says plainly that the call is
   billable.
3. Otherwise `unconfigured`, naming both options.

There is currently **no CLI flag** to force the metered path; the preference is a programmatic
adapter option only (`src/providers/index.ts:34`). Deliberate per-run selection arrives with the
`--billing` mode described in the roadmap below.

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

Anthropic, OpenAI and Google use authenticated local subscription CLIs and never
read `OPENAI_API_KEY` or `GEMINI_API_KEY`; a missing executable disables that
seat rather than changing transport. The HTTPS keys are `XAI_API_KEY`,
`DEEPSEEK_API_KEY` and `MOONSHOT_API_KEY`. Export them in the launch
environment, or let the maintained Claude facade load the same names from the
machine-local, untracked `~/.claude/council/providers.env`. An unset credential
disables only its own family. Failed, unavailable and identity-unverified seats
remain visible in the structured result. Cross-provider fallback is prohibited.

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

## Attribution

This is the maintained `AnnasCookies/claude-council` fork of [hex/claude-council](https://github.com/hex/claude-council). The upstream MIT licence and notices are retained.
