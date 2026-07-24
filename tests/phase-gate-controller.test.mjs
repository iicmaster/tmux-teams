import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  dispatchPhaseGateCompanion,
  appendPhaseGateCommand,
  initializePhaseGateController,
  phaseGateStatus,
  reconcilePhaseGateDispatch,
  reservePhaseGateDispatch,
  resolvePhaseGateDispatch,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-controller.mjs'
import { validateCompanionGovernance } from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-companion-guard.mjs'
import { stablePhaseRunId } from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-core.mjs'
import { sanitizeDeliveryRuntimeProjection } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROCESS_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phase-gate-controller-process-driver.mjs')
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const actors = {
  pm: ['pm-1'],
  phase_leads: {
    Requirement: ['requirement-lead'], Prototype: ['prototype-lead'],
    Development: ['development-lead'], QA: ['qa-lead'], ProjectDelivery: ['delivery-lead'],
  },
}
function governedRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'phase-gate-controller-'))
  const initialized = initializePhaseGateController(repo, {
    project_run_id: 'project', slice_id: 'slice', actors,
    trust_level: 'advisory_same_uid', pm_actor_id: 'pm-1',
    occurred_at: '2026-07-24T00:00:00.000Z',
  })
  return { repo, initialized }
}

test('init writes strict marker and projection round-trips through the Pulse v4 sanitizer', () => {
  const { repo, initialized } = governedRepo()
  const marker = JSON.parse(readFileSync(join(repo, '.tmux-teams', 'phase-gate.json'), 'utf8'))
  assert.equal(marker.manifest_digest, initialized.marker.manifest_digest)
  for (const phase of ['Requirement', 'Prototype', 'Development', 'QA']) {
    const id = stablePhaseRunId('slice', phase)
    assert.match(id, /^phase-run:[0-9a-f]{64}$/)
    assert.ok(id.length <= 128)
  }
  const projection = phaseGateStatus(repo, { now: '2026-07-24T00:01:00.000Z' }).projection
  const sanitized = sanitizeDeliveryRuntimeProjection(projection, Date.parse('2026-07-24T00:01:00.000Z'))
  assert.equal(sanitized.diagnostic, null)
  assert.deepEqual(sanitized.projection.phase_runs.map((row) => row.phase), ['Requirement', 'Prototype', 'Development', 'QA'])
})

test('controller reserves before spawn and guard records child, footprint, prompt, terminal in order', () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'bootstrap Requirement\n')
  let invocation
  const dispatched = dispatchPhaseGateCompanion(repo, {
    bootstrap: true, task_id: 'bootstrap-task', agent_id: 'mock', brief_file: brief,
    timeout_sec: 30, actor_id: 'requirement-lead',
  }, {
    uuid: '11111111-1111-4111-8111-111111111111',
    spawn_impl(command, args, options) { invocation = { command, args, options }; return { pid: process.pid } },
  })
  assert.ok(invocation)
  assert.equal(phaseGateStatus(repo).aggregate.dispatches[dispatched.dispatch_uuid].state, 'reserved')
  const guard = validateCompanionGovernance({
    repoRoot: repo, taskId: 'bootstrap-task', agentName: 'mock', briefFile: brief,
    timeoutSec: 30, env: dispatched.env,
  })
  guard.registerChild(process.pid)
  guard.recordFootprint('footprint')
  guard.recordPrompt('prompt')
  guard.recordTerminal('success', { evidence: true })
  const status = phaseGateStatus(repo, { now: '2026-07-24T00:02:00.000Z' })
  assert.equal(status.aggregate.dispatches[dispatched.dispatch_uuid].state, 'terminal')
  assert.equal(status.aggregate.requirement_bootstrap_ready, true)
  assert.deepEqual(status.aggregate.events.slice(-4).map((event) => event.event_type),
    ['dispatch_child_registered', 'dispatch_footprint', 'dispatch_prompt', 'dispatch_terminal'])
})

test('a second bootstrap dispatch cannot win while the first reservation exists', () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'brief\n')
  reservePhaseGateDispatch(repo, { bootstrap: true, task_id: 'one', agent_id: 'mock', brief_file: brief, timeout_sec: 30 })
  assert.throws(() => reservePhaseGateDispatch(repo, { bootstrap: true, task_id: 'two', agent_id: 'mock', brief_file: brief, timeout_sec: 30 }),
    (cause) => cause.errors?.some((item) => item.code === 'DISPATCH_EXISTS'))
})

