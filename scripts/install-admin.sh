#!/usr/bin/env bash
# Idempotent installer for the kid-admin DSH_HOME. Never prints secret
# VALUES: settings.yaml is inspected key-shape-only before it is copied, and
# .credentials.yaml is only ever symlinked, never read.
#
# Usage: scripts/install-admin.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_PKG_DIR="$REPO_ROOT/packages/dsh-kid-tutor-admin"
PROFILE_DIR="$REPO_ROOT/profiles/kid-admin"
PRESET_DIR="$REPO_ROOT/presets/kid-admin"

SOURCE_DSH_HOME="${DSH_HOME_SOURCE:-$HOME/.dsh}"
TARGET_DSH_HOME="${DSH_KID_ADMIN_HOME:-$HOME/.dsh-kid-admin}"

log() { printf '[install-admin] %s\n' "$1"; }

# --- 1. Build the admin package -------------------------------------------
log "installing workspace deps (repo root, idempotent)"
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  (cd "$REPO_ROOT" && pnpm install)
else
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile=false >/dev/null 2>&1 || pnpm install)
fi

log "building dsh-kid-tutor-admin"
(cd "$ADMIN_PKG_DIR" && pnpm run build)

# --- 2. Create $DSH_KID_ADMIN_HOME layout ----------------------------------
log "creating $TARGET_DSH_HOME"
mkdir -p "$TARGET_DSH_HOME/profiles" "$TARGET_DSH_HOME/.agent-presets"

link() {
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    return 0
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    log "removing stale $dest"
    rm -rf "$dest"
  fi
  ln -s "$src" "$dest"
  log "linked $dest -> $src"
}

link "$PROFILE_DIR" "$TARGET_DSH_HOME/profiles/kid-admin"

# NOT `link "$PRESET_DIR" ".../.agent-presets/kid-admin"` (a directory
# symlink): dsh's preset scanner (`scanRoot`,
# packages/preset/agent-presets/src/discovery.ts) filters roster entries with
# `child.isDirectory()` on a `Dirent` from `readdir(root, {withFileTypes:
# true})`. On macOS/Linux that Dirent type comes from the raw directory
# entry, which for a SYMLINKED directory reports as a symlink, not a
# directory — `isDirectory()` returns false and the preset is silently
# skipped (confirmed empirically: `node -e` against a real symlinked preset
# dir prints `isDirectory=false`, and the preset never showed up in
# Settings > Agent presets until this was fixed). Making the destination a
# REAL directory containing symlinked FILES sidesteps this: `isFile()` on a
# symlinked file uses `stat`, which follows symlinks correctly.
mkdir -p "$TARGET_DSH_HOME/.agent-presets/kid-admin"
link "$PRESET_DIR/preset.yml" "$TARGET_DSH_HOME/.agent-presets/kid-admin/preset.yml"

# `agent.cordis.yml` is NOT symlinked: it references its own custom plugin
# (`admin-tools`) via the __DSH_KID_TUTOR_ADMIN_DIST__ placeholder, which only
# a RELATIVE path could otherwise express — but this file no longer sits at
# its repo-relative depth once it lives under a REAL `.agent-presets/kid-admin`
# directory (required by the symlink-directory fix above), so a relative path
# would resolve against the wrong base. Substitute an ABSOLUTE, install-time
# path instead and write the result (dsh-kid-tutor's own
# presets/kid/agent.cordis.yml documents the identical fix and reasoning).
#
# `rm -f` the DESTINATION first: an earlier version of this script (or a
# manual fix while developing it) may have left a symlink there pointing
# straight at `$PRESET_DIR/agent.cordis.yml`. Bash `>` follows a symlink
# rather than replacing it, so writing through a stale symlink here would
# truncate and overwrite the REPO SOURCE FILE ITSELF with the substituted
# output — confirmed the hard way during development (it blanked the
# tracked source file; recovered by hand from conversation history).
# Removing the destination path (never the source) before redirecting makes
# this step safe no matter what state a prior run left behind.
rm -f "$TARGET_DSH_HOME/.agent-presets/kid-admin/agent.cordis.yml"
sed "s|__DSH_KID_TUTOR_ADMIN_DIST__|$ADMIN_PKG_DIR/dist|g" \
  "$PRESET_DIR/agent.cordis.yml" > "$TARGET_DSH_HOME/.agent-presets/kid-admin/agent.cordis.yml"
log "generated $TARGET_DSH_HOME/.agent-presets/kid-admin/agent.cordis.yml (re-run this script after editing the source file)"

if [ -f "$SOURCE_DSH_HOME/.credentials.yaml" ]; then
  link "$SOURCE_DSH_HOME/.credentials.yaml" "$TARGET_DSH_HOME/.credentials.yaml"
else
  log "WARNING: $SOURCE_DSH_HOME/.credentials.yaml not found; the admin process will have no DeepSeek key until it is linked"
fi

# --- 3. settings.yaml: keys-only inspection, then copy (never print values) --
if [ -f "$SOURCE_DSH_HOME/settings.yaml" ]; then
  log "inspecting $SOURCE_DSH_HOME/settings.yaml (KEY NAMES ONLY — values are never printed or copied to this log)"
  python3 - "$SOURCE_DSH_HOME/settings.yaml" <<'PYEOF'
import sys
import yaml

path = sys.argv[1]
with open(path) as f:
    data = yaml.safe_load(f) or {}

def walk(node, prefix=""):
    if isinstance(node, dict):
        for key, value in node.items():
            walk(value, f"{prefix}{key}.")
    elif isinstance(node, list):
        print(f"  {prefix.rstrip('.')} [list, {len(node)} items]")
    else:
        # Leaf: print only the KEY PATH, never the value.
        print(f"  {prefix.rstrip('.')}")

print("settings.yaml key shape:")
walk(data)
PYEOF
  log "copying settings.yaml, then forcing agent-default-model back to the admin route (its own values are provider config/env-var NAMES, not secrets — the DeepSeek key itself lives only in .credentials.yaml, which is symlinked, never copied)"
  cp "$SOURCE_DSH_HOME/settings.yaml" "$TARGET_DSH_HOME/settings.yaml"
  # settings.yaml's agent-default-model OVERRIDES the profile cordis.patch.yml
  # row of the same id at runtime (it's the live store the web UI's model
  # picker writes to, confirmed by dsh-kid-tutor's own install.sh comment) —
  # so copying the parent's PERSONAL settings.yaml verbatim would silently let
  # whatever model/effort they last picked for themselves override
  # CONTRACT.md's stated admin default (deepseek-v4-pro) instead of just
  # patching it. Force it explicitly rather than relying on today's values
  # happening to already match.
  python3 - "$TARGET_DSH_HOME/settings.yaml" <<'PYEOF'
import sys
import yaml

path = sys.argv[1]
with open(path) as f:
    data = yaml.safe_load(f) or {}
data["agent-default-model"] = {"provider": "deepseek-official", "model": "deepseek-v4-pro"}
with open(path, "w") as f:
    yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
PYEOF
else
  log "no $SOURCE_DSH_HOME/settings.yaml found; writing a minimal one"
  cat > "$TARGET_DSH_HOME/settings.yaml" <<'YAMLEOF'
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-pro
YAMLEOF
fi

# --- 4. pnpm install in the profile directory (resolves the link: dep) -----
log "pnpm install in $PROFILE_DIR"
(cd "$PROFILE_DIR" && pnpm install)

log "done"
echo
echo "Run the admin console with:"
echo "  DSH_HOME=$TARGET_DSH_HOME dsh --profile kid-admin --port 3082 --no-open"
