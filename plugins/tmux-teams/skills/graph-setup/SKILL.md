---
name: graph-setup
description: 'Use as the mandatory first-run setup for the delivery loop, right after installing this plugin, and whenever the declaration is missing, incomplete or rejected — an interactive wizard that asks until this repo has declared which Teams exist, how many workers each has, which model every seat runs on, and which workflows route over them, then writes and validates graph.json. Triggers: "setup loop", "set up the team graph", "ตั้งค่าลูป", "สร้างกราฟทีม", "graph.json", the graph page reporting the declaration could not be read, a fresh install that has never declared a loop.'
---

# graph-setup — interview until this repo has declared its own loop

This skill produces exactly one file: `<repo>/.tmux-teams/graph.json`. It is
the **declaration** layer — teams, seats, models and routes are assigned by a
human and never observed. Everything else the loop shows (who ran, what they
produced, how long it took) is evidence, and evidence can only bind to seats
that were declared here first.

It runs as a **wizard, not a form**. Ask one question at a time through the
runtime's question tool and keep asking until nothing is blank. A declaration
that is half filled in is not a smaller version of a declaration; it is a repo
that dispatches agents its owner never chose.

## If this is skipped, nothing dispatches

A missing declaration is **not** a default. The bundled template still loads —
the pages need something to draw while they explain what is missing — but the
runner refuses to dispatch against it, and says so rather than idling silently.

