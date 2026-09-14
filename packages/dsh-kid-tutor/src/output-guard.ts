/**
 * `output-guard` — the two-stage `llm/stream` guard: buffer the whole
 * message (no streaming to the kid — see "Pacing" below for the release
 * shape once buffering is done), a deterministic stage-1 regex pass, then a
 * stage-2 judge call (nested, no history, strict JSON verdict) that also
 * classifies the exchange for `parent-alert`. A `redo` verdict gets exactly
 * one more nested call before falling back to a block. Every stage's verdict
 * is logged, including `pass`, per docs/CONTRACT.md's `kid-tutor/guard-verdict`
 * event.
 *
 * ## Which dispatches this listener acts on (read this before editing the gate)
 *
 * `isAgentLoopRequest()` (docs/dsh-seams.md §5) LOOKS like the right gate and
 * is NOT usable here — it is what made this guard a silent no-op for the whole
 * first build (docs/GUARD-BISECT.md has the full bisect). It is a lookup in a
 * module-private `WeakSet` inside `@deepseek-ai/dsh-llm`; the agent loop writes
 * the mark through the HARNESS's copy of that package, while this plugin —
 * mounted by absolute path, so Node resolves its bare imports upward from
 * `dist/` — reads a SECOND copy from this repo's own `node_modules`, with its
 * own empty WeakSet. It therefore answered `false` for every request this
 * listener ever saw, including every main turn, and the gate's `yield* next()`
 * passed the model's raw reply straight to the kid.
 *
 * General rule this is an instance of: **no `@deepseek-ai/dsh-*` API whose
 * answer lives in module state (`WeakSet`/`WeakMap`, a module-level `Symbol()`,
 * `instanceof`) works from an out-of-tree plugin loaded by absolute path.**
 * Pure builders (`BlockAssembler`, `createUserMessage`, `deepFreeze`,
 * `deadline`) are unaffected: they only produce plain objects.
 *
 * So the gate below answers the question locally, with three conditions that
 * are exhaustive rather than heuristic because the harness has exactly three
 * `llm/stream` producers:
 *   - the agent loop's turn — `purpose: undefined`
 *     (`packages/core/agent-loop/src/agent.ts:505`) — the one we guard;
 *   - compaction — `purpose: 'compaction'`
 *     (`packages/compaction/compaction-basic/src/summarizer.ts:161`);
 *   - session-title — `purpose: 'session-title'`
 *     (`packages/session/session-title-llm/src/index.ts:259`).
 * plus this listener's OWN nested judge/redo calls, which carry no purpose and
 * reuse the turn's `sessionId`, and are therefore tagged in `ownCalls` — a
 * WeakSet owned by THIS module, so both the write and the read are the same
 * instance and the recursion guard is sound where the imported one was not.
 *
 * ## Two verbatim pass-throughs (both latent bugs until the gate was fixed)
 *
 * This guard replaces the reply stream with a single synthesized `text` block,
 * so it buffers the raw chunks first and re-emits them byte for byte in two
 * cases that re-synthesis would destroy. Neither was observable while the gate
 * above was rejecting every request; both became live the moment it stopped.
 *
 *   - **A step that finished `error` or `aborted`.** That terminal chunk IS the
 *     agent loop's failure channel — it drives `agent/request-error` and the
 *     retry policy. Treating it as an empty reply turns every provider outage
 *     into a calm "ask me a different way" with the real failure diagnosed
 *     nowhere. Note the narrowness: `max-tokens` is also a non-`stop` finish and
 *     deliberately does NOT pass through — see the comment at the check itself.
 *   - **A step whose reply carries `tool-call` blocks.** Re-synthesizing it as
 *     one text block deletes the tool calls and silently breaks `web_fetch` and
 *     `run_python`. Only the final, text-only reply — the one the kid actually
 *     reads — is filtered, judged, and re-synthesized.
 *
 * ## Pacing
 *
 * Once a stage decides what text the kid will see (the original reply, a
 * redo, or a replacement/alert message), it is NOT released as one chunk.
 * `pacedTextChunks()` releases it word by word at `pacing.charsPerSecond`
 * (default 40; 0 disables pacing and releases the whole text as a single
 * `text-delta`, same as before this feature). This paces the FINAL kid-
 * facing text block only — the model's `reasoning` block is still dropped
 * from the re-emitted stream entirely (unchanged prior behavior: this guard
 * only ever reconstructs a single `text` block).
 *
 * ## Parent alert
 *
 * The judge classifies `category`/`severity` for the EXCHANGE (the kid's
 * latest message plus the candidate reply), independent of `verdict`.
 * Whenever `ctx.parentAlert.shouldAlert(severity)` is true, this guard (a)
 * forces the kid-facing outcome to a replacement — even if `verdict` was
 * "pass" — because a topic worth alerting a parent about should never just
 * flow through unremarked, and (b) fires the alert as a DETACHED promise
 * (never awaited inline) so a slow or failing webhook cannot add latency or
 * a failure mode to the kid's own turn; the delivery outcome is logged via
 * `kid-tutor/alert` once it settles. Text shown to the kid depends on
 * `ctx.parentAlert.disclosure`: a warm "grown-up topic, telling your parent"
 * line, or the ordinary redo-prompt replacement, per config.
 *
 * ## History: what the old header claimed, and why it was wrong
 *
 * This file used to carry a long "CRITICAL, UNRESOLVED" note asserting that the
 * listener's body never ran for the main turn, and that the preset plane or
 * scope filtering must be to blame. Both parts were wrong and are recorded here
 * so they are not re-derived:
 *
 *   - The body DID run on every main turn. The earlier trace printed
 *     `purpose: undefined` lines and read them as "hand-built auxiliary calls",
 *     but `GenerateOptions.purpose` is only ever `'compaction' | 'session-title'`
 *     (`packages/llm/llm/src/types.ts:376`), so `purpose: undefined` IS the main
 *     agent-loop turn. What the guard did on those dispatches was take the
 *     `isAgentLoopRequest()` early return described above.
 *   - Scope filtering was never involved. `llm/stream` is absent from
 *     `packages/core/scope/src/scoped-events.generated.ts` (the generated list
 *     of scope-filtered events), and the only filter cordis applies to this
 *     dispatch is `Service[Context.filter]`, which compares the isolate label
 *     for the service name `llm` — nothing isolates `llm`; the `kid-guards`
 *     group isolates `kidQuota` only.
 *
 * DESIGN.md §10 had asked whether a nested `ctx.llm.stream()` from inside an
 * `llm/stream` listener works at all. It does; that was never the failure.
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
  ReasoningEffortId,
} from "@deepseek-ai/dsh-llm";
import type { ContentBlock, GenerateOptions, Message, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { deadline } from "@deepseek-ai/dsh-timeout";
import type {} from "./quota.ts";
import type {} from "./parent-alert.ts";
import {
  BlockedPatternsSchema,
  DEFAULT_BLOCKED_PATTERNS,
  GUARD_CATEGORIES,
  JudgeSchema,
  PacingSchema,
} from "./config.ts";
import type { GuardCategory, JudgeConfig, PacingConfig } from "./config.ts";
import { kidTutorEvents } from "./events.ts";

export const name = "dsh-kid-tutor/output-guard";
export const inject = ["kidQuota", "parentAlert", "llm"] as const;

export interface Config {
  blockedPatterns?: string[];
  // Whole-object override (schemastery's own row-config convention: replace,
  // not merge) — provide all three fields, not a partial patch.
  judge?: JudgeConfig;
  pacing?: PacingConfig;
  /**
   * Print one stderr line per `llm/stream` dispatch showing the gate's inputs
   * and decision. Off by default; the only supported way to see whether this
   * listener is reached and what it decided, without patching the file.
   */
  debug?: boolean;
}

