/**
 * Reads a trace.jsonl and prints one line per entry, then a summary.
 * Usage: npm run trace -- out/public_03-booking-happy-path/trace.jsonl
 */

import { readFileSync } from "fs";
import { pathToFileURL } from "url";

type Entry = { step?: number; action?: string; outcome?: string; latency_ms?: number; retry_count?: number; tokens?: number; detail?: string; request_id?: string };

export function formatTrace(text: string): string {
  const out: string[] = [];
  const total = { calls: 0, retries: 0, timeouts: 0, invalid: 0, tokens: 0 };
  for (const raw of text.split("\n").filter((l) => l.trim() !== "")) {
    let e: Entry;
    try {
      e = JSON.parse(raw);
      if (e === null || typeof e !== "object") throw new Error("not an entry");
    } catch {
      out.push("(unreadable line)");
      continue;
    }
    if (e.latency_ms !== undefined) total.calls += 1; // only lines that timed a real call
    if (e.outcome === "retry") total.retries += 1;
    if (e.outcome === "timeout") total.timeouts += 1;
    if (e.outcome === "invalid_output") total.invalid += 1;
    total.tokens += e.tokens ?? 0;
    out.push([
      `step ${String(e.step ?? "?").padStart(2)}`,
      (e.action ?? "?").padEnd(15),
      (e.outcome ?? "-").padEnd(14),
      e.latency_ms === undefined ? "      -" : `${e.latency_ms}ms`.padStart(7),
      `retry=${e.retry_count ?? 0}`,
      e.request_id ? `req=${String(e.request_id).slice(0, 8)}` : "",
      e.detail ?? "",
    ].filter((part) => part !== "").join("  "));
  }
  out.push("", `calls ${total.calls}, retries ${total.retries}, timeouts ${total.timeouts}, invalid_output ${total.invalid}, tokens ${total.tokens}`);
  return out.join("\n");
}

// Only run as a CLI: tests import this file and must not fire it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run trace -- out/<scenario>/trace.jsonl");
    process.exit(2);
  }
  try {
    console.log(formatTrace(readFileSync(file, "utf8")));
  } catch (err) {
    console.error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
