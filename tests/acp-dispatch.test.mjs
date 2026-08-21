import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, symlinkSync,
  realpathSync, statSync, linkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusReport, formatStatus, resumeCommand, outboxPath, sessionPath, COMPANION_DEFAULT_STALL_SEC, leaseExpired, strayOutboxes, TERMINAL_LIVENESS_STATES,
  waitForSettlement, EXIT_OUTBOX, EXIT_RUNNING, EXIT_NO_OUTBOX, pidPath, recordedPid, belongsToThisRun,
  statusExitCode, logPath, readLeafSync, recordedRouting, spawnDetached, ROUTING_ENV_KEYS, main }
  from '../plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
const DISPATCH = join(SCRIPTS, 'acp-dispatch.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const SKILLS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Every temp directory this file makes, removed when the file ends — AND every
// lane it spawned killed first, because deleting the directory is not the same
// as ending the writer.
//
// Written 2026-08-17 after this file helped fill the machine's disk twice in one
// day: 25 `mkdtempSync` calls and one `rmSync`, several holding a real lane's
// logs, receipts and KMS events.
//
// **That fix was not enough and a panel lane proved it on this machine.** It
// counted 17 leaked directories, named three, and showed mtimes ~60s after the
// suite ended — the lanes are DETACHED, so `after()` deleted the trees and the
// still-running companions recreated them while winding down (terminal
// persistence, receipts, KMS) or when a mock watchdog released a gated lane. It
// reproduced on a fully GREEN run too, and one recreated directory came back at
// 0755 rather than the 0700 this dispatcher enforces — proof the mkdir was the
// companion's, after the deletion.
//
// So the cleanup ends the writers first. A detached lane is not ours to wait
// for indefinitely, so this signals and then verifies rather than blocking: any
// pid still alive gets SIGKILL, and the directory is removed after its process
// is gone.
const TEMP_DIRS = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

// Only pids THIS RUN recorded. Two panel families found the earlier version
// dangerous for the same reason: it read whatever pid files were lying in a
// temp directory and SIGKILLed the group, so a stale pid whose number the OS
// had recycled belonged to a stranger — on the developer's own machine. It had
// already killed the test runner once while being written, which should have
// been the signal.
//
// A pid file only says a NUMBER. Whether that number is still the process this
// suite started is answered by its start time: anything running before this
// file began cannot be ours, however the number got there. `ps -o lstart=` is
// available on macOS and Linux; if it cannot answer, the pid is left alone,
// because not killing a lane leaks a directory and killing a stranger does not.
const SUITE_STARTED_AT = Date.now()

function startedAfterThisSuite(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (!out) return false
    const started = Date.parse(out)
    return Number.isFinite(started) && started >= SUITE_STARTED_AT - 5000
  } catch {
    return false
  }
}

function lanePidsUnder(dir) {
  const pids = []
  const pidDir = join(dir, '.tmux-teams', 'dispatch-pids')
  if (!existsSync(pidDir)) return pids
  for (const leaf of readdirSync(pidDir)) {
    const pid = Number.parseInt(readFileSync(join(pidDir, leaf), 'utf8').trim(), 10)
    if (!startedAfterThisSuite(pid)) continue
    // NEVER our own pid, and never our own group. Several fixtures plant
    // `process.pid` on purpose — they need a pid that is definitely alive to
    // test reuse and admission — and the first version of this hook killed the
    // test runner's own process group with them. The suite stopped at 26 of 37
    // and left 62 directories behind, which is the leak this hook exists to
    // stop, made four times worse by the fix for it.
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid) {
      pids.push(pid)
    }
  }
  return pids
}

after(async () => {
  const pids = TEMP_DIRS.flatMap((dir) => {
    try { return lanePidsUnder(dir) } catch { return [] }
  })
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  // Give the kills a moment to land before deleting what they were writing to.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && pids.some((pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  })) await sleep(100)
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
})

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

// Every `ACP_*` the caller's shell happens to carry is REMOVED before the
// lane's own settings are applied. A panel lane found this and it reproduces in
// one command: `ACP_MODEL=gemini-3.7-flash-high node --test
// tests/acp-dispatch.test.mjs` turned 35 pass / 0 fail into 23 / 12, because
// the companion then demands the adapter advertise that model and the mock does
// not. A suite that is green only in the author's shell is the same class as
// the test that read the author's `~/.config/claude-profiles` and shipped two
// releases on red CI.
function laneEnv(extra = {}) {
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ACP_')),
  )
  return {
    ...ambient,
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
  const cwd = tempDir('acp-dispatch-group-')
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
  const cwd = tempDir('acp-dispatch-pgid-')
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
  const cwd = tempDir('acp-dispatch-identity-')
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
  const settled = tempDir('acp-dispatch-wait-none-')
  mkdirSync(join(settled, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(settled, '.tmux-teams', 'liveness', 'lane.json'),
    JSON.stringify({ liveness_state: 'failed', termination_reason: 'no_outbox', worker: 'codex' }))
  const said = []
  assert.equal(await waitForSettlement(settled, 'lane', 5000, { out: (l) => said.push(l), pollMs: 10 }),
    EXIT_NO_OUTBOX, 'a turn that ended without an outbox did not end the wait')
  assert.match(said.join('\n'), /termination_reason: no_outbox/)

  // And it ends on the good outcome, arriving mid-wait rather than up front.
  const arriving = tempDir('acp-dispatch-wait-late-')
  mkdirSync(join(arriving, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(arriving, '.mailbox-out'), { recursive: true })
  writeFileSync(join(arriving, '.tmux-teams', 'liveness', 'lane.json'),
    JSON.stringify({ liveness_state: 'active', termination_reason: 'none' }))
  // Both, and in the order a real lane produces them: the worker writes the
  // outbox before session/prompt returns, and the companion records the
  // terminal state after validating it. Ranking the file alone let `wait`
  // return 0 on a file that might still be being written — the PR reviewer's
  // finding, and the reason this fixture now moves the liveness record too.
  const late = setTimeout(() => {
    writeFileSync(outboxPath(arriving, 'lane'), 'the answer\n')
    setTimeout(() => writeFileSync(join(arriving, '.tmux-teams', 'liveness', 'lane.json'),
      JSON.stringify({ liveness_state: 'completed', termination_reason: 'none' })), 150)
  }, 300)
  assert.equal(await waitForSettlement(arriving, 'lane', 20000, { out: () => {}, pollMs: 25 }), EXIT_OUTBOX)
  clearTimeout(late)

  // And the window between them is reported as STILL RUNNING, never as done.
  const midway = tempDir('acp-dispatch-wait-midway-')
  mkdirSync(join(midway, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(midway, '.mailbox-out'), { recursive: true })
  writeFileSync(join(midway, '.tmux-teams', 'liveness', 'lane.json'),
    JSON.stringify({ liveness_state: 'active', termination_reason: 'none' }))
  writeFileSync(outboxPath(midway, 'lane'), 'half a review\n')
  const said2 = []
  assert.equal(await waitForSettlement(midway, 'lane', 200, { out: (l) => said2.push(l), pollMs: 20 }),
    EXIT_RUNNING, 'an outbox file with no terminal state was reported as a finished turn')
  assert.match(said2.join('\n'), /has not recorded a terminal state/)

  // A lane still going when the budget runs out is reported as still going, and
  // the sentence has to say the lane was not touched — that is the whole
  // contract of a waiter that is a separate process from the thing it watches.
  const running = tempDir('acp-dispatch-wait-run-')
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
  const cwd = tempDir('acp-dispatch-wait-live-')
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
  assert.match(out, /wait:\s+node '[^']*acp-dispatch\.mjs' wait /)

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
  const cwd = tempDir('acp-dispatch-stale-')
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

  // The integration case above uses an hours-old snapshot, which a one-second
  // tolerance would also have rejected — so it never proved the BOUNDARY. Round
  // five said so plainly: "the stale identity test that passed does not prove
  // the boundary inside one second". Here it is, at the millisecond.
  const spawnedAt = 1_700_000_000_000
  const nonce = 'unit-boundary-nonce'
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce), true)
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt + 1).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce), true)
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt - 1).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce), false,
    'a snapshot written one millisecond before this spawn was accepted as this run\'s')
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt - 999).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce), false,
    'the one-second slack is back: a sub-second retry will inherit its predecessor\'s identity')
  assert.equal(belongsToThisRun({}, spawnedAt, nonce), false, 'a record with no started_at was claimed')
  assert.equal(belongsToThisRun(null, spawnedAt, nonce), false)
  // The bounds alone are not identity: an in-window record with a different
  // nonce, or no nonce at all, must still be refused — the case a timestamp
  // cannot close by itself.
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt).toISOString(), spawn_nonce: 'someone-elses-nonce' },
    spawnedAt, nonce), false, 'an in-window record with a different nonce was accepted as this run\'s')
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt).toISOString() }, spawnedAt, nonce), false,
    'an in-window record with no nonce at all was accepted as this run\'s')
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt).toISOString(), spawn_nonce: nonce }, spawnedAt, undefined), false,
    'a record matched against no expected nonce at all')
})

// These three go through `statusReport`, never a direct `belongsToThisRun`
// call with the new argument count — calling the new signature directly
// against the OLD source silently reinterprets the extra argument as `nowMs`,
// which corrupts the upper bound into NaN and makes the old code refuse for
// the wrong reason. Going through the reader that decides how many arguments
// it passes is what lets the same test genuinely fail on old source and pass
// on new.
test('a record with the right timestamp and a forged or missing nonce is refused', () => {
  const cwd = tempDir('acp-dispatch-forged-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  const spawnedAt = new Date().toISOString()

  // Missing entirely — what a record written before this field existed, or
  // forged without knowing it, looks like.
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'forged-a.json'),
    JSON.stringify({ worker: 'mock', spawnedAt, spawnNonce: 'this-dispatchs-own-nonce', env: {} }))
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'forged-a.json'), JSON.stringify({
    started_at: new Date(Date.parse(spawnedAt) + 5_000).toISOString(),
    liveness_state: 'completed', termination_reason: 'none',
    effective_identity: 'FORGED-A[max]', identity_status: 'matched',
  }))
  const reportA = statusReport(cwd, 'forged-a')
  assert.equal(reportA.liveness, null,
    'an in-window record with no nonce at all was adopted as this run\'s')
  assert.notEqual(reportA.identity, 'FORGED-A[max]', 'a forged identity reached the report')

  // Present, but wrong.
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'forged-b.json'),
    JSON.stringify({ worker: 'mock', spawnedAt, spawnNonce: 'this-dispatchs-own-nonce', env: {} }))
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'forged-b.json'), JSON.stringify({
    started_at: new Date(Date.parse(spawnedAt) + 5_000).toISOString(),
    liveness_state: 'completed', termination_reason: 'none',
    effective_identity: 'FORGED-B[max]', identity_status: 'matched',
    spawn_nonce: 'not-this-dispatchs-nonce',
  }))
  const reportB = statusReport(cwd, 'forged-b')
  assert.equal(reportB.liveness, null,
    'an in-window record with the WRONG nonce was adopted as this run\'s')
  assert.notEqual(reportB.identity, 'FORGED-B[max]', 'a forged identity reached the report')
})

test('a genuine dispatch\'s liveness record carries the nonce the dispatcher recorded for it', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // The wire, proven end to end: the dispatcher generates a nonce per
  // dispatch, hands it to the companion over ACP_SPAWN_NONCE, and the
  // companion echoes it into `spawn_nonce` — the value `belongsToThisRun` now
  // requires to match.
  const cwd = tempDir('acp-dispatch-nonce-genuine-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'nonce-genuine', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.equal(r.status, 0, `the dispatch failed outright:\n${r.stdout}${r.stderr}`)
  const routing = recordedRouting(cwd, 'nonce-genuine')
  assert.ok(routing?.spawnNonce, `no nonce was recorded in routing: ${JSON.stringify(routing)}`)
  const liveness = JSON.parse(readFileSync(join(cwd, '.tmux-teams', 'liveness', 'nonce-genuine.json'), 'utf8'))
  assert.equal(liveness.spawn_nonce, routing.spawnNonce,
    `the companion's liveness record did not carry the dispatcher's nonce: ${JSON.stringify(liveness)}`)
  const report = statusReport(cwd, 'nonce-genuine')
  assert.notEqual(report.liveness, null, 'a genuine record was refused by belongsToThisRun')
})

test('the companion refuses a prohibited model when it is reached without the dispatcher', () => {
  // The dispatcher refuses this too, and the test for that stops in the parent.
  // This is the child-side layer, and the only caller who can reach it is one
  // who runs the companion by hand — which is exactly the caller the layer is
  // for. Defence in depth that nothing exercises is decoration.
  const cwd = tempDir('acp-companion-prohibited-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  // Each case must leave exactly ONE call site able to refuse. A review lane
  // showed why that matters: ACP_EXPECT_MODEL falls back to the requested
  // model, so a lone prohibited ACP_MODEL is still caught by the expectation
  // check with the call site under test deleted — red, but for the wrong
  // reason. Pairing a prohibited request with a PERMITTED expectation is what
  // isolates the ACP_MODEL call site.
  const cases = [
    { env: { ACP_EXPECT_MODEL: 'gemini-3.1-flash' }, label: 'ACP_EXPECT_MODEL', value: 'gemini-3.1-flash' },
    { env: { ACP_MODEL: 'gemini-3.1-pro-high', ACP_EXPECT_MODEL: 'gpt-5.6-luna' },
      label: 'ACP_MODEL', value: 'gemini-3.1-pro-high' },
  ]
  for (const [i, probe] of cases.entries()) {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'acp-companion.mjs'), 'mock', cwd, `child-case-${i}`, brief, '120'],
      { cwd, encoding: 'utf8', env: laneEnv(probe.env), timeout: 20_000 })
    assert.equal(r.status, 2,
      `case ${i} (${JSON.stringify(probe.env)}) was accepted by the companion:\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, new RegExp(`${probe.label}: Gemini 3\\.1 is prohibited on tmux-teams routes, got ${probe.value}`),
      `case ${i} refused under the wrong name:\n${r.stderr}`)
  }
  // The mock agent writes `.adapter-env.json` unconditionally at its own top
  // level, so its ABSENCE is what proves the refusal landed before any adapter
  // process ran — not merely that the exit code was 2 in the end.
  assert.equal(existsSync(join(cwd, '.adapter-env.json')), false,
    'the adapter started before the companion refused the prohibited model')
})

test('a malformed ACP_SPAWN_NONCE is refused before the companion ever starts', () => {
  // The dispatcher always OVERWRITES ACP_SPAWN_NONCE with its own generated
  // value, so this guard is unreachable through acp-dispatch.mjs. It exists for
  // the caller who runs the companion by hand, and that is the only path that
  // can exercise it.
  const cwd = tempDir('acp-dispatch-nonce-malformed-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'acp-companion.mjs'), 'mock', cwd, 'nonce-malformed', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv({ ACP_SPAWN_NONCE: 'not a valid nonce!' }), timeout: 20_000 })
  assert.equal(r.status, 2, `a malformed ACP_SPAWN_NONCE was accepted:\n${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /invalid ACP_SPAWN_NONCE "not a valid nonce!" — 1-64 chars/,
    `unexpected refusal message:\n${r.stderr}`)
  // Refused before any state is touched, so no record exists for a dispatch
  // that was never allowed to begin.
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'liveness', 'nonce-malformed.json')), false,
    'the companion wrote a liveness record before refusing the malformed nonce')
})

