import childProcess from "node:child_process";
import process from "node:process";
import { createCliAdapter } from "../../../shared/lib/cli-adapter.mjs";

export const GEMINI_BIN = process.env.GEMINI_BIN ?? "/home/brodey/.nvm/versions/node/v24.14.1/bin/gemini";
export const GEMINI_AUTH_TIMEOUT_MS = 120_000;
export const MODEL_PRESETS = Object.freeze({
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite-preview",
  "pro-2.5": "gemini-2.5-pro",
  "flash-2.5": "gemini-2.5-flash",
  "flash-lite-2.5": "gemini-2.5-flash-lite",
});
export const RETRY_BACKOFFS_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 32_000]);

/** Strip terminal control sequences and warning noise from gemini output. */
export function stripTerminalNoise(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/^Warning: True color.*$/gm, "")
    .replace(/^Ripgrep is not available.*$/gm, "")
    .trim();
}

/** Resolve a supported Gemini model preset to a concrete model id. */
export function resolveModelPreset(preset = "pro") {
  if (!Object.hasOwn(MODEL_PRESETS, preset)) {
    const known = Object.keys(MODEL_PRESETS).map((k) => `'${k}'`).join(", ");
    throw new Error(`Unsupported model preset: ${preset}. Use one of: ${known}.`);
  }
  return MODEL_PRESETS[preset];
}

/** Detect a Google "Too Many Requests" / capacity error in CLI output. */
export function isRateLimited(stdout = "", stderr = "") {
  const merged = `${stdout}\n${stderr}`;
  return /Too Many Requests|status: 429|MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED/i.test(merged);
}

/** Build `gemini` argv from generic task options. */
export function buildArgv(options = {}) {
  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const argv = ["-p", prompt, "--yolo"];

  if (options.modelPreset) {
    argv.push("-m", resolveModelPreset(options.modelPreset));
  } else if (options.model) {
    argv.push("-m", options.model);
  } else {
    argv.push("-m", MODEL_PRESETS.pro);
  }

  if (options.debug) {
    argv.push("-d");
  }

  return argv;
}

/** Spawn `gemini` with the provided argv and environment. */
export function spawn(argv, env = process.env, cwd = process.cwd()) {
  return childProcess.spawn(GEMINI_BIN, argv, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Parse headless Gemini output into a structured result. */
export function parseOutput(stdout = "", stderr = "") {
  const cleanStdout = stripTerminalNoise(stdout);
  const cleanStderr = stripTerminalNoise(stderr);
  const merged = [cleanStdout, cleanStderr].filter(Boolean).join("\n").trim();
  const rateLimited = isRateLimited(stdout, stderr);

  if (!cleanStdout && !rateLimited) {
    return {
      ok: false,
      rawOutput: "",
      stderr: cleanStderr,
      rateLimited: false,
      errorMessage: cleanStderr || "Gemini produced no stdout.",
    };
  }

  if (rateLimited) {
    return {
      ok: false,
      rawOutput: cleanStdout,
      stderr: cleanStderr,
      rateLimited: true,
      errorMessage: "Rate limited (429) — Google capacity exhausted for this model.",
    };
  }

  return {
    ok: true,
    rawOutput: cleanStdout,
    stderr: cleanStderr,
    rateLimited: false,
    errorMessage: merged && cleanStderr && !cleanStdout ? cleanStderr : null,
  };
}

/** Sentinel string for auth probe — chosen to avoid ping/pong chat reflexes. */
export const AUTH_PROBE_SENTINEL = "ENSEMBLE_AUTH_OK_X41";

/** Probe Gemini auth with a bounded headless sentinel request on the cheaper flash model. */
export function detectAuth(options = {}) {
  const spawnImpl = options.spawnImpl ?? childProcess.spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...(options.env ?? {}) };
  const timeoutMs = options.timeoutMs ?? GEMINI_AUTH_TIMEOUT_MS;
  const argv = buildArgv({
    prompt: `Output the literal token on a single line and nothing else: ${AUTH_PROBE_SENTINEL}`,
    modelPreset: "flash",
  });
  const runResult = spawnImpl(GEMINI_BIN, argv, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });

  if (runResult.error) {
    return { ok: false, message: runResult.error.message, exitCode: runResult.status ?? null };
  }

  const parsed = parseOutput(runResult.stdout ?? "", runResult.stderr ?? "");
  if (parsed.rateLimited) {
    return { ok: false, message: parsed.errorMessage, exitCode: runResult.status, rateLimited: true };
  }

  if (runResult.status !== 0) {
    return {
      ok: false,
      message: parsed.errorMessage ?? `Gemini exited with code ${runResult.status}.`,
      exitCode: runResult.status,
    };
  }

  if (!parsed.rawOutput.includes(AUTH_PROBE_SENTINEL)) {
    return { ok: false, message: `Unexpected auth probe output: ${parsed.rawOutput || "(empty)"}`, exitCode: runResult.status };
  }

  return { ok: true, message: "auth ok", exitCode: runResult.status };
}

export const geminiCliAdapter = createCliAdapter({
  buildArgv,
  spawn,
  parseOutput,
  detectAuth,
});
