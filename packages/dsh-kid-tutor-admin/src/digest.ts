/**
 * Deterministic, no-model-call digest composition — the `kid_digest` tool's
 * whole implementation lives here as pure functions over already-fetched
 * records, so it is unit-testable without booting anything.
 * @module dsh-kid-tutor-admin/digest
 */

import type {
  AlertRecord,
  DailyStats,
  GuardEventRecord,
  PythonRunRecord,
  QuotaEventRecord,
  SessionSummary,
  ToolDeniedRecord,
} from "./kid-store.ts";
import { formatTimestamp } from "./config.ts";

export interface DigestInput {
  since: string;
  sessions: SessionSummary[];
  guardEvents: GuardEventRecord[];
  deniedTools: ToolDeniedRecord[];
  quotaEvents: QuotaEventRecord[];
  pythonRuns: PythonRunRecord[];
  alerts: AlertRecord[];
  stats: DailyStats[];
  timezone: string;
}

/** Compose the plain-text digest: a "Needs a look" heading (alerts + severity>=1 verdicts) up top, then sessions, topics, guard fires, denials, quota hits, python runs. */
export function buildDigest(input: DigestInput): string {
  const lines: string[] = [];
  lines.push(`Kid tutor digest since ${input.since}`);
  lines.push("");

  const notableGuardEvents = input.guardEvents.filter(
    (event) => event.severity !== undefined && event.severity >= 1,
  );
  if (input.alerts.length > 0 || notableGuardEvents.length > 0) {
    lines.push("Needs a look");
    for (const alert of input.alerts) {
      const when = formatTimestamp(alert.time, input.timezone);
      lines.push(
        `  - [${when}] ALERT ${alert.sessionId} turn ${alert.turn}: ${alert.category} (severity ${alert.severity}) — ${alert.delivered ? "delivered" : `NOT delivered${alert.error !== undefined ? ` (${alert.error})` : ""}`} — ${alert.kidMessagePreview}`,
      );
    }
    for (const event of notableGuardEvents) {
      const when = formatTimestamp(event.time, input.timezone);
      lines.push(
        `  - [${when}] GUARD ${event.sessionId} turn ${event.turn}: ${event.category ?? "none"} (severity ${event.severity}) — ${event.stage} → ${event.verdict}${
          event.reason !== undefined ? ` (${event.reason})` : ""
        }`,
      );
    }
    lines.push("");
  }

  lines.push(`Sessions: ${input.sessions.length}`);
  if (input.sessions.length > 0) {
    lines.push("Topics (first message per session):");
    for (const session of input.sessions) {
      const when = formatTimestamp(session.started, input.timezone);
      const topic =
        session.firstUserMessagePreview ?? "(no direct kid message)";
      lines.push(
        `  - [${when}] ${session.id} (${session.turnCount} turns): ${topic}`,
      );
    }
  }
  lines.push("");

  lines.push(`Guard fires (non-pass): ${input.guardEvents.length}`);
  for (const event of input.guardEvents) {
    const when = formatTimestamp(event.time, input.timezone);
    lines.push(
      `  - [${when}] ${event.sessionId} turn ${event.turn}: ${event.stage} → ${event.verdict}${
        event.category !== undefined
          ? ` [${event.category}, severity ${event.severity}]`
          : ""
      }${event.reason !== undefined ? ` (${event.reason})` : ""}`,
    );
  }
  lines.push("");

  lines.push(`Alerts: ${input.alerts.length}`);
  for (const alert of input.alerts) {
    const when = formatTimestamp(alert.time, input.timezone);
    lines.push(
      `  - [${when}] ${alert.sessionId} turn ${alert.turn}: ${alert.category} (severity ${alert.severity}) — ${
        alert.delivered
          ? "delivered"
          : `NOT delivered${alert.error !== undefined ? ` (${alert.error})` : ""}`
      }`,
    );
  }
  lines.push("");

  lines.push(`Denied tool calls: ${input.deniedTools.length}`);
  for (const denial of input.deniedTools) {
    const when = formatTimestamp(denial.time, input.timezone);
    const target = denial.url ?? denial.path ?? "";
    lines.push(
      `  - [${when}] ${denial.sessionId}: ${denial.tool}${target ? ` ${target}` : ""} — ${denial.reason}`,
    );
  }
  lines.push("");

  lines.push(`Quota hits: ${input.quotaEvents.length}`);
  for (const quota of input.quotaEvents) {
    const when = formatTimestamp(quota.time, input.timezone);
    lines.push(
      `  - [${when}] ${quota.sessionId}: ${quota.kind} ${quota.used}/${quota.limit}`,
    );
  }
  lines.push("");

  lines.push(`Python runs: ${input.pythonRuns.length}`);
  for (const run of input.pythonRuns) {
    const when = formatTimestamp(run.time, input.timezone);
    lines.push(
      `  - [${when}] ${run.sessionId}: ${run.file ?? "<stdin>"} exit=${run.exitCode} ${run.durationMs}ms${
        run.truncated ? " (truncated)" : ""
      }`,
    );
  }
  lines.push("");

  lines.push("Daily counts:");
  for (const day of input.stats) {
    lines.push(
      `  - ${day.day}: ${day.sessions} sessions, ${day.turns} turns, ${day.guardFires} guard fires, ` +
        `${day.toolDenials} denials, ${day.quotaHits} quota hits, ${day.pythonRuns} python runs`,
    );
  }

  return lines.join("\n");
}
