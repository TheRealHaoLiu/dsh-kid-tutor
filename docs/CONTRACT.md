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
- Kid model row: provider `deepseek-official`, model `deepseek-v4-flash`.
  Admin default: `deepseek-v4-pro` (patchable).

## Log-only session event types (declaration-merged; log-only, never surface)

| type | data |
|---|---|
| `kid-tutor/guard-verdict` | `{ stage: 'deterministic'\|'judge', verdict: 'pass'\|'block'\|'redo', reason?: string, rule?: string, judgeInput?: string, judgeOutput?: string, suppressedText?: string, turn: number, step: number }` |
| `kid-tutor/tool-denied` | `{ tool: string, reason: string, url?: string, path?: string, turn: number, step: number }` |
| `kid-tutor/quota` | `{ kind: 'turn'\|'cutoff', used: number, limit: number, turn: number }` |
| `kid-tutor/python-run` | `{ file?: string, exitCode: number, durationMs: number, truncated: boolean, turn: number, step: number }` |

`suppressedText` holds the full model message a guard replaced (audit requirement:
the parent must be able to see what the model said before the redo).

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
- `judge`: same route as chat, model `deepseek-v4-flash`, no history, fail closed
- `kidName`: set in the profile patch, never in the repo (public repo)
