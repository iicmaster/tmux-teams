# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-11-20 after shipping `v0.55.0` (composed via `bmad-party-mode` room: John, Sally, Winston, Amelia, Grumbal; prior file was 25,381 bytes from v0.48.0, target <= 32 KiB).

## 1. READ THIS FIRST

- **`main` is at `v0.55.0` (`60fc439`, pushed & tagged on `origin/main`)** — checked out in worktree `/Users/ngs/worktrees/tmux-teams-setup` (clean). GitHub Release live: `https://github.com/iicmaster/tmux-teams/releases/tag/v0.55.0`.
- **THIS worktree (`/Users/ngs/agent-skills/plugins/tmux-teams`) is on stale `release/seat-advisors` (`63479ab`, v0.53.0) and DIRTY** (35+ modified/untracked files from earlier WIP + this session's local edits). **THE SINGLE MOST DANGEROUS TRAP:** do not branch from, `git add -A`, or open a PR from this dirty worktree — create a clean worktree from `main` instead.
- **`~/.gemini/config/plugins/tmux-teams` symlinks into THIS dirty worktree** (`plugins/tmux-teams`), while `~/.zcode/cli/plugins/cache/tmux-teams/tmux-teams/0.55.0` holds the clean `v0.55.0` release copy.
- **Open PR #109** (`fix/review-gate-codex-acp2-opencode-seats`) is still open on GitHub.

## 2. HOW TO VERIFY

Run from a clean `main` worktree (e.g. `/Users/ngs/worktrees/tmux-teams-setup`), never while ACP lanes are live:

```bash
cd /Users/ngs/worktrees/tmux-teams-setup
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

- **Green on `v0.55.0` (`main`):** `1369 tests / 1363 pass / 0 fail / 6 skipped` (measured 2026-11-20 on clean worktree before version bump; `tests/plugin-structure.test.mjs` measured `28 pass / 0 fail` at `60fc439`; CI/Node 20 and CI/Node 24 green on PR #117 at `4998fb5`).
- **Structure & AGY default CLI checks:**

```bash
node --test tests/plugin-structure.test.mjs                 # expected: 28 pass / 0 fail (RELEASE_VERSION = '0.55.0')
node plugins/tmux-teams/skills/tmux-teams/scripts/agy-seat-fallback.mjs default thinker   # expected on agy 1.5.12: gemini-pro-orchestrator-neon
node plugins/tmux-teams/skills/tmux-teams/scripts/agy-seat-fallback.mjs default worker    # expected on agy 1.5.12: gemini-pro-orchestrator-neon
git diff --check                                            # expected: empty output, exit 0
```

- **Gate trap:** never chain `node --test | grep '✖' && git commit` — `grep` exits `0` when it FINDS failures. Gate on `grep -q '^ℹ fail 0$'`.
- **Machine-local trap:** if `~/.config/tmux-teams/lanes.json` overrides `agy`, tests reading real `HOME` may reflect that override; tests that inject `overrideLoader` are isolated.

## 3. STATE

### Shipped on `main` (`v0.55.0`, PR #117, merged `1be1c5e`, bumped & tagged `60fc439`)

1. **Per-family model version floor (`PROHIBITED_MODEL`)** — measured (unit tests + parity test + 6-round `codex-advisor[luna]` review `PASS`):
   - Three character-identical copies: `plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs:384`, `plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs:717`, `plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs:1535`.
   - Floors: `fable >= 5.2` (bare `fable`, pre-5.2, and 8-digit `YYYYMMDD` date stamps like `claude-fable-5-20260514` refused; unbounded versions like `fable-5.100`/`fable-100` and leading-zero forms like `fable-5.02`/`fable-05.2` permitted), Codex `sol/astra >= 6.2`, `terra >= 6.1`, `luna >= 6` (leading-zero and 3-part patch forms handled symmetrically; `gpt-6.10-*`/`gpt-61-sol` permitted), Gemini `3.1` (`3.1` / `3-1`) banned.
2. **AGY default → `gemini-pro-orchestrator-neon` + availability fallback** — measured (live `antigravity-acp@1.2.0` + `agy 1.5.12` probe confirmed 27 options including `gemini-pro-orchestrator-neon`; unit + CLI + review-gate tests pass):
   - `review-profiles.mjs:122` (`AGY_DEFAULT_MODEL`), `:123` (`AGY_FALLBACK_MODELS`: `thinker -> gemini-4-hydrogen-xhigh`, `worker -> gemini-4-hydrogen-medium`), `:1158` (`parseAgyModels`: strips CSI+OSC escapes, normalizes lowercase, ignores prose warnings), `:1190` (`agyAvailableModels`: 10s timeout, cached per `[binaryPath, HOME, XDG_CONFIG_HOME]`, never caches `null` failures permanently), `:1220` (`resolveAgyDefaultModel`: keeps Neon on `null` or `[]`), `:1442` (`buildAcpLaunch`: respects `lanes.json` model overrides, passes `{ source: mergedEnv }`, returns `fallback`, rewrites `settings.model`).
   - `review-gate.mjs:421` (`resolvePrimaryAgyDefault`) wired into `runReviewGate` (`:477`) and records `modelFallback` on gate report attempts/reviews.
   - `acp-lanes-mcp.mjs:504` (`laneStatus` passes `agyModelsResolver: () => null` so status stays local/non-blocking) and `:1126` (`probeOneLane` forwards `agyModelsResolver` and surfaces `fallback` on both reachable and unreachable returns).
   - `agy-seat-fallback.mjs:151` adds `default <thinker|worker>` (rejects extra args with exit 2; `seat <model>` remains retired / exit 2).
3. **`release/SKILL.md` preflight** — added generic `git worktree list` check (vendor/user-neutral, no hardcoded `gh` profile).
4. **Installed cache synced** — `~/.zcode/cli/plugins/cache/tmux-teams/tmux-teams/0.55.0` verified byte-identical via `diff -rq` and `node --check` on all 6 changed `.mjs` scripts (measured 2026-11-20).

### Open / Pending

- **Dirty worktree `/Users/ngs/agent-skills/plugins/tmux-teams`** still sits on `release/seat-advisors` (`63479ab`) with pre-existing WIP + local copies of the v0.55.0 edits. Do not touch or clean it without Master's explicit instruction.
- **Open PR #109** (`fix/review-gate-codex-acp2-opencode-seats`) — not touched this session.
- **P3 UX follow-up from Luna Round 6 (`R6-N1`, non-blocking):** `agy-seat-fallback.mjs default` stays silent on stderr when `agy models` is unreadable (same visible output as Neon confirmed); consider printing a stderr diagnostic while still outputting Neon so companion fails closed.

## 4. DO NOT

- **Do not run `gh pr diff <N>` immediately after `git push` to build a review brief.** Measured 2026-11-20 (PR #117 Round 4): GitHub's PR diff cache lagged behind push `83a74a6`, causing Luna to review the stale Round 3 diff and block unnecessarily. Always generate review diffs locally with `git diff main..HEAD`.
- **Do not dispatch `codex-advisor` without explicitly naming the outbox path in the brief.** Measured 2026-11-20 (`pr117-luna-r1`): saying "read-only / do not edit files" without naming `.mailbox-out/<task-id>` caused `termination_reason: no_outbox` after 519 progress events (recovered via receipt-backed `ACP_SESSION_OPERATION=load` resume).
- **Do not auto-fallback AGY on quota/429.** Antigravity shares one quota pool across all Gemini seats; `agy-seat-fallback.mjs seat <model>` exits `2` unconditionally. Availability fallback triggers ONLY when `agy models` succeeds and omits `gemini-pro-orchestrator-neon`.
- **Do not call `agy models` inside `acp_lane_status` or with a 3s timeout.** Measured 2026-11-19: `agy models` takes ~2.5s (network call); `agyAvailableModels` uses a 10s ceiling and `laneStatus` (`acp-lanes-mcp.mjs:504`) passes `() => null`.
- **Do not push, open a PR, merge, tag, or publish without Master's explicit order.** And before pushing to `origin` (`iicmaster/tmux-teams`), check `gh auth status` — `gh` frequently reverts to `ngs-th` (read-only → 403); run `gh auth switch --user iicmaster` when needed (keep personal account names out of public skills/docs).
- **Do not edit one copy of `PROHIBITED_MODEL` alone.** All three copies (`review-profiles.mjs`, `acp-dispatch.mjs`, `acp-companion.mjs`) are held byte-identical by `tests/review-policy.test.mjs`.
- **Do not bloat `tests/fixtures/mock-acp-agent.mjs` past 64 KiB** (companion enforces a hard 64 KiB bound on adapter entry files), **do not name test variables `secret`** (pre-commit scanner blocks it), and **do not work in `$TMPDIR` for long-lived worktrees**.

## 5. DECIDED — DO NOT RELITIGATE

- **Master, 2026-11-19 (AGY default):** `gemini-pro-orchestrator-neon` is the default for thinker, advisor, worker, and review gate (Neon brain + Hydrogen subagents = faster and cheaper than pure Neon). Availability fallback ONLY when absent from readable `agy models`: thinker/advisor/review → `gemini-4-hydrogen-xhigh`, worker → `gemini-4-hydrogen-medium`. Never fallback on 429/quota.
- **Master, 2026-11-19 (Model version floors):** Replace fixed allowlists with per-family version floors so newly released models work before plugin updates, while older/costlier models stay blocked: `fable >= 5.2` (bare `fable` blocked), Codex `sol/astra >= 6.2`, `terra >= 6.1`, `luna >= 6`, Gemini `3.1` banned. No numeric floor for Gemini 4 elements (element names do not order numerically and Hydrogen is the fallback target).
- **Master, 2026-11-20 (`release/SKILL.md`):** Keep `release` skill public/generic — add `git worktree list` preflight check, do NOT hardcode any `gh` profile or account name in the skill.
- **Master, 2026-11-17/18:** Release review is `codex-advisor[luna]` (`gpt-6-luna[max]`) read-only ACP round-table; `codex-advisor` default/`sol`/`astra` at `ultra`, `luna` at `max`.
- **ADR 0007:** MCP stays read-only; writing surfaces are skills.
- **ADR 0009:** `HANDOFF.md` budget is 32 KiB target / 48 KiB hard ceiling.

## 6. UNPROVEN

- **Fallback on a real machine without Neon** — `buildAcpLaunch`, `review-gate.mjs`, and `agy-seat-fallback.mjs default` fallback paths were verified with injected resolvers and fake `agy` binaries in tests, not on a real machine whose live `agy models` omits `gemini-pro-orchestrator-neon` (this Mac has `agy 1.5.12` which includes Neon).
- **Live end-to-end AGY review-gate run with `gemini-pro-orchestrator-neon`** — `antigravity-acp@1.2.0` `session/new` was live-probed and confirmed to advertise `gemini-pro-orchestrator-neon` (27 options), and `acp_lane_probe agy` handshake succeeded, but a full 3-model `runReviewGate` run against live providers was not executed in this session.
- **Unreadable `agy models` list + real companion fail-closed path** — verified in unit tests; not exercised against a live broken/logged-out `agy` binary.
- **If a readable `agy models` list lacks BOTH Neon and the Hydrogen fallback**, `resolveAgyDefaultModel` still selects the Hydrogen fallback and relies on downstream companion pre-check to fail closed (noted by Sally/Grumbal in Luna Round 3 & 6; not live-tested).
- **Prior machine-wide `lanes.json` / `requirement-audit` live multi-ticket spec / `agent-plugins/tmux-teams/` install** — remain unexercised end-to-end (carried forward from prior handoff, read not re-measured).

## 7. WHERE THINGS LIVE

```
plugins/tmux-teams/skills/party-mode/scripts/
  review-profiles.mjs:122,123,384,1158,1190,1220,1442   AGY Neon default, PROHIBITED_MODEL, parser/cache/resolver, buildAcpLaunch
  review-gate.mjs:421,477                               resolvePrimaryAgyDefault + modelFallback report wiring
  acp-lanes-mcp.mjs:504,1126                            non-blocking laneStatus + probeOneLane fallback forwarding
plugins/tmux-teams/skills/tmux-teams/scripts/
  acp-dispatch.mjs:717                                  PROHIBITED_MODEL copy #2
  acp-companion.mjs:1535                                PROHIBITED_MODEL copy #3 (self-contained)
  agy-seat-fallback.mjs:151                             `default <thinker|worker>` + retired `seat` + `rate-limited`
plugins/tmux-teams/skills/release/SKILL.md              default release workflow (incl. git worktree list preflight)
plugins/tmux-teams/skills/{agy,claude,codex,oc}-advisor/SKILL.md
tests/review-policy.test.mjs                            version-floor, parity, parser/cache/buildAcpLaunch tests
tests/review-gate.test.mjs                              runReviewGate AGY fallback + modelFallback test
tests/agy-seat-fallback.test.mjs                        CLI default/seat/rate-limited tests
tests/plugin-structure.test.mjs:15,18                   SKILLS list & RELEASE_VERSION ('0.55.0')
_bmad-output/implementation-artifacts/spec-agy-neon-default-and-model-version-floor.md   completed spec + Suggested Review Order
/Users/ngs/worktrees/tmux-teams-setup                   clean `main` worktree (v0.55.0, 60fc439)
~/.zcode/cli/plugins/cache/tmux-teams/tmux-teams/0.55.0 synced v0.55.0 installed plugin cache
~/.config/tmux-teams/lanes.json                         per-machine lane overrides (optional)
```
