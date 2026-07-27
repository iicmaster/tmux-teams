# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch CLI agents (codex, claude,
agy) over **two transports — tmux and ACP** — on one mailbox contract
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
| `tmux-teams:party-mode` | Multi-agent execution/advisory workflow with an ACP-only exact-three 3-model review gate + grill gate |
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
[Pulse v4 schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v4.schema.json),
[Pulse v3 compatibility schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v3.schema.json),
and Thai-first
[Stage 1 pilot runbook](plugins/tmux-teams/skills/tmux-teams/references/stage-1-pilot-runbook.md).

Pulse v4 is the default and keeps the same single
`<repo>/.tmux-teams/pulse.json` SSOT. It preserves the bounded Pulse v3
run/verdict fields and their `phase` and
`phase_source` attributes are explicit evidence for the phase flowchart; a
missing or untrusted attribution remains unassigned rather than being inferred
from a task name, worker, timestamp, or apparent handoff. Existing v3 documents
remain described by `pulse-v3.schema.json`; v4 adds the optional, closed
`delivery_runtime` field and otherwise references the v3 definitions. The
bounded `delivery_loop` and `delivery_runtime` inputs appear only when their
projections are named:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json \
  <repo> --delivery-loop <absolute-pulse-projection.json>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json \
  <repo> --delivery-runtime <absolute-delivery-runtime.json>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs compat-v1 <repo>
```

`compat-v1` writes a v1 down-projection to stdout only; it does not create a
second persisted snapshot. Pulse remains read-only and advisory. No Stage 1
command automatically routes work, certifies evidence, emits
`GO`/`ITERATE`/`NO_GO`, or applies a recommendation.

## Governed four-phase runtime and reproducible POC

The operational phase gate is opt-in and separate from the observe-only Stage 1
pilot. `phase-gate-controller.mjs` owns the governed write path for one linear
Requirement → Prototype → Development → QA slice. Initialization freezes a
strict manifest/store and writes `<repo>/.tmux-teams/phase-gate.json`.
Once that marker exists, invoking `acp-companion.mjs` directly without the
controller-bound reservation environment fails before brief, dispatch,
session, outbox, or KMS side effects.

The controller reserves an exact ledger head and dispatch UUID before spawning
ACP. The governed companion then records child registration, receiver
consumption, footprint, prompt, and terminal observations. An ambiguous
post-spawn path becomes `indeterminate`; it cannot auto-retry and requires an
explicit PM reconciliation/resolution. Claims remain structural and
`advisory_same_uid`, not authenticated identity.

There are exactly four Phase Teams. A normal phase completes only when the next
phase's first governed dispatch consumes the exact accepted artifact. The final
`QA -> ProjectDelivery` receiver acceptance is terminal: ProjectDelivery is not
Phase 5, creates no fifth ACP phase dispatch, and does not imply release,
business, or UAT approval.

Run the deterministic full-loop POC against the bundled mock ACP fixture:

```bash
POC_OUT="$(mktemp -d)/run"
POC_MOCK="$(realpath tests/fixtures/mock-acp-agent.mjs)"
node plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-poc.mjs \
  --out "$POC_OUT" \
  --acp-cmd "node $POC_MOCK" \
  --time-zone Asia/Bangkok --timeout 15
```

Run this from the checkout root; `mktemp` guarantees a new `--out` directory
and `realpath` keeps the fixture valid after the companion changes into the
generated repository. A successful run writes
`poc-result.json`, `delivery-runtime.json`, and the Pulse v4 JSON/HTML. `measurement.status: scenario_signal` means the single
scenario followed the expected governed path and produced measurement-ready
evidence; it is not a causal or business verdict. `roi.status:
ROI_NOT_ESTABLISHED` is the required interpretation: one deterministic run has
neither a production baseline nor a counterfactual, so ROI needs matched
production slices and measured routing, queue, rework, and defect costs.

The POC also records one inner-loop worker verdict for each of the four Phase
Teams so the Pulse graph can clear its pending-review (`ต้องตรวจ`) state. KMS
retains the legacy field name `pm_verdict`, but these POC records explicitly
carry `verifier_role: phase_team`: the field name is storage compatibility and
does not mean a PM performed, approved, or participated in the verification.

## Transports

The mailbox contract (brief in → `.mailbox-out/<id>` outbox +
`TEAM_DONE`/`TEAM_BLOCKED`/`TEAM_FAILED` out → PM adversarial verify) is
transport-independent:

| worker | primary | fallback |
|---|---|---|
| codex | ACP — `@agentclientprotocol/codex-acp@1.1.7` (drives the installed CLI; frontier model verified) | tmux |
| claude | ACP — `@agentclientprotocol/claude-agent-acp` (pass `ANTHROPIC_MODEL=claude-opus-4-8`) | tmux |
| agy | ACP — `antigravity-acp@1.0.0` (community adapter, source-audited 2026-07-21; needs `bun`; ToS risk — SKILL.md §8) | tmux |

The Gemini worker lane has been removed. The companion rejects that retired
public agent name even when `ACP_CMD` is set, preventing an override from
silently reviving it.

One worker over ACP:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs \
  codex <repo> <task-id> <brief-file> [timeout-sec]
```

