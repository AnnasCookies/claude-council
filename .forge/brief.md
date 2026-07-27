# Forge Brief — Standing Council Kernel

## Source

User instruction, 2026-07-27:

> alright do it per your recommendation using the forge lets see how it goes!

Approved architectural source: `C:/Users/GarethRadley/.claude/docs/superpowers/specs/2026-07-27-standing-council-kernel-design.md`.

## Repository scope

Evolve the public `claude-council` repository into a generic, secure Bun/TypeScript standing-council kernel. Preserve useful public plugin behaviour while removing repository-controlled auto-execution and the legacy Bash execution engine after compatibility is proven.

The public package must contain no private council records, personal policy, credentials, provider secrets or project names. It must expose a self-contained `dist/cli.js` consumed by Claude Code, OMP and private host adapters without runtime package installation.

## Execution decision

Use Forge v2 with isolated worktrees, frozen stage contracts, red milestone evidence, one implementation pass per stage and independent verification before acceptance. Serial implementation is the default. Provider adapters may be parallelised only after their shared interface is frozen and file ownership is disjoint.
