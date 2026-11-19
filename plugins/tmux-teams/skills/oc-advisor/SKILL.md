---
name: oc-advisor
description: "Consult an OpenCode advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. The default seat is opencode/deepseek-v4.1-flash-free with a ten-rung strength-ordered free-seat ladder behind it, and identity is verified via ACP_EXPECT_MODEL. Read-only posture: permission requests are denied at the transport (ACP_PERMISSIONS=deny) and the brief forbids edits — that is a policy guard and a documented residual, not a sandbox claim. Use when the user invokes $oc-advisor, wants a fourth family's read on a question, names a seat, or adds --party <id> to seat a saved bmad-party-mode roster."
---

# OpenCode Advisor

The fourth sibling of `codex-advisor`, `claude-advisor` and `agy-advisor`. This
one reaches OpenCode's own free seats through its ACP server (`opencode acp` —
no separate adapter package in between): DeepSeek by default, with a
ten-rung strength-ordered free-seat ladder behind it. Those are ten seats
behind one provider, not ten vendors, so a disagreement here with codex/agy is
the cross-vendor read — a disagreement between two OpenCode seats is worth
reading but is still not a cross-vendor read.

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
`acp-execution-profile`, and `@opencode/cli` ships no JS launcher: its bin IS a
native binary (measured 2026-11-19 on `2.3.2`: `bin/opencode.exe`). The producer
pins that binary, its `package.json`, and the agent identity OpenCode reported
over a live initialize (`{name: "OpenCode", version: "2.3.2"}`):

```bash
node <plugin-root>/skills/tmux-teams/scripts/opencode-execution-profile.mjs \
  <run-cwd>/.tmux-teams/opencode-execution-profile.json
```

