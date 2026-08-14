# tmux-teams plugin repo — agent instructions

This repo is a **Claude Code directory marketplace** delivering one plugin
(`tmux-teams`, see `plugins/tmux-teams/`) — and it is the **canonical source**
of its bundled skills. Edit them directly under
`plugins/tmux-teams/skills/`. `SKILLS` in `tests/plugin-structure.test.mjs` is
the list of record and the only thing that checks a skill is really there — a
count written in prose here rots the first time one is added, and said "six"
while nine were shipping. (Flipped 2026-07-21: agent-skills commit
`dd43dc1` vendored this repo as the authoritative submodule and deleted its
own `skills/shared/tmux-teams`; the old mirror/sync flow is gone.)

## Commands

```bash
node scripts/run-fast.mjs fast     # explicit in-process inner tier
node --test                        # whole suite — structure, semantics, KMS; run before commit
git diff --check                   # repository whitespace gate
claude plugin validate --strict .  # manifest validation
node scripts/gate-required.mjs     # does this release owe the three-model panel? 0=exempt 2=required
node scripts/roadmap-gate.mjs      # is the published roadmap page behind ROADMAP.md? 0=current 2=stale
node scripts/roadmap-render.mjs    # ROADMAP.md -> docs/roadmap.html, deterministic, no deps
```

`node scripts/run-fast.mjs fast` uses an explicit allowlist and prints every
full-only test file, so a new `tests/**/*.test.mjs` stays visible and is still
covered by the full tier. A fast pass does not cover ACP, CLI/subprocess,
publisher, schema, or other full-only behavior; run bare `node --test` before a
commit.

`node --test tests/` (a bare directory) fails on Node 24 with MODULE_NOT_FOUND —
pass no path at all, or a glob like `tests/*.test.mjs`.

**A grep over the suite output is not a gate.** `node --test | grep -E '✖|fail'`
exits 0 when it FINDS failures, so chaining a commit after it with `&&` commits
on red — done twice on 2026-08-03 before anyone noticed. Gate on the count:

```bash
node --test > /tmp/suite.log 2>&1; grep -E '^ℹ (tests|pass|fail)' /tmp/suite.log
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

**Never fan out subagents that each run this suite.** It spawns dozens of ACP
subprocesses per pass — one pass takes about two minutes on an idle dev box, and
several at once do not share nicely. On 2026-08-03 five agents were each told to
apply a fix, run `node --test`, revert and run it again: fifteen concurrent
passes drove the load average to 28 on 8 cores, and after 42 minutes not one
agent had finished. The wasted time is not the point — the numbers are. Earlier
that same day `tests/acp-companion.test.mjs` went RED at 79s with only a
headless browser and one `python3 -m http.server` competing for CPU, and passed
at 35s on a quiet machine. A verification phase run under contention measures
the contention. **Parallelise the reading and the design; serialise every
measurement through one caller.** Say it in the agent's prompt: do not copy the
repo, do not run `node --test` at all, return a diff that applies by string
match plus the exact commands the caller runs once.

**Every subagent that WRITES gets its own git worktree.** The rule above is about
CPU; this one is about the working tree, and it cost a wave on 2026-08-05. Five
agents were fanned out into this one checkout with no isolation. They raced each
other on `git checkout -b`: one agent's cherry-pick landed on a branch another
agent had just created, a third was mid-edit on the contract when HEAD moved
under it, and the agent that noticed force-reset the polluted branch — a reset
that **did not hold**, because the directory it reset was still being checked out
by somebody else. Nothing was lost, and that was luck plus `origin/main` being
ahead of the damage, not care.

Two things follow. Pass `isolation: 'worktree'` for any agent that commits, and
say in its prompt that the primary checkout is off limits — a capable agent will
`cd` there to "check something" and take HEAD with it. And treat a git write
performed in a shared directory as unverified until it is read back: a
force-reset, a branch delete, a checkout can all be undone by a concurrent
process between the command and the next one, silently and with a zero exit code.

A read-only agent needs no worktree, but give it one anyway when it sits beside
writers — `gh` and `grep` work the same there, and it removes the one way it
could still move HEAD.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once <repo>
```

