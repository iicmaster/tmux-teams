---
name: codex-advisor
description: "Consult a Codex advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. Takes an optional model — $codex-advisor [luna|terra|sol] — and always runs at max reasoning effort, which this adapter reports and the dispatch verifies. Use when the user invokes $codex-advisor, wants a second opinion from outside the Claude family, or names a specific Codex seat. Read-only: it advises, it never edits."
---

# Codex Advisor

The sibling of `claude-advisor`, and the reason both exist: an advisor from the
same family as the asker shares its blind spots. This lane asks a different
vendor's model, so a disagreement between the two is worth something.

## Why it is an ACP lane

Same mechanism as `claude-advisor`, and here it is the only mechanism — Codex is
not a Claude model, so no agent frontmatter can select it. `ACP_MODEL` and
`ACP_REASONING_EFFORT` set the session for this dispatch through the standard
ACP `session/set_config_option` calls; `ACP_EXPECT_MODEL` /
`ACP_EXPECT_REASONING_EFFORT` make the adapter acknowledge the resulting
identity. When an explicit expectation is omitted, the selected value is also
the expectation. A missing option, rejected value, or mismatch fails the
dispatch before prompt delivery rather than answering from a cheaper seat.

## Arguments

```
$codex-advisor              # default seat: gpt-5.6-sol
$codex-advisor luna         # gpt-5.6-luna
$codex-advisor terra        # gpt-5.6-terra
$codex-advisor sol          # gpt-5.6-sol
```

| `<model>` | dispatches | effort |
|---|---|---|
| *(omitted)* | `gpt-5.6-sol` | `max` |
| `luna` | `gpt-5.6-luna` | `max` |
| `terra` | `gpt-5.6-terra` | `max` |
| `sol` | `gpt-5.6-sol` | `max` |

A bare short name is accepted and expanded; the full `gpt-5.6-*` id is what
reaches the adapter and what the receipt must show. Any other name is a usage
error — **do not pass a model through unrecognised**, because an unknown value
either fails the dispatch or silently seats something nobody chose.

## Effort is LOCKED at `max` — it is not an argument

The caller chooses the model. The caller does **not** choose the effort. Every
dispatch from this skill sets and verifies `max`, and a request to lower it is a
request for a different skill.

`max` is what this adapter has actually been observed reporting: the release
review lanes on 2026-08-08 recorded `effective_identity: gpt-5.6-terra[max]` and
`gpt-5.6-luna[max]` on their receipts.

**Note the deliberate divergence, so nobody "fixes" it by accident.**
`plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs` pins the codex REVIEW lane at
`reasoning_effort: 'ultra'`. That is a different lane with a different job and it
is not changed by this file. Two numbers that disagree on purpose need the reason
written down or someone will align them and call it tidying.

**Pass the model and effort explicitly; never inherit them.** On 2026-07-29
`~/.codex/config.toml` read `model_reasoning_effort = "low"` while
`party-mode/SKILL.md` asserted the default was already the top of the range.
Every dispatch that trusted that sentence ran at the bottom while the document
promised the top — the model was right in that file and the effort was not,
which is a discrepancy no reader could see. The adapter now selects both values
per dispatch and verifies the correlated session response rather than assuming a
machine default.

Never downgrade for cost or quota. If the requested seat at `max` is
unavailable, **report that and stop**; an answer from a lesser seat is not this
skill.

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

