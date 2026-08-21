// acp-terminal-capability.test.mjs — the v0.33.0 fix for the default `claude`
// ACP lane being unable to reuse a Claude Max login. The gap named on the
// issue: the companion advertised filesystem capabilities only and never the
// ACP `terminal` capability, so the adapter never got to offer its
// Subscription/Console login route.
//
// The fix has to satisfy an opposite constraint at the same time: a dispatched
// REVIEW lane must never gain a terminal (the review gate's whole contract is
// zero built-in tools, no MCP servers, every permission denied). So the
// capability is gated by an explicit `ACP_ENABLE_TERMINAL=1` opt-in that no
// ordinary dispatch path sets, and this file proves BOTH halves: absent by
// default, present only on request, refused if requested anyway, and — when
// enabled — actually SERVED by a real child process, not a stub.
//
// What this file does NOT and CANNOT prove: the real end-to-end login, which
// needs a person watching a real terminal complete an OAuth flow with the
// real `claude` ACP adapter. See CLAUDE.md ข้อ "checking a published page" for
// the same discipline applied here in words instead of pixels — a test proves
// the mechanism the login route depends on, not the login itself.
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

// Same list mcp-servers-closed.test.mjs strips, plus ACP_ENABLE_TERMINAL
// itself — this suite is the one place an ambient copy of that variable would
// silently invalidate what "ordinary path" means.
const HERMETIC_ENV_KEYS = [
  'ACP_CMD', 'ACP_MODEL', 'ACP_REASONING_EFFORT', 'ACP_EXPECT_MODEL',
  'ACP_EXPECT_REASONING_EFFORT', 'ACP_RESUME', 'ACP_AGENT_ID', 'ACP_STALL_POLICY',
  'ACP_HARD_TIMEOUT_SEC', 'ACP_EXECUTION_PROFILE', 'ACP_SESSION_RECEIPT_REQUIRED',
  'ACP_SESSION_OPERATION', 'ACP_PRIOR_DISPATCH_ID', 'ACP_PRIOR_RECEIPT_DIGEST',
  'ACP_CONTROL_LOG', 'INITIAL_AGENT_MODE', 'TMUX_TEAMS_PHASE', 'ACP_ENABLE_TERMINAL',
]

