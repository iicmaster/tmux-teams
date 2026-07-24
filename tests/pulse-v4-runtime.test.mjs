import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  projectPulseV4,
  sanitizeDeliveryRuntimeProjection,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs'
import {
  appendPhaseGateCommand,
  dispatchPhaseGateCompanion,
  initializePhaseGateController,
  phaseGateStatus,
  reconcilePhaseGateDispatch,
  reservePhaseGateDispatch,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-controller.mjs'
import { validateCompanionGovernance } from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-companion-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')
const V4_SCHEMA = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/references/pulse-v4.schema.json')
const V3_SCHEMA = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/references/pulse-v3.schema.json')
const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const DIGEST_C = `sha256:${'c'.repeat(64)}`
const DIGEST_D = `sha256:${'d'.repeat(64)}`
const DIGEST_E = `sha256:${'e'.repeat(64)}`
const DISPATCH_ID = '11111111-1111-4111-8111-111111111111'
const DISPATCH_ID_2 = '22222222-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-07-24T10:10:00Z')
const controllerDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const CONTROLLER_ACTORS = {
  pm: ['pm-1'],
  phase_leads: {
    Requirement: ['requirement-lead'], Prototype: ['prototype-lead'],
    Development: ['development-lead'], QA: ['qa-lead'], ProjectDelivery: ['delivery-lead'],
  },
}

function phaseRuns() {
  return ['Requirement', 'Prototype', 'Development', 'QA'].map((phase, index) => ({
    phase,
    phase_run_id: `phase_run_${index + 1}`,
    state: index === 0 ? 'handoff_pending' : 'pending',
    started_at: index === 0 ? '2026-07-24T10:00:00Z' : null,
    transition_at: null,
    owner_role: index === 0 ? 'receiver_phase_lead' : 'phase_team',
    work_age_sec: index === 0 ? 600 : null,
    wait_age_sec: index === 0 ? 540 : null,
    handoff_count: index === 0 ? 1 : 0,
    revision_count: 0,
  }))
}

function gate(overrides = {}) {
  return {
    gate_id: 'gate_1',
    slice_id: 'slice_1',
    attempt_id: 'attempt_1',
    boundary: 'requirement_to_prototype',
    sender_phase: 'Requirement',
    receiver_phase: 'Prototype',
    artifact_type: 'requirements_baseline',
    artifact_digest: DIGEST_A,
    state: 'proposed',
    proposed_at: '2026-07-24T10:01:00Z',
    transition_at: null,
    acceptance_event_id: null,
    accepted_digest: null,
    receiver_dispatch_id: null,
    consumed_digest: null,
    consumed_at: null,
    ...overrides,
  }
}

function runtime(overrides = {}) {
  return {
    schema: 'tmux-teams.delivery-runtime-projection',
    schema_version: 1,
    generated_at: '2026-07-24T10:10:00Z',
    expires_at: '2026-07-24T10:20:00Z',
    trust_level: 'advisory_same_uid',
    mode: 'observe_only',
    actuation: { enabled: false, auto_execute: false },
    source_health: { phase_gates: 'ok', receiver_dispatches: 'ok' },
    summary: {
      proposed: 1, accepted: 1, rejected: 0, escalated: 0,
      consumed: 1, shown: 1, truncated: 0,
    },
    replay: { sequence: 4, head_event_id: DIGEST_B },
    phase_runs: phaseRuns(),
    bottleneck: {
      phase: 'Requirement',
      kind: 'handoff_review',
      age_sec: 540,
      since: '2026-07-24T10:01:00Z',
      owner_role: 'receiver_phase_lead',
      phase_run_id: 'phase_run_1',
      attempt_id: 'attempt_1',
      gate_id: 'gate_1',
    },
    phase_gates: [gate()],
    ...overrides,
  }
}

function emptyView() {
  return {
    active: [],
    rec: [],
    unclaimed: [],
    diagnostics: [],
    sourceHealth: {
      liveness: 'ok', tmux: 'ok', dispatch: 'ok', outbox: 'ok', events: 'ok',
    },
  }
}

function meta(sequence = 1) {
  return {
    streamId: '22222222-2222-4222-8222-222222222222',
    sequence,
    startedAt: NOW,
    finishedAt: NOW,
    intervalSec: 20,
    repoName: 'repo',
  }
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-v4-runtime-'))
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

function controllerRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'pulse-v4-controller-runtime-'))
  initializePhaseGateController(repo, {
    project_run_id: 'project', slice_id: 'slice', actors: CONTROLLER_ACTORS,
    trust_level: 'advisory_same_uid', pm_actor_id: 'pm-1',
    occurred_at: new Date(Date.now() - 1_000).toISOString(),
  })
  return repo
}

