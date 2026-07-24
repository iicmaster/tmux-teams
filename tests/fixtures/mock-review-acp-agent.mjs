// ACP-only fixture for review-gate tests.  It never touches a repository and
// has switches for deliberately hostile protocol behaviour.
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'review-session', update: value } })
const behaviour = process.env.MOCK_REVIEW_BEHAVIOUR ?? 'ok'
const expectedModel = process.env.MOCK_REVIEW_MODEL ?? 'review-model'
const log = value => { if (process.env.MOCK_REVIEW_LOG) process.stderr.write(`LOG:${value}\n`) }

function review() {
  if (behaviour === 'bad-review') return 'not json'
  if (behaviour === 'escaped-secret-review') {
    return '{"schema_version":1,"verdict":"PASS","assessment":"Bearer\\u0020abcdefghijklmnopqrstuvwxyz123456 must never be returned by a reviewer.","findings":[],"residual_risks":[]}'
  }
  if (behaviour === 'plain-secret-review') {
    return JSON.stringify({
      ...validReview,
      assessment: 'DB_PASSWORD=hunter2 must never be returned by a reviewer.',
    })
  }
  if (behaviour === 'url-secret-review') {
    return JSON.stringify({
      ...validReview,
      assessment: 'DATABASE_URL=postgresql://app:supersecret@db/prod and NPM_AUTH=dXNlcjpwYXNz must never be returned.',
    })
  }
  if (behaviour === 'schema-only') return JSON.stringify(validReview)
  let targetMarkerVisible
  let targetWriteSucceeded
  if (behaviour === 'sandbox-probe') {
    const marker = process.env.MOCK_TARGET_MARKER
    targetMarkerVisible = Boolean(marker && existsSync(marker) && readFileSync(marker, 'utf8') === 'host-secret-marker')
    try {
      writeFileSync(marker, 'sandbox-overwrite')
      targetWriteSucceeded = true
    } catch {
      targetWriteSucceeded = false
    }
  }
  return JSON.stringify({
    ...validReview,
    cwd: process.cwd(),
    model: expectedModel,
    leaked: process.env.SUPER_SECRET ?? null,
    sawRawSecret: promptText.includes('never-forward'),
    sawBearerSecret: promptText.includes('abcdefghijklmnopqrstuvwxyz123456'),
    toolsDisabled,
    ...(behaviour === 'sandbox-probe' ? { targetMarkerVisible, targetWriteSucceeded } : {}),
    ...(behaviour === 'safe-workspace-read' ? { workspaceEntries } : {}),
  })
}
function finish(id) {
  if (behaviour === 'response-then-exit-7') {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'review-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'only-current-turn',
          content: { type: 'text', text: review() },
        },
      },
    })
    const response = JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    process.stdout.write(`${message}\n${response}\n`, () => process.exit(7))
    return
  }
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'only-current-turn', content: { type: 'text', text: review() } })
  reply(id, { stopReason: 'end_turn' })
  if (behaviour === 'response-then-invalid') {
    send({ jsonrpc: '2.0', method: 'forbidden/notification', params: {} })
  }
}

