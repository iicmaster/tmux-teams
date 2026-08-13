// mcp-servers-closed.test.mjs — contract ข้อ 13: no dispatch may pass a non-empty
// `mcpServers`, and both ACP calls that start or resume a session send the
// literal `mcpServers: []`.
//
// Until this file existed that closure was a CODE-REVIEW fact. ข้อ 14.1 said so in
// its own words — "no test asserts `session/new` and `session/load` still send
// `mcpServers: []`; the closure is a code-review fact about `acp-companion.mjs`,
// not a running guard" — and a rule the code merely happens to follow is one
// refactor away from being untrue with nothing going red.
//
// So this test refuses to read the source. It runs the real companion against
// the mock ACP agent, records what the agent RECEIVED, and asserts on those
// bytes. A grep over `acp-companion.mjs` would pass just as well against a
// literal sitting in dead code.
//
// The trap it is written against is this repo's most expensive one: a test that
// never touches what it names. `readTerminalOutbox` was "covered" by a test that
// `clearStaleOutbox` refused before it ever ran, and the two paths printed the
// same sentence, so it stayed green while testing something else. Every
// assertion below therefore proves the CALL HAPPENED first and only then what it
// carried — see `assertSentMcpServersEmpty`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')

// Ambient ACP_* on the machine running this suite is not a theory: `ACP_MODEL`
// leaking in through `{...process.env}` turned a green suite into 12 failures on
// the machine that runs the review lanes, and it is the shape of both CI burns
// this repo has had.
const HERMETIC_ENV_KEYS = [
  'ACP_CMD', 'ACP_MODEL', 'ACP_REASONING_EFFORT', 'ACP_EXPECT_MODEL',
  'ACP_EXPECT_REASONING_EFFORT', 'ACP_RESUME', 'ACP_AGENT_ID', 'ACP_STALL_POLICY',
  'ACP_HARD_TIMEOUT_SEC', 'ACP_EXECUTION_PROFILE', 'ACP_SESSION_RECEIPT_REQUIRED',
  'ACP_SESSION_OPERATION', 'ACP_PRIOR_DISPATCH_ID', 'ACP_PRIOR_RECEIPT_DIGEST',
  'ACP_CONTROL_LOG', 'INITIAL_AGENT_MODE', 'TMUX_TEAMS_PHASE',
]

function runCompanion(taskId, extraEnv) {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-servers-closed-'))
  const requestLog = join(cwd, 'requests.jsonl')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')

  const env = { ...process.env }
  for (const key of HERMETIC_ENV_KEYS) delete env[key]
  Object.assign(env, {
    ACP_CMD: `${process.execPath} ${MOCK}`,
    MOCK_REQUEST_LOG: requestLog,
    ACP_STALL_POLICY: 'cancel',
    ACP_HARD_TIMEOUT_SEC: '0',
    ...extraEnv,
  })

  const result = spawnSync(process.execPath, [COMPANION, 'mock', cwd, taskId, brief, '30'], {
    cwd, encoding: 'utf8', env,
  })

  const requests = existsSync(requestLog)
    ? readFileSync(requestLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  return { ...result, cwd, requests, stderr: result.stderr || '', stdout: result.stdout || '' }
}

/**
 * Prove the call was made, THEN prove what it carried. The order matters: an
 * assertion on "every session/new we saw" is vacuously true when we saw none,
 * and a refactor that renamed the method would leave this file green forever.
 */
function assertSentMcpServersEmpty(run, method) {
  const calls = run.requests.filter((entry) => entry.method === method)
  assert.ok(calls.length > 0,
    `no ${method} was ever sent, so this test proved nothing. `
    + `methods seen: ${run.requests.map((r) => r.method).join(', ') || '(none)'}; stderr:\n${run.stderr}`)

  for (const call of calls) {
    assert.ok(Object.hasOwn(call.params ?? {}, 'mcpServers'),
      `${method} omitted mcpServers entirely: ${JSON.stringify(call.params)}`)
    // deepEqual against a literal `[]` and not a truthiness check: `{}` is the
    // other spelling an ACP agent accepts, and an object is where a server
    // registration would actually be smuggled in.
    assert.deepEqual(call.params.mcpServers, [],
      `${method} must send the literal empty ARRAY (contract ข้อ 13): ${JSON.stringify(call.params.mcpServers)}`)
  }
  return calls
}

test('session/new sends the literal mcpServers: []', () => {
  const run = runCompanion('task-mcp-new', {})
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const calls = assertSentMcpServersEmpty(run, 'session/new')
  assert.equal(calls.length, 1, 'a fresh dispatch opens exactly one session')
})

test('session/load sends the literal mcpServers: [] on the resume path', () => {
  // ACP_RESUME with the agent advertising loadSession is what routes the
  // companion through session/load instead of session/new. If that ever stops
  // being true the guard above fires first, by name.
  const run = runCompanion('task-mcp-load', { ACP_RESUME: 'sess_prev' })
  assert.equal(run.status, 0, `expected a clean resume; stderr:\n${run.stderr}`)
  assertSentMcpServersEmpty(run, 'session/load')
  assert.equal(run.requests.filter((entry) => entry.method === 'session/new').length, 0,
    'a resume that also opened a fresh session is not the path this test names')
})

test('every session-opening call in one dispatch is covered, not just the first', () => {
  // ข้อ 13 says "every ACP call that starts or resumes an agent's session". If a
  // future companion opens a second session mid-dispatch, the per-call loop in
  // assertSentMcpServersEmpty catches it — this test states that intent so the
  // loop is not simplified away as redundant.
  const run = runCompanion('task-mcp-all', {})
  const opening = run.requests.filter((entry) => entry.method === 'session/new' || entry.method === 'session/load')
  assert.ok(opening.length > 0, `no session-opening call observed; stderr:\n${run.stderr}`)
  for (const call of opening) {
    assert.deepEqual(call.params?.mcpServers, [], `${call.method}: ${JSON.stringify(call.params)}`)
  }
})

test('the recorder sees params at all — the fixture change is load-bearing', () => {
  // Anti-vacuity for the RECORDER rather than for the companion. If
  // MOCK_REQUEST_LOG silently wrote nothing, every assertion above would fail
  // loudly on its "proved nothing" guard; this states the positive so a reader
  // can see the mechanism is real rather than inferring it from an absence.
  const run = runCompanion('task-mcp-recorder', {})
  assert.ok(run.requests.length >= 3,
    `expected initialize + session/new + session/prompt at least: ${JSON.stringify(run.requests.map((r) => r.method))}`)
  assert.ok(run.requests.some((entry) => entry.method === 'initialize'))
  const newCall = run.requests.find((entry) => entry.method === 'session/new')
  assert.equal(typeof newCall.params.cwd, 'string',
    'session/new params were recorded but empty — the recorder is not reading what it claims to')
})
