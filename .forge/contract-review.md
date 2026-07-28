# Forge Contract Review — Public Standing Council Kernel

**Date:** 2026-07-27  
**Reviewer:** independent `PublicContractReview` reviewer  
**Verdict:** Pass after corrections; initial pipeline may be `ready` with Stage 1 eligible.

## Scope checked

- `.forge/brief.md`
- `docs/forge/2026-07-27-standing-council-kernel-spec.md`
- `.forge/feasibility.md`
- five-stage backward-only graph in `.forge/acceptance-criteria.md`
- `.forge/acceptance-criteria.md`
- `.forge/traceability.json`

## Findings and resolutions

1. **Stage 1 POSIX evidence environment — resolved.** Eleven containment criteria use the legacy Bats suite, which cannot run natively on this Windows host. The acceptance contract now states that every `bash tests/run_tests.sh` criterion is automated on supported POSIX CI and remains open until that CI evidence is captured.
2. **Mislinked packaging negative coverage — resolved.** AC-OPS-022, AC-OPS-023 and AC-OPS-033 now include explicit failing mutation fixtures and use self-contained negative coverage rather than unrelated Stage 5 criteria.
3. **Stale quorum-decision references — resolved.** AC-LOGIC-039, AC-LOGIC-042, AC-API-018 and AC-INT-050 now reference the specified two-family ordinary and three-family significant floors directly; no nonexistent decision record is required.
4. **Provider retention risk — resolved before review close.** `ModelRoute` and HTTP contracts include alias, transport, identity, storage/retention and cancellation metadata. Stateless provider requests and fail-closed retention policy are covered by AC-DATA-033 through AC-DATA-035.
5. **Status and parity ambiguities — resolved before review close.** High-confidence secrets use terminal `blocked-policy`; degraded floors are numeric; the private-host parity scenario set is enumerated.

## Contract integrity

- 286 unique criteria: 178 behavioural, 53 structural, 44 end-to-end and 11 manual-required.
- Stage ownership: 15 / 89 / 87 / 56 / 39.
- Traceability contains exactly one entry per criterion; every referenced specification heading exists; implementation, test and evidence arrays are empty before execution.
- Manual-required entries have explicit decision contracts. No initialisation decision is disguised as an assumption.

## Stage-bound risks

- Stage 3 must revalidate every production selector, transport and CLI isolation claim against current official evidence before enabling a route.
- Stage 5 requires observed private-host parity against the exact release-candidate identity before legacy deletion.
- POSIX/Linux and cross-platform process evidence must come from CI or a second machine; native Windows evidence is insufficient.
- Missing paid credentials are not an initial blocker. Fake transports own deterministic adapter acceptance; unavailable live routes must be reported honestly.

No unresolved issue prevents Stage 1 from starting.
