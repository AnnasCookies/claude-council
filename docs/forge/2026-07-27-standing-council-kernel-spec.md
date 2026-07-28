# Standing Council Kernel — Public Specification

**Date:** 2026-07-27  
**Status:** Approved for Forge execution  
**Repository:** `claude-council`

## Purpose

Deliver a reusable standing-council engine rather than another thin multi-model fan-out wrapper. The engine must combine independent provider families, motion-specific analytical lenses, chaired rounds, evidence brokering, fail-closed data policy, honest quorum and durable audit records while remaining safe to install as a public Claude Code or OMP plugin.

This repository is the owned fork `AnnasCookies/claude-council`; `hex/claude-council` remains the read-only upstream. The fork retains the upstream MIT licence and adds explicit attribution while changing package author, repository, homepage and marketplace ownership to the maintained fork. `origin` must resolve to the owned fork and `upstream` to the original before any public commit or push.

## Users

- A developer requesting a one-shot second opinion.
- A chair convening a multi-round standing council.
- A host adapter integrating council execution and private record policy.
- A maintainer adding a provider adapter, lens or evidence parser.

## Goals

1. Replace implicit Bash orchestration with strict Bun/TypeScript domain and execution contracts.
2. Keep provider identity independent from analytical role.
3. Enforce tool-free provider seats and fail-closed outbound-data policy in code.
4. Support ordinary one-shot and significant multi-round motions with honest quorum.
5. Preserve exact requested and actual provider/model/role identity in results.
6. Persist generic append-only records under explicit general or stable project scope.
7. Diagnose model and route drift without silently changing production routing.
8. Ship a deterministic, self-contained Bun bundle usable from clean plugin caches on Windows and Linux.
9. Remove unsafe repository-controlled auto-execution and the superseded Bash engine after parity.
10. Publish every release candidate under a new version and immutable source commit so host adapters cannot accept a stale cache.

## Non-goals

- No autonomous always-on council, Stop-hook review gate or repository-triggered external transmission.
- No provider seat may browse the host, run arbitrary shell, call MCPs, edit files or inspect the filesystem.
- No provider-side web search for arbitrary motions.
- No automatic model-successor adoption.
- No same-provider model duplication merely to inflate quorum.
- No private user records, identities, project names, credentials, charters or ledgers in this repository.
- No destructive migration of an existing record archive.
- No Node.js runtime or runtime package installation.
- No durable asynchronous `jobs`, `result` or `cancel` API in this release; cancellation applies to the live process, not a cross-invocation job store.

## Product surface

The public package exposes one compiled entry, `dist/cli.js`, with commands:

- `self-check --json` — offline validation of import-bundled schemas and registries plus package version and source commit;
- `doctor --json` — live provider and route diagnostics;
- `health --json` — structured baseline-compatible health results;
- `second-opinion` — one-round independent analysis;
- `council` — chaired multi-round execution;
- `migrate-general plan|apply` — append-preserving record migration support.

Claude Code commands and OMP-compatible skills are thin facades over this entry. They do not duplicate provider execution logic.

## Architecture

```text
validated motion
    |
    v
classification + provider policy + secret scan
    |
    +--> blocked-policy
    |
    v
motion-specific lenses + provider routes
    |
    v
optional sanitised evidence pack
    |
    v
round runner (blind analysis -> rebuttal -> optional resolution)
    |
    v
quorum and degraded-result gate
    |
    v
structured result + append-only generic record
```

### Layers

1. **Domain** — schemas, motion identity, scope, classification, lenses, routes, response and run state.
2. **Policy** — secret detection, provider ceilings, provider allowlists and outbound disclosure.
3. **Records** — stable project identity, atomic append-only writes and migration planning/application.
4. **Execution** — bounded HTTP and CLI primitives, provider adapters, round runner, quorum and cancellation.
5. **Evidence** — source-manifest schema, deterministic parser normalisation and sanitised evidence packs.
6. **Health** — offline self-check, live doctor and regression-aware route baseline.
7. **Facades** — CLI, Claude Code commands and OMP skill instructions.

Dependency direction is inward: facades depend on the core; domain and policy never import host-specific skill content.

## Core contracts

The implementation must expose schema-validated equivalents of:

