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
import { TOUR_CSS, TOUR_SCRIPT, buildTour, renderTourChart } from './graph-tour.mjs'
import { NAV_CSS, renderNav } from './page-nav.mjs'
import {
  DEFAULT_WORKFLOW_GRAPH, LEGACY_WORKFLOW_GRAPH_FILE, WORKFLOW_GRAPH_FILE, validateWorkflowGraph,
} from './workflow-graph.mjs'

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
  // Tried in order, and the order matters more than it looks. A repo that
  // declared its teams before the 2026-07-29 rename still holds them under the
  // old name; without this second attempt it would fall through to the bundled
  // default and draw four teams nobody declared — a page that looks completely
  // normal while answering about somebody else's project. That failure raises
  // no error to notice, which is why it is handled here instead of left to
  // whoever eventually wonders why the team names are wrong.
  for (const name of [WORKFLOW_GRAPH_FILE, LEGACY_WORKFLOW_GRAPH_FILE]) {
    let text
    try {
      text = readFileSync(join(repo, '.tmux-teams', name), 'utf8')
    } catch {
      // Absent. This is the ONLY condition the bundled default is for (§3).
      continue
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (cause) {
      // Present and unreadable is not the same fact as absent, and §3 says an
      // invalid graph fails closed. A single `catch` used to cover the read and
      // the parse together, so a corrupt declaration fell through to the
      // bundled template and the page rendered somebody else's project while
      // `graph.mjs check` exited 0 — the same silent substitution the legacy
      // read exists to prevent, one line above it.
      return { ok: false, value: null, reason: `${name} is not valid JSON: ${cause.message}`, source: name }
    }
    // `source` carries the name that actually answered, so a reader can see the
    // page is running off the legacy file rather than assume otherwise.
    return { ...validateWorkflowGraph(raw), source: name }
  }
  return { ...validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH), source: 'default' }
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
  // The controller's own two outputs. Without them its node counted
  // `escalations`, which the runner stamps with the agent BEING escalated
  // rather than the controller reading it — so the seat that audits every
  // finished route read `0 escalation(s) handled` however much it had done.
  // Counting the request as though it were the answer is the exact untruth
  // this graph exists to make impossible.
  audits: 0, resumes: 0,
  // The grill asking. It is the intake gate's other outcome — `accepted` is one
  // answer to the same question — so a seat that spends its day sending
  // requests back for detail would otherwise read as a seat that did nothing.
  asked: 0,
})

// Exported for the same reason as `stateOf` in kanban.mjs: whether an event
// credits the agent that performed it is a fact about this function, not about
// the page. Asserting it through rendered markup made a behaviour test read as
// a presentation test and bound it to wording that is free to change.
export function activityByAgent(items) {
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
      // The controller acting, not being asked to act. `audited` and `resumed`
      // are the only two events it writes itself, and both name it in
      // `agent_id`, so this is where its node stops reading empty forever.
      else if (entry.event === 'audited') bump(entry.agent_id, 'audits')
      else if (entry.event === 'resumed') bump(entry.agent_id, 'resumes')
      else if (entry.event === 'questioned') bump(entry.agent_id, 'asked')
    }
  }
  return byAgent
}

