import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  PHASE_BOUNDARIES,
  canonicalDigest,
  canonicalJson,
  validatePhaseExitArtifact,
} from './delivery-loop-core.mjs'

export const PHASE_GATE_SCHEMA = 'tmux-teams.phase-gate-event'
export const PHASE_GATE_VERSION = 1
export const PHASE_GATE_MANIFEST_SCHEMA = 'tmux-teams.phase-gate-store'
export const PHASE_GATE_TRUST_LEVEL = 'advisory_same_uid'
export const PHASE_GATE_JSON_MAX_BYTES = 1024 * 1024
export const PHASE_SEQUENCE = Object.freeze(['Requirement', 'Prototype', 'Development', 'QA', 'ProjectDelivery'])
export const REQUIREMENT_BOOTSTRAP_BOUNDARY = Object.freeze({ sender_phase: 'ProjectBootstrap', receiver_phase: 'Requirement' })
export const PHASE_GATE_EVENTS = Object.freeze([
  'project_genesis', 'phase_work', 'artifact_submission', 'handoff_propose',
  'handoff_accept', 'handoff_reject', 'handoff_escalate', 'handoff_resolve',
  'dispatch_reservation', 'dispatch_child_registered', 'dispatch_consumption',
  'dispatch_footprint', 'dispatch_prompt', 'dispatch_terminal', 'dispatch_indeterminate',
  'dispatch_resolution',
  'project_delivery_accept',
])

const TYPES = new Set(PHASE_GATE_EVENTS)
const ROLES = new Set(['sender', 'receiver_phase_lead', 'pm'])
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const PHASES = new Set(PHASE_SEQUENCE)
const PHASE_RUN_PHASES = new Set(PHASE_SEQUENCE.slice(0, -1))
const ARTIFACT_ID_MAX = 128
const ARTIFACT_TEXT_MAX = 4096
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const fail = (errors, code, path, message) => errors.push({ code, path, message })
const nonEmpty = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && ID.test(value)
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max
const jsonValue = (value, depth = 0) => {
  if (depth > 16) return false
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => jsonValue(item, depth + 1))
  return isObject(value) && Object.keys(value).length <= 64
    && Object.values(value).every((item) => jsonValue(item, depth + 1))
}
const rfc3339Millis = (value) => {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null
  if (!match) return null
  const calendar = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (calendar.getUTCFullYear() !== Number(match[1])
    || calendar.getUTCMonth() !== Number(match[2]) - 1
    || calendar.getUTCDate() !== Number(match[3])) return null
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? millis : null
}
const exactKeys = (errors, value, required, allowed = required, path = '') => {
  if (!isObject(value)) {
    fail(errors, 'OBJECT_REQUIRED', path || 'value', 'A closed object is required.')
    return
  }
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(errors, 'FIELD_UNKNOWN', path ? `${path}.${key}` : key, 'Field is not in the closed contract.')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(errors, 'FIELD_REQUIRED', path ? `${path}.${key}` : key, 'Required field is missing.')
  }
}
const includesActor = (values, actorId) => Array.isArray(values) && values.includes(actorId)

export class PhaseGateValidationError extends Error {
  constructor(errors, code = 'PHASE_GATE_VALIDATION_FAILED') {
    super('Phase gate validation failed')
    this.name = 'PhaseGateValidationError'
    this.code = code
    this.errors = errors
  }
}

export function canonicalPhaseGateEventId(event) {
  if (!isObject(event)) return null
  const unsigned = { ...event }
  delete unsigned.event_id
  return canonicalDigest(unsigned)
}

export function stablePhaseRunId(sliceId, phase) {
  if (!nonEmpty(sliceId) || !PHASE_RUN_PHASES.has(phase)) {
    throw new TypeError('stablePhaseRunId requires a valid slice id and one governed phase')
  }
  const digest = createHash('sha256')
    .update(`tmux-teams.phase-run/v1\0${sliceId}\0${phase}`)
    .digest('hex')
  return `phase-run:${digest}`
}

export function canonicalRepoIdentity(repoRoot) {
  return canonicalDigest({ repo_root: repoRoot })
}

