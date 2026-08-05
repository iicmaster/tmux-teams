// audit-transport-death.test.mjs — GitHub #52.
//
// The audit answer-deadline was the only reader a token at `audit_requested`
// had left, and it could see exactly one thing: whether the controller's leg
// was still alive. So a controller that read a delivery and sat silent for ten
// minutes, and a leg a provider's rate limit killed sixteen seconds in before
// the model ever got a turn, produced the same hard terminal — `abandoned`,
// §4.7, nothing may follow — and the same recorded reason, "no outer-controller
// audit answer in 10 minute(s)". For the second case that sentence is false:
// nobody failed to answer, because nobody was ever asked. Three finished tokens
// were destroyed that way on one quota-exhausted morning, one per deadline.
//
// §4.10 already invented the fact that settles it — `work_observed`, "did the
// model take a turn" — but wired it to the custody ledger, and the controller's
// own leg is spawned with `workItem: ''`, so the ledger write is a no-op for
// precisely the leg that needed it. The fix carries the same fact on the one
// channel that leg does write: its liveness snapshot.
//
// What must stay true is the reason the deadline exists at all. An audit that
// cannot be abandoned is an audit that can hang forever, which is the failure
// this branch was built to prevent — so the retry budget is checked FIRST and
// unconditionally, and every case that is not POSITIVE evidence of a dead
// transport still closes exactly as fast as it did before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planDispatches, planEscalation } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { gateHistory } from './fixture-gate.mjs'

const MODELS = { dispatcher: 'test-model', worker: 'test-model', evaluator: 'test-model' }
const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'test-model',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1'], evaluator_id: 'b_e', models: MODELS },
    { team_id: 'test', name: 'Test', dispatcher_id: 't_d', worker_ids: ['t_w1'], evaluator_id: 't_e', models: MODELS },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['build', 'test'] }],
}

const FIXED_NOW = Date.parse('2026-08-06T09:00:00.000Z')
const PAST_DEADLINE = FIXED_NOW + 1_000_000

