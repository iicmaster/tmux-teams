// The tour builder is arithmetic and scene bookkeeping with no I/O, so these
// run against `buildTour` directly. What the PAGE does with the result — that
// every seat still states its lane, its model and its clock — is asserted in
// graph.test.mjs, where the evidence actually lives.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Script, createContext } from 'node:vm'

import {
  TOUR_CSS, TOUR_SCRIPT, buildTour, jsonBlock, renderTourChart, tourDigest,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph-tour.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { renderPulseRefreshScript } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-refresh.mjs'

// ── a minimal DOM, built to run TOUR_SCRIPT for real ────────────────────────
// The two tests below EXECUTE TOUR_SCRIPT inside node:vm against this shim,
// instead of regex-matching its source text. A regex passes on any bytes that
// merely contain the right substring — it never runs, so a runtime TypeError
// inside apply() or the live-toggle loop, or the exact ordering bug #35 was,
// would still read green. This DOM is generic (classList/style/querySelector/
// events); it knows nothing about tmux-teams and duplicates none of
// graph-tour.mjs's own logic — it is a harness, not a second copy of the
// module under test.
class FakeClassList {
  constructor(el) { this.el = el }
  add(c) { this.el._classes.add(c) }
  remove(c) { this.el._classes.delete(c) }
  toggle(c, on) { on ? this.el._classes.add(c) : this.el._classes.delete(c); return Boolean(on) }
  contains(c) { return this.el._classes.has(c) }
}

class FakeElement {
  constructor(tag, ns = null) {
    this.tagName = tag
    this.namespaceURI = ns
    this._classes = new Set()
    this._attrs = new Map()
    this._style = {}
    this._text = ''
    this.children = []
    this.parentNode = null
    this._listeners = new Map()
    this.dataset = {}
  }
  get classList() { return new FakeClassList(this) }
  get style() { return this._style }
  set textContent(v) { this._text = String(v); this.children = [] }
  get textContent() { return this._text }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  setAttribute(name, value) {
    this._attrs.set(name, String(value))
    if (name === 'class') this._classes = new Set(String(value).split(/\s+/).filter(Boolean))
  }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null }
  removeAttribute(name) { this._attrs.delete(name) }
  hasAttribute(name) { return this._attrs.has(name) }
  toggleAttribute(name, on) { on ? this.setAttribute(name, '') : this.removeAttribute(name) }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  }
  removeEventListener() {}
  dispatchEvent(ev) { for (const fn of this._listeners.get(ev.type) || []) fn(ev); return true }
  setPointerCapture() {}
  get offsetWidth() { return 140 }
  get offsetHeight() { return 46 }
  get clientWidth() { return 1200 }
  get clientHeight() { return 800 }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight } }
  querySelector(sel) { return queryAll(this, sel)[0] ?? null }
  querySelectorAll(sel) { return queryAll(this, sel) }
}

function matchesSelector(el, sel) {
  if (sel.startsWith('.')) return el._classes.has(sel.slice(1))
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1)
    const eq = inner.indexOf('=')
    if (eq === -1) return el._attrs.has(inner)
    return el._attrs.get(inner.slice(0, eq)) === inner.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return el.tagName === sel
}

