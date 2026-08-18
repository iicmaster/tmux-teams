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
import { chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
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
// 2 covers two different facts and the comment used to name only one: a turn
// that ENDED without writing, and a lane that STOPPED REPORTING and may have
// died mid-turn. `status` says which; the exit code cannot, and pretending it
// does is how an operator resumes something that is still running.
// Kept beside the resume command that prints it. The companion owns the real
// default; this constant exists so the two can be asserted equal rather than
// hoped equal.
export const COMPANION_DEFAULT_STALL_SEC = 600

export const EXIT_NO_OUTBOX = 2     // no outbox, and the lane is not going to produce one on its own

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

// Opening a path is not the same as opening the FILE you meant, and a lexical
// id check only confines the spelling. A pre-existing symlink at
// `.tmux-teams/dispatch-pids/<id>` is followed by an ordinary write, which
// truncates whatever it points at — outside the run directory, after the child
// has already spawned. The log is worse: a symlink there redirects the child's
// entire stdout somewhere else. Raised by an advisor round on 2026-08-17.
//
// **The first fix was `O_NOFOLLOW` alone, with a comment calling the final
// component "the component an attacker can pre-position". That claim was
// false**, and the next round said so: `O_NOFOLLOW` refuses a symlinked LEAF
// and pathname resolution still walks the parents, so a symlinked
// `.tmux-teams`, `runner-logs`, `dispatch-pids` or `dispatch-routing` sends an
// `O_TRUNC` write to a same-named file in any writable directory. Under the
// hostile-run-directory model this file claims to hold, the attacker owns the
// whole walk before that safe basename.
//
// So the chain is checked as well as the leaf, and checked BEFORE the child is
// spawned — a refusal after `unref()` leaves a detached lane alive with no
// trustworthy records, which is a different and worse failure than not starting.
//
// **The residual, stated exactly, because the first two attempts at this
// paragraph overstated it and a review round said so both times.** Node exposes
// no `openat`, so nothing here can hold a directory capability and open
// relative to it. Two windows follow, not one: between a component check and
// the next component's `mkdir`, and between the final check and the open. An
// attacker with write and search permission on a relevant parent — no elevated
// privilege needed — can swap a component in either window and get a directory
// created or a file opened outside the root.
//
// So the guarantee is: **absent concurrent replacement, creation never happens
// past a symlinked component, and a pre-positioned symlink is refused.** That
// is the reachable case and it is what these checks close. Under an attacker
// racing the walk, they do not. An anchored-fd design would, and needs a
// primitive Node does not give us.
function openNoFollow(path, flags, mode = 0o600) {
  try {
    return openSync(path, flags | (fsConstants.O_NOFOLLOW ?? 0), mode)
  } catch (cause) {
    if (cause.code === 'ELOOP' || cause.code === 'EMLINK') {
      throw Object.assign(new Error(`refusing to write through a symlink at ${path}`), { code: 'unsafe_artifact' })
    }
    throw cause
  }
}

// Every directory between the run root and an artifact must still BE inside the
// run root once symlinks are resolved. Checked for all three artifact
// directories up front, so the answer to "is this run directory hostile" is
// known before anything is spawned.
export function assertContainedDir(root, ...parts) {
  // ONE COMPONENT AT A TIME, checking before creating.
  //
  // The first version called `mkdirSync(dir, { recursive: true })` and THEN
  // checked containment, which an advisor round caught: with `.tmux-teams`
  // pre-positioned as a symlink to a writable outside directory, the missing
  // `runner-logs` was CREATED out there and only then refused. A fail-closed
  // preflight that mutates outside the root before failing is not fail-closed,
  // and the operator gets no receipt for what it made.
  //
  // Walking instead of recursing is what fixes it: every component that already
  // exists is rejected if it is a symlink before its child is considered, so
  // creation never happens past one.
  let current = root
  for (const part of parts) {
    current = join(current, part)
    let stat = null
    try {
      stat = lstatSync(current)
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause
    }
    if (stat === null) {
      // 0700, not the umask default. This repository's ledger writer already
      // states that prose-bearing state is owner-only and enforces 0700/0600,
      // and an ACP runner log carries prompts, model output and diagnostics.
      // A review round measured 0755 here under an ordinary umask and was right
      // that the default is not the safe choice for this content.
      // EEXIST is a RACE, not an error: another dispatch created the same
      // directory between the lstat above and this line. Tolerating it here is
      // what lets two concurrent dispatches reach the atomic claim instead of
      // crashing in the preflight — found by the race test written for that
      // claim, which is the only way a window this small shows itself.
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
      }
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw Object.assign(
        new Error(`refusing a run directory whose ${current.slice(root.length + 1)} is not a real directory inside it`),
        { code: 'unsafe_artifact' },
      )
    }
  }
  // Belt and braces: the walk above should make this unreachable, and an
  // unreachable check that costs one syscall is worth keeping on a path whose
  // whole job is refusing a hostile directory.
  const realRoot = realpathSync(root)
  const realDir = realpathSync(current)
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw Object.assign(
      new Error(`refusing a run directory whose ${current.slice(root.length + 1)} resolves outside it`),
      { code: 'unsafe_artifact' },
    )
  }
  return realDir
}

