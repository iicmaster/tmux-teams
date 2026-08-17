# ROADMAP — tmux-teams

> **This file is the source of the published roadmap page.** Edit it here; the
> page is a rendering. `node scripts/roadmap-gate.mjs` answers whether the
> digest recorded at the last publish still matches these bytes — it reads no
> network and never fetches the page, so it detects a stale page, not a page that
> was changed underneath us, and the release flow runs it.
>
> It lives at the repository root, tracked, for the same reason `HANDOFF.md`
> does: a roadmap only one machine can read is a roadmap to nobody. Before
> 2026-08-13 this document existed **only** as HTML on a private host, with no
> source, no publish script and nothing that could notice it had gone stale —
> so it went stale, repeatedly, and nobody could tell without opening it.

Current release: **0.31.0**

## Where the phases stand

| Phase | State | What it is |
|---|---|---|
| **A** | done | ACP transport for review lanes — spawn, initialize, session, prompt, terminal settlement |
| **B** | done | The exact-three review gate: three distinct model families, endpoint pins, zero-tool isolation (ADR 0001) |
| **C** | **closed by changing the question, 2026-08-13** | Was "run the three-family panel through bwrap on Linux". The panel now runs without bwrap on macOS and Linux alike (ADR 0006), and passed 3/3 on three packets for v0.20.0. |
| **D** | partly built | **The rebuild by domain.** Four domains hold their own behaviour — `team.nextRole`, `token.canPull`/`token.deliver`, `workflow.nextHop` — and orchestration decides WHEN, never WHAT. One dependency reverses: today the loop reads a page (`display → scheduler`); the target is `run → scheduler`. |
| **E** | **slot accounting live**, five cells of six | **One publisher, N subscribers.** The ledger's own 17 words are the events; `token` subscribes to all 17, `team` to the 6 that take or free a slot, `workflow` to 5 about position, `display` to everything and it decides nothing. Scope is **six cells**, each moving one branch out of `nextStep` — counted, not estimated. |
| **F** | proposed, not started | Per-seat pre-LLM / post-LLM scripts (Master's proposal). Three questions must be answered before any code. |

**Measured 2026-08-16, and phase E's own scope sentence does not say it.** The
scope reads "each cell moving one branch out of `nextStep`", and five cells are
wired — but `nextStep` is still 308 lines carrying 32 `if` branches, the same
shape it had before. The subscribers took over ANSWERING those questions; the
branches that ask them did not move. Wiring a cell and shrinking `nextStep` are
two pieces of work, and only the first has been done.

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

## Shipped since the phases were last written

Work that arrived as a direct instruction rather than off this page. It belongs
here because a goal document that does not know what happened is a goal document
nobody can plan from.

- **v0.31.0 — an ACP lane's identity claim, recorded and never counted.** The
  instruction was to swap the review gate's family evidence from *where a lane
  routed* to *what answered*. Measuring first refused the swap: for `agy` the
  advertised model list is the adapter's own, but every claude-routed lane is
  handed its list by this runner, so counting it is quoting ourselves.
  `claimedIdentity` records the advertised value and whether the runner seeded
  it; `provenFamilyKey` remains the only family evidence. On the first panel
  that carried the field, two lanes advertised a bare `default` and `agy`
  advertised `gemini-3.7-flash-high` while this repo pinned 3.6 — so the field
  built to decide nothing is what caught a model moving underneath a pin.
- **v0.31.0 — the AGY lane moved to `gemini-3.7-flash-high`**, which is where
  its adapter already was.
- **v0.31.0 — the brakes question was answered** (see below); no brake was
  removed and one gained the guard it never had.
- **The release flow now goes through a pull request.** Merge requires CI green
  and the `chatgpt-codex-connector` review; only Master waives it and the waiver
  is recorded. v0.31.0 used that waiver once, on an exhausted account quota.
- **An MCP server for lane discovery — built, reviewed twice, not yet merged**
  (ADR 0007, branch `feat/acp-lane-mcp`). Two read-only tools answer which ACP
  lanes exist and what each still needs on this machine, because the per-machine
  override variables had worked since 2026-08-13 and nothing surfaced them. A
  `codex-advisor` lane blocked it twice on bytes a three-family panel had passed
  3/3 with zero findings — a false `ready: true` reproduced in one command, and
  then a fix list that named the wrong executable. **The lesson is a sequencing
  one and it is now in `CLAUDE.md`: an advisor lane can execute and the panel
  cannot, so attack with the advisor while the code is cheap to change and spend
  the panel last, as the record.**


- **`acp-dispatch.mjs` — the operator's entry to an ACP lane, 2026-08-17.**
  Direct instruction from Master, on the day a `codex-advisor` review died with
  its answer unwritten: `stall-sec` 1200 typed into a shell capped at 600, both
  numbers in the same command, nothing comparing them, killed at exactly ten
  minutes with 461 protocol events recorded. `loop-runner.mjs` had never been
  able to fail that way — its `dispatch()` has always spawned the companion
  `detached: true` and called `unref()`, so the lane leads its own process group
  and a group kill aimed at the parent cannot reach it. The fix existed and only
  the loop could reach it. The instruction was explicit: *make it impossible
  with a script, not a rule the model is hoped to follow.* So the shape of the
  answer is three things, not one — a script that detaches, a test that kills
  the caller's whole process group mid-turn and demands the lane finish anyway,
  and a test that reads every shipped skill and fails on a fenced command that
  launches the companion directly. Seven such commands existed across four
  skills and are gone. `status <cwd> <task-id>` closes the second half of the
  same day: it reads back liveness, names the outbox it derived, LISTS anything
  else in `.mailbox-out/`, and prints the resume command with the session id
  already in it. That listing is not decoration — a recovery run under a
  `-recover` task id while its prompt still named the original path produced a
  complete 22 KB review that the companion reported as `no_outbox`.

## The release in flight — v0.32.0

Scope set by Master, 2026-08-17: **one release carrying both** the MCP
lane-discovery server and `acp-dispatch.mjs`. They touch one file in common and
they are the same subject — the lifecycle of an ACP lane — so they are reviewed
and shipped together rather than paying for two panels and two version bumps.

**It is BLOCKED, and by exactly one thing.** A `codex-advisor` lane read the
round-three fixes and found five more, every one reproduced with a command:

1. The Kimi lane repeats the credential defect that round three "fixed" for
   Zai. `acceptedRoutedKeys` widened the LOADER; `validateRoutedEndpoint` still
   counts only `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ZAI_API_KEY`,
   so a `KIMI_API_KEY` is read and then not accepted from any source. **The fix
   was half a fix, and the half that shipped is the half that advertises.**
2. A fractional numeric request id is refused `-32600`. JSON-RPC 2.0 says
   fractional ids SHOULD NOT be used, not MUST NOT, and MCP's `RequestId` is
   string-or-number — so a legal request is rejected and its correlation lost.
3. Only `tools/call` validates its params. `initialize` with no params,
   `tools/list` with `params: []`, and `ping` with unexpected params all still
   answer success.
4. Credential FIELD NAMES do reach the wire, in the `credential_missing` fix
   sentences — put there deliberately in round three — while the module comment,
   ADR 0007 and a test title all claim they do not. The contract is false, not
   the bytes; the honest repair is to say that names are diagnostic vocabulary
   and values are what never leave.
5. Moving `MOONSHOT_API_KEY` from the `kimi` lane to `qwen` keeps both suites
   green and forwards a foreign key into the Qwen child. The literal inventory
   pins the SET; nothing pins which lane owns which name.

The room split on two more and did not reconcile: a mode-0755 file whose shebang
names a missing interpreter still answers `valid` (proving it would require
EXECUTING the candidate, which turns a read-only status tool into an acting
one), and the settings/ambient precedence for a provider secret is undocumented
and untested.

Also in scope and not code: the published roadmap page, the submodule pin in
`~/agent-skills`, and a `HANDOFF.md` that currently still says the third review
has not been run.

## The release after — v0.33.0, and why these five

Ordered by what they cost when left alone, not by size. The first two arrived
as GitHub issues; the last three are things v0.32.0 measured and could not fix
inside its own scope.

### 1. The default `claude` ACP lane cannot reuse a logged-in Claude Max session

Filed 2026-08-17 as *"ACP default Claude lane cannot reuse Claude Max OAuth
login"*. The default `claude` CLI reports a logged-in Claude Max account; the
companion drives the same binary and dies at `[fatal] -32000 Authentication
required` after `initialize` and `session/new` both succeed. No prompt is
delivered and no outbox is produced.

The gap named in the issue is specific: the companion advertises filesystem
capabilities only and never advertises the ACP terminal-auth capability, and
the upstream adapter exposes its Claude Subscription / Console login methods
only to a client that asks for them. So the adapter has a working login route
and we never let it offer one.

**This is first because of what it costs, which is more than one lane.** On
2026-08-17 a release panel needed three model families and found that four of
the seven declared lanes could not answer: `zai` refuses because its gateway
will not accept a disabled thinking mode and its package expired, `kimi` and
`deepseek` are out of quota, and `claude` — the one lane that needs no routed
profile and no third-party quota at all — is unreachable for the reason above.
A reviewer family that should be the fallback for every other one is the family
that has never been tried.

Acceptance is written out on the issue and is not restated here; the two parts
worth repeating are that a lane with no credentials must return a structured,
actionable blocker rather than hang or blame the model, and that no secret
value may reach a log, receipt, KMS event or outbox.

### 2. `loop-runner` re-dispatches a `blocked` terminal instead of escalating

Filed as *"loop-runner retries a 'blocked' terminal instead of escalating —
burns worker legs on a token that needs a human"*. `blocked` is this plugin's
own signal that a person must act, and `loop-runner.mjs` treats it as a crashed
process: `last.terminal !== 'done'` is the whole test, so the human gate and a
segfault are the same branch.

The issue carries a real run: `blocked` at 19:56, re-dispatched, `failed`,
re-dispatched, `blocked` again, and a human stopped it at 20:04. Nothing about
the token changed between legs — the first answer was the answer, and two more
worker legs were spent asking the same question. The review policy and the
handoff guidance both already say a `TEAM_BLOCKED` outbox must not be
auto-answered; only the runner disagrees.

### 3. Lane health is discovered one release at a time

There is no preflight that answers "which lanes can actually review today", so
the answer is assembled by probing lanes one at a time in the middle of a
release. On 2026-08-17 that cost four probes and a swapped panel composition
after the run had already started. `acp_lane_status` reports whether a lane is
CONFIGURED, which is a different question and deliberately so — it contacts no
endpoint. What is missing is the cheap live check: one trivial brief per lane,
run on demand, reporting reachable / quota / refused, with the refusal
classified rather than echoed.

Worth stating what this is not: it is not a health-check that runs on a timer
and it must not become one. The measurement is only wanted when a panel is
about to be assembled.

### 4. `belongsToThisRun` has bounds, not a nonce

v0.32.0 closed the forgery a panel lane found — a liveness record stamped in
the future read as belonging to this run forever — by bounding the timestamp on
both sides. That stops the accidental case and the clock-skew case. It does not
stop a deliberate one, because nothing in the record is unique to this dispatch.
A real nonce needs the companion to echo a value the dispatcher generated,
which is a protocol change and was out of scope. The code says so at the call
site rather than implying otherwise.

### 5. No real Claude host has ever initialized the shipped MCP server

ADR 0007 states this plainly and it is still true: the server's read-only
property is established by source inspection plus a mock-observed
`mcpServers: []` request, and the tool inventory inside a real dispatched ACP
child has never been measured. Until a real host initializes it, ADR 0003's
guarantee remains a guarantee about what is REQUESTED.

## What is actually open

These are real but unforced, and separate from the release above:

- **The raw companion is still runnable, and that is the honest limit of the
  word "impossible".** `loop-runner.mjs` spawns it and the suite drives it, so
  it cannot be removed. What was removed is every DOCUMENTED path to the
  killable form, and `tests/acp-dispatch.test.mjs` keeps them removed — a model
  reading a skill never finds a command to copy that a shell cap can cut in
  half. A caller who types the companion's own path anyway is outside what a
  script can reach.

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
- **A review packet has a working ceiling well below the 128 KiB the gate
  enforces.** The `qwen` lane
  failed `schema_invalid` three times running on a 72 KiB contract packet, always
  at `invalid finding summary` — a summary past the 1,000-character limit the
  prompt states plainly — while answering the same content cleanly at 22 KiB, and
  answering 74 KiB of source and 60 KiB of tests without trouble. So it is not
  size alone: dense prose costs more than dense code. Nobody has found where the
  real ceiling is, and the gate cannot warn about it. Three more data points
  from 2026-08-16, all mixed source and prose: 20 KiB and 26 KiB passed, and a
  37 KiB packet was split by meaning rather than risked. The working practice is
  to stay near 25 KiB and split; that is a habit, not a measurement of the
  boundary.
- **`nextStep` has not shrunk.** Five of phase E's six cells are wired and the
  function is still 308 lines over 32 branches — the subscribers answer the
  questions, and the branches that ask them are untouched. Moving one is the
  next unit of that phase, and nothing yet says which one is cheapest.
- **The brakes in `loop-runner.mjs`: there are SEVEN, and the evidence now
  exists. None of them comes out.** This entry asked for per-brake evidence
  that the WIP hold covers what each was standing in for; it was produced on
  2026-08-15 by disabling each one and running the 216 loop tests.

  First, the count was wrong. `MAX_AUDIT_TRANSPORT_RETRIES` was removed on
  2026-08-07 and its own comment says so — three documents went on saying
  "eight" for a week.

  ```
  brake                  tests red when disabled   what it actually stands for
  ANSWER_DEADLINE_SEC             9                the door's clock
  ZOMBIE_SEC                      7                a dead process, which no projection can see
  MAX_ATTEMPTS                    4                what TRIGGERS an escalation
  MAX_LEGS                        2                the length of a journey
  unchanged-trigger brake         2                a permanent condition re-reading itself
  MAX_IN_FLIGHT                   1                a ceiling on the whole board
  PM_COOLDOWN_SEC                 0                the RATE a full agent is spent at
  ```

  Six are guarded and load-bearing. Not one is standing in for a PM seat: the
  WIP hold says "this token already holds control's slot", and every brake
  above answers a different question — a clock, a dead process, a journey
  length, a spend rate. The premise this entry was written on ("they exist
  because no PM work occupied a PM slot") is true of the SHAPE of the problem
  and false of these seven items.

  And the zero is the interesting one, in the direction opposite to the obvious
  reading. `PM_COOLDOWN_SEC` could be set to 0 without one of 216 tests
  noticing — not because the WIP hold covers it, but because nothing ever
  guarded it. 28 of 33 `planEscalation` calls do leave `cooldownSec` at its
  default, so the default is reached constantly; it just never bites, because
  those boards have no `pm-notes/latest.md` for the clock branch to read.
  **Zero red proves UNGUARDED, never redundant** — the same rule this
  repository already applies to a platform branch that cannot answer. It has a
  guard now (`tests/loop-occupancy.test.mjs`), and removing the brake turns it
  red.

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
- **ADR 0002** — `opened` names a human decision; the runner never invents one.
- **ADR 0007** — the plugin ships one read-only MCP server for lane discovery.
  It reads credentials and never returns a credential VALUE — field NAMES are
  diagnostic vocabulary and go out on purpose, which ADR 0007 now states and
  this page contradicted until a panel lane caught the two disagreeing. It does
  not reopen ADR 0003:
  a DISPATCHED agent still receives none.

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