function queryAll(root, sel) {
  const out = []
  const walk = (node) => {
    for (const child of node.children) {
      if (matchesSelector(child, sel)) out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

const SEAT_KEY = 'tmux-teams.graph.seat'

// Builds the DOM tree TOUR_SCRIPT queries for, but does not run the script —
// so a test can instrument an element (e.g. wrap `.style` to log writes)
// between construction and execution.
function buildTourDom(data, { seat = null } = {}) {
  const root = new FakeElement('div')
  root.setAttribute('data-tour', '')
  const dataEl = new FakeElement('script')
  dataEl.setAttribute('data-tour-data', '')
  dataEl.textContent = JSON.stringify(data)
  root.appendChild(dataEl)

  const cam = new FakeElement('div'); cam.setAttribute('class', 'tour-cam'); root.appendChild(cam)
  const svg = new FakeElement('svg', 'http://www.w3.org/2000/svg')
  svg.setAttribute('class', 'tour-wires')
  root.appendChild(svg)
  const stage = new FakeElement('div'); stage.setAttribute('class', 'tour-stage'); root.appendChild(stage)

  const controls = {}
  for (const name of ['kicker', 'title', 'caption', 'stamp', 'dots', 'next', 'prev', 'in', 'out', 'fit', 'actual', 'full']) {
    const el = new FakeElement('div')
    el.setAttribute(`data-tour-${name}`, '')
    root.appendChild(el)
    controls[name] = el
  }

  const document_ = new FakeElement('#document')
  document_.appendChild(root)
  document_.body = new FakeElement('body')
  document_.exitFullscreen = () => {}
  document_.fullscreenElement = undefined
  document_.createElement = (tag) => new FakeElement(tag)
  document_.createElementNS = (ns, tag) => new FakeElement(tag, ns)

  const sessionStore = new Map()
  if (seat) sessionStore.set(SEAT_KEY, JSON.stringify(seat))

  return {
    document: document_,
    root, cam, svg, stage, controls,
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
      removeItem: (k) => sessionStore.delete(k),
    },
  }
}

// Actually executes TOUR_SCRIPT — its own IIFE — against the prepared DOM.
function runTourScript(dom) {
  const reduced = { matches: false, addEventListener() {}, removeEventListener() {} }
  class FakeMutationObserver { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
  const sandbox = {
    document: dom.document,
    sessionStorage: dom.sessionStorage,
    matchMedia: () => reduced,
    MutationObserver: FakeMutationObserver,
    addEventListener: () => {},
    console,
  }
  createContext(sandbox)
  new Script(TOUR_SCRIPT).runInContext(sandbox)
}

// Wraps one CSS property on an element's `.style` so writes to it are logged
// in call order, without changing FakeElement itself.
function instrumentStyle(el, prop) {
  const log = []
  const store = el._style
  const key = `_${prop}`
  Object.defineProperty(store, prop, {
    configurable: true,
    get() { return this[key] },
    set(v) { log.push(v); this[key] = v },
  })
  return log
}

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

// A seat's lines to its dispatcher and its evaluator are STRUCTURE, and
// structure does not accumulate. They used to harden from dashed to solid once
// a leg had crossed them, which made the board a record of where work had BEEN
// — a different question from the one it answers. They stay dashed no matter
// how much has run through them; while a worker is actually running, the `live`
// class moves that one line and nothing else does.
//
// Solid still means evidence everywhere else on the board: owns, pull,
// escalate, passed and the route wires are untouched.
test('a seat keeps its structural lines dashed however much work crosses them', () => {
  const dry = buildTour(CONTROLLED)
  assert.equal(find(dry, 'build_d', 'b1', 'assign').solid, false)

  const live = buildTour(CONTROLLED,
    new Map([['b1', { dispatched: true, settled: true }]]),
    undefined,
    new Map([['build', { rejected: true }]]))
  assert.equal(find(live, 'build_d', 'b1', 'assign').solid, false, 'a delivered leg is not a solid line')
  assert.equal(find(live, 'b1', 'build_e', 'judge').solid, false)
  assert.equal(find(live, 'build_e', 'build_d', 'reject').solid, false)
  // Rework goes back to the QUEUE, not to the worker who was judged: rejected
  // work is dispatched again, possibly to someone else, and only once the team
  // is under its WIP limit. So it is one line per team, not one per worker.
  assert.equal(find(live, 'build_e', 'b1', 'reject'), undefined)
  assert.equal(edgesOf(live, 'reject').filter((e) => e.from === 'build_e').length, 1)
  // The team's line to the seat that owns its queue is structure too, and joined
  // the dashed set for the same reason.
  assert.equal(find(live, 'team:build', 'build_d', 'owns').solid, false)
  // Solid still means evidence everywhere it did: handover and the sink.
  assert.equal(find(live, 'team:control', 'team:build', 'pull').solid, true)
})

// Rework runs from the evaluator back up to the dispatcher, and both sit on the
// team's centre line — so the straight path is drawn straight THROUGH every
// worker between them. The bow that clears them is a function of team size, and
// the first attempt got the arithmetic wrong: a cubic reaches about three
// quarters of its control offset, so a bow of 612 cleared 459 and still crossed
// a five-seat row's own 484 half-width. Nothing caught that but a browser.
//
// The upper bound matters as much: bow too far and the curve lands on the NEXT
// team, whose block starts at half this row plus COL_GAP.
test('the rework line clears its own worker row without reaching the next team', () => {
  for (const workers of [1, 2, 3, 4, 5]) {
    const graph = accept({
      ...CONTROLLED_RAW,
      teams: CONTROLLED_RAW.teams.map((team) => (team.team_id === 'build'
        ? { ...team, worker_ids: Array.from({ length: workers }, (_, i) => 'b' + (i + 1)) }
        : team)),
    })
    const edge = find(buildTour(graph), 'build_e', 'build_d', 'reject')
    assert.equal(typeof edge.bow, 'number', workers + ' workers: rework must carry its own bow')
    // A cubic whose control points are both offset by that much reaches 0.75 of it.
    const reach = Math.abs(edge.bow) * 0.75
    const halfRow = (workers * 176 + (workers - 1) * 22) / 2
    // `halfRow` already reaches the outermost card's OUTER EDGE — a single
    // 176-wide card centred puts its edge at 88, and halfRow for one worker is
    // 88. So the old bound of `halfRow + CARD_W / 2` cleared a further half-card
    // beyond the edge and spent that allowance twice; the arc was measurably
    // wider than the board needed (owner, 2026-08-05). What must still hold is
    // the edge plus room for the halo that rings the outermost card.
    const HALO_MARGIN = 20
    assert.ok(reach > halfRow + HALO_MARGIN,
      workers + ' workers: reach ' + Math.round(reach) + ' does not clear half-row ' + halfRow + ' plus its halo')
    assert.ok(reach < halfRow + 130,
      workers + ' workers: reach ' + Math.round(reach) + ' spills past COL_GAP into the next team')
  }
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
  // The halo period and its stagger are ONE decision, not two: the stagger is a
  // fraction of the period, chosen so the halos read as a pulse travelling the
  // route rather than a chase. Halving the period alone would spread four halos
  // across 81% of a cycle. Pinned together so a future change to either has to
  // notice the other. (Doubled in speed 2026-08-05 at Master's request: 2.6s →
  // 1.3s, stagger 0.35s → 0.175s.)
  // Every camera control is one instrument: no button may override the shared
  // box. `fit` carried its own `font:` shorthand and padding and rendered 28px
  // tall beside 39.6px siblings — measured on the served page, not guessed.
  // The shorthand was the trap: it silently resets line-height.
  const perButtonOverrides = [...TOUR_CSS.matchAll(/\.tour-controls \[data-tour-[a-z]+\]\{([^}]*)\}/g)]
    .filter(([, body]) => /(^|;)\s*(font|padding|line-height|height)\s*:/.test(body))
  assert.deepEqual(perButtonOverrides.map((m) => m[0]), [],
    'a camera control that sizes itself differently breaks the row into a pile of parts')

  // §2: the sink keeps a DASHED border because it is still not a team. The
  // comment above the rule said exactly that while the rule never set
  // border-style, so it inherited `solid` from .tnode and the page drew a team.
  // Found by the UX review, measured on the served page.
  const sink = TOUR_CSS.match(/\.k-outside\{([^}]*)\}/)
  assert.ok(sink, '.k-outside must exist')
  assert.match(sink[1], /border-style:dashed/, 'the sink is not a team and must not be drawn as one')

  // Every camera control offers the mouse the same disclosure the keyboard and
  // screen reader already get. They all carried aria-label and an empty title.
  const controls = [...renderTourChart(buildTour(CONTROLLED)).matchAll(/<button type="button" data-tour-[a-z]+([^>]*)>/g)]
  assert.ok(controls.length >= 7, `expected the camera row, found ${controls.length} controls`)
  for (const [, attrs] of controls) {
    const aria = (attrs.match(/aria-label="([^"]+)"/) || [])[1]
    const title = (attrs.match(/title="([^"]+)"/) || [])[1]
    assert.ok(aria, `a camera control without an aria-label: ${attrs}`)
    assert.equal(title, aria, 'a control must say the same thing on hover as it does to a screen reader')
  }

  // Owner's line language, 2026-08-05: dashed carries movement WITHIN a team
  // (and escalation); solid carries a token BETWEEN teams. `escalate` was solid,
  // which put a between-teams line on a within-team meaning.
  const { edges } = buildTour(CONTROLLED)
  const solidness = {}
  for (const e of edges) (solidness[e.kind] ??= new Set()).add(Boolean(e.solid))
  for (const kind of ['assign', 'judge', 'reject', 'owns', 'escalate']) {
    if (!solidness[kind]) continue
    assert.deepEqual([...solidness[kind]], [false], `${kind} moves inside a team and must be dashed`)
  }
  for (const kind of ['pull', 'passed']) {
    if (!solidness[kind]) continue
    assert.deepEqual([...solidness[kind]], [true], `${kind} carries a token between teams and must be solid`)
  }

  const halo = TOUR_CSS.match(/\.tour-halo\{animation:tourHalo ([\d.]+)s/)
  assert.ok(halo, 'the halo must declare its own animation')
  const period = Number(halo[1])
  const stagger = Number((TOUR_SCRIPT.match(/animationDelay = \(i \* ([\d.]+)\)/) || [])[1])
  assert.ok(stagger > 0, 'the halo stagger must be a real number')
  assert.equal(Number((stagger / period).toFixed(4)), 0.1346,
    `the stagger must stay ${(0.1346 * 100).toFixed(1)}% of the period — got ${stagger}s against ${period}s`)

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

test('the refresh script survives the escaping layer it is written through', () => {
  // The assembly that publishes this eats backslashes, so a regex literal
  // arrives with its escapes gone and matches something else entirely. Only
  // the refresh script goes through that layer.
  //
  // The backtick half of this test used to name TOUR_SCRIPT, TOUR_CSS and this
  // string by hand — which is why nothing noticed the two shipped strings it
  // had never heard of. It lives in `plugin-structure.test.mjs` now and finds
  // its own subjects by walking the shipped tree.
  assert.doesNotMatch(renderPulseRefreshScript(), /=\s*\/[^/\n]*\\[sSdDwWbB/]/,
    'the refresh script must not carry a regex literal — use indexOf')
})

test('the digest ignores clocks, so a tick that only moves time is not a change', () => {
  // The page reloads itself by comparing this. A running clock inside it made
  // every publish look like a change and threw the reader out of the board
  // several times a minute — the bug Master hit while watching a live POC.
  const cards = new Map([['b1', { state: 'working', lines: ['worker · claude'], time: '2m in progress' }]])
  const later = new Map([['b1', { state: 'working', lines: ['worker · claude'], time: '9m in progress' }]])
  assert.equal(tourDigest(buildTour(CONTROLLED, cards)), tourDigest(buildTour(CONTROLLED, later)))

  // But a real change still changes it.
  const moved = new Map([['b1', { state: 'delivered', lines: ['worker · claude'], time: '2m in progress' }]])
  assert.notEqual(tourDigest(buildTour(CONTROLLED, cards)), tourDigest(buildTour(CONTROLLED, moved)))
})

test('the board publishes its digest where the refresh script can read it', () => {
  const html = renderTourChart(buildTour(CONTROLLED))
  assert.match(html, /data-tour-digest="[0-9a-f]+"/)
})

test('the team-to-dispatcher wire is the same colour as that dispatcher\'s own line out', () => {
  // One relationship read top to bottom: the team owns the seat, the seat
  // assigns the worker. In var(--line) the first leg was the page's border
  // colour and read as a divider rather than a wire.
  const owns = TOUR_CSS.match(/\.w-owns\{([^}]*)\}/)
  const assign = TOUR_CSS.match(/\.w-assign\{([^}]*)\}/)
  assert.ok(owns && assign, 'both rules must exist')
  const strokeOf = (body) => body.match(/stroke:(var\(--[a-z0-9-]+\))/)?.[1]
  assert.equal(strokeOf(owns[1]), strokeOf(assign[1]),
    `owns draws ${strokeOf(owns[1])} and assign draws ${strokeOf(assign[1])}`)
  // Opacity is left to .dry, which sets it on both. A rule of its own here
  // would be a second answer to a question already answered.
  assert.doesNotMatch(owns[1], /opacity/)
})

test('a live leg outweighs the dry crawl, so it crawls on every scene', () => {
  // These selectors are class-only, so counting dots IS the specificity — and
  // `:not(.quiet)` contributes its own class, which is the whole point.
  const weight = (selector) => (selector.match(/\./g) || []).length
  const rule = (pattern) => {
    const at = TOUR_CSS.search(pattern)
    assert.notEqual(at, -1, `${pattern} is not in the stylesheet`)
    return { at, selector: TOUR_CSS.slice(at).match(pattern)[0].split('{')[0] }
  }
  const dry = rule(/[^\n}]*\.wire\.dry\{animation:tourFlow[^}]*\}/)
  const live = rule(/[^\n}]*\.wire\.live\{animation:tourFlow[^}]*\}/)
  // Written at (0,2,0) against the dry crawl's (0,4,0), the live rule lost
  // outright on every scene but the first: a wire with a dispatch running on it
  // animated at 1.1s, exactly like one with nothing recorded behind it, and the
  // only difference left was a dash pattern nobody can see. Measured on a
  // published page 2026-08-03.
  assert.ok(weight(live.selector) >= weight(dry.selector),
    `live is ${weight(live.selector)} and dry is ${weight(dry.selector)}: the dry crawl wins again`)
  if (weight(live.selector) === weight(dry.selector)) {
    assert.ok(live.at > dry.at, 'equal weight, so the live rule has to be written last')
  }
  // Reduced motion still stands it down, and by the same selector rather than
  // by a second rule that nothing reaches.
  assert.match(live.selector, /:not\(\.quiet\)/)
})

