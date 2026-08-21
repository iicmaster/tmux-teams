# ADR 0007: The plugin ships an MCP server, and it only answers questions

## Status

Accepted — 2026-08-16, on Master's instruction, after the room measured that the
per-machine problem it addresses was already solved in code and unsolved in
practice.

**Amended — 2026-08-20, per Master's 2026-08-19 v0.33.0 scope decision (item 7,
`ROADMAP.md`): a live lane-health preflight.** This amendment adds a THIRD
tool, `acp_lane_probe`, and it contacts an endpoint — which is exactly the
thing the two paragraphs below (now marked amended in place) said this server
would never do. The roadmap entry names the amendment as part of the item
rather than a thing to ship quietly around it: "That contacts an endpoint,
which ADR 0007 currently forbids — so the ADR is amended as part of the item
rather than quietly contradicted." What follows is that amendment, not a
second document, because a reader who trusts the earlier "no endpoint
contacted" sentence deserves to find the correction in the same place.

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
`.mcp.json`, with **three** tools (was two — see the 2026-08-20 amendment
below for the third):

- `acp_lanes` — what lanes this plugin declares: family, provider, model,
  adapter package, and whether the lane DECLARES a pinned endpoint — the tool
  description said "verified" until a panel lane pointed out that a handler
  returning declared facts cannot have verified anything.
  Declared facts only, so it answers on a machine with nothing configured.
- `acp_lane_status` — whether a lane's CONFIGURATION is valid **here**, and when
  it is not, which closed diagnostic applies and which environment variable
  points at the missing piece.
- `acp_lane_probe` — **amendment, 2026-08-20.** Whether a NAMED lane can be
  reached live, right now, with one trivial one-word brief: reachable, out of
  quota, or refused, classified into a closed code and never into the
  provider's own wording. This is the one tool in this server that contacts
  an endpoint. See "The live probe" section below for what that costs and
  what it does not change.

`acp_lanes` and `acp_lane_status` remain exactly what this document already
says of them: declared facts and local-file configuration checking, nothing
contacted, nothing dispatched. That has not moved.

`acp_lane_status` reports `valid`, `invalid` or `unchecked`, and never a
boolean. The first version returned `ready: true`, and the advisor reproduced
what that costs in one command: with no HOME, no PATH and no credentials, the
`claude` and `codex` lanes both reported ready, because no parent-side check
exists for either and a green answer from a check that never ran means
nothing. Those two answer `unchecked` now. Every answer also carries what it
did **not** prove — no endpoint contacted, no credential accepted, no adapter
resolved, no session negotiated — because a diagnostic that says READY and is
then contradicted by the real gate destroys trust in the one feature meant to
explain a refusal.

## The three lines it does not cross

**ADR 0003 stands, and what "enforced" means here is narrower than the word
suggests.** A dispatched agent still receives no MCP server — the runner
REQUESTS `mcpServers: []` and the suite asserts that request. A panel lane
pushed back on the categorical phrasing and was right: what has been observed is
a mock receiving an empty request, not a real child's tool inventory. The
guarantee is about what is ASKED FOR — which is about what a lane is handed,
while this server is about what an operator can ask. Adding a discovery surface for the
operator does not weaken the containment seam, and if it ever looks like it does,
the seam wins.

**It reads credentials. It never returns a credential VALUE.** This paragraph
said "none is ever read" until a Codex advisor round-table refused the wording on
2026-08-16 and was right: deciding validity means calling `buildAcpLaunch`, which
reads the settings JSON, reads the credential file and copies provider secrets
out of the environment, and discarding a value you asked for is not declining to
read it. Master chose the honest version of the requirement over the flattering
one.

**And the sentence had to be narrowed a second time, for the same reason.** It
said values *and field names* never leave, while the shipped code names
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and the lane's own keys in the
`credential_missing` repair — put there deliberately in round three, because an
operator who is not told the vocabulary writes the wrong key into the right file
and gets the same silence. Round four reproduced the contradiction. A name is
not a secret; a value is. What was wrong was the CLAIM, and a claim its own code
contradicts is worse than a narrower one because it teaches a reader to stop
checking. The guard that missed it is the more interesting half: the secret
matrix asserted no field name reached the wire and passed, because every fixture
in it failed at `endpoint_missing` — where no credential sentence is produced.
**A guard that holds by never reaching the branch it guards is not a guard**, and
there is now a fixture that lands on that branch on purpose.

