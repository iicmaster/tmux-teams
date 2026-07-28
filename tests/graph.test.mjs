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
  DEFAULT_WORKFLOW_GRAPH, readWorkflowGraph, renderGraphPage, renderLoopGraphSvg,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'

const repoWith = (graph) => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  mkdirSync(join(dir, '.tmux-teams'), { recursive: true })
  if (graph !== undefined) writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(graph))
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
  assert.match(page, /failed the contract/)
  assert.doesNotMatch(page, /<svg/)
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

// ── the drawing ──────────────────────────────────────────────────────────────

test('a team shared by two workflows is still drawn once, with every agent', () => {
  const graph = graphOf(TWO_TEAMS)
  const svg = renderLoopGraphSvg(graph, snapshotWith())
  const declared = graph.teams.flatMap((entry) => entry.agents.map((agent) => agent.agent_id))
  assert.equal(declared.length, 7)
  for (const agentId of declared) {
    assert.equal((svg.match(new RegExp(`>${agentId}<`, 'g')) || []).length, 1, `${agentId} drawn once`)
  }
})

test('a node states status, lane and model separately, and never fakes a model', () => {
  const graph = graphOf(TWO_TEAMS)
  const svg = renderLoopGraphSvg(graph, snapshotWith([
    run('b_w1', 'running', { worker: 'codex', transport: 'tmux' }),
    run('b_w2', 'running', { model: 'gpt-5.6-luna' }),
  ]))
  assert.match(svg, /WORKER · codex · tmux/)
  // The lane is not a model, and a run nobody pinned a model for is not the same
  // as one whose model check failed. Both used to print `unverified`, which told
  // a reader nothing about the thing they were looking for.
  assert.match(svg, /model not recorded/)
  assert.match(svg, /model gpt-5\.6-luna/)
  assert.doesNotMatch(svg, /model codex/)
  assert.doesNotMatch(svg, /model unverified/)
})

test('status is readable without colour: a dot plus a text tooltip', () => {
  const svg = renderLoopGraphSvg(graphOf(TWO_TEAMS), snapshotWith([run('b_w1', 'running')]))
  assert.match(svg, /class="node n-working"/)
  assert.match(svg, /<circle class="dot"/)
  assert.match(svg, /<title>b_w1 — working<\/title>/)
})

test('arrows carry meaning by colour, with no text on any edge', () => {
  const svg = renderLoopGraphSvg(graphOf(TWO_TEAMS), snapshotWith())
  for (const kind of ['k-assign', 'k-artifact', 'k-reject', 'k-oversight']) {
    assert.match(svg, new RegExp(kind), `${kind} edge present`)
  }
  assert.doesNotMatch(svg, /class="e-label"/)
})

