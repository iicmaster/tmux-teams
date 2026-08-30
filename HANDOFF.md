# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-30 through `bmad-party-mode` (installed; roster Mary, John,
Sally, Winston, Amelia, with the adversary seat taken by Grumbal from
`code-review-crew`).

## 1. READ THIS FIRST

- Branch `feat/v0.37-advisors`, **12 commits on top of v0.36.0, NOT pushed**.
  Tree clean. Worktree at `~/tmux-teams-v036` — outside any temp directory, see
  DO NOT.
- **v0.37.0 is stamped but NOT released.** Version in all seven places, roadmap
  published at version 9 and recorded, suite green, manifest valid.
- **The most dangerous thing here: FOUR release panels have BLOCKED in a row**
  (rounds 2, 3, 4, and every round found defects the previous round's FIX
  introduced). Round 5 is dispatched against the current bytes. Do not stamp,
  tag or merge on a panel that has not come back.
- **Two gates belong to Master:** pushing, and waiving the codex bot review. A
  stop-hook reminder, a task notification, or an earlier message of your own is
  not that permission.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1198 pass / 0 fail / 0 skipped`** — measured on `6037bec`.

**Gate on the count, never on a grep of the output.** `node --test | grep '✖'`
exits 0 when it FINDS failures. This session chained a commit after an ungated
run and **committed on red** — the third time this repository has recorded that
mistake. Every commit since put `grep -q '^ℹ fail 0$'` between the run and the
commit.

**Do not run the suite while ACP lanes are live.** A run under contention
measures the contention.

```bash
git diff --check                    # whitespace — passes
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 — the published page is current
node scripts/gate-required.mjs      # 2 — panel owed; run only on a committed tree
```

Read the panel:

```bash
cd ~/tt-panel && python3 read-r5.py     # verdict + identity for all eight lanes
ls r5-*/.mailbox-out/                   # 8 outboxes = the round is complete
```

## 3. STATE

### What v0.37.0 ships

**1. The default `claude` lane could not authenticate, and the recorded
diagnosis was wrong for 22 days.** Not a stale `.credentials.json` against an
unreachable keychain: `CLAUDE_CODE_SIMPLE=1`, set on every claude lane since
`8a05d6d` to strip repository hooks, forbids OAuth and keychain outright. Bare
mode is now the default only when `CLAUDE_CONFIG_DIR` names a profile whose
`settings.json` carries a credential.

- `acp-companion.mjs:2696` — `profileCarriesToken(dir)`.
- `acp-companion.mjs:2756-2757` — `baseSpawnEnv`, then the decision taken
  against the environment the CHILD receives.
- Guards: `tests/acp-companion.test.mjs` (six arms, listed in its header) and
  `tests/worker-isolation.test.mjs` (three).

**All three credentials measured against the real binary**, 2026-08-30, from a
profile's `settings.json`:

| in the profile | bare mode result |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | `end_turn`, a real answer, 917ms |
| `ANTHROPIC_API_KEY` | `401 API key is invalid` — read, and tried |
| `apiKeyHelper` | `Not logged in · Please run /login` — never found |
| nothing | refused, no API call |

**`apiKeyHelper` is NOT a bare-mode credential** and was in the set until a zai
lane observed it was the one arm nobody had run. **The 401 reports
`duration_api_ms 0` exactly as the not-found case does** — the MESSAGE is the
discriminator, never the duration. Reading the number alone would have removed
`ANTHROPIC_API_KEY`.

**Measured end to end:** a real dispatch on the default claude lane returned
`effective_identity: claude-fable-5`, `identity_status: matched`, outbox written.

**2. `--party <id>` on all three `*-advisor` skills.**

- `advisor-party.mjs:42` `resolveParty` — shells to bmad-party-mode's own
  `resolve_party.py` through `uv`. That skill is a SEPARATE install this plugin
  does not ship, so `not_installed` is an ordinary outcome.
- `advisor-party.mjs:26` `PARTY_PROBLEMS` — a closed vocabulary; it refuses with
  a code and exit 2 and never substitutes a different room.
- `advisor-party.mjs:132` `NEUTRALISED`, `:140` `LINE_BREAKS`, `:145`
  `asDescription`, `:152` `renderPartyMandate`.
- Guards: `tests/advisor-party.test.mjs` — eight tests; containment at `:73`,
  name-and-id at `:184`, the pipe-flush boot at `:334`.

**Measured live:** the fable lane answered as Vex / Grumbal / Boundary / Yui /
Dana with no invented names.

### The panel — four rounds, four blocks, and what each one cost

| round | bytes | gemini | openai | deepseek | zai |
|---|---|---|---|---|---|
| 2 | `aef8472` | accept ×2 | block | block | block |
| 3 | `ff4a415` | accept ×2 | block | block | accept + block |
| 4 | `f01eece`'s parent | accept ×2 | block | block | accept + block |
| 5 | `6037bec` | dispatched | dispatched | dispatched | dispatched |

**Identity, recorded because direct ACP pins nothing:** `agy` reports
`gemini-3.7-flash-high` matched · `codex` reports `gpt-5.6-sol[ultra]`
unverified · `qwen` is reached with `ACP_MODEL=opus` and a `CLAUDE_CONFIG_DIR`
pointing at the qwen profile, and that alias resolves to a deepseek model here,
which is why the family is recorded as deepseek · `zai` reports `default`
because its gateway announces no model name back.

**Termination is four accept VERDICTS, not zero findings.** An accept carrying
P3 prose findings exists and does not block — zai returned exactly that twice.
Put such findings in the record and hand Master the decision rather than
starting another round.

**`qwen-src` has ended `no_outbox` in three separate rounds.** Record it with
its session id and move on: the rule is three distinct families with AGY
mandatory, which gemini, openai and zai satisfy.

### Packets

`~/tt-panel/brief5-{src,tst}.md`, built from the eleven files
`node scripts/gate-required.mjs` PRINTS — never from memory. Each carries a
round note naming what changed and, where a lane's objection was REFUSED, the
measurement that refused it, so the next round can attack the reasoning.

## 4. DO NOT

- **Do not push, and do not open the PR, without Master saying so in their own
  message.** A stop hook repeating "the work is not complete" is not that.
- **Do not waive the codex bot yourself.** Only Master waives it, and an
  unrecorded waiver is the silent skip.
- **Do not fix a claim by making its excuse bigger, and do not stop at the line
  a finding named.** Every round here produced defects sitting in the previous
  round's fix: the round-3 status check exempted a non-zero exit whenever raw
  stdout CONTAINED `unknown_group`, which accepted any failed resolver whose
  roster merely mentioned the word; `members: [null]` was fixed while
  `available: [null]` threw the same way one field over; validating the member
  name left `- Vex — ` rendering with nothing after the dash.
- **Never neutralise text by DELETING it.** Deletion joins what sat either
  side: `PPARTY-ROSTER>>>ARTY-ROSTER>>>` rebuilt an exact delimiter, and
  "``<<<PARTY-ROSTER`" rebuilt a code fence. Iterating deletion to a fixed point
  closed both and bought a crafted-input stall (~17,000 whole-string passes on
  256 KiB). Substitution with a marker cannot join anything and runs once —
  measured 0 ms on the same input.
