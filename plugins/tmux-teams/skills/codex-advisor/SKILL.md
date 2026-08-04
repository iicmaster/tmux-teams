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
not a Claude model, so no agent frontmatter can select it. `ACP_MODEL` and
`ACP_REASONING_EFFORT` set the session for this dispatch through the standard
ACP `session/set_config_option` calls; `ACP_EXPECT_MODEL` /
`ACP_EXPECT_REASONING_EFFORT` make the adapter acknowledge the resulting
identity. When an explicit expectation is omitted, the selected value is also
the expectation. A missing option, rejected value, or mismatch fails the
dispatch before prompt delivery rather than answering from a cheaper seat.

## The pinned identity — not negotiable

| | |
|---|---|
| Model | `gpt-5.6-sol` |
| Reasoning effort | `ultra` |
| Lane | `codex` (ACP) |

**Pass the model and effort explicitly; never inherit them.** On 2026-07-29
`~/.codex/config.toml` read `model_reasoning_effort = "low"` while
`party-mode/SKILL.md` asserted the default was already `ultra`. Every dispatch
that trusted that sentence ran at the bottom of the range while the document
promised the top — the model was right in that file and the effort was not,
which is a discrepancy no reader could see. The adapter now selects both
values per dispatch and verifies the correlated session response rather than
assuming a machine default.

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

2. **Dispatch**, selecting and verifying the identity in one step:

   ```bash
   ACP_MODEL="gpt-5.6-sol" \
   ACP_REASONING_EFFORT="ultra" \
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

   The receipt should read `effective_identity: gpt-5.6-sol[ultra]`,
   `identity_status: matched`. If the installed ACP agent does not advertise
   the requested model/effort, the adapter fails closed before the prompt.

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

- **`no_outbox` — the turn finished and wrote nothing. TRY RESUME before
  re-dispatching.** It is cheap and it is the only path that could still hold
  the analysis, but it is not guaranteed: tried once here on 2026-08-04, the
  load warned `load receipt lacks requested prior lineage` and the agent
  answered `I have nothing`. Take the session id and send a short prompt —
  "you already read it, write what you have to `<path>`, do not redo the
  analysis" — which costs a few hundred tokens instead of the whole review:

  ```bash
  ACP_RESUME="<session-id>" ACP_MODEL="gpt-5.6-sol" ACP_REASONING_EFFORT="ultra" \
  ACP_EXPECT_MODEL="gpt-5.6-sol" ACP_EXPECT_REASONING_EFFORT="ultra" \
  node <plugin-root>/skills/tmux-teams/scripts/acp-companion.mjs \
    codex <cwd> <task-id> <recovery-prompt> [stall-sec]
  ```

  Two places the id lives: the run cwd's `.tmux-teams/` (the companion's own
  persisted session file), and
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<session-id>.jsonl`. Grep those
  for a phrase from your brief to tell attempts apart.

  **So never `rm -rf` the run directory before recording the id.** On
  2026-08-04 this lane finished and wrote nothing four times and the directory
  was wiped between retries, so the companion's own session file was gone every
  time and the ids had to be recovered from `~/.codex/sessions` instead.
  **Always ask the recovery prompt to say "I have nothing" plainly if the
  context is gone.** That clause is what turned the one attempt into a legible
  failure — a 456KB session existed, the load warned about missing lineage, and
  the agent said it had nothing rather than rebuilding a review from the
  recovery prompt it had just been handed.
- **What causes `no_outbox` on this lane is unexplained.** Brief size was the
  obvious suspect and it is wrong: 203KB failed twice, then a 7KB brief failed
  identically, while 52KB had succeeded that morning. Putting a large diff on
  disk and giving the agent paths is still worth doing for its own sake, but do
  not expect it to fix this. Try resume, then re-dispatch — do not theorise.
- **Identity refused.** The adapter did not acknowledge `gpt-5.6-sol` at
  `ultra`. Report and stop.
- **Effort inherited rather than set.** If the invocation did not name the
  effort, the answer may have come from `low` — see above. Treat an unverified
  effort as a refused identity, not as a minor omission.
- **Single voice returned.** Not a consultation.
- **Never reconstruct an outbox from terminal output.** That is attestation, and
  this plugin does not accept attestation. Resume the session (above) or report
  that there is no advice — those are the only two honest outcomes.
