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

### The review of record is `codex-advisor` at `gpt-5.6-luna`, effort `max`

**Master, 2026-08-19: that lane is the review, and the three-family panel is
waived for v0.32.0.** Recorded here and on the PR because a waiver nobody wrote
down is the silent skip this file already has a section about. What follows is
the search that preceded the decision, kept because the availability table is
still true and the next release will need it.

### The third family had been `opencode`, and how that was found

Seven review lanes ship with the plugin. Measured 2026-08-18, **two of them
could answer**: `agy` (gemini) and `codex` (openai). `qwen` hit a one-week quota,
`zai`'s gateway refuses a disabled thinking mode, `kimi` and `deepseek` exit 1,
and the default `claude`/fable seat cannot authenticate at all.

The third family came from OUTSIDE that list: **`opencode acp` speaks ACP
directly and carries its own credential store**, so
`opencode/deepseek-v4-flash-free` runs as a deepseek lane with no Claude
keychain and no per-provider wrapper binary. It returns `completed` with
`effective_identity: opencode/deepseek-v4-flash-free (matched)` — a matched
identity, not `unverified`, so it satisfies the recording rule as it stands.

    ACP_CMD="$(command -v opencode) acp" ACP_MODEL="opencode/deepseek-v4-flash-free"

**The lesson is the one that cost most of a day.** Availability was counted from
the seven lanes the plugin declares, and the answer "only two families are
possible" was wrong the whole time — the machine could reach a third through a
tool the plugin does not ship. Count what the machine can do, not what the
config file lists. Master pointed at `opencode`; nothing in this repository
would have.

The fable seat is a separate matter and is NOT a login problem: three successful
`claude auth login` runs changed nothing, `~/.claude/.credentials.json` has an
mtime of 13 July, and the Keychain entry the login writes is not reachable by a
subprocess. That is the GitHub issue about the default Claude ACP lane being
unable to reuse a Claude Max login, it is v0.33.0's first item, and the
measurement is recorded on the issue.

### Nine panel rounds, and what they actually cost

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

Green here on 2026-08-19, measured on the release branch, is exactly:

```
ℹ tests 1105
ℹ pass 1101
ℹ fail 0
ℹ skipped 4
```

**And "green three times on a quiet machine" is not the same as green.** On
2026-08-19 a review lane running its own dispatch races and MCP boots beside the
suite got 1106/1101/**1**/4: every bulk-at-exit `rmSync` in the suite could throw
ENOTEMPTY, because `force: true` swallows ENOENT and nothing else and a recursive
removal can race its own readdir. Nine hooks carry `maxRetries` now. Run it once
under load before believing a clean run.

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
  report back. It imposes NO DEADLINE on a lane, including its own — which is
  not the same as never killing one, and this line said the stronger thing until
  a lane read it against the source. A lane whose pid or routing record cannot
  be published IS killed, because the alternative is a detached process with no
  way back to it.
  58 tests in `tests/acp-dispatch.test.mjs` — a count that said 16 through six
  advisor rounds, because a number in prose is only true on the day it is typed.
- **The MCP lane-discovery server** is unchanged in purpose from ADR 0007 and
  much changed in detail: envelope AND per-method params validation, a request
  id that may be any finite number, credential vocabulary shared with the
  endpoint validator by construction, and an `agy` check that requires an
  executable regular file. 48 tests in `tests/acp-lanes-mcp.test.mjs`.
- **Two things are kept deliberately and are judgements, not spec readings.**
  `initialize` DOES demand `capabilities` and `clientInfo`, including
  `clientInfo.name` and `.version`, and this bullet said the opposite: measured,
  a call carrying only `protocolVersion` answers `initialize requires an object
  capabilities`, and adding one answers `initialize requires an object
  clientInfo`. The judgement that was kept is the narrower one — an UNKNOWN
  capability name stays legal whatever it holds, because refusing a future
  protocol is not validating this one. And a routed lane honours `ANTHROPIC_AUTH_TOKEN` /
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
- **The claude/anthropic review lane, measured 2026-08-18 — two faults, and the
  interesting one is that they masked each other.** The lane was written off as
  "auth broken" for a whole day. It had a wrong model id sitting IN FRONT of the
  auth failure, so every probe died at the first fault and nobody saw the
  second. Probed against the adapter's own `configOptions`, it advertises
  exactly `default`, `opus[1m]`, `sonnet`, `haiku` — `claude-fable-5` is refused
  and so is a bare `opus`. With `opus[1m]` the lane reports
  `effective_identity: opus[1m] (matched)` and then dies on
  `OAuth session expired and could not be refreshed`.
  That second failure is real and is NOT fixed by `claude auth login`:
  `~/.claude/.credentials.json` carries `claudeAiOauth.expiresAt =
  2026-06-11 15:49 UTC`, expired 68 days, while the CLI reads the macOS
  Keychain. So `claude -p` answers `OK` in a subprocess at the same moment the
  ACP lane refuses — the two read different credential stores, which is the
  v0.33.0 item, now with a measurement behind it instead of a guess.
  The mint is `claude setup-token` and it belongs to Master: it produces a
  durable credential and prints it, so running it through a session would put
  the secret in a transcript.
- **A diagnostic that holds the answer and does not say it.**
  `assertConfigOptionValue` (`acp-companion.mjs:1966`) refuses with
  `rejected unsupported model value <v>` while the advertised list is in its
  hand. Four probes were spent recovering what it could have printed. Not
  changed for v0.32.0 — the bytes are frozen for the panel — and it is on the
  roadmap, but note the shape: this repo's own rule is to assert the sentence a
  diagnostic should produce, and the rule was written for exactly this.

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
- **Do not start a panel round on a run directory holding the previous round's
  answers.** The runner resumes by skipping any lane that already has an outbox,
  which is right within a round and wrong across one: round nine's ten verdicts
  sat in `panel-runs/` after all fourteen of its findings were fixed, and a
  re-run would have reported verdicts on the PRE-fix bytes as the new round's.
  Archive the directory under the sha it answered — `panel-runs-round9-218433d`
  — rather than deleting it, because a superseded verdict is still the evidence
  that the fix was owed.
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
