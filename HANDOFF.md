# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-16 through `bmad-party-mode`.

## 1. READ THIS FIRST

- Branch `feat/acp-lane-mcp`, pushed, 7 commits ahead of `origin/main`. Tree clean.
- `main` is at v0.31.0 — merged, tagged, GitHub release published, marketplace
  updated, submodule pinned in `~/agent-skills`. Nothing is owed on it.
- **The dangerous thing: the branch you are on was BLOCKED twice by a
  `codex-advisor` review and the third review has not been run.** No pull
  request is open for it. Do not open one and do not merge it until a
  `codex-advisor` lane reads `39b3d66` and clears it.
- A three-family panel passed these same bytes 3/3 with zero findings, twice,
  while the advisor was blocking them. The panel is not a substitute for that
  read — see DO NOT.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
```

Green here on 2026-08-16 is exactly:

```
ℹ tests 1013
ℹ pass 1009
ℹ fail 0
ℹ skipped 4
```

The 4 skips are the bwrap set skipping itself off Linux. **A skipped test is an
unexecuted guard, not a passing one.**

```bash
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

**`node --test | grep '✖'` exits 0 when it FINDS failures.** Chaining a commit
after it with `&&` commits on red. Gate on the count above, never on the grep.

```bash
git diff --check                              # whitespace
claude plugin validate --strict .             # manifests
node scripts/gate-required.mjs                # 0 exempt · 2 panel required · run AFTER committing
node scripts/roadmap-gate.mjs ROADMAP.md      # 0 current · 2 published page is behind
```

All three published pages answered `0` at `39b3d66`: `ROADMAP.md`,
`RELEASE-PLAN.md`, `references/event-subscriptions.md`.

## 3. STATE

### Shipped in v0.31.0 (on `main`)

- **An ACP lane's identity claim, recorded and never counted.**
  `acp-review-client.mjs:1429` builds `claimedIdentity`; `review-gate.mjs:399`
  carries it into the panel record. `provenFamilyKey` remains the only family
  evidence and nothing branches on the claim. `runnerSeeded` is set from the
  deed: `acp-review-client.mjs:1077` flags the settings write itself, and the
  env half reads `CLAUDE_MODEL_CONFIG`.
- **AGY moved to `gemini-3.7-flash-high`** — profile, test pins, and the model
  policy in `CLAUDE.md`. The adapter already advertised 3.7 while the profile
  pinned 3.6; the inert claim field is what surfaced it.
- **The seven brakes in `loop-runner.mjs` stay.** Per-brake evidence is in
  `ROADMAP.md`. `PM_COOLDOWN_SEC` (`loop-runner.mjs:74`) had no guard at all
  until `tests/loop-occupancy.test.mjs:3668`.

### Open on this branch — the MCP lane-discovery server

- `plugins/tmux-teams/.mcp.json` declares one stdio server;
  `plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs` is it.
  Decision record: `plugins/tmux-teams/docs/adr/0007-the-plugin-ships-an-mcp-server-for-lane-discovery.md`.
- Two read-only tools. `laneStatus` at `acp-lanes-mcp.mjs:218` answers
  `valid` / `invalid` / `unchecked`, never a boolean. `UNCHECKED_LANES` at
  `:125` names `claude` and `codex`, for which no parent-side check exists.
- Failures are a closed code set — `DIAGNOSTICS` at `:96`, `classify` at `:107`
  — and the raw exception text never reaches the wire.
- `fixesFor` at `:195` is keyed on the cause. `launchedDirectly` at `:365`
  compares realpaths.
- 18 tests in `tests/acp-lanes-mcp.test.mjs`. The one that matters most is at
  `:308`: it boots the manifest's own command from a directory whose name
  contains a space.

### Open, off this branch

- **Phase E: five of six cells wired, and `nextStep` has not shrunk.** It is
  still 308 lines over 32 `if` branches; the subscribers answer the questions,
  the branches that ask them are untouched. Moving one is the next unit.
