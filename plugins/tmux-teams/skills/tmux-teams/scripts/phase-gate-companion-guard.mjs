import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { canonicalDigest, canonicalJson } from './delivery-loop-core.mjs'
import { PHASE_GATE_TRUST_LEVEL, stablePhaseRunId } from './phase-gate-core.mjs'
import { appendPhaseGateEventAtomic, readPhaseGateStore } from './phase-gate-store.mjs'

export const PHASE_GATE_MARKER = '.tmux-teams/phase-gate.json'
const GATE_ENV = [
  'TMUX_TEAMS_PHASE_GATE', 'TMUX_TEAMS_GATE_STORE', 'TMUX_TEAMS_GATE_DISPATCH_UUID',
  'TMUX_TEAMS_GATE_RESERVATION_EVENT_ID', 'TMUX_TEAMS_GATE_PHASE',
  'TMUX_TEAMS_GATE_TASK_ID', 'TMUX_TEAMS_GATE_AGENT_ID',
  'TMUX_TEAMS_GATE_BRIEF_DIGEST', 'TMUX_TEAMS_GATE_TIMEOUT_SEC',
]
const MARKER_KEYS = ['schema', 'schema_version', 'store_dir', 'project_run_id', 'slice_id', 'repo_root', 'manifest_digest']
const gateError = (code, message) => Object.assign(new Error(message), { name: 'PhaseGateGuardError', code })
const shaBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const processStart = (pid) => {
  try { const value = readFileSync(`/proc/${pid}/stat`, 'utf8'); return value.slice(value.lastIndexOf(')') + 2).split(' ')[19] ?? null } catch { return null }
}

