# Loop System Contract

**Status:** authoritative. This document is the single source of truth for the
delivery loop and the page that draws it.

If the code and this document disagree, one of them is a bug. Say which, in
writing, before changing either. Do not "fix" the document to match code that
was never reviewed against it, and do not change behaviour without amending
this file in the same commit.

## 0. Scope

**Governed by this contract**

| File | Owns |
| --- | --- |
| `scripts/workflow-graph.mjs` | the declaration: teams, workflows, validation |
| `scripts/dispatch-facts.mjs` | reading the ledger, and the single placement rule |
| `scripts/pull-controller.mjs` | pull, WIP enforcement, route completion |
| `scripts/loop-runner.mjs` | the state machine, dispatch, harvest, escalation |
| `scripts/role-briefs.mjs` | what each role is told, and verdict parsing |
| `scripts/graph-loop.mjs` | the loop graph page |
| `.tmux-teams/team-graph.json` | the declaration artifact |
| `.tmux-teams/work-items/<token>.jsonl` | the custody ledger |
| `.tmux-teams/work-items/<token>.md` | the token's own request |
| `.tmux-teams/graph-loop.html` | the published page |

**Not governed here.** `phase-gate-*` and `delivery-loop-*` implement a
separate, opt-in four-phase governed runtime; its terms (Phase Team, Delivery
Slice) are a different model and must not be conflated with this one.
`pulse.json` is a frozen schema owned by `references/pulse-v4.schema.json`; this
loop reads it and never adds fields to it.

## 1. Model

- A **Team** is a reusable resource pool: one **dispatcher** that owns intake,
  one or more **workers** that run in parallel, one **evaluator** that judges
  the team's own output. A team carries no routing.
- A **Workflow** is a route composed from existing teams. The same team may
  appear in as many workflows as need it.
- A **work item token** is the unit of work. It carries its own request and
  accumulates its own history.
- A route **never revisits a team**. Work moves backwards only by rejection.
- There is exactly one **outer controller** for the whole graph. It is not a
  member of any team and never does a team's work.

## 2. Two layers, never mixed

| Layer | Artifact | Nature |
| --- | --- | --- |
| DECLARATION | `team-graph.json` | assigned by a human, never observed |
| EVIDENCE | `work-items/*.jsonl`, `pulse.json` | recorded by the system, never assumed |

Team membership, role and WIP limit are declaration. Whether an agent ran, what
it produced and how long it took are evidence.

**The page may draw a declared thing that has no evidence — and must say so.**
An agent that has never run says so; it never shows a zero that reads like a
measurement.

## 3. Declaration contract — `team-graph.json`

```json
{
  "project_id": "<GRAPH_ID>",
  "outer_controller_id": "<AGENT_ID>",
  "teams": [{
    "team_id": "<GRAPH_ID>", "name": "<1..160 chars>",
    "dispatcher_id": "<AGENT_ID>", "worker_ids": ["<AGENT_ID>", "..."],
    "evaluator_id": "<AGENT_ID>", "wip_limit": 1
  }],
  "workflows": [{ "workflow_id": "<GRAPH_ID>", "name": "...", "route": ["<team_id>", "..."] }]
}
```

`AGENT_ID` = `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$` ·
`GRAPH_ID` = `^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$` ·
`name` = 1–160 characters, no control characters.

Bounds: 1–100 teams, 1–100 workers per team, 1–50 workflows, `wip_limit` an
integer 1–100 (defaults to the worker count).

**Rejected, with the reason it is rejected:**

| Input | Why it fails |
| --- | --- |
| `downstream_team_id` on a team | routing belongs to a workflow route, not a team |
| a route listing the same team twice | work returns by rejection, not by routing |
| an `agent_id` used twice anywhere | one agent, one seat — a shared id lights two nodes from one dispatch |
| a route naming an unknown team | a route may only compose declared teams |
| any missing or malformed field above | the graph fails **closed**; it never silently falls back |

