#!/usr/bin/env bash
# sync-skills.sh — mirror the bundled skills from the canonical agent-skills repo
# into this plugin. agent-skills stays canonical; this repo is a delivery artifact.
# Usage: scripts/sync-skills.sh [--check]
#   (no arg) sync: rsync each skill from agent-skills into plugins/tmux-teams/skills/
#   --check  drift report only; exit 1 when the plugin copy differs from canonical
set -euo pipefail

SRC="${AGENT_SKILLS_REPO:-$HOME/agent-skills}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/plugins/tmux-teams/skills"
MODE="${1:-sync}"

# skill-name:source-scope (codex-tmux-driver is claude-scoped in agent-skills)
PAIRS=(
  "tmux-teams:shared"
  "party-mode:shared"
  "party-auto:shared"
  "party-advise:shared"
  "sqthink:shared"
  "codex-tmux-driver:claude"
)

fail=0
for pair in "${PAIRS[@]}"; do
  name="${pair%%:*}"
  scope="${pair##*:}"
  src="$SRC/skills/$scope/$name"
  [[ -d "$src" ]] || { echo "MISSING source: $src" >&2; exit 1; }
  if [[ "$MODE" == "--check" ]]; then
    diff -rq "$src" "$DEST/$name" || fail=1
  else
    mkdir -p "$DEST/$name"
    rsync -a --delete "$src/" "$DEST/$name/"
  fi
done

if [[ "$MODE" == "--check" ]]; then
  if [[ $fail -eq 0 ]]; then
    echo "IN SYNC"
  else
    echo "DRIFT DETECTED — run scripts/sync-skills.sh, bump plugin version, then claude plugin update" >&2
    exit 1
  fi
else
  echo "synced ${#PAIRS[@]} skills from $SRC"
  echo "next: bump version in BOTH plugins/tmux-teams/.claude-plugin/plugin.json and .claude-plugin/marketplace.json, then claude plugin update tmux-teams"
fi
