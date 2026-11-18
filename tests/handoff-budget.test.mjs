// handoff-budget.test.mjs — the handoff skill's size budget, rotation,
// one-owner-one-block and cross-owner rules, pinned semantically so deleting
// the mechanism fails the suite rather than riding through as a prose edit.
// Run: node --test
//
// The measurement behind it, 2026-10-30: one project's HANDOFF.md reached
// 2,052,245 bytes / 4,514 lines (~454 bytes per line) — eight role-lanes
// each appending a full pre-compaction dump, each block claiming to
// supersede the previous one while physically leaving it in place. An
// archive-once on 2026-10-11 moved 1.7 MB to docs/history/ and the live
// file regrew to 2 MB by 2026-10-29, because writer behaviour never
// changed. ADR 0009 records the decision these anchors guard.
//
// Anchors match on whitespace-normalized text: a prose reflow that changes
// no meaning must not fail the suite (panel round 1, agy + claude lanes,
// 2026-11-19). The rules themselves are pinned, not the line breaks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = readFileSync(join(ROOT, 'plugins/tmux-teams/skills/handoff/SKILL.md'), 'utf8')
const ADR = readFileSync(join(ROOT, 'plugins/tmux-teams/docs/adr/0009-handoff-carries-a-size-budget.md'), 'utf8')

const norm = (s) => s.replace(/\s+/g, ' ').trim()

// The text of one `## ` section, and nothing else. `wc -c HANDOFF.md` now
// appears in several places in the skill, so a whole-file includes() cannot
// say WHICH section carries the obligation — the same lesson the
// `Cast 3-5 named voices` finder taught in plugin-structure.test.mjs.
const section = (title) => {
  const start = SKILL.indexOf(`## ${title}`)
  assert.ok(start !== -1, `the skill has no "## ${title}" section`)
  const rest = SKILL.slice(start + 1)
  const next = rest.indexOf('\n## ')
  return next === -1 ? SKILL.slice(start) : SKILL.slice(start, start + 1 + next)
}

const has = (hay, phrase, msg) => assert.ok(norm(hay).includes(norm(phrase)), msg)

test('the budget is stated in bytes: 32 KiB target, 48 KiB hard ceiling, measured with wc -c', () => {
  const budget = section('The file has a budget')
  has(budget, '**32 KiB target (32,768 bytes), 48 KiB hard ceiling (49,152 bytes)**',
    'the budget numbers are gone — an instruction with no ceiling is read as a preference')
  has(budget, 'a file over the ceiling never stays written',
    'the hard ceiling no longer refuses to let an over-ceiling write stand')
  has(budget, 'a post-write measure over the ceiling does not stand — rotate, then write smaller',
    'the post-write rule is gone — measuring after writing with no consequence is theater')
  has(budget, '`wc -c HANDOFF.md` before composing and again after writing',
    'the measure command is gone — a budget nobody measures is a budget nobody kept')
  has(budget, 'rotate first',
    'the rotation trigger is gone — without it the file grows to the ceiling and stays')
})

test('rotation names its destination: docs/history/handoff-archive-YYYYMMDD.md', () => {
  const budget = section('The file has a budget')
  has(budget, '`docs/history/handoff-archive-YYYYMMDD.md`',
    'the archive path template is gone, so rotation has nowhere defined to go')
  has(budget, "that date's file, appended, created if absent",
    'the append-or-create rule is gone — two writers must not fork the archive')
  has(budget, '### [PR] attestation rules → archived 2026-10-30: docs/history/handoff-archive-20261030.md',
    'the pointer example is gone or bare — an unheaded example teaches the exact form the skill forbids')
  has(budget, 'ONE headed pointer per tag and archive file',
    'consolidation no longer preserves per-tag addressability — folded pointers must stay headed blocks')
  has(budget, 'carry every pointer line your previous block held into your new block',
    'the carry-forward rule is gone — a rewrite deletes its own block\'s pointers and orphans the archive')
  has(budget, 'cold storage',
    'archives are no longer declared cold storage, so a session will read one whole')
  has(budget, 'pass a few KiB, consolidate them',
    'the pointer-consolidation rule is gone — pointer lines grow unbounded on long-lived projects')
})

