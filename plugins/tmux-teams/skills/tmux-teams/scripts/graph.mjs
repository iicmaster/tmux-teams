// graph.mjs — the loop graph: every team, every agent, and the routes.
//
// Two inputs, kept strictly apart:
//   DECLARATION  <repo>/.tmux-teams/team-graph.json — the Team pool and the
//                Workflows routed over it. Team, role and WIP limit live here
//                and nowhere else; they are assigned, never observed.
//   EVIDENCE     <repo>/.tmux-teams/pulse.json — what actually ran.
//
// The page has two bands and they answer different questions:
//   ROUTES   a plain horizontal team-level strip per workflow — how work can
//            move. No agents here; that detail belongs below.
//   TEAMS    the whole pool once, with every declared agent as one node. Teams
//            are never duplicated per workflow, so an agent appears exactly
//            once no matter how many routes use its team.
//
// Edges carry meaning by COLOUR, not by text: a label on every arrow turned the
// graph into noise. The legend states what each colour means, once.
//
// Where work actually is right now is the kanban board's job, not this page's.
//
// Copy is English: these pages get shared outside the team.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KANIT_FONT_CSS } from '../assets/kanit/kanit-embedded.mjs'
import { readDispatchFacts, readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { DEFAULT_WORKFLOW_GRAPH, WORKFLOW_GRAPH_FILE, validateWorkflowGraph } from './workflow-graph.mjs'

const FONT_CSS_NAME = `pulse-fonts-${createHash('sha256').update(KANIT_FONT_CSS).digest('hex')}.css`

export { DEFAULT_WORKFLOW_GRAPH, WORKFLOW_GRAPH_FILE }

const WORKING = new Set(['running', 'starting', 'orphan_running'])
const DELIVERED = new Set(['awaiting-verdict', 'unrecorded'])
const DEAD = new Set(['died', 'unknown'])

export const esc = (value) => String(value ?? '').replace(
  /[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]),
)

export const clip = (value, max) => {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Exported so the kanban board formats a duration the same way this page does.
// Two formatters is two truths about time.
export const duration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

export function readWorkflowGraph(repo) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(repo, '.tmux-teams', WORKFLOW_GRAPH_FILE), 'utf8'))
  } catch {
    return { ...validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH), source: 'default' }
  }
  return { ...validateWorkflowGraph(raw), source: WORKFLOW_GRAPH_FILE }
}

// ── LOOP HEALTH ──────────────────────────────────────────────────────────────
// Every other input on this page describes the AGENTS. None of them describes
// the LOOP. A runner that stopped dispatching leaves a board that looks calm:
// no agent is running, nothing is overdue, and a reader concludes there is
// simply no work. The runner therefore stamps its own pulse, and the page
// refuses to draw a calm board without saying whether anything is still driving
// it.
export const RUNNER_HEARTBEAT_FILE = 'runner-heartbeat.json'
const HEARTBEAT_SCHEMA = 'tmux-teams.runner-heartbeat'
// The runner declares its own tick, so the page never hard-codes how long its
// silence may run — a slow loop is not a dead one.
const STALE_TICKS = 3

// Reading this must never throw: this band is the only surface that can tell a
// reader the loop died, so a broken heartbeat has to render, not crash the page.
export function readRunnerHeartbeat(repo) {
  let raw
  try {
    raw = readFileSync(join(repo, '.tmux-teams', RUNNER_HEARTBEAT_FILE), 'utf8')
  } catch (error) {
    // Absent and unreadable are different claims about the filesystem. Only an
    // absent file licenses "the runner has never run here".
    if (error?.code === 'ENOENT') return { present: false, value: null, reason: '' }
    return { present: true, value: null, reason: 'the file could not be read' }
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { present: true, value: null, reason: 'the file is not valid JSON' } }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, value: null, reason: 'the file does not hold a JSON object' }
  }
  if (parsed.schema !== HEARTBEAT_SCHEMA) {
    return { present: true, value: null, reason: `the file is not a ${HEARTBEAT_SCHEMA} record` }
  }
  return { present: true, value: parsed, reason: '' }
}

// A zero the runner measured is a fact worth printing; a zero this page invented
// because a field was absent is the exact lie §12.7 forbids. One helper, so the
// two can never be confused.
const measured = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : 'not measured')

// The runner's own words, never this page's. A non-string is no reason at all.
const heartbeatReason = (value) => (typeof value?.reason === 'string' ? value.reason.trim() : '')

