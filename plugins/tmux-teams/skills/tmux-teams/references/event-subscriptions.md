# Event subscriptions — one publisher, four subscribers

**Status: built and wired, 2026-08-14.** This is the source of record for the owner's
instruction *"rebuild by domain, then a message queue, then one publisher and N
subscribers"* — ROADMAP phases D and E.

It exists as a file because the analysis behind it did not. It lived only as a
published HTML page with no source in this repository, so `git grep` could not
find it, and for eight days every session read `HANDOFF.md` and `ROADMAP.md` —
neither of which mentioned it — and worked on something else. The design was
never lost; it was unfindable, which cost the same.

The rendered original, with its diagrams, is the `tmux-teams-ddd-reading`
artifact (17 versions, last 2026-08-06). Everything below that decides work is
restated here.

## The publisher already exists, and it is the ledger

Measured again 2026-08-14, unchanged from the original reading:

```
appendEvent            the single write door        8 callers
work-items/ written directly, bypassing it          0 occurrences
event vocabulary                                    17 words, validated
```

**No second vocabulary is minted.** Inventing event names beside the ledger's
own words would create the translation seam that produced the bugs this rebuild
is meant to end. The seventeen words ARE the events.

## The carrier was decided by measurement, not preference

Four candidates were compared on this machine, none of which adds a dependency,
a daemon, a port or an account:

| candidate | how it works | new writer? | if the runner is down |
|---|---|---|---|
| **watch the ledger directory** | the `delivered` append IS the signal | none | nothing is lost — the line is already durable |
| unix socket (`node:net`) | companion connects, writes one byte, exits | yes | wake lost, which is allowed |
| a wake file | companion touches `.tmux-teams/wake/<task-id>` | yes | file waits |
| SQLite queue (`node:sqlite`) | companion inserts a row; runner marks it | yes, plus a schema | row waits |

**Watching the ledger won**, and it shipped as `watchForWork()` in
`loop-runner.mjs`. It is the only candidate that adds no writer, no second
store, no schema and no cleanup, because the thing being watched is the record
the system already had to write.

Its weakness — `fs.watch` delivery is platform-dependent and can miss changes —
is survivable **by construction**: a lost wake costs latency, never correctness,
because the interval underneath it is the floor. `tests/watch-for-work.test.mjs`
probes whether delivery happens on the host before asserting that it does; on
this project's CI it does not.

**What the queue was wanted for already existed.** A worker that finishes its
turn and writes nothing still produces a ledger line, written by the harness —
`recordTerminal` in `acp-companion.mjs`, reached for the no-outbox path through
`finishDirectFailure`. What was missing was the WAKE, not the FACT.

## Who subscribes to what

Read the columns, not the rows.

| ledger event | token | team | workflow | display |
|---|---|---|---|---|
| opened | starts a history | **control's slot is taken** | picks the route | redraw |
| pulled | changes hands | **a slot is taken** | advances a hop | redraw |
| intake / returned | records the gate's answer | **accepted, or the slot frees** | on returned, the hop is undone | redraw |
| assigned | a leg begins | a seat is busy | — | redraw |
| delivered | **the leg's outcome** | **the seat is free** | is this step done? | redraw |
| reviewed | records the verdict | on reject, its own workers rerun | on pass, the next hop may pull | redraw |
| lost | a leg produced nothing | the seat is free | — | redraw |
| escalated | parked with the controller | slot still held | — | redraw |
| resumed | fresh budget | work resumes | — | redraw |
| completed | the route closed | slot frees | **route finished** | redraw |
| audit_requested / audit_lost | owed a verdict | **control's slot** | — | redraw |
| audited / abandoned | terminal | every slot frees | — | redraw |
| questioned / answered | waiting on a person | slot held | — | redraw |

`token` reacts to all seventeen because it owns the history. `team` reacts only
to the six that take or free a slot. `workflow` reacts to five, all about
position on a route. **`display` reacts to everything and decides nothing** —
that is the one rule this design must not break, and today it is broken: the
loop reads a page, so the dependency runs `display -> scheduler` when it must
run `run -> scheduler`.

## The scope is six cells, counted

The bold cells above are where a subscription replaces a decision `nextStep`
makes today. Not seventeen new handlers — **six**:

1. `pulled` → **team**: a slot is taken
2. `intake` / `returned` → **team**: accepted, or the slot frees
3. `delivered` → **token**: the leg's outcome
4. `delivered` → **team**: the seat is free
5. `completed` → **workflow**: route finished
6. `audit_requested` / `audit_lost` → **team**: control's slot

