# Build contract (phase 1)

Shared agreements between the kid bundle and the admin bundle. Change here first.

## Repo layout (pnpm workspace)

```
packages/dsh-kid-tutor/        kid bundle: host-plane plugins + preset-plane plugins (TS, dist/)
packages/dsh-kid-tutor-admin/  admin bundle: analyst tools over the kid's session store
presets/kid/agent.cordis.yml   kid agent preset (persona, tool roster, guard/quota/fence rows)
presets/kid-admin/agent.cordis.yml
profiles/kid/                  profile template (package.json w/ link deps, cordis.patch.yml)
profiles/kid-admin/
scripts/install.sh             creates the two DSH homes, links presets/profiles, pnpm install
docs/                          dsh-seams.md (recon), this file
```

## Two DSH homes, hard separation

- Kid process: `DSH_HOME=$HOME/.dsh-kid`  → `dsh --profile kid --port 3081 --no-open`
- Admin process: `DSH_HOME=$HOME/.dsh-kid-admin` → `dsh --profile kid-admin --port 3082 --no-open`
- Admin reads the kid store READ-ONLY at `$HOME/.dsh-kid/sessions` (config row
  `kidSessionsDir`, overridable). Kid profile has no tool that reads any store.
- `install.sh` symlinks `~/.dsh/.credentials.yaml` into both homes (same DeepSeek
  key; never prints it) and writes a minimal `settings.yaml` per home.
- Kid model row: provider `deepseek-official`, model `deepseek-flash` (was
  `deepseek-v4-flash`, retired as an alias now served by V4.1-Flash — see
  `profiles/kid/cordis.patch.yml`'s comment on the `agent-default-model` row).
  Admin default: `deepseek-v4-pro` (patchable).

## Log-only session event types (declaration-merged; log-only, never surface)

| type | data |
|---|---|
| `kid-tutor/guard-verdict` | `{ stage: 'deterministic'\|'judge', verdict: 'pass'\|'block'\|'redo', reason?: string, rule?: string, judgeInput?: string, judgeOutput?: string, suppressedText?: string, category?: GuardCategory, severity?: number, turn: number, step: number }` |
| `kid-tutor/tool-denied` | `{ tool: string, reason: string, url?: string, path?: string, turn: number, step: number }` |
| `kid-tutor/quota` | `{ kind: 'turn'\|'cutoff', used: number, limit: number, turn: number }` |
| `kid-tutor/python-run` | `{ file?: string, exitCode: number, durationMs: number, truncated: boolean, turn: number, step: number }` |
| `kid-tutor/alert` | `{ category: GuardCategory, severity: number, excerpt: string, delivered: boolean, error?: string, turn: number, step: number }` |

`suppressedText` holds the full model message a guard replaced (audit requirement:
the parent must be able to see what the model said before the redo).

`category`/`severity` are set only on `stage: 'judge'` events (`undefined` on
`stage: 'deterministic'`), added when the judge started classifying the
exchange for parent-alerting, not just the reply for safety/pedagogy.
`GuardCategory` is one of `none | sexual | violence | self_harm | drugs |
personal_info | stranger_contact | hate | other_adult`; `severity` is `0`
(nothing notable), `1` (log only), `2` (alert-worthy — triggers
`kid-tutor/alert` if `parent-alert`'s webhook is configured and `severity`
clears the configured `alertSeverity` threshold, default `2`).

`kid-tutor/alert` is appended once per alert attempt (success or failure) by
`parent-alert.ts`'s `ParentAlertService`, asynchronously after the webhook
POST settles — it never blocks the kid's own turn. `excerpt` is the kid's
triggering message, truncated to 200 chars.

## Kid tool roster (preset), nothing else registered

`web_search` (deepseek-official provider), `web_fetch` (allowlist ONLY — the fetch
provider is an SSRF primitive; pre-execute must reject non-allowlisted hosts AND
any literal IP / RFC1918 / loopback / .local / .lan / .home hostnames before
dispatch), workspace file tools (read/write/list confined to `workspaceRoot`),
`run_python` (custom tool: `python3` subprocess, cwd = workspaceRoot, 10 s
timeout, 64 KiB output cap, code passed via stdin or a file path inside
workspaceRoot; NOT a shell). No bash, no subagents, no plan mode, no skills.

## Config defaults (all patchable rows)

- `workspaceRoot`: `$HOME/.dsh-kid/workspace`
- `allowlist`: `en.wikipedia.org, simple.wikipedia.org, bulbapedia.bulbagarden.net,
  docs.python.org, kids.britannica.com`
- `quota`: 60 turns/day, no chats between 21:00 and 07:00 local
- `judge`: same route as chat, model `deepseek-flash`, no history, fail closed
- `pacing`: `charsPerSecond` 40 (typewriter release of the guarded reply; `0` disables)
- `brevity`: `maxOutputTokens` 350 (hard cap via `agent/request`, never raises an
  already-tighter proposed value)
- `alert`: `alertSeverity` 2, `alertWebhookUrl` `""` (disabled unless set),
  `alertHeaders` `{}`, `alertDisclosure` `true`
- `kidName`: **not** set in the profile patch (verified false — a profile patch
  is host-plane only and cannot reach a row inside an agent preset, see
  `persona-name.ts`'s "Known deviation" note). Read from `$KID_NAME` at process
  launch instead, falling back to config, then `"friend"`.
- `alertWebhookUrl`/`alertHeaders`: same constraint as `kidName` — read from
  `$KID_ALERT_WEBHOOK_URL`/`$KID_ALERT_WEBHOOK_HEADERS` (a JSON object string)
  at launch, never from any patch file (`parent-alert.ts`'s "Known deviation"
  note). Unset/empty means alerting is off.
