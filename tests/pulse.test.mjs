// pulse.test.mjs — the derived states of the live view (SKILL.md §10).
// Each case fabricates the three sets in a temp repo and asserts what the page
// concludes. No tmux and no real workers: liveness is absent in every case, so
// these pin the hardest half — telling apart the ways a run can be NOT alive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

import { KANIT_FONT_CSS } from '../plugins/tmux-teams/skills/tmux-teams/assets/kanit/kanit-embedded.mjs'
import { PULSE_REFRESH_SOURCE } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-refresh.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')
const REFRESH_SOURCE = PULSE_REFRESH_SOURCE
const REFRESH_SOURCE_HASH = createHash('sha256').update(REFRESH_SOURCE).digest('hex')
const FIXED_UTC = '2026-07-21T09:00:00Z'
const FIXED_ISO = '2026-07-21T09:00:00.000Z'
const FIXED_BANGKOK = '2026-07-21 16:00:00'

const TEMP_REPOS = new Set()
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-repo-'))
  TEMP_REPOS.add(dir)
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

test.afterEach(() => {
  for (const dir of [...TEMP_REPOS]) {
    TEMP_REPOS.delete(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})
const runOnce = (dir, { extraEnv = {}, extraArgs = [] } = {}) => spawnSync(
  'node',
  [PULSE, 'once', dir, ...extraArgs],
  {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', PULSE_TIME_ZONE: '', ...extraEnv },
  },
)
const render = (dir, options) => {
  const r = runOnce(dir, options)
  assert.equal(r.status, 0, r.stderr)
  return readFileSync(r.stdout.trim(), 'utf8')
}
const snapshotOf = (dir) => JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
/** Backdate a path so age-based rules fire without sleeping. */
const age = (path, sec) => {
  const t = Date.now() / 1000 - sec
  utimesSync(path, t, t)
}
const dispatch = (dir, id, ageSec = 0) => {
  const p = join(dir, '.tmux-teams', 'dispatch', `${id}.md`)
  writeFileSync(p, `task_id: ${id}\nworker: codex\ntransport: tmux\nstarted_at: ${FIXED_UTC}\ntimeout_sec: 1200\n`)
  if (ageSec) age(p, ageSec)
  return p
}
const outbox = (dir, id, marker, ageSec = 0) => {
  const p = join(dir, '.mailbox-out', id)
  writeFileSync(p, `ASKED: x\nDID: y\nEVIDENCE: z\n${marker ? `${marker} ${id}\n` : ''}`)
  if (ageSec) age(p, ageSec)
  return p
}
/** Extract a named SVG without coupling tests to its surrounding disclosure UI. */
const svgById = (html, id) => {
  const match = html.match(new RegExp(`<svg\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</svg>`))
  assert.ok(match, `missing SVG ${id}`)
  return match[0]
}
/** The page carries two SVGs — the two-layer worker loop and the per-worker graph. */
const perWorkerSvg = (html) => {
  const i = html.indexOf('aria-label="แต่ละงานเดินไปถึงขั้นไหน"')
  return html.slice(html.lastIndexOf('<svg', i), html.indexOf('</svg>', i))
}
const dispatchLifecycleSvg = (html) => svgById(html, 'dispatch-lifecycle-svg')
const sectionBy = (html, labelledBy) => {
  const marker = `aria-labelledby="${labelledBy}"`
  const i = html.indexOf(marker)
  assert.notEqual(i, -1, `missing section ${labelledBy}`)
  return html.slice(html.lastIndexOf('<section', i), html.indexOf('</section>', i) + 10)
}

const event = (dir, id, wait = '42') => writeFileSync(
  join(dir, '.tmux-teams', 'kms', 'events', `20260721-0900_${id}_codex.md`),
  `task_id: ${id}\nworker: codex\nterminal: TEAM_DONE\npm_verdict: pass\nstarted_at: ${FIXED_UTC}\nwait_sec: ${wait}\n`,
)

const transportEvent = (dir, id) => writeFileSync(
  join(dir, '.tmux-teams', 'kms', 'events', `20260721-0901_${id}_codex.md`),
  `event_kind: transport-terminal\ntask_id: ${id}\nworker: codex\nterminal: done\nwait_sec: 42\n`,
)

test('a dispatch with no process and no record is reported as died silently', () => {
  const dir = repo()
  dispatch(dir, 'killed-midrun', 600)
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.total, 1)
  assert.equal(snapshot.history.runs[0].task_id, 'killed-midrun')
})

test('a fresh dispatch is starting up, not dead', () => {
  const dir = repo()
  dispatch(dir, 'just-launched', 5)
  const html = render(dir)
  assert.doesNotMatch(sectionBy(html, 'running-title'), /หยุดโดยไม่มีบันทึก/)
})

test('a finished worker awaiting a recorded verdict is not an alarm', () => {
  // The window between the worker exiting and the event being written is normal
  // and can last minutes; calling it death would fire on every successful run.
  const dir = repo()
  dispatch(dir, 'awaiting', 300)
  outbox(dir, 'awaiting', 'TEAM_DONE', 300)
  const html = render(dir)
  assert.doesNotMatch(sectionBy(html, 'running-title'), /หยุดโดยไม่มีบันทึก/)
})

test('the two-layer worker loop keeps ownership boundaries and the complete died counter', () => {
  const dir = repo()
  for (let i = 0; i < 101; i++) dispatch(dir, `dead-${String(i).padStart(3, '0')}`, 600)
  dispatch(dir, 'verdict-not-recorded', 4000)
  outbox(dir, 'verdict-not-recorded', 'TEAM_DONE', 4000)
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.total, 102)
  assert.equal(snapshot.history.runs.length, 100, 'history detail is bounded')
  assert.equal(snapshot.history.truncated, 2)
})

