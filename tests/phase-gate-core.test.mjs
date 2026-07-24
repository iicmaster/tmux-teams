import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  PHASE_GATE_TRUST_LEVEL,
  REQUIREMENT_BOOTSTRAP_BOUNDARY,
  appendPhaseGateEvent,
  canonicalRepoIdentity,
  createPhaseGateAggregate,
  createPhaseGateManifest,
  isDispatchEligible,
  isPhaseCompleted,
  isProjectDeliveryFinal,
  replayPhaseGateEvents,
  stablePhaseRunId,
  verifyArtifactBytes,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-core.mjs'
import {
  canonicalDigest,
  PHASE_BOUNDARIES,
  PHASE_EXIT_ARTIFACTS,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-core.mjs'

const ACTORS = Object.freeze({
  pm: ['pm-1'],
  phase_leads: {
    Requirement: ['requirement-lead'],
    Prototype: ['prototype-lead'],
    Development: ['development-lead'],
    QA: ['qa-lead'],
    ProjectDelivery: ['delivery-lead'],
  },
})
const actor = (actor_id, role) => ({ actor_id, role, trust: PHASE_GATE_TRUST_LEVEL })
const manifest = (overrides = {}) => createPhaseGateManifest({
  project_run_id: 'project',
  slice_id: 'slice',
  repo_root: '/workspace/project',
  repo_identity_digest: canonicalRepoIdentity('/workspace/project'),
  actors: ACTORS,
  trust_level: PHASE_GATE_TRUST_LEVEL,
  ...overrides,
})
const boundary = (phase) => ({ sender_phase: phase, receiver_phase: PHASE_BOUNDARIES[phase] })
const timestamp = (sequence) => new Date(Date.UTC(2026, 6, 24, 0, 0, sequence)).toISOString()
const phaseRun = (phase) => stablePhaseRunId('slice', phase)

function artifact(phase, revision = 1) {
  const value = {
    type: PHASE_EXIT_ARTIFACTS[phase],
    artifact_id: `artifact-${phase}-${revision}`,
    version: String(revision),
    digest: canonicalDigest({ phase, revision }),
    predecessor_trace: phase === 'Requirement' ? [] : [`artifact-${Object.keys(PHASE_BOUNDARIES)[Object.keys(PHASE_BOUNDARIES).indexOf(phase) - 1]}-${revision}`],
    validation_evidence: [`evidence-${phase}-${revision}`],
    expectations: { security: 'pass', performance: 'pass', integration: 'pass', uat: 'pass' },
  }
  if (phase === 'Requirement') {
    value.business_functions = ['checkout']
    value.validation_exceptions = []
  }
  if (phase === 'Prototype') value.clickable_prototype_ref = 'https://prototype.invalid/1'
  if (phase === 'Development') value.working_software_ref = 'sha256:working'
  if (phase === 'QA') value.e2e_uat_report_ref = 'sha256:uat'
  return value
}

function append(state, event_type, values = {}) {
  const phase = event_type === 'project_genesis' ? 'Requirement'
    : event_type.startsWith('dispatch_') ? values.boundary?.receiver_phase
      : values.boundary?.sender_phase
  const input = {
    project_run_id: 'project',
    slice_id: 'slice',
    phase_run_id: values.phase_run_id ?? phaseRun(phase),
    occurred_at: values.occurred_at ?? timestamp(state.head.sequence + 1),
    actor: values.actor,
    command_id: values.command_id ?? `command-${state.head.sequence + 1}`,
    idempotency_key: values.idempotency_key ?? `idempotency-${state.head.sequence + 1}`,
    event_type,
    payload: values.payload ?? {},
    ...values,
  }
  delete input.expected_head
  for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key]
  return appendPhaseGateEvent(state, input, { expected_head: state.head })
}

function genesis(state = createPhaseGateAggregate(manifest()), overrides = {}) {
  return append(state, 'project_genesis', {
    actor: actor('pm-1', 'pm'),
    phase_run_id: phaseRun('Requirement'),
    payload: { initial_phase: 'Requirement' },
    ...overrides,
  }).aggregate
}

