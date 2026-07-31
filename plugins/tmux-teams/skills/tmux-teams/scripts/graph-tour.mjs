// graph-tour.mjs — the loop graph as a guided tour rather than one static wall.
//
// The board answers two different questions and the single-picture SVG this
// replaces answered them on top of each other: WHO exists (teams as a pool,
// drawn once) and HOW work travels (a workflow, which is only an order through
// that pool). Drawn together, a reader cannot tell a team a route skips from a
// team that is not there — which is exactly the distinction the pool/route
// split exists to teach.
//
// So the same board is shown several times. Scene 0 is everything. Then one
// scene per workflow, with the teams that route does not use faded out and the
// camera pulled in to what is left. Then everything again. Nothing MOVES
// between scenes: a node keeps its position for the whole tour, because a node
// that jumps reads as a different node.
//
// Layout is DERIVED here, never baked: team count, worker count per team and
// the controller team all change the geometry, and a second set of hand-written
// coordinates would drift from the graph the moment any of them changes.
//
// This module is deliberately ignorant of evidence. It is handed a card per
// agent — already derived from the ledger and the snapshot by graph.mjs — and
// only decides where things sit and which scene they belong to. Keeping the
// arithmetic away from the evidence is what makes the layout testable without a
// repo, a snapshot or a clock.

// ── geometry ────────────────────────────────────────────────────────────────
// One column per team. Rows are fixed so every team reads at the same height;
// only the column width follows the widest worker row.
const CARD_W = 176
const WORKER_GAP = 22
const COL_GAP = 130
const ROW_TEAM = 0
const ROW_DISPATCHER = 122
const ROW_WORKER = 258
const ROW_EVALUATOR = 400
// The control team sits ABOVE the delivery row, not inside it. It is a team by
// every rule that matters — one worker, WIP 1, its own gate — but it is not the
// same KIND of thing as a team that does a leg of the work: it is the door, and
// every other team escalates back to it. Put it in the row and each of those
// escalations has to run backwards across the whole board through the cards in
// between. Lift it out and they all point straight up at nothing else.
const ROW_CONTROL = -430
const CONTROL_SEATS = -296
const CONTROL_PITCH = 300
const OUTSIDE_Y = ROW_CONTROL
const OUTSIDE_GAP = 150

const rowWidth = (team) =>
  team.worker_ids.length * CARD_W + (team.worker_ids.length - 1) * WORKER_GAP

