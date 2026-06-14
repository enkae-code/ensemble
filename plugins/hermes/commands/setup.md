---
description: Check whether the local Hermes arm is ready to run
argument-hint: '[--cwd <dir>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" setup $ARGUMENTS`

Present the setup output directly.
If auth is missing or broken, direct the user to run `hermes auth` and rerun `/hermes:setup`.