- **Phase D:** the loop still reads a rendered artifact to schedule —
  `loop-runner.mjs:2054` reads `pm-notes/latest.md` to decide whether to
  dispatch the controller. Target is `run → scheduler`.
- **The qwen credential should be rotated.** Four `settings.json` files under
  `~/.config/claude-profiles/` were mode 644 holding live tokens and are 600
  now, and a dead copy was removed from `~/bin/claude-qwen`, but the key itself
  has not been changed. Only its owner can do that.
- Full open list with measurements: `ROADMAP.md`, section "What is actually open".

## 4. DO NOT

- **Do not count "what answered" as family evidence.** Measured: for `agy` the
  advertised model list is the adapter's own, but every claude-routed lane is
  handed its list by this runner (`CLAUDE_MODEL_CONFIG` from
  `review-profiles.mjs:745`, plus `.claude/settings.local.json`), so reading it
  back is quoting ourselves. On the first panel carrying the field, both
  claude-routed lanes advertised a bare `default`.
- **Do not remove any of the seven brakes.** Each was disabled and the 216 loop
  tests run: `ANSWER_DEADLINE_SEC` 9 red, `ZOMBIE_SEC` 7, `MAX_ATTEMPTS` 4,
  `MAX_LEGS` 2, the unchanged-trigger brake 2, `MAX_IN_FLIGHT` 1,
  `PM_COOLDOWN_SEC` 0. **Zero red proved unguarded, never redundant** — 28 of 33
  `planEscalation` (`loop-runner.mjs:1939`) calls leave the default in place, so
  it is reached constantly and never bites, because those boards have no
  `pm-notes/latest.md` for the clock branch to read.
- **Do not build a review packet from memory.** `scripts/gate-required.mjs`
  prints every deciding file. Three of the four panels run for v0.31.0 were
  assembled by hand and all three missed the same two publication markers, so
  "the panel read the release diff" was false at 3/3.
- **Do not treat the three-family panel as a behavioural check.** It reads a
  static packet and is forbidden to call a tool, by design. A `codex-advisor`
  lane can execute, and on 2026-08-16 it reproduced `claude` and `codex`
  reporting `ready: true` under `HOME=/definitely/nonexistent` with one command
  — on bytes the panel had just passed 3/3 with zero findings. Run the advisor
  while the code is cheap to change; spend the panel last, as the record. Two
  panels were burned on this branch before an advisor read it.
- **Do not compare `import.meta.url` against a hand-built `file://` string.** It
  is percent-encoded, so a path containing a space never matches and the process
  exits 0 having served nothing. The obvious fix (`fileURLToPath` vs `resolve`)
  is ALSO wrong on macOS, where the ESM loader resolves the module URL through
  the `/var` → `/private/var` symlink while `argv[1]` does not. That second half
  was found by the test written for the first half, not by reading.
- **Do not assert that a diagnostic returned something.** `fixesFor` was "fixed"
  from an empty list to every generic sentence available, and the test asked
  only for non-empty — turning an empty wrong answer into a non-empty wrong
  answer, which is worse because it sounds specific. `agy` was told to repair
  the adapter package when a trusted `agy` binary was what the parent refused.
- **Do not run the suite beside ACP lanes or parallel agents.** It measures the
  contention. Serialise every measurement through one caller.
- **Do not push a release to `main`.** See DECIDED.
- **Do not `rm -rf` an ACP run directory before recording its session id.** An
  outbox-less dispatch is often recoverable with `ACP_RESUME`.

## 5. DECIDED — DO NOT RELITIGATE

- **A release ships as a pull request; merge needs CI green plus the
  `chatgpt-codex-connector` review.** Master, 2026-08-16. Only Master waives it,
  and a waiver is recorded on the PR and in the release notes. v0.31.0 used that
  waiver once, on an exhausted account-wide quota — the bot answered a live
  `@codex review` in seven seconds with the same limit message.
