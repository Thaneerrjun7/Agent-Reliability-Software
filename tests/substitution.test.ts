import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseGoal, runAgent, type CleanFlight } from "../src/agent";
import { FLIGHT, makeFakeApi, type PlannerMove } from "./fakeApi";

const noSleep = async () => {};
const flight = (id: string, price: number, extra: Partial<CleanFlight> = {}): CleanFlight => ({ ...FLIGHT, flight_id: id, price_eur: price, ...extra });

const GOAL = "Book the cheapest nonstop flight from Porto to Oslo on 2026-11-18 for Maria Silva.";
const flights = [
  flight("FL-P1", 180, { date: "2026-11-18", origin: "OPO", destination: "OSL", nonstop: false }), // cheapest overall, but has stops
  flight("FL-P2", 320, { date: "2026-11-18", origin: "OPO", destination: "OSL", nonstop: true }), // the right pick
  flight("FL-P3", 410, { date: "2026-11-18", origin: "OPO", destination: "OSL", nonstop: true }),
];
const search: PlannerMove = { call: "search_flights", args: { origin: "Porto", dest: "Oslo", date: "2026-11-18" } };
const book = (id: string, passenger = "Maria Silva"): PlannerMove => ({ call: "book_flight", args: { flight_id: id, passenger } });

beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_BASE_URL", "http://fake.test");
  vi.stubEnv("TRIP_AGENT_API_KEY", "tk_test");
});

async function play(opts: { goal?: string; planner: PlannerMove[]; confirm?: (f: string, p: string) => Promise<boolean>; autoConfirm?: boolean }) {
  const api = makeFakeApi({ planner: opts.planner, searchResults: flights });
  const chatBodies: string[] = [];
  const lines: Array<Record<string, any>> = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/chat")) chatBodies.push(String(init?.body));
    return api.fetchImpl(input, init);
  }) as typeof fetch;
  const result = await runAgent(
    { goal: opts.goal ?? GOAL, seed: "t", autoConfirm: opts.autoConfirm ?? true, trace: (l) => lines.push(l) },
    { fetchImpl: spy, sleep: noSleep, confirm: opts.confirm },
  );
  return { api, result, chatBodies, lines };
}

describe("the planner keeps picking a flight that is not the cheapest", () => {
  it("is told once, then the agent books the cheapest eligible flight itself and says so", async () => {
    const { api, result, chatBodies } = await play({ planner: [search, book("FL-P3"), book("FL-P3"), { say: "done" }] });
    expect(api.bookings.map((b) => b.flight_id)).toEqual(["FL-P2"]); // the cheapest nonstop, not FL-P1 (stops) and not FL-P3
    expect(api.count("book_flight")).toBe(1);
    expect(result.status).toBe("success");
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].flight_id).toBe("FL-P2");
    expect(result.answer).toContain("The planner picked FL-P3, which is not the cheapest, so I booked the cheapest eligible flight, FL-P2");
    expect(result.answer).toContain("confirmed on the server");
    expect(chatBodies[2]).toContain("Book FL-P2"); // the first wrong pick was told what to do
    expect(chatBodies[3]).toContain("You asked for FL-P3"); // and the planner learns what was booked
    expect(result.errors.filter((e) => e.code === "booking_not_matching_goal")).toHaveLength(1); // the first refusal stays on record
  });

  it("replaces a different wrong pick the second time too, and books for the passenger the goal names", async () => {
    const goal = "Book the cheapest flight from Porto to Oslo on 2026-11-18 for Maria Silva."; // no nonstop rule: FL-P1 is the cheapest
    const { api, result } = await play({ goal, planner: [search, book("FL-P3"), book("FL-P2"), { say: "done" }] });
    expect(api.bookings).toHaveLength(1);
    expect(api.bookings[0]).toMatchObject({ flight_id: "FL-P1", passenger: "Maria Silva" }); // from our own search results
    expect(result.answer).toContain("The planner picked FL-P2, which is not the cheapest, so I booked the cheapest eligible flight, FL-P1");
  });

  it("asks the operator about the substituted flight, and booking nothing is fine if they decline", async () => {
    const asked: string[] = [];
    const confirm = async (f: string, p: string) => { asked.push(`${f} for ${p}`); return false; };
    const { api, result } = await play({ planner: [search, book("FL-P3"), book("FL-P3"), { say: "done" }], confirm, autoConfirm: false });
    expect(asked).toEqual(["FL-P2 for Maria Silva"]); // the flight that would be booked, not the planner's pick
    expect(api.count("book_flight")).toBe(0);
    expect(result.status).toBe("partial");
    expect(result.errors.some((e) => e.code === "booking_not_confirmed")).toBe(true);
  });

  it("never substitutes when the price is not the only thing wrong (wrong passenger: refused both times, nothing booked)", async () => {
    const { api, result } = await play({ planner: [search, book("FL-P3", "Eve Mallory")] }); // the last move repeats
    expect(api.count("book_flight")).toBe(0);
    expect(result.status).toBe("partial");
    expect(result.bookings).toHaveLength(0);
  });

  it("never substitutes when the planner's flight breaks another rule (stops although the goal says nonstop)", async () => {
    const { api, result } = await play({ planner: [search, book("FL-P1")] });
    expect(api.count("book_flight")).toBe(0);
    expect(result.status).toBe("partial");
  });

  it("does nothing special when the goal does not ask for the cheapest", async () => {
    const goal = "Book a nonstop flight from Porto to Oslo on 2026-11-18 for Maria Silva.";
    expect(parseGoal(goal).cheapest).toBe(false);
    const { api, result } = await play({ goal, planner: [search, book("FL-P3"), { say: "done" }] });
    expect(api.bookings.map((b) => b.flight_id)).toEqual(["FL-P3"]);
    expect(result.status).toBe("success");
    expect(result.answer).not.toContain("The planner picked");
  });
});

describe("a re-ask happens inside the step, as the docs define a step", () => {
  const goal = "Find me a flight from Porto to Oslo on 2026-11-18.";

  it("three re-asks then a good move is still one step, so `steps` counts only usable moves", async () => {
    const { result, lines } = await play({ goal, planner: [{ say: "" }, { call: "fly_to_moon", args: {} }, { call: "search_flights", args: "{not json" }, search, { say: "done" }] });
    expect(result.status).toBe("success");
    expect(result.steps).toBe(2); // step 1: search (after 3 re-asks), step 2: the final answer
    const stepOfFirstSearch = lines.find((l) => l.action === "search_flights")?.step;
    expect(stepOfFirstSearch).toBe(1);
    const planner = lines.filter((l) => l.action === "llm.chat").map((l) => l.step);
    expect(planner.slice(0, 4)).toEqual([1, 1, 1, 1]); // all four planner calls belong to step 1
    expect(lines.filter((l) => l.action === "llm.reask").map((l) => l.step)).toEqual([1, 1, 1]);
  });

  it("re-asks do not use up the 25-step cap", async () => {
    const { result } = await play({ goal, planner: [{ say: "" }, { say: "" }, { say: "" }, search, { say: "done" }] });
    expect(result.steps).toBe(2);
  });
});
