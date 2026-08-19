#!/usr/bin/env node
// The operator's entry point to an ACP lane. A lane run in the FOREGROUND dies
// to the calling shell's own cap — a 1200s stall budget inside a 600s shell is
// killed at ten minutes with its review unwritten, both numbers typed by the
// same caller and nothing comparing them. So the lane is spawned `detached`
// into its own process group and `unref()`d, the shape `loop-runner.mjs`
// already used and only the loop could reach.
//
// Nothing here enforces a DEADLINE on the child; a wrapper that did would be
// the bug this removes. That is not the same as never killing it: a lane whose
// pid or routing record cannot be published is SIGKILLed, because the
// alternative is a detached process nobody can find again.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
// The rule is copied here with its source named, and the tests assert the two
// stay identical — the drift answer that does not reopen the hole.
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

// Opening a path is not the same as opening the FILE you meant. A pre-existing
// symlink at a control leaf is followed by an ordinary write and truncates
// whatever it points at; at the log it redirects the child's entire stdout.
//
// `O_NOFOLLOW` ALONE IS NOT ENOUGH, which is the mistake this guard exists to
// stop being made again: it refuses a symlinked LEAF while pathname resolution
// still walks the parents, so a symlinked `.tmux-teams` or `dispatch-pids`
// sends an `O_TRUNC` write to a same-named file in any writable directory. The
// chain is checked as well as the leaf, and BEFORE the child spawns — a refusal
// after `unref()` leaves a detached lane alive with no trustworthy records.
//
// **The residual, stated exactly.** Node exposes no `openat`, so nothing here
// can hold a directory capability and open relative to it. Two windows follow,
// not one: between a component check and the next component's `mkdir`, and
// between the final check and the open. An attacker with write and search
// permission on a relevant parent — no elevated privilege needed — can swap a
// component in either window and get a directory created or a file opened
// outside the root.
//
// So the guarantee is: **absent concurrent replacement, creation never happens
// past a symlinked component, and a pre-positioned symlink is refused.** Under
// an attacker racing the walk, it does not hold. An anchored-fd design would,
// and needs a primitive Node does not give us.
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
  // NOT `mkdirSync(dir, { recursive: true })` followed by a containment check:
  // with `.tmux-teams` pre-positioned as a symlink, the missing `runner-logs` is
  // CREATED outside and only then refused. A fail-closed preflight that mutates
  // outside the root before failing is not fail-closed.
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
      // Measured at 0755 under an ordinary umask, which is not safe for this.
      // EEXIST is a RACE, not an error: another dispatch created the same
      // directory between the lstat above and this line. Tolerating it here is
      // what lets two concurrent dispatches reach the atomic claim instead of
      // crashing in the preflight. Only a race test shows a window this small.
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
// Admitting a limitation is not the same as having one that cannot be removed.
// This removes the half that can be, on ONE machine. Two machines sharing a
// directory over NFS stay outside what this promises.
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

// EVERY read of a control leaf goes through here, because `status` runs against
// directories this dispatcher never created and the write-side guards say
// nothing about reading. A link is not followed and is not an error either: a
// hostile leaf reads as ABSENT, which is the honest answer for a diagnostic.
//
// The run root is PASSED, never derived from the leaf's shape — `dirname` counts
// differ between `.tmux-teams/<dir>/<x>` and `.mailbox-out/<x>`, and a guard
// that infers its own boundary is guessing.
// Listing a directory is a read too: a symlinked parent makes an enumeration
// report somebody else's directory as this run's.
// NO SYMLINK ON THE WAY, not "resolves somewhere under the run root":
// containment is not identity, and a link pointing back INSIDE the same run
// satisfies containment while redirecting the read. Each component is walked.
//
// Two approaches that look right and are not. Comparing `realpath(dir)` against
// `realpath(join(root, relative))` always matches — both resolve the same link.
// And `relative` must be sliced from the UNRESOLVED root, because the caller
// built `dir` from that same string; slicing by the resolved length eats the
// wrong number of characters wherever `/var` resolves to `/private/var`.
//
// A directory not under the run root at all is REFUSED, not walked — otherwise
// a caller that forgets its run root reads as "no components to inspect".
function noSymlinkOnTheWay(dir, runRoot) {
  try {
    if (dir !== runRoot && !dir.startsWith(runRoot + sep)) return false
    const relative = dir === runRoot ? '' : dir.slice(runRoot.length + 1)
    let walked = realpathSync(runRoot)
    for (const part of relative ? relative.split(sep) : []) {
      walked = join(walked, part)
      if (lstatSync(walked).isSymbolicLink()) return false
    }
    return true
  } catch {
    return false
  }
}

