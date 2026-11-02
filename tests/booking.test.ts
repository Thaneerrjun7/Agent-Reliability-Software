import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent";
import { BOOK, GOAL, SEARCH, makeFakeApi, type Override, type PlannerMove } from "./fakeApi";

const noSleep = async () => {};

async function run(planner: PlannerMove[], overrides: Record<string, Override> = {}) {
  const api = makeFakeApi({ planner, overrides });
  const result = await runAgent(
    { goal: GOAL, seed: "test", autoConfirm: true, trace: () => {} },
    { fetchImpl: api.fetchImpl, sleep: noSleep },
  );
  return { api, result };
}

const happy: PlannerMove[] = [SEARCH, BOOK, { say: "Booked FL-31A4 for Maria Silva." }];

beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_BASE_URL", "http://fake.test");
  vi.stubEnv("TRIP_AGENT_API_KEY", "tk_test");
});

describe("booking safety", () => {
  it("books once on the happy path", async () => {
    const { api, result } = await run(happy);
    expect(result.status).toBe("success");
    expect(api.bookings).toHaveLength(1);
    expect(result.bookings[0].idempotency_key).toBe(api.bookings[0].idempotency_key);
  });

  it("does not book twice when the booking commits and then times out", async () => {
    const { api, result } = await run(happy, { "book_flight#1": { commitThenTimeout: true } });
    expect(api.bookings).toHaveLength(1);
    expect(api.count("book_flight")).toBe(1); // reconciled via /bookings, no second POST
    expect(result.status).toBe("success");
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].idempotency_key).toBe(api.bookings[0].idempotency_key);
  });

  it("retries a booking that timed out without committing, with the same key", async () => {
    const { api, result } = await run(happy, { "book_flight#1": "timeout" });
    const keys = api.calls.filter((c) => c.endpoint === "book_flight").map((c) => c.body.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(api.bookings).toHaveLength(1);
    expect(result.status).toBe("success");
  });

  it("reuses one key across 503 retries", async () => {
    const { api, result } = await run(happy, {
      "book_flight#1": { status: 503 },
      "book_flight#2": { status: 503 },
    });
    const keys = api.calls.filter((c) => c.endpoint === "book_flight").map((c) => c.body.idempotency_key);
    expect(new Set(keys).size).toBe(1);
    expect(api.bookings).toHaveLength(1);
    expect(result.status).toBe("success");
  });

  it("does not retry a 422 on the booking call", async () => {
    const { api, result } = await run(happy, { "book_flight#1": { status: 422 } });
    expect(api.count("book_flight")).toBe(1);
    expect(api.bookings).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "http_422")).toBe(true);
  });

  it("never books a flight that was not in our own search results", async () => {
    const injected = { call: "book_flight", args: { flight_id: "FL-EVIL", passenger: "Maria Silva" } };
    const { api, result } = await run([SEARCH, injected]);
    expect(api.count("book_flight")).toBe(0);
    expect(api.bookings).toHaveLength(0);
    expect(result.status).toBe("partial");
    expect(result.errors.some((e) => e.code === "unverified_flight")).toBe(true);
  });

  it("stops the whole run on a revoked key without retrying", async () => {
    const { api, result } = await run(happy, { "book_flight#1": { status: 403 } });
    expect(api.count("book_flight")).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "auth_failed")).toBe(true);
  });

  it("says the outcome is unknown when it cannot check the server", async () => {
    const down = { status: 503 } as const;
    const { api, result } = await run(happy, {
      "book_flight#1": "timeout",
      "book_flight#2": "timeout",
      "book_flight#3": "timeout",
      "book_flight#4": "timeout",
      "bookings#1": down, "bookings#2": down, "bookings#3": down, "bookings#4": down,
      "bookings#5": down, "bookings#6": down, "bookings#7": down, "bookings#8": down,
      "bookings#9": down, "bookings#10": down, "bookings#11": down, "bookings#12": down,
      "bookings#13": down, "bookings#14": down, "bookings#15": down, "bookings#16": down,
      "bookings#17": down, "bookings#18": down, "bookings#19": down, "bookings#20": down,
      "bookings#21": down, "bookings#22": down, // both end-of-run attempts
    });
    expect(api.bookings).toHaveLength(0);
    expect(result.bookings).toHaveLength(0);
    expect(result.status).toBe("partial");
    expect(result.errors.some((e) => e.code === "booking_unconfirmed")).toBe(true);
    expect(result.errors.some((e) => e.code === "final_check_unavailable")).toBe(true);
    // The answer must say "unknown" and must not repeat the planner's "Booked ..." claim.
    expect(result.answer).toContain("UNKNOWN");
    expect(result.answer).not.toContain("Booked FL-31A4 for Maria Silva.");
  });

  it("finds a booking at the end of the run that it could not confirm during the run", async () => {
    const down = { status: 503 } as const;
    const overrides: Record<string, Override> = {};
    for (let i = 1; i <= 4; i++) overrides[`book_flight#${i}`] = { commitThenTimeout: true };
    for (let i = 1; i <= 20; i++) overrides[`bookings#${i}`] = down; // every in-run check fails
    const { api, result } = await run(happy, overrides); // bookings#21 (end of run) works
    expect(api.bookings).toHaveLength(1);
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].idempotency_key).toBe(api.bookings[0].idempotency_key);
    expect(result.status).toBe("success");
    expect(result.answer).toContain("confirmed on the server");
    // The planner was told "unconfirmed" and then said "Booked ...": its text is never used.
    expect(result.answer).not.toContain("Planner summary");
  });
});

