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
    review): hand the collected evidence to `party-mode`'s 3-model review
    (opencode + codex + antigravity via their review **plugins** — per the
    2026-06-18 directive reviews NEVER run through tmux workers; tmux is the
    execution transport, review lanes are MCP). Gate rule = party-mode Phase 6:
    ≥2-of-3 must return PASS to proceed; an objection ≥2 lanes share is
    must-fix.
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
| `acp` | codex (`@agentclientprotocol/codex-acp`, frontier-verified); claude (`@agentclientprotocol/claude-agent-acp`, official adapter — e2e-verified 2026-07-21, Task subagents work, effort via `MAX_THINKING_TOKENS`); agy (`antigravity-acp@1.0.0`, community adapter — audited + e2e-verified 2026-07-21, bun required, see ToS note); gemini (native `--acp` — see note) | `scripts/acp-companion.mjs` — JSON-RPC over stdio |

Run one worker over ACP (claude lane needs a model the adapter's SDK accepts —
per the routing directive pass Opus explicitly; a machine default of `fable`
is rejected by the adapter):

```bash
ANTHROPIC_MODEL=claude-opus-4-8 \
  node <skill-root>/scripts/acp-companion.mjs claude <repo> <task-id> <brief-file> [timeout-sec]
```

gemini note (re-verified 2026-07-21): dead for individuals — oauth-personal is
hard-blocked (`-32000` "migrate to Antigravity"), the api-key auth path works
mechanically but needs a valid `GEMINI_API_KEY`, and CLI 0.51.0 is the latest.
Keep the lane; it lights up wherever a licensed gemini or a valid API key
exists.

The brief file carries the SAME §6 contract text; the worker writes the same
`.mailbox-out/<id>` outbox; the companion enforces the same last-line terminal
match and exits 0=done/blocked/failed, 3=no-or-invalid outbox. Hardening
(2026-07-20): the companion prepends a deterministic task-id/outbox/marker
preamble to every prompt (placeholder-safe briefs), tolerates an outbox
mistakenly written as a directory holding a single file, and on timeout kills
the worker's whole process group (no orphaned builds). What ACP
removes: Enter-swallow retries, marker calibration, dialog keypress guessing —
permissions arrive as structured requests (companion auto-approves; tighten
per-task when the target repo is sensitive).

**codex over ACP is UNLOCKED** via the official App Server adapter
`@agentclientprotocol/codex-acp` (successor to the deprecated
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

`scripts/kms.mjs` — two commands, zero deps, one immutable file per finished
dispatch under `~/.tmux-teams/kms/<basename>-<hash8>/events/`:

```bash
node <skill-root>/scripts/kms.mjs append <repo> <event-file|->   # write one event
node <skill-root>/scripts/kms.mjs recall <repo> [terms...] [--worker W] [--limit N]
```

- **Not a gate.** Workers run as the same UID with broad permissions, so this
  store is worker-writable like everything else in `$HOME`. It records the PM's
  verdict; it never replaces the PM re-running the check. Do not build a
  "verified by KMS" claim on top of it — the §6 tamper rule applies here too.
- **Best-effort, never blocking.** A failed KMS write must not fail a run that
  otherwise worked; `mailbox-run.js` reports the error and continues. But it
  reports it out loud — memory that silently stops being written is the failure
  nobody notices for weeks.
- **Every terminal state is recorded** — blocked, failed, timed out, and
  PM-rejected DONE included. A store that keeps only successes lies about how
  the work actually goes.
- **Secrets are scrubbed on write** (EVIDENCE is raw command output by contract,
  and this store sits outside `.gitignore`'s reach). Events are immutable, so
  scrubbing after the fact is not an option — keep the excerpt short anyway.
- **Terminal markers are defanged on recall** (`TEAM_DONE` → `[TEAM_DONE]`),
  not on write: the completion detector reads `.mailbox-out/<id>` and never this
  store, so the risk lives where recalled text reaches the next brief.
- **Slug = basename + hash of the resolved path.** Basename alone merges
  `~/work/api` and `~/clients/api` into one memory; cross-project bleed is the
  one failure a memory store must not have.

Event body — `key: value` lines, `task_id` and `worker` required:
`task_id / worker / transport / repo_rev / tree / terminal / pm_verdict /
verify_cmd / lesson`. Write `pm_verdict` from the PM's own verdict (`fail` →
`reject`, `unverifiable|skipped` → `unresolved`), never from the worker's
self-report. For `lesson`, name why it slipped through rather than narrating:
`ci-gap | latent-code | workload-gap | incomplete-prior-fix | review-miss |
brief-too-open | none` (taxonomy adapted from thananon/9arm-skills' post-mortem
skill, 2026-07-21).

**Recall is opt-in.** Injecting recalled text into a brief means worker-authored
prose from an earlier run becomes an instruction to a later one — a persistent
injection path created by the system's own legitimate write path, which no
amount of escaping closes. Default is to record only; pull `recall` yourself
when planning, read it as leads, and paste in what you judge worth carrying.
Recalled output is labelled unverified history and carries a warning not to
re-run a stored `verify_cmd` blindly — re-derive it from the plan instead.
