# ensemble

Two extra execution arms for Claude Code: **Cursor Agent** and **Gemini CLI**.

Mirrors the architecture of OpenAI's official Codex plugin so you can dispatch tasks, run reviews, and run adversarial reviews against either CLI from inside Claude Code — same patterns, same job lifecycle, same hooks.

## Status

Alpha. APIs and command names may shift.

## Why

Anthropic's marketplace ships only one external execution arm (Codex). If Codex is on cooldown, billed out, or you want a different model family, you're stuck. This plugin pack gives you two more arms with full parity:

- background dispatch
- persistent job state
- status / result / cancel
- review + adversarial-review
- session lifecycle hooks
- optional Stop-time review gate
- per-project AGENTS.md auto-injection
- shared state DB across sessions

## Install

```bash
claude marketplace add brodey/ensemble
claude plugin install cursor
claude plugin install gemini
```

(Final repo URL TBD; this is a placeholder for the alpha.)

## Quick start

### Cursor arm

Requires `CURSOR_API_KEY` exported (e.g. in `~/.bashrc`).

```bash
/cursor:setup                                    # verify auth
/cursor:rescue --background "fix the auth bug"   # dispatch
/cursor:status                                    # list jobs
/cursor:result <job-id>                           # pull final output
/cursor:review                                    # read-only diff review
/cursor:adversarial-review                        # challenges direction
/cursor:cancel <job-id>                           # graceful cancel
```

Default model is `auto`. Premium presets (`premium`, `reasoning`, `fast`) trigger a quota warning before dispatch.

### Gemini arm

Requires `gemini auth login` (OAuth Google account).

```bash
/gemini:setup
/gemini:rescue --background "explain this codebase"
/gemini:status
/gemini:result <job-id>
/gemini:review
/gemini:adversarial-review
/gemini:cancel <job-id>
```

Default model is `gemini-2.5-pro`. Flash variant available via `--model flash`. The companion auto-retries 429 capacity errors with exponential backoff (2s → 32s, 5 attempts).

## Architecture

See `docs/ARCHITECTURE.md` (~2k lines, mirrors the Codex plugin layout). High-level layout:

```
plugins/
├── cursor/                        # Cursor arm
│   ├── .claude-plugin/plugin.json
│   ├── commands/*.md              # 7 slash commands
│   ├── skills/*/SKILL.md          # 3 sub-skills
│   ├── agents/cursor-rescue.md
│   ├── hooks/{hooks.json,session-lifecycle.mjs,stop-review-gate.mjs}
│   ├── prompts/adversarial-review.md
│   ├── schemas/review-output.schema.json
│   └── scripts/{cursor-companion.mjs, cli-adapter.mjs}
└── gemini/                        # Gemini arm (mirror of Cursor)

shared/lib/                        # Shared modules used by both arms
                                   # process, args, fs, git, state, render,
                                   # job-control, tracked-jobs, workspace,
                                   # cli-adapter, hooks, review-validation
```

## Stop-time review gate (opt-in)

```bash
export EXTRA_ARMS_REVIEW_GATE=1
```

When set, the Stop hook runs `/cursor:review` (or `/gemini:review`) on every Claude turn end. Output must start with `ALLOW:` or the gate blocks the turn with `BLOCK:` reason. Off by default.

## Contributing

See `docs/CONTRIBUTING.md`.

## License

MIT. Architectural patterns are inspired by OpenAI's Codex plugin (Apache-2.0). See `NOTICE`.
