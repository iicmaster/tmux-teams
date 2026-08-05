// ledger-reader-ratchet.mjs — fails when a NEW file starts reading a token's
// custody ledger straight off disk. A RATCHET, not an allowlist: the baseline
// records the CURRENT set of readers, and the check only fails on ADDITION.
// Removing a file from the baseline (because it stopped reading) is always
// allowed and tightens the guard for everyone after it — see A5.
//
// Why a ratchet and not "fix it now": the long-term cure is one canonical
// snapshot every reader consumes (a later wave). Until that lands, every
// reader that talks straight to
// `plugins/tmux-teams/skills/tmux-teams/scripts/ledger-{validate,writer}.mjs`
// (or reimplements their job) is a second place the "what does this ledger
// mean" question gets answered, and #42 was exactly that: the planner
// re-derived a rule the writer already enforces, and the two drifted.
//
// ---------------------------------------------------------------------------
// What counts as "reads the ledger" (documented so a future maintainer can
// see the definition being enforced, not just its output):
//
//   1. The identifier `readWorkItems` appears anywhere in the file — either
//      importing it from dispatch-facts.mjs, or (for dispatch-facts.mjs
//      itself) defining and calling it. This is the sanctioned AGGREGATE
//      reader: everything reachable from every token's ledger, parsed once.
//   2. The identifier `ledgerPath` appears anywhere in the file — either
//      importing it from ledger-writer.mjs to locate ONE token's ledger file,
//      or (for ledger-writer.mjs itself) defining and calling it.
//   3. One of `validateLedgerFileTolerant`, `validateLedgerFile`, or
//      `validateWorkItems` appears anywhere in the file — the three
//      ledger-validate.mjs exports that read bytes off disk themselves
//      (unlike `validateLedger`/`validateLedgerTolerant`, which only judge
//      lines a caller already read — importing those two does NOT count,
//      and must not: they take `lines`, never a path, so a file that only
//      imports them is reading whatever ITS caller already read, not the
//      disk itself).
//
// A file matching any signal is a reader whether it is importing the
// sanctioned path or reimplementing it inline — signal 3 in particular is
// what would catch a hand-rolled re-read of ledger-validate.mjs's own logic
// if someone ever pasted it rather than importing it, AS LONG AS the copy
// keeps the same names. It would not catch a copy that renamed everything,
// which is exactly the bypass documented below.
//
// ---------------------------------------------------------------------------
// How this check can be bypassed, and how expensive that is:
//
//   - Textual re-export renaming. A new file that does
//       `import { readWorkItems as getStuff } from './dispatch-facts.mjs'`
//     and only ever writes `getStuff` in its own source never contains the
//     literal identifier `readWorkItems`, so none of the three signals fire
//     on IT. The re-export line itself, however, has to live SOMEWHERE, and
//     wherever it lives is a diff to a file that already reads the ledger —
//     either a new shim file (which trips this ratchet the moment it is
//     added, being new and matching signal 1) or a hand-edited line inside
//     an already-baselined file such as dispatch-facts.mjs (which does NOT
//     trip the ratchet, because that file was already a recorded reader).
//     The bypass costs one line in a file every reviewer already expects to
//     see ledger internals in — it does not cost nothing, but it is real.
//   - Path obfuscation. Building `.tmux-teams/work-items/<id>.jsonl` from
//     character codes, `Buffer.from(..., 'base64')`, string concatenation
//     split across variables, or any construction that never spells out
//     `ledgerPath`/`readWorkItems`/`validateLedgerFile*` as a literal
//     identifier defeats every signal here at once — this check is pure
//     static text matching, not a parser and not a dataflow analysis. This
//     is the cheapest bypass and the one most worth naming plainly: it takes
//     no more effort than writing the string differently, and nothing here
//     would catch it. What it does NOT defeat is code review, and unlike an
//     accidental new `import { readWorkItems }` — the case this ratchet
//     actually exists to catch — deliberately obfuscating a path is not a
//     shape any of the eleven-going-on-nine current readers got written by
//     accident.
//
// In short: this stops the ordinary way a twelfth reader appears — someone
// adds `import { readWorkItems } from './dispatch-facts.mjs'` to a new file
// because it is the obvious thing to import — and says nothing about a
// determined attempt to hide one. That is the trade a ratchet makes: cheap,
// mechanical, and honest about its own ceiling.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

