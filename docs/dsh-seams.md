# dsh API seams for the `dsh-kid-tutor` bundle

Recon against `deepseek-harness` (monorepo checkout) and the installed `dsh`
0.1.1-rc.2 (npm-global under Homebrew's Node, **not** the `homebrew-core`
`dsh` formula — see the gotcha in §0). Cross-checked against the shipped
`web`/`headless` profiles in `~/.dsh/profiles` and the reference out-of-tree
bundle `dsh-model-env`. Every claim below is cited to a real file; where
something is genuinely unsupported I say so and name the closest Cordis-native
workaround.

---

## §0. Read this before anything else — four corrections to the DESIGN.md premises

1. **Bundle `cordis.patch.yml` cannot set the persona or disable tools for a
   *web* session.** `dsh-web-app`'s bundle patch disables `tool-web`,
   `tool-bash`, `tool-fs`, `tool-goal`, `plan-mode`, `tool-subagent*`,
   `tool-workflow`, `tool-todo`, `tool-skill`, `compaction-basic`, etc. at the
   HOST layer and re-enables them **per session** inside an **agent preset** —
   a *separate* composition file (`agent.cordis.yml`) mounted through
   `ctx.agentPresets`, not through the Loader tree that `cordis.patch.yml`
   overlays see (`packages/bundle/web-app/cordis.patch.yml`, the whole
   disabled-rows block; `packages/preset/agent-presets/README.md` "A directly
   plugged subtree is absent from `ctx.loader.entries()`"). For the **web**
   profile, `dsh-kid-tutor` must ship an **agent preset**, not (only) a
   bundle-style `cordis.patch.yml`. For the **headless** profile there is no
   preset layer — `packages/bundle/headless/cordis.patch.yml` patches
   `system-prompt`/`tools` directly and every base tool row stays live — so a
   bundle patch is sufficient there. See §1.
2. **`dsh-web-fetch-http` has zero SSRF protection today.** Its own README
   says outright: *"this provider is an SSRF primitive and **must not be
   enabled** in a deployment that can reach sensitive internal network
   targets"* (`packages/web/web-fetch-http/README.md`, Known Limitations).
   Since this will run on a homelab host, the `tool-policy` domain allowlist
   in DESIGN.md §4 is not a nice-to-have hardening layer — it is the **only**
   thing that would stand between the kid's prompt and the LAN once
   `web_fetch` is enabled. Enforce the allowlist in `tools/pre-execute` (§4)
   and treat "fetch enabled" as equivalent to "SSRF-reachable" until you've
   verified the allowlist covers every code path (including redirects —
   `dsh-web-fetch-http` does at least reject cross-origin redirects).
3. **There is no Python code-runtime backend.** `ctx.codeRuntime`
   (`docs/subsystems/code-runtime.md`) declares `'python'` as a "well-known"
   `language` value, but **only `'typescript'` has a published backend**
   (`@deepseek-ai/dsh-code-runtime-worker-thread`, mounted as `code-runtime` in
   the web/headless bundles). DESIGN.md §1's "helps them learn Python on their
   own machine" cannot be satisfied by `run_code` as shipped. Closest
   Cordis-native workarounds, worst to best fit:
   - Teach via `run_code` in TypeScript instead (zero new code, wrong
     language for the stated goal).
   - Write a new `ctx.codeRuntime` Python implementation (`isolation: 'process'`
     or `'container'`) satisfying `CodeRunRequest`/`CodeRunResult`
     (`docs/subsystems/code-runtime.md`) — real, scoped engineering work, and
     it inherits none of `run_code`'s tool-pipeline guardrails since bindings
     cross a separate serialization boundary from `ctx.tools`.
   - Give the kid a persistent shell tool scoped to `python3` only — but that
     re-opens the "no shell in phase 1" decision in DESIGN.md §8.
   Flag this as an open spike before the charter, exactly as DESIGN.md §10
   already asks for the `llm/stream` nested-call question.
4. **The web UI's branding/title/theme is a *build-time* concern, not a
   runtime patch.** `dsh-client-ui-brand-official`'s README: *"the browser
   title remains a build-environment concern outside this package"* and
   *"`DSH_CLIENT_TITLE` selects title text at build time."* The installed npm
   package ships a **prebuilt** frontend dist
   (`@deepseek-ai/dsh-web-frontend/dist/index.html`, confirmed present at
   `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist`,
   4.6 MB). Re-theming for a kid-friendly UI is not reachable from an
   out-of-tree bundle patch; it needs a from-source rebuild
   (`pnpm run build:web` with `DSH_CLIENT_*` env vars) and shipping your own
   dist — out of scope for "no fork." Practical read: phase 1's UI is the
   stock chat window; kid-friendly UX (DESIGN.md §1) has to come from the
   *persona's tone* and the Chat surfaces dsh already renders (tool cards,
   goal bar, etc.), not from re-skinning.

