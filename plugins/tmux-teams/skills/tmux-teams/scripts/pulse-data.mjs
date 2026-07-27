// Pure, allowlisted projection for the machine-readable Pulse contract.
//
// This module deliberately does not serialize Pulse's internal observations
// wholesale. Repo-local dispatch/KMS files are writable by the same UID as a
// worker, so every string crossing this boundary is treated as untrusted data.

import { validateTeamGraph } from './team-graph-contract.mjs'
import { projectTeamRuntime } from './team-runtime.mjs'

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
  'TEAM_RUNTIME_INPUT_UNREADABLE',
  'TEAM_RUNTIME_INPUT_INVALID',
  'TEAM_RUNTIME_STALE',
  'TEAM_RUNTIME_FUTURE',
  'LIVENESS_EVIDENCE_UNREADABLE',
  'LIVENESS_EVIDENCE_INVALID',
  'LIVENESS_EVIDENCE_MISMATCH',
  'LIVENESS_EVIDENCE_FUTURE',
  'AGENT_ID_CONFLICT',
  'TEAM_GRAPH_INPUT_UNREADABLE',
  'TEAM_GRAPH_INPUT_INVALID',
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
export const ACP_LIVENESS_SCHEMA = 'acp-liveness.v1'
export const ACP_LIVENESS_STATES = new Set([
  'starting', 'awaiting_agent', 'active', 'tool_running', 'suspected_stalled',
  'cancelling', 'cancelled', 'stalled', 'failed', 'completed',
])
export const ACP_STALL_HISTORY_STATES = new Set([
  'suspected_stalled', 'stalled', 'recovered', 'cancellation_unavailable',
])
const safeEvidenceText = (value, maximum = 256) => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maximum ? text : null
}

const LIVENESS_TOOL_LIMIT = 16
const LIVENESS_ACTIVE_TOOL_LIMIT = 8
const LIVENESS_HISTORY_LIMIT = 32
const LIVENESS_OBJECT_LIMIT = 8
const LIVENESS_VALUE_DEPTH = 3
const LIVENESS_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const LIVENESS_DIGEST_RE = /^sha256:[0-9a-f]{64}$/

const ACP_LIVENESS_RAW_STATES = new Set([
  ...ACP_LIVENESS_STATES,
])
const ACP_LIVENESS_RAW_TOOL_STATUSES = new Set([
  'pending', 'in_progress', 'completed', 'failed',
])
const ACP_LIVENESS_RAW_IDENTITY_STATES = new Set([
  'matched', 'mismatched', 'missing', 'unverified',
])
const ACP_LIVENESS_RAW_KEYS = Object.freeze([
  'schema_version', 'task_id', 'dispatch_id', 'worker', 'transport', 'session_id',
  'started_at', 'observed_at', 'stall_sec', 'hard_timeout_sec', 'stall_policy',
  'cancellation_grace_sec', 'liveness_state', 'termination_reason',
  'last_protocol_activity_at', 'last_meaningful_progress_at', 'lease_anchor_at',
  'meaningful_progress_count', 'consecutive_missed_leases', 'next_lease_expiry_at',
  'stall_recoveries', 'stall_history', 'active_tools', 'tools', 'plan_digest',
  'plan_entry_count', 'cancellation_unavailable', 'requested_model',
  'requested_reasoning_effort', 'effective_identity', 'identity_status',
])
const ACP_LIVENESS_RAW_TOOL_KEYS = Object.freeze([
  'tool_call_id', 'title', 'kind', 'status', 'content_digest', 'output_digest',
  'locations_digest', 'updated_at', 'update_count',
])

const exactKeys = (value, required, optional = []) => {
  if (!isObject(value)) return false
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key))
}

function rawString(value, maximum) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
}

function rawNullableString(value, maximum) {
  return value === null || rawString(value, maximum)
}

function rawTimestamp(value) {
  return typeof value === 'string' && LIVENESS_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value))
}

function rawNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function rawNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validRawDigest(value) {
  return value === undefined || value === null || typeof value === 'string' && LIVENESS_DIGEST_RE.test(value)
}

function validRawTool(value) {
  if (!exactKeys(value,
    ['tool_call_id', 'title', 'kind', 'status', 'updated_at', 'update_count'],
    ['content_digest', 'output_digest', 'locations_digest'])) return false
  if (!rawString(value.tool_call_id, 128) || !rawString(value.title, 128) ||
      !rawString(value.kind, 64) || !ACP_LIVENESS_RAW_TOOL_STATUSES.has(value.status) ||
      !rawTimestamp(value.updated_at) || !Number.isSafeInteger(value.update_count) ||
      value.update_count < 1 || value.update_count > 1_000_000) return false
  return ['content_digest', 'output_digest', 'locations_digest'].every((key) => validRawDigest(value[key]))
}

