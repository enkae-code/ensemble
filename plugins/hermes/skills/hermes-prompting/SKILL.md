---
name: hermes-prompting
description: Prompting guidance for Hermes companion commands
user-invocable: false
---

# Hermes Prompting

Use this skill only when tightening a prompt before forwarding it to `hermes-companion`.

Prompt rules:
- State one concrete task.
- Keep the task text compact and grounded in the current repository.
- Call out the expected output if the user cares about format.
- Prefer constraints over narrative.
- Raise model cost only when the user explicitly opts in.
- Use `--worktree` when the user wants isolation from the current branch.
- For research, state caps plainly: turns, idle timeout, wall timeout, and cost if the user supplied one.
- Do not assume any site-specific quota, registry, vault, or preflight system. External policy belongs in configured hooks.

Good structure:
- Task
- Constraints
- Verification target
- Output contract
