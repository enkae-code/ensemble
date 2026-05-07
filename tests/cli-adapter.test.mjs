import test from "node:test";
import assert from "node:assert/strict";
import { assertCliAdapter, createCliAdapter, REQUIRED_CLI_ADAPTER_METHODS } from "../shared/lib/cli-adapter.mjs";

function buildAdapter() {
  return {
    buildArgv() { return []; },
    spawn() { return null; },
    parseOutput() { return { ok: true }; },
    detectAuth() { return { ok: true }; },
  };
}

test("assertCliAdapter validates required methods", () => {
  assert.equal(REQUIRED_CLI_ADAPTER_METHODS.length, 4);
  assert.throws(() => assertCliAdapter({}), /buildArgv/);
  assert.equal(Object.isFrozen(createCliAdapter(buildAdapter())), true);
});
