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
| `scripts/workflow-graph.mjs` | the declaration: teams, workflows, models, validation |
| `scripts/dispatch-facts.mjs` | reading the ledger, and the single placement rule |
| `scripts/pull-controller.mjs` | pull, WIP enforcement, route completion |
| `scripts/loop-runner.mjs` | the state machine, dispatch, harvest, escalation, the heartbeat |
| `scripts/ledger-validate.mjs` | whether a custody ledger can be believed |
| `scripts/ledger-writer.mjs` | the only sanctioned way a line enters a ledger |
| `scripts/role-briefs.mjs` | what each role is told, and verdict parsing |
| `scripts/graph.mjs` | the loop graph page |
| `.tmux-teams/graph.json` | the declaration artifact |
| `.tmux-teams/work-items/<token>.jsonl` | the custody ledger |
| `.tmux-teams/work-items/<token>.md` | the token's own request |
| `.tmux-teams/runner-heartbeat.json` | the runner's statement about itself |
| `.tmux-teams/graph.html` | the published page |

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
- There is exactly one **outer controller** for the whole graph. It never does a
  team's work. Since §14.5 it holds the single worker seat of its own **control
  team** — the same seat `outer_controller_id` names, not a second one — which
  is what gives the front door a WIP limit of 1. It is still not a member of any
  DELIVERY team, and no route may revisit it.

## 2. Two layers, never mixed

| Layer | Artifact | Nature |
| --- | --- | --- |
| DECLARATION | `graph.json` | assigned by a human, never observed |
| EVIDENCE | `work-items/*.jsonl`, `pulse.json`, `runner-heartbeat.json` | recorded by the system, never assumed |

Team membership, role and **the model each seat is meant to run on** are
declaration. Whether an agent ran, what it produced, how long it took and
**which model actually answered** are evidence.

**A team's WIP limit is neither.** It is *derived*: it always equals that team's
worker count, so there is no second number that can disagree with the first.
See §3.

**Declared model and verified model are two different facts and are never
substituted for each other.** The declaration says which model a seat was
*asked* for; only the adapter's own acknowledgement says which model *answered*.
The page prints the second and never the first (§12.3, §12.7.2).

**The page may draw a declared thing that has no evidence — and must say so.**
An agent that has never run says so; it never shows a zero that reads like a
measurement.

## 3. Declaration contract — `graph.json`

```json
{
  "project_id": "<GRAPH_ID>",
  "outer_controller_id": "<AGENT_ID>",
  "outer_controller_model": "<MODEL>",
  "teams": [{
    "team_id": "<GRAPH_ID>", "name": "<1..160 chars>",
    "dispatcher_id": "<AGENT_ID>", "worker_ids": ["<AGENT_ID>", "..."],
    "evaluator_id": "<AGENT_ID>",
    "models": { "dispatcher": "<MODEL>", "worker": "<MODEL>", "evaluator": "<MODEL>" }
  }],
  "workflows": [{ "workflow_id": "<GRAPH_ID>", "name": "...", "route": ["<team_id>", "..."] }]
}
```

`AGENT_ID` = `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$` ·
`GRAPH_ID` = `^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$` ·
`name` = 1–160 characters, no control characters ·
`MODEL` = 1–128 characters, no control characters.

Bounds: 1–100 teams, 1–100 workers per team, 1–50 workflows.

### 3.1 `wip_limit` is derived, never declared

A team's WIP limit **always equals its worker count**. It is not an input.

A worker may spawn its own sub-agents, so parallelism already happens inside a
worker; a second number allowed to disagree with the first is a defect waiting
to happen, and a board that draws a limit nobody is enforcing is worse than a
board with no limit on it. An older graph that still states the *same* number
keeps loading and the number is ignored. One that states a *different* number is
**rejected**, naming both numbers — silently overruling it would make the loop
enforce a limit nobody wrote down.

Raising a team's WIP limit therefore means giving it another worker, and that is
the only way to raise it.

### 3.2 Every seat names its model

Each team names a model for its `dispatcher`, its `worker` and its `evaluator`,
and the graph names one for the outer controller. All four are **required**
whenever the seat exists; a graph that declares no `outer_controller_id` needs no
`outer_controller_model`.

Only the **shape** of the name is checked: 1–128 characters, no control
characters. The **value is never validated against a list of known models,
anywhere in this system.** The adapter is the only authority on what a model
name may say, and a hardcoded list here would go stale and start refusing names
that work. The cost of that choice is stated plainly: an invented name passes
this checker and fails later, at dispatch, when the adapter is asked to
acknowledge it.

The declared name is passed to the adapter as a **request the dispatch will be
held to**: `acp-companion` starts the session's `identity_status` at `missing`
and rejects the receipt unless the adapter answers with exactly that name. The
one sentinel value `inherit-account-default` therefore requests **nothing** and
leaves the account default in place; it is a blank, not an answer, and the
bundled template uses it precisely because no real model belongs in a template.

**Rejected, with the reason it is rejected:**

| Input | Why it fails |
| --- | --- |
| `downstream_team_id` on a team | routing belongs to a workflow route, not a team |
| a route listing the same team twice | work returns by rejection, not by routing |
| an `agent_id` used twice anywhere | one agent, one seat — a shared id lights two nodes from one dispatch |
| a route naming an unknown team | a route may only compose declared teams |
| a `wip_limit` that differs from the worker count | the limit is derived (§3.1); the graph would draw one number and enforce another |
| a missing or malformed model on any declared seat | a dispatch with no model named runs on whatever the account defaults to — the guess this declaration exists to stop |
| any missing or malformed field above | the graph fails **closed**; it never silently falls back |

A repo with no `graph.json` at all uses the bundled default graph. A repo
with an **invalid** one renders an error and dispatches nothing.

### 3.3 The declaration was renamed, and the old name is still read

`graph.json` was `team-graph.json` until 2026-07-29, renamed alongside the skill
that writes it (`team-loop-setup` → `graph-setup`) so the declaration, the
module and the page all carry one word.

`readWorkflowGraph` tries `graph.json`, then `team-graph.json`, then the bundled
default, and reports **which file answered** in `source`. The legacy read is not
courtesy. A missing declaration falls back to the bundled four-team template, so
a bare rename would have left every existing repo drawing teams nobody declared
— no error, no diagnostic, and a page that looks entirely correct. That is the
worst failure shape this contract exists to prevent: not a wrong answer that
announces itself, but a confident one about somebody else's project.

The new name wins when both files exist, so a repo mid-migration is never
shadowed by the file it is migrating away from.

The `--team-graph` flag on `pulse.mjs` keeps its name. It points at a file by
path rather than by convention, and renaming a flag breaks callers' scripts for
no gain.

