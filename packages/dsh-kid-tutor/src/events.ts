/**
 * The four log-only, declaration-merged `SessionEventMap` entries this bundle
 * contributes, plus one append helper per type. Shapes match
 * docs/CONTRACT.md "Log-only session event types" exactly. Log-only means
 * NEVER pass a `SurfaceIntent` (docs/dsh-seams.md §7) — these never appear in
 * the model-visible transcript, only in the durable log for the parent to
 * read (admin bundle's job).
 *
 * @module dsh-kid-tutor/events
 */

import type { Session } from "@deepseek-ai/dsh-session";
import type { GuardCategory } from "./config.ts";

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
      /** Judge-stage only: what kind of thing was flagged, "none" on pass. */
      category?: GuardCategory;
      /** Judge-stage only: 0 none, 1 log, 2 alert. Drives `parent-alert`. */
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

export type GuardVerdictData = {
  stage: "deterministic" | "judge";
  verdict: "pass" | "block" | "redo";
  reason?: string;
  rule?: string;
  judgeInput?: string;
  judgeOutput?: string;
  suppressedText?: string;
  category?: GuardCategory;
  severity?: number;
  turn: number;
  step: number;
};

export type AlertData = {
  category: GuardCategory;
  severity: number;
  excerpt: string;
  delivered: boolean;
  error?: string;
  turn: number;
  step: number;
};

export type ToolDeniedData = {
  tool: string;
  reason: string;
  url?: string;
  path?: string;
  turn: number;
  step: number;
};

export type QuotaEventData = {
  kind: "turn" | "cutoff";
  used: number;
  limit: number;
  turn: number;
};

export type PythonRunData = {
  file?: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  turn: number;
  step: number;
};

/**
 * Append helpers. Each is a thin, total wrapper over `Session.append` so
 * call sites never spell the event-type string more than once. All four are
 * log-only: no `SurfaceIntent` is passed, matching the compiler's own
 * enforcement (`Session.append`'s variadic `opts` is `[]` for a non-surface
 * type).
 */
/**
 * Sentinel `turn`/`step` for events raised from a `ToolExecution` (the
 * `tools/pre-execute`/`tools/post-execute` waterfalls and `run_python`'s
 * `execute`), none of which carry `turn`/`step` — those fields exist only on
 * `agent/pre-step` payloads and session events the agent loop itself appends
 * (`tool/call`, `step/start`, ...). Recording `0, 0` is honest about what
 * tool-execution context does NOT provide rather than guessing; the event's
 * own `time` plus the session it landed in still let a parent correlate it.
 */
export const UNKNOWN_TURN_STEP = { turn: 0, step: 0 } as const;

export const kidTutorEvents = {
  guardVerdict(session: Session, data: GuardVerdictData): void {
    session.append("kid-tutor/guard-verdict", data);
  },
  toolDenied(session: Session, data: ToolDeniedData): void {
    session.append("kid-tutor/tool-denied", data);
  },
  quota(session: Session, data: QuotaEventData): void {
    session.append("kid-tutor/quota", data);
  },
  pythonRun(session: Session, data: PythonRunData): void {
    session.append("kid-tutor/python-run", data);
  },
  alert(session: Session, data: AlertData): void {
    session.append("kid-tutor/alert", data);
  },
};
