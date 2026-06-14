#!/usr/bin/env node
// fallow-ignore-file unused-file, complexity
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../../shared/lib/args.mjs";
import { safeReadFile, writeJsonFile } from "../../../shared/lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../../../shared/lib/git.mjs";
import { terminateProcessTree } from "../../../shared/lib/process.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
} from "../../../shared/lib/render.mjs";
import { readJob, startJob, markJobCancelled } from "../../../shared/lib/job-control.mjs";
import {
  createJobLogFile,
  createJobRecord,
  nowIso,
  appendLogLine,
  runTrackedJob,
} from "../../../shared/lib/tracked-jobs.mjs";
import {
  ensureStateDir,
  listJobs,
  readJobFile,
  resolveJobFile,
} from "../../../shared/lib/state.mjs";
import { ensureAbsolutePath } from "../../../shared/lib/fs.mjs";
import { findAgentsFile, resolveWorkspaceRoot } from "../../../shared/lib/workspace.mjs";
import {
  AUTH_FILE,
  HERMES_BIN,
  HERMES_TIMEOUT_MS,
  hermesCliAdapter,
  detectAuth,
  parseModelOverride,
  resolveHermesTarget,
} from "./cli-adapter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_DIR = path.resolve(__dirname, "../prompts");
const SETUP_STATUS_FILE = "setup-status.json";
const DEFAULT_PLUGIN_DATA_DIR = path.join(os.homedir(), ".claude", "plugins", "data", "ensemble-hermes");

/** Print usage help for the companion entrypoint. */
export function printUsage() {
  process.stdout.write(
    "Usage: hermes-companion.mjs <task|ask|status|result|cancel|review|adversarial-review|setup> [options]\n",
  );
}

/** Set the Hermes plugin data root expected by the shared state helpers. */
export function ensureHermesPluginDataEnv(env = process.env) {
  env.CLAUDE_PLUGIN_DATA = DEFAULT_PLUGIN_DATA_DIR;
  return env.CLAUDE_PLUGIN_DATA;
}

/** Resolve a command cwd from parsed options and the current process cwd. */
export function resolveCommandCwd(options = {}) {
  return path.resolve(options.cwd ? ensureAbsolutePath(process.cwd(), options.cwd) : process.cwd());
}

/** Read the nearest AGENTS.md and prepend it to the outgoing prompt.
 *  Trust boundary: AGENTS.md is treated as instructions to the downstream CLI.
 *  Disable via `--no-agents`, `options.noAgents`, or `ENSEMBLE_NO_AGENTS=1` when
 *  running against an untrusted workspace. */
export function injectAgentsContext(cwd, prompt, options = {}) {
  const disabled = options.noAgents === true || process.env.ENSEMBLE_NO_AGENTS === "1";
  if (disabled) {
    return String(prompt ?? "").trim();
  }

  const agentsFile = findAgentsFile(cwd);
  if (!agentsFile) {
    return String(prompt ?? "").trim();
  }

  const content = safeReadFile(agentsFile)?.trim();
  if (!content) {
    return String(prompt ?? "").trim();
  }

  return [
    `<agents_md path="${agentsFile}">`,
    content,
    "</agents_md>",
    "",
    String(prompt ?? "").trim(),
  ].join("\n");
}

