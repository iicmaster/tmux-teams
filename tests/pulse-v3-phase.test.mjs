import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams')
const PULSE = join(SKILL, 'scripts', 'pulse.mjs')
const V4_SCHEMA = join(SKILL, 'references', 'pulse-v4.schema.json')
const HAS_JSONSCHEMA = spawnSync('python3', ['-c', 'import jsonschema'], {
  encoding: 'utf8',
}).status === 0

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-v3-phase-'))
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

function writeDispatch(dir, {
  task,
  dispatch,
  phaseLine = null,
}) {
  writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${task}.md`), [
    `dispatch_id: ${dispatch}`,
    `task_id: ${task}`,
    'worker: kimi',
    'transport: acp',
    ...(phaseLine === null ? [] : [`phase: ${phaseLine}`]),
    'started_at: 2026-07-24T09:00:00.000Z',
    'timeout_sec: 600',
    '',
  ].join('\n'))
}

function writeVerdict(dir, {
  name,
  task,
  dispatch,
  phaseLine = null,
}) {
  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', `${name}.md`), [
    `dispatch_id: ${dispatch}`,
    `task_id: ${task}`,
    'worker: kimi',
    'transport: acp',
    ...(phaseLine === null ? [] : [`phase: ${phaseLine}`]),
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    'started_at: 2026-07-24T09:00:00.000Z',
    'wait_sec: 12',
    'timeout_sec: 600',
    '',
  ].join('\n'))
}

function runPulse(dir) {
  const result = spawnSync(process.execPath, [PULSE, 'json', dir], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, TZ: 'UTC', PULSE_TIME_ZONE: 'Asia/Bangkok' },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('Pulse v4 carries explicit dispatch phase and joins it to a verdict by UUID', () => {
  const dir = repo()
  writeDispatch(dir, {
    task: 'active-development',
    dispatch: '11111111-1111-4111-8111-111111111111',
    phaseLine: 'Development',
  })
  writeDispatch(dir, {
    task: 'recorded-requirement',
    dispatch: '22222222-2222-4222-8222-222222222222',
    phaseLine: 'Requirement',
  })
  writeVerdict(dir, {
    name: 'recorded-requirement',
    task: 'recorded-requirement',
    dispatch: '22222222-2222-4222-8222-222222222222',
  })

  const snapshot = runPulse(dir)
  assert.equal(snapshot.schema_version, 4)
  const active = snapshot.runs.find(run => run.task_id === 'active-development')
  assert.equal(active.phase, 'Development')
  assert.equal(active.phase_source, 'dispatch')
  const recorded = snapshot.recent_verdicts
    .find(record => record.task_id === 'recorded-requirement')
  assert.equal(recorded.phase, 'Requirement')
  assert.equal(recorded.phase_source, 'dispatch_join')
  assert.ok(!snapshot.diagnostics.some(diagnostic =>
    diagnostic.code.startsWith('PHASE_BINDING_')))

  if (HAS_JSONSCHEMA) {
    const result = spawnSync('python3', [
      '-c',
      'import json,jsonschema,pathlib,sys; p=pathlib.Path(sys.argv[1]).resolve(); s=json.load(open(p)); s["$id"]=p.as_uri(); x=json.load(open(sys.argv[2])); jsonschema.Draft202012Validator(s, format_checker=jsonschema.FormatChecker()).validate(x)',
      V4_SCHEMA,
      join(dir, '.tmux-teams', 'pulse.json'),
    ], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
})

test('invalid phase text is explicit degraded evidence, never ordinary unassigned data', () => {
  const dir = repo()
  writeDispatch(dir, {
    task: 'misspelled-phase',
    dispatch: '33333333-3333-4333-8333-333333333333',
    phaseLine: 'Developmnt',
  })

  const snapshot = runPulse(dir)
  const run = snapshot.runs.find(item => item.task_id === 'misspelled-phase')
  assert.equal(run.phase, null)
  assert.equal(run.phase_source, 'unassigned')
  assert.equal(snapshot.complete, false)
  assert.ok(snapshot.diagnostics.some(diagnostic =>
    diagnostic.code === 'PHASE_BINDING_INVALID'))
})

test('dispatch and event phase disagreement becomes a conflict instead of event-first placement', () => {
  const dir = repo()
  writeDispatch(dir, {
    task: 'conflicting-phase',
    dispatch: '44444444-4444-4444-8444-444444444444',
    phaseLine: 'Development',
  })
  writeVerdict(dir, {
    name: 'conflicting-phase',
    task: 'conflicting-phase',
    dispatch: '44444444-4444-4444-8444-444444444444',
    phaseLine: 'QA',
  })

  const snapshot = runPulse(dir)
  const record = snapshot.recent_verdicts
    .find(item => item.task_id === 'conflicting-phase')
  assert.equal(record.phase, null)
  assert.equal(record.phase_source, 'conflict')
  assert.equal(snapshot.complete, false)
  assert.ok(snapshot.diagnostics.some(diagnostic =>
    diagnostic.code === 'PHASE_BINDING_CONFLICT'))

  const graph = readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
  assert.match(graph, /data-phase-id="unassigned"[^>]*data-task-id="conflicting-phase"/)
  assert.match(graph, /phase binding ขัดแย้ง · ไม่เลือกเฟสแบบ first-source-wins/)
  assert.doesNotMatch(graph, /data-phase-id="development"[^>]*data-task-id="conflicting-phase"/)
  assert.doesNotMatch(graph, /data-phase-id="qa"[^>]*data-task-id="conflicting-phase"/)
})

test('duplicate dispatch UUID with two phases marks every active projection conflicting', () => {
  const dir = repo()
  const dispatch = '55555555-5555-4555-8555-555555555555'
  writeDispatch(dir, {
    task: 'duplicate-development',
    dispatch,
    phaseLine: 'Development',
  })
  writeDispatch(dir, {
    task: 'duplicate-qa',
    dispatch,
    phaseLine: 'QA',
  })

  const snapshot = runPulse(dir)
  assert.equal(snapshot.runs.length, 2)
  assert.ok(snapshot.runs.every(run =>
    run.phase === null && run.phase_source === 'conflict'))
  assert.ok(snapshot.diagnostics.some(diagnostic =>
    diagnostic.code === 'PHASE_BINDING_CONFLICT' && diagnostic.count === 1))
})
