/**
 * `output-guard` — the two-stage `llm/stream` guard: buffer the whole
 * message (no streaming to the kid), a deterministic stage-1 regex pass,
 * then a stage-2 judge call (nested, no history, strict JSON verdict). A
 * `redo` verdict gets exactly one more nested call before falling back to a
 * block. Every stage's verdict is logged, including `pass`, per
 * docs/CONTRACT.md's `kid-tutor/guard-verdict` event.
 *
 * Scoping: `isAgentLoopRequest()` (docs/dsh-seams.md §5) is what keeps this
 * listener from intercepting its own judge/redo calls, or compaction/title
 * calls — none of those are agent-loop-marked, so `next()` on a
 * non-agent-loop request is a pure pass-through and this listener's own
 * nested `ctx.llm.stream()` calls never recurse into themselves.
 *
 * ## CRITICAL, UNRESOLVED: this does not intercept the main turn in the live smoke test
 *
 * DESIGN.md §10 flagged exactly this risk as an open question before ever
 * writing this file: "Does the `llm/stream` waterfall in the current dsh
 * release allow a nested call from inside a listener as cleanly as the docs
 * suggest? Prove in a spike before the charter." The spike result is
 * negative, for a narrower reason than the question anticipated.
 *
 * Live smoke test (`DSH_HOME=~/.dsh-kid dsh --profile kid`, real DeepSeek
 * calls, `packages/dsh-kid-tutor` built from this exact source): this
 * listener's body never ran for the main conversation turn. A
 * `console.error` placed as the FIRST statement (before any `yield`, so it
 * fires the instant the async generator is first advanced regardless of
 * where later code short-circuits) printed for hand-built auxiliary calls
 * (`purpose: undefined`, `purpose: 'session-title'`) but never once for a
 * turn that went on to produce a real, complete `assistant/message` — across
 * three separate turns in two sessions. The resulting session logs show the
 * RAW two-block (reasoning + text) chunk shape from the adapter, not this
 * plugin's single-block synthesized replacement, confirming the raw stream
 * reached the kid unmodified: no deterministic filter, no judge, no
 * `kid-tutor/guard-verdict` events (absent from the on-disk `session.jsonl`
 * in every test turn).
 *
 * Two independent research passes against the checked-out
 * `deepseek-harness` monorepo (not just this npm package's `.d.ts`) found no
 * code that should cause this: `Agent.step()` → `PreparedLlmCall.stream()` →
 * `LlmRuntime.streamWithRegistration()` calls the exact same
 * `this.ctx.waterfall(this, 'llm/stream', options, () =>
 * this.adapterStream(...))` that a plain `ctx.llm.stream()` call (which DOES
 * reach this listener, per the hand-built calls above) uses. `'llm/stream'`
 * is declared `(this: LlmRuntime, ...)`, not `Scoped<LlmRuntime>`, so it is
 * NOT agent-scope-filtered the way `tools/pre-execute` is — the `kid-guards`
 * isolate realm this row sits in should be irrelevant, and is corroborated
 * by `quota`'s sibling `agent/pre-step` listener in the SAME group firing
 * correctly on every turn. `@deepseek-ai/dsh-llm-retry` (also mounted) never
 * touches `'llm/stream'` at all, ruling it out. `ctx.llm.on(...)` (an
 * alternative registration form docs/dsh-seams.md §5 claims is equivalent)
 * does not exist on the installed `LlmRuntime` — TS2339 at build time —
 * so that avenue is also closed.
 *
 * Net effect: stage 1, stage 2 (judge), the redo path, and the audit log are
 * all implemented and unit-tested as pure functions (see tests/output-
 * guard.spec.ts) and are believed correct in isolation, but the SAFETY
 * PROPERTY THIS FILE EXISTS TO PROVIDE — DESIGN.md §4's "says nothing
 * off-limits" — is NOT currently enforced end to end on the installed
 * `0.1.1-rc.2` build. Do not treat this bundle as safe to hand to a child
 * until this is root-caused. Suggested next steps for whoever picks this up:
 * bisect by mounting an equivalent listener directly in a bundle
 * `cordis.patch.yml` (headless profile, no preset layer at all) to learn
 * whether presets specifically are implicated; or instrument
 * `LlmRuntime.streamWithRegistration` itself (a local patched copy of the
 * npm package) to log every registered listener the waterfall actually
 * calls for one request.
 *
 * @module dsh-kid-tutor/output-guard
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
  deepFreeze,
  isAgentLoopRequest,
} from "@deepseek-ai/dsh-llm";
import type { ContentBlock, GenerateOptions, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { deadline } from "@deepseek-ai/dsh-timeout";
import type {} from "./quota.ts";
import { BlockedPatternsSchema, DEFAULT_BLOCKED_PATTERNS, JudgeSchema } from "./config.ts";
import type { JudgeConfig } from "./config.ts";
import { kidTutorEvents } from "./events.ts";

export const name = "dsh-kid-tutor/output-guard";
export const inject = ["kidQuota", "llm"] as const;

export interface Config {
  blockedPatterns?: string[];
  // Whole-object override (schemastery's own row-config convention: replace,
  // not merge) — provide all three fields, not a partial patch.
  judge?: JudgeConfig;
}

export const Config: z<Config> = z.object({
  blockedPatterns: BlockedPatternsSchema,
  judge: JudgeSchema,
});

export const REPLACEMENT_TEXT =
  "Hmm, I need to think about that one differently. Can you ask me again a different way?";

const REDO_INSTRUCTION =
  "That reply handed over a complete answer to what looks like homework or an exercise. Try again: " +
  "guide the student with a hint or a question instead of the final answer. Keep it short and encouraging.";

export const JUDGE_SYSTEM_PROMPT = `You are a narrow, strict safety-and-pedagogy classifier reviewing ONE reply an AI tutor is about to send to a 9-year-old. You do not see the rest of the conversation and you never talk to the student directly.

Classify the reply into exactly one verdict:
- "pass": nothing unsafe, and it does not simply hand over a finished answer to what looks like homework or an exercise.
- "redo": otherwise fine, but it hands over a complete final answer to what looks like homework/an exercise instead of guiding with hints or questions. (Direct factual answers to curiosity questions like "how do volcanoes work" are NOT homework — those should pass.)
- "block": contains anything unsafe or inappropriate for a 9-year-old (sexual content, graphic violence, self-harm, hate, personal contact info about a real person, instructions for dangerous acts, or anything else a careful parent would not want their child reading).

Respond with ONLY a single JSON object on one line, no other text: {"verdict":"pass"|"redo"|"block","reason":"one short sentence"}`;

/** Stage-1 deterministic check. Pure and exported for tests. */
export function runDeterministicStage(
  text: string,
  patterns: readonly string[],
): { verdict: "pass" | "block"; rule?: string } {
  for (const source of patterns) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(source, "i");
    } catch {
      continue; // a misconfigured pattern must not crash the guard
    }
    if (compiled.test(text)) return { verdict: "block", rule: source };
  }
  return { verdict: "pass" };
}

