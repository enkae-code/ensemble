---
name: gemini-result-handling
description: Presentation rules for Gemini companion output
user-invocable: false
---

# Gemini Result Handling

Use this skill when returning Gemini companion output to the user.

Rules:
- Preserve the helper stdout exactly when a command says verbatim.
- Keep review findings in the order returned by Gemini.
- If a task failed with rate-limit, report that directly — do not retry by spawning more dispatches.
- If setup says auth failed, direct the user to `/gemini:setup` and `gemini auth login`.
- After a review, stop and ask what to do next. Do not auto-apply review suggestions.
- Keep job IDs, file paths, and follow-up commands intact.
