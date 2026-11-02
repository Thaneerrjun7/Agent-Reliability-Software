import { describe, expect, it } from "vitest";
import { parseArgs, writeJson, TraceWriter } from "../src/agent";
import { validateResult } from "../src/types";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

describe("starter plumbing (replace/augment with your own failure-path tests)", () => {
  it("parses the eval contract arguments", () => {
    const args = parseArgs([
      "--goal",
      "Find a flight",
      "--seed",
      "7",
      "--auto-confirm",
      "--output",
      "r.json",
      "--trace",
      "t.jsonl",
    ]);
    expect(args).toMatchObject({ goal: "Find a flight", seed: "7", autoConfirm: true });
  });

  it("rejects a structurally invalid result", () => {
    expect(validateResult({ status: "nope" }).length).toBeGreaterThan(0);
    expect(
      validateResult({ status: "success", answer: "x", bookings: [], steps: 1, cost: 2, errors: [] }),
    ).toEqual([]);
  });

  it("writes files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trip-"));
    await writeJson(path.join(dir, "r.json"), { ok: true });
    const t = new TraceWriter(path.join(dir, "t.jsonl"), "run-1");
    t.write({ step: 1, action: "search_flights" });
    await t.close();
    expect(JSON.parse(await fs.readFile(path.join(dir, "r.json"), "utf8"))).toEqual({ ok: true });
    expect(await fs.readFile(path.join(dir, "t.jsonl"), "utf8")).toContain("search_flights");
  });
});
