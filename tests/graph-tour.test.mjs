// The tour builder is arithmetic and scene bookkeeping with no I/O, so these
// run against `buildTour` directly. What the PAGE does with the result — that
// every seat still states its lane, its model and its clock — is asserted in
// graph.test.mjs, where the evidence actually lives.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TOUR_CSS, TOUR_SCRIPT, buildTour, jsonBlock, renderTourChart,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph-tour.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const MODELS = { dispatcher: 'm', worker: 'm', evaluator: 'm' }
const team = (id, workers) => ({
  team_id: id, name: id.toUpperCase(), dispatcher_id: `${id}_d`,
  worker_ids: workers, evaluator_id: `${id}_e`, models: MODELS,
})

const accept = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

// Kept as the raw declaration, not the accepted one: `accept` returns a graph
// with `controller_team` derived onto it, and feeding that back in is refused —
// correctly, since a derived fact must never be declarable.
const CONTROLLED_RAW = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'm',
  teams: [
    { team_id: 'control', name: 'Control', dispatcher_id: 'pm_in', worker_ids: ['pm'], evaluator_id: 'pm_out', models: MODELS },
    team('build', ['b1', 'b2']),
    team('qa', ['q1']),
  ],
  workflows: [
    { workflow_id: 'full', name: 'Full', route: ['control', 'build', 'qa'] },
    { workflow_id: 'fast', name: 'Fast', route: ['control', 'qa'] },
  ],
}
const CONTROLLED = accept(CONTROLLED_RAW)

// ── layout ───────────────────────────────────────────────────────────────────

test('every delivery seat gets exactly one node, at its own position', () => {
  const { world } = buildTour(CONTROLLED)
  const seats = CONTROLLED.teams
    .filter((t) => t.team_id !== 'control')
    .flatMap((t) => [t.dispatcher_id, ...t.worker_ids, t.evaluator_id])
  for (const seat of seats) assert.ok(world[seat], `${seat} is on the board`)

  // Two nodes on the same pixel is two agents a reader cannot tell apart.
  const seen = new Set()
  for (const node of Object.values(world)) {
    const at = `${node.x}:${node.y}`
    assert.equal(seen.has(at), false, `${node.id} sits on top of another node at ${at}`)
    seen.add(at)
  }
})

test('the control team is one node — its three seats are jobs, not stations', () => {
  const { world } = buildTour(CONTROLLED)
  assert.equal(world['team:control'].kind, 'control')
  // Grill, unstick and audit are three moments, not three stations work moves
  // through, and as peer cards they made the front door read as a fourth
  // delivery team.
  for (const seat of ['pm_in', 'pm', 'pm_out']) {
    assert.equal(world[seat], undefined, `${seat} must not be drawn as its own card`)
  }
  // A delivery team keeps its seats: there work really does move
  // dispatcher → worker → evaluator.
  for (const seat of ['build_d', 'b1', 'build_e']) assert.ok(world[seat])
})

test('layout follows the graph rather than a baked coordinate table', () => {
  const wide = buildTour(accept({
    ...CONTROLLED_RAW,
    teams: [
      { team_id: 'control', name: 'Control', dispatcher_id: 'pm_in', worker_ids: ['pm'], evaluator_id: 'pm_out', models: MODELS },
      team('build', ['b1', 'b2', 'b3', 'b4']),
      team('qa', ['q1']),
    ],
  }))
  const narrow = buildTour(CONTROLLED)
  assert.ok(wide.width > narrow.width, 'a team with more workers makes the board wider')
  // The column has to grow around its own row, not just push everything right.
  const spread = (tour) => Math.abs(tour.world.b2.x - tour.world.b1.x)
  assert.equal(spread(wide), spread(narrow), 'worker pitch is constant; the column widens around it')
})

// ── edges ────────────────────────────────────────────────────────────────────

const find = (tour, from, to, kind) =>
  tour.edges.find((e) => e.from === from && e.to === to && e.kind === kind)
