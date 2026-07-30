// workflow-graph.test.mjs — the declaration layer, after two rules changed.
//
// The declaration is the one thing in this system nobody measures: whatever it
// says is taken as true. So every way it can lie has to be a rejection with a
// reason a human can act on. Two rules are new here — WIP is derived from the
// worker count instead of declared, and every seat names its model — and the
// older rejections have to keep firing while they land.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_ID_RE, DEFAULT_WORKFLOW_GRAPH, GRAPH_ID_RE, WORKFLOW_GRAPH_FILE,
  deriveWorkflowGraphDigest, teamRoleOf, validateWorkflowGraph, workflowAgentIds,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

// Written by code point: a raw control character in a source file is invisible
// in review, and these two tests are about exactly that character.
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(7)

const MODELS = { dispatcher: 'model-d', worker: 'model-w', evaluator: 'model-e' }

const teamOf = (id, workers, extra = {}) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: workers,
  evaluator_id: `${id}_e`,
  models: { ...MODELS },
  ...extra,
})

// Two teams, two workers in the first: enough shape that a WIP derived from the
// worker count is visibly not the constant 1.
const graphWith = (overrides = {}) => ({
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'model-pm',
  teams: [teamOf('build', ['b_w1', 'b_w2']), teamOf('verify', ['v_w1'])],
  workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'verify'] }],
  ...overrides,
})

const accepted = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? 'expected an accepted graph')
  return result.value
}

const rejected = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, false, 'expected a rejected graph')
  assert.equal(result.value, null, 'a rejected graph carries no value')
  assert.equal(typeof result.reason, 'string')
  assert.ok(result.reason.length > 0, 'a rejection states a reason')
  return result.reason
}

// ── decision 6: wip_limit is derived, never declared ─────────────────────────

test('wip_limit is the worker count, whatever the graph does not say', () => {
  const value = accepted(graphWith())
  assert.equal(value.teams[0].worker_ids.length, 2)
  assert.equal(value.teams[0].wip_limit, 2)
  assert.equal(value.teams[1].wip_limit, 1)
})

test('a wip_limit that matches the worker count is accepted and ignored', () => {
  // The migration case: files written before the rule changed keep loading.
  const value = accepted(graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { wip_limit: 2 }), teamOf('verify', ['v_w1'], { wip_limit: 1 })],
  }))
  assert.equal(value.teams[0].wip_limit, 2)
  assert.equal(value.teams[1].wip_limit, 1)
})

test('a wip_limit that differs from the worker count is rejected, naming both numbers', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { wip_limit: 5 }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/, 'the reason names the team')
  assert.match(reason, /5/, 'the reason names the declared limit')
  assert.match(reason, /\b2\b/, 'the reason names the worker count')
})

test('a lower wip_limit is refused rather than silently overruled', () => {
  // Throttling a team below its own worker count used to be expressible. It is
  // not any more, and the graph must say so instead of quietly raising it.
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { wip_limit: 1 }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /\b1\b/)
  assert.match(reason, /\b2\b/)
})

test('a wip_limit of the wrong type is rejected and printed as declared', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { wip_limit: '2' }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /"2"/, 'a declared string is quoted so it is not read as the number')
})

// ── decision 3: every seat declares its model ────────────────────────────────

test('a missing dispatcher model is rejected, naming the team and the role', () => {
  const team = teamOf('build', ['b_w1'])
  delete team.models.dispatcher
  const reason = rejected(graphWith({ teams: [team, teamOf('verify', ['v_w1'])] }))
  assert.match(reason, /build/)
  assert.match(reason, /dispatcher/)
})

test('a missing worker model is rejected, naming the team and the role', () => {
  const team = teamOf('verify', ['v_w1'])
  delete team.models.worker
  const reason = rejected(graphWith({ teams: [teamOf('build', ['b_w1']), team] }))
  assert.match(reason, /verify/)
  assert.match(reason, /worker/)
})

test('a missing evaluator model is rejected, naming the team and the role', () => {
  const team = teamOf('verify', ['v_w1'])
  delete team.models.evaluator
  const reason = rejected(graphWith({ teams: [teamOf('build', ['b_w1']), team] }))
  assert.match(reason, /verify/)
  assert.match(reason, /evaluator/)
})

test('a missing outer controller model is rejected, naming the controller', () => {
  const graph = graphWith()
  delete graph.outer_controller_model
  const reason = rejected(graph)
  assert.match(reason, /outer controller|outer_controller_model/)
})

test('a team with no models block at all is rejected, naming all three roles', () => {
  const team = teamOf('build', ['b_w1'])
  delete team.models
  const reason = rejected(graphWith({ teams: [team, teamOf('verify', ['v_w1'])] }))
  assert.match(reason, /build/)
  for (const role of ['dispatcher', 'worker', 'evaluator']) assert.match(reason, new RegExp(role))
})