// Six states, because the four a reader must act on each have an honest failure
// mode behind them. `state` is the machine-readable one; the copy is what a
// reader acts on.
export function loopHealth(read, now) {
  if (!read.present) {
    return {
      state: 'never', tone: 'warn', mark: '▲', label: 'NO RUNNER',
      headline: 'The loop runner has never run in this repo.',
      detail: `No .tmux-teams/${RUNNER_HEARTBEAT_FILE} exists here. Start the runner, or read the graph below as a declaration with no loop behind it.`,
    }
  }
  const value = read.value
  if (!value) {
    return {
      state: 'unreadable', tone: 'bad', mark: '■', label: 'HEARTBEAT UNREADABLE',
      headline: 'The loop runner heartbeat cannot be read.',
      detail: `.tmux-teams/${RUNNER_HEARTBEAT_FILE} exists but ${read.reason}, so whether the loop is running was not measured.`,
    }
  }

  const cannotJudge = (why) => ({
    state: 'unmeasured', tone: 'warn', mark: '▲', label: 'HEARTBEAT INCOMPLETE',
    headline: 'The loop runner heartbeat does not say enough to judge it.',
    detail: `${why} Nothing below tells you whether the loop is still dispatching.`,
  })

  const at = typeof value.at === 'string' ? Date.parse(value.at) : Number.NaN
  if (!Number.isFinite(at)) return cannotJudge('It carries no usable timestamp, so its age was not measured.')
  const tick = typeof value.tick_sec === 'number' && Number.isFinite(value.tick_sec) && value.tick_sec > 0
    ? value.tick_sec
    : null
  if (tick === null) return cannotJudge('It did not report its tick interval, so how long its silence may safely run was not measured.')
  // A caller's broken clock is this page's fault, not the runner's, and must not
  // be reported as the runner disagreeing about the time.
  if (!Number.isFinite(now)) return cannotJudge('This page could not read its own clock, so the heartbeat age was not measured.')
  const ageSec = (now - at) / 1000
  if (ageSec < 0) return cannotJudge('Its last tick is dated ahead of this page, so the two clocks disagree and its age was not measured.')
  const age = duration(ageSec)
  // Rather than print the word `null` where a clock belongs.
  if (age === null) return cannotJudge('Its age could not be measured against this page\'s own clock.')
  const stated = heartbeatReason(value)

  if (ageSec > STALE_TICKS * tick) {
    // Everything else this record says is as old as the record. A stale
    // `dispatching: false` is not a hold in progress, so it is reported as what
    // the runner last said, never as what it is doing.
    const said = stated ? ` At that last tick it said: "${clip(stated, 160)}".` : ''
    return {
      state: 'stale', tone: 'bad', mark: '■', label: 'NOT RESPONDING',
      headline: 'The loop runner is not responding.',
      detail: `Last tick ${age} ago, past ${STALE_TICKS}× its own ${tick}s interval.${said} Read the board below as the last thing it saw, not as what is happening now.`,
    }
  }

  if (typeof value.dispatching !== 'boolean') {
    return cannotJudge(`Last tick ${age} ago, but it did not say whether it is dispatching.`)
  }

  if (!value.dispatching) {
    return {
      state: 'holding', tone: 'warn', mark: '▲', label: 'HOLDING',
      headline: 'The loop runner is alive and deliberately not dispatching.',
      // Never invent a reason for a hold: an unexplained hold is itself the
      // thing a reader has to chase.
      detail: `Last tick ${age} ago. Reason it gave: ${stated ? `"${clip(stated, 160)}"` : 'none — it is holding without saying why'}.`,
    }
  }

  return {
    state: 'dispatching', tone: 'ok', mark: '●', label: 'DISPATCHING',
    headline: 'The loop runner is dispatching normally.',
    detail: `Last tick ${age} ago · started in that tick: ${measured(value.started)} · held: ${measured(value.held)}.`,
  }
}

// State is carried three ways, as everywhere else on this page: the colour, a
// shape that survives greyscale, and the words themselves.
const loopHealthBand = (health) => `
<div class="loop-health lh-${health.tone}" data-loop-health="${health.state}">
  <span class="lh-mark" aria-hidden="true">${health.mark}</span>
  <span class="lh-state">${esc(health.label)}</span>
  <span class="lh-say">${esc(health.headline)}</span>
  <span class="lh-detail">${esc(health.detail)}</span>
</div>`

// Keyed by agent alone: the pool is drawn once, so an agent's single node shows
// its newest dispatch whichever workflow that dispatch was running.
function evidenceByAgent(snapshot, facts = new Map()) {
  const rows = [...(snapshot.runs || []), ...(snapshot.history?.runs || [])]
  const byAgent = new Map()
  let unrouted = 0
  for (const row of rows) {
    if (!row.agent_id) continue
    if (!(row.workflow || facts.get(row.task_id)?.workflow)) unrouted += 1
    const seen = byAgent.get(row.agent_id)
    if (!seen || String(row.started_at || '') > String(seen.started_at || '')) byAgent.set(row.agent_id, row)
  }
  return { byAgent, unrouted, total: rows.length }
}

function verdictsByAgent(snapshot) {
  const byAgent = new Map()
  for (const row of snapshot.recent_verdicts || []) {
    if (!row.agent_id) continue
    const bucket = byAgent.get(row.agent_id) || { pass: 0, reject: 0, unresolved: 0 }
    if (bucket[row.pm_verdict] !== undefined) bucket[row.pm_verdict] += 1
    byAgent.set(row.agent_id, bucket)
  }
  return byAgent
}

// What each agent has actually DONE, read from the custody ledger the runner
// writes. Pulse can say a process ran; only the ledger says whether that run
// accepted a handoff, produced an artifact, or refused one — which is the
// difference between a node that is merely drawn and a node that means
// something. Counting from the ledger also keeps these numbers true even if the
// separate verdict-to-snapshot chain breaks.
const EMPTY_WORK = Object.freeze({
  accepted: 0, returned: 0, pass: 0, reject: 0, unresolved: 0,
  delivered: 0, failed: 0, escalations: 0,
})

function activityByAgent(items) {
  const byAgent = new Map()
  const bump = (agentId, key) => {
    if (!agentId) return
    const row = byAgent.get(agentId) || { ...EMPTY_WORK }
    row[key] += 1
    byAgent.set(agentId, row)
  }
  for (const item of items.values()) {
    for (const entry of item.custody || []) {
      if (entry.event === 'intake') bump(entry.agent_id, 'accepted')
      // A refusal is recorded without an agent_id on purpose — the token moved
      // back to the sending team — so the dispatcher that refused it is named
      // in its own field.
      else if (entry.event === 'returned') bump(entry.refused_by, 'returned')
      else if (entry.event === 'reviewed') {
        bump(entry.agent_id, ['pass', 'reject'].includes(entry.verdict) ? entry.verdict : 'unresolved')
      } else if (entry.event === 'delivered') bump(entry.agent_id, entry.terminal === 'done' ? 'delivered' : 'failed')
      else if (entry.event === 'lost') bump(entry.agent_id, 'failed')
      else if (entry.event === 'escalated') bump(entry.agent_id, 'escalations')
    }
  }
  return byAgent
}

const workLine = (role, work) => {
  if (!work) return 'nothing recorded yet'
  if (role === 'dispatcher') return `${work.accepted} accepted · ${work.returned} returned`
  if (role === 'evaluator') return `${work.pass} pass · ${work.reject} reject`
  if (role === 'outer') return `${work.escalations} escalation(s) handled`
  return `${work.delivered} delivered · ${work.failed} failed`
}

