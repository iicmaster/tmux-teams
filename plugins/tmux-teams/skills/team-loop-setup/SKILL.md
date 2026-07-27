---
name: team-loop-setup
description: 'Use when setting up or changing the delivery loop a repo runs — declaring which Teams exist, who dispatches, who works, who reviews, and how work hands off between them, so the bundled Team delivery flow page reflects real work. Triggers: "setup loop", "set up the team graph", "ตั้งค่าลูป", "สร้างกราฟทีม", "team-graph.json", a graph page showing every node unbound.'
---

# team-loop-setup — declare the delivery loop this repo runs

The Team delivery flow page (`.tmux-teams/graph-loop.html`, published by
`pulse.mjs`) draws **declared topology** coloured by **observed evidence**. It
never guesses. Until this repo declares a loop, the page shows the bundled
four-team template with every node unbound — correct, and useless.

This skill produces one file: `<repo>/.tmux-teams/team-graph.json`.

## The one rule that decides whether the page works

Nodes bind to evidence by **`agent_id`** and nothing else. A dispatch appears on
the graph only when it was launched with `ACP_AGENT_ID` set to an id declared in
the graph:

```bash
ACP_AGENT_ID=build_worker_1 node <plugin>/skills/tmux-teams/scripts/acp-companion.mjs \
  claude <repo> <task-id> <brief-file> <stall-sec>
```

Dispatch without `ACP_AGENT_ID` and the work is real, runs fine, and is invisible
on this page — it lands in the "agents running outside this graph" count instead.
Say this out loud to the user; it is the single mistake that makes the page look
broken when it is telling the truth.

## Steps

1. **Start from the template or from scratch.**

   ```bash
   node <plugin>/skills/tmux-teams/scripts/graph-loop.mjs init <repo>
   ```

   writes the four-team template (Requirement → Prototype → Development → QA)
   for editing. It refuses to overwrite an existing file. Skip it if the user
   wants a shape of their own.

2. **Interview for the real shape.** Ask only what changes the file:
   - What stages does work actually pass through here, in order?
   - For each stage: who owns the queue (dispatcher), who does the work
     (workers, one or more), who accepts or rejects it (evaluator)?
   - Who takes exceptions and deadlocks — the outer controller / PM?

   Name agents after the role they play in the loop, not after a model or a
   person. `build_worker_1` survives a model swap; `opus_worker` does not.

3. **Write the file.** Shape:

   ```json
   {
     "project_id": "your_project",
     "outer_controller_id": "pm_main",
     "teams": [
       {
         "team_id": "build",
         "name": "Build",
         "dispatcher_id": "build_dispatcher",
         "worker_ids": ["build_worker_1", "build_worker_2"],
         "evaluator_id": "build_evaluator",
         "downstream_team_id": "verify"
       },
       {
         "team_id": "verify",
         "name": "Verify",
         "dispatcher_id": "verify_dispatcher",
         "worker_ids": ["verify_worker_1"],
         "evaluator_id": "verify_evaluator",
         "downstream_team_id": null
       }
     ]
   }
   ```

   Contract rules the validator enforces — a violation fails the page closed
   with the reason printed, it does not silently fall back:
   - 1–100 teams; each team needs a dispatcher, **at least one** worker, and an
     evaluator
   - every `agent_id` is unique across the whole graph, including the outer
     controller
   - `downstream_team_id: null` marks the sink and there must be **exactly one**;
     every team's chain must reach it, and no cycles
   - the final destination (Project Delivery) is drawn by the page as a terminal
     node — **do not declare it as a team**

4. **Check before dispatching anything.**

   ```bash
   node <plugin>/skills/tmux-teams/scripts/graph-loop.mjs check <repo>
   ```

   Prints the team/agent count and the exact `ACP_AGENT_ID` values to dispatch
   with, or exits non-zero with the contract violation.

5. **Publish and look at it.**

   ```bash
   node <plugin>/skills/tmux-teams/scripts/pulse.mjs once <repo>
   # then open <repo>/.tmux-teams/graph-loop.html
   ```

   Opening it is part of the job, not a formality. A page whose nodes are all
   dashed after a real dispatch means `ACP_AGENT_ID` did not match the graph.

## Reading the result

- **Dashed border** — declared, never dispatched
- **Green** — working now · **amber** — delivered, awaiting review · **red** —
  process not found
- **Solid edge** — a record exists for it · **dashed edge** — the operating
  model, nothing measured yet
- A **solid handoff** appears once a `pass` verdict is recorded for that team's
  evaluator; a **solid rework** edge appears once a `reject` is. Both stay
  dashed until then, and that is the page working correctly.

## Changing the loop later

Edit the file, re-run `check`, re-publish. The graph is a declaration, so
renaming a team or adding a worker takes effect on the next publish. Existing
evidence keeps binding by `agent_id` — rename an agent and its history stops
matching, which is why role-shaped ids are worth the thirty seconds.
