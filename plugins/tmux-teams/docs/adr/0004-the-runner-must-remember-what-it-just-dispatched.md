# ADR 0004: The runner must remember what it just dispatched

Status: accepted, 2026-08-09
Supersedes nothing. Amends the reasoning in `loop-runner.mjs`'s liveness note
and in `SKILL.md`'s framing of Pulse.

## Why this document exists

Eight defects were fixed on 2026-08-09 by running the system on real hardware
and following each failure to the next one. Every fix was correct and every one
of them was found by a symptom rather than by a plan. That works and it does not
scale: by the eighth the room could no longer say what "done" was.

This ADR is the boundary. The work below is what gets done. Anything discovered
along the way that is not in **Acceptance criteria** goes into a new issue or a
new ADR, not into this branch.

## Context — the defect, in three parts, all measured

A loop driven by its watcher **dispatches the same seat two and three times**.
Measured on Ubuntu 26.04, 2026-08-09, on a two-team route that completed
correctly in 215 s:

| seat | dispatches | needed |
| --- | --- | --- |
| `build_w1` | 2 | 1 |
| `verify_dispatcher` | 2 | 1 |
| `verify_w1` | **3** | 1 |

Ten legs where six were required. Every duplicate carries a distinct `task_id`
and `dispatch_id` and every one recorded `work_observed: true` — these were real
model turns, not repeated ledger lines.

**1. The runner's occupancy answer comes only from `pulse.json`.**
`busy` and `busyTasks` are built from `snapshot.runs` (`loop-runner.mjs` ~314),
where `snapshot` is `pulse.json`. Nothing else contributes.

**2. `pulse.json` is documented as a VIEW, and nothing publishes it.**
`SKILL.md` says "Publish the three views **after the runner is available**" and
describes Pulse as "what transport activity is happening now". The runner does
not start `pulse.mjs`; no document states that the runner is unsafe without it.
The measured run logged `no pulse.json yet — dispatching without liveness
evidence` **33 times** and dispatched every time.

**3. With no snapshot, every in-flight leg reads as dead.**
`legIsLive()` answers from `busyTasks`, so an empty set means *nothing is
running*. The runner therefore believed a leg it had itself dispatched 236 ms
earlier was gone, and dispatched the seat again. The ledger already held that
leg's `assigned` line with no `delivered`; nothing consulted it.

The escape hatch is justified in the code by a sentence that is true exactly
once:

> "No snapshot at all is a repo where nothing has ever run — there is no agent
> to collide with, so the first dispatch is safe."

After the first dispatch there **is** an agent to collide with, and nothing ever
makes that sentence false. This is the same class this repository keeps paying
for: a claim broader than the code it guards.

**Why it never showed up before.** The watcher debounces at 250 ms; a tick
driven by it runs about a quarter-second after the event. Every previous run of
this loop was driven at 30–90 s per tick, by which time the leg had `delivered`
and `nextStep` moved on. The window was always there. Turning on the watcher —
the thing this system's own documentation calls the improvement — is what made
it reachable.

## Decision

**The runner records an in-memory claim in the same tick that decides to spawn,
and unions those claims into `busy`/`busyTasks` at the single point where both
are computed.**

- A claim is `{ agent_id, task_id, pid, at }`.
- It is recorded **before** the spawn returns, inside the same synchronous tick.
  `tick()` is a plain synchronous function with no `await` anywhere in it
  (verified 2026-08-09), and the watcher calls it directly, so ticks in one
  process are strictly serialised and a claim needs no lock to be correct.
- A claim is released **on evidence, never on elapsed time**: the ledger shows
  `assigned` or `delivered` for that `task_id`, or a pulse row names it. A claim
  whose `pid` is gone with no evidence is the existing `lost` class and is
  handled as `lost` — it is not a new terminal state.
- The union happens where `busy` and `busyTasks` are built, not at each dispatch
  site. One merge point means no dispatch path — worker, dispatcher, evaluator,
  outer controller, palette fallback — can forget to ask.

Pulse stays exactly what `SKILL.md` says it is: a view. The runner stops
depending on it for the one window the ledger cannot cover.

## Alternatives, and why each loses

**The runner writes `assigned` itself.** Contract §13 makes the companion the
sole writer of `assigned`, and a test states it. Changing that is a contract
amendment to fix a 250 ms window. Rejected.

