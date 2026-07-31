# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch CLI agents (codex, claude,
agy) over **two transports — tmux and ACP** — on one mailbox contract
(evidence-not-attestation outbox + typed terminal markers), plan every
dispatch with `sqthink` + task creation, gate completion with `party-mode`
verification.

## The delivery loop

The mailbox contract above dispatches one agent and proves what it produced.
The delivery loop turns that into a system that keeps moving without a human
pressing continue.

Two layers that must never be conflated:

| Layer | File | Answers |
|---|---|---|
| **Declaration** | `.tmux-teams/graph.json` | who exists and how they are wired |
| **Evidence** | `.tmux-teams/work-items/<token>.jsonl`, `pulse.json`, `.tmux-teams/runner-heartbeat.json` | what actually happened, including whether the runner itself is responding |

- A **team** is a reusable pool: one dispatcher, N workers, one evaluator. Every
  role of every team declares its own model — work of different value deserves
  brains of different price — and a missing declaration is refused by name.
- A **workflow** is a route composed over teams. A route never revisits a team.
- A **work item** carries an **append-only** JSONL custody ledger. A mistaken
  line is corrected by appending, never by rewriting: what a receiving team
  inherits is the token's recorded history, and every later reader — intake, the
  board, the controller's audit — answers from it.
- Work is **pulled, not pushed**. A team takes work when it has room; the WIP
  limit is the worker count. A team at its limit leaves the token where it is
  and says so, because a queue backing up is the signal the board exists to
  show.
- **Three quality gates**: intake (the receiving dispatcher), review (the team's
  own evaluator — a worker finishing is not the team finishing), and an outer
  audit of every finished route. Verdicts are read from a `VERDICT:` line,
  **last match wins**, and silence is never approval.
- `plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md` is
  the SSOT. It carries a standing list of what the contract asserts but nothing
  enforces: a clause with no test is marked as such rather than left to be
  discovered.

Three pages are published side by side into `.tmux-teams/`, linked by one nav:

| Page | Answers |
|---|---|
| `pulse.html` | what is happening right now |
| `graph.html` | who exists and how they are wired |
| `kanban.html` | where each work item is stuck |

### The components, in operating order

| Component | Responsibility |
|---|---|
| `graph.mjs` + `workflow-graph.mjs` | create and validate `.tmux-teams/graph.json`: teams are reusable pools; workflows own routes |
| `ledger-writer.mjs` + `ledger-validate.mjs` | append and judge one custody history per token; invalid history stops movement |
| `pull-controller.mjs` | plan receiver-owned handoffs and enforce WIP; it pulls only reviewed work |
| `loop-runner.mjs` | run one ordered tick: harvest → pull → dispatch → escalate, and stamp the runner heartbeat |
| `acp-companion.mjs` | carry each dispatched leg over ACP; its custody-ledger authority is limited to that leg's `assigned` and `delivered` facts |
| `pulse.mjs` + `graph.mjs` + `kanban.mjs` | publish three projections from the same declaration and evidence |
| `kms.mjs` | keep immutable run-memory events; it is an event store, not a verification gate |

Run these commands from this repository's root. In an installed plugin, replace
`plugins/tmux-teams/skills/tmux-teams` with the installed skill root.

Create a declaration once, edit the generated team and model values, then
validate it. `graph.mjs init` expects the state directory to exist:

```bash
mkdir -p -- <repo>/.tmux-teams
node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs init <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs check <repo>
```

Admit a token through the general custody writer, then validate every ledger.
`opened` is the first event; a route-opening `pulled` would invent a sender.
This example uses the bundled declaration unchanged; after editing the graph,
substitute its workflow, dispatcher and team names:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs \
  --repo <repo> --actor human:operator --stdin <<'JSON'
{"event":"opened","work_item":"token-001","workflow":"default","agent_id":"requirement_dispatcher","to_team":"requirement","reason":"work admitted by operator"}
JSON
node plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs --repo <repo>
```

### When the graph routes work through a controller team

A graph whose `outer_controller_id` is the single worker of a team makes that
team the front door: every route starts there, and admission goes through it
rather than at a delivery team. Use `admit.mjs` instead of writing `opened` by
hand — it is the only writer that enforces the front door's WIP limit, which
`ledger-writer` cannot see because it judges one event against one ledger and
never reads the graph.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/admit.mjs \
  --repo <repo> --work-item token-001 --workflow default \
  --actor human:operator --reason 'what the person asked for'
```

Refused while the controller is holding its one token:

```text
REFUSED  controller_full: control is holding 1 of 1 — a new request is not
admitted while the front door is full. The person may send it again once the
queue moves.
```

That is a queue, not a rejection, and it is deliberate: one request waiting on a
person stops every new request entering. See
[controller-as-team.md](plugins/tmux-teams/skills/tmux-teams/references/controller-as-team.md) for why.

