import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseGoal, runAgent, type CleanFlight } from "../src/agent";
import { checkBookingAgainstGoal, checkReadArgs, differentPlace, isRealDate } from "../src/goalcheck";
import { FLIGHT, makeFakeApi, type PlannerMove } from "./fakeApi";

const noSleep = async () => {};

const flight = (id: string, price: number, extra: Partial<CleanFlight> = {}): CleanFlight => ({ ...FLIGHT, flight_id: id, price_eur: price, ...extra });
const check = (goal: string, chosen: CleanFlight, passenger: string, found: CleanFlight[]) => checkBookingAgainstGoal(parseGoal(goal), chosen, passenger, found);
const reasonOf = (c: ReturnType<typeof check>) => (c.ok ? "" : c.reason);

// The two public booking goals, with flights shaped like the live ones (airport codes).
const PORTO = "Book the cheapest nonstop flight from Porto to Oslo on 2026-11-18 for Maria Silva.";
const SEOUL = "Book the cheapest flight from Seoul to Berlin on 2026-12-01 for Juan Perez.";
const porto = [
  flight("FL-P1", 180, { origin: "OPO", destination: "OSL", nonstop: false }), // cheapest, but has stops
  flight("FL-P2", 320, { origin: "OPO", destination: "OSL", nonstop: true }), // the only right pick
  flight("FL-P3", 410, { origin: "OPO", destination: "OSL", nonstop: true }),
];
const seoul = [
  flight("FL-S1", 900, { origin: "ICN", destination: "BER" }),
  flight("FL-S2", 700, { origin: "ICN", destination: "BER" }),
  flight("FL-S3", 700, { origin: "ICN", destination: "BER" }), // same price as S2
];

describe("parseGoal: the details the booking check relies on", () => {
  it("reads cheapest, in several wordings", () => {
    expect(parseGoal(PORTO).cheapest).toBe(true);
    expect(parseGoal("Book the lowest-price flight from A to B").cheapest).toBe(true);
    expect(parseGoal("Book a flight from A to B").cheapest).toBe(false);
  });

  it("reads a budget only when it is a plain amount in euros", () => {
    expect(parseGoal("Book a flight under 500 for Ana Costa").budget).toBe(500);
    expect(parseGoal("Book a flight under €450").budget).toBe(450);
    expect(parseGoal("Book a flight under $450").budget).toBeNull(); // dollars: cannot compare with price_eur
    expect(parseGoal("Book a flight with max 2 stops").budget).toBeNull(); // not money
    expect(parseGoal("Book a flight under 300 USD").budget).toBeNull();
  });

  it("reads passengers with accents and hyphens whole", () => {
    expect(parseGoal("Book a flight from Lisbon to Tokyo for José Álvarez.").passenger).toBe("José Álvarez");
    expect(parseGoal("Book a flight from Lisbon to Tokyo for Mary-Jane Smith.").passenger).toBe("Mary-Jane Smith");
  });

  it("reads the place after 'weather in'", () => {
    expect(parseGoal("Find a flight from Oslo to Cairo on 2026-12-05 and tell me the weather in Cairo that day.").weatherCity).toBe("Cairo that day");
    expect(parseGoal("Find a flight from Madrid to Dublin on 2026-11-25 and check the weather in Dublin.").weatherCity).toBe("Dublin");
    expect(parseGoal("Find a flight from Madrid to Dublin on 2026-11-25").weatherCity).toBeNull();
  });
});