**And "never returns them" survived one more round than it deserved.** A third
advisor round reproduced a credential on the wire with the credential FIELDS
all clean: the fix sentence for a missing `agy` binary interpolated the RESOLVED
candidate path, so a secret value that also appeared in `HOME` was serialised
through the path diagnostic. Aliasing is how a guard shaped like a denylist gets
beaten, and the route the bytes took does not change what the bytes are. The
sentence now carries `$HOME/.local/bin/agy` unresolved — a constant, which is
also the clearer thing to print at an operator — and the suite pins a
credential hidden inside `HOME` as its own case.

The containment is therefore entirely on the OUTBOUND boundary, and the strength
of that word is worth stating exactly, because a panel lane challenged it: the
closed diagnostic set and the constant sentences are STRUCTURAL — a value cannot
reach the wire through a sentence that is a literal. The no-secret matrix is a
TEST ASSERTION over fixtures, which is evidence and not a mechanism. Both are
real; only the first is enforcement.

A failure is reported as a code from a closed set
with a sentence that is a constant of the module; the raw exception text never
reaches the wire, because the first version exported `String(error.message)`
verbatim and any future diagnostic downstream that interpolated a token would
have shipped it silently. The guard serialises whole replies built from
secret-bearing fixtures on the success path AND on each failure path, including
a credential supplied through the ambient environment rather than a file.

**What `acp_lanes` reports about an adapter is a DECLARATION, and a caller can
change which bytes run.** A round-seven panel lane put it precisely: every
shipped adapter command begins with a bare `npx` or `bunx`, `buildProfileEnv`
preserves the caller's `PATH`, and `executablePath` PREPENDS `$HOME/.local/bin`,
`$HOME/.kimi-code/bin` and `$HOME/.bun/bin` when they exist. So an operator who
controls their own home directory controls which adapter binary resolves — and
this tool reports the package the profile names, not the bytes that ran.

That prepending is deliberate and is not being removed: on a version-manager
machine the toolchain lives under `$HOME`, and a launch that cannot find it is
the shipped outage this project has already paid for once. The honest statement
is the boundary, not a fix:

- **Without required receipts**, the adapter identity in a lane report is a
  declaration. It says what the profile pins, and nothing observed it.
- **With `ACP_SESSION_RECEIPT_REQUIRED=1`**, the companion refuses an arbitrary
  `ACP_CMD` without an execution profile, and the receipt binds
  `adapter_integrity`, `adapter_entry_digest`, `adapter_metadata_digest`,
  `adapter_package_spec` and `adapter_resolved_version` — a mismatch on any of
  them fails the turn. That is where the bytes are pinned, and it is why both
  advisor skills now set the flag on every documented command.

The tool cannot close the gap itself without executing something, which is the
line it does not cross. Naming where the guarantee begins is the part that was
missing.

**Read-only, with no exceptions — amended 2026-08-20, because this sentence
became false the day `acp_lane_probe` shipped and saying otherwise here would
be the quiet contradiction this whole amendment exists to avoid.** It used to
read "No tool dispatches, spawns a lane, or starts a review," and the middle
clause is no longer true: the probe spawns exactly one process per lane
named, to ask it one trivial word and tear it down. What is still true, and is
the property this paragraph actually protects: **no tool dispatches or starts
a REVIEW, and no tool starts DELIVERY work.** A process started to prove
reachability is not a lane doing review work any more than a `ping` is — it
sends one message, discards every actual answer content, and reports a
classified reachability code. This is the same principle that keeps a
reviewer lane from launching delivery work: a surface that can answer
questions is a different thing from a surface that can act on an operator's
behalf, and the probe stays on the answering side of that line — it proves a
lane is alive, it does not use that lane for anything.

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

## The live probe — amendment, 2026-08-20

`ROADMAP.md`'s v0.33.0 item 7 named the gap this closes: "Lane health is
discovered one release at a time... On 2026-08-17 that cost four probes and a
swapped panel composition after the run had already started." `acp_lane_status`
answers whether a lane's CONFIGURATION is valid, which is a different question
on purpose — it contacts nothing, so it cannot tell an operator whether a
correctly-configured lane is actually out of quota today. Only a live attempt
can answer that, and this amendment ships the cheapest version of one.

**What is now contacted.** `acp_lane_probe` takes one or more lane ids,
explicitly named, and for each one not already known invalid: builds its
launch the same way a real dispatch would (`buildAcpLaunch`, the same function
`acp_lane_status` already calls to decide validity), spawns the adapter
process, and speaks the minimum of ACP needed to complete one turn —
`initialize`, `session/new`, `session/prompt` with a fixed one-word brief. The
process is torn down (SIGTERM then SIGKILL) whether it finishes, times out, or
refuses, bounded by a twenty-second per-lane ceiling. The result is classified
into a closed SIGNAL shape before this file ever sees it — `reachable`,
`quota_exhausted`, `probe_timeout`, `executable_missing`, `executable_unusable`
or `unclassified` — and the classifier (`classifyProbe`) reads only that shape,
never a byte of stdout or stderr. The same outbound contract this whole document
already states for `acp_lane_status` — a failure is a code from a closed set
with a constant sentence, never the raw exception — applies here without
exception, and the actual bytes a provider sends back (including whatever a
quota refusal or an auth refusal says in its own words) are read by the
transport ONLY to set one boolean (`quotaSignal`); they never reach a return
value, a log this server owns, or a reply.

