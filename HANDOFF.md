# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-24 through `bmad-party-mode`.

## 1. READ THIS FIRST

- Branch `release/v0.35.0`, **NOT pushed**. It carries 19 commits and a merge of
  `origin/main`. The tree is clean.
- The three-model panel is **3/3 ACCEPT with zero findings on these exact
  bytes** — six lane runs, three families, both packets. Do not re-run it unless
  the bytes change.
- **The single most dangerous thing here: any edit to `ROADMAP.md` voids that
  panel.** `ROADMAP.md` is NOT in `DOC_ONLY` (`scripts/gate-required.mjs:41`
  exempts only `HANDOFF.md`, `README.md`, `CLAUDE.md`). The v0.36 scope below is
  recorded in THIS file for exactly that reason. Move it to `ROADMAP.md` only
  AFTER v0.35.0 is tagged and released.
- Everything else about the release is done: seven version places bumped,
  roadmap page published and recorded (gate 0), suite green, manifest valid.
  What remains is push, PR, review, merge, tag, release.

## 2. HOW TO VERIFY

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green here is **`1170 pass / 0 fail / 0 skipped`**. The zero skipped is new: the
bwrap sandbox removal took the four Linux-only tests with it, so this suite has
no unexecuted guards on any platform for the first time.

`node --test | grep '✖'` **exits 0 when it FINDS failures.** Gate on the count,
never on the grep. This repository has committed on red twice that way.

```bash
git diff --check                    # whitespace
claude plugin validate --strict .   # manifest — "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 = published page current, 2 = stale
node scripts/gate-required.mjs      # run ONLY on a committed tree; 2 = panel owed
```

`gate-required.mjs` reads `<last-tag>..HEAD` and cannot see the working tree. On
a dirty tree it answers EXEMPT with full confidence and is wrong.

## 3. STATE

### v0.35.0 — what it ships

Nine defects were found by the panel across six rounds. **Three were older than
this release; two were introduced by the fix for an earlier one.**

| # | fix | where |
|---|---|---|
| 1 | probe budget split — 240s boot / 30s reply, rearmed at `initialize`, new closed code `probe_boot_timeout` | `plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs:455` |
| 2 | executable-trust call restored to the spawn path for every lane | `plugins/tmux-teams/skills/party-mode/scripts/acp-review-client.mjs:779` |
| 3 | `targetRepository` canonicalised + directory-checked before that call | same file, just above 779 |
| 4 | `networkSharedWithHost` corrected `false` → `true` in emitter and gate | `acp-review-client.mjs:1190`, `review-gate.mjs:288` |
| 5 | AGY safe-read exemption deleted from runner and gate | both files |
| 6 | dead auth-copy helpers deleted; `SKILL.md` corrected twice | `plugins/tmux-teams/skills/party-mode/SKILL.md` |
| 7 | `codex-tmux-driver` folded into a reference; skills 12 → 11, then 12 with `test-quality` from main | `plugins/tmux-teams/skills/tmux-teams/references/codex-tmux.md` |
| 8 | Agent Plugins 1.0 portable root + materialiser | `agent-plugins/tmux-teams/`, `scripts/portable-root.mjs:35` |
| 9 | bwrap OS sandbox removed entirely | ADR 0006, amended |

### The panel record for the release notes

```
Gate: 3/3
  agy   (gemini)   effective_identity: gemini-3.7-flash-high   identity_status: matched
  codex (openai)   effective_identity: gpt-5.6-luna[max]       identity_status: unverified
  qwen  (deepseek) effective_identity: opus                    identity_status: matched
```

`opus` on the qwen gateway is **deepseek-v4-pro-0813** — the alias is set by
`ANTHROPIC_DEFAULT_OPUS_MODEL` in that profile's settings. Record the resolution,
not just the alias: two lanes can share one gateway and the alias alone cannot
tell two families apart.

### v0.36 SCOPE — set by Master, 2026-08-24

**A plugin setup system: a readiness check, and per-machine `bin` configuration,
so that lanes appear as selectable options to MCP.**

