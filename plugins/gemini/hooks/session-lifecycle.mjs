#!/usr/bin/env node
import process from "node:process";
import { handleSessionStart, handleSessionEnd, readHookInput } from "../../../shared/lib/hooks.mjs";

const SESSION_ENV_NAME = "GEMINI_EXTRA_ARMS_SESSION_ID";

const event = process.argv[2];
const input = readHookInput();

if (event === "SessionStart") {
  handleSessionStart(input, SESSION_ENV_NAME);
} else if (event === "SessionEnd") {
  handleSessionEnd(input, { sessionEnvName: SESSION_ENV_NAME });
} else {
  process.stderr.write(`Unknown lifecycle event: ${event}\n`);
  process.exitCode = 1;
}