function bootstrapController(repo) {
  const brief = join(repo, 'bootstrap.md')
  writeFileSync(brief, 'bootstrap Requirement\n')
  const dispatched = dispatchPhaseGateCompanion(repo, {
    bootstrap: true, task_id: 'bootstrap', agent_id: 'mock', brief_file: brief, timeout_sec: 30,
  }, { spawn_impl() { return { pid: process.pid } } })
  const guard = validateCompanionGovernance({
    repoRoot: repo, taskId: 'bootstrap', agentName: 'mock', briefFile: brief,
    timeoutSec: 30, env: dispatched.env,
  })
  guard.registerChild(process.pid)
  guard.recordFootprint('bootstrap footprint')
  guard.recordPrompt('bootstrap prompt')
  guard.recordTerminal('success', {})
}

function acceptedRequirement(repo) {
  bootstrapController(repo)
  const artifactFile = join(repo, 'requirements.bin')
  writeFileSync(artifactFile, 'requirements bytes')
  const artifact = {
    type: 'requirements_baseline', artifact_id: 'requirements-1', version: '1',
    digest: controllerDigest('requirements bytes'), predecessor_trace: [],
    validation_evidence: ['review'],
    expectations: { security: 'pass', performance: 'pass', integration: 'pass', uat: 'pass' },
    business_functions: ['checkout'], validation_exceptions: [],
  }
  const boundary = { sender_phase: 'Requirement', receiver_phase: 'Prototype' }
  const common = {
    attempt_id: 'attempt-requirement', handoff_id: 'gate-requirement', revision: 1,
    boundary, artifact,
  }
  const submitted = appendPhaseGateCommand(repo, {
    ...common,
    actor: { actor_id: 'requirement-lead', role: 'sender', trust: 'advisory_same_uid' },
    command_id: 'submit-requirement', idempotency_key: 'submit-requirement',
    event_type: 'artifact_submission', payload: {},
  }, { artifact_file: artifactFile })
  appendPhaseGateCommand(repo, {
    ...common, artifact_event_id: submitted.event.event_id,
    actor: { actor_id: 'requirement-lead', role: 'sender', trust: 'advisory_same_uid' },
    command_id: 'propose-requirement', idempotency_key: 'propose-requirement',
    event_type: 'handoff_propose', payload: {},
  })
  const accepted = appendPhaseGateCommand(repo, {
    ...common, artifact_event_id: submitted.event.event_id,
    actor: { actor_id: 'prototype-lead', role: 'receiver_phase_lead', trust: 'advisory_same_uid' },
    command_id: 'accept-requirement', idempotency_key: 'accept-requirement',
    event_type: 'handoff_accept', payload: {
      artifact_event_id: submitted.event.event_id, artifact_digest: artifact.digest,
      sender_phase: 'Requirement', receiver_phase: 'Prototype',
      sender_actor_id: 'requirement-lead', receiver_actor_id: 'prototype-lead',
    },
  })
  return { artifact, accepted: accepted.event.event_id, brief: join(repo, 'prototype.md') }
}

test('sanitizer publishes closed, canonical phase-gate and bottleneck facts', () => {
  const result = sanitizeDeliveryRuntimeProjection(runtime(), NOW)
  assert.equal(result.diagnostic, null)
  assert.equal(result.projection.mode, 'observe_only')
  assert.deepEqual(result.projection.actuation, { enabled: false, auto_execute: false })
  assert.deepEqual(result.projection.phase_runs.map(row => row.phase),
    ['Requirement', 'Prototype', 'Development', 'QA'])
  assert.equal(result.projection.bottleneck.phase, 'Requirement')
  assert.equal(result.projection.phase_gates[0].receiver_dispatch_id, null)
  assert.deepEqual(result.projection.summary, {
    proposed: 1, accepted: 0, rejected: 0, escalated: 0,
    consumed: 0, shown: 1, truncated: 0,
  })
})

test('runtime projection preserves exact phase-gate digests and 128-character ledger ids', () => {
  const ledgerId = (prefix) => `${prefix}:${'.'.repeat(127 - prefix.length)}`
  const phaseIds = ['requirement', 'prototype', 'development', 'qa'].map(ledgerId)
  const gateId = ledgerId('gate')
  const sliceId = ledgerId('slice')
  const attemptId = ledgerId('attempt')
  const input = runtime({
    phase_runs: phaseRuns().map((row, index) => ({
      ...row,
      phase_run_id: phaseIds[index],
    })),
    bottleneck: {
      ...runtime().bottleneck,
      phase_run_id: phaseIds[0],
      attempt_id: attemptId,
      gate_id: gateId,
      since: '2026-07-24T10:02:00Z',
      age_sec: 480,
    },
    phase_gates: [gate({
      gate_id: gateId,
      slice_id: sliceId,
      attempt_id: attemptId,
      state: 'accepted',
      transition_at: '2026-07-24T10:02:00Z',
      acceptance_event_id: DIGEST_C,
      accepted_digest: DIGEST_A,
    })],
  })
  const result = sanitizeDeliveryRuntimeProjection(input, NOW)
  assert.equal(result.diagnostic, null)
  assert.equal(result.projection.phase_gates[0].acceptance_event_id, DIGEST_C)
  assert.equal(result.projection.phase_gates[0].gate_id, gateId)
  assert.equal(result.projection.phase_gates[0].slice_id, sliceId)
  assert.equal(result.projection.phase_gates[0].attempt_id, attemptId)
})

