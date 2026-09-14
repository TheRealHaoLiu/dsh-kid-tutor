# Design

Design document for `dsh-kid-tutor`. This is the exploration-and-decisions record;
implementation charters link back here and carry only pointers to decisions, not
the reasoning. Rejected alternatives stay in this file so they are not re-pitched.

## 1. Problem

A parent wants a chatbot for a nine-year-old that:

- tutors rather than answers — guides to the solution, does not do the homework;
- helps the kid query world knowledge at a nine-year-old's reading level;
- is the kid's guided door to the internet, not a browser;
- teaches how to work with an LLM (context, sessions, tools) by making the
  machinery visible;
- helps them learn Python on their own machine, in their own project folder;
- gives hints, not walkthroughs, for video games;
- helps them learn to use a computer;
- has a kid-friendly UX;
- gives the parent an auditable record of everything that happened.

The chosen model is DeepSeek's hosted flash-class model. Model choice is a
config row and can change; nothing in this design depends on the model being
safe, aligned, or honest.

## 2. Mental model

**The model is an untrusted component.** Like a fetched web page, it produces
text that may be wrong, manipulative, or unsafe. Every property listed below is
enforced by a harness plugin or it does not exist. The system prompt governs
*quality* (tone, persona, hint ladder, reading level); it governs no safety
property. The test: delete the prompt and every row in the enforcement table
still holds.

### Trust boundaries

| Party | Trust | Notes |
|---|---|---|
| The kid | Principal | Trusted intent, not trusted content. Prompts can be careless; that is fine. |
| The model | Untrusted | Text and tool calls are proposals. |
| Tool results | Untrusted | A fetched page is a prompt-injection vector. |
| The parent's account, the workspace, the API key | Assets | What the guards protect. |
| The parent | Administrator | Reads the log, patches the rows. |

## 3. Why dsh

dsh is a Cordis plugin tree. Persona (system-prompt sections), tool registry,
sandbox policy, the model-call stream, compaction, the web surface, and the
append-only session log are all rows a bundle can insert beside or patch.
Registrations are reversible effects that unwind on unload. That gives us:

- an **output seam** — the `llm/stream` waterfall wraps every model call and can
  read, replace, or short-circuit the chunk stream, including issuing a nested
  call;
- a **tool seam** — `tools/pre-execute` / `tools/post-execute` for allowlists and
  result sanitizing, and a scoped registry where unregistered tools do not exist;
- **file seams** — `fs/write-intent` / `fs/edit-intent` waterfalls plus the
  sandbox-policy and sandbox-windows-acl packages;
- a **step seam** — `agent/pre-step` for quotas and cutoffs;
- an **auditable log** — the `SessionEvent` log is append-only and first-class;
  plugin-sourced events are a normal thing to append;
- a **scheduler** — dsh's own schedule/jobs packages for the nightly digest;
- a **web surface** bundle and a **Python code runtime** already in tree.

## 4. Enforcement table

All deterministic unless marked *judge*.

| Property | Seam | Mechanism |
|---|---|---|
| Can only do X | tool registry | Only web fetch, web search, Python runtime, and workspace fs are registered. No shell in phase 1. Unregistered = nonexistent, not forbidden. |
| Can only touch the kid's files | `fs/write-intent`, `fs/edit-intent`, sandbox ACL | Any path outside the workspace root is rejected before the write. |
| Can only browse allowlisted sites | `tools/pre-execute` | Domain allowlist (e.g. Wikipedia, Bulbapedia, Python docs). Rejected URL is logged. |
| Fetched pages cannot steer | `tools/post-execute` | Fetched text is wrapped as quoted data; instruction-shaped lines are stripped. |
| Says nothing off-limits | `llm/stream` | Buffer the full message; stage 1 deterministic filters; stage 2 *judge*; release or replace. |
| Does not hand over answers (homework mode) | `llm/stream` | *Judge* flags "reveals final answer" → nested call with a redo instruction. The kid sees only the redo. Both messages are logged. |
| Bounded spend and time | `agent/pre-step` | Daily turn cap (counts judge calls too), evening cutoff. The bot itself says "we're done for today." |
| Parent sees everything | session log + schedule | Guard verdicts, suppressed messages, judge I/O, rejected tool calls as plugin-sourced events. Nightly digest to a push channel. |