The optional duration is an inactivity/stall lease, not a total task timeout;
there is no wall-clock ceiling unless `ACP_HARD_TIMEOUT_SEC>0` is set. ACP
liveness snapshots use the exact `acp-liveness.v1` contract, and Codex defaults
to `INITIAL_AGENT_MODE=agent-full-access` unless the caller supplies an explicit
override of `read-only`, `agent`, or `agent-full-access`; other Codex modes fail
before spawn. Tool records use only the ACP v1 statuses `pending`, `in_progress`,
`completed`, and `failed`, with bounded redacted metadata and digests. The
public liveness projection is capped at `tools` 64, `active_tools` 8,
`stall_history` 32, and 64 KiB of UTF-8 JSON; active tools are selected first
and terminal snapshots compact deterministically before an atomic write. The
terminal `liveness_state` is authoritative: terminal `active_tools` is always
`[]`, while `tools` may retain bounded last-reported ACP evidence. A successful
terminal return requires an atomic liveness write/readback that agrees with
the dispatch state; a write or readback failure returns nonzero with
`liveness_persistence_failed` evidence. Mechanical terminal evidence keeps
cancel ACK, attempted/delivered TERM/KILL, child exit code/signal, child-settlement
signal delivery, and descendant-only cleanup delivery separate. A clean child
exit 0 remains `cancelled` when only the remaining descendant group needed
cleanup; descendant cleanup never turns that settlement into `stalled`/forced.
Each dispatch also commits one immutable, no-replace
`.tmux-teams/receipts/<dispatch_id>.json` operation receipt, described by
`plugins/tmux-teams/skills/tmux-teams/references/acp-session-receipt-v1.schema.json`.
The receipt is paired with an immutable
`.tmux-teams/receipt-commits/<dispatch_id>.json` commitment envelope; only a
fresh file-fsync, directory-fsync, no-replace publication, joint readback, and
exact digest check trust the pair. It is committed and read back after the
correlated `session/new` or `session/load` response, observed adapter identity
enforcement, and before any prompt byte or prompt phase-gate event. A load is
proven only by the exact correlated JSON-RPC response for the requested session;
a response `sessionId` is not trusted or invented. The receipt records the
effective verified `INITIAL_AGENT_MODE` alongside the raw-byte execution
profile digests, and `initialize_agent_info` is the adapter identity observed
in the correlated initialize response, not the companion's sent client info.
`ACP_SESSION_RECEIPT_REQUIRED=1` requires explicit operation and prior-receipt
lineage inputs, rejects arbitrary `ACP_CMD` overrides, and fails closed before
prompt delivery when the receipt pair cannot be committed. In default mode, an
unavailable receipt is reported with `receipt_digest: none` and the legacy
prompt path continues; required mode never degrades this way.
Required Codex dispatches resolve the locally pinned
`@agentclientprotocol/codex-acp@1.1.7` package, verify its package metadata and
entry bytes, bind the profile to the real Node and `CODEX_PATH` executable
bytes/version, and spawn that verified Node/entry pair. Cache drift, PATH
shadowing, fake version output, profile drift, or an unsafe receipt directory
fails before spawn; the resulting failure is represented by a null-operation
receipt tombstone when publication is possible.

See `skills/tmux-teams/SKILL.md` §6-§8 for the contract, tmux lane, and ACP lane.

## Pulse v4 — agent-readable live state