function validRawHistory(value) {
  if (!exactKeys(value, ['state', 'evidence', 'observed_at'], [
    'reason', 'last_protocol_activity_at', 'last_meaningful_progress_at', 'active_tools',
  ])) return false
  if (!ACP_STALL_HISTORY_STATES.has(value.state) || !rawString(value.evidence, 128) ||
      !rawTimestamp(value.observed_at)) return false
  if (value.state === 'cancellation_unavailable') {
    if (!rawString(value.reason, 64)) return false
  } else if (Object.hasOwn(value, 'reason')) {
    return false
  }
  for (const key of ['last_protocol_activity_at', 'last_meaningful_progress_at']) {
    if (Object.hasOwn(value, key) && !rawTimestamp(value[key])) return false
  }
  if (Object.hasOwn(value, 'active_tools')) {
    if (!Array.isArray(value.active_tools) || value.active_tools.length > 1 ||
        value.active_tools.some((tool) => !validRawTool(tool))) return false
  }
  return true
}

/**
 * Validate the producer's complete closed acp-liveness.v1 object.
 *
 * This is intentionally separate from the smaller Pulse v4 projection
 * validator below. A raw source is trusted only after every scalar, lease,
 * identity, digest-tool, and history member has passed this closed contract.
 */
export function validateAcpLivenessV1(value) {
  if (!exactKeys(value, ACP_LIVENESS_RAW_KEYS, ['agent_id'])) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'raw liveness keys are not closed' }
  }
  if (value.schema_version !== ACP_LIVENESS_SCHEMA || typeof value.task_id !== 'string' ||
      !ID_RE.test(value.task_id) || typeof value.dispatch_id !== 'string' ||
      !UUID_RE.test(value.dispatch_id) || !rawString(value.worker, 64) ||
      value.transport !== 'acp' || !rawNullableString(value.session_id, 128) ||
      !rawTimestamp(value.started_at) || !rawTimestamp(value.observed_at) ||
      !rawNonNegativeNumber(value.stall_sec) || !rawNonNegativeNumber(value.hard_timeout_sec) ||
      !['cancel', 'report'].includes(value.stall_policy) ||
      !rawNonNegativeNumber(value.cancellation_grace_sec) ||
      !ACP_LIVENESS_RAW_STATES.has(value.liveness_state) ||
      !rawString(value.termination_reason, 64) ||
      !rawTimestamp(value.last_protocol_activity_at) ||
      !rawTimestamp(value.last_meaningful_progress_at) || !rawTimestamp(value.lease_anchor_at) ||
      !rawNonNegativeInteger(value.meaningful_progress_count) ||
      !rawNonNegativeInteger(value.consecutive_missed_leases) ||
      !rawTimestamp(value.next_lease_expiry_at) || !rawNonNegativeInteger(value.stall_recoveries) ||
      !Array.isArray(value.stall_history) || value.stall_history.length > 32 ||
      value.stall_history.some((entry) => !validRawHistory(entry)) ||
      !Array.isArray(value.active_tools) || value.active_tools.length > 8 ||
      value.active_tools.some((tool) => !validRawTool(tool)) ||
      !isObject(value.tools) || Object.keys(value.tools).length > 64 ||
      Object.entries(value.tools).some(([id, tool]) =>
        !rawString(id, 128) || !validRawTool(tool) || tool.tool_call_id !== id) ||
      !validRawDigest(value.plan_digest) || !rawNonNegativeInteger(value.plan_entry_count) ||
      typeof value.cancellation_unavailable !== 'boolean' ||
      !rawNullableString(value.requested_model, 128) ||
      !rawNullableString(value.requested_reasoning_effort, 64) ||
      !rawNullableString(value.effective_identity, 194) ||
      !ACP_LIVENESS_RAW_IDENTITY_STATES.has(value.identity_status) ||
      Object.hasOwn(value, 'agent_id') &&
        (typeof value.agent_id !== 'string' || !ID_RE.test(value.agent_id))) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'raw liveness field is invalid' }
  }
  if (value.identity_status === 'matched') {
    const expectedIdentity = `${value.requested_model || ''}${value.requested_reasoning_effort ? `[${value.requested_reasoning_effort}]` : ''}`
    if (!value.requested_model || value.effective_identity !== expectedIdentity) {
      return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'model identity attestation is invalid' }
    }
  }
  if (Date.parse(value.started_at) > Date.parse(value.observed_at)) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'liveness observation predates start' }
  }
  const leaseDelta = Date.parse(value.next_lease_expiry_at) - Date.parse(value.lease_anchor_at)
  const expectedLease = value.stall_sec * 1000
  if (value.liveness_state === 'tool_running' && value.active_tools.length > 0
      ? leaseDelta < expectedLease : leaseDelta !== expectedLease) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'liveness lease is not derived from its anchor' }
  }
  if (value.liveness_state === 'tool_running' &&
      (value.active_tools.length === 0 || value.active_tools.some((tool) => tool.status !== 'in_progress'))) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'tool_running active tools are not in progress' }
  }
  if (value.liveness_state === 'tool_running' &&
      (value.cancellation_unavailable || value.stall_history.some((entry) => entry.state === 'cancellation_unavailable'))) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'tool_running cannot report unavailable cancellation' }
  }
  for (const tool of value.active_tools) {
    if (!Object.hasOwn(value.tools, tool.tool_call_id)) {
      return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'active tool is absent from tools catalog' }
    }
  }
  if (value.liveness_state === 'tool_running' && value.active_tools.length === 0) {
    return { ok: false, code: 'LIVENESS_EVIDENCE_INVALID', reason: 'tool_running has no active tool' }
  }
  return { ok: true, value }
}

