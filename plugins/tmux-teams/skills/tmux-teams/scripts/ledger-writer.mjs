// ledger-writer.mjs — the only sanctioned way a line enters a custody ledger.
//
// The ledger is append-only evidence (contract ข้อ 2, ข้อ 4), which means it is only
// worth reading if everything in it got there under the same rules. Today any
// shell can `>>` a line into it, and twice an assistant did exactly that: two
// `abandoned` events that are structurally indistinguishable from ones the
// runner wrote. Nothing in the file says a human typed them, so the board, the
// pull controller and the outer controller all treated them as machine
// evidence.
//
// This module closes that. Every write:
//   - names its `actor`, so a hand append stays visibly a hand append forever;
//   - is checked against the per-event field table in contract ข้อ 4;
//   - is checked against the ledger it is joining, so an event that would make
//     the token's history impossible is refused rather than recorded;
//   - is refused outright if the ledger was ALREADY invalid, because appending
//     to a broken history buries the break instead of surfacing it.
//
// It never rewrites. Corrections are appended (ข้อ 4, ข้อ 13).
import {
  appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  ACTOR_RE, EVENT_SPEC, HARD_TERMINAL_EVENTS, isClosingTolerated, isLegacyTolerated, LEDGER_EVENTS, MAX_LEDGER_BYTES,
  TERMINAL_EVENTS, validateLedger,
} from './ledger-validate.mjs'

// ข้อ 1 became enforceable on a system that was already running, and the first
// real ledger it met was `story-1-10` in a live repo: 46 lines, one violation
// at line 36, a worker mid-leg at line 46. Under the first version of this rule
// that token could be CLOSED and nothing else — so a rule written to keep work
// moving became the thing that stopped it, on the one token that needed to move.
//
// The rule is enforced where it belongs instead: on the LINE BEING WRITTEN.
// `fresh` below refuses any append that introduces a NEW problem, so a new
// backwards pull is refused exactly as it was. What no longer happens is a
// ledger being punished for history it already carries — that history cannot be
// un-written, and refusing every future line does not undo it.
//
// Every OTHER problem still means "repair this before writing anything",
// which is what keeps this from being a general amnesty.
//
// B5 (2026-08-04): two later amendments — `question_id` required on
// `questioned`, `actor_kind: 'human'` required on `opened` — hit the exact
// same shape of trouble on ledgers that validated clean before them, and for
// the same reason: the rule changed under a system already running. The list
// this used to be lived here as a flat `Set` of codes; it now lives in
// `ledger-validate.mjs` as `LEGACY_TOLERATED_PROBLEMS`, scoped to
// (code, event[, field]) rather than code alone, because `missing_field`
// alone would tolerate a brand-new event missing any required field, not
// just an old `questioned` missing `question_id`. See that file for the full
// account, including why a ledger-format marker was considered and rejected.
// `pull-controller.mjs` reads the identical list — see the comment there for
// why importing it, rather than keeping this file's own copy, is the fix.

export { ACTOR_RE, LEDGER_EVENTS }

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
// A ledger holds the token's whole history and the reasons agents wrote in
// prose. It is readable by whoever runs the loop and nobody else.
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const fail = (code, detail, problems = []) => ({ ok: false, code, detail, problems })

export function ledgerPath(repo, workItem) {
  return join(resolve(repo), '.tmux-teams', 'work-items', `${workItem}.jsonl`)
}

// Creates a missing directory at 0700 and chmods it, because `mkdirSync`'s mode
// is masked by the process umask and a ledger that lands world-readable has
// already leaked. An existing directory is left alone — this writer owns the
// files it creates, not the tree it was pointed at.
function ensureDir(dir) {
  if (existsSync(dir)) return
  const parent = dirname(dir)
  const madeParent = !existsSync(parent)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  if (madeParent) chmodSync(parent, DIR_MODE)
  chmodSync(dir, DIR_MODE)
}

