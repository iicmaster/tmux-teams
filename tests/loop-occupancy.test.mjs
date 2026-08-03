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
import { REVIEW_VERDICTS, readVerdict, roleBrief } from '../plugins/tmux-teams/skills/tmux-teams/scripts/role-briefs.mjs'
import { EVENT_SPEC, LEDGER_EVENTS } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'
import { gateHistory } from './fixture-gate.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')

// Every seat names its model because the declaration now requires one (§3), and
// the value is never checked against a list — only its shape — so a fixture name
// is as legal here as a real one.
const MODELS = { dispatcher: 'test-model', worker: 'test-model', evaluator: 'test-model' }

// One worker per team on purpose: the WIP limit IS the worker count (§3), so one
// worker makes "one too many" a single unambiguous event rather than an
// arithmetic argument. No team declares `wip_limit` — it is derived, and a
// declared number that disagreed would be rejected outright.
const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'test-model',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1'], evaluator_id: 'b_e', models: MODELS },
    { team_id: 'test', name: 'Test', dispatcher_id: 't_d', worker_ids: ['t_w1'], evaluator_id: 't_e', models: MODELS },
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

// Contract §4 names fields on some events that these fixtures do not care about
// — which dispatch started a leg, whether it timed out, which task a review
// judged. Since DECISION 4 every write goes through `ledger-writer.appendEvent`,
// which refuses a line that does not satisfy §4 and refuses to append at all to
// a ledger that does not already validate. A shorthand history is therefore no
// longer a history this system could have produced, and a fixture written in one
// tests the loop against evidence it would never see.
//
// The uninteresting fields are filled in here rather than restated in thirty
// fixtures. What a test is ABOUT is still said by the test: anything a fixture
// states itself wins, because the spread below comes last.
const complete = (entry, lastDelivered) => {
  switch (entry.event) {
    case 'assigned':
      return { dispatch_id: `${entry.task_id ?? 'task'}-dispatch`, ...entry }
    case 'delivered':
      return { timed_out: false, evidence_present: true, ...entry }
    case 'reviewed':
      // The leg a review judged is a real relationship, so it is read off the
      // history rather than invented: the last delivery before this line.
      return { reviewed_task: lastDelivered ?? 'nothing-delivered', reason: 'the evaluator said so', ...entry }
    // `returned` was missing from this list, and `escalated` /
    // `audit_requested` name a task §4 requires. The fixture gate found all
    // three: shorthand that had been quietly producing histories the writer
    // would refuse.
    case 'escalated':
    case 'audit_requested':
      return { task_id: 'controller-task', reason: 'stated by the agent that wrote it', ...entry }
    case 'audited':
      // §4: the audit states a verdict, and `accept` is the one that changes
      // nothing — a fixture that omitted it was describing an audit that
      // reached no conclusion, which the controller cannot write.
      return { verdict: 'accept', reason: 'stated by the agent that wrote it', ...entry }
    case 'opened':
    case 'intake':
    case 'lost':
    case 'resumed':
    case 'returned':
    case 'abandoned':
      return { reason: 'stated by the agent that wrote it', ...entry }
    default:
      return { ...entry }
  }
}

const ledger = (workItem, events, gate = {}) => {
  let lastDelivered = null
  const history = events.map((entry, index) => {
    const filled = complete(entry, lastDelivered)
    if (filled.event === 'delivered') lastDelivered = filled.task_id ?? lastDelivered
    // Minutes from a fixed midnight, not `T0${index}`. That template produced
    // `2026-07-27T010:00:00.000Z` — a three-digit hour — for every history
    // longer than ten events, so the longest fixtures in this file carried
    // timestamps that parse to nothing. Nothing complained, because until the
    // fixture gate nothing looked. Every stamp still lands before FIXED_NOW
    // (09:00), so ordering against it is unchanged.
    // Counted BACK from FIXED_NOW so the last event is always "just now" — the
    // property the old `T0${index}` template gave by accident when a history
    // happened to be ten events long. Anchoring the newest line instead of the
    // oldest keeps the zombie clock reading what these tests intend.
    const at = new Date(FIXED_NOW - (events.length - 1 - index) * 60_000).toISOString()
    return { at, work_item: workItem, workflow: 'feature', ...filled }
  })
  // Judged by the runtime's own validator before any test sees it. Everything
  // in this file — occupancy, dispatch planning, harvest, escalation — answers
  // from these histories, so a fixture the system could not have written makes
  // every answer downstream a statement about a different system.
  return gateHistory(workItem, history, gate)
}

