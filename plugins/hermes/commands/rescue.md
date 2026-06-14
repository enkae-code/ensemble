---
description: Delegate implementation, diagnosis, or follow-up work to the Hermes rescue subagent
argument-hint: "[--background|--wait] [--model provider/model] [--skills list] [--worktree] [what Hermes should do]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `hermes:hermes-rescue` subagent.
The final user-visible response must be the companion stdout verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `hermes:hermes-rescue` subagent in the background.
- If the request includes `--wait`, run the `hermes:hermes-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are Claude execution flags. Do not treat them as task text.
- Preserve `--model`, `--skills`, and `--worktree` for the forwarded `task` call.
- If the user did not supply a task, ask what Hermes should investigate or build.

Operating rules:

- The subagent is a forwarder only.
- It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" task ...`.
- Return the command stdout exactly as-is.
- Do not inspect the repo, poll `/hermes:status`, fetch `/hermes:result`, or do follow-up work.
- If the helper reports setup or auth problems, stop and tell the user to run `/hermes:setup`.