// codex BLOCKER 8 (retro-release-review round 5, 2026-08-04): `appendEvent`
// below is read-validate-append with no atomicity ACROSS those three steps.
// `appendFileSync` makes ONE line's bytes atomic — two writers' lines can
// never interleave into a corrupt byte stream — but it says nothing about
// whether the line being written was still the right thing to write given
// what another writer just committed. Run N callers concurrently against a
// clean ledger and several can all read the same empty `existing`, each
// validate a `line` that is individually legal against that snapshot, and
// each append: N legal-looking single writes, one semantically duplicate
// ledger.
//
// The guarantee chosen here: total mutual exclusion per ledger file, via an
// `O_CREAT|O_EXCL` lock file (`<workItem>.jsonl.lock`) held for the whole
// read-validate-append critical section. Rejected alternatives and why:
//   - O_APPEND + post-write re-validation cannot un-write a byte that is
//     already on disk without becoming a rewriter, which this module's own
//     header says it refuses to be (`It never rewrites`).
//   - Compare-and-swap on file size needs an atomic "write only if size
//     still matches" primitive, which POSIX does not give a single process
//     without exactly the kind of lock this is.
// This assumes one local filesystem, which every caller here already does
// — `ledgerPath` is a plain local path; no networked mount is supported.
//
// Cost: a writer that is hard-killed (SIGKILL, OOM) while holding the lock
// blocks every OTHER writer to the SAME token for up to `LOCK_STALE_MS`,
// after which the lock is stolen based on the lock file's mtime, not on
// whether the original holder's pid is still alive — pid liveness is not
// reliable to check across platforms, and a reused pid would be a worse
// signal than the clock. A writer whose own read-validate-append cycle
// legitimately takes longer than `LOCK_STALE_MS` (30s — file I/O and JSON
// validation, not real work) can have its lock stolen and then race the
// stealer, reintroducing the exact defect this exists to close — but only
// in that narrow, bounded, and now-documented case, against the
// alternative of a token wedged forever behind a lock nobody will ever
// release.
const LOCK_SUFFIX = '.lock'
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 10
const LOCK_MAX_WAIT_MS = 5_000

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// A steal used to be a bare `unlinkSync`, and the comment claimed "only one
// racer can ever win that `wx`, so a steal can produce at most one new holder".
// r6-codex showed that is false, and the reason is that `wx` guards only the
// CREATE: B and C both stat the same stale marker, B unlinks it and creates its
// own, and C — still acting on what it saw a moment ago — unlinks B's FRESH
// lock and creates its own beside a holder that is still inside.
//
// `wx` on a separate steal marker puts at most one process in the steal section
// at a time, and inside it the decision is re-made against the bytes on disk:
// a marker whose token is no longer the one observed as stale is somebody's
// live lock and is never touched. C now either finds nothing (B took it and has
// not yet re-created) and races B fairly on `wx`, or reads B's token and leaves
// it alone.
//
// What this does NOT fix, and cannot with file primitives alone: a live-but-slow
// holder past `LOCK_STALE_MS` is still stolen from, and for as long as it stays
// inside its section two writers overlap. That is the trade the stale bound
// exists to make — a wedged token forever is worse — and it is stated here
// rather than claimed away.
const STEAL_SUFFIX = '.steal'
// A steal section is a read, a stat and an unlink. Anything older than this is
// a process that died holding it.
const STEAL_STALE_MS = 1_000

// Exported as a test seam: the guard below only matters on an interleaving
// `acquireLock` re-reads its way out of, so it has to be called directly.
export function stealStaleLock(lockPath, observedToken) {
  const stealPath = `${lockPath}${STEAL_SUFFIX}`
  // Our claim on the steal section, so we can tell OUR section from the one
  // that replaced it. Without this, a stealer suspended past `STEAL_STALE_MS`
  // — SIGTSTP, an IO stall, a starved scheduler, all ordinary under tmux — has
  // its marker cleared, a replacement takes the section and the lock, and the
  // sleeper then resumes into a destructive step it decided on before it slept.
  // r6/r7-qwen demonstrated exactly that; the mtime bound alone cannot see the
  // difference between a corpse and a process that is merely stopped.
  const claim = `${process.pid}:${process.hrtime.bigint()}`
  const stillOurs = () => {
    try { return readFileSync(stealPath, 'utf8') === claim } catch { return false }
  }
  let fd
  try {
    fd = openSync(stealPath, 'wx', 0o600)
    writeSync(fd, claim)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    try {
      if (Date.now() - statSync(stealPath).mtimeMs > STEAL_STALE_MS) unlinkSync(stealPath)
    } catch { /* another racer cleared it first */ }
    return false
  }
  try {
    let current
    try { current = readFileSync(lockPath, 'utf8') } catch { return true } // already gone
    if (current !== observedToken) return false // a live lock somebody else just took
    if (Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) return false // no longer stale
    // Last thing before the only destructive step: are we still the stealer?
    // Everything above was decided from bytes that may now be arbitrarily old.
    if (!stillOurs()) return false
    try { unlinkSync(lockPath) } catch { /* raced to it */ }
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
    // Only our own marker. Clearing a replacement's would hand a third stealer
    // the section while the second is inside it — the same shape one level up.
    if (stillOurs()) { try { unlinkSync(stealPath) } catch { /* nothing to clean up */ } }
  }
}

