/**
 * `quota` — a per-local-day turn cap plus an evening cutoff window, both
 * enforced on `agent/pre-step` (docs/dsh-seams.md §6), and a `ctx.kidQuota`
 * service exposing `charge()` so `output-guard`'s nested judge calls count
 * against the same daily budget (DESIGN.md §4: "the quota counts both").
 *
 * Exported as a `Service` subclass with a default export, the same shape the
 * harness's own backend plugins use (e.g. `dsh-fs-local`'s
 * `export default LocalFileSystem`) — this is what lets a sibling plugin in
 * the same preset `inject: ['kidQuota']` and call `ctx.kidQuota.charge()`.
 *
 * Per docs/dsh-seams.md §6, a bare `agent/pre-step` reject is silent (no
 * `step/start`/`step/end`, no model call — "the UI sees a turn that produced
 * nothing"). To make the cutoff/limit visible, this appends a plugin-sourced
 * `user/message` notice (zero tokens spent) before rejecting, exactly the
 * pattern the doc attributes to `plan-mode`'s own notice-then-reject code.
 *
 * @module dsh-kid-tutor/quota
 */

import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { resolveQuotaFile } from "./config.ts";
import { kidTutorEvents } from "./events.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    kidQuota: KidQuotaService;
  }
}

export interface Config {
  turnsPerDay?: number;
  cutoffStartHour?: number;
  cutoffEndHour?: number;
  quotaFile?: string;
}

interface QuotaState {
  date: string;
  used: number;
}

/** `YYYY-MM-DD` in LOCAL time (never `toISOString`, which is UTC). */
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Whether `hour` (0-23) falls in the [start, end) window, which may cross midnight. */
export function isWithinCutoff(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false; // a zero-width window never cuts off
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // crosses midnight, e.g. 21 -> 7
}

export class KidQuotaService extends Service {
  /** Picked up by the dsh loader the same way `dsh-fs-local`'s `LocalFileSystem.Config` is. */
  static Config: z<Config> = z.object({
    turnsPerDay: z.number().default(60),
    cutoffStartHour: z.number().default(21),
    cutoffEndHour: z.number().default(7),
    quotaFile: z.string().default(""),
  });

  private readonly file: string;
  private readonly turnsPerDay: number;
  private readonly cutoffStartHour: number;
  private readonly cutoffEndHour: number;
  private state: QuotaState;
  private readonly chargedTurnKeys = new Set<string>();

  constructor(ctx: Context, config: Config) {
    super(ctx, "kidQuota");
    const resolved = config as Required<Config>;
    this.file = resolveQuotaFile(resolved.quotaFile);
    this.turnsPerDay = resolved.turnsPerDay;
    this.cutoffStartHour = resolved.cutoffStartHour;
    this.cutoffEndHour = resolved.cutoffEndHour;
    this.state = this.load();

    ctx.on("agent/pre-step", async (payload, next): Promise<PreStepDecision> => {
      this.rollover();

      if (this.isCutoffNow()) {
        this.notifyAndLog(payload.agent, "cutoff");
        return { kind: "reject" };
      }
      if (this.remaining() <= 0) {
        this.notifyAndLog(payload.agent, "turn");
        return { kind: "reject" };
      }

      const dedupeKey = `${payload.agent.id}:${payload.turn}`;
      if (!this.chargedTurnKeys.has(dedupeKey)) {
        this.chargedTurnKeys.add(dedupeKey);
        this.charge();
        kidTutorEvents.quota(payload.agent.session, {
          kind: "turn",
          used: this.state.used,
          limit: this.turnsPerDay,
          turn: payload.turn,
        });
      }
      return next();
    });
  }

  private load(): QuotaState {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<QuotaState>;
      if (typeof parsed.date === "string" && typeof parsed.used === "number") {
        return { date: parsed.date, used: parsed.used };
      }
    } catch {
      // Missing, unreadable, or corrupt: fail closed to a fresh empty day
      // rather than throwing (a first run has no file at all).
    }
    return { date: localDateString(new Date()), used: 0 };
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state), "utf8");
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-kid-tutor/quota: failed to persist ${this.file}: ${(error as Error).message}`);
    }
  }

  private rollover(): void {
    const today = localDateString(new Date());
    if (this.state.date !== today) {
      this.state = { date: today, used: 0 };
      this.chargedTurnKeys.clear();
      this.persist();
    }
  }

  /** Count one unit against today's budget (a turn, or a judge call). Returns the new used count. */
  charge(): number {
    this.rollover();
    this.state.used += 1;
    this.persist();
    return this.state.used;
  }

  /** Units left today, never negative. */
  remaining(): number {
    this.rollover();
    return Math.max(0, this.turnsPerDay - this.state.used);
  }

  /** Whether the current local time falls inside the evening cutoff window. */
  isCutoffNow(now: Date = new Date()): boolean {
    return isWithinCutoff(now.getHours(), this.cutoffStartHour, this.cutoffEndHour);
  }

  private notifyAndLog(agent: Agent, kind: "turn" | "cutoff"): void {
    kidTutorEvents.quota(agent.session, {
      kind,
      used: this.state.used,
      limit: this.turnsPerDay,
      turn: 0,
    });
    const text =
      kind === "cutoff"
        ? "It's my bedtime too! Let's talk more tomorrow morning."
        : "We've used up all our chatting for today. See you tomorrow!";
    agent.session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-kid-tutor", form: "notice", summary: text },
      }),
      { surfaceOp: "append" },
    );
  }
}

export default KidQuotaService;
