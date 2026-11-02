/**
 * A fake of the mock API for failure-path tests: no network, no real key.
 * `planner` is the script of moves the fake planner makes, in order; the last
 * one repeats if the agent keeps asking. `rules` can override any endpoint's
 * answer for one call, so a test can say "the 1st book_flight call times out".
 */

export type PlannerMove =
  | { call: string; args: unknown }
  | { say: string };

export type FakeBooking = { booking_id: string; flight_id: string; passenger: string; idempotency_key: string; booked_at: string };

/**
 * What a call does instead of the normal answer:
 *  - "timeout": the request dies with a TimeoutError (nothing was committed).
 *  - "networkError": the connection drops (Node's `TypeError: fetch failed`).
 *  - { status, headers?, body? }: an HTTP reply. `raw` is sent as the exact body text instead of JSON
 *    (an HTML error page, an empty body, the string "null").
 *  - { commitThenTimeout }: a booking is committed on the server, then the request hangs.
 */
export type Override =
  | "timeout"
  | "networkError"
  | { status: number; headers?: Record<string, string>; body?: unknown; raw?: string }
  | { commitThenTimeout: true };

export const FLIGHT = { flight_id: "FL-31A4", airline: "TAP", origin: "LIS", destination: "NRT", date: "2026-11-03", depart: "09:00", duration_minutes: 900, price_eur: 700, nonstop: false };

export function makeFakeApi(opts: {
  planner?: PlannerMove[];
  /** Instead of a fixed script: the planner's move number n (0-based). Lets a test make a planner that never repeats itself. */
  plannerFn?: (n: number) => PlannerMove;
  /** Overrides keyed by "<endpoint>#<nth call, starting at 1>", e.g. "book_flight#1", or "<endpoint>#*" for every call that has no entry of its own. */
  overrides?: Record<string, Override>;
  searchResults?: unknown[];
  /** The token usage every chat reply reports (default 100 + 20). */
  usage?: { prompt_tokens: number; completion_tokens: number };
}) {
  const bookings: FakeBooking[] = [];
  const calls: Array<{ endpoint: string; body: any; seed: string | null }> = [];
  const counts: Record<string, number> = {};
  let plannerIndex = 0;
  const script = opts.planner ?? [];

  let responses = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": `req-${++responses}`, ...headers },
    });

  const timeoutError = () => Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });

  const commit = (body: any): FakeBooking => {
    const existing = bookings.find((b) => b.idempotency_key === body.idempotency_key);
    if (existing) return existing;
    const created = { booking_id: `BK-${bookings.length + 1}`, flight_id: body.flight_id, passenger: body.passenger, idempotency_key: body.idempotency_key, booked_at: "2026-11-02T12:00:00Z" };
    bookings.push(created);
    return created;
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    counts[endpoint] = (counts[endpoint] ?? 0) + 1;
    calls.push({ endpoint, body, seed: url.searchParams.get("seed") });

    const override = opts.overrides?.[`${endpoint}#${counts[endpoint]}`] ?? opts.overrides?.[`${endpoint}#*`];
    if (override === "timeout") throw timeoutError();
    if (override === "networkError") throw new TypeError("fetch failed");
    if (override && "commitThenTimeout" in override) {
      commit(body);
      throw timeoutError();
    }
    if (override) {
      if (override.raw !== undefined) {
        return new Response(override.raw, {
          status: override.status,
          headers: { "content-type": "application/json", "x-request-id": `req-${++responses}`, ...override.headers },
        });
      }
      return json(override.status, override.body ?? { error: { code: "fault", message: "injected" } }, override.headers);
    }

    switch (endpoint) {
      case "chat": {
        const n = plannerIndex++;
        const move = opts.plannerFn ? opts.plannerFn(n) : script[Math.min(n, script.length - 1)];
        const usage = opts.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
        const message = "say" in move
          ? { role: "assistant", content: move.say, tool_calls: null }
          : { role: "assistant", content: null, tool_calls: [{ name: move.call, arguments: typeof move.args === "string" ? move.args : JSON.stringify(move.args) }] };
        return json(200, { id: "c1", message, usage });
      }
      case "search_flights":
        return json(200, { results: opts.searchResults ?? [FLIGHT] });
      case "get_weather":
        return json(200, { city: body.city, date: body.date, temperature_c: 12, conditions: "Cloudy", stale: false });
      case "book_flight": {
        const already = bookings.some((b) => b.idempotency_key === body.idempotency_key);
        return json(200, { booking: commit(body), ...(already ? { idempotent_replay: true } : {}) });
      }
      case "bookings":
        return json(200, { bookings });
      default:
        return json(404, { error: { code: "not_found", message: endpoint } });
    }
  }) as typeof fetch;

  /** Everything the planner was ever sent (all messages of every chat request), as one string. */
  const sentToPlanner = () => calls.filter((c) => c.endpoint === "chat").map((c) => JSON.stringify(c.body.messages)).join("\n");

  return { fetchImpl, bookings, calls, count: (endpoint: string) => counts[endpoint] ?? 0, sentToPlanner };
}

export const GOAL = "Find a flight from Lisbon to Tokyo on 2026-11-03 and book it for Maria Silva";
export const SEARCH = { call: "search_flights", args: { origin: "Lisbon", dest: "Tokyo", date: "2026-11-03" } };
export const BOOK = { call: "book_flight", args: { flight_id: FLIGHT.flight_id, passenger: "Maria Silva" } };