// ── the tour ────────────────────────────────────────────────────────────────
// `cards` is a Map from agent_id to whatever graph.mjs derived for that seat.
// Anything it carries travels into the page untouched; this module never
// invents a status, a model or a time.
export function buildTour(graph, cards = new Map(), occupancy = { counts: new Map(), held: new Map() },
  teamFacts = new Map()) {
  const world = {}
  const edges = []
  const controlId = graph.controller_team ?? null

  // Column positions first, so every later edge can name two nodes that already
  // know where they are. An edge is always drawn from the two nodes' own
  // coordinates, so it can never claim a relationship the layout does not have.
  //
  // Control is left out of the row on purpose. A route is an order through the
  // teams that do the legs; control is not one of those, it is the door work
  // comes through and the seat every team interrupts when it is stuck. Given a
  // column in the row it would read as a station work passes once and leaves
  // behind, which is the one thing it is not.
  const delivery = graph.teams.filter((team) => team.team_id !== controlId)
  const centreOf = new Map()
  let x = 0
  for (const team of delivery) {
    const width = Math.max(rowWidth(team), CARD_W)
    centreOf.set(team.team_id, x + width / 2)
    x += width + COL_GAP
  }
  const boardWidth = Math.max(0, x - COL_GAP)
  // Centred over the row it watches, so no escalation runs further than it has
  // to and none of them cross each other on the way up.
  if (controlId) centreOf.set(controlId, boardWidth / 2)

  for (const team of graph.teams) {
    const centre = centreOf.get(team.team_id)
    const isControlTeam = team.team_id === controlId
    const wip = occupancy.counts.get(team.team_id) ?? 0
    const held = occupancy.held.get(team.team_id) ?? []
    const isControl = team.team_id === controlId
    const teamNodeId = `team:${team.team_id}`
    const facts = teamFacts.get(team.team_id) || {}

    world[teamNodeId] = {
      id: teamNodeId, x: centre, y: isControlTeam ? ROW_CONTROL : ROW_TEAM,
      kind: isControl ? 'control' : 'team',
      title: team.name,
      // A team's whole state in two lines: what it holds out of what it may
      // hold, then the tokens themselves when it holds any.
      lines: [
        `WIP ${wip}/${team.wip_limit}${wip >= team.wip_limit ? ' · full' : ''}`,
        held.length ? held.join(', ') : 'no work held',
      ],
      role: isControl ? 'the front door — every route enters here' : 'team',
    }

    // `lines` travels straight through. graph.mjs decides what a seat says —
    // its adapter lane, its verified model, what it has actually done, how long
    // it has been in that state — and this module must not be able to drop one
    // of those by knowing their names.
    const seat = (agentId, kind, y, cx) => {
      const card = cards.get(agentId) || {}
      world[agentId] = {
        id: agentId, x: cx, y, kind,
        title: agentId,
        state: card.state || '',
        lines: card.lines || [],
        status: card.status || 'unbound',
        role: card.role || kind,
      }
    }

    // Control's three seats sit side by side on one row rather than stacked
    // like a delivery team's, because they are not a pipeline: the grill, the
    // unsticking seat and the audit are three ways in, used at three different
    // moments, not three stages of one leg.
    const seats = isControlTeam ? [team.dispatcher_id, ...team.worker_ids, team.evaluator_id] : []
    // Wider pitch than a worker row: these cards carry the controller's own
    // sentence ("watching — no exception open"), which is far longer than a
    // worker's, and a card is sized by its text.
    const seatX = (agentId) =>
      centre + (seats.indexOf(agentId) - (seats.length - 1) / 2) * CONTROL_PITCH

    seat(team.dispatcher_id, 'dispatcher',
      isControlTeam ? CONTROL_SEATS : ROW_DISPATCHER,
      isControlTeam ? seatX(team.dispatcher_id) : centre)
    seat(team.evaluator_id, 'evaluator',
      isControlTeam ? CONTROL_SEATS : ROW_EVALUATOR,
      isControlTeam ? seatX(team.evaluator_id) : centre)

    const left = centre - rowWidth(team) / 2 + CARD_W / 2
    team.worker_ids.forEach((workerId, index) => {
      // The controller holds a worker seat on its own team. It is the seat
      // `outer_controller_id` already names — the same seat named twice, not
      // two seats — so it is drawn ONCE, here, and never again as a band of
      // its own above the board.
      const kind = workerId === graph.outer_controller_id ? 'controller' : 'worker'
      seat(workerId, kind,
        isControlTeam ? CONTROL_SEATS : ROW_WORKER,
        isControlTeam ? seatX(workerId) : left + index * (CARD_W + WORKER_GAP))
      // An edge hardens only once something recorded happened along it. Drawn
      // solid by default, the picture would claim every declared relationship
      // as an observed one — the exact attestation-over-evidence failure this
      // whole page exists to refuse.
      const seenWorker = cards.get(workerId) || {}
      edges.push({ from: team.dispatcher_id, to: workerId, kind: 'assign', solid: Boolean(seenWorker.dispatched) })
      edges.push({ from: workerId, to: team.evaluator_id, kind: 'judge', solid: Boolean(seenWorker.settled) })
      edges.push({ from: team.evaluator_id, to: workerId, kind: 'reject', solid: Boolean(facts.rejected) })
    })

    // Structure, not a claim about the past: this team HAS that dispatcher
    // whether or not anything ever ran. Only the three edges above say
    // something happened, and only those wait for evidence.
    edges.push({ from: teamNodeId, to: team.dispatcher_id, kind: 'owns', solid: true })
    // Oversight is a real relationship but never a reflexive one: the control
    // team escalating to itself would be a line that means nothing. The old
    // page drew that line, because it drew oversight before the controller had
    // a team to belong to.
    if (controlId && !isControl) {
      edges.push({ from: teamNodeId, to: `team:${controlId}`, kind: 'escalate', solid: true })
    }
  }

  world.request = {
    id: 'request', x: -OUTSIDE_GAP, y: OUTSIDE_Y, kind: 'outside',
    title: 'Request', lines: ['a person, through an agent'], role: 'outside the board',
  }
  world.delivered = {
    id: 'delivered', x: boardWidth + OUTSIDE_GAP, y: OUTSIDE_Y, kind: 'outside',
    title: 'Delivered', lines: ['read as a whole'], role: 'end, not a team',
  }
  if (controlId) edges.push({ from: 'request', to: `team:${controlId}`, kind: 'admit', solid: true })

  // Route edges carry their workflow id, which is what lets one scene show a
  // single route without hiding the structure underneath it.
  graph.workflows.forEach((workflow, index) => {
    const lane = index % 4
    const hops = [...workflow.route.map((teamId) => `team:${teamId}`), 'delivered']
    for (let i = 1; i < hops.length; i += 1) {
      edges.push({ from: hops[i - 1], to: hops[i], kind: `route${lane}`, wf: workflow.workflow_id, solid: true })
    }
  })

  const agentsOf = (teamId) => {
    const team = graph.teams.find((entry) => entry.team_id === teamId)
    return team ? [`team:${teamId}`, team.dispatcher_id, ...team.worker_ids, team.evaluator_id] : []
  }
  const everything = Object.keys(world)

  const scenes = [{
    id: 'all', wf: null, kicker: 'The board',
    title: 'Every team, drawn once',
    caption: `${graph.teams.length} team(s) as a reusable pool · ${graph.workflows.length} route(s) over them`
      + ' · press → for one route at a time.',
    ids: everything,
  }]
  for (const workflow of graph.workflows) {
    const skipped = graph.teams
      .filter((team) => !workflow.route.includes(team.team_id))
      .map((team) => team.name)
    scenes.push({
      id: workflow.workflow_id, wf: workflow.workflow_id,
      kicker: `route · ${workflow.workflow_id}`,
      title: workflow.name,
      caption: workflow.route.join(' → ')
        + (skipped.length
          ? ` · never touches ${skipped.join(', ')} — ${skipped.length === 1 ? 'that team is' : 'those teams are'}`
            + ` still on the board, this route just does not use ${skipped.length === 1 ? 'it' : 'them'}.`
          : ' · every team on the board.'),
      ids: ['request', 'delivered', ...workflow.route.flatMap(agentsOf)],
      // The camera frames the TEAMS on the route, not the two labels that sit
      // outside the board. Every route starts at control on the far left and
      // ends at the sink on the far right, so framing those two would make
      // every scene exactly as wide as the whole board and the zoom — the
      // reason a scene is a set of nodes at all — would never do anything.
      focus: workflow.route.flatMap(agentsOf),
    })
  }
  // Only worth closing the loop when there was more than one route to compare.
  if (graph.workflows.length > 1) {
    scenes.push({
      id: 'again', wf: null, kicker: 'and around again',
      title: 'Same teams, different orders',
      caption: 'One pool of agents, one order per route. Press → to start over.',
      ids: everything,
    })
  }

  return { world, edges, scenes, width: boardWidth }
}