test('a predecessor\'s record from an earlier dispatch is refused for a later window it happens to fall inside', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // The case the timestamp bounds were added for: a real earlier dispatch at
  // this task id leaves a genuine liveness record on disk, and a later
  // dispatch into the same task id (a resume, a quick retry) can have a
  // window that legitimately covers it. The bound alone cannot tell the two
  // dispatches apart; only the nonce can.
  const cwd = tempDir('acp-dispatch-predecessor-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')

  // Dispatch A: a genuine, earlier run at this task id.
  const first = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'predecessor', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.equal(first.status, 0, `the predecessor dispatch failed outright:\n${first.stdout}${first.stderr}`)

  // A LATER dispatch's own routing record, landing at the same task id — a
  // spawnedAt just before A's own started_at (so A's record sits inside the
  // later window) and a nonce that is necessarily different: every dispatch
  // mints its own.
  const predecessorLiveness = JSON.parse(
    readFileSync(join(cwd, '.tmux-teams', 'liveness', 'predecessor.json'), 'utf8'))
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'predecessor.json'), JSON.stringify({
    worker: 'mock',
    spawnedAt: new Date(Date.parse(predecessorLiveness.started_at) - 1).toISOString(),
    spawnNonce: 'a-later-dispatchs-own-nonce',
    env: {},
  }))

  const report = statusReport(cwd, 'predecessor')
  assert.equal(report.liveness, null,
    'a predecessor\'s record, inside a later dispatch\'s window, was adopted as the later dispatch\'s own')
})

test('a task id that would escape the run directory is refused before any file is opened', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX paths')
  // The repository's PR reviewer found this and it is the worst thing in the
  // change. An earlier version deliberately delegated id validation to the
  // companion — "a second copy of a rule can drift" — and then built the log
  // path and the pid path from the raw value FIRST. `writeFileSync` truncates,
  // so a task id of `../../../victim` replaced an arbitrary writable file with
  // a pid before the companion ever saw the id it was going to reject.
  const cwd = tempDir('acp-dispatch-traversal-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const victim = join(cwd, 'victim')
  writeFileSync(victim, 'PRECIOUS\n')

  for (const evil of ['../victim', '../../etc/passwd', 'a/b', '.', '..', '-leading-dash', 'x'.repeat(65)]) {
    const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, evil, brief, '120'],
      { cwd, encoding: 'utf8', env: laneEnv() })
    assert.equal(r.status, 2, `"${evil}" was accepted: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /invalid task id/)
  }
  // An empty id is a usage error rather than an invalid one, and exits 2 too.
  const empty = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, '', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv() })
  assert.equal(empty.status, 2)
  assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n', 'a task id truncated a file outside its run directory')
  // And nothing was created for any of them.
  assert.ok(!existsSync(join(cwd, '.tmux-teams', 'dispatch-pids')),
    'a pid file directory was created for a refused id')

  // The rule is the companion's, copied with its source named. This asserts the
  // two have not drifted, which is the answer to the objection that made the
  // first version delegate.
  const companion = readFileSync(join(SCRIPTS, 'acp-companion.mjs'), 'utf8')
  assert.match(companion, /const ID_RE = \/\^\[A-Za-z0-9_\]\[A-Za-z0-9_-\]\{0,63\}\$\//,
    'the companion changed its task-id rule and this file still enforces the old one')
})

test('a lane that reaches a terminal state during boot is a failed dispatch, not a successful one', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // Also the PR reviewer's. `isSettled(record)` used to fold a terminal boot
  // record into `outcome: 'live'`, so a consultation refused before its prompt
  // — an unsupported model, an identity mismatch, a config option the adapter
  // would not take — printed an identity and exited 0. "Dispatched
  // successfully" and "refused before the prompt" are not the same answer.
  const cwd = tempDir('acp-dispatch-refused-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'refused', brief, '120'], {
    cwd, encoding: 'utf8',
    // The mock advertises a model list that does not contain what we demand, so
    // the companion refuses the identity before the prompt is ever delivered.
    env: laneEnv({
      ACP_DISPATCH_BOOT_SEC: '30',
      MOCK_CONFIG_IDENTITY: '1',
      MOCK_MODEL_OPTIONS: 'something-else',
      MOCK_MODEL_OPTIONS_STRICT: '1',
      ACP_MODEL: 'a-model-the-adapter-will-not-take',
      ACP_EXPECT_MODEL: 'a-model-the-adapter-will-not-take',
    }),
  })
  assert.notEqual(r.status, 0, `a refused dispatch reported success:\n${r.stdout}${r.stderr}`)
  assert.doesNotMatch(r.stdout, /^effective_identity: /m,
    'an identity was printed for a consultation that never started')
})

test('a nonsense boot budget is refused rather than becoming an infinite wait', () => {
  const cwd = tempDir('acp-dispatch-bootsec-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  // NaN made every deadline comparison false, so the "short-lived" dispatcher
  // stayed attached to a hanging child forever — restoring, through a typo, the
  // caller-lifetime coupling this whole file exists to remove.
  for (const bad of ['soon', '', '0', '-5', 'NaN']) {
    const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'bootsec', brief, '120'],
      { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: bad }), timeout: 20000 })
    assert.equal(r.status, 2, `ACP_DISPATCH_BOOT_SEC="${bad}" was accepted`)
    assert.match(r.stderr, /ACP_DISPATCH_BOOT_SEC must be a positive number/)
  }
})

test('the caller reports the outbox path it derived, and never a second spelling of it', () => {
  const cwd = tempDir('acp-dispatch-outbox-')
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
    // NOT settled by the reason alone, and this changed on 2026-08-17. A
    // previous version counted any termination_reason other than 'none', and
    // the repository's PR reviewer showed what that costs: under
    // ACP_STALL_POLICY=report the companion writes `stalled` /
    // `stall_confirmed` and STAYS ALIVE to recover, and an ordinary
    // cancellation sits in `cancelling` with a reason set before it reaches a
    // terminal state. Both were being called finished. A lane that really
    // stopped is caught by its pid or by its lease instead — see the two tests
    // below — and being stalled is not being over.
    ['cancelling', 'controller_interrupted', false],
    ['stalled', 'stall_confirmed', false],
    ['failed', 'no_outbox', true],
    ['completed', 'none', true],
    ['cancelled', 'stall', true],
  ]
  for (const [state, reason, settled] of cases) {
    const cwd = tempDir('acp-dispatch-vocab-')
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
  const cwd = tempDir('acp-dispatch-lease-')
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
  assert.match(text, /ACP_RESUME='01a00cbb-b70c-7670-b9b3-b523a70aa393'/)

  // A lease still in the future is a lane still running, and must NOT be
  // swept up by this — otherwise every healthy lane is declared dead.
  const alive = tempDir('acp-dispatch-lease-ok-')
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
  const cwd = tempDir('acp-dispatch-pid-')
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
  const cwd = tempDir('acp-dispatch-resume-')
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
  // The routing the dispatch ACTUALLY used, recorded at spawn. The first
  // version rebuilt a generic command from the liveness record's requested
  // model — which turned an EXPECTATION into `ACP_MODEL` and dropped
  // CLAUDE_CONFIG_DIR entirely, so pasting it for a routed Claude seat could
  // load the session through a different profile while looking like it
  // preserved the identity. The PR reviewer named it.
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'lane.json'), JSON.stringify({
    worker: 'codex',
    env: {
      ACP_MODEL: 'gpt-5.6-sol', ACP_EXPECT_MODEL: 'gpt-5.6-sol',
      ACP_REASONING_EFFORT: 'max', ACP_EXPECT_REASONING_EFFORT: 'max',
      CLAUDE_CONFIG_DIR: '/home/someone/.config/claude-profiles/zai',
    },
  }))
  const text = formatStatus(statusReport(cwd, 'lane'))
  assert.match(text, /ACP_RESUME='01a00c81-0383-7522-963a-16e2d007d656'/)
  assert.match(text, /ACP_EXPECT_MODEL='gpt-5\.6-sol'/)
  assert.match(text, /ACP_EXPECT_REASONING_EFFORT='max'/)
  assert.match(text, /CLAUDE_CONFIG_DIR='\/home\/someone\/\.config\/claude-profiles\/zai'/,
    'the profile the dispatch routed through was dropped from its own recovery command')
  // The resume must re-enter through THIS script; a resume typed at the
  // companion is exactly as killable as the dispatch that lost the turn.
  assert.match(text, /acp-dispatch\.mjs/)
  assert.doesNotMatch(text, /acp-companion\.mjs/)
})

test('a resume reuses the task id, because a new one moves the outbox out from under the prompt', () => {
  const command = resumeCommand('/repo', 'round3', {
    sessionId: 'sess-1', routing: { worker: 'codex', env: { ACP_MODEL: 'gpt-5.6-sol' } },
    briefFile: '/tmp/recover.md',
  })
  assert.match(command, /'codex' '\/repo' 'round3' '\/tmp\/recover\.md'/)
  assert.equal(resumeCommand('/repo', 'round3', { sessionId: null }), null)

  // Every generated argument is shell-quoted. A path with a space produced a
  // command that split into the wrong argv when pasted — the same class as the
  // boot guard this file already carries a comment about.
  const spaced = resumeCommand('/a path/with spaces', 'round3', {
    sessionId: "it's-quoted", routing: { worker: 'codex', env: {} }, briefFile: '/b rief.md',
  })
  assert.match(spaced, /'\/a path\/with spaces'/)
  assert.match(spaced, /'\/b rief\.md'/)
  assert.match(spaced, /ACP_RESUME='it'\\''s-quoted'/,
    'a single quote in a value broke out of its own quoting')
})

// The rule this replaces was prose, and prose is what failed. Every shipped
// skill that tells someone how to dispatch has to name the detached entry
// point, or the next caller copies a killable command out of a document.
// Extracted so the guard can be pointed at a fixture as well as at the repo —
// a detector that can only ever be run over a clean tree cannot be shown to
// detect anything.
function foregroundCompanionCommands(text) {
  const found = []
  // Fenced blocks only. An ADR or a contract may DESCRIBE the companion; what
  // may not exist is a command somebody can paste.
  for (const [, body] of text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
    // A line continuation makes one command out of several lines.
    for (const command of body.replace(/\\\n/g, ' ').split('\n')) {
      if (/(^|[\s/])(node|exec)\s+\S*acp-companion\.mjs/.test(command)) found.push(command.trim())
    }
  }
  return found
}

test('no TRACKED document teaches a runnable command that launches the companion directly', () => {
  // Third scope failure in this guard's short life, and each was found by a
  // reviewer rather than by the guard. It scanned `skills/` while README.md
  // carried the command; it was widened to a filesystem walk that SKIPPED every
  // directory named `docs`, so a fenced command under `plugins/tmux-teams/docs/`
  // would never have been observed; and its name said "every tracked document"
  // while it asked the filesystem rather than git.
  //
  // It asks git now, which is what the name claims, and the negative control
  // below plants the offending command in the exact directory the old walker
  // pruned.
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: join(HERE, '..'), encoding: 'utf8' })
    .split('\0').filter(Boolean)
  assert.ok(tracked.includes('README.md'), 'the tracked-file query did not reach README.md')
  assert.ok(tracked.some((f) => f.startsWith('plugins/tmux-teams/docs/')),
    'no document under plugins/tmux-teams/docs/ was considered — the pruned directory is back')
  assert.ok(tracked.length > 20, `only ${tracked.length} documents were considered`)

  const offenders = []
  for (const rel of tracked) {
    for (const command of foregroundCompanionCommands(readFileSync(join(HERE, '..', rel), 'utf8'))) {
      offenders.push(`${rel}: ${command}`)
    }
  }
  assert.deepEqual(offenders, [],
    `these are copy-pasteable commands that a shell cap can kill mid-turn:\n${offenders.join('\n')}`)

  // The negative control: the detector must actually detect. Without this the
  // whole test passes on an empty candidate list, which is how it passed while
  // README.md was offending.
  const planted = '```bash\nnode plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs \\\n  codex . t b\n```\n'
  assert.equal(foregroundCompanionCommands(planted).length, 1,
    'the detector does not detect the thing it forbids')
  assert.equal(foregroundCompanionCommands('`acp-companion.mjs` is described here, not run.').length, 0,
    'prose about the companion is not an offence, and this guard must not say it is')
})

test('status and wait refuse the traversal syntax dispatch refuses, and read nothing', () => {
  // An advisor round's blocker 1: dispatch validated the id, the other two
  // PUBLIC modes did not, and `statusReport` builds six paths out of it. So the
  // command that refused `../` on dispatch happily read whatever `../` pointed
  // at on `status`, and reflected fields out of it. A guard on one entry point
  // is not a guard on the surface.
  const cwd = tempDir('acp-dispatch-readpath-')
  mkdirSync(join(cwd, 'run', '.tmux-teams', 'liveness'), { recursive: true })
  // The planted target, one level above the run directory.
  writeFileSync(join(cwd, 'secret.json'), JSON.stringify({
    liveness_state: 'completed', termination_reason: 'none',
    effective_identity: 'PLANTED-IDENTITY-MARKER', session_id: 'PLANTED-SESSION',
  }))

  for (const mode of ['status', 'wait']) {
    const r = spawnSync(process.execPath, [DISPATCH, mode, join(cwd, 'run'), '../../secret', '5'],
      { cwd, encoding: 'utf8', env: laneEnv(), timeout: 20000 })
    assert.equal(r.status, 2, `${mode} accepted a traversal id`)
    assert.match(r.stderr, /invalid task id/)
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /PLANTED-IDENTITY-MARKER|PLANTED-SESSION/,
      `${mode} read the planted file and reflected it`)
  }

  // And the exported boundary refuses too, so a programmatic caller cannot
  // route around the CLI check.
  assert.throws(() => statusReport(join(cwd, 'run'), '../../secret'), /invalid task id/)
})

test('a symlink planted where a run artifact belongs is refused, not followed', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symlinks')
  // An advisor round's blocker 2, and the sharper half of the traversal story:
  // a lexical id check confines the SPELLING, not the write. A pre-positioned
  // symlink at `.tmux-teams/dispatch-pids/<id>` is followed by an ordinary
  // write, which truncates whatever it points at — after the child has already
  // spawned, so the damage is done by a process nobody is watching.
  for (const artifact of [['dispatch-pids', 'planted'], ['dispatch-routing', 'planted.json'],
    ['runner-logs', 'planted.log']]) {
    const cwd = tempDir('acp-dispatch-symlink-')
    const brief = join(cwd, 'brief.md')
    writeFileSync(brief, 'do the thing\n')
    const victim = join(cwd, 'victim')
    writeFileSync(victim, 'PRECIOUS\n')
    mkdirSync(join(cwd, '.tmux-teams', artifact[0]), { recursive: true })
    symlinkSync(victim, join(cwd, '.tmux-teams', artifact[0], artifact[1]))

    const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'planted', brief, '120'],
      { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '5' }), timeout: 30000 })
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n',
      `a symlink at ${artifact.join('/')} was followed and the victim was truncated`)
    assert.notEqual(r.status, 0, `${artifact.join('/')}: a hostile run directory was dispatched into`)
    // And NOTHING started. The pid and routing writes happen after `unref()`,
    // so without a pre-spawn check on those leaves the refusal arrives too
    // late: a detached lane alive with no trustworthy records, which an advisor
    // round called operationally worse than not starting. A mutation removing
    // the pre-spawn leaf checks passed until this assertion existed.
    // The probe has to be a thing the CHILD does, not a thing the parent
    // prints: `spawnDetached` throwing means the parent's own report never
    // runs, so an absent "dispatched" line proves nothing about whether a lane
    // started. The companion writes to its log within milliseconds of starting,
    // so an empty log after the refusal is the evidence. A mutation removing
    // the pre-spawn leaf checks passed against the printed-output version of
    // this assertion and fails against this one.
    // The probe has to be a thing the CHILD does, and it has to be given time:
    // `spawnDetached` throwing means the parent's own report never runs, so an
    // absent "dispatched" line proves nothing, and a check taken the instant
    // spawnSync returns can beat the companion to its first write. The liveness
    // snapshot is the companion's own first act and its path is not the one
    // under attack here, so it is the clean witness.
    await sleep(1200)
    assert.ok(!existsSync(join(cwd, '.tmux-teams', 'liveness', 'planted.json')),
      `${artifact.join('/')}: a lane was spawned and the refusal came afterwards`)
  }
})

test('a predecessor\'s terminal record and outbox never add up to this run finishing', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // An advisor round's blocker 3. `outbox && terminated` sounds sufficient
  // until BOTH bytes belong to yesterday's run of the same task id while
  // today's pid is alive — a false success at the exact moment an operator is
  // deciding whether the work is done.
  const cwd = tempDir('acp-dispatch-generation-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.mailbox-out'), { recursive: true })
  // The predecessor: finished, with an answer.
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'gen.json'), JSON.stringify({
    started_at: '2026-08-16T21:36:10.138Z', observed_at: '2026-08-16T21:46:10.092Z',
    liveness_state: 'completed', termination_reason: 'none', effective_identity: 'YESTERDAY[max]',
  }))
  writeFileSync(outboxPath(cwd, 'gen'), "yesterday's answer\n")

  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'gen', brief, '120'], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({ MOCK_GATE_STAGE: 'prompt', MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000' }),
  })
  let out = ''
  caller.stdout.on('data', (chunk) => { out += chunk })
  await waitFor(() => caller.exitCode !== null, 60000, 'the caller to report and exit')
  assert.doesNotMatch(out, /YESTERDAY/, 'the predecessor\'s identity was reported as this run\'s')

  // The moment that used to lie: a live lane, a terminal record and an outbox
  // all present at once.
  const report = statusReport(cwd, 'gen')
  assert.equal(statusExitCode(report), EXIT_RUNNING,
    'a predecessor\'s finished record plus its outbox were reported as this run finishing')
  // The old answer is retired rather than deleted, and named where it went.
  assert.ok(report.strays.some((name) => name.startsWith('gen.superseded-')),
    `the predecessor's outbox was not retired: ${report.strays.join(', ')}`)

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'gen')), 60000, 'the lane to finish')
})

