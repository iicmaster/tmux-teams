#!/bin/bash
# deliver.sh — PoC mailbox delivery loop: inbox file -> Codex TUI pane (teammates-messaging.md pattern)
# usage: deliver.sh <tmux-pane-id e.g. %42>
# ponytail: single agent (codex), single loop; per-agent loops when a second team member exists
set -u

CTL="${TMUX_TEAMS_CTL:-$HOME/.tmux-teams/poc-mailbox-control}"
PANE="${1:?usage: deliver.sh <pane-id>}"
SESSION_EXPECTED="${TMUX_TEAMS_SESSION:-poc-mailbox}"
DENY="${TMUX_TEAMS_DENY:-pm-codex pm-design pm-party hf-hell-factory}"
INBOX="$CTL/inboxes/codex"; INFLIGHT="$CTL/inflight"; DELIVERED="$CTL/delivered"
LOG="$CTL/logs/deliver.log"; PIDF="$CTL/deliver.pid"; STOP="$CTL/stop"
MAX_RUNTIME=1800

# markers — overwritten by P0 calibration via markers.sh
WORK_MARKER="Esc to interrupt"
IDLE_GLYPH="›"
[ -f "$CTL/markers.sh" ] && . "$CTL/markers.sh"

# control dirs must exist before we log (log writes under $CTL/logs)
mkdir -p "$INBOX" "$INFLIGHT" "$DELIVERED" "$CTL/logs" || { echo "deliver.sh: cannot create control dirs under $CTL" >&2; exit 1; }

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "$LOG"; }

# --- single-instance guard: atomic create via noclobber (O_EXCL) ---
if ( set -o noclobber; echo $$ > "$PIDF" ) 2>/dev/null; then
  :   # won the pidfile
elif kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
  log "FATAL second instance refused (pid $(cat "$PIDF") alive)"; exit 1
else
  # stale pidfile from a crashed run — reclaim
  # ponytail: a simultaneous double-stale-start could still race here; single-operator tool, not worth a lockdir
  log "reclaiming stale pidfile (pid $(cat "$PIDF" 2>/dev/null) dead)"
  rm -f "$PIDF"
  ( set -o noclobber; echo $$ > "$PIDF" ) 2>/dev/null || { log "FATAL pidfile race"; exit 1; }
fi
trap 'rm -f "$PIDF"; log "EXIT pid $$"' EXIT

# --- inflight must be empty at start: never auto-requeue ---
if [ -n "$(ls -A "$INFLIGHT" 2>/dev/null)" ]; then
  log "FATAL inflight/ not empty at startup — halting for manual review"; exit 1
fi

pane_ok() {
  local sess
  sess=$(tmux display-message -p -t "$PANE" '#{session_name}' 2>/dev/null) || { log "FATAL pane $PANE gone"; return 1; }
  [ "$sess" = "$SESSION_EXPECTED" ] || { log "FATAL pane $PANE now in '$sess'"; return 1; }
  for d in $DENY; do [ "$sess" = "$d" ] && { log "FATAL denylist $d"; return 1; }; done
  return 0
}

cap() { tmux capture-pane -p -t "$PANE" -S -25 2>/dev/null; }

# idle = composer glyph present AND no work marker AND no approval dialog; EXITED (no glyph) = not idle
is_idle() {
  local c; c=$(cap) || return 1
  printf '%s' "$c" | grep -qF "$WORK_MARKER" && return 1
  printf '%s' "$c" | grep -qE 'Always allow|Allow once' && { log "WARN approval dialog visible"; return 1; }
  printf '%s' "$c" | grep -qF "$IDLE_GLYPH" || return 1
  return 0
}

log "START pid $$ pane $PANE runid $(cat "$CTL/run-id" 2>/dev/null)"
start=$(date +%s); tick=0
while :; do
  [ -f "$STOP" ] && { log "STOP flag — exiting"; break; }
  [ $(( $(date +%s) - start )) -gt $MAX_RUNTIME ] && { log "MAX_RUNTIME — exiting"; break; }
  pane_ok || break
  tick=$((tick+1)); [ $((tick % 12)) -eq 0 ] && log "heartbeat tick $tick"

  # lexically-first regular file (glob sorts by LC_COLLATE); NUL/space/newline-safe, no ls parsing
  msg=""
  for f in "$INBOX"/*; do [ -f "$f" ] && { msg=${f##*/}; break; }; done
  if [ -n "$msg" ] && is_idle && is_idle; then   # double-check narrows TOCTOU window
    mv "$INBOX/$msg" "$INFLIGHT/$msg"
    brief=$(tr '\n' ' ' < "$INFLIGHT/$msg")
    [ -z "${brief// }" ] && { log "SKIP empty brief $msg"; mv "$INFLIGHT/$msg" "$DELIVERED/$msg.empty"; continue; }
    head30=${brief:0:30}
    log "SUBMIT $msg"
    # a send failure must requeue, never fall through to DELIVERED (would drop the brief).
    # clear the composer first (partial/typed text may linger) so the next attempt starts
    # clean instead of concatenating onto leftovers; sleep before continue to avoid a hot loop.
    requeue() { tmux send-keys -t "$PANE" C-u 2>/dev/null; mv "$INFLIGHT/$msg" "$INBOX/$msg"; sleep 5; }
    if ! tmux send-keys -t "$PANE" -l "$brief"; then
      log "SEND-FAIL $msg — requeue"; requeue; continue
    fi
    if ! tmux send-keys -t "$PANE" Enter; then
      log "ENTER-FAIL $msg — requeue"; requeue; continue
    fi
    # confirm submission: Working marker must appear (300ms x 20 = 6s)
    sub=none
    for _ in $(seq 1 20); do
      c=$(cap)
      printf '%s' "$c" | grep -qF "$WORK_MARKER" && { sub=working; break; }
      sleep 0.3
    done
    if [ "$sub" = none ]; then
      # No marker in 6s. Enter on an empty composer is a no-op, so ALWAYS retry it:
      # covers the classic swallowed-Enter (brief text still visible) AND codex
      # collapsing a long paste into a "[Pasted Content N chars]" placeholder, where
      # the brief text is invisible and a text-match heuristic calls it submitted
      # while nothing runs (field-bitten 2026-07-17: worker idled 600s on an
      # unsubmitted placeholder).
      c=$(cap)
      if printf '%s' "$c" | grep -qF "$head30" || printf '%s' "$c" | grep -qF 'Pasted Content'; then
        log "RETRY-ENTER $msg (brief or paste placeholder still in composer)"
      else
        log "RETRY-ENTER $msg (blind — no marker seen; harmless if already submitted)"
      fi
      tmux send-keys -t "$PANE" Enter
      for _ in $(seq 1 20); do
        c=$(cap)
        printf '%s' "$c" | grep -qF "$WORK_MARKER" && { sub=working; break; }
        sleep 0.3
      done
      [ "$sub" = none ] && sub=fast   # still nothing after retry — turn may have finished within poll gap
    fi
    log "CONFIRMED $msg state=$sub"
    # DELIVERED = brief was sent into the pane (send-keys succeeded), NOT that the turn finished.
    # Task completion is decided separately by the outbox-file contract (teammates-messaging.md).
    mv "$INFLIGHT/$msg" "$DELIVERED/$msg"
    log "DELIVERED $msg"
  fi
  sleep 5
done
