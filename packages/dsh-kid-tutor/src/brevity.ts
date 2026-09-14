/**
 * `brevity` — hard-caps output length for the main agent turn via
 * `agent/request` (docs/dsh-seams.md §5/§6 neighbor seam;
 * `packages/core/agent/src/runtime-types.ts`: `'agent/request'(this:
 * Scoped<Agent>, payload: { agent, turn, step, signal }, next: () =>
 * Promise<LlmCallConfig>): Promise<LlmCallConfig>`). This is a DIFFERENT
 * waterfall from `llm/stream`: it fires only while `Agent.buildRequest()`
 * resolves the call configuration for a real turn (main or subagent — this
 * preset mounts no subagent tools, so in practice only the main turn), never
 * for output-guard's hand-built judge/redo calls, which construct their
 * `GenerateOptions` directly and never touch `Agent`'s own request-config
 * pipeline at all. So no `isAgentLoopRequest`-style guard is needed here.
 *
 * `Scoped<Agent>`: this row can sit anywhere in the preset (no realm needed
 * — it registers no service), exactly like `tool-policy`/`workspace-fence`.
 *
 * This is a soft cap (`Math.min` against whatever the loop already proposed)
 * so it can only shrink an output budget, never grow past a tighter limit
 * set elsewhere (a future escalation feature, say).
 *
 * @module dsh-kid-tutor/brevity
 */

import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent";
import { BrevitySchema } from "./config.ts";
import type { BrevityConfig } from "./config.ts";

export const name = "dsh-kid-tutor/brevity";
export const inject = [] as const;

export type Config = BrevityConfig;

export const Config: z<Config> = BrevitySchema;

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const maxOutputTokens = config.maxOutputTokens ?? 350;

  ctx.on("agent/request", async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next();
    const cap = resolved.maxTokens !== undefined ? Math.min(resolved.maxTokens, maxOutputTokens) : maxOutputTokens;
    return { ...resolved, maxTokens: cap };
  });
}
