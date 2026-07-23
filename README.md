# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch CLI agents (codex, claude,
gemini, agy) over **two transports — tmux and ACP** — on one mailbox contract
(evidence-not-attestation outbox + typed terminal markers), plan every
dispatch with `sqthink` + task creation, gate completion with `party-mode`
verification.

## Skills

| Skill | Purpose |
|---|---|
| `tmux-teams:tmux-teams` | PM protocol over tmux + ACP: dispatch, completion detection, capture, mailbox pattern, run memory (§9) |
| `tmux-teams:codex-tmux-driver` | Codex TUI calibration (flags, markers, dialogs) for the codex worker lane |
| `tmux-teams:party-mode` | Multi-agent execution/advisory workflow with 3-model review + grill gate |
| `tmux-teams:party-auto` | Execution lane of party-mode |
| `tmux-teams:party-advise` | Read-only advisory lane of party-mode |
| `tmux-teams:sqthink` | Sequential-thinking analysis/planning |

Commands: `/tmux-teams:mailbox-run` — run the mailbox PM workflow end to end.

## Experimental Stage 0 — delivery-loop measurement PoC

This opt-in, offline measurement-feasibility PoC is not an activated dispatch
hierarchy. Invoke it only for a named experiment JSON:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-poc.mjs analyze <experiment.json>
```

It models a PM outer loop around four Phase Team inner loops and their exit
artifacts: Requirement `requirements_baseline`, Prototype
`prototype_evaluation`, Development `development_delivery`, and QA
`qa_release_evidence`. Routine handoffs go directly to the receiver-owned
phase lead; the PM retains the exception, policy-conflict, and deadlock
boundary. The final boundary is a real `QA -> ProjectDelivery` handoff carrying
`qa_release_evidence`; its ProjectDelivery receiver owns routine acceptance
while the PM tracks outer-loop coordination and exceptions.

Recorded handoff attempts are actor-authorized, event-replayed terminal
histories whose events stay within `[slice.assigned_at, analysis_as_of]`; a
revision proposal is strictly later than its rejected parent's terminal event.
Canonical JSON and digests sort keys by true Unicode code-point order, not
JavaScript UTF-16 code-unit order. The primary estimand is the per-slice mean
by arm; raw arm totals are descriptive only. Every pre-registered guardrail is
recorded as `PASS`, `BREACH`, or `UNKNOWN`, and any `UNKNOWN` makes `measurement_readiness`
`INCONCLUSIVE`. Missing measured cost is explicit `null`, never zero: affected
totals and cost comparisons remain null, while bottleneck status and readiness
are `INCONCLUSIVE`.

Its JSON intentionally separates `measurement_readiness`, `scenario_signal`,
`guardrail_status`, `evidence_eligibility`, `safety_hold_recommended`, and
`decision_packet`. Deterministic, descriptive-only `bottlenecks.by_arm`
identifies the highest coordination phase and cost category per arm.
`business_decision` is always `EXTERNAL_REQUIRED`, so it cannot claim causal
effect or ROI, or return `GO`/`ITERATE`/`NO_GO`. `READY` means measurement
completeness, not accepted delivery, delivery success, or business approval.
It changes none of the existing tmux/ACP dispatch, mailbox, PM verification,
Party gates, KMS, Pulse,
role-loading, cleanup, or transport semantics. The compact
[Stage 0 reference contract](plugins/tmux-teams/skills/tmux-teams/references/two-level-delivery-loop-poc.md)
contains the complete rules plus Mermaid flowchart and sequence diagram.

## v0.7 Stage 1 — field-evidence toolkit

Stage 1 turns the Stage 0 model into an opt-in, append-only field-observation
toolkit. Its outcome is an integrity-bound evidence pack and a reproducible
measurement signal for external review—not a causal claim, certified result,
release approval, ROI claim, or business verdict. Same-UID observations remain
`advisory_same_uid`; exported packs remain `NOT_CERTIFIED`, require an external
business decision, and declare no actuation.

The operating model is still two-level: the PM coordinates the outer loop and
owns exceptions, while sender/receiver phase leads own the inner handoff loop
and routine acceptance. Assignment compares the frozen `pm_routed` and
`receiver_owned` protocols, but the toolkit only records assignment and named
source facts. It never routes or dispatches a worker.

From the repository root, the exact CLI is:

```bash
# Freeze a private draft into an immutable manifest and new observation store.
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs freeze \
  <draft.json> --store <absolute-store> --seed-file <outside-repo-seed-file> \
  --frozen-at <RFC3339>

# Prospectively assign one eligible slice.
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs assign \
  <candidate.json> --store <absolute-store> --seed-file <outside-repo-seed-file> \
  --assigned-at <RFC3339> --actor <assignment-custodian-id>

# Capture one named dispatch, outbox, or KMS source without mutating it.
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-capture.mjs capture \
  <mailbox-dispatch|mailbox-outbox|kms-event> <named-source> \
  --store <absolute-store> --slice <slice-id> --actor <actor-id> --at <RFC3339> \
  [--role pm|metric_producer] [--correlation <dispatch-id>]

