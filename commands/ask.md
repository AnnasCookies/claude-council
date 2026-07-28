---
description: Route an ordinary question or explicit debate through the standing council
argument-hint: '[--debate] [--scope general|project] [--classification level] [--project-policy path] [--providers list] <question>'
allowed-tools: Bash(bun:*)
---

Route `$ARGUMENTS` through the bundled standing-council runtime.

- If `--debate` is present, remove that compatibility flag and invoke `council`; this is a significant two-round run.
- Otherwise invoke `second-opinion`; this is exactly one blind round.
- Preserve explicit scope, classification, project-policy and provider flags. Treat the remaining text as one safely quoted motion.
- Invoke only `bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js <command> ...`. Never invoke a legacy execution script or provider CLI directly, source TypeScript or install packages.
- Project scope without a validated policy must remain blocked. Present policy preflight, provider/model identity, failures, uncertainty, disagreement and quorum honestly; do not silently substitute providers or synthesize over failed quorum.
