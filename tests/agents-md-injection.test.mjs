import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { injectAgentsContext as injectCursor } from "../plugins/cursor/scripts/cursor-companion.mjs";
import { findAgentsFile } from "../shared/lib/workspace.mjs";
import { makeTempDir } from "./helpers.mjs";

function setupRepoFixture(rules) {
  const temp = makeTempDir("agents-injection-");
  const root = temp.path;
  fs.mkdirSync(path.join(root, "src", "feature"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), rules, "utf8");
  return { temp, root, nested: path.join(root, "src", "feature") };
}

test("findAgentsFile walks up multiple directories to the root AGENTS.md", () => {
  const { temp, root, nested } = setupRepoFixture("# repo rules\nNo TODO comments.\n");
  const found = findAgentsFile(nested);
  assert.equal(path.resolve(found), path.resolve(path.join(root, "AGENTS.md")));
  temp.cleanup();
});

test("cursor injectAgentsContext wraps content with the agents_md tag and preserves the user prompt", () => {
  const { temp, nested } = setupRepoFixture("HARD RULE: never disable tests.");
  const prompt = injectCursor(nested, "Refactor the auth module.");
  assert.match(prompt, /<agents_md path=".*AGENTS\.md">/);
  assert.match(prompt, /HARD RULE: never disable tests\./);
  assert.match(prompt, /<\/agents_md>/);
  assert.ok(prompt.endsWith("Refactor the auth module."));
  temp.cleanup();
});

test("no AGENTS.md in scope returns the prompt unchanged", () => {
  const temp = makeTempDir("no-agents-");
  const cursorPrompt = injectCursor(temp.path, "Plain task.");
  assert.equal(cursorPrompt, "Plain task.");
  temp.cleanup();
});

test("empty AGENTS.md is treated as no rules", () => {
  const { temp, nested } = setupRepoFixture("   \n  \n");
  const prompt = injectCursor(nested, "Task.");
  assert.equal(prompt, "Task.");
  temp.cleanup();
});