test('digest mismatch, final-boundary consumption, extras, and contradictory bottlenecks fail closed', () => {
  const badInputs = [
    runtime({ phase_gates: [gate({ accepted_digest: DIGEST_B })] }),
    runtime({ phase_gates: [gate({ acceptance_event_id: 'accept_1' })] }),
    runtime({ phase_gates: [gate({ gate_id: `A${'.'.repeat(128)}` })] }),
    runtime({
      phase_gates: [gate({
        boundary: 'qa_to_project_delivery',
        sender_phase: 'QA',
        receiver_phase: 'ProjectDelivery',
        artifact_type: 'qa_release_evidence',
      })],
    }),
    { ...runtime(), raw_payload: 'SENTINEL_PRIVATE_PAYLOAD' },
    runtime({
      bottleneck: {
        ...runtime().bottleneck,
        phase_run_id: 'phase_run_3',
      },
    }),
  ]
  for (const input of badInputs) {
    const result = sanitizeDeliveryRuntimeProjection(input, NOW)
    assert.equal(result.diagnostic.code, 'DELIVERY_RUNTIME_INPUT_INVALID')
    assert.equal(result.projection.source_health.phase_gates, 'unavailable')
    assert.equal(JSON.stringify(result).includes('SENTINEL_PRIVATE_PAYLOAD'), false)
    assert.equal(result.projection.phase_gates.length, 0)
  }
})

test('QA to ProjectDelivery completes on acceptance and forbids receiver consumption', () => {
  const final = gate({
    gate_id: 'gate_final',
    attempt_id: 'attempt_final',
    boundary: 'qa_to_project_delivery',
    sender_phase: 'QA',
    receiver_phase: 'ProjectDelivery',
    artifact_type: 'qa_release_evidence',
    state: 'accepted',
    transition_at: '2026-07-24T10:02:00Z',
    acceptance_event_id: DIGEST_C,
    accepted_digest: DIGEST_A,
    receiver_dispatch_id: null,
    consumed_digest: null,
    consumed_at: null,
  })
  const input = runtime({ bottleneck: null, phase_gates: [final] })
  const result = sanitizeDeliveryRuntimeProjection(input, NOW)
  assert.equal(result.diagnostic, null)
  assert.equal(result.projection.phase_gates[0].state, 'accepted')
  assert.equal(result.projection.phase_gates[0].receiver_phase, 'ProjectDelivery')
  assert.equal(result.projection.phase_gates[0].consumed_at, null)
})

test('PM exception ownership is limited to exception and reconcile bottlenecks', () => {
  const pmException = runtime({
    phase_gates: [gate({
      state: 'escalated',
      transition_at: '2026-07-24T10:02:00Z',
    })],
    bottleneck: {
      ...runtime().bottleneck,
      kind: 'exception',
      owner_role: 'pm_exception_owner',
      since: '2026-07-24T10:02:00Z',
      age_sec: 480,
    },
  })
  assert.equal(sanitizeDeliveryRuntimeProjection(pmException, NOW).diagnostic, null)
  const routineReview = runtime({
    bottleneck: {
      ...runtime().bottleneck,
      owner_role: 'pm_exception_owner',
    },
  })
  assert.equal(
    sanitizeDeliveryRuntimeProjection(routineReview, NOW).diagnostic.code,
    'DELIVERY_RUNTIME_INPUT_INVALID',
  )
})

