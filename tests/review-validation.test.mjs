import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSchema, validateReviewOutput, extractJsonBlock } from "../shared/lib/review-validation.mjs";

const cursorSchemaPath = path.resolve("plugins/cursor/schemas/review-output.schema.json");
const geminiSchemaPath = path.resolve("plugins/gemini/schemas/review-output.schema.json");

test("schema files load and have identical contracts across both arms", () => {
  const a = loadSchema(cursorSchemaPath);
  const b = loadSchema(geminiSchemaPath);
  assert.deepEqual(a, b);
});

test("validateReviewOutput accepts a well-formed payload", () => {
  const schema = loadSchema(cursorSchemaPath);
  const payload = {
    verdict: "approve",
    summary: "Looks fine.",
    findings: [],
    next_steps: ["ship it"],
  };
  const result = validateReviewOutput(payload, schema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateReviewOutput accepts findings with all required fields", () => {
  const schema = loadSchema(cursorSchemaPath);
  const payload = {
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [
      {
        severity: "high",
        title: "leak",
        body: "fd not closed",
        file: "src/io.mjs",
        line_start: 12,
        line_end: 14,
        confidence: 0.9,
        recommendation: "wrap in try/finally",
      },
    ],
    next_steps: ["fix the leak"],
  };
  assert.equal(validateReviewOutput(payload, schema).ok, true);
});

test("validateReviewOutput rejects missing required fields", () => {
  const schema = loadSchema(cursorSchemaPath);
  const result = validateReviewOutput({ verdict: "approve" }, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /summary/.test(e)));
  assert.ok(result.errors.some((e) => /findings/.test(e)));
});

test("validateReviewOutput rejects invalid verdict and severity", () => {
  const schema = loadSchema(cursorSchemaPath);
  const result = validateReviewOutput({
    verdict: "ship-it",
    summary: "x",
    findings: [{ severity: "blocker", title: "t", body: "b", file: "f", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "" }],
    next_steps: [],
  }, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /verdict/.test(e)));
  assert.ok(result.errors.some((e) => /severity/.test(e)));
});

test("extractJsonBlock pulls JSON from fenced markdown", () => {
  const text = "Here is the review:\n\n```json\n{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}\n```\n\nDone.";
  const parsed = extractJsonBlock(text);
  assert.equal(parsed.verdict, "approve");
});

test("extractJsonBlock falls back to first..last braces", () => {
  const text = "noise {\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]} trailing noise";
  const parsed = extractJsonBlock(text);
  assert.equal(parsed.verdict, "approve");
});

test("extractJsonBlock returns null when no JSON is present", () => {
  assert.equal(extractJsonBlock("just prose, nothing structured"), null);
});
