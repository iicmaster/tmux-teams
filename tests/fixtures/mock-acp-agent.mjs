// A minimal ACP agent for exercising acp-companion.mjs end to end without a real
// model. It speaks the same line-delimited JSON-RPC the companion expects, emits
// one of every session/update variant, and writes the outbox the mailbox
// contract requires. Driven via ACP_CMD="node <this file>".
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const notify = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } })
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const PERMISSION_REQUEST_ID = 'mock-permission-request'
let pendingPermissionPrompt = null
let expectedPermissionDecision = null

if (process.env.MOCK_EXIT_EARLY === '1') process.exit(9)

function permissionOptions(scenario) {
  switch (scenario) {
    case 'empty':
      return []
    case 'prefer-once':
      return [
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ]
    case 'fallback-first':
      return [
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
      ]
    default:
      return [
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      ]
  }
}

function expectedPermission(scenario) {
  switch (scenario) {
    case 'empty': return 'cancelled'
    case 'prefer-once': return 'allow-once'
    case 'fallback-first': return 'reject-once'
    default: return 'allow-always'
  }
}

function completePrompt(m, permissionDecision = '') {
  const text = (m.params.prompt ?? []).map((p) => p.text ?? '').join('')
  const id = (text.match(/\.mailbox-out\/(\S+)/) ?? [])[1]
  notify({ sessionUpdate: 'agent_thought_chunk', messageId: 'thought-1', content: { type: 'text', text: 'weighing the options' } })
  notify({ sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'doing the work' } })
  notify({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run tests', kind: 'execute', status: 'pending' })
  notify({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'run tests', status: 'completed' })
  notify({ sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'in_progress' }] })
  const terminal = process.env.MOCK_TERMINAL ?? 'done'
  const marker = terminal === 'blocked' ? `TEAM_BLOCKED ${id}`
    : terminal === 'failed' ? `TEAM_FAILED ${id}`
    : terminal === 'invalid' ? 'TEAM_DONE wrong-id'
    : `TEAM_DONE ${id}`
  if (id && terminal !== 'missing') {
    mkdirSync('.mailbox-out', { recursive: true })
    const evidence = process.env.MOCK_EVIDENCE === '1' ? 'EVIDENCE: node --test — 1/1 pass\n' : ''
    const did = permissionDecision ? `DID: mock work; permission=${permissionDecision}\n` : 'DID: mock work\n'
    writeFileSync(join('.mailbox-out', id), `${did}${evidence}${marker}\n`)
  }
  return reply(m.id, { stopReason: 'end_turn' })
}

createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return
  const m = JSON.parse(l)
  if (m.id === PERMISSION_REQUEST_ID && m.method === undefined) {
    const outcome = m.result?.outcome
    const decision = outcome?.outcome === 'selected' ? outcome.optionId : outcome?.outcome
    if (!pendingPermissionPrompt || decision !== expectedPermissionDecision) {
      console.error(`expected ${expectedPermissionDecision} permission response, received ${JSON.stringify(m.result)}`)
      process.exit(8)
    }
    const prompt = pendingPermissionPrompt
    pendingPermissionPrompt = null
    expectedPermissionDecision = null
    return completePrompt(prompt, decision)
  }
  switch (m.method) {
    case 'initialize':
      // loadSession advertised so the resume path is reachable; MOCK_NO_LOAD
      // flips it off to exercise the graceful fallback branch.
      return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: process.env.MOCK_NO_LOAD !== '1' } })
    case 'session/new':
      return reply(m.id, { sessionId: 'sess_mock' })
    case 'session/load':
      notify({ sessionUpdate: 'user_message_chunk', messageId: 'history-user', content: { type: 'text', text: '(previous request)' } })
      notify({ sessionUpdate: 'agent_message_chunk', messageId: 'history-agent', content: { type: 'text', text: '(replayed history)' } })
      return reply(m.id, null)
    case 'session/prompt': {
      if (process.env.MOCK_HANG === '1') return
      const permissionScenario = process.env.MOCK_REQUEST_PERMISSION
      if (permissionScenario) {
        pendingPermissionPrompt = m
        expectedPermissionDecision = expectedPermission(permissionScenario)
        return send({
          jsonrpc: '2.0',
          id: PERMISSION_REQUEST_ID,
          method: 'session/request_permission',
          params: {
            sessionId: 's',
            toolCall: { toolCallId: 't-permission', title: 'write outbox' },
            options: permissionOptions(permissionScenario),
          },
        })
      }
      return completePrompt(m)
    }
  }
})