Also worth knowing up front: **installed "`dsh`" is not `brew install dsh`.**
`brew info dsh` resolves to the unrelated `homebrew-core` formula "Dancer's
shell." The real binary here is an npm-global package
(`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`, symlinked from
`/opt/homebrew/bin/dsh` because Homebrew's Node prefix happens to host it).
Say "the npm package `@deepseek-ai/dsh`," not "the `dsh` Homebrew formula," to
other engineers or they'll `brew info` the wrong thing.

---

## §1. Cordis plugin shape, bundle patches, profile deps, `--dump-config`

### 1a. What a Cordis plugin looks like to dsh

A dsh plugin is an ordinary Cordis plugin: a module exporting `name`
(string), optional `inject` (readonly string[] of required `ctx.*` service
keys), and `apply(ctx, config)` (or a class `Service`). Reference shape, from
the finished sibling bundle `dsh-model-env`
(`/Volumes/case-sensitive-volume/projects/src/github.com/TheRealHaoLiu/dsh-model-env/src/index.ts`):

```ts
export const name = "dsh-model-env";
export const inject = ["agentDefaultModel"] as const;

export function apply(ctx: Context, config: ModelEnvPluginConfig = {}): void {
  const service = ctx.agentDefaultModel;
  // ... wrap/patch the service ...
  ctx.effect(() => () => {
    // disposer: undo everything on unload
  }, "dsh-model-env restore");
}
```

Registrations should go through `ctx.effect()` (or a Cordis helper that
returns a disposer) so they unwind on HMR/unload
(`docs/cordis-primer.md` "Registrations are reversible effects").

### 1b. Bundle vs. preset — two different patch mechanisms

| | **Bundle** (`dsh.bundle.patch`) | **Agent preset** (`dsh.profile` → `agent.cordis.yml`) |
|---|---|---|
| Declared in | `package.json` `dsh.bundle.patch: "./cordis.patch.yml"` | A directory under `apps/cli/config/agent-presets/<id>/` or `$DSH_HOME/.agent-presets/<id>/`, holding `agent.cordis.yml` (+ optional `preset.yml` for display name/description) |
| Applies to | The **host-plane** Loader tree, once per process, in bundle-list order, then the profile's own `cordis.patch.yml`, then `$DSH_HOME`-level patch, then `--patch` overlays (`docs/architecture.md` "Profiles and bundles") | One **agent-plane** subtree, mounted once per process the first time a session names that preset id, and parented into every session that joins it (`packages/preset/agent-presets/README.md`) |
| Row shape | `{ id, name, config, disabled? }`; `insert:` for new rows, bare `{id, config}` to override an existing row's whole config | Same YAML row shape, but a **top-level list**, not wrapped in `insert:`; a service row MUST sit under a `cordis:group` entry carrying `isolate: {serviceName: true}` or it collides with other presets in the shared root realm (`packages/preset/agent-presets/tests/fixtures/system/standard/agent.cordis.yml`, and the `standard` preset's own comments) |
| Who mounts it | The Loader, at boot, for every process using that profile | `ctx.agentPresets.mount(agentCtx, id)`, called only from an `AgentFactory`'s `setup(agentCtx)` hook — i.e. dsh's own agent-creation path, not something `dsh-kid-tutor` calls itself |
| Used by | `headless` profile (no presets at all — see §1e) | `web` profile, one preset per session (`standard`/`minimal`/`code`/`cordis` ship; `default: standard` set in `dsh-web-app`'s patch, row id `agent-presets`) |

**Practical consequence for `dsh-kid-tutor`:** ship **both** a bundle
(`dsh.bundle.patch`) for anything host-plane (nothing kid-specific needs this
in phase 1 except maybe `dsh-model-env`-style model override, and the
`schedule`/timer-based digest, §9) **and** a preset directory
(`kid/agent.cordis.yml`) for everything model-facing: persona, tool roster,
`output-guard`'s `llm/stream` listener if scoped to the agent, `quota`'s
`agent/pre-step` listener, `workspace-fence`'s fs rows. A profile's
`package.json` can point `dsh.profile.bundles` at your bundle, but the preset
itself is discovered by directory, and its **package name resolution is
special**: bare `@deepseek-ai/dsh-*` specifiers in a preset resolve against
the *host* composition's `node_modules`, not the preset directory's own
(`packages/preset/agent-presets/README.md` "How a preset's rows resolve") —
so a *locally authored* preset can still reference in-tree dsh packages by
bare specifier, but a **preset's own custom plugin** (your persona/guard code)
must be referenced by relative or absolute path, which resolves from the
preset's own directory (relative) or its own location (absolute, converted to
a `file:` URL).

### 1c. Inserting a plugin row via `cordis.patch.yml`

Bundle/profile-level patch, top-level array, `insert:` to add a row:

```yaml
# dsh-kid-tutor's own cordis.patch.yml (bundle patch)
- insert:
    - id: kid-model-env
      name: 'dsh-kid-tutor/model-env'
```

Overriding an existing row's config (last-write-wins by `id`, whole `config`
replaced, not merged):

```yaml
- id: system-prompt
  config:
    persona: 'You are Robo, a friendly tutor...'
```

(`packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`
top comment: "A patch replaces the targeted row's whole `config` rather than
merging into it.")

### 1d. Preset-level insert (agent plane), the shape that matters for kid-tutor

Straight from the shipped `standard` preset
(`apps/cli/config/agent-presets/standard/agent.cordis.yml`):

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000
```

A service-owning row needs an `isolate` realm or the mount refuses it (only
tool/prompt *registrations* need no realm because those registries are
host-plane singletons the preset merely writes into):

```yaml
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config: { ... }
```

### 1e. `link:` deps in a profile `package.json`

From the live `headless` profile at `~/.dsh/profiles/headless/package.json`:

```json
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": {
    "dsh-herdr": "link:/Volumes/.../dsh-herdr",
    "dsh-model-env": "link:/Volumes/.../dsh-model-env"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-herdr",
        "dsh-model-env"
      ]
    }
  }
}
```

`dsh.profile.bundles` is an ordered list; each entry must resolve to a package
whose own `package.json` has `dsh.bundle.patch`. Order matters: later bundles'
patches win on `id` collisions, then the profile's own `cordis.patch.yml`,
then `--patch`. Installing into a *shipped* profile programmatically:
`dsh plugin --profile <name> add <bundle>` (README of `dsh-model-env`).

The profile directory is also a pnpm workspace root
(`~/.dsh/profiles/web/pnpm-workspace.yaml`):

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

### 1f. Seeing the composed tree

```sh
dsh --profile web --dump-config
```

prints every row the Loader currently boots for that profile — but **not**
agent-preset subtrees, since those mount lazily per session, outside
`ctx.loader.entries()` (`packages/preset/agent-presets/README.md`, "What a
mount rejects" / "A directly-plugged subtree is absent from
`ctx.loader.entries()`"). To see a preset's own effective rows, read its
`agent.cordis.yml` directly, or use `ctx.agentPresets.read(id)`.

---

## §2. System prompt / persona — two mechanisms, and how to REPLACE `dsh-web-app`'s

### The row that currently sets the coding persona

`@deepseek-ai/dsh-system-prompt` owns the **global, unconditional** persona
row (id `system-prompt` in every bundle patch). Its `persona` config string
renders as the order-0 `deployment:persona` section
(`packages/core/system-prompt/README.md`: *"this plugin owns the global
persona default... the ONE config-authored prompt fragment, rendered as the
order-0 `deployment:persona` section"*). `dsh-web-app`'s bundle patch sets it
to:

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

(`packages/bundle/web-app/cordis.patch.yml`, top of file.)

**But** for a *web* session, this global default is immediately **shadowed**
by the `standard` preset's own `persona` row — a **different package**,
`@deepseek-ai/dsh-persona` (`packages/preset/persona/src/index.ts`), which is
**scope-only**: mounting it outside an agent scope collides with the
registry's own registration and throws. Its job exists precisely because "an
agent preset cannot mount the prompt registry itself... without a row of its
own a preset could change an agent's tools but never its identity"
(`packages/preset/persona/README.md`).

**To replace the persona for the kid-tutor's web session**, put your own
`persona` row in your **preset's** `agent.cordis.yml` (not the bundle patch —
that only reaches the row `dsh-web-app` already shadows):

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are Robo, a patient tutor for a nine-year-old...
      (hint ladder, domain-mode rules, reading level, etc.)
    complete: false          # keep tool-guidance sections (§3) in the prompt
    includeRuntimeContext: true
```