const statusOf = (run) => !run ? 'unbound'
  : WORKING.has(run.state) ? 'working'
    : DELIVERED.has(run.state) ? 'delivered'
      : DEAD.has(run.state) ? 'dead' : 'other'

const STATUS_COPY = Object.freeze({
  watching: 'watching — no exception open',
  unbound: 'no dispatch observed',
  working: 'working',
  delivered: 'delivered, waiting',
  dead: 'process not found',
  other: 'evidence on record',
})

// Every node states a measured duration or says the clock is not running.
const timingOf = (run, status) => {
  if (!run) return 'not started'
  if (status === 'working') {
    const elapsed = duration(run.elapsed_sec)
    return elapsed ? `${elapsed} in progress` : 'elapsed not measured'
  }
  const idle = duration(run.silence_sec)
  return idle ? `${idle} since last activity` : 'idle time not measured'
}

// Lane and model are two different facts. `worker` is the adapter lane that
// carried the dispatch; the model is only reported once Pulse verified that the
// model asked for is the one that answered. Never substitute one for the other.
const laneLine = (run) => run ? `${run.worker || 'unknown'} · ${run.transport || 'transport ?'}` : '—'

// `unverified` was one word doing two jobs. Pulse reports a model only once it
// has VERIFIED one, and it can only verify a model that the dispatch asked for.
// A loop that never names a model therefore printed the same word as a loop
// whose model check failed — so the page said nothing about the thing it was
// asked to show. Three distinct facts, three distinct sentences.
const modelLine = (run, fact) => {
  if (!run) return '—'
  if (run.model) return run.model
  const asked = fact?.requested_model && fact.requested_model !== 'none' ? fact.requested_model : ''
  if (asked) return `${asked} unconfirmed`
  // Short on purpose: the node clips at 30 characters including the `model `
  // prefix, and a truncated sentence is a sentence a reader has to guess at.
  if (fact?.effective_identity === 'default') return 'default — none pinned'
  return 'not recorded'
}

// The outer controller cannot borrow a worker's status vocabulary. For a worker,
// "no dispatch observed" means it has not done its job yet; for an exception
// handler, having nothing to do is the correct state and good news. Reporting a
// healthy controller exactly like an unwired one is what made this node look
// dead on every screenshot.
const controllerState = (run, items, occupancy) => {
  if (run && WORKING.has(run.state)) return { status: 'working', copy: 'reviewing the board now' }
  const parked = [...items.values()]
    .filter((item) => item.custody?.[item.custody.length - 1]?.event === 'escalated').length
  if (parked) return { status: 'delivered', copy: `${parked} token(s) parked — awaiting a decision` }
  if (occupancy.orphans.length) return { status: 'dead', copy: `${occupancy.orphans.length} token(s) cannot be placed` }
  return { status: 'watching', copy: 'watching — no exception open' }
}

// ── LAYOUT (arithmetic only) ─────────────────────────────────────────────────
const PAD = 28
const NODE_W = 190
const NODE_H = 68   // five lines: id, role · lane, model, work done, clock
const NODE_GAP = 16
const LANE_PAD = 16
const LANE_HEAD = 38
const LANE_GAP = 40
const COL_GAP = 88          // dispatcher | workers | evaluator
const WORKER_GAP = 12       // between parallel workers
const REJECT_DIP = 46       // room under the lane for the rework curve
const PM_SPINE = 22         // oversight spine left of every lane
const ARROW_ROOM = 56       // right-hand gutter: room for the rework line to run back in
const ROW_GAP = 40          // vertical room between the three rows of a team
const STRIP_H = 54
const STRIP_BOX = 168
const STRIP_ARROW = 54
const HEAD_H = 78   // room for the controller's own lane/model line, with padding under it
// The band starts closer to the top bar than the side padding: vertical space
// is the scarce one on this page.
const TOP_PAD = 36

// ── SVG ──────────────────────────────────────────────────────────────────────
// Status is encoded three ways on purpose: the border colour, a dot in the
// corner, and the full sentence in a hover tooltip. Colour alone fails anyone
// printing this in greyscale or reading it colour-blind; the tooltip is where
// the wording stays honest when the box has no room for it.
const agentNode = (x, y, role, agentId, status, statusText, timing, lane, model, work) => `
  <g class="node n-${status}" transform="translate(${x},${y})">
    <title>${esc(`${agentId} — ${statusText}`)}</title>
    <rect width="${NODE_W}" height="${NODE_H}" rx="8"/>
    <circle class="dot" cx="${NODE_W - 13}" cy="13" r="4.5"/>
    <text class="n-title" x="11" y="18">${esc(clip(agentId, 22))}</text>
    <text class="n-meta" x="11" y="32">${esc(clip(`${role} · ${lane}`, 30))}</text>
    <text class="n-meta" x="11" y="43">${esc(clip(`model ${model}`, 30))}</text>
    <text class="n-work" x="11" y="54">${esc(clip(work, 30))}</text>
    <text class="n-time" x="11" y="${NODE_H - 6}">${esc(clip(timing, 30))}</text>
  </g>`

// Colour is the label. `kind` selects the stroke; solid means observed.
// An elbow, not a straight line: fanning out to parallel workers means most of
// these edges change row as well as column.
// A vertical elbow: down, across, down. Used to fan out from the dispatcher to
// parallel workers and back in to the evaluator without touching another node.
const drop = (from, to, kind, solid) => {
  const midY = (from.y + to.y) / 2
  const d = from.x === to.x
    ? `M ${from.x} ${from.y} V ${to.y}`
    : `M ${from.x} ${from.y} V ${midY} H ${to.x} V ${to.y}`
  return `
  <path class="edge k-${kind} ${solid ? "e-solid" : "e-dashed"}" d="${d}" marker-end="url(#a-${kind})"/>`
}

const elbow = (from, to, kind, solid) => {
  const midX = (from.x + to.x) / 2
  const d = from.y === to.y
    ? `M ${from.x} ${from.y} H ${to.x}`
    : `M ${from.x} ${from.y} H ${midX} V ${to.y} H ${to.x}`
  return `
  <path class="edge k-${kind} ${solid ? 'e-solid' : 'e-dashed'}" d="${d}" marker-end="url(#a-${kind})"/>`
}

