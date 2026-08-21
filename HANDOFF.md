# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-21 through `bmad-party-mode`.

## 1. READ THIS FIRST

- Branch `feat/v0.33.0`, **pushed** to `origin` (`iicmaster/tmux-teams`).
  `main` is at v0.32.0 (`6b95101`) and owes nothing.
- Tree is clean. Version is `0.33.0` in all seven places.
- Pull request **#71** is open. CI was red on whitespace and that is fixed.
- **THERE ARE TWO REVIEWERS AND ONLY ONE OF THEM IS OBVIOUS.** The PR review
  bot's findings are INLINE COMMENTS, not the review body — the body is
  boilerplate that says nothing either way. This session read the body twice,
  reported "no suggestions" twice, and was wrong twice: 26 findings were sitting
  there, 15 of them real, three ship-blocking. Read them with
  `gh api repos/iicmaster/tmux-teams/pulls/<n>/comments`, never by opening the
  review.
- **The review of record answered BLOCKED six times running before it cleared
  on the seventh** — on bytes that passed every automated gate every time.
  Twenty-six findings, in rounds of 8, 4, 6, 4, 3, 1, then `TEAM_DONE`. Rounds
  two through four found defects in the previous round's FIXES rather than in
  untouched code; round five found the first real RUNTIME defect, in a validator
  this release had itself extended; round six found the second door of a leak
  round five had closed at the first. **Do not read "the suite is green" as
  "this is ready" — it was green for all twenty-six.**
- **Editing `ROADMAP.md` makes the published page stale.** Run
  `node scripts/roadmap-gate.mjs` and believe THAT, not a status written here:
  this file said "answers 2 (STALE)" and was wrong within the hour, because the
  page was republished right after. A handoff must not quote the value of a gate
  a reader can run in a second.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
