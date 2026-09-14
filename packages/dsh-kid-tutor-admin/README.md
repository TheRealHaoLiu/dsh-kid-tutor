# dsh-kid-tutor-admin

The parent's side of [dsh-kid-tutor](../../README.md): a second DSH profile,
`kid-admin`, that gives a read-only AI analyst over the kid profile's session
store. See [DESIGN.md §6a](../../DESIGN.md#6a-admin-surface) for the design and
[docs/CONTRACT.md](../../docs/CONTRACT.md) for the binding shared agreements
with the kid bundle (event names, homes, ports, model rows).

Nothing here writes to the kid's session store. It opens a second,
independent `@deepseek-ai/dsh-session-persistence-jsonl` +
`@deepseek-ai/dsh-session-query-sqlite` pair pointed at the kid profile's
`sessions/` directory and only ever reads it
(docs/dsh-seams.md §7 "One live writer per session").

## Plugins

| Plugin | Plane | Row | Owns |
|---|---|---|---|
| `kid-admin-config` | host (bundle) | `kid-admin-config` | The one patchable config row (`kidSessionsDir`/`timezone`/`defaultSince`), published as `ctx.kidAdminConfig`. |
| `kid-store` | host (bundle), inside an isolated `cordis:group` | `kid-store` | A **service** (`ctx.kidStore`) wrapping a private, isolated `sessionPersistence`/`sessionQuery` pair pointed at `kidSessionsDir`, plus `kidTutorEventsDir`'s sidecar audit files. `listSessions`/`readSession`/`guardEvents`/`deniedTools`/`quotaEvents`/`pythonRuns`/`stats`. |
| `admin-tools` | agent (preset) | `admin-tools` | Registers the `kid_*` tools into `ctx.tools` for whichever agent preset mounts it (`presets/kid-admin`). |

`kid-store` and its private session-persistence/session-query pair live in
**this package's own `cordis.patch.yml`** (host plane), not the preset —
even though docs/dsh-seams.md §1d's isolated-`cordis:group` guidance is
usually illustrated on preset rows, it is a general Loader/Cordis primitive
available to any patch file in the same Loader tree (docs/dsh-seams.md §1b).
Keeping the isolated group host-plane, rather than per-session, is what lets
`profiles/kid-admin/cordis.patch.yml` override `kid-admin-config`'s
`kidSessionsDir` — a *host-plane* profile patch cannot reach into an
agent-plane preset's own rows (docs/dsh-seams.md §1b's table: "Applies to").
Only `admin-tools` needs to be a preset row, since tool availability is
per-session for a web profile (docs/dsh-seams.md §0.1).

## Config (`KidAdminConfig`, `src/config.ts`)

| Key | Default | Notes |
|---|---|---|
| `kidSessionsDir` | `$HOME/.dsh-kid/sessions` | Must equal the kid profile's own `session-persistence-jsonl` `root`. |
| `kidTutorEventsDir` | `$HOME/.dsh-kid/kid-tutor/events` | Must equal the kid profile's own sidecar audit root (`dsh-kid-tutor/events.ts`'s `kidTutorEventsDir()`) — guard-verdict/tool-denied/quota/python-run/alert facts for any session written after the sidecar fix (see "Known limitations" below). |
| `timezone` | `""` (host local) | IANA zone used to format timestamps and bucket `stats()` by day. |
| `defaultSince` | `"24h"` | Fallback lookback window (`resolveSince` also accepts `"<n>h"`, `"<n>d"`, `"<n>m"`, or an ISO timestamp) for any tool/method call that omits `since`. Unparsable input fails OPEN to the default window rather than erroring — a guard/digest surface should always show *something*. |

Override in `profiles/kid-admin/cordis.patch.yml`:

```yaml
- id: kid-admin-config
  config:
    kidSessionsDir: !!js process.env.DSH_KID_SESSIONS_DIR ?? (process.env.HOME + '/.dsh-kid/sessions')
    kidTutorEventsDir: !!js process.env.DSH_KID_TUTOR_EVENTS_DIR ?? (process.env.HOME + '/.dsh-kid/kid-tutor/events')
```

## Tools (`admin-tools.ts`)

`kid_list_sessions`, `kid_read_session`, `kid_guard_events`, `kid_denied_tools`,
`kid_quota_events`, `kid_python_runs`, `kid_alerts`, `kid_stats`, `kid_digest`.
Every result opens with an explicit notice that the kid's and model's own
words inside it are quoted content, not instructions — the same
untrusted-content posture DESIGN.md §2 applies to the kid's own tool results.

`kid_guard_events` includes each judge-stage verdict's `category`/`severity`
classification (per docs/CONTRACT.md) when present; a deterministic-stage
verdict never carries one. `kid_alerts` lists every `kid-tutor/alert` attempt
(category, severity, the kid's triggering message, and whether the parent
webhook actually delivered) — the durable record of what `parent-alert.ts`
tried to tell the parent, independent of whether it succeeded.

