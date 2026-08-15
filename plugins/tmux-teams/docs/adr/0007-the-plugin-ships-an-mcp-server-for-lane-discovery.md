# ADR 0007: The plugin ships an MCP server, and it only answers questions

## Status

Accepted — 2026-08-16, on Master's instruction, after the room measured that the
per-machine problem it addresses was already solved in code and unsolved in
practice.

## Why this document exists

Two earlier decisions in this repository say "no MCP", and a reader who finds an
MCP server shipped alongside them deserves to know which line moved and which
did not. ADR 0003 says a dispatched agent receives no MCP server. ADR 0005 says
the companion keeps its own task protocol rather than adopting the MCP tasks
extension. **Neither is reopened here.** This is a third surface: the operator
driving the plugin, who until now had no way to ask what it can do.

## What was measured

The problem Master reported was that the ACP profiles assume one machine's
profile layout. Measuring first showed the premise was already half wrong: two
per-lane overrides — `TMUX_TEAMS_REVIEW_<ID>_SETTINGS` and
`TMUX_TEAMS_REVIEW_<ID>_ENV_FILE` — have existed since 2026-08-13, written for
exactly the host that prompted the complaint. `buildAcpLaunch` was driven against
a third-layout fixture with `HOME` pointing at a path that does not exist: it
read the base URL and the credential, and without the overrides on such a host it
refused loudly rather than routing somewhere unproven. The real entry point,
`review-gate.mjs`, calls `buildProfileEnv` with no source argument, so
`process.env` carries those variables in from the operator's shell.

So the mechanism worked and **nothing told anybody it existed.** The answer to
"why does my lane refuse" was "read the comment at `review-profiles.mjs:627`",
which is a document, not an answer. A document has to be found before it can be
read; a tool answers when asked.

## The decision

Ship one stdio MCP server, `tmux-teams-acp-lanes`, declared in the plugin's
`.mcp.json`, with two read-only tools:

- `acp_lanes` — what lanes this plugin declares: family, provider, model,
  adapter package, and whether the lane is pinned to a verified endpoint.
  Declared facts only, so it answers on a machine with nothing configured.
- `acp_lane_status` — whether a lane's CONFIGURATION is valid **here**, and when
  it is not, which closed diagnostic applies and which environment variable
  points at the missing piece.

It reports `valid`, `invalid` or `unchecked`, and never a boolean. The first
version returned `ready: true`, and the advisor reproduced what that costs in one
command: with no HOME, no PATH and no credentials, the `claude` and `codex` lanes
both reported ready, because no parent-side check exists for either and a green
answer from a check that never ran means nothing. Those two answer `unchecked`
now. Every answer also carries what it did **not** prove — no endpoint contacted,
no credential accepted, no adapter resolved, no session negotiated — because a
diagnostic that says READY and is then contradicted by the real gate destroys
trust in the one feature meant to explain a refusal.

## The three lines it does not cross

**ADR 0003 stands.** A dispatched agent still receives no MCP server, enforced at
runtime and asserted by the suite. That guarantee is about what a lane is handed;
this server is about what an operator can ask. Adding a discovery surface for the
operator does not weaken the containment seam, and if it ever looks like it does,
the seam wins.

**It reads credentials. It never returns them.** This paragraph said "none is
ever read" until a Codex advisor round-table refused the wording on 2026-08-16
and was right: deciding validity means calling `buildAcpLaunch`, which reads the
settings JSON, reads the credential file and copies provider secrets out of the
environment, and discarding a value you asked for is not declining to read it.
Master chose the honest version of the requirement over the flattering one — it
reads them, and nothing it returns carries them.

The containment is therefore entirely on the OUTBOUND boundary, and it is
enforced rather than asserted. A failure is reported as a code from a closed set
with a sentence that is a constant of the module; the raw exception text never
reaches the wire, because the first version exported `String(error.message)`
verbatim and any future diagnostic downstream that interpolated a token would
have shipped it silently. The guard serialises whole replies built from
secret-bearing fixtures on the success path AND on each failure path, including
a credential supplied through the ambient environment rather than a file.

**Read-only, with no exceptions.** No tool dispatches, spawns a lane, or starts a
review. This is the same principle that keeps a reviewer lane from launching
delivery work: a surface that can answer questions is a different thing from a
surface that can act, and combining them is how the first one stops being safe to
expose.

## The argument against

A shipped MCP server is a new attack surface and a new thing to keep working, in
a repository that has twice decided against MCP. The counter-argument is real:
this could have been a skill, a `--status` flag, or a paragraph in the README,
none of which adds a protocol.

The reason to prefer it is that the failure being fixed is a fact existing in
code that nobody could reach: a flag has to be known about before it is typed and
a README has to be found before it is read, which is the same failure one layer
up. A tool advertised through the protocol the agent already speaks arrives
without the operator knowing to ask.

**That is a preference, not a proof, and this section claimed to be the latter.**
It said an MCP tool was "the only form of this answer" that arrives unprompted;
the advisor named that a false dichotomy and it is one — a model-invoked skill is
also discovered from its description and can drive a short-lived CLI, which would
avoid a long-lived process that loads credentials. Nothing in this change
measured discovery rate, startup cost or operator confusion for either shape, so
the honest record is: **Master chose MCP; it is more reliably advertised in the
operator's session, at the cost of an auto-started process holding this
capability.** The comparison that would settle it has not been run.

## What would reverse this

If the server ever needs to do more than answer — a tool that starts something,
a field that carries a secret, or a reason to hand it to a dispatched agent —
that is not an extension of this decision. Write the next ADR.
