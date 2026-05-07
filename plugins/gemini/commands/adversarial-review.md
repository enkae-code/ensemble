---
description: Run a Gemini review that challenges the current implementation direction
argument-hint: '[--cwd <dir>]'
allowed-tools: Bash(node:*), Bash(git:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review "$ARGUMENTS"
```

Output rules:
- Return the command stdout exactly as-is.
- Do not fix issues or suggest immediate edits.
- Keep the framing adversarial and design-focused.