- **The MCP server reads credentials and never returns them.** Master,
  2026-08-16, choosing the honest requirement over the flattering one after an
  advisor refused the earlier "none is ever read" wording.
- **The advertised model is a claim, not evidence.** Master, 2026-08-16.
- **AGY runs `gemini-3.7-flash-high`.** Master, 2026-08-16.
- **ADR 0003 stands: a dispatched agent receives no MCP server.** The new
  server is the operator's surface and does not reopen it.
- The remaining closed decisions, each with its document:
  `plugins/tmux-teams/docs/adr/` (0001 through 0007), and the
  "Decisions that are not up for re-litigation" section of `ROADMAP.md`.

## 6. UNPROVEN

Everything here rests on reading or on a synthetic environment, not on a run.

- **The MCP server has never been exercised by a real Claude host.** All 18
  tests drive it in-process or spawn it directly; nothing has registered it
  through `.mcp.json` and called a tool from a session.
- **`configuration: valid` does not mean a lane runs.** No endpoint is
  contacted, no credential is accepted by anyone, no adapter is resolved, no
  session is negotiated. Each answer carries `notProven` saying so.
- **Effective MCP containment inside a dispatched ACP child is not measured.**
  The existing guard proves the runner REQUESTS `mcpServers: []`; what the child
  runtime ends up with was never observed. Requested bytes and effective runtime
  are not synonyms — the boot bug on this branch is the proof.
- **The per-machine override path has never been run on the machine it was
  written for.** `TMUX_TEAMS_REVIEW_<ID>_SETTINGS` (`review-profiles.mjs:619`)
  and `_ENV_FILE` (`:640`) were proven against a third-layout FIXTURE with
  `HOME` pointing at a path that does not exist, plus the plumbing check that
  `review-gate.mjs:213` passes `process.env` through. A run on the Ubuntu host
  is the remaining proof.
- **`providerConfigDir` has no override.** It only matters under bwrap, and the
  staging block returns early at `acp-review-client.mjs:486` for every profile
  that does not declare it — no shipped profile does. Do not pre-fix it.
- **The real review-packet ceiling is unknown.** 74 KiB of source passed, 60 KiB
  of tests passed, 72 KiB of dense prose failed three times and passed at 22 KiB;
  20 KiB and 26 KiB passed on 2026-08-16 and a 37 KiB packet was split rather
  than risked. Staying near 25 KiB is a habit, not a measurement of the boundary.
- **Line numbers in this file were resolved on 2026-08-16 at `39b3d66`.** They
  rot. Re-grep the symbol rather than trusting the number.

## 7. WHERE THINGS LIVE

```
ROADMAP.md                                        the standing goal; phases and what is open
CLAUDE.md                                         the rules, with the measurements behind them
plugins/tmux-teams/docs/adr/                      closed decisions, 0001 through 0007
plugins/tmux-teams/skills/                        the shipped skills — this repo is their source
plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md   the one SSOT
plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs          lane definitions
plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs              the three-family gate
plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs            the MCP server
plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs              the loop
scripts/gate-required.mjs                         does this release owe a panel
scripts/roadmap-gate.mjs                          is a published page behind its source
scripts/roadmap-render.mjs                        source to page, deterministic
tests/acp-lanes-mcp.test.mjs                      guards the MCP server
tests/loop-occupancy.test.mjs                     guards slot accounting and the controller brakes
tests/review-gate.test.mjs                        guards the review transport and the gate
tests/review-policy.test.mjs                      guards lane identity and collision policy
tests/plugin-structure.test.mjs                   RELEASE_VERSION and the shipped tree
tests/docs-paths.test.mjs                         every documented .mjs path must resolve
~/.config/claude-profiles/<lane>/settings.json    per-lane provider config, mode 600
```

Narrative history that used to live in this file is now in `CLAUDE.md`, the ADRs
and `ROADMAP.md`. This file carries only what is true right now.
