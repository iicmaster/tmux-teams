// gate-required.test.mjs — proves the release-gate classifier fails CLOSED.
//
// Everything here runs against literal diff text held in this file. No temp
// git repos, no `process.env` reads, no subprocesses. That is not a style
// preference: both of this repo's CI burns were non-hermetic tests (one read
// the author's `~/.config/claude-profiles/`, one inherited `ACP_MODEL` from
// the shell), and a classifier that decides whether a release gets reviewed
// is the last place to repeat it.
//
// The trap this file is written against: a classifier that answers EXEMPT for
// everything would make every one of these fixtures pass if the fixtures only
// checked the exempt cases. So every exempt case below has a near-identical
// required twin — same file, one meaningful character different.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DOC_ONLY, classifyRelease, parseDiff, whyGated } from '../scripts/gate-required.mjs'

const file = (path, addedLines, removedLines) => ({ path, addedLines, removedLines })

// ---------------------------------------------------------------------------
// The pure classifier

test('a version bump inside a real test file is exempt', () => {
  const bump = file(
    'tests/plugin-structure.test.mjs',
    ["const RELEASE_VERSION = '0.18.3'"],
    ["const RELEASE_VERSION = '0.18.2'"],
  )
  assert.equal(whyGated(bump), null)
})

test('a semantic change hiding on a line that mentions a version REQUIRES the panel', () => {
  // The twin of the case above. Identical file, identical version movement —
  // and one extra clause that the panel is the only thing that would read.
  const smuggled = file(
    'tests/plugin-structure.test.mjs',
    ["const RELEASE_VERSION = process.env.VERSION ?? '0.18.3'"],
    ["const RELEASE_VERSION = '0.18.2'"],
  )
  assert.equal(whyGated(smuggled), 'changes more than the version string')
})

test('a changed shipped source file always requires the panel', () => {
  const shipped = file(
    'plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs',
    ['  return true'],
    ['  return false'],
  )
  assert.equal(whyGated(shipped), 'changes more than the version string')
})

// The list stated HERE, not read from the module. Both tests below used to
// iterate `DOC_ONLY` itself, which proves nothing: adding an entry makes the
// loop test the new entry and pass, so `scripts/gate-required.mjs` could have
// been added to its own allowlist — it is not under `plugins/` — and every
// assertion would still be green while semantic edits to the decider became
// exempt. Found by the release panel (codex lane, 2026-08-10); it is the trap
// CLAUDE.md already names, written again by the author who wrote the warning.
const ALLOWLIST = ['HANDOFF.md', 'README.md', 'CLAUDE.md']

test('the documentation allowlist is exactly these three files', () => {
  assert.deepEqual([...DOC_ONLY].sort(), [...ALLOWLIST].sort(),
    'the shipped allowlist drifted from the list this file pins — if the change is intended, change it HERE too and say why')
})

test('the documentation allowlist is exempt whatever it says', () => {
  for (const path of ALLOWLIST) {
    assert.equal(whyGated(file(path, ['anything at all'], [])), null, path)
  }
})

test('nothing inside plugins/ is on the documentation allowlist', () => {
  // A guard on the guard: the exemption is only defensible because none of
  // these files reach an installed plugin. Walks the SHIPPED set, because the
  // thing being guarded against is a path getting into that set.
  for (const path of DOC_ONLY) {
    assert.ok(!path.startsWith('plugins/'), `${path} ships — it cannot be doc-only`)
  }
})

test('a new file outside the allowlist requires the panel', () => {
  const added = file('plugins/tmux-teams/skills/tmux-teams/scripts/new-thing.mjs', ['export const x = 1'], [])
  assert.equal(whyGated(added), 'changes more than the version string')
})

test('a deleted file requires the panel', () => {
  const deleted = file('plugins/tmux-teams/skills/tmux-teams/scripts/gone.mjs', [], ['export const x = 1'])
  assert.equal(whyGated(deleted), 'changes more than the version string')
})

