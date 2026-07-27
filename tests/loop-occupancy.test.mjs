// loop-occupancy.test.mjs — where the loop says work is, and whether the page
// that draws it can be believed.
//
// The board, the pull controller and the runner each answer "which team is
// holding this token right now". They answer it from the same ledger, so they
// must answer it the same way; a board that reads full while the controller
// reads empty is worse than no board, because the WIP limit it draws is not the
// one being enforced.
//
// The page half of this file deliberately renders through `pulse.mjs once` and
// reads the file that lands on disk. Asserting on a returned string proves the
// generator ran; it does not prove the asset the page names exists, parses, or
// matches the digest the browser checks it against.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

import { teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import {
  applyHarvest, planDispatches, planEscalation, planHarvest, tick,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { applyPulls, planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'
import { REVIEW_VERDICTS, readVerdict } from '../plugins/tmux-teams/skills/tmux-teams/scripts/role-briefs.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')

// One worker per team on purpose: a WIP limit of 1 makes "one too many" a
// single unambiguous event rather than an arithmetic argument.
const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1'], evaluator_id: 'b_e', wip_limit: 1 },
    { team_id: 'test', name: 'Test', dispatcher_id: 't_d', worker_ids: ['t_w1'], evaluator_id: 't_e', wip_limit: 1 },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['build', 'test'] }],
}

// The ledger fixtures are stamped on this date, so a real clock would read every
// held token as stalled by years.
const FIXED_NOW = Date.parse('2026-07-27T09:00:00.000Z')
const FIXED_ISO = '2026-07-27T09:00:00.000Z'

const graphOf = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

const ledger = (workItem, events) => events.map((entry, index) => ({
  at: `2026-07-27T0${index}:00:00.000Z`, work_item: workItem, workflow: 'feature', ...entry,
}))

const itemsOf = (...entries) => new Map(entries.map(([workItem, events]) => {
  const custody = ledger(workItem, events)
  return [workItem, {
    work_item: workItem, workflow: 'feature', custody,
    current_event: custody[custody.length - 1].event,
    terminal: custody[custody.length - 1].terminal || '',
    legs: custody.filter((entry) => entry.event === 'assigned').length,
  }]
}))

