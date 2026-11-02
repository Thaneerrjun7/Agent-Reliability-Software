/**
 * Reads KEY=VALUE lines from a .env file into process.env. No dependency and no Node flag
 * (`--env-file` needs a recent Node), so `npm run agent` starts on any Node that can run the agent.
 * A variable that is already set is never overridden: a grader's own environment always wins.
 * Values are never printed.
 */

import { existsSync, readFileSync } from "fs";

export function loadDotEnv(file = ".env"): void {
  if (!existsSync(file)) return; // no file is fine: the variables may already be in the environment
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]);
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