test('runtime identity is single-slice and globally unique before any facts are published', () => {
  const accepted = gate({
    gate_id: 'gate_accepted', attempt_id: 'attempt_accepted',
    state: 'accepted', transition_at: '2026-07-24T10:02:00Z',
    acceptance_event_id: DIGEST_C, accepted_digest: DIGEST_A,
  })
  const consumed = gate({
    gate_id: 'gate_consumed', attempt_id: 'attempt_consumed',
    boundary: 'prototype_to_development', sender_phase: 'Prototype',
    receiver_phase: 'Development', artifact_type: 'prototype_evaluation',
    state: 'consumed', transition_at: '2026-07-24T10:02:00Z',
    acceptance_event_id: DIGEST_D, accepted_digest: DIGEST_A,
    receiver_dispatch_id: DISPATCH_ID, consumed_digest: DIGEST_A,
    consumed_at: '2026-07-24T10:03:00Z',
  })
  const developmentWorking = phaseRuns().map(run => run.phase === 'Development'
    ? { ...run, state: 'working', started_at: '2026-07-24T10:00:00Z', work_age_sec: 600 }
    : run)
  const invalid = [
    runtime({ bottleneck: null, phase_gates: [gate(), gate({ gate_id: 'gate_2', attempt_id: 'attempt_2', slice_id: 'slice_2' })] }),
    runtime({ bottleneck: null, phase_gates: [gate(), gate({ gate_id: 'gate_1', attempt_id: 'attempt_2' })] }),
    runtime({ bottleneck: null, phase_gates: [gate(), gate({ gate_id: 'gate_2', attempt_id: 'attempt_1' })] }),
    runtime({ bottleneck: null, phase_gates: [accepted, gate({
      gate_id: 'gate_accepted_2', attempt_id: 'attempt_accepted_2',
      state: 'accepted', transition_at: '2026-07-24T10:02:00Z',
      acceptance_event_id: DIGEST_C, accepted_digest: DIGEST_A,
    })] }),
    runtime({ bottleneck: null, phase_runs: developmentWorking, phase_gates: [consumed, gate({
      gate_id: 'gate_consumed_2', attempt_id: 'attempt_consumed_2',
      boundary: 'prototype_to_development', sender_phase: 'Prototype',
      receiver_phase: 'Development', artifact_type: 'prototype_evaluation',
      state: 'consumed', transition_at: '2026-07-24T10:02:00Z',
      acceptance_event_id: DIGEST_E, accepted_digest: DIGEST_A,
      receiver_dispatch_id: DISPATCH_ID, consumed_digest: DIGEST_A,
      consumed_at: '2026-07-24T10:03:00Z',
    })] }),
  ]
  for (const input of invalid) {
    const result = sanitizeDeliveryRuntimeProjection(input, NOW)
    assert.equal(result.diagnostic.code, 'DELIVERY_RUNTIME_INPUT_INVALID')
    assert.equal(result.projection.phase_gates.length, 0)
  }
})

test('phase matrices and chronological runtime facts fail closed', () => {
  const invalid = [
    runtime({ phase_runs: phaseRuns().map((run, index) => index === 1
      ? { ...run, started_at: '2026-07-24T10:00:00Z' } : run) }),
    runtime({ phase_runs: phaseRuns().map((run, index) => index === 0
      ? { ...run, state: 'working', owner_role: 'phase_team', wait_age_sec: 1 } : run) }),
    runtime({ phase_runs: phaseRuns().map((run, index) => index === 0
      ? { ...run, transition_at: '2026-07-24T10:02:00Z' } : run) }),
    runtime({ phase_runs: phaseRuns().map((run, index) => index === 0
      ? {
        ...run, state: 'completed', owner_role: 'phase_team',
        transition_at: '2026-07-24T10:02:00Z', work_age_sec: 1, wait_age_sec: null,
      } : run) }),
    runtime({ phase_runs: phaseRuns().map((run, index) => index === 0
      ? { ...run, started_at: '2026-07-24T10:11:00Z', work_age_sec: 1, wait_age_sec: 1 } : run) }),
    runtime({ phase_runs: phaseRuns().map((run, index) => index === 0
      ? { ...run, started_at: '2026-07-24T10:02:00Z', work_age_sec: 480, wait_age_sec: 420 } : run) }),
    runtime({
      bottleneck: null,
      phase_runs: phaseRuns().map((run, index) => index === 1
        ? { ...run, state: 'working', started_at: '2026-07-24T10:04:00Z', work_age_sec: 360 } : run),
      phase_gates: [gate({
        state: 'consumed', transition_at: '2026-07-24T10:02:00Z',
        acceptance_event_id: DIGEST_C, accepted_digest: DIGEST_A,
        receiver_dispatch_id: DISPATCH_ID, consumed_digest: DIGEST_A,
        consumed_at: '2026-07-24T10:03:00Z',
      })],
    }),
  ]
  for (const input of invalid) {
    const result = sanitizeDeliveryRuntimeProjection(input, NOW)
    assert.equal(result.diagnostic.code, 'DELIVERY_RUNTIME_INPUT_INVALID')
    assert.equal(result.projection.source_health.phase_gates, 'unavailable')
  }
})