// GitHub #34: an evaluator that is itself running (actively reviewing) must
// light its incoming leg exactly as a running worker lights its incoming
// assign — contract §5's 'live' means "a dispatch is running on that seat",
// and that is role-agnostic. 'judge' (worker -> evaluator) was missing from
// TOUR_SCRIPT's allowlist entirely, so a working evaluator drew no crawl and
// no lit edge — the one working seat on the whole board that looked idle.
test('an evaluator that is running lights its incoming judge edge, not only assign and owns', () => {
  // Executed, not grepped: a worker->evaluator 'judge' wire where the
  // EVALUATOR is running, beside a dispatcher->worker 'assign' wire where the
  // WORKER is not. If 'judge' were missing from the live allowlist, or if
  // RUNNING.has(e.to) read e.from instead, this comes back false — a regex
  // match on the source text cannot tell either mutation apart from a pass.
  const data = {
    world: {
      d1: { id: 'd1', kind: 'dispatcher', x: -100, y: -100, title: 'D1', running: false },
      w1: { id: 'w1', kind: 'worker', x: 0, y: 0, title: 'W1', running: false },
      e1: { id: 'e1', kind: 'evaluator', x: 100, y: 100, title: 'E1', running: true },
    },
    edges: [
      { from: 'w1', to: 'e1', kind: 'judge' },
      { from: 'd1', to: 'w1', kind: 'assign' },
    ],
    scenes: [{ ids: ['d1', 'w1', 'e1'], focus: ['d1', 'w1', 'e1'], kicker: '', title: '', caption: '', still: false }],
  }
  const dom = buildTourDom(data)
  runTourScript(dom)
  const wires = dom.svg.children.filter((el) => el.tagName === 'path')
  const judge = wires.find((w) => w.getAttribute('data-from') === 'w1' && w.getAttribute('data-to') === 'e1')
  const assign = wires.find((w) => w.getAttribute('data-from') === 'd1' && w.getAttribute('data-to') === 'w1')
  assert.ok(judge, 'the judge wire was never drawn')
  assert.ok(assign, 'the assign wire was never drawn')
  assert.equal(judge.classList.contains('live'), true,
    "a running evaluator's incoming judge edge must light, or the one working seat on the board looks idle")
  // The worker on the assign leg is NOT running (only the evaluator is), so
  // this one must stay dark — proving RUNNING.has(e.to) reads the right end.
  assert.equal(assign.classList.contains('live'), false,
    'the assign edge lit off the wrong end\'s running state')
})