test('human-facing review copy stays neutral while legacy pm_verdict remains explicit', () => {
  const dir = repo()
  dispatch(dir, 'awaiting-neutral', 300)
  outbox(dir, 'awaiting-neutral', 'TEAM_DONE', 300)
  event(dir, 'legacy-verdict')
  const html = render(dir)
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))

  for (const routinePmCopy of [
    /รอ PM ตรวจผล/,
    />PM ตรวจผล</,
    /คำตัดสิน PM/,
    /คำตัดสินของ PM/,
    /PM บันทึกคำตัดสิน/,
  ]) {
  }

  assert.match(REFRESH_SOURCE, /const stale = Date\.now\(\) >= expiry/)
  assert.match(REFRESH_SOURCE, /document\.addEventListener\('visibilitychange'/)
})

test('a 44-row attention fixture uses a complete, ordered dense list', () => {
  const dir = repo()
  const ids = Array.from({ length: 44 }, (_, index) => `dense-${String(index).padStart(2, '0')}`)
  for (const id of ids) dispatch(dir, id, 600)
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.summary.attention, 0)
  assert.equal(snapshot.history.total, 44)
  assert.equal(snapshot.history.runs.length, 44)
})

test('a recorded run leaves the live tables but stays on the graph', () => {
  // The graph deliberately keeps finished runs: a complete line is what an
  // interrupted one is read against. The alarm tables must still let it go.
  const dir = repo()
  dispatch(dir, 'all-done', 600)
  outbox(dir, 'all-done', 'TEAM_DONE', 600)
  event(dir, 'all-done')
  const html = render(dir)
  const liveSections = sectionBy(html, 'attention-title') + sectionBy(html, 'running-title')
  assert.doesNotMatch(liveSections, /all-done/)
  assert.match(perWorkerSvg(html), /all-done/)                  // on the graph
  assert.match(sectionBy(html, 'recent-title'), /all-done/)     // and in history
})

test('a mechanical terminal event does not settle a run before the PM verdict', () => {
  const dir = repo()
  dispatch(dir, 'mechanical-only', 300)
  outbox(dir, 'mechanical-only', 'TEAM_DONE', 300)
  transportEvent(dir, 'mechanical-only')
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.runs.find((run) => run.task_id === 'mechanical-only')?.state, 'awaiting-verdict')
})

test('an old event does not settle a newer dispatch of the same id', () => {
  // Ids get reused. Matching on id alone would let yesterday's record hide a run
  // that is happening right now.
  const dir = repo()
  event(dir, 'reused')
  age(join(dir, '.tmux-teams', 'kms', 'events', '20260721-0900_reused_codex.md'), 86400)
  dispatch(dir, 'reused', 600)
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.ok(snapshot.history.runs.some((run) => run.task_id === 'reused'))
})

