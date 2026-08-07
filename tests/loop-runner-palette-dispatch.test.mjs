// loop-runner-palette-dispatch.test.mjs — GitHub #47 phase 2 (§3.5): a seat
// that declares a palette actually dispatches from it, in declared order, and
// a seat that declares none is byte-for-byte unaffected.
//
// Phase 1 (`6301f4d`, contract §3.5) shipped the SHAPE and left it unread:
// `teams[].agents[].palette` resolves and validates, but nothing chooses an
// entry or writes a second one. This file proves the choosing: the starting
// entry, the walk forward on a transport failure, the retry-in-place on a
// genuine one, the escalation once every entry has been tried once with
// nothing answering, and — the property most likely to break silently — that
// none of this moves a single byte for a seat with no palette at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planDispatches, tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { gateHistory } from './fixture-gate.mjs'

const MODELS = { dispatcher: 'model-d', worker: 'model-w', evaluator: 'model-e' }

// One team, one worker seat. WIP 1 makes "which candidate did THIS leg use"
// unambiguous — the same reason loop-occupancy.test.mjs's own single-worker
// fixtures exist — and a single-team route is legal (workflow-graph.mjs only
// requires `route.length >= 1`).
const teamOf = (extra = {}) => ({
  team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1'],
  evaluator_id: 'b_e', models: { ...MODELS }, ...extra,
})

const BASE = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'model-pm',
  // D6 (2026-08-08): every graph declares a control team and every route enters
  // through it. Callers supply the `build` team this file is about; the front
  // door is spread in here so none of them has to restate it.
  workflows: [{ workflow_id: 'solo', name: 'Solo', route: ['control', 'build'] }],
}

const CONTROL_TEAM = {
  team_id: 'control', name: 'Control', dispatcher_id: 'pm_intake',
  worker_ids: ['pm'], evaluator_id: 'pm_audit', models: { ...MODELS },
}

const graphOf = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

// Declared shape on the left of each entry passed to `graphOf`; the RESOLVED
// shape workflow-graph.mjs actually produces on `agents[].palette` (§3.5:
// effort/display_model default to null, never omitted) is what `dispatchOn`
// reads and what every assertion below compares against.
const PALETTE_DECLARED = [
  { model: 'model-a', adapter: 'claude', bucket: 'bucket-a' },
  { model: 'model-b', adapter: 'codex', bucket: 'bucket-b' },
  { model: 'model-c', adapter: 'agy', bucket: 'bucket-c' },
]
const PALETTE = PALETTE_DECLARED.map((entry) => ({ effort: null, display_model: null, ...entry }))

const NO_PALETTE_GRAPH = graphOf({ ...BASE, teams: [teamOf(), CONTROL_TEAM] })
const PALETTE_GRAPH = graphOf({ ...BASE, teams: [teamOf({ seats: { b_w1: { palette: PALETTE_DECLARED } } }), CONTROL_TEAM] })

// ── ledger fixtures — trimmed from loop-occupancy.test.mjs's own `complete`/
// `ledger`/`itemsOf` to the event kinds this file actually uses, and routed
// through the same fixture gate: a history this file's own writer could not
// have produced is not a history this system will ever hand `nextStep`.
const FIXED_NOW = Date.parse('2026-08-05T09:00:00.000Z')

const complete = (entry) => {
  switch (entry.event) {
    case 'assigned':
      return { dispatch_id: `${entry.task_id ?? 'task'}-dispatch`, ...entry }
    case 'delivered':
      return { timed_out: false, evidence_present: true, ...entry }
    case 'escalated':
      return { task_id: 'controller-task', reason: 'stated by the agent that wrote it', ...entry }
    case 'intake':
    case 'resumed':
      return { reason: 'stated by the agent that wrote it', ...entry }
    default:
      return { ...entry }
  }
}

const ledger = (workItem, events) => {
  const history = events.map((entry, index) => {
    const at = new Date(FIXED_NOW - (events.length - 1 - index) * 60_000).toISOString()
    return { at, work_item: workItem, workflow: 'solo', ...complete(entry) }
  })
  return gateHistory(workItem, history)
}

const itemsOf = (workItem, events) => {
  const custody = ledger(workItem, events)
  return new Map([[workItem, {
    work_item: workItem, workflow: 'solo', custody,
    current_event: custody[custody.length - 1].event,
    terminal: custody[custody.length - 1].terminal || '',
    legs: custody.filter((entry) => entry.event === 'assigned').length,
  }]])
}

