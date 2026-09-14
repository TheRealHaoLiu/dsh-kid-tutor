/**
 * `kid-store`: a Cordis service that opens the kid profile's session store
 * READ-ONLY and exposes analyst-shaped queries over it.
 *
 * Mounted from `packages/dsh-kid-tutor-admin/cordis.patch.yml` inside an
 * isolated `cordis:group` realm (docs/dsh-seams.md §1d) alongside a SECOND,
 * private `@deepseek-ai/dsh-session-persistence-jsonl` +
 * `@deepseek-ai/dsh-session-query-sqlite` pair pointed at `kidSessionsDir` —
 * the admin process's OWN `ctx.sessionPersistence`/`ctx.sessionQuery`
 * (mounted by `@deepseek-ai/dsh-base` at host plane, for the admin agent's
 * OWN conversation) is a process-global singleton, so a second reader over a
 * different root must sit behind its own realm or it collides
 * (docs/dsh-seams.md §1d, the `standard` preset's own "A service row here
 * MUST sit inside a group carrying an `isolate` realm" comment). This class
 * itself is NOT isolated by name — only `sessionPersistence`/`sessionQuery`
 * are — so `ctx.kidStore` publishes into the ROOT realm and is reachable by
 * `admin-tools` from outside the group (docs/dsh-seams.md §7 "One live
 * writer per session": this backend never calls `.append()`, so staying a
 * second reader beside the kid process's own writer is safe).
 * @module dsh-kid-tutor-admin/kid-store
 */

import { Service, type Context } from "@deepseek-ai/cordis";
import { SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import "./kid-tutor-events.ts";
import { mergeSidecarEvents, readSidecarRecords, type GuardCategory } from "./kid-tutor-events.ts";
import { readSessionTolerant } from "./raw-session-read.ts";
import { Config, resolveSince, dayKey, type KidAdminConfig } from "./config.ts";
import {
  firstUserMessagePreview,
  lastActivity,
  renderTranscript,
  turnCount,
} from "./session-render.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    kidStore: KidStore;
  }
}

export interface SessionSummary {
  id: string;
  started: number;
  lastActivity: number;
  turnCount: number;
  firstUserMessagePreview?: string;
}

export interface ListSessionsOptions {
  since?: string;
  limit?: number;
}

export interface ReadSessionOptions {
  from?: number;
  to?: number;
  includeLogOnly?: boolean;
}

export interface GuardEventRecord {
  sessionId: string;
  seq: number;
  time: number;
  turn: number;
  step: number;
  stage: "deterministic" | "judge";
  verdict: "pass" | "block" | "redo";
  reason?: string;
  rule?: string;
  judgeInput?: string;
  judgeOutput?: string;
  suppressedText?: string;
  /** Judge-stage only: `undefined` on `stage: 'deterministic'`. */
  category?: GuardCategory;
  /** Judge-stage only: `undefined` on `stage: 'deterministic'`. */
  severity?: number;
}

export interface ToolDeniedRecord {
  sessionId: string;
  seq: number;
  time: number;
  turn: number;
  step: number;
  tool: string;
  reason: string;
  url?: string;
  path?: string;
}

export interface QuotaEventRecord {
  sessionId: string;
  seq: number;
  time: number;
  turn: number;
  kind: "turn" | "cutoff";
  used: number;
  limit: number;
}

