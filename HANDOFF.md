# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-09-03 through `bmad-party-mode` (installed; roster Mary, John,
Sally, Winston, Amelia, with the adversary seat taken by Grumbal from
`code-review-crew`).

## 1. READ THIS FIRST

- On `main`, clean, in sync with `origin/main`. No open pull requests. No
  branch is waiting to be pushed.
- **v0.37.0 IS RELEASED** — tagged on the merged sha `cd9a90a`, GitHub release
  published, marketplace and plugin cache moved 0.36.0 → 0.37.0.
- **`main` carries ONE UNRELEASED SKILL**: `requirement-audit`, merged in
  `0319e3a`. Every version file still says 0.37.0, which is correct — it ships
  with the next release, and nobody has it yet.
- **The most dangerous thing here is the panel.** `node scripts/gate-required.mjs`
  answers REQUIRED for v0.38.0 and names two deciding files. The previous
  release ran TWELVE panel rounds; do not assume that waiver carries forward. It
  was for v0.37.0's bytes and Master granted it once.
- Nothing in the tree is broken. The suite is green and both published gates
  are current.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036          # or any clone of iicmaster/tmux-teams
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1202 pass / 0 fail / 0 skipped`** — measured 2026-09-03 on `0319e3a`.

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
node scripts/gate-required.mjs      # 2 — panel owed for v0.38.0
```

All four measured 2026-09-03.

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

### On `main` and NOT released: `requirement-audit`

`plugins/tmux-teams/skills/requirement-audit/SKILL.md` — a 12-point requirement
contract: six Grill categories for content, INVEST for shape. It sat as an open
pull request with red CI from 2026-08-28 until 2026-09-01.

**The skill was never the problem.** Its branch added one file and registered it
nowhere, and two assertions failed with one cause: `SKILLS` at
`tests/plugin-structure.test.mjs:15` is the list of record, and the directory
disagreed with it. Registering a new skill takes three edits the folder cannot
carry itself:

1. `SKILLS` at `tests/plugin-structure.test.mjs:15` — read by both the structure
   test and the portable-root check.
2. The README skill table.
3. The README heading's COUNT. It said "the thirteen skills" while fourteen
   ship, and a test names the number it wants.

`RELEASE_VERSION` is at `tests/plugin-structure.test.mjs:18` and still reads
`'0.37.0'`. Fourteen skills ship from `main`.

### What v0.38.0 owes

`node scripts/gate-required.mjs` answers REQUIRED and names
`plugins/tmux-teams/skills/requirement-audit/SKILL.md` and
`tests/plugin-structure.test.mjs`. The bump itself is seven places in six files
— `.claude-plugin/marketplace.json` twice, `plugins/tmux-teams/plugin.json`,
`plugins/tmux-teams/.claude-plugin/plugin.json`,
`tests/plugin-structure.test.mjs`, `README.md`, `ROADMAP.md` — and bumping
`ROADMAP.md` makes the published page stale, so the roadmap step is not optional.

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

- **`requirement-audit` has never been invoked.** It is registered, its
  frontmatter satisfies the contract, and the structure tests pass — all of
  which is about REGISTRATION. Nobody has run the skill against a real
  requirement, and it is not in any installed plugin cache yet.
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
plugins/tmux-teams/skills/requirement-audit/SKILL.md   merged, unreleased
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
Release: `https://github.com/iicmaster/tmux-teams/releases/tag/v0.37.0`
