/**
 * Public entry point. Nothing in this package's `dsh.bundle.patch`
 * (cordis.patch.yml) references this module directly — the bundle patch only
 * inserts the existing `@deepseek-ai/dsh-web-fetch-http` row, and the preset
 * (`presets/kid/agent.cordis.yml`) references each plugin file directly by
 * relative path, per docs/dsh-seams.md §1b. This barrel exists for tests, for
 * anything that wants the shared config/paths/net/events utilities, and as
 * documentation of the package's public surface.
 *
 * @module dsh-kid-tutor
 */

export * from "./config.ts";
export * from "./paths.ts";
export * from "./net.ts";
export * from "./events.ts";

export * as toolPolicy from "./tool-policy.ts";
export * as workspaceFence from "./workspace-fence.ts";
export * as runPython from "./run-python.ts";
export * as personaName from "./persona-name.ts";
export * as outputGuard from "./output-guard.ts";
export * as quota from "./quota.ts";
