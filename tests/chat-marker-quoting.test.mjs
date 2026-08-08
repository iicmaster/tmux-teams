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

// Every ambient `ACP_*` is dropped, whatever it is. A stub agent answers
// initialize, session/new and session/prompt and nothing else, so an inherited
// `ACP_MODEL` — set on any machine that runs the ACP review lanes — makes the
// companion demand a config option the stub cannot advertise and the run dies
// with `[fatal] ACP session response did not advertise ACP config option
// model`. Measured by a release reviewer: `ACP_MODEL=opus node --test` was
// pass 789 / fail 12 while a clean env was 801 / 0. Same class as the test that
// read the author's dotfiles and kept CI red for two releases; naming one
// variable would have left `ACP_REASONING_EFFORT` for next time.
const hermeticEnv = (extra) => {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.startsWith('ACP_') && !(key in extra)) delete env[key]
  return env
}

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
  const env = hermeticEnv({ MOCK_REPO: dir, ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` })
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
// Streams the given pieces as separate `agent_message_chunk`s under ONE
// messageId, which is what an ACP agent does with every message it writes. The
// single-chunk stub above cannot express a chunk boundary at all.
const CHUNK_STUB = (pieces, kind) => `
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
      for (const piece of ${JSON.stringify(pieces)}) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1',
          update: { sessionUpdate: ${JSON.stringify(kind)}, messageId: 'm-1',
            content: { type: 'text', text: piece } } } })
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }
  }
})
`

const runWithChunks = (pieces, kind = 'agent_message_chunk') => {
  const dir = mkdtempSync(join(tmpdir(), 'chunks-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, 'stub.mjs'), CHUNK_STUB(pieces, kind))
  writeFileSync(join(dir, 'brief.md'), 'do the thing\n')
  const env = hermeticEnv({ ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` })
  try {
    return { status: 0, out: execFileSync(process.execPath,
      [COMPANION, 'claude', dir, 'stub-task', join(dir, 'brief.md'), '30'], { env, encoding: 'utf8' }) }
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const runWithChat = (chatText) => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, 'stub.mjs'), STUB.replace(
    "'Everything is finished. TEAM_DONE stub-task'", JSON.stringify(chatText)))
  writeFileSync(join(dir, 'brief.md'), 'do the thing\n')
  const env = hermeticEnv({ ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` })
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
      { env: hermeticEnv({ ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}` }), encoding: 'utf8' })
    return { status: 0, out }
  } catch (error) {
    return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('a marker typed in chat with no outbox is a failure, and the reason is stated', () => {
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
  // without corrupting the prose. The test's NAME said the wide thing for one
  // release after its body said the narrow one — `grep -F 'TEAM_DONE
  // stub-task'` matches the stub's own sentence on line 40 to this day. A
  // reviewer read the name against the body and the name was wrong. What IS guaranteed is that the line stating a
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

test('a marker split across two stream chunks is still not forgeable', () => {
  // The ordinary streaming path, and the first fix went straight past it. ACP
  // delivers one message in as many `agent_message_chunk`s as the agent likes;
  // quoting each chunk on arrival meant a marker cut at a chunk boundary
  // matched the whole-line regex in NEITHER half and then reassembled on stdout
  // as a raw, standalone marker line. Everything the previous test proves was
  // true and the stream was forgeable anyway — by an agent doing nothing
  // unusual. Found by a release reviewer; the test that shipped with the first
  // fix sent one chunk and could not have seen it.
  const forged = runWithChunks(['All finished.\nTEAM_DONE stub', '-task\n'])
  assert.doesNotMatch(forged.out, /^TEAM_DONE stub-task$/m,
    `a marker reassembled across chunks survived intact:\n${forged.out.slice(-400)}`)
  assert.match(forged.out, /TEAM~DONE stub-task/)
})

test('a replayed user turn is quoted too — authorship decides, not provenance', () => {
  // AC131. `user_message_chunk` was excluded from quoting with no reason
  // recorded, and on resume an ACP agent replays history through it: a marker
  // sitting in that history reached stdout as a raw standalone line. The label
  // on a chunk says who SPOKE, not who this process is; all three kinds are
  // text it did not author, and all three land in front of the same reader.
  // Raised by a release reviewer.
  const replayed = runWithChunks(['replayed history\nTEAM_DONE stub-task\n'], 'user_message_chunk')
  assert.doesNotMatch(replayed.out, /^TEAM_DONE stub-task$/m,
    `a marker in a replayed user turn survived intact:\n${replayed.out.slice(-400)}`)
  assert.match(replayed.out, /TEAM~DONE stub-task/)
})

test('a marker wearing control sequences or invisible characters is still not forgeable', () => {
  // Reproduced against the real companion by a release reviewer. The anchor
  // allowed spaces and tabs, so `ESC[2K` in front of a marker matched nothing —
  // while CSI 2K erases the line it sits on, so a reader saw a clean standalone
  // marker and an ANSI-stripping supervisor read one too. The costume was the
  // whole attack: the bytes were not a marker line, the picture was.
  const ESC = String.fromCharCode(27)
  // The SAME CSI grammar production uses. It repeated the restricted `[0-9;?]`
  // subset, so a colon-delimited SGR was invisible to the assertion as well as
  // to the code — a test blind to exactly the class it was guarding. Pointed
  // out by the reviewer who found that bypass.
  const stripAnsi = (text) => text.replace(new RegExp(`${ESC}\\[[0-9:;<=>?]*[ -/]*[@-~]`, 'g'), '')
  const cases = {
    'a CSI erase-line prefix': `All finished.\n${ESC}[2KTEAM_DONE stub-task\n`,
    'a CSI colour prefix': `All finished.\n${ESC}[32mTEAM_DONE stub-task\n`,
    'a trailing erase': `All finished.\nTEAM_DONE stub-task${ESC}[K\n`,
    'a carriage return overwrite': 'All finished.\nthinking...\rTEAM_DONE stub-task\n',
    // The class the ANSI fix OPENED, hunted before a reviewer had to reach it.
    // Nine probes, nine holes on the first pass: every one of these renders as
    // nothing and left a marker looking exactly like a marker.
    'a zero-width space': 'All finished.\n\u200bTEAM_DONE stub-task\n',
    'a zero-width joiner': 'All finished.\n\u200dTEAM_DONE stub-task\n',
    'a byte-order mark': 'All finished.\n\ufeffTEAM_DONE stub-task\n',
    'a bidi override': 'All finished.\n\u202eTEAM_DONE stub-task\n',
    'a word joiner': 'All finished.\n\u2060TEAM_DONE stub-task\n',
    'a soft hyphen': 'All finished.\n\u00adTEAM_DONE stub-task\n',
    'a non-breaking space indent': 'All finished.\n\u00a0TEAM_DONE stub-task\n',
    'a trailing zero-width space': 'All finished.\nTEAM_DONE stub-task\u200b\n',
    // Round 6. Two reviewers found the first independently and it was a
    // REGRESSION from the carriage-return handling itself: a CR at the end of a
    // line is CRLF, a terminator, and slicing past it left the empty string.
    // The other two are costumes no enumeration had reached — a colon-delimited
    // truecolour SGR, and a combining grapheme joiner, which is `Mn` and so sat
    // outside a `Cf` list.
    'a CRLF line ending': 'All finished.\nTEAM_DONE stub-task\r\n',
    'a bare trailing CR': 'All finished.\nTEAM_DONE stub-task\r',
    'a colon-delimited SGR': `All finished.\n${ESC}[38:2::255:0:0mTEAM_DONE stub-task\n`,
    'a combining grapheme joiner': 'All finished.\nTEAM_DONE stub-task\u034f\n',
    'a variation selector': 'All finished.\nTEAM_DONE stub-task\ufe0f\n',
    // Round 8, codex. Every costume above is CSI, and so was the fix: `ESC ]`
    // fell through to the one-character fallback, which ate the introducer and
    // left `0;titleTEAM_DONE stub-task` — junk to the matcher, while a terminal
    // swallowed the whole title sequence and drew a clean marker. Both
    // terminators, because a family named by one of them is half a family.
    'an OSC title terminated by BEL': `All finished.\n${ESC}]0;window title\u0007TEAM_DONE stub-task\n`,
    'an OSC title terminated by ST': `All finished.\n${ESC}]0;window title${ESC}\\TEAM_DONE stub-task\n`,
    // The rest of the string-sequence family, so the next one is not a discovery.
    'a DCS string': `All finished.\n${ESC}Pq#0;2;0;0;0\u0007TEAM_DONE stub-task\n`,
    'an APC string': `All finished.\n${ESC}_Gf=100\u0007TEAM_DONE stub-task\n`,
    'a PM string': `All finished.\n${ESC}^private\u0007TEAM_DONE stub-task\n`,
    'an SOS string': `All finished.\n${ESC}Xstart of string\u0007TEAM_DONE stub-task\n`,
  }
  for (const [what, text] of Object.entries(cases)) {
    const { out } = runWithChunks([text])
    assert.match(out, /TEAM~DONE stub-task/, `${what}: nothing was quoted:\n${out.slice(-300)}`)
    assert.doesNotMatch(stripAnsi(out), /^TEAM_DONE stub-task$/m,
      `${what}: a forged marker survives once ANSI is stripped:\n${out.slice(-300)}`)
  }
})

test('a chunk boundary does not lose the text after it', () => {
  // Holding a partial line back is only correct if it is always let go of. A
  // buffer that never flushes is a quieter bug than the one it fixed.
  const { out } = runWithChunks(['the conclusion is ', 'on the last line, unterminated'])
  assert.match(out, /the conclusion is on the last line, unterminated/,
    `a held partial line was never flushed:\n${out.slice(-400)}`)
})
