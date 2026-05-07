import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectReviewContext, detectDefaultBranch, getCurrentBranch, getRepoRoot, getWorkingTreeState, isGitWorktree, resolveReviewTarget } from "../shared/lib/git.mjs";
import { runCommandChecked } from "../shared/lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

function initRepo() {
  const temp = makeTempDir("phase2-git-");
  runCommandChecked("git", ["init", "-b", "main"], { cwd: temp.path });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: temp.path });
  runCommandChecked("git", ["config", "user.name", "Test User"], { cwd: temp.path });
  fs.writeFileSync(path.join(temp.path, "file.txt"), "one\n", "utf8");
  runCommandChecked("git", ["add", "file.txt"], { cwd: temp.path });
  runCommandChecked("git", ["commit", "-m", "init"], { cwd: temp.path });
  return temp;
}

test("repo helpers inspect current repository", () => {
  const temp = initRepo();
  assert.equal(getRepoRoot(temp.path), fs.realpathSync(temp.path));
  assert.equal(getCurrentBranch(temp.path), "main");
  assert.equal(detectDefaultBranch(temp.path), "main");
  assert.equal(isGitWorktree(temp.path), false);
  temp.cleanup();
});

test("working tree target and context prefer inline diff for small changes", () => {
  const temp = initRepo();
  fs.writeFileSync(path.join(temp.path, "file.txt"), "two\n", "utf8");
  const state = getWorkingTreeState(temp.path);
  assert.equal(state.clean, false);
  const target = resolveReviewTarget(temp.path);
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(temp.path, target);
  assert.equal(context.usedSelfCollect, false);
  assert.match(context.diff, /two/);
  temp.cleanup();
});
