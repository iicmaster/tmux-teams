// findings-board.test.mjs — the board is a contract, not a data structure:
// five types, two caps, three exit codes, and an append-only file. Every case
// here boots the CLI and pins one line of that contract, because the brief a
// worker receives is built from this output — a digest that drifts by one space
// is a worker reading a different dialect than the PM taught.
//
// Each test drives the real script (spawnSync, never an import for the CLI
// assertions) so the boot path — argv parsing, exit codes, stdout/stderr split —
// is exercised, not just the functions underneath it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FINDINGS = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/findings-board.mjs')

const run = (...args) => spawnSync(process.execPath, [FINDINGS, ...args], { encoding: 'utf8' })

// Every test gets its own temp directory and its own board: no test reads a
// board another test wrote.
const boardPath = (name) => join(mkdtempSync(join(tmpdir(), 'findings-board-')), name)

const newBoard = () => {
  const file = boardPath('board.jsonl')
  assert.equal(run('init', file).status, 0)
  return file
}

const append = (file, type, text, ...flags) => run('append', file, type, text, ...flags)

// The digest is line-split on purpose: an empty-but-successful read must read
// as zero lines, not [''], and the exact array is what the deepEquals pin.
const stdoutLines = (result) => result.stdout.split('\n').filter((line) => line !== '')

const entryAt = (file, line) => JSON.parse(readFileSync(file, 'utf8').split('\n')[line - 1])

test('init creates an empty board file', () => {
  const file = boardPath('fresh.jsonl')
  const result = run('init', file)
  assert.equal(result.status, 0)
  assert.ok(existsSync(file), 'init must create the file')
  assert.equal(readFileSync(file, 'utf8'), '', 'a fresh board is empty')
})

test('init on an existing board exits 1 and names the file — no idempotent re-init', () => {
  const file = newBoard()
  const again = run('init', file)
  assert.equal(again.status, 1)
  assert.match(again.stderr, /already exists/)
  assert.match(again.stderr, /board\.jsonl/, 'the message names the file it refused')
})

// init is append-only too: the refusal must not disturb a byte already on the
// board. A truncate-then-reject init passes the empty-board test above while
// destroying every entry that landed between its check and its open.
test('double-init on a written board refuses without disturbing one byte of it', () => {
  const file = newBoard()
  append(file, 'FACT', 'an already-known fact')
  const before = readFileSync(file, 'utf8')
  const again = run('init', file)
  assert.equal(again.status, 1)
  assert.match(again.stderr, /already exists/)
  assert.equal(readFileSync(file, 'utf8'), before, 'a refused init must not truncate the entries it refuses')
})

test('append happy path: stdout, id, ISO-8601 UTC ts, agent default, detail/ref omitted', () => {
  const file = newBoard()
  const result = append(file, 'FACT', 'the build is red')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'appended #1\n')
  const entry = entryAt(file, 1)
  assert.equal(entry.id, 1)
  assert.equal(entry.type, 'FACT')
  assert.equal(entry.text, 'the build is red')
  assert.equal(entry.agent, 'unknown', 'agent defaults to unknown')
  // ISO round-trip, not just parseability: a non-ISO UTC string like
  // "Mon, 26 Oct 2026 00:00:00 Z" parses fine and still ends in Z, but only a
  // true ISO-8601 UTC string is returned unchanged by toISOString.
  assert.equal(new Date(entry.ts).toISOString(), entry.ts,
    'ts must be ISO-8601 UTC: parse and re-serialize must return the exact string')
  assert.ok(!('detail' in entry), 'detail omitted when not provided, not null')
  assert.ok(!('ref' in entry), 'ref omitted when not provided, not null')
})

// The five types are pinned literally (a loop over the script's own constant
// would pass with a type deleted from it) and one rejection names the legal set.
test('all five types accepted; an unknown type exits 1 and writes nothing', () => {
  const file = newBoard()
  for (const type of ['OBSERVED', 'FACT', 'FAIL', 'CLAIM', 'PATCH_SUMMARY']) {
    const result = append(file, type, `a ${type} entry`)
    assert.equal(result.status, 0, `${type} must be accepted`)
  }
  const bad = append(file, 'NOTE', 'not one of the five')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /invalid type "NOTE"/)
  assert.match(bad.stderr, /PATCH_SUMMARY/, 'the message lists the legal types')
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 5, 'the rejected append wrote nothing')
  // The accepted type must be the one that was appended — a serializer that
  // quietly files CLAIM and PATCH_SUMMARY under FACT makes the five types a
  // two-type board while every exit code still looks right.
  const storedTypes = [1, 2, 3, 4, 5].map((line) => entryAt(file, line).type)
  assert.deepEqual(storedTypes, ['OBSERVED', 'FACT', 'FAIL', 'CLAIM', 'PATCH_SUMMARY'],
    'each entry must store the literal type it was appended as')
})

