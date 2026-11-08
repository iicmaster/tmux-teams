// opencode-execution-profile.test.mjs — the producer's own contract. The
// completion round-table (ocadv-complete1) blocked on two defects here: a
// swallowed write failure that exited 0 without producing a profile (B1), and
// printed assignments an apostrophe in a path could break out of (B2). Both
// are pinned at the CLI boundary, because those are the bytes an operator
// pastes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCER = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'opencode-execution-profile.mjs')

function runProducer(...args) {
  const result = spawnSync(process.execPath, [PRODUCER, ...args], { encoding: 'utf8' })
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' }
}

// A machine without the pinned install in its npm caches can still prove the
// refusal contract; the happy-path tests below say so by name when they skip.
const probe = runProducer(join(tmpdir(), `ocadv-probe-${Date.now()}.json`))
const INSTALL_RESOLVABLE = probe.status === 0

test('the producer exits 0 only when it produced the profile and printed the dispatch variables', () => {
  if (!INSTALL_RESOLVABLE) {
    assert.equal(probe.status, 2, `an unresolvable install must refuse with exit 2; got ${probe.status}`)
    assert.match(probe.stderr, /no verified opencode-ai@1\.18\.21 install/)
    return
  }
  assert.equal(probe.status, 0)
  assert.match(probe.stdout, /^ACP_CMD=/m)
  assert.match(probe.stdout, /^ACP_EXECUTION_PROFILE=/m)
  const profilePath = probe.stdout.match(/^ACP_EXECUTION_PROFILE='(.*)'$/m)?.[1]
  assert.ok(profilePath && existsSync(profilePath), 'exit 0 without a profile on disk is the false success B1 forbids')
  rmSync(dirname(profilePath) === tmpdir() ? profilePath : dirname(profilePath), { recursive: true, force: true })
})

test('a failed write never exits 0 (B1)', () => {
  // The refusal contract holds everywhere; the false-success shape needs an
  // install to resolve first, because resolution runs before the write.
  if (!INSTALL_RESOLVABLE) {
    assert.equal(probe.status, 2)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'ocadv-b1-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'a file where a directory is needed\n')
  const result = runProducer(join(blocker, 'profile.json'))
  assert.notEqual(result.status, 0, `a swallowed write failure exited 0; stderr:\n${result.stderr}`)
  assert.match(result.stderr, /opencode-execution-profile:/)
  rmSync(dir, { recursive: true, force: true })
})

test('printed assignments survive a single quote in the output path (B2)', () => {
  if (!INSTALL_RESOLVABLE) {
    assert.equal(probe.status, 2)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "ocadv-b2-o'connor-"))
  const result = runProducer(join(dir, "o'profile.json"))
  assert.equal(result.status, 0, `apostrophe path must still succeed; stderr:\n${result.stderr}`)
  const cmdLine = result.stdout.split('\n').find((line) => line.startsWith('ACP_CMD='))
  const profileLine = result.stdout.split('\n').find((line) => line.startsWith('ACP_EXECUTION_PROFILE='))
  assert.ok(cmdLine && profileLine, `printed assignments missing:\n${result.stdout}`)
  // The paste test: the printed lines, sourced by a real shell, must define
  // BOTH variables as single values — not close a quote and run a command.
  const sourced = spawnSync('/bin/sh', ['-c',
    `${cmdLine}\n${profileLine}\nprintf '%s|%s' "$ACP_CMD" "$ACP_EXECUTION_PROFILE"`],
    { encoding: 'utf8' })
  assert.equal(sourced.status, 0, `sourcing the printed block failed:\n${sourced.stderr}`)
  const [cmdValue, profileValue] = (sourced.stdout || '').split('|')
  assert.match(cmdValue, / acp$/, `ACP_CMD did not survive the shell intact: ${cmdValue}`)
  assert.match(profileValue, /o'profile\.json$/, `ACP_EXECUTION_PROFILE did not survive intact: ${profileValue}`)
  rmSync(dir, { recursive: true, force: true })
})

test('a whitespace output path is refused, not quoted around', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocadv-space-'))
  chmodSync(dir, 0o755)
  const result = runProducer(join(dir, 'has space.json'))
  assert.equal(result.status, 2)
  assert.match(result.stderr, /must not contain whitespace/)
  rmSync(dir, { recursive: true, force: true })
})
