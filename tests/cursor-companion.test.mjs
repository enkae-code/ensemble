import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildArgv, parseOutput, resolveModelPreset } from "../plugins/cursor/scripts/cli-adapter.mjs";
import { buildQuotaWarning, injectAgentsContext } from "../plugins/cursor/scripts/cursor-companion.mjs";
import { makeTempDir } from "./helpers.mjs";

test("buildArgv maps presets and worktree mode without leaking the API key", () => {
  const argv = buildArgv({
    prompt: "fix the bug",
    modelPreset: "premium",
    worktree: true,
    workspace: "/tmp/repo",
    apiKey: "secret",
  });

  assert.deepEqual(argv, [
    "-p",
    "--trust",
    "--output-format",
    "json",
    "--model",
    "gemini-3.1-pro",
    "--workspace",
    "/tmp/repo",
    "-w",
    "fix the bug",
  ]);
  assert.equal(argv.includes("--api-key"), false, "API key must not appear in argv (visible via ps)");
  assert.equal(argv.includes("secret"), false);
});

test("parseOutput extracts structured Cursor JSON output", () => {
  const parsed = parseOutput("\u001b]133;A\u001b\\{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"done\",\"session_id\":\"sess-1\"}", "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rawOutput, "done");
  assert.equal(parsed.sessionId, "sess-1");
});

test("resolveModelPreset and quota warnings cover all public presets", () => {
  assert.equal(resolveModelPreset("auto"), "auto");
  assert.equal(resolveModelPreset("reasoning"), "claude-opus-4-7-thinking-high");
  assert.equal(buildQuotaWarning("premium"), "QUOTA WARNING: preset 'premium' dispatches gemini-3.1-pro.");
  assert.equal(buildQuotaWarning("auto"), null);
});

test("injectAgentsContext prepends the nearest AGENTS.md", () => {
  const temp = makeTempDir("cursor-agents-");
  const repoRoot = temp.path;
  const nested = path.join(repoRoot, "src", "feature");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "repo rules", "utf8");

  const prompt = injectAgentsContext(nested, "Ship the fix.");
  assert.match(prompt, /<agents_md path=".*AGENTS\.md">/);
  assert.match(prompt, /repo rules/);
  assert.match(prompt, /Ship the fix\./);
  temp.cleanup();
});
