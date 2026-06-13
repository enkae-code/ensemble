# Contributing

Thanks for the interest. The repo is still alpha; expect rough edges.

## Setup

```bash
git clone <repo-url> ensemble
cd ensemble
npm install                    # no runtime deps; this only sets up package metadata
npm test                       # runs node:test against tests/
npm run lint:json              # validates every .json file
```

Node 20+ required. No external runtime dependencies — only Node built-ins.

## Project layout

- `shared/lib/` — generic modules used by the arm (process, args, fs, git, state, render, job-control, tracked-jobs, workspace, cli-adapter, hooks, review-validation)
- `plugins/cursor/` — Cursor arm (CLI: `cursor-agent`)
- `tests/` — `node:test` suites covering the cursor arm + shared
- `docs/` — architecture, per-arm guides, this file

Each arm mirrors the same structure: `commands/`, `skills/`, `agents/`, `hooks/`, `prompts/`, `schemas/`, `scripts/`.

## Adding a new arm

1. Pick a CLI that supports headless prompt mode (`--prompt` / `-p` / equivalent).
2. Create `plugins/<name>/` mirroring an existing arm.
3. Implement `plugins/<name>/scripts/cli-adapter.mjs` exporting `buildArgv`, `spawn`, `parseOutput`, `detectAuth`.
4. Implement `plugins/<name>/scripts/<name>-companion.mjs` — copy the structure of one of the existing companions; keep subcommand names and flags consistent across arms.
5. Add the 7 standard slash commands under `commands/`.
6. Add 3 sub-skills (`<name>-cli-runtime`, `<name>-prompting`, `<name>-result-handling`).
7. Add agent + adversarial prompt + schema.
8. Wire hooks via `plugins/<name>/hooks/`.
9. Add tests for adapter + companion + injection.
10. Register in root `.claude-plugin/marketplace.json`.

## Code rules

- ESM only (`.mjs`).
- Named exports only — no default exports.
- One-line JSDoc per exported function.
- No external runtime dependencies. Stick to Node built-ins.
- Tests use `node:test` only.
- Keep slash command markdown files thin — they should call the companion script via Bash and return stdout verbatim. Logic lives in the companion, not the command file.

## Testing

```bash
npm test                       # full suite
node --test tests/some.test.mjs   # one file
```

Tests should not require network access or the underlying CLIs to be installed; mock spawnSync where needed.

## Filing issues

Please include:
- Node version (`node -v`)
- OS + shell
- Which arm (cursor)
- Output of `/<arm>:setup`
- Reproducer command + the resulting state dir contents (`~/.claude/plugins/data/<arm>-extra-arms/state/...`)

## License

MIT. By contributing, you agree your contributions are licensed under MIT.
