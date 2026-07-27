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
const loopGraphOf = (dir) => readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
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
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.total, 1)
  assert.equal(snapshot.history.runs[0].task_id, 'killed-midrun')
  assert.match(graph, /data-count-working="0"/)
  assert.match(graph, /data-history-run="true"[^>]*data-audit-task-id="killed-midrun"/)
  assert.match(graph, /data-history-state="died"|data-history-state="pass"/)
})

test('a fresh dispatch is starting up, not dead', () => {
  const dir = repo()
  dispatch(dir, 'just-launched', 5)
  const html = render(dir)
  assert.match(html, /just-launched/)
  assert.doesNotMatch(sectionBy(html, 'running-title'), /หยุดโดยไม่มีบันทึก/)
  assert.match(html, /starting/)
})

test('a finished worker awaiting a recorded verdict is not an alarm', () => {
  // The window between the worker exiting and the event being written is normal
  // and can last minutes; calling it death would fire on every successful run.
  const dir = repo()
  dispatch(dir, 'awaiting', 300)
  outbox(dir, 'awaiting', 'TEAM_DONE', 300)
  const html = render(dir)
  assert.match(html, /awaiting-verdict/)
  assert.doesNotMatch(sectionBy(html, 'running-title'), /หยุดโดยไม่มีบันทึก/)
})

test('a terminal outbox with no record for too long is unrecorded, not dead', () => {
  const dir = repo()
  dispatch(dir, 'lost-record', 4000)
  outbox(dir, 'lost-record', 'TEAM_DONE', 4000)
  const html = render(dir)
  assert.match(html, /unrecorded/)
})

test('the two-layer worker loop keeps ownership boundaries and the complete died counter', () => {
  const dir = repo()
  for (let i = 0; i < 101; i++) dispatch(dir, `dead-${String(i).padStart(3, '0')}`, 600)
  dispatch(dir, 'verdict-not-recorded', 4000)
  outbox(dir, 'verdict-not-recorded', 'TEAM_DONE', 4000)
  render(dir)
  const snapshot = snapshotOf(dir)
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.total, 102)
  assert.equal(snapshot.history.runs.length, 100, 'history detail is bounded')
  assert.equal(snapshot.history.truncated, 2)
  assert.match(graph, /data-agent-node-count="0"/)
  assert.match(graph, /<details class="audit" id="graph-audit"/)
  assert.doesNotMatch(graph, /class="agent-node/)
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
    assert.doesNotMatch(html, routinePmCopy)
  }
  assert.match(html, /รอตรวจผล/)
  assert.match(html, /คำตัดสินที่บันทึก \(pm_verdict\)/)
  assert.match(html, /pm_verdict<\/code> เป็นชื่อฟิลด์เดิมเพื่อความเข้ากันได้ย้อนหลัง/)
  assert.match(html, /ไม่ได้ยืนยันว่า PM หรือทีมเฟสใดเป็นผู้ตรวจ/)
  assert.match(html, /PM รับเฉพาะข้อยกเว้น/)

  assert.match(html, /หลักฐานระบบครบ/)
  assert.match(html, /id="freshness-status"[^>]+role="status" aria-live="polite"/)
  assert.ok(html.includes(`data-observation-expires-at="${snapshot.observation.expires_at}"`))
  assert.match(REFRESH_SOURCE, /const stale = Date\.now\(\) >= expiry/)
  assert.match(REFRESH_SOURCE, /document\.addEventListener\('visibilitychange'/)
  assert.match(html, /data-observation-freshness="fresh"/)
})

test('a 44-row attention fixture uses a complete, ordered dense list', () => {
  const dir = repo()
  const ids = Array.from({ length: 44 }, (_, index) => `dense-${String(index).padStart(2, '0')}`)
  for (const id of ids) dispatch(dir, id, 600)
  render(dir)
  const snapshot = snapshotOf(dir)
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.summary.attention, 0)
  assert.equal(snapshot.history.total, 44)
  assert.equal(snapshot.history.runs.length, 44)
  assert.match(graph, /data-agent-node-count="0"/)
  assert.match(graph, /<details class="audit" id="graph-audit"/)
  assert.doesNotMatch(graph, /class="agent-node/)
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
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.equal(snapshot.history.runs.find((run) => run.task_id === 'mechanical-only')?.state, 'awaiting-verdict')
  assert.match(graph, /data-history-run="true"[^>]*data-audit-task-id="mechanical-only"/)
  assert.match(graph, /data-history-state="awaiting-verdict"/)
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
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.ok(snapshot.history.runs.some((run) => run.task_id === 'reused'))
  assert.match(graph, /data-history-run="true"[^>]*data-audit-task-id="reused"/)
  assert.match(graph, /data-history-state="died"/)
})

