// ledger-reader-ratchet.test.mjs — proves the A5 ratchet actually guards
// something (sees the real, current readers; not a regex matching nothing)
// and proves it fails on a genuinely new reader, then recovers when that
// reader is removed. Fast, in-process, no subprocess spawn needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkLedgerReaderRatchet, DEFAULT_BASELINE_PATH, DEFAULT_SCAN_DIR, findLedgerReaders,
} from '../scripts/ledger-reader-ratchet.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// The trap this whole file exists to avoid: a check that passes because it
// finds nothing anywhere is indistinguishable, from a green run, from a check
// that is actually guarding something. So before trusting the ratchet against
// a fixture, prove it SEES the real, current, shipped-tree readers.
test('sees the real readers in the shipped tree, not zero', () => {
  const readers = findLedgerReaders(DEFAULT_SCAN_DIR)
  const names = readers.map((r) => r.file).sort()
  // Printed, not just asserted: a human re-running this file after the tree
  // changes sees the count directly, the same discipline CLAUDE.md asks of
  // `node --test` output itself (gate on the count, not a grep).
  console.log(`ledger-reader-ratchet: found ${readers.length} reader(s): ${names.join(', ')}`)

  // Pinned to the exact count found on this branch (v0.14.6 + the commits
  // this worktree branched from) by the same detector this test imports —
  // not hand-counted separately. A regex that silently stops matching drops
  // this to 0 and fails LOUDLY here, rather than the ratchet quietly passing
  // with nothing left to guard.
  assert.equal(readers.length, 9, `expected 9 known ledger readers, found ${readers.length}: ${names.join(', ')}`)

  // The two sanctioned readers named in the task must always be among them —
  // proves the detector isn't merely finding *some* nine files, but the ones
  // that actually own reading a ledger.
  assert.ok(names.includes('ledger-writer.mjs'), 'ledger-writer.mjs must be detected as a reader (it reads-before-append)')
  assert.ok(names.includes('ledger-validate.mjs'), 'ledger-validate.mjs must be detected as a reader (that is its whole job)')
  // And the aggregate reader every other consumer goes through.
  assert.ok(names.includes('dispatch-facts.mjs'), 'dispatch-facts.mjs defines readWorkItems and must be detected')

  assert.deepEqual(names, [
    'admit.mjs', 'dispatch-facts.mjs', 'graph.mjs', 'intake-stats.mjs', 'kanban.mjs',
    'ledger-validate.mjs', 'ledger-writer.mjs', 'loop-runner.mjs', 'pull-controller.mjs',
  ])
})

