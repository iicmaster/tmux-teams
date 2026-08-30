# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-30 through `bmad-party-mode` (installed; roster Mary, John,
Sally, Winston, Amelia, with the adversary seat taken by Grumbal from
`code-review-crew`).

## 1. READ THIS FIRST

- Branch `feat/v0.37-advisors`, **17 commits on top of v0.36.0, NOT pushed**.
  Tree clean. Worktree at `~/tmux-teams-v036` — outside any temp directory.
- **v0.37.0 is stamped but NOT released.** Version in all seven places, roadmap
  published at version 12 and recorded, suite 1199 green, manifest valid.
- **SIX release panels have run and FIVE blocked.** Every round found defects
  the previous round's FIX introduced, and by round 5 most findings were against
  GUARDS written in this loop. Round 6's findings are fixed in `644568a`; **no
  panel has read those bytes.**
- **The session STOPPED here on purpose.** Master decides what happens next:
  another round, or a recorded waiver. Do not self-dispatch round 7.
- **Two gates belong to Master:** pushing, and waiving the codex bot review. A
  stop-hook reminder, a task notification, or an earlier message of your own is
  not that permission.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1199 pass / 0 fail / 0 skipped`** — measured on `644568a`.

**Gate on the count, never on a grep of the output.** `node --test | grep '✖'`
exits 0 when it FINDS failures. This session chained a commit after an ungated
run and **committed on red** — the third time this repository has recorded that
mistake. Every commit since put `grep -q '^ℹ fail 0$'` between run and commit.

**Do not run the suite while ACP lanes are live.** A run under contention
measures the contention.

```bash
git diff --check                    # whitespace — passes
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 — the published page is current
node scripts/gate-required.mjs      # 2 — panel owed; run only on a committed tree
cd ~/tt-panel && python3 read-r6.py # the last panel's verdicts and identities
```

## 3. STATE

### What v0.37.0 ships

**1. The default `claude` lane could not authenticate, and the recorded
diagnosis was wrong for 22 days.** Not a stale `.credentials.json` against an
unreachable keychain: `CLAUDE_CODE_SIMPLE=1`, set on every claude lane since
`8a05d6d` to strip repository hooks, forbids OAuth and keychain outright.

Bare mode is now the default only when a credential is actually REACHABLE —
in the lane's own environment, or in the `settings.json` of the profile
`CLAUDE_CONFIG_DIR` names. Both sources count; reading only the profile was
itself a regression that silently handed repository hooks back to
environment-credentialled lanes.

- `acp-companion.mjs:2697` `CREDENTIAL_ENV_KEYS` · `:2698` `profileCarriesToken`
  · `:2771` `envCarriesToken` · `:2774` `claudeBareByDefault`.
- An explicit `CLAUDE_CODE_SIMPLE` still wins, and an EMPTY one is not explicit.
- Guards: `tests/acp-companion.test.mjs` (seven arms, listed in its header) and
  `tests/worker-isolation.test.mjs` (three, profile source only).

**The credential matrix, measured against the real binary 2026-08-30:**

| credential | from the profile | from the environment |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | answers, `end_turn`, 917ms | `401 Invalid bearer token` |
| `ANTHROPIC_API_KEY` | `401 API key is invalid` | `401 API key is invalid` |
| `apiKeyHelper` | `Not logged in · Please run /login` | not tested |
| nothing | refused, no API call | — |

A 401 means the credential was READ AND TRIED. **`duration_api_ms` is 0 for a
401 exactly as it is for "never found", so the MESSAGE is the discriminator and
the duration is not** — reading the number alone would have removed
`ANTHROPIC_API_KEY`, the one credential the CLI's help text names outright.

**Measured end to end:** a real dispatch on the default claude lane returned
`effective_identity: claude-fable-5`, matched, outbox written.

**2. `--party <id>` on all three `*-advisor` skills.**

- `advisor-party.mjs:43` `resolveParty` — shells to bmad-party-mode's own
  `resolve_party.py` through `uv`; that skill is a SEPARATE install this plugin
  does not ship, so `not_installed` is an ordinary outcome.
- `advisor-party.mjs:26` `PARTY_PROBLEMS` — the closed refusal codes, including
  `:31` `party_substituted`, enforced at `:99`: the resolver's `active` must
  equal the id that was asked for.
- `advisor-party.mjs:148` `NEUTRALISED` · `:156` `LINE_BREAKS` · `:161`
  `asDescription` · `:168` `renderPartyMandate`.
- Guards: `tests/advisor-party.test.mjs`, nine tests.
- Exit `0` success, `2` a named refusal, `1` a usage error. All three
  documented in all three SKILL.md files.

**Measured live:** the fable lane answered as Vex / Grumbal / Boundary / Yui /
Dana with no invented names.

### The panel record

| round | bytes | gemini | openai | deepseek | zai |
|---|---|---|---|---|---|
| 2 | `aef8472` | accept ×2 | block ×2 | block | block + accept |
| 3 | `ff4a415` | accept ×2 | block ×2 | block | accept + block |
| 4 | `4a9…`(pre-`f01eece`) | accept ×2 | block ×2 | block | accept ×2 |
| 5 | `6037bec` | accept ×2 | block ×2 | no_outbox ×2 | accept ×2 |
| 6 | `644f612` | accept + no_outbox | block ×2 | accept + no_outbox | accept + block |

**Identity, recorded because direct ACP pins nothing:** `agy` =
`gemini-3.7-flash-high`, matched · `codex` = `gpt-5.6-sol[ultra]`, unverified ·
`qwen` is reached with `ACP_MODEL=opus` and a `CLAUDE_CONFIG_DIR` pointing at
the qwen profile; that alias resolves to a deepseek model here, which is why the
family is recorded as deepseek · `zai` = `default`, unverified, because its
gateway announces no model name back.

**Findings per round: 4 → 13 → 6 → 13 → 6 → 6.** P1s stopped after round 3.
Rounds 5 and 6 were almost entirely findings against guards written in this
loop, plus prose that had not caught up with the code.

**Between rounds, the built-in `advisor` found five more** — the backtick fence
rebuilt by delimiter deletion, the `unknown_group` substring exemption, the
`available: [null]` crash, the dangling `- Vex — `, and the environment-credential
regression. Each was REPRODUCED on the committed bytes before being changed.
That order (advisor → fix → panel) is cheaper than a panel round and caught
things the panel had passed.

**`qwen` and `agy` have each ended `no_outbox`.** Session ids are in the tails of
`~/tt-panel/r<N>-<lane>-<part>.log`. Resume is worth trying for the SAME bytes;
for changed bytes it would record a review of a diff that no longer exists.

### Packets

`~/tt-panel/brief6-{src,tst}.md`, built from the eleven files
`node scripts/gate-required.mjs` PRINTS — never from memory. Each carries a
round note naming what changed and, where an objection was REFUSED, the
measurement that refused it.

## 4. DO NOT

- **Do not push, and do not open the PR, without Master saying so in their own
  message.**
- **Do not waive the codex bot yourself.** Only Master waives it, and an
  unrecorded waiver is the silent skip.
- **Do not fix a claim by making its excuse bigger, and never stop at the line a
  finding named.** Every round here produced defects in the previous round's
  fix, and the neighbours of a finding are where they were: `members: [null]`
  was fixed while `available: [null]` threw the same way one field over;
  validating a member's name left `- Vex — ` rendering with nothing after it;
  the `unknown_group` exemption written to close a fail-open reopened it through
  a substring match.
- **Never neutralise text by DELETING it.** Deletion joins what sat either side:
  `PPARTY-ROSTER>>>ARTY-ROSTER>>>` rebuilt an exact delimiter, and
  "``<<<PARTY-ROSTER`" rebuilt a code fence. Iterating deletion to a fixed point
  closed both and bought a crafted-input stall (~17,000 whole-string passes on
  256 KiB). Substitution with a marker cannot join anything — measured 0 ms.
