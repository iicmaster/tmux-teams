// gate-required.mjs — decides whether a release must run the three-model
// review panel, from the release diff alone. See CLAUDE.md "Release flow"
// step 2. Master's decision, 2026-08-09: the gate is scoped, not retired.
//
// Why this script exists rather than a sentence: the rule it replaces said
// three model families must read every release diff, and v0.18.1 and v0.18.2
// shipped without a single lane. Nobody cheated — the gate charged its full
// price for a version bump and a documentation edit, so it got skipped, and a
// rule skipped twice in a row is not a rule. The scoped rule only stays true
// if "does this release need the panel" is answered by `git diff` instead of
// by whoever is holding the release.
//
// THE CLASSIFIER FAILS CLOSED. Every changed file requires the panel unless
// it can be PROVEN harmless, and there are exactly two proofs:
//
//   1. The file is one of the repo's own documentation files (DOC_ONLY), none
//      of which reach an installed plugin.
//   2. Every changed line in it is identical to its counterpart once semver
//      numbers are blanked — i.e. the diff changes the version and nothing
//      else. This is what lets a version bump touch a real test file
//      (`tests/plugin-structure.test.mjs` carries RELEASE_VERSION) without
//      dragging the whole panel along, while a semantic edit smuggled onto a
//      line that happens to mention a version still trips it.
//
// Anything the parser cannot read as +/- content lines — a binary file, a
// pure rename, an empty diff — produces NO proof and therefore REQUIRES the
// panel. That is deliberate: an unrecognized change shape is the one case
// where guessing is worst.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')

// Repository documentation. None of these are inside `plugins/`, so none of
// them reach an installed plugin — a reader of the release is the only thing
// they can change. `docs/` is deliberately absent: it is untracked in this
// repo (see CLAUDE.md Rules), so it can never appear in a release diff, and
// listing it would be a guard against something that cannot happen.
export const DOC_ONLY = new Set(['HANDOFF.md', 'README.md', 'CLAUDE.md'])

// Release semver only — no pre-release suffix. A `-rc1` therefore does NOT
// blank to the same text as the release it replaces, `sameLines` disagrees, and
// the panel is required. That is the safe direction of being wrong, and it is
// deliberate rather than overlooked (raised as non-blocking by the release
// panel, AGY lane, 2026-08-10). Widen it only alongside a case that proves the
// widened pattern still cannot swallow a semantic change.
// The SIX places the release flow bumps, and the ONLY files where a changed
// semver may be read as "just the version". Everything else with an `x.y.z` in
// it goes to the panel.
//
// Blanking every `x.y.z` in every file was a bypass, not a convenience: a
// shipped dependency pin moving from `@agentclientprotocol/claude-agent-acp@0.61.0`
// to `@9.99.0` blanked to the same line as its predecessor and classified as
// version-only — a behavioural change to what the plugin LAUNCHES, exempted by
// the thing that exists to catch it. Measured, not argued (`whyGated` answered
// `null`). Found by the release panel (codex lane, 2026-08-10, round 2).
//
// A seventh place will appear — five have already, each found by a reader
// rather than by the flow — and until it is added here its bump requires the
// panel. That is the safe direction, and it is the direction this list is
// wrong in on purpose.
export const VERSION_FILES = new Set([
  '.claude-plugin/marketplace.json',
  'plugins/tmux-teams/.claude-plugin/plugin.json',
  'plugins/tmux-teams/plugin.json',
  'tests/plugin-structure.test.mjs',
  // README.md is deliberately NOT here. It carries the version in prose, but it
  // is already in DOC_ONLY and that check runs first, so an entry here would be
  // unreachable — a line a reader would maintain believing it decided
  // something. Raised as non-blocking by the release panel (zai lane,
  // 2026-08-10, round 4). The "six places" the release flow bumps is a count of
  // string positions, not of files: `marketplace.json` carries two.
])