Republishes `pulse.html`, `graph.html`, `kanban.html` — the repo argument is
required, and a bare `pulse.mjs once` only prints usage.

## Checking a published page

**Measure AND look. Neither one alone is a check.** This section said only the
first half for a long time, and on 2026-08-06 that cost four "done" reports in
a row on the same page — a gap reported as halved that had moved nine pixels, a
wire attachment measured at a perfect `dx 0` while the wire rendered as a loop
floating between two cards, and a bow that went wide again. Every number was
right. Nobody had opened the picture. Master caught all four.

- A **measurement** proves a quantity and a logic. It cannot prove a shape.
- A **screenshot** proves a shape. It cannot prove motion, or that the number
  behind the shape is right.
- So: any change a reader can SEE gets a screenshot after it is finished, and
  the screenshot gets looked at before the word "done" is used. Report the
  measured OUTCOME, never the constant you edited — `OUTSIDE_GAP 150 -> 75` is
  not a result, `the gap went 347px -> 338px` is, and it is the sentence that
  would have caught this on the first round instead of the fourth.
- Ask what the check you just ran is capable of proving. Running the full
  ritual and passing is not the same as having verified the thing that changed:
  the mutation checks, the checksummed restores and the 748 green tests were
  all present for every one of those four misses.

Never from a screenshot alone: a still image cannot show whether anything is moving,
and four "fixed" reports were made against one on 2026-08-01. Serve the store
over HTTP, then MEASURE — `getComputedStyle(el).animationName`, count
`animateMotion` nodes and match `path` against each wire's `d`, compare
`getBoundingClientRect()` of a halo with the card it rings. Every wire carries
`data-from`/`data-to` so a check never reverse-engineers geometry.
`plugins/tmux-teams/skills/tmux-teams/references/loop-graph-page.md` ข้อ 9 is the
method for this, and the rest of that file is what `graph.html` may draw. It is
a chapter of `references/loop-system-contract.md` ข้อ 12 — **the contract is the
one SSOT** and wins if the two ever disagree.

## Model policy for every ACP route

- Every tmux-teams AGY route defaults to `gemini-3.6-flash-high`. Gemini 3.1
  variants are prohibited for ACP planning, review, and delivery work; fail
  closed if a configured or acknowledged AGY model is Gemini 3.1, and never
  fall back to it.
- Determine agent progress from ACP/protocol/process state. Elapsed time alone
  is never proof that a delivery worker or reviewer is stalled.
- A reviewer or read-only planning lane is read-only and cannot launch delivery
  work. (Kept from the retired dispatch gate below, because it was never a rule
  about dispatch.)

## Worker dispatch — the three-model gate is RETIRED (Master, 2026-08-06)

Dispatching a delivery worker no longer requires a frozen bounded plan, bound
objective/acceptance/brief hashes, a dispatch-ledger record, or three accepted
reviews. It is gone by owner decision, not by drift.

Read why, because the shape repeats: the gate charged its full price at every
retry and every corrective dispatch, while the failures worth stopping kept
arriving at RELEASE time — which is where the weight moves to. See Release flow
step 2.

Plan review before a dispatch is now a judgement call. Worth it when a change
crosses domain boundaries or amends the contract; skipped for ordinary work.
Nothing about this licenses a silent bypass elsewhere: the release gate below is
not optional, and only a later explicit instruction from Master changes either.

## Release flow

