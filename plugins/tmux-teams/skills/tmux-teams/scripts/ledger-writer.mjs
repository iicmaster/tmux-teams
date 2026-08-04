// ledger-writer.mjs — the only sanctioned way a line enters a custody ledger.
//
// The ledger is append-only evidence (contract §2, §4), which means it is only
// worth reading if everything in it got there under the same rules. Today any
// shell can `>>` a line into it, and twice an assistant did exactly that: two
// `abandoned` events that are structurally indistinguishable from ones the
// runner wrote. Nothing in the file says a human typed them, so the board, the
// pull controller and the outer controller all treated them as machine
// evidence.
//
// This module closes that. Every write:
//   - names its `actor`, so a hand append stays visibly a hand append forever;
//   - is checked against the per-event field table in contract §4;
//   - is checked against the ledger it is joining, so an event that would make
//     the token's history impossible is refused rather than recorded;
//   - is refused outright if the ledger was ALREADY invalid, because appending
//     to a broken history buries the break instead of surfacing it.
//
// It never rewrites. Corrections are appended (§4, §13).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  ACTOR_RE, EVENT_SPEC, isLegacyTolerated, LEDGER_EVENTS, MAX_LEDGER_BYTES, validateLedger,
} from './ledger-validate.mjs'

// §1 became enforceable on a system that was already running, and the first
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
    return fail('unknown_event', `${name} is not an event in contract §4 (known: ${LEDGER_EVENTS.join(', ')})`)
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
  let existing
  try {
    existing = readLines(path)
  } catch (error) {
    return fail('unreadable', `cannot read ${path}: ${error.message}`)
  }

  const before = validateLedger(existing)
  // Master, 2026-08-03: §1 became enforceable on a system that had already been
  // running, so a ledger written before it can contain a backwards pull. If
  // every append were refused, that token could never be CLOSED either — not
  // even `abandoned` — and a rule meant to keep work moving would strand the
  // work it caught. A terminal event may land on such a file. Nothing else may:
  // another `pulled` is refused exactly as it is on a clean ledger.
  const continuable = !before.ok
    && before.problems.every((problem) => isLegacyTolerated(problem))
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
      : `${name} does not satisfy contract §4: ${problems.map((problem) => problem.detail).join('; ')}`
    return fail(code, detail, problems)
  }

  try {
    ensureDir(dirname(path))
    const created = !existsSync(path)
    // One `appendFileSync` of one already-newline-terminated line: JSON.stringify
    // escapes every control character, so a record can never split into two
    // lines or interleave with a concurrent writer's line.
    appendFileSync(path, `${line}\n`, { mode: FILE_MODE })
    if (created) chmodSync(path, FILE_MODE)
  } catch (error) {
    return fail('write_failed', `cannot append to ${path}: ${error.message}`)
  }

  return { ok: true, path, line: existing.length + 1, record }
}

const USAGE = `usage:
  ledger-writer.mjs --repo <repo> --actor <agent:id|human:id> --event '<json>'
  ledger-writer.mjs --repo <repo> --actor <agent:id|human:id> --stdin   read the event JSON from stdin

Known events: ${LEDGER_EVENTS.join(', ')}
Every write is validated against contract §4 and against the ledger it joins.
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