test('text cap is 100: exactly 100 appends, 101 exits 1 naming text and the cap', () => {
  const file = newBoard()
  assert.equal(append(file, 'FACT', 'x'.repeat(100)).status, 0, '100 chars sits at the cap, legal')
  const over = append(file, 'FACT', 'y'.repeat(101))
  assert.equal(over.status, 1)
  assert.match(over.stderr, /\btext\b/)
  assert.match(over.stderr, /\b100\b/)
})

test('PATCH_SUMMARY cap is 300 — and 150 chars still fails a FACT: the cap is per-type', () => {
  const file = newBoard()
  assert.equal(append(file, 'PATCH_SUMMARY', 'p'.repeat(300)).status, 0, '300 sits at the cap, legal')
  const over = append(file, 'PATCH_SUMMARY', 'q'.repeat(301))
  assert.equal(over.status, 1)
  assert.match(over.stderr, /\b300\b/)
  const fact = append(file, 'FACT', 'f'.repeat(150))
  assert.equal(fact.status, 1, 'FACT keeps its own 100 cap even under the 300 headline')
  assert.match(fact.stderr, /\b100\b/)
})

test('detail cap is 2000: exactly 2000 appends, 2001 exits 1 naming detail and the cap', () => {
  const file = newBoard()
  const at = append(file, 'FACT', 'short', '--detail', 'd'.repeat(2000))
  assert.equal(at.status, 0, '2000 chars sits at the cap, legal')
  const over = append(file, 'FACT', 'short', '--detail', 'e'.repeat(2001))
  assert.equal(over.status, 1)
  assert.match(over.stderr, /\bdetail\b/)
  assert.match(over.stderr, /\b2000\b/)
})

test('append to a missing board exits 2 with the init hint — and creates nothing', () => {
  const file = boardPath('never-inited.jsonl')
  const result = append(file, 'FACT', 'orphan finding')
  assert.equal(result.status, 2, 'missing file is exit 2, not 1')
  assert.match(result.stderr, /run init first/)
  assert.ok(!existsSync(file), 'a refused append must not leave a board behind')
})

test('two appends preserve the prior line byte-for-byte with monotonic ids', () => {
  const file = newBoard()
  assert.equal(append(file, 'OBSERVED', 'first finding').stdout, 'appended #1\n')
  const before = readFileSync(file, 'utf8')
  assert.equal(append(file, 'OBSERVED', 'second finding').stdout, 'appended #2\n')
  const after = readFileSync(file, 'utf8')
  assert.ok(after.startsWith(before), 'append-only: the second append cannot disturb the first line')
  assert.equal(before.trim().split('\n').length, 1)
  assert.equal(after.trim().split('\n').length, 2)
  assert.equal(JSON.parse(after.split('\n')[0]).id, 1)
  assert.equal(JSON.parse(after.split('\n')[1]).id, 2)
})

test('--agent, --detail and --ref land in the JSON with the right types', () => {
  const file = newBoard()
  append(file, 'FACT', 'the old claim')
  const result = append(file, 'FAIL', 'the cache theory died',
    '--agent', 'worker-a', '--detail', 'trace 404 disproves it', '--ref', '1')
  assert.equal(result.status, 0)
  const entry = entryAt(file, 2)
  assert.equal(entry.agent, 'worker-a')
  assert.equal(entry.detail, 'trace 404 disproves it')
  assert.equal(entry.ref, 1)
  assert.equal(typeof entry.ref, 'number', 'ref is the numeric id, not the string "--ref 1"')
})

// An argument beginning with `--` is DATA wherever a positional is required:
// quoting is the caller's only voice, so the parser may not second-guess it
// into a flag. Grep keywords are data all the way down.
test('a text or keyword beginning with -- is data, not a flag', () => {
  const file = newBoard()
  const appended = append(file, 'FAIL', '--dry-run failed')
  assert.equal(appended.status, 0, 'the text is the third positional; leading dashes do not make it a flag')
  assert.equal(entryAt(file, 1).text, '--dry-run failed')
  const hit = run('grep', file, '--dry-run')
  assert.equal(hit.status, 0, 'a grep keyword beginning with -- is data too')
  assert.deepEqual(stdoutLines(hit), ['#1 FAIL --dry-run failed'])
})

test('read defaults: digest, most recent 20 of 25, printed oldest to newest', () => {
  const file = newBoard()
  for (let n = 1; n <= 25; n++) append(file, 'OBSERVED', `finding ${n}`)
  const result = run('read', file)
  assert.equal(result.status, 0)
  const lines = stdoutLines(result)
  assert.equal(lines.length, 20, 'the default limit is 20')
  assert.equal(lines[0], '#6 OBSERVED finding 6', 'the most recent 20 start at #6, oldest first')
  assert.equal(lines[19], '#25 OBSERVED finding 25', 'and end at the newest')
})

