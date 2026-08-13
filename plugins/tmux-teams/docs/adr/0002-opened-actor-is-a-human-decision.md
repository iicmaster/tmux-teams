# ADR 0002: `opened.actor` names who DECIDED, and that is always a person

## Status

Accepted

## Context

`admit.mjs`'s doc comment has said, since the front door existed, that
`options.actor` must be `human:<name>` even when an agent relays the request
on a person's behalf — "the actor names who DECIDED, and the person decided
(ข้อ 6.4.1)". Nothing enforced it. `EVENT_SPEC.opened` in `ledger-validate.mjs`
carried no `actor_kind`, so `appendEvent`/`validateLedger` accepted
`actor: 'human:master'`, `actor: 'agent:reopen-controller'`, `actor:
'agent:literally-anything'`, and an absent actor equally. The contract
(ข้อ 4.7) already enforces this exact rule for `opened`'s sibling event,
`answered`: "the only event whose actor KIND is part of its validity... An
operator agent may relay the words and then names itself in `relayed_by` —
the actor says who DECIDED." `opened` never got the same treatment, and
`intake-stats.mjs` reads the opening actor as the requester — a field three
different readers already treat as meaningful, none of them checked.

This surfaced in a retroactive review (`retro-release-review`, finding F3) as
a live inconsistency: the truthful relay shape
`{actor: 'agent:operator', answered_by: 'human:alice'}` was REJECTED on
`answered` by the rule that already existed, while the exact same
under-specification on `opened` accepted anything. It matters now because a
separately-designed reopen mechanism would be the first machine writer of
`opened`, and needs to know what the field means before it writes a line.

Three readings were on the table:

1. **`opened.actor` must be `human:<id>`** (matching `answered`), with an
   agent that relays naming itself in `relayed_by` instead of the person.
2. **Delete the claim.** `admit.mjs`'s doc comment describes a rule nothing
   enforces; make the code match the comment by removing the comment, and
   treat `actor` on `opened` as "whoever wrote the bytes" like most other
   events (ข้อ 4.1's general rule).
3. **Split the facts.** Keep a writer identity (`actor: 'agent:operator'`)
   separate from an independently meaningful, authenticated decision
   principal (e.g. `human_principal: 'human:alice'` plus an immutable
   `source_ref`), so "who wrote this line" and "who is on record as having
   decided" are never the same field.

## Decision

**Option 1.** `EVENT_SPEC.opened` gains `actor_kind: 'human'`, identically to
`answered`. `admit.mjs` and `ledger-writer.mjs`'s generic writer both refuse
an `opened` whose `actor` does not start with `human:`. An agent relaying a
person's request names itself in the optional `relayed_by: agent:<id>`
field — already documented for `answered`, now shape-validated
(`bad_relayed_by`) for any event that carries it, not only `opened` and
`answered`.

This is a deliberate, intentionally-breaking exception to ข้อ 4.1's general rule
("the actor is the component that performed the write, never the agent the
line is about"). `opened` and `answered` are the two events whose SUBJECT is
a person's decision rather than a mechanical step the runner or a companion
performed, and the contract already carved that exception out for `answered`
— this ADR extends it to the other row that always needed it.

### Why not option 2 (delete the claim)

Deleting the comment is honest about what the code did, but it throws away a
real distinction the rest of the system already depends on: `intake-stats.mjs`
reads the opening actor as the requester, the board and the audit treat a
person's admission differently from an agent's own initiative, and — most
concretely — `answered` already proves the codebase considers this
distinction worth enforcing at the validator, not just documenting. Weakening
`opened` to match its unenforced state would create a NEW inconsistency
(`opened` lax, `answered` strict) where today there is an accidental one that
is at least fixable by enforcing the stated rule rather than retracting it.

### Why not option 3 (split identity now)

The split is more honest about provenance: `actor: 'human:alice'` on a
caller-supplied event proves shape, not authentication, and a generic writer
call can self-label as a human today exactly as it always could. That
residual is real and this ADR does not close it — see Consequences. But
`opened` has exactly one production writer (`admit.mjs`) and no existing
ledger lines carry a second identity field for it; inventing `human_principal`
/ `source_ref` now is a bigger, unforced schema change with no second writer
yet to justify it, and it does not change today's actual attack surface
(the generic writer already accepts a caller-supplied `actor` for every
event, `opened` included, under option 1 exactly as under option 3 — the
difference is only where the honest-but-unauthenticated identity sits).
Reusing the actor/`relayed_by` pair that `answered` already established is
the smaller, symmetric move, and it does not foreclose a future split: a
machine-decided opener that genuinely is not relaying a person still needs
its own event or an explicit machine-origin field either way, under any of
the three options.

## Consequences

- `opened` written with a non-`human:` actor, or no actor, is refused —
  by `appendEvent` (before it reaches disk) and by `validateLedger` (for any
  ledger read, including ones assembled by hand or by a future producer that
  bypasses `admit.mjs`).
- Every existing fixture across the test suite that constructs an `opened`
  event without an explicit human actor needs updating. This is confirmed to
  affect at minimum `tests/kanban.test.mjs`, `tests/kanban-board.test.mjs`,
  and `tests/graph.test.mjs` in addition to this package's own
  `tests/ledger.test.mjs` and `tests/loop-occupancy.test.mjs` — all five were
  patched in this change; the first three were not executed as part of this
  package. *(This line cited `HANDOFF-PATCH.md` until 2026-08-05. No such file
  has ever been committed to this repository — the reference was dead from the
  day it was written, which is worth stating rather than deleting: a reader who
  went looking for it lost time to a citation that never existed. All five
  files run in the suite today.)*
- **`actor: 'human:<id>'` proves syntax, not authority** — this ADR does not
  add authentication. A generic caller of `ledger-writer.appendEvent` (or the
  `ledger-writer.mjs` CLI) can still supply any shape-valid `human:*` string
  it likes; nothing here verifies the writing process actually represents
  that person. This is the same limitation `answered` has always carried, not
  a new one. Closing it needs a real principal/credential concept, which is
  future work, not this ADR.
- A future MACHINE-decided opener (autonomous retry/reopen policy, not
  relaying a person) is explicitly NOT authorized to write `opened` with a
  forged `human:*` actor under this decision. It needs its own event name or
  an explicit machine-origin field before it ships; this ADR settles what
  `opened.actor` means so that design has an answer, not the design itself.

## Alternatives considered

- Deleting the unenforced doc comment (option 2 above): rejected — see
  "Why not option 2".
- Splitting recorder/relay identity from an authenticated decision principal
  now (option 3 above): rejected for `opened` specifically, at this time —
  see "Why not option 3". Not rejected in principle; a real authentication
  layer for either `opened` or `answered` is legitimate future work this ADR
  does not block.
