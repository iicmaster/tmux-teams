# tmux-teams — operating manual

This is the operating manual for the tmux-teams plugin: how work moves, how to
talk to it through ACP, what the published pages draw, full troubleshooting,
the reference detail, and how this repository is updated. The [README](../../README.md)
is the thin, newcomer-first entry point — install, quick start, the skills list,
and a documentation map. This manual inherits everything deeper than that.

Corrections to earlier prose are dated and carried into the section they
correct; anything purely historical is in [§8 Corrections record](#8-corrections-record).

## 1. How work moves

### 1.1 Two layers that must never be conflated

| Layer | File | Answers |
|---|---|---|
| **Declaration** | `.tmux-teams/graph.json` | who exists and how they are wired |
| **Evidence** | `.tmux-teams/work-items/<token>.jsonl`, `pulse.json`, `.tmux-teams/runner-heartbeat.json` | what actually happened, including whether the runner itself is responding |

A declaration is assigned by a human and never observed. Evidence is recorded
and never assumed. Every page keeps the two apart.

### 1.2 Seats

A **team** is a reusable pool of three kinds of seat:

| Seat | Owns |
|---|---|
| dispatcher (exactly one) | intake — whether the team takes the work at all |
| worker (one or more) | doing the work |
| evaluator (exactly one) | judging the team's own output before it is released |

**What the dispatcher is actually for.** The seat's job has always been
described as admission control — inspecting a token at the door and declining
it. In practice a door refusal is rare; the job an operator actually reaches
for a dispatcher to do is **choosing which model runs the work** — this token
is simple, give it the cheap seat; this one needs a multimodal seat; that
model is rate-limited right now, use another. Admission control is still real
and still enforced — [clause 1 of the loop system contract](../skills/tmux-teams/references/loop-system-contract.md)
keeps the refusal ceiling — it is just the seat's secondary duty now.

That routing is expressed per seat, not just per team. Any dispatcher,
worker, or evaluator entry in `graph.json` may override its team's default
`model`, `adapter` (which ACP lane — `claude`, `codex`, or `agy` — carries the
dispatch) and `effort`, in any combination. A seat may also declare
`display_model`: a name shown on `graph.html`'s board, which can differ from
the alias actually sent over the wire — the board can say `opus` while the
dispatch sends whatever model string the adapter accepts. See
[§2 Talking to it through ACP](#2-talking-to-it-through-acp) for how a
requested model is verified, not just asked for.

**A seat may name several models, in order — the palette.** Instead of a
single `model`/`adapter`/`effort`/`display_model`, a seat may declare
`palette`: an ordered array of up to eight whole seat specs. It is the answer
to "this model is rate-limited right now" happening at 3am with nobody
watching — the loop walks to the next candidate itself instead of parking the
token.

```json
"seats": { "build_worker_1": { "palette": [
  { "model": "<model>", "adapter": "claude", "bucket": "vendor-a" },
  { "model": "<model>", "adapter": "codex",  "bucket": "vendor-b" }
] } }
```

Four things make it a fallback and not a wish list:

- It is declared on a **seat**, so an eight-entry palette still costs one WIP
  slot. It never touches `worker_ids`.
- Each entry is a **whole seat spec**, never a bare model name — the same alias
  reaches a different vendor on a different lane, so a model without its lane
  means nothing.
- `bucket` names the **rate-limit family** an entry draws on (defaulting to its
  lane), and two CONSECUTIVE entries may not share one. Neighbours in a single
  bucket are not alternatives: the limit that refused the first refuses the
  second, so trying it spends a leg to learn nothing.
- The walk is driven by whether a leg ever **reached the model**. A leg that
  died at the transport advances to the next candidate; a leg that reached the
  model and failed on the merits **retries the same one**. Being unavailable
  and being wrong are different problems.

It replaces the single-value fields on that seat rather than sitting beside
them, and a graph declaring both is refused at load. What it cannot do: swap
between two executables on one lane — `claude-qwen` and `claude-kimi` are both
`adapter: claude` here.

A team's **WIP limit is not declarable — it always equals its worker count**
(`workflow-graph.mjs`). A `graph.json` that declares a `wip_limit` disagreeing
with its worker count is rejected by name.

### 1.3 Flow is one way

Work moves forward along a route and never runs back up it. An evaluator that
finds a problem does not return the work to the team that produced it — it
brings the work to a state it can pass and forwards it, and the token carries
on to the controller. A controller that is not satisfied does not send the
token back either: it starts a new flow. Rework is a new token on a fresh
route, never the same token moving upstream.

The rule is about crossing teams, and two things that look backwards are not.
A dispatcher refusing a token at the door checks it BEFORE it enters, so
nothing came back out — **three times at most per door**, after which that
dispatcher escalates to the controller instead of refusing again, because a
fourth refusal is two seats disagreeing with nobody deciding. And a team's own
evaluator may loop work back to a worker of that same team as often as the
work needs — that loop is why a team has its own evaluator. Neither crosses a
boundary.

What the rule forbids is a token crossing a team boundary in the direction it
came from: once a team releases work, that team is behind it. Since
2026-08-03 that is **refused, not merely written down** — the ledger validator
rejects a `pulled` naming a team that already admitted the token, and because
every append is validated through the sanctioned writer, the line never lands.
A team that refused at the door never admitted anything, so it may still pull
the work later; that is the difference the check is built around.

The worked example. A QA evaluator reading its own worker's report finds two
different things. The worker did not finish the checklist — send it back to
that worker and have it done properly; same team, allowed. The worker found a
real bug — QA fixes it from the report and carries on; it does not go back to
the Dev team that produced it, because Dev is behind this token now.

> correction (2026-11-10): an earlier page carried a fragment saying a
> cross-team backwards move "is not enforced yet" directly after the paragraph
> recording its enforcement. The [loop system contract](../skills/tmux-teams/references/loop-system-contract.md)
> is the authority: `validateLedger` has refused a backwards `pulled` since
> 2026-08-03. The fragment is retired to [§8](#8-corrections-record).

### 1.4 Workflows and the controller team

A **workflow** is a route composed over teams. `controller_team` is likewise
derived, not declared: it is the head of every route, and a workflow whose
route starts anywhere else is rejected. That control team's single worker seat
is the `outer_controller_id`, so **the control team's WIP is 1 and every route
starts there**. One request waiting on a person stops every new request
entering — a queue, not a rejection, and deliberate. See
[controller-as-team.md](../skills/tmux-teams/references/controller-as-team.md).

`admit.mjs` is the only writer that enforces the front door's WIP limit;
`ledger-writer.mjs` cannot, because it judges one event against one ledger and
never reads the graph. Refused while the controller is holding its one token:

```text
REFUSED  controller_full: control is holding 1 of 1 — a new request is not
admitted while the front door is full. The person may send it again once the
queue moves.
```

### 1.5 Handover is a pull, never a push

`pull-controller.mjs` never hands work to a team. It only lets a team **take**
work it has room for. One pass over the token ledgers decides, per token:

| Situation | Decision |
|---|---|
| last event is `reviewed` `pass` (a delivery team's evaluator accepted it) | eligible to move |
| last event is `intake` `accept` on the control team | eligible to move — admission is the claim, there is no artifact yet |
| last leg `delivered` with a non-`done` terminal | `failed` — a rerun, not a handoff |
| last leg `delivered` with terminal `blocked` | **escalated to a person** — a rerun would ask the same question again |
| the ledger does not validate | `invalid` — every problem printed, nothing appended |
| next team is under its WIP limit | `pulled`, signed by the **receiving** dispatcher |
| next team is at its WIP limit | `blocked`, with the count, and the token stays put |
| no next team on the route | `completed` |

Oldest delivery first, so nothing that has waited longest is starved. A worker
finishing is not the team finishing: until that team's evaluator has passed it,
the artifact has been typed, not checked.

### 1.6 The tick

`loop-runner.mjs` runs one ordered tick — **harvest → pull → dispatch →
escalate**. Harvest runs first so the pull controller never reads a stale event.
Every decision is logged, including the unhappy ones, because a runner that logs
only the happy path looks identical to one that has silently given up.

Verdicts are read from a `VERDICT:` line, **last match wins** (an agent
restating the format before writing its real answer is ordinary), and silence
is never approval.

The direct `pull-controller.mjs` command is an operator dry run. Let the
runner apply pulls so the tick order stays intact:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs <repo>
```

### 1.7 The custody ledger

One append-only JSONL file per token. A mistaken line is corrected by
appending, never by rewriting: what a receiving team inherits is the token's
recorded history, and every later reader — intake, the board, the controller's
audit — answers from it.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs \
  --repo <repo> --actor human:operator --stdin <<'JSON'
{"event":"opened","work_item":"token-001","workflow":"default","agent_id":"requirement_dispatcher","to_team":"requirement","reason":"work admitted by operator"}
JSON
node plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs --repo <repo>
```

`opened` is the first event and can only be the first event; a route-opening
`pulled` would invent a sender.

[loop-system-contract.md](../skills/tmux-teams/references/loop-system-contract.md)
is the SSOT for all of the above. Its [clause 14.1, "Clauses this contract does
NOT yet enforce"](../skills/tmux-teams/references/loop-system-contract.md),
carries a standing list of clauses the contract asserts that **no test
enforces** — including the tick order itself — declared there rather than left
to be discovered.

### 1.8 First run and the everyday commands

Nothing dispatches until a repository has declared its own loop. Use the
bundled `tmux-teams:graph-setup` skill, which interviews you until nothing is
blank, or run the commands directly. `graph.mjs init` expects the state
directory to exist:

```bash
mkdir -p -- <repo>/.tmux-teams
node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs init <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs check <repo>
```

Edit the generated team and model values, then re-run `check`.

Two different failures, and the difference bites newcomers:

| `.tmux-teams/graph.json` | What happens |
|---|---|
| **absent** | a bundled default declaration (5 teams, 3 workflows) is loaded for the pages, and `graph.mjs check` prints `ok (default)` — so a board can look normal while answering about teams nobody declared. The runner itself will not dispatch on it: the heartbeat is stamped `dispatching: false` with the reason `no team graph declared` (measured 2026-11-10) |
| **present but invalid or unreadable** | fails closed. The runner refuses to dispatch and states the reason in `<repo>/.tmux-teams/runner-heartbeat.json`; the graph page renders the reason instead of a board |

So the danger is not a crash — it is a board that looks completely normal
while answering about teams nobody declared. Run `graph.mjs check` and confirm
the source is your file, not `(default)`, before trusting anything the pages
say.

> correction (2026-11-10): an earlier version of this table said the runner
> "proceeds" on an absent `graph.json`, and a note here said the graph-setup
> skill "overstates" the refusal. The code moved: the bundled default is now a
> shape for the PAGES to draw (`graph.mjs` still comments "Absent — and ONLY
> absent — is what the bundled default is for"), while `loop-runner.mjs`
> refuses to dispatch on it and stamps `dispatching: false, held: null` in
> `runner-heartbeat.json`. The skill text is no longer an overstatement.

Run these commands from the repository root. In an installed plugin, replace
`plugins/tmux-teams/skills/tmux-teams` with the installed skill root.

Admit one request, run a tick, then publish the pages:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/admit.mjs \
  --repo <repo> --work-item token-001 --workflow default \
  --actor human:operator --reason 'what the person asked for'
node plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs <repo> --dry-run
node plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs <repo> --watch=20
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once <repo>
```

`--dry-run` deliberately does not stamp the heartbeat: it is a simulation, and
letting one overwrite a live runner's heartbeat would report a loop that is
not running.

## 2. Talking to it through ACP

This is the most misunderstood part of the plugin.

### 2.1 One dispatch is one ACP session and exactly one prompt

`acp-companion.mjs` spawns each worker over ACP. Per dispatch it sends
`initialize`, then `session/new` (or `session/load` when `ACP_RESUME` names a
prior session), then **exactly one `session/prompt`**, and then waits for the
worker's outbox file.

There is **no channel for a person to type into a running worker session** on
the ordinary dispatch path, which is every route but one. JSON-RPC travels on
the ADAPTER's stdin, which the companion writes to; the companion's own stdin
is read by nothing there.

> correction (2026-11-10): an earlier version of this paragraph said the
> companion's stdin WAS the transport. A review lane read the sentence against
> the two streams and it was wrong; the sentence above is the corrected claim.

The exception, added in v0.33.0, is `ACP_ENABLE_TERMINAL=1` login mode, so a
person can finish an interactive provider login in the terminal the lane runs
in. There the companion DOES read its own stdin and forwards it to the
terminals it opened (`ensureTerminalStdinBridge` in `acp-companion.mjs`). That
is still not a chat with the agent: the keystrokes reach the command the agent
started, never the model. If you have seen this described as a live chat you
can interject into, it is not that. Session continuity exists, but it is
resume-by-id (`ACP_RESUME` + `session/load`, with prior-receipt lineage
checks), not a conversation window.

### 2.2 What ACP actually buys

**Verified model identity.** A skill cannot pin a model — skill frontmatter is
`name` and `description`. An agent can (`model:` frontmatter), but nothing then
verifies the request was honoured, and per-agent reasoning effort is not
expressible at all. ACP does both:

| Variable | Effect |
|---|---|
| `ACP_MODEL`, `ACP_REASONING_EFFORT` | set the session through the standard `session/set_config_option` calls; an unadvertised or rejected value fails closed |
| `ACP_EXPECT_MODEL`, `ACP_EXPECT_REASONING_EFFORT` | make the adapter **acknowledge** its identity; a mismatch fails the dispatch **before any prompt byte** |

When an explicit expectation is omitted, the selected value is also the
expectation. This is the evidence-not-attestation rule turned on the worker:
*asking* for a model is not the same fact as that model answering, and only
one of the two is worth paying for.

**Protocol liveness instead of screen-scraping.** The tmux lane's measured
failure modes are recorded in
[teammates-messaging.md](../skills/tmux-teams/references/teammates-messaging.md)
Part 3: Enter-swallow fired on 3/3 dispatches, and the notify chain produced
zero events for an entire session. ACP replaces guessing from pixels — for
**liveness and progress**, which is what the stall lease and the
`acp-liveness.v1` snapshots are built from.

Note what it does *not* replace: the **completion verdict is the outbox file
on both lanes**. The runner harvests a leg only once `.mailbox-out/<task-id>`
exists, and the terminal state is read from that file's last line — never from
an ACP event. That is deliberate, and it is why the next section matters.

### 2.3 The mailbox/outbox contract

Every ACP brief is prefixed with this, verbatim:

```text
Your task-id is <task-id>. Write your outbox to .mailbox-out/<task-id> — a
single flat FILE (do NOT create it as a directory). Its last line must be
exactly: TEAM_DONE <task-id> (or TEAM_BLOCKED <task-id> / TEAM_FAILED <task-id>).
```

The companion then reads `<repo>/.mailbox-out/<task-id>` and classifies the
**last non-empty line**, which must match exactly:

| Last line | Terminal |
|---|---|
| `TEAM_DONE <task-id>` | `done` |
| `TEAM_BLOCKED <task-id>` | `blocked` |
| `TEAM_FAILED <task-id>` | `failed` |
| anything else | `invalid` |

The file must be a regular file within a bounded size. It is opened with
`O_NOFOLLOW` and `O_NONBLOCK`, so a symlink, a directory, or a FIFO left at
that path is rejected rather than followed or waited on.

> **A worker that prints its answer to the terminal and writes no outbox has
> produced nothing.** The companion fails the dispatch with `no_outbox` —
> *"worker finished the turn but wrote no `<repo>/.mailbox-out/<task-id>`"*.
> This happens with real models, especially cheaper ones given a thin brief:
> they answer correctly, print it, and drop the mechanism. The answer is not
> recoverable by the loop, because the loop deliberately reads artifacts and
> not screens. If this keeps happening, make the brief more explicit about the
> outbox; it is not a transport bug.

The full mailbox PM workflow is available as the command
`/tmux-teams:mailbox-run`.

### 2.4 Where a person actually enters the loop

Not inside an ACP session — at the **ledger**. When a gate cannot answer, it
records `questioned` and the token parks in front of a human; the reply is an
`answered` event, which the validator requires to be written by a `human:`
actor and refuses if no `questioned` precedes it. The runner gives that answer
a deadline (600 s) and the outer controller escalates when it lapses.

**This is a convention, not authentication.** The check is only that the actor
string starts with `human:`. Nothing verifies that a person wrote it. A model
relaying a person's words is expected to sign `human:` and name itself in
`relayed_by`; nothing enforces that either.

## 3. The published pages

One publish writes all three pages side by side into `<repo>/.tmux-teams/`,
linked by one nav:

| Page | Answers |
|---|---|
| `pulse.html` | what is happening right now |
| `graph.html` | who exists and how the loop is wired |
| `kanban.html` | where each work item is stuck |

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs ensure <repo> --interval 20
node plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs check <repo>
```

**`graph.html`** draws every declared agent exactly once inside its team —
including the outer controller, which holds the single worker seat on its own
control team and so is drawn once rather than as a band of its own. It shows
one **scene** at a time:

- **Scene 1, "Every team, drawn once"**, is deliberately still: it animates no
  route at all, because a board where everything is moving cannot also say
  which parts move.
- **Each later scene is one declared workflow.** It animates that route's
  path, and teams the route does not use fade out but keep their place, so a
  team a route SKIPS never reads as a team that is not there. That animation
  is the **declaration** — how work is meant to travel — not a live feed.

Live evidence is a separate layer: a halo on any seat whose ledger status is
`working` or stuck, and a token on the leg that delivered the work a busy team
is holding. That layer is keyed off ledger status and **not** off which scene
is showing, so it appears on any scene where the node is visible.

Nodes bind to evidence by `agent_id` only, so a dispatch must set
`ACP_AGENT_ID` to a declared id to appear. A solid edge means a record exists;
a dashed edge is declared but unobserved. The loop-health strip reads
`runner-heartbeat.json` before presenting the diagram, so an idle loop and a
dead runner do not look the same. A **missing** `graph.json` falls back to the
bundled default declaration (see [§1.8](#18-first-run-and-the-everyday-commands)
for exactly what that does and does not mean); an **invalid** one fails the
page closed with the reason. What the page may draw, and why, is
[loop-graph-page.md](../skills/tmux-teams/references/loop-graph-page.md).

> Known conformance gap, recorded 2026-11-10: without a verified model the
> current `graph.mjs` renderer may print `<requested model> unconfirmed`,
> `default — none pinned`, or `not recorded` instead of the contract's
> `unverified`. Those labels are not verified-model evidence and must not be
> reported as such.

**`kanban.html`** draws one card per token, in the column of the team holding
it, saying what it is waiting on. A token the pull controller refuses to move
(its ledger cannot be believed, its last leg failed, its next team is at its
WIP limit) is drawn as blocked with the reason — a board that draws a stuck
token as an ordinary card is a board disagreeing with the loop it reports on.

All three pages poll only the same-origin `pulse-current.json` bundle marker
while open. They reload only after `snapshot_id` changes, update expiry
visibly even without a new snapshot, preserve scroll/focus/disclosures, and
offer a keyboard-operable pause/resume control. Marker failures are shown as
unavailable; no external request is made. `TEAM_DONE` remains separate from a
recorded verdict: a recorded `pass` does not mean business approval or UAT
acceptance, and a `pass` that conflicts with terminal evidence is highlighted.

## 4. Troubleshooting, full

The [README](../../README.md) carries the top three. Everything else lives
here.

**The worker answered but the loop says it produced nothing.**
It wrote no outbox, or wrote a file whose last line is not an exact terminal
marker. See [§2.3 The mailbox/outbox contract](#23-the-mailboxoutbox-contract).
Check `<repo>/.tmux-teams/runner-logs/<task-id>.log` — every dispatch keeps
its adapter stderr, on purpose.

**A seat declares a non-Claude model or lane and I'm not sure it's honored.**
It is. The automated loop reads each seat's declared `adapter` for which ACP
lane carries the dispatch (`claude`, `codex`, or `agy` — see
[§1.2 Seats](#12-seats)), and reads its declared `model` for both a request
(`ACP_MODEL`) and a verification (`ACP_EXPECT_MODEL`) that the dispatch fails
closed on before any prompt byte if the adapter doesn't answer with that
exact name (see [§2.2](#22-what-acp-actually-buys)). A seat naming neither
inherits its team's default, and a team naming neither dispatches on `claude`
at the account's default model — never a hardcoded pin. Standalone
`acp-companion.mjs` dispatches select the lane and model the same way (see
[§5.1 Transports](#51-transports)).

**The runner is running but nothing dispatches, or a token isn't moving and I
don't know why.** Three refusals at the tick level, each stated rather than
silent:

- an **invalid** `graph.json` — the reason is in `runner-heartbeat.json`. A
  **missing** one is stated too: the heartbeat is stamped `dispatching: false`
  with `no team graph declared`, and the pages draw the bundled default (see
  [§1.8](#18-first-run-and-the-everyday-commands));

  > correction (2026-11-10): this entry previously said a missing
  > `graph.json` "does not refuse; it silently uses the bundled default".
  > Measured on this tree, the runner states the refusal in the heartbeat;
  > only the pages fall back to the default. See [§1.8](#18-first-run-and-the-everyday-commands).

- stale `pulse.json` — the runner logs `STALE` and refuses, because frozen
  evidence is worse than none. Is `pulse.mjs watch` running?
- a receiving team at its WIP limit — logged as `BLOCK`. That is the queue
  working, not a fault.

For a **specific token** that seems stuck, `.tmux-teams/decisions/latest.json`
names why the most recent tick passed over it — `escalate`, `wait` (every
seat it could use is busy), `waiting` (parked on a person), `skip` (nothing
follows its last event), `unreliable-history` (its ledger has a blocking
problem, with the exact line and code), `no-brief`, or `wedged`. It answers
"why is it not moving right now", not "how long has it been stuck" — the file
is overwritten whole every tick, never appended. A tick that never reached the
point of evaluating tokens (an invalid graph, stale `pulse.json`) leaves it
exactly as the last full tick left it, so check `tick_at` before trusting an
empty `decisions` array. A `--dry-run` never writes this file, so a simulation
can't be mistaken for a live tick's refusal.

**A token stopped moving and the log says `INVALID`.** Its ledger does not
validate; every problem is printed with its line number. Repair by
**appending** — the file is not rewritten.

**An installed copy does not have my changes.** The install cache is
version-keyed. Bump the version, push, then run both `claude plugin
marketplace update tmux-teams` AND `claude plugin update
tmux-teams@tmux-teams`, in that order — refreshing the marketplace is what
lets the plugin update see the new version. Editing a checkout, or bumping its
manifest, does not update an installed copy. Authenticate `gh`/git first if
your GitHub setup requires it.

**`node --test tests/` fails with MODULE_NOT_FOUND on Node 24.** Pass no path
at all, or a glob like `tests/*.test.mjs`.

## 5. Reference

### 5.1 Transports

The mailbox contract (brief in → `.mailbox-out/<id>` outbox +
`TEAM_DONE`/`TEAM_BLOCKED`/`TEAM_FAILED` out → PM adversarial verify) is
transport-independent:

| worker | primary | fallback |
|---|---|---|
| codex | ACP — `@agentclientprotocol/codex-acp@1.1.7` (drives the installed CLI; frontier model verified) | tmux |
| claude | ACP — `@agentclientprotocol/claude-agent-acp` (pass `ANTHROPIC_MODEL=claude-opus-5-5`) | tmux |
| agy | ACP — `antigravity-acp@1.2.0` (community adapter, 1.0.0 source-audited 2026-07-21, bumped 2026-09-30; needs `bun`; ToS risk — see the ACP transport lane section of [SKILL.md](../skills/tmux-teams/SKILL.md)) | tmux |

The Gemini worker lane has been removed. The companion rejects that retired
public agent name even when `ACP_CMD` is set, preventing an override from
silently reviving it.

One worker over ACP:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs \
  codex <repo> <task-id> <brief-file> [stall-sec]
```

`acp-dispatch.mjs` detaches the lane into its own process group and returns in
seconds, so the calling shell's timeout is not the lane's deadline; running
`acp-companion.mjs` directly puts it in the foreground, where it is. Ask
`acp-dispatch.mjs status <repo> <task-id>` what happened, or
`wait <repo> <task-id> [max-sec]` to block until the turn ends either way.

The optional duration is an inactivity/stall lease, not a total task timeout;
there is no wall-clock ceiling unless `ACP_HARD_TIMEOUT_SEC>0` is set. ACP
liveness snapshots use the exact `acp-liveness.v1` contract, and Codex defaults
to `INITIAL_AGENT_MODE=agent-full-access` unless the caller supplies an
explicit override of `read-only`, `agent`, or `agent-full-access`; other Codex
modes fail before spawn. Tool records use only the ACP v1 statuses `pending`,
`in_progress`, `completed`, and `failed`, with bounded redacted metadata and
digests. The public liveness projection is capped at `tools` 64,
`active_tools` 8, `stall_history` 32, and 64 KiB of UTF-8 JSON; active tools
are selected first and terminal snapshots compact deterministically before an
atomic write. The terminal `liveness_state` is authoritative: terminal
`active_tools` is always `[]`, while `tools` may retain bounded last-reported
ACP evidence. A successful terminal return requires an atomic liveness
write/readback that agrees with the dispatch state; a write or readback
failure returns nonzero with `liveness_persistence_failed` evidence.
Mechanical terminal evidence keeps cancel ACK, attempted/delivered TERM/KILL,
child exit code/signal, child-settlement signal delivery, and
descendant-only cleanup delivery separate. A clean child exit 0 remains
`cancelled` when only the remaining descendant group needed cleanup;
descendant cleanup never turns that settlement into `stalled`/forced.

Each dispatch also commits one immutable, no-replace
`.tmux-teams/receipts/<dispatch_id>.json` operation receipt, described by
[acp-session-receipt-v1.schema.json](../skills/tmux-teams/references/acp-session-receipt-v1.schema.json),
paired with
[acp-session-receipt-commit-v1.schema.json](../skills/tmux-teams/references/acp-session-receipt-commit-v1.schema.json)
for the commitment envelope written beside it. Note that the tests assert the
schema NAME those files declare and never validate a written receipt against
the documents themselves — the contract is published, not enforced.
The receipt is paired with an immutable
`.tmux-teams/receipt-commits/<dispatch_id>.json` commitment envelope; only a
fresh file-fsync, directory-fsync, no-replace publication, joint readback, and
exact digest check trust the pair. It is committed and read back after the
correlated `session/new` or `session/load` response, observed adapter identity
enforcement, and before any prompt byte. A load is proven only by the exact
correlated JSON-RPC response for the requested session; a response
`sessionId` is not trusted or invented. The receipt records the effective
verified `INITIAL_AGENT_MODE` alongside the raw-byte execution profile
digests, and `initialize_agent_info` is the adapter identity observed in the
correlated initialize response, not the companion's sent client info.
`ACP_SESSION_RECEIPT_REQUIRED=1` requires explicit operation and prior-receipt
lineage inputs, rejects arbitrary `ACP_CMD` overrides, and fails closed before
prompt delivery when the receipt pair cannot be committed. In default mode, an
unavailable receipt is reported with `receipt_digest: none` and the legacy
prompt path continues; required mode never degrades this way.
Required Codex dispatches resolve the locally pinned
`@agentclientprotocol/codex-acp@1.1.7` package, verify its package metadata
and entry bytes, bind the profile to the real Node and `CODEX_PATH` executable
bytes/version, and spawn that verified Node/entry pair. Cache drift, PATH
shadowing, fake version output, profile drift, or an unsafe receipt directory
fails before spawn; the resulting failure is represented by a null-operation
receipt tombstone when publication is possible.

See [SKILL.md](../skills/tmux-teams/SKILL.md) sections 6–8 — "Scaling up:
mailbox pattern", "PM workflow integration", and "ACP transport lane" — for
the contract, the tmux lane, and the ACP lane.

### 5.2 The components, in operating order

| Component | Responsibility |
|---|---|
| `graph.mjs` + `workflow-graph.mjs` | create and validate `.tmux-teams/graph.json`: teams are reusable pools; workflows own routes |
| `ledger-writer.mjs` + `ledger-validate.mjs` | append and judge one custody history per token; invalid history stops movement |
| `pull-controller.mjs` | plan receiver-owned handoffs and enforce WIP; it pulls only reviewed work |
| `loop-runner.mjs` | run one ordered tick: harvest → pull → dispatch → escalate, and stamp the runner heartbeat |
| `acp-companion.mjs` | carry each dispatched leg over ACP; its custody-ledger authority is limited to that leg's `assigned` and `delivered` facts |
| `pulse.mjs` + `graph.mjs` + `kanban.mjs` | publish three projections from the same declaration and evidence |
| `kms.mjs` | keep immutable run-memory events; it is an event store, not a verification gate |

What the front door has learned, read by the controller on every withdrawal:

```bash
node -e "import('plugins/tmux-teams/skills/tmux-teams/scripts/intake-stats.mjs').then(m => console.log(m.intakeStats('<repo>')))"
```

KMS is separate from custody. Append one event file, or recall prior events as
unverified leads:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/kms.mjs append <repo> <event-file|->
node plugins/tmux-teams/skills/tmux-teams/scripts/kms.mjs recall <repo> [terms...] [--worker W] [--limit N]
```

**Shipped in v0.48.0.** Two additions this manual records where they belong:

- **The findings board** (`findings-board.mjs`) — an append-only JSONL board
  with a small CLI (`init` / `append` / `read`): typed entries under two caps,
  three exit codes, and a digest whose exact bytes the brief a worker receives
  is built from. The board is a contract, not a data structure.
- **The AGY quota fallback** (`agy-seat-fallback.mjs`) — measured from the
  2026-10-21 quota death: when the gemini-4 seat hits the provider limit
  (RESOURCE_EXHAUSTED / 429 evidence in the lane's runner log or liveness
  record), the seat falls back to the gemini-3.8 flash seat at the SAME effort
  tier immediately and tells the operator. The codex and claude siblings keep
  their never-downgrade rules; rate-limit evidence is this exception's only
  trigger.

The plugin also ships an MCP server for the operator — lane discovery and
status, plus a live lane-health preflight added by the 2026-08-20 amendment
(see [ADR 0007](adr/0007-the-plugin-ships-an-mcp-server-for-lane-discovery.md)).
It is never a channel into a dispatch: a dispatched agent receives no MCP
server, unconditionally ([ADR 0003](adr/0003-mcp-server-containment-seam.md)).

The `handoff` skill carries a measured size budget
([ADR 0009](adr/0009-handoff-carries-a-size-budget.md)): HANDOFF.md targets
32 KiB with a 48 KiB hard ceiling, a rotation step, and a one-owner-one-block
rule — measured into existence after an eight-lane project's handoff file
regrew past 2 MB because "overwrite, not append" carried no ceiling.

### 5.3 Pulse v4 and the offline bundle

Pulse probes transport liveness and writes `<repo>/.tmux-teams/pulse.json`,
the machine-readable Pulse SSOT. One publish also writes `pulse.html`,
`graph.html`, `kanban.html`, their local assets, and `pulse-current.json`
last. The graph additionally reads the validated workflow declaration and
custody ledgers; the kanban reads those same ledgers through the same
placement rule as the pull controller.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json <repo>
```

`json` publishes and prints the exact persisted Pulse v4 document. Its
contract is the
[Pulse v4 schema](../skills/tmux-teams/references/pulse-v4.schema.json); its
run/verdict definitions retain Pulse v3 compatibility through the
[Pulse v3 compatibility schema](../skills/tmux-teams/references/pulse-v3.schema.json).
It includes snapshot identity/freshness, source diagnostics, run state,
`dispatch_id` correlation, and explicit phase attribution. Pulse is read-only
and reports `trust_level: advisory_same_uid`; suggested action codes are
advisory and are never executed automatically. See
[SKILL.md](../skills/tmux-teams/SKILL.md) section 10, "Pulse and the three
projections".

Pulse v4 is the default and keeps the same single
`<repo>/.tmux-teams/pulse.json` SSOT. It preserves the bounded Pulse v3
run/verdict fields, and their `phase` and `phase_source` attributes are
explicit evidence for the phase flowchart; a missing or untrusted attribution
remains `unassigned` rather than being inferred from a task name, worker,
timestamp, or apparent handoff. Existing v3 documents remain described by
`pulse-v3.schema.json`; v4 adds the optional, closed `delivery_runtime` field
and otherwise references the v3 definitions. The `delivery_loop` and
`delivery_runtime` fields those schemas declare are no longer produced or
accepted: the four-phase pilot that wrote them, and the `--delivery-loop` /
`--delivery-runtime` flags that read them, were removed on 2026-08-02. The
schemas keep the definitions so an on-disk snapshot written before that date
still validates and still upgrades.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs compat-v1 <repo>
```

`compat-v1` writes a v1 down-projection to stdout only; it does not create a
second persisted snapshot.

The canonical offline bundle contains `<repo>/.tmux-teams/pulse.json`,
`pulse.html`, `graph.html`, `kanban.html`, and their sibling
`pulse-fonts-<sha256>.css` and `pulse-refresh-<sha256>.js`. The stylesheet
contains the bundled Kanit WOFF2 data URLs. `graph.html` draws its board from
a JSON block in the page with a small inline script — pan, wheel-zoom and one
scene per workflow; the other pages are plain document flow. No charting
library is vendored or loaded. The shared assets are atomically published
before the JSON and HTML pages and are not rewritten when their content is
unchanged. No view loads a remote asset; while served, the refresh script
polls only same-origin siblings. Keep every named sibling together for offline
bundle identity. `<repo>/.tmux-teams/pulse-current.json` is the bundle commit
marker written last. It names and hashes the JSON, every HTML page, the font
stylesheet and the refresh script; readers can reject a mixed/partial publish
by validating those hashes and re-reading the marker after the files.

Human-visible absolute timestamps default to `Asia/Bangkok`. The page shows
the timezone once in its top-right header — for the default zone it renders
the Thai label `เวลาไทย (UTC+7)` ("Thai time, UTC+7") — instead of repeating
it beside every timestamp. Configure another IANA zone for one command or a
watcher with `--time-zone`, or set `PULSE_TIME_ZONE`:

```bash
PULSE_TIME_ZONE=America/New_York \
  node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs ensure <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once \
  <repo> --time-zone UTC
```

The CLI flag takes precedence over the environment. An explicit invalid zone
fails with exit 2, and changing the zone of a running watcher requires
stopping that watcher first. Pulse Data v4 continues to publish machine
timestamps as RFC 3339 UTC; display timezone configuration never changes the
JSON contract.

An earlier four-phase delivery pilot and its governed Phase Gate — the two
projections' only producers — shipped alongside this loop; both were withdrawn
on 2026-08-02, together with their commands and their documentation. What
ships here is teams and workflows.

### 5.4 The party-mode review gate

party-mode's 3-model review uses its bundled JavaScript ACP gate
(`plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs`), not
`oc`/AGY/Codex review plugins or MCP review tools. It no longer requires
`/usr/bin/bwrap`: [ADR 0006](adr/0006-the-review-gate-stops-declaring-bwrap.md)
removed `osSandbox: 'bwrap'` from every shipped profile in 2026-08-13, and its
2026-08-24 amendment removed the machinery itself. There is no OS sandbox and
no way to switch one back on; the gate runs on macOS and Linux alike. What it
still checks never came from bwrap. It also needs the supported ACP reviewer
runtimes: `antigravity-acp@1.2.0` + trusted `agy`, Qwen/Zai through the pinned
Claude ACP adapter, and the Codex ACP adapter. `claude-zai` and `claude-qwen`
must both use the pinned `@agentclientprotocol/claude-agent-acp` adapter with
their machine-local profile settings. Zai must use the explicit official
`https://api.z.ai/api/anthropic` settings route. AGY plus exactly two valid,
distinct reviewers are mandatory, and unsupported primary routes fail closed.
While the direct Claude provider is limited, the policy never launches it:
`claude-zai` resolves to the pinned Zai GLM-5.2 ACP profile and is accepted
only when it does not duplicate a reviewer/model or match the primary family.

Run the gate from a trusted workflow with the target repository as a separate,
runner-owned absolute argument; never take it from the untrusted packet:

```bash
node plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs \
  <static-packet.json> "$PWD" > <review-report.json>
```

Each reviewer gets a fresh temporary workspace, an ephemeral provider HOME, no
MCP servers or built-in tools, denied ACP permission requests, and no mount of
the target repository or host user-data roots. The provider network remains
shared so its remote API can be reached; adapter auth is available inside its
ephemeral same-process HOME and the provider may retain remote state. Model
evidence means the pinned ACP model was configured and acknowledged, not
cryptographic proof of the remote serving model. AGY may report a completed
read only for copied provider-runtime documentation under its isolated
`builtin/` tree; target, arbitrary, search, fetch, edit, and execute calls
remain blocked.

## 6. Update lifecycle (this repository is canonical — flipped 2026-07-21)

Skill content lives in `plugins/tmux-teams/skills/` — edit it directly.
`~/agent-skills` vendors this repository as the submodule `plugins/tmux-teams`,
has deleted its standalone copies of the bundled skills, and uses the
submodule as the source for its OpenClaw bridge. Codex and Claude load their
own version-keyed plugin caches.

1. Edit the skill under `plugins/tmux-teams/skills/` and commit here.
2. Bump the version in **six files, seven places**:
   `.claude-plugin/marketplace.json` (twice — `metadata.version` and
   `plugins[0].version`), `plugins/tmux-teams/.claude-plugin/plugin.json`,
   `plugins/tmux-teams/plugin.json` (the vendor-neutral Agent Plugins
   manifest), `RELEASE_VERSION` in `tests/plugin-structure.test.mjs`, the
   `Current release:` line in `README.md`, and the `Current release:` line in
   `ROADMAP.md`. That test is what checks they agree, so it has to state the
   number itself — **grep for the old number after every bump**.

   > correction (2026-11-10): earlier versions of this list said "five files,
   > six places" and omitted `ROADMAP.md`; the story of the half-bump that
   > proved it is in [§8](#8-corrections-record). `ROADMAP.md` is guarded by a
   > test now, so the count and the suite agree.
3. For the repository-only development tier, run `node scripts/run-fast.mjs fast`.
   The release gate remains bare `node --test`; then run `git diff --check` and
   the local-only `claude plugin validate --strict .` release gate.
4. Push, then `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (the install cache is
   version-keyed — both steps, in that order).
5. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills`.

GitHub Actions runs `node --test` plus `git diff --check` with no repository
secrets on Node 20 and Node 24. Strict plugin validation remains a local
release gate because the Claude CLI is not provisioned in CI. Pass no path:
`node --test tests/` fails on Node 24.

Note: `~/.claude/skills` no longer carries these skills (they are
plugin-delivered; `agent-skills/scripts/sync.sh` purges them from the tool
skill roots since the 2026-07-21 flip).

### Tracked files

Only release and plugin files are tracked — the policy list lives in
`CLAUDE.md`: `.github/`, `.claude-plugin/`, `.gitignore`, `plugins/`,
`tests/`, `scripts/`, `README.md`, and `CLAUDE.md`, plus the tracked root
documents (`ROADMAP.md`, `RELEASE-PLAN.md`, `HANDOFF.md`) and the
`agent-plugins/` view described next.

### Distribution: the two roots (ADR 0008)

`plugins/tmux-teams/` is what Claude Code installs, and its layout does NOT
conform to the Agent Plugins 1.0 section-8 namespace rule — moving
`.claude-plugin/` and `.mcp.json` under a namespace would make the plugin
uninstallable in Claude Code, whose binary contains no `agent-plugins.org`
string at all ([ADR 0008](adr/0008-agent-plugins-1-0-conformance-stops-at-the-layout.md)).
So a second, conformant root exists beside it: `agent-plugins/tmux-teams/`,
whose entries are SYMLINKS into this repository (a copy would be 69 files that
drift), with the client-specific material under
`agent-plugins/tmux-teams/com.anthropic.claude/` for the Claude-compatible
client. The links resolve only from a full checkout; anyone who needs a
directory they can carry asks `scripts/portable-root.mjs` to materialise one.

## 7. Glossary

One line each.

- **ACP** — Agent Client Protocol; the JSON-RPC protocol over which every
  dispatch is carried (`initialize`, `session/new`, exactly one
  `session/prompt`).
- **Seat** — one named role inside a team: a dispatcher (intake), a worker
  (does the work), or an evaluator (judges the team's own output). Seats may
  override `model`, `adapter`, `effort`, and `display_model`.
- **Lane** — one ACP transport to a model family: `claude`, `codex`, or `agy`.
- **Ledger** — the append-only JSONL custody history of one token; repaired by
  appending, never by rewriting.
- **Tick** — one ordered pass of `loop-runner.mjs`: harvest → pull → dispatch
  → escalate.
- **WIP** — work-in-progress limit; always equal to a team's worker count, and
  a team at its limit is left visibly blocked.
- **Mailbox/outbox** — the completion contract: the brief tells a worker to
  write `.mailbox-out/<task-id>` whose last line is an exact terminal marker
  (`TEAM_DONE` / `TEAM_BLOCKED` / `TEAM_FAILED`); the loop reads the file,
  never the screen.
- **Receipt** — the immutable, no-replace `.tmux-teams/receipts/<dispatch_id>.json`
  operation record committed before any prompt byte, paired with a commitment
  envelope.
- **Graph** — the declaration layer, `.tmux-teams/graph.json`: teams as
  reusable pools of seats, workflows as routes over them.
- **Findings board** — the append-only JSONL board (`findings-board.mjs`)
  whose typed entries and digest feed the brief a worker receives.
- **Advisory / attestation** — an advisory claim (Pulse's `advisory_same_uid`,
  a suggested action code, a model request) is reported, never executed or
  trusted as proof; attestation is what an agent says about itself, which this
  plugin deliberately does not accept as evidence.

## 8. Corrections record

Dated corrections carried out of the old README. Each entry names the section
that now carries the corrected claim; entries marked "historical" have no
living normative content.

- **correction (2026-11-10) — absent `graph.json` and dispatch.** The old
  first-run table said the runner "proceeds" on an absent `graph.json`
  ("measured on an empty repo"), and a note said the graph-setup skill
  overstates the refusal. Both described an older code state. Measured
  2026-11-10: the pages draw the bundled default and `graph.mjs check` prints
  `ok (default)`, while `loop-runner.mjs` refuses to dispatch and stamps
  `dispatching: false` / `held: null` with `no team graph declared`. Carried
  into [§1.8](#18-first-run-and-the-everyday-commands).
- **correction (2026-11-10) — "not enforced yet" fragment.** A paragraph about
  cross-team backwards moves ended with "That is not enforced yet", directly
  contradicting the paragraph above it recording the 2026-08-03 enforcement.
  The contract is the authority; the fragment is retired. Carried into
  [§1.3](#13-flow-is-one-way).
- **correction (2026-11-10) — the companion's stdin.** The ACP section once
  said the companion's own stdin WAS the transport; a review lane read the
  sentence against the two streams and it was wrong. Carried into
  [§2.1](#21-one-dispatch-is-one-acp-session-and-exactly-one-prompt).
- **correction (2026-11-10) — "Both advisors".** The old skills section said
  "Both advisors" while a third was shipping in the same release — how a
  reader comes to believe a seat does not exist. Historical: the skills
  inventory now lives in the README, which names all four advisor seats.
- **correction (2026-11-10) — the version-location count.** The update
  lifecycle once said "five files, six places" and omitted `ROADMAP.md` while
  `CLAUDE.md` said six and seven. A lane copied the checkout, bumped exactly
  the five files named there, and the suite passed 21/21 with `ROADMAP.md`
  still on the old version — a half-bump a reader following that file would
  have shipped. `ROADMAP.md` is guarded by a test now; the test is what made
  the disagreement survivable, not the prose. (The same paragraph had earlier
  said "all three" while `CLAUDE.md` said five — the fourth time a version
  location was found by a reader rather than by the process.) The corrected
  list is in [§6](#6-update-lifecycle-this-repository-is-canonical--flipped-2026-07-21).
- **correction (2026-08-24) — bwrap.** `/usr/bin/bwrap` is not used at all:
  [ADR 0006](adr/0006-the-review-gate-stops-declaring-bwrap.md) removed
  `osSandbox: 'bwrap'` from every shipped profile on 2026-08-13 and its
  amendment removed the machinery itself. Carried into
  [§5.4](#54-the-party-mode-review-gate).
- **historical — the four-phase delivery pilot.** The pilot and its Phase
  Gate, once the two projections' only producers, were withdrawn 2026-08-02
  with their commands and documentation; the schemas keep their definitions so
  older snapshots still validate. Noted in
  [§5.3](#53-pulse-v4-and-the-offline-bundle).
- **historical — the Gemini worker lane.** Removed; the companion rejects the
  retired public agent name even when `ACP_CMD` is set. Stated in
  [§5.1](#51-transports); the README and SKILL.md carry the same sentence.
