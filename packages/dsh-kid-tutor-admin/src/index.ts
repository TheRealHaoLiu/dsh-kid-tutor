/**
 * Bundle entry point (`package.json` `main`). This is the module the
 * `kid-admin-config` row in `cordis.patch.yml` resolves via the bare
 * specifier `dsh-kid-tutor-admin` — its named `name`/`apply` exports ARE the
 * plugin (docs/dsh-seams.md §1a), matching `dsh-model-env`'s reference shape.
 *
 * Also re-exports the package's public surface for anything that imports
 * `dsh-kid-tutor-admin` directly (tests, other tooling).
 * @module dsh-kid-tutor-admin
 */

export { name, apply } from "./kid-admin-config.ts";
export type { KidAdminConfig } from "./config.ts";
export {
  Config,
  resolveSince,
  formatTimestamp,
  dayKey,
  defaultKidSessionsDir,
} from "./config.ts";
export { KID_TUTOR_EVENT_TYPES } from "./kid-tutor-events.ts";
export type { KidTutorEventType } from "./kid-tutor-events.ts";
export { KidStore } from "./kid-store.ts";
export type {
  SessionSummary,
  ListSessionsOptions,
  ReadSessionOptions,
  GuardEventRecord,
  ToolDeniedRecord,
  QuotaEventRecord,
  PythonRunRecord,
  DailyStats,
} from "./kid-store.ts";
export {
  renderContent,
  renderTranscript,
  firstUserMessagePreview,
  preview,
  isDirectUserMessage,
} from "./session-render.ts";
export { buildDigest } from "./digest.ts";