test('status works against a run directory this dispatcher never created', () => {
  // Named in HANDOFF as unproven, and it is the first thing an advisor asked
  // about the generation binding: with no routing file there is nothing to bind
  // to. A lane started by `loop-runner.mjs`, or on another machine, still has
  // to be reportable — refusing there would make the tool useless exactly where
  // a person is most lost. So the binding protects the runs this dispatcher
  // started, and says nothing about the others rather than hiding them.
  const cwd = tempDir('acp-dispatch-foreign-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.mailbox-out'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'foreign.json'), JSON.stringify({
    started_at: '2026-08-16T21:36:10.138Z',
    liveness_state: 'completed', termination_reason: 'none',
    effective_identity: 'someone-elses-lane[max]', identity_status: 'matched',
  }))
  writeFileSync(outboxPath(cwd, 'foreign'), 'their answer\n')

  const report = statusReport(cwd, 'foreign')
  assert.equal(report.routing, null, 'the premise is gone: this directory has routing')
  assert.equal(report.terminated, true, 'a foreign run was hidden rather than reported')
  assert.equal(statusExitCode(report), EXIT_OUTBOX)
  assert.match(formatStatus(report), /someone-elses-lane/)

  // And a running foreign lane is still running, not settled by an absent pid.
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'foreign.json'), JSON.stringify({
    started_at: '2026-08-16T21:36:10.138Z',
    liveness_state: 'active', termination_reason: 'none',
    next_lease_expiry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }))
  assert.equal(statusExitCode(statusReport(cwd, 'foreign')), EXIT_RUNNING)
})

test('a symlinked DIRECTORY on the way to a run artifact is refused before anything spawns', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symlinks')
  // Round seven's only blocker, and it was a comment of mine that was simply
  // false: `O_NOFOLLOW` was applied to the leaf while a comment claimed the leaf
  // is "the component an attacker can pre-position". Pathname resolution walks
  // the PARENTS, so a symlinked `.tmux-teams` — or any one artifact directory —
  // sends an `O_TRUNC` write to a same-named file wherever it points.
  //
  // Four distinct parents, because one leaf test generalising was the mistake
  // that got here. And the refusal has to happen BEFORE the spawn: a secure
  // refusal after `unref()` leaves a detached lane alive with no trustworthy
  // records, which is operationally worse than not starting.
  for (const chain of [['.tmux-teams'], ['.tmux-teams', 'runner-logs'],
    ['.tmux-teams', 'dispatch-pids'], ['.tmux-teams', 'dispatch-routing']]) {
    const cwd = tempDir('acp-dispatch-dirlink-')
    const brief = join(cwd, 'brief.md')
    writeFileSync(brief, 'do the thing\n')
    const outside = tempDir('acp-dispatch-victimdir-')
    // Same-named files the escape would truncate.
    for (const victim of ['dirlink.log', 'dirlink', 'dirlink.json']) {
      writeFileSync(join(outside, victim), 'PRECIOUS\n')
    }
    // Build the chain, making the LAST element a symlink out of the run tree.
    let here = cwd
    for (const part of chain.slice(0, -1)) {
      here = join(here, part)
      mkdirSync(here, { recursive: true })
    }
    symlinkSync(outside, join(here, chain.at(-1)))

    const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'dirlink', brief, '120'],
      { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '5' }), timeout: 30000 })

    const label = chain.join('/')
    assert.notEqual(r.status, 0, `${label}: a hostile run directory was dispatched into`)
    assert.match(`${r.stdout}${r.stderr}`, /resolves outside it|not a real directory inside it|symlink/,
      `${label}: refused for the wrong reason: ${r.stderr}`)
    // Round eight's blocker 1: the refusal must not have CREATED anything out
    // there first. `mkdirSync(recursive)` ran before containment was
    // established, so a symlinked `.tmux-teams` had the missing artifact
    // directory made in the victim tree and only then refused — a fail-closed
    // preflight that mutates outside the root before failing is not fail-closed.
    for (const made of ['runner-logs', 'dispatch-pids', 'dispatch-routing']) {
      assert.ok(!existsSync(join(outside, made)),
        `${label}: the preflight created ${made} outside the run root before refusing`)
    }
    for (const victim of ['dirlink.log', 'dirlink', 'dirlink.json']) {
      assert.equal(readFileSync(join(outside, victim), 'utf8'), 'PRECIOUS\n',
        `${label}: the escape truncated ${victim} outside the run directory`)
    }
    // Nothing started. A companion writes its first liveness snapshot before it
    // spawns the adapter, so its absence in either place is the evidence.
    assert.ok(!existsSync(join(outside, 'liveness')), `${label}: a lane was spawned into the victim directory`)
    assert.ok(!existsSync(join(cwd, '.tmux-teams', 'liveness', 'dirlink.json')),
      `${label}: a lane was spawned before the refusal`)
    assert.doesNotMatch(r.stdout, /dispatched mock/, `${label}: the refusal came after the spawn`)
  }
})

test('a symlinked .mailbox-out cannot make the outbox retirement rename a stranger\'s file', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symlinks')
  // Round eight's blocker 2, and the sharpest kind of finding: the FOURTH write
  // path, in exactly the class round seven had just fixed for the other three.
  // `spawnDetached` retires a predecessor's outbox with `renameSync`, and
  // `.mailbox-out` was the one directory not in the containment list — so a
  // symlink there plus an outside regular file named for the task moved a
  // stranger's file, before anything spawned, with no receipt for where it went.
  const cwd = tempDir('acp-dispatch-outboxlink-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const outside = tempDir('acp-dispatch-outboxvictim-')
  writeFileSync(join(outside, 'linked'), 'PRECIOUS\n')
  symlinkSync(outside, join(cwd, '.mailbox-out'))

  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'linked', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '5' }), timeout: 30000 })

  assert.notEqual(r.status, 0, 'a run directory with a symlinked .mailbox-out was dispatched into')
  assert.equal(readFileSync(join(outside, 'linked'), 'utf8'), 'PRECIOUS\n',
    'the outbox retirement renamed a file outside the run root')
  assert.deepEqual(readdirSync(outside), ['linked'],
    `the outside tree gained or lost entries: ${readdirSync(outside).join(', ')}`)
  await sleep(1200)
  assert.ok(!existsSync(join(cwd, '.tmux-teams', 'liveness', 'linked.json')),
    'a lane was spawned before the refusal')
})

test('a symlinked run root is resolved, used, and REPORTED rather than silently adopted', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symlinks')
  // Round nine, blocker 1: the run root sat outside the component walk
  // entirely, so a `cwd` that was itself a symlink received both artifact trees
  // without ever being examined. Refusing would be wrong — a caller who passes
  // an alias usually means "use this path for its target", and this tool has to
  // work against directories other people made. What was missing is that the
  // target became the semantic root in silence.
  const real = tempDir('acp-dispatch-realroot-')
  const holder = tempDir('acp-dispatch-alias-')
  const alias = join(holder, 'alias')
  symlinkSync(real, alias)
  const brief = join(real, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(real, 'release')

  const caller = spawn(process.execPath, [DISPATCH, 'mock', alias, 'aliased', brief, '120'], {
    cwd: real, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({ MOCK_GATE_STAGE: 'prompt', MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000' }),
  })
  let out = ''
  caller.stdout.on('data', (chunk) => { out += chunk })
  await waitFor(() => caller.exitCode !== null, 60000, 'the caller to report and exit')
  assert.equal(caller.exitCode, 0, `a symlinked run root was refused: ${out}`)
  assert.match(out, /run directory resolves to: /,
    'the alias became the semantic root without the operator being told')
  assert.ok(out.includes(realpathSync(real)), 'the reported root is not the resolved one')
  // Everything landed in the real directory, under its real name.
  assert.ok(existsSync(join(realpathSync(real), '.tmux-teams', 'liveness', 'aliased.json')))

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(realpathSync(real), 'aliased')), 60000, 'the lane to finish')
})

test('state this dispatcher creates is owner-only, because it carries prose', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX modes')
  // Round nine, blocker 2, REPRODUCED by the reviewer: 0755 under an ordinary
  // umask. This repository's ledger writer already states that prose-bearing
  // state is owner-only and enforces 0700/0600, and an ACP runner log carries
  // prompts, model output and diagnostics — it is the most prose-bearing file
  // here and it was the one created with a default mode and never chmodded.
  const cwd = tempDir('acp-dispatch-modes-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')
  const caller = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'modes', brief, '120'], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({ MOCK_GATE_STAGE: 'prompt', MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000' }),
  })
  await waitFor(() => caller.exitCode !== null, 60000, 'the caller to report and exit')

  const mode = (p) => (statSync(p).mode & 0o777).toString(8)
  for (const dir of ['.tmux-teams', join('.tmux-teams', 'runner-logs'),
    join('.tmux-teams', 'dispatch-pids'), join('.tmux-teams', 'dispatch-routing'), '.mailbox-out']) {
    assert.equal(mode(join(cwd, dir)), '700', `${dir} is not owner-only`)
  }
  assert.equal(mode(logPath(cwd, 'modes')), '600', 'the runner log is readable by others')
  assert.equal(mode(pidPath(cwd, 'modes')), '600')

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'modes')), 60000, 'the lane to finish')
})

