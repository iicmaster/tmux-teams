---
name: pm-delegation
description: "Act as PM over other agents — subagents or ACP lanes — from one delegation to a whole spec. Covers the brief contract, the STOP rule, what counts as evidence, and the autonomous run: tickets as a dependency graph, one research pass, parallel implementers each in its own worktree, merged as they land, reviewed against the spec, worktrees cleaned up. Use when dispatching work to subagents or ACP, writing a brief, judging a returned result, or implementing a whole spec with minimal supervision — 'implement the spec', 'work the tickets', 'ทำตาม spec', 'ลุยทั้ง spec'. ใช้เมื่อรับบทเป็น PM คุมงานเอเจนต์อื่น. Do not use for a single edit you can make yourself, and never to route work through the delivery loop — that is tmux-teams."
---

# PM over other agents

You are holding work and other agents will do pieces of it. This covers one
delegation and a whole spec, because the contract is the same either way and
only the number of agents changes.

**Workers are host subagents or ACP lanes.** A subagent in its own worktree is
the cheap default; an ACP lane through `acp-dispatch.mjs` is for a different
model or a longer job. The contract does not care which.

**This does NOT feed the delivery loop.** `tmux-teams` routes a work item token
through teams over ACP with a custody ledger, WIP limits and brakes, and its
`Workflow` is a route that never revisits a team — a linear shape. Tickets here
are a **dependency graph**. Nothing in this skill writes to the custody ledger
or reads it. Two models, named apart on purpose: if you want WIP limits and
escalation, you want the loop, not this.

---

# Part one — one delegation

## The brief

A brief that does not carry all five of these is not ready to send.

1. **One bounded outcome.** Not a theme. "Add the layout test" is a brief;
   "improve the plugin structure" is a wish. If you cannot say what would make
   it done, the ticket is not ready and splitting it is the work.
2. **The acceptance, in the form it will be checked.** Name the command and the
   observable result — the focused test file for this ticket, and the count it
   must reach. An implementer who does not know how the work is judged will
   optimise for looking finished.
3. **Where the facts are.** Point at files, prior commits, an ADR — a **pointer,
   not a copy**. Copied context goes stale between the brief being written and
   read, and a stale copy is more dangerous than an absent one because it looks
   authoritative.
4. **The blast radius.** Which files this delegation may touch, stated as a list.
   Everything else is off limits and saying so is not an insult — two agents
   editing one file is how a wave loses work.
5. **What to do when blocked.** Every brief names the STOP condition. See below.

## What an implementer may not do

- **Not touch a file outside its stated radius.** Including "just to check".
- **Not run the full suite** when a caller is serialising measurement. One pass
  spawns dozens of subprocesses; several at once measure the contention rather
  than the code. Run the focused file; let the caller run the whole thing once.
- **Not `git checkout` to undo an experiment.** It restores the committed
  version and eats uncommitted work. Copy the file aside first, restore from the
  copy, and read it back afterwards.
- **Not report a number it did not measure.** "The tests pass" is a claim;
  `24 pass / 0 fail` is a measurement. If it was not run, say it was not run.
- **Not decide something the brief did not delegate.** A design question that
  surfaces mid-work goes back, it does not get answered quietly.

## STOP, and why it is not failure

An implementer that hits something only a person can settle must **stop and say
so**, with what it found and what it needs. It must not:

- pick the interpretation that lets it keep going,
- widen its radius to work around the obstacle,
- or deliver something adjacent and describe it as the thing asked for.

A stop that arrives early is cheap. A stop discovered at review is a wasted
delegation, and one discovered after a merge is a defect with a story attached.

**The caller must not answer a STOP by re-dispatching the same brief.** The
answer is a decision, a widened radius, or a different ticket. Sending the same
question back gets the same answer and spends another delegation to hear it.

## What comes back

A result is three things, and it is incomplete without all three.

- **What changed**, as files and the reason each one was touched.
- **The measurement**, verbatim — the command, and its output. Not a summary of
  the output.
- **What is NOT done**, said plainly. Anything skipped, anything guessed at,
  anything the implementer could not verify. A report with nothing in this
  section is not a clean result, it is an unexamined one.

## Evidence, and what does not count as it

- A green test is evidence the test passed. It is evidence the CODE is guarded
  only if the test would go RED without it. If a guard was added, the way to
  know it guards anything is to remove the thing it guards and watch the count
  move.
- A source grep proves somebody typed a string. Running the command proves the
  command works.
- "Non-empty" is not an acceptance criterion. A diagnostic that returns
  something is not a diagnostic that returns the right thing, and a confidently
  wrong sentence sends the reader further astray than an empty one.

## Redaction and provenance

- **A brief may carry secrets; a report may not.** Credential VALUES never appear
  in a result, a log, or a summary. Field NAMES may, and often must — an
  operator who is not told which variable was missing cannot fix it.
- **Say which agent produced what.** When a result is relayed onward, the relay
  says whose work it is relaying. Work that arrives without provenance gets
  believed on the strength of whoever is speaking last.
- **A result read from a transcript is not a result.** If the deliverable was
  supposed to be written to a file and the file is absent, the delegation
  produced nothing, whatever scrolled past on the way.

## Approval

Some things are not the implementer's to do even inside its radius: pushing to a
remote, opening or closing anything outward-facing, deleting what it did not
create, or spending a budget the caller owns. Those come back as a request, and
the caller decides.

