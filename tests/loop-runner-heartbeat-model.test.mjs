// loop-runner-heartbeat-model.test.mjs — the three decisions the runner half of
// this change is accountable for.
//
// DECISION 2 (heartbeat): the runner stamps its own pulse on EVERY tick,
// including the ticks it refuses to dispatch on. The failure this prevents is
// specific: a heartbeat that only appears when things are healthy says either
// "alive and dispatching" or nothing at all, and "nothing at all" is the same
// silence a dead process leaves. So every refusing path is tested by name.
//
// DECISION 3 (model): a dispatch declares the model its seat was assigned —
// EXCEPT when the declared model is the sentinel, because acp-companion treats
// a requested model as a promise and fails the whole dispatch when the adapter
// does not acknowledge it.
//
// DECISION 4 (ledger): a token's history is validated before a new leg is
// dispatched onto it, and every line this runner writes goes through the one
// writer that stamps an accountable actor.
//
// The heartbeat tests deliberately round-trip through `graph.mjs`'s real reader
// rather than asserting on the JSON alone. Two halves of one contract that were
// only ever tested against their own assumptions is how a writer and a reader
// come to disagree about the same file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loopHealth, readRunnerHeartbeat } from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import {
  INHERIT_ACCOUNT_DEFAULT, RUNNER_HEARTBEAT_FILE, applyHarvest,
  childEnv, declaredAdapter, declaredModel, modelEnv, tick,
  LOOP_FORWARDED_ACP_CONTROLS,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

// A real declared name, used only to prove a NON-sentinel value is passed
// through. It is not a claim that any adapter acknowledges it — see the
// comment on the pass-through test.
const A_DECLARED_MODEL = 'some-declared-model'

// `workers` overridable so the control team can name the outer controller as
// its one seat — D6 (2026-08-08) requires every graph to declare one.
const team = (id, model, workers = null) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: workers ?? [`${id}_w1`],
  evaluator_id: `${id}_e`,
  models: { dispatcher: model, worker: model, evaluator: model },
})

const graphDecl = ({ model = INHERIT_ACCOUNT_DEFAULT, pmModel = INHERIT_ACCOUNT_DEFAULT } = {}) => ({
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: pmModel,
  teams: [team('build', model), team('test', model), team('control', model, ['pm'])],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'test'] }],
})

