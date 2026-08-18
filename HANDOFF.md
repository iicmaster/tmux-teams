# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-17 through `bmad-party-mode`.

## 1. READ THIS FIRST

- Branch `release/v0.32.0`, pushed. It carries the MCP lane-discovery server and
  `acp-dispatch.mjs`. Scope set by Master 2026-08-17.
- `main` is at v0.31.0 and owes nothing.
- **What is left is one gate and five mechanical steps**: a three-family panel on
  the frozen bytes, then bump seven places, render/publish/record the roadmap,
  merge the PR, tag the merged sha, pin the submodule in `~/agent-skills`.

### The gate is blocked on lane availability, not on the code

Measured 2026-08-18. Seven review lanes ship; **three can answer**:

| lane | family | state |
|------|--------|-------|
| `agy` | gemini | works |
| `codex` | openai | works |
| `qwen` | qwen | 429, one-week quota exhausted, resets 08-19 16:37 UTC |
| `zai` | zai | 400 `[1210] This model always engages in thinking and cannot be disabled`; a thinking budget did not help; package expired |
| `kimi` | kimi | child exits 1 |
| `deepseek` | deepseek | child exits 1 |
| `claude`/fable | claude | identity MATCHES and the OAuth session is expired |

Master chose **fable** as the third family. **`claude auth login` does not fix
it, and this paragraph said it would until the login was actually run.**

Measured 2026-08-18 after a successful fresh login:

- with no `CLAUDE_CONFIG_DIR`: `Authentication required` — the credential is not
  found at all
- with `CLAUDE_CONFIG_DIR=$HOME/.claude`: `OAuth session expired and could not
  be refreshed`, identity `claude-fable-5 (matched)`, four progress events
- `~/.claude/.credentials.json` mtime: **13 July**, untouched by the login
- the Keychain entry `Claude Code-credentials`: present, written by the login

So the adapter reads a credential store the CLI no longer writes. It is not
staleness and a re-login cannot reach it — which is the GitHub issue about the
default Claude ACP lane being unable to reuse a Claude Max login, and it is
v0.33.0's first item. "Session expired" was the wrong diagnosis; the sentence
the adapter prints is not the reason it fails.

Round eight is running the two available families over all six packets — 12 of
18 lanes. `PANEL_THIRD=qwen` or `PANEL_THIRD=fable` re-runs the script and adds
the missing six; every pair that already has an outbox is skipped, so nothing is
paid for twice.

### Eight panel rounds, and what they actually cost

Rounds five, six and seven each found defects **in the previous round's fixes**,
never in untouched code. Every one was the same shape: the fix went in the right
direction and stopped short of its own call site.

- read policy added — `recordedPid()` never routed through it
- `hasStopped` corrected — admission left applying the opposite rule
- `credential_unreadable` added — no caller ever passed `fileKind`
- `mcp.json` added — only `.mcp.json` was ever booted
- `ACP_SESSION_RECEIPT_REQUIRED=1` added — without
  `ACP_SESSION_OPERATION`, which made every documented advisor command exit 2
- the leaf read policy — parents were still resolved through symlinks

**What changed in round seven is the method, not the effort.** Mutate the CALL
SITE, not the function: if deleting the call leaves the suite green, the guard
does not exist. And run the documented command instead of grepping for it — a
string check proves you typed something. Both caught real holes in guards
written minutes earlier, four times.

A panel lane can also be WRONG. One reported `acceptedCredentialNames` missing
from the codebase; it is at `review-profiles.mjs:776` and the disproof is
committed as a test, because a disproof in a chat message is worth nothing
later. Resolve a blocking finding by fixing it or by disproving it with a
command — never by re-running until it goes away.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
```

Green here on 2026-08-17, measured on the release branch, is exactly:

```
ℹ tests 1038
ℹ pass 1034
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

`roadmap-gate.mjs` answers **2 (STALE)** on this branch — `ROADMAP.md` gained a
release-scope section. Rendering, publishing and `--record` are part of this
release, not something to do after it.

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

### Open on this branch — the v0.32.0 release

- **`acp-dispatch.mjs`** (`plugins/tmux-teams/skills/tmux-teams/scripts/`) is
  the operator's entry to an ACP lane: it detaches the lane into its own process
  group so a caller's shell cap is not the lane's deadline, and `status` / `wait`
  report back. It never kills a lane, including on its own timeout.
  16 tests in `tests/acp-dispatch.test.mjs`.
- **The MCP lane-discovery server** is unchanged in purpose from ADR 0007 and
  much changed in detail: envelope AND per-method params validation, a request
  id that may be any finite number, credential vocabulary shared with the
  endpoint validator by construction, and an `agy` check that requires an
  executable regular file. 27 tests in `tests/acp-lanes-mcp.test.mjs`.