function renderRouteStrips(graph, topY) {
  const parts = [`  <text class="band-title" x="${PAD}" y="${topY}">Workflows — how work moves between teams</text>`]
  let y = topY + 24
  for (const workflow of graph.workflows) {
    parts.push(`  <text class="strip-name" x="${PAD}" y="${y + STRIP_H / 2 + 5}">${esc(clip(workflow.name, 20))}</text>`)
    const startX = PAD + 170
    workflow.route.forEach((teamId, i) => {
      const team = graph.teams.find((entry) => entry.team_id === teamId)
      const x = startX + i * (STRIP_BOX + STRIP_ARROW)
      parts.push(`
  <g class="strip-box" transform="translate(${x},${y})">
    <rect width="${STRIP_BOX}" height="${STRIP_H}" rx="10"/>
    <text class="sb-name" x="14" y="23">${esc(clip(team.name, 18))}</text>
    <text class="sb-sub" x="14" y="41">${team.worker_ids.length} workers · WIP ${team.wip_limit}</text>
  </g>`)
      if (i > 0) {
        parts.push(`  <path class="edge k-handoff e-solid" d="M ${x - STRIP_ARROW} ${y + STRIP_H / 2} H ${x}" marker-end="url(#a-handoff)"/>`)
      }
    })
    const endX = startX + workflow.route.length * (STRIP_BOX + STRIP_ARROW)
    parts.push(`
  <path class="edge k-handoff e-solid" d="M ${endX - STRIP_ARROW} ${y + STRIP_H / 2} H ${endX}" marker-end="url(#a-handoff)"/>
  <g class="strip-box sink" transform="translate(${endX},${y})">
    <rect width="${STRIP_BOX}" height="${STRIP_H}" rx="26"/>
    <text class="sb-name" x="16" y="23">Project Delivery</text>
    <text class="sb-sub" x="16" y="41">end, not a team</text>
  </g>`)
    y += STRIP_H + 24
  }
  return { svg: parts.join('\n'), nextY: y + 28 }
}

