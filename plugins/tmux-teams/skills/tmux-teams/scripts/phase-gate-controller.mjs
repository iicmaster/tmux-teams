#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalDigest } from './delivery-loop-core.mjs'
import {
  PHASE_GATE_TRUST_LEVEL,
  REQUIREMENT_BOOTSTRAP_BOUNDARY,
  stablePhaseRunId,
  verifyArtifactBytes,
} from './phase-gate-core.mjs'
import { appendPhaseGateEventAtomic, initializePhaseGateStore, inspectPhaseGateLock, manualReconcilePhaseGateLock, manualReconcilePhaseGateStore, readPhaseGateStore } from './phase-gate-store.mjs'
import { PHASE_GATE_MARKER, readPhaseGateMarker } from './phase-gate-companion-guard.mjs'
import { buildPhaseGateRuntimeProjection } from './phase-gate-runtime-projection.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, 'acp-companion.mjs')
const shaBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const controllerError = (code, message) => Object.assign(new Error(message), { name: 'PhaseGateControllerError', code })
const actor = (actor_id, role) => ({ actor_id, role, trust: PHASE_GATE_TRUST_LEVEL })
const readBoundedJson = (path, max = 1024 * 1024) => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw controllerError('INPUT_FILE_INVALID', `${path} must be a bounded non-symlink file`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { throw controllerError('INPUT_JSON_INVALID', `${path} is malformed JSON`) }
}
function markerFor(repoRoot) { return readPhaseGateMarker(resolve(repoRoot)).marker }
function stableRun(sliceId, event) {
  const phase = event.event_type === 'project_genesis' ? 'Requirement'
    : event.event_type?.startsWith('dispatch_') ? event.boundary?.receiver_phase
      : event.boundary?.sender_phase
  return stablePhaseRunId(sliceId, phase)
}
function appendDerived(marker, event) {
  const snapshot = readPhaseGateStore(marker.store_dir)
  const phase_run_id = stableRun(snapshot.manifest.slice_id, event)
  if (event.phase_run_id && event.phase_run_id !== phase_run_id) throw controllerError('PHASE_RUN_ID_MISMATCH', 'phase_run_id must be stable for this slice and phase')
  const command = {
    ...event,
    project_run_id: snapshot.manifest.project_run_id,
    slice_id: snapshot.manifest.slice_id,
    phase_run_id,
    occurred_at: event.occurred_at ?? new Date().toISOString(),
  }
  return appendPhaseGateEventAtomic(marker.store_dir, command, { expected_head: snapshot.aggregate.head })
}
function writeMarker(repoRoot, marker) {
  const stateDir = join(repoRoot, '.tmux-teams')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (lstatSync(stateDir).isSymbolicLink()) throw controllerError('STATE_DIR_INVALID', '.tmux-teams cannot be a symlink')
  const path = join(repoRoot, PHASE_GATE_MARKER)
  if (existsSync(path)) throw controllerError('PHASE_GATE_MARKER_EXISTS', 'governed marker already exists')
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(marker)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  const parentFd = openSync(stateDir, 'r'); try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
}

export function initializePhaseGateController(repoRoot, input) {
  const repo = resolve(repoRoot)
  if (!isAbsolute(repo) || repo === '/' || !lstatSync(repo).isDirectory() || lstatSync(repo).isSymbolicLink()) throw controllerError('REPO_ROOT_INVALID', 'repo root must be an existing absolute non-symlink directory')
  const store_dir = resolve(input.store_dir ?? join(repo, '.tmux-teams', 'phase-gate-store'))
  const manifestInput = { ...input, repo_root: repo }
  delete manifestInput.store_dir; delete manifestInput.pm_actor_id; delete manifestInput.occurred_at
  const initialized = initializePhaseGateStore(store_dir, manifestInput)
  const marker = {
    schema: 'tmux-teams.phase-gate-marker', schema_version: 1, store_dir,
    project_run_id: initialized.manifest.project_run_id, slice_id: initialized.manifest.slice_id,
    repo_root: repo, manifest_digest: canonicalDigest(initialized.manifest),
  }
  writeMarker(repo, marker)
  const pm = input.pm_actor_id ?? initialized.manifest.actors.pm[0]
  const genesis = appendDerived(marker, {
    actor: actor(pm, 'pm'), command_id: 'controller:project-genesis', idempotency_key: 'controller:project-genesis',
    event_type: 'project_genesis', payload: { initial_phase: 'Requirement' }, occurred_at: input.occurred_at,
  })
  return { marker, manifest: initialized.manifest, aggregate: genesis.aggregate }
}

