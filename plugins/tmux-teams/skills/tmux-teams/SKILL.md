---
name: tmux-teams
description: 'Use when acting as PM dispatching work to interactive CLI agents (codex, claude, claude-zai, opencode) inside tmux sessions — reliable prompt submission, completion detection, and output capture. Triggers: "สั่งงานผ่าน tmux", "ทีม codex/claude-zai", PM-via-tmux orchestration.'
---

# tmux-teams — orchestrating interactive CLI agents via tmux

Drive interactive TUI agents (codex / claude / claude-zai) as "teams": you plan
and dispatch, teams execute. Every lesson below was paid for by a real failure.

This skill owns the **generic protocol** (dispatch, completion, capture, PM
discipline, mailbox pattern). Tool-specific facts live in per-tool driver skills
and are the source of truth for that tool: **codex → `codex-tmux-driver`**
(flags, calibrated markers, dialog behavior, notify caveats, slash commands).

## 0. Delivery loop — declaration, custody, pull, tick

The mailbox pattern dispatches one leg. The delivery loop keeps a token moving
through declared teams while retaining evidence for every decision. Its law is
[the loop system contract](references/loop-system-contract.md); when prose and
code disagree, stop and name which one is wrong before changing either.

Read the system in this order:

| Component | Owns |
|---|---|
| `scripts/graph.mjs` + `scripts/workflow-graph.mjs` | `.tmux-teams/graph.json`: teams are reusable pools; workflows own routes |
| `scripts/ledger-writer.mjs` + `scripts/ledger-validate.mjs` | one append-only custody ledger per token and the predicate that judges it |
| `scripts/pull-controller.mjs` | receiver-owned pulls, route completion and WIP enforcement |
| `scripts/loop-runner.mjs` | the ordered tick: harvest → pull → dispatch → escalate |
| `scripts/acp-companion.mjs` | the ACP leg; its custody-ledger authority is limited to its own `assigned` and `delivered` events |
| `scripts/pulse.mjs` + `scripts/graph.mjs` + `scripts/kanban.mjs` | live transport, wiring and custody projections from the same evidence |
| `scripts/kms.mjs` | immutable run memory; never a substitute for verification |

Initialize a declaration, replace the bundled names and model requests, then
validate it. The initializer writes into an existing state directory:

```bash
mkdir -p -- <repo>/.tmux-teams
node <skill-root>/scripts/graph.mjs init <repo>
node <skill-root>/scripts/graph.mjs check <repo>
```

A missing declaration uses the bundled four-team template. A present but
invalid declaration fails closed. WIP is always the worker count; it is not a
second number in the declaration. `inherit-account-default` requests no model
and must never be displayed as a verified model.

Admit work through the general ledger writer. `opened` is legal only as the
first event and names the first receiving dispatcher and team. The example
below uses the bundled declaration unchanged; after editing the graph,
substitute its workflow, dispatcher and team names:

```bash
node <skill-root>/scripts/ledger-writer.mjs \
  --repo <repo> --actor human:operator --stdin <<'JSON'
{"event":"opened","work_item":"token-001","workflow":"default","agent_id":"requirement_dispatcher","to_team":"requirement","reason":"work admitted by operator"}
JSON
node <skill-root>/scripts/ledger-validate.mjs --repo <repo>
```

### When the graph routes work through a controller team

A graph whose `outer_controller_id` is the single worker of a team makes that
team the front door: every route starts there, and admission goes through it
rather than at a delivery team. Use `admit.mjs` instead of writing `opened` by
hand — it is the only writer that enforces the front door's WIP limit, which
`ledger-writer` cannot see because it judges one event against one ledger and
never reads the graph.

```bash
node <skill-root>/scripts/admit.mjs \
  --repo <repo> --work-item token-001 --workflow default \
  --actor human:operator --reason 'what the person asked for'
```

Refused while the controller is holding its one token:

```text
REFUSED  controller_full: control is holding 1 of 1 — a new request is not
admitted while the front door is full. The person may send it again once the
queue moves.
```

That is a queue, not a rejection, and it is deliberate: one request waiting on a
person stops every new request entering. See
[controller-as-team.md](references/controller-as-team.md) for why.

What the door has learned, read by the controller on every withdrawal:

```bash
node -e "import('<skill-root>/scripts/intake-stats.mjs').then(m => console.log(m.intakeStats('<repo>')))"
```

Do not write custody with shell redirection. `ledger-writer.mjs` is the only
general writer. The one narrow exception is `acp-companion.mjs`, which goes
through the same validator and may append only the transport facts it observes
for its own leg.

Inspect pull decisions without recording them, then simulate or run the whole
tick:

```bash
node <skill-root>/scripts/pull-controller.mjs <repo>
node <skill-root>/scripts/loop-runner.mjs <repo> --dry-run
node <skill-root>/scripts/loop-runner.mjs <repo> --watch=20
```

The direct pull command is an operator dry run. Let the runner apply pulls so
the fixed tick order remains intact. A dry runner does not stamp
`runner-heartbeat.json`; a live tick does, including a tick that deliberately
holds. The outer controller is event-triggered, audits a completed route before
handling exceptions, and receives one question per dispatch. It is never
dispatched by a heartbeat timer.

Publish the three views after the runner is available:

```bash
node <skill-root>/scripts/pulse.mjs once <repo>
node <skill-root>/scripts/pulse.mjs ensure <repo> --interval 20
node <skill-root>/scripts/kanban.mjs check <repo>
```

The graph answers who exists and how they are wired. The kanban answers where a
token is held. Pulse answers what transport activity is happening now. KMS,
described in §9, records what a run taught the PM after that run is judged.

Until 2026-08-09 that framing hid a dependency: the runner's entire occupancy
answer — `busy` and `busyTasks` — was built from `pulse.json` alone, so a
missing snapshot read every in-flight leg as dead. A watcher-driven loop
logged `no pulse.json yet — dispatching without liveness evidence` 33 times
that day and dispatched the same seat two and three times. ADR 0004 closed
it: the runner now records an in-memory claim for each dispatch inside the
same tick that decides to spawn it, and unions those claims into
`busy`/`busyTasks` at the one place both are built — the runner remembers
what it just dispatched. Pulse is again exactly what this section says it
is: a view, no longer load-bearing for the occupancy decision.