/** Create one summary line from raw prompt text. */
export function summarizePrompt(prompt, fallback = "Hermes task") {
  const firstLine = String(prompt ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return fallback;
  }
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

/** Load the stored adversarial review prompt template. */
export function loadAdversarialPromptTemplate() {
  const templatePath = path.join(PROMPTS_DIR, "adversarial-review.md");
  const template = safeReadFile(templatePath);
  if (!template) {
    throw new Error(`Missing prompt template: ${templatePath}`);
  }
  return template;
}

/** Fill the adversarial review prompt template with concrete values. */
export function buildAdversarialReviewPrompt(context) {
  const template = loadAdversarialPromptTemplate();
  return template
    .replaceAll("{{TARGET_LABEL}}", context.target.label)
    .replaceAll("{{USER_FOCUS}}", context.focusText || "Challenge the current direction.")
    .replaceAll("{{REVIEW_INPUT}}", context.reviewInput)
    .replaceAll("{{REVIEW_COLLECTION_GUIDANCE}}", context.collectionGuidance || "Inspect the diff and cited files directly before finalizing.");
}

/** Build a plain diff review prompt for Hermes Agent. */
export function buildReviewPrompt(context) {
  return [
    "You are reviewing local git changes in read-only mode.",
    `Target: ${context.target.label}`,
    "Return a terse review with:",
    "1. Verdict",
    "2. Findings ordered by severity",
    "3. Next steps",
    "",
    "Rules:",
    "- Do not modify files.",
    "- Ground every finding in the provided diff context or repository inspection.",
    "- If there are no material issues, say that directly.",
    "",
    "<review_context>",
    context.reviewInput,
    "</review_context>",
  ].join("\n");
}

/** Convert git review context into prompt input text. */
export function formatReviewInput(context) {
  const blocks = [context.summary];
  if (context.diff) {
    blocks.push(`<diff>\n${context.diff}\n</diff>`);
  }
  if (Array.isArray(context.changedPaths) && context.changedPaths.length > 0) {
    blocks.push(`Changed paths:\n${context.changedPaths.map((item) => `- ${item}`).join("\n")}`);
  }
  if (Array.isArray(context.untracked) && context.untracked.length > 0) {
    blocks.push(
      context.untracked.map((entry) => `<untracked path="${entry.path}">\n${entry.content}\n</untracked>`).join("\n\n"),
    );
  }
  return blocks.join("\n\n");
}

/** Resolve one job from an id or unique prefix. */
export function resolveJobByReference(cwd, reference) {
  const jobs = listJobs(cwd);
  if (!reference) {
    return jobs[0] ?? null;
  }

  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Job reference is ambiguous: ${reference}`);
  }
  return null;
}

/** Resolve the latest finished job when no explicit reference was supplied. */
export function resolveLatestFinishedJob(cwd) {
  return listJobs(cwd).find((job) => ["completed", "failed", "cancelled"].includes(job.status)) ?? null;
}

/** Read the stored per-job payload or fall back to the state index row. */
export function loadStoredJob(cwd, jobId) {
  return readJobFile(resolveJobFile(cwd, jobId)) ?? readJob(cwd, jobId);
}

/** Render Hermes output with captured session metadata. */
export function renderHermesResult(parsedResult, meta = {}) {
  const lines = [`# ${meta.title ?? "Hermes Result"}`];
  if (parsedResult.sessionId) {
    lines.push("", `Session: ${parsedResult.sessionId}`);
  }
  if (parsedResult.rawOutput) {
    lines.push("", parsedResult.rawOutput);
  }
  return `${lines.join("\n")}\n`;
}

/** Create the base job record for a Hermes task dispatch. */
export function createTaskJob({ cwd, prompt, provider, model, skills, worktree, noAgents }) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const baseJob = createJobRecord({
    kind: "task",
    kindLabel: "Hermes task",
    title: "Hermes task",
    workspaceRoot,
    summary: summarizePrompt(prompt),
    request: { prompt, provider, model, skills, worktree: Boolean(worktree), noAgents: Boolean(noAgents), cwd },
    write: true,
    jobClass: "hermes",
  }, { prefix: "hermes" });

  baseJob.logFile = createJobLogFile(workspaceRoot, baseJob.id, `Starting ${baseJob.kindLabel}.`);
  return startJob(workspaceRoot, baseJob);
}

/** Collect stdout and stderr from a spawned child process. */
export function collectChildOutput(child, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs) : null;
    timeout?.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

