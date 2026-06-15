---
name: hermes-result-handling
description: Presentation rules for Hermes companion output
user-invocable: false
---

# Hermes Result Handling

Use this skill when returning Hermes companion output to the user.

Rules:
- Preserve the helper stdout exactly when a command says verbatim.
- Keep review findings in the order returned by Hermes.
- If a task failed, report the failure and stop.
- If setup says auth failed, direct the user to `/hermes:setup`.
- If research is refused before launch, report the refusal and keep the partial-report path intact.
- If hook tracking is absent, do not treat that as a user-visible failure unless launch was refused by the prelaunch hook.
- After a review, stop and ask what to do next. Do not auto-apply review suggestions.
- Keep job IDs, file paths, and follow-up commands intact.