export const Config: z<Config> = z.object({
  blockedPatterns: BlockedPatternsSchema,
  judge: JudgeSchema,
  pacing: PacingSchema,
  debug: z.boolean().default(false),
});

export const REPLACEMENT_TEXT =
  "Hmm, I need to think about that one differently. Can you ask me again a different way?";

export const ALERT_DISCLOSURE_TEXT =
  "That sounds like a grown-up topic, so I'm letting your parent know we talked about it — you two can chat about it together. Is there something else I can help with?";

const REDO_INSTRUCTION =
  "That reply isn't quite right for the student yet — either it handed over a complete answer to what looks like " +
  "homework/an exercise instead of guiding, or it was too long and dense for a 9-year-old. Try again: keep it to a " +
  "few short sentences, one idea at a time, guide with a hint or a question instead of the final answer when it's " +
  "homework, and end with a short question back to the student.";

export const JUDGE_SYSTEM_PROMPT = `You are a narrow, strict safety-and-pedagogy classifier reviewing one exchange between a 9-year-old student and an AI tutor: the STUDENT's latest message and the TUTOR's candidate reply to it. You do not see the rest of the conversation and you never talk to the student directly.

Classify the TUTOR's reply into exactly one verdict:
- "pass": nothing unsafe, doesn't hand over a finished homework/exercise answer, and is short and simple enough for a 9-year-old (a few short sentences, not a wall of text or a long bullet list).
- "redo": otherwise fine, but needs a rewrite because it EITHER (a) hands over a complete final answer to what looks like homework or an exercise instead of guiding with hints or questions, OR (b) is too long, dense, or bullet-heavy for a 9-year-old. A direct factual answer to a curiosity question ("how do volcanoes work") is NOT homework and should pass on that ground alone, but can still get "redo" purely for length.
- "block": the STUDENT's message or the TUTOR's reply contains anything unsafe or inappropriate for a 9-year-old (sexual content, graphic violence, self-harm, hate, personal contact info about a real person, instructions for dangerous acts, or anything else a careful parent would not want their child reading).

SEPARATELY, regardless of verdict, classify whether the STUDENT's message touches a topic a parent would want to know about:
- "category": the single best-fitting one of none, sexual, violence, self_harm, drugs, personal_info, stranger_contact, hate, other_adult — "none" if nothing applies.
- "severity": 0 (nothing notable), 1 (a passing mention worth a quiet log entry only), 2 (a parent should be told now — a real safety concern, a direct or repeated request, or explicit content).

Respond with ONLY a single JSON object on one line, no other text: {"verdict":"pass"|"redo"|"block","reason":"one short sentence","category":"none"|"sexual"|"violence"|"self_harm"|"drugs"|"personal_info"|"stranger_contact"|"hate"|"other_adult","severity":0|1|2}`;

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
  category: GuardCategory;
  severity: number;
}

