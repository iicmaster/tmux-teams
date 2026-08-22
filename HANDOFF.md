# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-22 through `bmad-party-mode`.

## 1. READ THIS FIRST

- **TWO branches are live.** `feat/v0.33.0` (the release, PR #71) and
  `feat/v0.34.0` (finished work, branched from it). Neither is merged. `main` is
  at v0.32.0.
- **The review of record answered CLEAR on round ten — and v0.33.0 is NOT ready
  to merge.** After that verdict the PR review bot's inline comments produced
  twelve more findings and **all twelve survived adversarial verification**.
  Three are fixed, eight are with subagents, two are untouched. Do not read
  "round ten cleared it" as "ship it".
- **Two subagents were running when this was written**, each in its own
  worktree, each owning one file: `fix2-lanes` on `acp-lanes-mcp.mjs` + its
  test, `fix2-companion` on `acp-companion.mjs` +
  `tests/acp-terminal-capability.test.mjs` + `tests/fixtures/mock-acp-agent.mjs`.
  If the session ended before they reported, their work is UNCOMMITTED in
  `.claude/worktrees/`. Look before redoing it.
- `feat/v0.33.0` is **2 commits ahead of origin** — push before anything else.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
```

Green on `feat/v0.33.0` at `c045beb` is exactly:

```
ℹ tests 1164
ℹ pass 1160
ℹ fail 0
ℹ skipped 4
```

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
| 1 | `realProbeTransport` reaps only the wrapper pid, never descendants | `fix2-lanes` |
| 2 | `QUOTA_SIGNAL` misses the underscored `rate_limit_exceeded` | `fix2-lanes` |
| 3 | a malformed `session/prompt` result classifies as reachable | `fix2-lanes` |
| 4 | the stdout `'error'` handler swallows and never settles | `fix2-lanes` |
| 5 | terminal descendants survive a wrapper's exit | `fix2-companion` |
| 6 | `terminal/kill` does not escalate past SIGTERM | `fix2-companion` |
| 7 | a non-array `args` is not rejected | `fix2-companion` |
| 8 | login input broadcasts to every terminal | `fix2-companion` |
| 9 | `childEnv` forwarded ambient `ACP_*` | **DONE** `6ac3fbc` |
| 10 | `TEAM_BLOCKED` reached an agent defaulting to `resume` | **DONE** `c045beb` |
| 11 | agy-advisor command hardcodes the model, ignoring its alias argument | **DONE** |
| 12 | agy-advisor command never clears inherited `ACP_REASONING_EFFORT` | **DONE** |

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
- **Whether the bot ever stops producing findings is unknown.** Two batches, 38
  raised, 27 confirmed. The rate did not fall.
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
