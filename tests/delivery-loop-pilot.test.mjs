import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COST_CATEGORIES,
  GUARDRAIL_NAMES,
  analyzeExperiment,
  canonicalDigest,
  canonicalJson,
  validateExperiment,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-core.mjs'
import {
  ASSIGNMENT_ALGORITHM,
  EVENT_SCHEMA_VERSION,
  PILOT_MANIFEST_VERSION,
  PilotValidationError,
  appendPilotEvent,
  buildEvidencePack,
  compileExperiment,
  createAssignmentEvent,
  freezePilotManifest,
  validateFrozenManifest,
  verifyEvidencePack,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PILOT_CORE = join(
  ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts',
  'delivery-loop-pilot-core.mjs',
)
const SEED = 'stage1-rehearsal-seed-2026-07-23'
const FROZEN_AT = '2026-07-01T00:00:00.000Z'
const ASSIGNED_AT = '2026-07-03T00:00:00.000Z'
const ANALYSIS_AS_OF = '2026-07-23T00:00:00.000Z'
const ACTORS = {
  assignment: 'experiment-owner',
  sender: 'sender-a',
  receiver: 'qa-lead',
  pm: 'pm-a',
  metric: 'metric-producer',
}

const clone = (value) => structuredClone(value)
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function manifestInput() {
  const costInstrumentation = Object.fromEntries(
    COST_CATEGORIES.map((category, index) => [
      category,
      {
        method_id: `cost-method-${index + 1}`,
        method: `Directly observe ${category} for the assigned slice.`,
        owner_actor_id: ACTORS.metric,
        source_kind: 'manual_observation',
        unit: 'minute',
        unknown_value_policy: 'record_explicit_null',
      },
    ]),
  )
  const guardrailInstrumentation = Object.fromEntries(
    GUARDRAIL_NAMES.map((guardrail, index) => [
      guardrail,
      {
        method_id: `guardrail-method-${index + 1}`,
        method: `Review named ${guardrail} evidence for the assigned slice.`,
        owner_actor_id: 'guardrail-producer',
        evidence_requirement: 'named_reference_and_sha256_digest',
      },
    ]),
  )
  return {
    schema_version: PILOT_MANIFEST_VERSION,
    manifest_id: 'stage1-manifest-001',
    experiment_id: 'stage1-development-qa-pilot',
    automatic_routing: false,
    boundary: {
      sender_phase: 'Development',
      receiver_phase: 'QA',
      artifact_type: 'development_delivery',
    },
    hypothesis: 'Receiver-owned handoffs reduce per-slice coordination cost without harming mature outcomes.',
    primary_kpis: [
      'total_coordination_minutes',
      'incremental_loaded_cost',
      'time_to_usable_outcome_minutes',
      'value_proxy',
    ],
    guardrails: [...GUARDRAIL_NAMES],
    eligibility: {
      population_description: 'All prospectively observed Development to QA delivery slices.',
      inclusion_criteria: ['A stable slice identifier exists before assignment.'],
      exclusion_criteria: ['The slice entered QA before the assignment window.'],
      stable_slice_id_method: 'canonical_source_id',
      eligible_source_ref: 'fixture://stage1/eligible-slices',
      eligible_source_digest: canonicalDigest({ fixture: 'eligible-slices-v1' }),
      strata: ['phase', 'complexity'],
      enrollment_policy: 'prospective_all_eligible',
      eligibility_owner_actor_id: ACTORS.assignment,
    },
    assignment: {
      method: ASSIGNMENT_ALGORITHM,
      method_version: 1,
      arms: ['pm_routed', 'receiver_owned'],
      control_arm: 'pm_routed',
      treatment_arm: 'receiver_owned',
      allocation: { pm_routed: 1, receiver_owned: 1 },
      assignment_window: {
        start: '2026-07-02T00:00:00.000Z',
        end: '2026-08-01T00:00:00.000Z',
        interval: 'half_open_start_inclusive_end_exclusive',
      },
      assignment_custodian_actor_id: ACTORS.assignment,
      arm_override_allowed: false,
      retain_assigned_arm: true,
    },
    assignment_seed: SEED,
    sample_plan: {
      min_assigned_per_arm: 1,
      min_mature_per_arm: 1,
      target_assigned_total: 2,
      power_method: 'feasibility_bound',
      power_reference: 'fixture://stage1/power-plan',
      rationale: 'Two slices provide a deterministic both-arm Stage 1 rehearsal, not an efficacy claim.',
    },
    maturity: {
      min_follow_up_days: 7,
      outcome_states: ['mature', 'immature', 'censored', 'pending', 'cancelled', 'abandoned'],
      endpoint_definition: 'The first independently observed usable outcome after terminal handoff.',
      maturity_owner_actor_id: ACTORS.metric,
    },
    stopping_rule: {
      window_end: '2026-08-01T00:00:00.000Z',
      max_assigned_slices: 2,
      allowed_stop_reasons: ['ASSIGNMENT_WINDOW_ENDED', 'MAX_ASSIGNED_REACHED'],
      manual_stop_owner_actor_id: 'business-owner',
      post_outcome_rule_changes_allowed: false,
      automatic_safety_actuation: false,
    },
    thresholds: {
      min_mature_per_arm: 1,
      coordination_reduction_percent: 10,
      incremental_cost_reduction_percent: 10,
      time_to_usable_noninferiority_minutes: 5,
      value_noninferiority_margin: 2,
    },
    cost_model: {
      loaded_cost_per_minute: 2,
      currency: 'USD',
      unit: 'minute',
      allocation_basis: 'Direct observation by preregistered cost category.',
    },
    cost_instrumentation: costInstrumentation,
    outcome_instrumentation: {
      time_to_usable_outcome_minutes: {
        method_id: 'outcome-time-method',
        method: 'Observe elapsed minutes from assignment to the first usable mature outcome.',
        owner_actor_id: ACTORS.metric,
        unit: 'minute',
      },
      value_proxy: {
        method_id: 'outcome-value-method',
        method: 'Record the preregistered declared value proxy.',
        owner_actor_id: ACTORS.metric,
        unit: 'declared_value_unit',
      },
      maturity_status: {
        method_id: 'outcome-maturity-method',
        method: 'Classify maturity using the frozen endpoint and follow-up rule.',
        owner_actor_id: ACTORS.metric,
        unit: 'declared_value_unit',
      },
    },
    guardrail_instrumentation: guardrailInstrumentation,
    missing_data: {
      maximum_unknown_cost_fraction: 0,
      maximum_missing_mature_outcome_fraction: 0,
      cost_policy: 'explicit_null_never_zero',
      outcome_policy: 'retain_and_report_non_mature_by_assigned_arm',
      retain_all_assigned_slices: true,
      owner_actor_id: ACTORS.metric,
    },
    contamination: {
      maximum_contaminated_fraction: 0,
      detection_method_id: 'contamination-method',
      detection_method: 'Compare observed routing facts with the assigned arm instructions.',
      owner_actor_id: ACTORS.metric,
      retain_assigned_arm: true,
      treatment_instruction_ref: 'fixture://stage1/receiver-owned-instructions',
      treatment_instruction_digest: canonicalDigest({ instructions: 'receiver-owned-v1' }),
      control_instruction_ref: 'fixture://stage1/pm-routed-instructions',
      control_instruction_digest: canonicalDigest({ instructions: 'pm-routed-v1' }),
    },
    roles: {
      business_owner_ids: ['business-owner'],
      pm_ids: [ACTORS.pm],
      sender_ids: [ACTORS.sender],
      receiver_phase_lead_ids: [ACTORS.receiver],
      experiment_owner_ids: ['experiment-owner'],
      assignment_custodian_ids: [ACTORS.assignment],
      metric_producer_ids: [ACTORS.metric],
      guardrail_producer_ids: ['guardrail-producer'],
      external_reviewer_ids: ['external-reviewer'],
    },
    actors: {
      senders: [ACTORS.sender],
      pms: [ACTORS.pm],
      phase_leads: {
        Requirement: ['requirement-lead'],
        Prototype: ['prototype-lead'],
        Development: ['development-lead'],
        QA: [ACTORS.receiver],
        ProjectDelivery: ['project-delivery-lead'],
      },
      certifiers: ['external-reviewer'],
      experiment_owners: ['experiment-owner'],
      metric_producers: [ACTORS.metric],
      business_owners: ['business-owner'],
    },
    role_separation: {
      external_reviewer_outside_same_uid: true,
      external_reviewer_no_operational_role_overlap: true,
      routine_receiver_is_not_pm: true,
      assignment_custodian_not_metric_producer: true,
      business_owner_not_metric_producer: true,
      metric_producer_not_external_reviewer: true,
    },
    external_anchor: {
      required: true,
      anchor_type: 'separate_principal_custody',
      anchor_ref: 'fixture://stage1/external-anchor',
      anchor_digest: canonicalDigest({ anchor: 'stage1-manifest-001' }),
      anchored_at: FROZEN_AT,
      custodian_actor_id: 'external-reviewer',
      custody_principal: 'fixture-external-review-principal',
      outside_worker_writable_repository: true,
    },
    analysis_plan: {
      estimand: 'per_slice_mean_by_arm',
      analysis_as_of: ANALYSIS_AS_OF,
      comparison: 'intention_to_treat_receiver_owned_vs_pm_routed',
      contamination_analysis: 'report_and_retain_in_assigned_arm',
      missing_data_analysis: 'report_complete_case_metrics_with_itt_denominators',
      business_decision_authority: 'EXTERNAL_REQUIRED',
      actuation: 'NONE',
    },
  }
}

function freeze(input = manifestInput()) {
  return freezePilotManifest(input, { frozenAt: FROZEN_AT })
}

function validationErrors(result) {
  if (result === true || result?.valid === true) return []
  if (Array.isArray(result)) return result
  return result?.errors ?? result?.diagnostics ?? []
}

function assertFrozenValid(manifest) {
  const result = validateFrozenManifest(manifest)
  assert.deepEqual(validationErrors(result), [], JSON.stringify(result))
}

function errorDetails(error) {
  return error?.errors ?? error?.diagnostics ?? []
}

function hasCode(error, code) {
  return error instanceof PilotValidationError
    && (error.code === code || errorDetails(error).some((detail) => detail.code === code))
}

function assertThrowsCode(fn, code, message = code) {
  assert.throws(fn, (error) => hasCode(error, code), message)
}

function assertManifestInvalid(manifest, code) {
  try {
    const result = validateFrozenManifest(manifest)
    assert.ok(validationErrors(result).some((detail) => detail.code === code),
      `${code}: ${JSON.stringify(result)}`)
  } catch (error) {
    assert.ok(hasCode(error, code), `${code}: ${error?.stack ?? error}`)
  }
}

function candidate(index, complexity = index % 2 ? 'M' : 'S') {
  return {
    slice_id: `stage1-slice-${String(index).padStart(3, '0')}`,
    strata: { phase: 'Development', complexity },
    eligible: true,
  }
}

function assignmentOptions(overrides = {}) {
  return {
    assignedAt: ASSIGNED_AT,
    recordedAt: ASSIGNED_AT,
    actorId: ACTORS.assignment,
    assignmentSeed: SEED,
    ...overrides,
  }
}

function eventsOf(ledger) {
  if (Array.isArray(ledger)) return ledger
  if (Array.isArray(ledger?.events)) return ledger.events
  if (Array.isArray(ledger?.ledger)) return ledger.ledger
  throw new Error(`Unsupported ledger shape: ${JSON.stringify(ledger)}`)
}

function appended(result) {
  if (Array.isArray(result) || Array.isArray(result?.events)) return result
  if (Array.isArray(result?.ledger)) return result.ledger
  throw new Error(`Unsupported append result: ${JSON.stringify(result)}`)
}

function append(manifest, ledger, event) {
  return appended(appendPilotEvent(manifest, ledger, event))
}

function assignmentPayload(event) {
  return event.payload?.assignment ?? event.payload
}

function armOf(event) {
  return assignmentPayload(event).arm
}

function sliceIdOf(event) {
  return assignmentPayload(event).slice_id
}

function assign(manifest, ledger, value, overrides = {}) {
  const event = createAssignmentEvent(
    manifest, ledger, value, assignmentOptions(overrides),
  )
  return { event, ledger: append(manifest, ledger, event) }
}

function independentArm(manifest, value) {
  const message = [
    ASSIGNMENT_ALGORITHM,
    manifest.manifest_digest,
    canonicalJson(value.strata),
    value.slice_id,
  ].join('\0')
  const digest = createHmac('sha256', SEED).update(message).digest('hex')
  return BigInt(`0x${digest}`) % 2n === 0n ? 'pm_routed' : 'receiver_owned'
}

function eventBoundary(manifest) {
  return {
    sender_phase: manifest.boundary.sender_phase,
    receiver_phase: manifest.boundary.receiver_phase,
  }
}

function sourceFor(eventType, aggregateId, payload) {
  const source_ref = `fixture://stage1/${aggregateId}/${eventType}`
  return {
    kind: 'manual_observation',
    source_ref,
    source_digest: canonicalDigest({ source_ref, payload }),
    trust_level: 'advisory_same_uid',
  }
}

function makeEnvelope(manifest, ledger, {
  aggregateType,
  aggregateId,
  eventType,
  occurredAt,
  actorId,
  actorRole,
  payload,
  source,
  sequence,
  previousEventId,
}) {
  const prior = eventsOf(ledger)
    .filter((event) => event.aggregate?.type === aggregateType && event.aggregate?.id === aggregateId)
    .sort((left, right) => left.aggregate.sequence - right.aggregate.sequence)
    .at(-1)
  const unsigned = {
    schema: 'tmux-teams.delivery-loop-event',
    schema_version: EVENT_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    aggregate: {
      type: aggregateType,
      id: aggregateId,
      sequence: sequence ?? (prior ? prior.aggregate.sequence + 1 : 1),
      previous_event_id: previousEventId ?? prior?.event_id ?? null,
    },
    event_type: eventType,
    occurred_at: occurredAt,
    claimed_actor: { actor_id: actorId, role: actorRole },
    source: source ?? sourceFor(eventType, aggregateId, payload),
    payload,
  }
  return { ...unsigned, event_id: canonicalDigest(unsigned) }
}

function artifact(suffix) {
  return {
    type: 'development_delivery',
    artifact_id: `delivery-${suffix}`,
    version: '1',
    digest: canonicalDigest({ artifact: suffix }),
    predecessor_trace: [`prototype-${suffix}`],
    validation_evidence: ['unit-tests', 'integration-tests'],
    expectations: {
      security: 'pass',
      performance: 'pass',
      integration: 'pass',
      uat: 'pass',
    },
    working_software_ref: `build://${suffix}`,
  }
}

function artifactPayload(
  manifest,
  sliceId,
  attemptId,
  suffix = attemptId,
  observedAt = '2026-07-04T00:00:00.000Z',
) {
  const value = artifact(suffix)
  return {
    slice_id: sliceId,
    attempt_id: attemptId,
    artifact_id: value.artifact_id,
    artifact_type: value.type,
    artifact_version: value.version,
    artifact_digest: value.digest,
    boundary: eventBoundary(manifest),
    predecessor_trace: value.predecessor_trace.map((item) => canonicalDigest(item)),
    validation_evidence_digests: value.validation_evidence.map((item) => canonicalDigest(item)),
    observed_at: observedAt,
  }
}

function transitionPayload(manifest, {
  sliceId,
  attemptId,
  action,
  artifactEventId,
  revisionOf = null,
  transitionAt,
}) {
  const states = {
    propose: ['draft', 'proposed'],
    accept: ['proposed', 'accepted'],
    reject: ['proposed', 'rejected'],
    cancel: ['proposed', 'cancelled'],
    abandon: ['proposed', 'abandoned'],
    escalate: ['proposed', 'escalated'],
    resolve_exception: ['escalated', 'proposed'],
  }
  return {
    slice_id: sliceId,
    attempt_id: attemptId,
    boundary: eventBoundary(manifest),
    action,
    from_state: states[action][0],
    to_state: states[action][1],
    sender_actor_id: ACTORS.sender,
    receiver_actor_id: ACTORS.receiver,
    artifact_event_id: artifactEventId,
    revision_of_attempt_id: revisionOf,
    transition_at: transitionAt,
  }
}

function costValues(arm) {
  return Object.fromEntries(COST_CATEGORIES.map((category, index) => {
    const base = arm === 'pm_routed' ? 12 : 4
    return [category, category.includes('work_minutes') ? 0 : base + index]
  }))
}

function appendCompleteSlice(manifest, initialLedger, value, {
  terminal = 'accept',
  contaminated = false,
  omitCost,
  unknownCost,
} = {}) {
  let ledger = initialLedger
  const assignment = assign(manifest, ledger, value)
  ledger = assignment.ledger
  const arm = armOf(assignment.event)
  const attemptId = `${value.slice_id}-attempt-1`
  const receiver = terminal === 'accept' || terminal === 'reject' ? ACTORS.receiver : ACTORS.pm
  const terminalRole = terminal === 'accept' || terminal === 'reject' ? 'receiver_phase_lead' : 'pm'
  const observedArtifact = artifact(value.slice_id)
  const artifactEvent = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'artifact_observed',
    occurredAt: '2026-07-04T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: {
      slice_id: value.slice_id,
      attempt_id: attemptId,
      artifact_id: observedArtifact.artifact_id,
      artifact_type: observedArtifact.type,
      artifact_version: observedArtifact.version,
      artifact_digest: observedArtifact.digest,
      boundary: eventBoundary(manifest),
      predecessor_trace: observedArtifact.predecessor_trace.map((item) => canonicalDigest(item)),
      validation_evidence_digests: observedArtifact.validation_evidence.map((item) => canonicalDigest(item)),
      observed_at: '2026-07-04T00:00:00.000Z',
    },
  })
  ledger = append(manifest, ledger, artifactEvent)
  const propose = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-05T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: {
      slice_id: value.slice_id,
      attempt_id: attemptId,
      boundary: eventBoundary(manifest),
      action: 'propose',
      from_state: 'draft',
      to_state: 'proposed',
      sender_actor_id: ACTORS.sender,
      receiver_actor_id: ACTORS.receiver,
      artifact_event_id: artifactEvent.event_id,
      revision_of_attempt_id: null,
      transition_at: '2026-07-05T00:00:00.000Z',
    },
  })
  ledger = append(manifest, ledger, propose)
  const terminalState = {
    accept: 'accepted', reject: 'rejected', cancel: 'cancelled', abandon: 'abandoned',
  }[terminal]
  ledger = append(manifest, ledger, makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-06T00:00:00.000Z',
    actorId: receiver,
    actorRole: terminalRole,
    payload: {
      slice_id: value.slice_id,
      attempt_id: attemptId,
      boundary: eventBoundary(manifest),
      action: terminal,
      from_state: 'proposed',
      to_state: terminalState,
      sender_actor_id: ACTORS.sender,
      receiver_actor_id: ACTORS.receiver,
      artifact_event_id: artifactEvent.event_id,
      revision_of_attempt_id: null,
      transition_at: '2026-07-06T00:00:00.000Z',
    },
  }))

  for (const [index, [category, minutes]] of Object.entries(costValues(arm)).entries()) {
    if (category === omitCost) continue
    const unknown = category === unknownCost
    const aggregateId = `${value.slice_id}-cost-${index}`
    const method = manifest.cost_instrumentation?.[category]
    ledger = append(manifest, ledger, makeEnvelope(manifest, ledger, {
      aggregateType: 'observation',
      aggregateId,
      eventType: 'cost_observed',
      occurredAt: '2026-07-07T00:00:00.000Z',
      actorId: ACTORS.metric,
      actorRole: 'metric_producer',
      payload: {
        slice_id: value.slice_id,
        category,
        measurement_status: unknown ? 'unknown' : 'measured',
        minutes: unknown ? null : minutes,
        method_id: method?.method_id ?? `method-${index}`,
        owner_actor_id: ACTORS.metric,
        measured_at: '2026-07-07T00:00:00.000Z',
      },
    }))
  }

  ledger = append(manifest, ledger, makeEnvelope(manifest, ledger, {
    aggregateType: 'observation',
    aggregateId: `${value.slice_id}-outcome`,
    eventType: 'outcome_observed',
    occurredAt: '2026-07-15T00:00:00.000Z',
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      slice_id: value.slice_id,
      status: 'mature',
      time_to_usable_outcome_minutes: arm === 'pm_routed' ? 100 : 95,
      value_proxy: arm === 'pm_routed' ? 50 : 51,
      method_id: manifest.outcome_instrumentation?.time_to_usable_outcome_minutes?.method_id
        ?? 'outcome-method',
      owner_actor_id: ACTORS.metric,
      measured_at: '2026-07-15T00:00:00.000Z',
    },
  }))

  for (const [index, name] of GUARDRAIL_NAMES.entries()) {
    const method = manifest.guardrail_instrumentation?.[name]
    ledger = append(manifest, ledger, makeEnvelope(manifest, ledger, {
      aggregateType: 'observation',
      aggregateId: `${value.slice_id}-guard-${index}`,
      eventType: 'guardrail_observed',
      occurredAt: '2026-07-16T00:00:00.000Z',
      actorId: 'guardrail-producer',
      actorRole: 'guardrail_producer',
      payload: {
        slice_id: value.slice_id,
        guardrail: name,
        status: 'PASS',
        evidence_ref: `fixture://stage1/${value.slice_id}/${name}`,
        evidence_digest: canonicalDigest({ slice_id: value.slice_id, name, status: 'PASS' }),
        method_id: method?.method_id ?? `guard-${index}`,
        owner_actor_id: 'guardrail-producer',
        measured_at: '2026-07-16T00:00:00.000Z',
      },
    }))
  }

  ledger = append(manifest, ledger, makeEnvelope(manifest, ledger, {
    aggregateType: 'observation',
    aggregateId: `${value.slice_id}-contamination`,
    eventType: 'contamination_observed',
    occurredAt: '2026-07-16T00:00:01.000Z',
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      slice_id: value.slice_id,
      contaminated,
      reason_code: contaminated ? 'ARM_INSTRUCTION_CROSSED' : 'NO_CONTAMINATION_OBSERVED',
      method_id: manifest.contamination?.detection_method_id ?? 'contamination-method',
      owner_actor_id: ACTORS.metric,
      observed_at: '2026-07-16T00:00:01.000Z',
    },
  }))
  return { ledger, assignment: assignment.event, attemptId }
}