test('an empty model is as missing as an absent one', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { models: { ...MODELS, worker: '' } }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /worker/)
})

test('a control character in a model is rejected', () => {
  // The value reaches a brief and an SVG page; an escape sequence in it is a
  // way to write something the graph never said.
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { models: { ...MODELS, evaluator: `sonnet${ESC}[31m` } }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /evaluator/)
})

test('a model longer than 128 characters is rejected and 128 exactly is kept', () => {
  const overLong = 'm'.repeat(129)
  assert.match(rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { models: { ...MODELS, dispatcher: overLong } }), teamOf('verify', ['v_w1'])],
  })), /build/)

  const atLimit = 'm'.repeat(128)
  const value = accepted(graphWith({
    teams: [teamOf('build', ['b_w1'], { models: { ...MODELS, dispatcher: atLimit } }), teamOf('verify', ['v_w1'])],
  }))
  assert.equal(value.teams[0].models.dispatcher, atLimit)
})

test('a model value is never judged against a list of known models', () => {
  // The adapter is the only authority on what a model name may say. A name
  // nobody here has heard of has to survive, or this file becomes the place
  // that has to be edited every time a provider ships something.
  const exotic = 'vendor-x/very-new-model:2099-preview@eu'
  const value = accepted(graphWith({
    outer_controller_model: exotic,
    teams: [teamOf('build', ['b_w1'], { models: { dispatcher: exotic, worker: exotic, evaluator: exotic } }),
      teamOf('verify', ['v_w1'])],
  }))
  assert.equal(value.outer_controller_model, exotic)
  assert.equal(value.teams[0].models.worker, exotic)
})

test('the declared model travels with the team, the role and the agent', () => {
  const value = accepted(graphWith())
  assert.deepEqual(value.teams[0].models, MODELS)
  assert.deepEqual(value.teams[0].agents.map((agent) => agent.model),
    ['model-d', 'model-w', 'model-w', 'model-e'])
  assert.equal(value.outer_controller_model, 'model-pm')
})

// ── the bundled template ─────────────────────────────────────────────────────

test('the bundled template satisfies the new contract', () => {
  const value = accepted(DEFAULT_WORKFLOW_GRAPH)
  assert.equal(value.outer_controller_model, 'inherit-account-default')
  for (const team of value.teams) {
    assert.equal(team.wip_limit, team.worker_ids.length)
    for (const role of ['dispatcher', 'worker', 'evaluator']) {
      assert.equal(team.models[role], 'inherit-account-default',
        `${team.team_id} ${role} must not ship somebody else's model choice`)
    }
  }
  // A template that declared a WIP number would be teaching the field back.
  for (const team of DEFAULT_WORKFLOW_GRAPH.teams) {
    assert.equal('wip_limit' in team, false, 'the template must not declare wip_limit')
  }
})

// ── every rejection that existed before this change ──────────────────────────

test('downstream_team_id on a team is still rejected as misplaced routing', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { downstream_team_id: 'verify' }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /downstream_team_id/)
  assert.match(reason, /workflow/)
})

test('a route that lists the same team twice is still rejected', () => {
  const reason = rejected(graphWith({
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'verify', 'build'] }],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /rejection/)
})

test('an agent_id used twice is still rejected', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1']), teamOf('verify', ['b_w1'])],
  }))
  assert.match(reason, /b_w1/)
  assert.match(reason, /more than once/)
})