// Release semver only — no pre-release suffix. A `-rc1` therefore does NOT
// blank to the same text as the release it replaces, `sameLines` disagrees, and
// the panel is required. That is the safe direction of being wrong, and it is
// deliberate rather than overlooked (raised as non-blocking by the release
// panel, AGY lane, 2026-08-10). Widen it only alongside a case that proves the
// widened pattern still cannot swallow a semantic change.
const SEMVER = /\d+\.\d+\.\d+/g

// Blank every semver, then compare the added and removed lines as MULTISETS —
// sorted, length-checked. A multiset and not a Set: two identical lines both
// changing is a different diff from one changing, and a Set would call them
// equal.
// A line only gets its semver blanked when it is DECLARING a version, and a URL
// never is. `plugins/tmux-teams/plugin.json` carries
// `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`, so
// blanking every semver in every VERSION_FILES member exempted a changed
// manifest schema — a shipped contract — as a plain version bump. Measured:
// `whyGated` answered null. Found by the release panel (codex lane, 2026-08-10,
// round 3), one round after the same lane caught the wider version of this.
// All six real places name themselves: `"version": "x.y.z"`,
// `const RELEASE_VERSION = 'x.y.z'`, `Current release: **x.y.z**`.
// The EXACT shapes the release flow bumps, anchored end to end. Nothing else in
// a version file gets its semver blanked.
//
// This was `/version|release/i` plus a "no URL on the line" guard, and both
// halves were wrong. The loose pattern matched `"protocol_version": "1.0.0"` —
// a shipped manifest field — and exempted a change to it. The URL guard was
// never exercised at all: the `$schema` fixture written to test it contains
// neither `version` nor `release`, so the first half rejected the line before
// the second half was consulted, and deleting the URL guard entirely left every
// test in this file green. A guard nothing runs and a pattern that matches too
// much, shipped together, found by the release panel (codex lane, 2026-08-10,
// round 4) in the fix for the round-3 version of the same defect.
//
// Anchored patterns need no URL guard: a URL cannot match either of them.
// A seventh bump site will appear — five have already — and until its shape is
// listed here its bump requires the panel. That is the safe direction.
// PER FILE, not one pool. A generic pool let the JSON shape be accepted inside
// `tests/plugin-structure.test.mjs`, which is executable and full of fixture
// lines — so changing a fixture's `"version": "1.0.0"` to `"9.99.0"` classified
// as a release bump and was exempt, and the test written for this file asserted
// that exempt answer. Found by the release panel (codex lane, 2026-08-10,
// round 7). Each file declares its version in exactly one shape; anything else
// in it, in any shape, is a change and goes to the panel.
// EXACT lines, indentation included, because `^\s*"version"...$` accepted any
// nested `"version"` field anywhere in a manifest — so a semantic version on a
// dependency or a sub-object could change and exempt the release. Found by the
// release panel (codex lane, 2026-08-10, round 8), one round after the shapes
// were bound per file and two after they stopped being a single loose regex.
// Each entry is the literal line that file carries, and a bump that does not
// match one of them requires the panel: the safe direction, and the one every
// narrowing of this list has moved in.
const VERSION_DECLARATIONS = new Map([
  ['.claude-plugin/marketplace.json', [
    /^ {4}"version": "\d+\.\d+\.\d+"$/,
    /^ {6}"version": "\d+\.\d+\.\d+",$/,
  ]],
  ['plugins/tmux-teams/.claude-plugin/plugin.json', [/^ {2}"version": "\d+\.\d+\.\d+",$/]],
  ['plugins/tmux-teams/plugin.json', [/^ {2}"version": "\d+\.\d+\.\d+",$/]],
  ['tests/plugin-structure.test.mjs', [/^const RELEASE_VERSION = '\d+\.\d+\.\d+'$/]],
])
const declaresAVersion = (path, line) =>
  (VERSION_DECLARATIONS.get(path) ?? []).some((shape) => shape.test(line))
const blankVersions = (path, lines) => lines
  .map((line) => (declaresAVersion(path, line) ? line.replace(SEMVER, '<version>') : line))
  .sort()

const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i])

/**
 * Why this one file forces the panel, or null when it is provably harmless.
 * Pure: takes parsed lines, reads nothing, spawns nothing.
 */