function selectBothArms(manifest) {
  const selected = new Map()
  for (let index = 1; index <= 128 && selected.size < 2; index++) {
    const value = candidate(index)
    const arm = independentArm(manifest, value)
    if (!selected.has(arm)) selected.set(arm, value)
  }
  assert.deepEqual([...selected.keys()].sort(), ['pm_routed', 'receiver_owned'])
  return selected
}

function completeRehearsal(manifest, { contaminatedArm, omitCost, unknownCost } = {}) {
  let ledger = []
  const assignments = []
  for (const [arm, value] of selectBothArms(manifest)) {
    const completed = appendCompleteSlice(manifest, ledger, value, {
      contaminated: contaminatedArm === arm,
      omitCost: omitCost?.arm === arm ? omitCost.category : undefined,
      unknownCost: unknownCost?.arm === arm ? unknownCost.category : undefined,
    })
    ledger = completed.ledger
    assignments.push(completed.assignment)
  }
  return { ledger, assignments }
}

function experimentOf(compiled) {
  return compiled?.experiment ?? compiled?.dataset ?? compiled
}

function verifyResultValid(result) {
  return result === true || result?.valid === true || result?.verified === true
}

function walk(value, visit, path = '$') {
  visit(value, path)
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walk(item, visit, `${path}.${key}`)
  }
}