// Exported as a named test seam. The ownership invariant below is a property
// of two file operations, not of scheduling, and it cannot be observed through
// `appendEvent` without parking a real process inside its critical section for
// `LOCK_STALE_MS` — a 30-second test that would prove less than six lines do.
export function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      // Unique per ACQUISITION, not per process: a pid alone cannot tell this
      // acquisition from the one a steal replaced, which is exactly what
      // `releaseLock` has to distinguish.
      const token = `${process.pid}:${process.hrtime.bigint()}`
      writeSync(fd, token)
      closeSync(fd)
      return token
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // The deadline is checked FIRST because every path below loops. When the
      // only way back to the top was a failed `wx` on a lock somebody clearly
      // held, checking it last was equivalent; it is not now. A marker that
      // keeps vanishing and reappearing, or a steal another racer keeps
      // winning, would otherwise spin here against no bound at all.
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(`timed out waiting for ${lockPath} (held longer than ${LOCK_MAX_WAIT_MS}ms)`),
          { code: 'LOCK_TIMEOUT' },
        )
      }
      let observed
      try { observed = readFileSync(lockPath, 'utf8') } catch { continue } // vanished — retry at once
      let age
      try { age = Date.now() - statSync(lockPath).mtimeMs } catch { continue }
      // A steal that succeeded leaves nothing to wait for; one that lost to
      // another stealer waits like any other loser rather than spinning.
      if (age > LOCK_STALE_MS && stealStaleLock(lockPath, observed)) continue
      sleepSync(LOCK_RETRY_MS)
    }
  }
}

// A release must unlink OUR lock and no other. An unconditional unlink turns
// one stolen lock into two live writers: A stalls past `LOCK_STALE_MS`, B
// steals and enters, A finally finishes and deletes B's lock file, and C walks
// straight into the critical section B is still inside. The steal is a bounded,
// documented race between A and B; that amplification is not, and it outlives
// the steal by however long B still needs.
export function releaseLock(lockPath, token) {
  try {
    if (readFileSync(lockPath, 'utf8') !== token) return // stolen — not ours to remove
  } catch { return } // already gone, or unreadable: unlinking blind is the risk above
  try { unlinkSync(lockPath) } catch { /* already gone — nothing to clean up */ }
}

function readLines(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path).subarray(0, MAX_LEDGER_BYTES).toString('utf8')
  if (text === '') return []
  return text.replace(/\n+$/, '').split('\n')
}

/**
 * Append one event to one token's ledger.
 *
 * @returns {{ok: true, path: string, line: number, record: object}}
 *        | {ok: false, code: string, detail: string, problems: Array}
 *
 * The failure `code` separates the two operator actions that matter:
 * `ledger_already_invalid` means go repair the history someone else broke,
 * everything else means fix the event you just tried to write.
 */
