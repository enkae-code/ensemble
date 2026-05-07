---
description: Show tracked Gemini jobs for this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status $ARGUMENTS`

If the user did not pass a job ID:
- Present the output as a compact Markdown table.
- Do not add extra prose.

If the user did pass a job ID:
- Present the full command output.
- Do not summarize or condense it.