## 4. Custody ledger contract

One token, one file, append-only, one JSON object per line. Corrections are
appended. Nothing is ever rewritten, and no component may edit a prior line.

Common fields on every event: `at` (ISO 8601 UTC), `event`, `work_item`,
`workflow`, and — on every line written since the writer existed — `actor`.

| Event | Written by | Also carries | Means |
| --- | --- | --- | --- |
| `opened` | whoever admits the work (§4.6) | `agent_id` = receiving dispatcher, `to_team`, `reason`; **never** `from_team` | work entered the graph; legal only as a token's first event |
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
| `audit_requested` | runner | `agent_id` = controller, `task_id`, `reason` | a finished route flagged for a whole-delivery read |
| `audited` | runner (harvest) | `agent_id` = controller, `verdict`, `reason` | the controller read the delivery |
| `abandoned` | runner (harvest) or a human | `reason` | nobody will finish this token |

Rules:

1. `returned` carries **no `agent_id`** on purpose. The token is held by the
   team it went back to, not by the dispatcher that refused it.
2. `escalated` **must** carry `to_team`. The controller is not a team member, so
   without it the token cannot be placed and the board would draw parked work as
   unplaceable while freeing a WIP slot nobody released.
3. A malformed line is skipped, counted, and the count is surfaced on the page.
   Partial evidence beats none as long as nothing is invented.
4. Events are ordered by `at`; equal timestamps keep append order. A stamp
   strictly earlier than the line above it is an impossible past and is refused.
5. At most 1 MiB is read per token and 5000 files per directory.

### 4.1 Every line names who wrote it — `actor`

`actor` is `agent:<id>` or `human:<id>`. The kind is a closed vocabulary,
because the whole point of recording it is that a hand-typed line stays visibly
a hand-typed line forever.

This exists because it was missing. Two `abandoned` events in this repository
were typed into a ledger by an assistant, and they are **structurally and
sequentially legal** — no validator can tell them apart from lines the runner
wrote, and the board, the pull controller and the outer controller all read them
as machine evidence. Only a recorded actor can distinguish them.

The actor is the component that **performed the write**, never the agent the
line is about. A `pulled` made for a receiving dispatcher is signed
`agent:pull-controller` and carries that dispatcher in `agent_id`; signing it as
the dispatcher would claim a write that agent never performed. A harvested
verdict is signed by the agent whose outbox stated it. An event the runner
decided by itself — `lost`, a stall — is signed by the runner.

Lines written before this rule existed carry no `actor`. Requiring one of them
would condemn every legitimately runner-written line in history, so the
validator **shape-checks `actor` only when it is present** while the writer
**refuses to write without one**.

### 4.2 The sanctioned writer — `ledger-writer.mjs`

Every line that enters a custody ledger goes through `appendEvent`. It is the
only sanctioned writer, and it:

- refuses an event with no valid `actor`, before anything else is looked at;
- checks the event against the per-event field table above;
- checks it against the ledger it is joining, so an event that would make the
  token's history impossible is refused rather than recorded;
- refuses outright to append to a ledger that was **already invalid** —
  appending to a broken history buries the break instead of surfacing it;
- validates `work_item` before it is used as a filename, so a token id cannot
  escape the work-items directory;
- writes one pre-serialised line per call, at 0600 inside a 0700 directory.

It never rewrites. A refused write **did not happen**, and no caller may report
it as having happened.

### 4.3 Validated at both boundaries

The ledger is checked on the way **in** and on the way **out**, by the same
validator, because the two answer different questions:

| Boundary | Who | Refusing means |
| --- | --- | --- |
| write | `ledger-writer.appendEvent` | this line would make the history impossible, or the history already is |
| read, before dispatch | `loop-runner.tick` | do not write fresh evidence on top of evidence that cannot be believed |
| read, before handoff | `pull-controller.planPulls` | do not hand the next team a history that describes something impossible |

Plan and apply must answer to the **same predicate**. A planner using a laxer
rule would keep emitting a handoff the writer can never record, and the loop
would print the same move every tick while nothing moved — indistinguishable
from a runner that has quietly given up.

### 4.6 How work enters the graph — `opened`

A `pulled` is a team **taking** work from another team. The first team on a
route has nobody to take it from, so intake cannot be spelled as a pull without
either omitting `from_team` — which the validator refuses — or naming a sender
that does not exist, which it cannot catch. Both forms were on disk before this
event existed.

`opened` says the true thing instead: work arrived, here is where, here is why.
It carries `agent_id` (the receiving dispatcher), `to_team` and `reason`, it must
**not** carry `from_team`, and it is legal only as a token's **first** event — a
second one would describe work arriving somewhere it already is, and a late one
would claim the history above it happened before the work existed.

To every reader downstream `opened` and `pulled` mean the same thing: work is
sitting with a team whose dispatcher has not judged it yet. They differ only in
whether a team sent it. A reader that knows one and not the other strands the
token — the runner reports nothing to do while the board draws it waiting
forever.

### 4.7 A token blocked on a person — `questioned` / `answered`

**Implemented on branch `poc/controller-as-team` 2026-07-31; not on `main`.**

Every other state in this system waits on an agent or on the loop. These two
wait on a PERSON, and that needed a word of its own for a concrete reason: with
no state to park in, the runner sees a token sitting at a dispatcher and
re-dispatches that dispatcher every tick, paying repeatedly to ask a question of
somebody who has not replied.

- `questioned` carries `agent_id` (who asked), `questions` (what was asked) and
  `reason`. It does not release the team — the token is still held, still
  counted against WIP (§6). **The runner never dispatches on it.**
- `answered` carries `to_team` and `reason`, and is **the only event whose actor
  KIND is part of its validity**: it must be written by a `human:` actor or the
  writer refuses the line. §2 accepts attestations from no other role, and this
  is the gate whose subject is a person. An operator agent may relay the words
  and then names itself in `relayed_by` — the actor says who DECIDED.
- `to_team` on `answered` is not decoration. §6 places a token by its last
  event's `agent_id` or `to_team`, and a person is neither, so an answer without
  it would orphan the token the moment somebody replied.
- A `questioned` token that goes unanswered past the answer deadline is closed
  with `abandoned` by the RUNNER (§9), and the controller writes a withdrawal
  notice naming the unanswered questions.

## 5. State machine

One token, keyed on its last event and the role of the actor.

