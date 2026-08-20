# tmux-teams — Claude Code plugin

A multi-team delivery loop for agent work, and a published board that reports
what actually happened. Teams are declared once by a person; a unit of work
then moves between them as an append-only custody ledger, and every page is
drawn from that ledger rather than from what an agent said about itself. The
founding rule is **evidence over attestation**: a worker that finishes without
writing its outbox has produced nothing, a team at its WIP limit is left
visibly blocked instead of being pushed past, and a declaration that cannot be
read fails the page closed with the reason rather than falling back to a guess.

New here? Read this file top to bottom, then
[how-it-works.md](plugins/tmux-teams/skills/tmux-teams/references/how-it-works.md)
for the diagrams.

Current release: **0.33.0** (`.claude-plugin/marketplace.json` and
`plugins/tmux-teams/.claude-plugin/plugin.json`). Upgrading from an earlier
0.14.x release needs no change to an existing `graph.json` — the seat fields
in ข้อ 2 (`adapter`, `effort`, `display_model`) and the files in ข้อ 6 are all
optional and additive.

---

## 1. Install

```bash
claude plugin marketplace add iicmaster/tmux-teams
claude plugin install tmux-teams@tmux-teams
```

After a new release is pushed, update in two steps:

```bash
claude plugin marketplace update tmux-teams
claude plugin update tmux-teams@tmux-teams
```

Both steps are needed because **the install cache is version-keyed**. Editing a
checkout, or bumping its manifest, does not update an installed copy; the
marketplace must be refreshed before the plugin update can see a new version.
Authenticate `gh`/git first if your GitHub setup requires it.

### Prerequisites

| Need | For |
|---|---|
| Node 20+ with `npx` | the ACP adapters. CI exercises Node 20 and Node 24 |
| `tmux` and the `codex` CLI | the tmux worker lane |
| `bun` | the `agy` ACP adapter (`bunx antigravity-acp@1.0.0`) |
| `/usr/bin/bwrap` (Linux) | only for a profile that declares `osSandbox: 'bwrap'` — no shipped profile does since ADR 0006, so the gate runs on macOS and Linux without it |

### First run

Nothing dispatches until this repository has declared its own loop. Use the
bundled `graph-setup` skill, which interviews you until nothing is blank, or run
the commands directly. `graph.mjs init` expects the state directory to exist:

```bash
mkdir -p -- <repo>/.tmux-teams
node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs init <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs check <repo>
```

Edit the generated team and model values, then re-run `check`.

Two different failures, and the difference bites newcomers:

| `.tmux-teams/graph.json` | What happens |
|---|---|
| **absent** | a bundled default declaration (5 teams, 3 workflows) is used. `graph.mjs check` prints `ok (default)` and the runner proceeds — measured on an empty repo |
| **present but invalid or unreadable** | fails closed. The runner refuses to dispatch and states the reason in `<repo>/.tmux-teams/runner-heartbeat.json`; the graph page renders the reason instead of a board |

So the danger is not a crash — it is a board that looks completely normal while
answering about teams nobody declared. Run `graph.mjs check` and confirm the
source is your file, not `(default)`, before trusting anything the pages say.

> The `graph-setup` skill states that with no valid `graph.json` the runner
> refuses to dispatch. That holds for an invalid file, not an absent one. The
> code's fallback is deliberate and commented (`graph.mjs`: "Absent — and ONLY
> absent — is what the bundled default is for"); the skill text overstates it.

Run these commands from this repository's root. In an installed plugin, replace
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
letting one overwrite a live runner's heartbeat would report a loop that is not
running.

---

## 2. How work moves

### Two layers that must never be conflated

| Layer | File | Answers |
|---|---|---|
| **Declaration** | `.tmux-teams/graph.json` | who exists and how they are wired |
| **Evidence** | `.tmux-teams/work-items/<token>.jsonl`, `pulse.json`, `.tmux-teams/runner-heartbeat.json` | what actually happened, including whether the runner itself is responding |

A declaration is assigned by a human and never observed. Evidence is recorded
and never assumed. Every page keeps the two apart.

### Seats

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
and still enforced — ข้อ 1 of the contract keeps the refusal ceiling — it is
just the seat's secondary duty now.