export function readPhaseGateMarker(repoRoot) {
  const markerPath = join(repoRoot, PHASE_GATE_MARKER)
  const stat = lstatSync(markerPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw gateError('PHASE_GATE_MARKER_INVALID', 'phase gate marker must be a bounded non-symlink file')
  let marker
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { throw gateError('PHASE_GATE_MARKER_INVALID', 'phase gate marker is malformed') }
  if (!exact(marker, MARKER_KEYS) || marker.schema !== 'tmux-teams.phase-gate-marker' || marker.schema_version !== 1
    || !isAbsolute(marker.store_dir) || resolve(marker.repo_root) !== resolve(repoRoot)
    || !/^sha256:[0-9a-f]{64}$/.test(marker.manifest_digest)) {
    throw gateError('PHASE_GATE_MARKER_INVALID', 'phase gate marker does not match its closed contract')
  }
  return { marker, markerPath }
}

function appendObserved(context, event_type, payload) {
  const snapshot = readPhaseGateStore(context.marker.store_dir)
  const dispatch = snapshot.aggregate.dispatches[context.dispatch_uuid]
  if (!dispatch) throw gateError('PHASE_GATE_RESERVATION_MISSING', 'dispatch reservation disappeared')
  const bootstrap = dispatch.boundary.sender_phase === 'ProjectBootstrap'
  const event = {
    project_run_id: snapshot.manifest.project_run_id,
    slice_id: snapshot.manifest.slice_id,
    phase_run_id: stablePhaseRunId(snapshot.manifest.slice_id, dispatch.boundary.receiver_phase),
    occurred_at: new Date().toISOString(),
    boundary: dispatch.boundary,
    dispatch_uuid: context.dispatch_uuid,
    acceptance_event_id: dispatch.acceptance_event_id,
    actor: { actor_id: dispatch.receiver_actor_id, role: 'receiver_phase_lead', trust: PHASE_GATE_TRUST_LEVEL },
    command_id: `companion:${context.dispatch_uuid}:${event_type}`,
    idempotency_key: `companion:${context.dispatch_uuid}:${event_type}`,
    event_type,
    payload,
  }
  if (!bootstrap) Object.assign(event, {
    attempt_id: dispatch.attempt_id, handoff_id: dispatch.handoff_id,
    revision: dispatch.revision,
  })
  if (event_type === 'dispatch_consumption') event.artifact_event_id = dispatch.artifact_event_id
  return appendPhaseGateEventAtomic(context.marker.store_dir, event, { expected_head: snapshot.aggregate.head })
}

export function validateCompanionGovernance({ repoRoot, taskId, agentName, briefFile, timeoutSec, env = process.env }) {
  const markerPath = join(repoRoot, PHASE_GATE_MARKER)
  const markerPresent = existsSync(markerPath)
  const envPresent = GATE_ENV.some((key) => env[key] !== undefined)
  if (!markerPresent && !envPresent) return null
  if (!markerPresent) throw gateError('PHASE_GATE_MARKER_REQUIRED', 'gate environment cannot be used without a governed marker')
  const { marker } = readPhaseGateMarker(repoRoot)
  if (env.TMUX_TEAMS_PHASE_GATE !== '1') throw gateError('PHASE_GATE_ENV_REQUIRED', 'governed repository requires controller gate environment')
  const snapshot = readPhaseGateStore(marker.store_dir)
  if (canonicalDigest(snapshot.manifest) !== marker.manifest_digest
    || snapshot.manifest.project_run_id !== marker.project_run_id
    || snapshot.manifest.slice_id !== marker.slice_id
    || resolve(snapshot.manifest.repo_root) !== resolve(repoRoot)) {
    throw gateError('PHASE_GATE_MARKER_MISMATCH', 'marker does not bind the immutable gate store and repository')
  }
  const uuid = env.TMUX_TEAMS_GATE_DISPATCH_UUID
  const dispatch = snapshot.aggregate.dispatches[uuid]
  if (!dispatch || dispatch.state !== 'reserved') throw gateError('PHASE_GATE_RESERVATION_INVALID', 'dispatch UUID is not an unclaimed reservation')
  const phase = dispatch.boundary.receiver_phase
  const timeout = Number(timeoutSec)
  const briefStat = lstatSync(briefFile)
  if (!briefStat.isFile() || briefStat.isSymbolicLink() || briefStat.size > 1024 * 1024) throw gateError('PHASE_GATE_BRIEF_INVALID', 'brief must be a bounded non-symlink file')
  const briefDigest = shaBytes(readFileSync(briefFile))
  const expected = {
    TMUX_TEAMS_GATE_STORE: marker.store_dir,
    TMUX_TEAMS_GATE_DISPATCH_UUID: uuid,
    TMUX_TEAMS_GATE_RESERVATION_EVENT_ID: dispatch.reservation_event_id,
    TMUX_TEAMS_GATE_PHASE: phase,
    TMUX_TEAMS_GATE_TASK_ID: taskId,
    TMUX_TEAMS_GATE_AGENT_ID: agentName,
    TMUX_TEAMS_GATE_BRIEF_DIGEST: briefDigest,
    TMUX_TEAMS_GATE_TIMEOUT_SEC: String(timeout),
  }
  for (const [key, value] of Object.entries(expected)) if (env[key] !== value) throw gateError('PHASE_GATE_ENV_MISMATCH', `${key} does not match the immutable reservation`)
  if (dispatch.task_id !== taskId || dispatch.agent_id !== agentName || dispatch.brief_digest !== briefDigest
    || dispatch.timeout_sec !== timeout || env.ACP_KMS_AUTO !== '0') {
    throw gateError('PHASE_GATE_RESERVATION_MISMATCH', 'companion arguments do not match the immutable reservation')
  }
  const context = { marker, dispatch_uuid: uuid, brief_digest: briefDigest, phase }
  return {
    ...context,
    registerChild(pid) {
      const identity = { pid, ppid: process.pid, process_start: processStart(pid) ?? 'unavailable' }
      const result = appendObserved(context, 'dispatch_child_registered', {
        reservation_event_id: dispatch.reservation_event_id,
        ...identity,
        child_identity_digest: canonicalDigest(identity),
      })
      if (dispatch.boundary.sender_phase !== 'ProjectBootstrap') appendObserved(context, 'dispatch_consumption', {
        artifact_event_id: dispatch.artifact_event_id,
        artifact_digest: dispatch.artifact_digest,
      })
      return result
    },
    recordFootprint(body) { return appendObserved(context, 'dispatch_footprint', { footprint_digest: shaBytes(Buffer.from(body)) }) },
    recordPrompt(body) { return appendObserved(context, 'dispatch_prompt', { prompt_digest: shaBytes(Buffer.from(body)) }) },
    recordTerminal(outcome, evidence) { return appendObserved(context, 'dispatch_terminal', { outcome, evidence_digest: canonicalDigest(evidence) }) },
    markIndeterminate(reason) {
      const state = readPhaseGateStore(marker.store_dir).aggregate.dispatches[uuid]?.state
      if (!['reserved', 'child_registered', 'consumed', 'footprint', 'prompt'].includes(state)) return null
      return appendObserved(context, 'dispatch_indeterminate', { reason, observed_state: state })
    },
  }
}

export const guardPhaseGateCompanion = validateCompanionGovernance
