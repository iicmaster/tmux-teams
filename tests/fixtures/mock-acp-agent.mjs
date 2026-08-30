// Deterministic ACP agent used by the companion and phase-gate tests.
// It deliberately exercises startup, long-running tools, duplicate/noise
// updates, cancellation, identity, and descendant-process cleanup paths.
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, message = 'mock operation failed') => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
// MOCK_ENV_DUMP=<file>: write the environment this agent was SPAWNED with, so
// a test can assert what the companion actually handed the adapter rather than
// what the companion's source appears to compute. Added for the bare-mode fix —
// the claim under test is "the default claude lane no longer gets
// CLAUDE_CODE_SIMPLE=1", and only the child can say what it received.
//
// IT WRITES AN ALLOWLIST, NOT THE ENVIRONMENT. Serialising all of `process.env`
// put whatever credential the operator's shell was carrying —
// ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, anything a lane forwards — in
// plaintext into a temp file the test never removes. An openai lane found it in
// round 4. The guards read two keys; only those two are written, and a key
// added here should be one no credential can occupy.
const ENV_DUMP_KEYS = ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CONFIG_DIR']

// PRESENCE, NEVER VALUE, for the keys that can hold a credential. A guard has
// to be able to prove the credential REACHED the child — an openai lane and a
// zai lane both pointed out that observing only the rule's output cannot tell a
// companion reading the constructed child environment from one reading its own
// process.env, and that if the lane allowlist ever dropped these keys the child
// would start bare with nothing to authenticate with, behind a green test. That
// is the 22-day failure again. So the fixture reports whether each is set and
// never what it is: the guard becomes possible and no credential reaches disk.
const CREDENTIAL_PRESENCE_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']

// A RULE, NOT A SECOND HAND-MAINTAINED LIST. The no-credential-to-disk
// guarantee used to hold only while ENV_DUMP_KEYS and the decoy's carrier
// stayed disjoint — widen the first with a credential-shaped name and the value
// is written out while the suite stays green. A zai lane called that a P1. Any
// key whose NAME looks like a secret is reported by digest, whatever list it
// was added to.
const SECRET_SHAPED = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|HEADERS|AUTH/i

// A DIGEST, NOT A PRESENCE FLAG. `PRESENT: yes` cannot tell the injected
// credential from a stale one the companion substituted — an openai lane called
// that a P1, and it is right: the child would authenticate with the wrong token
// behind a green test. A truncated SHA-256 pins the exact value and reveals
// none of it.
const { createHash } = await import('node:crypto')
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)

if (process.env.MOCK_ENV_DUMP) {
  const { writeFileSync } = await import('node:fs')
  const observed = {}
  for (const key of ENV_DUMP_KEYS) {
    if (process.env[key] === undefined) continue
    observed[key] = SECRET_SHAPED.test(key) ? `sha256:${digest(process.env[key])}` : process.env[key]
  }
  for (const key of CREDENTIAL_PRESENCE_KEYS) {
    observed[`${key}__DIGEST`] = process.env[key] ? `sha256:${digest(process.env[key])}` : ''
  }
  writeFileSync(process.env.MOCK_ENV_DUMP, JSON.stringify(observed))
}
let currentSessionId = process.env.MOCK_SESSION_ID ?? 'sess_mock'
let configuredModel = process.env.MOCK_MODEL ?? process.env.ACP_EXPECT_MODEL ?? 'gpt-mock'
let configuredReasoningEffort = process.env.MOCK_REASONING_EFFORT ?? process.env.ACP_EXPECT_REASONING_EFFORT ?? ''
let promptSeen = false
let cancelSeen = false
let descendant = null
let raceHolder = null
let permissionDecision = ''
let pendingPermissionPrompt = null
const PERMISSION_REQUEST_ID = 'mock-permission-request'
const CANCEL_PERMISSION_REQUEST_ID = 'mock-permission-after-cancel'
// Generic id -> resolver map for requests THIS fixture originates (terminal/*
// so far). Separate from the two hand-named ids above because those predate
// it and nothing needs them to move.
const mockPendingResponses = new Map()
function sendMockRequest(method, params) {
  return new Promise((resolve) => {
    const id = `mock-${method.replace(/[^a-z0-9]+/gi, '-')}-${Math.random().toString(36).slice(2)}`
    mockPendingResponses.set(id, (message) => resolve({ result: message.result ?? null, error: message.error ?? null }))
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const envNumber = (name, fallback) => {
  const number = Number(process.env[name])
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

// The delay defaults to 0 (unchanged handler-fires-immediately behavior).
// A test can widen it to stand in for scheduler contention on the companion
// side of the TERM->KILL race deterministically, instead of waiting for real
// load to reproduce it. See acp-companion.test.mjs's FORCED_TERM_KILL_GRACE_MS.
if (process.env.MOCK_SCENARIO === 'cancel-sigterm-exit-zero') {
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), envNumber('MOCK_SIGTERM_EXIT_DELAY_MS', 0)))
}

function notify(update, sessionId = currentSessionId) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}

function identity() {
  if (process.env.MOCK_NO_IDENTITY === '1') return {}
  const model = configuredModel
  const effort = configuredReasoningEffort
  if (process.env.MOCK_CONFIG_IDENTITY === '1') {
    const modelOptions = (process.env.MOCK_MODEL_OPTIONS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [])
    const effortOptions = (process.env.MOCK_REASONING_EFFORT_OPTIONS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [])
    // With MOCK_MODEL_OPTIONS_STRICT the advertised list is exactly what the
    // operator wrote — the shape antigravity-acp 1.0.0 presents, whose model
    // values carry a "\t<display label>" suffix and never include the bare id
    // a client requests. Without it the mock keeps its old courtesy of
    // adding the current model so older tests stay meaningful.
    if (process.env.MOCK_MODEL_OPTIONS_STRICT !== '1' && !modelOptions.includes(model)) modelOptions.unshift(model)
    if (effort && !effortOptions.includes(effort)) effortOptions.unshift(effort)
    return {
      configOptions: [
        {
          id: 'model', name: 'Model', type: 'select', currentValue: model,
          options: modelOptions.map((value) => ({ value, name: value })),
        },
        ...(effort ? [{
          id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: effort,
          options: effortOptions.map((value) => ({ value, name: value })),
        }] : []),
      ],
    }
  }
  return { models: { currentModelId: effort ? `${model}[${effort}]` : model } }
}

function agentInfo() {
  if (process.env.MOCK_NO_AGENT_INFO === '1') return undefined
  return {
    name: process.env.MOCK_AGENT_NAME ?? 'mock-acp-agent',
    version: process.env.MOCK_AGENT_VERSION ?? '1',
  }
}

function writeDescendant() {
  if (process.env.MOCK_SPAWN_DESCENDANT !== '1' || descendant) return
  descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
  // Atomically. `writeFileSync` opens with O_CREAT|O_TRUNC and writes second,
  // so a reader polling `existsSync` can see the path appear while it is still
  // empty — `Number('')` is 0, and the test that read it asserted on a pid of
  // 0. That is issue #39: six green runs then a red one, blamed on load for a
  // week. A rename is atomic on one filesystem, so the path either is not there
  // or holds the whole pid.
  const pidPath = join(process.cwd(), '.descendant-pid')
  writeFileSync(`${pidPath}.tmp`, `${descendant.pid}\n`, { mode: 0o600 })
  renameSync(`${pidPath}.tmp`, pidPath)
}

