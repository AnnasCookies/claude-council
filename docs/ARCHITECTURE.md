# Architecture

## Runtime boundary

`dist/cli.js` is the only installed runtime entry point. It is a self-contained Bun bundle and must run with `bun --no-install`; source files and `node_modules` are development inputs, not cache-time dependencies. Plugin commands contain prose and CLI invocation only.

No hook or repository-controlled file can start a council automatically.

```mermaid
flowchart TD
  A[Explicit CLI or slash command] --> B[Parse and validate command]
  B --> C[Resolve scope and project policy]
  C --> D[Select eligible provider families and governed lenses]
  D --> E[Outbound policy and secret guard]
  E -->|blocked| F[Structured blocked-policy result]
  E -->|allowed| G[Policy preflight disclosure]
  G --> H[Independent tool-free provider seats]
  H --> I[Round response validation and redaction]
  I --> J[Distinct-family quorum]
  J -->|failed| K[blocked-quorum result]
  J -->|passed| L[Completed result / chair adjudication]
  L --> M[Scoped atomic session and resolution records]
```

## Domain and policy

`src/domain/` owns strict Zod contracts for classification, model routes, lenses, manifests, seat responses, quorum and run-state transitions.

`src/policy/data-guard.ts` evaluates the complete outbound request before any adapter is called. It combines:

- the motion classification;
- project provider allowlists and per-provider ceilings;
- exact provider/model destinations;
- the full outbound payload;
- an optional run-bound, payload-hash-bound override.

Invalid or missing project policy, restricted data, an unknown provider, an exceeded ceiling or a high-confidence secret blocks transmission. Overrides cannot cover secret detection or unrestricted policy failures.

`src/policy/secrets.ts` uses deterministic high-confidence detectors. Redaction markers carry only a secret kind and an eight-character digest; raw secret values never enter errors, diagnostics or records.

## Evidence boundary

`src/evidence/schema.ts` admits four explicit source shapes:

- trusted local instruction;
- untrusted local instruction;
- untrusted repository evidence;
- untrusted public HTTPS evidence.

Only a host-authored local instruction can be trusted. Repository paths must be relative and web locators must be public HTTPS addresses. `normaliseEvidence` hashes original source content, redacts it and encloses every untrusted excerpt in a delimiter-safe `untrusted-evidence` envelope. Every seat receives the same rendered pack.

Evidence collection itself is read-only. It does not run repository code, shell commands, write tools or panel tools. Provider seats receive no tools.

## Provider execution

`src/providers/index.ts` constructs one adapter per governed provider family:

| Family    | Transport                                                 | Identity rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | isolated local CLI                                        | trusted absolute executable; tool-free, stateless argv                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OpenAI    | isolated local CLI (`codex exec`)                         | trusted absolute executable; identity and reasoning effort bound from the renderer header, and a downgraded effort is rejected                                                                                                                                                                                                                                                                                                                                                                                             |
| xAI       | HTTPS chat completions **or** isolated local CLI (`grok`) | resolved from observable facts — `XAI_API_KEY` selects HTTPS, otherwise a `grok` binary on `PATH` selects the subscription CLI, otherwise `unconfigured`. Only transports listed in the route's `alternateTransports` are permitted; the runner and health probe reject any other. The CLI parser requires subscription evidence (`init.apiKeySource === "oauth"`), one consistent model and session identity across the init frame, assistant frame and the terminal result's sole `modelUsage` key, and no tool activity |
| Google    | isolated local CLI (`agy`)                                | actual model version must be present in the stream-json `init` event                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DeepSeek  | HTTPS chat completions                                    | actual model must be present in the response                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Moonshot  | HTTPS chat completions                                    | actual model must be present in the response                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

HTTP retries are bounded and limited to retryable network, 429 and server failures. CLI execution has a hard deadline and terminates the process group on POSIX or the complete process tree on Windows. Provider arguments are explicit argv plus stdin; no shell wrapper constructs the request.

Fallbacks remain within one provider family and only use registry-approved selectors. Missing credentials produce `unconfigured`/`skipped` responses. A failure is never relabelled as another family.

Structured provider answers contain recommendation, evidence, assumptions, risks, uncertainty and a decisive test. Malformed answers fail the seat. Returned content is redacted before it reaches round state, output or persistence.

## Lenses, rounds and quorum

`src/roles/catalogue.json` is the governed generic lens catalogue. `selectLenses` applies motion domains, impact and contested status. Its standing coverage requires domain, maintainer, risk and contrarian categories, plus systems for architecture, infrastructure and performance motions. An explicitly reduced three-seat council deterministically retains domain, risk and contrarian; maintainer and conditional systems coverage yield. Four-or-more-seat selection is unchanged. `assignLenses` uses deterministic SHA-256 permutations plus minimum-cost matching against prior assignments to rotate lenses without random or time-based behaviour. A chair override must name the original and replacement lenses and persist its reason.

`CouncilRunner` executes all seats in a round concurrently and preserves canonical family/seat ordering in the result. Round one is blind analysis; round two is rebuttal; round three is optional refinement. Prior responses are carried as explicitly untrusted data.

Quorum counts successful distinct provider families across the run. Ordinary resolution needs three families. Significant resolution defaults to four families and a successful contrarian lens. `council --min-families 3` is an explicit weaker mode: the contrarian remains mandatory, and the reduced floor plus warning is carried by the manifest, console result and persisted session record. Failed quorum disables synthesis; the facade cannot convert it into consensus.

## Records and migration

`CouncilStore` separates:

```text
<root>/general/
<root>/projects/<project-id>/
```

Each scope has its own sessions, resolutions and ledger. Inputs are Zod-validated, identifiers are path-safe and writes use same-directory temporary files, fsync, atomic rename and a scoped cross-process lock. Duplicate run, motion and resolution identifiers fail. A project record cannot mutate general history or another project.

General-history migration is a two-step boundary:

1. `migrate-general plan` reads and hashes the source, classifies entries in memory and writes a reviewable plan. It does not mutate records.
2. `migrate-general apply` requires explicit approval tied to the exact plan hash, verifies the source hash, publishes a byte-identical archive first, then writes provenance-bearing destinations and a manifest.

Unresolved items or source drift fail closed.

## Health and offline verification

`health --json` probes exact routes and emits a secret-free baseline. Baseline comparison reports newly unavailable families, actual-model changes, configured-route changes and total outage.

`doctor --json` additionally reports endpoint/executable resolution, tool isolation, candidate successor warnings and remediation codes. Health output never retains environment values or raw provider output.

`self-check --json` is offline. It validates the bundled registry, provider family set and governed lens catalogue without constructing a request or probing a provider.
