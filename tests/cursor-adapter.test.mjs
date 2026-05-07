import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_AGENT_BIN, detectAuth } from "../plugins/cursor/scripts/cli-adapter.mjs";

test("detectAuth reports success when the probe returns the sentinel token", () => {
  const outcome = detectAuth({
    cwd: process.cwd(),
    env: { CURSOR_API_KEY: "test-key" },
    spawnImpl(command, argv) {
      assert.equal(command, CURSOR_AGENT_BIN);
      assert.match(argv.join(" "), /ENSEMBLE_AUTH_OK_X41/);
      return {
        status: 0,
        stdout: "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ENSEMBLE_AUTH_OK_X41\",\"session_id\":\"abc\"}",
        stderr: "",
        error: null,
      };
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, "auth ok");
  assert.equal(outcome.sessionId, "abc");
});

test("detectAuth reports failure when the probe exits non-zero", () => {
  const outcome = detectAuth({
    cwd: process.cwd(),
    env: { CURSOR_API_KEY: "test-key" },
    spawnImpl() {
      return {
        status: 1,
        stdout: "",
        stderr: "bad auth",
        error: null,
      };
    },
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /bad auth/);
});