/** Execute one Hermes CLI request and return the parsed output. */
export async function runHermesInvocation({ cwd, prompt, mode = "dispatch", provider, model, skills, noAgents = false }) {
  const resolvedPrompt = injectAgentsContext(cwd, prompt, { noAgents });
  const target = resolveHermesTarget({ mode, provider, model });
  const attempts = [{ provider: target.provider, model: target.model }];
  if (mode === "review" && !provider && !model && target.fallbackProvider && target.fallbackModel) {
    attempts.push({ provider: target.fallbackProvider, model: target.fallbackModel });
  }

  const errors = [];
  for (const attempt of attempts) {
    const argv = hermesCliAdapter.buildArgv({
      prompt: resolvedPrompt,
      mode,
      provider: attempt.provider,
      model: attempt.model,
      skills,
    });
    const child = hermesCliAdapter.spawn(argv, process.env, cwd);
    const outcome = await collectChildOutput(child, HERMES_TIMEOUT_MS);
    const parsed = hermesCliAdapter.parseOutput(outcome.stdout, outcome.stderr);

    if (outcome.exitCode === 0 && parsed.ok) {
      return parsed;
    }

    errors.push(
      outcome.timedOut
        ? `Hermes call timed out after ${HERMES_TIMEOUT_MS}ms.`
        : (parsed.errorMessage ?? parsed.stderr ?? `Hermes Agent exited with code ${outcome.exitCode ?? "unknown"}.`),
    );
  }

  throw new Error(errors.at(-1) ?? "Hermes Agent failed.");
}

/** Run a stored task job to completion and persist result metadata. */
export async function executeTaskJob(job, options = {}) {
  return runTrackedJob(job, async ({ reportProgress, updateProgress }) => {
    reportProgress({ message: "Dispatching Hermes task.", phase: "running" });
    const parsed = await runHermesInvocation({
      cwd: options.cwd ?? job.request.cwd ?? job.workspaceRoot,
      prompt: job.request.prompt,
      mode: "dispatch",
      provider: job.request.provider,
      model: job.request.model,
      skills: job.request.skills,
      noAgents: job.request.noAgents ?? false,
    });
    updateProgress({
      phase: "finalizing",
      summary: summarizePrompt(parsed.rawOutput, job.summary),
      sessionId: parsed.sessionId ?? null,
    });
    const rendered = renderHermesResult(parsed, { title: "Hermes Task Result" });
    return {
      result: parsed,
      rendered,
    };
  }, { stderr: false });
}