const ADMITTED = [
  { event: 'opened', agent_id: 'b_d', to_team: 'build', reason: 'first team on the route', actor: 'human:tester' },
  { event: 'intake', agent_id: 'b_d', verdict: 'accept' },
]

// One failed leg, `n` deep. `observed` is the ONE fact this file keys a
// fallback on — never a terminal string (see the "genuine failure" tests
// below, which use the same terminal with the opposite `observed`).
const failedLeg = (n, observed) => ([
  { event: 'assigned', agent_id: 'b_w1', task_id: `t-${n}` },
  { event: 'delivered', agent_id: 'b_w1', task_id: `t-${n}`, terminal: 'protocol-error', work_observed: observed },
])

const planFor = (graph, events) =>
  planDispatches(graph, itemsOf('tok', events), new Set()).find((plan) => plan.work_item === 'tok')

// ── AC1: a palette dispatches from it, starting point first ─────────────────

test('a fresh admission on a palette seat dispatches candidate 0 — "the starting point" (§3.5)', () => {
  const plan = planFor(PALETTE_GRAPH, ADMITTED)
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w1')
  assert.deepEqual(plan.candidate, PALETTE[0])
})

test('one transport failure advances to candidate 1, in declared order', () => {
  const plan = planFor(PALETTE_GRAPH, [...ADMITTED, ...failedLeg(1, false)])
  assert.equal(plan.action, 'dispatch')
  assert.deepEqual(plan.candidate, PALETTE[1])
})

test('two transport failures advance to candidate 2', () => {
  const plan = planFor(PALETTE_GRAPH, [...ADMITTED, ...failedLeg(1, false), ...failedLeg(2, false)])
  assert.equal(plan.action, 'dispatch')
  assert.deepEqual(plan.candidate, PALETTE[2])
})

// ── the full-cycle escalation, and that it is a TIGHTER bound than legCeiling ─

test('a full cycle with nothing answering escalates instead of retrying candidate 0 (§3.5)', () => {
  const events = [...ADMITTED, ...failedLeg(1, false), ...failedLeg(2, false), ...failedLeg(3, false)]
  const plan = planFor(PALETTE_GRAPH, events)
  assert.equal(plan.action, 'escalate', `expected escalate, got ${plan.action}: ${plan.reason}`)
  assert.match(plan.reason, /3-entry palette has taken 3 transport failure/)
  assert.match(plan.reason, /3 transport failure/)
  // The tighter, palette-scoped bound fires with only 3 of the legCeiling's 15
  // still spent — legCeiling (§4.10: every `assigned` counts, unconditionally)
  // is nowhere near exhausted, so this escalation is NOT the pre-existing
  // `legs >= ceiling` guard firing under a different name.
  const legs = itemsOf('tok', events).get('tok').legs
  assert.equal(legs, 3)
})

test('legCeiling still counts every palette leg unconditionally — a palette is not free against it', () => {
  // This test used to compute `itemsOf(...).legs` and assert it equalled the
  // number of `assigned` events in its own fixture — true of the FIXTURE
  // whatever `nextStep` does with it, and therefore no proof at all that a
  // palette leg counts. The v0.15.0 release review named it a fixture
  // tautology at confidence 1.00 and was right. It now goes through the real
  // dispatch path instead.
  //
  // MAX_LEGS is 15. Fifteen transport-failed legs on a PALETTE seat: if the
  // ceiling guard counted palette legs at a discount — or skipped them the way
  // `attemptsBy` skips them for the ATTEMPT budget — this token would still be
  // dispatchable. It is not.
  const events = [...ADMITTED]
  for (let n = 1; n <= 15; n += 1) events.push(...failedLeg(n, false))
  const plan = planFor(PALETTE_GRAPH, events)

  assert.equal(plan.action, 'escalate')
  // The CEILING reason, not the palette-cycle one — which also pins the order
  // `nextStep` asks these two questions in. A palette walk cannot outrun the
  // ceiling by escalating on its own tighter bound first.
  assert.match(plan.reason, /15 legs on one token against a ceiling of 15/)
})

// ── a genuine failure retries the SAME candidate, never advances ────────────