export interface PythonRunRecord {
  sessionId: string;
  seq: number;
  time: number;
  turn: number;
  step: number;
  file?: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface AlertRecord {
  sessionId: string;
  seq: number;
  time: number;
  turn: number;
  step: number;
  category: GuardCategory;
  severity: number;
  /** The kid's triggering message, truncated to 200 chars (event's `excerpt`). */
  kidMessagePreview: string;
  /** Whether the webhook POST actually succeeded. */
  delivered: boolean;
  /** Present when `delivered` is false. */
  error?: string;
}

export interface SinceOptions {
  since?: string;
}

export interface DailyStats {
  day: string;
  sessions: number;
  turns: number;
  guardFires: number;
  toolDenials: number;
  quotaHits: number;
  pythonRuns: number;
}

/** Read-only analyst view over the kid profile's session store. */
export class KidStore extends Service {
  static readonly provide = "kidStore";
  // `sessionPersistence` is injected alongside `sessionQuery` for
  // `raw-session-read.ts`'s fallback (docs/dsh-seams.md §7 "Known
  // deviation") — both resolve, inside `kid-store-realm`'s isolated group,
  // to the SAME second reader pointed at the kid profile's store.
  static readonly inject = ["sessionQuery", "sessionPersistence"] as const;
  /** Loader-recognized config schema (mirrors `JsonlSessionPersistence.Config`) — defaults/validates the row's `config:`. */
  static readonly Config = Config;

  constructor(
    ctx: Context,
    public readonly config: KidAdminConfig,
  ) {
    super(ctx, "kidStore");
  }

  private since(value: string | undefined): number {
    return resolveSince(value, this.config.defaultSince);
  }

  /** List sessions started at or after `since` (default `config.defaultSince`), newest first. */
  async listSessions(
    options: ListSessionsOptions = {},
  ): Promise<SessionSummary[]> {
    const cutoff = this.since(options.since);
    const records = await this.ctx.sessionQuery.listSessions();
    const summaries: SessionSummary[] = [];
    for (const record of records) {
      if (record.header.createdAt < cutoff) continue;
      const { events } = await this.loadLog(record.header.id);
      summaries.push({
        id: record.header.id,
        started: record.header.createdAt,
        lastActivity: lastActivity(record.header, events),
        turnCount: turnCount(events),
        firstUserMessagePreview: firstUserMessagePreview(events),
      });
    }
    summaries.sort((a, b) => b.started - a.started);
    return options.limit !== undefined
      ? summaries.slice(0, options.limit)
      : summaries;
  }

  /**
   * Full raw event log for one session, id and header included. Reads
   * through the strict path first, falling back to
   * `raw-session-read.ts`'s tolerant decode for a session written before
   * the sidecar fix (docs/dsh-seams.md §7 "Known deviation"), then merges
   * in the session's sidecar audit file (present for any session written
   * AFTER the fix; absent, and a no-op merge, for one written before it).
   */
  private async loadLog(
    sessionId: string,
  ): Promise<{ session: SessionHeader; events: SessionEvent[] }> {
    const snapshot = await readSessionTolerant(
      this.ctx,
      SessionId(sessionId),
    );
    const sidecar = readSidecarRecords(
      this.config.kidTutorEventsDir,
      sessionId,
    );
    return {
      session: snapshot.session,
      events: mergeSidecarEvents(snapshot.events, sidecar),
    };
  }

  /** Render one session's transcript, log-only `kid-tutor/*` audit events included when asked. */
  async readSession(
    sessionId: string,
    options: ReadSessionOptions = {},
  ): Promise<string> {
    const snapshot = await this.loadLog(sessionId);
    return renderTranscript(snapshot.events, {
      timezone: this.config.timezone,
      includeLogOnly: options.includeLogOnly ?? false,
      from: options.from,
      to: options.to,
    });
  }

  /** Iterate every session's raw events at/after `since`, oldest session first. */
  private async *eachEventSince(
    since: string | undefined,
  ): AsyncGenerator<{ sessionId: string; events: readonly SessionEvent[] }> {
    const cutoff = this.since(since);
    const records = await this.ctx.sessionQuery.listSessions();
    for (const record of records) {
      if (record.header.createdAt < cutoff) continue;
      const snapshot = await this.loadLog(record.header.id);
      yield { sessionId: record.header.id, events: snapshot.events };
    }
  }

