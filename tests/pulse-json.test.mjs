import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, unlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  downProjectPulseV1,
  downProjectPulseV2,
  downProjectPulseV3,
  sanitizeTeamRuntimeProjection,
  validateAcpLivenessV1,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs'
import { validateTeamRuntime } from '../plugins/tmux-teams/skills/tmux-teams/scripts/team-runtime.mjs'
import { validateTeamGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/team-graph-contract.mjs'
import { PULSE_REFRESH_SOURCE } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-refresh.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')
const SCHEMA_DIR = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'references')
const SCHEMA_PATH = join(SCHEMA_DIR, 'pulse-v4.schema.json')
const V3_SCHEMA_PATH = join(SCHEMA_DIR, 'pulse-v3.schema.json')
const V1_SCHEMA_PATH = join(SCHEMA_DIR, 'pulse-v1.schema.json')
const V2_SCHEMA_PATH = join(SCHEMA_DIR, 'pulse-v2.schema.json')
const TEAM_RUNTIME_SCHEMA_PATH = join(SCHEMA_DIR, 'team-runtime-v1.schema.json')
const V4_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const V3_SCHEMA = JSON.parse(readFileSync(V3_SCHEMA_PATH, 'utf8'))
const SCHEMA_DOCUMENTS = new Map([
  ['pulse-v1.schema.json', JSON.parse(readFileSync(V1_SCHEMA_PATH, 'utf8'))],
  ['pulse-v2.schema.json', JSON.parse(readFileSync(V2_SCHEMA_PATH, 'utf8'))],
  ['pulse-v3.schema.json', V3_SCHEMA],
  ['pulse-v4.schema.json', V4_SCHEMA],
  ['team-runtime-v1.schema.json', JSON.parse(readFileSync(TEAM_RUNTIME_SCHEMA_PATH, 'utf8'))],
])
const SCHEMA = { ...V4_SCHEMA, $defs: { ...V3_SCHEMA.$defs, ...V4_SCHEMA.$defs } }
const PULSE_SOURCE = readFileSync(PULSE, 'utf8')
const REFRESH_SOURCE = PULSE_REFRESH_SOURCE
const REFRESH_HASH = createHash('sha256').update(REFRESH_SOURCE).digest('hex')
const HAS_PYTHON_JSONSCHEMA = spawnSync('python3', ['-c', 'import jsonschema'], { encoding: 'utf8' }).status === 0
const LIVENESS_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures')
const TEMP_REPOS = new Set()
const DIGEST_A = `sha256:${'a'.repeat(64)}`

const ID_RE = new RegExp(SCHEMA.$defs.id.pattern)
const UUID_RE = new RegExp(SCHEMA.$defs.uuid.pattern)
const SNAPSHOT_RE = new RegExp(SCHEMA.properties.snapshot_id.pattern)
const ISO_TIMESTAMP_RE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?<zone>Z|[+-]\d{2}:\d{2})$/

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-json-'))
  TEMP_REPOS.add(dir)
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

function removeTempRepo(dir) {
  TEMP_REPOS.delete(dir)
  rmSync(dir, { recursive: true, force: true })
}

test.afterEach(() => {
  for (const dir of [...TEMP_REPOS]) removeTempRepo(dir)
})

function age(path, seconds) {
  const then = Date.now() / 1000 - seconds
  utimesSync(path, then, then)
}

function fakeTmuxEnv(dir, stderr, status = 1) {
  const bin = join(dir, 'fake-bin')
  mkdirSync(bin)
  const fakeTmux = join(bin, 'tmux')
  writeFileSync(fakeTmux, [
    '#!/bin/sh',
    `echo '${stderr}' >&2`,
    `exit ${status}`,
    '',
  ].join('\n'))
  chmodSync(fakeTmux, 0o755)
  return { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` }
}

function dispatchWithMissingPane(dir) {
  const dispatchPath = join(dir, '.tmux-teams', 'dispatch', 'missing-pane.md')
  writeFileSync(dispatchPath, [
    'task_id: missing-pane',
    'worker: codex',
    'transport: tmux',
    'pane: %424242',
    '',
  ].join('\n'))
  age(dispatchPath, 600)
}

function writePinnedClockPreload(dir, nowMs) {
  const preloadPath = join(dir, '.pulse-clock-preload.cjs')
  writeFileSync(preloadPath, [
    "'use strict'",
    'const NativeDate = globalThis.Date',
    `const pinnedNowMs = ${JSON.stringify(Number(nowMs))}`,
    'class PinnedDate extends NativeDate {',
    '  constructor(...args) { super(...(args.length ? args : [pinnedNowMs])) }',
    '  static now() { return pinnedNowMs }',
    '  static parse(...args) { return NativeDate.parse(...args) }',
    '  static UTC(...args) { return NativeDate.UTC(...args) }',
    '}',
    'globalThis.Date = PinnedDate',
    '',
  ].join('\n'))
  return preloadPath
}

function envWithPinnedClock(dir, env, nowMs) {
  const preloadPath = writePinnedClockPreload(dir, nowMs)
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(' '),
  }
}

function runJson(dir, env = process.env, extraArgs = [], pinnedNowMs = null) {
  const childEnv = pinnedNowMs === null ? env : envWithPinnedClock(dir, env, pinnedNowMs)
  const result = spawnSync(process.execPath, [PULSE, 'json', dir, ...extraArgs], {
    encoding: 'utf8', timeout: 10_000, env: childEnv,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^\s*\{/)
  assert.match(result.stdout, /\}\s*$/)
  let snapshot
  assert.doesNotThrow(() => { snapshot = JSON.parse(result.stdout) },
    'json stdout must contain exactly one JSON document and no log prose')
  const published = readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8')
  assert.equal(result.stdout, published, 'json stdout and pulse.json must be byte-for-byte identical')
  return { snapshot, stdout: result.stdout }
}

function stripIsoTimestamps(value) {
  if (typeof value === 'string') return ISO_TIMESTAMP_RE.test(value) ? '<timestamp>' : value
  if (Array.isArray(value)) return value.map(stripIsoTimestamps)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, stripIsoTimestamps(child)]))
  }
  return value
}

function collectIsoTimestamps(value, path = '$', result = []) {
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP_RE.test(value)) result.push([path, Date.parse(value)])
    return result
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectIsoTimestamps(child, `${path}[${index}]`, result))
    return result
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) =>
      collectIsoTimestamps(child, `${path}.${key}`, result))
  }
  return result
}

function rebaseExactLivenessFixture(source, effectiveNowMs = Date.now()) {
  const fixture = structuredClone(source)
  const originalObservedMs = Date.parse(source.observed_at)
  const targetNowMs = Number(effectiveNowMs)
  assert.ok(Number.isFinite(originalObservedMs), 'fixture observed_at must be a valid timestamp')
  assert.ok(Number.isFinite(targetNowMs), 'effective fixture clock must be finite')
  const deltaMs = (targetNowMs - 30_000) - originalObservedMs
  const shift = (value) => {
    if (typeof value === 'string') {
      return ISO_TIMESTAMP_RE.test(value) ? new Date(Date.parse(value) + deltaMs).toISOString() : value
    }
    if (Array.isArray(value)) return value.map(shift)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shift(child)]))
    }
    return value
  }
  return shift(fixture)
}

function writeExactLivenessFixture(dir, fixtureName, { graph = false, effectiveNowMs = Date.now() } = {}) {
  const source = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, fixtureName), 'utf8'))
  const fixture = rebaseExactLivenessFixture(source, effectiveNowMs)
  const dispatchPath = join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`)
  writeFileSync(dispatchPath, [
    `dispatch_id: ${fixture.dispatch_id}`,
    `task_id: ${fixture.task_id}`,
    `worker: ${fixture.worker}`,
    'transport: acp',
    ...(fixture.agent_id ? [`agent_id: ${fixture.agent_id}`] : []),
    `started_at: ${fixture.started_at}`,
    'timeout_sec: 600',
    '',
  ].join('\n'))
  const fixtureMtimeSec = Math.max(0, (Number(effectiveNowMs) - 1000) / 1000)
  utimesSync(dispatchPath, fixtureMtimeSec, fixtureMtimeSec)
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'liveness', `${fixture.task_id}.json`),
    `${JSON.stringify(fixture, null, 2)}\n`)
  if (!graph) return fixture
  const graphPath = join(dir, 'team-graph.json')
  writeFileSync(graphPath, `${JSON.stringify({
    graph: {
      project_id: 'fixture-project',
      teams: [{
        team_id: 'fixture-team',
        name: 'Fixture Team',
        dispatcher_id: 'fixture-dispatcher',
        worker_ids: [fixture.agent_id || 'fixture-worker'],
        evaluator_id: 'fixture-evaluator',
        downstream_team_id: null,
      }],
    },
  }, null, 2)}\n`)
  return { fixture, graphPath }
}

function runtimeGraph() {
  return {
    project_id: 'runtime-project',
    outer_controller_id: 'outer-control',
    teams: [{
      team_id: 'runtime-team', name: 'Runtime Team', dispatcher_id: 'runtime-dispatcher',
      worker_ids: ['runtime-worker-a', 'runtime-worker-b'], evaluator_id: 'runtime-evaluator',
      downstream_team_id: null,
    }],
  }
}

function runtimeGraphWithDownstream() {
  const graph = structuredClone(runtimeGraph())
  graph.teams[0].downstream_team_id = 'runtime-next'
  graph.teams.push({
    team_id: 'runtime-next', name: 'Runtime Next', dispatcher_id: 'runtime-next-dispatcher',
    worker_ids: ['runtime-next-worker'], evaluator_id: 'runtime-next-evaluator', downstream_team_id: null,
  })
  return graph
}

function validTeamRuntime(graphSourceDigest, nowMs = Date.now()) {
  const at = (offset) => new Date(nowMs + offset).toISOString()
  const ids = [
    ['outer-control', 'outer_controller', null],
    ['runtime-dispatcher', 'dispatcher', 'runtime-team'],
    ['runtime-worker-a', 'worker', 'runtime-team'],
    ['runtime-worker-b', 'worker', 'runtime-team'],
    ['runtime-evaluator', 'evaluator', 'runtime-team'],
  ]
  const dispatches = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  ]
  const agentRuns = ids.map(([agentId, agentRole, teamId], index) => ({
    agent_run_id: `runtime-run-${index + 1}`,
    agent_id: agentId,
    agent_role: agentRole,
    team_id: teamId,
    task_id: `runtime-task-${index + 1}`,
    dispatch_id: dispatches[index],
    session_operation: 'new',
    requested_session_id: null,
    acp_session_id: `runtime-session-${index + 1}`,
    state: 'active',
    queued_at: at(-10_000),
    started_at: at(-9_000),
    completed_at: null,
    queue_wait_ms: 1_000,
    service_ms: null,
    result_digest: null,
    receipt_digest: `sha256:${String(index + 1).repeat(64)}`,
  }))
  return {
    schema: 'tmux-teams.team-runtime', schema_version: 1, trust_level: 'advisory_same_uid',
    comparison_id: 'runtime-comparison', run_id: 'runtime-run', mode: 'team_loop',
    generated_at: at(-1_000), expires_at: at(300_000), graph_source_digest: graphSourceDigest,
    workload_digest: `sha256:${'1'.repeat(64)}`, oracle_digest: `sha256:${'2'.repeat(64)}`,
    event_log_digest: `sha256:${'3'.repeat(64)}`, execution_profile_digest: `sha256:${'4'.repeat(64)}`,
    controller: { agent_id: 'outer-control', agent_run_id: 'runtime-run-1' },
    checkpoint: {}, agent_runs: agentRuns, routing_decisions: [], attempts: [], evaluations: [],
    handoffs: [], bottleneck: null,
    metrics: {
      pm_routing_touches: 0, cycle_time_ms: null, gross_cycle_time_ms: null,
      measurement_hold_ms: 0, fanout_makespan_ms: null, summed_worker_service_ms: 0,
      rework_items_rerun: 0, total_items: 0, unaffected_item_attempt_delta: 0,
      bottleneck_detection_ms: null, incorrect_stall_count: 0,
    },
  }
}