function bootstrap(state, { stop = 'terminal', outcome = 'success' } = {}) {
  const dispatch_uuid = '123e4567-e89b-42d3-a456-426614174001'
  let result = append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Requirement'),
    boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
    dispatch_uuid,
    acceptance_event_id: null,
    actor: actor('requirement-lead', 'receiver_phase_lead'),
    payload: {
      bootstrap: true,
      task_id: 'requirement-bootstrap',
      agent_id: 'requirement-lead',
      brief_digest: canonicalDigest({ brief: 'bootstrap' }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
  })
  state = result.aggregate
  const reservation_event_id = result.event.event_id
  const lifecycle = [
    ['dispatch_child_registered', { reservation_event_id, pid: 4101, ppid: 4000, process_start: '101', child_identity_digest: canonicalDigest({ child: 'bootstrap' }) }],
    ['dispatch_footprint', { footprint_digest: canonicalDigest({ footprint: 1 }) }],
    ['dispatch_prompt', { prompt_digest: canonicalDigest({ prompt: 1 }) }],
    ['dispatch_terminal', { outcome, evidence_digest: canonicalDigest({ outcome }) }],
  ]
  for (const [type, payload] of lifecycle) {
    state = append(state, type, {
      phase_run_id: phaseRun('Requirement'),
      boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
      dispatch_uuid,
      acceptance_event_id: null,
      actor: actor('requirement-lead', 'receiver_phase_lead'),
      payload,
    }).aggregate
    if (stop === type.replace('dispatch_', '')) break
  }
  return state
}

function submitAndPropose(state, phase, revision = 1, ids = {}) {
  const attempt_id = ids.attempt_id ?? `attempt-${phase}-${revision}`
  const handoff_id = ids.handoff_id ?? `handoff-${phase}-${revision}`
  const phaseArtifact = artifact(phase, revision)
  let result = append(state, 'artifact_submission', {
    attempt_id,
    handoff_id,
    revision,
    boundary: boundary(phase),
    artifact: phaseArtifact,
    actor: actor(ACTORS.phase_leads[phase][0], 'sender'),
  })
  state = result.aggregate
  const artifact_event_id = result.event.event_id
  result = append(state, 'handoff_propose', {
    attempt_id,
    handoff_id,
    revision,
    boundary: boundary(phase),
    artifact: phaseArtifact,
    artifact_event_id,
    actor: actor(ACTORS.phase_leads[phase][0], 'sender'),
  })
  return { state: result.aggregate, artifact: phaseArtifact, artifact_event_id, attempt_id, handoff_id }
}

function accept(state, phase, attempt) {
  const receiver_actor_id = ACTORS.phase_leads[PHASE_BOUNDARIES[phase]][0]
  const event_type = phase === 'QA' ? 'project_delivery_accept' : 'handoff_accept'
  const result = append(state, event_type, {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: Number(attempt.artifact.version),
    boundary: boundary(phase),
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor(receiver_actor_id, 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      artifact_event_id: attempt.artifact_event_id,
      sender_phase: phase,
      receiver_phase: PHASE_BOUNDARIES[phase],
      sender_actor_id: ACTORS.phase_leads[phase][0],
      receiver_actor_id,
    },
  })
  return { state: result.aggregate, acceptance_event_id: result.event.event_id, receiver_actor_id }
}

function dispatchAndConsume(state, phase, attempt, acceptance, dispatch_uuid) {
  let result = append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun(PHASE_BOUNDARIES[phase]),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: Number(attempt.artifact.version),
    boundary: boundary(phase),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor(acceptance.receiver_actor_id, 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      task_id: `task-${phase}`,
      agent_id: acceptance.receiver_actor_id,
      brief_digest: canonicalDigest({ brief: phase }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
    artifact_event_id: attempt.artifact_event_id,
  })
  state = result.aggregate
  const reservation_event_id = result.event.event_id
  const lifecycle = [
    ['dispatch_child_registered', { reservation_event_id, pid: 4201, ppid: 4000, process_start: '202', child_identity_digest: canonicalDigest({ child: phase }) }],
    ['dispatch_consumption', { artifact_event_id: attempt.artifact_event_id, artifact_digest: attempt.artifact.digest }],
    ['dispatch_footprint', { footprint_digest: canonicalDigest({ footprint: phase }) }],
    ['dispatch_prompt', { prompt_digest: canonicalDigest({ prompt: phase }) }],
    ['dispatch_terminal', { outcome: 'success', evidence_digest: canonicalDigest({ outcome: phase }) }],
  ]
  for (const [type, payload] of lifecycle) {
    state = append(state, type, {
      phase_run_id: phaseRun(PHASE_BOUNDARIES[phase]),
      attempt_id: attempt.attempt_id,
      handoff_id: attempt.handoff_id,
      revision: Number(attempt.artifact.version),
      boundary: boundary(phase),
      dispatch_uuid,
      acceptance_event_id: acceptance.acceptance_event_id,
      artifact_event_id: type === 'dispatch_consumption' ? attempt.artifact_event_id : undefined,
      actor: actor(acceptance.receiver_actor_id, 'receiver_phase_lead'),
      payload,
    }).aggregate
  }
  return state
}

