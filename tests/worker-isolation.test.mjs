// worker-isolation.test.mjs — GitHub #58.
//
// A worker spawned by the companion is a BUILD AGENT, not a continuation of
// whoever's terminal started the loop. It was inheriting both halves of that
// terminal: the target repo's `.claude/settings.json` fired its
// `UserPromptSubmit` hooks inside the worker — in this very repo that hook
// injects a party-mode persona, so a worker spent minutes playing character
// voices with zero tool calls — and the operator's `~/.claude/settings.json`
// `defaultMode: plan` started it in plan mode, where it thought 442 times and
// executed nothing.
//
// `CLAUDE_CODE_SIMPLE=1` is what `claude --bare` sets, and it is the lever this
// process can reach: the ACP adapter spawns the CLI itself so its argv is not
// ours, but the child environment is. That it works was MEASURED, not read off
// the help text — a project hook writing a marker file fired on a plain run and
// did not fire with the variable set.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// `MOCK_` is the prefix this companion's env allowlist names as the test seam
// (`ENV_PREFIXES`), so the stub can be told where to write. The first draft used
// `STUB_REPO` and the allowlist stripped it — the guard working exactly as
// designed, and a useful reminder that the child env here is not the parent's.
//
// A stub that does nothing but report the environment it was handed, then write
// a valid outbox so the companion exits cleanly. What the worker would have
// seen is exactly what this test is about.
const STUB = `
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
      writeFileSync(join(process.env.MOCK_REPO, '.mailbox-out', 'iso-task'),
        'saw CLAUDE_CODE_SIMPLE=' + (process.env.CLAUDE_CODE_SIMPLE ?? '<unset>')
        + '\\nsaw CLAUDE_CODE_MAX_OUTPUT_TOKENS=' + (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '<unset>')
        + '\\nTEAM_DONE iso-task\\n')
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    }
  }
})
`

const runLane = (extraEnv = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-'))
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, 'stub.mjs'), STUB)
  writeFileSync(join(dir, 'brief.md'), 'build the thing\n')
  const env = hermeticEnv({ MOCK_REPO: dir, ACP_CMD: `${process.execPath} ${join(dir, 'stub.mjs')}`, ...extraEnv })
  delete env.CLAUDE_CODE_SIMPLE
  Object.assign(env, extraEnv)
  const out = execFileSync(process.execPath, [COMPANION, 'claude', dir, 'iso-task', join(dir, 'brief.md'), '30'],
    { env, encoding: 'utf8' })
  // Read the OUTBOX, not the log. The companion prints the outbox path and its
  // verdict, never the bytes — which is the same distinction #59 turned on, and
  // grepping the stream for content it does not carry is how a test ends up
  // asserting `undefined !== '1'` and telling you nothing about the code.
  const outbox = readFileSync(join(dir, '.mailbox-out', 'iso-task'), 'utf8')
  return {
    out,
    seen: /saw CLAUDE_CODE_SIMPLE=(\S+)/.exec(outbox)?.[1],
    seenMaxOutput: /saw CLAUDE_CODE_MAX_OUTPUT_TOKENS=(\S+)/.exec(outbox)?.[1],
  }
}

test('a claude worker is handed the bare-mode flag by default', () => {
  // The name says what this proves and no more, after a reviewer pointed out
  // that it claimed the outcome and measured the input. What is asserted here
  // is that the child is HANDED `CLAUDE_CODE_SIMPLE=1` — the lever this process
  // can actually reach, since the ACP adapter spawns the CLI itself and its
  // argv is not ours.
  //
  // That the flag SUPPRESSES a project hook was measured separately, by hand,
  // with a hook that wrote a marker file: it fired on a plain run and did not
  // fire with the variable set (see the file header). That measurement is not
  // re-run here — it needs a real Claude CLI — so if a future release keeps
  // accepting the variable and stops honouring it, this test stays green and
  // says nothing about it. Written down because a test whose name promised the
  // behaviour would have hidden exactly that.
  const { seen } = runLane()
  assert.equal(seen, '1', `the worker was handed CLAUDE_CODE_SIMPLE=${seen}`)
})

test('an operator can put the project config back, deliberately', () => {
  // A default, not a lock. Someone may genuinely want a worker to see the
  // repo's hooks, and taking that away silently would be the same overreach in
  // the other direction.
  const { seen } = runLane({ ACP_INHERIT_PROJECT_CONFIG: '1' })
  assert.equal(seen, '<unset>', `opting back in still forced isolation (${seen})`)
})

test('the output-token ceiling an operator sets reaches the worker', () => {
  // Added 2026-08-13. A review lane thought for 21 minutes, emitted 16,500
  // thought chunks, and died on `Claude's response exceeded the 32000 output
  // token maximum` — an error whose own text names CLAUDE_CODE_MAX_OUTPUT_TOKENS
  // as the remedy. The variable was not on the claude lane allowlist, so the
  // companion stripped it and the remedy was unreachable through this path.
  //
  // This asserts the WIRING, not the ceiling: what is proven is that a value an
  // operator sets survives into the child. Whether the CLI then honours it is
  // the CLI's business and is not measured here — the same honest limit the
  // CLAUDE_CODE_SIMPLE test above states about itself.
  const { seenMaxOutput } = runLane({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })
  assert.equal(seenMaxOutput, '64000',
    `the worker was handed CLAUDE_CODE_MAX_OUTPUT_TOKENS=${seenMaxOutput}`)
})

test('the output-token ceiling is absent unless an operator sets it', () => {
  // The other half, and the half that would catch a future default sneaking in:
  // adding a name to an allowlist must not start SUPPLYING a value.
  const { seenMaxOutput } = runLane()
  assert.equal(seenMaxOutput, '<unset>',
    `an unset ceiling arrived as ${seenMaxOutput}`)
})

test('an explicit value wins over the default', () => {
  // It is on the lane allowlist, so an operator setting it survives into the
  // child. A default that silently overrode an explicit choice would be worse
  // than no default.
  const { seen } = runLane({ CLAUDE_CODE_SIMPLE: '0' })
  assert.equal(seen, '0', `an explicit CLAUDE_CODE_SIMPLE=0 was overridden with ${seen}`)
})
