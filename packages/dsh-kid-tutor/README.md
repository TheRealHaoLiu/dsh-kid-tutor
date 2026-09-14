# dsh-kid-tutor

The kid-facing bundle + agent preset for the [dsh-kid-tutor](../../README.md) project.
See the repo root [DESIGN.md](../../DESIGN.md) for the why, [docs/CONTRACT.md](../../docs/CONTRACT.md)
for the binding shape, and [docs/dsh-seams.md](../../docs/dsh-seams.md) for the dsh API
recon this package was built against.

## Status: mechanically installs and boots; the core safety guard does not fire yet

Read [Known gaps](#known-gaps) before trusting this with a child. The short version:
`output-guard` (the two-stage safety filter) is fully implemented and unit-tested, but a
live smoke test found it never intercepts the main conversation turn on the installed
`@deepseek-ai/dsh` `0.1.1-rc.2`. Everything else — the persona, the fetch allowlist, the
workspace fence, `run_python`, the daily quota, and the audit log — was verified working
end to end against a real DeepSeek model.

## What each plugin enforces

| Plugin | File | Enforces |
|---|---|---|
| `tool-policy` | `src/tool-policy.ts` | `web_fetch` allowlist (exact/subdomain match) plus a literal-IP / RFC1918 / loopback / link-local / `.local`/`.lan`/`.home`/`.internal` hostname denial, via `ctx.tools.guard()`. Wraps successful `web_fetch`/`web_search` results as explicitly-untrusted quoted data and strips lines shaped like prompt injection, via `tools/post-execute`. |
| `workspace-fence` | `src/workspace-fence.ts` | Confines `read`, `write`, `edit`, `read_image`, `glob`, `grep` to `workspaceRoot` with a symlink-safe realpath check (`src/paths.ts`), via `tools/pre-execute`. Denies any call carrying `sandbox_permissions`/`justification` (an escalation attempt) outright. See its file header for why this is NOT built on `fs/write-intent`/`fs/edit-intent` as originally briefed — those aren't an access-control seam. |
| `run-python` | `src/run-python.ts` | Registers a custom `run_python` tool: spawns `python3 -I` directly via `node:child_process.spawn` (explicit argv, never `shell: true`) with `cwd=workspaceRoot`, env scrubbed to `PATH`/`HOME`/`LANG`, a kill timeout (default 10s), and a 64 KiB output cap per stream with a truncation note. |
| `quota` | `src/quota.ts` | A `KidQuotaService` (`ctx.kidQuota`) persisting a per-local-day turn counter to a JSON file. `agent/pre-step` rejects a step once the daily cap is hit or the local-time cutoff window is active, first appending a plugin-sourced `user/message` notice (so the kid sees why, at zero token cost) and a `kid-tutor/quota` log event. Exposes `charge()` so `output-guard`'s judge calls count against the same budget. |
| `output-guard` | `src/output-guard.ts` | **See [Known gaps](#known-gaps) — does not currently intercept the main turn.** Designed as: buffer the whole reply (no streaming), a deterministic regex stage, then a nested judge call (strict JSON verdict, no history), one redo attempt on `redo`, fail-closed replacement text on `block`/timeout/judge failure. Logs `kid-tutor/guard-verdict` for every stage including `pass`. |
| `persona-name` | `src/persona-name.ts` | Contributes a small `ctx.systemPrompt` section naming the kid, resolved from `$KID_NAME` (environment) first, then config, then `"friend"`. See its file header for why this can't just be a preset-file config value. |
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
- `persona-name`: `{ kidName?: string }` (lowest-priority fallback; `$KID_NAME` wins).

`workspaceRoot` (used by `workspace-fence`, `run-python`, and — separately, at the HOST
plane — `profiles/kid/cordis.patch.yml`'s `sandbox-policy`/`fs-sandbox` rows) defaults to
`$DSH_HOME/workspace` when left empty; schemastery's own `.default()` couldn't be used
for this because it evaluates once at schema-definition time, before `$DSH_HOME` is
necessarily its final value in a test or an alternate profile.

## Known gaps

### Critical: `output-guard` does not intercept the main conversation turn

See the long header comment at the top of `src/output-guard.ts` for the full writeup —
summary: a live smoke test (real DeepSeek calls through `DSH_HOME=~/.dsh-kid dsh
--profile kid`) showed the `llm/stream` listener firing for hand-built auxiliary calls
(session-title generation) but never for the turn that produced the actual reply, across
three separate turns in two sessions. The on-disk session logs confirm the RAW
two-content-block (reasoning + text) adapter shape reached the log unmodified — not this
plugin's single-block synthesized replacement — and carry zero `kid-tutor/guard-verdict`
events. Two research passes against the `deepseek-harness` monorepo source (not just this
npm package's `.d.ts`) found no code path that should cause this: the main turn and the
hand-built calls that DO reach the listener both dispatch through the identical
`ctx.waterfall(this, 'llm/stream', ...)` call inside `LlmRuntime`. `DESIGN.md §10`
explicitly flagged this exact class of risk as something to spike before charter; the
spike result is negative for a narrower reason than that question anticipated, and
whoever continues this project should root-cause it (the file header suggests where to
look next) before deploying this to a real child. **Until then, model replies are not
actually filtered** — the deterministic/judge/redo logic is implemented and unit-tested
in isolation only.

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
  gap above, is not currently reached in practice either).

## Build & test

```sh
pnpm install
pnpm --filter dsh-kid-tutor run build   # tsc -p tsconfig.build.json -> dist/
pnpm --filter dsh-kid-tutor run check   # tsc -p tsconfig.json --noEmit
pnpm --filter dsh-kid-tutor run test    # vitest run
```

All three pass as of this writing: `check` is clean, and `test` runs 48 unit tests across
6 files (net/paths/quota/output-guard pure-logic/persona-name/tool-policy) — all pure
functions; nothing here boots a real Cordis context or hits a network.

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
- **`kid-tutor/guard-verdict` never landed, in any session** — the critical gap above.

Total real model calls made across this smoke test and its debugging: under a dozen
(session-title generation adds one per new session on top of each deliberate prompt).

## Repo paths this package owns

`packages/dsh-kid-tutor/**`, referenced from `presets/kid/agent.cordis.yml` and
`profiles/kid/cordis.patch.yml` (both owned by the parent repo layer, documented in
`docs/CONTRACT.md`).
