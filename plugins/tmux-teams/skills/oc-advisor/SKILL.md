---
name: oc-advisor
description: "Consult an OpenCode advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. The seat is the free OpenCode line, pinned to opencode/deepseek-v4.1-flash-free with identity verified via ACP_EXPECT_MODEL. Read-only posture: permission requests are denied at the transport (ACP_PERMISSIONS=deny) and the brief forbids edits — that is a policy guard and a documented residual, not a sandbox claim. Use when the user invokes $oc-advisor, wants a fourth family's read on a question, or adds --party <id> to seat a saved bmad-party-mode roster."
---

# OpenCode Advisor

The fourth sibling of `codex-advisor`, `claude-advisor` and `agy-advisor`. This
one reaches the deepseek family through OpenCode's own ACP server (`opencode
acp` — no separate adapter package in between), so a disagreement between the
four seats is worth reading.

**Read `codex-advisor/SKILL.md` for the parts that are the same** — why an
advisor is an ACP lane rather than an agent, how the round-table is assembled
from the answer, what a consultation with no receipt means, and how to wait
and resume. This file carries only what is DIFFERENT about the OpenCode seat.

## One-time setup — the execution profile

**Update the plugin as a whole before using this skill.** A companion older
than this release (the installed 0.45.0 cache, for one) refuses the produced
profile before a session exists — copying the skill and the producer forward
without updating the plugin is not enough.

A receipt-required custom-worker dispatch refuses `ACP_CMD` without a closed
`acp-execution-profile`, and `opencode-ai` ships no JS launcher: its bin IS a
native binary (measured 2026-11-07 on 1.18.21: `bin/opencode.exe`, Mach-O
arm64). The producer pins that binary, its `package.json`, and the agent
identity OpenCode reported over a live initialize (`{name: "OpenCode",
version: "1.18.21"}`):

```bash
node <plugin-root>/skills/tmux-teams/scripts/opencode-execution-profile.mjs \
  <run-cwd>/.tmux-teams/opencode-execution-profile.json
