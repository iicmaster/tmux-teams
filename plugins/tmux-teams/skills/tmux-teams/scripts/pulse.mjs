#!/usr/bin/env node
// pulse.mjs — one screen showing what this repo's orchestration is doing now.
//
// Observation is read-only: it never dispatches or kills workers. `ensure`
// manages only this observer's repo-local pidfile and detached watch process.
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
//   pulse.mjs ensure <repo> [--interval 20] render now; idempotently keep watch alive
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLsofCwd, parsePgrep, parsePsCandidates } from './pulse-platform.mjs'

const [cmd, repoArg, ...flags] = process.argv.slice(2)
const USAGE = 'usage: pulse.mjs once <repo> | pulse.mjs watch|ensure <repo> [--interval SEC]'
if (!cmd || !repoArg || !['once', 'watch', 'ensure'].includes(cmd)) { console.error(USAGE); process.exit(2) }

let REPO
try { REPO = realpathSync(repoArg) } catch { console.error(`[pulse] no such repo: ${repoArg}`); process.exit(2) }
const STORE = join(REPO, '.tmux-teams')
const OUT = join(STORE, 'pulse.html')
const EVENTS = join(STORE, 'kms', 'events')
const DISPATCH = join(STORE, 'dispatch')
const OUTBOX = join(REPO, '.mailbox-out')
const CTL = join(homedir(), '.tmux-teams', 'mailbox-run')
const WATCH_PID = join(STORE, 'pulse-watch.pid')
const THIS_SCRIPT = fileURLToPath(import.meta.url)
const MANAGED_WATCH = flags.includes('--managed')

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

// Liveness is read from /proc on Linux and from lsof/pgrep on macOS, where
// no /proc exists. The abstraction is deliberately two primitives — cwd-of-pid
// and has-a-child — because that is all the rest of the file asks of the OS.
const DARWIN = process.platform === 'darwin'

/** cwd of a live pid, or null when the process is gone or unreadable. */
function cwdOf(pid) {
  if (DARWIN) {
    // `lsof -Fn -d cwd` prints one `n<path>` line for the cwd descriptor.
    const out = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const path = parseLsofCwd(out)
    if (!path) return null
    try { return realpathSync(path) } catch { return path }
  }
  try { return realpathSync(`/proc/${pid}/cwd`) } catch { return null }
}
const PROC_OK = cwdOf(process.pid) !== null

/** Does this pid have at least one child? A pane shell with none is idle.
 *  null = unknowable on this host; the callers treat null as "not idle". */
function hasChild(pid) {
  if (DARWIN) {
    // pgrep exits non-zero with no output when a pid has no children; the `sh`
    // helper maps that to '' — indistinguishable from pgrep being absent, but
    // pgrep ships with macOS, so an empty result means genuinely no child.
    return parsePgrep(sh('pgrep', ['-P', String(pid)]))
  }
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().length > 0 } catch { return null }
}

// An outbox with a terminal marker but no event is normal for as long as the PM
// takes to verify. Past this, the record is not late — it is missing.
const UNRECORDED_SEC = 900

/** Candidate ACP processes as {pid, cmdline}. On Linux we walk /proc; on macOS
 *  `ps` gives pid+command in one call and we prefilter by the companion name so
 *  the per-pid lsof in cwdOf() runs on a handful, not every process. */
function acpCandidates() {
  if (DARWIN) {
    return parsePsCandidates(sh('ps', ['-axww', '-o', 'pid=,command=']))
  }
  let pids = []
  try { pids = readdirSync('/proc').filter(d => /^\d+$/.test(d)) } catch { return [] }
  const out = []
  for (const pid of pids) {
    let cmdline = ''
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { continue }
    out.push({ pid, cmdline })
  }
  return out
}

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
  if (!PROC_OK) notes.push(DARWIN
    ? 'lsof did not report this process\'s cwd — liveness on this host is unverifiable, so "running" and "died" cannot be told apart'
    : 'cannot read /proc — liveness on this host is unverifiable, so "running" and "died" cannot be told apart')

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
    for (const { pid, cmdline } of acpCandidates()) {
      if (cwdOf(pid) !== REPO) continue
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
      event_kind: get('event_kind'), pm_verdict: get('pm_verdict'),
      lesson: get('lesson'), started_at: get('started_at'),
      wait_sec: num('wait_sec'), timeout_sec: num('timeout_sec'), stakes: get('stakes'),
      mtime: statSync(join(EVENTS, f)).mtimeMs,
    }
  })
}