// GitHub #35: a reload restores the reader's seat (scene, zoom, pan — see the
// `seated`/`remember` mechanism) but used to glide there over the camera's
// .62s ease from the unstyled default, reading as the page jumping like a
// fresh open. `apply()` must be able to skip that ease for exactly the first
// restore, and `go()` must actually ask it to.
test('a restored seat lands in one frame instead of gliding there from the default', () => {
  // Executed, not grepped. A seat is pre-seeded in sessionStorage exactly as a
  // real reload would find it, so the script's own IIFE performs a genuine
  // restore on its first go(). If go() cleared `restoring` before capturing
  // it — the exact ordering bug #35 was — this test still builds a valid DOM
  // and a valid scene; only the recorded transitionDuration writes disagree,
  // which is precisely what a source-text regex cannot observe.
  const data = {
    world: {
      w1: { id: 'w1', kind: 'worker', x: 0, y: 0, title: 'W1' },
      w2: { id: 'w2', kind: 'worker', x: 300, y: 0, title: 'W2' },
    },
    edges: [],
    scenes: [
      { ids: ['w1', 'w2'], focus: ['w1', 'w2'], kicker: '', title: '', caption: '' },
      { ids: ['w1', 'w2'], focus: ['w1', 'w2'], kicker: '', title: '', caption: '' },
    ],
  }
  const dom = buildTourDom(data, { seat: { at: 0, k: 1, dx: 0, dy: 0 } })
  const camDurations = instrumentStyle(dom.cam, 'transitionDuration')
  const svgDurations = instrumentStyle(dom.svg, 'transitionDuration')
  runTourScript(dom)

  // The IIFE's own first go() — the reload restore — must have zeroed both
  // durations and handed them back to the stylesheet, in that order.
  assert.deepEqual(camDurations, ['0s', ''],
    `the restored first frame must zero then release the camera's transition duration, got ${JSON.stringify(camDurations)}`)
  assert.deepEqual(svgDurations, ['0s', ''],
    `the restored first frame must zero then release the wires' transition duration, got ${JSON.stringify(svgDurations)}`)

  // A later scene change — a real click on the same control a reader uses —
  // must NOT repeat that: `restoring` was already consumed by the first go().
  dom.controls.next.onclick()
  assert.deepEqual(camDurations, ['0s', ''],
    'a normal scene change must keep the eased transition, not zero it again')
  assert.deepEqual(svgDurations, ['0s', ''],
    'a normal scene change must keep the eased transition, not zero it again')
})