export function verifyArtifactBytes(artifact, bytes) {
  if (!artifact || !DIGEST.test(artifact.digest ?? '')
    || !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array || typeof bytes === 'string')) return false
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` === artifact.digest
}

function checkIdList(errors, value, path) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
    || value.some((item) => !nonEmpty(item)) || new Set(value).size !== value.length) {
    fail(errors, 'ACTOR_ROSTER_INVALID', path, 'Actor roster must be a non-empty unique list of ids.')
  }
}

export function validatePhaseGateManifest(manifest) {
  const errors = []
  if (!isObject(manifest) || !jsonValue(manifest)) {
    fail(errors, 'MANIFEST_BOUNDS_INVALID', 'manifest', 'Manifest must be a bounded JSON object.')
    return { valid: false, errors }
  }
  exactKeys(errors, manifest, [
    'schema', 'schema_version', 'project_run_id', 'slice_id', 'repo_root',
    'repo_identity_digest', 'actors', 'trust_level',
  ])
  if (manifest.schema !== PHASE_GATE_MANIFEST_SCHEMA || manifest.schema_version !== 1) {
    fail(errors, 'MANIFEST_SCHEMA_INVALID', 'schema', 'Incorrect store manifest schema.')
  }
  if (!nonEmpty(manifest.project_run_id)) fail(errors, 'ID_REQUIRED', 'project_run_id', 'project_run_id is required.')
  if (!nonEmpty(manifest.slice_id)) fail(errors, 'ID_REQUIRED', 'slice_id', 'slice_id is required.')
  if (!text(manifest.repo_root, 4096) || !manifest.repo_root.startsWith('/')
    || manifest.repo_root === '/' || posix.normalize(manifest.repo_root) !== manifest.repo_root) {
    fail(errors, 'REPO_ROOT_INVALID', 'repo_root', 'repo_root must be an absolute canonical POSIX path.')
  } else if (manifest.repo_identity_digest !== canonicalRepoIdentity(manifest.repo_root)) {
    fail(errors, 'REPO_IDENTITY_INVALID', 'repo_identity_digest', 'Repository identity digest does not bind repo_root.')
  }
  if (manifest.trust_level !== PHASE_GATE_TRUST_LEVEL) {
    fail(errors, 'TRUST_LEVEL_INVALID', 'trust_level', 'Only advisory_same_uid is supported.')
  }
  exactKeys(errors, manifest.actors, ['pm', 'phase_leads'], ['pm', 'phase_leads'], 'actors')
  checkIdList(errors, manifest.actors?.pm, 'actors.pm')
  exactKeys(errors, manifest.actors?.phase_leads, PHASE_SEQUENCE, PHASE_SEQUENCE, 'actors.phase_leads')
  for (const phase of PHASE_SEQUENCE) checkIdList(errors, manifest.actors?.phase_leads?.[phase], `actors.phase_leads.${phase}`)
  return { valid: errors.length === 0, errors }
}

export function createPhaseGateManifest(input) {
  const manifest = {
    schema: PHASE_GATE_MANIFEST_SCHEMA,
    schema_version: 1,
    project_run_id: input?.project_run_id,
    slice_id: input?.slice_id,
    repo_root: input?.repo_root,
    repo_identity_digest: input?.repo_identity_digest ?? canonicalRepoIdentity(input?.repo_root),
    actors: input?.actors,
    trust_level: input?.trust_level ?? PHASE_GATE_TRUST_LEVEL,
  }
  const validation = validatePhaseGateManifest(manifest)
  if (!validation.valid) throw new PhaseGateValidationError(validation.errors)
  return structuredClone(manifest)
}

function checkActorShape(errors, actor, path = 'actor') {
  exactKeys(errors, actor, ['actor_id', 'role', 'trust'], ['actor_id', 'role', 'trust'], path)
  if (!nonEmpty(actor?.actor_id)) fail(errors, 'ACTOR_ID_REQUIRED', `${path}.actor_id`, 'Actor id is required.')
  if (!ROLES.has(actor?.role)) fail(errors, 'ACTOR_ROLE_INVALID', `${path}.role`, 'Actor role is not allowed.')
  if (actor?.trust !== PHASE_GATE_TRUST_LEVEL) fail(errors, 'ACTOR_TRUST_INVALID', `${path}.trust`, 'Claims are advisory_same_uid only.')
}

function checkBoundary(errors, boundary, path = 'boundary') {
  exactKeys(errors, boundary, ['sender_phase', 'receiver_phase'], ['sender_phase', 'receiver_phase'], path)
  if (!Object.hasOwn(PHASE_BOUNDARIES, boundary?.sender_phase)
    || PHASE_BOUNDARIES[boundary?.sender_phase] !== boundary?.receiver_phase) {
    fail(errors, 'BOUNDARY_INVALID', path, 'Boundary must be one legal forward phase boundary.')
  }
}

function isBootstrapBoundary(boundary) {
  return same(boundary, REQUIREMENT_BOOTSTRAP_BOUNDARY)
}

function checkArtifact(errors, artifact, boundary, path = 'artifact') {
  if (!boundary?.sender_phase) return
  const phase = boundary.sender_phase
  const common = ['type', 'artifact_id', 'version', 'digest', 'predecessor_trace', 'validation_evidence', 'expectations']
  const phaseKeys = {
    Requirement: ['business_functions', 'validation_exceptions'],
    Prototype: ['clickable_prototype_ref'],
    Development: ['working_software_ref'],
    QA: ['e2e_uat_report_ref'],
  }[phase] ?? []
  exactKeys(errors, artifact, [...common, ...phaseKeys], [...common, ...phaseKeys], path)
  exactKeys(errors, artifact?.expectations, ['security', 'performance', 'integration', 'uat'], ['security', 'performance', 'integration', 'uat'], `${path}.expectations`)
  for (const field of ['artifact_id', 'version']) {
    if (typeof artifact?.[field] === 'string' && artifact[field].length > ARTIFACT_ID_MAX) {
      fail(errors, 'ARTIFACT_TEXT_TOO_LONG', `${path}.${field}`, `${field} exceeds the bounded phase-gate contract.`)
    }
  }
  for (const field of ['predecessor_trace', 'validation_evidence', 'business_functions', 'validation_exceptions']) {
    if (Array.isArray(artifact?.[field]) && artifact[field].some((value) => typeof value === 'string' && value.length > ARTIFACT_TEXT_MAX)) {
      fail(errors, 'ARTIFACT_TEXT_TOO_LONG', `${path}.${field}`, `${field} contains an overlong reference.`)
    }
  }
  for (const field of ['clickable_prototype_ref', 'working_software_ref', 'e2e_uat_report_ref']) {
    if (typeof artifact?.[field] === 'string' && artifact[field].length > ARTIFACT_TEXT_MAX) {
      fail(errors, 'ARTIFACT_TEXT_TOO_LONG', `${path}.${field}`, `${field} exceeds the bounded phase-gate contract.`)
    }
  }
  if (isObject(artifact?.expectations)) {
    for (const field of ['security', 'performance', 'integration', 'uat']) {
      if (typeof artifact.expectations[field] === 'string' && artifact.expectations[field].length > ARTIFACT_TEXT_MAX) {
        fail(errors, 'ARTIFACT_TEXT_TOO_LONG', `${path}.expectations.${field}`, `${field} exceeds the bounded phase-gate contract.`)
      }
    }
  }
  const result = validatePhaseExitArtifact(phase, artifact)
  for (const item of result.errors) errors.push({ ...item, path: item.path.replace(/^artifact/, path) })
}

const EVENT_FIELDS = Object.freeze({
  project_genesis: [],
  phase_work: ['attempt_id', 'handoff_id', 'revision', 'boundary'],
  artifact_submission: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact'],
  handoff_propose: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact', 'artifact_event_id'],
  handoff_accept: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact', 'artifact_event_id'],
  handoff_reject: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact', 'artifact_event_id'],
  handoff_escalate: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact', 'artifact_event_id'],
  handoff_resolve: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact', 'artifact_event_id'],
  dispatch_reservation: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id', 'artifact_event_id'],
  dispatch_child_registered: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id'],
  dispatch_footprint: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id'],
  dispatch_prompt: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id'],
  dispatch_terminal: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id'],
  dispatch_indeterminate: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id'],
  dispatch_resolution: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id'],
  dispatch_consumption: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'dispatch_uuid', 'acceptance_event_id', 'artifact_event_id'],
  project_delivery_accept: ['attempt_id', 'handoff_id', 'revision', 'boundary', 'artifact', 'artifact_event_id'],
})
const BASE_FIELDS = Object.freeze([
  'schema', 'schema_version', 'event_id', 'sequence', 'previous_event_id', 'occurred_at',
  'project_run_id', 'slice_id', 'manifest_digest', 'phase_run_id', 'actor',
  'command_id', 'idempotency_key', 'event_type', 'payload',
])
const PAYLOAD_KEYS = Object.freeze({
  project_genesis: ['initial_phase'],
  phase_work: ['work_item_id', 'status'],
  artifact_submission: [],
  handoff_propose: [],
  handoff_accept: ['artifact_event_id', 'artifact_digest', 'sender_phase', 'receiver_phase', 'sender_actor_id', 'receiver_actor_id'],
  handoff_reject: ['reason_code'],
  handoff_escalate: ['reason_code'],
  handoff_resolve: ['resolution'],
  dispatch_reservation: ['artifact_event_id', 'artifact_digest', 'task_id', 'agent_id', 'brief_digest', 'expected_head', 'trust_level', 'timeout_sec'],
  dispatch_child_registered: ['reservation_event_id', 'pid', 'ppid', 'process_start', 'child_identity_digest'],
  dispatch_footprint: ['footprint_digest'],
  dispatch_prompt: ['prompt_digest'],
  dispatch_terminal: ['outcome', 'evidence_digest'],
  dispatch_indeterminate: ['reason', 'observed_state'],
  dispatch_resolution: ['resolution', 'reason', 'expected_head', 'reservation_event_id', 'terminal_evidence_digest'],
  dispatch_consumption: ['artifact_event_id', 'artifact_digest'],
  project_delivery_accept: ['artifact_event_id', 'artifact_digest', 'sender_phase', 'receiver_phase', 'sender_actor_id', 'receiver_actor_id'],
})

function checkPayload(errors, event) {
  const bootstrap = event.event_type === 'dispatch_reservation' && isBootstrapBoundary(event.boundary)
  const keys = bootstrap
    ? ['bootstrap', 'task_id', 'agent_id', 'brief_digest', 'expected_head', 'trust_level', 'timeout_sec']
    : PAYLOAD_KEYS[event.event_type] ?? []
  exactKeys(errors, event.payload, keys, keys, 'payload')
  const payload = event.payload ?? {}
  if (event.event_type === 'project_genesis' && payload.initial_phase !== 'Requirement') {
    fail(errors, 'GENESIS_PHASE_INVALID', 'payload.initial_phase', 'The delivery slice must bootstrap at Requirement.')
  }
  if (bootstrap && payload.bootstrap !== true) {
    fail(errors, 'BOOTSTRAP_MARKER_REQUIRED', 'payload.bootstrap', 'Requirement bootstrap reservation must be explicit.')
  }
  if (event.event_type === 'phase_work') {
    if (!nonEmpty(payload.work_item_id)) fail(errors, 'WORK_ITEM_INVALID', 'payload.work_item_id', 'work_item_id is required.')
    if (!['started', 'completed'].includes(payload.status)) fail(errors, 'WORK_STATUS_INVALID', 'payload.status', 'Work status is invalid.')
  }
  for (const field of ['artifact_digest', 'artifact_event_id', 'brief_digest', 'child_identity_digest', 'footprint_digest', 'prompt_digest', 'evidence_digest', 'reservation_event_id']) {
    if (Object.hasOwn(payload, field) && !DIGEST.test(payload[field] ?? '')) fail(errors, 'DIGEST_INVALID', `payload.${field}`, `${field} must be SHA-256.`)
  }
  for (const field of ['artifact_event_id']) {
    if (Object.hasOwn(payload, field) && !DIGEST.test(payload[field] ?? '')) fail(errors, 'EVENT_LINK_INVALID', `payload.${field}`, `${field} must be an event digest.`)
  }
  for (const field of ['sender_actor_id', 'receiver_actor_id', 'task_id', 'agent_id']) {
    if (Object.hasOwn(payload, field) && !nonEmpty(payload[field])) fail(errors, 'ID_REQUIRED', `payload.${field}`, `${field} is required.`)
  }
  for (const field of ['reason_code']) {
    if (Object.hasOwn(payload, field) && !nonEmpty(payload[field])) fail(errors, 'ID_REQUIRED', `payload.${field}`, `${field} is required.`)
  }
  for (const field of ['resolution', 'reason', 'process_start']) {
    if (Object.hasOwn(payload, field) && !text(payload[field])) fail(errors, 'TEXT_REQUIRED', `payload.${field}`, `${field} is required.`)
  }
  if (Object.hasOwn(payload, 'sender_phase') && (!PHASES.has(payload.sender_phase) || payload.sender_phase === 'ProjectDelivery')) {
    fail(errors, 'PHASE_INVALID', 'payload.sender_phase', 'sender_phase is invalid.')
  }
  if (Object.hasOwn(payload, 'receiver_phase') && !PHASES.has(payload.receiver_phase)) {
    fail(errors, 'PHASE_INVALID', 'payload.receiver_phase', 'receiver_phase is invalid.')
  }
  if (Object.hasOwn(payload, 'trust_level') && payload.trust_level !== PHASE_GATE_TRUST_LEVEL) {
    fail(errors, 'TRUST_LEVEL_INVALID', 'payload.trust_level', 'Reservation trust level must match the manifest.')
  }
  if (Object.hasOwn(payload, 'expected_head')) {
    exactKeys(errors, payload.expected_head, ['sequence', 'event_id'], ['sequence', 'event_id'], 'payload.expected_head')
    if (!Number.isInteger(payload.expected_head?.sequence) || payload.expected_head.sequence < 0) fail(errors, 'HEAD_INVALID', 'payload.expected_head.sequence', 'Expected sequence is invalid.')
    if (payload.expected_head?.sequence === 0 ? payload.expected_head.event_id !== null : !DIGEST.test(payload.expected_head?.event_id ?? '')) {
      fail(errors, 'HEAD_INVALID', 'payload.expected_head.event_id', 'Expected event id is invalid.')
    }
  }
  for (const field of ['pid', 'ppid']) {
    if (Object.hasOwn(payload, field) && (!Number.isInteger(payload[field]) || payload[field] < (field === 'pid' ? 1 : 0))) {
      fail(errors, 'PROCESS_ID_INVALID', `payload.${field}`, `${field} must be a valid process number.`)
    }
  }
  if (Object.hasOwn(payload, 'timeout_sec')
    && (!Number.isInteger(payload.timeout_sec) || payload.timeout_sec < 1 || payload.timeout_sec > 86400)) {
    fail(errors, 'TIMEOUT_INVALID', 'payload.timeout_sec', 'timeout_sec must be an integer from 1 through 86400.')
  }
  if (Object.hasOwn(payload, 'status') && !['started', 'completed'].includes(payload.status)) fail(errors, 'STATUS_INVALID', 'payload.status', 'Status is invalid.')
  if (Object.hasOwn(payload, 'outcome') && !['success', 'failure', 'cancelled'].includes(payload.outcome)) fail(errors, 'OUTCOME_INVALID', 'payload.outcome', 'Terminal outcome is invalid.')
  if (Object.hasOwn(payload, 'resolution') && !['abandoned', 'terminal_observed'].includes(payload.resolution)) fail(errors, 'RESOLUTION_INVALID', 'payload.resolution', 'Dispatch resolution is invalid.')
  if (Object.hasOwn(payload, 'terminal_evidence_digest')) {
    const expectedDigest = payload.resolution === 'terminal_observed'
    if (expectedDigest ? !DIGEST.test(payload.terminal_evidence_digest ?? '') : payload.terminal_evidence_digest !== null) {
      fail(errors, 'TERMINAL_EVIDENCE_INVALID', 'payload.terminal_evidence_digest', 'Terminal evidence is required only for terminal_observed.')
    }
  }
  if (Object.hasOwn(payload, 'observed_state') && !['reserved', 'child_registered', 'consumed', 'footprint', 'prompt'].includes(payload.observed_state)) fail(errors, 'OBSERVED_STATE_INVALID', 'payload.observed_state', 'Observed dispatch state is invalid.')
}

export function validatePhaseGateEvent(event, { head = null, manifest = null } = {}) {
  const errors = []
  if (!isObject(event) || !jsonValue(event)) {
    fail(errors, 'EVENT_BOUNDS_INVALID', 'event', 'Event must be a bounded JSON object.')
    return { valid: false, errors }
  }
  if (Buffer.byteLength(`${canonicalJson(event)}\n`, 'utf8') > PHASE_GATE_JSON_MAX_BYTES) {
    fail(errors, 'EVENT_JSON_TOO_LARGE', 'event', 'Canonical event JSON exceeds the store read bound.')
  }
  const bootstrapDispatch = event.event_type?.startsWith('dispatch_') && isBootstrapBoundary(event.boundary)
  const typeFields = bootstrapDispatch
    ? ['boundary', 'dispatch_uuid', 'acceptance_event_id']
    : EVENT_FIELDS[event.event_type] ?? []
  exactKeys(errors, event, [...BASE_FIELDS, ...typeFields], [...BASE_FIELDS, ...typeFields])
  if (event.schema !== PHASE_GATE_SCHEMA || event.schema_version !== PHASE_GATE_VERSION) fail(errors, 'SCHEMA_INVALID', 'schema', 'Incorrect phase gate schema.')
  for (const field of ['project_run_id', 'slice_id', 'phase_run_id', 'command_id', 'idempotency_key']) {
    if (!nonEmpty(event[field])) fail(errors, 'ID_REQUIRED', field, `${field} is required.`)
  }
  if (!DIGEST.test(event.manifest_digest ?? '')) fail(errors, 'MANIFEST_DIGEST_INVALID', 'manifest_digest', 'Manifest digest is required.')
  if (rfc3339Millis(event.occurred_at) === null) fail(errors, 'OCCURRED_AT_INVALID', 'occurred_at', 'occurred_at must be RFC3339.')
  if (!Number.isInteger(event.sequence) || event.sequence < 1) fail(errors, 'SEQUENCE_INVALID', 'sequence', 'Sequence must be positive integer.')
  if (event.sequence === 1 ? event.previous_event_id !== null : !DIGEST.test(event.previous_event_id ?? '')) fail(errors, 'PREVIOUS_EVENT_INVALID', 'previous_event_id', 'Previous event link is invalid.')
  if (!TYPES.has(event.event_type)) fail(errors, 'EVENT_TYPE_INVALID', 'event_type', 'Event type is closed.')
  if (!DIGEST.test(event.event_id ?? '') || event.event_id !== canonicalPhaseGateEventId(event)) fail(errors, 'EVENT_ID_INVALID', 'event_id', 'Event id must be canonical SHA-256.')
  checkActorShape(errors, event.actor)
  if (event.event_type === 'project_genesis' && event.sequence !== 1) fail(errors, 'GENESIS_FIRST_REQUIRED', 'event_type', 'Genesis must be first.')
  if (event.event_type !== 'project_genesis' && event.sequence === 1) fail(errors, 'GENESIS_REQUIRED', 'event_type', 'First event must be genesis.')
  if (event.event_type !== 'project_genesis') {
    if (!(event.event_type.startsWith('dispatch_') && isBootstrapBoundary(event.boundary))) checkBoundary(errors, event.boundary)
    else exactKeys(errors, event.boundary, ['sender_phase', 'receiver_phase'], ['sender_phase', 'receiver_phase'], 'boundary')
    if (!bootstrapDispatch) {
      if (!nonEmpty(event.attempt_id) || !nonEmpty(event.handoff_id)) fail(errors, 'ATTEMPT_ID_REQUIRED', 'attempt_id', 'Attempt and handoff ids are required after genesis.')
      if (!Number.isInteger(event.revision) || event.revision < 1) fail(errors, 'REVISION_INVALID', 'revision', 'Revision must be a positive integer.')
    }
  }
  const phaseRunPhase = event.event_type === 'project_genesis'
    ? 'Requirement'
    : event.event_type?.startsWith('dispatch_')
      ? event.boundary?.receiver_phase
      : event.boundary?.sender_phase
  if (nonEmpty(event.slice_id) && PHASE_RUN_PHASES.has(phaseRunPhase)
    && event.phase_run_id !== stablePhaseRunId(event.slice_id, phaseRunPhase)) {
    fail(errors, 'PHASE_RUN_ID_MISMATCH', 'phase_run_id', 'phase_run_id must be the stable id for this slice and governed phase.')
  }
  if (Object.hasOwn(event, 'artifact')) checkArtifact(errors, event.artifact, event.boundary)
  if (Object.hasOwn(event, 'artifact_event_id') && !DIGEST.test(event.artifact_event_id ?? '')) fail(errors, 'ARTIFACT_EVENT_ID_INVALID', 'artifact_event_id', 'Artifact event id must be SHA-256.')
  if (Object.hasOwn(event, 'dispatch_uuid') && !UUID.test(event.dispatch_uuid ?? '')) fail(errors, 'DISPATCH_UUID_INVALID', 'dispatch_uuid', 'Dispatch uuid is invalid.')
  if (Object.hasOwn(event, 'acceptance_event_id')
    && !(isBootstrapBoundary(event.boundary) && event.acceptance_event_id === null)
    && !DIGEST.test(event.acceptance_event_id ?? '')) {
    fail(errors, 'ACCEPTANCE_EVENT_ID_INVALID', 'acceptance_event_id', 'Acceptance event id is invalid.')
  }
  checkPayload(errors, event)
  if (manifest) {
    const manifestValidation = validatePhaseGateManifest(manifest)
    errors.push(...manifestValidation.errors)
    if (event.project_run_id !== manifest.project_run_id || event.slice_id !== manifest.slice_id
      || event.manifest_digest !== canonicalDigest(manifest)) {
      fail(errors, 'MANIFEST_BINDING_MISMATCH', 'manifest_digest', 'Event is not bound to this immutable manifest.')
    }
  }
  if (head && (event.sequence !== head.sequence + 1 || event.previous_event_id !== head.event_id)) fail(errors, 'HEAD_CONFLICT', 'expected_head', 'Event does not extend the expected head.')
  return { valid: errors.length === 0, errors }
}

export function createPhaseGateAggregate(manifestInput) {
  const manifest = createPhaseGateManifest(manifestInput)
  return {
    schema: 'tmux-teams.phase-gate-aggregate',
    schema_version: 1,
    manifest,
    manifest_digest: canonicalDigest(manifest),
    project_run_id: manifest.project_run_id,
    slice_id: manifest.slice_id,
    head: { sequence: 0, event_id: null },
    last_occurred_at: null,
    current_phase: null,
    terminal: false,
    events: [],
    submissions: {},
    attempts: {},
    dispatches: {},
    consumptions: {},
  }
}

function commandBody(event) {
  const value = { ...event }
  delete value.event_id
  delete value.sequence
  delete value.previous_event_id
  return value
}

function throwOne(code, path, message, errorCode = code) {
  throw new PhaseGateValidationError([{ code, path, message }], errorCode)
}

function ensureAuthorized(state, event) {
  const { actor_id: actorId, role } = event.actor
  const actors = state.manifest.actors
  const sender = event.boundary?.sender_phase
  const receiver = event.boundary?.receiver_phase
  const pm = includesActor(actors.pm, actorId)
  const senderLead = sender && includesActor(actors.phase_leads[sender], actorId)
  const receiverLead = receiver && includesActor(actors.phase_leads[receiver], actorId)
  const requireRole = (expected, authorized) => {
    if (role !== expected || !authorized) throwOne('ACTOR_UNAUTHORIZED', 'actor', 'Actor role/phase is not authorized by the frozen manifest.')
  }
  if (event.event_type === 'project_genesis' || event.event_type === 'handoff_resolve') return requireRole('pm', pm)
  if (['phase_work', 'artifact_submission', 'handoff_propose'].includes(event.event_type)) return requireRole('sender', senderLead)
  if (['handoff_accept', 'handoff_reject', 'project_delivery_accept'].includes(event.event_type)) return requireRole('receiver_phase_lead', receiverLead)
  if (event.event_type === 'handoff_escalate') {
    const authorized = (role === 'pm' && pm) || (role === 'sender' && senderLead) || (role === 'receiver_phase_lead' && receiverLead)
    if (!authorized) throwOne('ACTOR_UNAUTHORIZED', 'actor', 'Escalation actor is not authorized by the frozen manifest.')
    return
  }
  if (event.event_type === 'dispatch_resolution') return requireRole('pm', pm)
  if (event.event_type.startsWith('dispatch_')) return requireRole('receiver_phase_lead', receiverLead)
  throwOne('ACTOR_UNAUTHORIZED', 'actor', 'Event has no authorization rule.')
}

function ensureBoundaryCurrent(state, event) {
  if (state.terminal) throwOne('PROJECT_DELIVERY_TERMINAL', 'event_type', 'ProjectDelivery is terminal; no Phase 5 exists.')
  if (event.boundary.sender_phase !== state.current_phase) {
    throwOne('PHASE_ORDER_INVALID', 'boundary.sender_phase', `Current phase is ${state.current_phase}.`)
  }
}

function acceptancePayload(attempt, event) {
  const expected = {
    artifact_event_id: attempt.artifact_event_id,
    artifact_digest: attempt.artifact.digest,
    sender_phase: attempt.boundary.sender_phase,
    receiver_phase: attempt.boundary.receiver_phase,
    sender_actor_id: attempt.sender_actor_id,
    receiver_actor_id: event.actor.actor_id,
  }
  if (!same(event.payload, expected)) throwOne('ACCEPTANCE_BINDING_MISMATCH', 'payload', 'Acceptance must bind the exact slice attempt, artifact, boundary, sender, and receiver.')
}

function ensureAttemptIdentity(attempt, event) {
  if (attempt.handoff_id !== event.handoff_id || attempt.revision !== event.revision || !same(attempt.boundary, event.boundary)) {
    throwOne('ATTEMPT_BINDING_MISMATCH', 'attempt_id', 'Attempt id is already bound to a different handoff, revision, or boundary.')
  }
}

function nextRevision(state, boundary) {
  const attempts = Object.values(state.attempts).filter((attempt) => same(attempt.boundary, boundary))
  return attempts.length === 0 ? 1 : Math.max(...attempts.map((attempt) => attempt.revision)) + 1
}

function reduceOne(state, event) {
  const next = structuredClone(state)
  ensureAuthorized(next, event)
  if (event.event_type === 'project_genesis') {
    if (next.events.length !== 0 || next.current_phase !== null) throwOne('GENESIS_DUPLICATE', 'event_type', 'Genesis can occur only once.')
    next.genesis_event_id = event.event_id
    next.current_phase = 'Requirement'
    return next
  }
  const bootstrapDispatch = event.event_type.startsWith('dispatch_') && isBootstrapBoundary(event.boundary)
  const registeredDispatchLifecycle = event.event_type.startsWith('dispatch_')
    && event.event_type !== 'dispatch_reservation'
    && Boolean(next.dispatches[event.dispatch_uuid])
  if (!bootstrapDispatch && !registeredDispatchLifecycle) ensureBoundaryCurrent(next, event)
  if (event.event_type === 'phase_work') {
    if (event.boundary.sender_phase === 'Requirement' && next.requirement_bootstrap_ready !== true) {
      throwOne('REQUIREMENT_BOOTSTRAP_REQUIRED', 'event_type', 'Requirement work cannot start before its receiver dispatch reaches a successful terminal state.')
    }
    if (event.revision !== nextRevision(next, event.boundary)) throwOne('REVISION_ORDER_INVALID', 'revision', 'Phase work must use the next semantic revision.')
    return next
  }

  if (event.event_type === 'artifact_submission') {
    if (event.boundary.sender_phase === 'Requirement' && next.requirement_bootstrap_ready !== true) {
      throwOne('REQUIREMENT_BOOTSTRAP_REQUIRED', 'event_type', 'Requirement artifact cannot be submitted before bootstrap dispatch completes.')
    }
    if (next.submissions[event.attempt_id] || next.attempts[event.attempt_id]) throwOne('ATTEMPT_EXISTS', 'attempt_id', 'Attempt id already exists.')
    if (Object.values(next.submissions).some((submission) => submission.handoff_id === event.handoff_id)
      || Object.values(next.attempts).some((attempt) => attempt.handoff_id === event.handoff_id)) {
      throwOne('HANDOFF_EXISTS', 'handoff_id', 'Handoff id already exists.')
    }
    if (event.revision !== nextRevision(next, event.boundary)) throwOne('REVISION_ORDER_INVALID', 'revision', 'Artifact submission must use the next semantic revision.')
    if (Object.values(next.attempts).some((attempt) => same(attempt.boundary, event.boundary) && attempt.state !== 'rejected')) {
      throwOne('BOUNDARY_ATTEMPT_ACTIVE', 'boundary', 'Only one active or accepted attempt is allowed per boundary.')
    }
    next.submissions[event.attempt_id] = {
      handoff_id: event.handoff_id,
      revision: event.revision,
      boundary: event.boundary,
      artifact: event.artifact,
      artifact_event_id: event.event_id,
      sender_actor_id: event.actor.actor_id,
    }
    return next
  }

  if (event.event_type === 'handoff_propose') {
    const submission = next.submissions[event.attempt_id]
    if (!submission) throwOne('ARTIFACT_SUBMISSION_REQUIRED', 'attempt_id', 'An immutable artifact submission is required before proposal.')
    ensureAttemptIdentity(submission, event)
    if (event.artifact_event_id !== submission.artifact_event_id || !same(event.artifact, submission.artifact)
      || event.actor.actor_id !== submission.sender_actor_id) {
      throwOne('ARTIFACT_BINDING_MISMATCH', 'artifact_event_id', 'Proposal must bind the exact submitted artifact and sender.')
    }
    if (next.attempts[event.attempt_id]) throwOne('ATTEMPT_EXISTS', 'attempt_id', 'Attempt was already proposed.')
    next.attempts[event.attempt_id] = { ...submission, state: 'proposed', proposal_event_id: event.event_id }
    return next
  }

  if (['handoff_accept', 'handoff_reject', 'handoff_escalate', 'handoff_resolve', 'project_delivery_accept'].includes(event.event_type)) {
    const attempt = next.attempts[event.attempt_id]
    if (!attempt) throwOne('ATTEMPT_UNKNOWN', 'attempt_id', 'Attempt is unknown.')
    ensureAttemptIdentity(attempt, event)
    if (event.artifact_event_id !== attempt.artifact_event_id || !same(event.artifact, attempt.artifact)) {
      throwOne('ARTIFACT_IMMUTABLE_MISMATCH', 'artifact', 'Decision must bind the exact proposed artifact.')
    }
    if (['handoff_accept', 'handoff_reject', 'project_delivery_accept'].includes(event.event_type)
      && event.actor.actor_id === attempt.sender_actor_id) {
      throwOne('ACTOR_SELF_REVIEW_INVALID', 'actor.actor_id', 'Sender cannot accept or reject the same attempt.')
    }
    if (event.event_type === 'handoff_accept') {
      if (attempt.boundary.receiver_phase === 'ProjectDelivery') throwOne('QA_FINAL_ACCEPT_REQUIRED', 'event_type', 'QA closes only through project_delivery_accept.')
      if (attempt.state !== 'proposed') throwOne('ATTEMPT_TRANSITION_INVALID', 'event_type', 'Only a proposed attempt can be accepted.')
      acceptancePayload(attempt, event)
      next.attempts[event.attempt_id] = { ...attempt, state: 'accepted', acceptance_event_id: event.event_id, receiver_actor_id: event.actor.actor_id }
    } else if (event.event_type === 'project_delivery_accept') {
      if (attempt.boundary.sender_phase !== 'QA' || attempt.boundary.receiver_phase !== 'ProjectDelivery') throwOne('PROJECT_DELIVERY_ACCEPT_INVALID', 'boundary', 'Only QA may enter ProjectDelivery.')
      if (attempt.state !== 'proposed') throwOne('ATTEMPT_TRANSITION_INVALID', 'event_type', 'Only a proposed QA attempt can be accepted.')
      acceptancePayload(attempt, event)
      next.attempts[event.attempt_id] = { ...attempt, state: 'accepted', acceptance_event_id: event.event_id, receiver_actor_id: event.actor.actor_id }
      next.project_delivery_acceptance = event.event_id
      next.project_delivery_attempt_id = event.attempt_id
      next.current_phase = 'ProjectDelivery'
      next.terminal = true
    } else if (event.event_type === 'handoff_reject') {
      if (attempt.state !== 'proposed') throwOne('ATTEMPT_TRANSITION_INVALID', 'event_type', 'Only a proposed attempt can be rejected.')
      next.attempts[event.attempt_id] = { ...attempt, state: 'rejected', rejection_event_id: event.event_id }
    } else if (event.event_type === 'handoff_escalate') {
      if (attempt.state !== 'proposed') throwOne('ATTEMPT_TRANSITION_INVALID', 'event_type', 'Only a proposed attempt can be escalated.')
      next.attempts[event.attempt_id] = { ...attempt, state: 'escalated', escalation_event_id: event.event_id }
    } else {
      if (attempt.state !== 'escalated') throwOne('ATTEMPT_TRANSITION_INVALID', 'event_type', 'Only an escalated attempt can be resolved.')
      next.attempts[event.attempt_id] = { ...attempt, state: 'proposed', resolution_event_id: event.event_id }
    }
    return next
  }

  if (event.event_type.startsWith('dispatch_')) {
    if (bootstrapDispatch) {
      if (next.current_phase !== 'Requirement' || next.terminal || Object.keys(next.attempts).length
        || Object.keys(next.submissions).length) {
        throwOne('BOOTSTRAP_DISPATCH_INVALID', 'boundary', 'Requirement bootstrap is the only legal first receiver dispatch and occurs once before phase work.')
      }
      if (event.acceptance_event_id !== null) throwOne('BOOTSTRAP_ACCEPTANCE_FORBIDDEN', 'acceptance_event_id', 'Bootstrap must not fabricate an acceptance.')
      const existingBootstrap = next.dispatches[event.dispatch_uuid]
      if (event.event_type === 'dispatch_reservation') {
        if (existingBootstrap || next.requirement_bootstrap_dispatch_uuid) throwOne('DISPATCH_EXISTS', 'dispatch_uuid', 'Requirement bootstrap was already reserved.')
        if (!same(event.payload.expected_head, next.head) || event.payload.trust_level !== next.manifest.trust_level) {
          throwOne('DISPATCH_BINDING_MISMATCH', 'payload', 'Bootstrap must bind the exact pre-reservation head and trust level.')
        }
        next.requirement_bootstrap_dispatch_uuid = event.dispatch_uuid
        next.dispatches[event.dispatch_uuid] = {
          state: 'reserved',
          bootstrap: true,
          boundary: event.boundary,
          acceptance_event_id: null,
          phase_run_id: event.phase_run_id,
          receiver_actor_id: event.actor.actor_id,
          task_id: event.payload.task_id,
          agent_id: event.payload.agent_id,
          brief_digest: event.payload.brief_digest,
          timeout_sec: event.payload.timeout_sec,
          reservation_event_id: event.event_id,
        }
        return next
      }
      if (!existingBootstrap || next.requirement_bootstrap_dispatch_uuid !== event.dispatch_uuid
        || existingBootstrap.bootstrap !== true
        || existingBootstrap.phase_run_id !== event.phase_run_id
        || (event.event_type !== 'dispatch_resolution' && existingBootstrap.receiver_actor_id !== event.actor.actor_id)) {
        throwOne('DISPATCH_BINDING_MISMATCH', 'dispatch_uuid', 'Bootstrap lifecycle must bind the exact registered receiver dispatch.')
      }
      if (event.event_type === 'dispatch_resolution') {
        if (existingBootstrap.state !== 'indeterminate'
          || event.payload.reservation_event_id !== existingBootstrap.reservation_event_id
          || !same(event.payload.expected_head, next.head)) {
          throwOne('DISPATCH_RESOLUTION_MISMATCH', 'payload', 'Resolution must bind the exact indeterminate bootstrap dispatch, reservation, and current head.')
        }
        if (event.payload.resolution === 'terminal_observed') {
          throwOne('BOOTSTRAP_TERMINAL_RESOLUTION_FORBIDDEN', 'payload.resolution', 'Bootstrap cannot infer a successful terminal outcome from out-of-band evidence.')
        }
        const resolvedState = event.payload.resolution === 'abandoned' ? 'resolved_abandoned' : 'terminal'
        next.dispatches[event.dispatch_uuid] = {
          ...existingBootstrap,
          state: resolvedState,
          resolution_event_id: event.event_id,
          resolution_reason: event.payload.reason,
          terminal_evidence_digest: event.payload.terminal_evidence_digest,
        }
        if (resolvedState === 'resolved_abandoned') next.requirement_bootstrap_dispatch_uuid = null
        return next
      }
      if (event.event_type === 'dispatch_consumption') {
        throwOne('BOOTSTRAP_CONSUMPTION_FORBIDDEN', 'event_type', 'Requirement bootstrap does not consume a fabricated acceptance or artifact.')
      }
      if (event.event_type === 'dispatch_indeterminate') {
        if (!['reserved', 'child_registered', 'footprint', 'prompt'].includes(existingBootstrap.state)
          || event.payload.observed_state !== existingBootstrap.state) {
          throwOne('DISPATCH_TRANSITION_INVALID', 'payload.observed_state', 'Indeterminate must bind the exact ambiguous bootstrap state.')
        }
        next.dispatches[event.dispatch_uuid] = {
          ...existingBootstrap,
          state: 'indeterminate',
          indeterminate_from: existingBootstrap.state,
          indeterminate_event_id: event.event_id,
        }
        return next
      }
      const bootstrapTransitions = {
        dispatch_child_registered: ['reserved', 'child_registered'],
        dispatch_footprint: ['child_registered', 'footprint'],
        dispatch_prompt: ['footprint', 'prompt'],
        dispatch_terminal: ['prompt', 'terminal'],
      }
      const bootstrapTransition = bootstrapTransitions[event.event_type]
      if (!bootstrapTransition || existingBootstrap.state !== bootstrapTransition[0]) {
        throwOne('DISPATCH_TRANSITION_INVALID', 'dispatch_uuid', `Cannot ${event.event_type} from ${existingBootstrap.state}.`)
      }
      if (event.event_type === 'dispatch_child_registered'
        && event.payload.reservation_event_id !== existingBootstrap.reservation_event_id) {
        throwOne('RESERVATION_EVENT_MISMATCH', 'payload.reservation_event_id', 'Child registration must bind the exact reservation event.')
      }
      const additions = event.event_type === 'dispatch_child_registered'
        ? {
            reservation_event_id: event.payload.reservation_event_id,
            pid: event.payload.pid,
            ppid: event.payload.ppid,
            process_start: event.payload.process_start,
            child_identity_digest: event.payload.child_identity_digest,
          }
        : event.event_type === 'dispatch_footprint'
          ? { footprint_digest: event.payload.footprint_digest }
          : {}
      next.dispatches[event.dispatch_uuid] = {
        ...existingBootstrap,
        ...additions,
        state: bootstrapTransition[1],
        [`${bootstrapTransition[1]}_event_id`]: event.event_id,
      }
      if (event.event_type === 'dispatch_terminal' && event.payload.outcome === 'success') next.requirement_bootstrap_ready = true
      return next
    }
    const attempt = next.attempts[event.attempt_id]
    if (!attempt || attempt.state !== 'accepted' || attempt.boundary.receiver_phase === 'ProjectDelivery') {
      throwOne('DISPATCH_NOT_ELIGIBLE', 'attempt_id', 'Only an accepted non-final boundary can dispatch.')
    }
    if (event.acceptance_event_id !== attempt.acceptance_event_id
      || (event.event_type !== 'dispatch_resolution' && event.actor.actor_id !== attempt.receiver_actor_id)) {
      throwOne('DISPATCH_ACCEPTANCE_MISMATCH', 'acceptance_event_id', 'Dispatch must be registered by the accepting receiver against the exact acceptance.')
    }
    const existing = next.dispatches[event.dispatch_uuid]
    if (event.event_type === 'dispatch_reservation') {
      if (existing) throwOne('DISPATCH_EXISTS', 'dispatch_uuid', 'Dispatch UUID is already reserved.')
      if (!isDispatchEligible(next, event.attempt_id)) throwOne('DISPATCH_NOT_ELIGIBLE', 'attempt_id', 'Acceptance is already consumed, active, or indeterminate.')
      if (event.artifact_event_id !== attempt.artifact_event_id
        || event.payload.artifact_event_id !== attempt.artifact_event_id
        || event.payload.artifact_digest !== attempt.artifact.digest
        || event.payload.trust_level !== next.manifest.trust_level
        || !same(event.payload.expected_head, next.head)) {
        throwOne('DISPATCH_BINDING_MISMATCH', 'payload', 'Reservation must bind the acceptance digest, trust, and exact pre-reservation head.')
      }
      next.dispatches[event.dispatch_uuid] = {
        state: 'reserved',
        attempt_id: event.attempt_id,
        handoff_id: event.handoff_id,
        revision: event.revision,
        boundary: event.boundary,
        acceptance_event_id: event.acceptance_event_id,
        phase_run_id: event.phase_run_id,
        artifact_event_id: attempt.artifact_event_id,
        artifact_digest: attempt.artifact.digest,
        receiver_actor_id: event.actor.actor_id,
        task_id: event.payload.task_id,
        agent_id: event.payload.agent_id,
        brief_digest: event.payload.brief_digest,
        timeout_sec: event.payload.timeout_sec,
        reservation_event_id: event.event_id,
      }
      return next
    }
    if (!existing || existing.attempt_id !== event.attempt_id
      || existing.handoff_id !== event.handoff_id
      || existing.revision !== event.revision
      || existing.phase_run_id !== event.phase_run_id
      || existing.acceptance_event_id !== event.acceptance_event_id
      || (event.event_type !== 'dispatch_resolution' && existing.receiver_actor_id !== event.actor.actor_id)
      || !same(existing.boundary, event.boundary)) {
      throwOne('DISPATCH_BINDING_MISMATCH', 'dispatch_uuid', 'Dispatch event does not match its immutable reservation.')
    }
    if (event.event_type === 'dispatch_resolution') {
      if (existing.state !== 'indeterminate'
        || event.payload.reservation_event_id !== existing.reservation_event_id
        || !same(event.payload.expected_head, next.head)) {
        throwOne('DISPATCH_RESOLUTION_MISMATCH', 'payload', 'Resolution must bind the exact indeterminate dispatch, reservation, and current head.')
      }
      const recordedConsumption = next.consumptions[event.acceptance_event_id]
      if (event.payload.resolution === 'terminal_observed'
        && recordedConsumption?.dispatch_uuid !== event.dispatch_uuid) {
        throwOne('DISPATCH_RESOLUTION_REQUIRES_CONSUMPTION', 'payload.resolution', 'terminal_observed requires the exact receiver consumption to be recorded first.')
      }
      next.dispatches[event.dispatch_uuid] = {
        ...existing,
        state: event.payload.resolution === 'abandoned' ? 'resolved_abandoned' : 'terminal',
        resolution_event_id: event.event_id,
        resolution_reason: event.payload.reason,
        terminal_evidence_digest: event.payload.terminal_evidence_digest,
      }
      return next
    }
    if (event.event_type === 'dispatch_indeterminate') {
      if (!['reserved', 'child_registered', 'consumed', 'footprint', 'prompt'].includes(existing.state)
        || event.payload.observed_state !== existing.state) {
        throwOne('DISPATCH_TRANSITION_INVALID', 'payload.observed_state', 'Indeterminate is allowed only from the exact ambiguous nonterminal state.')
      }
      next.dispatches[event.dispatch_uuid] = {
        ...existing,
        state: 'indeterminate',
        indeterminate_from: existing.state,
        indeterminate_event_id: event.event_id,
      }
      return next
    }
    const transitions = {
      dispatch_child_registered: ['reserved', 'child_registered'],
      dispatch_consumption: ['child_registered', 'consumed'],
      dispatch_footprint: ['consumed', 'footprint'],
      dispatch_prompt: ['footprint', 'prompt'],
      dispatch_terminal: ['prompt', 'terminal'],
    }
    const transition = transitions[event.event_type]
    if (!transition || existing.state !== transition[0]) throwOne('DISPATCH_TRANSITION_INVALID', 'dispatch_uuid', `Cannot ${event.event_type} from ${existing.state}.`)
    if (event.event_type === 'dispatch_consumption') {
      if (event.artifact_event_id !== attempt.artifact_event_id
        || event.payload.artifact_event_id !== attempt.artifact_event_id
        || event.payload.artifact_digest !== attempt.artifact.digest
        || next.consumptions[event.acceptance_event_id]) {
        throwOne('CONSUMPTION_BINDING_MISMATCH', 'payload', 'Consumption must bind the exact accepted artifact once.')
      }
      next.consumptions[event.acceptance_event_id] = {
        dispatch_uuid: event.dispatch_uuid,
        event_id: event.event_id,
        attempt_id: event.attempt_id,
        artifact_event_id: attempt.artifact_event_id,
        artifact_digest: attempt.artifact.digest,
      }
      next.current_phase = attempt.boundary.receiver_phase
    }
    const additions = event.event_type === 'dispatch_child_registered'
      ? {
          reservation_event_id: event.payload.reservation_event_id,
          pid: event.payload.pid,
          ppid: event.payload.ppid,
          process_start: event.payload.process_start,
          child_identity_digest: event.payload.child_identity_digest,
        }
      : event.event_type === 'dispatch_footprint'
        ? { footprint_digest: event.payload.footprint_digest }
        : {}
    next.dispatches[event.dispatch_uuid] = { ...existing, ...additions, state: transition[1], [`${transition[1]}_event_id`]: event.event_id }
    return next
  }

  throwOne('EVENT_TYPE_INVALID', 'event_type', 'Event is not in the reducer.')
}

function preparedCommand(aggregate, input) {
  return {
    ...input,
    schema: PHASE_GATE_SCHEMA,
    schema_version: PHASE_GATE_VERSION,
    manifest_digest: aggregate.manifest_digest,
  }
}

export function replayPhaseGateEvents(aggregateInput, events = aggregateInput?.events ?? []) {
  if (!aggregateInput || !Array.isArray(events)) throwOne('AGGREGATE_INVALID', 'aggregate', 'Aggregate and events required.')
  let state = createPhaseGateAggregate(aggregateInput.manifest ?? aggregateInput)
  for (const event of events) {
    const validation = validatePhaseGateEvent(event, { head: state.head, manifest: state.manifest })
    if (!validation.valid) throw new PhaseGateValidationError(validation.errors)
    if (state.last_occurred_at !== null && rfc3339Millis(event.occurred_at) < rfc3339Millis(state.last_occurred_at)) {
      throwOne('EVENT_TIME_ORDER_INVALID', 'occurred_at', 'Event times must be non-decreasing.')
    }
    state = reduceOne(state, event)
    state.events.push(event)
    state.head = { sequence: event.sequence, event_id: event.event_id }
    state.last_occurred_at = event.occurred_at
  }
  return state
}

export function appendPhaseGateEvent(aggregate, input, { expected_head = aggregate?.head } = {}) {
  if (!aggregate?.head || !aggregate?.manifest) throwOne('AGGREGATE_INVALID', 'aggregate', 'A manifest-bound aggregate is required.')
  const commandCandidate = preparedCommand(aggregate, input)
  const existing = aggregate.events.find((record) => record.command_id === commandCandidate.command_id
    || record.idempotency_key === commandCandidate.idempotency_key)
  if (existing) {
    if (same(commandBody(existing), commandBody(commandCandidate))) {
      return { aggregate, event: existing, appended: false, idempotent: true }
    }
    throwOne('IDEMPOTENCY_CONFLICT', 'command_id', 'Command identity is already bound to different content.', 'IDEMPOTENCY_CONFLICT')
  }
  if (!same(expected_head, aggregate.head)) throwOne('HEAD_CONFLICT', 'expected_head', 'Expected head does not match.', 'HEAD_CONFLICT')
  const event = {
    ...commandCandidate,
    sequence: aggregate.head.sequence + 1,
    previous_event_id: aggregate.head.event_id,
  }
  event.event_id = canonicalPhaseGateEventId(event)
  const validation = validatePhaseGateEvent(event, { head: aggregate.head, manifest: aggregate.manifest })
  if (!validation.valid) throw new PhaseGateValidationError(validation.errors)
  if (aggregate.last_occurred_at !== null && rfc3339Millis(event.occurred_at) < rfc3339Millis(aggregate.last_occurred_at)) {
    throwOne('EVENT_TIME_ORDER_INVALID', 'occurred_at', 'Event times must be non-decreasing.')
  }
  const reduced = reduceOne(aggregate, event)
  reduced.events = [...aggregate.events, event]
  reduced.head = { sequence: event.sequence, event_id: event.event_id }
  reduced.last_occurred_at = event.occurred_at
  return { aggregate: reduced, event, appended: true, idempotent: false }
}

export function isDispatchEligible(state, attemptId) {
  const attempt = state?.attempts?.[attemptId]
  if (!attempt || attempt.state !== 'accepted' || attempt.boundary.receiver_phase === 'ProjectDelivery'
    || !attempt.acceptance_event_id || state.consumptions?.[attempt.acceptance_event_id]) return false
  return !Object.values(state.dispatches ?? {}).some((dispatch) => (
    dispatch.attempt_id === attemptId && dispatch.state !== 'resolved_abandoned'
  ))
}
export const dispatchEligibility = isDispatchEligible

export function isPhaseCompleted(state, attemptId) {
  const attempt = state?.attempts?.[attemptId]
  if (!attempt || attempt.state !== 'accepted') return false
  if (attempt.boundary.receiver_phase === 'ProjectDelivery') {
    return state.project_delivery_attempt_id === attemptId && state.terminal === true
  }
  return Boolean(attempt.acceptance_event_id && state.consumptions?.[attempt.acceptance_event_id])
}

export const isProjectDeliveryFinal = (state) => Boolean(
  state?.terminal
  && state?.current_phase === 'ProjectDelivery'
  && state?.project_delivery_acceptance,
)
