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
//   pulse.mjs json <repo>                  render now; print one JSON document
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLsofCwd, parsePgrep, parsePsCandidates } from './pulse-platform.mjs'
import { ID_RE, PULSE_SCHEMA, PULSE_SCHEMA_VERSION, UUID_RE, projectPulseV1 } from './pulse-data.mjs'

const [cmd, repoArg, ...flags] = process.argv.slice(2)
const USAGE = 'usage: pulse.mjs once|json <repo> | pulse.mjs watch|ensure <repo> [--interval SEC]'
if (!cmd || !repoArg || !['once', 'json', 'watch', 'ensure'].includes(cmd)) { console.error(USAGE); process.exit(2) }

let REPO
try { REPO = realpathSync(repoArg) } catch { console.error(`[pulse] no such repo: ${repoArg}`); process.exit(2) }
const STORE = join(REPO, '.tmux-teams')
const OUT = join(STORE, 'pulse.html')
const JSON_OUT = join(STORE, 'pulse.json')
const EVENTS = join(STORE, 'kms', 'events')
const DISPATCH = join(STORE, 'dispatch')
const OUTBOX = join(REPO, '.mailbox-out')
const CTL = join(homedir(), '.tmux-teams', 'mailbox-run')
const WATCH_PID = join(STORE, 'pulse-watch.pid')
const PUBLISH_LOCK = join(STORE, 'pulse-publish.lock')
const THIS_SCRIPT = fileURLToPath(import.meta.url)
const MANAGED_WATCH = flags.includes('--managed')

const iFlag = flags.indexOf('--interval')
const INTERVAL = iFlag >= 0 && Number(flags[iFlag + 1]) > 0 ? Math.max(1, Math.ceil(Number(flags[iFlag + 1]))) : 20

// Startup is slower than it looks: an ACP lane may sit in `npx` downloading its
// adapter before anything exists to probe. Announcing death during a worker's
// own installation is the fastest way to make the alarm worthless. Where a pane
// id was recorded we check it directly and skip the guessing entirely.
const GRACE_SEC = 300
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_SOURCE_FILES = 1000
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024
const MAX_FIELD_CHARS = 256

function fieldValue(text, key) {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))
  if (!match) return ''
  const value = match[1].trim()
  return value.length <= MAX_FIELD_CHARS ? value : ''
}

const sh = (bin, args) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return '' }
}

