// fallow-ignore-file unused-file, unused-export, complexity
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createCliAdapter } from "../../../shared/lib/cli-adapter.mjs";
import { terminateProcessTree } from "../../../shared/lib/process.mjs";

export const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
export const HERMES_TIMEOUT_MS = parsePositiveIntegerEnv("HERMES_TIMEOUT_MS", 200_000);
export const AUTH_FILE = path.join(os.homedir(), ".hermes", "auth.json");
export const AUTH_PROBE_SENTINEL = "ENSEMBLE_HERMES_AUTH_OK_X41";

export const MODE_DEFAULTS = Object.freeze({
  dispatch: { provider: "opencode-go", model: "glm-5.1" },
  review: {
    provider: "opencode-go",
    model: "kimi-k2.6",
    fallbackProvider: "openrouter",
    fallbackModel: "nvidia/nemotron-3-super-120b-a12b:free",
  },
  ask: { provider: "opencode-go", model: "kimi-k2.6" },
});

function parsePositiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

/** Strip shell integration control sequences from CLI output. */
export function stripTerminalNoise(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .trim();
}

/** Parse a Hermes provider/model override. */
export function parseModelOverride(modelOverride) {
  if (!modelOverride) {
    return {};
  }

  const separatorIndex = String(modelOverride).indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === String(modelOverride).length - 1) {
    throw new Error("--model must use provider/model, for example opencode-go/kimi-k2.6.");
  }

  return {
    provider: String(modelOverride).slice(0, separatorIndex),
    model: String(modelOverride).slice(separatorIndex + 1),
  };
}

/** Resolve provider and model for one Hermes mode. */
export function resolveHermesTarget(options = {}) {
  const mode = options.mode ?? "dispatch";
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) {
    throw new Error(`Unsupported Hermes mode: ${mode}`);
  }

  const override = parseModelOverride(options.modelOverride);
  return {
    provider: options.provider ?? override.provider ?? defaults.provider,
    model: options.model ?? override.model ?? defaults.model,
    fallbackProvider: defaults.fallbackProvider ?? null,
    fallbackModel: defaults.fallbackModel ?? null,
  };
}

/** Build `hermes chat` argv from task options. */
export function buildArgv(options = {}) {
  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const target = resolveHermesTarget(options);
  if (!String(target.provider ?? "").trim()) {
    throw new Error("Hermes provider is required.");
  }
  if (!String(target.model ?? "").trim()) {
    throw new Error("Hermes model is required.");
  }

  const argv = ["chat", "-q", prompt, "-Q", "--provider", target.provider, "-m", target.model, "--yolo"];
  const skills = serializeSkills(options.skills);
  if (skills) {
    argv.push("-s", skills);
  }
  return argv;
}

function serializeSkills(skills) {
  if (Array.isArray(skills)) {
    return skills.map((skillName) => String(skillName).trim()).filter(Boolean).join(",");
  }

  return String(skills ?? "").trim();
}

function addProcessTreeKill(child) {
  child.kill = (signal = "SIGTERM") => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }

    return terminateProcessTree(child.pid, { signal });
  };
  return child;
}

/** Spawn `hermes` with the provided argv and environment. */
export function spawn(argv, env = process.env, cwd = process.cwd()) {
  const child = childProcess.spawn(HERMES_BIN, argv, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return addProcessTreeKill(child);
}

/** Return the last Hermes session_id trailer, if present. */
export function extractSessionId(stdout = "") {
  let sessionId = null;
  for (const line of String(stdout ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^session_id:\s*(.+)$/);
    if (match) {
      sessionId = match[1].trim();
    }
  }
  return sessionId;
}

/** Remove Hermes session_id trailer lines. */
export function stripSessionIdTrailer(stdout = "") {
  const lines = String(stdout ?? "").replace(/\r\n/g, "\n").split("\n");
  return lines.filter((line) => !/^session_id:\s*(.+)$/.test(line)).join("\n");
}

/** Detect Hermes's own failure sentinel, not arbitrary model prose. */
export function isHermesFailureOutput(outputText = "") {
  return /^(?:\u26A0\uFE0F?|No reply: the model returned empty content|API call failed after [0-9]+ retries)/imu.test(
    String(outputText ?? "").trim(),
  );
}

/** Parse quiet Hermes output into the shared companion shape. */
export function parseOutput(stdout = "", stderr = "") {
  const cleanStdout = stripTerminalNoise(stripSessionIdTrailer(stdout));
  const cleanStderr = stripTerminalNoise(stripSessionIdTrailer(stderr));
  const cleanOutput = stripTerminalNoise([stdout, stderr].filter(Boolean).join("\n"));
  const sessionId = extractSessionId(cleanOutput);
  const body = stripTerminalNoise(stripSessionIdTrailer(cleanOutput));

  if (!cleanStdout) {
    return {
      ok: false,
      rawOutput: body,
      stderr: cleanStderr,
      sessionId,
      errorMessage: cleanStderr || "Hermes produced no stdout.",
    };
  }

  if (isHermesFailureOutput(body)) {
    return {
      ok: false,
      rawOutput: body,
      stderr: cleanStderr,
      sessionId,
      errorMessage: body,
    };
  }

  return {
    ok: true,
    rawOutput: body,
    stderr: cleanStderr,
    sessionId,
    errorMessage: null,
  };
}

/** Detect local Hermes auth without spending model tokens. */
export function detectAuth(options = {}) {
  const authFile = options.authFile ?? AUTH_FILE;
  if (fs.existsSync(authFile)) {
    return {
      ok: false,
      message: "auth file present but not verified",
      status: "unverified",
      authFile,
      exitCode: null,
    };
  }

  if (options.probe) {
    const spawnImpl = options.spawnImpl ?? childProcess.spawnSync;
    const cwd = options.cwd ?? process.cwd();
    const env = { ...process.env, ...(options.env ?? {}) };
    const timeoutMs = options.timeoutMs ?? Math.min(HERMES_TIMEOUT_MS, 30_000);
    const argv = buildArgv({
      prompt: `Output the literal token on a single line and nothing else: ${AUTH_PROBE_SENTINEL}`,
      mode: "ask",
    });
    const runResult = spawnImpl(HERMES_BIN, argv, {
      cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });

    if (runResult.error) {
      return { ok: false, message: runResult.error.message, exitCode: runResult.status ?? null };
    }

    if (runResult.status !== 0) {
      const parsedFailure = parseOutput(runResult.stdout ?? "", runResult.stderr ?? "");
      return {
        ok: false,
        message: parsedFailure.errorMessage ?? parsedFailure.stderr ?? `Hermes exited with code ${runResult.status}.`,
        exitCode: runResult.status,
      };
    }

    const parsed = parseOutput(runResult.stdout ?? "", runResult.stderr ?? "");
    if (!parsed.ok || !parsed.rawOutput.includes(AUTH_PROBE_SENTINEL)) {
      return { ok: false, message: parsed.errorMessage ?? "Hermes auth probe failed.", exitCode: runResult.status };
    }

    return {
      ok: true,
      message: "auth ok",
      exitCode: runResult.status,
      sessionId: parsed.sessionId ?? null,
    };
  }

  return {
    ok: false,
    message: `Hermes auth not found at ${authFile}. Run hermes auth.`,
    authFile,
    exitCode: null,
  };
}

export const hermesCliAdapter = createCliAdapter({
  buildArgv,
  spawn,
  parseOutput,
  detectAuth,
});