*This paragraph has a history worth keeping. It claimed exactly this from the
day it was written and it was FALSE for that whole time: `readWorkflowGraph`
fell back to the template, the runner dispatched against four teams the user
never declared, every seat asking for the placeholder model
`inherit-account-default`, and the failures arrived one at a time at the
adapter. The v0.15.0 documentation review caught the lie, the documentation was
corrected to describe the defect (GitHub #48), and then the defect was fixed —
so the sentence is true now for the first time. `tmux-teams/SKILL.md` described
the old behaviour correctly throughout; the two documents disagreed, and the
one making the safety promise was the wrong one.*

The runner states that refusal in `<repo>/.tmux-teams/runner-heartbeat.json`:

```json
{ "schema": "tmux-teams.runner-heartbeat", "at": "<ISO 8601 UTC>", "tick_sec": 30,
  "dispatching": false, "reason": "<why it is holding>", "started": 0, "held": null }
```

`"held": null`, not `0`. A panel lane checked this example against
`loop-runner.mjs` and found the refusal paths pass `held: null` — the runner did
not COUNT zero held items, it never got far enough to count at all, and `0` is a
measurement while `null` is the absence of one. On a page whose whole subject is
the difference between absent, stale and refusing, an example that turns "not
measured" into "measured zero" teaches the opposite of what the section is for.

Read it the way every other reader must:

- **file absent** — the runner has never run in this repo
- **`at` older than 3 × `tick_sec`** — the runner is not responding
- **`dispatching: false`** — the runner is deliberately holding, and `reason`
  says what would have to change

Tell the user this before the first question, in one sentence. It is the reason
the interview cannot be postponed, and it is fairer than letting them discover
an idle board later.

## How to ask

1. **One question per call.** Pass exactly one element in the `questions` array
   of `AskUserQuestion` (Claude Code's question tool; use the equivalent in any
   other runtime). The tool accepts up to four and batching is the default
   instinct — do not. A list of four questions gets one skimmed answer.
2. **Lead with a recommendation and say why.** The first option is what you
   recommend; its description is the reason, not a restatement of the label.
   People accept a recommendation they understand and correct one they don't.
3. **Always leave room for their own answer.** Every question the user can
   answer in free text must be answerable in free text. Options are shortcuts,
   never the whole world.
4. **Never fill a blank yourself.** If an answer is missing, ask again. Not one
   field in the shape below has a value you are entitled to choose on the user's
   behalf.
5. **Never use multi-select for a route.** A route is ordered; a checkbox list
   is not.
6. **If the interview is abandoned, write nothing.** Say plainly that no
   declaration was written and that nothing will dispatch until it is. A partial
   file is worse than no file: it validates or fails on fields nobody chose.

## Step 0 — read what is already there before asking anything

```bash
cat <repo>/.tmux-teams/graph.json 2>/dev/null
node <plugin>/skills/tmux-teams/scripts/graph.mjs check <repo>
```

Three cases, and they are handled differently:

| What you find | What you do |
| --- | --- |
| no file | full interview, every question below |
| a file the checker rejects | interview **only for what is missing or invalid**, and repeat the checker's reason to the user as the reason for asking |
| a file the checker accepts, and `ok (graph.json)` | do not overwrite it. Report what it declares and ask whether anything should change |

The second case is the common one on an upgraded install: a graph written before
models were required, or one still carrying `wip_limit`. Re-asking for a team's
id and name when the file already states them is how a mandatory wizard becomes
a step people route around. Complete the incomplete part.

A bundled template — including anything an `init` command writes — is a shape to
read, never an answer. Copying it is the exact silent default this wizard
exists to remove.

## The interview

Ask in this order. Each numbered item is one question.

**The graph itself**

1. `project_id` — recommend the repo's directory name, normalised to
   `^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$`. Reason: it labels this graph in the
   page title and in every log line, so it should be recognisable at a glance.
2. `outer_controller_id` — recommend `pm_<project_id>`. Reason: exactly one
   agent takes deadlocks and reads every finished route as a whole; it belongs
   to no team and does no team's work, so it needs its own id.
3. `outer_controller_model` — see **Asking for a model** below. This seat is a
   position like any other and may not be left blank.
4. **How many teams.** This answer is what tells you when the per-team loop
   below is finished, so ask it before you ask anything about a team. Recommend
   the number of distinct stages the user's own description implies, and 1 when
   it implies nothing. Reason: a team is a reusable pool that any workflow can
   route through, so a team is worth declaring only if some route will use it —
   one declared now and routed nowhere is dead weight.

**For each of those teams, in turn** (do not start team 2 before team 1 is
complete, and stop at the count answered in 4)

5. `team_id` — recommend a short role word (`build`, `review`). Reason: agent
   ids are derived from it and routes name it, so a name that survives a
   reorganisation is worth the ten seconds.
6. `name` — recommend the title-cased id. Reason: this is the label a human
   reads on the page; the id is what the machine matches.
7. **How many workers this team has.** Put the consequence in the question text
   itself, not in a footnote: *this number is the team's WIP limit — the most
   work items it can hold at once. It is now the only place that limit comes
   from, so raising it later means adding a worker.* Recommend the number the
   user's own description implies, and 1 when it implies nothing. Reason: a
   worker may spawn its own sub-agents, so parallelism inside one worker is
   still available without widening the pool.
8. `models.dispatcher` — recommend a model this repo can point at: one already
   declared in an earlier answer or in the existing file. When the repo offers
   no candidate, ship the question with the user's own options and **no**
   recommended default, and say why: a model name recalled from memory is shape-
   valid, so it passes the checker and fails only at dispatch time.
9. `models.worker` — recommend the model just chosen for the dispatcher, and say
   so plainly ("same as the dispatcher").
10. `models.evaluator` — recommend a different, stronger model where one is
    available. Reason: an evaluator running the same model that produced the work
    agrees with itself more often than it should.

**The workflows**

11. How many workflows. Recommend 1. Reason: a workflow is a route composed from
    teams that already exist, so a second one costs nothing later and an unused
    one is noise now.

**For each workflow, in turn** — three questions, not one item with three parts

12. `workflow_id`.
13. `name` — recommend a phrase describing the delivery, not the teams. Reason:
    the route already lists the teams.
14. `route` — recommend all declared teams in declaration order, and offer free
    text for a different ordering. Reason: a route may not visit the same team
    twice — work comes back by rejection, never by routing backwards.

**Before writing**

15. Show the complete JSON you are about to write, including the agent ids you
    derived (`<team_id>_dispatcher`, `<team_id>_worker_1..n`,
    `<team_id>_evaluator`), and ask to write it or amend one thing. Derived ids
    are only derived until this question; after it they are chosen.

### Asking for a model

Every seat names its model and none may be blank. The value is **never**
validated against a list of known models — only its shape (a non-empty string,
at most 128 characters, no control characters). That has two consequences worth
stating to the user:

- A model name you invented from memory passes the checker and fails at dispatch
  time, far away from here. Offer only names you can point at: ones already
  declared in this repo, ones the user names, or ones from the adapter they use.
- A placeholder such as `inherit-account-default` is shape-valid and
  meaning-empty. Treat one as a blank and ask again. It is a template's way of
  saying "nobody has chosen yet".

## Writing the file

Create `<repo>/.tmux-teams/` if it does not exist, then write exactly this
shape:

```json
{
  "project_id": "acme_api",
  "outer_controller_id": "pm_acme_api",
  "outer_controller_model": "<model>",
  "teams": [
    {
      "team_id": "control",
      "name": "Control",
      "dispatcher_id": "pm_intake",
      "worker_ids": ["pm_acme_api"],
      "evaluator_id": "pm_audit",
      "models": { "dispatcher": "<model>", "worker": "<model>", "evaluator": "<model>" }
    },
    {
      "team_id": "build",
      "name": "Build",
      "dispatcher_id": "build_dispatcher",
      "worker_ids": ["build_worker_1", "build_worker_2"],
      "evaluator_id": "build_evaluator",
      "models": { "dispatcher": "<model>", "worker": "<model>", "evaluator": "<model>" }
    }
  ],
  "workflows": [
    { "workflow_id": "default", "name": "Default delivery", "route": ["control", "build"] }
  ]
}
```

**The control team is not optional and not decoration.** Its ONE worker is the
seat `outer_controller_id` names — the same seat, written twice — and the
loader refuses a graph without it (`the outer controller ... is a worker on no
team`). That refusal exists because a controller belonging to no team places
nowhere: everything it writes — an escalation, a question at the front door —
would count against no team's WIP and stop nothing, which is the whole
mechanism this system runs on. One worker means WIP 1, so the front door holds
exactly one request at a time and shuts while a person owes an answer.

Every route starts at `control` for the same reason: work enters through the
front door or it does not enter.

This example declared no control team until 2026-08-08 and would now be
refused at load — an outside reviewer caught it in the release that made the
team mandatory, before any operator ran the wizard into a wall.

### Optional: per-seat overrides and a model palette

`models` sets one model per ROLE. A `seats` block overrides ONE named seat, and
it is the only place a model palette can be declared — a feature that shipped
in v0.15.0 and that this interview does not ask about, so only add it when the
user's own answers call for it.

```json
"seats": {
  "build_worker_1": { "model": "<model>", "adapter": "claude | codex | agy",
                      "effort": "<effort>", "display_model": "<real model name>" },
  "build_worker_2": { "palette": [
    { "model": "<model>", "adapter": "claude", "bucket": "vendor-a" },
    { "model": "<model>", "adapter": "codex",  "bucket": "vendor-b" }
  ] }
}
```

Ask for a palette only if the user describes a seat that should keep working
when its first model is **rate-limited or refuses** — that is the whole
purpose. Then collect an ordered list of 1–8 candidates, and obey three rules
the validator enforces at load:

- **`palette` REPLACES that seat's `model`/`adapter`/`effort`/`display_model`.**
  It never sits beside them; a seat declaring both is refused.
- **Each entry is a whole seat spec**, not a model name. A model means nothing
  without its lane — the same alias reaches a different vendor on a different
  adapter — so `model` is required on every entry.
- **Two CONSECUTIVE entries may not share a `bucket`.** A bucket names the
  rate-limit family (it defaults to the entry's lane). Two neighbours in one
  bucket are not a fallback: they draw on the same limit, so trying the second
  right after the first spends an attempt to learn nothing. `A, B, A` is fine.

A palette does **not** cost extra worker seats — `wip_limit` counts
`worker_ids`, never candidates. An eight-entry palette on a one-worker team is
still WIP 1.

`AGENT_ID` = `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$` ·
`GRAPH_ID` = `^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$` · `name` = 1–160 characters,
no control characters. Bounds: 1–100 teams, **1–5 workers per team**, 1–50
workflows, 1–8 entries per declared palette. Five is a hard refusal, not
advice — never recommend a sixth worker seat, however many parallel reviewers
the user describes; give the team fewer seats and let the route carry the rest. Every `agent_id` is unique across the whole graph, the outer
controller included — one agent, one seat, or a single dispatch lights two nodes.

**Never write these:**

- `wip_limit` — it is no longer a declared input; it always equals
  `worker_ids.length`. A declared number that disagrees is rejected outright.
- `downstream_team_id` — routing lives in a workflow route, never on a team.
- a `null` `project_id` or `outer_controller_id` — both validate as null and
  both would silently delete a seat the user was supposed to fill.
- a placeholder model, or any value the user did not state.

## Validating — and what counts as success

```bash
node <plugin>/skills/tmux-teams/scripts/graph.mjs check <repo>
```

Success is **all four** of these, not just the exit code:

1. it exits 0
2. the ok line names the file — `ok (graph.json)`. `ok (default)` means
   your write did not land where the reader looks (wrong repo root, or
   `.tmux-teams/` missing) and the checker read a bundled shape instead
3. the printed team and workflow counts match the answers you just collected
4. no field is null, and no model is a placeholder

If the checker rejects the file, **do not report success and do not repair the
answer yourself**. The reason it prints names one field. Take that reason back
to the user as the next single question, rewrite, and check again. Inventing a
value that satisfies a validator is how a declaration stops describing what its
owner wanted.

Two things the checker will not catch, so check them yourself before declaring
done:

- a declared team that appears in no workflow route — valid, and dead weight
- a team whose worker count was accepted without the user seeing that it is the
  WIP limit

## The one rule that decides whether the page shows anything

Nodes bind to evidence by **`agent_id`** and nothing else. A dispatch appears on
the graph only when it was launched with `ACP_AGENT_ID` set to an id declared in
this file:

```bash
ACP_AGENT_ID=build_worker_1 node <plugin>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  claude <repo> <task-id> <brief-file> <stall-sec>
```

Dispatch without it and the work is real, runs fine, and is invisible here — it
lands in the "agents running outside this graph" count instead. Say this out
loud when the wizard finishes; it is the single mistake that makes the page look
broken when it is telling the truth.

## Reading the result

Publish and open it — that is part of the job, not a formality:

```bash
node <plugin>/skills/tmux-teams/scripts/pulse.mjs once <repo>
# then open <repo>/.tmux-teams/graph.html
```

- **Dashed border** — declared, never dispatched
- **Solid edge** — a record exists for it · **dashed edge** — the operating
  model, nothing measured yet
- A handoff edge hardens once a `pass` verdict is recorded for that team's
  evaluator; a rework edge hardens once a `reject` is. Both stay dashed until
  then, and that is the page working correctly
- A node reporting `unverified` for its model has not yet run under a dispatch
  that stated one. The **declared** model is what you collected here; the model
  a node reports is evidence, and they are two different facts

## Changing the loop later

Run this skill again. It reads the existing file first and interviews only for
what changed or is missing, so adding a worker is one question, not the whole
wizard. Re-run `check`, re-publish.

Adding a worker raises that team's WIP limit by one, because the limit is the
worker count and nothing else. Renaming an agent detaches its recorded history,
which keeps binding to the old id — which is why role-shaped ids earn their
keep.
