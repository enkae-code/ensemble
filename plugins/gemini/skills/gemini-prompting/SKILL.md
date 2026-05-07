---
name: gemini-prompting
description: Prompting guidance for the Gemini rescue subagent
user-invocable: false
---

# Gemini Prompting

Use this skill only when tightening a prompt before forwarding it to `gemini-companion`.

Prompt rules:
- State one concrete task.
- Keep the task text compact and grounded in the current repository.
- Call out the expected output if the user cares about format.
- Prefer constraints over narrative.
- Default to `pro` model. Use `flash` only for fast/light tasks where latency matters more than reasoning quality.
- Use `--worktree` when the user wants isolation from the current branch.

Good structure:
- Task
- Constraints
- Verification target
- Output contract