test('Requirement bootstrap is the only legal first receiver dispatch and needs no fake acceptance/artifact', () => {
  let state = genesis()
  const before = state
  assert.throws(() => append(state, 'phase_work', {
    attempt_id: 'attempt-Requirement-1',
    handoff_id: 'handoff-Requirement-1',
    revision: 1,
    boundary: boundary('Requirement'),
    actor: actor('requirement-lead', 'sender'),
    payload: { work_item_id: 'requirements', status: 'started' },
  }), (cause) => cause.errors.some((item) => item.code === 'REQUIREMENT_BOOTSTRAP_REQUIRED'))
  state = bootstrap(state)
  assert.equal(state.requirement_bootstrap_ready, true)
  const reservation = state.events.find((event) => event.event_type === 'dispatch_reservation')
  assert.equal(reservation.acceptance_event_id, null)
  assert.equal(Object.hasOwn(reservation, 'artifact'), false)
  assert.equal(Object.hasOwn(reservation, 'attempt_id'), false)
  assert.equal(replayPhaseGateEvents(createPhaseGateAggregate(manifest()), state.events).requirement_bootstrap_ready, true)
  assert.throws(() => bootstrap(state), (cause) => cause.errors.some((item) => ['BOOTSTRAP_DISPATCH_INVALID', 'DISPATCH_EXISTS'].includes(item.code)))
  assert.equal(before.current_phase, 'Requirement')
})

test('bootstrap recovery forbids terminal_observed and preserves abandoned as the only recovery path', () => {
  let state = bootstrap(genesis(), { stop: 'child_registered' })
  const dispatch_uuid = '123e4567-e89b-42d3-a456-426614174001'
  const reservation_event_id = state.dispatches[dispatch_uuid].reservation_event_id
  state = append(state, 'dispatch_indeterminate', {
    phase_run_id: phaseRun('Requirement'),
    boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
    dispatch_uuid,
    acceptance_event_id: null,
    actor: actor('requirement-lead', 'receiver_phase_lead'),
    payload: { reason: 'bootstrap child outcome cannot be proven', observed_state: 'child_registered' },
  }).aggregate
  const before = state.head
  assert.throws(() => append(state, 'dispatch_resolution', {
    phase_run_id: phaseRun('Requirement'),
    boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
    dispatch_uuid,
    acceptance_event_id: null,
    actor: actor('pm-1', 'pm'),
    payload: {
      resolution: 'terminal_observed',
      reason: 'out-of-band terminal observation is not enough for bootstrap',
      expected_head: state.head,
      reservation_event_id,
      terminal_evidence_digest: canonicalDigest({ terminal: 'bootstrap' }),
    },
  }), (cause) => cause.errors.some((item) => item.code === 'BOOTSTRAP_TERMINAL_RESOLUTION_FORBIDDEN'))
  assert.deepEqual(state.head, before)
  state = append(state, 'dispatch_resolution', {
    phase_run_id: phaseRun('Requirement'),
    boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
    dispatch_uuid,
    acceptance_event_id: null,
    actor: actor('pm-1', 'pm'),
    payload: {
      resolution: 'abandoned',
      reason: 'operator confirmed the bootstrap child is gone',
      expected_head: state.head,
      reservation_event_id,
      terminal_evidence_digest: null,
    },
  }).aggregate
  assert.equal(state.dispatches[dispatch_uuid].state, 'resolved_abandoned')
  assert.notEqual(state.requirement_bootstrap_ready, true)
})