function renderTeamPool(graph, topY, runs, verdicts, occupancy, activity, facts) {
  const parts = []
  const laneAnchors = []
  let x = PAD
  let height = 0
  // Each team is a vertical column — dispatcher on top, its parallel workers
  // side by side under it, evaluator at the bottom — and the columns sit next
  // to each other so the whole structure fits one screen instead of scrolling.
  for (const team of graph.teams) {
    const workers = team.worker_ids
    const wip = occupancy.counts.get(team.team_id) ?? 0
    const holding = occupancy.held.get(team.team_id) ?? []
    const atLimit = wip >= team.wip_limit
    const rowW = workers.length * NODE_W + (workers.length - 1) * WORKER_GAP
    const colW = LANE_PAD * 2 + ARROW_ROOM + Math.max(rowW, NODE_W)
    const top = topY
    const dispatcherY = top + LANE_HEAD
    const workerY = dispatcherY + NODE_H + ROW_GAP
    const evaluatorY = workerY + NODE_H + ROW_GAP
    const colH = LANE_HEAD + NODE_H * 3 + ROW_GAP * 2 + LANE_PAD
    const centreX = x + LANE_PAD + Math.max(rowW, NODE_W) / 2

    parts.push(`
  <g class="lane${atLimit ? " lane-full" : ""}">
    <rect x="${x}" y="${top}" width="${colW}" height="${colH}" rx="16"/>
    <text class="lane-title" x="${x + LANE_PAD}" y="${top + 28}">${esc(team.name)}</text>
    <text class="lane-wip${atLimit ? " wip-full" : ""}" x="${x + colW - LANE_PAD}" y="${top + 28}">${esc(clip(`WIP ${wip}/${team.wip_limit}${atLimit ? " · full" : ""} · ${holding.length ? holding.join(", ") : "no work held"}`, Math.max(14, Math.floor((colW - LANE_PAD * 2 - 34) / 6.4))))}</text>
  </g>`)

    // A verdict is recorded against the leg that was JUDGED, so a team's review
    // history lives on its workers. Reading it off the evaluator's own id leaves
    // every counter at zero however much reviewing actually happened.
    const teamTally = workers.reduce((sum, id) => {
      const seen = verdicts.get(id) || { pass: 0, reject: 0, unresolved: 0 }
      return {
        pass: sum.pass + seen.pass, reject: sum.reject + seen.reject,
        unresolved: sum.unresolved + seen.unresolved,
      }
    }, { pass: 0, reject: 0, unresolved: 0 })

    // The ledger is authoritative about reviewing once it has anything to say;
    // the snapshot tally is the fallback for a repo with no ledger yet. Two
    // sources that can disagree on the same page is the failure this whole page
    // has been fighting, so one of them has to win outright.
    const ledgerReview = activity.get(team.evaluator_id)
    const reviewTally = ledgerReview && (ledgerReview.pass + ledgerReview.reject + ledgerReview.unresolved) > 0
      ? ledgerReview
      : teamTally

    const place = (id, roleLabel, nx, ny) => {
      const run = runs.get(id) || null
      const status = statusOf(run)
      const role = roleLabel.toLowerCase()
      const tally = role.startsWith("evaluator") ? reviewTally : verdicts.get(id) || { pass: 0, reject: 0, unresolved: 0 }
      const stateText = role.startsWith("evaluator")
        ? `${STATUS_COPY[status]} · ${tally.pass} pass ${tally.reject} reject`
        : STATUS_COPY[status]
      parts.push(agentNode(nx, ny, roleLabel, id, status, stateText,
        timingOf(run, status), laneLine(run), modelLine(run, facts.get(run?.task_id)),
        workLine(role, activity.get(id))))
      return run
    }

    place(team.dispatcher_id, "DISPATCHER", centreX - NODE_W / 2, dispatcherY)
    place(team.evaluator_id, "EVALUATOR", centreX - NODE_W / 2, evaluatorY)

    const rowLeft = centreX - rowW / 2
    workers.forEach((workerId, i) => {
      const wx = rowLeft + i * (NODE_W + WORKER_GAP)
      const run = place(workerId, "WORKER", wx, workerY)
      // Fan out down to every worker and back in from every worker. Nothing
      // connects one worker to another: they run in parallel.
      parts.push(drop({ x: centreX, y: dispatcherY + NODE_H }, { x: wx + NODE_W / 2, y: workerY },
        "assign", Boolean(run)))
      parts.push(drop({ x: wx + NODE_W / 2, y: workerY + NODE_H }, { x: centreX, y: evaluatorY },
        "artifact", Boolean(run) && !WORKING.has(run.state)))
    })

    // Rework returns to this team own dispatcher, around the outside.
    const rejected = reviewTally.reject > 0
    const side = x + colW - LANE_PAD / 2
    parts.push(`
  <path class="edge k-reject ${rejected ? "e-solid" : "e-dashed"}"
    d="M ${centreX + NODE_W / 2} ${evaluatorY + NODE_H / 2} H ${side} V ${dispatcherY + NODE_H / 2} H ${centreX + NODE_W / 2}" marker-end="url(#a-reject)"/>`)

    laneAnchors.push({ x, y: top, w: colW })
    height = Math.max(height, colH + 26)
    x += colW + LANE_GAP
  }
  return { svg: parts.join("\n"), height, width: x - LANE_GAP + PAD, laneAnchors }
}
export function renderLoopGraphSvg(graph, snapshot, facts = new Map(), occupancy = { counts: new Map(), held: new Map(), orphans: [] }, items = new Map()) {
  const { byAgent } = evidenceByAgent(snapshot, facts)
  const verdicts = verdictsByAgent(snapshot)
  const activity = activityByAgent(items)
  const controller = graph.outer_controller_id ? byAgent.get(graph.outer_controller_id) : null
  const pm = controllerState(controller, items, occupancy)

  // Teams first: the structure is what the page is for. Routes are a summary
  // of how work travels across it, so they read better after it, not through it.
  const pool = renderTeamPool(graph, TOP_PAD + HEAD_H + 48, byAgent, verdicts, occupancy, activity, facts)
  const routes = renderRouteStrips(graph, TOP_PAD + HEAD_H + 48 + pool.height + 72)
  const stripWidth = PAD + 170 +
    Math.max(...graph.workflows.map((entry) => entry.route.length + 1)) * (STRIP_BOX + STRIP_ARROW) + PAD
  const width = Math.max(pool.width, stripWidth)
  const height = routes.nextY + PAD

  const head = `
  <text class="band-title" x="${PAD}" y="${TOP_PAD - 12}">Teams — every declared agent, drawn once</text>
  <g class="node n-${pm.status}" transform="translate(${PAD},${TOP_PAD})">
    <title>${esc(`${graph.outer_controller_id || 'no outer controller declared'} — ${pm.copy}`)}</title>
    <rect width="${width - PAD * 2}" height="${HEAD_H}" rx="12"/>
    <circle class="dot" cx="${width - PAD * 2 - 15}" cy="15" r="4.5"/>
    <text class="n-role" x="15" y="19">PM OUTER LOOP</text>
    <text class="n-title" x="15" y="36">${esc(graph.outer_controller_id || 'no outer controller declared')}</text>
    <text class="n-sub" x="15" y="52">exceptions, deadlocks and WIP-limit bottlenecks only — never reviews work on a team's behalf</text>
    <text class="n-sub" x="15" y="66">${esc(`OUTER · ${laneLine(controller)} · model ${modelLine(controller, facts.get(controller?.task_id))}`)}</text>
    <text class="n-state" x="${width - PAD * 2 - 26}" y="26" text-anchor="end">${esc(pm.copy)}</text>
    <text class="n-work" x="${width - PAD * 2 - 26}" y="44" text-anchor="end">${esc(workLine('outer', activity.get(graph.outer_controller_id)))}</text>
    <text class="n-time" x="${width - PAD * 2 - 26}" y="62" text-anchor="end">${esc(timingOf(controller, statusOf(controller)))}</text>
  </g>`

  // The outer loop is a real relationship, not decoration: the PM watches every
  // team in every workflow. Drawn as its own colour down the left, dashed
  // because oversight is declared, not something Pulse can observe happening.
  // Leave the PM band on its left edge, drop down outside every lane, then
  // reach in once per team. Going down first would cut straight through them.
  // Teams are columns now, so oversight runs along a rail above them and drops
  // into the top of each one. It is dashed because oversight is declared, not
  // something Pulse can watch happening.
  const anchors = pool.laneAnchors
  const railY = TOP_PAD + HEAD_H + 24
  const oversight = anchors.length ? `
  <path class="edge k-oversight e-dashed" d="M ${width / 2} ${TOP_PAD + HEAD_H} V ${railY}"/>
  <path class="edge k-oversight e-dashed" d="M ${anchors[0].x + anchors[0].w / 2} ${railY} H ${anchors[anchors.length - 1].x + anchors[anchors.length - 1].w / 2}"/>
  ${anchors.map((a) => `<path class="edge k-oversight e-dashed" d="M ${a.x + a.w / 2} ${railY} V ${a.y}" marker-end="url(#a-oversight)"/>`).join("\n  ")}
  <text class="oversight-label" x="${width / 2 + 14}" y="${railY - 9}">PM outer loop watches every team</text>` : ""

  const marker = (id) => `<marker id="a-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="m-${id}" d="M 0 0 L 10 5 L 0 10 z"/></marker>`

  // No width/height attributes: the page scales this to the viewport.
  // The oversight spine and its label sit left of every lane, so the canvas has
  // to start left of zero or the outer loop is clipped off the page.
  const BLEED = 12
  return `<svg viewBox="${-BLEED} 0 ${width + BLEED} ${height}" preserveAspectRatio="xMidYMid meet"
   role="img" aria-labelledby="graph-title graph-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="graph-title">Loop graph</title>
  <desc id="graph-desc">A horizontal strip per workflow shows how work moves between teams. Below it every declared team is drawn once with all of its agents: the dispatcher that owns the queue, its workers and its own evaluator. Each node is one agent and states its status, elapsed time, adapter lane and verified model. Arrow colour carries the meaning — assignment, artifact handover, rejection and handoff. Solid arrows have recorded evidence behind them; dashed arrows are the operating model with nothing measured yet.</desc>
  <defs>${marker('assign')}${marker('artifact')}${marker('reject')}${marker('handoff')}${marker('oversight')}</defs>
  ${head}
  ${pool.svg}
  ${routes.svg}
  ${oversight}
</svg>`
}