// `null` means REFUSED and `[]` means "nothing there", and the difference
// matters to the two callers: a report that cannot enumerate should say
// "nothing here I can trust", while ADMISSION must not read a refusal as
// "no collision found" — that is the permissive answer to a safety question.
// The directory ITSELF is walked, not its parent: `.mailbox-out` being the link
// is the case a lane reproduced.
function readDirSync(path, runRoot) {
  if (!noSymlinkOnTheWay(path, runRoot)) return null
  try {
    return readdirSync(path)
  } catch {
    // EVERY enumeration failure is "I cannot answer", ENOENT included. Catching
    // them as `[]` is what made the guard below unreachable in practice: a real
    // directory with write+search and no read permission passed the preflight,
    // returned EACCES, and was read as holding no case collision. A lane
    // admitted a colliding id that way, exit 0, on a case-insensitive volume.
    // The symlink walk was never the only way to fail to enumerate — it was the
    // only one anybody had pictured.
    //
    // ENOENT was briefly special-cased back to `[]`, and a lane pointed out the
    // distinction had no consumer: `strayOutboxes` coalesces null itself, and
    // admission pre-creates the three directories it scans, so the only ENOENT
    // left is a removal racing the walk — where refusing IS the right answer,
    // because collision evidence that cannot be read has not been checked. One
    // return, no classifier, and the mutant that survived the classifier is
    // gone with it.
    return null
  }
}