test('freeze produces a closed immutable manifest, commits the secret seed, and forbids actuation', () => {
  const input = manifestInput()
  const before = clone(input)
  const manifest = freeze(input)
  assert.deepEqual(input, before, 'freezing must not mutate caller input')
  assertFrozenValid(manifest)
  assert.equal(manifest.frozen_at, FROZEN_AT)
  assert.equal(manifest.assignment.method, ASSIGNMENT_ALGORITHM)
  assert.equal(manifest.assignment.seed_commitment, sha256(SEED))
  assert.equal(manifest.automatic_routing, false)
  assert.deepEqual(Object.keys(manifest.guardrail_instrumentation).sort(),
    [...GUARDRAIL_NAMES].sort())
  assert.equal(manifest.analysis_plan.actuation, 'NONE')
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(manifest.manifest_digest))
  walk(manifest, (value, path) => {
    assert.notEqual(value, SEED, `secret seed leaked at ${path}`)
  })

  const unknown = clone(manifest)
  unknown.unregistered_control = true
  assertManifestInvalid(unknown, 'MANIFEST_UNKNOWN_FIELD')

  const mutated = clone(manifest)
  mutated.thresholds.coordination_reduction_percent += 1
  assertManifestInvalid(mutated, 'MANIFEST_DIGEST_MISMATCH')

  const routing = manifestInput()
  routing.automatic_routing = true
  assertThrowsCode(() => freeze(routing), 'AUTOMATIC_ROUTING_FORBIDDEN')
})

