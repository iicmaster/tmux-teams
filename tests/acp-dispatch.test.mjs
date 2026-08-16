import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusReport, formatStatus, resumeCommand, outboxPath, strayOutboxes }
  from '../plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
const DISPATCH = join(SCRIPTS, 'acp-dispatch.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const SKILLS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

function laneEnv(extra = {}) {
  return {
    ...process.env,
    ACP_CMD: `${process.execPath} ${MOCK}`,
    ACP_STALL_POLICY: 'cancel',
    ACP_HARD_TIMEOUT_SEC: '0',
    ACP_RESUME: '',
    ACP_DISPATCH_BOOT_SEC: '30',
    ...extra,
  }
}

function pgidOf(pid) {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
  const value = Number((r.stdout || '').trim())
  return Number.isInteger(value) && value > 0 ? value : null
}

// The failure this file exists for, reproduced. On 2026-08-17 a review lane was
// dispatched with stall 1200 into a shell capped at 600; at ten minutes the
// shell killed its process group and took the lane with it, 461 protocol events
// in and its answer unwritten. Here the caller IS that shell: it dies mid-boot
// by a SIGTERM aimed at its whole group, and the lane has to finish anyway.
test('a SIGTERM to the dispatching shell\'s process group does not reach the lane', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-group-'))
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const stageFile = join(cwd, 'stages')
  const releaseFile = join(cwd, 'release')

  // Hold the adapter at session/prompt so the lane is provably mid-turn when the
  // kill lands. The caller is already gone by then and that is not a weakness of
  // the test: the companion writes its first liveness snapshot BEFORE it spawns
  // the adapter (`acp-companion.mjs`, the `flushPersistence()` above `let agent`),
  // so no gate on the adapter can hold the caller open. An earlier draft asserted
  // the caller was still running and failed one run in six on exactly that race.
  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'grouped', brief, '120'], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({
      MOCK_GATE_STAGE: 'prompt',
      MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000',
      MOCK_STAGE_FILE: stageFile,
    }),
  })
  let callerOut = ''
  caller.stdout.on('data', (chunk) => { callerOut += chunk })
  caller.stderr.on('data', (chunk) => { callerOut += chunk })

  await waitFor(() => existsSync(stageFile) && readFileSync(stageFile, 'utf8').includes('prompt-reached'),
    30000, 'the adapter to reach session/prompt')
  await waitFor(() => caller.exitCode !== null, 30000, 'the caller to report and exit')

  // This is the Bash cap: SIGTERM to the caller's whole process GROUP, not to
  // one pid. ESRCH here means the group holds nothing — which is the property,
  // not an escape from it. The pgid assertion below keeps it from ever being a
  // vacuous pass, and the mutant that drops `detached` fails this test by
  // timing out on the outbox rather than by skipping it.
  const lanePid = Number(callerOut.match(/pid (\d+)/)?.[1])
  assert.ok(Number.isInteger(lanePid), `no lane pid in caller output: ${callerOut}`)
  assert.notEqual(pgidOf(lanePid), caller.pid, 'the lane sits in the group about to be killed')
  let groupKill = 'delivered'
  try { process.kill(-caller.pid, 'SIGTERM') } catch (cause) { groupKill = cause.code }
  assert.ok(['delivered', 'ESRCH'].includes(groupKill), `unexpected group kill result: ${groupKill}`)

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'grouped')), 60000,
    'the lane to finish and write its outbox after its caller was killed')

  const receipts = readdirSync(join(cwd, '.tmux-teams', 'receipts'))
  assert.ok(receipts.length > 0, `the lane settled without a receipt; caller said: ${callerOut}`)
  const liveness = JSON.parse(readFileSync(join(cwd, '.tmux-teams', 'liveness', 'grouped.json'), 'utf8'))
  assert.notEqual(liveness.termination_reason, 'controller_interrupted',
    'the lane recorded the very interruption this script removes')
})

