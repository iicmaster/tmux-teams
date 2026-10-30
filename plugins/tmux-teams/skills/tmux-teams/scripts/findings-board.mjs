// findings-board.mjs — the shared findings board: one append-only JSONL file
// per delegation run.
//
// Workers in a delegation record what they learned so no peer re-derives a dead
// end and the PM reads one file instead of N transcripts. FAIL — a falsified
// hypothesis — is a first-class entry: recording a dead end is the highest-value
// act on the board. Inspired by Microsoft Agensh (arXiv 2609.26781) and kept
// deliberately minimal: one file, one script, no service, no daemon, no dedup
// engine — the PM curates.
//
// The contract this file does not get to reinterpret:
//   * APPEND-ONLY. No subcommand edits or deletes; superseding means appending
//     a new entry whose --ref names the old id. The only write paths are init's
//     empty exclusive create (`wx` — a competing create is refused, never
//     truncated) and fs.appendFile (O_APPEND).
//   * id IS the 1-based line number, counted at append time from the lines
//     already on disk. A hand-inserted garbage line therefore shifts the NEXT
//     append's id — which is correct: id is a line number, not a counter.
//     Two promises collide here — ≤8 concurrent writers AND unique ids — and
//     the id promise is the load-bearing one: --ref supersession addresses
//     entries by id, and two writers that read the same line count store the
//     same id on two lines (O_APPEND protects the write position, not the
//     read-count-append sequence; the release panel of 2026-10-30 proved the
//     interleaving with two writers). The smallest mechanism that keeps both
//     promises is an exclusive sidecar directory held across count-and-append
//     — mkdir is atomic everywhere this plugin runs — reclaimed by age when a
//     writer crashes, never by a human.
//   * Exit codes: 0 ok · 1 usage/validation · 2 file missing.
//   * The board lives in the run's workspace and dies with it (the lock is a
//     sidecar of the board, so it dies with it too). No watch mode, no wiring
//     into the delivery loop or the custody ledger.
//
// Decisions the spec left open, taken here and stated so they can be argued
// with:
//   * `read --type` filters FIRST, then takes the most-recent N of the matches.
//     "The 20 most recent FAILs" is the question a PM asks; limit-then-filter
//     answers "the FAILs among the last 20 of anything", which reads as empty
//     on a busy board.
//   * A line that parses as JSON but is not an entry (not an object, or no
//     numeric id) is malformed like an unparsable one: skipped, warned, never
//     fatal. A blank line is nothing at all and is skipped silently — the
//     trailing newline must not raise a warning on every read.
//   * --ref must be a positive integer. Whether the referenced entry exists is
//     NOT checked: the PM supersedes and curates, the script does not judge.
//   * grep prints the same digest `read` does, detail line included — a match
//     whose evidence pointer is hidden would not be a match worth printing.
//   * init creates missing parent directories (the run workspace may not exist
//     yet); append never creates anything — a missing board is exit 2, never a
//     silent new file, because a board created by accident looks exactly like
//     one everybody forgot to init.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TYPES = Object.freeze(['OBSERVED', 'FACT', 'FAIL', 'CLAIM', 'PATCH_SUMMARY'])

const TEXT_CAP = 100
const PATCH_SUMMARY_TEXT_CAP = 300
const DETAIL_CAP = 2000
const DEFAULT_LIMIT = 20

// PATCH_SUMMARY is a worker's final report and gets three lines to say it in;
// every other type is a finding and gets one. Exported so a test can call the
// rule rather than re-derive it.
export const textCapFor = (type) => (type === 'PATCH_SUMMARY' ? PATCH_SUMMARY_TEXT_CAP : TEXT_CAP)

