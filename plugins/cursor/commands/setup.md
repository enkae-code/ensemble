---
description: Check whether the local Cursor arm is ready to run
argument-hint: '[--cwd <dir>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup $ARGUMENTS`

Present the setup output directly.
If auth is missing or broken, direct the user to fix `CURSOR_API_KEY` and rerun `/cursor:setup`.
