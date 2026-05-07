import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create and later clean a temporary test directory. */
export function makeTempDir(prefix = "cca-tests-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: tempDir,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
