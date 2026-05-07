import test from "node:test";
import assert from "node:assert/strict";
import { markJobCancelled, markJobCompleted, markJobFailed, markJobRunning, readJob, startJob } from "../shared/lib/job-control.mjs";
import { makeTempDir } from "./helpers.mjs";

test("job-control stores lifecycle transitions", () => {
  const temp = makeTempDir("phase2-job-");
  startJob(temp.path, { id: "job-1", kind: "task", title: "Task" });
  assert.equal(readJob(temp.path, "job-1").status, "queued");
  markJobRunning(temp.path, "job-1");
  assert.equal(readJob(temp.path, "job-1").status, "running");
  markJobCompleted(temp.path, "job-1", { ok: true });
  assert.deepEqual(readJob(temp.path, "job-1").result, { ok: true });
  startJob(temp.path, { id: "job-2", kind: "task", title: "Task 2" });
  markJobFailed(temp.path, "job-2", new Error("boom"));
  assert.equal(readJob(temp.path, "job-2").errorMessage, "boom");
  startJob(temp.path, { id: "job-3", kind: "task", title: "Task 3" });
  markJobCancelled(temp.path, "job-3");
  assert.equal(readJob(temp.path, "job-3").status, "cancelled");
  temp.cleanup();
});
