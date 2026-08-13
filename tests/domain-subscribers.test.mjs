import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProjection } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-bus.mjs'
import {
  CONTROL_TEAM_ID, SLOT_DECIDING_EVENTS, teamDomain, occupancyOf, teamsHolding,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-team.mjs'
import { tokenDomain, lastLegOutcome, lastLegFailed, openLegCount } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-token.mjs'
import { workflowDomain, nextHop, routeFinished, positionOf } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-workflow.mjs'
import { DEFAULT_WORKFLOW_GRAPH } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const team = (log) => createProjection({ team: teamDomain() }).replay(log).stateOf('team')
const ev = (event, over = {}) => ({ event, work_item: 'w1', ...over })

// ---------------------------------------------------------------- the heart

test('an escalation holds BOTH the delivery team and control', () => {
  // The owner's rule, and the one thing measurement found was never built: a
  // stuck token holds its team's slot, and escalating means the PM is working,
  // so the PM's slot is held too. Today `escalated` occupies no PM seat at all,
  // which is why three tokens can be stuck in three teams while control sits
  // empty and the front door stays open.
  const state = team([ev('pulled', { to_team: 'build' }), ev('escalated', { agent_id: 'pm_outer_loop' })])
  assert.deepEqual(teamsHolding(state, 'w1'), ['build', CONTROL_TEAM_ID])
})

test('a completed route is held by control, not filed as done', () => {
  // A token that has completed but is not audited is a control-team-held queue
  // item. Freeing it here is what let a delivery finish with nobody owing it a
  // verdict.
  const state = team([ev('pulled', { to_team: 'build' }), ev('completed')])
  assert.deepEqual(teamsHolding(state, 'w1'), [CONTROL_TEAM_ID])
})

test('an audit in progress holds control, and a lost audit keeps holding it', () => {
  for (const word of ['audit_requested', 'audit_lost']) {
    const state = team([ev('pulled', { to_team: 'build' }), ev('completed'), ev(word)])
    assert.deepEqual(teamsHolding(state, 'w1'), [CONTROL_TEAM_ID], `${word} released the slot`)
  }
})

test('only a verdict frees everything', () => {
  for (const word of ['audited', 'abandoned']) {
    const state = team([ev('pulled', { to_team: 'build' }), ev('escalated'), ev('completed'), ev(word)])
    assert.deepEqual(teamsHolding(state, 'w1'), [], `${word} left a slot held`)
  }
})

test('a held slot is what closes the front door — occupancy counts it', () => {
  const graph = { teams: [{ team_id: 'build' }, { team_id: CONTROL_TEAM_ID }] }
  const state = team([
    ev('pulled', { work_item: 'a', to_team: 'build' }), ev('completed', { work_item: 'a' }),
    ev('pulled', { work_item: 'b', to_team: 'build' }), ev('escalated', { work_item: 'b' }),
  ])
  const { counts, held } = occupancyOf(state, graph)
  assert.equal(counts.get(CONTROL_TEAM_ID), 2, 'control is holding two pieces of work and must say so')
  assert.equal(counts.get('build'), 1, 'the escalated token is still stuck in its own team')
  assert.deepEqual(held.get(CONTROL_TEAM_ID), ['a', 'b'])
})

// ------------------------------------------------------------ moving around

test('a hop moves the token — it never holds two delivery teams at once', () => {
  const state = team([ev('pulled', { to_team: 'build' }), ev('pulled', { to_team: 'review' })])
  assert.deepEqual(teamsHolding(state, 'w1'), ['review'])
})

test('a refusal hands the token BACK, it does not drop it', () => {
  // Contract ข้อ 4.1: the token is held by the team it went back to, not by the
  // dispatcher that refused it. Treating a refusal as a plain release would let
  // work leave the system through the front door it was refused at.
  const state = team([
    ev('pulled', { to_team: 'build' }),
    ev('returned', { to_team: 'control', refused_by: 'build_dispatcher' }),
  ])
  assert.deepEqual(teamsHolding(state, 'w1'), ['control'])
})

test('acceptance changes nothing about the slot, on purpose', () => {
  const accepted = team([ev('pulled', { to_team: 'build' }), ev('intake')])
  assert.deepEqual(teamsHolding(accepted, 'w1'), ['build'])
})

test('delivering frees the SEAT and not the slot', () => {
  const state = team([
    ev('pulled', { to_team: 'build' }),
    ev('assigned', { agent_id: 'w', dispatch_id: 'd1' }),
    ev('delivered', { agent_id: 'w', dispatch_id: 'd1' }),
  ])
  assert.equal(state.seats.has('w'), false, 'the seat stayed busy after its leg reported')
  assert.deepEqual(teamsHolding(state, 'w1'), ['build'], 'the team stopped holding a token it still owns')
})

test('a dead leg reporting late does not free the seat a live leg is running', () => {
  // A leg killed mid-review still writes its last word on the way out, and `at`
  // is stamped when the line is written — so a dead leg's report genuinely
  // arrives after a NEW leg took the same seat. Freeing on agent_id alone hands
  // that seat away while work is still running on it.
  const state = team([
    ev('pulled', { to_team: 'build' }),
    ev('assigned', { agent_id: 'w', dispatch_id: 'd1' }),
    ev('assigned', { agent_id: 'w', dispatch_id: 'd2' }),
    ev('delivered', { agent_id: 'w', dispatch_id: 'd1' }),
  ])
  assert.equal(state.seats.has('w'), true, 'the live leg lost its seat to a dead leg\'s last word')
  assert.equal(state.seats.get('w').dispatch_id, 'd2')
})

test('a resume hands the work back and lets control go', () => {
  const state = team([
    ev('pulled', { to_team: 'build' }), ev('escalated'), ev('resumed', { to_team: 'build' }),
  ])
  assert.deepEqual(teamsHolding(state, 'w1'), ['build'])
})

test('waiting on a person is work in progress', () => {
  const state = team([ev('pulled', { to_team: 'build' }), ev('questioned')])
  assert.deepEqual(teamsHolding(state, 'w1'), ['build'])
})

// ------------------------------------------------------------------- wiring

test('the control team id is the one the graph actually declares', () => {
  // A constant checked against itself proves nothing. This asks the shipped
  // graph, so renaming the team in one place and not the other goes red.
  const ids = DEFAULT_WORKFLOW_GRAPH.teams.map((t) => t.team_id)
  assert.ok(ids.includes(CONTROL_TEAM_ID), `graph declares ${ids.join(', ')} — none of them is ${CONTROL_TEAM_ID}`)
})

test('every slot-deciding word actually decides a slot', () => {
  // Pinned literally as well as iterated: a loop over the constant stops testing
  // whatever is deleted from it, which this repository has been bitten by.
  assert.deepEqual(SLOT_DECIDING_EVENTS,
    ['pulled', 'intake', 'returned', 'delivered', 'completed', 'audit_requested'])

  const before = ev('pulled', { to_team: 'build' })
  for (const word of ['returned', 'completed', 'audit_requested']) {
    const withIt = teamsHolding(team([before, ev(word)]), 'w1')
    const without = teamsHolding(team([before]), 'w1')
    assert.notDeepEqual(withIt, without, `${word} left the slots exactly as they were`)
  }
  // `intake` and `delivered` hold the slot deliberately; their decision is the
  // seat and the refusal, checked in their own tests above.
})

// -------------------------------------------------------------------- token

test('a dead leg reporting late is matched to its own leg, not the open one', () => {
  const state = createProjection({ token: tokenDomain() }).replay([
    ev('assigned', { agent_id: 'w', dispatch_id: 'd1' }),
    ev('assigned', { agent_id: 'w', dispatch_id: 'd2' }),
    ev('delivered', { agent_id: 'w', dispatch_id: 'd1', terminal: 'refused' }),
  ]).stateOf('token')
  const legs = state.items.get('w1').legs
  assert.equal(legs[0].terminal, 'refused', 'the late word was applied to the wrong leg')
  assert.equal(legs[1].settled, false)
  assert.equal(openLegCount(state, 'w1'), 1)
})

test('a failed leg reads as failed, on the field a writer actually writes', () => {
  // The first version of this asked for a field called `outcome`. No writer has
  // ever set one -- `delivered` carries `terminal` -- so every leg read back as
  // a success and a failed leg would have stopped being re-dispatched. The test
  // passed anyway, because the fixture invented the same field the code read.
  // The split below is the one `nextStep` makes: lost, or a terminal that is
  // not 'done'.
  const settled = (terminal) => createProjection({ token: tokenDomain() }).replay([
    ev('assigned', { agent_id: 'a', dispatch_id: 'd1' }),
    ev('delivered', { agent_id: 'a', dispatch_id: 'd1', terminal }),
  ]).stateOf('token')

  assert.equal(lastLegFailed(settled('done'), 'w1'), false)
  assert.equal(lastLegOutcome(settled('done'), 'w1'), 'done')
  for (const terminal of ['timeout', 'no-outbox', 'identity-refused', 'error']) {
    assert.equal(lastLegFailed(settled(terminal), 'w1'), true, `${terminal} read as a success`)
  }
})

test('the leg outcome is the bold cell — the newest leg that reported', () => {
  const state = createProjection({ token: tokenDomain() }).replay([
    ev('assigned', { agent_id: 'a', dispatch_id: 'd1' }),
    ev('delivered', { agent_id: 'a', dispatch_id: 'd1', terminal: 'done' }),
    ev('assigned', { agent_id: 'b', dispatch_id: 'd2' }),
    ev('lost', { agent_id: 'b', dispatch_id: 'd2', task_id: 't', reason: 'nothing came back' }),
  ]).stateOf('token')
  assert.equal(lastLegOutcome(state, 'w1'), 'lost')
  assert.equal(lastLegFailed(state, 'w1'), true)
})

// ----------------------------------------------------------------- workflow

test('position is read off the declared route, not assumed', () => {
  const routes = new Map([['wf', ['control', 'build', 'review']]])
  const state = createProjection({ workflow: workflowDomain({ routes }) }).replay([
    ev('opened', { workflow: 'wf' }), ev('pulled', { to_team: 'build' }),
  ]).stateOf('workflow')
  assert.equal(positionOf(state, 'w1').hop, 1)
  assert.equal(nextHop(state, 'w1'), 'review')
})

test('a refusal undoes the hop', () => {
  const routes = new Map([['wf', ['control', 'build', 'review']]])
  const state = createProjection({ workflow: workflowDomain({ routes }) }).replay([
    ev('opened', { workflow: 'wf' }), ev('pulled', { to_team: 'build' }), ev('returned'),
  ]).stateOf('workflow')
  assert.equal(positionOf(state, 'w1').hop, 0)
})

test('a finished route says so itself, and offers no next hop', () => {
  const routes = new Map([['wf', ['control', 'build']]])
  const state = createProjection({ workflow: workflowDomain({ routes }) }).replay([
    ev('opened', { workflow: 'wf' }), ev('pulled', { to_team: 'build' }), ev('completed'),
  ]).stateOf('workflow')
  assert.equal(routeFinished(state, 'w1'), true)
  assert.equal(nextHop(state, 'w1'), null)
})
