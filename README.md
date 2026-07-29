# Claude Council

An explicit standing multi-model council for consequential or contested decisions. The plugin runs independent, tool-free provider seats through one Bun/TypeScript core, applies fail-closed outbound policy before transmission, records exact provider/model identity and preserves quorum failure rather than manufacturing consensus.

No hook starts a council automatically.

## Requirements

- Bun 1.3.14 or later
- Claude Code for the `anthropic` seat (`claude` must resolve to a trusted absolute executable)
- OMP for the `openai` seat, authenticated in the governed `claude-council` profile
- Antigravity CLI (`agy`) for the optional `google` seat
- Optional HTTP credentials from `.env.example`

The prebuilt `dist/cli.js` bundle is the only runtime entry point. Cached installs require neither `node_modules` nor automatic package installation.

## Install from this repository

```bash
claude plugin marketplace add /path/to/claude-council --scope user
claude plugin install claude-council@hex-plugins --scope user
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

The default command seat count is five. An allowlist defines eligibility, not mandatory participation: preflight reports selected, eligible and omitted eligible families. Use `--providers anthropic,openai,xai,google,moonshot` to select an explicit roster. The CLI never substitutes a different provider family under a failed seat.

## Provider routes

| Family    | Exact primary         | Same-family fallback    | Transport                | Credential                |
| --------- | --------------------- | ----------------------- | ------------------------ | ------------------------- |
| Anthropic | `claude-opus-5`       | none                    | isolated Claude CLI      | local Claude subscription |
| OpenAI    | `gpt-5.6-sol`         | none                    | isolated OMP CLI         | local OpenAI subscription |
| xAI       | `grok-4.5`            | none                    | HTTPS                    | `XAI_API_KEY`             |
| Google    | `gemini-3.1-pro-high` | `gemini-3.6-flash-high` | isolated Antigravity CLI | local Google subscription |
| DeepSeek  | `deepseek-v4-pro`     | `deepseek-v4-flash`     | HTTPS                    | `DEEPSEEK_API_KEY`        |
| Moonshot  | `kimi-k3`             | none                    | HTTPS                    | `MOONSHOT_API_KEY`        |

OpenAI requires a dedicated OMP profile at
`~/.omp/profiles/claude-council/agent/config.yml`:

```yaml
setupVersion: 1
advisor:
  enabled: false
prewalk:
  enabled: false
autolearn:
  enabled: false
```

Launch `omp --profile claude-council`, run `/login`, and select
`ChatGPT Plus/Pro (Codex Subscription)` once. The council additionally applies
a one-shot overlay that disables the advisor, prewalk and every external
configuration discovery provider; an absent profile is reported as
`unconfigured`.

OpenAI and Google never read `OPENAI_API_KEY` or `GEMINI_API_KEY`; missing
subscription executables disable those seats rather than changing transport.
The remaining HTTPS keys are `XAI_API_KEY`, `DEEPSEEK_API_KEY` and
`MOONSHOT_API_KEY`. Export them in the launch environment. The maintained
Claude facade loads the same names from the machine-local, untracked
`~/.claude/council/providers.env` file. An unset credential disables only its
HTTP family. Failed, unavailable and identity-unverified seats remain visible
in the structured result. Cross-provider fallback is prohibited.

## Evidence and data safety

- Scope and policy resolve before evidence collection.
- Repository and web material is untrusted evidence, never control instructions.
- One normalised evidence pack is supplied identically to every seat.
- High-confidence credentials, bearer tokens, private keys and session cookies hard-block before transmission.
- Claude and OpenAI seats are tool-free. OpenAI also runs in a dedicated OMP
  profile with all ambient configuration discovery disabled. AGY runs in an
  ephemeral home and may read only its staged `council-prompt.txt`; malformed,
  additional or unowned tool events fail closed.
- Provider responses and diagnostics are redacted before output or persistence.
- Ordinary quorum requires three distinct verified provider families. Significant quorum requires four, including the explicitly categorised contrarian seat, plus at least three verified rebuttals.
- Results below normal quorum remain `degraded` at the two-family ordinary or three-family significant usability floor; lower results are `blocked-quorum`.

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
