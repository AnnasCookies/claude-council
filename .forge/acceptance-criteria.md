# Acceptance Criteria

**Spec:** `docs/forge/2026-07-27-standing-council-kernel-spec.md`  
**Mode:** `interactive`  
**Extracted:** `2026-07-27T19:48:30Z`  
**Stages:** `5`  
**Criteria:** `286`

## Contract

This file is the canonical source of criterion outcomes. Milestones, stage plans, traceability, evidence and findings refer to criterion IDs.

Manual-required criteria remain unsatisfied until the named human decision or external evidence record exists; no availability, parity, provider identity or tool-isolation result may be inferred. Commands are JSON argv contracts. A command naming a file or script not present in the current tree is an owning-stage harness obligation, not a claim that the command currently exists or passes.

Every criterion whose command begins `["bash", "tests/run_tests.sh"` is automated evidence from the supported POSIX CI leg. Native Windows is not an alternative evidence environment for that command; the stage remains open until the CI result is captured.

## Stage Map

| Stage | Name | Dependencies |
|---:|---|---|
| 1 | Public Containment | None |
| 2 | Domain and Policy Foundation | Stage 1 |
| 3 | Provider Runtime | Stage 2 |
| 4 | Facades and Release Candidate | Stage 3 |
| 5 | Legacy Removal and Acceptance | Stage 4; private-host parity is manual/external evidence |

## Criteria

### AC-SEC-001

- **Stage:** 1
- **Spec source:** `## Non-goals` — autonomous execution prohibition
- **Observable outcome:** Loading or installing repository content performs no council execution and initiates no outbound provider request.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Use a deterministic fake-provider fixture with request counters, install and load the plugin without invoking a command, and observe zero council processes and zero outbound attempts in the Bats evidence.
- **Route:** Not applicable — plugin loading has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/containment.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-002

- **Stage:** 1
- **Spec source:** `## Public plugin safety` item 2
- **Observable outcome:** The published hook configuration contains no automatic Stop hook or equivalent automatic review gate.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Inspect the packaged hook manifest and command registrations with the containment fixture and observe that no Stop-event command or indirect Stop-event execution path is registered.
- **Route:** Not applicable — plugin hook configuration has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/containment.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-003

- **Stage:** 1
- **Spec source:** `## Public plugin safety` item 1
- **Observable outcome:** Repository-controlled files cannot enable council execution or authorise an outbound request.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Load malicious repository fixtures that request auto-enable and outbound execution, invoke only plugin initialisation, and observe a blocked/no-op result plus zero fake-provider requests.
- **Route:** Not applicable — repository initialisation has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/containment.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-004

- **Stage:** 1
- **Spec source:** `## Public plugin safety` item 3
- **Observable outcome:** A repository policy setting cannot lower or bypass a stricter user-level classification or provider policy.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Set a user-level restricted/deny policy, add a repository fixture claiming public/allow, attempt a council run, and observe the user policy decision and zero fake-provider requests.
- **Route:** Not applicable — policy precedence is exercised through the plugin command boundary.
- **Command:** `["bash", "tests/run_tests.sh", "tests/containment.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-005

- **Stage:** 1
- **Spec source:** `## Public plugin safety` item 4
- **Observable outcome:** An untrusted numeric lifecycle value is rejected before arithmetic evaluation or process execution.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Supply deterministic numeric-field payloads containing overflow, non-numeric text and shell syntax, invoke the current lifecycle path, and observe validation failure with no marker file and no child process.
- **Route:** Not applicable — lifecycle configuration has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/lifecycle-security.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-006

- **Stage:** 1
- **Spec source:** `## Public plugin safety` item 4
- **Observable outcome:** An untrusted enum lifecycle or provider value outside its declared set is rejected before use.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Supply deterministic unknown and shell-shaped enum values, invoke the current provider/lifecycle path, and observe validation failure before the fake provider or lifecycle handler runs.
- **Route:** Not applicable — lifecycle configuration has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/lifecycle-security.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-007

- **Stage:** 1
- **Spec source:** `## Public plugin safety` item 5
- **Observable outcome:** Provider and lifecycle values are passed as data rather than evaluated through shell interpolation.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Pass metacharacter-bearing provider and lifecycle fixtures through every current spawn path and observe literal argv capture, no extra command, and no marker-file creation.
- **Route:** Not applicable — process-spawn safety has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/lifecycle-security.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-008

- **Stage:** 1
- **Spec source:** `## Non-goals` — private repository content prohibition
- **Observable outcome:** The repository contains no private user record, identity, project name, credential, charter or ledger artefact.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Run the repository privacy scanner against tracked and packaged files using seeded forbidden fixtures as a control, and observe no forbidden private artefact in the real tree while each control is detected.
- **Route:** Not applicable — repository-content inspection has no application route.
- **Command:** `["bun", "tests/security/repository-privacy.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-009

- **Stage:** 1
- **Spec source:** `## Completion conditions` item 2
- **Observable outcome:** A terminal-state value cannot be interpreted as executable syntax or alter lifecycle control flow.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Feed shell-shaped and unknown terminal-state values through the current status path with marker-file and transition spies, and observe a structured rejection, no command execution and no state change.
- **Route:** Not applicable — run-state handling has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/lifecycle-security.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-001

- **Stage:** 1
- **Spec source:** `## Completion conditions` item 2
- **Observable outcome:** When timeout and normal-exit callbacks race in the current engine, the first terminal state remains the recorded result.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Use a deterministic child fixture whose normal exit is released immediately after timeout, run the current lifecycle path repeatedly under a controlled clock, and observe `timed-out` for every timeout-first schedule.
- **Route:** Not applicable — run-state handling has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/terminal-race.bats"]`
- **Negative/error coverage:** AC-LOGIC-002
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-002

- **Stage:** 1
- **Spec source:** `## Completion conditions` item 2
- **Observable outcome:** A normal-exit callback arriving after a terminal timeout cannot overwrite that timeout.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Release the normal-exit callback after the timeout fixture has committed `timed-out`, then observe the unchanged terminal state and a rejected/ignored later transition.
- **Route:** Not applicable — run-state handling has no application route.
- **Command:** `["bash", "tests/run_tests.sh", "tests/terminal-race.bats"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-001

- **Stage:** 1
- **Spec source:** `### Packaging and integration` — compatible public behaviour
- **Observable outcome:** The existing public regression suite passes after unsafe automatic execution is removed.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run the complete existing Bats suite in the contained plugin tree and observe a zero exit status with every compatible public test passing.
- **Route:** Not applicable — the legacy public surface is exercised by its command-level test suite.
- **Command:** `["bash", "tests/run_tests.sh"]`
- **Negative/error coverage:** AC-SEC-001, AC-SEC-002, AC-SEC-003
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-002

- **Stage:** 1
- **Spec source:** `## Purpose` — owned fork remotes
- **Observable outcome:** Repository remote `origin` resolves to `AnnasCookies/claude-council` and `upstream` resolves to `hex/claude-council`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the repository-ownership preflight in a fixture with the canonical owned-fork and upstream URLs and observe both remotes resolved to their required repositories.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/repository-ownership.ts"]`
- **Negative/error coverage:** AC-OPS-003
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-003

- **Stage:** 1
- **Spec source:** `## Purpose` — pre-publication remote gate
- **Observable outcome:** A public commit or push preflight fails when `origin` is not the owned fork or `upstream` is not the original repository.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the release preflight against fixtures with each remote missing, swapped and pointed elsewhere; observe a non-zero refusal before any commit/push action.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/repository-ownership.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-004

- **Stage:** 1
- **Spec source:** `## Purpose` — upstream licence and attribution
- **Observable outcome:** The fork retains the upstream MIT licence and includes explicit attribution to `hex/claude-council`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the ownership metadata fixture against the repository licence and attribution artefact, and observe the MIT licence retained plus the upstream repository named explicitly.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/repository-ownership.ts"]`
- **Negative/error coverage:** AC-SEC-008
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-001

- **Stage:** 2
- **Spec source:** `## Core contracts` — `DataClassification`
- **Observable outcome:** The validated `DataClassification` contract accepts exactly `public`, `internal`, `confidential` and `restricted`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the domain schema fixture over all four declared values and every neighbouring/unknown value, and observe acceptance only for the declared set.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-002

- **Stage:** 2
- **Spec source:** `## Core contracts` — `CouncilScope`
- **Observable outcome:** The validated `CouncilScope` contract accepts exactly `general` and `project`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the domain schema fixture with both declared values plus empty, case-variant and unknown values, and observe acceptance only for `general` and `project`.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-003

- **Stage:** 2
- **Spec source:** `## Core contracts` — `ProjectPolicy`
- **Observable outcome:** A valid `ProjectPolicy` represents stable project identity, classification, allowed providers and optional provider ceilings.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the canonical valid project-policy fixture and observe all required fields and optional ceilings retained in the typed result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-POL-007
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-004

- **Stage:** 2
- **Spec source:** `## Core contracts` — `ModelRoute`
- **Observable outcome:** A valid `ModelRoute` represents one provider family, one primary selector, ordered same-family fallbacks and one transport.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the canonical valid route fixture and observe provider family, primary selector, fallback order and transport preserved exactly.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-INT-005
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-005

- **Stage:** 2
- **Spec source:** `## Core contracts` — `RoleLens`
- **Observable outcome:** A valid `RoleLens` represents category, name, prompt and applicability metadata.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the canonical valid lens fixture and observe each declared field retained without implicit defaults.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-LOGIC-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-006

- **Stage:** 2
- **Spec source:** `## Core contracts` — `RunManifest`
- **Observable outcome:** A valid `RunManifest` represents motion ID, scope, classification, selected routes and lenses, rounds, quorum policy and evidence references.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the canonical valid manifest fixture and observe every required run-planning field retained and serialisable.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-007

- **Stage:** 2
- **Spec source:** `## Core contracts` — `SeatResponse`
- **Observable outcome:** A valid `SeatResponse` represents seat ID, provider family, requested model, optional observed actual model, `verified` or `unverified` model identity, role, status, timing and either a structured answer or structured error.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse canonical verified-success, unverified-success and failed-seat fixtures and observe exact identity state, optional actual model, role, status, timing and the appropriate answer/error branch retained.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-INT-026, AC-INT-031, AC-INT-032
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-008

- **Stage:** 2
- **Spec source:** `## Core contracts` — `RunState`
- **Observable outcome:** A valid `RunState` represents immutable in-process progression from `queued` through `running` to one terminal result status.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse fixtures for queued, running and every declared terminal result, then confirm mutation attempts do not change the parsed value or transition history.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-LOGIC-016, AC-CFG-013
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-009

- **Stage:** 2
- **Spec source:** `## Core contracts` — `CouncilRecord`
- **Observable outcome:** A valid `CouncilRecord` represents input hash, policy decision, disclosed destinations, evidence manifest, per-round responses, quorum, degradation and chair result.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the canonical complete record fixture and observe every audited field retained and round-trippable through serialisation.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/contracts.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-010

- **Stage:** 2
- **Spec source:** `## Core contracts` — boundary validation
- **Observable outcome:** A nonconforming value at any Stage 2 domain, policy, evidence or persisted-record boundary is rejected by Zod rather than accepted through a type assertion.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** For each exported Stage 2 boundary parser, pass a deterministic fixture with one required field absent or mistyped and observe a structured Zod failure before domain use or persistence.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/boundary-validation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-011

- **Stage:** 2
- **Spec source:** `## Architecture` — dependency direction
- **Observable outcome:** Domain and policy modules have no import path to facade or host-specific skill content.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Run the import-boundary checker against the TypeScript dependency graph and observe zero outward or host-content imports from domain and policy modules.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/architecture/import-boundaries.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-012

