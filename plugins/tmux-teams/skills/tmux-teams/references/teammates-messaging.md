# Claude Code Agent Teams messaging — study & how to apply it to tmux teams

Study of Claude Code's experimental Agent Teams (teammates) communication system
(docs: https://code.claude.com/docs/en/agent-teams.md, v2.1.178+), and a concrete
adaptation plan for our tmux-teams orchestration. Studied 2026-07-13.

---

## Part 1 — How teammates messaging actually works

### Architecture

| Component | What it is | Where it lives |
|---|---|---|
| Team lead | The user-facing Claude Code session; spawns teammates, orchestrates | main session |
| Teammates | Separate Claude Code **processes** (not threads), own context each | in-process panel or tmux/iTerm2 panes |
| Shared task list | File-based work queue, file-locked | `~/.claude/tasks/{team-name}/` (persists) |
| Mailboxes | Per-agent JSON message queues | `~/.claude/teams/{team-name}/inboxes/{agent}.json` (ephemeral) |

Team name = `session-` + first 8 chars of the lead's session id. Team config
(`~/.claude/teams/{team}/config.json`, has a `members` array) is deleted when the
lead exits; the task list persists.

### The key design decision: messages are files, not keystrokes

`SendMessage` never types into another agent's terminal. It **appends a JSON
object to the recipient's mailbox file**; the recipient's runtime injects queued
messages as a user turn **at the next turn boundary**. Consequences:

- Delivery is push-with-queueing: a busy agent is never interrupted; messages
  wait and arrive when it finishes the current turn.
- No submission ambiguity — there is no Enter-swallowing problem because there
  is no terminal input involved.
- Broadcast (`recipient: "*"`) is just N appends, one per mailbox.

Mailbox entry shape (inferred from docs; not fully specified publicly):

```json
{
  "type": "message | idle_notification | shutdown_request | shutdown_response",
  "text": "...", "summary": "...", "from": "sender", 
  "timestamp": "ISO-8601", "read": false
}
```

### Message types / protocol

| Type | Direction | Purpose |
|---|---|---|
| `message` | any → any (or `*`) | normal point-to-point / broadcast text |
| `idle_notification` | teammate → lead, **automatic** | fires when a teammate's turn ends; since v2.1.198 carries the error text if the turn died on an API error |
| `shutdown_request` / `shutdown_response` | lead ↔ teammate | graceful stop; teammate may approve or reject with a reason. No hard kill in the protocol |
| `permission_request`, `plan_approval_response` | teammate ↔ lead | permission/plan escalation |

### Task coordination

Four unprompted tools over one locked file: `TaskCreate` (subject, description,
`blockedBy` deps), `TaskList`, `TaskGet`, `TaskUpdate` (status
`pending|in_progress|completed`, `owner`, add/removeBlockedBy). Claiming is
race-safe via file locking; completing a task auto-unblocks its dependents.
Teammates either get assigned (`owner` set by lead) or **self-claim** the next
unblocked task after finishing one. Hooks `TaskCreated` / `TaskCompleted` /
`TeammateIdle` can veto transitions (exit code 2) — i.e. quality gates live
*outside* the agent.

### Reporting results

Completion is not scraped from a screen: teammate sets the task `completed`,
lead gets an `idle_notification`, and large outputs go through **shared files**
with a message pointing at them ("wrote findings to X").

### Known weaknesses (documented / observed)

- Malformed mailbox entry blocked the whole mailbox before v2.1.207.
- Task status can lag (teammate finishes but forgets to mark done) — the lead
  still needs to nudge/verify.
- No cross-machine transport; everything assumes one filesystem.
- `/resume` does not restore in-process teammates.

---

## Part 2 — What to adopt in tmux-teams

Our current model (SKILL.md) drives raw TUIs with `send-keys` + pane-scraping.
Its three chronic failures — swallowed Enter, missed completion markers,
scrollback-truncated answers — are exactly the three things the mailbox design
eliminates. Adopt the *pattern* (files as the transport, panes only as the
delivery/last-mile), keeping tmux as the runtime.

### Proposed on-disk layout (mirrors teams layout)

```
~/.tmux-teams/<team>/
  config.json           # members: name, tmux session, tool, permission mode
  tasks.md              # shared task board (flock-guarded edits)
  inboxes/<agent>/      # queued briefs: one file per message, NNN-slug.md
  outbox/<agent>/       # results agents write themselves: <task-id>.md
```

### 1. Mailbox dispatch instead of direct send-keys

PM never `send-keys`s a brief directly. PM **writes a message file** to
`inboxes/<agent>/`; one delivery loop per agent owns the last mile:

```bash
# deliver.sh <team> <agent> <tmux-session> — run via run_in_background/Monitor
inbox=~/.tmux-teams/$1/inboxes/$2
while :; do
  msg=$(ls "$inbox" 2>/dev/null | head -1) || true
  if [ -n "$msg" ] && agent_is_idle "$3"; then     # pane-pattern check, see interactive-agent-driver
    tmux send-keys -t "$3" -l "$(cat "$inbox/$msg")"
    tmux send-keys -t "$3" Enter
    sleep 2
    verify_submitted "$3" || tmux send-keys -t "$3" Enter   # retry-Enter lives HERE, once
    mv "$inbox/$msg" "$inbox/.delivered-$msg"
  fi
  sleep 5
done
```

What this buys, copied from teammates semantics:

- **Queueing at turn boundary** — messages sent while an agent works wait until
  it is idle, never interleaving with a running task.
- **The Enter-verify-retry dance is implemented once**, in the loop, not
  re-improvised by the PM on every dispatch (§2 of SKILL.md stays true, it just
  has a single owner).
- PM "sends" by writing a file — trivially auditable, replayable, and broadcast
  is a for-loop over inboxes.

### 2. Outbox files instead of pane-scraped answers

Teammates report via task status + shared files, never via "what's on screen".
Copy that through the **output contract in every brief**:

```
เขียนคำตอบเต็มลงไฟล์ ~/.tmux-teams/<team>/outbox/<agent>/<task-id>.md
แล้วพิมพ์บรรทัดสุดท้ายว่า: TEAM_DONE <task-id>
```

- Completion detection = watch for the outbox file (or `TEAM_DONE <id>` in the
  pane as a secondary signal), not marker-disappears heuristics. This is our
  `idle_notification` equivalent — explicit, not inferred.
- Kills the scrollback problem (§4 of SKILL.md): the full answer is in a file;
  `capture-pane -S -300` becomes a debugging aid, not the data path.
- Keep the stability-poll (3 clean polls of no work-marker) as the **fallback**
  for agents that ignore the contract, paired with a timeout as before.

### 3. Shared task board with owners and deps

Adopt the task-list shape (id, subject, status `pending|in_progress|completed`,
owner, blockedBy) in `tasks.md`; PM edits it under `flock` if watchers also
write. Two teammates rules worth keeping verbatim:

- a task is claimed by exactly one owner before work starts;
- completing a task is what unblocks dependents — PM dispatches a blocked brief
  only after its blockers' outbox files exist **and were verified**.

The `TaskCompleted`-hook idea maps to our existing gate: PM verifies evidence
(`verification-before-completion`) before flipping a row to completed — the
agent saying done is `in_progress → review`, not `completed`.

### 4. Graceful shutdown protocol

Replace immediate `kill-session` with the two-phase teammates shutdown:

1. Send (via inbox) "finish the current step, write status of anything
   incomplete to your outbox, then exit the CLI".
2. Wait for exit/idle, then `tmux kill-session`. Hard-kill only on timeout.

This preserves partial results — the thing raw `kill-session` destroys.

### What does NOT transfer

- **Turn-boundary injection by a runtime** — TUIs won't read files on their
  own; the delivery loop *is* our runtime, and it still rides on send-keys.
  All §2 submission-verification lessons remain load-bearing.
- **Automatic idle notifications** — ours are only as reliable as the output
  contract + fallback polling. Assume agents will sometimes forget the
  sentinel.
- **Permission escalation / plan approval messages** — no equivalent; handle
  by scoping briefs (read-only constraints) as today.
- **Agent-to-agent messaging** — possible (agent A's brief says "write to
  B's inbox") but adds failure surface; default stays hub-and-spoke through
  the PM.

## Part 3 — PoC results (2026-07-14, codex-cli 0.144.1, tmux 3.6a, macOS)

Round-trip proven end-to-end: inbox file → `scripts/deliver.sh` → Codex TUI (pane-id
targeted) → outbox file, with T2 enqueued mid-T1-turn and submitted only after T1
finished (queueing at turn boundary, timestamped in deliver.log). **Legacy,
noncompliant review note:** the historical two-reviewer completion check
(`oc PASS + codex PASS`; AGY down) predates the active ACP-only exact-three
contract and must not be used as release evidence.

Pattern-level field facts — trust these over assumptions:

- **Enter-swallow fired on 3/3 dispatches** (100%), not occasionally. The
  conditional retry (resend Enter ONLY if brief text still visible in composer)
  fired 2/2 in-loop with zero double-submits. Unconditional retry would have been
  a bug factory; ownerless retry (PM re-improvising per dispatch) would have missed it.
- **The completion signal must be an artifact, not a screen state**: the outbox
  file (run-scoped filename + mtime > run-start + content check) was the only
  signal that never lied. Turn-event hooks are diagnostics — the PoC's notify
  chain silently produced zero events for a whole session.
- **Control/sandbox split is load-bearing**: only `outbox/` lives inside the agent
  cwd (its writable sandbox); deliver.sh, PID file, stop flag, run-id, and
  inboxes/inflight/delivered live in a sibling control dir the agent cannot write.
- oh-my-codex stayed fully dormant in a fresh cwd (no `.omx/state` created).
- **Stop the loop before any remediation** (run 2, 2026-07-14): after
  Esc-interrupting a turn the pane reads as idle, and a live delivery loop will
  immediately dispatch the next queued brief — rewriting an inbox file in that
  window got both versions submitted back-to-back. Halt deliver.sh (stop flag →
  wait for PID exit) before touching the inbox or the pane. Also bound open-ended
  briefs and prepend "work alone — no subagents" for OMX-equipped tools; see
  `tmux-teams` §5-6 and `codex-tmux-driver` §2.

Codex-specific calibration from this run (verbatim markers incl. lowercase
`esc to interrupt`, boot-dialog single-keypress behavior, notify-chain no-op
details, `/status` flag-override verification) is owned by `codex-tmux-driver`
§§1-4 — the driver owns tool facts; this doc owns the pattern.

Residual risks for production (from the completion review): embed the sentinel as
the outbox file's last line (today it's pane-only); artifact-presence is not a
native turn-end signal; add max-retry escalation for the submit dance; sample
size is one run.

Delivery loop artifact: `../scripts/deliver.sh` (env-tunable: `TMUX_TEAMS_CTL`,
`TMUX_TEAMS_SESSION`, `TMUX_TEAMS_DENY`).

### Native alternative worth knowing

If every team member is Claude Code (no codex/opencode in the mix), consider
running the real thing instead of emulating it:
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `--teammate-mode tmux` gives actual
mailboxes, task locking, idle notifications, and per-teammate panes. Our
tmux-teams pattern remains the answer for **mixed-tool** teams (codex,
claude-zai, opencode), which native teams cannot drive. The lead-pane footer
`N teammates · ctrl+t` noted in interactive-agent-driver is this feature.
