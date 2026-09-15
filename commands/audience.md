---
description: Put a draft in front of reader personas and collect their reactions
argument-hint: '[--personas name,name:description] [--personas-file path] [--question text] [--scope <scope>] [--classification <classification>] [--project-policy <path>] <draft path>'
allowed-tools: Bash(bun:*)
---

Run one blind audience round over the draft named in `$ARGUMENTS`.

1. Resolve the draft path, the personas, scope, classification and any project policy locally. The draft must be a readable text file of at most 256 KiB. Project scope without a validated policy must block before provider dispatch.
2. Invoke only the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js audience --records-root ~/.claude/council --personas <comma-separated-personas> --draft <shell-escaped-path> --caller human --harness claude-code [--personas-file <path>] [--question <shell-escaped-question>] [--scope <scope>] [--classification <classification>] [--project-policy <path>] [--providers <comma-separated-families>] [--json]
```

`--records-root` is always passed: this mode's record is its product, and without it the run degrades and exits `4` rather than keeping one.

3. Pass the draft path and the question as single safely quoted arguments. Never paste the draft's text into the command, interpolate repository or web content into it, invoke source files, install packages or call a legacy provider script.
4. Report the tallies as the counts they are, every quote verbatim beside the persona that said it, and every voice that did not answer with its reason. Do not rewrite the draft, do not turn counts into a percentage or a verdict, and do not present the personas as a sample of real readers: they are model seats carrying the briefs that were supplied. Exit `0` is a complete run; exit `4` is a degraded one — a missing voice, an unseated metered-only family, or a record that could not be kept — with `degraded` saying why; exit `3` is a policy block; exit `2` is a usage mistake or an IO failure writing the record.