test('a nonsense poll interval is refused rather than spinning a core for the whole budget', () => {
  // A release panel found `ACP_DISPATCH_POLL_SEC` converted and never
  // validated: NaN, zero or a negative turned the wait loop into zero-delay
  // polling. The same class had already been fixed for the boot budget — and
  // missed here, because the fix went to the value that had bitten rather than
  // to the kind of value.
  const cwd = tempDir('acp-dispatch-poll-')
  for (const bad of ['soon', '', '0', '-1', 'NaN']) {
    const r = spawnSync(process.execPath, [DISPATCH, 'wait', cwd, 'poll', '5'],
      { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_POLL_SEC: bad }), timeout: 20000 })
    assert.equal(r.status, 2, `ACP_DISPATCH_POLL_SEC="${bad}" was accepted`)
    assert.match(r.stderr, /ACP_DISPATCH_POLL_SEC must be a positive number/)
  }
})

test('boot reports on the ACKNOWLEDGED identity status, not on a non-empty string', () => {
  // A release panel caught a truthy `effective_identity` standing in for an
  // ACCEPTED identity — the exact substitution this plugin exists to refuse,
  // committed inside the check written to enforce it. A record carrying an
  // identity with `identity_status: 'missing'` is not a booted lane.
  const cwd = tempDir('acp-dispatch-identitystatus-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  const spawnedAt = new Date().toISOString()
  const spawnNonce = 'ident-nonce'
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'ident.json'),
    JSON.stringify({ worker: 'mock', spawnedAt, spawnNonce, env: {} }))
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'ident.json'), JSON.stringify({
    started_at: spawnedAt, liveness_state: 'active', termination_reason: 'none',
    effective_identity: 'looks-like-an-identity', identity_status: 'missing',
    spawn_nonce: spawnNonce,
  }))
  // statusReport is the reader that shares this record; the boot path's own
  // acceptance is asserted through the dispatch tests above. Here the point is
  // that a 'missing' status is visible rather than dressed up as an identity.
  const report = statusReport(cwd, 'ident')
  assert.equal(report.identityStatus, 'missing')
  assert.match(formatStatus(report), /looks-like-an-identity \(missing\)/,
    'a status that was never accepted is reported as though it had been')
})

test('a second lane under a live task id is refused, and the leaf policy is not symlink-only', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX links')
  const cwd = tempDir('acp-dispatch-admission-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const releaseFile = join(cwd, 'release')

  // One live lane, held at the prompt.
  const first = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'twice', brief, '120'], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: laneEnv({ MOCK_GATE_STAGE: 'prompt', MOCK_GATE_RELEASE_FILE: releaseFile,
      MOCK_GATE_WATCHDOG_MS: '60000' }),
  })
  await waitFor(() => first.exitCode !== null, 60000, 'the first caller to report and exit')

  // A release panel: two companions under one task id share the liveness file,
  // the pid file and the outbox path, and the operator cannot tell whose answer
  // they read.
  const second = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'twice', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 30000 })
  assert.notEqual(second.status, 0, 'a second lane was admitted under a live task id')
  assert.match(second.stderr, /already running as pid \d+/)

  writeFileSync(releaseFile, 'go\n')
  await waitFor(() => existsSync(outboxPath(cwd, 'twice')), 60000, 'the first lane to finish')

  // Hard links and special files are not symlinks, and the policy used to name
  // only symlinks. A hard link shares the victim's inode and `lstat` calls it a
  // regular file.
  const hard = tempDir('acp-dispatch-hardlink-')
  const victim = join(hard, 'victim')
  writeFileSync(victim, 'PRECIOUS\n')
  mkdirSync(join(hard, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  linkSync(victim, join(hard, '.tmux-teams', 'dispatch-pids', 'linked'))
  writeFileSync(join(hard, 'brief.md'), 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', hard, 'linked', join(hard, 'brief.md'), '120'],
    { cwd: hard, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '5' }), timeout: 30000 })
  assert.notEqual(r.status, 0, 'a hard-linked pid file was written through')
  assert.match(`${r.stdout}${r.stderr}`, /hard-linked/)
  assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS\n')
})

test('a recovery command names the brief and the stall the dispatch actually used', () => {
  // A release panel found the recorded brief ignored and a literal
  // `<recovery-brief-file>` emitted into a command line — shell syntax, in the
  // one string whose whole purpose is being pasted.
  const withRouting = resumeCommand('/repo', 'r', {
    sessionId: 's', routing: { worker: 'codex', briefFile: '/tmp/the brief.md', stallSec: 2400, env: {} },
  })
  assert.match(withRouting, /'\/tmp\/the brief\.md' 2400/,
    'the recorded brief and stall were dropped in favour of a placeholder')
  // The placeholder survives only when nothing was recorded to name, and it is
  // no longer shell metacharacters.
  const bare = resumeCommand('/repo', 'r', { sessionId: 's', routing: { worker: 'codex', env: {} } })
  assert.doesNotMatch(bare, /[<>]/, 'the placeholder is still shell syntax')
})

test('a lane that FINISHED before the boot poll is a success, not a consultation that never started', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // The gemini panel lane's first finding, and the worst kind: a guard against
  // failure that had quietly taken ownership of the happy path. `watchBoot`
  // asked `hasTerminated`, which includes `completed`, so a quick consultation
  // that answered before the poll came round was told "this consultation never
  // started" and exited 2.
  const cwd = tempDir('acp-dispatch-quick-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'quick', brief, '120'],
    { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '30' }), timeout: 60000 })
  assert.equal(r.status, 0, `a fast successful lane was reported as a failure:\n${r.stdout}${r.stderr}`)
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /never started/)
  assert.ok(existsSync(outboxPath(cwd, 'quick')), 'the lane did not actually finish')

  // A terminal FAILURE at boot is still a failure.
  const bad = tempDir('acp-dispatch-refused2-')
  writeFileSync(join(bad, 'brief.md'), 'do the thing\n')
  const r2 = spawnSync(process.execPath, [DISPATCH, 'mock', bad, 'refused', join(bad, 'brief.md'), '120'], {
    cwd: bad, encoding: 'utf8',
    env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '30', MOCK_CONFIG_IDENTITY: '1',
      MOCK_MODEL_OPTIONS: 'something-else', MOCK_MODEL_OPTIONS_STRICT: '1',
      ACP_MODEL: 'not-on-offer', ACP_EXPECT_MODEL: 'not-on-offer' }),
  })
  assert.notEqual(r2.status, 0, 'an identity refusal was reported as a success')
})

test('a recorded stall survives being a string, which is what argv gives', () => {
  // The gemini panel lane again: `stallSec` is recorded from argv and argv is
  // strings, so `Number.isFinite('2400')` was false and EVERY recovery command
  // silently reset a custom stall to the default. A fallback that fires always
  // is indistinguishable from not having the feature.
  const asString = resumeCommand('/repo', 'r', {
    sessionId: 's', routing: { worker: 'codex', briefFile: '/b.md', stallSec: '2400', env: {} },
  })
  assert.match(asString, /'\/b\.md' 2400$/m, 'a stall recorded as a string was reset to the default')
  const asNumber = resumeCommand('/repo', 'r', {
    sessionId: 's', routing: { worker: 'codex', briefFile: '/b.md', stallSec: 1800, env: {} },
  })
  assert.match(asNumber, /'\/b\.md' 1800$/m)
  const nonsense = resumeCommand('/repo', 'r', {
    sessionId: 's', routing: { worker: 'codex', briefFile: '/b.md', stallSec: 'soon', env: {} },
  })
  // 600, not 900. `acp-companion.mjs` falls back to `positiveNumber(leaseArg, 600)`,
  // so a resume command offering 900 told the operator to use a lease the
  // original run never had. A panel lane read the two files against each other.
  assert.match(nonsense, /'\/b\.md' 600$/m, 'an unusable recorded stall must fall back, not propagate')
  assert.equal(COMPANION_DEFAULT_STALL_SEC, 600)
  // and the constant is not free to drift from the file that owns the default
  const companion = readFileSync(join(dirname(DISPATCH), 'acp-companion.mjs'), 'utf8')
  assert.match(companion, new RegExp(`positiveNumber\\(leaseArg, ${COMPANION_DEFAULT_STALL_SEC}\\)`),
    'the dispatcher and the companion disagree about the default stall')
})

test('a reused pid cannot suppress the lease, and a refusal is a sentence not a stack', () => {
  // A panel lane: a live pid settled "still running" forever. Pid numbers are
  // reused, so an unrelated process inheriting the number would report a
  // long-dead lane as running AND refuse every new dispatch under that task id.
  // A live pid wins over an unexpired lease; an EXPIRED lease still counts.
  const cwd = tempDir('acp-dispatch-reuse-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  writeFileSync(pidPath(cwd, 'reused'), `${process.pid}\n`)   // alive by definition
  const record = (leaseOffsetMs) => writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'reused.json'),
    JSON.stringify({
      liveness_state: 'tool_running', termination_reason: 'none',
      observed_at: new Date().toISOString(),
      next_lease_expiry_at: new Date(Date.now() + leaseOffsetMs).toISOString(),
    }))

  record(15 * 60 * 1000)
  assert.equal(statusReport(cwd, 'reused').notReporting, false, 'a healthy lane was called stopped')
  record(-60 * 1000)
  assert.equal(statusReport(cwd, 'reused').notReporting, true,
    'a live pid suppressed an expired lease — a reused number would hide a dead lane for good')

  // Every refusal this file raises arrives as a throw, and the entry had no
  // rejection handler: Node turned it into an unhandled rejection with a stack
  // and no sentence an operator can act on.
  const hostile = tempDir('acp-dispatch-throwpath-')
  writeFileSync(join(hostile, 'brief.md'), 'x\n')
  const outside = tempDir('acp-dispatch-throwvictim-')
  mkdirSync(join(hostile, '.tmux-teams'), { recursive: true })
  symlinkSync(outside, join(hostile, '.tmux-teams', 'liveness'))
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', hostile, 'thrown', join(hostile, 'brief.md'), '120'],
    { cwd: hostile, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '5' }), timeout: 30000 })
  assert.equal(r.status, 2, `a refusal did not exit 2: ${r.stderr}`)
  assert.doesNotMatch(r.stderr, /at .*acp-dispatch\.mjs:\d+/, 'the operator was handed a stack trace')
  assert.match(r.stderr, /resolves outside it|not a real directory inside it/)
})

test('a dangling symlink is the dangerous one, and a future-stamped record is not ours', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX links')
  // `existsSync` FOLLOWS the link and answers false for a DANGLING one, so the
  // single kind of pre-positioned symlink guaranteed to redirect our write —
  // aimed at a file that does not exist yet, waiting for us to create it —
  // walked straight past the leaf check. The harmless case was guarded and the
  // dangerous one was not.
  const cwd = tempDir('acp-dispatch-dangling-')
  const victimDir = tempDir('acp-dispatch-danglingvictim-')
  const victim = join(victimDir, 'stolen-outbox')
  mkdirSync(join(cwd, '.mailbox-out'), { recursive: true })
  symlinkSync(victim, outboxPath(cwd, 'dangle'))
  assert.equal(existsSync(outboxPath(cwd, 'dangle')), false, 'the fixture is not a dangling link')
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'dangle', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '5' }), timeout: 30000 })
  assert.notEqual(r.status, 0, 'a dangling outbox symlink was written through')
  assert.match(`${r.stdout}${r.stderr}`, /symlink/)
  assert.equal(existsSync(victim), false, 'the write landed on the symlink target')
})

test('three families on one line: a live pid never settles, and completed never skips the identity gate', () => {
  // hasStopped was raised as a BLOCKER by all THREE panel families in one round
  // — gemini, openai and qwen — and openai marked it REPRODUCED. The lease
  // measures MEANINGFUL PROGRESS, so a companion in a long tool call reaches
  // it, records a suspected stall, extends it and carries on. Settling on that
  // makes `wait` abandon a working lane and print resume advice for a turn that
  // is still running.
  const cwd = tempDir('acp-dispatch-livepid-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  writeFileSync(pidPath(cwd, 'alive'), `${process.pid}\n`)
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'alive.json'), JSON.stringify({
    liveness_state: 'tool_running', termination_reason: 'none',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() - 60_000).toISOString(),
  }))
  const r = statusReport(cwd, 'alive')
  assert.equal(r.settled, false, 'an expired lease settled a lane whose pid is alive')
  assert.equal(r.leaseStale, true, 'leaseStale was unreachable for every expired nonterminal record')
  assert.equal(r.notReporting, true, 'a lane that has gone quiet is still worth reporting as quiet')
  assert.notEqual(statusExitCode(r), EXIT_NO_OUTBOX,
    'wait would have exited 2 and offered resume advice for a running lane')

  // and the two cases a caller must be able to tell apart
  assert.match(r.stoppedBecause, /still alive/)
  rmSync(pidPath(cwd, 'alive'))
  const noPid = statusReport(cwd, 'alive')
  assert.equal(noPid.settled, true, 'with no pid to ask, the lease is the only evidence there is')
  assert.match(noPid.stoppedBecause, /lease expired/)
})