export function appendPhaseGateCommand(repoRoot, event, { artifact_file = null } = {}) {
  const marker = markerFor(repoRoot)
  if (event.event_type === 'artifact_submission') {
    if (!artifact_file) throw controllerError('ARTIFACT_FILE_REQUIRED', 'artifact_submission requires artifact_file')
    const stat = lstatSync(artifact_file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw controllerError('ARTIFACT_FILE_INVALID', 'artifact file must be bounded and non-symlink')
    const bytes = readFileSync(artifact_file)
    if (!verifyArtifactBytes(event.artifact, bytes)) throw controllerError('ARTIFACT_DIGEST_MISMATCH', 'artifact bytes do not match the declared digest')
  }
  return appendDerived(marker, event)
}

export function reservePhaseGateDispatch(repoRoot, input, { uuid = randomUUID() } = {}) {
  const marker = markerFor(repoRoot); const snapshot = readPhaseGateStore(marker.store_dir)
  let boundary, acceptance_event_id, dispatchActor, attempt = null
  if (input.bootstrap === true) {
    boundary = REQUIREMENT_BOOTSTRAP_BOUNDARY; acceptance_event_id = null
    dispatchActor = input.actor_id ?? snapshot.manifest.actors.phase_leads.Requirement[0]
  } else {
    if (!/^sha256:[0-9a-f]{64}$/.test(input.acceptance_event_id ?? '')) throw controllerError('ACCEPTANCE_EVENT_ID_REQUIRED', 'dispatch requires an exact acceptance_event_id')
    attempt = Object.values(snapshot.aggregate.attempts).find((row) => row.acceptance_event_id === input.acceptance_event_id)
    if (!attempt) throw controllerError('ACCEPTANCE_NOT_FOUND', 'acceptance is not present in the governed ledger')
    if (attempt.boundary.receiver_phase === 'ProjectDelivery') throw controllerError('PROJECT_DELIVERY_NO_DISPATCH', 'QA to ProjectDelivery is a terminal receiver acceptance and has no phase dispatch')
    boundary = attempt.boundary; acceptance_event_id = attempt.acceptance_event_id; dispatchActor = attempt.receiver_actor_id
  }
  const task_id = input.task_id; const agent_id = input.agent_id; const timeout_sec = Number(input.timeout_sec ?? 600)
  const briefStat = lstatSync(input.brief_file)
  if (!briefStat.isFile() || briefStat.isSymbolicLink() || briefStat.size > 1024 * 1024) throw controllerError('BRIEF_FILE_INVALID', 'brief must be a bounded non-symlink file')
  const brief_digest = shaBytes(readFileSync(input.brief_file))
  const event = {
    boundary, dispatch_uuid: uuid, acceptance_event_id,
    actor: actor(dispatchActor, 'receiver_phase_lead'),
    command_id: `controller:dispatch-reservation:${uuid}`, idempotency_key: `controller:dispatch-reservation:${uuid}`,
    event_type: 'dispatch_reservation',
    payload: input.bootstrap === true ? {
      bootstrap: true, task_id, agent_id, brief_digest, expected_head: snapshot.aggregate.head,
      trust_level: PHASE_GATE_TRUST_LEVEL, timeout_sec,
    } : {
      artifact_event_id: attempt.artifact_event_id, artifact_digest: attempt.artifact.digest,
      task_id, agent_id, brief_digest, expected_head: snapshot.aggregate.head,
      trust_level: PHASE_GATE_TRUST_LEVEL, timeout_sec,
    },
  }
  if (attempt) Object.assign(event, {
    attempt_id: Object.entries(snapshot.aggregate.attempts).find(([, row]) => row === attempt)?.[0]
      ?? Object.keys(snapshot.aggregate.attempts).find((key) => snapshot.aggregate.attempts[key].acceptance_event_id === acceptance_event_id),
    handoff_id: attempt.handoff_id, revision: attempt.revision, artifact_event_id: attempt.artifact_event_id,
  })
  const reservation = appendDerived(marker, event)
  return { marker, reservation, dispatch_uuid: uuid, task_id, agent_id, timeout_sec, brief_digest, phase: boundary.receiver_phase, brief_file: input.brief_file }
}

export function dispatchPhaseGateCompanion(repoRoot, input, { uuid, spawn_impl = spawn } = {}) {
  const reserved = reservePhaseGateDispatch(repoRoot, input, { uuid })
  const env = {
    ...process.env, ACP_KMS_AUTO: '0', TMUX_TEAMS_PHASE_GATE: '1',
    TMUX_TEAMS_GATE_STORE: reserved.marker.store_dir,
    TMUX_TEAMS_GATE_DISPATCH_UUID: reserved.dispatch_uuid,
    TMUX_TEAMS_GATE_RESERVATION_EVENT_ID: reserved.reservation.event.event_id,
    TMUX_TEAMS_GATE_PHASE: reserved.phase,
    TMUX_TEAMS_GATE_TASK_ID: reserved.task_id,
    TMUX_TEAMS_GATE_AGENT_ID: reserved.agent_id,
    TMUX_TEAMS_GATE_BRIEF_DIGEST: reserved.brief_digest,
    TMUX_TEAMS_GATE_TIMEOUT_SEC: String(reserved.timeout_sec),
    TMUX_TEAMS_PHASE: reserved.phase,
  }
  const child = spawn_impl(process.execPath, [COMPANION, reserved.agent_id, resolve(repoRoot), reserved.task_id, reserved.brief_file, String(reserved.timeout_sec)], {
    cwd: resolve(repoRoot), env, stdio: 'inherit', detached: false,
  })
  return { ...reserved, child, env }
}

export function reconcilePhaseGateDispatch(repoRoot, input) {
  const marker = markerFor(repoRoot); const snapshot = readPhaseGateStore(marker.store_dir)
  const dispatch = snapshot.aggregate.dispatches[input.dispatch_uuid]
  if (!dispatch) throw controllerError('DISPATCH_NOT_FOUND', 'dispatch does not exist')
  if (!['reserved', 'child_registered', 'consumed', 'footprint', 'prompt'].includes(dispatch.state)) throw controllerError('DISPATCH_NOT_AMBIGUOUS', 'dispatch is not in an ambiguous state')
  const event = {
    boundary: dispatch.boundary, dispatch_uuid: input.dispatch_uuid, acceptance_event_id: dispatch.acceptance_event_id,
    actor: actor(dispatch.receiver_actor_id, 'receiver_phase_lead'),
    command_id: input.command_id ?? `controller:dispatch-indeterminate:${input.dispatch_uuid}`,
    idempotency_key: input.idempotency_key ?? `controller:dispatch-indeterminate:${input.dispatch_uuid}`,
    event_type: 'dispatch_indeterminate', payload: { reason: input.reason, observed_state: dispatch.state },
  }
  if (dispatch.attempt_id) Object.assign(event, { attempt_id: dispatch.attempt_id, handoff_id: dispatch.handoff_id, revision: dispatch.revision })
  return appendDerived(marker, event)
}

export function resolvePhaseGateDispatch(repoRoot, input) {
  const marker = markerFor(repoRoot); const snapshot = readPhaseGateStore(marker.store_dir); const dispatch = snapshot.aggregate.dispatches[input.dispatch_uuid]
  if (!dispatch) throw controllerError('DISPATCH_NOT_FOUND', 'dispatch does not exist')
  const event = {
    boundary: dispatch.boundary, dispatch_uuid: input.dispatch_uuid, acceptance_event_id: dispatch.acceptance_event_id,
    actor: actor(input.actor_id, 'pm'), command_id: input.command_id ?? `controller:dispatch-resolution:${input.dispatch_uuid}`,
    idempotency_key: input.idempotency_key ?? `controller:dispatch-resolution:${input.dispatch_uuid}`,
    event_type: 'dispatch_resolution', payload: {
      resolution: input.resolution, reason: input.reason, expected_head: snapshot.aggregate.head,
      reservation_event_id: dispatch.reservation_event_id,
      terminal_evidence_digest: input.resolution === 'terminal_observed' ? input.terminal_evidence_digest : null,
    },
  }
  if (dispatch.attempt_id) Object.assign(event, { attempt_id: dispatch.attempt_id, handoff_id: dispatch.handoff_id, revision: dispatch.revision })
  return appendDerived(marker, event)
}

export function phaseGateStatus(repoRoot, options) {
  const marker = markerFor(repoRoot); const snapshot = readPhaseGateStore(marker.store_dir)
  return { marker, manifest: snapshot.manifest, head: snapshot.head, aggregate: snapshot.aggregate, projection: buildPhaseGateRuntimeProjection(snapshot.aggregate, options) }
}
export const projectPhaseGateStatus = (repoRoot, options) => phaseGateStatus(repoRoot, options).projection
export function reconcilePhaseGateStorage(repoRoot, input) {
  const marker = markerFor(repoRoot)
  return input.observed_lock
    ? manualReconcilePhaseGateLock(marker.store_dir, input)
    : manualReconcilePhaseGateStore(marker.store_dir, input)
}

async function main(argv) {
  const [command, repo, jsonFile, artifactFile] = argv
  if (!command || !repo) throw controllerError('USAGE', 'usage: phase-gate-controller.mjs <init|append|dispatch|reconcile|resolve|status|projection> <repo> [json-file] [artifact-file]')
  const input = jsonFile ? readBoundedJson(jsonFile) : {}
  const result = command === 'init' ? initializePhaseGateController(repo, input)
    : command === 'append' ? appendPhaseGateCommand(repo, input, { artifact_file: artifactFile })
      : command === 'dispatch' ? dispatchPhaseGateCompanion(repo, input)
        : command === 'reconcile' ? reconcilePhaseGateDispatch(repo, input)
          : command === 'resolve' ? resolvePhaseGateDispatch(repo, input)
            : command === 'status' ? phaseGateStatus(repo)
              : command === 'projection' ? projectPhaseGateStatus(repo)
                : command === 'storage-reconcile' ? reconcilePhaseGateStorage(repo, input)
                  : (() => { throw controllerError('USAGE', `unknown command ${command}`) })()
  process.stdout.write(`${JSON.stringify(result, (_key, value) => _key === 'child' ? undefined : value)}\n`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((cause) => { process.stderr.write(`${JSON.stringify({ error: cause.code ?? 'PHASE_GATE_CONTROLLER_FAILED', message: cause.message })}\n`); process.exitCode = 1 })
}
