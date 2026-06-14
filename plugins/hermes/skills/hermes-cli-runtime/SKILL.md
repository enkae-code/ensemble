---
name: hermes-cli-runtime
description: Internal helper contract for calling the hermes-companion runtime from Claude Code
user-invocable: false
---

# Hermes Runtime

Use this skill only inside the `hermes:hermes-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder. Invoke `task` once and return its stdout unchanged.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Strip `--background` and `--wait` before calling `task`.
- Leave `--model` unset unless the user explicitly asks for one.
- Use `--model provider/model` for model overrides.
- Preserve `--skills` when the user asks for Hermes skills.
- Preserve `--worktree` when the user asks for isolated work.
- If the helper prints `QUOTA WARNING`, keep that line in the returned output.
- If setup or auth is missing, tell the user to run `/hermes:setup`.

Available subcommands:
- `task [--background] [--model provider/model] [--skills LIST] [--worktree] [--cwd DIR] PROMPT`
- `ask [--model provider/model] [--skills LIST] [--cwd DIR] QUESTION`
- `status JOB_ID`
- `result JOB_ID`
- `cancel JOB_ID`
- `review [--cwd DIR]`
- `adversarial-review [--cwd DIR]`
- `setup`