const GUARD_CATEGORY_SET: ReadonlySet<string> = new Set(GUARD_CATEGORIES);

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
  const rawCategory = (parsed as { category?: unknown }).category;
  const category: GuardCategory = typeof rawCategory === "string" && GUARD_CATEGORY_SET.has(rawCategory)
    ? (rawCategory as GuardCategory)
    : "none";
  const rawSeverity = (parsed as { severity?: unknown }).severity;
  const severity = typeof rawSeverity === "number" && Number.isInteger(rawSeverity)
    ? Math.min(2, Math.max(0, rawSeverity))
    : 0;
  return { verdict, reason: typeof reason === "string" ? reason : "", category, severity };
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The kid's most recent ACTUAL message text (not a plugin-injected runtime-
 * context/instructions snapshot), for the judge's exchange context and the
 * `parent-alert` excerpt.
 *
 * `role === 'user'` alone is not enough: dynamic `ctx.systemPrompt.context()`
 * snapshots (docs/dsh-seams.md §2 — "rendered as a durable user-role
 * snapshot") also carry `role: 'user'` and are appended to the message list,
 * sometimes AFTER the kid's own turn. Confirmed live: without the
 * `source.kind === 'user'` filter, a "Current runtime context..." sandbox-
 * policy snapshot was picked up instead of the kid's real message, both in
 * the judge's classification input and in a delivered `kid-tutor/alert`
 * excerpt. Only `MessageSourceMap.user` (`{ kind: 'user' }`,
 * `packages/llm/llm/src/message.ts`) is the kid's own typed text.
 */
function latestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user" && message.source.kind === "user") return flattenText(message.content);
  }
  return "";
}

