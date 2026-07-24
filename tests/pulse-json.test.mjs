import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmdirSync, unlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')
const SCHEMA_DIR = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'references')
const SCHEMA_PATH = join(SCHEMA_DIR, 'pulse-v4.schema.json')
const V3_SCHEMA_PATH = join(SCHEMA_DIR, 'pulse-v3.schema.json')
const V4_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const V3_SCHEMA = JSON.parse(readFileSync(V3_SCHEMA_PATH, 'utf8'))
const SCHEMA = { ...V4_SCHEMA, $defs: { ...V3_SCHEMA.$defs, ...V4_SCHEMA.$defs } }
const PULSE_SOURCE = readFileSync(PULSE, 'utf8')
const HAS_PYTHON_JSONSCHEMA = spawnSync('python3', ['-c', 'import jsonschema'], { encoding: 'utf8' }).status === 0

const ID_RE = new RegExp(SCHEMA.$defs.id.pattern)
const UUID_RE = new RegExp(SCHEMA.$defs.uuid.pattern)
const SNAPSHOT_RE = new RegExp(SCHEMA.properties.snapshot_id.pattern)

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-json-'))
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

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

function runJson(dir, env = process.env) {
  const result = spawnSync(process.execPath, [PULSE, 'json', dir], {
    encoding: 'utf8', timeout: 10_000, env,
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
    ['d3_js', 'd3_license', 'dashboard', 'data', 'font_css', 'loop_graph'])
  for (const entry of Object.values(manifest.files)) {
    assert.match(entry.path, /^[a-z0-9][a-z0-9._-]*$/i)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    const content = readFileSync(join(store, entry.path))
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256)
  }
  const snapshot = JSON.parse(readFileSync(join(store, manifest.files.data.path), 'utf8'))
  assert.equal(snapshot.snapshot_id, manifest.snapshot_id)
  for (const key of ['dashboard', 'loop_graph']) {
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
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    `${label} must use RFC 3339 date-time syntax`)
  assert.ok(Number.isFinite(Date.parse(value)), `${label} is not a valid timestamp`)
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

test('Pulse Data v4 schema is closed, advisory-only, phase-explicit, and runtime-optional', () => {
  assert.equal(SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(SCHEMA.properties.schema.const, 'tmux-teams.pulse')
  assert.equal(SCHEMA.properties.schema_version.const, 4)
  assert.equal(SCHEMA.properties.trust_level.const, 'advisory_same_uid')

  for (const [name, definition] of [['pulse', SCHEMA], ...Object.entries(SCHEMA.$defs)]) {
    if (definition.type !== 'object') continue
    assert.equal(definition.additionalProperties, false, `${name} must reject unknown fields`)
    const optional = name === 'pulse' ? ['delivery_loop', 'delivery_runtime'] : []
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
  const run = snapshot.runs.find(item => item.task_id === 'missing-pane')

  assert.equal(snapshot.source_health.liveness, 'ok', 'the fixture requires a working host liveness probe')
  assert.equal(snapshot.source_health.tmux, 'ok')
  assert.ok(!snapshot.diagnostics.some(item => item.code === 'TMUX_UNAVAILABLE'))
  assert.equal(run?.state, 'died')
  assert.equal(run?.signals.pane, 'gone')
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
  const loopGraph = readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
  assert.match(html, new RegExp(`content="${persisted.snapshot_id}"`))
  assert.match(loopGraph, new RegExp(`content="${persisted.snapshot_id}"`))
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
  assert.ok(mismatched.runs.some(run => run.task_id === 'reused-id'),
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
  assert.ok(legacyVerdict.runs.some(run => run.task_id === 'reused-id'),
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
  assert.ok(!matched.runs.some(run => run.task_id === 'reused-id'),
    'the matching dispatch verdict settles the current run')
})

test('published document passes a real Draft 2020-12 validator', {
  skip: HAS_PYTHON_JSONSCHEMA ? false : 'python3 jsonschema is not installed',
}, () => {
  const dir = repo()
  runJson(dir)
  const program = [
    'import json, jsonschema, sys',
    'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
    'instance = json.load(open(sys.argv[2], encoding="utf-8"))',
    'base = json.load(open(sys.argv[3], encoding="utf-8"))',
    'jsonschema.Draft202012Validator.check_schema(schema)',
    'resolver = jsonschema.RefResolver.from_schema(schema, store={"pulse-v3.schema.json": base})',
    'jsonschema.Draft202012Validator(schema, resolver=resolver, format_checker=jsonschema.FormatChecker()).validate(instance)',
  ].join('; ')
  const validation = spawnSync('python3', [
    '-c', program, SCHEMA_PATH, join(dir, '.tmux-teams', 'pulse.json'), V3_SCHEMA_PATH,
  ], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(validation.status, 0, validation.stderr || validation.stdout)
})

test('HTML renderer has the projected snapshot as its only dynamic input', () => {
  assert.match(PULSE_SOURCE, /function render\(snapshot\)\s*\{/)
  assert.match(PULSE_SOURCE,
    /const publishedSnapshot = JSON\.parse\(jsonText\)[\s\S]*?const html = render\(publishedSnapshot\)/,
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

  const run = snapshot.runs.find(item => item.task_id === 'pulse-valid-run')
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
  assert.equal(snapshot.summary.active, 1, 'invalid outbox entries must not create projected runs')
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