- `DataClassification`: `public | internal | confidential | restricted`;
- `CouncilScope`: `general | project`;
- `ProjectPolicy`: stable project identity, classification, allowed providers and optional provider ceilings;
- `ModelRoute`: provider family, primary selector, ordered same-family fallbacks, alias policy, transport family, response-identity fields, provider-side storage control and timeout/cancellation semantics;
- `RoleLens`: category, name, prompt and applicability metadata;
- `RunManifest`: motion ID, scope, classification, selected routes/lenses, rounds, quorum policy and evidence references;
- `SeatResponse`: seat ID, provider family, requested model, optional actual model, `modelIdentity: verified | unverified`, role, status, timing and structured answer/error;
- `RunState`: immutable in-process transitions from `queued` through one terminal state; no durable job-store semantics;
- `CouncilRecord`: input hash, policy decision, disclosed destinations, evidence manifest, per-round responses, quorum, degradation and chair result.

Every external or persisted boundary is parsed with Zod. Type assertions are not boundary validation.

## Classification and fail-closed routing

Ordering is `public < internal < confidential < restricted`.

Each run requires an explicit effective classification. Project runs require an applicable project policy. Missing or malformed policy produces `blocked-policy`; it never defaults to public.

The complete outbound payload is scanned after lenses, evidence and prior-round responses are assembled. High-confidence secrets always block. `restricted` always blocks external transmission. Provider ceilings and allowlists are enforced per route; an allowlisted route with no configured ceiling fails closed. An unavailable or disallowed provider is an absent seat; it is never replaced by a different family under the original identity.

A permitted one-run policy override records reason, authorising source, affected providers, classification, destinations and timestamp. It cannot override secret detection, `restricted`, missing project identity or unknown classification.

Before external requests, facades disclose classification, provider families/endpoints, evidence inclusion and redaction/blocking status.

## Tool-free seats and evidence boundary

Provider seats receive only:

- the motion and relevant context;
- one validated role lens;
- a source-cited sanitised evidence pack when supplied;
- normalised prior-round responses in later rounds;
- a structured response schema.

Seats receive no tools, paths, arbitrary file contents, environment variables or credentials.

Research is a separate, non-voting host capability. The core accepts only evidence packs containing parser version, sources, content hashes, extraction metadata and sanitised excerpts. It never grants research tools to seats.

## Provider and model registry

The import-bundled registry includes independent families for Anthropic, OpenAI, xAI and Google, with optional DeepSeek and Moonshot routes when configured. Initial approved selectors are maintained as schema-validated data, not hard-coded orchestration branches. Exact availability is verified by structured provider catalogues or CLI output where supported.

Registry invariants:

- exact selectors are preferred over rolling aliases;
- fallbacks stay within one provider family;
- requested identity is always returned, while actual identity is returned only when observed;
- an unobservable actual model is represented as `modelIdentity: unverified`, never copied from the request;
- an identity-unverified seat does not establish voting diversity and contributes to a `degraded` or `blocked-quorum` outcome when the verified-family floor is missed;
- fallback use is explicit;
- successor discovery warns but never mutates routing;
- user overrides are parsed, merged and reparsed;
- missing credentials disable a route without exposing credential values.

Same-provider multi-model comparison is capability-specific evidence, never an independent-family quorum vote unless explicitly marked non-voting. DeepSeek and Moonshot release acceptance is deterministic against fake transports; live-route claims are optional and made only when credentials and observed route evidence exist.

## Dynamic role lenses

Provider family and role are separate axes. Every motion selects only relevant lenses from:

- domain expert;
- maintainer;
- risk;
- systems;
- contrarian;
- chair synthesis, which is never a seat vote.

The selected set must include domain, maintainability, failure/risk and counter-position coverage. Significant motions additionally require a contrarian response. Assignment is a deterministic permutation derived from the motion ID and persisted prior assignments. A role stays fixed across retries of one motion and rotates between motions. Missing or duplicate mandatory lenses fail before provider calls.

## Round protocol

### Ordinary second opinion

- One blind round.
- At least three successful distinct provider families.
- Structured recommendation, evidence, assumptions, risks, uncertainty and decisive test.

### Significant standing-council motion

- Round one is blind independent analysis.
- Round two supplies the same evidence pack and normalised round-one responses for rebuttal.
- Round three is optional, capped and allowed only when a material disagreement plus a specific resolving question remain.
- The blind analysis round must contain at least four successful distinct provider families and a successful contrarian lens; at least three verified round-two rebuttals are separately required for normal resolution. An optional refinement neither repairs blind-round quorum nor raises the rebuttal threshold.

The chair is the host session agent. It frames the motion, approves evidence, opens rounds and adjudicates. It does not vote and its synthesis cannot convert failed quorum into consensus.

## Quorum and degraded operation

Results distinguish:

- `completed` — required quorum, identity and round obligations met;
- `degraded` — the minimum usable provider-family floor is met but a required route, verified model identity, lens or round failed; a separate persisted chair-acceptance record is required before a degraded resolution may be appended;
- `blocked-policy` — data/provider policy forbids execution;
- `blocked-quorum` — even the minimum usable independent-family floor cannot be met and cannot be accepted as a resolution;
- `cancelled`, `timed-out` and `failed` — terminal execution states.

The result statuses listed above are terminal; only `queued -> running -> <result>` transitions. A degraded run remains `degraded`; acceptance does not rewrite it to `completed`. The record store accepts normal completed resolutions and explicitly accepted degraded resolutions, but never `blocked-quorum`. No success path may relabel fallback, missing identity, timeout or malformed output as a healthy original seat.

The minimum usable independent-family floor is two for an ordinary motion and three for a significant motion. Falling below that floor is `blocked-quorum`; meeting the floor while missing any normal quorum, identity, lens or round obligation is `degraded`.

## Execution and failure semantics

### HTTP

- Use abort signals and hard deadlines.
- Retry only transient network errors, eligible 429 and eligible 5xx responses with bounded backoff and jitter.
- Honour safe retry hints.
- Never retry authentication, policy, schema, model-missing or timeout failures automatically.
- Bound response size before parsing.
- Keep every request stateless: do not send prior-response identifiers, and explicitly disable provider-side request/response storage where the transport supports it.
- A route whose retention/storage semantics cannot satisfy the applicable data and provider policy is unavailable before any request is sent.

### CLI

- Resolve trusted executables explicitly and spawn with argument arrays.
- Keep prompts off the process argument list; use stdin or a protected temporary file.
- Tool isolation is a capability, not an assumed flag string: record accepted help/exit behaviour and a tool-use denial probe for each CLI backend.
- If tool-free behaviour cannot be proven on the target runtime, that CLI route is unavailable.
- Cancellation and timeout terminate the complete process tree and await exit.
- A timeout can never be overwritten by a later normal-exit handler.

### Run state

Only these terminal transitions are valid:

```text
queued -> running -> completed | degraded | failed | timed-out | cancelled | blocked-policy | blocked-quorum
```

The first terminal state wins. Run-state transitions are immutable and covered by real subprocess race tests. `queued` is the bounded pre-spawn state of the current invocation; it does not imply a durable background job.

## Records and migration API

Generic records are append-only and scoped to either `general` or a stable project identifier derived from canonical repository identity. Human display names are metadata, not storage keys.

Record writes use temporary file, flush where supported, atomic rename and post-write parse/hash verification. Duplicate run/session and resolution IDs are rejected. A motion ID may recur under distinct run IDs only when its canonical motion text and seat-to-lens assignments are unchanged, and at most one resolution may exist for that motion. Session records include policy and destination decisions but never credential values.

`migrate-general plan` accepts caller-supplied project taxonomy and match rules, performs generic classification without writes, and emits proposed destinations plus a mandatory unresolved bucket. The public package contains no private taxonomy. `apply` requires an approved plan hash and authorisation metadata, writes an immutable archive first, appends new records atomically, verifies counts and hashes, and never deletes the source archive.

## Health and model drift

`self-check --json` is offline and validates the import-bundled registry, import-bundled lens catalogue, schemas, package version and immutable source commit.

`doctor --json` reports route configuration, executable/endpoint resolution, requested model, actual model where observable, tool-isolation support, latency, error category and candidate successor warnings. It does not log secrets.

Scheduled health records provider family, route, requested/actual model, status, latency and error category. Regression comparison uses last-known-good identity and route, so an unintended downgrade cannot report healthy merely because some answer arrived.

## Public plugin safety

1. Repository content cannot start council execution or authorise outbound requests.
2. There is no automatic Stop hook or repository-controlled enablement path.
3. Repository configuration cannot weaken user-level policy.
4. Untrusted numeric or enum configuration is schema-validated before use.
5. Shell interpolation is not used for provider or lifecycle values.
6. The package and logs contain no secrets or private records.
7. Provider seats are tool-free by construction.
8. Prompt text cannot enable tools, change data classification or alter routing policy.

## Packaging