function runCompanion(taskId, extraEnv) {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-terminal-cap-'))
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

  // A companion that fails to reap a live terminal child holds an active
  // child_process handle and never drains its own event loop — measured
  // directly while writing this file: reverting the teardown-sweep fix made
  // this exact spawnSync hang past 120s instead of failing. `timeout` turns
  // that failure mode into a fast, readable one instead of a wedged `node
  // --test` run that a caller has to notice and kill by hand.
  const result = spawnSync(process.execPath, [COMPANION, 'mock', cwd, taskId, brief, '30'], {
    cwd, encoding: 'utf8', env, timeout: 20_000, killSignal: 'SIGKILL',
  })
  assert.equal(result.signal, null,
    `companion did not exit on its own within 20s (signal ${result.signal}) — `
    + `it likely leaked a live child and never drained its event loop; stderr:\n${result.stderr}`)

  const requests = existsSync(requestLog)
    ? readFileSync(requestLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const roundtripPath = join(cwd, '.terminal-roundtrip.json')
  const roundtrip = existsSync(roundtripPath) ? JSON.parse(readFileSync(roundtripPath, 'utf8')) : null
  return { ...result, cwd, requests, roundtrip, stderr: result.stderr || '', stdout: result.stdout || '' }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForPidGone(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return true
}

function initializeCall(run) {
  const calls = run.requests.filter((entry) => entry.method === 'initialize')
  assert.ok(calls.length > 0,
    `no initialize was ever sent, so this test proved nothing. `
    + `methods seen: ${run.requests.map((r) => r.method).join(', ') || '(none)'}; stderr:\n${run.stderr}`)
  return calls[0]
}

test('terminal capability is ABSENT from initialize on the ordinary dispatch path', () => {
  const run = runCompanion('task-term-absent', {})
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const init = initializeCall(run)
  const caps = init.params?.clientCapabilities ?? {}
  // Not `=== false` — the contract is that the key is OMITTED on this path,
  // not sent declining. `Object.hasOwn` is what tells "absent" from "false"
  // apart; a `=== false`-only check would pass even if the companion started
  // sending `terminal: false` and quietly weakened the guarantee.
  assert.equal(Object.hasOwn(caps, 'terminal'), false,
    `clientCapabilities must omit "terminal" entirely on the ordinary path: ${JSON.stringify(caps)}`)
  assert.deepEqual(caps.fs, { readTextFile: false, writeTextFile: false })
})

test('terminal capability is PRESENT only under ACP_ENABLE_TERMINAL=1', () => {
  const run = runCompanion('task-term-present', { ACP_ENABLE_TERMINAL: '1' })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const init = initializeCall(run)
  const caps = init.params?.clientCapabilities ?? {}
  assert.equal(caps.terminal, true, `expected terminal: true under login mode: ${JSON.stringify(caps)}`)
})

test('ACP_ENABLE_TERMINAL is refused when it is neither absent, "0", nor "1"', () => {
  const run = runCompanion('task-term-invalid', { ACP_ENABLE_TERMINAL: 'true' })
  assert.equal(run.status, 2,
    `expected exit 2 for a malformed ACP_ENABLE_TERMINAL, got ${run.status}; stderr:\n${run.stderr}`)
  assert.match(run.stderr, /invalid ACP_ENABLE_TERMINAL — use 0 or 1/)
  // Refused before the adapter is reached. A request here would mean the
  // malformed value had been read as "disabled" rather than refused, which is
  // the failure this guard exists to prevent.
  assert.equal(run.requests.length, 0,
    'the companion spoke to the adapter before refusing the malformed ACP_ENABLE_TERMINAL')
})

test('a terminal request arriving on an ordinary lane is REFUSED', () => {
  const run = runCompanion('task-term-refused', { MOCK_SCENARIO: 'terminal-roundtrip' })
  assert.equal(run.status, 0,
    `a refused terminal request must not crash the whole dispatch; stderr:\n${run.stderr}`)
  assert.ok(run.roundtrip, `mock never wrote .terminal-roundtrip.json; stderr:\n${run.stderr}`)
  assert.equal(run.roundtrip.create.result, null,
    `terminal/create must not succeed when the capability was never enabled: ${JSON.stringify(run.roundtrip.create)}`)
  assert.ok(run.roundtrip.create.error, 'terminal/create must come back as a JSON-RPC error, not a silent empty ack')
  assert.match(String(run.roundtrip.create.error.message), /not enabled/i)
  // The mock only proceeds past terminal/create when it got a terminalId back
  // — so a refusal must mean nothing downstream ran either.
  assert.equal(run.roundtrip.wait_for_exit, undefined)
})

test('terminal output over the byte cap is truncated, and cut at a character boundary', () => {
  // 100 Thai characters at 3 bytes each against a 64-byte cap: the tail starts
  // 236 bytes in, two bytes INSIDE a character. Under-limit output proves
  // neither half of this — the cap never fires and the boundary walk is never
  // reached, which is why the served test above cannot stand in for it.
  const run = runCompanion('task-term-overflow', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-overflow',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-overflow.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-overflow.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.error, null, `terminal/create was refused: ${JSON.stringify(steps.create.error)}`)
  const out = steps.output?.result
  assert.ok(out, `terminal/output returned nothing: ${JSON.stringify(steps.output)}`)
  assert.equal(out.truncated, true, 'output past the cap came back with truncated unset')
  assert.ok(Buffer.byteLength(out.output, 'utf8') <= 64,
    `the kept tail is ${Buffer.byteLength(out.output, 'utf8')} bytes against a 64-byte cap`)
  // A slice with no boundary walk starts mid-character, and that shows up as
  // U+FFFD at the leading edge and nowhere else.
  assert.ok(!out.output.includes('\uFFFD'),
    `the tail split a multi-byte character: ${JSON.stringify(out.output.slice(0, 8))}`)
  assert.match(out.output, /^\u0e01+$/, `unexpected tail: ${JSON.stringify(out.output)}`)
})

test('a terminal request in login mode is SERVED end to end by a real process', () => {
  const run = runCompanion('task-term-served', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-roundtrip',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  assert.ok(run.roundtrip, `mock never wrote .terminal-roundtrip.json; stderr:\n${run.stderr}`)
  const { create, wait_for_exit: waitForExit, output, release, output_after_release: outputAfterRelease } = run.roundtrip

  assert.equal(create.error, null, `terminal/create was refused in login mode: ${JSON.stringify(create.error)}`)
  assert.equal(typeof create.result?.terminalId, 'string')
  assert.ok(create.result.terminalId.length > 0)

  // The mock's terminal command is `node -e '...; process.exitCode = 3'` — a
  // real subprocess the companion actually spawned and waited on, not a
  // canned response. exitCode 3 could only come from having run it.
  assert.equal(waitForExit?.error, null, `terminal/wait_for_exit failed: ${JSON.stringify(waitForExit?.error)}`)
  assert.equal(waitForExit?.result?.exitCode, 3)
  assert.equal(waitForExit?.result?.signal, null)

  assert.equal(output?.error, null, `terminal/output failed: ${JSON.stringify(output?.error)}`)
  assert.match(String(output?.result?.output), /terminal-probe-output/)
  assert.equal(output?.result?.truncated, false)
  assert.equal(output?.result?.exitStatus?.exitCode, 3)

  assert.equal(release?.error, null, `terminal/release failed: ${JSON.stringify(release?.error)}`)

  // Proves release actually invalidated the id rather than being a no-op
  // success shape: the SAME terminalId must now be refused.
  assert.ok(outputAfterRelease?.error,
    `terminal/output after release should be refused, got: ${JSON.stringify(outputAfterRelease)}`)
  assert.equal(outputAfterRelease.result, null)
})

test('a live terminal child is killed at companion teardown, not left running', async () => {
  // The mock creates a terminal running `setInterval(() => {}, 1000)` — it
  // would never exit on its own — and never releases or waits on it. The turn
  // otherwise completes normally (outbox written, end_turn returned), so this
  // proves the companion's OWN cleanup reaps it, not the child's own logic.
  const run = runCompanion('task-term-orphan', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-orphan',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const pidFile = join(run.cwd, 'terminal-orphan-pid')
  assert.ok(existsSync(pidFile),
    `the spawned terminal never wrote its own pid — it may never have started; stderr:\n${run.stderr}`)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `unexpected pid file contents: ${pid}`)
  const gone = await waitForPidGone(pid)
  assert.ok(gone, `terminal child pid ${pid} is still alive after the companion exited — an orphan`)
})
