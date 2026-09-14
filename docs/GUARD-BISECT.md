# GUARD-BISECT — why `output-guard` never guarded the main turn

Status: **root-caused and fixed.** This note records the bisect so the wrong
theory in the old `src/output-guard.ts` header (and in the old README "Known
gaps") is not re-derived by the next person.

## Symptom

`packages/dsh-kid-tutor/src/output-guard.ts` registers an `llm/stream`
waterfall listener from the agent preset (`presets/kid/agent.cordis.yml`, row
`output-guard` inside the `kid-guards` group). Live, against
`@deepseek-ai/dsh` `0.1.1-rc.2`:

- the on-disk session log carries the RAW adapter reply — a `reasoning` block
  plus a `text` block — not this plugin's single synthesized `text` block;
- zero `kid-tutor/guard-verdict` events in any session;
- `tool-policy`'s `tools/pre-execute` listener and `quota`'s `agent/pre-step`
  listener, mounted from the SAME preset file, fire on every turn.

Evidence, still on disk:

```
~/.dsh-kid/sessions/--Users-haoli-.dsh-kid-workspace--/session-3bbbe472-*/session.jsonl.zstd
  seq 6   kid-tutor/quota            <- quota row works
  seq 625 assistant/message  {"content":[{"type":"reasoning",...},{"type":"text",...}]}
  (no kid-tutor/guard-verdict anywhere)
```

## The wrong theories (ruled out, do not re-test)

1. **Scope-filtered dispatch.** `llm/stream` is not a scoped event. The
   generated routing table `packages/core/scope/src/scoped-events.generated.ts`
   lists every scope-filtered event (`tools/pre-execute`, `agent/pre-step`,
   `agent/request`, …) and `llm/stream` is not among them. Its dispatch subject
   is the `LlmRuntime` service itself
   (`packages/llm/llm/src/index.ts:992-997`), not a `Scoped<Agent>` carrier, so
   `dsh-scope`'s ancestor-chain filter never runs on it.
2. **A second dispatch path for the main turn.** `agent.ts:346`
   (`preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`) reaches
   `LlmRuntime.streamWithRegistration()` either way
   (`packages/llm/llm/src/index.ts:861` for the prepared path, `:986` for the
   plain one), and that is the single site that runs
   `this.ctx.waterfall(this, 'llm/stream', …)`.
3. **The preset plane cannot see host-plane waterfalls.** It can. The only
   filter cordis applies to this dispatch is `Service[Context.filter]`
   (`@deepseek-ai/cordis/src/service.ts`), which compares the isolate label for
   the service name `llm` between the dispatching runtime's context and the
   listener's context. Nothing in this repo or in `dsh` isolates `llm`; the
   `kid-guards` group isolates `kidQuota` only.
4. **"The listener body never ran."** It ran, on every main turn. The previous
   builder's trace printed `purpose: undefined` lines and read those as
   "hand-built auxiliary calls" — but `GenerateOptions.purpose` is
   `'compaction' | 'session-title'` and nothing else
   (`packages/llm/llm/src/types.ts:376`), so `purpose: undefined` IS the main
   agent-loop turn. The listener was firing and taking its first early-return.

## Root cause: two copies of `@deepseek-ai/dsh-llm`, two WeakSets

`isAgentLoopRequest()` is not a property test. It is a lookup in a
**module-private `WeakSet`**:

```ts
// packages/llm/llm/src/call-config.ts:64-78
export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}
export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}
```

The agent loop marks its request at
`packages/core/agent-loop/src/agent.ts:505` (`markAgentLoopRequest(deepFreeze({…}))`)
using the copy of `@deepseek-ai/dsh-llm` that the **installed harness**
resolves:

```
/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js
```

`output-guard.js` is mounted by ABSOLUTE path (see the preset header for why a
relative path or a symlinked preset directory cannot work), so Node's ESM
loader resolves the plugin's own bare `@deepseek-ai/dsh-llm` import upward from
`packages/dsh-kid-tutor/dist/`, landing on **this repo's** dev copy:

```
<repo>/node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.1-rc.2_…/node_modules/@deepseek-ai/dsh-llm/lib/index.js
```

Two module instances, two `AGENT_LOOP_REQUESTS` WeakSets. Proof (no model
calls, reproducible in one command):

```console
$ node --input-type=module -e "
const A = await import('<repo>/node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.1-rc.2_…/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
const B = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
const req = { provider:'p', model:'m', messages: [] };
B.markAgentLoopRequest(req);
console.log('host copy sees mark:', B.isAgentLoopRequest(req));
console.log('plugin copy sees mark:', A.isAgentLoopRequest(req));
"
host copy sees mark: true
plugin copy sees mark: false
```

So `isAgentLoopRequest(options)` in this plugin returns `false` for **every**
request, including the main turn, and the listener's first statement —
`if (!isAgentLoopRequest(options)) { yield* next(); return }` — made the guard a
pure pass-through on every call it ever saw.

This is a general hazard for any out-of-tree dsh plugin loaded by absolute
path: **a `@deepseek-ai/dsh-*` API whose identity lives in module state
(`WeakSet`, `WeakMap`, a module-level `Symbol()`, `instanceof`) is not usable
across the boundary.** Pure functions (`BlockAssembler`, `createUserMessage`,
`deepFreeze`, `deadline`) are fine — they only build plain objects.

## The fix

Confined to `src/output-guard.ts`. It stops asking the other module instance a
question only that instance can answer, and answers it locally instead:

- **Our own nested calls** (judge, redo) are marked in a WeakSet owned by this
  module. Same module instance on both sides of that mark, so it is reliable —
  this is what keeps the guard from recursing into itself.
- **A main-turn request** is anything that is (a) not one of ours, (b) carries
  no `purpose`, and (c) carries a `sessionId` this plugin saw announced through
  `agent/created`. The harness has exactly three `llm/stream` producers, so
  those three conditions are exhaustive, not heuristic:
  | producer | `purpose` | site |
  |---|---|---|
  | agent loop (the turn we guard) | `undefined` | `packages/core/agent-loop/src/agent.ts:505` |
  | compaction summarizer | `'compaction'` | `packages/compaction/compaction-basic/src/summarizer.ts:161` |
  | session-title | `'session-title'` | `packages/session/session-title-llm/src/index.ts:259` |
- **Steps that finished `error`/`aborted` pass through untouched.** That
  terminal chunk is the agent loop's own failure channel — it drives
  `agent/request-error` and the retry policy. Buffering it and synthesizing a
  calm replacement turns a provider outage into "ask me a different way" with
  the real failure recorded nowhere. Latent for the same reason as the next
  item: the guard never actually ran. The check is deliberately narrower than
  "not `stop`": `max-tokens` is also a non-`stop` finish, and a brevity-capped
  reply is exactly the kind that still needs filtering, so it takes the normal
  guarded path.
- **Tool-call steps pass through untouched.** The guard reconstructs the stream
  as one `text` block; doing that to a step whose reply contains `tool-call`
  blocks would silently delete the tool calls and break `web_fetch` /
  `run_python`. Since the guard never actually fired before, this latent bug had
  never been hit. It now buffers the raw chunks and re-emits them verbatim when
  the assembled reply contains any `tool-call` block; only the final,
  text-only reply — the one the kid reads — is filtered, judged and
  re-synthesized.
- `debug: true` on the row's config prints one `[kid-tutor/output-guard]` line
  per dispatch to stderr, reporting the discriminator inputs and the decision.

### Rejected alternatives

- *Make the plugin import the harness's copy* (resolve `@deepseek-ai/dsh-llm`
  through `ctx.loader.internal.import()` against `ctx.root.baseUrl`). Works in
  principle, but it makes the plugin depend on a loader internal and on the
  root's base URL staying the harness's own — a worse dependency than not
  needing the singleton at all.
