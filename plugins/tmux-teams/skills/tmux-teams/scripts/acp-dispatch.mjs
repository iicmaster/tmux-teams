#!/usr/bin/env node
// The operator's entry point to an ACP lane, and the reason it exists is a
// measurement rather than a preference.
//
// On 2026-08-17 a `codex-advisor` lane was dispatched with `stall-sec` 1200 and
// run in the foreground of a shell whose own cap was 600 seconds. Both numbers
// were typed by the same caller in the same command and nothing compared them.
// At exactly ten minutes the shell killed the process group: the lane died
// `controller_interrupted` with 461 protocol events recorded, every tool call
// completed, and its review unwritten. `loop-runner.mjs` has never been able to
// fail that way — its `dispatch()` spawns the companion `detached: true` with
// `stdio: ['ignore', logFd, logFd]` and calls `unref()`, so the child sits in
// its OWN process group and a group kill aimed at the parent cannot reach it.
// This script is that same shape, made available to a human or an agent typing
// a command, because the fix already existed and only the loop could reach it.
//
// So the supervisor's budget stops mattering: this process exits in seconds
// while the lane runs for as long as it was given. Nothing here ever kills the
// child — a wrapper that enforces a deadline would be the bug it was written to
// remove.
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, 'acp-companion.mjs')

export const USAGE = [
  'usage: node acp-dispatch.mjs <claude|codex|agy> <cwd> <task-id> <brief-file> [stall-sec]',
  '       node acp-dispatch.mjs status <cwd> <task-id>',
  '       node acp-dispatch.mjs wait <cwd> <task-id> [max-sec]',
].join('\n')

// Exit codes, shared by `status` and `wait`, because a caller scripting either
// one is asking the same question.
export const EXIT_OUTBOX = 0        // the turn ended and wrote its outbox
export const EXIT_RUNNING = 1       // still going — for `wait`, still going when the wait budget ran out
export const EXIT_NO_OUTBOX = 2     // the turn ENDED and wrote nothing: resume before re-dispatching

// The window this process is willing to sit and watch a boot. It is a REPORTING
// bound, not a lifetime: when it expires the child keeps running and this
// process says where to look. Today's receipt landed 7 seconds after start, so
// 120 buys a fail-closed identity check without buying a deadline.
const BOOT_SEC_DEFAULT = 120
const POLL_MS = 250

// The companion's own id rule, and this file has to apply it BEFORE it builds a
// path — not after, and not by delegation.
//
// An earlier version deliberately delegated: "re-validating the task id here
// would be a second copy of a rule that can drift". True, and it still opened
// the log file and wrote the pid file from the raw value first. A task id of
// `../../../victim` therefore escaped `.tmux-teams/` and `writeFileSync`
// TRUNCATED an arbitrary writable file before the companion ever saw the id.
// Found by the repository's PR reviewer, 2026-08-17. The rule is copied here
// with the source named, and `tests/acp-dispatch.test.mjs` asserts the two stay
// identical, which is the drift answer that does not require the hole.
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

export function safeTaskId(taskId) {
  return typeof taskId === 'string' && ID_RE.test(taskId)
}

function assertSafeTaskId(taskId) {
  if (!safeTaskId(taskId)) {
    throw Object.assign(
      new Error(`invalid task id — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`),
      { code: 'invalid_task_id' },
    )
  }
  return taskId
}

