// fixture-gate.mjs — every history a test uses must be one the system could
// have produced.
//
// The reason this exists, in one line: two fixtures were found on 2026-07-29
// describing histories the runtime cannot write — a `reviewed` with nothing
// delivered, and an `escalated` stamped with the controller's own agent_id —
// and both had passed for as long as they existed. A test fed an impossible
// history is not testing this system. It is testing a system nobody built.
//
// The deeper problem is that the author of a test and the author of the code
// share one mental model, so a fixture wrong in the same direction as the code
// keeps the suite green. The fix is not more care. It is to stop letting the
// author be the oracle: `ledger-validate.mjs` is the runtime's own judgement,
// so routing fixtures through it makes the check independent of whoever wrote
// them.
//
// A test that deliberately builds a broken history — the validator's own — passes
// `{ expectInvalid: true, why }`. That escape is loud on purpose: it belongs in
// review, not in inference.
import { validateLedger } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'

/**
 * @param {string} workItem token name, only so a failure is findable
 * @param {object[]} entries custody events in the order they were appended
 * @param {{expectInvalid?: boolean, why?: string}} [options]
 * @returns {object[]} the same entries, so this can wrap a fixture inline
 */
export function gateHistory(workItem, entries, options = {}) {
  if (options.expectInvalid) {
    if (!options.why) {
      throw new Error(`fixture ${workItem}: expectInvalid must state why — an unexplained escape is how this gate turns into decoration`)
    }
    return entries
  }
  const { ok, problems } = validateLedger(entries.map((entry) => JSON.stringify(entry)))
  if (ok) return entries
  // Every problem, not the first: a fixture is repaired once, and being told one
  // defect at a time turns that into a guessing game against a file the author
  // is about to rewrite anyway.
  const detail = problems
    .map((problem) => `    line ${problem.line}  ${problem.code}  ${problem.detail}`)
    .join('\n')
  throw new Error(
    `fixture "${workItem}" is a history this system cannot produce (${problems.length} problem(s)):\n${detail}\n`
    + '  Fix the fixture, or pass { expectInvalid: true, why: "..." } when the test is about invalid input.',
  )
}
