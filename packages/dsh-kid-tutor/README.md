# dsh-kid-tutor

The kid-facing bundle + agent preset for the [dsh-kid-tutor](../../README.md) project.
See the repo root [DESIGN.md](../../DESIGN.md) for the why, [docs/CONTRACT.md](../../docs/CONTRACT.md)
for the binding shape, and [docs/dsh-seams.md](../../docs/dsh-seams.md) for the dsh API
recon this package was built against.

## Status: installs, boots, and the safety guard fires end to end

`output-guard` (the two-stage safety filter) was a silent no-op through the first build
and is now root-caused and fixed — see [docs/GUARD-BISECT.md](../../docs/GUARD-BISECT.md)
for the bisect. Every feature in this package — persona, fetch allowlist, workspace
fence, `run_python`, daily quota, the two-stage guard (deterministic + judge, redo,
category/severity classification), paced release, the brevity cap, `parent-alert`, and
`kid-ui` — has been verified working end to end against a real DeepSeek model. See
[Known gaps](#known-gaps) for what's still imperfect.

## What each plugin enforces

| Plugin | File | Enforces |
|---|---|---|
| `tool-policy` | `src/tool-policy.ts` | `web_fetch` allowlist (exact/subdomain match) plus a literal-IP / RFC1918 / loopback / link-local / `.local`/`.lan`/`.home`/`.internal` hostname denial, via `ctx.tools.guard()`. Wraps successful `web_fetch`/`web_search` results as explicitly-untrusted quoted data and strips lines shaped like prompt injection, via `tools/post-execute`. |
| `workspace-fence` | `src/workspace-fence.ts` | Confines `read`, `write`, `edit`, `read_image`, `glob`, `grep` to `workspaceRoot` with a symlink-safe realpath check (`src/paths.ts`), via `tools/pre-execute`. Denies any call carrying `sandbox_permissions`/`justification` (an escalation attempt) outright. See its file header for why this is NOT built on `fs/write-intent`/`fs/edit-intent` as originally briefed — those aren't an access-control seam. |
| `run-python` | `src/run-python.ts` | Registers a custom `run_python` tool: spawns `python3 -I` directly via `node:child_process.spawn` (explicit argv, never `shell: true`) with `cwd=workspaceRoot`, env scrubbed to `PATH`/`HOME`/`LANG`, a kill timeout (default 10s), and a 64 KiB output cap per stream with a truncation note. |
| `quota` | `src/quota.ts` | A `KidQuotaService` (`ctx.kidQuota`) persisting a per-local-day turn counter to a JSON file. `agent/pre-step` rejects a step once the daily cap is hit or the local-time cutoff window is active, first appending a plugin-sourced `user/message` notice (so the kid sees why, at zero token cost) and a `kid-tutor/quota` log event. Exposes `charge()` so `output-guard`'s judge calls count against the same budget. |
| `output-guard` | `src/output-guard.ts` | Buffers the whole reply (no streaming to the kid), runs a deterministic regex stage, then a nested judge call (strict JSON verdict, no history) that ALSO classifies the exchange into a `category`/`severity` for `parent-alert`, one redo attempt on `redo`, fail-closed replacement text on `block`/timeout/judge failure. Releases the final text word by word (`pacing.charsPerSecond`, default 40) rather than as one blob. Logs `kid-tutor/guard-verdict` for every stage including `pass`. Passes a step through byte for byte only on a genuine `error`/`aborted` finish or a `tool-call` reply — a `max-tokens` truncation still goes through the guard (see [Known gaps](#known-gaps)). See [Known gaps](#known-gaps) for why this was a no-op in the first build. |
| `brevity` | `src/brevity.ts` | Caps the main turn's output tokens via `agent/request` (`Math.min` against whatever the loop proposed — a config `maxOutputTokens`, default 350, never raises an already-tighter value). A different seam from `output-guard`'s `llm/stream`; fires only for real agent-loop turns, never the guard's own judge/redo calls. |
| `parent-alert` | `src/parent-alert.ts` | A `ParentAlertService` (`ctx.parentAlert`) `output-guard` calls when the judge's `severity` clears `alertSeverity` (default 2): POSTs a short plain-text notice (time, category, severity, the kid's triggering message) to `alertWebhookUrl` with a 5 s timeout, fire-and-forget (never blocks the kid's turn), logging `kid-tutor/alert` once the attempt settles. Disabled by default (empty URL). See its file header for why the URL/headers come from `$KID_ALERT_WEBHOOK_URL`/`$KID_ALERT_WEBHOOK_HEADERS`, not a patch file. |
| `persona-name` | `src/persona-name.ts` | Contributes a small `ctx.systemPrompt` section naming the kid, resolved from `$KID_NAME` (environment) first, then config, then `"friend"`. See its file header for why this can't just be a preset-file config value. |
| `kid-ui` | `src/kid-ui.ts` | The kid's whole front end. See [Kid UI](#kid-ui) below. |
| `events.ts` | `src/events.ts` | The four log-only `SessionEventMap` entries from `docs/CONTRACT.md` (`kid-tutor/guard-verdict`, `kid-tutor/tool-denied`, `kid-tutor/quota`, `kid-tutor/python-run`) plus one append helper per type. |
| `config.ts` | `src/config.ts` | The shared `KidTutorConfig` schema pieces (workspace root, allowlist, quota, judge, blocked patterns, kid name, python binary) every plugin's own `Config` schema is built from, so a default is declared once. |
| `net.ts` | `src/net.ts` | Pure hostname/URL classification (`checkFetchUrl`, `isAllowedHost`, `isDisallowedHost`) — the logic behind `tool-policy`'s allowlist. |
| `paths.ts` | `src/paths.ts` | `resolveWithinRoot()` — symlink-safe path containment shared by `workspace-fence` and `run-python`, built on `@deepseek-ai/dsh-home-paths`'s `canonicalizeWatchPath`. |

## Config rows and how to patch them

Every plugin's `Config` is a `schemastery` object built from the shared sub-schemas in
`src/config.ts`, so a preset row's `config:` only needs to override what it actually
wants to change; everything else keeps its documented default (`docs/CONTRACT.md`
"Config defaults"):

```yaml
- id: tool-policy
  name: '/abs/path/to/dist/tool-policy.js'
  config:
    allowlist: [en.wikipedia.org, docs.python.org]   # replaces the whole list
```

Row-by-row config shape:

- `tool-policy`: `{ allowlist?: string[] }`
- `workspace-fence`: `{ workspaceRoot?: string }`
- `run-python`: `{ workspaceRoot?: string; pythonBin?: string; timeoutMs?: number }`
- `quota` (`KidQuotaService`, a class plugin — `static Config` on the class, not a
  module-level export): `{ turnsPerDay?: number; cutoffStartHour?: number;
  cutoffEndHour?: number; quotaFile?: string }`
- `output-guard`: `{ blockedPatterns?: string[]; judge?: { provider: string; model:
  string; timeoutMs: number } }` — `judge` is whole-object-replace, not merged, matching
  the same "patch replaces the whole config" convention every dsh row follows.
  `pacing?: { charsPerSecond: number }` controls the typewriter release rate, and
  `debug: true` adds one `[kid-tutor/output-guard]` stderr line per `llm/stream`
  dispatch reporting the gate's inputs and decision — the supported way to check
  whether the listener is reached and what it did.
- `brevity`: `{ maxOutputTokens?: number }` (default 350).
- `parent-alert` (`ParentAlertService`, a class plugin — `static Config` on the class):
  `{ alertSeverity?: number; alertWebhookUrl?: string; alertHeaders?: Record<string,
  string>; alertDisclosure?: boolean }`. `$KID_ALERT_WEBHOOK_URL`/
  `$KID_ALERT_WEBHOOK_HEADERS` (a JSON object string) win over `alertWebhookUrl`/
  `alertHeaders` when set — same precedence pattern as `persona-name`'s `$KID_NAME`.
- `persona-name`: `{ kidName?: string }` (lowest-priority fallback; `$KID_NAME` wins).

`workspaceRoot` (used by `workspace-fence`, `run-python`, and — separately, at the HOST
plane — `profiles/kid/cordis.patch.yml`'s `sandbox-policy`/`fs-sandbox` rows) defaults to
`$DSH_HOME/workspace` when left empty; schemastery's own `.default()` couldn't be used
for this because it evaluates once at schema-definition time, before `$DSH_HOME` is
necessarily its final value in a test or an alternate profile.

## Kid UI

The stock dsh web UI (model picker, preset picker, trajectory viewer, settings,
workspace picker) is a Vite build-time artifact — `docs/dsh-seams.md §0.4`/`§8`
confirmed there is no runtime seam to re-skin or knob-strip it from an out-of-tree
bundle. Rather than own a from-source frontend build (rejected — see `DESIGN.md §8/§9`),
`kid-ui` (`src/kid-ui.ts` + `src/kid-ui/index.html`) is a second, much smaller front end
that talks to the exact same session API the stock UI uses.

**How it avoids the stock UI's knobs without disabling any dsh row.**
`@deepseek-ai/dsh-host-webserver`'s `WebServer.match()` checks its `exact`-path route
table before ever falling back to whatever claimed the single fallback seat — and
`@deepseek-ai/dsh-web-app` claims that seat (via `@deepseek-ai/dsh-host-frontend-static`)
to serve the stock dist. `kid-ui` registers an **exact** route at `config.path` (default
`/`); that route always wins at that path regardless of plugin load order, and since the
stock dist's `index.html` is reachable *only* at the webserver root/index paths (any other
miss is a 404 — `dsh-host-frontend-static`'s own `serveStatic`), claiming `/` makes the
knobby chat UI unreachable by navigation too. No stock row needed disabling; `/api/*`
(the session RPC + `events.mux` WebSocket the page itself uses) is untouched.

**Routes this plugin adds** (host-plane; needs `ctx.webServer` + `ctx.apiProxy`, both
host-only services a preset cannot see):

- `GET {config.path}` (default `/`) — the self-contained page: inline CSS + JS, no CDN,
  no build step, read fresh from `src/kid-ui/index.html` on every activation.
- `GET /kid/config` — `{ kidName }`, sourced the same way `persona-name` resolves it
  (`$KID_NAME` env, then config, then `"friend"`).
- `POST /kid/session` — creates (or idempotently resumes, given a previously issued
  `sessionId`) a session with a **server-side-fixed** `cwd: config.workspaceRoot` and
  `agentPreset: config.presetId`. `sanitizeSessionRequestBody()` strips every other field
  an untrusted body might carry (`cwd`, `workspaceId`, `agentPreset`) before it ever
  reaches `ctx.apiProxy.sessions.create()` — the browser can resume a session by id, but
  can never choose or override the workspace or the preset.

**Everything else is the stock protocol, used directly by the page's own JS**: `POST
/api/session.prompt` to send a message, `POST /api/session.history` to hydrate a resumed
session's transcript, and the `/api/events.mux` WebSocket (no client messages; a
downlink-only stream of `{type:'server-request', payload: MuxFrame}` frames) for live
`assistant/chunk` (rendered as progressive text deltas; `reasoning-delta` chunks are
never rendered), `tool/call`/`tool/result` (rendered as a single friendly status line —
"Looking that up…", "Running your program…" — never a trajectory view), and
`assistant/message` (the authoritative final text, replacing whatever chunks built up —
NOT the "turn is done" signal, since a turn can run more steps afterward; only
`turn/end` re-enables the input and clears the thinking indicator).
A plugin-sourced `user/message` whose `source.plugin` is `dsh-kid-tutor` (quota cutoff,
a guard's redo instruction — see `quota.ts`/`output-guard.ts`) renders as a distinct
centered "notice" bubble rather than a kid bubble, since the kid didn't type it. Every
OTHER plugin-sourced `user/message` — critically, dsh's own
`@deepseek-ai/dsh-system-prompt` "Current runtime context… DSH file policy…" snapshot,
which uses the identical `source.kind === 'plugin'` shape — is deliberately hidden
(`isOwnPluginNotice()`'s allowlist in `src/kid-ui/index.html`); a live smoke test
initially rendered that harness-internal snapshot to the kid before this was narrowed
from "any plugin source" to "our plugin by name." The trust fence
(`packages/client/connection/src/api-request-trust.ts` in the deepseek-harness source)
needs no accommodation: every request the page makes is same-origin to the server that
served the page, so the existing Host/Origin loopback check passes unchanged.

Config row (`cordis.patch.yml`, host-plane, this bundle):

```yaml
- id: kid-ui
  name: 'dsh-kid-tutor/kid-ui'
  config:
    enabled: true      # false unmounts every route this plugin owns
    path: '/'
    presetId: kid
    # workspaceRoot: ''  # empty resolves to $DSH_HOME/workspace, same as every other row
    # kidName: ''        # $KID_NAME env wins when set; this is the lowest-priority fallback
```

## Known gaps

### RESOLVED: `output-guard` did not intercept the main conversation turn

Full bisect in [docs/GUARD-BISECT.md](../../docs/GUARD-BISECT.md); the mechanism is also
in the header of `src/output-guard.ts`. Summary: the listener DID run on every main turn
and took its first early return, because `isAgentLoopRequest()` is a lookup in a
module-private `WeakSet` inside `@deepseek-ai/dsh-llm`. The agent loop writes that mark
through the HARNESS's copy of the package; this plugin is mounted by absolute path, so
Node resolves its bare imports upward from `dist/` and it read a SECOND copy out of this
repo's own `node_modules`, with its own empty WeakSet. It therefore answered `false` for
every request the guard ever saw. (The earlier investigation read its own
`purpose: undefined` trace lines as "auxiliary calls", but `GenerateOptions.purpose` is
only ever `'compaction' | 'session-title'` — `purpose: undefined` IS the main turn. Scope
filtering and the preset plane were never involved: `llm/stream` is not a scope-filtered
event.)

The gate now decides locally — our own nested judge/redo calls are tagged in a WeakSet
this module owns, and a guarded turn is one with no `purpose` whose `sessionId` was
announced through `agent/created`. Verified live: one turn produces
`kid-tutor/guard-verdict` events in the session log and a single-text-block,
guard-synthesized `assistant/message`, while the session-title call and the guard's own
judge call are correctly skipped.

**Generalize this before writing another plugin:** no `@deepseek-ai/dsh-*` API whose
answer lives in module state (a `WeakSet`/`WeakMap`, a module-level `Symbol()`,
`instanceof`) can work from an out-of-tree plugin loaded by absolute path. Pure builders
(`BlockAssembler`, `createUserMessage`, `deepFreeze`, `deadline`) are unaffected.

### Verified deviations from the original brief/CONTRACT (all fixed here, not gaps)

- **`fs/write-intent`/`fs/edit-intent` are not an access-control seam.** They're a
  stale-write guard (create-only vs. optimistic-concurrency replace); `workspace-fence`
  uses `tools/pre-execute` + a symlink-safe realpath check instead. See its file header.
- **A symlinked `.agent-presets/<id>` directory is invisible to preset discovery.**
  `@deepseek-ai/dsh-agent-presets`'s `scanRoot()` calls `Dirent.isDirectory()` on each
  entry of `<dshHome>/.agent-presets` straight from `fs.readdir(..., {withFileTypes:
  true})`, which does not follow symlinks. `scripts/install.sh` makes the directory real
  and symlinks only `preset.yml` (no path content) into it.
- **A relative plugin path from that real directory has no fixed offset back to
  `packages/dsh-kid-tutor/dist`.** `presets/kid/agent.cordis.yml` references plugins via
  a `__DSH_KID_TUTOR_DIST__` placeholder that `scripts/install.sh` substitutes for an
  absolute, install-time-resolved path (`docs/dsh-seams.md §1b`'s own documented
  alternative: "An absolute filesystem path keeps its own location").
- **A profile's `cordis.patch.yml` cannot reach a row inside an agent preset.**
  `docs/CONTRACT.md` said `kidName` would be "set in the profile patch, never in the
  repo," but profile/bundle patches are host-plane only (`docs/dsh-seams.md §1b`'s own
  table). `persona-name.ts` reads `$KID_NAME` from the environment instead — the process
  that starts dsh carries the name, not any file this repo or its generated profile
  copy holds.
- **`settings.yaml`'s `agent-default-model` overrides the profile's own
  `cordis.patch.yml` row of the same id at runtime.** Copying a parent's personal
  `~/.dsh/settings.yaml` verbatim silently handed a smoke-test session
  `deepseek-v4-pro` with `reasoningEffort: high` instead of the kid's intended
  `deepseek-v4-flash`. `scripts/install.sh` now forces that section back after copying.
- **`@deepseek-ai/dsh-web-fetch-http` ships on the public npm registry but is not a
  dependency of any installed bundle on this machine.** `profiles/kid/package.json`
  lists it explicitly so hoisted pnpm linking makes the bare specifier our bundle's
  `cordis.patch.yml` names actually resolvable.
- **`@deepseek-ai/schemastery` is version `3.18.x` on the public registry, not `4.x`**
  (an unrelated unscoped `schemastery` package under the same install tree misled an
  early check). Fixed in `package.json`.

### Smaller, accepted gaps

- **Reads via `glob`/`grep` and `read`/`read_image` are fenced by our own guard, not by
  the fs backend.** `@deepseek-ai/dsh-fs-sandbox`'s own README states "every mode permits
  reading" — its confinement covers only `write`/`edit`. `workspace-fence` closes this,
  but it is the only thing standing between the kid's prompt and the parent's filesystem
  for reads; a bug there has no second layer of defense the way writes do (fs-sandbox is
  still the backstop for mutations).
- **`turn`/`step` in `kid-tutor/tool-denied` and `kid-tutor/python-run` are always `0`.**
  `ToolExecution` (the object `tools/pre-execute`/`post-execute` and a custom tool's
  `execute` receive) does not carry those fields — they exist only on `agent/pre-step`
  payloads and session events the agent loop itself appends. Recorded as an honest
  `UNKNOWN_TURN_STEP` sentinel (`src/events.ts`) rather than a guess; the event's own
  `time` plus the session it landed in still let a parent correlate it.
- **Per-day quota dedupe is in-memory, not persisted.** A process restart mid-turn could
  double-charge that one turn against the daily cap. Acceptable for a soft guardrail, not
  a security boundary.
- **`output-guard`'s live `sessionsById` map is never pruned.** Session references
  accumulate for the life of the process. Fine for a single-kid personal deployment;
  would need bounding for a busier deployment.
- **Stage-1 deterministic patterns are deliberately coarse** (`config.ts`'s
  `DEFAULT_BLOCKED_PATTERNS`) — profanity basics, phone-number shapes, a couple of
  destructive-command shapes. Nuance is the judge stage's job (which, per the critical
  gap above, was never reached in practice until that gap was fixed).
- **`output-guard`'s `sessionsById` map is also its main-turn discriminator now, not
  just its log target.** A turn whose `agent/created` this plugin never saw is treated
  as "not ours" and passes through unguarded. That is the correct default for a preset
  that mounts per agent, but it does mean the guard fails OPEN for an agent created
  before the row activated. Nothing in this composition can produce that ordering (the
  preset mounts before the agent is published), but a future host-plane placement of
  this row would need a different discriminator.
- **UPDATE, superseding the note that used to be here:** an earlier pass saw the judge
  fail closed under `model: deepseek-flash` and attributed it to the model id being
  unrecognized (`session.models` on this install advertises only `deepseek-v4-flash`,
  `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` — `deepseek-flash` is not in that
  list). Root cause turned out to be different: the judge call had no `reasoningEffort`
  set, and this route defaults per-request effort to `high`
  (`llm-deepseek`'s own doc comment); with `maxTokens: 200` a reasoning-capable model can
  spend the ENTIRE budget on hidden `reasoning` content and return an empty visible
  `text` block, which `output-guard` correctly (but confusingly) reported as "judge
  unavailable or timed out." Fixed by setting `reasoningEffort: 'off'` (via the
  `ReasoningEffortId` brand constructor — it's a `Branded<'ReasoningEffortId'>`, not a
  plain string) and raising the judge's own cap to 300. Re-verified live, twice, with
  `model: deepseek-flash` at both the main-turn AND judge routes (unchanged from
  `config.ts`'s default): `deepseek-v4-flash` is what the actual API response records as
  having served the request either way, so `deepseek-flash` may simply be treated as an
  alias server-side rather than being invalid — this deployment cannot fully settle which
  id is "real," only that requesting `deepseek-flash` now works end to end, judge
  included, with correct `category`/`severity` classification and a delivered
  `parent-alert` webhook POST.
- **FIXED, not a gap: `latestUserText()` initially picked up a plugin-injected runtime-
  context snapshot instead of the kid's real message.** `role === 'user'` is not enough
  to identify the kid's own text: `ctx.systemPrompt.context()` snapshots (e.g. the
  sandbox-policy "Current DSH file policy…" notice) are ALSO appended as `role: 'user'`
  messages, sometimes after the kid's own turn. Confirmed live: a
  `kid-tutor/alert` excerpt and the judge's classification input both showed the sandbox
  snapshot's text instead of what the kid actually typed. Fixed by additionally requiring
  `message.source.kind === 'user'` (only `MessageSourceMap.user`, `{ kind: 'user' }`, is
  the kid's own typed text — a plugin snapshot's source is `{ kind: 'plugin', ... }`).
- **`max-tokens` truncation is NOT exempted from the guard, on purpose — see the
  "Two verbatim pass-throughs" note in `output-guard.ts`'s header for why, and its
  residual imperfection: a truncated-but-judge-"pass" reply still reaches the kid cut off
  mid-sentence.** Confirmed live: `brevity.ts`'s 350-token cap combined with this route's
  `high` reasoning-effort default made exactly the heaviest, most safety-relevant
  exchange in this smoke test (a stranger-danger question, 219 reasoning tokens) hit
  `finish: max-tokens`; an earlier version of the pass-through condition treated any
  non-`stop` finish as "re-emit raw," which would have let that one specific reply skip
  the guard entirely. If truncation turns out to be routine rather than rare, the real
  fix is raising `brevity.maxOutputTokens` or setting the MAIN route's own
  `reasoningEffort` lower — not exempting more finish reasons from the guard.
- **`dsh` must be launched through the `agent-vault` shell wrapper**
  (`~/.zshrc.d/dsh` defines `dsh()` as `agent-vault run --vault dsh -- … command dsh`).
  A bare `dsh --profile kid` — or a `zsh -lc`, which is login but not interactive and so
  never sources that file — boots fine and then fails every model call with
  `MISSING_CREDENTIAL`; `~/.dsh-kid/.credentials.yaml` deliberately holds no values.
  The guard's new non-`stop` pass-through is what makes that visible: before it, the
  adapter's terminal `error` chunk was swallowed and the kid got a calm "ask me a
  different way" with the real failure recorded nowhere.

## Build & test

```sh
pnpm install
pnpm --filter dsh-kid-tutor run build   # tsc -p tsconfig.build.json -> dist/
pnpm --filter dsh-kid-tutor run check   # tsc -p tsconfig.json --noEmit
pnpm --filter dsh-kid-tutor run test    # vitest run
```

All three pass as of this writing (also via the root `pnpm run check`/`pnpm run test`,
which run both this package and `dsh-kid-tutor-admin` together): `check` is clean, and
`test` runs 80 unit tests across 9 files (net, paths, quota, output-guard, brevity,
parent-alert, persona-name, tool-policy, kid-ui) — all pure functions or a bare `new
Context()` with no other plugins mounted; nothing here boots a real Cordis host tree or
hits a real network (`parent-alert.spec.ts` stubs `fetch`).

## Smoke test performed (real DeepSeek calls)

Ran via `scripts/install.sh` then `DSH_HOME=~/.dsh-kid dsh --profile kid --port 3081
--no-open`, driven over the dsh web app's JSON-RPC-over-HTTP + WebSocket-mux API (there is
no synchronous one-shot HTTP endpoint — `session.create`, `session.prompt`, then read the
reply off `ws://host/api/events.mux`, `session/event` frames). Confirmed:

- `dsh --profile kid --dump-config` boots clean with all host-plane patches applied
  (`agent-presets.default: kid`, `agent-default-model` pinned to flash, `sandbox-policy`/
  `fs-sandbox` pointed at the workspace, `webserver` on port 3081, the `web-fetch-http`
  row inserted).
- The `kid` agent preset mounts successfully (`session.create` returns `agentPreset:
  "kid"`) once the discovery/relative-path issues above were fixed.
- A curiosity question ("How do volcanoes work?") got a warm, on-level, direct answer
  that correctly addressed the kid by the `$KID_NAME`-injected name and distinguished
  curiosity from homework in its own reasoning trace.
- A `web_fetch` to `http://192.168.1.1/` was denied by `tool-policy`'s guard; a
  `kid-tutor/tool-denied` event (`tool: "web_fetch"`, the exact denial reason and URL)
  landed in the on-disk session log, and the model relayed a plain-language explanation
  to the kid instead of the address.
- `kid-tutor/quota` events landed correctly on every turn.
- **`kid-tutor/guard-verdict` never landed, in any session** — the critical gap above,
  now fixed. A later single-turn run against the same install produced
  `guard-verdict` events plus a guard-synthesized single-text-block
  `assistant/message`, with the `session-title` call and the guard's own judge call
  correctly skipped (`docs/GUARD-BISECT.md`).
- **Pacing**: with the guard actually intercepting, `assistant/chunk` timestamps for a
  guarded reply showed real word-by-word gaps (`+6076ms text-delta "Hmm, "` ...
  `+8150ms text-delta "way?"` across 17 words for one replacement message) — genuine
  progressive release, not a relabeled single blob.
- **Brevity persona rules**: unprompted, replies came back as 2-4 short sentences ending
  in a question back to the kid ("Great question, TestKid! ... Want to know why the sky
  turns black at night?").
- **`parent-alert`**: a message describing a stranger online requesting the kid's home
  address produced `category: "stranger_contact"`, `severity: 2` from the judge, a
  `kid-tutor/alert` event with `delivered: true`, an actual HTTP POST landing on a local
  test receiver with the correct excerpt (after the `latestUserText()` fix above), and
  the kid-facing reply correctly swapped to the `ALERT_DISCLOSURE_TEXT` warm "I'm letting
  your parent know" line even though the judge's own `verdict` for the reply text itself
  was `"pass"`.
- **`kid-ui`**: `GET /` returns the kid page, `GET /kid/config` returns `{"kidName":
  "TestKid"}`, and `POST /kid/session` creates a session pinned server-side to the `kid`
  preset and workspace regardless of request body content.

Total real model calls made across this smoke test and its debugging, across two build
iterations (the guard fix and the pacing/brevity/alert features): a few dozen, each a
deliberate, targeted check — session-title generation adds one call per new session on
top of each prompt, and the judge stage adds one to two more per guarded turn.

## Repo paths this package owns

`packages/dsh-kid-tutor/**`, referenced from `presets/kid/agent.cordis.yml` and
`profiles/kid/cordis.patch.yml` (both owned by the parent repo layer, documented in
`docs/CONTRACT.md`).
