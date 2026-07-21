#!/usr/bin/env node
// pulse.mjs — one screen showing what this repo's orchestration is doing now.
//
// Read-only by design: it renders a page, it never dispatches, kills or edits.
//
// It PROBES rather than believes. Nothing here reads a "status: running" file,
// because a worker announcing its own liveness is the same attestation the
// outbox contract (SKILL.md §6) refuses to accept. Instead it compares three
// sets and reports the gaps between them:
//
//   FOOTPRINT  traces a dispatch leaves behind and cannot fake away
//   ALIVE      processes that actually exist right now
//   RECORDED   immutable events written when a run finished (§9)
//
//   footprint + alive    + no record  -> running
//   footprint + record                -> finished
//   footprint + no alive + no record  -> DIED SILENTLY   <- nothing else sees this
//
// That last row is the reason this exists. A worker killed mid-run leaves a
// footprint, no process and no event; until now it simply vanished.
//
// usage:
//   pulse.mjs once  <repo>                 render once, print the path
//   pulse.mjs watch <repo> [--interval 20] re-render forever (Ctrl-C to stop)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [cmd, repoArg, ...flags] = process.argv.slice(2)
const USAGE = 'usage: pulse.mjs once <repo> | pulse.mjs watch <repo> [--interval SEC]'
if (!cmd || !repoArg || !['once', 'watch'].includes(cmd)) { console.error(USAGE); process.exit(2) }

let REPO
try { REPO = realpathSync(repoArg) } catch { console.error(`[pulse] no such repo: ${repoArg}`); process.exit(2) }
const STORE = join(REPO, '.tmux-teams')
const OUT = join(STORE, 'pulse.html')
const EVENTS = join(STORE, 'kms', 'events')
const DISPATCH = join(STORE, 'dispatch')
const OUTBOX = join(REPO, '.mailbox-out')
const CTL = join(homedir(), '.tmux-teams', 'mailbox-run')

const iFlag = flags.indexOf('--interval')
const INTERVAL = iFlag >= 0 && Number(flags[iFlag + 1]) > 0 ? Number(flags[iFlag + 1]) : 20

// Startup is slower than it looks: an ACP lane may sit in `npx` downloading its
// adapter before anything exists to probe. Announcing death during a worker's
// own installation is the fastest way to make the alarm worthless. Where a pane
// id was recorded we check it directly and skip the guessing entirely.
const GRACE_SEC = 300

const sh = (bin, args) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}

/** cwd of a live pid, or null when the process is gone or /proc is unavailable. */
function cwdOf(pid) {
  try { return realpathSync(`/proc/${pid}/cwd`) } catch { return null }
}
const PROC_OK = cwdOf(process.pid) !== null

/** Does this pid have at least one child? A pane shell with none is idle. */
function hasChild(pid) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().length > 0 } catch { return null }
}

// An outbox with a terminal marker but no event is normal for as long as the PM
// takes to verify. Past this, the record is not late — it is missing.
const UNRECORDED_SEC = 900

// ── ALIVE ────────────────────────────────────────────────────────────────────
// Ownership is proven by the process's own cwd, never by a session name:
// `auto--api` could belong to any repo named api, and this project already paid
// for that lesson once in the memory store's key.
/** Pane ids tmux currently knows about — a recorded pane still listed means the
 *  dispatch has not collapsed, whatever the worker inside it is doing. */
function livePaneIds() {
  const out = sh('tmux', ['list-panes', '-a', '-F', '#{pane_id}'])
  return new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
}

