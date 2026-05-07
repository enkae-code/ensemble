---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder. Invoke `task` once and return its stdout unchanged.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`.
- Strip `--background` and `--wait` before calling `task`.
- Leave `--model` unset unless the user explicitly asks for one.
- The hard default is `--model pro` (gemini-2.5-pro).
- Preserve `--worktree` when the user asks for isolated work.
- If the helper reports rate-limit failures, surface that directly so the user knows it is Google capacity, not local config.
- If setup or auth is missing, tell the user to run `/gemini:setup`.

Available subcommands:
- `task [--background] [--model PRESET] [--worktree] [--cwd DIR] PROMPT`
- `status JOB_ID`
- `result JOB_ID`
- `cancel JOB_ID`
- `review [--cwd DIR]`
- `adversarial-review [--cwd DIR]`
- `setup`