```

Green on 2026-08-21, measured on this branch, is exactly:

```
ℹ tests 1141
ℹ pass 1137
ℹ fail 0
ℹ skipped 4
```

**And green in YOUR shell is not green.** On 2026-08-21 the PRE-fix bytes
measured 1137/1131/**2**/4 in a shell carrying ambient `ACP_*` variables — the
state any shell is in after running a dispatch by hand. Four separate test files
kept their own hand-written list of variables to scrub and every one was missing
something; they scrub by `ACP_*` prefix now, and the hostile shell measures
1141/1137/0/4 like the friendly one. Keep verifying with it, because the
friendly one already agreed with you:

```bash
ACP_MODEL=ambient ACP_EXPECT_MODEL=ambient ACP_REASONING_EFFORT=ambient \
ACP_SPAWN_NONCE=ambient-nonce ACP_ENABLE_TERMINAL=1 ACP_AGENT_ID=ambient-agent \
ACP_SESSION_OPERATION=new ACP_SESSION_RECEIPT_REQUIRED=1 node --test
```

**`node --test | grep '✖'` exits 0 when it FINDS failures.** Chaining a commit
after it with `&&` commits on red. Gate on the count.

**A background `node --test ...; grep ...` reports the GREP's exit code.** On
2026-08-21 a red suite arrived as `exit code 0` in the task notification.

**`git diff --check` with no range reads the working tree only.** CI reads
`$PR_BASE_SHA...HEAD`, so whitespace committed earlier on the branch is
invisible locally and CI is the first thing to see it — which is what happened.
Use the range:

```bash
git diff --check main...HEAD          # what CI actually checks
claude plugin validate --strict .
node scripts/gate-required.mjs        # 0 exempt · 2 panel required · run AFTER committing
node scripts/roadmap-gate.mjs         # 0 current · 2 published page is behind
```

The 4 skips are the bwrap set skipping itself off Linux. **A skipped test is an
unexecuted guard, not a passing one.**

## 3. STATE

### v0.33.0, eight items, seven shipped

`ROADMAP.md` carries the table and the reasoning. In short: `agy-advisor`; the
comment diet; one advisor contract across all three `*-advisor` lanes; the
prohibited model refused at dispatch; a live lane-health preflight as a third
MCP tool; `blocked` escalating instead of re-dispatching; `belongsToThisRun`
proving identity rather than recency. **Item 5, the Claude Max login, is HALF**
— the terminal capability and all five `terminal/*` methods are implemented and
gated behind `ACP_ENABLE_TERMINAL=1`, and **nobody has completed a real login
through it.**

### The six guards that nothing called

Every one was real, sensible, and unheld by any test that would notice its
removal. Each now has one, and each was proved by deleting the call site:

| guard | test | with the call deleted |
|---|---|---|
| malformed `ACP_SPAWN_NONCE` (`acp-companion.mjs:65`) | `tests/acp-dispatch.test.mjs:562` | 67/2 |
| invalid `ACP_ENABLE_TERMINAL` (`acp-companion.mjs:98`) | `tests/acp-terminal-capability.test.mjs:123` | 67/2 |
| `belongsToThisRun` at admission (`acp-dispatch.mjs:803`) | `tests/acp-dispatch.test.mjs:1778` | 63/2 |
| `belongsToThisRun` in `watchBoot` (`acp-dispatch.mjs:1033`) | `tests/acp-dispatch.test.mjs:1957` | 63/2 |
| child-side prohibited model (`acp-companion.mjs:1469`) | `tests/acp-dispatch.test.mjs:528` | 65/1 |
| terminal output cap + UTF-8 tail (`acp-companion.mjs:3000`) | `tests/acp-terminal-capability.test.mjs:149` | 6/1, on two separate edits |

`belongsToThisRun` is at `acp-dispatch.mjs:990`; `PROHIBITED_MODEL` at
`acp-dispatch.mjs:705`; the blocked→escalate branch at `loop-runner.mjs:1549`;
the login-mode stdin bridge at `acp-companion.mjs:3034`.

### Open, off this branch

- **Nobody has completed a real Claude Max login.** A person at a real terminal
  has to do it. `terminal/kill` is implemented and no test calls it.
- No real MCP host has ever initialized the shipped server, and the live probe
  transport has never met a real provider.
- The nonce closes forgery for lanes THIS dispatcher started. A record with no
  routing file — what `loop-runner.mjs` produces — still passes on bounds
  alone, deliberately.
- Full open list with measurements: `ROADMAP.md`, "What is actually open".

## 4. DO NOT

- **Do not read a red mutation as proof the named call was reached.** The
  prohibited-model test went red when either call site was deleted — but
  `ACP_EXPECT_MODEL` falls back to the requested model, so deleting the
  `ACP_MODEL` check alone was caught by its neighbour and the test failed only
  over the error LABEL. It took a review lane running the mutation itself to
  see that. Isolate the call site: prohibited request, PERMITTED expectation.
- **Do not mistake a closed set of key NAMES for a closed contract.**
  `validateAcpLivenessV1` (`pulse-data.mjs`) admitted `work_observed` and
  `spawn_nonce` to its key set in v0.33.0 and gave neither a type. Measured: the
  STRING `'false'` was accepted, and `loop-runner.mjs` compares
  `work_observed === false`, so a truthy string read as work observed and the
  plan came back `expired` — withdrawing a delivery that should have been held
  for a person. An object `spawn_nonce` was accepted too, and it is compared for
  equality against a string. Both are typed now, each with its own negative.
- **Do not assume a spawner forwards only what it means to — and there are TWO
  of them.** `spawnDetached` (`acp-dispatch.mjs`) and `childEnv`
  (`loop-runner.mjs`) each spread the whole caller environment, so an ambient
  `ACP_ENABLE_TERMINAL=1` reached the companion and handed an ordinary lane —
  a review lane included — the terminal capability the companion's own comment
  says no ordinary caller may grant. Both are closed. **The second one stayed
  open for a whole review round because this file already said "after fixing a
  leak, go and look for the same shape somewhere else" and nobody did.**
  The reason dropping it costs nothing is asserted rather than described: both
  children are spawned with `stdin: 'ignore'`, so such a terminal could never
  receive a keystroke and could not serve the login it exists for.
  Guarded at BOTH levels, and the second one is the point: deleting the
  `childEnv()` CALL from `dispatch` leaves the function-level test green and
  turns only `the real dispatch path hands no terminal capability to a worker`
  red. Measured 2 fail / 1 fail on the two mutations.
- **Do not assume the file a release ADDED has been reviewed.** Seven review
  rounds read `acp-dispatch.mjs`, `acp-companion.mjs`, `loop-runner.mjs` and the
  documents. `acp-lanes-mcp.mjs` — the MCP server v0.33.0 introduced — was never
  opened by any of them, and eight of the fifteen confirmed bot findings were in
  it, including both unhandled-EPIPE crashes. **New code is the least-reviewed
  code, not the most.**
- **Do not fix one cleanup path and stop.** `tests/loop-smoke.test.mjs` has two
  tests that delete every ambient `ACP_*` key from THIS process; round three
  fixed the restore in one and round four found the same shape in the other,
  reproduced by observing the parent process after the test. There is a sentinel
  in `after()` now that goes red for either. **After fixing a leak, go and look
  for the same shape somewhere else.**
- **Do not fix a hand-maintained list by adding the missing name.** Round two
  added `ACP_SPAWN_NONCE` to one scrub list and left `ACP_ENABLE_TERMINAL`
  missing from the same list — a second omission introduced by the same
  release. Four files each had their own list. Scrub by prefix.
- **Do not use `git checkout -- <file>` to undo a mutation.** It restores the
  COMMITTED version and eats uncommitted work. Three times in one session.
  `cp` to `/tmp` first, or commit first, and read the file back afterwards.
- **Do not edit files while a review lane is reading the tree.** It reads a
  static range; a mid-run edit means it judges bytes that no longer exist. The
  round-one lane noticed an uncommitted change and said so in its report.
- **Do not blame the code when an ACP lane answers `execution_profile_drift`.**
  `~/.npm` is a symlink to `/Volumes/KINGSTON/DeveloperCaches/npm`, an external
  USB volume, while `npm config get cache` answers `~/.kingston-cache/npm`. When
  the volume is not there the pinned adapter is not there, and the refusal is
  correct. Repopulate with `npx -y @agentclientprotocol/codex-acp@1.1.7
  --version` — **in the background**, it hung past two minutes once.
- **Do not run the suite beside ACP lanes or parallel agents.** Measured:
  `tests/loop-smoke.test.mjs:189` failed a 20s outbox deadline in a 225s loaded
  run and passed in a 136s quiet one; `required load binds every prior identity`
  failed at 12.9s under load and passes at 3.4s alone. Serialise measurements
  through one caller.
- **Do not fan out subagents that each run the suite.** Have them return a diff
  that applies by string match plus the commands the caller runs once. That is
  what the three subagents on 2026-08-21 did, and it worked.
- **Do not push a release to `main`.** See DECIDED.
- **Do not `rm -rf` an ACP run directory before recording its session id.**

## 5. DECIDED — DO NOT RELITIGATE

- **The review of record is the `codex-advisor` ACP lane at `gpt-5.6-luna`,
  effort `max`, and it alone is sufficient.** Master, 2026-08-19. Its
  `effective_identity` goes in the release notes the way a panel lane's would.
  `scripts/gate-required.mjs` is fail-closed and does not read that decision, so
  it still answers REQUIRED and the record has to live in documents.
- **A release ships as a pull request; merge needs CI green plus the
  `chatgpt-codex-connector` review.** Master, 2026-08-16. Only Master waives it,
  in writing, per release. **A waiver written for one release does not carry to
  the next.**
- **The MCP server reads credentials and never returns them.** Master, 2026-08-16.
- **The advertised model is a claim, not evidence.** Master, 2026-08-16.
- **AGY runs `gemini-3.7-flash-high`.** Master, 2026-08-16.
- **ADR 0003 stands: a dispatched agent receives no MCP server.**
- **Implementation is dispatched to Sonnet subagents; codex at `gpt-5.6-luna`
  reviews.** Master, 2026-08-19.
- Remaining closed decisions: `plugins/tmux-teams/docs/adr/` (0001–0007) and
  "Decisions that are not up for re-litigation" in `ROADMAP.md`.

## 6. UNPROVEN

- **Nobody has completed a real Claude Max login through the new capability.**
  The terminal methods are exercised against a mock agent, never a real adapter.
  `terminal/kill` is not exercised at all.
- **No real MCP host has initialized the shipped server**, and the live lane
  probe has never contacted a real provider.
- **The nonce bypass was reasoned about, not exploited.** The routing-less path
  is accepted on bounds alone by choice; nobody has demonstrated an attack on it.
- **`~/.npm/_npx` was found empty between two dispatches and the external-volume
  explanation is inference, not proof.** Nothing was observed deleting it.
- **The one-off `required load binds every prior identity` failure at 12.9s is
  attributed to contention on the strength of a 3.4s isolated pass and one clean
  repeat.** The review lane could not reproduce it either and said so.
- **The four bwrap tests have never run on this machine.** They skip.
- **Line numbers here were resolved 2026-08-21.** They rot. Re-grep the symbol.

## 7. WHERE THINGS LIVE

```
ROADMAP.md                                        the standing goal; phases and what is open
CLAUDE.md                                         the rules, with the measurements behind them
plugins/tmux-teams/docs/adr/                      closed decisions, 0001 through 0007
plugins/tmux-teams/skills/                        the shipped skills — this repo is their source
plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md   the one SSOT
plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs             the operator's entry to a lane
plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs            the ACP leg
plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs              the loop
plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs            the MCP server
plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs          lane definitions
scripts/gate-required.mjs                         does this release owe a panel
scripts/roadmap-gate.mjs                          is a published page behind its source
scripts/roadmap-render.mjs                        source to page, deterministic
tests/acp-dispatch.test.mjs                       detachment, admission, status, wait, the nonce
tests/acp-companion.test.mjs                      the ACP leg, receipts, execution profile
tests/acp-terminal-capability.test.mjs            the terminal capability and its output cap
tests/acp-lanes-mcp.test.mjs                      the MCP server
tests/loop-occupancy.test.mjs                     slot accounting and the controller brakes
tests/plugin-structure.test.mjs                   RELEASE_VERSION and the shipped tree
~/.config/claude-profiles/<lane>/settings.json    per-lane provider config, mode 600
```

Narrative history lives in `CLAUDE.md`, the ADRs and `ROADMAP.md`. This file
carries only what is true right now.