export const DEFAULT_SCAN_DIR = join(REPO_ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
export const DEFAULT_BASELINE_PATH = join(HERE, 'ledger-readers.baseline.json')

const SIGNALS = [
  { name: 'readWorkItems', re: /\breadWorkItems\b/ },
  { name: 'ledgerPath', re: /\bledgerPath\b/ },
  {
    name: 'ledger-validate-disk-reader',
    re: /\bvalidateLedgerFileTolerant\b|\bvalidateLedgerFile\b|\bvalidateWorkItems\b/,
  },
]

// An alias for a signal, exported by a file that already reads. The header
// below names "textual re-export renaming" as the cheapest bypass, and on the
// day this check shipped a new module used it: `dispatch-facts.mjs` gained
// `export const loadWorkItemLedgers = readWorkItems` for the express purpose
// of letting `agent-seat-reads.mjs` import a reader without the identifier
// appearing in its own source. That module is not re-deriving anything — it
// consumes the sanctioned reader, which is the shape this check WANTS — but
// it read a ledger and this file reported nine, unchanged, as though nothing
// had. A count that cannot see the file it is counting is worse than a count
// nobody trusts.
//
// So an alias is discovered rather than assumed: a name bound to a signal
// anywhere in the scan becomes a signal itself, everywhere. It does not make
// the file that consumes it a violation — it makes it VISIBLE, which is all
// this check was ever for.
//
// Two spellings, because an alias is a fact about MEANING and this file can
// only see SYNTAX. The `const` form was the one that actually shipped; the
// `export { X as Y }` form is what an ordinary tidying refactor turns it into,
// and it was invisible here until an outside review proved it with a probe on
// 2026-08-05. That second hole mattered more than the first: with the rename
// spelled this way the check did not merely miss a reader, it PASSED and then
// reported the still-reading file as stale — advising a maintainer to delete
// the one baseline entry that was telling the truth.
const ALIAS_RE = /export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*$/gm
const REEXPORT_RE = /export\s*\{([^}]*)\}/g
const RENAME_RE = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g

// `export { X }` with no rename needs nothing here: an importer of it writes
// the signal's own name, which the base check already sees.
function aliasPairs(text) {
  const pairs = []
  for (const [, alias, target] of text.matchAll(ALIAS_RE)) pairs.push({ alias, target })
  for (const [, body] of text.matchAll(REEXPORT_RE)) {
    for (const [, target, alias] of body.matchAll(RENAME_RE)) pairs.push({ alias, target })
  }
  return pairs
}

// To a FIXPOINT, not one pass: an alias of an alias is still an alias, and a
// single pass stops at the first hop — which is a bypass anyone can build by
// renaming twice. Bounded by the pair count because each round must add at
// least one new name to continue.
function resolveAliasSignals(pairs) {
  const found = []
  const named = (name) => SIGNALS.find((entry) => entry.re.test(name))
    ?? found.find((entry) => entry.re.test(name))
  for (let round = 0; round <= pairs.length; round += 1) {
    const before = found.length
    for (const { alias, target } of pairs) {
      if (found.some((entry) => entry.alias === alias)) continue
      const signal = named(target)
      if (signal) found.push({ alias, name: `${signal.name}-as-${alias}`, re: new RegExp(`\\b${alias}\\b`) })
    }
    if (found.length === before) break
  }
  return found
}

function detectSignals(text, extra = []) {
  const hits = []
  for (const signal of [...SIGNALS, ...extra]) {
    if (signal.re.test(text)) hits.push(signal.name)
  }
  return hits
}

// Scans one directory, non-recursively — the shipped tree this guards is a
// flat `scripts/` folder (see DEFAULT_SCAN_DIR); a future nested layout would
// need this extended, and would fail closed today (files it cannot see are
// files it cannot flag), which is exactly the trap this file's own header
// warns against. Kept flat deliberately rather than silently "handled".
export function findLedgerReaders(scanDir) {
  const names = readdirSync(scanDir).filter((name) => name.endsWith('.mjs')).sort()
  const sources = new Map(names.map((name) => [name, readFileSync(join(scanDir, name), 'utf8')]))
  // Two passes: an alias exported by one file is a signal for every file,
  // including files scanned before it.
  const aliases = resolveAliasSignals([...sources.values()].flatMap(aliasPairs))
  const readers = []
  for (const name of names) {
    const signals = detectSignals(sources.get(name), aliases)
    if (signals.length) readers.push({ file: name, signals })
  }
  return readers
}

