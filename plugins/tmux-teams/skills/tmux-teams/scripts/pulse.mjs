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
//   pulse.mjs once  <repo> [--team-graph FILE] [--team-runtime FILE] [--time-zone ZONE]
//   pulse.mjs watch <repo> [--interval 20] [--team-graph FILE] [--team-runtime FILE] [--time-zone ZONE]
//   pulse.mjs ensure <repo> [--interval 20] [--team-graph FILE] [--team-runtime FILE] [--time-zone ZONE]
//   pulse.mjs json <repo> [--team-graph FILE] [--team-runtime FILE] [--time-zone ZONE]
//   pulse.mjs compat-v1 <repo>                                    stdout-only v1 downprojection
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KANIT_FONT_CSS } from '../assets/kanit/kanit-embedded.mjs'
import { parseLsofCwd, parsePgrep, parsePsCandidates } from './pulse-platform.mjs'
import {
  ACP_LIVENESS_SCHEMA, ID_RE, PULSE_SCHEMA, PULSE_SCHEMA_VERSION, PULSE_SCHEMA_VERSION_V2,
  PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4, UUID_RE, downProjectPulseV1,
  projectLivenessEvidence, projectPulseV4, validateAcpLivenessV1, verifiedLivenessModel,
} from './pulse-data.mjs'
// Relocated from delivery-loop-core.mjs, unchanged. Its sibling
// `PHASE_EXIT_ARTIFACTS` went with the delivery-loop projection, whose diagrams
// were its only readers.
//
// This is now a READER OF HISTORY only. Nothing writes a `phase:` line any
// more: `TMUX_TEAMS_PHASE` was retired on 2026-08-03 with the rest of the
// four-stage system, and no producer ever set it in the first place. Footprints
// written before that still carry the line and are still on operators' disks,
// so the binding stays and keeps rendering them exactly as it did. Only the
// KEYS are read — the successor map here has had no reader since the phase
// system was deleted, and it is kept because the four names it lists are the
// vocabulary those old footprints used.
const PHASE_BOUNDARIES = Object.freeze({
  Requirement: 'Prototype',
  Prototype: 'Development',
  Development: 'QA',
  QA: 'ProjectDelivery',
})
import { renderGraphPage } from './graph.mjs'
import { validateTeamGraph } from './team-graph-contract.mjs'
import { renderKanbanPage } from './kanban.mjs'
import { NAV_CSS, renderNav } from './page-nav.mjs'
import { renderPulseRefreshScript } from './pulse-refresh.mjs'

const [cmd, repoArg, ...flags] = process.argv.slice(2)
const USAGE = 'usage: pulse.mjs once|json <repo> [--team-graph FILE] [--team-runtime FILE] [--time-zone ZONE] | pulse.mjs watch|ensure <repo> [--interval SEC] [--team-graph FILE] [--team-runtime FILE] [--time-zone ZONE] | pulse.mjs compat-v1 <repo>'
if (!cmd || !repoArg || !['once', 'json', 'watch', 'ensure', 'compat-v1'].includes(cmd)) {
  console.error(USAGE); process.exit(2)
}
// Every argument has to be one THIS command reads. Until now anything unknown
// was ignored in silence, which stopped being harmless when v0.14.0 withdrew
// `--delivery-loop` and `--delivery-runtime`: a caller's script kept passing
// them, kept getting exit 0, and nothing it asked for happened. `--interval`
// and `--managed` are rejected on the commands that never look at them for the
// same reason — accepting a flag you ignore is a lie about what ran.
const VALUE_FLAGS = new Set(['--team-graph', '--team-runtime', '--time-zone'])
const BARE_FLAGS = new Set()
if (cmd === 'watch' || cmd === 'ensure') VALUE_FLAGS.add('--interval')
if (cmd === 'watch') BARE_FLAGS.add('--managed')
for (let i = 0; i < flags.length; i++) {
  const arg = flags[i]
  if (BARE_FLAGS.has(arg)) continue
  if (!VALUE_FLAGS.has(arg)) {
    console.error(`[pulse] unknown argument: ${arg}`)
    console.error(USAGE); process.exit(2)
  }
  const value = flags[i + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`[pulse] ${arg} needs a value`)
    console.error(USAGE); process.exit(2)
  }
  // A non-numeric interval used to fall through to the default of 20 without a
  // word, so `--interval abc` and `--interval 20` produced the same run.
  if (arg === '--interval' && !(Number(value) > 0)) {
    console.error(`[pulse] --interval needs a positive number of seconds, got "${value}"`)
    console.error(USAGE); process.exit(2)
  }
  i += 1
}
const teamGraphFlagIndexes = flags.flatMap((flag, index) => flag === '--team-graph' ? [index] : [])
const teamRuntimeFlagIndexes = flags.flatMap((flag, index) => flag === '--team-runtime' ? [index] : [])
const timeZoneFlagIndexes = flags.flatMap((flag, index) => flag === '--time-zone' ? [index] : [])
if (cmd === 'compat-v1' && flags.length > 0 ||
    teamGraphFlagIndexes.length > 1 ||
    (teamGraphFlagIndexes.length === 1 &&
      (!flags[teamGraphFlagIndexes[0] + 1] || flags[teamGraphFlagIndexes[0] + 1].startsWith('--'))) ||
    teamRuntimeFlagIndexes.length > 1 ||
    (teamRuntimeFlagIndexes.length === 1 &&
      (!flags[teamRuntimeFlagIndexes[0] + 1] || flags[teamRuntimeFlagIndexes[0] + 1].startsWith('--'))) ||
    timeZoneFlagIndexes.length > 1 ||
    (timeZoneFlagIndexes.length === 1 &&
      (!flags[timeZoneFlagIndexes[0] + 1] || flags[timeZoneFlagIndexes[0] + 1].startsWith('--')))) {
  console.error(USAGE); process.exit(2)
}
const TEAM_GRAPH_PATH = teamGraphFlagIndexes.length
  ? resolve(flags[teamGraphFlagIndexes[0] + 1])
  : null
const TEAM_RUNTIME_PATH = teamRuntimeFlagIndexes.length
  ? resolve(flags[teamRuntimeFlagIndexes[0] + 1])
  : null
const DEFAULT_TIME_ZONE = 'Asia/Bangkok'
const timeZoneInput = cmd === 'compat-v1'
  ? DEFAULT_TIME_ZONE
  : timeZoneFlagIndexes.length
    ? flags[timeZoneFlagIndexes[0] + 1].trim()
    : process.env.PULSE_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE
let DISPLAY_TIME_ZONE
try {
  DISPLAY_TIME_ZONE = new Intl.DateTimeFormat('en-US', { timeZone: timeZoneInput })
    .resolvedOptions().timeZone
} catch {
  console.error(`[pulse] invalid time zone "${timeZoneInput}"; use an IANA zone such as Asia/Bangkok`)
  process.exit(2)
}
if (!DISPLAY_TIME_ZONE) {
  console.error(USAGE)
  process.exit(2)
}