| Last event | Condition | Next |
| --- | --- | --- |
| `opened` | — | dispatch the **dispatcher** (intake) |
| `pulled` | — | dispatch the **dispatcher** (intake) |
| `intake` | — | dispatch a **worker** |
| `returned` | — | dispatch a **worker** (rework) |
| `resumed` | — | dispatch a **worker** (rework, budget reset) |
| `assigned` | actor is running | in flight, do nothing |
| `assigned` | no live process, older than `ZOMBIE_SEC` | append `lost` |
| `lost` | — | retry the **same role**; the leg produced nothing |
| `delivered` | terminal is not `done` | retry the **same role** |
| `delivered` | `done`, actor is a worker | dispatch the **evaluator** |
| `delivered` | `done`, actor is a dispatcher | harvest → `intake` or `returned` |
| `delivered` | `done`, actor is the evaluator | harvest → `reviewed` |
| `reviewed` | `pass` | release to the pull controller |
| `reviewed` | `reject` | dispatch a **worker** of the same team |
| `reviewed` | `unresolved` | escalate |
| `escalated` | controller outbox exists | harvest → `resumed` or `abandoned` |
| `escalated` | no answer yet | held; the runner does not move it |
| `completed` | not yet audited | flag `audit_requested` and dispatch the controller |
| `audit_requested` | controller outbox exists | harvest → `audited`, or `questioned` when the answer is not a word this seat reads |
| `completed`, `audited`, `abandoned` | — | terminal; the token holds nothing |

**Ordering within a tick is fixed:** harvest → pulls → dispatch → escalation.
Harvesting after pulling would let the controller evaluate a stale event, and
pulling before a review lands is what made the evaluator decorative.

**No leg is dispatched onto a history that cannot be believed.** Before the
runner acts on a token, that token's ledger is validated (§4.3). If it does not
validate the runner refuses, names every problem it found, and moves on.
Occupancy, the pull decision, the board and the audit are all derived from that
one file, so dispatching a fresh leg onto a broken history writes good evidence
on top of bad and buries the break. The refusal is **loud** for the same reason
every ceiling is (§10): a silent skip here looks exactly like a team with
nothing to do.

The cost is stated rather than hidden: a token whose ledger is invalid **stops
moving** until a human repairs it, and §13 forbids rewriting a line. See §14.2
item 1, which records the one shape of history this system produces today and
cannot then repair.

## 6. Occupancy — the single placement rule

`dispatch-facts.teamOccupancy()` is the **only** function permitted to answer
"which team is holding this token". Any second implementation is a defect: two
readers computing it separately is how a board came to draw a limit that was not
being enforced.

- A team holds a token from the moment it pulls it until the route closes.
`questioned` and `answered` may follow `completed` (§5: it is only half
closed). Every other gate escalates upward when it cannot decide; the
controller is the top, so its only remaining reader is a person. Without that
route a finished route meeting an unusable audit answer had nowhere legal to
go — the runner refused its own repair on every tick, visibly and for ever.

- `RELEASING_EVENTS = {completed, abandoned, audit_requested, audited}`. Everything
  else holds. An audit *observes* a delivery; it never takes custody of one, so
  reading a finished route must not put it back into a team's WIP.
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
- **A handoff carries no artifact of its own — what the receiving team inherits
  is the token's recorded history.** So a token whose ledger does not validate
  is not handed on. It is reported as `invalid`, with every problem named, and
  no custody event is written. This is the same refusal as the failed-leg check
  one layer down: handing on a history that describes something impossible is
  the same class of mistake as handing on a delivery that never happened.
- A blocked token stays visibly blocked. A queue backing up is the signal the
  board exists to show. **An `invalid` token must stay visibly blocked too** —
  see §14.2 item 2, where the board's failure to draw it is a live defect.
- No next team on the route → `completed`.

### 7.1 The controller team releases on `intake`, not on `reviewed`

**Branch `poc/controller-as-team` only.** A delivery team releases work when its
evaluator passes an artifact. The controller team has no artifact to review —
admission is the claim that a REQUEST is workable, and its dispatcher's gate is
what decides that. So `planPulls` treats `intake` `accept` at the controller
team as ready-to-pull, and the first delivery leg of every route becomes an
ordinary `pulled` with a real `from_team`.

The controller's worker is never dispatched during a healthy admission. It
exists for the other job (§9), and paying a leg to do nothing would also hold
the controller's single WIP slot while doing it.

**The front door obeys the WIP limit.** `opened` is the one arrival that is not
a pull, so nothing enforced §6 there until `admit.mjs` existed: two requests
landed on a WIP-1 controller and occupancy read 2. Admission now counts through
the same placement rule everything else uses and is refused while the controller
is full — a queue, not a rejection.

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

- **Event-triggered, never on a timer.** A timer bills for reading a board that
  has not changed. Every trigger below is something that *did* change. (This
  clause predates the runner heartbeat of §11 and is unrelated to it: the
  heartbeat is a file the runner writes about itself and costs nothing to
  write. Nothing in §11 may ever become a reason to dispatch the controller.)
- It has two jobs. **Auditing** is the standing one: no team's evaluator can see
  past its own leg, so only this role can ask whether what came out of the end is
  what was asked for. **Unsticking** is the exceptional one.
- Triggers:
  1. a route reached `completed` and nobody has read the delivery as a whole
  2. a held token has survived `RETRY_NOISE` or more failed legs — retries that
     succeed quietly hide how hard the loop had to work
  3. the board holds work with nothing recorded for longer than `STALL_SEC`
  4. a spent retry budget, an unresolved review, or a leg ceiling reached
  5. a token that cannot be placed
- Verdict families, chosen by which job the trigger names: `accept` | `concern`
  for an audit (the route is already closed, so a concern is a report for a
  human, not a rerun) and `resume` | `abandon` for a parked token.
- **One question per dispatch, and the audit goes first.** The controller's
  outbox ends in a single `VERDICT:` line, so a leg asked both jobs at once can
  only answer one of them — the two vocabularies are disjoint, and the
  unanswered token records nothing and is then held by the unchanged-trigger
  brake forever. The brief still carries every trigger and the whole board; it
  names the one token the verdict is about, and the rest are asked on later
  ticks. Answering one changes the trigger set, which is what releases the
  brake. (Added 2026-07-29 — found by `tests/loop-replay.test.mjs`.)
- **A token is only `held` if a question is actually outstanding.** An
  `escalated` written by the controller's dispatch names the controller;
  `harvestEvent` also writes one, for an intake refusal at the head of a route
  where there is no sending team, and that one names the *dispatcher*. Treating
  both as "waiting on the controller" parked the second forever: `held` is not a
  trigger, so nothing ever dispatched the controller to look at it. The
  discriminator is `agent_id`. For the same reason the harvest of an
  `escalated` only reads an outbox when the escalation named the controller —
  otherwise it read a dispatcher's refusal with the controller's vocabulary and
  either found nothing (silence forever) or, worse, found `resume`/`abandon` in
  the refusal prose and closed the token on the dispatcher's words.
