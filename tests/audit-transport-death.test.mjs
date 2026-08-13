// audit-transport-death.test.mjs — GitHub #52.
//
// The audit answer-deadline was the only reader a token at `audit_requested`
// had left, and it could see exactly one thing: whether the controller's leg
// was still alive. So a controller that read a delivery and sat silent for ten
// minutes, and a leg a provider's rate limit killed sixteen seconds in before
// the model ever got a turn, produced the same hard terminal — `abandoned`,
// ข้อ 4.7, nothing may follow — and the same recorded reason, "no outer-controller
// audit answer in 10 minute(s)". For the second case that sentence is false:
// nobody failed to answer, because nobody was ever asked. Three finished tokens
// were destroyed that way on one quota-exhausted morning, one per deadline.
//
// ข้อ 4.10 already invented the fact that settles it — `work_observed`, "did the
// model take a turn" — but wired it to the custody ledger, and the controller's
// own leg is spawned with `workItem: ''`, so the ledger write is a no-op for
// precisely the leg that needed it. The fix carries the same fact on the one
// channel that leg does write: its liveness snapshot.
//
// What must stay true is the reason the deadline exists at all. An audit that
// cannot be abandoned is an audit that can hang forever, which is the failure
// this branch was built to prevent — so every case that is not POSITIVE
// evidence of a dead transport still closes exactly as fast as it did before.
//
// 2026-08-07: the first fix RETRIED such a leg three times and then abandoned
// it anyway. That was the least-bad option at the time, because the alternative
// — park it on a question — had no exit: nothing in this system could write
// `answered`. `answer.mjs` now can, so the retry is gone (D1: a leg the
// transport killed is held, nothing retries by itself, a person unblocks it).
// The word `audit_lost` is still read everywhere; nothing writes it.
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
    // D6 (2026-08-08): every graph declares one, and here it is load-bearing
    // rather than ceremonial — the controller's question needs a WIP slot to
    // hold, and this is the team that owns it.
    { team_id: 'control', name: 'Control', dispatcher_id: 'pm_intake', worker_ids: ['pm'], evaluator_id: 'pm_audit', models: MODELS },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'test'] }],
}

// The same two delivery teams, with the controller sitting in a team of its own
// — the shape that gives a question somewhere to be. `worker_ids` is exactly
// one seat (the loader refuses more: one seat, so WIP 1) and every route enters
// through it. Without this graph the question path cannot be exercised at all,
// which is the point of the guard tested below.
const WITH_CONTROL = TWO_TEAMS

const FIXED_NOW = Date.parse('2026-08-06T09:00:00.000Z')
const PAST_DEADLINE = FIXED_NOW + 1_000_000