test('digest format is exact: supersedes suffix, then the four-space detail line', () => {
  const file = newBoard()
  append(file, 'FACT', 'the old fact')
  append(file, 'FACT', 'the new fact', '--detail', 'why the old one is wrong', '--ref', '1')
  const result = run('read', file)
  assert.equal(result.status, 0)
  // Raw stdout, no blank-line stripping: a digest that grew blank lines between
  // records would be a different dialect, and this is the test where that dies.
  assert.equal(result.stdout, [
    '#1 FACT the old fact',
    '#2 FACT the new fact (supersedes #1)',
    '    = why the old one is wrong',
  ].join('\n') + '\n')
})

test('read --type returns only that type, in chronological order', () => {
  const file = newBoard()
  append(file, 'OBSERVED', 'observed one')
  append(file, 'FAIL', 'fail one')
  append(file, 'OBSERVED', 'observed two')
  append(file, 'FAIL', 'fail two')
  const result = run('read', file, '--type', 'FAIL')
  assert.equal(result.status, 0)
  assert.deepEqual(stdoutLines(result), ['#2 FAIL fail one', '#4 FAIL fail two'])
})

test('read --limit takes the MOST RECENT N and prints them oldest to newest', () => {
  const file = newBoard()
  for (let n = 1; n <= 5; n++) append(file, 'OBSERVED', `finding ${n}`)
  const result = run('read', file, '--limit', '2')
  assert.equal(result.status, 0)
  assert.deepEqual(stdoutLines(result), ['#4 OBSERVED finding 4', '#5 OBSERVED finding 5'])
})

// Pins the filter-then-limit order: limit first would answer ['#5'] filtered to
// nothing; filter first answers the most recent FAIL, which is the question.
test('--type with --limit gives the most recent N of that type, not the type of the last N', () => {
  const file = newBoard()
  append(file, 'OBSERVED', 'obs one')
  append(file, 'FAIL', 'fail one')
  append(file, 'OBSERVED', 'obs two')
  append(file, 'FAIL', 'fail two')
  append(file, 'OBSERVED', 'obs three')
  const result = run('read', file, '--type', 'FAIL', '--limit', '1')
  assert.equal(result.status, 0)
  assert.deepEqual(stdoutLines(result), ['#4 FAIL fail two'])
})

test('read --format json emits one raw JSON entry per line', () => {
  const file = newBoard()
  append(file, 'FACT', 'a plain fact')
  append(file, 'FAIL', 'the old claim is dead', '--ref', '1')
  const result = run('read', file, '--format', 'json')
  assert.equal(result.status, 0)
  const lines = stdoutLines(result)
  assert.equal(lines.length, 2)
  const entries = lines.map((line) => JSON.parse(line))
  assert.equal(entries[0].text, 'a plain fact')
  assert.equal(entries[1].ref, 1)
  assert.deepEqual(entries.map((entry) => entry.id), [1, 2])
})

// Entry 1 matches cache in text only, entry 2 in detail only, entry 4 in both
// across fields and cases — so OR, text-only matching and case-sensitivity each
// fail this test on their own.
test('grep is AND across text+detail, case-insensitive, printed as digest', () => {
  const file = newBoard()
  append(file, 'OBSERVED', 'Cache warming skips cold pools')
  append(file, 'FACT', 'rerun after reboot', '--detail', 'the CACHE log shows the retry')
  append(file, 'FACT', 'unrelated observation', '--detail', 'nothing to see here')
  append(file, 'FAIL', 'the cache theory died', '--detail', 'log TRACE 7 disproves it')
  const result = run('grep', file, 'cache', 'trace')
  assert.equal(result.status, 0)
  assert.deepEqual(stdoutLines(result), [
    '#4 FAIL the cache theory died',
    '    = log TRACE 7 disproves it',
  ])
})

test('grep one keyword is case-insensitive; no match exits 0 with empty output', () => {
  const file = newBoard()
  append(file, 'OBSERVED', 'Cache warming skips cold pools')
  append(file, 'FACT', 'rerun after reboot', '--detail', 'the CACHE log shows the retry')
  append(file, 'FAIL', 'the cache theory died', '--detail', 'log TRACE 7 disproves it')
  const hits = run('grep', file, 'CACHE')
  assert.equal(hits.status, 0)
  assert.deepEqual(
    stdoutLines(hits).filter((line) => line.startsWith('#')),
    ['#1 OBSERVED Cache warming skips cold pools', '#2 FACT rerun after reboot', '#3 FAIL the cache theory died'])
  const miss = run('grep', file, 'zzz-no-such-thing')
  assert.equal(miss.status, 0, 'an empty result is success, not an error')
  assert.equal(miss.stdout, '')
})