test('the page states its scope and its own age', () => {
  const html = render(repo())
  assert.match(html, /ติดตามเฉพาะ worker ที่ระบบสั่งในโปรเจกต์นี้/)
  assert.match(html, /id="pulse-timezone-label"[^>]*>เวลาไทย \(UTC\+7\)<\/span><span>ข้อมูลที่สังเกต ณ<\/span><time[^>]+>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/time>/)
  assert.doesNotMatch(html, />\d{4}-\d{2}-\d{2}[^<]* UTC<\/time>/)
  assert.doesNotMatch(html, /http-equiv="refresh"/)
})

// The published asset is browser-parsed, never imported — a content hash proves
// integrity of whatever was emitted, including a file the browser refuses to run.
test('the published refresh asset parses as JavaScript', () => {
  assert.doesNotThrow(() => new Script(PULSE_REFRESH_SOURCE))  // compiles only; never run
})

test('both rendered pages use the local marker refresh contract and preserve interaction state', () => {
  const dir = repo()
  const html = render(dir)
  const graph = loopGraphOf(dir)
  for (const page of [html, graph]) {
    assert.equal((page.match(/<button[^>]*data-refresh-toggle[^>]*>/g) || []).length, 1)
    assert.match(page, /data-refresh-toggle[^>]*data-refresh-focus-key="refresh-toggle"[^>]*aria-pressed="false"/)
    assert.match(page, new RegExp(`<script src="pulse-refresh-${REFRESH_SOURCE_HASH}\\.js" defer><\\/script>`))
    assert.match(page, /data-refresh-scroll-key="[^"]+"/)
    assert.doesNotMatch(page, /<script>\s*(?:\(\(\)|const |function )/)
    assert.match(page, /default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'/)
    assert.doesNotMatch(page, /script-src[^";]*unsafe-inline/)
    assert.match(page, /prefers-reduced-motion:reduce/)
    assert.match(page, /forced-colors:active/)
    assert.doesNotMatch(page, /http-equiv="refresh"/)
  }
  for (const contract of [
    'pulse-current.json', 'snapshot_id', 'location.reload()', 'scroll_regions',
    'sessionStorage', 'details', 'document.activeElement', 'Updates unavailable',
    'crypto.subtle.digest', 'data-refresh-focus-key',
  ]) assert.match(REFRESH_SOURCE, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), contract)
  assert.equal((html.match(/id="pulse-timezone-label"/g) || []).length, 1)
  assert.equal((graph.match(/id="loop-timezone-label"/g) || []).length, 1)
  assert.match(html, /\.age button\{[^}]*min-height:44px/)
  assert.match(graph, /\.graph-time button\{[^}]*min-height:44px/)
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
  const utcGraph = readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
  assert.match(utc, /id="pulse-timezone-label"[^>]*>เขตเวลา UTC<\/span>/)
  assert.match(utcGraph, /id="loop-timezone-label"[^>]*>เขตเวลา UTC<\/span>/)
  assert.match(utcGraph, /<time datetime="[^"]+" title="UTC" aria-describedby="loop-timezone-label">/)
  assert.match(utc, new RegExp(
    `<time datetime="${FIXED_ISO}" title="UTC" aria-describedby="pulse-timezone-label">2026-07-21 09:00:00</time>`,
  ))

  const newYork = render(dir, { extraEnv: { PULSE_TIME_ZONE: 'America/New_York' } })
  const newYorkGraph = readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
  assert.match(newYork, /id="pulse-timezone-label"[^>]*>เขตเวลา America\/New_York<\/span>/)
  assert.match(newYorkGraph, /id="loop-timezone-label"[^>]*>เขตเวลา America\/New_York<\/span>/)
  assert.match(newYorkGraph, /<time datetime="[^"]+" title="America\/New_York" aria-describedby="loop-timezone-label">/)
  assert.match(newYork, new RegExp(
    `<time datetime="${FIXED_ISO}" title="America/New_York" aria-describedby="pulse-timezone-label">2026-07-21 05:00:00</time>`,
  ))

  const cliWins = render(dir, {
    extraEnv: { PULSE_TIME_ZONE: 'Invalid/Zone' },
    extraArgs: ['--time-zone', 'Asia/Bangkok'],
  })
  const cliWinsGraph = readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
  assert.match(cliWins, /id="pulse-timezone-label"[^>]*>เวลาไทย \(UTC\+7\)<\/span>/)
  assert.match(cliWinsGraph, /id="loop-timezone-label"[^>]*>เวลาไทย \(UTC\+7\)<\/span>/)
  assert.equal((cliWinsGraph.match(/เวลาไทย \(UTC\+7\)/g) || []).length, 1)
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
  assert.match(html, /--sans:"Kanit","Noto Sans Thai","Leelawadee UI"/)
  assert.match(html, /<link rel="stylesheet" href="pulse-fonts-[a-f0-9]{64}\.css">/)
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,[^"]+">/)
  assert.doesNotMatch(html, /data:font\/woff2;base64,|@font-face\{font-family:"Kanit"/)
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/)
  assert.match(html, /<a class="skip-link" href="#main">/)
  assert.match(html, /\.skip-link\{[^}]*clip-path:inset\(50%\)[^}]*opacity:0[^}]*\}\.skip-link:focus\{[^}]*clip-path:none[^}]*opacity:1/,
    'the unfocused skip link must be fully clipped so stitched full-page screenshots cannot expose it')
  assert.match(html, /@media\(max-width:620px\)/)
  assert.match(html, /class="surface table-scroll responsive-table"/)
  assert.match(html, /<details class="deep-dive" data-persist-key="progress"><summary>ความคืบหน้าของแต่ละงาน<\/summary>/)
  assert.match(html, /data-refresh-scroll-key="[^"]+"/)
  assert.doesNotMatch(html, />DIED SILENTLY<|>not measured</)
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
})