const graphOf = (declaration = TWO_TEAMS) => {
  const result = validateWorkflowGraph(declaration)
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
const planFor = (custody, livenessFor, declaration = TWO_TEAMS) => {
  const plans = planDispatches(graphOf(declaration), itemsOf(custody), new Set(), { now: PAST_DEADLINE, livenessFor })
  assert.equal(plans.length, 1, `expected one plan, got [${plans.map((plan) => plan.action).join(', ')}]`)
  return plans[0]
}

test('a controller leg the transport killed asks a person, and abandons nothing', () => {
  const plan = planFor([...DELIVERED, requested()], () => deadAtTransport(), WITH_CONTROL)

  assert.equal(plan.action, 'audit-question', 'the leg never got a turn; nobody failed to answer')
  assert.equal(plan.task_id, 'pm-1', 'the question names the leg that died')
  // The old reason said the controller did not answer. It has to stop saying
  // that, or the ledger keeps blaming a seat that was never asked.
  assert.doesNotMatch(plan.reason, /no outer-controller audit answer/)
  // And it must not blame a retry budget either — there is none any more.
  assert.doesNotMatch(plan.reason, /retry/)
  // What the person is actually being asked. A question with no question text
  // reaches the operator as an empty prompt they cannot act on.
  assert.match(plan.questions, /died at the.*transport/s)
  assert.match(plan.questions, /still waiting for a verdict/)
})

test('a controller that got its turn and said nothing is still abandoned', () => {
  // The conservative half, and the one that decides whether this change is a
  // narrowing or a hole: a leg that DID run and produced no verdict is the
  // original failure ข้อ 9 wrote `abandoned` for, and it still does.
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

test('a token already parked on the question is not asked again', () => {
  // What replaces the retry ceiling. The old risk was a lane dying every time
  // and burning three legs; the new one is a scan that asks once per tick for
  // ever, which would be worse — a person cannot answer a question that is
  // replaced every sixty seconds. Nothing guards this explicitly: the scan
  // reads `currentEntry` and skips anything that is not `audit_requested`, so
  // writing the question is itself what stops the asking. Pinned here because
  // that is a property of a `continue` two hundred lines away.
  const asked = [...DELIVERED, requested('pm-1'),
    { event: 'questioned', agent_id: 'pm', task_id: 'pm-1', question_id: 'q-tok-1',
      resume_role: 'audit', questions: 'the leg died at the transport — read it again?',
      reason: 'outer-controller leg for task pm-1 died without the model taking a turn' }]
  const plans = planDispatches(graphOf(), itemsOf(asked), new Set(),
    { now: PAST_DEADLINE, livenessFor: () => deadAtTransport() })

  assert.equal(plans.filter((plan) => plan.action === 'audit-question').length, 0,
    'the question was already asked; asking again replaces it with an identical one')
})

test('the parked question occupies the control team, which is what stops the board', () => {
  // Master's rule, and the reason any of this is worth building: a token stuck
  // with a team keeps that team's WIP; escalate it to the PM and the PM's WIP is
  // held until it is done. `admit.mjs` refuses admission while the control team
  // is at its limit, so a question nobody has answered closes the front door —
  // the system STOPS rather than starting more work on top of a problem.
  const asked = itemsOf([...DELIVERED, requested('pm-1'),
    { event: 'questioned', agent_id: 'pm', task_id: 'pm-1', question_id: 'q-tok-1',
      resume_role: 'audit', questions: 'read it again?', reason: 'leg died at the transport' }])

  const held = teamOccupancy(graphOf(WITH_CONTROL), asked)
  assert.equal(held.counts.get('control'), 1, 'the person owes an answer, and the slot is held')
  assert.equal(held.orphans.length, 0)
  // Not the delivery team: the route is finished and the question is the
  // controller's, so `build` and `test` are free to pull other work.
  assert.equal(held.counts.get('test'), 0)

  // The other half of the same rule — the counterpart used to be a graph with
  // no control team, where this token orphaned and stopped nothing. D6 removed
  // that shape at load, so the comparison that remains is the one that still
  // exists: answer the question and the slot is released.
  const answered = itemsOf([...DELIVERED, requested('pm-1'),
    { event: 'questioned', agent_id: 'pm', task_id: 'pm-1', question_id: 'q-tok-1',
      resume_role: 'audit', questions: 'read it again?', reason: 'leg died at the transport' },
    { event: 'answered', to_team: 'control', question_id: 'q-tok-1',
      actor: 'human:someone', reason: 'yes, read it again' }])
  const freed = teamOccupancy(graphOf(WITH_CONTROL), answered)
  assert.equal(freed.counts.get('control'), 1,
    'still held — the controller now owes the verdict it was going to give')
  assert.equal(freed.orphans.length, 0)
})

test('the question it writes is one answer.mjs can actually close', () => {
  // The two halves were built a day apart, and each is useless alone: a question
  // nothing can answer is the wedge this replaced, and a door with nothing to
  // open is furniture. `answer.mjs` refuses unless the current event is
  // `questioned` AND it carries a `question_id`, and derives `to_team` from the
  // asking seat — here the outer controller, which is a member of the control
  // team. So this asserts the plan carries what that door requires, by name.
  const plan = planFor([...DELIVERED, requested()], () => deadAtTransport(), WITH_CONTROL)

  assert.match(plan.question_id, /^q-/, 'an answer binds to this id; without it answer.mjs refuses')
  assert.equal(plan.agent_id, 'pm', 'the asking seat is what answer.mjs resolves the team from')
  // `resume_role` is not decoration either: `nextStep` returns `held` for
  // 'audit' and lets `awaitingAudit` re-arm on the `answered`. Any other value
  // dispatches a team seat for a reply it never asked for.
  assert.equal(plan.resume_role, 'audit')
})

test('a token completes exactly once, which is why one question is enough', () => {
  // Written for the retry counter this file no longer has — it pinned the
  // assumption that made an unscoped count exact — and kept because the new
  // design leans on the same fact harder. Asking once and holding is only safe
  // while a closed route has no successor that reopens it; a reopen event
  // would give a token a second delivery and a stale question still current
  // over it. If one is ever added, this goes red first, and the audit-question
  // path above is what has to learn about it.
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
  // `audit_lost` is no longer WRITTEN, and this is why it is still read: ledgers
  // written while it was must keep re-arming. Delete it from `awaitingAudit` and
  // every one of those tokens sits with no reader at all — the exact failure
  // this whole file exists to prevent, reintroduced by a cleanup.
  const legacy = escalationFor([...DELIVERED, requested('pm-1'), lost('pm-1')])
  // The path that replaced it: a person answered, so the controller is owed a
  // verdict again. Same action, because no new spawn path was added — the whole
  // mechanism is membership in the set `awaitingAudit` already decides.
  const answered = escalationFor([...DELIVERED, requested('pm-1'),
    { event: 'questioned', agent_id: 'pm', task_id: 'pm-1', question_id: 'q-tok-1',
      resume_role: 'audit', questions: 'read it again?', reason: 'leg died at the transport' },
    { event: 'answered', to_team: 'control', question_id: 'q-tok-1',
      actor: 'human:someone', reason: 'yes, read it again' }])

  assert.ok(fresh, 'a finished route is read by the controller — the baseline this compares against')
  assert.ok(legacy, 'a token owed a verdict must not sit with no reader at all')
  assert.equal(legacy.action, fresh.action, 'the legacy word uses the existing path, not a new one')
  assert.ok(answered, 'an answer re-arms the audit — otherwise the question is a wedge')
  assert.equal(answered.action, fresh.action, 'and it re-arms down the same path')
})

test('a token the controller already audited is not re-armed', () => {
  // The negative half of the test above, and the one that kills the mutant that
  // widens `awaitingAudit` to "anything that has ever been completed": that
  // mutant passes every assertion above while re-auditing settled tokens
  // forever.
  const settled = escalationFor([...DELIVERED, requested('pm-1'),
    { event: 'audited', agent_id: 'pm', verdict: 'accept', reason: 'the route holds' }])

  assert.equal(settled, null, 'audited is ข้อ 5 terminal — nothing follows it, including a retry')
})
