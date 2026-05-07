import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";

function timestamp() {
  return new Date().toISOString();
}

function loadStoredJob(workspaceRoot, jobId) {
  return readJobFile(resolveJobFile(workspaceRoot, jobId));
}

function persistJob(workspaceRoot, jobId, patch) {
  const current = loadStoredJob(workspaceRoot, jobId);
  if (!current) {
    throw new Error(`Unknown job: ${jobId}`);
  }

  const nextJob = { ...current, ...patch, id: jobId, updatedAt: timestamp() };
  writeJobFile(workspaceRoot, jobId, nextJob);
  upsertJob(workspaceRoot, nextJob);
  return nextJob;
}

/** Store a newly created job in both the index and the per-job record. */
export function startJob(workspaceRoot, job) {
  const record = {
    ...job,
    createdAt: job.createdAt ?? timestamp(),
    updatedAt: job.updatedAt ?? timestamp(),
    status: job.status ?? "queued",
    phase: job.phase ?? "queued",
  };
  writeJobFile(workspaceRoot, record.id, record);
  upsertJob(workspaceRoot, record);
  return record;
}

/** Mark an existing job as running. */
export function markJobRunning(workspaceRoot, jobId, patch = {}) {
  return persistJob(workspaceRoot, jobId, {
    ...patch,
    status: "running",
    phase: patch.phase ?? "running",
    startedAt: patch.startedAt ?? timestamp(),
  });
}

/** Mark an existing job as completed and store its result payload. */
export function markJobCompleted(workspaceRoot, jobId, result = null, patch = {}) {
  return persistJob(workspaceRoot, jobId, {
    ...patch,
    status: "completed",
    phase: patch.phase ?? "done",
    completedAt: patch.completedAt ?? timestamp(),
    result,
  });
}

/** Mark an existing job as failed and store the failure message. */
export function markJobFailed(workspaceRoot, jobId, error, patch = {}) {
  return persistJob(workspaceRoot, jobId, {
    ...patch,
    status: "failed",
    phase: patch.phase ?? "failed",
    completedAt: patch.completedAt ?? timestamp(),
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

/** Mark an existing job as cancelled with a terminal message. */
export function markJobCancelled(workspaceRoot, jobId, reason = "Cancelled by user.", patch = {}) {
  return persistJob(workspaceRoot, jobId, {
    ...patch,
    status: "cancelled",
    phase: patch.phase ?? "cancelled",
    completedAt: patch.completedAt ?? timestamp(),
    cancelledAt: patch.cancelledAt ?? timestamp(),
    errorMessage: reason,
  });
}

/** Load one stored job payload from disk. */
export function readJob(workspaceRoot, jobId) {
  return loadStoredJob(workspaceRoot, jobId);
}
