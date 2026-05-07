---
name: cursor-result-handling
description: Presentation rules for Cursor companion output
user-invocable: false
---

# Cursor Result Handling

Use this skill when returning Cursor companion output to the user.

Rules:
- Preserve the helper stdout exactly when a command says verbatim.
- Keep review findings in the order returned by Cursor.
- If a task failed, report the failure and stop.
- If setup says auth failed, direct the user to `/cursor:setup`.
- After a review, stop and ask what to do next. Do not auto-apply review suggestions.
- Keep job IDs, file paths, and follow-up commands intact.
