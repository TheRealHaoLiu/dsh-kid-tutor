import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/brevity.ts";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";

async function dispatchAgentRequest(
  ctx: Context,
  proposed: LlmCallConfig,
): Promise<LlmCallConfig> {
  const payload = { agent: undefined, turn: 1, step: 1, signal: new AbortController().signal };
  const waterfall = ctx.waterfall.bind(ctx) as (...args: unknown[]) => Promise<LlmCallConfig>;
  return waterfall("agent/request", payload, async () => proposed);
}

describe("brevity", () => {
  it("caps maxTokens down to the configured default when unset", async () => {
    const ctx = new Context();
    apply(ctx, {});
    const result = await dispatchAgentRequest(ctx, { provider: "p", model: "m" });
    expect(result.maxTokens).toBe(350);
  });

  it("caps maxTokens down to a configured value", async () => {
    const ctx = new Context();
    apply(ctx, { maxOutputTokens: 100 });
    const result = await dispatchAgentRequest(ctx, { provider: "p", model: "m" });
    expect(result.maxTokens).toBe(100);
  });

  it("never raises an already-tighter maxTokens", async () => {
    const ctx = new Context();
    apply(ctx, { maxOutputTokens: 350 });
    const result = await dispatchAgentRequest(ctx, { provider: "p", model: "m", maxTokens: 50 });
    expect(result.maxTokens).toBe(50);
  });

  it("lowers a looser existing maxTokens to the cap", async () => {
    const ctx = new Context();
    apply(ctx, { maxOutputTokens: 200 });
    const result = await dispatchAgentRequest(ctx, { provider: "p", model: "m", maxTokens: 5000 });
    expect(result.maxTokens).toBe(200);
  });

  it("preserves other LlmCallConfig fields", async () => {
    const ctx = new Context();
    apply(ctx, {});
    const result = await dispatchAgentRequest(ctx, { provider: "p", model: "m", temperature: 0.7, stop: ["END"] });
    expect(result.provider).toBe("p");
    expect(result.model).toBe("m");
    expect(result.temperature).toBe(0.7);
    expect(result.stop).toEqual(["END"]);
  });
});
