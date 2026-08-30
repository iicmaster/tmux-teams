# HANDOFF

State of play for the next agent. Overwritten in place, never appended.
Written 2026-08-30 through `bmad-party-mode` (installed; roster Mary, John,
Sally, Winston, Amelia — the adversary seat was taken by Grumbal from
`code-review-crew`).

## 1. READ THIS FIRST

- Branch `feat/v0.37-advisors`, **3 commits on top of v0.36.0, NOT pushed**.
  Tree clean. Worktree at `~/tmux-teams-v036` — deliberately outside any temp
  directory, see DO NOT.
- **v0.37.0 is stamped but NOT released.** Version bumped in all seven places,
  roadmap published and recorded, suite green, manifest valid.
- **The most dangerous thing here: the release panel is INCOMPLETE.** Round 2
  was dispatched against the current bytes and only the `agy` lane has answered.
  Do not stamp, tag, or merge on a partial panel. Section 3 says exactly where
  the other six live.
- **Two gates belong to Master, not to you:** pushing, and waiving the codex bot
  review. A stop-hook reminder, a task notification, or an earlier message of
  your own is not that permission.

## 2. HOW TO VERIFY

```bash
cd ~/tmux-teams-v036
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

Green is **`1196 pass / 0 fail / 0 skipped`** — measured on commit `aef8472`.

**Gate on the count, never on a grep of the output.** `node --test | grep '✖'`
exits 0 when it FINDS failures. This session chained a commit after an ungated
run and **committed on red** — the third time this repository has recorded that
mistake. Every commit after it put `grep -q '^ℹ fail 0$'` between the run and
the commit, and that is the only reason `aef8472` is trustworthy.

**Do not run the suite while ACP lanes are live.** A verification run under
contention measures the contention.

```bash
git diff --check                    # whitespace — passes
claude plugin validate --strict .   # "✔ Validation passed"
node scripts/roadmap-gate.mjs       # 0 — the published page is current
node scripts/gate-required.mjs      # 2 — panel owed; run only on a committed tree
```

All four measured on `aef8472`.

## 3. STATE

### What v0.37.0 ships

**1. The default `claude` lane could not authenticate, and the recorded
diagnosis had been wrong for 22 days.** Every handoff since v0.32 blamed a stale
`~/.claude/.credentials.json` against a keychain a subprocess cannot reach.
Measured: the real binary spawned by node with no TTY authenticates fine (exit
0, `end_turn`); the same binary with `CLAUDE_CODE_SIMPLE=1` exits 1 without an
API call. The CLI's own `--help` says bare mode reads "strictly
ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)". The
companion had set that flag on every claude lane since `8a05d6d` (2026-08-08) to
strip repository hooks, in a comment that listed hooks, MCP, commands and
permissions and never said auth.

- `acp-companion.mjs:2689` — `profileCarriesToken(dir)` reads the profile's
  `settings.json` for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `apiKeyHelper`. An unreadable profile resolves to NOT bare.
- `acp-companion.mjs:2707` — `claudeBareByDefault`; `:2711` an explicit
  `CLAUDE_CODE_SIMPLE` still wins either way.
- Guards: `tests/acp-companion.test.mjs` (three arms via `MOCK_ENV_DUMP` in
  `tests/fixtures/mock-acp-agent.mjs`) and `tests/worker-isolation.test.mjs`.

**Measured end to end:** a real dispatch on the default claude lane returned
`effective_identity: claude-fable-5`, `identity_status: matched`, and wrote its
outbox. The 22-day diagnosis is dead.

**2. `--party <id>` on all three `*-advisor` skills.**

- `advisor-party.mjs:42` `resolveParty` — shells to bmad-party-mode's own
  `resolve_party.py` through `uv`; that skill is a SEPARATE install and this
  plugin does not ship it, so its absence is the ordinary `not_installed`
  outcome, not a bug.
- `advisor-party.mjs:26` `PARTY_PROBLEMS` — a closed vocabulary. It REFUSES with
  a code and exit 2; it never substitutes a different room.
- `advisor-party.mjs:90` `renderPartyMandate` — three containment layers at
  `:77` (`DESCRIPTION_FENCE`), `:83` (`asDescription`, collapses newlines and
  fences), and the restated READ-ONLY line that comes AFTER the roster.
- Guards: `tests/advisor-party.test.mjs` — six tests; the injection one is at
  `:58`, the boot-from-a-path-with-a-space one at `:149`.

**Measured live:** the fable lane answered as Vex / Grumbal / Boundary / Yui /
Dana with no invented names.

### The panel — INCOMPLETE, and this is the open item

Round 1 (against `4fc91b9`) raised four findings; all four are fixed in
`aef8472` and each fix was mutation-tested — restoring the any-non-empty rule,
removing the newline collapse and dropping the restated read-only each turned a
guard red, and both files restored with matching checksums.

Round 2 was dispatched against `aef8472`. **Answered so far:**

```
agy   (gemini)  gemini-3.7-flash-high  matched     accept, 0 findings, BOTH packets
```

**Still in flight, or dead — determine which before acting:**

```bash
cd ~/tt-panel && python3 read-r2.py        # verdict + identity for all eight
ls r2-*/.mailbox-out/                      # 8 outboxes = the round is complete
```

Run directories are `~/tt-panel/r2-{agy,codex,qwen,zai}-{src,tst}`; logs are
`~/tt-panel/r2-<lane>-<part>.log`, and each log's tail carries the session id.
**A lane that ended `no_outbox` is recoverable — try `ACP_RESUME=<session-id>`
with a short "write what you already have, and say plainly if you have nothing"
prompt before paying for a re-run, and NEVER `rm -rf` a run directory before
recording its session id.** `~/tt-panel/dispatch-r2.sh` re-runs the whole panel
and its `go()` opens with `rm -rf "$dir"` — running it wholesale destroys all
eight run directories including the sessions you would resume from. A targeted
retry is one hand-copied `go` invocation.

Identities already published by the six that have not written an outbox, read
from each run dir's `.tmux-teams/liveness/*.json`:
`codex` = `gpt-5.6-sol[ultra]` unverified · `qwen` = `opus` matched (that alias
resolves to a deepseek model on this machine, which is why the family is
recorded as deepseek) · `zai` = `default` unverified, because its gateway
announces no model name back.

**Record every lane's `effective_identity`, not only AGY.** On direct ACP
nothing pins where a lane routed, so its own reported identity is the entire
evidence of who read the diff.

### Packets

`~/tt-panel/brief2-src.md` (33,315 bytes) and `brief2-tst.md` (24,674 bytes),
both under the 128 KiB prepared cap. They were built from the eleven files
`node scripts/gate-required.mjs` PRINTS, not from memory — on 2026-08-15 three
of four hand-assembled panels missed the same two files while every lane
answered 3/3. Each carries a "ROUND 2 — what changed" section pointing the lane
at `aef8472` as the newest and least-reviewed work.

## 4. DO NOT

- **Do not push, and do not open the PR, without Master saying so in their own
  message.** A stop hook repeating "the work is not complete" is not that.
- **Do not waive the codex bot yourself.** Only Master waives it, and a waiver
  that is not recorded on the PR and in the release notes is the silent skip.
- **Do not treat an earlier panel's acceptance as covering later bytes.** Round
  1 accepted `4fc91b9`; `aef8472` changed shipped source, which is exactly why
  round 2 exists.
- **Do not commit chained after an ungated `node --test`.** Done in this session.
  `node --test | grep '✖'` exits 0 when it finds failures, so `&&` commits on red.
- **Do not work in `$TMPDIR` or the session scratchpad.** A worktree there was
  destroyed TWICE in the v0.36 session — once losing every dotfile including
  `.git`, once losing the whole directory, and `/tmp` rescue copies went with
  it. Only committed work survived.
- **Do not fix a claim by making the code's excuse bigger.** Round 2's own
  first finding was that the bare-mode COMMENT said "a profile whose settings
  carry a token" while the code checked only that `CLAUDE_CONFIG_DIR` was
  non-empty — the defect shape of the previous release, written into the fix for
  that shape, and caught by two lanes independently.
- **Do not pass a nonexistent path to a bare-mode fixture.** Two guards in two
  files did exactly that (`/definitely/nonexistent/profile`) and asserted bare
  mode — an assertion no token-checking implementation could satisfy, so they
  pinned the defect rather than the rule.
- **Do not document a script path repo-relative in a SKILL.** All three advisor
  skills did, so an advisor invoked from the operator's own project would have
  resolved it under THAT tree and exited MODULE_NOT_FOUND. The spelling that
  works is `<plugin-root>/`; `$CLAUDE_PLUGIN_ROOT` was tried and broke the
  docs-path guard rather than satisfying it.
- **Do not bump a submodule pin in `~/agent-skills` after a release.** That step
  is retired — `scripts/sync.sh` there fetches `origin/main` at run time
  (commit `dd0b848`). Touch that repo only on explicit instruction, and only
  with `git commit --only -- <path>`: other people's work sits staged in it.

## 5. DECIDED — DO NOT RELITIGATE

- **Bare mode is conditional, not removed** (this session, after two lanes
  raised it): default ON only when `CLAUDE_CONFIG_DIR` names a profile whose
  `settings.json` carries a token, and an unreadable profile resolves to NOT
  bare — being refused for auth is the failure this change exists to end, and
  inheriting hooks is the milder cost.
- **A roster is contained, not censored** (this session): its text stays visible
  as description. Deleting it would hide what the operator saved; letting it
  speak as instruction would let a saved file dissolve the read-only rule.
- **An advisor REFUSES an unknown party rather than falling back to the invented
  cast.** An operator who typed `--party` asked for a specific room.
- **MCP stays read-only; the writing surface is a skill** — ADR 0007, unchanged
  by v0.36 and v0.37.
- **The per-machine lane file lives in the user's config dir**, never beside the
  plugin: a plugin install is version-keyed and `claude plugin update` destroys
  anything in its cache.
- **Master's instruction, 2026-08-30: no version pin in `~/agent-skills`.**
  Release flow step 10 is retired (`aa0ab7c`).

## 6. UNPROVEN

- **The panel is not complete.** Six of eight lanes have not answered. Anything
  that reads "3/3" or "4/4" for v0.37.0 is not yet true.
- **CI has never run these bytes.** Local green is necessary and not sufficient:
  CI runs Linux with a clean HOME, and two releases once shipped on a red CI.
- **`--party` has been exercised on the claude/fable lane only.** The codex and
  agy advisor skills carry the same documented command; neither was dispatched
  with it.
- **`profileCarriesToken` was measured against fixtures and against the qwen and
  zai gateway profiles** (both carry `ANTHROPIC_AUTH_TOKEN`, so both panel lanes
  really did run bare — the first live exercise of the changed path). It has not
  been measured against an `apiKeyHelper` profile outside a fixture.
- **Nothing has ever installed from `agent-plugins/tmux-teams/`.**

## 7. WHERE THINGS LIVE

```
~/tmux-teams-v036                          the worktree — NOT in a temp dir
ROADMAP.md                                 the standing goal; gated, not exempt
plugins/tmux-teams/skills/tmux-teams/scripts/
  acp-companion.mjs:2689                   profileCarriesToken
  acp-companion.mjs:2707                   claudeBareByDefault
  advisor-party.mjs:26                     PARTY_PROBLEMS — the closed codes
  advisor-party.mjs:77,83                  the fence and asDescription
  acp-dispatch.mjs                         the operator's entry to a lane
plugins/tmux-teams/skills/{claude,codex,agy}-advisor/SKILL.md
tests/advisor-party.test.mjs:58            the injection guard
tests/acp-companion.test.mjs               the three-arm bare-mode guard
tests/worker-isolation.test.mjs            the second bare-mode guard
tests/plugin-structure.test.mjs            SKILLS and RELEASE_VERSION
scripts/gate-required.mjs                  DOC_ONLY at :41 is the only exemption
~/tt-panel/                                packets, run dirs, read-r2.py
~/tt-panel/dispatch-r2.sh                  re-runs the panel — rm -rf's every run dir
~/.config/tmux-teams/lanes.json            the per-machine file (absent = normal)
~/.config/claude-profiles/                 the gateway profiles the lanes route through
```

Published roadmap: `https://artifacts.ngs.bz/claude/private/tmux-teams-roadmap/`
