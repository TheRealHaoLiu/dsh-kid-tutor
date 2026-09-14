/**
 * One shared `KidTutorConfig` schema for every dsh-kid-tutor plugin row. Each
 * plugin's own `Config` schema (in its own file) picks the sub-schemas it
 * needs from here, so a default or a field name is declared exactly once and
 * every row that shares a concept (e.g. `workspaceRoot`) shares its default
 * and validation too. Matches docs/CONTRACT.md "Config defaults (all
 * patchable rows)".
 *
 * @module dsh-kid-tutor/config
 */

import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

/** Default workspace root: `$DSH_HOME/workspace` (`$HOME/.dsh-kid/workspace` for the kid profile). */
export function defaultWorkspaceRoot(): string {
  return dshHomePath("workspace");
}

/** Default on-disk location for the quota plugin's per-day turn counter. */
export function defaultQuotaFile(): string {
  return dshHomePath("kid-tutor", "quota.json");
}

/**
 * Deterministic stage-1 patterns for `output-guard`. Regex source strings
 * (not `RegExp` objects) so they serialize cleanly through YAML/JSON config
 * and schemastery. Case-insensitive by convention; each plugin compiles them
 * with the `i` flag. Intentionally coarse — profanity basics, a raw URL whose
 * host is not on the allowlist, phone-number shapes, and shell/PowerShell
 * command shapes a kid has no legitimate reason to see echoed back.
 */
export const DEFAULT_BLOCKED_PATTERNS: readonly string[] = [
  // Profanity basics (deliberately coarse; the judge stage covers nuance).
  "\\bf+u+c+k+\\b",
  "\\bs+h+i+t+\\b",
  "\\bb+i+t+c+h+\\b",
  "\\ba+s+s+h+o+l+e+\\b",
  // Phone-number shapes (NANP-ish and generic separated-digit runs).
  "\\b\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b",
  // Shell/PowerShell command shapes that should never appear in a kid's chat.
  "\\brm\\s+-rf\\b",
  "\\bformat\\s+[a-z]:\\b",
  "Remove-Item\\s+-Recurse\\s+-Force",
  "Invoke-Expression",
  "\\biex\\s*\\(",
];

/**
 * Default DeepSeek route for both the main chat model and the judge.
 *
 * `deepseek-v4-flash` was retired as an alias now served by V4.1-Flash; the
 * live route is `deepseek-flash`. Verified against
 * `packages/llm/llm-deepseek/src/index.ts` (`resolveModels()`) that the
 * adapter's `models` catalog is "advisory... shown by discovery consumers"
 * only — `stream()` forwards whatever `model` string a request carries
 * straight to the API with no membership check against that catalog — so
 * switching this default needs no matching `models` row edit anywhere.
 */
export const DEFAULT_MODEL_PROVIDER = "deepseek-official";
export const DEFAULT_MODEL_ID = "deepseek-flash";

/** Default allowlist: docs/CONTRACT.md "Config defaults". */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  "en.wikipedia.org",
  "simple.wikipedia.org",
  "bulbapedia.bulbagarden.net",
  "docs.python.org",
  "kids.britannica.com",
];

/** Shared sub-schema: the workspace root every fs/python/sandbox row confines to. */
export const WorkspaceRootSchema: z<string> = z
  .string()
  .default("") // resolved to defaultWorkspaceRoot() by each plugin's config normalizer (see resolveWorkspaceRoot below); schemastery defaults are evaluated once at schema-definition time, which would freeze DSH_HOME too early for tests that override it.
  .description(
    "Absolute path the kid's fs tools, run_python, and the fs sandbox confine to. Empty string resolves to $DSH_HOME/workspace at plugin apply time.",
  );

/** Resolve a possibly-empty configured workspace root to its effective value. */
export function resolveWorkspaceRoot(configured: string | undefined): string {
  return configured !== undefined && configured.trim().length > 0
    ? configured
    : defaultWorkspaceRoot();
}

/** Shared sub-schema: the web_fetch domain allowlist. */
export const AllowlistSchema: z<string[]> = z
  .array(z.string())
  .default([...DEFAULT_ALLOWLIST])
  .description(
    "Hostnames (exact or subdomain match) tool-policy allows web_fetch to reach.",
  );

