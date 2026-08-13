# ADR 0006: The review gate stops declaring bwrap, and says what that costs

## Status

Accepted — 2026-08-13, on Master's decision, after the room recommended it.

## Why this document exists

Removing an OS-level isolation boundary is not a configuration tweak, and a
future reader who finds `osSandbox` absent from every shipped profile is owed the
reasoning rather than a blame line. This is that reasoning, including the part
that argues against the decision.

## Context — measured, not recalled

The sandboxed gate was reached for the first time on 2026-08-13, on the Ubuntu
26.04 host, after eight layers of fixes on 2026-08-09 and two more that day. What
the run produced:

- **AGY `accepted`** — the first review ever accepted through the sandboxed gate.
- **zai failed**, and the cause, once the transport stopped deleting the remote
  error, was the wrapper speaking for itself from inside the sandbox:
  `claude-zai: ไม่พบไฟล์โปรไฟล์ /home/server/.claude/profiles/zai.json`.
  `--tmpfs /home` had erased the profile the wrapper reads.
- **qwen ran for the full 900 s and timed out** — which is the one unambiguous
  proof that a claude-routed lane RUNS under bwrap. It did not fail to start.

Ten layers of debugging across two sessions. Every one of them was the sandbox
fighting the host's own toolchain — a version manager under `$HOME`, an `npx`
that is a node script, a bind order, an envelope-counted ceiling, a wrapper
looking for its own config. **Not one was a security event.**

Meanwhile the same three families, run through direct ACP with no sandbox on
macOS the same day, returned a complete 3/3 panel — the first this project has
ever assembled — and `toolCallsObserved` was 0 on every lane.

## Decision

**Shipped review profiles no longer declare `osSandbox: 'bwrap'`.**

The bwrap machinery is NOT deleted. Every consumer of `osSandbox` was already
conditional on it, in both the runner and the gate's own evidence check, so the
field going absent is the design working as intended rather than a hole punched
through it. A profile that declares `osSandbox: 'bwrap'` still gets the full
sandbox, and the tests that exercise that path still declare it. Turning this
back on is one word in one profile.

### What survives, and it is most of it

None of the following came from bwrap; all of it is enforced by the runner and
verified by the gate on every lane, sandbox or not:

- the lane runs in a temporary workspace, never the target repository
  (`workspace: 'temporary'`, `targetRepositoryCwd: false`)
- **a run that observed a tool call is refused outright** (`toolCallsObserved: 0`)
- built-in tools disabled, `tools: []`, `mcpServers: []`
- every `session/request_permission` denied
- the provider endpoint is pinned and verified IN THE PARENT before the child
  starts — this never depended on the sandbox
- the packet is redacted inbound and the review redacted outbound
- the review must be one strict JSON document matching a closed schema

### What is lost, stated plainly

**Filesystem confinement at the OS level.** If every protocol-level control above
failed at once, a reviewer process could read the disk. bwrap was the backstop
for that compound failure and there is now no backstop.

That is a real reduction. It is accepted because the sandbox has never once
caught such a failure, because a reviewer reads a STATIC PACKET and has never
needed repository access to do its job, and because the boundary's real cost was
paid every day: it is Linux-only, so the gate could not run at all on the
platform this project is developed on.

## What would reverse this

- A measured incident where protocol isolation failed and filesystem access
  mattered.
- A confinement mechanism that works on macOS as well as Linux, so the boundary
  stops costing the platform. `shepherd` is the candidate already on file (see
  HANDOFF) — Seatbelt on macOS, Landlock on Linux — and it is the shape that
  would let this decision be revisited without re-accepting Linux-only.

## The strongest argument against this decision

Defence in depth is worth most exactly when you cannot foresee the failure, and
"it never caught anything" is what every removed control can say right up until
the day it would have. The protocol controls listed above are enforced by the
same process that would be compromised; bwrap was the only control that did not
depend on our own code being correct. Ten layers of friction is a poor reason to
give that up, and the friction was nearly over — the last failure had a named
cause and a one-line fix.

That argument is on the record because it is a good one. The decision goes the
other way on evidence and on cost, not because the argument is weak.

## Out of scope

- Deleting the bwrap implementation. It stays, tested, opt-in.
- Any change to the three-family requirement, the endpoint pins, or the
  zero-tool contract. ADR 0001 is untouched — it never decided the sandbox; it
  mentions bwrap once, in Consequences, as a platform requirement.
- The macOS direct-ACP panel path, which is unchanged and already works.
