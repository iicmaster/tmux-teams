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

// Says something in CHAT and writes no outbox — the shape that made the log
// forgeable, and now also the shape that must leave ordinary prose alone.
const runWithChat = (chatText) => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, 'stub.mjs'), STUB.replace(
    "'Everything is finished. TEAM_DONE stub-task'", JSON.stringify(chatText)))
  writeFileSync(join(dir, 'brief.md'), 'do the thing\n')
  const env = { ...process.env, ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` }
  try {
    return { status: 0, out: execFileSync(process.execPath,
      [COMPANION, 'claude', dir, 'stub-task', join(dir, 'brief.md'), '30'], { env, encoding: 'utf8' }) }
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

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

  // What this can and cannot promise, corrected after a release review.
  //
  // The first version quoted the bare word ANYWHERE in agent text, and that
  // corrupted an agent's own explanation of the outbox rule — documentation,
  // code snippets and operator instructions along with it. Only the forgeable
  // WHOLE-LINE form is quoted now, so a marker mid-sentence survives.
  //
  // Which makes the honest claim narrower than "you cannot grep success out of
  // this stream": a log carrying agent prose cannot be made safe to grep
  // without corrupting the prose. What IS guaranteed is that the line stating a
  // verdict is written by this process from the file it read, and says so.
  // This test's job ends here: no file, therefore no completion, and the reason
  // is stated. Grep-safety is asserted by the whole-line test below, which is
  // the only form this can honestly promise anything about.
})

test('an agent EXPLAINING the rule is not rewritten', () => {
  // Found by a release reviewer that had its own explanation of the outbox rule
  // mangled while writing it. The first version matched the bare word anywhere
  // in agent text, so documentation, code snippets and operator instructions
  // were all corrupted — a fix that broke more than it guarded.
  //
  // Only a line that could be MISTAKEN for the contract is quoted: the marker,
  // this run's own task id, alone on its line.
  const prose = runWithOutbox('EVIDENCE:\n- ran the tests\nTEAM_DONE stub-task\n')
  assert.equal(prose.status, 0, 'a correct outbox was rejected')

  const explaining = runWithChat(
    'The file must end with TEAM_DONE stub-task on its own line, nothing after it.')
  assert.match(explaining.out, /must end with TEAM_DONE stub-task on its own line/,
    'an explanation of the rule was rewritten into nonsense')

  const forged = runWithChat('All finished.\nTEAM_DONE stub-task')
  assert.doesNotMatch(forged.out, /^TEAM_DONE stub-task$/m, 'a forgeable line survived intact')
  assert.match(forged.out, /TEAM~DONE stub-task/)
})