function writeMockStage(stage) {
  const path = process.env.MOCK_STAGE_FILE
  if (!path) return
  appendFileSync(path, `${stage}\n`, { mode: 0o600 })
}

async function waitForMockGate(stage) {
  if (process.env.MOCK_GATE_STAGE !== stage || !process.env.MOCK_GATE_RELEASE_FILE) return
  writeMockStage(`${stage}-reached`)
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync(process.env.MOCK_GATE_RELEASE_FILE)) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  writeMockStage(`${stage}-released`)
}

async function stopDescendant() {
  if (!descendant || descendant.exitCode !== null) return
  try { descendant.kill('SIGTERM') } catch {}
  await Promise.race([once(descendant, 'close'), wait(250)])
  if (descendant.exitCode === null) {
    try { descendant.kill('SIGKILL') } catch {}
    await Promise.race([once(descendant, 'close'), wait(250)])
  }
}

function writeOutbox(prompt) {
  const text = (prompt.params?.prompt ?? []).map((part) => part.text ?? '').join('')
  const id = text.match(/\.mailbox-out\/([A-Za-z0-9_-]+)/)?.[1]
  if (!id || process.env.MOCK_TERMINAL === 'missing') return
  const terminal = process.env.MOCK_TERMINAL ?? 'done'
  const marker = terminal === 'blocked' ? `TEAM_BLOCKED ${id}`
    : terminal === 'failed' ? `TEAM_FAILED ${id}`
      : terminal === 'invalid' ? 'TEAM_DONE wrong-id' : `TEAM_DONE ${id}`
  const workerEnvelopeText = text.match(/CURRENT_TASK_ENVELOPE_JSON:([^\n]+)/)?.[1]
  const evaluatorTaskId = text.match(/EVALUATOR_TASK_ID:([^\n]+)/)?.[1]?.trim()
  const evaluatorPhase = text.match(/EVALUATOR_PHASE:([^\n]+)/)?.[1]?.trim()
  const evaluatedTasks = JSON.parse(text.match(/EVALUATED_TASKS_JSON:([^\n]+)/)?.[1] ?? '[]')
  let envelope = ''
  if (evaluatorTaskId) {
    const decisions = evaluatedTasks.map((task, index) => {
      const rejected = evaluatorPhase === 'E1' && index === 1
      return {
        task_id: task.task_id,
        attempt: task.attempt,
        decision: rejected ? 'rejected' : 'accepted',
        criterion_verdicts: { criterion_delivery: rejected ? 'fail' : 'pass', criterion_integrity: 'pass' },
        defects: rejected ? [{ criterion_id: 'criterion_delivery', defect_code: 'SEEDED_ACCEPTANCE_DEFECT' }] : [],
      }
    })
    envelope = `EVALUATOR_RESULT_JSON:${JSON.stringify({
      schema_version: 'evaluator-result.v1',
      evaluator_task_id: evaluatorTaskId,
      provenance: 'live_acp',
      phase: evaluatorPhase,
      evaluated_tasks: evaluatedTasks,
      decisions,
    })}\n`
  } else if (workerEnvelopeText) {
    const task = JSON.parse(workerEnvelopeText)
    const result = {
      schema_version: 'worker-result.v1',
      task_id: task.task_id,
      team_id: task.team_id,
      work_id: task.work_id,
      attempt: task.attempt,
      completion_status: 'completed',
      verification: { passed: true, exit_code: 0 },
      gaps: [],
      unverified: [],
      artifact_digest: task.expected_artifact_digest,
      delivery_evidence: {
        present: task.delivery_evidence === 'present',
        path: task.delivery_evidence === 'present' ? `attempt-outboxes/${task.task_id}` : null,
      },
    }
    if (process.env.MOCK_INVALID_WORK_ID === task.work_id) result.extra_unallowed_key = true
    envelope = `WORKER_RESULT_JSON:${JSON.stringify(result)}\n`
  }
  mkdirSync('.mailbox-out', { recursive: true })
  const evidence = process.env.MOCK_EVIDENCE === '1' ? 'EVIDENCE: node --test — 1/1 pass\n' : ''
  // The normal companion fixture only proves transport completion. The loop
  // smoke needs the judgements that the runner actually harvests, keyed by the
  // declared agent identity rather than mutable prose in a role brief.
  let configuredVerdicts = {}
  try { configuredVerdicts = JSON.parse(process.env.MOCK_LOOP_VERDICTS ?? '{}') } catch { /* opt-in fixture input is invalid */ }
  const configured = configuredVerdicts && typeof configuredVerdicts === 'object' && !Array.isArray(configuredVerdicts)
    ? configuredVerdicts : {}
  const candidate = configured[process.env.ACP_AGENT_ID ?? '']
  const verdict = typeof candidate === 'string' && /^[a-z-]+$/.test(candidate) ? candidate : ''
  const verdictBlock = verdict ? `VERDICT: ${verdict}\nREASON: deterministic mock loop verdict\n` : ''
  const did = permissionDecision ? `DID: mock work; permission=${permissionDecision}` : 'DID: mock work'
  const body = `${did}\n${envelope}${evidence}${verdictBlock}${marker}\n`
  // A worker chooses what kind of file lands at the outbox path, so the fixture
  // has to be able to choose badly. Without these the companion's file-type and
  // size checks have no test that goes red when they are removed.
  const kind = process.env.MOCK_OUTBOX_KIND ?? 'file'
  const outbox = join('.mailbox-out', id)
  if (kind === 'symlink') {
    const target = join(process.cwd(), '.mailbox-out', `${id}.target`)
    writeFileSync(target, body, { mode: 0o600 })
    symlinkSync(target, outbox)
    return
  }
  if (kind === 'fifo') {
    // The FIFO is created by the TEST, OUTSIDE `.mailbox-out`, and moved into
    // place HERE — during the turn, which is the only moment a worker outbox
    // can arrive. Staging it at the outbox path before the run made
    // `clearStaleOutbox()` refuse it before `session/prompt`, so the run died
    // there and `readTerminalOutbox` — the reader this test exists to prove —
    // was never reached. The two refusals share a sentence, so the assertion
    // matched and the test stayed green while testing something else. Measured
    // by the reviewer who found it: deleting the reader's own file-type check
    // left this test passing.
    //
    // A rename, not a `mkfifo`: renaming needs no fork, so the one operation
    // that could fail under load stays in the test, where a setup failure is
    // reported as a setup failure.
    //
    // It used to be `spawnSync('mkfifo')` right here, with its result ignored.
    // When that fork failed there was no file at the outbox path at all, so the
    // companion answered "no outbox" and a test about file-type refusal failed
    // on the wording of an unrelated error — which is how it read the one time
    // it went red: `AssertionError: fifo`. Making the fixture throw was the
    // first repair and it was not enough: a setup failure still surfaced inside
    // the run, as agent stderr, where the assertion could not tell it apart
    // from a misclassification. Setup now happens where a setup failure can be
    // reported AS a setup failure. No writer is ever opened either way — a
    // blocking reader would wait here for ever.
    renameSync(process.env.MOCK_FIFO_SOURCE, outbox)
    return
  }
  if (kind === 'oversize') {
    writeFileSync(outbox, 'x'.repeat(5 * 1024 * 1024), { mode: 0o600 })
    return
  }
  writeFileSync(outbox, body, { mode: 0o600 })
}

