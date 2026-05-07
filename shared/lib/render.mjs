function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderKeyValueLines(entries) {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `- ${label}: ${value}`);
}

function renderJobRow(job) {
  return `| ${job.id} | ${job.kind ?? "job"} | ${job.status} | ${job.phase ?? ""} | ${job.summary ?? job.title ?? ""} |`;
}

/** Render setup status and next steps into markdown. */
export function renderSetupReport(report) {
  const lines = ["# Setup", ...renderKeyValueLines([
    ["Workspace", report.cwd],
    ["Runtime", report.runtime],
  ])];
  if (Array.isArray(report.checks) && report.checks.length > 0) {
    lines.push("", "## Checks");
    lines.push(...report.checks.map((check) => `- ${check.label}: ${check.ok ? "ok" : "failed"}`));
  }
  if (Array.isArray(report.actionsTaken) && report.actionsTaken.length > 0) {
    lines.push("", "## Actions");
    lines.push(...report.actionsTaken.map((item) => `- ${item}`));
  }
  if (Array.isArray(report.nextSteps) && report.nextSteps.length > 0) {
    lines.push("", "## Next");
    lines.push(...report.nextSteps.map((item) => `- ${item}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Render a structured review result into markdown. */
export function renderReviewResult(parsedResult, meta = {}) {
  const lines = [`# ${meta.title ?? "Review"}`];
  if (parsedResult.summary) {
    lines.push("", parsedResult.summary);
  }
  if (Array.isArray(parsedResult.findings) && parsedResult.findings.length > 0) {
    lines.push("", "## Findings");
    lines.push(...parsedResult.findings.map((finding) => `- ${finding}`));
  }
  if (Array.isArray(parsedResult.next_steps) && parsedResult.next_steps.length > 0) {
    lines.push("", "## Next");
    lines.push(...parsedResult.next_steps.map((step) => `- ${step}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Render a plain-text review payload with target metadata. */
export function renderNativeReviewResult(result, meta = {}) {
  const lines = [
    `# ${meta.title ?? result.review ?? "Review"}`,
    "",
    `Target: ${result.target?.label ?? "unknown"}`,
    "",
    result.codex?.stdout ?? result.stdout ?? "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

/** Render a task result with optional reasoning and file list. */
export function renderTaskResult(parsedResult, meta = {}) {
  const lines = [`# ${meta.title ?? "Task Result"}`];
  if (parsedResult.rawOutput) {
    lines.push("", parsedResult.rawOutput);
  }
  if (Array.isArray(parsedResult.touchedFiles) && parsedResult.touchedFiles.length > 0) {
    lines.push("", "## Files");
    lines.push(...parsedResult.touchedFiles.map((filePath) => `- ${filePath}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Render a status snapshot for multiple jobs. */
export function renderStatusReport(report) {
  const lines = ["# Status"];
  if (report.sessionId) {
    lines.push("", `Session: ${report.sessionId}`);
  }
  const jobs = report.jobs ?? [];
  if (jobs.length === 0) {
    lines.push("", "No tracked jobs.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("", "| Job | Kind | Status | Phase | Summary |", "| --- | --- | --- | --- | --- |");
  lines.push(...jobs.map(renderJobRow));
  return `${lines.join("\n")}\n`;
}

/** Render one job snapshot with key fields and progress preview. */
export function renderJobStatusReport(job) {
  const lines = [`# Job ${job.id}`, ...renderKeyValueLines([
    ["Kind", job.kind],
    ["Status", job.status],
    ["Phase", job.phase],
    ["Summary", job.summary],
  ])];
  if (Array.isArray(job.progressPreview) && job.progressPreview.length > 0) {
    lines.push("", "## Progress");
    lines.push(...job.progressPreview.map((line) => `- ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Render stored job output, preferring pre-rendered content when present. */
export function renderStoredJobResult(job, storedJob) {
  if (storedJob?.rendered) {
    return storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
  }

  if (storedJob?.result != null) {
    return formatJson(storedJob.result);
  }

  return renderJobStatusReport(job);
}

/** Render a cancellation confirmation block. */
export function renderCancelReport(job) {
  return `Cancelled ${job.kind ?? "job"} ${job.id}.\n`;
}

/** Render a bounded tail from a list of log lines. */
export function renderLogTail(lines, maxLines = 10) {
  return `${lines.slice(-maxLines).join("\n")}\n`;
}

/** Render a value as pretty JSON text. */
export function renderJsonPretty(value) {
  return formatJson(value);
}
