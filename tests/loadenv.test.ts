import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { loadDotEnv } from "../src/loadenv";

const NAMES = ["LOADENV_A", "LOADENV_B", "LOADENV_QUOTED", "LOADENV_SINGLE", "LOADENV_EXPORTED", "LOADENV_KEPT"];
afterEach(() => { for (const n of NAMES) delete process.env[n]; });

async function envFile(text: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "env-"));
  const file = path.join(dir, ".env");
  await fs.writeFile(file, text);
  return file;
}

describe("loading .env without a Node flag", () => {
  it("reads plain, quoted and exported lines, and skips comments and blank lines (CRLF too)", async () => {
    const file = await envFile('# a comment\r\n\r\nLOADENV_A=one\r\nLOADENV_B = two words \r\nLOADENV_QUOTED="in double"\r\nLOADENV_SINGLE=\'in single\'\r\nexport LOADENV_EXPORTED=out\r\nnot a line\r\n=novalue\r\n');
    loadDotEnv(file);
    expect(process.env.LOADENV_A).toBe("one");
    expect(process.env.LOADENV_B).toBe("two words");
    expect(process.env.LOADENV_QUOTED).toBe("in double");
    expect(process.env.LOADENV_SINGLE).toBe("in single");
    expect(process.env.LOADENV_EXPORTED).toBe("out");
  });

  it("never overrides a variable that is already set: a grader's own environment wins", async () => {
    process.env.LOADENV_KEPT = "from the grader";
    loadDotEnv(await envFile("LOADENV_KEPT=from the file\n"));
    expect(process.env.LOADENV_KEPT).toBe("from the grader");
  });

  it("is fine when there is no .env file at all", () => {
    expect(() => loadDotEnv(path.join(os.tmpdir(), "definitely-not-here", ".env"))).not.toThrow();
  });
});