test('a live pid with a long-dead lease does not lock the task id forever', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX pids')
  // The false-POSITIVE half of what a panel lane found in admission. Pid
  // numbers are reused: an unrelated process inheriting the number would refuse
  // every future dispatch under that task id, permanently. A pid is evidence of
  // a process, not of THIS lane — the lease is what says the lane is alive.
  const cwd = tempDir('acp-dispatch-notlocked-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  writeFileSync(pidPath(cwd, 'reclaim'), `${process.pid}\n`)   // alive, and not ours
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'reclaim.json'), JSON.stringify({
    liveness_state: 'tool_running', termination_reason: 'none',
    observed_at: new Date(Date.now() - 3_600_000).toISOString(),
    next_lease_expiry_at: new Date(Date.now() - 3_000_000).toISOString(),
  }))
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'reclaim', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  // THIS ASSERTION WAS BACKWARDS, and two panel rounds are why. Round five
  // (openai): a reused pid must not lock a task id forever, so admit. Round six
  // (openai, REPRODUCED): admission must not admit a second writer for a lane
  // `status` calls unsettled, so refuse. Same family, opposite directions, and
  // a pid plus a lease cannot tell a wedged lane from a recycled number.
  //
  // A duplicate writer is unrecoverable; a refusal is not. So it refuses AND
  // names the way out — which is the part that answers round five.
  assert.notEqual(r.status, 0, 'a second writer was admitted under a live task id')
  assert.match(`${r.stdout}${r.stderr}`, /already running/)
  assert.match(`${r.stdout}${r.stderr}`, /remove \.tmux-teams\/dispatch-pids\/reclaim/,
    'the refusal did not tell the operator how to reclaim a task id from a recycled pid')

  // and taking the documented escape works
  rmSync(pidPath(cwd, 'reclaim'))
  const again = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'reclaim', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.equal(again.status, 0, `the documented escape did not work:\n${again.stdout}${again.stderr}`)
  const superseded = readdirSync(join(cwd, '.tmux-teams', 'liveness'))
  assert.ok(superseded.some((f) => f.includes('.superseded-')),
    `the predecessor liveness record was not retired: ${superseded.join(', ')}`)
})

test('a planted predecessor record cannot lend its session or its silence to a new run', async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('POSIX')
  // A panel lane reproduced a fresh dispatch printing `session_id:
  // predecessor-session` and offering ACP_RESUME for a session that was never
  // this run's, because `belongsToThisRun` authenticates by TIMESTAMP alone —
  // no nonce, no task id, no worker — so a record stamped inside the accepted
  // window reads as ours.
  //
  // A bound cannot fix that; removal can. The predecessor's leaves are retired
  // at dispatch, so what this asserts is the OUTCOME: the identity and session
  // reported are the ones this run's lane produced, not the planted ones.
  const cwd = tempDir('acp-dispatch-ghost-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'sessions'), { recursive: true })
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  writeFileSync(sessionPath(cwd, 'ghost'), 'predecessor-session\n')
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'ghost.json'), JSON.stringify({
    liveness_state: 'completed', termination_reason: 'none',
    started_at: new Date(Date.now() + 30_000).toISOString(),
    observed_at: new Date(Date.now() + 30_000).toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 900_000).toISOString(),
  }))
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'ghost', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '10' }), timeout: 60000 })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 0, `the dispatch failed outright:\n${out}`)
  assert.match(out, /session_id: sess_mock/, `the planted session was inherited:\n${out}`)
  assert.doesNotMatch(out, /predecessor-session/, 'a session that was never this run\'s reached the operator')
  assert.match(out, /effective_identity: gpt-mock/, 'the reported identity was not this lane\'s')
  for (const dir of ['liveness', 'sessions']) {
    const kept = readdirSync(join(cwd, '.tmux-teams', dir))
    assert.ok(kept.some((f) => f.includes('.superseded-')),
      `the predecessor ${dir} leaf was neither retired nor kept: ${kept.join(', ')}`)
  }
})

test('the suite is green in a shell that carries ACP variables of its own', () => {
  // A panel lane read `laneEnv` and predicted this; the reproduction took one
  // command and turned 35 pass / 0 fail into 23 / 12. A suite that is green
  // only in the author's shell is the same class as the test that read the
  // author's `~/.config/claude-profiles` and let two releases ship on red CI.
  //
  // Asserted on `laneEnv` itself rather than by re-running the suite: a test
  // that spawns the suite inside the suite is a way to spend two minutes
  // proving what one object literal already says.
  const hostile = ['ACP_MODEL', 'ACP_EXPECT_MODEL', 'ACP_REASONING_EFFORT',
    'ACP_EXPECT_REASONING_EFFORT', 'ACP_AGENT_ID', 'ACP_SESSION_OPERATION']
  const saved = Object.fromEntries(hostile.map((k) => [k, process.env[k]]))
  try {
    for (const k of hostile) process.env[k] = 'from-the-callers-shell'
    const env = laneEnv()
    for (const k of hostile) {
      assert.notEqual(env[k], 'from-the-callers-shell', `${k} leaked in from the caller's shell`)
    }
    // and what the lane sets on purpose still arrives
    assert.match(env.ACP_CMD, /mock-acp-agent\.mjs$/)
    assert.equal(env.ACP_STALL_POLICY, 'cancel')
    assert.equal(laneEnv({ ACP_MODEL: 'named-on-purpose' }).ACP_MODEL, 'named-on-purpose')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('status does not follow a link out of the tree, and the old traversal fixture missed its own target', () => {
  // A panel lane found TWO things here. First the fixture: from
  // `<cwd>/run/.tmux-teams/liveness`, a task id of `../../secret` normalizes to
  // `<cwd>/run/secret.json` while the old test planted `<cwd>/secret.json`, so
  // its "no secret was reflected" assertion passed without the traversal ever
  // reaching the file. A vacuous assertion is worse than none: it reads as
  // coverage. This plants the secret where the traversal actually lands.
  const cwd = tempDir('acp-dispatch-read-')
  const run = join(cwd, 'run')
  mkdirSync(join(run, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(run, '.tmux-teams', 'sessions'), { recursive: true })
  writeFileSync(join(run, 'secret.json'), JSON.stringify({
    liveness_state: 'completed', effective_identity: 'SECRETVALUE', identity_status: 'matched',
  }))
  const traversed = spawnSync(process.execPath, [DISPATCH, 'status', run, '../../secret'],
    { encoding: 'utf8', env: laneEnv(), timeout: 20000 })
  assert.ok(!`${traversed.stdout}${traversed.stderr}`.includes('SECRETVALUE'),
    'a task id that traverses out of the tree reflected the file it landed on')

  // Second, and the reason the read side needed a policy at all: `status`
  // followed a SESSION symlink pointing anywhere and reflected what it found
  // into the pasteable ACP_RESUME command. The dispatch-side guards refuse to
  // WRITE through a link and said nothing about reading one.
  const outside = join(cwd, 'not-ours')
  writeFileSync(outside, 'STOLENSESSION\n')
  symlinkSync(outside, sessionPath(run, 'linked'))
  writeFileSync(join(run, '.tmux-teams', 'liveness', 'linked.json'), JSON.stringify({
    liveness_state: 'failed', termination_reason: 'protocol_error',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() - 1000).toISOString(),
  }))
  const linked = spawnSync(process.execPath, [DISPATCH, 'status', run, 'linked'],
    { encoding: 'utf8', env: laneEnv(), timeout: 20000 })
  const out = `${linked.stdout}${linked.stderr}`
  assert.ok(!out.includes('STOLENSESSION'),
    `a session symlink was followed and printed into the resume command:\n${out}`)
  // and a hostile leaf reads as ABSENT rather than crashing the report — a
  // diagnostic that refuses to print helps nobody.
  assert.match(out, /liveness_state: failed/)

  // THE PID LEAF, which `recordedPid()` used to read with a bare `readFileSync`
  // — a panel lane reported the "universal read boundary" had a hole in the one
  // reader admission depends on, and a mutation of this file confirmed the gap
  // was untested. A symlinked pid file must read as ABSENT, not be followed.
  const foreignPid = join(cwd, 'not-our-pid')
  writeFileSync(foreignPid, `${process.pid}\n`)
  mkdirSync(join(run, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  symlinkSync(foreignPid, join(run, '.tmux-teams', 'dispatch-pids', 'linkedpid'))
  writeFileSync(join(run, '.tmux-teams', 'liveness', 'linkedpid.json'), JSON.stringify({
    liveness_state: 'tool_running', termination_reason: 'none',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() - 60_000).toISOString(),
  }))
  const viaLink = statusReport(run, 'linkedpid')
  assert.equal(viaLink.pid, null,
    'a symlinked pid file was followed, so a stranger\'s pid decided this lane\'s state')
  // with no trustworthy pid, the expired lease is the only evidence there is
  assert.equal(viaLink.settled, true)

  // A hard-linked liveness record is somebody else's file too.
  const victim = join(cwd, 'victim.json')
  writeFileSync(victim, JSON.stringify({ liveness_state: 'completed', effective_identity: 'HARDLINKED' }))
  linkSync(victim, join(run, '.tmux-teams', 'liveness', 'hard.json'))
  const hard = spawnSync(process.execPath, [DISPATCH, 'status', run, 'hard'],
    { encoding: 'utf8', env: laneEnv(), timeout: 20000 })
  assert.ok(!`${hard.stdout}${hard.stderr}`.includes('HARDLINKED'))
})

test('the dispatch command each advisor skill documents gets past the companion preconditions', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // THE GUARD THAT WAS MISSING, and its absence produced the worst finding of
  // the release. Yesterday `ACP_SESSION_RECEIPT_REQUIRED=1` was added to all
  // four documented advisor commands to close a fail-open identity guarantee,
  // and the test asserted THE FLAG IS PRESENT — proof that I typed it. The
  // companion requires `ACP_SESSION_OPERATION=new|load` whenever that flag is
  // set and exits 2 BEFORE prompt delivery otherwise, so every documented
  // command was broken. All three panel families reported it.
  //
  // WHAT THIS PROVES AND WHAT IT DOES NOT. It runs each documented command's
  // own environment and asserts the companion does not refuse it on a usage
  // preconditionrather than checking that a string appears in a file. It does
  // NOT prove an end-to-end consultation: receipt-required mode correctly
  // refuses an arbitrary `ACP_CMD` without an execution profile, so
  // substituting the mock is itself rejected further down. That refusal is a
  // real protection and building a signed profile here would test the profile
  // machinery rather than the documented command.
  const SKILLS = join(dirname(DISPATCH), '..', '..')
  for (const skill of ['codex-advisor', 'claude-advisor']) {
    const text = readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8')
    const blocks = text.split('```bash').slice(1).map((b) => b.split('```')[0])
      .filter((b) => /acp-dispatch\.mjs[\s\\]+\n?\s*(codex|claude) </.test(b))
      .filter((b) => !b.includes('ACP_RESUME'))
    assert.ok(blocks.length >= 1, `${skill}: no fresh-dispatch block found`)

    for (const block of blocks) {
      const cwd = tempDir(`acp-doc-${skill}-`)
      writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
      const env = { ...laneEnv() }
      for (const [, k, v] of block.matchAll(/^\s*([A-Z_][A-Z0-9_]*)="?([^"\\\n]*)"?\s*\\?$/gm)) {
        if (['ACP_MODEL', 'ACP_EXPECT_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR'].includes(k)) continue
        env[k] = v.trim()
      }
      assert.equal(env.ACP_SESSION_RECEIPT_REQUIRED, '1',
        `${skill} documents a dispatch whose receipt may silently not exist`)
      spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'doc', join(cwd, 'brief.md'), '120'],
        { cwd, encoding: 'utf8', env, timeout: 90000 })
      const log = join(cwd, '.tmux-teams', 'runner-logs', 'doc.log')
      assert.ok(existsSync(log), `${skill}: the documented command never reached the companion`)
      const text2 = readFileSync(log, 'utf8')
      assert.doesNotMatch(text2, /requires explicit ACP_SESSION_OPERATION/,
        `${skill}'s documented command is refused before prompt delivery:\n${text2.slice(0, 600)}`)
      // it got as far as the receipt stage, which is past every usage check
      assert.match(text2, /\[receipt\]|receipt committed/,
        `${skill}'s documented command never reached the receipt stage:\n${text2.slice(0, 600)}`)
    }
  }
})

test('a hostile PARENT directory redirects no read, and a missing pid leaf is not proof of quiet', () => {
  // BLOCKER 1, REPRODUCED by a panel lane AFTER the leaf check went in:
  // `lstat` on the final component says nothing about `.tmux-teams` or
  // `sessions` being symlinks, so the boundary called universal covered one
  // component of the path. Second time a fix here covered the case I pictured
  // rather than the case that was named.
  const cwd = tempDir('acp-dispatch-parentlink-')
  const elsewhere = tempDir('acp-dispatch-parentlink-target-')
  mkdirSync(join(elsewhere, 'sessions'), { recursive: true })
  writeFileSync(join(elsewhere, 'sessions', 'p'), 'STOLENSESSION\n')
  mkdirSync(join(elsewhere, 'liveness'), { recursive: true })
  writeFileSync(join(elsewhere, 'liveness', 'p.json'), JSON.stringify({
    liveness_state: 'completed', effective_identity: 'NOTOURS', identity_status: 'matched',
  }))
  symlinkSync(elsewhere, join(cwd, '.tmux-teams'))
  const report = statusReport(cwd, 'p')
  assert.equal(report.sessionId, null, 'a symlinked .tmux-teams redirected the session read')
  assert.notEqual(report.identity, 'NOTOURS', 'a symlinked parent supplied this run\'s identity')

  // BLOCKER 2, REPRODUCED: a MISSING pid leaf is not evidence that nothing is
  // running — the leaf can be refused by the read policy, deleted, or never
  // written. Admission asked `recordedPid` and stopped, so a lane whose
  // liveness says it is mid-turn got a second writer whenever its pid file was
  // unreadable.
  const live = tempDir('acp-dispatch-nopid-')
  mkdirSync(join(live, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(live, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  writeFileSync(join(live, 'brief.md'), 'do the thing\n')
  const spawnedAt = new Date(Date.now() - 60_000).toISOString()
  const busyNonce = 'busy-nonce'
  writeFileSync(join(live, '.tmux-teams', 'dispatch-routing', 'busy.json'),
    JSON.stringify({ worker: 'mock', spawnedAt, spawnNonce: busyNonce, env: {} }))
  writeFileSync(join(live, '.tmux-teams', 'liveness', 'busy.json'), JSON.stringify({
    liveness_state: 'tool_running', termination_reason: 'none',
    started_at: new Date(Date.parse(spawnedAt) + 1000).toISOString(),
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 900_000).toISOString(),
    spawn_nonce: busyNonce,
  }))
  // no pid leaf at all
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', live, 'busy', join(live, 'brief.md'), '120'],
    { cwd: live, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.notEqual(r.status, 0, 'a second writer was admitted for a lane that is still reporting progress')
  assert.match(`${r.stdout}${r.stderr}`, /still reporting progress and its pid file/)
})

test('a liveness record whose nonce is a stranger\'s does not block admission', () => {
  // The admission call site passes the record through belongsToThisRun before
  // treating it as a live lane. The fixture above gives the liveness record the
  // SAME nonce as its routing record, so deleting that call changes nothing
  // there. Here the nonces DIFFER and everything else says "live": in-window
  // started_at, an unsettled state, a lease fifteen minutes out, no pid leaf.
  // With the check, the record belongs to nobody and admission proceeds.
  // Without it, a stray or forged liveness file blocks this task id forever.
  const cwd = tempDir('acp-dispatch-foreign-nonce-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  const spawnedAt = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'foreign.json'),
    JSON.stringify({ worker: 'mock', spawnedAt, spawnNonce: 'the-real-priors-nonce', env: {} }))
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'foreign.json'), JSON.stringify({
    liveness_state: 'tool_running', termination_reason: 'none',
    started_at: new Date(Date.parse(spawnedAt) + 1000).toISOString(),
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 900_000).toISOString(),
    spawn_nonce: 'a-strangers-nonce',
  }))
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'foreign', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60_000 })
  assert.equal(r.status, 0,
    `admission refused over a liveness record whose nonce does not match the recorded routing:\n${r.stdout}${r.stderr}`)
})

