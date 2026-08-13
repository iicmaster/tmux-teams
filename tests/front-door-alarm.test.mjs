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
import { admitWorkItem } from '../plugins/tmux-teams/skills/tmux-teams/scripts/admit.mjs'
import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { DEFAULT_WORKFLOW_GRAPH, validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const GRAPH = validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH).value
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