test('an unreadable change shape requires the panel rather than passing', () => {
  const binary = file('plugins/tmux-teams/assets/logo.png', [], [])
  assert.equal(
    whyGated(binary),
    'fail-closed: unrecognized change shape (binary, rename, or empty diff)',
  )
})

test('duplicate lines are compared as a multiset, not a set', () => {
  // Two identical lines bumped, ONE identical line put back. A Set-based
  // comparison calls these equal and waves the release through.
  const lopsided = file(
    'plugins/tmux-teams/plugin.json',
    ['  "version": "0.18.3"', '  "version": "0.18.3"'],
    ['  "version": "0.18.2"'],
  )
  assert.equal(whyGated(lopsided), 'changes more than the version string')
})

test('classifyRelease reports every deciding file, not just the first', () => {
  const verdict = classifyRelease([
    file('README.md', ['Current release: **0.18.3**'], ['Current release: **0.18.2**']),
    file('plugins/tmux-teams/skills/tmux-teams/scripts/a.mjs', ['b'], ['a']),
    file('.github/workflows/ci.yml', ['      - run: node --test --experimental'], ['      - run: node --test']),
  ])
  assert.equal(verdict.required, true)
  assert.deepEqual(verdict.deciding.map((d) => d.path), [
    'plugins/tmux-teams/skills/tmux-teams/scripts/a.mjs',
    '.github/workflows/ci.yml',
  ])
  assert.deepEqual(verdict.exempt, ['README.md'])
})

test('a docs-and-version-only release is exempt as a whole', () => {
  const verdict = classifyRelease([
    file('HANDOFF.md', ['new prose'], ['old prose']),
    file('README.md', ['Current release: **0.18.3**'], ['Current release: **0.18.2**']),
    file('plugins/tmux-teams/plugin.json', ['  "version": "0.18.3"'], ['  "version": "0.18.2"']),
    file('.claude-plugin/marketplace.json', ['    "version": "0.18.3"'], ['    "version": "0.18.2"']),
  ])
  assert.equal(verdict.required, false)
  assert.deepEqual(verdict.deciding, [])
})

test('an empty release REQUIRES the panel rather than exempting itself', () => {
  // This test used to assert `required: false` and so locked the bypass in:
  // a range that resolves to nothing, or a diff this parser cannot read at
  // all, exited 0 and printed `Gate: exempt`. Per-file that shape was already
  // fail-closed; the whole-release case was not. Found by the release panel
  // (codex lane, 2026-08-10).
  const verdict = classifyRelease([])
  assert.equal(verdict.required, true)
  assert.deepEqual(verdict.exempt, [])
  assert.equal(verdict.deciding.length, 1)
  assert.match(verdict.deciding[0].reason, /fail-closed/)
})

// ---------------------------------------------------------------------------
// The parser, against real `git diff --unified=0` output shapes

test('parseDiff reads paths and content lines, and never counts a header', () => {
  const files = parseDiff([
    'diff --git a/README.md b/README.md',
    'index 1111111..2222222 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -3 +3 @@',
    '-Current release: **0.18.2**',
    '+Current release: **0.18.3**',
    'diff --git a/plugins/tmux-teams/skills/x.mjs b/plugins/tmux-teams/skills/x.mjs',
    'index 3333333..4444444 100644',
    '--- a/plugins/tmux-teams/skills/x.mjs',
    '+++ b/plugins/tmux-teams/skills/x.mjs',
    '@@ -1 +1 @@',
    '-const a = 1',
    '+const a = 2',
    '',
  ].join('\n'))

  assert.deepEqual(files.map((f) => f.path), ['README.md', 'plugins/tmux-teams/skills/x.mjs'])
  // `--- a/README.md` starts with `-` and `+++ b/...` starts with `+`. If the
  // header checks were ordered after the content checks, each file would pick
  // up a phantom line here and the version-only proof would never hold.
  assert.deepEqual(files[0].addedLines, ['Current release: **0.18.3**'])
  assert.deepEqual(files[0].removedLines, ['Current release: **0.18.2**'])
})