- Two brakes, both required: a **time cooldown** (`PM_COOLDOWN_SEC`) and an
  **unchanged-trigger** check against the last note. Time alone is no brake on a
  permanent condition.
- It is dispatched **about the board**, not about a token: its brief carries the
  trigger list and the whole board, and its dispatch carries no work item.
- `resume` returns the token to its team and grants a fresh attempt budget.
  Attempts made before the controller looked do not count, or resume would
  re-escalate on the very next tick.
- `abandon` closes the token honestly. It was the only mechanised writer of
  `abandoned` until 2026-07-31, when the answer deadline gave it a second: the
  RUNNER closes a `questioned` token nobody answered in time (§4.7, branch
  `poc/controller-as-team`). Two writers, one word — `actor` already tells them
  apart, and a reader asking how a token ended wants one word to search for
  rather than two. The runner also writes the withdrawal notice, because a
  conversation that ends in silence is unreadable from the person's side.

## 10. Budgets and ceilings

| Ceiling | Value | Scope | On hit |
| --- | --- | --- | --- |
| `MAX_ATTEMPTS` | 3 | one role's pool, in one team, since the last resume | escalate |
| `MAX_LEGS` | 15 + granted | the whole token, all roles | escalate |
| `RESUME_GRANT` | 3 | added per `resumed` event, clamped | raises the leg ceiling |
| `MAX_IN_FLIGHT` | 4 | declared agents running across the whole board | wait |
| `wip_limit` | derived: the team's worker count (§3.1) | tokens held by one team | wait / block the pull |
| `ZOMBIE_SEC` | 180 s | an `assigned` with no live process | append `lost` |
| `PULSE_STALE_SEC` | 120 s | evidence age | refuse to dispatch |
| `PM_COOLDOWN_SEC` | 900 s | between controller dispatches | hold |
| `STALL_SEC` | 1800 s | held work with nothing recorded | escalate |
| `RETRY_NOISE` | 3 | failed legs survived by one held token | escalate |

Every ceiling must be **visible when it is hit**. A runner that logs only the
happy path looks identical to one that has silently given up.

## 11. Liveness dependency

Two different things can be dead, and each has its own evidence.

### 11.1 Are the AGENTS running — `pulse.json`

`pulse.json` is the only evidence that an agent is still running.

- **Missing** snapshot = a repo where nothing has ever run. Dispatch is allowed,
  with a note.
- **Present but stale** (older than `PULSE_STALE_SEC`, or undated) = the watcher
  that writes it has stopped. All dispatch is refused, loudly. Frozen evidence
  either stalls the loop forever on an agent that already exited or, past the
  zombie window, declares a running agent lost and pays to run it twice.

### 11.2 Is the LOOP running — `.tmux-teams/runner-heartbeat.json`

Every other artifact this system writes describes the agents. None of them
describes the runner. **A runner that has stopped leaves a board that looks
calm** — no agent running, nothing overdue — and a reader concludes there is
simply no work to do. So the runner states its own condition, on disk, in its
own words:

```json
{ "schema": "tmux-teams.runner-heartbeat", "at": "<ISO 8601 UTC>",
  "tick_sec": <number>, "dispatching": <boolean>,
  "reason": "<empty when dispatching>", "started": <number>, "held": <number> }
```

**It is stamped on EVERY tick, including the ticks that refuse to dispatch.** A
heartbeat that appeared only on healthy ticks would say "alive and dispatching"
or say nothing — and "nothing" is the same silence a dead process leaves. The
refusing ticks are exactly the ones a reader has to hear about, so
`dispatching: false` carries the runner's reason in the runner's own words, and
the runner never invents one.

Three reader rules, and no others:

| What the reader sees | What it means |
| --- | --- |
| no file | the runner has **never run** in this repo |
| `at` older than `3 × tick_sec` | the runner is **not responding** |
| `dispatching: false` | the runner is **deliberately holding**, and `reason` must be shown |

Age is judged against the runner's **own declared** `tick_sec`, never a
hard-coded one, so a slow loop is not read as a dead one. Staleness outranks
`dispatching`: a stale record is as old as the record, so a stale
`dispatching: false` is reported as what the runner *last said*, never as a hold
in progress.

Honesty, same rule as everywhere else (§12.7.1): `started` and `held` are
printed only when the runner measured them. A count it did not report says so
instead of printing a zero; a measured `0` still prints. Today the only tick
that emits `held: null` is the one that found the graph invalid, where occupancy
is genuinely unmeasurable because there are no declared teams to count against.
That is a property of the three call sites, not something the writer enforces —
its `held` parameter defaults to `null`, so a future caller that simply forgets
to count would land in the same state and be read as "not measured" rather than
as a bug. Every stamp must pass `held` deliberately.

A **dry run does not stamp.** Letting a simulation overwrite a live runner's
heartbeat in the same repo would report a loop that is not running.

Failing to stamp never takes a tick down: moving work matters more than
describing the move.

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

These are the bands **of the diagram**. The loop-health strip of §12.7.7 is not
one of them: it is page chrome that sits above the diagram entirely, so it
neither reorders these two nor adds a third.

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

**The declared model is a third fact, and it is not this one.** `graph.json`
now names a model for every seat (§3.2), and that name travels with the team and
with each agent in the validated graph. It is a DECLARATION: it says which model
was *asked* for. Line 3 states the model that *answered*. Wiring the declared
field into line 3 would turn this table's only honesty guarantee into a lie, and
is forbidden (§12.7.2). A seat whose declared model was never acknowledged still
reads `unverified`.

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
7. **The page states the loop's own health before it states anything else.**
   A board of declared agents with no evidence beside them is the same picture
   whether the loop is idle or dead, and this band is the only surface that can
   tell those apart. It sits directly under the header, reads
   `runner-heartbeat.json` by the rules of §11.2, and names one of six states —
   `never`, `stale`, `holding`, `dispatching`, `unreadable`, `unmeasured`. The
   four a reader must act on each have an honest failure mode behind them:
   `unreadable` is deliberately **not** collapsed into "never run", because that
   would be a false claim about the filesystem, and `unmeasured` covers a
   heartbeat that is present but does not say enough to judge.
   Reading the heartbeat must never throw. This band has to render even when
   everything it describes is broken.
   Like every other status on this page, the state is carried more than one way:
   a shape that survives greyscale, an uppercase state word, a sentence, and a
   machine-readable `data-loop-health` attribute — never colour alone (§12.4).