`Config` fields, from `packages/preset/persona/src/index.ts`:

```ts
export interface Config {
  text: string                        // template; {{model}}/{{cwd}} interpolate
  complete?: boolean                  // true = ONLY this text is the system prompt
  includeRuntimeContext?: boolean     // false suppresses dynamic context snapshots for this agent
}
```

- `complete: true` restores this exact section as the sole prompt **after**
  the cooperative `system-prompt/assemble` waterfall still runs (so tools,
  contexts, and variables resolve) — matches DESIGN.md's "the system prompt
  governs quality... The test: delete the prompt and every row in the
  enforcement table still holds" nicely, since `complete` cannot remove or
  add enforcement, only prompt text.
- Section identity is `deployment:persona`, order `0` (exported as
  `PERSONA_SECTION`/`PERSONA_ORDER` from `@deepseek-ai/dsh-system-prompt`, and
  re-exported by `dsh-persona` so you don't hardcode the string).

If instead `dsh-kid-tutor` runs under `headless` (no presets), patch the
bundle-level `system-prompt` row directly, exactly like `dsh-headless`'s own
patch does — no separate persona package needed there.

### Cordis API for a plugin contributing its OWN section (e.g., a hint-ladder addendum, or a domain-mode note)

`packages/core/system-prompt/src/index.ts`, `ctx.systemPrompt`:

```ts
section(section: PromptSection): () => void
// PromptSection: { name: string; order: number; text: string | ((ctx: AssembleContext) => string); complete?: boolean }
// order bands: -100 harness identity, 0 deployment persona, 100-199 tool guidance

context(context: PromptContext): () => void   // dynamic, cache-safe, rendered as a durable user-role snapshot
variable(name: string, provider: (ctx: AssembleContext) => string | undefined): () => void
tools(provider: (ctx: AssembleContext) => ToolProviderResult): () => void
suppressRuntimeContext(): () => void
async assemble(context?: AssembleContext): Promise<PromptAssembly>
```

Waterfall: `'system-prompt/assemble'(assembly, context, next)` — expert-level,
runs after ordinary sections/tools/variables are gathered; a registered
`complete` section is restored **after** this waterfall, so a listener cannot
add to or replace a complete scope's prompt (`docs/subsystems/system-prompt.md`).
Scoped registrations (via `agentCtx.systemPrompt.section(...)`) shadow global
ones by name.

---

## §3. Tool registry — seeing/disabling tools, row ids, search providers

### Row ids in `dsh-base` (host plane) and the `standard` preset (agent plane)

Everything below is a row `id` you can `disabled: true` (bundle patch, for
headless) or simply **omit** (preset, since a preset only registers what it
lists — omission IS disabling for the agent plane).

**`dsh-base` tool rows** (`packages/bundle/base/cordis.patch.yml`):
`tool-bash`, `tool-pwsh` (platform-gated), `tool-jobs`, `tool-fs`,
`tool-fs-search`, `tool-skill`, `tool-goal`, `plan-mode`, `tool-todo`,
`tool-ralph`, `tool-str-replace-editor`, `tool-subagent`,
`tool-subagent-fork`, `tool-subagent-control`,
`tool-subagent-list-agents`, `tool-subagent-report`, `tool-workflow`,
`tool-web` (config `{fetch: false, searchTimeoutMs: 60000}` — search on,
fetch off by default even in the base!). Registry itself: row `tools`
(`@deepseek-ai/dsh-tools`).

**`standard` preset agent-plane rows**
(`apps/cli/config/agent-presets/standard/agent.cordis.yml`): re-registers
`tool-bash`/`tool-pwsh`, `tool-fs`, `tool-fs-search`, `tool-jobs`,
`skill-filesystem`+`tool-skill`, `tool-goal`, a `planning` group
(`plan-mode`), a `compaction` group, a `delegation` group
(`tool-subagent*`, `tool-workflow`, `tool-ralph`), `tool-ask-user`,
`tool-todo`, `tool-web` (`{fetch: false, ...}`).

**For kid-tutor's preset, the tool roster you actually want is a *subset* of
the above, plus nothing more**: `tool-web` (with `fetch: true` this time —
see §0.2 for the SSRF caveat), `tool-fs`/`tool-fs-search` (fenced to the
workspace, §"workspace-fence" below), and either `run_code` (via `tools`
registry's Code Mode reserved transport — TypeScript only, see §0.3) or
nothing for "python." Everything else (`tool-bash`, `tool-pwsh`, `tool-jobs`,
`tool-goal`, `plan-mode`, `tool-skill`, `tool-subagent*`, `tool-workflow`,
`tool-ralph`, `tool-todo`) is simply **not listed** in your preset's
`agent.cordis.yml` — omission is the mechanism, there is no explicit "deny
list" row to write for tools your preset never mounts.

You can *also* use `ctx.tools.restrict({allow?, deny?})` (scoped, per-agent)
if you'd rather mount everything from a parent scope and narrow — but for a
from-scratch preset, simply not registering the row is cleaner and matches
what `minimal` does (`apps/cli/config/agent-presets/minimal/agent.cordis.yml`
registers only a persistent shell + `str_replace_editor`, nothing else).

### Web search providers

Package `@deepseek-ai/dsh-web-search-<provider>`, one row per provider,
registering into the shared `ctx.web` seam (row `web`,
`@deepseek-ai/dsh-web`, config `searchProvider: <id>` selects which one
`web_search` uses):

| Provider | Package | Credential | Notes |
|---|---|---|---|
| `deepseek-official` | `dsh-web-search-deepseek` | reuses `DEEPSEEK_API_KEY` (`apiKeyEnv`, default `DEEPSEEK_API_KEY`) | **Not a dedicated search endpoint** — issues a full Anthropic-compatible Messages call (`{baseURL}/messages`, default `https://api.deepseek.com/anthropic/v1`) with the native `web_search_20250305` server tool. Costs a complete model turn in tokens/latency per search, but needs **no new API key** beyond what you already hold for chat. This is the "free" answer to DESIGN.md's search-provider question: free of a *new credential*, not free of tokens. Shipped default in `dsh-base`. |
| `exa` | `dsh-web-search-exa` | `EXA_API_KEY` | Dedicated `/search` endpoint, flat `results[]`, no generated answer. |
| `perplexity` | `dsh-web-search-perplexity` | `PERPLEXITY_API_KEY` | OpenAI-compatible `/chat/completions`, generates an answer + citations. |

For kid-tutor, `deepseek-official` is almost certainly right (no second
vendor, no second credential to manage in the parent's vault).

### `web_fetch` provider — the SSRF gotcha, restated with the field name you need

`@deepseek-ai/dsh-web-fetch-http` is the only fetch provider; it is **not
mounted by default** in any shipped bundle (`dsh-base`'s comment: *"Fetch
stays disabled and no fetch provider is mounted: that provider defers SSRF
protection and the model would choose the request target"*). To enable
`web_fetch` you must (a) insert this row yourself and (b) flip `tool-web`'s
config to `{fetch: true}`. The tool's argument field is:

```json
{"type":"object","properties":{"url":{"type":"string","description":"The HTTP(S) URL to fetch."}}},"required":["url"]}
```

i.e. `args.url` — that's what your `tools/pre-execute` allowlist checks
against `name === 'web_fetch'` (§4).

---

## §4. `tools/pre-execute` / `tools/post-execute` — exact payloads, denial UX, rewriting

Both are **waterfalls** on `ctx.tools` (`packages/core/tools/src/index.ts`,
documented in `docs/subsystems/tools.md`).

### `tools/pre-execute` — allow / deny / ask before dispatch

```ts
'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>

type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }   // needs an approval channel; else treated as deny
```

`ToolExecution` (relevant fields): `name: string`, `arguments: unknown`
(already parsed, frozen JSON), `agent?: Agent`, `signal: AbortSignal`,
`callId`, `rootCallId`. Domain-allowlist example for `web_fetch`:

```ts
ctx.tools.guard((exec) => {
  if (exec.name !== 'web_fetch') return undefined
  const url = (exec.arguments as { url?: unknown }).url
  if (typeof url !== 'string') return 'invalid url'
  const host = new URL(url).hostname
  return ALLOWLIST.has(host) ? undefined : `domain "${host}" is not on the allowlist`
})
```

Note: `ctx.tools.guard(fn)` is actually the **simpler** primitive for a
pure allow/deny decision — it runs *after* `tools/pre-execute` as a
"monotonic" final check that can only deny, never re-allow something an
earlier layer denied (`ToolGuard = (execution) => string | undefined`,
`docs/subsystems/tools.md` "Execution: extensible waterfalls plus monotonic
policy"). Use `ctx.tools.guard()` for the allowlist (matches its one job:
deny) and reserve `tools/pre-execute` for anything that needs `ask` semantics
or must run before guards.

**What the model sees on denial:** a `deny` (or a guard string) "materializes
an error" — the tool call resolves as a normal `ToolExecutionFailure`
(`isError: true`, `error: { message: reason }`), which becomes the
`tool/result` content the model reads on its next turn, exactly like any
other tool error. No special channel; write your `reason` string as if it
were the tool's own error text, because the model will see it verbatim.

### `tools/post-execute` — accept / replace / block after dispatch

```ts
'tools/post-execute'(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>

type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }        // replace rendered content only
  | { kind: 'accept'; value: JsonValue; additionalContexts?: UserMessage[] }                 // replace canonical value (re-renders content/meta)
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }          // turn the whole result into an isError with corrective feedback
```

This is where the "fetched content is untrusted, quote/sanitize it" rule from
DESIGN.md §4 lives: for `name === 'web_fetch'` on success, return
`{ kind: 'accept', content: [wrapAsQuotedUntrustedData(result.content)] }`.
`additionalContexts: UserMessage[]` on either `accept` or `block` appends
extra durable `user/message` context for the **next** request (the mechanism
DESIGN.md's `quota`/`workspace-fence` plugins would use to tell the model
"you're out of turns for today," etc. — see also `agent.inject()`, §6).

Content vs. value: "Content replacement is presentation policy, not
confidentiality policy: a listener that must hide the programmatic value
blocks or replaces it" (`docs/subsystems/tools.md`) — i.e. replacing
`content` alone still leaves the original `value` reachable via
`presentationMeta`/Code Mode; if you need to actually redact a fetched
secret, replace `value` or `block`, don't just replace `content`.

---

## §5. `llm/stream` — signature, `StreamChunk`, buffering, nested judge calls, main-vs-auxiliary detection

### Signature

```ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```
(`packages/llm/llm/src/index.ts`, generated catalog in
`docs/subsystems/llm-streaming.md`). Register with `ctx.on('llm/stream', fn)`
or `ctx.llm.on(...)` — same event bus, `ctx.llm` just declares the type.

### `StreamChunk` union (closed; `switch` + fallthrough default, no `assertNever` since `SessionEvent` maps are merge-extensible but `StreamChunk` itself is closed per-adapter-contract)

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

### (a) Call `next()` and buffer all chunks

Use `BlockAssembler` (`@deepseek-ai/dsh-llm`) — this is exactly what
`dsh-session-title-first-prompt-llm` does for its own auxiliary call
(`packages/session/session-title-llm/src/index.ts:264-276`):

```ts
const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream(options)) {
  assembler.push(chunk)
}
const blocks = assembler.blocks()          // assembled ContentBlock[]
const finish = assembler.finish            // FinishReason
```

Inside an `llm/stream` **listener** specifically, buffer from `next()`'s
iterable the same way, then decide whether to yield the original chunks
through, yield replacements, or short-circuit entirely.

### (b) Yield replacement chunks (short-circuit)

An `llm/stream` listener is an async generator: `return` your own
`StreamChunk` sequence instead of delegating to `next()`, or delegate then
splice. There's no separate "replacement chunk" type — you construct the
same `StreamChunk` union by hand (typically `block-start` → `text-delta`* →
`block-end` → `usage`? → `finish`).

### (c) Make a NESTED model call from inside the listener without recursing into itself

**This is the load-bearing finding for DESIGN.md's output-guard/judge
design.** `ctx.llm.stream()` is the single dispatch entry point — calling it
again from inside your own `llm/stream` listener re-enters the **same**
waterfall, so your listener will be invoked again for the judge's own call
unless you guard against it. The guard the harness itself uses for exactly
this problem:

```ts
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'

ctx.on('llm/stream', (options, next) => {
  if (!isAgentLoopRequest(options)) return next()   // pass through: not a conversation turn
  // ... buffer, judge, redo ...
})
```

`markAgentLoopRequest()`/`isAgentLoopRequest()`
(`packages/llm/llm/src/call-config.ts:66-76`, re-exported from
`@deepseek-ai/dsh-llm`) is exactly the "is this the main agent turn, or an
independently-built auxiliary call" detector requested in the recon
prompt — it is used by the agent-loop's own reconstructability invariant
(`packages/core/agent-loop/src/invariant.ts:22`: `if
(!isAgentLoopRequest(options)) return next()`) for the identical reason: skip
non-conversation calls. **The agent loop marks every real turn/step request**
(main agent AND subagent — both dispatch through `agent-loop`, so this does
NOT distinguish "main" from "subagent"; if you need that distinction, compare
`options.sessionId` against the parent's own session id, since subagents get
their own `SessionId`). A **hand-built** call — like the title generator's,
and like your judge call should be — is simply never marked, so
`isAgentLoopRequest()` is `false` for it, and your listener's `next()`
early-return lets it fall straight through to the adapter without
re-triggering your own guard logic. This is exactly the pattern to build the
judge on: construct the judge request the same way
`generateSessionTitleWithLlm` does (below), and your `llm/stream` listener's
`isAgentLoopRequest` check makes recursion structurally impossible rather
than something you have to remember to avoid.

Concrete nested-call pattern, adapted from
`packages/session/session-title-llm/src/index.ts:264-283` (a real,
already-shipped "hand-built call with no history" — the closest existing
precedent to a judge call):

```ts
import { createUserMessage, BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const options: GenerateOptions = deepFreeze({
  provider: route.provider,
  model: route.model,
  messages: [createUserMessage({
    content: [{ type: 'text', text: candidateMessageText }],
    source: { kind: 'plugin', plugin: 'dsh-kid-tutor' },
  })],
  system: JUDGE_SYSTEM_PROMPT,
  maxTokens: 64,
  sessionId: session.id,          // for logging/attribution only — NOT reconstructability, since this isn't loop-built
  signal,
})
// Log the exact judge input BEFORE dispatch, per DESIGN.md's "verbatim" audit requirement:
session.append('kid-tutor/judge-request', { messages: options.messages, system: options.system })

const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
// assembler.blocks() / assembler.finish -> judge verdict; log it too (§7).
```

Note this call is **not** `markAgentLoopRequest`-marked (you didn't call it),
so it does not need to satisfy the agent-loop's reconstructability invariant
(`packages/core/agent-loop/src/invariant.ts`) — that invariant only fires
`if (!isAgentLoopRequest(options)) return next()`, i.e. it explicitly skips
hand-built calls like this one.

### The reconstructability constraint (why this matters for the judge, and why the judge is exempt)

"Model-visible means logged. Anything that reaches a model request must be
reconstructable from the session log, and a runtime invariant asserts it...
extend `SessionEventMap` and render from the log" (`docs/architecture.md`
"Session log"). This invariant is enforced *only* for `isAgentLoopRequest`
calls (see `packages/core/agent-loop/src/invariant.ts` guard above) — the
judge call is exempt because it never reaches the kid's own conversation
history; it is a private side-channel call whose own I/O you log yourself
(as a plugin-sourced event, §7) precisely because nothing else will.

### Distinguishing "main agent" vs. compaction / title / subagent calls

- `isAgentLoopRequest(options)` — true for conversation turns run through
  `agent-loop`, **including subagent turns** (a subagent is still driven by
  the same loop, just under a child `SessionId`). False for anything built by
  hand (session-title, compaction's own summarization call if it uses
  `ctx.llm.stream()` directly, and your judge call).
- `options.purpose` — `'compaction' | 'session-title' | undefined`. Set by
  the harness's own auxiliary callers; ordinary conversation requests leave
  it `undefined`. **Not set for arbitrary hand-built calls** unless you set it
  yourself — there's no reserved `purpose` value for "judge," so either add
  your own convention (it's just a string on `GenerateOptions`, no enum
  enforcement at the type level beyond the two literals TypeScript declares —
  though passing a third string will fail the type but not necessarily at
  runtime if you cast) or simply rely on `isAgentLoopRequest` being `false`,
  which is sufficient to avoid recursion.
- Main vs. subagent: compare `options.sessionId` to your preset's top-level
  session id, or check `payload.agent` in `agent/*` events for the initiating
  agent's identity chain.

---

## §6. `agent/pre-step` — quota gating, and injecting a message without a model call

### Signature

```ts
'agent/pre-step'(payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>

type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
```
(`packages/core/agent/src/runtime-types.ts`, `docs/subsystems/core.md`
lines 867-886.) Serial waterfall, the **only** serial listener chain before
request derivation; runs once per proposed step (including the very first
step of turn 1, and empty continuation batches between tool-driven steps).

### Rejecting a step

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  if (overQuota(payload.agent)) return { kind: 'reject' }
  return next()
}, { global: false })   // scope to the agent if registered from agentCtx
```

**What the user sees on reject:** "Reject opens no step... a rejected or
empty first claim still closes a durable turn that spent no step, so the log
records the attempt" (`docs/architecture.md` "Turn flow"). Concretely: the
turn opens (`turn/start`) and immediately closes (`turn/end`) with no
`step/start`/`step/end` and **no model call at all** — the UI sees a turn
that produced nothing. If you want the kid to see *why* ("we're done for
today"), you must inject that text yourself, since a bare reject is silent.

### Injecting a message to the user WITHOUT a model call

Two options, both durable:

1. **`agent.inject(message: UserMessage)`** — queues model-facing context for
   the *next* pre-step; does not wake the driver by itself
   (`docs/subsystems/core.md`, `Agent.inject`). Good for "the backpack is
   getting full" runtime-context style notices that should ride along with
   the kid's *next* turn rather than appear out of nowhere.
2. **Append a `user/message` event directly with a `plugin` source and no
   step**, then have your `agent/pre-step` listener reject the step so no
   model call follows: `session.append('user/message', {...}, {surfaceOp:
   'append'})` with `source: { kind: 'plugin', plugin: 'dsh-kid-tutor',
   form: 'notice', summary: "we're done for today" }`. This is exactly the
   "one-line why" pattern `plan-mode`'s own append-a-notice-then-reject-the-
   turn code uses (`docs/subsystems/plan.md`: *"An appended user selection
   also records one plugin-sourced `user/message` notice... so the model is
   told exactly when its context changed"*). Since it's a `user/message`, the
   **UI renders it in the transcript** even though no model call happened —
   this is the cleanest way to make the bot visibly say "we're done for
   today" with zero tokens spent.

Quota accounting must count judge calls too, per DESIGN.md §4 — since the
judge call from §5 is hand-built and invisible to `agent/pre-step` (which
only fires around real turns), your `quota` plugin needs to increment its own
counter explicitly at the point it dispatches the judge call, not rely on
`agent/pre-step` firing twice.

---

## §7. Session log — `SessionEvent` shape, appending a plugin-sourced event, on-disk path, cross-profile read access

### `SessionEvent<T>` envelope

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  type: T
  seq: number          // monotonic, seq === log.length at append time
  time: number          // epoch ms
  data: SessionEventMap[T]
  ignorable?: true      // readers may skip this type if unrecognized
} & (T extends SurfaceEventType ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp } : object)
```
(`docs/subsystems/session.md` "SessionEvent<T>"). `SurfaceEventType` = only
`'user/message' | 'assistant/message' | 'tool/result'` — the three that
produce model-visible messages and require `surfaceOp`/`sourceEventSeqs`.
Every other event type (including anything you declaration-merge) is
**log-only** and must NOT pass `SurfaceIntent`.

### Appending your OWN plugin-sourced event type (audit trail, judge I/O, guard verdicts)

Two layers, pick based on whether the fact should be model-visible:

**Log-only, not model-visible** (guard verdicts, judge I/O, quota counters —
exactly DESIGN.md §4/§6's audit needs): declaration-merge a new
`SessionEventMap` entry, the same way `compaction/*` and
`dsh-hook-protocol`'s `hook/invoked`/`hook/result` do
(`docs/subsystems/session.md` "Plugin-contributed log-only events"):

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'kid-tutor/guard-verdict': {
      stage: 'deterministic' | 'judge'
      verdict: 'pass' | 'block'
      reason?: string
      judgeInput?: string
      judgeOutput?: string
    }
  }
}
// append (no SurfaceIntent — compiler rejects passing one for a non-surface type):
session.append('kid-tutor/guard-verdict', { stage: 'judge', verdict: 'block', ... })
```

**Model-visible, appears in the transcript** (a "notice" the kid should see,
e.g. redo instructions after a homework-mode block): this is just an ordinary
`user/message` with `source: { kind: 'plugin', plugin: 'dsh-kid-tutor', form:
'notice', summary: '...' }` and `surfaceOp: 'append'` — see §6 option 2. The
`kind: 'plugin'` source (`MessageSourceMap.plugin`,
`packages/llm/llm/src/types.ts`) plus an optional `form` (`'instructions' |
'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'`) is the sanctioned
"plugin minted this content" vocabulary
(`docs/subsystems/llm-streaming.md` "Content blocks and messages").

Either way, `Session.append()`'s signature:

```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T>
```
`data` must be lossless-JSON-serializable or it throws at the append site
(`docs/subsystems/session.md` "Session public API").

### On-disk storage path

**Not partitioned by profile.** `dsh-base` mounts
`@deepseek-ai/dsh-session-persistence-jsonl` at `root: !!js
dshHomePath('sessions')` — i.e. `$DSH_HOME/sessions`
(`packages/bundle/base/cordis.patch.yml`, `id: session-persistence-jsonl`).
Confirmed on disk:

```
~/.dsh/sessions/
  session-index.sqlite
  --<normalized-cwd>--/                 # e.g. --Users-haoli-...-HomeLab--
    session-<uuid>/session.jsonl.zstd
    main-session-<uuid>/session.jsonl.zstd
```
(actual `ls` output under `/Users/haoli/.dsh/sessions`). Partitioning is by
**workspace cwd**, not by profile — `web`, `headless`, and any custom profile
sharing one `$DSH_HOME` all write into the same `sessions/` tree, split only
by the normalized working directory
(`packages/session/session-persistence-jsonl/README.md` "On-disk layout").
So a **kid** and **kid-admin** profile that share `$DSH_HOME` already share
one session store; give them **separate workspace roots** (different `cwd`)
if you want their transcripts to land in visibly different project
directories, or **separate `$DSH_HOME`s** if you want hard separation.

### `packages/session-query` — reading another profile's store read-only

`ctx.sessionQuery` (`docs/subsystems/session-query.md`,
`packages/session-query/session-query`) is a live-preferred read API over
**whichever `ctx.sessionPersistence` the composing process itself mounted** —
it is not a cross-process RPC. To let the **admin** profile read the **kid**
profile's sessions read-only, mount a `dsh-session-persistence-jsonl` (and
`dsh-session-query-sqlite`) in the admin process **pointed at the same
`root`** the kid process uses (an absolute path, not `dshHomePath(...)`
unless both share `$DSH_HOME`). This is safe for reads: "One live writer per
session... another backend instance or process must not write the same
session until that owner reaches quiescent disposal" — the admin process
just never calls `.append()` on those sessions, so it stays a read-only
second reader (`packages/session/session-persistence-jsonl/README.md`
"Known Limitations"). Key `ctx.sessionQuery` reads:

```ts
async listSessions(signal?): Promise<SessionRecord[]>
async readSession(sessionId): Promise<SessionLogSnapshot>       // full validated log
async listEvents(sessionId): Promise<SessionEventRecord[]>
async filterEvents(sessionId, filters): Promise<SessionEventSearchDocument[]>
async searchSessions(request, exec?): Promise<SessionSearchPage<SessionSearchHit>>   // needs FTS backend (session-query-sqlite) not `openAt: never`
async readSurface(sessionId): Promise<SessionSurfaceSnapshot>
```
(`docs/subsystems/session-query.md` "Cordis API"). Note `dsh-base` mounts
`session-query-sqlite` with `openAt: never` by default (full-text search
disabled until explicitly opted in) — the admin bundle should override that
row's `openAt` to `startup` or `first-search` if you want `searchSessions` to
work, per the base patch's own comment on that row.

`@deepseek-ai/dsh-tool-session-query` is the model-facing wrapper
(`session_event_read`, `session_event_search`, `session_event_trace`,
`session_search`, `session_trace` — `docs/tool-catalog.md` lines
1267-1502) if you'd rather give the admin's own agent read tools instead of
writing custom Cordis code; it "authorizes every result from the immutable
calling agent session," so pointing it at a *different* session store still
needs the admin's own composition to be the one holding that
`ctx.sessionPersistence`.

---

## §8. Web app bundle — bind/port, trust fence, browser auto-open, branding, non-interactive launch

### CLI flags (`dsh --profile web ...`)

From `packages/bundle/web-app/src/startup.ts`:

```
--host <host>            bind host (127.0.0.1 default; 0.0.0.0 explicitly REJECTED for safety)
--port <port>            listen port; 0 = OS picks a free one
--trusted-host <authority...>   repeatable; extra host(:port) the /api trust fence accepts
--no-open                do not open the default browser
```

Config rows that mirror these for a scripted/patched deployment (`id:
webserver`, `id: web-runtime` in `packages/bundle/web-app/cordis.patch.yml`):

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080

- id: web-runtime
  name: '@deepseek-ai/dsh-web-app'
  config:
    openBrowser: !!js ctx.webStartup.openBrowser   # false disables auto-open
    printUrl: true                                  # false silences the URL line (non-interactive)
    surfaceContext: true                             # false removes the "app:web-surface" prompt section + DSH_WEB_URL var
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

For phase 1 (LAN homelab host, DESIGN.md §7), launch non-interactively as a
long-running server with:

```sh
dsh --profile kid --host 127.0.0.1 --port 3081 --no-open
```

`--host 0.0.0.0` is a hard rejection at the flag parser
(`program.error('... intentionally not supported yet for safety...')`), so
binding to all interfaces for LAN reachability from the kid's laptop needs
either a specific LAN IP in `--host`, or a reverse proxy — matches Hao's
standing "no inbound exposure" / "no Docker TCP API" stance already in the
repo's own house rules, worth flagging back to the design if phase 1 assumed
`0.0.0.0`.

### Trust fence / `lanAddresses`

`resolveLanTrust(ctx.webServer.host, config.trustedHosts)`
(`packages/bundle/web-app/src/index.ts:133-138`) samples LAN IPv4 literals
**once, at bind time**, only when bound to all interfaces (moot here since
`0.0.0.0` is rejected outright) and appends any `--trusted-host` extras. It
is a **boot-time snapshot** — "interface changes after boot are not
re-advertised" (`packages/bundle/web-app/README.md` "Known Limitations").
Since the kid profile will bind a specific loopback/LAN address rather than
`0.0.0.0`, `lanAddresses` will simply be empty and only `trustedHosts` (your
explicit `--trusted-host` list) matters.

### Browser auto-open

Controlled by `openBrowser` (config) / `--no-open` (flag); also
auto-suppressed under SSH (`SSH_CONNECTION`/`SSH_TTY` env). For a boot-time
service on a homelab host with no interactive terminal, pass `--no-open`
explicitly rather than relying on SSH-detection, since a systemd/pm2-launched
process has neither variable set and would otherwise try (and fail) to spawn
a browser opener.

### Static title/branding/theme

**Not patchable at runtime** — see §0.4. `DSH_CLIENT_TITLE` and friends are
Vite build-time env vars consumed when building `dsh-web-frontend`'s dist;
`dsh-client-ui-brand-official` only fills sidebar/hero brand slots and
explicitly only when `DSH_CLIENT_BUILD_PROFILE=official`. There's no Cordis
row to patch for this in an out-of-tree bundle.

### Frontend dist ships in the install — confirmed

```
/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/
  index.html  manifest.webmanifest  favicon.svg  assets/
```
4.6 MB, prebuilt, present in the npm-installed package — no `pnpm run
build:web` needed to *run* the shipped web UI; you'd only need a from-source
build to *change* it (§0.4).

---

## §9. Schedule/jobs — there is no host-level cron primitive; use the Cordis timer that's already mounted

DESIGN.md §3/§6 assumes "dsh's own schedule/jobs packages for the nightly
digest." Having read both:

- **`@deepseek-ai/dsh-schedule`** (`docs/subsystems/schedule.md`,
  `packages/schedule/schedule`) is **session-local and model-facing**: it
  creates durable reminders (`schedule_create` tool) that "return to the
  original live Session as ordinary later conversation turns"
  (`docs/subsystems/schedule.md` header). It is designed for "remind me in 10
  minutes," not "run this host-side maintenance task nightly regardless of
  whether any session is open." Using it for the digest would mean the digest
  literally re-enters the kid's own session as a turn — wrong shape.
- **`ctx.jobs`** (`@deepseek-ai/dsh-jobs-local`, the `job_*` tools) is for
  **tool-driven background work** (a backgrounded `bash` run, a PTY send, a
  subagent) that a model call started and that gets collected/killed later.
  Also the wrong shape for an unattended nightly job with no triggering tool
  call.

**The Cordis-native primitive that actually fits** is
`@deepseek-ai/cordis-plugin-timer` (row `id: timer`, already mounted in
`dsh-base` — `packages/bundle/base/cordis.patch.yml`), which is a plain
disposal-aware timer service, not model/session-scoped at all:

```ts
export const inject = ['timer'] as const   // or just use ctx.interval directly if 'timer' is already in the tree

export function apply(ctx: Context, config: DigestConfig) {
  ctx.effect(() => ctx.interval(async () => {
    if (!isDigestTime(config.hourLocal)) return
    const sessions = await ctx.sessionQuery.listSessions()
    const digest = await buildDigest(sessions)           // §7's read-only cross-session query
    await postToNtfy(digest)                              // plain fetch(), outside the model/tool pipeline entirely
  }, 60_000 /* check every minute; the callback self-gates on the target hour */), 'kid-tutor digest timer')
}
```
(`ctx.interval(callback, delay)` API confirmed at
`.../node_modules/@deepseek-ai/cordis-plugin-timer/README.md`: *"Run
repeatedly and return a disposer... Timer handles are registered on the
current fiber, so they are cleared automatically when the plugin that
created them is disposed."*) This is a **host-plane** row (belongs in your
bundle, not the preset), runs once per process regardless of how many kid
sessions are open, and needs no session to exist at digest time. Flag the
DESIGN.md wording as slightly wrong about which dsh package to use; the
*intent* (nightly digest, linking session ids) is entirely achievable, just
via the timer + `ctx.sessionQuery`, not via `dsh-schedule`/`ctx.jobs`.

---

## §10. Model rows — `deepseek-official`, model ids, the "flash" id

Confirmed at `packages/llm/llm-deepseek/src/index.ts:80-90`:

```ts
const PROVIDER = 'deepseek-official'
const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', ... },
  { id: 'deepseek-v4-pro',   name: 'DeepSeek-V4-Pro',   ... },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text','image'], ... },
]
```

**Yes, a "flash" model id exists on `deepseek-official`: `deepseek-v4-flash`**
— and it is already the shipped default everywhere: `dsh-base`'s
`agent-default-model` row is configured `provider: deepseek-official, model:
deepseek-v4-flash`
(`packages/bundle/base/cordis.patch.yml`, `id: agent-default-model`). This
directly answers DESIGN.md §10's open question ("Exact model id for the
DeepSeek flash route — verify against the live catalog at charter time"):
verified in source, matches the design's assumption exactly, no charter-time
surprise expected — but re-run `mcat models dsh` (or `dsh --profile <name>
--dump-config` and inspect the `agent-default-model`/`llm-deepseek` rows) at
charter time anyway per the design's own stated policy, since this is a
live-updated catalog (`listModels()` is advisory and adapter-owned, so the
DEFAULT_MODELS array could change between now and charter).

Setting the route explicitly in a preset/patch: either the shared
`agent-default-model` host row's config, or per-request via `AgentOptions
{provider, model}` at agent creation, or process-locally via the
`dsh-model-env` sibling bundle's `DSH_MODEL`/`DSH_PROVIDER`/
`DSH_REASONING_EFFORT` env vars if you want a launch-time override without
touching settings.

`mcat models dsh` (this machine, live query) additionally lists
`deepseek-v4-pro` under a `frontier/premium/img` catalog bucket — useful for
sanity-checking the parent's stronger-model choice for the admin surface
(DESIGN.md §6a).

---

## §11. Build & test a bundle locally

Pattern is `dsh-model-env`
(`/Volumes/case-sensitive-volume/projects/src/github.com/TheRealHaoLiu/dsh-model-env`),
which is exactly the shape DESIGN.md §6 wants to reuse.

**`tsconfig.json`** (dev/typecheck, includes tests):
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

**`tsconfig.build.json`** (emits `dist/`, excludes tests):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "declaration": true, "declarationMap": true, "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*.ts"],
  "exclude": ["tests"]
}
```