export function verifiedLivenessModel(value) {
  if (!value || value.identity_status !== 'matched' || !rawString(value.requested_model, 128)) return null
  const expectedIdentity = `${value.requested_model}${value.requested_reasoning_effort ? `[${value.requested_reasoning_effort}]` : ''}`
  return value.effective_identity === expectedIdentity ? value.requested_model : null
}

function boundedLivenessValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid bounded liveness value')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 256) throw new Error('oversized bounded liveness value')
    return value
  }
  if (depth >= LIVENESS_VALUE_DEPTH) {
    if (value !== '[bounded]') throw new Error('unbounded liveness value')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > LIVENESS_OBJECT_LIMIT) throw new Error('oversized liveness value')
    return value
      .map((item) => boundedLivenessValue(item, depth + 1))
  }
  if (typeof value !== 'object') throw new Error('invalid bounded liveness value')
  const entries = Object.entries(value)
  if (entries.length > LIVENESS_OBJECT_LIMIT || entries.some(([key]) =>
    typeof key !== 'string' || key.length === 0 || key.length > 64)) {
    throw new Error('oversized bounded liveness value')
  }
  return Object.fromEntries(entries.map(([key, child]) => [
    key, boundedLivenessValue(child, depth + 1),
  ]))
}

function projectLivenessTool(value) {
  const digestKeys = ['content_digest', 'output_digest', 'locations_digest']
  const required = ['tool_call_id', 'title', 'kind', 'status', 'updated_at', 'update_count']
  const keys = [...required, ...digestKeys]
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      !required.every((key) => Object.hasOwn(value, key)) ||
      required.slice(0, 3).some((key) => typeof value[key] !== 'string' ||
        value[key].length < 1 || value[key].length > 128) ||
      !ACP_LIVENESS_RAW_TOOL_STATUSES.has(value.status) ||
      typeof value.updated_at !== 'string' || !LIVENESS_TIMESTAMP_RE.test(value.updated_at) ||
      !Number.isFinite(Date.parse(value.updated_at)) ||
      !Number.isSafeInteger(value.update_count) || value.update_count < 1 ||
      value.update_count > 1_000_000) {
    throw new Error('invalid liveness tool evidence')
  }
  const tool = {
    tool_call_id: value.tool_call_id,
    title: value.title,
    kind: value.kind,
    status: value.status,
    updated_at: value.updated_at,
    update_count: value.update_count,
  }
  for (const key of digestKeys) {
    if (!Object.hasOwn(value, key) || value[key] === null) {
      if (Object.hasOwn(value, key)) tool[key] = value[key]
      continue
    }
    if (typeof value[key] !== 'string' || !LIVENESS_DIGEST_RE.test(value[key])) {
      throw new Error('invalid liveness tool digest')
    }
    tool[key] = value[key]
  }
  return tool
}

function projectLivenessHistory(value) {
  const keys = [
    'state', 'observed_at', 'evidence', 'last_protocol_activity_at',
    'last_meaningful_progress_at', 'active_tools', 'reason',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      !ACP_STALL_HISTORY_STATES.has(value.state) ||
      !Object.hasOwn(value, 'observed_at') || !Object.hasOwn(value, 'evidence') ||
      typeof value.evidence !== 'string' || value.evidence.length < 1 || value.evidence.length > 256 ||
      value.state === 'cancellation_unavailable' &&
        (!Object.hasOwn(value, 'reason') || typeof value.reason !== 'string' ||
          value.reason.length < 1 || value.reason.length > 64) ||
      value.state !== 'cancellation_unavailable' && Object.hasOwn(value, 'reason') ||
      typeof value.observed_at !== 'string' || !LIVENESS_TIMESTAMP_RE.test(value.observed_at) ||
      !Number.isFinite(Date.parse(value.observed_at))) {
    throw new Error('invalid liveness stall history')
  }
  const projected = {
    state: value.state,
    observed_at: value.observed_at,
    evidence: value.evidence,
  }
  if (Object.hasOwn(value, 'reason')) projected.reason = value.reason
  for (const key of ['last_protocol_activity_at', 'last_meaningful_progress_at']) {
    if (!Object.hasOwn(value, key)) continue
    if (value[key] !== null && (typeof value[key] !== 'string' ||
        !LIVENESS_TIMESTAMP_RE.test(value[key]) || !Number.isFinite(Date.parse(value[key])))) {
      throw new Error(`invalid liveness stall history ${key}`)
    }
    projected[key] = value[key]
  }
  if (Object.hasOwn(value, 'active_tools')) {
    if (!Array.isArray(value.active_tools) || value.active_tools.length > LIVENESS_TOOL_LIMIT) {
      throw new Error('invalid liveness stall history tools')
    }
    projected.active_tools = value.active_tools.map(projectLivenessTool)
  }
  return projected
}