test('an added line whose own content starts with ++ is content, not a header', () => {
  // The twin of the test above, and the bypass it hid. Inside a hunk, an added
  // line carrying `++ counter` arrives as `+++ counter` — byte-identical to a
  // file header. Reading it as a header renamed the file to `counter` AND
  // dropped the line, leaving only the version movement, so a real source
  // change under `plugins/` classified as version-only and the gate exempted
  // it. Found by the release panel (codex lane, 2026-08-10) and reproduced
  // before the fix was written.
  const [only] = parseDiff([
    'diff --git a/plugins/tmux-teams/skills/x.mjs b/plugins/tmux-teams/skills/x.mjs',
    '--- a/plugins/tmux-teams/skills/x.mjs',
    '+++ b/plugins/tmux-teams/skills/x.mjs',
    '@@ -4 +4 @@',
    '-const V = "0.18.2"',
    '+const V = "0.19.0"',
    '@@ -9,0 +10 @@',
    '+++ counter',
    '',
  ].join('\n'))

  assert.equal(only.path, 'plugins/tmux-teams/skills/x.mjs', 'a hunk line must never rename the file')
  assert.deepEqual(only.addedLines, ['const V = "0.19.0"', '++ counter'])
  assert.equal(whyGated(only), 'changes more than the version string')
  assert.equal(classifyRelease([only]).required, true)
})

test('a removed line whose own content starts with -- is content, not a header', () => {
  const [only] = parseDiff([
    'diff --git a/plugins/tmux-teams/skills/x.mjs b/plugins/tmux-teams/skills/x.mjs',
    '--- a/plugins/tmux-teams/skills/x.mjs',
    '+++ b/plugins/tmux-teams/skills/x.mjs',
    '@@ -4 +4 @@',
    '-const V = "0.18.2"',
    '+const V = "0.19.0"',
    '@@ -9 +9,0 @@',
    '--- counter',
    '',
  ].join('\n'))

  assert.deepEqual(only.removedLines, ['const V = "0.18.2"', '-- counter'])
  assert.equal(whyGated(only), 'changes more than the version string')
})

test('parseDiff keeps the path of a deleted file, whose +++ is /dev/null', () => {
  const [only] = parseDiff([
    'diff --git a/plugins/tmux-teams/skills/gone.mjs b/plugins/tmux-teams/skills/gone.mjs',
    'deleted file mode 100644',
    '--- a/plugins/tmux-teams/skills/gone.mjs',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const x = 1',
  ].join('\n'))

  assert.equal(only.path, 'plugins/tmux-teams/skills/gone.mjs')
  assert.deepEqual(only.addedLines, [])
  assert.equal(whyGated(only), 'changes more than the version string')
})

test('a binary file parses to no content lines and therefore requires the panel', () => {
  const [only] = parseDiff([
    'diff --git a/plugins/tmux-teams/assets/logo.png b/plugins/tmux-teams/assets/logo.png',
    'index 5555555..6666666 100644',
    'Binary files a/plugins/tmux-teams/assets/logo.png and b/plugins/tmux-teams/assets/logo.png differ',
  ].join('\n'))

  assert.equal(only.path, 'plugins/tmux-teams/assets/logo.png')
  assert.equal(classifyRelease([only]).required, true)
})

test('a pure rename carries no content lines and requires the panel', () => {
  const [only] = parseDiff([
    'diff --git a/plugins/tmux-teams/skills/old.mjs b/plugins/tmux-teams/skills/new.mjs',
    'similarity index 100%',
    'rename from plugins/tmux-teams/skills/old.mjs',
    'rename to plugins/tmux-teams/skills/new.mjs',
  ].join('\n'))

  assert.equal(only.path, 'plugins/tmux-teams/skills/new.mjs')
  // Named as a rename now, not as "no content lines". It used to reach the same
  // verdict by accident — a pure rename happens to carry no `+`/`-` lines, so
  // the empty-shape rule caught it — and a rename WITH a version hunk therefore
  // slipped through as version-only. Found by the release panel (codex lane,
  // 2026-08-10, round 2); the case is below.
  assert.equal(whyGated(only), 'fail-closed: rename to (a change the hunks do not show)')
})

