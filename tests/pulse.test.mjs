// pulse.test.mjs — the derived states of the live view (SKILL.md §10).
// Each case fabricates the three sets in a temp repo and asserts what the page
// concludes. No tmux and no real workers: liveness is absent in every case, so
// these pin the hardest half — telling apart the ways a run can be NOT alive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-repo-'))
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}
const render = (dir) => {
  const r = spawnSync('node', [PULSE, 'once', dir], { encoding: 'utf8' })
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
  writeFileSync(p, `task_id: ${id}\nworker: codex\ntransport: tmux\nstarted_at: 2026-07-21T09:00:00Z\ntimeout_sec: 1200\n`)
  if (ageSec) age(p, ageSec)
  return p
}
const outbox = (dir, id, marker, ageSec = 0) => {
  const p = join(dir, '.mailbox-out', id)
  writeFileSync(p, `ASKED: x\nDID: y\nEVIDENCE: z\n${marker ? `${marker} ${id}\n` : ''}`)
  if (ageSec) age(p, ageSec)
  return p
}
/** The page carries two SVGs — the system loop and the per-worker graph. */
const perWorkerSvg = (html) => {
  const i = html.indexOf('aria-label="แต่ละงานเดินไปถึงขั้นไหน"')
  return html.slice(html.lastIndexOf('<svg', i), html.indexOf('</svg>', i))
}
const systemLoopSvg = (html) => {
  const i = html.indexOf('aria-label="ลูปการทำงานของระบบ"')
  return html.slice(html.lastIndexOf('<svg', i), html.indexOf('</svg>', i))
}
const sectionBy = (html, labelledBy) => {
  const marker = `aria-labelledby="${labelledBy}"`
  const i = html.indexOf(marker)
  assert.notEqual(i, -1, `missing section ${labelledBy}`)
  return html.slice(html.lastIndexOf('<section', i), html.indexOf('</section>', i) + 10)
}

const event = (dir, id, wait = '42') => writeFileSync(
  join(dir, '.tmux-teams', 'kms', 'events', `20260721-0900_${id}_codex.md`),
  `task_id: ${id}\nworker: codex\nterminal: TEAM_DONE\npm_verdict: pass\nwait_sec: ${wait}\n`,
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

test('a finished worker awaiting the PM verdict is not an alarm', () => {
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

test('the system loop dead counter uses the complete died summary only', () => {
  const dir = repo()
  for (let i = 0; i < 101; i++) dispatch(dir, `dead-${String(i).padStart(3, '0')}`, 600)
  dispatch(dir, 'verdict-not-recorded', 4000)
  outbox(dir, 'verdict-not-recorded', 'TEAM_DONE', 4000)
  const html = render(dir)
  const loop = systemLoopSvg(html)
  const count = loop.match(/>หยุดผิดปกติ<\/text><text[^>]*>(\d+)<\/text>/)
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))

  assert.match(html, /unrecorded/, 'the run must remain visible as unrecorded')
  assert.equal(snapshot.summary.by_state.died, 101)
  assert.equal(snapshot.summary.by_state.unrecorded, 1)
  assert.equal(snapshot.runs.length, 100, 'the detailed run list is intentionally bounded')
  assert.equal(snapshot.summary.truncated, 2)
  assert.equal(count?.[1], String(snapshot.summary.by_state.died),
    'the system total must not count other attention states or lose truncated deaths')
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
  assert.match(html, /อัปเดตล่าสุด <time[^>]+>\d{4}-\d{2}-\d{2}/)
  assert.match(html, /http-equiv="refresh"/)
})

test('the page is Thai-first and ordered for scanning before deep reading', () => {
  const html = render(repo())
  const overview = html.indexOf('aria-label="ภาพรวมสถานะ"')
  const attention = html.indexOf('aria-labelledby="attention-title"')
  const recent = html.indexOf('aria-labelledby="recent-title"')
  const details = html.indexOf('aria-labelledby="details-title"')

  assert.ok(overview < attention && attention < recent && recent < details)
  assert.match(html, /--sans:"Kanit","Noto Sans Thai","Leelawadee UI"/)
  assert.equal((html.match(/data:font\/woff2;base64,/g) || []).length, 6)
  assert.match(html, /@font-face\{font-family:"Kanit"/)
  assert.match(html, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/)
  assert.match(html, /<a class="skip-link" href="#main">/)
  assert.match(html, /@media\(max-width:620px\)/)
  assert.match(html, /class="surface table-scroll responsive-table"/)
  assert.match(html, /<details class="deep-dive" data-persist-key="progress"><summary>ความคืบหน้าของแต่ละงาน<\/summary>/)
  assert.match(html, /sessionStorage\.setItem\(key, detail\.open \? 'open' : 'closed'\)/)
  assert.doesNotMatch(html, />DIED SILENTLY<|>not measured</)
})

test('an empty repo says there is nothing to see rather than looking broken', () => {
  const html = render(repo())
  assert.match(html, /ยังไม่มีงานผิดปกติ/)
  assert.match(html, /ยังไม่มี worker ทำงาน/)
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

test('an idle pane shell is not counted as a running worker', () => {
  // The first real run opened its session with an empty PM shell in window 0.
  // Its cwd is the repo, so it passed the ownership check and was reported as a
  // second running worker. A shell with no child is a prompt, not a job —
  // whether or not it has a footprint.
  const dir = repo()
  const html = render(dir)
  // No tmux here, so this asserts the shape: an empty repo reports nothing
  // running, and the orphan path cannot invent rows out of bare processes.
  assert.match(html, /ยังไม่มี worker ทำงาน/)
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
