import fs from "node:fs";
import path from "node:path";
import {
  generateJobId,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile,
} from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

/** Return the current time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString();
}

function prefixLogLine(message) {
  return `[${nowIso()}] ${message}`;
}

/** Append one timestamped line to a job log file. */
export function appendLogLine(logFile, message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${prefixLogLine(message)}\n`, "utf8");
}

/** Append a titled multi-line block to a job log file. */
export function appendLogBlock(logFile, title, body) {
  appendLogLine(logFile, `${title}:`);
  const normalized = String(body ?? "").replace(/\r\n/g, "\n");
  for (const line of normalized.split("\n")) {
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  }
}

/** Create a new log file for a job and write the initial heading. */
export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `${prefixLogLine(title)}\n`, "utf8");
  return logFile;
}

/** Build a new job record with ids, timestamps, and session metadata. */
export function createJobRecord(base, options = {}) {
  const id = base.id ?? generateJobId(options.prefix ?? base.kind ?? "job");
  return {
    ...base,
    id,
    sessionId: options.sessionId ?? process.env[SESSION_ID_ENV] ?? null,
    createdAt: base.createdAt ?? nowIso(),
    updatedAt: base.updatedAt ?? nowIso(),
    status: base.status ?? "queued",
    phase: base.phase ?? "queued",
  };
}

/** Create a function that writes job progress into state and storage. */
export function createJobProgressUpdater(workspaceRoot, jobId) {
  return (patch = {}) => {
    const jobFile = writeJobFile(workspaceRoot, jobId, {
      ...(readJobFile(resolveJobFile(workspaceRoot, jobId)) ?? {}),
      ...patch,
      id: jobId,
    });
    const storedJob = readJobFile(jobFile) ?? patch;
    const job = upsertJob(workspaceRoot, {
      ...storedJob,
      ...patch,
      id: jobId,
      updatedAt: nowIso(),
    });
    return { job, jobFile };
  };
}

function normalizeEvent(value) {
  if (typeof value === "string") {
    return { message: value, phase: null };
  }

  return {
    message: value?.message ?? "",
    phase: value?.phase ?? null,
    patch: value?.patch ?? {},
  };
}

/** Create a progress callback that can log to stderr, file, and state. */
export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  return (event) => {
    const normalized = normalizeEvent(event);
    if (stderr && normalized.message) {
      process.stderr.write(`${normalized.message}\n`);
    }
    if (logFile && normalized.message) {
      appendLogLine(logFile, normalized.message);
    }
    if (onEvent) {
      onEvent(normalized);
    }
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  return readJobFile(resolveJobFile(workspaceRoot, jobId));
}

/** Run an async job while keeping state, storage, and logs in sync. */
export async function runTrackedJob(job, runner, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(job.workspaceRoot ?? options.cwd ?? process.cwd());
  const logFile = job.logFile ?? createJobLogFile(workspaceRoot, job.id, `Starting ${job.title ?? job.kind ?? "job"}.`);
  const updateProgress = createJobProgressUpdater(workspaceRoot, job.id);
  const baseJob = {
    ...job,
    workspaceRoot,
    logFile,
    status: "running",
    phase: job.phase === "queued" ? "starting" : (job.phase ?? "starting"),
    startedAt: job.startedAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  updateProgress(baseJob);
  const reportProgress = createProgressReporter({
    stderr: options.stderr ?? false,
    logFile,
    onEvent: (event) => {
      const patch = { ...(event.patch ?? {}) };
      if (event.phase) {
        patch.phase = event.phase;
      }
      if (Object.keys(patch).length > 0) {
        updateProgress(patch);
      }
    },
  });

  try {
    const outcome = await runner({ job: { ...job, workspaceRoot, logFile }, updateProgress, reportProgress });
    const completedJob = {
      status: "completed",
      phase: "done",
      completedAt: nowIso(),
      updatedAt: nowIso(),
      result: outcome?.result ?? outcome ?? null,
      rendered: outcome?.rendered ?? null,
    };
    updateProgress(completedJob);
    appendLogLine(logFile, "Job completed.");
    return { ...(readStoredJobOrNull(workspaceRoot, job.id) ?? {}), ...completedJob };
  } catch (error) {
    const failedJob = {
      status: "failed",
      phase: "failed",
      completedAt: nowIso(),
      updatedAt: nowIso(),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    updateProgress(failedJob);
    appendLogLine(logFile, failedJob.errorMessage);
    throw error;
  }
}
