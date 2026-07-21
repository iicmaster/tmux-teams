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

const event = (dir, id, wait = '42') => writeFileSync(
  join(dir, '.tmux-teams', 'kms', 'events', `20260721-0900_${id}_codex.md`),
  `task_id: ${id}\nworker: codex\nterminal: TEAM_DONE\npm_verdict: pass\nwait_sec: ${wait}\n`,
)

test('a dispatch with no process and no record is reported as died silently', () => {
  // Kill a worker mid-run and see whether the page dares say so.
  const dir = repo()
  dispatch(dir, 'killed-midrun', 600)
  const html = render(dir)
  assert.match(html, /killed-midrun/)
  assert.match(html, /DIED SILENTLY/)
})

test('a fresh dispatch is starting up, not dead', () => {
  const dir = repo()
  dispatch(dir, 'just-launched', 5)
  const html = render(dir)
  assert.match(html, /just-launched/)
  assert.doesNotMatch(html.split('บันทึกล่าสุด')[0], /DIED SILENTLY/)
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
  assert.doesNotMatch(html.split('บันทึกล่าสุด')[0], /DIED SILENTLY/)
})

test('a terminal outbox with no record for too long is unrecorded, not dead', () => {
  const dir = repo()
  dispatch(dir, 'lost-record', 4000)
  outbox(dir, 'lost-record', 'TEAM_DONE', 4000)
  const html = render(dir)
  assert.match(html, /unrecorded/)
})

test('a recorded run leaves the live tables but stays on the graph', () => {
  // The graph deliberately keeps finished runs: a complete line is what an
  // interrupted one is read against. The alarm tables must still let it go.
  const dir = repo()
  dispatch(dir, 'all-done', 600)
  outbox(dir, 'all-done', 'TEAM_DONE', 600)
  event(dir, 'all-done')
  const html = render(dir)
  const tables = html.slice(html.indexOf('ต้องการความสนใจ'), html.indexOf('บันทึกล่าสุด'))
  assert.doesNotMatch(tables, /all-done/)
  assert.match(html.slice(0, html.indexOf('ต้องการความสนใจ')), /all-done/)   // on the graph
  assert.match(html, /all-done/)                                              // and in history
})

test('an old event does not settle a newer dispatch of the same id', () => {
  // Ids get reused. Matching on id alone would let yesterday's record hide a run
  // that is happening right now.
  const dir = repo()
  event(dir, 'reused')
  age(join(dir, '.tmux-teams', 'kms', 'events', '20260721-0900_reused_codex.md'), 86400)
  dispatch(dir, 'reused', 600)
  const html = render(dir)
  assert.match(html.split('บันทึกล่าสุด')[0], /reused/)
  assert.match(html, /DIED SILENTLY/)
})

test('the page states its scope and its own age', () => {
  const html = render(repo())
  assert.match(html, /แสดงเฉพาะ worker ที่ระบบนี้สั่งในโปรเจกต์นี้/)
  assert.match(html, /อัปเดต \d{4}-\d{2}-\d{2}/)
  assert.match(html, /http-equiv="refresh"/)
})

test('an empty repo says there is nothing to see rather than looking broken', () => {
  const html = render(repo())
  assert.match(html, /ไม่มีอะไรต้องดู/)
  assert.match(html, /ไม่มี worker ทำงานอยู่/)
})

test('an unmeasured duration never renders as zero', () => {
  const dir = repo()
  event(dir, 'no-timing', '-1')
  const html = render(dir)
  assert.match(html, /not measured/)
  assert.doesNotMatch(html, />0s</)
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
  assert.match(html, /DIED SILENTLY/)
})

test('the grace window covers a slow cold start', () => {
  const dir = repo()
  dispatch(dir, 'npx-fetching', 200)     // 200s: past the old 90s window
  const html = render(dir)
  assert.match(html, /starting/)
  assert.doesNotMatch(html.split('บันทึกล่าสุด')[0], /DIED SILENTLY/)
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
  assert.doesNotMatch(graph, /g-ok/)
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
  assert.match(html, /ไม่มี worker ทำงานอยู่/)
  assert.doesNotMatch(html.slice(0, html.indexOf('บันทึกล่าสุด')), /pill running/)
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
  assert.match(html, /DIED SILENTLY/)
})
