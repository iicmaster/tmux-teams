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
// Everything ACP_*, by prefix rather than by name. Three files in this suite
// each carried their own hand list, and all three went stale the hour v0.33.0
// introduced ACP_SPAWN_NONCE — a list that must be edited whenever a variable
// is added is a list that will be wrong again.
const HERMETIC_ENV_KEYS = [
  'INITIAL_AGENT_MODE', 'TMUX_TEAMS_PHASE',
]

function runCompanion(taskId, extraEnv) {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-terminal-cap-'))
  const requestLog = join(cwd, 'requests.jsonl')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ACP_')))
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

// Returns the text of an INTACT "[terminal:<id>] " mirrored line — one whole
// regex line starting with the label and running to the next newline (or end
// of stream). A mirror that split the label into the middle of the line
// either fails to match this at all, or matches a line whose captured text
// still contains the raw bytes/label fragment the split left behind — either
// way the caller's exact-string comparison against the clean expected line
// is what actually proves the split did not happen, not this helper alone.
function redactedMirrorLine(stderr, terminalId) {
  const escaped = terminalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stderr.match(new RegExp(`^\\[terminal:${escaped}\\] (.*)$`, 'm'))
  return match ? match[1] : null
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

test('EOF on the companion stdin closes a login terminal\'s input instead of hanging the turn', () => {
  // Found by the PR review bot. The login-mode bridge forwarded `data` and never
  // `end`, so a command that reads until EOF — which is most of them, and the
  // exact shape a person finishes with Ctrl-D — stayed blocked, and
  // `terminal/wait_for_exit` and the ACP turn hung behind it.
  //
  // `input: ''` gives the companion a stdin that is a pipe and ends at once, so
  // this also covers the case where EOF has ALREADY happened before the first
  // terminal exists and the 'end' event will never fire again.
  const cwd = mkdtempSync(join(tmpdir(), 'acp-terminal-eof-'))
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('ACP_')) delete env[key]
  Object.assign(env, {
    ACP_CMD: `${process.execPath} ${MOCK}`,
    ACP_STALL_POLICY: 'cancel',
    ACP_HARD_TIMEOUT_SEC: '0',
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-eof',
  })
  const result = spawnSync(process.execPath, [COMPANION, 'mock', cwd, 'task-term-eof', brief, '30'],
    { cwd, encoding: 'utf8', env, input: '', timeout: 30_000, killSignal: 'SIGKILL' })
  assert.equal(result.signal, null,
    `the companion had to be killed — the login terminal never saw EOF; stderr:\n${result.stderr}`)

  const recorded = join(cwd, '.terminal-eof.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-eof.json; stderr:\n${result.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.error, null, `terminal/create was refused: ${JSON.stringify(steps.create.error)}`)
  assert.ok(steps.wait_for_exit, 'terminal/wait_for_exit never returned — the child was still blocked on input')
  assert.equal(steps.wait_for_exit.error, null, JSON.stringify(steps.wait_for_exit.error))
  // 7 is what the child sets on 'end'. Any other code means it exited for some
  // other reason and this test would be proving nothing about EOF.
  assert.equal(steps.wait_for_exit.result?.exitCode, 7,
    `the child did not exit on EOF: ${JSON.stringify(steps.wait_for_exit.result)}`)
})

test('a child request whose method is not a string is refused, and does not kill the lane', () => {
  // Found by the PR review bot on the bytes this release added. The router
  // checked `message.method` for TRUTHINESS and then called
  // `.startsWith('terminal/')` on it, so `{"id":1,"method":42}` threw
  // TypeError inside the readline callback — an uncaught exception that takes
  // the companion down before its terminal snapshot and cleanup, turning one
  // bad protocol frame into a lane that stopped with no record of why.
  const run = runCompanion('task-malformed-method', { MOCK_SCENARIO: 'malformed-request' })
  assert.equal(run.status, 0,
    `a malformed child request killed the dispatch; stderr:\n${run.stderr}`)
  assert.doesNotMatch(run.stderr, /TypeError/,
    `the router threw instead of refusing:\n${run.stderr}`)
  // The turn still completed, which is what proves the frame was survived
  // rather than merely not crashing on its way out.
  assert.match(run.stdout + run.stderr, /turn done|end_turn/,
    `the lane never finished its turn:\n${run.stdout}${run.stderr}`)
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

test('a terminal child that traps SIGTERM is still reaped, via SIGKILL escalation', async () => {
  // The mock installs a no-op SIGTERM handler before it loops — the shape a
  // real login command with its own signal handling (or `trap "" TERM`) can
  // present. killAllLiveTerminals sending a single SIGTERM and never
  // escalating would leave this child running past companion teardown, and
  // its open stdio pipes would keep the companion's own event loop alive —
  // this is also what runCompanion's own `result.signal === null` assertion
  // catches: without the escalation, the companion never exits within the
  // harness's 20s spawnSync timeout and that assertion fails first.
  const run = runCompanion('task-term-sigterm-trap', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-sigterm-trap',
    ACP_TERMINAL_KILL_GRACE_MS: '200',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const pidFile = join(run.cwd, 'terminal-sigterm-trap-pid')
  assert.ok(existsSync(pidFile),
    `the spawned terminal never wrote its own pid — it may never have started; stderr:\n${run.stderr}`)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `unexpected pid file contents: ${pid}`)
  const gone = await waitForPidGone(pid)
  assert.ok(gone,
    `terminal child pid ${pid} ignored SIGTERM and outlived the companion — SIGKILL escalation never fired`)
})

test('a RELEASED terminal that traps SIGTERM is still reaped, via SIGKILL escalation', async () => {
  // terminal/release sends its own SIGTERM and used to delete the terminal
  // from the tracking map immediately, regardless of whether the child
  // actually died — invisible to killAllLiveTerminals' teardown sweep from
  // that point on. This is finding 2 reached through release instead of an
  // orphaned terminal: the same SIGTERM-trapping child, but explicitly
  // released before the turn ends.
  const run = runCompanion('task-term-sigterm-trap-release', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-sigterm-trap-release',
    ACP_TERMINAL_KILL_GRACE_MS: '200',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const pidFile = join(run.cwd, 'terminal-sigterm-trap-release-pid')
  assert.ok(existsSync(pidFile),
    `the spawned terminal never wrote its own pid — it may never have started; stderr:\n${run.stderr}`)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `unexpected pid file contents: ${pid}`)
  const gone = await waitForPidGone(pid)
  assert.ok(gone,
    `released terminal child pid ${pid} ignored SIGTERM and outlived the companion — `
    + 'release removed it from the teardown sweep before it actually exited')
})

test('a wrapper terminal command that forks a descendant has the WHOLE subtree reaped at teardown', async () => {
  // The mock's terminal command is itself a LAUNCHER: it forks a plain
  // (non-detached) descendant that traps SIGTERM, then the wrapper exits on
  // its own almost immediately — standing in for a shell, npx, or bunx
  // wrapper. Before createTerminal spawned with `detached: true`, the
  // wrapper and its descendant shared the COMPANION's own process group, so
  // once the wrapper's 'exit' event fired, `term.exitStatus` was set and
  // killAllLiveTerminals' `if (term.exitStatus) continue` skipped this
  // terminal entirely — the descendant was never signalled by anything.
  const run = runCompanion('task-term-wrapper-descendant', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-wrapper-descendant',
    ACP_TERMINAL_KILL_GRACE_MS: '200',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const pidFile = join(run.cwd, 'terminal-wrapper-descendant-pid')
  assert.ok(existsSync(pidFile),
    `the wrapper's descendant never wrote its own pid — it may never have started; stderr:\n${run.stderr}`)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `unexpected pid file contents: ${pid}`)
  const gone = await waitForPidGone(pid)
  assert.ok(gone,
    `the wrapper's descendant pid ${pid} is still alive after the companion exited — `
    + "the wrapper settling hid its descendant from the teardown sweep")
})

test('terminal/kill escalates to SIGKILL itself when SIGTERM is ignored, before acking success', () => {
  // Found by a second reviewer of the prior round's fix: the teardown sweep
  // (killAllLiveTerminals) already escalates to SIGKILL, but the terminal/kill
  // REQUEST path sent one SIGTERM and answered `{}` immediately, so a caller
  // that trusted that ack and immediately called terminal/wait_for_exit could
  // block the whole turn on a process the kill claimed had already stopped.
  //
  // The load-bearing assertion is REQUEST LATENCY, not just eventual death: a
  // fire-and-forget kill answers in a few milliseconds regardless of the
  // grace period, while an escalation that actually lives inside the request
  // must sit through the whole ACP_TERMINAL_KILL_GRACE_MS before it can know
  // SIGTERM did nothing. A single post-response aliveness snapshot cannot
  // tell the two apart on its own: the SAME background escalation still runs
  // and kills the child moments later even in the un-awaited (broken) shape,
  // so a bounded poll window comparable to the grace period can read "dead"
  // either way. Kept as a secondary corroborating signal only.
  const run = runCompanion('task-term-kill-escalation', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-kill-escalation',
    ACP_TERMINAL_KILL_GRACE_MS: '200',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-kill-escalation.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-kill-escalation.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.kill?.error, null, `terminal/kill was refused: ${JSON.stringify(steps.kill?.error)}`)
  assert.ok(steps.killElapsedMs >= 150,
    `terminal/kill against a SIGTERM-trapping child answered in ${steps.killElapsedMs}ms — `
    + 'a request that actually waits out the 200ms grace before escalating to SIGKILL cannot '
    + 'answer this fast; the response path never escalated within the request itself')
  assert.equal(steps.aliveAfterKill, false,
    'the SIGTERM-trapping child was still alive after the request-path escalation and its '
    + 'follow-up poll window — SIGKILL never reached it at all')
})

test('a second terminal/create while the first is still live is refused', () => {
  // Finding 4, judged on the merits: the stdin bridge broadcasts to every
  // open terminal on the stated assumption that a login run drives at most
  // one at a time. Nothing enforced that assumption at the one place that
  // could create a second terminal, so this proves createTerminal now refuses
  // a concurrent one instead of silently letting two children compete for the
  // same keystrokes (including a login code meant for only one of them).
  const run = runCompanion('task-term-concurrent-create', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-concurrent-create',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-concurrent-create.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-concurrent-create.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.first.error, null, `the first terminal/create was refused: ${JSON.stringify(steps.first.error)}`)
  assert.equal(steps.second.result, null,
    `a second terminal/create must not succeed while the first is still live: ${JSON.stringify(steps.second)}`)
  assert.ok(steps.second.error, 'a concurrent terminal/create must come back as a JSON-RPC error, not a silent success')
  assert.match(String(steps.second.error.message), /at most one live terminal/)
  assert.equal(steps.release?.error, null, `releasing the first terminal failed: ${JSON.stringify(steps.release?.error)}`)
})

test('terminal/create with a non-array args value is refused, not silently dropped', () => {
  // The element-type check assumes `args` is already an array and never runs
  // against a bare non-array value — the ternary in createTerminal used to
  // fall through to `[]` for `args: "--login"` exactly like it does for
  // `undefined`, silently dropping every argument and running a materially
  // different command instead of refusing the malformed request.
  const run = runCompanion('task-term-args-not-array', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-args-not-array',
  })
  assert.equal(run.status, 0, `a refused terminal/create must not crash the whole dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-args-not-array.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-args-not-array.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.result, null,
    `terminal/create must not succeed with a non-array args value: ${JSON.stringify(steps.create)}`)
  assert.ok(steps.create.error, 'terminal/create must come back as a JSON-RPC error, not a silent success')
  assert.match(String(steps.create.error.message), /args must be an array/)
})

test('terminal/create with a non-array env is refused, the twin of the args case', () => {
  // Found by reading the fix for `args` rather than by a review round: the
  // guard beside it named one container, and `env: "FOO=1"` still fell through
  // its own ternary to `{}`. The caller believes it set the child's
  // environment; the child runs with the parent's. Same defect, one line down,
  // and the kind that arrives as next release's finding.
  const run = runCompanion('task-term-env-not-array', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-env-not-array',
  })
  assert.equal(run.status, 0, `a refused terminal/create must not crash the whole dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-env-not-array.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-env-not-array.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.result, null,
    `terminal/create must not succeed with a non-array env: ${JSON.stringify(steps.create)}`)
  assert.ok(steps.create.error, 'terminal/create must come back as a JSON-RPC error, not a silent success')
  assert.match(String(steps.create.error.message), /env must be an array/)
})

test('terminal/create with a non-string args element is refused, not silently coerced', () => {
  const run = runCompanion('task-term-bad-args', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-malformed-args',
  })
  assert.equal(run.status, 0, `a refused terminal/create must not crash the whole dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-malformed-args.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-malformed-args.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.result, null,
    `terminal/create must not succeed with a non-string args element: ${JSON.stringify(steps.create)}`)
  assert.ok(steps.create.error, 'terminal/create must come back as a JSON-RPC error, not a silent success')
  assert.match(String(steps.create.error.message), /args\[1\] must be a string/)
})

test('terminal/create with a non-string env value is refused, not coerced to "[object Object]"', () => {
  const run = runCompanion('task-term-bad-env', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-malformed-env',
  })
  assert.equal(run.status, 0, `a refused terminal/create must not crash the whole dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-malformed-env.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-malformed-env.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.result, null,
    `terminal/create must not succeed with a non-string env value: ${JSON.stringify(steps.create)}`)
  assert.ok(steps.create.error, 'terminal/create must come back as a JSON-RPC error, not a silent success')
  assert.match(String(steps.create.error.message), /env\[0\]\.value must be a string/)
})

test('terminal output split across chunks decodes correctly and mirrors at a line boundary', () => {
  // chunk1 ends with the first byte of 'é' (0xC3), chunk2 opens with the
  // second (0xA9) — a decode split. The two bytes also straddle the point a
  // human would read as "the middle of the URL" — a mirror split. One
  // scenario proves both fixes at once: a per-chunk `toString('utf8')` turns
  // the split byte pair into two U+FFFD, and a per-chunk stderr mirror would
  // print a second "[terminal:<id>] " label between "ex" and "mple.com".
  const run = runCompanion('task-term-chunk-split', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-chunk-split',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-chunk-split.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-chunk-split.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.error, null, `terminal/create was refused: ${JSON.stringify(steps.create.error)}`)
  const terminalId = steps.create.result?.terminalId
  assert.equal(typeof terminalId, 'string')
  const out = steps.output?.result
  assert.ok(out, `terminal/output returned nothing: ${JSON.stringify(steps.output)}`)
  // A decoder that lost the split bytes shows up as U+FFFD, and nowhere else.
  assert.ok(!out.output.includes('�'),
    `the split character decoded to a replacement character: ${JSON.stringify(out.output)}`)
  assert.equal(out.output, 'open https://exémple.com/device?code=ABC123\n')
  // The ACP terminal/output field carries no label at all (appendTerminalOutput
  // never adds one) — the label only exists on the human-facing stderr mirror,
  // so the line-boundary half of this test has to read THAT stream instead.
  const mirrored = redactedMirrorLine(run.stderr, terminalId)
  assert.ok(mirrored,
    `no intact mirrored line found for ${terminalId} in stderr:\n${run.stderr}`)
  assert.equal(mirrored, 'open https://exémple.com/device?code=ABC123',
    `the mirror split the label into the middle of the line: ${JSON.stringify(mirrored)}`)
})

test('wait_for_exit does not release until output still in flight at child exit has arrived', () => {
  // PR #71 inline comment 3835247725: a terminal child's `exit` can fire
  // before its stdout/stderr pipes finish delivering `data`, so finalizing
  // (ending the decoders, resolving every `wait_for_exit` waiter) on `exit`
  // let an adapter that waited and then called `terminal/output` miss the
  // command's final output. The mock's command forces this deterministically:
  // its own process exits almost at once, while an unref'd grandchild it
  // forked keeps the inherited stdout pipe open and writes a marker line only
  // after a 300ms delay of its own — so the marker cannot possibly have
  // arrived by the time the wrapper's bare `exit` event fires, and the pipe
  // cannot reach EOF (no `close`) until the grandchild's delay elapses.
  const run = runCompanion('task-term-exit-before-close', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-exit-before-close',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-exit-before-close.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-exit-before-close.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.error, null, `terminal/create was refused: ${JSON.stringify(steps.create.error)}`)

  // The wrapper's OWN exit status, not the grandchild's — proves the fix kept
  // the two apart rather than merging finalization with status reporting.
  assert.equal(steps.wait_for_exit?.error, null, `terminal/wait_for_exit failed: ${JSON.stringify(steps.wait_for_exit?.error)}`)
  assert.equal(steps.wait_for_exit?.result?.exitCode, 3)

  const out = steps.output_immediate?.result
  assert.ok(out, `terminal/output returned nothing: ${JSON.stringify(steps.output_immediate)}`)
  // Asserted FIRST, deliberately: this is the assertion the unfixed
  // 'exit'-only handler cannot pass. The marker is written 300ms after the
  // wrapper's own exit fires, so a terminal/output read immediately after
  // wait_for_exit resolves can only see it if wait_for_exit itself waited for
  // the output to actually finish arriving, not merely for the wrapper
  // process to have exited. The early "before-exit" write below is a much
  // smaller, near-instant write that the buggy handler usually also catches,
  // so checking it first would sometimes name the wrong line as the failure.
  assert.match(String(out.output), /LATE-MARKER-XYZ/,
    `terminal/output read immediately after wait_for_exit is missing output that was still in `
    + `flight when the child exited — wait_for_exit released before the terminal record was `
    + `finalized: ${JSON.stringify(out)}`)
  assert.match(String(out.output), /before-exit/, `expected at least the early write: ${JSON.stringify(out.output)}`)

  assert.equal(steps.release?.error, null, `terminal/release failed: ${JSON.stringify(steps.release?.error)}`)
})

test('wait_for_exit resolves at the bounded close grace, not forever, when a descendant never lets the pipe close', () => {
  // The other half of the fix above: waiting for `close` instead of `exit`
  // must not turn into an unbounded hang when a launcher's forked descendant
  // never lets go of the inherited stdio pipe (a real shape this file already
  // has to reap on teardown — see the sigterm-trap and wrapper-descendant
  // tests). The mock's grandchild here is immortal (`setInterval` forever, no
  // exit, no write), so `close` can never fire on its own; only
  // ACP_TERMINAL_CLOSE_GRACE_MS forces a finalize.
  const run = runCompanion('task-term-close-grace-timeout', {
    ACP_ENABLE_TERMINAL: '1',
    MOCK_SCENARIO: 'terminal-close-grace-timeout',
    ACP_TERMINAL_CLOSE_GRACE_MS: '200',
  })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)
  const recorded = join(run.cwd, '.terminal-close-grace-timeout.json')
  assert.ok(existsSync(recorded), `mock never wrote .terminal-close-grace-timeout.json; stderr:\n${run.stderr}`)
  const steps = JSON.parse(readFileSync(recorded, 'utf8'))
  assert.equal(steps.create.error, null, `terminal/create was refused: ${JSON.stringify(steps.create.error)}`)
  assert.equal(steps.wait_for_exit?.error, null, `terminal/wait_for_exit failed: ${JSON.stringify(steps.wait_for_exit?.error)}`)
  // The WRAPPER's own exit status — proves the bounded fallback finalizes
  // with the status `exit` recorded, not something derived from the
  // grandchild (which never exits and has no status to report at all).
  assert.equal(steps.wait_for_exit?.result?.exitCode, 3)
  // A request that answered near-instantly never actually rode out the grace
  // — it would mean 'close' fired on its own (impossible here, the grandchild
  // never exits) or the bound isn't wired to this env var at all.
  assert.ok(steps.waitElapsedMs >= 150,
    `wait_for_exit against a pipe that can never reach EOF resolved in ${steps.waitElapsedMs}ms — `
    + `expected it to ride out ACP_TERMINAL_CLOSE_GRACE_MS=200 before finalizing`)
  const out = steps.output_after_grace?.result
  assert.ok(out, `terminal/output returned nothing: ${JSON.stringify(steps.output_after_grace)}`)
  assert.match(String(out.output), /before-exit/, `expected the early write to have been captured: ${JSON.stringify(out.output)}`)
})

test('a session-reported model is refused when it is Gemini 3.1, even though nothing requested it', () => {
  // No ACP_MODEL / ACP_EXPECT_MODEL is set below — this is the
  // INHERIT_ACCOUNT_DEFAULT shape: a seat that asks for whatever the account
  // currently defaults to. MOCK_MODEL stands in for that account default
  // reporting a prohibited Gemini 3.1 seat back on session/new. Before the
  // fix, identityRequested is false, extractIdentity forces status
  // 'unverified', and enforceIdentity returns without ever comparing the
  // observed model against PROHIBITED_MODEL — the turn would proceed on a
  // prohibited model with no console.error and exit 0.
  const run = runCompanion('task-term-prohibited-model', { MOCK_MODEL: 'gemini-3.1-pro-high' })
  assert.notEqual(run.status, 0,
    `a session reporting a prohibited Gemini 3.1 model must not be treated as a clean dispatch; stderr:\n${run.stderr}`)
  assert.match(run.stderr, /Gemini 3\.1 is prohibited/,
    `expected the fail-closed refusal to name the prohibition; stderr:\n${run.stderr}`)
  assert.ok(!run.requests.some((entry) => entry.method === 'session/prompt'),
    'the turn proceeded on a prohibited model instead of being refused before session/prompt')
})
