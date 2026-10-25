# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-10-17 for v0.45.0 release; updated 2026-10-26 for v0.46.0.

## 1. READ THIS FIRST

- **v0.46.0 IS PREPARED** — version bumped to 0.46.0 across 6 files / 7 places,
  published roadmap page current (v20, recorded `49f51b7e…`).
- **What ships in v0.46.0** (on top of the already-committed `8eed50a`
  token-usage record):
  1. `gpt-6-sol` prohibition enforced in `acp-companion.mjs` — the companion's
     `PROHIBITED_MODEL` now matches `acp-dispatch.mjs` and `review-profiles.mjs`
     (Gemini 3.1 banned, gpt-6-sol retired, gpt-6.1-sol the frontier).
  2. `pm-delegation` prepare phase audits every ticket through
     `requirement-audit` before dispatch (NOT READY pauses ticket + dependents;
     re-audit on change); `requirement-audit` documents the caller.
  3. `claude-advisor` gains the 9Router seat: alias table read from
     `~/.claude-9r/settings.json` (fable→advisor, opus→thinker[1m],
     sonnet→worker[1m], haiku→flash, endpoint 127.0.0.1:20128), direct naming
     of the router's claude-shaped model ids (`claude-glm-5.3` verified end to
     end: `effective_identity: claude-glm-5.3 (matched)`, outcome succeeded,
     2026-10-26), and the cold-npx-cache boot failure mode with the 620ms
     direct-spawn control.
- **The claude lane works again on this machine** — see the correction in
  section 6b before quoting "cannot start" from it.
- **Gate**: `review-gate.mjs` was attempted twice and blocked both times on
  machine plumbing (homebrew node is outside the trusted-roots list — rerun
  with nvm's npx on PATH; then the gate's pinned codex profile demanded an
  unadvertised reasoning_effort option and its qwen lane died at npx exit
  127). The panel then ran on the CLAUDE.md macOS direct-ACP path, one run
  directory per lane. Round 1 (codex `gpt-6.1-sol[ultra]`, agy
  `gemini-4-argon-high`, both matched) returned five blocking findings each;
  all ten were resolved in `dcfb5a6` and `9e1dc48` — the largest being that
  **`8eed50a` was assembled from stale bytes and reverted three post-v0.44
  changes** (agy pin 1.2.0→1.0.0 twice, the gpt-6-sol prohibition arm, and the
  gpt-6-luna test fixtures). The qwen and kimi gateways both refused the
  prompt with "Authentication required" after a matched identity (expired
  credentials, not this repo), so **the third family leg could not be seated
  on this machine — the release is 2/3 and blocked on that leg; only Master
  waives it** (CLAUDE.md release flow step 2). Round 2 verdicts (final bytes):
  see the GitHub release notes. Suite **1234 pass / 0 fail / 0 skipped**
  (2026-10-26); `claude plugin validate --strict` passed; `roadmap-gate` 0
  (page v20, `49f51b7e…`).

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036          # or any clone of iicmaster/tmux-teams
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1234 pass / 0 fail / 0 skipped`** — measured 2026-10-26 on the
v0.46.0 release tree.

**Gate on the count, never on a grep of the output.** `node --test | grep '✖'`
exits 0 when it FINDS failures, so chaining a commit after it with `&&` commits
on red. That happened in the v0.37.0 session and it is the third time this
repository has recorded it.

**Do not run the suite while ACP lanes are live.** A run under contention
measures the contention.

```bash
git diff --check                    # clean
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 — the published page is current
node scripts/gate-required.mjs      # 2 — fail-closed on the empty post-tag range; the panel is recorded (section 1)
```

The first two lines were measured 2026-09-03 in the v0.37.0 verify block and
have held through every release since; the gate-required line's post-tag
behavior is new with v0.44.0 and was measured 2026-10-01 (exit 2 on the empty
`v0.44.0..HEAD` range after tagging, with the panel recorded in that release's
notes). Do not attach a historical date to a newly described behavior — a
review lane called that splice out in the v0.45.0 panel.

## 3. STATE

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
- **No panel has read anything after `e8b6ef0`.** That includes the whole
  `requirement-audit` merge.
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
- **zai and qwen are quota-exhausted until 2026-10-23 17:28** (429,
  Weekly/Monthly Limit Exhausted). gemini-4-argon is quota-exhausted for
  ~68 h from 2026-10-21 (429, Individual quota reached). The lanes that ran
  this session: codex (`gpt-6.1-sol[ultra]`) and agy (`gemini-3.8-flash-high`)
  — both receipt-verified `matched`. A three-family panel needs the quota
  reset first.
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
plugins/tmux-teams/skills/requirement-audit/SKILL.md   shipped in v0.44.0
plugins/tmux-teams/skills/{claude,codex,agy}-advisor/SKILL.md
tests/plugin-structure.test.mjs:15         SKILLS — the list of record
tests/plugin-structure.test.mjs:18         RELEASE_VERSION
tests/advisor-party.test.mjs               nine tests
tests/acp-companion.test.mjs               seven bare-mode cases, nine runs
tests/worker-isolation.test.mjs            three more, profile source only
tests/fixtures/mock-acp-agent.mjs          PLAINTEXT_SAFE_KEYS — under a 64 KiB bound
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
~/tt-panel/                                twelve rounds of packets, run dirs, read-r<N>.py
~/.config/claude-profiles/                 the gateway profiles the lanes route through
~/.config/tmux-teams/lanes.json            the per-machine lane file (absent = normal)
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
Release: `https://github.com/iicmaster/tmux-teams/releases/tag/v0.40.0`