test('a rename or a mode flip beside a version hunk still requires the panel', () => {
  // The twin the case above was missing. Each of these carries content lines
  // that blank to the same text, so the version-only rule answered EXEMPT while
  // a shipped file was renamed or made executable.
  const withHunk = (metadata) => parseDiff([
    'diff --git a/plugins/tmux-teams/plugin.json b/plugins/tmux-teams/plugin.json',
    ...metadata,
    '--- a/plugins/tmux-teams/plugin.json',
    '+++ b/plugins/tmux-teams/plugin.json',
    '@@ -4 +4 @@',
    '-  "version": "0.18.2",',
    '+  "version": "0.19.0",',
    '',
  ].join('\n'))[0]

  assert.match(whyGated(withHunk(['old mode 100644', 'new mode 100755'])), /^fail-closed: new mode/)
  assert.match(whyGated(withHunk([
    'similarity index 98%',
    'rename from plugins/tmux-teams/old.json',
    'rename to plugins/tmux-teams/plugin.json',
  ])), /^fail-closed: rename to/)

  // The control: the same file, the same version movement, no metadata. This
  // one IS exempt, which is what makes the two above meaningful.
  assert.equal(whyGated(withHunk([])), null)
})

test('a semver inside a URL is not a version bump, even in a version-carrying file', () => {
  // `plugins/tmux-teams/plugin.json` is on VERSION_FILES because it declares the
  // release version — and it ALSO carries
  // `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`.
  // Blanking every semver in that file therefore exempted a changed manifest
  // schema, a shipped contract, as a plain version bump. Measured: `whyGated`
  // answered null. Found by the release panel (codex lane, 2026-08-10, round 3),
  // one round after the same lane caught the file-wide version of this.
  const schemaBump = file(
    'plugins/tmux-teams/plugin.json',
    ['  "$schema": "https://agent-plugins.org/schemas/9.99.0/plugin.schema.json",'],
    ['  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",'],
  )
  assert.equal(whyGated(schemaBump), 'changes more than the version string')

  // The three real shapes must all still be exempt, or the narrowing has eaten
  // the exemption it was meant to keep.
  assert.equal(whyGated(file('plugins/tmux-teams/plugin.json',
    ['  "version": "0.19.0",'], ['  "version": "0.18.2",'])), null)
  assert.equal(whyGated(file('tests/plugin-structure.test.mjs',
    ["const RELEASE_VERSION = '0.19.0'"], ["const RELEASE_VERSION = '0.18.2'"])), null)
  assert.equal(whyGated(file('.claude-plugin/marketplace.json',
    ['    "version": "0.19.0"'], ['    "version": "0.18.2"'])), null)
})

test('a semver that is not THIS release version does not buy an exemption', () => {
  // `blankVersions` used to blank every `x.y.z` in every file, so a shipped
  // dependency pin moving two major versions read as a plain version bump and
  // the gate exempted it. Measured before the fix: `whyGated` answered null.
  // Found by the release panel (codex lane, 2026-08-10, round 2); the zai lane
  // raised the same class for dot-dates and IP literals.
  const pin = file(
    'plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs',
    ["const ADAPTER = '@agentclientprotocol/claude-agent-acp@9.99.0'"],
    ["const ADAPTER = '@agentclientprotocol/claude-agent-acp@0.61.0'"],
  )
  assert.equal(whyGated(pin), 'changes more than the version string')

  // And the exemption still works where it is meant to: the files that carry
  // the RELEASE version, which are the only ones the bump touches.
  for (const path of ['tests/plugin-structure.test.mjs', '.claude-plugin/marketplace.json']) {
    assert.equal(whyGated(file(path, [`  "version": "0.19.0",`], [`  "version": "0.18.2",`])), null, path)
  }
})