function aliveWorkers() {
  const rows = [], notes = []
  if (!PROC_OK) notes.push('cannot read /proc — liveness on this host is unverifiable, so "running" and "died" cannot be told apart')

  const panes = sh('tmux', ['list-panes', '-a', '-F', '#{session_name}|#{window_name}|#{pane_id}|#{pane_pid}'])
  for (const line of panes.split('\n').filter(Boolean)) {
    const [session, windowName, paneId, pid] = line.split('|')
    if (!PROC_OK) continue
    if (cwdOf(pid) !== REPO) continue
    // pane_pid is the SHELL, and mailbox-run opens a shell then types `codex`
    // into it — so the shell outlives a crashed worker. A pane with no child is
    // an idle prompt, not a running job; calling it "running" would hide exactly
    // the death this page exists to surface.
    rows.push({ id: windowName, kind: 'tmux', detail: `${session} ${paneId}`, pid, hasChild: hasChild(pid) })
  }

  // ACP workers have no pane at all — find them by their own cwd + command line.
  if (PROC_OK) {
    let pids = []
    try { pids = readdirSync('/proc').filter(d => /^\d+$/.test(d)) } catch { pids = [] }
    for (const pid of pids) {
      if (cwdOf(pid) !== REPO) continue
      let cmdline = ''
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { continue }
      const m = cmdline.match(/acp-companion\.mjs\s+\S+\s+\S+\s+(\S+)/)
      if (m) rows.push({ id: m[1], kind: 'acp', detail: `pid ${pid}`, pid })
    }
  }
  return { rows, notes }
}

// ── FOOTPRINTS ───────────────────────────────────────────────────────────────
// Only `<repo>/.mailbox-out/<id>` proves this repo dispatched the work. Control
// dirs live at ~/.tmux-teams/mailbox-run/<id>, keyed by worker id alone — two
// repos dispatching "task-1" share that path — so they are collected separately
// and never raise an alarm on their own. Counting them as ours is how a first
// render showed three DIED SILENTLY rows that all belonged to another project.
function footprints() {
  const byId = new Map()

  // The dispatch record is written by the PM the moment it dispatches, so it
  // survives a worker that dies before producing anything. Without it, the
  // truest silent death — dying before the first write — leaves no trace at
  // all, because dispatch DELETES any stale outbox first.
  let dispatches = []
  try { dispatches = readdirSync(DISPATCH).filter(f => f.endsWith('.md')) } catch { dispatches = [] }
  for (const f of dispatches) {
    const id = f.replace(/\.md$/, '')
    let st, text = ''
    try { st = statSync(join(DISPATCH, f)); text = readFileSync(join(DISPATCH, f), 'utf8') } catch { continue }
    const field = (k) => (text.match(new RegExp(`^${k}:[ \\t]*(.+)$`, 'm')) || [, ''])[1].trim()
    byId.set(id, {
      id, mtime: st.mtimeMs, marker: '', dispatched: true,
      startedAt: field('started_at'), timeoutSec: Number(field('timeout_sec')) || null,
      transport: field('transport'), worker: field('worker'), pane: field('pane'),
    })
  }

  let names = []
  try { names = readdirSync(OUTBOX) } catch { names = [] }
  for (const id of names) {
    const path = join(OUTBOX, id)
    let st, text = ''
    try { st = statSync(path) } catch { continue }
    try { if (st.isFile()) text = readFileSync(path, 'utf8') } catch { /* unreadable: treat as no marker */ }
    // Same rule the PM wait loop uses: the LAST non-empty line, whole-line match.
    const last = text.split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
    const m = last.match(/^TEAM_(DONE|BLOCKED|FAILED)\s+(\S+)$/)
    const prev = byId.get(id) || { id, dispatched: false, startedAt: '', timeoutSec: null }
    byId.set(id, { ...prev, mtime: Math.max(st.mtimeMs, prev.mtime || 0), marker: m && m[2] === id ? `TEAM_${m[1]}` : '' })
  }
  return [...byId.values()]
}