describe("checkBookingAgainstGoal: the public goal shapes pass", () => {
  it("cheapest nonstop Porto to Oslo: the only nonstop pick that is cheapest is allowed", () => {
    expect(check(PORTO, porto[1], "Maria Silva", porto)).toEqual({ ok: true });
  });

  it("cheapest Seoul to Berlin: the cheapest is allowed, and so is a tie", () => {
    expect(check(SEOUL, seoul[1], "Juan Perez", seoul)).toEqual({ ok: true });
    expect(check(SEOUL, seoul[2], "Juan Perez", seoul)).toEqual({ ok: true });
  });

  it("flights named in words (Porto, Oslo) match the goal too", () => {
    const named = flight("FL-N1", 300, { origin: "Porto", destination: "Oslo", nonstop: true });
    expect(check(PORTO, named, "Maria Silva", [named])).toEqual({ ok: true });
  });

  it("the goal in the existing tests (airport codes LIS and NRT against Lisbon and Tokyo) is not blocked", () => {
    const goal = "Find a flight from Lisbon to Tokyo on 2026-11-03 and book it for Maria Silva";
    expect(check(goal, flight("FL-31A4", 700), "Maria Silva", [flight("FL-31A4", 700)])).toEqual({ ok: true });
  });
});

describe("checkBookingAgainstGoal: each refusal", () => {
  it("(a) a different passenger, compared without case or padding", () => {
    expect(reasonOf(check(PORTO, porto[1], "Eve Mallory", porto))).toContain("Maria Silva");
    expect(check(PORTO, porto[1], "  MARIA silva ", porto)).toEqual({ ok: true });
    expect(check(PORTO, porto[1], "Maria", porto).ok).toBe(false); // a bare first name is not the named passenger
    expect(check(PORTO, porto[1], "Maria Silva Santos", porto).ok).toBe(true); // the parser keeps only two words of a name
  });

  it("(b) a flight with stops when the goal says nonstop, naming what would be acceptable", () => {
    const reason = reasonOf(check(PORTO, porto[0], "Maria Silva", porto));
    expect(reason).toContain("nonstop");
    expect(reason).toContain("FL-P2"); // the cheapest acceptable one comes first
    expect(check("Book a direct flight from Porto to Oslo for Maria Silva", porto[0], "Maria Silva", porto).ok).toBe(false);
  });

  it("(b) says so when no found flight fits at all", () => {
    const reason = reasonOf(check(PORTO, porto[0], "Maria Silva", [porto[0]]));
    expect(reason).toContain("do not book");
  });

  it("(c) a price over the budget", () => {
    const goal = "Book a flight from Lisbon to Tokyo on 2026-11-03 under 500 for Maria Silva.";
    const found = [flight("FL-A", 700), flight("FL-B", 450)];
    const c = check(goal, found[0], "Maria Silva", found);
    expect(reasonOf(c)).toContain("budget of EUR 500");
    expect(reasonOf(c)).toContain("FL-B");
    expect(check(goal, found[1], "Maria Silva", found)).toEqual({ ok: true });
    expect(check(goal, flight("FL-C", 500), "Maria Silva", found).ok).toBe(true); // exactly the budget is fine
  });

  it("(d) not the cheapest among the flights that qualify", () => {
    const reason = reasonOf(check(PORTO, porto[2], "Maria Silva", porto));
    expect(reason).toContain("cheapest");
    expect(reason).toContain("Book FL-P2");
    expect(reasonOf(check(SEOUL, seoul[0], "Juan Perez", seoul))).toContain("Book FL-S2");
  });

  it("(e) a route that is clearly not the goal's", () => {
    const goal = "Book a flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.";
    const wrong = flight("FL-W", 300, { origin: "Madrid", destination: "Dublin" });
    expect(reasonOf(check(goal, wrong, "Maria Silva", [wrong]))).toContain("Madrid to Dublin");
    const sameRoute = flight("FL-R", 300, { origin: "Lisbon (LIS)", destination: "Tokyo Narita" });
    expect(check(goal, sameRoute, "Maria Silva", [sameRoute]).ok).toBe(true);
  });

  it("(e) is not applied when one end could just be another airport name, or when a code cannot be compared", () => {
    const goal = "Book a flight from Lisbon to Tokyo on 2026-11-03 for Maria Silva.";
    const oneEnd = flight("FL-O", 300, { origin: "Lisbon", destination: "Haneda Airport" });
    const codes = flight("FL-C", 300, { origin: "XYZ", destination: "QRS" });
    const empty = flight("FL-E", 300, { origin: "", destination: "" });
    for (const f of [oneEnd, codes, empty]) expect(check(goal, f, "Maria Silva", [f]).ok).toBe(true);
  });

  it("checks nothing the goal did not say", () => {
    const anything = flight("FL-ANY", 9999, { origin: "Madrid", destination: "Dublin", nonstop: false });
    expect(check("Book a flight", anything, "Whoever", [anything])).toEqual({ ok: true });
  });
});

