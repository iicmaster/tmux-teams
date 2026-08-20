# HANDOFF

Written through `bmad-party-mode` (installed; John, Sally and Grumbal
mandatory), 2026-08-21.

## 1. READ THIS FIRST

- Branch `feat/v0.33.0` at `eb40d51`, 17 commits ahead of `main`. Tree clean.
- **NOT PUSHED. `git ls-remote origin feat/v0.33.0` returns nothing.**
- **The most dangerous thing: this branch exists in exactly one place —
  `/Users/ngs/agent-skills/plugins/tmux-teams` (the submodule's git dir). The
  worktree it was built in, `<scratchpad>/wt`, VANISHED once mid-session and had
  to be recreated with `git worktree add`. The commits survived because they
  were committed. Push before doing anything else you care about.**
- Version is still `0.32.0` everywhere. No bump has happened.
- `node scripts/gate-required.mjs` exits 2 and `node scripts/roadmap-gate.mjs`
  exits 2. Both are owed and both are expected — see §5.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
```

Green is exactly:

```
ℹ tests 1131
ℹ pass 1127
ℹ fail 0
ℹ skipped 4
```

The 4 skips are the bwrap set skipping itself off Linux. **A skipped test is an
unexecuted guard, not a passing one.**

**Gate on the count, never on a grep.** `node --test | grep '✖'` exits 0 when it
FINDS failures, so chaining a commit after it with `&&` commits on red:

```bash
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

**Do not put the bare suite under a command timeout below ~15 minutes.** Run it
detached and read the log. Measured 2026-08-21: a 600s cap produced
`✖ tests/acp-companion.test.mjs (599949ms)` — the cap killed it, the file was
fine, and the same run uncapped finished 1131/1127/0/4 with exit 0. That number
is the timeout, not a defect. This file has been wrongly called a flake before,
so measure until you have the explanation rather than either dismissing it or
believing it.

Other gates:

```bash
git diff --check                  # whitespace
claude plugin validate --strict . # manifests
node scripts/gate-required.mjs    # 0 exempt · 2 panel required — run AFTER committing
node scripts/roadmap-gate.mjs     # 0 current · 2 published page is behind ROADMAP.md
```

## 3. STATE

### Shipped on this branch (all measured, all with a test that a mutation kills)

- **A third advisor seat, `agy-advisor`** —
  `plugins/tmux-teams/skills/agy-advisor/SKILL.md`. Measured before it was
  written: the lane accepts `INITIAL_AGENT_MODE=read-only`,
  `ACP_SESSION_RECEIPT_REQUIRED=1`, `ACP_SESSION_OPERATION=new`, writes a
  receipt, and reports `effective_identity: gemini-3.7-flash-high (matched)`.
- **One advisor contract across all three lanes**, asserted by
  `tests/plugin-structure.test.mjs:733`. The guard that checks advisor command
  blocks used to match the workers `codex|claude` only, so a new advisor's
  commands matched NOTHING and would have shipped unguarded.
- **Gemini 3.1 refused at dispatch, not only on the profile pin.** Three copies
  of the pattern, all character-identical and asserted so:
  `review-profiles.mjs:226` (owner), `acp-companion.mjs:1459`,
  `acp-dispatch.mjs:705`. The dispatcher refuses inside `spawnDetached`
  (`acp-dispatch.mjs:716`) BEFORE anything is spawned. Tests:
  `tests/acp-dispatch.test.mjs:2396` (behaviour),
  `tests/review-policy.test.mjs:737` (drift across the three copies).
- **`blocked` escalates instead of re-dispatching** —
  `loop-runner.mjs:1549`. Test `tests/loop-occupancy.test.mjs:1744`. The
  matching refusal wording is `pull-controller.mjs:70`.
- **`belongsToThisRun` proves identity, not just recency** —
  `acp-dispatch.mjs:990`. The dispatcher mints a nonce, passes it as
  `ACP_SPAWN_NONCE`, records it as a TOP-LEVEL `spawnNonce` in the routing JSON
  (deliberately NOT in `env`, so a printed resume command never echoes it), and
  the companion echoes it back as `spawn_nonce`.
- **`validateAcpLivenessV1` accepted zero real snapshots** —
  `pulse-data.mjs:128` omitted `work_observed`, which the companion writes into
  every snapshot, so `pulse.mjs` threw on all of them. Measured on 7 real files
  from a full loop run: 0/7 passed before, 7/7 after. Test
  `tests/loop-smoke.test.mjs:302` validates what a REAL companion wrote.
- **A live lane-health probe, `acp_lane_probe`** —
  `acp-lanes-mcp.mjs:743`, real transport at `acp-lanes-mcp.mjs:479`, exercised
  against a stub agent by `tests/acp-lanes-mcp.test.mjs:2024`. ADR 0007 was
  amended in the same commit because the probe contacts an endpoint, which that
  ADR forbade.
- **The comment diet** on the two files v0.32.0 shipped:
  `acp-dispatch.mjs` 51% comments → 44%, `acp-lanes-mcp.mjs` 45% → 42%, net 213
  lines cut. Criterion: keep the RULE and the TRAP, cut the ARCHAEOLOGY (who
  found it, in which round, on what date — all of it already in `git log`).

### Half done, and the missing half is the one a user cares about

- **The `claude` lane still cannot reuse a Claude Max login.** The companion now
  advertises the ACP terminal capability behind `ACP_ENABLE_TERMINAL=1`
  (`acp-companion.mjs:97`) and serves all five terminal methods; the ordinary
  path advertises nothing new and refuses a terminal request. **Nobody has
  completed an actual login through it** — that needs a person at a terminal.
  The issue's other half, a structured blocker when an unauthenticated ordinary
  lane hits `-32000`, is untouched.

### Not started

- The release sequence for v0.33.0: bump seven places, render/publish/record the
  roadmap, PR, merge, tag the merged sha, move the submodule pin in
  `~/agent-skills`.

## 4. DO NOT

- **Do not `git checkout -- <file>` to undo a mutation test.** It restores the
  COMMITTED version and silently deletes uncommitted work. It happened THREE
  times in one session: it ate an uncommitted `export` (the test file then
  failed to import and a whole 53-test file vanished from a run that still
  reported a tidy total of 1044), it ate a source edit while the commit message
  describing that edit went out anyway, and it ate an entire test-guard
  extension minutes after the second one was written down. `cp <file> /tmp/x.bak`
  before, `cp /tmp/x.bak <file>` after — or commit first.
- **Do not trust a mutation that removes ONE of two redundant guards.** Removing
  only `assertPermittedModel(env.ACP_MODEL, …)` from `acp-dispatch.mjs:716`
  leaves the suite green at 62/0, because the `ACP_EXPECT_MODEL` line catches
  the same fixture. Removing both is 61/1. A redundant guard hides a mutation.
- **Do not write a test that greps source text for the guard it is testing.**
  The first prohibited-model test did exactly that; a reviewer replaced the
  condition with `if (false)` and the full suite stayed green at
  1113/1109/0/4. A source grep proves a string is present, never that anything
  happens.
- **Do not name a test fixture after the word the test asserts.** The fixture
  directory was `acp-prohibited-*`, the dispatcher prints
  `run directory resolves to: <path>`, and a `/prohibited/` assertion was
  therefore satisfied by the FOLDER NAME. Caught only because the assertion
  failed on a model that was PERMITTED.
- **Do not assert an exit code you have not observed.** `acp-dispatch.mjs`
  dispatches successfully and does not exit 0; asserting `status === 0` failed
  on a lane that had dispatched perfectly.
- **Do not fan out subagents that each run `node --test`.** It spawns dozens of
  ACP subprocesses per pass. Recorded measurement: fifteen concurrent passes
  drove the load average to 28 on 8 cores and after 42 minutes not one agent had
  finished. Parallelise the reading and the design; serialise every measurement
  through one caller. Say it in the agent's prompt — every subagent this session
  was told not to run the whole suite, and none did.
- **Do not read the 256 KiB environment ceiling
  (`review-profiles.mjs:1029`) as a platform limit.** It is OUR policy: this
  machine spawned a 921,600-byte environment successfully. The refusal sentence
  says "over budget" for that reason, and `assertStartableEnvironment`
  (`review-profiles.mjs:1068`) says "cannot start a process" only for a NUL.
- **Do not delete the per-value ceiling (`review-profiles.mjs:1038`) as
  redundant with the total.** Linux caps a single environment string at
  `MAX_ARG_STRLEN` independently of the total, so a 200 KiB credential fits the
  total budget and fails on the CI host.

## 5. DECIDED — DO NOT RELITIGATE

All of these are Master's, not the room's.

- **2026-08-19 — the review seat is the `codex-advisor` lane at
  `gpt-5.6-luna`, effort `max`, and that alone is enough.** Nine rounds on
  `gpt-5.6-sol[max]` were still returning new findings each pass; changing seat
  found, in ONE round, a red bare suite that nine rounds of the other seat had
  never seen.
- **2026-08-19 — the three-family panel and the `chatgpt-codex-connector`
  review were both WAIVED for v0.32.0.** Recorded on that release's PR and in
  its notes. `gate-required.mjs` still answers REQUIRED and is right to: it is
  fail-closed and does not read waivers, which is exactly why the record lives
  in documents.
- **2026-08-19 — v0.33.0 scope, settled by asking rather than guessing.** The
  claude-login item is fixed the way its ISSUE names (advertise the terminal
  capability), not the way v0.32.0 measured (the adapter reads
  `~/.claude/.credentials.json` while the CLI reads the macOS Keychain — that
  stays recorded, not fixed). The lane-health preflight is a THIRD MCP TOOL,
  and amending ADR 0007 is part of the item. The identity item TAKES the
  protocol change.
- **2026-08-19 — delivery model.** Sonnet subagents implement in their own
  worktrees; `agy` and `codex` at `gpt-5.6-luna` review; this session drives and
  measures rather than typing the change.
- **2026-08-19, IRON RULE — write the task list before starting work, and run
  `sqthink` before each individual task.** Not one plan for the batch; one per
  task, at the moment that task starts.
- **2026-08-21 — reviews are dropped for now; get the main line through first.**
  The two review lanes were stopped. One had already answered before it was
  stopped, and its one code finding (the grep-not-a-test above) was acted on.

## 6. UNPROVEN

Every line here rests on reading or reasoning, not execution. Treat each as a
thing to verify, not a thing to build on.

- **Nobody has completed a Claude Max login through the new terminal
  capability.** Everything around it is tested; the login itself is not. Do not
  describe that lane as working.
- **The Linux `MAX_ARG_STRLEN` behaviour was never run on Linux.** The per-value
  ceiling is reasoned from the documented kernel constant and a reviewer's
  claim. macOS spawns the oversized value happily, so this machine cannot
  falsify it.
- **The nonce residual is reasoned, not exploited.** `acp-dispatch.mjs:990`
  states that forgery is closed only for a lane this dispatcher started, because
  routing-less liveness is deliberately accepted for `loop-runner`. Nobody has
  actually deleted a routing file to demonstrate the bypass.
- **`realProbeTransport` (`acp-lanes-mcp.mjs:479`) has never spoken to a real
  provider.** It is exercised against a stub. In particular its quota pattern is
  guessed at real provider wording; if it misses, an exhausted lane reports
  `unclassified` and no stub can tell you.
- **The comment diet is claimed to have cut nothing load-bearing.** One review
  lane read the cuts and agreed they were archaeology. That is one reader's
  reading, not a proof, and it is the change its author is least able to check.
- **The `agy` review lane produced no report at all** in the last round; only
  the `codex`/luna lane answered. Its silence is unexplained.

## 7. WHERE THINGS LIVE

```
ROADMAP.md                                        the standing goal, and the v0.33.0 scope table
plugins/tmux-teams/docs/adr/                      decisions not up for re-litigation
plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md   the one SSOT
plugins/tmux-teams/skills/tmux-teams/references/loop-graph-page.md        what graph.html may draw

plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs      dispatch, admission, liveness reads
plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs     the ACP leg
plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs       the tick
plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs        liveness projection and its closed key set
plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs     the operator's MCP server
plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs   lane profiles, env building, the model prohibition

tests/acp-dispatch.test.mjs        62 tests · dispatch, admission, boundaries, the prohibition
tests/acp-lanes-mcp.test.mjs       60 tests · the MCP server and the probe
tests/acp-companion.test.mjs      135 tests · run it detached, it is the slowest file
tests/plugin-structure.test.mjs    22 tests · SKILLS is the list of record; RELEASE_VERSION lives here
tests/review-policy.test.mjs       27 tests · profile policy and prohibition drift
tests/loop-occupancy.test.mjs     110 tests · the tick's refusals
tests/loop-smoke.test.mjs           2 tests · one real ACP route, real forked companions

scripts/gate-required.mjs          does this release owe the panel
scripts/roadmap-gate.mjs           is the published roadmap page behind its source
scripts/roadmap-render.mjs         ROADMAP.md -> docs/roadmap.html
```

Published roadmap page: `https://artifacts.ngs.bz/claude/private/tmux-teams-next-plan/`
(v20 at time of writing; `roadmap-gate.mjs` exits 2, so it is behind again).
