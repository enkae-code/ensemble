import childProcess from "node:child_process";
import process from "node:process";
import { createCliAdapter } from "../../../shared/lib/cli-adapter.mjs";

export const CURSOR_AGENT_BIN = process.env.CURSOR_AGENT_BIN ?? "/home/brodey/.local/bin/cursor-agent";
export const CURSOR_AUTH_TIMEOUT_MS = 90_000;
export const AUTH_PROBE_SENTINEL = "ENSEMBLE_AUTH_OK_X41";
export const MODEL_PRESETS = Object.freeze({
  auto: "auto",
  premium: "gemini-3.1-pro",
  reasoning: "claude-opus-4-7-thinking-high",
  fast: "composer-2",
});

/** Strip shell integration control sequences from CLI output. */
export function stripTerminalNoise(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .trim();
}

/** Resolve a supported Cursor model preset to a concrete model id. */
export function resolveModelPreset(preset = "auto") {
  if (!Object.hasOwn(MODEL_PRESETS, preset)) {
    throw new Error(`Unsupported model preset: ${preset}`);
  }
  return MODEL_PRESETS[preset];
}

/** Build `cursor-agent` argv from generic task options. */
export function buildArgv(options = {}) {
  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const argv = ["-p", "--trust", "--output-format", options.outputFormat ?? "json"];

  if (options.readOnly) {
    argv.push("--mode", options.mode ?? "plan");
  } else if (options.mode) {
    argv.push("--mode", options.mode);
  }

  if (options.modelPreset) {
    argv.push("--model", resolveModelPreset(options.modelPreset));
  } else if (options.model) {
    argv.push("--model", options.model);
  }

  if (options.workspace) {
    argv.push("--workspace", options.workspace);
  }

  if (options.worktree) {
    argv.push("-w");
  }

  argv.push(prompt);
  return argv;
}

/** Spawn `cursor-agent` with the provided argv and environment. */
export function spawn(argv, env = process.env, cwd = process.cwd()) {
  return childProcess.spawn(CURSOR_AGENT_BIN, argv, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Parse headless Cursor output into a structured result. */
export function parseOutput(stdout = "", stderr = "") {
  const cleanStdout = stripTerminalNoise(stdout);
  const cleanStderr = stripTerminalNoise(stderr);
  const merged = [cleanStdout, cleanStderr].filter(Boolean).join("\n").trim();

  if (!cleanStdout) {
    return {
      ok: false,
      rawOutput: "",
      stderr: cleanStderr,
      errorMessage: cleanStderr || "Cursor Agent produced no stdout.",
    };
  }

  if (cleanStdout.startsWith("{")) {
    const payload = JSON.parse(cleanStdout);
    return {
      ok: payload.is_error !== true && payload.subtype !== "error",
      rawOutput: String(payload.result ?? "").trim(),
      stderr: cleanStderr,
      sessionId: payload.session_id ?? null,
      requestId: payload.request_id ?? null,
      durationMs: payload.duration_ms ?? null,
      usage: payload.usage ?? null,
      payload,
      errorMessage: payload.is_error ? String(payload.result ?? "Cursor Agent failed.") : null,
    };
  }

  return {
    ok: true,
    rawOutput: cleanStdout,
    stderr: cleanStderr,
    sessionId: null,
    requestId: null,
    durationMs: null,
    usage: null,
    payload: null,
    errorMessage: merged || null,
  };
}

/** Probe Cursor API-key auth with a bounded headless `PING` request. */
export function detectAuth(options = {}) {
  const spawnImpl = options.spawnImpl ?? childProcess.spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...(options.env ?? {}) };
  const timeoutMs = options.timeoutMs ?? CURSOR_AUTH_TIMEOUT_MS;
  const argv = buildArgv({
    prompt: `Output the literal token on a single line and nothing else: ${AUTH_PROBE_SENTINEL}`,
    readOnly: true,
    mode: "ask",
    outputFormat: "json",
    workspace: cwd,
    apiKey: env.CURSOR_API_KEY,
  });
  const runResult = spawnImpl(CURSOR_AGENT_BIN, argv, {
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
      message: parsedFailure.errorMessage ?? parsedFailure.stderr ?? `Cursor Agent exited with code ${runResult.status}.`,
      exitCode: runResult.status,
    };
  }

  const parsed = parseOutput(runResult.stdout ?? "", runResult.stderr ?? "");
  if (!parsed.ok) {
    return { ok: false, message: parsed.errorMessage ?? "Cursor Agent auth probe failed.", exitCode: runResult.status };
  }

  if (!parsed.rawOutput.includes(AUTH_PROBE_SENTINEL)) {
    return { ok: false, message: `Unexpected auth probe output: ${parsed.rawOutput || "(empty)"}`, exitCode: runResult.status };
  }

  return {
    ok: true,
    message: "auth ok",
    exitCode: runResult.status,
    sessionId: parsed.sessionId ?? null,
  };
}

export const cursorCliAdapter = createCliAdapter({
  buildArgv,
  spawn,
  parseOutput,
  detectAuth,
});