// ── the page fragment ───────────────────────────────────────────────────────
// The data goes out as `application/json`, not as a JS literal. HTML-entity
// escaping does nothing inside a <script> element — what ends the block is a
// literal `</script>` in any string, and this data carries free text a human
// typed (a question, a reason, a token name). A JSON block plus JSON.parse has
// no such exit; the line separators are escaped because they are legal in JSON
// but not in a JavaScript string literal.
export const jsonBlock = (data) => JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029')

export function renderTourChart(tour, { describedBy = 'tour-desc' } = {}) {
  return `<div class="tour" data-tour>
  <div class="tour-stage" tabindex="0" role="group"
   aria-roledescription="board" aria-describedby="${describedBy}">
    <svg class="tour-wires" aria-hidden="true"></svg>
    <div class="tour-cam"></div>
  </div>
  <div class="tour-bar">
    <div class="tour-copy">
      <p class="tour-kicker" data-tour-kicker></p>
      <h2 class="tour-title" data-tour-title></h2>
      <p class="tour-caption" data-tour-caption></p>
      <p class="tour-dots" data-tour-dots></p>
    </div>
    <div class="tour-controls">
      <span class="tour-zoom" data-tour-zoom aria-live="off"></span>
      <button type="button" data-tour-out aria-label="Zoom out">−</button>
      <button type="button" data-tour-fit aria-label="Fit this scene">fit</button>
      <button type="button" data-tour-in aria-label="Zoom in">+</button>
      <span class="tour-stamp" data-tour-stamp aria-live="polite"></span>
      <button type="button" data-tour-prev aria-label="Previous scene">←</button>
      <button type="button" data-tour-next aria-label="Next scene">→</button>
    </div>
  </div>
  <noscript><p class="tour-noscript">This board is drawn by the page itself, so it needs JavaScript.
   The same declaration is in <code>.tmux-teams/graph.json</code> and the same evidence is in
   <code>.tmux-teams/pulse.json</code> — both are readable without a browser.</p></noscript>
  <script type="application/json" data-tour-data>${jsonBlock(tour)}</script>
</div>`
}

