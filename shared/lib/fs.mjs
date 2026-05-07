import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve a path against cwd unless it is already absolute. */
export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

/** Create a temporary directory and return its absolute path. */
export function createTempDir(prefix = "multi-cli-plugins-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Read and parse a JSON file, returning null when it is absent. */
export function readJsonFile(filePath) {
  const text = safeReadFile(filePath);
  return text == null ? null : JSON.parse(text);
}

/** Write JSON to disk atomically, creating parent directories as needed. */
export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tempPath, payload, "utf8");
  fs.renameSync(tempPath, filePath);
}

/** Read a text file and return null when it does not exist. */
export function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/** Detect whether a buffer is probably human-readable text. */
export function isProbablyText(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return false;
  }

  let suspiciousBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return false;
    }
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!printable) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / Math.max(buffer.length, 1) < 0.15;
}

/** Read stdin when input is piped; otherwise return null. */
export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return null;
  }

  return fs.readFileSync(0, "utf8");
}
