import fs from "node:fs";
import path from "node:path";
import { runCommand, runCommandChecked } from "./process.mjs";

const DEFAULT_INLINE_DIFF_MAX_FILES = 8;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const MAX_UNTRACKED_BYTES = 24 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function trimOutput(result) {
  return String(result.stdout ?? "").trim();
}

function detectOriginHead(cwd) {
  const result = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (!result.ok) {
    return null;
  }

  const match = trimOutput(result).match(/^refs\/remotes\/origin\/(.+)$/);
  return match?.[1] ?? null;
}

function refExists(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", ref]).ok;
}

function parseStatusLines(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  const files = [];
  const branches = { ahead: 0, behind: 0 };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const match = line.match(/ahead (\d+)/);
      if (match) {
        branches.ahead = Number(match[1]);
      }
      const behindMatch = line.match(/behind (\d+)/);
      if (behindMatch) {
        branches.behind = Number(behindMatch[1]);
      }
      continue;
    }

    files.push({
      indexStatus: line.slice(0, 1),
      workingTreeStatus: line.slice(1, 2),
      path: line.slice(3),
    });
  }

  return { files, ...branches };
}

function listUntrackedFiles(cwd) {
  const result = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return result.ok ? result.stdout.split("\n").filter(Boolean) : [];
}

function readSmallFile(cwd, relativePath, maxBytes) {
  const fullPath = path.join(cwd, relativePath);
  const stat = fs.statSync(fullPath);
  if (!stat.isFile() || stat.size > maxBytes) {
    return null;
  }

  return fs.readFileSync(fullPath, "utf8");
}

/** Throw when cwd is not inside a git repository. */
export function ensureGitRepository(cwd) {
  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  return repoRoot;
}

/** Return the repository root for cwd, or null when outside git. */
export function getRepoRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? trimOutput(result) : null;
}

/** Detect the default branch name for the current repository. */
export function detectDefaultBranch(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  const originHead = detectOriginHead(repoRoot);
  if (originHead) {
    return originHead;
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (refExists(repoRoot, candidate) || refExists(repoRoot, `origin/${candidate}`)) {
      return candidate;
    }
  }

  return getCurrentBranch(repoRoot) ?? "main";
}

/** Return the current branch name, or null in detached HEAD. */
export function getCurrentBranch(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  const result = git(repoRoot, ["branch", "--show-current"]);
  const branch = trimOutput(result);
  return branch || null;
}

/** Report branch and file status for the working tree. */
export function getWorkingTreeState(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  const status = gitChecked(repoRoot, ["status", "--porcelain=v1", "--branch"]);
  const parsed = parseStatusLines(status.stdout);
  return {
    repoRoot,
    branch: getCurrentBranch(repoRoot),
    changedFiles: parsed.files,
    ahead: parsed.ahead,
    behind: parsed.behind,
    clean: parsed.files.length === 0,
    hasUntracked: parsed.files.some((file) => file.indexStatus === "?" || file.workingTreeStatus === "?"),
  };
}

/** Resolve a review target from explicit options or repository state. */
export function resolveReviewTarget(cwd, options = {}) {
  const repoRoot = ensureGitRepository(cwd);
  if (options.commit) {
    return { mode: "commit", label: `commit ${options.commit}`, commit: options.commit, explicit: true };
  }

  if (options.baseRef || options.branch) {
    const baseRef = options.baseRef ?? options.branch;
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true,
    };
  }

  const state = getWorkingTreeState(repoRoot);
  if (!state.clean) {
    return { mode: "working-tree", label: "working tree diff", explicit: false };
  }

  const branch = state.branch;
  const defaultBranch = detectDefaultBranch(repoRoot);
  if (branch && branch !== defaultBranch) {
    return {
      mode: "branch",
      label: `branch diff against ${defaultBranch}`,
      baseRef: defaultBranch,
      explicit: false,
    };
  }

  return { mode: "commit", label: "HEAD commit", commit: "HEAD", explicit: false };
}

/** Collect review context, choosing inline diffs only when the payload stays small. */
export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = ensureGitRepository(cwd);
  const branch = getCurrentBranch(repoRoot);
  const maxInlineFiles = options.maxInlineFiles ?? DEFAULT_INLINE_DIFF_MAX_FILES;
  const maxInlineDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;

  if (target.mode === "branch") {
    const mergeBase = trimOutput(gitChecked(repoRoot, ["merge-base", target.baseRef, "HEAD"]));
    const diff = gitChecked(repoRoot, ["diff", "--stat", `${mergeBase}..HEAD`]).stdout.trim();
    return {
      repoRoot,
      branch,
      target,
      summary: `Reviewing branch ${branch ?? "HEAD"} against ${target.baseRef} from merge-base ${mergeBase}.`,
      diff,
      usedSelfCollect: true,
    };
  }

  if (target.mode === "commit") {
    const diff = gitChecked(repoRoot, ["show", "--stat", "--format=medium", target.commit]).stdout.trim();
    return {
      repoRoot,
      branch,
      target,
      summary: `Reviewing commit ${target.commit}.`,
      diff,
      usedSelfCollect: true,
    };
  }

  const state = getWorkingTreeState(repoRoot);
  const changedPaths = state.changedFiles.map((file) => file.path);
  const diffText = gitChecked(repoRoot, ["diff", "--", ...changedPaths]).stdout;
  const includeInlineDiff = changedPaths.length <= maxInlineFiles
    && Buffer.byteLength(diffText, "utf8") <= maxInlineDiffBytes;
  const untracked = [];

  if (includeInlineDiff) {
    for (const relativePath of listUntrackedFiles(repoRoot)) {
      const content = readSmallFile(repoRoot, relativePath, MAX_UNTRACKED_BYTES);
      if (content != null) {
        untracked.push({ path: relativePath, content });
      }
    }
  }

  return {
    repoRoot,
    branch,
    target,
    summary: `Reviewing ${changedPaths.length} working tree change(s).`,
    changedPaths,
    diff: includeInlineDiff ? diffText.trim() : null,
    untracked,
    usedSelfCollect: !includeInlineDiff,
    guidance: includeInlineDiff ? null : "Collect review evidence from git status and targeted file reads.",
  };
}

/** Return whether cwd belongs to a linked git worktree. */
export function isGitWorktree(cwd) {
  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) {
    return false;
  }

  const gitDir = trimOutput(gitChecked(repoRoot, ["rev-parse", "--git-dir"]));
  return gitDir.includes(`${path.sep}worktrees${path.sep}`);
}
