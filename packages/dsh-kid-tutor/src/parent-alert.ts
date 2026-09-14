/**
 * `parent-alert` — a `ParentAlertService` (`ctx.parentAlert`) that
 * `output-guard` calls when the judge classifies an exchange as alert-worthy
 * (`severity >= alertSeverity`). POSTs a short plain-text notice to
 * `alertWebhookUrl` (an ntfy topic URL, a generic webhook, anything that
 * accepts a POST body) with a 5 s timeout; a missing/empty URL disables
 * alerting entirely rather than throwing, so this row is safe to mount with
 * no config at all.
 *
 * Exported as a `Service` subclass with a default export — the same shape
 * `quota.ts`'s `KidQuotaService` uses — so `output-guard` can
 * `inject: ['parentAlert']` and call `ctx.parentAlert.send(...)` /
 * `.shouldAlert(...)` / `.disclosure`.
 *
 * ## Known deviation: the webhook URL cannot live in the profile patch either
 *
 * The team brief says "The URL/headers live in the PROFILE patch (private),
 * never in repo defaults" — but this row is a PRESET row (it must react to
 * judge output inside an agent turn), and per `persona-name.ts`'s "Known
 * deviation" note, a profile's `cordis.patch.yml` cannot reach a row inside
 * an agent preset at all (host-plane vs. agent-plane). Same fix as
 * `persona-name.ts`'s `kidName`: read `KID_ALERT_WEBHOOK_URL` (and, if
 * needed, `KID_ALERT_WEBHOOK_HEADERS` as a JSON object string) from the
 * environment at apply time. `scripts/install.sh` does not set these —
 * that's the parent's own choice to wire up, exactly like `KID_NAME`.
 *
 * @module dsh-kid-tutor/parent-alert
 */

import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AlertSchema } from "./config.ts";
import type { AlertConfig, GuardCategory } from "./config.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    parentAlert: ParentAlertService;
  }
}

export type Config = AlertConfig;

/** `KID_ALERT_WEBHOOK_URL` / `KID_ALERT_WEBHOOK_HEADERS` env vars, then config, then disabled. */
export function resolveAlertWebhookUrl(config: Partial<Config>, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KID_ALERT_WEBHOOK_URL?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return config.alertWebhookUrl ?? "";
}

export function resolveAlertWebhookHeaders(
  config: Partial<Config>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const fromEnv = env.KID_ALERT_WEBHOOK_HEADERS?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    try {
      const parsed: unknown = JSON.parse(fromEnv);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Object.values(parsed).every((value) => typeof value === "string")
      ) {
        return parsed as Record<string, string>;
      }
    } catch {
      // fall through to config
    }
  }
  return config.alertHeaders ?? {};
}

export interface AlertSendParams {
  category: GuardCategory;
  severity: number;
  /** Already truncated by the caller (output-guard truncates to 200 chars). */
  excerpt: string;
}

export interface AlertSendResult {
  delivered: boolean;
  error?: string;
}

const ALERT_TIMEOUT_MS = 5_000;

export class ParentAlertService extends Service {
  static Config: z<Config> = AlertSchema;

  private readonly severityThreshold: number;
  private readonly webhookUrl: string;
  private readonly headers: Record<string, string>;
  readonly disclosure: boolean;

  constructor(ctx: Context, config: Config) {
    super(ctx, "parentAlert");
    const resolved = config as Required<Config>;
    this.severityThreshold = resolved.alertSeverity;
    this.webhookUrl = resolveAlertWebhookUrl(resolved);
    this.headers = resolveAlertWebhookHeaders(resolved);
    this.disclosure = resolved.alertDisclosure;
  }

  /** Whether `severity` clears the configured threshold AND a webhook is actually configured. */
  shouldAlert(severity: number): boolean {
    return this.webhookUrl.length > 0 && severity >= this.severityThreshold;
  }

  /**
   * Best-effort webhook POST. Never throws/rejects — every failure path
   * (disabled, timeout, network error, non-2xx) resolves to
   * `{ delivered: false, error }` so a caller can fire-and-forget this
   * safely (`output-guard` never awaits it inline; see its file header).
   */
  async send(params: AlertSendParams): Promise<AlertSendResult> {
    if (this.webhookUrl.length === 0) return { delivered: false, error: "no webhook configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
    try {
      const body = [
        "[dsh-kid-tutor] parent alert",
        `time: ${new Date().toISOString()}`,
        `category: ${params.category}`,
        `severity: ${params.severity}`,
        "",
        params.excerpt,
      ].join("\n");
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8", ...this.headers },
        body,
        signal: controller.signal,
      });
      if (!response.ok) return { delivered: false, error: `HTTP ${response.status}` };
      return { delivered: true };
    } catch (error) {
      return { delivered: false, error: (error as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export default ParentAlertService;
