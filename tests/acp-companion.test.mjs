// Drives the real acp-companion.mjs against a mock ACP agent (fixtures/) so the
// live-view rendering and the resume selection are exercised end to end — the
// same shape of proof the rest of this repo prefers over unit fragments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')

function run(taskId, extraEnv = {}, cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))) {
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync('node', [COMPANION, 'mock', cwd, taskId, brief, '30'], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ACP_CMD: `node ${MOCK}`, ...extraEnv },
  })
  return { ...r, cwd, stdout: r.stdout || '', stderr: r.stderr || '' }
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
