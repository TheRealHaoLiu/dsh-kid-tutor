/**
 * Read-side tolerance for kid sessions written before the `events.ts`
 * sidecar fix (see `dsh-kid-tutor/src/events.ts`'s module doc and
 * docs/dsh-seams.md §7 "Known deviation"). Those sessions still carry
 * `kid-tutor/*` events INLINE in dsh's own session log, without an
 * `ignorable` marker — `PersistenceCoordinator.assertEventsSupported`
 * (`@deepseek-ai/dsh-session-persistence`) refuses to interpret them, so
 * `ctx.sessionQuery.readSession()` throws a `SessionQueryError` with code
 * `SESSION_QUERY_PERSISTENCE_FAILED`.
 *
 * This module recovers them anyway, using dsh's OWN sanctioned bypass for
 * exactly this situation — never a monkey-patch of dsh internals:
 *
 * - `ctx.sessionPersistence.readRaw(id)` (`@deepseek-ai/dsh-session-persistence`'s
 *   `SessionPersistence.readRaw`/`supportsRawArtifacts`, documented as
 *   returning "the exact durable bytes the backend wrote... without
 *   reconstructing from parsed events" — i.e. it never calls
 *   `assertEventsSupported`, and never runs the coordinator's replay/
 *   invariant validation either) decompresses the on-disk `.jsonl(.zstd)`
 *   artifact and hands back its verbatim JSONL text plus the header line.
 * - `decodeStorageRecord` (`@deepseek-ai/dsh-session`) is the same PURE,
 *   vocabulary-blind per-line decoder the JSONL backend itself uses below
 *   the coordinator layer — it expands a packed chunk-run row back to its
 *   member events, or passes any other line through unchanged. It never
 *   consults `KNOWN_SESSION_EVENT_TYPES`.
 *
 * The cost: this bypasses the coordinator's own contiguity/replay/invariant
 * checks entirely, so a genuinely torn or corrupt log will not fail loudly
 * here the way `readSession` would — acceptable for a read-only analyst
 * fallback used only after the strict path has already refused, never as
 * the default path.
 * @module dsh-kid-tutor-admin/raw-session-read
 */

import type { Context } from "@deepseek-ai/cordis";
import { decodeStorageRecord, type SessionEvent, type SessionHeader, type SessionId } from "@deepseek-ai/dsh-session";
// Side-effect-only: pulls in `declare module '@deepseek-ai/cordis' { interface
// Context { sessionPersistence: ... } }` so `ctx.sessionPersistence` below
// type-checks under `tsconfig.build.json` too, which (unlike `tsconfig.json`)
// excludes `tests/` — the only place that ambient augmentation was otherwise
// reachable from. Same pattern `kid-store.ts` already uses for `ctx.sessionQuery`.
import type {} from "@deepseek-ai/dsh-session-persistence";
import { SessionQueryError, type SessionLogSnapshot } from "@deepseek-ai/dsh-session-query";

/**
 * Read one session log, preferring the fast strict path
 * (`ctx.sessionQuery.readSession`) and falling back to the raw-artifact
 * decode only when the strict path refuses specifically because of an
 * unrecognized-and-not-ignorable event type (`SESSION_QUERY_PERSISTENCE_FAILED`).
 * Any other failure (session truly absent, aborted, genuinely corrupt)
 * propagates unchanged — the fallback is a vocabulary workaround, not a
 * general error swallower.
 */
export async function readSessionTolerant(
  ctx: Context,
  sessionId: SessionId,
): Promise<SessionLogSnapshot> {
  try {
    return await ctx.sessionQuery.readSession(sessionId);
  } catch (error) {
    if (!isUnsupportedVocabularyFailure(error)) throw error;
    const raw = await readRawSessionLog(ctx, sessionId);
    if (raw === undefined) throw error;
    return raw;
  }
}

/** True for the specific "unknown event type, not marked ignorable" refusal this module works around. */
function isUnsupportedVocabularyFailure(error: unknown): boolean {
  return (
    error instanceof SessionQueryError &&
    error.code === "SESSION_QUERY_PERSISTENCE_FAILED"
  );
}

/**
 * Decode a session's on-disk log directly, bypassing the strict
 * vocabulary/replay validation entirely (see module doc). Returns
 * `undefined` when the backend has no raw artifact for this id (never
 * materialized, or the backend does not support raw reads at all).
 */
export async function readRawSessionLog(
  ctx: Context,
  sessionId: SessionId,
): Promise<SessionLogSnapshot | undefined> {
  if (!ctx.sessionPersistence.supportsRawArtifacts) return undefined;
  const raw = await ctx.sessionPersistence.readRaw(sessionId);
  if (raw === undefined) return undefined;
  const lines = raw.content.split("\n");
  const events: SessionEvent[] = [];
  // Line 0 is the header line (`raw.meta`, parsed by the backend itself);
  // every subsequent non-empty line is one storage record.
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    events.push(...decodeStorageRecord(parsed));
  }
  return { session: raw.meta as SessionHeader, events };
}
