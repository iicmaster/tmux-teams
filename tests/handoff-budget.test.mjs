// handoff-budget.test.mjs — the handoff skill's size budget, rotation and
// one-owner-one-block rules, pinned semantically so deleting the mechanism
// fails the suite rather than riding through as a prose edit. Run: node --test
//
// The measurement behind it, 2026-10-30: one project's HANDOFF.md reached
// 2,052,245 bytes / 4,514 lines (~454 bytes per line) — eight role-lanes
// each appending a full pre-compaction dump, each block claiming to
// supersede the previous one while physically leaving it in place. An
// archive-once on 2026-10-11 moved 1.7 MB to docs/history/ and the live
// file regrew to 2 MB by 2026-10-29, because writer behaviour never
// changed. ADR 0009 records the decision these anchors guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = readFileSync(join(ROOT, 'plugins/tmux-teams/skills/handoff/SKILL.md'), 'utf8')

// The text of one `## ` section, and nothing else. `wc -c HANDOFF.md` now
// appears in three places in the skill, so a whole-file includes() cannot
// say WHICH section carries the obligation — the same lesson the
// `Cast 3-5 named voices` finder taught in plugin-structure.test.mjs.
const section = (title) => {
  const start = SKILL.indexOf(`## ${title}`)
  assert.ok(start !== -1, `the skill has no "## ${title}" section`)
  const rest = SKILL.slice(start + 1)
  const next = rest.indexOf('\n## ')
  return next === -1 ? SKILL.slice(start) : SKILL.slice(start, start + 1 + next)
}

test('the budget is stated in bytes: 32 KiB target, 48 KiB hard ceiling, measured with wc -c', () => {
  const budget = section('The file has a budget')
  assert.ok(budget.includes('**32 KiB target, 48 KiB hard ceiling**'),
    'the budget numbers are gone — an instruction with no ceiling is read as a preference')
  assert.ok(budget.includes('a file over\nthe ceiling is never written'),
    'the hard ceiling no longer refuses to write')
  assert.ok(budget.includes('`wc -c HANDOFF.md` before\ncomposing and again after writing'),
    'the measure command is gone — a budget nobody measures is a budget nobody kept')
  assert.ok(budget.includes('rotate first'),
    'the rotation trigger is gone — without it the file grows to the ceiling and stays')
})

test('rotation names its destination: docs/history/handoff-archive-YYYYMMDD.md', () => {
  const budget = section('The file has a budget')
  assert.ok(budget.includes('`docs/history/handoff-archive-YYYYMMDD.md`'),
    'the archive path template is gone, so rotation has nowhere defined to go')
  assert.ok(budget.includes('that date\'s file, appended,\ncreated if absent'),
    'the append-or-create rule is gone — two writers must not fork the archive')
  assert.ok(budget.includes('- PR attestation rules → archived 2026-10-30: docs/history/handoff-archive-20261030.md'),
    'the one-pointer-line example is gone — without it a rotation leaves either nothing or everything')
  assert.ok(budget.includes('cold storage'),
    'archives are no longer declared cold storage, so a session will read one whole')
})

test('one owner, one block: the previous block is deleted and other owners are untouched', () => {
  const budget = section('The file has a budget')
  assert.ok(budget.includes('### One owner, one block'),
    'the one-owner-one-block heading is gone')
  assert.ok(budget.includes('writing a new version of your block physically\ndeletes your previous one from the file'),
    'the delete-your-previous-block rule is gone — this is the rule the eight-lane file died of')
  assert.ok(budget.includes('Never delete or rewrite another\nowner\'s block'),
    'the never-touch-another-owner\'s-block rule is gone')
  assert.ok(budget.includes('`.pm/<owner>/HANDOFF-YYYYMMDD-HHMM.md`'),
    'the sidecar path for full pre-compaction dumps is gone')
  assert.ok(budget.includes('snapshots live in\nsidecars, state lives here'),
    'the snapshots-vs-state boundary is gone')
})

test('inheriting a bloated file reads headers, not the whole file, and puts compaction first', () => {
  const budget = section('The file has a budget')
  assert.ok(budget.includes('### Inheriting a bloated file'),
    'the inheriting-a-bloated-file guard is gone')
  assert.ok(budget.includes("over the ceiling (measure with `wc -c` — never\ntrust how it scrolls)"),
    'the ceiling check for an inherited file is gone — scrolling is not a measurement')
  assert.ok(budget.includes("`grep '^## ' HANDOFF.md`"),
    'the headers-only read command is gone')
  assert.ok(budget.includes('"compact the handoff" in front of the\nuser as the first order of business'),
    'compaction is no longer the first order of business before the real work')
  assert.ok(budget.includes('2 MB of superseded state'),
    'the reason for the guard is gone — a session that swallows the file pays for every block it never acts on')
})

test('the room brief carries the budget as a fact', () => {
  const room = section('Run it through the room')
  assert.ok(room.includes('`wc -c HANDOFF.md` figure and the 32 KiB target as facts of the brief'),
    'the room no longer receives the current size and the target as facts of its brief')
  assert.ok(room.includes('rotates to the archive instead of staying'),
    'the room can no longer rotate what cannot justify its bytes')
})

test('READ THIS FIRST carries a byte cap beside the line limit', () => {
  const sections = section('The sections, in this order')
  assert.ok(sections.includes('ten lines and 2 KiB, hard limits'),
    'the 2 KiB cap on READ THIS FIRST is gone — ten long lines is not ten lines')
})

test('"Before you finish" reports the byte count and refuses done above the ceiling', () => {
  const finish = section('Before you finish')
  assert.ok(finish.includes('Report the `wc -c HANDOFF.md` result'),
    'the finish checklist no longer reports the measured size')
  assert.ok(finish.includes('above 48 KiB (target 32)'),
    'the finish checklist no longer refuses to call the file done above the ceiling')
  assert.ok(finish.includes('Every archive pointer line resolves to a file that exists'),
    'the archive-pointer resolution check is gone')
  assert.ok(finish.includes('grep your tag'),
    'the prove-your-old-blocks-are-gone check is gone — claiming deletion is not deleting')
})
