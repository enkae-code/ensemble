---
description: Run a read-only Hermes diff review against local git state
argument-hint: '[--cwd <dir>]'
allowed-tools: Bash(node:*), Bash(git:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-companion.mjs" review "$ARGUMENTS"
```

Output rules:
- Return the command stdout exactly as-is.
- Do not fix issues or suggest immediate edits.
- Keep the interaction review-only.
