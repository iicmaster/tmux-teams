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
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, 'acp-companion.mjs')

export const USAGE = [
  'usage: node acp-dispatch.mjs <claude|codex|agy> <cwd> <task-id> <brief-file> [stall-sec]',
  '       node acp-dispatch.mjs status <cwd> <task-id>',
].join('\n')

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

export function statusReport(cwd, taskId) {
  const liveness = readJson(livenessPath(cwd, taskId))
  const outbox = outboxPath(cwd, taskId)
  const found = existsSync(outbox) && lstatSync(outbox).isFile()
  const settled = liveness === null ? false : liveness.liveness_state !== 'running'
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
  return child
}

async function watchBoot(child, cwd, taskId, bootMs) {
  const path = livenessPath(cwd, taskId)
  const deadline = Date.now() + bootMs
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  for (;;) {
    const record = readJson(path)
    if (record) return { outcome: 'live', record }
    // Checked AFTER the liveness read so a child that wrote its file and exited
    // in the same tick is reported as booted rather than as a failure.
    if (exited) return { outcome: 'exited', ...exited }
    if (Date.now() >= deadline) return { outcome: 'booting' }
    await sleep(POLL_MS)
  }
}

export async function main(argv, { out = console.log, err = console.error, spawnFn = spawn, env = process.env } = {}) {
  if (argv[0] === 'status') {
    const [, cwdArg, taskId] = argv
    if (!cwdArg || !taskId) { err(USAGE); return 2 }
    const report = statusReport(resolve(cwdArg), taskId)
    out(formatStatus(report))
    if (report.outboxFound) return 0
    return report.settled ? 2 : 1
  }

  const [worker, cwdArg, taskId, briefFile, stallSec] = argv
  if (!worker || !cwdArg || !taskId || !briefFile) { err(USAGE); return 2 }
  const cwd = resolve(cwdArg)
  // Argv beyond this point is the companion's to judge. Re-validating the task
  // id here would be a second copy of a rule that can drift from the one that
  // matters; the companion exits 2 and this process reports it.
  const child = spawnDetached(worker, cwd, taskId, resolve(briefFile), stallSec, { spawnFn, env })
  const bootMs = Number(env.ACP_DISPATCH_BOOT_SEC ?? BOOT_SEC_DEFAULT) * 1000
  const booted = await watchBoot(child, cwd, taskId, bootMs)

  out(`dispatched ${worker} as ${taskId} — pid ${child.pid}, detached, own process group`)
  out(`log: ${logPath(cwd, taskId)}`)
  out(`outbox will be: ${outboxPath(cwd, taskId)}`)
  out(`status: node ${join(HERE, 'acp-dispatch.mjs')} status ${cwd} ${taskId}`)

  if (booted.outcome === 'exited') {
    err(`the companion exited before writing liveness — code ${booted.code}, signal ${booted.signal ?? 'none'}`)
    err('read the log above; a usage or identity refusal exits here.')
    return 2
  }
  if (booted.outcome === 'booting') {
    // Deliberately NOT a kill. This process has no authority over a lane's
    // lifetime; that is the entire point of the file.
    out(`still booting after ${bootMs / 1000}s — the lane is RUNNING, not stuck. Poll with the status command above.`)
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