test('preregistration requires all controls, all cost methods, and separated business/evidence/metric roles', () => {
  for (const [mutate, code] of [
    [(input) => { delete input.boundary }, 'BOUNDARY_REQUIRED'],
    [(input) => { input.sample_plan = {} }, 'SAMPLE_PLAN_INVALID'],
    [(input) => {
      delete input.guardrail_instrumentation.security
    }, 'GUARDRAIL_INSTRUMENTATION_REQUIRED'],
    [(input) => {
      delete input.cost_instrumentation.queue_wait_minutes
    }, 'COST_INSTRUMENTATION_REQUIRED'],
    [(input) => {
      input.contamination.maximum_contaminated_fraction = 1.01
    }, 'CONTAMINATION_THRESHOLD_INVALID'],
    [(input) => {
      input.roles.external_reviewer_ids = [ACTORS.metric]
    }, 'ROLE_SEPARATION_INVALID'],
    [(input) => {
      input.roles.business_owner_ids = [ACTORS.metric]
    }, 'ROLE_SEPARATION_INVALID'],
    [(input) => {
      input.assignment.assignment_window.start = input.assignment.assignment_window.end
    }, 'ASSIGNMENT_WINDOW_INVALID'],
  ]) {
    const input = manifestInput()
    mutate(input)
    assertThrowsCode(() => freeze(input), code)
  }
  assert.deepEqual(Object.keys(manifestInput().cost_instrumentation).sort(),
    [...COST_CATEGORIES].sort())
})

