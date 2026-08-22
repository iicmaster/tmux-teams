# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-22 through `bmad-party-mode`.

## 1. READ THIS FIRST

- **TWO branches are live.** `feat/v0.33.0` (the release, PR #71) and
  `feat/v0.34.0` (finished work, branched from it). Neither is merged. `main` is
  at v0.32.0.
- **The review of record answered CLEAR on round ten, and TWO further batches of
  findings have landed since.** Do not read "round ten cleared it" as "ship it":
  batch 2 raised twelve (all twelve survived adversarial verification, all
  twelve are now in), batch 3 raised three more, and one of those three was a
  **P1 caused by batch 2's own fix**. Re-list the PR's inline comments by
  `created_at` before any merge.
- **`feat/v0.33.0` is at `769897a`, pushed, CI green on Linux.** All twelve
  batch-2 findings plus the P1 plus a thirteenth found by reading are in.
- **Two subagents were running when this was written**, each in its own
  worktree, each owning one file: `fix3-lanes` on `acp-lanes-mcp.mjs` + its
  test, `fix3-companion` on `acp-companion.mjs` +
  `tests/acp-terminal-capability.test.mjs` + `tests/fixtures/mock-acp-agent.mjs`.
  If the session ended before they reported, their work is UNCOMMITTED in
  `.claude/worktrees/`. Look before redoing it.
- **The full suite has NOT been run since the two merges.** Focused files are
  green (see HOW TO VERIFY); the whole-suite number below predates them.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
```

Green on `feat/v0.33.0` at `9282868` is exactly, measured on a quiet machine:

```
ℹ tests 1183
ℹ pass 1179
ℹ fail 0
ℹ skipped 4
```

~63s wall, 313% CPU. The hostile-env run below gives the same four numbers.

**RUN THE WHOLE SUITE, NOT THE FILE.** The first quiet full run after the
batch-2 merge went **1179/1174/1/4** — `realProbeTransport reaps a descendant
left behind by a package-runner wrapper` died on a raw ENOENT naming a temp
path, while that same file had passed 79/79 twice and the single test 3/3 under
load average 7.3. The probe's 300ms deadline was also the wrapper process's
whole lifetime, so under suite load node had not booted to spawn the descendant.
**A deadline shorter than the subject's boot does not make a test flaky, it
makes it vacuous** — it would have passed against a version that reaps nothing.
Fixed in `fbeb8b3`, and the precondition now fails with a sentence naming
itself instead of an ENOENT stack.

**Green in YOUR shell is not green.** Run it hostile too — this is the state any
shell is in after a hand dispatch:

```bash
ACP_MODEL=ambient ACP_EXPECT_MODEL=ambient ACP_REASONING_EFFORT=ambient \
ACP_SPAWN_NONCE=ambient-nonce ACP_ENABLE_TERMINAL=1 ACP_AGENT_ID=ambient-agent \
ACP_SESSION_OPERATION=new ACP_SESSION_RECEIPT_REQUIRED=1 node --test
```

**`node --test | grep '✖'` exits 0 when it FINDS failures.** Gate on the count.
A background `node --test …; grep …` reports the GREP's exit code — a red suite
arrived as `exit code 0` in a task notification.

**`git diff --check` with no range reads the working tree only.** CI reads
`$PR_BASE_SHA...HEAD`. Use `git diff --check main...HEAD`.

```bash
node scripts/gate-required.mjs   # run AFTER committing; it reads <last-tag>..HEAD
node scripts/roadmap-gate.mjs    # 0 current · 2 published page is behind
```

**READ WHAT `gate-required` PRINTS.** It names every deciding file, and reading
that list is what found a 10KB review transcript tracked in the release after
ten review rounds had read past it.

The 4 skips are the bwrap set skipping itself off Linux. A skipped test is an
unexecuted guard.

## 3. STATE

### The twelve findings from the bot's second batch

All confirmed by two refuters each; none rated ship-blocking. Status:

| # | finding | state |
|---|---|---|
| 1 | `realProbeTransport` reaps only the wrapper pid, never descendants | **DONE** merged |
| 2 | `QUOTA_SIGNAL` misses the underscored `rate_limit_exceeded` | **DONE** merged |
| 3 | a malformed `session/prompt` result classifies as reachable | **DONE** merged |
| 4 | the stdout `'error'` handler swallows and never settles | **DONE** merged |
| 5 | terminal descendants survive a wrapper's exit | **DONE** merged |
| 6 | `terminal/kill` does not escalate past SIGTERM | **DONE** merged |
| 7 | a non-array `args` is not rejected | **DONE** merged |
| 8 | login input broadcasts to every terminal | **DONE** merged |
| 9 | `childEnv` forwarded ambient `ACP_*` | **DONE** `6ac3fbc` |
| 10 | `TEAM_BLOCKED` reached an agent defaulting to `resume` | **DONE** `c045beb` |
| 11 | agy-advisor command hardcodes the model, ignoring its alias argument | **DONE** `5509d39` |
| 12 | agy-advisor command never clears inherited `ACP_REASONING_EFFORT` | **DONE** `5509d39` |

**All twelve are in and CI is green on the merged bytes** (`769897a`, Linux,
clean HOME). Their work arrived on two branches from two subagents and was
verified by THIS caller by mutation, not on their word: deleting `detached:
true` from the probe spawn reds two descendant tests; dropping the `await` on
`killTerminal` reds the kill-escalation test at "answered in 0ms".

**A thirteenth was found by reading the twelfth's fix, not by a review round.**
`terminal/create` had just been taught to refuse a non-array `args`, and `env`
one line down still fell through its own ternary to `{}` — the caller believes
it set the child's environment, the child runs with the parent's, nothing says
so. One loop now covers both names (`769897a`). **This is the release's most
repeated shape: a guard written for the container that was REPORTED, with its
twin left open beside it.** Look for the twin every time.

**Deliberate contract narrowing, recorded so it is not mistaken for a defect
fix:** finding 8 was closed by REFUSING a second `terminal/create` while one is
live, rather than by building session-aware input routing. Nothing in any
shipped SKILL.md, ADR or reference promises concurrent terminals, the predicate
matches the one the stdin bridge already uses (`exitStatus || released`), and
the capability only exists on the login route nobody has completed. A
sequential login flow is unaffected.

Every finding in full: `scratchpad/bot-findings-batch2.md`.

11 and 12 were one block in `plugins/tmux-teams/skills/agy-advisor/SKILL.md`
and are guarded by one test — `tests/acp-dispatch.test.mjs`, "the AGY seat the
caller asked for". **The observable is the ROUTING RECORD, not the companion
log**, and two probes were spent finding that out: receipt-required mode refuses
an arbitrary `ACP_CMD` at the receipt stage before any config option is
negotiated, so the log is byte-identical with and without an ambient
`ACP_REASONING_EFFORT`. `dispatch-routing/<task-id>.json` is written before
that, and `ROUTING_ENV_KEYS` is what a resume is rebuilt from — an inherited
effort outlives the dispatch that inherited it. Three mutations, three distinct
red sentences: strip `env -u`, hardcode `ACP_MODEL`, hardcode
`ACP_EXPECT_MODEL`. The existing documented-command guard was widened from two
seats to three in the same commit; it had never covered AGY.

### Batch THREE, and the P1 in it is this release's own regression

Pushing the batch-2 fixes produced three more findings (2026-08-22 05:16Z).
All three premises verified by reading the source. One is **P1 and it was
caused by the fix for #9**:

- **`loop-runner.mjs` `childEnv` — 3835247721.** The shape guard dropped EVERY
  ambient `ACP_*`, which closed six doors and also closed four the loop's own
  `SKILL.md:461,466` invites an operator to open. **A loop launched with
  `ACP_HARD_TIMEOUT_SEC` ran with no wall-clock ceiling at all and said
  nothing**; `ACP_STALL_POLICY`, `ACP_CANCEL_GRACE_MS` and
  `ACP_PROCESS_KILL_GRACE_MS` went the same way. `tests/loop-smoke.test.mjs`
  supplies all four and never checked one arrived. **DONE** `1a4c83b`.
- `acp-lanes-mcp.mjs:724` — crossing `OUT_CAP` returns and never settles, so a
  probe that finished rides the 20s deadline and is reported `probe_timeout`:
  a confidently wrong diagnostic. **With `fix3-lanes`.**
- `acp-companion.mjs` terminal — finalizes on `'exit'` rather than `'close'`,
  so `wait_for_exit` can release before the last output lands. **With
  `fix3-companion`.**

**The fix for the P1 is two CLASSES, not a longer list.**
`LOOP_FORWARDED_ACP_CONTROLS` is the operator surface the skill declares;
everything else is the runner's. The criterion is the documented promise, not
harmlessness — a leaked `ACP_STALL_POLICY=report` really does weaken a brake
and is forwarded anyway, because the skill says an operator may set it.
Deny-by-default with a named exception is fail-CLOSED for a knob nobody has
classified; the bot's own first suggestion (filter the dangerous classes) is
fail-OPEN for every name added after today. **The list does not rot because a
second test reads the companion's own source and refuses any `ACP_` name in
neither list — scanning TWO patterns, because `ACP_MODEL` and
`ACP_REASONING_EFFORT` arrive through `requestedConfigOverride` and a
one-pattern scan misses both while reporting full coverage.**

### What #9 turned out to be, because it is this release's lesson

The bot named ONE variable. Writing the test as the SHAPE — no ambient `ACP_*`
survives `childEnv` — found **five more in one run**: `ACP_MODEL`,
`ACP_EXPECT_MODEL`, `ACP_REASONING_EFFORT`, `ACP_RESUME`,
`ACP_SESSION_OPERATION`. The model pair inverts a sentinel: `modelEnv()` returns
`{}` for `INHERIT_ACCOUNT_DEFAULT`, whose entire meaning is "request nothing",
so a leaked ambient `ACP_MODEL` made exactly that seat request something the
graph never declared — and the identity check certified it `matched`.

### v0.34.0, on its own branch

All four items committed. Agent Plugins 1.0 closed as a DECISION, not a move
(ADR 0008): the manifest already conformed on every field, and the layout cannot
because the installed Claude Code binary contains no `agent-plugins.org` string
at all — moving `.claude-plugin/` into a reverse-domain namespace would satisfy
1.0 and make the plugin uninstallable. `show-me` removed. One `pm-delegation`
skill covering a single delegation and a whole autonomous spec run.

**`feat/v0.34.0` has already taken `feat/v0.33.0`'s fixes by merge once. Anything
landing on the release branch from now on must be merged in again**, or those
skills sit on bytes with defects this release already found.

### OPEN, found by reading and deliberately not fixed in v0.33.0

~~**A released terminal whose descendant does not hold the pipe still escapes
the teardown sweep.**~~ **CLOSED** — round eleven blocked on it, correctly:
  `SKILL.md` promises complete group reaping, so this was a broken promise
  rather than an open gap. All three sites ask `isGroupGone` now. Kept below for
  the reading it took, because the report that raised it was WRONG about the
  code and half a correct finding sends a reader to the wrong line.

  The original entry, for that lesson: Reported by a subagent with a premise that is WRONG as
written — it said `releaseTerminal` deletes the moment `exitStatus` is set,
"even though a descendant sharing its process group can still be alive". Read
the code: `acp-companion.mjs:3365-3380` already closed the case it describes,
and keeps a still-live terminal in the map on purpose, with the reason in a
comment. The residual hole is narrower and real:

- a descendant spawned `stdio: 'ignore'` does NOT hold the wrapper's pipe, so
  `close` fires, `exitStatus` is set, and `acp-companion.mjs:3381` deletes the
  entry — after which `killAllLiveTerminals` (`:3444`) cannot see it;
- the 2000ms `ACP_TERMINAL_CLOSE_GRACE_MS` fallback sets `exitStatus` anyway
  even when the pipe IS held, so the window closes on a timer either way;
- `settleTerminalExit` (`:3071`) has the same shape via `term.released`.

The correct check is group liveness, not `exitStatus`. Not fixed here because
Master scoped this round to the two third-batch P2s, and the terminal
capability only exists on the login route nobody has completed. **Verify the
premise yourself before acting — the report that raised it was wrong about the
code, and half a correct finding sends a reader to the wrong line.**

**An unreproduced red.** A subagent saw `finish() does not settle until a killed
child has actually exited` (`tests/acp-lanes-mcp.test.mjs`) fail once, in a
full-file run, before it had touched anything. This caller could not reproduce
it: 3/3 green alone at load average 7.3, 2/2 green over the whole file, 2/2
green in the full suite. **OPEN and unreproduced, not closed** — this file's own
rule is that a failure there is never noise, and the clause that called an
`acp-companion.test.mjs` failure a timing flake was false for an unknown number
of releases.

### Round TWELVE answered TEAM_DONE on `9282868`

`codex-advisor` at `gpt-5.6-luna[max]`, `identity_status: matched`, run
2026-08-22. Four voices, **no named ship-blocking defect**, and one condition
that binds the RELEASE RECORD rather than the code:

> DONE only for bounded claims; BLOCKED for any release note that implies live
> Claude Max login, real MCP/provider reachability, or a three-family panel that
> I did not verify.

The drafted notes (`scratchpad/release-notes-v0.33.0.md`) already carry all
three as open, and the Gate line records `1/1` with the owner's 2026-08-19
waiver plus the fact that `gate-required.mjs` answers REQUIRED. **Do not tidy
any of that away.** A voice also declined to resolve the owner-policy
disagreement between the script's REQUIRED and the owner's sufficient-alone
decision, and was right not to: both are recorded, neither overrides the other.

### Round ELEVEN answered BLOCKED, and what that cost

The review of record read the post-round-ten delta at `06bc493` and answered
**BLOCKED** with four voices and six findings, none of them laundered into
consensus. All six are in, plus a seventh its own dispatch exposed.

**The one worth reading is that the call site was never proved.** The `childEnv`
test proves the FUNCTION and stays green if `dispatch` stops calling it — which
is exactly how the P1 it answers reached a release. There is now a call-site
test (`tests/loop-runner-palette-dispatch.test.mjs`, "the operator bounds an
ambient shell sets arrive at a real dispatched worker") and unwiring `childEnv`
from `dispatch` turns it red. **This repository has written that rule down three
times and broken it again anyway.**

**The classification criterion was circular and is replaced.** "Is it
documented" makes a knob owned because nobody wrote it down, and nobody writes
down a knob that is owned. It is now **bound versus widen** — a control that
BOUNDS what a lane may do is the operator's and is forwarded; anything that
WIDENS what a lane can reach, or changes who it is, is the runner's.
`ACP_ENV_PASSTHROUGH` proved the old rule wrong twice over: undocumented in any
SKILL.md AND genuinely an operator control by the companion's own comment. It
stays owned, now with a reason. Six controls are forwarded and both contracts
are declared in `plugins/tmux-teams/skills/tmux-teams/SKILL.md`.

**Finding 15 is CLOSED and it was blocking, not deferrable** — the lane found
what this file's own entry had missed: `SKILL.md` promises "Every terminal path
closes and reaps the complete detached process group", so it was a promise the
code broke rather than a gap left open. All three sites ask `isGroupGone` now,
and the mutation matrix is 1:1:1.

**Three tests written this round were green against the defect they were written
for**, and each is recorded inside itself: the computed-read assertion claimed
there were no computed reads (there are four), the call-site test asserted
absence for keys `dispatch` legitimately re-supplies, and the finding-16 guard
matched a derivation line in a preamble instead of the assignment that reaches
the dispatch. **Write the mutation before believing the test.**

### Finding 16 — the review of record's own command could not run

Dispatching round eleven failed at `invalid_execution_profile: required Codex
execution requires an absolute CODEX_PATH`. `codex-advisor/SKILL.md` omitted it
— the third seat of three to have that gap, after `agy-advisor`/`AGY_BIN` earlier
this release, and the only one the release gate depends on. **Found by running
the command, not by reading it.**

The runtime guard cannot reach that branch: it dispatches worker `mock` with an
`ACP_CMD`, and the requirement lives behind
`agentName === 'codex' && !process.env.ACP_CMD`. The new guard is static, reads
the requirement out of the companion's own error sentences, and **pins which
seats it covers** — deleting `AGY_BIN` from the agy command does NOT red it, and
a reader who assumed otherwise would be wrong.

## 4. DO NOT

- **Do not read the review bot's BODY and call it a verdict.** It is boilerplate
  either way. The findings are inline comments carrying P2 badges. This session
  read the body twice and reported "no suggestions" twice while 26 sat unread.
  `gh api repos/iicmaster/tmux-teams/pulls/71/comments --paginate`
- **Do not assume a triage stays current.** The bot writes NEW findings on every
  push. 26 were triaged, fixed and pushed — and 12 more appeared, of which 12 of
  12 survived. Re-list by `created_at` before merging.
- **Do not fix the variable that was named.** Three doors of one shape were
  closed one round apart, each fix naming the reported variable. Write the guard
  as a shape and the test as a shape.
- **Do not mistake a stream listener for an Interface listener.** Node FORWARDS
  an input stream's `'error'` onto a readline Interface; `input.on('error')` does
  not cover it. Measured — the process still dies with the listener present.
- **Do not use `git checkout -- <file>` to undo a mutation.** It restores the
  COMMITTED version and eats uncommitted work. Three times in one session.
- **Do not run the suite beside ACP lanes or parallel agents.** The same bytes
  ran 66s quiet and 723s loaded; two tests fail under contention and pass alone.
- **Do not let a subagent run the full suite.** Give it the focused file; the
  caller measures once.
- **Do not push a release to `main`.** See DECIDED.

## 5. DECIDED — DO NOT RELITIGATE

- **The review of record is `codex-advisor` at `gpt-5.6-luna`, effort `max`, and
  it alone is sufficient.** Master, 2026-08-19. `gate-required.mjs` is
  fail-closed and reads no waiver, so it answers REQUIRED forever — report that
  as a fact, never as a veto.
- **All twelve second-batch findings are fixed before v0.33.0 ships.** Master,
  2026-08-22, asked directly whether to ship on ship-blocking only.
- **Both third-batch P2s are fixed before the merge too.** Master, 2026-08-22,
  asked with the alternative of carrying them to v0.34.0 spelled out.
- **`TEAM_BLOCKED` is fixed in the outer controller's BRIEF, not by
  restructuring the routing.** Master, 2026-08-22.
- **`pm-delegation` is one skill, not two** — subagents OR ACP lanes, and it does
  not feed the delivery loop. Master, 2026-08-22.
- **Spec and tickets are files in the repository**, not GitHub issues. Master.
- A release ships as a pull request; merge needs CI green plus the
  `chatgpt-codex-connector` review. Only Master waives, in writing, per release.
- Remaining closed decisions: `plugins/tmux-teams/docs/adr/` 0001–0008.

## 6. UNPROVEN

- **Nobody has completed a real Claude Max login.** `terminal/kill` has no test.
- **No real MCP host has initialized the shipped server**, and the live probe has
  never contacted a real provider.
- **Round ten's CLEAR was measured on `331d218`.** Everything after it — the
  untracking, the shape guard, the brief — has not been read by that lane.
- **The two subagents' work was unverified by this caller.** Their counts are
  their own until someone runs the mutations.
- **Whether the bot ever stops producing findings is still unknown, but the
  rate IS falling.** Counted by `created_at` rather than by memory: 26, then 12,
  then 3 — 41 raised in total. This file said "the rate did not fall" after two
  batches; a third made that false. **There is no push-free path to a merge, so
  every merge decision is taken on a batch the bot has not yet answered.** That
  is a standing property of this loop, not a thing to wait out.
- **Line numbers here were resolved 2026-08-22.** Re-grep the symbol.

## 7. WHERE THINGS LIVE

```
ROADMAP.md                                the standing goal; v0.34.0 scope
CLAUDE.md                                 the rules with their measurements
plugins/tmux-teams/docs/adr/              closed decisions, 0001 through 0008
plugins/tmux-teams/skills/                the shipped skills
plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs     the loop, childEnv
plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs   the ACP leg
plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs    the dispatcher
plugins/tmux-teams/skills/tmux-teams/scripts/role-briefs.mjs     the agent briefs
plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs   the MCP server
scripts/gate-required.mjs                 does this release owe a panel
scripts/roadmap-gate.mjs                  is the published page behind its source
scratchpad/bot-findings-batch2.md         the twelve, in full
scratchpad/release-notes-v0.33.0.md       drafted from the real git log
scratchpad/wt34/                          the v0.34.0 worktree
~/.npm/_npx -> /Volumes/KINGSTON/...      the ACP adapter lives on a USB volume
```
