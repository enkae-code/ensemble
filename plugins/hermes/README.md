# Hermes Ensemble Plugin

Hermes gives Claude Code a local command surface for the NousResearch/hermes-agent CLI. It supports one-shot dispatch, ask, review, adversarial review, and the bounded research loop.

## Prerequisites

- Install the `hermes` CLI.
- Run `hermes auth`.
- Configure at least one Hermes provider/model.
- Install this plugin from the Ensemble marketplace.

The plugin runs on config alone. Hooks are optional. Cost brake is OFF by default.

## Commands

- `/hermes:rescue` - dispatch work through Hermes.
- `/hermes:review` - review local git changes.
- `/hermes:adversarial-review` - challenge the current direction.
- `/hermes:ask` - ask Hermes a direct question.
- `/hermes:research` - run a bounded research loop.
- `/hermes:research --background` - start a background research job.
- `/hermes:status [JOB_ID]` - inspect jobs.
- `/hermes:result [JOB_ID]` - read a finished job.
- `/hermes:cancel JOB_ID` - stop a running job.
- `/hermes:setup` - check binary and auth state.

## Core Config

| Variable | Purpose | Default |
|---|---|---|
| `HERMES_BIN` | Hermes executable used by direct calls and Mode B research. | `hermes` |
| `HERMES_CAPS_PATH` | JSON caps template for research. | bundled `hermes-caps.default.json` |
| `HERMES_WORKDIR` | Directory where Mode B launches Hermes. | current command cwd |
| `HERMES_STATE_DB` | Hermes SQLite state DB read for session binding and turn/idle signals. | `$HOME/.hermes/state.db` |
| `HERMES_MODEB_KILL_GRACE_SECONDS` | Grace period before hard kill after timeout. | `3` |
| `cost_brake_enabled` | Caps JSON flag that requires a prelaunch hook. | `false` in shipped caps |
| `max_turns`, `max_cost_usd`, `idle_timeout_seconds`, `max_wall_seconds` | Research loop caps. | caps JSON or CLI flags |

## Extension Hooks

Hooks are executable paths passed by env var or `HERMES_PLUGIN_CONFIG`. Empty or unset hook vars are skipped, except `cost_brake_enabled=true` with no prelaunch hook refuses launch.

| Hook | Called | stdin JSON | Exit contract |
|---|---|---|---|
| `HERMES_HOOK_PRELAUNCH` | Once before Hermes starts. | `{account,provider,model,pid,max_turns,max_cost_usd,idle_timeout_seconds,max_wall_seconds,caps,task}` | `0` proceeds. Nonzero refuses launch and writes the existing partial-report artifact. Optional stdout `{"job_id":"..."}` supplies the tracking id; otherwise Mode B creates one. |
| `HERMES_HOOK_JOB_TOUCH` | At registration and on activity ticks. | `{job_id,pid,session,status}` | Best effort. Failure is ignored. Missing hook is a no-op. |
| `HERMES_HOOK_JOB_RELEASE` | Once at process cleanup. | `{job_id,status}` | Best effort. Failure is ignored. Missing hook is a no-op. |

Example prelaunch hook:

```bash
#!/bin/bash
set -euo pipefail
payload="$(cat)"
cost="$(jq -r '.max_cost_usd' <<< "$payload")"
limit="${HERMES_MAX_ALLOWED_USD:-1.00}"
if awk "BEGIN { exit !($cost > $limit) }"; then
  printf 'budget %.2f exceeds %.2f\n' "$cost" "$limit" >&2
  exit 2
fi
printf '{"job_id":"budget-ok"}\n'
```

## Optional Config File

Set `HERMES_PLUGIN_CONFIG=/path/to/hermes-plugin.json` to map one JSON file into the spawn environment. Env vars win over file values.

```json
{
  "bin": "hermes",
  "caps_path": "$HOME/.config/hermes/caps.json",
  "workdir": "$HOME/project",
  "hooks": {
    "prelaunch": "/path/to/prelaunch-hook",
    "job_touch": "/path/to/job-touch-hook",
    "job_release": "/path/to/job-release-hook"
  }
}
```

Keys map to `HERMES_BIN`, `HERMES_CAPS_PATH`, `HERMES_WORKDIR`, `HERMES_HOOK_PRELAUNCH`, `HERMES_HOOK_JOB_TOUCH`, and `HERMES_HOOK_JOB_RELEASE`.