test('bottleneck kinds bind to a current gate state and never revive a stale consumed attempt', () => {
  const rejected = gate({ state: 'rejected', transition_at: '2026-07-24T10:02:00Z' })
  const rework = runtime({
    phase_gates: [rejected],
    bottleneck: {
      ...runtime().bottleneck, kind: 'rework', owner_role: 'phase_team',
      since: '2026-07-24T10:02:00Z', age_sec: 480,
    },
  })
  assert.equal(sanitizeDeliveryRuntimeProjection(rework, NOW).diagnostic, null)

  const workingRuns = phaseRuns().map((run, index) => index === 0
    ? { ...run, state: 'working', owner_role: 'phase_team', wait_age_sec: null } : run)
  const work = runtime({
    phase_runs: workingRuns,
    phase_gates: [],
    bottleneck: {
      phase: 'Requirement', kind: 'work', age_sec: 600, since: '2026-07-24T10:00:00Z',
      owner_role: 'phase_team', phase_run_id: 'phase_run_1', attempt_id: null, gate_id: null,
    },
  })
  assert.equal(sanitizeDeliveryRuntimeProjection(work, NOW).diagnostic, null)

  const qaHandoffRuns = phaseRuns().map((run, index) => index === 3
    ? {
      ...run, state: 'handoff_pending', started_at: '2026-07-24T10:00:00Z',
      owner_role: 'receiver_phase_lead', work_age_sec: 600, wait_age_sec: 540, handoff_count: 1,
    } : run)
  const qaHandoff = runtime({
    phase_runs: qaHandoffRuns,
    phase_gates: [gate({
      gate_id: 'gate_qa', attempt_id: 'attempt_qa',
      boundary: 'qa_to_project_delivery', sender_phase: 'QA', receiver_phase: 'ProjectDelivery',
      artifact_type: 'qa_release_evidence',
    })],
    bottleneck: {
      phase: 'QA', kind: 'handoff_review', age_sec: 540, since: '2026-07-24T10:01:00Z',
      owner_role: 'project_delivery', phase_run_id: 'phase_run_4',
      attempt_id: 'attempt_qa', gate_id: 'gate_qa',
    },
  })
  assert.equal(sanitizeDeliveryRuntimeProjection(qaHandoff, NOW).diagnostic, null)

  const consumed = gate({
    state: 'consumed', transition_at: '2026-07-24T10:02:00Z',
    acceptance_event_id: DIGEST_C, accepted_digest: DIGEST_A,
    receiver_dispatch_id: DISPATCH_ID, consumed_digest: DIGEST_A,
    consumed_at: '2026-07-24T10:03:00Z',
  })
  const receiverStarted = phaseRuns().map((run, index) => index === 1
    ? { ...run, state: 'working', started_at: '2026-07-24T10:00:00Z', work_age_sec: 600 } : run)
  const staleConsumed = runtime({
    phase_runs: receiverStarted,
    phase_gates: [consumed, gate({ gate_id: 'gate_later', attempt_id: 'attempt_later', proposed_at: '2026-07-24T10:04:00Z' })],
    bottleneck: {
      phase: 'Prototype', kind: 'dispatch_reconcile', age_sec: 420, since: '2026-07-24T10:03:00Z',
      owner_role: 'pm_exception_owner', phase_run_id: 'phase_run_2',
      attempt_id: 'attempt_1', gate_id: 'gate_1',
    },
  })
  const mismatched = [
    runtime({ bottleneck: { ...runtime().bottleneck, kind: 'exception', owner_role: 'pm_exception_owner' } }),
    runtime({ bottleneck: { ...runtime().bottleneck, kind: 'work' } }),
    runtime({ bottleneck: { ...runtime().bottleneck, kind: 'handoff_review' }, phase_gates: [rejected] }),
    staleConsumed,
  ]
  for (const input of mismatched) {
    assert.equal(sanitizeDeliveryRuntimeProjection(input, NOW).diagnostic.code,
      'DELIVERY_RUNTIME_INPUT_INVALID')
  }
})

