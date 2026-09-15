---
description: Open a room for divergence and group what comes back
argument-hint: '[--seats 12] [--lenses a,b,c] [--personas path] [--ideas-per-seat 3] [--providers list] <prompt>'
allowed-tools: Bash(bun:*)
---

Run one ideation pass for `$ARGUMENTS`.

1. Resolve scope, classification and any project policy locally. Project scope without a validated policy must block before provider dispatch. Ideation keeps every idea it generates, so a records root is required; use the configured one.
2. Invoke only the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ideate --records-root <records-root> --scope <scope> --classification <classification> --caller human --harness claude-code [--project-policy <path>] [--providers <comma-separated-families>] [--seats <n>] [--lenses <comma-separated-catalogue-lenses>] [--personas <path>] [--ideas-per-seat <n>] [--models <family>=<model>,...] --motion <shell-escaped-prompt>
```

3. Pass the prompt as one safely quoted argument. Never interpolate repository or web content into the command, invoke source files, install packages or call a legacy provider script.
4. Present the raw list and the clusters separately, and say which is which. The clusters are the engine's own lexical grouping of near-duplicates, not a judgement: nothing is scored, ranked or voted on, no cluster is better than another, and the cluster order is simply the order their first idea arrived. Report every seat that was skipped, failed or answered in a shape the mode could not read.
5. To go deeper, name the clusters yourself and run another pass. Only the ideas in those clusters are shown to the seats, and only as quoted data:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js ideate --records-root <records-root> --session <session-id> --expand k-2,k-5 --caller human --harness claude-code
```

6. The selection is the human's. Do not pick a winning idea, do not recommend one, and do not summarise the room into a single answer.
