// Drives the real acp-companion.mjs against a mock ACP agent (fixtures/) so the
// live-view rendering and the resume selection are exercised end to end — the
// same shape of proof the rest of this repo prefers over unit fragments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function run(taskId, extraEnv = {}, cwd = mkdtempSync(join(tmpdir(), 'acp-companion-')), timeoutSec = 30) {
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync('node', [COMPANION, 'mock', cwd, taskId, brief, String(timeoutSec)], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ACP_CMD: `node ${MOCK}`, ...extraEnv },
  })
  return { ...r, cwd, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function eventTexts(cwd) {
  const dir = join(cwd, '.tmux-teams', 'kms', 'events')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => readFileSync(join(dir, f), 'utf8'))
}

function field(text, name) {
  return (text.match(new RegExp(`^${name}: (.+)$`, 'm')) || [, ''])[1]
}

for (const retiredName of ['gemini', 'Gemini', 'GEMINI', ' gemini ']) {
  test(`the retired agent name ${JSON.stringify(retiredName)} is rejected before custom override or dispatch`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-retired-'))
    const brief = join(cwd, 'brief.md')
    writeFileSync(brief, 'this must never be dispatched\n')
    const env = { ...process.env, ACP_CMD: `node ${MOCK}` }
    const result = spawnSync('node', [
      COMPANION,
      retiredName,
      cwd,
      'task-retired-agent',
      brief,
      '30',
    ], { cwd, encoding: 'utf8', env })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /unsupported agent/)
    assert.match(result.stderr, /claude\|codex\|agy/)
    assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
    assert.equal(eventTexts(cwd).length, 0)
  })
}

test('renders every session/update kind and completes via the outbox', () => {
  const r = run('task-render')
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  // thoughts and message text are streamed under their own mode headers
  assert.match(r.stdout, /\[think\] weighing the options/)
  assert.match(r.stdout, /\[say\] doing the work/)
  // a tool call shows its kind + status, and its later status transition
  assert.match(r.stdout, /\[tool\] execute · run tests \(pending\)/)
  assert.match(r.stdout, /\[tool\] run tests → completed/)
  assert.match(r.stdout, /\[say\] doing the work\n\[tool\]/, 'tool output starts on a new line')
  // the agent's plan renders with per-entry marks
  assert.match(r.stdout, /\[plan\] ✓ step one/)
  assert.match(r.stdout, /▶ step two/)
  assert.match(r.stdout, /\[terminal\] done/)
})

for (const [scenario, decision, display] of [
  ['prefer-always', 'allow-always', 'Allow always'],
  ['prefer-once', 'allow-once', 'Allow once'],
  ['fallback-first', 'reject-once', 'Reject once'],
]) {
  test(`session/request_permission ${scenario} selects ${decision} and lets the waiting agent continue`, () => {
    const taskId = `task-permission-${scenario}`
    const r = run(taskId, { MOCK_REQUEST_PERMISSION: scenario })
    assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.match(r.stdout, new RegExp(`\\[permission\\] write outbox -> ${display}`))
    assert.match(readFileSync(join(r.cwd, '.mailbox-out', taskId), 'utf8'),
      new RegExp(`^DID: mock work; permission=${decision}$`, 'm'))
  })
}

test('session/request_permission with empty options returns cancelled and continues safely', () => {
  const taskId = 'task-permission-empty'
  const r = run(taskId, { MOCK_REQUEST_PERMISSION: 'empty' })
  assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /\[permission\] write outbox -> cancelled \(no options\)/)
  assert.match(readFileSync(join(r.cwd, '.mailbox-out', taskId), 'utf8'),
    /^DID: mock work; permission=cancelled$/m)
})

