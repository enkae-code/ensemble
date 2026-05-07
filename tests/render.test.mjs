import test from "node:test";
import assert from "node:assert/strict";
import { renderCancelReport, renderJsonPretty, renderJobStatusReport, renderStatusReport, renderStoredJobResult } from "../shared/lib/render.mjs";

test("renderStatusReport builds a markdown table", () => {
  const text = renderStatusReport({ jobs: [{ id: "job-1", kind: "task", status: "running", phase: "editing", summary: "fix tests" }] });
  assert.match(text, /\| job-1 \| task \| running \| editing \| fix tests \|/);
});

test("renderJobStatusReport includes progress preview", () => {
  const text = renderJobStatusReport({ id: "job-1", status: "running", phase: "editing", progressPreview: ["Step 1"] });
  assert.match(text, /Step 1/);
});

test("renderStoredJobResult prefers rendered output", () => {
  const text = renderStoredJobResult({ id: "job-1" }, { rendered: "done" });
  assert.equal(text, "done\n");
  assert.equal(renderCancelReport({ id: "job-1" }), "Cancelled job job-1.\n");
  assert.match(renderJsonPretty({ ok: true }), /"ok": true/);
});
