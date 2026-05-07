---
name: cursor-prompting
description: Prompting guidance for the Cursor rescue subagent
user-invocable: false
---

# Cursor Prompting

Use this skill only when tightening a prompt before forwarding it to `cursor-companion`.

Prompt rules:
- State one concrete task.
- Keep the task text compact and grounded in the current repository.
- Call out the expected output if the user cares about format.
- Prefer constraints over narrative.
- Raise model cost only when the user explicitly opts in.
- Use `--worktree` when the user wants isolation from the current branch.

Good structure:
- Task
- Constraints
- Verification target
- Output contract
