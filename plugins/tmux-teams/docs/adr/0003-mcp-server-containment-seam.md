# ADR 0003: The `mcpServers` seam stays closed — a dispatched agent receives no MCP server

## Status

Accepted

## Context

`acp-companion.mjs` sends the literal `mcpServers: []` at both ACP calls that
start or resume an agent's session — `session/new` and `session/load`. There is
no option, environment variable, `graph.json` field, or profile key that can
make it anything else: every agent **dispatched through this companion**
receives zero MCP servers, unconditionally.

Two precisions this paragraph lacked until 2026-08-05. First, it cited line
numbers (`:3462`, `:3478`) that ordinary edits have since moved; a line number
is not a durable citation in a file under change, so this ADR names the two
calls and leaves finding them to `grep -n mcpServers`. Second, the guarantee is
about the **automated loop**, not about every agent a human might start: a
person running an interactive session in the same repository is outside this
seam entirely, and nothing here constrains what that session loads. The scope
that matters for §13 is the dispatched leg, and for that the claim holds.

This was never decided in the open. It happened to be true because nothing
ever asked the companion to send anything else, and §13's list of
prohibitions never named it — so the code enforced a rule this document did
not state, which is the same kind of disagreement §15.3 exists to catch, just
in the direction of an undocumented protection instead of an undocumented
gap. §15.2 exists precisely so an unenforced clause SAYS so instead of
leaving a reader to infer a guard from the absence of a test, and this seam
had neither the clause nor the marker.

The project is about to be asked to widen it: an MCP server gives a
dispatched agent tool access beyond anything its brief negotiates through the
loop's own seams — ledger writes, pulls, escalations, review — all of which
are mediated, attributed to an actor, and reviewable through §3–§9 of the
contract. Before that conversation happens, "closed" needs to be a decision
on the record, not a default nobody chose.

## Decision

**The seam stays closed.** `loop-system-contract.md` §13 gains a prohibition:
no dispatch may pass a non-empty `mcpServers`. It is marked unenforced per
§15.2 — nothing tests the literal today — so the clause states what it
actually is (a stated rule, backed by two call sites read in review) rather
than implying a running protection that does not exist.

Opening the seam is a **containment reduction**, not an added capability. An
MCP server is a channel the loop's dispatch/ledger/pull/review machinery
never mediates: what it can read, write, or call is decided entirely by the
server's own implementation, outside anything this contract governs. Every
other way an agent gets more reach — a seat's model, its `effort`, its role's
declared tools — is expressed in `graph.json` and answers to the seams this
document already defines (§3 declaration contract, §4 ledger, §6 occupancy).
`mcpServers: []` is what keeps that true today; a non-empty value would be
the one capability increase this system cannot see, attribute, or gate
through anything §4–§9 already do.

Because this is a reduction of containment rather than an addition of
capability, it does not get the ordinary bar for a feature request. Opening
it requires amending §13's prohibition directly, and that amendment is
authorised only by **a human maintainer of this repository** — not a
`graph.json` field, and not an environment variable. Neither of those is a
place this kind of decision can be reviewed before it takes effect; both are
things a running graph or a shell environment can set without anyone reading
the change.

### Future option, not built

A per-seat allowlist — a seat declares which named MCP servers, if any, it
may receive, and the companion honours only that declared set for that seat
— could open the seam narrowly once there is a concrete server and a
concrete need for it to point at. It is recorded here as the shape a future
amendment would plausibly take, not as a design commitment. Nothing toward it
is built by this decision: no schema field, no companion branch, no
allowlist file.

## Consequences

- `loop-system-contract.md` §13 carries the prohibition. A dispatch that ever
  sends a non-empty `mcpServers` is a contract violation by definition,
  whether or not a test catches it on the day it happens.
- §14.1 records the specific gap this ADR does not close: nothing asserts the
  two call sites in `acp-companion.mjs` still send `mcpServers: []`. A
  regression here has no test to fail today — only a diff review, per §15's
  existing amendment-log discipline.
- No code changed as part of this decision. `acp-companion.mjs`'s two
  literals are exactly what they were before this ADR; what changed is that
  the contract now says why they must stay that way and names who may change
  that.
- The next request to widen a dispatched agent's tool access via MCP starts
  from this ADR, not from a blank slate: it must name a human maintainer's
  sign-off and a §13 amendment, not a config flag, an env var, or a
  `graph.json` field.

## Alternatives considered

- **Leave it implicit.** Rejected — an unreviewed default that happens to be
  safe is not the same thing as a decision, and this is the exact accident
  this item exists to fix before the seam is asked to open.
- **Make `mcpServers` configurable now** (an env var, a `graph.json` field, a
  profile key) so a future request has less to build. Rejected — that IS the
  containment reduction, done pre-emptively and system-wide, which is the
  opposite of documenting the seam as closed. Any such change belongs to the
  amendment this ADR requires, reviewed on its own bytes, not smuggled in as
  preparatory plumbing.
- **Build the per-seat allowlist now.** Rejected for the present — there is
  no server and no concrete need yet for an allowlist to point at; building
  the mechanism ahead of a use case is exactly the kind of unreviewed
  capability increase this ADR exists to prevent. Noted above as the likely
  future shape instead of built.