test('guard rejects wrong brief digest or missing controller environment without advancing head', () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'original\n')
  const dispatched = dispatchPhaseGateCompanion(repo, {
    bootstrap: true, task_id: 'task', agent_id: 'mock', brief_file: brief, timeout_sec: 30,
  }, { spawn_impl() { return { pid: process.pid } } })
  const before = phaseGateStatus(repo).head
  writeFileSync(brief, 'mutated\n')
  assert.throws(() => validateCompanionGovernance({ repoRoot: repo, taskId: 'task', agentName: 'mock', briefFile: brief, timeoutSec: 30, env: dispatched.env }),
    (cause) => cause.code === 'PHASE_GATE_ENV_MISMATCH')
  assert.throws(() => validateCompanionGovernance({ repoRoot: repo, taskId: 'task', agentName: 'mock', briefFile: brief, timeoutSec: 30, env: {} }),
    (cause) => cause.code === 'PHASE_GATE_ENV_REQUIRED')
  assert.deepEqual(phaseGateStatus(repo).head, before)
})

test('artifact submission verifies immutable bytes before append', () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'bootstrap\n')
  const dispatched = dispatchPhaseGateCompanion(repo, { bootstrap: true, task_id: 'boot', agent_id: 'mock', brief_file: brief, timeout_sec: 30 }, { spawn_impl() { return { pid: process.pid } } })
  const guard = validateCompanionGovernance({ repoRoot: repo, taskId: 'boot', agentName: 'mock', briefFile: brief, timeoutSec: 30, env: dispatched.env })
  guard.registerChild(process.pid); guard.recordFootprint('f'); guard.recordPrompt('p'); guard.recordTerminal('success', {})
  const artifactFile = join(repo, 'requirements.bin'); writeFileSync(artifactFile, 'requirements bytes')
  const artifact = {
    type: 'requirements_baseline', artifact_id: 'requirements-1', version: '1', digest: digest('requirements bytes'),
    predecessor_trace: [], validation_evidence: ['review'], expectations: { security: 'pass', performance: 'pass', integration: 'pass', uat: 'pass' },
    business_functions: ['checkout'], validation_exceptions: [],
  }
  const command = {
    attempt_id: 'attempt-requirement-1', handoff_id: 'gate-requirement-1', revision: 1,
    boundary: { sender_phase: 'Requirement', receiver_phase: 'Prototype' }, artifact,
    actor: { actor_id: 'requirement-lead', role: 'sender', trust: 'advisory_same_uid' },
    command_id: 'artifact-requirement-1', idempotency_key: 'artifact-requirement-1', event_type: 'artifact_submission', payload: {},
  }
  appendPhaseGateCommand(repo, command, { artifact_file: artifactFile })
  writeFileSync(artifactFile, 'mutated')
  assert.throws(() => appendPhaseGateCommand(repo, { ...command, command_id: 'artifact-mutated', idempotency_key: 'artifact-mutated', attempt_id: 'attempt-mutated', handoff_id: 'gate-mutated' }, { artifact_file: artifactFile }),
    (cause) => cause.code === 'ARTIFACT_DIGEST_MISMATCH')
})

test('true multi-process bootstrap race produces exactly one reservation', async () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'race\n')
  const children = ['race-one', 'race-two'].map((task) => fork(PROCESS_FIXTURE, [repo, brief, task], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }))
  const ready = children.map((child) => new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject)
  }))
  await Promise.all(ready)
  const results = children.map((child) => new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject); child.send('go')
  }))
  const settled = await Promise.all(results)
  assert.equal(settled.filter((result) => result.ok).length, 1, JSON.stringify(settled))
  assert.equal(Object.keys(phaseGateStatus(repo).aggregate.dispatches).length, 1)
})

