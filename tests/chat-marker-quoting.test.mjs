// chat-marker-quoting.test.mjs — GitHub #59.
//
// The companion has never been fooled by a marker typed in chat:
// `readTerminalOutbox` reads `.mailbox-out/<id>` and a missing file exits 3.
// Its LOG was. A worker emitted `TEAM_DONE <id>` in a message with zero tool
// calls and no outbox file, and a supervising loop grepping this stream
// reported success.
//
// The contract is the file. A stream that can be mistaken for the contract is a
// lie the contract cannot prevent, so the literal token is broken where it
// appears in agent-authored text — visibly, not silently: the reader still sees
// that a marker was typed and that it counted for nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMPANION = new URL('../plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs', import.meta.url).pathname

// A stub ACP agent: answers initialize/session/new, streams one message that
// TYPES a terminal marker, and writes no outbox at all. Exactly the shape #59
// reported — a hallucinated completion with nothing behind it.
const STUB = `
let buffer = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    if (!raw.trim()) continue
    const msg = JSON.parse(raw)
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-1' } })
    else if (msg.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
          text: 'Everything is finished. TEAM_DONE stub-task' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }
  }
})
`

const runStub = () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, 'stub.mjs'), STUB)
  writeFileSync(join(dir, 'brief.md'), 'do the thing\n')
  try {
    const out = execFileSync(process.execPath, [COMPANION, 'claude', dir, 'stub-task', join(dir, 'brief.md'), '30'],
      { env: { ...process.env, ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` }, encoding: 'utf8' })
    return { status: 0, out }
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('a marker typed in chat with no outbox is a failure, and cannot be grepped as success', () => {
  const { status, out } = runStub()

  // The half that already held: the file decides, and there is no file.
  assert.notEqual(status, 0, 'a run that wrote no outbox exited 0')
  assert.match(out, /no.?outbox|wrote no/i, `the reason was not stated: ${out.slice(-400)}`)

  // The half this test exists for. The worker typed the marker; a supervisor
  // grepping this stream must not find it.
  assert.ok(out.includes('TEAM_DONE') === false,
    `the raw marker survived into the log, so a grep still reports a hallucinated success:\n${out.slice(-400)}`)

  // Quoted, not hidden — the operator can still see what the worker claimed and
  // why it did not count. Silently deleting it would trade one confusion for
  // another.
  assert.match(out, /TEAM~DONE/, 'the marker was removed rather than quoted; the reader loses what happened')
  assert.match(out, /only the outbox file counts/)
})