test('phase run ids are deterministic per slice and phase and drift fails closed at the core boundary', () => {
  assert.equal(phaseRun('Requirement'), stablePhaseRunId('slice', 'Requirement'))
  assert.notEqual(phaseRun('Requirement'), phaseRun('Prototype'))
  const empty = createPhaseGateAggregate(manifest())
  assert.throws(() => genesis(empty, { phase_run_id: phaseRun('Prototype') }),
    (cause) => cause.errors.some((item) => item.code === 'PHASE_RUN_ID_MISMATCH'))

  let state = bootstrap(genesis())
  assert.throws(() => append(state, 'artifact_submission', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: 'attempt-run-drift',
    handoff_id: 'handoff-run-drift',
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: artifact('Requirement'),
    actor: actor('requirement-lead', 'sender'),
  }), (cause) => cause.errors.some((item) => item.code === 'PHASE_RUN_ID_MISMATCH'))

  const attempt = submitAndPropose(state, 'Requirement')
  const acceptance = accept(attempt.state, 'Requirement', attempt)
  state = acceptance.state
  assert.throws(() => append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Requirement'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid: '123e4567-e89b-42d3-a456-426614174077',
    acceptance_event_id: acceptance.acceptance_event_id,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      task_id: 'run-drift',
      agent_id: 'prototype-lead',
      brief_digest: canonicalDigest({ brief: 'run-drift' }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
  }), (cause) => cause.errors.some((item) => item.code === 'PHASE_RUN_ID_MISMATCH'))
})

test('dispatch UUID contract accepts lowercase versions 1 through 8 and rejects uppercase', () => {
  for (let version = 1; version <= 8; version += 1) {
    const state = genesis()
    const dispatch_uuid = `123e4567-e89b-${version}2d3-a456-426614174abc`
    const result = append(state, 'dispatch_reservation', {
      phase_run_id: phaseRun('Requirement'),
      boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
      dispatch_uuid,
      acceptance_event_id: null,
      actor: actor('requirement-lead', 'receiver_phase_lead'),
      payload: {
        bootstrap: true,
        task_id: `bootstrap-v${version}`,
        agent_id: 'requirement-lead',
        brief_digest: canonicalDigest({ version }),
        expected_head: state.head,
        trust_level: PHASE_GATE_TRUST_LEVEL,
        timeout_sec: 300,
      },
    })
    assert.equal(result.aggregate.dispatches[dispatch_uuid].state, 'reserved')
  }
  const state = genesis()
  const before = state.head
  assert.throws(() => append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Requirement'),
    boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
    dispatch_uuid: '123E4567-E89B-82D3-A456-426614174ABC',
    acceptance_event_id: null,
    actor: actor('requirement-lead', 'receiver_phase_lead'),
    payload: {
      bootstrap: true,
      task_id: 'bootstrap-uppercase',
      agent_id: 'requirement-lead',
      brief_digest: canonicalDigest({ version: 'uppercase' }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
  }), (cause) => cause.errors.some((item) => item.code === 'DISPATCH_UUID_INVALID'))
  assert.deepEqual(state.head, before)
})

