// The alarm, at the door that rings it.
//
// The owner's rule: a stuck token holds its team's slot; escalating means the PM
// is working, so the PM's slot is held too; and a held front door is the alarm.
// This file exercises that end to end through `admitWorkItem` — the real door,
// the real writer, the real reader — because the change it guards is a change in
// what the system REFUSES, and a refusal is only real at the place that makes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planDispatches, planEscalation } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { admitWorkItem } from '../plugins/tmux-teams/skills/tmux-teams/scripts/admit.mjs'
import { readWorkItems } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { DEFAULT_WORKFLOW_GRAPH, validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const GRAPH = validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH).value
const NOW = Date.parse('2026-08-14T10:00:00.000Z')
const CONTROL = GRAPH.controller_team
const WORKFLOW = GRAPH.workflows[0].workflow_id
const FIRST = GRAPH.workflows[0].route[1]

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'front-door-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  // The LITERAL graph on disk, not the validated one: `controller_team` is
  // derived from the head of every route, and a graph that declares it is
  // refused. Writing back what validation handed us made every door here answer
  // graph_invalid, which reads exactly like a closed door.
  writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(DEFAULT_WORKFLOW_GRAPH))
  return dir
}

const admit = (dir, token) => admitWorkItem(dir, {
  work_item: token, workflow: WORKFLOW, reason: 'a request from a person',
}, { actor: 'human:ada' })

const write = (dir, event) => {
  const { actor, ...rest } = event
  const result = appendEvent(dir, rest, { actor })
  assert.notEqual(result?.ok, false, `the writer refused ${rest.event}: ${result?.detail ?? ''}`)
}

const moveOut = (dir, token) => write(dir, {
  actor: `agent:${FIRST}_dispatcher`, event: 'pulled', work_item: token, workflow: WORKFLOW,
  agent_id: `${FIRST}_dispatcher`, from_team: CONTROL, to_team: FIRST,
})

test('the door opens again once the request leaves the controller', () => {
  // The baseline. Without this, every refusal below could be a door that is
  // simply stuck shut, which would look identical from the outside.
  const dir = repo()
  assert.equal(admit(dir, 'w1').ok, true)
  assert.equal(admit(dir, 'w2').ok, false, 'two requests sat in a WIP-1 queue at once')
  moveOut(dir, 'w1')
  assert.equal(admit(dir, 'w2').ok, true)
})

test('a delivery that finished and owes a verdict keeps the door shut', () => {
  // This is the change. The route is closed and the work is not done: control
  // owes it an audit, so control is holding it, so nothing new is admitted.
  // Before the accounting, `completed` freed the token from every team and the
  // door opened onto a system with unfinished business in it.
  const dir = repo()
  assert.equal(admit(dir, 'w1').ok, true)
  moveOut(dir, 'w1')
  assert.equal(admit(dir, 'w2').ok, true, 'the door should be free while w1 is out being worked on')
  moveOut(dir, 'w2')
  write(dir, { actor: `agent:${FIRST}_evaluator`, event: 'completed', work_item: 'w1', workflow: WORKFLOW, from_team: FIRST })

  const refused = admit(dir, 'w3')
  assert.equal(refused.ok, false, 'a new request was admitted while a finished delivery still owed a verdict')
  assert.match(String(refused.detail ?? refused.message ?? ''), /holding/)
})

test('an audit in progress keeps the door shut, and a verdict opens it', () => {
  const dir = repo()
  assert.equal(admit(dir, 'w1').ok, true)
  moveOut(dir, 'w1')
  write(dir, { actor: `agent:${FIRST}_evaluator`, event: 'completed', work_item: 'w1', workflow: WORKFLOW, from_team: FIRST })
  write(dir, { actor: 'agent:pm_audit', event: 'audit_requested', work_item: 'w1', workflow: WORKFLOW, agent_id: 'pm_audit', task_id: 't-audit', reason: 'reading the delivery' })
  assert.equal(admit(dir, 'w2').ok, false, 'the PM is working and the door was open anyway')

  write(dir, { actor: 'agent:pm_audit', event: 'audited', work_item: 'w1', workflow: WORKFLOW, agent_id: 'pm_audit', task_id: 't-audit', verdict: 'accept', reason: 'it holds' })
  assert.equal(admit(dir, 'w2').ok, true, 'a verdict did not free control')
})

