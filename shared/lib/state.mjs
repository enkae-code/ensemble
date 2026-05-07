import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const LOCK_DIR_NAME = ".lock";
const MAX_JOBS = 50;

function slugifyWorkspaceName(workspaceRoot) {
  return path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}

function canonicalWorkspaceRoot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return workspaceRoot;
  }
}

function stateRootDir() {
  return process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT_DIR;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: { stopReviewGate: false },
    jobs: [],
  };
}

function nowIso() {
  return new Date().toISOString();
}

function pruneJobs(cwd, jobs) {
  const kept = jobs
    .slice()
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
  const keptIds = new Set(kept.map((job) => job.id));

  for (const job of jobs) {
    if (!keptIds.has(job.id)) {
      removeFileIfExists(resolveJobFile(cwd, job.id));
      removeFileIfExists(resolveJobLogFile(cwd, job.id));
    }
  }

  return kept;
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function acquireLock(lockDir, timeoutMs = 5_000, pollMs = 25) {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n`, "utf8");
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for state lock: ${lockDir}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
    }
  }
}

function releaseLock(lockDir) {
  removeFileIfExists(path.join(lockDir, "owner"));
  try {
    fs.rmdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

/** Resolve the state directory for a workspace. */
export function resolveStateDir(cwd) {
  const workspaceRoot = canonicalWorkspaceRoot(cwd);
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(stateRootDir(), `${slugifyWorkspaceName(workspaceRoot)}-${hash}`);
}

/** Resolve the state index file for a workspace. */
export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

/** Resolve the per-job storage directory for a workspace. */
export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

/** Create the workspace state directory if it is missing. */
export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
  return resolveStateDir(cwd);
}

/** Load state from disk, defaulting to an empty schema. */
export function loadState(cwd) {
  const state = readJsonFile(resolveStateFile(cwd));
  if (!state) {
    return defaultState();
  }

  return {
    version: state.version ?? STATE_VERSION,
    config: { stopReviewGate: false, ...(state.config ?? {}) },
    jobs: Array.isArray(state.jobs) ? state.jobs : [],
  };
}

/** Save the state index to disk and prune expired job artifacts. */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: { stopReviewGate: false, ...(state.config ?? {}) },
    jobs: pruneJobs(cwd, Array.isArray(state.jobs) ? state.jobs : []),
  };
  writeJsonFile(resolveStateFile(cwd), nextState);
  return nextState;
}

/** Update the state index under a coarse lock and return the saved value. */
export function updateState(cwd, mutate, options = {}) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  acquireLock(lockDir, options.timeoutMs);
  try {
    const currentState = loadState(cwd);
    const nextState = mutate(structuredClone(currentState)) ?? currentState;
    return saveState(cwd, nextState);
  } finally {
    releaseLock(lockDir);
  }
}

/** Allowed characters for any externally-supplied job id (prevents path traversal). */
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Throw unless the id matches JOB_ID_PATTERN. */
export function assertSafeJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id: ${JSON.stringify(jobId)}`);
  }
  return jobId;
}

/** Create a sortable job id with a short random suffix. */
export function generateJobId(prefix = "job") {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "job";
  return `${safePrefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Insert or replace a job summary row in the state index. */
export function upsertJob(cwd, jobPatch) {
  if (!jobPatch?.id) {
    throw new Error("Job patch requires an id.");
  }

  let savedJob = null;
  updateState(cwd, (state) => {
    const jobs = state.jobs.filter((job) => job.id !== jobPatch.id);
    const previous = state.jobs.find((job) => job.id === jobPatch.id) ?? {};
    savedJob = { ...previous, ...jobPatch, updatedAt: jobPatch.updatedAt ?? nowIso() };
    jobs.push(savedJob);
    state.jobs = jobs;
    return state;
  });
  return savedJob;
}

/** List indexed jobs for a workspace, newest first. */
export function listJobs(cwd) {
  return loadState(cwd).jobs.slice().sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

/** Persist one config value in the state index. */
export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = { ...(state.config ?? {}), [key]: value };
    return state;
  }).config;
}

/** Read the workspace config object from state. */
export function getConfig(cwd) {
  return loadState(cwd).config;
}

/** Write a stored job payload to its per-job JSON file. */
export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonFile(jobFile, payload);
  return jobFile;
}

/** Read a stored job payload from disk, returning null when absent. */
export function readJobFile(jobFile) {
  return readJsonFile(jobFile);
}

/** Resolve the log file path for a job id. */
export function resolveJobLogFile(cwd, jobId) {
  assertSafeJobId(jobId);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

/** Resolve the stored JSON path for a job id. */
export function resolveJobFile(cwd, jobId) {
  assertSafeJobId(jobId);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

/** Run a callback while holding the workspace state lock. */
export function withStateLock(cwd, action, options = {}) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  acquireLock(lockDir, options.timeoutMs);
  try {
    return action();
  } finally {
    releaseLock(lockDir);
  }
}