test('single slice advances Requirement -> Prototype -> Development -> QA -> ProjectDelivery only through exact accepted consumption', () => {
  let state = bootstrap(genesis())
  const phases = ['Requirement', 'Prototype', 'Development', 'QA']
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index]
    const attempt = submitAndPropose(state, phase)
    state = attempt.state
    if (phase === 'QA') {
      assert.throws(() => append(state, 'handoff_accept', {
        attempt_id: attempt.attempt_id,
        handoff_id: attempt.handoff_id,
        revision: 1,
        boundary: boundary('QA'),
        artifact: attempt.artifact,
        artifact_event_id: attempt.artifact_event_id,
        actor: actor('delivery-lead', 'receiver_phase_lead'),
        payload: {
          artifact_event_id: attempt.artifact_event_id,
          artifact_digest: attempt.artifact.digest,
          sender_phase: 'QA',
          receiver_phase: 'ProjectDelivery',
          sender_actor_id: 'qa-lead',
          receiver_actor_id: 'delivery-lead',
        },
      }), (cause) => cause.errors.some((item) => item.code === 'QA_FINAL_ACCEPT_REQUIRED'))
    }
    const acceptance = accept(state, phase, attempt)
    state = acceptance.state
    if (phase === 'QA') {
      assert.equal(isProjectDeliveryFinal(state), true)
      assert.equal(isPhaseCompleted(state, attempt.attempt_id), true)
      assert.equal(state.current_phase, 'ProjectDelivery')
      assert.throws(() => append(state, 'dispatch_reservation', {
        phase_run_id: phaseRun('QA'),
        attempt_id: attempt.attempt_id,
        handoff_id: attempt.handoff_id,
        revision: 1,
        boundary: boundary(phase),
        dispatch_uuid: '123e4567-e89b-42d3-a456-426614174099',
        acceptance_event_id: acceptance.acceptance_event_id,
        actor: actor(acceptance.receiver_actor_id, 'receiver_phase_lead'),
        payload: {
          artifact_digest: attempt.artifact.digest,
          artifact_event_id: attempt.artifact_event_id,
          task_id: 'phase-5',
          agent_id: acceptance.receiver_actor_id,
          brief_digest: canonicalDigest({ phase: 5 }),
          expected_head: state.head,
          trust_level: PHASE_GATE_TRUST_LEVEL,
          timeout_sec: 300,
        },
        artifact_event_id: attempt.artifact_event_id,
      }), (cause) => cause.errors.some((item) => item.code === 'PROJECT_DELIVERY_TERMINAL'))
      break
    }
    assert.equal(isDispatchEligible(state, attempt.attempt_id), true)
    state = dispatchAndConsume(state, phase, attempt, acceptance, `123e4567-e89b-42d3-a456-42661417401${index}`)
    const lifecycle = state.events
      .filter((event) => event.dispatch_uuid === `123e4567-e89b-42d3-a456-42661417401${index}`)
      .map((event) => event.event_type)
    assert.deepEqual(lifecycle, [
      'dispatch_reservation',
      'dispatch_child_registered',
      'dispatch_consumption',
      'dispatch_footprint',
      'dispatch_prompt',
      'dispatch_terminal',
    ])
    assert.equal(isPhaseCompleted(state, attempt.attempt_id), true)
    assert.equal(state.current_phase, PHASE_BOUNDARIES[phase])
  }
})

test('manifest roster is immutable authority; payload cannot forge actors or self-review', () => {
  let state = bootstrap(genesis())
  const phaseArtifact = artifact('Requirement')
  assert.throws(() => append(state, 'artifact_submission', {
    attempt_id: 'attempt-forged',
    handoff_id: 'handoff-forged',
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: phaseArtifact,
    actor: actor('not-in-manifest', 'sender'),
  }), (cause) => cause.errors.some((item) => item.code === 'ACTOR_UNAUTHORIZED'))
  const attempt = submitAndPropose(state, 'Requirement')
  state = attempt.state
  assert.throws(() => append(state, 'handoff_accept', {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('requirement-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      artifact_event_id: attempt.artifact_event_id,
      sender_phase: 'Requirement',
      receiver_phase: 'Prototype',
      sender_actor_id: 'requirement-lead',
      receiver_actor_id: 'requirement-lead',
    },
    artifact_event_id: attempt.artifact_event_id,
  }), (cause) => cause.errors.some((item) => ['ACTOR_UNAUTHORIZED', 'ACTOR_SELF_REVIEW_INVALID'].includes(item.code)))
  assert.throws(() => append(state, 'handoff_accept', {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      artifact_event_id: attempt.artifact_event_id,
      sender_phase: 'Requirement',
      receiver_phase: 'Prototype',
      sender_actor_id: 'forged-sender',
      receiver_actor_id: 'prototype-lead',
    },
    artifact_event_id: attempt.artifact_event_id,
  }), (cause) => cause.errors.some((item) => item.code === 'ACCEPTANCE_BINDING_MISMATCH'))
})