function runtimeWithRecords(graphSourceDigest, nowMs = Date.now()) {
  const at = (offset) => new Date(nowMs + offset).toISOString()
  const runtime = validTeamRuntime(graphSourceDigest, nowMs)
  const worker = runtime.agent_runs[2]
  const evaluator = runtime.agent_runs[4]
  evaluator.state = 'completed'
  evaluator.completed_at = at(-1_000)
  evaluator.service_ms = 8_000
  evaluator.result_digest = DIGEST_A
  const attempt = {
    attempt_id: 'runtime-attempt', parent_attempt_id: null, team_id: 'runtime-team',
    work_item_id: 'runtime-work', agent_id: worker.agent_id, agent_run_id: worker.agent_run_id,
    task_id: worker.task_id, dispatch_id: worker.dispatch_id, acp_session_id: worker.acp_session_id,
    resumed_session_id: null, state: 'active', queued_at: at(-10_000), started_at: at(-9_000),
    completed_at: null, input_artifact_digest: null, output_artifact_digest: null, result_digest: null,
  }
  runtime.attempts = [attempt]
  runtime.routing_decisions = [{
    decision_id: 'runtime-decision-a', agent_run_id: runtime.agent_runs[1].agent_run_id,
    actor_id: runtime.agent_runs[1].agent_id, actor_role: 'dispatcher', scope: 'team_internal',
    team_id: 'runtime-team', work_item_id: attempt.work_item_id, attempt_id: attempt.attempt_id,
    decision_kind: 'assign', target_agent_id: worker.agent_id,
    source_task_id: runtime.agent_runs[1].task_id, source_dispatch_id: runtime.agent_runs[1].dispatch_id,
    source_result_digest: null, observed_at: at(-8_000),
  }]
  runtime.evaluations = [{
    evaluation_id: 'runtime-evaluation-a', agent_run_id: evaluator.agent_run_id,
    team_id: 'runtime-team', evaluator_agent_id: evaluator.agent_id,
    evaluator_task_id: evaluator.task_id, evaluator_dispatch_id: evaluator.dispatch_id,
    round: 1, work_item_id: attempt.work_item_id, attempt_id: attempt.attempt_id,
    verdict: 'accepted', criterion_results: [], defects: [], return_dispatcher_agent_id: null,
    source_result_digest: DIGEST_A, observed_at: at(-7_000),
  }]
  runtime.handoffs = [{
    handoff_id: 'runtime-handoff-a', producer_agent_run_id: evaluator.agent_run_id,
    consumer_agent_run_id: null, upstream_team_id: 'runtime-team',
    upstream_evaluator_agent_id: evaluator.agent_id, upstream_evaluator_task_id: evaluator.task_id,
    downstream_team_id: null, downstream_dispatcher_agent_id: null,
    artifact_digest: DIGEST_A, consumed_artifact_digest: null,
    produced_at: at(-6_000), consumed_at: null, state: 'completed',
  }]
  return runtime
}

function runtimeWithDownstreamHandoff(state) {
  const graph = runtimeGraphWithDownstream()
  const digest = runtimeGraphDigest(graph)
  const runtime = runtimeWithRecords(digest)
  const at = (offset) => new Date(Date.parse(runtime.generated_at) + offset).toISOString()
  runtime.agent_runs.push(
    {
      agent_run_id: 'runtime-next-run-1', agent_id: 'runtime-next-dispatcher', agent_role: 'dispatcher',
      team_id: 'runtime-next', task_id: 'runtime-next-dispatch', dispatch_id: '11111111-1111-4111-8111-111111111111',
      session_operation: 'new', requested_session_id: null, acp_session_id: 'runtime-next-session-1', state: 'active',
      queued_at: at(-10_000), started_at: at(-9_000), completed_at: null, queue_wait_ms: 1_000,
      service_ms: null, result_digest: null, receipt_digest: `sha256:${'6'.repeat(64)}`,
    },
    {
      agent_run_id: 'runtime-next-run-2', agent_id: 'runtime-next-worker', agent_role: 'worker',
      team_id: 'runtime-next', task_id: 'runtime-next-task', dispatch_id: '22222222-2222-4222-8222-222222222222',
      session_operation: 'new', requested_session_id: null, acp_session_id: 'runtime-next-session-2', state: 'active',
      queued_at: at(-10_000), started_at: at(-9_000), completed_at: null, queue_wait_ms: 1_000,
      service_ms: null, result_digest: null, receipt_digest: `sha256:${'7'.repeat(64)}`,
    },
    {
      agent_run_id: 'runtime-next-run-3', agent_id: 'runtime-next-evaluator', agent_role: 'evaluator',
      team_id: 'runtime-next', task_id: 'runtime-next-evaluate', dispatch_id: '33333333-3333-4333-8333-333333333333',
      session_operation: 'new', requested_session_id: null, acp_session_id: 'runtime-next-session-3', state: 'active',
      queued_at: at(-10_000), started_at: at(-9_000), completed_at: null, queue_wait_ms: 1_000,
      service_ms: null, result_digest: null, receipt_digest: `sha256:${'8'.repeat(64)}`,
    },
  )
  const handoff = runtime.handoffs[0]
  handoff.downstream_team_id = 'runtime-next'
  handoff.downstream_dispatcher_agent_id = 'runtime-next-dispatcher'
  handoff.state = state
  if (state === 'consumed') {
    handoff.consumer_agent_run_id = 'runtime-next-run-1'
    handoff.consumed_artifact_digest = DIGEST_A
    handoff.consumed_at = at(-2_000)
  } else if (state === 'produced') {
    handoff.consumer_agent_run_id = null
    handoff.consumed_artifact_digest = null
    handoff.consumed_at = null
  }
  return { graph, runtime }
}

function runtimeWithResume(graphSourceDigest, nowMs = Date.now()) {
  const at = (offset) => new Date(nowMs + offset).toISOString()
  const runtime = validTeamRuntime(graphSourceDigest, nowMs)
  const parentRun = runtime.agent_runs[2]
  parentRun.state = 'completed'
  parentRun.completed_at = at(-1_000)
  parentRun.service_ms = 8_000
  parentRun.result_digest = DIGEST_A
  const childRun = {
    ...parentRun,
    agent_run_id: 'runtime-run-child', dispatch_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    state: 'active', queued_at: at(-800), started_at: at(-700), completed_at: null,
    queue_wait_ms: 100, service_ms: null, session_operation: 'load',
    requested_session_id: parentRun.acp_session_id, result_digest: null,
  }
  runtime.agent_runs.push(childRun)
  runtime.attempts = [
    {
      attempt_id: 'runtime-parent-attempt', parent_attempt_id: null, team_id: 'runtime-team',
      work_item_id: 'runtime-rework', agent_id: parentRun.agent_id, agent_run_id: parentRun.agent_run_id,
      task_id: parentRun.task_id, dispatch_id: parentRun.dispatch_id, acp_session_id: parentRun.acp_session_id,
      resumed_session_id: null, state: 'completed', queued_at: at(-10_000), started_at: at(-9_000),
      completed_at: at(-1_000), input_artifact_digest: null, output_artifact_digest: DIGEST_A, result_digest: DIGEST_A,
    },
    {
      attempt_id: 'runtime-child-attempt', parent_attempt_id: 'runtime-parent-attempt', team_id: 'runtime-team',
      work_item_id: 'runtime-rework', agent_id: childRun.agent_id, agent_run_id: childRun.agent_run_id,
      task_id: childRun.task_id, dispatch_id: childRun.dispatch_id, acp_session_id: childRun.acp_session_id,
      resumed_session_id: parentRun.acp_session_id, state: 'active', queued_at: at(-800), started_at: at(-700),
      completed_at: null, input_artifact_digest: DIGEST_A, output_artifact_digest: null, result_digest: null,
    },
  ]
  return runtime
}

function runtimeGraphDigest(graph = runtimeGraph()) {
  const checked = validateTeamGraph(graph)
  assert.equal(checked.ok, true, checked.reason)
  return checked.value.source_digest
}

test('team runtime coverage is an exact mode-aware configured dispatch set', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  const missing = validTeamRuntime(digest)
  missing.agent_runs = missing.agent_runs.filter((run) => run.agent_id !== 'runtime-worker-b')
  assert.equal(validateTeamRuntime(missing, { teamGraph: graph }).ok, false, 'missing worker evidence')

  const legacy = validTeamRuntime(digest)
  legacy.mode = 'legacy'
  legacy.agent_runs = legacy.agent_runs.filter((run) => run.agent_role !== 'dispatcher')
  legacy.routing_decisions = [{
    decision_id: 'legacy-team-touch', agent_run_id: 'runtime-run-1', actor_id: 'outer-control',
    actor_role: 'outer_controller', scope: 'team_internal', team_id: 'runtime-team',
    work_item_id: null, attempt_id: null, decision_kind: 'start_team', target_agent_id: 'runtime-worker-a',
    source_task_id: 'runtime-task-1', source_dispatch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source_result_digest: null, observed_at: legacy.generated_at,
  }]
  legacy.metrics.pm_routing_touches = 1
  assert.equal(validateTeamRuntime(legacy, { teamGraph: graph }).ok, true, 'legacy expected set')

  const excludedDispatcher = structuredClone(legacy)
  excludedDispatcher.agent_runs.push(validTeamRuntime(digest).agent_runs[1])
  assert.equal(validateTeamRuntime(excludedDispatcher, { teamGraph: graph }).ok, false,
    'legacy dispatcher evidence is an invalid extra agent')

  const extra = validTeamRuntime(digest)
  extra.agent_runs.push({
    ...extra.agent_runs[2], agent_run_id: 'runtime-run-extra', agent_id: 'unconfigured-extra',
    dispatch_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  })
  assert.equal(validateTeamRuntime(extra, { teamGraph: graph }).ok, false, 'unconfigured extra agent')
})

test('team runtime rejects duplicate dispatches and controller record IDs globally', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  const duplicateDispatch = validTeamRuntime(digest)
  duplicateDispatch.agent_runs[3].dispatch_id = duplicateDispatch.agent_runs[2].dispatch_id
  assert.equal(validateTeamRuntime(duplicateDispatch, { teamGraph: graph }).ok, false, 'cross-agent dispatch duplicate')

  for (const [label, collection] of [
    ['routing decision', 'routing_decisions'],
    ['evaluation', 'evaluations'],
    ['handoff', 'handoffs'],
  ]) {
    const runtime = runtimeWithRecords(digest)
    runtime[collection].push(structuredClone(runtime[collection][0]))
    assert.equal(validateTeamRuntime(runtime, { teamGraph: graph }).ok, false, `${label} duplicate`)
  }
})

test('team runtime requires terminal results and exact timestamp-derived durations', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  const missingResult = validTeamRuntime(digest)
  missingResult.agent_runs[2].state = 'completed'
  missingResult.agent_runs[2].completed_at = new Date(Date.parse(missingResult.generated_at) - 1_000).toISOString()
  missingResult.agent_runs[2].service_ms = 8_000
  assert.equal(validateTeamRuntime(missingResult, { teamGraph: graph }).ok, false, 'terminal result digest')

  const terminalTiming = validTeamRuntime(digest)
  terminalTiming.agent_runs[2].completed_at = new Date(Date.parse(terminalTiming.generated_at) - 1_000).toISOString()
  assert.equal(validateTeamRuntime(terminalTiming, { teamGraph: graph }).ok, false, 'active terminal timing')

  const badQueue = validTeamRuntime(digest)
  badQueue.agent_runs[2].queue_wait_ms = 998
  assert.equal(validateTeamRuntime(badQueue, { teamGraph: graph }).ok, false, 'queue duration')

  const badService = validTeamRuntime(digest)
  badService.agent_runs[2].state = 'completed'
  badService.agent_runs[2].completed_at = new Date(Date.parse(badService.generated_at) - 1_000).toISOString()
  badService.agent_runs[2].service_ms = 7_998
  badService.agent_runs[2].result_digest = DIGEST_A
  assert.equal(validateTeamRuntime(badService, { teamGraph: graph }).ok, false, 'service duration')
})

test('resumed runtime attempts require every session lineage equality edge', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  assert.equal(validateTeamRuntime(runtimeWithResume(digest), { teamGraph: graph }).ok, true)
  for (const [label, mutate] of [
    ['attempt resumed session', (runtime) => { runtime.attempts[1].resumed_session_id = 'other-session' }],
    ['child attempt session', (runtime) => { runtime.attempts[1].acp_session_id = 'other-session' }],
    ['child run session', (runtime) => { runtime.agent_runs.at(-1).acp_session_id = 'other-session' }],
    ['parent run session', (runtime) => { runtime.agent_runs[2].acp_session_id = 'other-session' }],
  ]) {
    const runtime = runtimeWithResume(digest)
    mutate(runtime)
    assert.equal(validateTeamRuntime(runtime, { teamGraph: graph }).ok, false, label)
  }
})

test('mode and scope semantics re-derive PM routing touches', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  const legacy = validTeamRuntime(digest)
  legacy.mode = 'legacy'
  legacy.agent_runs = legacy.agent_runs.filter((run) => run.agent_role !== 'dispatcher')
  const touch = {
    decision_id: 'legacy-touch', agent_run_id: 'runtime-run-1', actor_id: 'outer-control',
    actor_role: 'outer_controller', scope: 'team_internal', team_id: 'runtime-team', work_item_id: null,
    attempt_id: null, decision_kind: 'start_team', target_agent_id: 'runtime-worker-a',
    source_task_id: 'runtime-task-1', source_dispatch_id: legacy.agent_runs[0].dispatch_id,
    source_result_digest: null, observed_at: legacy.generated_at,
  }
  legacy.routing_decisions = [touch]
  legacy.metrics.pm_routing_touches = 1
  assert.equal(validateTeamRuntime(legacy, { teamGraph: graph }).ok, true)
  const missingTouch = structuredClone(legacy)
  missingTouch.routing_decisions = []
  assert.equal(validateTeamRuntime(missingTouch, { teamGraph: graph }).ok, false)
  const wrongMetric = structuredClone(legacy)
  wrongMetric.metrics.pm_routing_touches = 0
  assert.equal(validateTeamRuntime(wrongMetric, { teamGraph: graph }).ok, false)

  const loop = validTeamRuntime(digest)
  loop.routing_decisions = [{ ...touch, decision_id: 'loop-invalid-touch' }]
  assert.equal(validateTeamRuntime(loop, { teamGraph: graph }).ok, false, 'team_loop outer Team touch')
})