```

Exit `0` prints the two variables the dispatch below consumes
(`ACP_CMD`, `ACP_EXECUTION_PROFILE`). Exit `1` is usage; exit `2` is a refusal
— no verified pinned install in the npm caches (run
`npx -y opencode-ai@1.18.21 --version` once, then retry), an ambiguous or
drifted set of cache hits (clear them and install fresh), or a whitespace
path the dispatch command cannot carry. Run it again after any cache change:
the profile is a local snapshot of bytes found at production time — it binds
what actually runs to what was profiled, and it is NOT an upstream integrity
verification of the package. The receipt's `node_executable_identity` field
keeps its historical name; on this lane it names the OpenCode binary.

## The command

```bash
env -u ACP_REASONING_EFFORT -u ACP_EXPECT_REASONING_EFFORT -u INITIAL_AGENT_MODE \
ACP_SESSION_RECEIPT_REQUIRED=1 \
ACP_SESSION_OPERATION="new" \
ACP_MODEL="opencode/deepseek-v4.1-flash-free" \
ACP_EXPECT_MODEL="opencode/deepseek-v4.1-flash-free" \
ACP_PERMISSIONS="deny" \
ACP_CMD="<exe> acp" \
ACP_EXECUTION_PROFILE="<profile.json>" \
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  opencode <cwd> <task-id> <brief-file> [stall-sec]
```

`<exe>` and `<profile.json>` come from the producer's output — paste them as
printed, and keep them together: the profile's argv is what the dispatch
verifies `ACP_CMD` against, and a mismatch fails before a session exists.
`<model>` is the full id in BOTH assignments; a request without a matching
expectation is a dispatch nobody verified.

The `env -u` line is the agy lesson applied here: a shell that just
dispatched a codex lane still carries `ACP_REASONING_EFFORT` and
`INITIAL_AGENT_MODE`, and the dispatcher forwards the whole caller
environment. OpenCode is not measured to honor either value, so the lane
neither sends nor claims them — clearing beats inheriting, and inheriting is
how a silent value outlives the dispatch that set it.

## Read-only — what is enforced, what is residual

**Enforced at the transport:** `ACP_PERMISSIONS=deny` makes the companion
answer every `session/request_permission` with the strongest reject the
adapter offered (`reject_always`, then `reject_once`), or cancelled when the
adapter offered no reject — an allow option never leaves the process. Under
the same flag `terminal/*` is refused even if the ambient environment enabled
the capability, because `terminal/create` spawns a process without ever
passing through the permission handler. Both behaviors are companion code
with tests, not brief prose.

**Residual, stated plainly:** this lane does NOT claim "it never edits". A
permission request is the only gate the transport holds; whether every
mutating tool of OpenCode 1.18.21 requests one is not proven from this
repository, and the MCP servers, configuration and skills the operator's
OpenCode install loads are the operator's own. The lane's posture is the
claude-advisor posture plus a hard guard: the brief forbids edits, the
transport refuses every permission it is asked to grant, and the two together
are the guarantee — nothing more is claimed.

**If the outbox cannot be written because a write was denied:** that is the
policy working, reported as `no_outbox` — not a bug to route around. The
deliberate exception is a recovery dispatch with `ACP_PERMISSIONS` unset: a
conscious policy change, recorded in the recovery command itself, and the
answer it produces must be labeled to the operator as coming from a
permission-allowed run. Never flip it silently.

## Arguments

```
$oc-advisor        # default seat: opencode/deepseek-v4.1-flash-free (free)
$oc-advisor free   # the same seat, named explicitly
```

A bare alias is expanded to the full `opencode/...` id, which is what reaches
the adapter and what the receipt must show. Any other model id is a usage
error: this file documents exactly one measured seat, and an unmeasured id
either fails the dispatch or silently seats something nobody verified.

### `--party <id>` — seat a saved bmad-party-mode roster

The same flag and the same rules as the other three advisors:

```bash
node <plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs <id>
```

`<plugin-root>` — expanded to `$CLAUDE_PLUGIN_ROOT`, never a
repository-relative path. Paste what it prints into the brief **in place of**
the invented-cast paragraph; leave the READ-ONLY paragraph exactly as it is.
Exit `0` is the only success. Exit `2` names why it refused —
`unknown_party`, `not_installed`, `uv_missing`, `resolver_failed`, or
`party_substituted` — and on `2` stop and tell the operator, then ask whether
to run with the invented cast instead. Exit `1` is a usage error in the
command you typed. Never substitute silently.

## The receipt, and what it does not prove

The receipt should read `effective_identity:
opencode/deepseek-v4.1-flash-free`, `identity_status: matched`; the adapter
acknowledges the model through `session/set_config_option` before the prompt,
and a mismatch fails the dispatch first.

The receipt proves the executable, the session and the configured identity.
It does NOT prove the provider answered. Measured on this account,
2026-11-08: the free seat runs WITHOUT any stored opencode credential —
`~/.local/share/opencode/auth.json` needs no `opencode` entry at all — but an
EXPIRED key stored there actively blocks every dispatch with
`API key has expired` before the first turn. The fix for that error is to
remove or renew the stored key, never to add one blindly. A provider-side
failure of any other kind is reported as it happened — the lane's log
carries the provider's own error — and is never routed to another family,
because the point of this advisor is the family, not the endpoint.

## Waiting and resuming

Same contract as every advisor: the dispatch RETURNS while the lane runs;
arm `wait` with the Bash tool using `run_in_background: true`; read the
outbox and the correlated receipt before using the advice.

```bash
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  status <cwd> <task-id>
```

Resume under the SAME task id, with `ACP_SESSION_OPERATION="load"`,
`ACP_PRIOR_DISPATCH_ID` and `ACP_PRIOR_RECEIPT_DIGEST` filled from the failed
run's receipt, and `ACP_CMD` / `ACP_EXECUTION_PROFILE` / `ACP_PERMISSIONS`
restored — the routing record carries all three since this seat shipped, so
the printed resume command includes them; pasting a resume without the deny
policy downgrades the lane to the allow preference while looking like the
same dispatch.

**Receipt-backed LOAD is documented by the same contract as every advisor
but is NOT yet verified live on this seat** — the fresh-dispatch path is
measured end to end; the load path is not. Treat the first resume as the
measurement and report what actually happened, never assume it.

```bash
env -u ACP_REASONING_EFFORT -u ACP_EXPECT_REASONING_EFFORT -u INITIAL_AGENT_MODE \
ACP_SESSION_RECEIPT_REQUIRED=1 \
ACP_SESSION_OPERATION="load" \
ACP_PRIOR_DISPATCH_ID="<dispatch-id from the failed run's receipt>" \
ACP_PRIOR_RECEIPT_DIGEST="<receipt_digest from that run>" \
ACP_RESUME="<session-id>" \
ACP_MODEL="opencode/deepseek-v4.1-flash-free" \
ACP_EXPECT_MODEL="opencode/deepseek-v4.1-flash-free" \
ACP_PERMISSIONS="deny" \
ACP_CMD="<exe> acp" \
ACP_EXECUTION_PROFILE="<profile.json>" \
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  opencode <cwd> <task-id> <recovery-prompt> [stall-sec]
```

## The consultation is a party. Only a party.

The advisor MUST answer as a `bmad-party-mode` round-table: several named voices
who argue with each other and are not reconciled into consensus. A single-voice
answer is a failed consultation — say so rather than passing it on.

Put the mandate in the brief, in these words:

```
Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
only me. Do not resolve the clash into consensus; where they cannot
agree, say so and say why. End with each voice's own bottom line.
State plainly whatever you could not verify.
```

## Read-only

This lane advises. It does not edit files, commit, or push. Work that comes
out of a consultation goes to `party-auto`. The enforcement boundary is the
section above: denied permissions, refused terminal, brief mandate — and the
residuals named there are part of this contract, not a footnote to it.

## Failure modes

- **`no_outbox` under `ACP_PERMISSIONS=deny`.** First resume under the same
  task id with the policy intact. If the runner log shows the denied request
  was the outbox write itself, the exception path above applies — unset the
  flag in a recorded, labeled recovery, never silently.
- **Identity refused.** The adapter did not acknowledge
  `opencode/deepseek-v4.1-flash-free`. Report and stop; do not re-seat.
- **Provider billing failure on the first turn.** Report the provider's own
  error from the lane log. This family is the point of the seat; routing the
  question to codex or agy instead changes the answer's provenance.
- **Profile refuses.** The producer's exit-2 reasons are each a real
  condition — resolve the cache state, never hand-edit the generated profile.
- **Single voice returned.** Not a consultation.
