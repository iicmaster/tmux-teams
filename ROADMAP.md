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

Current release: **0.34.0** — the version stamped in this tree, in flight on
a pull request and not yet tagged. `main` carries **v0.33.0**, tagged at the
MERGED sha `8a0f63b` (not the branch tip `f31c468` — those are different
commits, and tagging the wrong one ships a sha `main` does not hold). Anyone
installing from the marketplace resolves the last TAG, not this line.

## Where the phases stand

| Phase | State | What it is |
|---|---|---|
| **A** | done | ACP transport for review lanes — spawn, initialize, session, prompt, terminal settlement |
| **B** | done | The exact-three review gate: three distinct model families, endpoint pins, zero-tool isolation (ADR 0001) |
| **C** | **closed by changing the question, 2026-08-13** | Was "run the three-family panel through bwrap on Linux". The panel now runs without bwrap on macOS and Linux alike (ADR 0006), and passed 3/3 on three packets for v0.20.0. |
| **D** | partly built | **The rebuild by domain.** Four domains hold their own behaviour — `team.nextRole`, `token.canPull`/`token.deliver`, `workflow.nextHop` — and orchestration decides WHEN, never WHAT. One dependency reverses: today the loop reads a page (`display → scheduler`); the target is `run → scheduler`. |
| **E** | **slot accounting live**, four load-bearing cells of six plus one cross-check | **One publisher, N subscribers.** The ledger's own 17 words are the events; `token` subscribes to all 17, `team` to all 17 as well, `workflow` to 7 about position, `display` to everything and it decides nothing. (`team` 6 and `workflow` 5 stood here until a panel lane said the code disagreed and the lists were counted: `TEAM_EVENTS` holds all seventeen, `WORKFLOW_EVENTS` seven. The 6 was the design intent — the events that take or free a slot — written as though it were the shipped list.) Scope is **six cells**, each moving one branch out of `nextStep` — counted, not estimated. |
| **F** | proposed, not started | Per-seat pre-LLM / post-LLM scripts (Master's proposal). Three questions must be answered before any code. |

**Measured 2026-08-16, and phase E's own scope sentence does not say it.** The
scope reads "each cell moving one branch out of `nextStep`", and five cells are
wired — four load-bearing and cell 5 as a non-load-bearing cross-check, which is
the same five the "four are live" paragraph below counts differently. "Live" and
"wired" were being used as synonyms for two different states, and a lane reading
the page against itself is what separated them — but `nextStep` is still 308 lines carrying 32 `if` branches, the same
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

**Four of the six cells are live: 1, 2, 4 and 6 — and cell 3 is NOT among
them.** This paragraph said cell 3 landed last, with `nextStep` asking the
`token` subscriber whether a leg failed instead of re-deriving it, and
escalating to a person on disagreement. A panel lane said the code did not
contain it, and the code agrees with the lane: `failedLegs(item)` filters
`item.custody` directly, asks no subscriber, and has nothing to disagree with.
Commit `6d19d95`'s message carries the same overclaim — a commit message cannot
be corrected after the fact, so the correction lives here and says that the
commit said it too.

Cell 3 is open work, not shipped work.

**Cell 5 is a cross-check and is deliberately not load-bearing.** `awaitingAudit`
consults `routeFinished` and arms the audit on either answer. Measured: deleting
the domain's answer turns exactly one test red, and it is the domain's own unit
test. That is not an oversight — the domain and the custody scan read the same
field of the same log, so nothing can tell them apart behaviourally, and the
only way to give the domain the weight is to delete the scan. Then a projection
that is wrong drops an audit: a delivery that finished with nobody owing it a
verdict, which is the exact failure this rebuild exists to end.

**Phase D's real work is untouched**: `nextStep` still holds two domains'
behaviour in 308 lines, and still reads a route zero times. The prediction that
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
- **An MCP server for lane discovery — built, reviewed, merged in `f7b07c6`**
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

## The last release — v0.32.0, shipped

Scope set by Master, 2026-08-17: **one release carrying both** the MCP
lane-discovery server and `acp-dispatch.mjs`. They touch one file in common and
they are the same subject — the lifecycle of an ACP lane — so they are reviewed
and shipped together rather than paying for two panels and two version bumps.

**Where it actually stands, 2026-08-18.** This section described the release as
blocked by five `codex-advisor` findings from round three, and a panel lane
caught that they had all shipped while the page still called them the reason
the release was blocked. All five are closed: the Kimi credential path shares
`acceptedCredentialNames` with the Zai one, a fractional numeric request id is
accepted, every method validates its own params, the credential contract says
plainly that field NAMES are diagnostic vocabulary and VALUES are what never
leave, and the lane that owns each provider key is pinned rather than only the
set of keys being pinned.

What has been spent on it since: fourteen `codex-advisor` rounds, one automated
PR review that returned ten findings before its quota ran out, and NINE panel
rounds, with a tenth owed on the current bytes. This said "five panel rounds"
while two later paragraphs on the same page named findings from rounds five and
six and described what the ROUND-SEVEN packets carry — a number that its own
document disproved twice, caught by a lane asked to read the file against
itself.

Every accepted finding is closed, and the claim that each one carries a guard a
mutation turns red is now MEASURED rather than asserted: two predicates
survived their whole test file in both directions until 2026-08-18, and they
were behaviour-changing — one manufactured the literal string `undefined` as an
agent mode, another silently dropped the model and receipt guarantee from every
recovery. They have tests. The claim is worth keeping only while somebody keeps
running the mutations, so read it as a report on the last run, not a property. Nine findings
are deferred with their reasoning, listed under what is open; one dispute
recorded as unresolved was later resolved AGAINST the position recorded here.

**It shipped.** PR #69 merged to `main` at `6b95101`, tagged `v0.32.0` on
2026-08-19. Master waived the three-family panel for it; the review of record
was the `codex-advisor` lane at `gpt-5.6-luna`, effort `max`, whose reported
identity is written into the release notes the way a panel lane's would be. The
availability that prompted the waiver, measured 2026-08-18: of seven shipped
lanes only `agy` (gemini) and `codex` (openai) could answer — qwen hit a one-week quota, zai's gateway refuses a
disabled thinking mode and its package expired, kimi and deepseek are out of
quota, and the default `claude` seat cannot reach an ACP session at all, which
is v0.33.0's first item.

**That dispute is CLOSED, and this paragraph said otherwise for a whole
release.** A mode-0755 file whose shebang names a missing interpreter used to
answer `valid`, and the defence was that proving otherwise would require
EXECUTING the candidate. A panel lane answered that `unchecked` was already in
the vocabulary and describes the state honestly without executing anything, and
it was right: `unresolvedInterpreterFor` reads 256 bytes and
`acp-lanes-mcp.mjs:363` returns `unchecked` with a fix sentence naming the
missing interpreter. The settings/ambient precedence for a provider secret is
tested too — `tests/acp-lanes-mcp.test.mjs:163` applies the returned remediation
and measures the ambient path beside it.

Two hundred lines further down, this file already recorded the dispute as
settled against me. Both sentences shipped in the same document. A
codex-advisor lane read them against each other and against the code, which is
the only reason it is being corrected now rather than by the next reader of a
gate file that contradicts itself.

## The release in flight — v0.33.0

**Eight items ship; five were declared here before the work started and three
arrived during it.** This heading said "why these six" and the paragraph under
it counted two-plus-three-plus-one, while the settled table below listed eight —
a page that disagreed with its own table, which is exactly what makes a status
page unauditable. The five declared: the Claude Max login, the live lane-health
preflight, the `blocked` re-dispatch, the nonce, and `agy-advisor`. Ordered
below by what they cost when left alone, not by size.

**The three that were NOT declared here before the work started.** Recorded
because this file is the standing goal, and a goal that learns what happened
only after the fact is a status page:

| arrived during the release | how |
|---|---|
| the comment diet on the v0.32.0 files, 51% -> 44% | Master's instruction |
| one advisor contract across all three lanes | Master's instruction |
| the prohibited model accepted at dispatch | found while measuring the one above |

The last is the one worth reading. `ACP_MODEL=gemini-3.1-pro-high` on an AGY lane
was ACCEPTED and reported `effective_identity: gemini-3.1-pro-high (matched)` —
the identity check certifying a model CLAUDE.md prohibits and says to fail closed
on. The prohibition was enforced over the pinned profile models at import and
never over the model an operator requests, and the adapter advertises both 3.1
seats, so it was reachable by typing. Asking three advisors to "accept a model"
is what made a documented command able to reach it.

## v0.33.0 scope, settled by Master 2026-08-19

Three of these were ambiguous enough to stop and ask rather than guess, and the
answers are recorded here because a scope decided in conversation and not written
down is a scope that gets re-decided.

| # | item | state |
|---|---|---|
| 1 | `agy-advisor` | **shipped** |
| 2 | the comment diet on the v0.32.0 files | **shipped** |
| 3 | one advisor contract across all three lanes | **shipped** |
| 4 | the prohibited model accepted at dispatch | **shipped** |
| 5 | the `claude` lane cannot reuse a Claude Max login | **half** — see below |
| 6 | `loop-runner` re-dispatches `blocked` instead of escalating | **shipped** |
| 7 | a live lane-health preflight | **shipped** |
| 8 | `belongsToThisRun` proves identity, not just recency | **shipped** |

**Item 5 is HALF, and the half that is missing is the half that matters to a
user.** The companion now advertises the ACP terminal capability, gated behind
an explicit `ACP_ENABLE_TERMINAL=1` login mode, and IMPLEMENTS all five terminal
methods; the ordinary dispatch path advertises nothing new and refuses a
terminal request outright. **Four of the five are exercised** — create,
wait_for_exit, output and release, plus the refusal of output after release,
which is a postcondition of `terminal/output` and not a fifth method.
`terminal/kill` is implemented and no test calls it, which is an unexecuted
guard rather than a working one. Read "implements" as source: no runtime
exchange with a real adapter has been observed for any of the five.

**Nobody has completed an actual Claude Max login through it.** That needs a
person at a real terminal and it has not been done. Do not read this row as
"the lane works" until someone has run it and said so here. The issue's other
acceptance half — a structured, actionable blocker when an unauthenticated
ordinary lane hits `-32000` — is untouched.

**Item 5 is fixed the way the issue names, not the way v0.32.0 measured.** Both
diagnoses are real: the companion advertises filesystem capabilities only and
never the ACP terminal-auth capability, so the adapter has a login route it is
never invited to offer; and separately the adapter reads
`~/.claude/.credentials.json` while the CLI reads the macOS Keychain, which is
why `claude -p` answers at the moment the lane refuses. Master's call is the
capability, so a person can log in from the terminal the lane is running in.
The credential-store split stays recorded, not fixed.

**Item 7 is a THIRD TOOL on the MCP server**, beside `acp_lanes` and
`acp_lane_status`. That contacts an endpoint, which ADR 0007 currently forbids —
so the ADR is amended as part of the item rather than quietly contradicted. It
is still not a health check on a timer: one trivial brief per lane, on demand,
reporting reachable / quota / refused with the refusal classified.

**Item 8 takes the protocol change.** The entry below used to list it and then
explain in its own text that a real nonce was out of scope, which is a
contradiction this page carried while calling itself the standing goal. Master
settled it: v0.33.0 does it. The dispatcher generates a value, the companion
echoes it into the liveness record, and `belongsToThisRun` checks it — which
closes the deliberate forgery that bounds cannot **for lanes this dispatcher
started**. A record with no routing file, which is what `loop-runner.mjs`
produces when it starts a companion directly, still passes on bounds alone by
deliberate compatibility choice. The unqualified sentence stood here until a
review lane read it against `acp-dispatch.mjs`.

**Delivery model, also Master's, 2026-08-19:** implementation is dispatched to
Sonnet subagents; `agy` and `codex` at `gpt-5.6-luna` review. The session drives
and measures rather than typing the change itself.

**A third advisor seat: `agy-advisor`.** SHIPPED. `codex-advisor` and `claude-advisor`
cover the OpenAI and Anthropic families, so every consultation this project can
hold is a two-family split — and v0.32.0 spent nine review rounds on one seat
before a change of model found in its first round what the nine had not. A
Gemini seat through Antigravity is the cheapest way to stop that.

Measured before the skill was written rather than after: the lane accepts
`INITIAL_AGENT_MODE=read-only`, `ACP_SESSION_RECEIPT_REQUIRED=1` and
`ACP_SESSION_OPERATION=new`, writes a receipt, and reports
`effective_identity: gemini-3.7-flash-high (matched)`. So it is held to the same
enforcement as the Codex seat rather than excused like the Claude one, which has
no mode switch. It has no reasoning-effort dimension, so its identity is the
bare model id where Codex reads `gpt-5.6-sol[max]`.

The guard mattered more than the skill: `tests/plugin-structure.test.mjs`
matched advisor commands on the workers `codex|claude` only, so a new advisor's
commands would have matched NOTHING and shipped unguarded. That filter now names
every worker the dispatcher takes, and the mutation that reverts it turns the
suite red.

**The default `claude` ACP lane cannot reuse a logged-in Claude Max session.**

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

**`loop-runner` re-dispatched a `blocked` terminal instead of escalating —
SHIPPED in v0.33.0.** What follows is the issue as filed, in the tense it was
filed in; the behaviour it describes is gone. `loop-runner.mjs` returns
`escalate` for a `blocked` terminal and `pull-controller.mjs` says it needs a
person. A review lane read this section's present tense against the table above
that already marked it shipped, which is how a standing goal misleads an
operator into believing a fixed thing is still broken.

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

**Lane health was discovered one release at a time — SHIPPED in v0.33.0.**
The third MCP tool is the preflight this section asked for. What follows is the
issue as filed, in the tense it was filed in.

There was no preflight that answered "which lanes can actually review today", so
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

**`belongsToThisRun` had bounds and now has a nonce — CLOSED in v0.33.0.**

v0.32.0 closed the forgery a panel lane found — a liveness record stamped in
the future read as belonging to this run forever — by bounding the timestamp on
both sides. That stopped the accidental case and the clock-skew case and not a
deliberate one, because nothing in the record was unique to the dispatch. The
protocol change that was out of scope then is in v0.33.0: the dispatcher
generates `ACP_SPAWN_NONCE`, the companion echoes it into the liveness record,
and `belongsToThisRun` requires an exact match on top of the bounds.

**Scope it the way the code does.** That closes forgery for lanes THIS
dispatcher started. A record with no routing file — the shape `loop-runner.mjs`
produces, which starts companions directly and writes no nonce — is still
accepted on bounds alone, deliberately, as a compatibility mode. This paragraph
said the opposite of the one above it for a whole release, until a review lane
read the page against itself; do not read either as covering the routing-less
path.

**Nine findings from the v0.32.0 panel that are NOT v0.32.0's to fix.** Recorded
rather than dropped, because a finding that disappears without an answer is the
silent skip this file keeps legislating against.

The openai lane raised them in rounds five and six; gemini answered CLEAR on
those packets both times and qwen answered CLEAR on one and did not raise them
on the other. The repo's bar is that an objection two of three families raise is
must-fix — one family is a judgement, and this is the judgement: none of the
nine touches either feature v0.32.0 ships, and all of them predate it.

- `graph-setup`'s "an `init` copy is only a shape, never an answer" is false
  against `graph.mjs init`, which the main skill then tells a reader to use
  unchanged.
- The numbered interview cannot construct its own mandatory control team: Q2
  says the outer controller belongs to no team, Q15 derives workers per team,
  and a later section requires that controller to be the control team's sole
  worker.
- Valid graph IDs become invalid agent IDs — Q1 permits dots, colons and 128
  characters in `project_id`, Q2 recommends `pm_<project_id>`, and the AGENT_ID
  grammar forbids dots and colons and caps the length.
- The wizard collects models and never adapter or lane declarations, though the
  same skill says a model means nothing without one.
- The copy-paste admission command opens the bundled workflow at
  `requirement_dispatcher`, bypassing the control front door the same file calls
  mandatory, and the next section admits such graphs need `admit.mjs`.
- `graph.mjs` emits three strings where the contract requires `unverified`, and
  the skill tells the reader to reinterpret the output rather than fixing it.
- Pulse's startup exemption masks the silent worker death it exists to detect.
- The "robust" completion and live-status algorithms knowingly produce false
  DONE/idle results.
- ACP context is not opt-in and can bleed across reused task ids, and the
  footprint authenticity guarantee contradicts the same-UID trust model.

**If a second family raises any of these, it becomes must-fix and this entry is
wrong to have deferred it.** The round-seven packets carry this paragraph, so
the lane that raised them can read the reasoning and answer it — which is how
the `valid`-versus-`unchecked` dispute was settled against me.

**No real Claude host has ever initialized the shipped MCP server.**

ADR 0007 states this plainly and it is still true: the server's read-only
property is established by source inspection plus a mock-observed
`mcpServers: []` request, and the tool inventory inside a real dispatched ACP
child has never been measured. Until a real host initializes it, ADR 0003's
guarantee remains a guarantee about what is REQUESTED.

**What is left on v0.33.0 is the mechanical steps.** Merge on CI green plus the
codex bot review, tag the merged sha, publish the release with the review
identity in its notes, and move the submodule pin in `~/agent-skills`.

**The review of record is the `codex-advisor` lane at `gpt-5.6-luna`, effort
`max` — Master's decision of 2026-08-19, that this seat alone is sufficient.**
**It read these bytes seven times and blocked six of them.** Twenty-six findings
were raised and closed, in rounds of 8, 4, 6, 4, 3, 1 — and round seven answered
`TEAM_DONE`: no substantive ship blocker, with the unverified limits named
rather than waved past. Its `effective_identity`, `gpt-5.6-luna[max]` with
`identity_status: matched`, goes in the release notes the way a panel lane's
would. Rounds two through four found defects in the previous round's FIXES
rather than in untouched code; round five found the first real runtime defect,
in a validator this release had itself extended.

**And then a second reviewer, unread for the whole cycle, had 26 more.** The PR
review bot's findings do not live in the review BODY — that is boilerplate —
they are inline comments, and this session twice reported "no suggestions" after
reading only the body. Triaged against the current bytes by four readers with
two adversarial verifiers each: 2 already fixed, 4 not defects with the design
comment quoted, **15 confirmed and closed here**, three of them ship-blocking.

Two were unhandled stream `'error'` events that would take the whole MCP server
down on a broken pipe — a bug class this repository had already found and fixed
in two sibling files, and did not carry across to the one v0.33.0 added. The
third was a Gemini 3.1 seat reachable through an account default: the
prohibition was enforced on the model REQUESTED and a seat declaring
`INHERIT_ACCOUNT_DEFAULT` requests none, so nothing was checked. It is enforced
on the identity the session reports back now.

**Eight of the fifteen were in `acp-lanes-mcp.mjs`, which no review round ever
opened.** Seven rounds read the dispatcher, the companion, the loop and the
documents. The file this release ADDED was the one nobody looked at.

`scripts/gate-required.mjs` still answers REQUIRED, and will keep doing so: it
is fail-closed and reads no waiver. **Report that as a fact, not as a veto.**
This paragraph said "no review of record has been accepted" and "the panel is
NOT waived" for most of the release — written before the owner answered and
never revisited — while `HANDOFF.md` recorded the decision correctly. A review
lane read the two against each other. Two shipped documents must tell the next
operator the same thing about what a decision means.

## v0.34.0 scope, set by Master 2026-08-22

Four items. Two are inventory, one is conformance, and one is a new capability
that has to be written rather than vendored.

| # | item | state |
|---|---|---|
| 1 | Agent Plugins 1.0 — conform where possible, record where not | **shipped** — ADR 0008 |
| 2 | remove the `show-me` skill | **shipped** |
| 3+4 | `pm-delegation`, written here | **shipped** — one skill, not two |

**Item 1 closed as a DECISION, not a move.** The manifest already conformed on
every field; the layout cannot, because the client this plugin ships to has no
awareness of the standard. Measured from the installed Claude Code binary's own
strings: it finds plugin content by `.claude-plugin/` or a top-level
`commands/`, `skills/`, `agents/`, `hooks/`, `themes/`, `output-styles/`,
`monitors/`, `workflows/`, `SKILL.md`, `.mcp.json` or `.lsp.json`, and contains
no occurrence of `agent-plugins.org`. Moving `.claude-plugin/` into a
reverse-domain namespace would satisfy 1.0 and make the plugin uninstallable.
ADR 0008 records the decision and the argument against it. The layout test came
first and turns red at 21/3 if anything moves.

**Items 3 and 4 became one skill, on Master's answer.** They were shipped as two
— a contract and an implementer — and the answer was one `pm-delegation` for
acting as PM over subagents OR ACP lanes, not feeding the graph loop. Part one is
one delegation, part two is a whole spec. The rewrite is in the history; the
two-skill version never left the branch.

**Item 1 is a layout problem, not a manifest problem, and reading the schema is
what settled that.** `plugins/tmux-teams/plugin.json` already satisfies
`agent-plugins.org/schemas/1.0.0` on every field: the required set is
`["$schema", "name"]`, both are present, `$schema` matches exactly, `name`
passes the pattern, and `author` carries only permitted keys. What does not
match is the shape around it. The 1.0 portable root is `plugin.json`, `skills/`,
`mcp.json`, and **reverse-domain namespaces** for client-specific material.
This tree keeps that material at the root instead: `.claude-plugin/` and
`commands/` sit beside `skills/`.

**Two sentences that stood here were wrong, and the correction is the finding.**
This paragraph called `mcp.json` and `.mcp.json` "two copies that must agree
with nothing enforcing it". They are not copies and something does enforce them.
`mcp.json` is the vendor-neutral registration — it carries the
`agent-plugins.org/schemas/1.0.0/mcp.schema.json` declaration and uses
`${PLUGIN_ROOT}`; `.mcp.json` is the Claude Code one, carries no `$schema`, and
uses `${CLAUDE_PLUGIN_ROOT}`. They differ ON PURPOSE.
`tests/acp-lanes-mcp.test.mjs` reads both, asserts which must and must not carry
the schema key, asserts both point at the same shipped script, and separately
BOOTS the vendor-neutral one over JSON-RPC so a string-alike copy cannot pass.
The sentence was written from two filenames and a memory of an old bug, without
opening either file.

**And the real obstacle is not tidiness, it is a conflict.** Measured from the
installed Claude Code binary's own strings: it recognises plugin content by
looking for `.claude-plugin/` — or a top-level `commands/`, `skills/`,
`agents/`, `hooks/`, `themes/`, `output-styles/`, `monitors/`, `workflows/`,
`SKILL.md`, `.mcp.json` or `.lsp.json` — and it contains **no** occurrence of
`agent-plugins.org` or of a bare `${PLUGIN_ROOT}`. The client this plugin ships
to cannot read the namespace the standard asks us to move into. Moving
`.claude-plugin/` under `com.anthropic.claude/` would satisfy 1.0 and make the
plugin uninstallable.

So item 1 is a decision, not a chore: conform where the two agree, and record
where they cannot. **Whatever is decided, the layout test comes BEFORE anything
moves.** No test today asserts layout at all — every existing one reads a known
path and checks its CONTENTS, so a move that updated the four hard-coded paths
would keep the suite green. A test written after the move confirms what was
done rather than checking whether it was right.

**Item 2 removes a duplicate, not a feature.** `show-me` collides by name with
the `artifact-sftp` plugin's own `show-me`, which is installed on the same
machine. Shipping a name another plugin already uses hands the ambiguity to the
user. `SKILLS` in `tests/plugin-structure.test.mjs` and the README inventory are
both guarded, so the removal cannot be half-done quietly.

**Items 3 and 4 are written here, not vendored.** A pull request offering a
vendor-neutral `pm-delegation` guide is declined with thanks and the reason
recorded on it; the subject is one this plugin has opinions about and they
belong in our own words. `implement-spec` in `mattpocock/skills` is read as
prior art and not copied.

What item 4 has to be, in Master's words: a multi-agent implementer that takes a
spec and its tickets, does codebase research in a subagent, implements every
ticket in subagents at maximum concurrency, reviews the finished code against
the spec, and cleans up every worktree — able to take on large chunks of work
with minimal supervision.

**The tension to resolve before writing it, not during.** Tickets are a task
GRAPH with a moving frontier, and this plugin already has an orchestration model
of its own — a ledger, WIP limits, seven brakes, and a review gate. Vendoring a
second model would ship a plugin that teaches two conflicting ways to run work.
Whether the frontier is a new mechanism or an expression of the ledger this
system already keeps is the design question, and it is item 4's real content.

## v0.35.0 scope, set by Master 2026-08-24

Four items. Three were direct instructions; the fourth was found by running the
tool the previous release shipped.

| # | item | state |
|---|---|---|
| 1 | fold `codex-tmux-driver` into `tmux-teams` — it was a skill for one client | **shipped** — skills 12 → 11 |
| 2 | a conformant Agent Plugins 1.0 root beside the Claude one | **shipped** — `agent-plugins/` |
| 3 | remove the OS sandbox rather than merely stop declaring it | **shipped** — ADR 0006 amended |
| 4 | `acp_lane_probe` reported every lane unreachable, and was wrong | **shipped** — two budgets |
| 5 | two P1s the release panel found, one of them older than the release | **shipped** — see below |

**Item 2 is what ADR 0008 lost its own bet to, and it is the cheap answer it
did not see.** That ADR recorded a conformance gap as permanent because the
client cannot read the standard layout, and wrote itself down so the loss would
be visible. Master's answer was not to argue with the client: keep the Claude
layout as the one that ships, and put a second root beside it that IS the
standard, for whoever installs by the standard. Every entry under
`agent-plugins/tmux-teams/` is a symlink into the Claude tree, so the two roots
cannot drift into disagreeing — there is only one copy of anything.

**Item 4 is the one worth reading, because the tool was lying confidently.**
`acp_lane_probe` shipped in v0.33.0 with a single 20-second ceiling, and probed
on 2026-08-24 it reported all five contacted lanes `probe_timeout` — a closed
code whose sentence told the operator the endpoint had not answered. Measured
the same hour, the network was up, every adapter resolved on PATH, and the
pinned endpoint answered 200 in 126ms. The lanes were fine. What took longer
than 20 seconds was the ADAPTER STARTING: a cold `npx -y` install of
`@agentclientprotocol/claude-agent-acp@0.61.0` reached `initialize` in 190s, and
a warm one still took 24.4s to reach a prompt.

Raising the number was rejected as the fix. A single ceiling has to cover the
worst case, and a ceiling that covers a 190s cold install is one every genuinely
dead lane then rides in full — which is the cost the tool's own "cheap"
justification cannot pay five times in a sweep. The budget is split instead, at
the boundary the handshake already crosses: everything before `initialize`
answers is installation and process start, everything after it is an endpoint
being asked one word. `probe_boot_timeout` is a new closed code with its own
sentence, so the two failures no longer send an operator to the same wrong
place. A ceiling costs nothing when the lane answers, so the warm sweep did not
get slower.

**Measured against real lanes, not only the stub.** Driving the patched module
directly at `zai`, `codex` and `agy`: **agy came back `reachable`** — the same
lane that answered `probe_timeout` an hour earlier under the single ceiling.
The other two moved off `probe_timeout` as well, onto `unclassified`, which is
a refusal this server does not classify rather than a silence it invented. The
whole three-lane sweep took **20.5s**, so the larger boot budget did not cost
the sweep anything, exactly as the split predicted.

The stub and the mutation still carry the guard: a `mute` mode that answers the
handshake and then goes quiet, run with the budgets deliberately disagreeing,
and deleting the rearm turns that test red at 31.5s.

**What is still not proven:** that the two lanes now reading `unclassified` are
refusing for the reason their provider would give. `unclassified` is by design
the code for "this server will not guess", and nobody has run the gate to find
out what is behind it.

**Item 5 is what the release panel was for, and it earned its cost twice.**

The gemini lane read the source packet and found that `party-mode/SKILL.md`
announced the sandbox was gone in its opening sentence and then described that
sandbox, in the present tense, for the rest of the same bullet — masked host
roots, an ephemeral provider HOME, a new PID namespace, and a tolerance rule for
AGY built-in reads. Confirmed three ways in the code: `osSandbox` is read by
nothing, `inspectAgySafeRead` is gone, and the isolated `builtin/` tree is gone.

The openai lane blocked the release on two P1s and both were real.

**`networkSharedWithHost` was `false`, and no lane has ever satisfied it.** The
field states a fact about SHARING while every sibling in the same evidence
object states a fact about CONFINEMENT, and that inverted polarity in the middle
of a list is what let the sandbox removal flip the neighbours and freeze this
one. It was wrong before this release: at v0.34.0 it read
`profile.osSandbox === 'bwrap'`, and the bwrap argv carried `--unshare-pid` and
nothing else, because a review lane has to reach its provider's API. The network
was shared on both sides of that expression. Corrected to `true` in the emitter,
the gate's expectation and the fixture; mutating the emitter alone turns two
behavioural tests red.

**The portable root could not be picked up.** All six links point outside the
root they live in, so `git archive HEAD agent-plugins | tar -x` produces six
dangling links — and "install from that folder instead" is the entire reason the
folder exists. Master's answer, 2026-08-24: keep the links in the tree, and add
`scripts/portable-root.mjs` to hand out a resolved copy on demand. The two
properties were only in conflict while nothing could produce the second.
`fs.cp` with `dereference: true` is the whole mechanism, and the guard is a test
that walks the copy, refuses any surviving symlink, and compares four manifests
byte for byte against the sources they were linked to. Turning the dereference
off turns it red.

**And a third, found on the rerun: the AGY safe-read exemption outlived what it
was for.** The sandbox removal left `const agyReadInspection = null` guarding
`if (null?.scope)` — a branch that can never run and two counters that can never
leave zero — while `review-gate.mjs` went on exempting AGY from checking them.
Dead code holding open a dead permission: it could not help any real lane and
could only widen what a wrong runner slips past, and it read to an auditor like
a live allowance. The branch is deleted and the gate now requires zero from
every lane. Deleting the exemption did not turn one test red, which is how it
survived removal in the first place, so a behavioural guard was added; restoring
the exemption turns that guard red.

**And a fourth, the most serious, found on the round after that: the
executable-trust boundary had no caller.** `party-mode/SKILL.md` promises that
before launch the profile-owned executable is resolved, binaries shadowed by the
target repository or by PATH are rejected, and a trusted runtime root is
required. `resolveExecutable` and `trustedExecutableRoots` were exported and
unit-tested throughout — and at v0.34.0 their only production caller sat inside
`stageHomeExecutable`, which was called inside `if (profile.osSandbox ===
'bwrap')`. ADR 0006 stopped any shipped profile declaring that on 2026-08-13, so
no lane had resolved its executable for eleven days. The sandbox removal deleted
code that was already dead; what it exposed is a documented guarantee with
nothing behind it. The call is now on the spawn path for every lane, and the
guard is behavioural: an unresolvable command must be refused with `spawn` never
reached. Deleting the call site turns it red.

**What the panel cost and what it bought.** Four rounds, because a finding
changes the bytes and the bytes are what the panel read. The gemini lane found
the documentation defect and then accepted every later round with no findings;
the openai lane found all four code defects. **Three of the five were older than
this release rather than introduced by it**, and every one was the same shape: a
sweep that updated the neighbours and missed one, or a guard whose consumer went
away while the guard stayed green.

One finding was refused on measurement rather than argued away: the claim that
the gate fixture's `networkSharedWithHost` is decoupled from production is
false — mutating the emitter alone turns two behavioural tests red. Recorded
because a panel objection that survives is worth as much as one that lands.

## What is actually open

These are real but unforced, and separate from the release above:

- **The raw companion is still runnable, and that is the honest limit of the
  word "impossible".** `loop-runner.mjs` spawns it and the suite drives it, so
  it cannot be removed. What was removed is every DOCUMENTED path to the
  killable form, and `tests/acp-dispatch.test.mjs` keeps them removed — a model
  reading a skill never finds a command to copy that a shell cap can cut in
  half. A caller who types the companion's own path anyway is outside what a
  script can reach.

- **If a sandbox is ever written again** (the bwrap one was removed 2026-08-24), it still would not carry a routed
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
- **ADR 0003** — a dispatched agent is REQUESTED with no MCP server. The runner
  sends `mcpServers: []` and the suite asserts that request. "Enforced at
  runtime" is what this line said, and ADR 0007 already admitted the narrower
  truth two paragraphs into itself: what has been observed is a mock receiving
  an empty request, never a real child's tool inventory. A panel lane read the
  page against the document it summarises. The guarantee is about what is asked
  for.
- **ADR 0004** — the runner reserves a SEAT and a TOKEN, and releases a claim on
  evidence, never on elapsed time.
- **ADR 0005** — MCP's Tasks extension converged on this companion's design
  independently; we stay divergent, and the conditions that would reverse that
  are written down.
- **ADR 0006** (amended 2026-08-24) — the OS sandbox is removed entirely. What that
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