/** Split text into word-plus-trailing-whitespace pieces whose concatenation reproduces it exactly. */
export function splitIntoPacingChunks(text: string): string[] {
  const pieces = text.match(/\S+\s*|^\s+/g);
  return pieces ?? (text.length > 0 ? [text] : []);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Release `text` as a single `text` block, paced word by word at
 * `charsPerSecond` (0 = release the whole text in one `text-delta`, the
 * pre-pacing behavior). Stops pacing early (but still closes the block) if
 * `signal` aborts mid-release.
 */
async function* pacedTextChunks(
  text: string,
  usage: TokenUsage | undefined,
  charsPerSecond: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  if (text.length === 0) {
    // nothing to release
  } else if (charsPerSecond <= 0) {
    yield { type: "text-delta", index: 0, text };
  } else {
    for (const piece of splitIntoPacingChunks(text)) {
      if (signal?.aborted) break;
      yield { type: "text-delta", index: 0, text: piece };
      await sleep((piece.length / charsPerSecond) * 1000, signal);
    }
  }
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  if (usage !== undefined) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * This listener's OWN nested calls (judge, redo), tagged before dispatch so the
 * re-entrant `llm/stream` dispatch they cause is recognised and passed through.
 *
 * Module-local on purpose: the write and the read are the same module instance,
 * which is exactly the property `isAgentLoopRequest()` cannot give an
 * out-of-tree plugin (see the file header). Keyed by request-object identity,
 * which survives the waterfall — cordis passes the same `options` object to
 * every listener — and `deepFreeze()` returns its argument, so freezing does not
 * change the key.
 */
const ownCalls = new WeakSet<GenerateOptions>();

/** Tag one request as this listener's own nested call, then hand it back for dispatch. */
function markOwnCall(options: GenerateOptions): GenerateOptions {
  ownCalls.add(options);
  return options;
}

/** Whether the assembled reply asks to run a tool (such a step is never re-synthesized). */
function hasToolCall(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) => block.type === "tool-call");
}

