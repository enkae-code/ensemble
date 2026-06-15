---
name: hermes-cli-runtime
description: Internal helper contract for calling the Hermes companion runtime from Claude Code
user-invocable: false
---

# Hermes Runtime

Use this skill inside Hermes plugin command handlers and subagents.

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
- For research, Mode B can run with only Hermes config. Hooks are optional executable extension points.
- `HERMES_HOOK_PRELAUNCH` may refuse launch by exiting nonzero. `HERMES_HOOK_JOB_TOUCH` and `HERMES_HOOK_JOB_RELEASE` are best-effort tracking hooks.
- Do not assume any hook reads local vault, registry, or provider secrets. Hook authors own their own env.

Available subcommands:
- `task [--background] [--model provider/model] [--skills LIST] [--worktree] [--cwd DIR] PROMPT`
- `ask [--model provider/model] [--skills LIST] [--cwd DIR] QUESTION`
- `status JOB_ID`
- `result JOB_ID`
- `cancel JOB_ID`
- `review [--cwd DIR]`
- `adversarial-review [--cwd DIR]`
- `setup`
