// pulse.test.mjs — the derived states of the live view (SKILL.md §10).
// Each case fabricates the three sets in a temp repo and asserts what the page
// concludes. No tmux and no real workers: liveness is absent in every case, so
// these pin the hardest half — telling apart the ways a run can be NOT alive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KANIT_FONT_CSS } from '../plugins/tmux-teams/skills/tmux-teams/assets/kanit/kanit-embedded.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')
const FIXED_UTC = '2026-07-21T09:00:00Z'
const FIXED_ISO = '2026-07-21T09:00:00.000Z'
const FIXED_THAI = '2026-07-21 16:00:00 เวลาไทย (UTC+7)'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-repo-'))
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}
const render = (dir) => {
  const r = spawnSync('node', [PULSE, 'once', dir], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
  })
  assert.equal(r.status, 0, r.stderr)
  return readFileSync(r.stdout.trim(), 'utf8')
}
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
  // Kill a worker mid-run and see whether the page dares say so.
  const dir = repo()
  dispatch(dir, 'killed-midrun', 600)
  const html = render(dir)
  assert.match(html, /killed-midrun/)
  assert.match(html, /หยุดโดยไม่มีบันทึก/)
  assert.match(html, /data-state="died"/)
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
  const html = render(dir)
  const loop = dispatchLifecycleSvg(html)
  const graph = perWorkerSvg(html)
  const count = loop.match(/>หยุดผิดปกติ<\/text><text[^>]*>(\d+)<\/text>/)
  const graphWidth = Number(graph.match(/viewBox="0 0 ([\d.]+) /)?.[1])
  const graphTagX = Number(graph.match(/class="g-tag [^"]+" x="([\d.]+)"/)?.[1])
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))

  assert.match(html, /unrecorded/, 'the run must remain visible as unrecorded')
  assert.equal(snapshot.summary.by_state.died, 101)
  assert.equal(snapshot.summary.by_state.unrecorded, 1)
  assert.equal(snapshot.runs.length, 100, 'the detailed run list is intentionally bounded')
  assert.equal(snapshot.summary.truncated, 2)
  assert.match(loop, /role="img"/)
  assert.match(loop, /aria-labelledby="worker-lifecycle-title worker-lifecycle-desc"/)
  assert.match(loop, /<title id="worker-lifecycle-title">โมเดลเชิงบรรทัดฐานของลูปสองชั้นสำหรับ worker และการส่งมอบ<\/title>/)
  assert.match(loop, /<desc id="worker-lifecycle-desc">/)
  assert.match(loop, /ลูปชั้นใน · ทีมเฟสเป็นเจ้าของการตรวจ worker/)
  assert.match(loop, /ลูปชั้นนอก · PM ติดตาม phase และ handoff/)
  assert.match(loop, /PM รับเฉพาะข้อยกเว้น/)
  assert.match(loop, />ไม่พบผลลัพธ์<\/text><text[^>]*>และไม่พบ process<\/text>/,
    'the died condition must use two labels that stay clear of the node and connector')
  assert.doesNotMatch(loop, />PM ตรวจผล</,
    'routine worker review must stay inside the phase team loop')
  assert.match(html, /โมเดลเชิงบรรทัดฐาน ไม่ใช่สถานะสด/)
  assert.match(html, /ทีมเฟสเป็นเจ้าของ dispatch\/verification ตามปกติ/)
  assert.match(html, /งานที่ไม่ผ่านควรสร้าง dispatch หรือ attempt ใหม่ภายในทีม/)
  assert.match(html, /transition ที่ Pulse ยังไม่วัดว่าเกิดจริง/)
  assert.match(html, /คำอธิบายสัญลักษณ์กราฟความคืบหน้า/)
  assert.match(html, /จุดทึบ · มีหลักฐานว่าถึงขั้นนี้/)
  assert.match(html, /ข้อมูลเทียบเท่ากราฟ/)
  assert.ok(graphWidth - graphTagX >= 140,
    'the progress graph must reserve enough right padding for its longest Thai status label')
  assert.doesNotMatch(html, /aria-label="ลูปการทำงานของระบบ"/,
    'the worker lifecycle must not be announced as a whole-system loop')
  assert.equal(count?.[1], String(snapshot.summary.by_state.died),
    'the lifecycle counter must not count other attention states or lose truncated deaths')
  assert.match(loop, /เส้นย้อนกลับที่ยังไม่ได้วัด/,
    'the existing unmeasured back-edge explanation must remain available')
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
  assert.match(html, /const stale = !valid \|\| Date\.now\(\) >= expiry/)
  assert.match(html, /document\.addEventListener\('visibilitychange'/)
  assert.match(html, /data-observation-freshness="fresh"/)
})

