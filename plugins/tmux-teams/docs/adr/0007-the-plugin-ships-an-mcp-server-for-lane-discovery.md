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
- `acp_lane_status` — whether a lane can run **here**, and when it cannot, what
  is missing and which environment variable points at it.

## The three lines it does not cross

**ADR 0003 stands.** A dispatched agent still receives no MCP server, enforced at
runtime and asserted by the suite. That guarantee is about what a lane is handed;
this server is about what an operator can ask. Adding a discovery surface for the
operator does not weaken the containment seam, and if it ever looks like it does,
the seam wins.

**No credential is ever returned — and none is ever read.** Readiness is decided
by handing the work to `buildAcpLaunch` and reporting whether it complained. That
function builds an environment that contains the token; this server discards it
untouched. The guard is a test that serialises a whole reply for a lane made
ready by a fixture holding a secret and asserts the secret is not in the bytes,
because the failure to fear is a future field added in good faith.

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

It is not, for one reason. The failure being fixed is that a fact existed in code
and nobody could reach it. A flag has to be known about before it is typed and a
README has to be found before it is read — the same failure mode, one layer up. A
tool advertised through the protocol the agent is already speaking is the only
form of this answer that arrives without the operator knowing to ask for it.

## What would reverse this

If the server ever needs to do more than answer — a tool that starts something,
a field that carries a secret, or a reason to hand it to a dispatched agent —
that is not an extension of this decision. Write the next ADR.