Cell 6 is the heart, and it is the one that was never built at all. The owner's
rule: a stuck token holds its team's slot; escalating to the PM means the PM is
working, so the PM's slot is held until that work is done, whatever the work is;
a held front door is the alarm. **The system stops when there is a problem.**

What the code has instead is eight brakes, every one a timer or a counter, all
in `loop-runner.mjs`: `MAX_ATTEMPTS`, `MAX_LEGS`,
`MAX_AUDIT_TRANSPORT_RETRIES`, `ZOMBIE_SEC`, `PM_COOLDOWN_SEC`,
`MAX_IN_FLIGHT`, `ANSWER_DEADLINE_SEC`, and the unchanged-trigger brake. They
exist because no PM work occupies a PM slot: `audit_requested` is a releasing
event that occupies nothing at all, and `escalated` stays with the delivery team
and still does not occupy the PM. So three tokens can be stuck in three teams
while the PM's single slot sits empty and new work is admitted normally, to get
stuck later, somewhere else.

## Why phase E is blocked on phase D, not merely after it

Events between domains that do not yet hold their own rules **relocate the
tangle rather than reduce it**. Today one function holds two domains' behaviour:

```
nextStep()   loop-runner.mjs:1282-1587   305 lines
  reads route or workflow in code        0 occurrences
```

Measured 2026-08-06 as zero, and again 2026-08-14 as zero — the three matches
inside that range are all comments. Until `team` owns how a team works and
`workflow` owns how a token moves between teams, a subscription has nowhere to
deliver to.

## Decisions on the record — argue with these, not from a blank slate

- **D1** A controller audit leg killed at the transport before the model ever
  ran **stays held**. Nothing retries by itself; a person unsticks it. *(owner)*
- **D2** Recovery is **a question, not a new word**. The runner asks with
  `questioned`; a person replies with `answered`. Both events, the actor rule
  and the re-arm path already exist. **No eighteenth event is minted.**
  *(owner, after the room proposed a new word and was corrected)*
- **D3** A token that has completed but is not yet audited is a
  **control-team-held queue item**. Not filed as Done, not left owned by nobody.
  *(outside review)*
- **D4** Making the audit the **tail of the route is rejected**. It would need
  the no-revisit invariant relaxed, and even then route indexing and held-team
  admission would treat the tail as already admitted — the route would finish
  without ever pulling the audit. *(outside review)*
- **D5** The vocabulary work is **part of the rebuild, not a side task**, and
  the refusal words move directly to their owning domains rather than through an
  intermediate code field. *(owner)*

## What the build changed about this document

Four things here were wrong, and a run found every one of them — not a re-read.

- **`opened` is not "—" for `team`.** It requires `to_team` (contract ข้อ 4.6)
  and the front door writes it naming control, so a request occupies control's
  slot from the moment it is admitted. That is the count the door has always
  enforced. Read the dashes as "nothing beyond the placement".
- **`returned` does not free the slot.** Contract ข้อ 4.1 forbids `agent_id`
  there and requires `to_team`: the token is held by the team it went BACK to.
  "The slot frees" is true only of the team that said no.
- **`delivered` → token needed the field a writer writes.** The leg outcome is
  `terminal`, and success is exactly `'done'`. An earlier version read a field
  called `outcome` that nothing has ever set, so every leg — failed or not —
  read back as a success, and a failed leg would have stopped being retried.
- **Who HOLDS is not who DECIDES.** The table says an escalation holds two
  slots and it is right, but exactly one team acts on it. `counts` carries both
  and `held` carries the controller; without that split the planning loop
  reaches the same token twice.

And one thing the table could not have told anyone, because it is not about
events at all: the derivation being replaced placed a token by WHO ACTED —
`teamOf(agent_id)` — and the accounting had no equivalent, so a token whose
history begins mid-flight was held by nobody. That single mechanism took the
suite from 31 red to 7.

## Answers the review panel is owed

A lane asked whether rewriting 1,073 contract cross-references from the section
sign to a Thai word breaks any search, lint or ratchet that keys on them, and
noted the rewrite rides along in the same diff as this change without being
mentioned. Half of that is right and half is measured false:

```
code or config files still carrying the section sign   0   (no mixed notation)
scripts that READ a clause reference                   0   (no lint, no ratchet)
scripts and tests that MENTION one, in comments       26
```

So nothing keys on the marker, and the notation is not split. The rewrite's own
reason is elsewhere and stands on its own: the owner cannot type the sign, and a
document its owner cannot grep is a document its owner has to take on trust.
What the lane was right about is packaging — a mechanical rewrite riding inside
a behavioural diff, unexplained, makes a reviewer spend attention proving it is
mechanical. Say it in the packet next time.