test('a genuine worker failure (work_observed: true) retries candidate 0 rather than advancing', () => {
  // Same terminal `failedLeg` uses for a transport failure — the ONLY
  // difference is `work_observed`, on purpose: a fix keyed off the terminal
  // string would advance the palette on a failure that reached the model too.
  const plan = planFor(PALETTE_GRAPH, [...ADMITTED, ...failedLeg(1, true)])
  assert.equal(plan.action, 'dispatch')
  assert.deepEqual(plan.candidate, PALETTE[0], 'a genuine failure moved to the next candidate instead of retrying this one')
})

test('a lost leg (§4.10: never read as "never started") retries candidate 0 rather than advancing', () => {
  const plan = planFor(PALETTE_GRAPH, [
    ...ADMITTED,
    { event: 'assigned', agent_id: 'b_w1', task_id: 't-1' },
    { event: 'lost', agent_id: 'b_w1', task_id: 't-1', reason: 'no live process' },
  ])
  assert.equal(plan.action, 'dispatch')
  assert.deepEqual(plan.candidate, PALETTE[0], 'a lost leg with no delivered line advanced the palette')
})

test('a genuine failure between two transport failures still advances only on the transport ones', () => {
  // miss, genuine fail (counts as an ATTEMPT, not a miss), miss — candidate
  // index tracks misses only (2), not legs (3).
  const events = [...ADMITTED, ...failedLeg(1, false), ...failedLeg(2, true), ...failedLeg(3, false)]
  const plan = planFor(PALETTE_GRAPH, events)
  assert.equal(plan.action, 'dispatch')
  assert.deepEqual(plan.candidate, PALETTE[2])
})

// ── resume restarts the cycle at candidate 0 ─────────────────────────────────

test('a controller resume restarts the palette at candidate 0, like attemptsBy already resets', () => {
  const events = [
    ...ADMITTED, ...failedLeg(1, false), ...failedLeg(2, false),
    { event: 'escalated', agent_id: 'pm', to_team: 'build', task_id: 'controller-task', reason: 'palette cycled' },
    { event: 'resumed', agent_id: 'pm', to_team: 'build', grant: 3 },
  ]
  const plan = planFor(PALETTE_GRAPH, events)
  assert.equal(plan.action, 'dispatch')
  assert.deepEqual(plan.candidate, PALETTE[0])
})

// ── a worker_hint names a SEAT (§4.9, unchanged); the palette is that seat's
// own concern either way — `dispatchOn` is reached identically from the hint
// branch and the free-pick branch of `want` ─────────────────────────────────

const TWO_WORKER_PALETTE_GRAPH = graphOf({
  ...BASE,
  teams: [teamOf({ worker_ids: ['b_w1', 'b_w2'], seats: { b_w1: { palette: PALETTE_DECLARED } } }), CONTROL_TEAM],
})

const hintedAdmitted = (hint) => [
  { event: 'opened', agent_id: 'b_d', to_team: 'build', reason: 'first team on the route', actor: 'human:tester' },
  { event: 'intake', agent_id: 'b_d', verdict: 'accept', worker_hint: hint },
]

test('a worker_hint naming a palette seat still resolves THAT seat\'s own candidate, hint path or not', () => {
  // One prior transport failure on b_w1 before the hint is even honoured —
  // proving the hint branch of `want` reaches the same `dispatchOn` the
  // free-pick branch does, not a copy of it that forgot the palette.
  const plan = planFor(TWO_WORKER_PALETTE_GRAPH, [...hintedAdmitted('b_w1'), ...failedLeg(1, false)])
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w1')
  assert.deepEqual(plan.candidate, PALETTE[1])
})

test('a worker_hint naming the OTHER, no-palette seat is unaffected by its sibling\'s palette', () => {
  const plan = planFor(TWO_WORKER_PALETTE_GRAPH, hintedAdmitted('b_w2'))
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w2')
  assert.equal('candidate' in plan, false)
})

// ── AC3: a seat with no palette is unaffected — the property most likely to
// break silently ────────────────────────────────────────────────────────────

test('a seat with no palette dispatches with no `candidate` field at all', () => {
  const plan = planFor(NO_PALETTE_GRAPH, ADMITTED)
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w1')
  assert.equal('candidate' in plan, false, 'a no-palette seat\'s plan gained a new key')
})

test('a seat with no palette still retries the same seat after a transport failure, unchanged', () => {
  const plan = planFor(NO_PALETTE_GRAPH, [...ADMITTED, ...failedLeg(1, false)])
  assert.equal(plan.action, 'dispatch')
  assert.equal(plan.agent_id, 'b_w1')
  assert.equal('candidate' in plan, false)
})

