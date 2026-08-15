import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGES, renderBody, renderInline, renderRoadmap, runRenderCli } from '../scripts/roadmap-render.mjs'

const REPO_ROOT = new URL('..', import.meta.url).pathname

test('a code span next to an ordinary number survives both', () => {
  // The placeholder that protects code spans from the HTML escaper has to be a
  // sentinel the escaper leaves alone AND that prose cannot contain. A
  // space-delimited number is neither: "the cap is 128 KiB" would have been
  // read back as code span #128.
  const html = renderInline('the cap is 128 KiB, enforced by `gate.mjs` at 64 candidates')
  assert.match(html, /<code>gate\.mjs<\/code>/)
  assert.match(html, /128 KiB/)
  assert.match(html, /64 candidates/)
  assert.doesNotMatch(html, /undefined/)
})

test('rendering the same source twice gives the same bytes', () => {
  // Nothing may enter the page from the machine. A timestamp in the output
  // would make every render differ, and the digest --record pins would mean
  // nothing the moment it was written.
  const source = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8')
  assert.equal(renderRoadmap(source), renderRoadmap(source))
})

test('markup in the source is shown, never executed', () => {
  const html = renderRoadmap('# Title\n\nA line with <script>alert(1)</script> in it.\n')
  assert.doesNotMatch(html.split('</style>')[1], /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('a link that is not a link is left as text', () => {
  const html = renderInline('see [the page](javascript:alert(1)) and [the docs](https://example.test/x)')
  assert.doesNotMatch(html, /href="javascript/)
  assert.match(html, /<a href="https:\/\/example\.test\/x">the docs<\/a>/)
})

test('a table becomes a table, and every cell arrives', () => {
  const html = renderBody('| Phase | State |\n|---|---|\n| A | done |\n| B | open |\n')
  assert.match(html, /<th>Phase<\/th>/)
  assert.match(html, /<th>State<\/th>/)
  for (const cell of ['A', 'done', 'B', 'open']) {
    assert.match(html, new RegExp(`<td>${cell}</td>`))
  }
})

test('a wrapped list item stays one item', () => {
  const html = renderBody('- first line of the item\n  and its continuation\n- second item\n')
  assert.equal((html.match(/<li>/g) ?? []).length, 2)
  assert.match(html, /first line of the item and its continuation/)
})

test('every heading in the real ROADMAP.md reaches the page', () => {
  const source = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8')
  const headings = source.split('\n').filter((l) => /^#{1,4}\s/.test(l))
  assert.ok(headings.length >= 4, 'ROADMAP.md has almost no structure')
  const html = renderRoadmap(source)
  for (const heading of headings) {
    const [, hashes, text] = heading.match(/^(#{1,4})\s+(.*)$/)
    const plain = text.replace(/[*`]/g, '')
    assert.match(html, new RegExp(`<h${hashes.length}>[^<]*${plain.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `heading dropped: ${text}`)
  }
})

test('nothing in the real ROADMAP.md is silently dropped', () => {
  // A parser that meets a block shape it does not know can swallow it without
  // a word. Word coverage catches that; a heading count would not.
  const source = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8')
  const text = renderRoadmap(source).replace(/<[^>]+>/g, ' ')
  const missing = [...new Set(source.match(/[A-Za-z][A-Za-z-]{7,}/g) ?? [])]
    .filter((word) => !text.includes(word))
  assert.deepEqual(missing, [], `words present in the source and absent from the page: ${missing.join(', ')}`)
})

test('no unconsumed markup reaches the reader', () => {
  // The word-coverage test above does NOT catch this, and a mutation proved it:
  // delete the blockquote branch and those lines fall through to a paragraph
  // that still contains every word — coverage stays green while the reader gets
  // a literal "> " on the page. A parser that meets a block it cannot handle
  // must not quietly show its source.
  const source = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8')
  const text = renderRoadmap(source).split('</style>')[1].replace(/<[^>]+>/g, '\n')
  const leaked = text.split('\n').map((l) => l.trim())
    .filter((l) => /^(>|\||#{1,4}\s|[-*]\s|\d+\.\s)/.test(l))
  assert.deepEqual(leaked, [], `markdown markup rendered as text: ${leaked.join(' / ')}`)
  // and the block that would have leaked really is a blockquote
  assert.match(renderRoadmap(source), /<blockquote>/)
})

test('the CLI writes a page and reports where', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-render-'))
  writeFileSync(join(dir, 'ROADMAP.md'), '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  const out = join(dir, 'page.html')
  let printed = ''
  const code = runRenderCli(['--out', out], { root: dir, stdout: { write: (s) => { printed += s } } })
  assert.equal(code, 0)
  assert.match(printed, /wrote/)
  assert.match(readFileSync(out, 'utf8'), /<h1>Title<\/h1>/)
})

test('a missing source fails the script rather than writing an empty page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-render-empty-'))
  let printed = ''
  const code = runRenderCli([], { root: dir, stdout: { write: (s) => { printed += s } } })
  assert.equal(code, 1)
  assert.match(printed, /cannot read ROADMAP\.md/)
})

test('every declared page has a source that exists and a distinct slug', () => {
  // Two of the three published pages had no source in this repository at all,
  // which is why they went a week stale with nothing able to notice. The list is
  // the fix; a list naming a file that is not there would be the same failure
  // wearing a checklist.
  const root = new URL('..', import.meta.url).pathname
  assert.ok(PAGES.length >= 2)
  for (const page of PAGES) {
    assert.equal(existsSync(join(root, page.source)), true, `${page.slug}: no source at ${page.source}`)
    assert.ok(readFileSync(join(root, page.source), 'utf8').length > 200, `${page.slug}: source is a stub`)
  }
  assert.equal(new Set(PAGES.map((p) => p.slug)).size, PAGES.length, 'two pages publish to one slug')
  assert.equal(new Set(PAGES.map((p) => p.out)).size, PAGES.length, 'two pages render to one file')
})

test('a page renders to the output its entry names, and takes its title from the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-pages-'))
  writeFileSync(join(dir, 'ROADMAP.md'), '# A Named Page\n\nbody text that is long enough.\n')
  let printed = ''
  assert.equal(runRenderCli([], { root: dir, stdout: { write: (s) => { printed += s } } }), 0)
  const html = readFileSync(join(dir, PAGES[0].out), 'utf8')
  assert.match(html, /<title>A Named Page<\/title>/, 'the page kept a title the source did not give it')
})

test('an undeclared source never renders over a declared page', () => {
  // The whole defect in one line: the renderer fell back to the roadmap's output
  // path for any source it did not know, so a typo — or the same file spelled
  // `./ROADMAP.md` — rendered some other document straight over the published
  // roadmap. Found by three review lanes independently.
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-unknown-'))
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'ROADMAP.md'), '# The Roadmap\n\nthe page that must not be overwritten.\n')
  writeFileSync(join(dir, PAGES[0].out), '<html>the published roadmap</html>')
  writeFileSync(join(dir, 'NOPE.md'), '# Not A Page\n\nsomething else entirely, long enough.\n')

  let printed = ''
  const code = runRenderCli(['NOPE.md'], { root: dir, stdout: { write: (s) => { printed += s } } })
  assert.equal(code, 1)
  assert.match(printed, /not a declared page/)
  assert.equal(readFileSync(join(dir, PAGES[0].out), 'utf8'), '<html>the published roadmap</html>',
    'an undeclared source overwrote the roadmap page')
})

test('a declared source renders to ITS output, named positionally', () => {
  // The positional source argument — the core of the change — had no test at
  // all; the only new one called the CLI with an empty argv.
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-positional-'))
  const page = PAGES[1]
  mkdirSync(join(dir, page.source.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, page.source), '# Second Page\n\nbody long enough to be a real page.\n')
  let printed = ''
  assert.equal(runRenderCli([page.source], { root: dir, stdout: { write: (s) => { printed += s } } }), 0, printed)
  assert.match(readFileSync(join(dir, page.out), 'utf8'), /<title>Second Page<\/title>/)
  assert.equal(existsSync(join(dir, PAGES[0].out)), false, 'it also wrote the roadmap page')
})

test('--out=<path> is honoured, not silently dropped', () => {
  // `indexOf('--out')` never matched the inline form, so a caller who asked for
  // a different output got the declared page written instead — an instruction
  // accepted and ignored. Three review lanes found it.
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-inline-out-'))
  writeFileSync(join(dir, 'ROADMAP.md'), '# Inline\n\nbody long enough to be a real page.\n')
  const out = join(dir, 'elsewhere.html')
  let printed = ''
  assert.equal(runRenderCli([`--out=${out}`], { root: dir, stdout: { write: (s) => { printed += s } } }), 0, printed)
  assert.match(readFileSync(out, 'utf8'), /<h1>Inline<\/h1>/)
  assert.equal(existsSync(join(dir, PAGES[0].out)), false, 'it wrote the declared page as well')
})
