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

`<model>` is the expanded id — `gemini-3.7-flash-high` unless the caller named
another seat, see Arguments below. It goes in BOTH assignments: the request
without a matching expectation is a dispatch nobody verified. This command
hardcoded `high` in both places while the Arguments table promised `medium` and
`low`, so `$agy-advisor medium` ran high and produced a high receipt that
MATCHED — a silently ignored seat is worse than a refused one.

Measured 2026-08-19 rather than assumed: the lane accepts all three contract
variables, writes a receipt, and reports
`effective_identity: gemini-3.7-flash-high (matched)`.

## What differs from the Codex seat

**No reasoning-effort knob.** `codex-advisor` locks `ACP_REASONING_EFFORT=max`
and verifies it, so its identity reads `gpt-5.6-sol[max]`. The Antigravity
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

The default is `gemini-3.7-flash-high` (Master, 2026-08-16, moved off 3.6).

**Gemini 3.1 variants are PROHIBITED for planning, review and delivery work.**
If a configured or acknowledged model is a 3.1 variant, fail the dispatch — do
not fall back to it, and do not proceed on the grounds that a lane answered.

Verify the ACKNOWLEDGED identity, never the requested one. The adapter's own
default has moved underneath a pin before: a release panel recorded the adapter
advertising 3.7 while this repository still pinned 3.6, and the set-and-
acknowledge succeeded, so the lane really did run what it was told — but nothing
would have noticed if it had not.

## Arguments

```
$agy-advisor              # default seat: gemini-3.7-flash-high
$agy-advisor high         # gemini-3.7-flash-high
$agy-advisor medium       # gemini-3.7-flash-medium
$agy-advisor low          # gemini-3.7-flash-low
```

A bare alias is expanded; the full `gemini-3.7-flash-*` id is what reaches the
adapter and what the receipt must show. Any other name is a usage error — do not
pass a model through unrecognised, because an unknown value either fails the
dispatch or silently seats something nobody chose.

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
written.** Probed against the adapter, it advertises FOURTEEN values: the 3.7,
3.6 and 3.5 Flash seats at high/medium/low, both Gemini 3.1 Pro seats, two
Anthropic models and a GPT-OSS one. The sentence came from an assumption instead
of a measurement.

## Two refusals, and they are not style

**Gemini 3.1 is PROHIBITED** and the adapter advertises `gemini-3.1-pro-high`
and `gemini-3.1-pro-low` in the list above, so it is reachable by typing. The
companion refuses both the request and the expectation and exits 2 before a
session exists — measured, not assumed. Never route around it.

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
