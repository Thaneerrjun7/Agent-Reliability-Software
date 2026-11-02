import { describe, expect, it } from "vitest";
import { formatTrace } from "../scripts/show-trace";

describe("the trace reader", () => {
  it("prints one line per entry and a summary of calls, retries, timeouts, invalid output and tokens", () => {
    const trace = [
      { run_id: "r", step: 1, action: "llm.chat", latency_ms: 120, tokens: 300, retry_count: 0, outcome: "ok", request_id: "8f3a2c1d-aaaa-bbbb-cccc-111122223333" },
      { run_id: "r", step: 1, action: "search_flights", latency_ms: 80, retry_count: 0, outcome: "retry", detail: "HTTP 503" },
      { run_id: "r", step: 1, action: "search_flights", latency_ms: 10010, retry_count: 1, outcome: "timeout" },
      { run_id: "r", step: 2, action: "book_flight", outcome: "invalid_output", detail: "booking refused, does not match the goal" },
    ].map((l) => JSON.stringify(l)).join("\n");
    const lines = formatTrace(trace + "\nnot json\n").split("\n");

    expect(lines[0]).toContain("step  1");
    expect(lines[0]).toContain("llm.chat");
    expect(lines[0]).toContain("120ms");
    expect(lines[0]).toContain("req=8f3a2c1d"); // shortened
    expect(lines[0]).not.toContain("aaaa");
    expect(lines[1]).toContain("HTTP 503");
    expect(lines[2]).toContain("retry=1");
    expect(lines[3]).toContain("does not match the goal");
    expect(lines[4]).toBe("(unreadable line)");
    expect(lines.at(-1)).toBe("calls 3, retries 1, timeouts 1, invalid_output 1, tokens 300");
  });
});