- *Link the repo's `node_modules/@deepseek-ai/dsh-llm` at the installed
  harness's copy in `scripts/install.sh`.* Fixes it for this machine only, and
  silently regresses the moment anyone runs `pnpm install`, with the same
  invisible failure mode (a guard that passes everything through).
- *Move the row to the bundle's host-plane `cordis.patch.yml`.* Would not have
  helped: the plane was never the problem, and the host plane cannot see the
  preset's `kidQuota` realm.

## Verification (one live turn, `deepseek-v4-flash`, 2026-09-14)

Launched as `zsh -ic 'export DSH_HOME=$HOME/.dsh-kid KID_NAME=…; dsh --profile kid --port
3085 --no-open'` — the interactive shell is required so `~/.zshrc.d/dsh`'s `agent-vault`
wrapper function is defined; a bare `dsh` (or `zsh -lc`, login-but-not-interactive) boots
and then fails every call with `MISSING_CREDENTIAL`. Driven with one `session.create` +
`session.prompt` over `POST /api/…`, prompt "What is the tallest mountain in the world?".

Stderr, with `debug: true` on the row — three dispatches, one decision each:

```
[kid-tutor/output-guard] dispatch guarded=true  purpose=null          sessionId=session-924b80c7… knownSession=true ownCall=false markedByHarness=false
[kid-tutor/output-guard] dispatch guarded=false purpose=session-title sessionId=session-924b80c7… knownSession=true ownCall=false markedByHarness=false
[kid-tutor/output-guard] dispatch guarded=false purpose=null          sessionId=session-924b80c7… knownSession=true ownCall=true  markedByHarness=false
```

`markedByHarness=false` on the guarded main turn is the root cause restated at runtime:
the harness DID mark that request, and this plugin's copy of the WeakSet cannot see it.

Session log (`~/.dsh-kid/sessions/…/session-924b80c7-9298-4be7-b8db-4ebf5772dcba`):

```
kid-tutor/guard-verdict  {"stage":"deterministic","verdict":"pass",…}
kid-tutor/guard-verdict  {"stage":"judge","verdict":"pass","category":"none","severity":0,
                          "reason":"Short, simple, factual answer to a curiosity question
                                    with an inviting follow-up question.", …}
assistant/chunk          block-start text / block-end text / finish {"kind":"stop"}
assistant/message        content: [ one {"type":"text"} block ]
                         usage: {inputTokens:3495, outputTokens:114, reasoningTokens:39}
turn/end                 {"reason":{"kind":"completed"}}
```

Both properties hold: `kid-tutor/guard-verdict` events are present, and the
`assistant/message` is the guard's re-synthesis — a SINGLE `text` block, with the model's
reasoning block dropped even though `reasoningTokens: 39` proves the adapter emitted one.
Before the fix the same session shape carried the raw two-block (reasoning + text) reply
and no verdict events at all.