**`vitest.config.ts`**:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.spec.ts"] } });
```

**`package.json`** essentials:
```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "^0.1.1-rc.2"
  },
  "devDependencies": { "...same as peer, plus": "vitest ^3.0.0, typescript ^5.7.0, prettier ^3.5.0" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "prepack": "pnpm run build"
  }
}
```

`prepack: "pnpm run build"` matters: **yes, `pnpm run build` must happen
before a profile boots the bundle**, because the profile's `package.json`
`main`/`exports` point at `./dist/index.js`, and a `link:` dependency (§1e)
is a real symlink into your working copy — pnpm does not build TypeScript on
install for you. `prepack` only fires on `npm pack`/publish, not on `pnpm
install` of a `link:` dep, so during development you must manually re-run
`pnpm run build` in the bundle after every source change before the profile
picks it up (there's no dev-mode watch/HMR path for out-of-tree bundle code
the way there is for in-tree `dsh` packages — `hmr` (`@deepseek-ai/cordis-
plugin-hmr`) watches the *in-tree* Loader roots, and both `headless` and
`web-app` bundle patches explicitly `disabled: true` it anyway).

**Own `pnpm-workspace.yaml`** (the bundle's own repo root, not the profile's):
```yaml
packages: []
allowBuilds:
  esbuild: true