// And the leaf, before spawn as well as at write time. `O_NOFOLLOW` at the
// write is the guarantee; this is the part that lets the refusal happen while
// refusing still means "nothing started".
function assertNotSymlink(path) {
  let stat = null
  try {
    stat = lstatSync(path)
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
    return
  }
  // A symlink is not the only way a leaf can be someone else's file. A release
  // panel pointed out that the policy was symlink-ONLY: a hard link shares the
  // inode with a victim and `lstat` calls it a regular file, and a fifo or a
  // device is not a thing to write a pid into at all. `nlink > 1` is what a
  // hard link looks like from here.
  if (stat.isSymbolicLink()) {
    throw Object.assign(new Error(`refusing to write through a symlink at ${path}`), { code: 'unsafe_artifact' })
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error(`refusing to write to a non-regular file at ${path}`), { code: 'unsafe_artifact' })
  }
  if (stat.nlink > 1) {
    throw Object.assign(
      new Error(`refusing to write to a hard-linked file at ${path} — it is also someone else's`),
      { code: 'unsafe_artifact' },
    )
  }
  // An existing artifact keeps whatever mode it was created with, so the
  // owner-only guarantee applied only to files this dispatcher made. Tighten
  // what is already there rather than trusting its history.
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600)
}

function writeNoFollow(path, contents) {
  const fd = openNoFollow(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC)
  try {
    writeSync(fd, contents)
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}

// The ONE step in admission the filesystem can make atomic. `O_CREAT|O_EXCL`
// either creates the file or fails; two dispatches racing it cannot both win.
// The pid inside is written later, when the child exists — this only claims the
// NAME, which is the thing two lanes fight over.
//
// A panel lane marked the non-atomic admission PACKET-ADMITTED: my own comment
// said two dispatches racing the check both pass, and admitting a limitation is
// not the same as having one that cannot be removed. This removes the half that
// can be removed, on one machine. Two machines sharing a directory over NFS are
// still outside what this can promise, and that is stated rather than implied.
function claimTaskId(cwd, taskId) {
  const path = pidPath(cwd, taskId)
  try {
    closeSync(openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600))
    return true
  } catch (cause) {
    if (cause.code === 'EEXIST') return false
    throw cause
  }
}