test('an empty repo says there is nothing to see rather than looking broken', () => {
  const html = render(repo())
  assert.match(html, /ยังไม่มีงานผิดปกติ/)
  assert.match(html, /ยังไม่พบงานที่กำลังเดิน/)
})

test('an unmeasured duration never renders as zero', () => {
  const dir = repo()
  event(dir, 'no-timing', '-1')
  const html = render(dir)
  assert.match(html, /ยังไม่วัด/)
  assert.doesNotMatch(html, />0 วิ</)
})

test('a recorded pane that tmux still lists is starting, not dead', () => {
  // Startup can outlast any age guess — a cold `npx` fetching an ACP adapter
  // takes minutes. A pane tmux still knows about is evidence, not a heuristic.
  const dir = repo()
  const p = join(dir, '.tmux-teams', 'dispatch', 'slow-boot.md')
  writeFileSync(p, 'task_id: slow-boot\nworker: codex\ntransport: tmux\ntimeout_sec: 1200\npane: %999999\n')
  age(p, 4000)
  const html = render(dir)
  // %999999 does not exist, so with no pane held this must read as died —
  // proving the pane check is what decides, not the age.
  assert.match(html, /หยุดโดยไม่มีบันทึก/)
})

test('the grace window covers a slow cold start', () => {
  const dir = repo()
  dispatch(dir, 'npx-fetching', 200)     // 200s: past the old 90s window
  const html = render(dir)
  assert.match(html, /starting/)
  assert.doesNotMatch(sectionBy(html, 'running-title'), /หยุดโดยไม่มีบันทึก/)
})

test('the graph shows a stage as reached even after the process is gone', () => {
  const dir = repo()
  dispatch(dir, 'wrote-then-died', 4000)
  outbox(dir, 'wrote-then-died', 'TEAM_DONE', 4000)
  render(dir)
  const snapshot = snapshotOf(dir)
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.ok(snapshot.history.runs.some((run) => run.task_id === 'wrote-then-died'))
  assert.match(graph, /data-history-run="true"[^>]*data-audit-task-id="wrote-then-died"/)
  assert.match(graph, /data-history-state="unrecorded"/)
})

test('an unresolved run is not drawn as a healthy finish', () => {
  const dir = repo()
  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260721-0900_gave-up_codex.md'),
    'task_id: gave-up\nworker: codex\nterminal: TEAM_FAILED\npm_verdict: unresolved\nwait_sec: 12\n')
  const html = render(dir)
  const graph = perWorkerSvg(html)   // CSS also mentions these classes
  assert.match(graph, /gave-up/)
  assert.match(graph, /g-warn/)
  assert.match(graph, /ยังไม่สรุป/)
  assert.doesNotMatch(graph, /ไม่ทราบสถานะ/)
  assert.doesNotMatch(graph, /g-ok/)
})

test('the graph uses standardized Thai labels for recorded verdicts', () => {
  const dir = repo()
  event(dir, 'accepted')
  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260721-0901_needs-fix_codex.md'),
    'task_id: needs-fix\nworker: codex\nterminal: TEAM_DONE\npm_verdict: reject\nwait_sec: 12\n')
  const graph = perWorkerSvg(render(dir))
  assert.match(graph, /accepted/)
  assert.match(graph, /ผ่าน/)
  assert.match(graph, /needs-fix/)
  assert.match(graph, /ให้แก้ไข/)
  assert.doesNotMatch(graph, /ไม่ทราบสถานะ/)
})

test('the progress graph keeps the full task id visible without ellipsis', () => {
  const dir = repo()
  const taskId = 'completion-contract-fix-opus-with-visible-full-task-id'
  dispatch(dir, taskId, 600)
  render(dir)
  const graph = loopGraphOf(dir)
  assert.match(graph, new RegExp(`data-audit-task-id="${taskId}"`))
  assert.match(graph, new RegExp(`<code>${taskId}</code>`))
  assert.doesNotMatch(graph, /…/)
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
  assert.match(html, /ยังไม่พบงานที่กำลังเดิน/)
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
  const graph = loopGraphOf(dir)
  assert.equal(snapshot.summary.active, 0)
  assert.ok(snapshot.history.runs.some((run) => run.task_id === 'killed-now'))
  assert.match(graph, /data-history-run="true"[^>]*data-audit-task-id="killed-now"/)
  assert.match(graph, /data-history-state="died"/)
})
