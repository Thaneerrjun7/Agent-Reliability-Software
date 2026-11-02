/** Structured result contract (§ result.json) — validate before you write it. */
export type AgentResult = {
  status: "success" | "partial" | "failed";
  answer: string;
  bookings: Array<{ flight_id: string; passenger: string; idempotency_key?: string }>;
  steps: number;
  cost: number; // total tokens from the mock usage field
  errors: Array<{ code: string; message: string; step?: number }>;
};

/** One JSONL line of the trace. */
export type TraceLine = {
  run_id: string;
  step: number;
  action: string;
  args?: unknown;
  latency_ms?: number;
  tokens?: number;
  retry_count?: number;
  outcome?: string;
};

/** Minimal validation — enough to catch a malformed result before submission. */
export function validateResult(r: unknown): string[] {
  const errors: string[] = [];
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return ["result is not an object"];
  if (!["success", "partial", "failed"].includes(o.status as string)) errors.push("status must be success|partial|failed");
  if (typeof o.answer !== "string") errors.push("answer must be a string");
  if (!Array.isArray(o.bookings)) errors.push("bookings must be an array");
  if (typeof o.steps !== "number") errors.push("steps must be a number");
  if (typeof o.cost !== "number") errors.push("cost must be a number");
  if (!Array.isArray(o.errors)) errors.push("errors must be an array");
  return errors;
}