2. **Dispatch**, selecting and verifying the identity in one step. `<model>` is
   the expanded id — `gpt-5.6-sol` unless the caller named another:

   ```bash
   # The binary first, and ABSOLUTELY. `buildBuiltinProfile` refuses a
   # receipt-required Codex dispatch without an absolute CODEX_PATH and exits 2
   # before a session exists. This command omitted it until 2026-08-22 and could
   # not run as written on any machine — found by RUNNING it to dispatch a
   # review round, not by reading it. `agy-advisor` had the identical gap with
   # AGY_BIN and `claude-advisor` sets CLAUDE_CODE_EXECUTABLE, so this was the
   # last of the three, and it was the review of record.
   CODEX_PATH="$(realpath "$(command -v codex)" 2>/dev/null)"
   [ -n "$CODEX_PATH" ] || { echo 'no codex binary on this machine — stop'; exit 1; }

   INITIAL_AGENT_MODE="read-only" \
   CODEX_PATH="$CODEX_PATH" \
   ACP_SESSION_RECEIPT_REQUIRED=1 \
   ACP_SESSION_OPERATION="new" \
   ACP_MODEL="<model>" \
   ACP_REASONING_EFFORT="max" \
   ACP_EXPECT_MODEL="<model>" \
   ACP_EXPECT_REASONING_EFFORT="max" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     codex <cwd> <task-id> <brief-file> [stall-sec]
   ```

   **The first two lines are the read-only claim, and they were missing.** A
   release panel read this skill's own frontmatter — "Read-only: it advises, it
   never edits" — against the command below it and found nothing enforcing it:
   Codex children default to `INITIAL_AGENT_MODE=agent-full-access`, so the
   documented command launched a full-access advisor, and the brief was the only
   thing asking it to behave. `read-only` is one of the three modes the
   companion accepts, so this was an unenforced claim rather than an
   unenforceable one.

   And `ACP_SESSION_RECEIPT_REQUIRED=1`, because the default mode CONTINUES
   after a receipt-persistence failure with `receipt_digest: none` — so the
   identity this skill reports could rest on a receipt that was never written.
   **A consultation with no receipt is a failed consultation**; report it as one
   rather than reporting the identity it did not prove.

   **`acp-dispatch.mjs`, never `acp-companion.mjs` — and this is not a style
   preference.** The dispatcher puts the lane in its own process group and
   returns in seconds; the companion runs the lane in the FOREGROUND, so
   whatever cap the calling shell has becomes the lane's real deadline. On
   2026-08-17 that cost a finished review: `stall-sec` 1200 typed into a shell
   capped at 600, killed at exactly ten minutes with 461 protocol events
   recorded and the answer unwritten. Both numbers were typed by the same
   caller in the same command and nothing compared them.
   `tests/acp-dispatch.test.mjs` now refuses this file if it teaches the
   killable form.

   **Never set `ACP_CMD` on this lane.** The companion does not run `codex`
   directly: it launches a pinned `@agentclientprotocol/codex-acp` adapter whose
   entry point, digest and version it verifies first
   (`acp-companion.mjs` ~1104). `ACP_CMD` replaces that whole checked path with
   an unchecked one — and an earlier draft of this file did exactly that, which
   both discarded the integrity check and failed outright with
   `Error: stdin is not a terminal`, because bare `codex` opens a TUI rather
   than speaking ACP.

   The receipt should read `effective_identity: <model>[max]`,
   `identity_status: matched`. If the installed ACP agent does not advertise
   the requested model/effort, the adapter fails closed before the prompt.

3. **Arm a watcher, because the dispatch RETURNS while the lane runs.** That is
   the point of it, and it is also how a finished review sits unread. Run this
   in the BACKGROUND — killing the waiter does not touch the lane:

   ```bash
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     wait <cwd> <task-id> 3600
   ```

   It exits `0` when the outbox is written, `2` when there is no outbox and the
   lane will not produce one — the turn ended without writing, OR it stopped
   reporting without reaching a terminal state. Both are exit 2 and they need
   different responses, so read the liveness rather than the code: a lane that
   ENDED is a re-dispatch, a lane that went quiet may still hold a session worth
   resuming. This said only "the turn ENDED" until a lane reproduced the second
   case and got `{"exit":2,"terminated":false,"notReporting":true,"livenessState":"active"}`
   (resume — see Failure modes), and `1` when the wait budget ran out with the
   lane still going. Both terminal outcomes end the wait, on purpose: a watcher
   that looked only for an outbox would stay silent through a turn that wrote
   nothing, and silence reads exactly like still-running.

