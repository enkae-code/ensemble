# Codex parity matrix

Manual checklist verifying both arms against the acceptance contract from `~/vault/04_Projects/multi-cli-plugins/requirements.md`. Last verified 2026-05-07.

| # | Acceptance item | Cursor | Gemini | Notes |
|---|---|---|---|---|
| 1 | Installs via `claude marketplace add <repo>` and appears in `/plugin` | ⏳ deferred | ⏳ deferred | Marketplace add is a Phase 11 (release) task; manifests validate locally. |
| 2 | All 7 slash commands present (rescue, status, result, cancel, review, adversarial-review, setup) | ✅ | ✅ | `plugins/{arm}/commands/*.md` × 7 each. |
| 3 | Background dispatch <500ms returning job_id | ✅ | ✅ | `--background` forks detached, writes PID, prints job_id immediately. |
| 4 | Background job survives Claude session restart | ✅ | ✅ | State persisted to disk under `~/.claude/plugins/data/{arm}-extra-arms/state/`. |
| 5 | Resume mode (`--resume`) continues prior conversation | ❌ v1 gap | ❌ v1 gap | Cursor and Gemini CLIs lack a stable headless thread-resume API. Documented in README. |
| 6 | AGENTS.md auto-injection (walk up from cwd) | ✅ | ✅ | `injectAgentsContext` + `findAgentsFile` covered by `tests/agents-md-injection.test.mjs`. |
| 7 | Stop-hook review gate (opt-in) | ✅ | ✅ | Gated on `EXTRA_ARMS_REVIEW_GATE=1`. Default off. |
| 8 | Session-lifecycle hook cleans orphaned jobs | ✅ | ✅ | `cleanupSessionJobs` in `shared/lib/hooks.mjs`. Tested. |
| 9 | State DB on disk (per workspace hash) | ✅ | ✅ | `shared/lib/state.mjs` with workspace-hashed dirs. |
| 10 | Multi-model presets via `--model PRESET` | ✅ | ✅ | Cursor: `auto\|premium\|reasoning\|fast` (default `auto`, premium quota-warn). Gemini: `pro\|flash` (default `pro`). |
| 11 | CI runs unit + integration tests on PR | ✅ | ✅ | `.github/workflows/ci.yml` runs `npm test` + `npm run lint:json`. |
| 12 | Documented in README + per-arm docs | ✅ | ✅ | README.md, docs/arms/{cursor,gemini}.md, docs/CONTRIBUTING.md, docs/ARCHITECTURE.md. |
| 13 | Review output JSON schema | ✅ | ✅ | `plugins/{arm}/schemas/review-output.schema.json` + validator. |
| 14 | Adversarial review prompt template | ✅ | ✅ | `plugins/{arm}/prompts/adversarial-review.md`. |
| 15 | Sub-skills bundled (cli-runtime, prompting, result-handling) | ✅ | ✅ | `plugins/{arm}/skills/` × 3 each. |
| 16 | Agent definition for rescue subagent | ✅ | ✅ | `plugins/{arm}/agents/{arm}-rescue.md`. |

## Stress + concurrency check

- [ ] 10 background jobs per arm, verify state DB stays consistent — **deferred to Phase 11 in clean environment** (current session is Flatpak-constrained for some CLI invocations; will run on host).
- [x] Both arms can co-exist in same repo without state conflicts — separate plugin data dirs (`ensemble-cursor` vs `ensemble-gemini`), separate state hashes per workspace.

## V1 gaps (documented, not blockers)

1. **`--resume`** — neither CLI exposes a stable headless thread-resume API. Workaround: callers track context themselves or re-prompt with summary.
2. **Live AGENTS.md hot-reload** — current implementation walks up at dispatch time only. If AGENTS.md changes mid-job, the running job uses the snapshot.
3. **Stop hook is opt-in** — Codex's is on by default. Ours requires `EXTRA_ARMS_REVIEW_GATE=1`. Intentional: alpha users shouldn't be surprised by blocked turns.

## Test summary

- 66 tests total via `node:test`
- All pass on current branch
- JSON lint clean

## Pre-release gating issues

- None blocking alpha. v1 gaps above are documented and OK for first release.
