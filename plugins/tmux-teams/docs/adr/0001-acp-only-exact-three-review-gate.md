# ADR 0001: ACP-only exact-three external review gate

## Status

Accepted

## Context

Party Mode needs the same independent review policy on every run. Letting the
host model choose reviewers or fall back across unrelated review plugins makes
the panel nondeterministic, can accidentally select the primary model's own
family, and can silently degrade to fewer than three reports. Review adapters
also need provider authentication without granting reviewers access to the
target repository or normal host state.

## Decision

External plan and completion review use one bundled JavaScript ACP Review Gate.
It selects exactly three distinct model families from a fixed route matrix,
requires AGY in every accepted panel, and permits at most one policy-selected
non-AGY reserve. OpenAI/Codex/`gpt-*` primaries use AGY, Kimi `kimi/k3`, and
Zai `zai/glm-5.2`; Codex cannot review that primary family. Gemini, AGY,
unknown, conflicting, and mixed-family primaries fail closed.

Direct Claude is currently marked unavailable by runner-owned policy. The gate
does not launch it. A reserve that names Claude resolves deterministically to
`claude-zai`, which is the existing Zai/GLM-5.2 profile—not a new Claude
identity. The substitution proceeds only when the resulting panel still has
exactly three distinct non-primary families and configured models; a duplicate
Zai lane, a retry of a failed Zai lane, or a Zai-primary collision fails closed.

The runner owns reviewer profiles, provider/display labels, the canonical
target-repository path, packet hash, and provenance. Each ACP adapter must
acknowledge the pinned model and safety configuration. Review text uses a
closed, bounded schema; two independent matching findings are must-fix.

On Linux, each lane runs under bubblewrap with the target and host user-data
roots hidden, a new PID namespace, a temporary workspace, and an ephemeral
provider HOME containing only required copied auth/config. MCP and built-in
tools are requested off, ACP permission requests are denied, and effectful tool
updates are rejected. The gate resolves the immutable profile executable before
staging, rejects target/PATH shadowing, and accepts only trusted runtime roots.
Packet redaction covers structured secret keys and bounded sensitive
assignments, headers, and query parameters. If AGY ignores the built-in-tool-off
request, it may report only a completed read confined to copied
provider-runtime documentation inside its isolated `builtin/` tree or an exact
canonical listing of the fresh neutral workspace root or the one canonical
runner-owned read-only guide telling it to use the prompt packet. The workspace
contains no packet file, target content, or other runner scaffolding; runtime,
scratch, and target-mask directories are mounted outside the reviewer cwd.
Missing paths, all other workspace descendants, relative escapes, symlinks
(including `link/..`), and mixed scopes fail closed. The runtime/workspace
scopes are counted separately; target and arbitrary reads remain rejected.
Provider network access remains shared so remote APIs work; same-process adapter
auth, local/LAN reachability, remote provider state, and lack of cryptographic
remote-model attestation remain explicit residual boundaries.
The Zai/claude-zai profile also pins a 4096-token thinking budget in its
allowlisted environment, keeping adaptive-thinking output inside the existing
stdout and timeout ceilings rather than weakening those bounds.

## Consequences

- Review routing and fallback are reproducible and testable.
- AGY failure or any panel that cannot restore exactly three valid reviews
  blocks the workflow.
- Callers must supply the trusted absolute target path separately from the
  untrusted static packet.
- Linux hosts require `/usr/bin/bwrap` and configured ACP provider runtimes.
- Schema validity and configuration acknowledgement do not replace PM semantic
  review of findings and cited evidence.

## Alternatives considered

- Other review plugins or MCP review tools: rejected because they create
  external dependencies and inconsistent fallback semantics.
- Model-selected reviewers on each run: rejected because primary-family
  exclusion and the exact-three invariant become probabilistic.
- Two-reviewer degradation: rejected because it weakens independence and the
  consensus threshold.
- Full network isolation: deferred because all current reviewers need remote
  provider APIs; an egress/auth broker would be a separate architecture change.

## Amendment 2026-08-03 — one lane runs `default`, and a routed lane pins its host

Every lane started in ACP plan mode, and the gate enforced that by overwriting
each profile before launch. Two consequences showed up in production at once,
and the panel failed on every run:

- `glm-5.2` cannot hold plan mode and the JSON-only review protocol at the same
  time. Asked for both it answers prose, the parse fails, and the lane is
  counted as broken. That lane now declares `reviewMode: 'default'` and the gate
  runs what the profile declares. **Plan mode was never what made a lane
  read-only** — the zero-tool contract is: no MCP servers, every ACP permission
  request denied, and a run that observed a tool call refused outright. Those
  are unchanged and still apply to `zai`. The vocabulary is closed at two words
  and a third is refused before launch.
- The `kimi` lane ran a native client nobody had logged into, and the decision
  above still names the model it ran then (`kimi/k3`); the lane is `kimi/opus`
  now, resolved server-side by the profile it routes through. It reaches its
  provider through the Claude ACP adapter and an operator-owned wrapper —
  which made its `family` label a claim about a file. The panel counts `family`
  to prove three DISTINCT families reviewed the work, so a settings file
  re-pointed at Anthropic would satisfy the exact-three rule with two seats from
  one family and nothing in the receipt would disagree. What pins it instead is
  the binary: the adapter resolves its Claude executable from
  `CLAUDE_CODE_EXECUTABLE`, and this lane names the operator's `claude-kimi`,
  which carries Kimi's base URL, key and config directory. The gate sets that
  name from the profile and the environment allowlist does not carry it, so a
  caller cannot re-point the lane. A lane that instead routes through a
  settings file — `zai` today — pins its provider host in its profile and is
  checked against it before launch; one that routes but pins nothing is refused
  rather than trusted.

Also rejected here, deliberately: carrying the provider's own stderr text in the
blocked report. It is the most readable diagnostic available and it is the one
thing a provider fully controls, in an artifact people paste into issues. The
redactor is a denylist and cannot be proven complete — measured on 2026-08-03,
it misses an OAuth `code=` in a device-flow URL, which is precisely what an
unauthenticated lane prints. `stage`, `stderrDigest` and `stderrBytes` stay the
boundary. A typed, closed set of reason codes with fixed operator actions is the
open follow-up; free provider text is not it.