---

# Part two — a whole spec, run autonomously

Same contract, many agents. You need a **spec** (what is being built and what
makes it done) and **tickets** (bounded units with their dependencies). Both
live as files in the repository, so they are reviewed and diffed like anything
else.

If either is missing, stop and say so. Inventing the spec and then implementing
it is one agent agreeing with itself.

## The frontier

Tickets are a graph. The **frontier** is every ticket whose dependencies are
complete — that is what you dispatch, not a list in order.

Recompute it every time a ticket lands. A completion usually unblocks others,
and dispatching those immediately is the whole reason to model dependencies
rather than walk a list.

**An empty frontier with tickets left means a cycle or a failed dependency.**
Say which, and stop. It is not a slow moment to wait through.

## Steps

1. **Read the spec and every ticket. Build the graph and state it back** — ids
   and what blocks what — before dispatching anything. A graph nobody checked is
   a plan nobody agreed to.

2. **Research once, in one read-only subagent.** Where things live, the existing
   patterns, what will fight the change. **It writes notes to a file outside the
   repository** and every implementer is given that path. One pass, not one per
   ticket: six implementers rediscovering the same layout costs six times as
   much and they will not all reach the same answer.

3. **Branch.** The work needs somewhere to accumulate. **Do NOT push and do NOT
   open a pull request** — this skill has no authority to touch a remote, and an
   earlier version of this step asked for a draft PR while the boundary below
   forbade the push that a PR requires. A review lane caught the impossibility.
   The branch and its commits ARE the deliverable; step 10 hands them back and
   the owner opens the PR.

4. **Dispatch the frontier — one implementer per ticket, each in its own
   worktree.** The worktree is not optional. Agents sharing one checkout race on
   `git checkout -b`, land commits on each other's branches, and reset branches
   still checked out elsewhere. That has happened here, and nothing was lost by
   luck rather than care.

   Each implementer gets: the primary checkout is off limits, its file radius,
   the research notes path, and its acceptance.

   **Dispatch them in the background and do not wait on any one of them.** This
   is the sentence that makes the parallelism real: a caller who dispatches and
   then awaits each result in turn has followed every other rule here and still
   produced a serial run. Send the whole frontier, then handle results as they
   arrive.

5. **Merge each result as it lands, one at a time.** Do not batch — merging a
   finished ticket while others still run is the point of the parallelism, and a
   barrier at the end throws it away.

   **You merge, not a merger agent.** Prior art hands this to a dedicated merger
   subagent; here it is the caller's, deliberately. You are the only one holding
   the spec, the graph and every ticket already landed — the context a conflict
   is resolved from. An agent given only two diffs will guess, and a wrong guess
   inside a merge is the hardest kind to see afterwards.

6. **Recompute the frontier, dispatch what became unblocked.** Repeat from 4.

7. **Review the whole result against the SPEC, not the tickets.** Every ticket
   can be satisfied while the spec is not — that is what a spec is for.

   Use a review that can EXECUTE, not only read. This plugin ships that route:
   dispatch `codex-advisor` (or `agy-advisor` / `claude-advisor`) at the diff
   through `acp-dispatch.mjs`, and give it the spec and the branch.

   If your host also provides a `/code-review` command, run it as well — it is
   an OPTIONAL host extra, not part of this plugin. An earlier version of this
   step named it as the route and named nothing else; `/code-review` ships
   nowhere in this plugin (its only other occurrence is a keyword in
   `plugin.json`), so an agent reaching this step had no prescribed action.
   **If neither route is available, STOP and say so** — do not mark the work
   reviewed because the tests passed.

8. **Fix review findings in ONE implementer**, not one per finding. They overlap,
   and sequencing them inside one agent is cheaper than across several.

9. **Clean up every worktree.** A worktree left behind is a checkout the next
   run will collide with.

10. **Hand back, and stop.** Report the branch name, the head commit, what each
    ticket landed, what the spec review said, and anything you could not prove.
    **The owner opens the pull request.** That is the boundary this skill keeps,
    and it is why step 3 does not push.

## Pointers, not copies

Send **paths**: to the spec, the ticket, the research notes, the commits already
merged. A pasted copy is a snapshot from when the brief was written; two tickets
later it describes a tree that no longer exists, and the implementer believes it
because it arrived in the instructions.

## What you run, and what they run

An implementer runs **the focused test for its own ticket** and reports the
count. **You run the full suite once**, after the last merge and before the
review. That number is the one that means anything — measured here, fifteen
concurrent full passes took a load average to 28 on 8 cores and after 42 minutes
not one agent had finished.

## Where a run stops on its own

- **A ticket comes back STOPped.** The answer is a decision, not the same brief.
  If the decision is the user's, ask.
- **Empty frontier with tickets left.** Cycle or failed dependency; say which.
- **The same ticket fails twice.** The second failure is information about the
  ticket, not the implementer. Re-read it before spending a third.
- **A merge conflict the spec does not settle.** Two tickets disagree about the
  same lines and nothing says which wins. That is a spec question.

## What this will not do

- Push, tag, or release. **It leaves a local branch and hands it back** — it
  does not open a pull request, because it cannot: a PR needs a push.
- Widen a ticket into "while I was in there".
- Report a suite it did not run.