// A field that is absent from the CLI stays absent from the JSON — `detail` and
// `ref` are omitted, not null, so a reader never has to decide whether a null
// means "none" or "unknown". Key order is the contract's order: id, ts, type,
// agent, text, detail, ref.
export function appendEntry(file, { type, text, agent, detail, ref }) {
  if (!existsSync(file)) {
    return { ok: false, exit: 2, message: `no board at ${file} — run init first` }
  }
  if (!TYPES.includes(type)) {
    return { ok: false, exit: 1, message: `invalid type "${type}" — expected one of ${TYPES.join(', ')}` }
  }
  const textCap = textCapFor(type)
  if (text.length > textCap) {
    return { ok: false, exit: 1, message: `text is ${text.length} chars — cap for ${type} is ${textCap}` }
  }
  if (detail !== undefined && detail.length > DETAIL_CAP) {
    return { ok: false, exit: 1, message: `detail is ${detail.length} chars — cap is ${DETAIL_CAP}` }
  }
  if (ref !== undefined && (!Number.isInteger(ref) || ref < 1)) {
    return { ok: false, exit: 1, message: `ref must be a positive integer entry id, got "${ref}"` }
  }

  // The whole read-count-append sequence runs under the sidecar lock: id is
  // the physical line number, so the count and the append must be one
  // indivisible step or two writers store the same id on two lines. See the
  // header's id bullet for why the lock is the smallest mechanism that keeps
  // both the ≤8-writers budget and the id promise.
  return withBoardLock(file, () => {
    const existing = readFileSync(file, 'utf8')
    const id = countLines(existing) + 1
    // A hand edit that left the last line unterminated would fuse our JSON onto
    // it — lead with the newline the file is missing. Still append-only: bytes
    // are added, none rewritten.
    const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
    const entry = { id, ts: new Date().toISOString(), type, agent: agent || 'unknown', text }
    if (detail !== undefined) entry.detail = detail
    if (ref !== undefined) entry.ref = ref
    appendFileSync(file, `${lead}${JSON.stringify(entry)}\n`)
    return { ok: true, id }
  })
}

// Exclusive sidecar directory held across count-and-append. mkdir is atomic
// on every filesystem this plugin names, so acquisition needs no further
// protocol: EEXIST means somebody holds it. A holder that crashed leaves the
// directory behind; age reclaims it (LOCK_STALE_MS), never a human. The lock
// sits next to the board and dies with the run workspace like the board does.
// A live holder is waited out up to LOCK_ACQUIRE_MS — with ≤8 writers each
// holding for one small read-plus-append, an unacquirable lock means
// something is wrong, and failing loudly (exit 1, named path) beats hanging.
const LOCK_STALE_MS = 10_000
const LOCK_ACQUIRE_MS = 15_000
const LOCK_POLL_MS = 20

const lockDirFor = (file) => `${file}.lock`

const withBoardLock = (file, fn) => {
  const dir = lockDirFor(file)
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'owner'), `${process.pid} ${new Date().toISOString()}\n`)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let age = 0
      try { age = Date.now() - statSync(dir).mtimeMs } catch { /* released between check and stat; retry now */ continue }
      if (age > LOCK_STALE_MS) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* a concurrent reclaim won; retry */ }
      }
      if (Date.now() - started > LOCK_ACQUIRE_MS) {
        return { ok: false, exit: 1, message: `board lock ${dir} not acquirable within ${LOCK_ACQUIRE_MS}ms — a holder may be wedged` }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS)
    }
  }
  try {
    return fn()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* already gone; the stale-reclaim path can win this race harmlessly */ }
  }
}

