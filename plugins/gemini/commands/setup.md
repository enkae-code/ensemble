---
description: Check whether the local Gemini arm is ready to run
argument-hint: '[--cwd <dir>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup $ARGUMENTS`

Present the setup output directly.
If auth is missing or broken, direct the user to run `gemini auth login` and rerun `/gemini:setup`.