test('handoff states enforce produced, consumed, and project-completed shapes', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  const completed = runtimeWithRecords(digest)
  assert.equal(validateTeamRuntime(completed, { teamGraph: graph }).ok, true)

  const produced = structuredClone(completed)
  produced.handoffs[0].state = 'produced'
  assert.equal(validateTeamRuntime(produced, { teamGraph: graph }).ok, false,
    'produced final handoff cannot masquerade as completion')

  const consumed = structuredClone(completed)
  consumed.handoffs[0].state = 'consumed'
  assert.equal(validateTeamRuntime(consumed, { teamGraph: graph }).ok, false,
    'consumed handoff requires downstream consumer')

  const invalidCompletion = structuredClone(completed)
  invalidCompletion.handoffs[0].downstream_team_id = 'runtime-team'
  invalidCompletion.handoffs[0].downstream_dispatcher_agent_id = 'runtime-dispatcher'
  assert.equal(validateTeamRuntime(invalidCompletion, { teamGraph: graph }).ok, false,
    'completed handoff cannot point at a downstream Team')

  for (const state of ['produced', 'consumed']) {
    const downstream = runtimeWithDownstreamHandoff(state)
    assert.equal(validateTeamRuntime(downstream.runtime, { teamGraph: downstream.graph }).ok, true,
      `${state} downstream handoff`)
  }
})

test('runtime freshness permits exactly 120 seconds of future skew but not one millisecond more', () => {
  const graph = runtimeGraph()
  const nowMs = Date.parse('2026-07-26T00:00:00.000Z')
  const digest = runtimeGraphDigest(graph)
  const boundary = validTeamRuntime(digest, nowMs + 121_000)
  assert.equal(validateTeamRuntime(boundary, { teamGraph: graph, nowMs }).ok, true)
  const beyond = validTeamRuntime(digest, nowMs + 121_001)
  assert.equal(validateTeamRuntime(beyond, { teamGraph: graph, nowMs }).ok, false)
  const expired = validTeamRuntime(digest, nowMs - 1_000_000)
  expired.expires_at = new Date(nowMs - 1).toISOString()
  assert.equal(validateTeamRuntime(expired, { teamGraph: graph, nowMs }).ok, false)
})

test('runtime graph digest is mandatory even when the graph input omitted a source claim', () => {
  const graph = runtimeGraph()
  const digest = runtimeGraphDigest(graph)
  assert.match(digest, /^sha256:[a-f0-9]{64}$/)
  const arbitrary = validTeamRuntime(`sha256:${'f'.repeat(64)}`)
  assert.equal(validateTeamRuntime(arbitrary, { teamGraph: graph }).ok, false)
})

function runJsonAsync(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PULSE, 'json', dir])
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', status => {
      if (status !== 0) return reject(new Error(`pulse json exited ${status}: ${stderr}`))
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
  })
}

function verifyCommittedBundle(dir) {
  const store = join(dir, '.tmux-teams')
  const markerPath = join(store, 'pulse-current.json')
  const markerBefore = readFileSync(markerPath, 'utf8')
  const manifest = JSON.parse(markerBefore)
  assert.equal(manifest.schema, 'tmux-teams.pulse-bundle')
  assert.equal(manifest.schema_version, 2)
  assert.deepEqual(Object.keys(manifest.files).sort(),
    ['d3_js', 'd3_license', 'dashboard', 'data', 'font_css', 'graph', 'kanban', 'refresh_js'])
  for (const entry of Object.values(manifest.files)) {
    assert.match(entry.path, /^[a-z0-9][a-z0-9._-]*$/i)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    const content = readFileSync(join(store, entry.path))
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256)
  }
  assert.equal(manifest.files.refresh_js.path, `pulse-refresh-${REFRESH_HASH}.js`)
  assert.equal(manifest.files.refresh_js.sha256, REFRESH_HASH)
  const snapshot = JSON.parse(readFileSync(join(store, manifest.files.data.path), 'utf8'))
  assert.equal(snapshot.snapshot_id, manifest.snapshot_id)
  for (const key of ['dashboard', 'graph']) {
    const html = readFileSync(join(store, manifest.files[key].path), 'utf8')
    assert.match(html, new RegExp(
      `<meta name="tmux-teams-snapshot-id" content="${manifest.snapshot_id}">`,
    ))
  }
  assert.equal(readFileSync(markerPath, 'utf8'), markerBefore,
    'commit marker must remain stable across the bundle read')
  return { manifest, snapshot }
}

function assertExactKeys(value, schema, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), Object.keys(schema.properties).sort(),
    `${label} keys drifted from the closed schema`)
}

function assertEnum(value, schema, label) {
  assert.ok(schema.enum.includes(value), `${label}: unexpected code ${String(value)}`)
}