- **Stage:** 2
- **Spec source:** `## Packaging` — TypeScript strict mode
- **Observable outcome:** The TypeScript project type-checks with strict mode enabled.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Inspect the effective compiler configuration for `strict: true`, run the repository check script, and observe a zero exit status.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "run", "check"]`
- **Negative/error coverage:** AC-CFG-010
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-013

- **Stage:** 2
- **Spec source:** `## Core contracts` — in-process run state
- **Observable outcome:** Run-state storage contains no durable cross-invocation job semantics; `queued` exists only before spawn in the current invocation.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Inspect the run-state API and execute a process-restart fixture; observe no persisted queued/running job, no resumable identifier and no cross-invocation state recovery.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/no-durable-jobs.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-001

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — ordering
- **Observable outcome:** Classification comparison orders `public` below `internal`, `internal` below `confidential`, and `confidential` below `restricted`.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Evaluate every ordered and reverse pair in the deterministic classification matrix and observe the declared relation for every comparison.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/classification.test.ts"]`
- **Negative/error coverage:** AC-POL-003
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-002

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — explicit classification
- **Observable outcome:** A run with an explicit recognised effective classification reaches policy evaluation with that exact classification unchanged.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Create one fixture per classification, resolve effective policy, and observe the selected classification preserved in the policy decision.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/classification.test.ts"]`
- **Negative/error coverage:** AC-POL-003, AC-POL-004
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-003

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — explicit classification
- **Observable outcome:** A run with no effective classification ends as `blocked-policy` before any outbound call.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Omit classification from a run fixture, execute policy evaluation with an outbound spy, and observe `blocked-policy` plus zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/classification.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-004

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — explicit classification
- **Observable outcome:** A run with an unknown classification ends as `blocked-policy` before any outbound call.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Supply an unknown classification through the untyped boundary, execute policy evaluation with an outbound spy, and observe a structured policy error, `blocked-policy` and zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/classification.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-005

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — project policy
- **Observable outcome:** A project-scoped run with a matching valid project policy reaches route evaluation.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Create a canonical project identity and matching valid policy fixture, evaluate the run, and observe route evaluation using that policy.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/project-policy.test.ts"]`
- **Negative/error coverage:** AC-POL-006, AC-POL-007
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-006

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — project policy
- **Observable outcome:** A project-scoped run with no applicable project policy ends as `blocked-policy` before any outbound call.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Request project scope without a matching policy while an outbound spy is installed, and observe `blocked-policy` with zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/project-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-007

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — project policy
- **Observable outcome:** A project-scoped run with malformed project policy ends as `blocked-policy` before any outbound call.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Supply a malformed policy fixture at the project boundary with an outbound spy installed, and observe a structured validation error, `blocked-policy` and zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/project-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-008

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — provider ceilings
- **Observable outcome:** A route whose provider exceeds the effective classification ceiling is excluded from the run.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Evaluate the provider/classification ceiling matrix and observe each over-ceiling route recorded as an absent disallowed seat before execution.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/provider-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-009

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — provider allowlists
- **Observable outcome:** A provider family outside the effective allowlist is excluded from the run.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Evaluate a route set containing an unlisted family and observe that family recorded as an absent disallowed seat with no outbound invocation.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/provider-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-010

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — seat identity
- **Observable outcome:** A provider excluded by policy is not replaced by a different provider family under the excluded seat identity.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Disallow a selected family while another family is available, resolve routes, and observe the original seat absent and no response labelled with the excluded identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/provider-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-011

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — one-run override
- **Observable outcome:** A permitted one-run policy override records its reason, authorising source, affected providers, classification, destinations and timestamp.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Apply a valid explicitly authorised override fixture, serialise the policy decision, and observe every required audit field with the supplied values.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/override.test.ts"]`
- **Negative/error coverage:** AC-POL-013, AC-POL-014, AC-POL-015, AC-POL-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-012

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — one-run override
- **Observable outcome:** A policy override affects only its authorised run and does not change policy evaluation for the next run.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Evaluate two runs against one immutable base policy, attach the override only to the first, and observe the second run use the original policy with no inherited override.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/override.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-013

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — non-overridable secret detection
- **Observable outcome:** An override cannot permit external transmission of a payload containing a detected high-confidence secret.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Attach a maximally permissive override to a payload containing each versioned high-confidence secret fixture, execute policy evaluation, and observe a secret-blocking result with zero outbound calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/override.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-014

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — non-overridable restricted data
- **Observable outcome:** An override cannot permit external transmission of a `restricted` run.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Attach a permissive override to an explicitly restricted run, evaluate with an outbound spy, and observe `blocked-policy` and zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/override.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-015

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — non-overridable project identity
- **Observable outcome:** An override cannot permit a project run whose stable project identity is missing.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Attach a permissive override to a project-scoped run without canonical identity, evaluate with an outbound spy, and observe `blocked-policy` and zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/override.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-016

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — non-overridable unknown classification
- **Observable outcome:** An override cannot permit a run whose classification is unknown.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Pass an unknown classification plus a permissive override through the untyped boundary, and observe validation failure/`blocked-policy` before any outbound call.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/policy/override.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-010

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — complete payload scan
- **Observable outcome:** The secret scanner receives the fully assembled outbound payload rather than an earlier partial form.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Assemble a payload with unique sentinels in motion context, lens text, evidence and prior-round responses, invoke the scanner spy, and observe every sentinel in the single scanned value before the outbound gate opens.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts"]`
- **Negative/error coverage:** AC-SEC-011, AC-SEC-012, AC-SEC-013, AC-SEC-014
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-011

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — high-confidence secrets
- **Observable outcome:** A high-confidence secret in motion or context blocks execution before external transmission.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Place every versioned high-confidence secret fixture in the motion/context position, evaluate with an outbound spy, and observe a secret-blocking result plus zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-012

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — high-confidence secrets
- **Observable outcome:** A high-confidence secret in a role lens blocks execution before external transmission.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Place every versioned high-confidence secret fixture in selected lens text after lens assembly, evaluate with an outbound spy, and observe a secret-blocking result plus zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-013

- **Stage:** 2
- **Spec source:** `## Verification contract` — sensitive evidence tests
- **Observable outcome:** A high-confidence secret in supplied evidence blocks execution before external transmission.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Place every versioned high-confidence secret fixture in a syntactically valid evidence excerpt, evaluate the assembled payload with an outbound spy, and observe a secret-blocking result plus zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-014

- **Stage:** 2
- **Spec source:** `## Verification contract` — prior-round payload tests
- **Observable outcome:** A high-confidence secret in a normalised prior-round response blocks execution before external transmission.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Place every versioned high-confidence secret fixture in a valid prior-round response, assemble round two with an outbound spy, and observe a secret-blocking result plus zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-015

- **Stage:** 2
- **Spec source:** `## Classification and fail-closed routing` — restricted data
- **Observable outcome:** An explicitly `restricted` payload causes `blocked-policy` before external transmission even when it contains no detected secret.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Use a harmless secret-free restricted fixture, evaluate with an outbound spy, and observe `blocked-policy` plus zero spy calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-POL-017

- **Stage:** 2
- **Spec source:** `## Architecture` policy branch and `## Quorum and degraded operation` terminal statuses
- **Observable outcome:** A high-confidence-secret block returns terminal `blocked-policy` consistently in policy output, run-state schema, CLI output and record eligibility.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Drive a high-confidence-secret fixture through policy, run-state, CLI and record boundaries; pass only when each exposes `blocked-policy`, no provider request occurs and no record is eligible.
- **Route:** Not applicable — the contract is exercised through core and CLI boundaries.
- **Command:** `["bun", "test", "tests/security/outbound-scan.test.ts", "tests/run-state/transitions.test.ts", "tests/cli/result-schema.test.ts", "tests/records/record-store.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-001

- **Stage:** 2
- **Spec source:** `## Tool-free seats and evidence boundary` — evidence pack
- **Observable outcome:** A valid evidence pack carries parser version, sources, content hashes, extraction metadata and source-cited sanitised excerpts.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the canonical evidence-pack fixture and observe all provenance, hash, extraction and sanitised-excerpt fields retained exactly.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/evidence/evidence-pack.test.ts"]`
- **Negative/error coverage:** AC-DATA-002, AC-SEC-013
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-002

- **Stage:** 2
- **Spec source:** `## Tool-free seats and evidence boundary` — evidence pack
- **Observable outcome:** An evidence pack missing provenance, hash, extraction or sanitisation metadata is rejected before seat payload assembly.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Remove each required field in turn from the deterministic evidence fixture, submit it to the evidence boundary, and observe a structured Zod error plus zero seat-dispatch calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/evidence/evidence-pack.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-016

- **Stage:** 2
- **Spec source:** `## Tool-free seats and evidence boundary` — seat envelope
- **Observable outcome:** A seat envelope contains only motion/context, exactly one validated role lens, optional validated evidence, normalised prior-round responses when applicable and the response schema.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Build envelopes for round one and round two from canonical fixtures, serialise them, and observe only the declared fields, exactly one parsed lens, no prior responses in round one and normalised responses in round two.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/seat-envelope.test.ts"]`
- **Negative/error coverage:** AC-SEC-017, AC-SEC-018, AC-DATA-002
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-017

- **Stage:** 2
- **Spec source:** `## Tool-free seats and evidence boundary` — no tools
- **Observable outcome:** A seat envelope exposes no browser, shell, MCP, edit, filesystem or provider-side web-search capability.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Build an envelope through every seat-envelope variant and inspect its schema/serialised value; observe no tool descriptor, callable capability or web-search enablement field.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/seat-envelope.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-018

- **Stage:** 2
- **Spec source:** `## Tool-free seats and evidence boundary` — no host data
- **Observable outcome:** A seat envelope exposes no host path, arbitrary file content, environment variable or credential value.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Seed the host fixture with unique path, file, environment and credential sentinels, build every seat-envelope variant, and observe that none of the sentinels appears in the serialised outbound envelope.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/seat-envelope.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-003

- **Stage:** 2
- **Spec source:** `## Tool-free seats and evidence boundary` — research separation
- **Observable outcome:** A host research result can enter a run only as a validated evidence pack and never as a voting seat response.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Submit a research fixture directly and through a valid evidence pack, then observe direct rejection, evidence acceptance, and no increase in quorum vote count in either case.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/evidence/research-boundary.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-004

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — independent axes
- **Observable outcome:** Changing a seat provider family does not change its selected role lens, and changing its lens does not change its provider route.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Hold motion ID and assignments constant while varying provider and then lens independently; observe the untouched axis remains identical in each deterministic fixture.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/selection.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011, AC-LOGIC-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-018

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — lens catalogue
- **Observable outcome:** The validated lens catalogue exposes domain expert, maintainer, risk, systems, contrarian and chair-synthesis categories.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the bundled lens catalogue and observe one valid catalogue entry for each declared category.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/catalogue.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011, AC-LOGIC-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-005

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — applicability
- **Observable outcome:** Motion classification selects only lenses whose applicability metadata matches that motion.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the deterministic motion/applicability matrix and observe every selected lens matches its motion while every explicitly non-applicable lens is absent.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/selection.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-006

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — mandatory coverage
- **Observable outcome:** Every valid selected lens set covers domain expertise, maintainability, failure/risk and a counter-position.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Select lenses for each deterministic motion class and observe the four mandatory coverage categories in the resulting validated assignment.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/selection.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011, AC-LOGIC-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-007

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — significant contrarian
- **Observable outcome:** A significant motion includes a contrarian seat response requirement.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Classify the canonical significant motion, select its lenses, and observe a voting contrarian assignment and corresponding run obligation.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/selection.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011, AC-LOGIC-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-008

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — deterministic assignment
- **Observable outcome:** The same motion ID and prior-assignment history always produce the same role-to-seat permutation.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run selection repeatedly and under shuffled input ordering with identical motion ID/history, and observe byte-identical assignment output.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/rotation.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-009

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — role stability
- **Observable outcome:** A seat role remains unchanged across every round of one motion.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Generate all rounds for one deterministic motion and observe each seat ID retains the same lens category and name in every round.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/rotation.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-010

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — between-motion rotation
- **Observable outcome:** Eligible roles rotate between distinct motions when prior assignments would otherwise repeat them.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run two deterministic motion IDs with the first assignment supplied as history and observe at least one eligible seat receives a different role while mandatory coverage remains valid.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/rotation.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-011
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-011

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — missing mandatory lens
- **Observable outcome:** A lens set missing any mandatory coverage category fails before a provider call.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Remove each mandatory category in turn from the catalogue/selection fixture, execute planning with a provider spy, and observe structured lens failure plus zero provider calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/validation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-012

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — duplicate mandatory lens
- **Observable outcome:** A lens assignment containing a duplicate mandatory lens fails before a provider call.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Duplicate each mandatory assignment in turn, execute planning with a provider spy, and observe structured lens failure plus zero provider calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/validation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-013

- **Stage:** 2
- **Spec source:** `## Dynamic role lenses` — chair synthesis
- **Observable outcome:** Chair synthesis is represented separately from seat votes and contributes zero votes to quorum.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Add a valid chair synthesis to a deterministic run and compare quorum before/after; observe identical vote count and a separately labelled chair result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/lenses/validation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-014

- **Stage:** 2
- **Spec source:** `### Run state` — transition graph
- **Observable outcome:** A run can transition from `queued` to `running` and from `running` to each declared terminal state.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Execute the complete allowed-transition matrix and observe every declared edge accepted with the exact destination state.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/run-state.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-015, AC-LOGIC-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-015

- **Stage:** 2
- **Spec source:** `### Run state` — transition graph
- **Observable outcome:** A transition not present in `queued -> running -> terminal` is rejected without changing state.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Execute the complete disallowed-transition matrix, including direct queued-to-terminal and terminal-to-any-state attempts, and observe rejection plus unchanged source state.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/run-state.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-016

- **Stage:** 2
- **Spec source:** `### Run state` — first terminal wins
- **Observable outcome:** Concurrent terminal transitions commit exactly the first accepted terminal state.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Release each ordered pair of terminal-transition callbacks under a deterministic scheduler, and observe exactly one accepted transition and the first destination retained.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/run-state-race.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-017

- **Stage:** 2
- **Spec source:** `### Run state` — immutable transitions
- **Observable outcome:** Previously emitted run-state values and transition history cannot be mutated by later code.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Retain emitted states/history, attempt direct and nested mutation after subsequent transitions, and observe the retained snapshots remain byte-identical.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/run-state.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-026

- **Stage:** 2
- **Spec source:** `## Public plugin safety` item 8 — prompt tool escalation
- **Observable outcome:** Prompt text requesting tools does not add or enable any seat capability.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Use deterministic prompt-injection fixtures requesting shell, browser, filesystem, MCP and web-search access, build the seat envelope, and observe the same tool-free capability set as a harmless control.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/prompt-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-027

- **Stage:** 2
- **Spec source:** `## Public plugin safety` item 8 — prompt classification escalation
- **Observable outcome:** Prompt text cannot change the run effective classification.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Submit prompt-injection fixtures claiming a different classification, evaluate policy, and observe the caller/policy-derived classification unchanged in the manifest and decision.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/prompt-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-028

- **Stage:** 2
- **Spec source:** `## Public plugin safety` item 8 — prompt route escalation
- **Observable outcome:** Prompt text cannot add a provider, change a selector or bypass a provider ceiling/allowlist.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Submit prompt-injection fixtures naming forbidden providers/selectors and route overrides, resolve routes, and observe the policy-derived route set unchanged with forbidden routes absent.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/prompt-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-032

