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

import { currentEntry, teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import {
  applyHarvest, buildTaskId, declaredEffort, effortEnv, planDispatches, planEscalation, planHarvest, tick,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { applyPulls, planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'
import {
  REVIEW_VERDICTS, TARGET_VERDICTS, readTargetVerdict, readVerdict, readWorkerHint, roleBrief,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/role-briefs.mjs'
import { EVENT_SPEC, LEDGER_EVENTS, validateLedger } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'
import { gateHistory } from './fixture-gate.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { admitWorkItem } from '../plugins/tmux-teams/skills/tmux-teams/scripts/admit.mjs'

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

// GitHub #31 stage 2: same shape as TWO_TEAMS, but `test` is a review team —
// its worker's own output is a verdict on `build`'s delivery, not an artifact.
// A separate constant rather than mutating TWO_TEAMS, so every existing test
// against that fixture is unaffected by this one opting in.
const TWO_TEAMS_WITH_REVIEW = {
  ...TWO_TEAMS,
  teams: TWO_TEAMS.teams.map((entry) =>
    entry.team_id === 'test' ? { ...entry, produces: 'verdict' } : entry),
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
    // ADR 0002: `opened` is the one event whose actor is a PERSON, not the
    // agent that wrote the rest of this fixture's lines — so it gets its own
    // default rather than joining the group below.
    case 'opened':
      return { reason: 'stated by the agent that wrote it', actor: 'human:someone', ...entry }
    // F4: `question_id` names the question so an answer can bind to it. A
    // fixture that only cares about occupancy or dispatch shape, not the
    // question's identity, still needs a legal one — invented per-fixture
    // would fight the point of `complete()` existing at all.
    case 'questioned':
      return { question_id: 'q-fixture-1', reason: 'stated by the agent that wrote it', ...entry }
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

test('a legacy ledger with only a tolerated defect is still handed to the next team (B5)', () => {
  const graph = graphOf(TWO_TEAMS)
  // Written before ADR 0002 required a human actor on `opened` — the shape a
  // real pre-amendment ledger is in. Built directly, not through
  // `itemsOf`/`gateHistory`: that gate exists to catch a history the system
  // could never have produced, and this one is real and dated before the
  // rule that would now flag it existed. `ledger-writer.mjs`'s own tolerance
  // test for this exact shape lives in `tests/ledger.test.mjs`; this is the
  // same defect one layer up, where B5's second freeze was found — a token
  // that regained the ability to be APPENDED to still could not be PULLED
  // forward.
  const custody = [
    { at: '2026-07-27T08:00:00.000Z', event: 'opened', work_item: 'legacy', workflow: 'feature', agent_id: 'b_d', to_team: 'build', reason: 'requested before ADR 0002', actor: 'agent:b_d' },
    { at: '2026-07-27T08:00:01.000Z', event: 'intake', work_item: 'legacy', workflow: 'feature', agent_id: 'b_d', verdict: 'accept', reason: 'buildable' },
    { at: '2026-07-27T08:00:02.000Z', event: 'assigned', work_item: 'legacy', workflow: 'feature', agent_id: 'b_w1', task_id: 'b-9', dispatch_id: 'b-9-dispatch' },
    { at: '2026-07-27T08:00:03.000Z', event: 'delivered', work_item: 'legacy', workflow: 'feature', agent_id: 'b_w1', task_id: 'b-9', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T08:00:04.000Z', event: 'reviewed', work_item: 'legacy', workflow: 'feature', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-9', reason: 'checks out' },
  ]
  // Sanity: confirm the raw ledger really is invalid, and for exactly the
  // legacy-tolerated reason — otherwise a pull here would prove nothing.
  const raw = validateLedger(custody.map((entry) => JSON.stringify(entry)))
  assert.equal(raw.ok, false)
  assert.deepEqual(raw.problems.map((problem) => problem.code), ['not_a_human_answer'])

  const items = new Map([['legacy', {
    work_item: 'legacy', workflow: 'feature', custody,
    current_event: 'reviewed', terminal: '', legs: 1,
  }]])
  const decisions = planPulls(graph, items, '2026-07-27T09:00:00.000Z')
  const decision = decisions.find((entry) => entry.work_item === 'legacy')
  assert.equal(decision?.action, 'pull',
    `expected a pull despite a tolerated legacy defect, got ${JSON.stringify(decision)}`)
  assert.equal(decision.to_team, 'test')
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

test('a review names its own leg, so a later reassignment can tell it apart from a live one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-review-leg-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 'b-review'), 'It does what the request asked for.\n\nVERDICT: pass\nREASON: matches the brief\n')
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOnDisk(dir, ['tok', [
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
      { event: 'assigned', agent_id: 'b_e', task_id: 'b-review', dispatch_id: 'rev-1' },
      { event: 'delivered', agent_id: 'b_e', task_id: 'b-review', terminal: 'done', dispatch_id: 'rev-1' },
    ]])

    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), '2026-07-27T09:00:00.000Z')
    assert.equal(event.event, 'reviewed')
    assert.equal(event.verdict, 'pass')
    // Without this the review is indistinguishable from a stale one a killed and
    // retried evaluator leg writes on its way out (dispatch-facts.mjs:129).
    assert.equal(event.dispatch_id, 'rev-1', 'the review did not name its own leg')
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

// ── GitHub #31 stage 2: a produces:'verdict' team's confirmed rejection ────

test('a produces:verdict team\'s evaluator confirms what the worker found, in a second field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-target-verdict-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 't-review'),
      'The worker rejected the build delivery; the reasoning checks out.\n\n'
      + 'VERDICT: pass\nREASON: the rejection was correctly reasoned\n\n'
      + 'TARGET_VERDICT: reject\nTARGET_REASON: the auth check is missing\n')
    const graph = graphOf(TWO_TEAMS_WITH_REVIEW)
    const items = itemsOnDisk(dir, ['tok', [
      { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
      { event: 'delivered', agent_id: 't_w1', task_id: 't-1', terminal: 'done' },
      { event: 'assigned', agent_id: 't_e', task_id: 't-review' },
      { event: 'delivered', agent_id: 't_e', task_id: 't-review', terminal: 'done' },
    ]])

    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), FIXED_ISO)
    assert.equal(event.event, 'reviewed')
    assert.equal(event.verdict, 'pass')
    assert.equal(event.target_verdict, 'reject')
    assert.match(event.target_reason, /auth check/)
    // The write must actually be legal — a target_verdict ledger-validate
    // cannot accept would jam exactly the team this field exists to help.
    const result = validateLedger([...items.get('tok').custody, event].map((entry) => JSON.stringify(entry)))
    assert.deepEqual(result.problems, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a produces:verdict team\'s evaluator who states no TARGET_VERDICT attaches nothing — silence is not a reopen signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-target-verdict-silent-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 't-review'), 'Looks right to me.\n\nVERDICT: pass\nREASON: matches the brief\n')
    const graph = graphOf(TWO_TEAMS_WITH_REVIEW)
    const items = itemsOnDisk(dir, ['tok', [
      { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
      { event: 'delivered', agent_id: 't_w1', task_id: 't-1', terminal: 'done' },
      { event: 'assigned', agent_id: 't_e', task_id: 't-review' },
      { event: 'delivered', agent_id: 't_e', task_id: 't-review', terminal: 'done' },
    ]])

    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), FIXED_ISO)
    assert.equal(event.event, 'reviewed')
    assert.equal('target_verdict' in event, false)
    assert.equal('target_reason' in event, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a plain artifact team\'s evaluator never gets a target_verdict, even if its prose contains the words', () => {
  // TWO_TEAMS (not the _WITH_REVIEW variant): `build` still defaults to
  // produces: 'artifact'. Gating on the declared team, not on outbox text,
  // is the whole point — a worker's report quoting "TARGET_VERDICT: reject"
  // from a review team's brief must not be read as this team stating one.
  const dir = mkdtempSync(join(tmpdir(), 'loop-target-verdict-gated-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 'b-review'),
      'It does what the request asked for.\n\nVERDICT: pass\nREASON: matches the brief\n\n'
      + 'TARGET_VERDICT: reject\nTARGET_REASON: this text should be ignored here\n')
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOnDisk(dir, ['tok', [
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done' },
      { event: 'assigned', agent_id: 'b_e', task_id: 'b-review' },
      { event: 'delivered', agent_id: 'b_e', task_id: 'b-review', terminal: 'done' },
    ]])

    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), FIXED_ISO)
    assert.equal(event.event, 'reviewed')
    assert.equal('target_verdict' in event, false)
    assert.equal('target_reason' in event, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// GitHub #31 stage 2: the evaluator brief itself only carries the
// TARGET_VERDICT instruction when the team opted in.
test('the evaluator brief names TARGET_VERDICT only for a produces:verdict team', () => {
  const withTarget = roleBrief('/nonexistent', 'evaluator', 'test',
    { teamName: 'Test', workItem: 'tok', workerId: 't_w1', producesVerdict: true })
  assert.match(withTarget, /TARGET_VERDICT:/)

  const withoutTarget = roleBrief('/nonexistent', 'evaluator', 'build',
    { teamName: 'Build', workItem: 'tok', workerId: 'b_w1', producesVerdict: false })
  assert.doesNotMatch(withoutTarget, /TARGET_VERDICT:/)
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

// GitHub #31 stage 2: unlike readVerdict, an unstated line must leave
// `verdict` as `null` rather than falling back to a word in the vocabulary —
// the caller (harvestEvent) only attaches target_verdict/target_reason to a
// `reviewed` event when `stated` is true, and a fabricated 'unresolved' word
// here (readVerdict's shape) is not in TARGET_VERDICTS and would make
// ledger-validate reject the write outright.
test('an unstated TARGET_VERDICT is null, not a fabricated word', () => {
  const stated = readTargetVerdict('It fails the request.\n\nTARGET_VERDICT: reject\nTARGET_REASON: missing the auth check\n')
  assert.equal(stated.verdict, 'reject')
  assert.equal(stated.stated, true)
  assert.match(stated.reason, /missing the auth check/)
  assert.ok(TARGET_VERDICTS.has(stated.verdict))

  const silent = readTargetVerdict('Looks fine, VERDICT: pass\nREASON: matches the brief\n')
  assert.equal(silent.verdict, null)
  assert.equal(silent.stated, false)
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
    question_id: 'q-1',
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
  // Which leg died, not only who was running it. agent_id cannot answer that
  // once the same agent has been assigned twice, and this verdict is the only
  // place the answer is still in scope.
  assert.equal(plan.dispatch_id, 't-1-dispatch', 'the lost verdict did not name the leg it is about')

  // Inside the zombie window it is still simply in flight — a dispatch that
  // started moments ago must never be declared dead.
  const fresh = planDispatches(graph, itemsOf(['tok', [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    { event: 'assigned', agent_id: 't_w1', task_id: 't-1' },
  ]]), new Set(), { now: Date.parse('2026-07-27T01:00:30Z') })
  assert.deepEqual(fresh.filter((entry) => entry.action === 'lost'), [])
})

test('the lost verdict reaches the ledger carrying the leg it is about', () => {
  // The plan naming the leg is half of it. This is the half that matters: the
  // value has to survive into the line on disk, because that line is what every
  // later reader answers from. Asserting only the plan would leave the write
  // free to drop it and the suite still green.
  const dir = mkdtempSync(join(tmpdir(), 'loop-lost-write-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'test.md'), '# standing brief\n')
    writeFileSync(join(store, 'work-items', 'tok.jsonl'), itemsOf(['tok', [
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'intake', agent_id: 't_d', verdict: 'accept' },
      { event: 'assigned', agent_id: 't_w1', task_id: 't-1', dispatch_id: 'd-1' },
    ]]).get('tok').custody.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    // Fresh enough that the runner trusts it, and empty so nobody reads as busy.
    writeFileSync(join(store, 'pulse.json'), JSON.stringify({ generated_at: new Date().toISOString(), runs: [] }))

    tick(dir, { apply: true, scratchDir: join(dir, 'scratch') })

    const lines = readFileSync(join(store, 'work-items', 'tok.jsonl'), 'utf8').trim().split('\n')
    const written = JSON.parse(lines[lines.length - 1])
    assert.equal(written.event, 'lost')
    assert.equal(written.agent_id, 't_w1')
    assert.equal(written.dispatch_id, 'd-1', 'the lost line on disk cannot say which leg died')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a lost leg reporting in after its own retry does not speak for the retry', () => {
  // The last outcome line that could not name its leg. `delivered` and
  // `reviewed` carry a dispatch_id, so a stale one from the same agent is
  // already skipped; `lost` fell back to agent_id, which reads identical for
  // both legs, so the dead one decided where the token was.
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
    // Declared dead and handed straight back to the same worker.
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'd-2' },
    { at: '2026-07-27T09:02:00.000Z', event: 'lost', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1', reason: 'no live process and nothing recorded' },
  ]
  assert.equal(currentEntry(custody).task_id, 'b-2', 'the stale lost was read as where the token is')
  assert.equal(currentEntry(custody).event, 'assigned', 'the live leg is still assigned, not lost')

  // 2026-08-04, retro-release-review F1: this used to assert the OPPOSITE —
  // that stripping dispatch_id from every line made the stale `lost` read as
  // current again, and called that "an old ledger reading the way it always
  // did". That was the same fail-open the late-reviewed-pass defect (F1) used,
  // just via `lost` instead of `reviewed`: with no dispatch_id anywhere,
  // agent_id cannot tell b-1's dead leg from b-2's live retry — they are the
  // SAME agent — so trusting the fallback here let a dead leg's report decide
  // where a token the live retry still holds actually is. `task_id` is
  // required on `assigned` even in a ledger this old (§4), and `lost` names
  // the task_id its own leg was opened under, so it can still be traced back
  // to b-1's `assigned` and told apart from b-2's — no ID gap left to fall
  // back through. The migration answer: an unlabeled `lost`/`reviewed` behind
  // a same-agent retry is no longer trusted as current; it is read as
  // superseded, the same as a labeled one naming a different leg.
  const unlabeled = custody.map(({ dispatch_id, ...entry }) => entry)
  assert.equal(currentEntry(unlabeled).task_id, 'b-2', 'the stale unlabeled lost was read as where the token is')
  assert.equal(currentEntry(unlabeled).event, 'assigned', 'the live retry is still assigned, not lost')
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
  { event: 'assigned', agent_id: 'b_e', task_id: `e-${n}`, dispatch_id: `ed-${n}` },
  { event: 'delivered', agent_id: 'b_e', task_id: `e-${n}`, terminal: 'done' },
  // task_id/dispatch_id here match this round's own `assigned` line, exactly
  // as production stamps it (loop-runner.mjs harvests both from the same
  // `last` leg) — not identityless. Three rounds by the SAME evaluator with
  // no leg identity at all is the Shape 1 ghost-review shape (dispatch-
  // facts.mjs `currentEntry`, retro-release-review round 2, 2026-08-04, F1),
  // not this test's budget-counting concern; giving each round its own
  // task_id keeps that ambiguity out of a fixture that is not about it.
  { event: 'reviewed', agent_id: 'b_e', verdict: 'reject', task_id: `e-${n}`, dispatch_id: `ed-${n}` },
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

// F4: `audit_requested` used to be enough, on its own, to make `awaitingAudit`
// stop asking for a route FOREVER — so a person's reply to a post-completion
// question had nowhere to go. `completed -> audit_requested -> questioned ->
// answered` contains `audit_requested`, and the old check read only "has
// audit_requested ever appeared since completed".
test('a post-completion question, once answered, is escalated again — not silently closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-audit-reopen-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const answered = itemsOf(['reopened', [...ROUTE_DONE,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1' },
      { event: 'questioned', agent_id: 'pm', questions: 'accept or concern?', reason: 'unstated verdict', question_id: 'q-1' },
      { event: 'answered', to_team: 'control', reason: 'concern — AC7 missing', question_id: 'q-1', actor: 'human:ada' },
    ]])
    const escalation = planEscalation(dir, graph, answered, [], teamOccupancy(graph, answered),
      { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation?.action, 'escalate', 'the answer had nowhere to go — the audit was never re-asked')
    assert.deepEqual(escalation.audits, ['reopened'])

    // Still parked, not re-escalated, while the question is genuinely open.
    const stillWaiting = itemsOf(['reopened', [...ROUTE_DONE,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1' },
      { event: 'questioned', agent_id: 'pm', questions: 'accept or concern?', reason: 'unstated verdict', question_id: 'q-1' },
    ]])
    assert.deepEqual(planEscalation(dir, graph, stillWaiting, [], teamOccupancy(graph, stillWaiting),
      { now: FIXED_NOW, stallSec: 1e9 })?.audits ?? [], [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// M3 (retro-release-review, 2026-08-04): `awaitingAudit` used to read the raw
// last event name. A mixed-version or manually accepted ledger — invalid
// under today's writer, exactly the shape the finding names — can carry a
// stale trailing leg outcome from an agent `currentEntry` recognizes as
// superseded (a different agent than whoever is currently `assigned`). The
// raw tail read that stray entry's own event name instead of `answered`,
// silently suppressing the re-escalation this function exists to guarantee.
test('M3 a stray leg outcome trailing an answered reply does not hide it from re-escalation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-audit-stray-'))
  try {
    const graph = graphOf(TWO_TEAMS)
    const items = itemsOf(['shipped', [...ROUTE_DONE,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'b-2-d' },
      { event: 'questioned', agent_id: 'pm', questions: 'accept?', reason: 'unstated verdict', question_id: 'q-1', resume_role: 'audit' },
      { event: 'answered', to_team: 'build', reason: 'accepted', question_id: 'q-1', actor: 'human:ada' },
      // The stray: `b_e` (the evaluator's leg, superseded by the later
      // `b_w1` assignment above) finally reports in, naming a task no
      // `assigned` opened. `currentEntry` has nothing to trace it to, the
      // agent differs from the current holder, so it is skipped.
      { event: 'delivered', agent_id: 'b_e', task_id: 'ghost-task', terminal: 'done', timed_out: false, evidence_present: true },
    ], { expectInvalid: true, why: 'assigned/delivered after completed — the mixed-version shape the finding names, not a history the current writer would produce' }])
    assert.equal(currentEntry(items.get('shipped').custody).event, 'answered',
      'currentEntry itself no longer skips the stray leg outcome')
    const escalation = planEscalation(dir, graph, items, [], teamOccupancy(graph, items),
      { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation?.action, 'escalate', 'the reply had nowhere to go — the stray outcome hid it from re-escalation')
    assert.deepEqual(escalation.audits, ['shipped'])
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

// GitHub #45 part 2 (§4.10): a leg that died at the transport must not spend
// the worker's attempt budget, and a leg the worker genuinely ran and failed
// must still spend it — in the same file, so the distinction cannot rot in
// one direction. `acp-companion.mjs` is the only writer of `delivered` and the
// only process present at the moment a leg fails, so the fact has to come from
// it: `work_observed: false` when nothing — no tool call, no message, no
// completed prompt turn — was ever seen before the leg died.
const NEVER_STARTED = (n) => ([
  { event: 'assigned', agent_id: 't_w1', task_id: `never-${n}` },
  // Same terminal a genuine transport failure uses today (`FAILED_IN_TEST`
  // above) — the distinguishing fact is `work_observed`, not the terminal
  // string, on purpose: a fix keyed off `terminal` would also exempt a leg
  // that failed AFTER real work happened to end on the same wire error.
  { event: 'delivered', agent_id: 't_w1', task_id: `never-${n}`, terminal: 'protocol-error', work_observed: false },
])
const RAN_AND_FAILED = (n) => ([
  { event: 'assigned', agent_id: 't_w1', task_id: `ran-${n}` },
  // Explicitly `true`, not merely omitted: this leg is the guard against
  // widening the exclusion by TERMINAL rather than by the explicit fact — a
  // `protocol-error` that the companion itself says carried real progress
  // must count exactly like `blocked` or `hard-timeout` already do.
  { event: 'delivered', agent_id: 't_w1', task_id: `ran-${n}`, terminal: 'protocol-error', work_observed: true },
])

test('three transport-failed legs do not spend the attempt budget; three real failures still do', () => {
  const graph = graphOf(TWO_TEAMS)
  const prefix = [
    { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
    { event: 'intake', agent_id: 't_d', verdict: 'accept' },
  ]

  // Three legs that never got a turn: still dispatching, not escalated — the
  // pool's attempt budget was never touched.
  const neverStarted = planDispatches(graph, itemsOf(['tok',
    [...prefix, ...NEVER_STARTED(1), ...NEVER_STARTED(2), ...NEVER_STARTED(3)]]),
  new Set())[0]
  assert.equal(neverStarted.action, 'dispatch', 'a leg that never began exhausted the attempt budget anyway')
  assert.equal(neverStarted.agent_id, 't_w1')

  // Three legs the worker actually ran and lost: MAX_ATTEMPTS is spent, same
  // as before this fix — the exclusion above must not have swallowed these too.
  const ranAndFailed = planDispatches(graph, itemsOf(['tok',
    [...prefix, ...RAN_AND_FAILED(1), ...RAN_AND_FAILED(2), ...RAN_AND_FAILED(3)]]),
  new Set())[0]
  assert.equal(ranAndFailed.action, 'escalate', 'three genuine worker failures stopped spending the attempt budget')
  assert.match(ranAndFailed.reason, /3 worker attempts/)
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

// ── a leg that no longer holds the token cannot say where it is ──────────────

test('a superseded review pass does not clear the pull gate for a leg that is still running', () => {
  // The other half of GitHub #30 (dispatch-facts.mjs:129): a review leg can be
  // killed and retried exactly like a worker leg can, and unlike a trailing
  // delivered/lost this one does not merely misdraw a card — a superseded
  // `reviewed pass` clears pull-controller.mjs's gate and hands the token to the
  // next team while the retried leg is still running. Same evaluator both times,
  // so agent_id cannot tell the legs apart; dispatch_id can.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'b-1-review', dispatch_id: 'r-1' },
    { at: '2026-07-27T09:03:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'b-1-review-2', dispatch_id: 'r-2' },
    // The dead review leg (r-1), telling the truth about itself after the retry
    // (r-2) had already replaced it.
    { at: '2026-07-27T09:04:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-1', reason: 'it does what the request asked for', dispatch_id: 'r-1' },
  ]
  const items = itemsOf(['tok', custody])

  assert.equal(currentEntry(custody).task_id, 'b-1-review-2', 'the stale pass was read as where the token is')
  assert.deepEqual(teamOccupancy(graph, items).held.get('build'), ['tok'], 'the stale pass moved the token off the seat still running it')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:05:00.000Z'), [], 'a superseded review pass still cleared the pull gate')
})

test('two legs by the same agent are told apart by which one a trailing delivered reports on', () => {
  // Hole (b) at dispatch-facts.mjs:129: two legs run by the SAME agent used to
  // be indistinguishable, because the only signal was agent_id and it reads the
  // same for both. `delivered` already carries dispatch_id for free — every
  // companion stamps its own on every line it writes (acp-companion.mjs:1622) —
  // so this one needed no writer change at all.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
    // Reassigned to the SAME agent before the first leg reported anything.
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'd-2' },
    // The first leg (d-1), reporting in late on a task nobody is waiting on.
    { at: '2026-07-27T09:02:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'd-1' },
  ]
  const items = itemsOf(['tok', custody])

  // Occupancy alone cannot answer this and it is worth saying why: both legs
  // belong to the same agent, so both map to the same team, and a team-granular
  // count reads identical whichever leg is picked. The assertion has to name the
  // leg, or it looks like coverage while testing nothing.
  assert.equal(currentEntry(custody).task_id, 'b-2', 'the stale delivered for b-1 was read as current')
  assert.equal(currentEntry(custody).event, 'assigned', 'the live leg is still assigned, not delivered')
  const occupancy = teamOccupancy(graph, items)
  assert.deepEqual(occupancy.held.get('build'), ['tok'], 'the token still belongs to build — it never left')
  assert.equal(occupancy.counts.get('build'), 1)
})

test('a killed leg reporting in late does not drag the token back to its team', () => {
  // GitHub #30, from the real run: a review leg was killed, a human sent the
  // token back to development, the runner dispatched a dev worker — and THEN
  // the dead review companion wrote its `delivered` on the way out. `at` is
  // stamped when a line is written, so that write is honestly the newest, and
  // sorting cannot tell it apart from a real move. Every reader that took the
  // newest event as the current position followed it back to review: the board
  // drew it there and the runner dispatched a second review worker into it.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'b_d', from_team: 'build', to_team: 'build' },
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'returned', to_team: 'test', refused_by: 'b_d', reason: 'sent back by hand' },
    { at: '2026-07-27T09:03:00.000Z', event: 'assigned', agent_id: 't_w1', task_id: 't-1', dispatch_id: 'd-2' },
    // The dead leg, arriving last and telling the truth about itself.
    { at: '2026-07-27T09:04:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  ]
  const items = itemsOf(['tok', custody, { expectInvalid: true, why: 'the out-of-order history IS the subject' }])

  const occupancy = teamOccupancy(graph, items)
  assert.deepEqual(occupancy.held.get('test'), ['tok'], 'the token left the team that reported late')
  assert.deepEqual(occupancy.held.get('build'), [], 'a superseded leg pulled the token back')
  assert.equal(occupancy.counts.get('build'), 0)

  // And the ordinary case still reads last-wins: the same agent finishing its
  // own live leg is not superseded by anything.
  const live = itemsOf(['ok', custody.slice(0, 2).concat([
    { at: '2026-07-27T09:05:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  ])])
  assert.deepEqual(teamOccupancy(graph, live).held.get('build'), ['ok'])
})

test('the runner dispatches into the team that holds the token, not the one that reported late', () => {
  // `nextStep` re-derives its own `last`, so a fix confined to `teamOccupancy`
  // would move the card and still send a worker to the wrong team.
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    { at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'b_d', from_team: 'build', to_team: 'build' },
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'returned', to_team: 'test', refused_by: 'b_d', reason: 'sent back by hand' },
    // The new leg. It is what makes the old one superseded: without a newer
    // `assigned` the previous worker still holds the token, and its `delivered`
    // is its own live leg finishing — which is why this line is here and not a
    // detail of the fixture.
    { at: '2026-07-27T09:03:00.000Z', event: 'assigned', agent_id: 't_w1', task_id: 't-1', dispatch_id: 'd-2' },
    { at: '2026-07-27T09:04:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  ], { expectInvalid: true, why: 'the out-of-order history IS the subject' }])

  const plans = planDispatches(graph, items, new Set())
  const plan = plans.find((entry) => entry.work_item === 'tok')
  assert.ok(plan, `the token fell out of planning entirely: ${JSON.stringify(plans)}`)
  assert.equal(plan.team, 'test', 'the runner followed the leg that had already been superseded')
  // And it is looking at the NEW leg, not the old one's outcome. `nextStep`
  // picks its own entry, so a fix confined to occupancy would place the card in
  // `test` and still act on `delivered` — dispatching an evaluator for a leg
  // that belongs to a team the token has left.
  assert.notEqual(plan.role, 'evaluator', `the runner acted on the superseded leg: ${JSON.stringify(plan)}`)
  assert.equal(plan.agent_id ?? plan.agentId ?? 't_w1', 't_w1')
})

// ── retro-release-review, 2026-08-04: F1 and F2 ─────────────────────────────

test('an unlabeled stale review does not clear the pull gate for a live retry (F1)', () => {
  // The exact mixed-version shape from the review: the same evaluator retried
  // (agent_id cannot tell the legs apart), and the dead leg's `reviewed pass`
  // arrives with no dispatch_id at all — the shape an old runner wrote before
  // `reviewed` carried one, or the generic writer produces today. Without the
  // task_id fallback this read as current and cleared pull-controller's gate
  // while r-2 was still running.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    { at: '2026-07-27T09:03:00.000Z', event: 'delivered', agent_id: 'b_e', task_id: 'r-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'r-1' },
    // r-1 was killed and retried before it reported anything.
    { at: '2026-07-27T09:04:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-2', dispatch_id: 'r-2' },
    // r-1's late last word: names the task it opened under (r-1) but carries
    // no dispatch_id — exactly what an old harvester wrote, or what the
    // sanctioned generic writer still accepts today.
    { at: '2026-07-27T09:05:00.000Z', event: 'reviewed', agent_id: 'b_e', task_id: 'r-1', verdict: 'pass', reviewed_task: 'b-1', reason: 'it does what the request asked for' },
  ]
  const items = itemsOf(['tok', custody])

  assert.equal(currentEntry(custody).task_id, 'r-2', 'the stale unlabeled pass was read as where the token is')
  assert.equal(currentEntry(custody).event, 'assigned', 'the live retry is still assigned, not reviewed')
  assert.deepEqual(teamOccupancy(graph, items).held.get('build'), ['tok'],
    'the unlabeled stale pass moved the token off the seat still running it')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:06:00.000Z'), [],
    'an unlabeled stale review pass cleared the pull gate')
})

test('a dispatch_id match is not proof once the ledger contradicts what it was assigned to (F2)', () => {
  // The exact fixture from the review: two live assignments, then a
  // `delivered` that reuses the SECOND leg's dispatch_id while naming the
  // FIRST leg's agent and task. dispatch_id matching alone (currentEntry)
  // would read this as w2's own outcome; nothing before this checked that the
  // ID actually belonged to the (agent_id, task_id) pair claiming it.
  const lines = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w2', task_id: 't2', dispatch_id: 'd-2' },
    {
      at: '2026-07-27T09:02:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature',
      agent_id: 'w1', task_id: 't1', dispatch_id: 'd-2', terminal: 'done', timed_out: false, evidence_present: true,
    },
  ].map((entry) => JSON.stringify(entry))

  const result = validateLedger(lines)
  assert.equal(result.ok, false, 'a dispatch_id borrowed from a different leg validated clean')
  assert.ok(result.problems.some((problem) => problem.code === 'dispatch_id_agent_mismatch'),
    `expected a dispatch_id_agent_mismatch problem, got ${JSON.stringify(result.problems)}`)
  assert.ok(result.problems.some((problem) => problem.code === 'dispatch_id_task_mismatch'),
    `expected a dispatch_id_task_mismatch problem, got ${JSON.stringify(result.problems)}`)

  // The binding is per-ID, not blanket suspicion of reuse: an outcome that
  // correctly reports its OWN leg's dispatch_id still validates.
  const consistent = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w2', task_id: 't2', dispatch_id: 'd-2' },
    {
      at: '2026-07-27T09:02:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature',
      agent_id: 'w2', task_id: 't2', dispatch_id: 'd-2', terminal: 'done', timed_out: false, evidence_present: true,
    },
  ].map((entry) => JSON.stringify(entry))
  assert.equal(validateLedger(consistent).ok, true, JSON.stringify(validateLedger(consistent).problems))
})

// B5, 2026-08-04: the third of three places this froze — the writer
// (`tests/ledger.test.mjs`), the pull controller (above), and here, the
// runner's own dispatch gate at `loop-runner.mjs`'s `tick`. Before this fix
// `tick` read `validateLedgerFile` raw and refused to dispatch onto ANY
// problem, tolerated or not — so a token could be answered and pulled
// forward but never get a fresh leg spawned onto it again.
test('the runner still dispatches onto a legacy ledger with only a tolerated defect (B5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-legacy-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'build.md'), '# standing brief\n')

    // Same legacy shape as the ledger-writer and pull-controller B5 tests: an
    // `opened` written by an agent actor, from before ADR 0002 required a
    // human one. Direct `writeFileSync`, not the `ledger()` fixture helper —
    // that helper's gate would (correctly) refuse this under CURRENT rules;
    // it is exactly what the system produced under the old ones.
    const legacy = [
      { at: '2026-07-27T08:00:00.000Z', event: 'opened', work_item: 'tok', workflow: 'feature', agent_id: 'b_d', to_team: 'build', reason: 'requested before ADR 0002', actor: 'agent:b_d' },
      { at: '2026-07-27T08:00:01.000Z', event: 'intake', work_item: 'tok', workflow: 'feature', agent_id: 'b_d', verdict: 'accept', reason: 'buildable' },
    ]
    writeFileSync(join(store, 'work-items', 'tok.jsonl'),
      `${legacy.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const spawned = []
    const stubSpawn = (repo, args) => { spawned.push(args); return 'stub-task' }
    tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnLeg: stubSpawn })

    const workerLeg = spawned.find((args) => args.role === 'worker')
    assert.ok(workerLeg, `the runner refused to dispatch onto a legacy ledger: ${JSON.stringify(spawned)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── H2 — admission writes the token's own request, not just a ledger reason ─
// (retro-release-review, 2026-08-04): `composeBrief` (loop-runner.mjs) reads
// `.tmux-teams/work-items/<token>.md` as "the token's own request", but
// `admitWorkItem` stored `request.reason` in the ledger and stopped there.
// Following the documented admit path alone sent every later seat a token
// with no request to judge unless someone independently authored the file.
//
// `controller_team` is derived from the head of every route (workflow-
// graph.mjs) — the team whose only worker IS `outer_controller_id` — so
// admission needs a graph that actually declares one; TWO_TEAMS does not.
const WITH_CONTROLLER = {
  ...TWO_TEAMS,
  teams: [
    { team_id: 'control', name: 'Control', dispatcher_id: 'control_d', worker_ids: ['pm'], evaluator_id: 'control_e', models: MODELS },
    ...TWO_TEAMS.teams,
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'test'] }],
}

test('H2 admission writes the token\'s own request file from its reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admit-request-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(WITH_CONTROLLER))
    const result = admitWorkItem(dir, {
      work_item: 'tok', workflow: 'feature', reason: 'a customer asked for CSV export',
    }, { actor: 'human:ada' })
    assert.equal(result.ok, true, result.detail)
    const requestPath = join(store, 'work-items', 'tok.md')
    assert.equal(existsSync(requestPath), true, 'admission recorded a reason but wrote no request file')
    assert.match(readFileSync(requestPath, 'utf8'), /a customer asked for CSV export/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('H2 admission does not overwrite a request file an operator already authored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admit-request-existing-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(WITH_CONTROLLER))
    writeFileSync(join(store, 'work-items', 'tok.md'), '# The real request\n\nMuch more detail than the ledger reason line.\n')
    const result = admitWorkItem(dir, {
      work_item: 'tok', workflow: 'feature', reason: 'short version',
    }, { actor: 'human:ada' })
    assert.equal(result.ok, true, result.detail)
    assert.match(readFileSync(join(store, 'work-items', 'tok.md'), 'utf8'), /Much more detail/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('H2 a refused admission (controller at WIP) leaves no orphaned request file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admit-request-refused-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    // TWO_TEAMS declares no controller_team, so admitWorkItem fails before it
    // ever reaches the ledger write — exactly the early-refusal path the fix
    // must not write a request file behind.
    const result = admitWorkItem(dir, {
      work_item: 'tok', workflow: 'feature', reason: 'irrelevant — this must not land on disk',
    }, { actor: 'human:ada' })
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(store, 'work-items', 'tok.md')), false,
      'a refused admission left a request file for a token that was never opened')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── H1 — an answered question routes back to the seat that asked ────────────
// (retro-release-review, 2026-08-04): `nextStep` used to hardcode
// `want('dispatcher')` for every `answered` on the false assumption that only
// a dispatcher ever asks. `harvestEvent` stamps `resume_role` with the actual
// asking seat (dispatcher, evaluator, audit, outer) — an evaluator's question,
// once answered, was routed to this team's dispatcher instead of back to the
// evaluator that asked it, paying for a leg with nothing to act on.

test('H1 an answered question asked by the evaluator dispatches the evaluator, not the dispatcher', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'b-1-d' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1-d' },
    {
      event: 'questioned', agent_id: 'b_e', questions: 'pass or fail?', reason: 'unstated verdict',
      question_id: 'q-1', resume_role: 'evaluator',
    },
    { event: 'answered', to_team: 'build', reason: 'pass — it does what was asked', question_id: 'q-1', actor: 'human:ada' },
  ]])
  const plan = planDispatches(graph, items, new Set(), { now: FIXED_NOW })
    .find((entry) => entry.work_item === 'tok')
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.role, 'evaluator', `the reply went to ${plan.role || plan.action}, not the evaluator that asked`)
  assert.equal(plan.agent_id, 'b_e')
})

test('H1 an answered question with no resume_role (a legacy questioned line) keeps routing to the dispatcher', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    {
      event: 'questioned', agent_id: 'b_d', questions: 'which workflow?', reason: 'ambiguous request',
      question_id: 'q-1',
    },
    { event: 'answered', to_team: 'build', reason: 'use the feature workflow', question_id: 'q-1', actor: 'human:ada' },
  ]])
  const plan = planDispatches(graph, items, new Set(), { now: FIXED_NOW })
    .find((entry) => entry.work_item === 'tok')
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.role, 'dispatcher')
  assert.equal(plan.agent_id, 'b_d')
})

test('H1 an answered question asked by the outer controller does not also dispatch this team\'s own seat', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    {
      event: 'questioned', agent_id: 'pm', questions: 'accept the finding?', reason: 'unstated verdict',
      question_id: 'q-1', resume_role: 'outer',
    },
    { event: 'answered', to_team: 'build', reason: 'accepted', question_id: 'q-1', actor: 'human:ada' },
  ]])
  const plan = planDispatches(graph, items, new Set(), { now: FIXED_NOW })
    .find((entry) => entry.work_item === 'tok')
  assert.notEqual(plan.action, 'dispatch', 'this team dispatched a seat for a reply that was never asked as its own')
  assert.match(plan.reason, /outer controller/)
})

// qwen r3 #3 (retro-release-review, 2026-08-04): a pre-`completed` `escalated`
// (MAX_ATTEMPTS or the door-refusal ceiling) that reaches the outer controller
// and comes back `questioned(resume_role:'outer')` -> `answered` used to return
// `{action:'held'}` here — and `held` is not in `planEscalation`'s trigger set
// (`plans.filter(action === 'escalate')`), so the token was parked for ever.
// `awaitingAudit`, the mechanism that rescues the sibling `resume_role:'audit'`
// case, requires a `completed` this item never has. The fix must produce a
// plan `planEscalation` actually re-reads — proven end to end below, not just
// "not dispatch" (the pre-fix `held` also satisfied that weaker assertion).
test('H1 an answered outer-controller reply re-escalates instead of wedging the token for ever', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    {
      event: 'questioned', agent_id: 'pm', questions: 'accept the finding?', reason: 'unstated verdict',
      question_id: 'q-1', resume_role: 'outer',
    },
    { event: 'answered', to_team: 'build', reason: 'accepted', question_id: 'q-1', actor: 'human:ada' },
  ]])
  const plan = planDispatches(graph, items, new Set(), { now: FIXED_NOW })
    .find((entry) => entry.work_item === 'tok')
  assert.equal(plan.action, 'escalate', 'a `held` plan has no exit — planEscalation never reads it again')

  // The real proof: run the plan through `planEscalation` and confirm the
  // outer controller is actually asked again about THIS token, the way a
  // fresh `escalated` line already is.
  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-outer-resume-'))
  try {
    const occupancy = teamOccupancy(graph, items)
    const escalation = planEscalation(dir, graph, items, [plan], occupancy, { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation.action, 'escalate', 'the wedged plan never reached planEscalation\'s trigger set')
    assert.equal(escalation.parked, 'tok', 'the outer controller must be asked about this token again')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// r4-codex (retro-release-review, 2026-08-04): "reachable custody can still
// wedge" — the test above only ever proved ONE questioned(outer) -> answered
// cycle reaches `planEscalation`'s trigger set. It never retained a prior
// `pm-notes/latest.md`, so it could not see the unchanged-trigger brake at
// all. Built here: the FIRST cycle is read and its identity is the one really
// written to disk by the caller (loop-runner.mjs:1600), then a SECOND,
// independent questioned(outer)->answered cycle on the SAME token is checked
// against it. `plan.reason` for this branch is a fixed string — identical on
// every occurrence for the same work_item — so before the anchor fix the
// second reply rendered the exact identity already stored and the brake read
// it as `unchanged`: a reply that genuinely moved the ledger, permanently
// unread.
test('H4 a second questioned(outer) -> answered cycle on the same token does not collide with the identity already read', () => {
  const graph = graphOf(TWO_TEAMS)
  // `ledger()`'s own default anchors the LAST line of whatever array it is
  // given at exactly `FIXED_NOW` (deliberately, for the zombie-clock tests) —
  // which would make `firstCycle`'s last `at` and `secondCycle`'s last `at`
  // identical no matter how far apart the two cycles really are. Stamped
  // explicitly here so the two `answered` lines carry the genuinely different
  // recorded times a real second round-trip would produce.
  const at = (minutes) => new Date(FIXED_NOW + minutes * 60_000).toISOString()
  const firstCycle = itemsOf(['tok', [
    {
      event: 'questioned', agent_id: 'pm', questions: 'accept the finding?', reason: 'unstated verdict',
      question_id: 'q-1', resume_role: 'outer', at: at(0),
    },
    { event: 'answered', to_team: 'build', reason: 'accepted', question_id: 'q-1', actor: 'human:ada', at: at(1) },
  ]])
  const secondCycle = itemsOf(['tok', [
    {
      event: 'questioned', agent_id: 'pm', questions: 'accept the finding?', reason: 'unstated verdict',
      question_id: 'q-1', resume_role: 'outer', at: at(0),
    },
    { event: 'answered', to_team: 'build', reason: 'accepted', question_id: 'q-1', actor: 'human:ada', at: at(1) },
    {
      event: 'questioned', agent_id: 'pm', questions: 'accept the finding, a second time?', reason: 'unstated verdict',
      question_id: 'q-2', resume_role: 'outer', at: at(2),
    },
    { event: 'answered', to_team: 'build', reason: 'accepted again', question_id: 'q-2', actor: 'human:ada', at: at(3) },
  ]])

  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-outer-resume-twice-'))
  try {
    const notesDir = join(dir, '.tmux-teams', 'pm-notes')
    mkdirSync(notesDir, { recursive: true })

    // Tick 1: the first reply reaches the controller. This is what the
    // caller actually persists (loop-runner.mjs:1600) once it dispatches.
    const plan1 = planDispatches(graph, firstCycle, new Set(), { now: FIXED_NOW })
      .find((entry) => entry.work_item === 'tok')
    const escalation1 = planEscalation(dir, graph, firstCycle, [plan1], teamOccupancy(graph, firstCycle),
      { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation1.action, 'escalate', 'the first reply must reach the controller')
    writeFileSync(join(notesDir, 'latest.md'), `${new Date(FIXED_NOW).toISOString()}\n${escalation1.identity}\n`)

    // Nothing has changed since: calling again on the SAME state must still
    // read `unchanged` — the brake's actual job, and proof this fix does not
    // just always re-escalate.
    const stillNothing = planEscalation(dir, graph, firstCycle, [plan1], teamOccupancy(graph, firstCycle),
      { now: FIXED_NOW + 1000, stallSec: 1e9, cooldownSec: 0 })
    assert.equal(stillNothing.action, 'unchanged', 'a board with nothing new recorded must still be suppressed')

    // Tick 2: the SAME work item asked outer again and a person answered
    // again — new bytes are on the ledger. `plan.reason` renders identically
    // both times; only the anchor tells the two apart.
    const plan2 = planDispatches(graph, secondCycle, new Set(), { now: FIXED_NOW + 2000 })
      .find((entry) => entry.work_item === 'tok')
    assert.equal(plan2.action, 'escalate')
    const escalation2 = planEscalation(dir, graph, secondCycle, [plan2], teamOccupancy(graph, secondCycle),
      { now: FIXED_NOW + 2000, stallSec: 1e9, cooldownSec: 0 })
    assert.equal(escalation2.action, 'escalate', 'a second, later reply must not collide with the first one\'s identity')
    assert.equal(escalation2.parked, 'tok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The sibling wedge: `awaitingAudit` re-surfaces a token whose state is
// `answered` after a post-`completed` audit question gets a reply (§5). Its
// rendered text is a function of work_item/workflow/failed-leg-count alone,
// so a second audit-question reply on the same token collided with the
// identity stored from the FIRST `completed` trigger the same way.
test('H4 a second audit questioned -> answered cycle on a completed token does not collide with the identity already read', () => {
  const graph = graphOf(TWO_TEAMS)
  const justCompleted = itemsOf(['tok', FINISHED])
  // Same `ledger()` anchoring pitfall as the outer test above: without an
  // explicit `at`, the LAST line of `answeredAudit` would land on exactly the
  // same `FIXED_NOW` as `justCompleted`'s last line, and the reproduction
  // would not tell "the same instant" apart from "a real later reply".
  const at = (minutes) => new Date(FIXED_NOW + minutes * 60_000).toISOString()
  const answeredAudit = itemsOf(['tok', [
    ...FINISHED,
    { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1', reason: 'route finished — read the delivery as a whole', at: at(1) },
    {
      event: 'questioned', agent_id: 'pm', questions: 'accept or concern?',
      reason: 'the audit stated no verdict this seat can use', question_id: 'q-1', resume_role: 'audit', at: at(2),
    },
    { event: 'answered', to_team: 'test', reason: 'concern — rework the edge case', question_id: 'q-1', actor: 'human:ada', at: at(3) },
  ]])

  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-audit-resume-twice-'))
  try {
    const notesDir = join(dir, '.tmux-teams', 'pm-notes')
    mkdirSync(notesDir, { recursive: true })

    const occupancy1 = teamOccupancy(graph, justCompleted)
    const escalation1 = planEscalation(dir, graph, justCompleted, [], occupancy1, { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation1.action, 'escalate', 'a freshly completed, unread token must reach the controller')
    assert.deepEqual(escalation1.audits, ['tok'])
    writeFileSync(join(notesDir, 'latest.md'), `${new Date(FIXED_NOW).toISOString()}\n${escalation1.identity}\n`)

    const occupancy2 = teamOccupancy(graph, answeredAudit)
    const escalation2 = planEscalation(dir, graph, answeredAudit, [], occupancy2,
      { now: FIXED_NOW + 2000, stallSec: 1e9, cooldownSec: 0 })
    assert.equal(escalation2.action, 'escalate', 'the audit reply must not collide with the completion trigger\'s identity')
    assert.deepEqual(escalation2.audits, ['tok'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// r4-codex: "the PM brief ... omits the question and answer" and "a
// front-door dispatcher reproduction likewise reran the correct dispatcher
// with the original ambiguous request but without the human answer." Proven
// on both delivery surfaces: the outer controller's own brief (`ask`/`board`,
// built by `planEscalation`) and `composeBrief`, which every other resumed
// seat (worker, evaluator, front-door dispatcher) reads.
test('H4 the outer controller\'s brief carries what was asked and what the person answered', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    {
      event: 'questioned', agent_id: 'pm', questions: 'Resume or abandon?', reason: 'unstated verdict',
      question_id: 'q-1', resume_role: 'outer',
    },
    { event: 'answered', to_team: 'build', reason: 'Resume; dependency fixed', question_id: 'q-1', actor: 'human:ada' },
  ]])
  const plan = planDispatches(graph, items, new Set(), { now: FIXED_NOW }).find((entry) => entry.work_item === 'tok')
  const dir = mkdtempSync(join(tmpdir(), 'loop-pm-outer-brief-'))
  try {
    const escalation = planEscalation(dir, graph, items, [plan], teamOccupancy(graph, items), { now: FIXED_NOW, stallSec: 1e9 })
    assert.equal(escalation.action, 'escalate')
    assert.match(escalation.brief, /Resume or abandon\?/, 'the brief never said what was asked')
    assert.match(escalation.brief, /Resume; dependency fixed/, 'the brief never said what the person answered')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// codex's own reproduction: "A front-door dispatcher reproduction likewise
// reran the correct dispatcher with the original ambiguous request but
// without the human answer. The seat can ask the same question again." Built
// on the reachable path — `resume_role` unset (legacy/default) resumes the
// dispatcher (§5), and `build` is TWO_TEAMS' `controller_team` (derived from
// the head of its one route), so this is the front door itself.
test('H4 composeBrief carries what was asked and what the person answered, for a seat resumed after answered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-compose-brief-answer-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'build.md'), '# Build team standing brief\n')
    writeFileSync(join(store, 'work-items', 'tok.jsonl'), `${ledger('tok', [
      { event: 'opened', agent_id: 'b_d', to_team: 'build', reason: 'front door request', actor: 'human:ada' },
      {
        event: 'questioned', agent_id: 'b_d', questions: 'what should the worker build?',
        reason: 'the request is not workable yet', question_id: 'q-1',
      },
      { event: 'answered', to_team: 'build', reason: 'Build the CSV export first.', question_id: 'q-1', actor: 'human:ada' },
    ]).map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const scratch = join(dir, 'scratch')
    const result = tick(dir, { apply: false, scratchDir: scratch })
    assert.equal(result.ok, true, result.reason)
    const brief = readFileSync(join(scratch, 'brief-tok-build-dispatcher.md'), 'utf8')
    assert.match(brief, /what should the worker build\?/, 'the resumed dispatcher was never told what was asked')
    assert.match(brief, /Build the CSV export first\./, 'the resumed dispatcher was never told what the person answered')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── GitHub #32: per-seat reasoning effort reaches the spawned process ────────

test('declaredEffort reads the resolved seat, and effortEnv requests it the way modelEnv requests a model', () => {
  const graph = graphOf({
    ...TWO_TEAMS,
    outer_controller_effort: 'max',
    teams: [
      { ...TWO_TEAMS.teams[0], seats: { b_w1: { effort: 'xhigh' } } },
      TWO_TEAMS.teams[1],
    ],
  })
  assert.equal(declaredEffort(graph, 'build', 'b_w1'), 'xhigh')
  // No seat override on this one, and no role-level default exists to fall
  // back to (unlike model/adapter, effort has no `models`/`adapters`-style
  // per-role block) — so an unoverridden seat reads as unset.
  assert.equal(declaredEffort(graph, 'test', 't_w1'), '')
  // The outer controller reads its own top-level field, exactly like its model.
  assert.equal(declaredEffort(graph, null, 'pm'), 'max')

  assert.deepEqual(effortEnv('xhigh'), { ACP_REASONING_EFFORT: 'xhigh', ACP_EXPECT_REASONING_EFFORT: 'xhigh' })
  // Unset requests nothing. There is no sentinel to filter the way modelEnv
  // filters INHERIT_ACCOUNT_DEFAULT, because omission already means that.
  assert.deepEqual(effortEnv(''), {})
  assert.deepEqual(effortEnv(undefined), {})
})

test('a dispatched worker leg carries its seat effort into the spawned process env — the #32 bug pattern (declared, validated, dropped at dispatch) does not recur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-effort-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    const graph = {
      ...TWO_TEAMS,
      teams: [
        { ...TWO_TEAMS.teams[0], seats: { b_w1: { effort: 'max' } } },
        TWO_TEAMS.teams[1],
      ],
    }
    writeFileSync(join(store, 'graph.json'), JSON.stringify(graph))
    writeFileSync(join(store, 'team-briefs', 'build.md'), '# standing brief\n')
    writeFileSync(join(store, 'work-items', 'tok.jsonl'),
      `${ledger('tok', [{ event: 'opened', agent_id: 'b_d', to_team: 'build' }])
        .map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    // Deliberately do NOT stub `spawnLeg` — leaving it at its default
    // (`dispatch`) is the whole point. `spawnLeg: stubSpawn` replaces
    // `dispatch` wholesale, so `dispatch`'s own env object (where
    // `...effortEnv(effort)` actually lives, loop-runner.mjs) never runs and
    // this test cannot see it get dropped. `spawnFn` is the narrower seam:
    // it only replaces the OS-level `child_process.spawn` call inside the
    // real `dispatch`, so every line of `dispatch`'s env construction runs
    // for real and lands in `captured`.
    const captured = []
    const spawnFn = (cmd, args, options) => {
      captured.push({ cmd, args, env: options.env })
      return { unref() {} }
    }
    // `opened` dispatches the dispatcher first (intake); run twice so the
    // second tick reaches the worker leg this test is actually about, exactly
    // like the real loop's own next tick would.
    tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnFn })
    writeFileSync(join(store, 'work-items', 'tok.jsonl'),
      `${ledger('tok', [
        { event: 'opened', agent_id: 'b_d', to_team: 'build' },
        { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
      ]).map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnFn })

    const workerLeg = captured.find((call) => call.env.ACP_AGENT_ID === 'b_w1')
    assert.ok(workerLeg, `no worker leg was spawned: ${JSON.stringify(captured.map((c) => c.env.ACP_AGENT_ID))}`)
    // This is the actual child env `dispatch` built and would have handed to
    // `spawn()` for a real ACP process — not a call to `effortEnv` from the
    // test itself. Deleting `...effortEnv(effort)` from `dispatch`'s env
    // object turns this red; calling `effortEnv` a second time here would not.
    assert.equal(workerLeg.env.ACP_REASONING_EFFORT, 'max', 'the seat\'s declared effort did not reach the real child env')
    assert.equal(workerLeg.env.ACP_EXPECT_REASONING_EFFORT, 'max', 'the receipt-holding pair did not reach the real child env')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── GitHub #32: a dispatcher's worker hint, and its limits ──────────────────
//
// `want()`'s default is "first free seat in declared order" (§3.2.1). A hint
// is an override of THAT choice, not a new source of truth the loop trusts
// blindly — naming a worker that does not exist on this team is escalated,
// and naming one that is real but busy waits for that specific seat rather
// than silently substituting a different free one.

const TWO_BUILD_WORKERS = {
  ...TWO_TEAMS,
  teams: [
    { ...TWO_TEAMS.teams[0], worker_ids: ['b_w1', 'b_w2'] },
    TWO_TEAMS.teams[1],
  ],
}

const hintedIntake = (hint) => [
  { event: 'pulled', agent_id: 'b_d', from_team: 'test', to_team: 'build' },
  { event: 'intake', agent_id: 'b_d', verdict: 'accept', worker_hint: hint },
]

test('a worker_hint on intake overrides declared order, not just breaks its tie', () => {
  const graph = graphOf(TWO_BUILD_WORKERS)
  // Declared order alone would pick b_w1 — see the no-hint case below.
  const plan = planFor(graph, hintedIntake('b_w2'))
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w2')
})

test('no worker_hint keeps the existing first-free-in-declared-order default', () => {
  const graph = graphOf(TWO_BUILD_WORKERS)
  const plan = planFor(graph, hintedIntake(null))
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w1')
})

test('a worker_hint naming a seat that is not on this team is escalated, not silently ignored', () => {
  const graph = graphOf(TWO_BUILD_WORKERS)
  const plan = planFor(graph, hintedIntake('nonexistent_worker'))
  assert.equal(plan.action, 'escalate')
  assert.match(plan.reason, /nonexistent_worker/)
  assert.match(plan.reason, /the hint cannot be honored/)
})

test('a worker_hint naming a busy seat waits for that seat, and does not fall through to a different free one', () => {
  const graph = graphOf(TWO_BUILD_WORKERS)
  // b_w2 is named and busy; b_w1 is free and NOT named.
  const plan = planFor(graph, hintedIntake('b_w2'), new Set(['b_w2']))
  assert.equal(plan.action, 'wait')
  assert.match(plan.reason, /b_w2/)
  assert.notEqual(plan.agent_id, 'b_w1')
})

test('rework paths (returned, resumed) never read a worker_hint even if one is present on the line', () => {
  const graph = graphOf(TWO_BUILD_WORKERS)
  // Neither event carries `worker_hint` in real ledgers (§4: only `intake`
  // does) — this proves the CODE ignores it there regardless, rather than
  // relying on the writer never producing the shape.
  const returned = planFor(graph, [
    { event: 'pulled', agent_id: 'b_d', from_team: 'test', to_team: 'build' },
    { event: 'returned', to_team: 'build', refused_by: 'x_d', worker_hint: 'b_w2' },
  ])
  assert.equal(returned.action, 'dispatch')
  assert.equal(returned.agent_id, 'b_w1', 'a returned token honoured a worker_hint that only intake is allowed to carry')

  const resumed = planFor(graph, [
    { event: 'escalated', agent_id: 'pm', to_team: 'build', task_id: 'controller-task' },
    { event: 'resumed', agent_id: 'pm', to_team: 'build', grant: 3, worker_hint: 'b_w2' },
  ])
  assert.equal(resumed.action, 'dispatch')
  assert.equal(resumed.agent_id, 'b_w1', 'a resumed token honoured a worker_hint that only intake is allowed to carry')
})

test('an accepted intake outbox naming a WORKER line is harvested into worker_hint on the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-hint-harvest-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 'b-intake'),
      'Checked the handoff — it has what this team needs.\n\nWORKER: b_w2\nVERDICT: accept\nREASON: complete\n')
    const graph = graphOf(TWO_BUILD_WORKERS)
    const items = itemsOf(['tok', [
      { event: 'pulled', agent_id: 'b_d', from_team: 'test', to_team: 'build' },
      { event: 'assigned', agent_id: 'b_d', task_id: 'b-intake' },
      { event: 'delivered', agent_id: 'b_d', task_id: 'b-intake', terminal: 'done' },
    ]])
    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), '2026-07-27T09:00:00.000Z')
    assert.equal(event.event, 'intake')
    assert.equal(event.worker_hint, 'b_w2')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an accepted intake outbox with no WORKER line harvests worker_hint as null, not undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-hint-harvest-none-'))
  try {
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(dir, '.mailbox-out', 'b-intake'),
      'Checked the handoff — it has what this team needs.\n\nVERDICT: accept\nREASON: complete\n')
    const graph = graphOf(TWO_BUILD_WORKERS)
    const items = itemsOf(['tok', [
      { event: 'pulled', agent_id: 'b_d', from_team: 'test', to_team: 'build' },
      { event: 'assigned', agent_id: 'b_d', task_id: 'b-intake' },
      { event: 'delivered', agent_id: 'b_d', task_id: 'b-intake', terminal: 'done' },
    ]])
    const [event] = applyHarvest(dir, graph, planHarvest(graph, items), '2026-07-27T09:00:00.000Z')
    assert.equal(event.event, 'intake')
    assert.equal(event.worker_hint, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readWorkerHint reads the last WORKER line and ignores a malformed one', () => {
  assert.equal(readWorkerHint('WORKER: b_w2\n'), 'b_w2')
  // Last one wins, matching readVerdict's own restatement tolerance.
  assert.equal(readWorkerHint('WORKER: b_w1\nsome prose\nWORKER: b_w2\n'), 'b_w2')
  assert.equal(readWorkerHint('no worker line here\n'), null)
  // Not shaped like an agent id (a space) — read as no hint, not an error; see
  // the comment on WORKER_HINT_RE for why that tolerance is deliberate.
  assert.equal(readWorkerHint('WORKER: not a valid id\n'), null)
  assert.equal(readWorkerHint(null), null)
  assert.equal(readWorkerHint(undefined), null)
})

// ── retro-release-review, 2026-08-04: B4, B3, B2 ────────────────────────────

test('a truly identityless reviewed pass — no task_id, no dispatch_id — still does not clear the pull gate for a live retry (B4)', () => {
  // The exact shape the F1 test above does NOT cover, despite its title: F1's
  // `reviewed` carries `task_id: 'r-1'`, which routes it through the task_id
  // branch. This one carries neither field at all — the shorthand the
  // contract §6 says the system still writes — and the SAME evaluator was
  // retried, so agent_id reads identical on both legs too. Nothing here can
  // name which leg the review belongs to.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    { at: '2026-07-27T09:03:00.000Z', event: 'delivered', agent_id: 'b_e', task_id: 'r-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'r-1' },
    // r-1 killed and retried, same evaluator, before it reported anything.
    { at: '2026-07-27T09:04:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-2', dispatch_id: 'r-2' },
    // r-1's late last word: no task_id, no dispatch_id — nothing to trace it
    // back to its own leg with at all.
    { at: '2026-07-27T09:05:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-1', reason: 'it does what the request asked for' },
  ]
  const items = itemsOf(['tok', custody])

  assert.equal(currentEntry(custody).task_id, 'r-2', 'the identityless stale pass was read as where the token is')
  assert.equal(currentEntry(custody).event, 'assigned', 'the live retry is still assigned, not reviewed')
  assert.deepEqual(teamOccupancy(graph, items).held.get('build'), ['tok'],
    'the identityless stale pass moved the token off the seat still running it')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:06:00.000Z'), [],
    'a truly identityless reviewed pass cleared the pull gate')

  // And the legitimate case this must not regress: an evaluator assigned
  // exactly ONCE, whose `reviewed` never carried an identity field at all —
  // "the shorthand this system still writes when a review rides straight on
  // a worker's delivery, with no `assigned` of the evaluator's own to look
  // up" (dispatch-facts.mjs). Nothing retried it, so it is the only leg it
  // could possibly be evidence about, and it still clears the gate.
  const singleLeg = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-1', reason: 'it does what the request asked for' },
  ]
  const singleItems = itemsOf(['ok', singleLeg])
  assert.equal(currentEntry(singleLeg).event, 'reviewed', 'a never-retried identityless review was wrongly treated as UNKNOWN')
  assert.deepEqual(planPulls(graph, singleItems, '2026-07-27T09:06:00.000Z').map((d) => d.action), ['pull'],
    'a never-retried identityless review did not clear the pull gate')
})

test('a delivered from an IMPOSTER agent is not trusted merely for naming the holder\'s task_id (B3)', () => {
  // The exact fixture from the review: two live assignments, then a
  // `delivered` that names the SECOND leg's task_id (so it resolves to the
  // holder's own assigned line) but reports the FIRST leg's agent. task_id
  // matching the holder's leg is necessary but was not sufficient — nothing
  // bound task_id to an agent the way dispatch_id is bound at write time, so
  // this used to be trusted, and the old agent_id-only fallback it replaced
  // would have correctly refused it.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'assigned', agent_id: 'b_w2', task_id: 't-2' },
    // w1, the FIRST leg's agent, reporting a delivery under t-2 — the SECOND
    // leg's task_id, and the one that resolves to the current holder (w2).
    { at: '2026-07-27T09:02:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-2', terminal: 'done', timed_out: false, evidence_present: true },
  ]

  assert.equal(currentEntry(custody).event, 'assigned', 'an impersonating delivered was trusted for matching the holder\'s task_id')
  assert.equal(currentEntry(custody).agent_id, 'b_w2', 'the real holder was not read as still holding the token')

  // And the case task_id was added FOR must not regress: the SAME agent,
  // correctly reporting its own current leg's task_id, is still trusted.
  const legitimate = custody.slice(0, 2).concat([
    { at: '2026-07-27T09:02:00.000Z', event: 'delivered', agent_id: 'b_w2', task_id: 't-2', terminal: 'done', timed_out: false, evidence_present: true },
  ])
  assert.equal(currentEntry(legitimate).event, 'delivered', 'a truthful same-leg delivered was refused')
  assert.equal(currentEntry(legitimate).agent_id, 'b_w2')
})

test('a duplicate assigned.task_id (or dispatch_id) invalidates the ledger instead of silently letting the newer leg win (B2)', () => {
  // task_id is minted at millisecond resolution (loop-runner.mjs), so two
  // dispatches of the same (token, team, role) can collide, and a
  // hand-written or replayed ledger has no clock constraint on it at all.
  // `assignedIndexByTask` (dispatch-facts.mjs) is last-wins and
  // `dispatchOwner` (ledger-validate.mjs) keeps only the first owner — reused
  // ids never told the OPERATOR that the assumption both readers depend on
  // (one id, one leg, for its whole life) had already been broken.
  const dupeTask = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-dup', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-dup', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-dup', dispatch_id: 'd-2' },
    { at: '2026-07-27T09:03:00.000Z', event: 'lost', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-dup', reason: 'timed out' },
  ].map((entry) => JSON.stringify(entry))
  const taskResult = validateLedger(dupeTask)
  assert.equal(taskResult.ok, false, 'a ledger reusing task_id across two assigned lines validated clean')
  assert.ok(taskResult.problems.some((problem) => problem.code === 'duplicate_task_id'),
    `expected a duplicate_task_id problem, got ${JSON.stringify(taskResult.problems)}`)

  const dupeDispatch = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-1', dispatch_id: 'd-dup' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-2', dispatch_id: 'd-dup' },
    { at: '2026-07-27T09:03:00.000Z', event: 'lost', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-2', reason: 'timed out' },
  ].map((entry) => JSON.stringify(entry))
  const dispatchResult = validateLedger(dupeDispatch)
  assert.equal(dispatchResult.ok, false, 'a ledger reusing dispatch_id across two assigned lines validated clean')
  assert.ok(dispatchResult.problems.some((problem) => problem.code === 'duplicate_dispatch_id'),
    `expected a duplicate_dispatch_id problem, got ${JSON.stringify(dispatchResult.problems)}`)

  // Unique ids on an otherwise-identical shape still validate clean — this is
  // about reuse, not about redispatching the same agent per se.
  const unique = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-2', dispatch_id: 'd-2' },
    { at: '2026-07-27T09:03:00.000Z', event: 'lost', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't-2', reason: 'timed out' },
  ].map((entry) => JSON.stringify(entry))
  assert.equal(validateLedger(unique).ok, true, JSON.stringify(validateLedger(unique).problems))
})

// ── retro-release-review round 2, 2026-08-04: F1 survives in two shapes ─────
// the B4 heuristic (a CONSECUTIVE run of the same evaluator's `assigned`
// lines) did not cover: an intervening assignment — the ordinary rework leg
// between review rounds — reset the run and reopened the hole (Shape 1); and
// a `reviewed` that borrows the LIVE holder's dispatch_id while still naming
// an OLDER task_id took the dispatch_id fast path before task_id was ever
// consulted (Shape 2).

test('a same-evaluator reject-rework-re-review still does not clear the pull gate for a live retry (Shape 1)', () => {
  // The B4 fixture retries the SAME delivery — the evaluator's two `assigned`
  // lines are back to back, nothing else in between. This is the shape the
  // system actually produces instead: round 1's evaluator rejects, the
  // worker reworks (a DIFFERENT agent's `assigned` sits between the
  // evaluator's two legs), round 2's evaluator is assigned and still running
  // — and round 1's dead leg writes its late, identityless `reviewed pass`
  // after round 2 has already started. The old heuristic counted only a
  // consecutive run, saw the worker's `assigned` reset it to 1, and trusted
  // the ghost.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    // Round 1's own (real, in-order) verdict.
    { at: '2026-07-27T09:03:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 'b-1', reason: 'missing a test' },
    // The rework leg — a DIFFERENT agent's `assigned` between the evaluator's
    // two legs, which is exactly what reset the old "consecutive run" count.
    { at: '2026-07-27T09:04:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'w-2' },
    { at: '2026-07-27T09:05:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-2' },
    // Round 2's evaluator — the live holder, still running.
    { at: '2026-07-27T09:06:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-2', dispatch_id: 'r-2' },
    // Round 1's dead leg, late: identityless, so nothing on the line itself
    // says which of b_e's two legs it belongs to.
    { at: '2026-07-27T09:07:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-1', reason: 'a stale duplicate from the dead round-1 leg' },
  ]
  const items = itemsOf(['tok', custody])

  assert.equal(currentEntry(custody).task_id, 'r-2', 'the interleaved stale pass was read as where the token is')
  assert.equal(currentEntry(custody).event, 'assigned', 'the live round-2 retry is still assigned, not reviewed')
  assert.deepEqual(teamOccupancy(graph, items).held.get('build'), ['tok'],
    'the interleaved stale pass moved the token off the seat still running it')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:08:00.000Z'), [],
    'a reject-rework-re-review interleaving cleared the pull gate for a live retry')
})

test('a same-evaluator reject-rework-re-review DOES clear the gate once round 2 actually reports (Shape 1, positive case)', () => {
  // The fix must not turn every multi-round review into a permanent hold —
  // once round 2's OWN outcome lands (naming its own task_id), it is not
  // ambiguous at all: it resolves through the task_id branch, not the
  // identityless fallback this fix changed.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    { at: '2026-07-27T09:03:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 'b-1', reason: 'missing a test' },
    { at: '2026-07-27T09:04:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'w-2' },
    { at: '2026-07-27T09:05:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-2' },
    { at: '2026-07-27T09:06:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-2', dispatch_id: 'r-2' },
    // Round 2's OWN report — names its own task_id, so it is not ambiguous.
    { at: '2026-07-27T09:07:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'pass', task_id: 'r-2', reviewed_task: 'b-2', reason: 'the fix does what was asked' },
  ]
  const items = itemsOf(['tok', custody])
  assert.equal(currentEntry(custody).event, 'reviewed')
  assert.equal(currentEntry(custody).verdict, 'pass')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:08:00.000Z').map((d) => d.action), ['pull'],
    'round 2\'s own labeled outcome did not clear the pull gate')
})

test('a reviewed that borrows the live holder\'s dispatch_id while naming an OLDER task_id is not trusted (Shape 2)', () => {
  // assigned e/r1/d1 -> assigned e/r2/d2 (live) -> reviewed(pass, agent=e,
  // task_id=r1, dispatch_id=d2). The dispatch_id fast path in `currentEntry`
  // used to return on a dispatch_id match alone, before task_id was ever
  // consulted — so a line naming the LIVE dispatch_id but an OLD task_id read
  // as round 2's own outcome.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T09:03:00.000Z', event: 'assigned', agent_id: 'b_e', task_id: 'r-2', dispatch_id: 'd-2' },
    // Borrows the live dispatch_id (d-2) but still names round 1's task (r-1).
    { at: '2026-07-27T09:04:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'pass', task_id: 'r-1', dispatch_id: 'd-2', reviewed_task: 'b-1', reason: 'borrowed identity' },
  ]
  const items = itemsOf(['tok', custody, {
    expectInvalid: true,
    why: 'the sanctioned writer now refuses this shape too (dispatch_id_task_mismatch); '
      + 'this fixture is the raw, already-on-disk shape currentEntry must still defend against',
  }])

  assert.equal(currentEntry(custody).task_id, 'r-2', 'the borrowed-dispatch_id review was read as where the token is')
  assert.equal(currentEntry(custody).event, 'assigned', 'the live leg is still assigned, not reviewed')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:05:00.000Z'), [],
    'a reviewed borrowing the live dispatch_id while naming an older task_id cleared the pull gate')

  // The consistent case must still work: dispatch_id AND task_id both name
  // round 2's own leg.
  const consistent = custody.map((entry) => (entry.event === 'reviewed'
    ? { ...entry, task_id: 'r-2', reviewed_task: 'b-1', reason: 'its own leg' }
    : entry))
  assert.equal(currentEntry(consistent).event, 'reviewed')
  assert.equal(currentEntry(consistent).verdict, 'pass')

  // And a reviewed that matches dispatch_id and simply omits task_id
  // altogether (the ordinary shorthand) must still be trusted — this fix
  // only refuses a task_id that resolves to a DIFFERENT leg, not an absent
  // one.
  const noTaskId = custody.map((entry) => {
    if (entry.event !== 'reviewed') return entry
    const { task_id, ...rest } = entry
    return rest
  })
  assert.equal(currentEntry(noTaskId).event, 'reviewed')
  assert.equal(currentEntry(noTaskId).verdict, 'pass')
})

// ── retro-release-review round 5, 2026-08-04: B6 — a genuine different-agent
// shorthand round-2 review must not be discarded as a stale straggler ───────
// (r5-codex BLOCKER 5, "John"; r5-qwen "Priya"). The 36-cell matrix below
// always builds a STALE straggler by its own stated ground truth, so it has
// no cell for the opposite defect the round-4 fix (discard EVERY non-holder
// `reviewed` whose agent has any earlier `assigned`, unconditionally)
// introduced: a reviewer that had an OLDER leg somewhere in this ledger
// (reject, rework, re-review — the ordinary shape §1 describes) is legally
// allowed to report round 2 with the SAME shorthand a never-assigned
// reviewer writes — no new `assigned` of its own, no dispatch_id, no
// task_id (loop-system-contract.md:843-847,867-870: reviewer identity is
// never required to equal the holder's, and this shorthand is not scoped to
// "never assigned before"). The unconditional discard could not tell that
// apart from a stale echo and threw the genuine verdict away, silently
// re-dispatching and re-paying an evaluator that had already reported.
//
// `reviewed_task` is the fix: it is REQUIRED on every `reviewed` line
// (contract §4) and the sanctioned producer (loop-runner.mjs harvestEvent)
// always stamps it from the delivery actually being judged, at the moment of
// judging — a leg that died BEFORE the holder's current delivery existed
// cannot name that delivery's task_id, because it never saw it. Matching the
// holder's own task_id is therefore producer-bound proof this review is
// about what is CURRENTLY held, independent of who holds it.

test('a second identityless review from a leg that already spoke is not the holder\'s evidence (B6, narrowed by r6-codex)', () => {
  // This test asserted the OPPOSITE until 2026-08-04, and the shape it called
  // "round 2's genuine shorthand" is one this system does not produce. The
  // sanctioned writer stamps `dispatch_id: last.dispatch_id` on every
  // `reviewed` it authors (loop-runner.mjs:784) and writes one per harvested
  // outbox — so an identityless second review from an evaluator whose leg has
  // already spoken has no dispatch standing behind it. Trusting it put
  // `Passed review` on the board, released the pull, and moved the card, on a
  // line the runner could not have written.
  //
  // r5 added the carve-out to stop over-discarding; r6 kept the carve-out and
  // bound it to a leg that has not yet reported. The direction of the residual
  // error matters: refusing re-reviews the delivery, trusting ships it.
  const graph = graphOf(TWO_TEAMS)
  const spent = [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 'b-1', reason: 'missing a test' },
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'w-2' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true },
    // b_e's leg r-1 already reported at index 3. This is a second word from it.
    { event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-2', reason: 'the fix does what was asked' },
  ]
  const entry = currentEntry(itemsOf(['tok', spent]).get('tok').custody)
  assert.equal(entry.event, 'delivered', 'a second review from a spent leg was read as the holder\'s own evidence')
  assert.equal(entry.task_id, 'b-2', 'the token is still where the worker left it')
  assert.deepEqual(planPulls(graph, itemsOf(['tok', spent]), '2026-07-27T09:10:00.000Z').map((d) => d.action), [],
    'an unbacked pass cleared the pull gate')

  // The carve-out it replaced is still there for the case it was written for:
  // a reviewer whose CURRENT leg has not yet spoken, naming the holder's own
  // delivery. Here b_e's leg r-1 reports for the first time.
  const fresh = [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    { event: 'lost', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1', reason: 'the evaluator leg died' },
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'w-2' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-2', reason: 'the fix does what was asked' },
  ]
  const good = currentEntry(itemsOf(['tok', fresh]).get('tok').custody)
  assert.equal(good.event, 'reviewed', 'a first report from the reviewer\'s own leg, naming the holder\'s delivery, is still trusted')
  assert.equal(good.verdict, 'pass')
})

test('a different-agent shorthand naming an OLDER delivery than the one the holder made is still discarded (B6, negative)', () => {
  // Identical to the positive fixture except the trailing line's
  // `reviewed_task` still names b-1 — the delivery b_e actually reviewed
  // before being superseded — instead of the holder's fresh b-2. Proves the
  // B6 exception is bound to reviewing the CURRENT delivery, not a blanket
  // "reviewer had a leg once" pass.
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['tok', [
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'r-1' },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 'b-1', reason: 'missing a test' },
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'w-2' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true },
    // A second late line from b_e, but still naming b-1 — not the holder's
    // fresh b-2.
    { event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-1', reason: 'stale — about the wrong delivery' },
  ]])
  const entry = currentEntry(items.get('tok').custody)
  assert.notEqual(entry.event, 'reviewed', 'a stale review naming an older delivery was trusted as the holder\'s own')
  assert.equal(entry.agent_id, 'b_w1', 'the real holder (the reworked delivery) was not retained')
  assert.deepEqual(planPulls(graph, items, '2026-07-27T09:10:00.000Z'), [],
    'a stale different-agent review naming an older delivery cleared the pull gate')
})

// ── retro-release-review round 4, 2026-08-04: the full F1 identity matrix ───
// Three independent review families (codex, agy, qwen) each rebuilt a piece
// of this matrix and did not agree with each other. This test builds the
// WHOLE thing — (dispatch_id: own/absent/borrowed) x (task_id: own/absent/
// borrowed) x (agent: same/different) x (assignment interleaving: consecutive
// /interleaved) = 36 cells — instead of the handful of hand-picked shapes
// that produced three rounds of "fixed the shape you named, missed its
// neighbour". Every cell states its own required verdict and why, and the
// whole table is printed so a human can audit it, not just trust a pass
// count.
//
// Ground truth for every cell: the trailing `reviewed pass` is ALWAYS a
// straggler from the OLD (round-1) evaluator's dead leg, never a genuine
// round-2 report — "own"/"absent"/"borrowed" describe only what identity
// fields that straggler happens to carry, honestly or not.
//
// H  = the live assigned holder must be retained; the stale review must not
//      be trusted as the token's current position.
// TRUST = the review is legitimately indistinguishable from a genuine
//      current report and currentEntry trusting it is correct, not a bug.
//
// Three cells are TRUST rather than H specifically because existing tests in
// this file already require it and would go red otherwise:
//   - Shape 1 positive case (line ~2348): a same-agent report naming only
//     its own current task_id (no dispatch_id at all) must clear the gate —
//     dispatch=absent/task=borrowed, same agent.
//   - Shape 2 "noTaskId" case (line ~2410): a same-agent report naming the
//     current dispatch_id with task_id omitted must clear the gate —
//     dispatch=borrowed/task=absent, same agent.
//   - Shape 2 "consistent" case (line ~2400): a same-agent report naming
//     BOTH the current dispatch_id and task_id must clear the gate —
//     dispatch=borrowed/task=borrowed, same agent.
// For the SAME agent, a report carrying the holder's own real dispatch_id
// and/or task_id is byte-for-byte indistinguishable from a genuine round-2
// report by that same agent — Winston (codex) conceded this directly:
// "the bytes are identical to a genuine r2 report ... currentEntry cannot
// solve that with heuristics; the format needs producer-bound provenance."
// qwen independently built and tested exactly these nine same-agent cells
// and found "all nine correct". codex alone called three of them (borrowed/
// absent, borrowed/borrowed, absent/borrowed — all same-agent) bugs; two of
// three review families is the must-fix bar (CLAUDE.md), and here two of
// three (qwen's direct test, and the pre-existing protected tests in this
// file) say TRUST is required. Those three same-agent cells are therefore
// left as TRUST, not "fixed" — see "what I did not fix" in the round's report.
//
// For a DIFFERENT agent, codex AND agy independently confirmed (2 of 3) a
// concrete live failure: a superseded evaluator's identity-less stale review
// hijacking a live retry by a different agent. That agent's own leg, once
// superseded, can never again be trusted as evidence about someone else's
// leg no matter what it claims to carry — every different-agent cell is H.
const F1_MATRIX = []
for (const dispatchShape of ['own', 'absent', 'borrowed']) {
  for (const taskShape of ['own', 'absent', 'borrowed']) {
    for (const agentShape of ['same', 'different']) {
      for (const interleave of ['consecutive', 'interleaved']) {
        let required
        let reason
        if (agentShape === 'different') {
          required = 'H'
          reason = 'the reviewing agent is not the holder and has its own superseded leg — never trusted'
        } else if (dispatchShape === 'own') {
          required = 'H'
          reason = 'dispatch_id names a different leg than the holder\'s — unambiguous mismatch'
        } else if (dispatchShape === 'absent' && taskShape === 'own') {
          required = 'H'
          reason = 'task_id names a different leg than the holder\'s — unambiguous mismatch'
        } else if (dispatchShape === 'absent' && taskShape === 'absent') {
          required = 'H'
          reason = 'same agent assigned twice in this ledger — identity-less, genuinely ambiguous (Shape 1)'
        } else if (dispatchShape === 'absent' && taskShape === 'borrowed') {
          required = 'TRUST'
          reason = 'task_id resolves to the holder\'s own leg and the agent matches — protected by the Shape 1 positive test'
        } else if (dispatchShape === 'borrowed' && taskShape === 'own') {
          required = 'H'
          reason = 'dispatch_id matches but task_id names an older leg — unambiguous mismatch (Shape 2)'
        } else if (dispatchShape === 'borrowed' && taskShape === 'absent') {
          required = 'TRUST'
          reason = 'dispatch_id matches the holder\'s own leg, task_id omitted — protected by the Shape 2 noTaskId test'
        } else {
          required = 'TRUST'
          reason = 'both dispatch_id and task_id match the holder\'s own leg — protected by the Shape 2 consistent test'
        }
        F1_MATRIX.push({ dispatchShape, taskShape, agentShape, interleave, required, reason })
      }
    }
  }
}
assert.equal(F1_MATRIX.length, 36, 'the identity matrix must cover all 36 cells')

// r5-codex BLOCKER 7 ("Murat"): every line needs `work_item`/`workflow` — the
// two `COMMON_FIELDS` `validateLedger` requires on every event — or the
// sanctioned-writer check below rejects all 36 cells for a reason that has
// nothing to do with the identity shape under test.
const F1_WORK_ITEM = 'tok'
const F1_COMMON = { work_item: F1_WORK_ITEM, workflow: 'feature' }

function buildF1Cell({ dispatchShape, taskShape, agentShape, interleave }) {
  const OLD_AGENT = 'b_e'
  const NEW_AGENT = agentShape === 'same' ? 'b_e' : 'b_e2'
  const custody = [
    { ...F1_COMMON, at: '2026-08-04T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { ...F1_COMMON, at: '2026-08-04T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-1' },
    // The OLD evaluator's leg — timed out / failed, never itself reported.
    { ...F1_COMMON, at: '2026-08-04T09:02:00.000Z', event: 'assigned', agent_id: OLD_AGENT, task_id: 'r-1', dispatch_id: 'd-1' },
  ]
  let t = 3
  if (interleave === 'interleaved') {
    custody.push(
      { ...F1_COMMON, at: `2026-08-04T09:0${t}:00.000Z`, event: 'assigned', agent_id: 'b_w1', task_id: 'b-2', dispatch_id: 'w-2' },
      { ...F1_COMMON, at: `2026-08-04T09:0${t + 1}:00.000Z`, event: 'delivered', agent_id: 'b_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true, dispatch_id: 'w-2' },
    )
    t += 2
  }
  // The LIVE retry — this is the holder.
  custody.push({ ...F1_COMMON, at: `2026-08-04T09:0${t}:00.000Z`, event: 'assigned', agent_id: NEW_AGENT, task_id: 'r-2', dispatch_id: 'd-2' })
  t += 1
  const stale = {
    ...F1_COMMON, at: `2026-08-04T09:0${t}:00.000Z`, event: 'reviewed', agent_id: OLD_AGENT, verdict: 'pass',
    reviewed_task: 'b-1', reason: 'stale round-1 straggler',
  }
  if (dispatchShape === 'own') stale.dispatch_id = 'd-1'
  else if (dispatchShape === 'borrowed') stale.dispatch_id = 'd-2'
  if (taskShape === 'own') stale.task_id = 'r-1'
  else if (taskShape === 'borrowed') stale.task_id = 'r-2'
  custody.push(stale)
  return { custody, holder: NEW_AGENT, stale }
}

// r5-codex BLOCKER 7 ("Murat"): the matrix above bypasses `ledger-writer.mjs`
// entirely — no `work_item`/`workflow`, never routed through `validateLedger`
// — so it silently asserts over shapes the sanctioned writer would REFUSE
// (`dispatch_id_agent_mismatch`/`dispatch_id_task_mismatch`), and a mutation
// returning the stale entry's own bytes in an H cell could still read
// "correct" if it happened to also flip `verdict` away from `'pass'`. Two
// independent fixes, not a cosmetic label:
//   1. Every cell is now run through the SAME `validateLedger` the sanctioned
//      writer calls, and whether the writer would have accepted that exact
//      ledger is printed and asserted against a fixed expectation (24
//      accepted / 12 refused — executed and confirmed against
//      `ledger-writer.mjs:appendEvent` directly, not just `validateLedger`,
//      before this file was written). A cell the writer refuses still has its
//      `currentEntry` behaviour checked below — that is legitimate defense in
//      depth against a hand-edited or pre-rule legacy ledger — but the table
//      no longer lets a reader mistake "36 shapes" for "36 shapes production
//      can create".
//   2. An H cell is now checked by IDENTITY, not just by verdict string:
//      `result !== stale` fails if `currentEntry` ever returns the exact
//      stale object, however its fields are mutated, whenever a different
//      object (the live holder's own `assigned`) is required instead.
const F1_WRITER_ACCEPTS = ({ dispatchShape, taskShape, agentShape }) => {
  if (dispatchShape === 'own' && taskShape === 'borrowed') return false
  if (dispatchShape === 'borrowed' && taskShape === 'own') return false
  if (dispatchShape === 'borrowed' && taskShape === 'absent' && agentShape === 'different') return false
  if (dispatchShape === 'borrowed' && taskShape === 'borrowed' && agentShape === 'different') return false
  return true
}

test('F1 identity matrix — all 36 cells, printed and asserted, against what the sanctioned writer actually accepts (round 5)', () => {
  const rows = []
  let failures = 0
  let acceptedCount = 0
  for (const cell of F1_MATRIX) {
    const { custody, holder, stale } = buildF1Cell(cell)
    const writerVerdict = validateLedger(custody.map((entry) => JSON.stringify(entry)))
    const writerAccepted = writerVerdict.ok
    if (writerAccepted !== F1_WRITER_ACCEPTS(cell)) {
      failures += 1
      rows.push({
        dispatch: cell.dispatchShape, task: cell.taskShape, agent: cell.agentShape, order: cell.interleave,
        required: cell.required, actual: 'n/a', writerAccepted, pass: 'FAIL (writer-acceptance mismatch)',
      })
      continue
    }
    if (writerAccepted) acceptedCount += 1

    const result = currentEntry(custody)
    const actual = result.event === 'reviewed' && result.verdict === 'pass' ? 'TRUST' : 'H'
    // For H, the returned entry must be a DIFFERENT object than the stale
    // straggler — not merely one that happens to print a different verdict —
    // and it must be held by the real live holder.
    const heldCorrectly = actual !== 'H' || (result !== stale && result.agent_id === holder)
    const pass = actual === cell.required && heldCorrectly
    if (!pass) failures += 1
    rows.push({
      dispatch: cell.dispatchShape, task: cell.taskShape, agent: cell.agentShape,
      order: cell.interleave, required: cell.required, actual, writerAccepted, pass: pass ? 'ok' : 'FAIL',
    })
  }
  console.log('\nF1 identity matrix (36 cells, writer-acceptance labeled):')
  console.table(rows)
  assert.equal(acceptedCount, 24,
    'the sanctioned writer\'s acceptance of these 36 shapes drifted from the executed baseline (24/36) — re-verify against ledger-writer.mjs directly')
  if (failures > 0) {
    assert.fail(`${failures}/36 F1 identity cells did not match their required verdict or writer-acceptance — see table above`)
  }
  assert.equal(failures, 0)
})

// ── codex BLOCKER 4 (retro-release-review round 5, 2026-08-04): task id
// domain mismatch caused unbounded respawn ───────────────────────────────────
//
// `dispatch()` (loop-runner.mjs) used to build a task id by concatenating
// workItem-team-role-Date.now() and lossily replacing every disallowed
// character with '-'. `acp-companion.mjs`'s own ID_RE caps a task id at 64
// chars and rejects it BEFORE the child ever writes `assigned` — and the
// retry budget (`attemptsBy`, loop-runner.mjs) counts only `assigned` lines,
// so a work item long enough to overflow 64 chars respawned forever. These
// tests probe the REAL acp-companion.mjs process — not a copy of its
// regex — because the whole defect is "what a SEPARATE process's own gate
// accepts", which a same-process regex copy cannot prove.
const REAL_COMPANION = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs')

// Runs the real companion binary just far enough to clear (or trip) its own
// task-id gate: a nonexistent brief file makes it fail immediately AFTER
// that gate with a distinct, unmistakable message, so "rejected here" can
// never be confused with "rejected for some other, later reason".
function realCompanionTaskIdVerdict(taskId) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-id-probe-'))
  try {
    const result = spawnSync(process.execPath, [
      REAL_COMPANION, 'claude', dir, taskId, join(dir, 'does-not-exist.md'),
    ], { encoding: 'utf8' })
    const stderr = result.stderr || ''
    if (/invalid task id/.test(stderr)) return 'rejected-at-id-gate'
    if (/\[fatal\] cannot read brief/.test(stderr)) return 'passed-id-gate'
    return `unexpected: code=${result.status} stderr=${stderr}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('buildTaskId: a work item at the sanctioned ledger writer\'s own length ceiling never overflows the REAL acp-companion\'s 64-char task-id gate', () => {
  // ledger-writer.mjs's own ID_RE — the "REAL writer" this task-id must stay
  // inside the domain of — allows up to 128 chars, '.' and ':' included.
  // 128 is the worst case for length; use it, not a convenient smaller one.
  const workItem = `w${'x'.repeat(126)}y` // 128 chars, starts alnum as the ledger writer requires
  assert.equal(workItem.length, 128)
  const taskId = buildTaskId(workItem, 'build', 'dispatcher', 1_999_999_999_999)
  assert.ok(taskId.length <= 64, `taskId is ${taskId.length} chars, over acp-companion's 64-char cap: ${taskId}`)
  assert.equal(realCompanionTaskIdVerdict(taskId), 'passed-id-gate',
    `the REAL acp-companion process rejected a taskId built from a work item the REAL ledger writer accepts: ${taskId}`)
})

test('buildTaskId: the OLD formula is proven broken against the REAL acp-companion process on the same input (baseline for the fix above)', () => {
  // This reconstructs the exact pre-fix formula (loop-runner.mjs, before
  // this change) to prove the failure this fix closes was real, not
  // hypothetical — run against the actual companion binary, the same way
  // the fixed `buildTaskId` is proven above.
  const workItem = `w${'x'.repeat(126)}y`
  const oldTaskId = `${workItem}-build-dispatcher-${(1_999_999_999_999).toString(36)}`
    .replace(/[^A-Za-z0-9_-]/g, '-')
  assert.ok(oldTaskId.length > 64, 'the old formula must overflow 64 chars for this to be the failure it claims to be')
  assert.equal(realCompanionTaskIdVerdict(oldTaskId), 'rejected-at-id-gate',
    'the old formula was expected to be rejected by the real companion\'s own ID_RE')
})

test('buildTaskId: two work items that collide under naive char-substitution ("a.b", "a:b") no longer collide', () => {
  // Both are legal per the ledger writer's own ID_RE (which allows '.' and
  // ':'); the OLD sanitize turned both into "a-b", so two DIFFERENT tokens
  // dispatched in the same millisecond would have shared one task-keyed log,
  // dispatch record, liveness file and mailbox outbox. Pin `nowMs` so the
  // property under test is the id-building function's own injectivity, not
  // luck about which millisecond the clock read.
  const now = 1_700_000_000_000
  const a = buildTaskId('a.b', 'build', 'dispatcher', now)
  const b = buildTaskId('a:b', 'build', 'dispatcher', now)
  assert.notEqual(a, b, `"a.b" and "a:b" collided onto the same taskId at the same instant: ${a}`)
  // And the old formula DID collide, for the same reason blocker 4 states —
  // proves this is a real regression fix, not a property that always held.
  const oldSanitize = (workItem) => `${workItem}-build-dispatcher-${now.toString(36)}`.replace(/[^A-Za-z0-9_-]/g, '-')
  assert.equal(oldSanitize('a.b'), oldSanitize('a:b'), 'the old formula was expected to collide on these two inputs')
})

test('a dispatched leg for a valid-but-long work item is accepted by the REAL acp-companion process end to end (integration, not a copied regex)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-taskid-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    const graph = TWO_TEAMS
    writeFileSync(join(store, 'graph.json'), JSON.stringify(graph))
    writeFileSync(join(store, 'team-briefs', 'build.md'), '# standing brief\n')
    // 100 chars — well inside the ledger writer's 128-char ceiling, and long
    // enough on its own (before team/role/hash are even added) to have
    // overflowed the OLD formula's 64-char budget.
    const longWorkItem = `tok${'z'.repeat(97)}`
    assert.equal(longWorkItem.length, 100)
    writeFileSync(join(store, 'work-items', `${longWorkItem}.jsonl`),
      `${ledger(longWorkItem, [{ event: 'opened', agent_id: 'b_d', to_team: 'build' }])
        .map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const captured = []
    const spawnFn = (cmd, args, options) => {
      captured.push({ cmd, args, env: options.env })
      return { unref() {} }
    }
    tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnFn })

    assert.ok(captured.length >= 1, `expected at least one dispatched leg, got ${captured.length}`)
    for (const call of captured) {
      const taskId = call.args[3]
      assert.ok(taskId.length <= 64, `runner-generated taskId is ${taskId.length} chars: ${taskId}`)
      assert.equal(realCompanionTaskIdVerdict(taskId), 'passed-id-gate',
        `the REAL acp-companion rejected the taskId the REAL runner generated for a valid long work item: ${taskId}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── GitHub #32: per-seat reasoning effort reaches the spawned process ────────
// (trailing header retained as-is; no test body followed it before this change)

// ── retro-release-review round 5 (2026-08-04): BLOCKER 2 + BLOCKER 3 ────────

// BLOCKER 2: `lastWorkerDelivery` (loop-runner.mjs) used to walk `custody`
// backwards and take the newest `delivered`/worker/terminal:'done' line by
// ARRIVAL order — the position `readWorkItems` sorts it into by `at`
// (dispatch-facts.mjs). A leg already declared `lost` can still report a late
// success stamped with whatever `at` it actually landed at, which can sort
// AFTER a newer leg's own delivery. This reproduces the exact scenario in the
// review: w1 is declared lost, the retry (w2, same agent b_w1, a fresh
// task_id) delivers the artifact actually in play, and only THEN does w1's
// late, superseded success arrive and get appended last.
test('BLOCKER 2: the evaluator is handed the live retry\'s delivery, not a late straggler from a leg already declared lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-blocker2-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'build.md'), '# standing brief for Build\n')
    writeFileSync(join(dir, '.mailbox-out', 'w1-task'), 'STALE ARTIFACT FROM THE DECLARED-LOST LEG\n')
    writeFileSync(join(dir, '.mailbox-out', 'w2-task'), 'THE REAL CURRENT ARTIFACT FROM THE RETRY\n')
    writeFileSync(join(store, 'work-items', 'token2.jsonl'), `${ledger('token2', [
      { event: 'assigned', agent_id: 'b_w1', task_id: 'w1-task' },
      { event: 'lost', agent_id: 'b_w1', task_id: 'w1-task' },
      { event: 'assigned', agent_id: 'b_w1', task_id: 'w2-task' },
      { event: 'delivered', agent_id: 'b_w1', task_id: 'w2-task', terminal: 'done' },
      // Appended LAST, so a raw backwards scan meets this before w2's own
      // delivery — even though w2's leg opened (was `assigned`) later.
      { event: 'delivered', agent_id: 'b_w1', task_id: 'w1-task', terminal: 'done' },
    ]).map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const scratch = join(dir, 'scratch')
    const result = tick(dir, { apply: false, scratchDir: scratch })
    assert.equal(result.ok, true, result.reason)
    const brief = readFileSync(join(scratch, 'brief-token2-build-evaluator.md'), 'utf8')

    assert.match(brief, /THE REAL CURRENT ARTIFACT FROM THE RETRY/,
      'the evaluator brief did not carry the live retry\'s own delivery')
    assert.match(brief, /task `w2-task`/, 'the evaluator brief did not name the live retry\'s task')
    assert.doesNotMatch(brief, /STALE ARTIFACT FROM THE DECLARED-LOST LEG/,
      'the evaluator was handed the declared-lost leg\'s late straggler instead of the live retry\'s delivery')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// BLOCKER 3a: the outer controller's own leg is spawned with `workItem: ''`
// (`tick`, above), so a dead controller leg — killed, crashed, or simply one
// that never wrote `.mailbox-out/<taskId>` — leaves `planHarvest` nothing to
// harvest for a token parked in `escalated` on it. Before this fix `held` had
// no exit at all for that case; `answerDeadlineSec` (the same clock
// `questioned` already answers to) now gives it one.
test('BLOCKER 3a: a token parked on a dead outer-controller leg is held inside the deadline and expires past it', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = itemsOf(['parked', ESCALATED])
  const lastAt = Date.parse([...items.values()][0].custody.slice(-1)[0].at)

  const inside = planDispatches(graph, items, new Set(), { now: lastAt + 60_000, answerDeadlineSec: 600 })
    .find((entry) => entry.work_item === 'parked')
  assert.equal(inside?.action, 'held', 'a controller leg still inside its deadline must not be treated as dead')

  const past = planDispatches(graph, items, new Set(), { now: lastAt + 601_000, answerDeadlineSec: 600 })
    .find((entry) => entry.work_item === 'parked')
  assert.equal(past?.action, 'expired',
    'a controller leg with no outbox past the deadline left the token held with no path to a terminal')
  assert.equal(past.agent_id, 'pm')
})

// BLOCKER 3a, end to end: the `expired` action tick() applies actually reaches
// the ledger as `abandoned` — the terminal `AFTER_COMPLETED`'s own comment in
// `ledger-validate.mjs` names as the legal landing spot for exactly this.
test('BLOCKER 3a (tick): a parked token behind a dead outer-controller leg is abandoned instead of held forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-blocker3a-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    // No .mailbox-out/board-pm-1 — the controller leg never wrote an outbox.
    const ledgerFile = join(store, 'work-items', 'parked.jsonl')
    writeFileSync(ledgerFile, `${ledger('parked', ESCALATED).map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const result = tick(dir, { apply: true, scratchDir: join(dir, 'scratch') })
    assert.equal(result.ok, true, result.reason)

    const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n')
    const lastEvent = JSON.parse(lines[lines.length - 1])
    assert.equal(lastEvent.event, 'abandoned',
      'a controller leg that never wrote an outbox left the token parked forever instead of reaching a terminal')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// BLOCKER 3b: `audit_requested` is a RELEASING_EVENT (dispatch-facts.mjs
// `teamOccupancy`), so a token in that state is never a member of `held` and
// `nextStep`'s per-team loop in `planDispatches` never visits it at all — a
// dead controller leg here had NO reader whatsoever, not even a `held` one.
// `planDispatches` now scans every item directly for exactly this shape.
test('BLOCKER 3b: a finished route behind a dead outer-controller audit leg expires past the deadline', () => {
  const graph = graphOf(TWO_TEAMS)
  const at = (minutes) => new Date(FIXED_NOW + minutes * 60_000).toISOString()
  const stuckAudit = itemsOf(['tok', [
    ...FINISHED,
    { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-dead-1', reason: 'route finished — read the delivery as a whole', at: at(1) },
  ]])
  const lastAt = Date.parse(at(1))

  const inside = planDispatches(graph, stuckAudit, new Set(), { now: lastAt + 60_000, answerDeadlineSec: 600 })
    .find((entry) => entry.work_item === 'tok')
  assert.equal(inside, undefined,
    'an audit still inside its deadline must not be reported as expired (and RELEASING_EVENTS keeps it out of `held`, so no plan at all is the correct shape)')

  const past = planDispatches(graph, stuckAudit, new Set(), { now: lastAt + 601_000, answerDeadlineSec: 600 })
    .find((entry) => entry.work_item === 'tok')
  assert.equal(past?.action, 'expired',
    'a finished route whose audit controller leg never wrote an outbox was held with no automatic path to a terminal')
  assert.equal(past.agent_id, 'pm')
})

// BLOCKER 3b, end to end.
test('BLOCKER 3b (tick): a finished route behind a dead outer-controller audit leg is abandoned instead of held forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-blocker3b-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    const ledgerFile = join(store, 'work-items', 'tok.jsonl')
    // `at` stamped far in the past — well past `ANSWER_DEADLINE_SEC` relative
    // to the real clock `tick()` reads — and no .mailbox-out/pm-dead-1.
    writeFileSync(ledgerFile, `${ledger('tok', [
      ...FINISHED,
      { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-dead-1', reason: 'route finished — read the delivery as a whole' },
    ]).map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const result = tick(dir, { apply: true, scratchDir: join(dir, 'scratch') })
    assert.equal(result.ok, true, result.reason)

    const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n')
    const lastEvent = JSON.parse(lines[lines.length - 1])
    assert.equal(lastEvent.event, 'abandoned',
      'a finished route whose audit controller leg never wrote an outbox stayed audit_requested forever instead of reaching a terminal')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a token whose history stopped being believable is closed by the runner, not wedged forever', () => {
  // AGY, round six. On a ledger whose only defect is closing-tolerated, the
  // writer accepts `audited` and `abandoned` and refuses everything else — so
  // the `lost` the runner would write for a dead worker is refused, and with it
  // every route to the `expired` branch that writes the automatic `abandoned`.
  // The escape hatch CLOSING_TOLERATED_PROBLEMS promises existed with no
  // automated caller able to reach it, and the token sat held forever with the
  // board showing it in flight.
  const dir = mkdtempSync(join(tmpdir(), 'loop-unbelievable-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'graph.json'), JSON.stringify(TWO_TEAMS))
    writeFileSync(join(store, 'team-briefs', 'test.md'), '# standing brief\n')
    // Two legs sharing one task_id: a genuinely pre-existing duplicate, which
    // is closing-tolerated and nothing else.
    writeFileSync(join(store, 'work-items', 'tok.jsonl'), itemsOf(['tok', [
      { event: 'pulled', agent_id: 't_d', from_team: 'build', to_team: 'test' },
      { event: 'intake', agent_id: 't_d', verdict: 'accept' },
      { event: 'assigned', agent_id: 't_w1', task_id: 'dup', dispatch_id: 'd-1' },
      { event: 'lost', agent_id: 't_w1', task_id: 'dup', dispatch_id: 'd-1', reason: 'first leg died' },
      { event: 'assigned', agent_id: 't_w1', task_id: 'dup', dispatch_id: 'd-2' },
    ], { expectInvalid: true, why: 'a pre-existing duplicate task_id IS the subject — the runner must be able to close a ledger it can no longer continue' }]).get('tok').custody.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    writeFileSync(join(store, 'pulse.json'), JSON.stringify({ generated_at: new Date().toISOString(), runs: [] }))

    tick(dir, { apply: true, scratchDir: join(dir, 'scratch') })

    const lines = readFileSync(join(store, 'work-items', 'tok.jsonl'), 'utf8').trim().split('\n')
    const written = JSON.parse(lines[lines.length - 1])
    assert.equal(written.event, 'abandoned',
      `the runner left the token held on a ledger it can never continue: last line was ${written.event}`)
    assert.equal(written.actor, 'agent:runner', 'the runner signs the close it decided on its own')
    assert.match(written.reason, /duplicate_task_id/,
      'the close must name what made the history unbelievable, or nobody can repair it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a controller that is still running is not a controller that failed to answer (r6-codex/John)', () => {
  // `nextStep` took `busy` and never read it on this branch. A live outer
  // controller past `answerDeadlineSec` — a shorter clock than the 1800s stall
  // budget it actually runs under — had its token `abandoned` underneath it,
  // and `abandoned` is a HARD terminal, so the answer could not be harvested
  // when it arrived. Elapsed time is not proof that a process is dead.
  const graph = graphOf(TWO_TEAMS)
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T09:02:00.000Z', event: 'escalated', agent_id: graph.outer_controller_id, to_team: 'build', task_id: 'ctl-1', reason: 'needs a decision' },
  ]
  const items = itemsOf(['tok', custody, { expectInvalid: true, why: 'the escalation shape is the subject; the fixture only has to reach the escalated branch' }])
  // Well past the deadline either way.
  const now = Date.parse('2026-07-27T09:30:00.000Z')

  const live = planDispatches(graph, items, new Set([graph.outer_controller_id]),
    { now, answerDeadlineSec: 600, busyTasks: new Set(['ctl-1']) })
  assert.equal(live.filter((plan) => plan.action === 'expired').length, 0,
    'a controller with a live process was withdrawn from on the clock alone')

  // r7-codex: `busy` answers about an AGENT, and the outer controller is busy
  // almost always. Asking it here suppressed the withdrawal forever on work
  // that had nothing to do with this token — the leg parked here is `ctl-1`,
  // and the controller running `ctl-9` says nothing about it.
  const elsewhere = planDispatches(graph, items, new Set([graph.outer_controller_id]),
    { now, answerDeadlineSec: 600, busyTasks: new Set(['ctl-9']) })
  assert.equal(elsewhere.filter((plan) => plan.action === 'expired').length, 1,
    'unrelated live work on the same agent held this token open forever')

  const dead = planDispatches(graph, items, new Set(), { now, answerDeadlineSec: 600 })
  assert.equal(dead.filter((plan) => plan.action === 'expired').length, 1,
    'a controller with no live process must still be withdrawn from, or the token wedges forever')
})

test('two dispatches of the same work item, team and role do not reuse one task id (r6-codex/Quinn)', () => {
  // Quinn's mutant: delete `${nowMs}` from the digest input and every task-id
  // test stayed green — so nothing asserted that a retry of the same tuple gets
  // a new id. It has to: the id keys the log, the dispatch record, the liveness
  // file and the outbox, and a retry that reuses one writes over its own dead
  // leg's evidence and produces the `duplicate_task_id` the ledger then refuses
  // to continue.
  const first = buildTaskId('tok', 'build', 'worker', 1_770_000_000_000)
  const later = buildTaskId('tok', 'build', 'worker', 1_770_000_000_001)
  assert.notEqual(first, later, 'a retry one millisecond later reused the dead leg\'s id')
  assert.equal(first.length, later.length)
  assert.ok(first.length <= 64, `task id must fit acp-companion's cap, got ${first.length}`)

  // Same millisecond, same tuple: still identical, and the comment says so
  // rather than claiming uniqueness the digest cannot give.
  assert.equal(buildTaskId('tok', 'build', 'worker', 1_770_000_000_000), first)

  // The sanitizer collision this was built to remove: two work items that
  // flatten to one prefix are separated by the digest over the RAW tuple.
  const dotted = buildTaskId('a.b', 'build', 'worker', 1_770_000_000_000)
  const coloned = buildTaskId('a:b', 'build', 'worker', 1_770_000_000_000)
  assert.notEqual(dotted, coloned, 'two different work items shared one task id')

  // r6-qwen M6: `slice(0, 16)` -> `slice(0, 15)` survived, because "16 hex
  // chars" was a comment rather than an assertion. The width is load-bearing —
  // it is what makes `47 + 1 + 16 = 64` fit acp-companion's cap exactly.
  assert.match(first, /-[0-9a-f]{16}$/, 'the digest suffix must be exactly 16 hex chars')

  // r6-qwen M3: the digest delimiter ' ' -> '-' survived, and it reintroduces
  // real collisions — the ledger writer's ID_RE forbids a space in a work item
  // or team but allows `-`, so with a dash the tuple boundaries can be forged.
  // `a-b` + team `c` and `a` + team `b-c` flatten to the same joined string.
  assert.notEqual(
    buildTaskId('a-b', 'c', 'worker', 1_770_000_000_000),
    buildTaskId('a', 'b-c', 'worker', 1_770_000_000_000),
    'the digest delimiter can appear inside a work item or team, so the tuple boundary is forgeable',
  )
})

test('the answer deadline defaults to 600s and its boundary is inclusive (r6-qwen M8, M9)', () => {
  // M8: `ANSWER_DEADLINE_SEC` 600 -> 60000 survived, because every fixture
  // injects the value it expects — so the DEFAULT, which is what production
  // runs on, was pinned by nothing at all.
  // M9: `heldSec >=` -> `>` survived, because no fixture sits exactly on the
  // line. A token parked for precisely the deadline has waited it out.
  const graph = graphOf(TWO_TEAMS)
  const parkedAt = '2026-07-27T09:02:00.000Z'
  const custody = [
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'w-1' },
    { at: '2026-07-27T09:01:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: parkedAt, event: 'escalated', agent_id: graph.outer_controller_id, to_team: 'build', task_id: 'ctl-1', reason: 'needs a decision' },
  ]
  const items = itemsOf(['tok', custody, { expectInvalid: true, why: 'the escalation shape is the subject; the fixture only has to reach the escalated branch' }])
  const expiredAt = (now) => planDispatches(graph, items, new Set(), { now })
    .filter((plan) => plan.action === 'expired').length

  const parked = Date.parse(parkedAt)
  assert.equal(expiredAt(parked + 599_000), 0, 'withdrew a second early')
  assert.equal(expiredAt(parked + 600_000), 1, 'a token parked for exactly the deadline has waited it out')
  assert.equal(expiredAt(parked + 601_000), 1)
  // And the default really is 600, not merely whatever a fixture injects.
  assert.equal(expiredAt(parked + 1_000_000), 1)
  assert.equal(planDispatches(graph, items, new Set(), { now: parked + 700_000, answerDeadlineSec: 6_000 })
    .filter((plan) => plan.action === 'expired').length, 0,
  'the injected value must still win over the default, or this test pins the wrong thing')
})

test('the shorthand pass is round 2 and no further, and the ceiling is a re-dispatch not a lost token (r6-qwen)', () => {
  // The contract said "round-2+" and the code comment described an unbounded
  // "reject, rework, re-review" pass. Neither was true: the ambiguity rule
  // discards an identityless outcome from an agent assigned more than once,
  // because nothing in such a line says which of its own legs wrote it. Stating
  // the ceiling is the fix; loosening it would trust a dead leg's verdict.
  const leg = (agent, task, dispatch) => [
    { event: 'assigned', agent_id: agent, task_id: task, dispatch_id: dispatch },
    { event: 'delivered', agent_id: agent, task_id: task, dispatch_id: dispatch, terminal: 'done', timed_out: false, evidence_present: true },
  ]
  const round3 = [
    ...leg('b_w1', 'b-1', 'w-1'),
    { event: 'assigned', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'e-1' },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 'b-1', dispatch_id: 'e-1', reason: 'no test' },
    ...leg('b_w1', 'b-2', 'w-2'),
    { event: 'assigned', agent_id: 'b_e', task_id: 'r-2', dispatch_id: 'e-2' },
    { event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 'b-2', dispatch_id: 'e-2', reason: 'still no test' },
    ...leg('b_w1', 'b-3', 'w-3'),
    // Round 3, in the identity-free shorthand, naming the current delivery.
    { event: 'reviewed', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-3', reason: 'the fix does what was asked' },
  ]
  const entry = currentEntry(itemsOf(['tok', round3]).get('tok').custody)
  assert.equal(entry.event, 'delivered',
    'an identityless report from a reviewer with two prior legs cannot say which leg wrote it')
  assert.equal(entry.task_id, 'b-3', 'the token is still where the worker left it — a re-review, not a loss')
})
