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
//     truncated) and fs.appendFile (O_APPEND). With ≤8 writers each writing
//     one small line this is good enough — documented, not engineered.
//   * id IS the 1-based line number, counted at append time from the lines
//     already on disk. A hand-inserted garbage line therefore shifts the NEXT
//     append's id — which is correct: id is a line number, not a counter.
//   * Exit codes: 0 ok · 1 usage/validation · 2 file missing.
//   * The board lives in the run's workspace and dies with it. No locking, no
//     watch mode, no wiring into the delivery loop or the custody ledger.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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
// argument — is a positional. Required positionals are DATA first: quoting is
// the caller's only voice, so `append <board> FACT "--dry-run failed"` and the
// grep keyword in `grep <board> --dry-run` must reach the board as text, not
// die as an unknown flag. A flag missing its value is refused here rather than
// read as an empty string, which would append an entry nobody meant.
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
  const parsed = parseArgs(args, ['--agent', '--detail', '--ref'])
  if (parsed.error || parsed.positionals.length !== 3) {
    return fail(parsed.error || 'append takes: <file> <TYPE> <text>')
  }
  const [file, type, text] = parsed.positionals
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