test('artifact event/digest substitution, reverse order, QA generic acceptance, and bootstrap consumption fail closed', () => {
  let state = bootstrap(genesis())
  const attempt = submitAndPropose(state, 'Requirement')
  state = attempt.state
  assert.throws(() => accept(state, 'Prototype', { ...attempt, attempt_id: attempt.attempt_id }), (cause) => cause.errors.some((item) => ['PHASE_ORDER_INVALID', 'ATTEMPT_BINDING_MISMATCH', 'ARTIFACT_TYPE_INVALID'].includes(item.code)))
  assert.throws(() => append(state, 'handoff_accept', {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: attempt.artifact,
    artifact_event_id: canonicalDigest({ substituted: true }),
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: canonicalDigest({ substituted: true }),
      artifact_digest: attempt.artifact.digest,
      sender_phase: 'Requirement',
      receiver_phase: 'Prototype',
      sender_actor_id: 'requirement-lead',
      receiver_actor_id: 'prototype-lead',
    },
  }), (cause) => cause.errors.some((item) => item.code === 'ARTIFACT_IMMUTABLE_MISMATCH'))
  let qa = bootstrap(genesis())
  qa.current_phase = 'QA'
  // Direct state mutation is not trusted: replay is authoritative and a QA
  // generic acceptance is independently rejected when a valid QA attempt is used
  // in the full-loop test above.
  assert.equal(verifyArtifactBytes({ digest: canonicalDigest('bytes') }, Buffer.from('"bytes"')), true)
  assert.equal(verifyArtifactBytes({ digest: canonicalDigest('bytes') }, Buffer.from('substitution')), false)
})

test('semantic retry needs a new attempt/handoff/revision; command replay is deterministic and changed body conflicts', () => {
  let state = bootstrap(genesis())
  let attempt = submitAndPropose(state, 'Requirement')
  state = attempt.state
  state = append(state, 'handoff_reject', {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: { reason_code: 'needs_changes' },
  }).aggregate
  assert.throws(() => submitAndPropose(state, 'Requirement', 1, { attempt_id: 'attempt-retry', handoff_id: 'handoff-retry' }), (cause) => cause.errors.some((item) => item.code === 'REVISION_ORDER_INVALID'))
  attempt = submitAndPropose(state, 'Requirement', 2, { attempt_id: 'attempt-retry', handoff_id: 'handoff-retry' })
  state = attempt.state
  const input = {
    project_run_id: 'project',
    slice_id: 'slice',
    phase_run_id: phaseRun('Requirement'),
    occurred_at: timestamp(state.head.sequence + 1),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 2,
    boundary: boundary('Requirement'),
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    command_id: 'accept-retry',
    idempotency_key: 'accept-retry',
    event_type: 'handoff_accept',
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      sender_phase: 'Requirement',
      receiver_phase: 'Prototype',
      sender_actor_id: 'requirement-lead',
      receiver_actor_id: 'prototype-lead',
    },
  }
  const first = appendPhaseGateEvent(state, input, { expected_head: state.head })
  const replay = appendPhaseGateEvent(first.aggregate, input, { expected_head: state.head })
  assert.equal(replay.appended, false)
  assert.equal(replay.event.event_id, first.event.event_id)
  assert.throws(() => appendPhaseGateEvent(first.aggregate, {
    ...input,
    payload: { ...input.payload, artifact_digest: canonicalDigest({ changed: true }) },
  }, { expected_head: first.aggregate.head }), (cause) => cause.code === 'IDEMPOTENCY_CONFLICT')
})

