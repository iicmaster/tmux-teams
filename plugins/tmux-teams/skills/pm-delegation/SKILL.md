---
name: pm-delegation
description: "Act as PM over other agents — subagents or ACP lanes — from one delegation to a whole spec. Covers the brief contract, the STOP rule, what counts as evidence, and the autonomous run: tickets as a dependency graph, one research pass, every ticket audited with `requirement-audit` before dispatch, a shared findings board carrying what every implementer learns, parallel implementers each in its own worktree bounded by a disk budget and a WIP limit, merged as they land, worktrees retired at merge, reviewed against the spec. Use when dispatching work to subagents or ACP, writing a brief, judging a returned result, or implementing a whole spec with minimal supervision — 'implement the spec', 'work the tickets', 'ทำตาม spec', 'ลุยทั้ง spec'. ใช้เมื่อรับบทเป็น PM คุมงานเอเจนต์อื่น. Do not use for a single edit you can make yourself, and never to route work through the delivery loop — that is tmux-teams."
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

   For requirement work, read `../requirement-audit/SKILL.md` relative to this
   skill's own directory; STOP if unavailable. Use its authoring mode when
   drafting and its scope dial when auditing; reference the canonical
   requirement and its verdict; do not copy them. A ticket without a
   `📋 Grill:` block is still auditable — the audit judges content and shape,
   not marker presence.
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
complete AND whose requirement audit came back READY — that is what you
dispatch, not a list in order.

The frontier is not the same as "what dispatches right now." Dispatch is capped
by the resident worktree limit (see below): a frontier may list ten tickets and
only three may have a checkout open at once. A ticket that is eligible but
waiting for a slot is not blocked — it is queued, and it enters the frontier
the moment a slot frees. Do not confuse "queued for a slot" with "blocked on
an audit answer"; they have different causes and different owners.

Recompute it every time a ticket lands. A completion usually unblocks others,
and dispatching those immediately is the whole reason to model dependencies
rather than walk a list.

**An empty frontier with tickets left means a cycle, a failed dependency, or
every remaining ticket waiting on an audit answer.** Say which, and stop. It is
not a slow moment to wait through.

## Steps

1. **Read the spec and every ticket. Build the graph and state it back** — ids
   and what blocks what — before dispatching anything. A graph nobody checked is
   a plan nobody agreed to.

   **Pre-flight: disk and resident worktrees.** Before spending a token on
   research, take inventory: run `git worktree list --porcelain`, count the
   resident checkouts, and note what is free on the filesystem. Reclaim
   orphaned worktrees from previous runs — delete the directory first, then
   `git worktree prune` — but only when ownership, liveness, and authorization
   are all provable; otherwise report them as candidates and leave them. Set the
   WIP limit for this run: `N = min(DEFAULT_WIP_LIMIT, floor(free / cost))`,
   where `cost` is the size of one full checkout of the current tree. If
   `N < 1`, STOP here and say so; do not dispatch anything. The default
   `DEFAULT_WIP_LIMIT` is 3, and it is configurable — raise it only when the
   machine has the headroom and a run's audit shows the higher number did not
   degrade throughput.

   **Audit every ticket with `requirement-audit`.** Read
   `../requirement-audit/SKILL.md` relative to this skill's own directory and
   apply its audit mode to every ticket; if that file cannot be read, report
   the missing skill and stop instead of reconstructing the audit from a
   summary. A ticket without a `📋 Grill:` block is still auditable — the audit
   judges content and shape, not marker presence. Audit the whole set HERE,
   once, for the reason the next step gives for research — one pass, not one
   per implementer.

   A NOT READY ticket does not enter the frontier, and neither does anything
   that depends on it; the independent frontier keeps moving, because this is
   a pause and not a stop. Settling it is the owner's decision, never a
   plausible guess. When the answer lands, audit the ticket AGAIN — an answer
   to one dimension does not make the others pass.

   **Init the run's findings board.** Create the run's board file in the run's
   workspace with `findings-board.mjs init <board>` — the script ships in this
   plugin's tmux-teams scripts directory — and append each ticket's audit
   verdict to the board as FACT or FAIL while you audit, with the failing
   dimension as `--detail` on a FAIL. What the board is, and how it is written,
   is "The findings board" below.

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
   the research notes path, and its acceptance — plus the board path and a
   fresh digest (`findings-board.mjs read <board> --format digest`), and the
   instruction to append a CLAIM when it starts, OBSERVED / FACT / FAIL as it
   learns them — a falsified hypothesis is the highest-value entry, because it
   stops a peer re-deriving the same dead end — and a PATCH_SUMMARY when it
   finishes.

   **Dispatch them in the background and do not wait on any one of them.** This
   is the sentence that makes the parallelism real: a caller who dispatches and
   then awaits each result in turn has followed every other rule here and still
   produced a serial run. Send the whole frontier, then handle results as they
   arrive. Stagger the starts by seconds rather than launching all at once —
   simultaneous bursts trip rate limits.

   **Resident worktree limit.** Never open more than N checkouts at once, where
   N is the WIP limit set in the pre-flight. The frontier may be wider than N;
   that is a queue, not a barrier. Dispatch up to N, and refill the slot the
   moment one merges. Before creating each worktree, re-check free disk; if it
   has dropped below the safety headroom, pause the dispatch of new tickets and
   wait for a slot to free. Do not let the queue drain into silence — when a
   slot frees, fill it immediately.