### Output guard, two stages

1. **Deterministic.** Word lists, raw URLs outside the allowlist, phone/address
   patterns, anything shaped like a command to run outside the sandbox.
2. **Judge.** A second call to the same model route with a narrow classifier
   prompt and *no* conversation history. A judge is still a model, so it is not a
   guarantee. It is independent failure: the model must misbehave *and* the judge
   must miss it on a different prompt. Judge input and output are logged verbatim.

The judge runs on **every** message. Running it only in "homework mode" would make
mode detection its own untrusted classifier.

### Costs accepted

- **No token streaming.** The guard needs the full message before the kid sees
  it. Stream-then-retract is worse for a kid than a two-second wait; flash-class
  models make the wait small.
- **Fail closed.** Judge unavailable → "hmm, ask me that again." Never fail open.
- **Two model calls per turn.** Cheap at flash pricing; the quota counts both.

## 5. Pedagogy (quality layer)

- **Hint ladder, not a wall.** Three escalating hints, then a "show me" that is
  allowed but visibly logged, followed by "explain it back to me."
- **Domain modes.** Homework and Python get Socratic mode. Curiosity questions
  ("how do volcanoes work") get direct answers at reading level. Treating
  curiosity as cheating kills the product.
- **Games** use the same ladder against a fetched wiki page; never a walkthrough
  dump.