const STYLE = `
:root{color-scheme:light dark;
--bg:oklch(97% .008 165);--surface:oklch(99% .004 165);--surface-2:oklch(95% .012 165);
--line:oklch(87% .014 165);--ink:oklch(24% .018 165);--dim:oklch(50% .022 165);
--ok:oklch(50% .12 165);--warn:oklch(53% .13 72);--bad:oklch(52% .16 28);--focus:oklch(52% .13 235);
--assign:oklch(52% .13 235);--artifact:oklch(50% .12 165);--reject:oklch(52% .16 28);--handoff:oklch(48% .14 300);--oversight:oklch(55% .04 270);
--sans:"Kanit","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--r:14px}
@media (prefers-color-scheme:dark){:root{
--bg:oklch(17% .012 165);--surface:oklch(21% .014 165);--surface-2:oklch(24% .015 165);
--line:oklch(34% .014 165);--ink:oklch(93% .012 165);--dim:oklch(71% .018 165);
--ok:oklch(74% .13 165);--warn:oklch(78% .13 78);--bad:oklch(72% .16 28);--focus:oklch(78% .12 235);
--assign:oklch(78% .12 235);--artifact:oklch(74% .13 165);--reject:oklch(72% .16 28);--handoff:oklch(74% .14 300);--oversight:oklch(72% .04 270)}}
:root[data-theme=dark]{
--bg:oklch(17% .012 165);--surface:oklch(21% .014 165);--surface-2:oklch(24% .015 165);
--line:oklch(34% .014 165);--ink:oklch(93% .012 165);--dim:oklch(71% .018 165);
--ok:oklch(74% .13 165);--warn:oklch(78% .13 78);--bad:oklch(72% .16 28);--focus:oklch(78% .12 235);
--assign:oklch(78% .12 235);--artifact:oklch(74% .13 165);--reject:oklch(72% .16 28);--handoff:oklch(74% .14 300);--oversight:oklch(72% .04 270)}
:root[data-theme=light]{
--bg:oklch(97% .008 165);--surface:oklch(99% .004 165);--surface-2:oklch(95% .012 165);
--line:oklch(87% .014 165);--ink:oklch(24% .018 165);--dim:oklch(50% .022 165);
--ok:oklch(50% .12 165);--warn:oklch(53% .13 72);--bad:oklch(52% .16 28);--focus:oklch(52% .13 235);
--assign:oklch(52% .13 235);--artifact:oklch(50% .12 165);--reject:oklch(52% .16 28);--handoff:oklch(48% .14 300);--oversight:oklch(55% .04 270)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.6 var(--sans)}
.topbar{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;
 gap:var(--s3);padding:var(--s3) var(--s5);border-bottom:1px solid var(--line);background:var(--surface)}
.topbar h1{margin:0;font:600 1.1rem/1.3 var(--sans)}
.topbar h1 .repo{color:var(--dim);font-weight:400}
.meta{margin:0;color:var(--dim);font-size:.8rem}
.meta code{font-family:var(--mono);font-size:.76rem}
.refresh{display:flex;align-items:center;gap:var(--s3);margin:0;color:var(--dim);font-size:.78rem}
.refresh .pause{padding:2px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);
 color:var(--ink);font:500 .74rem var(--sans);cursor:pointer}
.refresh .pause:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.refresh .note{font-size:.72rem}
.orphans{margin:0;padding:var(--s3) var(--s5);background:var(--surface-2);
 border-bottom:1px solid var(--bad);color:var(--bad);font-size:.8rem}
.chart{padding:var(--s4) var(--s2);overflow-x:auto;background:var(--bg)}
.chart svg{display:block;width:100%;height:auto;min-width:1080px}
.chart{scrollbar-width:thin}
.below{display:grid;gap:var(--s4);max-width:1280px;margin:0 auto;padding:var(--s5)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s3)}
.tile{display:grid;gap:2px;padding:var(--s4);background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.tile-v{font:600 1.5rem/1 var(--sans);font-variant-numeric:tabular-nums}
.tile-l{color:var(--dim);font-size:.8rem}
.t-ok .tile-v{color:var(--ok)}.t-warn .tile-v{color:var(--warn)}.t-bad .tile-v{color:var(--bad)}
.band-title{fill:var(--ink);font:600 .98rem var(--sans)}
.strip-name{fill:var(--dim);font:500 .84rem var(--sans)}
.strip-box rect{fill:var(--surface);stroke:var(--line);stroke-width:1.5}
.strip-box.sink rect{fill:var(--surface-2)}
.sb-name{fill:var(--ink);font:600 .84rem var(--sans)}
.sb-sub{fill:var(--dim);font:400 .68rem var(--mono)}
.lane rect{fill:var(--surface-2);stroke:var(--line)}
.lane-full rect{stroke:var(--warn);stroke-dasharray:6 4}
.lane-title{fill:var(--ink);font:600 .9rem var(--sans)}
.lane-wip{fill:var(--dim);font:500 .74rem var(--mono);text-anchor:end}
.lane-holding{fill:var(--dim);font:400 .64rem var(--mono);opacity:.85}
.wip-full{fill:var(--warn)}
.node rect{fill:var(--surface);stroke:var(--line);stroke-width:1.5}
.node .n-role{fill:var(--dim);font:500 .6rem var(--sans);letter-spacing:.1em}
.node .n-meta{fill:var(--dim);font:400 .6rem var(--mono)}
.node .dot{stroke:none;fill:var(--dim)}
.n-working .dot{fill:var(--ok)}.n-delivered .dot{fill:var(--warn)}.n-dead .dot{fill:var(--bad)}
.n-watching .dot{fill:var(--accent-oversight,#8a7fd0)}
.n-watching rect{stroke:var(--accent-oversight,#8a7fd0);stroke-width:2;stroke-dasharray:none;opacity:1}
.n-watching .n-state{fill:var(--accent-oversight,#8a7fd0)}
.node{cursor:default}
.node .n-title{fill:var(--ink);font:600 .72rem var(--mono)}
.node .n-state{fill:var(--ink);font:500 .7rem var(--sans)}
.node .n-work{fill:var(--ink);font:500 .6rem var(--mono);font-variant-numeric:tabular-nums}
.node .n-state{font:600 .64rem var(--mono);letter-spacing:.02em}
.node .n-time{fill:var(--dim);font:400 .58rem var(--mono);font-variant-numeric:tabular-nums}
.node .n-sub{fill:var(--dim);font:400 .64rem var(--mono)}
.n-working rect{stroke:var(--ok);stroke-width:2.5}
.n-working .n-state{fill:var(--ok)}
.n-delivered rect{stroke:var(--warn);stroke-width:2.5}
.n-delivered .n-state{fill:var(--warn)}
.n-dead rect{stroke:var(--bad);stroke-width:2.5}
.n-dead .n-state{fill:var(--bad)}
.n-unbound rect{stroke-dasharray:5 4;opacity:.72}
.n-unbound .n-state{fill:var(--dim)}
.edge{fill:none;stroke-width:2.2}
.e-dashed{stroke-dasharray:5 5;opacity:.5}
.k-assign{stroke:var(--assign)}.m-assign{fill:var(--assign)}
.k-artifact{stroke:var(--artifact)}.m-artifact{fill:var(--artifact)}
.k-reject{stroke:var(--reject)}.m-reject{fill:var(--reject)}
.k-handoff{stroke:var(--handoff)}.m-handoff{fill:var(--handoff)}
.k-oversight{stroke:var(--oversight);stroke-width:1.8}.m-oversight{fill:var(--oversight)}
.oversight-label{fill:var(--oversight);font:500 .66rem var(--sans)}
.legend{display:grid;gap:8px;margin:0;padding:var(--s4);background:var(--surface-2);
 border:1px solid var(--line);border-radius:var(--r);font-size:.86rem}
.legend b{font-weight:600}
.keys{display:flex;flex-wrap:wrap;gap:var(--s4);list-style:none;margin:0;padding:0}
.keys li{display:flex;align-items:center;gap:8px}
.swatch{width:26px;height:3px;border-radius:2px;flex:none}
.sw-assign{background:var(--assign)}.sw-artifact{background:var(--artifact)}
.sw-reject{background:var(--reject)}.sw-handoff{background:var(--handoff)}
.sw-oversight{background:var(--oversight)}
.warnbox{padding:var(--s4);border:1px solid var(--bad);border-radius:var(--r);font-size:.9rem}
footer{color:var(--dim);font-size:.78rem}
.loop-health{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s2) var(--s3);
 margin:0;padding:var(--s3) var(--s5);background:var(--surface-2);
 border-bottom:1px solid var(--line);font-size:.82rem}
.loop-health .lh-mark{font-size:.66rem;line-height:1}
.loop-health .lh-state{font:600 .7rem var(--mono);letter-spacing:.08em}
.loop-health .lh-say{font-weight:600}
.loop-health .lh-detail{color:var(--dim)}
.lh-ok{border-bottom-color:var(--ok)}.lh-ok .lh-mark,.lh-ok .lh-state{color:var(--ok)}
.lh-warn{border-bottom-color:var(--warn)}.lh-warn .lh-mark,.lh-warn .lh-state{color:var(--warn)}
.lh-bad{border-bottom-color:var(--bad)}.lh-bad .lh-mark,.lh-bad .lh-state{color:var(--bad)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

export function renderGraphPage(repo, snapshot, { fontCssName = FONT_CSS_NAME, refreshScriptName = '', now = Date.now() } = {}) {
  const graph = readWorkflowGraph(repo)
  const repoName = snapshot.scope?.repo_name || ''
  // Without an explicit charset a plain file server hands this to the browser
  // as windows-1252 and every non-ASCII label turns to mojibake.
  const head = `<meta charset="utf-8">