test('the outbox is read through the boundary, and a case-only task id is refused', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX links')
  // REPRODUCED by a lane: `statusReport` decided whether the run had finished
  // with `existsSync(outbox) && lstatSync(outbox).isFile()` — the LEAF's type
  // and nothing above it — so a symlinked `.mailbox-out` answered the one
  // question the exit code is built from.
  const cwd = tempDir('acp-dispatch-outboxlink-')
  const elsewhere = tempDir('acp-dispatch-outboxlink-target-')
  writeFileSync(join(elsewhere, 'o'), 'SOMEBODY ELSE\n')
  symlinkSync(elsewhere, join(cwd, '.mailbox-out'))
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'o.json'), JSON.stringify({
    liveness_state: 'completed', termination_reason: 'none',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 900_000).toISOString(),
  }))
  const report = statusReport(cwd, 'o')
  assert.equal(report.outboxFound, false,
    'a symlinked .mailbox-out decided that this run had finished')
  assert.notEqual(statusExitCode(report), EXIT_OUTBOX,
    'the exit code said success on a stranger\'s file')

  // REPRODUCED: macOS and Windows default to case-insensitive filesystems, so
  // `Review` and `review` are two task ids here and one set of files on disk —
  // two lanes writing the same liveness, pid, routing and outbox while every
  // check says they are unrelated.
  const dir = tempDir('acp-dispatch-case-')
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'liveness', 'Review.json'), '{}')
  writeFileSync(join(dir, 'brief.md'), 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', dir, 'review', join(dir, 'brief.md'), '120'],
    { cwd: dir, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.notEqual(r.status, 0, 'two task ids differing only by case were both admitted')
  assert.match(`${r.stdout}${r.stderr}`, /differs only by case/)

  // and a genuinely different id in the same directory still works
  const ok = spawnSync(process.execPath, [DISPATCH, 'mock', dir, 'other', join(dir, 'brief.md'), '120'],
    { cwd: dir, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.equal(ok.status, 0, `an unrelated id was refused:\n${ok.stdout}${ok.stderr}`)
})

test('the cleanup will not kill a process older than this suite', () => {
  // Two panel families found the earlier hook dangerous for the same reason: it
  // read whatever pid files were lying in a temp directory and SIGKILLed the
  // GROUP, so a stale pid whose number the OS had recycled belonged to a
  // stranger — on the developer's own machine. It had already killed the test
  // runner once while being written.
  //
  // Ownership is decided by START TIME, not by the file. This asserts the
  // predicate directly, because the hook itself runs after every test and
  // cannot be observed from inside one.
  const dir = tempDir('acp-dispatch-ownership-')
  mkdirSync(join(dir, '.tmux-teams', 'dispatch-pids'), { recursive: true })

  // pid 1 has been running since long before this suite: never ours
  writeFileSync(join(dir, '.tmux-teams', 'dispatch-pids', 'ancient'), '1\n')
  assert.deepEqual(lanePidsUnder(dir), [],
    'the cleanup claimed a process that predates the suite')

  // and a pid that does not exist at all is not claimed either
  writeFileSync(join(dir, '.tmux-teams', 'dispatch-pids', 'gone'), '999999\n')
  assert.deepEqual(lanePidsUnder(dir), [])

  // a process started INSIDE this suite is ours — spawn one and check
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true })
  try {
    writeFileSync(join(dir, '.tmux-teams', 'dispatch-pids', 'ours'), `${child.pid}\n`)
    assert.deepEqual(lanePidsUnder(dir), [child.pid],
      'the cleanup did not recognise a process this suite started')
  } finally {
    try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

test('listing a directory is a read too, and a symlinked parent enumerates nothing', () => {
  // Two panel families named this: `strayOutboxes` listed `.mailbox-out` and
  // the case-collision scan listed `.tmux-teams/<dir>`, both by pathname and
  // neither through the boundary every FILE read goes through. A symlinked
  // parent made both enumerate somebody else's directory and report its
  // contents as this run's.
  const cwd = tempDir('acp-dispatch-listlink-')
  const elsewhere = tempDir('acp-dispatch-listlink-target-')
  writeFileSync(join(elsewhere, 'not-ours'), 'x\n')
  writeFileSync(join(elsewhere, 'also-not-ours'), 'x\n')
  symlinkSync(elsewhere, join(cwd, '.mailbox-out'))

  const report = statusReport(cwd, 'o')
  assert.deepEqual(report.strays, [],
    `a symlinked .mailbox-out was enumerated as this run's: ${report.strays.join(', ')}`)

  // and a real directory inside the tree still lists
  const honest = tempDir('acp-dispatch-listok-')
  mkdirSync(join(honest, '.mailbox-out'), { recursive: true })
  writeFileSync(join(honest, '.mailbox-out', 'somebody-elses-task'), 'x\n')
  assert.deepEqual(statusReport(honest, 'o').strays, ['somebody-elses-task'],
    'a real stray inside the run directory stopped being reported')
})

test('a completed record with no accepted identity, and one stamped in the future, are both refused', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // TWO REGRESSIONS THIS FILE NAMED AND NEVER EXERCISED. A panel lane found
  // both in round seven and again in round eight: the comments describe the
  // identity gate and the future-stamp bound, and no test body reached either,
  // which a mutation confirmed by surviving.
  //
  // Both are asserted through `belongsToThisRun` and the boot path's own
  // observable output, because that is where they decide anything.
  const spawnedAt = Date.now()
  const nonce = 'ghostid-nonce'

  // A record stamped in the future is not this run's, however close.
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt + 90_000).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce),
    false, 'a record stamped 90s ahead was accepted as this dispatch\'s')
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt + 1_000).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce),
    true, 'a record from a second after the spawn was rejected')
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt - 1_000).toISOString(), spawn_nonce: nonce }, spawnedAt, nonce),
    false, 'a record predating the spawn was accepted')

  // A `completed` record carrying NO accepted identity must not report success.
  // The dispatcher prints the identity it accepted; a ghost record has none, so
  // the run must not come back reporting one.
  const cwd = tempDir('acp-dispatch-ghostid-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'ghostid.json'), JSON.stringify({
    liveness_state: 'completed', termination_reason: 'none',
    started_at: new Date(spawnedAt + 5_000).toISOString(),
    observed_at: new Date(spawnedAt + 5_000).toISOString(),
    next_lease_expiry_at: new Date(spawnedAt + 900_000).toISOString(),
  }))
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'ghostid', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '10' }), timeout: 60000 })
  const out = `${r.stdout}${r.stderr}`
  // whatever it reports, it must be THIS lane's identity, never the ghost's absence
  assert.match(out, /effective_identity: gpt-mock/,
    `a completed record with no identity was allowed to stand in for one:\n${out}`)
  // The predecessor's record was moved aside rather than believed.
  assert.ok(readdirSync(join(cwd, '.tmux-teams', 'liveness')).some((f) => f.includes('.superseded-')),
    'the ghost record was not retired')

  // WHAT THIS CANNOT PROVE, measured rather than assumed. Mutating the boot
  // path's identity gate back to `outcome: 'live'` leaves this test GREEN,
  // because the retirement above removes the ghost before boot ever reads it.
  // The gate is defence in depth behind that retirement — reachable only if a
  // record appears after the retirement and during boot, which a test cannot
  // stage without a race. It stays because the retirement can fail: a read
  // refused by the containment boundary leaves the record in place. The
  // assertion that bites here is the retirement, and saying so is better than
  // leaving a surviving mutation for the next reader to discover.
})

test('watchBoot ignores a foreign-nonce record that lands after retirement', async () => {
  // The test above says in its own comment that it cannot reach watchBoot's
  // identity gate: a pre-placed ghost is retired by spawnDetached before boot
  // ever polls. This reaches it without staging an OS-level race. An async
  // function runs synchronously up to its first await; spawnDetached and
  // retirement are fully synchronous, and watchBoot's first poll is too. So by
  // the time main() hands back a pending promise, retirement has run and poll
  // one has found nothing — the record written on the next line lands strictly
  // between poll one and poll two. The stub spawnFn means no companion races it.
  const cwd = tempDir('acp-dispatch-boot-forge-')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const lines = []
  const p = main(['mock', cwd, 'boot-forge', brief, '120'], {
    out: (s) => lines.push(s), err: (s) => lines.push(s),
    spawnFn: () => ({ pid: 424243, unref() {}, on() {} }),
    env: { ACP_DISPATCH_BOOT_SEC: '2' },
  })
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'boot-forge.json'), JSON.stringify({
    started_at: new Date(Date.now() + 1000).toISOString(),
    liveness_state: 'completed', termination_reason: 'none',
    effective_identity: 'STRANGER-IDENTITY[max]', identity_status: 'matched',
    spawn_nonce: 'a-strangers-nonce',
  }))
  const code = await p
  const out = lines.join('\n')
  assert.doesNotMatch(out, /STRANGER-IDENTITY/,
    `a foreign-nonce record was reported as this dispatch's own identity:\n${out}`)
  assert.equal(code, 1,
    `expected the booting outcome — no record ever belonged to this dispatch's nonce:\n${out}`)
})

test('a lane whose records cannot be written is killed, not left running namelessly', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  // A panel lane reproduced the gap: the child is detached BEFORE its pid and
  // routing exist on disk, so an ordinary metadata failure — a full disk, a
  // directory turned read-only between the preflight and the write — leaves a
  // LIVE lane with no record anyone can find it by. `status` reports nothing,
  // admission admits a second writer, and the operator has an orphan burning
  // tokens under no name.
  //
  // The window cannot be closed, because the pid does not exist until the spawn
  // does. So the failure is made recoverable: the lane is killed and the error
  // names its pid.
  const cwd = tempDir('acp-dispatch-orphan-')
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  // BOTH publications, not just routing. The edit that added this guard
  // asserted two anchors, the first failed, and only the second half was
  // re-applied — a lane found the pid write still unguarded a round later.
  const r = spawnSync(process.execPath, ['-e', `
    process.env.ACP_DISPATCH_BOOT_SEC = '10'
    const m = await import(${JSON.stringify(DISPATCH)})
    const { chmodSync } = await import('node:fs')
    // make the routing directory unwritable AFTER the preflight has passed
    const orig = m.spawnDetached
    try {
      chmodSync(${JSON.stringify(join(cwd, '.tmux-teams', 'dispatch-routing'))}, 0o500)
      orig('mock', ${JSON.stringify(cwd)}, 'orphan', ${JSON.stringify(join(cwd, 'brief.md'))}, 120)
      console.log('NO ERROR')
    } catch (e) {
      console.log('CODE ' + e.code)
      console.log('MSG ' + e.message)
    }
  `], { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  const out = `${r.stdout}${r.stderr}`
  assert.doesNotMatch(out, /NO ERROR/, 'a lane whose routing could not be written was left running')
  assert.match(out, /CODE publication_failed/, `unexpected outcome:\n${out}`)
  assert.match(out, /killed rather than left unfindable/)
  const pid = Number.parseInt(out.match(/pid (\d+)/)?.[1] ?? '0', 10)
  assert.ok(pid > 1, 'the error did not name the pid it killed')
  await sleep(300)
  assert.throws(() => process.kill(pid, 0), 'the lane named in the error is still alive')
})

test('two dispatches racing one task id cannot both win', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX')
  // A panel lane marked the non-atomic admission PACKET-ADMITTED: this file's
  // own comment said two dispatches racing the check both pass, and admitting a
  // limitation is not the same as having one that cannot be removed.
  //
  // The reads cannot be made atomic — they answer "is the holder alive". The
  // CLAIM can: `O_CREAT|O_EXCL` on the pid path either creates or fails, so of
  // N racers exactly one proceeds. This starts eight at once and counts.
  const cwd = tempDir('acp-dispatch-race-')
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  const racers = await Promise.all(Array.from({ length: 8 }, () => new Promise((done) => {
    const p = spawn(process.execPath, [DISPATCH, 'mock', cwd, 'contested', join(cwd, 'brief.md'), '120'],
      { cwd, encoding: 'utf8', env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '20' }), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => done({ code, out }))
  })))
  const winners = racers.filter((r) => r.code === 0)
  assert.equal(winners.length, 1,
    `${winners.length} of 8 racing dispatches won the same task id`)
  for (const loser of racers.filter((r) => r.code !== 0)) {
    assert.match(loser.out, /already running|is claimed here|claimed by another/,
      `a loser failed for some reason other than losing the race:\n${loser.out.slice(0, 400)}`)
  }
  // and exactly one lane exists
  assert.equal(readdirSync(join(cwd, '.tmux-teams', 'dispatch-pids')).length, 1)

  // WHAT THIS TEST PROVES, re-measured after the paragraph that used to stand
  // here went false. It said neutering the `O_CREAT|O_EXCL` claim leaves this
  // GREEN, and that WAS true when it was written — an unconditional `rmSync`
  // ran before the claim, so the claim guarded nothing and removing it changed
  // nothing. Taking the `rmSync` out is what made the claim real, and it made
  // this paragraph false in the same commit; nobody re-read it. A codex-advisor
  // lane measured the mutant on this checkout: `if (false)` in place of
  // `if (!claimTaskId(cwd, taskId))` gives 1085 pass / 2 fail, this race test
  // among them, at 2 of 8 admitted.
  //
  // The lesson is not about the claim. A comment that records a measurement has
  // to be re-measured by whatever changes the thing it measured, or it becomes
  // a confident false statement sitting next to working code.
  //
  // It stays because the reads CANNOT be made atomic — they answer "is the
  // holder alive", which takes several syscalls — while the claim either
  // creates the name or does not. What this test does prove is that the whole
  // admission path, claim included, admits exactly one of eight concurrent
  // dispatches and refuses the rest for the right reason. It also caught a real
  // defect on its first run: the preflight's `mkdirSync` raced itself and
  // crashed the losers with EEXIST before they ever reached admission.
})