## 13. Prohibitions

- No component may rewrite a ledger line.
- **Exactly two components may append to a ledger: `ledger-writer.mjs` and
  `acp-companion.mjs`.** Nothing else — no shell `>>`, no ad-hoc
  `appendFileSync`, no third writer. The companion is the only thing that knows
  a leg started or ended, and routing it through the writer would mean spawning
  a process inside the dispatch path, so it is a sanctioned writer bound by the
  same obligations: every line it writes carries `actor`, and it writes only the
  events §4 names for it (`assigned`, `delivered`). Everything else goes through
  `ledger-writer.mjs`. A refused write did not happen and may not be reported as
  having happened.
  *An earlier draft of this clause named one writer and was contradicted by §4's
  own event table and by the code on every leg — the contract disagreeing with
  itself, which is worse than disagreeing with the code, because a reader
  believes the half that is false.*
- No component may add a field to `pulse.json`.
- No second implementation of the occupancy rule.
- No agent may be dispatched without a brief.
- No verdict may be inferred from prose.
- No `wip_limit` is written into a declaration (§3.1).
- No declared model is printed as a verified one (§12.7.2).
- No list of known model names lives anywhere in this system (§3.2).
- The page must never dispatch, pull, or mutate anything.

## 14. Acceptance criteria

Every clause below is enforced by a test that exists today. A clause with no
test is not enforced and must be marked as such in §14.1.

AC1–AC37 live in `tests/loop-occupancy.test.mjs` or `tests/graph.test.mjs`.
AC38 onward name their own file, because the batch of 2026-07-28 added three:
`tests/workflow-graph.test.mjs`, `tests/ledger.test.mjs` and
`tests/loop-runner-heartbeat-model.test.mjs`.

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
| AC33 | §9 | a finished route is read as a whole, not just leg by leg |
| AC34 | §6 | reading a finished delivery never puts it back in a team |
| AC35 | §9 | the controller hears about retries that succeeded quietly |
| AC36 | §9 | a board holding work with nothing recorded is a stall, not calm |
| AC37 | §8, §9 | an audit answer closes the flag, and silence does not |

Added 2026-07-28. Each row names the file holding its test.

| # | Clause | Assertion | Test file |
| --- | --- | --- | --- |
| AC38 | §3.1 | the WIP limit is the worker count whatever the graph does or does not say | `workflow-graph.test.mjs` |
| AC39 | §3.1 | a declared `wip_limit` that differs from the worker count is rejected, naming both numbers | `workflow-graph.test.mjs` |
| AC40 | §3.2 | a seat with no model is rejected, naming the team and the role | `workflow-graph.test.mjs` |
| AC41 | §3.2 | a declared outer controller with no model is rejected | `workflow-graph.test.mjs` |
| AC42 | §3.2 | a model value is never judged against a list of known models | `workflow-graph.test.mjs` |
| AC43 | §3.2, §12.3 | the declared model travels with the team, the role and the agent, as declaration | `workflow-graph.test.mjs` |
| AC44 | §4.1 | a write with no actor, or a malformed one, is refused | `ledger.test.mjs` |
| AC45 | §4.1 | the recorded actor cannot be spoofed by the event body | `ledger.test.mjs` |
| AC46 | §4.1 | history that predates the actor is not condemned for lacking one | `ledger.test.mjs` |
| AC47 | §4.2 | an event that would make the history impossible is refused, not written | `ledger.test.mjs` |
| AC48 | §4.2 | an already-broken ledger is repaired first, never appended to | `ledger.test.mjs` |
| AC49 | §4.2, §13 | writes append and never rewrite | `ledger.test.mjs` |
| AC50 | §4.2 | a `work_item` cannot escape the work-items directory | `ledger.test.mjs` |
| AC51 | §4.1 | the two hand-written `abandoned` events are legal, so only an actor could have caught them | `ledger.test.mjs` |
| AC52 | §5, §4.3 | a token whose history cannot be believed is not dispatched onto | `loop-runner-heartbeat-model.test.mjs` |
| AC53 | §5, §4.3 | a valid history still dispatches, so the gate is a gate and not a wall | `loop-runner-heartbeat-model.test.mjs` |
| AC54 | §4.1, §13 | every line the runner appends names an accountable actor | `loop-runner-heartbeat-model.test.mjs` |
| AC55 | §4.2 | an append the writer refused is not reported as having happened | `loop-runner-heartbeat-model.test.mjs` |
| AC56 | §11.2 | a healthy tick stamps a heartbeat the page reads as dispatching | `loop-runner-heartbeat-model.test.mjs` |
| AC57 | §11.2 | a tick that refuses still stamps, and says why | `loop-runner-heartbeat-model.test.mjs` |
| AC58 | §11.2, §12.7.1 | a refusal with no graph does not invent an occupancy count | `loop-runner-heartbeat-model.test.mjs` |
| AC59 | §11.2 | a dry run does not stamp, so a simulation cannot impersonate a live runner | `loop-runner-heartbeat-model.test.mjs` |
| AC60 | §11.2 | the runner is judged against the tick it declares, not a hard-coded one | `loop-runner-heartbeat-model.test.mjs` |
| AC61 | §3.2 | the sentinel is never sent as a request, so the account default stands | `loop-runner-heartbeat-model.test.mjs` |
| AC62 | §3.2 | a real declared name is passed through as the request the adapter is held to | `loop-runner-heartbeat-model.test.mjs` |
| AC63 | §3.2 | the model comes off the seat the agent actually sits in | `loop-runner-heartbeat-model.test.mjs` |
| AC64 | §12.7.7 | a repo where the runner has never run says so instead of looking calm | `graph.test.mjs` |
| AC65 | §11.2, §12.7.7 | a heartbeat older than three of its own ticks reads as not responding | `graph.test.mjs` |
| AC66 | §11.2 | a stale hold is reported as what the runner last said, not as a hold in progress | `graph.test.mjs` |
| AC67 | §11.2 | a slow loop is judged by its own tick and is not called dead | `graph.test.mjs` |
| AC68 | §11.2 | a deliberate hold shows the reason the runner gave, escaped | `graph.test.mjs` |
| AC69 | §12.7.1 | a count the runner did not report is not printed as a zero | `graph.test.mjs` |
| AC70 | §12.7.7 | an unreadable heartbeat is not reported as a runner that never ran | `graph.test.mjs` |
| AC71 | §12.7.7 | a heartbeat that cannot be judged says so rather than guessing | `graph.test.mjs` |
| AC72 | §12.4, §12.7.7 | loop health is readable without colour: a state word and a shape | `graph.test.mjs` |
| AC73 | §7, §4.3 | a token whose ledger cannot be believed is not handed to the next team, and the same refusal holds at apply time | `loop-occupancy.test.mjs` |
| AC74 | §9, §14.2 item 3 | a controller dispatch paid for with nothing recorded is named as stuck, not logged as bookkeeping | `loop-runner-heartbeat-model.test.mjs` |
| AC75 | §4, §8 | an accepted intake that stated no reason says so rather than leaving a mandatory field blank | `loop-runner-heartbeat-model.test.mjs` |
| AC76 | §4, rule 2 | an intake refusal with nowhere to send it back still names the team holding the token | `loop-runner-heartbeat-model.test.mjs` |