Today there is **no per-machine configuration layer at all**. Every entry in
`REVIEW_PROFILES` (`plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs:71`)
hardcodes three machine-dependent things: a launcher (`bunx` or `npx -y`), a
pinned adapter package version, and a wrapper executable name (`claude-qwen`,
`claude-9r`, `claude-zai`). A grep for `TMUX_TEAMS_*CONFIG`, `lanes.json` or any
local override in that file returns nothing.

**Seven machine-specific failures were measured in this one release, on one
machine. This is the evidence base for the scope — it is not hypothetical:**

| lane | what failed | why it is a MACHINE fact, not a code fact |
|---|---|---|
| codex | `Missing optional dependency @openai/codex-darwin-arm64` | the npm cache resolves to `/Volumes/KINGSTON` (a removable volume) holding a truncated install; only **uppercase** `NPM_CONFIG_CACHE` redirected it, lowercase `npm_config_cache` did not reach the child |
| opencode | model id does not exist | `opencode/deepseek-v4-flash-free` → the `-free` suffix is gone; the old id was recorded verbatim in a doc |
| opencode | `No payment method` | that machine's account |
| kimi | `402 unable to verify your membership benefits` | that machine's account |
| zai | `unsupported model value glm-5.2` | the adapter advertises a different value than the profile pins |
| qwen | needs `CLAUDE_CONFIG_DIR`; `opus` resolves to a different model per that profile's settings file; `effortLevel: xhigh` drove 25-minute turns | entirely per-machine |
| agy | the only lane that worked first try | because `bunx` is a native binary — **healthy by coincidence, not by design** |

So the scope has three parts, in this order:

1. **A readiness check** that answers, per lane, whether this machine can
   actually run it — and distinguishes *not installed*, *installed but broken*,
   *no credential*, *no quota* — reusing the closed-code discipline already in
   `acp_lane_probe` rather than inventing a second vocabulary.
2. **Per-machine `bin` configuration** so a launcher, an adapter version and a
   wrapper path can be set for THIS machine without editing a shipped profile.
   The failures above are all in that layer.
3. **Surfacing the result to MCP** so only lanes this machine can actually run
   appear as choices.

**Open design questions, not yet answered — do not start coding past them:**

- Where does per-machine config live, and what reads it first — the profile, an
  override file, or the environment?
- Does a readiness check contact an endpoint (real quota, real minutes) or stay
  structural? `acp_lane_status` is structural and `acp_lane_probe` is live; this
  may be a third thing or may be one of those two doing more.
- ADR 0007 says the plugin ships **read-only** lane-discovery tools. Writing
  configuration is not read-only. Either the setup surface is not an MCP tool,
  or ADR 0007 is amended **as part of the work** — not contradicted quietly.
  This exact tension was already resolved once when `acp_lane_probe` was added:
  the ADR was amended rather than bypassed. Do the same.

## 4. DO NOT

- **Do not edit `ROADMAP.md` before v0.35.0 is tagged.** It voids a 3/3 panel
  that cost six rounds and six lane runs. That is the whole reason the v0.36
  scope is in this file instead.
- **Do not add a per-machine override by widening the `DOC_ONLY` allowlist** in
  `scripts/gate-required.mjs`. Anything under `plugins/` reaches an installed
  plugin and is exactly what the panel exists for.
- **Do not treat `PM_COOLDOWN_SEC` (or any brake) as redundant because
  disabling it turned no test red.** Measured 2026-08-15: zero red means
  UNGUARDED, never redundant. It has a guard now in
  `tests/loop-occupancy.test.mjs`.
- **Do not run `acp_lane_probe` and read `probe_timeout` as "the endpoint is
  down".** Until this release the ceiling was 20s while a cold `npx -y` adapter
  install measured **190s** and a warm one **24.4s**, so every lane reported
  unreachable while the network was up and the endpoint answered 200 in 126ms.
  Fixed here; the failure shape is what to remember.
