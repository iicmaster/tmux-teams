---
name: agy-advisor
description: "Consult an Antigravity/Gemini advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. Use when the user invokes $agy-advisor, wants an opinion from outside both the Claude and the OpenAI families, names the AGY seat, or adds --party <id> to seat a saved bmad-party-mode roster. Read-only: it advises, it never edits."
---

# AGY Advisor

The third sibling of `codex-advisor` and `claude-advisor`. Those two cover the
OpenAI and Anthropic families; this one reaches Gemini through Antigravity, so a
disagreement between all three is worth something a two-family split is not.

**Read `codex-advisor/SKILL.md` for the parts that are the same** — why an
advisor is an ACP lane rather than an agent, how the round-table is assembled
from the answer, and what a consultation with no receipt means. This file
carries only what is DIFFERENT about the AGY seat.

## The command

```bash
# The binary first. `buildProfileEnv` derives this for a REVIEW lane; a lane
# dispatched by hand is not that lane and gets nothing, so the command has to
# do it. The candidates, in order, are the ones `agyBinaryCandidates` builds in
# the party-mode review profiles.
AGY_BIN="$(for c in "$HOME/.local/bin/agy" /usr/local/bin/agy /usr/bin/agy; do
  [ -x "$c" ] && { echo "$c"; break; }; done)"
[ -n "$AGY_BIN" ] || { echo 'no agy binary on this machine — stop, do not let the adapter fetch one'; exit 1; }

env -u ACP_REASONING_EFFORT -u ACP_EXPECT_REASONING_EFFORT \
INITIAL_AGENT_MODE="read-only" \
ACP_SESSION_RECEIPT_REQUIRED=1 \
ACP_SESSION_OPERATION="new" \
ACP_MODEL="<model>" \
ACP_EXPECT_MODEL="<model>" \
AGY_BIN="$AGY_BIN" \
AGY_SKIP_DOWNLOAD=1 \
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  agy <cwd> <task-id> <brief-file> [stall-sec]
```

`<model>` is the expanded id — `gemini-4-argon-high` unless the caller named
another seat, see Arguments below. It goes in BOTH assignments: the request
without a matching expectation is a dispatch nobody verified. This command
hardcoded `high` in both places while the Arguments table promised `medium` and
`low`, so `$agy-advisor medium` ran high and produced a high receipt that
MATCHED — a silently ignored seat is worse than a refused one.

Measured 2026-10-17 against `agy` 1.3.5 rather than assumed: the lane accepts
all three contract variables, writes a receipt, and reports
`effective_identity: gemini-4-argon-high (matched)`.

## What differs from the Codex seat

**No reasoning-effort knob.** `codex-advisor` locks `ACP_REASONING_EFFORT=ultra`
and verifies it, so its identity reads
`gpt-6.1-sol[ultra]`. The Antigravity
adapter has no such dimension — the AGY identity is the bare model id, and
sending `ACP_REASONING_EFFORT` here asks for a config option the adapter does not
advertise, which fails the dispatch before the prompt.

**So the command CLEARS both variables rather than merely not setting them.** A
shell that has just dispatched a codex lane still carries
`ACP_REASONING_EFFORT` and `ACP_EXPECT_REASONING_EFFORT`, and
`acp-dispatch.mjs` forwards the whole caller environment. Measured: dispatched
from such a shell, the lane's `dispatch-routing/<task-id>.json` records both —
and `ROUTING_ENV_KEYS` is what a `resume` command is rebuilt from, so the
inherited effort outlives the dispatch that inherited it. Not setting a
variable is not the same as clearing it.

**The adapter advertises `<id>\t<display label>` — with a TAB.** The pre-check
accepts either the full advertised string or the bare id, and the bare id is what
the adapter reports back as applied. Send the bare id. A value copied out of a
rendered log has a SPACE where the real string has a tab, and a tab rendered as
whitespace is how this seat spent months carrying an identity exemption it did
not need.