That routing is expressed per seat, not just per team. Any dispatcher,
worker, or evaluator entry in `graph.json` may override its team's default
`model`, `adapter` (which ACP lane — `claude`, `codex`, or `agy` — carries the
dispatch) and `effort`, in any combination. A seat may also declare
`display_model`: a name shown on `graph.html`'s board, which can differ from
the alias actually sent over the wire — the board can say `opus` while the
dispatch sends whatever model string the adapter accepts. See ข้อ 3 below for
how a requested model is verified, not just asked for.

**A seat may name several models, in order — the palette (new in 0.15.0).**
Instead of a single `model`/`adapter`/`effort`/`display_model`, a seat may
declare `palette`: an ordered array of up to eight whole seat specs. It is the
answer to "this model is rate-limited right now" happening at 3am with nobody
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

**Flow is one way.** Work moves forward along a route and never runs back up
it. An evaluator that finds a problem does not return the work to the team that
produced it — it brings the work to a state it can pass and forwards it, and
the token carries on to the controller. A controller that is not satisfied does
not send the token back either: it starts a new flow. Rework is a new token on a
fresh route, never the same token moving upstream.

**The rule is about crossing teams**, and two things that look backwards are
not. A dispatcher refusing a token at the door checks it BEFORE it enters, so
nothing came back out — **three times at most per door**, after which that
dispatcher escalates to the controller instead of refusing again, because a
fourth refusal is two seats disagreeing with nobody deciding. And a team's own
evaluator may loop work back to a worker of that same team as often as the work
needs — that loop is why a team has its own evaluator. Neither crosses a
boundary.

What the rule forbids is a token crossing a team boundary in the direction it
came from: once a team releases work, that team is behind it. Since 2026-08-03
that is **refused, not merely written down** — the ledger validator rejects a
`pulled` naming a team that already admitted the token, and because every
append is validated through the sanctioned writer, the line never lands. A team
that refused at the door never admitted anything, so it may still pull the work
later; that is the difference the check is built around.

The worked example. A QA evaluator reading its own worker's report finds two
different things. The worker did not finish the checklist — send it back to that
worker and have it done properly; same team, allowed. The worker found a real
bug — QA fixes it from the report and carries on; it does not go back to the Dev
team that produced it, because Dev is behind this token now.
 That is **not
enforced yet** — treat a cross-team backwards move you see today as something
the system has not been taught to refuse.

A **workflow** is a route composed over teams. `controller_team` is likewise
derived, not declared: it is the head of every route, and a workflow whose
route starts anywhere else is rejected. That control team's single worker seat
is the `outer_controller_id`, so **the control team's WIP is 1 and every route
starts there**. One request waiting on a person stops every new request
entering — a queue, not a rejection, and deliberate. See
[controller-as-team.md](plugins/tmux-teams/skills/tmux-teams/references/controller-as-team.md).

`admit.mjs` is the only writer that enforces the front door's WIP limit;
`ledger-writer.mjs` cannot, because it judges one event against one ledger and
never reads the graph. Refused while the controller is holding its one token:

```text
REFUSED  controller_full: control is holding 1 of 1 — a new request is not
admitted while the front door is full. The person may send it again once the
queue moves.
```

### Handover is a pull, never a push

`pull-controller.mjs` never hands work to a team. It only lets a team **take**
work it has room for. One pass over the token ledgers decides, per token:

| Situation | Decision |
|---|---|
| last event is `reviewed` `pass` (a delivery team's evaluator accepted it) | eligible to move |
| last event is `intake` `accept` on the control team | eligible to move — admission is the claim, there is no artifact yet |
| last leg `delivered` with a non-`done` terminal | `failed` — a rerun, not a handoff |
| the ledger does not validate | `invalid` — every problem printed, nothing appended |
| next team is under its WIP limit | `pulled`, signed by the **receiving** dispatcher |
| next team is at its WIP limit | `blocked`, with the count, and the token stays put |
| no next team on the route | `completed` |

Oldest delivery first, so nothing that has waited longest is starved. A worker
finishing is not the team finishing: until that team's evaluator has passed it,
the artifact has been typed, not checked.

### The tick

`loop-runner.mjs` runs one ordered tick — **harvest → pull → dispatch →
escalate**. Harvest runs first so the pull controller never reads a stale event.
Every decision is logged, including the unhappy ones, because a runner that logs
only the happy path looks identical to one that has silently given up.

Verdicts are read from a `VERDICT:` line, **last match wins** (an agent
restating the format before writing its real answer is ordinary), and silence is
never approval.

The direct `pull-controller.mjs` command is an operator dry run. Let the runner
apply pulls so the tick order stays intact:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs <repo>
```

### The custody ledger

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

`plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md` is the
SSOT for all of the above. Its ข้อ 14.1 carries a standing list of clauses the
contract asserts that **no test enforces** — including the tick order itself —
declared there rather than left to be discovered.

---

## 3. How you talk to it, and why that goes through ACP

This is the most misunderstood part of the plugin.

### One dispatch is one ACP session and exactly one prompt

`acp-companion.mjs` spawns each worker over ACP. Per dispatch it sends
`initialize`, then `session/new` (or `session/load` when `ACP_RESUME` names a
prior session), then **exactly one `session/prompt`**, and then waits for the
worker's outbox file.

There is **no channel for a person to type into a running worker session**. The
companion's stdin is the JSON-RPC transport to the adapter, not a human input
path. If you have seen this described as a live chat you can interject into, it
is not that. Session continuity exists, but it is resume-by-id (`ACP_RESUME` +
`session/load`, with prior-receipt lineage checks), not a conversation window.

### So what does ACP actually buy?

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
*asking* for a model is not the same fact as that model answering, and only one
of the two is worth paying for.

**Protocol liveness instead of screen-scraping.** The tmux lane's measured
failure modes are recorded in
`plugins/tmux-teams/skills/tmux-teams/references/teammates-messaging.md` Part 3:
Enter-swallow fired on 3/3 dispatches, and the notify chain produced zero events
for an entire session. ACP replaces guessing from pixels — for **liveness and
progress**, which is what the stall lease and the `acp-liveness.v1` snapshots are
built from.

Note what it does *not* replace: the **completion verdict is the outbox file on
both lanes**. The runner harvests a leg only once `.mailbox-out/<task-id>`
exists, and the terminal state is read from that file's last line — never from
an ACP event. That is deliberate, and it is why the next section matters.

### The mailbox/outbox contract

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
`O_NOFOLLOW` and `O_NONBLOCK`, so a symlink, a directory, or a FIFO left at that
path is rejected rather than followed or waited on.

> **A worker that prints its answer to the terminal and writes no outbox has
> produced nothing.** The companion fails the dispatch with `no_outbox` —
> *"worker finished the turn but wrote no `<repo>/.mailbox-out/<task-id>`"*. This
> happens with real models, especially cheaper ones given a thin brief: they
> answer correctly, print it, and drop the mechanism. The answer is not
> recoverable by the loop, because the loop deliberately reads artifacts and not
> screens. If this keeps happening, make the brief more explicit about the
> outbox; it is not a transport bug.

The full mailbox PM workflow is available as the command
`/tmux-teams:mailbox-run`.

### Where a person actually enters the loop

Not inside an ACP session — at the **ledger**. When a gate cannot answer, it
records `questioned` and the token parks in front of a human; the reply is an
`answered` event, which the validator requires to be written by a `human:`
actor and refuses if no `questioned` precedes it. The runner gives that answer a
deadline (600 s) and the outer controller escalates when it lapses.

**This is a convention, not authentication.** The check is only that the actor
string starts with `human:`. Nothing verifies that a person wrote it. A model
relaying a person's words is expected to sign `human:` and name itself in
`relayed_by`; nothing enforces that either.

---

## 4. The eleven skills

**Setting up and running the loop**

| Skill | Reach for it when |
|---|---|
| `tmux-teams:graph-setup` | first run, or the declaration is missing/rejected — interviews until `graph.json` is complete, then validates it |
| `tmux-teams:tmux-teams` | you are the PM: dispatch, completion detection, capture, the mailbox contract, the delivery loop |
| `tmux-teams:codex-tmux-driver` | driving a live Codex TUI — its flags, calibrated markers, and dialog behavior |

**Getting work done carefully**

| Skill | Reach for it when |
|---|---|
| `tmux-teams:party-mode` | the umbrella: routes a request to one of the two lanes below |
| `tmux-teams:party-auto` | executing multi-file or production-impacting work — planning, critique, file ownership, grill gate, verification, 3-model review |
| `tmux-teams:party-advise` | advice, plan critique, tradeoff or risk review — read-only, never edits |
| `tmux-teams:sqthink` | structured step-by-step analysis, comparison, or planning before deciding |

**Getting a second opinion**

| Skill | Reach for it when |
|---|---|
| `tmux-teams:claude-advisor` | you want Claude's strongest model — pinned to `claude-fable-5`, model identity verified via `ACP_EXPECT_MODEL` |
| `tmux-teams:codex-advisor` | you want a read from outside the Claude family — pinned to `gpt-5.6-sol` at `ultra` |

Both advisors return a round-table rather than a single voice, and both are
read-only. Ask both on a hard call: where they disagree is the finding.

**Closing out a session**

| Skill | Reach for it when |
|---|---|
| `tmux-teams:handoff` | ending a session and the next reader is another AI agent, not a person — writes `HANDOFF.md` at the project root through a `party-mode` round-table. Run it with `/tmux-teams:handoff`. |

---

## 5. The published pages

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
control team and so is drawn once rather than as a band of its own. It shows one
**scene** at a time:

- **Scene 1, "Every team, drawn once"**, is deliberately still: it animates no
  route at all, because a board where everything is moving cannot also say which
  parts move.
- **Each later scene is one declared workflow.** It animates that route's path,
  and teams the route does not use fade out but keep their place, so a team a
  route SKIPS never reads as a team that is not there. That animation is the
  **declaration** — how work is meant to travel — not a live feed.

Live evidence is a separate layer: a halo on any seat whose ledger status is
`working` or stuck, and a token on the leg that delivered the work a busy team
is holding. That layer is keyed off ledger status and **not** off which scene is
showing, so it appears on any scene where the node is visible.

Nodes bind to evidence by `agent_id` only, so a dispatch must set `ACP_AGENT_ID`
to a declared id to appear. A solid edge means a record exists; a dashed edge is
declared but unobserved. The loop-health strip reads `runner-heartbeat.json`
before presenting the diagram, so an idle loop and a dead runner do not look the
same. A **missing** `graph.json` falls back to the bundled default declaration
(see ข้อ 1); an **invalid** one fails the page closed with the reason. What the
page may draw, and why, is
`plugins/tmux-teams/skills/tmux-teams/references/loop-graph-page.md`.

> Known conformance gap: without a verified model the current `graph.mjs`
> renderer may print `<requested model> unconfirmed`, `default — none pinned`,
> or `not recorded` instead of the contract's `unverified`. Those labels are not
> verified-model evidence and must not be reported as such.

**`kanban.html`** draws one card per token, in the column of the team holding
it, saying what it is waiting on. A token the pull controller refuses to move
(its ledger cannot be believed, its last leg failed, its next team is at its WIP
limit) is drawn as blocked with the reason — a board that draws a stuck token as
an ordinary card is a board disagreeing with the loop it reports on.

All three pages poll only the same-origin `pulse-current.json` bundle marker
while open. They reload only after `snapshot_id` changes, update expiry visibly
even without a new snapshot, preserve scroll/focus/disclosures, and offer a
keyboard-operable pause/resume control. Marker failures are shown as
unavailable; no external request is made. `TEAM_DONE` remains separate from a
recorded verdict: a recorded `pass` does not mean business approval or UAT
acceptance, and a `pass` that conflicts with terminal evidence is highlighted.

---

## 6. Troubleshooting

**The worker answered but the loop says it produced nothing.**
It wrote no outbox, or wrote a file whose last line is not an exact terminal
marker. See ข้อ 3. Check `<repo>/.tmux-teams/runner-logs/<task-id>.log` — every
dispatch keeps its adapter stderr, on purpose.

**A seat declares a non-Claude model or lane and I'm not sure it's honored.**
It is. The automated loop reads each seat's declared `adapter` for which ACP
lane carries the dispatch (`claude`, `codex`, or `agy` — ข้อ 2 above), and reads
its declared `model` for both a request (`ACP_MODEL`) and a verification
(`ACP_EXPECT_MODEL`) that the dispatch fails closed on before any prompt byte
if the adapter doesn't answer with that exact name (ข้อ 3). A seat naming
neither inherits its team's default, and a team naming neither dispatches on
`claude` at the account's default model — never a hardcoded pin. Standalone
`acp-companion.mjs` dispatches select the lane and model the same way (see
Transports).

**The runner is running but nothing dispatches, or a token isn't moving and I
don't know why.** Three refusals at the tick level, each stated rather than
silent:
- an **invalid** `graph.json` — the reason is in `runner-heartbeat.json`. A
  **missing** one does not refuse; it silently uses the bundled default (ข้อ 1);
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
is overwritten whole every tick, never appended. A tick that never reached
the point of evaluating tokens (an invalid graph, stale `pulse.json`) leaves
it exactly as the last full tick left it, so check `tick_at` before trusting
an empty `decisions` array. A `--dry-run` never writes this file, so a
simulation can't be mistaken for a live tick's refusal.

**A token stopped moving and the log says `INVALID`.** Its ledger does not
validate; every problem is printed with its line number. Repair by **appending**
— the file is not rewritten.

**An installed copy does not have my changes.** The install cache is
version-keyed. Bump the version, push, then run both `marketplace update` and
`plugin update` (ข้อ 1).

**`node --test tests/` fails with MODULE_NOT_FOUND on Node 24.** Pass no path at
all, or a glob like `tests/*.test.mjs`.

---

## 7. Reference

### Transports

The mailbox contract (brief in → `.mailbox-out/<id>` outbox +
`TEAM_DONE`/`TEAM_BLOCKED`/`TEAM_FAILED` out → PM adversarial verify) is
transport-independent:

| worker | primary | fallback |
|---|---|---|
| codex | ACP — `@agentclientprotocol/codex-acp@1.1.7` (drives the installed CLI; frontier model verified) | tmux |
| claude | ACP — `@agentclientprotocol/claude-agent-acp` (pass `ANTHROPIC_MODEL=claude-opus-4-8`) | tmux |
| agy | ACP — `antigravity-acp@1.0.0` (community adapter, source-audited 2026-07-21; needs `bun`; ToS risk — SKILL.md ข้อ 8) | tmux |

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
to `INITIAL_AGENT_MODE=agent-full-access` unless the caller supplies an explicit
override of `read-only`, `agent`, or `agent-full-access`; other Codex modes fail
before spawn. Tool records use only the ACP v1 statuses `pending`, `in_progress`,
`completed`, and `failed`, with bounded redacted metadata and digests. The
public liveness projection is capped at `tools` 64, `active_tools` 8,
`stall_history` 32, and 64 KiB of UTF-8 JSON; active tools are selected first
and terminal snapshots compact deterministically before an atomic write. The
terminal `liveness_state` is authoritative: terminal `active_tools` is always
`[]`, while `tools` may retain bounded last-reported ACP evidence. A successful
terminal return requires an atomic liveness write/readback that agrees with
the dispatch state; a write or readback failure returns nonzero with
`liveness_persistence_failed` evidence. Mechanical terminal evidence keeps
cancel ACK, attempted/delivered TERM/KILL, child exit code/signal, child-settlement
signal delivery, and descendant-only cleanup delivery separate. A clean child
exit 0 remains `cancelled` when only the remaining descendant group needed
cleanup; descendant cleanup never turns that settlement into `stalled`/forced.

Each dispatch also commits one immutable, no-replace
`.tmux-teams/receipts/<dispatch_id>.json` operation receipt, described by
`plugins/tmux-teams/skills/tmux-teams/references/acp-session-receipt-v1.schema.json`,
paired with
`plugins/tmux-teams/skills/tmux-teams/references/acp-session-receipt-commit-v1.schema.json`
for the commitment envelope written beside it. Note that the tests assert the
schema NAME those files declare and never validate a written receipt against the
documents themselves — the contract is published, not enforced.
The receipt is paired with an immutable
`.tmux-teams/receipt-commits/<dispatch_id>.json` commitment envelope; only a
fresh file-fsync, directory-fsync, no-replace publication, joint readback, and
exact digest check trust the pair. It is committed and read back after the
correlated `session/new` or `session/load` response, observed adapter identity
enforcement, and before any prompt byte. A load is
proven only by the exact correlated JSON-RPC response for the requested session;
a response `sessionId` is not trusted or invented. The receipt records the
effective verified `INITIAL_AGENT_MODE` alongside the raw-byte execution
profile digests, and `initialize_agent_info` is the adapter identity observed
in the correlated initialize response, not the companion's sent client info.
`ACP_SESSION_RECEIPT_REQUIRED=1` requires explicit operation and prior-receipt
lineage inputs, rejects arbitrary `ACP_CMD` overrides, and fails closed before
prompt delivery when the receipt pair cannot be committed. In default mode, an
unavailable receipt is reported with `receipt_digest: none` and the legacy
prompt path continues; required mode never degrades this way.
Required Codex dispatches resolve the locally pinned
`@agentclientprotocol/codex-acp@1.1.7` package, verify its package metadata and
entry bytes, bind the profile to the real Node and `CODEX_PATH` executable
bytes/version, and spawn that verified Node/entry pair. Cache drift, PATH
shadowing, fake version output, profile drift, or an unsafe receipt directory
fails before spawn; the resulting failure is represented by a null-operation
receipt tombstone when publication is possible.

See `plugins/tmux-teams/skills/tmux-teams/SKILL.md` ข้อ 6-ข้อ 8 for the contract,
tmux lane, and ACP lane.

### The components, in operating order

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

### Pulse v4 and the offline bundle

Pulse probes transport liveness and writes `<repo>/.tmux-teams/pulse.json`, the
machine-readable Pulse SSOT. One publish also writes `pulse.html`, `graph.html`,
`kanban.html`, their local assets, and `pulse-current.json` last. The graph
additionally reads the validated workflow declaration and custody ledgers; the
kanban reads those same ledgers through the same placement rule as the pull
controller.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json <repo>
```

`json` publishes and prints the exact persisted Pulse v4 document. Its contract
is
[Pulse v4 schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v4.schema.json);
its run/verdict definitions retain Pulse v3 compatibility through
[Pulse v3 compatibility schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v3.schema.json).
It includes snapshot identity/freshness, source diagnostics, run state,
`dispatch_id` correlation, and explicit phase attribution. Pulse is read-only
and reports `trust_level: advisory_same_uid`; suggested action codes are
advisory and are never executed automatically. See
`plugins/tmux-teams/skills/tmux-teams/SKILL.md` ข้อ 10.

Pulse v4 is the default and keeps the same single
`<repo>/.tmux-teams/pulse.json` SSOT. It preserves the bounded Pulse v3
run/verdict fields, and their `phase` and `phase_source` attributes are explicit
evidence for the phase flowchart; a missing or untrusted attribution remains
unassigned rather than being inferred from a task name, worker, timestamp, or
apparent handoff. Existing v3 documents remain described by
`pulse-v3.schema.json`; v4 adds the optional, closed `delivery_runtime` field
and otherwise references the v3 definitions. The `delivery_loop` and `delivery_runtime` fields those schemas declare are no
longer produced or accepted: the four-phase pilot that wrote them, and the
`--delivery-loop` / `--delivery-runtime` flags that read them, were removed on
2026-08-02. The schemas keep the definitions so an on-disk snapshot written
before that date still validates and still upgrades.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs compat-v1 <repo>
```

`compat-v1` writes a v1 down-projection to stdout only; it does not create a
second persisted snapshot.

The canonical offline bundle contains `<repo>/.tmux-teams/pulse.json`,
`pulse.html`, `graph.html`, `kanban.html`, and their sibling
`pulse-fonts-<sha256>.css` and `pulse-refresh-<sha256>.js`. The stylesheet
contains the bundled Kanit WOFF2 data URLs. `graph.html` draws its board from a
JSON block in the page with a small inline script — pan, wheel-zoom and one
scene per workflow; the other pages are plain document flow. No charting library
is vendored or loaded. The shared assets are atomically published before the
JSON and HTML pages and are not rewritten when their content is unchanged. No
view loads a remote asset; while served, the refresh script polls only
same-origin siblings. Keep every named sibling together for offline bundle
identity. `<repo>/.tmux-teams/pulse-current.json` is the bundle commit marker
written last. It names and hashes the JSON, every HTML page, the font stylesheet
and the refresh script; readers can reject a mixed/partial publish by validating
those hashes and re-reading the marker after the files.

Human-visible absolute timestamps default to `Asia/Bangkok`. The page shows the
timezone once in its top-right header (`เวลาไทย (UTC+7)` for the default)
instead of repeating it beside every timestamp. Configure another IANA zone for
one command or a watcher with `--time-zone`, or set `PULSE_TIME_ZONE`:

```bash
PULSE_TIME_ZONE=America/New_York \
  node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs ensure <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once \
  <repo> --time-zone UTC
```

The CLI flag takes precedence over the environment. An explicit invalid zone
fails with exit 2, and changing the zone of a running watcher requires stopping
that watcher first. Pulse Data v4 continues to publish machine timestamps as
RFC 3339 UTC; display timezone configuration never changes the JSON contract.

An earlier four-phase delivery pilot and its governed Phase Gate — the two
projections' only producers — shipped alongside this loop; both were withdrawn
on 2026-08-02, together with their commands and their documentation. What ships
here is teams and workflows.

### The party-mode review gate

party-mode's 3-model review uses its bundled JavaScript ACP gate
(`plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs`), not `oc`/AGY/
Codex review plugins or MCP review tools. It no longer requires
`/usr/bin/bwrap`: ADR 0006 removed `osSandbox: 'bwrap'` from every shipped
profile, so the gate runs on macOS and Linux alike. The machinery is retained
and still tested — a profile that declares the field gets the full sandbox — and
this line claimed the opposite until a lane read it against ROADMAP.md and
CLAUDE.md, which had both been updated. It also needs the supported ACP reviewer runtimes:
`antigravity-acp@1.0.0` + trusted `agy`, Qwen/Zai through the pinned
Claude ACP adapter, and the Codex ACP adapter. `claude-zai` and `claude-qwen` must both use the
pinned `@agentclientprotocol/claude-agent-acp` adapter with their machine-local
profile settings. Zai must use the explicit official
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

Each reviewer gets a fresh temporary workspace, an ephemeral provider HOME,
no MCP servers or built-in tools, denied ACP permission requests, and no mount
of the target repository or host user-data roots. The provider network remains
shared so its remote API can be reached; adapter auth is available inside its
ephemeral same-process HOME and the provider may retain remote state. Model
evidence means the pinned ACP model was configured and acknowledged, not
cryptographic proof of the remote serving model. AGY may report a completed
read only for copied provider-runtime documentation under its isolated
`builtin/` tree; target, arbitrary, search, fetch, edit, and execute calls
remain blocked.

---

## 8. Update lifecycle (this repo IS canonical — flipped 2026-07-21)

Skill content lives here, in `plugins/tmux-teams/skills/` — edit it directly.
`~/agent-skills` vendors this repo as the submodule `plugins/tmux-teams`, has
deleted its standalone copies of the bundled skills, and uses the submodule as
the source for its OpenClaw bridge. Codex and Claude load their own
version-keyed plugin caches.

1. Edit the skill under `plugins/tmux-teams/skills/` and commit here.
2. Bump the version in **six files, seven places**:
   `.claude-plugin/marketplace.json` (twice — `metadata.version` and
   `plugins[0].version`), `plugins/tmux-teams/.claude-plugin/plugin.json`,
   `plugins/tmux-teams/plugin.json` (the vendor-neutral Agent Plugins manifest),
   `RELEASE_VERSION` in `tests/plugin-structure.test.mjs`, the
   `Current release:` line above, and the `Current release:` line in
   `ROADMAP.md`. That test is what checks they agree, so it has to state the
   number itself — and this list has been wrong at every count so far, so
   **grep for the old number after every bump**.

   This paragraph said "five files, six places" and omitted ROADMAP.md while
   CLAUDE.md said six and seven. A lane copied the checkout, bumped exactly the
   five files named here, and the suite passed 21/21 with ROADMAP.md still on
   the old version — a half-bump that a reader following this file would have
   shipped. ROADMAP.md is guarded now, so the count and the test agree; note
   that the test is what made the disagreement survivable, not the prose.
   This paragraph said "all three" while CLAUDE.md said five; a release reviewer
   found the contradiction, which is the fourth time a version location was
   found by a reader rather than by the process.
3. For the repository-only development tier, run `node scripts/run-fast.mjs fast`.
   The release gate remains bare `node --test`; then run `git diff --check` and
   the local-only `claude plugin validate --strict .` release gate.
4. Push, then `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
5. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills`.

GitHub Actions runs `node --test` plus `git diff --check` with no repository
secrets on Node 20 and Node 24. Strict plugin validation remains a local release
gate because the Claude CLI is not provisioned in CI. Pass no path:
`node --test tests/` fails on Node 24.

Note: `~/.claude/skills` no longer carries these skills (they are
plugin-delivered; `agent-skills/scripts/sync.sh` purges them from the tool
skill roots since the 2026-07-21 flip).

### Tracked files

Only release and plugin files are tracked: `.github/`, `.claude-plugin/`,
`.gitignore`, `plugins/`, `tests/`, `scripts/`, `README.md`, and `CLAUDE.md`.
