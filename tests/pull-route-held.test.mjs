// pull-route-held.test.mjs — GitHub #42/#44: the planner proposes a pull the
// writer always refuses.
//
// `planPulls` used to pick the next hop from route position alone
// (`workflow.route[index + 1]`), never consulting which teams the token has
// already been ADMITTED by. On an escalation exit — parked at a later team,
// resumed, and released there — the declared route can point back at a team
// the token passed through earlier, and the validator's own
// `route_went_backwards` refusal (contract §1, §4.2) then refuses that exact
// `pulled` forever: `tick()` recomputes the identical decision every loop
// with no exit in code.
//
// The fixture below is the synthetic shape the issue named: a token opens
// into team B first, gets admitted there, is handed on to team A (out of the
// route's declared order), hits trouble at A, escalates, resumes AT A (the
// same team it escalated from — `resumed.to_team` always equals the team it
// is already sitting at, contract §1), and finally passes review at A. The
// declared route lists A before B, so the naive `route[index + 1]` points
// straight back at B — a team this token was already admitted by.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyPulls, planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { validateLedgerTolerant } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'
import { ledgerPath } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { gateHistory } from './fixture-gate.mjs'

const MODELS = { dispatcher: 'test-model', worker: 'test-model', evaluator: 'test-model' }

// Three real teams. `outer_controller_id` ('pm') is not a worker on any of
// them, so `controller_team` stays null (references/controller-as-team.md is
// opt-in) — this fixture is about an ordinary escalation exit, not the
// controller-as-team admission path, and staying opted out keeps it that way.
const graphResult = validateWorkflowGraph({
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'test-model',
  teams: [
    { team_id: 'A', name: 'Alpha', dispatcher_id: 'a_d', worker_ids: ['a_w'], evaluator_id: 'a_e', models: MODELS },
    { team_id: 'B', name: 'Beta', dispatcher_id: 'b_d', worker_ids: ['b_w'], evaluator_id: 'b_e', models: MODELS },
    { team_id: 'C', name: 'Gamma', dispatcher_id: 'c_d', worker_ids: ['c_w'], evaluator_id: 'c_e', models: MODELS },
  ],
  // Two workflows over the same teams, so one fixture ledger can be judged
  // against either declared route: the two-team route exercises "nothing
  // left after skipping the held team" (`completed`), and the three-team
  // route exercises "skip the held team, pull the one never held" (`C`).
  workflows: [
    { workflow_id: 'two_leg', name: 'Two Leg', route: ['A', 'B'] },
    { workflow_id: 'three_leg', name: 'Three Leg', route: ['A', 'B', 'C'] },
  ],
})
if (!graphResult.ok) throw new Error(`test graph fixture is invalid: ${graphResult.reason}`)
const GRAPH = graphResult.value