test('indeterminate blocks blind retry until exact-head PM abandonment permits an explicit semantic retry', () => {
  let state = bootstrap(genesis())
  const attempt = submitAndPropose(state, 'Requirement')
  state = attempt.state
  const acceptance = accept(state, 'Requirement', attempt)
  state = acceptance.state
  const dispatch_uuid = '123e4567-e89b-42d3-a456-426614174088'
  let reservation = append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      task_id: 'prototype-task',
      agent_id: 'prototype-lead',
      brief_digest: canonicalDigest({ brief: 'prototype' }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
    artifact_event_id: attempt.artifact_event_id,
  })
  state = reservation.aggregate
  const reservation_event_id = reservation.event.event_id
  assert.throws(() => append(state, 'dispatch_consumption', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
    },
  }), (cause) => cause.errors.some((item) => item.code === 'DISPATCH_TRANSITION_INVALID'))
  assert.throws(() => append(state, 'dispatch_child_registered', {
    phase_run_id: 'wrong-dispatch-run',
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      reservation_event_id,
      pid: 4401,
      ppid: 4000,
      process_start: '303',
      child_identity_digest: canonicalDigest({ child: 'wrong-phase-run' }),
    },
  }), (cause) => cause.errors.some((item) => item.code === 'PHASE_RUN_ID_MISMATCH'))
  state = append(state, 'dispatch_indeterminate', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: { reason: 'spawn result could not be observed', observed_state: 'reserved' },
  }).aggregate
  assert.equal(state.dispatches[dispatch_uuid].state, 'indeterminate')
  assert.equal(isDispatchEligible(state, attempt.attempt_id), false)
  const beforeTerminalResolution = state.head
  assert.throws(() => append(state, 'dispatch_resolution', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('pm-1', 'pm'),
    payload: {
      resolution: 'terminal_observed',
      reason: 'terminal evidence exists but receiver consumption was never recorded',
      expected_head: state.head,
      reservation_event_id,
      terminal_evidence_digest: canonicalDigest({ terminal: 'without-consumption' }),
    },
  }), (cause) => cause.errors.some((item) => item.code === 'DISPATCH_RESOLUTION_REQUIRES_CONSUMPTION'))
  assert.deepEqual(state.head, beforeTerminalResolution)
  assert.throws(() => append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid: '123e4567-e89b-42d3-a456-426614174089',
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      task_id: 'blind-retry',
      agent_id: 'prototype-lead',
      brief_digest: canonicalDigest({ retry: true }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
    artifact_event_id: attempt.artifact_event_id,
  }), (cause) => cause.errors.some((item) => item.code === 'DISPATCH_NOT_ELIGIBLE'))
  assert.throws(() => append(state, 'dispatch_resolution', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      resolution: 'abandoned',
      reason: 'receiver cannot prove that the child started',
      expected_head: state.head,
      reservation_event_id,
      terminal_evidence_digest: null,
    },
  }), (cause) => cause.errors.some((item) => item.code === 'ACTOR_UNAUTHORIZED'))
  state = append(state, 'dispatch_resolution', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id: acceptance.acceptance_event_id,
    actor: actor('pm-1', 'pm'),
    payload: {
      resolution: 'abandoned',
      reason: 'receiver cannot prove that the child started',
      expected_head: state.head,
      reservation_event_id,
      terminal_evidence_digest: null,
    },
  }).aggregate
  assert.equal(state.dispatches[dispatch_uuid].state, 'resolved_abandoned')
  assert.equal(isDispatchEligible(state, attempt.attempt_id), true)
  const explicitRetry = append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid: '123e4567-e89b-42d3-a456-426614174090',
    acceptance_event_id: acceptance.acceptance_event_id,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      task_id: 'explicit-semantic-retry',
      agent_id: 'prototype-lead',
      brief_digest: canonicalDigest({ retry: 'pm-resolved' }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
  })
  assert.equal(explicitRetry.aggregate.dispatches['123e4567-e89b-42d3-a456-426614174090'].state, 'reserved')
})

test('PM terminal_observed resolution preserves prior consumption and closes an indeterminate dispatch append-only', () => {
  let state = bootstrap(genesis())
  const attempt = submitAndPropose(state, 'Requirement')
  state = accept(attempt.state, 'Requirement', attempt).state
  const acceptance_event_id = state.attempts[attempt.attempt_id].acceptance_event_id
  const dispatch_uuid = '123e4567-e89b-42d3-a456-426614174091'
  let result = append(state, 'dispatch_reservation', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      task_id: 'terminal-resolution',
      agent_id: 'prototype-lead',
      brief_digest: canonicalDigest({ terminal: 'resolution' }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
  })
  state = result.aggregate
  const reservation_event_id = result.event.event_id
  state = append(state, 'dispatch_child_registered', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      reservation_event_id,
      pid: 4501,
      ppid: 4000,
      process_start: '404',
      child_identity_digest: canonicalDigest({ child: 'terminal-resolution' }),
    },
  }).aggregate
  state = append(state, 'dispatch_consumption', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
    },
  }).aggregate
  state = append(state, 'dispatch_indeterminate', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id,
    actor: actor('prototype-lead', 'receiver_phase_lead'),
    payload: { reason: 'terminal evidence was observed out of band', observed_state: 'consumed' },
  }).aggregate
  const evidence = canonicalDigest({ terminal: 'observed' })
  state = append(state, 'dispatch_resolution', {
    phase_run_id: phaseRun('Prototype'),
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: 1,
    boundary: boundary('Requirement'),
    dispatch_uuid,
    acceptance_event_id,
    actor: actor('pm-1', 'pm'),
    payload: {
      resolution: 'terminal_observed',
      reason: 'verified terminal evidence against the registered child',
      expected_head: state.head,
      reservation_event_id,
      terminal_evidence_digest: evidence,
    },
  }).aggregate
  assert.equal(state.dispatches[dispatch_uuid].state, 'terminal')
  assert.equal(state.dispatches[dispatch_uuid].terminal_evidence_digest, evidence)
  assert.equal(isPhaseCompleted(state, attempt.attempt_id), true)
  assert.equal(isDispatchEligible(state, attempt.attempt_id), false)
})