function permissionOptions(scenario) {
  if (scenario === 'empty') return []
  if (scenario === 'prefer-always') {
    return [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' },
    ]
  }
  if (scenario === 'prefer-once') {
    return [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' },
    ]
  }
  return [{ optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }]
}

// Drives the full terminal/* lifecycle against the real companion and
// records what came back, so a test can tell "refused" from "served" without
// a human — and "served" means a real child process actually ran, not a
// stubbed terminalId. `outputByteLimit: 4096` is set explicitly so the
// companion's own default cannot silently satisfy the assertion.
async function runTerminalRoundtrip(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', 'process.stdout.write("terminal-probe-output\\n"); process.exitCode = 3'],
    outputByteLimit: 4096,
  })
  const terminalId = steps.create.result?.terminalId
  if (terminalId) {
    steps.wait_for_exit = await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    steps.output = await sendMockRequest('terminal/output', { sessionId: currentSessionId, terminalId })
    steps.release = await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
    // A `release`d id must stop working — proves release actually freed the
    // resource rather than only returning a success shape.
    steps.output_after_release = await sendMockRequest('terminal/output', { sessionId: currentSessionId, terminalId })
  }
  writeFileSync(join(process.cwd(), '.terminal-roundtrip.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// A login command that reads its input until EOF. The stdin bridge forwarded
// every keystroke and never the end of them, so this child blocked forever and
// took `terminal/wait_for_exit` and the whole turn with it. The child exits 7 on
// 'end', so the recorded exit status says plainly whether EOF arrived.
async function runTerminalEof(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = 7 })"],
    outputByteLimit: 4096,
  })
  const terminalId = steps.create.result?.terminalId
  if (terminalId) {
    steps.wait_for_exit = await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    steps.release = await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
  }
  writeFileSync(join(process.cwd(), '.terminal-eof.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Emits a child request whose `method` is truthy but NOT a string, then finishes
// the turn normally. The companion's router reached `message.method.startsWith`
// after only a truthy check, so this frame threw TypeError inside the readline
// callback and killed the process before its terminal snapshot — one bad frame
// from an adapter, and the lane stops with no record of why.
async function runMalformedRequest(prompt) {
  send({ jsonrpc: '2.0', id: 'malformed-1', method: 42, params: {} })
  send({ jsonrpc: '2.0', id: 'malformed-2', method: { nested: true }, params: {} })
  // A well-formed unknown method must still be answered, so this scenario also
  // proves the refusal is about the TYPE and not about the router giving up.
  send({ jsonrpc: '2.0', id: 'malformed-3', method: 'nobody/knows', params: {} })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Overruns the terminal output cap ON PURPOSE, with multi-byte characters
// positioned so a naive byte slice lands INSIDE one. 100 Thai characters at 3
// bytes each is 300 bytes against a 64-byte cap, so the tail starts 236 bytes
// in — two bytes into a character. A companion that keeps the whole buffer,
// or that slices without walking to a character boundary, is visible in the
// recorded output and in nothing else.
async function runTerminalOverflow(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', 'process.stdout.write("\u0e01".repeat(100))'],
    outputByteLimit: 64,
  })
  const terminalId = steps.create.result?.terminalId
  if (terminalId) {
    steps.wait_for_exit = await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    steps.output = await sendMockRequest('terminal/output', { sessionId: currentSessionId, terminalId })
    steps.release = await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
  }
  writeFileSync(join(process.cwd(), '.terminal-overflow.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Creates a terminal that never exits on its own and never releases it —
// standing in for a login command still waiting on human input when the rest
// of the turn otherwise completes normally. The child writes its OWN pid to
// a file in cwd (the companion's cwd, since no `cwd` override is sent) so a
// test with no other way to see inside the companion's process table can
// still prove whether that pid is still alive after the companion exits.
//
// Same trap `writeDescendant` already documents (issue #39): a plain
// `writeFileSync` opens O_CREAT|O_TRUNC and writes second, so a path can
// exist and read empty. The spawned child writes a `.tmp` file and renames it
// into place, and this function then WAITS for that final name to exist
// before letting the turn finish — otherwise the teardown sweep this scenario
// exists to test could SIGTERM the child mid-startup, before it ever reaches
// the rename, and the test would read "no pid file" as a pass instead of a
// missed measurement.
async function runTerminalOrphanProbe(prompt) {
  await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e',
      'const fs = require("fs"); fs.writeFileSync("terminal-orphan-pid.tmp", String(process.pid)); '
      + 'fs.renameSync("terminal-orphan-pid.tmp", "terminal-orphan-pid"); setInterval(() => {}, 1000)'],
  })
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-orphan-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Same pid-file trick as runTerminalOrphanProbe, but the child ALSO installs
// a no-op SIGTERM handler before it loops — the shape a real login command
// with its own signal handling (or a shell "trap \"\" TERM") can present. A
// companion that sends only one SIGTERM and never escalates leaves this
// child running forever; the test proves the opposite by checking the pid is
// gone after the companion has already exited.
async function runTerminalSigtermTrapProbe(prompt) {
  await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e',
      'process.on("SIGTERM", () => {}); '
      + 'const fs = require("fs"); fs.writeFileSync("terminal-sigterm-trap-pid.tmp", String(process.pid)); '
      + 'fs.renameSync("terminal-sigterm-trap-pid.tmp", "terminal-sigterm-trap-pid"); setInterval(() => {}, 1000)'],
  })
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-sigterm-trap-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Same SIGTERM-trapping child as runTerminalSigtermTrapProbe, but this one is
// RELEASED (terminal/release) before the turn ends instead of being left
// orphaned. terminal/release used to delete the terminal from the tracking
// map the instant it sent its own SIGTERM — regardless of whether the child
// actually died — which made it invisible to killAllLiveTerminals' teardown
// sweep from that point on. A child that traps SIGTERM would then survive
// BOTH the release's own signal and teardown, exactly the "outlives the
// companion" shape the finding describes, just reached through a second door.
async function runTerminalSigtermTrapReleaseProbe(prompt) {
  const create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e',
      'process.on("SIGTERM", () => {}); '
      + 'const fs = require("fs"); fs.writeFileSync("terminal-sigterm-trap-release-pid.tmp", String(process.pid)); '
      + 'fs.renameSync("terminal-sigterm-trap-release-pid.tmp", "terminal-sigterm-trap-release-pid"); setInterval(() => {}, 1000)'],
  })
  const terminalId = create.result?.terminalId
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-sigterm-trap-release-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  if (terminalId) await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// A terminal command that is itself a LAUNCHER — standing in for a shell,
// npx, or bunx wrapper — forks a plain (non-detached) descendant that traps
// SIGTERM, then the wrapper exits immediately on its own. Before
// createTerminal spawned with `detached: true`, the wrapper and its
// descendant shared the COMPANION's own process group, so any signal aimed
// at "this terminal" could only ever reach the wrapper pid; once the wrapper
// exited on its own, the descendant was invisible both to that 'exit' event
// and to any attempt to signal the terminal as a whole. The turn otherwise
// completes normally and this terminal is never released, so this proves the
// companion's teardown sweep reaps the WHOLE subtree the wrapper forked, not
// only the wrapper it directly spawned.
async function runTerminalWrapperDescendantProbe(prompt) {
  const descendantScript = [
    'process.on("SIGTERM", () => {});',
    'const fs = require("fs");',
    'fs.writeFileSync("terminal-wrapper-descendant-pid.tmp", String(process.pid));',
    'fs.renameSync("terminal-wrapper-descendant-pid.tmp", "terminal-wrapper-descendant-pid");',
    'setInterval(() => {}, 1000);',
  ].join(' ')
  const wrapperScript = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'fs.writeFileSync("wrapper-descendant-child.js", ' + JSON.stringify(descendantScript) + ');',
    'const child = spawn(process.execPath, ["wrapper-descendant-child.js"], { stdio: "ignore" });',
    'child.unref();',
    'process.exit(0);',
  ].join(' ')
  await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', wrapperScript],
  })
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-wrapper-descendant-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// The gap the wrapper-descendant probe above does NOT cover: that one never
// releases the terminal, so it stays in `terminals` (never deleted) and
// killAllLiveTerminals' teardown sweep reaps the whole group regardless of the
// wrapper's own `exitStatus`. This probe forces the order the finding names —
// the wrapper (a launcher, same shape as above) exits and settles FIRST, and
// only THEN is `terminal/release` called. `terminal/wait_for_exit` is awaited
// first so the release below deterministically lands after `exitStatus` is
// set — otherwise this could race and accidentally exercise the OTHER order
// (release-before-exit) instead, which is a different code path entirely.
// The descendant traps SIGTERM and holds NO pipe (`stdio: 'ignore'`), so
// nothing about its own I/O keeps anything open — it is exactly the shape
// the finding says slips past every existing test.
async function runTerminalReleaseAfterCloseProbe(prompt) {
  const descendantScript = [
    'process.on("SIGTERM", () => {});',
    'const fs = require("fs");',
    'fs.writeFileSync("terminal-release-after-close-pid.tmp", String(process.pid));',
    'fs.renameSync("terminal-release-after-close-pid.tmp", "terminal-release-after-close-pid");',
    'setInterval(() => {}, 1000);',
  ].join(' ')
  const wrapperScript = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'fs.writeFileSync("release-after-close-child.js", ' + JSON.stringify(descendantScript) + ');',
    'const child = spawn(process.execPath, ["release-after-close-child.js"], { stdio: "ignore" });',
    'child.unref();',
    'process.exit(0);',
  ].join(' ')
  const create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', wrapperScript],
  })
  const terminalId = create.result?.terminalId
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-release-after-close-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  if (terminalId) {
    await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
  }
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Same order as the release probe above (wrapper settles first, its
// stdio-'ignore' descendant traps SIGTERM and outlives it), but through
// `terminal/kill` instead of `terminal/release`. This one is NOT provable by
// a final "is the pid gone" check alone: `killTerminal` returning early
// without reaping does not delete the map entry, so the LATER teardown sweep
// would reap the descendant anyway and hide the bug. The load-bearing
// assertion is the immediate one — `killElapsedMs` and `aliveAfterKill`
// checked right after the `terminal/kill` request itself resolves, same shape
// `runTerminalKillEscalationProbe` already uses.
async function runTerminalKillAfterCloseProbe(prompt) {
  const descendantScript = [
    'process.on("SIGTERM", () => {});',
    'const fs = require("fs");',
    'fs.writeFileSync("terminal-kill-after-close-pid.tmp", String(process.pid));',
    'fs.renameSync("terminal-kill-after-close-pid.tmp", "terminal-kill-after-close-pid");',
    'setInterval(() => {}, 1000);',
  ].join(' ')
  const wrapperScript = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'fs.writeFileSync("kill-after-close-child.js", ' + JSON.stringify(descendantScript) + ');',
    'const child = spawn(process.execPath, ["kill-after-close-child.js"], { stdio: "ignore" });',
    'child.unref();',
    'process.exit(0);',
  ].join(' ')
  const create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', wrapperScript],
  })
  const terminalId = create.result?.terminalId
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-kill-after-close-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  const descendantPid = Number(readFileSync('terminal-kill-after-close-pid', 'utf8').trim())
  if (terminalId) {
    await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    const killStartedAt = Date.now()
    const kill = await sendMockRequest('terminal/kill', { sessionId: currentSessionId, terminalId })
    const killElapsedMs = Date.now() - killStartedAt
    const pollDeadline = Date.now() + envNumber('MOCK_KILL_POLL_MS', 400)
    let aliveAfterKill = true
    while (Date.now() < pollDeadline) {
      try { process.kill(descendantPid, 0); aliveAfterKill = true } catch { aliveAfterKill = false; break }
      await wait(10)
    }
    writeFileSync(join(process.cwd(), '.terminal-kill-after-close.json'),
      `${JSON.stringify({ kill, killElapsedMs, aliveAfterKill, descendantPid }, null, 2)}\n`, { mode: 0o600 })
  }
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// The THIRD site (`settleTerminalExit`), reached through the OPPOSITE order:
// `terminal/release` is called while the wrapper is still alive, and the
// wrapper's own settlement follows afterward. The wrapper here deliberately
// does NOT trap SIGTERM, so release's own group signal kills it almost
// immediately; the descendant DOES trap SIGTERM (and holds no pipe) and
// outlives that same signal. `settleTerminalExit` then runs for the wrapper
// with `term.released` already true — the exact moment a delete keyed only on
// `released` (instead of on the group actually being gone) would drop the
// still-live descendant from the map before the teardown sweep ever sees it.
async function runTerminalReleaseWhileAliveTrappedDescendantProbe(prompt) {
  const descendantScript = [
    'process.on("SIGTERM", () => {});',
    'const fs = require("fs");',
    'fs.writeFileSync("terminal-release-while-alive-pid.tmp", String(process.pid));',
    'fs.renameSync("terminal-release-while-alive-pid.tmp", "terminal-release-while-alive-pid");',
    'setInterval(() => {}, 1000);',
  ].join(' ')
  const wrapperScript = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'fs.writeFileSync("release-while-alive-child.js", ' + JSON.stringify(descendantScript) + ');',
    'const child = spawn(process.execPath, ["release-while-alive-child.js"], { stdio: "ignore" });',
    'child.unref();',
    // The wrapper itself installs NO SIGTERM handler, so it dies at the first
    // group signal release sends — it must stay alive (via this interval)
    // only until that signal arrives, never trap it.
    'setInterval(() => {}, 1000);',
  ].join(' ')
  const create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', wrapperScript],
  })
  const terminalId = create.result?.terminalId
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-release-while-alive-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  if (terminalId) await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// terminal/kill against a child that traps SIGTERM, called MID-TURN rather
// than left for companion teardown. Before the request path escalated to
// SIGKILL itself, it sent one SIGTERM and answered success IMMEDIATELY, so
// the primary measurement here is REQUEST LATENCY: with the escalation ladder
// inside the request, a SIGTERM-trapping child forces `terminal/kill` to sit
// through the whole ACP_TERMINAL_KILL_GRACE_MS grace period before it can
// answer, because that is the only way it can know SIGTERM did nothing. A
// fire-and-forget kill instead answers in a handful of milliseconds no matter
// how long the grace period is — and does so even though the SAME background
// escalation still runs and kills the child moments later, so a single
// post-response aliveness check alone cannot tell the two apart if the poll
// window is comparable to the grace period. The poll below is kept only as a
// secondary corroborating signal, not the load-bearing one.
async function runTerminalKillEscalationProbe(prompt) {
  const create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e',
      'process.on("SIGTERM", () => {}); '
      + 'const fs = require("fs"); fs.writeFileSync("terminal-kill-trap-pid.tmp", String(process.pid)); '
      + 'fs.renameSync("terminal-kill-trap-pid.tmp", "terminal-kill-trap-pid"); setInterval(() => {}, 1000)'],
  })
  const terminalId = create.result?.terminalId
  const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
  while (!existsSync('terminal-kill-trap-pid')) {
    if (Date.now() >= deadline) process.exit(17)
    await wait(10)
  }
  const pid = Number(readFileSync('terminal-kill-trap-pid', 'utf8').trim())
  const killStartedAt = Date.now()
  const kill = terminalId ? await sendMockRequest('terminal/kill', { sessionId: currentSessionId, terminalId }) : null
  const killElapsedMs = Date.now() - killStartedAt
  const pollDeadline = Date.now() + envNumber('MOCK_KILL_POLL_MS', 250)
  let aliveAfterKill = true
  while (Date.now() < pollDeadline) {
    try { process.kill(pid, 0); aliveAfterKill = true } catch { aliveAfterKill = false; break }
    await wait(10)
  }
  writeFileSync(join(process.cwd(), '.terminal-kill-escalation.json'),
    `${JSON.stringify({ kill, killElapsedMs, aliveAfterKill }, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// A second terminal/create while the first is still live (never released,
// never exited). createTerminal now refuses this instead of allowing both
// terminals onto the login stdin bridge's broadcast, which would deliver
// every keystroke — including a login code meant for one command — to both
// children. Releases the first afterward so the turn completes cleanly.
async function runTerminalConcurrentCreate(prompt) {
  const steps = {}
  steps.first = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  })
  steps.second = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  })
  const firstId = steps.first.result?.terminalId
  if (firstId) steps.release = await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId: firstId })
  writeFileSync(join(process.cwd(), '.terminal-concurrent-create.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// terminal/create with a non-string args element — the companion must refuse
// the whole request rather than silently dropping the bad element and running
// a different command than what was asked for.
async function runTerminalMalformedArgs(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: 'echo',
    args: ['a', 1, 'b'],
  })
  writeFileSync(join(process.cwd(), '.terminal-malformed-args.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// terminal/create with `args` present but NOT an array (a bare string) — the
// element-type check above assumes args is already an array and never runs
// against this shape, so the ternary in createTerminal used to fall through
// to `[]` exactly like it does for `undefined`, silently dropping every
// argument and running a materially different command instead of refusing
// the malformed request.
async function runTerminalArgsNotArray(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: 'echo',
    args: '--login',
  })
  writeFileSync(join(process.cwd(), '.terminal-args-not-array.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// terminal/create with a non-array env — the twin of the args case, and it was
// still open after the args one was closed.
async function runTerminalEnvNotArray(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: 'echo',
    args: ['hi'],
    env: 'FOO=1',
  })
  writeFileSync(join(process.cwd(), '.terminal-env-not-array.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// terminal/create with a non-string env override value — the companion must
// refuse rather than coerce the value to the literal string "[object Object]".
async function runTerminalMalformedEnv(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: 'echo',
    args: ['hi'],
    env: [{ name: 'FOO', value: { bad: 1 } }],
  })
  writeFileSync(join(process.cwd(), '.terminal-malformed-env.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// A URL split across two 'data' events at a point that ALSO splits one
// multi-byte UTF-8 character's bytes: chunk1 ends with the first byte of
// 'é' (0xC3), chunk2 opens with its second byte (0xA9). One scenario proves
// two mechanisms at once, deliberately: decoding chunk-by-chunk with no
// stateful decoder turns 0xC3 and 0xA9 into two U+FFFD, and mirroring
// chunk-by-chunk with no line buffering would put a second
// "[terminal:id] " label mid-URL even if the bytes decoded correctly. The
// 60ms gap (a setTimeout, not a second synchronous write) is what forces the
// two writes to arrive as two separate 'data' events instead of being
// coalesced into one pipe read.
async function runTerminalChunkSplit(prompt) {
  const steps = {}
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e',
      'const b1 = Buffer.concat([Buffer.from("open https://ex"), Buffer.from([0xC3])]); '
      + 'const b2 = Buffer.concat([Buffer.from([0xA9]), Buffer.from("mple.com/device?code=ABC123\\n")]); '
      + 'process.stdout.write(b1); '
      + 'setTimeout(() => { process.stdout.write(b2) }, 60)'],
  })
  const terminalId = steps.create.result?.terminalId
  if (terminalId) {
    steps.wait_for_exit = await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    steps.output = await sendMockRequest('terminal/output', { sessionId: currentSessionId, terminalId })
  }
  writeFileSync(join(process.cwd(), '.terminal-chunk-split.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// Forces the exact race PR #71 comment 3835247725 named: the terminal
// wrapper's own process exits almost immediately, while a grandchild it
// forked and left unref'd (a stand-in for a shell/npx/bunx launcher's own
// forked work) keeps the wrapper's inherited stdout fd open and writes a
// LATE marker line only after a further delay. `child.unref()` means the
// wrapper's event loop does not wait on the grandchild, so the wrapper's own
// `exit` fires almost at once — deterministically before the marker line has
// even been written, let alone delivered — while the pipe itself cannot
// reach EOF (and Node's child_process 'close' cannot fire) until the
// grandchild also lets go of that fd, which only happens once its own delay
// elapses. A companion that finalizes on 'exit' resolves
// `terminal/wait_for_exit` before the marker arrives, so the immediate
// `terminal/output` that follows is missing it; one that waits for 'close'
// cannot return before the marker is already in `outputText`, because the
// same 'data' listener that appends it also runs before 'close' can fire.
async function runTerminalExitBeforeClose(prompt) {
  const steps = {}
  const grandchildScript = 'setTimeout(() => { process.stdout.write("LATE-MARKER-XYZ\\n") }, 300);'
  const wrapperScript = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'fs.writeFileSync("exit-before-close-child.js", ' + JSON.stringify(grandchildScript) + ');',
    'process.stdout.write("before-exit\\n");',
    'const child = spawn(process.execPath, ["exit-before-close-child.js"], { stdio: "inherit" });',
    'child.unref();',
    'process.exitCode = 3;',
  ].join(' ')
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', wrapperScript],
    outputByteLimit: 4096,
  })
  const terminalId = steps.create.result?.terminalId
  if (terminalId) {
    steps.wait_for_exit = await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    // No delay of our own between wait_for_exit resolving and this read — the
    // whole point is to observe whatever `outputText` holds at the instant the
    // waiter was released, not after giving the marker more time to arrive.
    steps.output_immediate = await sendMockRequest('terminal/output', { sessionId: currentSessionId, terminalId })
    steps.release = await sendMockRequest('terminal/release', { sessionId: currentSessionId, terminalId })
  }
  writeFileSync(join(process.cwd(), '.terminal-exit-before-close.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

// The other half of the same fix: a grandchild that never lets go of the
// inherited pipe at all (it just loops forever, never exits) means `close`
// never fires either — proving the wait is BOUNDED, not that waiting for
// `close` traded a stale-output bug for a hang. Records elapsed time around
// `wait_for_exit` so the test can assert it actually rode out the bound
// rather than resolving instantly (which would mean the fix wasn't really
// exercised) or never returning at all (which would mean the bound is not
// real).
//
// Deliberately never releases the terminal: releasing an already-exited one
// deletes it from the tracking map immediately, which would hide this
// grandchild from killAllLiveTerminals' teardown sweep the same way the
// sigterm-trap-release test already proves for a still-live wrapper — left
// in the map, the sweep at companion exit reaps the whole process group
// (wrapper and grandchild share one, per createTerminal's `detached: true`).
async function runTerminalCloseGraceTimeout(prompt) {
  const steps = {}
  const grandchildScript = 'setInterval(() => {}, 1000);'
  const wrapperScript = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    'fs.writeFileSync("close-grace-timeout-child.js", ' + JSON.stringify(grandchildScript) + ');',
    'process.stdout.write("before-exit\\n");',
    'const child = spawn(process.execPath, ["close-grace-timeout-child.js"], { stdio: "inherit" });',
    'child.unref();',
    'process.exitCode = 3;',
  ].join(' ')
  steps.create = await sendMockRequest('terminal/create', {
    sessionId: currentSessionId,
    command: process.execPath,
    args: ['-e', wrapperScript],
    outputByteLimit: 4096,
  })
  const terminalId = steps.create.result?.terminalId
  if (terminalId) {
    const startedAt = Date.now()
    steps.wait_for_exit = await sendMockRequest('terminal/wait_for_exit', { sessionId: currentSessionId, terminalId })
    steps.waitElapsedMs = Date.now() - startedAt
    steps.output_after_grace = await sendMockRequest('terminal/output', { sessionId: currentSessionId, terminalId })
  }
  writeFileSync(join(process.cwd(), '.terminal-close-grace-timeout.json'), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 })
  writeOutbox(prompt)
  reply(prompt.id, { stopReason: 'end_turn' })
}

function requestPermission(prompt) {
  const scenario = process.env.MOCK_REQUEST_PERMISSION
  if (!scenario || permissionDecision || pendingPermissionPrompt) return false
  pendingPermissionPrompt = prompt
  send({
    jsonrpc: '2.0',
    id: PERMISSION_REQUEST_ID,
    method: 'session/request_permission',
    params: {
      sessionId: currentSessionId,
      toolCall: { title: 'write outbox' },
      options: permissionOptions(scenario),
    },
  })
  return true
}

async function handlePrompt(message) {
  currentSessionId = message.params?.sessionId ?? currentSessionId
  promptSeen = true
  writeDescendant()
  if (process.env.MOCK_STDERR) process.stderr.write(`${process.env.MOCK_STDERR}\n`)
  if (requestPermission(message)) return
  const scenario = process.env.MOCK_SCENARIO
  if (process.env.MOCK_HANG === '1' || scenario === 'silent' || scenario === 'cancel-ack'
    || scenario === 'cancel-no-ack' || scenario === 'cancel-clean-exit' || scenario === 'cancel-exit-7'
    || scenario === 'cancel-race-exit-7' || scenario === 'cancel-sigterm-exit-zero'
    || scenario === 'exit-during-cancel') return

  if (scenario === 'terminal-roundtrip') return void runTerminalRoundtrip(message)
  if (scenario === 'terminal-overflow') return void runTerminalOverflow(message)
  if (scenario === 'malformed-request') return void runMalformedRequest(message)
  if (scenario === 'terminal-eof') return void runTerminalEof(message)
  if (scenario === 'terminal-orphan') return void runTerminalOrphanProbe(message)
  if (scenario === 'terminal-sigterm-trap') return void runTerminalSigtermTrapProbe(message)
  if (scenario === 'terminal-sigterm-trap-release') return void runTerminalSigtermTrapReleaseProbe(message)
  if (scenario === 'terminal-wrapper-descendant') return void runTerminalWrapperDescendantProbe(message)
  if (scenario === 'terminal-release-after-close') return void runTerminalReleaseAfterCloseProbe(message)
  if (scenario === 'terminal-kill-after-close') return void runTerminalKillAfterCloseProbe(message)
  if (scenario === 'terminal-release-while-alive-trapped-descendant') return void runTerminalReleaseWhileAliveTrappedDescendantProbe(message)
  if (scenario === 'terminal-kill-escalation') return void runTerminalKillEscalationProbe(message)
  if (scenario === 'terminal-concurrent-create') return void runTerminalConcurrentCreate(message)
  if (scenario === 'terminal-args-not-array') return void runTerminalArgsNotArray(message)
  if (scenario === 'terminal-malformed-args') return void runTerminalMalformedArgs(message)
  if (scenario === 'terminal-env-not-array') return void runTerminalEnvNotArray(message)
  if (scenario === 'terminal-malformed-env') return void runTerminalMalformedEnv(message)
  if (scenario === 'terminal-chunk-split') return void runTerminalChunkSplit(message)
  if (scenario === 'terminal-exit-before-close') return void runTerminalExitBeforeClose(message)
  if (scenario === 'terminal-close-grace-timeout') return void runTerminalCloseGraceTimeout(message)

  if (scenario === 'report-recover') {
    notify({ sessionUpdate: 'agent_thought_chunk', messageId: 'pre-stall-progress', content: { type: 'text', text: 'starting the recovery observation' } })
    if (process.env.MOCK_RECOVERY_GATE_FILE) {
      const deadline = Date.now() + envNumber('MOCK_GATE_WATCHDOG_MS', 15000)
      while (!existsSync(process.env.MOCK_RECOVERY_GATE_FILE)) {
        if (Date.now() >= deadline) process.exit(17)
        await wait(10)
      }
    } else {
      await wait(envNumber('MOCK_RECOVER_DELAY_MS', 120))
    }
    notify({ sessionUpdate: 'agent_message_chunk', messageId: 'recovery-message', content: { type: 'text', text: 'recovered progress' } })
    await wait(15)
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }
  if (scenario === 'active-progress') {
    const count = Math.max(1, Math.floor(envNumber('MOCK_PROGRESS_COUNT', 5)))
    const delay = envNumber('MOCK_PROGRESS_DELAY_MS', 20)
    for (let index = 0; index < count; index += 1) {
      notify({ sessionUpdate: 'agent_thought_chunk', messageId: `progress-${index}`, content: { type: 'text', text: `progress-${index}` } })
      if (index + 1 < count) await wait(delay)
    }
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }
  if (scenario === 'silent-tool') {
    notify({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'long-running tool',
      kind: 'execute',
      status: 'in_progress',
      content: { type: 'text', text: 'tool started' },
      rawOutput: 'started',
      locations: [{ path: '/tmp/tool-start', line: 1 }],
    })
    await wait(envNumber('MOCK_TOOL_DELAY_MS', 160))
    notify({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'long-running tool', status: 'completed', rawOutput: 'finished' })
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }
  if (scenario === 'metadata-overflow') {
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: `tool-${'i'.repeat(220)} sk-r3-tool-secret-12345678901234567890`,
      title: `title-${'t'.repeat(220)} password=sk-r3-tool-secret-12345678901234567890`,
      kind: `kind-${'k'.repeat(120)} apiKey=sk-r3-tool-secret-12345678901234567890`,
      status: 'completed',
      content: { type: 'text', text: `content password=sk-r3-tool-secret-12345678901234567890 ${'c'.repeat(20000)}` },
      rawOutput: `output token=sk-r3-tool-secret-12345678901234567890 ${'o'.repeat(20000)}`,
      locations: [{ path: `/tmp/${'p'.repeat(20000)}?secret=sk-r3-tool-secret-12345678901234567890`, line: 1 }],
    })
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }
  if (scenario === 'invalid-tool-status') {
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'invalid-tool',
      title: 'invalid status must be ignored',
      status: 'totally-invalid',
      rawOutput: 'must not become progress',
    })
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }
  if (scenario === 'duplicates-noise') {
    const update = { sessionUpdate: 'agent_message_chunk', messageId: 'duplicate-message', content: { type: 'text', text: 'same notification' } }
    const toolUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'duplicate-tool',
      title: 'same tool notification',
      kind: 'execute',
      status: 'completed',
      content: { type: 'text', text: 'same tool result' },
      rawOutput: 'same tool output',
      locations: [{ path: '/tmp/same-tool', line: 1 }],
    }
    notify(update)
    notify(toolUpdate)
    await wait(envNumber('MOCK_DUPLICATE_DELAY_MS', 15))
    notify(update)
    notify(toolUpdate)
    notify(update, 'wrong-session')
    notify(toolUpdate, 'wrong-session')
    process.stderr.write('noise that must not renew the lease\n')
    return
  }
  if (scenario === 'long-stream') {
    const count = Math.max(1, Math.floor(envNumber('MOCK_LONG_STREAM_COUNT', 250)))
    const delay = envNumber('MOCK_LONG_STREAM_DELAY_MS', 0)
    for (let index = 0; index < count; index += 1) {
      notify({ sessionUpdate: 'agent_message_chunk', messageId: `stream-${index}`, content: { type: 'text', text: `stream-${index} apiKey=SUPER_SECRET_VALUE sk-test-secret-12345678901234567890` } })
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: `tool-${index % 80}`,
        title: `tool ${index}`,
        status: index % 2 ? 'in_progress' : 'completed',
        content: { type: 'text', text: 'tool content password=SUPER_SECRET_VALUE' },
        rawOutput: 'output password=SUPER_SECRET_VALUE',
        locations: [{ path: '/tmp/secret-location', line: index + 1 }],
      })
      if (delay) await wait(delay)
    }
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }
  if (scenario === 'unicode-large-tools') {
    const count = Math.max(65, Math.floor(envNumber('MOCK_UNICODE_TOOL_COUNT', 96)))
    const title = '🧪'.repeat(64)
    const kind = 'λ'.repeat(64)
    const secret = 'sk-unicode-secret-12345678901234567890'
    for (let index = 0; index < count; index += 1) {
      const toolCallId = `unicode-tool-${String(index).padStart(3, '0')}-${'i'.repeat(108)}`
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: `${title} ${secret}`,
        kind: `${kind} password=${secret}`,
        status: 'in_progress',
        content: { type: 'text', text: `${'内容'.repeat(12_000)} apiKey=${secret}` },
        rawOutput: `${'出力'.repeat(12_000)} token=${secret}`,
        locations: [{ path: `${'場所'.repeat(12_000)}?secret=${secret}`, line: index + 1 }],
      })
    }
    writeOutbox(message)
    return reply(message.id, { stopReason: 'end_turn' })
  }

  notify({ sessionUpdate: 'agent_thought_chunk', messageId: 'thought-1', content: { type: 'text', text: 'weighing the options' } })
  notify({ sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'doing the work' } })
  notify({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run tests', kind: 'execute', status: 'pending' })
  notify({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'run tests', status: 'completed' })
  notify({ sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'in_progress' }] })
  writeOutbox(message)
  return reply(message.id, { stopReason: 'end_turn' })
}

if (process.env.MOCK_EXIT_EARLY === '1') process.exit(9)

const keepAlive = setInterval(() => {}, 1000)
process.stdin.setEncoding('utf8')
let inputBuffer = ''
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk
  const lines = inputBuffer.split('\n')
  inputBuffer = lines.pop() ?? ''
  for (const line of lines) void handleLine(line)
})
process.stdin.on('end', async () => {
  clearInterval(keepAlive)
  if (descendant && !cancelSeen) await stopDescendant()
  const stdinEndDelayMs = envNumber('MOCK_STDIN_END_DELAY_MS', 0)
  if (stdinEndDelayMs > 0) await wait(stdinEndDelayMs)
  process.exit(0)
})

async function handleLine(line) {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (process.env.MOCK_PROTOCOL_LOG) {
    appendFileSync(process.env.MOCK_PROTOCOL_LOG, `${message.method ?? 'response'}:${message.id ?? ''}\n`, { mode: 0o600 })
  }
  // MOCK_REQUEST_LOG records the PARAMS the companion actually sent, which
  // MOCK_PROTOCOL_LOG (method:id only) cannot show. Kept as a separate file
  // rather than widening the protocol log, because a dozen existing tests read
  // that one by string match and a format change would move all of them.
  if (process.env.MOCK_REQUEST_LOG && message.method) {
    appendFileSync(process.env.MOCK_REQUEST_LOG,
      `${JSON.stringify({ method: message.method, params: message.params ?? null })}\n`, { mode: 0o600 })
  }
  if (mockPendingResponses.has(message.id) && !message.method) {
    const resolve = mockPendingResponses.get(message.id)
    mockPendingResponses.delete(message.id)
    resolve(message)
    return undefined
  }
  // A permission request the mock deliberately raises AFTER `session/cancel`.
  // ACP v1 obliges the CLIENT to answer it with the `cancelled` outcome; the
  // whole point of this path is to record what it actually answered, so the
  // test can tell a MUST being met from a MUST being skipped.
  if (message.id === CANCEL_PERMISSION_REQUEST_ID && !message.method) {
    const outcome = message.result?.outcome
    writeFileSync(join(process.cwd(), '.permission-after-cancel'),
      `${outcome?.outcome ?? 'none'}:${outcome?.optionId ?? ''}\n`, { mode: 0o600 })
    return undefined
  }
  if (pendingPermissionPrompt && message.id === PERMISSION_REQUEST_ID && !message.method) {
    const outcome = message.result?.outcome
    if (outcome?.outcome === 'selected') permissionDecision = outcome.optionId
    else permissionDecision = 'cancelled'
    const prompt = pendingPermissionPrompt
    pendingPermissionPrompt = null
    return void handlePrompt(prompt)
  }
  switch (message.method) {
    case 'initialize':
      if (process.env.MOCK_SCENARIO === 'startup-stall' && process.env.MOCK_STALL_STAGE === 'initialize') return
      await waitForMockGate('initialize')
      return reply(message.id, {
        protocolVersion: 1,
        agentInfo: agentInfo(),
        agentCapabilities: { loadSession: process.env.MOCK_NO_LOAD !== '1' },
      })
    case 'session/new':
      if (process.env.MOCK_SCENARIO === 'startup-stall' && process.env.MOCK_STALL_STAGE === 'new') return
      await waitForMockGate('new')
      currentSessionId = process.env.MOCK_SESSION_ID ?? 'sess_mock'
      if (envNumber('MOCK_NEW_DELAY_MS', 0) > 0) {
        return setTimeout(() => reply(message.id, { sessionId: currentSessionId, ...identity() }), envNumber('MOCK_NEW_DELAY_MS', 0))
      }
      return reply(message.id, { sessionId: currentSessionId, ...identity() })
    case 'session/load':
      if (process.env.MOCK_SCENARIO === 'startup-stall' && process.env.MOCK_STALL_STAGE === 'load') return
      await waitForMockGate('load-response')
      if (process.env.MOCK_LOAD_ERROR === '1') return replyError(message.id, 'mock load failed')
      currentSessionId = 'sess_prev'
      notify({ sessionUpdate: 'user_message_chunk', messageId: 'history-user', content: { type: 'text', text: '(previous request)' } })
      notify({ sessionUpdate: 'agent_message_chunk', messageId: 'history-agent', content: { type: 'text', text: '(replayed history)' } })
      return reply(message.id, {
        ...(process.env.MOCK_LOAD_RESPONSE_SESSION_ID && process.env.MOCK_LOAD_RESPONSE_SESSION_ID !== 'omit'
          ? { sessionId: process.env.MOCK_LOAD_RESPONSE_SESSION_ID }
          : {}),
        ...identity(),
      })
    case 'session/set_config_option': {
      if (process.env.MOCK_SET_CONFIG_ERROR === '1') return replyError(message.id, 'mock config update failed')
      if (process.env.MOCK_CONFIG_IDENTITY !== '1') return replyError(message.id, 'mock config options unavailable')
      const configId = message.params?.configId
      const value = message.params?.value
      const current = identity().configOptions?.find((option) => option.id === configId)
      // In strict mode the mock behaves like antigravity-acp 1.0.0: it
      // advertises label-suffixed values but session/set_config_option
      // accepts the bare id and reports it back bare.
      const advertised = (option) => option.value === value
        || (process.env.MOCK_MODEL_OPTIONS_STRICT === '1'
          && typeof option.value === 'string' && option.value.split('\t')[0] === value)
      if (!current || typeof value !== 'string' || !current.options.some(advertised)) {
        return replyError(message.id, `mock rejected ${configId}`)
      }
      if (configId === 'model') configuredModel = value
      if (configId === 'reasoning_effort') configuredReasoningEffort = value
      return reply(message.id, identity())
    }
    case 'session/prompt':
      await waitForMockGate('prompt')
      if (process.env.MOCK_ASSERT_RECEIPT_BEFORE_PROMPT === '1') {
        const receiptDir = join(process.cwd(), '.tmux-teams', 'receipts')
        const receiptSeen = existsSync(receiptDir) && readdirSync(receiptDir).some((name) => name.endsWith('.json'))
        writeFileSync(join(process.cwd(), '.prompt-receipt-seen'), `${receiptSeen}\n`, { mode: 0o600 })
      }
      return void handlePrompt(message)
    case 'session/cancel':
      cancelSeen = true
      writeFileSync(join(process.cwd(), '.cancel-seen'), `${Date.now()}\n`, { mode: 0o600 })
      if (process.env.MOCK_PERMISSION_AFTER_CANCEL === '1') {
        send({
          jsonrpc: '2.0',
          id: CANCEL_PERMISSION_REQUEST_ID,
          method: 'session/request_permission',
          params: {
            sessionId: currentSessionId,
            toolCall: { title: 'tool raised after cancel' },
            options: [
              { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' },
              { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
            ],
          },
        })
      }
      if (process.env.MOCK_SCENARIO === 'exit-during-cancel') return process.exit(0)
      if (process.env.MOCK_SCENARIO === 'cancel-clean-exit') {
        return setTimeout(() => process.exit(0), envNumber('MOCK_EXIT_DELAY_MS', 5))
      }
      if (process.env.MOCK_SCENARIO === 'cancel-race-exit-7') {
        raceHolder = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${envNumber('MOCK_RACE_HOLDER_MS', 100)})`], {
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        return setTimeout(() => process.exit(7), envNumber('MOCK_EXIT_DELAY_MS', 0))
      }
      if (process.env.MOCK_SCENARIO === 'cancel-exit-7') {
        return setTimeout(() => process.exit(7), envNumber('MOCK_EXIT_DELAY_MS', 5))
      }
      if (process.env.MOCK_CANCEL_RESPOND === '1') {
        reply(message.id, { cancelled: true })
        if (process.env.MOCK_SCENARIO === 'cancel-ack') {
          return setTimeout(() => process.exit(0), envNumber('MOCK_EXIT_DELAY_MS', 5))
        }
        return undefined
      }
      return undefined
    default:
      return undefined
  }
}

writeFileSync(join(process.cwd(), '.initial-agent-mode'), `${process.env.INITIAL_AGENT_MODE ?? ''}\n`, { mode: 0o600 })
// PRESENCE only, never the value: the point of the allowlist is that a lane's
// adapter cannot see another lane's credential, and a test that wrote the
// secret out to prove it would be the leak it is checking for.
writeFileSync(join(process.cwd(), '.adapter-env.json'), JSON.stringify(Object.fromEntries(
  ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'PATH', 'ACP_AGENT_ID']
    .map((key) => [key, key in process.env]),
)), { mode: 0o600 })