test('controller projections round-trip dispatch reconciliation at bootstrap, before consumption, and after consumption', () => {
  const assertRoundTrip = (repo, expectedGateState, expectedNullGate = false) => {
    const status = phaseGateStatus(repo, { now: new Date(Date.now() + 1_000).toISOString() })
    assert.equal(status.projection.bottleneck.kind, 'dispatch_reconcile')
    if (expectedNullGate) {
      assert.equal(status.projection.bottleneck.gate_id, null)
      assert.equal(status.projection.bottleneck.attempt_id, null)
    } else {
      assert.equal(status.projection.phase_gates.find(gate =>
        gate.gate_id === status.projection.bottleneck.gate_id)?.state, expectedGateState)
    }
    const sanitized = sanitizeDeliveryRuntimeProjection(
      status.projection, Date.parse(status.projection.generated_at),
    )
    assert.equal(sanitized.diagnostic, null)
  }

  const bootstrap = controllerRepo()
  const bootstrapBrief = join(bootstrap, 'bootstrap.md')
  writeFileSync(bootstrapBrief, 'bootstrap Requirement\n')
  const bootstrapDispatch = reservePhaseGateDispatch(bootstrap, {
    bootstrap: true, task_id: 'bootstrap-indeterminate', agent_id: 'mock',
    brief_file: bootstrapBrief, timeout_sec: 30,
  }, { uuid: '33333333-3333-4333-8333-333333333333' })
  reconcilePhaseGateDispatch(bootstrap, {
    dispatch_uuid: bootstrapDispatch.dispatch_uuid, reason: 'bootstrap reservation is indeterminate',
  })
  assertRoundTrip(bootstrap, null, true)

  const beforeConsumption = controllerRepo()
  const pre = acceptedRequirement(beforeConsumption)
  writeFileSync(pre.brief, 'prototype work\n')
  const preDispatch = reservePhaseGateDispatch(beforeConsumption, {
    acceptance_event_id: pre.accepted, task_id: 'prototype-indeterminate', agent_id: 'mock',
    brief_file: pre.brief, timeout_sec: 30,
  }, { uuid: '44444444-4444-4444-8444-444444444444' })
  reconcilePhaseGateDispatch(beforeConsumption, {
    dispatch_uuid: preDispatch.dispatch_uuid, reason: 'accepted artifact dispatch is indeterminate',
  })
  assertRoundTrip(beforeConsumption, 'accepted')

  const afterConsumption = controllerRepo()
  const post = acceptedRequirement(afterConsumption)
  writeFileSync(post.brief, 'prototype work\n')
  const postDispatch = dispatchPhaseGateCompanion(afterConsumption, {
    acceptance_event_id: post.accepted, task_id: 'prototype-consumed-indeterminate', agent_id: 'mock',
    brief_file: post.brief, timeout_sec: 30,
  }, {
    uuid: '55555555-5555-4555-8555-555555555555',
    spawn_impl() { return { pid: process.pid } },
  })
  const postGuard = validateCompanionGovernance({
    repoRoot: afterConsumption, taskId: 'prototype-consumed-indeterminate', agentName: 'mock',
    briefFile: post.brief, timeoutSec: 30, env: postDispatch.env,
  })
  postGuard.registerChild(process.pid)
  reconcilePhaseGateDispatch(afterConsumption, {
    dispatch_uuid: postDispatch.dispatch_uuid, reason: 'consumed artifact dispatch is indeterminate',
  })
  assertRoundTrip(afterConsumption, 'consumed')
})

test('stale and explicit read issues produce bounded degraded projections and diagnostics', () => {
  const stale = sanitizeDeliveryRuntimeProjection(
    runtime({
      generated_at: '2026-07-24T10:09:00Z',
      expires_at: '2026-07-24T10:09:59Z',
      bottleneck: { ...runtime().bottleneck, age_sec: 480 },
    }),
    NOW,
  )
  assert.equal(stale.diagnostic.code, 'DELIVERY_RUNTIME_STALE')
  assert.equal(stale.projection.phase_runs.length, 4)
  assert.equal(stale.projection.bottleneck, null)
  const unreadable = sanitizeDeliveryRuntimeProjection(null, NOW, 'DELIVERY_RUNTIME_INPUT_UNREADABLE')
  assert.equal(unreadable.diagnostic.code, 'DELIVERY_RUNTIME_INPUT_UNREADABLE')
  assert.equal(unreadable.projection.summary.shown, 0)
})

test('runtime gates sort canonically and cap at 100 without trusting input summary', () => {
  const gates = Array.from({ length: 101 }, (_, index) => gate({
    slice_id: 'slice_1',
    attempt_id: `attempt_${index}`,
    gate_id: `gate_${String(100 - index).padStart(3, '0')}`,
    state: 'proposed',
    transition_at: null,
    acceptance_event_id: null,
    accepted_digest: null,
    receiver_dispatch_id: null,
    consumed_digest: null,
    consumed_at: null,
  }))
  const result = sanitizeDeliveryRuntimeProjection(runtime({
    bottleneck: {
      ...runtime().bottleneck,
      gate_id: 'gate_100',
      attempt_id: 'attempt_0',
    },
    summary: {
      proposed: 999, accepted: 999, rejected: 999, escalated: 999,
      consumed: 999, shown: 999, truncated: 999,
    },
    phase_gates: gates,
  }), NOW)
  assert.equal(result.diagnostic, null)
  assert.equal(result.projection.phase_gates.length, 100)
  assert.equal(result.projection.summary.proposed, 101)
  assert.equal(result.projection.summary.shown, 100)
  assert.equal(result.projection.summary.truncated, 1)
  assert.equal(result.projection.phase_gates[0].gate_id, 'gate_000')
  assert.ok(result.projection.phase_gates.some(item => item.gate_id === 'gate_100'),
    'the active bottleneck gate must remain in the bounded public projection')
})