  /** Every `kid-tutor/guard-verdict` with `verdict !== 'pass'`, across sessions started at/after `since`. */
  async guardEvents(options: SinceOptions = {}): Promise<GuardEventRecord[]> {
    const out: GuardEventRecord[] = [];
    for await (const { sessionId, events } of this.eachEventSince(
      options.since,
    )) {
      for (const event of events) {
        if (event.type !== "kid-tutor/guard-verdict") continue;
        const data = event.data;
        if (data.verdict === "pass") continue;
        out.push({ sessionId, seq: event.seq, time: event.time, ...data });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** Every `kid-tutor/tool-denied` across sessions started at/after `since`. */
  async deniedTools(options: SinceOptions = {}): Promise<ToolDeniedRecord[]> {
    const out: ToolDeniedRecord[] = [];
    for await (const { sessionId, events } of this.eachEventSince(
      options.since,
    )) {
      for (const event of events) {
        if (event.type !== "kid-tutor/tool-denied") continue;
        out.push({
          sessionId,
          seq: event.seq,
          time: event.time,
          ...event.data,
        });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** Every `kid-tutor/quota` across sessions started at/after `since`. */
  async quotaEvents(options: SinceOptions = {}): Promise<QuotaEventRecord[]> {
    const out: QuotaEventRecord[] = [];
    for await (const { sessionId, events } of this.eachEventSince(
      options.since,
    )) {
      for (const event of events) {
        if (event.type !== "kid-tutor/quota") continue;
        out.push({
          sessionId,
          seq: event.seq,
          time: event.time,
          ...event.data,
        });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** Every `kid-tutor/python-run` across sessions started at/after `since`. */
  async pythonRuns(options: SinceOptions = {}): Promise<PythonRunRecord[]> {
    const out: PythonRunRecord[] = [];
    for await (const { sessionId, events } of this.eachEventSince(
      options.since,
    )) {
      for (const event of events) {
        if (event.type !== "kid-tutor/python-run") continue;
        out.push({
          sessionId,
          seq: event.seq,
          time: event.time,
          ...event.data,
        });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** Every `kid-tutor/alert` across sessions started at/after `since`. */
  async alerts(options: SinceOptions = {}): Promise<AlertRecord[]> {
    const out: AlertRecord[] = [];
    for await (const { sessionId, events } of this.eachEventSince(
      options.since,
    )) {
      for (const event of events) {
        if (event.type !== "kid-tutor/alert") continue;
        const { excerpt, ...rest } = event.data;
        out.push({
          sessionId,
          seq: event.seq,
          time: event.time,
          kidMessagePreview: excerpt,
          ...rest,
        });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** Per-local-day counts across sessions started at/after `since`. */
  async stats(options: SinceOptions = {}): Promise<DailyStats[]> {
    const byDay = new Map<string, DailyStats>();
    const bump = (
      day: string,
      field: keyof Omit<DailyStats, "day">,
      amount = 1,
    ): void => {
      let row = byDay.get(day);
      if (row === undefined) {
        row = {
          day,
          sessions: 0,
          turns: 0,
          guardFires: 0,
          toolDenials: 0,
          quotaHits: 0,
          pythonRuns: 0,
        };
        byDay.set(day, row);
      }
      row[field] += amount;
    };
    for await (const { events } of this.eachEventSince(options.since)) {
      let sessionCounted = false;
      for (const event of events) {
        const day = dayKey(event.time, this.config.timezone);
        if (!sessionCounted) {
          bump(day, "sessions");
          sessionCounted = true;
        }
        if (event.type === "turn/start") bump(day, "turns");
        else if (
          event.type === "kid-tutor/guard-verdict" &&
          event.data.verdict !== "pass"
        )
          bump(day, "guardFires");
        else if (event.type === "kid-tutor/tool-denied")
          bump(day, "toolDenials");
        else if (event.type === "kid-tutor/quota") bump(day, "quotaHits");
        else if (event.type === "kid-tutor/python-run") bump(day, "pythonRuns");
      }
    }
    return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  }
}

export default KidStore;