const edgesOf = (tour, kind) => tour.edges.filter((e) => e.kind === kind)

test('an edge is dashed until evidence hardens it', () => {
  const dry = buildTour(CONTROLLED)
  assert.equal(find(dry, 'build_d', 'b1', 'assign').solid, false)

  const live = buildTour(CONTROLLED,
    new Map([['b1', { dispatched: true, settled: true }]]),
    undefined,
    new Map([['build', { rejected: true }]]))
  assert.equal(find(live, 'build_d', 'b1', 'assign').solid, true)
  assert.equal(find(live, 'b1', 'build_e', 'judge').solid, true)
  // Rework goes back to the QUEUE, not to the worker who was judged: rejected
  // work is dispatched again, possibly to someone else, and only once the team
  // is under its WIP limit. So it is one line per team, not one per worker.
  assert.equal(find(live, 'build_e', 'build_d', 'reject').solid, true)
  assert.equal(find(live, 'build_e', 'b1', 'reject'), undefined)
  assert.equal(edgesOf(live, 'reject').filter((e) => e.from === 'build_e').length, 1)
  // Evidence belongs to the seat that produced it, never to its neighbour.
  assert.equal(find(live, 'build_d', 'b2', 'assign').solid, false)
  assert.equal(find(live, 'qa_e', 'qa_d', 'reject').solid, false)
})

test('the sink counts audited work, and only audited work', () => {
  const none = buildTour(CONTROLLED)
  assert.equal(none.world.delivered.state, '')
  const some = buildTour(CONTROLLED, new Map(), undefined, new Map(), { delivered: 3 })
  assert.match(some.world.delivered.state, /3 audited/)
})

test('every team can interrupt the controller, whatever any route says', () => {
  const { edges } = buildTour(CONTROLLED)
  const delivery = CONTROLLED.teams.filter((t) => t.team_id !== 'control')
  const escalate = edges.filter((e) => e.kind === 'escalate')
  assert.equal(escalate.length, delivery.length, 'one per team, route or no route')
  for (const edge of escalate) {
    assert.equal(edge.to, 'team:control')
    assert.notEqual(edge.from, 'team:control', 'control escalating to itself means nothing')
  }
})

test('a handover between teams is one line, however many routes use it', () => {
  const { edges } = buildTour(CONTROLLED)
  // `pull-controller` hands a token straight from one team to the next — the
  // RECEIVING team pulls it when it has room — so that is a line between two
  // teams, not a trip back through the controller.
  const pulls = edges.filter((e) => e.kind === 'pull')
  assert.ok(pulls.length > 0, 'work moves between teams')
  const keys = pulls.map((e) => `${e.from}>${e.to}`)
  assert.equal(new Set(keys).size, keys.length, 'two routes sharing a handover share its line')
  for (const edge of pulls) {
    assert.notEqual(edge.from, 'team:control')
    assert.notEqual(edge.to, 'team:control')
  }
})

test('finishing a route and being stuck are different lines', () => {
  const { edges } = buildTour(CONTROLLED)
  const audit = edges.filter((e) => e.kind === 'audit')
  const escalate = edges.filter((e) => e.kind === 'escalate')
  // Both run team → controller, and collapsing them would make "this is done,
  // read it" indistinguishable from "I cannot move this".
  for (const edge of audit) assert.equal(edge.to, 'team:control')
  const ends = new Set(CONTROLLED.workflows.map((w) => `team:${w.route[w.route.length - 1]}`))
  assert.deepEqual(new Set(audit.map((e) => e.from)), ends, 'only the last team on a route audits')
  assert.ok(escalate.length > audit.length, 'more teams can be stuck than can finish a route')
})

