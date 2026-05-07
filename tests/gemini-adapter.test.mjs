import test from "node:test";
import assert from "node:assert/strict";
import { GEMINI_BIN, detectAuth, buildArgv, parseOutput, isRateLimited, resolveModelPreset } from "../plugins/gemini/scripts/cli-adapter.mjs";

test("detectAuth reports success when the probe returns the sentinel token", () => {
  const outcome = detectAuth({
    cwd: process.cwd(),
    spawnImpl(command, argv) {
      assert.equal(command, GEMINI_BIN);
      assert.match(argv.join(" "), /ENSEMBLE_AUTH_OK_X41/);
      assert.match(argv.join(" "), /gemini-2\.5-flash/);
      return { status: 0, stdout: "ENSEMBLE_AUTH_OK_X41\n", stderr: "", error: null };
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, "auth ok");
});

test("detectAuth reports rate-limited failures distinctly", () => {
  const outcome = detectAuth({
    cwd: process.cwd(),
    spawnImpl() {
      return { status: 1, stdout: "", stderr: "Error: status: 429 Too Many Requests", error: null };
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rateLimited, true);
});

test("detectAuth fails on unexpected probe output", () => {
  const outcome = detectAuth({
    cwd: process.cwd(),
    spawnImpl() {
      return { status: 0, stdout: "PONG\n", stderr: "", error: null };
    },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Unexpected/);
});

test("detectAuth tolerates extra whitespace or wrapping around the sentinel", () => {
  const outcome = detectAuth({
    cwd: process.cwd(),
    spawnImpl() {
      return { status: 0, stdout: "  ENSEMBLE_AUTH_OK_X41  \n", stderr: "", error: null };
    },
  });
  assert.equal(outcome.ok, true);
});

test("resolveModelPreset rejects unsupported presets", () => {
  assert.equal(resolveModelPreset("pro"), "gemini-2.5-pro");
  assert.equal(resolveModelPreset("flash"), "gemini-2.5-flash");
  assert.throws(() => resolveModelPreset("preview"), /Unsupported/);
});

test("buildArgv defaults to gemini-2.5-pro and includes --yolo", () => {
  const argv = buildArgv({ prompt: "test prompt" });
  assert.deepEqual(argv, ["-p", "test prompt", "--yolo", "-m", "gemini-2.5-pro"]);
});

test("buildArgv accepts an explicit model preset", () => {
  const argv = buildArgv({ prompt: "x", modelPreset: "flash" });
  assert.equal(argv[argv.indexOf("-m") + 1], "gemini-2.5-flash");
});

test("isRateLimited detects multiple 429 signals", () => {
  assert.equal(isRateLimited("", "status: 429"), true);
  assert.equal(isRateLimited("MODEL_CAPACITY_EXHAUSTED", ""), true);
  assert.equal(isRateLimited("Too Many Requests", ""), true);
  assert.equal(isRateLimited("RESOURCE_EXHAUSTED", ""), true);
  assert.equal(isRateLimited("ok", "ok"), false);
});

test("parseOutput marks rate-limited responses", () => {
  const result = parseOutput("partial output", "status: 429 Too Many Requests");
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
});