function assertTimestamp(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a timestamp string`)
  assert.match(value, ISO_TIMESTAMP_RE,
    `${label} must use RFC 3339 date-time syntax`)
  assert.ok(isValidRepositoryDateTime(value), `${label} is not a valid timestamp`)
}

function isValidRepositoryDateTime(value) {
  const match = typeof value === 'string' ? ISO_TIMESTAMP_RE.exec(value) : null
  if (!match) return false
  const { year, month, day, hour, minute, second, zone } = match.groups
  const yearNumber = Number(year), monthNumber = Number(month), dayNumber = Number(day)
  const hourNumber = Number(hour), minuteNumber = Number(minute), secondNumber = Number(second)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31 ||
      hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return false
  if (zone !== 'Z') {
    const offset = zone.slice(1).split(':').map(Number)
    if (offset[0] > 23 || offset[1] > 59) return false
  }
  const calendar = new Date(0)
  calendar.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber)
  calendar.setUTCHours(hourNumber, minuteNumber, secondNumber, 0)
  if (calendar.getUTCFullYear() !== yearNumber ||
      calendar.getUTCMonth() !== monthNumber - 1 ||
      calendar.getUTCDate() !== dayNumber ||
      calendar.getUTCHours() !== hourNumber ||
      calendar.getUTCMinutes() !== minuteNumber ||
      calendar.getUTCSeconds() !== secondNumber) return false
  return Number.isFinite(Date.parse(value))
}

function jsonTypeMatches(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function resolveSchemaRef(ref, rootSchema) {
  const [documentRef, fragment = ''] = String(ref).split('#')
  const document = documentRef
    ? SCHEMA_DOCUMENTS.get(basename(documentRef))
    : rootSchema
  if (!document) throw new Error(`unresolved schema document ${documentRef}`)
  if (!fragment) return { schema: document, root: document }
  if (!fragment.startsWith('/')) throw new Error(`unsupported schema fragment ${fragment}`)
  let schema = document
  for (const rawPart of fragment.slice(1).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~')
    schema = schema?.[part]
  }
  if (schema === undefined) throw new Error(`unresolved schema fragment ${ref}`)
  return { schema, root: document }
}

function validateRepositorySchema(value, schema, rootSchema, path = '$', errors = []) {
  if (schema === true) return errors
  if (schema === false) {
    errors.push(`${path}: schema is false`)
    return errors
  }
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, rootSchema)
    validateRepositorySchema(value, resolved.schema, resolved.root, path, errors)
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path}: value is outside enum`)
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => jsonTypeMatches(value, type))) {
      errors.push(`${path}: expected type ${types.join('|')}`)
      return errors
    }
  }
  if (schema.oneOf) {
    const validBranches = schema.oneOf.filter((branch) =>
      validateRepositorySchema(value, branch, rootSchema, path, []).length === 0)
    if (validBranches.length !== 1) errors.push(`${path}: oneOf matched ${validBranches.length} branches`)
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) validateRepositorySchema(value, branch, rootSchema, path, errors)
  }
  if (schema.if) {
    const conditionMatches = validateRepositorySchema(value, schema.if, rootSchema, path, []).length === 0
    const branch = conditionMatches ? schema.then : schema.else
    if (branch) validateRepositorySchema(value, branch, rootSchema, path, errors)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {}
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}: missing required property ${required}`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateRepositorySchema(value[key], child, rootSchema, `${path}.${key}`, errors)
    }
    const unknown = Object.keys(value).filter((key) => !Object.hasOwn(properties, key))
    if (schema.additionalProperties === false) {
      for (const key of unknown) errors.push(`${path}: additionalProperties contains ${key}`)
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of unknown) {
        validateRepositorySchema(value[key], schema.additionalProperties, rootSchema, `${path}.${key}`, errors)
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`)
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path}: uniqueItems violated`)
    }
    if (schema.items) value.forEach((item, index) =>
      validateRepositorySchema(item, schema.items, rootSchema, `${path}[${index}]`, errors))
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength} characters`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength} characters`)
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: pattern mismatch`)
    }
    if (schema.format === 'date-time' && !isValidRepositoryDateTime(value)) {
      errors.push(`${path}: invalid date-time`)
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`)
  }
  return errors
}

function assertOfflineSchema(value, schemaPath, label) {
  const schema = SCHEMA_DOCUMENTS.get(basename(schemaPath))
  assert.ok(schema, `${label}: repository schema was not loaded`)
  const errors = validateRepositorySchema(value, schema, schema)
  if (errors.length) throw new Error(`${label}: ${errors.join('; ')}`)
}

function assertPythonSchema(value, schemaPath, label) {
  const program = [
    'import json, jsonschema, pathlib, sys',
    'schema_path = pathlib.Path(sys.argv[1]).resolve()',
    'schema = json.loads(schema_path.read_text(encoding="utf-8"))',
    'store = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in schema_path.parent.glob("*.schema.json")}',
    'jsonschema.Draft202012Validator.check_schema(schema)',
    'resolver = jsonschema.RefResolver.from_schema(schema, store=store)',
    'instance = json.load(sys.stdin)',
    'jsonschema.Draft202012Validator(schema, resolver=resolver, format_checker=jsonschema.FormatChecker()).validate(instance)',
  ].join('; ')
  const validation = spawnSync('python3', ['-c', program, schemaPath], {
    input: JSON.stringify(value), encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(validation.status, 0, `${label}: ${validation.stderr || validation.stdout}`)
}

function assertRealSchema(value, schemaPath, label) {
  assertOfflineSchema(value, schemaPath, label)
  if (HAS_PYTHON_JSONSCHEMA) assertPythonSchema(value, schemaPath, `${label} Python cross-check`)
}

function assertNullableDuration(value, label) {
  assert.ok(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0),
    `${label} must be null or a finite non-negative number`)
}

function assertRun(run, index) {
  const label = `runs[${index}]`
  assertExactKeys(run, SCHEMA.$defs.run, label)
  assert.ok(typeof run.task_id === 'string' && ID_RE.test(run.task_id), `${label}.task_id must be a validated ID`)
  assert.ok(run.dispatch_id === null || (typeof run.dispatch_id === 'string' && UUID_RE.test(run.dispatch_id)),
    `${label}.dispatch_id must be a UUID or null`)
  assertEnum(run.identity_source, SCHEMA.$defs.run.properties.identity_source, `${label}.identity_source`)
  assertEnum(run.state, SCHEMA.$defs.state, `${label}.state`)
  assert.ok(run.worker === null || (typeof run.worker === 'string' && ID_RE.test(run.worker)),
    `${label}.worker must be a validated ID or null`)
  assert.ok(run.agent_id === null || (typeof run.agent_id === 'string' && ID_RE.test(run.agent_id)),
    `${label}.agent_id must be a validated ID or null`)
  assertEnum(run.transport, SCHEMA.$defs.run.properties.transport, `${label}.transport`)
  if (run.started_at !== null) assertTimestamp(run.started_at, `${label}.started_at`)
  for (const field of ['elapsed_sec', 'silence_sec', 'timeout_sec']) {
    assertNullableDuration(run[field], `${label}.${field}`)
  }

  assertExactKeys(run.signals, SCHEMA.$defs.signals, `${label}.signals`)
  for (const [field, value] of Object.entries(run.signals)) {
    assertEnum(value, SCHEMA.$defs.signals.properties[field], `${label}.signals.${field}`)
  }
  assert.ok(run.reason_codes.length >= 1 && run.reason_codes.length <= 4)
  assert.equal(new Set(run.reason_codes).size, run.reason_codes.length, `${label}.reason_codes must be unique`)
  for (const reason of run.reason_codes) assertEnum(reason, SCHEMA.$defs.reason_code, `${label}.reason_codes`)

  assertExactKeys(run.advisory, SCHEMA.$defs.advisory, `${label}.advisory`)
  assert.equal(typeof run.advisory.attention, 'boolean')
  assertEnum(run.advisory.action_code, SCHEMA.$defs.action_code, `${label}.advisory.action_code`)
  assert.equal(run.advisory.auto_execute, false, `${label} must never authorize automatic action`)
  assert.ok(run.phase === null || SCHEMA.$defs.nullable_run_phase.oneOf[0].enum.includes(run.phase),
    `${label}.phase must be an explicit delivery phase or null`)
  assertEnum(run.phase_source, SCHEMA.$defs.phase_source, `${label}.phase_source`)
  assert.equal(run.phase === null, ['unassigned', 'conflict'].includes(run.phase_source),
    `${label} phase and phase_source must agree`)
}

function assertRecentVerdict(verdict, index) {
  const label = `recent_verdicts[${index}]`
  assertExactKeys(verdict, SCHEMA.$defs.recent_verdict, label)
  assert.ok(verdict.dispatch_id === null || (typeof verdict.dispatch_id === 'string' && UUID_RE.test(verdict.dispatch_id)))
  assert.ok(typeof verdict.task_id === 'string' && ID_RE.test(verdict.task_id))
  assert.ok(typeof verdict.worker === 'string' && ID_RE.test(verdict.worker))
  assert.ok(verdict.agent_id === null || (typeof verdict.agent_id === 'string' && ID_RE.test(verdict.agent_id)))
  assertEnum(verdict.transport, SCHEMA.$defs.recent_verdict.properties.transport, `${label}.transport`)
  assertEnum(verdict.terminal, SCHEMA.$defs.recent_verdict.properties.terminal, `${label}.terminal`)
  assertEnum(verdict.pm_verdict, SCHEMA.$defs.recent_verdict.properties.pm_verdict, `${label}.pm_verdict`)
  if (verdict.started_at !== null) assertTimestamp(verdict.started_at, `${label}.started_at`)
  assertNullableDuration(verdict.wait_sec, `${label}.wait_sec`)
  assertNullableDuration(verdict.timeout_sec, `${label}.timeout_sec`)
  assert.ok(verdict.phase === null ||
    SCHEMA.$defs.nullable_run_phase.oneOf[0].enum.includes(verdict.phase))
  assertEnum(verdict.phase_source, SCHEMA.$defs.phase_source, `${label}.phase_source`)
  assert.equal(verdict.phase === null, ['unassigned', 'conflict'].includes(verdict.phase_source),
    `${label} phase and phase_source must agree`)
}

function assertDiagnostic(diagnostic, index) {
  const label = `diagnostics[${index}]`
  assertExactKeys(diagnostic, SCHEMA.$defs.diagnostic, label)
  assertEnum(diagnostic.code, SCHEMA.$defs.diagnostic_code, `${label}.code`)
  assertEnum(diagnostic.severity, SCHEMA.$defs.diagnostic.properties.severity, `${label}.severity`)
  assertEnum(diagnostic.source, SCHEMA.$defs.diagnostic.properties.source, `${label}.source`)
  assert.ok(Number.isInteger(diagnostic.count) && diagnostic.count >= 1, `${label}.count must be a positive integer`)
}

function assertWorkerStat(stat, index) {
  const label = `worker_stats[${index}]`
  assertExactKeys(stat, SCHEMA.$defs.worker_stat, label)
  assert.ok(typeof stat.worker === 'string' && ID_RE.test(stat.worker), `${label}.worker must be a validated ID`)
  assert.ok(Number.isInteger(stat.runs) && stat.runs >= 1)
  assert.ok(Number.isInteger(stat.rejected) && stat.rejected >= 0 && stat.rejected <= stat.runs)
  assertNullableDuration(stat.median_wait_sec, `${label}.median_wait_sec`)
}

function assertUnclaimedControl(row, index) {
  const label = `unclaimed_control[${index}]`
  assertExactKeys(row, SCHEMA.$defs.unclaimed_control, label)
  assert.ok(typeof row.task_id === 'string' && ID_RE.test(row.task_id), `${label}.task_id must be a validated ID`)
  assert.ok(Number.isInteger(row.age_sec) && row.age_sec >= 0)
}

function assertPulseV4(snapshot) {
  assert.deepEqual(Object.keys(snapshot).sort(), [...SCHEMA.required].sort(),
    'default Pulse v3 must contain exactly its required fields')
  assert.equal(snapshot.schema, 'tmux-teams.pulse')
  assert.equal(snapshot.schema_version, 4)
  assert.equal(snapshot.team_runtime, null)
  assert.ok(typeof snapshot.stream_id === 'string' && UUID_RE.test(snapshot.stream_id), 'stream_id must be a UUID')
  assert.ok(Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 1)
  assert.ok(typeof snapshot.snapshot_id === 'string' && SNAPSHOT_RE.test(snapshot.snapshot_id))
  assert.equal(snapshot.snapshot_id, `${snapshot.stream_id}:${snapshot.sequence}`)
  assert.equal(snapshot.trust_level, 'advisory_same_uid')
  assertTimestamp(snapshot.generated_at, 'generated_at')
  assert.equal(typeof snapshot.complete, 'boolean')

  assertExactKeys(snapshot.observation, SCHEMA.$defs.observation, 'observation')
  assertTimestamp(snapshot.observation.started_at, 'observation.started_at')
  assertTimestamp(snapshot.observation.finished_at, 'observation.finished_at')
  assertTimestamp(snapshot.observation.expires_at, 'observation.expires_at')
  assert.equal(snapshot.observation.consistency, 'best_effort')
  assert.ok(Number.isInteger(snapshot.observation.refresh_interval_sec) && snapshot.observation.refresh_interval_sec >= 1)
  assert.ok(Number.isInteger(snapshot.observation.stale_after_sec) && snapshot.observation.stale_after_sec >= 60)
  assertEnum(snapshot.observation.quality, SCHEMA.$defs.observation.properties.quality, 'observation.quality')
  const started = Date.parse(snapshot.observation.started_at)
  const finished = Date.parse(snapshot.observation.finished_at)
  const expires = Date.parse(snapshot.observation.expires_at)
  assert.ok(started <= finished, 'observation must not finish before it starts')
  assert.equal(expires, finished + snapshot.observation.stale_after_sec * 1000,
    'expires_at must encode the stated freshness window')
  assert.equal(snapshot.generated_at, snapshot.observation.finished_at)

  assertExactKeys(snapshot.scope, SCHEMA.$defs.scope, 'scope')
  assert.ok(snapshot.scope.repo_name === null ||
    (typeof snapshot.scope.repo_name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(snapshot.scope.repo_name)))
  assertExactKeys(snapshot.source_health, SCHEMA.$defs.source_health, 'source_health')
  for (const [source, health] of Object.entries(snapshot.source_health)) {
    assertEnum(health, SCHEMA.$defs.health, `source_health.${source}`)
  }

  assertExactKeys(snapshot.summary, SCHEMA.$defs.summary, 'summary')
  assertExactKeys(snapshot.summary.by_state, SCHEMA.$defs.by_state, 'summary.by_state')
  for (const [state, count] of Object.entries(snapshot.summary.by_state)) {
    assert.ok(Number.isInteger(count) && count >= 0, `summary.by_state.${state} must be a non-negative integer`)
  }
  for (const field of ['active', 'attention', 'truncated']) {
    assert.ok(Number.isInteger(snapshot.summary[field]) && snapshot.summary[field] >= 0,
      `summary.${field} must be a non-negative integer`)
  }
  assert.equal(Object.values(snapshot.summary.by_state).reduce((sum, n) => sum + n, 0), snapshot.summary.active)
  assert.equal(snapshot.runs.length + snapshot.summary.truncated, snapshot.summary.active)

  assert.ok(Array.isArray(snapshot.runs) && snapshot.runs.length <= 100)
  snapshot.runs.forEach(assertRun)
  assert.ok(Array.isArray(snapshot.recent_verdicts) && snapshot.recent_verdicts.length <= 12)
  snapshot.recent_verdicts.forEach(assertRecentVerdict)
  assert.ok(Array.isArray(snapshot.worker_stats) && snapshot.worker_stats.length <= 100)
  snapshot.worker_stats.forEach(assertWorkerStat)
  assert.ok(Array.isArray(snapshot.unclaimed_control) && snapshot.unclaimed_control.length <= 8)
  snapshot.unclaimed_control.forEach(assertUnclaimedControl)
  assert.ok(Array.isArray(snapshot.diagnostics) && snapshot.diagnostics.length <= 50)
  snapshot.diagnostics.forEach(assertDiagnostic)
  assert.equal(snapshot.summary.attention,
    snapshot.runs.filter(run => run.advisory.attention).length,
    'attention must be derived from the projected runs')
  assert.equal(snapshot.complete, snapshot.diagnostics.length === 0)
  assert.equal(snapshot.observation.quality, snapshot.complete ? 'complete' : 'degraded')
  assertExactKeys(snapshot.history, SCHEMA.properties.history, 'history')
  assert.ok(Array.isArray(snapshot.history.runs) && snapshot.history.runs.length <= 100)
  snapshot.history.runs.forEach(assertRun)
  assert.ok(Number.isInteger(snapshot.history.total) && snapshot.history.total >= snapshot.history.runs.length)
  assert.ok(Number.isInteger(snapshot.history.truncated) && snapshot.history.truncated >= 0)
}

function walkKeys(value, visit, path = '') {
  if (Array.isArray(value)) return value.forEach((item, i) => walkKeys(item, visit, `${path}[${i}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    visit(key, path ? `${path}.${key}` : key)
    walkKeys(child, visit, path ? `${path}.${key}` : key)
  }
}

function walkLeaves(value, visit, path = '') {
  if (Array.isArray(value)) return value.forEach((item, i) => walkLeaves(item, visit, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).forEach(([key, child]) => walkLeaves(child, visit, path ? `${path}.${key}` : key))
  }
  visit(value, path)
}

test('Pulse Data v4 schema is closed, advisory-only, phase-explicit, and Team runtime is null when absent', () => {
  assert.equal(SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(SCHEMA.properties.schema.const, 'tmux-teams.pulse')
  assert.equal(SCHEMA.properties.schema_version.const, 4)
  assert.equal(SCHEMA.properties.trust_level.const, 'advisory_same_uid')

  for (const [name, definition] of [['pulse', SCHEMA], ...Object.entries(SCHEMA.$defs)]) {
    if (definition.type !== 'object') continue
    assert.equal(definition.additionalProperties, false, `${name} must reject unknown fields`)
    const optional = name === 'pulse'
      ? ['delivery_loop', 'delivery_runtime', 'team_graph']
      : name === 'liveness_tool'
        ? ['content_digest', 'output_digest', 'locations_digest']
        : name === 'liveness_history'
          ? ['reason', 'last_protocol_activity_at', 'last_meaningful_progress_at', 'active_tools']
          : []
    assert.deepEqual([...definition.required].sort(),
      Object.keys(definition.properties).filter(key => !optional.includes(key)).sort(),
      `${name} must require every non-optional declared field`)
  }
  assert.equal(SCHEMA.$defs.advisory.properties.auto_execute.const, false)
  assert.deepEqual(SCHEMA.$defs.phase_source.enum,
    ['dispatch', 'event', 'dispatch_join', 'unassigned', 'conflict'])

  const rawFieldNames = new Set([
    'lesson', 'verify_cmd', 'raw_evidence', 'raw_outbox', 'detail', 'pid',
    'session', 'cmdline', 'raw_error', 'path', 'file',
  ])
  walkKeys(SCHEMA, (key, path) => {
    if (path.endsWith('.properties')) return
    assert.ok(!rawFieldNames.has(key), `raw field ${key} must not cross the contract boundary`)
  })
})

test('json command publishes exactly one schema-valid document and HTML shares its snapshot id', () => {
  const dir = repo()
  const { snapshot } = runJson(dir)
  assertPulseV4(snapshot)

  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const meta = html.match(/<meta\s+name="tmux-teams-snapshot-id"\s+content="([^"]+)"\s*>/)
  assert.ok(meta, 'HTML must identify the JSON snapshot from which it was rendered')
  assert.equal(meta[1], snapshot.snapshot_id)
})

test('tmux 3.6a no-server stderr means an available probe with no panes', () => {
  const dir = repo()
  dispatchWithMissingPane(dir)
  const env = fakeTmuxEnv(dir,
    'error connecting to /private/tmp/tmux-503/default (No such file or directory)')
  const { snapshot } = runJson(dir, env)
  const run = snapshot.history.runs.find(item => item.task_id === 'missing-pane')

  assert.equal(snapshot.source_health.liveness, 'ok', 'the fixture requires a working host liveness probe')
  assert.equal(snapshot.source_health.tmux, 'ok')
  assert.ok(!snapshot.diagnostics.some(item => item.code === 'TMUX_UNAVAILABLE'))
  assert.equal(run?.state, 'died')
  assert.equal(run?.signals.pane, 'gone')
  assert.equal(snapshot.summary.active, 0)
})

