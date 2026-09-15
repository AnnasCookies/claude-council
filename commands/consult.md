---
description: Brief a consultant per lens, then follow up with one of them
argument-hint: '[--lens security,privacy] [--personas path] [--context path] [--session id --ask lens "question"] <brief question>'
allowed-tools: Bash(bun:*)
---

Run a consultants session for `$ARGUMENTS`.

1. Resolve scope, classification and any project policy locally. Project scope without a validated policy must block before provider dispatch.
2. Brief the consultants with the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js consult --records-root ~/.claude/council --scope <scope> --classification <classification> --caller human --harness claude-code --lens <comma-separated-lenses> [--personas <path>] [--context <path>]... [--providers <comma-separated-families>] --motion <shell-escaped-question>
```

3. Follow up with exactly one consultant, quoting the session id the brief returned:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js consult --records-root ~/.claude/council --session <id> --ask <lens> [--forward <lens>] <shell-escaped-question>
```

4. Pass the question as one safely quoted argument, and pass each `--context` path separately. Never interpolate repository or web content into the command, invoke source files, install packages or call a legacy provider script.
5. Present each report under its lens and seat, then the conflicts exactly as returned. The conflicts are never resolved by the engine and must not be resolved in your summary either: say which lenses disagree and what each holds, and leave the decision to the reader. Name any consultant that did not report, and say when the session spend cap stopped a follow-up.