### 14.1 Clauses this contract does NOT yet enforce

Declared here rather than left to be discovered. Each is a rule the code follows
today with nothing stopping it from regressing.

| Clause | Rule with no test |
| --- | --- |
| §4, rule 3 | a malformed ledger line is skipped, counted, and the count reaches the page |
| §4, rule 4 | equal timestamps keep append order |
| §5 | the tick order is harvest → pulls → dispatch → escalation |
| §12.7.6 | auto-refresh is pausable and the page states its own freshness — only the asset's existence and parseability are tested |
| §13 | the prohibitions are review rules, not runtime behaviour; they are enforced by reading a diff |

### 14.2 Known contradictions and live defects, 2026-07-28

Recorded here rather than left to be discovered. Each of these is a place where
this contract and the code do **not** agree, or where the contract is satisfied
by nothing. None is fixed by the batch that added §3.1, §3.2, §4.1, §4.2, §4.3
and §11.2.

1. **§4 has no spelling for a route-opening `pulled`, and the code refuses one.**
   §5 starts every token at `pulled`; §4 requires `from_team` on `pulled`; the
   first pull of a route has **no sending team**. There is no `created` or
   `opened` event. So intake into the graph is unrepresentable through the
   sanctioned writer without fabricating a sender.
   **This is live, not theoretical.** `.tmux-teams/work-items/kanban-board.jsonl`
   line 1 is exactly that event, and it fails validation today.
   *Corrected 2026-07-28:* an earlier draft of this item claimed that token is
   "permanently stuck" with a WIP slot never released. It is not. Its last event
   is `audited`, which §6 lists as releasing, so no team holds it — measured:
   all four teams count 0, no orphans, and the pull controller reports nothing
   waiting. The **mechanism** is real and would strand any token still in
   flight; the named instance is terminal. The evidence was wrong even though
   the conclusion was right, which is exactly the failure this section exists to
   catch, so it is corrected in place rather than quietly deleted.
   *Settled 2026-07-28 (Master):* §4 gains a distinct opening event, `opened`.
   The two rejected alternatives are recorded because the reasons outlive the
   choice. Making `from_team` optional on a token's first event would stop the
   validator catching a real pull that forgot its sender — permanently, for
   every pull, to accommodate one event per route; the guarantee that would have
   cost is now pinned by a test so a later convenience cannot quietly spend it.
   An append-only *repair* event was rejected on a larger principle: a system
   whose entire claim is that history cannot be rewritten should not ship a word
   for rewriting history. `opened` adds vocabulary instead of removing
   strictness. See §4.6.

2. **§7's "an `invalid` token stays visibly blocked" is not drawn.**
   `kanban.mjs` treated `blocked`, `failed` and `skip` as blocking and did not
   know `invalid`, so a gated token rendered as an ordinary card while the loop
   refused to move it. The board and the loop disagreed about that token.
   **The code was the one that was wrong** (§15.3): §7 said what should happen.
   *Closed 2026-07-28.* `invalid` joined the blocking set. Fixing it exposed a
   test fixture that was a `reviewed` with nothing delivered — a history the
   validator refuses and the loop cannot produce, which had passed all along
   only because the board ignored the verdict on a token's own history. The
   fixture is now a whole route, so the test measures what its name claims.

3. **The escalation path is not gated by §5, and cannot be without
   restructuring the tick.**
   The ledger check sits after the `action !== 'dispatch'` guard, so an
   `escalate` plan never passes through it. The consequence is specific: the
   controller is dispatched and `pm-notes/latest.md` is written **before** the
   `audit_requested` / `escalated` marks are appended, so a refused mark leaves
   the token's last event unchanged — the same trigger recurs next tick, the
   unchanged-trigger brake of §9 then holds it forever, and a controller
   dispatch was paid for with nothing recorded. The runner now says exactly that
   (`STUCK <token>`) instead of letting it pass as a bookkeeping complaint, and
   that refusal is tested. **The ordering hole itself remains.**
   (An earlier report in this batch claimed these two marks called an
   undefined `appendEvent` and threw. They do not: both go through `record()`,
   which is the sanctioned writer. Verified by grep and by the passing test
   `a token the controller was paid for but nothing was recorded about is called
   stuck`.)

4. **No real model name has been proven acknowledged by this adapter.**
   §3.2 says a declared name becomes a request the adapter is held to. That the
   name is *composed and passed* from the right seat is tested (AC61–AC63);
   that any real name comes back `matched` from a live agent is **not**, and no
   test can prove it without one. Until one is proven, every seat in this
   repository's own declaration reads `inherit-account-default`, which requests
   nothing. An unacknowledged name fails the whole dispatch.

5. **`appendEvent` has no lock.** It is read-validate-append, so two processes
   writing the same token (the runner and an acp-companion) are TOCTOU on the
   *sequence* check. One `appendFileSync` of one pre-serialised line keeps lines
   from interleaving, so the failure mode is a bad sequence, never a corrupt
   line. Known and unaddressed.

6. **The pull gate judges the parsed projection, not the raw file.**
   `planPulls` is handed items, not a repo path, so it validates the `at`-sorted
   projection `readWorkItems` produces — which has already dropped unparsable
   lines. A token broken only by an unparsable line is therefore invisible to
   the planner and surfaces only as a per-tick refusal on stderr from the
   writer, never as an `invalid` decision on the board. Closing this needs
   `readWorkItems` to carry a per-token malformed count (§4, rule 3).

7. **`ACTOR_RE` and the bare actor `runner`.** The actor vocabulary is
   `agent:<id>` | `human:<id>` (§4.1). A bare `runner` is not legal, and the
   runner signs itself `agent:runner`. Stated here because an earlier brief
   specified the bare form.

8. **The setup skill over-claims the consequence of skipping it.**
   `skills/graph-setup/SKILL.md` opens by saying nothing dispatches without
   a `graph.json`. §3 says, and `graph.mjs` does, the opposite: a repo with
   **no** file falls back to the bundled default and `graph.mjs check` on an
   empty directory exits 0 as `ok (default)`. Only an **invalid** file fails
   closed. **The skill is the one that is wrong** (§15.3); §3 and the code
   agree and are left alone.

