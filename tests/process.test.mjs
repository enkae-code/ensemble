import test from "node:test";
import assert from "node:assert/strict";
import { binaryAvailable, formatCommandFailure, runCommand, runCommandChecked, terminateProcessTree } from "../shared/lib/process.mjs";

test("runCommand captures stdout", () => {
  const result = runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ok");
});

test("runCommandChecked throws on failure", () => {
  assert.throws(() => runCommandChecked(process.execPath, ["-e", "process.exit(3)"]), /failed with exit code 3/);
});

test("binaryAvailable detects node", () => {
  assert.equal(binaryAvailable(process.execPath, ["--version"]), true);
});

test("formatCommandFailure includes stderr", () => {
  const result = runCommand(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(2)"]);
  assert.match(formatCommandFailure(result), /boom/);
});

test("terminateProcessTree returns false for invalid pid", () => {
  assert.equal(terminateProcessTree(-1), false);
});