test('stratified HMAC assignment is independently reproducible, order-independent, and has no arm override', () => {
  const manifest = freeze()
  const values = Array.from({ length: 24 }, (_, index) => candidate(index + 1))

  function run(order) {
    let ledger = []
    const rows = new Map()
    for (const value of order) {
      const result = assign(manifest, ledger, value)
      ledger = result.ledger
      rows.set(value.slice_id, {
        arm: armOf(result.event),
        event_id: result.event.event_id,
        sequence: result.event.aggregate.sequence,
      })
      assert.equal(armOf(result.event), independentArm(manifest, value), value.slice_id)
    }
    return { ledger, rows }
  }

  const forward = run(values)
  const reverse = run([...values].reverse())
  assert.deepEqual(forward.rows, reverse.rows)
  assert.deepEqual(new Set([...forward.rows.values()].map(({ arm }) => arm)),
    new Set(['pm_routed', 'receiver_owned']))
  assert.ok([...forward.rows.values()].every(({ sequence }) => sequence === 1),
    'sequence is per aggregate, not global ledger order')

  const first = eventsOf(forward.ledger)[0]
  assert.deepEqual(Object.keys(first).sort(), [
    'aggregate', 'claimed_actor', 'event_id', 'event_type', 'experiment_id',
    'manifest_digest', 'occurred_at', 'payload', 'schema', 'schema_version', 'source',
  ])
  assert.equal(first.schema_version, EVENT_SCHEMA_VERSION)
  assert.equal(first.event_type, 'slice_assigned')

  const override = candidate(101)
  override.arm = 'receiver_owned'
  assertThrowsCode(() => assign(manifest, [], override), 'ARM_OVERRIDE_FORBIDDEN')
  assertThrowsCode(() => assign(manifest, [], candidate(102), { assignmentSeed: 'wrong-secret' }),
    'ASSIGNMENT_SEED_MISMATCH')
})

