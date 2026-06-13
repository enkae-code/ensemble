# Personas (planned for v1.1)

> Status: design-only in v1. The persona system below is the **next** feature on the roadmap. v1 ships without it. This doc exists so users know it's coming and contributors know the shape.

## Why personas

Right now Cursor has one default identity ("a helpful Cursor agent" plus whatever the user types). For specialized work — design review, security audit, refactor-only — users have to write the system prompt from scratch every time and remember which model preset is appropriate.

A persona bundles **identity + rules + skills + model preset + write-permission** into a named, reusable thing.

## Where rules live: project-local first

Personas read their rules from inside the project being worked on. This is the same pattern as `AGENTS.md` (already supported). The hierarchy at dispatch time:

```
1. Built-in persona system prompt        (from plugins/<arm>/personas/<name>.md)
2. Project-local persona overrides       (from <project>/.ensemble/personas/<name>.md  — if present)
3. Project AGENTS.md                      (already wired today)
4. User task prompt
```

This means a project can override the built-in `architect` persona with its own version that knows about the project's specific architecture, naming conventions, or constraints. Same idea as how each project can have its own AGENTS.md but for task-specific personas.

A team can also commit `.ensemble/personas/` to git so every contributor's dispatches use the same persona definitions. No drift.

## Built-in personas (initial set)

| Persona | Default model | allowed-write | Purpose |
|---|---|---|---|
| `architect` | reasoning (Cursor) | false | System design, contracts, data flow. No code. |
| `security-auditor` | reasoning | false | OWASP, auth boundaries, data handling. |
| `refactorer` | auto | true | Minimal-diff structural improvements only. No new features. |
| `test-writer` | auto | true | Adds tests. Never modifies production code. |
| `ui-polish` | premium | true | Frontend-only. Design-system aware. |
| `bug-hunter` | reasoning | true | Root-cause first, fix second. Adds regression test. |
| `doc-writer` | fast | true | Documentation only. Never modifies code. |

## Persona file format

Stored at `plugins/<arm>/personas/<name>.md` (built-in) or `<project>/.ensemble/personas/<name>.md` (project override).

```yaml
---
name: architect
description: Senior systems architect — design + contracts + data flow only
allowed-write: false
model: reasoning
skills:
  - api-design
rules: |
  - Never propose code without grounding in current files
  - Always identify the contract before implementation
  - Reject scope creep
---
You are a senior systems architect. Focus on system boundaries, data flow,
contracts, and failure modes. Do not micro-optimize. Do not write code.
Output:
1. Current state summary
2. Proposed change at the contract level
3. Risks and mitigations
```

## Usage

```bash
/cursor:rescue --persona architect "Plan migration from sessions to JWT"
/cursor:rescue --persona security-auditor "Review OAuth flow"
/cursor:rescue --persona test-writer "Add coverage for src/auth.mjs"
/cursor:rescue --persona doc-writer --model fast "Document the public API"
```

Persona overrides flag-level model unless `--model` is also explicitly passed.

## Dispatch flow with persona

```
[user task prompt]
   ↓
load persona file (project override > built-in)
   ↓
prepend persona system prompt
   ↓
prepend project AGENTS.md (already wired)
   ↓
apply persona model preset (unless --model overrides)
   ↓
gate write-mode if persona is read-only
   ↓
load extra skills declared by persona
   ↓
spawn underlying CLI
```

## Implementation cost

~150 LOC + persona files. Slots above the existing `injectAgentsContext` layer. No breaking changes to v1.

## When

After v1 ships and we have a few weeks of dogfeeding to learn which personas are actually useful. Premature persona names are bad persona names.

## Related: claude-mem write hook (v1, not v1.1)

Each arm writes observations to claude-mem during dispatch — when work starts, what the arm did, what the result was. This makes work visible across arms and across Claude sessions. Independent from personas but composes nicely: the `architect` persona can `mem-search` for prior architectural decisions before answering.
