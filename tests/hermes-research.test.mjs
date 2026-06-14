// fallow-ignore-file complexity
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";

const COMPANION_PATH = path.resolve("plugins/hermes/scripts/hermes-companion.mjs");

function runNode(args, options = {}) {
  return childProcess.spawnSync(process.execPath, args, {
    encoding: "utf8",
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
}

function waitFor(check, timeoutMs = 15_000, pollMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value) {
      return value;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
  throw new Error("Timed out waiting for condition.");
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function readOptionalPid(pidPath) {
  if (!fs.existsSync(pidPath)) {
    return null;
  }
  const parsed = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readHeartbeatMtime(heartbeatPath) {
  return fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).mtimeMs : null;
}

function assertStoppedHeartbeat(heartbeatPath, waitMs = 1_200) {
  const before = readHeartbeatMtime(heartbeatPath);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  const after = readHeartbeatMtime(heartbeatPath);
  assert.equal(after, before, "heartbeat advanced after cancel");
}

function assertProcessGone(pid, label) {
  waitFor(() => !processExists(pid), 8_000, 100);
  assert.equal(processExists(pid), false, `${label} is still running`);
}

function initializeStateDb(dbPath) {
  const script = `
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.executescript(
    """
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at REAL NOT NULL,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        output_tokens INTEGER DEFAULT 0,
        api_call_count INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL
    );
    """
)
connection.commit()
`;
  const result = childProcess.spawnSync("python3", ["-c", script, dbPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function writeHermesStub(binDir) {
  const stubPath = path.join(binDir, "hermes");
  const script = `#!/bin/bash
set -euo pipefail

payload=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -z)
      shift
      payload="\${1:-}"
      ;;
  esac
  shift || break
done

marker="$(python3 -c 'import re, sys; match = re.search(r"\\[modeb-launch-id:[^\\]]+\\]", sys.argv[1]); print(match.group(0) if match else "")' "$payload")"
session_id="stub-\$\$"

if [[ -n "\${MODEB_STUB_PID_FILE:-}" ]]; then
  printf '%s\\n' "$$" > "$MODEB_STUB_PID_FILE"
fi

touch_heartbeat() {
  if [[ -n "\${MODEB_STUB_HEARTBEAT_FILE:-}" ]]; then
    date +%s > "$MODEB_STUB_HEARTBEAT_FILE"
  fi
}

python3 - "$HERMES_STATE_DB" "$session_id" "$marker" <<'PY'
import sqlite3
import sys
import time

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    """
    INSERT INTO sessions (
        id,
        source,
        started_at,
        estimated_cost_usd,
        output_tokens,
        api_call_count
    ) VALUES (?, ?, ?, ?, ?, ?)
    """,
    (sys.argv[2], "cli", time.time(), 0.0, 10, 1),
)
connection.execute(
    """
    INSERT INTO messages (
        session_id,
        role,
        content,
        timestamp
    ) VALUES (?, ?, ?, ?)
    """,
    (sys.argv[2], "user", sys.argv[3], time.time()),
)
connection.commit()
PY

count=1
trap 'touch_heartbeat; exit 143' TERM INT
while true; do
  python3 - "$HERMES_STATE_DB" "$session_id" "$count" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    "UPDATE sessions SET api_call_count = ?, output_tokens = ? WHERE id = ?",
    (int(sys.argv[3]), int(sys.argv[3]) * 10, sys.argv[2]),
)
connection.commit()
PY
  touch_heartbeat
  count=$((count + 1))
  sleep 1
done
`;
  fs.writeFileSync(stubPath, script, "utf8");
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function createResearchFixture(prefix) {
  const temp = makeTempDir(prefix);
  const workspace = path.join(temp.path, "workspace");
  const homeDir = path.join(temp.path, "home");
  const binDir = path.join(temp.path, "bin");
  const dbPath = path.join(temp.path, "state.db");
  const reportPath = path.join(temp.path, "report.md");
  const stubPidPath = path.join(temp.path, "stub.pid");
  const heartbeatPath = path.join(temp.path, "stub.heartbeat");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".hermes"), { recursive: true });
  initializeStateDb(dbPath);
  writeHermesStub(binDir);
  fs.writeFileSync(path.join(homeDir, ".hermes", "auth.json"), JSON.stringify({
    credential_pool: {
      "opencode-go": [
        {
          id: "hermes-research-test",
          label: "default",
        },
      ],
    },
  }, null, 2));

  return {
    temp,
    workspace,
    reportPath,
    stubPidPath,
    heartbeatPath,
    jobFileCache: new Map(),
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH}`,
      HERMES_STATE_DB: dbPath,
      CLAUDE_PLUGIN_DATA: path.join(homeDir, ".claude", "plugins", "data", "ensemble-hermes"),
      MODEB_STUB_PID_FILE: stubPidPath,
      MODEB_STUB_HEARTBEAT_FILE: heartbeatPath,
    },
  };
}

function resolveStoredJobPath(fixture, jobId) {
  const cached = fixture.jobFileCache.get(jobId);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  const stateRoot = path.join(fixture.env.CLAUDE_PLUGIN_DATA, "state");
  if (!fs.existsSync(stateRoot)) {
    return null;
  }

  for (const workspaceDir of fs.readdirSync(stateRoot)) {
    const candidate = path.join(stateRoot, workspaceDir, "jobs", `${jobId}.json`);
    if (fs.existsSync(candidate)) {
      fixture.jobFileCache.set(jobId, candidate);
      return candidate;
    }
  }

  return null;
}

function readJobForFixture(fixture, jobId) {
  const jobPath = resolveStoredJobPath(fixture, jobId);
  if (!jobPath || !fs.existsSync(jobPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jobPath, "utf8"));
}

function startResearchJob(fixture, prompt) {
  const start = runNode([
    COMPANION_PATH,
    "research",
    "--background",
    "--cwd",
    fixture.workspace,
    "--report",
    fixture.reportPath,
    "--idle",
    "30",
    "--wall",
    "60",
    prompt,
  ], { env: fixture.env, cwd: fixture.workspace });
  assert.equal(start.status, 0, start.stderr);

  const startLines = start.stdout.trim().split("\n");
  const startedLine = startLines.find((line) => line.startsWith("started "));
  const workerPidLine = startLines.find((line) => line.startsWith("pid "));
  assert.ok(startedLine, start.stdout);
  assert.ok(workerPidLine, start.stdout);

  return {
    jobId: startedLine.replace("started ", "").trim(),
    workerPid: Number.parseInt(workerPidLine.replace("pid ", "").trim(), 10),
  };
}

function waitForCancelledJob(fixture, jobId) {
  return waitFor(() => {
    const job = readJobForFixture(fixture, jobId);
    return job?.status === "cancelled" && typeof job.rendered === "string" ? job : null;
  }, 15_000, 100);
}

function cancelResearchJob(fixture, jobId) {
  const cancel = runNode([COMPANION_PATH, "cancel", "--cwd", fixture.workspace, jobId], {
    env: fixture.env,
    cwd: fixture.workspace,
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`Cancelled research ${jobId}\\.`));
}

function assertCancelledRunStopped(fixture, job, workerPid) {
  const stubPid = waitFor(() => readOptionalPid(fixture.stubPidPath), 8_000, 100);
  const trackedPids = [
    ["worker", workerPid],
    ["modeb", Number.parseInt(String(job.modebPid ?? ""), 10)],
    ["session-child", Number.parseInt(String(job.sessionChildPid ?? ""), 10)],
    ["stub", stubPid],
  ].filter(([, pid]) => Number.isInteger(pid) && pid > 0);

  for (const [label, pid] of trackedPids) {
    assertProcessGone(pid, label);
  }
  assertStoppedHeartbeat(fixture.heartbeatPath);
}

test("research cancel stops the worker, modeb wrapper, setsid child, and stub heartbeat", () => {
  const fixture = createResearchFixture("hermes-research-liveness-");
  try {
    const { jobId, workerPid } = startResearchJob(fixture, "Investigate the cancellation seam.");
    const runningJob = waitFor(() => {
      const job = readJobForFixture(fixture, jobId);
      return job?.modebPid && job?.sessionChildPid ? job : null;
    }, 15_000, 100);
    assert.equal(runningJob.kind, "research");
    assert.match(path.basename(String(runningJob.tempDir ?? "")), /^hermes-research-/);
    waitFor(() => readHeartbeatMtime(fixture.heartbeatPath) != null, 8_000, 100);

    const status = runNode([COMPANION_PATH, "status", "--cwd", fixture.workspace, jobId], {
      env: fixture.env,
      cwd: fixture.workspace,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`# Job ${jobId}`));

    cancelResearchJob(fixture, jobId);
    const cancelledJob = waitForCancelledJob(fixture, jobId);
    assert.equal(cancelledJob.result?.status, "cancelled");
    assert.equal(cancelledJob.result?.reportPath, fixture.reportPath);
    waitFor(() => !fs.existsSync(runningJob.tempDir), 8_000, 100);
    assert.equal(fs.existsSync(runningJob.tempDir), false, "research temp dir still exists after cancel");

    const result = runNode([COMPANION_PATH, "result", "--cwd", fixture.workspace, jobId], {
      env: fixture.env,
      cwd: fixture.workspace,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Status: cancelled/);
    assert.match(result.stdout, new RegExp(`Report: ${fixture.reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const report = waitFor(() => (fs.existsSync(fixture.reportPath) ? fs.readFileSync(fixture.reportPath, "utf8") : ""), 8_000, 100);
    assert.match(report, /## Stopped/);
    assert.match(report, /Reason: cancelled/);
    assertCancelledRunStopped(fixture, cancelledJob, workerPid);
  } finally {
    fixture.temp.cleanup();
  }
});

test("research cancel during the handoff window still leaves no live process behind", () => {
  const fixture = createResearchFixture("hermes-research-race-");
  try {
    const { jobId, workerPid } = startResearchJob(fixture, "Cancel during the FIFO handoff window.");
    cancelResearchJob(fixture, jobId);

    const cancelledJob = waitForCancelledJob(fixture, jobId);
    assert.equal(cancelledJob.result?.status, "cancelled");
    assertProcessGone(workerPid, "worker");

    const knownPids = [
      ["modeb", Number.parseInt(String(cancelledJob.modebPid ?? ""), 10)],
      ["session-child", Number.parseInt(String(cancelledJob.sessionChildPid ?? ""), 10)],
      ["stub", readOptionalPid(fixture.stubPidPath)],
    ].filter(([, pid]) => Number.isInteger(pid) && pid > 0);
    for (const [label, pid] of knownPids) {
      assertProcessGone(pid, label);
    }
    if (readHeartbeatMtime(fixture.heartbeatPath) != null) {
      assertStoppedHeartbeat(fixture.heartbeatPath);
    }
  } finally {
    fixture.temp.cleanup();
  }
});
