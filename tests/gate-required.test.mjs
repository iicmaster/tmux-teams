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

test('the documentation allowlist is exempt whatever it says', () => {
  for (const path of DOC_ONLY) {
    assert.equal(whyGated(file(path, ['anything at all'], [])), null, path)
  }
})

test('nothing inside plugins/ is on the documentation allowlist', () => {
  // A guard on the guard: the exemption is only defensible because none of
  // these files reach an installed plugin.
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

test('an empty release is exempt and says so without crashing', () => {
  const verdict = classifyRelease([])
  assert.equal(verdict.required, false)
  assert.deepEqual(verdict.exempt, [])
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
  assert.equal(whyGated(only), 'fail-closed: unrecognized change shape (binary, rename, or empty diff)')
})
