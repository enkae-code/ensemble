import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "./git.mjs";

/** Resolve the logical workspace root for a cwd. */
export function resolveWorkspaceRoot(cwd) {
  return getRepoRoot(cwd) ?? path.resolve(cwd);
}

/** Walk upward from cwd to find the nearest AGENTS.md file. */
export function findAgentsFile(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
