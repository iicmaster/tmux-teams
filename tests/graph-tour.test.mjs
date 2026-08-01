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

test('every handover is a pull, including the first leg out of the door', () => {
  const { edges } = buildTour(CONTROLLED)
  const pulls = edges.filter((e) => e.kind === 'pull')
  assert.ok(pulls.length > 0, 'work moves between teams')
  const keys = pulls.map((e) => `${e.from}>${e.to}`)
  assert.equal(new Set(keys).size, keys.length, 'two routes sharing a handover share its line')
  // `pull-controller` writes `pulled` with a `from_team` for the FIRST leg as
  // well as for team-to-team hops, so a separate kind for it claimed the door
  // works differently than the ledger says it does.
  assert.equal(edges.some((e) => e.kind === 'send'), false, 'there is no second kind of handover')
  assert.ok(pulls.some((e) => e.from === 'team:control'), 'the door hands over by pulling too')
  // Nothing ever pulls INTO control: the audit reads a delivery, it never
  // takes the token back.
  assert.equal(pulls.some((e) => e.to === 'team:control'), false)
})

test('a token stops where custody stops — it is never sent home', () => {
  const { edges, orders } = buildTour(CONTROLLED)
  assert.deepEqual(edges.filter((e) => e.kind === 'audit'), [])
  for (const workflow of CONTROLLED.workflows) {
    const order = orders[workflow.workflow_id]
    const legs = workflow.route.filter((teamId) => teamId !== 'control')
    // The last team writes `completed`; the controller's audit is a RELEASING
    // event, so no token travels back to it and none travels to the sink.
    assert.equal(order.length, legs.length, 'one pull per leg, and nothing after')
    assert.equal(order[order.length - 1], `team:${legs[legs.length - 2] ?? 'control'}>team:${legs[legs.length - 1]}>pull`)
    assert.equal(order.some((key) => key.endsWith('>passed')), false, 'nothing travels the audit line')
    // Every hop must move FORWARD along the declared route. The previous
    // version reused the outbound wire for the return leg without reversing
    // it, so the dot ran controller → team a second time and jumped back —
    // and the test that guarded it only checked the key was reused.
    const seen = ['team:control', ...legs.map((teamId) => `team:${teamId}`)]
    order.forEach((key, i) => {
      const [from, to] = key.split('>')
      assert.equal(from, seen[i], `hop ${i} leaves the node the token is actually at`)
      assert.equal(to, seen[i + 1], `hop ${i} arrives at the next team on the route`)
    })
  }
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
    // One pull per leg, starting at the door. Nothing after the last team.
    const teams = workflow.route.filter((teamId) => teamId !== 'control')
    assert.equal(order.length, teams.length)
    assert.match(order[0], /^team:control>.*>pull$/)
    for (const key of order) assert.match(key, />pull$/)
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

test('the audit line exists but carries nothing', () => {
  const { edges, orders } = buildTour(CONTROLLED)
  for (const workflow of CONTROLLED.workflows) {
    const order = orders[workflow.workflow_id]
    // Pulled from the door, then team to team, and that is all custody does.
    assert.match(order[0], /^team:control>.*>pull$/)
    for (const key of order) assert.match(key, />pull$/)
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
  // Fixed by weight rather than by order, because order only held until the
  // next state class was written below it: `.w-escalate.raised` restored
  // opacity .9 and kept animating on wires that had already left the scene.
  const off = TOUR_CSS.match(/\.wire\.off\{([^}]*)\}/)
  assert.ok(off, 'the rule must exist')
  assert.match(off[1], /opacity:0!important/)
  assert.match(off[1], /animation:none!important/, 'a hidden wire must not keep animating')
})

test('a solid edge is solid — the dash lives on the state, never on the colour', () => {
  // `.w-reject` carried `stroke-dasharray` itself, so a rejection with a
  // recorded verdict stayed dashed for ever and "solid once evidence exists"
  // was false however correct the data was.
  for (const kind of ['assign', 'judge', 'reject']) {
    const rule = TOUR_CSS.match(new RegExp(`\\.w-${kind}\\{([^}]*)\\}`))
    assert.ok(rule, `${kind} has a colour rule`)
    assert.doesNotMatch(rule[1], /stroke-dasharray/,
      `${kind} must take its dash from .dry, or it can never harden`)
  }
  assert.match(TOUR_CSS, /\.wire\.dry\{[^}]*stroke-dasharray/)
})

test('strokes do not grow with the camera', () => {
  // The board is scaled by a CSS transform, which scales stroke widths and dash
  // patterns with it. Zoomed in, a hairline becomes a bar.
  assert.match(TOUR_CSS, /\.wire\{[^}]*vector-effect:non-scaling-stroke/)
})

test('neither shipped string contains a backtick', () => {
  // Both are template literals, so a stray backtick — most easily written in a
  // comment quoting an identifier — closes one early and the module stops
  // parsing, with a syntax error a long way from its cause. It happened four
  // times writing this file; the fourth was in TOUR_CSS, which this test only
  // covered TOUR_SCRIPT for at the time.
  assert.equal(TOUR_SCRIPT.includes('`'), false, 'a backtick inside TOUR_SCRIPT ends the template')
  assert.equal(TOUR_CSS.includes('`'), false, 'and the same is true of TOUR_CSS')
})

// ── what a scene may show ────────────────────────────────────────────────────

test('a route scene shows only handovers that touch its own teams', () => {
  // The rule "hide the teams a route skips and the rest is its path" goes quiet
  // when a route uses EVERY team: nothing is hidden, so a handover belonging to
  // another route would stay on screen and the board would say work can be
  // handed somewhere this route never hands it.
  const { orders, edges } = buildTour(CONTROLLED)
  for (const workflow of CONTROLLED.workflows) {
    const mine = new Set(workflow.route.map((teamId) => `team:${teamId}`))
    mine.add('delivered')
    for (const key of orders[workflow.workflow_id]) {
      const [from, to] = key.split('>')
      assert.ok(mine.has(from) && mine.has(to),
        `${key} touches a team ${workflow.workflow_id} does not use`)
    }
    // The reverse does NOT hold, and that is why the client filters. The board
    // carries `control → qa` because some route pulls straight there; on a
    // route that reaches qa through build it must be hidden, not drawn as a
    // shortcut nobody takes. `draw()` keys that off this same order.
    const spare = edges.filter((e) => e.kind === 'pull'
      && mine.has(e.from) && mine.has(e.to)
      && !orders[workflow.workflow_id].includes(`${e.from}>${e.to}>${e.kind}`))
    for (const edge of spare) {
      assert.notEqual(edge.from, edge.to)
    }
  }
})

test('structure is true on every scene; a handover belongs to one route', () => {
  // The split the client filters on. Structure — a team owning its dispatcher,
  // an evaluator sending rework back, a team escalating — does not depend on
  // which route is being explained. A handover answers "how does THIS work
  // travel", which is exactly what changes.
  const { edges, orders } = buildTour(CONTROLLED)
  const handover = new Set(['pull'])
  const inSomeOrder = new Set(Object.values(orders).flat())
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}>${edge.kind}`
    if (handover.has(edge.kind)) {
      assert.ok(inSomeOrder.has(key), `${key} is a handover, so some route must use it`)
    } else if (edge.kind !== 'passed') {
      assert.equal(inSomeOrder.has(key), false, `${key} is structure and must not sit in a route order`)
    }
  }
  // `passed` is the deliberate exception, and the reason it needs stating: it
  // is a relationship the board shows on every scene — work the controller
  // read and accepted — but NO token travels it, because the audit releases
  // the token rather than carrying it anywhere.
  const passed = edges.filter((e) => e.kind === 'passed')
  assert.equal(passed.length, 1)
  for (const order of Object.values(orders)) {
    assert.equal(order.some((key) => key.endsWith('>passed')), false)
  }
})