/** Start a detached background worker for an existing queued task job. */
export function launchDetachedTaskWorker(cwd, jobId) {
  const child = childProcess.spawn(process.execPath, [__filename, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

/** Write a setup status snapshot for the current workspace. */
export function writeSetupStatus(cwd, report) {
  const stateDir = ensureStateDir(cwd);
  const setupPath = path.join(stateDir, SETUP_STATUS_FILE);
  writeJsonFile(setupPath, report);
  return setupPath;
}

/** Check whether the configured Hermes binary can be spawned. */
export function detectHermesBinary(cwd = process.cwd()) {
  const probe = childProcess.spawnSync(HERMES_BIN, ["--help"], {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });

  if (probe.error) {
    return {
      ok: false,
      message: probe.error.message,
      exitCode: probe.status ?? null,
    };
  }

  return {
    ok: true,
    message: "binary found",
    exitCode: probe.status,
  };
}

/** Build the setup report for the current workspace. */
export function buildSetupReport(cwd) {
  const auth = detectAuth({ cwd, env: process.env });
  const binary = detectHermesBinary(cwd);
  const checks = [
    { label: "node", ok: true },
    { label: "hermes-bin", ok: binary.ok },
    { label: "hermes-auth-file", ok: fs.existsSync(AUTH_FILE) },
    { label: "auth", ok: auth.ok },
  ];
  const nextSteps = [];
  if (!checks[1].ok) {
    nextSteps.push(`Install Hermes or set HERMES_BIN. Current value: ${HERMES_BIN}.`);
  }
  if (!auth.ok) {
    nextSteps.push("Run hermes auth, then rerun /hermes:setup.");
  }
  if (auth.ok) {
    nextSteps.push("Use /hermes:rescue to dispatch work.");
  }

  return {
    cwd,
    runtime: HERMES_BIN,
    checkedAt: nowIso(),
    checks,
    auth: { ...auth, binary },
    nextSteps,
  };
}

/** Handle the public `task` subcommand. */
export async function handleTask(argv) {
  const parsed = parseArgs(argv, {
    boolean: ["background", "worktree", "no-agents"],
    string: ["model", "cwd", "skills"],
    alias: { C: "cwd" },
  });
  const prompt = parsed._.join(" ").trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const cwd = resolveCommandCwd(parsed);
  const target = parseModelOverride(parsed.model);
  const job = createTaskJob({
    cwd,
    prompt,
    provider: target.provider,
    model: target.model,
    skills: parsed.skills,
    worktree: parsed.worktree,
    noAgents: parsed["no-agents"] === true,
  });

  if (parsed.background) {
    const pid = launchDetachedTaskWorker(cwd, job.id);
    startJob(job.workspaceRoot, { ...loadStoredJob(job.workspaceRoot, job.id), pid, phase: "starting", status: "running" });
    process.stdout.write([`started ${job.id}`, `pid ${pid}`, `status /hermes:status ${job.id}`].join("\n") + "\n");
    return;
  }

  const finished = await executeTaskJob({ ...job, pid: process.pid }, { cwd });
  const storedJob = loadStoredJob(job.workspaceRoot, job.id);
  process.stdout.write(renderStoredJobResult(finished, storedJob));
}

/** Handle the internal detached task worker subcommand. */
export async function handleTaskWorker(argv) {
  const parsed = parseArgs(argv, { string: ["job-id", "cwd"], alias: { C: "cwd" } });
  if (!parsed["job-id"]) {
    throw new Error("Missing --job-id.");
  }

  const cwd = resolveCommandCwd(parsed);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = loadStoredJob(workspaceRoot, parsed["job-id"]);
  if (!storedJob) {
    throw new Error(`Unknown job: ${parsed["job-id"]}`);
  }

  appendLogLine(storedJob.logFile, `Worker pid ${process.pid} attached.`);
  startJob(workspaceRoot, { ...storedJob, pid: process.pid, status: "running", phase: "starting" });
  await executeTaskJob({ ...storedJob, pid: process.pid }, { cwd });
}

/** Handle the `status` subcommand. */
export function handleStatus(argv) {
  const parsed = parseArgs(argv, { string: ["cwd"], alias: { C: "cwd" } });
  const cwd = resolveCommandCwd(parsed);
  const reference = parsed._[0];
  const job = resolveJobByReference(cwd, reference);
  if (reference && !job) {
    throw new Error(`Unknown job: ${reference}`);
  }

  if (!job) {
    process.stdout.write(renderStatusReport({ jobs: listJobs(cwd) }));
    return;
  }

  const storedJob = loadStoredJob(resolveWorkspaceRoot(cwd), job.id) ?? job;
  const progressPreview = safeReadFile(storedJob.logFile)?.trim().split("\n").slice(-8) ?? [];
  process.stdout.write(renderJobStatusReport({ ...storedJob, progressPreview }));
}

/** Handle the `result` subcommand. */
export function handleResult(argv) {
  const parsed = parseArgs(argv, { string: ["cwd"], alias: { C: "cwd" } });
  const cwd = resolveCommandCwd(parsed);
  const job = parsed._[0] ? resolveJobByReference(cwd, parsed._[0]) : resolveLatestFinishedJob(cwd);
  if (!job) {
    throw new Error("No finished jobs found.");
  }

  const storedJob = loadStoredJob(resolveWorkspaceRoot(cwd), job.id) ?? job;
  process.stdout.write(renderStoredJobResult(job, storedJob));
}

/** Handle the `cancel` subcommand. */
export function handleCancel(argv) {
  const parsed = parseArgs(argv, { string: ["cwd"], alias: { C: "cwd" } });
  const cwd = resolveCommandCwd(parsed);
  const job = resolveJobByReference(cwd, parsed._[0]);
  if (!job) {
    throw new Error(`Unknown job: ${parsed._[0] ?? "(missing job id)"}`);
  }
  if (job.status !== "running") {
    throw new Error(`Job is not running: ${job.id}`);
  }

  const killed = terminateProcessTree(job.pid);
  const cancelled = markJobCancelled(resolveWorkspaceRoot(cwd), job.id, killed ? "Cancelled by user." : "Process already exited.");
  appendLogLine(cancelled.logFile, cancelled.errorMessage);
  process.stdout.write(renderCancelReport(cancelled));
}

/** Handle the direct `ask` subcommand. */
export async function handleAsk(argv) {
  const parsed = parseArgs(argv, {
    boolean: ["no-agents"],
    string: ["model", "cwd", "skills"],
    alias: { C: "cwd" },
  });
  const prompt = parsed._.join(" ").trim();
  if (!prompt) {
    throw new Error("Question is required.");
  }

  const cwd = resolveCommandCwd(parsed);
  const target = parseModelOverride(parsed.model);
  const parsedOutput = await runHermesInvocation({
    cwd,
    prompt,
    mode: "ask",
    provider: target.provider,
    model: target.model,
    skills: parsed.skills,
    noAgents: parsed["no-agents"] === true,
  });
  process.stdout.write(renderHermesResult(parsedOutput, { title: "Hermes Ask Result" }));
}

/** Run a review-style job and emit the rendered result. */
export async function handleReviewCommand(argv, mode) {
  const parsed = parseArgs(argv, { string: ["cwd", "model", "skills"], alias: { C: "cwd" } });
  const cwd = resolveCommandCwd(parsed);
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd);
  const reviewContext = collectReviewContext(cwd, target);
  const context = {
    target,
    reviewInput: formatReviewInput(reviewContext),
    focusText: mode === "adversarial-review" ? "Challenge the direction and assumptions." : "",
    collectionGuidance: reviewContext.guidance ?? "Read changed files directly when the diff summary is incomplete.",
  };
  const prompt = mode === "adversarial-review" ? buildAdversarialReviewPrompt(context) : buildReviewPrompt(context);
  const job = createJobRecord({
    kind: mode,
    kindLabel: mode === "adversarial-review" ? "Hermes adversarial review" : "Hermes review",
    title: mode === "adversarial-review" ? "Hermes adversarial review" : "Hermes review",
    workspaceRoot: resolveWorkspaceRoot(cwd),
    summary: target.label,
    request: { prompt, cwd, ...parseModelOverride(parsed.model), skills: parsed.skills },
    write: false,
    jobClass: "hermes-review",
  }, { prefix: "hermes" });
  job.logFile = createJobLogFile(job.workspaceRoot, job.id, `Starting ${job.kindLabel}.`);
  const trackedJob = startJob(job.workspaceRoot, job);
  const finished = await runTrackedJob(trackedJob, async ({ reportProgress, updateProgress }) => {
    reportProgress({ message: "Dispatching review in read-only mode.", phase: "reviewing" });
    const parsedOutput = await runHermesInvocation({
      cwd,
      prompt,
      mode: "review",
      provider: job.request.provider,
      model: job.request.model,
      skills: job.request.skills,
    });
    updateProgress({ summary: summarizePrompt(parsedOutput.rawOutput, target.label), sessionId: parsedOutput.sessionId ?? null });
    return {
      result: parsedOutput,
      rendered: renderHermesResult(parsedOutput, { title: trackedJob.title }),
    };
  });
  const storedJob = loadStoredJob(job.workspaceRoot, finished.id);
  process.stdout.write(renderStoredJobResult(finished, storedJob));
}

/** Handle the `setup` subcommand. */
export function handleSetup(argv) {
  const parsed = parseArgs(argv, { string: ["cwd"], alias: { C: "cwd" } });
  const cwd = resolveCommandCwd(parsed);
  const report = buildSetupReport(cwd);
  const setupPath = writeSetupStatus(cwd, report);
  const output = renderSetupReport({
    ...report,
    checks: report.checks,
    nextSteps: [...report.nextSteps, `Setup status file: ${setupPath}`],
    actionsTaken: [report.auth.ok ? "auth ok" : `auth failed: ${report.auth.message}`],
  });
  process.stdout.write(output);
}

/** Dispatch a parsed subcommand. */
export async function main(argv = process.argv.slice(2)) {
  ensureHermesPluginDataEnv(process.env);
  const [command, ...rest] = argv;
  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === "task") {
    await handleTask(rest);
    return;
  }
  if (command === "ask") {
    await handleAsk(rest);
    return;
  }
  if (command === "task-worker") {
    await handleTaskWorker(rest);
    return;
  }
  if (command === "status") {
    handleStatus(rest);
    return;
  }
  if (command === "result") {
    handleResult(rest);
    return;
  }
  if (command === "cancel") {
    handleCancel(rest);
    return;
  }
  if (command === "review" || command === "adversarial-review") {
    await handleReviewCommand(rest, command);
    return;
  }
  if (command === "setup") {
    handleSetup(rest);
    return;
  }

  throw new Error(`Unknown subcommand: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