test('a route is an order over existing wires, adding none', () => {
  const tour = buildTour(CONTROLLED)
  const wires = new Set(tour.edges.map((e) => `${e.from}>${e.to}>${e.kind}`))
  for (const workflow of CONTROLLED.workflows) {
    const order = tour.orders[workflow.workflow_id]
    assert.ok(order.length > 0, `${workflow.workflow_id} has an order`)
    for (const key of order) {
      assert.ok(wires.has(key), `${key} is a wire the board already has`)
    }
    // In, then one pull per further team, then the audit, then the sink.
    const teams = workflow.route.filter((teamId) => teamId !== 'control')
    assert.equal(order.length, teams.length + 2)
    assert.match(order[0], /^team:control>.*>send$/)
    assert.match(order[order.length - 2], />team:control>audit$/)
    assert.equal(order[order.length - 1], 'team:control>delivered>passed')
  }
})

test('a graph with no controller team draws no front door and no oversight', () => {
  const plain = accept({
    project_id: 'p', outer_controller_id: 'pm', outer_controller_model: 'm',
    teams: [team('build', ['b1']), team('qa', ['q1'])],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'qa'] }],
  })
  const { edges, world } = buildTour(plain)
  assert.equal(edges.some((e) => e.kind === 'admit'), false)
  assert.equal(edges.some((e) => e.kind === 'escalate'), false)
  // And the controller is nowhere, which is the honest picture of a graph that
  // declares one and gives it no seat. The page says so in words.
  assert.equal(world.pm, undefined)
})

test('a route returns through the audit before anything is delivered', () => {
  const { edges, orders } = buildTour(CONTROLLED)
  for (const workflow of CONTROLLED.workflows) {
    const order = orders[workflow.workflow_id]
    // Admitted by the controller, pulled team to team, then back for the audit
    // before anything is delivered.
    assert.match(order[0], /^team:control>.*>send$/)
    for (const key of order.slice(1, -2)) assert.match(key, />pull$/)
    assert.match(order[order.length - 2], />team:control>audit$/)
    assert.equal(order[order.length - 1], 'team:control>delivered>passed')
  }
  // Exactly ONE line leaves the audit for the sink: what crosses it is the same
  // fact every time, so one per route would be three claims about one thing.
  const passed = edges.filter((e) => e.kind === 'passed')
  assert.equal(passed.length, 1)
  assert.equal(passed[0].from, 'team:control')
  assert.equal(passed[0].to, 'delivered')
  // No edge belongs to a workflow at all any more. Two routes are told apart by
  // which teams are on screen, not by giving one relationship three patterns.
  assert.deepEqual(edges.filter((e) => e.wf), [])
})

// ── scenes ───────────────────────────────────────────────────────────────────

test('the tour opens on the whole board, then walks one route at a time', () => {
  const { scenes } = buildTour(CONTROLLED)
  assert.equal(scenes.length, CONTROLLED.workflows.length + 1)
  assert.equal(scenes[0].wf, null)
  assert.deepEqual(
    scenes.slice(1).map((s) => s.wf),
    CONTROLLED.workflows.map((w) => w.workflow_id),
  )
})

test('the opening scene is still, and every route scene moves', () => {
  const { scenes } = buildTour(CONTROLLED)
  // The opening scene has NOTHING moving: no dash crawl, and no route to send
  // a token down either. Motion means something only once everything else is
  // holding still, and this is the scene everything else is read against.
  assert.equal(scenes[0].still, true)
  assert.equal(scenes[0].motion, null)
  for (const scene of scenes.slice(1)) {
    assert.notEqual(scene.still, true)
    assert.equal(scene.motion, scene.wf, 'a route scene animates its own route')
  }
})

test('a route scene hides the teams it skips and says which, by name', () => {
  const { scenes } = buildTour(CONTROLLED)
  const fast = scenes.find((s) => s.wf === 'fast')
  assert.equal(fast.ids.includes('team:build'), false, 'build is not on this route')
  assert.equal(fast.ids.includes('b1'), false, 'and neither are its agents')
  assert.ok(fast.ids.includes('team:qa'))
  assert.match(fast.caption, /BUILD/, 'the skipped team is named, not merely absent')
  assert.match(fast.caption, /still on the board/)
})