test('Pulse v4 omits an unconfigured runtime and degrades only when configured input is bad', () => {
  const omitted = projectPulseV4(emptyView(), meta())
  assert.equal(omitted.schema_version, 4)
  assert.equal(Object.hasOwn(omitted, 'delivery_runtime'), false)
  assert.equal(omitted.complete, true)

  const included = projectPulseV4(
    emptyView(), meta(), null, null, false, runtime(), null, true,
  )
  assert.equal(included.delivery_runtime.phase_gates.length, 1)
  assert.equal(included.complete, true)

  const degraded = projectPulseV4(
    emptyView(), meta(), null, null, false, null, 'DELIVERY_RUNTIME_INPUT_INVALID', true,
  )
  assert.equal(degraded.complete, false)
  assert.equal(degraded.observation.quality, 'degraded')
  assert.equal(degraded.diagnostics[0].source, 'delivery_runtime')
})

test('CLI publishes v4, preserves stream migration, and never serializes the source path', () => {
  for (const priorVersion of [1, 2, 3]) {
    const dir = tempRepo()
    const inputPath = join(dir, 'SENTINEL_PRIVATE_RUNTIME_PATH.json')
    writeFileSync(inputPath, `${JSON.stringify(runtime({
      generated_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      bottleneck: null,
    }))}\n`)
    const streamId = '33333333-3333-4333-8333-333333333333'
    writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
      schema: 'tmux-teams.pulse',
      schema_version: priorVersion,
      stream_id: streamId,
      sequence: 7,
    }))
    const result = spawnSync(process.execPath, [
      PULSE, 'json', dir, '--delivery-runtime', inputPath,
    ], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    const snapshot = JSON.parse(result.stdout)
    assert.equal(snapshot.schema_version, 4)
    assert.equal(snapshot.stream_id, streamId)
    assert.equal(snapshot.sequence, 8)
    assert.equal(snapshot.delivery_runtime.phase_gates.length, 1)
    assert.ok(snapshot.diagnostics.some(item => item.code === 'SCHEMA_UPGRADED'))
    assert.equal(result.stdout.includes(inputPath), false)
    assert.equal(result.stdout.includes('SENTINEL_PRIVATE_RUNTIME_PATH'), false)
    if (priorVersion === 3) {
      const program = [
        'import json, jsonschema, sys',
        'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
        'instance = json.load(open(sys.argv[2], encoding="utf-8"))',
        'base = json.load(open(sys.argv[3], encoding="utf-8"))',
        'resolver = jsonschema.RefResolver.from_schema(schema, store={"pulse-v3.schema.json": base})',
        'jsonschema.Draft202012Validator(schema, resolver=resolver, format_checker=jsonschema.FormatChecker()).validate(instance)',
      ].join('; ')
      const validation = spawnSync('python3', [
        '-c', program, V4_SCHEMA, join(dir, '.tmux-teams', 'pulse.json'), V3_SCHEMA,
      ], { encoding: 'utf8', timeout: 10_000 })
      assert.equal(validation.status, 0, validation.stderr || validation.stdout)
    }
  }
})

