import { describe, expect, it } from "vitest";
import { sanitizeSessionRequestBody } from "../src/kid-ui.ts";

describe("sanitizeSessionRequestBody", () => {
  it("keeps a well-formed sessionId", () => {
    expect(sanitizeSessionRequestBody({ sessionId: "abc-123" })).toEqual({ sessionId: "abc-123" });
  });

  it("drops every other field a client might send, including workspace/preset overrides", () => {
    expect(
      sanitizeSessionRequestBody({
        sessionId: "abc-123",
        cwd: "/etc",
        workspaceId: "attacker-workspace",
        agentPreset: "standard",
      }),
    ).toEqual({ sessionId: "abc-123" });
  });

  it("rejects an override with no sessionId to a bare workspace/preset payload", () => {
    expect(sanitizeSessionRequestBody({ cwd: "/etc", agentPreset: "standard" })).toEqual({});
  });

  it("ignores a blank or non-string sessionId", () => {
    expect(sanitizeSessionRequestBody({ sessionId: "   " })).toEqual({});
    expect(sanitizeSessionRequestBody({ sessionId: 42 })).toEqual({});
  });

  it("is total over non-object bodies", () => {
    expect(sanitizeSessionRequestBody(null)).toEqual({});
    expect(sanitizeSessionRequestBody(undefined)).toEqual({});
    expect(sanitizeSessionRequestBody("not an object")).toEqual({});
    expect(sanitizeSessionRequestBody([])).toEqual({});
  });
});
