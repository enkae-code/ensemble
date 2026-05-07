import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createTempDir, ensureAbsolutePath, isProbablyText, readJsonFile, safeReadFile, writeJsonFile } from "../shared/lib/fs.mjs";

test("ensureAbsolutePath resolves relative paths", () => {
  assert.equal(ensureAbsolutePath("/tmp/example", "a.txt"), path.join("/tmp/example", "a.txt"));
});

test("createTempDir creates a directory", () => {
  const directory = createTempDir("phase2-fs-");
  assert.equal(fs.statSync(directory).isDirectory(), true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("writeJsonFile writes atomically and readJsonFile parses it", () => {
  const directory = fs.mkdtempSync("/tmp/fs-test-");
  const filePath = path.join(directory, "state.json");
  writeJsonFile(filePath, { ok: true });
  assert.deepEqual(readJsonFile(filePath), { ok: true });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("safeReadFile returns null for missing files", () => {
  assert.equal(safeReadFile("/tmp/does-not-exist.txt"), null);
});

test("isProbablyText distinguishes ascii from binary", () => {
  assert.equal(isProbablyText(Buffer.from("hello\n", "utf8")), true);
  assert.equal(isProbablyText(Buffer.from([0, 1, 2, 3])), false);
});