A repo with no `team-graph.json` at all uses the bundled default graph. A repo
with an **invalid** one renders an error and dispatches nothing.

## 4. Custody ledger contract

One token, one file, append-only, one JSON object per line. Corrections are
appended. Nothing is ever rewritten, and no component may edit a prior line.

Common fields on every event: `at` (ISO 8601 UTC), `event`, `work_item`,
`workflow`.

| Event | Written by | Also carries | Means |
| --- | --- | --- | --- |
| `pulled` | pull-controller | `agent_id` = receiving dispatcher, `from_team`, `to_team` | the receiving team took the work |
| `intake` | runner (harvest) | `agent_id` = dispatcher, `verdict: accept`, `reason` | the team accepted the handoff |
| `returned` | runner (harvest) | `to_team` = sender, `refused_by`, `reason`, **no `agent_id`** | the handoff was refused and went back |
| `assigned` | acp-companion | `agent_id`, `task_id`, `dispatch_id` | one leg started |
| `delivered` | acp-companion | `agent_id`, `task_id`, `terminal`, `timed_out`, `evidence_present` | one leg finished |
| `reviewed` | runner (harvest) | `agent_id` = evaluator, `verdict`, `reviewed_task`, `reason` | the team judged its own output |
| `lost` | runner | `agent_id`, `task_id`, `reason` | an assignment whose process is gone and which recorded nothing |
| `escalated` | runner | `agent_id` = controller, `to_team`, `task_id`, `reason` | parked with the outer controller |
| `resumed` | runner (harvest) | `agent_id` = controller, `to_team`, `grant`, `reason` | the controller sent it back with a fresh budget |
| `completed` | pull-controller | `from_team` | the route finished |
| `abandoned` | runner (harvest) or a human | `reason` | nobody will finish this token |

Rules:

1. `returned` carries **no `agent_id`** on purpose. The token is held by the
   team it went back to, not by the dispatcher that refused it.
2. `escalated` **must** carry `to_team`. The controller is not a team member, so
   without it the token cannot be placed and the board would draw parked work as
   unplaceable while freeing a WIP slot nobody released.
3. A malformed line is skipped, counted, and the count is surfaced on the page.
   Partial evidence beats none as long as nothing is invented.
4. Events are ordered by `at`; equal timestamps keep append order.
5. At most 1 MiB is read per token and 5000 files per directory.

## 5. State machine

One token, keyed on its last event and the role of the actor.

| Last event | Condition | Next |
| --- | --- | --- |
| `pulled` | — | dispatch the **dispatcher** (intake) |
| `intake` | — | dispatch a **worker** |
| `returned` | — | dispatch a **worker** (rework) |
| `resumed` | — | dispatch a **worker** (rework, budget reset) |
| `assigned` | actor is running | in flight, do nothing |
| `assigned` | no live process, older than `ZOMBIE_SEC` | append `lost` |
| `delivered` | terminal is not `done` | retry the **same role** |
| `delivered` | `done`, actor is a worker | dispatch the **evaluator** |
| `delivered` | `done`, actor is a dispatcher | harvest → `intake` or `returned` |
| `delivered` | `done`, actor is the evaluator | harvest → `reviewed` |
| `reviewed` | `pass` | release to the pull controller |
| `reviewed` | `reject` | dispatch a **worker** of the same team |
| `reviewed` | `unresolved` | escalate |
| `escalated` | controller outbox exists | harvest → `resumed` or `abandoned` |
| `escalated` | no answer yet | held; the runner does not move it |
| `completed`, `abandoned` | — | terminal; the token holds nothing |

**Ordering within a tick is fixed:** harvest → pulls → dispatch → escalation.
Harvesting after pulling would let the controller evaluate a stale event, and
pulling before a review lands is what made the evaluator decorative.

## 6. Occupancy — the single placement rule

`dispatch-facts.teamOccupancy()` is the **only** function permitted to answer
"which team is holding this token". Any second implementation is a defect: two
readers computing it separately is how a board came to draw a limit that was not
being enforced.