// Since DECISION 4 the harvester appends through the sanctioned writer, which
// reads the ledger it is joining off disk — so a token that exists only in an
// in-memory items map is a token with no history at all, and every append onto
// it is refused as impossible. Tests that harvest lay the same history down on
// disk first.
const itemsOnDisk = (repo, ...entries) => {
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  for (const [workItem, events] of entries) {
    writeFileSync(join(repo, '.tmux-teams/work-items', `${workItem}.jsonl`),
      `${ledger(workItem, events).map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  }
  return itemsOf(...entries)
}

// A third element on an entry is the fixture gate's options — the only way a
// test says "this history is meant to be impossible", and it must say why.
const itemsOf = (...entries) => new Map(entries.map(([workItem, events, gate]) => {
  const custody = ledger(workItem, events, gate)
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

test('a token whose ledger cannot be believed is not handed to the next team', () => {
  const graph = graphOf(TWO_TEAMS)
  // Contract-legal except for the one thing under test: this `reviewed` names no
  // task it judged. A review of nothing is not a pass, and a handoff carries no
  // artifact of its own — what the next team inherits IS this history.
  const items = itemsOf(['broken', [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: null },
    // The gate is told to stand aside here, and told why: this history is the
    // subject, not the setup. Without the escape a test about unbelievable
    // ledgers could not build one.
  ], { expectInvalid: true, why: 'the broken history IS the subject — planPulls must refuse it' }])
  const [decision] = planPulls(graph, items, FIXED_ISO)

  assert.equal(decision.action, 'invalid')
  assert.equal(decision.from_team, 'build')
  assert.equal(decision.event, undefined, 'a history that cannot be believed must not produce a custody event')
  // Named, not merely refused: a silent skip here is indistinguishable from a
  // team with nothing waiting, and §13 forbids repairing the line in place.
  assert.match(decision.reason, /reviewed requires reviewed_task/)
  assert.ok(decision.problems.length >= 1)

  // The same predicate has to hold at apply time, or the loop would print this
  // handoff every tick while nothing moved.
  const dir = mkdtempSync(join(tmpdir(), 'pull-invalid-'))
  try {
    assert.equal(applyPulls(dir, [decision]), 0)
    assert.equal(existsSync(join(dir, '.tmux-teams/work-items/broken.jsonl')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
  // A limit BELOW the worker count can no longer be declared (§3), so the
  // pressure is applied the way it happens in production instead: one team of
  // one worker, holding two tokens whose next legs need two DIFFERENT agents.
  // `stuck` retries its failed leg on the worker t_w1; `pulled-in` needs the
  // dispatcher t_d for intake. Neither agent is busy, so agent availability
  // stops nothing here — only counting units of allowed work does.
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(
    ['stuck', FAILED_IN_TEST],
    ['pulled-in', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }]],
  )

  // The limit is the promise the board makes to a reader; the runner is the only
  // thing that can keep it. Dispatching per free agent instead of per unit of
  // allowed work is how a team limited to one ran two.
  const plans = planDispatches(graph, items, new Set()).filter((plan) => plan.team === 'test')
  const dispatches = plans.filter((plan) => plan.action === 'dispatch')
  assert.equal(dispatches.length, 1, `dispatched ${dispatches.length} agents into a team limited to 1`)
  // A ceiling that stops something silently looks exactly like a team with
  // nothing to do (§10), so the held-back token has to say why it waited.
  const waiting = plans.filter((plan) => plan.action === 'wait')
  assert.equal(waiting.length, 1)
  assert.match(waiting[0].reason, /at its WIP limit \(1\)/)
})

test('a team is handed the newest real deliverable, not the newest failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-brief-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
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
    const items = itemsOnDisk(dir, ['tok', [
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

// ── §14.4: the runner's half of the family guarantee ────────────────────────
//
// The board now fails when a word reaches its `default`. This is the same
// promise for the state machine: every event either moves the loop or is a dead
// end somebody wrote down. Four times this session a word was accepted by the
// validator and unknown to a reader, each found by a person looking at a page.
// A word added to §4 now has to answer this test instead of going quiet.
const NO_DISPATCH_FOLLOWS = {
  completed: 'the outer controller audits it — planEscalation, not a dispatch',
  audit_requested: 'waiting on the controller outbox; planHarvest turns it into `audited`',
  audited: 'terminal (§5)',
  abandoned: 'terminal (§5)',
}

test('every event either moves the loop or is a dead end somebody wrote down', () => {
  const graph = graphOf(TWO_TEAMS)
  const team = graph.teams[0]
  const filler = {
    from_team: team.team_id, to_team: team.team_id, refused_by: team.dispatcher_id,
    task_id: 't-1', dispatch_id: 'd-1', reviewed_task: 't-1', reason: 'a stated reason',
    terminal: 'done', timed_out: false, evidence_present: true, grant: 3,
    questions: 'who is the target customer? what happens on timeout?',
  }
  // Each event owns its vocabulary — `intake` records only an acceptance,
  // review speaks pass/reject/unresolved, the audit speaks accept/concern. One
  // shared filler word violated the rule closed an hour earlier, and the gate
  // said so immediately.
  const verdictFor = (event) => (
    event === 'intake' ? 'accept' : event === 'audited' ? 'accept' : 'pass')
  for (const event of LEDGER_EVENTS) {
    const entry = { at: '2026-07-27T09:00:00.000Z', event, agent_id: team.worker_ids[0] }
    for (const field of EVENT_SPEC[event].required ?? []) {
      if (!(field in entry)) entry[field] = field === 'verdict' ? verdictFor(event) : filler[field]
    }
    for (const field of EVENT_SPEC[event].forbidden ?? []) delete entry[field]
    // `skip` is the runner saying it has nothing to do — it is NOT movement.
    // The first version of this oracle read `Boolean(plan)`, and because
    // `planDispatches` RETURNS the `nothing follows` skip rather than dropping
    // it, every unknown word came back truthy and the assertion reduced to
    // `true === true`. It could not have failed for the one reason it exists.
    // `delivered` and `reviewed` need the leg that produced them, or the history
    // is one the loop cannot write. The question here is only which branch the
    // runner takes on the LAST event, so the prefix is the minimum that makes
    // the history real rather than a shape the fixture gate would reject.
    const assigned = { event: 'assigned', agent_id: entry.agent_id, task_id: 't-1', dispatch_id: 'd-1' }
    const delivered = { event: 'delivered', agent_id: entry.agent_id, task_id: 't-1', terminal: 'done' }
    const requested = { event: 'audit_requested', agent_id: 'pm', task_id: 'a-1' }
    const asked = { event: 'questioned', agent_id: team.dispatcher_id, questions: 'q?', reason: 'not enough to start' }
    const prefix = event === 'reviewed' ? [assigned, delivered]
      : event === 'delivered' ? [assigned]
        : event === 'audited' ? [requested]
          : event === 'answered' ? [asked] : []
    // The one event whose ACTOR KIND is part of its validity: a person answered,
    // and `human:` is how the ledger records that permanently (§5.1).
    if (event === 'answered') entry.actor = 'human:someone'
    const [plan] = planDispatches(graph, itemsOf(['tok', [...prefix, entry]]), new Set(),
      { now: Date.parse(entry.at) + 1e6 })
    const moved = Boolean(plan) && plan.action !== 'skip'
    const stated = event in NO_DISPATCH_FOLLOWS
    assert.equal(moved, !stated, stated
      ? `${event} is a stated dead end (${NO_DISPATCH_FOLLOWS[event]}) but the runner planned ${plan?.action}`
      : `${event} leaves the runner with nothing to do and is not a stated dead end`)
  }

  // The negative control this test shipped without, caught by an outside
  // reviewer within the hour. A word the runner has never heard of must read as
  // no movement; without this line the sweep above can be green on a vocabulary
  // it has never actually checked.
  const [unknown] = planDispatches(
    graph,
    itemsOf(['tok', [{ at: '2026-07-27T09:00:00.000Z', event: 'not_an_event', agent_id: team.worker_ids[0] }],
      { expectInvalid: true, why: 'a word outside §4 is the whole point — the control cannot exist without one' }]),
    new Set(), { now: Date.parse('2026-07-27T09:00:00.000Z') + 1e6 },
  )
  assert.equal(Boolean(unknown) && unknown.action !== 'skip', false,
    'an unknown event must read as no movement, or this whole test proves nothing')
})

// The cooldown used to be measured from the note file's mtime while `now` came
// from the caller. Two clocks in one subtraction: let the filesystem's run ahead
// and the difference goes negative, every tick reads "ran moments ago", and the
// outer controller is never dispatched again. Not hypothetical — it is what
// made the test below start failing partway through 2026-07-28, because its
// frozen `now` fell behind the real time the note was written at.
test('a filesystem clock ahead of the runner cannot silence the outer controller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-clock-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['tok', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }]])
    const occupancy = teamOccupancy(graph, items)
    const plans = [{ action: 'escalate', work_item: 'tok', team: 'test', reason: 'nothing can place this' }]

    mkdirSync(join(dir, '.tmux-teams', 'pm-notes'), { recursive: true })
    // Written this instant, so its mtime is the real wall clock — well past the
    // frozen `now` below. Line 1 is the only honest record of when the
    // controller actually ran, and it says weeks ago.
    writeFileSync(join(dir, '.tmux-teams', 'pm-notes', 'latest.md'),
      '2026-07-01T00:00:00.000Z\n- `other` in build: a problem read weeks ago\n')

    const plan = planEscalation(dir, graph, items, plans, occupancy, { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(plan.action, 'escalate', 'the stamp says weeks, only the filesystem says moments')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every shipped brief asks for the EVIDENCE block the ledger records', () => {
  // `evidence_present` was recorded on all 13 legs of the dogfood run and was
  // `false` on every one of them, because no brief had ever said the word. A
  // field that cannot be true is not a measurement.
  const dir = mkdtempSync(join(tmpdir(), 'loop-briefs-'))
  try {
    for (const role of ['dispatcher', 'evaluator', 'pm']) {
      const brief = roleBrief(dir, role, 'design', {
        teamName: 'Design', workItem: 'tok', fromTeam: 'intake', route: 'design -> build',
        workerId: 'design_w1', projectId: 'p', trigger: 't', board: 'b',
      })
      assert.match(brief, /^- End your outbox with an `EVIDENCE:` block/m, role)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a permanent problem does not re-dispatch the controller every cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-repeat-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['tok', [{ event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' }]])
    const occupancy = teamOccupancy(graph, items)
    const plans = [{ action: 'escalate', work_item: 'tok', team: 'test', reason: 'nothing can place this' }]

    // No `stallSec` override. This test used to pass `1e9`, which switched OFF
    // the one trigger whose text changes on every tick — so the only guard on
    // the brake had never once run the configuration the runner ships
    // (`planEscalation` is called with no options at all, loop-runner.mjs:1211).
    // Issue #22: the stall trigger renders a minute count, the brake compared it
    // as text, it was never twice the same, and the controller was re-dispatched
    // every PM_COOLDOWN_SEC for as long as the board stayed still. Both calls
    // below are a day past the last recorded event, so the stall is in both sets.
    const DAY = 86_400_000
    const first = planEscalation(dir, graph, items, plans, occupancy, { now: FIXED_NOW + DAY })
    assert.equal(first.action, 'escalate')
    mkdirSync(join(dir, '.tmux-teams', 'pm-notes'), { recursive: true })
    // The runner writes the IDENTITY, not the brief's text. Writing anything
    // else here would test a file this system does not produce.
    writeFileSync(join(dir, '.tmux-teams', 'pm-notes', 'latest.md'),
      `${new Date(FIXED_NOW + DAY).toISOString()}\n${first.identity}\n`)

    // An hour later: past the cooldown, same board, nothing recorded. A token
    // nobody can place stays in the set forever. Time alone is no brake on
    // that: past the cooldown it would dispatch a full agent to read the same
    // board again, every cooldown, indefinitely.
    const again = planEscalation(dir, graph, items, plans, occupancy, { now: FIXED_NOW + DAY + 3_600_000 })
    assert.equal(again.action, 'unchanged')

    // A guard on the guard, not the guard itself. The stall trigger renders
    // 1440 minutes in one call and 1500 in the other; if it ever stops being
    // volatile, the assertion above still passes while checking nothing.
    assert.notDeepEqual(first.triggers, again.triggers,
      'both calls rendered the same trigger text — this no longer exercises a trigger the clock moves')

    const changed = planEscalation(dir, graph, items,
      [...plans, { action: 'escalate', work_item: 'other', team: 'build', reason: 'new problem' }],
      occupancy, { now: FIXED_NOW + DAY + 3_600_000 })
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
    const plans = [{ action: 'escalate', work_item: 'tok', team: 'test', reason: '3 worker attempts in test spent over 3 legs on this token — those legs ended: blocked' }]
    const escalation = planEscalation(dir, graph, items, plans, teamOccupancy(graph, items), { now: FIXED_NOW, stallSec: 1e9 })

    assert.equal(escalation.action, 'escalate')
    assert.equal(escalation.agent_id, 'pm', 'the declared outer controller is the one that gets dispatched')
    assert.match(escalation.brief, /those legs ended: blocked/)
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
  { event: 'escalated', agent_id: 'pm', to_team: 'test', task_id: 'board-pm-1', reason: '3 worker attempts in test spent over 3 legs on this token — those legs ended: blocked' },
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

test('a controller that answers nothing hands the token to a person', () => {
  const dir = pmRepo('I looked at the board and it seems fine overall.\n')
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['parked', ESCALATED])
    // Silence is still not permission to close someone's work. But leaving the
    // token exactly where it was made an escalation a place tokens went to die:
    // every tick re-read the same unusable outbox and nothing ever moved. Every
    // other gate escalates upward when it cannot answer; the controller IS the
    // top, so its only remaining reader is a person — and the front door
    // already runs a deadline for exactly that.
    const applied = applyHarvest(dir, graph, planHarvest(graph, items, () => true), '2026-07-27T09:00:00.000Z')
    assert.equal(applied.length, 1)
    assert.equal(applied[0].event, 'questioned')
    assert.match(applied[0].questions, /resume|abandon/, 'it names the words that would have worked')
    assert.match(applied[0].reason, /no verdict this seat can use/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a frozen pulse snapshot stops the runner dispatching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stale-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
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
    project_id: 'p', outer_controller_id: 'pm', outer_controller_model: 'test-model',
    teams: Array.from({ length: 6 }, (unused, index) => ({
      team_id: `t${index}`, name: `T${index}`, dispatcher_id: `d${index}`,
      worker_ids: [`w${index}`], evaluator_id: `e${index}`, models: MODELS,
    })),
    workflows: [{ workflow_id: 'feature', name: 'F', route: ['t0', 't1', 't2', 't3', 't4', 't5'] }],
  }
  const graph = graphOf(many)
  const items = itemsOf(...Array.from({ length: 6 }, (unused, index) => [`tok${index}`, [
    { event: 'opened', agent_id: `d${index}`, to_team: `t${index}` },
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

// ── a spent budget has to say what it was spent ON ──────────────────────────
//
// Measured on this file's own fixtures: three quality rejections and three legs
// killed by a review gate that was down BOTH produced
// `3 worker attempts in <team> all failed`. Nothing failed in the first case,
// and the second never said the cause — so the controller, whose only two words
// are `resume` and `abandon`, granted three more legs against the same wall.

// One turn of a team's own quality loop. §1 blesses this and only this as
// same-token rework: the worker delivers, the team's own evaluator runs its leg,
// and rejects.
const REWORK = (n) => ([
  { event: 'assigned', agent_id: 'b_w1', task_id: `b-${n}` },
  { event: 'delivered', agent_id: 'b_w1', task_id: `b-${n}`, terminal: 'done' },
  { event: 'assigned', agent_id: 'b_e', task_id: `e-${n}` },
  { event: 'delivered', agent_id: 'b_e', task_id: `e-${n}`, terminal: 'done' },
  { event: 'reviewed', agent_id: 'b_e', verdict: 'reject' },
])
const ADMITTED = [
  { event: 'opened', agent_id: 'b_d', to_team: 'build' },
  { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
]
const BUDGET_SPENT_ON_QUALITY = [...ADMITTED, ...REWORK(1), ...REWORK(2), ...REWORK(3)]

test('a spent attempt budget says what the attempts ended as', () => {
  const graph = graphOf(TWO_TEAMS)

  // Three rejections. Every leg delivered; the old sentence called all three
  // failures, to the one reader that decides whether to pay for three more.
  const quality = planDispatches(graph, itemsOf(['tok', BUDGET_SPENT_ON_QUALITY]),
    new Set(), { now: FIXED_NOW })[0]
  assert.equal(quality.action, 'escalate')
  assert.match(quality.reason, /ended: done/)
  assert.doesNotMatch(quality.reason, /all failed/)

  // Three legs blocked by a gate that was down. Same budget, opposite cause.
  const blocked = planDispatches(graph, itemsOf(['tok', [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    { event: 'intake', agent_id: 't_d', verdict: 'accept' },
    ...[1, 2, 3].flatMap((n) => ([
      { event: 'assigned', agent_id: 't_w1', task_id: `t-${n}` },
      { event: 'delivered', agent_id: 't_w1', task_id: `t-${n}`, terminal: 'blocked', evidence_present: false },
    ])),
  ]]), new Set(), { now: FIXED_NOW })[0]
  assert.equal(blocked.action, 'escalate')
  assert.match(blocked.reason, /ended: blocked/)

  // A leg the runner declared lost delivered nothing at all, and says so rather
  // than borrowing the vocabulary of one that did.
  const lost = planDispatches(graph, itemsOf(['tok', [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    { event: 'intake', agent_id: 't_d', verdict: 'accept' },
    ...[1, 2].flatMap((n) => ([
      { event: 'assigned', agent_id: 't_w1', task_id: `t-${n}` },
      { event: 'delivered', agent_id: 't_w1', task_id: `t-${n}`, terminal: 'hard-timeout', evidence_present: false },
    ])),
    { event: 'assigned', agent_id: 't_w1', task_id: 't-3' },
    { event: 'lost', agent_id: 't_w1', task_id: 't-3' },
  ]]), new Set(), { now: FIXED_NOW })[0]
  assert.equal(lost.action, 'escalate')
  assert.match(lost.reason, /hard-timeout, lost/)
})

test('a second spent budget still reaches the controller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-budget-again-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const first = itemsOf(['tok', BUDGET_SPENT_ON_QUALITY])
    const round1 = planEscalation(dir, graph, first,
      planDispatches(graph, first, new Set(), { now: FIXED_NOW }), teamOccupancy(graph, first),
      { now: FIXED_NOW, cooldownSec: 0, stallSec: 1e9 })
    assert.equal(round1.action, 'escalate')
    // Pinned deliberately: every leg delivered, so `failedLegs` is 0 and the
    // RETRY_NOISE trigger never fires. If it ever did, its own growing count
    // would make the two rounds differ and this test would go green without the
    // fix — which is exactly why the transport case cannot be used here.
    assert.equal(round1.triggers.length, 1)

    // What the controller was told, written the way `tick` writes it.
    mkdirSync(join(dir, '.tmux-teams', 'pm-notes'), { recursive: true })
    writeFileSync(join(dir, '.tmux-teams', 'pm-notes', 'latest.md'),
      `${new Date(FIXED_NOW - 3_600_000).toISOString()}\n${round1.identity}\n`)

    // It said `resume`; the token spent the fresh budget the same way. The brake
    // compares trigger lines byte-for-byte, so a reason that cannot tell round
    // two from round one parks the token until the 30-minute stall trigger,
    // while the runner logs "the same 1 problem(s) the controller already read".
    const second = itemsOf(['tok', [...BUDGET_SPENT_ON_QUALITY,
      { event: 'escalated', agent_id: 'pm', to_team: 'build', task_id: 'board-pm-1' },
      { event: 'resumed', agent_id: 'pm', to_team: 'build', grant: 3 },
      ...REWORK(4), ...REWORK(5), ...REWORK(6)]])
    const round2 = planEscalation(dir, graph, second,
      planDispatches(graph, second, new Set(), { now: FIXED_NOW }), teamOccupancy(graph, second),
      { now: FIXED_NOW, cooldownSec: 0, stallSec: 1e9 })
    assert.equal(round2.action, 'escalate',
      'the second spent budget was brake-held as a problem the controller had already read')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── the controller audits, it does not only firefight ──────────────────────
//
// Built as an exception handler alone it never ran once: a whole route finished,
// recovered from four failed legs on the way, and nobody read the delivery or
// heard about the failures. Master asked for a controller that checks every team
// and every workflow is still working correctly.

// This history begins where the first team accepted the work, not at a pull.
// Contract §4 has no spelling for a route-OPENING `pulled`: it requires
// `from_team`, and the first pull of a route has no sending team. That gap is
// recorded as unresolved in contract §14.2 item 1; inventing a sending team here
// to satisfy the validator would hide it.
const ROUTE_DONE = [
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
    // Each failed leg now carries the `assigned` that started it. The fixture
    // used to jump straight to `delivered`, which the loop cannot produce — a
    // worker cannot deliver a task nobody gave it — so the retry story it told
    // was one the runner would never see.
    const items = itemsOf(['noisy', [
      { event: 'opened', agent_id: 'b_d', to_team: 'build' },
      { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'protocol-error' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-2' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'protocol-error' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-3' },
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
    const items = itemsOf(['parked', [{ event: 'opened', agent_id: 'b_d', to_team: 'build' }]])
    const occupancy = teamOccupancy(graph, items)

    // Read off the fixture rather than restated. This was hardcoded to the
    // timestamp the old generator happened to produce for a one-event history,
    // so it silently stopped describing this fixture the moment stamps changed.
    const pulledAt = Date.parse(items.get('parked').custody[0].at)
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
    const flagged = itemsOnDisk(dir, ['shipped', [...ROUTE_DONE,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1' }]])

    writeFileSync(join(dir, '.mailbox-out', 'pm-1'), 'I had a look around.\n')
    const [unread] = applyHarvest(dir, graph, planHarvest(graph, flagged, () => true), FIXED_ISO)
    // Still not closed — but no longer a dead end. An audit that cannot answer
    // hands the token to a person, because the controller is the top gate and
    // has nowhere left to escalate to. Leaving it flagged for ever meant the
    // loop re-read the same unusable outbox on every tick and nothing moved.
    assert.equal(unread.event, 'questioned', 'an unread answer never closes the audit')
    assert.notEqual(unread.event, 'audited')
    assert.match(unread.questions, /accept/)

    writeFileSync(join(dir, '.mailbox-out', 'pm-1'),
      'The spec asked for ten acceptance criteria and the delivery covers eight.\n\nVERDICT: concern\nREASON: AC7 and AC9 are not implemented\n')
    const [event] = applyHarvest(dir, graph, planHarvest(graph, flagged, () => true), FIXED_ISO)
    assert.equal(event.event, 'audited')
    assert.equal(event.verdict, 'concern')
    assert.match(event.reason, /AC7 and AC9/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a dispatch refused for its declared model is not retried', () => {
  const graph = graphOf(TWO_TEAMS)
  // The companion refuses before any work happens, and it will refuse the same
  // way every time. Three identical failures cost three dispatches and teach
  // nobody anything; worse, the escalation that follows carries the same
  // unacknowledged model, so the controller fails too and the token is held for
  // good while the board still reads as dispatching.
  for (const terminal of ['identity-missing', 'identity-mismatch']) {
    const plan = planDispatches(graph, itemsOf(['tok', [
      { event: 'opened', agent_id: 'b_d', to_team: 'build' },
      { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal },
    ]]), new Set())[0]
    assert.equal(plan.action, 'escalate', `${terminal} was retried`)
    assert.match(plan.reason, /declared model/)
  }

  // An ordinary transport failure still gets its retries.
  const transport = planDispatches(graph, itemsOf(['tok', [
    { event: 'opened', agent_id: 'b_d', to_team: 'build' },
    { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'protocol-error' },
  ]]), new Set())[0]
  assert.equal(transport.action, 'dispatch')
})

// ── the page that lands on disk ──────────────────────────────────────────────

const publish = (ledgers = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-page-'))
  const store = join(dir, '.tmux-teams')
  mkdirSync(join(store, 'work-items'), { recursive: true })
  writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
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
    // live and does nothing. The loop body was empty until 2026-07-31, so this
    // list has been iterated and discarded on every run since it was written.
    for (const hook of ['meta name="tmux-teams-snapshot-id"', 'data-observation-expires-at',
      'data-refresh-toggle', 'data-refresh-status']) {
      assert.ok(html.includes(hook), `the refresh script reaches for ${hook}, which the page never renders`)
    }
  } finally { rmSync(store.replace(/\/\.tmux-teams$/, ''), { recursive: true, force: true }) }
})

// ── a wedged harvest must say so ─────────────────────────────────────────────

test('a gate answering in the wrong vocabulary is reported, not skipped in silence', async () => {
  // An audit takes `accept` or `concern`. Answer `pass` — the evaluator's word
  // — and `harvestEvent` returns null. It used to `continue` from there, so the
  // token sat for ever while the runner printed "nothing to move", which is the
  // same line it prints when there is genuinely nothing to do. A wedged loop
  // looked exactly like an idle one.
  const { applyHarvest } = await import('../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'wedge-'))
  const store = join(dir, '.tmux-teams')
  mkdirSync(join(store, 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.mailbox-out', 'audit-task'), 'VERDICT: pass\nTEAM_DONE audit-task\n')

  const job = {
    item: { work_item: 'tok', workflow: 'feature', custody: [] },
    last: { event: 'audit_requested', agent_id: 'pm', task_id: 'audit-task' },
    role: 'audit',
  }
  const said = []
  const applied = applyHarvest(dir, TWO_TEAMS, [job], '2026-08-02T00:00:00.000Z', (skip) => said.push(skip))
  try {
    // It no longer dies here: an audit that cannot answer parks the token on a
    // person, with the words it should have used spelled out in the question.
    assert.equal(applied.length, 1)
    assert.equal(applied[0].event, 'questioned')
    assert.match(applied[0].questions, /accept/)
    assert.match(applied[0].questions, /concern/)
    assert.deepEqual(said, [], 'nothing was skipped, so nothing needed reporting')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a door that has refused three times escalates instead of refusing again', () => {
  // Master, 2026-08-03: the door check is legal and stays legal, but three is
  // the ceiling. A fourth refusal is not a check — it is two seats disagreeing
  // about the same work with nobody deciding, and the token bounces for as long
  // as both keep their opinion.
  const dir = mkdtempSync(join(tmpdir(), 'loop-door-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 't-intake'),
      'Still nothing to build against.\n\nVERDICT: reject\nREASON: no interface named\n')
    const graph = graphOf(TWO_TEAMS)
    const refusals = [1, 2, 3].flatMap(() => [
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'returned', to_team: 'build', refused_by: 't_d' },
    ])
    const atTheDoorAgain = [
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'assigned', agent_id: 't_d', task_id: 't-intake' },
      { event: 'delivered', agent_id: 't_d', task_id: 't-intake', terminal: 'done' },
    ]

    const [third] = applyHarvest(dir, graph,
      planHarvest(graph, itemsOf(['tok', [...refusals.slice(0, 4), ...atTheDoorAgain]])),
      '2026-07-27T09:00:00.000Z')
    assert.equal(third.event, 'returned', 'the third refusal is still an ordinary door check')

    const [fourth] = applyHarvest(dir, graph,
      planHarvest(graph, itemsOf(['tok', [...refusals, ...atTheDoorAgain]])),
      '2026-07-27T09:00:00.000Z')
    assert.equal(fourth.event, 'escalated', 'the fourth refusal bounced the token again')
    // §4.2: the token is at this team's door, so this team still holds it —
    // the same placement the no-sending-team escalation uses.
    assert.equal(fourth.to_team, 'test')
    assert.equal(fourth.agent_id, 't_d')
    assert.match(fourth.reason, /refused the token 3 times/)
    // The refusal's own words survive: the controller is being asked to decide,
    // not handed a token with the reasoning stripped off.
    assert.match(fourth.reason, /no interface named/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── a refused pull must reach the caller that narrates it ────────────────────

test('a pull the writer refuses comes back on the decision, not only on stderr', () => {
  // §14.2 item 6, built on purpose: `readWorkItems` drops a line no reader can
  // parse, so `planPulls` judges a clean four-event history and plans the pull.
  // The writer reads the FILE, sees the sixth line, and refuses. That gap is
  // the only way a pull can be planned and then refused, and it was reported
  // nowhere the caller could see — `applyPulls` returned a count, so the runner
  // one loop later narrated the refused pull as one that happened.
  const dir = mkdtempSync(join(tmpdir(), 'pull-refused-'))
  try {
    mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
    writeFileSync(join(dir, '.tmux-teams', 'work-items', 'tok.jsonl'),
      `${JSON.stringify({
        at: FIXED_ISO, event: 'opened', work_item: 'tok', workflow: 'feature',
        agent_id: 'b_d', to_team: 'build', reason: 'start',
      })}\n{ this line is not JSON\n`)

    const decision = {
      work_item: 'tok', action: 'pull', workflow: 'feature',
      from_team: 'build', to_team: 'test',
      event: {
        at: FIXED_ISO, event: 'pulled', work_item: 'tok', workflow: 'feature',
        agent_id: 't_d', from_team: 'build', to_team: 'test',
      },
    }
    const said = []
    assert.equal(applyPulls(dir, [decision], (d, result) => said.push(`${d.work_item} ${result.code}`)), 0)

    assert.equal(decision.write_result?.ok, false,
      'the refusal never reached the decision object the runner narrates')
    assert.equal(decision.write_result.code, 'ledger_already_invalid')
    assert.deepEqual(said, ['tok ledger_already_invalid'], 'the injected reporter was not called')
    assert.equal(readFileSync(join(dir, '.tmux-teams/work-items/tok.jsonl'), 'utf8')
      .trim().split('\n').length, 2, 'a line reached a ledger that had already failed validation')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