test('grep with no keywords exits 1', () => {
  const file = newBoard()
  const result = run('grep', file)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /at least one keyword/)
})

test('a malformed line is skipped with a warning on stderr, on read and grep, still exit 0', () => {
  const file = newBoard()
  append(file, 'FACT', 'good one')
  append(file, 'FAIL', 'good two')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.splice(1, 0, 'this is not json')
  writeFileSync(file, lines.join('\n'))

  const read = run('read', file)
  assert.equal(read.status, 0, 'one corrupt line must not take the board down')
  assert.match(read.stderr, /skipped malformed line 2\b/)
  assert.deepEqual(stdoutLines(read), ['#1 FACT good one', '#2 FAIL good two'])

  const grep = run('grep', file, 'good')
  assert.equal(grep.status, 0)
  assert.match(grep.stderr, /skipped malformed line 2\b/)
  assert.equal(stdoutLines(grep).length, 2, 'grep skips the same line read skips')
})

// ── Round-2 corrections (release panel of 2026-10-30) ─────────────────────
// Two contract failures were proved on the pre-panel bytes and fixed: a text
// token exactly equal to one of append's own flags was eaten as that flag
// (storing the NEXT flag's name as the text — successful evidence corruption
// with exit 0), and read-count-append had no serialization, so two writers
// reading the same line count stored the same id on two lines. These tests
// pin both corrections; deleting either reopens the finding the panel closed.

test('append stores a text token identical to a flag name as text, not as the flag', () => {
  const file = newBoard()
  // Before the fix: text="worker-a", detail="--agent", agent="unknown", exit 0.
  const one = append(file, 'FACT', '--detail', '--agent', 'worker-a')
  assert.equal(one.status, 0, one.stderr)
  const first = entryAt(file, 1)
  assert.equal(first.text, '--detail', 'the flag-shaped token in the text POSITION is text')
  assert.equal(first.agent, 'worker-a')
  assert.equal(first.detail, undefined, 'no --detail flag was given, so none is stored')

  // --ref as text alongside a real --ref flag: both must survive, separately.
  const two = append(file, 'FACT', '--ref', '--ref', '1', '--agent', 'w2')
  assert.equal(two.status, 0, two.stderr)
  const second = entryAt(file, 2)
  assert.equal(second.text, '--ref')
  assert.equal(second.ref, 1, 'the REAL --ref flag still parses after the positionals')

  // --agent as text with no flags at all.
  const three = append(file, 'FACT', '--agent')
  assert.equal(three.status, 0, three.stderr)
  assert.equal(entryAt(file, 3).text, '--agent')
})

test('append with fewer than three positionals exits 1 and names the usage', () => {
  const file = newBoard()
  const result = run('append', file, 'FACT')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /append takes:/)
})

// Real processes, real interleaving: 8 writers x 3 appends is the promised
// concurrency budget, and id IS the physical line number, so the board must
// hold exactly ids 1..24 with no duplicate. Without the sidecar lock this
// schedule is exactly the one the panel proved could double-book an id.
test('8 concurrent writers x 3 appends yield exactly ids 1..24, no duplicates', async () => {
  const file = newBoard()
  const spawns = []
  for (let w = 1; w <= 8; w++) {
    for (let j = 1; j <= 3; j++) {
      spawns.push(new Promise((res, rej) => {
        const child = spawn(process.execPath, [FINDINGS, 'append', file, 'FACT', `w${w}-finding-${j}`, '--agent', `w${w}`])
        child.on('exit', (code) => code === 0 ? res() : rej(new Error(`writer w${w}#${j} exited ${code}`)))
        child.on('error', rej)
      }))
    }
  }
  await Promise.all(spawns)

  const ids = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l).id)
  const unique = new Set(ids)
  assert.equal(ids.length, 24, 'every append landed')
  assert.equal(unique.size, 24, 'no id is stored twice')
  assert.deepEqual([...unique].sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1),
    'the ids are exactly the physical line numbers 1..24')
  assert.ok(!existsSync(`${file}.lock`), 'the lock is released when the last writer finishes')
})

test('a stale lock (a crashed writer) is reclaimed by age, and the append succeeds', () => {
  const file = newBoard()
  const lock = `${file}.lock`
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner'), '999999 crashed-long-ago\n')
  // Age the lock past LOCK_STALE_MS so the live writer reclaims it.
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)

  const result = append(file, 'FACT', 'after the crash')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(entryAt(file, 1).text, 'after the crash')
  assert.ok(!existsSync(lock), 'the reclaimed lock is removed with the append')
})
