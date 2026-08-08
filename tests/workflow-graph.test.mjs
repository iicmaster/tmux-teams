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

// Two delivery teams, two workers in the first: enough shape that a WIP derived
// from the worker count is visibly not the constant 1. The control team is
// APPENDED rather than prepended so the index-addressed assertions below still
// read the team they were written about; the route, which is what the loader
// checks, still enters through it. Mandatory since D6 (2026-08-08) — before
// that a graph naming the controller in no team was accepted, and that is now
// the refusal tested at the bottom of this file.
const graphWith = (overrides = {}) => {
  const graph = {
    project_id: 'p',
    outer_controller_id: 'pm',
    outer_controller_model: 'model-pm',
    teams: [teamOf('build', ['b_w1', 'b_w2']), teamOf('verify', ['v_w1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'verify'] }],
    ...overrides,
  }
  // Injected rather than written into the literal above, because most tests
  // here override `teams` to say something about a delivery team and would
  // otherwise drop the control team along with it — and then every one of them
  // would fail on D6 instead of on the thing it is about. Appended, so the
  // index-addressed assertions still read the team they were written for.
  // Skipped when the caller supplied a control team, and when the controller id
  // is deliberately malformed: those tests are about the id, and a bad worker
  // id would answer them with the wrong error.
  const controller = graph.outer_controller_id
  const placed = Array.isArray(graph.teams)
    && graph.teams.some((team) => Array.isArray(team?.worker_ids) && team.worker_ids.includes(controller))
  // ...and skipped for an EMPTY teams array, which is its own rejection tested
  // below: injecting into it would answer that test with a route error instead.
  if (!placed && Array.isArray(graph.teams) && graph.teams.length > 0
    && typeof controller === 'string' && AGENT_ID_RE.test(controller)) {
    graph.teams = [...graph.teams, teamOf('control', [controller])]
    graph.workflows = (graph.workflows || []).map((flow) => (Array.isArray(flow?.route)
      ? { ...flow, route: ['control', ...flow.route] }
      : flow))
  }
  return graph
}

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

// The template is the first graph anybody sees, so it is also the first thing
// that teaches the shape. Until 2026-07-31 it shipped four teams and one route
// with no front door at all: the validator enforced controller-as-team while
// the bundled example quietly demonstrated the opposite, and the whole suite
// stayed green through the change because nothing asserted this.
test('the bundled template leads with the controller team', () => {
  const value = accepted(DEFAULT_WORKFLOW_GRAPH)
  assert.equal(value.controller_team, 'control')
  const control = value.teams.find((team) => team.team_id === 'control')
  assert.deepEqual(control.worker_ids, [DEFAULT_WORKFLOW_GRAPH.outer_controller_id],
    'the control team holds the controller itself, not a second seat')
  assert.equal(control.wip_limit, 1, 'the front door holds one request at a time')
  for (const workflow of value.workflows) {
    assert.equal(workflow.route[0], 'control',
      `${workflow.workflow_id} must enter through the front door`)
  }
})

// One route cannot show that teams are a pool: with a single workflow, "the
// route" and "the board" are the same picture, and the difference between them
// is exactly what a reader has to learn.
test('the bundled template ships several routes over one pool of teams', () => {
  const value = accepted(DEFAULT_WORKFLOW_GRAPH)
  assert.ok(value.workflows.length >= 3, 'one route cannot show that teams are a pool')
  const [longest, ...rest] = value.workflows.map((workflow) => workflow.route)
  for (const route of rest) {
    const skipped = longest.filter((teamId) => !route.includes(teamId))
    assert.ok(skipped.length > 0, 'every other route must skip teams the longest one uses')
    for (const teamId of skipped) {
      assert.ok(value.teams.some((team) => team.team_id === teamId),
        `${teamId} is skipped by a route but must still exist on the board`)
    }
  }
  // Routes that skip DIFFERENT teams: two routes missing the same teams would
  // teach the same lesson twice and the pool would still look like a pipeline.
  const shapes = new Set(rest.map((route) => route.join('>')))
  assert.equal(shapes.size, rest.length)
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

  // The other half, reversed by D6 on 2026-08-08. This test used to assert that
  // a graph putting the controller in no team "is the graph this system has
  // always accepted" — and it was, which is exactly what was wrong with it. §6
  // places a token by its last event's `agent_id`, so on such a graph anything
  // the outer controller writes belongs to no team: a token parked on a
  // question orphans, holds nobody's WIP and stops nothing. The stop mechanism
  // is the whole point of the system, and it silently did not apply.
  const controllerless = {
    project_id: 'p',
    outer_controller_id: 'pm',
    outer_controller_model: 'model-pm',
    teams: [teamOf('build', ['b_w1']), teamOf('verify', ['v_w1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'verify'] }],
  }
  const refused = validateWorkflowGraph(controllerless)
  assert.equal(refused.ok, false, 'a graph with no control team is refused at load')
  assert.match(refused.reason, /worker on no team/)
  // The refusal has to say how to fix it. A loader that only says no turns a
  // one-line declaration change into a reading exercise in this file.
  assert.match(refused.reason, /worker_ids/)
  assert.match(refused.reason, /start every route there/)
})

test('a key the loader does not read is refused, not silently dropped', () => {
  // The oldest defect shape in this system: not a wrong answer, an unasked
  // question. A workflow could declare `when`, `sla_hours`, anything at all, and
  // the loader answered ok while the field vanished at `workflows.push`. GitHub
  // #47 phase 1 gave this treatment to a seat override and a palette entry and
  // stopped there — so the strictest checks in the file sat INSIDE the most
  // permissive ones.
  const flow = rejected(graphWith({
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'verify'], sla_hours: 4 }],
  }))
  assert.match(flow, /sla_hours/, 'the refusal names the key the operator wrote')
  assert.match(flow, /workflow_id, name and route/, 'and says what may be declared instead')

  const team = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { on_call: 'someone' }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(team, /on_call/)
  assert.match(team, /a team declares/)

  // `downstream_team_id` keeps its older, more specific redirect — a field
  // operators actually reached for deserves the better sentence, and the generic
  // message must not swallow it.
  assert.match(rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { downstream_team_id: 'verify' }), teamOf('verify', ['v_w1'])],
  })), /routing into workflows/)
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
  assert.deepEqual(workflowAgentIds(value),
    ['build_d', 'b_w1', 'b_w2', 'build_e', 'verify_d', 'v_w1', 'verify_e', 'control_d', 'pm', 'control_e'])
  assert.deepEqual(teamRoleOf(value, 'b_w2'), { team_id: 'build', team_name: 'BUILD', role: 'worker' })
  assert.deepEqual(teamRoleOf(value, 'verify_e'), { team_id: 'verify', team_name: 'VERIFY', role: 'evaluator' })
  // Reversed by D6: this asserted `null` and said "the controller is not a team
  // member", which was true and was the defect — a seat in no team places
  // nowhere, so everything it wrote orphaned. It is now a team's only worker,
  // and that is what gives a parked question a WIP slot to hold.
  assert.deepEqual(teamRoleOf(value, 'pm'), { team_id: 'control', team_name: 'CONTROL', role: 'worker' })
  assert.match(value.source_digest, /^sha256:[0-9a-f]{64}$/)
})