5. **Merge each result as it lands, one at a time.** Do not batch — merging a
   finished ticket while others still run is the point of the parallelism, and a
   barrier at the end throws it away.

   **You merge, not a merger agent.** Prior art hands this to a dedicated merger
   subagent; here it is the caller's, deliberately. You are the only one holding
   the spec, the graph and every ticket already landed — the context a conflict
   is resolved from. An agent given only two diffs will guess, and a wrong guess
   inside a merge is the hardest kind to see afterwards.

   **Retire the checkout the moment the merge and its acceptance are done.**
   Merge, verify, then clean that worktree immediately — do not wait for step 9.
   The whole point of streaming is that the slot frees for the next ticket; a
   merge that lands and leaves the checkout open is a slot wasted. Retire means:
   remove the worktree directory and prune its metadata, and confirm it is gone
   before dispatching the next ticket.

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

9. **Reconcile the worktrees.** By now every ticket's checkout should have been
   retired at merge (step 5). This step catches what slipped through: a ticket
   that STOPped, a run that was interrupted, a merge that failed. For each
   remaining worktree, verify ownership, liveness, and authorization before
   removing — a dirty checkout, one a process is still using, one owned by
   another run, or one carrying untracked or uncommitted data is reported as a
   candidate and left alone, never force-deleted. Remove only what you can
   prove is yours and finished. Report what remains and why.

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

The **requirement audit is yours too**, once over the whole set, in the prepare
phase, and its verdict is per ticket — read them one ticket at a time, not as
one verdict for the spec. An implementer auditing its own ticket is the
duplication the research pass exists to prevent, and a self-audit has no teeth.

The **disk budget and the worktree count are yours too.** The pre-flight sets
the WIP limit from free space and repo size; the dispatch guard re-checks
before each checkout; the retirement at merge frees the slot. An implementer
does not create, count, or clean worktrees — that is the PM's, because the PM
is the only one holding the graph and the disk state.

## Resident worktrees and disk

A worktree per ticket is the isolation the whole skill rests on; it is not
negotiable, and the 2026-08-05 incident (five agents racing one checkout, a
branch reset that did not hold) is why. What is negotiable is how many exist at
once and when they are released.

**The trap to avoid.** `git worktree add` does not copy the object database —
Git shares `.git/objects` across worktrees from the start, so history is not
the cost. The cost is the working-tree files plus anything untracked that the
run creates: `node_modules`, build caches, target directories. A 50MB source
tree becomes a 500MB checkout the moment the implementer installs dependencies.
On a machine with 4GB free, eight tickets is 4GB — which is all of it.

**Three rules:**

1. **Cap the resident count.** Never open more than N checkouts at once, where
   N is the WIP limit set in the pre-flight. The frontier may be wider than N;
   that is a queue, not a barrier. Refill the slot the moment one merges.
2. **Retire at merge.** Step 5 removes the checkout the moment its merge and
   acceptance are done. Step 9 exists for what slipped through, not for the
   happy path.
3. **Reclaim before you start.** Step 1's pre-flight reclaims orphaned
   worktrees from previous runs — but only those it can prove are orphaned and
   safe to remove. `git worktree prune` removes metadata only; it does not
   delete the directory. The directory must be removed first, and only when
   ownership, liveness, and authorization are all provable. Otherwise report
   the candidate and leave it.

