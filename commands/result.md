---
description: List or read schema-validated standing-council sessions
argument-hint: 'list | <run-id> --records-root <path> [--scope general|project] [--project-id id]'
allowed-tools: Bash(bun:*)
---

Use only the bundled typed record facade for `$ARGUMENTS`.

- `list` invokes `bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js jobs` with the supplied records root and scope.
- A run id invokes `bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js result --run-id <safe-id>` with the supplied records root and scope.
- `cancel <run-id>` invokes the `cancel` command. Persisted terminal sessions must remain immutable; relay a `not-cancellable` result rather than rewriting them.

Require `--records-root`. Project scope also requires `--project-id`. Never read arbitrary paths derived from an unvalidated run id, invoke the legacy job scripts or reformat a schema-validation failure as success.
