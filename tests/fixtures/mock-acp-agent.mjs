// Deterministic ACP agent used by the companion and phase-gate tests.
// It deliberately exercises startup, long-running tools, duplicate/noise
// updates, cancellation, identity, and descendant-process cleanup paths.
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, message = 'mock operation failed') => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
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
  if (scenario === 'terminal-orphan') return void runTerminalOrphanProbe(message)

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