function projectLivenessTools(value) {
  if (!isObject(value) || Object.keys(value).length > 64) {
    throw new Error('invalid liveness tools catalog')
  }
  const projected = {}
  for (const [toolId, tool] of Object.entries(value)) {
    if (!rawString(toolId, 128)) throw new Error('invalid liveness tool id')
    const next = projectLivenessTool(tool)
    if (next.tool_call_id !== toolId) throw new Error('liveness tool id mismatch')
    projected[toolId] = next
  }
  return projected
}

export function projectLivenessEvidence(value) {
  const keys = [
    'schema_version', 'task_id', 'dispatch_id', 'agent_id', 'liveness_state',
    'observed_at', 'last_protocol_activity_at', 'last_meaningful_progress_at', 'termination_reason',
    'active_tools', 'tools', 'stall_history',
  ]
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      value.schema_version !== ACP_LIVENESS_SCHEMA ||
      typeof value.task_id !== 'string' || !ID_RE.test(value.task_id) ||
      typeof value.dispatch_id !== 'string' || !UUID_RE.test(value.dispatch_id) ||
      !ACP_LIVENESS_STATES.has(value.liveness_state) ||
      !Object.hasOwn(value, 'observed_at') || typeof value.observed_at !== 'string' ||
      !LIVENESS_TIMESTAMP_RE.test(value.observed_at) || !Number.isFinite(Date.parse(value.observed_at)) ||
      !Object.hasOwn(value, 'last_protocol_activity_at') ||
      !Object.hasOwn(value, 'last_meaningful_progress_at') ||
      !Object.hasOwn(value, 'termination_reason') ||
      !Object.hasOwn(value, 'active_tools') || !Object.hasOwn(value, 'tools') ||
      !Object.hasOwn(value, 'stall_history')) {
    throw new Error('invalid liveness evidence')
  }
  for (const key of ['last_protocol_activity_at', 'last_meaningful_progress_at']) {
    if (typeof value[key] !== 'string' || !LIVENESS_TIMESTAMP_RE.test(value[key]) ||
        !Number.isFinite(Date.parse(value[key]))) throw new Error('invalid liveness timestamp')
  }
  if (value.agent_id !== null && value.agent_id !== undefined &&
      (typeof value.agent_id !== 'string' || !ID_RE.test(value.agent_id))) {
    throw new Error('invalid liveness agent id')
  }
  if (value.termination_reason !== null &&
      (typeof value.termination_reason !== 'string' || value.termination_reason.length < 1 ||
        value.termination_reason.length > 256)) {
    throw new Error('invalid liveness termination reason')
  }
  if (!Array.isArray(value.active_tools) || value.active_tools.length > LIVENESS_ACTIVE_TOOL_LIMIT ||
      !Array.isArray(value.stall_history) || value.stall_history.length > LIVENESS_HISTORY_LIMIT) {
    throw new Error('invalid liveness collections')
  }
  const activeTools = value.active_tools.map(projectLivenessTool)
  const stallHistory = value.stall_history.map(projectLivenessHistory)
  return {
    schema_version: ACP_LIVENESS_SCHEMA,
    task_id: value.task_id,
    dispatch_id: value.dispatch_id,
    agent_id: value.agent_id == null ? null : value.agent_id,
    liveness_state: value.liveness_state,
    observed_at: value.observed_at,
    last_protocol_activity_at: value.last_protocol_activity_at,
    last_meaningful_progress_at: value.last_meaningful_progress_at,
    termination_reason: value.termination_reason,
    active_tools: activeTools,
    tools: projectLivenessTools(value.tools),
    stall_history: stallHistory,
  }
}

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