1. Edit skills under `plugins/tmux-teams/skills/` (this repo IS canonical).
2. **Three model families read the release diff BEFORE the version is marked.**
   Master's rule, 2026-08-06. It replaces the single-`codex-advisor` rule of
   2026-08-04 and inherits its reason — no version number is stamped on work a
   second model family has not read — but one reader was not enough, and the
   heavier gate that did exist was being spent at dispatch time instead of here.
   Three substantive reviews from three distinct model families, AGY mandatory.
   "2/3" means an objection that two of the three raise is must-fix, NOT that
   two reports are enough. Any blocking finding stops the bump — resolve it and
   rerun all three on the new bytes; never retry an objection away. Fewer than
   three accepted reviews leaves the release visibly blocked: no silent
   substitution, no two-reviewer degradation.

   **WHEN the panel is owed is decided by `git diff`, never by whoever is
   holding the release** (Master, 2026-08-09). The rule above stood unscoped
   until v0.18.1 and v0.18.2 shipped with ZERO lanes. Nobody bypassed it on
   purpose: it charged the same price for a documentation edit as for a rewrite
   of the companion, so it got skipped — and a rule skipped twice running is not
   a rule, it is a wish. **Scoped, not retired:**

   ```bash
   node scripts/gate-required.mjs   # 0 = exempt · 2 = panel required · 1 = the script itself failed
   ```

   **Run it AFTER committing, never on a dirty tree.** It reads
   `<last-tag>..HEAD` and nothing else — uncommitted work is invisible to it, so
   a finished-but-unstaged change to a shipped file reads back as EXEMPT and
   says so with the same confidence it says REQUIRED. Caught 2026-08-12 by an
   operator who ran it on a working tree holding a `plugins/` edit; committing
   the same bytes flipped it to REQUIRED. The failure shape is edit → run gate →
   see EXEMPT → commit → release, which is a panel skipped by somebody who
   checked.

   It exempts a file only on PROOF, and there are two: the file is `HANDOFF.md`,
   `README.md` or `CLAUDE.md`, or every changed line in it is identical once
   semver numbers are blanked (which is what lets a version bump touch
   `tests/plugin-structure.test.mjs` alone). Everything else requires the panel,
   including a change shape the parser cannot read — binary, rename, empty diff.
   **Never widen that allowlist to a path under `plugins/`**: those bytes reach
   an installed plugin, and they are the entire thing the panel is for.

   **An exemption that is not RECORDED is just the old silent skip.** An exempt
   release carries `Gate: exempt (docs/version-only) — <files>` in its GitHub
   release notes; a gated release carries `Gate: 3/3` with every lane's
   `effective_identity`. A release with neither line is in exactly the state
   v0.18.1 was left in — ungated and unrecorded. And note what the decider says
   about the past: run it over `v0.17.0..v0.18.0`, `v0.18.0..v0.18.1` and
   `v0.18.1..v0.18.2` and it answers REQUIRED for all three. **The new scope
   excuses none of them, and it was not built to.**

   **HOW you run the panel depends on the machine, and this rule named a tool
   that cannot run on half of them** (found 2026-08-08, the first time anyone
   tried it here). `party-advise`'s ACP-only gate —
   `node <party-mode>/scripts/review-gate.mjs <packet> <abs-target>` — is the
   preferred path and the stronger one: it sandboxes each lane, hides the target
   repository, and pins the endpoint every profile routes to.

   **STRONGER IN DESIGN, UNPROVEN IN PRACTICE — it has never yet assembled a
   three-family panel.** Measured 2026-08-09 on Ubuntu 26.04 with `/usr/bin/bwrap`
   present, the first time anyone ran it on a host that could. AGY reached
   `status: accepted`; every claude-routed lane died, EIGHT distinct layers deep
   — five that stopped a lane before it could start, then three more that only a
   running gate could ever have shown. This paragraph said "five" from
   `daeaa54` (2026-08-09 12:15) to `dfef37c` (2026-08-12 23:44) — three days,
   across one shipped release, v0.19.0. Read those timestamps before repeating
   the easy explanation: the paragraph was not left stale by neglect, it was
   written at 12:15 and the layers it does not mention landed at 12:34 and
   13:56 THE SAME AFTERNOON. Nobody re-read a paragraph they had finished an
   hour earlier. The first five, each fix revealing the next: staging asked
   "is it under `$HOME`" instead of "does the sandbox mask it"; the
   trusted-roots list knew `~/.nvm`
   and not mise; no interpreter was staged at all; `npx` is a node script whose
   relative `require` a single-file copy cannot satisfy; and the shebang then
   found no `node` on the sandbox PATH. **AGY survived all five only because
   `bunx` is a native binary** — one lane healthy by coincidence while its
   neighbour was not. **Those five are fixed and committed** (`fe42d4a`,
   `2a1868e`, `a3a7d60` — all 2026-08-09, not the 08-10 this line claimed until
   somebody checked `git log`): staging asks whether the sandbox MASKS a path
   rather than whether it is under `$HOME`; trusted roots are derived from
   `process.execPath`; the interpreter prefix is re-bound — and refused when it
   is a home directory, one of its direct children, or overlapping the target
   repository; `npx` resolves because the whole prefix is mounted rather than one
   file copied; and the sandbox PATH carries the toolchain bin.

   **The other three (`0228f6b`, same day) are the ones worth reading, because
   no unit test could have reached any of them.** A dying lane took the WHOLE
   gate down: `write` checked `stdin.writable` and then wrote, and a child
   exiting between those two steps leaves an EPIPE with no listener, which Node
   promotes to an unhandled error and kills the process — the run died in 2.6s
   with a stack trace naming a socket, losing every lane's result and hiding its
   own cause. The toolchain bind was correct, present, and BURIED: printing the
   real bwrap argv showed `--ro-bind <node prefix>` sitting before the
   `--bind <ephemeral home>` that lands on the host home directory, which mounts
   over `$HOME` itself, and
   on any version-manager machine the interpreter lives under `$HOME` — two
   correct instructions in the wrong order, so nothing but a run could catch it.
   And the stdout ceiling counted ENVELOPES, not output: an ACP adapter emits one
   JSON-RPC envelope per streamed token, so 8,531 envelopes carrying roughly 20 KB
   of thinking totalled 2,097,253 bytes — ~100x amplification, and the 2 MiB
   ceiling fired on an ordinary answer. Raised to 16 MiB; `lineBytes` and
   `messageBytes` are what bound a hostile agent and neither moved.

   **What all eight bought, and it is more than this file used to admit:** the
   zai lane went `config -> closed(127) -> closed(1) -> closed(1) -> protocol ->
   review`, ran 4m8s, and glm-5.2 read the diff and answered. **The transport
   works end to end.** It failed on `agent output is not one strict JSON
   document` — prose instead of JSON, in the very mode
   `plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs` claimed
   prevents that (see the note now standing beside the zai profile).
   This line also said "two fixed, three open" for a full release-panel round
   after that stopped being true, and a reviewer caught it — the same rot, twice,
   in the same paragraph. Until someone runs three families through green on a
   Linux host, this is still the path with the better design and the thinner
   evidence — but what is open is no longer the sandbox, and as of 2026-08-13 it
   is no longer the lane either. Measured that day on macOS through direct ACP,
   the zai lane returned one strict JSON document in BOTH modes (plan 87s,
   default 204s) and a three-family panel completed 3/3 — the first time this
   project has ever assembled one. **What is left is one thing: nobody has run
   three families through bwrap on a Linux host.** A `qwen` provisioned on that
   host is a prerequisite of that run, not a separate item.

   **It was Linux-only, and as of 2026-08-13 it is not — see ADR 0006.** No
   shipped profile declares `osSandbox: 'bwrap'` any more, so the gate runs on
   macOS too. The bwrap machinery is retained and still tested; a profile that
   declares the field gets the full sandbox, and turning it back on is one word.
   What was given up is filesystem confinement at the OS level, and the ADR
   states that plainly along with the argument against the decision.
   Everything else the gate checks is unchanged and never came from bwrap: a
   temporary workspace, `toolCallsObserved: 0`, no built-in tools, no MCP
   servers, every permission denied, the endpoint pinned and verified in the
   PARENT before the child starts, and the packet redacted both ways.

   The old shape is still worth recognising if you re-enable it: on a non-Linux
   host all three lanes refuse together at `stage: config` with `stderrBytes: 0`,
   which reads like three broken profiles and is one precondition.

   Two further limits worth knowing before you build the packet: the gate caps a
   prepared packet at **128 KiB** (256 KiB raw), and a release diff will exceed
   that. Split by MEANING — shipped source in one packet, the tests that guard
   it in another — and require every part to pass. Do not raise the cap.

   **On macOS, run the same three families through direct ACP**
   (`plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs`, one run
   directory per lane — receipts are not
   namespaced by lane, so a shared directory makes the second lane try to resume
   the first one's session). Owner decision, 2026-08-08. The family requirement
   does not move; the isolation does. Direct ACP gives no sandbox and no
   endpoint pin, so **record `effective_identity` for EVERY lane, not just AGY**
   — it is read from that lane's `.tmux-teams/liveness/<task-id>.json`, and on
   this path it is the only evidence of who actually read the diff. Write the
   brief to a file and point the lane at it; never paste a long brief.

   **The AGY exemption from `identity_status: matched` rested on a false premise,
   and the premise is now disproven** (measured 2026-08-13, twice: in PR #63 and
   again live from this repo). The 2026-08-07 note said the `antigravity-acp`
   adapter "rejects EVERY model config value". It does not. Probed directly
   against agy 1.1.12:

   ```
   advertised            "gemini-3.6-flash-high\tGemini 3.6 Flash (High)"   ← a TAB
   set "gemini-3.6-flash-high"          -> ACCEPTED, currentValue bare
   set "gemini-3.6-flash-high\tGemini…" -> ACCEPTED, currentValue with the tab
   ```

   **Both are accepted.** Two things produced the old conclusion. Our own
   `assertConfigOptionValue` compared the requested value against the advertised
   list by exact equality, so the bare id — the form the adapter actually
   prefers — was refused BY US before the adapter was ever asked. And the second
   string in that old sentence has a SPACE where the real value has a tab: a tab
   rendered as whitespace in a log, copied back, and refused for not existing.
   A transcription artefact became a permanent exemption.

   So AGY's model CAN be requested and its identity CAN be matched. The fix is
   merged (PR #63). Treat `unverified` on that lane as a thing to investigate,
   not a standing allowance — and if you re-add an exemption, measure the
   adapter first and paste the escaped value, never the rendered one.

   **What does not change: RECORDING.** If a review is accepted from AGY without
   its reported identity written down, the release is not gated — it is
   unrecorded. That was always the load-bearing half.

   The exemption is about MATCHING, not about recording, and the direct-ACP path
   above widens the recording obligation to every lane for a different reason:
   there, nothing pins where a lane routed, so its own reported identity is all
   there is. Two lanes can also share one gateway — `claude-qwen` reaches
   qwen3.8-max on `--model opus` and deepseek-v4 on `--model sonnet` — so a
   recorded identity is what tells two families apart on a path that cannot
   prove them apart.

   Review the actual diff
   that would ship — `git log --oneline <last-tag-or-release-sha>..HEAD` plus
   `git diff <that sha>..HEAD` — not a summary of it, and not the plan that
   produced it. This exists because every release before it was marked on one model's
   reading, and the three corrections that mattered most on 2026-08-03 all came
   from the advisor rather than from this room.
3. Bump the version in SIX files, SEVEN places — the counts differ because one
   file carries it twice, and saying only the smaller one is how a marketplace
   half-bump gets past a checklist. `README.md` said it correctly while this
   line said "all FIVE places" and then listed six; a release reviewer caught
   the contradiction. The files: `.claude-plugin/marketplace.json`
   (twice: `metadata.version` and `plugins[0].version`),
   `plugins/tmux-teams/.claude-plugin/plugin.json`, `RELEASE_VERSION` in
   `tests/plugin-structure.test.mjs`, the `Current release: **X.Y.Z**` line
   in `README.md`, `plugins/tmux-teams/plugin.json` (the vendor-neutral Agent
   Plugins manifest, added 2026-08-08 — it arrived WITH its guard rather than
   waiting for a release to notice, which is the first time that happened), and
   — found 2026-08-14, by grepping rather than by reading this list — the
   `Current release:` line in `ROADMAP.md`, which additionally has its own gate:
   bumping it makes the published page stale, so the roadmap step is not
   optional on a version bump. That test is the only thing checking they agree, so it has
   to state the number itself. This step said "BOTH" until 2026-08-01, and
   v0.12.0 reached the bump with the third one still on 0.11.1 until the test
   caught it — then said "THREE" until 2026-08-05, when the v0.15.0
   documentation review found README.md carrying the version in prose with no
   test guarding it at all. It has one now. **The pattern is the lesson: each
   time a place was added, it was found by a reader rather than by the flow, so
   assume there is a fifth and grep for the old number after every bump.**
4. **`git commit` the bumped files.** This step was missing from the flow until
   2026-08-13, when the AGY review lane found it: `git push` sends only what is
   committed, so following the old list literally pushed and tagged the PRE-bump
   commit while the new version numbers sat uncommitted in the working tree. It
   was added to `HANDOFF.md` the same hour and NOT here, and the release panel
   caught that too — one document is not both documents.
5. **`node scripts/roadmap-gate.mjs`** — `2` means the published roadmap page is
   behind `ROADMAP.md`. Then `node scripts/roadmap-render.mjs`, publish
   `docs/roadmap.html`, and `--record <url>`. Before 2026-08-13 that
   page had no source in this repository at all, so nothing could notice it had
   rotted; it rotted, repeatedly. The gate never records for you.
   **The renderer landed the same day and for a second reason: a gate raises the
   alarm without lowering the cost.** Every published version of that page was
   HTML written by hand, so "keep it current" meant remembering to dispatch an
   agent at it — and the gate would have gone on reporting STALE at a flow that
   still had no cheap way to answer it.
6. Run `node --test`, `git diff --check`, and
   `claude plugin validate --strict .` locally.
   **Read the SKIP count, not only the fail count.** Four tests skip themselves
   on macOS (`process.platform !== 'linux' || !existsSync('/usr/bin/bwrap')`),
   so the suite reads `847 pass / 0 fail / 4 skipped` here and `847/0/0` on a
   Linux host. A skipped test is an UNEXECUTED GUARD, not a passing one: those
   four had never run on any machine until 2026-08-09, and three of them failed
   the first time they did. `tests/acp-companion.test.mjs`
   was long treated as a timing flake — "a different name each time, re-run it
   alone and expect 120/120". **That clause was false**, and it let a real
   failure be dismissed for an unknown number of releases: on a clean tree at
   v0.13.1 `controller signal after exact load response fences the pre-receipt
   barrier` failed alone, twice in a row. Cause: the cancellation ladder and
   post-settlement descendant cleanup wrote the SAME control-log line, so a test
   demanded a `grace` step in front of a sweep that has nothing to wait for.
   Both now carry `(cancel)` / `(reap)`. Treat any failure there as OPEN —
   never as noise. The clause survived because nothing ever compared it against
   a run, which is the failure mode this repo exists to make impossible.
   **It happened again, and worse.** From `f528168` (2026-07-27) to 2026-08-03
   this file was 125/130 on macOS across three shipped releases, while HANDOFF
   recorded a clean suite. `groupPids()` and `waitForGroupGone()` both began
   `process.platform !== 'linux'` and answered "nobody else in the group" /
   "the group is gone" WITHOUT LOOKING, so every descendant sweep was a no-op
   here and a detached process outlived every cancellation. Two things hid it:
   the suite is green on Linux, and the test asserted the receipt's wording
   BEFORE `assertPidGone`, so a live orphan surfaced as a regex mismatch. Both
   are fixed; the file is 130/130 and the suite 494/494 on this machine. Rules:
   a test states the outcome before the words about it, and a platform branch
   that cannot answer must say UNKNOWN, never "no".
7. Push (confirm with Master first — see Rules), then
   `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
8. **Watch the CI run that push triggers, and do not tag a red one.**
   `gh run list --limit 3` then `gh run view <id> --log-failed`. Added
   2026-08-08 because it was missing and it cost two releases: CI had been
   failing since before v0.16.0 and v0.17.0 shipped on it, while the local
   suite read 793 pass / 0 fail against CI's 785 / 2. **The same command on the
   same commit does not see the same thing** — CI runs Linux and a clean HOME,
   and both failures lived in that gap (a test reading the author's
   `~/.config/claude-profiles/`, and an `fs.watch` delivery assertion that holds
   on macOS FSEvents and not on CI's filesystem). Local green is necessary and
   is not sufficient.
9. **Tag it and publish the GitHub release** — `git tag vX.Y.Z && git push
   origin vX.Y.Z`, then `gh release create vX.Y.Z --title vX.Y.Z --notes ...`
   with notes written from the real `git log <prev-tag>..vX.Y.Z`. A version
   number in three JSON files is not a release: this step was missing from the
   flow until 2026-08-04, and by then THIRTY versions between v0.1.1 and
   v0.14.4 had been "released" with no tag and no release page — the whole
   history had to be backfilled from git in one sitting. Anyone installing from
   the marketplace resolves a version-keyed cache, so an untagged release is a
   number nobody else can fetch. Write the notes with a heredoc or `--notes-file`,
   never `printf` — the backfill put a literal `%ad` into all 30 notes.
10. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills` to the
   new sha and push it. `agent-skills` uses that pin as the source for its
   OpenClaw bridge; Codex and Claude plugin runtimes use version-keyed caches.

## Rules

- Only release and plugin files are tracked: `.github/`, `.claude-plugin/`,
  `.gitignore`, `plugins/`, `tests/`, `scripts/`, `README.md`, `CLAUDE.md`,
  `ROADMAP.md`, `RELEASE-PLAN.md`, the `.published-*.json` markers (including
  `.roadmap-published.json`), and `HANDOFF.md`. The marker is
  tracked for the same reason the roadmap is: one that only its author's machine
  can read makes the gate answer STALE forever for everybody else, which turns a
  gate into noise. `HANDOFF.md` is the state of play between sessions — what shipped,
  what is open, what was decided and must not be relitigated, and where the
  disagreements were left. It is tracked so a fresh clone gets it too; a handoff
  only one machine can read is a handoff to nobody.
  BMAD scaffold dirs are gitignored — keep it that way. (`scripts/` was added
  2026-07-29 for `run-fast.mjs`: the Commands section above documents it, so it
  has to exist for anyone who clones this. Dev tooling only — nothing the
  plugin ships.)
- The marketplace on this machine is registered from GitHub
  (`iicmaster/tmux-teams`) — a release is NOT live until pushed; after
  pushing run `claude plugin marketplace update tmux-teams` then
  `claude plugin update tmux-teams@tmux-teams`. Confirm with Master before
  the push that ships a release.
- **Push as `iicmaster`.** This machine has three GitHub accounts in `gh`
  (`ngs-th`, `iicmaster`, `warawut-grit`) and the active one is often `ngs-th`,
  which has READ access here — `git pull` works, `git push origin` returns 403.
  `gh auth switch --user iicmaster` first. A second remote, `fork`
  (`ngs-th/tmux-teams`), accepts a push from the wrong account, so an
  unattended session can believe it shipped while `origin/main` never moved:
  on 2026-08-03 three fixes sat in that fork until someone looked. Check
  `git status -sb` says `main...origin/main` with no `ahead`, not just that a
  push printed a hash. Never bump the submodule pin in `~/agent-skills` to a
  sha that is only on the fork — that URL is `iicmaster`, and the pin would be
  unresolvable for everyone else while looking fine locally.
- `~/agent-skills` no longer carries standalone copies of the six it used to:
  `tmux-teams`, `party-mode`, `party-auto`, `party-advise`, `sqthink`,
  `codex-tmux-driver` — its `PLUGIN_DELIVERED` names exactly those, and the
  plugin has bundled more since.
  Treat THIS repo as authoritative; its submodule pin feeds the OpenClaw
  bridge, and must never be copied back from installed targets.
- `~/.claude/skills` must NOT contain those same six (they were
  deduplicated 2026-07-19; `agent-skills/scripts/sync.sh` purges them for the
  tool roots). Restoring them by hand recreates double-triggering.
- **An ACP dispatch that ends `no_outbox` may be recoverable — try resume
  before re-dispatching.** `ACP_RESUME=<session-id>` plus a short "write what you
  already have, do not redo the analysis" prompt costs a few hundred tokens
  against a whole re-run, so it is worth trying first even though it is not
  guaranteed: the one time it was tried here (2026-08-04) the load warned
  `load receipt lacks requested prior lineage` and the agent answered
  `I have nothing`. **Always include the "say I have nothing plainly if the
  context is gone" clause** — that honest refusal is what made the failure
  legible instead of producing a review reconstructed from the prompt. The id lives in the run cwd's `.tmux-teams/` (the
  companion's persisted session file) and, for the codex lane, in
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<session-id>.jsonl` — grep those
  for a phrase from the brief to tell attempts apart.
  **Never `rm -rf` an ACP run directory before recording the session id.** On
  2026-08-04 a 200KB brief made the codex lane finish its turn and write nothing
  twice; the directory was wiped before each retry, so three fresh runs were
  paid for while a 456KB session holding the finished analysis sat on disk. It
  took Master asking "we're on ACP, can't we resume?" to notice.
  Brief size was the first suspect and it is **not** the cause: 203KB failed
  twice and a 7KB brief failed the same way an hour later, while 52KB had
  succeeded that morning. Whatever produces `no_outbox` on this lane is
  unexplained — do not write a size rule into a skill on the strength of two
  data points, which is what this paragraph said until the third arrived.
- `acp-companion.mjs` honors `ACP_CMD="node <stub>.mjs"` — point it at a stub
  ACP agent (answers initialize/session/new/session/prompt) for fast,
  model-free tests of the outbox/timeout logic.
- A demo or study page must IMPORT the shipping module, never paste a copy of
  it. A pasted copy of the graph engine drifted within an hour, and it was the
  page being read, so four fixes were reported against stale bytes.
- Client code shipped as a JS template literal (`TOUR_SCRIPT`, `TOUR_CSS`,
  `NAV_CSS`, and the stylesheet inside `graph.mjs`) may contain no backtick —
  one in a comment closes the template and the module stops parsing a long way
  from the cause. Eleven occurrences so far. `tests/plugin-structure.test.mjs`
  now walks the whole shipped tree for this rather than naming strings by hand:
  it `node --check`s every `.mjs` and refuses a backtick in any export whose
  name ends in `CSS` or `SCRIPT`. Run `node --check` yourself before the suite
  anyway — it names the file in a second.
- A scripted edit (python `str.replace`) must `assert old in s` before writing.
  A replace that finds nothing writes the file unchanged and says nothing; two
  patches silently failed to apply that way on 2026-08-01.
- **Two ways a mutation survives that are the TEST's fault, both hit within an
  hour on 2026-08-09.** A test that ITERATES the constant it is validating
  proves nothing — delete an entry and the loop simply stops testing it, so pin
  the list literally as well. And a pure function tested in isolation says
  nothing about its CONSUMER — delete the call site and every test still passes.
  Check the wiring behaviourally; a source grep for the call is a tripwire, not
  a test. Both misses were found by mutation and by nothing else.
- **`ssh host 'cmd'` runs a NON-login shell, so `~/.local/bin` is absent from
  PATH** and `command -v claude` answers MISSING for tools that are installed —
  a whole survey was reported wrong that way. Use `ssh host 'bash -lc "…"'`, and
  write anything with nested quotes to a file and `scp` it instead of escaping
  it through zsh and bash in turn.
- **`git bundle create /tmp/x.bundle main` then `scp` moves unpushed commits to
  another machine without touching any remote** — the way to try work on a test
  box while `origin` stays untouched.
- **An ENOENT that names a SCRIPT means its shebang interpreter is missing**,
  not the script. And on a mise/asdf machine `realpath $(command -v node)` is
  the version-manager binary itself — it dispatches on `argv[0]`, so it is not
  an interpreter. Use `process.execPath` whenever the real one is meant.