describe("checkReadArgs: arguments are checked before any API call", () => {
  const goal = parseGoal("Find a flight from Oslo to Cairo on 2026-12-05 and tell me the weather in Cairo that day.");
  const search = { origin: "Oslo", dest: "Cairo", date: "2026-12-05" };

  it("accepts the goal's own search and weather request", () => {
    expect(checkReadArgs("search_flights", search, goal)).toBeNull();
    expect(checkReadArgs("get_weather", { city: "Cairo", date: "2026-12-05" }, goal)).toBeNull();
    expect(checkReadArgs("search_flights", { origin: "OSL", dest: "CAI", date: "2026-12-05" }, goal)).toBeNull(); // codes: cannot tell
    expect(checkReadArgs("bookings", {}, goal)).toBeNull();
  });

  it("rejects missing, empty, non-text and over-long values", () => {
    expect(checkReadArgs("search_flights", { dest: "Cairo", date: "2026-12-05" }, goal)).toContain("origin");
    expect(checkReadArgs("search_flights", { ...search, dest: "  " }, goal)).toContain("dest");
    expect(checkReadArgs("search_flights", { ...search, origin: 42 }, goal)).toContain("origin");
    expect(checkReadArgs("search_flights", { ...search, origin: "x".repeat(500) }, goal)).toContain("max");
    expect(checkReadArgs("get_weather", { date: "2026-12-05" }, goal)).toContain("city");
  });

  it("rejects dates that are not a real YYYY-MM-DD day", () => {
    for (const bad of ["tomorrow", "2026-12-5", "05/12/2026", "2026-13-45", "2026-02-30", "", undefined, 20261205]) {
      expect(checkReadArgs("search_flights", { ...search, date: bad }, goal)).toContain("YYYY-MM-DD");
      expect(checkReadArgs("get_weather", { city: "Cairo", date: bad }, goal)).toContain("YYYY-MM-DD");
    }
    expect(isRealDate("2028-02-29")).toBe(true);
  });

  it("rejects a clearly different route or city, and says what the goal asked for", () => {
    expect(checkReadArgs("search_flights", { ...search, origin: "Madrid" }, goal)).toContain("Oslo to Cairo");
    expect(checkReadArgs("search_flights", { ...search, dest: "Dublin" }, goal)).toContain("Oslo to Cairo");
    expect(checkReadArgs("get_weather", { city: "Paris", date: "2026-12-05" }, goal)).toContain("Cairo");
  });

  it("enforces nothing when the goal did not give a route or a weather place", () => {
    const open = parseGoal("Find me something fun");
    expect(checkReadArgs("search_flights", { origin: "Madrid", dest: "Dublin", date: "2026-11-25" }, open)).toBeNull();
    expect(checkReadArgs("get_weather", { city: "Paris", date: "2026-11-25" }, open)).toBeNull();
  });

  it("differentPlace: containment either way is the same place", () => {
    expect(differentPlace("Lisbon", "lisbon (LIS)")).toBe(false);
    expect(differentPlace("Tokyo", "Tokyo that day")).toBe(false);
    expect(differentPlace("Madrid", "Dublin")).toBe(true);
    expect(differentPlace("NRT", "Tokyo")).toBe(false);
    expect(differentPlace("", "Tokyo")).toBe(false);
    expect(differentPlace("Tokyo", null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same checks inside the agent loop, against the fake API.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_BASE_URL", "http://fake.test");
  vi.stubEnv("TRIP_AGENT_API_KEY", "tk_test");
});

async function play(goal: string, planner: PlannerMove[], searchResults?: unknown[]) {
  const api = makeFakeApi({ planner, searchResults });
  const chatBodies: string[] = [];
  const lines: Array<Record<string, any>> = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/chat")) chatBodies.push(String(init?.body));
    return api.fetchImpl(input, init);
  }) as typeof fetch;
  const result = await runAgent({ goal, seed: "t", autoConfirm: true, trace: (l) => lines.push(l) }, { fetchImpl: spy, sleep: noSleep });
  return { api, result, chatBodies, lines };
}

const searchPorto: PlannerMove = { call: "search_flights", args: { origin: "Porto", dest: "Oslo", date: "2026-11-18" } };
const bookP = (id: string, passenger = "Maria Silva"): PlannerMove => ({ call: "book_flight", args: { flight_id: id, passenger } });
const refusalErrors = (r: { errors: Array<{ code: string; step?: number }> }) => r.errors.filter((e) => e.code === "booking_not_matching_goal");

describe("public goal shapes still book", () => {
  it("'cheapest nonstop flight from Porto to Oslo ... for Maria Silva' books the nonstop flight", async () => {
    const { api, result } = await play(PORTO, [searchPorto, bookP("FL-P2"), { say: "done" }], porto);
    expect(result.status).toBe("success");
    expect(api.bookings.map((b) => b.flight_id)).toEqual(["FL-P2"]);
    expect(refusalErrors(result)).toHaveLength(0);
  });

  it("'cheapest flight from Seoul to Berlin ... for Juan Perez' books the cheapest", async () => {
    const search: PlannerMove = { call: "search_flights", args: { origin: "Seoul", dest: "Berlin", date: "2026-12-01" } };
    const { api, result } = await play(SEOUL, [search, bookP("FL-S2", "Juan Perez"), { say: "done" }], seoul);
    expect(result.status).toBe("success");
    expect(api.bookings).toHaveLength(1);
    expect(refusalErrors(result)).toHaveLength(0);
  });
});

describe("a booking that does not match the goal", () => {
  it("is refused without calling the API, and the planner is told what is acceptable", async () => {
    const { api, result, chatBodies, lines } = await play(PORTO, [searchPorto, bookP("FL-P1"), bookP("FL-P2"), { say: "done" }], porto);
    expect(api.count("book_flight")).toBe(1); // only the second, acceptable try reached the API
    expect(api.bookings.map((b) => b.flight_id)).toEqual(["FL-P2"]);
    expect(result.status).toBe("success");
    expect(refusalErrors(result)).toHaveLength(1);
    expect(refusalErrors(result)[0].step).toBeGreaterThan(0);
    expect(chatBodies[2]).toContain("Nothing was booked");
    expect(chatBodies[2]).toContain("Acceptable flights from the search results: FL-P2");
    expect(lines.some((l) => l.action === "book_flight" && l.outcome === "invalid_output" && String(l.detail).includes("does not match the goal"))).toBe(true);
    expect(result.answer).toContain("Refused to book"); // the answer says what was refused, then what was booked
    expect(result.answer).toContain("FL-P2");
  });

  it("(cheapest) the planner is told which flight to book instead", async () => {
    const { api, result, chatBodies } = await play(PORTO, [searchPorto, bookP("FL-P3"), bookP("FL-P2"), { say: "done" }], porto);
    expect(chatBodies[2]).toContain("Book FL-P2");
    expect(api.bookings.map((b) => b.flight_id)).toEqual(["FL-P2"]);
    expect(result.status).toBe("success");
  });

  it("(passenger) books under another name are refused, then the right name goes through", async () => {
    const { api, result } = await play(PORTO, [searchPorto, bookP("FL-P2", "Eve Mallory"), bookP("FL-P2"), { say: "done" }], porto);
    expect(api.bookings.map((b) => b.passenger)).toEqual(["Maria Silva"]);
    expect(refusalErrors(result)).toHaveLength(1);
    expect(result.status).toBe("success");
  });

  it("asking for the same refused booking twice stops the run as partial, with nothing booked", async () => {
    const { api, result, lines } = await play(PORTO, [searchPorto, bookP("FL-P1")], porto); // the last move repeats
    expect(api.count("book_flight")).toBe(0);
    expect(api.bookings).toHaveLength(0);
    expect(result.status).toBe("partial");
    expect(result.bookings).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "booking_not_matching_goal" && e.step !== undefined)).toBe(true);
    expect(result.answer).toContain("Refused to book");
    expect(result.answer).toContain("nonstop");
    expect(lines.filter((l) => l.action === "book_flight" && l.outcome === "invalid_output")).toHaveLength(2);
    for (const l of lines) expect(["ok", "retry", "invalid_output", "timeout", "cap"]).toContain(l.outcome);
  });
});