test('a seat with no palette still escalates at MAX_ATTEMPTS genuine failures, unchanged', () => {
  const events = [...ADMITTED, ...failedLeg(1, true), ...failedLeg(2, true), ...failedLeg(3, true)]
  const plan = planFor(NO_PALETTE_GRAPH, events)
  assert.equal(plan.action, 'escalate')
  assert.match(plan.reason, /3 worker attempts/)
})

// ── AC1/AC2 (as far as reachable), end to end: the REAL child env a palette
// fallback would spawn, not merely what the plan says it would ─────────────

test('a palette seat\'s second leg spawns the process with the SECOND candidate\'s model/adapter/effort, for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-palette-dispatch-'))
  try {
    const store = join(dir, '.tmux-teams')
    mkdirSync(join(store, 'work-items'), { recursive: true })
    mkdirSync(join(store, 'team-briefs'), { recursive: true })
    writeFileSync(join(store, 'team-briefs', 'build.md'), '# standing brief\n')
    const palette = [
      { model: 'model-a', adapter: 'claude', effort: 'low', bucket: 'bucket-a' },
      { model: 'model-b', adapter: 'codex', effort: 'high', bucket: 'bucket-b' },
    ]
    const graph = { ...BASE, teams: [teamOf({ seats: { b_w1: { palette } } }), CONTROL_TEAM] }
    writeFileSync(join(store, 'graph.json'), JSON.stringify(graph))
    writeFileSync(join(store, 'work-items', 'tok.jsonl'),
      `${ledger('tok', [...ADMITTED, ...failedLeg(1, false)]).map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const captured = []
    const spawnFn = (cmd, args, options) => {
      captured.push({ args, env: options.env })
      return { unref() {} }
    }
    tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnFn })

    const workerLeg = captured.find((call) => call.env.ACP_AGENT_ID === 'b_w1')
    assert.ok(workerLeg, `no worker leg was spawned: ${JSON.stringify(captured.map((c) => c.env.ACP_AGENT_ID))}`)
    assert.equal(workerLeg.env.ACP_MODEL, 'model-b', 'the spawned process did not request the SECOND candidate\'s model')
    assert.equal(workerLeg.env.ACP_EXPECT_MODEL, 'model-b')
    assert.equal(workerLeg.env.ACP_REASONING_EFFORT, 'high')
    // args: [COMPANION, adapter, repo, taskId, briefPath, stallSec] — `dispatch`'s
    // own positional contract (loop-runner.mjs). The adapter is the SECOND
    // candidate's lane, not the seat's role default.
    assert.equal(workerLeg.args[1], 'codex', 'the spawned process did not run on the SECOND candidate\'s adapter')
    // Each candidate gets its OWN task_id, minted the same way any retry's
    // always has (`buildTaskId`, unchanged) — never the failed leg's own id
    // reused. This is the leg-identity decision: a fallback candidate is a
    // NEW leg, not a retry of the old one's identity, so ledger-validate's
    // duplicate_task_id rule (line ~522) is never in tension with a palette.
    assert.notEqual(workerLeg.args[3], 't-1', 'the fallback leg reused the failed leg\'s own task_id')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// v0.15.0 release review (gpt-5.6-luna), CONFIRMED. `misses` is a scalar and a
// genuine failure retries the SAME entry, so an entry CAN reach the model
// between two misses while the counter still reaches palette.length. The
// escalation reason used to say "no candidate ever reaching the model", which
// this exact sequence disproves. Nothing pinned that clause, which is how
// AC106 stayed green describing a stronger property than the code has.

test('the escalation reason claims only what was counted, never that no entry reached the model', () => {
  const events = [
    ...ADMITTED,
    ...failedLeg(1, false), // miss on candidate 0
    ...failedLeg(2, true),  // candidate 1 REACHED the model, then failed for real
    ...failedLeg(3, false), // miss on candidate 1 (a genuine failure did not advance)
    ...failedLeg(4, false), // miss on candidate 2 — misses now 3 on a 3-entry palette
  ]
  const plan = planFor(PALETTE_GRAPH, events)
  assert.equal(plan.action, 'escalate')
  assert.doesNotMatch(plan.reason, /ever reaching the model/,
    'the reason must not assert something this ledger contradicts — leg 2 reached the model')
  assert.match(plan.reason, /3 transport failure/)
})
