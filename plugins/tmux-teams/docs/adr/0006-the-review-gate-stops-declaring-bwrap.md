# ADR 0006: The review gate stops declaring bwrap, and says what that costs

## Status

**Superseded by its own amendment — 2026-08-24, on Master's instruction: "we
will not use sandbox."** The 2026-08-13 decision below stopped SHORT of removal:
it kept the machinery, kept it tested, and said turning it back on was one word.
That halfway state is now closed. The code is gone. See "The amendment".

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
  zero-tool contract.

**Correction, 2026-08-19.** The sentence that stood here said ADR 0001 "never
decided the sandbox" and "mentions bwrap once, in Consequences, as a platform
requirement". Both halves are wrong, and a codex-advisor lane reading the two
ADRs against each other found it: 0001 states in its Decision that on Linux each
lane runs under bubblewrap with the target and host user-data roots hidden, a
new PID namespace, a temporary workspace and an ephemeral home, and repeats the
requirement in its Consequences. This ADR therefore SUPERSEDES that part of 0001
rather than leaving it untouched, and 0001's Linux-sandbox statements are to be
read through this one. The decision itself does not change — only the account of
what it displaces, which was written from memory of the other document instead
of from the document.
- The macOS direct-ACP panel path, which is unchanged and already works.

## The amendment — 2026-08-24

**The sandbox is removed, not merely undeclared.**

### What the halfway state actually cost

The 2026-08-13 decision left the bwrap machinery in place "and still tested",
on the reasoning that a profile could turn it back on with one word. Measured
before removing it:

- **No shipped profile declared `osSandbox`.** Zero, across all seven. Every
  `profile.osSandbox === 'bwrap'` branch was dead on every path that runs.
- **Four tests skipped themselves on every run**, gated on
  `platform !== 'linux' || !existsSync('/usr/bin/bwrap')`. This repository's own
  rule is that a skipped test is an UNEXECUTED GUARD, not a passing one. Those
  four were the `4 skipped` that appeared at the end of every suite run for
  months.
- 257 lines of helper functions, plus an 87-line spawn branch and a 71-line
  provider-state branch, reachable by nothing.

"Retained and still tested" was true of the helpers and false of the thing they
served: the sandbox itself was never exercised by any run on any machine here.

### What was removed

`acp-review-client.mjs` 1598 → 1157 lines. Gone: the bwrap spawn branch, the
bubblewrap-required precondition, `prepareProviderState`'s sandbox half, and the
helper cluster — `SANDBOX_MASKED_ROOTS`, `sandboxRebindRoots`,
`needsSandboxStaging`, `sandboxStagedExecutables`, `swallowsStagingFailure`,
`stageHomeExecutable`, `prepareSandboxResolver`, `rebindHomeSource`,
`inspectAgySafeRead`, `canonicalSync`.

`review-gate.mjs`: the isolation assertions that were conditional on `osSandbox`
now assert the no-sandbox truth directly, and the sandbox-only
`targetRepositoryCanonical` clause is gone.

`tests/review-gate.test.mjs` 2254 → ~1580 lines, 27 test cases removed.

**The suite now reports `1165 / 1165 pass / 0 fail / 0 skipped`.** The skip
count reaching zero is the point: those four guards are no longer pretending.

### Three guards were deleted by mistake and restored

The filter used to find sandbox tests was "mentions bwrap", which is a proxy for
the property, not the property. It caught three tests that only mentioned bwrap
in a COMMENT or used a sandbox error string as a fixture:

- a remote protocol error says what the remote said, redacted and on one line
- a review carrying credential-shaped text is redacted and kept, not discarded
- lanes that stop at one stage for different reasons are not announced as one

All three are restored; the third's fixture and assertion use a different lane
failure, since the bubblewrap precondition it named no longer exists. **This is
the same mistake this repository keeps recording — filtering on a proxy instead
of the property — and it was caught by reading the deletion list, not by a test.**

### What this costs, stated as plainly as the original did

The original ADR gave up OS-level filesystem confinement and said so. This
amendment gives up the ability to get it back cheaply. Restoring a sandbox now
means writing it again, not setting a field.

Everything the gate still checks is unchanged and never came from bwrap: a
temporary workspace, `toolCallsObserved: 0`, no built-in tools, no MCP servers,
every permission denied, the endpoint pinned and verified in the PARENT before
the child starts, and the packet redacted both ways.

### The argument against, stated rather than omitted

A review lane runs an external model against a prepared packet with the target
repository visible on disk. Nothing at the OS level now stops a lane that
decides to read outside its packet; only the ACP permission layer does, and that
is the agent's own runtime rather than the kernel's. ADR 0001 assumed OS
confinement when it was written and no longer gets it.

If that trade stops being acceptable, the answer is a fresh sandbox designed for
the platforms this project actually runs on — not the bwrap code that was
removed, which never ran on any of them.
