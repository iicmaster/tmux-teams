// team-flow.test.mjs — the loop graph page and the pull system behind it.
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
  DEFAULT_WORKFLOW_GRAPH, readWorkflowGraph, renderLoopGraphSvg, renderTeamFlowPage,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/team-flow.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'

const repoWith = (graph) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-graph-'))
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

const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1', 'b_w2'], evaluator_id: 'b_e', wip_limit: 2 },
    { team_id: 'verify', name: 'Verify', dispatcher_id: 'v_d', worker_ids: ['v_w1'], evaluator_id: 'v_e', wip_limit: 1 },
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
  const page = renderTeamFlowPage(dir, snapshotWith())
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
  // The lane is not a model: an unverified run says so rather than borrowing it.
  assert.match(svg, /model unverified/)
  assert.match(svg, /model gpt-5\.6-luna/)
  assert.doesNotMatch(svg, /model codex/)
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

test('the newest dispatch wins when one agent ran more than once', () => {
  const svg = renderLoopGraphSvg(graphOf(TWO_TEAMS), snapshotWith([
    run('v_w1', 'died', { started_at: '2026-07-26T00:00:00.000Z' }),
    run('v_w1', 'running', { started_at: '2026-07-27T09:00:00.000Z' }),
  ]))
  assert.match(svg, /class="node n-working"/)
  assert.doesNotMatch(svg, /class="node n-dead"/)
})

test('the graph fills the viewport and is never pinned to a pixel size', () => {
  const page = renderTeamFlowPage(repoWith(TWO_TEAMS), snapshotWith())
  assert.match(page, /<svg viewBox="-?\d+ 0 \d+ \d+" preserveAspectRatio/)
  assert.doesNotMatch(page, /<svg[^>]+\swidth="\d/)
  assert.match(page, /\.chart svg\{[^}]*width:100%/)
})

test('hostile names stay escaped and the page declares utf-8', () => {
  const dir = repoWith({
    project_id: 'x', outer_controller_id: 'pm',
    teams: [{ team_id: 'only', name: '<script>alert(1)</script>', dispatcher_id: 'a', worker_ids: ['b'], evaluator_id: 'c' }],
    workflows: [{ workflow_id: 'w', name: 'W', route: ['only'] }],
  })
  const page = renderTeamFlowPage(dir, snapshotWith())
  assert.match(page, /^<meta charset="utf-8">/)
  assert.doesNotMatch(page, /<script>alert/)
  assert.match(page, /&lt;script&gt;alert/)
})

// ── the pull system ──────────────────────────────────────────────────────────

const ledger = (id, events) => [id, {
  work_item: id, workflow: 'full', custody: events,
  current_agent: events[events.length - 1].agent_id,
}]

// A worker finishing is not the team finishing. Work sits in its team's done
// queue only once that team's own evaluator has passed it — so the fixture for
// "ready to move on" ends in a review, not a delivery.
const delivered = (id, agentId, hour) => ledger(id, [
  { at: `2026-07-27T0${hour}:00:00.000Z`, event: 'assigned', work_item: id, workflow: 'full', agent_id: agentId },
  { at: `2026-07-27T0${hour}:20:00.000Z`, event: 'delivered', work_item: id, workflow: 'full', agent_id: agentId, terminal: 'done' },
  {
    at: `2026-07-27T0${hour}:30:00.000Z`, event: 'reviewed', work_item: id, workflow: 'full',
    agent_id: `${agentId.split('_')[0]}_e`, verdict: 'pass',
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