/** Quota sub-config: daily turn cap plus the local-time evening cutoff window. */
export interface QuotaConfig {
  /** Turns per local day, judge calls counted too. */
  turnsPerDay: number;
  /** Local hour (0-23) the cutoff window starts. */
  cutoffStartHour: number;
  /** Local hour (0-23) the cutoff window ends (exclusive). May be < start (crosses midnight). */
  cutoffEndHour: number;
  /** On-disk path for the persisted per-day counter. */
  quotaFile: string;
}

export const QuotaSchema: z<QuotaConfig> = z.object({
  turnsPerDay: z.number().default(60),
  cutoffStartHour: z.number().default(21),
  cutoffEndHour: z.number().default(7),
  quotaFile: z.string().default(""), // resolved via resolveQuotaFile at apply time, same reasoning as workspaceRoot.
});

export function resolveQuotaFile(configured: string | undefined): string {
  return configured !== undefined && configured.trim().length > 0
    ? configured
    : defaultQuotaFile();
}

/** Judge sub-config: the nested classifier call's route and timeout. */
export interface JudgeConfig {
  provider: string;
  model: string;
  timeoutMs: number;
}

export const JudgeSchema: z<JudgeConfig> = z.object({
  provider: z.string().default(DEFAULT_MODEL_PROVIDER),
  model: z.string().default(DEFAULT_MODEL_ID),
  timeoutMs: z.number().default(20_000),
});

/** Shared sub-schema: stage-1 deterministic block patterns (regex source strings). */
export const BlockedPatternsSchema: z<string[]> = z
  .array(z.string())
  .default([...DEFAULT_BLOCKED_PATTERNS]);

/** Shared sub-schema: the kid's display name, used only via config (see persona-name.ts). */
export const KidNameSchema: z<string> = z.string().default("friend");

/** Shared sub-schema: the python3 binary run-python spawns. */
export const PythonBinSchema: z<string> = z.string().default("python3");

/** Pacing sub-config: the typewriter-style release rate for a guarded reply. */
export interface PacingConfig {
  /** Characters per second; 0 disables pacing (release the whole reply at once). */
  charsPerSecond: number;
}

export const PacingSchema: z<PacingConfig> = z.object({
  charsPerSecond: z.number().default(40),
});

/** Brevity sub-config: the hard output-token cap `brevity.ts` enforces via `agent/request`. */
export interface BrevityConfig {
  maxOutputTokens: number;
}

export const BrevitySchema: z<BrevityConfig> = z.object({
  maxOutputTokens: z.number().default(350),
});

/**
 * The judge's category/severity classification, persisted verbatim on every
 * `kid-tutor/guard-verdict` event (docs/CONTRACT.md). `severity` drives
 * `parent-alert`; `category` is the human-readable reason a parent reads.
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

/** Parent-alert sub-config: the severity threshold, webhook target, and disclosure policy. */
export interface AlertConfig {
  /** Minimum judge `severity` (0-2) that triggers a webhook POST. */
  alertSeverity: number;
  /** Webhook URL to POST a plain-text alert to; empty disables alerting entirely. */
  alertWebhookUrl: string;
  /** Extra headers for the webhook request (e.g. an ntfy Title/Priority pair), as a plain string map. */
  alertHeaders: Record<string, string>;
  /** Whether the kid is told an alert was sent (true) or sees the ordinary redo-prompt (false). */
  alertDisclosure: boolean;
}

export const AlertSchema: z<AlertConfig> = z.object({
  alertSeverity: z.number().default(2),
  alertWebhookUrl: z.string().default(""),
  alertHeaders: z.dict(z.string()).default({}),
  alertDisclosure: z.boolean().default(true),
});

/**
 * The full config shape, for documentation and for tests that want one
 * object. No plugin row takes this whole shape directly — each takes the
 * slice it needs, built from the same sub-schemas above.
 */
export interface KidTutorConfig {
  workspaceRoot: string;
  allowlist: string[];
  quota: QuotaConfig;
  judge: JudgeConfig;
  blockedPatterns: string[];
  kidName: string;
  pythonBin: string;
  pacing: PacingConfig;
  brevity: BrevityConfig;
  alert: AlertConfig;
}