const graphOf = () => {
  const result = validateWorkflowGraph(TWO_TEAMS)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

// Every history here is judged by the runtime's own validator before a test
// sees it, so `audit_lost` being a word the ledger accepts is not something
// this file asserts separately — a fixture using it could not be built at all
// if the vocabulary had not been extended.
const itemsOf = (custody) => {
  const history = gateHistory('tok', custody.map((event, index) => ({
    at: new Date(FIXED_NOW - (custody.length - 1 - index) * 60_000).toISOString(),
    work_item: 'tok', workflow: 'feature', ...event,
  })))
  return new Map([['tok', {
    work_item: 'tok', workflow: 'feature', custody: history,
    current_event: history[history.length - 1].event,
    terminal: history[history.length - 1].terminal || '',
    legs: history.filter((entry) => entry.event === 'assigned').length,
  }]])
}

// A token that ran its route and was handed to the controller to read.
const DELIVERED = [
  { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
  { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  { event: 'completed', from_team: 'build' },
]

const requested = (taskId = 'pm-1') => (
  { event: 'audit_requested', agent_id: 'pm', task_id: taskId, reason: 'read the finished route' })
const lost = (taskId) => (
  { event: 'audit_lost', agent_id: 'pm', task_id: taskId, reason: `leg ${taskId} died at the transport` })

// The shape acp-companion writes for a leg killed before the model ran. The
// producer-derived fixture `acp-liveness-v1-startup.json` carries exactly this
// pairing, measured from a real run rather than asserted here.
const deadAtTransport = (over = {}) => (
  { liveness_state: 'failed', termination_reason: 'protocol_error', work_observed: false, ...over })

// Exactly one plan, or the assertion below is reading a different token's.
const planFor = (custody, livenessFor) => {
  const plans = planDispatches(graphOf(), itemsOf(custody), new Set(), { now: PAST_DEADLINE, livenessFor })
  assert.equal(plans.length, 1, `expected one plan, got [${plans.map((plan) => plan.action).join(', ')}]`)
  return plans[0]
}

test('a controller leg the transport killed is retried, not abandoned', () => {
  const plan = planFor([...DELIVERED, requested()], () => deadAtTransport())

  assert.equal(plan.action, 'audit-lost', 'the leg never got a turn; nobody failed to answer')
  assert.equal(plan.task_id, 'pm-1', 'the retry names the leg it is replacing')
  // The old reason said the controller did not answer. It has to stop saying
  // that, or the ledger keeps blaming a seat that was never asked.
  assert.doesNotMatch(plan.reason, /no outer-controller audit answer/)
  assert.match(plan.reason, /retry 1 of 3/)
})

test('a controller that got its turn and said nothing is still abandoned', () => {
  // The conservative half, and the one that decides whether this change is a
  // narrowing or a hole: a leg that DID run and produced no verdict is the
  // original failure §9 wrote `abandoned` for, and it still does.
  const plan = planFor([...DELIVERED, requested()], () => deadAtTransport({ work_observed: true }))

  assert.equal(plan.action, 'expired', 'work was observed — this is silence, not a dead transport')
  assert.match(plan.reason, /no outer-controller audit answer/)
})

test('an absent or unreadable liveness record is not evidence of anything', () => {
  // Positive evidence only. Reading absence as "the transport must have died"
  // would turn every unwritable disk into an audit that never closes.
  for (const [name, reader] of [
    ['missing', () => null],
    ['unparsed', () => undefined],
    ['present but silent on the question', () => ({ liveness_state: 'failed', termination_reason: 'protocol_error' })],
  ]) {
    const plan = planFor([...DELIVERED, requested()], reader)
    assert.equal(plan.action, 'expired', `${name} must close exactly as fast as it did before`)
  }
})

test('a caller that supplies no liveness reader gets exactly the old answer', () => {
  // Back-compatibility is load-bearing here rather than polite: `planDispatches`
  // is called from tests and tools that know nothing about liveness, and the
  // default has to be the behaviour they were written against.
  const plan = planFor([...DELIVERED, requested()], undefined)
  assert.equal(plan.action, 'expired')
})

test('the retry budget is a ceiling, not a reprieve', () => {
  // The whole risk of this change in one test: a lane that dies in sixteen
  // seconds every single time still ends the token. The count is read off the
  // ledger, so a runner restart cannot forget it.
  const spent = [...DELIVERED, requested('pm-1'), lost('pm-1'), requested('pm-2'), lost('pm-2'),
    requested('pm-3'), lost('pm-3'), requested('pm-4')]
  const plan = planFor(spent, () => deadAtTransport())

  assert.equal(plan.action, 'expired', 'three retries spent, and the transport is still dying')
  assert.match(plan.reason, /3 transport retries already spent/)
})

test('the last retry inside the budget is still a retry', () => {
  // The off-by-one that would make the ceiling two: with two spent, the third
  // is owed. Fails if `>=` and `>` are swapped, which the ceiling test above
  // cannot see on its own.
  const plan = planFor([...DELIVERED, requested('pm-1'), lost('pm-1'), requested('pm-2'), lost('pm-2'),
    requested('pm-3')], () => deadAtTransport())

  assert.equal(plan.action, 'audit-lost')
  assert.match(plan.reason, /retry 3 of 3/)
})

test('the budget counts a whole token because a token completes exactly once', () => {
  // The assumption the counter rests on, pinned rather than assumed. This was
  // written the other way first — scoped to the newest `completed`, so a
  // "reworked" token would audit on a fresh budget — and the fixture gate
  // refused the history outright: §5 gives a closed route no successor that
  // reopens it. An unscoped count is therefore exact, not sloppy.
  //
  // If a reopen event is ever added, this goes red and the counter above is
  // where to look: an unscoped count would hand a reworked token its
  // predecessor's spent retries.
  assert.throws(() => itemsOf([...DELIVERED, { event: 'completed', from_team: 'test' }]),
    /event_after_terminal/, 'a second completed is not a history this system can produce')
})

test('the recorded reason quotes the leg, and is not a fixed phrase', () => {
  // Written against a specific mutant: hardcoding the words that the first
  // fixture happens to contain passes any single-fixture assertion while
  // reporting the same cause for every failure there is.
  const quota = planFor([...DELIVERED, requested()], () => deadAtTransport({ termination_reason: 'protocol_error' }))
  const timeout = planFor([...DELIVERED, requested()], () => deadAtTransport({ termination_reason: 'hard_timeout' }))

  assert.match(quota.reason, /protocol_error/)
  assert.match(timeout.reason, /hard_timeout/)
  assert.doesNotMatch(timeout.reason, /protocol_error/, 'the cause is read, not printed from a constant')
  assert.notEqual(quota.reason, timeout.reason)
})

// ── the other half: something has to look at the token again ────────────────
// A retry that nothing re-dispatches is the silent-forever failure this change
// exists to avoid, dressed as a fix. `audit_lost` re-arms through the same
// `awaitingAudit` membership `completed` and `answered` already use — so the
// assertion is relative: whatever the controller is planned to do for a fresh
// delivery, it must do for a token whose audit leg died.

const escalationFor = (custody) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-transport-'))
  try {
    mkdirSync(join(dir, '.tmux-teams', 'pm-notes'), { recursive: true })
    // No prior controller note, so the unchanged-trigger brake has nothing to
    // suppress and the plan reflects the ledger alone.
    writeFileSync(join(dir, '.tmux-teams', 'pm-notes', 'latest.md'), '')
    const graph = graphOf()
    const items = itemsOf(custody)
    return planEscalation(dir, graph, items, [], teamOccupancy(graph, items), { now: PAST_DEADLINE })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a token whose audit leg died is put back in front of the controller', () => {
  const fresh = escalationFor([...DELIVERED])
  const retried = escalationFor([...DELIVERED, requested('pm-1'), lost('pm-1')])

  assert.ok(fresh, 'a finished route is read by the controller — the baseline this compares against')
  assert.ok(retried, 'a token owed a verdict must not sit with no reader at all')
  assert.equal(retried.action, fresh.action, 'the retry uses the existing path, not a new one')
})

test('a token the controller already audited is not re-armed', () => {
  // The negative half of the test above, and the one that kills the mutant that
  // widens `awaitingAudit` to "anything that has ever been completed": that
  // mutant passes every assertion above while re-auditing settled tokens
  // forever.
  const settled = escalationFor([...DELIVERED, requested('pm-1'),
    { event: 'audited', agent_id: 'pm', verdict: 'accept', reason: 'the route holds' }])

  assert.equal(settled, null, 'audited is §5 terminal — nothing follows it, including a retry')
})
