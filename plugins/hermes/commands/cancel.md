---
description: Cancel an active background Hermes job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" cancel $ARGUMENTS`
