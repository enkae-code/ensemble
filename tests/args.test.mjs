import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString } from "../shared/lib/args.mjs";

test("splitRawArgumentString preserves quoted values", () => {
  assert.deepEqual(splitRawArgumentString("--cwd '/tmp/a b' task"), ["--cwd", "/tmp/a b", "task"]);
});

test("parseArgs handles aliases, booleans, and string flags", () => {
  const parsed = parseArgs(["-C", "/tmp/repo", "--write", "task"], {
    alias: { C: "cwd" },
    string: ["cwd"],
    boolean: ["write"],
  });
  assert.equal(parsed.cwd, "/tmp/repo");
  assert.equal(parsed.write, true);
  assert.deepEqual(parsed._, ["task"]);
});

test("parseArgs splits a single raw argv string", () => {
  const parsed = parseArgs(["--model gpt task"], { string: ["model"] });
  assert.equal(parsed.model, "gpt");
  assert.deepEqual(parsed._, ["task"]);
});
