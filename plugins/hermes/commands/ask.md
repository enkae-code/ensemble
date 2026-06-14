---
description: Ask Hermes a direct one-shot question
argument-hint: '[--cwd <dir>] [--model provider/model] [--skills list] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" ask $ARGUMENTS`

Present the full command output to the user.
Do not summarize or condense it.
