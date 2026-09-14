/**
 * Host-plane plugin publishing `ctx.kidAdminConfig`: the ONE validated,
 * patchable config row (`kidSessionsDir`/`timezone`/`defaultSince`) other
 * rows in this bundle's `cordis.patch.yml` read from. Kept host-plane (not
 * inside the isolated `kid-store` realm) so `profiles/kid-admin/cordis.patch.yml`
 * — a HOST-PLANE patch (docs/dsh-seams.md §1b) — can override it wholesale,
 * exactly the "kidSessionsDir row" docs/CONTRACT.md calls for.
 * @module dsh-kid-tutor-admin/kid-admin-config
 */

import type { Context } from "@deepseek-ai/cordis";
import { Config, type KidAdminConfig } from "./config.ts";

export type { KidAdminConfig } from "./config.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    kidAdminConfig: KidAdminConfig;
  }
}

export const name = "dsh-kid-tutor-admin/kid-admin-config";

export function apply(
  ctx: Context,
  config: Partial<KidAdminConfig> = {},
): void {
  const validated = Config(config);
  ctx.provide("kidAdminConfig", validated);
}
