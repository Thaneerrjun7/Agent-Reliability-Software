import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, parseGoal, runAgent, cleanFlights, type CleanFlight } from "../src/agent";
import { checkBookingAgainstGoal, checkReadArgs, differentPlace } from "../src/goalcheck";
import { FLIGHT, makeFakeApi, type PlannerMove } from "./fakeApi";

// Cases found by an independent review: each one is a correct action that used to be refused, or a wrong one that slipped through.

const noSleep = async () => {};
const flight = (id: string, price: number, extra: Partial<CleanFlight> = {}): CleanFlight => ({ ...FLIGHT, flight_id: id, price_eur: price, date: "2026-11-03", origin: "Lisbon", destination: "Tokyo", nonstop: true, ...extra });
const ok = (goal: string, f: CleanFlight, who: string, found = [f], booked: Array<{ flight_id: string; passenger: string }> = []) => checkBookingAgainstGoal(parseGoal(goal), f, who, found, booked).ok;
const saved = { ...CONFIG };
afterEach(() => Object.assign(CONFIG, saved));
beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_BASE_URL", "http://fake.test");
  vi.stubEnv("TRIP_AGENT_API_KEY", "tk_test");
});

describe("passenger names", () => {
  const f = flight("FL-1", 300);
  it("a later 'for <Capital>' does not replace the passenger", () => {
    const goal = "Book a flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva and check the weather for Tokyo.";
    expect(ok(goal, f, "Maria Silva")).toBe(true);
    expect(ok(goal, f, "Eve Mallory")).toBe(false);
  });
  it("titles, initials, accents and non-Latin-1 letters are read whole", () => {
    for (const [goal, name] of [
      ["Book a flight from Lisbon to Tokyo for Dr. Anna Nowak.", "Anna Nowak"],
      ["Book a flight from Lisbon to Tokyo for Dr. Anna Nowak.", "Dr. Anna Nowak"],
      ["Book a flight from Lisbon to Tokyo for Maria J. Silva.", "Maria Silva"],
      ["Book a flight from Lisbon to Tokyo for Paweł Nowak.", "Paweł Nowak"],
      ["Book a flight from Lisbon to Tokyo for Anna Wiśniewska.", "Anna Wiśniewska"],
      ["Book a flight from Lisbon to Tokyo for Nguyễn Văn An.", "Nguyễn Văn An"],
    ] as const) expect(ok(goal, f, name), `${goal} / ${name}`).toBe(true);
  });
  it("a capital 'For' and a 'Passenger:' cue are read too, so a wrong name is caught", () => {
    expect(ok("For Maria Silva, book a flight from Lisbon to Tokyo.", f, "Eve Mallory")).toBe(false);
    expect(ok("Book a flight from Lisbon to Tokyo. Passenger: Maria Silva", f, "Eve Mallory")).toBe(false);
  });
  it("a goal that names nobody enforces nothing", () => {
    expect(ok("Book the cheapest flight from Lisbon to Tokyo on 2026-11-03.", f, "Anyone At All")).toBe(true);
  });
  it("one flight per passenger per run, unless the goal talks about a return or several flights", () => {
    const other = flight("FL-2", 310);
    const goal = "Book a flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.";
    expect(ok(goal, other, "Maria Silva", [f, other], [{ flight_id: "FL-1", passenger: "Maria Silva" }])).toBe(false);
    expect(ok(goal, other, "Juan Perez", [f, other], [{ flight_id: "FL-1", passenger: "Maria Silva" }])).toBe(false); // wrong name anyway
    expect(ok("Book the outbound and return flights from Lisbon to Tokyo for Maria Silva.", other, "Maria Silva", [f, other], [{ flight_id: "FL-1", passenger: "Maria Silva" }])).toBe(true);
  });
});

describe("budgets", () => {
  it.each([
    ["Book a flight under 1,000 euros", 1000],
    ["Book a flight under 299.99 EUR", 299.99],
    ["Book a flight, budget of EUR 300", 300],
    ["Book a flight for no more than €300", 300],
  ])("%s -> %s", (goal, budget) => expect(parseGoal(goal).budget).toBe(budget));
  it.each(["Book a flight with max 2 connections", "Book a flight with max 1 checked bag", "Book a flight under 5 hrs", "Book a flight under 500", "Book a flight under $500"])(
    "'%s' is not a euro budget, so nothing is enforced",
    (goal) => expect(parseGoal(goal).budget).toBeNull(),
  );
  it("a 299.50 flight is within 'under 299.99 EUR'", () => {
    expect(ok("Book a flight from Lisbon to Tokyo under 299.99 EUR", flight("FL-1", 299.5), "Anyone")).toBe(true);
  });
});

