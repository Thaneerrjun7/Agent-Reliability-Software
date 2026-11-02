/**
 * Thin HTTP client for the mock APIs. Typed request/response envelopes ONLY —
 * deliberately NO retries, NO validation, NO timeouts. That reliability work
 * is the assessment; write it in your agent (src/agent.ts).
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { name: string; arguments: string }[] | null;
};

export type ChatResponse = {
  id: string;
  message: { role: "assistant"; content: string | null; tool_calls: { name: string; arguments: string }[] | null };
  usage: { prompt_tokens: number; completion_tokens: number };
};

export type ApiEnvelope<T> = {
  status: number;
  headers: Headers;
  body: T | { error: { code: string; message: string } };
};

export class MockApiClient {
  constructor(
    private opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch },
  ) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; seed?: string | number } = {},
  ): Promise<ApiEnvelope<T>> {
    // Tolerate a trailing slash in TRIP_AGENT_BASE_URL (no "//api/..." 308 round trips).
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}${path}`);
    if (init.seed !== undefined) url.searchParams.set("seed", `${init.seed}`);
    const res = await (this.opts.fetchImpl ?? fetch)(url.toString(), {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    const body = (await res.json().catch(() => ({ error: { code: "bad_json", message: "response was not JSON" } }))) as T;
    return { status: res.status, headers: res.headers, body };
  }

  chat(messages: ChatMessage[], opts: { seed?: string | number; signal?: AbortSignal } = {}) {
    return this.request<ChatResponse>("/api/mock/v1/llm/chat", {
      body: { messages, ...(opts.seed !== undefined ? { seed: opts.seed } : {}) },
      signal: opts.signal,
    });
  }

  searchFlights(
    args: { origin: string; dest: string; date: string },
    opts: { seed?: string | number; signal?: AbortSignal } = {},
  ) {
    return this.request<{ results: unknown[] }>("/api/mock/v1/tools/search_flights", { body: args, ...opts });
  }

  getWeather(args: { city: string; date: string }, opts: { seed?: string | number; signal?: AbortSignal } = {}) {
    return this.request<{ city: string; date: string; temperature_c: number; conditions: string; stale: boolean }>(
      "/api/mock/v1/tools/get_weather",
      { body: args, ...opts },
    );
  }

  bookFlight(
    args: { flight_id: string; passenger: string; idempotency_key: string },
    opts: { seed?: string | number; signal?: AbortSignal } = {},
  ) {
    return this.request<{
      booking: { booking_id: string; flight_id: string; passenger: string; idempotency_key: string; booked_at: string };
      idempotent_replay?: boolean;
    }>("/api/mock/v1/tools/book_flight", { body: args, ...opts });
  }

  listBookings(opts: { seed?: string | number; signal?: AbortSignal } = {}) {
    return this.request<{
      bookings: Array<{ booking_id: string; flight_id: string; passenger: string; idempotency_key: string; booked_at: string }>;
    }>("/api/mock/v1/tools/bookings", { method: "GET", ...opts });
  }
}
