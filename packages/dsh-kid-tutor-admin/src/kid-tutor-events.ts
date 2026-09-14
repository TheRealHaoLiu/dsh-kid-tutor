/**
 * Declaration-merged log-only session event types this admin bundle reads,
 * per docs/CONTRACT.md "Log-only session event types". The admin package
 * never appends these; it declares them so `ctx.sessionQuery`/raw
 * `SessionEvent` reads are typed instead of `any`.
 *
 * Kept in lockstep with `dsh-kid-tutor`'s own shapes by hand: CONTRACT.md is
 * the single normative source, and both packages mirror it rather than one
 * importing the other (they are independent bundles).
 *
 * KNOWN DEVIATION (docs/dsh-seams.md §7 "Known deviation",
 * `dsh-kid-tutor/events.ts`'s module doc): since the write-side fix, a kid
 * session's dsh log itself no longer carries these types at all — the kid
 * bundle now writes them to its own sidecar JSONL file
 * (`readSidecarRecords`/`mergeSidecarEvents` below), because dsh's runtime
 * reader was never able to make an out-of-tree `SessionEventMap` addition
 * safe to replay. This `declare module` augmentation still earns its keep
 * for exactly ONE reason: it types the events `raw-session-read.ts`'s
 * fallback recovers from sessions written BEFORE the fix, which still have
 * them inline. New sessions' `SessionEvent[]` simply never contains a
 * `kid-tutor/*` member; `kid-store.ts` merges the sidecar file's records in
 * separately for those.
 * @module dsh-kid-tutor-admin/kid-tutor-events
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * The judge's category classification, mirrored by hand from
 * `dsh-kid-tutor/config.ts`'s `GUARD_CATEGORIES` per CONTRACT.md.
 */
export const GUARD_CATEGORIES = [
  "none",
  "sexual",
  "violence",
  "self_harm",
  "drugs",
  "personal_info",
  "stranger_contact",
  "hate",
  "other_adult",
] as const;

export type GuardCategory = (typeof GUARD_CATEGORIES)[number];

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "kid-tutor/guard-verdict": {
      stage: "deterministic" | "judge";
      verdict: "pass" | "block" | "redo";
      reason?: string;
      rule?: string;
      judgeInput?: string;
      judgeOutput?: string;
      suppressedText?: string;
      /** Judge-stage only: what kind of thing was flagged, "none" on pass. Undefined on `stage: 'deterministic'`. */
      category?: GuardCategory;
      /** Judge-stage only: 0 none, 1 log, 2 alert. Drives `parent-alert`. Undefined on `stage: 'deterministic'`. */
      severity?: number;
      turn: number;
      step: number;
    };
    "kid-tutor/tool-denied": {
      tool: string;
      reason: string;
      url?: string;
      path?: string;
      turn: number;
      step: number;
    };
    "kid-tutor/quota": {
      kind: "turn" | "cutoff";
      used: number;
      limit: number;
      turn: number;
    };
    "kid-tutor/python-run": {
      file?: string;
      exitCode: number;
      durationMs: number;
      truncated: boolean;
      turn: number;
      step: number;
    };
    "kid-tutor/alert": {
      /** The guard-verdict category/severity that triggered this attempt. */
      category: GuardCategory;
      severity: number;
      /** The kid's message that triggered the alert, truncated to 200 chars. */
      excerpt: string;
      /** Whether the webhook POST actually succeeded. */
      delivered: boolean;
      /** Present when `delivered` is false. */
      error?: string;
      turn: number;
      step: number;
    };
  }
}

/** The five kid-tutor log-only event type names, for narrowing/filtering. */
export const KID_TUTOR_EVENT_TYPES = [
  "kid-tutor/guard-verdict",
  "kid-tutor/tool-denied",
  "kid-tutor/quota",
  "kid-tutor/python-run",
  "kid-tutor/alert",
] as const;

export type KidTutorEventType = (typeof KID_TUTOR_EVENT_TYPES)[number];

/** One line of a kid-tutor sidecar audit file — mirrors `dsh-kid-tutor/events.ts`'s `KidTutorSidecarRecord`. */
export interface KidTutorSidecarRecord {
  type: KidTutorEventType;
  time: number;
  data: Record<string, unknown>;
}

/** Same filename convention as `dsh-kid-tutor/events.ts`'s `sidecarFilename` (independent bundles, mirrored by hand). */
function sidecarFilename(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}.jsonl`;
}

function isKidTutorEventType(value: string): value is KidTutorEventType {
  return (KID_TUTOR_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Read one session's sidecar audit file. Tolerant of a missing file
 * (nothing recorded yet, or a session that predates the sidecar fix and
 * only has its facts inline via `raw-session-read.ts`'s fallback instead)
 * and of a malformed line (skipped, never thrown) — this is a read-only
 * analyst view, not a strict replay path.
 */
export function readSidecarRecords(
  dir: string,
  sessionId: string,
): KidTutorSidecarRecord[] {
  let text: string;
  try {
    text = readFileSync(join(dir, sidecarFilename(sessionId)), "utf8");
  } catch {
    return [];
  }
  const out: KidTutorSidecarRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; time?: unknown; data?: unknown };
      if (
        typeof parsed.type === "string" &&
        isKidTutorEventType(parsed.type) &&
        typeof parsed.time === "number" &&
        typeof parsed.data === "object" &&
        parsed.data !== null
      ) {
        out.push({ type: parsed.type, time: parsed.time, data: parsed.data as Record<string, unknown> });
      }
    } catch {
      // one bad line never sinks the rest of the file
    }
  }
  return out;
}

/**
 * Merge a session's sidecar audit records into its dsh-log event array, in
 * time order, so `session-render.ts`/`kid-store.ts` can treat them exactly
 * like the inline `kid-tutor/*` events a pre-fix session still carries.
 * Merged records get synthetic `seq` values (continuing past the highest
 * real seq) — correct for time ordering and `event.type` narrowing, but not
 * meaningful for `kid_read_session`'s `from`/`to` bounds, which only ever
 * address the real dsh log's own seq space.
 */
export function mergeSidecarEvents(
  events: readonly SessionEvent[],
  sidecar: readonly KidTutorSidecarRecord[],
): SessionEvent[] {
  if (sidecar.length === 0) return [...events];
  let nextSeq = events.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
  const extra = sidecar.map(
    (record) =>
      ({
        type: record.type,
        seq: nextSeq++,
        time: record.time,
        data: record.data,
      }) as SessionEvent,
  );
  return [...events, ...extra].sort((a, b) => a.time - b.time);
}