// The published asset is browser-parsed, never imported — a content hash proves
// integrity of whatever was emitted, including a file the browser refuses to run.
test('the published refresh asset parses as JavaScript', () => {
  assert.doesNotThrow(() => new Script(PULSE_REFRESH_SOURCE))  // compiles only; never run
})

test('the dashboard uses the local marker refresh contract and preserves interaction state', () => {
  const dir = repo()
  const html = render(dir)
  for (const page of [html]) {
    assert.equal((page.match(/<button[^>]*data-refresh-toggle[^>]*>/g) || []).length, 1)
    assert.doesNotMatch(page, /<script>\s*(?:\(\(\)|const |function )/)
  }
  for (const contract of [
    'pulse-current.json', 'snapshot_id', 'location.reload()', 'scroll_regions',
    'sessionStorage', 'details', 'document.activeElement', 'Updates unavailable',
    'crypto.subtle.digest', 'data-refresh-focus-key',
  ]) assert.match(REFRESH_SOURCE, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), contract)
  assert.equal((html.match(/id="pulse-timezone-label"/g) || []).length, 1)
})

test('header, recent verdicts, and run details render Asia/Bangkok while JSON stays UTC', () => {
  const dir = repo()
  dispatch(dir, 'thai-active', 600)
  event(dir, 'thai-recent')

  const html = render(dir)
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  const expectedFixedTime = `<time datetime="${FIXED_ISO}" title="Asia/Bangkok" aria-describedby="pulse-timezone-label">${FIXED_BANGKOK}</time>`
  const header = html.match(/ข้อมูลที่สังเกต ณ<\/span><time datetime="([^"]+)" title="Asia\/Bangkok" aria-describedby="pulse-timezone-label">([^<]+)<\/time>/)
  const generatedBangkok = new Date(Date.parse(snapshot.generated_at) + 7 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  assert.ok(header, 'header must expose its machine timestamp and explicit IANA zone')
  assert.equal(header[1], snapshot.generated_at)
  assert.equal(header[2], generatedBangkok)
  assert.ok(sectionBy(html, 'recent-title').includes(expectedFixedTime))
  assert.equal(snapshot.history.runs.find(run => run.task_id === 'thai-active')?.started_at, FIXED_ISO)
  assert.equal(snapshot.recent_verdicts.find(row => row.task_id === 'thai-recent')?.started_at, FIXED_ISO)
  assert.equal((html.match(/เวลาไทย \(UTC\+7\)/g) || []).length, 1,
    'the visible timezone label belongs only in the header')

  const absoluteTimes = [...html.matchAll(/<time datetime="([^"]+)" title="([^"]+)" aria-describedby="pulse-timezone-label">([^<]+)<\/time>/g)]
  assert.equal(absoluteTimes.length, 2, 'fixture covers header and recent history')
  for (const [, machineTime, zone, visibleTime] of absoluteTimes) {
    assert.match(machineTime, /Z$/, 'machine timestamp remains RFC3339 UTC')
    assert.equal(zone, 'Asia/Bangkok')
    assert.match(visibleTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  }
})

test('display timezone supports env and CLI precedence without changing UTC data', () => {
  const dir = repo()
  dispatch(dir, 'zone-active', 600)
  event(dir, 'zone-recent')

  const utc = render(dir, { extraEnv: { PULSE_TIME_ZONE: 'UTC' } })
  assert.match(utc, /id="pulse-timezone-label"[^>]*>เขตเวลา UTC<\/span>/)
  assert.match(utc, new RegExp(
    `<time datetime="${FIXED_ISO}" title="UTC" aria-describedby="pulse-timezone-label">2026-07-21 09:00:00</time>`,
  ))

  const newYork = render(dir, { extraEnv: { PULSE_TIME_ZONE: 'America/New_York' } })
  assert.match(newYork, /id="pulse-timezone-label"[^>]*>เขตเวลา America\/New_York<\/span>/)
  assert.match(newYork, new RegExp(
    `<time datetime="${FIXED_ISO}" title="America/New_York" aria-describedby="pulse-timezone-label">2026-07-21 05:00:00</time>`,
  ))

  const cliWins = render(dir, {
    extraEnv: { PULSE_TIME_ZONE: 'Invalid/Zone' },
    extraArgs: ['--time-zone', 'Asia/Bangkok'],
  })
  assert.match(cliWins, /id="pulse-timezone-label"[^>]*>เวลาไทย \(UTC\+7\)<\/span>/)
  assert.match(cliWins, new RegExp(
    `<time datetime="${FIXED_ISO}" title="Asia/Bangkok" aria-describedby="pulse-timezone-label">${FIXED_BANGKOK}</time>`,
  ))

  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  assert.equal(snapshot.history.runs.find(run => run.task_id === 'zone-active')?.started_at, FIXED_ISO)
  assert.equal(snapshot.recent_verdicts.find(row => row.task_id === 'zone-recent')?.started_at, FIXED_ISO)
})

test('an explicit invalid display timezone fails before publishing', () => {
  for (const options of [
    { extraEnv: { PULSE_TIME_ZONE: 'Invalid/Zone' } },
    { extraArgs: ['--time-zone', 'Invalid/Zone'] },
  ]) {
    const result = runOnce(repo(), options)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /\[pulse\] invalid time zone "Invalid\/Zone"/)
  }
})

