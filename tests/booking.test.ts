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
      "bookings#21": down, // the end-of-run check
    });
    expect(api.bookings).toHaveLength(0);
    expect(result.bookings).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "booking_unconfirmed")).toBe(true);
    expect(result.errors.some((e) => e.code === "booking_outcome_unknown")).toBe(true);
  });
});
