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
// `CLAUDE_CODE_SIMPLE=1` is what `claude --bare` sets — and bare mode ALSO reads
// no OAuth and no keychain, so it is only safe for a worker whose profile
// carries a token (see the bare-mode test below). It is the lever this
// process can reach: the ACP adapter spawns the CLI itself so its argv is not
// ours, but the child environment is. That it works was MEASURED, not read off
// the help text — a project hook writing a marker file fired on a plain run and
// did not fire with the variable set.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

test('a claude worker with its own profile dir is handed the bare-mode flag; the default login is not', () => {
  // This test used to be named "handed the bare-mode flag by default" and
  // asserted '1' unconditionally. That WAS the behaviour, and it was the
  // defect: the CLI's own --help says CLAUDE_CODE_SIMPLE=1 means "OAuth and
  // keychain are never read", so the operator's default claude.ai login — whose
  // only credential is the keychain entry — was refused on every dispatch for
  // 22 days while four handoffs blamed the credential store. A green test
  // named "by default" is what let the wrong rule look intentional.
  //
  // The rule now: bare mode is the default only when CLAUDE_CONFIG_DIR names a
  // profile, because a routed profile's settings carry a token that bare mode
  // still reads. Both arms are asserted so that dropping bare mode entirely
  // fails the second and restoring the old unconditional rule fails the first.
  //
  // What is asserted is still what this process can reach — the variable the
  // child is HANDED. That the flag suppresses a project hook was measured by
  // hand with a real CLI (see the file header) and is not re-run here.
  const plain = runLane({ CLAUDE_CONFIG_DIR: '' })
  assert.equal(plain.seen, '0',
    `the default login was handed CLAUDE_CODE_SIMPLE=${plain.seen}, which forbids the only credential it has`)
  // A profile that REALLY CARRIES A TOKEN. This passed a nonexistent path and
  // asserted bare mode, which pinned "any non-empty CLAUDE_CONFIG_DIR" rather
  // than the stated rule — two review families caught the same shortcut in the
  // companion's own guard, and it lived here too.
  const withToken = mkdtempSync(join(tmpdir(), 'worker-profile-'))
  try {
    writeFileSync(join(withToken, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-not-a-real-token' } }))
    const routed = runLane({ CLAUDE_CONFIG_DIR: withToken })
    assert.equal(routed.seen, '1',
      `a routed worker was handed CLAUDE_CODE_SIMPLE=${routed.seen} and so inherits the repository hooks`)

    // And a profile with no credential must NOT get bare mode: it would read
    // neither OAuth nor keychain and be refused, which is the failure this rule
    // exists to end.
    const empty = mkdtempSync(join(tmpdir(), 'worker-profile-empty-'))
    try {
      writeFileSync(join(empty, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }))
      const isolated = runLane({ CLAUDE_CONFIG_DIR: empty })
      assert.notEqual(isolated.seen, '1',
        'a profile carrying no credential was put in bare mode, which forbids the OAuth it must fall back on')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(withToken, { recursive: true, force: true })
  }
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