export function readLeafSync(path, runRoot) {
  // The PARENTS as well as the leaf. `lstat` on the final component says
  // nothing about `.tmux-teams` or `sessions` being symlinks, so a hostile
  // parent still redirected the read — the boundary was called universal and
  // covered one component of the path. A panel lane reproduced it after the
  // leaf check went in, which is the second time a fix here covered the case I
  // pictured and not the case that was named.
  if (!noSymlinkOnTheWay(dirname(path), runRoot)) return null
  let stat = null
  try {
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
    // A refusal reports nothing rather than throwing: this is a report, and
    // "nothing here I can trust" is the honest answer to give a reader.
    return (readDirSync(join(cwd, '.mailbox-out'), cwd) ?? []).filter((name) => name !== taskId).sort()
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
  // Recorded for the same reason as the rest: a resume that drops it does not
  // fail, it DOWNGRADES — the companion defaults `receiptRequired` to false, so
  // a lane that was dispatched under a receipt guarantee comes back without one
  // and says nothing. Not a secret; it selects a mode.
  'ACP_SESSION_RECEIPT_REQUIRED',
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
  // `Number(...)`, because `stallSec` comes from argv and argv is strings:
  // `Number.isFinite('2400')` is false, so the fallback fires ALWAYS and
  // silently resets every custom stall to the default.
  const recordedStall = Number(routing?.stallSec)
  // 600, read from `acp-companion.mjs` (`positiveNumber(leaseArg, 600)`) rather
  // than recalled — any other number tells the operator to use a lease the
  // original run never had.
  const stall = Number.isFinite(recordedStall) && recordedStall > 0 ? recordedStall : COMPANION_DEFAULT_STALL_SEC
  const parts = [`ACP_RESUME=${shQuote(sessionId)}`]
  for (const key of ROUTING_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') parts.push(`${key}=${shQuote(env[key])}`)
  }
  // A receipt-required dispatch resumes as a receipt-required LOAD, and a load
  // needs lineage this function cannot know. `ACP_SESSION_OPERATION` is
  // synthesised rather than copied, because the recorded value is `new` and
  // pasting `new` would start a fresh session under a resume command.
  //
  // The two lineage values are QUOTED PLACEHOLDERS, like the brief path above:
  // an operator who pastes this unedited must get a refusal, not a quieter
  // guarantee.
  // `=== '1'`, NOT truthiness: the companion treats only `1` as required, so `0`
  // is a valid explicit opt-out — and the string `'0'` is truthy, which hands an
  // opt-out dispatch lineage placeholders that make its own resume exit 2.
  if (env.ACP_SESSION_RECEIPT_REQUIRED === '1') {
    parts.push(`ACP_SESSION_OPERATION=${shQuote('load')}`)
    parts.push(`ACP_PRIOR_DISPATCH_ID=${shQuote('PUT-THE-PRIOR-DISPATCH-ID-HERE')}`)
    parts.push(`ACP_PRIOR_RECEIPT_DIGEST=${shQuote('PUT-THE-PRIOR-RECEIPT-DIGEST-HERE')}`)
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

// The companion's own vocabulary, not a guess at it: `VALID_TERMINAL_STATES` in
// `acp-companion.mjs` is exactly these three. Asking `liveness_state !==
// 'running'` names a state the companion never writes, so a lane at `active`
// reads as finished — and a hand-written liveness fixture will not catch it.
export const TERMINAL_LIVENESS_STATES = Object.freeze(['completed', 'cancelled', 'failed'])

// TERMINAL STATES ONLY — never "any termination_reason other than none". Under
// `ACP_STALL_POLICY=report` a stalled companion sets a reason and stays ALIVE to
// recover, and an ordinary cancellation sets one while still in `cancelling`;
// both would be called finished and get resume advice printed at a working lane.
// A lane that stopped is detected by its process being gone, or by its lease
// running out. Being stalled is not being over.
function hasTerminated(liveness) {
  if (liveness === null) return false
  return TERMINAL_LIVENESS_STATES.includes(liveness.liveness_state)
}

// A lane killed hard writes NO terminal snapshot, so its last record says
// `tool_running` forever — one that died to a full disk was reported running
// for nearly four hours, and a watcher built on that never returns.
//
// `next_lease_expiry_at` is the companion's OWN statement of when it should
// next have been heard from, so this needs no threshold of mine and no pid: if
// that moment is in the past, the lane is not reporting. It is a lease, not a
// death certificate — say "not reporting", never "dead".
export function leaseExpired(liveness, now = Date.now()) {
  // NO LEASE READS AS EXPIRED. `Number.isFinite(expiry) && …` treated a record
  // with no `next_lease_expiry_at` — or an unparseable one — as a lane that is
  // still making progress, which is the absence of evidence read as evidence.
  // CLAUDE.md's own rule for a branch that cannot answer: say UNKNOWN, never
  // "no". Here the safe UNKNOWN is "not proven alive".
  //
  // This is what lets admission accept routing-less liveness (a loop-runner
  // lane is real and has a live lease) without a predecessor's leaseless
  // leftover blocking every re-dispatch.
  const expiry = Date.parse(liveness?.next_lease_expiry_at ?? '')
  if (Number.isFinite(expiry)) return expiry < now
  // No lease is AMBIGUOUS, not absent: a lane in `starting` has not published
  // one yet, and a leftover from days ago never will. The record's own
  // `observed_at` is the evidence that distinguishes them — recent means a lane
  // that is between its start and its first lease, old means nobody is coming
  // back to write one. The window is the companion's default stall, because
  // that is the longest a lane may legitimately go without saying anything.
  const observed = Date.parse(liveness?.observed_at ?? '')
  // NO TIMING AT ALL is UNKNOWN, and unknown is not "expired". A record with
  // neither a lease nor an observation says nothing about time, and answering
  // "stopped" to that would settle a lane on the absence of a field. What the
  // old-observation branch above catches is a record that DOES carry a time and
  // whose time is long past.
  if (!Number.isFinite(observed)) return false
  return observed + COMPANION_DEFAULT_STALL_SEC * 1000 < now
}

// A lane has STOPPED when its process is gone, or — when nobody recorded a pid
// to ask — when the lease it published itself has run out.
//
// `next_lease_expiry_at` is a MEANINGFUL-PROGRESS lease, not a heartbeat: a
// companion may reach it, record a suspected stall, extend it and carry on. An
// expired lease therefore never outvotes a pid `pidAlive` just confirmed.
//
// When a function is edited from two sides, re-read every comment that touches
// it: this one and the one inside said opposite things for three commits.
function hasStopped(liveness, { pid = null, now = Date.now() } = {}) {
  if (hasTerminated(liveness)) return false
  // Two requirements that sound contradictory belong to two CALL SITES. An
  // expired lease must not settle a lane `pidAlive` just confirmed — that is
  // THIS function. A reused pid number must not hide a dead lane forever — that
  // is admission, and is answered there.
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
    && !belongsToThisRun(rawLiveness, spawnedAtMs, routing?.spawnNonce) ? null : rawLiveness
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

// Recorded because the lease is the SLOW answer: `next_lease_expiry_at` is up
// to fifteen minutes out, so a lane that died minutes ago still reads as
// running. A pid answers immediately. Pid reuse can only produce a false ALIVE, which then falls back
// to the lease, so the wrong answer is the harmless direction.
export function pidPath(cwd, taskId) { return join(cwd, '.tmux-teams', 'dispatch-pids', `${taskId}`) }

export function recordedPid(cwd, taskId) {
  // Through `readLeafSync`, like every other control-leaf read: a direct
  // `readFileSync` puts a hole in the boundary at the one reader admission
  // depends on, and a planted FIFO blocks it outright.
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

export function spawnDetached(worker, cwd, taskId, briefFile, stallSec,
  { spawnFn = spawn, env = process.env, nonce = randomUUID() } = {}) {
  // FIRST. Every line below builds a path out of this value.
  assertSafeTaskId(taskId)
  const spawnedAtIso = new Date().toISOString()
  // Retire the PREDECESSOR's outbox before the new lane starts.
  //
  // `statusExitCode` requires a terminal record AND an outbox, which sounds
  // sufficient until both bytes belong to the previous run of the same task id
  // while today's pid is alive — a false SUCCESS at the moment an operator is
  // deciding whether the work is done. Renamed rather than deleted, so the
  // predecessor's answer stays on disk and `strayOutboxes` points at it.
  // The whole filesystem question, answered BEFORE anything is spawned. A
  // refusal after `unref()` leaves a detached lane alive with no trustworthy
  // records — worse than never starting.
  // `liveness` and `sessions` belong here too: the companion writes both and
  // `statusReport` reads both, so a symlinked parent on either sends a write out
  // of the tree or feeds the reader a stranger's file.
  for (const artifact of ['runner-logs', 'dispatch-pids', 'dispatch-routing', 'liveness', 'sessions']) {
    assertContainedDir(cwd, '.tmux-teams', artifact)
  }
  // `.mailbox-out` is the FOURTH write path and it was not checked. The
  // predecessor-outbox retirement renames through it, so a symlinked
  // `.mailbox-out` plus an outside regular file named for the task moved a
  // stranger's file before anything spawned — the same parent-resolution class
  // as the three above, on the one directory that was not in the list.
  assertContainedDir(cwd, '.mailbox-out')
  // ADMISSION, and it must sit BELOW the containment preflight: reading a pid
  // file before establishing that `dispatch-pids` is a real directory inside
  // the tree is a read-before-check.
  //
  // A LIVE PID ALONE is not evidence of a live lane — pid numbers are reused,
  // and refusing on that alone locks a task id forever behind an unrelated
  // process. Refuse only when the pid is alive AND the lane still reports
  // progress. These reads can be raced; the claim below cannot. What they buy
  // is a good REFUSAL MESSAGE, since the claim alone would say only "taken".
  // A MISSING pid leaf is not evidence that nothing is running — it can be
  // refused by the read policy, deleted, or never written. With no pid to ask,
  // the lease is the only evidence there is.
  // CASE. On a case-insensitive filesystem `Review` and `review` are two task
  // ids here and one set of files on disk, so every check above calls them
  // unrelated while they overwrite each other. No portable way to make the
  // paths distinct: an existing artifact spelled differently means it is taken.
  for (const dir of ['liveness', 'dispatch-pids', 'dispatch-routing']) {
    const at = join(cwd, '.tmux-teams', dir)
    // ADMISSION, not a report — so a refusal must not read as "no collision".
    // Enumerating nothing and being unable to enumerate are the same value to a
    // `for` loop and opposite answers to the question being asked.
    const leaves = readDirSync(at, cwd)
    if (leaves === null) {
      throw Object.assign(
        // A symlink is offered as ONE cause, not the only one — a permission
        // failure reaches here too.
        new Error(`task id "${taskId}" cannot be admitted: .tmux-teams/${dir} cannot be `
          + 'listed — it is reached through a symlink, or it is not readable — so what it '
          + 'holds cannot be checked for a case collision'),
        { code: 'unreadable_run_directory' },
      )
    }
    for (const leaf of leaves) {
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
    // Bound to the RECORDED dispatch, as `statusReport` binds it. A
    // predecessor's unsettled record is not this id's live lane, and refusing on
    // it makes every re-dispatch after an interrupted run impossible.
    // WITH NO ROUTING, the record is still evidence: `loop-runner.mjs` starts
    // companions without a dispatcher routing file, so requiring one discards a
    // live lane's liveness and admits a second writer. Admission must not be
    // stricter than `statusReport`, which accepts routing-less liveness.
    const liveness = readJson(livenessPath(cwd, taskId), cwd)
    const priorRouting = recordedRouting(cwd, taskId)
    const priorSpawn = Date.parse(priorRouting?.spawnedAt ?? '')
    const record = Number.isFinite(priorSpawn)
      ? (belongsToThisRun(liveness, priorSpawn, priorRouting?.spawnNonce) ? liveness : null)
      : liveness
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
  // the outbox above is retired and by the same means. `belongsToThisRun` now
  // requires a matching nonce as well as the timestamp bounds, which closes
  // deliberate forgery — but this dispatch's nonce does not exist yet at this
  // point in the function, so there is nothing on disk to compare against
  // before the child is even spawned. Removal stays the belt-and-braces answer
  // here: a leaf that is not on disk cannot be mistaken for this run's, and the
  // predecessor's bytes are kept under a suffix rather than deleted, exactly as
  // the outbox is.
  for (const leaf of [livenessPath(cwd, taskId), sessionPath(cwd, taskId)]) {
    retirePredecessorLeaf(leaf, spawnedAtIso)
  }
  // Claimed AFTER the reads, not before — a pid file left by a finished lane is
  // not a live claim, and claiming first fails every ordinary re-dispatch.
  //
  // THE CLAIM IS THE WHOLE OF IT: `O_CREAT|O_EXCL` succeeds or this dispatch
  // refuses. NO TAKE-OVER PATH, and do not add one — four designs were measured
  // and every one raced. Remove-then-create let 2 of 8 concurrent dispatches
  // win the same id; rename-onto-the-path let all of them win; retiring the
  // stale leaf by rename still failed 2 runs in 6; gating that on mtime reached
  // 1 in 6 and cannot go further, because a contender starting admission AFTER
  // the winner claims sees the winner's fresh leaf as older than its own and
  // retires a LIVE claim.
  //
  // No filesystem primitive both takes over a dead holder's file and refuses a
  // live one. A leftover leaf is an operator step, which the refusal names.
  assertNotSymlink(pidPath(cwd, taskId))
  if (!claimTaskId(cwd, taskId)) {
    // NO LEASE SENTENCE HERE, and do not add one back. The loop above RETIRES
    // that leaf unconditionally forty lines earlier, so any such read is
    // unreachable — and repairing it would be worse than leaving it out.
    // The leaf we just renamed away belonged to the PREVIOUS occupant of this
    // id; whoever holds the claim we just lost is a different lane, and may not
    // have written a liveness file yet. Quoting the predecessor's lease as
    // "its progress lease" is a confident wrong answer, which this file already
    // has a rule about: it sounds specific and sends the reader somewhere else.
    throw Object.assign(
      new Error(`task id "${taskId}" is claimed here: .tmux-teams/dispatch-pids/${taskId} exists.`
        + ' Ask it with `status`; if that lane is gone, remove that file and dispatch again'),
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
  // The harmless case is the one that looks like it needs guarding.
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
  //
  // `ACP_SPAWN_NONCE` is ADDED on top, never taken from the operator's `env`:
  // it is this dispatch's own proof of authorship, generated above, and an
  // operator-supplied value here would defeat the thing it exists to prove.
  const childEnv = { ...env, ACP_SPAWN_NONCE: nonce }
  const child = spawnFn(process.execPath, argv, { cwd, detached: true, stdio: ['ignore', logFd, logFd], env: childEnv })
  child.unref()
  // The child holds its own duplicate; this parent has no use for the
  // descriptor and leaked it for the life of the process.
  try { closeSync(logFd) } catch { /* the spawn may already have consumed it */ }
  // GUARDED, like the routing write below. This was not — the edit that added
  // the routing guard asserted two anchors, the first failed, and I re-applied
  // only the half that had errored. A lane reported the pid half still
  // unguarded a round later, which is the third time in this release that a
  // scripted edit failed silently and I read the line after it instead of the
  // failure.
  try {
    if (Number.isInteger(child.pid)) {
      writeNoFollow(pidPath(cwd, taskId), `${child.pid}\n`)
    }
  } catch (cause) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
    try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
    throw Object.assign(
      new Error(`the lane started as pid ${child.pid} and its pid file could not be written `
        + `(${cause.code ?? cause.message}) — it has been killed rather than left unfindable`),
      { code: 'publication_failed', cause },
    )
  }
  // `ACP_RESUME` is deliberately NOT captured: a resume of a resume must carry
  // the session id the operator is recovering, not the one the last attempt was
  // itself resuming.
  const routingEnv = {}
  for (const key of ROUTING_ENV_KEYS) {
    if (env?.[key] !== undefined && env[key] !== '') routingEnv[key] = String(env[key])
  }
  try {
    // `spawnNonce` sits beside `spawnedAt`, not inside `env`: it is this
    // dispatcher's own record of what it told the companion, not something a
    // resume command should ever echo — a resume is a fresh dispatch and gets
    // a fresh nonce, so `ROUTING_ENV_KEYS` deliberately excludes it.
    writeNoFollow(routingPath(cwd, taskId),
      `${JSON.stringify({ worker, briefFile, stallSec: stallSec ?? null, spawnedAt: spawnedAtIso,
        spawnNonce: nonce, env: routingEnv }, null, 2)}\n`)
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
// writes its first snapshot before spawning the adapter, so the file exists
// within milliseconds carrying `identity_status: 'missing'` — waiting for the
// FILE reports `unknown (missing)` for a lane acknowledged `matched` seconds
// later. The point of waiting is to keep the identity check synchronous.
// A liveness record belongs to THIS dispatch only if the child wrote it after
// the spawn. Re-dispatching into the same run directory leaves the previous
// run's snapshot in place, identity and all, and on a plugin whose subject is
// provenance, reporting a predecessor's identity as this one's is the worst
// small bug available.
//
// A record with no `started_at` is not-this-run: the companion always writes it.
// NO slack for clock granularity — both timestamps come from the same host
// clock, so slack buys nothing and, on a retry inside one second, accepts the
// predecessor's snapshot.
//
// BOUNDS AND A NONCE, both required. A bound is not identity: nothing in a
// timestamp is unique to THIS dispatch, so a record stamped inside the window
// by a predecessor — or forged on purpose — passed. `spawnDetached` mints a
// nonce per dispatch and hands it over `ACP_SPAWN_NONCE`; the companion echoes
// it back as `spawn_nonce`. The bounds STAY, because a resume into the same
// task id can produce a predecessor record carrying the same nonce.
export function belongsToThisRun(record, spawnedAtMs, expectedNonce, nowMs = Date.now()) {
  const started = Date.parse(record?.started_at ?? '')
  if (!Number.isFinite(started)) return false
  // A lower bound ALONE accepts anything stamped in the future, so a record left
  // by a skewed or hostile clock reads as ours forever.
  const FUTURE_TOLERANCE_MS = 60_000
  if (started < spawnedAtMs || started > nowMs + FUTURE_TOLERANCE_MS) return false
  // MISSING ON EITHER SIDE REFUSES. A routing file written before this field
  // existed has no `expectedNonce`, and an old or foreign liveness record has no
  // `spawn_nonce` — both read as "cannot prove", never as a pass.
  return Boolean(expectedNonce) && record?.spawn_nonce === expectedNonce
}

// **The residual, stated exactly.** This closes forgery for a lane THIS
// dispatcher started, because only it knows the nonce. It does NOT close it in
// general, and the reason is a requirement rather than an oversight:
// `loop-runner.mjs` starts companions with no dispatcher routing file, and both
// `statusReport` and admission deliberately accept routing-less liveness — so
// where there is no routing there is no nonce to compare, and the record is
// taken on its timestamps alone.
//
// An attacker who can plant a liveness file in a run directory can also delete
// the routing file beside it and land back in that path. So against someone who
// owns the directory the nonce buys nothing; what it closes is a PREDECESSOR's
// record, an accident, and a forgery by anything that cannot write the run root.
//
// `watchBoot` is the exception and the strongest case: it is called by the
// dispatch that just minted the nonce, so it always has one and never falls
// back.

async function watchBoot(child, cwd, taskId, bootMs, spawnedAtMs, spawnNonce) {
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
    const record = belongsToThisRun(found, spawnedAtMs, spawnNonce) ? found : null
    // A lane that reached a TERMINAL state during boot did not boot — it failed,
    // and gets its own outcome, because "dispatched successfully" and "refused
    // before the prompt" are not the same answer.
    //
    // `failed`/`cancelled` ONLY, never `hasTerminated`: that includes
    // `completed`, which is a lane that FINISHED fast, not one that never
    // started — the happy path a failure guard must not own.
    if (record && ['failed', 'cancelled'].includes(record.liveness_state)) {
      return { outcome: 'terminal', record }
    }
    // `completed` falls THROUGH to the identity check rather than short-circuiting
    // it. Excusing it above this gate reports success without ever asking who
    // answered: taking the happy path away from one guard must not hand it to
    // none.
    //
    // `identity_status`, not the truthiness of a string — a non-empty
    // `effective_identity` standing in for an ACCEPTED one is the exact
    // substitution this plugin exists to refuse.
    // EXITED FIRST. A lane reproduced this: the identity check ran before the
    // captured `exited` state, so a child that had already exited nonzero — and
    // whose exit this loop had observed — was reported as a healthy boot on the
    // strength of a record it wrote on its way out.
    //
    // A record proves what a lane SAID; `exited` proves what happened to it.
    // When they disagree the process wins.
    if (exited && exited.code !== 0) return { outcome: 'exited', record, ...exited }
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
  // Generated here, not inside `spawnDetached`, so this same value can also be
  // handed to `watchBoot` below — one nonce per dispatch, not one per function
  // that happens to need it.
  const spawnNonce = randomUUID()
  const child = spawnDetached(worker, cwd, taskId, resolve(briefFile), stallSec, { spawnFn, env, nonce: spawnNonce })
  const bootMs = bootSec * 1000
  const booted = await watchBoot(child, cwd, taskId, bootMs, spawnedAtMs, spawnNonce)

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