### 14.3 Settled 2026-07-28 — the PM audit's findings

The outer controller's first real audit returned `concern` on `kanban-page` with
four findings. Three were decisions Master settled; the fourth was found while
settling them. Recorded because the reasoning is the durable part.

1. **`kanban-page`'s hollow `completed`.** The controller proposed closing the
   token as superseded. **Rejected.** The token is terminal and holds no WIP, so
   nothing is stuck; and the audit that found the problem is already in its
   ledger. What was missing was a reader: `kanban.mjs` had no case for either
   half of the audit, so a route the PM had read and raised concerns about
   rendered as `Unknown event: audited`. The board that exists to report exactly
   that could not say it. Superseding the record would have hidden a true
   history to work around a display bug. `completed` now also reads
   *"Completed — not yet audited"*, because §5 says it is only half closed.

2. **`evidence_present` was `false` on all 13 legs.** Not a bug in the
   recording: `role-briefs.mjs` never once said the word `EVIDENCE`, so no agent
   this plugin dispatches was ever told to write the block that
   `acp-companion.mjs` looks for. A field that cannot be true is not a
   measurement. The shared rules now require the block and say why, and a test
   asserts every shipped brief carries the requirement. Worker briefs remain the
   repo's own `<team>.md` (§4), so a repo that writes its own worker brief has to
   carry the requirement into it — that gap is real and is named here.

3. **`pulled` with no sender.** Settled as §4.6 above.

4. **Found while fixing the above: the cooldown mixed two clocks.**
   `planEscalation` took an injectable `now` and compared it against
   `statSync(pm-notes/latest.md).mtimeMs`. Let the filesystem's clock run ahead
   of the caller's and the difference goes negative, every tick reads "the
   controller ran moments ago", and **the outer controller is never dispatched
   again** — a permanent silence produced by a clock rather than by a board with
   nothing on it. It now reads the ISO stamp its own writer puts on line 1, with
   mtime as a fallback for files written before that stamp existed. The bug
   announced itself by making a test that had passed all morning start failing
   in the afternoon, which is the only reason it was found at all.

### 14.4 The recurring shape, and what now stops it

Four defects this session were one defect: **the validator accepts a word and a
reader downstream has never heard of it.** `opened` stranded a token; `audited`
rendered a route the controller had raised concerns about as `Unknown event:
audited`; `invalid` drew a token the loop refuses to move as an ordinary card;
`lost` was handled by the runner but absent from §5. Every one was found by a
person looking at a page, one word later than the last.

Fixing them individually cannot converge, because nothing required a reader to
cover the vocabulary — only somebody noticing. `tests/kanban.test.mjs` now walks
every entry in `LEDGER_EVENTS`, renders a token whose last event is that word,
and fails if any of them reaches the board's `default` branch. It also asserts
the detector fires on a word that is genuinely unknown, because a sweep that has
never been shown to fail proves nothing.

All three readers now carry it, each in the shape its own failure takes.

- **The board** (`tests/kanban.test.mjs`): no event may reach the `default`
  branch, and the detector is shown to fire on a word that is genuinely unknown.
- **The runner** (`tests/loop-occupancy.test.mjs`): every event either produces
  a dispatch or appears in `NO_DISPATCH_FOLLOWS` with the reason it is a dead
  end. Four are — `completed` (the controller audits it), `audit_requested`
  (waiting on an outbox), `audited` and `abandoned` (terminal, §5).
- **The graph** (`tests/graph.test.mjs`): every event naming an `agent_id`
  either credits that agent with work, or appears in `NOT_THE_AGENTS_OWN_ACT`
  with the reason. Four are — `opened` and `pulled` name a dispatcher that has
  not judged yet, `assigned` is the dispatch rather than its outcome, and
  `audit_requested` is the runner asking rather than the controller acting.

A word added to §4 now fails all three until somebody decides what it means to
each. That property is the fix; no individual patch was.

**Corrected 2026-07-29, within the hour, by two outside advisors.** The
paragraph above was false when written, for the runner and possibly the graph.

- **Runner — the oracle was a tautology.** It read `moved = Boolean(plan)`, but
  `planDispatches` *returns* the `nothing follows <event>` skip rather than
  dropping it, so every unknown word came back truthy, `stated` was false, and
  the assertion reduced to `true === true`. It could not have failed for the one
  reason it existed. Fixed: `skip` is no longer counted as movement, and a
  `not_an_event` negative control now proves the detector fires. Measured
  before the fix: `planDispatches` on `future_word` returned
  `{action:"skip", reason:"nothing follows future_word"}` — length 1, truthy.
- **Graph — reported unverified.** An advisor reports `tests/graph.test.mjs`
  skips any event whose `EVENT_SPEC` does not *require* `agent_id`, which
  excludes `abandoned` — while the runner writes `abandoned` with an `agent_id`
  at runtime, and `activityByAgent` does not credit it. Not yet confirmed here;
  recorded as a claim, not as a fact.

The lesson is narrower and worse than "test the family": **a closure test that
has never been shown to fail is not a closure test.** The board's version
carried a negative control from the start and was sound; the runner's did not
and was worthless. Both were written in the same hour, by the same author, with
the same confidence.

Closing the graph's half exposed a defect of its own. `workLine` for the outer
controller read `N escalation(s) handled`, but `escalations` is bumped on the
agent **being** escalated: the runner stamps that event with the dispatcher it
is escalating, never with the controller reading it. So the seat that audits
every finished route read `0 escalation(s) handled` however much it had done,
and its two real outputs — `audited` and `resumed` — were counted nowhere.
Master reported that node as empty twice; the node was drawn correctly and had
nothing to draw. It now states `N audited · N resumed`. The fixture that had
hidden this credited the controller by writing `escalated` with the controller's
own `agent_id` — a line the loop cannot produce, and the same class of fake
fixture found in the board's tests an hour earlier.

### 14.5 Decided 2026-07-31, BUILT 2026-08-01 — work enters through the controller

**This is now what the runtime does**, and this section is kept for the
reasoning rather than as a plan. `validateWorkflowGraph` refuses a graph whose
routes do not start at the controller team, the bundled template ships one,
`admit.mjs` is the only writer that enforces the front door's WIP limit, and
`graph.html` draws the controller as that team's single seat.

It said "NOT yet built" until an outside review on 2026-08-01 pointed out that
this file and `references/loop-graph-page.md` were two SSOTs an implementer
could not satisfy at once — this one describing a controller outside the board,
the other a controller holding a team seat. A stale heading in a contract is not
a harmless leftover: it is an instruction to build the wrong thing.

