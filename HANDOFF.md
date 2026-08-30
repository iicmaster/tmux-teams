# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-31 through `bmad-party-mode` (installed; roster Mary, John,
Sally, Winston, Amelia, with the adversary seat taken by Grumbal from
`code-review-crew`).

## 1. READ THIS FIRST

- Branch `feat/v0.37-advisors`, **23 commits on top of v0.36.0, NOT pushed**.
  Tree clean. Worktree at `~/tmux-teams-v036`.
- **v0.37.0 is stamped, gated and WAIVED, but NOT released.** Version in all
  seven places, roadmap published at version 12 and recorded, suite 1202 green,
  manifest valid.
- **TWELVE release panels ran. Master waived the thirteenth on 2026-08-31** —
  see THE WAIVER below. That waiver is the record; do not treat the release as
  ungated, and do not start round 13 to "confirm" it.
- **Pushing is still Master's gate and has NOT been given.** So is waiving the
  codex bot review on the PR, which is a SEPARATE gate from the panel waiver.
- Nothing here is dangerous to touch. The danger is procedural: this branch
  looks finished, and two gates that belong to Master are still open.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1202 pass / 0 fail / 0 skipped`** — measured on `e8b6ef0`.

**Gate on the count, never on a grep of the output.** `node --test | grep '✖'`
exits 0 when it FINDS failures. This session committed on red once that way —
the third time this repository has recorded it. Every commit after put
`grep -q '^ℹ fail 0$'` between the run and the commit.

**Do not run the suite while ACP lanes are live.**

```bash
git diff --check                    # whitespace — passes
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 — the published page is current
node scripts/gate-required.mjs      # 2 — panel owed; run only on a committed tree
cd ~/tt-panel && python3 read-r12.py   # the last panel's verdicts and identities
```

## 3. STATE

### What v0.37.0 ships

**1. The default `claude` lane could not authenticate, and the recorded
diagnosis was wrong for 22 days.** Not a stale `.credentials.json` against an
unreachable keychain: `CLAUDE_CODE_SIMPLE=1`, set on every claude lane since
`8a05d6d` to strip repository hooks, forbids OAuth and keychain outright.

Bare mode is the default only when a credential is REACHABLE — in the lane's own
environment, or in the `settings.json` of the profile `CLAUDE_CONFIG_DIR` names.

- `acp-companion.mjs:2711` `CREDENTIAL_ENV_KEYS` · `:2712` `profileCarriesToken`
  · `:2785` `envCarriesToken` · `:2788` `claudeBareByDefault`.
- An explicit `CLAUDE_CODE_SIMPLE` wins; an EMPTY one is not explicit.
- Guards: `tests/acp-companion.test.mjs` (seven labelled cases, nine `dumpOf`
  runs — both numbers are in its header because one alone rotted three times)
  and `tests/worker-isolation.test.mjs` (three, profile source only).

**The credential matrix, measured against the real binary, 2026-08-30:**

| credential | from the profile | from the environment |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | answers, `end_turn`, 917ms | `401 Invalid bearer token` |
| `ANTHROPIC_API_KEY` | `401 API key is invalid` | `401 API key is invalid` |
| `apiKeyHelper` | `Not logged in · Please run /login` | not tested |
| nothing | refused, no API call | — |

A 401 means the credential was READ AND TRIED. **`duration_api_ms` is 0 for a
401 exactly as for "never found", so the MESSAGE is the discriminator** —
reading the number alone would have removed `ANTHROPIC_API_KEY`.

**2. `--party <id>` on all three `*-advisor` skills.**

- `advisor-party.mjs:99` — the resolver's `active` must equal the id asked for;
  `:31` `party_substituted` is the code when it does not.
- `:148` `NEUTRALISED` — substitution, never deletion. Deletion joins what sat
  either side and rebuilt both a fence delimiter and a code fence.
- `:175` `CONTROL_CHARS = /\p{C}/gu` · `:202` `MARKUP_OPENER` · `:256`
  `CHARACTER_REFERENCE` · `:271` `VISIBLE`.
- Exit `0` success, `2` a named refusal, `1` a usage error — all three
  documented in all three SKILL.md files.
- Guards: `tests/advisor-party.test.mjs`, nine tests.

**Measured live:** the fable lane answered as Vex / Grumbal / Boundary / Yui /
Dana with no invented names.

### THE WAIVER — Master, 2026-08-31

**Twelve panel rounds ran; eleven blocked. Master waived the thirteenth.** This
line is the record the release flow requires; it belongs in the PR body and the
GitHub release notes verbatim:

> `Gate: panel waived by Master after 12 rounds.` Rounds 11 and 12 each had
> **gemini accept both packets and zai accept both packets**; only the openai
> lane blocked, on P2/P3 findings. Every finding from all twelve rounds is
> fixed or explicitly refused with its reason in the code. The final commit
> `e8b6ef0` has not been read by a panel.

**Identity, recorded because direct ACP pins nothing:** `agy` =
`gemini-3.7-flash-high`, matched · `codex` = `gpt-5.6-sol[ultra]`, unverified ·
`qwen` reached with `ACP_MODEL=opus` and the qwen profile, which resolves to a
deepseek model here · `zai` = `default`, unverified, gateway announces no name.

**Findings per round: 4, 13, 6, 13, 6, 6, 6, 10, 4, 2, 4, 4.** P1s stopped after
round 3 and returned twice. From round 5 on, most findings were against GUARDS
written during the loop rather than against the release's own scope.

**Five classes were enumerated and had to become rules** — this is the most
reusable thing the twelve rounds produced:

| class | started as | ended as |
|---|---|---|
| line breaks | `[\r\n]` | seven codepoints, then subsumed |
| control/format | hand-kept C0/C1 | `\p{C}` |
| blank-rendering names | ten codepoints | `\p{Default_Ignorable_Code_Point}` + U+2800 |
| character references | `&#?[a-zA-Z0-9]{1,10};` | numeric any form + a closed named set |
| "looks like a secret" | six substrings | INVERTED — name what is safe to print |

