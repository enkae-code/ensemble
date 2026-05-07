import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { findAgentsFile, resolveWorkspaceRoot } from "../shared/lib/workspace.mjs";
import { runCommandChecked } from "../shared/lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

test("findAgentsFile walks up the directory tree", () => {
  const temp = makeTempDir("phase2-workspace-");
  const nested = path.join(temp.path, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(temp.path, "AGENTS.md"), "# Agents\n", "utf8");
  assert.equal(findAgentsFile(nested), path.join(temp.path, "AGENTS.md"));
  temp.cleanup();
});

test("resolveWorkspaceRoot returns repo root when cwd is inside git", () => {
  const temp = makeTempDir("phase2-workspace-");
  runCommandChecked("git", ["init", "-b", "main"], { cwd: temp.path });
  const nested = path.join(temp.path, "a");
  fs.mkdirSync(nested);
  assert.equal(resolveWorkspaceRoot(nested), fs.realpathSync(temp.path));
  temp.cleanup();
});
