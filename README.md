# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch CLI agents (codex, claude,
gemini, agy) over **two transports — tmux and ACP** — on one mailbox contract
(evidence-not-attestation outbox + typed terminal markers), plan every
dispatch with `sqthink` + task creation, gate completion with `party-mode`
verification.

## v0.6.1 hardening release

- ACP permission responses check that `options` is an array. Empty or non-array
  options return the protocol's cancelled outcome instead of dereferencing a
  missing choice; valid choices retain the existing allow-always,
  then allow-once, then first-option precedence.
- The experimental Stage 0 validator returns structured diagnostics for
  malformed container shapes, enforces proposer/receiver separation even when
  actor roles overlap, and rejects non-finite aggregate, loaded-cost, or
  comparison arithmetic instead of emitting an invalid report.
- Pulse keeps its dynamic HTML small by publishing the bundled Kanit payload
  once as a local content-addressed stylesheet. The canonical page remains
  offline and network-free, but it is deliberately no longer a single file.

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

## Transports

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

The canonical offline page is
`<repo>/.tmux-teams/pulse.html` together with its sibling
`pulse-fonts-<sha256>.css`. The stylesheet contains the bundled Kanit WOFF2
data URLs, is atomically published before the HTML, and is not rewritten when
its content is unchanged; it makes no font-network request. Keep both files
together—copying `pulse.html` alone still shows the dashboard with fallback
fonts, but is not the canonical page.

Human-visible absolute timestamps in the header, recent verdicts, and run
details use `Asia/Bangkok` and are labelled `เวลาไทย (UTC+7)`. Pulse Data v1
continues to publish machine timestamps as RFC 3339 UTC.

## Install

```bash
claude plugin marketplace add iicmaster/tmux-teams
claude plugin install tmux-teams@tmux-teams
```

Authenticate `gh`/git first if your GitHub setup requires it. Installation uses
the latest pushed marketplace version; changing a checkout or bumping its
manifest does not update an installed copy. After a release is pushed, run
`claude plugin marketplace update tmux-teams` followed by
`claude plugin update tmux-teams@tmux-teams`.

## Prerequisites (soft dependencies)

- `tmux`, and the `codex` CLI for the worker lane; Node 20+ with `npx` for
  the ACP adapters. CI exercises Node 20 and Node 24.
- party-mode's 3-model review lanes need the `oc` (opencode) and `agy`
  (antigravity) plugins plus Codex MCP — without them party-mode falls back
  per its own review-fallback rules.

## Update lifecycle (this repo IS canonical — flipped 2026-07-21)

Skill content lives here, in `plugins/tmux-teams/skills/` — edit it directly.
`~/agent-skills` vendors this repo as the submodule `plugins/tmux-teams`, has
deleted its standalone copies of all six bundled skills, and uses the submodule
as the source for its OpenClaw bridge. Codex and Claude load their own
version-keyed plugin caches.

1. Edit the skill under `plugins/tmux-teams/skills/` and commit here.
2. Bump the version in BOTH `plugins/tmux-teams/.claude-plugin/plugin.json`
   and `.claude-plugin/marketplace.json` (the test asserts they match).
3. Run `node --test`, `git diff --check`, and the local-only
   `claude plugin validate --strict .` release gate.
4. Push, then `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
5. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills`.

GitHub Actions runs `node --test` plus `git diff --check` with no repository
secrets on Node 20 and Node 24. Strict plugin validation remains a local release
gate because the Claude CLI is not provisioned in CI. Pass no path:
`node --test tests/` fails on Node 24.

Note: `~/.claude/skills` no longer carries these six skills (they are
plugin-delivered; `agent-skills/scripts/sync.sh` purges them from the tool
skill roots since the 2026-07-21 flip).
