# ADR 0005: MCP Tasks converged on the companion's design, and we stay divergent

## Status

Accepted — 2026-08-13. Revisit when the trigger in "What would change this
answer" fires, not on a schedule.

## Why this document exists

MCP revision `2026-07-28` moved asynchronous task execution out of the core
protocol and into an official extension, `io.modelcontextprotocol/tasks`. That
extension describes: a durable handle returned instead of a blocking result,
polling for status, a lifecycle of `working` / `input_required` / `completed` /
`failed` / `cancelled`, mid-flight input, and cooperative cancellation.

`plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs` implements
almost exactly that, by hand, over ACP instead of MCP, and it was built without
reference to the extension. Two designs arrived at the same shape from opposite
directions.

Nobody had compared them. This ADR is the comparison and the decision, so that
the next person who notices the resemblance does not have to rediscover why we
did not adopt it — and so that if they think we should, they argue against a
recorded position instead of a vacuum.

**This is not ADR 0003.** That ADR governs MCP servers a dispatched agent may
RECEIVE, and its answer is none: the seam stays closed, enforced at runtime by
AC135. This one runs the other way — whether our own task machinery should
speak the MCP Tasks vocabulary or shape. The two decisions are independent and
neither implies the other.

## Context — where the two designs actually meet

Measured against the extension overview and `modelcontextprotocol/ext-tasks`,
and against this repo as it stands at ADR time.

| MCP Tasks | tmux-teams | Where |
|---|---|---|
| terminal `completed` / `failed` / `cancelled` | same three words, literally | `VALID_TERMINAL_STATES`, companion `:321` |
| `working` | split three ways: `awaiting_agent`, `active`, `tool_running` | companion `:1296`, `:3258`+ |
| `tasks/get` polling | a file read — `.tmux-teams/liveness/<task_id>.json` | companion `:1510-1558`, `:243` |
| durable handle survives client death | `ACP_RESUME` plus the dispatch record | companion `:1701-1731` |
| cooperative `tasks/cancel` | `session/cancel` first, then a ladder — see below | companion `:3318-3358` |
| `taskId` | **two ids**: `task_id` stable across attempts, `dispatch_id` new per attempt | companion `:38-50`, `:239` |
| `input_required` + `tasks/update` | **nothing** — the companion answers `session/request_permission` itself | companion `:3196-3212` |
| `ttlMs` expiry | **nothing** — the ledger is permanent by design | absence |
| `pollIntervalMs` | **nothing advertised** — readers set their own interval | `pulse.mjs` `--interval` |
| `notifications/tasks` push | **nothing** — poll-by-file only | absence |

And the reverse direction, which matters more, because these are the things
that would have nowhere to live inside the extension:

- **A two-key dispatch claim** — `agent_id` AND `work_item`
  (`loop-runner.mjs:2551`, ADR 0004). MCP models one request against one
  server; it has no vocabulary for a bounded pool of interchangeable seats, so
  "this seat is spoken for" cannot be said independently of "this task exists".
- **A receipt/commit pair whose durability a THIRD PARTY can verify**
  (`readTrustedReceiptPair`, companion `:744-774`: fsync both files, fsync both
  parent directories, re-stat device and inode to catch a race). MCP requires a
  server to durably create a task before answering — but that is a promise the
  client takes on faith. Nothing in the extension lets anyone check it after.
- **`outbox_digest` pinned on the custody line** (companion `:2284-2297`), so a
  downstream reader can prove it read the same bytes that were classified.
- **Evidence, never elapsed time** (ADR 0004). `ttlMs` is precisely the
  elapsed-time mechanism this system rejected on purpose.
- **`escalated`** — `loop-system-contract.md:2912` says it plainly: "`escalated`
  is deliberately not in it: an escalation IS the PM's work." Forcing that into
  MCP means abusing `input_required`, which means "the model needs input to
  continue", not "accountability for this token is moving to a human".

## Decision

**Stay as we are.** Do not rename our states to the MCP words, and do not make
the companion speak the extension.

Reasons, heaviest first:

1. **The two transports just diverged in the dimension that would matter most.**
   SEP-2575 removed MCP's stateful `initialize` / `notifications/initialized`
   handshake so that polling and resumption work without session affinity. ACP
   — what the companion speaks — is session-based to its core (`initialize`,
   then `session/new` or `session/load`, companion `:3734-3796`). Bridging a
   protocol that just went stateless to one that is fundamentally stateful is an
   architecture problem, not an adapter.