export function livenessPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`) }
export function sessionPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'sessions', taskId) }

// Move a predecessor's leaf out of the way rather than deleting it, so its
// bytes stay readable and `strayOutboxes`-style forensics still work. The
// symlink check runs first for the same reason it does everywhere else in this
// file: a rename through a link moves someone else's file.
function retirePredecessorLeaf(path, spawnedAtIso) {
  let stat = null
  try {
    stat = lstatSync(path)
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
    return
  }
  if (stat.isSymbolicLink()) {
    throw Object.assign(new Error(`refusing to retire through a symlink at ${path}`), { code: 'unsafe_artifact' })
  }
  renameSync(path, `${path}.superseded-${spawnedAtIso.replaceAll(':', '-')}`)
}
export function logPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'runner-logs', `${taskId}.log`) }
// The one path the worker is told to write and this process reads back. It is
// derived from the task id in BOTH places and never typed twice — the second
// half of the same day's failure was a recovery prompt naming
// `.mailbox-out/mcp-round3` while the dispatch's task id made the companion
// read `.mailbox-out/mcp-round3-recover`. The review was written, complete, and
// reported as `no_outbox`.
export function outboxPath(cwd, taskId) { return join(cwd, '.mailbox-out', taskId) }

// The READ side had no symlink policy at all, and a panel lane showed what that
// costs: `status` follows a session symlink pointing anywhere and reflects the
// text it finds into the pasteable `ACP_RESUME` command. The dispatch-side
// guards refuse to WRITE through a link; they say nothing about reading one, and
// `status` runs against directories this dispatcher never created.
//
// So every read of a control leaf goes through here. A link is not followed and
// is not an error either — a report is a diagnostic, and refusing to print one
// because a leaf is hostile helps nobody. It reads as absent, which is the
// honest answer: there is no trustworthy record.
// The run root is PASSED, not derived. The first version counted three
// `dirname` calls back from the leaf, which is right for `.tmux-teams/<dir>/<x>`
// and one level too high for `.mailbox-out/<x>` — so the outbox check accepted
// a symlink pointing anywhere under the run directory's PARENT. Found by the
// test written for the fix, on the same afternoon: a guard that infers its own
// boundary from path shape is guessing.
// Listing a directory is a read too, and these were not going through any
// boundary — `strayOutboxes` listed `.mailbox-out` and the case check listed
// `.tmux-teams/<dir>`, both by pathname. Two panel families named it: a
// symlinked parent makes both of them enumerate somebody else's directory and
// report its contents as this run's. Returns an empty list rather than
// throwing, because a report that cannot enumerate should say "nothing here I
// can trust", not fail.
function readDirSync(path, runRoot) {
  try {
    const real = realpathSync(path)
    const root = realpathSync(runRoot)
    if (!real.startsWith(root + sep) && real !== root) return []
    return readdirSync(path)
  } catch {
    return []
  }
}

function readLeafSync(path, runRoot) {
  // The PARENTS as well as the leaf. `lstat` on the final component says
  // nothing about `.tmux-teams` or `sessions` being symlinks, so a hostile
  // parent still redirected the read — the boundary was called universal and
  // covered one component of the path. A panel lane reproduced it after the
  // leaf check went in, which is the second time a fix here covered the case I
  // pictured and not the case that was named.
  //
  // `realpathSync` on the DIRECTORY, compared against the run root: cheap, and
  // it answers the question the leaf check cannot.
  let stat = null
  try {
    const parent = realpathSync(dirname(path))
    const root = realpathSync(runRoot)
    if (!parent.startsWith(root + sep) && parent !== root) return null
    stat = lstatSync(path)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.nlink > 1) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function readJson(path, runRoot) {
  const text = readLeafSync(path, runRoot)
  if (text === null) return null
  try { return JSON.parse(text) } catch { return null }
}

function readSessionId(cwd, taskId) {
  return readLeafSync(sessionPath(cwd, taskId), cwd)?.trim() || null
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Anything in `.mailbox-out/` that is not this task's file. An outbox written
// under a name nobody reads is indistinguishable from no outbox at all, and the
// difference between them is a whole re-dispatch.
export function strayOutboxes(cwd, taskId) {
  try {
    return readDirSync(join(cwd, '.mailbox-out'), cwd).filter((name) => name !== taskId).sort()
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
  const record = readJson(routingPath(cwd, taskId), cwd)
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null
}

// Reuses the SAME task id on purpose. A resume under a fresh id moves the outbox
// path out from under the prompt the agent was already given — see `outboxPath`.
export function resumeCommand(cwd, taskId, { sessionId, worker, routing, briefFile }) {
  if (!sessionId) return null
  const env = routing?.env ?? {}
  // The brief and the stall the dispatch ACTUALLY used, recorded at spawn. A
  // release panel found the recorded brief ignored and a literal
  // `<recovery-brief-file>` emitted into a command line — shell syntax, in a
  // command whose whole purpose is being pasted. The placeholder survives only
  // when there is genuinely nothing recorded to name.
  const brief = briefFile ?? routing?.briefFile ?? null
  // `Number(...)`, because `stallSec` is recorded from argv and argv is
  // strings: `Number.isFinite('2400')` is false, so every recovery command
  // silently reset a custom stall to the default. Found by the gemini panel
  // lane — a fallback that fires always is indistinguishable from no feature.
  const recordedStall = Number(routing?.stallSec)
  // 600, because that is what `acp-companion.mjs` itself falls back to
  // (`positiveNumber(leaseArg, 600)`). This said 900, so a resume command
  // generated for a run with an omitted or unusable stall told the operator to
  // use a lease the original run never had — a panel lane read the two files
  // against each other and caught the drift. Measured in the companion, not
  // recalled.
  const stall = Number.isFinite(recordedStall) && recordedStall > 0 ? recordedStall : COMPANION_DEFAULT_STALL_SEC
  const parts = [`ACP_RESUME=${shQuote(sessionId)}`]
  for (const key of ROUTING_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') parts.push(`${key}=${shQuote(env[key])}`)
  }
  return [
    `${parts.join(' ')} \\`,
    `  node ${shQuote(join(HERE, 'acp-dispatch.mjs'))} \\`,
    `    ${shQuote(routing?.worker ?? worker ?? '<worker>')} ${shQuote(cwd)} ${shQuote(taskId)} `
      // Quoted even when it is a placeholder: `<...>` is a redirection, so the
      // old form made a paste do something rather than fail.
      + `${shQuote(brief ?? 'PUT-THE-RECOVERY-BRIEF-PATH-HERE')} ${stall}`,
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
// `next_lease_expiry_at` is a MEANINGFUL-PROGRESS lease, not a heartbeat: a
// companion may reach it, record a suspected stall, extend it and carry on. An
// expired lease therefore never outvotes a pid `pidAlive` just confirmed.
//
// This comment and the one inside the function said OPPOSITE things for three
// commits, and the code agreed with neither — written in two rounds that pulled
// in different directions, and caught by a panel lane quoting both back. When a
// function is edited from two sides, re-read every comment that touches it.
function hasStopped(liveness, { pid = null, now = Date.now() } = {}) {
  if (hasTerminated(liveness)) return false
  // Two panel families reproduced this from opposite directions and the answer
  // is that they were describing two different CALL SITES, not two opinions.
  // gemini: an expired lease must not settle a lane `pidAlive` just confirmed —
  // the lease measures MEANINGFUL PROGRESS, and a companion in a long tool call
  // reaches it, records a suspected stall, extends it and carries on. openai: a
  // reused pid number must not hide a dead lane forever. The first is about
  // THIS function; the second is about admission, and is fixed there.
  //
  // So: a dead pid settles it. A live pid settles nothing — `leaseStale` in the
  // report carries that evidence without ending the wait. With no pid to ask,
  // the lease is the only evidence there is.
  if (pid !== null) return !pidAlive(pid)
  return liveness !== null && leaseExpired(liveness, now)
}

function isSettled(liveness, options = {}) {
  return hasTerminated(liveness) || hasStopped(liveness, options)
}

export function statusReport(cwd, taskId) {
  // The same rule the dispatch path applies, at the boundary that BUILDS the
  // paths. `status` and `wait` are public modes and were passing the raw id
  // straight in here, so an id containing `../` made them read attacker-chosen
  // JSON and reflect fields out of it — the read half of the traversal, which
  // the dispatch-only guard did not cover.
  assertSafeTaskId(taskId)
  const routing = recordedRouting(cwd, taskId)
  const spawnedAtMs = Date.parse(routing?.spawnedAt ?? '')
  const rawLiveness = readJson(livenessPath(cwd, taskId), cwd)
  // A liveness record that predates the dispatch we recorded is the previous
  // run's, and settling on it is how a stale terminal record plus a stale
  // outbox add up to a false success.
  //
  // With NO routing file there is nothing to bind to, and the record is taken
  // as-is. That is deliberate rather than an oversight: `status` has to work
  // against a run directory this dispatcher never created — a lane started by
  // `loop-runner.mjs`, or by an operator on another machine — and refusing to
  // report on one would make the tool useless exactly where a person is most
  // lost. The cost is that the generation binding protects only runs this
  // dispatcher started, which is the population it can speak for.
  const liveness = Number.isFinite(spawnedAtMs) && rawLiveness !== null
    && !belongsToThisRun(rawLiveness, spawnedAtMs) ? null : rawLiveness
  const outbox = outboxPath(cwd, taskId)
  // Through the same boundary as every other control read. This checked the
  // LEAF's type and nothing above it, so a symlinked `.mailbox-out` decided
  // whether this run counts as finished — on the ONE artifact the exit code is
  // built from. A lane reproduced it. `readLeafSync` returns null for a path
  // whose parent resolves outside the run root, for a non-regular file and for
  // a hard link, which is exactly the set that must not answer this question.
  const found = readLeafSync(outbox, cwd) !== null
  // The pid answers NOW; the lease answers in up to fifteen minutes. Both, and
  // the pid only when this dispatcher recorded one — `status` also has to work
  // against a run directory it did not create.
  const pid = recordedPid(cwd, taskId)
  const pidGone = pid !== null && !pidAlive(pid)
  const stopped = hasStopped(liveness, { pid })
  const terminated = hasTerminated(liveness)
  const leaseStale = liveness !== null && !hasTerminated(liveness)
    && leaseExpired(liveness, Date.now()) && !stopped
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
    notReporting: stopped || leaseStale,
    // `leaseStale` reports and does NOT settle. Two panel families landed on
    // opposite sides of this in one round and both were right: a live pid must
    // not mask an expired lease forever (a reused pid number would hide a dead
    // lane), and an expired lease must not settle a lane that is mid-tool-call.
    // They are two facts. `settled` uses only the one that can be proven; the
    // other is reported so an operator can look.
    leaseStale,
    stoppedBecause: pidGone
      ? 'its process is gone'
      : (stopped ? 'its own lease expired' : (leaseStale ? 'its lease expired while its process is still alive' : null)),
    pid,
    routing,
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
  if (report.outboxFound && report.terminated
    && ['failed', 'cancelled'].includes(report.livenessState)) {
    lines.push(
      `the outbox exists AND the turn ended as ${report.livenessState}`
        + ` (${report.terminationReason}). Read it, but read the log too:`,
      'a lane can write an answer and still have ended badly, and exit 0 alone does not say which.',
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
      routing: report.routing,
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
  // Through `readLeafSync`, like every other control-leaf read. This function
  // called `readFileSync` on the pid path directly, so the "safe read boundary"
  // had a hole in the one reader admission depends on — and a FIFO planted
  // there blocks the reader outright. A panel lane reproduced both.
  const text = readLeafSync(pidPath(cwd, taskId), cwd)
  if (text === null) return null
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isInteger(pid) && pid > 1 ? pid : null
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
  const spawnedAtIso = new Date().toISOString()
  // Retire the PREDECESSOR's outbox before the new lane starts.
  //
  // `statusExitCode` requires a terminal record AND an outbox, which sounds
  // sufficient until both bytes belong to the previous run of the same task id
  // while today's pid is alive — a false SUCCESS at the exact moment an
  // operator is deciding whether the work is done. An advisor round named it on
  // 2026-08-17. Renaming rather than deleting: the predecessor's answer is
  // still on disk, and `strayOutboxes` will point at it.
  // The whole filesystem question, answered BEFORE anything is spawned. A
  // refusal after `unref()` leaves a detached lane alive with no trustworthy
  // records — worse than never starting.
  // `liveness` and `sessions` were NOT in this list, and three panel lanes said
  // so. The companion writes both, `statusReport` READS both, and a symlinked
  // parent on either sends the write out of the tree or feeds the reader a
  // stranger's file — which is the same class as the four already covered, on
  // the two directories whose contents this tool actually reports.
  for (const artifact of ['runner-logs', 'dispatch-pids', 'dispatch-routing', 'liveness', 'sessions']) {
    assertContainedDir(cwd, '.tmux-teams', artifact)
  }
  // `.mailbox-out` is the FOURTH write path and it was not checked. The
  // predecessor-outbox retirement renames through it, so a symlinked
  // `.mailbox-out` plus an outside regular file named for the task moved a
  // stranger's file before anything spawned — the same parent-resolution class
  // as the three above, on the one directory that was not in the list.
  assertContainedDir(cwd, '.mailbox-out')
  // ADMISSION, and it sits HERE for a reason a panel lane reproduced: it used to
  // run at the top of this function, so `recordedPid()` READ a pid file before
  // the containment preflight above had established that `dispatch-pids` is a
  // real directory inside the tree. A read-before-check, introduced by the very
  // feature meant to make dispatch safer.
  //
  // Two companions under one task id share a liveness file, a pid file and an
  // outbox path, and the operator cannot tell whose answer they read. But a
  // LIVE PID ALONE is not evidence of a live lane — pid numbers are reused, and
  // refusing on that alone locks a task id forever behind an unrelated process
  // (the other half of what the panel found). So refuse only when the pid is
  // alive AND the lane is still reporting progress.
  //
  // The checks above read state and can be raced. The CLAIM below cannot: it is
  // an `O_CREAT|O_EXCL` create of the pid path, so of two dispatches racing to
  // the same task id on this machine exactly one proceeds. What the reads above
  // still buy is a good REFUSAL MESSAGE — the claim alone would say only "taken".
  // A MISSING pid leaf is not evidence that nothing is running: the leaf can be
  // refused by the read policy, deleted by an operator, or never have been
  // written. Admission asked `recordedPid` and stopped there, so a lane whose
  // liveness says it is mid-turn was admitted a second writer whenever its pid
  // file was unreadable. A panel lane reproduced it.
  //
  // With no pid to ask, the lease is the only evidence there is — the same rule
  // `hasStopped` already applies, applied here too.
  // CASE. macOS and Windows default to case-insensitive filesystems, so `Review`
  // and `review` are two task ids to this dispatcher and one set of files to the
  // disk — two lanes writing the same liveness, pid, routing and outbox while
  // every check above says they are unrelated. A lane reproduced it. There is no
  // portable way to make the paths distinct, so the collision is refused where
  // it can be seen: an existing artifact spelled differently means the id is
  // taken.
  for (const dir of ['liveness', 'dispatch-pids', 'dispatch-routing']) {
    const at = join(cwd, '.tmux-teams', dir)
    for (const leaf of readDirSync(at, cwd)) {
      const stem = leaf.replace(/\.(json|superseded-.*)$/, '').replace(/\.superseded-.*$/, '')
      if (stem !== taskId && stem.toLowerCase() === taskId.toLowerCase()) {
        throw Object.assign(
          new Error(`task id "${taskId}" differs only by case from "${stem}", which already has `
            + `artifacts here — on a case-insensitive filesystem they are the same files`),
          { code: 'task_id_case_collision' },
        )
      }
    }
  }
  const livePid = recordedPid(cwd, taskId)
  if (livePid === null) {
    // Bound to the RECORDED dispatch, exactly as `statusReport` binds it. A
    // predecessor's unsettled record is not this task id's live lane — it is
    // the thing the retirement below exists to move aside, and refusing on it
    // would make every re-dispatch after an interrupted run impossible. The
    // test caught that within a minute of the first version.
    const priorSpawn = Date.parse(recordedRouting(cwd, taskId)?.spawnedAt ?? '')
    const record = Number.isFinite(priorSpawn) && belongsToThisRun(readJson(livenessPath(cwd, taskId), cwd), priorSpawn)
      ? readJson(livenessPath(cwd, taskId), cwd)
      : null
    if (record !== null && !isSettled(record, { pid: null })) {
      throw Object.assign(
        new Error(`a lane for "${taskId}" is still reporting progress and its pid file `
          + 'cannot be read — ask it with `status`, or use a different task id'),
        { code: 'already_running' },
      )
    }
  }
  if (livePid !== null && pidAlive(livePid)) {
    // The SAME predicate `status` uses, because a panel lane reproduced the two
    // disagreeing: `hasStopped` leaves a live pid unsettled (the companion may
    // be mid-tool-call) while this computed `stillReporting = false` from an
    // expired lease and admitted a SECOND child under the same task id — the
    // duplicate writer admission exists to refuse. I fixed the two call sites
    // to satisfy two different reviewers and made them contradict each other.
    //
    // One question, asked once: is this lane settled? If it is not, it is still
    // this task id's lane and a second one is refused.
    const record = readJson(livenessPath(cwd, taskId), cwd)
    if (!isSettled(record, { pid: livePid })) {
      // The two panel rounds pulled in opposite directions here, from the SAME
      // family: round five said a reused pid must not lock a task id forever;
      // round six said admission must not admit a second writer for a lane
      // status calls unsettled. A pid number plus a lease cannot tell a wedged
      // lane from a recycled pid, so this refuses — a duplicate writer is
      // unrecoverable, a refusal is not — and names the way out instead of
      // leaving the operator to find it.
      const stale = readJson(livenessPath(cwd, taskId), cwd)?.next_lease_expiry_at ?? null
      throw Object.assign(
        new Error(`a lane for "${taskId}" is already running as pid ${livePid} — `
          + 'ask it with `status`, or use a different task id.'
          + (stale ? ` Its progress lease says ${stale}: if that is long past and pid ${livePid} `
            + 'is some other program that inherited the number, remove '
            + `.tmux-teams/dispatch-pids/${taskId} and dispatch again.` : '')),
        { code: 'already_running' },
      )
    }
  }
  // Retire the PREDECESSOR's liveness and session leaves, for the same reason
  // the outbox above is retired and by the same means. `belongsToThisRun`
  // compares TIMESTAMPS and nothing else — no nonce, no task id, no worker — so
  // a record stamped inside the accepted window reads as ours, and a panel lane
  // reproduced a fresh dispatch reporting `session_id: predecessor-session`
  // and offering ACP_RESUME for a session that was never ours.
  //
  // A bound cannot fix that; only identity can, and a nonce is a protocol
  // change. What IS available today is removal: a leaf that is not on disk
  // cannot be mistaken for this run's, and the predecessor's bytes are kept
  // under a suffix rather than deleted, exactly as the outbox is.
  for (const leaf of [livenessPath(cwd, taskId), sessionPath(cwd, taskId)]) {
    retirePredecessorLeaf(leaf, spawnedAtIso)
  }
  // The name is claimed AFTER the reads above, not before: a pid file left by a
  // lane that has since finished is not a live claim, and claiming first made
  // every ordinary re-dispatch fail. The reads decide whether the holder is
  // alive; the claim decides who wins when two dispatches pass those reads at
  // the same instant.
  //
  // `O_CREAT|O_EXCL` on a path that may legitimately already exist: remove the
  // dead holder's file first, which is safe because the reads above have just
  // established it is dead, then claim. Two racers both reach here, one create
  // succeeds, the other gets EEXIST and stops having changed nothing.
  // The leaf policy FIRST. The first version removed whatever was at the pid
  // path, which quietly deleted a planted symlink instead of refusing it — a
  // regression this file's own tests caught immediately, and one that would
  // have turned a refusal into a silent overwrite of somebody else's file.
  assertNotSymlink(pidPath(cwd, taskId))
  try { rmSync(pidPath(cwd, taskId), { force: true }) } catch { /* nothing to remove */ }
  if (!claimTaskId(cwd, taskId)) {
    throw Object.assign(
      new Error(`task id "${taskId}" was claimed by another dispatch a moment ago — `
        + 'ask it with `status`, or use a different task id'),
      { code: 'already_running' },
    )
  }
  assertNotSymlink(logPath(cwd, taskId))
  assertNotSymlink(pidPath(cwd, taskId))
  assertNotSymlink(routingPath(cwd, taskId))
  const previous = outboxPath(cwd, taskId)
  // `lstatSync`, not `existsSync`. `existsSync` FOLLOWS the link and answers
  // false for a DANGLING symlink, so the one kind of pre-positioned link that
  // is guaranteed to redirect our write — one aimed at a file that does not
  // exist yet, waiting for us to create it — walked straight past this check.
  // A panel lane found it. I had guarded the harmless case and skipped the
  // dangerous one.
  let previousStat = null
  try {
    previousStat = lstatSync(previous)
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
  }
  if (previousStat !== null) {
    assertNotSymlink(previous)
    renameSync(previous, `${previous}.superseded-${spawnedAtIso.replaceAll(':', '-')}`)
  }
  // 0600 for the same reason: the log is the most prose-bearing artifact here.
  const logFd = openNoFollow(logPath(cwd, taskId),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600)
  const argv = [COMPANION, worker, cwd, taskId, briefFile]
  if (stallSec !== undefined) argv.push(String(stallSec))
  // The whole environment, not an allowlist. Every ACP_* variable an operator
  // exports — model, expectation, resume, adapter — reaches the lane with
  // nothing to remember and nothing to forget.
  const child = spawnFn(process.execPath, argv, { cwd, detached: true, stdio: ['ignore', logFd, logFd], env })
  child.unref()
  // The child holds its own duplicate; this parent has no use for the
  // descriptor and leaked it for the life of the process.
  try { closeSync(logFd) } catch { /* the spawn may already have consumed it */ }
  if (Number.isInteger(child.pid)) {
    writeNoFollow(pidPath(cwd, taskId), `${child.pid}\n`)
  }
  // `ACP_RESUME` is deliberately NOT captured: a resume of a resume must carry
  // the session id the operator is recovering, not the one the last attempt was
  // itself resuming.
  const routingEnv = {}
  for (const key of ROUTING_ENV_KEYS) {
    if (env?.[key] !== undefined && env[key] !== '') routingEnv[key] = String(env[key])
  }
  try {
    writeNoFollow(routingPath(cwd, taskId),
      `${JSON.stringify({ worker, briefFile, stallSec: stallSec ?? null, spawnedAt: spawnedAtIso, env: routingEnv }, null, 2)}\n`)
  } catch (cause) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
    try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
    throw Object.assign(
      new Error(`the lane started as pid ${child.pid} and its routing file could not be written `
        + `(${cause.code ?? cause.message}) — it has been killed rather than left unfindable`),
      { code: 'publication_failed', cause },
    )
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
// No tolerance. The first version allowed a second of slack for clock
// granularity, and the PR reviewer pointed out that both timestamps come from
// the SAME host clock: the slack buys nothing and, on a retry inside one
// second, accepts the predecessor's snapshot — recreating the exact
// stale-identity failure this check exists to prevent.
export function belongsToThisRun(record, spawnedAtMs, nowMs = Date.now()) {
  const started = Date.parse(record?.started_at ?? '')
  if (!Number.isFinite(started)) return false
  // A lower bound alone accepted anything stamped in the FUTURE, so a record
  // left by a predecessor with a skewed clock — or written on purpose — read as
  // ours forever. A panel lane pointed out there was no upper bound and no
  // nonce. The upper bound is cheap and closes the forgery; a real nonce is
  // still owed and is written down as such rather than implied.
  // ponytail: bounds, not a nonce. A nonce needs the companion to echo it back,
  // which is a protocol change; the bound stops the accidental and the
  // clock-skew cases today.
  const FUTURE_TOLERANCE_MS = 60_000
  return started >= spawnedAtMs && started <= nowMs + FUTURE_TOLERANCE_MS
}

async function watchBoot(child, cwd, taskId, bootMs, spawnedAtMs) {
  const path = livenessPath(cwd, taskId)
  const deadline = Date.now() + bootMs
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  // A spawn that fails asynchronously — ENOENT on the interpreter, EACCES —
  // emits 'error', and an EventEmitter with no 'error' listener THROWS. This
  // process would have died with a stack trace naming a socket instead of
  // reporting a lane that never started. The same shape the ACP gate hit in
  // August when an EPIPE with no listener killed a whole review run.
  child.on('error', (cause) => { exited = { code: null, signal: null, error: cause } })
  for (;;) {
    const found = readJson(path, cwd)
    const record = belongsToThisRun(found, spawnedAtMs) ? found : null
    // A lane that reached a TERMINAL state during boot did not boot — it failed.
    // The first version folded this into `live` and printed an identity beside
    // exit 0 for a consultation that never started: an identity refusal, an
    // unsupported model, a config option the adapter would not take. Reported as
    // its own outcome now, because "dispatched successfully" and "refused before
    // the prompt" are not the same answer.
    // `completed` is a lane that FINISHED, not one that never started. The
    // previous version asked `hasTerminated`, which includes it — so a fast
    // consultation that answered before the boot poll came round was told
    // "this consultation never started" and exited 2. Found by the gemini panel
    // lane; it is the happy path for a quick lane, which is exactly the path a
    // guard against failure should never have owned.
    if (record && ['failed', 'cancelled'].includes(record.liveness_state)) {
      return { outcome: 'terminal', record }
    }
    // `completed` is a lane that FINISHED, not one that never started — but it
    // is NOT a bypass of the identity check. This line was added to stop a fast
    // consultation being called a failure, and it was placed ABOVE the identity
    // gate, so any record saying `completed` reported success without ever
    // being asked who answered. A panel lane reproduced it. The fix for one
    // guard owning the happy path must not hand the happy path to no guard at
    // all: `completed` now falls through to the same identity check as
    // everything else.
    // `identity_status`, not the truthiness of a string. A release panel caught
    // that a non-empty `effective_identity` was standing in for an ACCEPTED
    // identity — which is the substitution this whole plugin exists to refuse,
    // committed inside the check written to enforce it.
    if (record && record.effective_identity
      && ['matched', 'unverified'].includes(record.identity_status)) {
      return { outcome: 'live', record }
    }
    // A `completed` record that never carried an accepted identity is a lane
    // that finished without anyone establishing who ran it. That is a refusal,
    // not a success — the whole point of the identity gate.
    if (record && record.liveness_state === 'completed') {
      return { outcome: 'terminal', record }
    }
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

// Reading modes tolerate a run directory that has gone: `status` on a lane
// whose tree was cleaned up should report what it can, not crash.
function canonicalRoot(path) {
  try { return realpathSync(path) } catch { return path }
}

export async function main(argv, { out = console.log, err = console.error, spawnFn = spawn, env = process.env } = {}) {
  // Both public read modes get the id rule too. They were passing the raw value
  // into `statusReport`, which builds six paths out of it — so the command that
  // REFUSES `../` on dispatch accepted it on `status`, and read whatever it
  // pointed at.
  const refuseId = (taskId) => {
    err(`invalid task id "${taskId}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
    return 2
  }

  if (argv[0] === 'status') {
    const [, cwdArg, taskId] = argv
    if (!cwdArg || !taskId) { err(USAGE); return 2 }
    if (!safeTaskId(taskId)) return refuseId(taskId)
    const report = statusReport(canonicalRoot(resolve(cwdArg)), taskId)
    out(formatStatus(report))
    return statusExitCode(report)
  }

  if (argv[0] === 'wait') {
    const [, cwdArg, taskId, maxSec] = argv
    if (!cwdArg || !taskId) { err(USAGE); return 2 }
    if (!safeTaskId(taskId)) return refuseId(taskId)
    const budget = Number(maxSec ?? 3600)
    if (!Number.isFinite(budget) || budget <= 0) { err(USAGE); return 2 }
    // Converted and never validated until a release panel said so: NaN, zero or
    // a negative value turned the wait loop into zero-delay polling that could
    // spin a core for the whole budget. Same class as the boot budget, which
    // had already been fixed — and missed here because the fix was applied to
    // the value that had bitten rather than to the kind of value.
    const pollSec = Number(env.ACP_DISPATCH_POLL_SEC ?? 15)
    if (!Number.isFinite(pollSec) || pollSec <= 0) {
      err(`ACP_DISPATCH_POLL_SEC must be a positive number of seconds, got "${env.ACP_DISPATCH_POLL_SEC}"`)
      return 2
    }
    return waitForSettlement(canonicalRoot(resolve(cwdArg)), taskId, budget * 1000,
      { out, pollMs: pollSec * 1000 })
  }

  const [worker, cwdArg, taskId, briefFile, stallSec] = argv
  if (!worker || !cwdArg || !taskId || !briefFile) { err(USAGE); return 2 }
  // Before ANY path is built from it. `spawnDetached` asserts the same thing —
  // this is the operator-facing message, that one is the guarantee.
  if (!safeTaskId(taskId)) return refuseId(taskId)
  // The run root is CANONICALISED before anything is built from it. A review
  // round found it sitting outside the component walk entirely: a `cwd` that is
  // itself a symlink received both artifact trees without ever being examined.
  //
  // Resolving rather than refusing is the right answer — a caller who passes an
  // alias usually means "use this path for its target", and this tool has to
  // work against directories other people made. What was missing is that the
  // target became the semantic root SILENTLY. It is resolved once, everything
  // downstream uses the resolved path, and when the two differ the operator is
  // told which directory this command actually operated on.
  let cwd
  try {
    cwd = realpathSync(resolve(cwdArg))
  } catch (cause) {
    err(`cannot resolve the run directory ${cwdArg}: ${cause.code ?? cause.message}`)
    return 2
  }
  if (cwd !== resolve(cwdArg)) out(`run directory resolves to: ${cwd}`)
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
  // A rejection here used to become an unhandled promise rejection, which Node
  // turns into a nonzero exit with a stack trace and no sentence an operator
  // can act on. Every refusal this file raises — an unsafe artifact, an
  // occupied task id — arrives as a throw, so this is the path they all take.
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((cause) => {
      console.error(cause?.message ?? String(cause))
      process.exitCode = 2
    })
}
