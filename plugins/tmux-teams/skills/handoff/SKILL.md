---
name: handoff
description: "Write or refresh HANDOFF.md at the project root — the state of play between sessions, composed for an AI agent to act on rather than for a person to skim. Use when the user invokes /handoff, says hand off, write the handoff, save state before compaction, or asks what the next session needs to know. ใช้เมื่อ Master สั่ง /handoff, ส่งงานต่อ, เขียน HANDOFF, หรือถามว่าเซสชันถัดไปต้องรู้อะไร. Runs through party-mode so the room argues about what belongs before anything is written. Do not use to write release notes, a changelog, a commit message, or documentation for humans."
---

# Handoff

Write `HANDOFF.md` at the **project root** — not in `docs/`, not dated in a
filename. One file, overwritten in place, so a fresh clone gets exactly one
answer to "what is going on here".

Its reader is the next AI agent, which changes what belongs in it.

## Run it through the room

Invoke `party-mode` first and compose the handoff there. A handoff written by
one voice inherits that voice's blind spots, and the blind spot is always the
same one: the author knows why a line matters, so the line does not say why.
Let the room fight about what earns its place before a byte is written.

If `party-mode` is unavailable, say so and write it solo rather than stalling —
a handoff that exists beats a handoff that was going to be excellent.

## What changes when the reader is an agent

A person skims, gets bored, and stops. An agent **does what the file says**, in
order, without getting bored. That cuts both ways:

- A hedge is read as an instruction. "We should probably look at X" sends the
  next session to X.
- An unverified claim is indistinguishable from a measured one. It will act on
  both with equal confidence.
- Anything you did not pin down, it re-derives — burning the tokens and the
  wall-clock you already spent, and often reaching a different answer.

So: **no hedges, mark every claim's status, and pin every reference.**

## The sections, in this order

Order is load-bearing: an agent reads top-down and may act before finishing.

**1. READ THIS FIRST** — ten lines, hard limit. Branch and whether it is pushed.
Whether the tree is clean. The single most dangerous thing about the current
state. If there is nothing dangerous, say that in those words.

**2. HOW TO VERIFY** — the exact commands, verbatim, copy-pasteable, and what
their green output looks like. Not "run the tests" — the command, the expected
counts, and any gate that is not what it appears (a `grep` that exits 0 when it
*finds* failures belongs here, loudly).

**3. STATE** — what shipped and what is open. Every entry carries `file:line`.
"The graph reader" costs the next agent a grep; `graph.mjs:279` costs nothing.
Never name a file without its path, never a function without its file.

**4. DO NOT** — the highest-value section, and the one most often missing.
Every approach that was tried and rejected, **with the measurement that
rejected it**. Not "we decided against X" — "X was tried; it turned four tests
in two files red, because an evaluator does not always have an `assigned` of
its own." Without the because, the next agent re-derives it. With it, they
skip a whole afternoon.

**5. DECIDED — DO NOT RELITIGATE** — decisions that are closed, and who closed
them. A decision the user made outranks a decision the room made; say which it
was. This section is what stops a fresh session reopening an argument that was
already paid for.

**6. UNPROVEN** — every claim in this file that rests on reading rather than
execution. Be specific and be generous with it. A handoff that lists nothing
here is lying, and the next agent will discover which line was the lie by
building on it.

**7. WHERE THINGS LIVE** — a locator block. The contract or spec that is the
single source of truth, the test that guards each area, config and state paths.
Paths only, no prose.

## Rules for the prose itself

- **State, not chronology.** Nobody needs the morning. Cut every sentence whose
  job is transition.
- **A claim, its evidence, its status.** Three things or it does not go in.
  Status is one of: measured (say what was run), read (say what was read), or
  assumed (say why the assumption was necessary).
- **Commands are commands.** Write the bytes to run, never a description of
  them.
- **Numbers over adjectives.** "The suite is slow" is unusable; "the full suite
  is ~120s and the fast tier is ~2s, a 50x difference" changes behaviour.
- **Name the file that will bite.** If a change in one place silently requires a
  change in another, that pairing is a section, not a footnote.
- **Record the mistakes, especially the embarrassing ones.** A session that
  committed on red twice should say so with the reason — that is a live trap,
  not a confession. The next agent walks into traps, not into successes.
- **Delete what is no longer true.** This file is overwritten, not appended.
  A stale warning costs more than a missing one because it is obeyed.

## Before you finish

- Re-read the file as if you had never seen this project. Every unexplained
  noun is a bug.
- Check that every `file:line` still resolves — line numbers rot, and a wrong
  one sends the reader somewhere confidently incorrect.
- If the repo tracks `HANDOFF.md`, commit it. A handoff only one machine can
  read is a handoff to nobody.
