import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { CONFIG, parseAndRun, runAgent, writeJson } from "../src/agent";
import { FLIGHT, GOAL, SEARCH, makeFakeApi, type Override, type PlannerMove } from "./fakeApi";

const noSleep = async () => {};
const SEARCH_ONLY = "Find a flight from Lisbon to Tokyo on 2026-11-03.";
const WEATHER = { call: "get_weather", args: { city: "Tokyo", date: "2026-11-03" } };
const saved = { ...CONFIG };

async function run(opts: { planner: PlannerMove[]; overrides?: Record<string, Override>; searchResults?: unknown[]; goal?: string }) {
  const api = makeFakeApi({ planner: opts.planner, overrides: opts.overrides, searchResults: opts.searchResults });
  const chatBodies: string[] = [];
  const lines: Array<Record<string, any>> = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/llm/chat")) chatBodies.push(String(init?.body));
    return api.fetchImpl(input, init);
  }) as typeof fetch;
  const result = await runAgent(
    { goal: opts.goal ?? GOAL, seed: "t", autoConfirm: true, trace: (l) => lines.push(l) },
    { fetchImpl: spy, sleep: noSleep },
  );
  return { api, result, chatBodies, lines };
}

beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_BASE_URL", "http://fake.test");
  vi.stubEnv("TRIP_AGENT_API_KEY", "tk_test");
});
afterEach(() => Object.assign(CONFIG, saved));

describe("planner replies that are not usable moves", () => {
  it("re-asks when the reply has neither a tool call nor any text", async () => {
    const { result, lines } = await run({ planner: [{ say: "" }, SEARCH, { say: "done" }], goal: SEARCH_ONLY });
    expect(lines.some((l) => l.action === "llm.reask" && l.outcome === "invalid_output")).toBe(true);
    expect(result.status).toBe("success");
  });

  it("retries a 200 reply that is not a planner response, and says why in the trace", async () => {
    const unreadable = { status: 200, body: { error: { code: "bad_json", message: "response was not JSON" } } } as const;
    const { result, lines } = await run({ planner: [SEARCH, { say: "done" }], overrides: { "chat#1": unreadable }, goal: SEARCH_ONLY });
    expect(result.status).toBe("success");
    expect(lines.some((l) => l.action === "llm.chat" && l.outcome === "invalid_output" && String(l.detail).includes("not a valid planner response"))).toBe(true);
  });

  it("does not mistake a bug (a plain TypeError) for a network error and retry it", async () => {
    let chatCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("/llm/chat")) chatCalls += 1;
      throw new TypeError("boom");
    }) as unknown as typeof fetch;
    const result = await runAgent({ goal: GOAL, seed: "t", autoConfirm: true, trace: () => {} }, { fetchImpl, sleep: noSleep });
    expect(chatCalls).toBe(1); // one try, no retries
    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "internal_error")).toBe(true);
  });
});

describe("the chat API's size limits", () => {
  it("stops cleanly before the conversation passes the 50-message limit", async () => {
    CONFIG.maxMessages = 4; // stands in for 50 so the test stays small
    const { result, api } = await run({ planner: [SEARCH, WEATHER, { call: "get_weather", args: { city: "Oslo", date: "2026-11-03" } }] });
    expect(result.status).toBe("partial");
    expect(result.errors.some((e) => e.code === "message_limit_reached")).toBe(true);
    expect(api.count("chat")).toBe(2); // it did not send the over-long conversation
  });

  it("sends the planner only the 10 cheapest flights but still reports all of them", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...FLIGHT, flight_id: `FL-${i}X`, price_eur: 900 - i * 10 }));
    const { result, chatBodies } = await run({ planner: [SEARCH, { say: "done" }], searchResults: many });
    expect(chatBodies[1]).toContain("Showing the 10 cheapest of 12");
    expect(chatBodies[1]).not.toContain("FL-0X"); // the dearest two are not sent on
    expect(result.answer).toContain("Found 12 flight option(s)");
  });

  it("shortens a huge corrupt planner move before echoing it back", async () => {
    const huge = { call: "fly_to_moon", args: "x".repeat(20_000) };
    const { chatBodies } = await run({ planner: [huge, SEARCH, { say: "done" }] });
    expect(chatBodies[1].length).toBeLessThan(5_000);
  });
});

describe("status means the goal was met", () => {
  it("a weather-only goal that got its weather is a success", async () => {
    const { result } = await run({ planner: [{ call: "get_weather", args: { city: "Cairo", date: "2026-12-05" } }, { say: "done" }], goal: "What is the weather in Cairo on 2026-12-05?" });
    expect(result.status).toBe("success");
    expect(result.answer).toContain("Weather in Cairo");
  });

  it("a goal that asks for weather but never got it is not a success", async () => {
    const { result } = await run({ planner: [SEARCH, { say: "done" }], goal: "Find a flight from Lisbon to Tokyo on 2026-11-03 and tell me the weather in Tokyo." });
    expect(result.status).not.toBe("success");
  });
});

describe("output folders that do not exist yet", () => {
  it("creates them for the trace and for result.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nested-"));
    const args = { goal: GOAL, seed: "t", autoConfirm: true, output: path.join(dir, "a", "b", "r.json"), trace: path.join(dir, "c", "d", "t.jsonl") };
    await parseAndRun(args, { now: () => { throw new Error("stop early"); } });
    expect(existsSync(args.trace)).toBe(true);
    await writeJson(args.output, { ok: true });
    expect(existsSync(args.output)).toBe(true);
  });
});
