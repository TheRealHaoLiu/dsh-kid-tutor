/**
 * `workspace-fence` — confines the kid's fs/search tools (`read`, `write`,
 * `edit`, `read_image`, `glob`, `grep`) to `workspaceRoot` and blocks any
 * attempt to escalate past the standing sandbox mode.
 *
 * ## Known deviation from the original brief, and why
 *
 * The brief asked for this to be built on the `fs/write-intent` and
 * `fs/edit-intent` waterfalls. Having read `packages/fs/fs/src/index.ts` and
 * `types.ts` in the dsh monorepo, those two waterfalls are NOT an access-
 * control seam: `FsWriteIntent` is `{ kind: 'createIfAbsent' } | { kind:
 * 'replaceIfVersion'; version }` — a STALE-WRITE guard (create-only vs
 * optimistic-concurrency replace), not an allow/deny decision, and there is
 * no reject arm in either type. Using them here would not do what the brief
 * asked for.
 *
 * The actual confinement mechanism the harness ships is the
 * `@deepseek-ai/dsh-fs-sandbox` backend (`SandboxedFileSystem`) plus
 * `ctx.sandboxPolicy`'s `workspaceRoot`/`mode` — both HOST-plane rows the
 * `kid` profile patches directly (see profiles/kid/cordis.patch.yml). That
 * backend is the primary fence for `write`/`edit`. This plugin adds three
 * things on top of it, all things that backend's own README documents as
 * gaps or that a preset cannot otherwise close:
 *
 * 1. **Reads are not confined at all.** `dsh-fs-sandbox`'s README says
 *    outright: "Reads always pass through — every mode permits reading." A
 *    kid tutor must not be able to read arbitrary files on the parent's
 *    account (DESIGN.md §7's phase-2 threat model), so `read`/`read_image`
 *    need their own check.
 * 2. **Escalation must be fully closed, not just asked about.** `dsh-tool-fs`
 *    always advertises `sandbox_permissions`/`justification` once a confining
 *    backend is mounted, and approves a wider mode through `ctx.approval` —
 *    which for a web session is a UI prompt the kid themselves would see and
 *    could click. There is no parent in the loop to approve or deny it. This
 *    plugin denies any call carrying either argument outright, before the
 *    escalation flow can start.
 * 3. **A synchronous, symlink-safe re-check independent of the fs backend**,
 *    so confinement does not rest on one component alone (DESIGN.md's "every
 *    property enforced by a harness plugin or it does not exist").
 *
 * Registered on `tools/pre-execute` (not `ctx.tools.guard()`) because the
 * containment check needs `fs.realpath`, which is async; `guard()` is
 * synchronous-only (docs/dsh-seams.md §4).
 *
 * @module dsh-kid-tutor/workspace-fence
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import { WorkspaceRootSchema, resolveWorkspaceRoot } from "./config.ts";
import { resolveWithinRoot } from "./paths.ts";
import { kidTutorEvents, UNKNOWN_TURN_STEP } from "./events.ts";

export const name = "dsh-kid-tutor/workspace-fence";
export const inject = ["tools"] as const;

export interface Config {
  workspaceRoot?: string;
}

export const Config: z<Config> = z.object({
  workspaceRoot: WorkspaceRootSchema,
});

/**
 * fs/search tools this plugin fences, mapped to the argument field that
 * carries the model-supplied path. `read`/`write`/`edit`/`read_image` use
 * `file_path` (`packages/fs/tool-fs/src/{read,write,edit}.ts`); `glob`/`grep`
 * (`@deepseek-ai/dsh-tool-fs-search`) use `path`, optional and defaulting to
 * the session workspace when omitted — so an omitted `path` is left to that
 * default rather than denied.
 */
const FENCED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["read", "file_path"],
  ["write", "file_path"],
  ["edit", "file_path"],
  ["read_image", "file_path"],
  ["glob", "path"],
  ["grep", "path"],
]);

interface FsToolArgs {
  file_path?: unknown;
  path?: unknown;
  sandbox_permissions?: unknown;
  justification?: unknown;
}

export function apply(ctx: Context, config: Config = {}): void {
  const workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot);

  ctx.on("tools/pre-execute", async (exec, next): Promise<PreToolDecision> => {
    const pathField = FENCED_TOOLS.get(exec.name);
    if (pathField === undefined) return next();
    const args = exec.arguments as FsToolArgs | undefined;
    const session = exec.agent?.session;

    if (args?.sandbox_permissions !== undefined || args?.justification !== undefined) {
      if (session !== undefined) {
        kidTutorEvents.toolDenied(session, {
          tool: exec.name,
          reason: "sandbox escalation is not available in this deployment",
          ...UNKNOWN_TURN_STEP,
        });
      }
      return {
        kind: "deny",
        reason:
          "I can only work inside your project folder, and I can't ask for wider access here. Let's find another way to do this.",
      };
    }

    const rawPath = (args as Record<string, unknown> | undefined)?.[pathField];
    const filePath = typeof rawPath === "string" ? rawPath : undefined;
    if (filePath === undefined) return next();

    const check = await resolveWithinRoot(workspaceRoot, filePath);
    if (!check.ok) {
      if (session !== undefined) {
        kidTutorEvents.toolDenied(session, {
          tool: exec.name,
          reason: check.reason ?? "path resolves outside the workspace",
          path: filePath,
          ...UNKNOWN_TURN_STEP,
        });
      }
      return {
        kind: "deny",
        reason: "I can only read and write files inside your own project folder.",
      };
    }

    return next();
  });
}