test('the digest follows the declaration, models included', () => {
  const base = accepted(graphWith())
  const other = accepted(graphWith({ outer_controller_model: 'model-pm-2' }))
  assert.notEqual(base.source_digest, other.source_digest,
    'a changed model is a changed declaration')
  assert.equal(deriveWorkflowGraphDigest({ a: 1 }), deriveWorkflowGraphDigest({ a: 1 }))
})

// ── AC77-AC80: a seat may differ from its role ──────────────────────────────
//
// `models` and `adapters` bind per ROLE, so every worker on a team ran one
// model on one lane and a two-model team could not be declared at all. GitHub
// #24. `seats` is the exception list; every way of declaring one and saying
// nothing is refused rather than ignored, because an entry that resolves to the
// role default is a declaration a reader would believe.

test('a seat overrides its role model and lane, and only that seat', () => {
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1', 'b_w2'], {
        adapters: { dispatcher: 'claude', worker: 'claude', evaluator: 'claude' },
        seats: { b_w2: { model: 'cheap-model', adapter: 'codex' } },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const build = value.teams.find((team) => team.team_id === 'build')
  const seat = (id) => build.agents.find((agent) => agent.agent_id === id)
  assert.equal(seat('b_w2').model, 'cheap-model')
  assert.equal(seat('b_w2').adapter, 'codex')
  // Its neighbour on the same role is untouched — an override, not a team-wide
  // change wearing one seat's name.
  assert.equal(seat('b_w1').model, build.models.worker)
  assert.equal(seat('b_w1').adapter, 'claude')
  // The role block still states the DEFAULT it was computed from; agents[] is
  // the answer, and nothing may pair a role back to models[] by hand.
  assert.equal(build.adapters.worker, 'claude')
})