4. **Read the outbox.** No outbox file means no advice, whatever scrolled past
   in the terminal.

5. **Report identity with the advice** — the acknowledged model and effort beside
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

Two Codex seats are not two vendors. `luna`, `terra` and `sol` are one family; a
disagreement between them is worth reading but it is not the cross-vendor check
this section is about.

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
  node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
    status <cwd> <task-id>
  ```

  `status` prints the resume command with the session id already in it, so
  nobody digs that out of `.tmux-teams/` by hand — and with `ACP_PRIOR_DISPATCH_ID`
  and `ACP_PRIOR_RECEIPT_DIGEST` as visible placeholders, because status cannot
  know them. **It is not ready to paste, and the two words were doing damage.**
  This file used to call it ready-to-paste in one paragraph and explain nine
  lines further down that a receipt-required load needs lineage status has no
  way to supply. The code sided with the wrong paragraph: it emitted neither the
  receipt flag nor the operation, so a paste did not fail, it DOWNGRADED — the
  companion defaults `receiptRequired` to false, and the recovered consultation
  came back without the guarantee the original ran under. Found by a
  codex-advisor lane reading this skill against the function it describes.

  Fill the two placeholders from the failed run's receipt before running it.
  It looks like this, and the shape matters:

  ```bash
  INITIAL_AGENT_MODE="read-only" ACP_SESSION_RECEIPT_REQUIRED=1 \
  ACP_SESSION_OPERATION="load" \
  ACP_PRIOR_DISPATCH_ID="<dispatch-id from the failed run's receipt>" \
  ACP_PRIOR_RECEIPT_DIGEST="<receipt_digest from that run>" \
  ACP_RESUME="<session-id>" ACP_MODEL="<model>" ACP_REASONING_EFFORT="max" \
  ACP_EXPECT_MODEL="<model>" ACP_EXPECT_REASONING_EFFORT="max" \
  node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
    codex <cwd> <task-id> <recovery-prompt> [stall-sec]
  ```

  **A receipt-required LOAD needs its lineage, and the first version of this
  block had none of it.** `ACP_SESSION_OPERATION=load` plus the prior dispatch
  id and receipt digest are what bind the resumed turn to the run that failed;
  without them the companion refuses, and without the whole set the resume is
  not receipt-backed at all. Three panel families reported the fresh-dispatch
  half of this and one reported the resume half — all against a command block
  that had been "fixed" the day before by adding one variable and testing that
  the variable was PRESENT.

  Read the two values out of the failed run's receipt; `status` cannot supply
  them, which is stated here rather than left for a paste to discover.

  **Resume under the SAME task id.** The companion tells the worker to write
  `.mailbox-out/<task-id>` and then reads that exact path back, so a resume
  under a fresh id moves the outbox out from under the prompt the agent was
  already given. On 2026-08-17 a recovery ran as `<task>-recover` while its
  prompt still named `.mailbox-out/<task>`: the agent wrote a complete 22KB
  review and the companion reported `no_outbox`. `status` now lists anything
  else sitting in `.mailbox-out/` for exactly that reason — read those before
  paying for a re-dispatch.

  Resume the seat you dispatched. Recovering one session under a different
  model is a different agent reading someone else's lineage.

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
- **Identity refused.** The adapter did not acknowledge the requested model at
  `max`. Report and stop.
- **Unknown model name.** Anything outside `luna`, `terra`, `sol` is a usage
  error. Ask, do not guess — a name that reaches the adapter unchecked either
  fails the dispatch or seats a model nobody chose.
- **Effort inherited rather than set.** If the invocation did not name the
  effort, the answer may have come from `low` — see above. Treat an unverified
  effort as a refused identity, not as a minor omission.
- **Single voice returned.** Not a consultation.
- **Never reconstruct an outbox from terminal output.** That is attestation, and
  this plugin does not accept attestation. Resume the session (above) or report
  that there is no advice — those are the only two honest outcomes.
