# ADR 0009: One driver skill was never a layer, so it stops being one

## Status

Accepted — 2026-08-24, on Master's decision, after the room measured that the
split this repository believed it had was never honoured.

## Why this document exists

`skills/tmux-teams/SKILL.md` opened with an architecture claim:

> This skill owns the **generic protocol** … Tool-specific facts live in
> per-tool driver skills and are the source of truth for that tool:
> **codex → `codex-tmux-driver`**

A future reader would take that as a layering rule and file the next tool's
calibration into a new driver skill. That rule was never true, and following it
would have made the shape worse.

## What was measured

`tmux-teams` names four tools. Counted in its own `SKILL.md`, before this change:

| tool | mentions in `SKILL.md` | had a driver skill |
|---|---|---|
| codex | 30 | yes |
| claude-zai | 3 | no |
| opencode | 3 | no |
| claude | 12 | no |

So the "per-tool driver skills" were one skill, and the other three tools'
specifics — a 93-second `claude-zai` completion-detection miss, how `opencode`
reads `AGENTS.md`, window-name conventions — sat inline in the file that claimed
not to hold them. **An abstraction with one implementation, contradicted for
everything else it named.**

Its `SKILL.md` also still carried `metadata.scope: claude`, a leftover from the
`~/agent-skills` per-tool scope era where it was the first and only tool-scoped
skill. Nothing has used that field since the plugin took delivery over.

## What forced the question

Not a defect report. A person who owns this repository read a generated
inventory of the twelve shipped skills and said they had forgotten
`codex-tmux-driver` existed, and that a single-vendor entry looked out of place
beside eleven general ones.

That is the cost being paid: a skill nobody remembers is a skill nobody
invokes, and its content might as well not ship.

## The decision

**Collapse it into a reference under the skill it calibrates.**

- `skills/codex-tmux-driver/SKILL.md` → `skills/tmux-teams/references/codex-tmux.md`
- its nested `references/codex-cli-reference.md` moves beside it
- `SKILL.md`'s architecture claim is corrected to describe what is actually
  true: this skill owns the protocol AND the tool facts; codex has enough of
  them to earn a file; the other two tools stay inline
- `tmux-teams`'s own `description` absorbs the single-session triggers the
  driver used to carry ("delegating to a live Codex TUI", "babysitting a long
  run", "handling an approval prompt"), so a person wanting to drive ONE codex
  session still lands somewhere

Shipped skills go 12 → 11.

## The alternative that was rejected, and why

**Honour the split instead: extract `claude-zai` and `opencode` drivers too.**
It would make the stated rule true. It was rejected because it answers an
asymmetry by adding two more things to forget, when forgetting is the failure
already being paid for. Three tools' worth of calibration is a few dozen lines;
a skill is a permanent entry in every inventory, every README table, and every
person's memory.

## The argument against this decision, stated rather than omitted

`codex-tmux-driver` was genuinely person-facing. Its description told a reader
what it was for and drew a real line — "NOT for orchestrating many mixed agents
as PM (use tmux-teams)". A reference cannot be invoked by name, so that line now
lives inside a longer description and is easier to miss.

If a second tool ever grows codex-sized calibration, this decision should be
revisited — but as ONE deliberate move to per-tool drivers for every tool, not
by re-adding a single one and recreating exactly the shape this ADR removes.

## What this does not decide

Whether `references/codex-tmux.md`'s content is still accurate. It was
field-verified on codex-cli 0.144.1 in July 2026 and has not been re-measured
here; the move preserved its bytes below the new header.
