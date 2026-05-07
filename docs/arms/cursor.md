# Cursor arm

Dispatches coding tasks to **Cursor Agent CLI** via headless `cursor-agent -p`.

## Auth

```bash
export CURSOR_API_KEY="crsr_..."
```

Add to `~/.bashrc` for persistence. Verify with `/cursor:setup` — runs a minimal "PING" probe (90s timeout). Note: `cursor-agent status` is broken under API-key auth and always reports "Not logged in"; trust `/cursor:setup`'s probe instead.

## Slash commands

| Command | Purpose |
|---|---|
| `/cursor:setup` | Verify CLI present + auth probe; writes setup-status.json |
| `/cursor:rescue [--background] [--model PRESET] [--worktree] PROMPT` | Dispatch task |
| `/cursor:status [JOB_ID]` | List jobs or detail one |
| `/cursor:result [JOB_ID]` | Final output for a finished job |
| `/cursor:cancel JOB_ID` | Graceful SIGTERM + state cleanup |
| `/cursor:review` | Read-only diff review of local git state |
| `/cursor:adversarial-review` | Diff review that challenges the direction |

## Model presets

| Preset | Resolves to | Notes |
|---|---|---|
| `auto` (default) | `auto` | Cursor's own pool — separate quota from premium |
| `premium` | `gemini-3.1-pro` | Premium quota; emits `QUOTA WARNING:` before dispatch |
| `reasoning` | `claude-opus-4-7-thinking-high` | Premium quota |
| `fast` | `composer-2` | Premium quota |

## Worktree mode

`--worktree` (or `-w`) creates an isolated branch. Useful when you want to review the work on a separate branch before merging.

## Examples

Background bug fix:
```
/cursor:rescue --background "Find and fix the off-by-one in src/parser.mjs:140-160. Add a regression test."
```

Synchronous small refactor:
```
/cursor:rescue "Rename usrInput to userInput across src/. Update tests."
```

Premium model for a hard reasoning task:
```
/cursor:rescue --model reasoning "Design the migration strategy for moving from session cookies to JWT. Output a migration plan with rollback steps."
```

Read-only review:
```
/cursor:review
```

Adversarial review of staged changes:
```
/cursor:adversarial-review
```

Worktree-isolated experiment:
```
/cursor:rescue --worktree "Try replacing express with hono. Show the diff but do not merge."
```

## State on disk

`~/.claude/plugins/data/ensemble-cursor/state/<workspace-hash>/`
- `state.json` — job index
- `jobs/<job-id>.json` — per-job record
- `jobs/<job-id>.log` — stdout/stderr stream
- `setup-status.json` — last setup probe

## Limitations

- Cursor CLI has no native background mode; companion forks detached and writes PID into state.
- First-call latency is high (~30-60s) — `CURSOR_AUTH_TIMEOUT_MS` is set to 90s for auth probes.
- `cursor-agent status` is unreliable under API-key auth.
