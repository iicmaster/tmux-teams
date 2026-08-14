import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyRoadmap, runRoadmapGateCli, sourceDigest,
  ROADMAP_SOURCE, ROADMAP_MARKER, MARKER_SCHEMA, ROADMAP_EXIT,
} from '../scripts/roadmap-gate.mjs'

const SOURCE = '# ROADMAP\n\nsomething true today.\n'
const DIGEST = sourceDigest(Buffer.from(SOURCE))
const marker = (over = {}) => ({
  schema: MARKER_SCHEMA,
  source_sha256: DIGEST,
  url: 'https://artifacts.example/roadmap/',
  published_at: '2026-08-13T00:00:00.000Z',
  ...over,
})

const repoWith = ({ source = SOURCE, markerValue } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-gate-'))
  writeFileSync(join(dir, ROADMAP_SOURCE), source)
  if (markerValue !== undefined) {
    writeFileSync(join(dir, ROADMAP_MARKER),
      typeof markerValue === 'string' ? markerValue : JSON.stringify(markerValue))
  }
  return dir
}
const run = (argv, dir) => {
  let out = ''
  const code = runRoadmapGateCli(argv, { root: dir, stdout: { write: (s) => { out += s } } })
  return { code, out }
}

test('a page nobody has recorded as published is stale', () => {
  const v = classifyRoadmap(Buffer.from(SOURCE), null)
  assert.equal(v.stale, true)
  assert.match(v.reason, /never been recorded/)
})

test('a marker matching the source byte-for-byte is current', () => {
  assert.equal(classifyRoadmap(Buffer.from(SOURCE), marker()).stale, false)
})

test('one edited character makes it stale', () => {
  // The whole point: the gate answers from the BYTES, not from a date somebody
  // typed. A roadmap that says "updated today" and describes last month is the
  // failure this replaces.
  const v = classifyRoadmap(Buffer.from(`${SOURCE} `), marker())
  assert.equal(v.stale, true)
  assert.match(v.reason, /changed since the last publish/)
})

test('a marker that cannot be trusted is treated as stale, never as current', () => {
  for (const [label, value] of [
    ['wrong schema', marker({ schema: 'something.else' })],
    ['no digest', marker({ source_sha256: undefined })],
    ['digest not a sha256', marker({ source_sha256: 'nope' })],
    ['no url', marker({ url: undefined })],
    ['http url', marker({ url: 'http://artifacts.example/roadmap/' })],
    ['an array', []],
    ['a string', 'published, trust me'],
  ]) {
    assert.equal(classifyRoadmap(Buffer.from(SOURCE), value).stale, true,
      `${label}: an unusable marker was accepted as proof of publication`)
  }
})

test('the gate NEVER writes the marker', () => {
  // The load-bearing test. A gate that records its own answer passes forever —
  // the same vacuous shape as a test asserting a value it just computed, which
  // this repository has been bitten by seven times. Recording must stay a
  // separate, deliberate act performed after a publish really happened.
  const dir = repoWith()
  const { code } = run([], dir)
  assert.equal(code, ROADMAP_EXIT.stale)
  assert.equal(existsSync(join(dir, ROADMAP_MARKER)), false,
    'the gate created the marker it is supposed to be checking')
  // and again, in case a first run were treated as a special case
  run([], dir)
  assert.equal(existsSync(join(dir, ROADMAP_MARKER)), false)
})

test('--record writes what was published, and the gate then agrees', () => {
  const dir = repoWith()
  const rec = run(['--record', 'https://artifacts.example/roadmap/'], dir)
  assert.equal(rec.code, ROADMAP_EXIT.current)
  const written = JSON.parse(readFileSync(join(dir, ROADMAP_MARKER), 'utf8'))
  assert.equal(written.schema, MARKER_SCHEMA)
  assert.equal(written.source_sha256, DIGEST)
  assert.equal(written.url, 'https://artifacts.example/roadmap/')
  assert.equal(run([], dir).code, ROADMAP_EXIT.current)
})