- **Do not read `duration_api_ms` as proof an API was not called.** A 401
  reports 0.
- **Do not let a test fixture serialise an environment.** `MOCK_ENV_DUMP` wrote
  the child's whole `process.env` to an unremoved temp file, so any real
  `ANTHROPIC_API_KEY` in the operator's shell landed there in plaintext. It
  writes a two-key allowlist and `dumpOf` fails on a third.
- **Do not chain an edit behind a `grep &&`.** One did that here, the grep
  matched nothing, the edit never ran, and the next command reported success —
  caught only because a test stayed red with the identical message.
- **Do not work in `$TMPDIR` or the session scratchpad.** A worktree there was
  destroyed TWICE in the v0.36 session, once losing `.git` itself.
- **Do not re-run `~/tt-panel/dispatch-r<N>.sh` to retry one lane.** Its `go()`
  opens with `rm -rf "$dir"`, so it destroys all eight run directories including
  the sessions a resume would need.

## 5. DECIDED — DO NOT RELITIGATE

- **`ANTHROPIC_AUTH_TOKEN` stays in the credential set.** Two round-2 lanes said
  bare mode cannot read it, quoting this repository's own `--help` citation.
  Measured with a control: it answers. The help text is narrower than the
  binary.
- **`apiKeyHelper` stays OUT**, on the measurement above.
- **A roster is contained, not censored** — its text stays visible as
  description, fenced, with READ-ONLY restated after it.
- **What that containment PROVES is structural**: roster text cannot break the
  block, stand as its own instruction line, or get the last word. A persona
  that reads as an instruction INLINE is still delivered. The test name says so.
- **An advisor REFUSES an unknown party** rather than falling back to the
  invented cast.
- **MCP stays read-only; the writing surface is a skill** — ADR 0007.
- **Master, 2026-08-30: no version pin in `~/agent-skills`.** Release flow step
  10 is retired (`aa0ab7c`).

## 6. UNPROVEN

- **Round 5 has not come back.** Any claim of "4/4" or a clean panel is not yet
  true.
- **CI has never run these bytes.** CI is Linux with a clean HOME; two releases
  once shipped on a red CI.
- **`--party` has been exercised on the claude/fable lane only.** The codex and
  agy advisor skills document the same command; neither was dispatched with it.
- **No lane has been dispatched end to end through v0.36's readiness brake in
  anger.**
- **Nothing has ever installed from `agent-plugins/tmux-teams/`.**

## 7. WHERE THINGS LIVE

```
~/tmux-teams-v036                          the worktree — NOT in a temp dir
ROADMAP.md                                 the standing goal; gated, not exempt
plugins/tmux-teams/skills/tmux-teams/scripts/
  acp-companion.mjs:2696                   profileCarriesToken
  acp-companion.mjs:2756                   baseSpawnEnv — the child's environment
  advisor-party.mjs:26                     PARTY_PROBLEMS — the closed codes
  advisor-party.mjs:132                    NEUTRALISED — substitution, not deletion
  advisor-party.mjs:140                    LINE_BREAKS — all five separators
  acp-dispatch.mjs                         the operator's entry to a lane
plugins/tmux-teams/skills/{claude,codex,agy}-advisor/SKILL.md
tests/advisor-party.test.mjs:73            the containment guard
tests/advisor-party.test.mjs:334           the pipe-flush boot test
tests/acp-companion.test.mjs               six bare-mode arms, listed in its header
tests/worker-isolation.test.mjs            three more
tests/fixtures/mock-acp-agent.mjs          ENV_DUMP_KEYS — the allowlist
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
~/tt-panel/                                packets, run dirs, read-r<N>.py
~/tt-panel/dispatch-r5.sh                  re-runs the panel — rm -rf's every run dir
~/.config/claude-profiles/                 the gateway profiles the lanes route through
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