- **Stage:** 2
- **Spec source:** `### Layers` — deterministic evidence normalisation
- **Observable outcome:** For one parser version and source input, evidence parser normalisation produces byte-identical normalised content and hashes on repeated runs.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Parse each versioned evidence fixture repeatedly and with irrelevant traversal/input ordering varied, then observe byte-identical normalised excerpts, source references and content hashes.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/evidence/normalisation.test.ts"]`
- **Negative/error coverage:** AC-DATA-002, AC-SEC-013
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-033

- **Stage:** 2
- **Spec source:** `## Core contracts` — `ModelRoute`
- **Observable outcome:** A valid `ModelRoute` records selector, alias policy, transport family, response-identity fields, provider-side storage control and timeout/cancellation semantics.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse one fixture for each supported transport family and observe every named metadata field retained exactly; reject fixtures omitting any required field.
- **Route:** Not applicable — the route schema has no browser or HTTP surface.
- **Command:** `["bun", "test", "tests/domain/model-route.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-034

- **Stage:** 3
- **Spec source:** `### HTTP` — stateless provider requests
- **Observable outcome:** Every supported HTTP provider request omits prior-response identifiers and explicitly disables provider-side request/response storage where that transport supports the control.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Execute each HTTP adapter against a request-capture fixture and observe no prior-response identifier plus the transport-specific no-storage value whenever supported.
- **Route:** Not applicable — adapters are exercised through captured HTTP transport fixtures.
- **Command:** `["bun", "test", "tests/providers/storage-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-035

- **Stage:** 3
- **Spec source:** `### HTTP` — retention-policy gate
- **Observable outcome:** A provider route whose retention or storage semantics cannot satisfy the applicable data/provider policy is unavailable before any external request.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Configure a route fixture with mandatory incompatible retention, execute a classified motion with a request spy, and observe an unavailable-route result plus zero external requests.
- **Route:** Not applicable — adapters are exercised through captured HTTP transport fixtures.
- **Command:** `["bun", "test", "tests/providers/storage-policy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-003

- **Stage:** 2
- **Spec source:** `## Records and migration API` — scope
- **Observable outcome:** A general-scope record is stored under the generic `general` scope rather than a project-derived key.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Write a canonical general-scope record into an empty temporary store and observe it retrieved only from the `general` scope.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/scoping.test.ts"]`
- **Negative/error coverage:** AC-DATA-005
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-004

- **Stage:** 2
- **Spec source:** `## Records and migration API` — stable project identity
- **Observable outcome:** Equivalent canonical repository identities derive the same stable project storage identifier across repeated runs.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the versioned canonical-identity fixture matrix, including supported equivalent repository forms, and observe one stable opaque project key per canonical identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/project-identity.test.ts"]`
- **Negative/error coverage:** AC-DATA-005
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-005

- **Stage:** 2
- **Spec source:** `## Records and migration API` — display names
- **Observable outcome:** Changing a human project display name does not change the project storage key.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Derive a key twice from the same canonical repository identity with two display names and observe identical keys while each display name remains metadata only.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/project-identity.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-006

- **Stage:** 2
- **Spec source:** `## Records and migration API` — append-only records
- **Observable outcome:** Appending a record leaves every previously visible record byte-for-byte unchanged.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Snapshot a seeded temporary record store, append one valid record, and observe all prior record bytes/hashes unchanged plus exactly one new record.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/append-only.test.ts"]`
- **Negative/error coverage:** AC-DATA-009, AC-DATA-010, AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-007

- **Stage:** 2
- **Spec source:** `## Records and migration API` — atomic writes
- **Observable outcome:** A record write becomes visible only as one complete final file, never as a partial record.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Inject failures at temporary-write, flush, rename and verification boundaries while concurrently reading the store; observe either the prior state or one complete parseable final record, never partial content.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/atomic-write.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-008

- **Stage:** 2
- **Spec source:** `## Records and migration API` — post-write verification
- **Observable outcome:** A successful record write has been reparsed and its persisted hash matches the intended record hash.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Write a canonical record through verification spies, then independently parse the final file and compare hashes; observe a successful parse and exact hash equality before success is returned.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/atomic-write.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-009

- **Stage:** 2
- **Spec source:** `## Records and migration API` — duplicate motion IDs
- **Observable outcome:** A record whose motion ID already exists in the target scope is rejected without changing the store.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Seed a scope with one motion ID, attempt a second record using that ID, and observe a duplicate error plus byte-identical store contents.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/append-only.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-010

- **Stage:** 2
- **Spec source:** `## Records and migration API` — duplicate session IDs
- **Observable outcome:** A record whose session ID already exists in the target scope is rejected without changing the store.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Seed a scope with one session ID, attempt a second record using that ID, and observe a duplicate error plus byte-identical store contents.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/append-only.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-011

- **Stage:** 2
- **Spec source:** `## Records and migration API` — audit decisions
- **Observable outcome:** A persisted session record contains the effective policy decision and disclosed external destinations.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Persist a run with a deterministic policy/destination decision, reload the record, and observe the exact decision and destination set recorded.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/session-record.test.ts"]`
- **Negative/error coverage:** AC-DATA-012, AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-012

- **Stage:** 2
- **Spec source:** `## Records and migration API` — credential exclusion
- **Observable outcome:** No persisted session record contains a provider credential value.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Seed unique credential sentinels in all configured provider transports, persist success and failure sessions, then scan/reparse records and observe none of the sentinels.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/session-record.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-013

- **Stage:** 2
- **Spec source:** `## Records and migration API` — migration plan
- **Observable outcome:** `migrate-general plan` applies caller-supplied project taxonomy and match rules without writing to source, archive or destination stores.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Supply a canonical taxonomy/rule fixture, snapshot the migration filesystem, run plan, and observe classifications derived from that fixture plus byte-identical source/archive/destination contents.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-014

- **Stage:** 2
- **Spec source:** `## Records and migration API` — proposed destinations
- **Observable outcome:** A migration plan reports a proposed destination for each item whose destination is deterministically resolvable.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run plan against fixtures with known canonical destination mappings and observe each resolvable item paired with its expected stable destination.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** AC-DATA-015
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-015

- **Stage:** 2
- **Spec source:** `## Records and migration API` — unresolved items
- **Observable outcome:** A migration plan places every item whose destination cannot be resolved into the mandatory unresolved bucket rather than assigning it speculatively.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run plan against ambiguous and missing-identity fixtures and observe each item in the unresolved collection with no invented destination.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-016

- **Stage:** 2
- **Spec source:** `## Records and migration API` — approved plan hash
- **Observable outcome:** Migration apply rejects a missing, unknown or stale plan hash before any write.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Invoke apply with omitted, altered and stale hashes against a snapshotted store and observe structured rejection plus byte-identical source/archive/destination contents.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-017

- **Stage:** 2
- **Spec source:** `## Records and migration API` — authorisation metadata
- **Observable outcome:** Migration apply rejects missing or malformed authorisation metadata before any write.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Invoke apply with each required authorisation field absent or invalid and observe structured rejection plus byte-identical source/archive/destination contents.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-018

- **Stage:** 2
- **Spec source:** `## Records and migration API` — immutable archive first
- **Observable outcome:** A valid migration apply publishes an immutable source archive before appending any destination record.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run apply with ordered write spies and a canonical approved plan, and observe archive publication/verification precede the first destination append.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration-order.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-019

- **Stage:** 2
- **Spec source:** `## Records and migration API` — atomic migration appends
- **Observable outcome:** A valid migration apply appends each destination record atomically.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Apply an approved plan under per-item failpoints and concurrent readers, and observe each destination as either absent or one complete parseable record, never partial content.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration-order.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-020

- **Stage:** 2
- **Spec source:** `## Records and migration API` — count and hash verification
- **Observable outcome:** Migration apply returns success only when destination counts and hashes match the approved plan.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Apply a canonical plan, independently count and hash destination records, and observe exact agreement; inject count/hash mismatch and observe failure instead of success.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-021

- **Stage:** 2
- **Spec source:** `## Records and migration API` — source preservation
- **Observable outcome:** Migration apply never deletes or modifies the source archive.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Hash the seeded source before successful and failpointed applies, then observe the source remains present and byte-identical after every outcome.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-022

- **Stage:** 2
- **Spec source:** `## Error behaviour` — persistence failure
- **Observable outcome:** A persistence failure returns a failure result and leaves no partial record visible.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Inject deterministic write, flush, rename, parse and hash failures into record and migration writes; observe a failure result and only the previously committed store state.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/persistence-failure.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-023

- **Stage:** 2
- **Spec source:** `## Records and migration API` — caller-supplied taxonomy
- **Observable outcome:** Changing the validated caller-supplied taxonomy or match rules changes migration classification only as those inputs prescribe.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the same source fixture with two valid deterministic taxonomy/rule sets and observe each plan follow its supplied mappings with no hidden project mapping.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration-taxonomy.test.ts"]`
- **Negative/error coverage:** AC-DATA-024, AC-DATA-025
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-024

- **Stage:** 2
- **Spec source:** `## Records and migration API` — no private taxonomy
- **Observable outcome:** The public package contains no embedded private project taxonomy or private project match rule.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Run the package/privacy scanner with a seeded private-taxonomy control and observe the control detected while no bundled source, data or release artefact contains a private taxonomy.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration-taxonomy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-025

- **Stage:** 2
- **Spec source:** `## Records and migration API` — mandatory unresolved bucket
- **Observable outcome:** Every migration plan output contains an unresolved bucket, including plans with zero unresolved items.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run plan against fully resolvable and ambiguous fixtures, parse each output, and observe the unresolved collection present as empty for the first and populated for the second.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/migration.test.ts"]`
- **Negative/error coverage:** AC-DATA-015
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-026

- **Stage:** 2
- **Spec source:** `## Quorum and degraded operation` — degraded acceptance record
- **Observable outcome:** Appending a degraded resolution requires a separate persisted chair-acceptance record that references the degraded run.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Attempt to append a degraded resolution with no acceptance, embedded acceptance and a separate valid referenced acceptance; observe rejection for the first two and eligibility only for the third.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/resolution-gate.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-027

- **Stage:** 2
- **Spec source:** `## Quorum and degraded operation` — immutable degraded status
- **Observable outcome:** Appending an explicitly accepted degraded resolution leaves the underlying run status as `degraded`.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Persist a degraded run, persist its separate chair acceptance, append the resolution and reload all records; observe the run still labelled `degraded`, never `completed`.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/resolution-gate.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-028

- **Stage:** 2
- **Spec source:** `## Quorum and degraded operation` — completed resolution
- **Observable outcome:** The record store accepts a resolution for a normally completed run without a degraded-acceptance record.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Persist a valid completed run and append its resolution, then observe a parseable resolution linked to that completed run.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/resolution-gate.test.ts"]`
- **Negative/error coverage:** AC-DATA-026, AC-DATA-029
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-DATA-029

- **Stage:** 2
- **Spec source:** `## Quorum and degraded operation` — blocked quorum record gate
- **Observable outcome:** The record store never accepts a resolution for a `blocked-quorum` run.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Persist a blocked-quorum run, attempt resolution append with and without chair acceptance metadata, and observe rejection plus no resolution record in both cases.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/records/resolution-gate.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-001

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — independent families
- **Observable outcome:** The import-bundled validated registry contains independently identified Anthropic, OpenAI, xAI and Google provider families.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse the bundled registry and observe exactly one independent-family identity for each required family with no shared identity key.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/registry.test.ts"]`
- **Negative/error coverage:** AC-CFG-016, AC-SEC-019
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-002

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — optional families
- **Observable outcome:** A configured valid DeepSeek or Moonshot route is exposed under its own provider-family identity.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Load valid DeepSeek and Moonshot configuration fixtures separately and observe each route enabled with its exact independent family identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/registry.test.ts"]`
- **Negative/error coverage:** AC-INT-003, AC-CFG-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-003

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — optional families
- **Observable outcome:** DeepSeek and Moonshot routes remain disabled when their configuration is absent.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Load the registry with optional-family configuration omitted and observe neither optional route in the enabled route set.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/registry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-014

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — schema-validated data
- **Observable outcome:** Approved model selectors and routes are loaded from schema-validated registry data rather than provider-specific orchestration branches.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the registry parser and architecture check, observe the canonical data file parses, and observe no provider-selector literal branch in the round orchestrator.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/registry-structure.test.ts"]`
- **Negative/error coverage:** AC-CFG-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-004

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — exact selectors
- **Observable outcome:** Route selection chooses an available exact approved selector before any rolling alias for the same family.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Expose both exact and rolling selectors in a deterministic provider catalogue and observe the exact selector chosen.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/routing.test.ts"]`
- **Negative/error coverage:** AC-INT-011
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-005

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — same-family fallback
- **Observable outcome:** Every fallback attempt stays within the provider family of the primary route.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Fail each primary route in turn against a catalogue containing same- and cross-family alternatives and observe only ordered same-family selectors attempted.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/fallback.test.ts"]`
- **Negative/error coverage:** AC-INT-012
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-006

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — requested and actual identity
- **Observable outcome:** Every provider attempt records the requested model; when actual model identity is observed, it records that actual model and marks `modelIdentity: verified`.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run primary-success, fallback-success and failure fixtures with observable identities and observe requested model on every attempt plus exact observed actual model and `verified` identity where available.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/identity.test.ts"]`
- **Negative/error coverage:** AC-INT-026, AC-INT-031, AC-INT-032
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-007

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — explicit fallback
- **Observable outcome:** A response obtained from a fallback is explicitly marked as fallback use with its attempted selector sequence.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Force the primary selector to fail and the second same-family selector to succeed; observe fallback status and ordered attempt identities in the response audit.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/fallback.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-028
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-008

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — successor discovery
- **Observable outcome:** Discovery of a plausible successor selector emits a candidate-successor warning.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Return a deterministic provider catalogue containing an approved selector and a newer unapproved candidate, run diagnostics, and observe a structured candidate-successor warning naming both.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/drift.test.ts"]`
- **Negative/error coverage:** AC-INT-009
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-009

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — no automatic adoption
- **Observable outcome:** Successor discovery does not change the configured production route.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run discovery with a newer candidate, reload route configuration and execute selection, and observe the original approved selector remains selected byte-for-byte.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/drift.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-015

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — user overrides
- **Observable outcome:** A valid user registry override is parsed, merged with base data and reparsed before use.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Apply a canonical valid override, capture both parser invocations, and observe the final validated registry contains the intended override plus unchanged base entries.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/overrides.test.ts"]`
- **Negative/error coverage:** AC-CFG-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-016

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — user overrides
- **Observable outcome:** An invalid merged registry override is rejected before route selection or provider execution.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Apply type-invalid, cross-family-fallback and unknown-enum overrides with route/provider spies, and observe structured validation failure plus zero selection and provider calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/overrides.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-019

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — missing credentials
- **Observable outcome:** Missing provider credentials disable that route without attempting it.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Omit each provider credential in turn, resolve and execute routes with adapter spies, and observe the affected route disabled with zero adapter calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/credentials.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-020

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — credential secrecy
- **Observable outcome:** Credential values do not appear in route-disable errors, provider diagnostics or runtime logs.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Use unique credential sentinels across configured, missing and failed-provider fixtures, capture all structured output and logs, and observe none of the sentinel values.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/credentials.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-018

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — same-provider comparisons
- **Observable outcome:** Multiple models from one provider family contribute at most one independent-family quorum vote; additional comparison results are explicitly non-voting.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Return two valid model responses from one family plus other families, compute quorum, and observe the family counted once and the extra response labelled non-voting comparison evidence.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/family-independence.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-010