- Bun `1.3.14` exactly in release CI and package metadata; TypeScript strict mode.
- `bun build src/cli.ts --target=bun --outfile dist/cli.js` produces the committed release entry.
- Runtime dependencies, the model registry and the lens catalogue are imported into the bundle; only an explicit user-level override is read from the filesystem.
- `.gitattributes` marks `dist/cli.js -text`.
- Installed plugin caches need no `node_modules`, global package cache or network package resolution.
- Offline verification runs `bun --no-install --no-env-file dist/cli.js self-check --json` with networking unavailable.
- `doctor` is a separate networked route check.
- Source/tests may be present in repository installs but are not runtime imports.
- One designated build platform performs the byte-identity rebuild check. Windows/Linux matrix legs execute the committed bundle rather than asserting cross-platform build bytes.
- Cross-platform `bun run check` excludes the temporary legacy Bats gate; `bun run check:legacy` runs Bats/ShellCheck only on supported POSIX CI until legacy removal.
- The release-candidate version is distinct from upstream `2026.7.9` and reports its exact commit; package and plugin versions remain identical.

## Compatibility and cutover

The new CLI and facades are added before the legacy Bash engine is removed. Existing safe command intents are mapped to the new CLI. Unsafe Stop-hook and repository-controlled auto-enable behaviour is removed immediately rather than emulated.

Legacy provider/orchestration scripts are deleted only after:

1. core and facade acceptance passes;
2. a clean installed-plugin cache runs the bundle;
3. a real host adapter resolves the exact release-candidate source, version and commit; runs offline self-check from a cache without `node_modules`; executes a harmless second-opinion motion and an ordinary council motion; preserves honest completed, degraded or blocked-quorum status and provider/model identity; proves blocked private classification before provider execution; consumes the health schema and detects route/model drift; leaves private payloads and records out of public storage; and has no remaining direct legacy-engine caller;
4. no remaining caller references the legacy engine.

No compatibility shim or duplicate execution engine remains after cutover.

## Error behaviour

- Invalid inputs produce structured errors and non-zero exit status.
- Missing policy and impossible quorum block before external calls.
- Provider failures retain exact category and identity.
- Malformed provider output is a failed seat, never coerced into a vote.
- Partial results remain auditable but cannot silently satisfy normal quorum.
- Persistence failure returns failure and leaves no partial record visible.
- Cancellation and timeout are observable, terminal and distinct.

## Verification contract

### Deterministic

- Schema/classification/provider-ceiling tests.
- Secret and sensitive-data tests including evidence and prior-round payloads.
- Project identity, atomic records and migration dry-run/apply tests.
- Lens coverage, deterministic rotation and role/provider independence tests.
- HTTP status/retry/size/deadline fixtures.
- CLI normal exit, hang, child-process hang, cancellation and behavioural tool-denial fixtures.
- Requested/observed model identity, unverified identity and same-family fallback tests.
- Round, quorum, degradation and malformed-response tests.
- Offline self-check, health baseline and doctor schema tests.
- Security regressions for malicious repository settings and lifecycle arithmetic.

### Packaging and integration

- Existing compatible public behaviours remain covered until legacy removal.
- Claude Code validates the plugin manifest.
- A fresh plugin cache contains no `node_modules` requirement and executes only the bundled entry with `--no-install`.
- Windows and Linux exercise process termination, paths, atomic writes and bundle start-up.

### Live smoke

With explicit `public` classification, harmless content and sufficient configured routes:

- one ordinary motion attempts at least three independent provider families;
- one significant motion attempts four families plus rebuttals and contrarian coverage;
- observed actual model identities and every unverified identity are reported honestly;
- a behavioural probe confirms no seat can use tools;
- records parse and match the disclosed route/evidence manifest.

Live provider availability is environment-dependent and cannot substitute for deterministic adapter fixtures or block release when credentials are absent. A motion that cannot meet normal live quorum must report `degraded` or `blocked-quorum` according to the deterministic floor; no live route is claimed without observed evidence.

## Completion conditions

The public pipeline is complete only when:

1. repository-controlled auto-execution is absent;
2. current terminal-state injection/race defects are fixed;
3. every boundary is schema validated;
4. policy, secret and quorum failures occur before unsafe external calls;
5. provider/model/role identity is exact and audited;
6. the standing-council round protocol and degradation rules behave as specified;
7. generic scoped records and approval-gated migration APIs work atomically;
8. health detects route/model drift honestly;
9. the bundled CLI runs from a clean cache without package installation;
10. public/private implementation duplication is eliminated after host parity;
11. deterministic, packaging, security and available cross-platform checks pass.

## Sources

Current provider selectors and transport claims must be verified against official provider documentation during the provider-runtime stage. The master design records the source set used for initial planning; implementation must not rely on model-name memory alone.