`kid_digest` is deterministic (`src/digest.ts`): no model call, so it is a
safe first move for any "what happened" question and gives the analyst model
a bias-free starting point. It puts alerts and any guard verdict with
`severity >= 1` up front under a "Needs a look" heading, ahead of the
ordinary sessions/guard-fires/denials/quota/python-runs sections, so the
parent-relevant signal is never buried below routine activity.

## Build & test

```sh
pnpm install        # from the repo root (workspace)
pnpm --filter dsh-kid-tutor-admin run build
pnpm --filter dsh-kid-tutor-admin run check
pnpm --filter dsh-kid-tutor-admin test
```

`tests/kid-store.spec.ts` writes fixture sessions through the REAL
`@deepseek-ai/dsh-session-persistence-jsonl` backend (so the on-disk layout is
exactly what the kid process would write), then boots a second, independent
reader over the same root — the same shape production uses — and exercises
every `KidStore` method plus `buildDigest` end to end.

## Install

```sh
scripts/install-admin.sh    # from the repo root
DSH_HOME=$HOME/.dsh-kid-admin dsh --profile kid-admin --port 3082 --no-open
```

The installer never prints secret values: it symlinks `.credentials.yaml`
(never reads it) and, before copying `settings.yaml`, prints only its KEY
NAMES (never values) for inspection.

## Known limitations / unverified

- **Sessions written before the sidecar fix are read-only-recoverable, not
  kid-resumable.** Every real on-disk kid session used to fail
  `ctx.sessionQuery.readSession()` with `SESSION_QUERY_PERSISTENCE_FAILED`
  ("contains event type \"kid-tutor/quota\" ... unknown to this harness and
  not marked ignorable") — a smoke check of the real `~/.dsh-kid/sessions`
  (19 sessions) found only 1 readable. Root cause (see
  `dsh-kid-tutor/src/events.ts`'s module doc and docs/dsh-seams.md §7 "Known
  deviation"): dsh's runtime reader checks a *compile-time-generated*
  `KNOWN_SESSION_EVENT_TYPES` set built only from event types declared
  *inside the deepseek-harness repo itself* — an out-of-tree bundle's own
  `SessionEventMap` declaration merge never reaches it, and there is no
  public way to mark an appended event `ignorable: true` either
  (`Session.append()`'s signature has no parameter for it). Fixed by moving
  the kid bundle's audit facts out of dsh's session log entirely, into its
  own sidecar JSONL file (`kidTutorEventsDir`), and by teaching this
  package's `raw-session-read.ts` to recover the OLD inline-logged facts
  from existing sessions via dsh's own sanctioned
  `SessionPersistence.readRaw()` + `decodeStorageRecord()` primitives
  (never a monkey-patch). Verified against the real store: all 19 sessions
  now read cleanly through `KidStore`, recovering their `kid-tutor/*` facts
  (3 non-pass guard verdicts, 2 alerts, 2 denied-tool calls, 46 quota
  events, 7 python runs at last check).

  This closes the read side completely, for both old and new sessions. It
  does **not** make a PRE-fix session resumable by the KID process itself:
  `prepare()` (the live-resume path) runs the exact same
  `assertEventsSupported` check as `readSession()`, and there is no raw
  bypass for a path that must keep writing to the log afterward. A parent
  or kid resuming one of the 18 pre-fix sessions specifically will still hit
  the harness's own refusal and have to start fresh; nothing about that
  history is lost (the admin can still read it, per above) — only live
  continuation of those specific old sessions is unavailable. Every session
  written after this fix resumes normally, on both sides, because its dsh
  log never contains a `kid-tutor/*` line to begin with.
- **`!!js ctx.kidAdminConfig.kidSessionsDir` inside a nested `cordis:group`
  row, referencing an earlier top-level row in the SAME patch file** —
  plausible by analogy to `ctx.webStartup` (docs/dsh-seams.md §8), and it
  passed `dsh --profile kid-admin --dump-config` in this session's smoke test
  (see the report), but this exact "config service published by an earlier
  row in the same patch file, read via `!!js` from a later nested row" shape
  has no precedent I found in the dsh monorepo itself. If a future dsh release
  changes patch-row evaluation order, fall back to reading `kidSessionsDir`
  from `process.env.DSH_KID_SESSIONS_DIR` directly in the
  `kid-session-persistence-jsonl` row instead of via `ctx.kidAdminConfig`.
- `timezone: ""` relies on `Intl.DateTimeFormat` treating an omitted
  `timeZone` option as "use the host's local zone" — correct per ECMA-402,
  but the admin process's OWN local zone, not necessarily the kid's, if they
  ever run on different hosts.
- No test exercises the real `zstd` compression path (tests use
  `compression: 'none'` for speed/simplicity) — the reader code path is
  identical either way (`SqliteSessionQueryEngine`/`JsonlSessionPersistence`
  decode transparently regardless of `compression`, per that package's
  README "Reading is layout-blind"), but it is worth a manual smoke check
  against the real kid profile's zstd-compressed logs once phase 1 is live.