// This test used to say "the outer controller shares its seat with nobody" and
// refused the controller anywhere inside a team. `references/controller-as-team.md`
// overturns exactly that: the controller becomes an ordinary team whose one
// worker IS that seat. What survives is the part that was never about the
// controller — one agent, one seat — so this rewrite keeps every refusal that
// still holds and adds the one case that is now legal.
test('the controller may hold one team seat, as that team’s only worker', () => {
  // Still refused: as a dispatcher it would be a SECOND seat, not the same one.
  assert.match(rejected(graphWith({
    teams: [teamOf('control', ['c_w1'], { dispatcher_id: 'pm' }), teamOf('build', ['b_w1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build'] }],
  })), /pm/)

  // Still refused: one seat cannot be worked by two teams.
  assert.match(rejected(graphWith({
    teams: [teamOf('control', ['pm']), teamOf('other', ['pm'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'other'] }],
  })), /one seat/)

  // Refused: a controller team is WIP 1 by definition — its seat is one seat.
  assert.match(rejected(graphWith({
    teams: [teamOf('control', ['pm', 'c_w2']), teamOf('build', ['b_w1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build'] }],
  })), /WIP 1/)

  // Refused: work enters through the controller, so every route starts there.
  assert.match(rejected(graphWith({
    teams: [teamOf('control', ['pm']), teamOf('build', ['b_w1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'control'] }],
  })), /every route enters through/)

  // Refused: two routes cannot disagree about where work enters.
  assert.match(rejected(graphWith({
    teams: [teamOf('control', ['pm']), teamOf('build', ['b_w1']), teamOf('qa', ['q_w1'])],
    workflows: [
      { workflow_id: 'full', name: 'Full', route: ['control', 'build', 'qa'] },
      { workflow_id: 'fast', name: 'Fast', route: ['build', 'qa'] },
    ],
  })), /every route enters through/)

  // Accepted, and the controller team is DERIVED rather than declared.
  const ok = validateWorkflowGraph(graphWith({
    teams: [teamOf('control', ['pm']), teamOf('build', ['b_w1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build'] }],
  }))
  assert.ok(ok.ok, ok.reason)
  assert.equal(ok.value.controller_team, 'control')
  assert.equal(ok.value.teams.find((entry) => entry.team_id === 'control').wip_limit, 1)

  // A graph that puts the controller in no team is the graph this system has
  // always accepted, and none of the above may touch it.
  const legacy = validateWorkflowGraph(graphWith())
  assert.ok(legacy.ok, legacy.reason)
  assert.equal(legacy.value.controller_team, null)
})

test('controller_team is derived, never declared', () => {
  assert.match(rejected(graphWith({ controller_team: 'build' })), /derived/)
})

test('a route naming an unknown team is still rejected', () => {
  const reason = rejected(graphWith({
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'ghost'] }],
  }))
  assert.match(reason, /ghost/)
  assert.match(reason, /unknown team/)
})

test('a control character in a team name is still rejected', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { name: `Build${BEL}` }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /name/)
})

test('the structural rejections all still fire', () => {
  assert.match(rejected(null), /object/)
  assert.match(rejected([]), /object/)
  assert.match(rejected(graphWith({ teams: [] })), /teams/)
  assert.match(rejected(graphWith({ workflows: [] })), /workflows/)
  assert.match(rejected(graphWith({ project_id: 'bad id!' })), /project_id/)
  assert.match(rejected(graphWith({ outer_controller_id: 'not a seat' })), /outer_controller_id/)
  assert.match(rejected(graphWith({ teams: [teamOf('build', [])] })), /worker_ids/)
  assert.match(rejected(graphWith({ teams: [teamOf('build', ['b_w1']), teamOf('build', ['c_w1'])] })),
    /duplicated/)
  assert.match(rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { dispatcher_id: 'has a space' }), teamOf('verify', ['v_w1'])],
  })), /dispatcher_id/)
  assert.match(rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { evaluator_id: 42 }), teamOf('verify', ['v_w1'])],
  })), /evaluator_id/)
  assert.match(rejected(graphWith({
    workflows: [{ workflow_id: 'a', name: 'A', route: ['build'] }, { workflow_id: 'a', name: 'A2', route: ['verify'] }],
  })), /workflow_id/)
})

// ── the exports the rest of the loop reads ───────────────────────────────────

test('the exported surface still answers what the loop asks it', () => {
  assert.equal(WORKFLOW_GRAPH_FILE, 'graph.json')
  assert.equal(AGENT_ID_RE.test('build_w1'), true)
  assert.equal(AGENT_ID_RE.test('build w1'), false)
  assert.equal(GRAPH_ID_RE.test('team.one:a'), true)
  assert.equal(GRAPH_ID_RE.test('team one'), false)

  const value = accepted(graphWith())
  assert.deepEqual(workflowAgentIds(value), ['build_d', 'b_w1', 'b_w2', 'build_e', 'verify_d', 'v_w1', 'verify_e'])
  assert.deepEqual(teamRoleOf(value, 'b_w2'), { team_id: 'build', team_name: 'BUILD', role: 'worker' })
  assert.deepEqual(teamRoleOf(value, 'verify_e'), { team_id: 'verify', team_name: 'VERIFY', role: 'evaluator' })
  assert.equal(teamRoleOf(value, 'pm'), null, 'the controller is not a team member')
  assert.match(value.source_digest, /^sha256:[0-9a-f]{64}$/)
})

test('the digest follows the declaration, models included', () => {
  const base = accepted(graphWith())
  const other = accepted(graphWith({ outer_controller_model: 'model-pm-2' }))
  assert.notEqual(base.source_digest, other.source_digest,
    'a changed model is a changed declaration')
  assert.equal(deriveWorkflowGraphDigest({ a: 1 }), deriveWorkflowGraphDigest({ a: 1 }))
})