- **Stage:** 3
- **Spec source:** `## Sources` — official provider verification
- **Observable outcome:** The release-candidate registry selectors and transport claims match current official provider documentation recorded during Stage 3.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** Retrieve current official documentation for every configured provider route, compare exact selector and transport claims to the bundled registry, and record pass evidence only when every claim matches; external documentation evidence is required and deterministic fixtures do not substitute for it.
- **Route:** Not applicable — official provider documentation is an external evidence source.
- **Command:** Not applicable — this is a time-sensitive official-documentation review, not a repository command.
- **Negative/error coverage:** Not applicable — any mismatch fails this same manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must approve an `AC-INT-010` decision record listing each official source URL, retrieval timestamp, selector/transport comparison and any excluded route; pass requires explicit approval that all bundled production claims match those sources.

### AC-INT-011

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — structured availability
- **Observable outcome:** A route reported unavailable by structured catalogue or trusted CLI output is represented as an absent seat.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Return deterministic unavailable catalogue/CLI fixtures for each transport and observe the matching seat absent with the exact unavailability category.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/availability.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-012

- **Stage:** 3
- **Spec source:** `## Classification and fail-closed routing` — provider identity
- **Observable outcome:** An unavailable provider is never replaced by a different family under the unavailable provider identity.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Make a selected family unavailable while another family remains healthy, execute routing, and observe the original seat absent and no response carrying the unavailable family identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/availability.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-021

- **Stage:** 3
- **Spec source:** `## Tool-free seats and evidence boundary` — adapter construction
- **Observable outcome:** Every available provider adapter proves tool-free seat behaviour with a behavioural denial probe rather than assuming flags imply isolation.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run each adapter against its versioned tool-use denial fixture, ask the seat to invoke an available-looking tool, and observe a denied/unavailable capability with recorded probe evidence and no tool side effect.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/tool-isolation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-022

- **Stage:** 3
- **Spec source:** `## Non-goals` — provider-side web search
- **Observable outcome:** No arbitrary-motion provider request enables provider-side web search.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run every adapter with an arbitrary motion against a request-capture fixture and observe all web-search/tool-search controls absent or explicitly disabled.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/tool-isolation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-031

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — unobservable actual identity
- **Observable outcome:** When actual model identity cannot be observed, the seat omits actual model identity and records `modelIdentity: unverified` instead of copying the requested model.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Return a syntactically valid response with no observable model identity, then observe the seat retains requested model, omits actual model and marks identity unverified.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/identity.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-033

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — DeepSeek deterministic acceptance
- **Observable outcome:** A configured DeepSeek route passes its provider adapter contract against the deterministic fake transport without requiring live credentials.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run DeepSeek request, success, failure, identity and fallback fixtures through the fake transport and observe all adapter contract expectations pass with no network access.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/deepseek.test.ts"]`
- **Negative/error coverage:** AC-CFG-016, AC-SEC-021
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-034

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — Moonshot deterministic acceptance
- **Observable outcome:** A configured Moonshot route passes its provider adapter contract against the deterministic fake transport without requiring live credentials.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run Moonshot request, success, failure, identity and fallback fixtures through the fake transport and observe all adapter contract expectations pass with no network access.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/moonshot.test.ts"]`
- **Negative/error coverage:** AC-CFG-016, AC-SEC-021
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-035

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — optional live-route claims
- **Observable outcome:** No DeepSeek or Moonshot live-route availability claim is emitted without both configured credentials and observed route evidence.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run diagnostics with credentials absent, evidence absent and both present; observe no live claim in the first two cases and a claim containing observed evidence only in the third.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/optional-live-claims.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-013

- **Stage:** 3
- **Spec source:** `### HTTP` — abort signals
- **Observable outcome:** Every HTTP provider request is bound to an abort signal.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Invoke each HTTP adapter through a request-capture transport and observe a live abort signal attached to every request.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http.test.ts"]`
- **Negative/error coverage:** AC-INT-014
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-014

- **Stage:** 3
- **Spec source:** `### HTTP` — hard deadlines
- **Observable outcome:** An HTTP provider request that exceeds its hard deadline aborts and returns `timed-out`.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Use a deterministic never-resolving HTTP fixture and controlled clock, advance past the configured hard deadline, and observe abort plus a `timed-out` result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-deadline.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-015

- **Stage:** 3
- **Spec source:** `### HTTP` — transient network retries
- **Observable outcome:** A transient network failure eligible under the route retry policy is retried.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Return one eligible transient network error followed by success from the deterministic fixture and observe exactly the configured retry then the successful same-route result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-retry.test.ts"]`
- **Negative/error coverage:** AC-INT-018, AC-INT-020, AC-INT-021, AC-INT-022, AC-INT-023, AC-INT-024
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-016

- **Stage:** 3
- **Spec source:** `### HTTP` — 429 retries
- **Observable outcome:** An eligible HTTP 429 response is retried under the route retry policy.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Return an eligible 429 followed by success and observe one policy-scheduled retry with the same provider identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-retry.test.ts"]`
- **Negative/error coverage:** AC-INT-018, AC-INT-019
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-017

- **Stage:** 3
- **Spec source:** `### HTTP` — 5xx retries
- **Observable outcome:** An eligible HTTP 5xx response is retried under the route retry policy.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run each versioned eligible 5xx fixture followed by success and observe policy-scheduled retry with the same provider identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-retry.test.ts"]`
- **Negative/error coverage:** AC-INT-018
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-018

- **Stage:** 3
- **Spec source:** `### HTTP` — bounded backoff and jitter
- **Observable outcome:** HTTP retries stop within the configured finite retry/deadline budget and use backoff with bounded jitter.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Drive an always-transient fixture with a seeded clock/random source, capture attempt count and delays, and observe no attempt beyond the finite policy budget and every delay within its configured jitter bounds.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-retry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-019

- **Stage:** 3
- **Spec source:** `### HTTP` — safe retry hints
- **Observable outcome:** A safe valid provider retry hint delays the next eligible retry by the hinted interval subject to the configured hard deadline.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Return eligible retry responses with valid safe hint fixtures under a controlled clock and observe the next attempt not start before the accepted hint while never exceeding the hard deadline.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-retry.test.ts"]`
- **Negative/error coverage:** AC-INT-018
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-020

- **Stage:** 3
- **Spec source:** `### HTTP` — authentication failures
- **Observable outcome:** An authentication failure is returned after one attempt and is not retried automatically.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Return each deterministic authentication-error fixture and observe one request, exact authentication category and no retry timer.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-no-retry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-021

- **Stage:** 3
- **Spec source:** `### HTTP` — policy failures
- **Observable outcome:** A policy failure is returned without an automatic provider retry.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Trigger policy rejection at the outbound gate with request/retry spies and observe zero provider requests and zero retry timers.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-no-retry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-022

- **Stage:** 3
- **Spec source:** `### HTTP` — schema failures
- **Observable outcome:** A request or response schema failure is returned without an automatic retry.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Feed malformed request and response fixtures through the HTTP boundary and observe one structured schema failure per case with no retry timer.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-no-retry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-023

- **Stage:** 3
- **Spec source:** `### HTTP` — model-missing failures
- **Observable outcome:** A model-missing response is returned after one attempt and is not retried automatically.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Return the versioned model-missing fixture and observe one request, exact model-missing category and no retry timer.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-no-retry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-024

- **Stage:** 3
- **Spec source:** `### HTTP` — timeout failures
- **Observable outcome:** A timed-out HTTP attempt is not retried automatically.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Advance a deterministic hanging request past its hard deadline and observe one aborted request, no later request and the timeout category retained.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-no-retry.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-025

- **Stage:** 3
- **Spec source:** `### HTTP` — response-size boundary
- **Observable outcome:** A response exceeding the configured size limit is rejected before provider-output parsing begins.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Stream a response one byte beyond the configured bound with a parser spy and observe an oversize failure, bounded bytes retained and zero parser calls.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/http-size.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-026

- **Stage:** 3
- **Spec source:** `## Error behaviour` — provider failure identity
- **Observable outcome:** A failed provider attempt retains its exact provider/model identity and failure category in the seat result.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Run each deterministic provider failure category with unique requested/actual identity fixtures and observe those exact identities and category in the structured failed-seat result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/providers/failures.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-027

- **Stage:** 3
- **Spec source:** `### CLI` — trusted executable resolution
- **Observable outcome:** A CLI adapter executes only an explicitly resolved trusted executable.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Place trusted and shadow executables on a controlled PATH, resolve each CLI adapter, and observe the configured trusted absolute executable selected or a resolution error when absent.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-resolution.test.ts"]`
- **Negative/error coverage:** AC-INT-028
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-028

- **Stage:** 3
- **Spec source:** `### CLI` — argument-array spawning
- **Observable outcome:** CLI provider and lifecycle processes are spawned with argument arrays and no shell evaluation.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Pass metacharacter-bearing lifecycle/model fixtures into every CLI adapter, capture spawn options, and observe literal argv, `shell: false`/equivalent and no marker command execution.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-spawn.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-023

- **Stage:** 3
- **Spec source:** `### CLI` — prompt transport
- **Observable outcome:** Provider prompt text never appears in the spawned process argument list.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Use a unique prompt sentinel through every CLI adapter, inspect captured argv/process listings, and observe the sentinel only in stdin or the protected temporary-file body.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-prompt.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-024

- **Stage:** 3
- **Spec source:** `### CLI` — protected temporary prompts
- **Observable outcome:** When a CLI adapter uses a temporary prompt file, the file is access-restricted, removed after exit and never reused.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Force the temporary-file transport on each supported platform fixture, inspect permissions/ACL and lifecycle, and observe host-user-only access, deletion after success/error/timeout and a distinct path per run.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-prompt.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-025

- **Stage:** 3
- **Spec source:** `### CLI` — isolation flags
- **Observable outcome:** Each CLI backend records its accepted help/exit behaviour and the result of a behavioural tool-use denial probe.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the backend-specific capability fixture, capture accepted help/exit behaviour, execute a tool-use attempt, and observe a structured capability record containing the accepted invocation and denial-probe result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-isolation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-029

- **Stage:** 3
- **Spec source:** `### CLI` — cancellation
- **Observable outcome:** Cancelling a CLI seat terminates its complete process tree, waits for every descendant to exit and returns `cancelled`.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Spawn the deterministic child-process-hang fixture, cancel it, and observe parent and child exit before the adapter returns the distinct `cancelled` result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-cancellation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-030

- **Stage:** 3
- **Spec source:** `### CLI` — timeout
- **Observable outcome:** Timing out a CLI seat terminates its complete process tree, waits for every descendant to exit and returns `timed-out`.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Spawn the deterministic child-process-hang fixture, advance the controlled clock beyond deadline, and observe parent and child exit before the adapter returns the distinct `timed-out` result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-timeout.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-019

- **Stage:** 3
- **Spec source:** `### CLI` — timeout race
- **Observable outcome:** A normal-exit handler arriving after a CLI timeout cannot replace the committed `timed-out` state.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Release the deterministic child normal-exit callback after timeout has committed, and observe the final result remains `timed-out` with the later completion ignored/rejected.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-timeout.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-029

- **Stage:** 3
- **Spec source:** `### CLI` — unproven isolation
- **Observable outcome:** A CLI route whose tool-free behaviour cannot be proven on the target runtime is unavailable and receives no seat dispatch.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Make the denial probe unsupported, inconclusive and unexpectedly successful in turn; observe the route unavailable with zero motion dispatches in every case.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-isolation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-036

