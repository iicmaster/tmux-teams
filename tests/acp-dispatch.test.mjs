import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusReport, formatStatus, resumeCommand, outboxPath, strayOutboxes, TERMINAL_LIVENESS_STATES,
  waitForSettlement, EXIT_OUTBOX, EXIT_RUNNING, EXIT_NO_OUTBOX, pidPath, recordedPid }
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
  // The caller waits for the ACKNOWLEDGED identity, not for a file to exist.
  // The companion writes its first snapshot before it spawns the adapter, so
  // the file carries `identity_status: 'missing'` within milliseconds — the
  // first version reported exactly that for a lane whose identity arrived a
  // moment later.
  assert.doesNotMatch(out, /effective_identity: unknown/,
    `the caller reported before the identity was acknowledged: ${out}`)
  assert.match(out, /effective_identity: \S+ \((matched|unverified)\)/)

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

test('the caller waits for an ACKNOWLEDGED identity, and says so plainly when it never comes', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // The discriminating case, and it took a mutation to find that the previous
  // assertion was not one: with a fast mock the identity lands inside the first
  // poll, so a caller that returned on "the liveness FILE exists" looked
  // identical to one that waited for the acknowledgement. Holding the adapter
  // at `initialize` widens that window past the boot budget — the companion has
  // already written a snapshot carrying `identity_status: 'missing'`, so the
  // file-exists version reports `unknown (missing)` and exits 0, and the real
  // one keeps waiting and then says which of the two it is.
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-identity-'))
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')

  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'ident', brief, '120'], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({
      ACP_DISPATCH_BOOT_SEC: '2',
      MOCK_GATE_STAGE: 'initialize',
      MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000',
    }),
  })
  let out = ''
  caller.stdout.on('data', (chunk) => { out += chunk })
  caller.stderr.on('data', (chunk) => { out += chunk })

  await waitFor(() => caller.exitCode !== null, 40000, 'the caller to give up waiting and report')
  // The liveness file exists by now — that is the whole trap.
  assert.ok(existsSync(join(cwd, '.tmux-teams', 'liveness', 'ident.json')),
    'the premise of this test is gone: no snapshot was written before the adapter answered')
  assert.equal(caller.exitCode, 1, `caller exited ${caller.exitCode} instead of reporting a slow boot: ${out}`)
  assert.match(out, /identity not acknowledged after 2s/)
  assert.doesNotMatch(out, /effective_identity: unknown/,
    'the caller reported an identity it had not been given')
  // Never a kill. The lane it just declined to wait for has to still be there.
  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'ident')), 60000,
    'the lane died when its caller stopped waiting for it')
})

test('wait ends on BOTH terminal outcomes, because silence reads exactly like still-running', async () => {
  // Detaching answered "the lane must not die". It created "nobody is told when
  // it ends", and Master asked the obvious question. A watcher that only looks
  // for an outbox stays quiet through a turn that ended writing nothing, which
  // is the failure round three actually had.
  const settled = mkdtempSync(join(tmpdir(), 'acp-dispatch-wait-none-'))
  mkdirSync(join(settled, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(settled, '.tmux-teams', 'liveness', 'lane.json'),
    JSON.stringify({ liveness_state: 'failed', termination_reason: 'no_outbox', worker: 'codex' }))
  const said = []
  assert.equal(await waitForSettlement(settled, 'lane', 5000, { out: (l) => said.push(l), pollMs: 10 }),
    EXIT_NO_OUTBOX, 'a turn that ended without an outbox did not end the wait')
  assert.match(said.join('\n'), /termination_reason: no_outbox/)

  // And it ends on the good outcome, arriving mid-wait rather than up front.
  const arriving = mkdtempSync(join(tmpdir(), 'acp-dispatch-wait-late-'))
  mkdirSync(join(arriving, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(arriving, '.mailbox-out'), { recursive: true })
  writeFileSync(join(arriving, '.tmux-teams', 'liveness', 'lane.json'),
    JSON.stringify({ liveness_state: 'active', termination_reason: 'none' }))
  const late = setTimeout(() => writeFileSync(outboxPath(arriving, 'lane'), 'the answer\n'), 300)
  assert.equal(await waitForSettlement(arriving, 'lane', 20000, { out: () => {}, pollMs: 25 }), EXIT_OUTBOX)
  clearTimeout(late)

  // A lane still going when the budget runs out is reported as still going, and
  // the sentence has to say the lane was not touched — that is the whole
  // contract of a waiter that is a separate process from the thing it watches.
  const running = mkdtempSync(join(tmpdir(), 'acp-dispatch-wait-run-'))
  mkdirSync(join(running, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(running, '.tmux-teams', 'liveness', 'lane.json'),
    JSON.stringify({ liveness_state: 'tool_running', termination_reason: 'none' }))
  const lines = []
  assert.equal(await waitForSettlement(running, 'lane', 120, { out: (l) => lines.push(l), pollMs: 20 }),
    EXIT_RUNNING)
  assert.match(lines.join('\n'), /THE LANE IS UNTOUCHED/)
})

test('a wait that gives up does not reap the lane it was waiting for', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-wait-live-'))
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')
  const stageFile = join(cwd, 'stages')

  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'patient', brief, '120'], {
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
  let out = ''
  caller.stdout.on('data', (chunk) => { out += chunk })
  await waitFor(() => existsSync(stageFile) && readFileSync(stageFile, 'utf8').includes('prompt-reached'),
    30000, 'the adapter to reach session/prompt')
  // Wait for the caller to FINISH before reading what it said. The gate is on
  // the adapter and the report is on the caller, so `prompt-reached` and a
  // flushed stdout race — asserting on `out` here passed alone and failed 3/3
  // in the file, on an empty string.
  await waitFor(() => caller.exitCode !== null, 30000, 'the caller to report and exit')
  // The dispatch report has to hand the operator this command, or the answer
  // exists and nobody is given it.
  assert.match(out, /wait:\s+node .*acp-dispatch\.mjs wait /)

  const code = await waitForSettlement(cwd, 'patient', 400, { out: () => {}, pollMs: 50 })
  assert.equal(code, EXIT_RUNNING, 'a gated lane was reported as settled')

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'patient')), 60000,
    'the lane died when its waiter gave up on it')
})

