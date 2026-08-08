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

// A stub that writes an outbox whose CONTENT the caller chooses. #53 is about
// what the companion says when that content is not a valid terminal.
const OUTBOX_STUB = (body) => `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
      writeFileSync(join(process.env.MOCK_REPO, '.mailbox-out', 'stub-task'), ${JSON.stringify(body)})
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }
  }
})
`

const runWithOutbox = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'marker53-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, 'stub.mjs'), OUTBOX_STUB(body))
  writeFileSync(join(dir, 'brief.md'), 'do the thing\n')
  const env = { ...process.env, MOCK_REPO: dir, ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` }
  try {
    return { status: 0, out: execFileSync(process.execPath,
      [COMPANION, 'claude', dir, 'stub-task', join(dir, 'brief.md'), '30'], { env, encoding: 'utf8' }) }
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('a misplaced marker says WHERE it is and what the rule is', () => {
  // GitHub #53. A worker wrote `TEAM_DONE <id>` and then an EVIDENCE block after
  // it. The only diagnostic was the quoted last line — a fragment of its own
  // evidence — so it could not learn that the marker must come last, and the
  // same delivery was retried twice before a human read the file and said so.
  const { status, out } = runWithOutbox('did the work\nTEAM_DONE stub-task\nEVIDENCE:\n- ran the tests\n')

  assert.notEqual(status, 0, 'a misplaced marker was accepted')
  assert.match(out, /line 2 of 4/, `it did not say WHERE the marker is:\n${out.slice(-300)}`)
  assert.match(out, /must be the LAST non-empty line/, 'it did not state the rule the worker has to learn')
  assert.match(out, /EVIDENCE and every other section belongs BEFORE it/)
})

test('a marker for another task is not reported as a missing one', () => {
  // The distinction the parser could not draw at all: a marker that IS there,
  // naming the wrong run, is an id mistake — telling that worker "no marker
  // anywhere" sends it to fix something that is not broken.
  const { out } = runWithOutbox('work\nTEAM_DONE some-other-task\n')
  assert.match(out, /marker for a different task/)
  assert.match(out, /this run is stub-task/)
})

test('no marker at all says exactly that', () => {
  const { out } = runWithOutbox('I finished everything, honestly.\n')
  assert.match(out, /no TEAM_DONE\/TEAM_BLOCKED\/TEAM_FAILED stub-task line anywhere/)
})

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
