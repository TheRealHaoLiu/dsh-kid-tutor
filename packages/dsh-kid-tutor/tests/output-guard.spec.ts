import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKED_PATTERNS } from "../src/config.ts";
import {
  parseJudgeVerdict,
  runDeterministicStage,
  splitIntoPacingChunks,
} from "../src/output-guard.ts";

describe("runDeterministicStage", () => {
  it("passes ordinary kid-safe text", () => {
    expect(runDeterministicStage("Volcanoes form when magma rises.", DEFAULT_BLOCKED_PATTERNS)).toEqual({
      verdict: "pass",
    });
  });

  it("blocks a shell command shape", () => {
    const result = runDeterministicStage("just run rm -rf / and it'll be fine", DEFAULT_BLOCKED_PATTERNS);
    expect(result.verdict).toBe("block");
  });

  it("blocks a PowerShell destructive shape", () => {
    const result = runDeterministicStage("Remove-Item -Recurse -Force C:\\", DEFAULT_BLOCKED_PATTERNS);
    expect(result.verdict).toBe("block");
  });

  it("blocks a phone-number shape", () => {
    const result = runDeterministicStage("call me at 555-123-4567", DEFAULT_BLOCKED_PATTERNS);
    expect(result.verdict).toBe("block");
  });

  it("blocks basic profanity even with repeated letters", () => {
    const result = runDeterministicStage("that is such shiiit to deal with", DEFAULT_BLOCKED_PATTERNS);
    expect(result.verdict).toBe("block");
  });

  it("tolerates a malformed configured pattern instead of throwing", () => {
    const patterns = ["(unclosed", "\\bshould-still-check\\b"];
    expect(() => runDeterministicStage("nothing to see here", patterns)).not.toThrow();
    expect(runDeterministicStage("should-still-check this", patterns).verdict).toBe("block");
  });
});

describe("parseJudgeVerdict", () => {
  it("parses a clean JSON object, defaulting category/severity when absent", () => {
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"fine"}')).toEqual({
      verdict: "pass",
      reason: "fine",
      category: "none",
      severity: 0,
    });
  });

  it("parses JSON embedded in surrounding prose", () => {
    expect(
      parseJudgeVerdict('Sure, here it is: {"verdict":"redo","reason":"gives the answer away"} thanks'),
    ).toEqual({ verdict: "redo", reason: "gives the answer away", category: "none", severity: 0 });
  });

  it("defaults a missing reason to an empty string", () => {
    expect(parseJudgeVerdict('{"verdict":"block"}')).toEqual({
      verdict: "block",
      reason: "",
      category: "none",
      severity: 0,
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseJudgeVerdict("not json at all")).toBeUndefined();
  });

  it("returns undefined for a JSON object with an unknown verdict", () => {
    expect(parseJudgeVerdict('{"verdict":"maybe","reason":"?"}')).toBeUndefined();
  });

  it("returns undefined for JSON that isn't an object", () => {
    expect(parseJudgeVerdict('"just a string"')).toBeUndefined();
  });

  it("parses a valid category and severity", () => {
    expect(
      parseJudgeVerdict('{"verdict":"block","reason":"unsafe","category":"violence","severity":2}'),
    ).toEqual({ verdict: "block", reason: "unsafe", category: "violence", severity: 2 });
  });

  it("falls back to category none for an unrecognized category string", () => {
    const parsed = parseJudgeVerdict('{"verdict":"pass","reason":"ok","category":"not-a-real-one","severity":1}');
    expect(parsed?.category).toBe("none");
  });

  it("clamps an out-of-range severity into 0-2", () => {
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"ok","severity":99}')?.severity).toBe(2);
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"ok","severity":-5}')?.severity).toBe(0);
  });

  it("treats a non-integer severity as 0", () => {
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"ok","severity":1.5}')?.severity).toBe(0);
  });
});

describe("splitIntoPacingChunks", () => {
  it("reconstructs the original text exactly when concatenated", () => {
    const text = "Great question, TestKid! Volcanoes are like Earth's pressure valves.";
    expect(splitIntoPacingChunks(text).join("")).toBe(text);
  });

  it("splits into word-plus-trailing-whitespace pieces", () => {
    expect(splitIntoPacingChunks("Hello world")).toEqual(["Hello ", "world"]);
  });

  it("handles leading whitespace without losing it", () => {
    const text = "  leading space";
    expect(splitIntoPacingChunks(text).join("")).toBe(text);
  });

  it("returns an empty array for an empty string", () => {
    expect(splitIntoPacingChunks("")).toEqual([]);
  });

  it("handles multi-line text", () => {
    const text = "Line one.\nLine two.";
    expect(splitIntoPacingChunks(text).join("")).toBe(text);
  });
});