test('Pulse HTML renders a clean full delivery runtime loop without private gate facts', () => {
  const dir = tempRepo()
  const inputPath = join(dir, 'delivery-runtime.json')
  const fullLoop = runtime({
    generated_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    phase_runs: ['Requirement', 'Prototype', 'Development', 'QA'].map((phase, index) => ({
      phase,
      phase_run_id: `private_phase_run_${index + 1}`,
      state: 'completed',
      started_at: '2026-07-24T10:00:00Z',
      transition_at: '2026-07-24T10:05:00Z',
      owner_role: phase === 'QA' ? 'project_delivery' : 'phase_team',
      work_age_sec: null,
      wait_age_sec: null,
      handoff_count: index + 1,
      revision_count: index === 0 ? 1 : 0,
    })),
    bottleneck: null,
    phase_gates: [
      gate({
        gate_id: 'SENTINEL_PRIVATE_GATE_REJECTED',
        slice_id: 'SENTINEL_PRIVATE_SLICE',
        attempt_id: 'attempt_requirement_rejected',
        state: 'rejected',
        transition_at: '2026-07-24T10:02:00Z',
        acceptance_event_id: null,
        accepted_digest: null,
        receiver_dispatch_id: null,
        consumed_digest: null,
        consumed_at: null,
      }),
      gate({
        gate_id: 'SENTINEL_PRIVATE_GATE_CONSUMED_REQUIREMENT',
        slice_id: 'SENTINEL_PRIVATE_SLICE',
        attempt_id: 'attempt_requirement_consumed',
        state: 'consumed',
        transition_at: '2026-07-24T10:02:00Z',
        acceptance_event_id: DIGEST_C,
        accepted_digest: DIGEST_A,
        receiver_dispatch_id: DISPATCH_ID,
        consumed_digest: DIGEST_A,
        consumed_at: '2026-07-24T10:03:00Z',
      }),
      gate({
        gate_id: 'SENTINEL_PRIVATE_GATE_ESCALATED',
        slice_id: 'SENTINEL_PRIVATE_SLICE',
        attempt_id: 'attempt_prototype_escalated',
        boundary: 'prototype_to_development',
        sender_phase: 'Prototype',
        receiver_phase: 'Development',
        artifact_type: 'prototype_evaluation',
        state: 'escalated',
        transition_at: '2026-07-24T10:02:00Z',
        acceptance_event_id: null,
        accepted_digest: null,
        receiver_dispatch_id: null,
        consumed_digest: null,
        consumed_at: null,
      }),
      gate({
        gate_id: 'SENTINEL_PRIVATE_GATE_CONSUMED_DEVELOPMENT',
        slice_id: 'SENTINEL_PRIVATE_SLICE',
        attempt_id: 'attempt_development_consumed',
        boundary: 'development_to_qa',
        sender_phase: 'Development',
        receiver_phase: 'QA',
        artifact_type: 'development_delivery',
        state: 'consumed',
        transition_at: '2026-07-24T10:02:00Z',
        acceptance_event_id: DIGEST_D,
        accepted_digest: DIGEST_A,
        receiver_dispatch_id: DISPATCH_ID_2,
        consumed_digest: DIGEST_A,
        consumed_at: '2026-07-24T10:03:00Z',
      }),
      gate({
        gate_id: 'SENTINEL_PRIVATE_GATE_ACCEPTED_QA',
        slice_id: 'SENTINEL_PRIVATE_SLICE',
        attempt_id: 'attempt_qa_accepted',
        boundary: 'qa_to_project_delivery',
        sender_phase: 'QA',
        receiver_phase: 'ProjectDelivery',
        artifact_type: 'qa_release_evidence',
        state: 'accepted',
        transition_at: '2026-07-24T10:02:00Z',
        acceptance_event_id: DIGEST_E,
        accepted_digest: DIGEST_A,
        receiver_dispatch_id: null,
        consumed_digest: null,
        consumed_at: null,
      }),
    ],
  })
  writeFileSync(inputPath, `${JSON.stringify(fullLoop)}\n`)
  const result = spawnSync(process.execPath, [
    PULSE, 'once', dir, '--delivery-runtime', inputPath,
  ], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')

  assert.match(html, /<section class="delivery-runtime" aria-labelledby="delivery-runtime-title">/)
  assert.match(html, /<h2 id="delivery-runtime-title">สถานะ runtime ของการส่งมอบ<\/h2>/)
  assert.match(html, /data-runtime-attention-count="0"/)
  assert.match(html, /รายการที่ต้องดำเนินการจาก runtime: 0/)
  for (const phase of ['Requirement', 'Prototype', 'Development', 'QA']) {
    assert.match(html, new RegExp(`data-phase="${phase}" data-state="completed"`))
  }
  assert.match(html, /ส่งต่อ<\/dt><dd class="num">1 ครั้ง<\/dd>/)
  assert.match(html, /แก้ไข<\/dt><dd class="num">1 รอบ<\/dd>/)
  assert.match(html, /data-boundary="requirement_to_prototype" data-gate-state="rejected" data-attempt-id="attempt_requirement_rejected"/)
  assert.match(html, /data-boundary="qa_to_project_delivery" data-gate-state="accepted" data-attempt-id="attempt_qa_accepted"/)
  for (const state of ['ผู้รับปฏิเสธ', 'ผู้รับนำไปใช้แล้ว', 'ยกระดับข้อยกเว้น', 'ผู้รับตอบรับ']) {
    assert.match(html, new RegExp(state))
  }
  assert.match(html, /ProjectDelivery เป็นผู้รับปลายทาง/)
  assert.match(html, /ไม่มีการ dispatch worker ลำดับที่ห้า/)
  for (const privateValue of [
    'SENTINEL_PRIVATE_GATE_REJECTED', 'SENTINEL_PRIVATE_SLICE',
    'private_phase_run_1', DIGEST_A, DIGEST_B, DIGEST_C, DIGEST_D, DIGEST_E,
    DISPATCH_ID, DISPATCH_ID_2,
  ]) assert.equal(html.includes(privateValue), false, `HTML leaked ${privateValue}`)
})

test('CLI invalid runtime degrades without leaking raw input, payload, or path', () => {
  const dir = tempRepo()
  const inputPath = join(dir, 'SENTINEL_SECRET_PATH.json')
  writeFileSync(inputPath, JSON.stringify({
    ...runtime({
      generated_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    raw_payload: 'SENTINEL_SECRET_PAYLOAD',
  }))
  const result = spawnSync(process.execPath, [
    PULSE, 'json', dir, '--delivery-runtime', inputPath,
  ], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(result.stdout)
  assert.equal(snapshot.delivery_runtime.source_health.phase_gates, 'unavailable')
  assert.equal(snapshot.diagnostics[0].code, 'DELIVERY_RUNTIME_INPUT_INVALID')
  assert.equal(result.stdout.includes('SENTINEL_SECRET_PATH'), false)
  assert.equal(result.stdout.includes('SENTINEL_SECRET_PAYLOAD'), false)
})