export function whyGated(file) {
  // A mode flip, a rename or a copy is a structural change the hunks do not
  // show. Paired with a version hunk in the same file it used to read as a
  // plain version bump — a renamed shipped executable, or `100644` to `100755`,
  // exempted. Found by the release panel (codex lane, 2026-08-10, round 2).
  //
  // Checked BEFORE the documentation allowlist, and the order is the guard.
  // With `DOC_ONLY` first, a diff that RENAMES a shipped script to `README.md`
  // and edits it on the way parses as `path: README.md` plus a rename, and the
  // allowlist exempted the whole thing — a behavioural release with no review,
  // reachable from one `git mv`. Found by the release panel (codex lane,
  // 2026-08-10, round 5). Nothing on the allowlist is ever legitimately
  // renamed or chmod'd during a release, so the reordering costs nothing real.
  if (file.structural) return `fail-closed: ${file.structural}`

  if (DOC_ONLY.has(file.path)) return null

  if (file.addedLines.length === 0 && file.removedLines.length === 0) {
    return 'fail-closed: unrecognized change shape (binary, rename, or empty diff)'
  }

  // Only a file that CARRIES the release version can ever be exempt. Everything
  // else that changed at all goes to the panel, with no comparison of any kind.
  //
  // The comparison used to run on every file, and because it sorts both sides
  // before comparing them, a pure REORDER was exempt: same lines added as
  // removed, so the multisets matched. Swap `releaseClaimsSettledInLedger(repo,
  // items)` with `const pulse = busyAgents(repo)` in `loop-runner.mjs` — which
  // is precisely how the defect this release exists to fix comes back — and the
  // gate answered EXEMPT. Measured before this was written. Found by the release
  // panel (AGY lane, 2026-08-10, round 4); it had been there since the script
  // was written and survived three earlier rounds.
  //
  // Sorting is kept for the version files, where it is the point: two identical
  // lines both moving is a different diff from one moving, which a Set would
  // miss. A reorder inside those five files still exempts, and that is bounded
  // and acceptable — they are two JSON manifests, a test constant and a README
  // line, none of which have execution order.
  if (!VERSION_FILES.has(file.path)) return 'changes more than the version string'

  // EVERY changed line in a version file has to BE a version declaration. The
  // comparison sorts before comparing, so without this a file on the list could
  // have its lines reordered and still classify as version-only — and one of
  // the five is `tests/plugin-structure.test.mjs`, which is executable, so a
  // semantic reorder plus a version bump would ship unreviewed. Found by the
  // release panel (codex lane, 2026-08-10, round 6), one round after the same
  // sort-and-compare was closed for every OTHER file.
  const everyLine = [...file.addedLines, ...file.removedLines]
  if (!everyLine.every((line) => declaresAVersion(file.path, line))) return 'changes more than the version string'

  const added = blankVersions(file.path, file.addedLines)
  const removed = blankVersions(file.path, file.removedLines)
  if (!sameLines(added, removed)) return 'changes more than the version string'
  return null
}

/**
 * The whole verdict. `files` is [{path, addedLines, removedLines}].
 */
export function classifyRelease(files) {
  // No files at all is not "nothing to review" — it is a range that resolved to
  // nothing, a parser that understood nothing, or a diff shape this script
  // cannot read. Per-file that shape is already fail-closed (`whyGated`); the
  // whole-release case answered EXEMPT and exited 0, which is a gate bypass at
  // the one place the decision is made. Found by the release panel (codex lane,
  // 2026-08-10).
  if (files.length === 0) {
    return {
      required: true,
      deciding: [{ path: '(whole release)', reason: 'fail-closed: the diff for this range parsed to no files at all' }],
      exempt: [],
    }
  }
  const deciding = []
  for (const file of files) {
    const reason = whyGated(file)
    if (reason !== null) deciding.push({ path: file.path, reason })
  }
  return {
    required: deciding.length > 0,
    deciding,
    exempt: files.filter((file) => whyGated(file) === null).map((file) => file.path),
  }
}

