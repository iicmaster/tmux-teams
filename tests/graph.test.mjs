// graph.test.mjs — the loop graph page and the pull system behind it.
//
// The page can fail in exactly one way that matters: showing something no
// evidence supports. Every case here pins that line, plus the two layout facts
// a reader depends on (one node per agent, and the PM reaching every team).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_WORKFLOW_GRAPH, readWorkflowGraph, renderGraphPage,
  activityByAgent, frontDoorStatus,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import { readWorkItems, teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { gateHistory } from './fixture-gate.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'
import { EVENT_SPEC, LEDGER_EVENTS } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'

const repoWith = (graph) => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  mkdirSync(join(dir, '.tmux-teams'), { recursive: true })
  if (graph !== undefined) writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(graph))
  return dir
}

const snapshotWith = (runs = [], recentVerdicts = []) => ({
  snapshot_id: 'test:1',
  generated_at: '2026-07-27T00:00:00.000Z',
  scope: { repo_name: 'demo' },
  runs,
  history: { runs: [], total: 0, truncated: 0 },
  recent_verdicts: recentVerdicts,
})

const run = (agentId, state, extra = {}) => ({
  agent_id: agentId, task_id: `t-${agentId}`, state, worker: 'claude', transport: 'acp',
  model: null, workflow: 'full', started_at: '2026-07-27T00:00:00.000Z', ...extra,
})

// No `wip_limit` here on purpose: it is not a declared input any more — a team
// can hold exactly as many tokens as it has workers. Models are declared and
// their values are never checked against a list; only the shape is.
const MODELS = { dispatcher: 'opus-5', worker: 'sonnet-5', evaluator: 'opus-5' }

const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'opus-5',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1', 'b_w2'], evaluator_id: 'b_e', models: MODELS },
    { team_id: 'verify', name: 'Verify', dispatcher_id: 'v_d', worker_ids: ['v_w1'], evaluator_id: 'v_e', models: MODELS },
  ],
  workflows: [
    { workflow_id: 'full', name: 'Full', route: ['build', 'verify'] },
    { workflow_id: 'quick', name: 'Quick', route: ['build'] },
  ],
}

const graphOf = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

// ── the declaration ──────────────────────────────────────────────────────────

test('the bundled template satisfies the workflow contract', () => {
  assert.equal(validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH).ok, true)
})

test('a repo with no declared graph falls back to the bundled template', () => {
  const graph = readWorkflowGraph(repoWith(undefined))
  assert.equal(graph.ok, true)
  assert.equal(graph.source, 'default')
})

test('an invalid graph fails closed instead of silently using the default', () => {
  const dir = repoWith({ teams: [{ team_id: 'solo' }], workflows: [] })
  assert.equal(readWorkflowGraph(dir).ok, false)
  const page = renderGraphPage(dir, snapshotWith())
})

test('routing lives on the workflow, never inside a team', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) => ({ ...entry, downstream_team_id: null })),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /downstream_team_id belongs to a workflow route/)
})

test('a route never revisits a team — work goes back by rejection, not routing', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    workflows: [{ workflow_id: 'loop', name: 'Loop', route: ['build', 'verify', 'build'] }],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /visits team build twice/)
})

// GitHub #31 stage 1: `produces` is optional and defaults to 'artifact' so
// every graph written before this field existed keeps validating and keeps
// meaning exactly what it meant.
test('a team with no declared produces defaults to artifact', () => {
  const graph = graphOf(TWO_TEAMS)
  assert.equal(graph.teams.find((entry) => entry.team_id === 'build').produces, 'artifact')
})

test('a team may declare it produces a verdict rather than an artifact', () => {
  const graph = graphOf({
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) =>
      entry.team_id === 'verify' ? { ...entry, produces: 'verdict' } : entry),
  })
  assert.equal(graph.teams.find((entry) => entry.team_id === 'build').produces, 'artifact')
  assert.equal(graph.teams.find((entry) => entry.team_id === 'verify').produces, 'verdict')
})

test('a team cannot declare a produces word outside the closed vocabulary', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) =>
      entry.team_id === 'verify' ? { ...entry, produces: 'opinion' } : entry),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /declares produces "opinion"/)
})

// ── the drawing ──────────────────────────────────────────────────────────────
//
// The page draws itself from a JSON block, so these read that block rather than
// grep an SVG string: it is the same data the browser gets, and an assertion
// against it cannot pass because some unrelated markup happened to match.

const tourOf = (graph, snapshot = snapshotWith()) => {
  const page = renderGraphPage(repoWith(graph), snapshot)
  const block = page.match(/<script type="application\/json" data-tour-data>([\s\S]*?)<\/script>/)
  assert.ok(block, 'the page ships no tour data at all')
  return JSON.parse(block[1])
}
const wire = (tour, from, to, kind) =>
  tour.edges.find((e) => e.from === from && e.to === to && e.kind === kind)

test('a team shared by two workflows is still drawn once, with every agent', () => {
  const tour = tourOf(TWO_TEAMS)
  const declared = graphOf(TWO_TEAMS).teams.flatMap((entry) => entry.agents.map((a) => a.agent_id))
  assert.equal(declared.length, 7)
  for (const agentId of declared) {
    assert.ok(tour.world[agentId], `${agentId} is on the board`)
  }
  // `world` is keyed by agent id, so a duplicate could only appear as a second
  // node carrying the same title — which is exactly how the controller used to
  // be drawn twice, once as a band and once as a worker card.
  // The controller in this fixture holds no team seat, so it is not on the
  // board at all — and the page has to say that out loud rather than draw a
  // board that silently has no way in.
  assert.equal(tour.world.pm, undefined)
  assert.match(renderGraphPage(repoWith(TWO_TEAMS), snapshotWith()),
    /The controller <code>pm<\/code> holds no team seat/)
})