test('an escalation holds the PM, so the door shuts on the whole system', () => {
  // Three tokens stuck in three teams used to leave control empty and the door
  // open, so more work was admitted to get stuck later, somewhere else. The
  // escalation is the PM's work; the PM's slot is held until it is done.
  const dir = repo()
  assert.equal(admit(dir, 'w1').ok, true)
  moveOut(dir, 'w1')
  assert.equal(admit(dir, 'w2').ok, true)
  write(dir, {
    actor: `agent:${FIRST}_dispatcher`, event: 'escalated', work_item: 'w1', workflow: WORKFLOW,
    agent_id: `${FIRST}_dispatcher`, to_team: CONTROL, task_id: 't-esc', reason: 'stuck and nobody can unstick it here',
  })
  moveOut(dir, 'w2')
  assert.equal(admit(dir, 'w3').ok, false, 'work was admitted while the PM was already unsticking something')
})

test('a full controller can still be reached for the token that filled it', () => {
  // A review lane asked this and could not answer it from the diff: control has
  // one seat, an escalation consumes it, and the only events that free it are
  // ones the controller itself writes. If a full control team could not be
  // planned for, the stop mechanism would be a deadlock wearing its clothes.
  //
  // It is not, and the reason is the split between holding and acting: the
  // delivery team's slot is spent (WIP) while its `held` list is empty (the
  // controller decides), so the token is reached exactly once, under control.
  const custody = [
    { at: '2026-08-14T09:00:00.000Z', event: 'opened', work_item: 'tok', workflow: WORKFLOW, agent_id: 'pm_intake', to_team: CONTROL, reason: 'admitted' },
    { at: '2026-08-14T09:01:00.000Z', event: 'pulled', work_item: 'tok', workflow: WORKFLOW, agent_id: `${FIRST}_dispatcher`, from_team: CONTROL, to_team: FIRST },
    { at: '2026-08-14T09:02:00.000Z', event: 'escalated', work_item: 'tok', workflow: WORKFLOW, agent_id: `${FIRST}_dispatcher`, to_team: CONTROL, task_id: 't1', reason: 'stuck here' },
  ]
  const items = new Map([['tok', { work_item: 'tok', workflow: WORKFLOW, custody }]])

  const occupancy = teamOccupancy(GRAPH, items)
  assert.equal(occupancy.counts.get(CONTROL), 1, 'the PM is working and is not counted for it')
  assert.equal(occupancy.counts.get(FIRST), 1, 'the work is still stuck in its delivery team')
  assert.deepEqual(occupancy.held.get(FIRST), [], 'two teams would plan for the same token in one tick')

  const plans = planDispatches(GRAPH, items, new Set(), { now: Date.parse('2026-08-14T09:05:00.000Z') })
  const forToken = plans.filter((plan) => plan.work_item === 'tok' || plan.team === CONTROL)
  assert.equal(forToken.length, 1, 'the token that filled control was planned for zero times, or twice')
  assert.equal(forToken[0].action, 'escalate')
})