test('the PM outer loop rail spans every team, including the first', () => {
  const graph = graphOf(TWO_TEAMS)
  const svg = renderLoopGraphSvg(graph, snapshotWith())
  const rail = svg.match(/class="edge k-oversight e-dashed" d="M (\d+(?:\.\d+)?) \d+ H (\d+(?:\.\d+)?)"/)
  assert.ok(rail, 'horizontal oversight rail present')
  const drops = [...svg.matchAll(/class="edge k-oversight e-dashed" d="M (\d+(?:\.\d+)?) \d+ V/g)]
    .map(([, at]) => Number(at))
  assert.equal(drops.length, graph.teams.length + 1, 'one drop per team, plus the stem from the PM band')
  const [, from, to] = rail.map(Number)
  for (const at of drops.slice(1)) {
    assert.ok(at >= from - 1 && at <= to + 1, `${at} sits on the rail`)
  }
})

test('an edge only hardens once evidence exists for it', () => {
  const graph = graphOf(TWO_TEAMS)
  const dry = renderLoopGraphSvg(graph, snapshotWith())
  assert.doesNotMatch(dry, /class="edge k-assign e-solid"/)
  const live = renderLoopGraphSvg(graph, snapshotWith([run('b_w1', 'running')]))
  assert.match(live, /class="edge k-assign e-solid"/)
  // Rework stays dashed until a rejection is actually recorded.
  assert.doesNotMatch(live, /class="edge k-reject e-solid"/)
  // A verdict is recorded against the leg that was JUDGED — the worker's — so
  // that is what hardens this team's rework edge and fills its evaluator's
  // counter. Keying either off the evaluator's own id is why the page read
  // `0 pass 0 reject` no matter how much reviewing had happened.
  const rejected = renderLoopGraphSvg(graph, snapshotWith([run('b_w1', 'running')],
    [{ agent_id: 'b_w1', pm_verdict: 'reject' }]))
  assert.match(rejected, /class="edge k-reject e-solid"/)
  assert.match(rejected, /0 pass 1 reject/)
})

test('every role states the work it actually did, from the ledger', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = new Map([ledger('tok', [
    { at: '2026-07-27T01:00:00.000Z', event: 'pulled', work_item: 'tok', agent_id: 'b_d', to_team: 'build' },
    { at: '2026-07-27T01:05:00.000Z', event: 'intake', work_item: 'tok', agent_id: 'b_d', verdict: 'accept' },
    { at: '2026-07-27T02:00:00.000Z', event: 'delivered', work_item: 'tok', agent_id: 'b_w1', terminal: 'done' },
    { at: '2026-07-27T02:30:00.000Z', event: 'delivered', work_item: 'tok', agent_id: 'b_w1', terminal: 'protocol-error' },
    { at: '2026-07-27T03:00:00.000Z', event: 'reviewed', work_item: 'tok', agent_id: 'b_e', verdict: 'reject' },
    { at: '2026-07-27T04:00:00.000Z', event: 'returned', work_item: 'tok', to_team: 'build', refused_by: 'v_d' },
    { at: '2026-07-27T05:00:00.000Z', event: 'escalated', work_item: 'tok', agent_id: 'pm' },
  ])])
  const svg = renderLoopGraphSvg(graph, snapshotWith(), new Map(), undefined, items)

  // A node that only says "no dispatch observed" is a box, not evidence. Pulse
  // knows a process ran; only the ledger knows whether that run accepted a
  // handoff, produced an artifact, or refused one.
  assert.match(svg, /1 accepted · 0 returned/, 'the dispatcher that accepted a handoff')
  assert.match(svg, /0 accepted · 1 returned/, 'the dispatcher that refused one')
  assert.match(svg, /1 delivered · 1 failed/, 'the worker that delivered once and failed once')
  assert.match(svg, /0 pass · 1 reject/, 'the evaluator that rejected')
  assert.match(svg, /1 escalation\(s\) handled/, 'the outer controller')
  // An agent with nothing recorded must say so rather than print a zero that
  // reads like a measurement.
  assert.match(svg, /nothing recorded yet/)
})

test('the outer controller states the same facts as every other agent', () => {
  const graph = graphOf(TWO_TEAMS)

  // The PM band was hand-drawn instead of going through the node renderer, so
  // every fact line added to agents later — lane, model, clock, status — never
  // reached it. It showed an id and a sentence, which is a label, not evidence.
  const idle = renderLoopGraphSvg(graph, snapshotWith())
  assert.match(idle, /OUTER · — · model —/, 'the controller must state lane and model like anyone else')

  // And a state in its own words. For an exception handler, nothing to do is the
  // correct state and good news; reporting it exactly like an agent that was
  // never wired up is what made this node read as dead.
  assert.match(idle, /watching — no exception open/)
  assert.match(idle, /class="node n-watching"/)
  assert.doesNotMatch(idle, /<title>pm — no dispatch observed<\/title>/)

  const parked = renderLoopGraphSvg(graph, snapshotWith(), new Map(), undefined, new Map([['tok', {
    work_item: 'tok', workflow: 'feature',
    custody: [{ at: '2026-07-27T01:00:00.000Z', event: 'escalated', work_item: 'tok', agent_id: 'pm', to_team: 'build' }],
  }]]))
  assert.match(parked, /1 token\(s\) parked — awaiting a decision/)

  const ran = renderLoopGraphSvg(graph, snapshotWith([run('pm', 'running', { elapsed_sec: 90 })]))
  assert.match(ran, /OUTER · claude · acp/)
  assert.match(ran, /1m in progress/, 'the controller must state a measured clock')
  assert.match(ran, /reviewing the board now/)
  assert.match(ran, /class="node n-working"/)
})

test('the newest dispatch wins when one agent ran more than once', () => {
  const svg = renderLoopGraphSvg(graphOf(TWO_TEAMS), snapshotWith([
    run('v_w1', 'died', { started_at: '2026-07-26T00:00:00.000Z' }),
    run('v_w1', 'running', { started_at: '2026-07-27T09:00:00.000Z' }),
  ]))
  assert.match(svg, /class="node n-working"/)
  assert.doesNotMatch(svg, /class="node n-dead"/)
})

test('the graph fills the viewport and is never pinned to a pixel size', () => {
  const page = renderGraphPage(repoWith(TWO_TEAMS), snapshotWith())
  assert.match(page, /<svg viewBox="-?\d+ 0 \d+ \d+" preserveAspectRatio/)
  assert.doesNotMatch(page, /<svg[^>]+\swidth="\d/)
  assert.match(page, /\.chart svg\{[^}]*width:100%/)
})

test('hostile names stay escaped and the page declares utf-8', () => {
  const dir = repoWith({
    project_id: 'x', outer_controller_id: 'pm', outer_controller_model: 'opus-5',
    teams: [{
      team_id: 'only', name: '<script>alert(1)</script>',
      dispatcher_id: 'a', worker_ids: ['b'], evaluator_id: 'c', models: MODELS,
    }],
    workflows: [{ workflow_id: 'w', name: 'W', route: ['only'] }],
  })
  const page = renderGraphPage(dir, snapshotWith())
  assert.match(page, /^<meta charset="utf-8">/)
  assert.doesNotMatch(page, /<script>alert/)
  assert.match(page, /&lt;script&gt;alert/)
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

// The three pages are published side by side and answer three different
// questions about one run. Reaching the other two used to mean knowing their
// filenames. Asserted on structure, never on the labels, which are copy.
test('the graph publishes the nav it shares with pulse and the board', () => {
  const page = pageOf(repoWith(TWO_TEAMS))
  assert.match(page, /<nav class="page-nav" aria-label="[^"]+">/)
  assert.match(page, /href="pulse\.html"/)
  assert.match(page, /href="kanban\.html"/)
  // This page is the one you are on, so it is the one entry that is not a link.
  assert.equal(page.includes('href="graph.html"'), false)
  assert.match(page, /\.page-nav\{/)
})

test('a repo where the runner has never run says so instead of looking calm', () => {
  const page = pageOf(repoWith(TWO_TEAMS))
  assert.match(page, /data-loop-health="never"/)
  assert.match(page, /never run in this repo/)
  // The dangerous failure is the opposite claim, made by silence.
  assert.doesNotMatch(page, /dispatching normally/)
})

test('a heartbeat older than three of its own ticks reads as not responding', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(61) })))
  assert.match(page, /data-loop-health="stale"/)
  assert.match(page, /is not responding/)
  assert.match(page, /Last tick 1m ago/)
  // `dispatching: true` is what the runner believed one tick before it stopped.
  // A dead runner claiming to dispatch is exactly the calm-looking lie.
  assert.doesNotMatch(page, /dispatching normally/)
})