const workLine = (role, work) => {
  if (!work) return 'nothing recorded yet'
  if (role === 'dispatcher') return `${work.accepted} accepted · ${work.returned} returned`
  if (role === 'evaluator') return `${work.pass} pass · ${work.reject} reject`
  // What it did, not what was asked of it. The old line said "handled" over a
  // counter of requests, and read 0 forever besides.
  if (role === 'outer') return `${work.audits} audited · ${work.resumes} resumed`
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

// Is the front door open, and if not, who has to act?
//
// The controller holds one seat (WIP 1), so a single request waiting on a person
// stops EVERY new request entering the system. Master, 2026-07-31: *"ตรงจุดนั้นก็
// กลายเป็นติดบล็อก ... ทำให้ flow เดินต่อไม่ได้ทั้งระบบ ซึ่งมันควรจะเป็นแบบนั้น"* — that block is
// the design working, not a fault. It is only a fault when it is INVISIBLE: a
// board that shows a calm graph while nothing can enter is the same silence
// this project has spent a week removing.
//
// Exported for the same reason as `stateOf` and `activityByAgent`: whether the
// door is blocked is a fact about the evidence, not about the markup.
export function frontDoorStatus(graph, items, occupancy) {
  const controlId = graph.controller_team
  if (!controlId) {
    return { blocked: false, kind: 'none', copy: 'work enters at a delivery team — no controller gate' }
  }
  const team = graph.teams.find((entry) => entry.team_id === controlId)
  const held = occupancy?.held?.get(controlId) || []
  const waiting = held
    .map((workItem) => items.get(workItem))
    .filter(Boolean)
    .map((item) => item.custody[item.custody.length - 1])
    .find((last) => last?.event === 'questioned')

  if (waiting) {
    return {
      blocked: true,
      kind: 'person',
      work_item: waiting.work_item,
      since: waiting.at || null,
      questions: waiting.questions || '',
      // Says who must act. "Blocked" alone sends a reader looking at the loop,
      // and the loop is not what is holding this.
      copy: `blocked — waiting on a person to answer ${waiting.work_item}`,
    }
  }
  if (held.length >= team.wip_limit) {
    return {
      blocked: true, kind: 'busy', work_item: held[0] || null, since: null, questions: '',
      copy: `blocked — the gate is working on ${held[0]}, no new request can enter`,
    }
  }
  return { blocked: false, kind: 'open', copy: `open — ${held.length}/${team.wip_limit} at the gate` }
}

// The outer controller cannot borrow a worker's status vocabulary. For a worker,
// "no dispatch observed" means it has not done its job yet; for an exception
// handler, having nothing to do is the correct state and good news. Reporting a
// healthy controller exactly like an unwired one is what made this node look
// dead on every screenshot.
const controllerState = (run, items, occupancy, graph = null) => {
  // Before anything else: if nothing can enter the system, that is the single
  // most important thing this node can say, running or not.
  const door = graph ? frontDoorStatus(graph, items, occupancy) : { blocked: false }
  if (door.blocked && door.kind === 'person') return { status: 'dead', copy: door.copy }
  if (run && WORKING.has(run.state)) return { status: 'working', copy: 'reviewing the board now' }
  const parked = [...items.values()]
    .filter((item) => item.custody?.[item.custody.length - 1]?.event === 'escalated').length
  if (parked) return { status: 'delivered', copy: `${parked} token(s) parked — awaiting a decision` }
  if (occupancy.orphans.length) return { status: 'dead', copy: `${occupancy.orphans.length} token(s) cannot be placed` }
  return { status: 'watching', copy: 'watching — no exception open' }
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
${NAV_CSS}
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
.below{display:grid;gap:var(--s4);max-width:1280px;margin:0 auto;padding:var(--s5)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s3)}
.tile{display:grid;gap:2px;padding:var(--s4);background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.tile-v{font:600 1.5rem/1 var(--sans);font-variant-numeric:tabular-nums}
.tile-l{color:var(--dim);font-size:.8rem}
.t-ok .tile-v{color:var(--ok)}.t-warn .tile-v{color:var(--warn)}.t-bad .tile-v{color:var(--bad)}
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
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
 clip-path:inset(50%);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
${TOUR_CSS}`

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
<p class="meta">Fix the file and regenerate Pulse, or delete it to fall back to the bundled controller-led template.</p></div>`
  }

  const value = graph.value
  const facts = readDispatchFacts(repo)
  const { items, skippedLines } = readWorkItems(repo)
  const occupancy = teamOccupancy(value, items)
  const { byAgent, unrouted } = evidenceByAgent(snapshot, facts)
  const verdicts = verdictsByAgent(snapshot)
  const activity = activityByAgent(items)

  // One card per declared seat, derived here where the evidence lives. The tour
  // module places these and nothing else: it cannot invent a status, a model or
  // a time, which is what keeps the picture unable to say more than the ledger.
  const cards = new Map()
  const teamFacts = new Map()
  for (const team of value.teams) {
    // A verdict is recorded against the leg that was JUDGED, so a team's review
    // history lives on its workers, not on the evaluator's own id.
    const teamTally = team.worker_ids.reduce((sum, id) => {
      const seen = verdicts.get(id) || { pass: 0, reject: 0, unresolved: 0 }
      return {
        pass: sum.pass + seen.pass, reject: sum.reject + seen.reject,
        unresolved: sum.unresolved + seen.unresolved,
      }
    }, { pass: 0, reject: 0, unresolved: 0 })
    const ledgerReview = activity.get(team.evaluator_id)
    const reviewTally = ledgerReview && (ledgerReview.pass + ledgerReview.reject + ledgerReview.unresolved) > 0
      ? ledgerReview
      : teamTally
    // Rework is a team-level fact: the edge back into the queue hardens once
    // ANY of this team's legs was rejected, not once a particular worker was.
    // Stuck: a token this team holds whose last recorded event stopped it. An
    // escalation is waiting on the controller; a question is waiting on a
    // person. Both mean the same thing for the board — this team cannot move
    // that work on its own — and neither is the same as being busy.
    const held = occupancy.held.get(team.team_id) || []
    const stuck = held.some((workItem) => {
      const last = items.get(workItem)?.custody?.at(-1)
      return last?.event === 'escalated' || last?.event === 'questioned'
    })
    // Where the work this team is holding came FROM. `pulled` records its own
    // origin, so the board can show the leg that actually delivered the token
    // rather than guessing from the route: a team may sit on several routes,
    // and only the ledger knows which one this token travelled.
    const cameFrom = [...new Set(held.map((workItem) => {
      const custody = items.get(workItem)?.custody || []
      for (let i = custody.length - 1; i >= 0; i -= 1) {
        if (custody[i].event === 'pulled') return custody[i].from_team || null
      }
      return null
    }).filter(Boolean))]
    teamFacts.set(team.team_id, { rejected: reviewTally.reject > 0, stuck, cameFrom })

    for (const agent of team.agents) {
      const run = byAgent.get(agent.agent_id) || null
      const isController = agent.agent_id === value.outer_controller_id
      // The controller cannot borrow a worker's vocabulary: for a worker "no
      // dispatch observed" means it has not done its job, while for an
      // exception handler having nothing to do is the correct state.
      const controller = isController ? controllerState(run, items, occupancy, value) : null
      const status = controller ? controller.status : statusOf(run)
      const state = controller
        ? controller.copy
        : (agent.role === 'evaluator'
          ? `${STATUS_COPY[status]} · ${reviewTally.pass} pass ${reviewTally.reject} reject`
          : STATUS_COPY[status])
      cards.set(agent.agent_id, {
        status,
        state,
        // What hardens the edges out of this seat. `dispatched` says something
        // was actually assigned here; `settled` says that dispatch has stopped
        // running, which is the only point at which a handover to the evaluator
        // can have happened.
        dispatched: Boolean(run),
        settled: Boolean(run) && !WORKING.has(run.state),
        role: isController ? "outer controller, holding this team's one worker seat" : agent.role,
        lines: [
          `${agent.role} · ${laneLine(run)}`,
          `model ${modelLine(run, facts.get(run?.task_id))}`,
          workLine(isController ? 'outer' : agent.role, activity.get(agent.agent_id)),
          timingOf(run, statusOf(run)),
        ],
      })
    }
  }
  // What actually landed. `audited` is the only event that means the controller
  // read the finished delivery and accepted it: `completed` is half closed and
  // `abandoned` is work that left rather than work that arrived.
  const delivered = [...items.values()]
    .filter((item) => item.custody[item.custody.length - 1]?.event === 'audited').length
  const tour = buildTour(value, cards, occupancy, teamFacts, { delivered })
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
${renderNav('graph')}
<header class="topbar" data-observation-expires-at="${esc(snapshot.observation?.expires_at || '')}" data-refresh-interval="${Number(snapshot.observation?.refresh_interval_sec) || 20}">
  <h1>Loop graph <span class="repo">${esc(repoName)}</span></h1>
  <p class="meta">graph: <code>${graph.source === 'default' ? 'bundled template' : `.tmux-teams/${WORKFLOW_GRAPH_FILE}`}</code>
   · ${value.teams.length} teams · ${value.workflows.length} workflows
   · evidence: <code>pulse.json</code> ${esc(snapshot.snapshot_id || '—')} · observed ${esc(observed)}</p>
  <p class="refresh"><span data-refresh-status role="status" aria-live="polite">Snapshot fresh</span>
   <button type="button" class="pause" data-refresh-toggle data-refresh-focus-key="refresh-toggle" aria-pressed="false">Pause updates</button>
   <span class="note" data-refresh-note>Polling the local snapshot marker</span></p>
</header>
${loopHealthBand(loopHealth(readRunnerHeartbeat(repo), now))}
${value.outer_controller_id && !value.controller_team ? `<p class="orphans">The controller <code>${esc(value.outer_controller_id)}</code> holds no team seat, so it is not on the board. This graph predates the front door: give it a team whose one worker is that seat, and start every route there. Until then nothing enforces a way in, and no WIP limit covers requests waiting to be admitted.</p>` : ""}
${occupancy.orphans.length || skippedLines ? `<p class="orphans">${occupancy.orphans.length ? `${occupancy.orphans.length} work item(s) cannot be placed — agent or workflow not in this graph: ${esc(occupancy.orphans.map((o) => o.work_item).join(", "))}. ` : ""}${skippedLines ? `${skippedLines} unreadable ledger line(s) skipped.` : ""}</p>` : ""}
${renderTourChart(tour)}
<p class="sr-only" id="tour-desc">The board is shown one scene at a time. The first scene has every declared
 team drawn once — a team is a dispatcher that owns the queue, its workers side by side, and the team's own
 evaluator. Each following scene is one workflow: the teams that route does not use fade out, and the teams
 it does use keep the positions they had. Every node is one agent and states its status, its adapter lane,
 its verified model, what it has done and how long it has been in that state. Use the previous and next
 buttons, the scene dots, or the left and right arrow keys while the board has focus.</p>
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
</div>
<script>${TOUR_SCRIPT}</script>`
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `init` drops the bundled template so a repo has something to edit; `check`
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
    console.log(`[graph] wrote the bundled template -> ${target}`)
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