export function livenessPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`) }
export function sessionPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'sessions', taskId) }
export function logPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'runner-logs', `${taskId}.log`) }
// The one path the worker is told to write and this process reads back. It is
// derived from the task id in BOTH places and never typed twice — the second
// half of the same day's failure was a recovery prompt naming
// `.mailbox-out/mcp-round3` while the dispatch's task id made the companion
// read `.mailbox-out/mcp-round3-recover`. The review was written, complete, and
// reported as `no_outbox`.
export function outboxPath(cwd, taskId) { return join(cwd, '.mailbox-out', taskId) }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readSessionId(cwd, taskId) {
  try { return readFileSync(sessionPath(cwd, taskId), 'utf8').trim() || null } catch { return null }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Anything in `.mailbox-out/` that is not this task's file. An outbox written
// under a name nobody reads is indistinguishable from no outbox at all, and the
// difference between them is a whole re-dispatch.
export function strayOutboxes(cwd, taskId) {
  try {
    return readdirSync(join(cwd, '.mailbox-out')).filter((name) => name !== taskId).sort()
  } catch {
    return []
  }
}

// Single-quote for `sh`. A generated command that cannot be pasted is not a
// generated command, and this plugin already knows what an unquoted path costs:
// the boot guard two hundred lines down exists because an install path with a
// space broke a comparison nobody had run.
export function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

// The routing a dispatch actually used, captured at spawn so a resume can
// reproduce it. Nothing here is a secret — these select a profile, a model or a
// mode; the credential lives in the profile the wrapper loads.
//
// Written because the first resume command was generic: it turned the recorded
// EXPECTATION into `ACP_MODEL` and dropped everything else, so pasting it for a
// routed Claude seat could load the session through a different profile or
// endpoint while looking like it preserved the identity. The PR reviewer named
// it; the fix is to record what was used rather than to guess it back.
export const ROUTING_ENV_KEYS = Object.freeze([
  'ACP_MODEL', 'ACP_REASONING_EFFORT', 'ACP_EXPECT_MODEL', 'ACP_EXPECT_REASONING_EFFORT',
  'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EXECUTABLE', 'INITIAL_AGENT_MODE',
  'ACP_AGENT_ID', 'ACP_EXECUTION_PROFILE',
])

export function routingPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'dispatch-routing', `${taskId}.json`) }

export function recordedRouting(cwd, taskId) {
  const record = readJson(routingPath(cwd, taskId))
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null
}

// Reuses the SAME task id on purpose. A resume under a fresh id moves the outbox
// path out from under the prompt the agent was already given — see `outboxPath`.
export function resumeCommand(cwd, taskId, { sessionId, worker, routing, briefFile }) {
  if (!sessionId) return null
  const env = routing?.env ?? {}
  const parts = [`ACP_RESUME=${shQuote(sessionId)}`]
  for (const key of ROUTING_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') parts.push(`${key}=${shQuote(env[key])}`)
  }
  return [
    `${parts.join(' ')} \\`,
    `  node ${shQuote(join(HERE, 'acp-dispatch.mjs'))} \\`,
    `    ${shQuote(routing?.worker ?? worker ?? '<worker>')} ${shQuote(cwd)} ${shQuote(taskId)} `
      + `${briefFile ? shQuote(briefFile) : '<recovery-brief-file>'} 900`,
  ].join('\n')
}

// The companion's own vocabulary, not a guess at it. `VALID_TERMINAL_STATES` in
// `acp-companion.mjs` is exactly these three, and `isLivenessTerminal()` is what
// the companion asks itself. The first version of this file asked
// `liveness_state !== 'running'` — a state the companion never writes — so a
// lane sitting at `active` was reported as finished, complete with resume
// advice for a turn that had not ended. It shipped because the status test was
// built on a liveness fixture written BY HAND, which met a vocabulary nobody
// checked against a real file.
export const TERMINAL_LIVENESS_STATES = Object.freeze(['completed', 'cancelled', 'failed'])

// TERMINAL STATES ONLY. An earlier version also counted "any termination_reason
// other than 'none'", reasoning from round three's lane that died at
// `cancelling` and never moved. The repository's PR reviewer showed what that
// costs: under `ACP_STALL_POLICY=report` the companion writes
// `liveness_state: stalled` with `termination_reason: stall_confirmed` and stays
// ALIVE to recover, and an ordinary cancellation spends time in `cancelling`
// with a reason set before it reaches a terminal state. Both would have been
// called finished, with `wait` returning and resume advice printed for a lane
// still working.
//
// The round-three case is not lost — it is answered by the right evidence
// instead. A lane that stopped is detected by its process being gone, or by its
// lease running out when no pid was recorded. Being stalled is not being over.
function hasTerminated(liveness) {
  if (liveness === null) return false
  return TERMINAL_LIVENESS_STATES.includes(liveness.liveness_state)
}

// The third way this file has now trusted a file its writer can no longer
// correct, and the most expensive: a lane killed hard writes NO terminal
// snapshot, so its last record says `tool_running` forever. On 2026-08-17 a
// review lane died when the disk filled — the log ends with the companion
// failing to persist its own snapshot — and `status` went on reporting it as
// running for nearly four hours. A watcher built on that would never have
// returned.
//
// `next_lease_expiry_at` is the companion's OWN statement of when it should
// next have been heard from, so this needs no threshold of mine and no pid: if
// that moment is in the past, the lane is not reporting. It is a lease, not a
// death certificate — say "not reporting", never "dead".
export function leaseExpired(liveness, now = Date.now()) {
  const expiry = Date.parse(liveness?.next_lease_expiry_at ?? '')
  return Number.isFinite(expiry) && expiry < now
}

// A lane has STOPPED when its process is gone, or — when nobody recorded a pid
// to ask — when the lease it published itself has run out.
//
// The `pid === null` guard is the PR reviewer's correction and it matters:
// `next_lease_expiry_at` is a MEANINGFUL-PROGRESS lease, not a heartbeat. A
// companion may reach it, record a suspected stall, extend it and carry on. So
// an expired lease must never outvote a pid that `pidAlive` just confirmed —
// ORing the two made `wait` give up on a living lane in the window before its
// next tick.
function hasStopped(liveness, { pid = null, now = Date.now() } = {}) {
  if (hasTerminated(liveness)) return false
  if (pid !== null) return !pidAlive(pid)
  return liveness !== null && leaseExpired(liveness, now)
}

function isSettled(liveness, options = {}) {
  return hasTerminated(liveness) || hasStopped(liveness, options)
}

export function statusReport(cwd, taskId) {
  const liveness = readJson(livenessPath(cwd, taskId))
  const outbox = outboxPath(cwd, taskId)
  const found = existsSync(outbox) && lstatSync(outbox).isFile()
  // The pid answers NOW; the lease answers in up to fifteen minutes. Both, and
  // the pid only when this dispatcher recorded one — `status` also has to work
  // against a run directory it did not create.
  const pid = recordedPid(cwd, taskId)
  const pidGone = pid !== null && !pidAlive(pid)
  const stopped = hasStopped(liveness, { pid })
  const terminated = hasTerminated(liveness)
  const settled = terminated || stopped
  return {
    taskId,
    cwd,
    liveness,
    livenessState: liveness?.liveness_state ?? null,
    terminationReason: liveness?.termination_reason ?? null,
    progress: liveness?.meaningful_progress_count ?? null,
    identity: liveness?.effective_identity ?? null,
    identityStatus: liveness?.identity_status ?? null,
    outboxPath: outbox,
    outboxFound: found,
    strays: strayOutboxes(cwd, taskId),
    sessionId: readSessionId(cwd, taskId),
    settled,
    terminated,
    // Distinguished from `settled` because the ADVICE differs: a lane that
    // recorded a terminal state finished, and one that stopped saying anything
    // was killed, ran out of memory, or filled the disk under itself.
    notReporting: stopped,
    stoppedBecause: pidGone ? 'its process is gone' : (stopped ? 'its own lease expired' : null),
    pid,
    lastSeen: liveness?.observed_at ?? null,
  }
}

export function formatStatus(report) {
  const lines = [
    `task_id: ${report.taskId}`,
    `liveness_state: ${report.livenessState ?? 'none — no liveness file yet'}`,
    `termination_reason: ${report.terminationReason ?? 'none'}`,
    `meaningful_progress: ${report.progress ?? 'unknown'}`,
    `effective_identity: ${report.identity ?? 'unknown'} (${report.identityStatus ?? 'unknown'})`,
    `outbox: ${report.outboxFound ? report.outboxPath : `absent — ${report.outboxPath}`}`,
    `log: ${logPath(report.cwd, report.taskId)}`,
  ]
  if (report.notReporting) {
    lines.push(
      `NOT REPORTING — ${report.stoppedBecause}. Last snapshot ${report.lastSeen ?? 'never'}.`,
      'It wrote no terminal state, which is what a hard kill, an OOM or a full disk',
      'looks like from out here. Read the log, then resume.',
    )
  }
  if (!report.outboxFound && report.strays.length > 0) {
    lines.push(
      `other files in .mailbox-out/: ${report.strays.join(', ')}`,
      'READ THOSE BEFORE RE-DISPATCHING — a worker told a different path writes a real answer nobody reads.',
    )
  }
  if (report.outboxFound && !report.terminated) {
    lines.push(
      'the outbox FILE exists but the companion has not recorded a terminal state for this turn.',
      'A worker writes it before session/prompt returns and the companion validates it after, so',
      'this file may still be being written, or about to be refused. Wait for the terminal state.',
    )
  }
  if (!report.outboxFound && report.settled && report.sessionId) {
    const resume = resumeCommand(report.cwd, report.taskId, {
      sessionId: report.sessionId,
      worker: report.liveness?.worker,
      routing: recordedRouting(report.cwd, report.taskId),
    })
    lines.push('', 'the turn ended without an outbox — try RESUME before paying for a re-dispatch:', resume)
  }
  return lines.join('\n')
}

// Recorded because the lease is the SLOW answer. `next_lease_expiry_at` is up
// to fifteen minutes out, so a lane that died two minutes ago still reads as
// running — measured twice on 2026-08-17, once for four hours. A pid answers
// immediately. Pid reuse can only produce a false ALIVE, which then falls back
// to the lease, so the wrong answer is the harmless direction.
export function pidPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'dispatch-pids', `${taskId}`) }

export function recordedPid(cwd, taskId) {
  try {
    const value = Number(readFileSync(pidPath(cwd, taskId), 'utf8').trim())
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

// No EPERM branch, deliberately. The first version had one — "it exists and is
// not ours to signal, so it is alive" — and a mutation showed nothing tested
// it, because the pid here is always a child THIS process spawned as this user,
// so EPERM cannot arise for it. The only way to reach EPERM is pid reuse by
// another user, and in that case the lane really is gone, so the branch was
// both untestable and wrong. An untested branch guarding a case that cannot
// happen is worse than no branch: it reads as care.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function spawnDetached(worker, cwd, taskId, briefFile, stallSec, { spawnFn = spawn, env = process.env } = {}) {
  // FIRST. Every line below builds a path out of this value.
  assertSafeTaskId(taskId)
  mkdirSync(join(cwd, '.tmux-teams', 'runner-logs'), { recursive: true })
  const logFd = openSync(logPath(cwd, taskId), 'a', 0o600)
  const argv = [COMPANION, worker, cwd, taskId, briefFile]
  if (stallSec !== undefined) argv.push(String(stallSec))
  // The whole environment, not an allowlist. Every ACP_* variable an operator
  // exports — model, expectation, resume, adapter — reaches the lane with
  // nothing to remember and nothing to forget.
  const child = spawnFn(process.execPath, argv, { cwd, detached: true, stdio: ['ignore', logFd, logFd], env })
  child.unref()
  if (Number.isInteger(child.pid)) {
    mkdirSync(join(cwd, '.tmux-teams', 'dispatch-pids'), { recursive: true })
    writeFileSync(pidPath(cwd, taskId), `${child.pid}\n`, { mode: 0o600 })
  }
  // `ACP_RESUME` is deliberately NOT captured: a resume of a resume must carry
  // the session id the operator is recovering, not the one the last attempt was
  // itself resuming.
  const routingEnv = {}
  for (const key of ROUTING_ENV_KEYS) {
    if (env?.[key] !== undefined && env[key] !== '') routingEnv[key] = String(env[key])
  }
  mkdirSync(join(cwd, '.tmux-teams', 'dispatch-routing'), { recursive: true })
  writeFileSync(routingPath(cwd, taskId),
    `${JSON.stringify({ worker, briefFile, stallSec: stallSec ?? null, env: routingEnv }, null, 2)}\n`,
    { mode: 0o600 })
  return child
}

// Waits for the lane's IDENTITY, not merely for a file to appear. The companion
// writes its first snapshot before it spawns the adapter, so the file exists
// within milliseconds carrying `identity_status: 'missing'` — the first version
// reported that as the boot result and printed `unknown (missing)` for a lane
// whose identity was acknowledged as `matched` four seconds later. The point of
// waiting at all is to keep the fail-closed identity check synchronous, so the
// thing waited for has to be the acknowledgement.
// A liveness record belongs to THIS dispatch only if the child wrote it after
// we spawned the child. Re-dispatching or resuming into the same run directory
// leaves the previous run's snapshot in place, identity and all — and this
// caller read one: it reported `gpt-5.6-sol[max] (matched)` and a session id
// for a resume whose own record, one second later, said `identity_status:
// missing`. On a plugin whose entire subject is provenance, reporting a
// previous run's identity as this one's is the worst small bug available.
//
// A record with no `started_at` is treated as not-this-run rather than
// accepted: the companion always writes it, so its absence means the file is
// not what this function is looking for.
// No tolerance. The first version allowed a second of slack for clock
// granularity, and the PR reviewer pointed out that both timestamps come from
// the SAME host clock: the slack buys nothing and, on a retry inside one
// second, accepts the predecessor's snapshot — recreating the exact
// stale-identity failure this check exists to prevent.
function belongsToThisRun(record, spawnedAtMs) {
  const started = Date.parse(record?.started_at ?? '')
  return Number.isFinite(started) && started >= spawnedAtMs
}