// Same issue: the browser's own scroll restoration on reload runs alongside
// pulse-refresh.mjs's own capture()/restore(), which can settle a frame after
// the manual one and read as a second, smaller jump right after the first.
test('the refresh script hands scroll restoration to itself, not the browser', () => {
  assert.match(renderPulseRefreshScript(), /history\.scrollRestoration\s*=\s*'manual'/,
    "the refresh script must set history.scrollRestoration = 'manual' before it restores anything itself")
})

test('the board can be shown at its own size, not only at whatever fits', () => {
  // fit and 100% answer different questions: fit is "show me all of it" at
  // whatever scale the scene needs, 100% is "show it to me at its own size" —
  // the same scale on every scene and every board. Measured on a published
  // page: fit gave a transform scale of 0.386 and this button gives exactly 1.
  const html = renderTourChart(buildTour(CONTROLLED))
  assert.match(html, /data-tour-actual[^>]*aria-label="Zoom to actual size"/)
  assert.match(html, />100%</, 'the control has to say what it does')

  // The label already renders fitted.k * user.k, so the reciprocal is what
  // makes it read 100 — asserting the arithmetic, because a button wired to
  // reset() would look identical in the markup and be a second fit.
  // The BUTTON, not just the arithmetic. Wiring this control to reset() leaves
  // the markup and the reciprocal both present and makes it a second fit —
  // measured: that mutation kept an earlier version of this test green.
  assert.match(TOUR_SCRIPT, /\[data-tour-actual\]'\)\.onclick = actual/)
  assert.match(TOUR_SCRIPT, /user\.k = Math\.min\(6, Math\.max\(0\.4, 1 \/ fitted\.k\)\)/)
  // Reachable without a pointer, the way fit is reachable with 0.
  assert.match(TOUR_SCRIPT, /ev\.key === '1'[^\n]*actual\(\)/)
})