export function appendEvent(repo, event, options = {}) {
  const { actor } = options

  // Actor first: an event with no accountable writer must never reach disk, no
  // matter how well-formed the rest of it is.
  if (actor === undefined || actor === null || String(actor).trim() === '') {
    return fail('missing_actor', 'appendEvent requires an actor, e.g. agent:build_dispatcher or human:ada')
  }
  if (!ACTOR_RE.test(String(actor))) {
    return fail('bad_actor', `actor must be agent:<id> or human:<id>, got ${JSON.stringify(actor)}`)
  }

  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return fail('bad_event', 'event must be a plain object')
  }
  const name = typeof event.event === 'string' ? event.event : ''
  if (!name) return fail('bad_event', 'event.event is required')
  if (!Object.hasOwn(EVENT_SPEC, name)) {
    // Refusing the name is the whole point: an event nobody taught the readers
    // about is invisible to occupancy and would silently free a WIP slot.
    return fail('unknown_event', `${name} is not an event in contract ข้อ 4 (known: ${LEDGER_EVENTS.join(', ')})`)
  }

  const workItem = String(event.work_item ?? '')
  // This value becomes a filename. Validating it here is what keeps a token id
  // from escaping the work-items directory.
  if (!ID_RE.test(workItem)) {
    return fail('bad_work_item', `work_item must match ${ID_RE.source}, got ${JSON.stringify(event.work_item)}`)
  }

  const { at: givenAt, actor: _ignored, ...rest } = event
  const at = givenAt === undefined || givenAt === null || String(givenAt).trim() === ''
    ? new Date().toISOString()
    : String(givenAt)
  // `at` leads and `actor` trails so a line reads chronology-first and
  // accountability-last no matter which caller built the middle.
  const record = { at, ...rest, actor: String(actor) }

  const path = ledgerPath(repo, workItem)
  // The lock file lives beside the ledger it guards, so it must exist first —
  // `acquireLock` below opens it with `wx`, which needs its parent directory.
  ensureDir(dirname(path))
  const lockPath = `${path}${LOCK_SUFFIX}`
  let lockToken = null
  try {
    lockToken = acquireLock(lockPath)
  } catch (error) {
    if (error.code === 'LOCK_TIMEOUT') return fail('locked', error.message)
    throw error
  }
  try {
    return appendLocked()
  } finally {
    if (lockToken !== null) releaseLock(lockPath, lockToken)
  }

  // Everything that reads or writes the ledger's bytes must run AFTER the
  // lock above is held and BEFORE it is released — that is the whole of the
  // guarantee BLOCKER 8 asks for, so it is one function so nothing between
  // `acquireLock` and `releaseLock` can accidentally read/write outside it.
  function appendLocked() {
    let existing
    try {
      existing = readLines(path)
    } catch (error) {
      return fail('unreadable', `cannot read ${path}: ${error.message}`)
    }

    const before = validateLedger(existing)
    // Master, 2026-08-03: ข้อ 1 became enforceable on a system that had already been
    // running, so a ledger written before it can contain a backwards pull. If
    // every append were refused, that token could never be CLOSED either — not
    // even `abandoned` — and a rule meant to keep work moving would strand the
    // work it caught. A terminal event may land on such a file. Nothing else may:
    // another `pulled` is refused exactly as it is on a clean ledger.
    //
    // codex BLOCKER 3 (retro-release-review round 4, 2026-08-04): that "nothing
    // else may" was previously enforced only by accident — by the appended
    // line usually introducing its own fresh problem — not by checking the
    // event's own kind. `continuable` now has two tiers instead of one, because
    // duplicate ids need a NARROWER allowance than the four original legacy
    // shapes: `route_went_backwards`/`sent_back_after_admission`/an old
    // `questioned`/an old agent-authored `opened` do not change what a
    // dispatch_id or task_id MEANS, so a ledger carrying only those may still
    // be continued normally (matches `isLegacyTolerated`, used by every
    // reader). A duplicate id — or the `dispatch_id_agent_mismatch`/
    // `dispatch_id_task_mismatch` it produces on later lines — does change what
    // the id means, so a ledger that needs `isClosingTolerated` to be
    // considered continuable at all may only receive an event with NO legal
    // successor: enough to close it, never enough to be trusted for another leg.
    //
    // codex BLOCKER 9 (round 5): that used to read TERMINAL_EVENTS, which also
    // holds `completed` — and ข้อ 5 calls `completed` only HALF closed, its sole
    // continuation an `audit_requested`/`audited` pair that is not terminal and
    // so is refused here in turn. Accepting it did not close the ledger, it
    // stranded the token: the runner's next write is refused with
    // `ledger_already_invalid` into the STUCK path, while the board reads the
    // `completed` line as a releasing event and files the card under Done with
    // no blocked reason — the wedge invisible on the one screen a human checks.
    // `HARD_TERMINAL_EVENTS` (`audited`, `abandoned`) is the set that really
    // has no successor.
    const continuableAsUsual = !before.ok
      && before.problems.every((problem) => isLegacyTolerated(problem))
    const continuableToClose = !before.ok
      && before.problems.every((problem) => isClosingTolerated(problem))
      && HARD_TERMINAL_EVENTS.has(name)
    const continuable = continuableAsUsual || continuableToClose
    if (!before.ok && !continuable) {
      return fail('ledger_already_invalid',
        `${path} has ${before.problems.length} problem(s) and must be repaired before anything is appended`,
        before.problems)
    }

    const line = JSON.stringify(record)
    const after = validateLedger([...existing, line])
    // Only what THIS line introduced. On a clean ledger `inherited` is empty and
    // this is the same comparison it always was; on a tolerated legacy one it is
    // what stops the old defect from being re-reported as the new line's fault.
    const inherited = new Set(before.problems.map((problem) => `${problem.line}:${problem.code}`))
    const fresh = after.problems.filter((problem) => !inherited.has(`${problem.line}:${problem.code}`))
    if (fresh.length) {
      // The prior ledger validated clean, so anything reported now is about the
      // candidate line and nothing else.
      const mine = fresh.filter((problem) => problem.line === existing.length + 1)
      const problems = mine.length ? mine : fresh
      const code = problems.some((problem) => problem.code === 'time_went_backwards')
        ? 'timestamp_not_monotonic'
        : 'invalid_event'
      const detail = code === 'timestamp_not_monotonic'
        ? `at ${at} is earlier than the last line already in ${path}`
        : `${name} does not satisfy contract ข้อ 4: ${problems.map((problem) => problem.detail).join('; ')}`
      return fail(code, detail, problems)
    }

    try {
      // `ensureDir` already ran, above the lock, before `acquireLock` needed
      // this same directory to exist for the lock file itself.
      const created = !existsSync(path)
      // One `appendFileSync` of one already-newline-terminated line: JSON.stringify
      // escapes every control character, so a record can never split into two
      // lines or interleave with a concurrent writer's line. The lock held for
      // the whole of `appendLocked` is what makes this THE next line rather
      // than a line racing an unseen sibling for that position.
      appendFileSync(path, `${line}\n`, { mode: FILE_MODE })
      if (created) chmodSync(path, FILE_MODE)
    } catch (error) {
      return fail('write_failed', `cannot append to ${path}: ${error.message}`)
    }

    return { ok: true, path, line: existing.length + 1, record }
  }
}