test('assignment is append-only: exact recapture is idempotent and conflicting reassignment is rejected', () => {
  const manifest = freeze()
  const value = candidate(1)
  const created = createAssignmentEvent(manifest, [], value, assignmentOptions())
  const once = append(manifest, [], created)
  const twice = append(manifest, once, created)
  assert.deepEqual(twice, once)

  const rerun = createAssignmentEvent(manifest, once, value, assignmentOptions())
  assert.equal(rerun.event_id, created.event_id)
  assert.equal(armOf(rerun), armOf(created))

  const changed = clone(value)
  changed.strata.complexity = changed.strata.complexity === 'M' ? 'S' : 'M'
  assertThrowsCode(() => createAssignmentEvent(manifest, once, changed, assignmentOptions()),
    'ASSIGNMENT_CONFLICT')

  const atEnd = manifest.assignment.assignment_window.end
  assertThrowsCode(() => assign(manifest, [], candidate(2), {
    assignedAt: atEnd,
    recordedAt: atEnd,
  }), 'ASSIGNMENT_OUTSIDE_WINDOW')
})

test('event ledger rejects closed-envelope drift, aggregate gaps/forks, actor violations, and post-terminal mutation', () => {
  const manifest = freeze()
  const value = candidate(1)
  let ledger = assign(manifest, [], value).ledger
  const attemptId = `${value.slice_id}-attempt`
  const artifactEvent = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'artifact_observed',
    occurredAt: '2026-07-04T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: artifactPayload(manifest, value.slice_id, attemptId, 'event-contract'),
  })
  const mismatchedArtifactTime = clone(artifactEvent)
  mismatchedArtifactTime.payload.observed_at = '2026-07-04T00:00:00.001Z'
  delete mismatchedArtifactTime.event_id
  mismatchedArtifactTime.event_id = canonicalDigest(mismatchedArtifactTime)
  assertThrowsCode(
    () => append(manifest, ledger, mismatchedArtifactTime),
    'ARTIFACT_INVALID',
  )
  ledger = append(manifest, ledger, artifactEvent)
  assert.deepEqual(append(manifest, ledger, artifactEvent), ledger, 'exact recapture is a no-op')

  const unknown = { ...makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-05T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'propose',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-05T00:00:00.000Z',
    }),
  }), extra: true }
  delete unknown.event_id
  unknown.event_id = canonicalDigest(unknown)
  assertThrowsCode(() => append(manifest, ledger, unknown), 'EVENT_UNKNOWN_FIELD')

  const gap = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-05T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    sequence: 3,
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'propose',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-05T00:00:00.000Z',
    }),
  })
  assertThrowsCode(() => append(manifest, ledger, gap), 'AGGREGATE_SEQUENCE_GAP')

  const unauthorized = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-05T00:00:00.000Z',
    actorId: ACTORS.pm,
    actorRole: 'pm',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'propose',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-05T00:00:00.000Z',
    }),
  })
  assertThrowsCode(() => append(manifest, ledger, unauthorized), 'ACTOR_UNAUTHORIZED')

  const before = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-02T23:59:59.999Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'propose',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-02T23:59:59.999Z',
    }),
  })
  assertThrowsCode(() => append(manifest, ledger, before), 'EVENT_BEFORE_ASSIGNMENT')

  const propose = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-05T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'propose',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-05T00:00:00.000Z',
    }),
  })
  ledger = append(manifest, ledger, propose)
  const fork = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-05T00:00:00.001Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    sequence: propose.aggregate.sequence,
    previousEventId: artifactEvent.event_id,
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'propose',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-05T00:00:00.001Z',
    }),
  })
  assertThrowsCode(() => append(manifest, ledger, fork), 'AGGREGATE_FORK')

  const accept = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-06T00:00:00.000Z',
    actorId: ACTORS.receiver,
    actorRole: 'receiver_phase_lead',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'accept',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-06T00:00:00.000Z',
    }),
  })
  ledger = append(manifest, ledger, accept)
  const postTerminal = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-07T00:00:00.000Z',
    actorId: ACTORS.receiver,
    actorRole: 'receiver_phase_lead',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId,
      action: 'reject',
      artifactEventId: artifactEvent.event_id,
      transitionAt: '2026-07-07T00:00:00.000Z',
    }),
  })
  assertThrowsCode(() => append(manifest, ledger, postTerminal), 'TERMINAL_ATTEMPT_IMMUTABLE')
})

test('revision proposal must be strictly after its rejected parent terminal event regardless of ledger order', () => {
  const manifest = freeze()
  const value = candidate(1)
  let ledger = assign(manifest, [], value).ledger
  const rejectedId = `${value.slice_id}-rejected`
  const rejectedArtifact = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: rejectedId,
    eventType: 'artifact_observed',
    occurredAt: '2026-07-04T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: artifactPayload(manifest, value.slice_id, rejectedId, 'rejected'),
  })
  ledger = append(manifest, ledger, rejectedArtifact)
  for (const [transition, at, actorId, role] of [
    ['propose', '2026-07-05T00:00:00.000Z', ACTORS.sender, 'sender'],
    ['reject', '2026-07-06T00:00:00.000Z', ACTORS.receiver, 'receiver_phase_lead'],
  ]) {
    ledger = append(manifest, ledger, makeEnvelope(manifest, ledger, {
      aggregateType: 'attempt',
      aggregateId: rejectedId,
      eventType: 'attempt_transition_observed',
      occurredAt: at,
      actorId,
      actorRole: role,
      payload: transitionPayload(manifest, {
        sliceId: value.slice_id,
        attemptId: rejectedId,
        action: transition,
        artifactEventId: rejectedArtifact.event_id,
        transitionAt: at,
      }),
    }))
  }

  const revisionId = `${value.slice_id}-revision`
  const revisionArtifact = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: revisionId,
    eventType: 'artifact_observed',
    occurredAt: '2026-07-06T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: artifactPayload(
      manifest,
      value.slice_id,
      revisionId,
      'revision',
      '2026-07-06T00:00:00.000Z',
    ),
  })
  ledger = append(manifest, ledger, revisionArtifact)
  const simultaneous = makeEnvelope(manifest, ledger, {
    aggregateType: 'attempt',
    aggregateId: revisionId,
    eventType: 'attempt_transition_observed',
    occurredAt: '2026-07-06T00:00:00.000Z',
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: transitionPayload(manifest, {
      sliceId: value.slice_id,
      attemptId: revisionId,
      action: 'propose',
      artifactEventId: revisionArtifact.event_id,
      revisionOf: rejectedId,
      transitionAt: '2026-07-06T00:00:00.000Z',
    }),
  })
  assertThrowsCode(() => append(manifest, ledger, simultaneous), 'REVISION_TIME_INVALID')

  const later = clone(simultaneous)
  later.occurred_at = '2026-07-06T00:00:00.001Z'
  later.payload.transition_at = later.occurred_at
  delete later.event_id
  later.event_id = canonicalDigest(later)
  ledger = append(manifest, ledger, later)
  assert.ok(eventsOf(ledger).some((event) => event.event_id === later.event_id))
})