const PM_VERDICTS = new Set(['pass', 'reject', 'unresolved'])
const hasPmVerdict = (r) => PM_VERDICTS.has(r.pm_verdict)

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
  for (const r of rec) {
    // ACP writes a transport-terminal event before the PM verifies anything.
    // It is useful history, but only an explicit PM verdict settles a run.
    if (r.task_id && hasPmVerdict(r)) recAt.set(r.task_id, Math.max(recAt.get(r.task_id) || 0, r.mtime))
  }
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
    // Where a pane id was recorded there is nothing left to guess, in EITHER
    // direction: still listed means the dispatch is intact (a cold `npx` can
    // outlast any timer), and gone means gone. The grace window is only for
    // dispatches with no pane to check. Killing a worker mid-run proved why:
    // the window kept reporting "starting" about a pane already destroyed.
    const paneHeld = f.pane ? panesNow.has(f.pane) : null
    const state = working ? 'running'
      : !PROC_OK ? 'unknown'
      : f.marker ? (ageSec > UNRECORDED_SEC ? 'unrecorded' : 'awaiting-verdict')
      : paneHeld === true ? 'starting'
      : paneHeld === false ? 'died'
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
  // But the SAME idle-shell rule applies here, and the first real run proved
  // why: a dispatch opens the session with an empty PM shell in window 0, whose
  // cwd is the repo, so it passed the ownership check and was reported as a
  // second running worker that does not exist.
  for (const l of live) {
    if (active.some(a => a.id === l.id)) continue
    if (l.kind === 'tmux' && l.hasChild === false) continue
    active.push({ id: l.id, marker: '', alive: true, kind: l.kind, detail: l.detail, ageSec: null, state: 'running' })
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
    // Mechanical transport facts are not another reviewed run. Counting both
    // halves would double totals and blend pre-verdict timing into PM history.
    if (!r.worker || !hasPmVerdict(r)) continue
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

// ── GRAPH ────────────────────────────────────────────────────────────────────
// Every dispatch walks the same five stages, so the honest picture of the graph
// is not a drawing of boxes and arrows — it is WHERE EACH RUN STOPPED. Each row
// is one worker; a filled dot is a stage reached, a hollow one is not. Read down
// the column and you see the shape of the run; read across and you see how far a
// single worker got before it finished, stalled or died.
//
// Hand-rolled SVG on purpose: no chart library, nothing fetched, works offline.
const STAGES = ['สั่งงาน', 'มีชีวิต', 'outbox', 'PM ตัดสิน', 'บันทึก']

function graphRows(active, rec) {
  const rows = []
  for (const a of active) {
    // "Reached" is about the PAST, not the present: a run that produced an
    // outbox was demonstrably alive at some point, even if it is gone now.
    // Mixing the two drew a solid line straight through a hollow dot.
    rows.push({
      id: a.id, state: a.state, kind: a.kind,
      reached: [true, a.alive || !!a.marker, !!a.marker, false, false],
    })
  }
  // Finished runs are dropped from the live tables; the graph keeps a few so the
  // picture is not just alarms — you need the healthy shape to compare against.
  for (const r of [...rec].filter(hasPmVerdict).sort((x, y) => y.mtime - x.mtime)) {
    if (rows.length >= 10) break
    if (rows.some(w => w.id === r.task_id)) continue
    // A run that ended TEAM_FAILED and was never resolved is not a green line.
    rows.push({
      id: r.task_id, kind: r.worker,
      state: r.pm_verdict === 'reject' ? 'rejected' : r.pm_verdict === 'pass' ? 'finished' : 'unresolved',
      reached: [true, true, true, true, true],
    })
  }
  return rows
}

// ── LOOP ─────────────────────────────────────────────────────────────────────
// The per-worker graph is one run walking a straight line. THIS is the system:
// a cycle with two back-edges — a rejected verdict returning to dispatch, and
// today's record feeding tomorrow's planning.
//
// Both back-edges are DASHED because neither is measured. We count rejects, but
// nothing records whether a reject was actually re-dispatched, and recall is
// opt-in and unlogged. Drawing them solid would claim the loop turns when
// nobody knows that it does.
//
// Hand-drawn SVG with a fixed layout, not a chart library: the shape of this
// loop is a constant, and a page whose job is to be true cannot depend on
// fetching a renderer that may not arrive.
function renderLoop(active, rec) {
  const c = (xs) => xs.length
  const running = c(active.filter(a => ['running', 'starting'].includes(a.state)))
  const waiting = c(active.filter(a => a.state === 'awaiting-verdict'))
  const dead = c(active.filter(a => ['died', 'unknown', 'unrecorded'].includes(a.state)))
  const pass = c(rec.filter(r => r.pm_verdict === 'pass'))
  const reject = c(rec.filter(r => r.pm_verdict === 'reject'))
  const unres = c(rec.filter(r => r.pm_verdict === 'unresolved'))

  const W = 720, X = 300, BW = 210, BH = 46, GAP = 26
  const nodes = [
    { k: 'box', t: 'วางแผน · sqthink', s: 'บรีฟ + verify_cmd + ลำดับ' },
    { k: 'box', t: 'สั่งงาน', s: `เขียน dispatch record · ค้าง ${active.length}` },
    { k: 'box', t: 'worker ทำงาน', s: `${running} กำลังวิ่ง` },
    { k: 'dia', t: 'มี outbox + marker?', s: '' },
    { k: 'box', t: 'PM ตรวจซ้ำ', s: `รัน verify_cmd เอง · ${waiting} รอตัดสิน` },
    { k: 'dia', t: 'คำตัดสิน', s: '' },
    { k: 'box', t: 'บันทึกเหตุการณ์', s: 'ทุกจุดจบ ไม่เฉพาะที่ผ่าน' },
    { k: 'store', t: 'ความจำ', s: `${rec.length} เหตุการณ์` },
  ]
  const y = (i) => 24 + i * (BH + GAP)
  const H = y(nodes.length - 1) + BH + 24
  const cy = (i) => y(i) + BH / 2

  const box = (n, i) => {
    const yy = y(i), half = BW / 2
    const shape = n.k === 'dia'
      ? `<polygon class="l-dia" points="${X},${yy - 6} ${X + half + 14},${cy(i)} ${X},${yy + BH + 6} ${X - half - 14},${cy(i)}"/>`
      : `<rect class="l-box${n.k === 'store' ? ' l-store' : ''}" x="${X - half}" y="${yy}" width="${BW}" height="${BH}" rx="${n.k === 'store' ? 22 : 5}"/>`
    const label = n.s
      ? `<text class="l-t" x="${X}" y="${cy(i) - 3}" text-anchor="middle">${esc(`${i + 1}. ${n.t}`)}</text>` +
        `<text class="l-s" x="${X}" y="${cy(i) + 12}" text-anchor="middle">${esc(n.s)}</text>`
      : `<text class="l-t" x="${X}" y="${cy(i) + 4}" text-anchor="middle">${esc(`${i + 1}. ${n.t}`)}</text>`
    return shape + label
  }

  const down = (i) => `<line class="l-edge" x1="${X}" y1="${y(i) + BH}" x2="${X}" y2="${y(i + 1)}" marker-end="url(#lh)"/>`
  // straight run down the spine, minus the two hops that carry their own labels
  const spine = [0, 1, 2, 4, 6].map(down).join('')

  const DX = X + BW / 2 + 195           // the died-silently branch sits off to the right
  const dyy = cy(3)
  const died =
    `<line class="l-edge l-bad" x1="${X + BW / 2 + 14}" y1="${dyy}" x2="${DX - 62}" y2="${dyy}" marker-end="url(#lbad)"/>` +
    `<text class="l-lbl l-bad-t" x="${X + BW / 2 + 20}" y="${dyy - 9}">ไม่มี marker</text>` +
    `<text class="l-lbl l-dim" x="${X + BW / 2 + 20}" y="${dyy + 16}">และไม่มีกระบวนการ</text>` +
    `<rect class="l-box l-bad-box" x="${DX - 60}" y="${dyy - 20}" width="124" height="40" rx="20"/>` +
    `<text class="l-t l-bad-t" x="${DX + 2}" y="${dyy - 2}" text-anchor="middle">ตายเงียบ</text>` +
    `<text class="l-s l-bad-t" x="${DX + 2}" y="${dyy + 13}" text-anchor="middle">${dead}</text>`

  const yesEdge = `<text class="l-lbl" x="${X + 8}" y="${(y(3) + BH + y(4)) / 2 + 4}">มี</text>` + down(3)
  const passEdge = `<text class="l-lbl" x="${X + 8}" y="${(y(5) + BH + y(6)) / 2 + 4}">pass ${pass} · unresolved ${unres}</text>` + down(5)

  // back-edges bow out to the left; dashed, because nothing counts these
  const LX = X - BW / 2 - 70, LX2 = LX - 46
  const reEdge =
    `<path class="l-edge l-dash" d="M ${X - BW / 2 - 14} ${cy(5)} H ${LX} V ${cy(1)} H ${X - BW / 2 - 4}" marker-end="url(#lh)"/>` +
    `<text class="l-lbl l-dim" x="${LX - 6}" y="${(cy(5) + cy(1)) / 2}" text-anchor="end" transform="rotate(-90 ${LX - 6} ${(cy(5) + cy(1)) / 2})">reject ${reject} · ไม่ได้วัดว่าถูกสั่งใหม่ไหม</text>`
  const recallEdge =
    `<path class="l-edge l-dash" d="M ${X - BW / 2 - 14} ${cy(7)} H ${LX2} V ${cy(0)} H ${X - BW / 2 - 4}" marker-end="url(#lh)"/>` +
    `<text class="l-lbl l-dim" x="${LX2 - 6}" y="${(cy(7) + cy(0)) / 2}" text-anchor="end" transform="rotate(-90 ${LX2 - 6} ${(cy(7) + cy(0)) / 2})">recall · opt-in และไม่มีใครบันทึก</text>`

  const defs = `<defs>
    <marker id="lh" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path class="l-head" d="M0,0 L8,4 L0,8 z"/></marker>
    <marker id="lbad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path class="l-head-bad" d="M0,0 L8,4 L0,8 z"/></marker>
  </defs>`

  return `<svg viewBox="-30 0 ${W} ${H}" width="100%" height="${H}" role="img"
     aria-label="ลูปการทำงานของระบบ">${defs}${spine}${yesEdge}${passEdge}${died}${reEdge}${recallEdge}` +
    nodes.map(box).join('') + `</svg>`
}

function renderGraph(rows) {
  if (!rows.length) return '<p class="empty">ยังไม่มีงานให้วาด</p>'
  const LEFT = 190, COL = 112, TOP = 34, ROW = 30
  const NAME_MAX = 22
  const w = LEFT + COL * (STAGES.length - 1) + 90
  const h = TOP + ROW * rows.length + 12
  const x = (i) => LEFT + COL * i
  const cls = (s) => ['died', 'unknown'].includes(s) ? 'g-bad'
    : ['finished', 'running'].includes(s) ? 'g-ok'
    : 'g-warn'

  const head = STAGES.map((s, i) =>
    `<text class="g-head" x="${x(i)}" y="18" text-anchor="middle">${esc(s)}</text>`).join('')

  const body = rows.map((r, n) => {
    const y = TOP + ROW * n + 10
    const c = cls(r.state)
    // The line only extends as far as the run actually got: a track drawn to the
    // end would imply progress that never happened.
    const lastReached = r.reached.lastIndexOf(true)
    const track = `<line class="g-track" x1="${x(0)}" y1="${y}" x2="${x(STAGES.length - 1)}" y2="${y}"/>` +
      (lastReached > 0 ? `<line class="g-line ${c}" x1="${x(0)}" y1="${y}" x2="${x(lastReached)}" y2="${y}"/>` : '')
    const dots = r.reached.map((on, i) =>
      `<circle class="${on ? `g-dot ${c}` : 'g-dot g-off'}" cx="${x(i)}" cy="${y}" r="${on ? 5 : 3.5}"/>`).join('')
    const name = r.id.length > NAME_MAX ? r.id.slice(0, NAME_MAX - 1) + '…' : r.id
    return `<g><text class="g-id" x="0" y="${y + 4}">${esc(name)}</text><title>${esc(r.id)}</title>${track}${dots}` +
      `<text class="g-tag ${c}" x="${x(STAGES.length - 1) + 16}" y="${y + 4}">${esc(r.state)}</text></g>`
  }).join('')

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
     aria-label="แต่ละงานเดินไปถึงขั้นไหน">${head}${body}</svg>`
}

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
.graph{padding:14px 16px}
.diagram{padding:16px;overflow-x:auto}
.l-box{fill:var(--card);stroke:var(--line);stroke-width:1.5}
.l-store{fill:var(--bg)}
.l-dia{fill:var(--card);stroke:var(--line);stroke-width:1.5}
.l-t{font:600 12px var(--mono);fill:var(--ink)}
.l-s{font:10.5px var(--mono);fill:var(--dim)}
.l-lbl{font:10.5px var(--mono);fill:var(--ink)}
.l-dim{fill:var(--dim)}
.l-edge{stroke:var(--line);stroke-width:1.8;fill:none}
.l-dash{stroke-dasharray:5 4}
.l-head{fill:var(--line)}.l-head-bad{fill:var(--bad)}
.l-bad{stroke:var(--bad)}.l-bad-t{fill:var(--bad)}.l-bad-box{stroke:var(--bad)}
.g-head{font:600 10px var(--mono);fill:var(--dim);letter-spacing:.06em;text-transform:uppercase}
.g-id{font:13px var(--mono);fill:var(--ink)}
.g-tag{font:10px var(--mono);fill:var(--dim);letter-spacing:.04em}
.g-track{stroke:var(--line);stroke-width:2}
.g-line{stroke-width:2.5}
.g-dot{stroke:var(--card);stroke-width:1.5}
.g-off{fill:var(--line);stroke:none}
.g-ok{stroke:var(--ok)}.g-ok.g-dot,.g-ok.g-tag{fill:var(--ok)}
.g-warn{stroke:var(--warn)}.g-warn.g-dot,.g-warn.g-tag{fill:var(--warn)}
.g-bad{stroke:var(--bad)}.g-bad.g-dot,.g-bad.g-tag{fill:var(--bad)}
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

<h2>ลูปของระบบ</h2>
<div class="card diagram">
  ${renderLoop(active, rec)}
  <p class="dim">เส้นประ = ทางที่รู้ว่ามีแต่ยังไม่มีใครวัด</p>
</div>

<h2>เส้นทางของแต่ละงาน</h2>
<div class="card graph">${renderGraph(graphRows(active, rec))}</div>

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
</div>
</body></html>`
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

function watcherPid() {
  try {
    const pid = Number(readFileSync(WATCH_PID, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code === 'EPERM' }
}

// Same single-operator O_EXCL pattern as deliver.sh: one caller claims the
// pidfile; another sees a live owner and backs off; a dead owner is reclaimed.
function claimWatcher() {
  mkdirSync(STORE, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(WATCH_PID, `${process.pid}\n`, { flag: 'wx' })
      return { claimed: true, pid: process.pid }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = watcherPid()
      if (pidAlive(pid)) return { claimed: false, pid }
      try { unlinkSync(WATCH_PID) } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  const pid = watcherPid()
  return { claimed: false, pid: pidAlive(pid) ? pid : null }
}

function releaseWatcher(pid = process.pid) {
  try { if (watcherPid() === pid) unlinkSync(WATCH_PID) } catch { /* best effort */ }
}

if (cmd === 'ensure') {
  console.log(once())
  const claim = claimWatcher()
  if (!claim.claimed) {
    if (!claim.pid) { console.error('[pulse] could not claim watcher pidfile'); process.exit(1) }
    console.log(`[pulse] watcher already running pid ${claim.pid}`)
    process.exit(0)
  }
  const child = spawn(process.execPath,
    [THIS_SCRIPT, 'watch', REPO, '--interval', String(INTERVAL), '--managed'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PULSE_WATCH_CLAIM_OWNER: String(process.pid) },
    })
  if (!child.pid) {
    releaseWatcher()
    console.error('[pulse] failed to start watcher')
    process.exit(1)
  }
  child.unref()
  // The child changes the pidfile from this claimant's pid to its own only
  // after installing signal cleanup. Do not tell cron "started" before that
  // handoff is real, or an immediate shutdown can strand a stale pidfile.
  let ready = false
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    if (watcherPid() === child.pid) { ready = true; break }
    if (!pidAlive(child.pid)) break
  }
  if (!ready) {
    try { process.kill(child.pid, 'SIGTERM') } catch { /* already gone */ }
    releaseWatcher()
    console.error('[pulse] watcher failed its pidfile handoff')
    process.exit(1)
  }
  console.log(`[pulse] watcher started pid ${child.pid}`)
  process.exit(0)
}

let managedClaimAccepted = false
if (MANAGED_WATCH) {
  const owner = Number(process.env.PULSE_WATCH_CLAIM_OWNER)
  const recorded = watcherPid()
  if (recorded !== process.pid && recorded !== owner) {
    console.error(`[pulse] watcher claim belongs to pid ${recorded ?? 'none'}; refusing duplicate`)
    process.exit(1)
  }
  managedClaimAccepted = true
} else {
  const claim = claimWatcher()
  if (!claim.claimed) {
    console.error(`[pulse] watcher already running pid ${claim.pid}`)
    process.exit(1)
  }
}

const cleanupWatcher = () => releaseWatcher(process.pid)
process.once('exit', cleanupWatcher)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanupWatcher(); process.exit(0) })
}
if (managedClaimAccepted) writeFileSync(WATCH_PID, `${process.pid}\n`)

console.log(`[pulse] watching ${REPO} every ${INTERVAL}s -> ${OUT}`)
console.log('[pulse] open that file in a browser; it refreshes itself')
const tick = () => {
  if (watcherPid() !== process.pid) {
    console.error('[pulse] watcher lost its pidfile claim; exiting')
    process.exit(1)
  }
  try { once() } catch (e) { console.error(`[pulse] render failed: ${e.message}`) }
}
if (!MANAGED_WATCH) tick()
setInterval(tick, INTERVAL * 1000)