An earlier four-phase delivery pilot and its governed Phase Gate lived here;
both were withdrawn on 2026-08-02 together with their commands and their
documentation. This loop is teams and workflows.

## 1. Session setup

**One session per run, one window per worker: session `auto--{folder}[--{runid}]`,
window `{role}[--{n}]`** (decided 2026-07-17; supersedes session-per-worker —
workers are separate processes on the same tmux server either way, so separate
sessions bought zero isolation and cost cleanup + monitoring ergonomics). Two
things the `--` double-dash separator buys: the `auto-` prefix makes ownership
decidable from the name alone — a human's `pm-codex` can never collide with
automation, even in a folder literally named `pm` (that collision is a data-loss
class bug: cleanup would kill a live manual session) — and because `{folder}` is
itself kebab-case (single dashes allowed), a `--` field separator keeps the
boundary unambiguous. Human/manual sessions are exempt from this standard and
MUST never be killed by automation.

- `{folder}` — basename of the working dir, **sanitized to `[a-z0-9-]` with
  repeated dashes collapsed**: lowercase, replace `.` `:` `_` and whitespace
  with `-`, then squeeze runs of `-` to one (tmux rejects `.`/`:` in session
  names — an unsanitized `next.js` fails `new-session`; collapsing repeats keeps
  a stray `--` from ever appearing inside a field and colliding with the
  separator), cap ~24 chars.
- `{role}` — the **window name**; tool or purpose: `codex` | `zai` | `opencode` |
  `review`. Window 0 (created with the session) stays an idle shell — the PM's
  observation seat.
- `--{n}` — mandatory when >1 worker of the same role runs in the same run,
  **pre-assigned from the dispatch plan** — never detected reactively
  (check-then-create races under concurrent dispatch). `--{runid}` on the session
  when the orchestrator has one (mailbox runs do) keeps concurrent runs on the
  same folder apart.
- **Windows, never split panes.** Each TUI needs the full 220×50 — a squeezed pane
  reflows/wraps the work marker and silently breaks §2 submit-verify and §3
  completion detection. Windows keep full size; humans switch with `C-b w`.
- **Pane id is the only stable handle.** tmux auto-renames windows after the
  foreground process unless `automatic-rename off` is set; window names are for
  human eyes — scripts always target the `$PANE` captured at creation.
- Kill scope: `tmux kill-session -t "=auto--{folder}[--{runid}]"` — one exact-match
  call removes the whole team (that is the point). `tmux kill-window -t "$PANE"`
  retires one worker while the others keep running. An orchestrator that might
  SHARE the session with a concurrent run (no unique runid) must clean up by
  kill-window on its own panes, then kill-session only when just window 0 remains
  (mailbox-run does this). A crashed run orphans its windows in the shared
  session — reclaim with kill-session only after confirming no other run is live.

```bash
FOLDER=$(basename "$PWD" | tr 'A-Z.:_ ' 'a-z----' | tr -s -)    # sanitize to kebab, collapse repeats
S="auto--${FOLDER}"                                             # one session per run; append --{runid} if you have one
tmux new-session -d -s "$S" -c <repo> -x 220 -y 50 2>/dev/null  # window 0 = PM shell; "duplicate session" = already up, fine
PANE=$(tmux new-window -t "=$S" -n codex -c <repo> -P -F '#{pane_id}')   # one window per worker
tmux set-option -t "$PANE" -w automatic-rename off              # keep the role name; tmux renames after the process otherwise
tmux send-keys -t "$PANE" 'codex' Enter                         # target by pane id from here on
```

- Wait ~8s, then `tmux capture-pane -t "$PANE" -p` to confirm boot; handle trust
  dialogs before dispatching. The dup-tolerant `new-session` + atomic `new-window`
  pair is concurrency-safe — no kill-then-create, which under a shared session
  would destroy the other workers' windows.
- Note each team's permission mode from the boot banner (codex "YOLO", claude
  "bypass permissions"). If dangerous, scope briefs read-only or add "ห้ามแก้ไฟล์".

## 2. Dispatch — the Enter gotcha (MOST COMMON FAILURE)

```bash
tmux send-keys -t "$PANE" -l 'พรอมต์ภาษาไทย/ข้อความยาว...'   # -l = literal, no key-name parsing
tmux send-keys -t "$PANE" Enter                                # Enter as a SEPARATE call
```

**TUIs swallow the Enter that arrives with/right after a paste** (bracketed-paste).
The prompt then sits in the input box forever and the team "never starts".

**MANDATORY verification** — ~2s after dispatch, capture the pane:
- Prompt text still visible in the input box → NOT submitted → send `Enter` again.
- Work indicators visible ("esc to interrupt", "Working", tool activity) → submitted.

Never arm a completion watcher before verifying submission — you'll wait on a
task that never started.

**Paste-placeholder trap (codex, field-bitten 2026-07-17):** a long brief can
collapse in the composer to `[Pasted Content N chars]` — the prompt text is NOT
visible, so a "prompt text still visible" check reads as submitted while nothing
runs. Treat the placeholder as not-submitted. Enter on an empty composer is a
no-op, so the robust rule is: no work indicators after ~6s → send Enter again
regardless of what the capture shows (`scripts/deliver.sh` does this).

## 3. Completion detection

Working markers differ per TUI and polling can miss them entirely (a 4s poll
loop missed a 93s claude-zai run). Don't rely on marker-appears-then-disappears.

Robust pattern — **stability + no-work-marker**, N consecutive clean polls:

```bash
clear=0
while [ $clear -lt 3 ]; do
  if tmux capture-pane -t "$PANE" -p | grep -qi "esc to interrupt"; then clear=0; else clear=$((clear+1)); fi
  sleep 5
done
echo TEAM_DONE
```

