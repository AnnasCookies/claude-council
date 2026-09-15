---
description: Ask the convene advisor one question on demand, or read a session's note log
argument-hint: '[--session <key>] [--status] <question>'
allowed-tools: Bash(bun:*)
---

Put `$ARGUMENTS` to the advisor seat as one question and relay its note. The advisor speaks and never acts: relay the note, then decide.

1. Resolve the session key. Use the key the user names with `--session`; otherwise use `manual-<YYYY-MM-DD>` so a day's on-demand questions share one note log. The kernel maps any key to a log under the records root.
2. Invoke only the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js advise --records-root ~/.claude/council --caller human --harness claude-code --session <key> --ask <shell-escaped-question>
```

With `--status` instead of a question, run `--status` in place of `--ask` and report whether the log exists, how many notes it holds and the last one.

3. Pass the question as one safely quoted argument. Never interpolate repository or web content into the command, invoke source files, install packages or call a provider CLI directly.
4. Present `envelope.output.note` as it is: the id, severity, text, the seat that answered and its verified model. A `skipped` or `no-advice` note is reported with its reason, never rewritten as advice. Exit `2` is a usage error to correct, `3` a policy block to report.
5. When the user acts on or dismisses the note, record it: `advise --records-root ~/.claude/council --session <key> --heed <note-id> yes|no`.