test('unrelated tmux failures and nonstandard exit codes remain unavailable', () => {
  const cases = [
    ['permission denied', 'permission denied', 1],
    ['no-server text with exit 2', 'error connecting to /tmp/tmux/default (No such file or directory)', 2],
  ]

  for (const [label, stderr, status] of cases) {
    const dir = repo()
    dispatchWithMissingPane(dir)
    const { snapshot } = runJson(dir, fakeTmuxEnv(dir, stderr, status))
    const run = snapshot.runs.find(item => item.task_id === 'missing-pane')

    assert.equal(snapshot.source_health.liveness, 'ok', `${label}: liveness precondition`)
    assert.equal(snapshot.source_health.tmux, 'unavailable', label)
    assert.ok(snapshot.diagnostics.some(item => item.code === 'TMUX_UNAVAILABLE'), label)
    assert.equal(run?.state, 'unknown', label)
    assert.equal(run?.signals.pane, 'probe_unavailable', label)
  }
})

test('snapshot sequence is monotonic and corrupt prior identity starts a diagnosed stream', () => {
  const dir = repo()
  const first = runJson(dir).snapshot
  const second = runJson(dir).snapshot
  assert.equal(first.sequence, 1)
  assert.equal(second.stream_id, first.stream_id)
  assert.equal(second.sequence, 2)

  writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
    schema: 'tmux-teams.pulse', schema_version: 1, stream_id: 'not-a-uuid', sequence: 2,
  }))
  const reset = runJson(dir).snapshot
  assert.notEqual(reset.stream_id, first.stream_id)
  assert.equal(reset.sequence, 1)
  assert.ok(reset.diagnostics.some(item => item.code === 'SEQUENCE_RESET'))
})

test('concurrent publishers serialize into one committed bundle with unique sequences', { timeout: 30_000 }, async () => {
  const dir = repo()
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => runJsonAsync(dir)))
  assert.equal(new Set(snapshots.map(item => item.stream_id)).size, 1)
  assert.deepEqual(snapshots.map(item => item.sequence).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])

  const persisted = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  assert.equal(persisted.sequence, 6)
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  assert.match(html, new RegExp(`content="${persisted.snapshot_id}"`))
  const committed = verifyCommittedBundle(dir)
  assert.equal(committed.manifest.snapshot_id, persisted.snapshot_id)
})

test('the bundle marker stays on the last complete snapshot when an HTML rename fails', () => {
  const dir = repo()
  const first = runJson(dir).snapshot
  const markerPath = join(dir, '.tmux-teams', 'pulse-current.json')
  const markerBefore = readFileSync(markerPath, 'utf8')
  verifyCommittedBundle(dir)

  const dashboardPath = join(dir, '.tmux-teams', 'pulse.html')
  unlinkSync(dashboardPath)
  mkdirSync(dashboardPath)
  const failed = spawnSync(process.execPath, [PULSE, 'json', dir], {
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout, '')
  assert.match(failed.stderr, /\[pulse\] publish failed:/)
  assert.equal(readFileSync(markerPath, 'utf8'), markerBefore,
    'the prior commit marker must survive a partial publication')
  const partial = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  assert.ok(partial.sequence > first.sequence, 'the injected failure happens after JSON publication')
  assert.throws(() => verifyCommittedBundle(dir),
    'the old marker must make the mixed snapshot detectable')

  rmdirSync(dashboardPath)
  runJson(dir)
  verifyCommittedBundle(dir)
})

test('dispatch UUID prevents a newer verdict for a reused task id from settling this attempt', () => {
  const dir = repo()
  const currentId = '33333333-3333-4333-8333-333333333333'
  const otherId = '44444444-4444-4444-8444-444444444444'
  const dispatchPath = join(dir, '.tmux-teams', 'dispatch', 'reused-id.md')
  writeFileSync(dispatchPath, [
    `dispatch_id: ${currentId}`,
    'task_id: reused-id',
    'worker: codex',
    'transport: tmux',
    '',
  ].join('\n'))
  age(dispatchPath, 600)
  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260722-0200_other.md'), [
    `dispatch_id: ${otherId}`,
    'task_id: reused-id',
    'worker: codex',
    'transport: tmux',
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    '',
  ].join('\n'))

  const mismatched = runJson(dir).snapshot
  assert.ok(mismatched.history.runs.some(run => run.task_id === 'reused-id'),
    'a verdict for another dispatch must not hide the current run')

  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260722-0201_legacy.md'), [
    'task_id: reused-id',
    'worker: codex',
    'transport: tmux',
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    '',
  ].join('\n'))
  const legacyVerdict = runJson(dir).snapshot
  assert.ok(legacyVerdict.history.runs.some(run => run.task_id === 'reused-id'),
    'a strong footprint must not downgrade to mtime for an id-less event')

  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260722-0202_current.md'), [
    `dispatch_id: ${currentId}`,
    'task_id: reused-id',
    'worker: codex',
    'transport: tmux',
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    '',
  ].join('\n'))
  const matched = runJson(dir).snapshot
  assert.ok(matched.history.runs.some(run => run.task_id === 'reused-id'),
    'the matching dispatch verdict settles the current run')
})

test('published document passes a real Draft 2020-12 validator', () => {
  const dir = repo()
  const { snapshot } = runJson(dir)
  assertRealSchema(snapshot, SCHEMA_PATH, 'published v4 snapshot')
})

test('v4 downprojections strip v4-only fields and validate against closed v1, v2, and v3 schemas', () => {
  const dir = repo()
  const deliveryPath = join(dir, 'delivery-loop.json')
  const { snapshot } = runJson(dir, process.env, ['--delivery-loop', deliveryPath])
  assert.equal(snapshot.schema_version, 4)
  assert.equal(snapshot.team_runtime, null)
  assert.ok(Object.hasOwn(snapshot, 'history'))

  const v1 = downProjectPulseV1(snapshot)
  const v2 = downProjectPulseV2(snapshot)
  const v3 = downProjectPulseV3(snapshot)
  for (const value of [v1, v2, v3]) {
    assert.equal(Object.hasOwn(value, 'history'), false)
    assert.equal(Object.hasOwn(value, 'team_graph'), false)
    assert.equal(Object.hasOwn(value, 'delivery_runtime'), false)
    assert.equal(Object.hasOwn(value, 'team_runtime'), false)
    for (const run of value.runs) {
      assert.equal(Object.hasOwn(run, 'agent_id'), false)
      assert.equal(Object.hasOwn(run, 'identity_conflict'), false)
      assert.equal(Object.hasOwn(run, 'model'), false)
      assert.equal(Object.hasOwn(run, 'liveness_evidence'), false)
    }
  }
  for (const recent of [...v1.recent_verdicts, ...v2.recent_verdicts, ...v3.recent_verdicts]) {
    assert.equal(Object.hasOwn(recent, 'agent_id'), false)
  }
  assert.equal(v1.schema_version, 1)
  assert.equal(Object.hasOwn(v1, 'delivery_loop'), false)
  assert.equal(v2.schema_version, 2)
  assert.ok(Object.hasOwn(v2, 'delivery_loop'))
  assert.equal(v3.schema_version, 3)
  assert.equal(Object.hasOwn(v3, 'delivery_loop'), true)
  assertRealSchema(v1, V1_SCHEMA_PATH, 'v1 downprojection')
  assertRealSchema(v2, V2_SCHEMA_PATH, 'v2 downprojection')
  assertRealSchema(v3, V3_SCHEMA_PATH, 'v3 downprojection')
})

test('closed v1/v2/v3 downprojections use an offline validator with recursive closure checks', () => {
  const dir = repo()
  const deliveryPath = join(dir, 'delivery-loop.json')
  const { snapshot } = runJson(dir, process.env, ['--delivery-loop', deliveryPath])
  const projections = [
    [downProjectPulseV1(snapshot), V1_SCHEMA_PATH, 'v1'],
    [downProjectPulseV2(snapshot), V2_SCHEMA_PATH, 'v2'],
    [downProjectPulseV3(snapshot), V3_SCHEMA_PATH, 'v3'],
  ]
  for (const [projection, schemaPath, label] of projections) {
    assertOfflineSchema(projection, schemaPath, label)

    const extra = structuredClone(projection)
    extra.__v4_only = true
    assert.throws(() => assertOfflineSchema(extra, schemaPath, `${label} extra`),
      /additionalProperties|unknown property/)

    const nestedExtra = structuredClone(projection)
    nestedExtra.summary.__v4_only = true
    assert.throws(() => assertOfflineSchema(nestedExtra, schemaPath, `${label} nested extra`),
      /additionalProperties|unknown property/)

    const impossibleDate = structuredClone(projection)
    impossibleDate.generated_at = '2026-99-99T99:99:99Z'
    assert.throws(() => assertOfflineSchema(impossibleDate, schemaPath, `${label} impossible date`),
      /invalid date-time|date-time/)

    const missing = structuredClone(projection)
    delete missing.schema
    assert.throws(() => assertOfflineSchema(missing, schemaPath, `${label} missing`),
      /required property|missing required/)
  }
})

test('closed schema acceptance executes without Python jsonschema and without skips', { timeout: 90_000 }, () => {
  const dir = repo()
  const unavailableBin = join(dir, 'python-unavailable-bin')
  mkdirSync(unavailableBin)
  const fakePython = join(unavailableBin, 'python3')
  writeFileSync(fakePython, '#!/bin/sh\nexit 127\n')
  chmodSync(fakePython, 0o755)
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...cleanProcessEnv } = process.env
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-name-pattern',
    '^closed v1/v2/v3 downprojections use an offline validator with recursive closure checks$',
    join(ROOT, 'tests', 'pulse-json.test.mjs'),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 80_000,
    env: {
      ...cleanProcessEnv,
      PATH: `${unavailableBin}:${process.env.PATH || ''}`,
    },
  })
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 0, output)
  assert.match(output, /✔ closed v1\/v2\/v3 downprojections use an offline validator with recursive closure checks/)
  assert.match(output, /pass 1/)
  assert.match(output, /fail 0/)
  assert.doesNotMatch(output, /- closed v1\/v2\/v3 downprojections use an offline validator/)
})