Exit `0` prints the two variables the dispatch below consumes
(`ACP_CMD`, `ACP_EXECUTION_PROFILE`). Exit `1` is usage; exit `2` is a refusal
— no verified pinned install in the npm caches (run
`npx -y @opencode/cli@2.3.2 --version` once, then retry), an ambiguous or
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
ACP_MODEL="<model>" \
ACP_EXPECT_MODEL="<model>" \
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
expectation is a dispatch nobody verified. See Arguments for which id — the
default seat, or the next rung after a ladder step. **Never hop a rung
because an answer merely disappointed you**: the ladder is entered only on the
failure evidence listed there.

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
$oc-advisor                     # default seat (ladder rung 1): opencode/deepseek-v4.1-flash-free (free)
$oc-advisor free                # the same seat, named explicitly
$oc-advisor deepseek            # the same seat by model name
$oc-advisor inkling             # ladder rung 2: opencode/inkling-2-small-free (free)
$oc-advisor glm                 # ladder rung 3: opencode/glm-5.3-flash-free (free)
$oc-advisor mimo                # ladder rung 4: opencode/mimo-v2.6-flash-free (free)
$oc-advisor hy4                 # ladder rung 5: opencode/hy4-flash-free (free)
$oc-advisor longcat             # ladder rung 6: opencode/longcat-2.5-free (free)
$oc-advisor flint               # ladder rung 7: opencode/flint-40b-free (free)
$oc-advisor beam                # ladder rung 8: opencode/beam-free (free)
$oc-advisor nemotron-super-vl   # ladder rung 9: opencode/nemotron-3.5-super-vl-free (free)
$oc-advisor nemotron-lightning  # ladder rung 10: opencode/nemotron-3.5-lightning-free (free)
```

| `<seat>` | dispatches |
|---|---|
| *(omitted)* | `opencode/deepseek-v4.1-flash-free` |
| `free` | `opencode/deepseek-v4.1-flash-free` |
| `deepseek` | `opencode/deepseek-v4.1-flash-free` |
| `inkling` | `opencode/inkling-2-small-free` |
| `glm` | `opencode/glm-5.3-flash-free` |
| `mimo` | `opencode/mimo-v2.6-flash-free` |
| `hy4` | `opencode/hy4-flash-free` |
| `longcat` | `opencode/longcat-2.5-free` |
| `flint` | `opencode/flint-40b-free` |
| `beam` | `opencode/beam-free` |
| `nemotron-super-vl` | `opencode/nemotron-3.5-super-vl-free` |
| `nemotron-lightning` | `opencode/nemotron-3.5-lightning-free` |

A bare alias is expanded to the full `opencode/...` id, which is what reaches
the adapter and what the receipt must show. Any other model id is a usage
error: this file documents exactly ten measured seats, and an unmeasured id
either fails the dispatch or silently seats something nobody verified. All ten
ids were probed against `opencode acp` 1.18.21 on 2026-11-18 (advertised in
`configOptions` and accepted by `session/set_config_option`); a follow-up probe
on `@opencode/cli@2.3.2` on 2026-11-19 confirmed the other nine rungs present in
v2.3.2 while `glm-5.3-flash-free` was absent from the v2.3.2 catalog.

A named rung below the default is not a general-purpose switch. It is a ladder
seat, so an operator typing one deliberately is making an explicit, disclosed
choice — but the reason to be on it is one of the entry conditions below, and
an answer produced there must still be labelled with its seat.

## The fallback ladder — rungs in strength order, and the evidence that enters each hop

`deepseek` — ladder rung 1 — is the default seat; the nine rungs below it are
the ladder, entered only on evidence, never as a preference. Take the next
rung when the **current seat cannot answer**, and only then — a working answer
from any rung is the answer, however much a reader dislikes it. This changes
the SEAT, not the account: a provider-side condition affecting the whole
OpenCode service is not ladder evidence (see the last entry).

The rungs, in strength order: `deepseek -> inkling -> glm -> mimo -> hy4 -> longcat -> flint -> beam -> nemotron-super-vl -> nemotron-lightning`. That
order is the measured-strength ranking recorded in
[../../docs/oc-advisor-free-seat-strength.md](../../docs/oc-advisor-free-seat-strength.md);
the full `opencode/...` ids sit in the Arguments table above. Each hop
descends exactly one rung, on its own evidence.

Enter the ladder on exactly one of these, each requiring evidence about **this
seat's model identity**, not merely a dispatch that stopped:

1. **The adapter refuses the model, terminally** — `ACP_MODEL` not advertised,
   or a receipt whose `identity_status` is `mismatched`/`missing` for a
   dispatch that has ENDED. A lane still RUNNING is not a refusal: a pending
   identity is `identity_status: missing` while the companion keeps polling,
   so **wait and re-read `status` — never hop on a pending value.** Other
   pre-prompt refusals (profile/config/receipt-path/boot failures) are NOT
   ladder evidence: fix or report them with the seat unchanged.
2. **The provider refuses the account for that seat** — a quota, membership,
   or retired-model-id condition **named in the lane log for that seat**. Same
   brief, fresh dispatch.
3. **The current seat repeats `no_outbox` after one resume** under the same
   task id, with the lane having ENDED (not merely gone quiet) — **unless the
   denial came from `ACP_PERMISSIONS=deny` itself**, which outranks this rule:
   a permission-denied outbox write is the policy working, so it is never a
   ladder entry, however many times it repeats. The permission-allowed
   recovery path above is the answer there, and it is labelled as such.

Do NOT enter it for: a slow lane, a pending (unsettled) identity, an answer
you judge weak, a denied outbox write under `ACP_PERMISSIONS=deny`, a single
`no_outbox` that has not been resumed once, a **failed LOAD** (`resume_status:
load_failed` is not a second `no_outbox`), or a `session/prompt` that errored
without a seat-specific diagnosis — a generic `UnknownError` from OpenCode is
a service condition, so report it and stop, never hop. Label the answer with
the seat that produced it, every time — a consultation that quietly changed
seats is the same lie as a wrong identity. (`agy-advisor` carried that
labelling rule for an automatic quota fallback until 2026-11-15, when the
shared Gemini quota pool retired that fallback; the labelling rule is the part
kept here, and this ladder is the only place it fires.)

**One rung at a time, inside these ten seats.** Hop to the NEXT rung only,
each hop on its own evidence; when the last rung also fails, stop and report
every event. Never a model outside the documented ids, and never another
family: the point of this advisor is which family answered. Walking the ladder
is a disclosed, bounded descent within this advisor's own free seats — it is
not a licence to route an OpenCode failure to codex, agy or claude.

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

### Automatic party selection

If the operator names no room, or names `auto`, the script chooses a saved room
from the assigned work instead of inventing a cast. Pass the brief as a file:

```bash
node <plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs auto --task-file <brief>
```

Leaving the id off entirely (`--task-file <brief>` alone) does the same thing.
Selection is a deterministic keyword count over the brief against the
`SELECTION_CATALOG` constant in `advisor-party.mjs` (documented for maintainers at
`_bmad-output/specs/spec-advisor-party-type/selection-catalog.md`); it makes no
network or model call. A named id still wins and takes the resolve-or-refuse path
unchanged.

On a hit, stdout is byte-identical to the mandate for that id seated explicitly,
so paste it into the brief exactly as above. One `selected-party: <name> (<id>)`
line goes to **stderr** — that is where the operator reads which room was chosen;
it is never part of the brief. Exit `0` means a room was selected.

Exit `3` means auto selection found no room (no catalog keyword hit, or a tie at
the top score): stdout is empty. **On `3`, emit the original "Cast 3-5 named
voices" paragraph and tell the operator that no saved room matched.** Auto never
fails open to a guessed room. Exit `2` here means `task_file_unreadable` (no
readable `--task-file`) or a resolver refusal — stop and tell the operator, as
with any `2`. Exit `1` is a command-usage error.

## The receipt, and what it does not prove

The receipt should read `effective_identity: <seat>`,
`identity_status: matched` where `<seat>` is the id that was dispatched —
`opencode/deepseek-v4.1-flash-free` on the default seat, or the id of the seat
that actually answered after a ladder step. The adapter
acknowledges the model through `session/set_config_option` before the prompt,
and a mismatch fails the dispatch first. Read the seat off the receipt rather
than assuming the default: after a ladder hop the two disagree, and the receipt
is the one that is right.

The receipt proves the executable, the session and the configured identity.
It does NOT prove the provider answered, and it does not attest
`ACP_PERMISSIONS` — the deny policy lives in per-dispatch environment and in
the routing record, never in the receipt. Measured on this account,
2026-11-08: the free seat runs WITHOUT any stored opencode credential —
`~/.local/share/opencode/auth.json` needs no `opencode` entry at all — but an
EXPIRED key stored there actively blocks every dispatch with
`API key has expired` before the first turn. The fix for that error is to
remove or renew the stored key, never to add one blindly.

A provider-side failure is reported as it happened — the lane's log carries
the provider's own error. Within the ten documented seats, and only on the
seat-specific conditions listed under the ladder above, the one permitted
consequence is the bounded descent — one rung at a time, in ladder order;
anything wider, including routing a generic service error to another family
(codex, agy, claude), changes what the reader is buying and is forbidden.

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

**What is measured, stated by LAYER — and the layers differ.** Evidence exists
for the session/model-configuration layer only, and it stops where the prompt
begins: a fresh dispatch reaches `session/new`, is acknowledged by
`session/set_config_option`, and commits a receipt reading
`identity_status: matched` (observed 2026-11-09 on the seats documented then,
per this repository's own dispatch records — not re-measured since). The
2026-11-18 probe extends that config layer to all ten rung ids — advertised in
`configOptions` and accepted by `session/set_config_option` — and the 2026-11-19
probe of `@opencode/cli@2.3.2` confirmed 11 free models in `session/new` (nine
rungs present; `glm-5.3-flash-free` absent in v2.3.2). No prompt was sent, so
the probe proves nothing past the ACK. The **answer layer
is NOT measured**: as of 2026-11-16 `session/prompt` fails inside OpenCode with
`Unexpected server error` for the deepseek seat, the glm seat AND a keyed
`zai-coding-plan` seat alike, so no round-table outbox has been produced
through the ACP path since the 2026-11-08 keyless run. Do not read a matched
receipt as a working answer, and do not read this file as a claim that any
rung currently answers. Receipt-backed LOAD is likewise unverified — treat the
first resume as the measurement, and report what actually happened rather than
assuming it.

```bash
env -u ACP_REASONING_EFFORT -u ACP_EXPECT_REASONING_EFFORT -u INITIAL_AGENT_MODE \
ACP_SESSION_RECEIPT_REQUIRED=1 \
ACP_SESSION_OPERATION="load" \
ACP_PRIOR_DISPATCH_ID="<dispatch-id from the failed run's receipt>" \
ACP_PRIOR_RECEIPT_DIGEST="<receipt_digest from that run>" \
ACP_RESUME="<session-id>" \
ACP_MODEL="<model>" \
ACP_EXPECT_MODEL="<model>" \
ACP_PERMISSIONS="deny" \
ACP_CMD="<exe> acp" \
ACP_EXECUTION_PROFILE="<profile.json>" \
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  opencode <cwd> <task-id> <recovery-prompt> [stall-sec]
```

Resume the seat you dispatched, not the default: a session belongs to the
model that held it, and loading it under a different seat is a different model
reading someone else's lineage. Take `<model>` from the failed run's receipt.

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
  flag in a recorded, labeled recovery, never silently. **A denied outbox
  write outranks the repeat rule: it is never a ladder entry, however many
  times it repeats.** A second `no_outbox` with the lane ENDED, where deny was
  NOT the cause, is ladder entry 3.
- **Identity refused.** The adapter did not acknowledge the seat that was
  requested. A TERMINAL refused seat (`mismatched`/`missing` on an ENDED
  dispatch) is ladder entry 1 — the default seat hops to rung 2, and a refused
  rung hops to its next rung the same way; a still-RUNNING lane with a pending
  `missing` is not a refusal, so `status` again rather than hopping. A refusal
  at the last rung is the end of the ladder: report every event and stop.
- **A generic `session/prompt` error (`UnknownError` / `Unexpected server
  error`).** A service condition, not a seat verdict: report it and stop.
  Never hop, never call it quota, never retry under another seat on this
  evidence.
- **A failed LOAD** (`resume_status: load_failed`). Not a second `no_outbox`
  and not ladder evidence — report it and stop.
- **Provider billing/account failure named for the seat on the first turn.**
  Report the provider's own error from the lane log. Only a seat-specific
  condition named for THIS seat is ladder entry 2; routing the question to
  codex, agy or claude instead changes the answer's provenance and is
  forbidden.
- **Profile refuses.** The producer's exit-2 reasons are each a real
  condition — resolve the cache state, never hand-edit the generated profile,
  and never change the seat to work around it.
- **Single voice returned.** Not a consultation.