test('a seat with display_model shows the real model name, not the dispatch alias', () => {
  // The dispatch layer sends an alias the adapter accepts; the page must show
  // the real model the operator declared for that seat — never the alias a
  // reader would have to reverse-engineer.
  const graph = {
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) => entry.team_id === 'build'
      ? { ...entry, seats: { b_w1: { model: 'opus', display_model: 'qwen3.8-max-preview' } } }
      : entry),
  }
  const tour = tourOf(graph, snapshotWith([run('b_w1', 'delivered', { model: 'opus' })]))
  const modelLine = (id) => tour.world[id].lines.find((l) => l.startsWith('model '))
  assert.equal(modelLine('b_w1'), 'model qwen3.8-max-preview')
  // A neighbour without display_model keeps the verified model as-is.
  assert.equal(modelLine('b_w2'), 'model —')
})

// v0.15.0 release review (gpt-5.6-luna), CONFIRMED under re-verification. The
// test above passes whether `display_model` translates a VERIFIED model or
// replaces one — its seat has a verified run either way. These two pin the
// difference, which is §12.7 honesty law 2: never show a model that was not
// verified.

test('a declared display_model on a seat that never ran is not printed as a model', () => {
  const graph = {
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) => entry.team_id === 'build'
      ? { ...entry, seats: { b_w1: { model: 'opus', display_model: 'claimed-without-proof' } } }
      : entry),
  }
  // No run for b_w1 at all — nothing was measured, so there is nothing to show.
  const tour = tourOf(graph, snapshotWith([]))
  const line = tour.world['b_w1'].lines.find((l) => l.startsWith('model '))
  assert.equal(line, 'model —',
    'an operator declaration must never render in the shape a verified model uses')
})

test('a run with no verified model does not borrow the declared one', () => {
  const graph = {
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) => entry.team_id === 'build'
      ? { ...entry, seats: { b_w1: { model: 'opus', display_model: 'claimed-without-proof' } } }
      : entry),
  }
  // The run happened; the model was never confirmed. The page must say that,
  // not fill the gap with the declaration.
  const tour = tourOf(graph, snapshotWith([run('b_w1', 'delivered', {})]))
  const line = tour.world['b_w1'].lines.find((l) => l.startsWith('model '))
  assert.notEqual(line, 'model claimed-without-proof',
    'an unverified run must not be labelled with the declared model')
})

test('a died run shows process not found only while the death is recent', () => {
  // The node's run state is the pulse's own measurement; a run that died long
  // ago is a seat that is idle again, not a seat that is broken. The page
  // must stop labelling a ready seat red forever.
  const stale = run('b_w1', 'died', { elapsed_sec: 10000, timeout_sec: 1800 })
  const tour = tourOf(TWO_TEAMS, snapshotWith([stale]))
  assert.equal(tour.world['b_w1'].status, 'other')
  // A recent death is still worth seeing.
  const recent = run('b_w1', 'died', { elapsed_sec: 100, timeout_sec: 1800 })
  const tour2 = tourOf(TWO_TEAMS, snapshotWith([recent]))
  assert.equal(tour2.world['b_w1'].status, 'dead')
})

test('the controller is one node — never a node and a band as well', () => {
  const tour = tourOf(DEFAULT_WORKFLOW_GRAPH)
  const seat = DEFAULT_WORKFLOW_GRAPH.outer_controller_id
  assert.equal(tour.world[seat], undefined, 'the controller is not a card of its own')
  const control = tour.world['team:control']
  assert.ok(control && control.kind === 'control', 'it IS the control team node')
  assert.equal(Object.values(tour.world).filter((n) => n.kind === 'control').length, 1)
})

test('the controller team is the head of every route, and never escalates to itself', () => {
  const tour = tourOf(DEFAULT_WORKFLOW_GRAPH)
  const control = 'team:control'
  assert.ok(tour.world[control], 'the control team is on the board')
  // No node for the incoming request: it would carry no evidence, no WIP and no
  // seat. Every route starting at control already says work enters there.
  assert.equal(tour.world.request, undefined)
  for (const workflow of DEFAULT_WORKFLOW_GRAPH.workflows) {
    // The route is an order over the board's own wires, not wires of its own.
    const order = tour.orders[workflow.workflow_id]
    assert.ok(order.length > 0)
    assert.match(order[0], /^team:control>.*>pull$/, 'work is pulled out of the front door')
    // Custody ends at the last team: it writes `completed`, and the audit is a
    // releasing event that never takes the token back.
    for (const key of order) assert.match(key, />pull$/)
  }
  const passed = tour.edges.filter((e) => e.kind === 'passed')
  assert.equal(passed.length, 1, 'one line out of the audit, not one per route')
  assert.equal(passed[0].from, control)

  // Every delivery team can interrupt the controller, route or no route.
  const delivery = DEFAULT_WORKFLOW_GRAPH.teams.length - 1
  assert.equal(tour.edges.filter((e) => e.kind === 'escalate').length, delivery)
  for (const edge of tour.edges.filter((e) => e.kind === 'send')) assert.equal(edge.from, control)
  for (const edge of tour.edges.filter((e) => e.kind === 'audit')) assert.equal(edge.to, control)
  // Work crosses between teams directly, which is what the pull controller does.
  assert.ok(tour.edges.some((e) => e.kind === 'pull'))
})