test('linear four-boundary run reaches final ProjectDelivery acceptance with no QA dispatch', () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'phase work\n')
  const boot = dispatchPhaseGateCompanion(repo, { bootstrap: true, task_id: 'boot-linear', agent_id: 'mock', brief_file: brief, timeout_sec: 30 }, { spawn_impl() { return { pid: process.pid } } })
  const bootGuard = validateCompanionGovernance({ repoRoot: repo, taskId: 'boot-linear', agentName: 'mock', briefFile: brief, timeoutSec: 30, env: boot.env })
  bootGuard.registerChild(process.pid); bootGuard.recordFootprint('f'); bootGuard.recordPrompt('p'); bootGuard.recordTerminal('success', {})
  const receivers = { Requirement: 'prototype-lead', Prototype: 'development-lead', Development: 'qa-lead', QA: 'delivery-lead' }
  const senders = { Requirement: 'requirement-lead', Prototype: 'prototype-lead', Development: 'development-lead', QA: 'qa-lead' }
  const receiverPhase = { Requirement: 'Prototype', Prototype: 'Development', Development: 'QA', QA: 'ProjectDelivery' }
  const types = { Requirement: 'requirements_baseline', Prototype: 'prototype_evaluation', Development: 'development_delivery', QA: 'qa_release_evidence' }
  let qaAcceptance
  for (const [index, phase] of ['Requirement', 'Prototype', 'Development', 'QA'].entries()) {
    const bytes = `${phase} artifact bytes`; const artifactFile = join(repo, `${phase}.bin`); writeFileSync(artifactFile, bytes)
    const artifact = {
      type: types[phase], artifact_id: `artifact-${phase}`, version: '1', digest: digest(bytes),
      predecessor_trace: phase === 'Requirement' ? [] : [`artifact-${index}`], validation_evidence: [`evidence-${phase}`],
      expectations: { security: 'pass', performance: 'pass', integration: 'pass', uat: 'pass' },
    }
    if (phase === 'Requirement') Object.assign(artifact, { business_functions: ['checkout'], validation_exceptions: [] })
    if (phase === 'Prototype') artifact.clickable_prototype_ref = 'prototype-ref'
    if (phase === 'Development') artifact.working_software_ref = 'software-ref'
    if (phase === 'QA') artifact.e2e_uat_report_ref = 'uat-ref'
    const boundary = { sender_phase: phase, receiver_phase: receiverPhase[phase] }
    const attempt_id = `attempt-${phase}`; const handoff_id = `gate-${phase}`
    const submitted = appendPhaseGateCommand(repo, {
      attempt_id, handoff_id, revision: 1, boundary, artifact,
      actor: { actor_id: senders[phase], role: 'sender', trust: 'advisory_same_uid' },
      command_id: `submit-${phase}`, idempotency_key: `submit-${phase}`, event_type: 'artifact_submission', payload: {},
    }, { artifact_file: artifactFile })
    const proposed = appendPhaseGateCommand(repo, {
      attempt_id, handoff_id, revision: 1, boundary, artifact, artifact_event_id: submitted.event.event_id,
      actor: { actor_id: senders[phase], role: 'sender', trust: 'advisory_same_uid' },
      command_id: `propose-${phase}`, idempotency_key: `propose-${phase}`, event_type: 'handoff_propose', payload: {},
    })
    const proposedStatus = phaseGateStatus(repo, { now: new Date(Date.now() + 1_000).toISOString() })
    assert.equal(proposedStatus.projection.bottleneck.kind, 'handoff_review')
    assert.equal(proposedStatus.projection.bottleneck.phase, phase)
    assert.equal(proposedStatus.projection.bottleneck.since, proposed.event.occurred_at)
    assert.equal(proposedStatus.projection.bottleneck.owner_role,
      phase === 'QA' ? 'project_delivery' : 'receiver_phase_lead')
    assert.equal(sanitizeDeliveryRuntimeProjection(
      proposedStatus.projection, Date.parse(proposedStatus.projection.generated_at),
    ).diagnostic, null)
    const event_type = phase === 'QA' ? 'project_delivery_accept' : 'handoff_accept'
    const accepted = appendPhaseGateCommand(repo, {
      attempt_id, handoff_id, revision: 1, boundary, artifact, artifact_event_id: submitted.event.event_id,
      actor: { actor_id: receivers[phase], role: 'receiver_phase_lead', trust: 'advisory_same_uid' },
      command_id: `accept-${phase}`, idempotency_key: `accept-${phase}`, event_type,
      payload: {
        artifact_event_id: submitted.event.event_id, artifact_digest: artifact.digest,
        sender_phase: phase, receiver_phase: receiverPhase[phase],
        sender_actor_id: senders[phase], receiver_actor_id: receivers[phase],
      },
    })
    const acceptedStatus = phaseGateStatus(repo, { now: new Date(Date.now() + 1_000).toISOString() })
    if (phase === 'QA') {
      qaAcceptance = accepted.event.event_id
      assert.equal(acceptedStatus.projection.bottleneck, null)
      assert.equal(sanitizeDeliveryRuntimeProjection(
        acceptedStatus.projection, Date.parse(acceptedStatus.projection.generated_at),
      ).diagnostic, null)
      continue
    }
    assert.equal(acceptedStatus.projection.bottleneck.kind, 'handoff_review')
    assert.equal(acceptedStatus.projection.bottleneck.phase, phase)
    assert.equal(acceptedStatus.projection.bottleneck.since, accepted.event.occurred_at)
    assert.equal(acceptedStatus.projection.phase_gates.find((gate) =>
      gate.gate_id === handoff_id)?.state, 'accepted')
    assert.equal(sanitizeDeliveryRuntimeProjection(
      acceptedStatus.projection, Date.parse(acceptedStatus.projection.generated_at),
    ).diagnostic, null)
    const task = `dispatch-${phase}`
    const dispatched = dispatchPhaseGateCompanion(repo, { acceptance_event_id: accepted.event.event_id, task_id: task, agent_id: 'mock', brief_file: brief, timeout_sec: 30 }, { spawn_impl() { return { pid: process.pid } } })
    const guard = validateCompanionGovernance({ repoRoot: repo, taskId: task, agentName: 'mock', briefFile: brief, timeoutSec: 30, env: dispatched.env })
    guard.registerChild(process.pid); guard.recordFootprint(`f-${phase}`); guard.recordPrompt(`p-${phase}`); guard.recordTerminal('success', {})
  }
  const finalStatus = phaseGateStatus(repo, { now: new Date(Date.now() + 60_000).toISOString() })
  assert.equal(finalStatus.aggregate.terminal, true)
  assert.equal(sanitizeDeliveryRuntimeProjection(finalStatus.projection, Date.parse(finalStatus.projection.generated_at)).diagnostic, null)
  assert.throws(() => reservePhaseGateDispatch(repo, { acceptance_event_id: qaAcceptance, task_id: 'illegal-qa-dispatch', agent_id: 'mock', brief_file: brief, timeout_sec: 30 }),
    (cause) => cause.code === 'PROJECT_DELIVERY_NO_DISPATCH')
})