test('a previous run\'s identity is never reported as this dispatch\'s', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // Measured on 2026-08-17, resuming a lane into the run directory its dead
  // predecessor had used. The caller printed
  // `effective_identity: gpt-5.6-sol[max] (matched)` and a session id — read
  // straight out of the DEAD run's snapshot, one second before the live run
  // wrote `identity_status: missing`. On a plugin whose whole subject is
  // provenance, that is the worst small bug on offer.
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-stale-'))
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  // The predecessor: finished, identified, and a plausible thing to believe.
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'stale.json'), JSON.stringify({
    started_at: '2026-08-16T21:36:10.138Z',
    observed_at: '2026-08-16T21:46:10.092Z',
    liveness_state: 'tool_running',
    termination_reason: 'none',
    effective_identity: 'GHOST-OF-A-PREVIOUS-RUN[max]',
    identity_status: 'matched',
  }))

  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'stale', brief, '120'], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({
      ACP_DISPATCH_BOOT_SEC: '30',
      MOCK_GATE_STAGE: 'prompt',
      MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000',
    }),
  })
  let out = ''
  caller.stdout.on('data', (chunk) => { out += chunk })
  await waitFor(() => caller.exitCode !== null, 60000, 'the caller to report and exit')
  assert.doesNotMatch(out, /GHOST-OF-A-PREVIOUS-RUN/,
    `the caller reported a dead run's identity as this dispatch's: ${out}`)
  assert.match(out, /effective_identity: \S+ \((matched|unverified)\)/,
    `no identity of its own was reported: ${out}`)

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'stale')), 60000, 'the lane to finish')
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

test('status reads the companion\'s own liveness vocabulary, not a guess at it', () => {
  // This is here because the first version guessed. It asked
  // `liveness_state !== 'running'` — a value the companion never writes — so a
  // healthy lane sitting at `active` was reported as finished, with resume
  // advice for a turn that had not ended. The status test that shipped beside
  // it used a liveness fixture written BY HAND, so it only ever met states its
  // own author had chosen.
  const companion = readFileSync(join(SCRIPTS, 'acp-companion.mjs'), 'utf8')
  assert.match(companion, /VALID_TERMINAL_STATES = new Set\(\['completed', 'cancelled', 'failed'\]\)/,
    'the companion changed its terminal-state vocabulary and this file still assumes the old one')
  assert.deepEqual([...TERMINAL_LIVENESS_STATES], ['completed', 'cancelled', 'failed'])

  const cases = [
    // state, termination_reason, settled?  — the reason field carries the
    // STRING 'none' while a lane is healthy, never null.
    ['starting', 'none', false],
    ['active', 'none', false],
    ['tool_running', 'none', false],
    ['awaiting_agent', 'none', false],
    ['stalled', 'none', false],
    ['suspected_stalled', 'none', false],
    // Round three died here and never moved: a killed process writes no further
    // snapshot, so a recorded reason is what makes this one finished.
    ['cancelling', 'controller_interrupted', true],
    ['failed', 'no_outbox', true],
    ['completed', 'none', true],
    ['cancelled', 'stall', true],
  ]
  for (const [state, reason, settled] of cases) {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-vocab-'))
    mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
    writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'lane.json'),
      JSON.stringify({ liveness_state: state, termination_reason: reason }))
    const report = statusReport(cwd, 'lane')
    assert.equal(report.settled, settled, `${state}/${reason} was judged settled=${report.settled}`)
    const text = formatStatus(report)
    assert.equal(/try RESUME/.test(text), settled && Boolean(report.sessionId),
      `${state}/${reason} offered resume advice for a turn that has not ended`)
  }
})