// The shared story: opened into B, admitted at B, handed to A (skipping the
// route's declared order on purpose — that is how B ends up ADMITTED before
// A, even though A precedes B in the declared route), a failed leg at A,
// escalated and resumed AT A (never at B — `resumed.to_team` is always the
// team already holding the token, contract §1; loop-runner.mjs:765 stamps it
// from `last.to_team`), then A's own worker and evaluator finish and pass.
const story = (workItem, workflow) => gateHistory(workItem, [
  { at: '2026-08-05T09:00:00.000Z', event: 'opened', work_item: workItem, workflow, agent_id: 'b_d', to_team: 'B', reason: 'front door request', actor: 'human:ada' },
  { at: '2026-08-05T09:00:01.000Z', event: 'intake', work_item: workItem, workflow, agent_id: 'b_d', verdict: 'accept', reason: 'workable' },
  { at: '2026-08-05T09:00:02.000Z', event: 'pulled', work_item: workItem, workflow, agent_id: 'a_d', from_team: 'B', to_team: 'A' },
  { at: '2026-08-05T09:00:03.000Z', event: 'intake', work_item: workItem, workflow, agent_id: 'a_d', verdict: 'accept', reason: 'workable' },
  { at: '2026-08-05T09:00:04.000Z', event: 'assigned', work_item: workItem, workflow, agent_id: 'a_w', task_id: 'a-1', dispatch_id: 'a-1-d' },
  { at: '2026-08-05T09:00:05.000Z', event: 'delivered', work_item: workItem, workflow, agent_id: 'a_w', task_id: 'a-1', terminal: 'protocol-error', timed_out: false, evidence_present: false },
  { at: '2026-08-05T09:00:06.000Z', event: 'escalated', work_item: workItem, workflow, agent_id: 'pm', to_team: 'A', task_id: 'esc-1', reason: 'worker leg failed' },
  { at: '2026-08-05T09:00:07.000Z', event: 'resumed', work_item: workItem, workflow, agent_id: 'pm', to_team: 'A', grant: 3, reason: 'transport issue, resume' },
  { at: '2026-08-05T09:00:08.000Z', event: 'assigned', work_item: workItem, workflow, agent_id: 'a_w', task_id: 'a-2', dispatch_id: 'a-2-d' },
  { at: '2026-08-05T09:00:09.000Z', event: 'delivered', work_item: workItem, workflow, agent_id: 'a_w', task_id: 'a-2', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-08-05T09:00:10.000Z', event: 'assigned', work_item: workItem, workflow, agent_id: 'a_e', task_id: 'a-2-review', dispatch_id: 'a-2-review-d' },
  { at: '2026-08-05T09:00:11.000Z', event: 'delivered', work_item: workItem, workflow, agent_id: 'a_e', task_id: 'a-2-review', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-08-05T09:00:12.000Z', event: 'reviewed', work_item: workItem, workflow, agent_id: 'a_e', verdict: 'pass', reviewed_task: 'a-2', reason: 'looks right' },
])

const itemOf = (workItem, workflow, custody) => ({
  work_item: workItem, workflow, custody,
  current_event: custody[custody.length - 1].event,
  terminal: custody[custody.length - 1].terminal || '',
  legs: custody.filter((entry) => entry.event === 'assigned').length,
})

// No decision from ANY of these tests may ever propose a pull into a team
// already in the token's held set — this is the literal acceptance
// criterion, asserted the same way regardless of which route was declared.
const assertNoPullIntoHeld = (decisions, held) => {
  for (const decision of decisions) {
    if (decision.action === 'pull') {
      assert.ok(!held.has(decision.to_team),
        `planPulls proposed pulling ${decision.work_item} into ${decision.to_team}, which it was already admitted by`)
    }
  }
}

test('sanity: the story validates clean and B is held before A finishes', () => {
  const custody = story('sanity', 'two_leg')
  const verdict = validateLedgerTolerant(custody.map((entry) => JSON.stringify(entry)))
  assert.deepEqual(verdict.blocking, [])
  assert.equal(verdict.ok, true)
  assert.deepEqual([...verdict.heldTeams].sort(), ['A', 'B'])
})

test('an escalation exit whose route has nothing left after the held team completes the token', () => {
  const custody = story('tok-complete', 'two_leg')
  const items = new Map([['tok-complete', itemOf('tok-complete', 'two_leg', custody)]])
  const decisions = planPulls(GRAPH, items, '2026-08-05T09:05:00.000Z')

  assertNoPullIntoHeld(decisions, new Set(['A', 'B']))
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].action, 'complete',
    `expected the route to finish once B is skipped as already held, got ${JSON.stringify(decisions[0])}`)
  assert.equal(decisions[0].event.event, 'completed')
  assert.equal(decisions[0].event.from_team, 'A')

  // §7: the token must visibly become something. `applyPulls` must write the
  // `completed` event and refuse nothing.
  const dir = mkdtempSync(join(tmpdir(), 'pull-route-held-complete-'))
  try {
    mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
    writeFileSync(ledgerPath(dir, 'tok-complete'), `${custody.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    const refusals = []
    const written = applyPulls(dir, decisions, (decision, result) => refusals.push({ decision, result }))
    assert.deepEqual(refusals, [])
    assert.equal(written, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an escalation exit whose route still has an unheld team skips ahead to it', () => {
  const custody = story('tok-skip', 'three_leg')
  const items = new Map([['tok-skip', itemOf('tok-skip', 'three_leg', custody)]])
  const decisions = planPulls(GRAPH, items, '2026-08-05T09:05:00.000Z')

  assertNoPullIntoHeld(decisions, new Set(['A', 'B']))
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].action, 'pull',
    `expected a pull skipping past B to C, got ${JSON.stringify(decisions[0])}`)
  assert.equal(decisions[0].from_team, 'A')
  assert.equal(decisions[0].to_team, 'C', 'B is already held; the fix must skip it, not stop at it or pick it')

  const dir = mkdtempSync(join(tmpdir(), 'pull-route-held-skip-'))
  try {
    mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
    writeFileSync(ledgerPath(dir, 'tok-skip'), `${custody.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    const refusals = []
    const written = applyPulls(dir, decisions, (decision, result) => refusals.push({ decision, result }))
    assert.deepEqual(refusals, [])
    assert.equal(written, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