- **Do not fan out subagents that each run `node --test`.** Measured
  2026-08-03: fifteen concurrent passes drove load average to 28 on 8 cores and
  after 42 minutes not one agent had finished.
- **Do not `rm -rf` an ACP run directory before recording the session id.** Four
  lanes ended `no_outbox` in this release and **three of their answers were
  recovered from the run log**, not from a re-run. `grep -v '^\[' <log> | grep -o
  '{"verdict".*'` is what recovered them.
- **Do not commit anything in `~/agent-skills`, including the submodule pin.**
  `CLAUDE.md` release step 10 says to bump it; the owner's standing boundary
  says that repository is not ours to touch. The boundary wins. Report the pin
  bump as a task for the owner.

## 5. DECIDED — DO NOT RELITIGATE

- **The portable root's symlinks point outside it BY DESIGN** (Master,
  2026-08-24). The tree keeps one copy of everything so the two roots cannot
  drift; `scripts/portable-root.mjs` hands out a self-contained copy on demand.
  The openai lane raised "the raw subtree is not installable" in three separate
  rounds — it is the finding that produced the materialiser, not an oversight.
- **The OS sandbox is removed, not merely undeclared** (Master, 2026-08-24).
  ADR 0006 is amended. `osSandbox` is read by nothing.
- **v0.36's first item is the setup/readiness/bin system** (Master,
  2026-08-24), recorded above.
- **A release ships as a pull request, never a push to `main`** (Master,
  2026-08-16). Merge needs CI green plus a codex bot review STATE. A bot comment
  saying quota is exhausted is an ABSENT reviewer — neither pass nor fail — and
  only Master waives it, in writing, on the PR and in the notes.

## 6. UNPROVEN

Be generous here; the next agent builds on whatever is missing.

- **Nothing has ever installed from `agent-plugins/tmux-teams/`.** No 1.0-aware
  client was available to test with. The tests prove the layout and the
  materialised copy's byte-identity; they do not prove any client accepts it.
- **The panel read a static diff and ran nothing.** Its 3/3 says three families
  read these bytes. It is not a behavioural check and the lanes said so
  themselves in every `notes` field.
- **`identity_status: unverified` on the codex lane** — direct ACP pins no
  endpoint, so `gpt-5.6-luna[max]` is that lane's own report and nothing
  corroborates it.
- **The real ceiling of a review packet is unknown.** The gate allows 128 KiB; a
  72 KiB prose-dense packet failed three times running while 74 KiB of source
  passed. Working habit is ~25 KiB and split. That is a habit, not a measurement.
- **`nextStep` has not shrunk.** Five of phase E's six cells are wired and it is
  still 308 lines over 32 branches. "Wired" and "live" are different states.
- **CI has never run these bytes.** Local green is necessary and not sufficient:
  CI runs Linux with a clean HOME, and two releases once shipped on a red CI
  that local runs could not see.

## 7. WHERE THINGS LIVE

```
ROADMAP.md                                  the standing goal; gated, not exempt
plugins/tmux-teams/docs/adr/                decisions that are closed
plugins/tmux-teams/skills/                  the shipped skills — this repo IS their source
  party-mode/scripts/review-profiles.mjs:71 REVIEW_PROFILES — the hardcoded lanes v0.36 targets
  party-mode/scripts/acp-lanes-mcp.mjs:455  PROBE_BOOT_TIMEOUT_MS / PROBE_REPLY_TIMEOUT_MS
  party-mode/scripts/acp-review-client.mjs:779   the executable-trust call site
  party-mode/scripts/review-gate.mjs:288    the isolation-evidence expectations
scripts/gate-required.mjs:41                DOC_ONLY — the only exempt files
scripts/portable-root.mjs:35                materialisePortableRoot
scripts/roadmap-gate.mjs                    0 current / 2 stale; never records for you
tests/plugin-structure.test.mjs:15          SKILLS and RELEASE_VERSION — the list of record
.roadmap-published.json                     tracked marker; a private marker makes the gate lie
```

Published roadmap page: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