// Line count of a text blob, counting a missing trailing newline as a line —
// `"a\n"` is one line, `"a"` is one line, `"a\nb"` is two.
const countLines = (content) => {
  if (content === '') return 0
  const lines = content.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

// The one reader. Returns every well-formed entry in file order plus the line
// numbers it had to skip, so the caller warns once per skipped line and still
// exits 0 — a board with one corrupt line is damaged, not dead.
export function readEntries(file) {
  if (!existsSync(file)) {
    return { ok: false, exit: 2, message: `no board at ${file} — run init first` }
  }
  const content = readFileSync(file, 'utf8')
  const entries = []
  const malformed = []
  if (content !== '') {
    content.split('\n').forEach((line, index) => {
      if (line === '') return
      let entry
      try { entry = JSON.parse(line) } catch { malformed.push(index + 1); return }
      if (typeof entry !== 'object' || entry === null || !Number.isInteger(entry.id)) {
        malformed.push(index + 1)
        return
      }
      entries.push(entry)
    })
  }
  return { ok: true, entries, malformed }
}

// Filter by type first, then keep the most-recent N of what matched, oldest
// first — see the header for why the order is filter-then-limit.
export function selectEntries(entries, { type, limit = DEFAULT_LIMIT } = {}) {
  const matched = type ? entries.filter((entry) => entry.type === type) : entries
  return matched.slice(Math.max(0, matched.length - limit))
}

// The digest is what a worker's brief actually carries, so every byte of it is
// contract: `#<id> <TYPE> <text>`, ` (supersedes #<ref>)` when superseding, and
// a `    = <detail>` line carrying the evidence pointer.
export function digestLines(entry) {
  const head = `#${entry.id} ${entry.type} ${entry.text}`
    + (entry.ref !== undefined ? ` (supersedes #${entry.ref})` : '')
  return entry.detail !== undefined ? [head, `    = ${entry.detail}`] : [head]
}

const USAGE = `usage:
  node findings-board.mjs init <file>
  node findings-board.mjs append <file> <TYPE> "<text>" [--agent NAME] [--detail TEXT] [--ref ID]
  node findings-board.mjs read <file> [--type TYPE] [--limit N] [--format digest|json]
  node findings-board.mjs grep <file> <keyword> [keyword...]

One append-only JSONL board per run. Types: OBSERVED FACT FAIL CLAIM PATCH_SUMMARY.
Caps: text <= 100 chars (300 for PATCH_SUMMARY), detail <= 2000. Supersede by
appending with --ref <id> — nothing on the board is ever edited or deleted.`

// One flag shape for every subcommand: a token is a flag only when it is one
// of that subcommand's allowed flags; everything else — including a `--`-prefixed
// argument — is a positional. This scanner is honest ONLY for positionals that
// cannot collide with the subcommand's own flags (grep has none; init none;
// read's single positional colliding with --type/--limit/--format is REFUSED
// as a missing positional, never silently mis-stored). Where a required
// positional CAN collide — append's <text> against --agent/--detail/--ref —
// the subcommand takes its positionals as data by position before calling
// this; see appendBoard. A flag missing its value is refused here rather
// than read as an empty string, which would append an entry nobody meant.
const parseArgs = (args, allowedFlags) => {
  const positionals = []
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && allowedFlags.includes(arg)) {
      const value = args[i + 1]
      if (value === undefined) return { error: `flag ${arg} needs a value` }
      flags[arg] = value
      i++
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

// One error door: the message names the field or file that refused, the exit
// code comes from the caller's verdict (1 validation, 2 missing file) — never
// hardcoded, so a missing board cannot masquerade as a usage error.
const fail = (message, exit = 1) => {
  process.stderr.write(`findings-board: ${message}\n`)
  return exit
}

const positiveIntFlag = (raw, name) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    return { error: `${name} must be a positive integer, got "${raw}"` }
  }
  return { value }
}