**Amended again, 2026-08-22, and the shape of the correction is the point.**
This section listed FIVE codes and the transport now produces six: a PR review
bot found that every spawn failure was answering `executable_missing`, so
`EACCES` and `EPERM` — found, and this process may not run it — sent an
operator to install a file that was already there. That is
`executable_unusable`. The same review found that the quota regex was tested
against each stream chunk in isolation, so a refusal split across two `data`
events was missed; detection now runs over a **bounded 64-character rolling tail**,
which is a small correction to the sentence above: bytes are held for the
length of that tail rather than examined and dropped within one chunk. It is
sixty-four CODE UNITS, not bytes — this paragraph said bytes for a day, and a
review lane read `String.prototype.slice` and said so. The tokens it watches
for are ASCII, so the span is what matters and the memory is bounded either
way; the claim is corrected rather than the code, because the code is right. Nothing
about where they may go changed. The internal `settled` shapes also grew —
`refused`, `cancelled` and `invalid_handshake` join `response`, `exit`,
`timeout` and `spawn_error` — because three paths used to reach the twenty-
second ceiling instead of settling, and one reported a cancelled turn as a
real answer.

**What is still never done, and this is the amendment's whole boundary.**

- **No scheduler ships.** This is an on-demand MCP tool with no timer, no
  cron, and no loop anywhere in this codebase that calls it automatically.
  ROADMAP.md states this as a requirement in its own words: "it is not a
  health-check that runs on a timer and it must not become one." An MCP tool
  has no scheduler of its own, so the only way this becomes one is somebody
  wrapping the call in a loop elsewhere — nothing in THIS server can stop
  that, which is exactly why the structural answer lives in the next bullet
  rather than in a promise about how the tool is used.
- **No probe-everything default.** `lanes` is a required, non-empty array —
  refused synchronously, before any process is spawned, if it is missing,
  empty, not an array, or contains a non-string. A caller who wants every lane
  probed has to type every lane id; there is no shorthand that reaches all
  seven with less typing than naming them, so a sweep is a decision made on
  purpose every time rather than the path of least resistance. The suite
  proves the negative half of this directly: every refusal case is asserted
  against a transport spy that records whether it was ever called, and it
  never is.
- **ADR 0003 is untouched.** A dispatched ACP agent still receives no MCP
  server at all, this one included. The probe runs only from the operator's
  own MCP session, the same surface `acp_lanes` and `acp_lane_status` already
  occupied.
- **No credential value reaches a reply, on any path.** The invalid-lane
  short-circuit reuses `acp_lane_status`'s own guarantee unchanged. The live
  path is new and carries the same guarantee for a new reason: the transport
  DOES receive real credentials (it has to — a probe that cannot authenticate
  proves nothing), and the classifier it reports through is the closed SIGNAL
  shape above, which structurally has no field a value could ride in. The
  suite's secret-matrix tests were extended rather than duplicated: one proves
  a credential sitting in an unreadable file still never surfaces (the
  existing guarantee, exercised through the new tool), and a second proves a
  credential that DOES reach the transport — confirmed by the fake transport
  asserting it saw the real value — still never reaches the reply back.
- **No tool call authorizes anything the probed lane asks for.** An ACP
  adapter that sends a client-initiated request mid-handshake (most notably
  `session/request_permission`) is answered immediately with a refusal
  (`{ outcome: { outcome: 'cancelled' } }`, or an empty result for anything
  else) rather than left to stall toward the timeout or, worse, granted by
  default. A probe proves a lane is alive; it does not use that lane's tools
  for anything, on purpose.

**What the operator is trusting.** Each `acp_lane_probe` call spends real
minutes (up to the per-lane timeout) and real provider quota — this is stated
in the tool's own description, not only here, because the anti-sweep posture
this amendment insists on is worth nothing if the cost is hidden from the
caller deciding whether to spend it. The answer is a snapshot: `reachable`
right now says nothing about a minute from now, and the probe's own
`notProven` list says so on every answer, the same discipline `acp_lane_status`
already applies to `valid`. And the real transport that talks to an actual
provider adapter has not been driven against a live provider by this change's
own tests — deliberately, matching the roadmap's own warning about spending
real quota in a verification pass. Every test in this file's suite injects a
fake transport instead; the real one is exercised only by the manifest-launched
server an operator actually runs. Treat it with the same honesty this project's
`CLAUDE.md` already applies to the `party-advise` bwrap gate: designed
carefully, unproven by a real run until someone spends the quota to take one.

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

