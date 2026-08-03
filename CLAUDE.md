# tmux-teams plugin repo — agent instructions

This repo is a **Claude Code directory marketplace** delivering one plugin
(`tmux-teams`, see `plugins/tmux-teams/`) — and it is the **canonical source**
of the six bundled skills. Edit them directly under
`plugins/tmux-teams/skills/`. (Flipped 2026-07-21: agent-skills commit
`dd43dc1` vendored this repo as the authoritative submodule and deleted its
own `skills/shared/tmux-teams`; the old mirror/sync flow is gone.)

## Commands

```bash
node scripts/run-fast.mjs fast     # explicit in-process inner tier
node --test                        # whole suite — structure, semantics, KMS; run before commit
git diff --check                   # repository whitespace gate
claude plugin validate --strict .  # manifest validation
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

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once <repo>
```

Republishes `pulse.html`, `graph.html`, `kanban.html` — the repo argument is
required, and a bare `pulse.mjs once` only prints usage.

## Checking a published page

Never from a screenshot: a still image cannot show whether anything is moving,
and four "fixed" reports were made against one on 2026-08-01. Serve the store
over HTTP, then MEASURE — `getComputedStyle(el).animationName`, count
`animateMotion` nodes and match `path` against each wire's `d`, compare
`getBoundingClientRect()` of a halo with the card it rings. Every wire carries
`data-from`/`data-to` so a check never reverse-engineers geometry.
`plugins/tmux-teams/skills/tmux-teams/references/loop-graph-page.md` §9 is the
method for this, and the rest of that file is what `graph.html` may draw. It is
a chapter of `references/loop-system-contract.md` §12 — **the contract is the
one SSOT** and wins if the two ever disagree.

## Worker dispatch planning gate

- Before **every new delivery-worker dispatch**—including retry, corrective,
  implementation, QA, and dogfood work—freeze the final bounded plan after
  critique/grill/decomposition. The reviewed plan must bind the objective and
  acceptance-criteria hashes and preselect each step's task ID, dispatch ID,
  agent ID, model profile, dependency, and unchanged worker-brief hash. Review
  those exact plan bytes with `party-advise` through the bundled ACP-only
  three-model gate.
- Dispatch requires three schema-valid, substantive reviews from three
  distinct, acknowledged non-primary model families, with AGY mandatory, and a
  final synthesis of `PASS`. Three reports are required; “2/3” means that the
  same objection raised by at least two of the three is must-fix, not that two
  reports are enough.
- Every tmux-teams AGY route defaults to `gemini-3.6-flash-high`. Gemini 3.1
  variants are prohibited for ACP planning, review, and delivery work; fail
  closed if a configured or acknowledged AGY model is Gemini 3.1, and never
  fall back to it.
- Any single blocking finding, any must-fix objection, or any mutation of the
  plan invalidates the review. Resolve it and rerun all three reviewers on the
  new bytes; never retry a model objection away.
- Bind the accepted plan input hash, review-receipt digest, plan step ID, and
  every worker-brief hash into a separate dispatch-ledger record before ACP
  spawn. Never modify the reviewed brief to add receipt metadata. Fail closed
  on objective, acceptance-criteria, dependency, worker identity, model
  profile, plan, or brief drift; missing evidence; replay; model mismatch; or
  provider unavailability. One accepted plan may authorize multiple workers
  only when every unchanged brief is listed and hashed in its frozen manifest.
- A transport or protocol failure may receive one fresh-session retry against
  the same plan hash. Fewer than three accepted reviews remains visibly
  blocked; no silent substitution or two-reviewer degradation is allowed.
- Reviewer and read-only planning lanes are exempt from the delivery-worker
  gate so the rule cannot recurse into itself; they remain read-only and cannot
  launch delivery work.
- Determine agent progress from ACP/protocol/process state. Elapsed time alone
  is never proof that a delivery worker or reviewer is stalled.
- The sole grandfathered process lineage is task
  `acp-session-receipt-r3-model-r1`, dispatch
  `26029f55-12f9-4fc3-9f3e-c6b91add2f52`, ACP session
  `019f9981-d62b-73b0-9c3d-f91dabc3e310`, and agent
  `root_liveness_implementer`. Its next retry, correction, resume under a new
  dispatch ID, or successor must pass this gate.
- This is a procedural rule for the trusted Project Control agent. Mechanical
  dispatch enforcement and closed receipt schemas remain separate future work
  and must not be claimed complete. No implicit environment-variable bypass is
  permitted; only a later explicit instruction from Master may change this
  rule before a dispatch.

## Release flow

1. Edit skills under `plugins/tmux-teams/skills/` (this repo IS canonical).
2. Bump the version in all THREE places — `.claude-plugin/marketplace.json`
   (twice: `metadata.version` and `plugins[0].version`),
   `plugins/tmux-teams/.claude-plugin/plugin.json`, and `RELEASE_VERSION` in
   `tests/plugin-structure.test.mjs`. That test is the only thing checking they
   agree, so it has to state the number itself. This step said "BOTH" until
   2026-08-01, and v0.12.0 reached the bump with the third one still on 0.11.1
   until the test caught it.
3. Run `node --test`, `git diff --check`, and
   `claude plugin validate --strict .` locally. `tests/acp-companion.test.mjs`
   was long treated as a timing flake — "a different name each time, re-run it
   alone and expect 120/120". **That clause was false**, and it let a real
   failure be dismissed for an unknown number of releases: on a clean tree at
   v0.13.1 `controller signal after exact load response fences the pre-receipt
   barrier` failed alone, twice in a row. Cause: the cancellation ladder and
   post-settlement descendant cleanup wrote the SAME control-log line, so a test
   demanded a `grace` step in front of a sweep that has nothing to wait for.
   Both now carry `(cancel)` / `(reap)`; the file is 123/123. Treat any failure
   there as OPEN — never as noise. The clause survived because nothing ever
   compared it against a run, which is the failure mode this repo exists to
   make impossible.
4. Push (confirm with Master first — see Rules), then
   `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
5. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills` to the
   new sha and push it. `agent-skills` uses that pin as the source for its
   OpenClaw bridge; Codex and Claude plugin runtimes use version-keyed caches.

## Rules

- Only release and plugin files are tracked: `.github/`, `.claude-plugin/`,
  `.gitignore`, `plugins/`, `tests/`, `scripts/`, `README.md`, `CLAUDE.md`, and
  `HANDOFF.md`. The last is the state of play between sessions — what shipped,
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
- `~/agent-skills` no longer carries standalone copies of these six skills.
  Treat THIS repo as authoritative; its submodule pin feeds the OpenClaw
  bridge, and must never be copied back from installed targets.
- `~/.claude/skills` must NOT contain the six bundled skills (they were
  deduplicated 2026-07-19; `agent-skills/scripts/sync.sh` purges them for the
  tool roots). Restoring them by hand recreates double-triggering.
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