let permissionPrompt
let promptText = ''
let toolsDisabled = false
let workspaceEntries = []
const validReview = {
  schema_version: 1,
  verdict: 'PASS',
  assessment: 'The supplied static evidence satisfies the stated criteria.',
  findings: [],
  residual_risks: [],
}
const rl = createInterface({ input: process.stdin })
rl.on('line', raw => {
  const m = JSON.parse(raw)
  if (permissionPrompt && m.id === 'deny-me' && !m.method) {
    const outcome = m.result?.outcome
    if (outcome?.outcome !== 'selected' || outcome.optionId !== 'reject-always') process.exitCode = 9
    else finish(permissionPrompt.id)
    permissionPrompt = undefined
    return
  }
  switch (m.method) {
    case 'initialize':
      if (behaviour === 'malformed') return process.stdout.write('{bad json\n')
      return reply(m.id, { protocolVersion: 1, configOptions: [
        { id: 'model', currentValue: behaviour === 'model-mismatch' || behaviour === 'ack-mismatch' ? 'wrong-model' : expectedModel },
        { id: 'mode', currentValue: 'plan' },
      ] })
    case 'session/new':
      toolsDisabled = m.params?._meta?.disableBuiltInTools === true &&
        Array.isArray(m.params?._meta?.claudeCode?.options?.tools) &&
        m.params._meta.claudeCode.options.tools.length === 0 &&
        Array.isArray(m.params?.mcpServers) &&
        m.params.mcpServers.length === 0
      if (behaviour === 'replay') update({ sessionUpdate: 'agent_message_chunk', messageId: 'old', content: { type: 'text', text: '{"old":true}' } })
      if (behaviour === 'pre-prompt-tool-call') update({
        sessionUpdate: 'tool_call',
        toolCallId: 'forbidden-before-prompt',
        title: 'read file before prompt',
        status: 'in_progress',
      })
      return reply(m.id, { sessionId: 'review-session', configOptions: [] })
    case 'session/set_config_option':
      log(`config:${m.params.configId}=${m.params.value}`)
      return reply(m.id, { configOptions: [
        { id: m.params.configId, currentValue: behaviour === 'ack-mismatch' ? 'not-acknowledged' : m.params.value },
      ] })
    case 'session/cancel':
      log('cancel')
      return
    case 'session/prompt':
      log('prompt')
      promptText = (m.params.prompt ?? []).map(p => p.text ?? '').join('')
      if (behaviour === 'tool-call') {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'review-session',
          update: { sessionUpdate: 'tool_call', toolCallId: 'forbidden', title: 'read file', status: 'in_progress' },
        } })
        return
      }
      if (behaviour === 'think-update') {
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-think-1',
          title: 'Think',
          kind: 'think',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'bounded reasoning status' } }],
        })
        return finish(m.id)
      }
      if (behaviour === 'safe-runtime-read') {
        const path = process.env.MOCK_SAFE_RUNTIME_PATH
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-runtime-read-1',
          title: 'Read provider runtime guide',
          kind: 'read',
          status: 'completed',
          locations: [{ path, line: 1 }],
          rawInput: { AbsolutePath: path, StartLine: 1, EndLine: 10 },
          content: [{ type: 'content', content: { type: 'text', text: 'provider runtime documentation' } }],
        })
        return finish(m.id)
      }
      if (behaviour === 'safe-workspace-read') {
        workspaceEntries = readdirSync(process.cwd())
        const variant = process.env.MOCK_SAFE_WORKSPACE_VARIANT
        let location = process.env.MOCK_SAFE_WORKSPACE_LOCATION ?? process.cwd()
        let locations = [{ path: location }]
        let rawInput = { DirectoryPath: location, toolAction: 'Listing workspace directory' }
        if (variant === 'relative-escape') {
          rawInput = { ...rawInput, DirectoryPath: '../provider-state/agy/home/.gemini/antigravity-cli/antigravity-oauth-token' }
        }
        if (variant === 'child') {
          location = join(process.cwd(), 'child')
          locations = [{ path: location }]
          rawInput = { ...rawInput, DirectoryPath: location }
        }
        if (variant === 'symlink' || variant === 'symlink-parent') {
          location = join(process.cwd(), 'outside-link')
          symlinkSync('/etc', location, 'dir')
          if (variant === 'symlink-parent') location = `${location}/..`
          locations = [{ path: location }]
          rawInput = { ...rawInput, DirectoryPath: location }
        }
        if (variant === 'symlink-root' || variant === 'symlink-guide') {
          location = join(process.cwd(), `${variant}-alias`)
          const target = variant === 'symlink-root'
            ? process.cwd()
            : join(process.cwd(), 'REVIEW_STATIC_PACKET_ONLY.md')
          symlinkSync(target, location, variant === 'symlink-root' ? 'dir' : 'file')
          locations = [{ path: location }]
          rawInput = { ...rawInput, DirectoryPath: location }
        }
        if (variant === 'runtime-inward') {
          location = process.env.MOCK_SAFE_RUNTIME_ALIAS
          locations = [{ path: location }]
          rawInput = { AbsolutePath: location, StartLine: 1, EndLine: 10 }
        }
        if (variant === 'parent-location') {
          location = dirname(process.cwd())
          locations = [{ path: location }]
          rawInput = { ...rawInput, DirectoryPath: location }
        }
        if (variant === 'mixed') {
          locations = [{ path: process.cwd() }, { path: process.env.MOCK_SAFE_RUNTIME_PATH }]
        }
        if (variant === 'nested') {
          rawInput = { ...rawInput, options: { path: '../provider-state' } }
        }
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-workspace-read-1',
          title: 'List neutral workspace',
          kind: 'read',
          status: 'completed',
          locations,
          rawInput,
          content: [{ type: 'content', content: { type: 'text', text: 'neutral workspace listing' } }],
        })
        return finish(m.id)
      }
      if (behaviour === 'safe-workspace-sentinel-read') {
        const path = join(process.cwd(), 'REVIEW_STATIC_PACKET_ONLY.md')
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-workspace-guide-read-1',
          title: 'Read static-review guide',
          kind: 'read',
          status: 'completed',
          locations: [{ path, line: 1 }],
          rawInput: { AbsolutePath: path, StartLine: 1, EndLine: 20 },
          content: [{ type: 'content', content: { type: 'text', text: 'static packet review only' } }],
        })
        return finish(m.id)
      }
      if (behaviour === 'wrong-session') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"wrong":true}' } } } })
        return
      }
      if (behaviour === 'hang' || behaviour === 'late') {
        if (behaviour === 'late') setTimeout(() => finish(m.id), 120)
        return
      }
      if (behaviour === 'permission') {
        permissionPrompt = m
        return send({ jsonrpc: '2.0', id: 'deny-me', method: 'session/request_permission', params: { sessionId: 'review-session', options: [
          { optionId: 'reject-always', kind: 'reject_always' }, { optionId: 'allow-always', kind: 'allow_always' },
        ] } })
      }
      return finish(m.id)
  }
})
