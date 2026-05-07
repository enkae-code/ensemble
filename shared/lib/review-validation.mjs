import fs from "node:fs";

/** Read a JSON Schema file and return the parsed object. */
export function loadSchema(schemaPath) {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

/** Minimal JSON Schema check sufficient for review-output.schema.json. */
export function validateReviewOutput(value, schema) {
  const errors = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("review output must be a JSON object");
    return { ok: false, errors };
  }
  for (const required of schema.required ?? []) {
    if (!(required in value)) {
      errors.push(`missing required field: ${required}`);
    }
  }
  if ("verdict" in value && !schema.properties.verdict.enum.includes(value.verdict)) {
    errors.push(`verdict must be one of ${schema.properties.verdict.enum.join("|")}`);
  }
  if ("summary" in value && (typeof value.summary !== "string" || value.summary.length === 0)) {
    errors.push("summary must be a non-empty string");
  }
  if ("findings" in value) {
    if (!Array.isArray(value.findings)) {
      errors.push("findings must be an array");
    } else {
      const itemSchema = schema.properties.findings.items;
      const allowedSeverities = itemSchema.properties.severity.enum;
      value.findings.forEach((finding, index) => {
        for (const required of itemSchema.required) {
          if (!(required in finding)) {
            errors.push(`findings[${index}] missing field: ${required}`);
          }
        }
        if ("severity" in finding && !allowedSeverities.includes(finding.severity)) {
          errors.push(`findings[${index}].severity invalid: ${finding.severity}`);
        }
        if ("confidence" in finding && (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1)) {
          errors.push(`findings[${index}].confidence must be 0..1`);
        }
        if ("line_start" in finding && (!Number.isInteger(finding.line_start) || finding.line_start < 1)) {
          errors.push(`findings[${index}].line_start must be integer >= 1`);
        }
      });
    }
  }
  if ("next_steps" in value && !Array.isArray(value.next_steps)) {
    errors.push("next_steps must be an array");
  }
  return { ok: errors.length === 0, errors };
}

/** Try to extract a JSON object from a free-text review output (model may wrap in prose or fences). */
export function extractJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* fall through */ }
  }
  return null;
}
