// graph-tour.mjs — the loop graph as a guided tour rather than one static wall.
//
// SSOT for what this page may draw and why:
// `references/loop-graph-page.md`. Every rule there was written after the
// picture proved it. If this file and that one disagree, one is a defect.
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
const OUTSIDE_Y = ROW_CONTROL
const OUTSIDE_GAP = 150

const rowWidth = (team) =>
  team.worker_ids.length * CARD_W + (team.worker_ids.length - 1) * WORKER_GAP

// ── the tour ────────────────────────────────────────────────────────────────
// `cards` is a Map from agent_id to whatever graph.mjs derived for that seat.
// Anything it carries travels into the page untouched; this module never
// invents a status, a model or a time.
export function buildTour(graph, cards = new Map(), occupancy = { counts: new Map(), held: new Map() },
  teamFacts = new Map(), board = {}) {
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

    // The control team has no seat cards, so its own node carries the
    // controller's evidence — status, lane, verified model, clock. Dropping the
    // cards must not drop the facts: the seat still runs on a model and still
    // has a state, and a node that only names a team would say less than the
    // ledger knows.
    const controllerCard = isControl ? cards.get(graph.outer_controller_id) : null
    world[teamNodeId] = {
      id: teamNodeId, x: centre, y: isControlTeam ? ROW_CONTROL : ROW_TEAM,
      kind: isControl ? 'control' : 'team',
      title: team.name,
      state: controllerCard?.state || '',
      status: controllerCard?.status || '',
      // The controller's clock rides with it, outside `lines`, for the same
      // reason every seat's does: a ticking value inside the compared payload
      // makes every publish look like a change.
      time: controllerCard?.time || '',
      // A token this team is holding has stopped and is waiting on a decision.
      // It is a different fact from "busy": one is work happening, the other is
      // work that cannot happen until someone answers.
      stuck: Boolean(facts.stuck),
      // The teams the work it is holding was pulled from, straight out of the
      // ledger. A team can sit on several routes, so only the record knows
      // which leg this token actually travelled.
      cameFrom: facts.cameFrom || [],
      // A team's whole state in two lines: what it holds out of what it may
      // hold, then the tokens themselves when it holds any.
      lines: [
        `WIP ${wip}/${team.wip_limit}${wip >= team.wip_limit ? ' · full' : ''}`,
        held.length ? held.join(', ') : 'no work held',
        ...(controllerCard?.lines || []),
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
        time: card.time || '',
        status: card.status || 'unbound',
        running: Boolean(card.running),
        role: card.role || kind,
      }
    }

    // The control team is drawn as ONE node. Its three seats — grill, unstick,
    // audit — are three jobs the controller does at three different moments,
    // not three stations work passes through, and drawn as peer cards they made
    // the front door read as a fourth delivery team. Every other team keeps its
    // seats, because there work really does move dispatcher → worker →
    // evaluator and a reader has to see which worker holds what.
    if (isControlTeam) continue

    seat(team.dispatcher_id, 'dispatcher', ROW_DISPATCHER, centre)
    seat(team.evaluator_id, 'evaluator', ROW_EVALUATOR, centre)

    const left = centre - rowWidth(team) / 2 + CARD_W / 2
    team.worker_ids.forEach((workerId, index) => {
      // The controller holds a worker seat on its own team. It is the seat
      // `outer_controller_id` already names — the same seat named twice, not
      // two seats — so it is drawn ONCE, here, and never again as a band of
      // its own above the board.
      const kind = workerId === graph.outer_controller_id ? 'controller' : 'worker'
      seat(workerId, kind, ROW_WORKER, left + index * (CARD_W + WORKER_GAP))
      // An edge hardens only once something recorded happened along it. Drawn
      // solid by default, the picture would claim every declared relationship
      // as an observed one — the exact attestation-over-evidence failure this
      // whole page exists to refuse.
      const seenWorker = cards.get(workerId) || {}
      edges.push({ from: team.dispatcher_id, to: workerId, kind: 'assign', solid: Boolean(seenWorker.dispatched) })
      edges.push({ from: workerId, to: team.evaluator_id, kind: 'judge', solid: Boolean(seenWorker.settled) })
    })

    // Rework returns to the team's own DISPATCHER — one line per team, not one
    // per worker. Drawn back to the worker that was judged, the picture says
    // rejected work stays with whoever produced it; in this loop it goes back
    // into the queue and is dispatched again, which may well be to someone
    // else and only once the team is under its WIP limit.
    edges.push({
      from: team.evaluator_id, to: team.dispatcher_id, kind: 'reject', solid: Boolean(facts.rejected),
    })

    // Structure, not a claim about the past: this team HAS that dispatcher
    // whether or not anything ever ran. Only the three edges above say
    // something happened, and only those wait for evidence.
    edges.push({ from: teamNodeId, to: team.dispatcher_id, kind: 'owns', solid: true })
    // Oversight is a real relationship but never a reflexive one: the control
    // team escalating to itself would be a line that means nothing. The old
    // page drew that line, because it drew oversight before the controller had
    // a team to belong to.
    // Every team can interrupt the controller at any moment, so this line exists
    // for all of them whether or not any route ends there. It is the one that
    // crawls: an escalation is a condition, not a handover, and nothing travels
    // along it — the token stays where it is stuck while a person is asked.
    if (controlId && !isControl) {
      edges.push({ from: teamNodeId, to: `team:${controlId}`, kind: 'escalate', solid: true })
    }
  }

  // There is no node for the incoming request. It would carry no evidence, no
  // WIP and no seat — a label, not a fact — and the control team already says
  // everything true about it: work enters there, one at a time.
  // `audited` and nothing else. `completed` is half closed — the controller
  // still has to read the delivery as a whole — and `abandoned` is work that
  // left, not work that landed. A sink that counted either would report a
  // number nobody could act on.
  const done = Number.isFinite(board.delivered) ? board.delivered : null
  world.delivered = {
    id: 'delivered', x: boardWidth + OUTSIDE_GAP, y: OUTSIDE_Y, kind: 'outside',
    title: 'Delivered',
    state: done === null ? '' : `${done} audited`,
    lines: ['read as a whole, then closed'],
    role: 'end, not a team',
  }

  // ONE line leaves the audit for the sink. What crosses it is the same fact
  // every time — work the controller has read and passed.
  if (controlId) edges.push({ from: `team:${controlId}`, to: 'delivered', kind: 'passed', solid: true })

  // How work actually travels, which is not the same as who has authority over
  // it. `pull-controller` hands a token from one team to the next directly —
  // the RECEIVING team pulls it when it has room — so that handover is a line
  // between two teams, not a trip back through the controller.
  //
  // Each of these is derived from the routes and then DEDUPED: two workflows
  // that both run development → qa share one line, because it is one
  // relationship. That is what keeps a route an order over the wiring rather
  // than wiring of its own.
  const seenEdge = new Set()
  const addOnce = (from, to, kind) => {
    const key = `${from}>${to}>${kind}`
    if (seenEdge.has(key)) return
    seenEdge.add(key)
    edges.push({ from, to, kind, solid: true })
  }
  // The controller can hand work straight to ANY team — that is what holding
  // the front door means, and a route only decides which one it uses this
  // time. It is a `pull` like every other handover, because that is what the
  // runtime writes: `pull-controller` records `pulled` with a `from_team` for
  // the FIRST leg too, not only for team-to-team hops. A separate `send` kind
  // said the first hop was a different kind of event than the rest, which the
  // ledger does not agree with.
  if (controlId) {
    for (const team of graph.teams) {
      if (team.team_id === controlId) continue
      addOnce(`team:${controlId}`, `team:${team.team_id}`, 'pull')
    }
  }
  for (const workflow of graph.workflows) {
    const legs = workflow.route.filter((teamId) => teamId !== controlId)
    if (!legs.length) continue
    // Across: the next team pulls from the one before it.
    for (let i = 1; i < legs.length; i += 1) {
      addOnce(`team:${legs[i - 1]}`, `team:${legs[i]}`, 'pull')
    }
  }

  // A route is an ORDER over the wiring above, never wiring of its own. This is
  // the sequence a token takes — down to a team, back to control, down to the
  // next — and it exists only to animate. It adds no edge to the board.
  // Custody, and only custody. The route ends where the ledger ends it: the
  // last team writes `completed` (§6) and the controller's audit is a
  // RELEASING event — it reads the delivery, it never takes the token back.
  // An earlier version sent a token home to control and on to the sink, which
  // animated two handovers the ledger has no record of; worse, the "home" hop
  // reused the outbound wire without reversing it, so the dot ran controller →
  // team a second time and then jumped back. `passed` stays on the board as a
  // relationship, with no token on it, because nothing travels it.
  const orderOf = (workflow) => {
    const legs = workflow.route.filter((teamId) => teamId !== controlId)
    if (!legs.length) return []
    const trip = [`team:${controlId}>team:${legs[0]}>pull`]
    for (let i = 1; i < legs.length; i += 1) {
      trip.push(`team:${legs[i - 1]}>team:${legs[i]}>pull`)
    }
    return trip
  }
  const ORDERS = new Map(graph.workflows.map((workflow) => [workflow.workflow_id, orderOf(workflow)]))

  // The control team has no seat nodes, so naming its seats here would put ids
  // in a scene that the world has never heard of — and the camera would frame
  // coordinates that do not exist.
  const agentsOf = (teamId) => {
    const team = graph.teams.find((entry) => entry.team_id === teamId)
    if (!team) return []
    if (teamId === controlId) return [`team:${teamId}`]
    return [`team:${teamId}`, team.dispatcher_id, ...team.worker_ids, team.evaluator_id]
  }
  const everything = Object.keys(world)

  // Scene 0 does not move at all: no crawl, and no token either. It answers
  // "who exists", and a board where anything is moving cannot also say which
  // parts move — motion means something only once everything else holds still.
  // Carrying one token here was the complicated way to say that; giving the
  // scene no route to animate is the simple one.
  const scenes = [{
    id: 'all', wf: null, kicker: 'The board', still: true, motion: null,
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
      id: workflow.workflow_id, wf: workflow.workflow_id, motion: workflow.workflow_id,
      kicker: `route · ${workflow.workflow_id}`,
      title: workflow.name,
      caption: workflow.route.join(' → ')
        + (skipped.length
          ? ` · never touches ${skipped.join(', ')} — ${skipped.length === 1 ? 'that team is' : 'those teams are'}`
            + ` still on the board, this route just does not use ${skipped.length === 1 ? 'it' : 'them'}.`
          : ' · every team on the board.'),
      ids: ['delivered', ...workflow.route.flatMap(agentsOf)],
      // The camera frames the TEAMS on the route, not the two labels that sit
      // outside the board. Every route starts at control on the far left and
      // ends at the sink on the far right, so framing those two would make
      // every scene exactly as wide as the whole board and the zoom — the
      // reason a scene is a set of nodes at all — would never do anything.
      focus: workflow.route.flatMap(agentsOf),
    })
  }
  return { world, edges, scenes, orders: Object.fromEntries(ORDERS), width: boardWidth }
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