// A token that ran the whole route: build took it, delivered it, test pulled it,
// ran it, delivered it, and the controller closed the route.
const FINISHED = [
  { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
  { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
  { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
  { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
  { event: 'delivered', agent_id: 't_w1', task_id: 't-1', terminal: 'done' },
  { event: 'completed', from_team: 'test' },
]

// The shape the live ledger is in right now: a leg that ended in a protocol
// error, which produced no artifact and no outbox.
const FAILED_IN_TEST = [
  { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
  { event: 'assigned', agent_id: 't_w1', task_id: 't-9' },
  { event: 'delivered', agent_id: 't_w1', task_id: 't-9', terminal: 'protocol-error' },
]

// Ready to move on: build's worker delivered AND build's own evaluator passed
// it. A delivery on its own releases nothing — that is what the evaluator is for.
const DELIVERED_BY_BUILD = [
  { event: 'assigned', agent_id: 'b_w1', task_id: 'b-2' },
  { event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done' },
  { event: 'reviewed', agent_id: 'b_e', task_id: 'b-2-review', verdict: 'pass' },
]

// ── where the work is ────────────────────────────────────────────────────────

test('a token that finished its route is done, not unplaceable', () => {
  const occupancy = teamOccupancy(graphOf(TWO_TEAMS), itemsOf(['shipped', FINISHED]))

  // `orphans` is the page's red banner: "cannot be placed — agent or workflow
  // not in this graph". Work that completed exactly as declared belongs in
  // neither that banner nor any team's WIP count.
  assert.deepEqual(occupancy.orphans, [], 'finished work was reported as unplaceable')
  assert.equal(occupancy.counts.get('test'), 0)
  assert.equal(occupancy.counts.get('build'), 0)
})

test('a leg that failed still occupies the team that has to run it again', () => {
  const occupancy = teamOccupancy(graphOf(TWO_TEAMS), itemsOf(['stuck', FAILED_IN_TEST]))

  // The worker exited; the work did not leave. Dropping it here is how a token
  // disappears from the board while the team is still on the hook for it.
  assert.equal(occupancy.counts.get('test'), 1)
  assert.deepEqual(occupancy.held.get('test'), ['stuck'])
})

test('the board and the controller agree about a team holding a failed leg', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['stuck', FAILED_IN_TEST], ['ready', DELIVERED_BY_BUILD])
  const occupancy = teamOccupancy(graph, items)
  const decisions = planPulls(graph, items, '2026-07-27T09:00:00.000Z')

  // Test is full by the only definition the page shows a reader (1/1). If the
  // controller counts it empty it will pull `ready` in on top of `stuck`, and
  // the limit drawn on the board is not the limit being enforced.
  assert.equal(occupancy.counts.get('test'), graph.teams[1].wip_limit)
  const pulled = decisions.filter((entry) => entry.action === 'pull' && entry.to_team === 'test')
  assert.deepEqual(pulled, [], 'controller pulled into a team the board draws as full')
  assert.equal(decisions.find((entry) => entry.work_item === 'ready')?.action, 'blocked')
})

test('a failed leg is never handed to the next team', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['stuck', [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-3' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-3', terminal: 'protocol-error' },
  ]])
  const decisions = planPulls(graph, items, '2026-07-27T09:00:00.000Z')

  // This is the incident in the live ledger: kanban-page was delivered with
  // terminal `protocol-error` at 06:39 and pulled build -> test 22 seconds
  // later, handing the next team a delivery that never existed.
  assert.deepEqual(decisions.map((entry) => entry.action), ['failed'])
  assert.equal(decisions[0].event, undefined, 'a failed leg must not invent a custody event')

  const dir = mkdtempSync(join(tmpdir(), 'pull-failed-'))
  try {
    assert.equal(applyPulls(dir, decisions), 0)
    assert.equal(existsSync(join(dir, '.tmux-teams/work-items/stuck.jsonl')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── the runner that acts on all of it ────────────────────────────────────────

test('the runner never puts more work in a team than its WIP limit allows', () => {
  const graph = graphOf({
    ...TWO_TEAMS,
    teams: [TWO_TEAMS.teams[0],
      { ...TWO_TEAMS.teams[1], worker_ids: ['t_w1', 't_w2'], wip_limit: 1 }],
  })
  const items = itemsOf(
    ['stuck', FAILED_IN_TEST],
    ['pulled-in', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }]],
  )

  // Test holds two tokens against a limit of one. The limit is the promise the
  // board makes to a reader; the runner is the only thing that can keep it, and
  // right now it dispatches per free worker instead of per unit of allowed work.
  const dispatches = planDispatches(graph, items, new Set())
    .filter((plan) => plan.action === 'dispatch' && plan.team === 'test')
  assert.ok(dispatches.length <= 1, `dispatched ${dispatches.length} workers into a team limited to 1`)
})

test('a team is handed the newest real deliverable, not the newest failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-brief-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(store, 'team-graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'test.md'), '# standing brief for Test\n')
    writeFileSync(join(dir, '.mailbox-out', 'build-1'), 'THE DESIGN THE BUILD TEAM DELIVERED\n')
    // Build delivered a real artifact; a later leg died before writing anything.
    // This is the live kanban-page ledger: three protocol-error legs stacked on
    // top of one genuine delivery.
    writeFileSync(join(store, 'work-items', 'token.jsonl'), `${ledger('token', [
      { event: 'assigned', agent_id: 'b_w1', task_id: 'build-1' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'build-1', terminal: 'done' },
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'assigned', agent_id: 't_w1', task_id: 'test-1' },
      { event: 'delivered', agent_id: 't_w1', task_id: 'test-1', terminal: 'protocol-error' },
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    ]).map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const scratch = join(dir, 'scratch')
    const result = tick(dir, { apply: false, scratchDir: scratch })
    assert.equal(result.ok, true, result.reason)
    // The token was just pulled into Test, so the leg the runner plans is that
    // team's dispatcher checking the handoff — and intake is exactly the role
    // that has to be handed the real artifact to judge.
    const brief = readFileSync(join(scratch, 'brief-token-test-dispatcher.md'), 'utf8')

    // Passing the outbox forward is the whole point of a route. A leg that
    // crashed produced no outbox, so quoting it tells the next team the
    // evidence is missing while the real deliverable sits unread on disk.
    assert.match(brief, /THE DESIGN THE BUILD TEAM DELIVERED/,
      'the next team was told there is no evidence while a delivered outbox existed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── every declared role, actually dispatched ────────────────────────────────
//
// The graph declares a dispatcher, workers and an evaluator per team plus an
// outer controller, and for a long time the runner dispatched only workers. A
// whole route could therefore run with every quality gate structurally absent.
// These are the states each role is reachable from.

const planFor = (graph, custody, busy = new Set()) =>
  planDispatches(graph, itemsOf(['tok', custody]), busy)
    .find((plan) => plan.work_item === 'tok')

test('every declared role has a state that dispatches it', () => {
  const graph = graphOf(TWO_TEAMS)
  const reached = new Map()
  for (const custody of [
    // pulled -> the receiving dispatcher checks the handoff
    [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }],
    // intake accepted -> a worker of that team does the work
    [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'intake', agent_id: 't_d', verdict: 'accept' }],
    // worker delivered -> that team's evaluator judges it
    [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'intake', agent_id: 't_d', verdict: 'accept' },
      { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
      { event: 'delivered', agent_id: 't_w1', task_id: 't-1', terminal: 'done' }],
  ]) {
    const plan = planFor(graph, custody)
    assert.equal(plan.action, 'dispatch', `no dispatch after ${custody[custody.length - 1].event}`)
    reached.set(plan.role, plan.agent_id)
  }

  assert.deepEqual([...reached.keys()].sort(), ['dispatcher', 'evaluator', 'worker'])
  assert.deepEqual(reached, new Map([['dispatcher', 't_d'], ['worker', 't_w1'], ['evaluator', 't_e']]))
})

test('a delivered artifact goes to its own evaluator, never straight onward', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
  ]])

  // This is the gate that was missing: the pull controller used to move a token
  // on the tick after the worker delivered, so the evaluator never ran at all.
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:00:00.000Z')
    .filter((entry) => entry.action === 'pull'), [])
  assert.equal(planDispatches(graph, items, new Set())[0].agent_id, 'b_e')
})

test('a rejected review goes back to this team, not to the next one', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reason: 'the tests do not run' },
  ]])
  const plan = planDispatches(graph, items, new Set())[0]

  assert.equal(plan.role, 'worker')
  assert.equal(plan.team, 'build', 'a rejection is the inner loop — it stays inside the team')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:00:00.000Z')
    .filter((entry) => entry.action === 'pull'), [])
})

test('an evaluator that states no verdict is not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-review-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    // A review that never says pass or reject. Reading approval into prose is
    // how a rubber stamp gets mistaken for a quality gate.
    writeFileSync(join(dir, '.mailbox-out', 'b-review'), 'Looks good to me overall.\n')
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['tok', [
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
      { event: 'assigned', agent_id: 'b_e', task_id: 'b-review' },
      { event: 'delivered', agent_id: 'b_e', task_id: 'b-review', terminal: 'done' },
    ]])

    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), '2026-07-27T09:00:00.000Z')
    assert.equal(event.event, 'reviewed')
    assert.equal(event.verdict, 'unresolved')
    assert.equal(event.reviewed_task, 'b-1', 'the verdict must name the leg it judged')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a refused handoff returns the token to the team that sent it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-intake-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 't-intake'),
      'Nothing was handed over.\n\nVERDICT: reject\nREASON: build delivered no file\n')
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['tok', [
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'assigned', agent_id: 't_d', task_id: 't-intake' },
      { event: 'delivered', agent_id: 't_d', task_id: 't-intake', terminal: 'done' },
    ]])

    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), '2026-07-27T09:00:00.000Z')
    assert.equal(event.event, 'returned')
    assert.equal(event.to_team, 'build')
    assert.equal(event.refused_by, 't_d')
    // Placement follows to_team, not the refusing dispatcher: the work is back
    // with Build, and a board that drew it in Test would be lying about who owes
    // the next move.
    assert.equal(event.agent_id, undefined)
    const back = itemsOf(['tok', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'returned', to_team: 'build', refused_by: 't_d' }]])
    assert.deepEqual(teamOccupancy(graph, back).held.get('build'), ['tok'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the verdict is the last one stated, not the first one mentioned', () => {
  // Every brief prints the required format as literal text, so an agent that
  // restates it before answering is ordinary. Reading the first match turns
  // that restatement into the decision — a rejection recorded as a pass.
  const echoed = 'I will finish with VERDICT: pass or VERDICT: reject.\n\n'
    + 'The tests do not run.\n\nVERDICT: reject\nREASON: node --check fails on two files\n'
  assert.equal(readVerdict(echoed, REVIEW_VERDICTS).verdict, 'reject')
  assert.match(readVerdict(echoed, REVIEW_VERDICTS).reason, /node --check fails/)
  assert.equal(readVerdict('no verdict anywhere', REVIEW_VERDICTS).stated, false)
})

test('a permanent problem does not re-dispatch the controller every cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-repeat-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['tok', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }]])
    const occupancy = teamOccupancy(graph, items)
    const plans = [{ action: 'escalate', work_item: 'tok', team: 'test', reason: 'nothing can place this' }]

    const first = planEscalation(dir, graph, items, plans, occupancy, { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(first.action, 'escalate')
    mkdirSync(join(dir, '.tmux-teams', 'pm-notes'), { recursive: true })
    writeFileSync(join(dir, '.tmux-teams', 'pm-notes', 'latest.md'),
      `2026-07-27T09:00:00.000Z\n${first.triggers.join('\n')}\n`)

    // A token nobody can place stays in `triggers` forever. Time alone is no
    // brake on that: past the cooldown it would dispatch a full agent to read
    // the same board again, every cooldown, indefinitely.
    const again = planEscalation(dir, graph, items, plans, occupancy, { now: FIXED_NOW + 86_400_000, stallSec: 1e9 })
    assert.equal(again.action, 'unchanged')

    const changed = planEscalation(dir, graph, items,
      [...plans, { action: 'escalate', work_item: 'other', team: 'build', reason: 'new problem' }],
      occupancy, { now: FIXED_NOW + 86_400_000, stallSec: 1e9 })
    assert.equal(changed.action, 'escalate', 'a new problem must still reach the controller')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an abandoned token stops occupying the team that can never finish it', () => {
  const graph = graphOf(TWO_TEAMS)
  const occupancy = teamOccupancy(graph, itemsOf(['probe', [
    { event: 'assigned', agent_id: 't_w1', task_id: 't-probe' },
    { event: 'abandoned', agent_id: 't_w1', reason: 'diagnostic probe, nobody will finish it' },
  ]]))

  // The alternatives are to lie (`completed`) or to leave it holding a WIP slot
  // on a team of one, which deadlocks that team for good.
  assert.equal(occupancy.counts.get('test'), 0)
  assert.deepEqual(occupancy.orphans, [])
})

test('the outer controller is dispatched when the runner runs out of moves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['tok', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }]])
    const plans = [{ action: 'escalate', work_item: 'tok', team: 'test', reason: '3 worker attempts all failed' }]
    const escalation = planEscalation(dir, graph, items, plans, teamOccupancy(graph, items), { now: FIXED_NOW, stallSec: 1e9 })

    assert.equal(escalation.action, 'escalate')
    assert.equal(escalation.agent_id, 'pm', 'the declared outer controller is the one that gets dispatched')
    assert.match(escalation.brief, /3 worker attempts all failed/)
    // It is dispatched about the board, so the board is what it is handed.
    assert.match(escalation.brief, /\*\*Test\*\* — WIP 1\/1/)

    // Nothing is escalated when nothing is stuck: a controller on a timer bills
    // for looking at a board that has not changed.
    assert.equal(planEscalation(dir, graph, items, [], teamOccupancy(graph, items), { now: FIXED_NOW, stallSec: 1e9 }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── the outer loop has a way back in ────────────────────────────────────────
//
// Escalation used to be a one-way door: the controller wrote a note nobody
// read, and the token was parked forever — while the board drew it as
// unplaceable and freed a WIP slot nobody had released.

const ESCALATED = [
  { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
  { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
  { event: 'delivered', agent_id: 't_w1', task_id: 't-1', terminal: 'protocol-error' },
  { event: 'escalated', agent_id: 'pm', to_team: 'test', task_id: 'board-pm-1', reason: '3 worker attempts all failed' },
]

const pmRepo = (outbox) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-outer-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  if (outbox !== null) writeFileSync(join(dir, '.mailbox-out', 'board-pm-1'), outbox)
  return dir
}

test('a token parked with the controller is still held by its team', () => {
  const occupancy = teamOccupancy(graphOf(TWO_TEAMS), itemsOf(['parked', ESCALATED]))

  // The controller is not a member of any team, so without naming the team the
  // board cannot place the token — it would print the red "cannot be placed"
  // banner over work that is parked exactly as designed, and free a WIP slot
  // that nobody released.
  assert.deepEqual(occupancy.orphans, [], 'parked work was reported as unplaceable')
  assert.equal(occupancy.counts.get('test'), 1)
  assert.deepEqual(occupancy.held.get('test'), ['parked'])
})

test('the controller saying resume puts the work back with a fresh budget', () => {
  const dir = pmRepo('The adapter rejected a relative path; that is fixed.\n\nVERDICT: resume\nREASON: the cause was transport, not the work\n')
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['parked', ESCALATED])
    const jobs = planHarvest(graph, items, () => true)
    const [event] = applyHarvest(dir, graph, jobs, '2026-07-27T09:00:00.000Z')

    assert.equal(event.event, 'resumed')
    assert.equal(event.to_team, 'test')
    assert.ok(event.grant > 0, 'a resume without a budget grant is an expensive no-op')

    // And the loop actually moves it: attempts made before the controller
    // looked at it must not count, or it re-escalates on the very next tick.
    const resumed = itemsOf(['parked', [...ESCALATED, { event: 'resumed', agent_id: 'pm', to_team: 'test', grant: 3 }]])
    const plan = planDispatches(graph, resumed, new Set())[0]
    assert.equal(plan.action, 'dispatch')
    assert.equal(plan.role, 'worker')
    assert.equal(plan.team, 'test')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the controller saying abandon closes it and frees the team', () => {
  const dir = pmRepo('This token is a diagnostic probe.\n\nVERDICT: abandon\nREASON: nobody will finish it\n')
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['parked', ESCALATED])
    const [event] = applyHarvest(dir, graph, planHarvest(graph, items, () => true), '2026-07-27T09:00:00.000Z')

    assert.equal(event.event, 'abandoned')
    const closed = itemsOf(['parked', [...ESCALATED, { event: 'abandoned', agent_id: 'pm' }]])
    assert.equal(teamOccupancy(graph, closed).counts.get('test'), 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a controller that answers nothing changes nothing', () => {
  const dir = pmRepo('I looked at the board and it seems fine overall.\n')
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['parked', ESCALATED])
    // Silence is not permission to close someone's work, and appending a no-op
    // would make the loop re-read the same outbox on every tick forever.
    assert.deepEqual(applyHarvest(dir, graph, planHarvest(graph, items, () => true), '2026-07-27T09:00:00.000Z'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a frozen pulse snapshot stops the runner dispatching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stale-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'team-graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'test.md'), '# standing brief\n')
    writeFileSync(join(store, 'work-items', 'tok.jsonl'), `${JSON.stringify({
      at: '2026-07-27T01:00:00.000Z', event: 'intake', work_item: 'tok', workflow: 'feature',
      agent_id: 't_d', verdict: 'accept',
    })}\n`)
    // A snapshot that exists but stopped moving can still be asserting that
    // agents are running, and can no longer say when they stop. Dispatching on
    // it means paying to run an agent that never exited.
    writeFileSync(join(store, 'pulse.json'), JSON.stringify({ generated_at: '2020-01-01T00:00:00.000Z', runs: [] }))

    const result = tick(dir, { apply: false, scratchDir: join(dir, 'scratch') })
    assert.equal(result.ok, true)
    assert.equal(result.stale, true)
    assert.deepEqual(result.plans, [], 'the runner dispatched against frozen evidence')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a team name with a control character is still rejected', () => {
  // The check lives in a regex whose character class was written as raw control
  // bytes, which made the whole file read as binary to `file` and invisible to
  // `grep`. Rewriting it as escapes must not change what it accepts.
  const withControl = {
    ...TWO_TEAMS,
    teams: [{ ...TWO_TEAMS.teams[0], name: `Build${String.fromCharCode(0)}` }, TWO_TEAMS.teams[1]],
  }
  assert.equal(validateWorkflowGraph(withControl).ok, false)
  assert.equal(validateWorkflowGraph(TWO_TEAMS).ok, true)
})

// ── the ceilings that bound what one loop can spend ─────────────────────────

test('a lost leg is recorded, not left occupying its team forever', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    { event: 'intake', agent_id: 't_d', verdict: 'accept' },
    { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
  ]])

  // Nothing is running and the assignment is long past the point where a
  // process could still be starting. Recording that is not the same as
  // inventing a delivery, and without it the token holds a WIP slot for good.
  const plan = planDispatches(graph, items, new Set(), { now: Date.parse('2026-07-28T00:00:00Z') })[0]
  assert.equal(plan.action, 'lost')
  assert.equal(plan.agent_id, 't_w1')

  // Inside the zombie window it is still simply in flight — a dispatch that
  // started moments ago must never be declared dead.
  const fresh = planDispatches(graph, itemsOf(['tok', [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
  ]]), new Set(), { now: Date.parse('2026-07-27T01:00:30Z') })
  assert.deepEqual(fresh.filter((entry) => entry.action === 'lost'), [])
})

test('the board as a whole has a dispatch ceiling, not only each team', () => {
  // Six teams of one, each holding a token ready for a worker. Team WIP limits
  // are all satisfied; only a board-wide ceiling stops this fanning out to six
  // concurrent agents.
  const many = {
    project_id: 'p', outer_controller_id: 'pm',
    teams: Array.from({ length: 6 }, (unused, index) => ({
      team_id: `t${index}`, name: `T${index}`, dispatcher_id: `d${index}`,
      worker_ids: [`w${index}`], evaluator_id: `e${index}`, wip_limit: 1,
    })),
    workflows: [{ workflow_id: 'feature', name: 'F', route: ['t0', 't1', 't2', 't3', 't4', 't5'] }],
  }
  const graph = graphOf(many)
  const items = itemsOf(...Array.from({ length: 6 }, (unused, index) => [`tok${index}`, [
    { event: 'pulled', agent_id: `d${index}`, to_team: `t${index}` },
    { event: 'intake', agent_id: `d${index}`, verdict: 'accept' },
  ]]))

  const dispatches = planDispatches(graph, items, new Set()).filter((plan) => plan.action === 'dispatch')
  assert.ok(dispatches.length <= 4, `dispatched ${dispatches.length} agents at once across the board`)
  assert.ok(planDispatches(graph, items, new Set()).some((plan) => /in flight across the board/.test(plan.reason || '')),
    'the ceiling must say out loud that it stopped something')
})

test('a token cannot exceed its leg ceiling unless the controller grants more', () => {
  const graph = graphOf(TWO_TEAMS)
  const legs = (count, extra = []) => itemsOf(['tok', [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    ...Array.from({ length: count }, (unused, index) => ([
      { event: 'assigned', agent_id: 't_w1', task_id: `t-${index}` },
      { event: 'delivered', agent_id: 't_w1', task_id: `t-${index}`, terminal: 'done' },
    ])).flat(),
    ...extra,
  ]])

  // Fifteen legs on one token is bouncing, not progressing. Per-role caps each
  // look reasonable and still allow two teams to ping-pong a token forever, so
  // the ceiling has to be on the journey.
  const spent = planDispatches(graph, legs(15), new Set())[0]
  assert.equal(spent.action, 'escalate')
  assert.match(spent.reason, /ceiling of 15/)

  // The controller can raise it, but only deliberately: each grant cost a PM
  // dispatch to obtain, and the grant is recorded on the ledger.
  const granted = planDispatches(graph, legs(15, [
    { event: 'escalated', agent_id: 'pm', to_team: 'test' },
    { event: 'resumed', agent_id: 'pm', to_team: 'test', grant: 3 },
  ]), new Set())[0]
  assert.equal(granted.action, 'dispatch')
  assert.equal(granted.role, 'worker')
})

// ── the controller audits, it does not only firefight ──────────────────────
//
// Built as an exception handler alone it never ran once: a whole route finished,
// recovered from four failed legs on the way, and nobody read the delivery or
// heard about the failures. Master asked for a controller that checks every team
// and every workflow is still working correctly.

const ROUTE_DONE = [
  { event: 'pulled', agent_id: 'b_d', to_team: 'build' },
  { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
  { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
  { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
  { event: 'reviewed', agent_id: 'b_e', verdict: 'pass' },
  { event: 'completed', from_team: 'build' },
]

test('a finished route is read as a whole, not just leg by leg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-audit-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['shipped', ROUTE_DONE])
    const escalation = planEscalation(dir, graph, items, [], teamOccupancy(graph, items),
      { now: FIXED_NOW, stallSec: 1e9 })

    // Every evaluator checked its own leg. Nobody checked whether what came out
    // of the end is what was asked for — that is the only question left, and the
    // controller is the only role that can see it.
    assert.equal(escalation.action, 'escalate')
    assert.deepEqual(escalation.audits, ['shipped'])
    assert.match(escalation.brief, /nobody has read the delivery as a whole/)

    // And it stops asking once it has been answered.
    const audited = itemsOf(['shipped', [...ROUTE_DONE,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1' },
      { event: 'audited', agent_id: 'pm', verdict: 'accept' }]])
    assert.equal(planEscalation(dir, graph, audited, [], teamOccupancy(graph, audited),
      { now: FIXED_NOW, stallSec: 1e9 }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reading a finished delivery never puts it back in a team', () => {
  const graph = graphOf(TWO_TEAMS)
  for (const tail of [['audit_requested'], ['audit_requested', 'audited']]) {
    const items = itemsOf(['shipped', [...ROUTE_DONE, ...tail.map((event) => ({ event, agent_id: 'pm' }))]])
    const occupancy = teamOccupancy(graph, items)
    assert.equal(occupancy.counts.get('build'), 0, `${tail.join('+')} re-occupied a team`)
    assert.deepEqual(occupancy.orphans, [])
  }
})

test('the controller hears about retries that succeeded quietly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-noise-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    // Three legs died and the fourth worked. Under the old rule the loop simply
    // carried on and nobody was ever told it had to try four times.
    const items = itemsOf(['noisy', [
      { event: 'pulled', agent_id: 'b_d', to_team: 'build' },
      { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'protocol-error' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'protocol-error' },
      { event: 'lost', agent_id: 'b_w1', task_id: 'b-3' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-4' },
    ]])
    const escalation = planEscalation(dir, graph, items, [], teamOccupancy(graph, items),
      { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation.action, 'escalate')
    assert.match(escalation.brief, /survived 3 failed legs and is still going/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a board holding work with nothing recorded is a stall, not calm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stall-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['parked', [{ event: 'pulled', agent_id: 'b_d', to_team: 'build' }]])
    const occupancy = teamOccupancy(graph, items)

    const pulledAt = Date.parse('2026-07-27T00:00:00.000Z')
    assert.equal(planEscalation(dir, graph, items, [], occupancy,
      { now: pulledAt + 1_800_000, stallSec: 3600 }), null, 'a team simply working is not a stall')

    const stalled = planEscalation(dir, graph, items, [], occupancy,
      { now: pulledAt + 7_200_000, stallSec: 3600 })
    assert.equal(stalled.action, 'escalate')
    assert.match(stalled.brief, /nothing recorded for \d+ minutes/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an audit answer closes the flag, and silence does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-audit-answer-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    const graph = graphOf(TWO_TEAMS)
    const flagged = itemsOf(['shipped', [...ROUTE_DONE,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1' }]])

    writeFileSync(join(dir, '.mailbox-out', 'pm-1'), 'I had a look around.\n')
    assert.deepEqual(applyHarvest(dir, graph, planHarvest(graph, flagged, () => true), FIXED_ISO), [],
      'an unread answer must not close the audit')

    writeFileSync(join(dir, '.mailbox-out', 'pm-1'),
      'The spec asked for ten acceptance criteria and the delivery covers eight.\n\nVERDICT: concern\nREASON: AC7 and AC9 are not implemented\n')
    const [event] = applyHarvest(dir, graph, planHarvest(graph, flagged, () => true), FIXED_ISO)
    assert.equal(event.event, 'audited')
    assert.equal(event.verdict, 'concern')
    assert.match(event.reason, /AC7 and AC9/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── the page that lands on disk ──────────────────────────────────────────────

const publish = (ledgers = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-page-'))
  const store = join(dir, '.tmux-teams')
  mkdirSync(join(store, 'work-items'), { recursive: true })
  writeFileSync(join(store, 'team-graph.json'), JSON.stringify(TWO_TEAMS))
  for (const [workItem, events] of Object.entries(ledgers)) {
    writeFileSync(join(store, 'work-items', `${workItem}.jsonl`),
      `${ledger(workItem, events).map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  }
  const result = spawnSync(process.execPath, [PULSE, 'once', dir], { encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 0, result.stderr)
  return { dir, store, html: readFileSync(join(store, 'graph.html'), 'utf8') }
}

test('the published loop graph can actually load the refresh script it names', () => {
  const { store, html } = publish()
  try {
    const named = html.match(/<script src="([^"]+)"/)
    assert.ok(named, 'the page wires no refresh script at all')
    const source = readFileSync(join(store, named[1]), 'utf8')

    // A <script src> tag proves nothing: the file has to exist next to the page
    // and has to parse, or the page is a static picture with a dead button.
    new Script(source)

    // The browser refuses to reload unless the digest in the marker matches the
    // bytes it fetched, so a stale marker silently freezes the page instead of
    // failing loudly.
    const marker = JSON.parse(readFileSync(join(store, 'pulse-current.json'), 'utf8'))
    assert.equal(marker.files.refresh_js.path, named[1])
    assert.equal(marker.files.refresh_js.sha256, createHash('sha256').update(source).digest('hex'))

    // Every hook that script reaches for. A missing one is a control that looks
    // live and does nothing.
    for (const hook of ['meta name="tmux-teams-snapshot-id"', 'data-observation-expires-at',
      'data-refresh-toggle', 'data-refresh-status']) {
      assert.ok(html.includes(hook), `the page is missing ${hook}`)
    }
    assert.match(html, /<meta name="tmux-teams-snapshot-id" content="[^"]+">/,
      'an empty snapshot marker makes the page reload on every poll')
  } finally { rmSync(store.replace(/\/\.tmux-teams$/, ''), { recursive: true, force: true }) }
})

test('the published page does not accuse a finished token of being unplaceable', () => {
  const { store, html } = publish({ shipped: FINISHED })
  try {
    assert.doesNotMatch(html, /cannot be placed/, 'the page flags completed work as an error')
  } finally { rmSync(store.replace(/\/\.tmux-teams$/, ''), { recursive: true, force: true }) }
})