test('one owner, one block: tagged, bounded, previous block deleted, other owners untouched', () => {
  const budget = section('The file has a budget')
  has(budget, '### One owner, one block',
    'the one-owner-one-block heading is gone')
  has(budget, 'Head your block with your owner tag and make the heading its boundary',
    'the owner tag and block boundary are undefined — physical replacement and the grep proof are not actionable')
  has(budget, 'ONE live, non-pointer block per section',
    'the one-block rule lost its live/non-pointer scope — archived and sidecar pointer headings are blocks too')
  has(budget, 'a block is one `### [<tag>] <what>` heading plus the lines under it, ending at the next `##` or `###` heading',
    'the block boundary is no longer the heading — owners cannot tell where their block ends')
  has(budget, 'the tag is the same every time',
    'the tag stability rule is gone — an unstable tag makes "grep your tag" useless')
  has(budget, 'writing a new version of your block physically deletes your previous one from the file',
    'the delete-your-previous-block rule is gone — this is the rule the eight-lane file died of')
  has(budget, "Never delete or rewrite another owner's live block",
    "the never-touch-another-owner's-block rule is gone or lost its live qualifier — the ADR says live")
  has(budget, '`.pm/<owner>/HANDOFF-YYYYMMDD-HHMM.md`',
    'the sidecar path for full pre-compaction dumps is gone')
  has(budget, 'snapshots live in sidecars, state lives here',
    'the snapshots-vs-state boundary is gone')
})

test('cross-owner deadlock closed: superseded blocks move verbatim; otherwise sidecar and escalate', () => {
  const budget = section('The file has a budget')
  has(budget, "Another owner's SUPERSEDED block may be moved, never edited",
    'the verbatim-move rule is gone — the writer the 2 MB file trapped has no escape path')
  has(budget, 'byte-for-byte, nothing rewritten, summarised or shortened',
    'the verbatim definition is gone — "moved" without "verbatim" invites silent rewriting')
  has(budget, 'leaving the original heading in place as the pointer line',
    'the pointer-heading rule is gone — a bare pointer line is swallowed by the block above it and orphaned with its rewrite')
  has(budget, '`### [<tag>] <what> → archived YYYY-MM-DD: <path>`',
    'the pointer-line form is gone — pointers without a heading are not blocks')
  has(budget, 'A bare pointer line with no heading',
    'the bare-pointer prohibition is gone — pointer lines get absorbed into the previous owner\'s block')
  has(budget, 'Moving superseded bytes is not rewriting them',
    'the move-vs-rewrite boundary is gone — the two rules contradict without it')
  has(budget, 'do not write past it: put your new state in your sidecar, leave one pointer line',
    'the writer escape is gone — an owner who cannot fit under the ceiling has nowhere to put its state')
  has(budget, 'the same heading turned into `### [<tag>] <what> → sidecar: <path>`',
    'the escape pointer has no sidecar marker — a mover cannot tell a pointer heading from a live block')
  has(budget, 'A pointer heading is any `### [<tag>]` heading carrying `→ archived` or `→ sidecar`',
    'pointer heading is undefined — the newest rule and the grep proof both scope against it')
  has(budget, 'the sidecar alone holds the state and the compaction request carries the pointer',
    'the near-ceiling corner is unhandled — even a pointer line can cross the ceiling')
  has(budget, 'your previous block stays in the file untouched',
    'the near-ceiling corner no longer names the fate of the writer\'s previous block')
  has(budget, 'the last non-pointer `### [<tag>]` heading in the section',
    'newest is no longer defined by what the file shows — "written last" is invisible to a static file')
  has(budget, 'never fold another owner\'s pointers',
    'the consolidation ownership rule is gone — folding another owner\'s pointers rewrites protected bytes')
  has(budget, 'If the sidecar lives under a gitignored path, its pointer line says so',
    'the gitignored-sidecar disclosure is gone — a committed pointer to machine-local state strands other machines')
})

test('inheriting a bloated file reads 2 KiB of section 1 plus headers, and puts compaction first', () => {
  const budget = section('The file has a budget')
  has(budget, '### Inheriting a bloated file',
    'the inheriting-a-bloated-file guard is gone')
  has(budget, 'over the ceiling (measure with `wc -c` — never trust how it scrolls)',
    'the ceiling check for an inherited file is gone — scrolling is not a measurement')
  has(budget, 'Read the first 2 KiB of section 1 and the headers',
    'the reader guard no longer bounds section 1 — a bloated READ THIS FIRST defeats the guard')
  has(budget, '`grep \'^## \' HANDOFF.md`',
    'the headers-only read command is gone')
  has(budget, '"compact the handoff" in front of the user as the first order of business',
    'compaction is no longer the first order of business before the real work')
  has(budget, '2 MB of superseded state',
    'the reason for the guard is gone — a session that swallows the file pays for every block it never acts on')
})

test('the room brief carries the budget as a fact', () => {
  const room = section('Run it through the room')
  has(room, '`wc -c HANDOFF.md` figure and the 32 KiB target as facts of the brief',
    'the room no longer receives the current size and the target as facts of its brief')
  has(room, 'rotates to the archive instead of staying',
    'the room can no longer rotate what cannot justify its bytes')
})