function initBoard(args) {
  const parsed = parseArgs(args, [])
  if (parsed.error || parsed.positionals.length !== 1) {
    return fail(parsed.error || 'init takes exactly one argument: the board file')
  }
  const file = parsed.positionals[0]
  const exists = `${file} already exists — init creates a board once; append to it instead`
  if (existsSync(file)) return fail(exists)
  mkdirSync(dirname(resolve(file)), { recursive: true })
  try {
    // `wx` is the point: the create is exclusive, so a board that a competing
    // init slips into existence between the existsSync check and this open
    // makes the open fail with EEXIST instead of truncating it. A plain `w`
    // here is how a race destroys someone's entry while init still exits 0.
    writeFileSync(file, '', { flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') return fail(exists)
    throw error
  }
  return 0
}

function appendBoard(args) {
  // Data by POSITION, then flags: `append <file> <TYPE> "<text>"` names its
  // three positionals, so the first three tokens are data no matter what they
  // look like. A text token exactly equal to a flag name — `append b FACT
  // "--detail" --agent worker-a` — must store the literal text "--detail";
  // the left-to-right scanner used here first consumed it as the option and
  // then ate `--agent` as its value, storing text="worker-a",
  // detail="--agent", agent="unknown" with exit 0: successful evidence
  // corruption, caught by the release panel of 2026-10-30. The old comment
  // promised "positionals are DATA first"; the loop never did it for a
  // token that collides with one of append's own flags.
  if (args.length < 3) return fail('append takes: <file> <TYPE> <text>')
  const positionals = [args[0], args[1], args[2]]
  const parsed = parseArgs(args.slice(3), ['--agent', '--detail', '--ref'])
  if (parsed.error) return fail(parsed.error)
  const [file, type, text] = positionals
  let ref
  if (parsed.flags['--ref'] !== undefined) {
    const parsedRef = positiveIntFlag(parsed.flags['--ref'], 'ref')
    if (parsedRef.error) return fail(parsedRef.error)
    ref = parsedRef.value
  }
  const result = appendEntry(file, {
    type, text,
    agent: parsed.flags['--agent'],
    detail: parsed.flags['--detail'],
    ref,
  })
  if (!result.ok) return fail(result.message, result.exit)
  process.stdout.write(`appended #${result.id}\n`)
  return 0
}

function readBoard(args) {
  const parsed = parseArgs(args, ['--type', '--limit', '--format'])
  if (parsed.error || parsed.positionals.length !== 1) {
    return fail(parsed.error || 'read takes exactly one argument: the board file')
  }
  const file = parsed.positionals[0]
  const format = parsed.flags['--format'] ?? 'digest'
  if (format !== 'digest' && format !== 'json') {
    return fail(`invalid format "${format}" — expected digest or json`)
  }
  const type = parsed.flags['--type']
  if (type !== undefined && !TYPES.includes(type)) {
    return fail(`invalid type "${type}" — expected one of ${TYPES.join(', ')}`)
  }
  let limit = DEFAULT_LIMIT
  if (parsed.flags['--limit'] !== undefined) {
    const parsedLimit = positiveIntFlag(parsed.flags['--limit'], 'limit')
    if (parsedLimit.error) return fail(parsedLimit.error)
    limit = parsedLimit.value
  }
  const board = readEntries(file)
  if (!board.ok) return fail(board.message, board.exit)
  for (const line of board.malformed) process.stderr.write(`skipped malformed line ${line}\n`)
  const selected = selectEntries(board.entries, { type, limit })
  for (const entry of selected) {
    process.stdout.write((format === 'json' ? JSON.stringify(entry) : digestLines(entry).join('\n')) + '\n')
  }
  return 0
}

function grepBoard(args) {
  const parsed = parseArgs(args, [])
  if (parsed.error) return fail(parsed.error)
  const keywords = parsed.positionals.slice(1)
  if (!parsed.positionals.length) return fail('grep takes: <file> <keyword> [keyword...]')
  if (!keywords.length) return fail('grep needs at least one keyword')
  const board = readEntries(parsed.positionals[0])
  if (!board.ok) return fail(board.message, board.exit)
  for (const line of board.malformed) process.stderr.write(`skipped malformed line ${line}\n`)
  const needles = keywords.map((keyword) => keyword.toLowerCase())
  for (const entry of board.entries) {
    const haystack = `${entry.text ?? ''} ${entry.detail ?? ''}`.toLowerCase()
    if (needles.every((needle) => haystack.includes(needle))) {
      process.stdout.write(digestLines(entry).join('\n') + '\n')
    }
  }
  return 0
}

function main(argv) {
  const [command, ...rest] = argv.slice(2)
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  switch (command) {
    case 'init': return initBoard(rest)
    case 'append': return appendBoard(rest)
    case 'read': return readBoard(rest)
    case 'grep': return grepBoard(rest)
    default:
      process.stderr.write(`${USAGE}\n`)
      return fail(command === undefined ? 'a subcommand is required' : `unknown subcommand "${command}"`)
  }
}

// CLAUDE.md's boot-path rule: import.meta.url is percent-encoded and resolved
// through symlinks while argv[1] is as typed, so the comparison runs through
// realpathSync on both sides — a board path with a space, or macOS /var →
// /private/var, must not turn a CLI invocation into a silent no-op.
const invokedAsMain = () => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (process.argv[1] && invokedAsMain()) {
  process.exitCode = main(process.argv)
}