test('a finished route is picked up for audit, and the verdict gives the slot back', () => {
  // A review lane read `planDispatches` alone and concluded a completed token
  // holds control's slot for ever with nothing able to free it. Correct against
  // what it was given, and wrong about the system: the per-team loop skips the
  // control queue precisely because another planner owns it. This walks the
  // whole path, because "nothing can free it" is the worst thing that could be
  // true here and no test proved otherwise end to end.
  const dir = repo()
  assert.equal(admit(dir, 'w1').ok, true)
  moveOut(dir, 'w1')
  write(dir, { actor: `agent:${FIRST}_evaluator`, event: 'completed', work_item: 'w1', workflow: WORKFLOW, from_team: FIRST })

  const items = readWorkItems(dir).items
  const occupancy = teamOccupancy(GRAPH, items)
  assert.equal(occupancy.counts.get(CONTROL), 1, 'the finished route is not in the controller queue')
  assert.deepEqual(planDispatches(GRAPH, items, new Set(), { now: NOW }), [],
    'the per-team loop planned for a token the audit path owns')

  const escalation = planEscalation(dir, GRAPH, items, [], occupancy, { now: NOW })
  assert.deepEqual(escalation.audits, ['w1'], 'nothing offered the finished route to the controller')

  // The grammar requires the request before the verdict — `audited with no
  // preceding audit_requested` is refused by the writer — so the walk includes
  // the step the controller takes when it picks the token up.
  write(dir, { actor: 'agent:pm_audit', event: 'audit_requested', work_item: 'w1', workflow: WORKFLOW, agent_id: 'pm_audit', task_id: 't-a', reason: 'reading the delivery' })
  assert.equal(teamOccupancy(GRAPH, readWorkItems(dir).items).counts.get(CONTROL), 1,
    'the controller let go of the token while it was reading it')

  write(dir, { actor: 'agent:pm_audit', event: 'audited', work_item: 'w1', workflow: WORKFLOW, agent_id: 'pm_audit', task_id: 't-a', verdict: 'accept', reason: 'read and accepted' })
  const after = teamOccupancy(GRAPH, readWorkItems(dir).items)
  assert.equal(after.counts.get(CONTROL), 0, 'the verdict did not give the slot back')
  assert.equal(admit(dir, 'w2').ok, true, 'the front door never reopened')
})

test('a failed leg is re-dispatched, and the answer comes from the token subscriber', () => {
  // Cell 3, at its consumer. The subscriber owning a leg's outcome proves
  // nothing until `nextStep` asks it, and a pure function tested alone is this
  // repository's third-most-repeated way of testing nothing.
  const custody = [
    { at: '2026-08-14T09:00:00.000Z', event: 'opened', work_item: 'w1', workflow: WORKFLOW, agent_id: 'pm_intake', to_team: CONTROL, reason: 'admitted' },
    { at: '2026-08-14T09:01:00.000Z', event: 'pulled', work_item: 'w1', workflow: WORKFLOW, agent_id: `${FIRST}_dispatcher`, from_team: CONTROL, to_team: FIRST },
    { at: '2026-08-14T09:02:00.000Z', event: 'intake', work_item: 'w1', workflow: WORKFLOW, agent_id: `${FIRST}_dispatcher`, verdict: 'accept', reason: 'looks doable' },
    { at: '2026-08-14T09:03:00.000Z', event: 'assigned', work_item: 'w1', workflow: WORKFLOW, agent_id: `${FIRST}_worker_1`, task_id: 't1', dispatch_id: 'd1' },
    { at: '2026-08-14T09:04:00.000Z', event: 'delivered', work_item: 'w1', workflow: WORKFLOW, agent_id: `${FIRST}_worker_1`, task_id: 't1', dispatch_id: 'd1', terminal: 'timeout', timed_out: true, evidence_present: false },
  ]
  const items = new Map([['w1', { work_item: 'w1', workflow: WORKFLOW, custody }]])
  const plans = planDispatches(GRAPH, items, new Set(), { now: Date.parse('2026-08-14T09:05:00.000Z') })
  const forToken = plans.filter((plan) => plan.work_item === 'w1')
  assert.equal(forToken.length, 1, 'a leg that timed out was planned for zero times, or twice')
  assert.equal(forToken[0].action, 'dispatch', 'a failed leg was not re-dispatched')
  assert.equal(forToken[0].role, 'worker', 'a failed worker leg went to a seat that is not a worker')
})