test('ambiguous post-spawn state becomes indeterminate and requires explicit PM resolution', () => {
  const { repo } = governedRepo(); const brief = join(repo, 'brief.md'); writeFileSync(brief, 'crash\n')
  const dispatched = dispatchPhaseGateCompanion(repo, { bootstrap: true, task_id: 'crash-task', agent_id: 'mock', brief_file: brief, timeout_sec: 30 }, { spawn_impl() { return { pid: process.pid } } })
  const guard = validateCompanionGovernance({ repoRoot: repo, taskId: 'crash-task', agentName: 'mock', briefFile: brief, timeoutSec: 30, env: dispatched.env })
  guard.registerChild(process.pid)
  reconcilePhaseGateDispatch(repo, { dispatch_uuid: dispatched.dispatch_uuid, reason: 'child vanished after registration' })
  assert.equal(phaseGateStatus(repo).aggregate.dispatches[dispatched.dispatch_uuid].state, 'indeterminate')
  assert.throws(() => reservePhaseGateDispatch(repo, { bootstrap: true, task_id: 'auto-retry-forbidden', agent_id: 'mock', brief_file: brief, timeout_sec: 30 }))
  resolvePhaseGateDispatch(repo, {
    dispatch_uuid: dispatched.dispatch_uuid, actor_id: 'pm-1', resolution: 'abandoned',
    reason: 'operator inspected child identity and confirmed it is gone',
  })
  assert.equal(phaseGateStatus(repo).aggregate.dispatches[dispatched.dispatch_uuid].state, 'resolved_abandoned')
  const replacement = reservePhaseGateDispatch(repo, { bootstrap: true, task_id: 'manual-retry', agent_id: 'mock', brief_file: brief, timeout_sec: 30 })
  assert.notEqual(replacement.dispatch_uuid, dispatched.dispatch_uuid)
})