- A team holds a token from the moment it pulls it until the route closes.
- `RELEASING_EVENTS = {completed, abandoned}`. Everything else holds.
- Placement: `teamOf(last.agent_id)` if the actor is a declared team member,
  otherwise `last.to_team`, otherwise the token is an **orphan** and is surfaced,
  never dropped.
- The rule is a **release list, not a whitelist**: an event nobody taught this
  function about leaves the work where it is rather than making it disappear.

## 7. Pull system

- Work is **pulled, never pushed**. A team takes work only when it has room.
- The only pullable state is `reviewed` with `verdict: pass`. A worker
  finishing is not the team finishing.
- Oldest accepted delivery first. Serving the newest arrival starves whatever
  waited longest.
- The destination team's occupancy is checked before each pull and incremented
  on each accepted pull, so one pass can never overfill a team.
- A blocked token stays visibly blocked. A queue backing up is the signal the
  board exists to show.
- No next team on the route → `completed`.

## 8. Quality gates

Two layers, both mandatory.

| Gate | Who | Verdicts | Rejection goes |
| --- | --- | --- | --- |
| intake (between teams) | receiving dispatcher | `accept` \| `reject` | back to the sending team |
| review (inside a team) | that team's evaluator | `pass` \| `reject` \| `unresolved` | back to that team's own workers |
| outer (exceptions) | outer controller | `resume` \| `abandon` | back to the parked team, or closed |

Parsing rules, non-negotiable:

1. A verdict is read only from a line matching `^VERDICT: <word>$`, and the
   **last** such line wins. Briefs print the format as literal text and agents
   restate it before answering; reading the first match turns a restatement into
   the decision.
2. A missing or unrecognised verdict is `unresolved`. **Silence is never
   approval.**
3. For the outer controller, an unstated verdict appends **nothing** — silence is
   not permission to close someone's work, and a no-op event would make the
   runner re-read the same outbox forever.
4. The runner never invents a verdict. Every verdict in the ledger was stated by
   the agent whose job it was to state it.

## 9. Outer controller

- **Anomaly-triggered only.** Never on a heartbeat: a timer that dispatches a
  full agent every interval bills for looking at a board that has not changed.
- Triggers: a spent retry budget, an unresolved review, a leg ceiling reached,
  or a token that cannot be placed.
- Two brakes, both required: a **time cooldown** (`PM_COOLDOWN_SEC`) and an
  **unchanged-trigger** check against the last note. Time alone is no brake on a
  permanent condition.
- It is dispatched **about the board**, not about a token: its brief carries the
  trigger list and the whole board, and its dispatch carries no work item.
- `resume` returns the token to its team and grants a fresh attempt budget.
  Attempts made before the controller looked do not count, or resume would
  re-escalate on the very next tick.
- `abandon` closes the token honestly. It is the only mechanised writer of
  `abandoned`.

## 10. Budgets and ceilings

| Ceiling | Value | Scope | On hit |
| --- | --- | --- | --- |
| `MAX_ATTEMPTS` | 3 | one role's pool, in one team, since the last resume | escalate |
| `MAX_LEGS` | 15 + granted | the whole token, all roles | escalate |
| `RESUME_GRANT` | 3 | added per `resumed` event, clamped | raises the leg ceiling |
| `MAX_IN_FLIGHT` | 4 | declared agents running across the whole board | wait |
| `wip_limit` | declared | tokens held by one team | wait / block the pull |
| `ZOMBIE_SEC` | 180 s | an `assigned` with no live process | append `lost` |
| `PULSE_STALE_SEC` | 120 s | evidence age | refuse to dispatch |
| `PM_COOLDOWN_SEC` | 900 s | between controller dispatches | hold |

Every ceiling must be **visible when it is hit**. A runner that logs only the
happy path looks identical to one that has silently given up.

## 11. Liveness dependency

`pulse.json` is the only evidence that an agent is still running.

- **Missing** snapshot = a repo where nothing has ever run. Dispatch is allowed,
  with a note.
