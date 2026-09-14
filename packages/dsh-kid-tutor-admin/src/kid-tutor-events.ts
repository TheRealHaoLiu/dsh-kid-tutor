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