describe("one booking per run, whatever the goal wording", () => {
  const twoRuns: PlannerMove[] = [SEARCH, BOOK, { say: "done" }, SEARCH, BOOK, { say: "done" }];

  it("rewording the goal with the same seed replays the same booking instead of making a second", async () => {
    const api = makeFakeApi({ planner: twoRuns });
    const deps = { fetchImpl: api.fetchImpl, sleep: noSleep };
    const first = await runAgent({ goal: GOAL, seed: "pub3", autoConfirm: true, trace: () => {} }, deps);
    const second = await runAgent({ goal: GOAL + " Thanks!", seed: "pub3", autoConfirm: true, trace: () => {} }, deps);
    expect(api.bookings).toHaveLength(1);
    expect(second.bookings[0].idempotency_key).toBe(first.bookings[0].idempotency_key);
    expect(second.status).toBe("success");
  });

  it("a different seed is a separate booking", async () => {
    const api = makeFakeApi({ planner: twoRuns });
    const deps = { fetchImpl: api.fetchImpl, sleep: noSleep };
    await runAgent({ goal: GOAL, seed: "pub3", autoConfirm: true, trace: () => {} }, deps);
    await runAgent({ goal: GOAL, seed: "storm503", autoConfirm: true, trace: () => {} }, deps);
    expect(api.bookings).toHaveLength(2);
    expect(new Set(api.bookings.map((b) => b.idempotency_key)).size).toBe(2);
  });
});

describe("the final answer only states what the server confirms", () => {
  it("drops a planner claim of a booking that never happened", async () => {
    const { api, result } = await run([SEARCH, { say: "Booked FL-31A4 for Maria Silva." }]);
    expect(api.count("book_flight")).toBe(0);
    expect(result.bookings).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "unsupported_planner_claim")).toBe(true);
    expect(result.answer).not.toContain("Booked FL-31A4 for Maria Silva.");
  });

  it("removes a booking from the result when the server does not hold it", async () => {
    const { result } = await run(happy, { "bookings#1": { status: 200, body: { bookings: [] } } });
    expect(result.bookings).toHaveLength(0);
    expect(result.status).not.toBe("success");
    expect(result.errors.some((e) => e.code === "booking_claim_not_on_server")).toBe(true);
    expect(result.answer).toContain("NOT booked");
  });

  it("checks the server at the end even when nothing was booked", async () => {
    const { api, result } = await run([SEARCH, { say: "Found flights." }]);
    expect(api.count("bookings")).toBe(1);
    expect(result.answer).toContain("made no bookings");
  });

  it("tells the planner why it is being asked again", async () => {
    const sent: string[] = [];
    const api = makeFakeApi({ planner: [{ call: "fly_to_moon", args: {} }, SEARCH, { say: "Found flights." }] });
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/chat")) sent.push(String(init?.body));
      return api.fetchImpl(input, init);
    }) as typeof fetch;
    await runAgent({ goal: GOAL, seed: "test", autoConfirm: true, trace: () => {} }, { fetchImpl: spy, sleep: noSleep });
    const reask = sent.find((body) => body.includes("re-ask 1 of 3"));
    expect(reask).toContain("unknown tool");
    expect(reask).toContain("Valid tools");
  });
});
