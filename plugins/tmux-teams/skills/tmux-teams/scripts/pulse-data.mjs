// Pure, allowlisted projection for the machine-readable Pulse contract.
//
// This module deliberately does not serialize Pulse's internal observations
// wholesale. Repo-local dispatch/KMS files are writable by the same UID as a
// worker, so every string crossing this boundary is treated as untrusted data.

export const PULSE_SCHEMA = 'tmux-teams.pulse'
export const PULSE_SCHEMA_VERSION = 1
export const PULSE_SCHEMA_VERSION_V2 = 2
export const PULSE_SCHEMA_VERSION_V3 = 3
export const PULSE_SCHEMA_VERSION_V4 = 4
export const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const RUN_LIMIT = 100
const RECENT_LIMIT = 12
const DIAGNOSTIC_LIMIT = 50
const UNCLAIMED_LIMIT = 8
const WORKER_STATS_LIMIT = 100
const DIAGNOSTIC_CODES_V1 = new Set([
  'LIVENESS_UNAVAILABLE', 'TMUX_UNAVAILABLE', 'DISPATCH_UNREADABLE',
  'OUTBOX_UNREADABLE', 'EVENT_UNREADABLE', 'INVALID_EVENT_ENTRY',
  'SOURCE_TRUNCATED', 'SEQUENCE_RESET',
])
const DIAGNOSTIC_CODES_V2 = new Set([
  ...DIAGNOSTIC_CODES_V1,
  'SCHEMA_UPGRADED',
  'DELIVERY_LOOP_INPUT_UNREADABLE',
  'DELIVERY_LOOP_INPUT_INVALID',
  'DELIVERY_LOOP_STALE',
])
const DIAGNOSTIC_CODES_V3 = new Set([
  ...DIAGNOSTIC_CODES_V2,
  'PHASE_BINDING_INVALID',
  'PHASE_BINDING_CONFLICT',
])
const DIAGNOSTIC_CODES_V4 = new Set([
  ...DIAGNOSTIC_CODES_V3,
  'DELIVERY_RUNTIME_INPUT_UNREADABLE',
  'DELIVERY_RUNTIME_INPUT_INVALID',
  'DELIVERY_RUNTIME_STALE',
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
const PHASES = new Set(['Requirement', 'Prototype', 'Development', 'QA'])
const ASSIGNED_PHASE_SOURCES = new Set(['dispatch', 'event', 'dispatch_join'])
const PHASE_SOURCES = new Set([...ASSIGNED_PHASE_SOURCES, 'unassigned', 'conflict'])

// Phase and provenance are one binding. Normalizing the fields independently
// can publish a real phase with "unassigned" provenance, or retain a phase
// after its evidence has been marked conflicting.
const phaseBinding = (phaseValue, sourceValue) => {
  if (sourceValue === 'conflict') return { phase: null, phase_source: 'conflict' }
  if (PHASES.has(phaseValue) && ASSIGNED_PHASE_SOURCES.has(sourceValue)) {
    return { phase: phaseValue, phase_source: sourceValue }
  }
  return { phase: null, phase_source: 'unassigned' }
}

function projectRun(run, includePhase = false) {
  const taskId = safeId(run.id)
  if (!taskId || !STATE_META[run.state]) return null
  const meta = STATE_META[run.state]
  const dispatchId = safeUuid(run.dispatchId)
  const identitySource = dispatchId ? 'dispatch_id'
    : run.dispatched === false ? 'process_only'
      : 'legacy_task_time'
  const projected = {
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
  if (includePhase) {
    Object.assign(projected, phaseBinding(run.phase, run.phaseSource))
  }
  return projected
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

function projectRecent(event, includePhase = false) {
  const taskId = safeId(event.task_id)
  const worker = safeId(event.worker)
  if (!taskId || !worker || !['pass', 'reject', 'unresolved'].includes(event.pm_verdict)) return null
  const projected = {
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
  if (includePhase) {
    Object.assign(projected, phaseBinding(event.phase, event.phaseSource))
  }
  return projected
}

function projectDiagnostic(diagnostic, allowedCodes = DIAGNOSTIC_CODES_V1) {
  const code = allowedCodes.has(diagnostic?.code) ? diagnostic.code : null
  const severity = ['info', 'warning', 'error'].includes(diagnostic?.severity) ? diagnostic.severity : 'warning'
  const allowedSources = allowedCodes === DIAGNOSTIC_CODES_V4
    ? ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher', 'delivery_loop', 'delivery_runtime']
    : allowedCodes !== DIAGNOSTIC_CODES_V1
      ? ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher', 'delivery_loop']
    : ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher']
  const source = allowedSources.includes(diagnostic?.source)
    ? diagnostic.source : 'publisher'
  if (!code) return null
  const count = Number.isSafeInteger(diagnostic.count) && diagnostic.count >= 1 ? diagnostic.count : 1
  return { code, severity, source, count }
}

function projectPulse(view, meta, schemaVersion, allowedDiagnosticCodes, includePhase = false) {
  const projected = view.active.map(run => projectRun(run, includePhase)).filter(Boolean)
    .sort((a, b) => Number(b.advisory.attention) - Number(a.advisory.attention) || a.task_id.localeCompare(b.task_id))
  const runs = projected.slice(0, RUN_LIMIT)
  const recent = [...view.rec].sort((a, b) => b.mtime - a.mtime)
    .map(event => projectRecent(event, includePhase)).filter(Boolean).slice(0, RECENT_LIMIT)
  const workerStats = projectWorkerStats(view.rec)
  const unclaimedControl = projectUnclaimed(view.unclaimed, meta.finishedAt)
  const diagnostics = (view.diagnostics || [])
    .map(diagnostic => projectDiagnostic(diagnostic, allowedDiagnosticCodes))
    .filter(Boolean).slice(0, DIAGNOSTIC_LIMIT)
  const byState = Object.fromEntries(Object.keys(STATE_META).map(state => [state, 0]))
  for (const run of projected) byState[run.state]++
  const staleAfterSec = Math.max(60, Math.ceil(meta.intervalSec * 3))
  const finishedAt = new Date(meta.finishedAt).toISOString()
  return {
    schema: PULSE_SCHEMA,
    schema_version: schemaVersion,
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

export function projectPulseV1(view, meta) {
  return projectPulse(view, meta, PULSE_SCHEMA_VERSION, DIAGNOSTIC_CODES_V1)
}

const DELIVERY_PHASES = Object.freeze(['Requirement', 'Prototype', 'Development', 'QA'])
const DELIVERY_BOUNDARIES = new Set([
  'requirement_to_prototype',
  'prototype_to_development',
  'development_to_qa',
  'qa_to_project_delivery',
])
const DELIVERY_HEALTH = new Set(['ok', 'degraded', 'unavailable', 'not_configured'])
const DELIVERY_STATUS = new Set(['not_configured', 'ready', 'active', 'paused', 'complete', 'degraded'])
const DELIVERY_PHASE_STATES = new Set([
  'idle', 'active', 'waiting_receiver', 'rework', 'exception', 'complete', 'unknown',
])
const DELIVERY_ROLES = new Set([
  'operator', 'pm', 'sender_phase_lead', 'receiver_phase_lead', 'experiment_owner',
  'metric_producer', 'qa', 'external_reviewer', 'business_owner',
])
const DELIVERY_ACTIONS = new Set([
  'monitor',
  'restore_observability',
  'verify_and_recommend_manual_hold',
  'inspect_contract_violation',
  'resolve_exception',
  'review_handoff',
  'revise_artifact',
  'complete_measurement',
  'continue_observation',
  'export_evidence',
  'request_external_review',
])
const DELIVERY_REASONS = new Set([
  'OBSERVATION_CURRENT',
  'OBSERVATION_STALE',
  'SOURCE_DEGRADED',
  'GUARDRAIL_BREACH',
  'CONTRACT_INVALID',
  'EXCEPTION_OPEN',
  'HANDOFF_AWAITING_RECEIVER',
  'REVISION_REQUIRED',
  'MEASUREMENT_INCOMPLETE',
  'MATURITY_PENDING',
  'EVIDENCE_EXPORT_READY',
  'EXTERNAL_REVIEW_READY',
  'NO_ACTIVE_SLICES',
  'BOTTLENECK_AVAILABLE',
  'BOTTLENECK_INCONCLUSIVE',
])
const DELIVERY_SCOPES = new Set(['source', 'experiment', 'phase', 'slice'])
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
const DELIVERY_INPUT_KEYS = [
  'schema', 'schema_version', 'generated_at', 'expires_at', 'trust_level', 'mode',
  'status', 'actuation', 'experiment', 'source_health', 'summary', 'phase_cards',
  'bottleneck', 'attention', 'next_action', 'evidence',
]
const DELIVERY_SOURCE_KEYS = ['manifest', 'assignment', 'events', 'costs', 'outcomes', 'guardrails', 'export']
const DELIVERY_SUMMARY_KEYS = [
  'assigned', 'in_progress', 'terminal', 'exceptions', 'contaminated',
  'operator_action_total', 'operator_action_shown', 'operator_action_truncated',
]

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactObject = (value, keys) => isObject(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0
const isNullableId = (value) => value === null || (typeof value === 'string' && ID_RE.test(value))
const isNullableDigest = (value) => value === null || (typeof value === 'string' && DIGEST_RE.test(value))
const isNullableNonNegative = (value) => value === null || (Number.isFinite(value) && value >= 0)
const codePointCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0

function strictIso(value) {
  if (typeof value !== 'string') return null
  const match = value.match(RFC3339_RE)
  if (!match) return null
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59 ||
      (offsetHourText !== undefined &&
        (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function nullableIso(value) {
  if (value === null) return null
  return strictIso(value)
}

function cloneReasons(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 ||
      new Set(value).size !== value.length ||
      value.some(reason => typeof reason !== 'string' || !DELIVERY_REASONS.has(reason))) return null
  return [...value].sort(codePointCompare)
}

function cloneAdvisory(value) {
  const keys = ['attention', 'owner_role', 'action_code', 'auto_execute']
  if (!exactObject(value, keys) || typeof value.attention !== 'boolean' ||
      !DELIVERY_ROLES.has(value.owner_role) || !DELIVERY_ACTIONS.has(value.action_code) ||
      value.auto_execute !== false) return null
  return {
    attention: value.attention,
    owner_role: value.owner_role,
    action_code: value.action_code,
    auto_execute: false,
  }
}

function cloneExperiment(value) {
  const keys = [
    'experiment_id', 'manifest_id', 'manifest_digest', 'dataset_digest',
    'boundary', 'assignment_window', 'analysis_as_of',
  ]
  if (!exactObject(value, keys) || !isNullableId(value.experiment_id) ||
      !isNullableId(value.manifest_id) || !isNullableDigest(value.manifest_digest) ||
      !isNullableDigest(value.dataset_digest) ||
      !(value.boundary === null || DELIVERY_BOUNDARIES.has(value.boundary)) ||
      !exactObject(value.assignment_window, ['start', 'end'])) return null
  const start = nullableIso(value.assignment_window.start)
  const end = nullableIso(value.assignment_window.end)
  if ((value.assignment_window.start !== null && !start) ||
      (value.assignment_window.end !== null && !end) ||
      ((start === null) !== (end === null)) ||
      (start && Date.parse(start) >= Date.parse(end))) return null
  const analysisAsOf = nullableIso(value.analysis_as_of)
  if (value.analysis_as_of !== null && !analysisAsOf) return null
  return {
    experiment_id: value.experiment_id,
    manifest_id: value.manifest_id,
    manifest_digest: value.manifest_digest,
    dataset_digest: value.dataset_digest,
    boundary: value.boundary,
    assignment_window: { start, end },
    analysis_as_of: analysisAsOf,
  }
}

function cloneSourceHealth(value) {
  if (!exactObject(value, DELIVERY_SOURCE_KEYS) ||
      DELIVERY_SOURCE_KEYS.some(key => !DELIVERY_HEALTH.has(value[key]))) return null
  return Object.fromEntries(DELIVERY_SOURCE_KEYS.map(key => [key, value[key]]))
}

function cloneSummary(value) {
  if (!exactObject(value, DELIVERY_SUMMARY_KEYS) ||
      DELIVERY_SUMMARY_KEYS.some(key => !isNonNegativeInteger(value[key])) ||
      value.operator_action_shown > 50 ||
      value.operator_action_total !== value.operator_action_shown + value.operator_action_truncated) return null
  return Object.fromEntries(DELIVERY_SUMMARY_KEYS.map(key => [key, value[key]]))
}

function clonePhaseCard(value) {
  const keys = [
    'phase', 'state', 'active_slices', 'oldest_open_age_sec', 'reason_codes', 'advisory',
  ]
  if (!exactObject(value, keys) || !DELIVERY_PHASES.includes(value.phase) ||
      !DELIVERY_PHASE_STATES.has(value.state) || !isNonNegativeInteger(value.active_slices) ||
      !isNullableNonNegative(value.oldest_open_age_sec)) return null
  const reasonCodes = cloneReasons(value.reason_codes)
  const advisory = cloneAdvisory(value.advisory)
  if (!reasonCodes || !advisory) return null
  return {
    phase: value.phase,
    state: value.state,
    active_slices: value.active_slices,
    oldest_open_age_sec: value.oldest_open_age_sec,
    reason_codes: reasonCodes,
    advisory,
  }
}

function cloneBottleneck(value) {
  const keys = ['status', 'basis', 'boundary', 'age_sec', 'reason_codes']
  if (!exactObject(value, keys) ||
      !['available', 'none', 'inconclusive'].includes(value.status) ||
      value.basis !== 'oldest_open_handoff_age' ||
      !(value.boundary === null || DELIVERY_BOUNDARIES.has(value.boundary)) ||
      !isNullableNonNegative(value.age_sec)) return null
  const reasonCodes = cloneReasons(value.reason_codes)
  if (!reasonCodes) return null
  const hasBoundary = value.boundary !== null
  const hasAge = value.age_sec !== null
  if (value.status === 'available' && (!hasBoundary || !hasAge)) return null
  if (value.status === 'none' && (hasBoundary || hasAge)) return null
  if (value.status === 'inconclusive' && hasAge) return null
  return {
    status: value.status,
    basis: 'oldest_open_handoff_age',
    boundary: value.boundary,
    age_sec: value.age_sec,
    reason_codes: reasonCodes,
  }
}

function cloneAttention(value) {
  const keys = [
    'attention_id', 'severity', 'scope', 'slice_id', 'phase', 'owner_role',
    'reason_codes', 'action_code', 'auto_execute',
  ]
  if (!exactObject(value, keys) || typeof value.attention_id !== 'string' ||
      !ID_RE.test(value.attention_id) || !['info', 'warning', 'hold'].includes(value.severity) ||
      !DELIVERY_SCOPES.has(value.scope) || !isNullableId(value.slice_id) ||
      !(value.phase === null || DELIVERY_PHASES.includes(value.phase)) ||
      !DELIVERY_ROLES.has(value.owner_role) || !DELIVERY_ACTIONS.has(value.action_code) ||
      value.auto_execute !== false) return null
  const reasonCodes = cloneReasons(value.reason_codes)
  if (!reasonCodes) return null
  return {
    attention_id: value.attention_id,
    severity: value.severity,
    scope: value.scope,
    slice_id: value.slice_id,
    phase: value.phase,
    owner_role: value.owner_role,
    reason_codes: reasonCodes,
    action_code: value.action_code,
    auto_execute: false,
  }
}

function cloneNextAction(value) {
  const keys = [
    'scope', 'slice_id', 'phase', 'owner_role', 'reason_codes', 'action_code', 'auto_execute',
  ]
  if (!exactObject(value, keys) || !DELIVERY_SCOPES.has(value.scope) ||
      !isNullableId(value.slice_id) ||
      !(value.phase === null || DELIVERY_PHASES.includes(value.phase)) ||
      !DELIVERY_ROLES.has(value.owner_role) || !DELIVERY_ACTIONS.has(value.action_code) ||
      value.auto_execute !== false) return null
  const reasonCodes = cloneReasons(value.reason_codes)
  if (!reasonCodes) return null
  return {
    scope: value.scope,
    slice_id: value.slice_id,
    phase: value.phase,
    owner_role: value.owner_role,
    reason_codes: reasonCodes,
    action_code: value.action_code,
    auto_execute: false,
  }
}

function cloneEvidence(value) {
  const keys = [
    'measurement_readiness', 'scenario_signal', 'guardrail_status',
    'evidence_eligibility', 'safety_hold_recommended', 'business_decision',
  ]
  if (!exactObject(value, keys) ||
      !['READY', 'INCONCLUSIVE'].includes(value.measurement_readiness) ||
      !['FAVORABLE', 'UNFAVORABLE', 'INCONCLUSIVE'].includes(value.scenario_signal) ||
      !['CLEAR', 'BREACH', 'UNKNOWN'].includes(value.guardrail_status) ||
      !['SYNTHETIC_ONLY', 'OBSERVED_UNVERIFIED', 'ELIGIBLE_FOR_EXTERNAL_REVIEW']
        .includes(value.evidence_eligibility) ||
      typeof value.safety_hold_recommended !== 'boolean' ||
      value.business_decision !== 'EXTERNAL_REQUIRED' ||
      (value.measurement_readiness === 'INCONCLUSIVE' &&
        value.scenario_signal === 'FAVORABLE') ||
      (value.guardrail_status === 'BREACH' &&
        value.safety_hold_recommended !== true)) return null
  return {
    measurement_readiness: value.measurement_readiness,
    scenario_signal: value.scenario_signal,
    guardrail_status: value.guardrail_status,
    evidence_eligibility: value.evidence_eligibility,
    safety_hold_recommended: value.safety_hold_recommended,
    business_decision: 'EXTERNAL_REQUIRED',
  }
}

function cloneDeliveryLoop(value) {
  if (!exactObject(value, DELIVERY_INPUT_KEYS) ||
      value.schema !== 'tmux-teams.delivery-loop-projection' ||
      value.schema_version !== 1 ||
      value.trust_level !== 'advisory_same_uid' ||
      value.mode !== 'stage1_observe_only' ||
      !DELIVERY_STATUS.has(value.status) ||
      !exactObject(value.actuation, ['enabled', 'auto_execute']) ||
      value.actuation.enabled !== false || value.actuation.auto_execute !== false) return null
  const generatedAt = strictIso(value.generated_at)
  const expiresAt = strictIso(value.expires_at)
  if (!generatedAt || !expiresAt || Date.parse(generatedAt) >= Date.parse(expiresAt)) return null
  const experiment = cloneExperiment(value.experiment)
  const sourceHealth = cloneSourceHealth(value.source_health)
  const summary = cloneSummary(value.summary)
  const bottleneck = cloneBottleneck(value.bottleneck)
  const nextAction = cloneNextAction(value.next_action)
  const evidence = cloneEvidence(value.evidence)
  if (!experiment || !sourceHealth || !summary || !bottleneck || !nextAction || !evidence ||
      !Array.isArray(value.phase_cards) || value.phase_cards.length > DELIVERY_PHASES.length ||
      !Array.isArray(value.attention) || value.attention.length > 50) return null
  if (['active', 'complete'].includes(value.status) &&
      (experiment.experiment_id === null || experiment.manifest_id === null ||
        experiment.manifest_digest === null || experiment.dataset_digest === null)) return null
  const phaseCards = value.phase_cards.map(clonePhaseCard)
  const attention = value.attention.map(cloneAttention)
  if (phaseCards.some(card => !card) || attention.some(item => !item) ||
      new Set(phaseCards.map(card => card.phase)).size !== phaseCards.length ||
      new Set(attention.map(item => item.attention_id)).size !== attention.length ||
      attention.length !== summary.operator_action_shown) return null
  const phaseOrder = new Map(DELIVERY_PHASES.map((phase, index) => [phase, index]))
  const severityOrder = new Map([['hold', 0], ['warning', 1], ['info', 2]])
  phaseCards.sort((left, right) => phaseOrder.get(left.phase) - phaseOrder.get(right.phase))
  attention.sort((left, right) =>
    severityOrder.get(left.severity) - severityOrder.get(right.severity) ||
    codePointCompare(left.attention_id, right.attention_id))
  if (attention.length) {
    const first = attention[0]
    if (nextAction.scope !== first.scope || nextAction.slice_id !== first.slice_id ||
        nextAction.phase !== first.phase || nextAction.owner_role !== first.owner_role ||
        nextAction.action_code !== first.action_code ||
        nextAction.reason_codes.length !== first.reason_codes.length ||
        nextAction.reason_codes.some((reason, index) => reason !== first.reason_codes[index])) return null
  }
  return {
    schema: 'tmux-teams.delivery-loop-projection',
    schema_version: 1,
    generated_at: generatedAt,
    expires_at: expiresAt,
    trust_level: 'advisory_same_uid',
    mode: 'stage1_observe_only',
    status: value.status,
    actuation: { enabled: false, auto_execute: false },
    experiment,
    source_health: sourceHealth,
    summary,
    phase_cards: phaseCards,
    bottleneck,
    attention,
    next_action: nextAction,
    evidence,
  }
}

function degradedDeliveryLoop(nowMs, reasonCode) {
  const timestamp = new Date(nowMs).toISOString()
  return {
    schema: 'tmux-teams.delivery-loop-projection',
    schema_version: 1,
    generated_at: timestamp,
    expires_at: timestamp,
    trust_level: 'advisory_same_uid',
    mode: 'stage1_observe_only',
    status: 'degraded',
    actuation: { enabled: false, auto_execute: false },
    experiment: {
      experiment_id: null,
      manifest_id: null,
      manifest_digest: null,
      dataset_digest: null,
      boundary: null,
      assignment_window: { start: null, end: null },
      analysis_as_of: null,
    },
    source_health: Object.fromEntries(DELIVERY_SOURCE_KEYS.map(key => [key, 'unavailable'])),
    summary: {
      assigned: 0,
      in_progress: 0,
      terminal: 0,
      exceptions: 0,
      contaminated: 0,
      operator_action_total: 1,
      operator_action_shown: 1,
      operator_action_truncated: 0,
    },
    phase_cards: [],
    bottleneck: {
      status: 'inconclusive',
      basis: 'oldest_open_handoff_age',
      boundary: null,
      age_sec: null,
      reason_codes: [reasonCode === 'OBSERVATION_STALE' ? 'BOTTLENECK_INCONCLUSIVE' : 'SOURCE_DEGRADED'],
    },
    attention: [{
      attention_id: 'delivery-loop-observation',
      severity: 'warning',
      scope: 'source',
      slice_id: null,
      phase: null,
      owner_role: 'operator',
      reason_codes: [reasonCode],
      action_code: 'restore_observability',
      auto_execute: false,
    }],
    next_action: {
      scope: 'source',
      slice_id: null,
      phase: null,
      owner_role: 'operator',
      reason_codes: [reasonCode],
      action_code: 'restore_observability',
      auto_execute: false,
    },
    evidence: {
      measurement_readiness: 'INCONCLUSIVE',
      scenario_signal: 'INCONCLUSIVE',
      guardrail_status: 'UNKNOWN',
      evidence_eligibility: 'OBSERVED_UNVERIFIED',
      safety_hold_recommended: false,
      business_decision: 'EXTERNAL_REQUIRED',
    },
  }
}

export function sanitizeDeliveryLoopProjection(input, nowMs = Date.now(), inputIssue = null) {
  const timestamp = Number.isFinite(nowMs) ? nowMs : Date.now()
  if (inputIssue) {
    const code = inputIssue === 'DELIVERY_LOOP_INPUT_UNREADABLE'
      ? 'DELIVERY_LOOP_INPUT_UNREADABLE' : 'DELIVERY_LOOP_INPUT_INVALID'
    return {
      projection: degradedDeliveryLoop(timestamp, 'SOURCE_DEGRADED'),
      diagnostic: { code, severity: 'error', source: 'delivery_loop', count: 1 },
    }
  }
  const projection = cloneDeliveryLoop(input)
  if (!projection) {
    return {
      projection: degradedDeliveryLoop(timestamp, 'SOURCE_DEGRADED'),
      diagnostic: {
        code: 'DELIVERY_LOOP_INPUT_INVALID',
        severity: 'error',
        source: 'delivery_loop',
        count: 1,
      },
    }
  }
  if (Date.parse(projection.expires_at) <= timestamp) {
    return {
      projection: degradedDeliveryLoop(timestamp, 'OBSERVATION_STALE'),
      diagnostic: { code: 'DELIVERY_LOOP_STALE', severity: 'warning', source: 'delivery_loop', count: 1 },
    }
  }
  return { projection, diagnostic: null }
}

export function projectPulseV2(view, meta, deliveryInput, inputIssue = null) {
  const sanitized = sanitizeDeliveryLoopProjection(deliveryInput, meta.finishedAt, inputIssue)
  const diagnostics = [...(view.diagnostics || [])]
  if (sanitized.diagnostic) diagnostics.unshift(sanitized.diagnostic)
  diagnostics.sort((left, right) => {
    const priority = (code) => code?.startsWith('DELIVERY_LOOP_') ? 0 : code === 'SCHEMA_UPGRADED' ? 1 : 2
    return priority(left?.code) - priority(right?.code)
  })
  return {
    ...projectPulse(
      { ...view, diagnostics },
      meta,
      PULSE_SCHEMA_VERSION_V2,
      DIAGNOSTIC_CODES_V2,
    ),
    delivery_loop: sanitized.projection,
  }
}

export function projectPulseV3(
  view,
  meta,
  deliveryInput = null,
  inputIssue = null,
  includeDeliveryLoop = false,
) {
  const diagnostics = [...(view.diagnostics || [])]
  let deliveryLoop = null
  if (includeDeliveryLoop) {
    const sanitized = sanitizeDeliveryLoopProjection(deliveryInput, meta.finishedAt, inputIssue)
    deliveryLoop = sanitized.projection
    if (sanitized.diagnostic) diagnostics.unshift(sanitized.diagnostic)
  }
  diagnostics.sort((left, right) => {
    const priority = (code) => code?.startsWith('DELIVERY_LOOP_')
      ? 0
      : code === 'PHASE_BINDING_CONFLICT' ? 1
        : code === 'PHASE_BINDING_INVALID' ? 2
          : code === 'SCHEMA_UPGRADED' ? 3 : 4
    return priority(left?.code) - priority(right?.code)
  })
  const projected = projectPulse(
    { ...view, diagnostics },
    meta,
    PULSE_SCHEMA_VERSION_V3,
    DIAGNOSTIC_CODES_V3,
    true,
  )
  return includeDeliveryLoop
    ? { ...projected, delivery_loop: deliveryLoop }
    : projected
}

const DELIVERY_RUNTIME_SCHEMA = 'tmux-teams.delivery-runtime-projection'
const DELIVERY_RUNTIME_LIMIT = 100
const DELIVERY_RUNTIME_INPUT_LIMIT = 1000
const DELIVERY_RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const DELIVERY_RUNTIME_STATES = new Set(['proposed', 'accepted', 'rejected', 'escalated', 'consumed'])
const DELIVERY_RUNTIME_INPUT_KEYS = [
  'schema', 'schema_version', 'generated_at', 'expires_at', 'trust_level', 'mode',
  'actuation', 'source_health', 'summary', 'replay', 'phase_runs', 'bottleneck',
  'phase_gates',
]
const DELIVERY_RUNTIME_SUMMARY_KEYS = [
  'proposed', 'accepted', 'rejected', 'escalated', 'consumed', 'shown', 'truncated',
]
const DELIVERY_RUNTIME_GATE_KEYS = [
  'gate_id', 'slice_id', 'attempt_id', 'boundary', 'sender_phase',
  'receiver_phase', 'artifact_type', 'artifact_digest', 'state', 'proposed_at',
  'transition_at', 'acceptance_event_id', 'accepted_digest',
  'receiver_dispatch_id', 'consumed_digest', 'consumed_at',
]
const DELIVERY_RUNTIME_BOUNDARIES = Object.freeze({
  requirement_to_prototype: Object.freeze({
    sender: 'Requirement', receiver: 'Prototype', artifact: 'requirements_baseline',
  }),
  prototype_to_development: Object.freeze({
    sender: 'Prototype', receiver: 'Development', artifact: 'prototype_evaluation',
  }),
  development_to_qa: Object.freeze({
    sender: 'Development', receiver: 'QA', artifact: 'development_delivery',
  }),
  qa_to_project_delivery: Object.freeze({
    sender: 'QA', receiver: 'ProjectDelivery', artifact: 'qa_release_evidence',
  }),
})
const DELIVERY_RUNTIME_BOUNDARY_ORDER =
  new Map(Object.keys(DELIVERY_RUNTIME_BOUNDARIES).map((boundary, index) => [boundary, index]))
const DELIVERY_RUNTIME_PHASES = ['Requirement', 'Prototype', 'Development', 'QA']
const DELIVERY_RUNTIME_PHASE_STATES =
  new Set(['pending', 'working', 'handoff_pending', 'blocked', 'completed'])
const DELIVERY_RUNTIME_OWNER_ROLES =
  new Set(['phase_team', 'receiver_phase_lead', 'project_delivery'])
const DELIVERY_RUNTIME_BOTTLENECK_OWNER_ROLES =
  new Set([...DELIVERY_RUNTIME_OWNER_ROLES, 'pm_exception_owner'])
const DELIVERY_RUNTIME_BOTTLENECK_KINDS =
  new Set(['work', 'handoff_review', 'rework', 'exception', 'dispatch_reconcile'])
const isRuntimeId = value =>
  typeof value === 'string' && DELIVERY_RUNTIME_ID_RE.test(value)
const isNullableRuntimeId = value => value === null || isRuntimeId(value)

function cloneRuntimeSummary(value) {
  if (!exactObject(value, DELIVERY_RUNTIME_SUMMARY_KEYS) ||
      DELIVERY_RUNTIME_SUMMARY_KEYS.some(key => !isNonNegativeInteger(value[key]))) return null
  return value
}

function cloneRuntimeGate(value) {
  if (!exactObject(value, DELIVERY_RUNTIME_GATE_KEYS)) return null
  for (const key of ['gate_id', 'slice_id', 'attempt_id']) {
    if (!isRuntimeId(value[key])) return null
  }
  const mapping = DELIVERY_RUNTIME_BOUNDARIES[value.boundary]
  if (!mapping || value.sender_phase !== mapping.sender || value.receiver_phase !== mapping.receiver ||
      value.artifact_type !== mapping.artifact || !DELIVERY_RUNTIME_STATES.has(value.state) ||
      typeof value.artifact_digest !== 'string' || !DIGEST_RE.test(value.artifact_digest)) return null
  const proposedAt = strictIso(value.proposed_at)
  const transitionAt = nullableIso(value.transition_at)
  const consumedAt = nullableIso(value.consumed_at)
  if (!proposedAt ||
      (value.transition_at !== null && !transitionAt) ||
      (value.consumed_at !== null && !consumedAt) ||
      !isNullableDigest(value.acceptance_event_id) ||
      !isNullableDigest(value.accepted_digest) ||
      !(value.receiver_dispatch_id === null ||
        typeof value.receiver_dispatch_id === 'string' && UUID_RE.test(value.receiver_dispatch_id)) ||
      !isNullableDigest(value.consumed_digest)) return null
  const acceptance = value.acceptance_event_id !== null && transitionAt !== null &&
    value.accepted_digest === value.artifact_digest
  const noAcceptance = value.acceptance_event_id === null &&
    value.accepted_digest === null
  const noConsumption = consumedAt === null && value.receiver_dispatch_id === null &&
    value.consumed_digest === null
  if (value.state === 'proposed' &&
      (!noAcceptance || transitionAt !== null || !noConsumption) ||
      value.state === 'accepted' &&
      (!acceptance || !noConsumption) ||
      value.state === 'rejected' &&
      (!noAcceptance || transitionAt === null || !noConsumption) ||
      value.state === 'escalated' &&
      (!noAcceptance || transitionAt === null || !noConsumption) ||
      value.state === 'consumed' &&
      (!acceptance || consumedAt === null ||
        value.receiver_dispatch_id === null ||
        value.consumed_digest !== value.artifact_digest)) return null
  const finalBoundary = value.boundary === 'qa_to_project_delivery'
  if (finalBoundary && value.state === 'consumed') return null
  const eventTimes = [transitionAt, consumedAt].filter(Boolean)
  if (eventTimes.some(timestamp => Date.parse(timestamp) < Date.parse(proposedAt)) ||
      consumedAt && transitionAt && Date.parse(consumedAt) < Date.parse(transitionAt)) return null
  return {
    gate_id: value.gate_id,
    slice_id: value.slice_id,
    attempt_id: value.attempt_id,
    boundary: value.boundary,
    sender_phase: mapping.sender,
    receiver_phase: mapping.receiver,
    artifact_type: mapping.artifact,
    artifact_digest: value.artifact_digest,
    state: value.state,
    proposed_at: proposedAt,
    transition_at: transitionAt,
    consumed_at: consumedAt,
    acceptance_event_id: value.acceptance_event_id,
    accepted_digest: value.accepted_digest,
    receiver_dispatch_id: value.receiver_dispatch_id,
    consumed_digest: value.consumed_digest,
  }
}

function cloneRuntimeReplay(value) {
  if (!exactObject(value, ['sequence', 'head_event_id']) ||
      !isNonNegativeInteger(value.sequence) || !isNullableDigest(value.head_event_id) ||
      value.sequence === 0 !== (value.head_event_id === null)) return null
  return { sequence: value.sequence, head_event_id: value.head_event_id }
}

function cloneRuntimePhaseRun(value, expectedPhase) {
  const keys = [
    'phase', 'phase_run_id', 'state', 'started_at', 'transition_at', 'owner_role',
    'work_age_sec', 'wait_age_sec', 'handoff_count', 'revision_count',
  ]
  if (!exactObject(value, keys) || value.phase !== expectedPhase ||
      !isRuntimeId(value.phase_run_id) ||
      !DELIVERY_RUNTIME_PHASE_STATES.has(value.state) ||
      !DELIVERY_RUNTIME_OWNER_ROLES.has(value.owner_role) ||
      !isNullableNonNegative(value.work_age_sec) ||
      !isNullableNonNegative(value.wait_age_sec) ||
      !isNonNegativeInteger(value.handoff_count) ||
      !isNonNegativeInteger(value.revision_count)) return null
  const startedAt = nullableIso(value.started_at)
  const transitionAt = nullableIso(value.transition_at)
  if (value.started_at !== null && !startedAt ||
      value.transition_at !== null && !transitionAt ||
      startedAt && transitionAt && Date.parse(transitionAt) < Date.parse(startedAt)) return null
  return {
    phase: expectedPhase,
    phase_run_id: value.phase_run_id,
    state: value.state,
    started_at: startedAt,
    transition_at: transitionAt,
    owner_role: value.owner_role,
    work_age_sec: value.work_age_sec,
    wait_age_sec: value.wait_age_sec,
    handoff_count: value.handoff_count,
    revision_count: value.revision_count,
  }
}

function validRuntimePhaseState(run, generatedMs) {
  const startedMs = run.started_at === null ? null : Date.parse(run.started_at)
  const transitionMs = run.transition_at === null ? null : Date.parse(run.transition_at)
  if (startedMs !== null && startedMs > generatedMs ||
      transitionMs !== null && transitionMs > generatedMs) return false
  const noTimesOrAges = run.started_at === null && run.transition_at === null &&
    run.work_age_sec === null && run.wait_age_sec === null
  if (run.state === 'pending') return noTimesOrAges && run.owner_role === 'phase_team'
  if (run.state === 'working') {
    return run.started_at !== null && run.transition_at === null &&
      run.work_age_sec !== null && run.wait_age_sec === null && run.owner_role === 'phase_team'
  }
  if (run.state === 'handoff_pending') {
    return run.started_at !== null && run.transition_at === null &&
      run.work_age_sec !== null && run.wait_age_sec !== null &&
      run.owner_role === 'receiver_phase_lead'
  }
  if (run.state === 'blocked') {
    return run.started_at !== null && run.transition_at === null &&
      run.work_age_sec !== null && run.wait_age_sec !== null && run.owner_role === 'phase_team'
  }
  return run.state === 'completed' && run.started_at !== null && run.transition_at !== null &&
    run.work_age_sec === null && run.wait_age_sec === null &&
    run.owner_role === (run.phase === 'QA' ? 'project_delivery' : 'phase_team')
}

function hasDuplicateNonNull(values) {
  const seen = new Set()
  for (const value of values) {
    if (value === null) continue
    if (seen.has(value)) return true
    seen.add(value)
  }
  return false
}

function gateOrder(left, right) {
  return Date.parse(left.proposed_at) - Date.parse(right.proposed_at) ||
    codePointCompare(left.gate_id, right.gate_id)
}

function currentGateForBoundary(gates, gate) {
  return !gates.some(candidate => candidate.boundary === gate.boundary &&
    candidate.gate_id !== gate.gate_id && gateOrder(candidate, gate) > 0)
}

function validRuntimeChronology(phaseRuns, gates, generatedAt) {
  const generatedMs = Date.parse(generatedAt)
  if (phaseRuns.some(run => !validRuntimePhaseState(run, generatedMs))) return false
  const byPhase = new Map(phaseRuns.map(run => [run.phase, run]))
  for (const gate of gates) {
    const proposedMs = Date.parse(gate.proposed_at)
    const transitionMs = gate.transition_at === null ? null : Date.parse(gate.transition_at)
    const consumedMs = gate.consumed_at === null ? null : Date.parse(gate.consumed_at)
    if (proposedMs > generatedMs || transitionMs !== null && transitionMs > generatedMs ||
        consumedMs !== null && consumedMs > generatedMs) return false
    const sender = byPhase.get(gate.sender_phase)
    if (sender?.started_at !== null && proposedMs < Date.parse(sender.started_at)) return false
    if (consumedMs !== null && gate.receiver_phase !== 'ProjectDelivery') {
      const receiver = byPhase.get(gate.receiver_phase)
      if (!receiver || receiver.started_at === null || Date.parse(receiver.started_at) > consumedMs) {
        return false
      }
    }
    if (gate.boundary === 'qa_to_project_delivery' && transitionMs !== null) {
      const qa = byPhase.get('QA')
      if (qa?.started_at !== null && Date.parse(qa.started_at) > transitionMs ||
          qa?.transition_at !== null && Date.parse(qa.transition_at) < transitionMs) return false
    }
  }
  return true
}

function cloneRuntimeBottleneck(value) {
  if (value === null) return null
  const keys = [
    'phase', 'kind', 'age_sec', 'since', 'owner_role', 'phase_run_id',
    'attempt_id', 'gate_id',
  ]
  if (!exactObject(value, keys) || !DELIVERY_RUNTIME_PHASES.includes(value.phase) ||
      !DELIVERY_RUNTIME_BOTTLENECK_KINDS.has(value.kind) ||
      !isNullableNonNegative(value.age_sec) || value.age_sec === null ||
      !DELIVERY_RUNTIME_BOTTLENECK_OWNER_ROLES.has(value.owner_role) ||
      !isRuntimeId(value.phase_run_id) ||
      !isNullableRuntimeId(value.attempt_id) ||
      !isNullableRuntimeId(value.gate_id)) return undefined
  const since = strictIso(value.since)
  if (!since || (value.gate_id === null) !== (value.attempt_id === null) ||
      value.owner_role === 'pm_exception_owner' &&
        !['exception', 'dispatch_reconcile'].includes(value.kind) ||
      value.kind === 'handoff_review' &&
        !['receiver_phase_lead', 'project_delivery'].includes(value.owner_role)) return undefined
  return {
    phase: value.phase,
    kind: value.kind,
    age_sec: value.age_sec,
    since,
    owner_role: value.owner_role,
    phase_run_id: value.phase_run_id,
    attempt_id: value.attempt_id,
    gate_id: value.gate_id,
  }
}

function validRuntimeBottleneck(bottleneck, phaseRuns, gates, generatedAt) {
  if (bottleneck === null) return true
  const phaseRun = phaseRuns.find(run => run.phase === bottleneck.phase)
  const elapsedSec = Math.max(0, (Date.parse(generatedAt) - Date.parse(bottleneck.since)) / 1000)
  if (!phaseRun || phaseRun.phase_run_id !== bottleneck.phase_run_id ||
      Date.parse(bottleneck.since) > Date.parse(generatedAt) ||
      bottleneck.age_sec < Math.max(0, elapsedSec - 1) || bottleneck.age_sec > elapsedSec + 1) {
    return false
  }
  if (bottleneck.kind === 'work') {
    return bottleneck.gate_id === null && bottleneck.attempt_id === null &&
      bottleneck.owner_role === 'phase_team' && phaseRun.state === 'working' &&
      bottleneck.since === phaseRun.started_at
  }
  if (bottleneck.kind === 'dispatch_reconcile' && bottleneck.gate_id === null) {
    return bottleneck.attempt_id === null && bottleneck.owner_role === 'pm_exception_owner'
  }
  const gate = gates.find(candidate => candidate.gate_id === bottleneck.gate_id)
  if (!gate || gate.attempt_id !== bottleneck.attempt_id || !currentGateForBoundary(gates, gate)) return false
  if (bottleneck.kind === 'exception') {
    return gate.state === 'escalated' && bottleneck.phase === gate.sender_phase &&
      bottleneck.owner_role === 'pm_exception_owner' && bottleneck.since === gate.transition_at
  }
  if (bottleneck.kind === 'rework') {
    return gate.state === 'rejected' && bottleneck.phase === gate.sender_phase &&
      bottleneck.owner_role === 'phase_team' && bottleneck.since === gate.transition_at
  }
  if (bottleneck.kind === 'handoff_review') {
    const expectedOwner = gate.receiver_phase === 'ProjectDelivery'
      ? 'project_delivery' : 'receiver_phase_lead'
    const since = gate.state === 'proposed' ? gate.proposed_at : gate.transition_at
    return ['proposed', 'accepted'].includes(gate.state) &&
      bottleneck.phase === gate.sender_phase && bottleneck.owner_role === expectedOwner &&
      bottleneck.since === since
  }
  if (bottleneck.kind === 'dispatch_reconcile') {
    const observedAt = gate.state === 'accepted' ? gate.transition_at
      : gate.state === 'consumed' ? gate.consumed_at : null
    return observedAt !== null && ['accepted', 'consumed'].includes(gate.state) &&
      bottleneck.phase === gate.receiver_phase && bottleneck.owner_role === 'pm_exception_owner' &&
      Date.parse(bottleneck.since) >= Date.parse(observedAt)
  }
  return false
}

function summarizeRuntime(gates, shown) {
  return {
    proposed: gates.length,
    accepted: gates.filter(gate => ['accepted', 'consumed'].includes(gate.state)).length,
    rejected: gates.filter(gate => gate.state === 'rejected').length,
    escalated: gates.filter(gate => gate.state === 'escalated').length,
    consumed: gates.filter(gate => gate.state === 'consumed').length,
    shown: shown.length,
    truncated: Math.max(0, gates.length - shown.length),
  }
}

function cloneDeliveryRuntime(value) {
  if (!exactObject(value, DELIVERY_RUNTIME_INPUT_KEYS) ||
      value.schema !== DELIVERY_RUNTIME_SCHEMA || value.schema_version !== 1 ||
      value.trust_level !== 'advisory_same_uid' || value.mode !== 'observe_only' ||
      !exactObject(value.actuation, ['enabled', 'auto_execute']) ||
      value.actuation.enabled !== false || value.actuation.auto_execute !== false ||
      !exactObject(value.source_health, ['phase_gates', 'receiver_dispatches']) ||
      !['ok', 'degraded', 'unavailable'].includes(value.source_health.phase_gates) ||
      !['ok', 'degraded', 'unavailable'].includes(value.source_health.receiver_dispatches) ||
      !cloneRuntimeSummary(value.summary) || !Array.isArray(value.phase_gates) ||
      value.phase_gates.length > DELIVERY_RUNTIME_INPUT_LIMIT) return null
  const generatedAt = strictIso(value.generated_at)
  const expiresAt = strictIso(value.expires_at)
  if (!generatedAt || !expiresAt || Date.parse(generatedAt) >= Date.parse(expiresAt)) return null
  const replay = cloneRuntimeReplay(value.replay)
  if (!replay || !Array.isArray(value.phase_runs) ||
      value.phase_runs.length !== DELIVERY_RUNTIME_PHASES.length) return null
  const phaseRuns = value.phase_runs.map((run, index) =>
    cloneRuntimePhaseRun(run, DELIVERY_RUNTIME_PHASES[index]))
  if (phaseRuns.some(run => !run) ||
      new Set(phaseRuns.map(run => run.phase_run_id)).size !== phaseRuns.length) return null
  const gates = value.phase_gates.map(cloneRuntimeGate)
  if (gates.some(gate => !gate) ||
      new Set(gates.map(gate => gate.slice_id)).size > 1 ||
      new Set(gates.map(gate => gate.gate_id)).size !== gates.length ||
      new Set(gates.map(gate => gate.attempt_id)).size !== gates.length ||
      hasDuplicateNonNull(gates.map(gate => gate.acceptance_event_id)) ||
      hasDuplicateNonNull(gates.map(gate => gate.receiver_dispatch_id)) ||
      !validRuntimeChronology(phaseRuns, gates, generatedAt)) return null
  gates.sort((left, right) =>
    DELIVERY_RUNTIME_BOUNDARY_ORDER.get(left.boundary) -
      DELIVERY_RUNTIME_BOUNDARY_ORDER.get(right.boundary) ||
    gateOrder(left, right))
  const bottleneck = cloneRuntimeBottleneck(value.bottleneck)
  if (bottleneck === undefined) return null
  if (!validRuntimeBottleneck(bottleneck, phaseRuns, gates, generatedAt)) return null
  let shown = gates.slice(0, DELIVERY_RUNTIME_LIMIT)
  if (bottleneck?.gate_id && !shown.some(gate => gate.gate_id === bottleneck.gate_id)) {
    const bottleneckGate = gates.find(gate => gate.gate_id === bottleneck.gate_id)
    shown = [...shown.slice(0, DELIVERY_RUNTIME_LIMIT - 1), bottleneckGate]
      .sort((left, right) =>
        DELIVERY_RUNTIME_BOUNDARY_ORDER.get(left.boundary) -
          DELIVERY_RUNTIME_BOUNDARY_ORDER.get(right.boundary) ||
        codePointCompare(left.proposed_at, right.proposed_at) ||
        codePointCompare(left.gate_id, right.gate_id))
  }
  return {
    schema: DELIVERY_RUNTIME_SCHEMA,
    schema_version: 1,
    generated_at: generatedAt,
    expires_at: expiresAt,
    trust_level: 'advisory_same_uid',
    mode: 'observe_only',
    actuation: { enabled: false, auto_execute: false },
    source_health: {
      phase_gates: value.source_health.phase_gates,
      receiver_dispatches: value.source_health.receiver_dispatches,
    },
    summary: summarizeRuntime(gates, shown),
    replay,
    phase_runs: phaseRuns,
    bottleneck,
    phase_gates: shown,
  }
}

function degradedDeliveryRuntime(nowMs) {
  const timestamp = new Date(nowMs).toISOString()
  return {
    schema: DELIVERY_RUNTIME_SCHEMA,
    schema_version: 1,
    generated_at: timestamp,
    expires_at: timestamp,
    trust_level: 'advisory_same_uid',
    mode: 'observe_only',
    actuation: { enabled: false, auto_execute: false },
    source_health: { phase_gates: 'unavailable', receiver_dispatches: 'unavailable' },
    summary: {
      proposed: 0, accepted: 0, rejected: 0, escalated: 0,
      consumed: 0, shown: 0, truncated: 0,
    },
    replay: { sequence: 0, head_event_id: null },
    phase_runs: DELIVERY_RUNTIME_PHASES.map((phase, index) => ({
      phase,
      phase_run_id: `unavailable_${index + 1}`,
      state: 'pending',
      started_at: null,
      transition_at: null,
      owner_role: 'phase_team',
      work_age_sec: null,
      wait_age_sec: null,
      handoff_count: 0,
      revision_count: 0,
    })),
    bottleneck: null,
    phase_gates: [],
  }
}

export function sanitizeDeliveryRuntimeProjection(input, nowMs = Date.now(), inputIssue = null) {
  const timestamp = Number.isFinite(nowMs) ? nowMs : Date.now()
  if (inputIssue) {
    const code = inputIssue === 'DELIVERY_RUNTIME_INPUT_UNREADABLE'
      ? 'DELIVERY_RUNTIME_INPUT_UNREADABLE' : 'DELIVERY_RUNTIME_INPUT_INVALID'
    return {
      projection: degradedDeliveryRuntime(timestamp),
      diagnostic: { code, severity: 'error', source: 'delivery_runtime', count: 1 },
    }
  }
  const projection = cloneDeliveryRuntime(input)
  if (!projection) {
    return {
      projection: degradedDeliveryRuntime(timestamp),
      diagnostic: {
        code: 'DELIVERY_RUNTIME_INPUT_INVALID',
        severity: 'error',
        source: 'delivery_runtime',
        count: 1,
      },
    }
  }
  if (Date.parse(projection.expires_at) <= timestamp) {
    return {
      projection: degradedDeliveryRuntime(timestamp),
      diagnostic: {
        code: 'DELIVERY_RUNTIME_STALE',
        severity: 'warning',
        source: 'delivery_runtime',
        count: 1,
      },
    }
  }
  return { projection, diagnostic: null }
}

export function projectPulseV4(
  view,
  meta,
  deliveryInput = null,
  deliveryIssue = null,
  includeDeliveryLoop = false,
  runtimeInput = null,
  runtimeIssue = null,
  includeDeliveryRuntime = false,
) {
  const diagnostics = [...(view.diagnostics || [])]
  let deliveryLoop = null
  let deliveryRuntime = null
  if (includeDeliveryLoop) {
    const sanitized = sanitizeDeliveryLoopProjection(deliveryInput, meta.finishedAt, deliveryIssue)
    deliveryLoop = sanitized.projection
    if (sanitized.diagnostic) diagnostics.unshift(sanitized.diagnostic)
  }
  if (includeDeliveryRuntime) {
    const sanitized = sanitizeDeliveryRuntimeProjection(runtimeInput, meta.finishedAt, runtimeIssue)
    deliveryRuntime = sanitized.projection
    if (sanitized.diagnostic) diagnostics.unshift(sanitized.diagnostic)
  }
  diagnostics.sort((left, right) => {
    const priority = (code) => code?.startsWith('DELIVERY_RUNTIME_')
      ? 0
      : code?.startsWith('DELIVERY_LOOP_') ? 1
        : code === 'PHASE_BINDING_CONFLICT' ? 2
          : code === 'PHASE_BINDING_INVALID' ? 3
            : code === 'SCHEMA_UPGRADED' ? 4 : 5
    return priority(left?.code) - priority(right?.code)
  })
  const projected = projectPulse(
    { ...view, diagnostics },
    meta,
    PULSE_SCHEMA_VERSION_V4,
    DIAGNOSTIC_CODES_V4,
    true,
  )
  return {
    ...projected,
    ...(includeDeliveryLoop ? { delivery_loop: deliveryLoop } : {}),
    ...(includeDeliveryRuntime ? { delivery_runtime: deliveryRuntime } : {}),
  }
}

const PULSE_V1_KEYS = [
  'schema', 'schema_version', 'stream_id', 'sequence', 'snapshot_id', 'trust_level',
  'generated_at', 'observation', 'complete', 'scope', 'source_health', 'summary',
  'runs', 'recent_verdicts', 'worker_stats', 'unclaimed_control', 'diagnostics',
]

const PULSE_STATES = new Set(Object.keys(STATE_META))
const PULSE_IDENTITY_SOURCES = new Set(['dispatch_id', 'legacy_task_time', 'process_only'])
const PULSE_TRANSPORTS = new Set(['tmux', 'acp'])
const PULSE_TERMINALS = new Set(['done', 'blocked', 'failed', 'absent', 'invalid'])
const PULSE_VERDICTS = new Set(['pass', 'reject', 'unresolved', 'absent'])
const PULSE_REASON_CODES = new Set(Object.values(STATE_META).map(value => value.reason))
const PULSE_ACTION_CODES = new Set(Object.values(STATE_META).map(value => value.action))
const PULSE_HEALTH = new Set(['ok', 'degraded', 'unavailable'])
const PULSE_DIAGNOSTIC_SEVERITIES = new Set(['info', 'warning', 'error'])
const PULSE_DIAGNOSTIC_SOURCES_V1 =
  new Set(['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher'])
const PULSE_DIAGNOSTIC_SOURCES_V2 =
  new Set([...PULSE_DIAGNOSTIC_SOURCES_V1, 'delivery_loop'])
const PULSE_DIAGNOSTIC_SOURCES_V4 =
  new Set([...PULSE_DIAGNOSTIC_SOURCES_V2, 'delivery_runtime'])

function incompatibleV1() {
  throw new Error('persisted Pulse snapshot is not compatible with v1')
}

function requiredIso(value) {
  const sanitized = strictIso(value)
  if (!sanitized) incompatibleV1()
  return sanitized
}

function requiredNullableIso(value) {
  if (value === null) return null
  return requiredIso(value)
}

function requiredNullableId(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !ID_RE.test(value)) incompatibleV1()
  return value
}

function requiredNullableUuid(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !UUID_RE.test(value)) incompatibleV1()
  return value
}

function requiredDuration(value) {
  if (value === null) return null
  if (!Number.isFinite(value) || value < 0) incompatibleV1()
  return value
}

function requiredInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) incompatibleV1()
  return value
}

function requiredEnum(value, allowed) {
  if (!allowed.has(value)) incompatibleV1()
  return value
}

function clonePulseObservationV1(value) {
  const keys = [
    'started_at', 'finished_at', 'consistency', 'refresh_interval_sec',
    'stale_after_sec', 'expires_at', 'quality',
  ]
  if (!exactObject(value, keys) || value.consistency !== 'best_effort' ||
      !['complete', 'degraded'].includes(value.quality)) incompatibleV1()
  return {
    started_at: requiredIso(value.started_at),
    finished_at: requiredIso(value.finished_at),
    consistency: 'best_effort',
    refresh_interval_sec: requiredInteger(value.refresh_interval_sec, 1),
    stale_after_sec: requiredInteger(value.stale_after_sec, 60),
    expires_at: requiredIso(value.expires_at),
    quality: value.quality,
  }
}

function clonePulseSourceHealthV1(value) {
  const keys = ['liveness', 'tmux', 'dispatch', 'outbox', 'events']
  if (!exactObject(value, keys)) incompatibleV1()
  return Object.fromEntries(keys.map(key => [key, requiredEnum(value[key], PULSE_HEALTH)]))
}

function clonePulseSummaryV1(value) {
  const states = [...PULSE_STATES]
  if (!exactObject(value, ['active', 'attention', 'by_state', 'truncated']) ||
      !exactObject(value.by_state, states)) incompatibleV1()
  return {
    active: requiredInteger(value.active),
    attention: requiredInteger(value.attention),
    by_state: Object.fromEntries(states.map(state => [
      state, requiredInteger(value.by_state[state]),
    ])),
    truncated: requiredInteger(value.truncated),
  }
}

function clonePulseSignalsV1(value) {
  const keys = ['dispatch', 'liveness', 'pane', 'terminal', 'pm_verdict', 'correlation']
  if (!exactObject(value, keys)) incompatibleV1()
  return {
    dispatch: requiredEnum(value.dispatch, new Set(['present', 'absent', 'unknown'])),
    liveness: requiredEnum(value.liveness, new Set(['alive', 'dead', 'unknown'])),
    pane: requiredEnum(value.pane, new Set(['held', 'gone', 'not_recorded', 'probe_unavailable'])),
    terminal: requiredEnum(value.terminal, PULSE_TERMINALS),
    pm_verdict: requiredEnum(value.pm_verdict, PULSE_VERDICTS),
    correlation: requiredEnum(value.correlation, PULSE_IDENTITY_SOURCES),
  }
}

function clonePulseReasonsV1(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 ||
      new Set(value).size !== value.length ||
      value.some(code => !PULSE_REASON_CODES.has(code))) incompatibleV1()
  return [...value]
}

function clonePulseAdvisoryV1(value) {
  if (!exactObject(value, ['attention', 'action_code', 'auto_execute']) ||
      typeof value.attention !== 'boolean' ||
      !PULSE_ACTION_CODES.has(value.action_code) ||
      value.auto_execute !== false) incompatibleV1()
  return {
    attention: value.attention,
    action_code: value.action_code,
    auto_execute: false,
  }
}

function clonePulseRunV1(value) {
  const keys = [
    'dispatch_id', 'task_id', 'identity_source', 'state', 'worker', 'transport',
    'started_at', 'elapsed_sec', 'silence_sec', 'timeout_sec', 'signals',
    'reason_codes', 'advisory',
  ]
  if (!exactObject(value, keys) || typeof value.task_id !== 'string' ||
      !ID_RE.test(value.task_id) ||
      !(value.transport === null || PULSE_TRANSPORTS.has(value.transport))) incompatibleV1()
  return {
    dispatch_id: requiredNullableUuid(value.dispatch_id),
    task_id: value.task_id,
    identity_source: requiredEnum(value.identity_source, PULSE_IDENTITY_SOURCES),
    state: requiredEnum(value.state, PULSE_STATES),
    worker: requiredNullableId(value.worker),
    transport: value.transport,
    started_at: requiredNullableIso(value.started_at),
    elapsed_sec: requiredDuration(value.elapsed_sec),
    silence_sec: requiredDuration(value.silence_sec),
    timeout_sec: requiredDuration(value.timeout_sec),
    signals: clonePulseSignalsV1(value.signals),
    reason_codes: clonePulseReasonsV1(value.reason_codes),
    advisory: clonePulseAdvisoryV1(value.advisory),
  }
}

function clonePulseRunV3(value) {
  const keys = [
    'dispatch_id', 'task_id', 'identity_source', 'state', 'worker', 'transport',
    'started_at', 'elapsed_sec', 'silence_sec', 'timeout_sec', 'signals',
    'reason_codes', 'advisory', 'phase', 'phase_source',
  ]
  if (!exactObject(value, keys)) incompatibleV1()
  const v1 = clonePulseRunV1(Object.fromEntries(
    Object.entries(value).filter(([key]) => !['phase', 'phase_source'].includes(key)),
  ))
  const phaseValue = value.phase === null ? null : requiredEnum(value.phase, PHASES)
  const source = requiredEnum(value.phase_source, PHASE_SOURCES)
  if (phaseValue === null && !['unassigned', 'conflict'].includes(source) ||
      phaseValue !== null && !ASSIGNED_PHASE_SOURCES.has(source)) incompatibleV1()
  return { ...v1, phase: phaseValue, phase_source: source }
}

function clonePulseRecentV1(value) {
  const keys = [
    'dispatch_id', 'task_id', 'worker', 'transport', 'terminal', 'pm_verdict',
    'started_at', 'wait_sec', 'timeout_sec',
  ]
  if (!exactObject(value, keys) ||
      typeof value.task_id !== 'string' || !ID_RE.test(value.task_id) ||
      typeof value.worker !== 'string' || !ID_RE.test(value.worker) ||
      !(value.transport === null || PULSE_TRANSPORTS.has(value.transport)) ||
      !['pass', 'reject', 'unresolved'].includes(value.pm_verdict)) incompatibleV1()
  return {
    dispatch_id: requiredNullableUuid(value.dispatch_id),
    task_id: value.task_id,
    worker: value.worker,
    transport: value.transport,
    terminal: requiredEnum(value.terminal, PULSE_TERMINALS),
    pm_verdict: value.pm_verdict,
    started_at: requiredNullableIso(value.started_at),
    wait_sec: requiredDuration(value.wait_sec),
    timeout_sec: requiredDuration(value.timeout_sec),
  }
}

function clonePulseRecentV3(value) {
  const keys = [
    'dispatch_id', 'task_id', 'worker', 'transport', 'terminal', 'pm_verdict',
    'started_at', 'wait_sec', 'timeout_sec', 'phase', 'phase_source',
  ]
  if (!exactObject(value, keys)) incompatibleV1()
  const v1 = clonePulseRecentV1(Object.fromEntries(
    Object.entries(value).filter(([key]) => !['phase', 'phase_source'].includes(key)),
  ))
  const phaseValue = value.phase === null ? null : requiredEnum(value.phase, PHASES)
  const source = requiredEnum(value.phase_source, PHASE_SOURCES)
  if (phaseValue === null && !['unassigned', 'conflict'].includes(source) ||
      phaseValue !== null && !ASSIGNED_PHASE_SOURCES.has(source)) incompatibleV1()
  return { ...v1, phase: phaseValue, phase_source: source }
}

function clonePulseWorkerStatV1(value) {
  if (!exactObject(value, ['worker', 'runs', 'rejected', 'median_wait_sec']) ||
      typeof value.worker !== 'string' || !ID_RE.test(value.worker)) incompatibleV1()
  const runs = requiredInteger(value.runs, 1)
  const rejected = requiredInteger(value.rejected)
  if (rejected > runs) incompatibleV1()
  return {
    worker: value.worker,
    runs,
    rejected,
    median_wait_sec: requiredDuration(value.median_wait_sec),
  }
}

function clonePulseUnclaimedV1(value) {
  if (!exactObject(value, ['task_id', 'age_sec']) ||
      typeof value.task_id !== 'string' || !ID_RE.test(value.task_id)) incompatibleV1()
  return { task_id: value.task_id, age_sec: requiredInteger(value.age_sec) }
}

function clonePulseDiagnosticForCompat(value, schemaVersion) {
  if (!exactObject(value, ['code', 'severity', 'source', 'count'])) incompatibleV1()
  const codes = schemaVersion === PULSE_SCHEMA_VERSION_V4
    ? DIAGNOSTIC_CODES_V4
    : schemaVersion === PULSE_SCHEMA_VERSION_V3
    ? DIAGNOSTIC_CODES_V3
    : schemaVersion === PULSE_SCHEMA_VERSION_V2 ? DIAGNOSTIC_CODES_V2 : DIAGNOSTIC_CODES_V1
  const sources = schemaVersion === PULSE_SCHEMA_VERSION_V4
    ? PULSE_DIAGNOSTIC_SOURCES_V4
    : [PULSE_SCHEMA_VERSION_V2, PULSE_SCHEMA_VERSION_V3].includes(schemaVersion)
      ? PULSE_DIAGNOSTIC_SOURCES_V2 : PULSE_DIAGNOSTIC_SOURCES_V1
  return {
    code: requiredEnum(value.code, codes),
    severity: requiredEnum(value.severity, PULSE_DIAGNOSTIC_SEVERITIES),
    source: requiredEnum(value.source, sources),
    count: requiredInteger(value.count, 1),
  }
}

function cloneBoundedArray(value, limit, cloneItem) {
  if (!Array.isArray(value) || value.length > limit) incompatibleV1()
  return value.map(cloneItem)
}

export function downProjectPulseV1(snapshot) {
  if (!isObject(snapshot) || snapshot.schema !== PULSE_SCHEMA ||
      ![
        PULSE_SCHEMA_VERSION, PULSE_SCHEMA_VERSION_V2, PULSE_SCHEMA_VERSION_V3,
        PULSE_SCHEMA_VERSION_V4,
      ]
        .includes(snapshot.schema_version)) incompatibleV1()
  const hasDeliveryLoop = Object.hasOwn(snapshot, 'delivery_loop')
  const hasDeliveryRuntime = Object.hasOwn(snapshot, 'delivery_runtime')
  const topKeys = [
    ...PULSE_V1_KEYS,
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V2 ||
      [PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4].includes(snapshot.schema_version) &&
        hasDeliveryLoop ? ['delivery_loop'] : []),
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V4 && hasDeliveryRuntime
      ? ['delivery_runtime'] : []),
  ]
  if (!exactObject(snapshot, topKeys) ||
      typeof snapshot.stream_id !== 'string' || !UUID_RE.test(snapshot.stream_id) ||
      !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 ||
      snapshot.snapshot_id !== `${snapshot.stream_id}:${snapshot.sequence}` ||
      snapshot.trust_level !== 'advisory_same_uid' ||
      typeof snapshot.complete !== 'boolean' ||
      !exactObject(snapshot.scope, ['repo_name']) ||
      !(snapshot.scope.repo_name === null ||
        (typeof snapshot.scope.repo_name === 'string' &&
          /^[A-Za-z0-9_.-]{1,80}$/.test(snapshot.scope.repo_name)))) incompatibleV1()
  const observation = clonePulseObservationV1(snapshot.observation)
  const diagnostics = cloneBoundedArray(
    snapshot.diagnostics,
    DIAGNOSTIC_LIMIT,
    item => clonePulseDiagnosticForCompat(item, snapshot.schema_version),
  ).filter(item =>
    DIAGNOSTIC_CODES_V1.has(item.code) && PULSE_DIAGNOSTIC_SOURCES_V1.has(item.source))
  const projected = {
    schema: PULSE_SCHEMA,
    schema_version: PULSE_SCHEMA_VERSION,
    stream_id: snapshot.stream_id,
    sequence: snapshot.sequence,
    snapshot_id: snapshot.snapshot_id,
    trust_level: 'advisory_same_uid',
    generated_at: requiredIso(snapshot.generated_at),
    observation,
    complete: diagnostics.length === 0,
    scope: { repo_name: snapshot.scope.repo_name },
    source_health: clonePulseSourceHealthV1(snapshot.source_health),
    summary: clonePulseSummaryV1(snapshot.summary),
    runs: cloneBoundedArray(
      snapshot.runs,
      RUN_LIMIT,
      [PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4].includes(snapshot.schema_version)
        ? (item) => {
            const { phase: _phase, phase_source: _source, ...v1 } = clonePulseRunV3(item)
            return v1
          }
        : clonePulseRunV1,
    ),
    recent_verdicts: cloneBoundedArray(
      snapshot.recent_verdicts,
      RECENT_LIMIT,
      [PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4].includes(snapshot.schema_version)
        ? (item) => {
            const { phase: _phase, phase_source: _source, ...v1 } = clonePulseRecentV3(item)
            return v1
          }
        : clonePulseRecentV1,
    ),
    worker_stats: cloneBoundedArray(snapshot.worker_stats, WORKER_STATS_LIMIT, clonePulseWorkerStatV1),
    unclaimed_control: cloneBoundedArray(
      snapshot.unclaimed_control, UNCLAIMED_LIMIT, clonePulseUnclaimedV1,
    ),
    diagnostics,
  }
  projected.complete = projected.diagnostics.length === 0
  projected.observation.quality = projected.complete ? 'complete' : 'degraded'
  return projected
}
