import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildArgv, parseOutput, resolveModelPreset } from "../plugins/gemini/scripts/cli-adapter.mjs";
import { injectAgentsContext, summarizePrompt, runGeminiInvocation } from "../plugins/gemini/scripts/gemini-companion.mjs";
import { makeTempDir } from "./helpers.mjs";

test("buildArgv defaults to pro and includes --yolo", () => {
  assert.deepEqual(buildArgv({ prompt: "do stuff" }), ["-p", "do stuff", "--yolo", "-m", "gemini-2.5-pro"]);
});

test("buildArgv supports flash preset", () => {
  const argv = buildArgv({ prompt: "fast", modelPreset: "flash" });
  assert.equal(argv[argv.indexOf("-m") + 1], "gemini-2.5-flash");
});

test("resolveModelPreset accepts pro and flash only", () => {
  assert.equal(resolveModelPreset("pro"), "gemini-2.5-pro");
  assert.equal(resolveModelPreset("flash"), "gemini-2.5-flash");
  assert.throws(() => resolveModelPreset("preview"));
});

test("parseOutput cleans terminal noise", () => {
  const parsed = parseOutput("Warning: True color (24-bit) support not detected.\nReal answer", "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rawOutput, "Real answer");
});

test("summarizePrompt truncates long prompts", () => {
  const summary = summarizePrompt("a".repeat(200));
  assert.ok(summary.length <= 120);
});

test("injectAgentsContext prepends the nearest AGENTS.md", () => {
  const temp = makeTempDir("gemini-agents-");
  const repoRoot = temp.path;
  const nested = path.join(repoRoot, "src", "feature");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "rule one", "utf8");
  const prompt = injectAgentsContext(nested, "Ship it.");
  assert.match(prompt, /<agents_md path=".*AGENTS\.md">/);
  assert.match(prompt, /rule one/);
  assert.match(prompt, /Ship it\./);
  temp.cleanup();
});

test("runGeminiInvocation retries on rate-limited responses then succeeds", async () => {
  const calls = [];
  const originalSpawn = (await import("node:child_process")).default.spawn;
  // Mock by monkey-patching child_process.spawn
  const childProcess = (await import("node:child_process")).default;
  let attempt = 0;
  childProcess.spawn = function mockSpawn(_cmd, _argv, _opts) {
    calls.push(attempt);
    const events = {};
    const stdoutHandlers = [];
    const stderrHandlers = [];
    const closeHandlers = [];
    const child = {
      stdout: {
        setEncoding() {},
        on(event, handler) { if (event === "data") stdoutHandlers.push(handler); },
      },
      stderr: {
        setEncoding() {},
        on(event, handler) { if (event === "data") stderrHandlers.push(handler); },
      },
      on(event, handler) {
        events[event] = handler;
        if (event === "close") closeHandlers.push(handler);
      },
    };
    setImmediate(() => {
      if (attempt < 1) {
        stderrHandlers.forEach((h) => h("status: 429 Too Many Requests"));
        closeHandlers.forEach((h) => h(1, null));
      } else {
        stdoutHandlers.forEach((h) => h("ok response"));
        closeHandlers.forEach((h) => h(0, null));
      }
      attempt += 1;
    });
    return child;
  };
  try {
    const parsed = await runGeminiInvocation({ cwd: process.cwd(), prompt: "x", backoffs: [10] });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rawOutput, "ok response");
    assert.equal(calls.length, 2);
  } finally {
    childProcess.spawn = originalSpawn;
  }
});