- **Do not read `duration_api_ms` as proof no API call was made.** A 401
  reports 0.
- **Do not let a test inherit the runner's credentials.** The bare-mode arms
  would have failed on any machine whose shell exports `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN` while CI stayed green. They scrub all three variables
  now. This repository has already lost two releases to a local/CI gap.
- **Do not let a test fixture serialise an environment.** `MOCK_ENV_DUMP` wrote
  the child's whole `process.env` to an unremoved temp file.
- **Do not chain an edit behind `grep && python`.** One did here, the grep
  matched nothing, the edit never ran, and the next command reported success —
  caught only because a test stayed red with the identical message.
- **Do not read a panel outbox by stripping `TEAM_DONE` alone.** A blocking lane
  ends `TEAM_BLOCKED`, and the reader silently reported "not JSON" for a
  four-finding block. `~/tt-panel/read-r*.py` strips all three sentinels now.
- **Do not work in `$TMPDIR` or the session scratchpad.** A worktree there was
  destroyed TWICE in the v0.36 session, once losing `.git` itself.
- **Do not re-run `~/tt-panel/dispatch-r<N>.sh` to retry one lane.** Its `go()`
  opens with `rm -rf "$dir"` and destroys all eight run directories.

## 5. DECIDED — DO NOT RELITIGATE

