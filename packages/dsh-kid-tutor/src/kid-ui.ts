/**
 * `kid-ui` — a minimal, knob-free front end for the kid, served from the
 * SAME `@deepseek-ai/dsh-host-webserver` instance the stock dsh web UI uses
 * (host-plane plugin; belongs in the bundle patch, not the preset).
 *
 * Why an exact route beats disabling the stock frontend row (docs/dsh-seams.md
 * §8): `WebServer.match()` (`@deepseek-ai/dsh-host-webserver`) checks the
 * `exact` table BEFORE falling back to whatever claimed the single fallback
 * seat, regardless of plugin load order. `@deepseek-ai/dsh-web-app` claims
 * that fallback seat with `@deepseek-ai/dsh-host-frontend-static` (serving the
 * stock knobby chat dist) via a nested `ctx.plugin()` call inside its own
 * `apply()` — it has no independent row id a patch could target, and
 * `web-runtime`'s own row can't be disabled outright because other rows
 * (`connection`, the URL-line/browser-handoff logic) `inject: ['webRuntime']`
 * from it. Registering an EXACT route at `config.path` (default `/`) sidesteps
 * all of that with zero edits to any dsh-owned row: our page always wins at
 * that path, and since the stock dist's own index.html is reachable ONLY at
 * the webserver's root/index paths (`@deepseek-ai/dsh-host-frontend-static`'s
 * `serveStatic`: any other miss is a 404), claiming `/` makes the stock
 * knobby UI unreachable by navigation too — no model picker, no preset
 * picker, no trajectory viewer, no settings, no workspace picker ever loads.
 * `/api/*` (session RPC + the `events.mux` WebSocket) is untouched: this
 * plugin only ever ADDS routes, never removes one.
 *
 * The page itself (`src/kid-ui/index.html`, read fresh on every plugin
 * activation — never bundled/transformed) talks to the exact same session API
 * the stock UI uses: `POST /api/session.create` (routed here through
 * `/kid/session` instead, so workspace root and agent preset are pinned
 * server-side and never client input — task requirement: "reject any
 * client-supplied override"), `POST /api/session.prompt`, `POST
 * /api/session.history`, and the `/api/events.mux` WebSocket for streamed
 * `assistant/chunk` / `tool/call` / `tool/result` / `assistant/message`
 * events. Verified against `packages/client/connection/src/{index,rpc-host,
 * api-request-trust}.ts` and `packages/host/apiproxy/src/api/sessions.ts` in
 * the deepseek-harness checkout — see docs/dsh-seams.md §8 for the pointer.
 *
 * @module dsh-kid-tutor/kid-ui
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-host-apiproxy";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { KidNameSchema, WorkspaceRootSchema, resolveWorkspaceRoot } from "./config.ts";
import { resolveKidName } from "./persona-name.ts";

export const name = "dsh-kid-tutor/kid-ui";
export const inject = ["webServer", "apiProxy"] as const;

export interface Config {
  /** Set false to mount no routes at all (an escape hatch, not a knob the kid sees). */
  enabled?: boolean;
  /** Exact webserver path the kid's page is served at. Default `/` — see module doc for why that's safe. */
  path?: string;
  /** Fixed server-side workspace every kid session is created against. Empty resolves to `$DSH_HOME/workspace`. */
  workspaceRoot?: string;
  /** Fixed server-side agent preset id every kid session is created with. */
  presetId?: string;
  /** Same precedence as `persona-name`'s: `$KID_NAME` env, then this, then "friend". */
  kidName?: string;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default("/"),
  workspaceRoot: WorkspaceRootSchema,
  presetId: z.string().default("kid"),
  kidName: KidNameSchema,
});

const MAX_SESSION_BODY_BYTES = 16 * 1024;

/**
 * Read `src/kid-ui/index.html` fresh on every activation. The html is never
 * compiled (`tsconfig.build.json`'s `include` is `src/**\/*.ts` only), so it
 * stays only under `src/` regardless of whether this module runs as the
 * built `dist/kid-ui.js` (the real preset row: `../src/kid-ui/index.html`
 * from `dist/`) or as `src/kid-ui.ts` directly (`./kid-ui/index.html`, e.g. a
 * vitest import that never touches `dist/`). Try both rather than branching
 * on path shape, which would misfire if the repo checkout path itself
 * contained the word "dist".
 */
function loadHtml(): string {
  const candidates = [
    fileURLToPath(new URL("../src/kid-ui/index.html", import.meta.url)),
    fileURLToPath(new URL("./kid-ui/index.html", import.meta.url)),
  ];
  const htmlPath = candidates.find((candidate) => existsSync(candidate));
  if (htmlPath === undefined) {
    throw new Error(`dsh-kid-tutor/kid-ui: could not find kid-ui/index.html near ${candidates.join(" or ")}`);
  }
  return readFileSync(htmlPath, "utf8");
}

/**
 * Collect a request body up to a small cap (this route only ever carries an
 * optional session id) and parse it as JSON; an empty body parses as `{}`.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_SESSION_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Strip an untrusted `/kid/session` POST body down to the one field it may
 * legitimately carry: a previously issued `sessionId`, so a returning kid
 * resumes their session instead of getting a fresh one every page load
 * (`session.create` is idempotent for a retry with the same id+cwd — see
 * `packages/host/apiproxy/src/api/sessions.ts` "Creates a real session").
 * Anything else in the body (a `cwd`, `workspaceId`, or `agentPreset`
 * override) is silently discarded — those are server-side facts set from
 * this plugin's own config, never client input.
 */
export function sanitizeSessionRequestBody(body: unknown): { sessionId?: string } {
  if (typeof body !== "object" || body === null) return {};
  const raw = (body as Record<string, unknown>).sessionId;
  return typeof raw === "string" && raw.trim().length > 0 ? { sessionId: raw } : {};
}

/**
 * Mount the kid's page and its two tiny server-side routes. Everything else
 * (creating messages, reading history, streaming events) goes straight to
 * dsh's own `/api/*` surface the browser already has same-origin access to.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return;

  const path = config.path ?? "/";
  const workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot);
  const presetId = config.presetId ?? "kid";
  const kidName = resolveKidName({ kidName: config.kidName });
  const html = loadHtml();

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(req.method === "HEAD" ? undefined : html);
        },
      }),
    "dsh-kid-tutor/kid-ui: page route",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/kid/config",
        handler: (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405);
            res.end();
            return;
          }
          sendJson(res, 200, { kidName });
        },
      }),
    "dsh-kid-tutor/kid-ui: /kid/config route",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/kid/session",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { error: "invalid request body" });
            return;
          }
          const { sessionId } = sanitizeSessionRequestBody(body);
          const response = await ctx.apiProxy.sessions.create({
            rpcId: RpcId(randomUUID()),
            payload: {
              cwd: workspaceRoot,
              agentPreset: presetId,
              // Brand cast at this one call site, same convention as
              // `sessions.schema.ts`'s own `sessionIdSchema` — the only place
              // a client-supplied string becomes a SessionId.
              ...(sessionId === undefined ? {} : { sessionId: sessionId as unknown as SessionId }),
            },
          });
          sendJson(res, 200, response.result);
        },
      }),
    "dsh-kid-tutor/kid-ui: /kid/session route",
  );
}