let REPO
try { REPO = realpathSync(repoArg) } catch { console.error(`[pulse] no such repo: ${repoArg}`); process.exit(2) }
const STORE = join(REPO, '.tmux-teams')
const OUT = join(STORE, 'pulse.html')
const GRAPH_OUT = join(STORE, 'graph.html')
const KANBAN_OUT = join(STORE, 'kanban.html')
const WORKFLOW_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const JSON_OUT = join(STORE, 'pulse.json')
const BUNDLE_OUT = join(STORE, 'pulse-current.json')
const FONT_CSS_NAME = `pulse-fonts-${createHash('sha256').update(KANIT_FONT_CSS).digest('hex')}.css`
const FONT_CSS_OUT = join(STORE, FONT_CSS_NAME)
const PULSE_REFRESH_SOURCE = renderPulseRefreshScript()
const PULSE_REFRESH_HASH = createHash('sha256').update(PULSE_REFRESH_SOURCE).digest('hex')
const PULSE_REFRESH_NAME = `pulse-refresh-${PULSE_REFRESH_HASH}.js`
const PULSE_REFRESH_OUT = join(STORE, PULSE_REFRESH_NAME)
const EVENTS = join(STORE, 'kms', 'events')
const DISPATCH = join(STORE, 'dispatch')
const LIVENESS = join(STORE, 'liveness')
const OUTBOX = join(REPO, '.mailbox-out')
const CTL = join(homedir(), '.tmux-teams', 'mailbox-run')
const WATCH_PID = join(STORE, 'pulse-watch.pid')
const WATCH_CONFIG = join(STORE, 'pulse-watch.config.json')
const PUBLISH_LOCK = join(STORE, 'pulse-publish.lock')
const THIS_SCRIPT = fileURLToPath(import.meta.url)
const MANAGED_WATCH = flags.includes('--managed')

const iFlag = flags.indexOf('--interval')
const INTERVAL = iFlag >= 0 && Number(flags[iFlag + 1]) > 0 ? Math.max(1, Math.ceil(Number(flags[iFlag + 1]))) : 20
const WATCH_HANDOFF_ATTEMPTS = 300

// Startup is slower than it looks: an ACP lane may sit in `npx` downloading its
// adapter before anything exists to probe. Announcing death during a worker's
// own installation is the fastest way to make the alarm worthless. Where a pane
// id was recorded we check it directly and skip the guessing entirely.
const GRACE_SEC = 300
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_SOURCE_FILES = 1000
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024
const DELIVERY_PHASE_SET = new Set(Object.keys(PHASE_BOUNDARIES))
const MAX_FIELD_CHARS = 256
const LIVENESS_FILE_LIMIT = 1000
// Producer fixtures and persisted footprints can legitimately be observed
// across a long operator session. Staleness remains timestamp-based; this is
// only the bounded evidence lease, not a filesystem-mtime grace period.
const LIVENESS_STALE_SEC = 6 * 3600
const LIVENESS_FUTURE_SKEW_MS = 120_000
const LIVENESS_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const LIVENESS_DIGEST_RE = /^sha256:[0-9a-f]{64}$/

function fieldValue(text, key) {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))
  if (!match) return ''
  const value = match[1].trim()
  return value.length <= MAX_FIELD_CHARS ? value : ''
}