test('HTML renderer has the projected snapshot as its only dynamic input', () => {
  assert.match(PULSE_SOURCE, /function render\(snapshot(?:,\s*\{[^}]+\}\s*=\s*\{\})?\)\s*\{/)
  assert.match(PULSE_SOURCE,
    /const publishedSnapshot = JSON\.parse\(jsonText\)[\s\S]*?const html = render\(publishedSnapshot,\s*\{ refreshScriptName:/,
    'HTML must consume the exact serialized JSON document')
  assert.doesNotMatch(PULSE_SOURCE, /render\(\s*(?:view|derive\s*\()/,
    'publisher must never pass raw observations to the HTML renderer')

  const start = PULSE_SOURCE.indexOf('function graphRows(snapshot)')
  const end = PULSE_SOURCE.indexOf('\nconst lockWait', start)
  assert.ok(start >= 0 && end > start, 'could not isolate the renderer dependency boundary')
  const renderer = PULSE_SOURCE.slice(start, end)
  assert.doesNotMatch(renderer, /\b(?:REPO|STORE|OUTBOX|EVENTS|DISPATCH|INTERVAL)\b/,
    'renderer must not read dynamic globals outside the snapshot')
  assert.doesNotMatch(renderer, /\b(?:readFileSync|readdirSync|statSync|derive|footprints|recorded|aliveWorkers)\s*\(/,
    'renderer must not consult probes or raw stores')
})

test('JSON is a safe SSOT: corrupt data degrades explicitly while valid data survives', () => {
  const dir = repo()
  const dispatchId = '11111111-1111-4111-8111-111111111111'
  const verdictDispatchId = '22222222-2222-4222-8222-222222222222'
  const rawSecret = 'PULSE_RAW_SECRET_7f4dd8d4'
  const rawError = 'PULSE_RAW_ERROR_do_not_render'
  const rawPane = '%424242'
  const absolutePath = join(dir, 'private', 'worker-output.txt')

  const dispatchPath = join(dir, '.tmux-teams', 'dispatch', 'pulse-valid-run.md')
  writeFileSync(dispatchPath, [
    `dispatch_id: ${dispatchId}`,
    'task_id: pulse-valid-run',
    'worker: codex',
    'transport: tmux',
    `pane: ${rawPane}`,
    'pid: 987654321',
    'session: raw-session-name',
    `raw_error: ${rawError}`,
    '',
  ].join('\n'))
  age(dispatchPath, 600)

  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260722-0100_pulse-valid-verdict_codex.md'), [
    `dispatch_id: ${verdictDispatchId}`,
    'task_id: pulse-valid-verdict',
    'worker: codex',
    'transport: acp',
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    `lesson: ${rawSecret}`,
    `verify_cmd: cat ${absolutePath}`,
    `evidence: ${rawSecret} ${absolutePath}`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260722-0101_corrupt.md'), [
    'task_id: pulse-invalid-event',
    `lesson: ${rawSecret}`,
    `raw_error: ${rawError}`,
    '',
  ].join('\n'))

  writeFileSync(join(dir, '.mailbox-out', '.gitignore'), `${rawSecret}\nTEAM_DONE .gitignore\n`)
  writeFileSync(join(dir, '.mailbox-out', 'pulse invalid outbox'), `${rawSecret}\n`)
  const validOutbox = join(dir, '.mailbox-out', 'pulse-valid-run')
  writeFileSync(validOutbox, `ASKED: fixture\nDID: ${rawSecret}\nEVIDENCE: ${absolutePath}\n`)
  age(validOutbox, 600)

  const { snapshot, stdout } = runJson(dir)
  assertPulseV4(snapshot)

  const run = snapshot.history.runs.find(item => item.task_id === 'pulse-valid-run')
  assert.ok(run, 'valid dispatch must survive projection')
  assert.equal(run.dispatch_id, dispatchId)
  assert.equal(run.identity_source, 'dispatch_id')
  assert.equal(run.state, 'died')
  assert.equal(run.worker, 'codex')
  assert.equal(run.transport, 'tmux')
  assert.equal(run.started_at, null)
  assert.equal(run.elapsed_sec, null)
  assert.ok(run.silence_sec >= 500, 'silence is measured for this fixture and must not default to zero')
  assert.equal(run.timeout_sec, null, 'an unmeasured timeout must remain null, never become zero')
  assert.deepEqual(run.signals, {
    dispatch: 'present',
    liveness: 'dead',
    pane: 'gone',
    terminal: 'absent',
    pm_verdict: 'absent',
    correlation: 'dispatch_id',
  })
  assert.deepEqual(run.reason_codes, ['PROCESS_MISSING_AFTER_DISPATCH'])
  assert.deepEqual(run.advisory, { attention: true, action_code: 'inspect_worker', auto_execute: false })

  const verdict = snapshot.recent_verdicts.find(item => item.task_id === 'pulse-valid-verdict')
  assert.ok(verdict, 'a valid event must survive beside a corrupt event')
  assert.equal(verdict.dispatch_id, verdictDispatchId)
  assert.equal(verdict.started_at, null)
  assert.equal(verdict.wait_sec, null, 'missing timing must project as null')
  assert.equal(verdict.timeout_sec, null, 'missing timeout must project as null')
  const workerStat = snapshot.worker_stats.find(item => item.worker === 'codex')
  assert.ok(workerStat)
  assert.equal(workerStat.median_wait_sec, null, 'no timing samples must produce a null median, never zero')
  assert.equal(snapshot.summary.active, 0, 'dead attempts belong to history, not the operational count')
  assert.equal(snapshot.source_health.outbox, 'ok', 'ignored outbox entries must not degrade the source')
  assert.ok(!snapshot.diagnostics.some(item => item.source === 'outbox'),
    'ignored outbox entries must not create diagnostics')
  assert.equal(snapshot.source_health.events, 'degraded')
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.observation.quality, 'degraded')
  assert.ok(snapshot.diagnostics.some(item => item.source === 'events'),
    'the corrupt event must produce an allowlisted diagnostic')

  const projectedIds = new Set([
    ...snapshot.runs.map(item => item.task_id),
    ...snapshot.history.runs.map(item => item.task_id),
    ...snapshot.recent_verdicts.map(item => item.task_id),
  ])
  assert.ok(!projectedIds.has('.gitignore'))
  assert.ok(!projectedIds.has('pulse invalid outbox'))
  assert.ok(!projectedIds.has('pulse-invalid-event'))

  const forbiddenKeys = new Set([
    'lesson', 'verify_cmd', 'evidence', 'raw_outbox', 'detail', 'pid', 'session',
    'cmdline', 'raw_error', 'path', 'file',
  ])
  walkKeys(snapshot, (key, path) => assert.ok(!forbiddenKeys.has(key), `forbidden raw field leaked at ${path}`))
  const rawLeafValues = [
    rawSecret, rawError, rawPane, absolutePath, dir, 'raw-session-name', '987654321',
    '.gitignore', 'pulse-invalid-event', 'pulse invalid outbox',
  ]
  walkLeaves(snapshot, (value, path) => {
    if (typeof value !== 'string') return
    for (const raw of rawLeafValues) assert.ok(!value.includes(raw), `raw value leaked at ${path}: ${raw}`)
  })
  for (const raw of rawLeafValues) {
    assert.ok(!stdout.includes(raw), `raw value leaked into JSON: ${raw}`)
  }

  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const meta = html.match(/<meta\s+name="tmux-teams-snapshot-id"\s+content="([^"]+)"\s*>/)
  assert.equal(meta?.[1], snapshot.snapshot_id)
  for (const item of [...snapshot.runs, ...snapshot.recent_verdicts]) {
    assert.ok(html.includes(item.task_id), `HTML omitted projected task ${item.task_id}`)
  }
  for (const item of snapshot.runs) assert.ok(html.includes(item.state), `HTML omitted projected state ${item.state}`)
  for (const raw of [
    rawSecret, rawError, rawPane, absolutePath, dir, 'raw-session-name', '.gitignore',
    'pulse-invalid-event', 'pulse invalid outbox',
  ]) {
    assert.ok(!html.includes(raw), `HTML consulted hidden raw input instead of the JSON snapshot: ${raw}`)
  }
})

test('team graph CLI consumes a graph wrapper, publishes a content digest, and keeps the path private', () => {
  const dir = repo()
  const graphPath = join(dir, 'SENTINEL_TEAM_GRAPH_SOURCE.json')
  const graphInput = {
    graph: {
      project_id: 'graph-cli-fixture',
      teams: [{
        team_id: 'alpha',
        name: 'Alpha Team',
        dispatcher_id: 'dispatcher-a',
        worker_ids: ['worker-a', 'worker-b'],
        evaluator_id: 'evaluator-a',
        downstream_team_id: null,
      }],
    },
  }
  const graphText = `${JSON.stringify(graphInput)}\n`
  writeFileSync(graphPath, graphText)
  const result = spawnSync(process.execPath, [PULSE, 'json', dir, '--team-graph', graphPath], {
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(result.stdout)
  assert.deepEqual(snapshot.team_graph.project_id, 'graph-cli-fixture')
  assert.deepEqual(snapshot.team_graph.teams[0].worker_ids, ['worker-a', 'worker-b'])
  assert.equal(snapshot.team_graph.source_digest,
    `sha256:${createHash('sha256').update(graphText).digest('hex')}`)
  assert.equal(snapshot.team_graph.outer_controller_id, null)
  assert.equal(result.stdout.includes(graphPath), false)
  assert.equal(result.stdout.includes('SENTINEL_TEAM_GRAPH_SOURCE'), false)
})

test('team_runtime.v1 is optional, closed, graph-bound, and survives the Pulse v4 projection', () => {
  const dir = repo()
  const graphPath = join(dir, 'runtime-graph.json')
  const runtimePath = join(dir, 'runtime-evidence.json')
  const deliveryPath = join(dir, 'delivery-loop.json')
  const graphText = `${JSON.stringify(runtimeGraph())}\n`
  writeFileSync(graphPath, graphText)
  const graphDigest = `sha256:${createHash('sha256').update(graphText).digest('hex')}`
  const runtime = validTeamRuntime(graphDigest)
  writeFileSync(runtimePath, `${JSON.stringify(runtime)}\n`)
  const { snapshot } = runJson(dir, process.env, [
    '--delivery-loop', deliveryPath, '--team-graph', graphPath, '--team-runtime', runtimePath,
  ])
  assert.deepEqual(snapshot.team_runtime, runtime)
  assert.equal(snapshot.team_graph.outer_controller_id, 'outer-control')
  assert.equal(snapshot.diagnostics.some((item) => item.source === 'team_runtime'), false)
  for (const projected of [downProjectPulseV1(snapshot), downProjectPulseV2(snapshot), downProjectPulseV3(snapshot)]) {
    assert.equal(Object.hasOwn(projected, 'team_runtime'), false)
  }
})

test('invalid, stale, and graph-mismatched team runtime input fails closed visibly', () => {
  const graph = runtimeGraph()
  const graphText = `${JSON.stringify(graph)}\n`
  for (const [label, mutate, expectedCode] of [
    ['invalid field', (runtime) => { runtime.agent_runs[0].agent_id = 'outer.control' }, 'TEAM_RUNTIME_INPUT_INVALID'],
    ['graph digest', (runtime) => { runtime.graph_source_digest = `sha256:${'f'.repeat(64)}` }, 'TEAM_RUNTIME_INPUT_INVALID'],
    ['stale', (runtime) => {
      runtime.generated_at = '2020-01-01T00:00:00.000Z'
      runtime.expires_at = '2020-01-01T00:01:00.000Z'
    }, 'TEAM_RUNTIME_STALE'],
  ]) {
    const dir = repo()
    try {
      const graphPath = join(dir, `${label.replaceAll(' ', '-')}-graph.json`)
      const runtimePath = join(dir, `${label.replaceAll(' ', '-')}-runtime.json`)
      writeFileSync(graphPath, graphText)
      const digest = `sha256:${createHash('sha256').update(graphText).digest('hex')}`
      const runtime = validTeamRuntime(digest)
      mutate(runtime)
      writeFileSync(runtimePath, JSON.stringify(runtime))
      const { snapshot } = runJson(dir, process.env, ['--team-graph', graphPath, '--team-runtime', runtimePath])
      assert.equal(snapshot.team_runtime, null, label)
      assert.ok(snapshot.diagnostics.some((item) => item.code === expectedCode && item.source === 'team_runtime'), label)
    } finally {
      removeTempRepo(dir)
    }
  }
})

test('the shared Team graph contract rejects punctuation that ACP agent IDs cannot carry', () => {
  const graph = runtimeGraph()
  graph.teams[0].worker_ids[0] = 'worker.with.dot'
  const checked = sanitizeTeamRuntimeProjection(null)
  assert.equal(checked.projection, null)
  const dir = repo()
  try {
    const graphPath = join(dir, 'invalid-agent-graph.json')
    writeFileSync(graphPath, JSON.stringify(graph))
    const snapshot = runJson(dir, process.env, ['--team-graph', graphPath]).snapshot
    assert.equal(snapshot.team_graph, null)
    assert.ok(snapshot.diagnostics.some((item) => item.code === 'TEAM_GRAPH_INPUT_INVALID'))
  } finally {
    removeTempRepo(dir)
  }
})

test('producer liveness evidence is projected as bounded digest-only truth', () => {
  const dir = repo()
  const fixture = writeExactLivenessFixture(dir, 'acp-liveness-v1.json')
  const { snapshot: projectedSnapshot } = runJson(dir)
  const projectedRun = projectedSnapshot.runs.find((item) => item.task_id === fixture.task_id)
  assert.ok(projectedRun)
  assert.equal(projectedRun.liveness_evidence.observed_at, fixture.observed_at)
  assert.deepEqual(projectedRun.liveness_evidence.active_tools, fixture.active_tools)
  assert.deepEqual(projectedRun.liveness_evidence.tools, fixture.tools)
  assert.equal(projectedRun.agent_id, fixture.agent_id)
  assert.equal(projectedRun.model, fixture.requested_model)
  assert.equal(JSON.stringify(projectedSnapshot).includes('private_payload'), false)
  assert.doesNotMatch(JSON.stringify(projectedRun.liveness_evidence), /"(?:content|output|locations)"\s*:/)
})

test('producer recovery evidence preserves every stall-history state and reason', () => {
  const dir = repo()
  const fixture = writeExactLivenessFixture(dir, 'acp-liveness-v1-recovery.json')
  const { snapshot: projectedSnapshot } = runJson(dir)
  const projectedRun = projectedSnapshot.history.runs.find((item) => item.task_id === fixture.task_id)
  assert.ok(projectedRun)
  assert.equal(projectedRun.liveness_evidence.liveness_state, 'completed')
  assert.deepEqual(projectedRun.liveness_evidence.stall_history, fixture.stall_history)
  assert.equal(projectedRun.model, fixture.requested_model)
})

test('the three frozen producer fixtures validate as closed raw acp-liveness.v1', () => {
  for (const fixtureName of [
    'acp-liveness-v1.json',
    'acp-liveness-v1-startup.json',
    'acp-liveness-v1-recovery.json',
  ]) {
    const fixture = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, fixtureName), 'utf8'))
    const result = validateAcpLivenessV1(fixture)
    assert.equal(result.ok, true, `${fixtureName}: ${result.reason || 'raw fixture rejected'}`)
    assert.deepEqual(result.value, fixture, `${fixtureName} must not be rewritten during raw validation`)
  }
})

test('raw liveness rejects producer-unknown fields and invalid nested members as one evidence unit', () => {
  const fixture = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8'))
  const cases = [
    ['top-level content', (value) => { value.content = 'raw payload' }],
    ['active tool content', (value) => { value.active_tools[0].content = 'raw payload' }],
    ['tool catalog status', (value) => { value.tools.t1.status = 'not-a-producer-status' }],
    ['history reason on non-cancellation state', (value) => {
      value.stall_history = [{ state: 'recovered', evidence: 'message', observed_at: value.observed_at, reason: 'wrong-shape' }]
    }],
  ]
  for (const [label, mutate] of cases) {
    const value = structuredClone(fixture)
    mutate(value)
    const result = validateAcpLivenessV1(value)
    assert.equal(result.ok, false, label)
    assert.equal(result.code, 'LIVENESS_EVIDENCE_INVALID', label)
  }
})

