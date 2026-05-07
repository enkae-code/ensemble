import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { terminateProcessTree } from "./process.mjs";
import { loadState, resolveStateFile, saveState } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const SESSION_ID_ENV_DEFAULT = "EXTRA_ARMS_SESSION_ID";
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const REVIEW_GATE_TIMEOUT_MS = 5 * 60 * 1000;
export const HOOK_STDIN_MAX_BYTES = 1024 * 1024;

/** Read newline-trimmed JSON from stdin (Claude hook input). Bounded + tolerant of malformed input. */
export function readHookInput() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return {};
  }
  if (raw.length > HOOK_STDIN_MAX_BYTES) {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Print a JSON decision payload Claude Code consumes. */
export function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Shell-escape a string for use inside an `export VAR=value` line. */
function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** Append an env var line to CLAUDE_ENV_FILE if Claude provided one. */
export function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

/** Remove queued/running jobs that belong to a session; terminate live PIDs first. */
export function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return { cleaned: 0 };
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return { cleaned: 0 };
  }
  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return { cleaned: 0 };
  }
  for (const job of sessionJobs) {
    if (job.status === "queued" || job.status === "running") {
      try { terminateProcessTree(job.pid ?? Number.NaN); } catch { /* ignore */ }
    }
  }
  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId),
  });
  return { cleaned: sessionJobs.length };
}

/** Handle SessionStart: persist session id + plugin data path into Claude env. */
export function handleSessionStart(input, sessionEnvName = SESSION_ID_ENV_DEFAULT) {
  appendEnvVar(sessionEnvName, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

/** Handle SessionEnd: clean orphan jobs left by this session. */
export function handleSessionEnd(input, options = {}) {
  const cwd = input.cwd ?? process.cwd();
  const sessionId = input.session_id ?? process.env[options.sessionEnvName ?? SESSION_ID_ENV_DEFAULT];
  return cleanupSessionJobs(cwd, sessionId);
}

/** Detect whether the working tree has any tracked changes worth reviewing. */
export function workspaceHasPendingChanges(cwd) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return false;
  }
  return Boolean(result.stdout && result.stdout.trim());
}

/** Run a Stop-time review-gate via the arm's companion script. */
export function runStopReviewGate(input, companionPath, options = {}) {
  if (process.env.EXTRA_ARMS_REVIEW_GATE !== "1") {
    return { ok: true, skipped: true };
  }
  const cwd = input.cwd ?? process.cwd();
  if (!workspaceHasPendingChanges(cwd)) {
    return { ok: true, skipped: true, reason: "no pending changes" };
  }
  const args = [companionPath, "review", "--cwd", cwd];
  const runResult = spawnSync(process.execPath, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? REVIEW_GATE_TIMEOUT_MS,
  });
  if (runResult.status === 0) {
    return { ok: true, skipped: false, output: runResult.stdout };
  }
  return {
    ok: false,
    skipped: false,
    reason: runResult.stderr?.trim() || `Review gate exited with code ${runResult.status}.`,
  };
}

/** Resolve a plugin script path relative to the hook script directory. */
export function resolveCompanionPath(scriptDir, relativeFromScripts) {
  return path.resolve(scriptDir, "..", "scripts", relativeFromScripts);
}