- **`ANTHROPIC_AUTH_TOKEN` stays a bare-mode credential** (round-2 objection,
  overruled on measurement: it answers).
- **`apiKeyHelper` is NOT one** (round-4 objection, upheld on measurement).
- **A credential in the environment counts as well as one in a profile.**
- **A roster is contained, not censored.** Its text stays visible as
  description, fenced, with READ-ONLY restated after it.
- **What that containment PROVES is structural**: roster text cannot break the
  block, stand as its own instruction line, or get the last word. A persona that
  reads as an instruction INLINE is still delivered. The test name says so.
- **An advisor REFUSES an unknown or substituted party** rather than falling
  back to the invented cast.
- **MCP stays read-only; the writing surface is a skill** — ADR 0007.
- **Master, 2026-08-30: no version pin in `~/agent-skills`.** Release flow step
  10 is retired (`aa0ab7c`).

## 6. UNPROVEN

- **No panel has read `644568a`.** Round 6's fixes are unreviewed.
- **CI has never run these bytes.** CI is Linux with a clean HOME; two releases
  once shipped on a red CI.
- **`--party` has been exercised on the claude/fable lane only.** The codex and
  agy advisor skills document the same command; neither was dispatched with it.
- **`apiKeyHelper` was measured from a profile only**, not from the environment.
- **No lane has been dispatched end to end through v0.36's readiness brake in
  anger.**
- **Nothing has ever installed from `agent-plugins/tmux-teams/`.**

## 7. WHERE THINGS LIVE

```
~/tmux-teams-v036                          the worktree — NOT in a temp dir
ROADMAP.md                                 the standing goal; gated, not exempt
plugins/tmux-teams/skills/tmux-teams/scripts/
  acp-companion.mjs:2697                   CREDENTIAL_ENV_KEYS
  acp-companion.mjs:2698                   profileCarriesToken
  acp-companion.mjs:2771                   envCarriesToken
  acp-companion.mjs:2774                   claudeBareByDefault
  advisor-party.mjs:26                     PARTY_PROBLEMS — the closed codes
  advisor-party.mjs:99                     the no-substitution check
  advisor-party.mjs:148                    NEUTRALISED — substitution, not deletion
  advisor-party.mjs:156                    LINE_BREAKS — all five separators
  acp-dispatch.mjs                         the operator's entry to a lane
plugins/tmux-teams/skills/{claude,codex,agy}-advisor/SKILL.md
tests/advisor-party.test.mjs               nine tests
tests/acp-companion.test.mjs               seven bare-mode arms, listed in its header
tests/worker-isolation.test.mjs            three more, profile source only
tests/fixtures/mock-acp-agent.mjs          ENV_DUMP_KEYS — the allowlist
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
~/tt-panel/                                packets, run dirs, read-r<N>.py
~/tt-panel/dispatch-r6.sh                  re-runs the panel — rm -rf's every run dir
~/.config/claude-profiles/                 the gateway profiles the lanes route through
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