// What the page compares to decide whether it changed. Clocks are stripped:
// they move every tick on their own, and reloading a board to advance a
// timestamp throws the reader out of whatever they were reading.
export function tourDigest(tour) {
  const stable = JSON.stringify(tour, (key, value) => (key === 'time' ? undefined : value))
  let h = 2166136261
  for (let i = 0; i < stable.length; i += 1) { h ^= stable.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16)
}

export function renderTourChart(tour, { describedBy = 'tour-desc' } = {}) {
  return `<div class="tour" data-tour data-tour-digest="${tourDigest(tour)}">
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
/* The control node carries the controller's evidence as well as the team's, so
   zoomed out it keeps only what is readable from across the board: how full the
   door is, and what it is holding. */
.tour.lean .k-control span:nth-of-type(n+3){display:none}
.tour-cam,.tour-wires{position:absolute;inset:0;width:100%;height:100%;transform-origin:0 0;
 transition:transform .62s cubic-bezier(.22,.61,.36,1)}
.tour-wires{overflow:visible;pointer-events:none}
.wire{fill:none;stroke-width:1.8;transition:opacity .4s;vector-effect:non-scaling-stroke}
/* Solid means a record exists for it. Dashed means the operating model with
   nothing measured yet — the difference the whole page rests on. */
.wire.dry{stroke-dasharray:5 5;opacity:.34}
/* AFTER .dry, and the order is the rule rather than a preference: both are
   specificity (0,2,0), so whichever is written last wins. With .dry below it,
   an edge told to leave the scene was painted straight back in at .34, and the
   teams a route skips kept their wiring on screen. */
/* Leaving a scene wins over everything. This rule sat here as an ordinary one
   and lost to any later rule of equal specificity — first the dry state, then
   the raised escalation, which restored opacity .9 AND kept animating on wires
   already told to leave. Weight ends that family of bug instead of re-fixing it
   every time a state class is written below. */
.wire.off{opacity:0!important;animation:none!important}
/* Motion carries one meaning and only one: an edge with NOTHING recorded behind
   it crawls, and goes still the moment a record exists. So a board that has
   stopped moving is a board where everything on screen is backed by evidence —
   the opposite of decoration, and the opposite of codegraph, where the flow is
   ambient. -20 is exactly two dash periods (5+5), so the loop has no seam. */
.tour:not(.still) .wire.dry{animation:tourFlow 1.1s linear infinite}
.tour.quiet .wire.dry{animation:none}
@keyframes tourFlow{to{stroke-dashoffset:-20}}
/* Every handover is one colour. Green made the return leg and the delivery
   read as a different KIND of relationship, when they are the same one —
   work changing hands — at a different moment. */
.w-passed{stroke:var(--handoff);stroke-width:2.6;opacity:.85}
.tour-token{fill:var(--handoff);filter:drop-shadow(0 0 6px var(--handoff))}
/* Green, like the ring on the seat it is feeding: this token is evidence of
   work in hand, not an explanation of how a route runs. */
.tour-token-live{fill:var(--ok)}
.tour-token-live.tour-token{filter:drop-shadow(0 0 6px var(--ok))}
.tour-tail{fill:var(--handoff)}
/* The travelling dot IS a work item — a token moving down its route, not an
   ornament. That is why the opening board holds still while one still runs: the
   dash crawl says "nothing recorded here" and would be noise across the whole
   board at once, while the token shows what the route DOES, and needs somewhere
   quiet to be legible. Reduced motion stops both. */
.tour.quiet .tour-token,.tour.quiet .tour-tail{visibility:hidden}
.tour-halo{fill:none;stroke:var(--handoff);opacity:0;vector-effect:non-scaling-stroke}
/* Peak at 40%, not 50%: a quick inhale and a slow exhale reads as alive, while
   a symmetric one reads as a pulse meter. */
.tour:not(.quiet) .tour-halo{animation:tourHalo 2.6s ease-in-out infinite}
/* The live ring is green because it reports evidence, not the route colour:
   this seat has a dispatch running on it right now. It breathes on the opening
   board too — that scene is the live one, and a board that cannot show work in
   progress is not reporting a state, it is drawing a diagram. */
.tour-live{stroke:var(--ok)}
/* Stuck is red and it is not the same news as busy: one is work happening,
   the other is work that has stopped and needs a person. */
.tour-stuck{stroke:var(--bad)}
.tour.quiet .tour-live,.tour.quiet .tour-stuck{animation:none;opacity:.55}
.wire.live{stroke-dasharray:6 4;animation:tourFlow .9s linear infinite}
.tour.quiet .wire.live{animation:none}
@keyframes tourHalo{0%,100%{opacity:0;stroke-width:1}40%{opacity:.5;stroke-width:2.4}}
.w-assign{stroke:var(--assign);opacity:.5}
.w-judge{stroke:var(--artifact);opacity:.55}
.w-reject{stroke:var(--reject);opacity:.5}
.w-owns{stroke:var(--line)}
.w-pull{stroke:var(--handoff);stroke-width:2.4;opacity:.8}
/* Escalation is a CONDITION, not a handover: nothing travels it. It is red
   because it is the same news as a rejection — work that cannot move — and it
   only crawls when a token is ACTUALLY stuck on it. An escalation line that
   animates all the time reports an emergency that is not happening. */
.w-escalate{stroke:var(--bad);stroke-width:1.8;stroke-dasharray:5 5;opacity:.35}
.w-escalate.raised{opacity:.9;stroke-width:2.4}
.tour:not(.quiet) .w-escalate.raised{animation:tourFlow 1.1s linear infinite}
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
/* Never hidden by the zoom-out rule: a stuck team must be readable at any
   scale, and this is the only place that state exists as text. */
.tnode .tnode-flag{color:var(--bad)}
.tnode.s-working .tnode-flag,.k-team .tnode-flag{color:var(--ok)}
.tnode.out{opacity:0;transform:translate(-50%,-50%) scale(.82);pointer-events:none}
.k-team{background:var(--ink);border-color:var(--ink)}
.k-team b{color:var(--bg)}.k-team span{color:var(--surface-2);opacity:.9}
.k-control{background:var(--ink);border-color:var(--oversight);
 box-shadow:0 0 0 3px color-mix(in oklch,var(--oversight) 32%,transparent)}
.k-control b{color:var(--bg)}.k-control span{color:var(--surface-2);opacity:.9}
.k-dispatcher{border-color:var(--assign)}
.k-evaluator{border-color:var(--artifact)}
.k-controller{border-color:var(--oversight);background:var(--surface-2)}
/* The sink is where work lands, so it is drawn as a destination rather than a
   footnote: its own surface, room around the text, and a count big enough to
   read from across the board. It keeps the dashed border because it is still
   not a team — nothing is dispatched there and it holds no WIP. */
.k-outside{background:var(--surface-2);border-style:dashed;border-width:2px;
 padding:14px 26px;border-radius:14px;min-width:150px;text-align:center}
.k-outside b{font:600 .95rem/1.3 var(--sans)}
.k-outside em{color:var(--ok);font:700 1.15rem/1.4 var(--sans);
 font-variant-numeric:tabular-nums;letter-spacing:0}
.k-outside span{font-size:.68rem}
/* The count is the one thing on this node worth reading zoomed out. */
.tour.lean .k-outside span{display:none}
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

  // This page reloads itself whenever the snapshot changes, which threw the
  // reader back to scene 1 at the default zoom every few seconds — unusable
  // for the one thing it is for, which is sitting and watching. Where you were
  // looking survives the reload; the DATA is always the new data.
  const SEAT = 'tmux-teams.graph.seat'
  const remember = () => {
    try {
      sessionStorage.setItem(SEAT, JSON.stringify({ at, k: user.k, dx: user.dx, dy: user.dy }))
    } catch (error) { /* private mode: the board still works, it just forgets */ }
  }
  const seated = (() => {
    try { return JSON.parse(sessionStorage.getItem(SEAT) || 'null') } catch { return null }
  })()

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
    // The rings and the crawl are drawn in an aria-hidden SVG, so without this
    // the two states that most need acting on reach nobody using a screen
    // reader. Text, not colour and not motion.
    if (n.stuck || n.running) {
      const flag = document.createElement('em')
      flag.className = 'tnode-flag'
      flag.textContent = n.stuck ? '! STUCK — waiting on a decision' : '● WORKING NOW'
      el.appendChild(flag)
    }
    if (n.state) { const s = document.createElement('em'); s.textContent = n.state; el.appendChild(s) }
    for (const line of [...(n.lines || []), n.time]) {
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
    // Down and back share two endpoints, so they must bow apart or they land on
    // the same pixels and the board looks like it has half the wiring it has.
    // Escalation and audit both run team → controller, so they must bow apart
    // or the two meanings land on the same pixels.
    pull: 0, escalate: -46, passed: 0,
  }
  const NS = 'http://www.w3.org/2000/svg'
  // FNV-1a, 0..1. Deterministic on purpose: the same edge desyncs the same way
  // on every reload, so the board looks like itself rather than like a fresh
  // roll of dice each time somebody opens it.
  const hash = (str) => {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return ((h >>> 0) % 1000) / 1000
  }
  const seen = {}
  const WIRES = edges.map((e) => {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('class', 'wire w-' + e.kind + (e.solid ? '' : ' dry'))
    // Both ends named on the element. A wire is otherwise identified only by a
    // path string, which makes anything checking the board — a test, a console,
    // a reader — reverse-engineer geometry to answer "which edge is this".
    p.setAttribute('data-from', e.from)
    p.setAttribute('data-to', e.to)
    // A NEGATIVE delay of exactly one period drops each edge into mid-cycle at
    // its own deterministic point. Without it every dash on the board advances
    // in lockstep and the whole thing beats like a metronome.
    if (!e.solid) p.style.animationDelay = (hash(e.from + e.to) * -1.1) + 's'
    svg.appendChild(p)
    const key = e.from + '>' + e.kind
    return { e, p, lane: (seen[key] = (seen[key] ?? -1) + 1) }
  })

  // One TOKEN per route hop, and one halo per team on that route. The dot is a
  // work item travelling its route — that is the whole reading of it — and it
  // is given the wire's OWN d, which is what makes it impossible for a token to
  // appear anywhere its route does not go. Built once per route and shown per
  // scene, so changing scene never rebuilds the DOM.
  const wireOf = new Map(WIRES.map((w) => [w.e.from + '>' + w.e.to + '>' + w.e.kind, w]))

  // A halo on whatever is RUNNING right now. This is the one piece of motion
  // that belongs on the opening board: that scene reports the live state, so a
  // seat that is working has to be visible as working. It is keyed off the
  // status the ledger produced — never off which route is on screen — so it
  // appears when there is something to see and not otherwise.
  const liveLayer = document.createElementNS(NS, 'g')
  svg.appendChild(liveLayer)
  const LIVE = []
  for (const node of Object.values(world)) {
    const state = node.status === 'working' ? 'live' : (node.stuck ? 'stuck' : null)
    if (!state) continue
    const ring = document.createElementNS(NS, 'rect')
    ring.setAttribute('class', 'tour-halo tour-' + state)
    ring.setAttribute('rx', 12)
    ring.style.animationDelay = (hash(node.id) * -2.6) + 's'
    liveLayer.appendChild(ring)
    LIVE.push({ el: ring, around: node.id })
  }

  // A token on the leg that DELIVERED the work a busy team is holding. The
  // route tokens explain how work is meant to travel; this one reports where
  // this particular work came from, so it is on the live board with the rings.
  const liveTokens = []
  for (const node of Object.values(world)) {
    // A stuck team is not receiving work, it is holding work that stopped, so
    // a token arriving would contradict its own red ring.
    if (!node.cameFrom?.length || node.stuck) continue
    for (const fromTeam of node.cameFrom) {
      const wire = wireOf.get('team:' + fromTeam + '>' + node.id + '>pull')
      if (!wire) continue
      for (let t = 0; t < 3; t += 1) {
        const dot = document.createElementNS(NS, 'circle')
        dot.setAttribute('class', t === 0 ? 'tour-token tour-token-live' : 'tour-tail tour-token-live')
        dot.setAttribute('r', t === 0 ? 4 : 4 - t)
        if (t) dot.setAttribute('opacity', 0.42 / t)
        const motion = document.createElementNS(NS, 'animateMotion')
        motion.setAttribute('dur', '1.6s')
        motion.setAttribute('repeatCount', 'indefinite')
        motion.setAttribute('begin', (hash(node.id) * 1.6 + t * 0.055).toFixed(3) + 's')
        motion.setAttribute('calcMode', 'linear')
        dot.appendChild(motion)
        liveLayer.appendChild(dot)
        liveTokens.push({ el: dot, motion, wire })
      }
    }
  }

  const haloLayer = document.createElementNS(NS, 'g')
  const cometLayer = document.createElementNS(NS, 'g')
  svg.appendChild(haloLayer)
  svg.appendChild(cometLayer)
  // Keyed by kind as well as by endpoints. Two routes can share a hop —
  // development → qa is on both the full route and the hotfix — so a
  // from>to key silently kept only whichever wire was built last, and a
  // comet on one route ended up riding another route's line.
  const MOTION = []
  // Built once per ROUTE, not once per scene: the opening board and the full
  // route both animate the same workflow, and building per scene made two
  // comets for every hop of it.
  const animated = [...new Set(scenes.map((scene) => scene.motion).filter(Boolean))]
  for (const wf of animated) {
    // The order names wires that already exist — control → team, team → control,
    // and finally control → the sink. A route therefore adds nothing to the
    // board: it is a path THROUGH it, which is why switching scene only ever
    // removes teams and never redraws a connection.
    const hops = (data.orders?.[wf] || []).map((key) => wireOf.get(key)).filter(Boolean)
    hops.forEach((w, i) => {
      const hop = w.e
      const node = world[hop.from]
      if (node) {
        const halo = document.createElementNS(NS, 'rect')
        halo.setAttribute('class', 'tour-halo')
        halo.setAttribute('rx', 12)
        // Staggered in reading order, so the halos travel the route too. The
        // box is measured from the rendered card below — a card is
        // sized by its text, so a fixed rectangle fits nothing.
        halo.style.animationDelay = (i * 0.35) + 's'
        haloLayer.appendChild(halo)
        MOTION.push({ wf, el: halo, around: hop.from })
      }
      const dur = 1.6
      // 'begin' staggers hop i so the route reads as one token travelling it,
      // not as N dots firing at once.
      const begin = i * dur / Math.max(1, hops.length)
      for (let t = 0; t < 3; t++) {
        const dot = document.createElementNS(NS, 'circle')
        // Head plus two fading tail dots: one token, motion-blurred, rather
        // than three tokens in a row.
        dot.setAttribute('class', t === 0 ? 'tour-token' : 'tour-tail')
        dot.setAttribute('r', t === 0 ? 4 : 4 - t)
        if (t) dot.setAttribute('opacity', 0.42 / t)
        const motion = document.createElementNS(NS, 'animateMotion')
        motion.setAttribute('dur', dur + 's')
        motion.setAttribute('repeatCount', 'indefinite')
        motion.setAttribute('begin', (begin + t * 0.055).toFixed(3) + 's')
        motion.setAttribute('calcMode', 'linear')
        dot.appendChild(motion)
        cometLayer.appendChild(dot)
        MOTION.push({ wf, el: dot, motion, wire: w })
      }
    })
  }

  // The three that carry a token, and therefore belong to one route at a time.
  // Everything else — ownership, assignment, review, rework, escalation, the
  // line out to the sink — is true on every scene.
  const HANDOVER = new Set(['pull'])
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const RUNNING = new Set(Object.values(world).filter((n) => n.running).map((n) => n.id))
  const STUCK = new Set(Object.values(world).filter((n) => n.stuck).map((n) => n.id))
  function draw(visible, motionWf) {
    const order = motionWf ? new Set(data.orders?.[motionWf] || []) : null
    for (const { e, p, lane } of WIRES) {
      // A leg with something running on it crawls, whichever scene is up: it is
      // the live state, not an explanation. The dry crawl means "nothing
      // recorded here"; this one means "happening now", so they are separate
      // classes even though both move.
      // A running worker means the ASSIGNMENT is live. The handover to the
      // evaluator has not happened — that is what "still running" means — so
      // crawling it too claimed an artifact was in motion that nobody sent.
      p.classList.toggle('live', e.kind === 'assign' && RUNNING.has(e.to))
      // Raised only while that team really is stuck, so the red crawl reports
      // an event rather than decorating the possibility of one.
      if (e.kind === 'escalate') p.classList.toggle('raised', STUCK.has(e.from))
      // Structure is shown wherever both ends survive. Handovers are not: a
      // scene showing ONE route must show only that route's handovers, or a
      // route that happens to use every team keeps every other route's lines
      // on screen — the board would say the controller can hand straight to
      // development while the route being explained never does that.
      //
      // The opening board keeps them all on purpose: with no route selected,
      // "the controller can send work directly to any team" is exactly the
      // true thing to say.
      const on = visible.has(e.from) && visible.has(e.to)
        && (!order || !HANDOVER.has(e.kind) || order.has(e.from + '>' + e.to + '>' + e.kind))
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
    for (const m of MOTION) {
      const on = m.wf === motionWf
      m.el.style.display = on ? '' : 'none'
      // Copy the finished d rather than recomputing it: two independent
      // derivations of the same curve is two curves waiting to disagree.
      if (!on) continue
      if (m.motion) m.motion.setAttribute('path', m.wire.p.getAttribute('d'))
    }
    // Live rings and live tokens follow their own node, not the route: they
    // report state, so they show wherever that node is on screen and vanish
    // with it. Without this they stayed lit on scenes their team had left.
    for (const live of LIVE) live.el.style.display = visible.has(live.around) ? '' : 'none'
    for (const live of liveTokens) {
      const on = !live.wire.p.classList.contains('off')
      live.el.style.display = on ? '' : 'none'
      if (on) live.motion.setAttribute('path', live.wire.p.getAttribute('d'))
    }
    fitHalos()
  }

  // A card carries five lines of evidence, which is four more than the picture
  // can show at board scale. Rather than drop them — the page would then say
  // less than the ledger knows — they are hidden while the board is zoomed out
  // and appear as soon as the reader zooms in far enough to read them.
  const DETAIL_AT = 0.86
  // A card is sized by its own text, so a halo is MEASURED, never assumed — a
  // constant rectangle fits no node on the board. It has to run after the zoom
  // class is settled, not during draw(): 'lean' hides two lines of the control
  // card, so measuring first left that one halo 27px taller than the card it
  // was supposed to be ringing while every other one fitted.
  function fitHalos() {
    for (const m of [...MOTION, ...LIVE]) {
      if (!m.around || m.el.style.display === 'none') continue
      const card = NODES[m.around]
      const n = world[m.around]
      // offsetWidth/Height are in board units: the camera scale lives on an
      // ancestor transform, so these are exactly the numbers the rect needs.
      // A ring of 6 a side — more and it stops reading as "this node" and
      // starts reading as "this area".
      const w2 = (card?.offsetWidth || 140) / 2 + 6
      const h2 = (card?.offsetHeight || 46) / 2 + 6
      m.el.setAttribute('x', n.x - w2); m.el.setAttribute('y', n.y - h2)
      m.el.setAttribute('width', w2 * 2); m.el.setAttribute('height', h2 * 2)
    }
  }

  function apply() {
    const k = fitted.k * user.k
    const w = stage.clientWidth, h = stage.clientHeight
    const t = 'translate(' + (w / 2 + user.dx) + 'px,' + (h / 2 + user.dy) + 'px) scale(' + k
      + ') translate(' + (-fitted.x) + 'px,' + (-fitted.y) + 'px)'
    cam.style.transform = t
    svg.style.transform = t
    root.classList.toggle('lean', k < DETAIL_AT)
    // The class just changed what a card measures, so the halos have to follow.
    fitHalos()
    remember()
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

  let restoring = Boolean(seated)
  function go(index) {
    at = (index + scenes.length) % scenes.length
    root.classList.remove('free')
    const sc = scenes[at]
    const visible = new Set(sc.ids)
    root.classList.toggle('still', Boolean(sc.still))
    for (const [id, el] of Object.entries(NODES)) {
      const gone = !visible.has(id)
      el.classList.toggle('out', gone)
      // Fading to zero opacity hides a node from eyes only: a screen reader still read
      // every team a route had skipped, so the one audience that cannot see
      // the fade got the whole board plus a route that made no sense.
      el.toggleAttribute('inert', gone)
      el.setAttribute('aria-hidden', String(gone))
    }
    draw(visible, sc.motion)

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
    // A scene change resets the reader's zoom — except on the first paint
    // after a reload, where restoring it is the whole point.
    user = restoring && seated ? { k: seated.k, dx: seated.dx, dy: seated.dy } : { k: 1, dx: 0, dy: 0 }
    restoring = false
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
  // Motion is a client loop: it keeps running long after the producer stops,
  // so a stale board went on breathing and reported a system that was not
  // there. The refresh script stamps freshness on <body>; watch it and go
  // quiet, because the honest thing for a page with no fresh evidence is to
  // stop claiming any.
  const freshness = () => {
    const stale = document.body.dataset.observationFreshness === 'stale'
    root.classList.toggle('quiet', stale || reduced.matches)
    try { stale || reduced.matches ? svg.pauseAnimations() : svg.unpauseAnimations() } catch (error) { /* no SMIL */ }
  }
  new MutationObserver(freshness).observe(document.body, {
    attributes: true, attributeFilter: ['data-observation-freshness'],
  })

  addEventListener('resize', () => go(at))
  // A CSS media query cannot reach SMIL, so reduced motion has to stop the
  // comets explicitly — and it has to keep listening, because the preference
  // can change while the page is open and reading it once at load ignored
  // every reader who turned it on afterwards.
  reduced.addEventListener('change', freshness)
  freshness()
  go(seated ? seated.at : 0)
})()
`
