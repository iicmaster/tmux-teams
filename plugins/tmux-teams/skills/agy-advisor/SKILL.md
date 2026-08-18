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
$agy-advisor              # gemini-3.7-flash-high
```

One seat. If Antigravity gains a second model worth consulting, add it here with
its measured identity string, not with a guess at the name.

## Reporting

The answer comes back as a round-table, the same as its siblings: John (PM),
Sally (UX) and Grumbal (The Adversary) mandatory, others as the topic needs.
An advisor that reports as one voice has thrown away the reason it was asked.
