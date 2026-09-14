/**
 * `persona-name` — tells the model the kid's name via config, without baking
 * it into the public preset file.
 *
 * `@deepseek-ai/dsh-persona`'s `text` template only interpolates `{{model}}`
 * and `{{cwd}}` (`packages/preset/persona/src/index.ts`) — there is no
 * generic `{{kidName}}` templating variable in the shipped template engine.
 * DESIGN.md's own rule is that the kid's name never lives in this (public)
 * repo, so the PUBLIC `presets/kid/agent.cordis.yml` persona text has to stay
 * name-agnostic. This tiny plugin is the "else via config" branch.
 *
 * ## Known deviation from docs/CONTRACT.md, and why
 *
 * CONTRACT.md says "kidName: set in the profile patch, never in the repo" —
 * but per docs/dsh-seams.md §1b, a profile's `cordis.patch.yml` reaches only
 * the HOST-plane Loader tree, while every row in THIS file is agent-plane
 * (mounted once as a standing preset subtree, per §1b's table: bundle/profile
 * patches and `--patch` overlays are all host-plane-only). There is no
 * supported mechanism for a profile patch to override one row's `config`
 * inside an agent preset. Since `presets/kid` is meant to stay a plain
 * symlink to this repo (scripts/install.sh), a per-install kidName can't live
 * in this row's own preset-file config either without forking the preset.
 *
 * The fix: read `KID_NAME` from the environment at apply time, exactly the
 * process-local-override pattern `dsh-model-env` (the reference bundle) uses
 * for `DSH_MODEL`/`DSH_PROVIDER`. `scripts/install.sh` prints the run command
 * with `KID_NAME=<name>` in front of it, so the real name lives only in how
 * the parent starts the process — never in a file this repo tracks. The
 * `kidName` config field remains as a lower-priority override/test seam.
 *
 * @module dsh-kid-tutor/persona-name
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { KidNameSchema } from "./config.ts";

export const name = "dsh-kid-tutor/persona-name";
export const inject = ["systemPrompt"] as const;

export interface Config {
  kidName?: string;
}

export const Config: z<Config> = z.object({
  kidName: KidNameSchema,
});

/** `KID_NAME` env var, then config, then the schema's own "friend" default. */
export function resolveKidName(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KID_NAME?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return config.kidName ?? "friend";
}

export function apply(ctx: Context, config: Config = {}): void {
  const kidName = resolveKidName(config);
  ctx.systemPrompt.section({
    name: "dsh-kid-tutor:kid-name",
    order: 1,
    text: `The student you are tutoring is named ${kidName}. Use their name warmly sometimes, but don't overdo it.`,
  });
}
