---
name: agy-advisor
description: "Consult an Antigravity/Gemini advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. Use when the user invokes $agy-advisor, wants an opinion from outside both the Claude and the OpenAI families, or names the AGY seat. Read-only: it advises, it never edits."
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
INITIAL_AGENT_MODE="read-only" \
ACP_SESSION_RECEIPT_REQUIRED=1 \
ACP_SESSION_OPERATION="new" \
ACP_MODEL="gemini-3.7-flash-high" \
ACP_EXPECT_MODEL="gemini-3.7-flash-high" \
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  agy <cwd> <task-id> <brief-file> [stall-sec]
```

Measured 2026-08-19 rather than assumed: the lane accepts all three contract
variables, writes a receipt, and reports
`effective_identity: gemini-3.7-flash-high (matched)`.

## What differs from the Codex seat

**No reasoning-effort knob.** `codex-advisor` locks `ACP_REASONING_EFFORT=max`
and verifies it, so its identity reads `gpt-5.6-sol[max]`. The Antigravity
adapter has no such dimension — the AGY identity is the bare model id, and
sending `ACP_REASONING_EFFORT` here asks for a config option the adapter does not
advertise, which fails the dispatch before the prompt.

**The adapter advertises `<id>\t<display label>` — with a TAB.** The pre-check
accepts either the full advertised string or the bare id, and the bare id is what
the adapter reports back as applied. Send the bare id. A value copied out of a
rendered log has a SPACE where the real string has a tab, and a tab rendered as
whitespace is how this seat spent months carrying an identity exemption it did
not need.

**It needs its executable, not a package manager.** `AGY_BIN` comes from
`trustedAgyBinary` and `AGY_SKIP_DOWNLOAD=1` stops the adapter fetching its own;
`buildProfileEnv` sets both. A lane started outside that builder gets neither.

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
