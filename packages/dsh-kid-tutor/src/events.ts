/**
 * The five log-only audit facts this bundle records, plus one append helper
 * per type. Shapes match docs/CONTRACT.md "Log-only session event types"
 * exactly.
 *
 * KNOWN DEVIATION from the original design (docs/dsh-seams.md §7 as first
 * written): these facts are NOT written through `Session.append()` into
 * dsh's own session log anymore. They used to be, via a
 * `declare module "@deepseek-ai/dsh-session/types"` augmentation of
 * `SessionEventMap` — the mechanism docs/dsh-seams.md §7 documented by
 * analogy with `compaction/*` and `dsh-hook-protocol`'s in-tree
 * `hook/invoked`/`hook/result`. That analogy does not hold for an
 * out-of-tree bundle: dsh's runtime reader does not consult
 * `SessionEventMap` at all when deciding whether a log is safe to
 * reconstruct. It consults a SEPARATE, generated, compile-time-fixed set,
 * `KNOWN_SESSION_EVENT_TYPES` (`@deepseek-ai/dsh-session`, built by
 * `deepseek-harness`'s own `scripts/gen-persistence-catalog.ts` from
 * `SessionEventMap` members declared *inside that repository only*). That
 * module's own top comment says so outright: "Downstream (out-of-repo)
 * plugin events are outside this list by construction; a registration
 * surface for them is deferred until such a consumer exists." A TypeScript
 * declaration merge in this package's own `.ts` files never touches that
 * generated set, so every `session.append('kid-tutor/...', ...)` call
 * produced an event `PersistenceCoordinator.assertEventsSupported`
 * (`@deepseek-ai/dsh-session-persistence`) would refuse to interpret ever
 * again — on ANY future read, including the kid harness's own process
 * resuming its own session after a restart, not just the admin bundle's
 * cross-profile read. There is also no public way to mark such an event
 * `ignorable: true` (the envelope field that WOULD have made the strict
 * reader skip it): `Session.append()`'s public signature has no parameter
 * for it, and the constructed event object never copies one in — `ignorable`
 * can only ever be set on an event supplied through a session's `seed`
 * (`Session.create`), i.e. at restore/import time, never through a live
 * `append()` call.
 *
 * Fix: these facts are written to this bundle's OWN append-only JSONL
 * sidecar file, one per session, entirely outside dsh's session log and
 * therefore immune to `assertEventsSupported` forever — for the kid's own
 * future resumes AND for the admin's reads alike. This is the same
 * "own file under `dshHomePath('kid-tutor', ...)`" pattern this bundle
 * already used for quota state (`config.ts`'s `defaultQuotaFile()`), just
 * extended to the audit trail. Sessions written BEFORE this fix still carry
 * these facts inline in dsh's own log, unrecoverable by the strict reader;
 * `dsh-kid-tutor-admin`'s `raw-session-read.ts` implements the read-side
 * fallback that recovers them anyway, via dsh's own sanctioned
 * `SessionPersistence.readRaw()`/`decodeStorageRecord()` primitives (never a
 * dsh-internals monkey-patch).
 *
 * @module dsh-kid-tutor/events
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type { Session } from "@deepseek-ai/dsh-session";
import type { GuardCategory } from "./config.ts";

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

/** The five kid-tutor log-only event type names. Mirrored by hand in the admin package's `kid-tutor-events.ts` (independent bundles, CONTRACT.md is the shared source of truth). */
export const KID_TUTOR_EVENT_TYPES = [
  "kid-tutor/guard-verdict",
  "kid-tutor/tool-denied",
  "kid-tutor/quota",
  "kid-tutor/python-run",
  "kid-tutor/alert",
] as const;

export type KidTutorEventType = (typeof KID_TUTOR_EVENT_TYPES)[number];

/** One line of a kid-tutor sidecar audit file — see module doc. */
export interface KidTutorSidecarRecord<T extends KidTutorEventType = KidTutorEventType> {
  type: T;
  time: number;
  data:
    | GuardVerdictData
    | ToolDeniedData
    | QuotaEventData
    | PythonRunData
    | AlertData;
}

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

/**
 * Root directory for every session's audit sidecar file. Resolved fresh on
 * every call (never cached) so a test's `DSH_HOME` override — or a future
 * per-process home change — is always honored (mirrors `config.ts`'s
 * `defaultQuotaFile()`/`defaultWorkspaceRoot()` comment on why these helpers
 * must not memoize).
 */
export function kidTutorEventsDir(): string {
  return dshHomePath("kid-tutor", "events");
}

/**
 * Encode a session id as one safe filename segment. Session ids are
 * harness-generated (never kid/model-controlled) so this only needs to be
 * collision-safe in practice, not a security boundary — a plain allow-list
 * substitution is enough (contrast dsh's own `encodeSegment`, which is
 * private to `dsh-session-persistence-jsonl` and injective because it also
 * guards against traversal from an untrusted id).
 */
function sidecarFilename(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}.jsonl`;
}

/** The sidecar audit-log path for one session. */
export function kidTutorSidecarPath(sessionId: string): string {
  return join(kidTutorEventsDir(), sidecarFilename(sessionId));
}

/**
 * Append one audit record to the session's sidecar file. Best-effort and
 * fail-open by design: a logging failure (disk full, permissions) must never
 * break the kid's turn — the caller sites (`output-guard.ts`, `quota.ts`,
 * `run-python.ts`, `tool-policy.ts`, `workspace-fence.ts`) all call these
 * helpers as fire-and-forget `void` calls from hot paths, exactly as they
 * did when this wrapped `Session.append()` (which could throw synchronously
 * on a non-serializable payload, but never on I/O — this preserves the same
 * "never throws for on-disk reasons" contract via try/catch instead).
 */
function appendSidecar<T extends KidTutorEventType>(
  session: Session,
  type: T,
  data: KidTutorSidecarRecord<T>["data"],
): void {
  const record: KidTutorSidecarRecord<T> = { type, time: Date.now(), data };
  const path = kidTutorSidecarPath(session.id);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(
      `dsh-kid-tutor/events: failed to append "${type}" to ${path}: ${(error as Error).message}`,
    );
  }
}

export const kidTutorEvents = {
  guardVerdict(session: Session, data: GuardVerdictData): void {
    appendSidecar(session, "kid-tutor/guard-verdict", data);
  },
  toolDenied(session: Session, data: ToolDeniedData): void {
    appendSidecar(session, "kid-tutor/tool-denied", data);
  },
  quota(session: Session, data: QuotaEventData): void {
    appendSidecar(session, "kid-tutor/quota", data);
  },
  pythonRun(session: Session, data: PythonRunData): void {
    appendSidecar(session, "kid-tutor/python-run", data);
  },
  alert(session: Session, data: AlertData): void {
    appendSidecar(session, "kid-tutor/alert", data);
  },
};