async function watchBoot(child, cwd, taskId, bootMs, spawnedAtMs) {
  const path = livenessPath(cwd, taskId)
  const deadline = Date.now() + bootMs
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  for (;;) {
    const found = readJson(path)
    const record = belongsToThisRun(found, spawnedAtMs) ? found : null
    // A lane that reached a TERMINAL state during boot did not boot — it failed.
    // The first version folded this into `live` and printed an identity beside
    // exit 0 for a consultation that never started: an identity refusal, an
    // unsupported model, a config option the adapter would not take. Reported as
    // its own outcome now, because "dispatched successfully" and "refused before
    // the prompt" are not the same answer.
    if (record && hasTerminated(record)) return { outcome: 'terminal', record }
    if (record && record.effective_identity) return { outcome: 'live', record }
    // Checked AFTER the liveness read so a child that wrote its file and exited
    // in the same tick is reported as booted rather than as a failure.
    if (exited) return { outcome: 'exited', record, ...exited }
    if (Date.now() >= deadline) return { outcome: 'booting', record }
    await sleep(POLL_MS)
  }
}

// `0` means THE TURN ENDED and the outbox is the answer, so it needs both.
//
// An ACP worker normally writes its outbox before `session/prompt` returns, and
// the companion validates that file and records its terminal state afterwards —
// so ranking the file first let `wait` exit 0 while the lane was still active,
// handing back a file that might still be being written or about to be
// rejected. The repository's PR reviewer caught it contradicting this file's own
// documented promise. Waiting the extra moment costs nothing; the wrong answer
// costs a review read from a half-written file.
export function statusExitCode(report) {
  if (report.outboxFound && report.terminated) return EXIT_OUTBOX
  if (!report.settled) return EXIT_RUNNING
  return EXIT_NO_OUTBOX
}

