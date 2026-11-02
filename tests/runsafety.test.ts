import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { TraceWriter, parseAndRun, runAgent, stoppedNowResult } from "../src/agent";
import { validateResult } from "../src/types";
import { BOOK, GOAL, SEARCH, makeFakeApi } from "./fakeApi";

const noSleep = async () => {};

beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_BASE_URL", "http://fake.test");
  vi.stubEnv("TRIP_AGENT_API_KEY", "tk_test");
});

describe("the trace is written as the run goes", () => {
  it("is on disk after each line, not only at the end", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-"));
    const file = path.join(dir, "t.jsonl");
    const t = new TraceWriter(file, "run-1");
    expect(existsSync(file)).toBe(true); // exists even before the first line
    t.write({ step: 1, action: "search_flights", outcome: "ok" });
    expect(readFileSync(file, "utf8")).toContain("search_flights"); // no close() needed
    t.write({ step: 2, action: "get_weather", outcome: "ok" });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("records the call arguments and the server's request id", async () => {
    const api = makeFakeApi({ planner: [SEARCH, { say: "done" }] });
    const lines: Array<Record<string, any>> = [];
    await runAgent({ goal: GOAL, seed: "t", autoConfirm: true, trace: (l) => lines.push(l) }, { fetchImpl: api.fetchImpl, sleep: noSleep });
    const search = lines.find((l) => l.action === "search_flights");
    expect(search?.args).toMatchObject({ origin: "Lisbon", dest: "Tokyo" });
    expect(search?.request_id).toMatch(/^req-\d+$/);
    expect(lines.find((l) => l.action === "llm.chat")?.request_id).toMatch(/^req-\d+$/);
  });
});

describe("step numbers are 1-based, as the docs describe", () => {
  it("numbers a planner call and the tool it triggers as the same step, starting at 1", async () => {
    const api = makeFakeApi({ planner: [SEARCH, { say: "done" }] });
    const lines: Array<Record<string, any>> = [];
    const progress = { steps: 0, cost: 0 };
    const result = await runAgent({ goal: GOAL, seed: "t", autoConfirm: true, trace: (l) => lines.push(l) }, { fetchImpl: api.fetchImpl, sleep: noSleep, progress });
    expect(lines[0]).toMatchObject({ action: "llm.chat", step: 1 });
    expect(lines.find((l) => l.action === "search_flights")?.step).toBe(1);
    expect(lines.every((l) => l.step >= 1)).toBe(true);
    expect(progress).toEqual({ steps: result.steps, cost: result.cost }); // what an emergency stop would report
  });

  it("points an error at the step that was in progress, not step 0", async () => {
    const down = { status: 503 } as const;
    const api = makeFakeApi({ planner: [SEARCH], overrides: { "chat#1": down, "chat#2": down, "chat#3": down, "chat#4": down } });
    const result = await runAgent({ goal: GOAL, seed: "t", autoConfirm: true, trace: () => {} }, { fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(result.errors.find((e) => e.code === "llm_unavailable")?.step).toBe(1);
    expect(result.errors.every((e) => (e.step ?? 1) >= 1)).toBe(true);
  });
});

describe("an immediate stop (Esc)", () => {
  it("reports real counts, claims no booking, and says nothing was checked", () => {
    const r = stoppedNowResult({ steps: 3, cost: 910 });
    expect(validateResult(r)).toEqual([]);
    expect(r).toMatchObject({ status: "partial", steps: 3, cost: 910, bookings: [] });
    expect(r.answer).toContain("NOT listed here");
    expect(r.errors[0].code).toBe("stopped_immediately");
  });
});

describe("a result always exists", () => {
  it("a crash outside the agent loop still gives a failed result that admits nothing is verified", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crash-"));
    const args = { goal: GOAL, seed: "t", autoConfirm: true, output: path.join(dir, "r.json"), trace: path.join(dir, "t.jsonl") };
    const result = await parseAndRun(args, { now: () => { throw new Error("boom"); } });
    expect(result.status).toBe("failed");
    expect(result.errors[0].code).toBe("internal_error");
    expect(result.answer).toContain("Nothing in this file is verified");
    expect(readFileSync(args.trace, "utf8")).toContain("run crashed");
  });
});

describe("Ctrl+C", () => {
  it("stops cleanly mid-booking, then the server check settles whether it went through", async () => {
    const api = makeFakeApi({ planner: [SEARCH, BOOK, { say: "done" }] });
    const stop = new AbortController();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await api.fetchImpl(input, init); // the server commits the booking...
      if (new URL(String(input)).pathname.endsWith("/book_flight")) {
        stop.abort(); // ...then the operator hits Ctrl+C before we hear back
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
      return res;
    }) as typeof fetch;
    const lines: Array<Record<string, any>> = [];
    const result = await runAgent(
      { goal: GOAL, seed: "t", autoConfirm: true, trace: (l) => lines.push(l) },
      { fetchImpl, sleep: noSleep, abort: stop.signal },
    );
    expect(result.status).toBe("partial");
    expect(result.errors.some((e) => e.code === "interrupted")).toBe(true);
    expect(api.count("book_flight")).toBe(1); // no retry after Ctrl+C
    expect(api.bookings).toHaveLength(1);
    expect(result.bookings).toHaveLength(1); // found by the end-of-run check
    expect(result.answer).toContain("confirmed on the server");
    expect(result.answer).toContain("Stopped:");
    expect(lines.some((l) => l.outcome === "cap" && String(l.detail).includes("operator"))).toBe(true);
  });
});