/** Control dirs that no live process claims — shown as context, never as alarms. */
function unclaimedControlDirs(liveIds, footIds) {
  let names = []
  try { names = readdirSync(CTL) } catch { return [] }
  return names
    .filter(id => !liveIds.has(id) && !footIds.has(id))
    .map(id => {
      try { return { id, mtime: statSync(join(CTL, id)).mtimeMs } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 8)
}

// ── RECORDED ─────────────────────────────────────────────────────────────────
function recorded() {
  let files = []
  try { files = readdirSync(EVENTS).filter(f => f.endsWith('.md')).sort() } catch { return [] }
  return files.map(f => {
    const text = readFileSync(join(EVENTS, f), 'utf8')
    const get = (k) => (text.match(new RegExp(`^${k}:[ \\t]*(.+)$`, 'm')) || [, ''])[1].trim()
    const num = (k) => { const v = Number(get(k)); return Number.isFinite(v) ? v : null }
    return {
      file: f, task_id: get('task_id'), worker: get('worker'), terminal: get('terminal'),
      pm_verdict: get('pm_verdict'), lesson: get('lesson'), started_at: get('started_at'),
      wait_sec: num('wait_sec'), timeout_sec: num('timeout_sec'), stakes: get('stakes'),
      mtime: statSync(join(EVENTS, f)).mtimeMs,
    }
  })
}

// ── DERIVE ───────────────────────────────────────────────────────────────────
function derive(now) {
  const { rows: live, notes } = aliveWorkers()
  const panesNow = livePaneIds()
  const foot = footprints()
  const rec = recorded()
  // Worker ids get reused across runs, so an event only settles the footprint it
  // belongs to. Matching on id alone would let yesterday's record mark today's
  // dispatch "finished" and quietly drop it off the screen.
  const recAt = new Map()
  for (const r of rec) if (r.task_id) recAt.set(r.task_id, Math.max(recAt.get(r.task_id) || 0, r.mtime))
  const liveById = new Map(live.map(l => [l.id, l]))

  const active = []
  for (const f of foot) {
    const alive = liveById.get(f.id)
    const settled = recAt.has(f.id) && recAt.get(f.id) >= f.mtime - 1000
    if (settled && !alive) continue                    // finished and recorded: history, not now
    const ageSec = Math.round((now - f.mtime) / 1000)
    // The absence of a process means different things depending on whether the
    // worker got as far as writing its terminal marker. Collapsing those into
    // one red alarm would fire on every successful run, because the PM's verify
    // pass happens AFTER the worker exits and BEFORE the event is written.
    // A pane whose shell has no child is an idle prompt: the worker is gone even
    // though tmux still lists it. `null` means the check itself failed — that is
    // not evidence of death and must not be treated as any.
    const working = alive && (alive.kind !== 'tmux' || alive.hasChild !== false)
    // A recorded pane that tmux still lists is evidence the dispatch is intact,
    // which beats any age heuristic: no guessing how long a cold `npx` takes.
    const paneHeld = !!(f.pane && panesNow.has(f.pane))
    const state = working ? 'running'
      : !PROC_OK ? 'unknown'
      : f.marker ? (ageSec > UNRECORDED_SEC ? 'unrecorded' : 'awaiting-verdict')
      : paneHeld ? 'starting'
      : ageSec <= GRACE_SEC ? 'starting'
      : 'died'
    active.push({
      ...f, alive: !!alive, detail: alive ? alive.detail : '',
      kind: (alive && alive.kind) || f.transport || '', ageSec, state,
      idleShell: !!(alive && alive.kind === 'tmux' && alive.hasChild === false),
    })
  }
  // A live process with no footprint at all still deserves a row — it is real,
  // and hiding it because it does not fit the model is how a dashboard lies.
  for (const l of live) {
    if (!active.some(a => a.id === l.id)) {
      active.push({ id: l.id, marker: '', alive: true, kind: l.kind, detail: l.detail, ageSec: null, state: 'running' })
    }
  }
  const unclaimed = unclaimedControlDirs(new Set(live.map(l => l.id)), new Set(foot.map(f => f.id)))
  return { active, rec, notes, unclaimed }
}

// ── STATS ────────────────────────────────────────────────────────────────────
function median(xs) {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y), mid = a.length >> 1
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}

function stats(rec) {
  const byWorker = new Map()
  for (const r of rec) {
    if (!r.worker) continue
    const s = byWorker.get(r.worker) || { worker: r.worker, runs: 0, rejected: 0, waits: [] }
    s.runs++
    if (r.pm_verdict === 'reject') s.rejected++
    if (typeof r.wait_sec === 'number' && r.wait_sec >= 0) s.waits.push(r.wait_sec)
    byWorker.set(r.worker, s)
  }
  return [...byWorker.values()].map(s => ({
    ...s,
    // A median over zero measurements is not 0 — it is unknown, and the page
    // says so rather than inventing a confident number.
    medianWait: median(s.waits),
  })).sort((a, b) => b.runs - a.runs)
}

// ── RENDER ───────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const dur = (sec) => sec == null ? 'not measured'
  : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`

function render({ active, rec, notes, unclaimed }, now) {
  const attention = active.filter(a => ['died', 'unknown', 'unrecorded'].includes(a.state))
  const running = active.filter(a => ['running', 'starting', 'awaiting-verdict'].includes(a.state))
  const recent = [...rec].sort((a, b) => b.mtime - a.mtime).slice(0, 12)
  const st = stats(rec)
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 19) + 'Z'

  const row = (a) => `<tr>
    <td class="mono">${esc(a.id)}</td>
    <td><span class="pill ${a.state}">${a.state === 'died' ? 'DIED SILENTLY' : a.state}</span></td>
    <td>${esc(a.kind || '—')}</td>
    <td class="mono">${esc(a.detail || '')}</td>
    <td>${a.ageSec == null ? 'not measured' : dur(a.ageSec)}${a.timeoutSec ? ` <span class="dim">/ ${dur(a.timeoutSec)}</span>` : ''}</td>
    <td>${a.idleShell ? '<span class="warn">pane alive but its shell has no child — worker gone</span>' : a.dispatched === false ? '<span class="warn">no dispatch record</span>' : ''}</td>
  </tr>`

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>pulse — ${esc(REPO.split('/').pop())}</title>
<meta http-equiv="refresh" content="${INTERVAL}">
<style>
:root{--bg:#0f1216;--card:#161b22;--line:#262d36;--ink:#e6ebe9;--dim:#8b98a5;--ok:#4ac4a2;--warn:#d99b3d;--bad:#e0716a;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root{--bg:#f6f8f7;--card:#fff;--line:#dde3e1;--ink:#141a1f;--dim:#5f6b73;--ok:#12806a;--warn:#a06714;--bad:#b0413a}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:12px}
h1{font:600 20px var(--mono);margin:0;letter-spacing:-.01em}
.age{font:12px var(--mono);color:var(--dim);text-align:right}
.scope{font:12px var(--mono);color:var(--dim);margin:6px 0 0}
h2{font:600 14px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--dim);margin:32px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:640px}
th{text-align:left;font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--dim);padding:10px 14px;border-bottom:1px solid var(--line)}
td{padding:10px 14px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
.mono{font-family:var(--mono);font-size:13px}
.pill{display:inline-block;font:600 11px var(--mono);padding:2px 8px;border-radius:3px;text-transform:uppercase}
.pill.running{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.pill.starting{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.pill.awaiting-verdict{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.pill.unrecorded{background:color-mix(in srgb,var(--warn) 26%,transparent);color:var(--warn)}
.pill.died,.pill.unknown{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.warn{color:var(--warn);font-size:12px}.dim{color:var(--dim);font-size:12px}
.empty{padding:16px;color:var(--dim);font-size:14px}
.note{border-left:3px solid var(--warn);background:var(--card);padding:10px 14px;margin:10px 0;font-size:13px}
.verdict-reject{color:var(--bad)}.verdict-pass{color:var(--ok)}.verdict-unresolved{color:var(--warn)}
footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);font:12px var(--mono);color:var(--dim)}
</style></head><body><div class="wrap">

<header>
  <div>
    <h1>pulse · ${esc(REPO.split('/').pop())}</h1>
    <p class="scope">แสดงเฉพาะ worker ที่ระบบนี้สั่งในโปรเจกต์นี้ · อ่านอย่างเดียว</p>
  </div>
  <div class="age">อัปเดต ${stamp}<br>รีเฟรชทุก ${INTERVAL}s</div>
</header>

${notes.map(n => `<p class="note">⚠ ${esc(n)}</p>`).join('')}

<h2>ต้องการความสนใจ</h2>
<div class="card">${attention.length ? `<table>
<tr><th>งาน</th><th>สถานะ</th><th>ช่องทาง</th><th>ที่อยู่</th><th>เงียบมานาน</th><th>หมายเหตุ</th></tr>
${attention.map(row).join('')}</table>`
    : '<p class="empty">ไม่มีอะไรต้องดู — ไม่มีงานที่หายไปโดยไม่ทิ้งบันทึก</p>'}</div>

<h2>กำลังทำงาน</h2>
<div class="card">${running.length ? `<table>
<tr><th>งาน</th><th>สถานะ</th><th>ช่องทาง</th><th>ที่อยู่</th><th>ผ่านไป</th><th>หมายเหตุ</th></tr>
${running.map(row).join('')}</table>`
    : '<p class="empty">ไม่มี worker ทำงานอยู่</p>'}</div>

${unclaimed && unclaimed.length ? `<h2>รอยเท้าที่ยืนยันเจ้าของไม่ได้</h2>
<div class="card"><table>
<tr><th>งาน</th><th>อายุ</th><th>หมายเหตุ</th></tr>
${unclaimed.map(u => `<tr><td class="mono">${esc(u.id)}</td><td>${dur(Math.round((now - u.mtime) / 1000))}</td>
  <td><span class="warn">control dir ไม่ผูกกับโปรเจกต์ อาจเป็นของ repo อื่น</span></td></tr>`).join('')}
</table></div>` : ''}

<h2>บันทึกล่าสุด</h2>
<div class="card">${recent.length ? `<table>
<tr><th>งาน</th><th>worker</th><th>จบแบบ</th><th>คำตัดสิน PM</th><th>ใช้เวลา</th><th>บทเรียน</th></tr>
${recent.map(r => `<tr>
  <td class="mono">${esc(r.task_id)}</td><td>${esc(r.worker)}</td>
  <td class="mono">${esc(r.terminal || '—')}</td>
  <td class="verdict-${esc(r.pm_verdict)}">${esc(r.pm_verdict || '—')}</td>
  <td>${r.wait_sec == null || r.wait_sec < 0 ? 'not measured' : dur(r.wait_sec)}</td>
  <td>${esc(r.lesson && r.lesson !== 'none' ? r.lesson : '')}</td>
</tr>`).join('')}</table>`
    : '<p class="empty">ยังไม่มีบันทึก</p>'}</div>

<h2>ของสะสม</h2>
<div class="card">${st.length ? `<table>
<tr><th>worker</th><th>รอบทั้งหมด</th><th>ถูกตีตก</th><th>เวลากลาง</th></tr>
${st.map(s => `<tr><td>${esc(s.worker)}</td><td>${s.runs}</td>
  <td>${s.rejected ? `<span class="verdict-reject">${s.rejected}</span>` : '0'}</td>
  <td>${s.medianWait == null ? 'not measured' : dur(s.medianWait)}</td></tr>`).join('')}</table>`
    : '<p class="empty">ยังไม่มีข้อมูลพอ</p>'}</div>

<footer>
  หน้านี้ตรวจของจริง ไม่เชื่อไฟล์ที่ประกาศสถานะตัวเอง — งานที่ทิ้งรอยเท้าไว้แต่ไม่มีทั้งกระบวนการและบันทึก จะขึ้นว่า DIED SILENTLY
  · control dir ไม่ได้แยกตามโปรเจกต์ จึงติดป้าย ownership unconfirmed
  · ถ้าเวลาอัปเดตด้านบนหยุดเดิน แปลว่าตัวสังเกตการณ์ตาย ไม่ใช่ว่าไม่มีงาน
</footer>
</div></body></html>`
}

function once() {
  const now = Date.now()
  mkdirSync(STORE, { recursive: true })
  const ignore = join(STORE, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  writeFileSync(OUT, render(derive(now), now))
  return OUT
}

if (cmd === 'once') { console.log(once()); process.exit(0) }

console.log(`[pulse] watching ${REPO} every ${INTERVAL}s -> ${OUT}`)
console.log('[pulse] open that file in a browser; it refreshes itself')
const tick = () => { try { once() } catch (e) { console.error(`[pulse] render failed: ${e.message}`) } }
tick()
setInterval(tick, INTERVAL * 1000)
