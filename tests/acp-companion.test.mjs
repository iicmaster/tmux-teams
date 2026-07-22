// Drives the real acp-companion.mjs against a mock ACP agent (fixtures/) so the
// live-view rendering and the resume selection are exercised end to end — the
// same shape of proof the rest of this repo prefers over unit fragments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')

function run(taskId, extraEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))
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
  assert.match(r.stdout, /\(replayed history\)/)
  assert.match(r.stdout, /\[session\] sess_prev/)
})

test('ACP_RESUME falls back to a fresh session when loadSession is absent', () => {
  const r = run('task-noload', { ACP_RESUME: 'sess_prev', MOCK_NO_LOAD: '1' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.match(r.stderr, /does not advertise loadSession/) // warning goes to stderr
  assert.match(r.stdout, /\[session\] sess_mock/)          // fell back to a new session
})

test('a resumed session id is persisted for a later same-id dispatch', () => {
  const r = run('task-persist')
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const stored = join(r.cwd, '.tmux-teams', 'sessions', 'task-persist')
  assert.ok(existsSync(stored), 'session id file should be written')
  assert.equal(readFileSync(stored, 'utf8').trim(), 'sess_mock')
})