- **Present but stale** (older than `PULSE_STALE_SEC`, or undated) = the watcher
  that writes it has stopped. All dispatch is refused, loudly. Frozen evidence
  either stalls the loop forever on an agent that already exited or, past the
  zombie window, declares a running agent lost and pays to run it twice.

## 12. The loop graph page

### 12.1 Purpose and boundary

The page answers **"who exists and how is this wired"**. It must **not** answer
"where is the work right now" — that is the kanban board's question, and merging
the two has been rejected. It may show what a team is holding as a WIP fact; it
may not become a board.

### 12.2 Bands, in this order

1. **Teams** — the whole pool drawn once, with every declared agent as exactly
   one node, no matter how many workflows use its team.
2. **Workflows** — a plain horizontal team-level strip per workflow. No agents
   here.

### 12.3 Every node states the same five facts

| Line | Content | When unknown |
| --- | --- | --- |
| 1 | agent id | — |
| 2 | `ROLE · lane · transport` | `—` |
| 3 | `model <verified model>` | `unverified`, never a guess |
| 4 | what this agent has **done**, from the ledger | `nothing recorded yet` |
| 5 | a measured clock | `not started` |

Line 4 by role: dispatcher `N accepted · M returned` · worker
`N delivered · M failed` · evaluator `N pass · M reject` · outer controller
`N escalation(s) handled`.

**The outer controller is a node like any other** and states all five. It was
once hand-drawn as a banner, and every fact line added later silently skipped
it.

**Lane and model are two separate facts.** The lane is the adapter that carried
the dispatch; the model is reported only once verified. Never substitute one for
the other.

### 12.4 Status

Encoded three ways, always together: **border colour + a corner dot + a full
sentence in the tooltip**. Colour alone fails greyscale printing and
colour-blind readers; the tooltip is where the wording stays honest when the box
has no room.

### 12.5 Edges

Meaning is carried by **colour**, never by text on the arrow — a label on every
arrow turned the graph into noise. The legend states each colour once.

| Colour | Edge |
| --- | --- |
| blue | dispatcher assigns to a worker |
| green | worker delivers to the evaluator |
| red | rework: the evaluator rejects back into the team |
| purple | handoff between teams on a route |
| grey-violet | the outer controller's oversight rail |

**Solid means observed; dashed means declared.** An edge hardens only when
recorded evidence exists for it. Oversight is always dashed: it is an operating
model, not something the system can watch happening.

### 12.6 Layout laws

These are standing requirements. Each one was a defect first.

1. Teams are laid out **vertically** — the whole pool must be readable without
   scrolling.
2. Within a team: dispatcher on top, workers **in parallel**, evaluator at the
   bottom. Workers side by side read as a relay and contradict the WIP limit.
3. Each worker fans out from the dispatcher and back to the evaluator
   independently. Nothing connects one worker to another.
4. The outer controller links from the **centre**, with a rail that spans
   **every** team including the first.
5. The rework arrow runs up the **right** side, with enough gutter that the line
   visibly re-enters the node rather than showing a bare arrowhead.
6. The workflow band sits **below** the team band, never interleaved.
7. The diagram fills the viewport width and is never pinned to a pixel size.
8. No text on any edge.
9. No text touches a node's border.
10. Wide content scrolls inside its own container; the page body never scrolls
    sideways.
11. Copy is **English** — these pages get shared outside the team.
12. The page declares `<meta charset="utf-8">` as its first line and escapes
    every id, name and agent-authored reason.

### 12.7 Honesty laws

1. Never print a number that was not measured. Unmeasured says so.
2. Never show a model that was not verified.
3. Unreadable ledger lines and unplaceable tokens are surfaced, never hidden.
4. The page and the controller must never disagree about occupancy — both read
   the same function (§6).
5. Counters come from the ledger, which is the runner's own record, so a broken
   verdict-to-snapshot chain cannot make reviewing look like it never happened.
6. Auto-refresh is real and pausable; the page states its own freshness.

## 13. Prohibitions