**Make `pulse.mjs` mandatory, or have the runner spawn it.** The 90 s run had
zero duplicates with no pulse either, because once `assigned` and `delivered`
land the ledger answers. The uncovered gap is only spawn → `assigned`. Requiring
a second process changes operations for every existing user to close a window a
claim closes for free. Rejected.

**A cross-process lock or a lock sidecar.** Cron-driven operation gets a fresh
process per tick, so in-memory claims do not survive it. Cron cadence is ≥30 s
and the window is ~1 s, and after `assigned` the ledger covers everything.
Recorded below as a known residual with its reasoning, not closed here.

## Out of scope — this list is the point of the document

None of the following is part of this work. Each is real; each gets its own
issue or ADR if it is worth doing.

- **No broker, no message queue.** Already decided and not to be relitigated.
- **No change to `pulse.json`'s schema.** Contract §11.1 is frozen.
- **No change to who writes `assigned`.** Contract §13.
- **No cross-process lock.** See the residual above.
- **No change to cron-mode behaviour.**
- **The sandboxed review gate.** `qwen` is unprovisioned on the test host and
  `zai` answers prose instead of strict JSON. Both are gate problems, not loop
  problems. Note for whoever picks that up: `review-profiles.mjs` says default
  mode is what stops glm-5.2 answering prose, and on 2026-08-09 it answered
  prose **in default mode** — that contradiction needs recording where a reader
  of that file will find it.
- **No new watcher tuning.** The 250 ms debounce is not the defect.
- **No retry/backoff policy work.** A duplicate dispatch is not a retry.

## Acceptance criteria

1. **`loop-replay` carries a permanent invariant**: for every `agent_id`, a new
   `assigned` never lands while that seat's previous task has no `delivered`.
   Checkable from the ledger alone. **This test must go RED against the code as
   it stands before the fix** — by mutation or by a stashed revert — and that
   red run must be recorded. It is the only artifact proving the next
   re-entrancy defect cannot ship in silence.
2. **A unit test drives two immediate ticks with a stubbed spawn** and asserts
   the second one dispatches nothing for the claimed seat.
3. **Mutation**: removing the claim union from `busy`/`busyTasks` turns (1) and
   (2) red; the file restores to a matching sha256.
4. **Every consumer of `busy`/`busyTasks` is enumerated** — `nextStep`,
   `legIsLive`, withdrawal suppression, `inFlight` — and this ADR or the
   contract states what a claim in the union means for each. A claim briefly
   suppressing a withdrawal is acceptable and must be written down rather than
   discovered.
5. **The auto loop is re-run on the Linux host**, `--watch` with `interval=600`,
   and **dispatched legs equal required legs** with wall clock still around
   3.6 minutes. Anything faster than 600 s proves the watcher drove it.
6. Contract amended in the same commits as the behaviour: the claim concept and
   a new AC row naming the test. **§11.1 specifically, named here because this
   criterion was written without it and it would otherwise have fallen between
   owners** — found by a reader of this ADR, not by its author. That section
   states the defect as design:

   > "`pulse.json` is the only evidence that an agent is still running.
   > **Missing** snapshot = a repo where nothing has ever run. Dispatch is
   > allowed, with a note. **Present but stale** … All dispatch is refused,
   > loudly."

   Two things must change there. The opening sentence stops being true the
   moment the runner remembers its own in-flight dispatches — that is a second
   evidence source, narrower than pulse and authoritative only for the window
   pulse cannot see. And the asymmetry is backwards and must be named as such:
   **old evidence refuses all dispatch, no evidence permits it.** The
   justification — "a repo where nothing has ever run" — becomes false the
   instant the first dispatch leaves, and nothing in the system ever tells the
   contract it went false.
7. The liveness comment in `loop-runner.mjs` is **corrected, not deleted**, and
   `SKILL.md`'s "publish the views after the runner is available" framing stops
   implying the runner's safety ever depended on running one.

## Release path

This touches `plugins/**`, so `node scripts/gate-required.mjs` answers
**REQUIRED** and the three-model panel runs before the version is marked. On
macOS that is direct ACP with three families, per the 2026-08-08 rule, with
`effective_identity` recorded for every lane — the sandboxed gate cannot
assemble three families today and fixing that is out of scope above.

Then the standard mechanics: five files and six places, `git grep` the old
number, full suite, push with permission, watch CI, tag, GitHub release,
marketplace update. Commit `0228f6b` is still local and ships with this release.