Pulse has one data path: probes produce
`<repo>/.tmux-teams/pulse.json`, the machine-readable SSOT, and
both `<repo>/.tmux-teams/pulse.html` and the full-screen
`<repo>/.tmux-teams/loop-graph.html` are rendered only from that serialized
JSON. There is no HTML-side interpretation of the probes.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json <repo>
```

`json` prints the exact persisted Pulse v4 document. Its contract is
`plugins/tmux-teams/skills/tmux-teams/references/pulse-v4.schema.json`; its
run/verdict definitions retain Pulse v3 compatibility through
`pulse-v3.schema.json`. It
includes snapshot identity/freshness, source diagnostics, run state,
`dispatch_id` correlation, and explicit phase attribution. Pulse is read-only and reports
`trust_level: advisory_same_uid`; suggested action codes are advisory and are
never executed automatically. See `skills/tmux-teams/SKILL.md` §10.

The canonical offline views are `<repo>/.tmux-teams/pulse.html` and
`<repo>/.tmux-teams/loop-graph.html` together with their sibling
`pulse-fonts-<sha256>.css`. The stylesheet contains the bundled Kanit WOFF2
data URLs. Every page is plain document flow with static SVG — no charting
library is vendored or loaded. All assets are atomically published before the
HTML pages and are
not rewritten when their content is unchanged; neither view makes a network
request. Keep the sibling assets beside the pages for offline bundle identity.
`<repo>/.tmux-teams/pulse-current.json` is the bundle commit marker written
last. It names and hashes the JSON, every HTML page and the font stylesheet;
readers can reject a mixed/partial publish
by validating those hashes and re-reading the marker after the files.

`team-flow.html` is the Team delivery flowchart and ships ready to use: it draws
the declared loop as lanes — dispatcher, workers and the team's own evaluator —
with a `passed · handoff contract` edge into the next team, a rework edge back
into the same queue, and Project Delivery as a terminal node rather than a fifth
team. One node is exactly one agent and carries its status, model and transport
(`acp` or `tmux`). Topology comes from `<repo>/.tmux-teams/team-graph.json`
validated by the Team contract, or from the bundled four-team template when that
file is absent; an invalid file fails the page closed with the reason instead of
falling back. Nodes bind to evidence by `agent_id` only, so a dispatch must set
`ACP_AGENT_ID` to a declared id to appear. A solid edge means a record exists for
it and a dashed edge is the operating model with nothing measured yet. Use the
bundled `team-loop-setup` skill (`team-flow.mjs init|check <repo>`) to declare a
repo's own loop. The page is full-bleed: the graph is the page, and its SVG
carries no fixed pixel size so it scales to the viewport.

`loop-graph.html` is the simple configurable Team flow. A configured dispatcher
fans out to separate worker nodes, every worker collects into that Team's
integrator/evaluator, rejection returns to the same dispatcher, and a pass goes
to the configured downstream dispatcher or one non-agent Project Completion
endpoint. One `.agent-node` is one configured or currently observed ACP agent;
configured idle agents remain `not_started`, while unmatched or conflicting
evidence stays once in `Control / Unassigned` with `unknown` truth. Team names,
roles, membership, and downstream links come from `--team-graph FILE`, not from
the legacy phase names. Optional `--team-runtime FILE` evidence can add
validated queue wait, service duration, attempt, bottleneck, decision, and
handoff facts; invalid or stale controller evidence is shown as a diagnostic
and never decorates a node. Completed and superseded attempts remain in one
collapsed audit area. The old fixed phase/delivery diagrams elsewhere on the
dashboard are legacy/normative illustrations, not the live Team graph.
`TEAM_DONE` remains separate from a recorded verdict.
A recorded `pass` does not mean business approval or UAT acceptance, and a
`pass` that conflicts with terminal evidence is highlighted for attention.
Both pages poll only the same-origin `pulse-current.json` bundle marker while
open. They reload only after `snapshot_id` changes, update expiry visibly even
without a new snapshot, preserve page/flow scroll, focus, and disclosures, and
offer a keyboard-operable pause/resume control. Marker failures are shown as
unavailable; no external request is made.

Human-visible absolute timestamps default to `Asia/Bangkok`. The page shows
the timezone once in its top-right header (`เวลาไทย (UTC+7)` for the default)
instead of repeating it beside every timestamp. Configure another IANA zone
for one command or a watcher with `--time-zone`, or set `PULSE_TIME_ZONE`:

```bash
PULSE_TIME_ZONE=America/New_York \
  node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs ensure <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once \
  <repo> --time-zone UTC
```

The CLI flag takes precedence over the environment. An explicit invalid zone
fails with exit 2, and changing the zone of a running watcher requires stopping
that watcher first. Pulse Data v4 continues to publish machine timestamps as
RFC 3339 UTC; display timezone configuration never changes the JSON contract.

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

## Prerequisites

- `tmux`, and the `codex` CLI for the worker lane; Node 20+ with `npx` for
  the ACP adapters. CI exercises Node 20 and Node 24.
- party-mode's 3-model review uses its bundled JavaScript ACP gate
  (`skills/party-mode/scripts/review-gate.mjs`), not `oc`/AGY/Codex review
  plugins or MCP review tools. On Linux it fails closed without
  `/usr/bin/bwrap`. It also needs the supported ACP reviewer runtimes:
  `antigravity-acp@1.0.0` + trusted `agy`, native `kimi acp`, and the pinned
  Claude/Codex ACP adapters. Zai must use the explicit official
  `https://api.z.ai/api/anthropic` settings route. AGY plus exactly two valid,
  distinct reviewers are mandatory, and unsupported primary routes fail closed.
  While the direct Claude provider is limited, the policy never launches it:
  `claude-zai` resolves to the pinned Zai GLM-5.2 ACP profile and is accepted
  only when it does not duplicate a reviewer/model or match the primary family.

Run the gate from a trusted workflow with the target repository as a separate,
runner-owned absolute argument; never take it from the untrusted packet:

```bash
node plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs \
  <static-packet.json> "$PWD" > <review-report.json>
```

Each reviewer gets a fresh temporary workspace, an ephemeral provider HOME,
no MCP servers or built-in tools, denied ACP permission requests, and no mount
of the target repository or host user-data roots. The provider network remains
shared so its remote API can be reached; adapter auth is available inside its
ephemeral same-process HOME and the provider may retain remote state. Model
evidence means the pinned ACP model was configured and acknowledged, not
cryptographic proof of the remote serving model. AGY may report a completed
read only for copied provider-runtime documentation under its isolated
`builtin/` tree; target, arbitrary, search, fetch, edit, and execute calls
remain blocked.

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
