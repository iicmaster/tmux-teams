import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, symlinkSync,
  realpathSync, statSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusReport, formatStatus, resumeCommand, outboxPath, strayOutboxes, TERMINAL_LIVENESS_STATES,
  waitForSettlement, EXIT_OUTBOX, EXIT_RUNNING, EXIT_NO_OUTBOX, pidPath, recordedPid, belongsToThisRun,
  statusExitCode, logPath }
  from '../plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
const DISPATCH = join(SCRIPTS, 'acp-dispatch.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const SKILLS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Every temp directory this file makes, removed when the file ends.
//
// Written 2026-08-17 after this file helped fill the machine's disk twice in
// one day. It had 25 `mkdtempSync` calls and one `rmSync`, and several of those
// directories hold a real lane's logs, receipts and KMS events — so every run
// left tens of megabytes behind, and enough runs took the volume to zero and
// stopped every tool that writes, this one included. A test that leaks is a
// test that eventually stops the work.
const TEMP_DIRS = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

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
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt).toISOString() }, spawnedAt), true)
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt + 1).toISOString() }, spawnedAt), true)
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt - 1).toISOString() }, spawnedAt), false,
    'a snapshot written one millisecond before this spawn was accepted as this run\'s')
  assert.equal(belongsToThisRun({ started_at: new Date(spawnedAt - 999).toISOString() }, spawnedAt), false,
    'the one-second slack is back: a sub-second retry will inherit its predecessor\'s identity')
  assert.equal(belongsToThisRun({}, spawnedAt), false, 'a record with no started_at was claimed')
  assert.equal(belongsToThisRun(null, spawnedAt), false)
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
  writeFileSync(join(cwd, '.tmux-teams', 'dispatch-routing', 'ident.json'),
    JSON.stringify({ worker: 'mock', spawnedAt, env: {} }))
  writeFileSync(join(cwd, '.tmux-teams', 'liveness', 'ident.json'), JSON.stringify({
    started_at: spawnedAt, liveness_state: 'active', termination_reason: 'none',
    effective_identity: 'looks-like-an-identity', identity_status: 'missing',
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
  assert.match(nonsense, /'\/b\.md' 900$/m, 'an unusable recorded stall must fall back, not propagate')
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