2. **The extension declares itself experimental** and says it may be
   discontinued. Binding this repo's dispatch model to it buys a cost now
   against a foundation that may move again.
3. **Renaming is not free, and this repo already knows that.** `livenessState`
   values are written to disk, read by `pulse.mjs` and `loop-runner.mjs`, and
   named by AC rows in `loop-system-contract.md`. A rename here is a contract
   amendment, which this project deliberately made expensive.
4. **The overlap is the easy part and the divergence is the load-bearing part.**
   Where the two agree, they agree almost for free. Where they differ, they
   differ because the problems differ — one request between one client and one
   server, versus WIP-bounded multi-team token routing with an audit trail.

## The cancellation question, answered rather than assumed

This is the one place the two designs look like they contradict each other, so
it gets its own section.

MCP is explicit: cancellation is cooperative, a server "is not obligated to
actually stop the work", and "eventual transition to `cancelled` is not
guaranteed". The companion escalates: `session/cancel`, then a bounded grace,
then `SIGTERM` to the process group, then `SIGKILL` (`:3318-3358`, `:3283-3316`).

**They do not conflict, and the reason is a layer distinction.** MCP's
cooperative promise describes the logical task AS SEEN THROUGH THE PROTOCOL. It
says nothing about what a client may do beneath the protocol when it happens to
hold a stronger handle. MCP has to make the weak promise because the typical
task server — a hosted pipeline, a job queue — genuinely cannot guarantee more.
The companion is the PARENT PROCESS of the worker it spawned. It holds a
guarantee the MCP abstraction does not model.

**Where it would become a conflict:** if anyone adopts MCP's cooperative
cancellation as the WHOLE contract — treats a sent or acknowledged
`session/cancel` as sufficient and drops the signal ladder because "the spec
says cooperative is enough". ADR 0004's seat-reuse guarantee assumes a cancelled
seat becomes free within a bounded window. MCP explicitly disclaims that bound.

So: today we are stronger than the spec requires, not weaker. **The risk is
entirely in adoption discipline, not in the code.** Anyone importing MCP's
vocabulary must not import its weaker guarantee along with the words.

## What would change this answer

Named so the revisit is triggered by an event and not by taste:

- `io.modelcontextprotocol/tasks` leaves experimental status AND a tool we
  actually want to interoperate with speaks it.
- ACP gains a stateless request mode, removing reason 1.
- A concrete need appears for mid-flight human input during a dispatch — the one
  capability MCP Tasks has that we genuinely lack.

**The strongest argument against this decision**, recorded because a decision
whose counter-argument is missing is not a decision: if the extension does
become the de facto standard for agent-orchestration async work, divergence
compounds. Every generic task browser or cross-tool dashboard that speaks MCP
Tasks reads tmux-teams as illegible without a translation layer, and the parts
that overlap almost for free — the three terminal states, the poll-a-handle
shape — would have been cheapest to align BEFORE the tests, the contract prose
and the surrounding tools calcified around today's names. That cost is real and
it grows. "Stay as we are" is right for today; it is not a claim about forever.

## Out of scope

- Whether a dispatched agent may receive an MCP server. That is ADR 0003 and it
  is unchanged: none, enforced by AC135.
- Publishing any part of this system AS an MCP server. If that is ever wanted,
  `agent-seat-reads.mjs` names itself the thing such an adapter would wrap — and
  it would be built against the 2026-07-28 shape (stateless, `server/discover`,
  `resultType`), not against anything remembered from an earlier revision.
- Any change to `livenessState` values, the receipt schema, or the contract.

## What could not be verified

- **The ACP specification itself was not read.** Every statement here about
  ACP's `session/cancel` semantics is inferred from how
  `plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs` DEFENDS
  against it — an ack timer that proceeds regardless — not from a documented ACP
  obligation. If ACP promises something stronger than MCP does, this ADR has no
  evidence either way, and the cancellation section would need re-reading.
- The MCP TypeScript schema was read through a summarising fetch rather than as
  bytes. Concept-level claims above are sound; treat field-level details as
  second-hand.