test('exact producer fixtures flow through Pulse JSON and graph DOM with lifecycle truth', () => {
  const cases = [
    {
      name: 'acp-liveness-v1.json', expectedCurrent: true, expectedStatus: 'tool_running',
      expectedModel: 'gpt-5.6-luna', expectedHistory: false,
    },
    {
      name: 'acp-liveness-v1-recovery.json', expectedCurrent: false, expectedStatus: 'completed',
      expectedModel: 'gpt-5.6-luna', expectedHistory: true, expectedHistoryState: 'recovered',
    },
    {
      name: 'acp-liveness-v1-startup.json', expectedCurrent: false, expectedStatus: 'failed',
      expectedModel: null, expectedHistory: true, expectedHistoryState: 'cancellation_unavailable',
    },
  ]
  for (const item of cases) {
    const dir = repo()
    try {
      const { fixture, graphPath } = writeExactLivenessFixture(dir, item.name, { graph: true })
      const { snapshot } = runJson(dir, process.env, ['--team-graph', graphPath])
      const current = snapshot.runs.find((run) => run.task_id === fixture.task_id)
      const historical = snapshot.history.runs.find((run) => run.task_id === fixture.task_id)
      assert.equal(Boolean(current), item.expectedCurrent, item.name)
      assert.equal(Boolean(historical), item.expectedHistory, item.name)
      const run = current || historical
      assert.equal(run.model, item.expectedModel, `${item.name} model attestation`)
      assert.equal(run.liveness_evidence.observed_at, fixture.observed_at)
      assert.equal(run.liveness_evidence.agent_id, fixture.agent_id)
      assert.equal(run.liveness_evidence.active_tools.length,
        fixture.active_tools.length, `${item.name} active tool count`)
      assert.deepEqual(run.liveness_evidence.tools, fixture.tools, `${item.name} tool catalog`)
      assert.doesNotMatch(JSON.stringify(run.liveness_evidence), /"(?:content|output|locations)"\s*:/)
      if (item.expectedHistoryState) {
        assert.ok(run.liveness_evidence.stall_history.some((entry) => entry.state === item.expectedHistoryState))
      }
      if (item.expectedCurrent) {
      } else {
      }
    } finally {
      removeTempRepo(dir)
    }
  }
})

test('rebased exact fixtures remain valid after a deterministic 24-hour clock advance', { timeout: 30_000 }, async () => {
  const fixtureNames = [
    'acp-liveness-v1.json',
    'acp-liveness-v1-recovery.json',
    'acp-liveness-v1-startup.json',
  ]
  const frozenFixtures = fixtureNames.map((name) =>
    JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, name), 'utf8')))
  const frozenObservedMs = Math.max(...frozenFixtures.map((fixture) => Date.parse(fixture.observed_at)))
  const effectiveNowMs = Math.max(Date.now(), frozenObservedMs + (24 * 60 * 60 * 1000))
  const expected = new Map([
    ['acp-liveness-v1.json', ['current', 'tool_running']],
    ['acp-liveness-v1-recovery.json', ['history', 'completed']],
    ['acp-liveness-v1-startup.json', ['history', 'failed']],
  ])

  for (const name of fixtureNames) {
    const source = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, name), 'utf8'))
    const dir = repo()
    const { fixture, graphPath } = writeExactLivenessFixture(dir, name, {
      graph: true, effectiveNowMs,
    })
    const sourceTimes = collectIsoTimestamps(source)
    const rebasedTimes = collectIsoTimestamps(fixture)
    const commonDeltaMs = Date.parse(fixture.observed_at) - Date.parse(source.observed_at)
    assert.ok(effectiveNowMs - Date.parse(source.observed_at) >= 24 * 60 * 60 * 1000)
    assert.ok(effectiveNowMs - Date.parse(fixture.observed_at) < 60 * 1000,
      `${name} must be rebased to a fresh observation at the effective test clock`)
    assert.deepEqual(rebasedTimes.map(([path]) => path), sourceTimes.map(([path]) => path),
      `${name} timestamp paths must remain intact`)
    assert.ok(rebasedTimes.every(([, timestamp], index) =>
      timestamp - sourceTimes[index][1] === commonDeltaMs),
    `${name} timestamps must share one rebase delta`)
    assert.deepEqual(stripIsoTimestamps(fixture), stripIsoTimestamps(source),
      `${name} non-time producer structure must remain exact`)
    assert.equal(validateAcpLivenessV1(fixture).ok, true, `${name} rebased raw evidence`)

    const [surface, status] = expected.get(name)
    let liveProcess = null
    try {
      if (surface === 'current') {
        const fakeCompanion = join(dir, 'acp-companion.mjs')
        writeFileSync(fakeCompanion, 'setTimeout(() => {}, 30000)\n')
        liveProcess = spawn(process.execPath, [fakeCompanion, 'codex', dir, fixture.task_id, 'brief.md', '30'], {
          cwd: dir, stdio: ['ignore', 'ignore', 'ignore'],
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const { snapshot } = runJson(dir, process.env, ['--team-graph', graphPath], effectiveNowMs)
      assert.equal(snapshot.generated_at, new Date(effectiveNowMs).toISOString(),
        `${name} Pulse child must observe the aligned effective test clock`)
      const projected = (surface === 'current' ? snapshot.runs : snapshot.history.runs)
        .find((run) => run.task_id === fixture.task_id)
      assert.ok(projected, `${name} must project on its lifecycle surface`)
      assert.equal(projected.liveness_evidence.liveness_state, status)
    } finally {
      liveProcess?.kill('SIGTERM')
      removeTempRepo(dir)
    }
  }
})

test('an adversarial process-clock +24-hour command re-runs lifecycle and stale guards', { timeout: 90_000 }, () => {
  const fixtureNames = [
    'acp-liveness-v1.json',
    'acp-liveness-v1-recovery.json',
    'acp-liveness-v1-startup.json',
  ]
  const frozenObservedMs = Math.max(...fixtureNames.map((name) =>
    Date.parse(JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, name), 'utf8')).observed_at)))
  const effectiveNowMs = Math.max(Date.now(), frozenObservedMs + (24 * 60 * 60 * 1000))
  const adversarialNowMs = effectiveNowMs + (24 * 60 * 60 * 1000)
  const dir = repo()
  try {
    const preloadPath = writePinnedClockPreload(dir, adversarialNowMs)
    const { NODE_TEST_CONTEXT: _nodeTestContext, ...cleanProcessEnv } = process.env
    const env = {
      ...cleanProcessEnv,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preloadPath}`.trim(),
    }
    const result = spawnSync(process.execPath, [
      '--test',
      '--test-name-pattern',
      'exact producer fixtures flow through|rebased exact fixtures remain|observed_at controls freshness',
      join(ROOT, 'tests', 'pulse-json.test.mjs'),
    ], { cwd: ROOT, encoding: 'utf8', env, timeout: 80_000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const output = `${result.stdout}\n${result.stderr}`
    assert.match(output, /tests 3/)
    assert.match(output, /pass 3/)
    assert.match(output, /fail 0/)
    assert.match(output, /skipped 0/)
  } finally {
    removeTempRepo(dir)
  }
})

test('liveness future skew accepts the exact 120000ms boundary and rejects larger skew', { timeout: 30_000 }, async () => {
  const source = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8'))
  const effectiveNowMs = Math.max(Date.now(), Date.parse(source.observed_at) + 24 * 60 * 60 * 1000)
  for (const [label, offsetMs, accepted] of [
    ['fresh', 0, true],
    ['exact-boundary', 120_000, true],
    ['too-far-future', 120_001, false],
  ]) {
    const dir = repo()
    try {
      const fixture = rebaseExactLivenessFixture(source, effectiveNowMs + 30_000 + offsetMs)
      const dispatchPath = join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`)
      writeFileSync(dispatchPath, [
        `dispatch_id: ${fixture.dispatch_id}`, `task_id: ${fixture.task_id}`,
        `worker: ${fixture.worker}`, `agent_id: ${fixture.agent_id}`, 'transport: acp', '',
      ].join('\n'))
      mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
      writeFileSync(join(dir, '.tmux-teams', 'liveness', `${fixture.task_id}.json`), JSON.stringify(fixture))
      const fakeCompanion = join(dir, 'acp-companion.mjs')
      writeFileSync(fakeCompanion, 'setTimeout(() => {}, 30000)\n')
      const child = spawn(process.execPath, [fakeCompanion, 'codex', dir, fixture.task_id, 'brief.md', '30'], {
        cwd: dir, stdio: ['ignore', 'ignore', 'ignore'],
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const { snapshot } = runJson(dir, process.env, [], effectiveNowMs)
        const run = snapshot.runs.find((item) => item.task_id === fixture.task_id)
        assert.equal(Boolean(run?.liveness_evidence), accepted, label)
        if (!accepted) {
          assert.ok(snapshot.diagnostics.some((item) => item.code === 'LIVENESS_EVIDENCE_FUTURE'), label)
        }
      } finally {
        child.kill('SIGTERM')
      }
    } finally {
      removeTempRepo(dir)
    }
  }
})

test('a source state roughly 86400 seconds in the future is not operational', { timeout: 30_000 }, async () => {
  const source = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8'))
  const effectiveNowMs = Math.max(Date.now(), Date.parse(source.observed_at) + 24 * 60 * 60 * 1000)
  const dir = repo()
  try {
    const fixture = rebaseExactLivenessFixture(source, effectiveNowMs + 86_370_000)
    const dispatchPath = join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`)
    writeFileSync(dispatchPath, [
      `dispatch_id: ${fixture.dispatch_id}`, `task_id: ${fixture.task_id}`,
      `worker: ${fixture.worker}`, `agent_id: ${fixture.agent_id}`, 'transport: acp', '',
    ].join('\n'))
    mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
    writeFileSync(join(dir, '.tmux-teams', 'liveness', `${fixture.task_id}.json`), JSON.stringify(fixture))
    const fakeCompanion = join(dir, 'acp-companion.mjs')
    writeFileSync(fakeCompanion, 'setTimeout(() => {}, 30000)\n')
    const child = spawn(process.execPath, [fakeCompanion, 'codex', dir, fixture.task_id, 'brief.md', '30'], {
      cwd: dir, stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const { snapshot } = runJson(dir, process.env, [], effectiveNowMs)
    assert.equal(snapshot.runs.find((item) => item.task_id === fixture.task_id)?.liveness_evidence, null)
      assert.ok(snapshot.diagnostics.some((item) => item.code === 'LIVENESS_EVIDENCE_FUTURE'))
    } finally {
      child.kill('SIGTERM')
    }
  } finally {
    removeTempRepo(dir)
  }
})

test('liveness provenance guards reject filename, footprint dispatch, graph identity, and producer identity independently', () => {
  const fixture = JSON.parse(readFileSync(join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8'))
  const cases = [
    ['filename stem', (dir, value) => writeFileSync(join(dir, '.tmux-teams', 'liveness', 'wrong-filename.json'), JSON.stringify(value)), 'wrong-filename'],
    ['footprint dispatch', (dir, value) => {
      writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`), [
        `dispatch_id: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, `task_id: ${fixture.task_id}`,
        `worker: ${fixture.worker}`, `agent_id: ${fixture.agent_id}`, 'transport: acp', '',
      ].join('\n'))
      writeFileSync(join(dir, '.tmux-teams', 'liveness', `${fixture.task_id}.json`), JSON.stringify(value))
    }, fixture.task_id],
    ['producer agent', (dir, value) => {
      writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`), [
        `dispatch_id: ${fixture.dispatch_id}`, `task_id: ${fixture.task_id}`,
        `worker: ${fixture.worker}`, 'agent_id: footprint-agent', 'transport: acp', '',
      ].join('\n'))
      writeFileSync(join(dir, '.tmux-teams', 'liveness', `${fixture.task_id}.json`), JSON.stringify(value))
    }, fixture.task_id],
    ['graph agent', (dir, value) => {
      writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`), [
        `dispatch_id: ${fixture.dispatch_id}`, `task_id: ${fixture.task_id}`,
        `worker: ${fixture.worker}`, 'agent_id: graph-footprint-agent', 'transport: acp', '',
      ].join('\n'))
      writeFileSync(join(dir, '.tmux-teams', 'liveness', `${fixture.task_id}.json`), JSON.stringify(value))
      const graphPath = join(dir, 'graph-agent.json')
      writeFileSync(graphPath, JSON.stringify({
        graph: { project_id: 'graph-agent-project', teams: [{
          team_id: 'graph-team', name: 'Graph Team', dispatcher_id: 'graph-dispatcher',
          worker_ids: ['different-graph-agent'], evaluator_id: 'graph-evaluator',
          downstream_team_id: null,
        }] },
      }))
      return graphPath
    }, fixture.task_id],
  ]
  for (const [label, writeCase, filename] of cases) {
    const dir = repo()
    mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
    const value = structuredClone(fixture)
    if (label === 'producer agent') value.agent_id = 'producer-agent'
    if (label === 'footprint dispatch') value.dispatch_id = fixture.dispatch_id
    if (label === 'filename stem') value.task_id = fixture.task_id
    if (label === 'graph agent') value.agent_id = 'graph-footprint-agent'
    const graphPath = writeCase(dir, value)
    if (label === 'filename stem') {
      writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${fixture.task_id}.md`), [
        `dispatch_id: ${fixture.dispatch_id}`, `task_id: ${fixture.task_id}`,
        `worker: ${fixture.worker}`, `agent_id: ${fixture.agent_id}`, 'transport: acp', '',
      ].join('\n'))
    }
    const result = spawnSync(process.execPath, [PULSE, 'json', dir, ...(graphPath ? ['--team-graph', graphPath] : [])], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    const snapshot = JSON.parse(result.stdout)
    assert.equal(snapshot.runs.find((run) => run.task_id === fixture.task_id)?.liveness_evidence, null, label)
    assert.ok(snapshot.diagnostics.some((diagnostic) =>
      ['LIVENESS_EVIDENCE_MISMATCH', 'LIVENESS_EVIDENCE_INVALID'].includes(diagnostic.code)), label)
    if (filename !== fixture.task_id) assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.source === 'liveness'), label)
  }
})