# Deterministically reconstruct state and repeat the evidence build at least 3 times.
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs replay \
  --store <absolute-store> --as-of <RFC3339>
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs rehearse \
  --store <absolute-store> --as-of <RFC3339> [--runs 3]

# Export a file-based pack, then verify its index, files, digests, and replay.
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs export \
  --store <absolute-store> --out <new-absolute-pack-dir> --as-of <RFC3339> \
  --source-revision <40-hex-git-sha>
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs verify-pack \
  <absolute-pack-dir>
```

The normative contracts are the
[pilot manifest schema](plugins/tmux-teams/skills/tmux-teams/references/delivery-loop-pilot-manifest-v1.schema.json),
[event schema](plugins/tmux-teams/skills/tmux-teams/references/delivery-loop-event-v1.schema.json),
[evidence-pack schema](plugins/tmux-teams/skills/tmux-teams/references/delivery-loop-evidence-pack-v1.schema.json),
[Pulse v2 schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v2.schema.json),
and Thai-first
[Stage 1 pilot runbook](plugins/tmux-teams/skills/tmux-teams/references/stage-1-pilot-runbook.md).

Pulse v2 is explicit opt-in and keeps the same single
`<repo>/.tmux-teams/pulse.json` SSOT:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json \
  <repo> --delivery-loop <absolute-pulse-projection.json>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs compat-v1 <repo>
```

`compat-v1` writes a v1 down-projection to stdout only; it does not create a
second persisted snapshot. Pulse remains read-only and advisory. No Stage 1
command automatically routes work, certifies evidence, emits
`GO`/`ITERATE`/`NO_GO`, or applies a recommendation.

## Transports (v0.2.x)

The mailbox contract (brief in → `.mailbox-out/<id>` outbox +
`TEAM_DONE`/`TEAM_BLOCKED`/`TEAM_FAILED` out → PM adversarial verify) is
transport-independent:

| worker | primary | fallback |
|---|---|---|
| codex | ACP — `@agentclientprotocol/codex-acp` (drives the installed CLI; frontier model verified) | tmux |
| claude | ACP — `@agentclientprotocol/claude-agent-acp` (pass `ANTHROPIC_MODEL=claude-opus-4-8`) | tmux |
| gemini | ACP — native `--acp` (dead for individuals 2026-07-21; needs a valid `GEMINI_API_KEY`) | — |
| agy | ACP — `antigravity-acp@1.0.0` (community adapter, source-audited 2026-07-21; needs `bun`; ToS risk — SKILL.md §8) | tmux |

One worker over ACP:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs \
  codex <repo> <task-id> <brief-file> [timeout-sec]
```

See `skills/tmux-teams/SKILL.md` §6-§8 for the contract, tmux lane, and ACP lane.

## Pulse v1 — agent-readable live state

Pulse has one data path: probes produce
`<repo>/.tmux-teams/pulse.json`, the machine-readable SSOT, and
`<repo>/.tmux-teams/pulse.html` is rendered only from that serialized JSON.
There is no second HTML-side interpretation of the probes.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json <repo>
```

`json` prints the exact persisted Pulse v1 document. Its contract is
`plugins/tmux-teams/skills/tmux-teams/references/pulse-v1.schema.json` and
includes snapshot identity/freshness, source diagnostics, run state, and
`dispatch_id` correlation. Pulse is read-only and reports
`trust_level: advisory_same_uid`; suggested action codes are advisory and are
never executed automatically. See `skills/tmux-teams/SKILL.md` §10.

## Install (this machine)

```bash
claude plugin marketplace add /home/iicmaster/projects/tmux-teams
claude plugin install tmux-teams@tmux-teams
```

For a second machine: `claude plugin marketplace add iicmaster/tmux-teams`
(private repo — authenticate `gh`/git first), then the same `plugin install`.

## Prerequisites (soft dependencies)

- `tmux`, and the `codex` CLI for the worker lane; Node 18+ with `npx` for
  the ACP adapters.
- party-mode's 3-model review lanes need the `oc` (opencode) and `agy`
  (antigravity) plugins plus Codex MCP — without them party-mode falls back
  per its own review-fallback rules.

## Update lifecycle (this repo IS canonical — flipped 2026-07-21)

Skill content lives here, in `plugins/tmux-teams/skills/` — edit it directly.
(`~/agent-skills` vendors this repo as the submodule `plugins/tmux-teams` and
deleted its own copy of the tmux-teams skill; remaining duplicates there are
non-authoritative.)

1. Edit the skill under `plugins/tmux-teams/skills/` and commit here.
2. Bump the version in BOTH `plugins/tmux-teams/.claude-plugin/plugin.json`
   and `.claude-plugin/marketplace.json` (the test asserts they match).
3. Push, then `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
4. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills`.

`node --test` runs the whole suite (structure, semantics, KMS). Pass no path:
`node --test tests/` fails on Node 24.

Note: `~/.claude/skills` no longer carries these six skills (they are
plugin-delivered; `agent-skills/scripts/sync.sh` purges them from the tool
skill roots since the 2026-07-21 flip).