test('READ THIS FIRST carries a byte cap beside the line limit', () => {
  const sections = section('The sections, in this order')
  has(sections, 'ten lines and 2 KiB, hard limits',
    'the 2 KiB cap on READ THIS FIRST is gone — ten long lines is not ten lines')
})

test('"Before you finish" reports the byte count, resolves pointers, and commits archives together', () => {
  const finish = section('Before you finish')
  has(finish, 'Report the `wc -c HANDOFF.md` result',
    'the finish checklist no longer reports the measured size')
  has(finish, 'above 48 KiB (target 32)',
    'the finish checklist no longer refuses to call the file done above the ceiling')
  has(finish, 'Every archive pointer line resolves to a file that exists — archive and sidecar alike',
    'the archive-pointer resolution check is gone or no longer covers sidecars')
  has(finish, 'a pointer marked machine-local (a gitignored sidecar) is skipped on machines that do not hold the sidecar, not failed',
    'the machine-local pointer exception is gone — a committed gitignored sidecar pointer fails the check on every other machine')
  has(finish, "`grep -nE '^### \\[<tag>\\]' HANDOFF.md | grep -vE '→ (archived|sidecar)'` returns at most one hit per section, your live block",
    'the grep proof is gone or unscoped — archived and sidecar pointer headings share the tag and would fail an honest writer')

  has(finish, 'commit it in the same commit as the archive file any rotation created',
    'the commit-together rule is gone — a pointer committed alone resolves to nothing on another machine')
})

test('the grep proof runs the real pipeline over a fixture with archived and sidecar pointer headings', (t) => {
  // Runs the skill's actual pipeline over a fixture holding a live block
  // AND both pointer-heading kinds under the same tag — the round-3/4
  // cross-owner scenario that broke earlier proofs. Real grep, not a JS
  // stand-in, so a regression in the prescribed command shape is caught
  // behaviorally; reported as SKIP, never PASS, where it cannot run.
  if (!['linux', 'darwin'].includes(process.platform)) return t.skip('grep pipeline is POSIX-only')
  const dir = mkdtempSync(join(tmpdir(), 'hb-grep-fixture-'))
  try {
    const file = join(dir, 'HANDOFF.md')
    writeFileSync(file, [
      '### [DBA] live block',
      'current state lines',
      '### [DBA] older rules → archived 2026-11-19: docs/history/handoff-archive-20261119.md',
      '### [DBA] parked state → sidecar: .pm/dba/HANDOFF-20261119-0900.md',
      '### [MD] another owner live',
      '',
    ].join('\n'))
    const out = execFileSync('sh', [
      '-c',
      `grep -nE '^### \\[DBA\\]' '${file}' | grep -vE '→ (archived|sidecar)'`,
    ], { encoding: 'utf8' })
    const hits = out.trim().split('\n').filter((l) => l !== '')
    assert.equal(hits.length, 1,
      'the prescribed pipeline does not return at most one hit — pointer headings still fail an honest writer')
    assert.match(hits[0], /live block/,
      'the single surviving hit is not the live block — the proof points at the wrong block')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADR 0009 records the 2 KiB cap, the tooling tripwire, and agrees with the skill on ownership', () => {
  has(ADR, 'READ THIS FIRST capped at ten lines and 2 KiB',
    'the ADR no longer records the 2 KiB cap — a decision document that omits a rule invites relitigation')
  has(ADR, 'the tooling exclusion reverses and the ceiling becomes a mechanical check',
    'the tooling tripwire is gone — nothing answers the writers-ignore-the-ceiling repeat')
  has(ADR, "Another owner's SUPERSEDED block may be moved VERBATIM to the archive — move is not rewrite",
    'the ADR still carries the unqualified round-1 prohibition — the decision record contradicts the skill word for word')
  has(ADR, "the writer parks its state in the sidecar — the previous block's heading becomes the `→ sidecar` pointer — and puts \"compact the handoff\" in front of the user",
    'the ADR omits the sidecar+escalate escape — the decision record and the skill disagree on the deadlock answer')
  has(ADR, "the detail's original tagged heading, turned into the pointer",
    'the ADR rotation bullet omits the pointer-heading requirement — the record predates the round-2 fix')
  has(ADR, 'machine-local sidecar pointers are skipped on machines that do not hold the sidecar',
    'the ADR consequences omit the machine-local pointer exception — the record and the skill disagree again')
  has(ADR, "`grep -nE '^### \\[<tag>\\]' HANDOFF.md | grep -vE '→ (archived|sidecar)'`: at most one hit per section, the writer's live block",
    'the ADR consequences still carry a retired grep proof — the decision record and the skill disagree on the finish check')
})
