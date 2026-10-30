# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-10-30 for v0.48.0 release.

## 1. READ THIS FIRST

- **v0.48.0 IS PREPARED** on branch `release/v0.48.0` — version bumped across
  6 files / 7 places. `main` carries **v0.46.0**, tagged at the MERGED sha
  `890768a`. **v0.47.0 was prepared on a release branch and never tagged**;
  its content ships inside v0.48.0, and the ROADMAP current-release line
  records exactly that.
- **What ships in v0.48.0** — two things:
  1. **The shared findings board** (the whole of the un-released v0.47.0,
    `db0bd28`/`9d08832`/`e5d14c6`/`a4f0c54`): `findings-board.mjs`, one
    append-only JSONL per delegation run (CLAIM / OBSERVED / FACT / FAIL /
    PATCH_SUMMARY; FAIL — a falsified hypothesis — first-class; supersede by
    appending with `--ref`; id IS the 1-based line number), wired into
    `pm-delegation` (board init in step 1, audit verdicts as FACT/FAIL, the
    board path + digest in step 4's brief). Guarded by
    `tests/findings-board.test.mjs`. A `codex-advisor` lane reviewed that
    round (`fb-run 2026-10-26`) and its findings were closed before merge.
  2. **The AGY seat's rate-limit fallback** (`590e393`), Master's order
    2026-10-30: a gemini-4 seat that dies on provider quota evidence falls
    back to the gemini-3.8 flash seat at the SAME effort tier immediately,
    with the operator told — not an error that stops the consultation.
    `agy-seat-fallback.mjs` classifies the failure (`rate-limited <cwd>
    <task-id>`) from liveness fields AND the whole runner log, through
    `acp-dispatch.mjs`'s own read boundary, and maps the seat (`seat
    <model>`); the `agy-advisor` skill carries the re-dispatch recipe (same
    brief, same task id, both `ACP_MODEL`/`ACP_EXPECT_MODEL` on the fallback
    seat, receipt verified, answer labelled). ONE HOP ONLY; rate-limit
    evidence is the ONLY trigger; the codex/claude never-downgrade rules and
    the Gemini 3.1 ban are untouched. Guarded by
    `tests/agy-seat-fallback.test.mjs` (ten tests).
- **Why the classifier reads the LOG**: in the measured event (2026-10-21,
  `pmd-review-agy`, gemini-4-argon-high, `RESOURCE_EXHAUSTED (code 429)`,
  68 h reset) the liveness record ended `termination_reason: "protocol_error"`
  — the reason field names the protocol frame, not the provider condition.
  Verified end to end against that real run directory.
- **Suite on the bumped tree: 1277 pass / 0 fail / 0 skipped** (2026-10-30).
  `git diff --check` clean; `claude plugin validate --strict` passed.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036          # or any clone of iicmaster/tmux-teams
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1277 pass / 0 fail / 0 skipped`** — measured 2026-10-30 on the
v0.48.0 release tree. **On this Mac, first move
`~/.config/tmux-teams/lanes.json` aside** (and put it back after): it pins
`agy → gemini-3.8-flash-high` machine-wide, and `tests/acp-lanes-mcp.test.mjs`
pins the shipped default `gemini-4-argon-high`, so one test fails on machine
state alone — the same class as running the suite under live lanes.

**Gate on the count, never on a grep of the output.** `node --test | grep '✖'`
exits 0 when it FINDS failures, so chaining a commit after it with `&&` commits
on red. That happened in the v0.37.0 session and it is the third time this
repository has recorded it.

**Do not run the suite while ACP lanes are live.** A run under contention
measures the contention.

```bash
git diff --check                    # clean
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 2 while the page is behind — publish, then --record
node scripts/gate-required.mjs      # reads <last-tag>..HEAD; run only after committing
```

## 3. STATE

### In the working tree, uncommitted: the handoff skill's size budget (2026-10-30)

Master's direct instruction, from the 2 MB `HANDOFF.md` finding — measured
2,052,245 bytes / 4,514 lines in an eight-lane project; an archive-once of
1.7 MB (2026-10-11) regrew to 2 MB by 2026-10-29. Four files, uncommitted on
`release/v0.48.0`, ported byte-identical (cmp-verified) from a worktree that
has been removed; a release carrying them owes the panel — they are
`plugins/` bytes.

- `plugins/tmux-teams/skills/handoff/SKILL.md` — "The file has a budget":
  32 KiB target / 48 KiB hard ceiling, `wc -c HANDOFF.md` before composing and
  after writing, rotation to `docs/history/handoff-archive-YYYYMMDD.md` with
  one pointer line per moved block, one-owner-one-block with pre-compaction
  dumps in owner sidecars, and a reader guard for inherited over-ceiling
  files. The room brief carries the budget; READ THIS FIRST caps at ten lines
  and 2 KiB; "Before you finish" reports the byte count and proves old blocks
  deleted.
- `plugins/tmux-teams/docs/adr/0009-handoff-carries-a-size-budget.md` — the
  decision, the measurement, and the strongest argument against it.
- `tests/handoff-budget.test.mjs` — seven anchor tests, all passing.
- `ROADMAP.md` — one entry under "Shipped since the phases were last written".

Suite in the worktree at `79d43c2` + these files: 1263 tests, 1261 pass,
2 fail, 0 skipped; an A/B at clean HEAD (same two files alone) reproduced
both failures, 139/137/2 — **both are pre-existing on the branch, not from
this change**:

1. `tests/acp-lanes-mcp.test.mjs` "every declared lane is listed": pins
   `gemini-4-argon-high`, the declaration says `gemini-3.8-flash-high`.
   Adjacent work is in flight (`590e393`, agy rate-limit fallback onto the
   3.8 seat) — coordinate before touching.
2. `tests/plugin-structure.test.mjs` "every shipped module parses":
   `skills/tmux-teams/workflows/mailbox-run.js` is ESM in a `.js` name with
   no nearest `type: module`.

Unproven: the 32/48 numbers are reader-cost numbers, not sufficiency numbers
(ADR 0009 records this); the budget has not yet been exercised on a real
handoff.

**[v0.48.0 release session, 2026-10-30 — coordination note.** This release
ships WITHOUT these four files; they sit uncommitted exactly as left. The
ROADMAP entry above was accidentally captured by this session's release bump
`git add` and was removed again by amending that commit before anything was
pushed — the released ROADMAP does not describe this work, and committing
these files remains their own session's step once the panel-review question
is settled. The acp-lanes-mcp failure in item 1 is root-caused to
`~/.config/tmux-teams/lanes.json` pinning `agy → gemini-3.8-flash-high`
machine-wide (see 6b); it is not a branch defect. Item 2 did not reproduce
in this session's two green full-suite runs (1277/0/0) — re-measure before
believing either account.**]

### Prepared: v0.48.0 (findings board + AGY quota fallback)

See section 1. The fallback script ships in
`plugins/tmux-teams/skills/tmux-teams/scripts/agy-seat-fallback.mjs`; its
open decisions are stated in the file header and comments (the marker set is
the measured 2026-10-21 vocabulary — `RESOURCE_EXHAUSTED`, standalone `429`,
`quota reached`, `rate limit`, `too many requests`; the log is scanned whole,
not tailed) so they can be argued with. **No advisor lane and no panel read
these bytes**: Master ordered the release directly (2026-10-30), and that is
recorded here rather than smoothed over — the PR's CI and the codex review
bot are the only outside read this release gets.

### Released: v0.46.0 (PR #99, panel of record 3/3)

9Router advisor seat in `claude-advisor` (alias table from
`~/.claude-9r/settings.json`, direct router-native ids, `claude-glm-5.3`
verified end to end); `gpt-6-sol` prohibition enforced in `acp-companion.mjs`
(three character-identical `PROHIBITED_MODEL` copies); `pm-delegation`
prepare-phase audit through `requirement-audit`; the `8eed50a` stale-bytes
reverts fixed (`dcfb5a6`, `9e1dc48`). Suite at ship: 1234/0/0 (2026-10-26).

### Released: v0.37.0

**1. The default `claude` lane could not authenticate, and the recorded
diagnosis was wrong for 22 days.** Not a stale `.credentials.json` against an
unreachable keychain: `CLAUDE_CODE_SIMPLE=1`, set on every claude lane since
`8a05d6d` to strip repository hooks, forbids OAuth and keychain outright.

Bare mode is the default only when a credential is REACHABLE — in the lane's own
environment, or in the `settings.json` of the profile `CLAUDE_CONFIG_DIR` names.

- `plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs:2711`
  `CREDENTIAL_ENV_KEYS` · `:2712` `profileCarriesToken` · `:2785`
  `envCarriesToken` · `:2788` `claudeBareByDefault`.
- An explicit `CLAUDE_CODE_SIMPLE` wins; an EMPTY one is not explicit.
- Guards: `tests/acp-companion.test.mjs` (seven labelled cases, nine `dumpOf`
  runs — both numbers are in its header because one alone rotted three times)
  and `tests/worker-isolation.test.mjs` (three, profile source only).

**Credential matrix, measured against the real binary 2026-08-30:**

| credential | in the profile | in the environment |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | answers, `end_turn`, 917ms | `401 Invalid bearer token` |
| `ANTHROPIC_API_KEY` | `401 API key is invalid` | `401 API key is invalid` |
| `apiKeyHelper` | `Not logged in · Please run /login` | not tested |
| nothing | refused, no API call | — |

A 401 means the credential was READ AND TRIED. `duration_api_ms` is 0 for a 401
exactly as for "never found", so the MESSAGE discriminates and the duration does
not — reading the number alone would have removed `ANTHROPIC_API_KEY`.

**2. `--party <id>` on all three `*-advisor` skills.**
`plugins/tmux-teams/skills/tmux-teams/scripts/advisor-party.mjs`:

- `:31` `party_substituted` · `:99` the check that the resolver's `active`
  equals the id asked for.
- `:148` `NEUTRALISED` — substitution, never deletion.
- `:175` `CONTROL_CHARS = /\p{C}/gu` · `:202` `MARKUP_OPENER` · `:256`
  `CHARACTER_REFERENCE` · `:271` `VISIBLE`.
- Exit `0` success, `2` a named refusal, `1` a usage error — all three
  documented in all three SKILL.md files.
- Guard: `tests/advisor-party.test.mjs`, nine tests.

Measured live: the fable lane answered as Vex / Grumbal / Boundary / Yui / Dana
with no invented names.

### v0.44.0 Release

**The luna tier is now `max`, not `ultra`.** Everything that says
`gpt-6-luna[ultra]` as CURRENT policy is wrong after 2026-09-30; dated
historical notes and the two liveness fixtures (which record what the companion
once emitted) stay as they are by decision of the panel. The review matrix to
hold every future edit to: default/`sol` and `astra` at `ultra`, `luna` at
`max`, codex review profile `gpt-6.1-sol[ultra]`.

**The review-gate AGY lane is dead on this machine** until the pinned adapter
gets an `agy` source it can actually reach: `antigravity-acp@1.0.0` wants
`agy` v1.0.13 and its download URL 404s, while `AGY_BIN` cannot reach the lane
through `neutralEnv`. Bumping the adapter pin or widening the env allowlist is
a change to the gate machinery itself and needs its own review.

### v0.40.0 Release

**1. `codex-advisor` reasoning effort locked per model** (`plugins/tmux-teams/skills/codex-advisor/SKILL.md`)
Locked reasoning effort per model (`ultra` for `astra`/`luna`, `max` for `sol`/`terra`), with default seat `sol[max]`. Aligned codex review profile in `review-profiles.mjs` with `gpt-5.6-sol` at `max`.
Merged via PR #83 with CI green and `chatgpt-codex-connector` review approval.

`RELEASE_VERSION` is at `tests/plugin-structure.test.mjs:18` and reads `'0.40.0'`.
Fourteen skills ship from `main`.

## 4. DO NOT

- **Do not push, open a PR, merge, tag or publish without Master saying so in
  their own message.** Each is its own gate. In the v0.37.0 session Master
  answered them one at a time and the answers were not interchangeable.
- **Do not `git add` a file another session is editing.** Two sessions shared
  this working tree on 2026-10-30 and a `git add ROADMAP.md` captured the
  other session's uncommitted entry into a release commit; nothing had been
  pushed, so an amend removed it. `git add` reads the WORKING TREE, not your
  last edit — add narrow paths, and `git show --stat` every commit before it
  leaves the machine.
- **Do not treat the v0.37.0 panel waiver as covering anything else.** Master
  granted it on 2026-08-31 after twelve rounds, for those bytes.
- **Do not reach for `--force` on a stale branch.** The `requirement-audit`
  branch was 269 commits behind; rebasing it and force-pushing was proposed and
  Master refused it. Merging `main` INTO the branch reached the same place —
  CI green on current code — with a plain fast-forward push, and it kept the
  branch's existing bot review and anything anyone had based on it. The push
  printed `83d4448..7be0c5f` with no `+`.
- **Do not let a commit message describe a thing you did not do.** That same
  commit still said "rebased onto" after the approach changed to a merge, and
  it had to be amended. It is the release's own defect shape in a message.
- **Do not push as whatever account `gh` currently holds.** It reverts to
  `ngs-th`, which has READ access only, and the push returns 403 with
  `Permission to iicmaster/tmux-teams.git denied to ngs-th`. Run
  `gh auth switch --user iicmaster` immediately before every push. It happened
  again on 2026-09-01, after the same trap had already been written down.
- **Never neutralise text by DELETING it.** Deletion joins what sat either side:
  `PPARTY-ROSTER>>>ARTY-ROSTER>>>` rebuilt an exact delimiter and
  "``<<<PARTY-ROSTER`" rebuilt a code fence. Substitution cannot, and is linear
  — a crafted 256 KiB field went from ~17,000 whole-string passes to 0 ms.
- **Over-neutralising is a defect too.** The mandate carries what the operator
  saved. `risk<10%`, `n<3`, `Rock &roll;`, `Tom &Harry;`, `AT&T`, `Q&A` and
  `a & b` must survive intact, and `tests/advisor-party.test.mjs` asserts it.
- **Do not read `duration_api_ms` as proof no API call was made.** A 401
  reports 0.
- **`tests/fixtures/mock-acp-agent.mjs` sits under a 64 KiB HARD BOUND** the
  companion enforces on an adapter entry. Twelve lines of comment took it past
  and 39 tests went red *naming a checksum*, because one condition answered
  three facts with one sentence. Both halves are fixed and guarded; put the
  explanation in the TEST, which has no bound.
- **Do not chain an edit behind `grep && python`.** One did in the v0.37.0
  session, the grep matched nothing, the edit never ran, and the next command
  reported success. It surfaced only because a test stayed red with the
  identical message.
- **Do not read a panel outbox by stripping `TEAM_DONE` alone** — a blocking
  lane ends `TEAM_BLOCKED`, and the reader called a four-finding block "not
  JSON". `~/tt-panel/read-r*.py` strips all three sentinels.
- **Do not name a test variable `secret`.** The pre-commit scanner blocks the
  commit, correctly: it cannot tell a decoy from a credential by its name.
- **Do not re-run `~/tt-panel/dispatch-r<N>.sh` to retry one lane.** Its `go()`
  opens with `rm -rf "$dir"` and destroys all eight run directories.
- **Do not work in `$TMPDIR` or a session scratchpad.** A worktree there was
  destroyed twice in the v0.36 session, once losing `.git` itself.

## 5. DECIDED — DO NOT RELITIGATE

- **Master, 2026-09-30: `gpt-6-sol` is blocked on every route — only
  `gpt-6.1-sol` may be dispatched or reviewed.** Enforced by the shared
  `PROHIBITED_MODEL` pattern (three character-identical copies: dispatcher,
  companion, review profiles) at request, expectation AND observed-identity
  time; the refusal names the successor. The same pattern carries CLAUDE.md's
  Gemini 3.1 ban.
- **Master, 2026-10-30: the AGY seat falls back to the gemini-3.8 flash seat
  on rate-limit evidence — immediately, at the same tier, with the operator
  told.** The one automatic downgrade this seat takes; one hop only; codex and
  claude keep their never-downgrade rules. Recorded in `agy-advisor/SKILL.md`
  and shipped in v0.48.0.
- **Master, 2026-08-31: the v0.37.0 panel is waived after twelve rounds.**
  Recorded in that release's PR body and release notes.
- **Master, 2026-09-01: merge over rebase for a stale published branch**, when
  the alternative is a force-push.
- **Master, 2026-08-30: no version pin in `~/agent-skills`.** Release flow step
  10 is retired (`aa0ab7c`); its `sync.sh` fetches `origin/main` at run time.
- **`ANTHROPIC_AUTH_TOKEN` stays a bare-mode credential** (round-2 objection,
  overruled on measurement) · **`apiKeyHelper` is NOT one** (round-4 objection,
  upheld on measurement) · **a credential in the environment counts as well as
  one in a profile**.
- **`queue<limit` is neutralised** (round-12 objection, refused): `<` before an
  ASCII letter is TAG OPEN in the HTML tokenizer and can swallow the closing
  fence; `<` before a digit is not. The reasoning is in the code above
  `MARKUP_OPENER`.
- **A roster is contained, not censored**, and what containment PROVES is
  structural: roster text cannot break the block, stand as its own instruction
  line, or get the last word. A persona that reads as an instruction INLINE is
  still delivered.
- **MCP stays read-only; the writing surface is a skill** — ADR 0007.

## 6. UNPROVEN

- **No advisor lane and no panel have read the v0.48.0 fallback bytes.** The
  findings-board half was codex-reviewed (`fb-run 2026-10-26`); the quota
  fallback was verified by its tests and against the real 2026-10-21 run
  directory only. Master ordered the release directly; the PR's CI and the
  codex review bot are the only outside read it gets.
- **The rate-limit marker set is one measured event deep.** It covers
  `RESOURCE_EXHAUSTED`, a standalone `429`, `quota reached`, `rate limit` and
  `too many requests` — the vocabulary of the 2026-10-21 log. A provider error
  worded differently classifies as NOT rate-limited and the dispatch keeps
  failing closed (the safe direction), but the set will need widening on the
  next differently-worded quota death, and that widening should be driven by
  the new log, not paraphrased from this one.
- **`astra[ultra]` has no live evidence on this machine** and neither does the
  bare `codex` default behind the `mailbox-run.js` comments — the v0.44.0 ACP
  evidence covers `gpt-6.1-sol[ultra]`, `gpt-6-luna[max]` (refusal and match)
  and the three panel lanes only.
- **`requirement-audit` has never been invoked against a REAL requirement.**
  Mechanically it now has been: 2026-10-23, a test spec + two tickets walked
  `pm-delegation` step 1 end to end — T1 (full `📋 Grill:` block) came back
  READY and entered the frontier, T2 (no Grill block) came back NOT READY with
  six blockers and was held out while T1 proceeded. That is mechanical
  verification that the wiring fires, not operational evidence that it works
  on a real multi-ticket spec with a real dependency graph. It SHIPPED in
  v0.44.0 and is in the installed plugin cache; an earlier note here said
  otherwise and was wrong. `pm-delegation`'s prepare phase now instructs the
  PM to run its audit mode on every ticket, and `requirement-audit` documents
  the caller under "Called from".
- **Nothing after `e8b6ef0` has been panel-read except the findings board**
  (`fb-run 2026-10-26`, findings closed in `e5d14c6`). The v0.48.0 fallback
  bytes continue that gap — see the first bullet.
- **`--party` has been exercised on the claude/fable lane only.** The codex and
  agy advisor skills document the same command; neither was dispatched with it.
- **`apiKeyHelper` was measured from a profile only**, not from the environment.
- **The sanitizer is measured against the payloads named in the tests.** It is
  not proved complete. Its comments say which parts are a closed spec (HTML's
  named-reference set is frozen) and which remain a bounded denylist (U+2800 is
  the only hand-listed blank-rendering codepoint).
- **Nothing has ever installed from `agent-plugins/tmux-teams/`.**

## 6b. ENVIRONMENTAL BLOCKERS ON THIS MACHINE (recorded 2026-10-23, this session)

- **The claude ACP lane cannot start here.** Both the default seat and the
  `kimi` profile die at `claude auth status did not answer within 5 s` →
  `session/new failed before prompt` → SIGKILL. `claude auth status` answers
  in 0.8 s when run directly from a login shell, so the 5 s window inside the
  adapter is what misses — an environment/adapter issue, not a code bug in
  this repo. Do not count the claude family in a panel on this machine until
  that changes.
  **CORRECTED 2026-10-26 — the lane dispatches, and the blocker above was the
  npx layer, not auth.** Two receipt-backed probes ran end to end through
  `CLAUDE_CONFIG_DIR="$HOME/.claude-9r"` (fable: `effective_identity: fable
  (matched)`; claude-glm-5.3: `effective_identity: claude-glm-5.3 (matched)`,
  both `outcome: succeeded`). The adapter answers `initialize` in 620ms when
  spawned directly; `npx -y @agentclientprotocol/claude-agent-acp` re-extracts
  its whole tree on EVERY boot because `~/.npm` symlinks to the external
  KINGSTON volume (~5-6 min, one tarball alone measured at 320s), and any
  stall budget shorter than that kills the install mid-flight and leaves a
  stale `_npx/<hash>/concurrency.lock`. The default 600s stall survives it.
  Recorded as a failure mode in `claude-advisor`'s SKILL.
- **zai and qwen quota walls have EXPIRED** (reset 2026-10-23 17:28; recorded
  here when they were live). gemini-4-argon's 68 h wall expired ~2026-10-24.
  Treat those lanes as candidates again, and MEASURE rather than quote this
  paragraph either way — the 2026-10-26 note below is the pattern: what a
  lane "cannot do" changed twice in four days.
- **`~/.config/tmux-teams/lanes.json` pins `agy → gemini-3.8-flash-high`
  machine-wide** (recorded 2026-10-30). It is a hand-workaround of the same
  quota the v0.48.0 fallback now handles in the skill, and it makes
  `tests/acp-lanes-mcp.test.mjs` fail on this machine (the test pins the
  shipped default). Move it aside to measure a green suite; whether it should
  be deleted now that the skill falls back on its own is Master's call.
- **The gpt-6-sol prohibition gap in `acp-companion.mjs` is CLOSED** (this
  session). The companion's `PROHIBITED_MODEL` now carries the same
  `(gemini 3.1 | gpt-6-sol)` alternation and refusal wording as
  `acp-dispatch.mjs` and `review-profiles.mjs` — all three verified
  character-identical, with the drift test (`tests/review-policy.test.mjs:861`)
  passing. Previously the companion blocked Gemini 3.1 only and silently
  accepted the retired `gpt-6-sol`; the dispatch test caught it.

## 7. WHERE THINGS LIVE

```
ROADMAP.md                                 the standing goal; gated, not exempt
plugins/tmux-teams/skills/tmux-teams/scripts/
  acp-companion.mjs:2711                   CREDENTIAL_ENV_KEYS
  acp-companion.mjs:2712                   profileCarriesToken
  acp-companion.mjs:2785                   envCarriesToken
  acp-companion.mjs:2788                   claudeBareByDefault
  advisor-party.mjs:31,99                  party_substituted and its check
  advisor-party.mjs:148                    NEUTRALISED — substitution, not deletion
  advisor-party.mjs:175                    CONTROL_CHARS — \p{C}
  advisor-party.mjs:202                    MARKUP_OPENER — the tokenizer's rule
  advisor-party.mjs:256                    CHARACTER_REFERENCE — the closed set
  advisor-party.mjs:271                    VISIBLE
  acp-dispatch.mjs                         the operator's entry to a lane
  findings-board.mjs                       the shared findings board (v0.47.0 work)
  agy-seat-fallback.mjs                    AGY quota fallback: classify + seat map (v0.48.0)
plugins/tmux-teams/skills/requirement-audit/SKILL.md   shipped in v0.44.0
plugins/tmux-teams/skills/{claude,codex,agy}-advisor/SKILL.md
tests/plugin-structure.test.mjs:15         SKILLS — the list of record
tests/plugin-structure.test.mjs:18         RELEASE_VERSION
tests/advisor-party.test.mjs               nine tests
tests/agy-seat-fallback.test.mjs           ten tests (v0.48.0)
tests/acp-companion.test.mjs               seven bare-mode cases, nine runs
tests/worker-isolation.test.mjs            three more, profile source only
tests/fixtures/mock-acp-agent.mjs          PLAINTEXT_SAFE_KEYS — under a 64 KiB bound
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
~/tt-panel/                                twelve rounds of packets, run dirs, read-r<N>.py
~/.config/claude-profiles/                 the gateway profiles the lanes route through
~/.config/tmux-teams/lanes.json            the per-machine lane file (absent = normal)
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
Release: `https://github.com/iicmaster/tmux-teams/releases/tag/v0.46.0`