test('a lane that stopped reporting is not reported as running, however alive its last snapshot looked', () => {
  // The real numbers, from 2026-08-17. A review lane died when the disk filled
  // — its log ends with the companion failing to persist its own snapshot with
  // ENOSPC — so it never wrote a terminal state and its last record still says
  // `tool_running`. `status` went on calling that RUNNING for nearly four
  // hours, and a `wait` built on it would never have returned. That is this
  // file trusting a file its writer can no longer correct for the third time.
  //
  // `next_lease_expiry_at` is the companion's OWN statement of when it should
  // next have been heard from, so no threshold here is invented.
  const dead = {
    liveness_state: 'tool_running',
    termination_reason: 'none',
    observed_at: '2026-08-16T22:54:54.379Z',
    next_lease_expiry_at: '2026-08-16T23:34:54.324Z',
    meaningful_progress_count: 461,
    worker: 'codex',
    requested_model: 'gpt-5.6-sol',
    requested_reasoning_effort: 'max',
  }
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-lease-'))
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'sessions'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'sessions', 'lane'), '01a00cbb-b70c-7670-b9b3-b523a70aa393\n')
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'lane.json'), JSON.stringify(dead))

  const report = statusReport(cwd, 'lane')
  assert.equal(report.livenessState, 'tool_running', 'the fixture must LOOK alive or it tests nothing')
  assert.equal(report.notReporting, true)
  assert.equal(report.settled, true, 'a lane that stopped reporting would hang a waiter forever')
  const text = formatStatus(report)
  assert.match(text, /NOT REPORTING — its own lease expired/,
    'the sentence must say WHICH signal judged it, not merely that something did')
  assert.match(text, /Last snapshot 2026-08-16T22:54:54\.379Z/)
  // And it still offers the recovery, because a session that stopped reporting
  // is exactly the one worth resuming rather than re-paying for.
  assert.match(text, /ACP_RESUME="01a00cbb-b70c-7670-b9b3-b523a70aa393"/)

  // A lease still in the future is a lane still running, and must NOT be
  // swept up by this — otherwise every healthy lane is declared dead.
  const alive = mkdtempSync(join(tmpdir(), 'acp-dispatch-lease-ok-'))
  mkdirSync(join(alive, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(alive, '.tmux-teams', 'liveness', 'lane.json'), JSON.stringify({
    ...dead,
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  }))
  const healthy = statusReport(alive, 'lane')
  assert.equal(healthy.notReporting, false)
  assert.equal(healthy.settled, false)
  assert.doesNotMatch(formatStatus(healthy), /NOT REPORTING/)
})

test('a dead process is noticed immediately, without waiting out the lease', () => {
  // The lease is correct and SLOW: `next_lease_expiry_at` sits up to fifteen
  // minutes out, so a lane that died two minutes ago still reads as running.
  // That happened twice on 2026-08-17 while a recovery was waiting on it. The
  // dispatcher records the pid it spawned, so the immediate answer exists.
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dispatch-pid-'))
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  // A snapshot that looks alive AND a lease still well in the future: the lease
  // check alone would call this running.
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'lane.json'), JSON.stringify({
    liveness_state: 'tool_running',
    termination_reason: 'none',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  }))

  // This process is alive by definition, so it stands in for a healthy lane.
  writeFileSync(pidPath(cwd, 'lane'), `${process.pid}\n`)
  const alive = statusReport(cwd, 'lane')
  assert.equal(alive.notReporting, false, 'a live pid was reported as gone')
  assert.equal(alive.settled, false)

  // A pid that cannot exist.
  writeFileSync(pidPath(cwd, 'lane'), '2147483646\n')
  const dead = statusReport(cwd, 'lane')
  assert.equal(dead.notReporting, true, 'a dead pid was reported as running because the lease had not expired')
  assert.equal(dead.settled, true, 'a waiter would have hung on this')
  assert.match(formatStatus(dead), /NOT REPORTING — its process is gone/)

  // And `status` still works against a run directory this dispatcher did not
  // create, where there is no pid to read.
  rmSync(pidPath(cwd, 'lane'))
  assert.equal(recordedPid(cwd, 'lane'), null)
  assert.equal(statusReport(cwd, 'lane').notReporting, false)
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