describe("routes and places", () => {
  it("a route followed by other words is still read", () => {
    const g = parseGoal("Book a flight from Lisbon to Tokyo under 800 euros for Maria Silva.");
    expect([g.origin, g.dest]).toEqual(["Lisbon", "Tokyo"]);
    expect(checkReadArgs("search_flights", { origin: "Madrid", dest: "Dublin", date: "2026-11-03" }, g)).toContain("Lisbon to Tokyo");
  });
  it("accents do not make two spellings different places", () => {
    expect(differentPlace("São Paulo", "Sao Paulo")).toBe(false);
    expect(differentPlace("Zürich", "Zurich")).toBe(false);
    expect(differentPlace("Tokyo", "Tokyo, Japan")).toBe(false);
    expect(differentPlace("Lisbon", "Madrid")).toBe(true);
  });
  it("'the weather at the destination' is not a city to enforce", () => {
    const g = parseGoal("Find a flight from Oslo to Cairo on 2026-12-05 and tell me the weather at the destination.");
    expect(checkReadArgs("get_weather", { city: "Cairo", date: "2026-12-05" }, g)).toBeNull();
    const named = parseGoal("Find a flight from Oslo to Cairo on 2026-12-05 and tell me the weather in Cairo that day.");
    expect(checkReadArgs("get_weather", { city: "Cairo", date: "2026-12-05" }, named)).toBeNull();
    expect(checkReadArgs("get_weather", { city: "Oslo", date: "2026-12-05" }, named)).toContain("Cairo");
  });
  it("a search for another day than the goal's single date is re-asked, and 'cheapest' ignores other days", () => {
    const g = parseGoal("Book the cheapest flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.");
    expect(checkReadArgs("search_flights", { origin: "Lisbon", dest: "Tokyo", date: "2026-11-04" }, g)).toContain("2026-11-03");
    const today = flight("FL-1", 500);
    const nextDay = flight("FL-2", 100, { date: "2026-11-04" });
    expect(ok("Book the cheapest flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.", today, "Maria Silva", [today, nextDay])).toBe(true);
    expect(ok("Book the cheapest flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.", nextDay, "Maria Silva", [today, nextDay])).toBe(false);
  });
  it("a goal with two dates enforces neither", () => {
    expect(parseGoal("Book a flight from Lisbon to Tokyo on 2026-11-03 and back on 2026-11-10.").dateGiven).toBe(false);
  });
  it("Paris to Paris is never booked, even if the server returned a flight", () => {
    const f = flight("FL-1", 100, { origin: "Paris", destination: "Paris" });
    expect(ok("Book a flight from Paris to Paris on 2026-11-03 for Anna Nowak.", f, "Anna Nowak")).toBe(false);
  });
});

describe("other wordings", () => {
  it.each(["Book a non stop flight", "Book a flight with no layovers", "Book a flight without any stops"])("'%s' means nonstop", (goal) => expect(parseGoal(goal).nonstop).toBe(true));
  it("'lowest fare' means cheapest", () => expect(parseGoal("Book the lowest fare").cheapest).toBe(true));
  it("'do not book it' is a search-only goal", () => {
    expect(parseGoal("Find a flight from Lisbon to Tokyo but do not book it.").wantBooking).toBe(false);
    expect(parseGoal("Book a flight from Lisbon to Tokyo.").wantBooking).toBe(true);
  });
  it("a zero or negative price is not a real flight", () => {
    const cleaned = cleanFlights([{ ...FLIGHT, flight_id: "FL-NEG", price_eur: -1 }, { ...FLIGHT, flight_id: "FL-ZERO", price_eur: 0 }, { ...FLIGHT, flight_id: "FL-OK", price_eur: 99 }]);
    expect(cleaned.map((x) => x.flight_id)).toEqual(["FL-OK"]);
  });
});

describe("in the agent loop", () => {
  const BOOKING_GOAL = "Book a flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.";
  const search: PlannerMove = { call: "search_flights", args: { origin: "Lisbon", dest: "Tokyo", date: "2026-11-03" } };
  const book = (id: string, who = "Maria Silva"): PlannerMove => ({ call: "book_flight", args: { flight_id: id, passenger: who } });

  it("a booking goal that also mentions another 'for <Place>' still books", async () => {
    const goal = "Book a flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva and check the weather for Tokyo.";
    const api = makeFakeApi({ planner: [search, book("FL-31A4"), { call: "get_weather", args: { city: "Tokyo", date: "2026-11-03" } }, { say: "done" }] });
    const result = await runAgent({ goal, seed: "t", autoConfirm: true, trace: () => {} }, { fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(result.status).toBe("success");
    expect(api.bookings).toHaveLength(1);
  });

  it("a second, different flight for the same passenger is refused: one booking per goal", async () => {
    const two = [FLIGHT, { ...FLIGHT, flight_id: "FL-2", price_eur: 800 }];
    const api = makeFakeApi({ planner: [search, book("FL-31A4"), book("FL-2")], searchResults: two });
    const result = await runAgent({ goal: BOOKING_GOAL, seed: "t", autoConfirm: true, trace: () => {} }, { fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(api.bookings.map((b) => b.flight_id)).toEqual(["FL-31A4"]);
    expect(result.errors.some((e) => e.code === "booking_not_matching_goal")).toBe(true);
  });

  it("a booking whose later end-of-run check is refused (401) is reported as not verified, never as confirmed", async () => {
    const api = makeFakeApi({ planner: [search, book("FL-31A4"), { say: "done" }], overrides: { "bookings#1": { status: 401 } } });
    const result = await runAgent({ goal: BOOKING_GOAL, seed: "t", autoConfirm: true, trace: () => {} }, { fetchImpl: api.fetchImpl, sleep: noSleep });
    expect(result.answer).not.toContain("confirmed on the server");
    expect(result.answer).toContain("not verified");
    expect(result.status).toBe("partial");
  });

  it("our own per-call timeout is really installed: a call that never answers is aborted and retried", async () => {
    CONFIG.callTimeoutMs = 15;
    CONFIG.chatRetries = 1;
    CONFIG.finalCheckTimeoutMs = 15; // the end-of-run check hangs too, and has its own timeout
    let signals = 0;
    const hang = (async (_url: unknown, init?: RequestInit) => {
      signals += init?.signal ? 1 : 0;
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))));
    }) as unknown as typeof fetch;
    const result = await runAgent({ goal: "Find a flight from Lisbon to Tokyo on 2026-11-03.", seed: "t", autoConfirm: true, trace: () => {} }, { fetchImpl: hang, sleep: noSleep });
    expect(signals).toBeGreaterThanOrEqual(2); // every attempt carried an abort signal
    expect(result.errors.some((e) => e.code === "llm_unavailable")).toBe(true);
  });
});