**It needs its executable, not a package manager.** `AGY_BIN` names the binary
and `AGY_SKIP_DOWNLOAD=1` stops the adapter fetching its own. `buildProfileEnv`
sets both for a REVIEW lane; a lane dispatched by hand is not that lane and gets
neither — which is why the command above derives them rather than assuming.
This paragraph described that gap accurately while the command printed directly
above it walked straight into it, for the whole of v0.33.0's review cycle.

## Model policy — this is the part that fails closed

The default is `gemini-4-argon-high` (Master, 2026-10-17, moved off `gemini-3.7-flash-high`).

**Gemini 3.1 variants are PROHIBITED for planning, review and delivery work.**
If a configured or acknowledged model is a 3.1 variant, fail the dispatch — do
not fall back to it, and do not proceed on the grounds that a lane answered.

Verify the ACKNOWLEDGED identity, never the requested one. The adapter's own
default has moved underneath a pin before: a release panel recorded the adapter
advertising 3.7 while this repository still pinned 3.6, and the set-and-
acknowledge succeeded, so the lane really did run what it was told — but nothing
would have noticed if it had not.

The 3.1 prohibition above is untouched by the rate-limit fallback in the next
section: the fallback maps gemini-4 seats to gemini-3.8 flash seats at the same
tier only, so it can never reach a 3.1 value and the two sections cannot be
read as contradicting each other.

## Rate-limit fallback — the one automatic downgrade this seat takes

Measured 2026-10-21: a real dispatch (`pmd-review-agy`,
`ACP_MODEL=gemini-4-argon-high`) died on the Antigravity individual quota. The
runner log carried
`AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached...","status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true,...}`
— and the liveness record ended `liveness_state: "failed"` with
`termination_reason: "protocol_error"`. **The termination_reason is a red
herring**: it names the protocol frame the companion died on, not the provider
condition underneath it, so the ONLY evidence is in the runner log. A
classifier that read the liveness record alone would miss every one of these.

The rule (Master, 2026-10-30): a gemini-4 seat that dies with rate-limit or
quota evidence falls back IMMEDIATELY to the gemini-3.8 flash seat at the SAME
effort tier — a `gemini-4-argon-high` seat falls back to `gemini-3.8-flash-high`,
medium to medium, low to low — and the operator is TOLD before or with the
re-dispatch, so the work keeps moving. An error that stops the consultation is
the failure mode this section removes. `codex-advisor` says "Never downgrade
for cost or quota" and `claude-advisor` says "Never downgrade for cost, quota
or speed on your own initiative"; both keep their rules. This seat's quota
fallback is the ordered exception, and the ONLY automatic downgrade it takes.

```bash
# 1. Classify the failure. Exit 0 = rate-limited, the excerpt names the line
#    and where it came from; exit 1 = no rate-limit evidence; exit 2 = usage
#    or an invalid task id.
node <plugin-root>/skills/tmux-teams/scripts/agy-seat-fallback.mjs rate-limited <cwd> <task-id>

# 2. Map the seat at the same effort tier. Prints the fallback id —
#    `gemini-3.8-flash-high` here.
node <plugin-root>/skills/tmux-teams/scripts/agy-seat-fallback.mjs seat gemini-4-argon-high
```

3. Re-dispatch the SAME brief under the SAME task id with BOTH `ACP_MODEL` and
   `ACP_EXPECT_MODEL` set to the fallback seat — the dispatch command at the
   top of this file with `<model>` replaced by the fallback id in BOTH
   assignments, everything else unchanged: `AGY_BIN`, `AGY_SKIP_DOWNLOAD`, the
   receipt requirement, the cleared reasoning variables. The SAME task id is
   deliberate: the failed predecessor is settled, admission retires its
   leaves, and the outbox path the brief already names must not move.
4. Verify the new receipt's acknowledged identity IS the 3.8 seat (`matched`),
   and label the answer to the operator as coming from the fallback seat — a
   consultation that quietly changed seats is the same lie as a wrong identity.

**ONE HOP ONLY.** If the gemini-3.8 seat is ALSO rate-limited, stop and report
both events with their reset windows. Never a second hop, never another family,
never 3.1.

**Rate-limit evidence is the ONLY trigger for an automatic downgrade.**
Identity refusals, prohibited models, a missing binary, an unreadable brief —
each keeps failing closed exactly as before. Nothing here licenses a downgrade
for cost, speed or convenience.

