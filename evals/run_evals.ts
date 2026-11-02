/**
 * Public eval runner: executes evals/public/*.json against YOUR agent using
 * the README command contract, and prints a pass/fail table.
 *
 * Requires TRIP_AGENT_BASE_URL and TRIP_AGENT_API_KEY in the environment.
 * Booking counts are checked via the server (GET /tools/bookings) before and
 * after each scenario. A booking scenario that ends at delta 0 still passes
 * when result.json claims only bookings the server already held before the
 * run (same idempotency key, flight, passenger) — a correct idempotent
 * replay of an earlier run, not a missed booking.
 */

import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";

type Expectations = {
  status: string[];
  bookings_delta: { min: number; max: number };
  min_answer_chars?: number;
  forbidden_flights?: string[];
};

type ServerBooking = { flight_id: string; passenger: string; idempotency_key: string };
type ClaimedBooking = Partial<ServerBooking>;

type Scenario = { id: string; goal: string; seed: string; expect: Expectations };

const BASE_URL = process.env.TRIP_AGENT_BASE_URL ?? "http://localhost:4242";
const API_KEY = process.env.TRIP_AGENT_API_KEY;
const SCENARIO_TIMEOUT_MS = 120_000;

if (!API_KEY) {
  console.error("Set TRIP_AGENT_API_KEY (and optionally TRIP_AGENT_BASE_URL) before running evals.");
  process.exit(2);
}

async function bookingsList(): Promise<ServerBooking[]> {
  const res = await fetch(`${BASE_URL}/api/mock/v1/tools/bookings`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    bookings?: ServerBooking[];
    error?: { code?: string; message?: string };
  };
  if (!body.bookings) {
    throw new Error(
      `bookings check failed (${res.status}${body.error ? ` ${body.error.code}: ${body.error.message}` : ""}) — ` +
        `check TRIP_AGENT_BASE_URL / TRIP_AGENT_API_KEY`,
    );
  }
  return body.bookings;
}

// delta 0 on a scenario that expects a booking is a correct outcome when the
// agent replays an idempotency key from an earlier run of the same scenario:
// the server returns the existing booking and the count does not grow. Accept
// it only with server-side proof — every booking claimed in result.json (same
// key, flight AND passenger) must already have been on the server before this
// run, so a hallucinated or fresh booking still fails.
function isVerifiedReplay(
  claimed: ClaimedBooking[],
  beforeList: ServerBooking[],
): boolean {
  return (
    claimed.length > 0 &&
    claimed.every((c) =>
      beforeList.some(
        (b) =>
          b.idempotency_key === c.idempotency_key &&
          b.flight_id === c.flight_id &&
          b.passenger === c.passenger,
      ),
    )
  );
}

async function runOne(scenario: Scenario): Promise<{
  pass: boolean;
  reasons: string[];
  notes: string[];
}> {
  const outDir = path.join("out", scenario.id.replace(/\//g, "_"));
  await fs.mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, "result.json");

  const beforeList = await bookingsList();
  const before = beforeList.length;

  const agent = spawnSync(
    "npm",
    [
      "run",
      "agent",
      "--",
      "--goal",
      scenario.goal,
      "--seed",
      scenario.seed,
      "--auto-confirm",
      "--output",
      resultPath,
      "--trace",
      path.join(outDir, "trace.jsonl"),
    ],
    { cwd: path.resolve(__dirname, ".."), timeout: SCENARIO_TIMEOUT_MS, encoding: "utf8" },
  );

  const reasons: string[] = [];
  const notes: string[] = [];
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    reasons.push(`no/invalid result.json (agent ${agent.status === null ? `timed out after ${SCENARIO_TIMEOUT_MS}ms` : `exited ${agent.status}`})`);
  }

  const afterList = await bookingsList();
  const delta = afterList.length - before;

  if (result) {
    const expect = scenario.expect;
    if (!expect.status.includes(result.status as string)) {
      reasons.push(`status ${result.status} not in [${expect.status.join(", ")}]`);
    }
    if (delta < expect.bookings_delta.min || delta > expect.bookings_delta.max) {
      const claimed = Array.isArray(result.bookings)
        ? (result.bookings as ClaimedBooking[])
        : [];
      if (delta === 0 && expect.bookings_delta.min >= 1 && isVerifiedReplay(claimed, beforeList)) {
        notes.push("idempotent replay — booking already on the server from an earlier run, not double-booked");
      } else {
        reasons.push(`bookings delta ${delta} outside [${expect.bookings_delta.min}, ${expect.bookings_delta.max}]`);
      }
    }
    for (const forbidden of expect.forbidden_flights ?? []) {
      if (afterList.some((b) => b.flight_id === forbidden)) {
        reasons.push(`booked a forbidden flight (${forbidden}) — never book flights that were not in your search results`);
      }
    }
    const answer = typeof result.answer === "string" ? result.answer : "";
    if (expect.min_answer_chars && answer.length < expect.min_answer_chars) {
      reasons.push(`answer too short (${answer.length} chars)`);
    }
  }

  return { pass: reasons.length === 0, reasons, notes };
}

async function main() {
  const dir = path.resolve(__dirname, "public");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const rows: Array<{ id: string; pass: boolean; reasons: string; notes: string }> = [];

  for (const file of files) {
    const scenario = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as Scenario;
    process.stdout.write(`running ${scenario.id} ... `);
    const { pass, reasons, notes } = await runOne(scenario);
    const suffix = notes.join("; ");
    console.log(pass ? `PASS${suffix ? ` (${suffix})` : ""}` : `FAIL (${reasons.join("; ")})`);
    rows.push({ id: scenario.id, pass, reasons: reasons.join("; "), notes: suffix });
  }

  console.log("\n================= PUBLIC EVALS =================");
  for (const r of rows) {
    const detail = r.pass ? (r.notes ? `  (${r.notes})` : "") : `  — ${r.reasons}`;
    console.log(`${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.id}${detail}`);
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`================================================\n${rows.length - failed}/${rows.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
