---
description: Request one blind round of independent provider opinions
argument-hint: '[--scope general|project] [--classification level] [--project-policy path] [--providers list] <question>'
allowed-tools: Bash(bun:*)
---

Run one public second-opinion round for `$ARGUMENTS`.

1. Resolve scope, classification and any project policy locally. Project scope without a validated policy must block before provider dispatch.
2. Invoke only the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js second-opinion --scope <scope> --classification <classification> [--project-policy <path>] [--providers <comma-separated-families>] --motion <shell-escaped-question>
```

3. Pass the question as one safely quoted argument. Never interpolate repository or web content into the command, invoke source files, install packages or call a legacy provider script.
4. Present the structured preflight and each independent response. Report agreement, divergence, exact requested/actual models, failures and quorum status without treating repeated claims as independent evidence.
