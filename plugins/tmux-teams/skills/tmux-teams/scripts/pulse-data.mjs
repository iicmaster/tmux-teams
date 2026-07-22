// Pure, allowlisted projection for the machine-readable Pulse contract.
//
// This module deliberately does not serialize Pulse's internal observations
// wholesale. Repo-local dispatch/KMS files are writable by the same UID as a
// worker, so every string crossing this boundary is treated as untrusted data.

export const PULSE_SCHEMA = 'tmux-teams.pulse'
export const PULSE_SCHEMA_VERSION = 1
export const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const RUN_LIMIT = 100
const RECENT_LIMIT = 12
const DIAGNOSTIC_LIMIT = 50
const UNCLAIMED_LIMIT = 8
const WORKER_STATS_LIMIT = 100
const DIAGNOSTIC_CODES = new Set([
  'LIVENESS_UNAVAILABLE', 'TMUX_UNAVAILABLE', 'DISPATCH_UNREADABLE',
  'OUTBOX_UNREADABLE', 'EVENT_UNREADABLE', 'INVALID_EVENT_ENTRY',
  'SOURCE_TRUNCATED', 'SEQUENCE_RESET',
])

const STATE_META = Object.freeze({
  running: { attention: false, reason: 'PROCESS_ALIVE', action: 'monitor' },
  starting: { attention: false, reason: 'STARTUP_IN_PROGRESS', action: 'wait' },
  'awaiting-verdict': { attention: true, reason: 'TERMINAL_WITHOUT_PM_VERDICT', action: 'verify_result' },
  unrecorded: { attention: true, reason: 'PM_VERDICT_RECORD_MISSING', action: 'record_verdict' },
  died: { attention: true, reason: 'PROCESS_MISSING_AFTER_DISPATCH', action: 'inspect_worker' },
  unknown: { attention: true, reason: 'LIVENESS_UNAVAILABLE', action: 'restore_observability' },
  orphan_running: { attention: true, reason: 'LIVE_PROCESS_WITHOUT_DISPATCH', action: 'inspect_ownership' },
})

