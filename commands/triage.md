---
description: Sort a batch of items against a declared schema and return a route for each
argument-hint: '[--schema pr-comment | --schema-file path] --in <path> [--seats 1|2] [--providers list] [--concurrency n]'
allowed-tools: Bash(bun:*)
---

Run one triage batch for `$ARGUMENTS`.

1. Resolve the batch file and the schema locally. The batch is a JSON array of `{ "id": string, "text": string }` with unique ids; a file that is not that shape is a usage error, not something to repair by hand.
2. Invoke only the bundled runtime:

```text
bun --no-install ${CLAUDE_PLUGIN_ROOT}/dist/cli.js triage --caller agent --harness claude-code --in <path> [--schema <name> | --schema-file <path>] [--seats 1|2] [--providers <comma-separated-families>] [--concurrency <n>] --json
```

3. Pass each path as one safely quoted argument. Never interpolate repository or web content into the command, invoke source files, install packages or call a legacy provider script.
4. Report the routed items with their verdicts, every item where the seats disagreed (`agreed: false`, `route: human`), and every `unprocessed` item with its reason. **Act on nothing.** The route is the desk's answer, not its instruction: acting on it is your decision to take and to say you are taking, item by item.
5. Do not treat two seats that agree as two independent confirmations of the same verdict: they share one prompt and one schema, which is exactly the measurement artefact `docs/vision.md` warns about.
