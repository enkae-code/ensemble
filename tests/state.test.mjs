import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getConfig, listJobs, loadState, resolveJobFile, resolveStateDir, setConfig, upsertJob, withStateLock, writeJobFile } from "../shared/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

test("state resolves a hashed workspace directory and defaults config", () => {
  const temp = makeTempDir("phase2-state-");
  const state = loadState(temp.path);
  assert.equal(state.version, 1);
  assert.equal(state.config.stopReviewGate, false);
  assert.match(resolveStateDir(temp.path), /phase2-state-/);
  temp.cleanup();
});

test("state writes config and jobs", () => {
  const temp = makeTempDir("phase2-state-");
  setConfig(temp.path, "stopReviewGate", true);
  assert.equal(getConfig(temp.path).stopReviewGate, true);
  upsertJob(temp.path, { id: "job-1", kind: "task", updatedAt: "2026-05-07T00:00:00.000Z" });
  assert.equal(listJobs(temp.path).length, 1);
  writeJobFile(temp.path, "job-1", { id: "job-1", ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(resolveJobFile(temp.path, "job-1"), "utf8")), { id: "job-1", ok: true });
  temp.cleanup();
});

test("withStateLock serializes work", () => {
  const temp = makeTempDir("phase2-state-");
  const marker = path.join(temp.path, "marker.txt");
  withStateLock(temp.path, () => {
    fs.writeFileSync(marker, "ok", "utf8");
  });
  assert.equal(fs.readFileSync(marker, "utf8"), "ok");
  temp.cleanup();
});