- **Stage:** 3
- **Spec source:** `### CLI` — normal exit fixture
- **Observable outcome:** A trusted CLI backend that passes isolation and exits normally returns one structured successful seat result.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the deterministic normal-exit subprocess fixture through each CLI transport and observe one successful result with captured identity, status, timing and parsed answer.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/execution/cli-normal-exit.test.ts"]`
- **Negative/error coverage:** AC-INT-029, AC-INT-030, AC-INT-026
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-020

- **Stage:** 3
- **Spec source:** `### Ordinary second opinion` — round count
- **Observable outcome:** An ordinary second-opinion run executes exactly one analysis round.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Execute the canonical ordinary-motion fixture with all seats succeeding and observe exactly one round in the manifest, dispatch log and result record.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/ordinary.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-021
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-021

- **Stage:** 3
- **Spec source:** `### Ordinary second opinion` — blind analysis
- **Observable outcome:** No ordinary first-round seat payload contains another seat response.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the ordinary fixture with unique per-seat response sentinels, capture every outbound payload, and observe no peer-response sentinel in any first-round payload.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/ordinary.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-022

- **Stage:** 3
- **Spec source:** `### Ordinary second opinion` — normal quorum
- **Observable outcome:** An ordinary run resolves normally only with at least three successful distinct provider families.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the family/quorum matrix with verified identities and observe normal completion at three or more distinct successful families and no normal completion below three.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/ordinary.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-042, AC-LOGIC-048
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-023

- **Stage:** 3
- **Spec source:** `### Ordinary second opinion` — structured result
- **Observable outcome:** A successful ordinary seat answer contains recommendation, evidence, assumptions, risks, uncertainty and a decisive test.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse canonical ordinary provider outputs and observe all six required answer fields in each successful seat response.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/ordinary.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-024

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — blind first round
- **Observable outcome:** No significant-motion round-one seat payload contains another seat response.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the significant fixture with unique per-seat response sentinels, capture round-one payloads, and observe no peer-response sentinel in any of them.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/significant.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-025

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — rebuttal evidence
- **Observable outcome:** Every significant-motion round-two seat receives the same validated evidence pack used in round one.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run two rounds with a hashed canonical evidence pack, capture all seat payloads, and observe the identical evidence hash/content in every round-one and round-two payload.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/significant.test.ts"]`
- **Negative/error coverage:** AC-DATA-002
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-026

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — rebuttal context
- **Observable outcome:** Every significant-motion round-two seat receives the normalised valid round-one responses.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run round one with uniquely identifiable valid responses, capture round-two payloads, and observe the same schema-normalised round-one response set in each.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/significant.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-027

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — optional resolution round
- **Observable outcome:** Round three starts only when both a material disagreement and a specific resolving question remain after rebuttal.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the four-condition matrix for disagreement present/absent and resolving question present/absent; observe round three only in the both-present case.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/resolution.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-028

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — round cap
- **Observable outcome:** No standing-council run executes more than three rounds.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Keep disagreement unresolved after round three in a deterministic fixture and observe no fourth dispatch and a three-round maximum in the manifest/record.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/resolution.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-029

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — normal family quorum
- **Observable outcome:** Normal significant-motion resolution requires at least four successful distinct provider families.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the significant family matrix with verified identities and all other obligations met; observe normal resolution at four or more distinct successful families and no normal resolution below four.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/significant.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-042, AC-LOGIC-048
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-030

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — contrarian obligation
- **Observable outcome:** Normal significant-motion resolution requires a successful response from the assigned contrarian lens.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Hold four-family, verified-identity and rebuttal requirements satisfied while toggling only contrarian success, and observe normal resolution only when the contrarian response is valid and successful.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/significant.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-039, AC-LOGIC-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-031

- **Stage:** 3
- **Spec source:** `### Significant standing-council motion` — rebuttal obligation
- **Observable outcome:** Normal significant-motion resolution requires at least three valid rebuttals.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Hold family, identity and contrarian requirements satisfied while varying valid rebuttal count, and observe normal resolution only at three or more.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/significant.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-039, AC-LOGIC-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-032

- **Stage:** 3
- **Spec source:** `## Round protocol` — chair framing
- **Observable outcome:** A run without a chair-supplied validated motion cannot dispatch a provider seat.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Attempt run creation with missing and malformed chair motion fixtures plus a provider spy, and observe structured rejection with zero dispatches.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/chair-control.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-033

- **Stage:** 3
- **Spec source:** `## Round protocol` — chair evidence approval
- **Observable outcome:** Evidence not explicitly approved by the chair is not included in any seat payload.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Attach a valid but unapproved evidence pack, execute planning with capture adapters, and observe the evidence absent and no transmission of that pack.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/chair-control.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-034

- **Stage:** 3
- **Spec source:** `## Round protocol` — chair opens rounds
- **Observable outcome:** A later round cannot dispatch until the chair records an open-round action for that round.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Complete the prior round, withhold then supply the chair open action, and observe zero later-round dispatches before the action and expected dispatches after it.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/chair-control.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-035

- **Stage:** 3
- **Spec source:** `## Round protocol` — chair adjudication
- **Observable outcome:** A recorded normal resolution contains the host chair adjudication separately from seat responses.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Complete a valid-quorum fixture, submit a chair adjudication, persist the result, and observe the adjudication under chair result with seat responses unchanged.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/chair-control.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-036, AC-LOGIC-037
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-036

- **Stage:** 3
- **Spec source:** `## Round protocol` — non-voting chair
- **Observable outcome:** Adding chair synthesis or adjudication never increases independent-family vote count.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Compute quorum before and after adding chair synthesis/adjudication to the same run and observe an identical vote count.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/chair.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-037

- **Stage:** 3
- **Spec source:** `## Round protocol` — failed-quorum synthesis
- **Observable outcome:** Chair synthesis cannot change failed quorum into `completed` or consensus.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Supply an affirmative chair synthesis to below-threshold ordinary and significant fixtures and observe the quorum result unchanged and not completed.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/chair.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-038

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — completed
- **Observable outcome:** A run is `completed` only when all quorum, verified-identity and round obligations for its motion class are met.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the obligation truth table for ordinary and significant motions and observe `completed` only on rows where every required obligation is true.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/outcomes.test.ts"]`
- **Negative/error coverage:** AC-INT-032, AC-LOGIC-039, AC-LOGIC-042
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-039

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — degraded
- **Observable outcome:** When the specified minimum usable provider-family floor is met, failure of a required route, verified model identity, lens or round yields terminal `degraded`.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** At the specified two-family ordinary floor and three-family significant floor, run four fixtures differing only by required-route, identity-verification, required-lens or required-round failure; observe terminal `degraded` in each.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/degraded.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-040

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — immutable degraded result
- **Observable outcome:** Chair acceptance of a degraded result does not rewrite its terminal status to `completed`.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Produce a degraded result, persist separate chair acceptance and append its resolution, then observe the original run status remains `degraded` in memory and persisted records.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/degraded.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-041

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — blocked policy
- **Observable outcome:** A data/provider-policy prohibition terminates the run as `blocked-policy`.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Execute the deterministic non-secret policy-prohibition matrix and observe terminal `blocked-policy` with no provider call.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/outcomes.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-042

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — blocked quorum
- **Observable outcome:** A run below the specified minimum usable independent-family floor terminates as `blocked-quorum` and cannot be accepted as a resolution.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run ordinary fixtures below two families and significant fixtures below three families; observe terminal `blocked-quorum`, then attempt chair acceptance and observe no resolution eligibility.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/preflight.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-043

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — distinct execution results
- **Observable outcome:** Cancellation, timeout and execution failure produce the distinct terminal results `cancelled`, `timed-out` and `failed` respectively.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Trigger deterministic cancellation, deadline and non-timeout execution-failure fixtures and observe the matching distinct terminal result in each.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/outcomes.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-044

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — honest seat health
- **Observable outcome:** Fallback use, missing/unverified identity, timeout or malformed output never yields a healthy original-seat status.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the fallback, unverified-identity, timeout and malformed-output fixtures and observe each marked fallback/degraded/failed as applicable, with none labelled healthy original seat.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/seat-health.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-045

- **Stage:** 3
- **Spec source:** `## Error behaviour` — malformed provider output
- **Observable outcome:** Malformed provider output is recorded as a failed seat and contributes no vote.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Return each malformed response fixture, compute quorum and persist the run, and observe a schema-category failed seat in the audit plus no vote contribution.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/rounds/malformed-output.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-046

- **Stage:** 3
- **Spec source:** `## Error behaviour` — partial audit
- **Observable outcome:** Partial successful seat results remain present in the audit record after another required seat or round fails.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Complete selected seats then fail a required seat/round, persist the result, and observe every completed partial response retained with exact identity/status.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/partial-results.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-047

- **Stage:** 3
- **Spec source:** `## Error behaviour` — partial quorum
- **Observable outcome:** Partial results below normal obligations cannot produce `completed` or silently satisfy normal quorum.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Feed audited partial-result matrices below each normal obligation into quorum evaluation and observe no `completed` outcome and explicit unmet obligations.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/partial-results.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-048

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — minimum usable provider-family floor
- **Observable outcome:** The minimum usable independent-provider-family floor is two for ordinary motions and three for significant motions, making `degraded` and `blocked-quorum` deterministic.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run ordinary and significant boundary fixtures immediately below and at their specified floors; pass only when below-floor runs are `blocked-quorum` and at-floor runs with an unmet normal obligation are `degraded`.
- **Route:** Not applicable — quorum evaluation is a core contract without a browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/floor.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-LOGIC-049

- **Stage:** 3
- **Spec source:** `## Quorum and degraded operation` — terminal results
- **Observable outcome:** Each listed result status is terminal and accepts no later transition.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** For every result status, attempt transitions to queued, running and every other result under the transition API and observe rejection with the original result unchanged.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/domain/run-state.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-032

- **Stage:** 3
- **Spec source:** `## Provider and model registry` — unverified identity quorum
- **Observable outcome:** An identity-unverified successful seat may count its provider family for diversity but forces the run result to `degraded`.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Replace one otherwise valid verified seat with an unverified-identity success while preserving family diversity and all other obligations; observe the family counted and terminal result `degraded`, never `completed`.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/quorum/unverified-identity.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-037

- **Stage:** 3
- **Spec source:** `## Health and model drift` — self-check contract
- **Observable outcome:** Offline self-check validates the import-bundled registry, import-bundled lens catalogue, schemas, package version and immutable source commit.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run self-check service fixtures with each embedded artefact valid and then corrupted one at a time; observe success only for the all-valid fixture and a precise failure for each corrupted component.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/health/self-check.test.ts"]`
- **Negative/error coverage:** AC-CFG-016, AC-OPS-010, AC-OPS-018
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-038

- **Stage:** 3
- **Spec source:** `## Health and model drift` — doctor schema
- **Observable outcome:** Doctor reports route configuration, executable or endpoint resolution, requested model, actual model when observable, tool-isolation support, latency, error category and candidate-successor warnings.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run deterministic HTTP/CLI diagnostic fixtures, parse doctor output, and observe every declared field with actual model absent/unverified where not observable.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/health/doctor.test.ts"]`
- **Negative/error coverage:** AC-SEC-030, AC-INT-031
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-030

- **Stage:** 3
- **Spec source:** `## Health and model drift` — diagnostic secrecy
- **Observable outcome:** Doctor output and diagnostic logs contain no provider credential value.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Configure unique credential sentinels, run success and failure diagnostic fixtures, capture structured output and logs, and observe none of the sentinels.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/health/doctor.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-039

- **Stage:** 3
- **Spec source:** `## Health and model drift` — scheduled health record
- **Observable outcome:** A scheduled health observation records provider family, route, requested model, observed actual model when available, identity verification state, status, latency and error category.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Generate health records from verified-success, unverified-success and failure fixtures, parse them, and observe every required field with optional actual identity represented honestly.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/health/baseline.test.ts"]`
- **Negative/error coverage:** AC-INT-031, AC-INT-041
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-040

- **Stage:** 3
- **Spec source:** `## Health and model drift` — regression baseline
- **Observable outcome:** Health regression comparison uses the last-known-good route and model identity as its comparison baseline.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Seed a last-known-good baseline, vary current route and identity independently, and observe comparison against the seeded route/identity rather than mere answer presence.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/health/baseline.test.ts"]`
- **Negative/error coverage:** AC-INT-041
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-041

- **Stage:** 3
- **Spec source:** `## Health and model drift` — unintended downgrade
- **Observable outcome:** A response from an unintended downgraded route or model cannot report healthy.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Return a valid answer from a route/model different from the last-known-good identity without an approved route change and observe a regression/unhealthy result naming the drift.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/health/baseline.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-001

- **Stage:** 4
- **Spec source:** `## Product surface` — compiled entry
- **Observable outcome:** The public package exposes its runtime command surface through the single compiled entry `dist/cli.js`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Inspect packaged executable registrations and runtime imports, then observe every public command resolves to `dist/cli.js` and no second compiled engine entry is exposed.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/product-surface.test.ts"]`
- **Negative/error coverage:** AC-API-024, AC-OPS-038
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-002