## Arguments

```
$agy-advisor              # default seat: gemini-4-argon-high
$agy-advisor high         # gemini-4-argon-high
$agy-advisor medium       # gemini-4-argon-medium
$agy-advisor low          # gemini-4-argon-low
$agy-advisor flash-high   # gemini-3.8-flash-high
$agy-advisor flash-medium # gemini-3.8-flash-medium
$agy-advisor flash-low    # gemini-3.8-flash-low
```

A bare alias is expanded; the full `gemini-4-argon-*` or `gemini-3.8-flash-*`
id is what reaches the adapter and what the receipt must show. Any other name is
a usage error — do not pass a model through unrecognised, because an unknown
value either fails the dispatch or silently seats something nobody chose.

### `--party <id>` — seat a saved bmad-party-mode roster

Any seat above also takes `--party <id>`, the same flag `bmad-party-mode` takes.
Instead of the lane inventing 3-5 voices, it answers as the operator's own saved
party — real names, titles and scene. One script renders the roster so all three
`*-advisor` skills seat it the same way:

```bash
node <plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs <id>
```

`<plugin-root>` — the same spelling every dispatch command in this file uses,
expanded to `$CLAUDE_PLUGIN_ROOT` when you run it. NOT a repository-relative
path: an advisor is invoked from the operator's own project, where
`plugins/tmux-teams/...` resolves under THAT tree and exits `MODULE_NOT_FOUND`,
so `--party` would never reach the resolver. An openai review lane caught the
relative form in all three skills at once.

Paste what it prints into the brief **in place of** the invented-cast paragraph
(the one that asks for three to five named voices); leave the READ-ONLY paragraph
exactly as it is. Exit `0` is the only
success. Exit `2` names why it refused — `unknown_party` (with the ids that do
exist), `not_installed` (bmad-party-mode is a separate install, not shipped
here), `uv_missing`, `resolver_failed`, or `party_substituted` (the resolver
answered with a different party than the one asked for) — and on `2` **stop and
tell the operator, then ask whether to run with the invented cast instead.**
Exit `1` is a USAGE error in the command you typed — a missing id, a flag with
no value, an extra argument — and it prints the usage line and nothing else; fix
the command and run it again. A zai review lane found this section naming only
`0` and `2`, which left a lane that branches on those two with no rule for `1`
and free to proceed with the invented cast. Never substitute silently: someone
who typed `--party` asked for a specific room.

**This said "One seat" until 2026-08-19, and it was false the day it was
written.** Probed against `agy` 1.3.5 (2026-10-17), the adapter advertises
THIRTEEN values: the Gemini 4 Argon and Gemini 3.8 Flash seats at
high/medium/low, six Anthropic 5.5 seats (Opus and Sonnet at low/medium/high),
and a GPT-OSS one (earlier adapter versions advertised fourteen, including
3.7/3.6/3.5 Flash and both Gemini 3.1 Pro seats). The sentence came from an
assumption instead of a measurement.

## Two refusals, and they are not style

**Gemini 3.1 is PROHIBITED** and older adapter versions advertised
`gemini-3.1-pro-high` and `gemini-3.1-pro-low`, so it remains guarded in case
an older binary or cached model list is present. The companion refuses both the
request and the expectation and exits 2 before a session exists — measured, not
assumed. Never route around it.

**Never send a `claude-*` or `gpt-oss-*` value through this lane.** The adapter
will take them, and the moment it does, this seat stops being the Gemini family:
a three-family panel would be one lane wearing three names. The point of this
advisor is the family, not the endpoint.

## The consultation is a party. Only a party.

The advisor MUST answer as a `bmad-party-mode` round-table: several named voices
who argue with each other and are not reconciled into consensus. A single-voice
answer is a failed consultation — say so rather than passing it on.

Put the mandate in the brief, in these words:

```
Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
me. Do not reconcile them into one recommendation.
```

John (PM), Sally (UX) and Grumbal (The Adversary) are mandatory; others as the
topic needs. An advisor that reports as one voice has thrown away the reason it
was asked.