test('a stale hold is reported as what the runner last said, not as a hold in progress', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS),
    heartbeat({ at: ago(300), dispatching: false, reason: 'pulse.json is stale' })))
  assert.match(page, /data-loop-health="stale"/)
  assert.doesNotMatch(page, /data-loop-health="holding"/)
  assert.match(page, /At that last tick it said: &quot;pulse.json is stale&quot;/)
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
  assert.match(page, /data-loop-health="holding"/)
  assert.match(page, /deliberately not dispatching/)
  assert.match(page, /Last tick 10s ago/)
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; pulse\.json is stale/)
  assert.doesNotMatch(page, /<script>alert/)

  // A hold with no reason is itself the thing to chase; the page never writes
  // one for the runner.
  const silent = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ dispatching: false, reason: '' })))
  assert.match(silent, /holding without saying why/)
})

test('a dispatching runner states the age of its last tick and what that tick did', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ started: 3, held: 1 })))
  assert.match(page, /data-loop-health="dispatching"/)
  assert.match(page, /dispatching normally/)
  assert.match(page, /Last tick 10s ago/)
  assert.match(page, /started in that tick: 3/)
  assert.match(page, /held: 1/)
})

test('a count the runner did not report is not printed as a zero', () => {
  const bare = heartbeat()
  delete bare.started
  delete bare.held
  const page = pageOf(beat(repoWith(TWO_TEAMS), bare))
  assert.match(page, /started in that tick: not measured/)
  assert.match(page, /held: not measured/)
  assert.doesNotMatch(page, /started in that tick: 0/)

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
