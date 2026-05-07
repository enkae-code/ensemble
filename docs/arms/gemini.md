# Gemini arm

Dispatches coding tasks to **Gemini CLI** via headless `gemini -p ... --yolo`.

## Auth

```bash
gemini auth login
```

OAuth-personal Google account. No env-var key required. Verify with `/gemini:setup`.

## Slash commands

| Command | Purpose |
|---|---|
| `/gemini:setup` | Verify CLI present + auth probe |
| `/gemini:rescue [--background] [--model PRESET] [--worktree] PROMPT` | Dispatch task |
| `/gemini:status [JOB_ID]` | List jobs or detail one |
| `/gemini:result [JOB_ID]` | Final output for a finished job |
| `/gemini:cancel JOB_ID` | Graceful SIGTERM + state cleanup |
| `/gemini:review` | Read-only diff review of local git state |
| `/gemini:adversarial-review` | Diff review that challenges the direction |

## Model presets

| Preset | Resolves to | Notes |
|---|---|---|
| `pro` (default) | `gemini-2.5-pro` | Stable, strong reasoning |
| `flash` | `gemini-2.5-flash` | Faster, lower latency, lower cost |

**Avoided:** `gemini-3.1-pro-preview` returns chronic 429s due to Google server-side capacity (not user quota). The companion never selects preview models by default.

## 429 retry behavior

The companion retries 429 / `MODEL_CAPACITY_EXHAUSTED` / `RESOURCE_EXHAUSTED` responses with exponential backoff: 2s → 4s → 8s → 16s → 32s (5 attempts). After that it surfaces the error verbatim — distinct from regular failures so the caller can tell the difference.

## Examples

Pro-model background task:
```
/gemini:rescue --background "Summarize the architecture in docs/ARCHITECTURE.md and list the top 3 risks for OSS release."
```

Flash for fast turnaround:
```
/gemini:rescue --model flash "Generate a one-liner README badge for the test count."
```

Diff review:
```
/gemini:review
```

Adversarial review:
```
/gemini:adversarial-review
```

## State on disk

`~/.claude/plugins/data/ensemble-gemini/state/<workspace-hash>/`
- Same layout as Cursor arm.

## Limitations

- Gemini CLI has no native background mode; companion forks detached.
- Preview models share constrained capacity pools — the companion intentionally does not expose them as presets.
- Auth probe latency is high in some sandboxes; `GEMINI_AUTH_TIMEOUT_MS` is 120s.
