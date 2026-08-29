# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-30 through `bmad-party-mode`.

## 1. READ THIS FIRST

- Branch `feat/v0.36-setup`, **20 commits, NOT pushed**. Tree clean. It lives in
  a worktree at `~/tmux-teams-v036`, deliberately outside any temp directory —
  see DO NOT.
- **v0.36.0 is complete and stamped but NOT released.** Everything up to the
  push is done: five scope items shipped, version bumped in all seven places,
  roadmap published and recorded, suite green, manifest valid, FIVE panel rounds
  run across FOUR model families.
- **Two gates remain and BOTH belong to Master, not to you.** Pushing needs
  explicit permission. The codex bot review is missing and only Master waives
  it. Do not read a stop-hook reminder, a task notification, or your own earlier
  message as that permission — none of them is the user.
- The most dangerous thing here is not in the code. **This release produced
  EIGHTEEN defects of one shape and seventeen were found by review lanes rather
  than by tests.** The shape is: *something claimed what it did not do.* If you
  add to this branch, assume you will produce a nineteenth — several of these
  were introduced by the fix for an earlier one.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1189 pass / 0 fail / 0 skipped`**.

**Gate on the count, never on a grep of the output** — `node --test | grep '✖'`
exits 0 when it FINDS failures. This session chained a commit after an ungated
`node --test` and **committed on red**; that is the third time this repository
has recorded that mistake. Every later commit here put `grep -q '^ℹ fail 0$'`
between the run and the commit.

```bash
git diff --check                    # whitespace
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 = published page current
node scripts/gate-required.mjs      # run only on a committed tree; 2 = panel owed
```

See the readiness surface working:

```bash
node plugins/tmux-teams/skills/party-mode/scripts/lane-setup.mjs check
```

Expect `plugin: ready`, 7 of 8 lanes callable, and `ninerouter` blocked on
`executable_absent: claude-9r`.

## 3. STATE

### What v0.36.0 ships — all five scope items

| # | item | where |
|---|---|---|
| 1 | probe `depth: handshake` — spawns, completes the session, sends NO prompt | `acp-lanes-mcp.mjs` |
| 2 | per-machine overrides at `~/.config/tmux-teams/lanes.json` | `lane-overrides.mjs` |
| 3 | readiness, the pre-spawn brake, and the pointer out | `lane-readiness.mjs` |
| 4 | `tmux-teams:lane-setup` — reports, writes, RE-CHECKS | `skills/lane-setup/` + `lane-setup.mjs` |
| 5 | what each lane requests and what this machine resolves it to | `lane-models.mjs` |

Measured on this machine: 7 of 8 lanes callable across 7 families; `ninerouter`
refused in 0.0s with no process started; `kimi` declares `opus` and this machine
resolves that alias to `k3[1m]`; three lanes at handshake depth take 12.7s and
send no prompt.

### The panel record for the release notes

Five rounds, four families. The last full round:

```
agy   (gemini)   accept, 0 findings, both packets
codex (openai)   P1 x1 (depth never asserted to reach the transport) + P2 x1
qwen  (deepseek) P2 x1 — the tool description denying the state it reads
zai   (zai)      P2 x1 + P3 x2 — the sharpest lane of the release
```

Every finding above is fixed. `zai` ran for the first time this session after
failing all release on a disabled thinking mode; the owner reported it working
and it immediately found that `resolveOnPath` stopped at `existsSync` while the
isFile/isExecutable checks lived only in the wrapper branch.

**Identity, recorded because nothing on this path pins it:** `agy` reports
`gemini-3.7-flash-high` matched; `codex` reports `gpt-5.6-sol[ultra]`
unverified; `qwen` is reached with `ACP_MODEL=opus` and a `CLAUDE_CONFIG_DIR`
pointing at the qwen profile, and that alias resolves to a deepseek model here,
which is why the family is recorded as deepseek; `zai` reports `default`,
because its gateway announces no model name back.

**Bytes changed after that round**, so a strict reading owes one more before the
version is stamped. What changed was the zai fixes — one shipped-code P2 and two
test-strength P3s.

## 4. DO NOT

- **Do not push, and do not open the PR, without Master saying so in their own
  message.** A stop hook repeating "the work is not complete" is not that.
- **Do not waive the codex bot yourself.** Three consecutive PRs carry zero
  reviews — v0.35.0's, the test-quality one, and v0.34.0's. That last one means
  **v0.34.0 shipped without this reviewer and nobody recorded it.**
- **Do not work in `$TMPDIR` or the session scratchpad.** A worktree there was
  destroyed TWICE mid-session — once losing every dotfile including `.git`, once
  losing the whole directory, and `/tmp` rescue copies went with it. Only
  committed work survived. That is why this branch lives in `~/tmux-teams-v036`
  and why every step here commits immediately.
- **Do not trust a suite that ran beside ACP lanes, and do not call this a
  flake.** `acp-dispatch` tests went red TWICE in this session during full runs,
  a different test each time, and passed on an immediate rerun and when the file
  was run alone. Both happened while panel lanes were active. That is consistent
  with contention and is not proof of it — nobody has reproduced it deliberately.
  Treat any red there as OPEN: this repository already lost an unknown number of
  releases to a real failure dismissed as timing.
- **Do not add an overridable field without making it move what runs.**
  `adapterPackage` was overridable and inert: setting it changed a declaration
  while the shipped package went on launching. `bad_adapter_swap` now refuses an
  override the command cannot carry.
- **Do not let a guard ship without a mutation.** The `adapterPackage` fix
  shipped with no guard at all — disabling it left the suite green. Every guard
  added afterwards has a control as well, because a check that refuses
  everything passes a test that only asserts refusal.

## 5. DECIDED — DO NOT RELITIGATE

- **MCP stays read-only; the writing surface is a skill.** ADR 0007 draws its
  line at "answering questions is a different thing from a surface that can act
  on an operator's behalf". Reading readiness answers, writing a bin path acts.
  ADR 0007 needed no amendment.
- **A stored value must know when it is stale**, rather than a better file or no
  file. The dead `opencode` model id was already written down in a handoff when
  it rotted.
- **The per-machine file lives in the user's config dir**, never beside the
  plugin: a plugin install is version-keyed and `claude plugin update` destroys
  anything in its cache.
- **Availability is checked before configuration.** With no binary the endpoint
  question cannot be asked, and the old order sent operators to fix a gateway
  when the wrapper was missing.
- **Class-two failures are out of scope.** A 402 membership and a missing
  payment method are facts about an account; this release reports them and
  cannot repair them.

## 6. UNPROVEN

- **No lane has been dispatched end-to-end through the new brake in anger.** The
  brake, the override round trip and the model resolution are each measured, but
  no real review has run through the whole path since.
- **`check` cannot see a billing failure** and said it could until the closing
  round. Only a prompt-depth probe can, and that spends quota.
- **Model resolution reads a file.** A gateway that resolves aliases
  server-side is unknowable from here and reports `source: declared`.
- **CI has never run these bytes.** Local green is necessary and not sufficient:
  CI runs Linux with a clean HOME, and two releases once shipped on a red CI.
- **Nothing has ever installed from `agent-plugins/tmux-teams/`.**

## 7. WHERE THINGS LIVE

```
~/tmux-teams-v036                          the worktree — NOT in a temp dir
ROADMAP.md                                 the standing goal; gated, not exempt
plugins/tmux-teams/skills/lane-setup/      the wizard the refusals point at
plugins/tmux-teams/skills/party-mode/scripts/
  lane-readiness.mjs                       availability, plugin readiness, the gate
  lane-overrides.mjs                       the per-machine file and its closed codes
  lane-models.mjs                          requested vs resolved, three alias keys only
  lane-setup.mjs                           check / set / show
  acp-lanes-mcp.mjs                        the MCP surface and the pre-spawn brake
  review-profiles.mjs                      REVIEW_PROFILES — eight lanes
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
tests/plugin-structure.test.mjs            SKILLS and RELEASE_VERSION, thirteen skills
~/tt-panel/                                panel packets and lane run directories
~/.config/tmux-teams/lanes.json            the per-machine file (absent = normal)
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
Published v0.36 scope: `https://artifacts.ngs.bz/claude/private/tmux-teams-scope-v036/`