describe("search_flights and get_weather arguments", () => {
  const goalText = "Find a flight from Oslo to Cairo on 2026-12-05 and tell me the weather in Cairo that day.";
  const goodSearch: PlannerMove = { call: "search_flights", args: { origin: "Oslo", dest: "Cairo", date: "2026-12-05" } };

  it("a bad date is re-asked with the reason, and the API is not called for it", async () => {
    const badDate: PlannerMove = { call: "search_flights", args: { origin: "Oslo", dest: "Cairo", date: "next friday" } };
    const { api, result, chatBodies } = await play(goalText, [badDate, goodSearch, { say: "done" }]);
    expect(api.count("search_flights")).toBe(1); // only the good one
    expect(chatBodies[1]).toContain("re-ask 1 of 3");
    expect(chatBodies[1]).toContain("YYYY-MM-DD");
    expect(result.errors.some((e) => e.code === "model_output_malformed")).toBe(false);
  });

  it("a missing origin is re-asked", async () => {
    const noOrigin: PlannerMove = { call: "search_flights", args: { dest: "Cairo", date: "2026-12-05" } };
    const { api, chatBodies } = await play(goalText, [noOrigin, goodSearch, { say: "done" }]);
    expect(api.count("search_flights")).toBe(1);
    expect(chatBodies[1]).toContain("origin");
  });

  it("a different route is not searched: it is re-asked at most 3 times, then the run fails cleanly", async () => {
    const wrongRoute: PlannerMove = { call: "search_flights", args: { origin: "Madrid", dest: "Dublin", date: "2026-12-05" } };
    const { api, result, chatBodies, lines } = await play(goalText, [wrongRoute]); // the planner never gives in
    expect(api.count("search_flights")).toBe(0);
    expect(chatBodies[1]).toContain("Oslo to Cairo");
    expect(lines.filter((l) => l.action === "llm.reask")).toHaveLength(3);
    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "model_output_malformed")).toBe(true);
  });

  it("weather for a different city than the goal's is re-asked, then the right city is fetched", async () => {
    const wrongCity: PlannerMove = { call: "get_weather", args: { city: "Paris", date: "2026-12-05" } };
    const rightCity: PlannerMove = { call: "get_weather", args: { city: "Cairo", date: "2026-12-05" } };
    const { api, result, chatBodies } = await play(goalText, [goodSearch, wrongCity, rightCity, { say: "done" }]);
    expect(api.calls.filter((c) => c.endpoint === "get_weather").map((c) => c.body.city)).toEqual(["Cairo"]);
    expect(chatBodies.join("\n")).toContain("weather in Cairo that day");
    expect(result.status).toBe("success");
    expect(result.answer).toContain("Weather in Cairo");
  });

  it("weather with an empty city is re-asked", async () => {
    const { api } = await play(goalText, [goodSearch, { call: "get_weather", args: { city: "", date: "2026-12-05" } }, { call: "get_weather", args: { city: "Cairo", date: "2026-12-05" } }, { say: "done" }]);
    expect(api.count("get_weather")).toBe(1);
  });
});
