import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

function normalizeSpawnOptions(options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    input = undefined,
    encoding = "utf8",
    timeout = 0,
    windowsHide = true,
    detached = false,
    shell = false,
    stdio = "pipe",
  } = options;

  return { cwd, env, input, encoding, timeout, windowsHide, detached, shell, stdio };
}

/** Run a child process synchronously and capture stdout, stderr, and exit data. */
export function runCommand(command, args = [], options = {}) {
  const child = spawnSync(command, args, normalizeSpawnOptions(options));
  return {
    command,
    args: [...args],
    cwd: options.cwd ?? process.cwd(),
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    exitCode: child.status,
    signal: child.signal ?? null,
    error: child.error ?? null,
    ok: child.error == null && child.status === 0,
  };
}

/** Run a command and throw when it fails. */
export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (!result.ok) {
    throw new Error(formatCommandFailure(result));
  }

  return result;
}

/** Check whether a binary is callable in the current environment. */
export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  return result.error == null && result.exitCode === 0;
}

function isMissingProcessError(error) {
  return error?.code === "ESRCH" || error?.code === "ENOENT";
}

/** Read process group id for pid via /proc on Linux; null if unavailable or unreadable. */
function readProcessGroupId(pid) {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) {
      return null;
    }
    const fields = stat.slice(rparen + 2).split(" ");
    const pgid = Number.parseInt(fields[2], 10);
    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

/** Terminate a process tree when possible and return whether a signal was sent.
 *  Defends against PID reuse by verifying the target still leads its own process group
 *  before issuing a group-wide kill. */
export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const signal = options.signal ?? "SIGTERM";
  if (process.platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], options);
    return result.ok || /not found|no running instance/i.test(result.stderr);
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    throw error;
  }

  const pgid = readProcessGroupId(pid);
  if (pgid === pid) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (isMissingProcessError(error)) {
        return false;
      }
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    throw error;
  }
}

/** Format a failed command result into a readable error string. */
export function formatCommandFailure(result) {
  const joinedArgs = [result.command, ...(result.args ?? [])].join(" ").trim();
  const reason = result.error?.message
    ?? (result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode ?? "unknown"}`);
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const tail = stderr || stdout;
  return tail ? `${joinedArgs} failed with ${reason}: ${tail}` : `${joinedArgs} failed with ${reason}`;
}
