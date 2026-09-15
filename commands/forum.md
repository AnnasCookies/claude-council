---
description: Convene a forum where many seats argue a motion over rounds and nobody rules
argument-hint: '[--seats n] [--rounds n] [--lenses list] [--personas path] [--providers list] <motion>'
allowed-tools: Bash(bun:*)
---

Convene a forum on `$ARGUMENTS`.

1. Resolve scope, classification and any project policy locally. Project scope without a validated policy must block before provider dispatch.
2. Invoke only the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js forum --seats <2-24> --rounds <1-6> --scope <scope> --classification <classification> --caller human --harness claude-code [--lenses <comma-separated-lenses> | --personas <path>] [--providers <comma-separated-families>] [--spend-cap <n>] --motion <shell-escaped-motion>
```

3. Pass the motion as one safely quoted argument. Never interpolate repository or web content into the command, invoke source files, install packages or call a legacy provider script.
4. Present the rounds in order, then the position map with its holders, then who moved and why, then the motions with their support and opposition. Attribute every position to its seat and round.
5. Do not declare a winner, a consensus or a decision, and do not rank the positions: the forum records, it never rules. Report the rounds actually run, and say so plainly when the spend cap or a missing seat cut the forum short.
