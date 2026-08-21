---
name: pm-delegation
description: "The contract for handing bounded work to an implementer and getting back something a verifier can check — what a brief must carry, what an implementer may not do, what counts as evidence, and when to STOP instead of continuing. Use when dispatching work to subagents or another agent, when writing a brief, when deciding whether a returned result is acceptable, or when work has hit something a person must answer. ใช้เมื่อสั่งงาน subagent, เขียน brief, ตรวจงานที่ส่งกลับ, หรือเจอสิ่งที่คนต้องตัดสิน. Invoked by implement-spec for every ticket it dispatches. Do not use to write the code yourself; this is the contract, not the work."
---

# PM delegation

The contract between whoever is holding the work and whoever is doing a piece of
it. `implement-spec` runs this for every ticket it dispatches; you can also run
it by hand for a single delegation.

It is a contract and not a procedure. Nothing here says how to implement
anything — it says what has to be true about the handing over and the handing
back, because that is where delegated work fails.

## The brief

A brief that does not carry all five of these is not ready to send.

1. **One bounded outcome.** Not a theme. "Add the layout test" is a brief;
   "improve the plugin structure" is a wish. If you cannot say what would make
   it done, the ticket is not ready and splitting it is the work.
2. **The acceptance, in the form it will be checked.** Name the command and the
   observable result — the focused test file for this ticket, and the count it
   must reach. An implementer who does not know how the work is judged will
   optimise for looking finished.
3. **Where the facts are.** Point at files, prior commits, an ADR — a **pointer,
   not a copy**. Copied context goes stale between the brief being written and
   read, and a stale copy is more dangerous than an absent one because it looks
   authoritative.
4. **The blast radius.** Which files this delegation may touch, stated as a list.
   Everything else is off limits and saying so is not an insult — two agents
   editing one file is how a wave loses work.
5. **What to do when blocked.** Every brief names the STOP condition. See below.

## What an implementer may not do

- **Not touch a file outside its stated radius.** Including "just to check".
- **Not run the full suite** when a caller is serialising measurement. One pass
  spawns dozens of subprocesses; several at once measure the contention rather
  than the code. Run the focused file; let the caller run the whole thing once.
- **Not `git checkout` to undo an experiment.** It restores the committed
  version and eats uncommitted work. Copy the file aside first, restore from the
  copy, and read it back afterwards.
- **Not report a number it did not measure.** "The tests pass" is a claim;
  `24 pass / 0 fail` is a measurement. If it was not run, say it was not run.
- **Not decide something the brief did not delegate.** A design question that
  surfaces mid-work goes back, it does not get answered quietly.

## STOP, and why it is not failure

An implementer that hits something only a person can settle must **stop and say
so**, with what it found and what it needs. It must not:

- pick the interpretation that lets it keep going,
- widen its radius to work around the obstacle,
- or deliver something adjacent and describe it as the thing asked for.

A stop that arrives early is cheap. A stop discovered at review is a wasted
delegation, and one discovered after a merge is a defect with a story attached.

**The caller must not answer a STOP by re-dispatching the same brief.** The
answer is a decision, a widened radius, or a different ticket. Sending the same
question back gets the same answer and spends another delegation to hear it.

## What comes back

A result is three things, and it is incomplete without all three.

- **What changed**, as files and the reason each one was touched.
- **The measurement**, verbatim — the command, and its output. Not a summary of
  the output.
- **What is NOT done**, said plainly. Anything skipped, anything guessed at,
  anything the implementer could not verify. A report with nothing in this
  section is not a clean result, it is an unexamined one.

## Evidence, and what does not count as it

- A green test is evidence the test passed. It is evidence the CODE is guarded
  only if the test would go RED without it. If a guard was added, the way to
  know it guards anything is to remove the thing it guards and watch the count
  move.
- A source grep proves somebody typed a string. Running the command proves the
  command works.
- "Non-empty" is not an acceptance criterion. A diagnostic that returns
  something is not a diagnostic that returns the right thing, and a confidently
  wrong sentence sends the reader further astray than an empty one.

## Redaction and provenance

- **A brief may carry secrets; a report may not.** Credential VALUES never appear
  in a result, a log, or a summary. Field NAMES may, and often must — an
  operator who is not told which variable was missing cannot fix it.
- **Say which agent produced what.** When a result is relayed onward, the relay
  says whose work it is relaying. Work that arrives without provenance gets
  believed on the strength of whoever is speaking last.
- **A result read from a transcript is not a result.** If the deliverable was
  supposed to be written to a file and the file is absent, the delegation
  produced nothing, whatever scrolled past on the way.

## Approval

Some things are not the implementer's to do even inside its radius: pushing to a
remote, opening or closing anything outward-facing, deleting what it did not
create, or spending a budget the caller owns. Those come back as a request, and
the caller decides.
