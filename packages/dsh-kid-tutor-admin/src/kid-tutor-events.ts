/**
 * Declaration-merged log-only session event types the kid bundle appends and
 * this admin bundle reads, per docs/CONTRACT.md "Log-only session event
 * types". The admin package never appends these (read-only); it declares them
 * so `ctx.sessionQuery`/raw `SessionEvent` reads are typed instead of `any`.
 *
 * Kept in lockstep with `dsh-kid-tutor`'s own declaration by hand: CONTRACT.md
 * is the single normative source for these shapes, and both packages mirror
 * it rather than one importing the other (they are independent bundles).
 * @module dsh-kid-tutor-admin/kid-tutor-events
 */

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
  }
}

/** The four kid-tutor log-only event type names, for narrowing/filtering. */
export const KID_TUTOR_EVENT_TYPES = [
  "kid-tutor/guard-verdict",
  "kid-tutor/tool-denied",
  "kid-tutor/quota",
  "kid-tutor/python-run",
] as const;

export type KidTutorEventType = (typeof KID_TUTOR_EVENT_TYPES)[number];