test('each invalid liveness v1 field is rejected without null or empty-array coercion', () => {
  const base = structuredClone(JSON.parse(readFileSync(
    join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8')))
  base.task_id = 'liveness-field-check'
  base.dispatch_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  base.agent_id = 'graph-worker'
  const cases = [
    ['schema', { schema_version: 'acp-liveness.v2' }, 'LIVENESS_EVIDENCE_MISMATCH'],
    ['task', { task_id: 'other-task' }, 'LIVENESS_EVIDENCE_MISMATCH'],
    ['dispatch', { dispatch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, 'LIVENESS_EVIDENCE_MISMATCH'],
    ['agent', { agent_id: 'other-agent' }, 'LIVENESS_EVIDENCE_MISMATCH'],
    ['protocol timestamp', { last_protocol_activity_at: 42 }, 'LIVENESS_EVIDENCE_INVALID'],
    ['progress timestamp', { last_meaningful_progress_at: 'not-a-date' }, 'LIVENESS_EVIDENCE_INVALID'],
    ['state', { liveness_state: 'running' }, 'LIVENESS_EVIDENCE_INVALID'],
    ['unknown field', { private_payload: 'must reject' }, 'LIVENESS_EVIDENCE_INVALID'],
    ['empty termination reason', { termination_reason: '' }, 'LIVENESS_EVIDENCE_INVALID'],
    ['active tool', { active_tools: [null] }, 'LIVENESS_EVIDENCE_INVALID'],
    ['start after observation', { started_at: '2026-07-25T16:03:30Z' }, 'LIVENESS_EVIDENCE_INVALID'],
    ['lease derivation', { next_lease_expiry_at: '2026-07-25T16:03:30Z' }, 'LIVENESS_EVIDENCE_INVALID'],
    ['tool status', { active_tools: [{ ...base.active_tools[0], status: 'completed' }] }, 'LIVENESS_EVIDENCE_INVALID'],
    ['history', { stall_history: [{ state: 'active', observed_at: '2026-07-25T11:00:00Z', evidence: 'bad' }] }, 'LIVENESS_EVIDENCE_INVALID'],
  ]
  for (const [label, change, expectedCode] of cases) {
    const dir = repo()
    writeFileSync(join(dir, '.tmux-teams', 'dispatch', 'liveness-field-check.md'), [
      `dispatch_id: ${base.dispatch_id}`, `task_id: ${base.task_id}`, 'worker: codex',
      'agent_id: graph-worker', 'transport: acp', '',
    ].join('\n'))
    mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
    writeFileSync(join(dir, '.tmux-teams', 'liveness', 'liveness-field-check.json'), JSON.stringify({ ...base, ...change }))
    const { snapshot } = runJson(dir)
    const run = snapshot.runs.find((item) => item.task_id === base.task_id)
    assert.equal(run?.liveness_evidence, null, label)
    assert.ok(snapshot.diagnostics.some((item) => item.code === expectedCode && item.source === 'liveness'), label)
  }
})

test('observed_at controls freshness; mtime and a live process cannot waive staleness', { timeout: 30_000 }, async () => {
  const dir = repo()
  const task = 'stale-live-evidence'
  const dispatchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${task}.md`), [
    `dispatch_id: ${dispatchId}`, `task_id: ${task}`, 'worker: codex',
    'agent_id: graph-worker', 'transport: acp', '',
  ].join('\n'))
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
  const stale = structuredClone(JSON.parse(readFileSync(
    join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8')))
  stale.task_id = task
  stale.dispatch_id = dispatchId
  stale.agent_id = 'graph-worker'
  stale.liveness_state = 'tool_running'
  stale.started_at = '2020-01-01T00:00:00Z'
  stale.observed_at = '2020-01-01T00:00:00Z'
  const fakeCompanion = join(dir, 'acp-companion.mjs')
  writeFileSync(fakeCompanion, 'setTimeout(() => {}, 30000)\n')
  writeFileSync(join(dir, '.tmux-teams', 'liveness', `${task}.json`), JSON.stringify(stale))
  const child = spawn(process.execPath, [fakeCompanion, 'codex', dir, task, 'brief.md', '30'], {
    cwd: dir, stdio: ['ignore', 'ignore', 'ignore'],
  })
  const oldFileDir = repo()
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const { snapshot } = runJson(dir)
    assert.equal(snapshot.runs.find((item) => item.task_id === task)?.liveness_evidence, null)
    assert.ok(snapshot.diagnostics.some((item) => item.code === 'LIVENESS_EVIDENCE_MISMATCH'))

    const oldFileTask = 'fresh-observed-old-file'
    const oldFileDispatch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const oldFileFixture = rebaseExactLivenessFixture(JSON.parse(readFileSync(
      join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8')), Date.now())
    oldFileFixture.task_id = oldFileTask
    oldFileFixture.dispatch_id = oldFileDispatch
    oldFileFixture.agent_id = 'graph-worker'
    writeFileSync(join(oldFileDir, '.tmux-teams', 'dispatch', `${oldFileTask}.md`), [
      `dispatch_id: ${oldFileDispatch}`, `task_id: ${oldFileTask}`, 'worker: codex',
      'agent_id: graph-worker', 'transport: acp', '',
    ].join('\n'))
    mkdirSync(join(oldFileDir, '.tmux-teams', 'liveness'), { recursive: true })
    const oldFileEvidence = join(oldFileDir, '.tmux-teams', 'liveness', `${oldFileTask}.json`)
    writeFileSync(oldFileEvidence, JSON.stringify(oldFileFixture))
    age(oldFileEvidence, 86_400)
    const oldFileSnapshot = runJson(oldFileDir).snapshot
    assert.deepEqual(
      (oldFileSnapshot.runs.find((item) => item.task_id === oldFileTask) ||
        oldFileSnapshot.history.runs.find((item) => item.task_id === oldFileTask))?.liveness_evidence,
      {
        schema_version: oldFileFixture.schema_version,
        task_id: oldFileTask,
        dispatch_id: oldFileDispatch,
        agent_id: 'graph-worker',
        observed_at: oldFileFixture.observed_at,
        liveness_state: oldFileFixture.liveness_state,
        last_protocol_activity_at: oldFileFixture.last_protocol_activity_at,
        last_meaningful_progress_at: oldFileFixture.last_meaningful_progress_at,
        termination_reason: oldFileFixture.termination_reason,
        active_tools: oldFileFixture.active_tools,
        tools: oldFileFixture.tools,
        stall_history: oldFileFixture.stall_history,
      },
      'fresh producer observation must survive an old filesystem mtime',
    )
  } finally {
    child.kill('SIGTERM')
    removeTempRepo(dir)
    removeTempRepo(oldFileDir)
  }
})

test('liveness v1 rejects schema, task, dispatch, and identity provenance mismatches visibly', () => {
  const dir = repo()
  const task = 'liveness-mismatch'
  const dispatchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${task}.md`), [
    `dispatch_id: ${dispatchId}`, `task_id: ${task}`, 'worker: codex', 'agent_id: graph-worker', 'transport: acp', '',
  ].join('\n'))
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'liveness', `${task}.json`), JSON.stringify({
    schema_version: 'acp-liveness.v0',
    task_id: 'other-task',
    dispatch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    agent_id: 'other-agent',
    liveness_state: 'active',
    last_protocol_activity_at: null,
    last_meaningful_progress_at: null,
    termination_reason: null,
    active_tools: [],
    stall_history: [],
  }))
  const { snapshot } = runJson(dir)
  const run = snapshot.runs.find((item) => item.task_id === task)
  assert.ok(run)
  assert.equal(run.liveness_evidence, null)
  assert.ok(snapshot.diagnostics.some((item) =>
    item.code === 'LIVENESS_EVIDENCE_MISMATCH' && item.source === 'liveness'))
})

test('a valid-schema liveness identity conflict cannot enrich the configured dispatch', () => {
  const dir = repo()
  const task = 'liveness-agent-conflict'
  const dispatchId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${task}.md`), [
    `dispatch_id: ${dispatchId}`, `task_id: ${task}`, 'worker: codex',
    'agent_id: configured-agent', 'transport: acp', '',
  ].join('\n'))
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
  const evidence = structuredClone(JSON.parse(readFileSync(
    join(LIVENESS_FIXTURE_DIR, 'acp-liveness-v1.json'), 'utf8')))
  evidence.task_id = task
  evidence.dispatch_id = dispatchId
  evidence.agent_id = 'different-agent'
  writeFileSync(join(dir, '.tmux-teams', 'liveness', `${task}.json`), JSON.stringify(evidence))
  const { snapshot } = runJson(dir)
  const run = snapshot.runs.find((item) => item.task_id === task)
  assert.ok(run)
  assert.equal(run.agent_id, null)
  assert.equal(run.liveness_evidence, null)
  assert.ok(snapshot.diagnostics.some((item) =>
    item.code === 'AGENT_ID_CONFLICT' && item.source === 'liveness'))
})

test('source truncation keeps a live ACP dispatch ahead of stale dispatch files', async () => {
  const dir = repo()
  const task = 'live-priority'
  const dispatchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${task}.md`), [
    `dispatch_id: ${dispatchId}`,
    `task_id: ${task}`,
    'worker: codex',
    'transport: acp',
    'timeout_sec: 600',
    '',
  ].join('\n'))
  const brief = join(dir, 'brief.md')
  const fakeCompanion = join(dir, 'acp-companion.mjs')
  writeFileSync(fakeCompanion, 'setTimeout(() => {}, 30000)\n')
  const child = spawn(process.execPath, [fakeCompanion, 'codex', dir, task, brief, '30'], {
    cwd: dir, stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (let index = 0; index < 1005; index += 1) {
      writeFileSync(join(dir, '.tmux-teams', 'dispatch', `stale-${String(index).padStart(4, '0')}.md`), [
        `task_id: stale-${String(index).padStart(4, '0')}`,
        'worker: codex',
        'transport: acp',
        'timeout_sec: 600',
        '',
      ].join('\n'))
    }
    const { snapshot } = runJson(dir)
    const live = snapshot.runs.find((item) => item.task_id === task)
    assert.ok(live, 'the live process must retain its exact dispatch row')
    assert.equal(live.dispatch_id, dispatchId)
    assert.equal(live.state, 'running')
    assert.ok(snapshot.diagnostics.some((item) =>
      item.code === 'SOURCE_TRUNCATED' && item.source === 'dispatch'))
  } finally {
    child.kill('SIGTERM')
  }
})

test('1,417 stale unresolved dispatches remain history without becoming active nodes', () => {
  const dir = repo()
  for (let index = 0; index < 1417; index += 1) {
    const task = `legacy-${String(index).padStart(3, '0')}`
    const path = join(dir, '.tmux-teams', 'dispatch', `${task}.md`)
    writeFileSync(path, [
      `task_id: ${task}`,
      'worker: codex',
      'transport: acp',
      'timeout_sec: 600',
      '',
    ].join('\n'))
    age(path, 86_400)
  }
  const { snapshot } = runJson(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.summary.by_state.died, 0)
  assert.equal(snapshot.history.total, 1417)
  assert.equal(snapshot.history.runs.length, 100)
  assert.equal(snapshot.history.truncated, 1317)
})

test('a recent dead dispatch is history by lifecycle, not by age threshold', () => {
  const dir = repo()
  const task = 'recent-dead-lifecycle'
  const dispatchId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const path = join(dir, '.tmux-teams', 'dispatch', `${task}.md`)
  writeFileSync(path, [
    `dispatch_id: ${dispatchId}`, `task_id: ${task}`, 'worker: codex', 'transport: acp', '',
  ].join('\n'))
  age(path, 600)
  const { snapshot } = runJson(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.total, 1)
  assert.equal(snapshot.history.runs[0].dispatch_id, dispatchId)
})