test('compilation retains ITT, requires all 12 measured costs with provenance, and exposes contamination', () => {
  const manifest = freeze()
  const complete = completeRehearsal(manifest)
  const compiled = experimentOf(compileExperiment(manifest, complete.ledger, {
    analysisAsOf: ANALYSIS_AS_OF,
  }))
  const validation = validateExperiment(compiled)
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  assert.deepEqual(new Set(compiled.slices.map((slice) => slice.arm)),
    new Set(['pm_routed', 'receiver_owned']))
  for (const slice of compiled.slices) {
    assert.deepEqual(Object.keys(slice.costs).sort(), [...COST_CATEGORIES].sort())
    assert.ok(Object.values(slice.costs).every((value) => Number.isFinite(value) && value >= 0))
    assert.ok(eventsOf(complete.ledger)
      .filter((event) => event.event_type === 'cost_observed'
        && event.payload.slice_id === slice.slice_id)
      .every((event) => event.source.source_ref && event.source.source_digest
        && event.payload.method_id && event.payload.owner_actor_id
        && event.payload.measured_at))
  }

  const assigned = compiled.slices.length
  compiled.slices[0].outcome = { status: 'cancelled' }
  const report = analyzeExperiment(compiled)
  assert.equal(Object.values(report.intention_to_treat.assigned_by_arm)
    .reduce((sum, value) => sum + value, 0), assigned)

  const missing = completeRehearsal(manifest, {
    omitCost: { arm: 'receiver_owned', category: 'queue_wait_minutes' },
  })
  assertThrowsCode(() => compileExperiment(manifest, missing.ledger, {
    analysisAsOf: ANALYSIS_AS_OF,
  }), 'COST_INCOMPLETE')

  const unknown = completeRehearsal(manifest, {
    unknownCost: { arm: 'receiver_owned', category: 'queue_wait_minutes' },
  })
  const unknownExperiment = experimentOf(compileExperiment(
    manifest,
    unknown.ledger,
    { analysisAsOf: ANALYSIS_AS_OF },
  ))
  const unknownSlice = unknownExperiment.slices.find((slice) => slice.arm === 'receiver_owned')
  assert.equal(unknownSlice.costs.queue_wait_minutes, null,
    'an explicit unknown stays null instead of becoming zero or blocking export')
  const unknownReport = analyzeExperiment(unknownExperiment)
  assert.equal(unknownReport.measurement_readiness, 'INCONCLUSIVE')
  assert.equal(unknownReport.metrics.total_coordination_minutes_by_arm.receiver_owned, null)
  assert.ok(verifyResultValid(verifyEvidencePack(buildEvidencePack(
    manifest,
    unknown.ledger,
    { analysisAsOf: ANALYSIS_AS_OF },
  ))), 'explicit unknown observations remain exportable and integrity-verifiable')

  const contaminated = completeRehearsal(manifest, { contaminatedArm: 'receiver_owned' })
  const contaminatedExperiment = experimentOf(compileExperiment(
    manifest, contaminated.ledger, { analysisAsOf: ANALYSIS_AS_OF },
  ))
  const contaminatedReport = analyzeExperiment(contaminatedExperiment)
  assert.equal(contaminatedReport.intention_to_treat.contamination_detected, true)
  assert.equal(contaminatedReport.measurement_readiness, 'INCONCLUSIVE')
  assert.equal(contaminatedExperiment.slices.length, assigned, 'contaminated slices remain ITT')
})