export const TOUR_CSS = `
/* The board is four rows tall plus headroom for the escalation arc, so the
   stage height — not the page width — is what decides how far the camera has
   to zoom out. Too short and every card is scaled past legibility; too tall
   and the page scrolls, which costs more than the zoom buys. */
.tour{display:grid;grid-template-rows:minmax(470px,62vh) auto;border-block:1px solid var(--line);background:var(--bg)}
.tour-stage{position:relative;overflow:hidden;cursor:grab;touch-action:none}
.tour-stage:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
/* Under a hand the camera must track the cursor exactly; the scene ease is for
   moves the page makes on its own. */
.tour.free .tour-cam,.tour.free .tour-wires{transition:none}
/* Zoomed out, an agent card shows only its name and its state — the rest is
   unreadable at that scale and only makes the board denser. Zoom in and it
   comes back. A team keeps its WIP line at every scale: how full a team is is
   the one thing worth reading from across the board. */
.tour.lean .tnode:not(.k-team):not(.k-control) span{display:none}
.tour-cam,.tour-wires{position:absolute;inset:0;width:100%;height:100%;transform-origin:0 0;
 transition:transform .62s cubic-bezier(.22,.61,.36,1)}
.tour-wires{overflow:visible;pointer-events:none}
.wire{fill:none;stroke-width:1.8;transition:opacity .4s}
.wire.off{opacity:0}
/* Solid means a record exists for it. Dashed means the operating model with
   nothing measured yet — the difference the whole page rests on. */
.wire.dry{stroke-dasharray:5 5;opacity:.34}
.w-assign{stroke:var(--assign);opacity:.5}
.w-judge{stroke:var(--artifact);opacity:.55}
.w-reject{stroke:var(--reject);stroke-dasharray:4 4;opacity:.5}
.w-owns{stroke:var(--line)}
.w-escalate{stroke:var(--oversight);stroke-dasharray:6 4;opacity:.8}
.w-admit{stroke:var(--ink);stroke-width:2.4;opacity:.75}
.w-route0{stroke:var(--handoff);stroke-width:2.6;opacity:.8}
.w-route1{stroke:var(--warn);stroke-width:2.6;opacity:.8;stroke-dasharray:9 5}
.w-route2{stroke:var(--focus);stroke-width:2.6;opacity:.8;stroke-dasharray:2 6}
.w-route3{stroke:var(--artifact);stroke-width:2.6;opacity:.8;stroke-dasharray:14 6}
.tnode{position:absolute;transform:translate(-50%,-50%);padding:8px 14px;border-radius:10px;
 background:var(--surface);border:1.5px solid var(--line);white-space:nowrap;
 transition:opacity .45s,transform .55s cubic-bezier(.22,.61,.36,1)}
.tnode b{display:block;font:600 .78rem/1.35 var(--mono)}
.tnode span{display:block;color:var(--dim);font:400 .64rem/1.4 var(--mono);font-variant-numeric:tabular-nums}
.tnode em{display:block;font:600 .6rem/1.4 var(--mono);font-style:normal;letter-spacing:.04em}
.tnode.out{opacity:0;transform:translate(-50%,-50%) scale(.82);pointer-events:none}
.k-team{background:var(--ink);border-color:var(--ink)}
.k-team b{color:var(--bg)}.k-team span{color:var(--surface-2);opacity:.9}
.k-control{background:var(--ink);border-color:var(--oversight);
 box-shadow:0 0 0 3px color-mix(in oklch,var(--oversight) 32%,transparent)}
.k-control b{color:var(--bg)}.k-control span{color:var(--surface-2);opacity:.9}
.k-dispatcher{border-color:var(--assign)}
.k-evaluator{border-color:var(--artifact)}
.k-controller{border-color:var(--oversight);background:var(--surface-2)}
.k-outside{background:transparent;border-style:dashed}
.s-working{border-color:var(--ok)}.s-working em{color:var(--ok)}
.s-delivered{border-color:var(--warn)}.s-delivered em{color:var(--warn)}
.s-dead{border-color:var(--bad)}.s-dead em{color:var(--bad)}
.s-unbound{border-style:dashed;opacity:.82}.s-unbound em{color:var(--dim)}
.s-watching em{color:var(--oversight)}
.tour-bar{display:grid;grid-template-columns:1fr auto;gap:var(--s5);align-items:end;
 padding:var(--s3) var(--s5) var(--s4);border-top:1px solid var(--line);background:var(--surface)}
.tour-kicker{margin:0;color:var(--dim);font:500 .68rem var(--sans);letter-spacing:.13em;text-transform:uppercase}
.tour-title{margin:2px 0 3px;font:650 1.15rem/1.3 var(--sans);text-wrap:balance}
.tour-caption{margin:0;max-width:78ch;color:var(--dim);font-size:.86rem}
.tour-dots{display:flex;gap:5px;margin:10px 0 0}
.tour-dots button{width:9px;height:9px;padding:0;border:none;border-radius:99px;background:var(--line);cursor:pointer}
.tour-dots button[aria-current=true]{background:var(--ink)}
.tour-dots button:focus-visible,.tour-controls button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.tour-controls{display:flex;align-items:center;gap:var(--s2)}
.tour-controls button{padding:6px 14px;border:1px solid var(--line);border-radius:8px;
 background:var(--surface);color:var(--ink);font:inherit;cursor:pointer}
.tour-controls button:hover{border-color:var(--ink)}
.tour-stamp{min-width:8ch;color:var(--dim);font:400 .74rem var(--mono);
 font-variant-numeric:tabular-nums;text-align:right}
.tour-zoom{min-width:5ch;color:var(--dim);font:400 .74rem var(--mono);
 font-variant-numeric:tabular-nums;text-align:right}
.tour-controls [data-tour-fit]{font:400 .74rem var(--mono);padding:6px 10px}
.tour-noscript{margin:0;padding:var(--s4) var(--s5);color:var(--dim);font-size:.86rem}
@media (prefers-reduced-motion:reduce){.tour-cam,.tour-wires,.tnode,.wire{transition:none!important}}
`