test('an unwritable pid directory refuses BEFORE a child exists', () => {
  if (process.platform === 'win32') return
  // The routing half of the publication guard shipped and the pid half did not,
  // because a scripted edit asserted two anchors, failed on the first, and only
  // the second was re-applied. A round-nine lane reported it. Both halves are
  // guarded now.
  //
  // But the pid half CANNOT be reached by making that directory unwritable,
  // and the reason is the better outcome: `claimTaskId` is the earliest write
  // there, so a permission problem is refused before any child exists and
  // there is nothing to orphan. The guard covers the narrower window between
  // the claim and the write — a disk that fills in between — which a test
  // cannot stage.
  const cwd = tempDir('acp-dispatch-orphanpid-')
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  chmodSync(join(cwd, '.tmux-teams', 'dispatch-pids'), 0o500)
  try {
    const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'orphanpid', join(cwd, 'brief.md'), '120'],
      { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
    assert.notEqual(r.status, 0, 'a dispatch proceeded with an unwritable pid directory')
    assert.match(`${r.stdout}${r.stderr}`, /EACCES|permission denied/)
    // nothing was started, so nothing needs killing
    assert.equal(readdirSync(join(cwd, '.tmux-teams', 'runner-logs')).length, 0)
  } finally {
    chmodSync(join(cwd, '.tmux-teams', 'dispatch-pids'), 0o700)
  }

  // and both publications really are guarded in the source, which is what the
  // lane's finding was about
  const src = readFileSync(DISPATCH, 'utf8')
  assert.equal((src.match(/code: 'publication_failed'/g) ?? []).length, 2,
    'one of the two publication writes is unguarded again')
})

test('an observed nonzero exit outranks a record the child wrote on its way out', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX')
  // A round-nine lane reported the identity check running BEFORE the captured
  // `exited` state, so a child that had already exited nonzero — and whose exit
  // this loop had observed — was reported as a healthy boot on the strength of
  // a record it wrote on its way out.
  //
  // A record proves what a lane SAID; `exited` proves what happened to it. An
  // identity refusal is the case that produces both: the companion writes the
  // identity it saw, refuses it, and exits nonzero.
  const cwd = tempDir('acp-dispatch-exitwins-')
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'exitwins', join(cwd, 'brief.md'), '120'], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: laneEnv({ ACP_DISPATCH_BOOT_SEC: '30', MOCK_CONFIG_IDENTITY: '1',
      MOCK_MODEL_OPTIONS: 'something-else', MOCK_MODEL_OPTIONS_STRICT: '1',
      ACP_MODEL: 'not-on-offer', ACP_EXPECT_MODEL: 'not-on-offer' }),
  })
  const out = `${r.stdout}${r.stderr}`
  assert.notEqual(r.status, 0, `a refused identity was reported as a healthy boot:\n${out}`)
  assert.doesNotMatch(out, /^dispatched .* and is running/m,
    'the caller was told a lane that exited is running')

  // WHAT THIS DOES NOT PROVE, measured: removing the `exited` check leaves this
  // green, because an identity refusal ALSO writes `liveness_state: failed` and
  // the terminal branch catches it first. The `exited` rule covers the case
  // where the record looks HEALTHY and the process died anyway — a mock that
  // writes a good identity and then crashes, which the fixtures cannot produce.
  //
  // It stays because a record proves what a lane said and `exited` proves what
  // happened to it, and the panel found the ordering wrong by reading rather
  // than by running. Saying so is better than leaving the survivor unexplained.
})

test('a parent symlinked INSIDE the run is still refused: containment is not identity', () => {
  if (process.platform === 'win32') return
  // A round-nine lane found the boundary accepting any parent that resolved
  // somewhere under the run root — so `.mailbox-out` pointed at another
  // directory in the SAME run still passed, and a liveness file could answer
  // the outbox question. The check walks each component now.
  const cwd = tempDir('acp-dispatch-inside-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'inside'), 'NOT AN OUTBOX\n')
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'inside.json'), JSON.stringify({
    liveness_state: 'completed', termination_reason: 'none',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 900_000).toISOString(),
  }))
  // point .mailbox-out at a directory that IS inside the run root
  symlinkSync(join(cwd, '.tmux-teams', 'liveness'), join(cwd, '.mailbox-out'))

  const report = statusReport(cwd, 'inside')
  assert.equal(report.outboxFound, false,
    'a parent symlinked to another directory inside the same run answered the outbox question')
  assert.notEqual(statusExitCode(report), EXIT_OUTBOX)

  // and an ordinary run directory still reads normally
  const honest = tempDir('acp-dispatch-inside-ok-')
  mkdirSync(join(honest, '.mailbox-out'), { recursive: true })
  writeFileSync(outboxPath(honest, 'ok'), 'the answer\n')
  mkdirSync(join(honest, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(honest, '.tmux-teams', 'liveness', 'ok.json'), JSON.stringify({
    liveness_state: 'completed', termination_reason: 'none',
    observed_at: new Date().toISOString(),
    next_lease_expiry_at: new Date(Date.now() + 900_000).toISOString(),
  }))
  assert.equal(statusReport(honest, 'ok').outboxFound, true,
    'an ordinary outbox stopped being found')
})

test('admission sees a routing-less lane, and a leaseless leftover does not block a re-dispatch', () => {
  // A round-nine lane reproduced the first half: `loop-runner.mjs` starts
  // companions WITHOUT a dispatcher routing file, and admission required one
  // before it would look at liveness at all — so a live lane's own record was
  // discarded and a second writer admitted beside it. `statusReport` accepts
  // routing-less liveness for exactly that reason; admission was stricter than
  // the thing it exists to agree with.
  //
  // The second half is what makes that safe. A leaseless record is AMBIGUOUS:
  // a lane in `starting` has not published a lease yet, and a leftover from two
  // days ago never will. `observed_at` separates them, and a record with NO
  // timing at all is unknown rather than expired — answering "stopped" to a
  // missing field would settle a lane on an absence.
  const now = Date.now()
  const fresh = { liveness_state: 'tool_running', termination_reason: 'none',
    observed_at: new Date(now - 5_000).toISOString() }
  const ancient = { liveness_state: 'tool_running', termination_reason: 'none',
    observed_at: '2026-08-16T21:46:10.092Z' }
  const timeless = { liveness_state: 'starting', termination_reason: 'none' }

  assert.equal(leaseExpired(fresh, now), false, 'a lane observed seconds ago was called stale')
  assert.equal(leaseExpired(ancient, now), true, 'a two-day-old record was treated as progress')
  assert.equal(leaseExpired(timeless, now), false, 'a record with no timing was settled on an absence')

  // an explicit lease still wins over the observation
  assert.equal(leaseExpired({ ...fresh, next_lease_expiry_at: new Date(now - 1).toISOString() }, now),
    true, 'an expired lease was overridden by a recent observation')
  assert.equal(leaseExpired({ ...ancient, next_lease_expiry_at: new Date(now + 60_000).toISOString() }, now),
    false, 'a live lease was overridden by an old observation')

  // AND THROUGH ADMISSION, because asserting the predicate proved nothing about
  // the caller — the first version of this test left the routing-less branch
  // mutable and green. A lane with a fresh record, no pid and NO ROUTING is a
  // `loop-runner` lane, and a second writer must not be admitted beside it.
  const cwd = tempDir('acp-dispatch-noroute-')
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  writeFileSync(join(cwd, 'brief.md'), 'do the thing\n')
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'looprun.json'), JSON.stringify({
    ...fresh, next_lease_expiry_at: new Date(now + 900_000).toISOString(),
  }))
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'looprun', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.notEqual(r.status, 0,
    'a second writer was admitted beside a routing-less lane that is still reporting')
  assert.match(`${r.stdout}${r.stderr}`, /still reporting progress/)

  // and the same directory with an ANCIENT routing-less record dispatches
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'looprun.json'), JSON.stringify(ancient))
  const again = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'looprun', join(cwd, 'brief.md'), '120'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  assert.equal(again.status, 0,
    `a leaseless leftover blocked a re-dispatch:\n${again.stdout}${again.stderr}`)
})

// Found by a codex-advisor lane on the release candidate, reproduced here
// before the fix. `readDirSync` checked only that `realpath(path)` stayed under
// `realpath(runRoot)` — so a `.mailbox-out` symlinked to another directory
// INSIDE the same run passed, and the listing reported the target's files as
// this run's. The leaf reader had already learned that containment is not
// identity; the directory reader had not, though the comment above it claimed
// both were fixed.
test('an outbox directory reached through a symlink enumerates nothing of its own', () => {
  const cwd = tempDir('acp-dirlink-')
  mkdirSync(join(cwd, 'inside-target'), { recursive: true })
  writeFileSync(join(cwd, 'inside-target', 'foreign'), 'not this run\n')
  symlinkSync(join(cwd, 'inside-target'), join(cwd, '.mailbox-out'))
  assert.deepEqual(strayOutboxes(cwd, 'mine'), [],
    "a symlinked .mailbox-out reported the link target's files as this run's outboxes")
})

// The same lane found the one `readJson` call site of eight that omitted its
// run root, in the refusal that loses the claim race. Chasing it turned up
// something the lane could not see from the source alone: even with the root
// restored the read finds nothing, because admission RETIRES that leaf about
// forty lines earlier. The sentence it fed was unreachable from the start.
//
// So this test pins the two things that are true instead of the one that was
// assumed. The refusal names the id and the file and stops there; and the leaf
// really is retired rather than deleted, which is what keeps a superseded
// lane's bytes readable.
test('a refused claim says only what it can support, and keeps the retired leaf', () => {
  const cwd = tempDir('acp-claimlease-')
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
  mkdirSync(join(cwd, '.tmux-teams', 'liveness'), { recursive: true })
  // A DEAD pid, because the two refusals are different branches and only one of
  // them is the claim. A live pid takes the "already running" path, whose own
  // lease read never lost its run root — so planting `process.pid` here tested
  // the branch that already worked. The first version of this test did exactly
  // that and failed for a reason that looked like the bug and was not.
  const dead = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' }).pid
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-pids', 'held'), `${dead}\n`)
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'held.json'),
    JSON.stringify({ task_id: 'held', liveness_state: 'active',
      next_lease_expiry_at: '2999-01-01T00:00:00.000Z' }))
  writeFileSync(join(cwd, 'brief.md'), 'brief\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'held', join(cwd, 'brief.md'), '30'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  const said = `${r.stdout}${r.stderr}`
  assert.match(said, /task id "held" is claimed here/, `the claim was not refused:\n${said}`)
  assert.doesNotMatch(said, /progress lease says/,
    `the refusal quoted a lease belonging to the occupant it had just retired:\n${said}`)
  const leaves = readdirSync(join(cwd, '.tmux-teams', 'liveness'))
  assert.equal(leaves.filter((n) => n.startsWith('held.json.superseded-')).length, 1,
    `the predecessor leaf was not retired under a suffix: ${leaves.join(', ')}`)
})

// This test exists because a mutation SURVIVED, and what it pins is not what it
// was written for. Making the collision scan stop refusing an unenumerable
// directory left the whole file green, so that guard has no consumer test.
// Writing one showed why: the scan can never SEE that case, because
// `assertContainedDir` refuses a symlinked `.tmux-teams/<dir>` forty lines
// earlier. So what is asserted below is the guarantee that stands in front of
// it — the one that is reachable.
//
// THE GUARD IS STILL IN THE CODE, and an earlier version of this paragraph said
// it had been removed. It had not: the removal was written, then reverted by a
// `git checkout --` run to undo a mutation, and the commit that claimed it went
// out with the claim and without the change. A codex-advisor lane read the
// paragraph against `acp-dispatch.mjs` and caught it.
//
// It stays, for a reason that came from that same lane rather than from me: the
// preflight makes the branch unreachable in ordinary sequence, but a directory
// replaced concurrently BETWEEN preflight and scan lands in it, and there it
// gives a named refusal instead of a `for...of null` TypeError. Both fail
// closed; one of them tells the operator which directory refused. That is
// defence in depth with an honest label — untested, unreachable by any test
// this suite can stage, and kept deliberately rather than by oversight.
test('admission refuses an artifact directory that is a symlink', () => {
  const cwd = tempDir('acp-dirscan-')
  mkdirSync(join(cwd, '.tmux-teams'), { recursive: true })
  mkdirSync(join(cwd, 'elsewhere'), { recursive: true })
  // Spelled differently on purpose: were the scan ever to enumerate through the
  // link it would find a case collision, so a pass here cannot come from an
  // empty directory. The link points back INSIDE the run root, which is what
  // makes a containment test useless against it.
  writeFileSync(join(cwd, 'elsewhere', 'Held.json'), '{}')
  symlinkSync(join(cwd, 'elsewhere'), join(cwd, '.tmux-teams', 'liveness'))
  writeFileSync(join(cwd, 'brief.md'), 'brief\n')
  const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'held', join(cwd, 'brief.md'), '30'],
    { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
  const said = `${r.stdout}${r.stderr}`
  assert.notEqual(r.status, 0, `a run directory reached through a symlink was admitted:\n${said}`)
  assert.match(said, /refusing a run directory whose \.tmux-teams\/liveness is not a real directory inside it/,
    `the refusal did not name the directory that refused:\n${said}`)
})

