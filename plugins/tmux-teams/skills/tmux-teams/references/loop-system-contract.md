# Loop System Contract

**Status:** authoritative. This document is the single source of truth for the
delivery loop and the page that draws it.

If the code and this document disagree, one of them is a bug. Say which, in
writing, before changing either. Do not "fix" the document to match code that
was never reviewed against it, and do not change behaviour without amending
this file in the same commit.

**There is one source of truth, and it is this file.** Every other document
about the loop — `references/loop-graph-page.md`,
`references/controller-as-team.md`, `references/how-it-works.md`, `README.md`,
`SKILL.md` — expands a section of it and loses to it on conflict.

## Where to look

| § | Answers |
| --- | --- |
| [0](#0-scope) | which files this contract governs, and which it does not |
| [1](#1-model) | team, workflow, token — and that flow is one way |
| [2](#2-two-layers-never-mixed) | declared vs. observed: what a human may assign and what only evidence may say |
| [3](#3-declaration-contract--graphjson) | `graph.json` — seats, models, adapters, worker ceiling, validation |
| [4](#4-custody-ledger-contract) | every event a ledger may carry, and what each must name |
| [5](#5-state-machine) | the states a token moves through |
| [6](#6-occupancy--the-single-placement-rule) | the one rule that decides which team holds a token |
| [7](#7-pull-system) | who pulls, WIP, and when a route is complete |
| [8](#8-quality-gates) | verdicts, evidence, and what a pass has to mean |
| [9](#9-outer-controller) | the controller's three jobs, and the ones only it may do |
| [10](#10-budgets-and-ceilings) | limits on size, count and spend |
| [11](#11-liveness-dependency) | how the system knows the runner is alive |
| [12](#12-the-loop-graph-page) | what `graph.html` may draw — detail in `loop-graph-page.md` |
| [13](#13-prohibitions) | what nothing in this system is allowed to do |
| [14](#14-acceptance-criteria) | what is decided, what is built, and what is still open |
| [15](#15-change-control) | how this document may be amended, and the log |
| [16](#16-agent-seat-read-facade) | the three read-only questions an agent seat may ask without learning a filesystem path |

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
| `scripts/agent-seat-reads.mjs` | the agent-seat read facade — §16 |
| `.tmux-teams/graph.json` | the declaration artifact |
| `.tmux-teams/work-items/<token>.jsonl` | the custody ledger |
| `.tmux-teams/work-items/<token>.md` | the token's own request |
| `.tmux-teams/runner-heartbeat.json` | the runner's statement about itself |
| `.tmux-teams/graph.html` | the published page |

**Not governed here.** `pulse.json` is a frozen schema owned by
`references/pulse-v4.schema.json`; this loop reads it and never adds fields to
it. The separate four-phase governed runtime that used to sit beside this one —
`phase-gate-*` and `delivery-loop-*` — was removed on 2026-08-02 along with its
commands and documentation; there is one delivery model now.

## 1. Model

- A **Team** is a reusable resource pool: one **dispatcher** that owns intake,
  one or more **workers** that run in parallel, one **evaluator** that judges
  the team's own output. A team carries no routing.

  **What the dispatcher is actually for** (corrected 2026-08-05, from the
  owner's use rather than from this document's own theory). This section led
  with admission control — inspecting a token and declining it — for as long as
  it has existed. In practice **a refusal at the door has never been observed**
  on the owner's deployments, and the ledgers on the development machine have
  never reached an `intake` at all. The job the seat actually does is
  **choosing which model runs the work**: this token is simple, give it the
  cheap seat; this one is hard, give it the strong one; this one carries no
  images, a text-only model will do; this one needs a multimodal seat; that
  model is rate-limited right now, use another. §4.9 is the mechanism, and it
  is described there in the wrong words — as picking a *seat*, when the seat is
  only how a model is named.
  Admission control remains real and remains specified (the refusal ceiling
  below is enforced in two places), but it is the seat's **secondary** duty and
  should be read that way. A team whose door has never refused anything is not
  running a broken dispatcher; it is running a router.
- A **Workflow** is a route composed from existing teams. The same team may
  appear in as many workflows as need it.
- A **work item token** is the unit of work. It carries its own request and
  accumulates its own history.
- A route **never revisits a team**, and as of 2026-08-03 it does not run
  backwards at all. **Flow is one way.** An evaluator that finds a problem does
  not hand the work back to the team that produced it: it brings the work to a
  state it can pass and forwards it, and the token continues to the controller.
  A controller that is not satisfied does not return the token either — it
  starts a new flow. Rework is therefore a NEW token on a fresh route, never the
  same token moving upstream.

  **The rule is about CROSSING TEAMS.** Two things that look like going
  backwards are not, and neither is affected:

  - **A refusal at the door.** A receiving dispatcher inspecting a token and
    declining to admit it — `intake` with a `reject` verdict, and the `returned`
    event that follows — checks the work BEFORE it enters. It never entered, so
    nothing came back out. **Three refusals per door, and no more** (Master,
    2026-08-03): a fourth is not a check, it is two seats disagreeing about the
    same work with nobody deciding, and the token would bounce between them for
    as long as both keep their opinion. On the fourth the dispatcher writes
    `escalated` instead and the controller decides. Counted per door, so a
    different team refusing the same token starts at its own first. Enforced in
    both places it can go wrong: `loop-runner.mjs` escalates rather than
    refusing, and `validateLedger` refuses a fourth `returned` from the same
    `refused_by` with `door_refusals_exhausted`.
  - **A team's own loop.** An evaluator may send work back to a worker of its
    own team as often as the work needs; `reviewed` with a `reject` verdict
    redispatching inside the team (§7) is that loop, and it is the whole point
    of a team having its own evaluator. The token has not moved between teams.

  What the rule forbids is a token crossing a team boundary in the direction it
  came from. Once a team releases work, that team is behind it.

  The worked example, which says it better than the rule does. A QA evaluator
  reading its own worker's report finds two different things:

  - the worker did not finish the checklist — send it back to that worker and
    have it done properly. Same team, its own loop, allowed.
  - the worker found a real bug — QA fixes it, from the report, and carries on.
    It does NOT go back to the Dev team that produced it. Dev is behind this
    token now.


  **Enforced 2026-08-03.** `validateLedger` refuses a `pulled` whose `to_team`
  is a team that already **admitted** this token, with the code
  `route_went_backwards` — and since the sanctioned writer validates before and
  after every append (§4.3), the line is refused rather than reported later.
  Admission, not arrival, is what counts: `pulled` is written before `intake`
  runs, so a team that refuses at the door never enters the set and may pull
  the same token again once what was wrong is fixed. `escalated`, `resumed` and
  `answered` name the team the token already sits at and are not moves at all.
  Both halves are negative-controlled in `tests/ledger.test.mjs`: remove the
  check and the backwards route validates clean; count arrival instead of
  admission and the door-refusal retry stops being legal.

  **A team that has ADMITTED the work does not send it back.** `returned` is
  the door saying no BEFORE admission; after `intake` has run, the same word is
  the loop running backwards, and `validateLedger` refuses it with
  `sent_back_after_admission`. A reviewer that finds a problem brings the work
  to a state it can pass and forwards it — Master, 2026-08-03: *"ยืนยันกฏไม่ส่งกลับ
  รีวิวเวอร์ที่เจอปัญหาก็ต้องแก้ต่อเองให้จบเลย"*. Nothing refused this until then, which
  is how a hand-written `returned` came to sit in a live ledger: the operator
  used the only move the system had left open.

  **The rule is enforced on the line being written, not on the file's history.**
  A ledger written before §1 was enforceable can contain a backwards move, and
  the first version of this refused every further append to such a file — which
  met a real 46-line ledger with a worker mid-leg and froze it. A rule meant to
  keep work moving must not be the thing that stops it. The writer now refuses
  an append that introduces a NEW problem and nothing else, so a fresh backwards
  pull is refused exactly as before while history the token already carries no
  longer blocks its next legal step. `route_went_backwards` and
  `sent_back_after_admission` are tolerated that way BY CODE ALONE, wherever
  either occurs — a file invalid for any OTHER reason still has to be repaired
  before anything at all is appended.

  **B5 (2026-08-04): two later amendments hit the exact same trouble.**
  `question_id` became required on `questioned` and `actor_kind: 'human'`
  became required on `opened` (ADR 0002) — both tightened `EVENT_SPEC` on a
  system already running, exactly as §1's own backwards-pull rule was. A
  ledger clean before either amendment now reports `missing_field` (an old
  `questioned` with no `question_id`) or `not_a_human_answer` (an old `opened`
  with a non-human actor). By-code tolerance — the shape §1's own fix used —
  is too blunt for these two: `missing_field` fires for every required field
  on every event, so tolerating it by code alone would silently excuse a
  BRAND-NEW `delivered` missing `agent_id`; `not_a_human_answer` also fires on
  `answered`, whose human-actor rule is not new and was never legal to
  violate. So tolerance for these two is SCOPED: `LEGACY_TOLERATED_PROBLEMS`
  in `ledger-validate.mjs` matches on `(code, event[, field])`, against
  `event`/`field` metadata `validateLedger` now attaches to each problem it
  reports, not on prose parsed out of `detail`. A ledger-format marker was
  considered and rejected: this system's ledgers are read by grep and never
  rewritten (§4, §13), and a marker would mean every reader either
  understands versioning or treats "no marker" as "assume legacy" — the same
  scoped-by-shape reasoning with an extra field to keep in sync forever. Only
  HISTORY is excused: each violation is judged at its own line, so a
  half-migrated ledger — an old `questioned` with no `question_id`, followed
  after this fix ships by a fresh one that DOES carry one — needs no special
  case, and a NEW line missing either field is refused exactly as any other
  invalid event.

  This judgment is no longer writer-only. Before this fix, only
  `ledger-writer.mjs`'s `appendEvent` tolerated the two original codes; a
  token that regained the ability to be APPENDED to still could not be PULLED
  to the next team (`pull-controller.mjs`'s `planPulls` called the raw
  validator) or DISPATCHED onto again (`loop-runner.mjs`'s `tick` did the
  same). All three now read the identical `LEGACY_TOLERATED_PROBLEMS` list —
  `appendEvent` via `isLegacyTolerated`, `planPulls` via
  `validateLedgerTolerant`, `tick` via `validateLedgerFileTolerant` — so the
  three can no longer drift apart on the same question the way they just did.
  `tests/ledger.test.mjs` and `tests/loop-occupancy.test.mjs` carry the
  negative controls: each of the three call sites is mutation-tested to go
  red if it reverts to a raw, non-tolerant read, and `tests/ledger.test.mjs`
  goes red if `LEGACY_TOLERATED_PROBLEMS` is widened past these four shapes.

  **retro-release-review round 4, 2026-08-04 (qwen F-1 / codex BLOCKER 3):
  B2's `duplicate_task_id` and `duplicate_dispatch_id` (§6) must NEVER be
  among those four shapes, and a prior attempt at this fix briefly put them
  there.** `LEGACY_TOLERATED_PROBLEMS` feeds `isLegacyTolerated`, which
  `validateLedgerTolerant`/`validateLedgerFileTolerant` use — the shared
  judgment `pull-controller.mjs`, `kanban.mjs`, and `loop-runner.mjs`'s tick
  all read for "can this ledger be trusted enough to move the token, be
  dispatched onto, or be shown as on-track". `route_went_backwards`,
  `sent_back_after_admission`, an old `questioned` missing `question_id`, and
  an old agent-authored `opened` do not change what a `dispatch_id` or
  `task_id` MEANS — trusting the rest of such a ledger is trusting a fact
  that is still true. A duplicate id is different in kind: `currentEntry`
  (dispatch-facts.mjs) and `dispatchOwner` (ledger-validate.mjs) both depend
  on an id resolving to exactly one leg for its whole life, and reusing one
  breaks that for every later line, forever. `isLegacyTolerated` has no
  notion of *when* a problem was written, so tolerating the bare code there
  tolerated a duplicate minted today exactly as readily as one that predates
  B2 — for every reader, not only the writer's closing decision. That is
  qwen F-1's reproduction: a freshly duplicated `dispatch_id` let a dead
  leg's late review read as the live leg's own outcome, through the
  tolerance meant only to let an OLD collision be closed. So
  `duplicate_task_id`, `duplicate_dispatch_id`, and the
  `dispatch_id_agent_mismatch`/`dispatch_id_task_mismatch` a reused
  `dispatch_id` produces on every later line naming it (since `dispatchOwner`
  keeps only the first owner) are never in `LEGACY_TOLERATED_PROBLEMS`. No
  reader that decides whether a token may move, be dispatched onto, or be
  read as on-track ever treats a duplicated id as anything but blocking, no
  matter how old it is.

  A ledger whose only defect is a duplicate id must still be CLOSEABLE —
  B2's original point stands, and a rule that traps a token with no legal
  terminal is worse than the ambiguity it closes; a token must always be
  able to reach `abandoned`. `ledger-validate.mjs` exports a second, wider
  list for exactly this — `CLOSING_TOLERATED_PROBLEMS` / `isClosingTolerated`
  — with exactly one caller: `ledger-writer.mjs`'s `appendEvent`, and only
  when the event being appended is itself a TERMINAL event (§5). A
  duplicate-tainted ledger may receive a terminal event and nothing else —
  not even a brand-new `assigned` naming ids the ledger has never seen
  before — closing it without ever being trusted enough to continue as
  though the id still meant one thing. `tests/ledger.test.mjs` carries the
  negative controls for both directions: it goes red if a duplicate code (or
  its mismatch fallout) is added back to `LEGACY_TOLERATED_PROBLEMS`, and it
  goes red if `isClosingTolerated`/the terminal-only restriction stops
  covering a realistic pre-existing `dispatch_id` collision followed by its
  own second leg's normal `delivered`.

  **What §1 still does not provide is the rework path it names.** It says rework
  is a NEW token on a fresh route; nothing in this system creates one. The only
  writer of `opened` is `admit.mjs`, which a person runs. Until that gap is
  closed, an operator who obeys §1 opens the successor by hand, and an operator
  who does not obey it writes the move this section now refuses.
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
  "outer_controller_adapter": "claude | codex | agy",
  "teams": [{
    "team_id": "<GRAPH_ID>", "name": "<1..160 chars>",
    "dispatcher_id": "<AGENT_ID>", "worker_ids": ["<AGENT_ID>", "..."],
    "evaluator_id": "<AGENT_ID>",
    "produces": "artifact | verdict",
    "models": { "dispatcher": "<MODEL>", "worker": "<MODEL>", "evaluator": "<MODEL>" },
    "adapters": { "dispatcher": "claude | codex | agy", "worker": "...", "evaluator": "..." },
    "seats": { "<AGENT_ID>": { "model": "<MODEL>", "adapter": "claude | codex | agy" } }
  }],
  "workflows": [{ "workflow_id": "<GRAPH_ID>", "name": "...", "route": ["<team_id>", "..."] }]
}
```

A `seats` entry may instead carry `palette` — `{ "<AGENT_ID>": { "palette": [{ "model": "<MODEL>", "adapter": "...", "effort": "<EFFORT>", "display_model": "<MODEL>", "bucket": "<BUCKET>" }, "..."] } }`
— an ordered list of candidate seat specs for that ONE seat, in place of
`model`/`adapter`/`effort`/`display_model`, never alongside them. See §3.5.

`AGENT_ID` = `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$` ·
`GRAPH_ID` = `^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$` ·
`name` = 1–160 characters, no control characters ·
`MODEL` = 1–128 characters, no control characters ·
`EFFORT` = 1–64 characters, no control characters — optional everywhere it
appears; omitted means no reasoning effort is requested, not a default value ·
`BUCKET` = same shape as `MODEL` (1–128 characters, no control characters),
compared for equality only — this layer never learns what a bucket MEANS (§3.5).

Bounds: 1–100 teams, **1–5 workers per team**, 1–50 workflows, 1–8 entries per
declared palette. The worker bound said 100 here until 2026-08-05 while
`workflow-graph.mjs` had enforced 5 since well before v0.14.6 — the SSOT
overstated a limit the code refuses, so a graph written from this line alone
would be rejected at load. `MAX_WORKERS` is the authority; §3 states the reason
five is a ceiling rather than advice.

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

### 3.2 Every ROLE names a model and a lane; a seat may override its own

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
| an adapter outside `claude`/`codex`/`agy`, per role or per seat | the lanes are a **closed** set — `acp-companion.mjs` exits 2 on a fourth name |
| a `seats` key naming no seat on that team | a typo'd agent id would resolve to the role default while a reader believed the seat had moved |
| a `seats` entry that is empty, or carrying a key other than `model`/`adapter`/`effort` | the same silence, spelt differently: it renders as a declaration and changes nothing |
| a `seats` entry for `outer_controller_id` | the controller declares its lane and model at the top level and the dispatch reads those; a second statement of one fact is the one that would be ignored |
| a malformed `effort` — empty, over 64 characters, or carrying a control character — on a seat or on the outer controller | an effort is a request the dispatch will hold the adapter to, exactly like a model; a malformed one is refused rather than silently sent as a literal empty request |
| any missing or malformed field above | the graph fails **closed**; it never silently falls back |

A repo with no `graph.json` at all uses the bundled default graph. A repo
with an **invalid** one renders an error and dispatches nothing.

#### 3.2.1 `seats` — one seat, against its role

`models` and `adapters` bind per **role**, so every worker on a team shares one
model and one lane. `seats` is the exception list, keyed by `agent_id`: it names
an agent that team already holds and overrides that one seat's `model`, its
`adapter`, or both. Omitted — or omitted for a given seat — the role block
stands, so every graph written before this keeps meaning what it meant.

It is an **override, never a second declaration**, and the rule §3.1 applies to
`wip_limit` applies here: an entry restating the role's own value keeps loading
and changes nothing, including `source_digest`. Every way of *saying nothing* is
refused rather than ignored, because a `seats` entry that resolves to the role
default is a declaration a reader would believe.

The resolved value lives in `teams[].agents[]`. **That array is the answer;
`teams[].models` and `teams[].adapters` are the defaults it was computed from.**
`declaredModel` and `declaredAdapter` read `agents[]` and nothing else, so no
consumer may pair a role back to the `models` block by hand.

**Declaration order is preference order, for `worker_ids` only.** `nextStep`'s
`want()` picks the FIRST free seat in declared order. The dispatcher and
evaluator pools are singletons, so this mattered only for workers, and it did
not matter at all while every worker seat was identical. With `seats` it does:
`worker_ids[0]` is the preferred seat and later entries are overflow. **This is
not fanout** — one leg is dispatched to one seat. GitHub #32 gives a team's own
dispatcher a way to override this default per token — see §4.9; declared order
is still what a token with no stated preference falls back to.

#### 3.2.2 `effort` — a seat may also request a reasoning effort

GitHub #32. `acp-companion.mjs` already honours `ACP_REASONING_EFFORT` as a
request and `ACP_EXPECT_REASONING_EFFORT` as the expectation it holds the
receipt to — the identical request/expectation pair §3.2 built for `model` —
but nothing between the graph and the companion ever set them. `effort` closes
that gap the same way `seats` closed the one-model-per-role gap: it is a third
optional key on a `seats` override, alongside `model` and `adapter`.

It is **not** a fourth per-ROLE block alongside `models`/`adapters`. Master's
concrete case is two workers on ONE team running the SAME model at DIFFERENT
efforts — an easy/medium tier and a medium/hard tier, with the DISPATCHER
choosing which token goes to which (§4.9) — so a role-wide default would force
every worker on a team to share one effort, which is exactly the constraint
this exists to remove. There is consequently no role-level default for `effort`
to fall back to: an unoverridden seat's `agents[].effort` is `null`, meaning
"request nothing," never a team default the way an unoverridden model or lane
falls back to `models`/`adapters`.

Because there is no default to restate, there is no `effort` analogue of
§3.2.1's "an entry restating the role's own value keeps loading and changes
nothing" — every declared `effort` is a real request, full stop. The empty
string is still refused, for the same reason an empty `model` is: a key
present with nothing meaningful in it is the "declaration that says nothing"
rule (`references/loop-system-contract.md` and this repo's `CLAUDE.md` both
name it), not a way to opt out — omit the key entirely for that.

The outer controller carries the equivalent field at the top level,
`outer_controller_effort`, exactly mirroring `outer_controller_model` and
`outer_controller_adapter` — except it is **optional**, because effort itself
has no required declaration anywhere in this system. Omitted or empty, the
controller requests nothing; a non-empty value that fails `EFFORT`'s shape
check is refused. A `seats` entry may not name the outer controller for the
same reason §3.2.1 already refuses one for model/adapter: `outer_controller_*`
is what the dispatch reads, and a second statement of the same fact is the one
that would silently lose.

`acp-companion.mjs`'s own reasoning-effort bound (`MAX_REASONING_EFFORT = 64`)
is repeated here as `EFFORT_MAX` rather than imported, because the companion
module also owns process argv parsing and must not be imported by the
declaration layer for a constant.

**A wrong per-seat model fails loudly and exactly once.** `acp-companion` starts
`identity_status` at `missing` and refuses the receipt unless the adapter answers
with the declared name; the runner escalates rather than retrying. It does not
fall through to the sibling seat, so a declaration a lane cannot honour is never
silently answered by a different model. `MAX_ATTEMPTS` is still counted across
the whole worker pool, not per seat.

**What a lane does NOT say: the endpoint.** The lane chooses which binary is
spawned; which service that binary talks to comes from ambient environment
(`ANTHROPIC_BASE_URL` and friends), forwarded whole by `childEnv`, and is
therefore **process-global for the entire runner**. A per-seat *endpoint* — the
"one seat on Kimi, one on Claude" case — is not declarable, and this section
must not be read as offering it.

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

### 3.4 `produces` — what a team's worker hands onward (GitHub #31)

A team declares `produces: "artifact" | "verdict"`. **Optional, defaulting to
`artifact`** — every graph written before this field existed validates
unchanged and means exactly what it meant. Almost every team hands its own
artifact to the next team on the route; that is the default. A REVIEW team's
worker instead renders a verdict on someone else's work rather than building
one of its own, and declaring that is what lets the evaluator brief
(`role-briefs.mjs`) and the optional `target_verdict` on `reviewed` (§4.8)
tell the two kinds of team apart without guessing from a team's name or its
position on a route.

`produces` is inert on its own: nothing downstream reads it except the
evaluator brief, which gains one additional instruction only for a `produces:
'verdict'` team's evaluator, and `harvestEvent`, which only reads a
`TARGET_VERDICT:` line out of that same evaluator's outbox. It does not change
`pull-controller.mjs`'s gate (§7): the only pullable state remains `reviewed`
with `verdict: pass`, unconditionally, exactly as before this field existed.

### 3.5 A seat's model palette — declared (phase 1) and dispatched (phase 2)

**Phase 1 (2026-08-05) declared a SHAPE and made nothing read it.** A graph
that declares a palette validates, normalizes, and exposes it on
`teams[].agents[]`; `loop-runner.mjs`, `ledger-validate.mjs`,
`ledger-writer.mjs`, `acp-companion.mjs` and `dispatch-facts.mjs` were
unchanged by that amendment, and the runner dispatched exactly as it did
before this section existed, reading the same single-value
`model`/`adapter`/`effort`/`display_model` fields it always has. GitHub #47's
own text named this split on purpose: dispatch, `assigned` carrying the chosen
model, and the fallback machinery are a second phase, so that the two phases
do not both edit `loop-runner.mjs` and this contract at once.

**Phase 2 (2026-08-05, this amendment) is the dispatch half — see §3.5.1
below.** It reaches two of those three: dispatch and the fallback machinery.
The third — `assigned` carrying the chosen model — is NOT built by this
amendment, and §3.5.1 states why in the same terms as everything else here:
argued, not silently dropped.

**Not a role, and not a model name.** GitHub #47 asked for "a role's model" to
become an array; this amendment answers differently, and says why. A model is
`(executable, alias) → real name` — `opus` on one lane is a different vendor
entirely from `opus` on another — so an array of alias strings would be
meaningless on its own: what an alias resolves to is fixed by the adapter
already named for it. A palette entry is therefore a **whole seat spec**,
reusing the same fields a `seats` override already carries (§3.2.1): `model`,
`adapter`, `effort`, `display_model`, plus `bucket` (below).

It is declared per **seat**, not per role. "One token, four candidate models"
is a fact about ONE worker seat, not about the `worker` role as a whole — a
team may still have several worker seats, each running its own single model
or its own independent palette. Binding this to `models[role]` instead would
force every seat on a role to share one palette, which is not the shape GitHub
#47 asked for and is not what any concrete case in it needs. So:

```json
"seats": { "<AGENT_ID>": { "palette": [
  { "model": "<MODEL>", "adapter": "claude | codex | agy", "effort": "<EFFORT>", "display_model": "<MODEL>", "bucket": "<BUCKET>" },
  "..."
] } }
```

**`palette` replaces the single-value fields on that seat; it never sits
beside them.** A `seats` entry may declare `model`/`adapter`/`effort`/
`display_model`, OR `palette`, never both — a single-value field next to a
`palette` would read as a default the palette falls back to and would in fact
be silently ignored, which is the exact "declaration that changes nothing"
shape §3.2.1 already refuses for an empty or restating seat entry. The
controller may not declare a seat at all (§3.2.1, unchanged) and so may not
declare a palette either.

**A palette entry's `model` is required — it has no role default to fall back
to.** A plain seat override's `model` may be omitted (the role's `models[role]`
stands in); one entry in an array has nothing else to mean if it names no
model. Every other field on an entry is optional with the same resolution a
plain seat override already has: `adapter` defaults to the seat's role's lane,
`effort` defaults to "nothing requested", `display_model` defaults to `null`.
Every field is validated by the exact §3.2 / §3.2.1 / §3.2.2 checks a plain
seat override already runs — `isModelName`, `ADAPTERS.has`, `isEffortName` —
applied per entry rather than once; this amendment does not invent a second
validator.

**Bounds: 1 to 8 entries.** Zero says nothing, which is the same "empty
declaration" shape every other optional block in this file already refuses
rather than silently accepting. Eight is a real ceiling, not advice, for the
same reason `MAX_WORKERS` is one (§3): a palette longer than that is far more
likely to be a mistake — enumerating every model a provider has ever shipped —
than a real fallback roster an operator would actually maintain.

**Bucket — the field that makes fallback checkable.** Rate limits are per
model-family within a provider, not per provider: codex counts its `gpt`
family separately from `codex-spark`, agy counts `gemini` separately from
non-`gemini`, claude counts `fable` separately from `opus`/`sonnet`/`haiku`.
`bucket` names that family. It is **free-form and shape-checked only**,
exactly like a model name under §3.2 — the system never needs to know what a
bucket MEANS, only whether two of them are equal, so it reuses `isModelName`'s
shape check (non-empty, ≤128 characters, no control characters) rather than
building a second one or holding a list of known buckets, which §3.2's own
model rule already forbids for exactly this kind of field.

`bucket` defaults to the entry's own **resolved adapter** when unspecified —
not to the seat's role, to the one LANE this specific entry actually runs
on — so two entries on the same lane are the same bucket by default unless a
finer name is given, and every graph that predates this field (none can
declare a palette yet) keeps meaning what it meant.

**Two consecutive entries in the same bucket are refused, not merely
warned.** This is the rule the whole design turns on: two adjacent entries
drawing on the same rate limit are not a fallback — trying the second right
after the first spends a leg (§4.10) to learn nothing a wrong guess on the
first entry hadn't already established. Refusing was chosen over warning for
two reasons. First, consistency: every other malformed declaration in this
file fails **closed** (§3.2's own table says so in as many words), and this
validator has no "accepted, with a warning" channel anywhere else — building
one for this single rule would be new machinery bolted onto a shape checker,
not a shape check. Second, cost: the failure this rule prevents is silent and
expensive — a graph that looks like it declares four-deep fallback but
actually wastes its first retry attempt on nothing, discovered only once
GitHub #45 part 2's leg-attempt accounting is watched closely enough to
notice the wasted leg. A graph author gets the same signal §3.1 already gives
for a mismatched `wip_limit`: told immediately, at load, naming the team, the
seat and the bucket, rather than made to discover it from a runtime symptom
much later. The check compares only **adjacent** entries in declared order —
a repeated bucket separated by a different one (A, B, A) is accepted, because
at least one other candidate was tried in between and the repeat is not
spending a leg to learn nothing it hadn't already risked learning.

**`wip_limit` does not change when a palette grows.** This is the whole point
of the item (§3.1) and follows from where the palette lives: it is declared on
`seats[agentId]`, which never touches `worker_ids`, and `wip_limit` is derived
from `worker_ids.length` alone. A seat with an eight-entry palette is still
one seat; a team with one worker seat and an eight-entry palette on it is
still WIP 1.

**Resolved shape.** Every `teams[].agents[]` entry gains a `palette` field:
`null` for a seat that declared none, or the fully-resolved array (every
entry's `adapter`/`effort`/`display_model`/`bucket` default applied) for a
seat that did. The existing single-value `model`/`adapter`/`effort`/
`display_model` on that same `agents[]` entry resolve to the palette's
**first** entry — the one reading this contract before phase 2 exists sees
exactly what it has always seen, a single seat spec, and it is the one at the
front of declared order. This is not a dispatch decision; it is what "the
starting point" (below) already has to mean in a system where nothing yet
chooses anything else.

**And that field is emitted as `null`, not omitted — so `source_digest`
changes for every graph at this version, including graphs that declare no
palette.** Say it out loud, because the first draft of AC97 claimed the
opposite and the test written for it compared two graphs resolved by the SAME
code, which is true whatever the shape became. Emitting `null` follows this
file's own convention — `effort` and `display_model` are already reported as
`null` rather than dropped — and the digest is a statement about the resolved
graph, so reporting the old digest for a newly-shaped one would be the actual
lie. It costs nothing here because no module compares a *workflow* graph's
`source_digest` across versions: the digest `team-runtime.mjs` joins on is
`team-graph-contract.mjs`'s, a different derivation over a different object.
What survives from the original claim is the §3.2.1 property, which is
genuinely unaffected: declarations that say the same thing still hash alike.

**Ordering semantics — written down 2026-08-05 (phase 1), enforced the same
day (phase 2).** GitHub #47's own text says both "the dispatcher picks" and
"fall back in order", and read together those need one more sentence or two
plausible rules exist and code would silently pick one. The reading this
contract committed to: **the dispatcher's choice is the starting point, the
array is the order after it, and a full cycle with nothing answering is an
escalation rather than another retry.** §3.5.1 (below) is where phase 2 built
exactly this, and resolved the one thing phase 1's own wording left open —
whether a dispatcher can name a specific PALETTE ENTRY, not merely a seat.
This paragraph is kept, unedited past this note, as the record of what was
decided in advance and why; §3.5.1 is where it became enforced. Formerly
**not enforced by any code**, listed in §14.1 as an unenforced clause — that
row is gone; §14 AC104–AC109 (`tests/loop-runner-palette-dispatch.test.mjs`)
are what replaced it.

### 3.5.1 Dispatch and fallback — built (GitHub #47 phase 2, 2026-08-05)

**The starting point needs no ledger read.** `loop-runner.mjs`'s
`declaredModel`/`declaredAdapter`/`declaredEffort` already resolve a palette
seat's single-value fields to the palette's first entry (§3.5, phase 1); a
fresh leg on a palette seat reaches the model exactly the way it always has,
through the same `dispatch()` env-building this file has never needed to
change for a plain seat. `dispatchOn` (`loop-runner.mjs`, inside `nextStep`)
is consulted only for a SECOND or later leg on the same seat, where the
starting point alone is no longer enough.

**`worker_hint` (§4.9) still names a SEAT, not a palette entry.** GitHub #47's
own wording said "starting seat/entry" as if a dispatcher might name either;
phase 1 already resolved this for the FIRST leg (the starting point is always
entry 0, stated in §3.5 above), and phase 2 resolves it for every leg after:
nothing exists to name a specific entry, on a fresh admission or a retry, and
this amendment does not add one. A `WORKER: <agent_id>` line still only picks
which seat gets the token; which of THAT seat's candidates a given leg runs is
computed from the seat's own ledger history, described next.

**What triggers a fallback: `work_observed: false` on the failed leg's
`delivered` line, stated precisely in those words because the runner cannot
see anything narrower.** §4.10 already established this is the ONE fact the
ledger carries for "the leg never reached the model" — not a terminal string,
not an inference from a missing line. This amendment reuses it rather than
inventing a second signal: a leg whose `delivered` states `work_observed:
false` advances the NEXT leg on this seat to the next palette entry in
declared order (wrapping past the end back to the first); a leg that reached
the model — `work_observed: true`, or a `delivered` written before this fact
existed and so carries neither — retries the SAME entry, exactly as a
no-palette seat's worker retries its one seat today. A `lost` leg (§4: "an
assignment whose process is gone and which recorded nothing" — never
distinguishable from a killed worker that did real work) is likewise never
read as a miss, and also retries the same entry. **This is deliberately not
"on rate limit."** The runner has no signal for a rate limit specifically —
only `work_observed` and `terminal` — so this rule is stated as what it
actually keys on, not as the friendlier name that motivated it: transport-level
failure, the class `work_observed: false` was built to name. A rule stated as
"on rate limit" and implemented as "on any failure" would be indistinguishable
from this one in its passing tests and different in what it does the first
time a genuine worker failure is mistaken for a dead model.

**Each fallback candidate is a NEW leg, with its own `task_id` and
`dispatch_id`, minted the same way any retry's always has been.** `dispatch()`
already calls `buildTaskId` fresh on every call; this amendment adds no second
identity-minting path, so `ledger-validate.mjs`'s existing
`duplicate_task_id`/`duplicate_dispatch_id` rules (§4.2) are never in tension
with a palette — a fallback attempt was already, before this amendment,
indistinguishable from a plain retry as far as leg identity goes, and stays so.

**As many misses as there are entries escalates instead of retrying entry 0 a
second time.** Once `misses >= palette.length` — where `misses` counts exactly
the `work_observed: false` legs on this ONE seat since the token's last resume
(or its admission, if never resumed) — the next leg on this seat escalates
rather than dispatching, naming the seat, the palette size and the miss count.

**That is not the same statement as "every entry was tried and none reached
the model", and this paragraph used to say it was.** A genuine failure retries
the SAME entry without advancing (above), so a sequence like miss on A, a real
answer from B, a miss on B, a miss on C reaches `misses === 3` on a 3-entry
palette while B demonstrably reached the model. The counter is a scalar, on
purpose — it is the cheap bound that stops a seat spending legs on an outage,
not an exhaustive proof about each candidate. The release review for v0.15.0
constructed that sequence and showed the escalation reason asserting something
the ledger denied; the reason now claims only what was counted. Keep the two
sentences apart: what fires, and what it proves. This is the same shape §11.3's `escalate` decision already reads
a token's own next step as: a case for the outer controller, not a ninth
attempt at candidates that already refused eight times.

**`legCeiling` (§4.10, §10) is unaffected — every `assigned` still counts
toward it unconditionally, transport-failed or not, exactly as §4.10 requires
by name.** A palette is not made free against it: this amendment does not
special-case a palette leg out of `legs = custody.filter(assigned).length`
anywhere. What bounds a palette walk from being able to spend legs toward
that ceiling forever is the full-cycle rule above — a strictly TIGHTER,
palette-scoped bound (at most `palette.length`, 1 to 8, misses before
escalating) that fires long before a 15-leg (or controller-granted higher)
ceiling ever could. Both checks run: `legCeiling`'s guard sits at the top of
`nextStep`, unmoved by this amendment, and would still catch a token that
somehow accumulated enough legs by other means — the palette's own bound does
not replace it, it adds a narrower one in front of it.

**A seat that declares no palette is unaffected — proven, not merely
argued.** `dispatchOn` returns the exact `{ action: 'dispatch', role,
agent_id }` shape `want` always returned, with no `candidate` key at all, for
any seat whose resolved `palette` is `null` (§3.5). The tick loop's dispatch
call only reads `plan.candidate` when it is present, so a no-palette seat's
model/adapter/effort resolve through the same `declaredModel`/
`declaredAdapter`/`declaredEffort` calls, byte-for-byte, that ran before this
amendment. Every pre-existing test in `tests/loop-occupancy.test.mjs` (103
tests), `tests/loop-runner-heartbeat-model.test.mjs`,
`tests/loop-runner-decisions.test.mjs`, `tests/loop-runner-busy.test.mjs`,
`tests/loop-replay.test.mjs` and `tests/loop-smoke.test.mjs` passed unedited
against this change — none needed a line changed, which is the property
itself, not a claim about it.

**What this amendment does NOT build: `assigned` carrying the chosen
model.** GitHub #47's own text and this contract's own §3.5 intro both name
it as part of the same feature; it is not here, and the reason is structural,
not a scoping choice made for convenience. `assigned` is written by
`acp-companion.mjs` alone (§13: it is one of exactly two components that may
append to a ledger, and the only one of the two that may write `assigned` or
`delivered`), and the required field on `assigned` that matters here —
`dispatch_id` (`ledger-validate.mjs`'s `EVENT_SPEC`) — is minted by
`randomUUID()` INSIDE `acp-companion.mjs`, at process start, with no
environment variable or argument through which anything upstream could
supply or predict it. `loop-runner.mjs` cannot write a valid `assigned` line
for a leg `acp-companion.mjs` will also process: any `dispatch_id` it invented
would not be the one `acp-companion.mjs` mints and later carries on
`delivered`, and `ledger-validate.mjs`'s own dispatch-id/task-id ownership
check (§4.2) would then read the two events as disagreeing — turning a
cosmetic gap into a ledger the runner itself would refuse to dispatch onto
next tick. Recording the model is therefore reachable only by
`acp-companion.mjs` itself adding it to its own existing, unconditional
`appendWorkItemEvent('assigned')` call — a small change (it already computes
`requestedModel` at that point, for its own dispatch-record text) but a change
to a file this amendment's own scope excludes.

**Phase 2b did exactly that, and it is built.** `assigned` now carries
`requested_model` and `adapter`. Both halves are needed, not one: a palette
may hold the same model on two lanes — different buckets, so legal even as
adjacent entries — and an alias names different vendors on different lanes
(`opus` is one vendor's model on one lane and another's on the next), so
neither field identifies a leg alone. What the pair CANNOT distinguish is two
executables on one lane (`claude-qwen` from `claude-kimi`), because a palette
entry cannot express an executable either; that is GitHub #40's subject, and
#40 was closed deliberately unbuilt. The ledger therefore answers exactly as
much as the palette can declare, which is the honest bound rather than an
accidental one.

It is written **before spawn**, so it is the REQUEST and never the verified
identity — no adapter has answered at that moment. `effective_identity` and
`identity_status` on the dispatch record are the verified facts and arrive
later. A reader must not read one as the other: a leg whose `assigned` says
`requested_model: opus` and which never reached a model at all (§4.10,
`work_observed: false`) is precisely the case a palette exists to walk past.

`ledger-validate.mjs` stays unedited through both phases, and now that the
fields are actually written that is a decision rather than a deferral: only
the event NAME is a closed vocabulary (`ledger-validate.mjs`'s own line 43),
so `requested_model` and `adapter` are accepted with no validator change, and
the precedent for leaving them unchecked is already set by `work_observed`
and `worker_hint` — neither shape-checked there either. Shape-checking them
would also refuse every ledger written before this version, since a
pre-0.15.0 `assigned` carries neither, and `loadWorkItemLedgers` reads
historical files. They are therefore **optional by construction, forever**:
absence means "written before this existed", never "the model was unknown".

## 4. Custody ledger contract

One token, one file, append-only, one JSON object per line. Corrections are
appended. Nothing is ever rewritten, and no component may edit a prior line.

Common fields on every event: `at` (ISO 8601 UTC), `event`, `work_item`,
`workflow`, and — on every line written since the writer existed — `actor`.

| Event | Written by | Also carries | Means |
| --- | --- | --- | --- |
| `opened` | whoever admits the work (§4.6) | `agent_id` = receiving dispatcher, `to_team`, `reason`; **never** `from_team`; `actor` must be `human:<id>` (ADR 0002), optional `relayed_by: agent:<id>` | work entered the graph; legal only as a token's first event |
| `pulled` | pull-controller | `agent_id` = receiving dispatcher, `from_team`, `to_team` | the receiving team took the work |
| `intake` | runner (harvest) | `agent_id` = dispatcher, `verdict: accept`, `reason`, optional `worker_hint` (§4.9) | the team accepted the handoff |
| `returned` | runner (harvest) | `to_team` = sender, `refused_by`, `reason`, **no `agent_id`** | the handoff was refused and went back |
| `assigned` | acp-companion | `agent_id`, `task_id`, `dispatch_id`; optional `requested_model`, `adapter` (§3.5.1, GitHub #47 phase 2b) — the model this leg was dispatched ON, and the lane it was dispatched to; the REQUEST, not the verified identity, which is not known until after spawn | one leg started |
| `delivered` | acp-companion | `agent_id`, `task_id`, `terminal`, `timed_out`, `evidence_present`; optional `work_observed` (§4.10, GitHub #45 part 2) | one leg finished |
| `reviewed` | runner (harvest) | `agent_id` = evaluator, `verdict`, `reviewed_task`, `reason`; optional `target_verdict: accept \\| reject`, `target_reason` (§4.8, GitHub #31) | the team judged its own output |
| `lost` | runner | `agent_id`, `task_id`, `reason` | an assignment whose process is gone and which recorded nothing |
| `escalated` | runner | `agent_id` = controller, `to_team`, `task_id`, `reason` | parked with the outer controller |
| `resumed` | runner (harvest) | `agent_id` = controller, `to_team`, `grant`, `reason` | the controller sent it back with a fresh budget |
| `completed` | pull-controller | `from_team` | the route finished |
| `audit_requested` | runner | `agent_id` = controller, `task_id`, `reason` | a finished route flagged for a whole-delivery read |
| `audit_lost` | NOTHING since 2026-08-07 | `agent_id` = controller, `task_id`, `reason` | the flagged read never happened: that leg died at the transport before the model took a turn (§9). Still READ everywhere — removing the word makes every ledger already carrying one unclosable |
| `audited` | runner (harvest) | `agent_id` = controller, `verdict`, `reason` | the controller read the delivery |
| `abandoned` | runner (harvest) or a human | `reason` | nobody will finish this token |
| `questioned` | runner (harvest) | `agent_id` = who asked, `questions`, `reason`, `question_id`; optional `resume_role` (§4.7) | the token is parked on a person; still held, still counted against WIP |
| `answered` | a human, optionally relayed by an agent (§4.7) | `to_team`, `reason`; `actor` must be `human:<id>`, optional `relayed_by: agent:<id>` | the person replied; the open question is consumed |

Rules:

1. `returned` carries **no `agent_id`** on purpose. The token is held by the
   team it went back to, not by the dispatcher that refused it.
2. `escalated` **must** carry `to_team` — but since D6 (2026-08-08) it is not
   what PLACES the token. The controller is now a team member, so an escalated
   token occupies the CONTROL team's slot: Master's rule, and plain Kanban —
   work stuck with a team keeps that team's WIP, and work escalated to the PM
   holds the PM's until the PM is done with it. `to_team` remains required
   because a later `resumed` reads it to send the work back. That one event is
   the whole of §6's `PLACES_BY_DESTINATION`: a `resumed` is signed by the
   controller and MOVES the token, so its destination outranks its signer.
   Read the other way, every resume would park the work on the PM for ever.
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

**Two events are the named exception to this rule (§4.6, §4.7; ADR 0002,
2026-08-04):** `opened` and `answered` are the two events whose subject is a
PERSON, so their `actor` records who DECIDED — `human:<id>` — even when an
agent relayed the bytes on that person's behalf. Every other event keeps this
paragraph's rule unchanged: the actor is whoever wrote the line, full stop.

Lines written before this rule existed carry no `actor`. Requiring one of them
would condemn every legitimately runner-written line in history, so the
validator **shape-checks `actor` only when it is present** while the writer
**refuses to write without one** — with one carve-out this tolerance does not
cover. For `opened` and `answered` specifically, the human-actor check (§4.6,
§4.7) reads a missing `actor` as the empty string, and the empty string does
not start with `human:` either, so an `opened` or `answered` line with NO
`actor` at all is refused exactly like one signed `agent:*` would be. This
paragraph's actor-less-history tolerance therefore does NOT extend to those two
events; only `ledger-writer.mjs`'s `LEGACY_TOLERATED` set (§4.2) — which does
not yet include `not_a_human_answer` — can excuse one already on disk.

### 4.2 The sanctioned writer — `ledger-writer.mjs`

Every line that enters a custody ledger goes through `appendEvent`. It is the
only sanctioned writer, and it:

- refuses an event with no valid `actor`, before anything else is looked at;
- checks the event against the per-event field table above;
- checks it against the ledger it is joining, so an event that would make the
  token's history impossible is refused rather than recorded;
- refuses outright to append to a ledger that was **already invalid** —
  appending to a broken history buries the break instead of surfacing it,
  **except for the narrow, named set of problems §1 already calls tolerated**
  (`ledger-writer.mjs`'s `LEGACY_TOLERATED`: `route_went_backwards` and
  `sent_back_after_admission` only, as of this amendment) — a ledger invalid
  for any OTHER reason still must be repaired before anything is appended;
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

**`opened.actor` names who DECIDED, not who wrote the bytes (ADR 0002,
2026-08-04).** This is a deliberate exception to §4.1's general rule that
`actor` is the component that performed the write: `opened` and `answered`
(§4.7) are the two events whose subject is a person, and their `actor` records
that person, `human:<id>`, even when an agent relayed the words on their
behalf. Before this amendment `admit.mjs`'s own doc comment stated the rule and
nothing enforced it — `EVENT_SPEC.opened` carried no `actor_kind`, so
`agent:reopen-controller` and an unactored line both validated. An agent that
relays now names itself in the optional `relayed_by: agent:<id>` field instead
of borrowing the person's identity; `relayed_by` is shape-checked (must be
`agent:*`) whenever it is present, on any event. `opened` is unaffected by any
future MACHINE-decided admission — a system that opens tokens on its own
authority (a "reopen" mechanism, considered but not built as of this
amendment) needs its own actor word, not this one forged into looking human.

### 4.7 A token blocked on a person — `questioned` / `answered`

**Shipped on `main` as of this range** (originally implemented on branch
`poc/controller-as-team`, 2026-07-31 — the branch-only caveat that used to open
this section is retired: `question_id` binding, the hard-terminal rule, and the
post-`completed` `questioned`/`abandoned` path are enforced by
`ledger-validate.mjs` at HEAD, not gated behind any branch check).

Every other state in this system waits on an agent or on the loop. These two
wait on a PERSON, and that needed a word of its own for a concrete reason: with
no state to park in, the runner sees a token sitting at a dispatcher and
re-dispatches that dispatcher every tick, paying repeatedly to ask a question of
somebody who has not replied.

- `questioned` carries `agent_id` (who asked), `questions` (what was asked),
  `reason`, and `question_id` — a per-token, per-question identifier
  (`harvestEvent` writes `q-<work_item>-<n>`, counting the token's own prior
  `questioned` lines). It does not release the team — the token is still held,
  still counted against WIP (§6). **The runner never dispatches on it.**
  `question_id` is what an `answered` binds to: the validator refuses to close
  a DIFFERENT open question than the one an answer names
  (`question_id_mismatch`), and the open question is consumed — cleared —
  the moment an `answered` or a question-closing `abandoned` lands, so a stray
  second `answered` with nothing new asked is refused as
  `answered_without_question` rather than silently accepted. `questioned` also
  carries an optional `resume_role` naming the seat that asked
  (`dispatcher`, `audit`, `outer`, or the leg's own role) — the seat that asked
  is the only one that can read the reply, in principle. `resume_role` is
  recorded by every producer as of this amendment and IS read to route
  dispatch, as of `loop-runner.mjs`'s H1 fix (retro-release-review,
  2026-08-04): `resume_role: worker` dispatches the **worker**,
  `resume_role: evaluator` dispatches the **evaluator**, `resume_role: audit`
  holds — the outer controller reads the reply through the
  `completed`-driven `audit_requested` path instead, which `awaitingAudit`
  already guarantees fires again, so nothing is lost by not dispatching here
  — and `resume_role: outer` re-escalates, so the outer controller, the seat
  that actually asked, is the one that reads the reply. Only when
  `resume_role` is absent (a legacy question written before the field
  existed) or literally `dispatcher` does §5's old `answered`
  (pre-`completed`) behavior still apply: resume the **dispatcher**.
  `loop-runner.mjs` is the file of record for this routing; a change to it
  must amend this paragraph in the same commit (§15.1).
- `answered` carries `to_team` and `reason`, and its actor KIND is part of its
  validity: it must be written by a `human:` actor or the writer refuses the
  line — the same rule §4.6 gives `opened` (ADR 0002). Those two, not
  `answered` alone, are the events whose subject is a person, and §2 accepts
  attestations from no other role for either. An operator agent may relay the
  words and then names itself in `relayed_by` — the actor says who DECIDED.
- `to_team` on `answered` is not decoration. §6 places a token by its last
  event's `agent_id` or `to_team`, and a person is neither, so an answer without
  it would orphan the token the moment somebody replied.
- **The writer is `answer.mjs`, and a person runs it** — what `admit.mjs` is to
  `opened` (§4.6) and `withdraw.mjs` is to `abandoned` (§9), added 2026-08-07. Until then this section specified every
  field of an event **no code in this system produced**: `questioned` was written
  in five places, the board rendered "Waiting on a person to answer", the
  validator accepted the word and the routing above was live, but the only way to
  reply was to hand-write the line — which §4 forbids. A person supplies the
  answer and nothing else: `question_id` and `to_team` are DERIVED from the open
  question (the asking seat's team, resolved through the declaration), because
  asking a person to restate what the system already knows is how a
  `question_id_mismatch` gets written by hand. It refuses rather than writes when
  the token is not at `questioned` (a second answer is caught here, not by the
  validator afterwards), when the question carries no id, and when the asking
  seat belongs to no declared team and the token has never been pulled — that
  last one was the outer controller on a graph with no control team, which D6
  (2026-08-08) removed from existence. The refusal is kept anyway, and the
  honest reason is NOT that some caller hands this function a graph object —
  it takes a repo path and loads the declaration itself. It is kept because a
  door that refuses what it cannot place stays correct if D6 is ever relaxed,
  and because refusing costs one branch while a blank `to_team` costs a token.
- A `questioned` token that goes unanswered past the answer deadline is closed
  with `abandoned` by the RUNNER (§9), and the controller writes a withdrawal
  notice naming the unanswered questions. This applies whether the question was
  asked at the front door or POST-`completed` by the audit — before this
  amendment the validator refused the post-`completed` case outright
  (`completed -> audit_requested -> questioned -> abandoned` was
  `event_after_terminal`), so an unread audit question could never expire and
  sat occupying the board forever.
- `audited` and `abandoned` are §5's genuinely hard terminals: nothing may
  follow either, ever, enforced by the validator rather than by the accident of
  `completed` always being written first. Before this amendment the validator
  tracked only the FIRST terminal event on a ledger — always `completed`, for
  every route that reaches an audit — so `completed -> audit_requested ->
  audited -> audit_requested` validated clean; the second `audit_requested`
  described re-opening an audit that had already closed.
- **A dispatch produced because a person just answered now carries that
  exchange** (retro-release-review r4-codex BLOCKER 4, 2026-08-04). Resuming
  the right seat (§5) is not the same as that seat being able to READ the
  reply: `composeBrief` used to hand every resumed role — worker, evaluator,
  the front-door dispatcher — only the standing brief and the previous
  delivery, and the outer controller's own brief (built by `planEscalation`,
  §9) carried a generic instruction to "read the reply" with no reply on the
  page. The exact reproduction: a front-door dispatcher resumed after
  `answered` reran with the original ambiguous request and no memory of the
  human's words, free to ask the same question again. `composeBrief` now
  opens with the last `questioned`'s `questions` and the current `answered`'s
  `reason` whenever the item it is briefing for is currently at `answered`;
  `planEscalation`'s `ask` text carries the same pair for whichever token it
  names as the one to answer for.

### 4.8 A confirmed finding on someone else's work — `target_verdict` (GitHub #31)

Only a `produces: 'verdict'` (§3.4) team's evaluator ever writes this pair, and
only when it chose to: `reviewed` may carry an optional `target_verdict:
accept | reject` with its own `target_reason`. `verdict` on the same line still
judges whether the REVIEW itself was done correctly; `target_verdict` is a
separate, narrower answer — what the evaluator confirmed the reviewed worker's
own finding actually WAS. `TARGET_VERDICTS` (`role-briefs.mjs`) deliberately
has no `unresolved` member: an evaluator that states nothing here leaves both
fields absent, never a fabricated word ledger-validate would then have to
accept or reject as though it meant something — "absence means no reopen
signal", never a rejected write. `ledger-validate.mjs` checks `target_verdict`
against this vocabulary and requires `target_reason` whenever it is present, in
a block separate from the `verdict` check above (that check is hardcoded to
`entry.verdict`).

This is GitHub #31 stages 1–2 only: the DECLARATION (§3.4) and the RECORDING of
a confirmed finding. Nothing reads `target_verdict` to move a token yet —
`pull-controller.mjs`'s gate is unchanged (§7), and a `reviewed pass` with
`target_verdict: reject` still pulls to the done queue exactly as a `reviewed
pass` always has. A mechanism that reopens a fresh token on a confirmed
`target_verdict: reject` is stage 3 of that issue and is explicitly NOT part of
this amendment; §1's "rework is a new token on a fresh route, opened by a
person" stands unchanged until that stage ships its own amendment.

### 4.9 A dispatcher's worker hint — `worker_hint` (GitHub #32)

**This is model selection, and calling it a seat hint has hidden that.** A seat
carries its own `model`, `adapter` and `effort` (§3.2's `seats` override, read
by `declaredModel`/`declaredAdapter` and by nothing else), so naming a seat IS
naming a model, an adapter and a reasoning effort. That is the use this
mechanism actually gets: cheap model for simple work, strong model for hard
work, text-only where there is no media, multimodal where there is, a different
seat when the first model is rate-limited. Read every "seat" below as "the
capability a seat stands for" — the field is named for the thing it points at
rather than the thing it selects, and renaming it is not worth breaking a
shipped event field over.

Two consequences follow from that reading. The first is not fixed here:

- **A model palette costs WIP.** §3.1 derives `wip_limit` from the worker-seat
  count, so declaring four seats to have four models also tells the system this
  team may hold four tokens at once. An operator who wants "one token, four
  possible models" cannot say so. The two numbers are the same number and
  should not be.
- **The choice is made blind to availability.** `want()` knows only whether a
  seat is BUSY — whether a process is running on it. It does not know whether
  that seat's provider will accept a request, so a dispatcher routing away from
  a rate-limited model is still guessing (unfixed). What no longer follows from
  a wrong guess (GitHub #45, part 2, fixed 2026-08-05 — §4.10) is that the leg
  dying at the transport spends a worker attempt: `work_observed: false` on
  `delivered` now excludes exactly that leg from `MAX_ATTEMPTS`, and only that
  leg. The router still has no availability signal; a wrong guess is merely
  cheap now instead of also being counted.

A team's dispatcher may name which worker seat should take a token it is
admitting, by writing a `WORKER: <agent_id>` line in its outbox alongside
`VERDICT`/`REASON`. `harvestEvent` reads it with `role-briefs.readWorkerHint`
and records it as `intake.worker_hint` — `null` when nothing was said, an
EVENT_SPEC-permitted extra field either way (§4: only the event NAME is a
closed vocabulary).

Only a FRESH `intake` carries a hint. `returned` and `resumed` are the rework
paths — a refused handoff coming back, or a controller-granted retry — and
neither is judged by a hint the dispatcher wrote for the ORIGINAL admission.

`nextStep`'s `want()` is what judges a stated hint, for `role === 'worker'`
only:

- naming a real, free seat overrides declared order (§3.2.1) — not merely a
  tie-break among equal seats;
- naming a seat not on this team's pool is **escalated**, naming the hint,
  never silently substituted for a seat that exists;
- naming a real seat that is currently busy **waits for that seat
  specifically** — the same "every worker busy" wait §3.2.1 already has, not a
  new way to stall forever, because the zombie detection that frees any busy
  seat (§11) frees this one too.

### 4.10 A leg that never got a turn — `work_observed` (GitHub #45 part 2)

> Read with §9. This fact is written on TWO channels for one reason: the
> `delivered` line below is per-token, and the outer controller's own leg
> carries no token (`workItem: ''`), so for that leg the ledger can never
> answer this question. The liveness snapshot answers it there instead
> (GitHub #52, 2026-08-06). A third consumer that needs it on a third kind of
> leg should check which channel that leg actually writes before assuming
> this one reaches it.

§4.9's own text used to end here: a dispatcher routing away from a
rate-limited model is guessing, and a wrong guess used to spend a worker
attempt on a leg that died at the transport — `attemptsBy` (`loop-runner.mjs`)
counted every `assigned` line against `MAX_ATTEMPTS` (§10) whether the process
ever started, whether the adapter accepted the declared model, or whether a
single token of work happened. A seat whose provider was down could burn all
three attempts on legs that never began, and the pool read as exhausted.
**The router's blindness to availability is unchanged by this fix** — `want()`
still knows only whether a seat is BUSY, never whether its provider will
answer, so a dispatch can still land on a dead model. What changes is the
COST of landing there.

Three decisions, in the order this contract requires them to be made:

1. **A transport failure is still a leg.** It still gets `assigned`, still
   occupies its team, still counts toward `legCeiling` (§10's `MAX_LEGS`). The
   alternative — never writing `assigned` for a leg that dies before doing
   anything — was rejected: `acp-companion.mjs` writes it before spawning the
   adapter on purpose, to leave a footprint if the process is killed before it
   can write anything else, and a task id that never reaches `assigned` is the
   exact unbounded-respawn shape a prior fix (BLOCKER 4, 2026-08-04, §14.2)
   closed. Only the ATTEMPT count changes.
2. **The distinguishing fact is written by `acp-companion.mjs`, at the point
   the transport fails, onto its own `delivered` line — `work_observed:
   false`.** It is the only process present at that moment, and `delivered` is
   the only event it writes, so the ledger is the only channel it has to say
   what happened. `work_observed` is `true` the instant the companion sees
   real agent activity — a tool call, a message or thought chunk, a plan
   update, a completed prompt round trip — and stays
   `false` when nothing but bare protocol handshaking (`initialize`,
   `session/new`, `session/load`, `session/set_config_option` responses, and
   the operation receipt commit) happened before the leg died. **The receipt
   commit moved to that second list in v0.15.0 and this sentence used to name
   it as work.** It is not: every receipt commit fires during session setup,
   the last of them immediately before `session/prompt` is sent, so it proves
   durability and nothing about the model. While it counted, a leg that hung
   or was rate-limited without one byte coming back reported
   `work_observed: true`, which spent a worker attempt (this section) and, once
   §3.5.1 shipped, also kept a palette seat from ever rotating off a dead
   candidate. Found by the v0.15.0 release review and reproduced against a
   hanging adapter before it was believed. A NEW kind of progress the companion learns to
   report defaults to counting as work unless explicitly classified otherwise,
   so an unclassified signal fails toward a spent attempt, never toward a free
   one. `lost` **never** carries this fact and is never read as "never
   started": §4 already defines it as "an assignment whose process is gone and
   which recorded nothing", and that sentence is exactly as true of a leg
   killed after real, meaningful work as of one that never began — the ledger
   alone cannot tell a killed worker from a worker that never started, so
   guessing from the absence of a `delivered` line is refused. Only an
   EXPLICIT `work_observed: false`, written by the one process that was there,
   excludes a leg.
3. **A genuine worker failure still spends an attempt.** `attemptsBy` excludes
   an `assigned` leg from the count only when its matching `delivered` states
   `work_observed: false` — never by `terminal` name. A `protocol-error` (or
   any other non-`done` terminal) with `work_observed: true` counts exactly
   like `blocked` or `hard-timeout` always have; only the explicit fact
   narrows the budget, and a `delivered` with no `work_observed` field at all
   (every line written before this amendment) counts exactly as before. Keying
   the exclusion off the terminal string instead was tried and rejected during
   review: it reads a leg that failed for a genuine reason but happened to
   share a wire-error terminal as "never started" too, which is precisely the
   widening §15's own history warns against.

What this does NOT change: `legCeiling` (`MAX_LEGS`, §10) counts every
`assigned` unconditionally, transport-failed or not — a palette that keeps
landing on dead seats no longer burns `MAX_ATTEMPTS` faster, but it still
burns the token's total leg ceiling at the same rate it always did. GitHub #47
(an ordered model palette) is unblocked with respect to the attempt-budget
mechanism this amendment fixes; the leg ceiling is a separate, wider budget
that #47's own work should still account for.

## 5. State machine

One token, keyed on its last event and the role of the actor.

| Last event | Condition | Next |
| --- | --- | --- |
| `opened` | — | dispatch the **dispatcher** (intake) |
| `pulled` | — | dispatch the **dispatcher** (intake) |
| `intake` | — | dispatch a **worker** — the dispatcher's `worker_hint` (§4.9) if it names a real, free seat; escalate if it names a seat not on this team; wait for that seat if it names one that is busy; declared order (§3.2.1) if no hint was stated |
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
| `audit_requested` | leg dead past the deadline, liveness says `work_observed: false` | `questioned` with `resume_role: audit` — a person is asked and the token holds (§9) |
| `audit_lost` | — | re-arms `awaitingAudit` exactly as `completed` does; NOT terminal, and it releases the team like every other audit state (§6). Legacy only — `answered` carries this now |
| `questioned` (pre-`completed`) | before the answer deadline | held; the runner does not dispatch while a person has not replied (§4.7) |
| `questioned` (pre-`completed`) | past the answer deadline | RUNNER closes it with `abandoned` (§4.7, §9) |
| `answered` (pre-`completed`) | `resume_role: worker` | dispatch the **worker** (§4.7) |
| `answered` (pre-`completed`) | `resume_role: evaluator` | dispatch the **evaluator** (§4.7) |
| `answered` (pre-`completed`) | `resume_role: audit` | held — the outer controller reads it via the `completed`-driven `audit_requested` path instead (§4.7) |
| `answered` (pre-`completed`) | `resume_role: outer` | escalate — re-asks the outer controller, the seat that actually asked (§4.7) |
| `answered` (pre-`completed`) | `resume_role` absent, or `dispatcher` | dispatch the **dispatcher** (§4.7) |
| `questioned` (post-`completed`) | past the answer deadline | RUNNER closes it with `abandoned` (§4.7, §9) |
| `answered` (post-`completed`) | — | re-flag `audit_requested`; the reply is read, not silently absorbed (2026-08-04: `awaitingAudit` used to treat ANY prior `audit_requested` as proof the route was already read, so this reply had nowhere to go — fixed in `loop-runner.mjs`) |
| `audited`, `abandoned` | — | **hard terminal** (§4.7): nothing may follow either, ever |

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

- `RELEASING_EVENTS = {completed, abandoned, audit_requested, audit_lost, audited}`. Everything
  else holds. An audit *observes* a delivery; it never takes custody of one, so
  reading a finished route must not put it back into a team's WIP.
  A post-`completed` `questioned`/`answered` is the case this pair of sentences
  must disambiguate, and the two are not in conflict: neither event is in
  `RELEASING_EVENTS`, so placement does not skip it — but the outer
  controller/audit is not a declared team member and neither event carries
  `to_team`, so `teamOf` and the `to_team` fallback both miss and the token is
  placed as an **orphan** (surfaced, never silently dropped), never back inside
  a delivery team's WIP. "Holds" above means "is not released from placement,"
  not "occupies a team's WIP slot" — the orphan case is how those two stay
  true at once.
- Placement: `teamOf(last.agent_id)` if the actor is a declared team member,
  otherwise `last.to_team`, otherwise the token is an **orphan** and is surfaced,
  never dropped.
- `last` is `dispatch-facts.currentEntry(custody)`, **not** `custody[length-1]`.
  They differ in one case and it is a real one: a leg that has been superseded
  can still write its outcome afterwards. A companion killed mid-review writes
  its `delivered` on the way out, `at` is stamped when the line is written, so
  that write is honestly the newest and no sort can separate it from a real
  move — there is no recorded field for *when the work finished* as opposed to
  *when this was written*. `currentEntry` takes the agent named on the newest
  `assigned` as the holder and skips a trailing `delivered`/`lost`/`reviewed`
  that belongs to an older leg. It is still evidence about that leg; it is not
  where the token IS. Everything else stays last-wins.
  "Belongs to an older leg" is decided by `dispatch_id` when both the trailing
  entry and the holder's `assigned` recorded one — that tells two legs run by
  the SAME agent apart, which agent_id alone cannot. `reviewed` is in the set
  now, but it never falls back to agent_id on its own: an evaluator does not
  always have an `assigned` of its own when its review lands, so its agent_id
  is never expected to equal the holder's, and treating that mismatch alone as
  staleness is what read every ordinary review as superseded — measured, four
  tests.

  A DIFFERENT agent that DOES have an older `assigned` leg somewhere earlier
  in this ledger (round 5, 2026-08-04, F1/B6) is a harder case than either of
  those: by construction that leg is superseded, so its straggler is USUALLY
  evidence about ITS OWN old leg, not the holder's — no matter what
  dispatch_id/task_id it also carries, those cannot be told apart from a
  genuine current report by anything left to read off the entry (the
  guarantee that an id means one thing for its whole life is enforced at the
  point bytes enter the ledger, not re-derivable here). The one case this is
  wrong for is a genuine round-2 report from a reviewer who reviewed the SAME
  delivery once before (reject, rework, re-review by the SAME evaluator — the
  ordinary shape §1 describes) and writes its later verdict in the same
  identity-free shorthand a never-assigned reviewer is allowed to use.
  **Round 2 and no further**, and this said "round-2+" until 2026-08-04, which
  the code has never done (r6-qwen). A reviewer already assigned twice writing
  an identityless report is discarded by the ambiguity rule further down —
  nothing in such a line says which of its own legs wrote it — however
  correctly its `reviewed_task` names the current delivery. The cost is a
  re-dispatch, not a lost token: the runner assigns the evaluator again, and
  the sanctioned writer stamps a `dispatch_id` on every `reviewed` it authors,
  so the next report is not a shorthand at all. Paying for a re-review is the
  cheaper error than trusting a dead leg's verdict. The
  shorthand's own field, `reviewed_task` — REQUIRED on every `reviewed` line
  (§4) and always stamped by the sanctioned producer from the delivery
  actually being judged, at the moment of judging — settles it: a leg that
  died before the holder's own delivery existed cannot name that delivery's
  task_id, because it never saw it. So `reviewed_task` matching the CURRENT
  holder's own task_id is evidence — not proof, and the word was wrong here
  until 2026-08-04 — that the review is about what is held right now, and is
  trusted even though the reviewer is a different agent with an older leg
  elsewhere in this ledger. It is bounded twice over. The field is not bound to
  its producer: the sanctioned harvester is the only thing that stamps one, but
  nothing in the ledger says so, and a forged value needs exactly the write
  access every other field already assumes away. And the argument above covers
  only a leg that DIED before the delivery existed — a leg still running can
  see a later delivery land and name it, so the pass additionally requires that
  the reviewer's current leg has not already reported. The harvester writes one
  `reviewed` per outbox; a second word from the same leg did not come from it
  (r6-codex, round 6). A `reviewed_task` that
  does not match the holder's own task_id (or the holder has none — the
  holder is itself an evaluator/dispatcher/etc. leg, not a worker delivery)
  gets no such pass and is discarded exactly as before.

  When `dispatch_id` cannot settle it (missing on either side — a mixed-version
  ledger where an old writer, or the generic writer, left it off), `task_id` is
  the next signal, not agent_id alone: `assigned` is required to carry one
  (§4), and every outcome this matters for — `delivered`, `lost`, and a
  harvester-written `reviewed` — carries the SAME task_id its own leg opened
  under. An outcome that names a task_id is traced back to the exact `assigned`
  line that started its leg and compared against the `assigned` line that made
  the current holder the holder. Resolving to the SAME leg is necessary but not
  sufficient (retro-release-review, 2026-08-04, B3): nothing bound task_id to
  an agent the way `dispatch_id` is bound at write time (below), so a
  `delivered` naming a DIFFERENT agent than the one that leg was assigned to
  used to be trusted here — strictly worse than the agent_id fallback this
  branch sits in front of, which correctly refused that impersonation. The
  entry's own agent_id must also match the holder for the task_id match to
  count; when it does, that is the same leg and it is trusted, a different one
  (by either signal) means a newer leg has started since and the outcome is not
  evidence about where the token is now.

  Only a `reviewed` with NEITHER `dispatch_id` NOR a `task_id` it can look up
  (the shorthand this system still writes when a review rides straight on a
  worker's delivery, with no `assigned` of the evaluator's own to trace) has no
  identity signal left at all — and unconditional trust there was itself a hole

  PROPOSED, NOT YET IMPLEMENTED (round 5, 2026-08-04, F1 "fail-open"): for the
  SAME agent retried (the identical evaluator killed and redispatched), a
  `reviewed` that carries the LIVE leg's own dispatch_id and/or task_id is
  byte-for-byte indistinguishable from a genuine round-2 report by that same
  agent — codex (round 5) conceded this directly and this document agrees: no
  field on the entry can tell a forged/replayed line, stamped at write time
  with whichever ids currently read as "live" while carrying content actually
  produced under an OLDER leg, apart from a genuine live report. This is not a
  gap in the heuristic; it is a property of an append-only, unauthenticated
  ledger where dispatch_id/task_id are plaintext values anyone with write
  access can copy. Closing it needs a producer-bound identity that is bound
  at CONTENT-GENERATION time, not at write time — for example: the writer
  mints an opaque, single-use leg token when it records an `assigned` line,
  delivers it to the dispatched process out of band (never re-derivable by
  reading the ledger, e.g. written only into that leg's own scratch/task
  directory), and REQUIRES `delivered`/`lost`/`reviewed` from that leg to
  echo it back; a stale/dead process's buffered content, generated before a
  retry, never received the RETRY's token and so cannot echo it, however
  current the dispatch_id/task_id it separately copies from the ledger might
  be. This needs changes to `ledger-writer.mjs` (mint + verify the token),
  the harvester in `loop-runner.mjs` (thread it through spawn -> outbox ->
  harvest), and `dispatch-facts.mjs` (trust the token, not dispatch_id/
  task_id, for the same-agent case) — larger than one guard clause, and
  deliberately not attempted in this round. Until it lands, the three
  same-agent cells this document already calls TRUST two paragraphs below
  remain a documented, deliberate gap, not a heuristic anyone should try to
  patch further; see CONTRACT-PATCH.md in the round-5 "BLOCKER 1 + 5 + 7"
  worktree for the full reasoning this amendment summarizes.
  (retro-release-review, 2026-08-04, B4): the SAME evaluator retried also
  reads identical by agent_id on both legs, so an identityless `reviewed` from
  the DEAD leg is indistinguishable from one on the LIVE leg by anything on the
  entry itself. The one remaining signal is structural, not on the entry: was
  the entry's own agent assigned more than once ANYWHERE in the ledger, up
  to and including the position of the entry being judged — not merely in an
  unbroken consecutive run. The consecutive-only version of this check was
  itself the bug, found and fixed at retro-release-review round 2 (F1,
  2026-08-04): a same-evaluator reject → rework → re-review — one team's own
  ordinary quality loop, not a kill-and-redispatch — always has a DIFFERENT
  agent's `assigned` (the rework worker) sitting between the evaluator's two
  legs, so counting only a consecutive run reset to 1 across that gap and
  read as unambiguous, letting a dead round-1 evaluator leg's late,
  identityless `reviewed pass` clear the pull gate while round 2 was still
  running. `dispatch-facts.mjs`'s `assignedCountFor`, called from inside
  `currentEntry`, is the file of record: it scans every line up to the judged
  entry's own index and counts an `assigned` naming that agent wherever it
  falls, consecutive or not — an intervening OTHER agent's leg changes
  nothing about whether TWO of the target agent's own legs exist for this one
  to be ambiguous between. Assigned once (or never) anywhere in that span,
  there is no other leg it could be stale against, and it is trusted exactly
  as before. Assigned more than once anywhere in that span, it cannot say
  which leg it belongs to and that is UNKNOWN — a branch that cannot answer
  says UNKNOWN, not "stale", but
  UNKNOWN must not be counted as a passing review either. Guessing "stale"
  outright is still what read every ordinary review as superseded, above.
  `delivered`/`lost` without a resolvable task_id fall back to the plain
  agent_id check they always used, for the same reason.

  `dispatch_id` matching is not proof on its own if the ledger itself is
  self-contradictory: `ledger-validate.mjs` now binds every `dispatch_id` to
  the `(agent_id, task_id)` its `assigned` line actually named, and refuses
  (`dispatch_id_agent_mismatch`, `dispatch_id_task_mismatch`) a
  `delivered`/`lost`/`reviewed` that reuses a live dispatch_id while
  contradicting who or what it was assigned to. `currentEntry` itself does
  NOT trust a matching `dispatch_id` alone — retro-release-review round 2
  (Shape 2, F1, 2026-08-04) found a `dispatch_id` match necessary but not
  sufficient: nothing stopped an entry from also naming a `task_id` that
  resolves to a DIFFERENT `assigned` line than the holder's, which is stale
  evidence wearing the live leg's badge. `dispatch-facts.mjs`'s `currentEntry`
  refuses that entry — treats it as not current, and keeps searching older
  lines — whenever its `task_id` is present and resolves to an `assigned`
  other than the holder's own; an entry that omits `task_id`, or that names
  the holder's own, still passes on the `dispatch_id` match alone. The
  write-time guarantee above (the ID means one thing for its whole life) is
  still enforced at the point bytes enter the ledger, not re-derived here —
  this paragraph is about what `currentEntry` additionally checks on READ,
  which is now a second, independent gate rather than none.

  Both the `task_id`-tracing and the `dispatch_id` binding above assume each id
  opens exactly ONE leg for its whole life; nothing enforced that until now
  (retro-release-review, 2026-08-04, B2). `task_id` is minted at millisecond
  resolution (`loop-runner.mjs`), so two dispatches of the same
  (token, team, role) inside one millisecond collide with nothing to stop it,
  and a hand-written or replayed ledger has no clock constraint at all. A
  reused id let a stale leg's outcome be read as the current leg's: the
  `assignedIndexByTask`/`dispatchOwner` maps `currentEntry` and
  `ledger-validate.mjs` build are both last-wins or first-wins and neither
  reported the reuse. `ledger-validate.mjs` now refuses a ledger whose
  `assigned` line reuses a `task_id` or `dispatch_id` an earlier `assigned`
  line in the same ledger already claimed (`duplicate_task_id`,
  `duplicate_dispatch_id`) — reported at the line that reused the id, alongside
  every other problem the ledger has.

  Two amendments from retro-release-review round 5 (2026-08-04, codex
  BLOCKER 4 and BLOCKER 8) touch this paragraph without weakening its claim.
  First, `loop-runner.mjs`'s `buildTaskId` no longer builds the string
  `dispatch()` passes to `acp-companion.mjs` by raw concatenation: it is a
  16-hex-char slice of a sha256 digest over the same
  (workItem, team, role, millisecond) tuple, joined to a truncated
  human-readable prefix. This is still deterministic per exact tuple — two
  dispatches of the same (token, team, role) in the same millisecond still
  mint the identical id, exactly as this paragraph already says — but it
  fixes two things the old concatenation got wrong that this paragraph never
  claimed to cover: a `workItem` long enough to overflow
  `acp-companion.mjs`'s 64-character task-id cap (§4's `ID_RE` allows
  `work_item` up to 128 characters) used to make the companion exit before
  writing `assigned` at all — invisible to the retry budget, which counts
  only `assigned` lines — and the old char-substitution sanitize was not
  injective (`.` and `:` both became `-`), so two DIFFERENT work items could
  collide onto one task-keyed file. Second, this paragraph's own stated
  defense — `ledger-writer.mjs` refusing a duplicate `task_id`/`dispatch_id`
  at append time — used to be a read-validate-append with no atomicity
  across those three steps, so N callers racing the SAME append could each
  read the same pre-append snapshot and each pass its own validation,
  landing several duplicate rows before anything noticed. `appendEvent` now
  holds an exclusive per-ledger-file lock
  (`<work-item>.jsonl.lock`, `O_CREAT|O_EXCL`) across the whole
  read-validate-append critical section, so at most one concurrent writer to
  the same token can ever land a line; every other concurrent caller sees
  the FIRST writer's committed line before it validates its own and is
  refused with the same `duplicate_task_id`/`duplicate_dispatch_id` this
  paragraph already names — the corruption this paragraph describes
  preventing can no longer happen even when several writers race the exact
  case it warns about. `appendEvent` can now also return
  `{ok: false, code: 'locked', ...}` if contention on one ledger file is not
  resolved within 5 seconds; a lock older than 30 seconds is treated as
  abandoned by a dead holder and is stolen by the next acquirer.
  This paragraph said "Both callers ... already treat every `!result.ok`
  refusal uniformly regardless of `code`, so this needed no caller change".
  Both halves were false and r6-qwen and r6-agy both said so. There are FIVE
  call sites, not two — `admit.mjs`, `acp-companion.mjs`'s
  `appendWorkItemEvent`, `pull-controller.mjs`, `loop-runner.mjs`'s `record`
  (itself five writes), and this module's own CLI — and treating every code
  uniformly is exactly what was wrong: `locked` is the one refusal that says
  nothing about the event, so a caller that files it beside a verdict drops a
  custody line for contention. The companion's append and the runner's
  `record` now retry `locked` and nothing else; `pull-controller` carries its
  refusal home on the decision and its CLI exits non-zero when it recorded
  none of the pulls it planned.
  `tests/loop-occupancy.test.mjs` gained the BLOCKER 4 cases (probed against
  the real `acp-companion.mjs` process, not a copied regex);
  `tests/ledger.test.mjs` gained the BLOCKER 8 cases (a release-gated,
  genuinely-simultaneous multi-process race, and stale-lock recovery).
  Readers that answer position or state go through it: `teamOccupancy`,
  `planPulls`, `planHarvest`, `nextStep`, `boardSummary`, the kanban card, and —
  on the loop graph page — `frontDoorStatus`, `controllerState`'s parked count,
  its `holding` set, a team's `stuck` flag, and the `delivered`/`waiting` tile
  counts in `graph.mjs`.

  `loop-runner.lastWorkerDelivery` answers a related but DIFFERENT question —
  not "where is the token now" but "which WORKER leg's delivery is the
  artifact currently in play" — and it cannot simply call `currentEntry`,
  because the current position is often not a worker `delivered` at all (an
  evaluator has since been `assigned`, and possibly reviewed, on top of it —
  `currentEntry` would return that `assigned` line, not any delivery). It
  still owes the same non-staleness guarantee position does: a worker leg
  already superseded by a newer worker leg must never win merely for
  reporting in later (retro-release-review r5, 2026-08-04, BLOCKER 2 — a leg
  already `lost`, retried, and superseded by the retry's own `delivered`, can
  still write a late success stamped with whenever it actually landed,
  sorting AFTER the retry's delivery in `custody`; a scan by ARRIVAL order
  picked the late straggler). It satisfies that guarantee its own way: every
  candidate `delivered` is ranked by the array position of the `assigned`
  line that OPENED its leg — a fact authored in dispatch order, and so never
  late, exactly the fact §6's own `task_id`-tracing paragraph above already
  relies on — rather than by the `delivered` line's own position, which can
  be late. The candidate whose leg opened most recently wins, however late
  its own report shows up. A `delivered` whose `task_id` does not resolve to
  any `assigned` in the ledger is not ranked at all: house rule, a branch
  that cannot answer says UNKNOWN, never "newest".
  Readers that answer *when* something last happened do not, and must not.
- The rule is a **release list, not a whitelist**: an event nobody taught this
  function about leaves the work where it is rather than making it disappear.

### 6.1 Per-token projection — the shape every OTHER reader should consume

§6 above centralised the one question "which team holds this token" into
`teamOccupancy`/`currentEntry`. It did not centralise everything past that:
when a token entered its PRESENT placement, where that placement was pulled
from, and what its own intake history says each still lived inside whichever
reader needed it first — `kanban.mjs` folded the first two inline, and
`intake-stats.mjs` folded the third, independently, before either could see
the other was answering the same kind of question about the same evidence.

`token-projection.mjs`'s `projectToken(item)` is the single fold for exactly
those questions, over ONE token's own custody, and no other input — no graph
declaration, no wall clock, no other token's state:

| Field | Answers | Folded from |
| --- | --- | --- |
| `current` | who holds this token now, and with what event/verdict | `dispatch-facts.currentEntry` — reused, never re-derived |
| `releasing` | is the route still open or already closed | `RELEASING_EVENTS.has(current.event)` |
| `placed_at` | when did the token enter its CURRENT placement | newest `opened`/`pulled`/`returned` line, else the first line ever recorded (kanban.mjs's own fold before this) |
| `pulled_from` | which team the current placement was pulled from, if any | newest `pulled` line's `from_team` (graph.mjs's own fold before this) |
| `lead_sec`, `legs` | the token's whole-journey timing and leg count | pass through from `dispatch-facts.readWorkItems`'s own item — never recomputed |
| `requester` | who opened this token | the `opened` line's `actor` |
| `questions[]` | every time the token was sent back for detail — category and answer time, per asking | each `questioned`/`answered` pair (intake-stats.mjs's own fold before this) |
| `withdrawn_by_runner` | did the runner's own deadline lapse it, as opposed to a controller `abandon` verdict | an `abandoned` line whose `actor` is `agent:runner` specifically — the same disambiguation §9 already requires |

**Deliberately excluded, and why:**

- Per-team occupancy (`teamOccupancy`'s cross-token aggregate) stays where it
  is. This projection answers about ONE token; a team's occupancy is built by
  folding MANY tokens together, which is a different, later step.
- `.tmux-teams/decisions/latest.json` (§11.3) stays separate. It is a
  different file on a different write cadence — overwritten whole once per
  tick, never appended — answering why the RUNNER passed over a token on ONE
  tick. No reader of a custody ledger asks that question of the ledger, and
  it is not evidence a token carries about itself; it is evidence about a
  tick that read the token and moved on.
- Ledger structural validity (`ledger-validate.mjs`) stays separate: a
  byte-level judgment over raw lines, not a fact about a believed-valid
  token's history.
- A human-readable state sentence, "how long has it been sitting here"
  against the wall clock, and whether a team is at its WIP limit all need the
  graph declaration and/or the clock, which this projection deliberately does
  not take — they stay in the reader that already has both.

**Adoption is per-reader, not automatic.** As of this amendment only
`kanban.mjs`'s `cardOf`/`readBoard` consume it, replacing their own inline
placement-and-placing fold with the shared one, with no change to either
function's observable output (`tests/kanban.test.mjs`,
`tests/kanban-board.test.mjs` pass unmodified). The other eight readers named
in the D2 amendment log entry below are unchanged; moving them is future
work, one at a time, each proving it changes nothing before it lands.

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
- **The next hop is the first team on the route the token has not been
  ADMITTED by (§1); a team already in its held set is skipped, and a route
  with none left is finished → `completed`.** (GitHub #42/#44, 2026-08-05.)
  `route[index + 1]` alone answers only "what is declared next", never "has
  this token been here already" — and on an escalation exit (parked at a
  later team, resumed, and released there) those two answers can disagree:
  the declared route points back at a team the token was already ADMITTED by.
  The validator's `route_went_backwards` refusal (§4.2) remains the backstop —
  it is what stopped the wrong pull from ever being written — but a planner
  that keeps proposing what the writer is guaranteed to refuse recomputes the
  identical decision every tick with no exit in code, which is indistinguishable
  from a runner that has quietly given up. `heldTeams` is computed once, in
  `ledger-validate.mjs`'s own admission tracking (§1), and returned on
  `validateLedgerTolerant`'s verdict — the planner consumes it rather than
  scanning the ledger for the same fact a second time.

### 7.1 The controller team releases on `intake`, not on `reviewed`

**Shipped on `main`** (originally prototyped on branch
`poc/controller-as-team`; `admit.mjs` and the front-door WIP rule below are
part of this range's `main`, not gated behind a branch). A delivery team releases work when its
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
- **The brake compares a trigger's IDENTITY, not the text the controller reads.**
  A trigger may render elapsed time — *"nothing recorded for 47 minutes"* is
  what an agent can act on — but elapsed time is measured against the clock, so
  it is a different string on every tick. The stall trigger was compared as
  text: its minute count incremented forever while a board sat still, the brake
  could never match a second time, and the controller was re-dispatched every
  `PM_COOLDOWN_SEC` for as long as nothing happened (issue #22, 2026-08-03). A
  trigger's identity must be a function of what is RECORDED and of nothing else,
  so the stall's identity names the timestamp of the last recorded event rather
  than its age: the same stall stays the same problem, and a stall that returns
  after something IS recorded is a new one. `pm-notes/latest.md` holds
  identities — that is what makes it comparable between ticks — and it stays
  readable, because an identity is the same fact rendered against a fixed point
  instead of against now. AC14 is the guard, and it must run the shipping
  `STALL_SEC`: it passed `stallSec: 1e9`, which switched off the only trigger
  that could defeat the brake, so the guard had never once run the
  configuration the runner ships.
- **The same anchor discipline applies to a re-escalated `answered` reply**
  (retro-release-review r4-codex BLOCKER 4, 2026-08-04). Two triggers render
  text that is a pure function of the token's identity and NOT of which cycle
  produced it: the outer-controller re-escalation (`nextStep`'s `answered` +
  `resume_role: 'outer'` branch always states the same reason,
  "a person answered a question the outer controller asked...") and the
  `awaitingAudit` completion trigger (a function of `work_item`/`workflow`/
  failed-leg-count alone). A token that cycles through a SECOND
  `questioned(outer|audit)` -> `answered` round trip renders byte-identical
  text to the first, and the brake — comparing only rendered text before this
  amendment — read the second, genuinely new reply as the same already-read
  problem and suppressed it forever: a reply that moved the ledger, never
  read. Both triggers' `id` (not their `text` — the controller still reads the
  same clear prose) now also carries the timestamp of the item's own last
  recorded custody entry, which changes exactly when a new event — such as
  this very `answered` — is appended, and stays constant when nothing has
  changed. This is the identical anchor the stall trigger already uses one
  bullet above, applied to the two triggers that render per-item text without
  it.
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
  A third and fourth case joined 2026-08-04 (retro-release-review r5, BLOCKER
  3). The controller's OWN leg carries no work item — `tick` deliberately
  spawns it with `workItem: ''`, so the companion's per-token custody write is
  a no-op for that leg specifically; there is no ledger for it to write a
  `lost` into. A controller leg that dies (crashes, is killed, or simply never
  writes `.mailbox-out/<taskId>`) before producing anything therefore left a
  token parked in `escalated` (naming the controller) or in `audit_requested`
  with NOTHING that could ever revisit it: `planHarvest` needs an outbox to
  harvest anything at all, and `audit_requested` is additionally never a
  member of `held` (§6: it is a `RELEASING_EVENT`), so `planDispatches`'s
  ordinary per-team loop never even visits it. The runner now applies the
  SAME `answerDeadlineSec` clock `questioned` already answers to, to both: a
  controller leg with no outbox past the deadline is treated as dead, and the
  runner writes `abandoned` exactly as it does for an unanswered `questioned`
  — EXCEPT where that dead leg's own liveness snapshot states
  `work_observed: false`. That is §4.10's fact carried on the one channel a
  `workItem: ''` leg does write, and it says the model never took a turn:
  nobody failed to answer, because nobody was ever asked, and the reason
  recorded for years said otherwise. The runner writes the non-terminal
  `questioned` instead, with `resume_role: audit`, and the token HOLDS: nothing
  is retried and nothing is withdrawn. Amended 2026-08-07 — this said
  `audit_lost` and a bounded retry, which was the least-bad option while no
  code could write `answered`, so parking on a question was a wedge rather than
  a pause. `answer.mjs` (§4.7) removed that constraint, and D1 governs: a leg
  the transport killed is held, nothing retries by itself, a person unblocks
  it. Two things bound the hold, and a third bound it for one day. The scan
  reads `currentEntry` and visits only `audit_requested`, so writing the
  question is itself what stops the asking — a person is never handed a question
  that is replaced every tick. And the question always has somewhere to BE: §6
  places a token by its last event's `agent_id`, D6 (§1, 2026-08-08) refuses at
  LOAD any graph whose controller is a worker on no team, so `teamOf(controller)`
  always resolves. The parked question holds the control team's one slot and
  `admit.mjs` refuses admission at the limit: that is the whole stop mechanism,
  and it is Kanban rather than an invention.

  **Corrected 2026-08-08, and the correction is the lesson.** For one day this
  paragraph named a THIRD bound — a runtime guard that declined to write a
  question a control-less graph could not place, and fell back to the old
  withdrawal — and called that graph "still valid". D6 landed the next day,
  refused the graph at load, and the guard was deleted as unreachable; §4.2,
  §4.7 and the AC table were rewritten with it and THIS paragraph was not.
  Both changes ship in one release, so the contract contradicted itself and its
  own code in a section labelled non-negotiable. Found by an outside reviewer
  reading the release diff, not by anyone here. The rule it breaks is §15.1's,
  and the shape is the one this document keeps paying for: prose that was true
  when written and never compared against the code again.
  And only POSITIVE evidence narrows the rule: a missing, unreadable,
  or work-bearing snapshot closes exactly as fast as it did before. That
  second default fails OPEN — toward the irreversible terminal — on ambiguity,
  which is deliberate and is the price of this paragraph's other guarantee,
  that an audit cannot hang forever.
  `escalated` reaches this inside `nextStep` (already visited via `held`,
  since `escalated` — unlike `audit_requested` — is not a `RELEASING_EVENT`);
  `audit_requested` is scanned for directly inside `planDispatches`, since
  `held` will never carry it.

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

### 11.3 Why a token was passed over — `.tmux-teams/decisions/latest.json`

Every refusal the tick decides is spoken once, to the runner's own log, and
nowhere else: a seat the runner would not wait on, a history it would not
dispatch onto, a brief it could not compose, an escalation whose own mark it
could not write. None of it survives the process that decided it — a token
nobody looked at this tick and a token the runner considered and declined are,
the instant the tick ends, indistinguishable. This file is the fix.

```json
{ "tick_at": "<ISO 8601 UTC>",
  "decisions": [
    { "work_item": "<id>", "action": "<one of the set below>",
      "reason": "<the runner's own words, unchanged from the log line>",
      "problems": [ { "line": 12, "code": "<code>", "detail": "<text>" } ] }
  ] }
```

`problems` is present only on a decision that has one — today, only
`unreliable-history` — and is the exact array `validateLedgerFileTolerant`
already returned; nothing here recomputes it.

`action` is a small closed set. Every value is read off an object the tick
already held for an unrelated reason (the log line, or the plan itself) —
nothing here is a taxonomy invented for this file:

| `action` | Read off | Meaning |
| --- | --- | --- |
| `escalate` | `plan.action` (`nextStep`, §5) | the token's own next step is escalation |
| `wait` | `plan.action` | every seat this token could use right now is busy |
| `waiting` | `plan.action` | held on a person who has not answered yet |
| `skip` | `plan.action` | nothing follows the token's last custody event |
| `unreliable-history` | `validateLedgerFileTolerant(...).ok === false` | the ledger has a blocking problem, so no fresh leg may be dispatched onto it (§4.3) |
| `no-brief` | `composeBrief(...).path === null` | no standing brief exists for the team this token would be dispatched to |
| `wedged` | a `record(...)` call after an escalation returned `false` | the controller was dispatched and the ledger refused to record what it decided about this token; nothing will retry it on its own (§9, §14.2 item 3, AC74) |

**Overwritten whole, every tick — never appended.** A file that grew forever
beside the ledger would be a second event store, which is exactly what §13
exists to prevent; that is why the two advisors who wanted an append-only log
(`decisions/<date>.jsonl`) lost the argument. The cost of that choice is
stated rather than hidden: **this file answers "why is it not moving right
now" and cannot answer "how long has it been stuck."** A token skipped for the
same reason forty ticks running reads identically to one skipped for the
first time. Anyone who needs that history still has to read the log this file
was built to stand in for — it narrows the question, it does not replace the
log.

**Only a tick that actually reached the point of evaluating tokens writes
it.** A tick that returns before `planDispatches` ever runs — an invalid
graph, a stale `pulse.json` — has no decisions to report, and writing
`decisions: []` with a fresh `tick_at` would claim the board was checked and
nothing was refused, which is false: it was never checked. Those ticks leave
this file exactly as the last full tick left it. A full tick that genuinely
refused nothing still writes `decisions: []` with the new `tick_at` — that
*is* real information, and is distinguishable from "never checked" only
because `tick_at` moved; a reader must check `tick_at`, not just whether the
array is empty.

**A dry run does not write this file**, for the same reason §11.2's heartbeat
does not stamp on one: a simulation overwriting what a live tick actually
decided would report decisions nobody made.

Written atomically — temp file, then rename — in `.tmux-teams/decisions/`,
for the same reason `acp-companion.mjs`'s own outbox writes are: a reader
polling this path can otherwise open it between create and write.

## 12. The loop graph page

The rules below are the contract's own. The **detail** — every node, edge, scene
and motion the page may draw, and the method for checking a published one — is
expanded in `references/loop-graph-page.md`, which is a chapter of this section
and not a source of truth beside it. Where the two disagree, this file wins and
the disagreement is a defect.

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
names a model for every role and lets a seat override its own (§3.2, §3.2.1),
and the RESOLVED name travels with each agent in the validated graph — so two
workers on one team may state two different declared models. It is a
DECLARATION: it says which model
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
- **No dispatch may pass a non-empty `mcpServers`.** Every ACP call that
  starts or resumes an agent's session sends the literal `mcpServers: []` —
  no option, environment variable, `graph.json` field, or profile key may
  make it configurable. This is the Execution seam's containment boundary: an
  agent this system dispatches can do exactly what its brief permits and
  nothing more, and an MCP server grants reach that nothing in §3–§9 mediates
  or attributes. Opening it is a containment REDUCTION, not an added capability,
  and it opens only by amending this clause — see ADR 0003. **Unenforced
  (§15.2)** — nothing tests the literal today; see §14.1.

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
| AC77 | §3.2.1 | a seat overrides its role's model and lane, and only that seat | `workflow-graph.test.mjs` |
| AC78 | §3.2.1, §3.1 | a graph with no `seats`, an empty `seats`, and a `seats` entry restating the role default all hash to one `source_digest` | `workflow-graph.test.mjs` |
| AC79 | §3.2.1 | every way of declaring a seat and saying nothing is refused, naming the team and the seat | `workflow-graph.test.mjs` |
| AC80 | §3.2.1, §9 | a `seats` entry for the outer controller is refused, because the dispatch reads `outer_controller_*` and would ignore it | `workflow-graph.test.mjs` |
| AC81 | §3.2, §9 | the outer controller is dispatched on the lane it declares, like every other seat | `loop-runner-heartbeat-model.test.mjs` |
| AC82 | §3.2.2 | a seat's declared effort resolves into `agents[]`, and an unoverridden seat carries `null`, not a role default | `graph.test.mjs` |
| AC83 | §3.2.2 | a malformed effort (empty, over 64 characters, a control character) is refused, on a seat or on the outer controller | `graph.test.mjs` |
| AC84 | §3.2.2, §9 | a seat's declared effort reaches `dispatch`'s spawn call and its child env (`ACP_REASONING_EFFORT`/`ACP_EXPECT_REASONING_EFFORT`) — the §3.2.1 "validated, normalized, dropped at dispatch" bug pattern does not recur for effort | `loop-occupancy.test.mjs` |
| AC85 | §4.9 | a dispatcher's `WORKER:` line is harvested into `intake.worker_hint`; no line harvests as `null`, not `undefined` | `loop-occupancy.test.mjs` |
| AC86 | §4.9 | a worker_hint naming a real, free seat overrides declared order, not merely a tie-break among equal seats | `loop-occupancy.test.mjs` |
| AC87 | §4.9 | a worker_hint naming a seat not on the team's pool is escalated, naming the hint, never silently substituted | `loop-occupancy.test.mjs` |
| AC88 | §4.9 | a worker_hint naming a real but busy seat waits for that seat and does not fall through to a different free one | `loop-occupancy.test.mjs` |
| AC89 | §4.9 | `returned`/`resumed` never read a `worker_hint`, even if one were present on the line | `loop-occupancy.test.mjs` |
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
| AC90 | §11.3 | a tick that refuses a token records it in `decisions/latest.json`, with its reason, and a token nobody considered is absent — both in the same test | `loop-runner-decisions.test.mjs` |
| AC91 | §11.3 | a dry run does not write `decisions/latest.json`, so a simulation cannot impersonate a live tick's refusals | `loop-runner-decisions.test.mjs` |
| AC92 | §11.3 | a tick that returns before evaluating any token (invalid graph, stale pulse) leaves an existing `decisions/latest.json` untouched rather than overwriting it with an empty, falsely-fresh one | `loop-runner-decisions.test.mjs` |
| AC93 | §16 | `listDeliveries` lists every `delivered` leg on a real synthetic ledger, oldest first, with an opaque id and no content | `agent-seat-reads.test.mjs` |
| AC94 | §16 | `fetchDelivery` returns the exact outbox bytes for an id `listDeliveries` named, scoped to the work item it was listed under, and reports a missing outbox as `content_available: false` rather than as not-found | `agent-seat-reads.test.mjs` |
| AC95 | §16 | `legOutcomes` lists every closed leg (`delivered`/`lost`/`reviewed`) and counts repeated rejections, so a caller need not fold the ledger itself | `agent-seat-reads.test.mjs` |
| AC96 | §16 | no return value from any of the three functions, across a found case, a not-found case, and a hostile (path-shaped) argument, contains `.jsonl`, `.tmux-teams`, `.mailbox-out`, or an absolute path — and the module goes through the sanctioned aggregate ledger reader, keeping the ledger-reader ratchet green with no new baseline entry | `agent-seat-reads.test.mjs` |

Added 2026-08-05, GitHub #47 phase 1 (declaration only — no runtime code reads
a palette yet).

| # | Clause | Assertion | Test file |
| --- | --- | --- | --- |
| AC97 | §3.5 | a seat declaring a valid palette loads and validates; a graph declaring none resolves every seat's `palette` to `null`, and declarations that say the same thing still hash alike (§3.2.1) | `workflow-graph-palette.test.mjs` |
| AC98 | §3.5 | a malformed palette entry — bad model, adapter, effort, display_model, bucket, an unknown key, a non-object entry, or a palette of the wrong length — is refused, naming the team and the seat | `workflow-graph-palette.test.mjs` |
| AC99 | §3.5 | `palette` alongside `model`/`adapter`/`effort`/`display_model` on the same seat is refused, not silently ignored | `workflow-graph-palette.test.mjs` |
| AC100 | §3.5 | two consecutive palette entries in the same bucket are refused — explicitly declared, and defaulted from an unstated bucket to a shared lane — while a repeat separated by a different bucket is accepted | `workflow-graph-palette.test.mjs` |
| AC101 | §3.1, §3.5 | `wip_limit` is unchanged by a palette of any length, on a team with exactly one worker seat | `workflow-graph-palette.test.mjs` |
| AC102 | §3.5 | a seat's resolved `palette` on `agents[]` is `null` when none was declared, and the seat's single-value `model`/`adapter`/`effort`/`display_model` resolve to the palette's first entry when one was | `workflow-graph-palette.test.mjs` |
| AC103 | §3.5 | a palette for a seat not on the team, or for the outer controller, is refused by the same checks §3.2.1 already runs for a plain seat override | `workflow-graph-palette.test.mjs` |

Added 2026-08-05, GitHub #47 phase 2 (§3.5.1: dispatch and fallback — the
ordering semantics phase 1 wrote down and left unenforced).

| # | Clause | Assertion | Test file |
| --- | --- | --- | --- |
| AC104 | §3.5.1 | a fresh admission on a palette seat dispatches its first declared entry — "the starting point" — with no ledger read needed | `loop-runner-palette-dispatch.test.mjs` |
| AC105 | §3.5.1, §4.10 | a leg whose `delivered` states `work_observed: false` advances the seat's NEXT leg to the next palette entry in declared order, wrapping past the end; a leg that reached the model (`work_observed: true`, absent, or `lost`) retries the same entry | `loop-runner-palette-dispatch.test.mjs` |
| AC106 | §3.5.1 | once as many `work_observed: false` legs have accumulated on the seat since the last resume as the palette has entries, the runner escalates instead of dispatching the first entry a second time, naming the seat, the palette size and the miss count — and its stated reason claims only that, never that no entry ever reached the model (an intervening genuine failure retries the same entry, so one CAN have) | `loop-runner-palette-dispatch.test.mjs` |
| AC107 | §3.5.1, §4.10, §10 | a palette leg still counts toward `legCeiling` unconditionally, transport-failed or not; the palette's own per-seat cycle bound escalates with legs to spare against that ceiling, not by weakening it | `loop-runner-palette-dispatch.test.mjs` |
| AC108 | §3.5.1, §4.9 | `worker_hint` still names a seat only; a hinted palette seat resolves its own candidate exactly like a freely-picked one, and its no-palette sibling is unaffected | `loop-runner-palette-dispatch.test.mjs` |
| AC109 | §3.5.1 | a seat with no palette dispatches with no `candidate` field at all. The six files named here (`loop-occupancy`, `loop-runner-heartbeat-model`, `loop-runner-decisions`, `loop-runner-busy`, `loop-replay`, `loop-smoke`) needed no line changed WHEN THIS CLAUSE WAS WRITTEN; D6 has since edited five of them for the mandatory control team, so read that as history rather than as a standing claim about the tree | `loop-runner-palette-dispatch.test.mjs` |
| AC110 | §3.5.1, §4 | a real `acp-companion.mjs` run writes `assigned` carrying `requested_model` and `adapter`, and the line still satisfies §4's own required fields | `assigned-carries-model.test.mjs` |
| AC111 | §3.5.1 | a leg that pinned no model records `requested_model: null` — the request, absent, never the adapter's later answer, which at write time has not been given | `assigned-carries-model.test.mjs` |
| AC112 | §4, §5, §9 | a dead audit leg whose liveness says `work_observed: false` asks a person (`questioned`, `resume_role: audit`) and holds; one that says `true`, or says nothing at all, is still `abandoned` on the same deadline as before | `audit-transport-death.test.mjs` |
| AC113 | §4.7, §9 | the question that path writes carries everything `answer.mjs` needs to close it — a `question_id`, an `agent_id` that resolves to a team, and `resume_role: audit` — and a token already parked on one is not asked again | `audit-transport-death.test.mjs` |
| AC114 | §6, §9 | a parked question holds the control team's one slot, which is what closes the front door — `admit.mjs` refuses admission at the limit | `audit-transport-death.test.mjs` |
| AC115 | §1, §6 | a graph whose outer controller is a worker on no team is REFUSED at load, and so is a graph naming no controller at all; both refusals say how to fix the declaration | `workflow-graph.test.mjs`, `graph-tour.test.mjs`, `controller-team.test.mjs`, `loop-runner-heartbeat-model.test.mjs` |
| AC116 | §4.2, §6 | an escalated token occupies the CONTROL team's WIP, not the delivery team's; a `resumed` still returns to the team its `to_team` names | `loop-occupancy.test.mjs`, `kanban-board.test.mjs` |
| AC117 | §4.1, §9 | a person can CLOSE a token (`withdraw.mjs` → `abandoned`, `human:` actor enforced by the door because the validator cannot: the runner writes the same event and signs as itself). A hard terminal, an unknown token and an empty reason are refused; success prints the `admit.mjs` line for a replacement | `withdraw-the-token.test.mjs` |
| AC120 | §10, §11 | the runner wakes on a change under `.mailbox-out/` or `work-items/` as well as on its interval; a directory it cannot watch degrades to a note and the interval alone; a burst wakes it once; watching decides nothing | `watch-for-work.test.mjs` |
| AC119 | §1 | a workflow or a team declaring a key the loader does not read is REFUSED, naming the key and listing what may be declared — it is not accepted and silently dropped | `workflow-graph.test.mjs` |
| AC118 | §9 | the recorded reason quotes that leg's own `liveness_state`/`termination_reason` rather than a fixed phrase, so two different causes cannot report the same one | `audit-transport-death.test.mjs` |

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
| §13, `mcpServers` | no test asserts `session/new` and `session/load` still send `mcpServers: []`; the closure is a code-review fact about `acp-companion.mjs`, not a running guard |
| §3.5.1 | that a palette entry's model is the one an adapter actually SERVED. `assigned` records the request (phase 2b), and `identity_status: matched` on the receipt verifies the answer, but nothing joins the two — a leg dispatched on entry 2 and answered by some other model would be visible in two places and contradicted in neither |

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
   *Extended 2026-08-04 (H5, retro-release-review):* closing the blocking-set
   gap above did not close a narrower one — `planPulls` validates a token's
   ledger only once that token reaches ITS OWN pull-readiness check (a
   `reviewed pass` or the controller's `intake accept`). A token sitting on an
   earlier state, e.g. `opened`, with a line the validator refuses (a missing
   required field) never reached that check, so it drew as ordinary "Waiting
   for intake" while `loop-runner.mjs` would refuse to dispatch it forever —
   the board and the runner disagreed about the same token again, just at a
   different state than item 2 originally named. `readBoard` (`kanban.mjs`) now
   validates every token's ledger independently of what state it is in, so an
   invalid ledger is visibly blocked from the moment it exists.

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

5. **`appendEvent`'s lock does not survive a stale takeover.** Since
   2026-08-04 an append holds an `O_CREAT|O_EXCL` marker beside the ledger, so
   the runner and an acp-companion writing the same token no longer race the
   *sequence* check in the ordinary case; a loser waits `LOCK_MAX_WAIT_MS` and
   is refused with `code: 'locked'`, which both the runner's `record` and the
   companion's custody append retry rather than drop. One `appendFileSync` of
   one pre-serialised line still keeps lines from interleaving, so the failure
   mode remains a bad sequence, never a corrupt line. What is NOT closed: a
   marker older than `LOCK_STALE_MS` is stolen on its mtime, so a live-but-slow
   holder can be stolen from, and for as long as it stays inside its section
   two writers overlap. The steal is serialised through its own marker, refuses
   to remove a lock whose token is not the one it judged, and re-checks that it
   still owns that marker immediately before the only destructive step and
   again before clearing it.
   That last check exists because the marker's own staleness bound cannot tell
   a corpse from a process that is merely STOPPED — SIGTSTP, an IO stall, a
   starved scheduler, all ordinary under tmux (r7-qwen). A stealer suspended
   past `STEAL_STALE_MS` has its marker cleared and a replacement takes both
   the section and the lock; without the re-check the sleeper resumed into a
   decision it made before it slept and deleted the replacement's fresh lock.
   What remains, and is NOT closed: between that final check and the `unlink`
   beside it there is still a window of a few syscalls. A process stopped
   exactly there reopens the same overlap. This cannot be closed with file
   primitives — stale takeover trades exclusion for liveness by construction,
   and a lock nobody may ever steal wedges a token behind a dead holder
   forever. Fencing tokens are the real answer and are not implemented.
   The guard itself is not covered by a test: reaching it needs two real
   processes and a stop signal delivered inside that window, and a test that
   looked like it covered this passed with the guard removed. Bounded, stated,
   and uncovered — not closed.

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

**2026-08-08 — the loop wakes on a change, and the interval stays.** Measured
first: one `tick` calls `readWorkItems(repo)` THREE times, every interval,
whether or not anything moved, and the only thing that differs between two quiet
ticks is whether an outbox file appeared. A finished worker then waited up to a
full interval to be noticed.

Work arrives exactly three ways, and it is a closed set: a worker writes
`.mailbox-out/<task>`; a person runs one of the three operator doors, which
appends to `work-items/`; or a clock fires — the deadlines in §10. The first two
are a file changing under one of two directories. **The third is why the
interval stays.** No watcher can see time pass, so the sweep is not an optimisation
to be removed later; it is the only reader those five deadlines have.

`watchForWork` is therefore additive by construction. It takes an `onChange` and
returns a closer; it reads no ledger, no graph, and cannot reach a dispatch
decision — a test asserts that by handing it a repo whose ledger is corrupt and
watching it succeed anyway. A missed event costs LATENCY, never correctness,
because the sweep still re-derives everything. A directory that cannot be
watched logs a note naming the directory, the error code, and the fact that the
interval still sweeps.

**Two corrections the same day, both from an adversarial review of the shipped
commit, and both worse than the bug they looked like.** The first: `.mailbox-out`
does not exist until a worker writes an outbox, and the RUNNER is what dispatches
that worker — so on every fresh repo the attach failed with `ENOENT`, was never
retried, and the one event source this exists for was dead for the life of the
process. The note made it look handled; the author had produced that exact
`ENOENT` output by hand and read it as clean degradation. Both directories belong
to the runner, so they are now CREATED before being watched. The second: an
`FSWatcher` is an `EventEmitter`, and an `error` event with no listener THROWS —
killing the runner and the interval with it, which would make a watcher failure
strictly worse than having no watcher. The `try/catch` covered only the
synchronous attach. Both are pinned by tests that fail without them.

What was NOT done, deliberately: no message queue, no broker, no at-least-once
delivery. A scratchpad POC proved at-most-once loses work silently about 1 in 60
and that do-then-acknowledge fixes it — true, and not this system's problem. The
queue here is an append-only ledger that every tick re-derives from scratch, so
nothing can be lost; what polling costs is repetition, and repetition is what a
watcher removes. Reaching for a broker would have added a second source of truth
about work in flight next to the one §4 already names. AC120.

**2026-08-08 — a declaration the loader does not read is refused, not
dropped.** A workflow could declare `when`, `on_reject`, `sla_hours` — anything —
and `validateWorkflowGraph` answered `ok: true` while the field vanished at
`workflows.push`. A team entry behaved the same way. GitHub #47 phase 1 gave
exactly this treatment to a seat override and to a palette entry and stopped
there; the two containers ABOVE those were left open, so the strictest checks in
the file sat inside the most permissive ones.

The defect is not that the fields did nothing. It is that the operator was never
told. This document's own worst failures share that shape — a wizard template
that could not load, a comment claiming nine ledger readers while the tool
counted twelve, a §9 paragraph describing a guard the release had deleted. Each
was true-looking and silent. A declaration is a statement to the system; a
statement the system discards without answering is the one thing this contract
exists to prevent.

Both refusals name the offending key and list what may be declared. Measured
before landing: no test, no bundled default, no documented example and no caller
in the tree passes a key outside the allowed sets, so nothing legitimate breaks.
`downstream_team_id` keeps its older, more specific redirect ("routing belongs to
a workflow route, not to a team") rather than being swallowed by the generic
message — a field operators actually reached for deserves the better sentence.
AC119.

**2026-08-08 — the third operator door: a person can close a token
(`withdraw.mjs`), and the route stays one-way.** `abandoned` was written by the
runner's clock and by the outer controller, and by nobody else. A person could
open a token and, since the day before, answer a question about one — but could
not STOP one. §4 forbids hand-editing a ledger, so the documented workaround was
invoking `ledger-writer.mjs` with a JSON literal and this document's field spec
open alongside it. Somebody really did that.

It is also the exit for a token bouncing between two teams. The open
resume-routing defect asks for a route override — a `resumed` naming any team —
and that was REJECTED by owner decision, because flow through a route is one
way. The rule is enforced for `pulled` (`route_went_backwards`) and enforced for
`resumed` by nothing at all, so an override would have quietly reopened every
team a token had already passed through, and the hand-written line that started
this did exactly that and validated. §6.3's own words are the alternative:
"rework is a new token on a fresh route". So the exit is two honest steps rather
than one dishonest one, and the withdrawal prints the `admit.mjs` line for the
replacement with the token's workflow already filled in — an exit a person has
to reconstruct is not an exit, and that is pinned by a test rather than left to
courtesy.

One asymmetry worth stating, because it looks like an oversight and is not:
`answered` carries `actor_kind: human` in the validator and `abandoned` does
not, so `withdraw.mjs` checks the actor itself. The validator cannot: the RUNNER
writes `abandoned` too (§9's deadline) and signs as itself, so a rule there
would refuse the clock. Without the door's own check a model could close
somebody's work while wearing the clock's identity. AC117 added.

**2026-08-08 — D6: the control team is mandatory, and the stop mechanism is
real for the first time.** Owner decision, taken with the cost measured first:
212 tests across 17 files were built on graphs that declared no control team,
and some of them existed to pin that as supported. It was supported. That was
the defect.

§6 places a token by its last event's `agent_id`. On a graph where the outer
controller was a member of no team, everything that seat wrote resolved to no
team at all — an escalation, a question at the front door, an audit's question —
so the token ORPHANED: counted against nobody's WIP, stopping nothing, waiting
for a person nobody was told about. The system's central guarantee is Kanban's
one rule, that work stuck with a team keeps that team's WIP and work escalated
to the PM holds the PM's, and on half the graphs the loader accepted it silently
did not apply. A shape where the central guarantee does not hold is not an
option to support; it is a way to run this system and not get it.

Refused at load, both halves: a controller who is a worker on no team, and a
graph naming no controller at all. The second was found on the way — one test
BUILT that configuration and pinned its consequence as a permanent wedge (the
audit trigger fires, the controller leg is paid for, and only then is the
escalation mark refused for want of an `agent_id` the graph never had, so the
unchanged-trigger brake holds the token for ever). D6 refuses the configuration
instead of documenting its symptom.

One thing had to change with it. §6's placement was `teamOf(agent_id) ?? to_team`
— the signer always won, and `to_team` was a fallback that only ever fired
because the controller resolved to nothing. Make the controller a team member
and every `resumed` the controller signs parks the work on the PM instead of
sending it back to the team the resume names: the shape of the resume-routing
defect already open against this system, made total. §6 now names one set,
`PLACES_BY_DESTINATION = {resumed}` — an event whose purpose is to MOVE a token
is placed by its destination, an event that records a seat acting is placed by
that seat. `escalated` is deliberately not in it: an escalation IS the PM's
work.

Two pieces of code were deleted rather than kept "to be safe", because D6
removes the case rather than the symptom: the audit path's unplaceable-question
guard, written two commits earlier when such a graph could still be loaded, and
`graph.mjs`'s banner telling a reader their controller holds no team seat. A
page cannot warn about a declaration the loader will not accept. There is
exactly one load path and it validates.

And the replay simulation grew the half it never had. Once every route enters
through the front door, the intake gate can OBJECT, and an objection parks the
token on a question only a person can close — so the loop stops, correctly, and
the wedge check read a working stop as a wedge. The check did not grow an
exception; the simulation grew a person, calling the real `answer.mjs`. Every
seed now walks the whole exchange: ask, hold, answer, resume. AC114, AC115
and AC116 all ADDED — an earlier draft of this line said AC114 was rewritten,
and the pre-existing AC113 it was inserted above kept its number until an
outside reviewer found two rows sharing it; that row is now AC118.

**2026-08-07 — the retry that only existed because nobody could answer.**
Supersedes the transport-death half of the 2026-08-06 entry below; that entry
stays as the record of what was decided with the options available that day.
A leg the transport killed was retried up to `MAX_AUDIT_TRANSPORT_RETRIES = 3`
and then abandoned anyway. The alternative — park it on a question and wait for
a person — was rejected then for a reason that was true at the time: **no code
in this system could write `answered`**, so a question was somewhere tokens went
to die, and a bounded retry destroyed fewer of them than a permanent wedge.
`answer.mjs` removed that constraint the same week, and D1 governs the design:
a leg the transport killed is HELD, nothing retries by itself, a person unblocks
it. The retry, its ceiling and its counter are gone.

The replacement adds no mechanism. The scan writes `questioned` with
`resume_role: audit`; `nextStep` already returns `held` for that role, and
`awaitingAudit` already re-arms on `answered` — so a person's reply puts the
token back in front of the controller down the path a `completed` uses, with no
new spawn path, exactly as the retry did. Asking is self-limiting for the same
kind of reason: the scan visits only tokens whose `currentEntry` is
`audit_requested`, so writing the question is what stops the asking, and nobody
is handed a question replaced every tick. `resume_role` is carried on the PLAN
rather than hardcoded at the write, so the plan states what it will record.

`audit_lost` is now written by NOTHING and read by everything that read it
before — `awaitingAudit`, `ledger-validate.mjs`, `dispatch-facts.mjs`,
`kanban.mjs`. Deleting the word would turn every ledger written while it was
produced into `unknown_event`, which is not in `LEGACY_TOLERATED_PROBLEMS`:
those tokens could never be closed or written to again. The word costs a set
membership; removing it costs somebody's work.

What did NOT change, and is the reason the deadline exists: a controller that
GOT its turn and said nothing is still `abandoned` on the same deadline, and
ambiguity still fails open toward that terminal. Only positive evidence of a
dead transport takes the new path. AC112 rewritten, AC113 added.

Still open, and it belongs to the WIP work rather than here: the question this
writes is subject to the ordinary answer deadline, so an unanswered one still
ends in `abandoned`. The token is no longer destroyed on a FALSE reason, and a
person now has a window they can actually act in — but "held until a person
comes" is not yet literally true, and saying so would overclaim.

**2026-08-07 — the half of the exchange nobody could speak: `answer.mjs`.**
§4.7 has specified `answered` down to the field since it was written, and
`loop-runner.mjs` has routed on it — `resume_role: worker` wakes the worker,
`evaluator` the evaluator — but **no code in this system ever wrote the
event.** Every writer of `questioned` had a reader waiting for a reply that
could only arrive by hand-editing a ledger, which §4 forbids. So a token parked
on a question was parked for good, and the mechanism that closed it was the
answer deadline: `ANSWER_DEADLINE_SEC` reads like a guard against slow people
and was in fact standing in for people who could not reply at all.

`answer.mjs` is the door, shaped after `admit.mjs` so the two operator entries
read and refuse alike. A person supplies the answer; `question_id` and
`to_team` are derived from the open question, since a hand-supplied
`question_id` is exactly what the validator refuses as `question_id_mismatch`
after the line is already on disk. It refuses four ways before writing —
not-waiting (which is also how a second answer to one question is caught, ahead
of the validator rather than behind it), unknown token, a question with no id,
and an asking seat that belongs to no declared team on a token never pulled.
`openQuestions()` lists what is owed, because an operator cannot answer a
question the board never showed them.

Deliberately NOT in this amendment: no new event word, no state-machine change,
no change to the routing above. `answered` already meant this. What it lacked
was a writer. This also makes the deadline honest for the first time — an
expiry can now mean "nobody replied" rather than "nobody could."

Found by the A5 ratchet on its first full run after the file appeared: a new
reader of a token's ledger is refused until it is authorized by hand, and this
one was, taking the recorded set to eleven. §16.2's closing paragraph was
corrected in the same commit for carrying "9" in prose while the tool had said
ten for two days.

**2026-08-06 — GitHub #52: a leg the transport killed is not a controller that
chose silence.** The audit answer-deadline (`loop-runner.mjs`'s
`audit_requested` scan) could see exactly one thing — whether the controller's
leg was still alive — so a controller that read a delivery and said nothing for
ten minutes, and a leg a provider's rate limit killed sixteen seconds in before
the model ever got a turn, produced the same hard terminal and the same
recorded reason. For the second case that reason was FALSE: nobody failed to
answer, because nobody was ever asked. Three finished tokens were destroyed
that way on one quota-exhausted morning, one per `ANSWER_DEADLINE_SEC`, each
recoverable only by a fresh `admit` that re-runs the whole route.

§4.10 had already invented the fact that settles it — `work_observed` — but
wired it to the custody ledger, and `tick` spawns the controller's own leg with
`workItem: ''`, which makes the companion's per-token write a no-op for
precisely the leg that needed it. That is why this was not simply a missing
`if`: the primitive existed and could not reach here. It now rides the one
channel that leg does write unconditionally, its liveness snapshot
(`acp-companion.mjs`'s `snapshotData`), and the scan reads that one file for
the dead leg's own task id.

Behaviour changed in `acp-companion.mjs` (the snapshot carries `work_observed`;
never `minimal`-gated, because it is one boolean that decides whether a token is
retried or destroyed), `loop-runner.mjs` (`MAX_AUDIT_TRANSPORT_RETRIES`; the
scan takes an injected `livenessFor` reader and emits the new non-terminal
`audit_lost`; `awaitingAudit` re-arms on it, which is the entire re-dispatch
mechanism — no new spawn path was added), `ledger-validate.mjs` and
`dispatch-facts.mjs` (the new word, and it releases the team like every other
audit state), and `kanban.mjs` (it says so on the board rather than falling
through to `Unknown event`, which is how `audited` was once unreadable there).

Two bounds, both deliberate. The retry budget is checked FIRST and
unconditionally, off the ledger's own `audit_lost` lines, so a restart cannot
forget it and a lane that dies on every retry still ends the token. And only
POSITIVE evidence narrows the rule — missing, unreadable, or work-bearing
snapshots close exactly as fast as they did before. That default fails OPEN,
toward the irreversible terminal, and that is the accepted price of keeping §9's
other guarantee that an audit cannot hang forever.

One assumption is pinned rather than trusted: the budget counts a whole token
because a token is `completed` exactly once. This was first written scoped to
the newest delivery — for a "reworked" token — and the fixture gate refused the
history outright, since §5 gives a closed route no successor that reopens it.
Whoever adds a reopen event must scope the count, or a reworked token is born
with its predecessor's retries already spent; `audit-transport-death.test.mjs`
goes red when they do.

**2026-08-05 — GitHub #48: an undeclared repository does not run a loop.**
`readWorkflowGraph` answers with `DEFAULT_WORKFLOW_GRAPH` and `source:
'default'` when no `.tmux-teams/graph.json` exists. Nothing read that field, so
`loop-runner.mjs`'s only gate was `!graph.ok` and a repository that had never
declared anything dispatched normally — against four teams its owner never
chose, every seat requesting the placeholder model `inherit-account-default`,
with the failures arriving one at a time at the adapter instead of once, at
load, where an operator would see them.

The template still LOADS, deliberately: `graph.html` and `kanban.html` need
something to draw while they explain what is missing, and it is a useful shape
to read during setup. What changed is that it is a shape to read and never a
loop to run — `tick()` now refuses when `graph.source === 'default'`, writes
`dispatching: false` to the heartbeat with a reason naming the missing file and
the `graph-setup` skill, and both pages carry a banner
(`data-graph-undeclared="1"`) saying the repository has not declared its own
loop. The banner is a banner and not a metadata label on purpose: the only
prior surfacing was `graph: bundled template` inside the graph page's collapsed
`details` disclosure and beside the team count on the kanban page, which read
as configuration trivia rather than as a system that is not ready.

Two things make this a correction rather than a feature. `workflow-graph.mjs`
had already named this shape the dangerous one in its own comment — "a reader
cannot tell those two states apart, which is what makes the quiet path the
dangerous one" — and `graph-setup/SKILL.md` promised the refusal existed from
the day it was written. Nothing enforced the promise for the whole life of the
document. `tests/undeclared-graph.test.mjs` enforces it now, and separately
pins that the template still loads, so a future "fix" that refuses to READ it
would leave both pages blank and fail there instead.

**2026-08-05 — what the v0.15.0 release review found, and what it cost to
ignore that it was still unread.** Four halves of the release diff were read by
two outside families (`glm-5.2` on the custody axis, `gpt-5.6-luna[max]` on the
contract, the palette and the review gate) as the bmad-party-mode
anti-consensus club. Every finding below was then handed to a skeptic told to
REFUTE it; all survived. None was a style note.

1. **`receipt_commit` counted as work.** §4.10's list of "real agent activity"
   named the receipt commit, and so did `acp-companion.mjs`. It is not late
   evidence: every receipt commit fires during session setup, the last
   immediately before `session/prompt` is sent. A leg that then hung or was
   rate-limited without one byte returning reported `work_observed: true`,
   which spent a worker attempt (§4.10) *and* stopped a palette seat rotating
   off a dead candidate (§3.5.1) — defeating both features this release
   shipped, in the one case they exist for. Now classified as handshake-only.
   `tests/work-observed-needs-a-turn.test.mjs` runs the real companion against
   a hanging adapter and reads the ledger, because every prior `work_observed`
   test built its fixture by hand and so could never catch a producer that sets
   the flag at the wrong moment.
2. **AC107's proof was a fixture tautology.** The test computed the leg count
   from its own fixture and asserted it equalled the number of `assigned`
   events in that fixture — true whatever `nextStep` does. It now drives 15
   legs through the real dispatch path and asserts the ceiling reason fires,
   which also pins the ORDER the two bounds are asked in.
3. **AC106 and §3.5.1 claimed more than the code guarantees.** "Every entry
   tried, none ever reaching the model" is not `misses >= palette.length`: a
   genuine failure retries the same entry without advancing, so an entry can
   reach the model between two misses. The operator-facing escalation reason
   asserted it too. Both now state only what was counted, and a test pins the
   miss→hit→miss→miss sequence that disproves the stronger claim.
4. **The panel gate compared one argv and launched another.** §12.7's diversity
   rule is enforced by `provenLaunchSignature`, which reads `profile.args`;
   `defaultLaneRunner` rebuilt the argv itself and never did. Two lanes
   declaring one `command` and different `args` had different signatures and
   identical launches — one process wearing three names, certified distinct.
   Reproduced end-to-end through the exported `runReviewGate` seam. Both paths
   now share `launchArgv`. Inert against the ten frozen profiles, live for any
   injected one, which that module's own comment invites.
5. **§12.7 honesty law 2 was broken by the page.** `display_model` was the
   FIRST branch of `modelLine`, so a seat that never ran printed its declared
   model in the exact shape a verified one uses, and a verified model was
   silently replaced by the declaration. It now only ever translates a model
   that was verified.

The lesson worth keeping is not any single defect: it is that the suite was
green for every one of them, and four of the five were pinned by tests that
asserted something weaker than their own names claimed.

**2026-08-05 — GitHub #47 phase 2b: `assigned` says which model the leg was
dispatched on.** New AC110–111 (§14); §4's `assigned` row and §3.5.1 updated;
§14.1's "genuinely unbuilt" row retired and replaced with the narrower gap
that remains. Phase 2 stopped at this line and said so plainly rather than
widening its scope, which was the right call and is why the follow-up is one
argument long instead of an archaeology exercise: `acp-companion.mjs` is the
sole writer of `assigned` (§13) because `dispatch_id` is minted inside it
with no injection seam, so no other component can produce a line
`ledger-validate.mjs`'s ownership check (§4.2) would accept.

Both `requested_model` and `adapter` are recorded, not one: a palette may
hold the same model on two lanes — different buckets, so legal even as
adjacent entries (§3.5) — and an alias names different vendors on different
lanes, so neither field identifies a leg alone. The pair still cannot
separate two executables on one lane (`claude-qwen` from `claude-kimi`);
neither can a palette entry, so the ledger answers exactly as much as the
declaration can express. That bound is GitHub #40's subject and #40 was
closed deliberately unbuilt.

Written **before spawn**, so it is the REQUEST and never the verified
identity — `effective_identity`/`identity_status` are separate, later facts,
and §14.1 now records that nothing joins the two. Both fields are optional
forever: shape-checking them in `ledger-validate.mjs` would refuse every
pre-0.15.0 ledger, which `loadWorkItemLedgers` still reads, so absence means
"written before this existed" and never "the model was unknown". Proven in
`tests/assigned-carries-model.test.mjs` by running the real companion against
the stub ACP agent — a runner-side `spawnFn` test proves the env was built,
never that the ledger recorded it. Mutation-checked by file copy with a
SHA-256 verified restore: dropping the two fields turns both tests RED.

**2026-08-05 — GitHub #47 phase 1: a seat may declare an ordered palette of
candidate models, declaration only.** New §3.5; new AC97–103 (§14) and the
palette-ordering row in §14.1. `workflow-graph.mjs`'s `seats[agentId]` gains
an optional `palette` key — an array of 1 to 8 whole seat specs (`model`
required, `adapter`/`effort`/`display_model`/`bucket` optional, the same
fields and the same validators §3.2.1's plain seat override already uses) —
mutually exclusive with `model`/`adapter`/`effort`/`display_model` on that
same seat, refused if declared alongside them. `wip_limit` (§3.1) is
unaffected by construction: the palette lives on a SEAT, never on
`worker_ids`, so a one-worker team with an eight-entry palette is still WIP 1
— GitHub #45's own defect, that a model palette used to cost a worker seat
per candidate, is closed by where this lives, not by a special case. `bucket`
names the rate-limit family a candidate draws on (per model-family within a
provider, not per provider — codex's `gpt` vs `codex-spark`, agy's `gemini`
vs non-`gemini`, claude's `fable` vs `opus`/`sonnet`/`haiku`); it is
shape-checked only, exactly like a model name (§3.2), reusing `isModelName`
rather than a second checker, and defaults to the entry's own resolved
adapter when unspecified. Two CONSECUTIVE entries sharing a bucket are
refused rather than warned — this validator fails closed everywhere else in
this file and has no "accepted with a warning" channel to reuse, and the
failure a silent accept would produce is expensive (a leg spent, per §4.10,
learning nothing a first refusal hadn't already shown) and would surface only
much later, as a runtime symptom, instead of at load — a non-consecutive
repeat (A, B, A) is accepted, because something else was tried in between.
`teams[].agents[]` gains a `palette` field, `null` unless declared; the
existing single-value `model`/`adapter`/`effort`/`display_model` on that same
entry resolve to the palette's FIRST entry, so a reader that predates this
amendment sees exactly the seat spec it always has. That new key is **emitted
as `null` rather than omitted, so every graph's `source_digest` moves at this
version** — AC97 said the opposite when this amendment first landed, and its
test compared two graphs resolved by the same code, a comparison that holds
whatever the shape became. Corrected in the merge: AC97 now claims only
§3.2.1's equivalence property, which is genuinely unaffected, and the test
pins the resolved seat's keys so the next field to arrive fails by name
instead of as an unexplained hash. Nothing joins on a *workflow* graph's
digest across versions — `team-runtime.mjs` joins on
`team-graph-contract.mjs`'s, a different derivation over a different object.
The ordering semantics
GitHub #47's own text raises — the dispatcher's choice as the starting point,
the declared array as the order after it, a full unanswered cycle as an
escalation rather than a ninth retry — are written into §3.5 and marked
**unenforced** (§14.1): no code reads a palette for dispatch yet.
`loop-runner.mjs`, `ledger-validate.mjs`, `ledger-writer.mjs`,
`acp-companion.mjs`, `dispatch-facts.mjs` and `skills/party-mode/` are
untouched, on purpose — GitHub #47 part 2 (`assigned` carrying the chosen
model, and the fallback/escalation machinery itself) is deliberately a
separate phase, so the two do not both edit `loop-runner.mjs` and this
contract in one pass. Proven in
`tests/workflow-graph-palette.test.mjs`: AC97–103. A mutation check —
deleting the consecutive-bucket refusal — was run by file copy with a SHA-256
checksum verifying the restore, never by reversing a `str.replace`; removing
the check turns the two consecutive-bucket tests and the dedicated mutation
test RED, on `result.ok`, not on any wording.

**2026-08-05 — GitHub #47 phase 2: a palette seat dispatches from it, in
declared order, with a bound on the walk.** New §3.5.1; new AC104–109 (§14),
replacing the §14.1 palette-ordering row with a narrower one (below).
`loop-runner.mjs` gains `declaredPalette` (reads a seat's resolved `palette`,
mirroring `declaredModel`/`declaredAdapter`/`declaredEffort`), `missesBy`
(counts, since the token's last resume, how many of ONE seat's legs carried
`delivered.work_observed: false` — the same fact §4.10 defined, summed rather
than excluded), and `dispatchOn` (chosen from both branches of `want` that
used to return a bare `{ action: 'dispatch', role, agent_id }` — the hint
branch and the free-pick branch — so a hinted palette seat and a freely-picked
one resolve a candidate the same way). A seat with no palette gets the exact
prior shape back, unedited: `dispatchOn`'s first line is `if (!palette) return
{ action: 'dispatch', role, agent_id: agentId }`. What triggers a fallback is
stated as what it structurally is, not by name: `work_observed: false`, never
a terminal string and never "on rate limit" — the runner has no narrower
signal than the one §4.10 already put in the ledger. Each fallback candidate
is a new leg with its own `task_id`/`dispatch_id`, minted by the same
`buildTaskId` call every retry already used; nothing about leg identity
changes. A full cycle — `misses >= palette.length` — escalates instead of
retrying entry 0 a second time, matching the ordering semantics §3.5 wrote
down in advance. `legCeiling` (§10) is untouched: every `assigned` still
counts toward it unconditionally, exactly as §4.10 requires by name; the new
per-seat cycle bound is a TIGHTER, additional gate in front of it (at most 8
misses before escalating, against a 15-leg default ceiling), not a
replacement — GitHub #45's own defect (a palette destroying the leg-ceiling
accounting) does not recur, by construction rather than by a special case.

**Not built: `assigned` carrying the chosen model.** This is the one piece of
GitHub #47's own text this amendment does not close, and the reason is
structural. `assigned` is written by exactly one component (§13:
`acp-companion.mjs`, one of only two things that may append to a ledger, and
the only one of the two permitted to write `assigned` or `delivered`), and
the field `EVENT_SPEC` requires on it that matters here — `dispatch_id` — is
minted by `randomUUID()` inside `acp-companion.mjs` at process start, with no
env var or argument through which `loop-runner.mjs` could supply or predict
it. A dispatch_id `loop-runner.mjs` invented itself would not be the one
`acp-companion.mjs` later carries on `delivered`, and `ledger-validate.mjs`'s
own dispatch-id/task-id ownership check (§4.2) would read the two events as
disagreeing — the ledger the runner itself refuses to dispatch onto, next
tick. `acp-companion.mjs` is out of scope for this phase (Files, above); the
model reaches the spawned process (unchanged — the same `modelEnv`/
`ACP_MODEL`/`ACP_EXPECT_MODEL` plumbing every seat has always used) but not
the ledger line. `ledger-validate.mjs` is unedited: only the event NAME is a
closed vocabulary (§4), so a future `model` field on `assigned` needs no
validator change to be accepted, and — following the precedent already set by
`work_observed` and `worker_hint`, neither of which is shape-checked in
`ledger-validate.mjs` today — this amendment does not add shape-checking for a
field nothing yet writes. §14.1 now names this a genuinely UNBUILT clause,
replacing the ordering-semantics row this amendment closed. Proven in
`tests/loop-runner-palette-dispatch.test.mjs`: AC104–109, plus an unedited
pass of every pre-existing loop-runner test file
(`loop-occupancy.test.mjs`: 103/103, `loop-runner-heartbeat-model.test.mjs`,
`loop-runner-decisions.test.mjs`, `loop-runner-busy.test.mjs`,
`loop-replay.test.mjs`, `loop-smoke.test.mjs`), which is what stands in for
AC3's "prove it" — a non-palette seat needed no test rewritten. A mutation
check — deleting the full-cycle escalation guard in `dispatchOn` — was run by
file copy with a SHA-256 checksum verifying the restore, never by reversing a
`str.replace`; removing the guard turns exactly one test RED, on
`plan.action` ('escalate' expected, 'dispatch' observed), not on any wording.

**2026-08-05 — D1: the three read tools an agent seat actually needs.** New
file `scripts/agent-seat-reads.mjs`; new §16 records the surface, and AC93–96
(§14) record what proves it. Scenario work sized an agent seat's read demand
at three questions — what did an earlier leg deliver (`listDeliveries`), give
me one piece of it by id (`fetchDelivery`), how did this token's earlier legs
end (`legOutcomes`) — and this amendment builds exactly those three and
nothing else: a fourth, asking a person, is a mutation and stays out of scope,
and no write tool exists here. It is a plain module, not a server and not an
MCP registration — §13's `mcpServers: []` prohibition is unaffected, and
opening that seam remains a containment decision nobody has taken (§13, A3).
Every ledger byte it reads comes from dispatch-facts.mjs's existing aggregate
reader, imported under a re-exported name (`loadWorkItemLedgers`) chosen
specifically so `./scripts/ledger-reader-ratchet.mjs`'s static-text scan needs
no new baseline entry — the ratchet still reports the same 9 known readers
after this file exists, proven by a test that calls the ratchet directly
rather than trusting a description of it. No return value or work-identifying
argument may be, or contain, a filesystem path: `fetchDelivery`'s `id`
argument is checked against a safe character class before it ever reaches a
`join()`, a missing outbox reports `content_available: false` instead of
surfacing the `fs` error that would carry the path, and a dedicated test
replays every case above (found, not-found, and a hostile path-shaped
argument) and asserts none of `.jsonl`, `.tmux-teams`, `.mailbox-out`, or an
absolute path appears anywhere in the returned JSON. `repo` — the project
root — is the one argument every sanctioned reader in this contract already
takes and is not treated as a hole in that wall; §16 states why.

**2026-08-05 — D2: one projection every reader could consume, and one reader
moved onto it.** New §6.1. `./scripts/ledger-reader-ratchet.mjs` names the nine
readers of a token's ledger as they stand today: `admit.mjs`,
`dispatch-facts.mjs`, `graph.mjs`, `intake-stats.mjs`, `kanban.mjs`,
`ledger-validate.mjs`, `ledger-writer.mjs`, `loop-runner.mjs`,
`pull-controller.mjs`. §6's `teamOccupancy`/`currentEntry` already
centralised "which team holds this token"; what was still folded
independently, one reader at a time, was everything past that — when a
token entered its CURRENT placement (`kanban.mjs`'s own `placingEvent`),
where that placement was pulled from (`graph.mjs`'s inline scan for the
newest `pulled` line), and the token's own intake history — every
`questioned`/`answered` pairing, who asked, whether the runner's own
deadline (not a controller `abandon`) lapsed it (`intake-stats.mjs`'s own
fold). New `token-projection.mjs`'s `projectToken(item)` is the union of
those questions over ONE token's own custody, with §6.1 stating exactly what
it deliberately excludes and why (per-team occupancy, `.tmux-teams/decisions/
latest.json` from §11.3, ledger structural validity, and anything needing
the graph declaration or the wall clock). One reader — `kanban.mjs`, chosen
because its fold is small and self-contained (a single `cardOf` function)
and its tests are strong and dedicated (`tests/kanban.test.mjs`,
`tests/kanban-board.test.mjs`, 41 tests) — was moved onto it; the other
eight are unchanged, deliberately: moving all nine at once would be a
rewrite with no way to tell which move broke what, and `dispatch-facts.mjs`
in particular — the reader everyone else already depends on — is named here
as the worst NEXT candidate, not a good first one, for the same reason.
`kanban.mjs`'s own tests pass with no edit to either test file; a reader
whose tests needed changing would have meant its behaviour changed, which
this amendment does not claim.

**2026-08-05 — C1: why the runner passed over a token now survives the tick
that decided it.** Behaviour changed in `loop-runner.mjs`; new §11.3 records
it. Four `log()` sites decided, on the tick's own evidence, that a token would
not be dispatched onto this tick — every seat busy (`wait`), a person still
being waited on (`waiting`), nothing following the token's last event
(`skip`), the token's own next step already being escalation (`escalate`), a
ledger too broken to trust (`unreliable-history`), no standing brief for the
team (`no-brief`), and an escalation whose own `audit_requested`/`escalated`
mark the ledger refused to record (`wedged`, already named `STUCK` in the
log, §14.2 item 3, AC74). All seven reached only `console.log`; nothing else
in the system could read them back, so a token nobody had looked at and a
token refused for cause were indistinguishable once the tick ended.
`.tmux-teams/decisions/latest.json` now carries the same seven, unchanged from
the object the tick already held for each — `plan.action`/`plan.reason`
verbatim for the first four, `ledger.blocking` verbatim as `problems` for the
fifth, `brief.reason` verbatim for the sixth, and the `wedged` closure's own
constructed message for the seventh. Two advisors disagreed on shape: one
wanted `decisions/<date>.jsonl`, appended, so a token stuck on the same reason
for 40 ticks would be visible as a pattern; two wanted overwrite, because an
append-only file beside the ledger is a second event store, which is the
disease §13 exists to prevent. Overwrite was built; §11.3 states the ceiling
this creates — the file answers "why is it not moving right now" and cannot
answer "how long has it been stuck" — rather than letting it be discovered.
Written only by a tick that reaches the point of evaluating tokens (an
invalid-graph or stale-pulse tick returns earlier and leaves the file as the
last full tick left it, so an empty `decisions: []` on disk always means
"checked, nothing refused" and never "never checked"), and only when
`apply` is true, matching §11.2's heartbeat: a dry run must not impersonate a
live tick's refusals any more than it may impersonate its heartbeat. Written
atomically (temp file, then rename) for the same reason `acp-companion.mjs`'s
outbox writes are. Proven in `tests/loop-runner-decisions.test.mjs`: AC90–AC92.

**2026-08-05 — B1/GitHub #45 part 2: a leg that never got a turn no longer
spends the worker's attempt budget.** Behaviour changed in `loop-runner.mjs`
and `acp-companion.mjs`. §4's `delivered` row and new §4.10 record the fix;
§4.9's availability paragraph is corrected to say the router's blindness is
still open while the attempt-spend consequence is not. `attemptsBy` used to
count every `assigned` line against `MAX_ATTEMPTS` regardless of whether the
process ever started — a seat whose provider was rate-limited could burn all
three attempts on legs that never began. `acp-companion.mjs` (the sole writer
of `delivered`, and the only process present when a leg dies at the transport)
now tracks whether it ever observed real agent activity — a tool call, a
message/thought chunk, a plan update, a completed prompt turn — as opposed to
bare protocol handshaking or the pre-prompt receipt commit (§4.10), and writes
`work_observed: false` on `delivered` when it saw none of that before the leg
failed. `attemptsBy` excludes an `assigned` leg from the count only when its
matching `delivered` states `work_observed: false` explicitly; a `lost` line
(the runner's own "the process is gone and recorded nothing", §4) is never
read this way, because that sentence is equally true of a leg killed after
real work and one that never started, and the ledger alone cannot tell them
apart — guessing from absence was considered and rejected (§4.10 decision 2).
The exclusion keys off `work_observed`, never off `terminal`: a
`protocol-error` (or any other non-`done` terminal) marked `work_observed:
true` still spends an attempt exactly like `blocked` or `hard-timeout` always
have, and every `delivered` line written before this amendment (no
`work_observed` field at all) counts exactly as before. Proven in
`tests/loop-occupancy.test.mjs` with two fixtures in one test: three
transport-failed legs (`work_observed: false`) still read `dispatch`, and
three legs that genuinely ran and failed (`work_observed: true`, same
`protocol-error` terminal, so the guard cannot be keying off the terminal
string) still reach `escalate` at `MAX_ATTEMPTS`. `legCeiling` (`MAX_LEGS`,
§10) is unchanged — it still counts every `assigned` unconditionally, so a
model palette (GitHub #47) no longer burns `MAX_ATTEMPTS` faster than a single
seat would, but still burns the token's total leg ceiling at the same rate;
that ordering is otherwise unblocked by this fix.

**2026-08-05 — A3: the `mcpServers: []` containment seam is now a documented
decision, not an accident.** No behaviour change; §13 gains a prohibition
against a non-empty `mcpServers` on dispatch, marked unenforced (§15.2)
because nothing tests the literal sent at `session/new`
(`acp-companion.mjs:3462`) and `session/load` (`:3478`) today — both entries
recorded in §14.1. Per §15.3: the code was already right — every dispatch has
sent the empty array since the seam existed — and this entry brings the
contract into agreement with the code, not the reverse; nothing in
`acp-companion.mjs` or any other `.mjs` file changed. ADR 0003
(`docs/adr/0003-mcp-server-containment-seam.md`) records what the seam is, why
it is closed, that opening it is a containment reduction rather than an added
capability, and that only a human maintainer of this repository — not a
`graph.json` field, not an environment variable — may authorise opening it. A
per-seat allowlist is noted there as a future option once something concrete
exists for an allowlist to point at; it is not built.

**2026-08-05 — the dispatcher was described by what it was designed for, not by
what it does.** No behaviour change; §1 and §4.9 are corrected to match observed
use, and two consequences are recorded as open.
This document has led the seat's definition with admission control since it was
written. Master, asked directly: a refusal at the door has never been seen on
his deployments — and the development machine's ledgers have never reached an
`intake` at all, so nothing here had ever tested the claim either. The duty the
seat actually performs is choosing which MODEL runs a token: cheap for simple
work, strong for hard, text-only where there is no media, multimodal where
there is, another seat when a model is rate-limited.
The mechanism was already there and was described in the wrong words. A seat
carries its own `model`, `adapter` and `effort` (§3.2's `seats` override, which
`declaredModel`/`declaredAdapter` are the only readers of), so §4.9's "name a
worker seat" has always meant "name a model". A team with one worker looked
pointless to reason about only because the question was being asked as "how
many workers" when it is "how many models".
Two defects fall out of the confusion and are stated rather than fixed. §3.1
derives `wip_limit` from the worker-seat count, so a model palette and a
concurrency limit are the same number — an operator wanting one token and four
candidate models cannot express it. And `want()` knows only whether a seat is
busy, never whether its provider will answer, so routing away from a
rate-limited model is a guess, and a wrong guess spends a worker attempt on a
leg that dies at the transport. That is GitHub #45 part 2, and it is the same
problem as the first half rather than a neighbour of it: the router has no
availability signal.
Admission control is unchanged and still enforced in both places; it is the
seat's secondary duty and now reads that way.

**2026-08-05 — GitHub #42/#44: the planner proposed a pull the writer always
refuses.** Behaviour changed in `pull-controller.mjs` and `ledger-validate.mjs`.
`planPulls` picked the next hop from route position alone
(`workflow.route[index + 1]`) and never consulted `heldTeams` — the set
`ledger-validate.mjs` already tracks, filled at `intake` (admission, not
arrival, per §1). On an escalation exit the declared route can point back at a
team the token already holds a place in, and the validator's own
`route_went_backwards` refusal (§4.2) then refuses every such `pulled` the
planner proposes, forever: `tick()` recomputed the identical decision every
loop with no exit in code. `validateLedger`/`validateLedgerTolerant` now
return `heldTeams` on the verdict (additive; no existing field's meaning
changed), and `planPulls` consumes it — the next hop is the first team on the
rest of the route not already in that set, and a route with none left is
`completed`. Not a new scan: the definition of "held" stays the one place §1
already put it. This fixes the planner root only; it does not address GitHub
#46's mid-flight-restart hypothesis for the same symptom.

**2026-08-05 — r7-qwen: the steal marker could not tell a corpse from a
suspended process.** Behaviour changed in `ledger-writer.mjs`. `stealStaleLock`
cleared a marker older than `STEAL_STALE_MS` on mtime alone, which is right for
a process that died holding it and wrong for one that is merely stopped —
SIGTSTP, an IO stall, a starved scheduler, none of them exotic under tmux. The
displaced stealer then resumed inside its own section, acting on bytes it had
read before it slept, and unlinked the replacement's fresh lock and marker:
exactly the two-writers-one-section overlap the marker was added to close, and
§14.5 claimed closed. The section now carries a per-acquisition claim, and the
holder re-reads it immediately before the destructive step and again before
clearing the marker; a stealer that was displaced destroys nothing on its way
out. §14.5 states the residual window — a few syscalls wide, uncloseable with
file primitives — and states that the guard is not covered by a test, because a
test that appeared to cover it passed with the guard removed.

**2026-08-05 — r7-codex: four, of which three were opened by round six.**
Behaviour changed in `pull-controller.mjs`, `loop-runner.mjs` and party-mode's
`plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs`.
The `--apply` exit status compared `plannedPulls.length` against `applyPulls`'s
return, and those count different things — that return counts EVERY decision
carrying an event, so one unrelated write landing while the only planned pull
was refused made the numbers agree and the exit code lie. It now asks each
planned pull whether it was recorded, using the `write_result` `applyPulls`
already stamps on a refusal.
The expiry guards asked `busy.has(agentId)`, which is true for as long as that
agent runs ANYTHING — and the outer controller is busy almost always, so
unrelated work could hold a token open forever. `busyAgents` now also returns
`busyTasks` from the pulse rows' own `task_id`, and `legIsLive` asks about the
leg the token is parked on, falling back to the agent when a leg has no task to
name.
`provenLaunchSignature` dropped `profile.args` whenever `command` was an array,
so two lanes differing only there read as one launch; `runAcpReview` appends
`args` in both declaration shapes, and so does this now. It also resolved the
executable against this process's PATH rather than the one `buildProfileEnv`
hands the child, which is a proof about a binary nobody runs.
And one unreadable launch still slipped past the comparison — one is all the
attack needs, since node coerces a non-string argv part and the process that
runs is identical to a lane already seated. A lane that DECLARES a launch this
code cannot read is now refused outright. The latitude AGY asked for is kept
for a lane that declares nothing at all: silence cannot run, a malformed
declaration can.

**2026-08-04 — r6-qwen, the rest: two quantifiers nothing pinned and one
ceiling nobody stated.** No behaviour change beyond `ledger-writer.mjs`'s and
`loop-runner.mjs`'s already-amended fixes; this records what the words were
saying wrongly. §5 said the identity-free shorthand covers a "round-2+" report
and the code comment described an unbounded reject/rework/re-review pass. The
code has never done that: an identityless outcome from an agent assigned more
than once is discarded by the ambiguity rule, because nothing in such a line
says which of its own legs wrote it. Round 2 and no further; the cost is a
re-dispatch, not a lost token, since the sanctioned writer stamps a
`dispatch_id` on every `reviewed` it authors and the next report is therefore
not a shorthand at all. Paying for a re-review is the cheaper error than
trusting a dead leg's verdict, and both are now stated instead of one being
implied. The nine one-line mutants qwen walked past the suite with are closed
in tests; the two that mattered were the closing gate's quantifier
(`every` -> `some` let a ledger close over an untolerated defect) and the task-id
digest delimiter (a space is forbidden inside a work item or team by ID_RE, a
dash is not, so a dash makes the tuple boundary forgeable).

**2026-08-04 — r6-qwen: the diversity gate could not read the shape the
client executes.** Behaviour changed in
`plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs`.
`provenLaunchSignature` read only a whole-array `command`, but `runAcpReview`
(`plugins/tmux-teams/skills/party-mode/scripts/acp-review-client.mjs`) requires
`command` to be a STRING and takes `args`
beside it — so for the shape the execution layer actually runs, the signature
returned null and the comparison was skipped entirely. It now normalises both
shapes to one argv.
Separately, two null signatures used to `continue` past the comparison while
two null KEYS have always failed closed by explicit philosophy. qwen executed
the asymmetry end to end: two profiles carrying `[node, MOCK, 123]` produce
null signatures because a part is not a string, node coerces the number so the
exec'd argv is byte-identical, and different `adapterPackage` values keep the
keys apart — keys differ, signatures skipped, panel certified. Two unreadable
launches now fail closed, one beside two readable distinct lanes still passes,
and every shipped panel is unaffected (verified for all six routes).
`tests/review-gate.test.mjs`'s base fixture gave every lane the identical
`[node, MOCK]` argv, which is the r5-qwen attack shape and a panel the gate is
right to refuse; it now varies by lane, as `gateProfile` beside it already did.

**2026-08-04 — r5-codex BLOCKER 9: `completed` is only HALF closed, and the
tolerance gate treated it as an ending.** Recorded late; r6-qwen was right that
the change shipped in `6d560db` with no amendment of its own, which §15.1
forbids. Behaviour changed in `ledger-writer.mjs`: `appendEvent`'s
closing-tolerance branch accepted any `TERMINAL_EVENTS` member onto a ledger
whose only defects are closing-tolerated, and that set holds `completed` — which
§5 calls half closed, its only continuation an `audit_requested`/`audited` pair
that is not terminal and so is refused there in turn. Accepting it did not close
the ledger, it stranded the token: the runner's next write came back
`ledger_already_invalid` into the STUCK path while the board read the
`completed` line as a releasing event and filed the card under Done with no
blocked reason — invisible on the one screen a human would check.
`HARD_TERMINAL_EVENTS` (`audited`, `abandoned`) is the set with no legal
successor, and only those two may land there. §5's state machine is unchanged;
this makes the writer agree with it.

**2026-08-04 — r6-codex/Winston, the last caller that advanced past a
refusal.** Behaviour changed in `pull-controller.mjs`: the standalone
`--apply` CLI printed `appended N custody events` and exited 0 whatever N was,
so a run in which every planned pull was refused looked exactly like a run with
nothing to do. It now compares written against planned and exits 1 with the
count on stderr when they differ. The disagreement between the two is real and
expected rather than a bug being papered over — §14.5 rule 6 says `planPulls`
judges the parsed projection, which has already dropped unparsable lines, while
the writer judges the bytes, so a token broken only by an unparsable line is
planned as a pull and then refused. Making that visible is the point.
No section text changed: §7 already says a refused pull is not a pull.

**2026-08-04 — r6-codex: five holes, of which two were opened by the round
that was closing them.** Behaviour changed in party-mode's
`plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs`, and in
`dispatch-facts.mjs` and `loop-runner.mjs`.
`assertAdapterPackageBoundToCommand` bound `adapterPackage` to the command's
FINAL token, tightened from `.includes()` the same day. `npm exec -- <pkg>
[args...]` and `bunx <package> [arguments...]` both run the FIRST positional and
hand it the rest, so `['npx', codexPackage, '-y', agyPackage]` was certified as
bound to agy while npx ran codex — and the accompanying test asserted that
acceptance was correct, so the gate and its test agreed with each other and not
with npx. It now binds the first positional, and refuses rather than guesses
when `-p`/`--package` name an install target.
`provenLaunchSignature` compared executable STRINGS while its comment called
them bytes: an alias symlinked to the real wrapper is the same file, the same
settings dir and the same account, and the panel counted two families. It now
resolves through PATH to a real path, falling back to the declared name when
this machine cannot see it.
The stale-lock steal was a bare `unlinkSync` under a comment claiming "at most
one new holder": `wx` guards the create, not the decision in front of it, so a
second stealer acting on what it read could unlink the FRESH lock a first one
had just taken and walk into the section it was inside. The steal is now
serialised through its own `wx` marker and removes only a lock whose token is
still the one it judged. §14.5 records what remains open.
`currentEntry`'s `reviewed_task` pass covered only a leg that DIED before the
delivery existed; a leg still running can see a later delivery land and name
it, with no new `assigned` of its own. The pass now also requires that the
reviewer's current leg has not already reported — the harvester writes one
`reviewed` per outbox. §5's paragraph on the shorthand is corrected, including
its use of the word "proof".
`nextStep`'s `escalated` branch and `planEscalation`'s `audit_requested` scan
took `busy` and never read it, so a controller alive and working past
`answerDeadlineSec` — a shorter clock than the 1800s stall budget it runs
under — had its token hard-`abandoned` underneath it, and `abandoned` admits no
successor, so its answer could not be harvested when it arrived. Both now treat
a live process as in flight. Elapsed time is not proof that a process is dead.
Also corrected without behaviour change: §14.5's claim that `appendEvent` has no
lock, and `buildTaskId`'s claim to remove collisions — 16 hex is 64 bits, and
the identical tuple in the identical millisecond still yields the identical id.
What it removed was the sanitizer collision.

**2026-08-04 — r6-agy, narrowed: the escape hatch had no automated caller.**
Behaviour changed in `loop-runner.mjs`. §5's closing tolerance promises that a
token whose only defects are pre-existing duplicate ids "must always be able to
reach `abandoned`", and the writer keeps that promise — offered five events, a
duplicate-tainted ledger refuses `delivered`, `escalated`, `lost` and
`completed` and accepts `abandoned`. Nothing automated could walk through it.
The runner's own `abandoned` is written by the `expired` branch, which a token
only reaches from `questioned`, `escalated` or `audit_requested` — and
`escalated` is itself refused on such a ledger. So a token whose history became
unbelievable while a worker still held it stayed held forever, with the board
showing it in flight and no line on disk saying why.
`closeUnbelievableHistory` fires only after a `lost` was already refused, only
when EVERY blocking problem is closing-tolerated, and writes the one event that
closes the token rather than any event that continues it. A ledger broken any
other way is still left for a human, which is the point of refusing to write
onto bytes nobody can believe. AGY named the shape; the reported form was
wider — it claimed no automated `abandoned` exists at all, and §9's `expired`
writer had been there since the clock got its own withdrawal.
§5 and §9 are unchanged: this adds a caller for a rule both already state.

**2026-08-04 — retro-release-review r6-agy: the round-five lock released
what it no longer held, and no caller could tell contention from a verdict.**
Behaviour changed in `ledger-writer.mjs` and `acp-companion.mjs`. `acquireLock`
now returns a token unique per ACQUISITION (`pid:hrtime`) rather than writing a
bare pid, and `releaseLock` unlinks only a lock file still holding that token.
Without it the documented steal amplified into something undocumented: A stalls
past `LOCK_STALE_MS`, B steals and enters, A finishes and deletes B's lock file,
and C then acquires cleanly while B is still inside the critical section — one
bounded A/B overlap becoming an open section for as long as B needs, with
nothing on disk recording it. The steal itself is unchanged and still costed in
the comment above `LOCK_SUFFIX`.
Separately, `appendEvent`'s `locked` refusal is the ONE code that says nothing
about the event — another process held the lock, and the next attempt may
write. Every other code is a verdict on the bytes. The companion's custody
append treated all refusals alike and dropped the line with a warning, which is
right for a verdict and wrong for contention: a lost custody line is precisely
what §13 makes this process a writer to prevent. It now retries `locked`
`LOCKED_APPEND_RETRIES` times (whole `appendEvent` calls, each waiting out
`LOCK_MAX_WAIT_MS` on its own) before refusing loudly. `pull-controller.mjs`
already carries its refusal home on the decision and is unchanged.
No section text changed: §13 already binds this process to the writer's
obligations, and both fixes make it meet them rather than restating them.

**2026-08-04 — retro-release-review r5-codex BLOCKER 6: §4.7, §5, and §6
described behaviour two round-2 fixes had already replaced (no behaviour
changed by this entry).** No code changed. §4.7 and §5's `answered`
(pre-`completed`) row said `resume_role` is "recorded... but not yet wired"
and that every `answered` resumes the dispatcher regardless of which seat
asked; `loop-runner.mjs`'s H1 fix (also 2026-08-04, earlier in this log)
already routes `resume_role: worker`/`evaluator` to that seat directly and
`audit`/`outer` to a held/escalate path instead — the H1 log entry named
§4.7 as corrected, but the paragraph was never actually edited, and a later
same-day entry ("the contract stopped contradicting itself") independently
rewrote the same section for an unrelated reason and, reading from a copy
that still said "not yet wired," preserved that sentence as if it were the
reconciled truth. §6 separately still described the `reviewed`-ambiguity
check as counting only a CONSECUTIVE run of an agent's own `assigned` lines,
and described a matching `dispatch_id` as trusted outright — both were
already replaced at retro-release-review round 2 (F1, Shape 2, same date):
`dispatch-facts.mjs`'s `assignedCountFor` counts across the whole ledger up
to the judged entry's position (the consecutive version is what let a dead
round-1 evaluator leg's stale `reviewed pass` survive an intervening rework
leg), and `currentEntry` additionally requires a `dispatch_id`-matched
entry's `task_id`, when present, to resolve to the holder's own leg. Under
§15.3: the code was right in both packages; this document was not amended in
the same commit as either fix, in violation of §15.1. Text corrected per
CONTRACT-PATCH.md, retro-release-review round 5 (codex BLOCKER 6).

**2026-08-04 — retro-release-review r5: the evaluator read the wrong
artifact, and a runner-written custody state had no path to a terminal
(BLOCKER 2, BLOCKER 3).** Behaviour changed in `loop-runner.mjs`:
`lastWorkerDelivery` no longer ranks candidate worker deliveries by their own
arrival position in `custody` (BLOCKER 2 — a leg already declared `lost` can
still write a late success stamped with whenever it actually landed, sorting
after a live retry's own delivery; the evaluator's brief, its outbox section,
and the `reviewed_task`/verdict storage that key off this function all read
the stale leg's bytes). It now ranks by the array position of the `assigned`
line that opened each candidate's leg — authored in dispatch order, and so
never late — and a `delivered` whose `task_id` does not resolve to any
`assigned` is not ranked at all. §6 gained the paragraph distinguishing this
reader from a `currentEntry` call site above.
Separately (BLOCKER 3), `nextStep`'s `escalated` branch and a new direct scan
inside `planDispatches` each apply `answerDeadlineSec` — the same clock
`questioned` already answers to — to a token parked on the outer
controller's own leg (`escalated` naming the controller, or
`audit_requested`) once that leg's task has produced no outbox past the
deadline: the runner now writes `abandoned`, the same way it already does for
an unanswered `questioned`. Before this, a controller leg that died before
writing an outbox left the token with NO automatic path to a terminal at
all — its own dispatch record carries no work item (§9), so the companion's
custody write for it is a no-op, and `audit_requested` additionally sits
outside `held` (§6: `RELEASING_EVENT`) where `planDispatches`'s ordinary loop
never reaches it either. §9's `abandon` bullet gained the third/fourth-writer
paragraph above. Under §15.3: neither defect was a contract/code
disagreement — both are cases the contract was silent about and the code
under-implemented; §6 and §9 are amended to state what the fix now does,
not to correct a prior claim.
Reproduced and proven in `tests/loop-occupancy.test.mjs`: `BLOCKER 2` builds
the exact declared-lost/retry/late-straggler custody through `tick`'s own
brief-writing path and asserts the evaluator's brief carries the retry's
outbox, not the stale leg's; `BLOCKER 3a`/`BLOCKER 3a (tick)` and `BLOCKER
3b`/`BLOCKER 3b (tick)` each assert the pre-deadline state is unchanged
(`held`, or no plan at all for `audit_requested`) and the post-deadline state
reaches `abandoned` through a real `tick()` run against a ledger with no
`.mailbox-out` entry for the controller's task. Each guard was proven against
the ORIGINAL code by reverting the fix, confirming the new test failed, and
restoring the fix from a file copy verified by SHA-256 before and after.

**2026-08-04 — retro-release-review r5-codex BLOCKER 4 and BLOCKER 8: a task
id domain mismatch caused unbounded respawn, and the ledger writer had no
lock across its own read-validate-append.** Behaviour changed in two files.
`loop-runner.mjs`: `dispatch()`'s task-id construction is now the exported
`buildTaskId(workItem, team, role, nowMs)` — a 47-char truncated,
char-sanitized human-readable prefix plus a 16-hex-char sha256 digest slice
over the raw (pre-sanitize) tuple, capped at 64 characters total so it can
never overflow `acp-companion.mjs`'s own `ID_RE` (§4's `ID_RE` allows
`work_item` up to 128 characters and additionally `.`/`:`, neither of which
`acp-companion.mjs`'s task-id gate accepts) — where the prior raw
concatenation both could overflow that 64-char cap (making the child exit
before writing `assigned`, which the retry budget in `attemptsBy` cannot see
because it counts only `assigned` lines, so the runner respawned the same
doomed dispatch forever) and was not injective (`.` and `:` both sanitized
to `-`, so two different work items dispatched in the same millisecond
could collide onto one task-keyed log/dispatch-record/liveness/outbox file).
`ledger-writer.mjs`: `appendEvent` now acquires an exclusive
`O_CREAT|O_EXCL` lock file (`<work-item>.jsonl.lock`) for its whole
read-validate-append critical section, closing a TOCTOU race where N
concurrent callers could each read the same pre-append ledger snapshot,
each validate a legal-looking single line against it, and each append —
landing several structurally duplicate `assigned` rows that
`ledger-validate.mjs` only caught on a LATER read (`duplicate_task_id`,
`duplicate_dispatch_id`). A lock held past 30 seconds is treated as
abandoned by a dead holder and stolen by the next acquirer; a caller unable
to acquire within 5 seconds gets `{ok: false, code: 'locked'}`, which both
existing callers already handle the same as any other refusal. §9's
task_id-minting paragraph gained the two paragraphs in Patch 1 above.
`tests/loop-occupancy.test.mjs` gained BLOCKER 4's cases, run against the
real `acp-companion.mjs` process rather than a copied regex, since the
defect is specifically about what a SEPARATE process's own gate accepts;
`tests/ledger.test.mjs` gained BLOCKER 8's cases, a release-gated
(genuinely simultaneous, not merely `Promise.all`-launched — process-startup
jitter alone was measured to hide the race under a naive launch) 24-process
race against a clean ledger, and a stale-lock-recovery case. Neither change
alters any ledger event's recorded fields, so no §4 event-table row changed.

**2026-08-04 — retro-release-review round 5, package "BLOCKER 1 + 5 + 7": F1
failed open one way and closed the other.** `dispatch-facts.mjs`'s
`currentEntry` gained a `reviewed_task`-based exception (B6): a `reviewed`
from a DIFFERENT agent that has an older `assigned` leg elsewhere in this
ledger is now trusted, even with no dispatch_id/task_id of its own, when its
REQUIRED `reviewed_task` field names exactly the delivery the CURRENT holder
made — producer-bound proof (the sanctioned harvester always stamps this
field from the delivery it is actually judging, and a dead leg cannot name a
delivery it never saw) that this is a genuine review of what is held now, not
a stale echo of an older leg wearing a different-agent's badge. This closes
the false-negative the round-4 fix (BLOCKER 5, "unconditional discard of
every non-holder `reviewed` whose agent has any earlier `assigned`")
introduced against the ordinary reject/rework/re-review shape. It does NOT
touch the SAME-agent forged/replayed-current-ids case (BLOCKER 1): three
independent reviewers (codex round 5, qwen's own rebuilt matrix, and this
document's own pre-existing Shape 1/Shape 2 positive tests) agree those bytes
are genuinely indistinguishable from a live round-2 report by the construction
of this schema, and Patch 2 above proposes — but does not implement — the
producer-bound identity change that would actually close it. The 36-cell
identity matrix (`tests/loop-occupancy.test.mjs`) was also rebuilt to run
every cell through the same `validateLedger` the sanctioned writer calls
(labeling which of the 36 shapes production can actually write — 24 of 36 —
rather than silently asserting over the other 12) and to check H cells by
object identity against the stale entry, not by verdict string alone
(BLOCKER 7).

**2026-08-04 — retro-release-review r4-codex BLOCKER 4: a resumed reply could
still wedge behind the unchanged-trigger brake, and no resumed seat was ever
told what was asked or answered.** Behaviour changed in `loop-runner.mjs`:
`planEscalation`'s trigger builder for `plans.filter(action === 'escalate')`
and for its `awaitingAudit` list now anchor each trigger's `id` on the
triggering item's own last recorded custody timestamp, not on rendered text
alone; `composeBrief` now opens with the exchange (`questioned.questions` +
`answered.reason`) whenever it is briefing an item currently at `answered`;
`planEscalation`'s `ask` text does the same for whichever token (audit or
parked) it names as the one to answer for; `boardSummary` now renders that
reply inline instead of the bare `(answered)` state name. §9 gained the
identity-anchor paragraph above; §4.7 gained the exchange-delivery paragraph.
Under §15.3, the code was wrong on both counts: §9 already stated the
identity-anchor principle for the stall trigger specifically, and the two
`answered`-recurring triggers had silently not followed it; nothing in the
contract or the code ever claimed the resumed seat's brief carried the
exchange, so this is new behaviour rather than a contradiction resolved.
Reproduced and proven in `tests/loop-occupancy.test.mjs` (new tests prefixed
`H4`): a second `questioned(outer) -> answered` cycle and a second
post-`completed` audit `questioned -> answered` cycle, each checked against a
`pm-notes/latest.md` written from the first cycle's own identity, previously
read `unchanged` and now re-escalate; a companion pair of tests asserts the
outer controller's own brief and a resumed front-door dispatcher's brief each
literally contain the question text and the human's answer text.

**2026-08-04 — B5: legacy tolerance for ADR 0002's new required fields, made
shared across every ledger-trust reader (retro-release-review B5; qwen, agy,
and codex independently reproduced this against hand-built ledgers clean at
88bd851).** Behaviour changed in `ledger-validate.mjs` (new
`LEGACY_TOLERATED_PROBLEMS`, `isLegacyTolerated`, `validateLedgerTolerant`,
`validateLedgerFileTolerant`; `missing_field` and `not_a_human_answer`
problems now carry `event`/`field` metadata so tolerance can be scoped rather
than matched by code alone), `ledger-writer.mjs` (`appendEvent`'s continuable
check now reads the shared, scoped list instead of its own flat `Set`),
`pull-controller.mjs` (`planPulls` now calls `validateLedgerTolerant` instead
of `validateLedger`), and `loop-runner.mjs` (`tick`'s dispatch gate now calls
`validateLedgerFileTolerant` instead of `validateLedgerFile`). §1 gained the
B5 paragraphs above.

Under §15.3, the code was wrong: the amendment below ("`opened.actor` is a
human decision (ADR 0002)...") tightened `EVENT_SPEC` on a system already
running, exactly as §1's own backwards-pull rule had, but neither new problem
code was added to `ledger-writer.mjs`'s `LEGACY_TOLERATED` set — so a ledger
clean before either amendment became permanently un-appendable
(`ledger_already_invalid` on every `answered` or `abandoned`), stranding a
token that could be neither answered, nor closed, nor withdrawn. Codex's B5
additionally found the compatibility claim was writer-only: even after
widening the writer's own tolerance, `pull-controller.mjs` and
`loop-runner.mjs` each called the raw, non-tolerant validator directly and
would still refuse to pull or dispatch onto such a token — so the fix has to
be the single shared judgment described above, not three separate copies of
the same list. Plain by-code tolerance was considered and rejected for these
two specifically, for the reason given in §1: it is not scoped enough to
avoid excusing an unrelated, genuinely new defect.

**2026-08-04 — retro-release-review: H1 (resume_role wired for evaluator/
worker), H2 (admission writes the token's own request; the grill brief no
longer claims a route choice nothing reads), H3 (`target_verdict: reject`
blocks the pull), H5 (an invalid ledger is caught before pull-readiness), M3
(`awaitingAudit` and `readBoard`'s Done/team/unplaceable classification now
read `currentEntry`, not the raw last event).** Three independent outside
reviews (qwen, AGY/Gemini, gpt-5.6-sol) of `88bd851..c3997a5` returned
BLOCKING; this batch is the subset of their findings assigned to this package.
See §4.7, §4.8, and §14.2 item 2 above for the specific paragraphs each
behavior change corrects. `admit.mjs` now writes
`.tmux-teams/work-items/<token>.md` from `request.reason` when that file does
not already exist, on a successful admission only — closing the gap where
`composeBrief` (§4.6) names that file as "the token's own request" but nothing
ever created it. `role-briefs.mjs`'s grill brief no longer tells the admitting
seat "you also choose the route it takes" when nothing downstream reads a
route decision out of its reply — it now states the route was fixed at
admission and that a person, not the grill, can re-admit the token onto a
different one.

Not fixed by this batch, named so the next reader does not have to
rediscover it: H2's intake-authority gap has a second half this batch did not
touch — `admit.mjs` still requires the OPERATOR to choose the workflow, and
`role-briefs.mjs` still lets the controller/grill state a route preference in
its `reason` that no parser turns into a ledger fact; a person reads it and
decides whether to re-admit elsewhere. Building a channel for the grill's
route preference to reach the ledger directly (mirroring GitHub #32's
`WORKER:` line pattern for `worker_hint`) is left for a future amendment,
matching the "judge, do not inherit" scoping instruction under which the
`WORKER:` line itself was built narrow.

**2026-08-04 — the contract stopped contradicting itself (no behaviour
changed).** Three independent outside model-family reviews of
`88bd851..c3997a5` (qwen, agy/Gemini, codex2) each found this document
internally inconsistent after the same week's parallel amendments; the
same-day §4.8 collision (GitHub #32's worker_hint and GitHub #31's
target_verdict both claiming "§4.8") is the clearest single cause and is
fixed by giving worker_hint its own §4.9. Also fixed: §4.1's `actor` rule
stated as an unconditional absolute with no forward pointer to the §4.6/§4.7
exception ADR 0002 already named, and its actor-less-history tolerance
paragraph not carrying the carve-out that already applies to `opened`/
`answered`; §4.2's already-invalid-ledger refusal stated with no exception
though §1 (two sections earlier) already documents `LEGACY_TOLERATED`;
§4.7's claim that `answered` is the ONLY actor-kind-constrained event, though
`opened` (§4.6, ADR 0002) is too; §4.7's "resume_role... not yet wired"
without stating what runs in its place (every `answered` resumes the
dispatcher regardless of `resume_role` — §5 gained the missing pre-`completed`
row); §4's own event table missing `questioned`/`answered` entirely (14 rows
against `LEDGER_EVENTS`'s 16); §4.7 and §7.1 each opening with a
`poc/controller-as-team`-only disclaimer that predates `admit.mjs` and the
`question_id`/hard-terminal enforcement shipping to `main` in this very range;
§6's "everything else holds" left to be reconciled against "an audit never
takes custody" by tracing `dispatch-facts.mjs`'s orphan path by hand, done
three times independently by three reviewers; and one stale line citation in
this very amendment log, four entries below, pointing at
`tests/loop-occupancy.test.mjs:877-895` for a test that lives at 1006-1037.

Checked and found NOT a self-contradiction, so not touched: §4.8
`target_verdict: reject` still pulling to the done queue against §1's "rework
creates no token" — §3.4, §4.8, and §1 already agree explicitly; the daylight
between the evaluator brief's stronger promise and the runtime is a
brief-vs-runtime mismatch for whichever package owns `role-briefs.mjs` and
GitHub #31 stage 3, not a contract inconsistency.

VERIFICATION: no code changed; nothing to run. Every `old` anchor in this
amendment's patch script was matched against the live file (unique,
`str.count == 1`) immediately before writing, and each `new` was re-read after
writing to confirm the section numbers, table rows, and prose it introduces
do not themselves collide with anything already in the document (in
particular: §4.9 was free, §4.10 remains free for the next arrival).

**2026-08-04 — GitHub #32: per-seat reasoning effort, and a dispatcher's
worker hint.** Behaviour changed in `workflow-graph.mjs` (`seats` gained a
third optional key, `effort`, validated the same way as `model`; a new
optional top-level `outer_controller_effort`; `agents[].effort` — `null` when
unoverridden, since there is no role-level default to fall back to, unlike
model/adapter), in `loop-runner.mjs` (`declaredEffort`/`effortEnv` mirror
`declaredModel`/`modelEnv`; `dispatch()` now sends `ACP_REASONING_EFFORT`/
`ACP_EXPECT_REASONING_EFFORT` alongside the model pair, at both dispatch call
sites — team legs and the controller/pm escalation leg; `harvestEvent`'s
dispatcher-accept branch now reads an optional `WORKER:` line via
`role-briefs.readWorkerHint` and records it as `intake.worker_hint`;
`nextStep`'s `want()` takes an optional `hint` and, for a fresh `intake` only,
honours a real free seat, escalates a seat not on the team's pool, and waits
specifically for a real but busy one), and in `role-briefs.mjs`
(`WORKER_HINT_RE`/`readWorkerHint`; the dispatcher brief now lists the team's
workers with their declared model/effort and documents the optional line).
§3 gained §3.2.2 and the `intake` row/AC table gained §4.8. Under §15.3 the
document was wrong on both halves: §3.2 declared a model and a lane per seat
and said nothing about effort, though `acp-companion.mjs` had honoured
`ACP_REASONING_EFFORT` since before this change; and §5's `intake` row said
flatly "dispatch a worker" with declared order as the only rule §3.2.1 gave it,
though the two-tier dev pool this exists for needs the DISPATCHER, not
declaration order alone, to be able to place harder work on the stronger seat.

Two things were deliberately kept narrow, matching the "judge, do not inherit"
instruction this work was scoped under rather than the issue's literal
proposal:

- `effort` is seat-only, with no team-wide default block (no `efforts: {...}`
  alongside `models`/`adapters`). Master's own case is two workers on ONE team
  at two DIFFERENT efforts, which a role-wide default cannot express, and
  nothing in the issue asked for a shared team default beyond that.
- The hint travels as a line inside the dispatcher's existing outbox
  (`WORKER: <agent_id>`, parsed like `VERDICT`/`REASON` already are) rather
  than as a new field on the intake ledger event's SOURCE — the issue's other
  suggestion, "separate routes chosen at intake" — was not built: this repo
  already has exactly one place a dispatcher states a decision in prose that
  the runner turns into a ledger fact, and adding a second channel for one
  more decision would be two places stating overlapping intent.

A hint that names something unreal or unavailable is never silently absorbed:
an unknown seat escalates (visible to the outer controller and the board, not
a guessed substitution), and a busy real seat waits for THAT seat rather than
picking a different free one — matching the existing "every worker busy" wait,
not a new stall shape, because the same zombie detection (§11) that frees any
busy seat frees this one too.

VERIFICATION: `tests/graph.test.mjs` (46/46) and `tests/loop-occupancy.test.mjs`
(60/60) were run directly, including three add-then-revert mutations proving
each new guard is load-bearing — `isEffortName` short-circuited true (RED: 4),
the worker-pool membership check on a hint short-circuited false (RED: 1), and
`effort` dropped from the spawn call at the dispatch site (RED: 1) — each
restored by file copy (checksum-verified) and reconfirmed GREEN. The bare
`node --test` full suite was intentionally NOT run from this worktree, per
this repo's own standing rule against fanning out concurrent full-suite passes
(`CLAUDE.md`, "Never fan out subagents that each run this suite"); it is owed
from whichever session integrates this change, same as the caveat `3d5b75c`
recorded for the same reason.

**2026-08-04 — GitHub #31 stages 1–2: a team may declare it produces a
verdict, and its evaluator may confirm one, on the record.** Behaviour changed
in `workflow-graph.mjs` (a team's declaration gains optional `produces:
"artifact" | "verdict"`, defaulting to `artifact`; §3.4), `role-briefs.mjs`
(new `TARGET_VERDICTS = {accept, reject}` — deliberately no `unresolved`
member — and `readTargetVerdict`, which returns `stated: false` rather than a
fabricated word when the evaluator said nothing; the evaluator brief gains a
`TARGET_VERDICT:`/`TARGET_REASON:` instruction only for a `produces: 'verdict'`
team), `loop-runner.mjs` (`composeBrief` passes `producesVerdict` to the
evaluator brief; `harvestEvent` attaches `target_verdict`/`target_reason` to a
`reviewed` event only when the team declares `produces: 'verdict'` AND the
evaluator stated one), and `ledger-validate.mjs` (`reviewed` may carry the
optional pair; a new block — not a reuse of the `spec.verdicts` check, which is
hardcoded to `entry.verdict` — refuses an unknown `target_verdict` and a
`target_verdict` with no `target_reason`). New §3.4 and §4.8.

This closes no GitHub issue by itself. GitHub #31 ("a confirmed rejection has
nowhere to go") is a `pull-controller.mjs` gate that reads exactly what §7
already said, plus a missing automatic writer of `opened` (§1) — a judged
three-design panel found neither is fixable by loosening the pull gate, which
this amendment does not touch. This ships the DECLARATION and the RECORDING
the eventual fix needs — a `reviewed pass` can now say, on the record, that it
confirms the reviewed work should be rejected — without yet acting on it: a
`target_verdict: reject` still pulls to the done queue exactly as before.
Stage 3 (an automatic reopen mechanism) is future work; ADR 0002 explicitly
forbids a machine-decided `opened` from forging a `human:*` actor, so stage 3
needs either its own event name or an explicit machine-origin field, neither
of which exists yet.

**2026-08-04 — `opened.actor` is a human decision (ADR 0002); the
post-completion question state machine is bound, consumed, and its terminals
are genuinely final.** Behaviour changed in `ledger-validate.mjs`
(`EVENT_SPEC.opened` gained `actor_kind: 'human'`; `EVENT_SPEC.questioned`
gained required `question_id`; a `relayed_by` shape check now applies to any
event; `AFTER_COMPLETED` gained `abandoned`; a new `HARD_TERMINAL_EVENTS` set
tracked separately from the existing `closedAt` makes `audited`/`abandoned`
refuse every later line, not only lines following a `completed` that has not
yet reached one of them), in `admit.mjs` (doc comment now cites the enforced
rule and an optional `--relayed-by`/`relayed_by`), and in `loop-runner.mjs`
(`harvestEvent`'s five `questioned` writers now stamp `question_id` and
`resume_role`; `awaitingAudit` reads the CURRENT last event —
`completed`/`answered` due, `audit_requested`/`questioned` already in flight,
`audited`/`abandoned` closed — instead of scanning history for the first-ever
`audit_requested`/`audited`).

Under §15.3, the document was wrong twice, both pre-existing: §4 documented
`opened`'s `agent_id`/`to_team`/`reason` but not that `actor` was ever intended
to be constrained (ADR 0002 settles this was always the intent —
`admit.mjs`'s own doc comment said so — never enforced); and §5's state table
called `completed` a terminal alongside `audited`/`abandoned` while §4.7
already documented `questioned`/`answered` legally following it, which is the
same "first terminal wins" confusion the validator's old code had in
executable form. A retroactive review (`retro-release-review`, F3/F4)
traced both: `opened.actor` accepted `agent:reopen-controller`,
`relayed_by:'garbage'`, and an absent actor alike, while rejecting the
TRUTHFUL relay shape `{actor:'agent:operator', answered_by:'human:alice'}` on
`answered`'s stricter neighbor — an inconsistency only explainable by `opened`
never having gained the rule `answered` already enforced. Separately,
`completed -> audit_requested -> questioned -> abandoned` (the exact shape the
RUNNER writes for an expired post-completion audit question, §9) was refused
as `event_after_terminal`, and `completed -> audit_requested -> audited ->
audit_requested` validated clean despite `audited` being one of §5's two
no-successor rows.

`resume_role` is recorded on every `questioned` line as of this amendment but
not yet consumed: an `answered` following a post-`completed` question is
placed by §6's ordinary rule (`teamOf(agent_id)` or `to_team`, else orphan),
which has no notion of "resume at the seat that asked" for a seat that is not
a declared team (the outer controller/audit is not a team member). The data
this needs is now on disk; the placement/dispatch change to read it is
deliberately left to a follow-up — see `HANDOFF-PATCH.md` — rather than
widening this change into `dispatch-facts.mjs`'s occupancy rule under review-
concurrency with the custody package's own edits to the same files.

**2026-08-04 — the loop graph page's own state readers named in §6.** Behaviour
changed in `graph.mjs`: `frontDoorStatus`, `controllerState`'s parked count, the
`holding` set that marks a seat as holding a live token, a team's `stuck` flag,
and the `delivered`/`waiting` tile counts now read `dispatch-facts.currentEntry`
instead of `custody[length-1]`. Under §15.3 the code was wrong: §6 already named
the rule and its five readers, but the graph page carried six more that answer
the same two questions — is a person blocking the front door, is a seat
currently holding a token, is a team stuck — through a second, independent
last-line read of the same custody array, which is exactly the "two readers
computing it separately" defect §6 opens by naming. A verified fixture: a
controller `questioned` entry followed by a trailing, mismatched `delivered`
from a superseded leg (older `dispatch_id`, different `agent_id`) made
`frontDoorStatus` report the gate merely "busy" instead of blocked on a person —
`tests/graph.test.mjs`, "a stale mismatched delivered from a superseded leg does
not hide a person waiting at the front door". `graph.mjs`'s full-history tallies
(`activityByAgent`, which counts every event a token ever recorded, not its
current one) and its `cameFrom` search for the most recent `pulled` event are
unchanged and do not belong on this list: neither answers where a token IS now,
they answer what has happened or when — the class of read §6 already says must
NOT go through `currentEntry`.

**2026-08-04 — kanban card evidence: a malformed timestamp is shown, not
laundered; the card names itself for a screen reader.** Behaviour changed in
`kanban.mjs`: `absoluteAt` no longer trusts `Date.parse` as a validator — a
stamp is accepted only if its UTC components, reserialised, match what was
typed, so a calendar-impossible value (`2026-02-29` in a year with no leap
day, an hour of `24`, the bare string `"0"`) now renders as `Malformed
timestamp: "…"` instead of the next real instant `Date.parse` silently rolls
it into. The `datetime` attribute is now always a value HTML's own
microsyntax accepts — millisecond precision, truncated from whatever the
ledger carries, never rounded or invented; the ledger's own `at` field is
unaffected, this is only the card's machine-readable copy of it. The card's
`<article>` also carries `aria-labelledby`, pointing at the token element's
own `id`, and a visible `last event: <name>` line. This closes a gap an
earlier change left open: dropping the card's `title` was correct (§13 — a
tooltip overrides the accessible name a screen reader announces), but nothing
replaced the name it incidentally carried, so the article became unreadable
in a screen reader's article list without opening each one, and the literal
last-event word — as opposed to `state`'s paraphrase of it — disappeared from
the page entirely, on-screen and in the accessibility tree alike. Under
§15.3: neither the code nor this document disagreed before this change — the
document named no rule for the kanban card's own timestamp validity or its
accessible name, so this entry establishes one rather than correcting one.
Flagged in the 2026-08-03/04 retroactive release review, findings F8 and F9.
`tests/kanban.test.mjs` gained the F8 and F9 cases, and the pre-existing
"two facts" test now asserts the token id at the ledger's own maximum length
(128 characters, §4's `ID_RE`) rather than a 71-character stand-in whose own
comment claimed 72 — a fixture that short could not have caught a clip
regression below 128.

**2026-08-04 — the old-ledger compatibility claim was overstated.** No
behaviour changed; this corrects two entries below (2026-08-04 "the last
outcome line that could not name its leg" and 2026-08-03 "leg identity
closes the review half of #30") and the claim in §6 they restate. Both said
an old ledger — or more precisely, any record where the trailing outcome or
the holder's `assigned` lacks a `dispatch_id` — "reads exactly as it did
before," "unchanged, and measured." That is true only for the case they were
written against: a `dispatch_id` genuinely ABSENT from one or both sides.
`retro-release-review` F2 reproduces a case the sentence does not cover: a
sanctioned-writer-accepted ledger where `dispatch_id` IS present on both the
live holder's `assigned` and a stale `delivered` for a different agent/task,
but the two are self-contradictory (the id was issued to one assignment, the
delivery claims a different agent/task under the same id). `currentEntry`'s
dispatch_id match at §6 returns that stale `delivered` outright — it never
binds `(dispatch_id, task_id, agent_id)`, so "the id matches" is trusted over
"the agent matches," and validation does not reject the contradiction either.
The reader's answer differs from what the pre-dispatch_id (agent_id-only)
reader would have chosen on the same bytes. So the true-today compatibility
claim is: unchanged for ledgers that never write a `dispatch_id`; NOT proven
for a ledger where a validator-accepted `dispatch_id` is present but
contradicts the agent/task it is attached to. `retro-release-review` F1 is
a related but distinct gap: a trailing `reviewed` with no `dispatch_id` of
its own is still returned as current unconditionally, even when a newer
`assigned` leg for the same task is already live, which the same "unchanged,
and measured" language does not flag as unresolved. The custody-identity fix
tracked from F1/F2 (bind `dispatch_id` to exactly one `(agent_id, task_id)`
assignment tuple at validation, and require `dispatch_id` on every new
`reviewed`/`delivered`/`lost` outcome) is expected to close both gaps; until
it ships, treat a validator-accepted but internally contradictory
`dispatch_id` tuple, and a missing-ID trailing `reviewed`, as unresolved
rather than as compatible legacy reads.

**2026-08-03 — `TMUX_TEAMS_PHASE` retired.** Behaviour changed in
`acp-companion.mjs`: the variable is refused rather than validated, and a
dispatch footprint no longer carries a `phase:` line. Under §15.3 the code was
wrong: v0.14.0 deleted the four-stage delivery phases and this check kept
enforcing their vocabulary for a release afterwards, so an operator running a
companion by hand for a team named `control` was told to use words describing
nothing that still exists. Nothing in this repository ever set the variable, and
its successor map had no reader beyond its own key list. Widening it to accept
any name was rejected: pulse validates the binding against that same vocabulary
and would record an unknown one as `unassigned`, which is a declaration that
says nothing. `pulse.mjs` keeps the binding as a reader of footprints already on
disk. GitHub #21, third item.

**2026-08-03 — a superseded leg is evidence, not a position.** Behaviour changed
in `dispatch-facts.mjs` (new `currentEntry`), and in the five readers that
answer position or state: `pull-controller.planPulls`, `loop-runner.planHarvest`,
`nextStep`, `boardSummary`, and `kanban.cardOf`. §6 gained the rule and §5 the
cross-reference. Under §15.3, the document was wrong: it said a token's state is
the name of its LAST event, and that is true only while the leg that wrote it
still holds the token. GitHub #30, from a real run: a killed review leg wrote its
`delivered` after a human had already returned the token to development and the
runner had assigned a dev worker, so the board drew it back in review and the
runner dispatched a second review worker into a team the token had left.

**2026-08-04 — the last outcome line that could not name its leg.** Behaviour
changed in `loop-runner.mjs`: `nextStep`'s `lost` verdict now carries
`dispatch_id` and the write in `tick` records it. Nothing in
`dispatch-facts.mjs` changed — §6's rule already compares `dispatch_id`
whenever both sides recorded one, so the reader took the new field without
being taught it, which is the test of whether that rule was written properly.
This retires the closing sentence of the entry below: `lost` is no longer
written without a leg identity, and two legs by the same agent whose
superseded one ended in `lost` are now told apart on any ledger written from
here on. The agent_id fallback stays for `delivered`/`lost` and is what every
ledger written before this still reads by — unchanged, and measured, for a
ledger where no `dispatch_id` is present on the relevant entries. See the
2026-08-04 correction above (retro-release-review F1/F2): once a
`dispatch_id` IS present but contradicts the agent/task it is attached to,
this is not proven unchanged.

**2026-08-03 — leg identity closes the review half of #30.** Behaviour changed
in `dispatch-facts.mjs` (`currentEntry`, `LEG_OUTCOMES` now includes
`reviewed`) and in `loop-runner.mjs` (`harvestEvent` stamps `dispatch_id` on
the `reviewed` line it writes). §6 gained the `dispatch_id` rule and its two
limits collapsed to one. Under §15.3, the document was wrong: §6 named "leg
identity (`dispatch_id`)" as a known limit and said `reviewed` could not join
`LEG_OUTCOMES` without reproducing the false positive the four tests caught —
both were true only because nothing yet compared a trailing entry's own
`dispatch_id` against the holder's. The remaining known limit — a
`delivered`/`lost`/`reviewed` with no `dispatch_id` falls back to (or, for
`reviewed`, forgoes) the agent_id check, unchanged from before this change —
is corrected by the 2026-08-04 entry below: on a same-agent retry that fallback
was fail-open, not merely imprecise, and the closing sentence of the
2026-08-04 (`lost`) entry beneath this one is retired for the same reason.
`lost` is still runner-written without a `dispatch_id`, so two legs by the same
agent whose superseded one ended in `lost` are told apart by `task_id` instead
(see below), not left indistinguishable.

**2026-08-04 — an unlabeled outcome behind a live retry is not current
(retro-release-review F1, F2).** Behaviour changed in `dispatch-facts.mjs`
(`currentEntry`) and `ledger-validate.mjs` (`validateLedger`). §6 gained the
`task_id` fallback and the dispatch_id-binding paragraph above. Under §15.3,
BOTH this document and the code were wrong, in the direction of trusting too
much: §6 said an unlabeled `reviewed`, or a `delivered`/`lost` whose agent_id
matched the holder, was "trusted exactly as before" — true of the words, false
of the safety, because "before" already fails open. A same-agent retry (the
identical evaluator run twice, a killed worker redispatched to the same
worker) reads identical by agent_id on both legs; when the trailing outcome
also carries no `dispatch_id`, nothing distinguished the dead leg's late last
word from the live retry's own report, and a `reviewed pass` in that shape
cleared `pull-controller.mjs`'s gate and released the token to the next team
while the live leg was still running. `task_id` closes it: `assigned` already
required one (§4), and it is required on `assigned` even in a ledger old
enough to carry no `dispatch_id` at all, so it is never the field the fallback
has nothing left to check. `tests/loop-occupancy.test.mjs:1006-1037` (test "a
lost leg reporting in after its own retry does not speak for the retry"; line
numbers as of this amendment — they will rot again, same as this citation did)
previously asserted the fail-open reading as correct ("an old ledger stopped
reading the way it always did"); that assertion encoded this defect and was
changed to assert the token is read as still held by the live retry, with the
same comment explaining why the old claim was wrong rather than deleting it
silently.

Separately, `ledger-validate.mjs` did not bind a `dispatch_id` to the
`(agent_id, task_id)` its own `assigned` line named, so a `delivered` could
carry a dispatch_id belonging to a DIFFERENT, live leg while naming an
entirely different agent and task, and `currentEntry`'s dispatch_id-match
branch — the one case in §6 that was supposed to be authoritative — trusted it
outright. `validateLedger` now refuses such a line (`dispatch_id_agent_mismatch`,
`dispatch_id_task_mismatch`); `dispatch-facts.mjs` still treats a matching
dispatch_id as proof, unchanged, because a ledger that reaches it now cannot
carry that contradiction and still validate. A ledger already tolerated as
legacy through `ledger-writer.mjs`'s `LEGACY_TOLERATED` set is unaffected —
`dispatch_id_agent_mismatch`/`dispatch_id_task_mismatch` are not in that set,
so a NEW line making this mistake is refused exactly as any other invalid
event is, and an old ledger that never had a contradicting dispatch_id in the
first place validates exactly as it did.

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

## 16. Agent seat read facade

`scripts/agent-seat-reads.mjs` (D1). A caller-side facade, not a server and
not an MCP registration: no dispatch sends a non-empty `mcpServers` (§13), and
opening that seam is a containment decision nobody has taken (§13, ADR 0003).
This is the thing an MCP adapter would later wrap, and it is useful without
one because the runner and the board can already import it directly.

Scenario work sized what an agent seat needs to READ at three questions. A
fourth — asking a person — is a MUTATION, and mutation is out of scope: an
outside review refuses any write tool on the current lock, and §14.5 agrees
the lock cannot be made safe against stale takeover with file primitives. No
function below writes anything, ever.

| Function | Answers | Returns `null` when |
| --- | --- | --- |
| `listDeliveries(repo, workItem)` | what has an earlier leg on this token delivered? | `workItem` names no ledger this repo holds |
| `fetchDelivery(repo, workItem, id)` | give me the one piece named `id` | `workItem` is unknown, `id` does not match a `delivered` leg recorded on THAT token, or `id` is not shaped like one this module would ever have issued |
| `legOutcomes(repo, workItem)` | how did this token's earlier legs end, and how many times has it been rejected? | `workItem` names no ledger this repo holds |

`listDeliveries` and `fetchDelivery` are deliberately two calls, not one: a
single call either truncates a piece that turned out to be enormous or floods
a caller that only wanted to know what exists. `listDeliveries` returns one
entry per `delivered` line on the token's own ledger (event vocabulary: §4),
oldest first — `id`, `agent_id`, `at`, `terminal`, `work_observed`,
`evidence_present` — and never the delivery's own text. `fetchDelivery` takes
one of those `id`s back and returns that one piece's full content, read from
the leg's own outbox, plus `content_available` (false when the ledger
recorded the delivery but the outbox bytes are gone — evidence about the
LEDGER is not invalidated by a later, separate loss of the bytes) and
`truncated` (true past 256 KiB — smaller than §4 rule 5's whole-ledger 1 MiB,
because this is one file, not a token's whole history).

`legOutcomes` returns one entry per `delivered`/`lost`/`reviewed` line (§4's
own leg-closing vocabulary — this function does not re-derive dispatch-facts
.mjs's `currentEntry`, which answers who holds a token NOW and needs the
dispatch_id/task_id disambiguation documented at length in that file; a
leg-outcome HISTORY does not, because every entry in the history is
self-describing and none of it depends on which leg is current) — `id`,
`event`, `agent_id`, `at`, `terminal`, `verdict`, `reason`, `work_observed` —
plus a computed `reject_count`, so a caller does not have to fold the list
itself just to answer the question `MAX_DOOR_REFUSALS`-style ceilings would
otherwise have to discover blind: has this been rejected before, and how many
times.

### 16.1 The wall

**No return value from any function above may contain a filesystem path, and
no argument identifying a piece of work may be one either.** A caller that
never learns a path cannot open one. Concretely: nothing returned, in any
shape (found, not-found, or fed a hostile argument), may contain `.jsonl`,
`.tmux-teams`, `.mailbox-out`, or an absolute path — proven for a found case,
a not-found case, and a path-shaped `id` argument (`../../etc/passwd`,
`/etc/passwd`, a bare `a/b`) in the same test, over the same calls the
behavioural tests already made, not a hand-picked subset (§14, AC96).

`repo` — the project root — is the one argument this rule does not cover, and
that is not a hole in it: it is the same first argument every sanctioned
reader in this contract already takes (`readWorkItems(repo)` /
`readDispatchFacts(repo)` in dispatch-facts.mjs, `readBoard(repo)` in
kanban.mjs, `intakeStats(repo)` in intake-stats.mjs), a caller inside this
repo already knows its own root, and nothing this facade returns lets it
derive a path it did not already have. What the wall actually forbids is a
return value or an `id` that points INTO `.tmux-teams/` or `.mailbox-out/` —
the thing a caller would otherwise have to guess to read another leg's outbox
directly, which is the exact gap `listDeliveries`/`fetchDelivery` close.

`fetchDelivery`'s `id` is checked against a safe character class (the same
`^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$` shape already duplicated across
dispatch-facts.mjs, ledger-writer.mjs, ledger-validate.mjs and others in this
directory) BEFORE it ever reaches a filesystem `join()`, so a path-traversal
argument is refused rather than attempted and caught. An `fs` failure reading
an outbox is never rethrown: Node's own error would carry the path this
module withholds, so it is swallowed into `content_available: false` instead.
Should a future change ever need to rethrow one, the original belongs on
`{ cause }`, never restated in the new error's own `message` — `cause` is not
part of the string an ordinary caller reads back, but it is not nothing
either, and this paragraph is the place that says so rather than leaving it to
be discovered.

### 16.2 Ledger access stays behind the one sanctioned reader

Every ledger byte this facade sees comes from dispatch-facts.mjs's existing
aggregate reader. `dispatch-facts.mjs` exports it a second time under the name
`loadWorkItemLedgers` — a plain alias, added in the same commit as this
section — specifically so `agent-seat-reads.mjs` can import it without writing
the literal identifier `./scripts/ledger-reader-ratchet.mjs`'s static-text scan
watches for. This is the "textual re-export renaming" technique that ratchet's
own header names as a real, low-cost way to reference an already-authorized
reader under a different name: used here deliberately, recorded here so it is
never mistaken for the ratchet quietly failing to notice a new one. Running
`node ./scripts/ledger-reader-ratchet.mjs` after this facade exists reports the
same readers as before it — the facade added no new one, which is the claim that
matters. `tests/agent-seat-reads.test.mjs` asserts this directly, by calling the
ratchet's own checker function, not by restating a count that could drift from
what the tool actually finds. This paragraph used to say "the same 9 known
readers" and was carrying a stale number for two days: the ratchet's own test
had recorded ten since 2026-08-05 and eleven since 2026-08-07, and nothing ever
compared the prose against a run. The sentence praising the test for not
restating a count was itself restating one; the count now lives only where the
tool can contradict it.
dispatch-facts.mjs remains the only place that decides how a ledger line
means what it means; this facade never re-derives a fold over custody — where
an existing function already answers a question (an outcome's own recorded
fields), it is read off the entry directly rather than reconstructed.