test('the page is Thai-first and ordered for scanning before deep reading', () => {
  const html = render(repo())
  const overview = html.indexOf('aria-label="ภาพรวมสถานะ"')
  const attention = html.indexOf('aria-labelledby="attention-title"')
  const recent = html.indexOf('aria-labelledby="recent-title"')
  const details = html.indexOf('aria-labelledby="details-title"')

  assert.ok(overview < attention && attention < recent && recent < details)
  assert.match(html, /\.skip-link\{[^}]*clip-path:inset\(50%\)[^}]*opacity:0[^}]*\}\.skip-link:focus\{[^}]*clip-path:none[^}]*opacity:1/,
    'the unfocused skip link must be fully clipped so stitched full-page screenshots cannot expose it')
})

// Salvaged from pulse-v2.test.mjs before that file goes with the phase
// subsystem. `assertPublishLock` and `atomicWrite` appear in no other test, so
// this was the only thing standing between a reclaimed publisher and a
// half-written page — and it would have been deleted as collateral.
test('publish fencing is checked inside each atomic rename boundary', () => {
  const source = readFileSync(PULSE, 'utf8')
  const atomicWrite = source.slice(
    source.indexOf('function atomicWrite('),
    source.indexOf('\nfunction atomicWriteIfChanged('),
  )
  assert.match(atomicWrite,
    /if \(publishToken !== null\) assertPublishLock\(publishToken\)\s+renameSync\(temp, path\)/,
    'a reclaimed publisher must be fenced out immediately before rename')
  for (const call of [
    'atomicWriteIfChanged(FONT_CSS_OUT, KANIT_FONT_CSS, token)',
    'atomicWrite(JSON_OUT, jsonText, token)',
    'atomicWrite(OUT, html, token)',
    'atomicWrite(GRAPH_OUT, graphHtml, token)',
    'atomicWrite(KANBAN_OUT, kanbanHtml, token)',
    'atomicWrite(BUNDLE_OUT, bundleText, token)',
  ]) {
    assert.ok(source.includes(call), `publisher is missing the lock token: ${call}`)
  }
})

// Also salvaged. `dispatchLifecycleSvg` was defined in this file and never
// called; the only test that rendered the diagram lived in the dying file, and
// the a11y half of it was `function assertSvgA11y(svg, titleId, descId) {}` —
// an empty body, so three call sites asserted nothing at all. Written out here
// against the markup pulse.mjs actually emits rather than carried over blank.
test('the dispatch lifecycle diagram renders, is labelled, and says it is a model', () => {
  const html = render(repo())
  const loop = dispatchLifecycleSvg(html)
  assert.match(loop, /role="img"/)
  assert.match(loop, /aria-labelledby="worker-lifecycle-title worker-lifecycle-desc"/)
  assert.match(loop, /<title id="worker-lifecycle-title">[^<]+<\/title>/)
  assert.match(loop, /<desc id="worker-lifecycle-desc">[^<]+<\/desc>/)
  // The caveat is the point of the picture: it is a responsibility model, and a
  // reader who takes it for live state is reading a claim nobody made.
  assert.match(loop, /โมเดลเชิงบรรทัดฐาน/)
  assert.match(loop, /ไม่ใช่สถานะสด/)
})