<title>Loop graph · ${esc(repoName)}</title>
<meta name="tmux-teams-snapshot-id" content="${esc(snapshot.snapshot_id || '')}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${esc(fontCssName)}">
<style>${STYLE}</style>${refreshScriptName ? `\n<script src="${esc(refreshScriptName)}" defer></script>` : ''}`

  if (!graph.ok) {
    return `${head}
<div class="below"><h1>Team graph could not be read</h1>
<p class="warnbox"><code>.tmux-teams/${WORKFLOW_GRAPH_FILE}</code> failed the contract: ${esc(graph.reason)}</p>
<p class="meta">Fix the file and regenerate Pulse, or delete it to fall back to the bundled four-team template.</p></div>`
  }

  const value = graph.value
  const facts = readDispatchFacts(repo)
  const { items, skippedLines } = readWorkItems(repo)
  const occupancy = teamOccupancy(value, items)
  const { byAgent, unrouted } = evidenceByAgent(snapshot, facts)
  const declared = value.teams.flatMap((entry) => entry.agents.map((agent) => agent.agent_id))
  const bound = declared.filter((agentId) => byAgent.has(agentId))
  const working = bound.filter((agentId) => WORKING.has(byAgent.get(agentId).state)).length
  // `awaiting-verdict` is a Pulse state meaning "no verdict recorded in KMS".
  // This loop records verdicts in the custody ledger, so every finished leg sat
  // in that state forever and the tile reported ten things waiting for review
  // when the ledger showed all ten reviewed. Count the real thing: tokens whose
  // last event is a delivery nobody has judged yet.
  const waiting = [...items.values()]
    .filter((item) => item.custody[item.custody.length - 1]?.event === 'delivered').length
  const atLimit = value.teams.filter((entry) => (occupancy.counts.get(entry.team_id) ?? 0) >= entry.wip_limit).length
  const inFlight = [...occupancy.counts.values()].reduce((sum, n) => sum + n, 0)
  const unroutedDeclared = bound.filter((agentId) => {
    const run = byAgent.get(agentId)
    return !(run.workflow || facts.get(run.task_id)?.workflow)
  }).length

  const at = new Date(snapshot.generated_at)
  const observed = Number.isNaN(at.getTime()) ? '—' : `${at.toISOString().replace('T', ' ').slice(0, 19)} UTC`
  const tile = (v, l, tone = '') =>
    `<div class="tile${tone ? ` t-${tone}` : ''}"><span class="tile-v">${esc(v)}</span><span class="tile-l">${esc(l)}</span></div>`

  return `${head}