// The client half. Kept as a string rather than a served file because this page
// is copied around as a single artifact, and a second file that can go missing
// turns the board into an empty box with nothing to explain it.
export const TOUR_SCRIPT = `
(() => {
  const root = document.querySelector('[data-tour]')
  if (!root) return
  let data
  try { data = JSON.parse(root.querySelector('[data-tour-data]').textContent) } catch { return }
  const { world, edges, scenes } = data
  const cam = root.querySelector('.tour-cam')
  const svg = root.querySelector('.tour-wires')
  const stage = root.querySelector('.tour-stage')
  let at = 0
  // The camera the SCENE asks for, and the adjustment the READER made on top of
  // it. Kept apart so changing scene never throws away a zoom, and zooming
  // never rewrites what the scene meant to frame.
  let fitted = { k: 1, x: 0, y: 0 }
  let user = { k: 1, dx: 0, dy: 0 }

  const NODES = {}
  for (const n of Object.values(world)) {
    const el = document.createElement('div')
    el.className = 'tnode k-' + n.kind + (n.status ? ' s-' + n.status : '')
    el.style.left = n.x + 'px'
    el.style.top = n.y + 'px'
    el.title = n.id + (n.role ? ' — ' + n.role : '')
    const head = document.createElement('b')
    head.textContent = n.title
    el.appendChild(head)
    if (n.state) { const s = document.createElement('em'); s.textContent = n.state; el.appendChild(s) }
    for (const line of n.lines || []) {
      if (!line) continue
      const s = document.createElement('span')
      s.textContent = line
      el.appendChild(s)
    }
    cam.appendChild(el)
    NODES[n.id] = el
  }

  // Every wire is drawn from the two nodes' own positions. The bow is
  // PERPENDICULAR to the line: drawn straight, assign, judge and reject land on
  // the same pixels and a dispatcher's second wire runs through the first
  // worker's card. Same-kind edges leaving one node fan out instead of stacking.
  // Perpendicular offsets, in board pixels. Inside a team the numbers are small
  // because the nodes are close. Across the board they are large and they are
  // what keeps the picture readable: routes share one horizontal row, so a
  // second route drawn straight would land on the first one's pixels, and an
  // escalation from the far right back to control would run through every team
  // card in between. Bowing them apart is not decoration — it is the only thing
  // that makes two routes distinguishable at all.
  const BOW = {
    reject: -46, judge: 18, assign: 30, owns: 0, admit: 0,
    escalate: -34, route0: 0, route1: 74, route2: -104, route3: 132,
  }
  const seen = {}
  const WIRES = edges.map((e) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('class', 'wire w-' + e.kind + (e.solid ? '' : ' dry'))
    svg.appendChild(p)
    const key = e.from + '>' + e.kind
    return { e, p, lane: (seen[key] = (seen[key] ?? -1) + 1) }
  })

  function draw(visible, wf) {
    for (const { e, p, lane } of WIRES) {
      const on = visible.has(e.from) && visible.has(e.to) && (!e.wf || !wf || e.wf === wf)
      p.classList.toggle('off', !on)
      if (!on) continue
      const a = world[e.from], b = world[e.to]
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      // The offset is perpendicular to the LINE, so its screen direction flips
      // when the line runs backwards — and escalation always runs backwards,
      // from a team on the right to control on the left. Without this, the one
      // family of edges that most needs to clear the board bows down through
      // every card instead of up over them.
      const back = Math.abs(dx) >= Math.abs(dy) ? (Math.sign(dx) || 1) : 1
      const bow = (BOW[e.kind] ?? 0) * (1 + lane * 0.9) * back
      const px = -dy / len * bow, py = dx / len * bow
      p.setAttribute('d', 'M ' + a.x + ' ' + a.y
        + ' C ' + (a.x + dx / 3 + px) + ' ' + (a.y + dy / 3 + py)
        + ', ' + (a.x + dx * 2 / 3 + px) + ' ' + (a.y + dy * 2 / 3 + py)
        + ', ' + b.x + ' ' + b.y)
    }
  }

  // A card carries five lines of evidence, which is four more than the picture
  // can show at board scale. Rather than drop them — the page would then say
  // less than the ledger knows — they are hidden while the board is zoomed out
  // and appear as soon as the reader zooms in far enough to read them.
  const DETAIL_AT = 0.86
  function apply() {
    const k = fitted.k * user.k
    const w = stage.clientWidth, h = stage.clientHeight
    const t = 'translate(' + (w / 2 + user.dx) + 'px,' + (h / 2 + user.dy) + 'px) scale(' + k
      + ') translate(' + (-fitted.x) + 'px,' + (-fitted.y) + 'px)'
    cam.style.transform = t
    svg.style.transform = t
    root.classList.toggle('lean', k < DETAIL_AT)
    const zoom = root.querySelector('[data-tour-zoom]')
    if (zoom) zoom.textContent = Math.round(k * 100) + '%'
  }

  // Zoom about the pointer, so the thing under the cursor stays under it. The
  // page must not scroll while this happens, hence the non-passive listener.
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault()
    // The scene transition is a slow ease, which is right when the camera moves
    // on its own and completely wrong under a hand: dragging through it feels
    // like the board is stuck to the cursor by elastic.
    root.classList.add('free')
    const rect = stage.getBoundingClientRect()
    const ox = ev.clientX - rect.left - rect.width / 2 - user.dx
    const oy = ev.clientY - rect.top - rect.height / 2 - user.dy
    const next = Math.min(6, Math.max(0.4, user.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)))
    const ratio = next / user.k
    user.dx -= ox * (ratio - 1)
    user.dy -= oy * (ratio - 1)
    user.k = next
    apply()
  }, { passive: false })

  let drag = null
  stage.addEventListener('pointerdown', (ev) => {
    root.classList.add('free')
    drag = { x: ev.clientX, y: ev.clientY, dx: user.dx, dy: user.dy }
    stage.setPointerCapture(ev.pointerId)
    stage.style.cursor = 'grabbing'
  })
  stage.addEventListener('pointermove', (ev) => {
    if (!drag) return
    user.dx = drag.dx + (ev.clientX - drag.x)
    user.dy = drag.dy + (ev.clientY - drag.y)
    apply()
  })
  for (const done of ['pointerup', 'pointercancel']) {
    stage.addEventListener(done, () => { drag = null; stage.style.cursor = '' })
  }

  function go(index) {
    at = (index + scenes.length) % scenes.length
    root.classList.remove('free')
    const sc = scenes[at]
    const visible = new Set(sc.ids)
    for (const [id, el] of Object.entries(NODES)) el.classList.toggle('out', !visible.has(id))
    draw(visible, sc.wf)

    // Fit the camera to what is in frame — the whole reason a scene is a set of
    // nodes rather than a highlight over one fixed picture.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const id of (sc.focus && sc.focus.length ? sc.focus : sc.ids)) {
      const n = world[id]; if (!n) continue
      x0 = Math.min(x0, n.x - 120); x1 = Math.max(x1, n.x + 120)
      y0 = Math.min(y0, n.y - 74); y1 = Math.max(y1, n.y + 74)
    }
    const pad = 44
    const w = stage.clientWidth, h = stage.clientHeight
    fitted = {
      k: Math.min(1.55, (w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0)),
      x: (x0 + x1) / 2, y: (y0 + y1) / 2,
    }
    // A new scene means a new frame, so the reader's own zoom starts over —
    // carrying it across would drop them into a corner of a board they have
    // not seen yet.
    user = { k: 1, dx: 0, dy: 0 }
    apply()

    root.querySelector('[data-tour-kicker]').textContent = sc.kicker || ''
    root.querySelector('[data-tour-title]').textContent = sc.title || ''
    root.querySelector('[data-tour-caption]').textContent = sc.caption || ''
    root.querySelector('[data-tour-stamp]').textContent = (at + 1) + ' / ' + scenes.length
    dots.forEach((d, i) => d.setAttribute('aria-current', String(i === at)))
  }

  const dotBar = root.querySelector('[data-tour-dots]')
  const dots = scenes.map((sc, i) => {
    const d = document.createElement('button')
    d.type = 'button'
    d.setAttribute('aria-label', 'Scene ' + (i + 1) + ': ' + sc.title)
    d.onclick = () => go(i)
    dotBar.appendChild(d)
    return d
  })
  root.querySelector('[data-tour-next]').onclick = () => go(at + 1)
  root.querySelector('[data-tour-prev]').onclick = () => go(at - 1)

  // Zoom by keyboard as well as by wheel: a wheel is not available to everyone,
  // and a board only a mouse can read is a board some readers cannot.
  const nudge = (factor) => { root.classList.add('free'); user.k = Math.min(6, Math.max(0.4, user.k * factor)); apply() }
  const reset = () => { root.classList.remove('free'); user = { k: 1, dx: 0, dy: 0 }; apply() }
  root.querySelector('[data-tour-in]').onclick = () => nudge(1.25)
  root.querySelector('[data-tour-out]').onclick = () => nudge(1 / 1.25)
  root.querySelector('[data-tour-fit]').onclick = reset
  // Arrow keys only while the board itself has focus: the page still scrolls.
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight') { ev.preventDefault(); go(at + 1) }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(at - 1) }
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); nudge(1.25) }
    if (ev.key === '-') { ev.preventDefault(); nudge(1 / 1.25) }
    if (ev.key === '0') { ev.preventDefault(); reset() }
  })
  addEventListener('resize', () => go(at))
  go(0)
})()
`