- **Stage:** 4
- **Spec source:** `## Product surface` — `self-check --json`
- **Observable outcome:** `self-check --json` returns structured JSON validating bundled schemas/registries and reporting package version and source commit without contacting a provider.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Disable networking, execute the compiled command, parse stdout as the self-check schema, and observe successful component checks plus package version/source commit and zero network attempts.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "--no-install", "dist/cli.js", "self-check", "--json"]`
- **Negative/error coverage:** AC-API-015, AC-OPS-026
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-003

- **Stage:** 4
- **Spec source:** `## Product surface` — `doctor --json`
- **Observable outcome:** `doctor --json` returns the structured live route diagnostic contract.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Execute doctor against deterministic configured, disabled and failed-route fixtures, parse stdout, and observe the doctor schema including honest observed/unverified identity and isolation support.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/doctor.test.ts"]`
- **Negative/error coverage:** AC-API-015, AC-SEC-030
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-004

- **Stage:** 4
- **Spec source:** `## Product surface` — `health --json`
- **Observable outcome:** `health --json` returns a structured result compatible with the stored health-baseline schema.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Seed a deterministic last-known-good baseline, execute the compiled health command through its CLI fixture, and observe parseable baseline-compatible status and drift fields.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/health.test.ts"]`
- **Negative/error coverage:** AC-API-015, AC-INT-041
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-005

- **Stage:** 4
- **Spec source:** `## Product surface` — `second-opinion`
- **Observable outcome:** The `second-opinion` command executes the ordinary one-round protocol through the core engine.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Invoke the compiled command with a public-classification ordinary-motion fixture and three fake independent families, then observe one blind round and a structured core result.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/second-opinion.test.ts"]`
- **Negative/error coverage:** AC-API-015, AC-LOGIC-042
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-006

- **Stage:** 4
- **Spec source:** `## Product surface` — `council`
- **Observable outcome:** The `council` command executes the chaired multi-round protocol through the core engine.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Invoke the compiled command with a public significant-motion fixture, fake provider responses and chair actions, then observe blind analysis, rebuttal and a structured adjudicated core result.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/council.test.ts"]`
- **Negative/error coverage:** AC-API-015, AC-LOGIC-039, AC-LOGIC-042
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-007

- **Stage:** 4
- **Spec source:** `## Product surface` — `migrate-general plan`
- **Observable outcome:** `migrate-general plan` exposes the generic no-write migration plan through the compiled CLI.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Invoke the compiled plan command with a caller taxonomy/match-rules fixture and snapshotted source store; observe structured destinations plus unresolved bucket and byte-identical stores.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/migrate-general.test.ts"]`
- **Negative/error coverage:** AC-API-015, AC-DATA-015
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-008

- **Stage:** 4
- **Spec source:** `## Product surface` — `migrate-general apply`
- **Observable outcome:** `migrate-general apply` exposes approval-gated append-preserving migration through the compiled CLI.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Invoke apply with a valid approved plan hash and authorisation fixture, then observe immutable archive creation, verified atomic appends and preserved source.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/migrate-general.test.ts"]`
- **Negative/error coverage:** AC-API-015, AC-DATA-016, AC-DATA-017, AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-009

- **Stage:** 4
- **Spec source:** `## Product surface` — Claude Code facade
- **Observable outcome:** Each compatible Claude Code command maps its intent to the compiled CLI and returns the CLI result without provider execution logic in the facade.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run the command-intent mapping fixture for every retained Claude Code command, capture invocation/result, and observe one `dist/cli.js` call with equivalent intent and no direct provider call.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/facades/claude-code.test.ts"]`
- **Negative/error coverage:** AC-API-024
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-010

- **Stage:** 4
- **Spec source:** `## Product surface` — OMP facade
- **Observable outcome:** Each OMP-compatible skill maps its intent to the compiled CLI and contains no provider execution logic.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Inspect and exercise every OMP facade fixture, and observe instructions target `dist/cli.js`, map the declared intent and define no provider transport/orchestration branch.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/facades/omp.test.ts"]`
- **Negative/error coverage:** AC-API-024
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-011

- **Stage:** 4
- **Spec source:** `## Classification and fail-closed routing` — classification disclosure
- **Observable outcome:** Before a provider request, the invoking facade discloses the run effective classification.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Pause a fake provider before request, invoke each execution facade, and observe the exact effective classification in disclosure output before releasing the request.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/facades/disclosure.test.ts"]`
- **Negative/error coverage:** AC-API-017, AC-SEC-027
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-012

- **Stage:** 4
- **Spec source:** `## Classification and fail-closed routing` — destination disclosure
- **Observable outcome:** Before a provider request, the invoking facade discloses every selected provider family and endpoint destination.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Pause fake providers before request, invoke each facade with a known route set, and observe the exact family/endpoint set disclosed before any request.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/facades/disclosure.test.ts"]`
- **Negative/error coverage:** AC-POL-008, AC-POL-009, AC-INT-011
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-013

- **Stage:** 4
- **Spec source:** `## Classification and fail-closed routing` — evidence disclosure
- **Observable outcome:** Before a provider request, the invoking facade discloses whether evidence is included.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Invoke each facade once with approved evidence and once without, pause before request, and observe `included` only for the approved-evidence run.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/facades/disclosure.test.ts"]`
- **Negative/error coverage:** AC-LOGIC-033
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-014

- **Stage:** 4
- **Spec source:** `## Classification and fail-closed routing` — redaction/block disclosure
- **Observable outcome:** Before any allowed provider request, the invoking facade discloses redaction status; a blocked run discloses blocking status and sends no request.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run clean, redacted and policy/secret-blocked fixtures with a provider spy, and observe the matching disclosure before allowed requests plus zero requests for blocked cases.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/facades/disclosure.test.ts"]`
- **Negative/error coverage:** AC-POL-003, AC-POL-006, AC-SEC-011, AC-SEC-015
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-015

- **Stage:** 4
- **Spec source:** `## Error behaviour` — structured CLI input errors
- **Observable outcome:** Invalid CLI input produces a structured error matching the public error schema.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Invoke every subcommand with missing, malformed and unknown-enum fixtures, parse stderr/stdout according to the CLI contract, and observe a structured validation error for each.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/errors.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-016

- **Stage:** 4
- **Spec source:** `## Error behaviour` — invalid-input exit status
- **Observable outcome:** Invalid CLI input exits with a non-zero status.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Invoke every subcommand with its deterministic invalid-input fixture and observe a non-zero process exit status.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/errors.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-017

- **Stage:** 4
- **Spec source:** `## Error behaviour` — missing policy preflight
- **Observable outcome:** A project-scoped CLI run missing applicable policy blocks before any external request.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Invoke second-opinion and council with project scope but no policy against request spies, and observe a blocking structured result plus zero external requests.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/preflight.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-018

- **Stage:** 4
- **Spec source:** `## Error behaviour` — impossible quorum preflight
- **Observable outcome:** A CLI run below the specified minimum usable family floor returns `blocked-quorum` before any external request.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Invoke ordinary fixtures below two eligible families and significant fixtures below three, with request spies; observe `blocked-quorum` plus zero requests.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/preflight.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-019

- **Stage:** 4
- **Spec source:** `## Error behaviour` — provider failure output
- **Observable outcome:** A provider failure retains exact requested/observed identity state and failure category through the CLI output.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Return each provider failure fixture through second-opinion and council, parse CLI output, and observe the core failure category and identity fields unchanged.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/provider-errors.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-020

- **Stage:** 4
- **Spec source:** `## Error behaviour` — cancellation output
- **Observable outcome:** Cancelling a live CLI invocation yields observable terminal `cancelled` output distinct from timeout and failure.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Start the deterministic hanging command fixture, send cancellation to the live process, and observe terminal `cancelled`, non-success exit and no surviving child process.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/cancellation.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-021

- **Stage:** 4
- **Spec source:** `## Error behaviour` — timeout output
- **Observable outcome:** A live CLI invocation that reaches its deadline yields observable terminal `timed-out` output distinct from cancellation and failure.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Run the deterministic hanging fixture under a controlled deadline and observe terminal `timed-out`, non-success exit and no surviving child process.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/timeout.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-022

- **Stage:** 4
- **Spec source:** `## Non-goals` — no durable asynchronous API
- **Observable outcome:** The compiled CLI exposes no durable asynchronous `jobs`, `result` or `cancel` subcommand/API.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Inspect the command schema and invoke each prohibited subcommand name; observe none registered and each invocation rejected as an unknown command.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/no-durable-jobs.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-023

- **Stage:** 4
- **Spec source:** `## Non-goals` — live-process cancellation
- **Observable outcome:** Cancellation acts only on the current live invocation and cannot target a persisted job identifier across invocations.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Terminate one invocation, start a fresh process and attempt cancellation using prior process/session data; observe no job lookup/store and no effect on the new invocation.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cli/no-durable-jobs.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-API-024

- **Stage:** 4
- **Spec source:** `## Product surface` — thin facades
- **Observable outcome:** Claude Code and OMP facades contain no duplicate provider adapter, round runner, quorum or persistence implementation.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Run the facade import/dependency audit and observe every facade depends on the compiled/core entry while no forbidden execution-core symbol or transport implementation exists in facade files.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/architecture/facades.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-019

- **Stage:** 4
- **Spec source:** `### Layers` — architecture separation
- **Observable outcome:** The release candidate exposes separate domain, policy, records, execution, evidence, health and facade modules with the declared inward dependency direction.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the architecture inventory/import-graph test and observe each declared layer present, each public responsibility owned once, facades depending inward, and no domain/policy dependency on host content.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/architecture/layers.test.ts"]`
- **Negative/error coverage:** AC-CFG-011, AC-API-024
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-005

- **Stage:** 4
- **Spec source:** `## Packaging` — release toolchain
- **Observable outcome:** Release CI and package metadata require Bun version exactly `1.3.14`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the release-toolchain validator against CI configuration, lock metadata and package engines, and observe exact `1.3.14` with ranges/newer versions rejected.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/toolchain.ts"]`
- **Negative/error coverage:** AC-OPS-006
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-006

- **Stage:** 4
- **Spec source:** `## Packaging` — release toolchain mismatch
- **Observable outcome:** A release candidate cannot build when the active Bun version differs from `1.3.14`.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the release preflight with deterministic reported-version fixtures below and above `1.3.14`, and observe non-zero refusal before bundle generation.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/toolchain.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-007

- **Stage:** 4
- **Spec source:** `## Packaging` — committed entry
- **Observable outcome:** The prescribed Bun build command produces the committed release entry `dist/cli.js`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Execute the prescribed build on the designated build platform and observe `dist/cli.js` created, tracked by the release manifest and runnable as the command entry.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "build", "src/cli.ts", "--target=bun", "--outfile", "dist/cli.js"]`
- **Negative/error coverage:** AC-OPS-020
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-008

- **Stage:** 4
- **Spec source:** `## Packaging` — bundled dependencies
- **Observable outcome:** Every runtime package dependency is embedded in `dist/cli.js`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Inspect the build metafile/import graph and run the clean-cache smoke; observe no runtime package import resolved outside the bundle.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/bundle-contents.test.ts"]`
- **Negative/error coverage:** AC-OPS-012, AC-OPS-013, AC-OPS-014
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-009

- **Stage:** 4
- **Spec source:** `## Packaging` — bundled registry
- **Observable outcome:** The validated model registry is imported into `dist/cli.js` rather than loaded from repository files at runtime.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Remove source/data files from a copied clean cache, disable filesystem fallback/network, execute self-check, and observe registry validation succeeds from bundled content.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/bundle-contents.test.ts"]`
- **Negative/error coverage:** AC-OPS-010
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-010

- **Stage:** 4
- **Spec source:** `## Packaging` — bundled lens catalogue
- **Observable outcome:** The validated lens catalogue is imported into `dist/cli.js` rather than loaded from repository files at runtime.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Remove source/data files from a copied clean cache, disable filesystem fallback/network, execute self-check, and observe lens-catalogue validation succeeds from bundled content.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/bundle-contents.test.ts"]`
- **Negative/error coverage:** AC-OPS-011
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-011

- **Stage:** 4
- **Spec source:** `## Packaging` — filesystem override boundary
- **Observable outcome:** At runtime the bundle reads only an explicitly configured user-level override, never a repository-controlled registry/lens/policy file.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Seed conflicting repository-level and explicit user-level override fixtures, capture filesystem reads, and observe only the explicit user-level override read and applied.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/runtime-imports.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-012

- **Stage:** 4
- **Spec source:** `## Packaging` — no `node_modules` requirement
- **Observable outcome:** The installed plugin executes successfully when `node_modules` is absent.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Create a clean plugin-cache copy containing release artefacts but no `node_modules`, execute offline self-check, and observe successful JSON output.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-013

- **Stage:** 4
- **Spec source:** `## Packaging` — no global package-cache requirement
- **Observable outcome:** The installed plugin executes successfully with an empty isolated global package cache.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Run the clean-cache smoke with global Bun/package cache paths pointed to empty isolated directories and observe successful offline self-check.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-014

- **Stage:** 4
- **Spec source:** `## Packaging` — no network package resolution
- **Observable outcome:** The installed plugin performs no network package resolution at runtime.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Deny networking and capture connection attempts while executing the clean-cache self-check, and observe success with zero package/network resolution attempts.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-015

- **Stage:** 4
- **Spec source:** `## Packaging` — bundled entry execution
- **Observable outcome:** A fresh plugin cache executes only the bundled release entry for runtime commands.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Create a release-only cache, invoke each command through facade fixtures with execution tracing, and observe `dist/cli.js` as the sole product-code entry.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** AC-API-024, AC-OPS-038
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-016

- **Stage:** 4
- **Spec source:** `## Non-goals` — no Node.js runtime
- **Observable outcome:** The installed plugin starts and runs offline self-check with no Node.js executable available.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Run the clean-cache smoke in an environment exposing Bun but no Node executable, and observe successful self-check plus no Node process attempt.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-017