**Today:** an operator writes `opened` straight at a team — `agent_id` is the
receiving dispatcher, `to_team` is that team, and the `workflow` is a string the
operator typed. The controller is never told. Two consequences, both real:

1. **The auditor never saw the request.** §9 makes the controller the only role
   that can ask whether what came out of the end is what was asked for. It is
   handed that question at the end of a route it had no part in admitting. Master
   put it in one line: *"PM เป็นคนตรวจงานคนสุดท้าย แต่จะไม่รู้ว่างานนี้มาจากไหนได้อย่างไร"* — the
   last reviewer cannot know where the work came from.
2. **Nobody accountable chose the route.** `hotfix` or the long way round is the
   most consequential decision made about a token, and today it is made by
   whoever typed the command, with no evidence of why.

**Decided:** admission goes through the controller. The operator brings a
request to the controller; the controller admits it, chooses the workflow, and
states why. The route then runs as it always has.

**The objection, and why it fell.** A controller in the admission path looked
like a bottleneck and a cost: §9 says event-triggered, never on a timer, and one
controller leg answers one question with one verdict (§9, added 2026-07-29). N
tokens would mean N dispatches serialised behind a 15-minute cooldown. Master's
answer was that this misreads the direction of the loop: *"คอขวดไม่ใช่ปัญหาเพราะเราใช้
ระบบ pull เมื่อทีมลีดว่างจะมาดึงงานจาก PM ไปเอง"* — the controller does not push work to a
team. It holds admitted work, and the receiving dispatcher **pulls** when it has
room, exactly as every other handoff on this board already works (§7).

**What this also fixes, unplanned.** The head-of-route intake refusal — the wedge
closed on 2026-07-29 by discriminating on `agent_id` — exists only because the
first team on a route has no sender to return work to. If every route begins at
the controller, every team has a sender and that special case stops existing.

**Settled the same day — the controller IS a team.** The open question was where
an admitted token sits before the first team pulls it, since §6 can only place
work with a team. The answer is that the controller stops being an exception:
it is declared in `graph.json` as an ordinary team with **one worker, so WIP 1**.
Every mechanism the board already has then applies to it unchanged — occupancy,
the pull, the WIP limit, the placement rule.

And its three jobs are not three new mechanisms. They are the three roles this
model already defines, pointed at the route instead of at one leg:

| Controller's job | Its role on that team | Same rule as every other team |
| --- | --- | --- |
| take a request, make it a token, queue it | **dispatcher** | the receiving side decides whether to accept |
| unstick what the loop cannot decide (§9 triggers) | **worker** | one worker, one leg, WIP 1 |
| read the finished delivery as a whole | **evaluator** | the gate that can send work back |

An ordinary team's dispatcher admits work to that TEAM and its evaluator judges
that team's LEG. The controller's dispatcher admits work to the SYSTEM and its
evaluator judges the whole ROUTE. Same shape, different scope — which is the
strongest argument that this is the right model and not a special case wearing a
team's clothes.

**The intake gate is a grill, not a form.** Master's requirement on job 1: the
controller must interrogate a request until nothing is left to guess. This is
the one place the system asks a human to be specific, and it is also where an
unclear ask becomes four teams' worth of wasted legs.

**The full design is written up in
[controller-as-team.md](controller-as-team.md)** — declaration, the admission
sequence event by event, the grill's six question categories verbatim, the new
`questioned` / `answered` pair for a token blocked on a person, and the list of
what must be built with the test that would prove each piece. It is marked NOT
BUILT throughout, for the same reason this section is: the contract describes
what the runtime does.

**Settled since:** an escalated token DOES consume the controller's WIP — one
stuck token stops new admission, *stop starting, start finishing*. And the grill
carries BOTH evidences: the six categories covered, and a human-actored line
before `intake`.

**Settled the same day, all of it:** an escalated token occupies the
controller's WIP, and so does a token waiting on a human — unanswered questions
expire on a deadline and free the queue rather than holding it forever. The
grill judges sufficiency rather than counting boxes: every category is faced,
none is skipped silently. And the grill objects but cannot veto — if a person
confirms after being warned, the work proceeds, with the warning and the
decision both on the record.

**Still open:** the deadline value, who writes the expiry (today §9 names the
controller as the only mechanised writer of `abandoned`), and the countdown the
board will have to draw — the first thing that page has ever had to show about a
human's obligation rather than an agent's.

Also unresolved: what the operator's own hand-off looks like in the ledger. A
human bringing a request is a custody event like any other, and today it has no
line.

## 15. Change control

1. A change to behaviour amends this document **in the same commit**.
2. A clause added here without a test is marked unenforced until one exists.
3. When code and this contract disagree, state which is wrong before editing
   either. A contract quietly edited to match unreviewed code is not a contract.
4. One writer per file per batch. The loop is itself a writer in this repository;
   editing a file while a worker holds it has already cost one overwrite.

### Amendment log

**2026-07-28 — WIP derived, models declared, the sanctioned writer, the runner's
own pulse.** Behaviour changed in `workflow-graph.mjs`, `loop-runner.mjs`,
`pull-controller.mjs`, `graph.mjs`, and in two new files `ledger-validate.mjs`
and `ledger-writer.mjs`. Under §15.3, which document was wrong in each case:

| Change | Which was wrong |
| --- | --- |
| `wip_limit` derived from the worker count (§2, §3.1, §10) | **the contract** — it declared `wip_limit` an input; the code now derives it, deliberately |
| models required per seat (§2, §3.2, §12.3) | **the contract** — it had no model in the declaration at all |
| `actor` on every written line, one sanctioned writer (§4.1, §4.2, §13) | **the contract** — it named no writer and no actor, which is how two hand-typed events became indistinguishable from machine evidence |
| validation at write, before dispatch, before handoff (§4.3, §5, §7) | **the contract** — it said a ledger is evidence and never said who checks it |
| the runner's heartbeat (§0, §2, §11.2, §12.7.7) | **the contract** — nothing described the runner itself, so a dead loop and an idle one drew the same board |
| "a repo with no `graph.json` uses the bundled default" (§3) | **neither** — contract and code agree; the *setup skill* over-claims. See §14.2 item 8 |

`.tmux-teams/graph.json` was migrated in the same commit: every seat and
the outer controller now name `inherit-account-default`, because §14.2 item 4
says no real name is proven yet, and all four teams' `wip_limit` lines were
removed even though each happened to match its worker count — leaving a field
in the canonical artifact that §3.1 says is not an input would contradict this
document on its own example.
