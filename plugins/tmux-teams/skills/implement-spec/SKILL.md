---
name: implement-spec
description: "Implement a whole spec autonomously: read its tickets as a dependency graph, research the codebase once in a subagent, run every unblocked ticket in parallel implementer subagents each in its own worktree, merge them as they land, review the result against the spec, and clean up. Use when there is a spec with tickets and the user wants the work done with minimal supervision — 'implement the spec', 'work the tickets', 'ทำตาม spec', 'ลุยทั้ง spec'. Runs pm-delegation for every dispatch. Do not use for a single edit, for work with no written spec, or when the user wants to review each step."
---

# Implement a spec

Take a spec and its tickets and produce a branch that implements all of it,
running as much in parallel as the dependencies allow.

**This is not the delivery loop.** `tmux-teams` routes a work item token through
teams over ACP, with a custody ledger, WIP limits and brakes, and its
`Workflow` is a route that never revisits a team. This skill is a different
mechanism for a different job: tickets are a **dependency graph**, not a route,
and the workers are the host's own subagents, not ACP lanes. Nothing here writes
to the custody ledger and nothing here consults it. Two models, named apart on
purpose — if you find yourself wanting WIP limits here, you want the loop.

Every dispatch runs under **`pm-delegation`**. Read it; the brief rules and the
STOP contract below are its, not repeated here.

## What you need before starting

- **A spec**: what is being built and what makes it done.
- **Tickets**: bounded units with their dependencies stated. If they are a flat
  list with no dependencies, that is a graph too — one where everything is
  unblocked and everything runs at once.

If either is missing, stop and say so. Inventing the spec and then implementing
it is one agent agreeing with itself.

## The frontier

The tickets are a graph. At any moment the **frontier** is every ticket whose
dependencies are all complete. That is what you dispatch — not a list in order.

Recompute the frontier every time a ticket lands. A ticket completing usually
unblocks others, and dispatching those immediately is the whole reason to model
dependencies rather than walk a list.

**If the frontier is empty and tickets remain, the graph has a cycle or a
dependency on something that failed.** Say which, and stop. A frontier that
empties with work left is not a slow moment to wait through.

## Steps

1. **Read the spec and every ticket.** Build the graph. State it back — ticket
   ids and what blocks what — before dispatching anything. A graph nobody
   checked is a plan nobody agreed to.

2. **Research once, in one subagent.** Send a read-only agent to answer what the
   tickets need to know about the codebase: where things live, what the existing
   patterns are, what will fight the change. **It writes its notes to a file
   outside the repository**, and every implementer is given that path.

   One research pass, not one per ticket. Six implementers each rediscovering
   the same layout is six times the cost for one answer, and they will not all
   reach the same one.

3. **Branch, and open a draft pull request.** The PR exists from the start so
   the work has somewhere to accumulate and a reader can watch it.

4. **Dispatch the frontier — one implementer per ticket, each in its own
   worktree.** The worktree is not optional. Agents editing one checkout race on
   `git checkout -b`, land commits on each other's branches, and reset branches
   that are still checked out somewhere else. That has happened here and nothing
   was lost by luck rather than care.

   Tell each implementer: the primary checkout is off limits, its file radius,
   the research notes path, and the acceptance for its ticket.

5. **Merge each result as it lands, one at a time.** Do not batch. Merging one
   finished ticket while others still run is the point of the parallelism; a
   barrier at the end throws it away.

   **Merge conflicts are yours, not the implementer's.** It no longer has the
   context and re-dispatching it to resolve one costs more than resolving it.

6. **Recompute the frontier and dispatch what just became unblocked.** Repeat
   from 4 until every ticket is complete.

7. **Review the whole result against the SPEC, not against the tickets.**
   Tickets can each be satisfied while the spec is not — that is what a spec is
   for. Ask what it asked for and whether the branch does it.

   Use a review that can execute, not only read. `codex-advisor` is the read of
   record here; `/code-review` covers the diff.

8. **Fix review findings in ONE implementer**, not one per finding. They overlap
   and the sequencing is cheaper inside one agent than across several.

9. **Clean up every worktree.** Then mark the PR ready.

## Communicate with pointers, not copies

Send implementers **paths**: to the spec, to the ticket, to the research notes,
to the commits already merged. Do not paste the content.

A pasted copy is a snapshot from the moment the brief was written. Two tickets
into the run it is describing a tree that no longer exists, and the implementer
believes it because it arrived in the instructions.

## What to run, and what to leave to the caller

An implementer runs **the focused test for its own ticket** and reports the
count. It does not run the whole suite: one pass forks dozens of subprocesses,
and several at once measure the contention rather than the code — measured
here, fifteen concurrent passes took a load average to 28 on 8 cores and after
42 minutes not one agent had finished.

**You run the full suite once**, after the last merge, before the review. That
number is the one that means anything.

## Where this stops on its own

- **A ticket comes back STOPped.** Read `pm-delegation`: the answer is a
  decision, not the same brief again. If the decision is the user's, ask.
- **The frontier is empty with tickets left.** Cycle or failed dependency. Say
  which.
- **The same ticket fails twice.** The second failure is information about the
  ticket, not about the implementer. Re-read it before spending a third.
- **A merge conflict you cannot resolve from the spec.** Two tickets disagree
  about the same lines and the spec does not say which wins. That is a spec
  question.

## What this skill will not do

- Push, tag, or release. It leaves a draft PR.
- Widen its own scope from a ticket into "while I was in there".
- Report a suite it did not run.