<header class="topbar" data-observation-expires-at="${esc(snapshot.observation?.expires_at || '')}" data-refresh-interval="${Number(snapshot.observation?.refresh_interval_sec) || 20}">
  <h1>Loop graph <span class="repo">${esc(repoName)}</span></h1>
  <p class="meta">graph: <code>${graph.source === 'default' ? 'bundled four-team template' : `.tmux-teams/${WORKFLOW_GRAPH_FILE}`}</code>
   · ${value.teams.length} teams · ${value.workflows.length} workflows
   · evidence: <code>pulse.json</code> ${esc(snapshot.snapshot_id || '—')} · observed ${esc(observed)}</p>
  <p class="refresh"><span data-refresh-status role="status" aria-live="polite">Snapshot fresh</span>
   <button type="button" class="pause" data-refresh-toggle data-refresh-focus-key="refresh-toggle" aria-pressed="false">Pause updates</button>
   <span class="note" data-refresh-note>Polling the local snapshot marker</span></p>
</header>
${loopHealthBand(loopHealth(readRunnerHeartbeat(repo), now))}
${occupancy.orphans.length || skippedLines ? `<p class="orphans">${occupancy.orphans.length ? `${occupancy.orphans.length} work item(s) cannot be placed — agent or workflow not in this graph: ${esc(occupancy.orphans.map((o) => o.work_item).join(", "))}. ` : ""}${skippedLines ? `${skippedLines} unreadable ledger line(s) skipped.` : ""}</p>` : ""}
<div class="chart">${renderLoopGraphSvg(value, snapshot, facts, occupancy, items)}</div>
<div class="below">
<section class="tiles">
  ${tile(inFlight, 'work items in a team right now', inFlight ? 'ok' : '')}
  ${tile(`${bound.length}/${declared.length}`, 'declared agents with a dispatch', bound.length ? 'ok' : 'bad')}
  ${tile(working, 'working now', 'ok')}
  ${tile(waiting, 'delivered, awaiting review', waiting ? 'warn' : '')}
  ${tile(`${atLimit}/${value.teams.length}`, 'teams at their WIP limit', atLimit ? 'warn' : '')}
  ${tile(unroutedDeclared, 'declared agents whose newest dispatch names no workflow', unroutedDeclared ? 'bad' : '')}
</section>
<div class="legend"><b>Arrow colour is the label</b>
<ul class="keys">
  <li><span class="swatch sw-assign"></span>assign — dispatcher gives work to a worker</li>
  <li><span class="swatch sw-artifact"></span>artifact + evidence — worker hands to the evaluator</li>
  <li><span class="swatch sw-reject"></span>rejected — back into this team's own queue</li>
  <li><span class="swatch sw-handoff"></span>handoff — between teams, along a workflow route</li>
  <li><span class="swatch sw-oversight"></span>PM outer loop — watches every team in every workflow</li>
</ul>
 <span>Solid = a record exists for it · dashed = the operating model, nothing measured yet.</span>
 <span>Node border: green working · amber delivered and waiting · red process not found · dashed declared but never dispatched.</span>
 <span>Every node is one agent, drawn once no matter how many workflows use its team, and states its status, time in state, adapter <b>lane</b> and separately its <b>model</b>. <code>unverified</code> means the dispatch never declared which model it asked for.</span>
 <span>Where a given piece of work is right now is the kanban board's question, not this page's.</span></div>
<footer>Teams, roles, routes and WIP limits come from the declared graph; status, timing, lane and model come from observed evidence. No role is inferred from a name.</footer>
</div>`
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `init` drops the four-team template so a repo has something to edit; `check`
// is the gate the setup skill runs before anyone dispatches against a graph.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, repoArg] = process.argv.slice(2)
  const repo = repoArg || '.'
  const target = join(repo, '.tmux-teams', WORKFLOW_GRAPH_FILE)

  if (command === 'init') {
    if (existsSync(target)) {
      console.error(`[graph] ${target} already exists — edit it or delete it first`)
      process.exit(2)
    }
    writeFileSync(target, `${JSON.stringify(DEFAULT_WORKFLOW_GRAPH, null, 2)}\n`)
    console.log(`[graph] wrote the four-team template -> ${target}`)
    console.log('[graph] rename the teams and agent ids, then run: graph.mjs check <repo>')
  } else if (command === 'check') {
    const graph = readWorkflowGraph(repo)
    if (!graph.ok) {
      console.error(`[graph] invalid (${graph.source}): ${graph.reason}`)
      process.exit(1)
    }
    console.log(`[graph] ok (${graph.source}) — ${graph.value.teams.length} teams, ${graph.value.workflows.length} workflows`)
    for (const workflow of graph.value.workflows) {
      console.log(`[graph]   ${workflow.workflow_id}: ${workflow.route.join(' → ')}`)
    }
    console.log('[graph] dispatch with ACP_AGENT_ID=<agent>, TMUX_TEAMS_WORKFLOW=<workflow_id>, TMUX_TEAMS_WORK_ITEM=<token>')
  } else {
    console.error('usage: node graph.mjs <init|check> [repo]')
    process.exit(2)
  }
}
