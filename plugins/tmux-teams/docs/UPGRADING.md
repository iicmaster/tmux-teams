# Upgrading tmux-teams

This file exists because nothing else in the repo answers "what changed since
the version I'm running, and does it break anything" from inside a checked-out
or installed copy. GitHub release notes exist, but they are outside the repo
and outside the plugin install — nobody reads them from `.tmux-teams/` at 2am
when a loop looks stuck. `docs/adr/` already holds the human-readable decision
record for this plugin (containment, review gates); this file is that same
genre — narrative, for a person, not for the agent — so it lives beside the
ADRs rather than at the repo root. It ships with the plugin (the plugin
source is `plugins/tmux-teams`, and `docs/` is inside it), so it is present in
an installed copy too, not just on GitHub. `README.md` and `CLAUDE.md` are
maintained elsewhere in this project; this file does not duplicate their
content and is not linked from either — find it by browsing `docs/` next to
the ADRs, or from the release notes.

**Two readers, two places to start:**

- **Already running tmux-teams and mid-loop right now** — read
  ["What changed since v0.14.6"](#what-changed-since-v0146) below. Skip to
  ["Does anything break?"](#does-anything-break) first if that's the only
  question you have.
- **Arriving fresh, nothing installed yet** — this file assumes you already
  know the system. Start with `README.md` (install, the ten skills, the
  published pages) and
  [`skills/tmux-teams/references/loop-system-contract.md`](../skills/tmux-teams/references/loop-system-contract.md)
  (§0–§9 for the model itself). Come back here once you're running something
  and want to know what changed under you.

## What changed since v0.14.6

Everything below is real on `main` as of this writing (`f75597f`, following
tagged release `v0.14.6` / `e0f96a9`). The plugin manifest still reads
`0.14.6` at the time this file was written — the version bump, tag, and
GitHub release for this range happen as a separate step per this repo's
release flow, and will most likely land as `0.15.0`. If you're reading this
from a tagged `v0.15.0` or later, "since v0.14.6" is the range this section
describes; check the file's own git history if you need the exact range for
a later version.

### Does anything break?

**No — checked against the code, not assumed.** The three places most likely
to break on an upgrade were each traced by hand:

- **An existing custody ledger still validates.** The one schema-relevant
  change is `validateLedger` now also returning a `heldTeams` array on its
  result object. It's computed from events every valid ledger already has
  (`opened`, `pulled`, `intake`) — nothing new is required on disk, and
  `validateLedgerTolerant` passes the same array through unchanged. No new
  problem code was added that an old ledger could trip.
- **A ledger written before `work_observed` existed still counts its attempts
  correctly.** `work_observed` is a new optional field `acp-companion.mjs`
  writes onto a `delivered` line. The runner's attempt-budget filter reads it
  as `legOutcome(item, taskId)?.work_observed === false` — on a line that
  predates this release the field is simply absent, `undefined === false` is
  `false`, and the leg counts against the attempt budget exactly as it always
  did (`plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs`,
  `legNeverStarted`/`attemptsBy`). Nothing about old history is
  reinterpreted; the new field only ever narrows what counts when it is
  explicitly present and `false`.
- **An existing `graph.json` still loads.** Two new keys on a seat override
  (`validateWorkflowGraph`), both *optional*: `display_model`, and `palette`
  (contract §3.5). A declaration that has never heard of either hits no new
  required field and no new key check that rejects it, and every board node
  falls back to the model it already showed
  (`plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs`, `modelLine`).
  Nothing in `pulse.json` changed shape either — the graph page's new
  stale-death logic (below) reads `elapsed_sec`/`timeout_sec`, fields that
  were already part of a run record.
- **One thing genuinely does change for every graph: `source_digest`.** The
  resolved `teams[].agents[]` entry gained a `palette` field, reported as
  `null` for the seats — today, all of them — that declare none, so the hash
  over the resolved graph moves even for a `graph.json` you have not touched.
  Measured against the tags, not reasoned — and corrected once: the bundled
  default graph resolves to `b8803e6a…` on v0.14.6 and `16e7d87c…` here. The
  first draft of this line said `ffe8ebe7…`, which was the digest of `main`
  mid-release rather than of the tag, caught by the v0.15.0 documentation
  review. A number offered as a measurement has to name what was measured.

  This is safe because nothing joins on a
  *workflow* graph's `source_digest` across versions — the digest
  `team-runtime.mjs` matches against is `team-graph-contract.mjs`'s, a
  different derivation over a different object — and because declarations
  that say the same thing still hash alike, which is the property §3.2.1
  actually depends on. If you have built something outside this plugin that
  pins a workflow graph's digest, that is the one thing here that will notice
  the upgrade.

If you find a case where one of those three claims is wrong, that is a bug in
this release, not a documentation gap — say so loudly rather than working
around it.

### What you get without doing anything

These take effect the next time the loop runs. No `graph.json` change, no new
flag, no migration step.

- **A leg that never got a turn stops spending the worker attempt budget.**
  Previously, a seat whose provider was rate-limited or refused the declared
  model could burn all of `MAX_ATTEMPTS` on legs that never actually ran, and
  the pool read as exhausted for a token that had never really been tried.
  Now only a leg that reached real agent activity (a tool call, a message,
  a completed prompt round trip — not just the bare ACP handshake) spends an
  attempt. **Not covered:** `legCeiling` (`MAX_LEGS`) still counts every
  `assigned` leg unconditionally, transport-failed or not — this fix narrows
  the attempt budget specifically, not the total leg ceiling.
  (GitHub #45 part 2; contract §4.10.)
- **The planner stops proposing a pull the ledger writer is guaranteed to
  refuse.** On an escalation exit — a token parked at a later team, resumed,
  and released there — the old code picked the next hop as
  `route[index + 1]`, which could point back at a team the token had already
  been admitted by. The writer's `route_went_backwards` check always refused
  that write, but the planner had no way to know it would, so it recomputed
  the same refused decision every tick forever — a token that looked stuck
  was actually stuck in a loop with no exit in code. The planner now skips any
  team the token's own ledger shows it has already been admitted by, and
  finishes the route (`completed`) if none are left. (GitHub #42/#44;
  contract §7.)
- **The runner records why it passed over a token, once per tick.** Every
  refusal — busy seats, a person still being waited on, an unbelievable
  ledger, no standing brief, an escalation mark the ledger refused to
  record — used to go to the console log only, and nothing else could read it
  back once the tick ended. `.tmux-teams/decisions/latest.json` now carries
  the same decisions, overwritten whole every tick that actually reaches the
  point of evaluating tokens. It answers "why is this not moving right now";
  it deliberately cannot answer "how long has it been stuck" — that's still
  the log's job. A dry run does not write it, same as the heartbeat file.
  (Contract §11.3.)
- **The panel-diversity check stops collapsing to one bucket.** Nine
  collision-decision functions in `party-mode`'s review-gate code were
  collapsed into one `laneIdentity()` with three explicit states —
  `identified`, `undeclared`, `unreadable` — instead of one value that
  conflated "we don't know" with "it's blank." This is an internal
  refactor of `review-profiles.mjs`; nothing in how you invoke `party-mode`,
  `party-auto`, or `party-advise` changes. (GitHub #43.)
- **A run that died stops reading as broken forever.** The loop graph page
  used to show a died run as "process not found" indefinitely. It now ages
  out of that state once the run is well past its own stall window (3× its
  timeout, minimum 15 minutes) and reads as an ordinary idle seat instead —
  a ready seat no longer misreads as a permanently broken one.
- **`/handoff` resolves.** The command file
  (`plugins/tmux-teams/commands/handoff.md`) that invokes the `handoff` skill
  was missing from the shipped tree; it's back.

### What you must opt into

- **`display_model` on a seat**, if you want the board to show the real
  model name for a seat whose dispatch alias is something else (for example
  a seat that dispatches as `opus` behind an adapter alias, where you want
  the page to say the actual model). Add `display_model` beside `model` on
  the seat override in `graph.json`. The dispatch layer never reads it — it
  is display-only, and if you don't set it, nothing changes.
- **The ledger-reader ratchet, and only if you are developing *this plugin's
  own source*.** `scripts/ledger-reader-ratchet.mjs` and
  `scripts/ledger-readers.baseline.json` live in this repo's top-level
  `scripts/` directory, which is dev tooling for people modifying
  `plugins/tmux-teams/skills/tmux-teams/scripts/` — it does not ship with the
  plugin and has no effect on a running loop. It fails when a file starts
  reading a token's ledger straight off disk (`readWorkItems`, `ledgerPath`,
  or the ledger-validate disk readers) without being added to the baseline;
  nine files are recorded readers today, so a tenth trips it. `node --test`
  already exercises it against this repo's own tree (`tests/ledger-reader-ratchet.test.mjs`),
  so if you're contributing to tmux-teams itself, you already get it for
  free by running the suite before committing. There is nothing to enable in
  a *consumer* project — it has no CI wiring outside this repository, and
  wiring it into your own project's CI is not something this release does
  for you.

### What is deliberately absent

- **There is no MCP server, and no dispatched agent receives one.** Every ACP
  call this system makes sends the literal `mcpServers: []` — not an
  omission, a closed seam. `loop-system-contract.md` §13 prohibits a
  non-empty `mcpServers` outright, and
  [`docs/adr/0003-mcp-server-containment-seam.md`](adr/0003-mcp-server-containment-seam.md)
  records why: an MCP server is a channel this system's own ledger, pull, and
  review machinery cannot mediate, attribute, or gate — opening it is a
  reduction in containment, not an added feature, and the ADR requires a
  human maintainer's sign-off to amend, not a `graph.json` field or an
  environment variable. If you were expecting this to open up as the system
  matures, it's the opposite: it stays closed on purpose, and a per-seat
  allowlist is recorded in that ADR only as a possible *future* shape, not
  something this release builds toward.
- **There is no write/mutation tool of any kind that a dispatched agent can
  call.** This follows from the same seam: nothing this system dispatches has
  a channel back into the ledger, the graph, or the loop's own state other
  than the sanctioned custody events its brief already asks for
  (`ledger-writer.mjs` / `acp-companion.mjs` remain the only two writers,
  per §13). This is a separate fact from, and not the reason for, a known
  limitation already on record: contract §14.2 item 5 documents that this
  system's own internal ledger-append lock (used between the runner and the
  companion, not exposed to a dispatched agent at all) cannot be proven safe
  against a stale takeover — a live-but-slow lock holder can still be stolen
  from, and file primitives cannot close that window; fencing tokens would,
  and are not implemented. That defect is about this system's *own* internal
  writers contending with each other, not about whether a dispatched agent
  could be given a write tool — but it's one more reason a general-purpose
  mutation channel for dispatched agents isn't a small addition on top of
  what exists today.

## Full change index

Not a source of truth — an index into it. Read the cited section or commit if
you need the actual reasoning; this table only says where to look.

| Change | Where | Opt-in? |
| --- | --- | --- |
| Attempt budget ignores legs that never got a turn | contract §4.10; `loop-runner.mjs`, `acp-companion.mjs` | No |
| Planner skips route hops the token already holds | contract §7; `pull-controller.mjs`, `ledger-validate.mjs` | No |
| `.tmux-teams/decisions/latest.json` records why a token was passed over | contract §11.3; `loop-runner.mjs` | No |
| Panel diversity: `laneIdentity()` replaces nine collision functions | `party-mode/scripts/review-profiles.mjs` | No |
| A died run ages out of "process not found" | `graph.mjs` | No |
| `/handoff` command file restored | `plugins/tmux-teams/commands/handoff.md` | No |
| `display_model` on a seat | `workflow-graph.mjs`, `graph.mjs` | Yes — add the key |
| Ledger-reader ratchet | `scripts/ledger-reader-ratchet.mjs` (repo dev tooling, not shipped) | Yes, and only if developing this plugin |
| `mcpServers` stays closed | contract §13; `docs/adr/0003-mcp-server-containment-seam.md` | N/A — deliberately absent |