test('a single-route graph does not close a loop it never opened', () => {
  const { scenes } = buildTour(accept({
    ...CONTROLLED_RAW,
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build', 'qa'] }],
  }))
  assert.equal(scenes.length, 2, 'the board, then its one route')
})

test('the camera frames the route, not the labels parked outside the board', () => {
  const { scenes, world } = buildTour(CONTROLLED)
  const fast = scenes.find((s) => s.wf === 'fast')
  assert.ok(fast.focus.length > 0)
  // A scene may not name a node the world has never heard of: the camera would
  // frame coordinates that do not exist.
  for (const id of [...fast.ids, ...fast.focus]) assert.ok(world[id], `${id} exists`)
  for (const id of fast.focus) assert.notEqual(world[id].kind, 'outside')
  // Every route starts at control on the far left and ends at the sink on the
  // far right, so framing those two would make every scene exactly as wide as
  // the whole board and the zoom would never do anything.
  assert.equal(fast.focus.includes('request'), false)
  assert.equal(fast.focus.includes('delivered'), false)
})

// ── serialisation ────────────────────────────────────────────────────────────

test('a token that ends a script block cannot end the script block', () => {
  const nasty = '</script><img src=x onerror=alert(1)>'
  const block = jsonBlock({ note: nasty })
  assert.equal(block.includes('</script'), false, 'the closing tag must not survive verbatim')
  assert.equal(JSON.parse(block).note, nasty, 'and the value itself must come back unchanged')

  // Legal in JSON, fatal in a JavaScript string literal.
  for (const sep of [' ', ' ']) {
    const escaped = jsonBlock({ sep })
    assert.equal(escaped.includes(sep), false)
    assert.equal(JSON.parse(escaped).sep, sep)
  }
})

test('the page fragment ships the data, the controls and a way in without JS', () => {
  const html = renderTourChart(buildTour(CONTROLLED))
  assert.match(html, /<noscript>/, 'a board drawn by JS must say so when there is none')
  assert.match(html, /aria-describedby="tour-desc"/)
  assert.match(html, /aria-label="Zoom in"/)
})

test('every hook the client script reaches for exists in the fragment', () => {
  const html = renderTourChart(buildTour(CONTROLLED))
  const hooks = new Set([...TOUR_SCRIPT.matchAll(/\[(data-tour-[a-z]+)\]/g)].map(([, h]) => h))
  assert.ok(hooks.size >= 7, `only ${hooks.size} hooks found — the scan is not reading the script`)
  for (const hook of hooks) {
    assert.ok(html.includes(hook), `${hook} is read by the script but never rendered`)
  }
})

// ── the cascade ──────────────────────────────────────────────────────────────

test('an edge told to leave the scene cannot be painted back in', () => {
  // `.wire.off` and `.wire.dry` are both specificity (0,2,0), so the ONLY thing
  // deciding which opacity wins is which is written last. With `.dry` last, the
  // teams a route skips kept their wiring on screen at .34 — a bug invisible in
  // the logic, which was correct, and living entirely in line order.
  const off = TOUR_CSS.indexOf('.wire.off{')
  const dry = TOUR_CSS.indexOf('.wire.dry{')
  assert.ok(off > -1 && dry > -1, 'both rules must exist')
  assert.ok(off > dry, '.wire.off must come after .wire.dry or hiding an edge does nothing')
})

test('strokes do not grow with the camera', () => {
  // The board is scaled by a CSS transform, which scales stroke widths and dash
  // patterns with it. Zoomed in, a hairline becomes a bar.
  assert.match(TOUR_CSS, /\.wire\{[^}]*vector-effect:non-scaling-stroke/)
})

test('the client script contains no backtick', () => {
  // TOUR_SCRIPT is itself a template literal, so a stray backtick — most easily
  // written inside a comment, quoting an identifier — closes it early and the
  // module stops parsing. It happened three times while this file was written;
  // the failure is a syntax error a long way from its cause.
  assert.equal(TOUR_SCRIPT.includes('`'), false, 'a backtick inside TOUR_SCRIPT ends the template')
})
