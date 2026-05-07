import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createJobRecord, createJobLogFile, runTrackedJob } from "../shared/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile } from "../shared/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

test("runTrackedJob records completion and logs progress", async () => {
  const temp = makeTempDir("phase2-tracked-");
  const job = createJobRecord({
    id: "job-1",
    kind: "task",
    title: "Tracked Task",
    workspaceRoot: temp.path,
    logFile: createJobLogFile(temp.path, "job-1", "Starting"),
  });

  const finished = await runTrackedJob(job, async ({ reportProgress }) => {
    reportProgress({ message: "editing", phase: "editing" });
    return { result: { ok: true }, rendered: "done" };
  });

  assert.equal(finished.status, "completed");
  assert.equal(readJobFile(resolveJobFile(temp.path, "job-1")).status, "completed");
  assert.match(fs.readFileSync(job.logFile, "utf8"), /editing/);
  temp.cleanup();
});
