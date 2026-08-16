---
name: claude-advisor
description: "Consult a Claude-protocol advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. Defaults to the top Claude model (fable at the session's effort); optionally takes a routing pair — $claude-advisor <bin> <model> — to reach k3, qwen3.8-max, deepseek or glm through a routed profile. Use when the user invokes $claude-advisor, asks for a second opinion, or names a specific advisor seat. Read-only: it advises, it never edits."
---

# Claude Advisor

A consultation lane. It asks a Claude-protocol seat a question, returns a
round-table, and **can prove which model answered**.

## What this skill actually guarantees

Not "the most expensive model". **Provable identity.** The default seat is the
top Claude model; a caller may name a different one, and the receipt still has
to say who answered. A silent downgrade is the failure this lane exists to stop
— a *declared* choice of seat is not one.

## Why it is an ACP lane and not a subagent

A skill cannot pin a model: skill frontmatter is `name` and `description`. An
agent can (`model:` frontmatter), but nothing then verifies the request was
honoured, and per-agent reasoning effort is not expressible at all.

The ACP companion does both. `ACP_EXPECT_MODEL` makes the adapter
**acknowledge** its identity, and a mismatch fails the dispatch instead of
quietly answering from a cheaper seat. That is this plugin's
evidence-not-attestation rule turned on the advisor: *asking* for a model is not
the same fact as that model answering, and only one of the two is worth paying
for.

## Arguments

```
$claude-advisor                      # default seat: claude-fable-5
$claude-advisor <bin> <model>        # a routed seat
```

`<bin>` names the routed Claude wrapper; `<model>` is the Anthropic-protocol
alias the wrapper maps onto a vendor model. Both are required together — a bin
with no model, or a model with no bin, is a usage error, because the alias only
means something inside a profile.

### The seats, read off each profile's `settings.json` on 2026-08-09

| `<bin>` | `<model>` | answers as | endpoint |
|---|---|---|---|
| *(omitted)* | *(omitted)* | `claude-fable-5` | Anthropic |
| `claude-kimi` | `opus` | `k3` | `api.kimi.com` |
| `claude-kimi` | `sonnet` | `kimi-for-coding` | `api.kimi.com` |
| `claude-qwen` | `opus` | `qwen3.8-max` | Alibaba MaaS |
| `claude-qwen` | `sonnet` | `deepseek-v4-flash-0731` | Alibaba MaaS |
| `claude-zai` | `opus` | `glm-5.2[1m]` | `api.z.ai` |
| `claude-zai` | `sonnet` | `glm-5-turbo` | `api.z.ai` |

**An alias is not a family.** `opus` on three different bins reaches three
different vendors, and a receipt that records `effective_identity: opus` has told
you nothing about who answered — it names the alias the gateway was asked for.
The `<bin>` is the fact; the alias is a slot. When two lanes must be from
different families, prove it from the endpoint, never from the alias.

This table is read from the profiles, and the profiles can change under it. It is
the map, not the territory: `plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs` carries
the same mappings for the review lanes, where two were confirmed by asking the
running model for its own identifier rather than trusting the file
(`claude-qwen --model opus` → `qwen3.8-max-preview`, `--model sonnet` →
`deepseek-v4-flash-0731`, measured 2026-08-08 — note the served id is not
character-identical to the requested one). If a seat matters, ask it who it is.

### Two spellings, and which works depends on the machine

A routed seat is selected either by the wrapper binary or by the profile
directory that wrapper loads:

```bash
CLAUDE_CODE_EXECUTABLE="claude-qwen"                      # the wrapper
CLAUDE_CONFIG_DIR="$HOME/.config/claude-profiles/qwen"    # the profile it loads
```

Measured 2026-08-09 on the authoring machine: `~/.local/bin` holds `claude` and
**no `claude-*` wrapper at all**, while every profile directory exists. So the
wrapper form is unusable here and the config-dir form is what has actually been
run — a zai lane dispatched that way returned `identity_status: matched` the same
day. Check which exists before writing a command that assumes one:

```bash
command -v claude-qwen || ls -d "$HOME/.config/claude-profiles/qwen"
```

## The pinned default — still not negotiable

| | | |
|---|---|---|
| Model | `claude-fable-5` | **verified** — `ACP_EXPECT_MODEL`, `identity_status: matched` |
| Reasoning effort | session's | **not verifiable on this lane** — see below |
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
this file will not pretend otherwise.