test('--record refuses without a real url, because a marker with no url cannot be checked by a human either', () => {
  const dir = repoWith()
  assert.equal(run(['--record'], dir).code, ROADMAP_EXIT.failed)
  assert.equal(run(['--record', 'not-a-url'], dir).code, ROADMAP_EXIT.failed)
  assert.equal(existsSync(join(dir, ROADMAP_MARKER)), false)
})

test('a missing source file fails the script rather than reporting current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-gate-empty-'))
  const { code, out } = run([], dir)
  assert.equal(code, ROADMAP_EXIT.failed)
  assert.match(out, /cannot read ROADMAP\.md/)
})

test('the repository ships a ROADMAP.md the gate can read', () => {
  // Without this, every assertion above could pass against fixtures while the
  // real file did not exist — which is exactly how the published page came to
  // have no source at all.
  const root = new URL('..', import.meta.url).pathname
  assert.equal(existsSync(join(root, ROADMAP_SOURCE)), true, 'ROADMAP.md is missing from the repository root')
  assert.ok(readFileSync(join(root, ROADMAP_SOURCE), 'utf8').length > 200, 'ROADMAP.md is a stub')
})

test('an undeclared source is refused, never treated as the roadmap', () => {
  // Three review lanes found this independently: an unknown or misspelled source
  // fell back to the roadmap's marker, so a typo answered about a page that does
  // not exist. The page list is the authority.
  const dir = repoWith()
  const { code, out } = run(['NOPE.md'], dir)
  assert.equal(code, ROADMAP_EXIT.failed)
  assert.match(out, /not a declared page/)
  assert.match(out, /ROADMAP\.md/, 'the refusal did not say what the declared pages are')
})

test('one spelling per page — ./ROADMAP.md is ROADMAP.md', () => {
  // Two spellings used to keep two separate records, which nothing would ever
  // reconcile: one could read current while the other read stale, for one file.
  const dir = repoWith()
  run(['--record', 'https://artifacts.example/roadmap/'], dir)
  assert.equal(run(['./ROADMAP.md'], dir).code, ROADMAP_EXIT.current,
    'the same file spelled differently kept its own publication record')
})

test('--record=<url> records, exactly as --record <url> does', () => {
  const dir = repoWith()
  const { code, out } = run(['--record=https://artifacts.example/roadmap/'], dir)
  assert.equal(code, ROADMAP_EXIT.current, out)
  assert.equal(run([], dir).code, ROADMAP_EXIT.current)
})

test('--record works when a source is named first, and records that source', () => {
  // It asked whether argv[0] was `--record`. Naming a source first — the only
  // way to record any page but the roadmap — fell through to the CHECK branch,
  // recorded nothing, and printed STALE as though nothing had been asked. A
  // command that does the opposite of what it was told, quietly, is worse than
  // one that refuses.
  const dir = repoWith()
  const other = 'RELEASE-PLAN.md'
  writeFileSync(join(dir, other), '# Other\n\nlong enough to be a real page, twice over.\n')

  const rec = run([other, '--record', 'https://artifacts.example/other/'], dir)
  assert.equal(rec.code, ROADMAP_EXIT.current, rec.out)
  assert.match(rec.out, /recorded/)

  // The named page is current; the roadmap is untouched by it.
  assert.equal(run([other], dir).code, ROADMAP_EXIT.current)
  assert.equal(run([], dir).code, ROADMAP_EXIT.stale, 'recording one page marked another as published')
  assert.equal(existsSync(join(dir, ROADMAP_MARKER)), false, 'the roadmap marker was written by another page')
})

test('a stale page names the marker and source it actually read', () => {
  // The message was built from the roadmap constants no matter which page was
  // checked, so a second page reported a missing `.roadmap-published.json` —
  // sending a reader to look at the wrong file for the wrong reason.
  const dir = repoWith()
  writeFileSync(join(dir, 'RELEASE-PLAN.md'), '# Other\n\nlong enough to be a real page, twice over.\n')
  const { out } = run(['RELEASE-PLAN.md'], dir)
  assert.match(out, /RELEASE-PLAN/)
  assert.doesNotMatch(out, /\.roadmap-published\.json/)
})