// The other half of detaching, and it was missing until Master asked the
// obvious question: this process hands a lane its own process group so no
// caller's cap can end it, and then nobody is told when it DOES end. A watcher
// hand-rolled per dispatch is a rule again, so it lives here.
//
// It watches. It never kills. When the budget runs out the lane is untouched
// and this says so — a waiter that reaped what it was waiting for would be the
// same bug in a later costume.
//
// The terminal condition is BOTH outcomes, never just the good one. A watcher
// that only looks for an outbox is silent through a lane that ended without
// writing anything, and silence reads exactly like still-running.
export async function waitForSettlement(cwd, taskId, maxMs, {
  out = console.log, pollMs = 15000, now = () => Date.now(),
} = {}) {
  const deadline = now() + maxMs
  for (;;) {
    const report = statusReport(cwd, taskId)
    const code = statusExitCode(report)
    if (code !== EXIT_RUNNING) {
      out(formatStatus(report))
      return code
    }
    if (now() >= deadline) {
      out(formatStatus(report))
      out(`\nstill running after ${Math.round(maxMs / 1000)}s of waiting.`)
      out('THE LANE IS UNTOUCHED — this waiter has no authority over it. Wait again, or poll with status.')
      return EXIT_RUNNING
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
  }
}

export async function main(argv, { out = console.log, err = console.error, spawnFn = spawn, env = process.env } = {}) {
  if (argv[0] === 'status') {
    const [, cwdArg, taskId] = argv
    if (!cwdArg || !taskId) { err(USAGE); return 2 }
    const report = statusReport(resolve(cwdArg), taskId)
    out(formatStatus(report))
    return statusExitCode(report)
  }

  if (argv[0] === 'wait') {
    const [, cwdArg, taskId, maxSec] = argv
    if (!cwdArg || !taskId) { err(USAGE); return 2 }
    const budget = Number(maxSec ?? 3600)
    if (!Number.isFinite(budget) || budget <= 0) { err(USAGE); return 2 }
    return waitForSettlement(resolve(cwdArg), taskId, budget * 1000,
      { out, pollMs: Number(env.ACP_DISPATCH_POLL_SEC ?? 15) * 1000 })
  }

  const [worker, cwdArg, taskId, briefFile, stallSec] = argv
  if (!worker || !cwdArg || !taskId || !briefFile) { err(USAGE); return 2 }
  // Before ANY path is built from it. `spawnDetached` asserts the same thing —
  // this is the operator-facing message, that one is the guarantee.
  if (!safeTaskId(taskId)) {
    err(`invalid task id "${taskId}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
    return 2
  }
  const cwd = resolve(cwdArg)
  // A typo here used to restore the very coupling this file removes: a
  // non-numeric value made `bootMs` NaN, every deadline comparison false, and
  // the "short-lived" dispatcher attached to a hanging child forever.
  const bootSec = Number(env.ACP_DISPATCH_BOOT_SEC ?? BOOT_SEC_DEFAULT)
  if (!Number.isFinite(bootSec) || bootSec <= 0) {
    err(`ACP_DISPATCH_BOOT_SEC must be a positive number of seconds, got "${env.ACP_DISPATCH_BOOT_SEC}"`)
    return 2
  }
  // Taken BEFORE the spawn, so any snapshot the child writes is stamped later
  // than this and a previous run's snapshot is stamped earlier.
  const spawnedAtMs = Date.now()
  const child = spawnDetached(worker, cwd, taskId, resolve(briefFile), stallSec, { spawnFn, env })
  const bootMs = bootSec * 1000
  const booted = await watchBoot(child, cwd, taskId, bootMs, spawnedAtMs)

  const self = shQuote(join(HERE, 'acp-dispatch.mjs'))
  out(`dispatched ${worker} as ${taskId} — pid ${child.pid}, detached, own process group`)
  out(`log: ${logPath(cwd, taskId)}`)
  out(`outbox will be: ${outboxPath(cwd, taskId)}`)
  out(`status: node ${self} status ${shQuote(cwd)} ${shQuote(taskId)}`)
  // Printed beside status because "how do I know it finished" is the question
  // detaching creates, and an answer nobody is handed is not an answer.
  out(`wait:   node ${self} wait ${shQuote(cwd)} ${shQuote(taskId)} 3600`)
  out('        (run `wait` in the background — killing the waiter does not touch the lane)')

  if (booted.outcome === 'terminal') {
    err(`the lane reached ${booted.record.liveness_state} before its prompt — `
      + `termination_reason: ${booted.record.termination_reason ?? 'none'}`)
    err('this consultation never started. Read the log above; an identity or config refusal ends here.')
    return 2
  }
  if (booted.outcome === 'exited') {
    err(`the companion exited before writing liveness — code ${booted.code}, signal ${booted.signal ?? 'none'}`)
    err('read the log above; a usage or identity refusal exits here.')
    return 2
  }
  if (booted.outcome === 'booting') {
    // Deliberately NOT a kill. This process has no authority over a lane's
    // lifetime; that is the entire point of the file.
    out(`identity not acknowledged after ${bootMs / 1000}s — the lane is RUNNING, not stuck.`)
    out(`liveness_state: ${booted.record?.liveness_state ?? 'none'} · poll with the status command above.`)
    return 1
  }
  out(`effective_identity: ${booted.record.effective_identity ?? 'unknown'} (${booted.record.identity_status ?? 'unknown'})`)
  out(`session_id: ${readSessionId(cwd, taskId) ?? 'not yet written'}`)
  return 0
}

// Percent-encoding and symlinks both break the obvious form of this comparison;
// `realpathSync` on both sides is what a spawned test proved. See the same guard
// in `party-mode/scripts/acp-lanes-mcp.mjs` for the two-bug story.
export function launchedDirectly(entry = process.argv[1]) {
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry))
  } catch {
    return false
  }
}

if (launchedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
