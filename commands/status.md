---
description: Diagnose configured standing-council provider routes
argument-hint: '[--json]'
allowed-tools: Bash(bun:*)
---

Invoke the bundled doctor and present its structured diagnostics:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js doctor --json
```

Report route resolution, configured primary and fallback selectors, requested/actual model identity, tool-isolation status, provider failures and remediation codes. Do not expose environment values or raw provider output. Do not invoke legacy status or provider scripts.
