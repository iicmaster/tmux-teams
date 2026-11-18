# ADR 0009: The handoff carries a size budget, and says where the overflow goes

## Status

Accepted — 2026-10-30, on Master's instruction, after measuring what the
"overwritten in place, not appended" rule actually produced.

## Why this document exists

The `handoff` skill has always said HANDOFF.md is overwritten, not appended.
A future reader who finds a 32 KiB budget, a rotation step and a
one-owner-one-block rule in that skill is owed the measurement that put them
there, because to a reader who has only ever seen small files this looks
like bureaucracy. It is not. This is what happened without it.

## Context — measured, not recalled

Measured 2026-10-30, in a multi-agent project with eight role-lanes —
[MD] [DBA] [HRM] [INV] [AUTHZ] [ACCT] [FIN] [DOCS]:

- **2,052,245 bytes / 4,514 lines** — a ~454 byte-per-line average, which is
  prose density, not data: each lane was appending a full pre-compaction
  state dump.
- Each lane's new block **claimed to supersede its old one while physically
  leaving it in place**. Eight owners, eight growing histories, one file.
- An archive-once attempt on 2026-10-11 moved 1.7 MB to `docs/history/` —
  and the live file regrew to 2 MB by 2026-10-29, because writer behaviour
  never changed. Moving the bytes once is not a mechanism; the writers are.

The root cause is in the skill, not the writers: it said "overwrite, not
append" and carried no size budget, no rotation step, and no rule for a file
shared by several owners. An instruction with no ceiling is read as a
preference.

## Decision

**The handoff skill carries a built-in size-management system:**

- **32 KiB target, 48 KiB hard ceiling.** A file over the ceiling is never
  written; the writer measures with `wc -c HANDOFF.md` before composing and
  again after writing.
- **Rotation over ceiling-sitting.** When the existing file or the new draft
  passes 32 KiB, superseded detail moves to
  `docs/history/handoff-archive-YYYYMMDD.md` — that date's file, appended,
  created if absent — and exactly one pointer line stays where the detail
  came from.
- **One owner, one block.** Each owner sharing a HANDOFF.md keeps at most
  one block per section, and writing the new version physically deletes the
  previous one. An owner never touches another owner's block; a full
  pre-compaction dump goes to the owner's own sidecar
  (`.pm/<owner>/HANDOFF-YYYYMMDD-HHMM.md`, or wherever the project already
  keeps per-owner state) with one pointer line in the handoff.
- **A reader guard.** A session opening a HANDOFF.md over the ceiling does
  not read it whole: the first 2 KiB of section 1 and the headers, then
  "compact the handoff" goes in front of the user as the first order of
  business.
- **READ THIS FIRST capped at ten lines and 2 KiB.** The ten-line rule the
  skill already stated failed the moment lines ran a thousand bytes; both
  limits are hard.

Archives are cold storage, never read whole; a pointer is followed only when
that detail is actually needed. State that lives in a system of record — a
board, a registry, a ticket file — is referenced by path and row/id, never
copied in: a copy is a second source of truth with no owner.

## Consequences

- **The room gets the budget as a fact of its brief.** A handoff is composed
  in a room, and the room now argues inside the stated budget — the current
  `wc -c` figure and the 32 KiB target — so what cannot justify its bytes
  rotates rather than staying because nobody was counting.
- **Inheriting sessions are told to compact rather than swallow.** A session
  that swallows 2 MB of superseded state pays for every block it will never
  act on; the guard makes compaction the user's first decision instead.
- **The "Before you finish" list closes the loop.** The writer reports the
  `wc -c` result, refuses to call the file done above 48 KiB (target 32),
  checks that every archive pointer resolves to a file that exists, and
  greps its own tag to prove its previous blocks are physically gone.
- **The failure this answers is measured, not hypothetical.** The 2 MB file
  grew back from a 1.7 MB archive in under three weeks; the budget binds
  every write, which is the only thing that has not been tried.

## What would reverse this

- A measured cost of rotation that exceeds the cost of size: sessions
  following pointer lines into archives more often than the ceiling saves
  them. Nothing measured suggests this; the 454 byte-per-line average was
  superseded prose, not referenced state.
- An owner ruling that their project's handoffs are intentionally archival.
  The budget lives in the skill, so that ruling would have to be recorded
  against this ADR rather than made quietly.
- A tracked HANDOFF.md found over the ceiling again — writers ignoring a
  prose ceiling is the exact failure this answers; if it recurs, the tooling
  exclusion reverses and the ceiling becomes a mechanical check.

## The strongest argument against this decision

A ceiling taxes every write for a failure that has been measured once. It
can also push load-bearing detail out of the file and into an archive the
next session must choose to follow — two hops where there was one — and a
handoff the reader does not trust enough to follow a pointer from has been
made worse, not better. And the numbers are reader-cost numbers, not
sufficiency numbers: nothing measures that 32 KiB is enough for a handoff
at this complexity, only that 2 MB was far too much.

That argument is on the record because the cost is real and every writer
from here on pays it. The decision goes the other way because the one
measured failure was not a writer short on room — it was eight writers with
no ceiling at all.

## Out of scope

- Any change to the handoff's section order or the room ladder. This
  decision adds a budget, a byte cap, and ownership rules to the existing
  skill; it does not rewrite it.
- Tooling to enforce the ceiling. The measure is `wc -c` and the proof is a
  grep, both of which a session already runs; a script would add a surface
  for a rule a writer can keep with two commands.
