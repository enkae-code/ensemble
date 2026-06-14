#!/usr/bin/env node
// fallow-ignore-file unused-file
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { emitDecision, readHookInput, runStopReviewGate, resolveCompanionPath } from "../../../shared/lib/hooks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = resolveCompanionPath(__dirname, "hermes-companion.mjs");

const input = readHookInput();
const result = runStopReviewGate(input, COMPANION);

if (result.skipped) {
  process.exit(0);
}

if (result.ok) {
  emitDecision({ decision: "approve", reason: "Hermes review gate passed." });
  process.exit(0);
}

emitDecision({ decision: "block", reason: result.reason });
process.exit(2);
