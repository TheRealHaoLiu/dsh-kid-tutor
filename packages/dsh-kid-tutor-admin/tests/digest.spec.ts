import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/digest.ts";

describe("buildDigest", () => {
  it("is deterministic and includes every section with counts", () => {
    const input = {
      since: "24h",
      timezone: "UTC",
      sessions: [
        {
          id: "s1",
          started: 1_000,
          lastActivity: 2_000,
          turnCount: 3,
          firstUserMessagePreview: "how do volcanoes work?",
        },
      ],
      guardEvents: [
        {
          sessionId: "s1",
          seq: 4,
          time: 1_500,
          turn: 1,
          step: 1,
          stage: "judge" as const,
          verdict: "block" as const,
          reason: "reveals final answer",
        },
      ],
      deniedTools: [
        {
          sessionId: "s1",
          seq: 5,
          time: 1_600,
          turn: 1,
          step: 1,
          tool: "web_fetch",
          reason: "not on allowlist",
          url: "http://evil.example",
        },
      ],
      quotaEvents: [
        {
          sessionId: "s1",
          seq: 6,
          time: 1_700,
          turn: 1,
          kind: "turn" as const,
          used: 60,
          limit: 60,
        },
      ],
      pythonRuns: [
        {
          sessionId: "s1",
          seq: 7,
          time: 1_800,
          turn: 1,
          step: 1,
          file: "main.py",
          exitCode: 0,
          durationMs: 120,
          truncated: false,
        },
      ],
      stats: [
        {
          day: "2026-09-14",
          sessions: 1,
          turns: 3,
          guardFires: 1,
          toolDenials: 1,
          quotaHits: 1,
          pythonRuns: 1,
        },
      ],
    };

    const a = buildDigest(input);
    const b = buildDigest(input);
    expect(a).toBe(b); // deterministic — no model call, no nondeterministic ordering

    expect(a).toContain("Sessions: 1");
    expect(a).toContain("how do volcanoes work?");
    expect(a).toContain("Guard fires (non-pass): 1");
    expect(a).toContain("reveals final answer");
    expect(a).toContain("Denied tool calls: 1");
    expect(a).toContain("web_fetch");
    expect(a).toContain("Quota hits: 1");
    expect(a).toContain("Python runs: 1");
    expect(a).toContain("main.py");
    expect(a).toContain("2026-09-14: 1 sessions, 3 turns");
  });

  it("reports zero counts plainly when there is no activity", () => {
    const text = buildDigest({
      since: "24h",
      timezone: "UTC",
      sessions: [],
      guardEvents: [],
      deniedTools: [],
      quotaEvents: [],
      pythonRuns: [],
      stats: [],
    });
    expect(text).toContain("Sessions: 0");
    expect(text).toContain("Guard fires (non-pass): 0");
    expect(text).toContain("Denied tool calls: 0");
    expect(text).toContain("Quota hits: 0");
    expect(text).toContain("Python runs: 0");
  });
});