const safeId = (value) => ID_RE.test(String(value || '')) ? String(value) : null
const safeUuid = (value) => UUID_RE.test(String(value || '')) ? String(value) : null
const safeRepoName = (value) => /^[A-Za-z0-9_.-]{1,80}$/.test(String(value || '')) ? String(value) : null
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0 ? value : null
const safeIso = (value) => {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const terminal = (marker) => ({
  TEAM_DONE: 'done', TEAM_BLOCKED: 'blocked', TEAM_FAILED: 'failed',
}[marker] || (marker ? 'invalid' : 'absent'))

const verdict = (value) => ['pass', 'reject', 'unresolved'].includes(value) ? value : 'absent'
const transport = (value) => ['tmux', 'acp'].includes(value) ? value : null
const pane = (value) => ['held', 'gone', 'not_recorded', 'probe_unavailable'].includes(value) ? value : 'not_recorded'
const liveness = (value) => ['alive', 'dead', 'unknown'].includes(value) ? value : 'unknown'
const sourceState = (value) => ['ok', 'degraded', 'unavailable'].includes(value) ? value : 'degraded'
const dispatchSignal = (value) => ['present', 'absent'].includes(value) ? value : 'absent'

function projectRun(run) {
  const taskId = safeId(run.id)
  if (!taskId || !STATE_META[run.state]) return null
  const meta = STATE_META[run.state]
  const dispatchId = safeUuid(run.dispatchId)
  const identitySource = dispatchId ? 'dispatch_id'
    : run.dispatched === false ? 'process_only'
      : 'legacy_task_time'
  return {
    dispatch_id: dispatchId,
    task_id: taskId,
    identity_source: identitySource,
    state: run.state,
    worker: safeId(run.worker),
    transport: transport(run.kind || run.transport),
    started_at: safeIso(run.startedAt),
    elapsed_sec: finiteNonNegative(run.elapsedSec),
    silence_sec: finiteNonNegative(run.ageSec),
    timeout_sec: finiteNonNegative(run.timeoutSec),
    signals: {
      dispatch: dispatchSignal(run.dispatchStatus || (run.dispatched === false ? 'absent' : 'present')),
      liveness: liveness(run.liveness),
      pane: pane(run.paneStatus),
      terminal: terminal(run.marker),
      pm_verdict: verdict(run.pmVerdict),
      correlation: dispatchId ? 'dispatch_id' : run.dispatched === false ? 'process_only' : 'mtime_heuristic',
    },
    reason_codes: [meta.reason],
    advisory: {
      attention: meta.attention,
      action_code: meta.action,
      auto_execute: false,
    },
  }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function projectWorkerStats(events) {
  const byWorker = new Map()
  for (const event of events) {
    const worker = safeId(event.worker)
    if (!worker || !['pass', 'reject', 'unresolved'].includes(event.pm_verdict)) continue
    const row = byWorker.get(worker) || { worker, runs: 0, rejected: 0, waits: [] }
    row.runs++
    if (event.pm_verdict === 'reject') row.rejected++
    const wait = finiteNonNegative(event.wait_sec)
    if (wait !== null) row.waits.push(wait)
    byWorker.set(worker, row)
  }
  return [...byWorker.values()].map(row => ({
    worker: row.worker,
    runs: row.runs,
    rejected: row.rejected,
    median_wait_sec: median(row.waits),
  })).sort((a, b) => b.runs - a.runs || a.worker.localeCompare(b.worker)).slice(0, WORKER_STATS_LIMIT)
}

function projectUnclaimed(rows, finishedAt) {
  return (rows || []).map(row => {
    const taskId = safeId(row.id)
    if (!taskId || !Number.isFinite(row.mtime)) return null
    return { task_id: taskId, age_sec: Math.max(0, Math.round((finishedAt - row.mtime) / 1000)) }
  }).filter(Boolean).slice(0, UNCLAIMED_LIMIT)
}

function projectRecent(event) {
  const taskId = safeId(event.task_id)
  const worker = safeId(event.worker)
  if (!taskId || !worker || !['pass', 'reject', 'unresolved'].includes(event.pm_verdict)) return null
  return {
    dispatch_id: safeUuid(event.dispatch_id),
    task_id: taskId,
    worker,
    transport: transport(event.transport),
    terminal: terminal(event.terminal && event.terminal.startsWith('TEAM_') ? event.terminal : event.terminal ? `TEAM_${String(event.terminal).toUpperCase()}` : ''),
    pm_verdict: event.pm_verdict,
    started_at: safeIso(event.started_at),
    wait_sec: finiteNonNegative(event.wait_sec),
    timeout_sec: finiteNonNegative(event.timeout_sec),
  }
}

function projectDiagnostic(diagnostic) {
  const code = DIAGNOSTIC_CODES.has(diagnostic?.code) ? diagnostic.code : null
  const severity = ['info', 'warning', 'error'].includes(diagnostic?.severity) ? diagnostic.severity : 'warning'
  const source = ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher'].includes(diagnostic?.source)
    ? diagnostic.source : 'publisher'
  if (!code) return null
  const count = Number.isSafeInteger(diagnostic.count) && diagnostic.count >= 1 ? diagnostic.count : 1
  return { code, severity, source, count }
}

export function projectPulseV1(view, meta) {
  const projected = view.active.map(projectRun).filter(Boolean)
    .sort((a, b) => Number(b.advisory.attention) - Number(a.advisory.attention) || a.task_id.localeCompare(b.task_id))
  const runs = projected.slice(0, RUN_LIMIT)
  const recent = [...view.rec].sort((a, b) => b.mtime - a.mtime).map(projectRecent).filter(Boolean).slice(0, RECENT_LIMIT)
  const workerStats = projectWorkerStats(view.rec)
  const unclaimedControl = projectUnclaimed(view.unclaimed, meta.finishedAt)
  const diagnostics = (view.diagnostics || []).map(projectDiagnostic).filter(Boolean).slice(0, DIAGNOSTIC_LIMIT)
  const byState = Object.fromEntries(Object.keys(STATE_META).map(state => [state, 0]))
  for (const run of projected) byState[run.state]++
  const staleAfterSec = Math.max(60, Math.ceil(meta.intervalSec * 3))
  const finishedAt = new Date(meta.finishedAt).toISOString()
  return {
    schema: PULSE_SCHEMA,
    schema_version: PULSE_SCHEMA_VERSION,
    stream_id: meta.streamId,
    sequence: meta.sequence,
    snapshot_id: `${meta.streamId}:${meta.sequence}`,
    trust_level: 'advisory_same_uid',
    generated_at: finishedAt,
    observation: {
      started_at: new Date(meta.startedAt).toISOString(),
      finished_at: finishedAt,
      consistency: 'best_effort',
      refresh_interval_sec: Math.max(1, Math.ceil(meta.intervalSec)),
      stale_after_sec: staleAfterSec,
      expires_at: new Date(meta.finishedAt + staleAfterSec * 1000).toISOString(),
      quality: diagnostics.length ? 'degraded' : 'complete',
    },
    complete: diagnostics.length === 0,
    scope: { repo_name: safeRepoName(meta.repoName) },
    source_health: {
      liveness: sourceState(view.sourceHealth?.liveness),
      tmux: sourceState(view.sourceHealth?.tmux),
      dispatch: sourceState(view.sourceHealth?.dispatch),
      outbox: sourceState(view.sourceHealth?.outbox),
      events: sourceState(view.sourceHealth?.events),
    },
    summary: {
      active: projected.length,
      attention: runs.filter(run => run.advisory.attention).length,
      by_state: byState,
      truncated: Math.max(0, projected.length - runs.length),
    },
    runs,
    recent_verdicts: recent,
    worker_stats: workerStats,
    unclaimed_control: unclaimedControl,
    diagnostics,
  }
}