test('a seat can declare a display_model that travels with the agent, separately from the dispatch model', () => {
  // The dispatch layer sends `model` (often an alias the adapter accepts); the
  // display layer shows `display_model` (the real model name). Two facts, one
  // seat — they must not swap, and a neighbour must stay untouched.
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1', 'b_w2'], {
        seats: { b_w2: { model: 'opus', display_model: 'qwen3.8-max-preview' } },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const build = value.teams.find((team) => team.team_id === 'build')
  const seat = (id) => build.agents.find((agent) => agent.agent_id === id)
  assert.equal(seat('b_w2').model, 'opus')
  assert.equal(seat('b_w2').display_model, 'qwen3.8-max-preview')
  assert.equal(seat('b_w1').model, build.models.worker)
  assert.equal(seat('b_w1').display_model, null)
})

test('an invalid display_model is rejected, naming the team and the seat', () => {
  // A control character in the display model is an escape sequence that could
  // reach the page — rejected exactly like the dispatch model is.
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { seats: { b_w1: { display_model: `deepseek${ESC}[31m` } } }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /display_model/)
  assert.match(reason, /invalid/)
  assert.match(reason, /build/)
})

test('display_model is optional — a seat without it normalizes to null, not a role default', () => {
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1'], { seats: { b_w1: { model: 'opus' } } }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const build = value.teams.find((team) => team.team_id === 'build')
  const seat = build.agents.find((agent) => agent.agent_id === 'b_w1')
  assert.equal(seat.display_model, null)
})

test('a graph that declares no seat, or restates one, is the graph it already was', () => {
  const bare = accepted(graphWith())
  const empty = accepted(graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { seats: {} }), teamOf('verify', ['v_w1'])],
  }))
  // Restating the role's own value is not a change, which is the rule §3.1
  // already applies to a `wip_limit` that matches its worker count.
  const restated = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1', 'b_w2'], { seats: { b_w2: { model: MODELS.worker } } }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  assert.equal(empty.source_digest, bare.source_digest)
  assert.equal(restated.source_digest, bare.source_digest)
})

test('every way of declaring a seat and saying nothing is refused', () => {
  const withSeats = (seats) => graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { seats }), teamOf('verify', ['v_w1'])],
  })
  for (const [seats, needle] of [
    [{ ghost: { model: 'm' } }, /not a seat on this team/],
    [{ b_w2: {} }, /empty seat/],
    [{ b_w2: { modle: 'm' } }, /unknown key/],
    [{ b_w2: { model: '' } }, /invalid model on the seat/],
    [{ b_w2: { adapter: 'kimi' } }, /unknown adapter on the seat/],
    [{ b_w2: 'codex' }, /not an object/],
  ]) {
    const reason = rejected(withSeats(seats))
    assert.match(reason, needle)
    assert.match(reason, /build/, 'a rejection names the team')
  }
  assert.match(rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { seats: [] }), teamOf('verify', ['v_w1'])],
  })), /seats that are not an object/)
})

test('a seat for the outer controller is refused, because the dispatch would ignore it', () => {
  // It names its model in outer_controller_model and its lane in
  // outer_controller_adapter, and declaredModel/declaredAdapter read those
  // first. A seat entry here validates, moves source_digest and draws on the
  // page — then loses silently at dispatch.
  const reason = rejected(graphWith({
    outer_controller_id: 'pm',
    teams: [
      teamOf('control', ['pm'], { seats: { pm: { adapter: 'codex' } } }),
      teamOf('build', ['b_w1']),
    ],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build'] }],
  }))
  assert.match(reason, /outer controller/)
  assert.match(reason, /outer_controller_adapter/)
})