function phaseBindingFromText(text, source) {
  const match = text.match(/^phase:[ \t]*(.*)$/m)
  if (!match) return { phase: '', phaseSource: 'unassigned', invalid: false }
  const value = match[1].trim()
  if (!value) return { phase: '', phaseSource: 'unassigned', invalid: false }
  if (!DELIVERY_PHASE_SET.has(value)) {
    return { phase: '', phaseSource: 'unassigned', invalid: true }
  }
  return { phase: value, phaseSource: source, invalid: false }
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
      const m = cmdline.match(/acp-companion\.mjs\s+(\S+)\s+\S+\s+(\S+)/)
      if (m) rows.push({ id: m[2], model: m[1], kind: 'acp', detail: `pid ${pid}`, pid })
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
function prioritizedSourceFiles(directory, files, priorityIds = new Set(), correlatedIds = new Set()) {
  const ranked = files.map((file) => {
    const id = file.replace(/\.(?:md|json)$/, '')
    let mtime = 0
    try { mtime = statSync(join(directory, file)).mtimeMs } catch { /* unreadable below */ }
    return {
      file,
      id,
      priority: priorityIds.has(id) ? 0 : correlatedIds.has(id) ? 1 : 2,
      mtime,
    }
  })
  ranked.sort((left, right) =>
    left.priority - right.priority || right.mtime - left.mtime || left.file.localeCompare(right.file, 'en'))
  return ranked
}

function footprints(inputBudget, liveIds = new Set()) {
  const byId = new Map()
  const diagnostics = []
  let invalidPhaseCount = 0
  let dispatchHealth = 'ok', outboxHealth = 'ok'
  let dispatchSourceTotal = 0
  let dispatchDiscarded = 0

  // The dispatch record is written by the PM the moment it dispatches, so it
  // survives a worker that dies before producing anything. Without it, the
  // truest silent death — dying before the first write — leaves no trace at
  // all, because dispatch DELETES any stale outbox first.
  let dispatches = []
  let outboxNames = []
  try { dispatches = readdirSync(DISPATCH).filter(f => f.endsWith('.md')) } catch (e) {
    if (e.code !== 'ENOENT') {
      dispatchHealth = 'degraded'
      diagnostics.push({ code: 'DISPATCH_UNREADABLE', severity: 'error', source: 'dispatch' })
    }
  }
  dispatchSourceTotal = dispatches.filter((file) => ID_RE.test(file.replace(/\.md$/, ''))).length
  try { outboxNames = readdirSync(OUTBOX) } catch { /* handled by the outbox read below */ }
  // A live process is the strongest correlation. Terminal outbox names are
  // intentionally not all promoted to priority: doing so can turn a source
  // cap into an unbounded read when stale history has many outboxes.
  const correlatedIds = new Set(liveIds)
  if (dispatches.length > MAX_SOURCE_FILES) {
    dispatchHealth = 'degraded'
    const selected = prioritizedSourceFiles(DISPATCH, dispatches, correlatedIds)
    dispatches = selected.slice(0, MAX_SOURCE_FILES).map((entry) => entry.file)
    dispatchDiscarded = Math.max(
      0,
      dispatchSourceTotal - dispatches.filter((file) => ID_RE.test(file.replace(/\.md$/, ''))).length,
    )
    diagnostics.push({
      code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'dispatch',
      count: Math.max(1, selected.length - dispatches.length),
    })
  } else {
    dispatches = prioritizedSourceFiles(DISPATCH, dispatches, correlatedIds).map((entry) => entry.file)
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
    const dispatchPhase = phaseBindingFromText(text, 'dispatch')
    if (dispatchPhase.invalid) {
      invalidPhaseCount += 1
      dispatchHealth = 'degraded'
    }
    byId.set(id, {
      id, mtime: st.mtimeMs, marker: '', terminalStatus: 'absent', dispatched: true, dispatchStatus: 'present',
      dispatchId: UUID_RE.test(dispatchId) ? dispatchId : '', startedAt: fieldValue(text, 'started_at'),
      timeoutSec: Number.isFinite(timeout) && timeout >= 0 ? timeout : null,
      transport: fieldValue(text, 'transport'), worker: fieldValue(text, 'worker'),
      agentId: ID_RE.test(fieldValue(text, 'agent_id')) ? fieldValue(text, 'agent_id') : '',
      model: fieldValue(text, 'model'), pane: fieldValue(text, 'pane'),
      phase: dispatchPhase.phase,
      phaseSource: dispatchPhase.phaseSource,
      // One team serves many workflows, so which route a dispatch runs is not
      // derivable from the declared graph — the caller records it or it stays
      // unplaced. Never inferred.
      workflow: WORKFLOW_ID_RE.test(fieldValue(text, 'workflow')) ? fieldValue(text, 'workflow') : '',
    })
  }
  if (invalidPhaseCount > 0) {
    diagnostics.push({
      code: 'PHASE_BINDING_INVALID',
      severity: 'warning',
      source: 'dispatch',
      count: invalidPhaseCount,
    })
  }

  let names = outboxNames
  try { if (!outboxNames.length) names = readdirSync(OUTBOX) } catch (e) {
    if (e.code !== 'ENOENT') {
      outboxHealth = 'degraded'
      diagnostics.push({ code: 'OUTBOX_UNREADABLE', severity: 'error', source: 'outbox' })
    }
  }
  if (names.length > MAX_SOURCE_FILES) {
    outboxHealth = 'degraded'
    const selected = prioritizedSourceFiles(OUTBOX, names, liveIds)
    names = selected.slice(0, MAX_SOURCE_FILES).map((entry) => entry.file)
    diagnostics.push({
      code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'outbox',
      count: Math.max(1, selected.length - names.length),
    })
  } else {
    names = prioritizedSourceFiles(OUTBOX, names, liveIds).map((entry) => entry.file)
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
    historySourceTotal: dispatchSourceTotal,
    historySourceDiscarded: dispatchDiscarded,
  }
}

function projectedLivenessEvidence(raw) {
  return projectLivenessEvidence({
    schema_version: raw.schema_version,
    task_id: raw.task_id,
    dispatch_id: raw.dispatch_id,
    agent_id: raw.agent_id ?? null,
    observed_at: raw.observed_at,
    liveness_state: raw.liveness_state,
    last_protocol_activity_at: raw.last_protocol_activity_at,
    last_meaningful_progress_at: raw.last_meaningful_progress_at,
    termination_reason: raw.termination_reason,
    active_tools: raw.active_tools,
    tools: raw.tools,
    stall_history: raw.stall_history,
  })
}

function readLivenessEvidence(
  inputBudget,
  priorityIds = new Set(),
  correlatedIds = new Set(),
  footprintsByTask = new Map(),
  configuredAgentIds = null,
  now = Date.now(),
) {
  let files = []
  const diagnostics = []
  const identityConflicts = new Set()
  const modelByDispatch = new Map()
  let health = 'ok'
  try { files = readdirSync(LIVENESS).filter((file) => file.endsWith('.json')) } catch (error) {
    if (error.code !== 'ENOENT') {
      health = 'degraded'
      diagnostics.push({ code: 'LIVENESS_EVIDENCE_UNREADABLE', severity: 'warning', source: 'liveness' })
    }
  }
  if (files.length > LIVENESS_FILE_LIMIT) {
    health = 'degraded'
    const selected = prioritizedSourceFiles(LIVENESS, files, priorityIds, correlatedIds)
    files = selected.slice(0, LIVENESS_FILE_LIMIT).map((entry) => entry.file)
    diagnostics.push({
      code: 'SOURCE_TRUNCATED', severity: 'warning', source: 'liveness',
      count: Math.max(1, selected.length - files.length),
    })
  }
  const byDispatch = new Map()
  for (const file of files) {
    const taskId = file.replace(/\.json$/, '')
    if (!ID_RE.test(taskId)) {
      health = 'degraded'
      diagnostics.push({ code: 'LIVENESS_EVIDENCE_INVALID', severity: 'warning', source: 'liveness', count: 1 })
      continue
    }
    const path = join(LIVENESS, file)
    let raw = ''
    let parsed = null
    let identityConflict = false
    try {
      const stats = statSync(path)
      if (!stats.isFile() || stats.size > MAX_INPUT_BYTES || stats.size > inputBudget.remaining) {
        throw Object.assign(new Error('liveness evidence unreadable'), { code: 'LIVENESS_EVIDENCE_UNREADABLE' })
      }
      inputBudget.remaining -= stats.size
      raw = readFileSync(path, 'utf8')
      parsed = JSON.parse(raw)
      if (parsed?.schema_version !== ACP_LIVENESS_SCHEMA || parsed?.task_id !== taskId) {
        throw Object.assign(new Error('liveness schema/task provenance mismatch'), {
          code: 'LIVENESS_EVIDENCE_MISMATCH',
        })
      }
      const validation = validateAcpLivenessV1(parsed)
      if (!validation.ok) {
        throw Object.assign(new Error(validation.reason || 'invalid liveness evidence'), {
          code: validation.code || 'LIVENESS_EVIDENCE_INVALID',
        })
      }
      const expected = footprintsByTask.get(taskId) || []
      const expectedDispatch = parsed?.dispatch_id
      const footprint = expected.find((item) => item.dispatchId === expectedDispatch)
      if (!footprint || !UUID_RE.test(String(expectedDispatch || ''))) {
        throw Object.assign(new Error('liveness provenance mismatch'), { code: 'LIVENESS_EVIDENCE_MISMATCH' })
      }
      identityConflict = Boolean(parsed?.agent_id && parsed.agent_id !== footprint.agentId)
      if (!identityConflict && configuredAgentIds instanceof Set && configuredAgentIds.size > 0 &&
          (!footprint.agentId || !configuredAgentIds.has(footprint.agentId))) {
        identityConflict = true
        throw Object.assign(new Error('configured graph agent identity mismatch'), {
          code: 'AGENT_ID_CONFLICT',
        })
      }
      if (identityConflict) {
        throw Object.assign(new Error('liveness identity mismatch'), { code: 'AGENT_ID_CONFLICT' })
      }
      const evidence = projectedLivenessEvidence(parsed)
      const observedAt = Date.parse(evidence.observed_at)
      if (!Number.isFinite(observedAt) || observedAt < now - LIVENESS_STALE_SEC * 1000) {
        throw Object.assign(new Error('stale liveness evidence'), { code: 'LIVENESS_EVIDENCE_MISMATCH' })
      }
      if (observedAt > now + LIVENESS_FUTURE_SKEW_MS) {
        throw Object.assign(new Error('liveness evidence is too far in the future'), {
          code: 'LIVENESS_EVIDENCE_FUTURE',
        })
      }
      byDispatch.set(`${taskId}\u0000${expectedDispatch}`, evidence)
      const model = verifiedLivenessModel(parsed)
      if (model) modelByDispatch.set(`${taskId}\u0000${expectedDispatch}`, model)
    } catch (error) {
      health = 'degraded'
      const code = ['LIVENESS_EVIDENCE_INVALID', 'LIVENESS_EVIDENCE_MISMATCH',
        'LIVENESS_EVIDENCE_FUTURE', 'AGENT_ID_CONFLICT'].includes(error.code)
        ? error.code : 'LIVENESS_EVIDENCE_UNREADABLE'
      if (code === 'AGENT_ID_CONFLICT') {
        diagnostics.push({ code: 'LIVENESS_EVIDENCE_MISMATCH', severity: 'warning', source: 'liveness', count: 1 })
      }
      diagnostics.push({ code, severity: code === 'AGENT_ID_CONFLICT' ? 'error' : 'warning', source: 'liveness', count: 1 })
      if (identityConflict) {
        identityConflicts.add(`${taskId}\u0000${String(parsed?.dispatch_id || '')}`)
      }
    }
  }
  return { byDispatch, diagnostics, health, identityConflicts, modelByDispatch }
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
  let invalidPhaseCount = 0
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
      const agentId = fieldValue(text, 'agent_id')
      const eventPhase = phaseBindingFromText(text, 'event')
      if (eventPhase.invalid) {
        invalidPhaseCount += 1
        health = 'degraded'
      }
      rows.push({
        task_id: task, worker, agentId: ID_RE.test(agentId) ? agentId : '',
        dispatch_id: UUID_RE.test(dispatchId) ? dispatchId : '',
        transport: fieldValue(text, 'transport'), terminal: fieldValue(text, 'terminal'),
        pm_verdict: fieldValue(text, 'pm_verdict'), started_at: fieldValue(text, 'started_at'),
        wait_sec: num('wait_sec'), timeout_sec: num('timeout_sec'),
        phase: eventPhase.phase,
        phaseSource: eventPhase.phaseSource,
        mtime: st.mtimeMs,
      })
    } catch {
      health = 'degraded'
      diagnostics.push({ code: 'EVENT_UNREADABLE', severity: 'error', source: 'events' })
    }
  }
  if (invalidPhaseCount > 0) {
    diagnostics.push({
      code: 'PHASE_BINDING_INVALID',
      severity: 'warning',
      source: 'events',
      count: invalidPhaseCount,
    })
  }
  return { rows, diagnostics, health }
}

