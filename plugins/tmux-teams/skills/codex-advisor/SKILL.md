---
name: codex-advisor
description: "Consult a Codex advisor pinned to the top Codex model (gpt-5.6-sol at ultra reasoning effort) over ACP. The advice always comes back as a bmad-party-mode round-table, never as a single voice. Use when the user invokes $codex-advisor, wants a second opinion from outside the Claude family, or wants an outside read on a design, a risk, or a decision. Read-only: it advises, it never edits."
---

# Codex Advisor

The sibling of `claude-advisor`, and the reason both exist: an advisor from the
same family as the asker shares its blind spots. This lane asks a different
vendor's strongest model, so a disagreement between the two is worth something.

## Why it is an ACP lane

Same mechanism as `claude-advisor`, and here it is the only mechanism — Codex is
not a Claude model, so no agent frontmatter can select it. The model and the
effort live on the invocation, and `ACP_EXPECT_MODEL` /
`ACP_EXPECT_REASONING_EFFORT` make the adapter acknowledge both. A mismatch
fails the dispatch rather than answering from a cheaper seat.

## The pinned identity — not negotiable

| | |
|---|---|
| Model | `gpt-5.6-sol` |
| Reasoning effort | `ultra` |
| Lane | `codex` (ACP) |

**Pass the effort explicitly; never inherit it.** On 2026-07-29
`~/.codex/config.toml` read `model_reasoning_effort = "low"` while
`party-mode/SKILL.md` asserted the default was already `ultra`. Every dispatch
that trusted that sentence ran at the bottom of the range while the document
promised the top — the model was right in that file and the effort was not,
which is a discrepancy no reader could see. That is why the expectation here is
verified rather than assumed.

Never downgrade for cost or quota. If `gpt-5.6-sol` at `ultra` is unavailable,
**report that and stop**; an answer from a lesser seat is not this skill.

## The consultation is a party. Only a party.

The advisor MUST answer as a `bmad-party-mode` round-table: several named voices
who argue with each other and are not reconciled into consensus. A single-voice
answer is a failed consultation — say so rather than passing it on.

## Running it

1. **Write the brief to a file** — the question, the concrete context (paths,
   diffs, measurements, not a summary you composed), and this mandate:

   ```
   Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
   distinct expertise and real disagreements. They address each other, not
   only me. Do not resolve the clash into consensus; where they cannot
   agree, say so and say why. End with each voice's own bottom line.
   State plainly whatever you could not verify.
   ```

2. **Dispatch**, pinning and verifying the identity in one step:

   Give Codex a config home of its own that pins the effort, leaving the
   machine's `~/.codex/config.toml` untouched:

   ```bash
   H=$(mktemp -d)
   for f in ~/.codex/*; do ln -s "$f" "$H/$(basename "$f")"; done
   rm -f "$H/config.toml"
   sed 's/^model_reasoning_effort.*/model_reasoning_effort = "ultra"/' \
     ~/.codex/config.toml > "$H/config.toml"

   CODEX_HOME="$H" \
   ACP_EXPECT_MODEL="gpt-5.6-sol" \
   ACP_EXPECT_REASONING_EFFORT="ultra" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-companion.mjs \
     codex <cwd> <task-id> <brief-file> [stall-sec]
   ```

   **Never set `ACP_CMD` on this lane.** The companion does not run `codex`
   directly: it launches a pinned `@agentclientprotocol/codex-acp` adapter whose
   entry point, digest and version it verifies first
   (`acp-companion.mjs` ~1104). `ACP_CMD` replaces that whole checked path with
   an unchecked one — and an earlier draft of this file did exactly that, which
   both discarded the integrity check and failed outright with
   `Error: stdin is not a terminal`, because bare `codex` opens a TUI rather
   than speaking ACP.

   Measured 2026-07-29: with `CODEX_HOME` the receipt reads
   `effective_identity: gpt-5.6-sol[ultra]`, `identity_status: matched`. Without
   it, the same probe reads `gpt-5.6-sol[low]`.

3. **Read the outbox.** No outbox file means no advice, whatever scrolled past
   in the terminal.

4. **Report identity with the advice** — the acknowledged model and effort beside
   the round-table, so a reader never has to take provenance on trust.

## Using both advisors on one question

When the question is architectural, hard to reverse, or one where being wrong is
expensive, ask both and **put the two round-tables side by side without merging
them**. Where they agree, that is agreement across vendors, worth more than
agreement inside one. Where they disagree, the gap IS the finding — the thing
neither lane could have shown alone — and blending it away destroys the only
reason to have paid twice.

Do not average them into a recommendation. Report the disagreement and let the
person decide.

## Read-only

This lane advises. It does not edit files, commit, push, or run anything that
changes state. Work that comes out of a consultation goes to `party-auto`.

## Failure modes

- **Identity refused.** The adapter did not acknowledge `gpt-5.6-sol` at
  `ultra`. Report and stop.
- **Effort inherited rather than set.** If the invocation did not name the
  effort, the answer may have come from `low` — see above. Treat an unverified
  effort as a refused identity, not as a minor omission.
- **Single voice returned.** Not a consultation.
- **Empty outbox.** No advice was produced. Do not reconstruct it from terminal
  output; that is attestation, and this plugin does not accept attestation.