test('the lane is placed in its own process group, which is why the kill above misses', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-pgid-'))
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')

  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'pgid', brief, '120'], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({
      MOCK_GATE_STAGE: 'prompt',
      MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000',
    }),
  })
  let out = ''
  caller.stdout.on('data', (chunk) => { out += chunk })

  await waitFor(() => caller.exitCode !== null, 60000, 'the caller to report and exit')
  assert.equal(caller.exitCode, 0, `caller exited ${caller.exitCode}: ${out}`)

  const lanePid = Number(out.match(/pid (\d+)/)?.[1])
  assert.ok(Number.isInteger(lanePid), `no lane pid in caller output: ${out}`)
  const lanePgid = pgidOf(lanePid)
  assert.ok(lanePgid !== null, 'the lane was not alive after its caller exited')
  assert.notEqual(lanePgid, pgidOf(caller.pid) ?? caller.pid,
    'the lane shares its caller\'s process group — a group kill would reach it')
  assert.equal(lanePgid, lanePid, 'a detached child leads its own group')

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'pgid')), 60000, 'the lane to finish')
})

test('the caller reports the outbox path it derived, and never a second spelling of it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-outbox-'))
  mkdirSync(join(cwd, '.mailbox-out'), { recursive: true })
  writeFileSync(join(cwd, '.mailbox-out', 'round3'), 'the finished review\n')
  // The second half of the same day's failure: the recovery prompt named
  // `.mailbox-out/mcp-round3` while the dispatch's task id made the companion
  // read `.mailbox-out/mcp-round3-recover`, so a complete 22KB review was
  // reported as `no_outbox`. A stray is now named rather than invisible.
  assert.deepEqual(strayOutboxes(cwd, 'round3-recover'), ['round3'])
  const report = statusReport(cwd, 'round3-recover')
  assert.equal(report.outboxFound, false)
  const text = formatStatus(report)
  assert.match(text, /other files in \.mailbox-out\/: round3/)
  assert.match(text, /READ THOSE BEFORE RE-DISPATCHING/)
})

test('status hands over the resume command with the session id already in it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-resume-'))
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'sessions'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'sessions', 'lane'), '01a00c81-0383-7522-963a-16e2d007d656\n')
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'lane.json'), JSON.stringify({
    liveness_state: 'failed',
    termination_reason: 'no_outbox',
    worker: 'codex',
    requested_model: 'gpt-5.6-sol',
    requested_reasoning_effort: 'max',
  }))
  const text = formatStatus(statusReport(cwd, 'lane'))
  assert.match(text, /ACP_RESUME="01a00c81-0383-7522-963a-16e2d007d656"/)
  assert.match(text, /ACP_EXPECT_MODEL="gpt-5\.6-sol"/)
  assert.match(text, /ACP_EXPECT_REASONING_EFFORT="max"/)
  // The resume must re-enter through THIS script; a resume typed at the
  // companion is exactly as killable as the dispatch that lost the turn.
  assert.match(text, /acp-dispatch\.mjs/)
  assert.doesNotMatch(text, /acp-companion\.mjs/)
})

test('a resume reuses the task id, because a new one moves the outbox out from under the prompt', () => {
  const command = resumeCommand('/repo', 'round3', {
    sessionId: 'sess-1', worker: 'codex', model: 'gpt-5.6-sol', effort: 'max', briefFile: '/tmp/recover.md',
  })
  assert.match(command, /codex \/repo round3 \/tmp\/recover\.md/)
  assert.equal(resumeCommand('/repo', 'round3', { sessionId: null }), null)
})

// The rule this replaces was prose, and prose is what failed. Every shipped
// skill that tells someone how to dispatch has to name the detached entry
// point, or the next caller copies a killable command out of a document.
test('no shipped skill teaches a runnable command that launches the companion directly', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.md')) continue
      const text = readFileSync(path, 'utf8')
      // Fenced blocks only. An ADR or a contract may DESCRIBE the companion;
      // what may not exist is a command somebody can paste.
      for (const [, body] of text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
        // A line continuation makes one command out of several lines.
        for (const command of body.replace(/\\\n/g, ' ').split('\n')) {
          if (/(^|[\s/])(node|exec)\s+\S*acp-companion\.mjs/.test(command)) {
            offenders.push(`${path.slice(SKILLS.length + 1)}: ${command.trim()}`)
          }
        }
      }
    }
  }
  walk(SKILLS)
  assert.deepEqual(offenders, [],
    `these are copy-pasteable commands that a shell cap can kill mid-turn:\n${offenders.join('\n')}`)
})