**GC that is safe.** A worktree is removable only when all of these hold:
ownership (it is yours, recorded in the run's brief or notes), liveness (no
process is using it), authorization (the merge succeeded and its result is
recorded, or the ticket STOPped and the owner agreed to discard), and no
untracked or uncommitted data. Age and a name that looks like an agent's are
not proof of any of these. If any cannot be proved, keep the worktree and
report it; a disk budget that is met by deleting someone else's work is not
a budget, it is a loss.

**Sparse checkout is opt-in, never the default.** `git worktree add --no-checkout`
plus a sparse cone can shrink a checkout to its blast radius, but the blast
radius is a prediction, not a jail: an implementer may need to read type
definitions, config, or fixtures that live outside it, and a focused test needs
the module graph and root configuration to load. Use sparse checkout only when
the repository has a clear package boundary (`nx.json`, `pnpm-workspace.yaml`,
or equivalent) and the focused acceptance command still passes with the same
target count. Full checkout is the fallback, and the budget check applies to
the fallback too.

**Symlink heavy dependencies — shared READ-ONLY, never written by a worker.**
For repositories where `node_modules`, vendor caches, or build directories
dwarf the source, symlink them from the primary checkout into each worktree
rather than letting each implementer install its own. Verify first that the
project's toolchain follows symlinks (most do; a few do not). Know exactly
what this gives up: the SOURCE trees stay isolated, the DEPENDENCY tree does
not — one writable tree behind every worktree's symlink and behind the
off-limits primary checkout at once. So the contract is: an implementer never
runs an install (`npm install`, `pnpm install`, `bundle`, equivalents) inside
a worktree, and never runs a build or generator whose outputs land inside the
shared tree (`node_modules/.cache`, shim rewrites) while any other worker is
live. Dependency changes are made in the primary checkout by the run's owner
BETWEEN waves, not inside one; a ticket whose acceptance genuinely requires a
new or rebuilt dependency either runs alone (WIP 1) or with its own installed
copy, because two workers writing one dependency tree is not isolation at any
price. The "will not do" list below forbids sharing a dependency tree workers
may WRITE into — this paragraph is the same rule stated from the other side.

**What this skill will not do.** It will not pool worktrees across runs, share
a writable dependency tree, use filesystem reflinks, or auto-delete anything
whose ownership it cannot prove. Those are optimizations that trade isolation
for space, and isolation is the thing this skill exists to keep.

## The findings board

Each run keeps one findings board — a single append-only JSONL file in the
run's workspace, created at prepare (step 1) and written only through
`findings-board.mjs`. The append-only write holds for at most 8 concurrent
writers, the PM's own appends included — a WIP limit raised past that ceiling
is outside what the board promises. Entries are typed, one line each:

- **OBSERVED** — something a worker saw, evidence still to point at.
- **FACT** — established: an audit verdict, a confirmed pattern.
- **FAIL** — a falsified hypothesis, and the board's highest-value entry: a
  dead end recorded once is one no peer re-derives.
- **CLAIM** — a worker's belief, not yet verified.
- **PATCH_SUMMARY** — a worker's final report of what it changed.

Nobody edits or deletes an entry — superseding means appending a new one with
`--ref` naming the old id, the PM's move when curation overtakes an entry.
`detail` carries a pointer to the evidence, not a copy — the same rule as
briefs — and a fresh digest rides in every brief, so each worker starts from
everything the run already knows.

## Where a run stops on its own

- **A ticket comes back STOPped.** The answer is a decision, not the same brief.
  If the decision is the user's, ask.
- **Empty frontier with tickets left.** Cycle or failed dependency; say which.
- **The same ticket fails twice.** The second failure is information about the
  ticket, not the implementer. Re-read it before spending a third.
- **A merge conflict the spec does not settle.** Two tickets disagree about the
  same lines and nothing says which wins. That is a spec question.
- **No ticket can move and the reason is an audit answer.** The frontier is
  empty because every remaining ticket is waiting on a requirement the owner
  has not answered. Say that plainly, naming the dimension the verdict named —
  do not fill the gap with an answer that sounds right. The audit reports a
  missing dimension; it never guesses one.
- **Disk cannot hold even one more worktree.** The pre-flight failed and
  reclamation did not free enough. Report the capacity and stop — do not
  dispatch anything.

## What this will not do

- Push, tag, or release. **It leaves a local branch and hands it back** — it
  does not open a pull request, because it cannot: a PR needs a push.
- Widen a ticket into "while I was in there".
- Report a suite it did not run.
