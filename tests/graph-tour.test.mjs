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

test('every declared seat gets exactly one node, at its own position', () => {
  const { world } = buildTour(CONTROLLED)
  const seats = CONTROLLED.teams.flatMap((t) => [t.dispatcher_id, ...t.worker_ids, t.evaluator_id])
  for (const seat of seats) assert.ok(world[seat], `${seat} is on the board`)

  // Two nodes on the same pixel is two agents a reader cannot tell apart.
  const seen = new Set()
  for (const node of Object.values(world)) {
    const at = `${node.x}:${node.y}`
    assert.equal(seen.has(at), false, `${node.id} sits on top of another node at ${at}`)
    seen.add(at)
  }
})

test('the controller holds one node, marked as the controller', () => {
  const { world } = buildTour(CONTROLLED)
  const named = Object.values(world).filter((n) => n.id === 'pm' || n.title === 'pm')
  assert.equal(named.length, 1)
  assert.equal(world.pm.kind, 'controller')
  assert.equal(world['team:control'].kind, 'control')
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

test('an edge is dashed until evidence hardens it', () => {
  const dry = buildTour(CONTROLLED)
  assert.equal(find(dry, 'build_d', 'b1', 'assign').solid, false)

  const live = buildTour(CONTROLLED,
    new Map([['b1', { dispatched: true, settled: true }]]),
    undefined,
    new Map([['build', { rejected: true }]]))
  assert.equal(find(live, 'build_d', 'b1', 'assign').solid, true)
  assert.equal(find(live, 'b1', 'build_e', 'judge').solid, true)
  assert.equal(find(live, 'build_e', 'b1', 'reject').solid, true)
  // Evidence belongs to the seat that produced it, never to its neighbour.
  assert.equal(find(live, 'build_d', 'b2', 'assign').solid, false)
  assert.equal(find(live, 'qa_e', 'q1', 'reject').solid, false)
})

test('oversight runs to control from every team except control', () => {
  const { edges } = buildTour(CONTROLLED)
  const escalations = edges.filter((e) => e.kind === 'escalate')
  assert.equal(escalations.length, 2)
  for (const edge of escalations) {
    assert.equal(edge.to, 'team:control')
    assert.notEqual(edge.from, 'team:control')
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
  const { edges } = buildTour(CONTROLLED)
  for (const workflow of CONTROLLED.workflows) {
    const hops = edges.filter((e) => e.wf === workflow.workflow_id)
    // One hop per team, one back to control for the audit, one into the sink.
    assert.equal(hops.length, workflow.route.length + 1)
    assert.equal(hops[0].from, 'team:control', 'work enters through the front door')
    // The last delivery team hands BACK to control, not to the sink: the
    // controller's evaluator reads the finished route as a whole, and a route
    // drawn straight to the sink would say work can leave without that.
    assert.equal(hops[hops.length - 2].to, 'team:control')
    assert.equal(hops[hops.length - 1].from, 'team:control')
    assert.equal(hops[hops.length - 1].to, 'delivered')
    assert.equal(new Set(hops.map((e) => e.kind)).size, 1)
  }
  // Two routes over one pool must be distinguishable, or the board draws one
  // line and claims it is both.
  const kinds = new Set(edges.filter((e) => e.wf).map((e) => e.kind))
  assert.equal(kinds.size, CONTROLLED.workflows.length)
})

// ── scenes ───────────────────────────────────────────────────────────────────

test('the tour opens on the whole board, walks one route at a time, and returns', () => {
  const { scenes } = buildTour(CONTROLLED)
  assert.equal(scenes.length, CONTROLLED.workflows.length + 2)
  assert.equal(scenes[0].wf, null)
  assert.equal(scenes[scenes.length - 1].wf, null)
  assert.deepEqual(
    scenes.slice(1, -1).map((s) => s.wf),
    CONTROLLED.workflows.map((w) => w.workflow_id),
  )
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
  assert.equal(scenes.length, 2, 'the board, then its one route — no "and around again"')
})

test('the camera frames the route, not the labels parked outside the board', () => {
  const { scenes, world } = buildTour(CONTROLLED)
  const fast = scenes.find((s) => s.wf === 'fast')
  assert.ok(fast.focus.length > 0)
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
