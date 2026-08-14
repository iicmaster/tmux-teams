# ROADMAP — tmux-teams

> **This file is the source of the published roadmap page.** Edit it here; the
> page is a rendering. `node scripts/roadmap-gate.mjs` answers whether the
> published page still matches these bytes, and the release flow runs it.
>
> It lives at the repository root, tracked, for the same reason `HANDOFF.md`
> does: a roadmap only one machine can read is a roadmap to nobody. Before
> 2026-08-13 this document existed **only** as HTML on a private host, with no
> source, no publish script and nothing that could notice it had gone stale —
> so it went stale, repeatedly, and nobody could tell without opening it.

Current release: **0.20.0**

## Where the phases stand

| Phase | State | What it is |
|---|---|---|
| **A** | done | ACP transport for review lanes — spawn, initialize, session, prompt, terminal settlement |
| **B** | done | The exact-three review gate: three distinct model families, endpoint pins, zero-tool isolation (ADR 0001) |
| **C** | **closed by changing the question, 2026-08-13** | Was "run the three-family panel through bwrap on Linux". The panel now runs without bwrap on macOS and Linux alike (ADR 0006), and passed 3/3 on three packets for v0.20.0. |
| **D** | partly built | **The rebuild by domain.** Four domains hold their own behaviour — `team.nextRole`, `token.canPull`/`token.deliver`, `workflow.nextHop` — and orchestration decides WHEN, never WHAT. One dependency reverses: today the loop reads a page (`display → scheduler`); the target is `run → scheduler`. |
| **E** | **slot accounting live**, four cells of six | **One publisher, N subscribers.** The ledger's own 17 words are the events; `token` subscribes to all 17, `team` to the 6 that take or free a slot, `workflow` to 5 about position, `display` to everything and it decides nothing. Scope is **six cells**, each moving one branch out of `nextStep` — counted, not estimated. |
| **F** | proposed, not started | Per-seat pre-LLM / post-LLM scripts (Master's proposal). Three questions must be answered before any code. |

## The rebuild the owner ordered — and where it actually stands

The instruction was **rebuild by domain, then a message queue, then one publisher
and N subscribers.** Phases D and E above are that instruction, and until
2026-08-14 they were two blank rows in this table while the design sat in a
published HTML page with no source in this repository — the identical failure
this file was created to end, applied to the owner's own direction.

**What was already done, and where the code is:**

- **The queue question was answered by measurement, not skipped.** Four
  carriers were compared on this machine — `fs.watch` on the ledger directory, a
  `node:net` unix socket, a wake file, and a `node:sqlite` queue. None adds a
  dependency, a daemon, a port or an account. Watching the ledger won because the
  `delivered` append **is** the signal: no new writer, no second store, no schema,
  no cleanup. A lost wake costs latency, never correctness, because the interval
  underneath it is the floor.
- **That carrier shipped**: `watchForWork()` in
  `plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs`, guarded by
  `tests/watch-for-work.test.mjs`, which probes whether `fs.watch` delivers on the
  host before asserting that it does — on this project's CI it does not.
- **The fact the queue was wanted for already existed**: a worker that writes
  nothing still produces a ledger line, written by the harness — `recordTerminal`
  in `acp-companion.mjs`, reached for the no-outbox path through
  `finishDirectFailure`. What was missing was the WAKE, not the FACT.

**Built 2026-08-14, and E landed ahead of D rather than behind it.** The four
subscribers exist and `teamOccupancy` delegates to the `team` one, so every
reader — board, graph page, pull controller, runner, front door — gets the same
answer and contract ข้อ 13 holds. `RELEASING_EVENTS` narrows to the two hard
terminals; an escalation holds both its delivery team's slot and control's; a
finished route is control's queue item until it is audited. The front door
refuses while control owes a verdict, which is the alarm the owner described.

**Five of the six cells are live: 1, 2, 3, 4 and 6.** Cell 3 landed last:
`nextStep` asks the `token` subscriber whether a leg failed instead of
re-deriving it, and escalates to a person if the subscriber and the ledger line
disagree rather than quietly preferring one. Forcing the subscriber to answer
false turns the planner's own test red, so the wiring is guarded at the
consumer.

**Cell 5 is a cross-check and is deliberately not load-bearing.** `awaitingAudit`
consults `routeFinished` and arms the audit on either answer. Measured: deleting
the domain's answer turns exactly one test red, and it is the domain's own unit
test. That is not an oversight — the domain and the custody scan read the same
field of the same log, so nothing can tell them apart behaviourally, and the
only way to give the domain the weight is to delete the scan. Then a projection
that is wrong drops an audit: a delivery that finished with nobody owing it a
verdict, which is the exact failure this rebuild exists to end.

**Phase D's real work is untouched**: `nextStep` still holds two domains'
behaviour in 305 lines, and still reads a route zero times. The prediction that
E could not pay before D landed turned out to be wrong for the slot accounting
specifically — slots are the team's own business and needed no route — and it
still stands for everything that depends on where a token goes next.

**Decisions on the record — argue with these, not from a blank slate.** A
controller audit leg killed at the transport stays held; a person unsticks it
(owner). Recovery is a question, not a new word: `questioned` / `answered`
already exist, and no eighteenth event is minted (owner, after the room proposed
a new word and was corrected). A completed-but-unaudited token is a
control-team-held queue item (outside review). Making the audit the tail of the
route is rejected — the route would finish without ever pulling it (outside
review). The vocabulary work is part of the rebuild, not a side task (owner).

## What is actually open

Nothing is blocking a release. These are real but unforced:

- **If bwrap is ever re-enabled**, the sandbox still does not carry a routed
  wrapper's own profile files into the ephemeral home. The gate knows where to
  READ them (`TMUX_TEAMS_REVIEW_<ID>_SETTINGS` / `_ENV_FILE`) and never places
  them where the wrapper looks. The layout-agnostic fix is to mirror the
  operator-named paths relative to `HOME`, not to hardcode a second layout.
- **Credential-shaped JSON key names** are no longer redacted in outbound
  reviews — a deliberate consequence of `keyNames: false`, which stopped a field
  called `sawRawSecret` from having its value erased. Narrow, but real.
- **`cleanRemoteText` collapses only CR/LF/TAB**, so ESC/ANSI and NUL from a
  provider error can still reach an operator's log. Low severity, log-injection
  shaped.
- **Phase F** needs its three questions answered before it becomes work.

## Decisions that are not up for re-litigation

Each of these has a document; go and argue with the document, not from a blank
slate.

- **ADR 0001** — the exact-three ACP review gate, and why plan mode was never
  what made a lane read-only.
- **ADR 0003** — a dispatched agent receives no MCP server. Enforced at runtime
  (AC135), not merely stated.
- **ADR 0004** — the runner reserves a SEAT and a TOKEN, and releases a claim on
  evidence, never on elapsed time.
- **ADR 0005** — MCP's Tasks extension converged on this companion's design
  independently; we stay divergent, and the conditions that would reverse that
  are written down.
- **ADR 0006** — shipped review profiles no longer declare bwrap. What that
  costs is stated, along with the strongest argument against the decision.

## How this page stays true

1. Edit `ROADMAP.md`.
2. `node scripts/roadmap-render.mjs` — writes `docs/roadmap.html`, deterministic,
   no dependencies. Nothing about the page is written by hand any more.
3. Publish that file, then `node scripts/roadmap-gate.mjs --record <url>`.
4. `node scripts/roadmap-gate.mjs` — exits 2 while the published page is behind.

The gate never records for you. A gate that writes its own answer passes
forever, which is the same shape as a test asserting a value it just computed —
this project has been bitten by that seven times and counting.

The renderer exists because the gate alone was not enough. A gate raises the
alarm; it does not lower the cost, and the cost was the whole problem — every
published version of this page was HTML somebody wrote by hand, so staying
current meant remembering to dispatch an agent at it. That is not a process.