test('ACP_RESUME with loadSession support calls session/load, not session/new', () => {
  const r = run('task-resume', { ACP_RESUME: 'sess_prev' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.match(r.stdout, /\[resume\] loading sess_prev/)
  assert.match(r.stdout, /\[resume\] history restored/)
  assert.match(r.stdout, /\[user\] \(previous request\)\n\[say\] \(replayed history\)/)
  assert.match(r.stdout, /\[session\] sess_prev/)
})

test('ACP_RESUME falls back to a fresh session when loadSession is absent', () => {
  const r = run('task-noload', { ACP_RESUME: 'sess_prev', MOCK_NO_LOAD: '1' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.match(r.stderr, /does not advertise loadSession/) // warning goes to stderr
  assert.match(r.stdout, /\[session\] sess_mock/)          // fell back to a new session
})

test('a persisted session id resumes a later same-id dispatch', () => {
  const first = run('task-persist')
  assert.equal(first.status, 0, `exit 0 expected; stderr:\n${first.stderr}`)
  const stored = join(first.cwd, '.tmux-teams', 'sessions', 'task-persist')
  assert.ok(existsSync(stored), 'session id file should be written')
  assert.equal(readFileSync(stored, 'utf8').trim(), 'sess_mock')
  const second = run('task-persist', {}, first.cwd)
  assert.equal(second.status, 0, `exit 0 expected; stderr:\n${second.stderr}`)
  assert.match(second.stdout, /\[resume\] loading sess_mock/)
})

test('an unreadable persisted-session entry warns and starts fresh', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))
  mkdirSync(join(cwd, '.tmux-teams', 'sessions', 'task-bad-session'), { recursive: true })
  const r = run('task-bad-session', {}, cwd)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.match(r.stderr, /could not read persisted session id/)
  assert.match(r.stdout, /\[session\] sess_mock/)
})

test('records one mechanical KMS event without inventing a PM judgement', () => {
  const r = run('task-kms')
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  const footprint = readFileSync(join(r.cwd, '.tmux-teams', 'dispatch', 'task-kms.md'), 'utf8')
  const dispatchId = field(footprint, 'dispatch_id')
  assert.match(dispatchId, UUID_RE)
  assert.equal(field(events[0], 'dispatch_id'), dispatchId, 'footprint and terminal event identify the same dispatch')
  assert.match(events[0], /^event_kind: transport-terminal$/m)
  assert.match(events[0], /^task_id: task-kms$/m)
  assert.match(events[0], /^worker: mock$/m)
  assert.match(events[0], /^transport: acp$/m)
  assert.match(events[0], /^terminal: done$/m)
  assert.match(events[0], /^exit_code: 0$/m)
  assert.match(events[0], /^evidence_present: false$/m)
  assert.match(events[0], /^timed_out: false$/m)
  assert.match(events[0], /^started_at: \d{4}-\d{2}-\d{2}T/m)
  assert.doesNotMatch(events[0], /^pm_verdict:/m)
  assert.doesNotMatch(events[0], /^lesson:/m)
})

test('an explicit delivery phase is copied to the dispatch footprint and terminal event', () => {
  const r = run('task-phase', { TMUX_TEAMS_PHASE: 'Development' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const footprint = readFileSync(
    join(r.cwd, '.tmux-teams', 'dispatch', 'task-phase.md'),
    'utf8',
  )
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.equal(field(footprint, 'phase'), 'Development')
  assert.equal(field(events[0], 'phase'), 'Development')
  assert.equal(field(events[0], 'dispatch_id'), field(footprint, 'dispatch_id'))
})

test('an invalid delivery phase fails before dispatch, ACP, or KMS side effects', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-invalid-phase-'))
  const r = run('task-invalid-phase', { TMUX_TEAMS_PHASE: 'Developmnt' }, cwd)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /invalid TMUX_TEAMS_PHASE/)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
  assert.deepEqual(eventTexts(cwd), [])
})

test('a governed marker cannot be bypassed by invoking the raw companion', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-governed-bypass-'))
  mkdirSync(join(cwd, '.tmux-teams'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'phase-gate.json'), '{malformed')
  const result = run('task-governed-bypass', {}, cwd)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /PHASE_GATE_MARKER_INVALID/)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'sessions')), false)
  assert.deepEqual(eventTexts(cwd), [])
})

test('a repeated task id gets a fresh dispatch UUID without changing legacy paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))
  const first = run('task-repeat', {}, cwd)
  assert.equal(first.status, 0, `first exit 0 expected; stderr:\n${first.stderr}`)
  const footprintPath = join(cwd, '.tmux-teams', 'dispatch', 'task-repeat.md')
  const firstId = field(readFileSync(footprintPath, 'utf8'), 'dispatch_id')

  const second = run('task-repeat', {}, cwd)
  assert.equal(second.status, 0, `second exit 0 expected; stderr:\n${second.stderr}`)
  const secondId = field(readFileSync(footprintPath, 'utf8'), 'dispatch_id')

  assert.match(firstId, UUID_RE)
  assert.match(secondId, UUID_RE)
  assert.notEqual(secondId, firstId)
  assert.deepEqual(readdirSync(join(cwd, '.tmux-teams', 'dispatch')), ['task-repeat.md'])
  assert.deepEqual(eventTexts(cwd).map(text => field(text, 'dispatch_id')), [firstId, secondId])
})

test('records whether the terminal outbox contains concrete evidence', () => {
  const r = run('task-evidence', { MOCK_EVIDENCE: '1' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.match(eventTexts(r.cwd)[0], /^evidence_present: true$/m)
})

for (const [mode, status, terminal] of [
  ['blocked', 0, 'blocked'],
  ['failed', 0, 'failed'],
  ['invalid', 3, 'invalid'],
  ['missing', 3, 'no-outbox'],
]) {
  test(`records the ${terminal} terminal path`, () => {
    const r = run(`task-${mode}`, { MOCK_TERMINAL: mode })
    assert.equal(r.status, status, `exit ${status} expected; stderr:\n${r.stderr}`)
    const events = eventTexts(r.cwd)
    assert.equal(events.length, 1)
    assert.match(events[0], new RegExp(`^terminal: ${terminal}$`, 'm'))
    assert.match(events[0], new RegExp(`^exit_code: ${status}$`, 'm'))
  })
}

test('ACP_KMS_AUTO=0 opts out of the automatic event', () => {
  const r = run('task-optout', { ACP_KMS_AUTO: '0' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.deepEqual(eventTexts(r.cwd), [])
})

test('records timeout once and exits when the agent accepts SIGTERM', () => {
  const r = run('task-timeout', { MOCK_HANG: '1' }, undefined, 1)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.match(events[0], /^terminal: timeout$/m)
  assert.match(events[0], /^timed_out: true$/m)
  assert.match(events[0], /^exit_code: 1$/m)
})

test('records an agent that exits before completing the protocol', () => {
  const r = run('task-early-exit', { MOCK_EXIT_EARLY: '1' })
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.match(events[0], /^terminal: agent-exit$/m)
  assert.match(events[0], /^exit_code: 9$/m)
})

test('records an agent command that cannot be spawned', () => {
  const r = run('task-spawn-error', { ACP_CMD: 'tmux-teams-no-such-acp-agent' })
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.match(events[0], /^terminal: spawn-error$/m)
  assert.match(events[0], /^exit_code: 1$/m)
})