- **Transparency as curriculum** (later phase): a context meter ("the backpack is
  getting full"), a "new conversation" button with a one-line why, compaction
  surfaced as "I packed up our old chat, here is my summary," tool calls shown as
  cards ("I'm looking this up on Wikipedia"). dsh already emits these events; the
  work is in the web surface.
- **The competitor is the consumer chatbot on the same laptop.** If the tutor is
  the annoying one, a kid routes around it in a week. Fun beats restriction.

## 6. Architecture

One out-of-tree bundle, `dsh-kid-tutor`, declaring `dsh.bundle.patch` like
[dsh-model-env](https://github.com/TheRealHaoLiu/dsh-model-env). Plugins inside it:

| Plugin | Seam | Owns |
|---|---|---|
| `persona` | system-prompt sections | Tutor persona, hint ladder, domain modes, reading level. Near the prompt head, stable per process (KV-cache friendly). |
| `tool-policy` | `tools/pre-execute`, `tools/post-execute` | Domain allowlist; fetched-content quoting/sanitizing. |
| `workspace-fence` | `fs/*-intent`, sandbox rows | Workspace root confinement. |
| `output-guard` | `llm/stream` | Buffer, stage-1 filters, stage-2 judge, redo nested call, fail-closed fallback. |
| `quota` | `agent/pre-step` | Daily cap, cutoff hours, judge-call accounting. |
| `audit` | session log | Appends guard verdicts and suppressed content as plugin-sourced events. |
| `digest` | schedule | Nightly summary to a push channel, linking session ids. |
| `transparency` (later) | web surface | Context meter, compaction moments, tool cards. |

A **profile** (`kid`, name TBD) composes: `dsh-base` → `dsh-web-app` →
`dsh-kid-tutor` → a `cordis.patch.yml` setting the model row, bind address,
workspace root, allowlist, quota numbers, and the kid's name. Nothing kid-specific
lives in the bundle; it is all patch rows.

**Cordis test for every change:** is it a plugin contributing services/events/
reversible effects, configured as rows a higher layer can patch? If it needs a
fork, a monkey patch, or a reach around the tree, it is the wrong design.

## 6a. Admin surface

The parent needs a surface that is **separate from the kid's front end** and that
can use AI to introspect the kid's activity ("what did they ask about today?",
"did any guard fire this week?", "show me the redo pairs").

Cordis-native shape: a **second profile**, `kid-admin`, running as its own process
on its own port. It composes `dsh-base` → `dsh-web-app` → `dsh-kid-tutor-admin`,
where the admin bundle contributes:

- an **analyst persona** (system-prompt section) for the parent, no tutor rules;
- **read-only tools** over the kid profile's session store: list sessions, read a
  session's trajectory, list guard/audit events, list rejected tool calls;
- a **digest** command that produces the nightly summary on demand.

Separation is by process, profile, port, and model row (the parent may run a
stronger model). The kid profile never loads the admin bundle and has no tool that
reads its own store. In phase 2 the admin process is launched by the parent, not
at boot, so it is not reachable from the kid's OS session unless the parent starts it.

## 6b. Corrections from reconnaissance (2026-09-14)

Reading dsh source ([docs/dsh-seams.md](docs/dsh-seams.md)) changed four premises:

1. **Web sessions are shaped by an agent preset, not the bundle patch.** The web
   bundle disables tools at the host layer and re-enables them per session from
   `agent.cordis.yml`. So the kid's persona, tool roster, guard and quota rows live
   in a **preset** (`presets/kid/`), and the bundle carries only host-plane rows.
   Still Cordis-native: same row shape, different plane.
2. **`web_fetch` is an SSRF primitive** by its own README. The domain allowlist in
   `tools/pre-execute` is the only thing between the kid's prompt and the LAN. It
   also rejects literal IPs, private ranges, and local hostnames.
3. **No Python runtime exists in dsh.** `run_code` is TypeScript only. Phase 1
   ships a custom `run_python` tool: a `python3` subprocess confined to the
   workspace, isolated mode, timeout, output cap, no argv passthrough. It is not
   a shell. A proper `ctx.codeRuntime` Python backend is later work.
4. **The web UI cannot be re-skinned from a bundle.** Branding is a Vite
   build-time concern. Phase 1 uses the stock chat window; kid-friendliness comes
   from persona tone and the surfaces dsh already renders.

Also: the flash model id is `deepseek-v4-flash` on `deepseek-official`, and the
nested-call pattern inside `llm/stream` is real (recursion guard =
`isAgentLoopRequest` / `markAgentLoopRequest`, precedent: the session-title
plugin). Both former open questions are closed.

## 7. Deployment models

### Phase 1 — homelab host

The bundle and profile run on a LAN host in the author's homelab, reached from
the kid's laptop browser. The Python runtime and workspace live on that host,
so "learn Python on your own machine" is *not* exercised in phase 1. What phase 1
proves: the guards, the judge, the quota, the audit loop, the digest, and the
persona. Everything is built so that the only change for phase 2 is the patch
file and the process supervisor.

### Phase 2 — final model: the kid's laptop

- dsh runs as a **boot-time service under the parent's OS account** on the kid's
  laptop, Windows-native (a WSL distro only runs inside the parent's interactive
  session, so it is the wrong host for a service another user needs).
- Web surface **bound to loopback**. The kid signs into their own OS account and
  opens the browser to localhost. Same-machine loopback crosses user sessions.
  No LAN exposure, no auth story, no router rules.
- The API key lives in the parent's dsh credentials store. The kid never holds a
  secret.
- **Privilege consequence:** every tool call runs as the parent's account, which
  is a local admin. The narrow tool registry and the workspace fence are what
  stand between the kid's prompt and that account. Recorded escape hatch: a
  dedicated standard-user service account owning the dsh process — a one-row
  change, kept as an alternative rather than the default.
- Workspace root = the kid's project folder, which the parent's account can
  write, so Python actually runs against the kid's files.

## 8. Decided (do not re-litigate)

- Base = dsh as an out-of-tree bundle; no fork.
- Model is untrusted; safety comes from the harness only. Model choice is a
  config row.
- Output guard = deterministic stage + judge stage, every message, fail closed,
  no streaming.
- Judge = same route, separate narrow prompt, no history, I/O logged verbatim.
- Phase 1 on a homelab host; phase 2 = Windows-native service under the parent's
  account, loopback-only.
- Open source, MIT, built in public. The kid's name and any home-network detail
  live in the private patch file, never in this repo.
- Local link-dependency bundle first; publish only when it stabilizes.
- Admin surface = separate profile/process/port with AI introspection over the
  kid's session store (§6a). Never the same web surface as the kid.
- **Reversal (2026-09-14): the kid gets a minimal custom front end
  (`packages/dsh-kid-tutor/src/kid-ui.ts` + `src/kid-ui/index.html`), not the stock dsh
  web UI.** §6b/§10 had left this as "phase 1 uses the stock chat window" because
  re-skinning it requires owning a from-source frontend build (§0.4/§9's own "A kid-facing
  custom front end from day one... real maintenance bill"). The parent's actual
  requirement — far fewer knobs than dsh's stock UI: no model picker, no preset picker, no
  trajectory/step viewer, no settings, no workspace picker — cannot be met by persona tone
  alone, since those are UI chrome the stock frontend always renders regardless of what the
  model says or does. The reversal is a **second, additive front end**, not a fork of the
  first: a self-contained page (inline CSS/JS, no build step, no CDN) served from an exact
  webserver route that wins over the stock UI's fallback route without disabling any dsh
  row, talking to the identical `/api/session.*` + `events.mux` surface the stock UI
  uses, with the session's workspace root and agent preset pinned server-side so the
  browser can never choose either. See `packages/dsh-kid-tutor/README.md`'s "Kid UI"
  section for the exact routes and protocol.
  - **Rejected alternative:** rebuilding `dsh-web-frontend` from source with a
    `DSH_CLIENT_*` kid build profile. Owning an upstream frontend build (its own Vite
    config, its own release/rebase burden against `deepseek-harness` upstream) is a much
    larger maintenance bill than one static HTML file, for a UI surface this project needs
    to be deliberately small rather than deliberately complete.

## 9. Rejected alternatives

| Alternative | Why not |
|---|---|
| Open WebUI (already in the author's lab, chosen partly for kid-chat oversight) | No agentic loop: no sandboxed Python on the kid's machine, no guarded browsing, no file access. Three of the use cases die. |
| Open WebUI as front end, dsh as the brain | dsh's "API gateway" is its internal RPC, not an OpenAI-compatible endpoint. Would need a shim that owns its own maintenance bill. |
| Prompt-only guardrails | The kid can argue the model out of them; fetched pages can inject around them; nothing is enforced. |
| Trusting the model's own safety training | Wrong mental model. See §2. |
| Stream tokens and retract on a guard hit | A kid watching text vanish is worse than a short wait. |
| Judge only in "homework mode" | Mode detection becomes its own untrusted classifier. |
| dsh inside WSL as the phase-2 host | Runs only inside the parent's interactive session; dies when the kid logs in alone. |
| Locally hosted uncensored/abliterated models | Wrong tool for a child, full stop, even behind guards. |
| A kid-facing custom front end from day one | Real maintenance bill; the web bundle skinned is enough until the transparency phase earns it. |

## 10. Open questions

- A real `ctx.codeRuntime` Python backend to replace the phase-1 subprocess tool.
- Kid-friendly re-skin: requires building the web frontend from source; decide
  whether that is worth owning.
- Whether the web bundle's trust fence needs any change for the phase-1 LAN host
  (it binds loopback by default and prints a LAN URL).
- Digest privacy line: counts and fired guards only, or session excerpts? Parent's
  call.
- Profile name and the bundle's public name (working: `dsh-kid-tutor`).
