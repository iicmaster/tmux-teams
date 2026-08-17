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

// Reuses the SAME task id on purpose. A resume under a fresh id moves the outbox
// path out from under the prompt the agent was already given — see `outboxPath`.
export function resumeCommand(cwd, taskId, { sessionId, worker, model, effort, briefFile }) {
  if (!sessionId) return null
  const parts = [`ACP_RESUME="${sessionId}"`]
  if (model) parts.push(`ACP_MODEL="${model}"`, `ACP_EXPECT_MODEL="${model}"`)
  if (effort) parts.push(`ACP_REASONING_EFFORT="${effort}"`, `ACP_EXPECT_REASONING_EFFORT="${effort}"`)
  return [
    `${parts.join(' ')} \\`,
    `  node ${join(HERE, 'acp-dispatch.mjs')} \\`,
    `    ${worker ?? '<worker>'} ${cwd} ${taskId} ${briefFile ?? '<recovery-brief-file>'} 900`,
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

// `cancelling` is not in that set, and round three's interrupted lane died
// there and never moved: a killed process writes no further snapshot. So a
// recorded termination reason counts as settled too — and the reason field
// carries the STRING 'none' while a lane is healthy, never null, which is its
// own small trap.
function hasTerminated(liveness) {
  if (liveness === null) return false
  if (TERMINAL_LIVENESS_STATES.includes(liveness.liveness_state)) return true
  const reason = liveness.termination_reason
  return typeof reason === 'string' && reason !== '' && reason !== 'none'
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

function isSettled(liveness, now = Date.now()) {
  return hasTerminated(liveness) || (liveness !== null && leaseExpired(liveness, now))
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
  const stopped = !hasTerminated(liveness) && (pidGone || (liveness !== null && leaseExpired(liveness)))
  const settled = hasTerminated(liveness) || stopped
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
  if (!report.outboxFound && report.settled && report.sessionId) {
    const resume = resumeCommand(report.cwd, report.taskId, {
      sessionId: report.sessionId,
      worker: report.liveness?.worker,
      model: report.liveness?.requested_model,
      effort: report.liveness?.requested_reasoning_effort,
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
function belongsToThisRun(record, spawnedAtMs) {
  const started = Date.parse(record?.started_at ?? '')
  return Number.isFinite(started) && started >= spawnedAtMs - 1000
}

async function watchBoot(child, cwd, taskId, bootMs, spawnedAtMs) {
  const path = livenessPath(cwd, taskId)
  const deadline = Date.now() + bootMs
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  for (;;) {
    const found = readJson(path)
    const record = belongsToThisRun(found, spawnedAtMs) ? found : null
    if (record && (record.effective_identity || isSettled(record))) return { outcome: 'live', record }
    // Checked AFTER the liveness read so a child that wrote its file and exited
    // in the same tick is reported as booted rather than as a failure.
    if (exited) return { outcome: 'exited', record, ...exited }
    if (Date.now() >= deadline) return { outcome: 'booting', record }
    await sleep(POLL_MS)
  }
}

export function statusExitCode(report) {
  if (report.outboxFound) return EXIT_OUTBOX
  return report.settled ? EXIT_NO_OUTBOX : EXIT_RUNNING
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
  const cwd = resolve(cwdArg)
  // Argv beyond this point is the companion's to judge. Re-validating the task
  // id here would be a second copy of a rule that can drift from the one that
  // matters; the companion exits 2 and this process reports it.
  // Taken BEFORE the spawn, so any snapshot the child writes is stamped later
  // than this and a previous run's snapshot is stamped earlier.
  const spawnedAtMs = Date.now()
  const child = spawnDetached(worker, cwd, taskId, resolve(briefFile), stallSec, { spawnFn, env })
  const bootMs = Number(env.ACP_DISPATCH_BOOT_SEC ?? BOOT_SEC_DEFAULT) * 1000
  const booted = await watchBoot(child, cwd, taskId, bootMs, spawnedAtMs)

  out(`dispatched ${worker} as ${taskId} — pid ${child.pid}, detached, own process group`)
  out(`log: ${logPath(cwd, taskId)}`)
  out(`outbox will be: ${outboxPath(cwd, taskId)}`)
  out(`status: node ${join(HERE, 'acp-dispatch.mjs')} status ${cwd} ${taskId}`)
  // Printed beside status because "how do I know it finished" is the question
  // detaching creates, and an answer nobody is handed is not an answer.
  out(`wait:   node ${join(HERE, 'acp-dispatch.mjs')} wait ${cwd} ${taskId} 3600`)
  out('        (run `wait` in the background — killing the waiter does not touch the lane)')

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