function projectRun(run, includePhase = false, includeExtended = false) {
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
    ...(includeExtended ? { agent_id: safeId(run.agentId) } : {}),
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
  if (includeExtended) {
    projected.model = safeEvidenceText(run.model, 128)
    projected.identity_conflict = run.identityConflict === true
    projected.liveness_evidence = projectLivenessEvidence(run.livenessEvidence)
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

function projectRecent(event, includePhase = false, includeExtended = false) {
  const taskId = safeId(event.task_id)
  const worker = safeId(event.worker)
  if (!taskId || !worker || !['pass', 'reject', 'unresolved'].includes(event.pm_verdict)) return null
  const projected = {
    dispatch_id: safeUuid(event.dispatch_id),
    task_id: taskId,
    worker,
    ...(includeExtended ? { agent_id: safeId(event.agentId) } : {}),
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
    ? ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher', 'delivery_loop', 'delivery_runtime', 'team_runtime']
    : allowedCodes !== DIAGNOSTIC_CODES_V1
      ? ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher', 'delivery_loop']
    : ['liveness', 'tmux', 'dispatch', 'outbox', 'events', 'publisher']
  const source = allowedSources.includes(diagnostic?.source)
    ? diagnostic.source : 'publisher'
  if (!code) return null
  const count = Number.isSafeInteger(diagnostic.count) && diagnostic.count >= 1 ? diagnostic.count : 1
  return { code, severity, source, count }
}

function projectPulse(
  view,
  meta,
  schemaVersion,
  allowedDiagnosticCodes,
  includePhase = false,
  includeExtended = false,
  includeHistory = false,
) {
  const projected = view.active.map(run => projectRun(run, includePhase, includeExtended)).filter(Boolean)
    .sort((a, b) => Number(b.advisory.attention) - Number(a.advisory.attention) || a.task_id.localeCompare(b.task_id))
  const runs = projected.slice(0, RUN_LIMIT)
  const recent = [...view.rec].sort((a, b) => b.mtime - a.mtime)
    .map(event => projectRecent(event, includePhase, includeExtended)).filter(Boolean).slice(0, RECENT_LIMIT)
  const historicalRuns = includeHistory
    ? (view.history || []).map(run => projectRun(run, true, true)).filter(Boolean).slice(0, RUN_LIMIT)
    : null
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
    ...(includeHistory ? {
      history: {
        runs: historicalRuns,
        total: Number.isSafeInteger(view.historyTotal) && view.historyTotal >= historicalRuns.length
          ? view.historyTotal : (Array.isArray(view.history) ? view.history.length : 0),
        truncated: Math.max(
          0,
          (Number.isSafeInteger(view.historyTotal) && view.historyTotal >= historicalRuns.length
            ? view.historyTotal : (Array.isArray(view.history) ? view.history.length : 0)) - historicalRuns.length,
        ),
      },
    } : {}),
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
  if (!generatedAt || !expiresAt || Date.parse(generatedAt) > Date.parse(expiresAt)) return null
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

/** Sanitize the graph object consumed by the operational flow renderer. */
export function sanitizeTeamGraphProjection(input, sourceDigest = null, inputIssue = null) {
  if (inputIssue) {
    return {
      projection: null,
      diagnostic: {
        code: inputIssue === 'TEAM_GRAPH_INPUT_UNREADABLE'
          ? 'TEAM_GRAPH_INPUT_UNREADABLE' : 'TEAM_GRAPH_INPUT_INVALID',
        severity: 'error', source: 'publisher', count: 1,
      },
    }
  }
  const checked = validateTeamGraph(input, { sourceDigest })
  if (!checked.ok) {
    return {
      projection: null,
      diagnostic: { code: 'TEAM_GRAPH_INPUT_INVALID', severity: 'error', source: 'publisher', count: 1 },
    }
  }
  const teams = checked.value.teams.map(({ agents: _agents, ...team }) => team)
  return {
    projection: { ...checked.value, teams },
    diagnostic: null,
  }
}

export function sanitizeTeamRuntimeProjection(
  input,
  nowMs = Date.now(),
  inputIssue = null,
  teamGraph = null,
  snapshot = null,
) {
  if (inputIssue) {
    return {
      projection: null,
      diagnostic: {
        code: inputIssue === 'TEAM_RUNTIME_INPUT_UNREADABLE'
          ? 'TEAM_RUNTIME_INPUT_UNREADABLE' : 'TEAM_RUNTIME_INPUT_INVALID',
        severity: 'error', source: 'team_runtime', count: 1,
      },
    }
  }
  if (input === null) {
    return {
      projection: null,
      diagnostic: { code: 'TEAM_RUNTIME_INPUT_INVALID', severity: 'error', source: 'team_runtime', count: 1 },
    }
  }
  const checked = projectTeamRuntime(input, { teamGraph, snapshot, nowMs })
  return checked.diagnostic ? checked : { projection: checked.projection, diagnostic: null }
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
  teamGraphInput = null,
  teamGraphIssue = null,
  includeTeamGraph = false,
  teamRuntimeInput = null,
  teamRuntimeIssue = null,
  includeTeamRuntime = false,
) {
  const diagnostics = [...(view.diagnostics || [])]
  let deliveryLoop = null
  let deliveryRuntime = null
  let teamGraph = null
  let teamRuntime = null
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
  if (includeTeamGraph) {
    const sanitized = sanitizeTeamGraphProjection(
      teamGraphInput,
      meta.teamGraphSourceDigest,
      teamGraphIssue,
    )
    teamGraph = sanitized.projection
    if (sanitized.diagnostic) diagnostics.unshift(sanitized.diagnostic)
  }
  if (includeTeamRuntime) {
    const preliminary = projectPulse(
      { ...view, diagnostics },
      meta,
      PULSE_SCHEMA_VERSION_V4,
      DIAGNOSTIC_CODES_V4,
      true,
      true,
      true,
    )
    const sanitized = sanitizeTeamRuntimeProjection(
      teamRuntimeInput,
      meta.finishedAt,
      teamRuntimeIssue,
      teamGraph,
      { ...preliminary, team_graph: teamGraph },
    )
    teamRuntime = sanitized.projection
    if (sanitized.diagnostic) diagnostics.unshift(sanitized.diagnostic)
  }
  diagnostics.sort((left, right) => {
    const priority = (code) => code?.startsWith('TEAM_RUNTIME_')
      ? 0
      : code?.startsWith('DELIVERY_RUNTIME_') ? 1
        : code?.startsWith('DELIVERY_LOOP_') ? 2
          : code?.startsWith('TEAM_GRAPH_') ? 3
            : code?.startsWith('LIVENESS_EVIDENCE_') ? 4
              : code === 'PHASE_BINDING_CONFLICT' ? 5
                : code === 'PHASE_BINDING_INVALID' ? 6
                  : code === 'SCHEMA_UPGRADED' ? 7 : 8
    return priority(left?.code) - priority(right?.code)
  })
  const projected = projectPulse(
    { ...view, diagnostics },
    meta,
    PULSE_SCHEMA_VERSION_V4,
    DIAGNOSTIC_CODES_V4,
    true,
    true,
    true,
  )
  return {
    ...projected,
    ...(includeDeliveryLoop ? { delivery_loop: deliveryLoop } : {}),
    ...(includeDeliveryRuntime ? { delivery_runtime: deliveryRuntime } : {}),
    ...(includeTeamGraph ? { team_graph: teamGraph } : {}),
    team_runtime: teamRuntime,
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
  new Set([...PULSE_DIAGNOSTIC_SOURCES_V2, 'delivery_runtime', 'team_runtime'])

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

function cloneBoundedLivenessValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 256) return value
  if (depth >= LIVENESS_VALUE_DEPTH) {
    if (value !== '[bounded]') incompatibleV1()
    return value
  }
  if (Array.isArray(value) && value.length <= LIVENESS_OBJECT_LIMIT) {
    return value.map((item) => cloneBoundedLivenessValue(item, depth + 1))
  }
  if (isObject(value) && Object.keys(value).length <= LIVENESS_OBJECT_LIMIT) {
    const entries = Object.entries(value)
    if (entries.some(([key]) => typeof key !== 'string' || key.length === 0 || key.length > 64)) {
      incompatibleV1()
    }
    return Object.fromEntries(entries.map(([key, child]) => [
      key, cloneBoundedLivenessValue(child, depth + 1),
    ]))
  }
  incompatibleV1()
}

function cloneLivenessTool(value) {
  const digestKeys = ['content_digest', 'output_digest', 'locations_digest']
  const required = ['tool_call_id', 'title', 'kind', 'status', 'updated_at', 'update_count']
  const keys = [...required, ...digestKeys]
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key)) ||
      !required.every((key) => Object.hasOwn(value, key)) ||
      required.slice(0, 3).some((key) => typeof value[key] !== 'string' ||
        value[key].length < 1 || value[key].length > 128) ||
      !ACP_LIVENESS_RAW_TOOL_STATUSES.has(value.status) ||
      !rawTimestamp(value.updated_at) || !Number.isSafeInteger(value.update_count) ||
      value.update_count < 1) incompatibleV1()
  const result = Object.fromEntries(required.map((key) => [
    key, key === 'updated_at' ? requiredIso(value[key]) : value[key],
  ]))
  for (const key of digestKeys) {
    if (!Object.hasOwn(value, key)) continue
    if (value[key] !== null &&
        (typeof value[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value[key]))) incompatibleV1()
    result[key] = value[key]
  }
  return result
}

function cloneLivenessTools(value) {
  if (!isObject(value) || Object.keys(value).length > 64) incompatibleV1()
  const result = {}
  for (const [toolId, tool] of Object.entries(value)) {
    if (typeof toolId !== 'string' || toolId.length < 1 || toolId.length > 128) incompatibleV1()
    const cloned = cloneLivenessTool(tool)
    if (cloned.tool_call_id !== toolId) incompatibleV1()
    result[toolId] = cloned
  }
  return result
}

function cloneLivenessHistory(value) {
  const required = ['state', 'observed_at', 'evidence']
  const optional = ['reason', 'last_protocol_activity_at', 'last_meaningful_progress_at', 'active_tools']
  if (!isObject(value) || Object.keys(value).some((key) => ![...required, ...optional].includes(key)) ||
      !required.every((key) => Object.hasOwn(value, key)) || !ACP_STALL_HISTORY_STATES.has(value.state) ||
      typeof value.evidence !== 'string' || value.evidence.length < 1 || value.evidence.length > 256 ||
      value.state === 'cancellation_unavailable' &&
        (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 64) ||
      value.state !== 'cancellation_unavailable' && Object.hasOwn(value, 'reason')) incompatibleV1()
  const result = {
    state: value.state,
    observed_at: requiredIso(value.observed_at),
    evidence: value.evidence,
  }
  if (Object.hasOwn(value, 'reason')) result.reason = value.reason
  for (const key of ['last_protocol_activity_at', 'last_meaningful_progress_at']) {
    if (Object.hasOwn(value, key)) result[key] = requiredNullableIso(value[key])
  }
  if (Object.hasOwn(value, 'active_tools')) {
    result.active_tools = cloneBoundedArray(value.active_tools, LIVENESS_TOOL_LIMIT, cloneLivenessTool)
  }
  return result
}

function cloneLivenessEvidence(value) {
  const keys = [
    'schema_version', 'task_id', 'dispatch_id', 'agent_id', 'liveness_state',
    'observed_at', 'last_protocol_activity_at', 'last_meaningful_progress_at', 'termination_reason',
    'active_tools', 'tools', 'stall_history',
  ]
  if (!exactObject(value, keys) || value.schema_version !== ACP_LIVENESS_SCHEMA ||
      typeof value.task_id !== 'string' || !ID_RE.test(value.task_id) ||
      typeof value.dispatch_id !== 'string' || !UUID_RE.test(value.dispatch_id) ||
      !ACP_LIVENESS_STATES.has(value.liveness_state) ||
      typeof value.observed_at !== 'string' || !LIVENESS_TIMESTAMP_RE.test(value.observed_at) ||
      !(value.agent_id === null || typeof value.agent_id === 'string' && ID_RE.test(value.agent_id)) ||
      !(value.termination_reason === null ||
        typeof value.termination_reason === 'string' && value.termination_reason.length >= 1 &&
          value.termination_reason.length <= 256)) incompatibleV1()
  return {
    schema_version: ACP_LIVENESS_SCHEMA,
    task_id: value.task_id,
    dispatch_id: value.dispatch_id,
    agent_id: value.agent_id,
    observed_at: requiredIso(value.observed_at),
    liveness_state: value.liveness_state,
    last_protocol_activity_at: requiredIso(value.last_protocol_activity_at),
    last_meaningful_progress_at: requiredIso(value.last_meaningful_progress_at),
    termination_reason: value.termination_reason,
    active_tools: cloneBoundedArray(value.active_tools, LIVENESS_ACTIVE_TOOL_LIMIT, cloneLivenessTool),
    tools: cloneLivenessTools(value.tools),
    stall_history: cloneBoundedArray(value.stall_history, LIVENESS_HISTORY_LIMIT, cloneLivenessHistory),
  }
}

function clonePulseRunV4(value) {
  const keys = [
    'dispatch_id', 'task_id', 'identity_source', 'state', 'worker', 'agent_id', 'identity_conflict', 'model', 'transport',
    'started_at', 'elapsed_sec', 'silence_sec', 'timeout_sec', 'signals',
    'reason_codes', 'advisory', 'phase', 'phase_source', 'liveness_evidence',
  ]
  if (!exactObject(value, keys) ||
      !(value.agent_id === null || typeof value.agent_id === 'string' && ID_RE.test(value.agent_id)) ||
      typeof value.identity_conflict !== 'boolean' ||
      !(value.model === null || typeof value.model === 'string' && value.model.length >= 1 &&
        value.model.length <= 128) ||
      !(value.liveness_evidence === null || isObject(value.liveness_evidence))) incompatibleV1()
  const v3 = clonePulseRunV3(Object.fromEntries(
    Object.entries(value).filter(([key]) => !['agent_id', 'identity_conflict', 'model', 'liveness_evidence'].includes(key)),
  ))
  const livenessEvidence = value.liveness_evidence === null
    ? null : cloneLivenessEvidence(value.liveness_evidence)
  if (livenessEvidence !== null &&
      (livenessEvidence.task_id !== value.task_id ||
       livenessEvidence.dispatch_id !== value.dispatch_id ||
       livenessEvidence.agent_id !== null && livenessEvidence.agent_id !== value.agent_id)) {
    incompatibleV1()
  }
  return {
    ...v3,
    agent_id: value.agent_id,
    identity_conflict: value.identity_conflict,
    model: value.model,
    liveness_evidence: livenessEvidence,
  }
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

function clonePulseRecentV4(value) {
  const keys = [
    'dispatch_id', 'task_id', 'worker', 'agent_id', 'transport', 'terminal', 'pm_verdict',
    'started_at', 'wait_sec', 'timeout_sec', 'phase', 'phase_source',
  ]
  if (!exactObject(value, keys) ||
      !(value.agent_id === null || typeof value.agent_id === 'string' && ID_RE.test(value.agent_id))) {
    incompatibleV1()
  }
  const v3 = clonePulseRecentV3(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'agent_id'),
  ))
  return { ...v3, agent_id: value.agent_id }
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
  const hasTeamGraph = Object.hasOwn(snapshot, 'team_graph')
  const hasTeamRuntime = Object.hasOwn(snapshot, 'team_runtime')
  const hasHistory = Object.hasOwn(snapshot, 'history')
  const topKeys = [
    ...PULSE_V1_KEYS,
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V2 ||
      [PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4].includes(snapshot.schema_version) &&
        hasDeliveryLoop ? ['delivery_loop'] : []),
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V4 && hasDeliveryRuntime
      ? ['delivery_runtime'] : []),
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V4 && hasTeamGraph
      ? ['team_graph'] : []),
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V4 && hasHistory
      ? ['history'] : []),
    ...(snapshot.schema_version === PULSE_SCHEMA_VERSION_V4 && hasTeamRuntime
      ? ['team_runtime'] : []),
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
  if (hasHistory) {
    if (!exactObject(snapshot.history, ['runs', 'total', 'truncated']) ||
        !Number.isSafeInteger(snapshot.history.total) || snapshot.history.total < 0 ||
        !Number.isSafeInteger(snapshot.history.truncated) || snapshot.history.truncated < 0 ||
        !Array.isArray(snapshot.history.runs) || snapshot.history.runs.length > RUN_LIMIT) {
      incompatibleV1()
    }
    snapshot.history.runs.forEach((item) => clonePulseRunV4(item))
  }
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
            const { phase: _phase, phase_source: _source, agent_id: _agentId, identity_conflict: _identityConflict, model: _model, liveness_evidence: _liveness, ...v1 } =
              snapshot.schema_version === PULSE_SCHEMA_VERSION_V4
                ? clonePulseRunV4(item) : clonePulseRunV3(item)
            return v1
          }
        : clonePulseRunV1,
    ),
    recent_verdicts: cloneBoundedArray(
      snapshot.recent_verdicts,
      RECENT_LIMIT,
      [PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4].includes(snapshot.schema_version)
        ? (item) => {
            const { phase: _phase, phase_source: _source, agent_id: _agentId, ...v1 } =
              snapshot.schema_version === PULSE_SCHEMA_VERSION_V4
                ? clonePulseRecentV4(item) : clonePulseRecentV3(item)
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

function compatibilityDiagnostics(snapshot, schemaVersion) {
  const diagnostics = cloneBoundedArray(
    snapshot.diagnostics,
    DIAGNOSTIC_LIMIT,
    item => clonePulseDiagnosticForCompat(item, schemaVersion),
  ).filter(item => {
    const codes = schemaVersion === PULSE_SCHEMA_VERSION_V3
      ? DIAGNOSTIC_CODES_V3 : DIAGNOSTIC_CODES_V2
    const sources = schemaVersion === PULSE_SCHEMA_VERSION_V3
      ? PULSE_DIAGNOSTIC_SOURCES_V2 : PULSE_DIAGNOSTIC_SOURCES_V2
    return codes.has(item.code) && sources.has(item.source)
  })
  return diagnostics
}

function compatibilityBase(snapshot, schemaVersion) {
  const base = downProjectPulseV1(snapshot)
  const diagnostics = compatibilityDiagnostics(snapshot, schemaVersion)
  const projected = {
    ...base,
    schema_version: schemaVersion,
    diagnostics,
    complete: diagnostics.length === 0,
    observation: { ...base.observation, quality: diagnostics.length ? 'degraded' : 'complete' },
  }
  return projected
}

function v3RunFromSnapshot(value, sourceVersion) {
  if (sourceVersion === PULSE_SCHEMA_VERSION_V4) {
    const run = clonePulseRunV4(value)
    const { agent_id: _agentId, identity_conflict: _identityConflict, model: _model, liveness_evidence: _liveness, ...v3 } = run
    return clonePulseRunV3(v3)
  }
  return clonePulseRunV3(value)
}

function v3RecentFromSnapshot(value, sourceVersion) {
  if (sourceVersion === PULSE_SCHEMA_VERSION_V4) {
    const recent = clonePulseRecentV4(value)
    const { agent_id: _agentId, ...v3 } = recent
    return clonePulseRecentV3(v3)
  }
  return clonePulseRecentV3(value)
}

/**
 * Downproject a closed v4 (or compatible newer) snapshot to the real v2
 * schema. v2 has a required delivery-loop projection but no phase, model,
 * agent identity, liveness evidence, or historical-run area.
 */
export function downProjectPulseV2(snapshot) {
  if (!isObject(snapshot) || !Object.hasOwn(snapshot, 'delivery_loop')) incompatibleV1()
  const deliveryLoop = cloneDeliveryLoop(snapshot.delivery_loop)
  if (!deliveryLoop) incompatibleV1()
  return {
    ...compatibilityBase(snapshot, PULSE_SCHEMA_VERSION_V2),
    delivery_loop: deliveryLoop,
  }
}

/**
 * Downproject to v3 while preserving only evidence-sourced phase attribution.
 * All v4-only identity, model, liveness, team-graph, and history fields are
 * deliberately stripped before the closed v3 shape is returned.
 */
export function downProjectPulseV3(snapshot) {
  if (!isObject(snapshot) ||
      ![PULSE_SCHEMA_VERSION_V3, PULSE_SCHEMA_VERSION_V4].includes(snapshot.schema_version)) {
    incompatibleV1()
  }
  const projected = compatibilityBase(snapshot, PULSE_SCHEMA_VERSION_V3)
  projected.runs = cloneBoundedArray(
    snapshot.runs,
    RUN_LIMIT,
    item => v3RunFromSnapshot(item, snapshot.schema_version),
  )
  projected.recent_verdicts = cloneBoundedArray(
    snapshot.recent_verdicts,
    RECENT_LIMIT,
    item => v3RecentFromSnapshot(item, snapshot.schema_version),
  )
  if (Object.hasOwn(snapshot, 'delivery_loop')) {
    const deliveryLoop = cloneDeliveryLoop(snapshot.delivery_loop)
    if (!deliveryLoop) incompatibleV1()
    projected.delivery_loop = deliveryLoop
  }
  return projected
}