function loadBaseline(baselinePath) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    return { ok: false, error: `cannot read baseline ${baselinePath}: ${error.message}` }
  }
  if (!parsed || !Array.isArray(parsed.readers)) {
    return { ok: false, error: `${baselinePath} must be a JSON object with a "readers" array` }
  }
  return { ok: true, readers: [...parsed.readers].sort() }
}

/**
 * The ratchet itself. `ok` is true iff every DETECTED reader is already on
 * the recorded baseline — i.e. nothing NEW appeared. A baseline entry with no
 * matching detected reader (`stale`) is reported but never fails the check:
 * removing a reader must always be allowed (see file header), and this is
 * where that promise is kept.
 */
export function checkLedgerReaderRatchet(options = {}) {
  const scanDir = options.scanDir ?? DEFAULT_SCAN_DIR
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH

  const baseline = loadBaseline(baselinePath)
  if (!baseline.ok) {
    return { ok: false, code: 'bad_baseline', detail: baseline.error, readers: [], extra: [], stale: [] }
  }

  const readers = findLedgerReaders(scanDir)
  const readerNames = new Set(readers.map((r) => r.file))
  const baselineNames = new Set(baseline.readers)

  const extra = readers.filter((r) => !baselineNames.has(r.file))
  const stale = baseline.readers.filter((name) => !readerNames.has(name))

  return {
    ok: extra.length === 0,
    code: extra.length === 0 ? 'ok' : 'new_reader',
    scanDir,
    baselinePath,
    readers,
    extra,
    stale,
  }
}

const USAGE = `usage: ledger-reader-ratchet.mjs [--scan-dir <dir>] [--baseline <path>]

Fails when a file under the scanned directory reads a work-item ledger
directly and is not already recorded in the baseline manifest. See the
comment at the top of this file for exactly what counts as "reads the
ledger" and how that definition can be bypassed.`

function flag(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const scanDir = flag(args, '--scan-dir') ?? DEFAULT_SCAN_DIR
  const baselinePath = flag(args, '--baseline') ?? DEFAULT_BASELINE_PATH

  const result = checkLedgerReaderRatchet({ scanDir, baselinePath })
  if (result.code === 'bad_baseline') {
    process.stderr.write(`ERROR  ${result.detail}\n`)
    return 2
  }

  process.stdout.write(`scanned ${result.scanDir}\n`)
  process.stdout.write(`baseline ${result.baselinePath}\n`)
  process.stdout.write(`${result.readers.length} file(s) currently read the ledger:\n`)
  for (const reader of result.readers) {
    process.stdout.write(`  - ${reader.file}  (${reader.signals.join(', ')})\n`)
  }

  if (result.stale.length) {
    // NOT "safe to remove". This check cannot tell "stopped reading" from "still
    // reads, through a spelling I cannot see" — and it got that exact pair wrong
    // once already. A file that cannot answer must say UNKNOWN, never "no".
    process.stdout.write(`note: ${result.stale.length} baseline entr${result.stale.length === 1 ? 'y is' : 'ies are'} no longer DETECTED as reading — which means either it stopped, or it now reads through a spelling this check cannot see. Confirm by reading the file before removing either one:\n`)
    for (const name of result.stale) process.stdout.write(`  - ${name}\n`)
  }

  if (!result.ok) {
    process.stderr.write(`FAIL  ${result.extra.length} new ledger reader(s) not in ${result.baselinePath}:\n`)
    for (const reader of result.extra) {
      process.stderr.write(`  - ${reader.file}  (matched: ${reader.signals.join(', ')})\n`)
    }
    process.stderr.write('Add the file to the baseline only after confirming it genuinely needs to read a ledger directly.\n')
    return 1
  }

  process.stdout.write(`PASS  0 new ledger reader(s)\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