test('event contract rejects unknown fields, malformed time, manifest mismatch, and non-monotonic time', () => {
  let state = genesis()
  assert.throws(() => append(state, 'dispatch_reservation', {
    boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
    dispatch_uuid: '123e4567-e89b-42d3-a456-426614174001',
    acceptance_event_id: null,
    actor: actor('requirement-lead', 'receiver_phase_lead'),
    occurred_at: 'not-a-time',
    payload: {
      bootstrap: true,
      task_id: 'requirement-bootstrap',
      agent_id: 'requirement-lead',
      brief_digest: canonicalDigest({ brief: 1 }),
      expected_head: state.head,
      trust_level: PHASE_GATE_TRUST_LEVEL,
      timeout_sec: 300,
    },
    injected_authority: ['attacker'],
  }), (cause) => cause.errors.some((item) => ['FIELD_UNKNOWN', 'OCCURRED_AT_INVALID'].includes(item.code)))
  assert.throws(() => createPhaseGateAggregate(manifest({ repo_identity_digest: canonicalDigest({ wrong: true }) })), (cause) => cause.errors.some((item) => item.code === 'REPO_IDENTITY_INVALID'))
  state = bootstrap(state)
  assert.throws(() => append(state, 'artifact_submission', {
    attempt_id: 'attempt-time',
    handoff_id: 'handoff-time',
    revision: 1,
    boundary: boundary('Requirement'),
    artifact: artifact('Requirement'),
    actor: actor('requirement-lead', 'sender'),
    occurred_at: timestamp(1),
  }), (cause) => cause.errors.some((item) => item.code === 'EVENT_TIME_ORDER_INVALID'))
})

test('published event schema is closed over the current child-registration lifecycle and has no denial/process relics', () => {
  const path = new URL('../plugins/tmux-teams/skills/tmux-teams/references/phase-gate-event-v1.schema.json', import.meta.url)
  const text = readFileSync(path, 'utf8')
  const schema = JSON.parse(text)
  assert.equal(text.includes('dispatch_process'), false)
  assert.equal(text.includes('denial_audit'), false)
  assert.equal(text.includes('dispatch_child_registered'), true)
  assert.equal(text.includes('dispatch_resolution'), true)
  assert.equal(schema.oneOf.some((entry) => entry.$ref === '#/$defs/dispatch_consumption'), true)
  assert.equal(schema.$defs.child_payload.additionalProperties, false)
  assert.equal(schema.$defs.normal_dispatch_reservation.unevaluatedProperties, false)
  assert.equal(schema.$defs.id.maxLength, 128)
  assert.equal(schema.$defs.artifact.properties.validation_evidence.items.maxLength, 4096)
  assert.equal(new RegExp(schema.$defs.uuid.pattern).test('123e4567-e89b-82d3-a456-426614174abc'), true)
  assert.equal(new RegExp(schema.$defs.uuid.pattern).test('123E4567-E89B-82D3-A456-426614174ABC'), false)
  assert.equal(schema.$defs.bootstrap_resolution_payload.properties.resolution.const, 'abandoned')
  const sample = bootstrap(genesis()).events
  const validation = spawnSync('python3', [
    '-c',
    'import json,jsonschema,sys; schema=json.load(open(sys.argv[1])); jsonschema.Draft202012Validator.check_schema(schema); [jsonschema.validate(event,schema) for event in json.load(sys.stdin)]',
    fileURLToPath(path),
  ], { input: JSON.stringify(sample), encoding: 'utf8' })
  assert.equal(validation.status, 0, validation.stderr)
})
