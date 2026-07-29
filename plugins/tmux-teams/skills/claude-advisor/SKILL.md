---
name: claude-advisor
description: "Consult a Claude advisor pinned to the top Claude model (fable at max reasoning effort) over ACP. The advice always comes back as a bmad-party-mode round-table, never as a single voice. Use when the user invokes $claude-advisor, asks for a second opinion from Claude's strongest model, or wants an outside read on a design, a risk, or a decision. Read-only: it advises, it never edits."
---

# Claude Advisor

A consultation lane. It asks the strongest Claude model a question and returns a
round-table — and it can prove which model answered.

## Why it is an ACP lane and not a subagent

A skill cannot pin a model: skill frontmatter is `name` and `description`. An
agent can (`model:` frontmatter), but nothing then verifies the request was
honoured, and per-agent reasoning effort is not expressible at all.

The ACP companion does both. `ACP_EXPECT_MODEL` and
`ACP_EXPECT_REASONING_EFFORT` make the adapter **acknowledge** its identity, and
a mismatch fails the dispatch instead of quietly answering from a cheaper seat.
That is this plugin's evidence-not-attestation rule turned on the advisor:
*asking* for fable is not the same fact as fable answering, and only one of the
two is worth paying for.

## The pinned identity — not negotiable

| | | |
|---|---|---|
| Model | `claude-fable-5` | **verified** — `ACP_EXPECT_MODEL`, `identity_status: matched` |
| Reasoning effort | `max` | **requested, not verifiable on this lane** — see below |
| Lane | `claude` (ACP) | |

### Effort cannot be proved here, and the skill says so

Measured 2026-07-29 by dispatching this lane: the Claude ACP adapter reports
`effective_identity: claude-fable-5` and `requested_reasoning_effort: none`. It
exposes no reasoning-effort field at all, so `ACP_EXPECT_REASONING_EFFORT` can
never match and setting it fails every dispatch with
`identity missing: expected claude-fable-5[max], effective claude-fable-5`.

An earlier draft of this file claimed effort was pinned and verified here. It
was not, and the claim survived only because nobody had run it — the same
mistake this whole plugin exists to make impossible, committed inside the skill
built to prevent it. The model **is** verified; the effort is the session's, and
this file will not pretend otherwise. If you need max effort from this lane,
set it on the session before dispatching and know that nothing checks you did.

`codex-advisor` **can** verify its effort, because the Codex adapter reports it.
That asymmetry is real and is not smoothed over.

Never downgrade for cost, quota or speed. The whole value of this skill is that
the answer came from the top of the range; a cheaper answer is not a cheaper
version of this skill, it is a different skill wearing its name. If the model is
unavailable, **report that and stop** — do not substitute.

## The consultation is a party. Only a party.

The advisor MUST answer as a `bmad-party-mode` round-table: several named voices
who talk to each other, disagree, and are not reconciled into a tidy consensus.
A single-voice answer is a failed consultation — say so rather than passing it
on.

This is not decoration. One advisor gives one framing and you cannot see what it
never considered; a room argues, and the disagreement is the part you could not
have produced alone. If the voices agree instantly, report that plainly — easy
consensus is itself a finding, usually that the question was too narrow.

## Running it

1. **Write the brief to a file.** It carries the question, the concrete context
   (paths, diffs, measurements — not a summary you composed), and this mandate:

   ```
   Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
   distinct expertise and real disagreements. They address each other, not
   only me. Do not resolve the clash into consensus; where they cannot
   agree, say so and say why. End with each voice's own bottom line.
   State plainly whatever you could not verify.
   ```

2. **Dispatch**, pinning and verifying the identity in one step:

   ```bash
   ANTHROPIC_MODEL="claude-fable-5" \
   ACP_EXPECT_MODEL="claude-fable-5" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-companion.mjs \
     claude <cwd> <task-id> <brief-file> [stall-sec]
   ```

   Do **not** set `ACP_CMD`, and do not set `ACP_EXPECT_REASONING_EFFORT` — the
   first bypasses the companion's own launch path, the second cannot be
   satisfied on this lane and fails every dispatch.

3. **Read the outbox.** No outbox file means no advice. A run that printed to
   the terminal and wrote nothing has produced no consultation, however good the
   text looked scrolling past — this has happened with a real model, whose
   answer was correct and landed nowhere a reader could find it.

4. **Report identity with the advice.** State the acknowledged model and effort
   beside the round-table. Advice whose provenance goes unstated is advice the
   reader must take on trust, which is the thing this lane exists to remove.

## Read-only

This lane advises. It does not edit files, commit, push, or run anything that
changes state. If the consultation ends in work to be done, hand that to
`party-auto`; the advisor's job stops at the recommendation.

## Failure modes

- **Identity refused.** The adapter did not acknowledge `claude-fable-5` at
  `max`. Report and stop — a rerun cannot change a declaration, and answering
  from whatever seat was free is the exact failure this skill was built against.
- **Single voice returned.** Not a consultation. Say so rather than presenting
  one opinion as a room.
- **Empty outbox.** No advice was produced. Do not reconstruct it from terminal
  output; that is attestation, and this plugin does not accept attestation.
- **Frictionless consensus.** Report it as a finding about the question, not as
  a strong answer.