- Run via Bash `run_in_background` (one team) or Monitor (streaming several).
- Known done-markers as extra signal: claude prints `✻ Worked for Xs`; codex
  markers/states are calibrated in `codex-tmux-driver` §3 — use those verbatim.
- Always pair with a timeout; on "never started" warnings, first re-check the
  input box (see §2) before assuming the team is slow.

Live status board — who is busy right now (one session = one query):

```bash
tmux list-panes -s -t "=$S" -F '#{window_name} #{pane_id}' | while read -r w p; do
  tmux capture-pane -p -t "$p" | grep -qi 'esc to interrupt' && echo "WORKING  $w" || echo "idle     $w"
done
```

Do not use tmux `monitor-activity` for this — TUIs redraw constantly even when
idle, so the activity flag stays lit and means nothing.

## 4. Capture results

Visible pane ≠ full answer — long answers scroll out. Use scrollback:

```bash
tmux capture-pane -t "$PANE" -p -S -300 | grep -v '^$' > scratchpad/team-answer.txt
```

Capture BEFORE sending the next task (new output pushes old answers out of
scrollback limits). Quote the team's actual output in your PM report — don't
paraphrase from memory.

## 5. PM discipline

- **PM dispatches; it never does the worker's task itself.** Catching yourself
  editing a file the worker owns (because it's faster, or the worker stalled) means
  re-dispatch, not ghost-write: PM-authored work skips the §6 self-check contract, so
  nothing captures its evidence and no one verifies it.
- One brief = one deliverable + output format + explicit constraints
  ("ห้ามแก้ไฟล์ใดๆ ทำแค่อ่านและวิเคราะห์").
- **Bound open-ended briefs**: reasoning-heavy TUIs happily burn 15+ minutes (and
  quota) on an unbounded "review"/"audit" — cap them ("static reading only, no
  probing commands, max N findings"). For tools with their own orchestration layer
  (e.g. oh-my-codex), start briefs with "work alone — no subagents" or the layer
  may hijack the task into an agent-wait loop (field-bitten 2026-07-14).
- **Persona/role constraints belong to the target repo, not to this transport.** If a
  worker needs a standing role, identity, or house rules, put them in that repo's
  `AGENTS.md` / `CLAUDE.md` — codex/opencode read those themselves, however they were
  launched. Do NOT build a profile/persona loader into this skill or paste a BMAD
  persona block into every brief (decided 2026-07-16): it duplicates a per-project file
  that already works and couples the transport to a manifest format. A persona is
  costume anyway — it carries no power to verify work; that job is the outbox
  self-check contract in §6.
- Track a status board (team / session / model / task / status); report once
  with results compared side-by-side, not play-by-play.
- Cleanup when done: `tmux kill-session -t "=auto--myapp"` — one exact-match call
  removes the whole team; `kill-window -t "$PANE"` to retire one worker only — or
  keep alive for follow-up rounds and say so in the report. Prefer graceful shutdown first
  (inbox message: finish current step, dump status to outbox, exit) so partial
  results survive; hard-kill only on timeout.

## 6. Scaling up: mailbox pattern (from Claude Code Agent Teams)

For multi-round or multi-agent runs, don't dispatch/collect via raw send-keys +
pane-scraping — use the file-based messaging model borrowed from Claude Code
teammates: per-agent **inbox** files delivered by a loop that only fires when
the agent is idle (queueing at turn boundaries, single owner of the
Enter-verify-retry dance), per-agent **outbox** files as the output contract
(completion = file exists + a terminal sentinel `TEAM_DONE` / `TEAM_BLOCKED` /
`TEAM_FAILED` `<task-id>`, not marker-disappears heuristics), and a shared task
board with owner/blockedBy.

**Outbox self-check contract** — `TEAM_DONE` proves the turn ended, not that the
work is right. A worker that self-certifies (`✓ done`) is the false-trust failure
wearing a nicer costume, so the outbox must carry **evidence, not attestation**:

```text
ASKED:      <the brief restated in one line — catches misunderstanding early>
DID:        <files / actions>
EVIDENCE:   <RAW output of the verification command actually run — not a summary, not a ✓>
UNVERIFIED: <what could not be checked and why, or "none">
GAPS:       <what was intentionally skipped, or "none">
<terminal marker — exactly ONE of:>
TEAM_DONE <task-id>      finished; evidence above
TEAM_BLOCKED <task-id>   cannot proceed — why is under UNVERIFIED/GAPS
TEAM_FAILED <task-id>    attempted and failed — failing output under EVIDENCE
```

- **Terminal markers are typed** (borrowed from thClaws' `idle_reason`,
  2026-07-19 — their lead logic was blind to give-up states until they typed
  them). The PM wait loop matches all three, so a blocked or failed worker
  surfaces immediately instead of burning the whole timeout; `BLOCKED`/`FAILED`
  skip the verify lane and go straight to the PM's re-dispatch decision.
- **The worker reports; the PM decides.** `TEAM_DONE` = "turn finished + evidence
  dumped", never "it is correct". Read the EVIDENCE and rule pass/fail yourself;
  for high-stakes work re-run the command — the worker's evidence only tells you
  where to look. This is a soft gate (evidence can be faked), not a hard one — say
  so out loud rather than letting the contract imply more rigor than it provides.
- **Tamper-check before believing any output** (field-bitten 2026-07-16): a gate the
  worker can rewrite is not a gate. The checker usually lives inside the worker's own
  writable sandbox, so confirm it was not modified (`git status --porcelain`, or a
  checksum against a pristine copy) *before* trusting a passing run. A worker that
  rewrote its own test voided its evidence — that is a `fail`, not a pass.
- **Proportional**: demand real EVIDENCE only where a verifiable surface exists. A
  read/analysis brief puts its findings there and explains itself under UNVERIFIED —
  do not bolt ceremony onto a task with nothing to run.

**Interrupt/remediation rule (field-bitten): STOP the delivery loop first** —
set the stop flag and wait for its PID to exit BEFORE touching the inbox or the
pane. An Esc-interrupted pane reads as idle to the loop, which will instantly
dispatch whatever is queued; rewriting an inbox file during that window got both
versions submitted back-to-back.
Design, delivery-loop script, and what does/doesn't transfer from the native
feature: `references/teammates-messaging.md` (Part 3 = field-verified PoC results
at the pattern level: round-trip, queueing proof, Enter-swallow every dispatch;
codex-specific calibration lives in `codex-tmux-driver`).
Proven loop: `scripts/deliver.sh`. If the whole team is Claude Code,
consider native teams instead (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
`--teammate-mode tmux`); this skill remains the path for mixed-tool teams.

Runnable end-to-end orchestration: `workflows/mailbox-run.js` — a Claude Code
Workflow (run via the Workflow tool) that pipelines each worker through
setup → dispatch (with the outbox self-check contract) → wait for a terminal
marker (`TEAM_DONE` / `TEAM_BLOCKED` / `TEAM_FAILED`) → collect → **PM
adversarial verify** on `TEAM_DONE` results only (re-runs the worker's own
evidence command; blocked/failed skip verify and go straight to the PM's
re-dispatch decision) → report + cleanup. One agent owns each worker's full lifecycle (pane
id stays in that agent's shell); the foreign TUI is driven via `deliver.sh`
inside it. The self-check contract is evidence-not-attestation: `TEAM_DONE`
means "finished + evidence dumped", never "correct" — the PM decides pass/fail.

## 7. PM workflow integration — sqthink in, party gate out (wired 2026-07-19)

The PM loop is plan → dispatch → gate, and the plan/gate ends are owned by two
sibling skills (same skill root / same plugin `skills/` dir):

- **Before dispatch — plan with `sqthink`, then create tasks (mandatory for
  EVERY run — Master directive 2026-07-19):** first run `sqthink`'s planning
  template over the objective to produce the dispatch plan: worker split,
  per-worker brief + `verify_cmd`, dependency order, stakes level. Then
  materialize that plan in the runtime task tracker (Claude Code:
  `TaskCreate`; other runtimes: the §6 shared task board) — one task per
  worker carrying the brief summary, `verify_cmd`, and `blockedBy` for
  dependency order. Only then dispatch, and update each task's status as its
  outbox lands. **No sqthink plan + no tasks = no dispatch** — this replaces
  the earlier multi-worker/high-stakes-only rule; a single trivial task still
  gets a (short) sqthink pass and one task entry.
- **After collection — completion gate:** the outbox self-check contract (§6)
  is the worker-level gate; the run-level gate escalates by stakes:
  - Normal runs: PM adversarial verify (§6 / mailbox-run.js Verify stage) —
    re-run the worker's own evidence command yourself.
  - High-stakes runs (production impact, multi-file, or Master asked for
    review): hand the collected evidence to `party-mode`'s bundled ACP-only
    3-model gate: `node <party-mode>/scripts/review-gate.mjs <packet> <runner-owned-absolute-target>`. Reviews never
    run through tmux workers, review plugins, MCP review tools, or raw review
    CLIs. The final panel must be exactly three valid, distinct, acknowledged
    reviewers and include AGY; AGY failure or any incomplete/invalid panel is
    blocked. Matching findings from two or more final reviewers are must-fix.
- **Precedence:** when the overall task already runs under `party-mode`
  (party-auto), party-mode's phases own the gates — §7 is then just the shape
  of its Phase 5 execution and Phase 6 evidence for tmux runs, not a second
  workflow with its own plan/grill/review cycle.
- When the run was party-gated, report in party-mode Phase 8 shape (Shipped /
  Evidence / Blockers / Risks) and quote worker outboxes — don't paraphrase.

## 8. ACP transport lane (added 2026-07-19, transport-equivalence proven by PoC)

The mailbox **contract** (§6 brief + outbox + typed markers + PM verify) is
transport-independent. Two transports carry it:

| transport | for | mechanism |
|---|---|---|
| `tmux` | any TUI without ACP; codex/agy fallback | deliver.sh + markers (§1-§6) |
| `acp` | codex (`@agentclientprotocol/codex-acp@1.1.7`, frontier-verified); claude (`@agentclientprotocol/claude-agent-acp`, official adapter — e2e-verified 2026-07-21, Task subagents work, effort via `MAX_THINKING_TOKENS`); agy (`antigravity-acp@1.0.0`, community adapter — audited + e2e-verified 2026-07-21, bun required, see ToS note) | `scripts/acp-companion.mjs` — JSON-RPC over stdio |

The Gemini lane has been removed. The companion normalizes and rejects that
retired public agent name before considering `ACP_CMD`; a custom command cannot
silently revive it.

Run one worker over ACP (claude lane needs a model the adapter's SDK accepts —
per the routing directive pass Opus explicitly; a machine default of `fable`
is rejected by the adapter):

```bash
ANTHROPIC_MODEL=claude-opus-4-8 \
  node <skill-root>/scripts/acp-companion.mjs claude <repo> <task-id> <brief-file> [stall-sec]
```

For a per-dispatch Codex choice, set `ACP_MODEL` and
`ACP_REASONING_EFFORT`. The companion applies them after `session/new` or
`session/load` with the standard `session/set_config_option` method, in model
then reasoning-effort order, and verifies the returned `configOptions` before
the prompt. `ACP_EXPECT_MODEL` and `ACP_EXPECT_REASONING_EFFORT` remain
available for an explicit identity witness; when omitted, each selector is
also treated as its expected value. An unavailable option, rejected value, or
non-applied response fails closed before prompt delivery.

The claude adapter's endpoint and model are fully environment-driven; it is not
limited to Anthropic-hosted models. A real ACP outbox round-trip was verified
2026-07-20 against Kimi's Anthropic-compatible endpoint. Keep credentials in the
environment and explicitly blank a stray API key so it cannot take precedence:

```bash
ANTHROPIC_BASE_URL=https://api.kimi.com/coding/ \
ANTHROPIC_AUTH_TOKEN="$KIMI_TOKEN" \
ANTHROPIC_API_KEY= \
ANTHROPIC_MODEL=k3 \
  node <skill-root>/scripts/acp-companion.mjs claude <repo> <task-id> <brief-file> [stall-sec]
```

The brief file carries the SAME §6 contract text; the worker writes the same
`.mailbox-out/<id>` outbox; the companion enforces the same last-line terminal
match and exits 0=done/blocked/failed, 3=no-or-invalid outbox. The optional
positional duration is an inactivity/stall lease, never a total task timeout.
There is no wall-clock ceiling by default; set `ACP_HARD_TIMEOUT_SEC>0` only
when an explicit ceiling is required. A first missed meaningful-progress lease
is `suspected_stalled`; a second consecutive miss confirms `stalled`. Confirmed
stalls and hard ceilings use one cancel-first coordinator (`session/cancel`,
bounded grace/ACK observation, then TERM/KILL only if still unsettled). The
`ACP_STALL_POLICY=report` mode remains observable and can recover without
cancelling the ACP child. Snapshots use the exact `acp-liveness.v1` contract;
the public projection is bounded to `tools` 64, `active_tools` 8,
`stall_history` 32, and 64 KiB of UTF-8 JSON, with active tools selected first
and deterministic compaction/fallback for terminal writes. Tool records are
bounded metadata/digests and common secret shapes are redacted. Every terminal
path treats terminal `liveness_state` as authoritative and persists
`active_tools: []`; `tools` may retain bounded last-reported ACP evidence. Every
successful terminal return requires an atomic liveness write/readback that
agrees with the dispatch state; failure is nonzero with
`liveness_persistence_failed` evidence. Mechanical terminal evidence keeps
cancel ACK, attempted/delivered TERM/KILL, child exit code/signal, child-settlement
signal delivery, and descendant-only cleanup delivery separate. A clean child
exit 0 remains `cancelled` when only descendant cleanup was signalled; descendant
cleanup never reclassifies a clean child settlement as `stalled`/forced. Every
terminal path closes and reaps the complete detached process group. `ACP_AGENT_ID`,
when supplied, is validated and preserved as the stable
Pulse identity; Codex children default to `INITIAL_AGENT_MODE=agent-full-access`
unless the caller explicitly overrides it with `read-only`, `agent`, or
`agent-full-access`; invalid Codex modes fail before spawn. ACP v1 tool records
accept only `pending`, `in_progress`, `completed`, or `failed`, and persist
bounded metadata/digests rather than content. What ACP removes: Enter-swallow
retries, marker calibration, dialog keypress guessing — permissions arrive as
structured requests (companion auto-approves; tighten per-task when the target
repo is sensitive).

Every dispatch also commits one immutable, bounded
`.tmux-teams/receipts/<dispatch_id>.json` operation receipt under the closed
`references/acp-session-receipt-v1.schema.json` contract. It is published with
same-directory exclusive creation, file and directory fsync, no-replace
publication, and readback before `recordPrompt`, `markPromptStarted`, or the
first `session/prompt` byte. Its immutable
`.tmux-teams/receipt-commits/<dispatch_id>.json` envelope is separate from the
receipt; a pair is trusted only after a fresh joint durability/readback proof
and exact digest match. A successful `session/load` receipt proves the exact
correlated JSON-RPC response to the requested session; ACP does not return a
load `sessionId`, so the companion never manufactures one from a response
field. `initialize_agent_info` is the adapter identity observed in initialize,
and the receipt binds the effective verified `INITIAL_AGENT_MODE` and raw-byte
execution-profile digests. `ACP_SESSION_RECEIPT_REQUIRED=1` requires explicit
`new|load` intent and, for load, a validated prior dispatch and receipt digest.
Failed or interrupted loads write null-operation tombstones and cannot
cold-start or deliver a prompt. Required-mode receipt, profile, or correlation
failure exits nonzero before prompt delivery. Receipts contain only bounded
digests and identity/profile metadata, never prompts, outboxes, tool payloads,
PIDs, or absolute paths; the receipt digest is joined into dispatch,
KMS, and terminal evidence by `dispatch_id`. In optional/default mode a
persistence failure is explicitly warned and carries `receipt_digest: none`;
required mode always fails closed instead of continuing without the receipt.
Required Codex dispatches resolve the locally pinned
`@agentclientprotocol/codex-acp@1.1.7` package, verify package metadata and
entry bytes, bind the profile to the real Node and `CODEX_PATH` executable
bytes/version, and spawn that verified Node/entry pair. PATH shadowing, fake
version output, cache/profile drift, or an unsafe receipt directory fails before
spawn; a null-operation failure tombstone is published when the receipt root
remains writable.

**Terminal KMS facts are automatic.** On every terminal path the companion
best-effort appends an immutable `event_kind: transport-terminal` event with the
mechanical facts it can prove: task/worker/transport, repo revision and tree,
terminal and exit code, timing, brief size, evidence presence, and timeout
state. This event deliberately omits `pm_verdict` and `lesson`; the PM appends
its judgement as a separate event after independent verification. Set
`ACP_KMS_AUTO=0` only when the caller intentionally owns terminal recording.

**The live view is structured, not a black box.** The companion renders the
core text, tool, and plan `session/update` streams to stdout: `[user]` (replayed
user history), `[think]` (reasoning), `[say]` (agent message text), `[tool]
<kind> · <title> (<status>)` with its later `→ completed`/`→ failed`
transition, and `[plan]` with per-entry marks. A tmux pane shows raw scrollback;
this shows typed signal — what the user asked and what the agent is thinking,
doing, and planning. Follow the companion's stdout (its log file) the way you
would `capture-pane`.

**Cross-turn context is opt-in via `ACP_RESUME`.** The mailbox brief is
one-shot: each dispatch is a fresh `session/new`, so a follow-up cannot see an
earlier turn's context by default. To continue one, pass its printed
`[session] <id>` as `ACP_RESUME=<id>` on the next dispatch — the companion calls
`session/load` (the agent replays its history) instead of starting over. It
needs the agent to advertise `loadSession`; without it the run falls back to a
fresh session with a warning, never a silent cold start. Session ids are also
stored per task-id under `.tmux-teams/sessions/`, so re-dispatching the same id
resumes automatically.

**codex over ACP is UNLOCKED** via the official App Server adapter
`@agentclientprotocol/codex-acp@1.1.7` (successor to the deprecated
`zed-industries/codex-acp`): it drives the INSTALLED codex CLI, so
`gpt-5.6-sol` + `ultra` work exactly as the Frontier-always directive
requires — e2e-verified 2026-07-19. Do NOT use the old zed-industries binary
(stale embedded core; the companion maps its failure signatures to a clear
message). tmux remains the fallback lane for codex and agy. §7's
plan/tasks-before-dispatch rule applies to BOTH transports.

**agy over ACP is UNLOCKED (2026-07-21)** via the community adapter
`antigravity-acp@1.0.0` (shubzkothekar) — version-pinned to the release whose
source was fully audited that day: no credential handling (OAuth stays inside
the official `agy` binary it spawns), exactly one network call in the whole
project (downloading `agy` from Google's official GitHub releases with a
pinned SHA-256, refused on mismatch), no telemetry, two runtime deps (official
ACP SDK + protobuf). The companion sets `AGY_SKIP_DOWNLOAD=1` so the installed
`agy` on PATH/$AGY_BIN is always used. Requires `bun` on PATH (the adapter is
Bun-native). **ToS risk — say it out loud when proposing this lane:** Google's
Antigravity terms name third-party tools driving an OAuth-authed agy as a
breach (account suspension possible); this is the same pattern-level exposure
as driving agy via tmux, and Google's own mitigation is authenticating agy
with a Vertex AI / AI Studio API key instead of OAuth.

**Permissions (stall-tested 2026-07-20):** the two transports fail very
differently here. On tmux, a TUI approval dialog SILENTLY STALLS the turn —
deliver.sh can only WARN and wait — so workers MUST be launched with the
right flags up front (codex approval/sandbox flags per codex-tmux-driver,
claude bypass-permissions, agy trust-once). On ACP there is no stall: under
the most restrictive codex config (`approval_policy = "untrusted"` +
`sandbox_mode = "read-only"`) the run still completed hands-free — approvals
either resolve inside the App Server adapter or arrive as structured
`session/request_permission` requests, which acp-companion answers
programmatically (auto-approve, allow_always > allow_once > first). For
sensitive target repos tighten the companion's permission handler instead of
juggling TUI flags.

## 9. Team KMS — run memory (added 2026-07-21)

The outbox answers *was this piece of work good?*; the KMS answers *is what the
system has learned still true and usable?* Both fail differently, and the outbox
cannot answer the second — it is read once and never again.

`scripts/kms.mjs` — two commands, zero deps, one immutable file per event under
`<repo>/.tmux-teams/kms/events/` — the same in-project convention
as `.mailbox-out/` (worker outboxes) and `.remember/`. The store travels with the
project, and `kms.mjs` drops a self-ignoring `.gitignore` (`*`) into
`.tmux-teams/` on first write, since we cannot edit a target repo's ignore rules
and an event carries verify output that must never reach a commit:

```bash
node <skill-root>/scripts/kms.mjs append <repo> <event-file|->   # write one event
node <skill-root>/scripts/kms.mjs recall <repo> [terms...] [--worker W] [--limit N]
```

- **Facts and judgement stay distinct.** An ACP dispatch first writes a
  mechanical `transport-terminal` event; after verification the PM writes a
  separate event carrying `pm_verdict` and any `lesson`. Events are immutable,
  so “fill the verdict later” always means another append, never editing the
  transport event. The tmux workflow may still write one combined PM event.
- **Not a gate.** Workers run as the same UID with broad permissions, so the
  store is worker-writable wherever it sits — a `$HOME` path would not have
  changed that, it would only have hidden meddling from `git status` as well. A
  PM event records the PM's verdict; no event replaces the PM re-running the check.
  Do not build a "verified by KMS" claim on top of it — §6's tamper rule applies
  here too.
- **Best-effort, never blocking.** A failed KMS write must not fail a run that
  otherwise worked; `mailbox-run.js` reports the error and continues. But it
  reports it out loud — memory that silently stops being written is the failure
  nobody notices for weeks.
- **Every terminal state is recorded** — ACP does this automatically unless
  `ACP_KMS_AUTO=0`; blocked, failed, timed out, malformed/missing outbox, and
  PM-rejected DONE are included across the mechanical and PM events. A store
  that keeps only successes lies about how the work actually goes.
- **Secrets are scrubbed on write** (EVIDENCE is raw command output by contract,
  and this store sits outside `.gitignore`'s reach). Events are immutable, so
  scrubbing after the fact is not an option — keep the excerpt short anyway.
- **Terminal markers are defanged on recall** (`TEAM_DONE` → `[TEAM_DONE]`),
  not on write: the completion detector reads `.mailbox-out/<id>` and never this
  store, so the risk lives where recalled text reaches the next brief.
- **The repo is the key.** Because the store lives inside the project, two repos
  sharing a basename cannot share a memory — cross-project bleed is structurally
  impossible rather than defended against.
- **Do not confuse the two `.tmux-teams` paths.** `<repo>/.tmux-teams/kms/` is
  this memory and belongs in the project. `~/.tmux-teams/mailbox-run/` is the
  delivery CONTROL dir (inboxes, stop flag, pidfile) and must stay OUTSIDE the
  repo — that is the control/sandbox split §6 depends on. Moving either one to
  where the other lives breaks a different guarantee.

Event body — `key: value` lines, `task_id` and `worker` required. `kms.mjs`
stores whatever keys it is given, so this list grows without touching code:

- **What happened:** `event_kind / task_id / dispatch_id / worker / transport /
  repo_rev / tree / terminal / exit_code / pm_verdict / verify_cmd / lesson`
- **Measured (added 2026-07-21):** `started_at / wait_sec / timeout_sec /
  brief_bytes / evidence_present / timed_out / stakes`
- ACP terminal transport facts additionally keep `cancel_attempted /
  cancel_ack / termination_attempted / termination_delivered / kill_attempted /
  kill_delivered / child_settlement_signal_delivered /
  descendant_cleanup_signal_delivered / child_exit_code / child_signal /
  forced_reap_attempted / forced_reap_delivered / forced_reap` separate.

Write `pm_verdict` only in the PM's follow-up event, from the PM's own verdict (`fail` → `reject`,
`unverifiable|skipped` → `unresolved`), never from the worker's self-report. For
`lesson`, name why it slipped through rather than narrating: `ci-gap |
latent-code | workload-gap | incomplete-prior-fix | review-miss | brief-too-open
| none` (taxonomy adapted from thananon/9arm-skills' post-mortem skill).

**Measure early, even imperfectly.** Events are immutable, so a dimension not
recorded today is unanswerable for every run already written — "which task
shapes run long?" cannot be backfilled. Timing is captured by the agent holding
the shell (this workflow runtime cannot call a clock), and `-1` / `""` means
*not measured*: never write a guessed number, because later nobody can tell an
estimate from a measurement. Expect this list to keep growing; adding a key
needs no code change.

**Recall is opt-in.** Injecting recalled text into a brief means worker-authored
prose from an earlier run becomes an instruction to a later one — a persistent
injection path created by the system's own legitimate write path, which no
amount of escaping closes. Default is to record only; pull `recall` yourself
when planning, read it as leads, and paste in what you judge worth carrying.
Recalled output is labelled unverified history and carries a warning not to
re-run a stored `verify_cmd` blindly — re-derive it from the plan instead.

## 10. Pulse and the three projections

§9 remembers what finished. `scripts/pulse.mjs` shows what is happening now,
scoped to this repo and to workers this system dispatched. A publish separates
transport evidence, loop wiring and token custody:

```text
transport probes -----------------------> .tmux-teams/pulse.json
graph.json + pulse + custody ledgers ---> .tmux-teams/graph.html
graph.json + custody ledgers -----------> .tmux-teams/kanban.html
pulse.json -----------------------------> .tmux-teams/pulse.html
all published files --------------------> .tmux-teams/pulse-current.json (last)
```

Pulse v4 is the default persisted transport snapshot and its contract is
[Pulse data v4](references/pulse-v4.schema.json). It references the v3 run,
verdict and phase definitions; existing v3 documents remain described by
[Pulse data v3 compatibility contract](references/pulse-v3.schema.json).
`phase` and `phase_source` are explicit evidence.
Missing or untrusted attribution remains unassigned; never infer it
from a task name, worker, provider or timestamp. `compat-v1` is a stdout-only
down-projection for consumers that require the older v1 contract.

```bash
node <skill-root>/scripts/pulse.mjs once  <repo> [--time-zone Asia/Bangkok]
node <skill-root>/scripts/pulse.mjs json  <repo> [--time-zone Asia/Bangkok]
node <skill-root>/scripts/pulse.mjs watch <repo> [--interval 20] [--time-zone Asia/Bangkok]
node <skill-root>/scripts/pulse.mjs ensure <repo> [--interval 20] [--time-zone Asia/Bangkok]
node <skill-root>/scripts/pulse.mjs compat-v1 <repo>
```

`--delivery-loop` and `--delivery-runtime` are gone, along with the four-phase
pilot and its governed gate that produced the projections they read. A script
still passing them now **exits 2 and names the argument**: as of 2026-08-03
`pulse.mjs` refuses any argument the command in front of it does not read —
including `--interval` and `--managed` on `once`/`json`, which never watch — and
refuses an `--interval` that is not a positive number of seconds rather than
falling back to 20 in silence. A withdrawn flag that exits 0 is indistinguishable
from one that still works.

Pulse retains `--team-graph` and `--team-runtime` for an older optional Pulse
projection. Those inputs are not the workflow declaration. The active delivery
loop always declares its teams and routes in `<repo>/.tmux-teams/graph.json`
through `graph.mjs` and `workflow-graph.mjs`.

Each file is atomically replaced under one publish lock. The publisher writes
the JSON, all three HTML views and their assets, then
`<repo>/.tmux-teams/pulse-current.json` last. That commit marker carries their
paths and SHA-256 hashes. A reader can detect a mixed or partial bundle and
re-read the marker after validation to detect a racing publish. `json` prints
the exact persisted JSON document rather than another projection.
The document carries `stream_id` + monotonic `sequence`, a unique `snapshot_id`,
render/observation timestamps and freshness, per-source health, and bounded
diagnostics so agents can distinguish stale or partial observation from a
healthy empty run. A dispatch's `dispatch_id` is the primary correlation key
between its footprint and KMS events. A footprint carrying that UUID accepts
only a matching event; Pulse falls back to task-id + recency only when the
footprint itself is legacy data without `dispatch_id`.

`graph.html` answers who exists and how the loop is wired. It draws each
declared team once, with a dispatcher, parallel workers and its evaluator, then
draws workflows as separate team-level routes. The governing contract requires
every agent node—and the outer controller—to state agent id; role, lane and
transport; verified model or `unverified`; work recorded in the custody ledger;
and a measured clock or `not started`. Declared models are requests, not
verified-model evidence.

The current `graph.mjs` renderer does not yet conform to that model line. When
no verified model exists it may display `<requested model> unconfirmed`,
`default — none pinned`, or `not recorded` instead of `unverified`. Treat all
three as unverified, and never quote them as the model that answered. The
loop-health strip reads `runner-heartbeat.json` before the diagram so a dead
runner cannot look idle.

`kanban.html` answers where each token is held. Placement, WIP and blocked
reasons come from the same `teamOccupancy()` and pull decisions the controller
uses. A malformed ledger line, invalid history or unplaceable token is surfaced,
not turned into an ordinary card.

Human timestamps default to `Asia/Bangkok`; the HTML displays the timezone
once in the header and keeps each semantic timestamp concise. Set an IANA zone
with `--time-zone` or `PULSE_TIME_ZONE` (CLI wins). Explicit invalid values exit
2. The canonical zone is part of a watcher's config fingerprint, so stop an
existing watcher before changing it. This setting is render-only: Pulse v4 JSON
timestamps remain RFC 3339 UTC.

The contract reports `trust_level: advisory_same_uid`: Pulse observes files,
processes, panes, and KMS records that same-UID workers may also influence. It is
read-only, and every suggested action code is advisory with auto-execution
disabled; Pulse never retries, kills, redispatches, or otherwise remediates a
run. Humans and agents must verify before acting.

All three HTML files refresh themselves — open any one and leave it open. Each page
polls only the same-origin `pulse-current.json` marker and reloads only when its
`snapshot_id` changes. It visibly marks expiry or marker failure, preserves page
and flow-region scroll, focused agent/control, and open `<details>` state across
reloads, and exposes one keyboard-operable pause/resume control. Reduced-motion,
forced-colors, offline/local-asset, and CSP constraints remain active.
`watch` is the observer; `ensure` renders immediately and then starts a detached
watcher only when this repo's existing watcher is not alive.
Its pidfile is `<repo>/.tmux-teams/pulse-watch.pid`: repo-local so same-basename
projects cannot collide, exclusively claimed so concurrent cron fires do not
duplicate the watcher, and reclaimed when a prior watcher died. Calling
`ensure` from every cron gate makes the page reboot-safe without a babysat tmux
session.

**It probes; it does not believe.** No status file is read, because a worker
announcing its own liveness is the attestation §6 rejects. Three sets are
compared and the GAPS are the product:

- **footprint** — `<repo>/.tmux-teams/dispatch/<id>.md`, written at dispatch by
  BOTH lanes (the tmux workflow and `acp-companion.mjs`) — the dispatcher
  stating what *it* did, which a worker cannot forge — plus any
  `<repo>/.mailbox-out/<id>`. The ACP record omits `pane:` because that lane has
  none, which is why the pane check must tolerate its absence rather than read
  it as death. A live test caught this lane writing no footprint at all: it was
  observable only while alive, so dying mid-run erased it entirely. Dispatch DELETES a stale outbox first, so without
  the dispatch record a worker dying before its first write would leave no trace
  in this repo at all — the truest silent death would be the invisible one.
- **alive** — tmux panes whose `/proc/<pane_pid>/cwd` is this repo, and ACP
  companions found the same way. Session names prove nothing (`auto--api` fits
  any repo called api). A pane whose shell has **no child** is an idle prompt,
  not a running job: `mailbox-run` opens a shell and types `codex` into it, so
  the shell outlives a crashed worker.
- **recorded** — §9 events, matched by id *and* recency: ids get reused, and
  yesterday's record must not settle today's dispatch. All events appear in
  recent history, but only an event with an explicit `pm_verdict` of `pass`,
  `reject`, or `unresolved` settles the live run or enters PM statistics. An ACP
  `transport-terminal` event alone leaves it awaiting verdict.

| footprint | terminal marker | alive | PM verdict recorded | state |
|---|---|---|---|---|
| yes | — | yes | — | running |
| yes (pane still listed, or <5m) | no | no | no | starting |
| yes | no | no | no | **DIED SILENTLY** |
| yes | yes | no | no | awaiting-verdict (<15m) → unrecorded |
| yes | yes | no | yes | finished — leaves the live view |

`DIED SILENTLY` is the reason this exists: nothing else in the system notices a
worker that vanished. What keeps that alarm worth reading is refusing to raise
it on the two occasions a healthy run legitimately has no process: while it is
still starting, and while the PM is verifying it. Startup is checked by
evidence first — a pane id recorded at dispatch that tmux still lists means the
dispatch is intact, whatever is happening inside it — and only falls back to a
5-minute window when there is no pane to check. That matters for the ACP lane,
where a cold `npx` fetching an adapter can outlast any short timer; announcing
death during a worker's own installation is the fastest way to make the alarm
worthless.

**Legacy diagrams, and the live Team flow answer different questions.** The loop chart at the top
is the SYSTEM: plan → dispatch → work → outbox? → verify → verdict → record →
memory, with the branch to *died silently* and two back-edges — a rejected
verdict returning to dispatch, and today's record feeding tomorrow's planning.
Those two are drawn **dashed on purpose: neither is measured**. We count rejects,
but nothing records whether a reject was re-dispatched, and recall is opt-in and
unlogged. Solid lines would claim the loop turns when nobody knows that it does —
so the dashes double as the list of what to instrument next. The dashboard
diagram and delivery/phase illustrations are fixed-layout legacy or normative
SVGs; they are not the live Team graph and do not define Team membership. The
current full-screen Team flow uses normal document layout and a minimal static
SVG connector layer. No charting library is bundled or loaded.

**The per-run graph is where each run stopped.** Every dispatch walks the same five
stages — dispatched → alive → outbox → PM verdict → recorded — so the truthful
picture is not boxes and arrows but one line per worker with a filled dot for
each stage actually reached. Read across and you see how far a worker got before
it finished, stalled or died; read down and you see the shape of the run. Stages
record the PAST, not the present: an outbox proves the worker was alive at some
point even though it is gone now. Finished runs stay on the graph on purpose — a
complete line is what an interrupted one is read against. It remains a
hand-rolled dashboard SVG; the separate current Team flow uses local
HTML/CSS/SVG only, so both views work offline without network access.

**Outboxes ignore themselves too.** `.mailbox-out/` holds raw command output,
so dispatch drops a `.gitignore` containing `*` into it — the target repo's
ignore rules are not ours to edit, and a real run leaked an outbox into a commit
before this existed. Same trick as the memory store, same reason.

**Honesty rules, same as everywhere else here.** Control dirs
(`~/.tmux-teams/mailbox-run/<id>`) are keyed by worker id alone and cannot prove
which repo dispatched them, so they appear in their own section and never raise
an alarm — counting them as ours made the first render report three deaths that
all belonged to another project. An unreadable `/proc` becomes `unknown`, never
`dead`. Anything unmeasured prints "not measured", never `0`. The header carries
the render time, so a dead observer makes the page visibly rot instead of
quietly showing yesterday. Repo-writable inputs are bounded to 1 MiB per file,
1,000 files per source, 32 MiB across a snapshot, and 256 characters per parsed
field; hitting a bound produces a finite diagnostic instead of exhausting the
observer.