- **Two things are kept deliberately and are judgements, not spec readings.**
  `initialize` does not demand `capabilities` or `clientInfo` — no real host has
  ever initialized this server, so refusing one that omits a field costs a dead
  feature and buys nothing. And a routed lane honours `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_API_KEY` from its own FILES but never from the ambient
  environment, while its declared secrets work from either. Both are in ADR
  0007. An advisor round accepted both with the caveat that this must never be
  sold as strict MCP conformance.

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
- **Do not trust a guard without checking its SCOPE and whether it REACHES the
  branch it guards.** Three times in two days: the secret matrix asserted no
  credential field name reached the wire and passed because every fixture in it
  failed at `endpoint_missing`, where no credential sentence exists; the
  companion-command guard scanned `skills/` while `README.md` carried the exact
  command it forbids; and the stale-identity test used an hours-old snapshot, so
  it never touched the one-second boundary it was named for. All three were
  green. **A guard that never reaches its branch is not a guard**, and neither
  is one pointed at the wrong directory.
- **Do not build a path out of an argument before validating it**, however good
  the reason for delegating the validation. The dispatcher deliberately left
  task-id checking to the companion — and then opened the log file and wrote the
  pid file from the raw value, so `../../../victim` truncated a file outside the
  run directory. Copy the rule, name its source, and assert the two stay
  identical; that answers the drift objection without keeping the hole.
- **Do not fix a finding while the panel that found it is still running.** It
  reads a static packet built from one sha; a fix mid-run means the remaining
  lanes judge bytes that no longer exist, and the run ends with verdicts nobody
  can cite. Two runs were spent learning this. Freeze, run, collect, then fix.
- **Do not leave a long job in a killable foreground — including a job that
  supervises unkillable ones.** The panel script ran as a harness background
  task, was killed mid-run, and its lanes survived because THEY are detached
  while the thing collecting their answers was not. One verdict had to be
  recovered by hand. `nohup … &` for the supervisor too.
- **Do not let a test leak the directory it made.** `tests/acp-dispatch.test.mjs`
  had 25 `mkdtempSync` calls and one `rmSync`; several of those hold a real
  lane's logs and receipts. Enough runs took a 228 GB volume to zero — twice —
  and stopped every tool that writes, including the ones needed to fix it.
  Register and remove in `after()`. The panel runner had the same shape and was
  found only after it cost the machine a second time: **after fixing a leak, go
  and look for the same shape somewhere else.**
- **Do not mutate the FUNCTION when you mean to test the wiring.** Deleting a
  call site must turn a test red. Four guards written this release passed their
  own mutation and still guarded nothing, because the mutation hit the helper
  and every consumer had been left unwired.
- **Do not grep for a command when you can run it.** A string check proves you
  typed something. `ACP_SESSION_RECEIPT_REQUIRED=1` was added to four documented
  advisor commands, asserted as present, and broke all four — the companion
  refuses that flag without `ACP_SESSION_OPERATION` and exits 2 before prompt
  delivery. Three families reported it.
- **Do not let a `git commit` follow a test run without depending on it.**
  `node --test > log; grep ...; git add -A && git commit` commits on red,
  because the grep controls nothing. It shipped one commit this release.
  Put the commit inside `if grep -q '^ℹ fail 0$' log; then`.
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
- ~~The dispatcher has never run against a lane it did not itself spawn.~~
  **Closed 2026-08-17**: `tests/acp-dispatch.test.mjs` now reports on a foreign
  run directory in both a finished and a running state. What remains unproven
  is narrower and worth keeping: the run-generation binding protects only the
  runs this dispatcher started, because a foreign directory has no routing file
  to bind to. That is stated in the code rather than implied.
- **`initialize` tolerance is unmeasured in both directions.** No real host has
  initialized this server, so neither the tolerance nor a stricter rule has been
  tested against one.
- **Line numbers in this file were resolved on 2026-08-17.** They rot. Re-grep
  the symbol rather than trusting the number.

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
plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs             the operator's entry to a lane
tests/acp-lanes-mcp.test.mjs                      guards the MCP server
tests/acp-dispatch.test.mjs                       guards detachment, status and wait
tests/loop-occupancy.test.mjs                     guards slot accounting and the controller brakes
tests/review-gate.test.mjs                        guards the review transport and the gate
tests/review-policy.test.mjs                      guards lane identity and collision policy
tests/plugin-structure.test.mjs                   RELEASE_VERSION and the shipped tree
tests/docs-paths.test.mjs                         every documented .mjs path must resolve
~/.config/claude-profiles/<lane>/settings.json    per-lane provider config, mode 600
```

Narrative history that used to live in this file is now in `CLAUDE.md`, the ADRs
and `ROADMAP.md`. This file carries only what is true right now.