**One finding was REFUSED with its reasoning in the code**: `queue<limit` is
still neutralised, because `<` before an ASCII letter is TAG OPEN in the HTML
tokenizer and really can swallow the closing fence, while `<` before a digit is
not. See `advisor-party.mjs` above `MARKUP_OPENER`.

**Three earlier objections were refused on measurement** and are in section 5.

### Packets

`~/tt-panel/brief12-{src,tst}.md`, built from the eleven files
`node scripts/gate-required.mjs` PRINTS — never from memory.

## 4. DO NOT

- **Do not push, and do not open the PR, without Master saying so in their own
  message.** The panel waiver is NOT that permission, and neither is a stop hook.
- **Do not waive the codex bot yourself.** It is a separate gate from the panel.
- **Do not start round 13.** Master closed the loop. Findings were still
  arriving, and would have continued; that was the reason for the waiver, not an
  argument against it.
- **Never neutralise text by DELETING it.** Deletion joins what sat either side:
  `PPARTY-ROSTER>>>ARTY-ROSTER>>>` rebuilt an exact delimiter, and
  "``<<<PARTY-ROSTER`" rebuilt a code fence. Substitution cannot, and is linear.
- **Over-neutralising is a defect too.** The mandate carries what the operator
  saved. `risk<10%`, `n<3`, `Rock &roll;`, `Tom &Harry;`, `AT&T`, `Q&A` and
  `a & b` must survive intact, and are asserted to.
- **Do not read `duration_api_ms` as proof no API call was made.** A 401
  reports 0.
- **Do not let a test inherit the runner's credentials**, and do not let a
  fixture serialise an environment. Both happened here.
- **`tests/fixtures/mock-acp-agent.mjs` has a 64 KiB HARD BOUND** the companion
  enforces on an adapter entry. Twelve lines of comment took it past and 39
  tests went red *naming a checksum*, because one condition answered three facts
  with one sentence. Both halves are fixed and guarded; explain in the TEST.
- **Do not chain an edit behind `grep && python`.** One did here, the grep
  matched nothing, the edit never ran, and the next command reported success.
- **Do not read a panel outbox by stripping `TEAM_DONE` alone** — a blocking
  lane ends `TEAM_BLOCKED`. `~/tt-panel/read-r*.py` strips all three sentinels.
- **Do not name a test variable `secret`.** The repository's pre-commit scanner
  blocks the commit, correctly: it cannot tell a decoy from a credential by name.
- **Do not re-run `~/tt-panel/dispatch-r<N>.sh` to retry one lane.** Its `go()`
  opens with `rm -rf "$dir"`.
- **Do not work in `$TMPDIR` or the session scratchpad.**

## 5. DECIDED — DO NOT RELITIGATE

- **`ANTHROPIC_AUTH_TOKEN` stays a bare-mode credential** (round-2 objection,
  overruled on measurement: it answers).
- **`apiKeyHelper` is NOT one** (round-4 objection, upheld on measurement).
- **A credential in the environment counts as well as one in a profile.**
- **`queue<limit` is neutralised** (round-12 objection, refused on the HTML
  tokenizer's tag-open rule).
- **A roster is contained, not censored**, and what containment PROVES is
  structural: roster text cannot break the block, stand as its own instruction
  line, or get the last word. A persona that reads as an instruction INLINE is
  still delivered.
- **An advisor REFUSES an unknown or substituted party.**
- **MCP stays read-only; the writing surface is a skill** — ADR 0007.
- **Master, 2026-08-30: no version pin in `~/agent-skills`.** Release flow step
  10 is retired (`aa0ab7c`).
- **Master, 2026-08-31: the panel is waived after twelve rounds.**

## 6. UNPROVEN

- **No panel has read `e8b6ef0`.** The waiver covers this; the fact stands.
- **CI has never run these bytes.** CI is Linux with a clean HOME; two releases
  once shipped on a red CI.
- **`--party` has been exercised on the claude/fable lane only.**
- **`apiKeyHelper` was measured from a profile only**, not from the environment.
- **The sanitizer is measured against the payloads named in this file and in the
  tests.** It is not proved complete, and the comments say which parts are a
  closed spec and which are a bounded denylist.
- **Nothing has ever installed from `agent-plugins/tmux-teams/`.**

## 7. WHERE THINGS LIVE

```
~/tmux-teams-v036                          the worktree
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
plugins/tmux-teams/skills/{claude,codex,agy}-advisor/SKILL.md
tests/advisor-party.test.mjs               nine tests
tests/acp-companion.test.mjs               seven bare-mode cases, nine runs
tests/worker-isolation.test.mjs            three more, profile source only
tests/fixtures/mock-acp-agent.mjs          PLAINTEXT_SAFE_KEYS — 64 KiB bound
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
~/tt-panel/                                twelve rounds of packets and run dirs
~/.config/claude-profiles/                 the gateway profiles the lanes route through
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
