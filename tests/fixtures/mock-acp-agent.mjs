// Deterministic ACP agent used by the companion and phase-gate tests.
// It deliberately exercises startup, long-running tools, duplicate/noise
// updates, cancellation, identity, and descendant-process cleanup paths.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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

if (process.env.MOCK_SCENARIO === 'cancel-sigterm-exit-zero') {
  process.on('SIGTERM', () => process.exit(0))
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const envNumber = (name, fallback) => {
  const number = Number(process.env[name])
  return Number.isFinite(number) && number >= 0 ? number : fallback
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
    if (!modelOptions.includes(model)) modelOptions.unshift(model)
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
  writeFileSync(join(process.cwd(), '.descendant-pid'), `${descendant.pid}\n`, { mode: 0o600 })
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
  writeFileSync(join('.mailbox-out', id), `${did}\n${envelope}${evidence}${verdictBlock}${marker}\n`, { mode: 0o600 })
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
      if (!current || typeof value !== 'string' || !current.options.some((option) => option.value === value)) {
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
