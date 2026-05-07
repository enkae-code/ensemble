import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendEnvVar,
  cleanupSessionJobs,
  emitDecision,
  handleSessionStart,
  resolveCompanionPath,
  runStopReviewGate,
} from "../shared/lib/hooks.mjs";
import { saveState } from "../shared/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

function withEnvFile(fn) {
  const temp = makeTempDir("hooks-env-");
  const envFile = path.join(temp.path, "claude.env");
  fs.writeFileSync(envFile, "", "utf8");
  const prev = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = envFile;
  try {
    fn(envFile);
  } finally {
    if (prev === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = prev;
    }
    temp.cleanup();
  }
}

test("appendEnvVar shell-escapes single quotes safely", () => {
  withEnvFile((envFile) => {
    appendEnvVar("FOO", "with'quote");
    const written = fs.readFileSync(envFile, "utf8");
    assert.match(written, /^export FOO=/);
    assert.ok(written.includes("with"));
  });
});

test("handleSessionStart writes session id when an env file is present", () => {
  withEnvFile((envFile) => {
    handleSessionStart({ session_id: "abc-123" }, "TEST_SESSION_ID");
    const written = fs.readFileSync(envFile, "utf8");
    assert.match(written, /export TEST_SESSION_ID='abc-123'/);
  });
});

test("cleanupSessionJobs removes jobs that match the session id", () => {
  const temp = makeTempDir("hooks-cleanup-");
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(temp.path, "data");
  try {
    saveState(temp.path, {
      version: 1,
      jobs: [
        { id: "keep", sessionId: "other", status: "completed" },
        { id: "drop-1", sessionId: "doomed", status: "queued", pid: -1 },
        { id: "drop-2", sessionId: "doomed", status: "running", pid: -1 },
      ],
    });
    const result = cleanupSessionJobs(temp.path, "doomed");
    assert.equal(result.cleaned, 2);
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
    temp.cleanup();
  }
});

test("runStopReviewGate skips when EXTRA_ARMS_REVIEW_GATE is unset", () => {
  const previous = process.env.EXTRA_ARMS_REVIEW_GATE;
  delete process.env.EXTRA_ARMS_REVIEW_GATE;
  try {
    const result = runStopReviewGate({ cwd: process.cwd() }, "/bin/true");
    assert.equal(result.skipped, true);
    assert.equal(result.ok, true);
  } finally {
    if (previous !== undefined) {
      process.env.EXTRA_ARMS_REVIEW_GATE = previous;
    }
  }
});

test("resolveCompanionPath joins hook dir and scripts dir", () => {
  const resolved = resolveCompanionPath("/fake/plugins/cursor/hooks", "cursor-companion.mjs");
  assert.equal(resolved, "/fake/plugins/cursor/scripts/cursor-companion.mjs");
});

test("emitDecision writes JSON with newline", () => {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    emitDecision({ decision: "approve" });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(chunks[0], "{\"decision\":\"approve\"}\n");
});