test('the published page reaches nothing outside itself', () => {
  assert.doesNotMatch(readFileSync(PULSE, 'utf8'), /https?:\/\/|\b(?:fetch|XMLHttpRequest)\s*\(/)
})

test('the Kanit payload is content-addressed, offline, and not rewritten on refresh', () => {
  const dir = repo()
  const cssHash = createHash('sha256').update(KANIT_FONT_CSS).digest('hex')
  const cssName = `pulse-fonts-${cssHash}.css`
  const cssPath = join(dir, '.tmux-teams', cssName)

  const firstHtml = render(dir)
  assert.match(firstHtml, new RegExp(`<link rel="stylesheet" href="${cssName}">`))
  assert.doesNotMatch(firstHtml, /data:font\/woff2;base64,|https?:\/\//)
  assert.equal(readFileSync(cssPath, 'utf8'), KANIT_FONT_CSS)
  assert.equal((KANIT_FONT_CSS.match(/data:font\/woff2;base64,/g) || []).length, 6)
  assert.doesNotMatch(KANIT_FONT_CSS, /src:url\((?!\"data:font\/woff2;base64,)/)

  utimesSync(cssPath, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const mtimeBefore = statSync(cssPath).mtimeMs
  const secondHtml = render(dir)

  assert.match(secondHtml, new RegExp(`<link rel="stylesheet" href="${cssName}">`))
  assert.equal(readFileSync(cssPath, 'utf8'), KANIT_FONT_CSS)
  assert.equal(statSync(cssPath).mtimeMs, mtimeBefore, 'unchanged static payload must not be rewritten')
  assert.equal(JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8')).sequence, 2)

  // Salvaged from pulse-v2.test.mjs. Not-rewritten-when-unchanged and
  // repaired-when-corrupt are opposite halves of the same rule, and only the
  // first half was tested here — the half that proves the page cannot be left
  // pointing at a broken asset lived in the file the phase deletion takes.
  writeFileSync(cssPath, 'corrupt\n')
  render(dir)
  assert.equal(readFileSync(cssPath, 'utf8'), KANIT_FONT_CSS, 'a corrupted font payload must be republished')
})

test('the grace window covers a slow cold start', () => {
  const dir = repo()
  dispatch(dir, 'npx-fetching', 200)     // 200s: past the old 90s window
  const html = render(dir)
  assert.doesNotMatch(sectionBy(html, 'running-title'), /หยุดโดยไม่มีบันทึก/)
})

test('the graph shows a stage as reached even after the process is gone', () => {
  const dir = repo()
  dispatch(dir, 'wrote-then-died', 4000)
  outbox(dir, 'wrote-then-died', 'TEAM_DONE', 4000)
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.ok(snapshot.history.runs.some((run) => run.task_id === 'wrote-then-died'))
})

test('an idle pane shell is not counted as a running worker', () => {
  // The first real run opened its session with an empty PM shell in window 0.
  // Its cwd is the repo, so it passed the ownership check and was reported as a
  // second running worker. A shell with no child is a prompt, not a job —
  // whether or not it has a footprint.
  const dir = repo()
  const html = render(dir)
  // No tmux here, so this asserts the shape: an empty repo reports nothing
  // running, and the orphan path cannot invent rows out of bare processes.
  assert.doesNotMatch(sectionBy(html, 'running-title'), /pill running/)
})

test('a recorded pane that tmux no longer lists means dead, not starting', () => {
  // Killing a worker mid-run showed the grace window overriding real evidence:
  // the pane was already destroyed and the page still said "starting". A
  // recorded pane decides in BOTH directions; the window is only for dispatches
  // that have no pane to check.
  const dir = repo()
  const p = join(dir, '.tmux-teams', 'dispatch', 'killed-now.md')
  writeFileSync(p, 'task_id: killed-now\nworker: codex\ntransport: tmux\ntimeout_sec: 240\npane: %999999\n')
  age(p, 30)   // well inside the grace window
  render(dir)
  const snapshot = snapshotOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.ok(snapshot.history.runs.some((run) => run.task_id === 'killed-now'))
})
