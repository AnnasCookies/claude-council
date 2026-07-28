# Feasibility — Public Standing Council Kernel

**Assessment date:** 2026-07-27  
**Verdict:** Feasible with staged cutover and explicit external/runtime limitations.

## Repository and ownership

The starting checkout was `hex/claude-council`, where the authenticated GitHub account had read-only permission. That was a release blocker, not an implementation detail.

Resolved before Forge initialisation:

- created the owned fork `https://github.com/AnnasCookies/claude-council`;
- configured `origin` as the owned fork;
- configured `upstream` as `https://github.com/hex/claude-council`;
- retained the upstream MIT licence and required attribution in the specification.

The first public stage must update package/plugin author, repository, homepage and marketplace ownership before publication. The release candidate must use a version distinct from upstream `2026.7.9` and report its immutable source commit.

## Baseline

Observed in the isolated worktree:

- `claude plugin validate C:/tmp/forge-standing-council-public` exits successfully.
- The current repository is a functional legacy Bash plugin with no `src/` TypeScript core or `dist/cli.js`.
- `tests/run_tests.sh` is the canonical Bats gate used by Linux/macOS CI and the existing release script.
- Native Windows lacks an installed WSL distribution and Docker. A temporary Bats checkout under Git Bash cannot run the suite correctly because path handling passes Windows library paths to Bats. This is an environment limitation, not product evidence.

Resolution: keep Bats/ShellCheck in a POSIX-only `check:legacy` gate until the Bash engine is removed. The new `bun run check` is cross-platform. Windows CI verifies TypeScript/core tests and executes the committed bundle; one designated build platform performs byte reproducibility.

## Current architecture and stage seams

The current public engine is concentrated in:

- `commands/ask.md` — user-facing provider/async routing;
- `scripts/query-council.sh` — prompt assembly, provider fan-out, fallback and JSON output;
- `scripts/lib/providers.sh` and `scripts/lib/model_fallback.sh` — discovery and legacy identity/fallback policy;
- `scripts/run-council.sh` and `scripts/lib/jobs.sh` — asynchronous job/cancellation state;
- `scripts/check-status.sh` — ad hoc health probing;
- `hooks/hooks.json` and `scripts/stop-review-gate.sh` — automatic Stop-hook path;
- skill/command facades and shell-era documentation.

The new core is absent, so implementation can use clean `src/` ownership. The chosen stage order is backward-only:

1. **Public Containment** — remove Stop-hook auto-execution, automatic raw context transmission and the real cancellation overwrite path while retaining the legacy bridge.
2. **Domain and Policy Foundation** — strict schemas, classification, model registry, secret/data policy, stable identity, atomic records and lens allocation.
3. **Provider Runtime** — HTTP/CLI primitives, behavioural tool-isolation capability, exact/unverified model identity, providers, rounds, evidence and quorum.
4. **Facades and Release Candidate** — health, doctor, self-check, bundle, commands/skills, package metadata and immutable build identity.
5. **Legacy Removal and Acceptance** — requires observed private-host parity before deleting the bridge; then complete cross-platform/package/security acceptance.

Shared files and exports make these stages serial. Provider adapters may be disjoint only after the adapter interface and registry are frozen in stage 3 planning.

## Security and data feasibility

Current high-confidence defects:

- the Stop hook reads repository-controlled configuration and can send `git diff HEAD` externally;
- `commands/ask.md` auto-discovers file context and the shell engine persists full prompts/transcripts in cleartext;
- CLI/API shadow fallback can execute a different provider route under the original slot;
- agentic CLI providers rely on prompts/sandbox assumptions rather than proven tool denial;
- asynchronous cancellation can be overwritten by an unconditional worker completion write.

The specification corrects these at source:

- no repository-controlled execution or policy enablement;
- full assembled-payload classification and secret scan before external calls;
- no cross-family fallback;
- behavioural tool-denial capability required for CLI voting seats;
- exact requested identity plus observed actual identity or `identity-unverified`;
- immutable first-terminal-state semantics tested through the real subprocess path;
- per-route alias, transport, response-identity, retention/storage and timeout/cancellation metadata, with stateless requests and provider-side storage disabled where supported;
- no durable async jobs API in the new release.

## Provider and model feasibility

Official documentation checked on 2026-07-27 supports all six planned families, subject to route-specific metadata and runtime proof:

- Anthropic documents `claude-opus-5` and `claude-fable-5` over `POST /v1/messages`, with response `model`, request timeout and abort signal.
- OpenAI documents `gpt-5.6-sol` plus `terra`/`luna` and the `gpt-5.6` alias over Responses; provider cancellation applies only to background responses, so this synchronous design uses request abort/deadline rather than a durable response job.
- xAI documents `grok-4.5` and the Responses API, but stateful responses are stored for 30 days by default. The adapter must explicitly disable storage and cannot carry prior-response IDs.
- Google documents stable `gemini-3.6-flash`, preview-model caveats, `responseId`/`modelVersion` and millisecond timeout. Its abort signal is client-only and does not cancel service-side work.
- DeepSeek documents `deepseek-v4-pro`/`deepseek-v4-flash` over OpenAI-style chat completions. Provider-native cancellation was not found in the checked pages, so acceptance relies on client abort/deadline.
- Moonshot documents `kimi-k3` as the current flagship over its OpenAI-compatible chat API; older K2 aliases are deprecated or discontinued.

Sources: [Anthropic models](https://platform.claude.com/docs/en/about-claude/models/overview), [OpenAI latest model](https://developers.openai.com/api/docs/guides/latest-model), [xAI models](https://docs.x.ai/developers/models), [xAI text generation and retention](https://docs.x.ai/developers/model-capabilities/text/generate-text), [Gemini models](https://ai.google.dev/gemini-api/docs/models), [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion), [Kimi models](https://platform.kimi.ai/docs/models).

The registry therefore needs per-model selector, alias policy, transport family, response-identity fields, provider-side storage control and timeout/cancellation semantics. Anthropic and Gemini need native adapters. OpenAI, xAI, DeepSeek and Moonshot can share an OpenAI-compatible transport core only where their payload and storage differences remain explicit. Missing live credentials do not block release: deterministic fake transports own adapter acceptance, and live claims are made only for observed routes. A selector absent from an official catalogue or live structured listing is unavailable rather than guessed; unverified actual identity forces a degraded result.

## Packaging feasibility

A single Bun bundle is feasible. Registries and lens catalogues are import-bundled; only an explicit user-level override is a runtime filesystem read. The package pins Bun `1.3.14`, marks `dist/cli.js -text`, commits the generated bundle, and performs offline `--no-install --no-env-file` self-checks from a clean plugin cache.

The private host must bind its cutover to the release-candidate version and source commit. Installing from the original main checkout or accepting a stale cache is prohibited.

## Acceptance and observability

Deterministic tests can cover every domain, policy, transport, run-state and package contract. Live provider smoke is environment-dependent and is supplementary. A four-family significant motion is not an unconditional release gate when credentials are absent; the observable requirement is honest `completed`, `degraded` or `blocked-quorum` behaviour.

Manual/external evidence remains required for:

- private host parity against the exact release-candidate build before legacy deletion;
- available-route live smoke claims;
- Windows and Linux installed-cache execution where the current machine cannot supply both environments.

## Known limitations and stage blockers

- Stage 3 must validate current official model selectors and CLI isolation behaviour before enabling each route.
- Stage 5 must remain blocked until the private Forge pipeline records parity against the exact public version/commit.
- Cross-platform process-tree evidence needs CI or a second machine; native Windows alone cannot prove Linux behaviour.
- This pipeline does not provision paid provider credentials.

No unresolved issue prevents stage 1 from starting.
