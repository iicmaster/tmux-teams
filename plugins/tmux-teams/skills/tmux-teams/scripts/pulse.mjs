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
//   pulse.mjs once  <repo> [--delivery-loop FILE]                 render once, print the path
//   pulse.mjs watch <repo> [--interval 20] [--delivery-loop FILE] re-render forever
//   pulse.mjs ensure <repo> [--interval 20] [--delivery-loop FILE] render now; keep watch alive
//   pulse.mjs json <repo> [--delivery-loop FILE]                  render now; print one JSON document
//   pulse.mjs compat-v1 <repo>                                    stdout-only v1 downprojection
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KANIT_FONT_CSS } from '../assets/kanit/kanit-embedded.mjs'
import { parseLsofCwd, parsePgrep, parsePsCandidates } from './pulse-platform.mjs'
import {
  ID_RE, PULSE_SCHEMA, PULSE_SCHEMA_VERSION, PULSE_SCHEMA_VERSION_V2, UUID_RE,
  downProjectPulseV1, projectPulseV1, projectPulseV2,
} from './pulse-data.mjs'
import { PHASE_BOUNDARIES, PHASE_EXIT_ARTIFACTS } from './delivery-loop-core.mjs'

const [cmd, repoArg, ...flags] = process.argv.slice(2)
const USAGE = 'usage: pulse.mjs once|json <repo> [--delivery-loop FILE] | pulse.mjs watch|ensure <repo> [--interval SEC] [--delivery-loop FILE] | pulse.mjs compat-v1 <repo>'
if (!cmd || !repoArg || !['once', 'json', 'watch', 'ensure', 'compat-v1'].includes(cmd)) {
  console.error(USAGE); process.exit(2)
}
const deliveryFlagIndexes = flags.flatMap((flag, index) => flag === '--delivery-loop' ? [index] : [])
if (cmd === 'compat-v1' && flags.length > 0 ||
    deliveryFlagIndexes.length > 1 ||
    (deliveryFlagIndexes.length === 1 &&
      (!flags[deliveryFlagIndexes[0] + 1] || flags[deliveryFlagIndexes[0] + 1].startsWith('--')))) {
  console.error(USAGE); process.exit(2)
}
const DELIVERY_LOOP_PATH = deliveryFlagIndexes.length
  ? resolve(flags[deliveryFlagIndexes[0] + 1])
  : null

let REPO
try { REPO = realpathSync(repoArg) } catch { console.error(`[pulse] no such repo: ${repoArg}`); process.exit(2) }
const STORE = join(REPO, '.tmux-teams')
const OUT = join(STORE, 'pulse.html')
const JSON_OUT = join(STORE, 'pulse.json')
const FONT_CSS_NAME = `pulse-fonts-${createHash('sha256').update(KANIT_FONT_CSS).digest('hex')}.css`
const FONT_CSS_OUT = join(STORE, FONT_CSS_NAME)
const EVENTS = join(STORE, 'kms', 'events')
const DISPATCH = join(STORE, 'dispatch')
const OUTBOX = join(REPO, '.mailbox-out')
const CTL = join(homedir(), '.tmux-teams', 'mailbox-run')
const WATCH_PID = join(STORE, 'pulse-watch.pid')
const WATCH_CONFIG = join(STORE, 'pulse-watch.config.json')
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
const dur = (sec) => sec == null ? 'ยังไม่วัด'
  : sec < 60 ? `${sec} วิ`
    : sec < 3600 ? `${Math.floor(sec / 60)} นาที${sec % 60 ? ` ${sec % 60} วิ` : ''}`
      : `${Math.floor(sec / 3600)} ชม.${Math.floor((sec % 3600) / 60) ? ` ${Math.floor((sec % 3600) / 60)} นาที` : ''}`
const THAI_TIME_ZONE = 'Asia/Bangkok'
const THAI_TIME_LABEL = 'เวลาไทย (UTC+7)'
const THAI_DATE_TIME = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: THAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function absoluteTime(value) {
  const text = thaiTimeText(value)
  if (text === 'ไม่ระบุ') return text
  return `<time datetime="${esc(value)}" title="${THAI_TIME_ZONE}">${text}</time>`
}

