# tmux-teams plugin repo — agent instructions

This repo is a **Claude Code directory marketplace** delivering one plugin
(`tmux-teams`, see `plugins/tmux-teams/`) — and it is the **canonical source**
of the six bundled skills. Edit them directly under
`plugins/tmux-teams/skills/`. (Flipped 2026-07-21: agent-skills commit
`dd43dc1` vendored this repo as the authoritative submodule and deleted its
own `skills/shared/tmux-teams`; the old mirror/sync flow is gone.)

## Commands

```bash
node --test                        # whole suite — structure, semantics, KMS
git diff --check                  # repository whitespace gate
claude plugin validate --strict .  # manifest validation
```

`node --test tests/` (a bare directory) fails on Node 24 with MODULE_NOT_FOUND —
pass no path at all, or a glob like `tests/*.test.mjs`.

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
2. Bump the version in BOTH `.claude-plugin/marketplace.json` and
   `plugins/tmux-teams/.claude-plugin/plugin.json` (test asserts they match).
3. Run `node --test`, `git diff --check`, and
   `claude plugin validate --strict .` locally.
4. Push (confirm with Master first — see Rules), then
   `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
5. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills` to the
   new sha and push it. `agent-skills` uses that pin as the source for its
   OpenClaw bridge; Codex and Claude plugin runtimes use version-keyed caches.

## Rules

- Only release and plugin files are tracked: `.github/`, `.claude-plugin/`,
  `.gitignore`, `plugins/`, `tests/`, `README.md`, and `CLAUDE.md`. BMAD
  scaffold dirs are gitignored — keep it that way.
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