- No component may rewrite a ledger line.
- No component may add a field to `pulse.json`.
- No second implementation of the occupancy rule.
- No agent may be dispatched without a brief.
- No verdict may be inferred from prose.
- The page must never dispatch, pull, or mutate anything.

## 14. Acceptance criteria

Every clause below is enforced by a test in `tests/loop-occupancy.test.mjs` or
`tests/graph-loop.test.mjs`. A clause with no test is not enforced and must be
marked as such here.

| # | Clause | Assertion |
| --- | --- | --- |
| AC1 | §5 | every declared role has a ledger state that dispatches it |
| AC2 | §7 | a delivered artifact goes to its own evaluator, never straight onward |
| AC3 | §8 | a rejected review returns to the same team, not the next one |
| AC4 | §8 | an evaluator that states no verdict yields `unresolved`, not a pass |
| AC5 | §8 | the last verdict line wins, not the first mentioned |
| AC6 | §4, §6 | a refused handoff is placed with the sending team |
| AC7 | §6 | a finished token is done, not unplaceable |
| AC8 | §6 | a failed leg still occupies the team that must rerun it |
| AC9 | §6 | the board and the controller agree about a team holding a failed leg |
| AC10 | §9 | a parked token is still held by its team |
| AC11 | §9 | the controller's `resume` restores the work with a fresh budget |
| AC12 | §9 | the controller's `abandon` closes it and frees the team |
| AC13 | §9 | a controller that answers nothing changes nothing |
| AC14 | §9 | a permanent problem does not re-dispatch the controller every cooldown |
| AC15 | §10 | the runner never puts more work in a team than its WIP limit allows |
| AC16 | §11 | a frozen pulse snapshot stops the runner dispatching |
| AC17 | §3 | an invalid graph fails closed; a control character in a name is rejected |
| AC18 | §12.3 | every role states the work it actually did, from the ledger |
| AC19 | §12.3 | the outer controller states the same facts as every other agent |
| AC20 | §12.3 | a node states status, lane and model separately, and never fakes a model |
| AC21 | §12.4 | status is readable without colour: a dot plus a text tooltip |
| AC22 | §12.5 | arrows carry meaning by colour, with no text on any edge |
| AC23 | §12.5 | an edge only hardens once evidence exists for it |
| AC24 | §12.6 | the controller's rail spans every team, including the first |
| AC25 | §12.6 | the graph fills the viewport and is never pinned to a pixel size |
| AC26 | §12.6 | hostile names stay escaped and the page declares utf-8 |
| AC27 | §12.2 | a team shared by two workflows is drawn once, with every agent |
| AC28 | §12.7 | the published page does not accuse a finished token of being unplaceable |
| AC29 | §12.7 | the published page can actually load the refresh script it names |
| AC30 | §10 | a lost leg is recorded, not left occupying its team forever |
| AC31 | §10 | the board as a whole has a dispatch ceiling, not only each team |
| AC32 | §10 | a token cannot exceed its leg ceiling unless the controller grants more |

### 14.1 Clauses this contract does NOT yet enforce

Declared here rather than left to be discovered. Each is a rule the code follows
today with nothing stopping it from regressing.

| Clause | Rule with no test |
| --- | --- |
| §4.3 | a malformed ledger line is skipped, counted, and the count reaches the page |
| §4.4 | equal timestamps keep append order |
| §5 | the tick order is harvest → pulls → dispatch → escalation |
| §12.7.6 | auto-refresh is pausable and the page states its own freshness — only the asset's existence and parseability are tested |
| §13 | the prohibitions are review rules, not runtime behaviour; they are enforced by reading a diff |

## 15. Change control

1. A change to behaviour amends this document **in the same commit**.
2. A clause added here without a test is marked unenforced until one exists.
3. When code and this contract disagree, state which is wrong before editing
   either. A contract quietly edited to match unreviewed code is not a contract.
4. One writer per file per batch. The loop is itself a writer in this repository;
   editing a file while a worker holds it has already cost one overwrite.
