---
description: Show the stored final output for a finished Hermes job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" result $ARGUMENTS`

Present the full command output to the user.
Do not summarize or condense it.
