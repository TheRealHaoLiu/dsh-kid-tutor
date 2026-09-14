/**
 * Integration test: writes fixture sessions through the REAL
 * `@deepseek-ai/dsh-session-persistence-jsonl` backend (so the on-disk layout
 * is exactly what production writes — docs/dsh-seams.md §7's "On-disk
 * storage path"), then boots a SECOND, independent read-only
 * persistence+query pair pointed at the same root — exactly what `kid-store`
 * does in production, minus the `cordis:group` isolation (irrelevant to this
 * unit: nothing here collides with another `sessionPersistence`) — and
 * exercises `KidStore` end to end.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { CallId, MessageId } from "@deepseek-ai/dsh-llm";
import SessionStore, {
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SqliteSessionQueryEngine from "@deepseek-ai/dsh-session-query-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../src/kid-tutor-events.ts";
import { buildDigest } from "../src/digest.ts";
import { KidStore } from "../src/kid-store.ts";

let root: string;
let writerCtx: Context;
let readerCtx: Context;

const DAY_MS = 86_400_000;
const now = Date.now();

function header(id: string, createdAt: number): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt, cwd: "/kid/workspace" };
}

/** A realistic one-turn kid session: a curiosity question, a web search, and a clean pass. */
function plainSessionLog(): SessionEvent[] {
  return [
    { type: "turn/start", seq: 0, time: now - 1000, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: now - 900,
      data: {
        id: MessageId("u1"),
        role: "user",
        content: [{ type: "text", text: "how do volcanoes work?" }],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    },
    { type: "step/start", seq: 2, time: now - 800, data: { turn: 1, step: 1 } },
    {
      type: "tool/call",
      seq: 3,
      time: now - 700,
      data: {
        turn: 1,
        step: 1,
        callId: CallId("c1"),
        name: "web_search",
        arguments: '{"query":"how volcanoes work"}',
      },
    },
    {
      type: "tool/result",
      seq: 4,
      time: now - 600,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId("t1"),
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: CallId("c1"),
              content: [
                { type: "text", text: "Volcanoes form where magma..." },
              ],
            },
          ],
          source: { kind: "tool", callId: CallId("c1") },
        },
      },
      surfaceOp: "append",
    },
    {
      type: "kid-tutor/guard-verdict",
      seq: 5,
      time: now - 500,
      ignorable: true,
      data: { stage: "deterministic", verdict: "pass", turn: 1, step: 1 },
    },
    {
      type: "assistant/message",
      seq: 6,
      time: now - 400,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId("a1"),
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Great question! Volcanoes form where magma...",
            },
          ],
          source: {
            kind: "model",
            provider: "deepseek-official",
            model: "deepseek-v4-flash",
          },
        },
      },
      surfaceOp: "append",
    },
    { type: "step/end", seq: 7, time: now - 300, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 8,
      time: now - 200,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

/** A homework-mode session where the guard blocks a final-answer reveal, a fetch gets denied, and quota/python fire. */
function eventfulSessionLog(): SessionEvent[] {
  return [
    { type: "turn/start", seq: 0, time: now - 100_000, data: { turn: 5 } },
    {
      type: "user/message",
      seq: 1,
      time: now - 99_000,
      data: {
        id: MessageId("u2"),
        role: "user",
        content: [
          { type: "text", text: "just give me the answer to problem 4" },
        ],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    },
    {
      type: "step/start",
      seq: 2,
      time: now - 98_000,
      data: { turn: 5, step: 1 },
    },
    {
      type: "kid-tutor/tool-denied",
      seq: 3,
      time: now - 97_500,
      ignorable: true,
      data: {
        tool: "web_fetch",
        reason: 'domain "example.com" is not on the allowlist',
        url: "https://example.com",
        turn: 5,
        step: 1,
      },
    },
    {
      type: "kid-tutor/python-run",
      seq: 4,
      time: now - 97_000,
      ignorable: true,
      data: {
        file: "main.py",
        exitCode: 1,
        durationMs: 340,
        truncated: false,
        turn: 5,
        step: 1,
      },
    },
    {
      type: "kid-tutor/guard-verdict",
      seq: 5,
      time: now - 96_000,
      ignorable: true,
      data: {
        stage: "judge",
        verdict: "block",
        reason: "reveals final answer",
        suppressedText: "The answer is x = 4.",
        turn: 5,
        step: 1,
      },
    },
    {
      type: "assistant/message",
      seq: 6,
      time: now - 95_000,
      data: {
        turn: 5,
        step: 1,
        message: {
          id: MessageId("a2"),
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Let's work through it together — what's the first step?",
            },
          ],
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
      type: "step/end",
      seq: 7,
      time: now - 94_000,
      data: { turn: 5, step: 1 },
    },
    {
      type: "kid-tutor/quota",
      seq: 8,
      time: now - 93_000,
      ignorable: true,
      data: { kind: "turn", used: 60, limit: 60, turn: 5 },
    },
    {
      type: "turn/end",
      seq: 9,
      time: now - 92_000,
      data: { turn: 5, reason: { kind: "completed" } },
    },
  ];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-kid-admin-"));

  writerCtx = new Context();
  await writerCtx.plugin(SessionStore);
  await writerCtx.plugin(JsonlSessionPersistence, {
    root,
    compression: "none",
  });
  const persistence = writerCtx.sessionPersistence;

  const plainMeta = header("plain-1", now - DAY_MS * 10); // 10 days ago — outside a 24h window
  await persistence.create(plainMeta);
  await persistence.append(
    plainMeta.id,
    plainSessionLog().map((e) => ({
      ...e,
      time: plainMeta.createdAt + e.time - (now - 1000),
    })),
  );

  const recentMeta = header("eventful-1", now - 3_600_000); // 1 hour ago — inside a 24h window
  await persistence.create(recentMeta);
  await persistence.append(
    recentMeta.id,
    eventfulSessionLog().map((e) => ({
      ...e,
      time: recentMeta.createdAt + e.time - (now - 100_000),
    })),
  );

  await writerCtx.fiber.dispose();

  readerCtx = new Context();
  await readerCtx.plugin(SessionStore);
  await readerCtx.plugin(JsonlSessionPersistence, {
    root,
    compression: "none",
  });
  await readerCtx.plugin(SqliteSessionQueryEngine, {
    path: ":memory:",
    openAt: "startup",
  });
  await readerCtx.plugin(KidStore, {
    kidSessionsDir: root,
    timezone: "UTC",
    defaultSince: "24h",
  });
});

afterEach(async () => {
  await readerCtx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("KidStore over a real (second-reader) session store", () => {
  it("listSessions defaults to the configured window and excludes older sessions", async () => {
    const sessions = await readerCtx.kidStore.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["eventful-1"]);
    expect(sessions[0]?.firstUserMessagePreview).toBe(
      "just give me the answer to problem 4",
    );
    expect(sessions[0]?.turnCount).toBe(1);
  });

  it("listSessions with an explicit wide since includes both sessions, newest first", async () => {
    const sessions = await readerCtx.kidStore.listSessions({ since: "30d" });
    expect(sessions.map((s) => s.id)).toEqual(["eventful-1", "plain-1"]);
  });

  it("listSessions respects limit", async () => {
    const sessions = await readerCtx.kidStore.listSessions({
      since: "30d",
      limit: 1,
    });
    expect(sessions).toHaveLength(1);
  });

  it("readSession renders a compact transcript and hides log-only events by default", async () => {
    const text = await readerCtx.kidStore.readSession("eventful-1");
    expect(text).toContain("kid: just give me the answer to problem 4");
    expect(text).toContain("model: Let's work through it together");
    expect(text).not.toContain("GUARD");
    expect(text).toMatch(/QUOTED CONTENT/);
  });

  it("readSession includes kid-tutor/* audit events when asked", async () => {
    const text = await readerCtx.kidStore.readSession("eventful-1", {
      includeLogOnly: true,
    });
    expect(text).toContain("[GUARD judge → block: reveals final answer]");
    expect(text).toContain("suppressed text: The answer is x = 4.");
    expect(text).toContain("[DENIED web_fetch https://example.com:");
    expect(text).toContain("[QUOTA turn: 60/60]");
    expect(text).toContain("[PYTHON main.py exit=1 340ms]");
  });

  it("guardEvents excludes plain passes and includes judge I/O", async () => {
    const events = await readerCtx.kidStore.guardEvents({ since: "30d" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "eventful-1",
      verdict: "block",
      suppressedText: "The answer is x = 4.",
    });
  });

  it("deniedTools, quotaEvents, pythonRuns each return one record for the eventful session", async () => {
    expect(await readerCtx.kidStore.deniedTools({ since: "30d" })).toHaveLength(
      1,
    );
    expect(await readerCtx.kidStore.quotaEvents({ since: "30d" })).toHaveLength(
      1,
    );
    expect(await readerCtx.kidStore.pythonRuns({ since: "30d" })).toHaveLength(
      1,
    );
  });

  it("stats buckets counts by local day", async () => {
    const stats = await readerCtx.kidStore.stats({ since: "30d" });
    const totalSessions = stats.reduce((sum, d) => sum + d.sessions, 0);
    expect(totalSessions).toBe(2);
    const totalGuardFires = stats.reduce((sum, d) => sum + d.guardFires, 0);
    expect(totalGuardFires).toBe(1);
  });

  it("composes into a digest end to end", async () => {
    const since = "30d";
    const [sessions, guardEvents, deniedTools, quotaEvents, pythonRuns, stats] =
      await Promise.all([
        readerCtx.kidStore.listSessions({ since }),
        readerCtx.kidStore.guardEvents({ since }),
        readerCtx.kidStore.deniedTools({ since }),
        readerCtx.kidStore.quotaEvents({ since }),
        readerCtx.kidStore.pythonRuns({ since }),
        readerCtx.kidStore.stats({ since }),
      ]);
    const digest = buildDigest({
      since,
      sessions,
      guardEvents,
      deniedTools,
      quotaEvents,
      pythonRuns,
      stats,
      timezone: "UTC",
    });
    expect(digest).toContain("Sessions: 2");
    expect(digest).toContain("Guard fires (non-pass): 1");
    expect(digest).toContain("Denied tool calls: 1");
    expect(digest).toContain("Quota hits: 1");
    expect(digest).toContain("Python runs: 1");
  });
});
