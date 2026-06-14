---
description: Run the Hermes autonomous research loop with the vendored Mode B supervisor
argument-hint: "[--background|--wait] [--provider name] [--model name] [--report path] [--turns n] [--wall seconds] [--idle seconds] [--cost usd] [--cost-brake] [what Hermes should research]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `hermes:hermes-rescue` subagent.
The final user-visible response must be the companion stdout verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the Hermes research loop in the background.
- If the request includes `--wait`, run the Hermes research loop in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are Claude execution flags. Do not treat them as task text.
- Preserve `--provider`, `--model`, `--report`, `--turns`, `--wall`, `--idle`, `--cost`, and `--cost-brake` for the forwarded `research` call.
- If the user did not supply a task, ask what Hermes should research.

Operating rules:

- The subagent is a forwarder only.
- It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" research ...`.
- Return the command stdout exactly as-is.
- Do not inspect the repo, poll `/hermes:status`, fetch `/hermes:result`, or do follow-up work.
- If the helper reports setup or auth problems, stop and tell the user to run `/hermes:setup`.