const USAGE = `usage:
  ledger-writer.mjs --repo <repo> --actor <agent:id|human:id> --event '<json>'
  ledger-writer.mjs --repo <repo> --actor <agent:id|human:id> --stdin   read the event JSON from stdin

Known events: ${LEDGER_EVENTS.join(', ')}
Every write is validated against contract ข้อ 4 and against the ledger it joins.
Exits non-zero and writes nothing when either check fails.`

function flag(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function main(argv) {
  const args = argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return args.length ? 0 : 2
  }
  const repo = flag(args, '--repo') ?? process.cwd()
  const actor = flag(args, '--actor')
  let payload = flag(args, '--event')
  if (payload === undefined && args.includes('--stdin')) {
    try {
      payload = readFileSync(0, 'utf8')
    } catch (error) {
      process.stderr.write(`cannot read stdin: ${error.message}\n`)
      return 2
    }
  }
  if (payload === undefined) {
    process.stderr.write(`--event or --stdin is required\n${USAGE}\n`)
    return 2
  }

  let event
  try {
    event = JSON.parse(payload)
  } catch (error) {
    process.stderr.write(`--event is not JSON: ${error.message}\n`)
    return 2
  }

  const result = appendEvent(repo, event, { actor })
  if (!result.ok) {
    process.stderr.write(`REFUSED  ${result.code}: ${result.detail}\n`)
    for (const problem of result.problems) {
      process.stderr.write(`  line ${problem.line}  ${problem.code}  ${problem.detail}\n`)
    }
    return 1
  }
  process.stdout.write(`${result.path}:${result.line}  ${JSON.stringify(result.record)}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