What the door has learned, read by the controller on every withdrawal:

```bash
node -e "import('plugins/tmux-teams/skills/tmux-teams/scripts/intake-stats.mjs').then(m => console.log(m.intakeStats('<repo>')))"
```

The pull controller's direct command is an operator dry run. Let the runner
apply pulls so the contract's tick order stays intact:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs <repo> --dry-run
node plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs <repo> --watch=20
```

The runner supplies the graph identity, workflow, token and model environment
to `acp-companion.mjs`; the standalone transport form is documented under
Transports below. Publish one snapshot or keep the observer alive, then inspect
the custody board:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once <repo>
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs ensure <repo> --interval 20
node plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs check <repo>
```

KMS is separate from custody. Append one event file, or recall prior events as
unverified leads:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/kms.mjs append <repo> <event-file|->
node plugins/tmux-teams/skills/tmux-teams/scripts/kms.mjs recall <repo> [terms...] [--worker W] [--limit N]
```

## Skills

| Skill | Purpose |
|---|---|
| `tmux-teams:tmux-teams` | PM protocol over tmux + ACP: dispatch, completion detection, capture, mailbox pattern, run memory (§9) |
| `tmux-teams:codex-tmux-driver` | Codex TUI calibration (flags, markers, dialogs) for the codex worker lane |
| `tmux-teams:party-mode` | Multi-agent execution/advisory workflow with an ACP-only exact-three 3-model review gate + grill gate |
| `tmux-teams:party-auto` | Execution lane of party-mode |
| `tmux-teams:party-advise` | Read-only advisory lane of party-mode |
| `tmux-teams:sqthink` | Sequential-thinking analysis/planning |
| `tmux-teams:graph-setup` | First-run interview: how many teams, and which model sits in each role of each one. Asks until the declaration is complete rather than starting a loop on blanks |
| `tmux-teams:claude-advisor` | Read-only consultation over ACP, pinned to `claude-fable-5` at `max` and verified with `ACP_EXPECT_MODEL` — the answer comes back as a party, never one voice |
| `tmux-teams:codex-advisor` | The same from outside the Claude family: `gpt-5.6-sol` at `ultra`. Ask both on a hard call and read the two round-tables side by side — where they disagree is the finding |

Commands: `/tmux-teams:mailbox-run` — run the mailbox PM workflow end to end.

## Retained measurement semantics — no direct Stage 0 command

The former offline analyzer is not a user-facing entry point in this checkout.
Its pure validation and analysis core remains because the surviving Stage 1
exporter replays an existing observation store through those rules. It is
separate from the custody loop above and never dispatches or routes work.

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
`scenario_signal` remains descriptive; its ROI interpretation is
`ROI_NOT_ESTABLISHED`. `business_decision` is always `EXTERNAL_REQUIRED`, so
the analysis cannot claim causal effect or ROI, or return
`GO`/`ITERATE`/`NO_GO`. `READY` means measurement completeness, not accepted
delivery, delivery success, or business approval.
It changes none of the existing tmux/ACP dispatch, mailbox, PM verification,
Party gates, KMS, Pulse, role-loading, cleanup, or transport semantics. The
schemas and the Stage 1 runbook below retain the rules that the exporter still
enforces.

## v0.7 Stage 1 — export-only evidence compatibility

The Stage 1 entry point that remains reads an already-populated, append-only
observation store and exports an integrity-bound review pack. This checkout
does not create the store, freeze a pilot, assign slices, capture sources, or
append observations. The exporter never routes or dispatches work. Its output
is not a causal claim, certified result, release approval, ROI claim, or
business verdict. Same-UID observations remain `advisory_same_uid`; exported
packs remain `NOT_CERTIFIED`, require `EXTERNAL_REQUIRED`, and declare no
actuation.

The store must already contain a valid frozen manifest and its event files.
Export replays that named evidence, materializes the ITT dataset and analysis,
and writes a new pack directory. Verification checks the pack's paths, bytes,
digests and deterministic replay; it does not authenticate custody or identity.

From the repository root, the exact CLI is:

```bash
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

## Governed four-phase runtime compatibility

The Phase Gate runtime is opt-in and separate from both the custody loop and
the observe-only Stage 1 exporter. `phase-gate-controller.mjs` and its
supporting modules are the executable surface in this checkout. An older Phase
Gate Runtime v1 design note remains under `references/`, but its POC and
`scenario_signal` passages describe the earlier demonstration, not a command
or field produced by the current Phase Gate modules; it is not an operational
guide for this checkout.
When `<repo>/.tmux-teams/phase-gate.json` exists, `acp-companion.mjs` requires
the controller's exact reservation environment before it reads the brief or
starts a child.