test('append-only supersession matches the schema, preserves trace history, and materializes only the replacement', () => {
  const manifest = freeze()
  const complete = completeRehearsal(manifest)
  let ledger = complete.ledger
  const target = eventsOf(ledger).find((event) => event.event_type === 'cost_observed')
  assert.ok(target)
  const replacementAt = '2026-07-17T00:00:00.000Z'
  const replacement = makeEnvelope(manifest, ledger, {
    aggregateType: target.aggregate.type,
    aggregateId: target.aggregate.id,
    eventType: target.event_type,
    occurredAt: replacementAt,
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      ...clone(target.payload),
      minutes: target.payload.minutes + 7,
      measured_at: replacementAt,
    },
  })
  ledger = append(manifest, ledger, replacement)

  const supersededAt = '2026-07-17T00:00:01.000Z'
  const correctionPayload = {
    target_event_id: target.event_id,
    replacement_event_id: replacement.event_id,
    reason_code: 'MEASUREMENT_CORRECTION',
    superseded_at: supersededAt,
  }
  const correction = makeEnvelope(manifest, ledger, {
    aggregateType: 'correction',
    aggregateId: `${target.payload.slice_id}-${target.payload.category}-correction`,
    eventType: 'observation_superseded',
    occurredAt: supersededAt,
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: correctionPayload,
  })
  const eventSchema = JSON.parse(readFileSync(join(
    ROOT,
    'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'references',
    'delivery-loop-event-v1.schema.json',
  ), 'utf8'))
  assert.deepEqual(
    Object.keys(correction.payload).sort(),
    [...eventSchema.$defs.observation_superseded_payload.required].sort(),
    'runtime correction payload must use the normative schema field names',
  )
  ledger = append(manifest, ledger, correction)

  const compiled = experimentOf(compileExperiment(manifest, ledger, {
    analysisAsOf: ANALYSIS_AS_OF,
  }))
  const correctedSlice = compiled.slices.find((slice) => slice.slice_id === target.payload.slice_id)
  assert.equal(correctedSlice.costs[target.payload.category], replacement.payload.minutes)

  const pack = buildEvidencePack(manifest, ledger, { analysisAsOf: ANALYSIS_AS_OF })
  assert.ok(verifyResultValid(verifyEvidencePack(pack)))
  for (const event of [target, replacement, correction]) {
    assert.ok(pack.ledger.some((item) => item.event_id === event.event_id),
      `${event.event_type} must remain in the immutable ledger`)
    assert.ok(pack.trace_index.some((item) => item.event_id === event.event_id),
      `${event.event_type} must remain in the trace index`)
  }

  const missingReference = makeEnvelope(manifest, ledger, {
    aggregateType: 'correction',
    aggregateId: 'missing-correction-reference',
    eventType: 'observation_superseded',
    occurredAt: '2026-07-18T00:00:00.000Z',
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      target_event_id: `sha256:${'0'.repeat(64)}`,
      replacement_event_id: replacement.event_id,
      reason_code: 'SOURCE_CORRECTION',
      superseded_at: '2026-07-18T00:00:00.000Z',
    },
  })
  assertThrowsCode(
    () => append(manifest, ledger, missingReference),
    'SUPERSESSION_REFERENCE_MISSING',
  )

  const otherCost = eventsOf(ledger).find((event) => event.event_type === 'cost_observed'
    && event.event_id !== target.event_id
    && event.payload.slice_id === target.payload.slice_id)
  const outcome = eventsOf(ledger).find((event) => event.event_type === 'outcome_observed'
    && event.payload.slice_id === target.payload.slice_id)
  assert.ok(otherCost && outcome)
  const scopeMismatch = makeEnvelope(manifest, ledger, {
    aggregateType: 'correction',
    aggregateId: 'cross-kind-correction',
    eventType: 'observation_superseded',
    occurredAt: '2026-07-18T00:00:01.000Z',
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      target_event_id: otherCost.event_id,
      replacement_event_id: outcome.event_id,
      reason_code: 'MEASUREMENT_CORRECTION',
      superseded_at: '2026-07-18T00:00:01.000Z',
    },
  })
  assertThrowsCode(() => append(manifest, ledger, scopeMismatch), 'SUPERSESSION_SCOPE_MISMATCH')

  const legacyFieldNames = makeEnvelope(manifest, ledger, {
    aggregateType: 'correction',
    aggregateId: 'legacy-field-correction',
    eventType: 'observation_superseded',
    occurredAt: '2026-07-18T00:00:02.000Z',
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      superseded_event_id: otherCost.event_id,
      replacement_event_id: outcome.event_id,
      reason: 'measurement correction',
    },
  })
  assertThrowsCode(() => append(manifest, ledger, legacyFieldNames), 'EVENT_UNKNOWN_FIELD')
})

test('three fresh both-arm rehearsals are deterministic and evidence digests detect every mutation', () => {
  const outputs = []
  for (let run = 0; run < 3; run++) {
    const manifest = freeze()
    const rehearsal = completeRehearsal(manifest)
    const compiled = experimentOf(compileExperiment(manifest, rehearsal.ledger, {
      analysisAsOf: ANALYSIS_AS_OF,
    }))
    assert.deepEqual(new Set(compiled.slices.map((slice) => slice.arm)),
      new Set(['pm_routed', 'receiver_owned']), `rehearsal ${run + 1}`)
    const pack = buildEvidencePack(manifest, rehearsal.ledger, {
      analysisAsOf: ANALYSIS_AS_OF,
    })
    assert.ok(verifyResultValid(verifyEvidencePack(pack)), `rehearsal ${run + 1}`)
    outputs.push({ compiled: canonicalJson(compiled), pack: canonicalJson(pack) })
  }
  assert.equal(new Set(outputs.map(({ compiled }) => compiled)).size, 1)
  assert.equal(new Set(outputs.map(({ pack }) => pack)).size, 1)

  const pack = JSON.parse(outputs[0].pack)
  for (const mutate of [
    (value) => { value.manifest_digest = `sha256:${'0'.repeat(64)}` },
    (value) => {
      const event = value.ledger?.[0] ?? value.events?.[0] ?? value.trace_index?.[0]
      if (event) event.event_id = `sha256:${'1'.repeat(64)}`
      else value.dataset_digest = `sha256:${'1'.repeat(64)}`
    },
    (value) => { value.dataset_digest = `sha256:${'2'.repeat(64)}` },
  ]) {
    const changed = clone(pack)
    mutate(changed)
    const result = verifyEvidencePack(changed)
    assert.equal(verifyResultValid(result), false, 'tampered pack must fail verification')
  }

  walk(pack, (value, path) => {
    assert.notEqual(value, SEED, `secret seed leaked at ${path}`)
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /^(?:GO|ITERATE|NO_GO)$/i,
        `pilot core generated a business recommendation at ${path}`)
    }
    if (path.endsWith('.automatic_routing')) assert.equal(value, false)
  })
})

test('pilot core remains pure and contains no runtime actuation surface', () => {
  const source = readFileSync(PILOT_CORE, 'utf8')
  assert.doesNotMatch(source,
    /node:(?:fs|child_process|http|https|net|dgram)|\b(?:spawn|execFile|process\.kill)\s*\(/,
    'pilot core must stay pure and offline')
  assert.doesNotMatch(source,
    /\b(?:tmux|acp-companion|mailbox-run|deliver\.sh|pulse\.json|TEAM_DONE)\b/i,
    'pilot core must not reach runtime routing/control surfaces')
  assert.doesNotMatch(source,
    /(?:business_recommendation|owner_ratification)\s*[:=]\s*['"]?(?:GO|ITERATE|NO_GO)/i,
    'pilot core must not originate a recommendation or ratification')
})
