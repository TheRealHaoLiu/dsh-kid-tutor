/**
 * Config schema for the dsh-kid-tutor-admin bundle.
 *
 * `kidSessionsDir` is the one load-bearing knob: it must point at the SAME
 * `root` the kid profile's `@deepseek-ai/dsh-session-persistence-jsonl` row
 * uses (CONTRACT.md "Two DSH homes, hard separation"). Everything here is a
 * plain config row a profile's `cordis.patch.yml` can override wholesale
 * (docs/dsh-seams.md §1c: "a patch replaces the targeted row's whole config").
 * @module dsh-kid-tutor-admin/config
 */

import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Default kid sessions root, matching CONTRACT.md's "Config defaults". */
export function defaultKidSessionsDir(): string {
  return join(homedir(), ".dsh-kid", "sessions");
}

/** Validated admin-bundle configuration. */
export interface KidAdminConfig {
  /**
   * Absolute path to the kid profile's `$DSH_HOME/sessions` directory. The
   * admin process mounts a second, read-only
   * `@deepseek-ai/dsh-session-persistence-jsonl` backend pointed here
   * (docs/dsh-seams.md §7 "packages/session-query — reading another
   * profile's store read-only"). Never written to.
   */
  kidSessionsDir: string;
  /**
   * IANA timezone used to bucket `stats()` counts by local day. Empty string
   * (the default) means "the admin process's own local timezone."
   */
  timezone: string;
  /**
   * Default lookback window for tools/methods that accept an optional
   * `since`, as a duration string (`"<n>h"`, `"<n>d"`, `"<n>m"`) or an ISO
   * 8601 timestamp. See {@link resolveSince}.
   */
  defaultSince: string;
}

/** Schemastery config for `KidAdminConfig`, matching how dsh's own plugins validate config (e.g. `dsh-tool-goal`'s `Config`). Input is partial (every field has a runtime default); output is the fully-resolved `KidAdminConfig`. */
export const Config: z<Partial<KidAdminConfig>, KidAdminConfig> = z.object({
  kidSessionsDir: z.string().default(defaultKidSessionsDir()),
  timezone: z.string().default(""),
  defaultSince: z.string().default("24h"),
});

const DURATION_RE = /^(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

/**
 * Resolve a `since` argument (relative duration, absolute ISO timestamp, or
 * `undefined`) to an epoch-ms cutoff, falling back to `config.defaultSince`.
 * Never throws: an unparsable string falls back to the default window too,
 * since a guard/digest tool must fail open to "show recent stuff", not closed
 * with an error the model has to explain to the parent.
 */
export function resolveSince(
  since: string | undefined,
  defaultSince: string,
  now: number = Date.now(),
): number {
  const raw = since?.trim();
  if (raw !== undefined && raw.length > 0) {
    const parsed = parseSinceValue(raw, now);
    if (parsed !== undefined) return parsed;
  }
  return parseSinceValue(defaultSince, now) ?? now - 24 * 3_600_000;
}

function parseSinceValue(value: string, now: number): number | undefined {
  const duration = DURATION_RE.exec(value);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unitKey = (duration[2] ?? "").toLowerCase().replace(/s$/, "");
    const unitMs = UNIT_MS[unitKey] ?? UNIT_MS[unitKey.slice(0, 1)];
    if (unitMs !== undefined && Number.isFinite(amount))
      return now - amount * unitMs;
  }
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.valueOf())) return asDate.valueOf();
  return undefined;
}

/** Format an epoch-ms timestamp for display, in `config.timezone` when set. */
export function formatTimestamp(epochMs: number, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timezone.length > 0 ? { timeZone: timezone } : {}),
  };
  return new Intl.DateTimeFormat("en-CA", options)
    .format(new Date(epochMs))
    .replace(",", "");
}

/** Format an epoch-ms timestamp as a local calendar day key (`YYYY-MM-DD`), in `timezone` when set. */
export function dayKey(epochMs: number, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timezone.length > 0 ? { timeZone: timezone } : {}),
  };
  return new Intl.DateTimeFormat("en-CA", options).format(new Date(epochMs));
}