`codex-advisor` **can** verify its effort, because the Codex adapter reports it.
That asymmetry is real and is not smoothed over.

Never downgrade for cost, quota or speed **on your own initiative**. If the
caller named no seat and the default is unavailable, **report that and stop** —
do not substitute. A cheaper answer is not a cheaper version of this skill; it
is a different skill wearing its name.

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

2. **Dispatch** through `acp-dispatch.mjs`, which detaches the lane into its own
   process group and returns in seconds. Running `acp-companion.mjs` directly
   puts the lane in the FOREGROUND, where the calling shell's cap silently
   becomes the lane's deadline — on 2026-08-17 that killed a finished review at
   ten minutes with 461 protocol events recorded. `tests/acp-dispatch.test.mjs`
   refuses this file if it teaches the killable form. Default seat:

   ```bash
   ANTHROPIC_MODEL="claude-fable-5" \
   ACP_EXPECT_MODEL="claude-fable-5" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     claude <cwd> <task-id> <brief-file> [stall-sec]
   ```

   Routed seat — the config-dir form, which is the one verified on this machine:

   ```bash
   CLAUDE_CONFIG_DIR="$HOME/.config/claude-profiles/<profile>" \
   ACP_MODEL="<model>" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     claude <cwd> <task-id> <brief-file> [stall-sec]
   ```

   Do **not** set `ACP_CMD` — it bypasses the companion's own launch path. Do
   **not** set `ACP_EXPECT_REASONING_EFFORT`; it cannot be satisfied on this lane
   and fails every dispatch.

   `ACP_EXPECT_MODEL` on a routed seat can only expect the ALIAS, because that is
   what the adapter reports back. It proves the alias was honoured. It does not
   prove which vendor served it — the endpoint does that, and it is the caller's
   job to say so.

3. **Read the outbox.** No outbox file means no advice. A run that printed to
   the terminal and wrote nothing has produced no consultation, however good the
   text looked scrolling past — this has happened with a real model, whose
   answer was correct and landed nowhere a reader could find it.

4. **Report identity with the advice** — the acknowledged alias, the bin or
   profile, AND the endpoint it routes to. On a routed seat the alias alone is
   not provenance; that is the whole point of the table above.

## Read-only

This lane advises. It does not edit files, commit, push, or run anything that
changes state. If the consultation ends in work to be done, hand that to
`party-auto`; the advisor's job stops at the recommendation.

## Failure modes

- **Identity refused.** The adapter did not acknowledge the requested model.
  Report and stop — a rerun cannot change a declaration, and answering from
  whatever seat was free is the exact failure this skill was built against.
- **Bin named but absent.** `claude-qwen` does not exist on every machine. Fall
  back to the profile directory if it exists, and say which form you used; do
  not silently dispatch the default seat under the routed seat's name.
- **Single voice returned.** Not a consultation. Say so rather than presenting
  one opinion as a room.
- **Empty outbox (`no_outbox`). TRY RESUME first, and never reconstruct.**
  Reconstructing from terminal output is attestation and this plugin does not
  accept attestation. Resume is cheap and is the only path that could still hold
  the analysis, but it is unproven here: the one attempt on 2026-08-04 loaded
  without its prior lineage and answered `I have nothing`. Send a short prompt
  to the same session —
  `ACP_RESUME=<session-id>`, "you already read it, write what you have to
  `<path>`, do not redo the analysis" — which costs a few hundred tokens instead
  of the whole consultation. Ask it to answer "I have nothing" plainly if the
  context really is gone; a short honest refusal is worth more than a
  reconstruction.

  The id lives in the run cwd's `.tmux-teams/` (the companion's persisted
  session file), so **never `rm -rf` the run directory before recording it** —
  on 2026-08-04 three fresh runs were paid for on the sibling codex lane while
  a session holding the finished analysis sat on disk.
- **What produces an empty outbox is unexplained on the sibling codex lane**,
  where it recurred across 203KB, 203KB and 7KB briefs on one afternoon after a
  52KB brief had worked that morning. Size is not the variable. Putting large
  diffs on disk is worth doing anyway; do not expect it to prevent this.
- **Frictionless consensus.** Report it as a finding about the question, not as
  a strong answer.