- **Stage:** 4
- **Spec source:** `## Packaging` — hardened offline self-check
- **Observable outcome:** With networking unavailable and environment-file loading disabled, the committed bundle passes offline self-check using no installation.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Deny networking, place misleading secrets/config in an environment file, execute the exact hardened command, parse JSON and observe success using bundled data with no env-file value or network access.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "--no-install", "--no-env-file", "dist/cli.js", "self-check", "--json"]`
- **Negative/error coverage:** AC-OPS-012, AC-OPS-013, AC-OPS-014, AC-OPS-026, AC-OPS-028
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-018

- **Stage:** 4
- **Spec source:** `## Packaging` — doctor separation
- **Observable outcome:** Offline self-check performs no live route check; networked route diagnostics remain under `doctor`.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Capture network calls while running self-check then doctor against a fake endpoint; observe zero self-check calls and diagnostic calls only from doctor.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/offline-boundary.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-019

- **Stage:** 4
- **Spec source:** `## Packaging` — source/test runtime imports
- **Observable outcome:** Source and test files are not imported at runtime by the committed bundle.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Remove source/tests from a release-cache copy, trace module/filesystem resolution while running every offline command fixture, and observe no source/test import attempt.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/runtime-imports.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-020

- **Stage:** 4
- **Spec source:** `## Packaging` — deterministic designated build
- **Observable outcome:** Two release builds on the designated build platform from the same immutable source commit are byte-identical.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Build twice from clean trees on the designated platform using Bun 1.3.14 and compare hashes; observe identical `dist/cli.js` bytes.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/rebuild-byte-identity.ts"]`
- **Negative/error coverage:** AC-OPS-006
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-021

- **Stage:** 4
- **Spec source:** `## Packaging` — line-ending protection
- **Observable outcome:** `.gitattributes` marks `dist/cli.js -text`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse `.gitattributes` with the packaging validator and observe an effective `-text` rule for the committed bundle path.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/gitattributes.test.ts"]`
- **Negative/error coverage:** AC-OPS-020
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-022

- **Stage:** 4
- **Spec source:** `## Packaging` — Windows bundle policy
- **Observable outcome:** The Windows acceptance leg executes the committed `dist/cli.js` rather than rebuilding it for byte comparison.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Inspect/run the Windows CI fixture and observe commands consume the checked-out committed bundle with no bundle-build or cross-platform byte assertion step; add a rebuild step to a copied fixture and observe validation fail.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/ci-matrix.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-023

- **Stage:** 4
- **Spec source:** `## Packaging` — Linux bundle policy
- **Observable outcome:** The Linux acceptance leg executes the committed `dist/cli.js` rather than rebuilding it for byte comparison.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Inspect/run the Linux CI fixture and observe commands consume the checked-out committed bundle with no cross-platform byte assertion outside the designated build job; add a second build to a copied non-designated leg and observe validation fail.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/packaging/ci-matrix.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-024

- **Stage:** 4
- **Spec source:** `## Packaging` — cross-platform check boundary
- **Observable outcome:** `bun run check` is cross-platform and does not invoke the temporary legacy Bats/ShellCheck gate.
- **Case:** negative
- **Tier:** e2e
- **Verification method:** Run `check` with Bats and ShellCheck unavailable while tracing subprocesses; observe a zero status for valid code and no Bats/ShellCheck invocation.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "run", "check"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-025

- **Stage:** 4
- **Spec source:** `## Packaging` — legacy check boundary
- **Observable outcome:** `bun run check:legacy` runs the legacy Bats and ShellCheck gate only on supported POSIX CI.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run the legacy CI fixture on supported POSIX and observe both Bats and ShellCheck invoked; inspect Windows/non-POSIX matrix fixtures and observe the script not scheduled there.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "run", "check:legacy"]`
- **Negative/error coverage:** AC-OPS-024, AC-OPS-038
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-026

- **Stage:** 4
- **Spec source:** `## Packaging` — fork release version
- **Observable outcome:** The release-candidate version differs from upstream version `2026.7.9`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse package/plugin release metadata and observe a valid candidate version not equal to `2026.7.9`.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/identity.ts"]`
- **Negative/error coverage:** AC-OPS-030
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-027

- **Stage:** 4
- **Spec source:** `## Packaging` — package/plugin version parity
- **Observable outcome:** Package and Claude plugin metadata report the identical release-candidate version.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse both metadata files and observe exact version-string equality.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/identity.ts"]`
- **Negative/error coverage:** AC-OPS-030
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-028

- **Stage:** 4
- **Spec source:** `## Packaging` — exact source commit
- **Observable outcome:** Self-check reports the immutable source commit from which the committed bundle was built.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Build from a known immutable commit, execute self-check, and observe its source-commit field exactly equals that commit and the release manifest.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "--no-install", "--no-env-file", "dist/cli.js", "self-check", "--json"]`
- **Negative/error coverage:** AC-OPS-029
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-029

- **Stage:** 4
- **Spec source:** `## Goals` item 10 — stale-cache identity
- **Observable outcome:** A host can distinguish a stale bundle from the current release candidate using the pair of reported version and immutable source commit.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Compare self-check output from prior and current candidate cache fixtures and observe distinct version and/or source-commit identity, with the current pair matching release metadata.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/release/cache-identity.test.ts"]`
- **Negative/error coverage:** AC-OPS-030
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-030

- **Stage:** 4
- **Spec source:** `## Goals` item 10 — new release candidate identity
- **Observable outcome:** A source-changing release candidate cannot reuse the preceding candidate version/source-commit pair.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run release identity validation against fixtures with changed source plus reused version or commit and observe refusal; observe acceptance only for a new version paired with the new immutable commit.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/identity.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-031

- **Stage:** 4
- **Spec source:** `## Purpose` — maintained-fork metadata
- **Observable outcome:** Package author, repository, homepage and marketplace ownership identify the maintained `AnnasCookies/claude-council` fork rather than upstream ownership.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Parse package, plugin and marketplace metadata and observe maintained-fork ownership in every declared ownership field while upstream remains attribution only.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/release/identity.ts"]`
- **Negative/error coverage:** AC-OPS-003, AC-OPS-004
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-032

- **Stage:** 4
- **Spec source:** `### Packaging and integration` — plugin validation
- **Observable outcome:** The release-candidate Claude Code plugin manifest validates successfully.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the Claude plugin validator at repository root and observe a zero exit status with no manifest error.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["claude", "plugin", "validate", "."]`
- **Negative/error coverage:** AC-API-015
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-033

- **Stage:** 4
- **Spec source:** `### Packaging and integration` — legacy compatibility gate
- **Observable outcome:** Compatible existing public behaviours remain covered and passing until legacy removal.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run the complete Bats compatibility suite on supported POSIX CI before cutover and observe all retained-intent tests pass; break one retained intent in a copied fixture and observe the suite fail.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bash", "tests/run_tests.sh"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-034

- **Stage:** 4
- **Spec source:** `### Packaging and integration` — clean-cache package smoke
- **Observable outcome:** A fresh installed-plugin cache with release artefacts only starts the committed bundle and passes hardened offline self-check.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Construct a cache containing the manifest/facades/committed bundle but no dependency tree or source, deny networking and env-file loading, then observe successful parsed self-check.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** AC-OPS-012, AC-OPS-013, AC-OPS-014, AC-OPS-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-SEC-031

- **Stage:** 4
- **Spec source:** `## Public plugin safety` item 6
- **Observable outcome:** The release package and runtime logs contain no secret value or private record content.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Build/package and exercise success/failure paths using seeded secret/private-record controls, scan archive bytes and captured logs, and observe no control value outside the detector test fixtures.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security/package-privacy.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-035

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — core/facade gate
- **Observable outcome:** Legacy provider/orchestration deletion is refused until core and facade acceptance evidence is complete.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the cutover gate with core or facade evidence missing/failed and observe refusal with legacy files untouched; supply valid evidence and observe this gate clears.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cutover/gates.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-036

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — clean-cache gate
- **Observable outcome:** Legacy provider/orchestration deletion is refused until a clean installed-plugin cache has run the committed bundle successfully.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the cutover gate without valid AC-OPS-034 evidence and observe refusal with legacy files untouched; supply matching clean-cache evidence and observe this gate clears.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/cutover/gates.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-037

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — real host parity
- **Observable outcome:** A real private host adapter completes every specification-defined parity smoke scenario against the exact public release-candidate source, version and commit before legacy deletion.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** From the external private host, capture evidence for exact installed identity, cache-only self-check, harmless second-opinion and ordinary-council execution, honest status and identity, pre-provider private-policy blocking, health/drift consumption, absence of private public records and absence of direct legacy callers; public fake adapters cannot satisfy this criterion.
- **Route:** Not applicable — the private host adapter is external to this public repository.
- **Command:** Not applicable — the authoritative parity invocation and evidence live in the private host, not this repository.
- **Negative/error coverage:** Not applicable — any parity mismatch fails this same manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-OPS-037` decision record naming the private host, exact public package version/source commit and observed result for every specification-defined scenario; legacy deletion remains blocked until explicit parity approval is recorded.

### AC-OPS-038

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — legacy callers
- **Observable outcome:** No remaining command, skill, hook, script, test or package entry references the legacy execution engine.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Run the syntax-aware legacy-reference scanner across all packaged/runtime callers and observe zero references outside the historical migration fixture.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/cutover/no-legacy-references.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-039

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — ordered deletion
- **Observable outcome:** Legacy provider and orchestration scripts are absent only after all four cutover gates have passed.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Validate cutover evidence for core/facade, clean cache, AC-OPS-037 host parity and no callers, then inspect the release tree and observe legacy provider/orchestration files absent with gate evidence preceding deletion.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/cutover/verify.ts"]`
- **Negative/error coverage:** AC-OPS-035, AC-OPS-036, AC-OPS-037, AC-OPS-038
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-040

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — no compatibility shim
- **Observable outcome:** No post-cutover compatibility shim forwards to or emulates the legacy engine.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Run the cutover architecture scanner over command/facade/runtime files and observe no legacy-name shim, forwarding branch or emulation module.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/cutover/verify.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-041

- **Stage:** 5
- **Spec source:** `## Compatibility and cutover` — single execution engine
- **Observable outcome:** The post-cutover package contains exactly one provider/round execution engine: the Bun/TypeScript core used by `dist/cli.js`.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the execution-engine inventory against the release tree and dependency graph and observe one core implementation with all facades pointing to it.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/cutover/verify.ts"]`
- **Negative/error coverage:** AC-OPS-040, AC-OPS-042
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-042

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 10 — public/private duplication
- **Observable outcome:** After host parity, the private host consumes the public release-candidate engine and contains no duplicate provider adapter, round runner, quorum or generic-record implementation.
- **Case:** negative
- **Tier:** manual-required
- **Verification method:** Inspect the external private host dependency/runtime graph after AC-OPS-037, exercise a parity scenario, and record pass only when execution enters the exact public RC bundle and no duplicate public-core implementation exists in the host.
- **Route:** Not applicable — the private host implementation is external to this public repository.
- **Command:** Not applicable — the authoritative dependency/runtime evidence must be produced in the private host.
- **Negative/error coverage:** Self
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-OPS-042` decision record referencing approved AC-OPS-037 evidence, the private-host dependency/runtime inspection and the exact public version/source commit; public/private duplication remains an open blocker until explicitly eliminated and approved.

### AC-OPS-043

- **Stage:** 5
- **Spec source:** `## Packaging` — temporary legacy gate removal
- **Observable outcome:** After legacy removal, the temporary `check:legacy` Bats/ShellCheck gate is no longer part of the release pipeline.
- **Case:** negative
- **Tier:** structural
- **Verification method:** Inspect final package scripts and CI jobs after verified cutover and observe no scheduled `check:legacy`, Bats or legacy ShellCheck gate while `bun run check` remains.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/cutover/verify.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-044

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Windows process termination
- **Observable outcome:** On Windows, cancelling a live CLI seat terminates its complete subprocess tree before returning.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Run the committed bundle against the Windows parent/child hang fixture, cancel the live invocation, and observe parent and descendant processes exited before terminal `cancelled` output.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/process-tree.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-045

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Windows process timeout
- **Observable outcome:** On Windows, timing out a live CLI seat terminates its complete subprocess tree before returning.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Run the committed bundle against the Windows parent/child hang fixture, reach its deadline, and observe parent and descendant processes exited before terminal `timed-out` output.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/process-tree.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-046

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Linux process termination
- **Observable outcome:** On Linux, cancelling a live CLI seat terminates its complete subprocess tree before returning.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Run the committed bundle against the Linux parent/child hang fixture, cancel the live invocation, and observe parent and descendant processes exited before terminal `cancelled` output.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/process-tree.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-047

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Linux process timeout
- **Observable outcome:** On Linux, timing out a live CLI seat terminates its complete subprocess tree before returning.
- **Case:** error
- **Tier:** e2e
- **Verification method:** Run the committed bundle against the Linux parent/child hang fixture, reach its deadline, and observe parent and descendant processes exited before terminal `timed-out` output.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/process-tree.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-048

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Windows paths
- **Observable outcome:** On Windows, supported plugin-cache, user-override and record paths resolve without POSIX-only assumptions.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Execute the committed bundle on the Windows path fixture including spaces and canonical repository identity, and observe successful override discovery and record read/write at the expected Windows locations.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/paths.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-049

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Linux paths
- **Observable outcome:** On Linux, supported plugin-cache, user-override and record paths resolve without Windows-only assumptions.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Execute the committed bundle on the Linux path fixture including spaces and canonical repository identity, and observe successful override discovery and record read/write at the expected Linux locations.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/paths.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-050

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Windows atomic writes
- **Observable outcome:** On Windows, record and migration writes remain atomic under every declared failpoint.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run record/migration failpoint fixtures on Windows with concurrent reads and observe only prior complete state or fully verified new records, never partial files.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/atomic-writes.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-051

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Linux atomic writes
- **Observable outcome:** On Linux, record and migration writes remain atomic under every declared failpoint.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run record/migration failpoint fixtures on Linux with concurrent reads and observe only prior complete state or fully verified new records, never partial files.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration/atomic-writes.test.ts"]`
- **Negative/error coverage:** AC-DATA-022
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-052

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Windows bundle start-up
- **Observable outcome:** On Windows, the committed bundle starts from a fresh plugin cache and passes hardened offline self-check.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** On the Windows CI leg, create a clean release-only cache with networking/env-file loading disabled, execute the committed entry and observe successful parsed self-check.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** AC-OPS-012, AC-OPS-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-053

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — Linux bundle start-up
- **Observable outcome:** On Linux, the committed bundle starts from a fresh plugin cache and passes hardened offline self-check.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** On the Linux CI leg, create a clean release-only cache with networking/env-file loading disabled, execute the committed entry and observe successful parsed self-check.
- **Route:** Not applicable — command-line surface has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** AC-OPS-012, AC-OPS-016
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-042