// The primitive, tested directly, because NO consumer can reach this branch —
// every call site builds its path from the run root it also passes. That is
// exactly why the branch matters: it is what turns "a caller forgot the run
// root" from a silent pass into a refusal, and the release this test ships in
// contains one call site that had forgotten it.
//
// The previous shape answered `relative = ''` for a path outside the root and
// then walked no components at all, so the boundary agreed with anything it
// could not place. A mutation survived the whole file until this went in.
test('the read boundary refuses a path outside the run root it was given', () => {
  const cwd = tempDir('acp-outside-')
  const other = tempDir('acp-other-')
  writeFileSync(join(other, 'secret'), 'not this run\n')
  writeFileSync(join(cwd, 'mine'), 'this run\n')
  assert.equal(readLeafSync(join(other, 'secret'), cwd), null,
    'a file outside the run root was read')
  assert.equal(readLeafSync(cwd, cwd), null, 'the run root itself is not a leaf')
  assert.equal(readLeafSync(join(cwd, 'mine'), cwd), 'this run\n',
    'a file inside the run root was refused')
})

// A codex-advisor lane read `codex-advisor/SKILL.md` against the function it
// describes and found them disagreeing. The skill required a receipt on every
// dispatch and a receipt-required LOAD on every recovery; `resumeCommand`
// emitted neither the flag nor the operation. Because the companion defaults
// `receiptRequired` to false, pasting the generated command did not fail — it
// came back with the guarantee quietly removed, which is the failure mode this
// repository already has a rule about.
//
// The two lineage values are placeholders on purpose, the same way the brief
// path already was: status cannot know a digest it did not write, and an
// operator who pastes this unedited must get a refusal rather than a resume
// that silently means something weaker.
test('a receipt-required dispatch resumes as a receipt-required load', () => {
  const command = resumeCommand('/run', 'adv', {
    sessionId: 'sess-1',
    routing: { worker: 'codex', briefFile: '/tmp/recover.md', stallSec: 600,
      env: { INITIAL_AGENT_MODE: 'read-only', ACP_SESSION_RECEIPT_REQUIRED: '1',
        ACP_MODEL: 'gpt-5.6-sol' } },
  })
  for (const key of ['ACP_SESSION_RECEIPT_REQUIRED', 'ACP_SESSION_OPERATION',
    'ACP_PRIOR_DISPATCH_ID', 'ACP_PRIOR_RECEIPT_DIGEST']) {
    assert.match(command, new RegExp(`${key}=`), `the resume command dropped ${key}:\n${command}`)
  }
  assert.match(command, /ACP_SESSION_OPERATION='load'/,
    `the resume copied the recorded operation instead of loading:\n${command}`)
  // Quoted, so an unedited paste is a refusal rather than a shell redirection.
  assert.match(command, /ACP_PRIOR_DISPATCH_ID='PUT-THE-PRIOR-DISPATCH-ID-HERE'/)

  // A dispatch that never asked for a receipt does not acquire one here. The
  // recovery has to reproduce what ran, not improve on it.
  const plain = resumeCommand('/run', 'adv', {
    sessionId: 'sess-2',
    routing: { worker: 'codex', briefFile: '/tmp/b.md', stallSec: 600, env: { ACP_MODEL: 'x' } },
  })
  assert.doesNotMatch(plain, /ACP_SESSION_OPERATION|ACP_PRIOR_/,
    `a plain dispatch was given lineage it never had:\n${plain}`)
})

// The guard I kept as unreachable defence-in-depth turned out to be reachable,
// and the thing standing between it and the defect was its own producer. A lane
// found that `readDirSync` caught EVERY `readdirSync` failure as `[]`, so a real
// directory with write and search permission but no read permission passed the
// preflight, answered EACCES, and was read as holding no case collision. It
// admitted a colliding id, exit 0, on this case-insensitive volume.
//
// The symlink walk was never the only way to fail to enumerate — it was the
// only one anybody had pictured, which is also why the refusal used to say
// "reached through a symlink" about a permission error.
test('admission refuses an artifact directory it is not allowed to read', () => {
  const cwd = tempDir('acp-eacces-')
  const dir = join(cwd, '.tmux-teams', 'liveness')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Other.json'), JSON.stringify({ liveness_state: 'failed' }))
  // Only meaningful where the two spellings are the same file. Elsewhere there
  // is no collision to miss, so the test would pass without proving anything.
  if (!existsSync(join(dir, 'other.json'))) return
  writeFileSync(join(cwd, 'brief.md'), 'brief\n')
  chmodSync(dir, 0o300)
  try {
    const r = spawnSync(process.execPath, [DISPATCH, 'mock', cwd, 'other', join(cwd, 'brief.md'), '5'],
      { cwd, encoding: 'utf8', env: laneEnv(), timeout: 60000 })
    const said = `${r.stdout}${r.stderr}`
    assert.notEqual(r.status, 0, `an unreadable artifact directory was admitted:\n${said}`)
    assert.match(said, /cannot be listed/, `the refusal did not name the failure:\n${said}`)
    // It must not claim a symlink is the SOLE cause; it may still offer one as
    // a possibility, and it does. The old exact phrase asserted the cause.
    assert.doesNotMatch(said, /is reached through a symlink, so/,
      `a permission failure was reported as a symlink:\n${said}`)
  } finally {
    chmodSync(dir, 0o700)
  }
})

// `'0'` is truthy in JavaScript and is an explicit opt-out to the companion,
// which treats only `'1'` as required. The first version of the resume branch
// tested truthiness, so an opt-out dispatch was handed both lineage
// placeholders; a lane RAN the resulting command and the dispatcher exited 2 on
// `prior lineage validation failed: ENOENT .../PUT-THE-PRIOR-DISPATCH-ID-HERE.json`.
test('an explicit receipt opt-out resumes without receipt lineage', () => {
  for (const value of ['0', 'false', 'no']) {
    const command = resumeCommand('/run', 'adv', {
      sessionId: 'sess', routing: { worker: 'codex', briefFile: '/tmp/b.md', stallSec: 600,
        env: { ACP_SESSION_RECEIPT_REQUIRED: value, ACP_MODEL: 'x' } },
    })
    assert.doesNotMatch(command, /ACP_SESSION_OPERATION|ACP_PRIOR_/,
      `ACP_SESSION_RECEIPT_REQUIRED=${value} was treated as a receipt requirement:\n${command}`)
    // The recorded value is still carried through — the resume reproduces what
    // ran, and what ran said 0.
    assert.match(command, new RegExp(`ACP_SESSION_RECEIPT_REQUIRED='${value}'`))
  }
})

// Two predicates survived the whole file — the capture in both directions and
// the emission forced true, three mutants in all — and a lane showed they
// are not algebraic. The routing capture and the resume emission share a shape
// — `if the value is present and non-empty` — and forcing it TRUE writes the
// STRING "undefined" into the record and then into a pasted command, including
// an INITIAL_AGENT_MODE the Codex adapter does not accept. Forcing it FALSE
// records nothing, so a recovery silently loses the model, the profile and the
// receipt guarantee.
//
// Neither direction was visible because every existing fixture supplied a full
// env. A sparse one is the ordinary case — most dispatches set two or three of
// these eleven keys.
test('routing records the keys that were set and invents none', () => {
  const cwd = tempDir('acp-routing-')
  mkdirSync(join(cwd, '.tmux-teams'), { recursive: true })
  writeFileSync(join(cwd, 'brief.md'), 'brief\n')
  spawnDetached('codex', cwd, 'rt', join(cwd, 'brief.md'), 600, {
    spawnFn: () => ({ pid: 424242, unref() {}, on() {} }),
    env: { ACP_MODEL: 'gpt-5.6-sol', ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_REASONING_EFFORT: '',
      SOMETHING_UNRELATED: 'not routing' },
  })
  const recorded = recordedRouting(cwd, 'rt')?.env ?? {}
  assert.deepEqual(recorded, { ACP_MODEL: 'gpt-5.6-sol', ACP_SESSION_RECEIPT_REQUIRED: '1' },
    `routing recorded something other than the keys that were set: ${JSON.stringify(recorded)}`)
  // Named explicitly, because "deepEqual to two keys" would also pass if the
  // capture had recorded the literal string "undefined" for a third.
  for (const key of ROUTING_ENV_KEYS) {
    assert.notEqual(recorded[key], 'undefined', `${key} was recorded as the string "undefined"`)
  }
})

test('a resume command names no setting the dispatch did not have', () => {
  // An EMPTY value beside the absent ones. A lane found this test pinned the
  // `undefined` half of "present and non-empty" and nothing else: deleting just
  // the `!== ''` clause left all 58 green, and the mutant emitted
  // `INITIAL_AGENT_MODE=''` — a mode the Codex adapter refuses. A fixture built
  // from a reproduction tests the reported case; the rule needs the neighbour
  // the reproduction did not happen to use.
  const command = resumeCommand('/run', 'rt', {
    sessionId: 'sess', routing: { worker: 'codex', briefFile: '/tmp/b.md', stallSec: 600,
      env: { ACP_MODEL: 'gpt-5.6-sol', INITIAL_AGENT_MODE: '', ACP_AGENT_ID: '' } },
  })
  assert.doesNotMatch(command, /=''/,
    `an empty recorded value was emitted as an empty assignment:\n${command}`)
  assert.doesNotMatch(command, /'undefined'/,
    `the resume command manufactured a literal undefined setting:\n${command}`)
  assert.match(command, /ACP_MODEL='gpt-5.6-sol'/)
  // INITIAL_AGENT_MODE='undefined' is the one that bites: the Codex adapter
  // rejects it, so a paste fails in a way that reads like a broken dispatcher.
  assert.doesNotMatch(command, /INITIAL_AGENT_MODE=/,
    `a mode was emitted for a dispatch that never set one:\n${command}`)
})

// BEHAVIOUR, not the source text. The first guard for this shipped with a test
// that grepped `acp-companion.mjs` for the guard's own source lines — and a
// reviewer replaced the condition with `if (false)` and watched the whole suite
// stay green at 1113/1109/0/4. A source grep is a tripwire, not a test: it
// proves a string is present, never that anything happens.
//
// The prohibition is CLAUDE.md's, it says fail closed, and the AGY adapter
// advertises both Gemini 3.1 seats — so this is reachable by typing.
test('a prohibited model refuses the dispatch before a session exists', () => {
  // The directory name deliberately avoids the word this test asserts. The
  // dispatcher prints `run directory resolves to: <path>`, so a fixture called
  // `acp-prohibited-*` satisfies a `/prohibited/` match on its own — the same
  // shape this repository already records elsewhere as "a caller who controls a
  // filename controls the classification". Caught by the assertion failing on a
  // PERMITTED model.
  const cwd = tempDir('acp-modelguard-')
  writeFileSync(join(cwd, 'brief.md'), 'probe\n')
  const run = (model) => spawnSync(process.execPath,
    [DISPATCH, 'mock', cwd, `p-${model.replace(/[^a-z0-9]/gi, '')}`, join(cwd, 'brief.md'), '20'],
    { cwd, encoding: 'utf8', timeout: 60000,
      env: { ...laneEnv(), ACP_MODEL: model, ACP_EXPECT_MODEL: model } })

  for (const model of ['gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'Gemini 3.1']) {
    const r = run(model)
    const said = `${r.stdout}${r.stderr}`
    assert.notEqual(r.status, 0, `${model} was dispatched:\n${said.slice(0, 300)}`)
    assert.match(said, /Gemini 3\.1 is prohibited/,
      `${model} was refused for some other reason, or not refused at all:\n${said.slice(0, 300)}`)
  }

  // The EXPECTATION is checked too — expecting a prohibited model is how a lane
  // gets certified as having run one.
  const expected = spawnSync(process.execPath,
    [DISPATCH, 'mock', cwd, 'p-expect', join(cwd, 'brief.md'), '20'],
    { cwd, encoding: 'utf8', timeout: 60000,
      env: { ...laneEnv(), ACP_MODEL: 'gemini-3.7-flash-high', ACP_EXPECT_MODEL: 'gemini-3.1-pro-low' } })
  assert.match(`${expected.stdout}${expected.stderr}`, /Gemini 3\.1 is prohibited/,
    'a prohibited EXPECTATION was accepted')

  // And a permitted model still starts, or the guard is just an outage.
  const ok = spawnSync(process.execPath,
    [DISPATCH, 'mock', cwd, 'p-ok', join(cwd, 'brief.md'), '20'],
    { cwd, encoding: 'utf8', timeout: 60000,
      env: { ...laneEnv(), ACP_MODEL: 'gemini-3.7-flash-high', ACP_EXPECT_MODEL: 'gemini-3.7-flash-high' } })
  assert.doesNotMatch(`${ok.stdout}${ok.stderr}`, /is prohibited on tmux-teams routes/,
    'a permitted model was refused by the prohibition guard')
  // The dispatched LINE, not the exit code — this command's success code is not
  // 0 by convention and asserting one I had not checked is how the previous
  // version of this line failed on a lane that had dispatched perfectly well.
  assert.match(`${ok.stdout}${ok.stderr}`, /dispatched mock as p-ok/,
    `a permitted model did not dispatch:\n${ok.stdout}${ok.stderr}`)
})