const dirs = []
function repoWith({ graph = graphDecl(), ledgers = {}, pulseAgeSec = 5, rawGraph = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-runner-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'team-briefs'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'),
    JSON.stringify(rawGraph ?? graph, null, 2))
  for (const id of ['build', 'test']) {
    writeFileSync(join(dir, '.tmux-teams', 'team-briefs', `${id}.md`), `# ${id}\n\nDo the work.\n`)
  }
  // A snapshot that exists and is fresh: the runner refuses to dispatch on a
  // frozen one, which is a different test.
  writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
    generated_at: new Date(Date.now() - pulseAgeSec * 1000).toISOString(),
    runs: [],
  }))
  for (const [token, lines] of Object.entries(ledgers)) {
    writeFileSync(join(dir, '.tmux-teams', 'work-items', `${token}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  }
  return dir
}

test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })

const at = (index) => `2026-07-27T0${index}:00:00.000Z`

// A token that ran the whole route and was already read as a whole: terminal,
// so the tick has nothing to dispatch and nothing to escalate. That is what
// lets a healthy tick be tested without spawning a real agent.
const CLOSED = [
  { at: at(0), event: 'pulled', work_item: 'shipped', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
  { at: at(1), event: 'assigned', work_item: 'shipped', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-1', dispatch_id: 'd-1' },
  { at: at(2), event: 'delivered', work_item: 'shipped', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  { at: at(3), event: 'completed', work_item: 'shipped', workflow: 'feature', from_team: 'build' },
  { at: at(4), event: 'audit_requested', work_item: 'shipped', workflow: 'feature', agent_id: 'pm', task_id: 'pm-1', reason: 'read it' },
  { at: at(5), event: 'audited', work_item: 'shipped', workflow: 'feature', agent_id: 'pm', verdict: 'accept', reason: 'fine' },
]

// A token a team is actually holding: build accepted it and a worker is due.
const HELD = [
  { at: at(0), event: 'pulled', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
  { at: at(1), event: 'assigned', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', dispatch_id: 'd-i' },
  { at: at(2), event: 'delivered', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', terminal: 'done', timed_out: false, evidence_present: true },
  { at: at(3), event: 'intake', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', verdict: 'accept', reason: 'looks complete' },
]

// Captures what the runner said. The runner's log IS its report to an operator,
// so a decision that is not said out loud is a decision nobody can audit.
function saying(run) {
  const said = []
  const real = console.log
  console.log = (line) => { said.push(String(line)) }
  try { return { result: run(), said } } finally { console.log = real }
}

const beatOf = (dir) => JSON.parse(readFileSync(join(dir, '.tmux-teams', RUNNER_HEARTBEAT_FILE), 'utf8'))

// ── DECISION 2: the heartbeat ────────────────────────────────────────────────

test('a healthy tick stamps a heartbeat the page reads as dispatching', () => {
  const dir = repoWith({ ledgers: { shipped: CLOSED } })
  saying(() => tick(dir, { tickSec: 20 }))

  const beat = beatOf(dir)
  assert.equal(beat.schema, 'tmux-teams.runner-heartbeat')
  assert.equal(beat.dispatching, true)
  assert.equal(beat.tick_sec, 20)
  // A hold reason left on a healthy tick would have the runner explaining a
  // hold it is not doing.
  assert.equal(beat.reason, '')
  assert.equal(beat.started, 0, 'nothing was dispatchable, and 0 here is measured')
  assert.equal(beat.held, 0, 'the only token is closed, so no team is holding it')
  assert.match(beat.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  // The half of this contract that actually matters: the reader agrees.
  const health = loopHealth(readRunnerHeartbeat(dir), Date.parse(beat.at))
  assert.equal(health.state, 'dispatching')
})

test('a tick that refuses on a stale pulse still stamps, and says why', () => {
  // 600s beats the runner's own PULSE_STALE_SEC of 120.
  const dir = repoWith({ ledgers: { wip: HELD }, pulseAgeSec: 600 })
  const { result } = saying(() => tick(dir, { tickSec: 20 }))
  assert.equal(result.stale, true)

  const beat = beatOf(dir)
  // This is the whole point of DECISION 2. Without this stamp the worst state
  // the runner can be in is indistinguishable from the runner being dead.
  assert.equal(beat.dispatching, false)
  assert.match(beat.reason, /pulse\.json is \d+s old/)
  assert.equal(beat.started, 0)
  // The graph and the ledgers are both readable here, so this is a real count.
  assert.equal(beat.held, 1, 'build is still holding the token it refused to move')

  const health = loopHealth(readRunnerHeartbeat(dir), Date.parse(beat.at))
  assert.equal(health.state, 'holding')
  assert.match(health.detail, /pulse\.json is/)
})

test('a tick that refuses on an invalid graph still stamps, and does not invent a count', () => {
  // Valid JSON, invalid graph: no models on any seat. Unparseable JSON would
  // fall back to the bundled default and dispatch instead of refusing.
  const broken = graphDecl()
  delete broken.teams[0].models
  const dir = repoWith({ rawGraph: broken })
  const { result } = saying(() => tick(dir, { tickSec: 20 }))
  assert.equal(result.ok, false)

  const beat = beatOf(dir)
  assert.equal(beat.dispatching, false)
  assert.match(beat.reason, /team graph invalid/)
  // With no declared teams there is no occupancy to count. A zero would read as
  // an empty board rather than one that was never counted.
  assert.equal(beat.held, null)

  const health = loopHealth(readRunnerHeartbeat(dir), Date.parse(beat.at))
  assert.equal(health.state, 'holding')
  // The reader prints "not measured" rather than a zero it was never given.
  assert.equal(loopHealth({ present: true, value: { ...beat, dispatching: true }, reason: '' },
    Date.parse(beat.at)).detail.includes('held: not measured'), true)
})

test('a dry run does not stamp, so a simulation cannot impersonate a live runner', () => {
  const dir = repoWith({ ledgers: { shipped: CLOSED } })
  saying(() => tick(dir, { apply: false, tickSec: 20 }))
  const read = readRunnerHeartbeat(dir)
  assert.equal(read.present, false)
  assert.equal(loopHealth(read, Date.now()).state, 'never')
})

test('the runner is judged against the tick it declares, not a hard-coded one', () => {
  const dir = repoWith({ ledgers: { shipped: CLOSED } })
  saying(() => tick(dir, { tickSec: 600 }))
  const beat = beatOf(dir)
  // Five minutes of silence from a ten-minute loop is not a dead loop.
  const health = loopHealth(readRunnerHeartbeat(dir), Date.parse(beat.at) + 300_000)
  assert.equal(health.state, 'dispatching')
  // Past three of its own ticks it is.
  assert.equal(loopHealth(readRunnerHeartbeat(dir), Date.parse(beat.at) + 1_801_000).state, 'stale')
})

// ── DECISION 3: the declared model ───────────────────────────────────────────

test('the sentinel is never sent as a request, so the account default stands', () => {
  // acp-companion starts identity_status at `missing` the moment
  // ACP_EXPECT_MODEL is set and rejects the session receipt unless the adapter
  // answers with exactly that name. Sending the sentinel would therefore fail
  // every dispatch on a fresh install, on a name that was never a request.
  assert.deepEqual(modelEnv(INHERIT_ACCOUNT_DEFAULT), {})
  assert.deepEqual(modelEnv(''), {})
  assert.deepEqual(modelEnv(null), {})
  assert.deepEqual(modelEnv(undefined), {})
  assert.deepEqual(modelEnv('   '), {})
})

// Every dispatch spawned the literal string `claude` whatever the graph said,
// so a seat could declare a model only another lane answers to and still be
// handed to Claude. These fail if the lane stops travelling from the seat to
// the spawn, or if an unknown lane stops being refused at validation.
test('a seat runs on the lane it declares, and an unknown lane is refused', () => {
  const declared = validateWorkflowGraph({
    ...graphDecl(),
    outer_controller_adapter: 'codex',
    teams: [
      { ...team('build', A_DECLARED_MODEL), adapters: { dispatcher: 'agy', worker: 'codex', evaluator: 'claude' } },
      team('test', A_DECLARED_MODEL),
      team('control', A_DECLARED_MODEL, ['pm']),
    ],
  })
  assert.equal(declared.ok, true, declared.reason ?? '')
  assert.equal(declaredAdapter(declared.value, 'build', 'build_d'), 'agy')
  assert.equal(declaredAdapter(declared.value, 'build', 'build_w1'), 'codex')
  assert.equal(declaredAdapter(declared.value, 'build', 'build_e'), 'claude')
  assert.equal(declaredAdapter(declared.value, null, 'pm'), 'codex')
  // A graph written before seats could name a lane keeps its meaning.
  const silent = validateWorkflowGraph(graphDecl())
  assert.equal(silent.ok, true, silent.reason ?? '')
  assert.equal(declaredAdapter(silent.value, 'build', 'build_w1'), 'claude')
  assert.equal(declaredAdapter(silent.value, null, 'pm'), 'claude')

  const unknown = validateWorkflowGraph({
    ...graphDecl(),
    teams: [{ ...team('build', A_DECLARED_MODEL), adapters: { worker: 'gemini-cli' } }, team('test', A_DECLARED_MODEL),
      team('control', A_DECLARED_MODEL, ['pm'])],
  })
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /unknown adapter/)
})

// Reading the lane off the seat is not the same fact as spawning it. The gap
// between a value that exists and a value that is used is exactly how the
// declared MODEL went unrequested for as long as it did, so this asserts at the
// point of use.
test('the declared lane reaches the dispatch, not just the graph', () => {
  const dir = repoWith({
    graph: {
      ...graphDecl({ model: A_DECLARED_MODEL }),
      teams: [
        { ...team('build', A_DECLARED_MODEL), adapters: { dispatcher: 'codex', worker: 'codex', evaluator: 'codex' } },
        team('test', A_DECLARED_MODEL),
        team('control', A_DECLARED_MODEL, ['pm']),
      ],
    },
    ledgers: { wip: HELD },
  })
  const seen = []
  saying(() => tick(dir, {
    apply: true, tickSec: 20, scratchDir: join(dir, 'scratch'),
    spawnLeg: (repo, plan) => { seen.push(plan); return `t-${seen.length}` },
  }))
  assert.ok(seen.length > 0, 'nothing was dispatched, so nothing was proved')
  for (const plan of seen) {
    if (plan.team === 'build') assert.equal(plan.adapter, 'codex', JSON.stringify(plan))
  }
})

// The companion prefers an ambient ACP_CMD over the adapter its lane names, so
// one left in a shell silently replaced the adapter every seat in the loop ran
// on. Production dispatch must not carry it; a test that needs the seam has to
// name it. Goes red if childEnv stops filtering.
test('an ambient ACP_CMD never reaches a dispatched worker', () => {
  const ambient = childEnv({ PATH: '/bin', ACP_CMD: 'node /somebody-elses-adapter.mjs' })
  assert.equal('ACP_CMD' in ambient, false, JSON.stringify(ambient))
  assert.equal(ambient.PATH, '/bin')

  const named = childEnv({ PATH: '/bin', ACP_CMD: 'node /stale.mjs', TMUX_TEAMS_ACP_CMD: 'node /mock.mjs' })
  assert.equal(named.ACP_CMD, 'node /mock.mjs')
  assert.equal('TMUX_TEAMS_ACP_CMD' in named, false)
})

// `acp-companion.mjs` states it in its own comment: no ordinary caller,
// loop-runner included, may hand a lane the terminal capability. It was reaching
// one from any shell that still had the login-mode opt-in exported —
// `ACP_ENABLE_TERMINAL=1 node -e "childEnv().ACP_ENABLE_TERMINAL"` printed "1".
// `acp-dispatch.mjs` had the identical shape and was closed one review round
// earlier; this door stayed open because nobody went looking for the second one.
//
// This proves the FUNCTION. The call site is proved separately, in
// tests/loop-runner-palette-dispatch.test.mjs, because deleting the childEnv()
// call from dispatch would leave this test green.
// Three doors of one shape have now been closed one review round apart:
// ACP_CMD, then ACP_ENABLE_TERMINAL, then ACP_SPAWN_NONCE. Each time the fix
// was for the variable that had been NAMED, and each time the next one was
// still open. This test is the shape rather than the list: whatever ACP_*
// variables a caller's shell is carrying, a dispatched worker sees only what
// this runner decided to give it.
//
// The allowed set is written out. A test that derived it from `childEnv`'s own
// destructuring would agree with whatever that line says, including a line
// somebody widened.
test('no ambient ACP_ variable survives childEnv except the ones this runner re-supplies', () => {
  const ambient = {
    PATH: '/bin',
    ACP_CMD: 'node /somebody-elses-adapter.mjs',
    ACP_ENABLE_TERMINAL: '1',
    ACP_SPAWN_NONCE: 'a-stale-nonce-from-a-hand-run',
    ACP_MODEL: 'somebody-elses-model',
    ACP_EXPECT_MODEL: 'somebody-elses-expectation',
    ACP_REASONING_EFFORT: 'low',
    ACP_SESSION_OPERATION: 'load',
    ACP_RESUME: 'somebody-elses-session',
    // The documented operator controls, mixed in with the hostile ones. They
    // MUST survive: finding 3835247721 is that the shape above dropped them
    // too, so a loop launched with a wall-clock ceiling ran without one.
    ACP_HARD_TIMEOUT_SEC: '900',
    ACP_STALL_POLICY: 'report',
    ACP_CANCEL_GRACE_MS: '100',
    ACP_CANCEL_GRACE_SEC: '7',
    ACP_PROCESS_KILL_GRACE_MS: '100',
  }
  const passed = childEnv(ambient)
  const survivors = Object.keys(passed).filter((k) => k.startsWith('ACP_')).sort()
  // `dispatch()` supplies model, effort, agent id and the rest deliberately
  // AFTER this call. Nothing ambient is entitled to arrive on its own EXCEPT
  // the controls the skill invites an operator to set.
  assert.deepEqual(survivors, [
    'ACP_CANCEL_GRACE_MS', 'ACP_CANCEL_GRACE_SEC', 'ACP_HARD_TIMEOUT_SEC',
    'ACP_PROCESS_KILL_GRACE_MS', 'ACP_STALL_POLICY',
  ], `wrong ACP_ variables reached a worker: ${survivors.join(', ')}`)
  assert.equal(passed.ACP_HARD_TIMEOUT_SEC, '900',
    'the wall-clock ceiling an operator set never reached the lane it was meant to bound')
  assert.equal(passed.PATH, '/bin', 'the filter ate something it was not asked to')

  // And the one ACP_ variable this runner DOES set, from its own explicit
  // dependency rather than from the environment.
  const named = childEnv({ ...ambient, TMUX_TEAMS_ACP_CMD: 'node /mock.mjs' })
  assert.equal(named.ACP_CMD, 'node /mock.mjs')
  assert.equal('TMUX_TEAMS_ACP_CMD' in named, false)
  assert.equal('ACP_SPAWN_NONCE' in named, false, 'a stale nonce rode in beside the injected adapter')
})

// The names this runner OWNS: identity, routing, session lineage, adapter
// selection and capability opt-ins. A leg gets whatever `dispatch()` decided,
// never whatever the operator's shell was carrying. `ACP_TEST_*` is owned as a
// CLASS by prefix — a test seam reaching a production lane is the same hazard
// this filter exists for, and there are eleven of them.
const LOOP_OWNED_ACP = [
  'ACP_AGENT_ID', 'ACP_CMD', 'ACP_CONTROL_LOG', 'ACP_ENABLE_TERMINAL',
  'ACP_EXECUTION_PROFILE', 'ACP_EXPECT_MODEL', 'ACP_EXPECT_REASONING_EFFORT',
  'ACP_INHERIT_PROJECT_CONFIG', 'ACP_KMS_AUTO', 'ACP_LIVENESS_TICK_MS',
  'ACP_LIVENESS_WRITE_INTERVAL_MS', 'ACP_MODEL', 'ACP_PRIOR_DISPATCH_ID',
  'ACP_ENV_PASSTHROUGH', 'ACP_PRIOR_RECEIPT_DIGEST', 'ACP_PROCESS_REAP_GRACE_MS',
  'ACP_REASONING_EFFORT', 'ACP_RESUME', 'ACP_SESSION_OPERATION',
  'ACP_SESSION_RECEIPT_REQUIRED', 'ACP_SPAWN_NONCE',
  'ACP_TERMINAL_CLOSE_GRACE_MS', 'ACP_TERMINAL_KILL_GRACE_MS',
]

// WHY THIS TEST EXISTS AND NOT JUST THE ONE ABOVE. Deny-by-default is only
// fail-closed if somebody NOTICES an unclassified knob, and nobody reads a
// filter in one file while adding an env read in another. This reads the
// companion's own source: every ACP_ name it consumes must be in one list or
// the other, so a new knob turns THIS red instead of being silently dropped in
// production and found by a review bot two releases later.
//
// SCAN EVERY ACP_ IDENTIFIER, not the ways of reading one. This test was first
// written with two patterns — `process.env.X` and `requestedConfigOverride('X')`
// — on the reasoning that those were the two ways the companion read an env
// var. **Within the hour a knob landed through a third**
// (`strictNonNegativeEnvNumber('ACP_TERMINAL_CLOSE_GRACE_MS', 2000)`) and this
// test reported full coverage over 35 names while 39 existed. Enumerating the
// READING HELPERS is the same list problem one level up, and it rotted faster
// than the list it was written to protect.
//
// So the scan is every `ACP_*` identifier in the file. Over-inclusive is the
// safe direction: a name that is not an env var costs one line in a list,
// while a name that is missed costs a silently dropped operator control.
// Prefix FRAGMENTS used to build names (`ACP_EXPECT_`, `ACP_TEST_RECEIPT_`) are
// excluded by the one property that distinguishes them — a real variable name
// does not end in an underscore — rather than by naming them.
test('every ACP_ variable the companion reads is classified as forwarded or owned', () => {
  const src = readFileSync(
    new URL('../plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs', import.meta.url), 'utf8')
  const names = new Set([...src.matchAll(/\bACP_[A-Z0-9_]+/g)]
    .map((m) => m[0]).filter((name) => !name.endsWith('_')))
  // A scan that quietly stops matching reports perfect classification.
  assert.ok(names.size >= 39,
    `the companion scan found only ${names.size} ACP_ names — the pattern stopped matching`)
  // Three names, each read a DIFFERENT way, pinned so a narrowed scan is caught:
  // a plain member access, a config-override call, and a helper call.
  assert.ok(names.has('ACP_SPAWN_NONCE'), 'the scan missed a plain process.env read')
  assert.ok(names.has('ACP_MODEL'), 'the scan missed a requestedConfigOverride name')
  assert.ok(names.has('ACP_TERMINAL_CLOSE_GRACE_MS'),
    'the scan missed a name read through an env helper — the exact hole that made this test lie')

  const unclassified = [...names].filter((n) => !LOOP_FORWARDED_ACP_CONTROLS.includes(n)
    && !LOOP_OWNED_ACP.includes(n) && !n.startsWith('ACP_TEST_')).sort()
  assert.deepEqual(unclassified, [],
    'the companion reads ACP_ variables this runner has never classified — decide for each whether it is '
    + `an operator control or this runner's, rather than leaving it to the prefix: ${unclassified.join(', ')}`)

  // Pinned literally, both of them. A test that read either list back from the
  // module would agree with a line somebody widened, which is the failure this
  // repository has now written down three times.
  assert.deepEqual([...LOOP_FORWARDED_ACP_CONTROLS], [
    'ACP_CANCEL_GRACE_MS', 'ACP_CANCEL_GRACE_SEC', 'ACP_HARD_TIMEOUT_SEC',
    'ACP_PROCESS_KILL_GRACE_MS', 'ACP_STALL_POLICY',
  ], 'the forwarded operator surface changed — SKILL.md documents it and must change with it')
  assert.equal(LOOP_OWNED_ACP.length, 23)
})

test('an ambient ACP_ENABLE_TERMINAL never reaches a dispatched worker', () => {
  const ambient = childEnv({ PATH: '/bin', ACP_ENABLE_TERMINAL: '1' })
  assert.equal('ACP_ENABLE_TERMINAL' in ambient, false, JSON.stringify(ambient))
  assert.equal(ambient.PATH, '/bin', 'the filter ate something it was not asked to')
  // '0' is a legal value the companion accepts, and it is dropped too: the
  // point is that this caller never speaks about terminals at all.
  assert.equal('ACP_ENABLE_TERMINAL' in childEnv({ PATH: '/bin', ACP_ENABLE_TERMINAL: '0' }), false)
})

// This test was named for the request and asserted only the expectation, so it
// passed for as long as the loop demanded a model it never asked for. ACP_MODEL
// is what makes the adapter become the name; ACP_EXPECT_MODEL is what refuses
// the dispatch if it did not. A declared seat needs both.
test('a real declared name is passed through as the request', () => {
  const both = { ACP_MODEL: A_DECLARED_MODEL, ACP_EXPECT_MODEL: A_DECLARED_MODEL }
  assert.deepEqual(modelEnv(A_DECLARED_MODEL), both)
  // Whitespace is the declarer's, not the adapter's.
  assert.deepEqual(modelEnv(`  ${A_DECLARED_MODEL}  `), both)
})

test('the model comes off the seat the agent actually sits in', () => {
  const graph = validateWorkflowGraph(graphDecl({ model: A_DECLARED_MODEL, pmModel: 'pm-model' }))
  assert.equal(graph.ok, true, graph.reason ?? '')

  for (const agentId of ['build_d', 'build_w1', 'build_e']) {
    assert.equal(declaredModel(graph.value, 'build', agentId), A_DECLARED_MODEL)
  }
  // The outer controller is in no team, so it must not be looked up in one.
  assert.equal(declaredModel(graph.value, null, 'pm'), 'pm-model')
  assert.equal(declaredModel(graph.value, 'build', 'pm'), 'pm-model')
  // An agent that is not in the team it was asked about yields nothing rather
  // than another team's model.
  assert.equal(declaredModel(graph.value, 'test', 'build_w1'), '')
})

test('the runner says which model each dispatch will ask for', () => {
  // A dry run, so nothing is spawned. This proves the graph -> plan -> seat
  // lookup is wired; it does not prove any adapter acknowledges the name.
  const named = repoWith({ graph: graphDecl({ model: A_DECLARED_MODEL }), ledgers: { wip: HELD } })
  const { said } = saying(() => tick(named, { apply: false, tickSec: 20 }))
  const line = said.find((entry) => entry.includes('would dispatch build_w1'))
  assert.ok(line, `no dispatch was planned: ${said.join(' | ')}`)
  assert.match(line, new RegExp(`model=${A_DECLARED_MODEL}`))

  const inherited = repoWith({ ledgers: { wip: HELD } })
  const plain = saying(() => tick(inherited, { apply: false, tickSec: 20 }))
    .said.find((entry) => entry.includes('would dispatch build_w1'))
  assert.ok(plain)
  assert.match(plain, /model=account default \(none requested\)/)
  assert.doesNotMatch(plain, new RegExp(INHERIT_ACCOUNT_DEFAULT))
})

// ── DECISION 4: the ledger ───────────────────────────────────────────────────

test('a token whose history cannot be believed is not dispatched onto', () => {
  // The seed `pulled` carries no `from_team`, which contract ข้อ 4 requires.
  const bad = HELD.map((entry, index) => (index === 0 ? { ...entry, from_team: undefined } : entry))
  const dir = repoWith({ ledgers: { wip: bad } })
  const { said } = saying(() => tick(dir, { apply: false, tickSec: 20 }))

  // Loudly: a silent skip here looks exactly like a team with nothing to do.
  const refusal = said.find((entry) => entry.startsWith('[loop] LEDGER wip'))
  assert.ok(refusal, `the refusal was not said out loud: ${said.join(' | ')}`)
  assert.match(refusal, /refusing to dispatch/)
  assert.ok(said.some((entry) => entry.includes('missing_field')), 'the defect itself was not named')
  assert.equal(said.some((entry) => entry.includes('would dispatch build_w1')), false,
    'a leg was planned onto a broken history')
})

test('a valid history still dispatches, so the gate is a gate and not a wall', () => {
  const dir = repoWith({ ledgers: { wip: HELD } })
  const { said } = saying(() => tick(dir, { apply: false, tickSec: 20 }))
  assert.ok(said.some((entry) => entry.includes('would dispatch build_w1')))
  assert.equal(said.some((entry) => entry.startsWith('[loop] LEDGER')), false)
})

test('every line the runner appends names an accountable actor', () => {
  const dir = repoWith({ ledgers: { wip: HELD } })
  // The evaluator's leg finished and its verdict is waiting in the outbox.
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.mailbox-out', 'b-r'), 'It builds.\nVERDICT: pass\n')
  const custody = [...HELD,
    { at: at(4), event: 'assigned', work_item: 'wip', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-2', dispatch_id: 'd-2' },
    { at: at(5), event: 'delivered', work_item: 'wip', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-2', terminal: 'done', timed_out: false, evidence_present: true },
    { at: at(6), event: 'assigned', work_item: 'wip', workflow: 'feature', agent_id: 'build_e', task_id: 'b-r', dispatch_id: 'd-r' },
    { at: at(7), event: 'delivered', work_item: 'wip', workflow: 'feature', agent_id: 'build_e', task_id: 'b-r', terminal: 'done', timed_out: false, evidence_present: true },
  ]
  writeFileSync(join(dir, '.tmux-teams', 'work-items', 'wip.jsonl'),
    `${custody.map((line) => JSON.stringify(line)).join('\n')}\n`)

  const graph = validateWorkflowGraph(graphDecl())
  const applied = saying(() => applyHarvest(dir, graph.value,
    [{ item: { work_item: 'wip', workflow: 'feature', custody }, last: custody[custody.length - 1], role: 'evaluator' }],
    new Date().toISOString())).result

  assert.equal(applied.length, 1)
  assert.equal(applied[0].event, 'reviewed')
  const written = readFileSync(join(dir, '.tmux-teams', 'work-items', 'wip.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
  const last = written[written.length - 1]
  assert.equal(last.event, 'reviewed')
  assert.equal(last.verdict, 'pass')
  // The evaluator stated the verdict, so the evaluator is the accountable
  // writer — not the runner that transcribed it.
  assert.equal(last.actor, 'agent:build_e')
})

test('an append the writer refuses is not reported as having happened', () => {
  const dir = repoWith({})
  // A history that is already broken: the writer refuses to add to it rather
  // than burying the break under good evidence.
  const custody = [
    { at: at(0), event: 'pulled', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', to_team: 'build' },
    { at: at(1), event: 'assigned', work_item: 'wip', workflow: 'feature', agent_id: 'build_e', task_id: 'b-r', dispatch_id: 'd-r' },
    { at: at(2), event: 'delivered', work_item: 'wip', workflow: 'feature', agent_id: 'build_e', task_id: 'b-r', terminal: 'done', timed_out: false, evidence_present: true },
  ]
  writeFileSync(join(dir, '.tmux-teams', 'work-items', 'wip.jsonl'),
    `${custody.map((line) => JSON.stringify(line)).join('\n')}\n`)
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.mailbox-out', 'b-r'), 'VERDICT: pass\n')

  const graph = validateWorkflowGraph(graphDecl())
  const { result, said } = saying(() => applyHarvest(dir, graph.value,
    [{ item: { work_item: 'wip', workflow: 'feature', custody }, last: custody[custody.length - 1], role: 'evaluator' }],
    new Date().toISOString()))

  assert.deepEqual(result, [], 'the runner claimed an event it never recorded')
  assert.ok(said.some((entry) => entry.includes('REFUSED') && entry.includes('ledger_already_invalid')),
    `the refusal was not said out loud: ${said.join(' | ')}`)
  const lines = readFileSync(join(dir, '.tmux-teams', 'work-items', 'wip.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, custody.length, 'a line reached a ledger that had already failed validation')
})

test('an intake refusal with nowhere to send it back names the team still holding it', () => {
  // ข้อ 4.2: without `to_team` the board draws parked work as unplaceable and
  // frees a WIP slot nobody released — and the writer refuses the line outright.
  const dir = repoWith({})
  const custody = [
    { at: at(0), event: 'pulled', work_item: 'seed', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
    { at: at(1), event: 'assigned', work_item: 'seed', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', dispatch_id: 'd-i' },
    { at: at(2), event: 'delivered', work_item: 'seed', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', terminal: 'done', timed_out: false, evidence_present: true },
  ]
  writeFileSync(join(dir, '.tmux-teams', 'work-items', 'seed.jsonl'),
    `${custody.map((line) => JSON.stringify(line)).join('\n')}\n`)
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.mailbox-out', 'b-i'), 'Not enough to start on.\nVERDICT: reject\n')

  const graph = validateWorkflowGraph(graphDecl())
  // The seed pull names `build` as its own sender, so strip it to reach the
  // branch where there is genuinely nowhere to return the work to.
  const orphaned = custody.map((entry, index) => (index === 0 ? { ...entry, from_team: '' } : entry))
  const applied = saying(() => applyHarvest(dir, graph.value,
    [{ item: { work_item: 'seed', workflow: 'feature', custody: orphaned }, last: orphaned[2], role: 'dispatcher' }],
    new Date().toISOString())).result

  assert.equal(applied.length, 1)
  assert.equal(applied[0].event, 'escalated')
  assert.equal(applied[0].to_team, 'build', 'the escalation did not name the team still holding the token')
})

test('a headless graph is refused at load, so the wedge it caused cannot happen', () => {
  // This test used to BUILD that wedge and assert its symptoms. The shape: a
  // graph with no `outer_controller_id` was accepted, the finished route raised
  // an audit trigger, the controller leg was dispatched and `pm-notes/latest.md`
  // written — and only THEN was the escalation mark refused, for want of an
  // `agent_id` the graph never had. The token's last event never changed, so the
  // trigger recurred and the unchanged-trigger brake held it for ever: a PM
  // dispatch bought for nothing, permanently.
  //
  // D6 (2026-08-08) refuses the configuration instead of documenting its
  // consequence. A graph naming no controller has no front door, no audit and
  // no seat to escalate to; it is not a supported way to run this system, and
  // the failure it produced arrived a whole dispatch too late to be legible.
  const headless = graphDecl()
  delete headless.outer_controller_id
  delete headless.outer_controller_model

  const refused = validateWorkflowGraph(headless)
  assert.equal(refused.ok, false, 'a graph with no controller is refused before anything is paid for')
  assert.match(refused.reason, /names nobody/)
  // The refusal has to name the consequence, not just the missing field: the
  // field being absent was survivable-looking for as long as this was accepted.
  assert.match(refused.reason, /no front door/)
  assert.match(refused.reason, /already been paid for/)
})

test('an accepted intake that stated no reason says so rather than leaving it blank', () => {
  const dir = repoWith({})
  const custody = [
    { at: at(0), event: 'pulled', work_item: 'quiet', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
    { at: at(1), event: 'assigned', work_item: 'quiet', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', dispatch_id: 'd-i' },
    { at: at(2), event: 'delivered', work_item: 'quiet', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', terminal: 'done', timed_out: false, evidence_present: true },
  ]
  writeFileSync(join(dir, '.tmux-teams', 'work-items', 'quiet.jsonl'),
    `${custody.map((line) => JSON.stringify(line)).join('\n')}\n`)
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.mailbox-out', 'b-i'), 'VERDICT: accept\n')

  const graph = validateWorkflowGraph(graphDecl())
  const applied = saying(() => applyHarvest(dir, graph.value,
    [{ item: { work_item: 'quiet', workflow: 'feature', custody }, last: custody[2], role: 'dispatcher' }],
    new Date().toISOString())).result

  assert.equal(applied.length, 1, 'a bare accept was refused instead of recorded')
  assert.equal(applied[0].event, 'intake')
  assert.equal(applied[0].reason, 'no reason stated')
})

test('a pull the writer refuses is not narrated as a pull that happened', () => {
  // ข้อ 4.2: "a refused write did not happen, and no caller may report it as
  // having happened." The runner logged every decision by the action it was
  // PLANNED with, so a refused handoff printed the same `pull` line a written
  // one does — and the loop planned it again the next tick, forever, while an
  // operator read a board that said the token had moved on.
  const custody = [
    { at: at(0), event: 'pulled', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
    { at: at(1), event: 'assigned', work_item: 'wip', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-9', dispatch_id: 'd-9' },
    { at: at(2), event: 'delivered', work_item: 'wip', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-9', terminal: 'done', timed_out: false, evidence_present: true },
    { at: at(3), event: 'reviewed', work_item: 'wip', workflow: 'feature', agent_id: 'build_e', verdict: 'pass', reviewed_task: 'b-9', reason: 'it works' },
  ]
  const dir = repoWith({ ledgers: { wip: custody } })
  const file = join(dir, '.tmux-teams', 'work-items', 'wip.jsonl')
  // Parsed readers drop this line; the writer, which reads the file, does not.
  writeFileSync(file, `${readFileSync(file, 'utf8')}{ this line is not JSON\n`)

  const { result, said } = saying(() => tick(dir, { tickSec: 20, spawnLeg: () => 'stub-task' }))

  const pull = result.pulls.find((entry) => entry.work_item === 'wip')
  assert.equal(pull.action, 'pull', 'the planner is meant to plan it — the writer is what refuses')
  assert.ok(said.some((line) => line.includes('REFUSED') && line.includes('wip') && line.includes('ledger_already_invalid')),
    `the refusal was not said out loud: ${said.join(' | ')}`)
  assert.equal(said.some((line) => /^\[loop\] pull\s+wip:/.test(line)), false,
    'the runner reported a handoff the ledger never took')
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, custody.length + 1,
    'a line reached a ledger that had already failed validation')
})