function tmux(args) {
  try {
    return { available: true, out: execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    const stderr = String(e.stderr || '')
    const knownNoServer = /no server running|failed to connect to server|no current client/i.test(stderr) ||
      /^error connecting to .+ \(No such file or directory\)$/i.test(stderr.trim())
    if (e.status === 1 && knownNoServer) {
      return { available: true, out: '' }
    }
    return { available: false, out: '' }
  }
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
/** One tmux probe feeds both liveness rows and the recorded-pane decision. */
function paneInventory() {
  const probe = tmux(['list-panes', '-a', '-F', '#{session_name}|#{window_name}|#{pane_id}|#{pane_pid}'])
  const lines = probe.out.split('\n').filter(Boolean)
  return {
    available: probe.available,
    lines,
    ids: new Set(lines.map(line => line.split('|')[2]).filter(Boolean)),
  }
}

function aliveWorkers(panes) {
  const rows = [], notes = [], diagnostics = []
  if (!PROC_OK) {
    notes.push(DARWIN
      ? 'lsof did not report this process\'s cwd — liveness on this host is unverifiable, so "running" and "died" cannot be told apart'
      : 'cannot read /proc — liveness on this host is unverifiable, so "running" and "died" cannot be told apart')
    diagnostics.push({ code: 'LIVENESS_UNAVAILABLE', severity: 'error', source: 'liveness' })
  }
  if (!panes.available) diagnostics.push({ code: 'TMUX_UNAVAILABLE', severity: 'warning', source: 'tmux' })

  for (const line of panes.lines) {
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
  return { rows, notes, diagnostics }
}

// ── FOOTPRINTS ───────────────────────────────────────────────────────────────
// Only `<repo>/.mailbox-out/<id>` proves this repo dispatched the work. Control
// dirs live at ~/.tmux-teams/mailbox-run/<id>, keyed by worker id alone — two
// repos dispatching "task-1" share that path — so they are collected separately
// and never raise an alarm on their own. Counting them as ours is how a first
// render showed three DIED SILENTLY rows that all belonged to another project.
function footprints(inputBudget) {
  const byId = new Map()
  const diagnostics = []
  let dispatchHealth = 'ok', outboxHealth = 'ok'

  // The dispatch record is written by the PM the moment it dispatches, so it
  // survives a worker that dies before producing anything. Without it, the
  // truest silent death — dying before the first write — leaves no trace at
  // all, because dispatch DELETES any stale outbox first.
  let dispatches = []
  try { dispatches = readdirSync(DISPATCH).filter(f => f.endsWith('.md')) } catch (e) {
    if (e.code !== 'ENOENT') {
      dispatchHealth = 'degraded'
      diagnostics.push({ code: 'DISPATCH_UNREADABLE', severity: 'error', source: 'dispatch' })
    }
  }
  if (dispatches.length > MAX_SOURCE_FILES) {
    dispatchHealth = 'degraded'
    diagnostics.push({ code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'dispatch', count: dispatches.length - MAX_SOURCE_FILES })
    dispatches = dispatches.sort().slice(-MAX_SOURCE_FILES)
  }
  for (const f of dispatches) {
    const id = f.replace(/\.md$/, '')
    if (!ID_RE.test(id)) continue
    let st, text = ''
    try {
      st = statSync(join(DISPATCH, f))
      if (st.size > MAX_INPUT_BYTES) throw Object.assign(new Error('oversized'), { code: 'EFBIG' })
      if (st.size > inputBudget.remaining) {
        diagnostics.push({ code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'dispatch' })
        dispatchHealth = 'degraded'
        break
      }
      inputBudget.remaining -= st.size
      text = readFileSync(join(DISPATCH, f), 'utf8')
    } catch {
      diagnostics.push({ code: 'DISPATCH_UNREADABLE', severity: 'error', source: 'dispatch' })
      dispatchHealth = 'degraded'
      continue
    }
    const timeoutRaw = fieldValue(text, 'timeout_sec'), timeout = timeoutRaw === '' ? null : Number(timeoutRaw)
    const dispatchId = fieldValue(text, 'dispatch_id')
    byId.set(id, {
      id, mtime: st.mtimeMs, marker: '', terminalStatus: 'absent', dispatched: true, dispatchStatus: 'present',
      dispatchId: UUID_RE.test(dispatchId) ? dispatchId : '', startedAt: fieldValue(text, 'started_at'),
      timeoutSec: Number.isFinite(timeout) && timeout >= 0 ? timeout : null,
      transport: fieldValue(text, 'transport'), worker: fieldValue(text, 'worker'), pane: fieldValue(text, 'pane'),
    })
  }

  let names = []
  try { names = readdirSync(OUTBOX) } catch (e) {
    if (e.code !== 'ENOENT') {
      outboxHealth = 'degraded'
      diagnostics.push({ code: 'OUTBOX_UNREADABLE', severity: 'error', source: 'outbox' })
    }
  }
  if (names.length > MAX_SOURCE_FILES) {
    outboxHealth = 'degraded'
    diagnostics.push({ code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'outbox', count: names.length - MAX_SOURCE_FILES })
    names = names.sort().slice(-MAX_SOURCE_FILES)
  }
  for (const id of names) {
    if (id.startsWith('.')) continue
    if (!ID_RE.test(id)) continue
    const path = join(OUTBOX, id)
    let st, text = '', terminalStatus = 'absent'
    try {
      st = statSync(path)
      let file = path, fileStat = st
      if (st.isDirectory()) {
        const entries = readdirSync(path).filter(name => {
          try { return statSync(join(path, name)).isFile() } catch { return false }
        })
        if (entries.length !== 1) throw new Error('outbox directory needs exactly one file')
        file = join(path, entries[0])
        fileStat = statSync(file)
      }
      if (!fileStat.isFile() || fileStat.size > MAX_INPUT_BYTES) throw new Error('outbox unreadable or oversized')
      if (fileStat.size > inputBudget.remaining) {
        throw Object.assign(new Error('aggregate input budget exhausted'), { code: 'EBUDGET' })
      }
      inputBudget.remaining -= fileStat.size
      text = readFileSync(file, 'utf8')
      st = fileStat
    } catch (e) {
      if (e.code === 'EBUDGET') {
        diagnostics.push({ code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'outbox' })
        outboxHealth = 'degraded'
        break
      }
      terminalStatus = 'unreadable'
      outboxHealth = 'degraded'
      diagnostics.push({ code: 'OUTBOX_UNREADABLE', severity: 'error', source: 'outbox' })
    }
    // Same rule the PM wait loop uses: the LAST non-empty line, whole-line match.
    const last = text.split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
    const m = last.match(/^TEAM_(DONE|BLOCKED|FAILED)\s+(\S+)$/)
    const marker = m && m[2] === id ? `TEAM_${m[1]}` : ''
    if (marker) terminalStatus = 'present'
    const prev = byId.get(id) || {
      id, dispatched: false, dispatchStatus: 'absent', dispatchId: '', startedAt: '', timeoutSec: null,
    }
    byId.set(id, {
      ...prev, mtime: Math.max(st?.mtimeMs || 0, prev.mtime || 0), marker, terminalStatus,
    })
  }
  return {
    rows: [...byId.values()], diagnostics,
    health: { dispatch: dispatchHealth, outbox: outboxHealth },
  }
}

/** Control dirs that no live process claims — shown as context, never as alarms. */
function unclaimedControlDirs(liveIds, footIds) {
  let names = []
  try { names = readdirSync(CTL) } catch { return [] }
  return names
    .filter(id => ID_RE.test(id))
    .filter(id => !liveIds.has(id) && !footIds.has(id))
    .map(id => {
      try { return { id, mtime: statSync(join(CTL, id)).mtimeMs } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 8)
}

// ── RECORDED ─────────────────────────────────────────────────────────────────
function recorded(inputBudget) {
  let files = []
  const diagnostics = []
  let health = 'ok'
  try { files = readdirSync(EVENTS).filter(f => f.endsWith('.md')).sort() } catch (e) {
    if (e.code !== 'ENOENT') {
      health = 'degraded'
      diagnostics.push({ code: 'EVENT_UNREADABLE', severity: 'error', source: 'events' })
    }
  }
  if (files.length > MAX_SOURCE_FILES) {
    health = 'degraded'
    diagnostics.push({ code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'events', count: files.length - MAX_SOURCE_FILES })
    files = files.slice(-MAX_SOURCE_FILES)
  }
  const rows = []
  for (const f of files) {
    try {
      const path = join(EVENTS, f), st = statSync(path)
      if (!st.isFile() || st.size > MAX_INPUT_BYTES) throw new Error('event unreadable or oversized')
      if (st.size > inputBudget.remaining) {
        diagnostics.push({ code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'events' })
        health = 'degraded'
        break
      }
      inputBudget.remaining -= st.size
      const text = readFileSync(path, 'utf8')
      const num = (k) => {
        const raw = fieldValue(text, k)
        if (raw === '') return null
        const value = Number(raw)
        return Number.isFinite(value) ? value : null
      }
      const task = fieldValue(text, 'task_id'), worker = fieldValue(text, 'worker')
      if (!ID_RE.test(task) || !ID_RE.test(worker)) {
        health = 'degraded'
        diagnostics.push({ code: 'INVALID_EVENT_ENTRY', severity: 'warning', source: 'events' })
        continue
      }
      const dispatchId = fieldValue(text, 'dispatch_id')
      rows.push({
        task_id: task, worker, dispatch_id: UUID_RE.test(dispatchId) ? dispatchId : '',
        transport: fieldValue(text, 'transport'), terminal: fieldValue(text, 'terminal'),
        pm_verdict: fieldValue(text, 'pm_verdict'), started_at: fieldValue(text, 'started_at'),
        wait_sec: num('wait_sec'), timeout_sec: num('timeout_sec'),
        mtime: st.mtimeMs,
      })
    } catch {
      health = 'degraded'
      diagnostics.push({ code: 'EVENT_UNREADABLE', severity: 'error', source: 'events' })
    }
  }
  return { rows, diagnostics, health }
}

const PM_VERDICTS = new Set(['pass', 'reject', 'unresolved'])
const hasPmVerdict = (r) => PM_VERDICTS.has(r.pm_verdict)

// ── DERIVE ───────────────────────────────────────────────────────────────────
function derive(now) {
  const inputBudget = { remaining: MAX_TOTAL_INPUT_BYTES }
  const panesNow = paneInventory()
  const { rows: live, notes, diagnostics: liveDiagnostics } = aliveWorkers(panesNow)
  const footResult = footprints(inputBudget)
  const recordResult = recorded(inputBudget)
  const foot = footResult.rows, rec = recordResult.rows
  const diagnostics = [...liveDiagnostics, ...footResult.diagnostics, ...recordResult.diagnostics]
  // Worker ids get reused across runs, so an event only settles the footprint it
  // belongs to. Matching on id alone would let yesterday's record mark today's
  // dispatch "finished" and quietly drop it off the screen.
  const liveById = new Map(live.map(l => [l.id, l]))

  const active = []
  for (const f of foot) {
    const alive = liveById.get(f.id)
    const verdicts = rec.filter(r => {
      if (r.task_id !== f.id || !hasPmVerdict(r)) return false
      // Once the footprint has strong identity, never silently downgrade it.
      // Recency is only a compatibility path for a legacy footprint that has
      // no dispatch UUID of its own.
      if (f.dispatchId) return f.dispatchId === r.dispatch_id
      return r.mtime >= f.mtime - 1000
    }).sort((a, b) => b.mtime - a.mtime)
    const currentVerdict = verdicts[0] || null
    const settled = !!currentVerdict
    if (settled && !alive) continue                    // finished and recorded: history, not now
    const ageSec = Math.max(0, Math.round((now - f.mtime) / 1000))
    const startedMs = Date.parse(f.startedAt || '')
    const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.round((now - startedMs) / 1000)) : null
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
    const paneHeld = f.pane && panesNow.available ? panesNow.ids.has(f.pane) : null
    const paneStatus = !f.pane ? 'not_recorded' : !panesNow.available ? 'probe_unavailable' : paneHeld ? 'held' : 'gone'
    const state = working ? 'running'
      : !PROC_OK ? 'unknown'
      : f.terminalStatus === 'unreadable' ? 'unknown'
      : f.marker ? (ageSec > UNRECORDED_SEC ? 'unrecorded' : 'awaiting-verdict')
      : paneHeld === true ? 'starting'
      : paneHeld === false ? 'died'
      : f.pane && !panesNow.available ? 'unknown'
      : ageSec <= GRACE_SEC ? 'starting'
      : 'died'
    active.push({
      ...f, alive: !!alive, detail: alive ? alive.detail : '',
      kind: (alive && alive.kind) || f.transport || '', ageSec, elapsedSec, state,
      liveness: working ? 'alive' : PROC_OK ? 'dead' : 'unknown', paneStatus,
      pmVerdict: currentVerdict?.pm_verdict || '',
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
    active.push({
      id: l.id, marker: '', terminalStatus: 'absent', alive: true, liveness: 'alive',
      dispatched: false, dispatchStatus: 'absent', dispatchId: '', worker: '', transport: l.kind,
      kind: l.kind, detail: l.detail, ageSec: null, elapsedSec: null, timeoutSec: null,
      paneStatus: l.kind === 'tmux' ? 'held' : 'not_recorded', pmVerdict: '', state: 'orphan_running',
    })
  }
  const unclaimed = unclaimedControlDirs(new Set(live.map(l => l.id)), new Set(foot.map(f => f.id)))
  for (const code of [...new Set(diagnostics.map(d => d.code))]) {
    if (code !== 'LIVENESS_UNAVAILABLE') notes.push(`pulse source degraded: ${code}`)
  }
  return {
    active, rec, notes, unclaimed, diagnostics,
    sourceHealth: {
      liveness: PROC_OK ? 'ok' : 'unavailable',
      tmux: panesNow.available ? 'ok' : 'unavailable',
      dispatch: footResult.health.dispatch,
      outbox: footResult.health.outbox,
      events: recordResult.health,
    },
  }
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

function graphRows(snapshot) {
  const rows = []
  for (const run of snapshot.runs) {
    // "Reached" is about the PAST, not the present: a run that produced an
    // outbox was demonstrably alive at some point, even if it is gone now.
    // Mixing the two drew a solid line straight through a hollow dot.
    const terminalReached = ['done', 'blocked', 'failed'].includes(run.signals.terminal)
    const verdictReached = ['pass', 'reject', 'unresolved'].includes(run.signals.pm_verdict)
    rows.push({
      id: run.task_id, state: run.state, kind: run.transport,
      reached: [run.signals.dispatch === 'present', run.signals.liveness === 'alive' || terminalReached,
        terminalReached, verdictReached, verdictReached],
    })
  }
  // Finished runs are dropped from the live tables; the graph keeps a few so the
  // picture is not just alarms — you need the healthy shape to compare against.
  for (const event of snapshot.recent_verdicts) {
    if (rows.length >= 10) break
    if (rows.some(row => row.id === event.task_id)) continue
    // A run that ended TEAM_FAILED and was never resolved is not a green line.
    rows.push({
      id: event.task_id, kind: event.transport,
      state: event.pm_verdict === 'reject' ? 'rejected' : event.pm_verdict === 'pass' ? 'finished' : 'unresolved',
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
function renderLoop(snapshot) {
  const active = snapshot.runs
  const rec = snapshot.recent_verdicts
  const c = (xs) => xs.length
  const running = c(active.filter(a => ['running', 'starting'].includes(a.state)))
  const waiting = c(active.filter(a => a.state === 'awaiting-verdict'))
  const died = snapshot.summary.by_state.died
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
  const diedBranch =
    `<line class="l-edge l-bad" x1="${X + BW / 2 + 14}" y1="${dyy}" x2="${DX - 62}" y2="${dyy}" marker-end="url(#lbad)"/>` +
    `<text class="l-lbl l-bad-t" x="${X + BW / 2 + 20}" y="${dyy - 9}">ไม่มี marker</text>` +
    `<text class="l-lbl l-dim" x="${X + BW / 2 + 20}" y="${dyy + 16}">และไม่มีกระบวนการ</text>` +
    `<rect class="l-box l-bad-box" x="${DX - 60}" y="${dyy - 20}" width="124" height="40" rx="20"/>` +
    `<text class="l-t l-bad-t" x="${DX + 2}" y="${dyy - 2}" text-anchor="middle">ตายเงียบ</text>` +
    `<text class="l-s l-bad-t" x="${DX + 2}" y="${dyy + 13}" text-anchor="middle">${died}</text>`

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
     aria-label="ลูปการทำงานของระบบ">${defs}${spine}${yesEdge}${passEdge}${diedBranch}${reEdge}${recallEdge}` +
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

// HTML is a pure view of the published contract. It never receives the raw
// observations, so pulse.json is the sole source of truth for humans and agents.
function render(snapshot) {
  const active = snapshot.runs
  const rec = snapshot.recent_verdicts
  const notes = snapshot.diagnostics
  const unclaimed = snapshot.unclaimed_control
  const attention = active.filter(a => ['died', 'unknown', 'unrecorded', 'orphan_running'].includes(a.state))
  const running = active.filter(a => ['running', 'starting', 'awaiting-verdict'].includes(a.state))
  const recent = rec
  const st = snapshot.worker_stats
  const stamp = snapshot.generated_at.replace('T', ' ').slice(0, 19) + 'Z'
  const repoName = snapshot.scope.repo_name || 'unknown'
  const refreshInterval = snapshot.observation.refresh_interval_sec

  const row = (a) => `<tr>
    <td class="mono">${esc(a.task_id)}</td>
    <td><span class="pill ${a.state}">${a.state === 'died' ? 'DIED SILENTLY' : a.state}</span></td>
    <td>${esc(a.transport || '—')}</td>
    <td class="mono">${esc(a.dispatch_id || '—')}</td>
    <td>${a.silence_sec == null ? 'not measured' : dur(a.silence_sec)}${a.timeout_sec != null ? ` <span class="dim">/ ${dur(a.timeout_sec)}</span>` : ''}</td>
    <td><span class="${a.advisory.attention ? 'warn' : 'dim'}">${esc(a.advisory.action_code)}</span></td>
  </tr>`

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>pulse — ${esc(repoName)}</title>
<meta http-equiv="refresh" content="${refreshInterval}">
<meta name="tmux-teams-snapshot-id" content="${esc(snapshot.snapshot_id)}">
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
.pill.orphan_running{background:color-mix(in srgb,var(--warn) 26%,transparent);color:var(--warn)}
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
    <h1>pulse · ${esc(repoName)}</h1>
    <p class="scope">แสดงเฉพาะ worker ที่ระบบนี้สั่งในโปรเจกต์นี้ · อ่านอย่างเดียว</p>
  </div>
  <div class="age">อัปเดต ${stamp}<br>รีเฟรชทุก ${refreshInterval}s</div>
</header>

${notes.map(n => `<p class="note">⚠ ${esc(`${n.source}:${n.code}${n.count > 1 ? ` ×${n.count}` : ''}`)}</p>`).join('')}

<h2>ลูปของระบบ</h2>
<div class="card diagram">
  ${renderLoop(snapshot)}
  <p class="dim">เส้นประ = ทางที่รู้ว่ามีแต่ยังไม่มีใครวัด</p>
</div>

<h2>เส้นทางของแต่ละงาน</h2>
<div class="card graph">${renderGraph(graphRows(snapshot))}</div>

<h2>ต้องการความสนใจ</h2>
<div class="card">${attention.length ? `<table>
<tr><th>งาน</th><th>สถานะ</th><th>ช่องทาง</th><th>dispatch</th><th>เงียบมานาน</th><th>คำแนะนำ</th></tr>
${attention.map(row).join('')}</table>`
    : '<p class="empty">ไม่มีอะไรต้องดู — ไม่มีงานที่หายไปโดยไม่ทิ้งบันทึก</p>'}</div>

<h2>กำลังทำงาน</h2>
<div class="card">${running.length ? `<table>
<tr><th>งาน</th><th>สถานะ</th><th>ช่องทาง</th><th>dispatch</th><th>ผ่านไป</th><th>คำแนะนำ</th></tr>
${running.map(row).join('')}</table>`
    : '<p class="empty">ไม่มี worker ทำงานอยู่</p>'}</div>

${unclaimed && unclaimed.length ? `<h2>รอยเท้าที่ยืนยันเจ้าของไม่ได้</h2>
<div class="card"><table>
<tr><th>งาน</th><th>อายุ</th><th>หมายเหตุ</th></tr>
${unclaimed.map(u => `<tr><td class="mono">${esc(u.task_id)}</td><td>${dur(u.age_sec)}</td>
  <td><span class="warn">control dir ไม่ผูกกับโปรเจกต์ อาจเป็นของ repo อื่น</span></td></tr>`).join('')}
</table></div>` : ''}

<h2>บันทึกล่าสุด</h2>
<div class="card">${recent.length ? `<table>
<tr><th>งาน</th><th>worker</th><th>จบแบบ</th><th>คำตัดสิน PM</th><th>ใช้เวลา</th><th>dispatch</th></tr>
${recent.map(r => `<tr>
  <td class="mono">${esc(r.task_id)}</td><td>${esc(r.worker)}</td>
  <td class="mono">${esc(r.terminal || '—')}</td>
  <td class="verdict-${esc(r.pm_verdict)}">${esc(r.pm_verdict || '—')}</td>
  <td>${r.wait_sec == null || r.wait_sec < 0 ? 'not measured' : dur(r.wait_sec)}</td>
  <td class="mono">${esc(r.dispatch_id || '—')}</td>
</tr>`).join('')}</table>`
    : '<p class="empty">ยังไม่มีบันทึก</p>'}</div>

<h2>ของสะสม</h2>
<div class="card">${st.length ? `<table>
<tr><th>worker</th><th>รอบทั้งหมด</th><th>ถูกตีตก</th><th>เวลากลาง</th></tr>
${st.map(s => `<tr><td>${esc(s.worker)}</td><td>${s.runs}</td>
  <td>${s.rejected ? `<span class="verdict-reject">${s.rejected}</span>` : '0'}</td>
  <td>${s.median_wait_sec == null ? 'not measured' : dur(s.median_wait_sec)}</td></tr>`).join('')}</table>`
    : '<p class="empty">ยังไม่มีข้อมูลพอ</p>'}</div>

<footer>
  หน้านี้ตรวจของจริง ไม่เชื่อไฟล์ที่ประกาศสถานะตัวเอง — งานที่ทิ้งรอยเท้าไว้แต่ไม่มีทั้งกระบวนการและบันทึก จะขึ้นว่า DIED SILENTLY
  · control dir ไม่ได้แยกตามโปรเจกต์ จึงติดป้าย ownership unconfirmed
  · ถ้าเวลาอัปเดตด้านบนหยุดเดิน แปลว่าตัวสังเกตการณ์ตาย ไม่ใช่ว่าไม่มีงาน
</footer>
</div>
</body></html>`
}

const lockWait = new Int32Array(new SharedArrayBuffer(4))
const pause = (ms) => Atomics.wait(lockWait, 0, 0, ms)
const PUBLISH_LEASE_MS = 5 * 60_000

function readPublishToken() {
  try { return readFileSync(PUBLISH_LOCK, 'utf8').trim() }
  catch { return null }
}

function assertPublishLock(token) {
  if (readPublishToken() !== token) throw new Error('publish lock ownership lost')
}

function claimPublishLock() {
  mkdirSync(STORE, { recursive: true })
  const token = `${process.pid}:${randomUUID()}`
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      writeFileSync(PUBLISH_LOCK, `${token}\n`, { flag: 'wx' })
      return token
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let observed = null, owner = null, age = Infinity
      try {
        observed = readPublishToken()
        owner = Number(observed?.split(':', 1)[0])
        age = Date.now() - statSync(PUBLISH_LOCK).mtimeMs
      } catch { /* reclaim below */ }
      if (!pidAlive(owner) || age > PUBLISH_LEASE_MS) {
        // Re-read immediately before unlinking. A publisher that replaced the
        // stale claim in between must keep its lock. Every owner also checks
        // its token before each rename, so a reclaimed lease cannot publish.
        if (!observed || readPublishToken() !== observed) continue
        try { unlinkSync(PUBLISH_LOCK) } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError
        }
        continue
      }
      pause(5)
    }
  }
  throw new Error('publish lock busy')
}

function releasePublishLock(token) {
  try {
    if (readPublishToken() === token) unlinkSync(PUBLISH_LOCK)
  } catch { /* best effort */ }
}

function atomicWrite(path, content) {
  const temp = join(STORE, `.${path.split('/').pop()}.${process.pid}.${randomUUID()}.tmp`)
  let fd = null
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
  } catch (e) {
    if (fd !== null) try { closeSync(fd) } catch { /* best effort */ }
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw e
  }
}

function priorStream(view) {
  if (!existsSync(JSON_OUT)) return { streamId: randomUUID(), sequence: 1 }
  try {
    const prior = JSON.parse(readFileSync(JSON_OUT, 'utf8'))
    if (prior.schema !== PULSE_SCHEMA || prior.schema_version !== PULSE_SCHEMA_VERSION ||
        !UUID_RE.test(prior.stream_id) || !Number.isSafeInteger(prior.sequence) ||
        prior.sequence < 1 || prior.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('invalid prior pulse')
    return { streamId: prior.stream_id, sequence: prior.sequence + 1 }
  } catch {
    view.diagnostics.push({ code: 'SEQUENCE_RESET', severity: 'warning', source: 'publisher' })
    return { streamId: randomUUID(), sequence: 1 }
  }
}

function once() {
  const startedAt = Date.now()
  const view = derive(startedAt)
  const finishedAt = Date.now()
  mkdirSync(STORE, { recursive: true })
  const ignore = join(STORE, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const token = claimPublishLock()
  try {
    const stream = priorStream(view)
    const snapshot = projectPulseV1(view, {
      ...stream, startedAt, finishedAt, intervalSec: INTERVAL,
      repoName: REPO.split('/').pop(),
    })
    const jsonText = JSON.stringify(snapshot, null, 2) + '\n'
    // Render the exact serialized contract, not the internal projection object.
    // This makes pulse.json the literal SSOT and catches serialization drift.
    const publishedSnapshot = JSON.parse(jsonText)
    const html = render(publishedSnapshot)
    assertPublishLock(token)
    atomicWrite(JSON_OUT, jsonText)
    assertPublishLock(token)
    atomicWrite(OUT, html)
    return { htmlPath: OUT, jsonText, snapshot: publishedSnapshot }
  } finally {
    releasePublishLock(token)
  }
}

if (cmd === 'once' || cmd === 'json') {
  try {
    const result = once()
    if (cmd === 'json') process.stdout.write(result.jsonText)
    else console.log(result.htmlPath)
    process.exit(0)
  } catch (e) {
    console.error(`[pulse] publish failed: ${e.message}`)
    process.exit(1)
  }
}

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
  console.log(once().htmlPath)
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
