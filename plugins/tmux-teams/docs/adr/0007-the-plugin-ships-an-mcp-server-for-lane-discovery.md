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

**And "never returns them" survived one more round than it deserved.** A third
advisor round reproduced a credential on the wire with the credential FIELDS
all clean: the fix sentence for a missing `agy` binary interpolated the RESOLVED
candidate path, so a secret value that also appeared in `HOME` was serialised
through the path diagnostic. Aliasing is how a guard shaped like a denylist gets
beaten, and the route the bytes took does not change what the bytes are. The
sentence now carries `$HOME/.local/bin/agy` unresolved — a constant, which is
also the clearer thing to print at an operator — and the suite pins a
credential hidden inside `HOME` as its own case.

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

Two limits on that sentence, both named by a review rather than by us. Tools and
handlers are built from one descriptor list, which makes the surface auditable in
one place — it does **not** make a hidden branch impossible, and this document
said "unrepresentable" until an advisor pointed out that a differently named
handler added later would still pass. And the read-only property is established
by source inspection plus the mock-observed `mcpServers: []` request; the tool
inventory inside a real dispatched ACP child has not been measured, so ADR 0003's
guarantee remains a guarantee about what is REQUESTED. That distinction is the
same one the boot bug in this very change taught: the bytes sent and the runtime
that results are not synonyms.

## What the third round changed, and why it is in this document

Three advisor rounds blocked this change; a static three-family panel passed the
same bytes 3/3 with zero findings, twice, in between. That gap is the finding
worth recording. The panel is forbidden to run anything, by design — what it
proves is that three distinct families READ the bytes. An advisor lane can drive
the server, mutate the source and re-run the suite, and every round-three
finding arrived with a command and an output attached.

Two of them changed what this server IS, rather than how it words an answer:

**It validates its protocol now.** It previously accepted `"jsonrpc":"1.0"` and
answered with a tool list, accepted array `arguments` against an object-only
schema, reported an unknown tool as a SUCCESSFUL result carrying `isError`, and
dropped both an empty batch and an `id: null` request in silence. A permissive
host continuing anyway is not a conformance check — it is why nobody noticed. A
client holding a stale tool cache cannot distinguish protocol misuse from tool
failure when the first is reported as the second, so an unknown tool is
`-32602`, a malformed envelope is `-32600` under `id: null`, and a notification
is a request with no `id` MEMBER rather than one whose id happens to be null.

**A diagnostic that cannot be acted on is worse than an unclassified one, and
the credential fix was one.** `TMUX_TEAMS_REVIEW_ZAI_ENV_FILE` was the
prescribed repair for a missing zai credential, and the env-file loader filtered
through an allowlist that excluded `ZAI_API_KEY` while the endpoint validator
accepted the identical key from the ambient environment. Same key, `valid` one
way and `invalid` the other, with this server printing the way that does not
work. The loader now accepts each lane's own declared provider secrets — per
lane, so nothing gains another lane's vocabulary — and the guard applies the
returned remediation and requires the state to change, because asserting that a
sentence mentions the right variable is not a test of the repair.

A third was smaller and the same shape: `existsSync` was the entire `agy`
executable check, so a mode-0644 file, or a directory with the right name,
reported a valid configuration while executing it failed `EACCES`. AGY is not in
the unchecked set — executable discovery is the one parent-side fact it claims —
so that green was false about its own boundary.

## The argument against

A shipped MCP server is a new attack surface and a new thing to keep working, in
a repository that has twice decided against MCP. The counter-argument is real:
this could have been a skill, a `--status` flag, or a paragraph in the README,
none of which adds a protocol.

The reason to prefer it is that the failure being fixed is a fact existing in
code that nobody could reach: a flag has to be known about before it is typed and
a README has to be found before it is read, which is the same failure one layer
up.

**That is a preference, not a proof, and this section twice claimed otherwise.**
The first version called an MCP tool "the only form of this answer" that arrives
unprompted. A Codex advisor named that a false dichotomy and it is one — a
model-invoked skill is also discovered from its description and can drive a
short-lived CLI, avoiding a long-lived process that loads credentials. The
replacement then said MCP is "more reliably advertised", and the same room caught
that too: it is a comparative, this change measured no discovery rate, no
invocation rate, no startup cost and no operator confusion for either shape, and
a missing experiment stated as a conclusion is the thing an ADR exists to prevent.

What is actually held, and all that is: **Master chose MCP. Claude registers a
plugin's MCP server automatically, so a tool DESCRIPTOR is present in the
operator's session without anyone typing anything — whether the model then
notices and uses that descriptor more reliably than a skill description is
unmeasured.** The cost is an auto-started process holding this capability.

## What would reverse this

If the server ever needs to do more than answer — a tool that starts something,
a field that carries a secret, or a reason to hand it to a dispatched agent —
that is not an extension of this decision. Write the next ADR.