export function apply(ctx: Context, config: Config = {}): void {
  const patterns = config.blockedPatterns ?? [...DEFAULT_BLOCKED_PATTERNS];
  const judgeConfig: JudgeConfig = {
    provider: config.judge?.provider ?? "deepseek-official",
    model: config.judge?.model ?? "deepseek-flash",
    timeoutMs: config.judge?.timeoutMs ?? 20_000,
  };
  const charsPerSecond = config.pacing?.charsPerSecond ?? 40;
  const debug = config.debug ?? false;
  const trace = (message: string, fields: Record<string, unknown>): void => {
    if (!debug) return;
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    console.error(`[kid-tutor/output-guard] ${message} ${rendered}`);
  };

  // Live sessions this preset's agents are driving, keyed by SessionId, so the
  // llm/stream listener (which only sees `options.sessionId`, not an Agent)
  // can still append kid-tutor/guard-verdict events. See file header.
  const sessionsById = new Map<string, Session>();
  ctx.on("agent/created", ({ agent }) => {
    sessionsById.set(agent.id, agent.session);
  });

  /**
   * Whether this dispatch is a conversation turn this guard owns. See the file
   * header for why the three conditions are exhaustive: our own nested calls
   * are tagged, the harness's two other producers both set `purpose`, and an
   * agent-loop turn always carries the `sessionId` of a session announced to
   * this plugin through `agent/created` (the loop sets `sessionId:
   * this.session.id`, and `agent.id` IS that session id).
   */
  function isGuardedTurn(options: GenerateOptions): boolean {
    if (ownCalls.has(options)) return false;
    if (options.purpose !== undefined) return false;
    if (options.sessionId === undefined) return false;
    return sessionsById.has(options.sessionId);
  }

  /** Run the judge once over one exchange; undefined means "unavailable" (fail closed by the caller). */
  async function runJudge(
    kidMessage: string,
    replyText: string,
    baseOptions: GenerateOptions,
  ): Promise<(JudgeVerdict & { rawOutput: string }) | undefined> {
    ctx.kidQuota.charge();
    // Avoid `using`/Symbol.dispose (needs a lib newer than this package's
    // ES2022 target); call deadline() and dispose it manually instead.
    const callDeadline = deadline(baseOptions.signal, judgeConfig.timeoutMs, "KID_TUTOR_JUDGE_TIMEOUT");
    try {
      const judgeInput = `STUDENT: ${kidMessage}\n\nTUTOR REPLY: ${replyText}`;
      const options: GenerateOptions = deepFreeze({
        provider: judgeConfig.provider,
        model: judgeConfig.model,
        messages: [
          createUserMessage({
            content: [{ type: "text", text: judgeInput }],
            source: { kind: "plugin", plugin: "dsh-kid-tutor" },
          }),
        ],
        system: JUDGE_SYSTEM_PROMPT,
        maxTokens: 300,
        // A reasoning-capable route defaults its per-request effort to
        // "high" (llm-deepseek's own doc comment); without this, the judge
        // can spend its whole `maxTokens` budget on hidden reasoning and
        // return an EMPTY visible text block (confirmed live: judge call
        // succeeded with no exception, `flattenText` returned ""). The
        // classifier task needs no reasoning at all.
        reasoningEffort: ReasoningEffortId("off"),
        ...(baseOptions.sessionId !== undefined ? { sessionId: baseOptions.sessionId } : {}),
        signal: callDeadline.signal,
      });
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(markOwnCall(options))) assembler.push(chunk);
      const rawOutput = flattenText(assembler.blocks());
      const parsed = parseJudgeVerdict(rawOutput);
      if (parsed === undefined) {
        console.error(`[kid-tutor/output-guard] judge produced unparseable output (fail closed): ${JSON.stringify(rawOutput)}`);
        return undefined;
      }
      return { ...parsed, rawOutput };
    } catch (error) {
      console.error(`[kid-tutor/output-guard] judge call threw (fail closed): ${(error as Error)?.stack ?? String(error)}`);
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
      for await (const chunk of ctx.llm.stream(markOwnCall(options))) assembler.push(chunk);
      return flattenText(assembler.blocks());
    } catch {
      return undefined;
    }
  }

  /** Fire the parent alert as a detached promise; never awaited by the caller (see file header). */
  function fireAlertDetached(
    session: Session | undefined,
    verdict: JudgeVerdict,
    kidMessage: string,
  ): void {
    ctx.parentAlert
      .send({ category: verdict.category, severity: verdict.severity, excerpt: kidMessage.slice(0, 200) })
      .then((result) => {
        if (session === undefined) return;
        kidTutorEvents.alert(session, {
          category: verdict.category,
          severity: verdict.severity,
          excerpt: kidMessage.slice(0, 200),
          delivered: result.delivered,
          ...(result.error !== undefined ? { error: result.error } : {}),
          turn: 0,
          step: 0,
        });
      })
      .catch(() => {
        // send() itself is designed never to reject; this catch exists only
        // so a future change to it can't turn into an unhandled rejection.
      });
  }

  ctx.on("llm/stream", async function* (options, next): AsyncIterable<StreamChunk> {
    const guarded = isGuardedTurn(options);
    trace("dispatch", {
      guarded,
      purpose: options.purpose ?? null,
      sessionId: options.sessionId ?? null,
      knownSession: options.sessionId !== undefined && sessionsById.has(options.sessionId),
      ownCall: ownCalls.has(options),
      // Always false, and deliberately still reported: it is read through this
      // repo's duplicate copy of @deepseek-ai/dsh-llm, never the harness's, so
      // a `markedByHarness=true` line here would mean the duplicate-module
      // condition described in the file header has been resolved.
      markedByHarness: isAgentLoopRequest(options),
    });
    if (!guarded) {
      yield* next();
      return;
    }

    const session = options.sessionId !== undefined ? sessionsById.get(options.sessionId) : undefined;
    const kidMessage = latestUserText(options.messages);
    const logVerdict = (data: Omit<Parameters<typeof kidTutorEvents.guardVerdict>[1], "turn" | "step">): void => {
      if (session === undefined) return;
      kidTutorEvents.guardVerdict(session, { ...data, turn: 0, step: 0 });
    };

    const assembler = new BlockAssembler();
    const rawChunks: StreamChunk[] = [];
    for await (const chunk of next()) {
      rawChunks.push(chunk);
      assembler.push(chunk);
    }
    const originalBlocks = assembler.blocks();
    const originalText = flattenText(originalBlocks);
    const usage = assembler.usage;

    // Only a genuine failure (`error`/`aborted`) is re-emitted byte for byte.
    // That terminal chunk is the agent loop's own failure channel (it drives
    // `agent/request-error` and the retry policy); swallowing it and
    // synthesizing a calm replacement would turn every provider outage into a
    // silent "ask me a different way" with no diagnosis anywhere.
    //
    // `max-tokens` is deliberately NOT included here, despite also being a
    // non-"stop" finish. Confirmed live: `brevity.ts`'s 350-token cap
    // combined with a `high`-reasoning-effort route means exactly the
    // heaviest, most safety-relevant exchanges (a stranger-danger question
    // that rightly used 219 reasoning tokens) are the ones most likely to
    // hit the cap — passing THOSE through unfiltered would exempt the
    // replies needing the guard most from ever reaching it, and would also
    // hand the kid a reply truncated mid-sentence. A `max-tokens` reply's
    // visible text is still coherent enough to run through both guard stages
    // (the length judged too long/incomplete falls out of the existing
    // brevity redo criterion for free), so it takes the normal path below.
    const finish = assembler.finish;
    if (finish.kind === "error" || finish.kind === "aborted") {
      trace("passthrough", { reason: `finish:${finish.kind}` });
      yield* rawChunks;
      return;
    }

    // A tool-calling step is re-emitted byte for byte: re-synthesizing it as a
    // single text block would delete the tool calls. See the file header.
    if (hasToolCall(originalBlocks)) {
      trace("passthrough", { reason: "tool-call step", blocks: originalBlocks.length });
      yield* rawChunks;
      return;
    }

    /** Returns the reply's own verdict, plus whether an alert-worthy classification forces a non-pass outcome. */
    async function evaluate(text: string): Promise<{ verdict: "pass" | "redo" | "block"; alerted: boolean }> {
      const stage1 = runDeterministicStage(text, patterns);
      if (stage1.verdict === "block") {
        logVerdict({ stage: "deterministic", verdict: "block", rule: stage1.rule, suppressedText: text });
        return { verdict: "block", alerted: false };
      }
      logVerdict({ stage: "deterministic", verdict: "pass" });

      const judged = await runJudge(kidMessage, text, options);
      if (judged === undefined) {
        logVerdict({
          stage: "judge",
          verdict: "block",
          reason: "judge unavailable or timed out (fail closed)",
          suppressedText: text,
        });
        return { verdict: "block", alerted: false };
      }
      logVerdict({
        stage: "judge",
        verdict: judged.verdict,
        reason: judged.reason.length > 0 ? judged.reason : undefined,
        judgeInput: text,
        judgeOutput: judged.rawOutput,
        category: judged.category,
        severity: judged.severity,
        ...(judged.verdict === "pass" ? {} : { suppressedText: text }),
      });

      if (ctx.parentAlert.shouldAlert(judged.severity)) {
        fireAlertDetached(session, judged, kidMessage);
        // A topic worth alerting a parent about never just flows through,
        // even if the reply itself was judged "pass" — see file header.
        return { verdict: judged.verdict === "pass" ? "block" : judged.verdict, alerted: true };
      }
      return { verdict: judged.verdict, alerted: false };
    }

    function replacementText(alerted: boolean): string {
      return alerted && ctx.parentAlert.disclosure ? ALERT_DISCLOSURE_TEXT : REPLACEMENT_TEXT;
    }

    const first = await evaluate(originalText);
    if (first.verdict === "pass") {
      yield* pacedTextChunks(originalText, usage, charsPerSecond, options.signal);
      return;
    }
    if (first.verdict === "block") {
      yield* pacedTextChunks(replacementText(first.alerted), undefined, charsPerSecond, options.signal);
      return;
    }

    // Exactly one redo attempt, then block regardless of the second verdict.
    const redoText = await runRedo(options, originalBlocks);
    if (redoText === undefined) {
      logVerdict({ stage: "judge", verdict: "block", reason: "redo call failed (fail closed)" });
      yield* pacedTextChunks(REPLACEMENT_TEXT, undefined, charsPerSecond, options.signal);
      return;
    }
    const second = await evaluate(redoText);
    if (second.verdict === "pass") {
      yield* pacedTextChunks(redoText, undefined, charsPerSecond, options.signal);
      return;
    }
    yield* pacedTextChunks(replacementText(second.alerted), undefined, charsPerSecond, options.signal);
  });
}
