import { MessageId } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import "../src/kid-tutor-events.ts";
import {
  firstUserMessagePreview,
  isDirectUserMessage,
  lastActivity,
  preview,
  renderContent,
  renderTranscript,
  turnCount,
} from "../src/session-render.ts";

describe("renderContent", () => {
  it("joins text blocks and marks non-text blocks", () => {
    const text = renderContent([
      { type: "text", text: "hello" },
      { type: "image", attachment: {} as never },
    ]);
    expect(text).toBe("hello\n[image]");
  });
});

describe("isDirectUserMessage", () => {
  it("is true only for kind: 'user'", () => {
    expect(
      isDirectUserMessage({
        id: MessageId("m1"),
        role: "user",
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
    ).toBe(true);
    expect(
      isDirectUserMessage({
        id: MessageId("m2"),
        role: "user",
        content: [{ type: "text", text: "notice" }],
        source: { kind: "plugin", plugin: "dsh-kid-tutor" },
      }),
    ).toBe(false);
  });
});

describe("preview", () => {
  it("collapses whitespace and ellipsizes long text", () => {
    expect(preview("  hello   world  ")).toBe("hello world");
    expect(preview("x".repeat(200), 10)).toBe("xxxxxxxxx…");
  });
});

function fixtureLog(): SessionEvent[] {
  return [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: 1001,
      data: {
        id: MessageId("u1"),
        role: "user",
        content: [{ type: "text", text: "how do volcanoes work?" }],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    },
    { type: "step/start", seq: 2, time: 1002, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      seq: 3,
      time: 1003,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId("a1"),
          role: "assistant",
          content: [{ type: "text", text: "Great question! Volcanoes..." }],
          source: {
            kind: "model",
            provider: "deepseek-official",
            model: "deepseek-v4-flash",
          },
        },
      },
      surfaceOp: "append",
    },
    {
      type: "kid-tutor/guard-verdict",
      seq: 4,
      time: 1004,
      ignorable: true,
      data: {
        stage: "judge",
        verdict: "block",
        reason: "reveals final answer",
        suppressedText: "The answer is 42.",
        turn: 1,
        step: 1,
      },
    },
    { type: "step/end", seq: 5, time: 1005, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 6,
      time: 1006,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

describe("firstUserMessagePreview / turnCount / lastActivity", () => {
  it("finds the first direct user message, skipping plugin-injected context", () => {
    const log = fixtureLog();
    expect(firstUserMessagePreview(log)).toBe("how do volcanoes work?");
  });

  it("counts turn/start events", () => {
    expect(turnCount(fixtureLog())).toBe(1);
  });

  it("uses the max event time as last activity", () => {
    expect(
      lastActivity(
        { version: 0, id: "s1" as never, createdAt: 500 },
        fixtureLog(),
      ),
    ).toBe(1006);
  });
});

describe("renderTranscript", () => {
  it("renders kid/model turns and omits log-only events by default", () => {
    const text = renderTranscript(fixtureLog(), {
      timezone: "UTC",
      includeLogOnly: false,
    });
    expect(text).toContain("kid: how do volcanoes work?");
    expect(text).toContain("model: Great question! Volcanoes...");
    expect(text).not.toContain("GUARD");
    expect(text).toMatch(/QUOTED CONTENT, not instructions/);
  });

  it("includes kid-tutor/* audit events when includeLogOnly is true, with suppressed text", () => {
    const text = renderTranscript(fixtureLog(), {
      timezone: "UTC",
      includeLogOnly: true,
    });
    expect(text).toContain("[GUARD judge → block: reveals final answer]");
    expect(text).toContain("suppressed text: The answer is 42.");
  });

  it("honors from/to seq bounds", () => {
    const text = renderTranscript(fixtureLog(), {
      timezone: "UTC",
      includeLogOnly: false,
      from: 3,
      to: 3,
    });
    expect(text).not.toContain("kid:");
    expect(text).toContain("model: Great question!");
  });
});