const PM_VERDICTS = new Set(['pass', 'reject', 'unresolved'])
const hasPmVerdict = (r) => PM_VERDICTS.has(r.pm_verdict)

// ── DERIVE ───────────────────────────────────────────────────────────────────
function derive(now, configuredAgentIds = null) {
  const inputBudget = { remaining: MAX_TOTAL_INPUT_BYTES }
  const panesNow = paneInventory()
  const { rows: live, notes, diagnostics: liveDiagnostics } = aliveWorkers(panesNow)
  const liveIds = new Set(live.map((worker) => worker.id))
  const footResult = footprints(inputBudget, liveIds)
  const recordResult = recorded(inputBudget)
  const foot = footResult.rows
  const footprintsByDispatch = new Map()
  const footprintsByTask = new Map()
  for (const footprint of foot) {
    const taskMatches = footprintsByTask.get(footprint.id) || []
    taskMatches.push(footprint)
    footprintsByTask.set(footprint.id, taskMatches)
    if (!footprint.dispatchId) continue
    const matches = footprintsByDispatch.get(footprint.dispatchId) || []
    matches.push(footprint)
    footprintsByDispatch.set(footprint.dispatchId, matches)
  }
  const livenessResult = readLivenessEvidence(
    inputBudget,
    liveIds,
    new Set(foot.map((footprint) => footprint.id)),
    footprintsByTask,
    configuredAgentIds,
    now,
  )
  const conflictingDispatches = new Set()
  for (const [dispatchId, matches] of footprintsByDispatch) {
    const phases = new Set(
      matches.map(footprint => footprint.phase).filter(phase => DELIVERY_PHASE_SET.has(phase)),
    )
    if (phases.size > 1) conflictingDispatches.add(dispatchId)
  }
  const rec = recordResult.rows.map((row) => {
    const matches = row.dispatch_id
      ? footprintsByDispatch.get(row.dispatch_id) || []
      : []
    if (matches.length === 0) return row
    const dispatchPhases = new Set(
      matches.map(footprint => footprint.phase).filter(phase => DELIVERY_PHASE_SET.has(phase)),
    )
    const eventHasPhase = DELIVERY_PHASE_SET.has(row.phase)
    const bindingConflicts = dispatchPhases.size > 1 ||
      eventHasPhase && [...dispatchPhases].some(phase => phase !== row.phase)
    if (bindingConflicts) {
      conflictingDispatches.add(row.dispatch_id)
      return { ...row, phase: '', phaseSource: 'conflict' }
    }
    if (eventHasPhase) return row
    const [dispatchPhase] = dispatchPhases
    return dispatchPhase
      ? { ...row, phase: dispatchPhase, phaseSource: 'dispatch_join' }
      : row
  })
  const agentIdsByDispatch = new Map()
  const addAgentIdentity = (dispatchId, agentId) => {
    if (!dispatchId || !agentId) return
    const identities = agentIdsByDispatch.get(dispatchId) || new Set()
    identities.add(agentId)
    agentIdsByDispatch.set(dispatchId, identities)
  }
  for (const footprint of foot) {
    addAgentIdentity(footprint.dispatchId, footprint.agentId)
  }
  for (const row of rec) {
    addAgentIdentity(row.dispatch_id, row.agentId)
  }
  for (const evidence of livenessResult.byDispatch.values()) {
    addAgentIdentity(evidence.dispatch_id, evidence.agent_id)
  }
  const conflictingAgentDispatches = new Set([...agentIdsByDispatch.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([dispatchId]) => dispatchId))
  for (const key of livenessResult.identityConflicts) {
    const [, dispatchId] = key.split('\u0000')
    if (dispatchId) conflictingAgentDispatches.add(dispatchId)
  }
  const diagnostics = [
    ...liveDiagnostics,
    ...footResult.diagnostics,
    ...recordResult.diagnostics,
    ...livenessResult.diagnostics,
  ]
  if (conflictingDispatches.size > 0) {
    diagnostics.push({
      code: 'PHASE_BINDING_CONFLICT',
      severity: 'error',
      source: 'publisher',
      count: conflictingDispatches.size,
    })
  }
  if (conflictingAgentDispatches.size > 0) {
    diagnostics.push({
      code: 'AGENT_ID_CONFLICT', severity: 'error', source: 'publisher', count: conflictingAgentDispatches.size,
    })
  }
  // Worker ids get reused across runs, so an event only settles the footprint it
  // belongs to. Matching on id alone would let yesterday's record mark today's
  // dispatch "finished" and quietly drop it off the screen.
  const liveById = new Map(live.map(l => [l.id, l]))

  const active = []
  const history = []
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
    const verdictPhaseConflict = conflictingDispatches.has(f.dispatchId) ||
      verdicts.some(verdict => verdict.phaseSource === 'conflict')
    const settled = !!currentVerdict
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
    const livenessEvidence = livenessResult.byDispatch.get(`${f.id}\u0000${f.dispatchId}`) || null
    const livenessTerminal = ['completed', 'cancelled', 'failed'].includes(
      livenessEvidence?.liveness_state,
    )
    // The companion's last word outranks every probe on this page. A terminal
    // liveness state is a settled statement written by the process that ran
    // the leg; the OS scan and the grace window only guess at what that
    // process already reported. Without this first branch a leg that failed
    // with a held pane or inside GRACE_SEC kept reading 'starting'/'running'
    // - WORKING in every consumer of this row, busyAgents included, for up
    // to five minutes per corpse (measured on eventbox, 2026-08-12).
    const state = livenessTerminal ? 'died'
      : working ? 'running'
      : !PROC_OK ? 'unknown'
      : f.terminalStatus === 'unreadable' ? 'unknown'
      : f.marker ? (ageSec > UNRECORDED_SEC ? 'unrecorded' : 'awaiting-verdict')
      : paneHeld === true ? 'starting'
      : paneHeld === false ? 'died'
      : f.pane && !panesNow.available ? 'unknown'
      : ageSec <= GRACE_SEC ? 'starting'
      : 'died'
    const livenessCurrent = Boolean(livenessEvidence) && !livenessTerminal
    const projected = {
      ...f, alive: !!alive, detail: alive ? alive.detail : '',
      kind: (alive && alive.kind) || f.transport || '', ageSec, elapsedSec, state,
      liveness: working || livenessCurrent ? 'alive' : PROC_OK ? 'dead' : 'unknown', paneStatus,
      model: livenessResult.modelByDispatch.get(`${f.id}\u0000${f.dispatchId}`) || null,
      livenessEvidence,
      identityConflict: Boolean(f.dispatchId && conflictingAgentDispatches.has(f.dispatchId)),
      agentId: f.dispatchId && conflictingAgentDispatches.has(f.dispatchId)
        ? ''
        : f.agentId || livenessResult.byDispatch.get(`${f.id}\u0000${f.dispatchId}`)?.agent_id || '',
      pmVerdict: currentVerdict?.pm_verdict || '',
      idleShell: !!(alive && alive.kind === 'tmux' && alive.hasChild === false),
      phase: verdictPhaseConflict ? '' : f.phase,
      phaseSource: verdictPhaseConflict ? 'conflict' : f.phaseSource,
    }
    const terminalEvidence = settled || Boolean(f.marker) || livenessTerminal
    const deadAttempt = !working && state === 'died'
    if (terminalEvidence || deadAttempt || state === 'unrecorded') history.push(projected)
    else active.push(projected)
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
      kind: l.kind, detail: l.detail, model: null, ageSec: null, elapsedSec: null, timeoutSec: null,
      paneStatus: l.kind === 'tmux' ? 'held' : 'not_recorded', pmVerdict: '', state: 'orphan_running',
      livenessEvidence: null,
      identityConflict: false,
      agentId: '',
      phase: '', phaseSource: 'unassigned',
    })
  }
  const unclaimed = unclaimedControlDirs(liveIds, new Set(foot.map(f => f.id)))
  for (const code of [...new Set(diagnostics.map(d => d.code))]) {
    if (code !== 'LIVENESS_UNAVAILABLE') notes.push(`pulse source degraded: ${code}`)
  }
  return {
    active, history, rec, notes, unclaimed, diagnostics,
    historyTotal: history.length + footResult.historySourceDiscarded,
    sourceHealth: {
      liveness: !PROC_OK ? 'unavailable' : livenessResult.health,
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
const TIME_ZONE_LABEL = DISPLAY_TIME_ZONE === DEFAULT_TIME_ZONE
  ? 'เวลาไทย (UTC+7)'
  : `เขตเวลา ${DISPLAY_TIME_ZONE}`
const DISPLAY_DATE_TIME = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function absoluteTime(value) {
  const text = displayTimeText(value)
  if (text === 'ไม่ระบุ') return text
  return `<time datetime="${esc(value)}" title="${esc(DISPLAY_TIME_ZONE)}" aria-describedby="pulse-timezone-label">${text}</time>`
}

// Keep the date computation separately testable from its semantic HTML shell.
// Pulse JSON stays in UTC; only this human projection uses the configured zone.
function displayTimeText(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'ไม่ระบุ'
  const parts = Object.fromEntries(DISPLAY_DATE_TIME.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
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
  // These two had no entry, so both fell through to "ข้อมูลบางส่วนอ่านไม่ได้" —
  // a sentence that names neither the file nor the reason, printed once per
  // rejected file. What a reader needs is which evidence was refused and why it
  // was right to refuse it: this is the loop declining to trust a claim, not
  // the loop failing to read one.
  LIVENESS_EVIDENCE_MISMATCH: 'หลักฐาน liveness ไม่ตรงกับงานที่สั่ง จึงไม่ถูกนับ',
  LIVENESS_EVIDENCE_INVALID: 'หลักฐาน liveness ผิดสัญญา จึงไม่ถูกนับ',
  TMUX_UNAVAILABLE: 'เชื่อมต่อ tmux ไม่ได้',
  DISPATCH_UNREADABLE: 'อ่านข้อมูลการสั่งงานไม่ได้',
  OUTBOX_UNREADABLE: 'อ่านผลลัพธ์จาก worker ไม่ได้',
  EVENT_UNREADABLE: 'อ่านบันทึกเหตุการณ์ไม่ได้',
  INVALID_EVENT_ENTRY: 'พบบันทึกเหตุการณ์ที่ไม่ถูกต้อง',
  SOURCE_TRUNCATED: 'ข้อมูลต้นทางถูกจำกัดเพื่อความปลอดภัย',
  SEQUENCE_RESET: 'เริ่มลำดับ snapshot ใหม่',
  SCHEMA_UPGRADED: 'อัปเกรดข้อมูล Pulse เป็นรุ่นใหม่',
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
function render(snapshot, { refreshScriptName = PULSE_REFRESH_NAME } = {}) {
  const active = snapshot.runs
  const rec = snapshot.recent_verdicts
  const notes = snapshot.diagnostics
  const unclaimed = snapshot.unclaimed_control
  const attentionStates = ['died', 'unknown', 'unrecorded', 'orphan_running']
  const attention = active.filter(a => attentionStates.includes(a.state))
  const tracked = active.filter(a => ['running', 'starting', 'awaiting-verdict'].includes(a.state))
  const recent = rec
  const st = snapshot.worker_stats
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

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>pulse — ${esc(repoName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="tmux-teams-snapshot-id" content="${esc(snapshot.snapshot_id)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231f6f5f'/%3E%3Cpath d='M14 35h11l6-19 9 32 7-15h5' fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${FONT_CSS_NAME}">
<style>
:root{color-scheme:dark;--bg:oklch(17% .012 165);--surface:oklch(21% .014 165);--surface-2:oklch(24% .015 165);--line:oklch(34% .014 165);--ink:oklch(93% .012 165);--dim:oklch(71% .018 165);--ok:oklch(74% .13 165);--warn:oklch(78% .13 78);--bad:oklch(72% .16 28);--focus:oklch(78% .12 235);--sans:"Kanit","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--r-sm:8px;--r-md:14px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:oklch(97% .008 165);--surface:oklch(99% .004 165);--surface-2:oklch(95% .012 165);--line:oklch(87% .014 165);--ink:oklch(24% .018 165);--dim:oklch(50% .022 165);--ok:oklch(50% .12 165);--warn:oklch(53% .13 72);--bad:oklch(52% .16 28);--focus:oklch(52% .13 235)}}
*{box-sizing:border-box}html{max-width:100%;font-size:16px}body{max-width:100%;margin:0;padding:var(--s5);background:var(--bg);color:var(--ink);font:400 1rem/1.65 var(--sans);text-rendering:optimizeLegibility}
.wrap{min-width:0;max-width:1180px;margin:0 auto}.skip-link{position:fixed;top:var(--s3);left:var(--s3);z-index:10;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);opacity:0;white-space:nowrap;background:var(--ink);color:var(--bg);padding:0;border-radius:var(--r-sm)}.skip-link:focus{width:auto;height:auto;overflow:visible;clip-path:none;opacity:1;padding:var(--s2) var(--s4)}
${NAV_CSS}
.site-header{display:flex;min-width:0;justify-content:space-between;align-items:flex-start;gap:var(--s5);padding:var(--s2) 0 var(--s5);border-bottom:1px solid var(--line)}.site-header>*,main>*,section,.primary-grid>*{min-width:0}
.eyebrow{display:block;margin:0 0 var(--s1);color:var(--dim);font:500 .75rem/1.4 var(--sans);letter-spacing:.08em;text-transform:uppercase}
h1{display:flex;min-width:0;align-items:baseline;gap:var(--s3);margin:0;font:600 1.75rem/1.2 var(--sans);letter-spacing:-.02em}h1 .repo{min-width:0;color:var(--dim);font:500 1rem var(--mono);letter-spacing:0;overflow-wrap:anywhere}
.scope{max-width:62ch;margin:var(--s2) 0 0;color:var(--dim);font-size:.875rem}.loop-graph-link{display:inline-block;margin-top:var(--s2);color:var(--ink);font-size:.78rem;text-decoration:none;border-bottom:1px solid var(--line)}.loop-graph-link:hover{border-color:var(--ink)}.header-status{display:flex;min-width:0;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap;gap:var(--s3);text-align:right}.status-badges{display:flex;min-width:0;flex-wrap:wrap;justify-content:flex-end;gap:var(--s2)}.age{min-width:0;color:var(--dim);font-size:.8rem;line-height:1.5;overflow-wrap:anywhere}.age time,.freshness-note,.time-zone-label{display:block}.time-zone-label{color:var(--ink);font-weight:500}.age time{color:var(--ink);font-family:var(--mono);font-variant-numeric:tabular-nums}
  .quality{display:inline-flex;align-items:center;gap:var(--s2);white-space:nowrap;padding:6px 10px;border:1px solid var(--line);border-radius:999px;font-size:.78rem;font-weight:500}.quality::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}.quality.complete{color:var(--dim)}.quality.ok{color:var(--ok)}.quality.warn{color:var(--warn)}.age button{min-height:44px;margin-top:var(--s2);padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2);color:var(--ink);font:500 .78rem var(--sans);cursor:pointer}.age button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
main{display:grid;min-width:0;gap:var(--s7);padding-top:var(--s6)}.summary-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}.metric{min-width:0;padding:var(--s5);border-left:1px solid var(--line)}.metric:first-child{border-left:0}.metric-label,.metric-note{display:block;color:var(--dim);font-size:.82rem}.metric-value{display:block;margin:2px 0;font:600 2rem/1.2 var(--sans);font-variant-numeric:tabular-nums}.metric.bad .metric-value{color:var(--bad)}.metric.ok .metric-value{color:var(--ok)}.metric.warn .metric-value{color:var(--warn)}
body[data-observation-freshness="stale"] .metric.ok .metric-value{color:var(--dim)}body[data-observation-freshness="stale"] .pill.running{background:color-mix(in srgb,var(--dim) 16%,transparent);color:var(--dim)}body[data-observation-freshness="stale"] .status-dot.running{background:var(--dim)}
.diagnostics{border:1px solid color-mix(in oklch,var(--warn) 45%,var(--line));border-radius:var(--r-md);background:color-mix(in oklch,var(--warn) 8%,var(--surface));padding:var(--s4) var(--s5)}.diagnostics h2{margin:0 0 var(--s2);font-size:1rem}.diagnostics ul{display:grid;gap:var(--s2);margin:0;padding:0;list-style:none}.diagnostics li{display:flex;justify-content:space-between;gap:var(--s4);color:var(--dim);font-size:.875rem}.diagnostics strong{color:var(--ink);font-weight:500}.diagnostics code{font-size:.75rem}
.diagram-equivalent h3{margin:0 0 var(--s3);font-size:1rem}
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
@media(max-width:820px){body{padding:var(--s4)}.site-header{display:grid}.header-status,.status-badges{justify-content:flex-start;text-align:left}.summary-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{border-top:1px solid var(--line)}.metric:nth-child(-n+2){border-top:0}.metric:nth-child(odd){border-left:0}.primary-grid,.run-list-dense{grid-template-columns:1fr}.run-list-dense .run-item{border-left:0}.run-list-dense .run-item:nth-child(2){border-top:1px solid var(--line)}main{gap:var(--s6)}}
@media(max-width:620px){h1{display:grid;gap:2px;font-size:1.5rem}.header-status,.status-badges{display:grid;justify-items:start}.quality{white-space:normal}.metric{padding:var(--s4)}.metric-value{font-size:1.65rem}.section-head{align-items:start}.run-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.run-facts div:last-child{grid-column:1/-1}.warning-list li{grid-template-columns:1fr auto}.warning-list p{grid-column:1/-1}.responsive-table table,.responsive-table tbody,.responsive-table tr,.responsive-table td{display:block;min-width:0}.responsive-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.responsive-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s3);padding:var(--s4);border-top:1px solid var(--line)}.responsive-table tbody tr:first-child{border-top:0}.responsive-table td{padding:0;border:0;overflow-wrap:anywhere}.responsive-table td:first-child{grid-column:1/-1}.responsive-table td::before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--dim);font-size:.7rem}.deep-dive>summary{padding:var(--s4)}.detail-body{padding:var(--s3)}.graph-legend,.diagram-legend{display:grid}}
@media(max-width:360px){body{padding:var(--s3)}.summary-strip,.runtime-summary{grid-template-columns:1fr}.metric,.metric:nth-child(-n+2){border-top:1px solid var(--line);border-left:0}.metric:first-child{border-top:0}.run-facts{grid-template-columns:1fr}.run-facts div:last-child{grid-column:auto}.responsive-table tr{grid-template-columns:1fr}.responsive-table td:first-child{grid-column:auto}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
@media(forced-colors:active){.graph-scroll:focus-visible,.diagram-scroll:focus-visible{outline-color:Highlight}.legend-dot,.legend-line{border-color:CanvasText;background:CanvasText}}
</style></head><body data-observation-freshness="${initiallyStale ? 'stale' : 'fresh'}"><div class="wrap">

<a class="skip-link" href="#main">ข้ามไปยังสถานะงาน</a>

${renderNav('pulse')}
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
    <div class="age"><span id="pulse-timezone-label" class="time-zone-label">${esc(TIME_ZONE_LABEL)}</span><span>ข้อมูลที่สังเกต ณ</span>${absoluteTime(snapshot.generated_at)}<span id="freshness-note" data-refresh-note class="freshness-note">${!expiryIsValid ? 'ตรวจเวลาหมดอายุไม่ได้' : initiallyStale ? 'ตัวสังเกตการณ์ไม่อัปเดตตามรอบ' : `กำหนดรีเฟรชทุก ${refreshInterval} วิ`}</span><button type="button" data-refresh-toggle data-refresh-focus-key="refresh-toggle" aria-pressed="false">Pause updates</button></div>
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
    <div class="surface table-scroll responsive-table" data-refresh-scroll-key="recent-runs" tabindex="0">${recent.length ? `<table><caption>บันทึกผลล่าสุด; คำตัดสินอ่านจากฟิลด์เดิม pm_verdict</caption><thead><tr><th>งาน</th><th>worker</th><th>ผลจาก worker</th><th>คำตัดสินที่บันทึก (pm_verdict)</th><th>เริ่ม</th><th>ใช้เวลา</th><th>dispatch</th></tr></thead><tbody>
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
      <details class="deep-dive" data-persist-key="progress"><summary>ความคืบหน้าของแต่ละงาน</summary><div class="detail-body">${renderGraphLegend()}<div class="graph-scroll" data-refresh-scroll-key="progress-graph" tabindex="0" role="region" aria-label="กราฟความคืบหน้าของแต่ละงานแบบเลื่อนแนวนอนได้">${renderGraph(graph)}</div>${renderGraphEquivalent(graph)}</div></details>
      <details class="deep-dive" data-persist-key="system-loop"><summary>ลูปสองชั้น: ทีมตรวจ worker · PM ติดตาม phase</summary><div class="detail-body"><ul class="diagram-legend" aria-label="วิธีอ่านเส้นในโมเดลลูปสองชั้น"><li><span class="legend-line" aria-hidden="true"></span>เส้นทึบ · เส้นทางตามโมเดล ไม่ใช่ event สด</li><li><span class="legend-line dashed" aria-hidden="true"></span>เส้นประ · transition ที่ Pulse ยังไม่วัดว่าเกิดจริง</li><li><span class="legend-line bad" aria-hidden="true"></span>เส้นแดง · ทางยกระดับข้อยกเว้น; ตัวเลขมาจากหลักฐานหยุดผิดปกติ</li></ul><div class="diagram-scroll" data-refresh-scroll-key="system-loop" tabindex="0" role="region" aria-label="แผนภาพลูปสองชั้นเชิงบรรทัดฐานของการสั่งงาน worker และการส่งมอบแบบเลื่อนแนวนอนได้">${renderLoop(snapshot)}</div><p class="diagram-note"><strong>โมเดลเชิงบรรทัดฐาน ไม่ใช่สถานะสด</strong> ทีมเฟสเป็นเจ้าของ dispatch/verification ตามปกติ ส่วน PM คุมลูปชั้นนอกและรับเฉพาะข้อยกเว้น; ตัวเลขมาจากหลักฐาน dispatch และ verdict เดิมที่ Pulse อ่านได้ แต่เส้นทางของโมเดลไม่ได้ยืนยันว่า transition เกิดขึ้นจริง.</p><section class="diagram-equivalent" aria-labelledby="worker-loop-equivalent-title"><h3 id="worker-loop-equivalent-title">ข้อความเทียบเท่าลูปสองชั้น</h3><ol><li>ตามโมเดล PM กำหนดเป้าหมาย ติดตาม phase, handoff และ bottleneck โดยไม่รับตรวจ worker ทุกงาน</li><li>ตามโมเดลทีมเฟสแตกงานเป็น slice พร้อม validation แล้ว dispatch ให้ worker</li><li>ตามโมเดล worker ส่งหลักฐานกลับให้ผู้ตรวจของทีม; ผ่านจึงนำไปประกอบ exit artifact</li><li>งานที่ไม่ผ่านควรสร้าง dispatch หรือ attempt ใหม่ภายในทีม; Pulse ยังไม่วัดว่าการวนนี้เกิดจริง</li><li>exception, deadlock, policy conflict หรือ bottleneck เท่านั้นที่โมเดลยกระดับให้ PM แก้</li></ol></section></div></details>
      <details class="deep-dive" data-persist-key="worker-stats"><summary>สถิติ worker</summary><div class="detail-body surface table-scroll responsive-table" data-refresh-scroll-key="worker-stats" tabindex="0">${st.length ? `<table><caption>สถิติ worker</caption><thead><tr><th>worker</th><th>รอบทั้งหมด</th><th>ให้แก้ไข</th><th>เวลากลาง</th></tr></thead><tbody>
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
<script src="${esc(refreshScriptName)}" defer></script>
</body></html>`
}

const lockWait = new Int32Array(new SharedArrayBuffer(4))
const pause = (ms) => Atomics.wait(lockWait, 0, 0, ms)
const PUBLISH_LEASE_MS = 5 * 60_000
const PUBLISH_LOCK_WAIT_MS = 10_000

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
  const deadline = Date.now() + PUBLISH_LOCK_WAIT_MS
  let attempt = 0
  while (Date.now() < deadline) {
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
      // A bounded stagger avoids waking every concurrent publisher on the
      // same 5ms cadence while still keeping interactive publication prompt.
      pause(Math.min(5 + attempt, 50))
      attempt += 1
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

function readProjectionInput(path, unreadableCode, invalidCode) {
  if (!path) return { value: null, issue: null }
  let descriptor = null
  try {
    descriptor = openSync(path, 'r')
    const stats = fstatSync(descriptor)
    if (!stats.isFile()) return { value: null, issue: unreadableCode }
    if (stats.size > MAX_INPUT_BYTES) return { value: null, issue: invalidCode }
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_INPUT_BYTES) return { value: null, issue: invalidCode }
    return { value: JSON.parse(buffer.toString('utf8', 0, bytesRead)), issue: null }
  } catch (error) {
    return {
      value: null,
      issue: error instanceof SyntaxError ? invalidCode : unreadableCode,
    }
  } finally {
    if (descriptor !== null) try { closeSync(descriptor) } catch { /* best effort */ }
  }
}

function readTeamGraphInput() {
  const input = readProjectionInput(
    TEAM_GRAPH_PATH,
    'TEAM_GRAPH_INPUT_UNREADABLE',
    'TEAM_GRAPH_INPUT_INVALID',
  )
  if (!TEAM_GRAPH_PATH) return { ...input, sourceDigest: null }
  try {
    const stats = statSync(TEAM_GRAPH_PATH)
    if (!stats.isFile() || stats.size > MAX_INPUT_BYTES) {
      return { value: null, issue: 'TEAM_GRAPH_INPUT_INVALID', sourceDigest: null }
    }
    const bytes = readFileSync(TEAM_GRAPH_PATH)
    return {
      ...input,
      sourceDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }
  } catch {
    return { value: null, issue: 'TEAM_GRAPH_INPUT_UNREADABLE', sourceDigest: null }
  }
}

function readTeamRuntimeInput() {
  return readProjectionInput(
    TEAM_RUNTIME_PATH,
    'TEAM_RUNTIME_INPUT_UNREADABLE',
    'TEAM_RUNTIME_INPUT_INVALID',
  )
}

function atomicWriteIfChanged(path, content, publishToken = null) {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  atomicWrite(path, content, publishToken)
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const sourceContentIdentity = (path) => {
  if (!path) return null
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > MAX_INPUT_BYTES) return null
    return `sha256:${sha256(readFileSync(path))}`
  } catch { return null }
}
function bundleManifest(snapshot, jsonText, html, graphHtml, kanbanHtml) {
  return `${JSON.stringify({
    schema: 'tmux-teams.pulse-bundle',
    schema_version: 2,
    snapshot_id: snapshot.snapshot_id,
    files: {
      data: { path: 'pulse.json', sha256: sha256(jsonText) },
      dashboard: { path: 'pulse.html', sha256: sha256(html) },
      graph: { path: 'graph.html', sha256: sha256(graphHtml) },
      kanban: { path: 'kanban.html', sha256: sha256(kanbanHtml) },
      font_css: { path: FONT_CSS_NAME, sha256: sha256(KANIT_FONT_CSS) },
      refresh_js: { path: PULSE_REFRESH_NAME, sha256: PULSE_REFRESH_HASH },
    },
  }, null, 2)}\n`
}

function priorStream(view, targetVersion) {
  if (!existsSync(JSON_OUT)) return { streamId: randomUUID(), sequence: 1 }
  try {
    const prior = JSON.parse(readFileSync(JSON_OUT, 'utf8'))
    if (prior.schema !== PULSE_SCHEMA ||
        ![
          PULSE_SCHEMA_VERSION, PULSE_SCHEMA_VERSION_V2, PULSE_SCHEMA_VERSION_V3,
          PULSE_SCHEMA_VERSION_V4,
        ]
          .includes(prior.schema_version) ||
        !UUID_RE.test(prior.stream_id) || !Number.isSafeInteger(prior.sequence) ||
        prior.sequence < 1 || prior.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('invalid prior pulse')
    if (prior.schema_version !== targetVersion) {
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
  const teamGraphInput = readTeamGraphInput()
  const teamRuntimeInput = readTeamRuntimeInput()
  // Same check the legacy graph page ran, taken straight from the contract
  // module instead of through a renderer this repo no longer ships.
  const teamGraphCheck = validateTeamGraph(teamGraphInput.value)
  const normalizedTeamGraph = teamGraphCheck.ok ? teamGraphCheck.value : null
  const configuredAgentIds = normalizedTeamGraph
    ? new Set([
        ...(normalizedTeamGraph.outer_controller_id ? [normalizedTeamGraph.outer_controller_id] : []),
        ...normalizedTeamGraph.teams.flatMap((team) => team.agents.map((agent) => agent.agent_id)),
      ])
    : null
  const view = derive(startedAt, configuredAgentIds)
  const finishedAt = Date.now()
  const targetVersion = PULSE_SCHEMA_VERSION_V4
  mkdirSync(STORE, { recursive: true })
  const ignore = join(STORE, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const token = claimPublishLock()
  try {
    const stream = priorStream(view, targetVersion)
    const meta = {
      ...stream, startedAt, finishedAt, intervalSec: INTERVAL,
      repoName: REPO.split('/').pop(),
      teamGraphSourceDigest: teamGraphInput.sourceDigest,
    }
    const snapshot = projectPulseV4(
      view,
      meta,
      teamGraphInput.value,
      teamGraphInput.issue,
      Boolean(TEAM_GRAPH_PATH),
      teamRuntimeInput.value,
      teamRuntimeInput.issue,
      Boolean(TEAM_RUNTIME_PATH),
    )
    const jsonText = JSON.stringify(snapshot, null, 2) + '\n'
    // Render the exact serialized contract, not the internal projection object.
    // This makes pulse.json the literal SSOT and catches serialization drift.
    const publishedSnapshot = JSON.parse(jsonText)
    const html = render(publishedSnapshot, { refreshScriptName: PULSE_REFRESH_NAME })
    // Reads the repo's declared Team graph, or falls back to the bundled
    // four-team template so a fresh install has a page on the first run.
    const graphHtml = renderGraphPage(REPO, publishedSnapshot,
      { fontCssName: FONT_CSS_NAME, refreshScriptName: PULSE_REFRESH_NAME })
    // Same two sources as the flow page, asked the other question: where the
    // work is right now, rather than who exists and how the team is wired.
    const kanbanHtml = renderKanbanPage(REPO, publishedSnapshot,
      { fontCssName: FONT_CSS_NAME, refreshScriptName: PULSE_REFRESH_NAME })
    const bundleText = bundleManifest(publishedSnapshot, jsonText, html, graphHtml, kanbanHtml)
    assertPublishLock(token)
    atomicWriteIfChanged(FONT_CSS_OUT, KANIT_FONT_CSS, token)
    assertPublishLock(token)
    assertPublishLock(token)
    assertPublishLock(token)
    atomicWriteIfChanged(PULSE_REFRESH_OUT, PULSE_REFRESH_SOURCE, token)
    assertPublishLock(token)
    atomicWrite(JSON_OUT, jsonText, token)
    assertPublishLock(token)
    atomicWrite(OUT, html, token)
    assertPublishLock(token)
    assertPublishLock(token)
    atomicWrite(GRAPH_OUT, graphHtml, token)
    assertPublishLock(token)
    atomicWrite(KANBAN_OUT, kanbanHtml, token)
    // This commit marker is written last. Readers validate its hashes and
    // snapshot id, then re-read it to detect a publication racing their read.
    assertPublishLock(token)
    atomicWrite(BUNDLE_OUT, bundleText, token)
    return {
      htmlPath: OUT,
      graphPath: GRAPH_OUT,
      kanbanPath: KANBAN_OUT,
      bundlePath: BUNDLE_OUT,
      jsonText,
      snapshot: publishedSnapshot,
    }
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
    schema_version: PULSE_SCHEMA_VERSION_V4,
    team_graph_source: sourceContentIdentity(TEAM_GRAPH_PATH),
    team_runtime_source: sourceContentIdentity(TEAM_RUNTIME_PATH),
    time_zone: DISPLAY_TIME_ZONE,
  }
}

function readWatcherConfig() {
  try {
    const stats = statSync(WATCH_CONFIG)
    if (!stats.isFile() || stats.size > 4096) return null
    const value = JSON.parse(readFileSync(WATCH_CONFIG, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 5 ||
        !Object.hasOwn(value, 'pid') ||
        !Object.hasOwn(value, 'schema_version') ||
        !Object.hasOwn(value, 'team_graph_source') ||
        !Object.hasOwn(value, 'team_runtime_source') ||
        !Object.hasOwn(value, 'time_zone') ||
        !Number.isSafeInteger(value.pid) || value.pid < 1 ||
        value.schema_version !== PULSE_SCHEMA_VERSION_V4 ||
        !(value.team_graph_source === null ||
          typeof value.team_graph_source === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(value.team_graph_source)) ||
        !(value.team_runtime_source === null ||
          typeof value.team_runtime_source === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(value.team_runtime_source)) ||
        typeof value.time_zone !== 'string' ||
        value.time_zone.length === 0) return null
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
    actual.team_graph_source === desired.team_graph_source &&
    actual.team_runtime_source === desired.team_runtime_source &&
    actual.time_zone === desired.time_zone
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
        '[pulse] watcher mode/input mismatch; stop the existing watcher before changing --team-graph, --team-runtime, or --time-zone',
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
  if (TEAM_GRAPH_PATH) watchArgs.push('--team-graph', TEAM_GRAPH_PATH)
  if (TEAM_RUNTIME_PATH) watchArgs.push('--team-runtime', TEAM_RUNTIME_PATH)
  watchArgs.push('--time-zone', DISPLAY_TIME_ZONE)
  const child = spawn(process.execPath,
    watchArgs, {
      detached: true,
      stdio: 'ignore',
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
  for (let i = 0; i < WATCH_HANDOFF_ATTEMPTS; i++) {
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
  // --managed is not a command: it is the second half of the handoff that
  // `ensure` begins, so the only process entitled to take the claim is the
  // child of the process already holding it. The kernel answers who that is.
  // An environment variable could not: the pid it carried was read out of the
  // world-readable pidfile the operator was already looking at, so handing it
  // back was accepted, overwrote the pidfile below, and the watcher it named
  // exited at its next tick for losing a claim nobody was entitled to take.
  //
  // This binds the handoff to a DIRECT parent-child spawn. Nothing today puts a
  // process between `ensure` and its watch child; anything that later does — an
  // `sh -c` wrapper, a supervisor, an exec shim — breaks here, loudly and
  // fail-closed, rather than by a watcher that quietly never starts.
  const owner = process.ppid
  if (watcherPid() !== owner) {
    console.error('[pulse] --managed is the pidfile handoff performed by "pulse.mjs ensure";'
      + ' run "pulse.mjs ensure <repo>" for a background watcher, or drop --managed to watch here')
    process.exit(1)
  }
  // Reachable only as ensure's own child: the inputs it forwarded no longer
  // resolve to the identity it recorded.
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
console.log(`[pulse] team delivery flow -> ${GRAPH_OUT}`)
console.log(`[pulse] kanban board -> ${KANBAN_OUT}`)
console.log('[pulse] open either HTML file in a browser; both refresh themselves')
const tick = () => {
  if (watcherPid() !== process.pid) {
    console.error('[pulse] watcher lost its pidfile claim; exiting')
    process.exit(1)
  }
  try { once() } catch (e) { console.error(`[pulse] render failed: ${e.message}`) }
}
if (!MANAGED_WATCH) tick()
setInterval(tick, INTERVAL * 1000)
