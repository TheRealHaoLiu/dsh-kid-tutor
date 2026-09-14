import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKED_PATTERNS } from "../src/config.ts";
import { parseJudgeVerdict, runDeterministicStage } from "../src/output-guard.ts";

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
  it("parses a clean JSON object", () => {
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"fine"}')).toEqual({
      verdict: "pass",
      reason: "fine",
    });
  });

  it("parses JSON embedded in surrounding prose", () => {
    expect(parseJudgeVerdict('Sure, here it is: {"verdict":"redo","reason":"gives the answer away"} thanks')).toEqual(
      { verdict: "redo", reason: "gives the answer away" },
    );
  });

  it("defaults a missing reason to an empty string", () => {
    expect(parseJudgeVerdict('{"verdict":"block"}')).toEqual({ verdict: "block", reason: "" });
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
});