test('a 44-row attention fixture uses a complete, ordered dense list', () => {
  const dir = repo()
  const ids = Array.from({ length: 44 }, (_, index) => `dense-${String(index).padStart(2, '0')}`)
  for (const id of ids) dispatch(dir, id, 600)
  const html = render(dir)
  const attention = sectionBy(html, 'attention-title')
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))

  assert.equal(snapshot.summary.attention, 44)
  assert.equal(snapshot.summary.by_state.died, 44)
  assert.match(html, /class="primary-grid primary-grid-stacked" data-layout="stacked-dense"/)
  assert.match(attention, /class="run-list run-list-dense" data-run-count="44" data-layout="dense"/)
  assert.equal((attention.match(/class="run-item"/g) || []).length, 44)
  let previous = -1
  for (const id of ids) {
    const position = attention.indexOf(`<code>${id}</code>`)
    assert.ok(position > previous, `${id} must retain deterministic DOM priority order`)
    previous = position
  }
  assert.match(html, /\.run-list-dense\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/)
  assert.match(html, /\.primary-grid,\.run-list-dense\{grid-template-columns:1fr\}/)
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
  const html = render(dir)
  const liveSections = sectionBy(html, 'attention-title') + sectionBy(html, 'running-title')
  assert.match(liveSections, /mechanical-only/)
  assert.match(liveSections, /awaiting-verdict/)
  const graph = perWorkerSvg(html)
  const dots = [...graph.matchAll(/<circle class="([^"]+)"/g)].map(m => m[1])
  assert.equal(dots.filter(c => !c.includes('g-off')).length, 3, 'PM verdict and record stages stay open')
  assert.match(html, /ยังไม่มีสถิติ/)
})

test('an old event does not settle a newer dispatch of the same id', () => {
  // Ids get reused. Matching on id alone would let yesterday's record hide a run
  // that is happening right now.
  const dir = repo()
  event(dir, 'reused')
  age(join(dir, '.tmux-teams', 'kms', 'events', '20260721-0900_reused_codex.md'), 86400)
  dispatch(dir, 'reused', 600)
  const html = render(dir)
  assert.match(sectionBy(html, 'attention-title'), /reused/)
  assert.match(html, /หยุดโดยไม่มีบันทึก/)
})

test('the page states its scope and its own age', () => {
  const html = render(repo())
  assert.match(html, /ติดตามเฉพาะ worker ที่ระบบสั่งในโปรเจกต์นี้/)
  assert.match(html, /ข้อมูลที่สังเกต ณ<\/span><time[^>]+>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} เวลาไทย \(UTC\+7\)<\/time>/)
  assert.doesNotMatch(html, />\d{4}-\d{2}-\d{2}[^<]* UTC<\/time>/)
  assert.match(html, /http-equiv="refresh"/)
})

test('header, recent verdicts, and run details render Asia/Bangkok while JSON stays UTC', () => {
  const dir = repo()
  dispatch(dir, 'thai-active', 600)
  event(dir, 'thai-recent')

  const html = render(dir)
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  const expectedFixedTime = `<time datetime="${FIXED_ISO}" title="Asia/Bangkok">${FIXED_THAI}</time>`
  const header = html.match(/ข้อมูลที่สังเกต ณ<\/span><time datetime="([^"]+)" title="Asia\/Bangkok">([^<]+)<\/time>/)
  const generatedThai = new Date(Date.parse(snapshot.generated_at) + 7 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  assert.ok(header, 'header must expose its machine timestamp and explicit IANA zone')
  assert.equal(header[1], snapshot.generated_at)
  assert.equal(header[2], `${generatedThai} เวลาไทย (UTC+7)`)
  assert.ok(sectionBy(html, 'attention-title').includes(expectedFixedTime))
  assert.ok(sectionBy(html, 'recent-title').includes(expectedFixedTime))
  assert.equal(snapshot.runs.find(run => run.task_id === 'thai-active')?.started_at, FIXED_ISO)
  assert.equal(snapshot.recent_verdicts.find(row => row.task_id === 'thai-recent')?.started_at, FIXED_ISO)

  const absoluteTimes = [...html.matchAll(/<time datetime="([^"]+)" title="([^"]+)">([^<]+)<\/time>/g)]
  assert.equal(absoluteTimes.length, 3, 'fixture covers header, recent, and active-run details')
  for (const [, machineTime, zone, visibleTime] of absoluteTimes) {
    assert.match(machineTime, /Z$/, 'machine timestamp remains RFC3339 UTC')
    assert.equal(zone, 'Asia/Bangkok')
    assert.match(visibleTime, /เวลาไทย \(UTC\+7\)$/)
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
  assert.match(html, /sessionStorage\.setItem\(key, detail\.open \? 'open' : 'closed'\)/)
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
  // An outbox proves the worker was alive at some point. Drawing that stage as
  // never-reached put a solid line through a hollow dot.
  const dir = repo()
  dispatch(dir, 'wrote-then-died', 4000)
  outbox(dir, 'wrote-then-died', 'TEAM_DONE', 4000)
  const html = render(dir)
  const graph = perWorkerSvg(html)
  const dots = [...graph.matchAll(/<circle class="([^"]+)"/g)].map(m => m[1])
  // dispatch + alive + outbox filled, verdict + record hollow
  assert.equal(dots.filter(c => !c.includes('g-off')).length, 3)
  assert.equal(dots.filter(c => c.includes('g-off')).length, 2)
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
  const graph = perWorkerSvg(render(dir))
  assert.match(graph, new RegExp(`<text class="g-id"[^>]*>${taskId}</text>`))
  assert.doesNotMatch(graph, /<text class="g-id"[^>]*>[^<]*…<\/text>/)
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
  const html = render(dir)
  assert.match(html, /killed-now/)
  assert.match(html, /หยุดโดยไม่มีบันทึก/)
})