- **Stage:** 5
- **Spec source:** `### Live smoke` — ordinary family attempts
- **Observable outcome:** When sufficient live routes are configured, a harmless explicitly public ordinary motion attempts at least three independent provider families; otherwise no ordinary live-route claim is made.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** In an external credentialled environment, record route availability, run the ordinary live-smoke command when at least three families are available, and inspect destination/attempt evidence; if fewer are available, record that fact and verify no live claim is published.
- **Route:** Not applicable — provider live smoke is a CLI/external-provider flow, not a browser or HTTP application route.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "ordinary"]`
- **Negative/error coverage:** Not applicable — provider unavailability is handled by the same conditional manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-INT-042` decision record listing configured families and either evidence of at least three distinct-family attempts for the harmless public motion or an explicit unavailable/no-live-claim observation; absent credentials must not be represented as a successful smoke.

### AC-INT-043

- **Stage:** 5
- **Spec source:** `### Live smoke` — significant family attempts
- **Observable outcome:** When four live families are configured, a harmless explicitly public significant motion attempts four independent provider families; otherwise no significant live-route claim is made.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** In an external credentialled environment, record route availability, run the significant live-smoke command when four families are available, and inspect destination/attempt evidence; if fewer are available, record that fact and verify no live claim is published.
- **Route:** Not applicable — provider live smoke is a CLI/external-provider flow, not a browser or HTTP application route.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "significant"]`
- **Negative/error coverage:** Not applicable — provider unavailability is handled by the same conditional manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-INT-043` decision record listing configured families and either evidence of four distinct-family attempts for the harmless public motion or an explicit unavailable/no-live-claim observation.

### AC-INT-044

- **Stage:** 5
- **Spec source:** `### Live smoke` — live rebuttals
- **Observable outcome:** When the significant live smoke runs, its second round attempts rebuttals using normalised first-round responses.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** Run the external significant smoke, inspect round manifests and captured disclosed hashes, and record pass only when round two is opened and attempted with normalised round-one responses; if live smoke is unavailable, record no claim.
- **Route:** Not applicable — provider live smoke is a CLI/external-provider flow, not a browser or HTTP application route.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "significant"]`
- **Negative/error coverage:** Not applicable — absence of live routes is recorded by this conditional manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-INT-044` decision record referencing AC-INT-043 and either the observed round-two rebuttal attempt evidence or an explicit unavailable/no-live-claim observation.

### AC-INT-045

- **Stage:** 5
- **Spec source:** `### Live smoke` — live contrarian coverage
- **Observable outcome:** When the significant live smoke runs, one attempted voting seat carries the validated contrarian lens.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** Run the external significant smoke, inspect its selected-lens and dispatch manifests, and record pass only when one attempted voting seat is contrarian; if live smoke is unavailable, record no claim.
- **Route:** Not applicable — provider live smoke is a CLI/external-provider flow, not a browser or HTTP application route.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "significant"]`
- **Negative/error coverage:** Not applicable — absence of live routes is recorded by this conditional manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-INT-045` decision record referencing AC-INT-043 and either observed contrarian dispatch evidence or an explicit unavailable/no-live-claim observation.

### AC-INT-046

- **Stage:** 5
- **Spec source:** `### Live smoke` — live identity honesty
- **Observable outcome:** Every live response reports its requested model and either its observed actual model as verified or an explicit unverified identity with no fabricated actual model.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** Run each available external live route with harmless public content, compare provider-observable identities to the result, and record pass only when every response is verified exactly or honestly unverified; if no live routes are available, record no claim.
- **Route:** Not applicable — provider live smoke is a CLI/external-provider flow, not a browser or HTTP application route.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "identity"]`
- **Negative/error coverage:** Not applicable — any dishonest or missing identity fails this same manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-INT-046` decision record listing each attempted route, requested identity, observed actual identity/evidence and reported verification state, or explicitly recording no routes/no live claim when credentials are absent.

### AC-SEC-032

- **Stage:** 5
- **Spec source:** `### Live smoke` — behavioural tool isolation
- **Observable outcome:** Each live seat route claimed available passes a behavioural probe showing that the seat cannot use tools.
- **Case:** negative
- **Tier:** manual-required
- **Verification method:** For each externally configured route, run the harmless tool-denial smoke and verify no shell, browser, MCP, filesystem/edit or web-search side effect occurs; if no live route is claimed, record that no tool-isolation live claim is made.
- **Route:** Not applicable — provider tool-isolation smoke is an external CLI/provider flow.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "tool-denial"]`
- **Negative/error coverage:** Self
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-SEC-032` decision record per claimed live route with denial-probe input, observed denial/no-side-effect evidence and runtime identity; a route without this evidence cannot be claimed tool-free or live-available.

### AC-DATA-030

- **Stage:** 5
- **Spec source:** `### Live smoke` — live record parsing
- **Observable outcome:** Every record produced by an executed live smoke parses successfully against the public `CouncilRecord` schema.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** After each executed external live smoke, load its appended record through the release-candidate parser and record pass only on successful schema/hash validation; if no smoke executes, record that no live record claim is made.
- **Route:** Not applicable — record verification is an external CLI/filesystem flow.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "records"]`
- **Negative/error coverage:** Not applicable — any parse/hash failure fails this same manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-DATA-030` decision record naming each live motion/record hash and parser result, or explicitly recording no live run/no record claim when routes are unavailable.

### AC-DATA-031

- **Stage:** 5
- **Spec source:** `### Live smoke` — disclosure/record parity
- **Observable outcome:** Each live-smoke record route and evidence manifest exactly matches what the facade disclosed before external requests.
- **Case:** positive
- **Tier:** manual-required
- **Verification method:** Capture pre-request disclosure and final record from each external live smoke, compare provider endpoints and evidence hashes, and record pass only on exact set/hash equality; if no smoke executes, record no parity claim.
- **Route:** Not applicable — disclosure/record verification is an external CLI/provider flow.
- **Command:** `["bun", "tests/live/provider-smoke.ts", "records"]`
- **Negative/error coverage:** Not applicable — any mismatch fails this same manual criterion.
- **Manual required:** yes
- **Decision contract:** A human must create an `AC-DATA-031` decision record referencing the live motion, disclosure evidence, persisted record hash and exact route/evidence comparison, or explicitly recording no live run/no parity claim.

### AC-INT-047

- **Stage:** 5
- **Spec source:** `### Live smoke` — absent credentials release semantics
- **Observable outcome:** Absent live-provider credentials do not fail release acceptance when every deterministic adapter and packaging gate passes.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run the release gate with all provider credentials absent and valid deterministic evidence, and observe release eligibility with every route honestly disabled and no live claim.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/release/live-optional.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-048

- **Stage:** 5
- **Spec source:** `### Live smoke` — deterministic evidence precedence
- **Observable outcome:** Successful live smoke cannot substitute for or waive any deterministic adapter fixture.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Supply passing live-evidence fixtures while one deterministic provider fixture fails, run the release gate, and observe release refusal naming the deterministic failure.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/release/live-optional.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-049

- **Stage:** 5
- **Spec source:** `### Live smoke` — evidence-gated route claims
- **Observable outcome:** A live route is not claimed available without observed route evidence.
- **Case:** negative
- **Tier:** behavioural
- **Verification method:** Run release/doctor claim generation with credentials only, stale evidence, mismatched evidence and current matching observed evidence; observe a live claim only in the final case.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/release/live-optional.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-INT-050

- **Stage:** 5
- **Spec source:** `### Live smoke` — below-normal live quorum
- **Observable outcome:** A live motion that misses normal quorum reports `degraded` when it meets the specified usable floor and `blocked-quorum` when below that floor.
- **Case:** error
- **Tier:** behavioural
- **Verification method:** Feed captured-shape live outcomes around the specified two-family ordinary and three-family significant floors into deterministic quorum evaluation and observe the exact degraded/blocked boundary with no completed result.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/release/live-quorum.test.ts"]`
- **Negative/error coverage:** Self
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-CFG-017

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 3 — boundary inventory
- **Observable outcome:** Every external and persisted boundary in the release-candidate execution graph has an invoked Zod parser and rejects a nonconforming fixture.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the maintained boundary inventory, require one valid and one single-field-invalid fixture per listed boundary, and observe every valid fixture accepted, every invalid fixture rejected and no unowned boundary/import assertion.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/contracts/boundary-inventory.test.ts"]`
- **Negative/error coverage:** AC-CFG-010, AC-CFG-016, AC-API-015, AC-LOGIC-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-054

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 11 — cross-platform static checks
- **Observable outcome:** The final post-cutover cross-platform check command passes.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the final repository check after legacy removal and observe a zero exit status with type, format, lint and structural checks succeeding without Bats/ShellCheck.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "run", "check"]`
- **Negative/error coverage:** AC-CFG-017, AC-OPS-043
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-055

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 11 — deterministic checks
- **Observable outcome:** The complete deterministic Bun test suite passes without provider credentials or network access.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Clear provider credentials, deny networking, run the deterministic suite and observe a zero exit status with all domain, policy, provider, round, record, health and facade fixtures passing.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test"]`
- **Negative/error coverage:** AC-INT-048, AC-DATA-022, AC-LOGIC-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-056

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 11 — packaging checks
- **Observable outcome:** The final clean-cache packaging smoke passes against the committed release bundle.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Construct the final release-only cache with no dependency tree/global cache/network/env-file loading, execute the smoke and observe successful self-check with exact version/source identity.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "tests/smoke/clean-cache.ts"]`
- **Negative/error coverage:** AC-OPS-012, AC-OPS-013, AC-OPS-014, AC-OPS-016, AC-OPS-028
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-057

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 11 — security checks
- **Observable outcome:** The complete deterministic security regression suite passes.
- **Case:** positive
- **Tier:** behavioural
- **Verification method:** Run the security suite covering repository settings, lifecycle arithmetic, secret payload positions, prompt policy, credential/privacy scanning and behavioural tool denial, and observe zero failures.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/security"]`
- **Negative/error coverage:** AC-SEC-003, AC-SEC-005, AC-SEC-010, AC-SEC-026, AC-SEC-029, AC-SEC-031
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-058

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 11 — Windows checks
- **Observable outcome:** All available Windows release-matrix checks for committed-bundle start-up, paths, process termination and atomic writes pass.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run the Windows CI acceptance job against the committed bundle and observe zero failures for AC-OPS-044, AC-OPS-045, AC-OPS-048, AC-OPS-050 and AC-OPS-052.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration"]`
- **Negative/error coverage:** AC-OPS-044, AC-OPS-045
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-059

- **Stage:** 5
- **Spec source:** `## Completion conditions` item 11 — Linux checks
- **Observable outcome:** All available Linux release-matrix checks for committed-bundle start-up, paths, process termination and atomic writes pass.
- **Case:** positive
- **Tier:** e2e
- **Verification method:** Run the Linux CI acceptance job against the committed bundle and observe zero failures for AC-OPS-046, AC-OPS-047, AC-OPS-049, AC-OPS-051 and AC-OPS-053.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["bun", "test", "tests/integration"]`
- **Negative/error coverage:** AC-OPS-046, AC-OPS-047
- **Manual required:** no
- **Decision contract:** Not applicable

### AC-OPS-060

- **Stage:** 5
- **Spec source:** `### Packaging and integration` — final plugin gate
- **Observable outcome:** The final post-cutover Claude Code plugin validates successfully.
- **Case:** positive
- **Tier:** structural
- **Verification method:** Run the validator against the final release tree after legacy removal and observe a zero exit status with no manifest or component-discovery error.
- **Route:** Not applicable — core contract has no browser or HTTP route.
- **Command:** `["claude", "plugin", "validate", "."]`
- **Negative/error coverage:** AC-API-015, AC-OPS-038
- **Manual required:** no
- **Decision contract:** Not applicable

## Specification Gaps

None.

## Coverage Summary

### By tier

| Tier | Count |
|---|---:|
| behavioural | 178 |
| structural | 53 |
| e2e | 44 |
| manual-required | 11 |

### By case

| Case | Count |
|---|---:|
| positive | 138 |
| negative | 112 |
| error | 36 |

### By stage

| Stage | Count |
|---:|---:|
| 1 | 15 |
| 2 | 89 |
| 3 | 87 |
| 4 | 56 |
| 5 | 39 |