## What the fourth round changed

Round three fixed the Zai credential repair by widening the LOADER and stopped
there. Round four found the same defect alive in the Kimi lane: the endpoint
check still named three keys literally, so `KIMI_API_KEY` was read and then not
accepted from any source, while this server printed it as the repair. **The half
that shipped was the half that advertises.** Both sides now call one function,
`acceptedCredentialNames`, so the advertised vocabulary and the accepted
vocabulary cannot drift again — and the guard applies each advertised name and
requires the state to change, rather than asserting that a sentence mentions it.

Writing that guard surfaced an asymmetry worth stating: `ANTHROPIC_AUTH_TOKEN`
and `ANTHROPIC_API_KEY` are honoured from a routed lane's own FILES and not from
the ambient environment, while a lane's declared secrets work from either. That
is deliberate — a token sitting in an operator's shell must not silently
authenticate a routed lane — and it was undocumented until a test asserted the
simpler thing and went red.

Two protocol answers were also wrong in the other direction, which is the
direction that is easy to miss because it looks like rigour. `Number.isInteger`
turned JSON-RPC's "fractional ids SHOULD NOT be used" into a local MUST NOT, so
`id: 1.5` — legal under MCP's `string | number` — was refused, and refused under
`id: null`, which loses the correlation. And only `tools/call` validated its
params, so `initialize` with none, `tools/list` with an array and `ping` with
unexpected params all answered success.

The per-method validation matches MCP's `InitializeRequest` in full:
`protocolVersion`, `capabilities` and `clientInfo` are all required, and
`clientInfo` must carry a string `name` and `version`.

**This paragraph said the opposite for one release cycle**, describing
`capabilities` and `clientInfo` as type-checked-when-present and deliberately
not demanded, with an argument for why the asymmetry was a reasonable judgement.
A panel lane read the paragraph against the code at the same sha and found the
code had moved: a different lane, one round earlier, had objected that requiring
`clientInfo` to BE an object while never checking its contents was half a rule,
and the fix went in without this document following it.

That is the failure this whole release has been chasing, committed once more in
the document that describes it. The rule now is what the code does, and what
changed the decision is worth keeping: `ping` and `initialize` were each wrong
in BOTH directions across three commits — too tolerant, then too strict — and
the answer was the specification every time, never a preference for strictness
or for tolerance.

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

This section used to say: "If the server ever needs to do more than answer —
a tool that starts something... that is not an extension of this decision.
Write the next ADR." **That is exactly what `acp_lane_probe` is, and this
document is the record of it happening rather than a second one.** The
difference between a quiet violation and a governed amendment is not that the
line moved without being named — it is that Master decided it explicitly
(`ROADMAP.md`, v0.33.0 item 7, 2026-08-19: "That contacts an endpoint, which
ADR 0007 currently forbids — so the ADR is amended as part of the item rather
than quietly contradicted"), and the amendment above states plainly what is
now contacted, what still is not, and what an operator is trusting. Amending
this document in place rather than opening ADR 0008 was a judgement call: the
probe is a third tool on the SAME server, answering the SAME kind of
question — "what can this server tell me right now" — rather than a
different capability bolted alongside it, so the two earlier "no MCP"
decisions this document already distinguishes itself from (ADR 0003, ADR 0005)
still apply unchanged and a new ADR number would not have said anything this
one plus its amendment does not.

What reverses THIS decision, updated for what now exists:

- **A scheduler.** `acp_lane_probe` is on-demand only; nothing in this
  codebase calls it on a timer, and the amendment above states that as a
  requirement, not a description of today's behavior. Wrapping it in one is
  the reversal.
- **A probe-everything default**, or any change that makes naming every lane
  cheaper than typing every lane id. The anti-sweep guard is the entire
  argument for shipping this at all.
- **A probe that touches a lane's actual capabilities** — approves a tool
  call, reads a file, writes anything, or otherwise uses the lane for
  something instead of proving it answers. The moment a probe does real work,
  it is dispatch wearing this tool's name, and ADR 0003's boundary is the one
  that would actually be crossed.
- **A credential value reaching a reply, on any path**, live or config-time.
  That line has not moved since this document's first version and the live
  probe does not get a lighter version of it.
- **Handing this server, or any tool on it, to a dispatched agent.** ADR 0003
  still says a dispatched agent receives no MCP server, and nothing in this
  amendment argues for an exception.

Anything else this server needs to do beyond a bounded, explicitly-named live
probe is the next ADR, same as before.