test('a team\'s internal lines never harden, but its verdict counter still fills', () => {
  const dry = tourOf(TWO_TEAMS)
  assert.equal(wire(dry, 'b_d', 'b_w1', 'assign').solid, false)

  // A dispatch is observed on this worker and the line does not change: the
  // relationship was true before the dispatch and is true after it.
  const live = tourOf(TWO_TEAMS, snapshotWith([run('b_w1', 'running')]))
  assert.equal(wire(live, 'b_d', 'b_w1', 'assign').solid, false)
  assert.equal(wire(live, 'b_w1', 'b_e', 'judge').solid, false)
  assert.equal(wire(live, 'b_e', 'b_d', 'reject').solid, false)

  // The COUNTER is the part that still has to be right, and it is the half that
  // was actually broken: a verdict is recorded against the leg that was
  // JUDGED — the worker's — and keying it off the evaluator's own id is why the
  // page read `0 pass 0 reject` no matter how much reviewing had happened.
  const rejected = tourOf(TWO_TEAMS,
    snapshotWith([run('b_w1', 'running')], [{ agent_id: 'b_w1', pm_verdict: 'reject' }]))
  assert.equal(wire(rejected, 'b_e', 'b_d', 'reject').solid, false, 'rework is a line, not a tally')
  assert.match(rejected.world.b_e.state, /0 pass 1 reject/)
  assert.match(tourOf(TWO_TEAMS).world.b_e.state, /0 pass 0 reject/)
})

test('the outer controller states the same facts as every other agent', () => {
  // The PM band was hand-drawn instead of going through the node renderer, so
  // every fact line added to agents later — lane, model, clock, status — never
  // reached it. It showed an id and a sentence, which is a label, not evidence.
  // The controller has no card of its own any more, so the control team node
  // carries its evidence. Dropping the card must not drop the facts.
  const seat = DEFAULT_WORKFLOW_GRAPH.outer_controller_id
  const idle = tourOf(DEFAULT_WORKFLOW_GRAPH).world['team:control']
  assert.ok(idle, 'the control team is on the board')
  assert.ok(idle.lines.some((line) => /· —$/.test(line)), 'it states its lane')
  assert.ok(idle.lines.some((line) => line.startsWith('model ')), 'it states its model')

  // And a state in its own words. For an exception handler, nothing to do is the
  // correct state and good news; reporting it exactly like an agent that was
  // never wired up is what made this node read as dead.
  assert.equal(idle.state, 'watching — no exception open')
  assert.equal(idle.status, 'watching')

  const ran = tourOf(DEFAULT_WORKFLOW_GRAPH,
    snapshotWith([run(seat, 'running', { elapsed_sec: 90 })])).world['team:control']
  assert.ok(ran.lines.some((line) => line.includes('claude · acp')), 'it states a measured lane')
  // The clock lives outside `lines` so a running timestamp cannot make every
  // publish look like a change to the board.
  assert.match(ran.time, /1m in progress/, 'it states a measured clock')
  assert.equal(ran.state, 'reviewing the board now')
  assert.equal(ran.status, 'working')
})

// ── loop health ──────────────────────────────────────────────────────────────
//
// Everything else on this page describes the AGENTS. A runner that stopped
// dispatching leaves a board that looks calm — nobody running, nothing overdue —
// and a reader concludes there is simply no work. These cases pin the page
// saying, in words, whether the loop itself is still alive.

const NOW = Date.parse('2026-07-27T00:00:00.000Z')
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString()

// A raw string goes to disk untouched, so a malformed heartbeat can be tested.
const beat = (dir, body) => {
  writeFileSync(join(dir, '.tmux-teams/runner-heartbeat.json'),
    typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}

const heartbeat = (over = {}) => ({
  schema: 'tmux-teams.runner-heartbeat', at: ago(10), tick_sec: 20,
  dispatching: true, reason: '', started: 2, held: 1, ...over,
})

// A fixed clock: an age measured against the wall clock would drift the copy.
const pageOf = (dir) => renderGraphPage(dir, snapshotWith(), { now: NOW })

// ── the declaration survived being renamed ──────────────────────────────────
//
// `team-graph.json` became `graph.json` on 2026-07-29. A missing declaration
// falls back to the bundled four-team template, so a bare rename would have
// left every existing repo drawing teams nobody declared — no error, no
// diagnostic, and a page that looks entirely normal. The legacy name is still
// read, and `source` states which file answered so nobody has to guess.
test('a repo still holding the old file name keeps its teams, and says which file answered', () => {
  const dir = repoWith(undefined)
  writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(TWO_TEAMS))
  const legacy = readWorkflowGraph(dir)
  assert.equal(legacy.ok, true)
  assert.equal(legacy.source, 'team-graph.json')
  assert.deepEqual(legacy.value.teams.map((team) => team.team_id), ['build', 'verify'])

  // The new name wins when both exist — a repo mid-migration must not have its
  // current declaration shadowed by the file it is migrating away from.
  writeFileSync(join(dir, '.tmux-teams/graph.json'),
    JSON.stringify({ ...TWO_TEAMS, project_id: 'current' }))
  const current = readWorkflowGraph(dir)
  assert.equal(current.source, 'graph.json')
  assert.equal(current.value.project_id, 'current')
})

test('a declaration that exists but cannot be parsed fails closed, it does not become the default', () => {
  // §3: the bundled default is for a repo with NO declaration. One `catch` used
  // to cover the read and the parse together, so a corrupt file was
  // indistinguishable from an absent one — the page drew four teams nobody
  // declared while `graph.mjs check` exited 0. Found by an outside review with
  // a probe; this is the control proving the branch now fires.
  const dir = repoWith(undefined)
  writeFileSync(join(dir, '.tmux-teams/graph.json'), '{ "teams": [ this is not json')
  const broken = readWorkflowGraph(dir)
  assert.equal(broken.ok, false)
  assert.equal(broken.source, 'graph.json')
  assert.match(broken.reason, /not valid JSON/)

  // A corrupt new file must not be rescued by an intact legacy one either —
  // that would resurrect the silent substitution through the migration path.
  writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(TWO_TEAMS))
  assert.equal(readWorkflowGraph(dir).ok, false, 'a broken graph.json is not repaired by team-graph.json')
})