```
(empty `packages` because the bundle has no internal workspace of its own;
`allowBuilds` opts a specific dependency's native postinstall script — here
`esbuild`, vitest's transitive dep — into pnpm's default-deny build-script
policy. Add any other native-postinstall dep your bundle pulls in here or
`pnpm install` silently skips its build step.)

**Profile-side `pnpm install` with `link:` deps**: the profile's own
`pnpm-workspace.yaml` (`~/.dsh/profiles/web/pnpm-workspace.yaml`) sets
`nodeLinker: hoisted` and `autoInstallPeers: false` — hoisted linking is what
makes a `link:` entry's own `peerDependencies` (e.g. `dsh-model-env`'s
requirement on `@deepseek-ai/cordis`) resolve against the profile's installed
copies rather than demanding the linked package vendor its own; disabling
`autoInstallPeers` means the profile's `package.json` must list every peer
your bundle needs explicitly (as `dsh-base`'s own bundle transitively
provides `@deepseek-ai/cordis`/`@deepseek-ai/dsh-agent`, this is usually
already satisfied once `dsh-base` is in `dsh.profile.bundles`, but verify
after adding a bundle with unusual peers).

Test harness pattern for a plugin that patches a `ctx.*` service
(`dsh-model-env`'s `tests/plugin.spec.ts`): construct a minimal fake `Context`
by hand (`{ agentDefaultModel: {...}, effect(factory) { disposers.push(factory()) } } as unknown as Context`)
rather than booting a real Cordis root — fast, no I/O, and exercises
disposal ordering directly. For anything that needs the *real* tool/session
pipeline (guard/judge logic), `packages/*/tests/*.spec.ts` across the
monorepo generally boot a real `Context` with just the packages under test
plus their declared `inject` deps — grep any `tool-*` package's own
`tests/*.spec.ts` for the minimal-boot pattern before inventing your own.

---

## Appendix: file/line index of everything cited above

- `packages/bundle/base/cordis.patch.yml` — host-plane row ids, defaults, comments explaining preset-vs-host ownership for nearly every subsystem touched above.
- `packages/bundle/web-app/cordis.patch.yml` — web-only rows, the disabled-tool block, `agent-presets` default.
- `packages/bundle/web-app/src/index.ts:29-138` — LAN trust resolution, config schema.
- `packages/bundle/web-app/src/startup.ts` — CLI flags.
- `packages/bundle/headless/cordis.patch.yml` — headless has no presets; direct tool/persona patching.
- `apps/cli/config/agent-presets/{standard,minimal}/agent.cordis.yml` — the two clearest preset exemplars.
- `packages/preset/agent-presets/README.md` — the entire preset mounting mechanism, realms, `--dump-config` blind spot.
- `packages/preset/persona/src/index.ts` + `README.md` — persona shadowing mechanics.
- `packages/core/system-prompt/README.md`, `docs/subsystems/system-prompt.md` — global persona ownership, `ctx.systemPrompt` API.
- `docs/subsystems/tools.md` — `ToolDefinition`, `tools/pre-execute`/`post-execute`/`execute` waterfalls, `ToolGuard`.
- `docs/tool-catalog.md` (generated) — every shipped tool's exact JSON schema, incl. `web_fetch`'s `url` field.
- `packages/web/web-fetch-http/README.md` — the SSRF gotcha, verbatim.
- `packages/web/web-search-{deepseek,exa,perplexity}/README.md` — provider credentials/config.
- `docs/subsystems/code-runtime.md` — `ctx.codeRuntime`, the TypeScript-only-backend gap.
- `docs/subsystems/llm-streaming.md` + `packages/llm/llm/src/call-config.ts` — `StreamChunk`, `isAgentLoopRequest`/`markAgentLoopRequest`.
- `packages/session/session-title-llm/src/index.ts` — the real hand-built-nested-call precedent.
- `packages/core/agent-loop/src/invariant.ts` — where the harness itself uses `isAgentLoopRequest` to skip non-conversation calls.
- `docs/subsystems/core.md` — `agent/pre-step`, `agent/turn-stopping`, `Agent` interface (`inject`, `steer`, `followup`).
- `docs/subsystems/session.md` — `SessionEventMap`, `SessionEvent<T>`, plugin-contributed log-only events, `Session.append()`.
- `packages/session/session-persistence-jsonl/README.md` — on-disk layout, one-writer-per-session rule.
- `docs/subsystems/session-query.md`, `packages/session-query/*` — `ctx.sessionQuery` API.
- `packages/llm/llm-deepseek/src/index.ts:80-90` — model ids.
- `.../cordis-plugin-timer/README.md` (installed copy) — `ctx.interval`, the digest primitive.
- `dsh-model-env` (sibling repo) — the whole reference bundle shape, tsconfig/vitest/package.json/tests.
- Installed npm package `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` — confirms shipped frontend dist, real binary location, version `0.1.1-rc.2`.