test('the ratchet passes as this branch stands, against the real baseline', () => {
  const result = checkLedgerReaderRatchet()
  assert.equal(result.baselinePath, DEFAULT_BASELINE_PATH)
  assert.deepEqual(result.extra, [], 'no reader should be outside the recorded baseline on a clean branch')
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
// Isolated fixtures below: a throwaway scan directory + throwaway baseline,
// never the real plugins/ tree. Proves the FAIL path, not just the PASS path.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-ratchet-'))
  return dir
}

function writeBaseline(dir, readers) {
  const path = join(dir, 'baseline.json')
  writeFileSync(path, JSON.stringify({ readers }), 'utf8')
  return path
}

test('fails when a new reader appears, and recovers when it is removed', () => {
  const scanDir = sandbox()
  try {
    // Two innocent files that do not read the ledger at all — proves the
    // detector does not just flag every .mjs file in the directory.
    writeFileSync(join(scanDir, 'harmless-a.mjs'), 'export const x = 1\n')
    writeFileSync(join(scanDir, 'harmless-b.mjs'), "import { join } from 'node:path'\nexport const y = join('a', 'b')\n")
    const baselinePath = writeBaseline(scanDir, [])

    const before = checkLedgerReaderRatchet({ scanDir, baselinePath })
    assert.equal(before.ok, true)
    assert.deepEqual(before.readers, [])

    // The fixture: a new file that reads a ledger the ordinary, accidental
    // way — importing the obvious helper — exactly the shape this ratchet
    // exists to catch (see the bypass discussion in the checked-in module).
    const fixturePath = join(scanDir, 'fixture-new-reader.mjs')
    writeFileSync(
      fixturePath,
      "import { readWorkItems } from './dispatch-facts.mjs'\nexport const items = readWorkItems('/tmp/repo')\n",
    )

    const during = checkLedgerReaderRatchet({ scanDir, baselinePath })
    assert.equal(during.ok, false, 'a new reader not on the baseline must fail the check')
    assert.equal(during.code, 'new_reader')
    assert.equal(during.extra.length, 1)
    assert.equal(during.extra[0].file, 'fixture-new-reader.mjs')
    assert.deepEqual(during.extra[0].signals, ['readWorkItems'])

    // Remove the fixture — the acceptance criterion requires the check to
    // recover, not merely to have failed once.
    unlinkSync(fixturePath)
    const after = checkLedgerReaderRatchet({ scanDir, baselinePath })
    assert.equal(after.ok, true, 'removing the new reader must restore a passing check')
    assert.deepEqual(after.extra, [])
  } finally {
    rmSync(scanDir, { recursive: true, force: true })
  }
})

test('each of the three documented signals is independently detected', () => {
  const scanDir = sandbox()
  try {
    writeFileSync(join(scanDir, 'via-read-work-items.mjs'),
      "import { readWorkItems } from './dispatch-facts.mjs'\nreadWorkItems('/tmp/x')\n")
    writeFileSync(join(scanDir, 'via-ledger-path.mjs'),
      "import { ledgerPath } from './ledger-writer.mjs'\nconsole.log(ledgerPath('/tmp/x', 'tok'))\n")
    writeFileSync(join(scanDir, 'via-validate-file.mjs'),
      "import { validateLedgerFileTolerant } from './ledger-validate.mjs'\nvalidateLedgerFileTolerant('/tmp/x.jsonl')\n")
    // A negative control: importing the LINES-based validators must NOT
    // count, because they read whatever the CALLER already read off disk,
    // not the disk themselves (see the module header's signal-3 caveat).
    writeFileSync(join(scanDir, 'via-lines-only-validator.mjs'),
      "import { validateLedgerTolerant, validateLedger } from './ledger-validate.mjs'\nvalidateLedger([])\nvalidateLedgerTolerant([])\n")
    const baselinePath = writeBaseline(scanDir, [])

    const result = checkLedgerReaderRatchet({ scanDir, baselinePath })
    const byFile = Object.fromEntries(result.readers.map((r) => [r.file, r.signals]))

    assert.deepEqual(byFile['via-read-work-items.mjs'], ['readWorkItems'])
    assert.deepEqual(byFile['via-ledger-path.mjs'], ['ledgerPath'])
    assert.deepEqual(byFile['via-validate-file.mjs'], ['ledger-validate-disk-reader'])
    assert.equal(byFile['via-lines-only-validator.mjs'], undefined,
      'validateLedger/validateLedgerTolerant take pre-read lines and must not count as reading the ledger')
    assert.equal(result.readers.length, 3)
  } finally {
    rmSync(scanDir, { recursive: true, force: true })
  }
})

test('a baseline entry that stopped reading (removed) never fails the check — the ratchet only tightens', () => {
  const scanDir = sandbox()
  try {
    // Nothing in this directory reads the ledger any more...
    writeFileSync(join(scanDir, 'now-harmless.mjs'), 'export const z = 1\n')
    // ...but the baseline still remembers it as a reader from before the fix.
    const baselinePath = writeBaseline(scanDir, ['now-harmless.mjs', 'already-deleted.mjs'])

    const result = checkLedgerReaderRatchet({ scanDir, baselinePath })
    assert.equal(result.ok, true, 'a stale baseline entry (reader removed or file deleted) must not fail the check')
    assert.deepEqual(result.extra, [])
    assert.deepEqual(result.stale.sort(), ['already-deleted.mjs', 'now-harmless.mjs'])
  } finally {
    rmSync(scanDir, { recursive: true, force: true })
  }
})

test('a malformed baseline file fails closed with a clear error, not a false pass', () => {
  const scanDir = sandbox()
  try {
    const baselinePath = join(scanDir, 'bad-baseline.json')
    writeFileSync(baselinePath, '{"not_readers": []}', 'utf8')
    const result = checkLedgerReaderRatchet({ scanDir, baselinePath })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'bad_baseline')
  } finally {
    rmSync(scanDir, { recursive: true, force: true })
  }
})

// Sanity: the module resolves its own defaults relative to the repo, not to
// whatever directory `node --test` happened to be invoked from.
test('default paths point inside this repo', () => {
  assert.ok(DEFAULT_SCAN_DIR.startsWith(ROOT))
  assert.ok(DEFAULT_BASELINE_PATH.startsWith(ROOT))
})