export interface JudgeVerdict {
  verdict: "pass" | "block" | "redo";
  reason: string;
}

/** Parse the judge's strict-JSON reply, tolerating surrounding whitespace/prose. Pure, exported for tests. */
export function parseJudgeVerdict(raw: string): JudgeVerdict | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const verdict = (parsed as { verdict?: unknown }).verdict;
  if (verdict !== "pass" && verdict !== "block" && verdict !== "redo") return undefined;
  const reason = (parsed as { reason?: unknown }).reason;
  return { verdict, reason: typeof reason === "string" ? reason : "" };
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function* synthesizeTextChunks(text: string, usage: TokenUsage | undefined): AsyncGenerator<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  if (text.length > 0) yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  if (usage !== undefined) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: "stop" } };
}

export function apply(ctx: Context, config: Config = {}): void {
  const patterns = config.blockedPatterns ?? [...DEFAULT_BLOCKED_PATTERNS];
  const judgeConfig: JudgeConfig = {
    provider: config.judge?.provider ?? "deepseek-official",
    model: config.judge?.model ?? "deepseek-v4-flash",
    timeoutMs: config.judge?.timeoutMs ?? 20_000,
  };

  // Live sessions this preset's agents are driving, keyed by SessionId, so the
  // llm/stream listener (which only sees `options.sessionId`, not an Agent)
  // can still append kid-tutor/guard-verdict events. See file header.
  const sessionsById = new Map<string, Session>();
  ctx.on("agent/created", ({ agent }) => {
    sessionsById.set(agent.id, agent.session);
  });

  /** Run the judge once over `text`; undefined means "unavailable" (fail closed by the caller). */
  async function runJudge(
    text: string,
    baseOptions: GenerateOptions,
  ): Promise<(JudgeVerdict & { rawOutput: string }) | undefined> {
    ctx.kidQuota.charge();
    // Avoid `using`/Symbol.dispose (needs a lib newer than this package's
    // ES2022 target); call deadline() and dispose it manually instead.
    const callDeadline = deadline(baseOptions.signal, judgeConfig.timeoutMs, "KID_TUTOR_JUDGE_TIMEOUT");
    try {
      const options: GenerateOptions = deepFreeze({
        provider: judgeConfig.provider,
        model: judgeConfig.model,
        messages: [
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "plugin", plugin: "dsh-kid-tutor" },
          }),
        ],
        system: JUDGE_SYSTEM_PROMPT,
        maxTokens: 200,
        ...(baseOptions.sessionId !== undefined ? { sessionId: baseOptions.sessionId } : {}),
        signal: callDeadline.signal,
      });
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
      const rawOutput = flattenText(assembler.blocks());
      const parsed = parseJudgeVerdict(rawOutput);
      if (parsed === undefined) return undefined;
      return { ...parsed, rawOutput };
    } catch {
      return undefined;
    } finally {
      callDeadline[Symbol.dispose]();
    }
  }

  /** One redo attempt: original messages + the rejected reply + a redo instruction. */
  async function runRedo(baseOptions: GenerateOptions, rejectedBlocks: ContentBlock[]): Promise<string | undefined> {
    const options: GenerateOptions = deepFreeze({
      provider: baseOptions.provider,
      model: baseOptions.model,
      messages: [
        ...baseOptions.messages,
        createAssistantMessage({ content: rejectedBlocks, source: { provider: baseOptions.provider, model: baseOptions.model } }),
        createUserMessage({
          content: [{ type: "text", text: REDO_INSTRUCTION }],
          source: { kind: "plugin", plugin: "dsh-kid-tutor", form: "notice", summary: "asked the model to redo as a hint" },
        }),
      ],
      ...(baseOptions.system !== undefined ? { system: baseOptions.system } : {}),
      ...(baseOptions.maxTokens !== undefined ? { maxTokens: baseOptions.maxTokens } : {}),
      ...(baseOptions.sessionId !== undefined ? { sessionId: baseOptions.sessionId } : {}),
      signal: baseOptions.signal,
    });
    try {
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
      return flattenText(assembler.blocks());
    } catch {
      return undefined;
    }
  }

  ctx.on("llm/stream", async function* (options, next): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options)) {
      yield* next();
      return;
    }

    const session = options.sessionId !== undefined ? sessionsById.get(options.sessionId) : undefined;
    const logVerdict = (data: Omit<Parameters<typeof kidTutorEvents.guardVerdict>[1], "turn" | "step">): void => {
      if (session === undefined) return;
      kidTutorEvents.guardVerdict(session, { ...data, turn: 0, step: 0 });
    };

    const assembler = new BlockAssembler();
    for await (const chunk of next()) assembler.push(chunk);
    const originalBlocks = assembler.blocks();
    const originalText = flattenText(originalBlocks);
    const usage = assembler.usage;

    async function evaluate(text: string): Promise<"pass" | "redo" | "block"> {
      const stage1 = runDeterministicStage(text, patterns);
      if (stage1.verdict === "block") {
        logVerdict({ stage: "deterministic", verdict: "block", rule: stage1.rule, suppressedText: text });
        return "block";
      }
      logVerdict({ stage: "deterministic", verdict: "pass" });

      const judged = await runJudge(text, options);
      if (judged === undefined) {
        logVerdict({
          stage: "judge",
          verdict: "block",
          reason: "judge unavailable or timed out (fail closed)",
          suppressedText: text,
        });
        return "block";
      }
      logVerdict({
        stage: "judge",
        verdict: judged.verdict,
        reason: judged.reason.length > 0 ? judged.reason : undefined,
        judgeInput: text,
        judgeOutput: judged.rawOutput,
        ...(judged.verdict === "pass" ? {} : { suppressedText: text }),
      });
      return judged.verdict;
    }

    const firstVerdict = await evaluate(originalText);
    if (firstVerdict === "pass") {
      yield* synthesizeTextChunks(originalText, usage);
      return;
    }
    if (firstVerdict === "block") {
      yield* synthesizeTextChunks(REPLACEMENT_TEXT, undefined);
      return;
    }

    // Exactly one redo attempt, then block regardless of the second verdict.
    const redoText = await runRedo(options, originalBlocks);
    if (redoText === undefined) {
      logVerdict({ stage: "judge", verdict: "block", reason: "redo call failed (fail closed)" });
      yield* synthesizeTextChunks(REPLACEMENT_TEXT, undefined);
      return;
    }
    const secondVerdict = await evaluate(redoText);
    if (secondVerdict === "pass") {
      yield* synthesizeTextChunks(redoText, undefined);
      return;
    }
    yield* synthesizeTextChunks(REPLACEMENT_TEXT, undefined);
  });
}