/**
 * Parse `git diff --unified=0` output into the shape classifyRelease wants.
 * `--unified=0` so no context line is ever mistaken for a change.
 */
// `deleted file mode` and `new file mode` are deliberately absent: a creation
// or a deletion carries the WHOLE file as `+`/`-` lines, so the content
// comparison already gates it and neither shape can hide beside a version hunk
// as version-only. The six here are the ones that can. Written down because a
// release reviewer read the omission and had to reason it out (zai lane,
// 2026-08-10, round 3).
const STRUCTURAL = ['old mode ', 'new mode ', 'rename from ', 'rename to ', 'copy from ', 'copy to ']

export function parseDiff(text) {
  const files = []
  let current = null
  // A `+++ `/`--- ` line is a HEADER only before the first `@@` of a file.
  // Inside a hunk the same bytes are an added line whose own content starts
  // with `++ ` — and reading that as a header both renamed the file and DROPPED
  // the line, so a real source change under `plugins/` classified as
  // version-only and the gate exempted it. Found by the release panel
  // (codex lane, 2026-08-10) and reproduced before this was written.
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      current = { path: match ? match[2] : line, addedLines: [], removedLines: [], structural: null }
      files.push(current)
      inHunk = false
      continue
    }
    if (current === null) continue
    if (line.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk) {
      // Extended headers git writes before the first hunk. They describe a
      // change the +/- lines cannot show, so they are recorded rather than
      // skipped past.
      const structural = STRUCTURAL.find((prefix) => line.startsWith(prefix))
      if (structural) { current.structural = `${structural.trim()} (a change the hunks do not show)`; continue }
    }
    // The +++/--- header checks MUST come before the +/- content checks, and
    // only outside a hunk.
    if (!inHunk && line.startsWith('+++ ')) {
      const path = line.slice(4)
      if (path !== '/dev/null') current.path = path.replace(/^b\//, '')
    } else if (!inHunk && line.startsWith('--- ')) {
      continue
    } else if (line.startsWith('+')) {
      current.addedLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      current.removedLines.push(line.slice(1))
    }
  }
  return files
}

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

export function releaseRange() {
  return `${git(['describe', '--tags', '--abbrev=0']).trim()}..HEAD`
}

// Exit codes are DISTINCT on purpose, and 1 is not one of the verdicts. This
// repo has already been burned once by a check whose exit code meant the
// opposite of what a `&&` chain assumed (`node --test | grep '✖'` exits 0 when
// it FINDS failures, and two commits landed on red because of it).
//   0 = exempt · 2 = panel required · 1 = the script itself failed
const EXIT_EXEMPT = 0
const EXIT_REQUIRED = 2
const EXIT_ERROR = 1

function main(argv) {
  let range
  try {
    range = argv[2] ?? releaseRange()
  } catch (error) {
    console.error(`gate-required: could not resolve the release range — ${error.message}`)
    return EXIT_ERROR
  }

  let files
  try {
    files = parseDiff(git(['diff', '--unified=0', range]))
  } catch (error) {
    console.error(`gate-required: could not read the diff for ${range} — ${error.message}`)
    return EXIT_ERROR
  }

  const verdict = classifyRelease(files)
  console.log(`range: ${range}  ·  files changed: ${files.length}`)

  if (!verdict.required) {
    console.log('')
    console.log('GATE EXEMPT — documentation and version numbers only.')
    console.log('Put this line in the GitHub release notes, verbatim:')
    console.log('')
    console.log(`    Gate: exempt (docs/version-only) — ${verdict.exempt.join(', ') || 'no files changed'}`)
    return EXIT_EXEMPT
  }

  console.log('')
  console.log(`GATE REQUIRED — ${verdict.deciding.length} file(s) decide it:`)
  for (const { path, reason } of verdict.deciding) console.log(`    ${path} — ${reason}`)
  console.log('')
  console.log('Run the three-model panel on this diff before the version is marked')
  console.log('(CLAUDE.md "Release flow" step 2), then record:')
  console.log('')
  console.log('    Gate: 3/3 — <lane>:<effective_identity> for every lane')
  return EXIT_REQUIRED
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