The runtime has Requirement → Prototype → Development → QA Phase Teams.
`QA -> ProjectDelivery` ends at a receiver: ProjectDelivery is not Phase 5 and
does not imply release, UAT, certification, ROI, or business approval. This
checkout ships no full-loop demonstration command, so the reference and
controller modules must not be presented as a one-command POC.

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
  codex <repo> <task-id> <brief-file> [stall-sec]
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

See `plugins/tmux-teams/skills/tmux-teams/SKILL.md` §6-§8 for the contract,
tmux lane, and ACP lane.

## Pulse v4 and the three projections

Pulse probes transport liveness and writes
`<repo>/.tmux-teams/pulse.json`, the machine-readable Pulse SSOT. One publish
also writes `pulse.html`, `graph.html`, `kanban.html`, their local assets, and
`pulse-current.json` last. The graph additionally reads the validated workflow
declaration and custody ledgers; the kanban reads those same ledgers through the
same placement rule as the pull controller.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json <repo>
```

`json` publishes and prints the exact persisted Pulse v4 document. Its contract is
`plugins/tmux-teams/skills/tmux-teams/references/pulse-v4.schema.json`; its
run/verdict definitions retain Pulse v3 compatibility through
`pulse-v3.schema.json`. It
includes snapshot identity/freshness, source diagnostics, run state,
`dispatch_id` correlation, and explicit phase attribution. Pulse is read-only and reports
`trust_level: advisory_same_uid`; suggested action codes are advisory and are
never executed automatically. See
`plugins/tmux-teams/skills/tmux-teams/SKILL.md` §10.

The canonical offline bundle contains `<repo>/.tmux-teams/pulse.json`,
`pulse.html`, `graph.html`, `kanban.html`, and their sibling
`pulse-fonts-<sha256>.css` and `pulse-refresh-<sha256>.js`. The stylesheet
contains the bundled Kanit WOFF2 data URLs. `graph.html` draws its board from a
JSON block in the page with a small inline script — pan, wheel-zoom and one
scene per workflow; the other pages are plain document flow. No charting library
is vendored or loaded. The shared assets
are atomically published before the JSON and HTML pages and are not rewritten
when their content is unchanged. No view loads a remote asset; while served,
the refresh script polls only same-origin siblings. Keep every named sibling
together for offline bundle identity.
`<repo>/.tmux-teams/pulse-current.json` is the bundle commit marker written
last. It names and hashes the JSON, every HTML page, the font stylesheet and
the refresh script;
readers can reject a mixed/partial publish
by validating those hashes and re-reading the marker after the files.

`graph.html` answers who exists and how the loop is wired. Every declared agent
appears exactly once inside its team — including the outer controller, which
holds the single worker seat on its own control team and so is drawn once rather
than as a band of its own. The board opens whole, then walks one workflow at a
time: teams a route does not use fade out and keep their place, so a team a
route SKIPS never reads as a team that is not there. It needs JavaScript; the
same declaration is in `graph.json` and the same evidence in `pulse.json`.
The governing contract requires each node to state the same five facts: agent
id; role, lane and transport; verified model or `unverified`; ledger-recorded
work; and a measured clock or `not started`. The declared model is the model
requested, not evidence of the model that answered.

The current `graph.mjs` renderer has a known conformance gap: without a verified
model it may print `<requested model> unconfirmed`, `default — none pinned`, or
`not recorded` instead of the contract's `unverified`. Those labels are not
verified-model evidence and must not be reported as such.

Topology comes from `<repo>/.tmux-teams/graph.json` validated by the Team
contract, or from the bundled four-team template when that file is absent; an
**invalid** file fails the page closed with the reason rather than falling back.
Nodes bind to evidence by `agent_id` only, so a dispatch must set
`ACP_AGENT_ID` to a declared id to appear. A solid edge means a record exists;
a dashed edge is declared but unobserved. The loop-health strip reads
`runner-heartbeat.json` before presenting the diagram, so an idle loop and a
dead runner do not look the same. Use the bundled `graph-setup` skill, or the
exact `graph.mjs init|check <repo>` commands above, to declare a repo's loop.

`kanban.html` answers where the work is now — one card per token, in the
column of the team holding it, saying what it is waiting on. A token the pull
controller refuses to move (its ledger cannot be believed, its last leg failed,
its next team is at its WIP limit) is drawn as blocked with the reason, because
a board that draws a stuck token as an ordinary card is a board disagreeing with
the loop it reports on.

`TEAM_DONE` remains separate from a recorded verdict.
A recorded `pass` does not mean business approval or UAT acceptance, and a
`pass` that conflicts with terminal evidence is highlighted for attention.
All three pages poll only the same-origin `pulse-current.json` bundle marker while
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
  (`plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs`), not
  `oc`/AGY/Codex review
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
3. For the repository-only development tier, run `node scripts/run-fast.mjs fast`.
   The release gate remains bare `node --test`; then run `git diff --check` and
   the local-only `claude plugin validate --strict .` release gate.
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