// Keep the date computation separately testable from its semantic HTML shell.
// Pulse timestamps are Gregorian calendar values in Thailand's UTC+7 timezone.
function thaiTimeText(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'ไม่ระบุ'
  const parts = Object.fromEntries(THAI_DATE_TIME.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${THAI_TIME_LABEL}`
}

// State codes stay stable for agents; people get one consistent Thai label.
// Keeping the mapping at the view boundary prevents UX copy from leaking into
// the versioned Pulse Data contract.
const STATE_COPY = Object.freeze({
  running: 'กำลังทำงาน',
  starting: 'กำลังเริ่มงาน',
  'awaiting-verdict': 'รอตรวจผล',
  unrecorded: 'ยังไม่บันทึกผล',
  died: 'หยุดโดยไม่มีบันทึก',
  unknown: 'ตรวจสถานะไม่ได้',
  orphan_running: 'ไม่พบเจ้าของงาน',
  finished: 'ผ่าน',
  rejected: 'ให้แก้ไข',
  unresolved: 'ยังไม่สรุป',
})
const ACTION_COPY = Object.freeze({
  monitor: 'ติดตามการทำงาน',
  wait: 'รอให้เริ่มงาน',
  verify_result: 'ตรวจผลลัพธ์',
  record_verdict: 'บันทึกคำตัดสิน',
  inspect_worker: 'ตรวจสอบ worker',
  restore_observability: 'กู้การตรวจสถานะ',
  inspect_ownership: 'ตรวจสอบเจ้าของงาน',
  verify_and_recommend_manual_hold: 'ตรวจสอบและเสนอพักงานด้วยคน',
  inspect_contract_violation: 'ตรวจสอบข้อมูลที่ผิดสัญญา',
  resolve_exception: 'แก้ข้อยกเว้น',
  review_handoff: 'ตรวจรับงานส่งมอบ',
  revise_artifact: 'แก้ไขชิ้นงานส่งมอบ',
  complete_measurement: 'เติมข้อมูลการวัด',
  continue_observation: 'ติดตามจนถึงเกณฑ์ครบ',
  export_evidence: 'ส่งออกชุดหลักฐาน',
  request_external_review: 'ขอผู้ตรวจอิสระทบทวน',
})
const TERMINAL_COPY = Object.freeze({
  done: 'เสร็จแล้ว', blocked: 'ติดข้อจำกัด', failed: 'ล้มเหลว',
  invalid: 'ข้อมูลไม่ถูกต้อง', absent: 'ยังไม่มีข้อมูล',
})
const VERDICT_COPY = Object.freeze({
  pass: 'ผ่าน', reject: 'ให้แก้ไข', unresolved: 'ยังไม่สรุป', absent: 'ยังไม่มีคำตัดสิน',
})
const DIAGNOSTIC_COPY = Object.freeze({
  LIVENESS_UNAVAILABLE: 'ตรวจสถานะ process ไม่ได้',
  TMUX_UNAVAILABLE: 'เชื่อมต่อ tmux ไม่ได้',
  DISPATCH_UNREADABLE: 'อ่านข้อมูลการสั่งงานไม่ได้',
  OUTBOX_UNREADABLE: 'อ่านผลลัพธ์จาก worker ไม่ได้',
  EVENT_UNREADABLE: 'อ่านบันทึกเหตุการณ์ไม่ได้',
  INVALID_EVENT_ENTRY: 'พบบันทึกเหตุการณ์ที่ไม่ถูกต้อง',
  SOURCE_TRUNCATED: 'ข้อมูลต้นทางถูกจำกัดเพื่อความปลอดภัย',
  SEQUENCE_RESET: 'เริ่มลำดับ snapshot ใหม่',
  SCHEMA_UPGRADED: 'อัปเกรดข้อมูล Pulse เป็นรุ่นใหม่',
  DELIVERY_LOOP_INPUT_UNREADABLE: 'อ่านข้อมูลวงรอบส่งมอบไม่ได้',
  DELIVERY_LOOP_INPUT_INVALID: 'ข้อมูลวงรอบส่งมอบไม่ผ่านสัญญา',
  DELIVERY_LOOP_STALE: 'ข้อมูลวงรอบส่งมอบหมดอายุ',
})
const DELIVERY_PHASE_COPY = Object.freeze({
  Requirement: 'ข้อกำหนด (Requirement)',
  Prototype: 'ต้นแบบ (Prototype)',
  Development: 'พัฒนา (Development)',
  QA: 'ทดสอบ (QA)',
})
const DELIVERY_BOUNDARY_COPY = Object.freeze({
  requirement_to_prototype: 'Requirement → Prototype',
  prototype_to_development: 'Prototype → Development',
  development_to_qa: 'Development → QA',
  qa_to_project_delivery: 'QA → ProjectDelivery',
})
const DELIVERY_PHASE_LABEL = Object.freeze({
  Requirement: 'ข้อกำหนด', Prototype: 'ต้นแบบ', Development: 'พัฒนา', QA: 'ทดสอบ',
  ProjectDelivery: 'ส่งมอบโครงการ',
})
const DELIVERY_ARTIFACT_LABEL = Object.freeze({
  requirements_baseline: 'ฐานข้อกำหนด',
  prototype_evaluation: 'ผลประเมินต้นแบบที่คลิกได้',
  development_delivery: 'ซอฟต์แวร์ที่ใช้งานได้',
  qa_release_evidence: 'รายงาน E2E / UAT',
})
const boundaryKey = (sender, receiver) => `${sender.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}_to_${receiver.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`
// This is the sole diagram model. Contract exports determine every actor,
// receiver, artifact and stable boundary key; Thai labels remain view-only.
const DELIVERY_TOPOLOGY = Object.freeze(Object.entries(PHASE_BOUNDARIES).map(([sender, receiver]) => Object.freeze({
  sender,
  receiver,
  artifact: PHASE_EXIT_ARTIFACTS[sender],
  artifactLabel: DELIVERY_ARTIFACT_LABEL[PHASE_EXIT_ARTIFACTS[sender]],
  boundary: boundaryKey(sender, receiver),
})))
const DELIVERY_STATUS_COPY = Object.freeze({
  not_configured: 'ยังไม่ได้ตั้งค่า',
  ready: 'พร้อมเริ่ม',
  active: 'กำลังเก็บหลักฐาน',
  paused: 'พักการทดลอง',
  complete: 'เก็บหลักฐานครบ',
  degraded: 'ข้อมูลต้องตรวจสอบ',
})
const DELIVERY_PHASE_STATE_COPY = Object.freeze({
  idle: 'ยังไม่มีงาน',
  active: 'กำลังทำงาน',
  waiting_receiver: 'รอทีมผู้รับตรวจ',
  rework: 'กำลังแก้ไข',
  exception: 'มีข้อยกเว้น',
  complete: 'ผ่านเฟสแล้ว',
  unknown: 'ตรวจสถานะไม่ได้',
})
const DELIVERY_ROLE_COPY = Object.freeze({
  operator: 'ผู้ดูแลระบบ',
  pm: 'PM',
  sender_phase_lead: 'ทีมผู้ส่ง',
  receiver_phase_lead: 'ทีมผู้รับ',
  experiment_owner: 'เจ้าของการทดลอง',
  metric_producer: 'ผู้ผลิตข้อมูลวัดผล',
  qa: 'QA',
  external_reviewer: 'ผู้ตรวจอิสระ',
  business_owner: 'เจ้าของธุรกิจ',
})
const DELIVERY_DECISION_COPY = Object.freeze({
  EXTERNAL_REQUIRED: 'ต้องให้ผู้มีอำนาจภายนอกตัดสิน',
})
const stateLabel = (state) => STATE_COPY[state] || 'ไม่ทราบสถานะ'
const actionLabel = (action) => ACTION_COPY[action] || 'ตรวจสอบรายละเอียด'
const terminalLabel = (terminal) => TERMINAL_COPY[terminal] || 'ยังไม่มีข้อมูล'
const verdictLabel = (verdict) => VERDICT_COPY[verdict] || 'ยังไม่มีคำตัดสิน'
const transportLabel = (transport) => transport === 'acp' ? 'ACP' : transport === 'tmux' ? 'tmux' : 'ไม่ระบุ'

// ── GRAPH ────────────────────────────────────────────────────────────────────
// Every dispatch walks the same five stages, so the honest picture of the graph
// is not a drawing of boxes and arrows — it is WHERE EACH RUN STOPPED. Each row
// is one worker; a filled dot is a stage reached, a hollow one is not. Read down
// the column and you see the shape of the run; read across and you see how far a
// single worker got before it finished, stalled or died.
//
// Hand-rolled SVG on purpose: no chart library, nothing fetched, works offline.
const STAGES = ['สั่งงาน', 'เริ่มทำงาน', 'ส่งผลลัพธ์', 'ตรวจผล', 'บันทึกผล']

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

// ── TWO-LAYER WORKER LOOP ────────────────────────────────────────────────────
// The worker lifecycle sits INSIDE a phase team. Routine worker review belongs
// to that team; PM coordinates the outer phase/handoff loop and intervenes only
// for exceptions, deadlocks, policy conflicts, or bottlenecks. Keeping both
// layers in one SVG makes that ownership boundary visible instead of implying
// that every worker result must climb back to PM.
//
// Counts are observed from today's dispatch/verdict evidence. The role model
// and back-edges are normative: re-dispatch and history recall are dashed
// because Pulse does not yet measure whether those transitions actually fire.
//
// Hand-drawn SVG with a fixed layout, not a chart library: it stays offline and
// cannot fail because an external renderer did not arrive.
function renderLoop(snapshot) {
  const rec = snapshot.recent_verdicts
  const c = (xs) => xs.length
  const byState = snapshot.summary.by_state
  const running = byState.running + byState.starting
  const waiting = byState['awaiting-verdict']
  const died = byState.died
  const pass = c(rec.filter(r => r.pm_verdict === 'pass'))
  const reject = c(rec.filter(r => r.pm_verdict === 'reject'))
  const unres = c(rec.filter(r => r.pm_verdict === 'unresolved'))

  const defs = `<defs>
    <marker id="lh" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path class="l-head" d="M0,0 L8,4 L0,8 z"/></marker>
    <marker id="lbad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path class="l-head-bad" d="M0,0 L8,4 L0,8 z"/></marker>
  </defs>`

  const box = (x, y, w, title, copy, extra = '') => `<g>${extra}<rect class="l-box" x="${x}" y="${y}" width="${w}" height="58" rx="8"/><text class="wl-node-title" x="${x + w / 2}" y="${y + 24}" text-anchor="middle">${esc(title)}</text><text class="wl-node-copy" x="${x + w / 2}" y="${y + 42}" text-anchor="middle">${esc(copy)}</text></g>`
  const arrow = (x1, y1, x2, y2, cls = 'l-edge', marker = 'lh') =>
    `<path class="${cls}" d="M ${x1} ${y1} L ${x2} ${y2}" marker-end="url(#${marker})"/>`

  const outer =
    `<rect class="wl-lane" x="20" y="28" width="1040" height="160" rx="18"/>` +
    `<text class="wl-lane-title" x="48" y="56">ลูปชั้นนอก · PM ติดตาม phase และ handoff</text>` +
    `<text class="wl-lane-copy" x="48" y="75">PM ไม่รับตรวจ worker ตามปกติ · เข้ามาเมื่อเกิด exception, deadlock, policy conflict หรือ bottleneck</text>` +
    box(55, 98, 190, 'PM ติดตามภาพรวม', `หลักฐานที่ต้องติดตาม ${snapshot.summary.active} · ผิดปกติ ${died + unres}`) +
    box(315, 98, 190, 'ทีมเฟสเป็นเจ้าของ', `ผล worker รอตรวจ ${waiting}`) +
    `<g><rect class="wl-artifact" x="575" y="98" width="190" height="58" rx="20"/><text class="wl-node-title" x="670" y="122" text-anchor="middle">ประกอบ exit artifact</text><text class="wl-node-copy" x="670" y="140" text-anchor="middle">ส่งมอบเมื่อ phase contract ผ่าน</text></g>` +
    box(835, 98, 190, 'ทีมถัดไปรับ/ปฏิเสธ', 'receiver owns validation') +
    arrow(245, 127, 315, 127) + arrow(505, 127, 575, 127) + arrow(765, 127, 835, 127) +
    `<path class="l-edge wl-unmeasured" d="M 930 156 V 174 H 410 V 158" marker-end="url(#lh)"/>` +
    `<text class="wl-unmeasured-copy" x="670" y="181" text-anchor="middle">reject → ผู้ส่งสร้าง attempt ใหม่ · ยังไม่วัดการวนจริง</text>`

  const inner =
    `<rect class="wl-lane wl-lane-inner" x="120" y="224" width="920" height="320" rx="18"/>` +
    `<text class="wl-lane-title" x="148" y="254">ลูปชั้นใน · ทีมเฟสเป็นเจ้าของการตรวจ worker</text>` +
    `<text class="wl-lane-copy" x="148" y="273">แต่ละทีมแตกงาน ส่ง worker ตรวจหลักฐาน และวนแก้ภายในก่อนสร้างชิ้นงานส่งมอบ</text>` +
    box(150, 300, 150, 'วางแผน slice', 'บรีฟ · validation · risks') +
    box(345, 300, 150, 'ส่งงานให้ worker', `${snapshot.summary.active} dispatch ยังไม่จบ`) +
    box(540, 300, 150, 'worker ส่งหลักฐาน', `${running} งานกำลังเดิน`) +
    `<g><polygon class="l-dia" points="820,292 918,329 820,366 722,329"/><text class="wl-node-title" x="820" y="326" text-anchor="middle">ทีมตรวจผล</text><text class="wl-node-copy" x="820" y="344" text-anchor="middle">หลักฐานเดิม: ผ่าน ${pass} · แก้ ${reject} · ค้าง ${unres}</text></g>` +
    arrow(300, 329, 345, 329) + arrow(495, 329, 540, 329) + arrow(690, 329, 722, 329) +
    `<path class="l-edge wl-pass" d="M 820 292 V 210 H 670 V 158" marker-end="url(#lh)"/>` +
    `<text class="wl-unmeasured-copy" x="835" y="211">ผ่าน → รวมเป็น exit artifact</text>` +
    `<path class="l-edge wl-unmeasured" d="M 820 366 V 405 H 420 V 360" marker-end="url(#lh)"/>` +
    `<text class="wl-unmeasured-copy" x="620" y="422" text-anchor="middle">ให้แก้ไข ${reject} · สร้าง dispatch/attempt ใหม่ · ยังไม่วัดการส่งซ้ำ</text>` +
    `<path class="l-edge l-bad" d="M 615 358 V 469 H 730" marker-end="url(#lbad)"/>` +
    `<text class="wl-exception-copy" x="665" y="438" text-anchor="middle">ไม่พบผลลัพธ์</text>` +
    `<text class="wl-exception-copy" x="665" y="453" text-anchor="middle">และไม่พบ process</text>` +
    `<rect class="l-box l-bad-box" x="732" y="448" width="140" height="42" rx="21"/>` +
    `<text class="l-t l-bad-t" x="802" y="465" text-anchor="middle">หยุดผิดปกติ</text>` +
    `<text class="l-s l-bad-t" x="802" y="482" text-anchor="middle">${died}</text>` +
    `<path class="l-edge wl-exception" d="M 872 469 H 1010 V 82 H 150 V 96" marker-end="url(#lbad)"/>` +
    `<text class="wl-exception-copy" x="1018" y="278" text-anchor="middle" transform="rotate(-90 1018 278)">PM รับเฉพาะข้อยกเว้น</text>` +
    `<path class="l-edge wl-unmeasured" d="M 670 156 V 514 H 225 V 360" marker-end="url(#lh)"/>` +
    `<text class="wl-unmeasured-copy" x="455" y="530" text-anchor="middle">นำประวัติ/ผล handoff มาวางแผนรอบถัดไป · เปิดตามต้องการ</text>`

  return `<svg id="dispatch-lifecycle-svg" class="worker-loop-svg" viewBox="0 0 1080 570" width="100%" height="570" role="img"
     aria-labelledby="worker-lifecycle-title worker-lifecycle-desc"><title id="worker-lifecycle-title">โมเดลเชิงบรรทัดฐานของลูปสองชั้นสำหรับ worker และการส่งมอบ</title><desc id="worker-lifecycle-desc">แบบจำลองความรับผิดชอบ ไม่ใช่สถานะสด: ลูปชั้นในให้ทีมเฟสวางแผน สั่ง worker และตรวจผลเอง ลูปชั้นนอกให้ PM ติดตาม phase และ handoff โดยรับเฉพาะข้อยกเว้น ตัวเลขมาจากหลักฐาน dispatch และ verdict เดิม ส่วนเส้นย้อนกลับที่ยังไม่ได้วัดแสดงด้วยเส้นประ</desc>${defs}${outer}${inner}</svg>`
}

function renderDeliveryFlow(delivery) {
  const selected = delivery.experiment?.boundary
  const selectedKnown = DELIVERY_TOPOLOGY.some(edge => edge.boundary === selected)
  const W = 1120, H = 430
  const x = { Requirement: 20, Prototype: 245, Development: 470, QA: 695, ProjectDelivery: 920 }
  const y = 150, w = 180, h = 145
  const artifactText = (artifact, xx, yy, className = 'df-artifact') => {
    const parts = artifact.split('_')
    return `<text class="${className}" x="${xx}" y="${yy}" text-anchor="middle">${parts.map((part, index) => `<tspan x="${xx}" dy="${index ? 11 : 0}">${esc(`${part}${index < parts.length - 1 ? '_' : ''}`)}</tspan>`).join('')}</text>`
  }
  const node = (phase) => {
    const isFinal = phase === 'ProjectDelivery'
    const label = DELIVERY_PHASE_LABEL[phase] || phase
    const artifact = isFinal ? 'รับหลักฐาน QA' : PHASE_EXIT_ARTIFACTS[phase]
    const incoming = DELIVERY_TOPOLOGY.find(edge => edge.receiver === phase)
    return `<g class="df-node${isFinal ? ' df-final' : ''}">
      <rect x="${x[phase]}" y="${y}" width="${w}" height="${h}" rx="12"/>
      <text class="df-title" x="${x[phase] + w / 2}" y="${y + 28}" text-anchor="middle">${esc(label)}</text>
      ${isFinal
        ? `<text class="df-copy" x="${x[phase] + w / 2}" y="${y + 52}" text-anchor="middle">ผู้รับปลายทาง · ตรวจรับจาก QA</text><text class="df-copy" x="${x[phase] + w / 2}" y="${y + 78}" text-anchor="middle">ไม่ใช่ทีมลูปที่ห้า</text><text class="df-copy" x="${x[phase] + w / 2}" y="${y + 106}" text-anchor="middle">รับ ≠ รับรอง/อนุมัติธุรกิจ</text>`
        : `<path class="df-loop" d="M ${x[phase] + 42} ${y + 118} C ${x[phase] + 18} ${y + 118}, ${x[phase] + 18} ${y + 72}, ${x[phase] + 42} ${y + 72}" marker-end="url(#df-head)"/><text class="df-copy" x="${x[phase] + 100}" y="${y + 50}" text-anchor="middle">${incoming ? `ผู้รับตรวจรับจาก${esc(DELIVERY_PHASE_LABEL[incoming.sender])}` : 'เริ่มจากข้อกำหนดธุรกิจ'}</text><text class="df-copy" x="${x[phase] + 100}" y="${y + 69}" text-anchor="middle">ทีมภายในตรวจ/แก้</text>${artifactText(artifact, x[phase] + w / 2, y + 87)}<text class="df-copy" x="${x[phase] + w / 2}" y="${y + 136}" text-anchor="middle">สร้างข้อเสนอใหม่เมื่อแก้</text>`}
    </g>`
  }
  const edges = DELIVERY_TOPOLOGY.map(edge => {
    const left = x[edge.sender] + w, right = x[edge.receiver]
    const isSelected = selectedKnown && edge.boundary === selected
    const mid = (left + right) / 2
    return `<g class="df-edge${isSelected ? ' df-selected' : ''}" data-boundary="${edge.boundary}" data-selected="${isSelected ? 'true' : 'false'}" data-observed="${isSelected ? 'true' : 'false'}">
      <path d="M ${left} ${y + 49} H ${right - 8}" marker-end="url(#df-head)"/>
      <text class="df-artifact-label" x="${mid}" y="${y - 55}" text-anchor="middle">${esc(edge.artifactLabel)}</text>
      ${artifactText(edge.artifact, mid, y - 31)}
      ${isSelected ? `<text class="df-observed" x="${mid}" y="${y + h + 24}" text-anchor="middle">★ pilot ที่สังเกต: ${esc(edge.boundary)}</text>` : ''}
    </g>`
  }).join('')
  const exceptionEdges = [...Object.keys(PHASE_EXIT_ARTIFACTS), 'ProjectDelivery']
    .map(phase => `<path class="df-exception" d="M ${x[phase] + w / 2} ${y} V 94" marker-end="url(#df-head)"/>`)
    .join('')
  const selectedCopy = selectedKnown
    ? `เน้นเฉพาะขอบเขต pilot ที่สังเกต: ${selected}`
    : 'ยังไม่ได้เลือกขอบเขต pilot ที่ยืนยันได้ จึงไม่เน้นเส้นใด'
  return `<div class="diagram-scroll" tabindex="0" role="region" aria-label="แผนภาพโมเดลการส่งมอบแบบเลื่อนแนวนอนได้"><svg id="delivery-topology-svg" class="delivery-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-labelledby="delivery-flow-title delivery-flow-desc" data-selected-boundary="${esc(selectedKnown ? selected : '')}">
    <title id="delivery-flow-title">โมเดลเส้นทางส่งมอบแบบผู้รับเป็นเจ้าของการตรวจรับ</title><desc id="delivery-flow-desc">แบบจำลองเชิงบรรทัดฐาน ไม่ใช่สถานะจริง: ทีม Requirement Prototype Development และ QA มีลูปภายใน ส่งชิ้นงานให้ผู้รับตรวจรับ และ PM ประสานเฉพาะข้อยกเว้น</desc>
    <defs><marker id="df-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>
    <rect class="df-pm" x="10" y="22" width="1100" height="395" rx="18"/><text class="df-pm-label" x="32" y="50">PM outer loop: ประสาน ติด bottleneck และแก้ข้อยกเว้นเท่านั้น — ไม่ตรวจรับแทนทีมผู้รับ</text>
    ${exceptionEdges}<text class="df-exception-label" x="560" y="407" text-anchor="middle">exception / deadlock / policy conflict → PM resolve_exception → กลับให้ผู้รับตัดสิน</text>
    ${edges}${[...Object.keys(PHASE_EXIT_ARTIFACTS), 'ProjectDelivery'].map(node).join('')}
  </svg></div><p class="diagram-note"><strong>โมเดลเชิงบรรทัดฐานเพื่อการเรียนรู้</strong> ไม่ใช่สถานะงานจริง; ${esc(selectedCopy)}. การตรวจรับเป็นการตัดสินใจของผู้รับ ไม่เท่ากับส่งมอบสำเร็จ การรับรอง หรือการอนุมัติทางธุรกิจ.</p>`
}

function renderDeliveryFlowEquivalent() {
  return `<section class="diagram-equivalent" aria-labelledby="delivery-flow-equivalent-title"><h3 id="delivery-flow-equivalent-title">ข้อความเทียบเท่าแผนภาพการส่งมอบ</h3><p>PM ประสาน ติด bottleneck และแก้ข้อยกเว้นเท่านั้น; งานปกติและการตรวจรับอยู่กับทีมผู้รับ.</p><ol>${DELIVERY_TOPOLOGY.map(edge => `<li><strong>${esc(DELIVERY_PHASE_LABEL[edge.sender])}</strong> ส่ง ${esc(edge.artifactLabel)} <code>${esc(edge.artifact)}</code> เป็นข้อเสนอให้ <strong>${esc(DELIVERY_PHASE_LABEL[edge.receiver])}</strong>; ผู้รับเป็นเจ้าของการตรวจรับและการรับ/ปฏิเสธ. ${edge.receiver === 'ProjectDelivery' ? 'ProjectDelivery เป็นผู้รับปลายทาง ไม่ใช่ทีมลูปที่ห้า; การรับไม่ใช่การรับรองหรืออนุมัติธุรกิจ.' : 'ทีมผู้ส่งทำลูปภายในและสร้างข้อเสนอใหม่เมื่อต้องแก้ไข.'}</li>`).join('')}</ol></section>`
}

function renderDeliverySequence(delivery) {
  const selected = DELIVERY_TOPOLOGY.find(edge => edge.boundary === delivery.experiment?.boundary)
  const boundaryCopy = selected
    ? `${DELIVERY_PHASE_LABEL[selected.sender]} → ${DELIVERY_PHASE_LABEL[selected.receiver]}`
    : 'ยังไม่มีขอบเขต pilot ที่ยืนยันได้'
  return `<div class="diagram-scroll" tabindex="0" role="region" aria-label="แผนภาพลำดับการส่งมอบแบบเลื่อนแนวนอนได้"><svg id="handoff-sequence-svg" class="sequence-svg" viewBox="0 0 980 360" width="100%" height="360" role="img" aria-labelledby="delivery-sequence-title delivery-sequence-desc" data-selected-boundary="${esc(selected?.boundary || '')}"><title id="delivery-sequence-title">ลำดับทั่วไปของการส่งมอบโดยผู้รับเป็นเจ้าของ</title><desc id="delivery-sequence-desc">ผู้ส่งเสนอชิ้นงานถาวรหนึ่งความพยายาม ผู้รับตรวจและเลือกยอมรับหรือปฏิเสธ การปฏิเสธสิ้นสุดความพยายามเดิม ผู้ส่งต้องสร้างความพยายามใหม่ที่อ้าง revision_of_attempt_id; ข้อยกเว้นส่งให้ PM แก้แล้วกลับสู่ข้อเสนอ</desc><defs><marker id="ds-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs><text class="ds-context" x="490" y="18" text-anchor="middle">ขอบเขต pilot: ${esc(boundaryCopy)} · โปรโตคอลตัวอย่าง ไม่ใช่ event สด</text><g class="ds-lane"><text x="110" y="48">ผู้ส่ง</text><text x="465" y="48">ผู้รับ</text><text x="820" y="48">PM (เฉพาะข้อยกเว้น)</text><path d="M110 62V330M465 62V330M820 62V330"/></g><g class="ds-flow"><path d="M110 88 H465" marker-end="url(#ds-head)"/><text x="287" y="80" text-anchor="middle">เสนอ immutable artifact / attempt</text><path d="M465 118 H545 V142 H465" marker-end="url(#ds-head)"/><text x="620" y="136">ผู้รับตรวจ phase contract</text><path d="M465 176 H110" marker-end="url(#ds-head)"/><text x="287" y="168" text-anchor="middle">ผู้รับเลือก accept หรือ reject</text><text class="ds-terminal" x="110" y="198">reject = attempt เดิมสิ้นสุด</text><path d="M110 214 H190 V238 H110" marker-end="url(#ds-head)"/><text x="300" y="234">ผู้ส่งสร้าง NEW attempt + revision_of_attempt_id</text><path class="ds-exception" d="M465 270 H820" marker-end="url(#ds-head)"/><text x="642" y="262" text-anchor="middle">exception / deadlock / policy conflict</text><path class="ds-exception" d="M820 300 H465" marker-end="url(#ds-head)"/><text x="642" y="322" text-anchor="middle">PM resolve_exception → proposed; ผู้รับยังตัดสินผล</text></g></svg></div><p class="diagram-note"><strong>ลำดับทั่วไปเพื่อการเรียนรู้</strong> ไม่ใช่ event state สด และไม่ยืนยันผลสำเร็จ การรับรอง หรืออนุมัติธุรกิจ.</p>`
}

function renderDeliverySequenceEquivalent() {
  return `<section class="diagram-equivalent" aria-labelledby="delivery-sequence-equivalent-title"><h3 id="delivery-sequence-equivalent-title">ข้อความเทียบเท่าลำดับทั่วไป</h3><ol><li>ผู้ส่งเสนอชิ้นงาน immutable และ attempt หนึ่งรายการ</li><li>ผู้รับตรวจและเป็นเจ้าของการยอมรับหรือปฏิเสธตามปกติ</li><li>การปฏิเสธสิ้นสุด attempt เดิม; ผู้ส่งสร้าง attempt ใหม่พร้อม <code>revision_of_attempt_id</code></li><li>ข้อยกเว้น, deadlock หรือ policy conflict ส่งให้ PM แก้ แล้วกลับสู่ proposed; ผู้รับยังเป็นผู้ตัดสินผล</li></ol></section>`
}

function renderGraph(rows) {
  if (!rows.length) return '<p class="empty">ยังไม่มีงานให้วาด</p>'
  // Keep the visible label authoritative: task IDs must not rely on a hover
  // title to recover characters hidden by an ellipsis. The graph is already
  // horizontally scrollable, so a longer label lane is safer than truncation.
  const longestTaskId = Math.max(...rows.map(row => row.id.length))
  const LEFT = Math.max(190, Math.ceil(longestTaskId * 8.2) + 16)
  const COL = 112, RIGHT = 164, TOP = 34, ROW = 30
  const w = LEFT + COL * (STAGES.length - 1) + RIGHT
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
    return `<g><text class="g-id" x="0" y="${y + 4}">${esc(r.id)}</text><title>${esc(r.id)}</title>${track}${dots}` +
      `<text class="g-tag ${c}" x="${x(STAGES.length - 1) + 16}" y="${y + 4}">${esc(stateLabel(r.state))}</text></g>`
  }).join('')

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
     aria-label="แต่ละงานเดินไปถึงขั้นไหน" aria-describedby="progress-graph-desc progress-graph-contract"><title id="progress-graph-title">แต่ละงานเดินไปถึงขั้นไหน</title><desc id="progress-graph-desc">จุดทึบคือขั้นที่มีหลักฐานว่าไปถึงแล้ว จุดโปร่งคือขั้นที่ยังไม่มีหลักฐาน สีบอกสถานะล่าสุดของแต่ละงาน</desc>${head}${body}</svg>`
}

function renderGraphLegend() {
  return `<ul class="graph-legend" aria-label="คำอธิบายสัญลักษณ์กราฟความคืบหน้า">
    <li><span class="legend-dot reached" aria-hidden="true"></span>จุดทึบ · มีหลักฐานว่าถึงขั้นนี้</li>
    <li><span class="legend-dot pending" aria-hidden="true"></span>จุดโปร่ง · ยังไม่มีหลักฐานว่าถึงขั้นนี้</li>
    <li><span class="legend-dot ok" aria-hidden="true"></span>เขียว · กำลังทำงานหรือมีบันทึกว่าผ่าน</li>
    <li><span class="legend-dot warn" aria-hidden="true"></span>เหลือง · กำลังเริ่ม รอตรวจ หรือหลักฐานยังไม่ครบ</li>
    <li><span class="legend-dot bad" aria-hidden="true"></span>แดง · หยุดหรือยังตรวจสถานะไม่ได้</li>
  </ul>`
}

function renderGraphEquivalent(rows) {
  if (!rows.length) {
    return '<section class="graph-equivalent" aria-labelledby="progress-equivalent-title"><h3 id="progress-equivalent-title">ข้อมูลเทียบเท่ากราฟ</h3><p id="progress-graph-contract">ยังไม่มีงานให้สรุปเป็นข้อความ</p></section>'
  }
  return `<section class="graph-equivalent" aria-labelledby="progress-equivalent-title">
    <h3 id="progress-equivalent-title">ข้อมูลเทียบเท่ากราฟ</h3>
    <p id="progress-graph-contract">ขั้น “ตรวจผล” และ “บันทึกผล” อาศัยฟิลด์เดิม <code>pm_verdict</code> จึงบอกเพียงว่ามี verdict ถูกบันทึก ไม่ได้ยืนยันว่า PM หรือทีมเฟสใดเป็นผู้ตรวจ</p>
    <ol>${rows.map(row => `<li><span><code>${esc(row.id)}</code> · ${esc(stateLabel(row.state))}</span><span class="graph-stage-list">${row.reached.map((reached, index) => `<span data-reached="${reached ? 'true' : 'false'}">${esc(STAGES[index])}: ${reached ? 'ถึงแล้ว' : 'ยังไม่ถึง'}</span>`).join('')}</span></li>`).join('')}</ol>
  </section>`
}

// HTML is a pure view of the published contract. It never receives the raw
// observations, so pulse.json is the sole source of truth for humans and agents.
function render(snapshot) {
  const active = snapshot.runs
  const rec = snapshot.recent_verdicts
  const notes = snapshot.diagnostics
  const unclaimed = snapshot.unclaimed_control
  const attentionStates = ['died', 'unknown', 'unrecorded', 'orphan_running']
  const attention = active.filter(a => attentionStates.includes(a.state))
  const tracked = active.filter(a => ['running', 'starting', 'awaiting-verdict'].includes(a.state))
  const recent = rec
  const st = snapshot.worker_stats
  const delivery = snapshot.delivery_loop || null
  const byState = snapshot.summary.by_state
  const graph = graphRows(snapshot)
  const attentionTotal = attentionStates.reduce((sum, state) => sum + byState[state], 0)
  const runningTotal = byState.running + byState.starting
  const waitingTotal = byState['awaiting-verdict']
  const passTotal = rec.filter(r => r.pm_verdict === 'pass').length
  const rejectTotal = rec.filter(r => r.pm_verdict === 'reject').length
  const repoName = snapshot.scope.repo_name || 'unknown'
  const refreshInterval = snapshot.observation.refresh_interval_sec
  const expiresAt = snapshot.observation.expires_at || ''
  const expiresMs = Date.parse(expiresAt)
  const expiryIsValid = Number.isFinite(expiresMs)
  const initiallyStale = !expiryIsValid || Date.now() >= expiresMs
  const qualityLabel = snapshot.complete ? 'หลักฐานระบบครบ' : 'หลักฐานระบบบางส่วน'
  const qualityClass = snapshot.complete ? 'complete' : 'warn'
  const freshnessLabel = !expiryIsValid ? 'ตรวจเวลาข้อมูลไม่ได้' : initiallyStale ? 'ข้อมูลหมดอายุ' : 'ข้อมูลสด'
  const freshnessClass = initiallyStale ? 'warn' : 'ok'
  const denseThreshold = 8
  const denseAttention = attention.length >= denseThreshold
  const denseTracked = tracked.length >= denseThreshold
  const densePrimary = denseAttention || denseTracked

  const metric = (label, value, note, tone = '') => `<div class="metric ${tone}">
    <span class="metric-label">${esc(label)}</span>
    <strong class="metric-value">${value}</strong>
    <span class="metric-note">${esc(note)}</span>
  </div>`

  const runItem = (a, timingLabel) => `<article class="run-item" data-state="${esc(a.state)}">
    <div class="run-summary">
      <div class="run-name"><span class="status-dot ${a.state}" aria-hidden="true"></span><code>${esc(a.task_id)}</code></div>
      <span class="pill ${a.state}" title="state: ${esc(a.state)}">${esc(stateLabel(a.state))}</span>
    </div>
    <dl class="run-facts">
      <div><dt>ช่องทาง</dt><dd>${esc(transportLabel(a.transport))}</dd></div>
      <div><dt>${esc(timingLabel)}</dt><dd class="num">${a.silence_sec == null ? 'ยังไม่วัด' : dur(a.silence_sec)}</dd></div>
      <div><dt>ขั้นถัดไป</dt><dd class="next-action">${esc(actionLabel(a.advisory.action_code))}</dd></div>
    </dl>
    <details class="technical" data-persist-key="run:${esc(a.dispatch_id || a.task_id)}">
      <summary>รายละเอียดทางเทคนิค</summary>
      <dl>
        <div><dt>dispatch</dt><dd><code>${esc(a.dispatch_id || 'ไม่ระบุ')}</code></dd></div>
        <div><dt>เริ่ม</dt><dd>${absoluteTime(a.started_at)}</dd></div>
        <div><dt>timeout</dt><dd class="num">${a.timeout_sec == null ? 'ไม่ระบุ' : dur(a.timeout_sec)}</dd></div>
        <div><dt>state code</dt><dd><code>${esc(a.state)}</code></dd></div>
      </dl>
    </details>
  </article>`
  const runList = (items, timingLabel, dense) =>
    `<div class="run-list${dense ? ' run-list-dense' : ''}" data-run-count="${items.length}" data-layout="${dense ? 'dense' : 'single'}">${items.map(item => runItem(item, timingLabel)).join('')}</div>`

  const diagnosticItems = notes.map(n => `<li>
    <span><strong>${esc(DIAGNOSTIC_COPY[n.code] || 'ข้อมูลบางส่วนอ่านไม่ได้')}</strong>${n.count > 1 ? ` <span class="num">×${n.count}</span>` : ''}</span>
    <code>${esc(`${n.source}:${n.code}`)}</code>
  </li>`).join('')

  const deliverySection = delivery ? (() => {
    const action = delivery.next_action
    const bottleneck = delivery.bottleneck
    const phaseCards = delivery.phase_cards.map(card => `<article class="phase-card">
      <div class="run-summary"><strong>${esc(DELIVERY_PHASE_COPY[card.phase] || card.phase)}</strong><span class="pill ${card.advisory.attention ? 'unrecorded' : 'running'}">${esc(DELIVERY_PHASE_STATE_COPY[card.state] || card.state)}</span></div>
      <dl class="run-facts">
        <div><dt>งานที่กำลังอยู่ในเฟส</dt><dd class="num">${card.active_slices}</dd></div>
        <div><dt>ค้างนานสุด</dt><dd class="num">${card.oldest_open_age_sec == null ? 'ยังไม่วัด' : dur(card.oldest_open_age_sec)}</dd></div>
        <div><dt>ขั้นถัดไป</dt><dd class="next-action">${esc(actionLabel(card.advisory.action_code))}</dd></div>
      </dl>
    </article>`).join('')
    const attentionItems = delivery.attention.map(item => `<li>
      <span><strong>${esc(actionLabel(item.action_code))}</strong> · ${esc(DELIVERY_ROLE_COPY[item.owner_role] || item.owner_role)}</span>
      <code>${esc(item.attention_id)}</code>
    </li>`).join('')
    const bottleneckText = bottleneck.status === 'available'
      ? `${DELIVERY_BOUNDARY_COPY[bottleneck.boundary] || bottleneck.boundary} · ${dur(bottleneck.age_sec)}`
      : bottleneck.status === 'none' ? 'ยังไม่พบจุดค้าง' : 'ข้อมูลยังไม่พอสรุป'
    return `<section class="delivery-loop" aria-labelledby="delivery-loop-title">
      <div class="section-head"><div><span class="eyebrow">Stage 1 · advisory only</span><h2 id="delivery-loop-title">วงรอบส่งมอบ</h2><p>สังเกตเฉพาะ pilot ที่เลือก · ไม่มีการสั่งงานอัตโนมัติ; แผนภาพเต็มเป็นโมเดลเชิงบรรทัดฐาน ไม่ใช่สถานะจริง</p></div><span class="quality ${delivery.status === 'degraded' ? 'warn' : 'ok'}">${esc(DELIVERY_STATUS_COPY[delivery.status] || delivery.status)}</span></div>
      <dl class="delivery-times" aria-label="เวลาของข้อมูลวงรอบส่งมอบ"><div><dt>ข้อมูลวงรอบ ณ</dt><dd>${absoluteTime(delivery.generated_at)}</dd></div><div><dt>วิเคราะห์ถึง</dt><dd>${absoluteTime(delivery.experiment.analysis_as_of)}</dd></div><div><dt>เริ่มช่วงทดลอง</dt><dd>${absoluteTime(delivery.experiment.assignment_window.start)}</dd></div><div><dt>สิ้นสุดช่วงทดลอง</dt><dd>${absoluteTime(delivery.experiment.assignment_window.end)}</dd></div></dl>
      <div class="delivery-overview">
        <article class="delivery-callout surface"><span class="eyebrow">ทำต่อโดย</span><strong>${esc(DELIVERY_ROLE_COPY[action.owner_role] || action.owner_role)}</strong><p>${esc(actionLabel(action.action_code))}</p><code>${esc(action.reason_codes.join(' · '))}</code></article>
        <article class="delivery-callout surface"><span class="eyebrow">จุดค้างเชิงพรรณนา</span><strong>${esc(bottleneckText)}</strong><p>ใช้เวลาค้างที่เก่าที่สุด ไม่ใช่ข้อสรุปสาเหตุ</p><code>${esc(bottleneck.reason_codes.join(' · '))}</code></article>
        <article class="delivery-callout surface"><span class="eyebrow">ภาพรวม pilot</span><strong>${delivery.summary.in_progress} กำลังเดิน · ${delivery.summary.terminal} สิ้นสุด</strong><p>ต้องดำเนินการ ${delivery.summary.operator_action_total} รายการ</p><code>${esc(DELIVERY_DECISION_COPY[delivery.evidence.business_decision] || delivery.evidence.business_decision)}</code></article>
      </div>
      <section class="delivery-model surface" aria-labelledby="delivery-model-title"><div class="detail-body"><h3 id="delivery-model-title">โมเดลเส้นทางส่งมอบและเจ้าของการตรวจรับ</h3>${renderDeliveryFlow(delivery)}${renderDeliveryFlowEquivalent()}</div></section>
      <div class="phase-grid">${phaseCards || '<p class="empty"><strong>ยังไม่มีข้อมูลเฟส</strong>ตรวจแหล่งข้อมูลวงรอบส่งมอบก่อน</p>'}</div>
      ${attentionItems ? `<div class="surface delivery-attention"><h3>รายการที่ต้องดำเนินการ</h3><ul class="diagnostics-list">${attentionItems}</ul></div>` : ''}
      <details class="deep-dive" data-persist-key="delivery-sequence"><summary>ลำดับทั่วไปของ handoff ที่ผู้รับเป็นเจ้าของ</summary><div class="detail-body">${renderDeliverySequence(delivery)}${renderDeliverySequenceEquivalent()}</div></details>
    </section>`
  })() : ''

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>pulse — ${esc(repoName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refreshInterval}">
<meta name="tmux-teams-snapshot-id" content="${esc(snapshot.snapshot_id)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231f6f5f'/%3E%3Cpath d='M14 35h11l6-19 9 32 7-15h5' fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${FONT_CSS_NAME}">
<style>
:root{color-scheme:dark;--bg:oklch(17% .012 165);--surface:oklch(21% .014 165);--surface-2:oklch(24% .015 165);--line:oklch(34% .014 165);--ink:oklch(93% .012 165);--dim:oklch(71% .018 165);--ok:oklch(74% .13 165);--warn:oklch(78% .13 78);--bad:oklch(72% .16 28);--focus:oklch(78% .12 235);--sans:"Kanit","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--r-sm:8px;--r-md:14px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:oklch(97% .008 165);--surface:oklch(99% .004 165);--surface-2:oklch(95% .012 165);--line:oklch(87% .014 165);--ink:oklch(24% .018 165);--dim:oklch(50% .022 165);--ok:oklch(50% .12 165);--warn:oklch(53% .13 72);--bad:oklch(52% .16 28);--focus:oklch(52% .13 235)}}
*{box-sizing:border-box}html{max-width:100%;font-size:16px}body{max-width:100%;margin:0;padding:var(--s5);background:var(--bg);color:var(--ink);font:400 1rem/1.65 var(--sans);text-rendering:optimizeLegibility}
.wrap{min-width:0;max-width:1180px;margin:0 auto}.skip-link{position:fixed;top:var(--s3);left:var(--s3);z-index:10;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);opacity:0;white-space:nowrap;background:var(--ink);color:var(--bg);padding:0;border-radius:var(--r-sm)}.skip-link:focus{width:auto;height:auto;overflow:visible;clip-path:none;opacity:1;padding:var(--s2) var(--s4)}
.site-header{display:flex;min-width:0;justify-content:space-between;align-items:flex-start;gap:var(--s5);padding:var(--s2) 0 var(--s5);border-bottom:1px solid var(--line)}.site-header>*,main>*,section,.primary-grid>*{min-width:0}
.eyebrow{display:block;margin:0 0 var(--s1);color:var(--dim);font:500 .75rem/1.4 var(--sans);letter-spacing:.08em;text-transform:uppercase}
h1{display:flex;min-width:0;align-items:baseline;gap:var(--s3);margin:0;font:600 1.75rem/1.2 var(--sans);letter-spacing:-.02em}h1 .repo{min-width:0;color:var(--dim);font:500 1rem var(--mono);letter-spacing:0;overflow-wrap:anywhere}
.scope{max-width:62ch;margin:var(--s2) 0 0;color:var(--dim);font-size:.875rem}.header-status{display:flex;min-width:0;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap;gap:var(--s3);text-align:right}.status-badges{display:flex;min-width:0;flex-wrap:wrap;justify-content:flex-end;gap:var(--s2)}.age{min-width:0;color:var(--dim);font-size:.8rem;line-height:1.5;overflow-wrap:anywhere}.age time,.freshness-note{display:block}.age time{color:var(--ink);font-family:var(--mono);font-variant-numeric:tabular-nums}
.quality{display:inline-flex;align-items:center;gap:var(--s2);white-space:nowrap;padding:6px 10px;border:1px solid var(--line);border-radius:999px;font-size:.78rem;font-weight:500}.quality::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}.quality.complete{color:var(--dim)}.quality.ok{color:var(--ok)}.quality.warn{color:var(--warn)}
main{display:grid;min-width:0;gap:var(--s7);padding-top:var(--s6)}.summary-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}.metric{min-width:0;padding:var(--s5);border-left:1px solid var(--line)}.metric:first-child{border-left:0}.metric-label,.metric-note{display:block;color:var(--dim);font-size:.82rem}.metric-value{display:block;margin:2px 0;font:600 2rem/1.2 var(--sans);font-variant-numeric:tabular-nums}.metric.bad .metric-value{color:var(--bad)}.metric.ok .metric-value{color:var(--ok)}.metric.warn .metric-value{color:var(--warn)}
body[data-observation-freshness="stale"] .metric.ok .metric-value{color:var(--dim)}body[data-observation-freshness="stale"] .pill.running{background:color-mix(in srgb,var(--dim) 16%,transparent);color:var(--dim)}body[data-observation-freshness="stale"] .status-dot.running{background:var(--dim)}
.diagnostics{border:1px solid color-mix(in oklch,var(--warn) 45%,var(--line));border-radius:var(--r-md);background:color-mix(in oklch,var(--warn) 8%,var(--surface));padding:var(--s4) var(--s5)}.diagnostics h2{margin:0 0 var(--s2);font-size:1rem}.diagnostics ul{display:grid;gap:var(--s2);margin:0;padding:0;list-style:none}.diagnostics li{display:flex;justify-content:space-between;gap:var(--s4);color:var(--dim);font-size:.875rem}.diagnostics strong{color:var(--ink);font-weight:500}.diagnostics code{font-size:.75rem}
.delivery-loop{display:grid;min-width:0;gap:var(--s4)}.delivery-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s3)}.delivery-callout{min-width:0;padding:var(--s4)}.delivery-callout strong{display:block;font-size:1.05rem;overflow-wrap:anywhere}.delivery-callout p{margin:var(--s2) 0;color:var(--dim);font-size:.85rem}.delivery-callout code{font-size:.72rem;color:var(--dim);overflow-wrap:anywhere}.delivery-times{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--s3);margin:0}.delivery-times div{min-width:0;padding:var(--s3);border-left:3px solid var(--line);background:var(--surface-2)}.delivery-times dt{color:var(--dim);font-size:.75rem}.delivery-times dd{margin:2px 0 0;overflow-wrap:anywhere;font-size:.85rem}.delivery-times time{font-family:var(--mono);font-variant-numeric:tabular-nums}.delivery-model .detail-body>h3,.diagram-equivalent h3{margin:0 0 var(--s3);font-size:1rem}.phase-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s3)}.phase-card{min-width:0;padding:var(--s4);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md)}.delivery-attention{padding:var(--s4)}.delivery-attention h3{margin:0 0 var(--s2);font-size:1rem}.diagnostics-list{display:grid;gap:var(--s2);margin:0;padding:0;list-style:none}.diagnostics-list li{display:flex;min-width:0;justify-content:space-between;gap:var(--s4);color:var(--dim);font-size:.85rem}.diagnostics-list li>*{min-width:0;overflow-wrap:anywhere}.diagnostics-list strong{color:var(--ink);font-weight:500}
.primary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s5);align-items:start}.primary-grid-stacked{grid-template-columns:1fr}.section-head{display:flex;min-width:0;justify-content:space-between;align-items:end;gap:var(--s4);margin-bottom:var(--s3)}.section-head h2{margin:0;font:600 1.25rem/1.3 var(--sans);letter-spacing:-.01em}.section-head p{margin:var(--s1) 0 0;color:var(--dim);font-size:.875rem}.count{flex:none;color:var(--dim);font:500 .82rem var(--sans);font-variant-numeric:tabular-nums}.surface{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}.run-list{display:grid;min-width:0}.run-list-dense{grid-template-columns:repeat(2,minmax(0,1fr))}.run-item{min-width:0;padding:var(--s4);border-top:1px solid var(--line)}.run-item:first-child{border-top:0}.run-list-dense .run-item{border-left:1px solid var(--line)}.run-list-dense .run-item:nth-child(-n+2){border-top:0}.run-list-dense .run-item:nth-child(odd){border-left:0}.run-summary{display:flex;min-width:0;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--s3)}.run-name{display:flex;min-width:0;max-width:100%;flex:1 1 12rem;align-items:center;gap:var(--s2)}.run-name code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font:500 .9rem var(--mono)}.status-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dim)}.status-dot.running{background:var(--ok)}.status-dot.starting,.status-dot.awaiting-verdict,.status-dot.unrecorded,.status-dot.orphan_running{background:var(--warn)}.status-dot.died,.status-dot.unknown{background:var(--bad)}
.pill{display:inline-flex;align-items:center;white-space:nowrap;font:500 .75rem/1.4 var(--sans);padding:4px 9px;border-radius:999px}
.pill.running{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.pill.starting{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.pill.awaiting-verdict{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.pill.unrecorded{background:color-mix(in srgb,var(--warn) 26%,transparent);color:var(--warn)}
.pill.orphan_running{background:color-mix(in srgb,var(--warn) 26%,transparent);color:var(--warn)}
.pill.died,.pill.unknown{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.run-facts{display:grid;grid-template-columns:.7fr .8fr 1.4fr;gap:var(--s3);margin:var(--s3) 0 0}.run-facts div{min-width:0}.run-facts dt,.technical dt{color:var(--dim);font-size:.72rem}.run-facts dd,.technical dd{min-width:0;margin:1px 0 0;font-size:.86rem;overflow-wrap:anywhere}.next-action{color:var(--ink);font-weight:500}.technical{min-width:0;margin-top:var(--s3);color:var(--dim);font-size:.78rem}.technical summary{max-width:100%;width:max-content;cursor:pointer;overflow-wrap:anywhere}.technical dl{display:grid;gap:var(--s2);margin:var(--s2) 0 0;padding:var(--s3);background:var(--surface-2);border-radius:var(--r-sm)}.technical dl div{display:grid;min-width:0;grid-template-columns:80px minmax(0,1fr);gap:var(--s2)}.technical code{overflow-wrap:anywhere}.empty{margin:0;padding:var(--s5);color:var(--dim)}.empty strong{display:block;margin-bottom:2px;color:var(--ink);font-weight:500}.limit-note,.legacy-note{margin:var(--s3) 0 0;color:var(--dim);font-size:.82rem}.legacy-note code{color:var(--ink)}
.warning-list{display:grid;margin:0;padding:0;list-style:none}.warning-list li{display:grid;min-width:0;grid-template-columns:minmax(130px,1fr) auto 2fr;gap:var(--s4);padding:var(--s3) var(--s4);border-top:1px solid var(--line);align-items:center}.warning-list li:first-child{border-top:0}.warning-list code,.warning-list p{min-width:0;overflow-wrap:anywhere}.warning-list p{margin:0;color:var(--warn);font-size:.85rem}
.table-scroll{min-width:0;max-width:100%;overflow-x:auto}.table-scroll:focus-visible{outline:3px solid var(--focus);outline-offset:2px}table{border-collapse:collapse;width:100%;min-width:720px;font-size:.9rem}caption{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}th{text-align:left;color:var(--dim);font:500 .75rem var(--sans);letter-spacing:.04em;padding:var(--s3) var(--s4);border-bottom:1px solid var(--line)}td{min-width:0;padding:var(--s3) var(--s4);border-bottom:1px solid var(--line);vertical-align:top}td code{overflow-wrap:anywhere}tr:last-child td{border-bottom:0}.mono,code{font-family:var(--mono)}.num{font-variant-numeric:tabular-nums}.dim{color:var(--dim)}.warn{color:var(--warn)}
.verdict-reject{color:var(--bad)}.verdict-pass{color:var(--ok)}.verdict-unresolved{color:var(--warn)}
.details-stack{display:grid;min-width:0;gap:var(--s3)}.deep-dive{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}.deep-dive>summary{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:var(--s4);cursor:pointer;padding:var(--s4) var(--s5);font-weight:500;list-style:none;overflow-wrap:anywhere}.deep-dive>summary::-webkit-details-marker{display:none}.deep-dive>summary::after{content:"+";flex:none;color:var(--dim);font:400 1.25rem var(--sans)}.deep-dive[open]>summary{border-bottom:1px solid var(--line)}.deep-dive[open]>summary::after{content:"−"}.detail-body{min-width:0;padding:var(--s4)}.graph-scroll,.diagram-scroll{min-width:0;max-width:100%;overflow-x:auto}.diagram-scroll{scrollbar-color:var(--line) transparent}.graph-scroll:focus-visible,.diagram-scroll:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.graph-scroll svg,.diagram-scroll svg{display:block;min-width:720px;height:auto}.graph-legend,.diagram-legend{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);margin:0 0 var(--s3);padding:0;list-style:none;color:var(--dim);font-size:.78rem}.graph-legend li,.diagram-legend li{display:flex;align-items:center;gap:var(--s2)}.legend-dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--dim);background:transparent}.legend-dot.reached{background:var(--ink);border-color:var(--ink)}.legend-dot.pending{border-color:var(--dim)}.legend-dot.ok{background:var(--ok);border-color:var(--ok)}.legend-dot.warn{background:var(--warn);border-color:var(--warn)}.legend-dot.bad{background:var(--bad);border-color:var(--bad)}.legend-line{width:26px;border-top:2px solid var(--ink)}.legend-line.dashed{border-top-style:dashed}.legend-line.bad{border-top-color:var(--bad)}.graph-equivalent{margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)}.graph-equivalent h3{margin:0;font-size:1rem}.graph-equivalent>p{margin:var(--s2) 0;color:var(--dim);font-size:.82rem}.graph-equivalent ol{display:grid;gap:var(--s3);margin:var(--s3) 0 0;padding-left:1.35rem}.graph-equivalent li{padding-left:var(--s1)}.graph-stage-list{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s2);margin-top:var(--s1);color:var(--dim);font-size:.76rem}.graph-stage-list span{padding:2px 6px;border:1px solid var(--line);border-radius:999px}.graph-stage-list [data-reached="true"]{color:var(--ink);border-color:var(--dim)}.diagram-note{margin:var(--s3) 0 0;color:var(--dim);font-size:.82rem}.diagram-equivalent{margin-top:var(--s4);padding-top:var(--s4);border-top:1px solid var(--line)}.diagram-equivalent p,.diagram-equivalent ol{margin:var(--s2) 0 0;color:var(--dim);font-size:.86rem}.diagram-equivalent ol{padding-left:1.35rem}.diagram-equivalent li+li{margin-top:var(--s2)}
.delivery-svg{min-width:1120px}.delivery-svg .df-pm{fill:none;stroke:var(--dim);stroke-width:1.5;stroke-dasharray:6 5}.df-pm-label{font:500 14px var(--sans);fill:var(--dim)}.df-node rect{fill:var(--surface-2);stroke:var(--line);stroke-width:1.5}.df-final rect{fill:var(--bg);stroke-width:2}.df-title{font:600 15px var(--sans);fill:var(--ink)}.df-copy,.df-owner{font:11px var(--sans);fill:var(--dim)}.df-artifact{font:500 10px var(--mono);fill:var(--ink)}.df-artifact-label{font:600 11px var(--sans);fill:var(--ink)}.df-loop,.df-edge path{fill:none;stroke:var(--line);stroke-width:1.8}.df-edge marker path,.df-loop marker path,.df-exception marker path,.ds-flow marker path{fill:var(--line)}.df-selected path{stroke:var(--warn);stroke-width:3}.df-observed{font:600 11px var(--sans);fill:var(--warn)}.df-exception{fill:none;stroke:var(--bad);stroke-width:1.8;stroke-dasharray:5 4}.df-exception-label{font:11px var(--sans);fill:var(--bad)}.sequence-svg{min-width:980px}.ds-context{font:500 11px var(--sans);fill:var(--dim)}.ds-lane text{font:600 14px var(--sans);fill:var(--ink)}.ds-lane path{stroke:var(--line);stroke-dasharray:4 4}.ds-flow path{stroke:var(--line);stroke-width:1.8;fill:none}.ds-flow text{font:11px var(--sans);fill:var(--ink)}.ds-flow .ds-terminal{fill:var(--bad);font-weight:500}.ds-flow .ds-exception{stroke:var(--bad);stroke-dasharray:5 4}
.l-box{fill:var(--surface);stroke:var(--line);stroke-width:1.5}
.l-store{fill:var(--bg)}
.l-dia{fill:var(--surface);stroke:var(--line);stroke-width:1.5}
.l-t{font:500 12px var(--sans);fill:var(--ink)}
.l-s{font:10.5px var(--sans);fill:var(--dim)}
.l-lbl{font:10.5px var(--sans);fill:var(--ink)}
.l-dim{fill:var(--dim)}
.l-edge{stroke:var(--line);stroke-width:1.8;fill:none}
.l-dash{stroke-dasharray:5 4}
.l-head{fill:var(--line)}.l-head-bad{fill:var(--bad)}
.l-bad{stroke:var(--bad)}.l-bad-t{fill:var(--bad)}.l-bad-box{stroke:var(--bad)}
.worker-loop-svg{min-width:1080px}.wl-lane{fill:var(--surface-2);stroke:var(--line);stroke-width:1.5}.wl-lane-inner{fill:var(--surface)}.wl-lane-title{font:600 14px var(--sans);fill:var(--ink)}.wl-lane-copy{font:11px var(--sans);fill:var(--dim)}.wl-role{font:600 10px var(--sans);fill:var(--warn);letter-spacing:.04em}.wl-node-title{font:600 12px var(--sans);fill:var(--ink)}.wl-node-copy{font:10.5px var(--sans);fill:var(--dim)}.wl-artifact{fill:var(--bg);stroke:var(--ok);stroke-width:1.8}.wl-pass{stroke:var(--ok)}.wl-exception{stroke:var(--bad);stroke-dasharray:5 4}.wl-exception-copy{font:600 10.5px var(--sans);fill:var(--bad)}.wl-unmeasured{stroke-dasharray:5 4}.wl-unmeasured-copy{font:10.5px var(--sans);fill:var(--dim)}
.g-head{font:500 10px var(--sans);fill:var(--dim);letter-spacing:.02em}
.g-id{font:13px var(--mono);fill:var(--ink)}
.g-tag{font:500 10px var(--sans);fill:var(--dim)}
.g-track{stroke:var(--line);stroke-width:2}
.g-line{stroke-width:2.5}
.g-dot{stroke:var(--surface);stroke-width:1.5}
.g-off{fill:var(--line);stroke:none}
.g-ok{stroke:var(--ok)}.g-ok.g-dot,.g-ok.g-tag{fill:var(--ok)}
.g-warn{stroke:var(--warn)}.g-warn.g-dot,.g-warn.g-tag{fill:var(--warn)}
.g-bad{stroke:var(--bad)}.g-bad.g-dot,.g-bad.g-tag{fill:var(--bad)}
footer{margin-top:var(--s7);padding-top:var(--s4);border-top:1px solid var(--line);color:var(--dim);font-size:.82rem}footer details summary{cursor:pointer;width:max-content;color:var(--ink)}footer ul{max-width:78ch;margin:var(--s3) 0 0;padding-left:1.25rem}footer code{font-size:.76rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}summary:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
@media(max-width:820px){body{padding:var(--s4)}.site-header{display:grid}.header-status,.status-badges{justify-content:flex-start;text-align:left}.summary-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{border-top:1px solid var(--line)}.metric:nth-child(-n+2){border-top:0}.metric:nth-child(odd){border-left:0}.delivery-overview{grid-template-columns:1fr}.primary-grid,.run-list-dense{grid-template-columns:1fr}.run-list-dense .run-item{border-left:0}.run-list-dense .run-item:nth-child(2){border-top:1px solid var(--line)}main{gap:var(--s6)}}
@media(max-width:620px){h1{display:grid;gap:2px;font-size:1.5rem}.header-status,.status-badges{display:grid;justify-items:start}.quality{white-space:normal}.metric{padding:var(--s4)}.metric-value{font-size:1.65rem}.section-head{align-items:start}.delivery-times,.phase-grid{grid-template-columns:1fr}.run-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.run-facts div:last-child{grid-column:1/-1}.warning-list li{grid-template-columns:1fr auto}.warning-list p{grid-column:1/-1}.responsive-table table,.responsive-table tbody,.responsive-table tr,.responsive-table td{display:block;min-width:0}.responsive-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.responsive-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s3);padding:var(--s4);border-top:1px solid var(--line)}.responsive-table tbody tr:first-child{border-top:0}.responsive-table td{padding:0;border:0;overflow-wrap:anywhere}.responsive-table td:first-child{grid-column:1/-1}.responsive-table td::before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--dim);font-size:.7rem}.deep-dive>summary{padding:var(--s4)}.detail-body{padding:var(--s3)}.graph-legend,.diagram-legend{display:grid}}
@media(max-width:360px){body{padding:var(--s3)}.summary-strip{grid-template-columns:1fr}.metric,.metric:nth-child(-n+2){border-top:1px solid var(--line);border-left:0}.metric:first-child{border-top:0}.run-facts{grid-template-columns:1fr}.run-facts div:last-child{grid-column:auto}.responsive-table tr{grid-template-columns:1fr}.responsive-table td:first-child{grid-column:auto}}
@media(forced-colors:active){.df-selected path{stroke:Highlight;stroke-width:4}.df-observed,.df-exception-label,.ds-flow .ds-terminal{color:CanvasText;fill:CanvasText}.df-node rect,.df-pm{stroke:CanvasText}.graph-scroll:focus-visible,.diagram-scroll:focus-visible{outline-color:Highlight}.legend-dot,.legend-line{border-color:CanvasText;background:CanvasText}}
</style></head><body data-observation-freshness="${initiallyStale ? 'stale' : 'fresh'}"><div class="wrap">

<a class="skip-link" href="#main">ข้ามไปยังสถานะงาน</a>

<header class="site-header">
  <div>
    <span class="eyebrow">tmux teams · live status</span>
    <h1>Pulse <span class="repo">${esc(repoName)}</span></h1>
    <p class="scope">ติดตามเฉพาะ worker ที่ระบบสั่งในโปรเจกต์นี้ · หน้านี้อ่านข้อมูลอย่างเดียว</p>
  </div>
  <div class="header-status" data-observation-expires-at="${esc(expiresAt)}" data-refresh-interval="${refreshInterval}">
    <div class="status-badges">
      <span class="quality ${qualityClass}" title="ความครบถ้วนของหลักฐานที่ Pulse อ่านได้">${qualityLabel}</span>
      <span id="freshness-status" class="quality ${freshnessClass}" role="status" aria-live="polite">${freshnessLabel}</span>
    </div>
    <div class="age"><span>ข้อมูลที่สังเกต ณ</span>${absoluteTime(snapshot.generated_at)}<span id="freshness-note" class="freshness-note">${!expiryIsValid ? 'ตรวจเวลาหมดอายุไม่ได้' : initiallyStale ? 'ตัวสังเกตการณ์ไม่อัปเดตตามรอบ' : `กำหนดรีเฟรชทุก ${refreshInterval} วิ`}</span></div>
  </div>
</header>

<main id="main">
  <section aria-labelledby="overview-title">
    <h2 class="sr-only" id="overview-title">ภาพรวมสถานะ</h2>
    <div class="summary-strip" aria-label="ภาพรวมสถานะ">
      ${metric('ต้องตรวจสอบ', attentionTotal, 'งานผิดปกติหรือข้อมูลขาด', attentionTotal ? 'bad' : '')}
      ${metric('กำลังทำงาน', runningTotal, 'worker ที่กำลังเริ่มหรือทำงาน', 'ok')}
      ${metric('รอตรวจผล', waitingTotal, 'มีผลลัพธ์แล้ว แต่ยังไม่มีคำตัดสินที่บันทึก', waitingTotal ? 'warn' : '')}
      ${metric('บันทึกล่าสุด', recent.length, `ผ่าน ${passTotal} · ให้แก้ไข ${rejectTotal}`)}
    </div>
    ${snapshot.summary.truncated ? `<p class="limit-note">ยอดรวมครอบคลุมทุกงาน ส่วนรายละเอียดด้านล่างแสดง 100 งานแรก · ยังมีอีก ${snapshot.summary.truncated} งาน</p>` : ''}
  </section>

  ${notes.length ? `<section class="diagnostics" aria-labelledby="diagnostics-title"><h2 id="diagnostics-title">คุณภาพข้อมูลต้องตรวจสอบ</h2><ul>${diagnosticItems}</ul></section>` : ''}

  ${deliverySection}

  <div class="primary-grid${densePrimary ? ' primary-grid-stacked' : ''}" data-layout="${densePrimary ? 'stacked-dense' : 'paired'}">
    <section aria-labelledby="attention-title">
      <div class="section-head"><div><span class="eyebrow">ทำก่อน</span><h2 id="attention-title">ต้องตรวจสอบ</h2><p>งานผิดปกติหรือยังมีหลักฐานไม่ครบ</p></div><span class="count">${attentionTotal} งาน</span></div>
      <div class="surface">${attention.length ? runList(attention, 'เงียบมา', denseAttention)
        : '<p class="empty"><strong>ยังไม่มีงานผิดปกติ</strong>ไม่พบงานที่หยุดหรือขาดหลักฐาน</p>'}</div>
    </section>

    <section aria-labelledby="running-title">
      <div class="section-head"><div><span class="eyebrow">หลักฐานที่ติดตาม</span><h2 id="running-title">งานที่กำลังเดินหรือรอตรวจ</h2><p>รวมงานที่กำลังเริ่ม กำลังทำ และมีผลลัพธ์รอตรวจตามหลักฐานล่าสุด</p></div><span class="count">${runningTotal + waitingTotal} งาน</span></div>
      <div class="surface">${tracked.length ? runList(tracked, 'ผ่านไป', denseTracked)
        : '<p class="empty"><strong>ยังไม่พบงานที่กำลังเดิน</strong>ไม่พบ worker ที่กำลังเริ่ม ทำงาน หรือมีผลลัพธ์รอตรวจในหลักฐานล่าสุด</p>'}</div>
    </section>
  </div>

  ${unclaimed && unclaimed.length ? `<section aria-labelledby="ownership-title">
    <div class="section-head"><div><span class="eyebrow">ตรวจแหล่งที่มา</span><h2 id="ownership-title">งานที่ยังยืนยันเจ้าของไม่ได้</h2><p>ข้อมูลควบคุมอาจมาจากโปรเจกต์อื่น</p></div><span class="count">${unclaimed.length} รายการ</span></div>
    <div class="surface"><ul class="warning-list">${unclaimed.map(u => `<li><code>${esc(u.task_id)}</code><span class="num">${dur(u.age_sec)}</span><p>ยังผูกข้อมูลควบคุมกับโปรเจกต์นี้ไม่ได้</p></li>`).join('')}</ul></div>
  </section>` : ''}

  <section aria-labelledby="recent-title">
    <div class="section-head"><div><span class="eyebrow">หลักฐานที่บันทึกไว้</span><h2 id="recent-title">บันทึกผลล่าสุด</h2><p>ผลปลายทาง เวลาเริ่ม และเวลาที่ใช้; verdict มาจากฟิลด์เดิม <code>pm_verdict</code></p></div><span class="count">${recent.length} รายการ</span></div>
    <div class="surface table-scroll responsive-table" tabindex="0">${recent.length ? `<table><caption>บันทึกผลล่าสุด; คำตัดสินอ่านจากฟิลด์เดิม pm_verdict</caption><thead><tr><th>งาน</th><th>worker</th><th>ผลจาก worker</th><th>คำตัดสินที่บันทึก (pm_verdict)</th><th>เริ่ม</th><th>ใช้เวลา</th><th>dispatch</th></tr></thead><tbody>
${recent.map(r => `<tr>
  <td data-label="งาน"><code>${esc(r.task_id)}</code></td><td data-label="worker">${esc(r.worker)}</td>
  <td data-label="ผลจาก worker">${esc(terminalLabel(r.terminal))}</td>
  <td data-label="คำตัดสินที่บันทึก (pm_verdict)" class="verdict-${esc(r.pm_verdict)}">${esc(verdictLabel(r.pm_verdict))}</td>
  <td data-label="เริ่ม">${absoluteTime(r.started_at)}</td>
  <td data-label="ใช้เวลา" class="num">${r.wait_sec == null || r.wait_sec < 0 ? 'ยังไม่วัด' : dur(r.wait_sec)}</td>
  <td data-label="dispatch"><code>${esc(r.dispatch_id || 'ไม่ระบุ')}</code></td>
</tr>`).join('')}</tbody></table>`
      : '<p class="empty"><strong>ยังไม่มีบันทึกผล</strong>รายการจะปรากฏเมื่อมีคำตัดสินถูกบันทึกในฟิลด์เดิม pm_verdict</p>'}</div>
    <p class="legacy-note"><strong>ขอบเขตหลักฐาน:</strong> <code>pm_verdict</code> เป็นชื่อฟิลด์เดิมเพื่อความเข้ากันได้ย้อนหลัง การมีค่าไม่ได้ยืนยันว่า PM หรือทีมเฟสใดเป็นผู้ตรวจ และไม่เท่ากับการตรวจรับหรืออนุมัติทางธุรกิจ</p>
  </section>

  <section aria-labelledby="details-title">
    <div class="section-head"><div><span class="eyebrow">เปิดเมื่ออยากเจาะลึก</span><h2 id="details-title">รายละเอียดระบบ</h2><p>เส้นทางงาน วิธีติดตาม และสถิติ worker</p></div></div>
    <div class="details-stack">
      <details class="deep-dive" data-persist-key="progress"><summary>ความคืบหน้าของแต่ละงาน</summary><div class="detail-body">${renderGraphLegend()}<div class="graph-scroll" tabindex="0" role="region" aria-label="กราฟความคืบหน้าของแต่ละงานแบบเลื่อนแนวนอนได้">${renderGraph(graph)}</div>${renderGraphEquivalent(graph)}</div></details>
      <details class="deep-dive" data-persist-key="system-loop"><summary>ลูปสองชั้น: ทีมตรวจ worker · PM ติดตาม phase</summary><div class="detail-body"><ul class="diagram-legend" aria-label="วิธีอ่านเส้นในโมเดลลูปสองชั้น"><li><span class="legend-line" aria-hidden="true"></span>เส้นทึบ · เส้นทางตามโมเดล ไม่ใช่ event สด</li><li><span class="legend-line dashed" aria-hidden="true"></span>เส้นประ · transition ที่ Pulse ยังไม่วัดว่าเกิดจริง</li><li><span class="legend-line bad" aria-hidden="true"></span>เส้นแดง · ทางยกระดับข้อยกเว้น; ตัวเลขมาจากหลักฐานหยุดผิดปกติ</li></ul><div class="diagram-scroll" tabindex="0" role="region" aria-label="แผนภาพลูปสองชั้นเชิงบรรทัดฐานของการสั่งงาน worker และการส่งมอบแบบเลื่อนแนวนอนได้">${renderLoop(snapshot)}</div><p class="diagram-note"><strong>โมเดลเชิงบรรทัดฐาน ไม่ใช่สถานะสด</strong> ทีมเฟสเป็นเจ้าของ dispatch/verification ตามปกติ ส่วน PM คุมลูปชั้นนอกและรับเฉพาะข้อยกเว้น; ตัวเลขมาจากหลักฐาน dispatch และ verdict เดิมที่ Pulse อ่านได้ แต่เส้นทางของโมเดลไม่ได้ยืนยันว่า transition เกิดขึ้นจริง.</p><section class="diagram-equivalent" aria-labelledby="worker-loop-equivalent-title"><h3 id="worker-loop-equivalent-title">ข้อความเทียบเท่าลูปสองชั้น</h3><ol><li>ตามโมเดล PM กำหนดเป้าหมาย ติดตาม phase, handoff และ bottleneck โดยไม่รับตรวจ worker ทุกงาน</li><li>ตามโมเดลทีมเฟสแตกงานเป็น slice พร้อม validation แล้ว dispatch ให้ worker</li><li>ตามโมเดล worker ส่งหลักฐานกลับให้ผู้ตรวจของทีม; ผ่านจึงนำไปประกอบ exit artifact</li><li>งานที่ไม่ผ่านควรสร้าง dispatch หรือ attempt ใหม่ภายในทีม; Pulse ยังไม่วัดว่าการวนนี้เกิดจริง</li><li>exception, deadlock, policy conflict หรือ bottleneck เท่านั้นที่โมเดลยกระดับให้ PM แก้</li></ol></section></div></details>
      <details class="deep-dive" data-persist-key="worker-stats"><summary>สถิติ worker</summary><div class="detail-body surface table-scroll responsive-table" tabindex="0">${st.length ? `<table><caption>สถิติ worker</caption><thead><tr><th>worker</th><th>รอบทั้งหมด</th><th>ให้แก้ไข</th><th>เวลากลาง</th></tr></thead><tbody>
${st.map(s => `<tr><td data-label="worker">${esc(s.worker)}</td><td data-label="รอบทั้งหมด" class="num">${s.runs}</td>
  <td data-label="ให้แก้ไข" class="num ${s.rejected ? 'verdict-reject' : ''}">${s.rejected}</td>
  <td data-label="เวลากลาง" class="num">${s.median_wait_sec == null ? 'ยังไม่วัด' : dur(s.median_wait_sec)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty"><strong>ยังไม่มีสถิติ</strong>ต้องมีผลการทำงานก่อนจึงจะคำนวณได้</p>'}</div></details>
    </div>
  </section>
</main>

<footer>
  <details data-persist-key="limitations"><summary>ข้อจำกัดและวิธีอ่านข้อมูล</summary><ul>
    <li>Pulse ตรวจหลักฐานจาก process, tmux, dispatch, outbox และ event โดยไม่เชื่อไฟล์ประกาศสถานะเพียงอย่างเดียว</li>
    <li>“หยุดโดยไม่มีบันทึก” หมายถึงพบหลักฐานการสั่งงาน แต่ไม่พบทั้งกระบวนการและผลลัพธ์</li>
    <li>ข้อมูลควบคุมบางรายการยังแยกเจ้าของตามโปรเจกต์ไม่ได้ จึงแสดงเป็น “ยังยืนยันเจ้าของไม่ได้”</li>
    <li>ฟิลด์เดิม <code>pm_verdict</code> บอกเพียงว่ามีคำตัดสินถูกบันทึก ไม่ยืนยันผู้ตรวจ การตรวจรับ หรือการอนุมัติธุรกิจ</li>
    <li>ลูปสองชั้นเป็นโมเดลเชิงบรรทัดฐาน; เส้นทางไม่ได้ยืนยันว่า phase handoff หรือ transition เกิดขึ้นจริง</li>
    <li>หากป้าย freshness แสดง “ข้อมูลหมดอายุ” ให้ตรวจตัวสังเกตการณ์ก่อนสรุปสถานะงาน</li>
  </ul></details>
</footer>
</div>
<script>
(() => {
  for (const detail of document.querySelectorAll('details[data-persist-key]')) {
    const key = 'tmux-teams:pulse:' + location.pathname + ':' + detail.dataset.persistKey
    try {
      const saved = sessionStorage.getItem(key)
      if (saved !== null) detail.open = saved === 'open'
      detail.addEventListener('toggle', () => sessionStorage.setItem(key, detail.open ? 'open' : 'closed'))
    } catch { /* storage may be disabled; native details still work */ }
  }

  const header = document.querySelector('[data-observation-expires-at]')
  const status = document.querySelector('#freshness-status')
  const note = document.querySelector('#freshness-note')
  let expiryTimer = 0
  const updateFreshness = () => {
    if (!header || !status || !note) return
    if (expiryTimer) clearTimeout(expiryTimer)
    const expiry = Date.parse(header.dataset.observationExpiresAt || '')
    const valid = Number.isFinite(expiry)
    const stale = !valid || Date.now() >= expiry
    document.body.dataset.observationFreshness = stale ? 'stale' : 'fresh'
    status.classList.toggle('ok', !stale)
    status.classList.toggle('warn', stale)
    status.textContent = !valid ? 'ตรวจเวลาข้อมูลไม่ได้' : stale ? 'ข้อมูลหมดอายุ' : 'ข้อมูลสด'
    note.textContent = !valid
      ? 'ตรวจเวลาหมดอายุไม่ได้'
      : stale
        ? 'ตัวสังเกตการณ์ไม่อัปเดตตามรอบ'
        : 'กำหนดรีเฟรชทุก ' + (header.dataset.refreshInterval || '?') + ' วิ'
    if (!stale) {
      const delay = Math.min(Math.max(expiry - Date.now() + 25, 25), 2_147_000_000)
      expiryTimer = setTimeout(updateFreshness, delay)
    }
  }
  updateFreshness()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateFreshness()
  })
})()
</script>
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

function atomicWrite(path, content, publishToken = null) {
  const temp = join(STORE, `.${path.split('/').pop()}.${process.pid}.${randomUUID()}.tmp`)
  let fd = null
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    if (publishToken !== null) assertPublishLock(publishToken)
    renameSync(temp, path)
  } catch (e) {
    if (fd !== null) try { closeSync(fd) } catch { /* best effort */ }
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw e
  }
}

function readDeliveryLoopInput() {
  if (!DELIVERY_LOOP_PATH) return { value: null, issue: null }
  try {
    const stats = statSync(DELIVERY_LOOP_PATH)
    if (!stats.isFile()) {
      return { value: null, issue: 'DELIVERY_LOOP_INPUT_UNREADABLE' }
    }
    if (stats.size > MAX_INPUT_BYTES) {
      return { value: null, issue: 'DELIVERY_LOOP_INPUT_INVALID' }
    }
    let descriptor = null
    try {
      descriptor = openSync(DELIVERY_LOOP_PATH, 'r')
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1)
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_INPUT_BYTES) {
        return { value: null, issue: 'DELIVERY_LOOP_INPUT_INVALID' }
      }
      return {
        value: JSON.parse(buffer.toString('utf8', 0, bytesRead)),
        issue: null,
      }
    } catch (error) {
      return {
        value: null,
        issue: error instanceof SyntaxError
          ? 'DELIVERY_LOOP_INPUT_INVALID'
          : 'DELIVERY_LOOP_INPUT_UNREADABLE',
      }
    } finally {
      if (descriptor !== null) try { closeSync(descriptor) } catch { /* best effort */ }
    }
  } catch {
    return { value: null, issue: 'DELIVERY_LOOP_INPUT_UNREADABLE' }
  }
}

function atomicWriteIfChanged(path, content, publishToken = null) {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  atomicWrite(path, content, publishToken)
}

function priorStream(view, targetVersion) {
  if (!existsSync(JSON_OUT)) return { streamId: randomUUID(), sequence: 1 }
  try {
    const prior = JSON.parse(readFileSync(JSON_OUT, 'utf8'))
    if (prior.schema !== PULSE_SCHEMA ||
        ![PULSE_SCHEMA_VERSION, PULSE_SCHEMA_VERSION_V2].includes(prior.schema_version) ||
        !UUID_RE.test(prior.stream_id) || !Number.isSafeInteger(prior.sequence) ||
        prior.sequence < 1 || prior.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('invalid prior pulse')
    if (prior.schema_version === PULSE_SCHEMA_VERSION &&
        targetVersion === PULSE_SCHEMA_VERSION_V2) {
      view.diagnostics.push({
        code: 'SCHEMA_UPGRADED',
        severity: 'info',
        source: 'publisher',
        count: 1,
      })
    }
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
  const targetVersion = DELIVERY_LOOP_PATH ? PULSE_SCHEMA_VERSION_V2 : PULSE_SCHEMA_VERSION
  const deliveryLoopInput = readDeliveryLoopInput()
  mkdirSync(STORE, { recursive: true })
  const ignore = join(STORE, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const token = claimPublishLock()
  try {
    const stream = priorStream(view, targetVersion)
    const meta = {
      ...stream, startedAt, finishedAt, intervalSec: INTERVAL,
      repoName: REPO.split('/').pop(),
    }
    const snapshot = targetVersion === PULSE_SCHEMA_VERSION_V2
      ? projectPulseV2(view, meta, deliveryLoopInput.value, deliveryLoopInput.issue)
      : projectPulseV1(view, meta)
    const jsonText = JSON.stringify(snapshot, null, 2) + '\n'
    // Render the exact serialized contract, not the internal projection object.
    // This makes pulse.json the literal SSOT and catches serialization drift.
    const publishedSnapshot = JSON.parse(jsonText)
    const html = render(publishedSnapshot)
    assertPublishLock(token)
    atomicWriteIfChanged(FONT_CSS_OUT, KANIT_FONT_CSS, token)
    assertPublishLock(token)
    atomicWrite(JSON_OUT, jsonText, token)
    assertPublishLock(token)
    atomicWrite(OUT, html, token)
    return { htmlPath: OUT, jsonText, snapshot: publishedSnapshot }
  } finally {
    releasePublishLock(token)
  }
}

if (cmd === 'compat-v1') {
  try {
    const persisted = JSON.parse(readFileSync(JSON_OUT, 'utf8'))
    process.stdout.write(`${JSON.stringify(downProjectPulseV1(persisted), null, 2)}\n`)
    process.exit(0)
  } catch {
    console.error('[pulse] no compatible persisted Pulse snapshot')
    process.exit(1)
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

function desiredWatcherConfig(pid) {
  return {
    pid,
    schema_version: DELIVERY_LOOP_PATH ? PULSE_SCHEMA_VERSION_V2 : PULSE_SCHEMA_VERSION,
    delivery_loop_path: DELIVERY_LOOP_PATH,
  }
}

function readWatcherConfig() {
  try {
    const stats = statSync(WATCH_CONFIG)
    if (!stats.isFile() || stats.size > 4096) return null
    const value = JSON.parse(readFileSync(WATCH_CONFIG, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 3 ||
        !Object.hasOwn(value, 'pid') ||
        !Object.hasOwn(value, 'schema_version') ||
        !Object.hasOwn(value, 'delivery_loop_path') ||
        !Number.isSafeInteger(value.pid) || value.pid < 1 ||
        ![PULSE_SCHEMA_VERSION, PULSE_SCHEMA_VERSION_V2].includes(value.schema_version) ||
        !(value.delivery_loop_path === null ||
          typeof value.delivery_loop_path === 'string') ||
        (value.schema_version === PULSE_SCHEMA_VERSION) !==
          (value.delivery_loop_path === null)) return null
    return value
  } catch { return null }
}

function writeWatcherConfig(pid) {
  atomicWrite(WATCH_CONFIG, `${JSON.stringify(desiredWatcherConfig(pid), null, 2)}\n`)
}

function watcherConfigMatches(pid) {
  const actual = readWatcherConfig()
  const desired = desiredWatcherConfig(pid)
  return actual !== null &&
    actual.pid === desired.pid &&
    actual.schema_version === desired.schema_version &&
    actual.delivery_loop_path === desired.delivery_loop_path
}

// Same single-operator O_EXCL pattern as deliver.sh: one caller claims the
// pidfile; another sees a live owner and backs off; a dead owner is reclaimed.
function claimWatcher() {
  mkdirSync(STORE, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(WATCH_PID, `${process.pid}\n`, { flag: 'wx' })
      try {
        writeWatcherConfig(process.pid)
      } catch (error) {
        try { unlinkSync(WATCH_PID) } catch { /* best effort */ }
        throw error
      }
      return { claimed: true, pid: process.pid }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = watcherPid()
      if (pidAlive(pid)) return { claimed: false, pid }
      try { unlinkSync(WATCH_CONFIG) } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      }
      try { unlinkSync(WATCH_PID) } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  const pid = watcherPid()
  return { claimed: false, pid: pidAlive(pid) ? pid : null }
}

function releaseWatcher(pid = process.pid) {
  try {
    if (watcherPid() !== pid) return
    try { unlinkSync(WATCH_CONFIG) } catch { /* best effort */ }
    unlinkSync(WATCH_PID)
  } catch { /* best effort */ }
}

if (cmd === 'ensure') {
  const claim = claimWatcher()
  if (!claim.claimed) {
    if (!claim.pid) { console.error('[pulse] could not claim watcher pidfile'); process.exit(1) }
    if (!watcherConfigMatches(claim.pid)) {
      console.error(
        '[pulse] watcher mode/input mismatch; stop the existing watcher before changing --delivery-loop',
      )
      process.exit(1)
    }
    try {
      console.log(once().htmlPath)
    } catch (error) {
      console.error(`[pulse] publish failed: ${error.message}`)
      process.exit(1)
    }
    console.log(`[pulse] watcher already running pid ${claim.pid}`)
    process.exit(0)
  }
  try {
    console.log(once().htmlPath)
  } catch (error) {
    releaseWatcher()
    console.error(`[pulse] publish failed: ${error.message}`)
    process.exit(1)
  }
  const watchArgs = [THIS_SCRIPT, 'watch', REPO, '--interval', String(INTERVAL), '--managed']
  if (DELIVERY_LOOP_PATH) watchArgs.push('--delivery-loop', DELIVERY_LOOP_PATH)
  const child = spawn(process.execPath,
    watchArgs, {
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
  if (!watcherConfigMatches(owner)) {
    console.error('[pulse] watcher claim mode/input does not match this process; refusing handoff')
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
if (managedClaimAccepted) {
  writeWatcherConfig(process.pid)
  writeFileSync(WATCH_PID, `${process.pid}\n`)
}

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