test('a repo with neither file still says it is on the bundled default', () => {
  // The fallback is not the bug. Answering from it without saying so was.
  assert.equal(readWorkflowGraph(repoWith(undefined)).source, 'default')
})

// ── the controller counts what it did, not what it was asked ────────────────
//
// Its node read `0 escalation(s) handled` however much it had done, because
// `escalations` is bumped on the agent BEING escalated — the runner stamps that
// event with the dispatcher it is escalating, never with the controller reading
// it. Meanwhile the controller's only two outputs, `audited` and `resumed`,
// were counted nowhere. Master reported this node as empty twice; the node was
// drawn correctly and had nothing to draw.

const withLedger = (graph, token, entries, gate = {}) => {
  const dir = repoWith(graph)
  mkdirSync(join(dir, '.tmux-teams/work-items'), { recursive: true })
  // Gated before it reaches disk: this page answers entirely from custody, so a
  // history the loop could not have written makes every node on it a claim
  // about a different system.
  const history = gateHistory(token,
    entries.map((entry) => ({ work_item: token, workflow: 'full', ...entry })), gate)
  writeFileSync(join(dir, `.tmux-teams/work-items/${token}.jsonl`),
    `${history.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return dir
}

test('the controller node states the audits it gave, not the requests it got', () => {
  const dir = withLedger(TWO_TEAMS, 'tok', [
    { at: '2026-07-27T09:00:00.000Z', event: 'completed', from_team: 'verify' },
    { at: '2026-07-27T09:10:00.000Z', event: 'audit_requested', agent_id: 'pm', task_id: 'a-1', reason: 'route finished' },
    { at: '2026-07-27T09:20:00.000Z', event: 'audited', agent_id: 'pm', verdict: 'concern', reason: 'four findings' },
  ])
  const page = renderGraphPage(dir, snapshotWith(), { now: NOW })
  assert.match(page, /1 audited/, 'the sink counts the audit that was given')
  assert.doesNotMatch(page, /1 handled/, 'never the requests it received')
  // The old line counted requests under the word "handled". Both the wording
  // and the counter were wrong, so neither may come back.
})

// Rewritten from AC18, which asked this of a rendered SVG. What it was really
// asking is whether `activityByAgent` credits each role for the work the ledger
// records — a fact about the function, reachable without drawing anything.
test('every role is credited with the work the ledger records for it', () => {
  const dir = withLedger(TWO_TEAMS, 'tok', [
    { at: '2026-07-27T01:00:00.000Z', event: 'pulled', agent_id: 'b_d', from_team: 'build', to_team: 'build' },
    { at: '2026-07-27T01:05:00.000Z', event: 'intake', agent_id: 'b_d', verdict: 'accept', reason: 'ok' },
    // Each delivery carries the assignment that produced it — a worker cannot
    // deliver a task nobody gave it, and the gate says so.
    { at: '2026-07-27T01:50:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T02:00:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T02:20:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-2', dispatch_id: 'd-2' },
    { at: '2026-07-27T02:30:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-2', terminal: 'protocol-error', timed_out: false, evidence_present: false },
    { at: '2026-07-27T03:00:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 't-1', reason: 'thin' },
    // The handoff this refusal refuses. Without it the fixture said Build
    // admitted the token and then something sent it back across a boundary,
    // which §1 forbids — a refusal is a door check, and a door needs an arrival
    // standing in front of it.
    { at: '2026-07-27T03:30:00.000Z', event: 'pulled', agent_id: 'v_d', from_team: 'build', to_team: 'verify' },
    { at: '2026-07-27T04:00:00.000Z', event: 'returned', to_team: 'build', refused_by: 'v_d', reason: 'not ours' },
    { at: '2026-07-27T05:30:00.000Z', event: 'resumed', agent_id: 'pm', to_team: 'build', grant: 3, reason: 'carry on' },
  ])
  const work = activityByAgent(readWorkItems(dir).items)

  assert.equal(work.get('b_d').accepted, 1, 'the dispatcher that accepted a handoff')
  // A refusal carries no `agent_id` on purpose — the refusing dispatcher is
  // named in `refused_by`, and crediting the wrong field is how a node ends up
  // reporting somebody else's work.
  assert.equal(work.get('v_d').returned, 1, 'the dispatcher that refused one')
  assert.equal(work.get('b_w1').delivered, 1, 'one delivery that produced an artifact')
  assert.equal(work.get('b_w1').failed, 1, 'one leg that did not')
  assert.equal(work.get('b_e').reject, 1, 'the evaluator that rejected')
  assert.equal(work.get('pm').resumes, 1, 'the controller states its own output')
  // An agent with nothing recorded is absent, not a zero that reads like a
  // measurement.
  assert.equal(work.has('t_w1'), false)
})

// §14.4: the family guarantee the board already has, now for this page. Every
// event that names an agent either credits that agent with work, or is listed
// here with the reason it does not — so a word added to §4 forces the decision
// instead of silently landing in neither column.
const NOT_THE_AGENTS_OWN_ACT = {
  opened: 'agent_id is the receiving dispatcher, which has not judged it yet',
  pulled: 'same — a pull is the taking team acting, not work finished',
  assigned: 'the dispatch, not its outcome; `delivered` or `lost` is the work',
  audit_requested: 'the runner asking the controller, not the controller acting',
}

test('every event that names an agent either credits it or is a stated exception', () => {
  const filler = {
    from_team: 'build', to_team: 'verify', refused_by: 'b_d', task_id: 't-1', dispatch_id: 'd-1',
    reviewed_task: 't-1', reason: 'a stated reason', terminal: 'done', timed_out: false,
    evidence_present: true, verdict: 'accept', grant: 3,
    questions: 'who is the target customer?', question_id: 'q-1',
  }
  for (const event of LEDGER_EVENTS) {
    const spec = EVENT_SPEC[event]
    if (!(spec.required ?? []).includes('agent_id')) continue
    const entry = { at: '2026-07-27T09:00:00.000Z', event, agent_id: 'b_w1' }
    for (const field of spec.required) if (field !== 'agent_id') entry[field] = filler[field]
    // ADR 0002: `opened.actor` is who decided, always a person — not part of
    // `spec.required` (it is validated, not merely present), so the loop
    // above never fills it.
    if (event === 'opened') entry.actor = 'human:someone'
    // Called directly rather than rendered and pattern-matched. Whether an
    // event credits its agent is a fact about `activityByAgent`; reading it out
    // of markup made the assertion depend on layout and on a 400-character
    // window that could silently stop covering the line it was aimed at.
    // `delivered` needs the leg that produced it, or the history is one the
    // loop cannot write. The sweep asks only what the LAST event credits, so
    // the prefix is the minimum that makes the history real.
    const assigned = { at: '2026-07-27T08:58:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-1', dispatch_id: 'd-1' }
    const delivered = { at: '2026-07-27T08:59:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true }
    const prefix = event === 'reviewed' ? [assigned, delivered]
      : event === 'delivered' ? [assigned]
        : event === 'audited' ? [{ at: '2026-07-27T08:59:00.000Z', event: 'audit_requested', agent_id: 'pm', task_id: 'a-1', reason: 'r' }]
          : []
    // Each event owns its verdict vocabulary — one shared filler word violates
    // whichever rule it does not belong to.
    if ('verdict' in entry) {
      entry.verdict = event === 'reviewed' ? 'pass' : 'accept'
    }
    const { items } = readWorkItems(withLedger(TWO_TEAMS, `t-${event}`, [...prefix, entry]))
    const noticed = activityByAgent(items).has('b_w1')
    const excused = event in NOT_THE_AGENTS_OWN_ACT
    assert.equal(noticed, !excused, excused
      ? `${event} is excused (${NOT_THE_AGENTS_OWN_ACT[event]}) but was counted anyway`
      : `${event} names an agent and credits it with nothing — count it, or state why not`)
  }
})

// The three pages are published side by side and answer three different
// questions about one run. Reaching the other two used to mean knowing their
// filenames. Asserted on structure, never on the labels, which are copy.
test('the graph publishes the nav it shares with pulse and the board', () => {
  const page = pageOf(repoWith(TWO_TEAMS))
  for (const sibling of ['pulse.html', 'kanban.html']) {
    assert.ok(page.includes(`href="${sibling}"`), `${sibling} is reachable without knowing its name`)
  }
  // This page is the one you are on, so it is the one entry that is not a link.
  assert.match(page, /<strong aria-current="page"[^>]*>Loop graph</)
  assert.doesNotMatch(page, /href="graph\.html"/)
})

test('a repo where the runner has never run says so instead of looking calm', () => {
  const page = pageOf(repoWith(TWO_TEAMS))
  assert.match(page, /NO RUNNER/)
  assert.match(page, /has never run in this repo/)
  // The dangerous failure is the opposite claim, made by silence.
  assert.doesNotMatch(page, /DISPATCHING/)
})

test('a heartbeat older than three of its own ticks reads as not responding', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(61) })))
  assert.match(page, /NOT RESPONDING/)
  // `dispatching: true` is what the runner believed one tick before it stopped.
  // A dead runner claiming to dispatch is exactly the calm-looking lie.
  assert.doesNotMatch(page, /class="lh-state">DISPATCHING/)
})

test('a stale hold is reported as what the runner last said, not as a hold in progress', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS),
    heartbeat({ at: ago(300), dispatching: false, reason: 'pulse.json is stale' })))
  assert.match(page, /NOT RESPONDING/, 'five minutes of silence is not a hold in progress')
  assert.match(page, /pulse\.json is stale/, "and the runner's own last words survive")
})

test('the runner is judged against its own tick, so a slow loop is not a dead one', () => {
  const edge = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(60), tick_sec: 20 })))
  assert.match(edge, /data-loop-health="dispatching"/, 'exactly 3x its tick is still alive')
  const past = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(61), tick_sec: 20 })))
  assert.match(past, /data-loop-health="stale"/, 'one second past 3x its tick is not')
  const slow = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(300), tick_sec: 600 })))
  assert.match(slow, /data-loop-health="dispatching"/, 'a ten-minute tick may be five minutes silent')
})

test('a runner that is deliberately holding shows the reason it gave, escaped', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS),
    heartbeat({ dispatching: false, reason: '<script>alert(1)</script> pulse.json is stale' })))

  // A hold with no reason is itself the thing to chase; the page never writes
  // one for the runner.
  const silent = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ dispatching: false, reason: '' })))
  assert.match(silent, /holding without saying why/)
})

test('a dispatching runner states the age of its last tick and what that tick did', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ started: 3, held: 1 })))
  assert.match(page, /DISPATCHING/)
  // What that tick DID, in the runner's own measured numbers — a zero it
  // measured is worth printing; a zero this page invented is the lie §12.7
  // forbids, which is why the copy says "not measured" rather than 0.
  assert.match(page, /\b3\b/, 'the count it started')
  assert.match(page, /\b1\b/, 'and the count it held')
})

test('a count the runner did not report is not printed as a zero', () => {
  const bare = heartbeat()
  delete bare.started
  delete bare.held
  const page = pageOf(beat(repoWith(TWO_TEAMS), bare))

  // A zero the runner did measure is a fact, and stays printable.
  const idle = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ started: 0, held: 0 })))
  assert.match(idle, /started in that tick: 0/)
})

test('an unreadable heartbeat is not reported as a runner that never ran', () => {
  const broken = pageOf(beat(repoWith(TWO_TEAMS), 'not json'))
  assert.match(broken, /data-loop-health="unreadable"/)
  assert.match(broken, /not valid JSON/)
  assert.doesNotMatch(broken, /never run in this repo/)

  const foreign = pageOf(beat(repoWith(TWO_TEAMS),
    { schema: 'something.else', at: ago(1), tick_sec: 20, dispatching: true }))
  assert.match(foreign, /data-loop-health="unreadable"/)
})

test('a heartbeat that cannot be judged says so rather than guessing', () => {
  const undated = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: 'whenever' })))
  assert.match(undated, /data-loop-health="unmeasured"/)
  assert.match(undated, /no usable timestamp/)

  const noTick = heartbeat()
  delete noTick.tick_sec
  assert.match(pageOf(beat(repoWith(TWO_TEAMS), noTick)), /did not report its tick interval/)

  const mute = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ dispatching: 'yes' })))
  assert.match(mute, /did not say whether it is dispatching/)
  assert.doesNotMatch(mute, /data-loop-health="holding"/)

  const ahead = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(-90) })))
  assert.match(ahead, /the two clocks disagree/)

  // A caller's broken clock is this page's fault, and is never reported as the
  // runner disagreeing about the time.
  const noClock = renderGraphPage(beat(repoWith(TWO_TEAMS), heartbeat()), snapshotWith(), { now: null })
  assert.match(noClock, /data-loop-health="unmeasured"/)
  assert.match(noClock, /could not read its own clock/)
})

test('loop health is readable without colour: a state word and a shape, not a hue', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(600) })))
  // Colour alone fails a greyscale print and a colour-blind reader, so the
  // state has to survive without it: a word and a shape carry it, and the
  // shape is aria-hidden because the word already says it out loud.
  assert.match(page, /class="lh-state">NOT RESPONDING</)
  assert.match(page, /class="lh-mark" aria-hidden="true">■</)
})

// ── the pull system ──────────────────────────────────────────────────────────

const ledger = (id, events) => [id, {
  work_item: id, workflow: 'full', custody: events,
  current_agent: events[events.length - 1].agent_id,
}]

// A worker finishing is not the team finishing. Work sits in its team's done
// queue only once that team's own evaluator has passed it — so the fixture for
// "ready to move on" ends in a review, not a delivery.
//
// Every field contract §4 names is stated, uninteresting ones included. Since
// DECISION 4 the pull controller validates a token's whole history before
// handing it on, so a shorthand history is refused as `invalid` rather than
// pulled — and this fixture exists to reach the pull decision, not to test the
// validator.
const delivered = (id, agentId, hour) => ledger(id, [
  {
    at: `2026-07-27T0${hour}:00:00.000Z`, event: 'assigned', work_item: id, workflow: 'full',
    agent_id: agentId, task_id: `${id}-1`, dispatch_id: `${id}-d1`,
  },
  {
    at: `2026-07-27T0${hour}:20:00.000Z`, event: 'delivered', work_item: id, workflow: 'full',
    agent_id: agentId, task_id: `${id}-1`, terminal: 'done', timed_out: false, evidence_present: true,
  },
  {
    at: `2026-07-27T0${hour}:30:00.000Z`, event: 'reviewed', work_item: id, workflow: 'full',
    agent_id: `${agentId.split('_')[0]}_e`, verdict: 'pass',
    reviewed_task: `${id}-1`, reason: 'it does what the request asked for',
  },
])

test('a team pulls work only while it is under its WIP limit', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = new Map([delivered('one', 'b_w1', 1), delivered('two', 'b_w1', 2), delivered('three', 'b_w1', 3)])
  const decisions = planPulls(graph, items, '2026-07-27T10:00:00.000Z')
  const pulled = decisions.filter((entry) => entry.action === 'pull')
  const blocked = decisions.filter((entry) => entry.action === 'blocked')
  assert.equal(pulled.length, 1, 'Verify has room for exactly one')
  assert.equal(blocked.length, 2)
  // Oldest delivery first: newest-first would starve whatever waited longest.
  assert.equal(pulled[0].work_item, 'one')
  assert.match(blocked[0].reason, /WIP limit \(1\/1\)/)
})

test('a team already holding work pulls nothing more', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = new Map([
    ledger('held', [{ at: '2026-07-27T01:00:00.000Z', event: 'pulled', work_item: 'held', workflow: 'full', agent_id: 'v_d' }]),
    delivered('next', 'b_w1', 2),
  ])
  assert.deepEqual(planPulls(graph, items, '2026-07-27T10:00:00.000Z').map((entry) => entry.action), ['blocked'])
})

test('the last team on a route completes instead of pulling nowhere', () => {
  const [decision] = planPulls(graphOf(TWO_TEAMS), new Map([delivered('done', 'v_w1', 1)]), '2026-07-27T10:00:00.000Z')
  assert.equal(decision.action, 'complete')
  assert.equal(decision.event.event, 'completed')
})

test('a pull is recorded as an act of the receiving dispatcher', () => {
  const [decision] = planPulls(graphOf(TWO_TEAMS), new Map([delivered('one', 'b_w1', 1)]), '2026-07-27T10:00:00.000Z')
  assert.equal(decision.event.event, 'pulled')
  assert.equal(decision.event.agent_id, 'v_d')
  assert.equal(decision.event.from_team, 'build')
  assert.equal(decision.event.to_team, 'verify')
})

// ── the opening board reports a live state ───────────────────────────────────

test('a seat with a dispatch running on it is marked working, on every scene', () => {
  // Scene 0 is the live one: it answers what is happening now, not what the
  // routes look like. So "working" has to reach the board as data — the client
  // rings and crawls off this, and off nothing to do with which route is shown.
  const idle = tourOf(TWO_TEAMS)
  assert.equal(idle.world.b_w1.status, 'unbound')

  const live = tourOf(TWO_TEAMS, snapshotWith([run('b_w1', 'running')]))
  assert.equal(live.world.b_w1.status, 'working')
  assert.match(live.world.b_w1.state, /work/i)
  // Its neighbour is not: a running seat is one seat, not a lit-up team.
  assert.equal(live.world.b_w2.status, 'unbound')
})

// ── the page must not claim more than the evidence ───────────────────────────

test('a declaration that exists but cannot be read fails closed', () => {
  // §3: absent is the ONLY condition the bundled default is for. A directory
  // where the file should be used to read as "no graph here", so the page drew
  // somebody else's four-team template and `check` exited 0.
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  mkdirSync(join(dir, '.tmux-teams/graph.json'), { recursive: true })
  const read = readWorkflowGraph(dir)
  assert.equal(read.ok, false, 'unreadable is not absent')
  assert.match(read.reason, /could not be read/)
  assert.notEqual(read.source, 'default', 'and it must not fall back to the template')
})

test('a full front door is reported as blocked, never as watching', () => {
  // The controller node also carries `WIP 1/1 · full`. Saying "no exception
  // open" beside it put two contradicting facts on one card, and the
  // reassuring one was the bigger.
  const graph = { ...TWO_TEAMS, teams: [
    { team_id: 'control', name: 'Control', dispatcher_id: 'pm_in', worker_ids: ['pm'], evaluator_id: 'pm_out', models: MODELS },
    ...TWO_TEAMS.teams,
  ], workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build', 'verify'] }] }
  const dir = withLedger(graph, 'tok', [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'pm', to_team: 'control',
      task_id: 't-pm', dispatch_id: 'd-pm' },
  ])
  const page = renderGraphPage(dir, snapshotWith(), { now: NOW })
  const block = page.match(/<script type="application\/json" data-tour-data>([\s\S]*?)<\/script>/)
  const control = JSON.parse(block[1]).world['team:control']
  assert.match(control.lines.join(' '), /WIP 1\/1/, 'the door is at its limit')
  assert.doesNotMatch(control.state, /no exception open/, 'so it cannot also be calm')
})

// §6: "readers that answer position or state go through [currentEntry]." A leg
// that has already been superseded can still write its outcome afterwards —
// dispatch-facts.mjs's own example is a companion killed mid-review whose
// `delivered` lands on disk after the token has moved on. `frontDoorStatus`
// answers a STATE question (is a person blocking the gate) and used to read
// `custody[length-1]` directly instead of `currentEntry(custody)`, so this late,
// mismatched write could hide the person waiting and report the door as merely
// busy — the exact disagreement §6 exists to make impossible.
test('a stale mismatched delivered from a superseded leg does not hide a person waiting at the front door', () => {
  const graph = { ...TWO_TEAMS, teams: [
    { team_id: 'control', name: 'Control', dispatcher_id: 'pm_in', worker_ids: ['pm'], evaluator_id: 'pm_out', models: MODELS },
    ...TWO_TEAMS.teams,
  ], workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build', 'verify'] }] }
  const value = graphOf(graph)
  const dir = withLedger(graph, 'tok', [
    // Leg 1, an older dispatch to a different agent — the one that goes stale.
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'w_old', to_team: 'control', task_id: 't-old', dispatch_id: 'd-old' },
    // Leg 2, the current holder: `pm` is reassigned and then asks a question.
    { at: '2026-07-27T09:05:00.000Z', event: 'assigned', agent_id: 'pm', to_team: 'control', task_id: 't-pm', dispatch_id: 'd-pm' },
    // `question_id` became required while this test was being written in a
    // parallel worktree — a question now names itself so an answer can be tied
    // to the one it settles.
    { at: '2026-07-27T09:10:00.000Z', event: 'questioned', agent_id: 'pm', questions: 'which scope?', reason: 'unclear request', question_id: 'q-pm-1' },
    // Leg 1's companion reports in late, after leg 2 already asked its question.
    // `currentEntry` recognises `d-old` does not belong to the current holder's
    // `d-pm` and skips it; a raw `custody[length-1]` read cannot tell the two
    // legs apart.
    { at: '2026-07-27T09:15:00.000Z', event: 'delivered', agent_id: 'w_old', task_id: 't-old', dispatch_id: 'd-old', terminal: 'done', timed_out: false, evidence_present: true },
  ])
  const { items } = readWorkItems(dir)
  const occupancy = teamOccupancy(value, items)
  const door = frontDoorStatus(value, items, occupancy)
  assert.equal(door.kind, 'person', 'a person is still being asked — the stale delivered must not stand in for it')
  assert.match(door.copy, /waiting on a person to answer/)
})

test('a running worker lights its assignment, not its handover', () => {
  // "Still running" is exactly what means the artifact has NOT reached the
  // evaluator yet, so crawling that leg claimed a handover nobody made.
  const live = tourOf(TWO_TEAMS, snapshotWith([run('b_w1', 'running')]))
  assert.equal(live.world.b_w1.running, true)
  const settled = tourOf(TWO_TEAMS, snapshotWith([run('b_w1', 'awaiting-verdict')]))
  assert.equal(settled.world.b_w1.running, false, 'a finished dispatch is not a live one')
})

test('a finished run on a seat holding nothing is history, not a waiting state', () => {
  // A seat's status came only from the newest run in the snapshot, which is
  // history: a worker that finished hours ago read "delivered, waiting" for
  // ever. A POC board with every token closed was a wall of amber cards
  // claiming work was waiting to be reviewed — Master saw it before any test
  // did, because no test compared a run against the ledger.
  const settled = snapshotWith([run('b_w1', 'awaiting-verdict')])
  const idle = tourOf(TWO_TEAMS, settled)
  assert.equal(idle.world.b_w1.status, 'unbound', 'nothing holds it, so nothing waits on it')

  // Still holding the token: the same run now means what it says.
  const dir = withLedger(TWO_TEAMS, 'tok', [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:05:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-1',
      terminal: 'done', timed_out: false, evidence_present: true },
  ])
  const page = renderGraphPage(dir, settled, { now: NOW })
  const block = page.match(/<script type="application\/json" data-tour-data>([\s\S]*?)<\/script>/)
  assert.equal(JSON.parse(block[1]).world.b_w1.status, 'delivered')
})

test('the demoted topbar facts are reachable without a pointer', () => {
  // When three bands became one, the graph path, the snapshot id and the team
  // and workflow counts moved into the repo name's title attribute — which is
  // a hover, and a keyboard or a touch screen never hovers. They live behind a
  // native disclosure now; the title stays as the mouse shortcut.
  const page = pageOf(repoWith(TWO_TEAMS))
  const disclosure = page.match(/<details class="repo"([^>]*)>([\s\S]*?)<\/details>/)
  assert.ok(disclosure, 'the topbar facts are not behind a details element')
  const [, attrs, inside] = disclosure
  assert.match(inside, /<summary[^>]*>/, 'a details with no summary cannot be operated by keyboard')
  // pulse-refresh remembers every details across a republish, keyed by position
  // when nothing names it. A positional key hands this element's saved state to
  // whatever lands at that index next, so it names itself.
  assert.match(attrs, /data-refresh-details-key="topbar-facts"/)

  // The facts themselves, as TEXT inside the disclosure — not only as an
  // attribute value. Stripping the tags is what keeps this from passing on a
  // page that merely repeats them in another title.
  const facts = inside.replace(/<summary[^>]*>[\s\S]*?<\/summary>/, '').replace(/<[^>]+>/g, ' ')
  assert.match(facts, /2 teams/)
  assert.match(facts, /workflows/)
  assert.match(facts, /graph:/)
  assert.match(facts, /evidence: pulse\.json/)
})

// ── GitHub #32: per-seat reasoning effort ────────────────────────────────────
//
// `effort` rides the same `seats` override `3d5b75c` built for `model`/
// `adapter`, but it has no per-ROLE default block: there is nothing for a
// seat's effort to "resolve to" and say nothing, so every declared effort is a
// real request and an unoverridden seat carries `null`, not a role default.

test('a seat may override its effort, and only that seat carries it', () => {
  const graph = graphOf({
    ...TWO_TEAMS,
    teams: [
      {
        ...TWO_TEAMS.teams[0],
        seats: { b_w1: { effort: 'max' } },
      },
      TWO_TEAMS.teams[1],
    ],
  })
  const build = graph.teams.find((entry) => entry.team_id === 'build')
  assert.equal(build.agents.find((agent) => agent.agent_id === 'b_w1').effort, 'max')
  assert.equal(build.agents.find((agent) => agent.agent_id === 'b_w2').effort, null)
  // No role-level effort exists to inherit, so every OTHER seat on the graph —
  // including the ones on a team that declared no `seats` at all — reads null.
  const verify = graph.teams.find((entry) => entry.team_id === 'verify')
  assert.ok(verify.agents.every((agent) => agent.effort === null))
})

test('a seat may combine model, adapter and effort in one override', () => {
  const graph = graphOf({
    ...TWO_TEAMS,
    teams: [
      {
        ...TWO_TEAMS.teams[0],
        seats: { b_w1: { model: 'cheap-model', adapter: 'codex', effort: 'xhigh' } },
      },
      TWO_TEAMS.teams[1],
    ],
  })
  const seat = graph.teams.find((entry) => entry.team_id === 'build')
    .agents.find((agent) => agent.agent_id === 'b_w1')
  assert.deepEqual(
    { model: seat.model, adapter: seat.adapter, effort: seat.effort },
    { model: 'cheap-model', adapter: 'codex', effort: 'xhigh' },
  )
})

test('an empty-string effort is refused, like an empty-string model', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: [
      { ...TWO_TEAMS.teams[0], seats: { b_w1: { effort: '' } } },
      TWO_TEAMS.teams[1],
    ],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /invalid reasoning effort/)
})

test('an effort with a control character is refused', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: [
      { ...TWO_TEAMS.teams[0], seats: { b_w1: { effort: `max${String.fromCharCode(7)}` } } },
      TWO_TEAMS.teams[1],
    ],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /invalid reasoning effort/)
})

test('an effort over 64 characters is refused', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: [
      { ...TWO_TEAMS.teams[0], seats: { b_w1: { effort: 'x'.repeat(65) } } },
      TWO_TEAMS.teams[1],
    ],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /invalid reasoning effort/)
})

test('a seat key other than model/adapter/effort is still refused', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: [
      { ...TWO_TEAMS.teams[0], seats: { b_w1: { reasoning: 'max' } } },
      TWO_TEAMS.teams[1],
    ],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /unknown key/)
})

test('the outer controller may declare a reasoning effort, optionally', () => {
  const withEffort = graphOf({ ...TWO_TEAMS, outer_controller_effort: 'max' })
  assert.equal(withEffort.outer_controller_effort, 'max')
  const without = graphOf(TWO_TEAMS)
  assert.equal(without.outer_controller_effort, null)
})

test('an invalid outer controller effort is refused', () => {
  const result = validateWorkflowGraph({ ...TWO_TEAMS, outer_controller_effort: '' })
  // An empty string is treated as "not declared" for the controller, same as
  // an empty outer_controller_adapter falling back to the default lane — so
  // this one is accepted, and only a genuinely malformed value is refused.
  assert.equal(result.ok, true)
  assert.equal(result.value.outer_controller_effort, null)

  const badResult = validateWorkflowGraph({
    ...TWO_TEAMS, outer_controller_effort: 'x'.repeat(65),
  })
  assert.equal(badResult.ok, false)
  assert.match(badResult.reason, /invalid reasoning effort/)
})
