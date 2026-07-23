import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COST_CATEGORIES,
  ContractValidationError,
  GUARDRAIL_NAMES,
  HANDOFF_TERMINAL_STATES,
  PHASE_BOUNDARIES,
  PHASE_EXIT_ARTIFACTS,
  analyzeExperiment,
  canonicalDigest,
  canonicalJson,
  deriveManifestIdentity,
  reduceHandoffAttempt,
  validateExperiment,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_DIR = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
const CORE = join(SCRIPT_DIR, 'delivery-loop-core.mjs')
const CLI = join(SCRIPT_DIR, 'delivery-loop-poc.mjs')
const FIXTURES = join(ROOT, 'tests', 'fixtures')
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))

function invalidCodes(input) {
  const result = validateExperiment(input)
  assert.equal(result.valid, false, `expected invalid input, got ${JSON.stringify(result)}`)
  return result.errors.map(({ code }) => code)
}

function validInput() {
  const input = fixture('delivery-loop-poc-favorable-synthetic.json')
  input.actors.phase_leads.ProjectDelivery ??= ['delivery-owner']
  return input
}

function artifact(phase, suffix = phase.toLowerCase()) {
  const value = {
    type: PHASE_EXIT_ARTIFACTS[phase], artifact_id: `artifact-${suffix}`, version: '1',
    digest: canonicalDigest({ phase, suffix }),
    predecessor_trace: phase === 'Requirement' ? [] : [`predecessor-${suffix}`],
    validation_evidence: [`evidence-${suffix}`],
    expectations: { security: 'pass', performance: 'pass', integration: 'pass', uat: 'pass' },
  }
  if (phase === 'Requirement') Object.assign(value, { business_functions: [`function-${suffix}`], validation_exceptions: [] })
  if (phase === 'Prototype') value.clickable_prototype_ref = `prototype://${suffix}`
  if (phase === 'Development') value.working_software_ref = `build://${suffix}`
  if (phase === 'QA') value.e2e_uat_report_ref = `report://${suffix}`
  return value
}

function attempt(state = 'draft') {
  return {
    state, receiver_phase: 'Development',
    actors: { senders: ['sender'], pms: ['pm'], phase_leads: { Development: ['receiver'] } },
    events: [],
  }
}

const RECEIVER_BY_PHASE = {
  Requirement: 'proto-lead', Prototype: 'dev-lead', Development: 'qa-lead', QA: 'delivery-owner',
}

function recordedAttempt(phase, state, suffix, sunk = 0) {
  const receiver_phase = PHASE_BOUNDARIES[phase] ?? 'Release'
  const terminal = {
    accepted: { type: 'accept', actor_id: RECEIVER_BY_PHASE[phase] },
    rejected: { type: 'reject', actor_id: RECEIVER_BY_PHASE[phase] },
    cancelled: { type: 'cancel', actor_id: 'sender-a' },
    abandoned: { type: 'abandon', actor_id: 'pm-a' },
  }[state]
  return {
    attempt_id: `attempt-${suffix}`, sender_phase: phase, receiver_phase, state,
    sunk_cost_minutes: sunk, exit_artifact: artifact(phase, suffix),
    events: [
      { type: 'propose', actor_id: 'sender-a', at: '2026-07-10T00:00:00.000Z' },
      { ...terminal, at: '2026-07-11T00:00:00.000Z' },
    ],
  }
}

function rekeySlice(source, suffix, phase = source.strata.phase) {
  const slice = clone(source)
  slice.slice_id = `${source.slice_id}-${suffix}`
  slice.strata.phase = phase
  slice.handoff_attempts = [recordedAttempt(phase, 'accepted', suffix)]
  return slice
}

function refreshClaimDigests(input) {
  input.evidence.certification_claim.manifest_digest = deriveManifestIdentity(input).manifest_digest
  input.evidence.certification_claim.dataset_digest = canonicalDigest({
    experiment_id: input.experiment_id, analysis_as_of: input.analysis_as_of, slices: input.slices,
  })
}

function walk(value, visit, path = '$') {
  visit(value, path)
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, visit, `${path}.${key}`))
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10_000, ...options })
}

function assertStructuredValidation(input, expectedCode, expectedPath = null) {
  let validation
  assert.doesNotThrow(() => {
    validation = validateExperiment(input)
  })
  assert.equal(validation.valid, false)
  assert.ok(validation.errors.some(({ code }) => code === expectedCode), expectedCode)
  if (expectedPath !== null) {
    assert.ok(validation.errors.some(({ code, path }) => code === expectedCode && path === expectedPath),
      `${expectedCode} at ${expectedPath}`)
  }
  assert.throws(
    () => analyzeExperiment(input),
    (error) => error instanceof ContractValidationError
      && error.code === 'DELIVERY_LOOP_VALIDATION_FAILED'
      && error.errors.some(({ code }) => code === expectedCode),
  )

  const directory = mkdtempSync(join(tmpdir(), 'delivery-loop-validation-'))
  const invalid = join(directory, 'invalid.json')
  writeFileSync(invalid, JSON.stringify(input))
  const result = runCli(['analyze', invalid])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  const diagnostic = JSON.parse(result.stderr)
  assert.equal(diagnostic.error, 'DELIVERY_LOOP_VALIDATION_FAILED')
  assert.ok(diagnostic.diagnostics.some(({ code }) => code === expectedCode), expectedCode)
  if (expectedPath !== null) {
    assert.ok(diagnostic.diagnostics.some(({ code, path }) => code === expectedCode && path === expectedPath),
      `${expectedCode} at ${expectedPath}`)
  }
}

test('closed reducer enforces the complete actor/state/action matrix and preserves its inputs', () => {
  const cases = [
    ['draft', 'propose', 'sender', 'proposed'],
    ['proposed', 'accept', 'receiver', 'accepted'],
    ['proposed', 'reject', 'receiver', 'rejected'],
    ['proposed', 'cancel', 'sender', 'cancelled'],
    ['proposed', 'cancel', 'pm', 'cancelled'],
    ['proposed', 'abandon', 'pm', 'abandoned'],
    ['proposed', 'escalate', 'sender', 'escalated'],
    ['proposed', 'escalate', 'receiver', 'escalated'],
    ['proposed', 'escalate', 'pm', 'escalated'],
    ['escalated', 'resolve_exception', 'pm', 'proposed'],
  ]
  for (const [state, type, actor_id, expected] of cases) {
    const before = attempt(state), event = { type, actor_id, at: '2026-07-02T00:00:00.000Z' }
    const beforeCopy = clone(before), eventCopy = clone(event)
    const result = reduceHandoffAttempt(before, event)
    assert.equal(result.state, expected, `${state}/${type}/${actor_id}`)
    assert.deepEqual(before, beforeCopy, 'attempt is immutable')
    assert.deepEqual(event, eventCopy, 'event is immutable')
    assert.notEqual(result.events, before.events, 'event log is copied')
  }
  for (const terminal of HANDOFF_TERMINAL_STATES) {
    assert.throws(() => reduceHandoffAttempt(attempt(terminal), { type: 'propose', actor_id: 'sender' }),
      (error) => error instanceof ContractValidationError && error.errors.some(({ code }) => code === 'TERMINAL_ATTEMPT_IMMUTABLE'),
      `${terminal} must be immutable`)
  }
  for (const event of [{ type: 'invent', actor_id: 'sender' }, { type: 'accept', actor_id: 'sender' }, { type: 'cancel', actor_id: 'sender' }, { type: 'abandon', actor_id: 'pm' }, { type: 'resolve_exception', actor_id: 'pm' }]) {
    assert.throws(() => reduceHandoffAttempt(attempt('draft'), event), ContractValidationError)
  }

  const overlappingRoles = attempt('draft')
  overlappingRoles.actors.phase_leads.Development = ['sender']
  const selfProposed = reduceHandoffAttempt(overlappingRoles, { type: 'propose', actor_id: 'sender' })
  for (const type of ['accept', 'reject']) {
    assert.throws(
      () => reduceHandoffAttempt(selfProposed, { type, actor_id: 'sender' }),
      (error) => error instanceof ContractValidationError
        && error.errors.some(({ code }) => code === 'ACTOR_SELF_REVIEW_INVALID'),
      `an actor cannot propose and ${type} the same attempt`,
    )
  }
})

test('revision lineage is same-slice/prior/rejected and terminal sunk costs bind category totals', () => {
  const input = validInput()
  const rejected = recordedAttempt('Development', 'rejected', 'revision-rejected', 7)
  const corrected = recordedAttempt('Development', 'accepted', 'revision-accepted', 0)
  corrected.revision_of_attempt_id = rejected.attempt_id
  corrected.events[0].at = '2026-07-12T00:00:00.000Z'
  corrected.events[1].at = '2026-07-13T00:00:00.000Z'
  input.slices[0].handoff_attempts = [rejected, corrected]
  input.slices[0].costs.rejected_work_minutes = 7
  assert.equal(validateExperiment(input).valid, true, 'a new revision must retain rejected predecessor lineage')

  const missingLineage = clone(input)
  delete missingLineage.slices[0].handoff_attempts[1].revision_of_attempt_id
  assert.ok(invalidCodes(missingLineage).includes('REVISION_LINEAGE_REQUIRED'), 'a corrected attempt cannot erase its predecessor')

  const notRejected = clone(input)
  notRejected.slices[0].handoff_attempts[0].state = 'accepted'
  assert.ok(invalidCodes(notRejected).includes('REVISION_REQUIRES_REJECTION'))

  const wrongSlice = clone(input)
  wrongSlice.slices[0].handoff_attempts[1].revision_of_attempt_id = wrongSlice.slices[1].handoff_attempts[0].attempt_id
  assert.ok(invalidCodes(wrongSlice).includes('REVISION_REQUIRES_REJECTION'))

  const overlappingRevision = clone(input)
  overlappingRevision.slices[0].handoff_attempts[1].events[0].at = rejected.events.at(-1).at
  assert.ok(invalidCodes(overlappingRevision).includes('REVISION_TIME_INVALID'),
    'revision proposal must occur strictly after the rejected parent terminal event')

  for (const [state, category] of [['rejected', 'rejected_work_minutes'], ['cancelled', 'cancelled_work_minutes'], ['abandoned', 'abandoned_work_minutes']]) {
    const sunk = validInput()
    sunk.slices[0].handoff_attempts = [recordedAttempt('Development', state, `sunk-${state}`, 4)]
    sunk.slices[0].costs[category] = 4
    assert.equal(validateExperiment(sunk).valid, true, state)
    sunk.slices[0].costs[category] = 3
    assert.ok(invalidCodes(sunk).includes('SUNK_COST_MISMATCH'), category)
    sunk.slices[0].costs[category] = null
    assert.ok(invalidCodes(sunk).includes('SUNK_COST_MISMATCH'), `${category} cannot be unknown for a recorded ${state} terminal cost`)
  }
  const acceptedSunk = validInput()
  acceptedSunk.slices[0].handoff_attempts[0].sunk_cost_minutes = 1
  assert.ok(invalidCodes(acceptedSunk).includes('ACCEPTED_SUNK_COST_INVALID'))
})

test('the four phase exits have exact artifact mappings and every mandatory field', () => {
  assert.deepEqual(PHASE_EXIT_ARTIFACTS, {
    Requirement: 'requirements_baseline', Prototype: 'prototype_evaluation',
    Development: 'development_delivery', QA: 'qa_release_evidence',
  })
  for (const phase of Object.keys(PHASE_EXIT_ARTIFACTS)) {
    const input = validInput()
    input.slices[0] = rekeySlice(input.slices[0], `phase-${phase}`, phase)
    assert.equal(validateExperiment(input).valid, true, `${phase} artifact and terminal handoff should validate in a full experiment`)
    for (const field of ['artifact_id', 'version', 'digest', 'validation_evidence', 'expectations']) {
      const malformed = clone(input)
      delete malformed.slices[0].handoff_attempts[0].exit_artifact[field]
      assert.equal(validateExperiment(malformed).valid, false, `${phase}.${field} is mandatory`)
    }
    if (phase !== 'Requirement') {
      const noTrace = clone(input)
      noTrace.slices[0].handoff_attempts[0].exit_artifact.predecessor_trace = []
      assert.ok(invalidCodes(noTrace).includes('ARTIFACT_TRACE_REQUIRED'))
    }
    for (const [field, code] of [
      ['predecessor_trace', 'ARTIFACT_TRACE_REQUIRED'],
      ['validation_evidence', 'ARTIFACT_VALIDATION_REQUIRED'],
    ]) {
      for (const invalidRefs of [[null], ['']]) {
        const malformedRefs = clone(input)
        malformedRefs.slices[0].handoff_attempts[0].exit_artifact[field] = invalidRefs
        assert.ok(invalidCodes(malformedRefs).includes(code), `${phase}.${field} requires non-empty string references`)
      }
    }
    const ref = { Prototype: 'clickable_prototype_ref', Development: 'working_software_ref', QA: 'e2e_uat_report_ref' }[phase]
    if (ref) {
      const noRef = clone(input)
      delete noRef.slices[0].handoff_attempts[0].exit_artifact[ref]
      assert.ok(invalidCodes(noRef).includes('ARTIFACT_PHASE_REFERENCE_REQUIRED'), ref)
    }
  }
  const requirement = validInput()
  requirement.slices[0] = rekeySlice(requirement.slices[0], 'requirement-fields', 'Requirement')
  requirement.slices[0].handoff_attempts[0].exit_artifact.business_functions = []
  assert.ok(invalidCodes(requirement).includes('REQUIREMENT_BUSINESS_FUNCTIONS_REQUIRED'))

  const qa = validInput()
  qa.slices[0] = rekeySlice(qa.slices[0], 'qa-project-delivery', 'QA')
  const qaAttempt = qa.slices[0].handoff_attempts[0]
  assert.equal(qaAttempt.exit_artifact.type, 'qa_release_evidence')
  assert.equal(qaAttempt.receiver_phase, 'ProjectDelivery')
  assert.equal(qaAttempt.events.at(-1).actor_id, 'delivery-owner')
  assert.equal(validateExperiment(qa).valid, true)
  assert.equal(analyzeExperiment(qa).business_decision, 'EXTERNAL_REQUIRED')
})

test('assignment is half-open, slice IDs are globally unique, and both independent arms are required', () => {
  const atStart = validInput()
  atStart.slices[0].assigned_at = atStart.preregistration.assignment_window.start
  assert.equal(validateExperiment(atStart).valid, true, 'window start is included')
  const atEnd = validInput()
  atEnd.slices[0].assigned_at = atEnd.preregistration.assignment_window.end
  assert.ok(invalidCodes(atEnd).includes('ASSIGNMENT_OUTSIDE_WINDOW'), 'window end is excluded')
  const duplicate = validInput()
  duplicate.slices[1].slice_id = duplicate.slices[0].slice_id
  assert.ok(invalidCodes(duplicate).includes('SLICE_ID_DUPLICATE'))
  const oneArm = validInput()
  oneArm.slices[1].arm = 'pm_routed'
  assert.ok(invalidCodes(oneArm).includes('INDEPENDENT_ARMS_REQUIRED'))

  const strata = validInput()
  delete strata.slices[0].strata.complexity
  assert.ok(invalidCodes(strata).includes('SLICE_STRATUM_REQUIRED'))
  const noPhaseRegistration = validInput()
  noPhaseRegistration.preregistration.strata = ['complexity']
  assert.ok(invalidCodes(noPhaseRegistration).includes('PHASE_STRATUM_REQUIRED'))
  const contamination = validInput()
  delete contamination.slices[0].contamination
  assert.ok(invalidCodes(contamination).includes('CONTAMINATION_REQUIRED'))
  const looseTime = validInput()
  looseTime.preregistration.assignment_window.start = '2026-07-01'
  assert.ok(invalidCodes(looseTime).includes('ASSIGNMENT_WINDOW_INVALID'))

  const forged = validInput()
  forged.slices[0].handoff_attempts[0].events[1].actor_id = 'forged-actor'
  assert.ok(invalidCodes(forged).includes('ACTOR_UNAUTHORIZED'))
  const missingAttempt = validInput()
  missingAttempt.slices[0].handoff_attempts = []
  assert.ok(invalidCodes(missingAttempt).includes('HANDOFF_ATTEMPTS_REQUIRED'))
  const duplicateAttempt = validInput()
  duplicateAttempt.slices[1].handoff_attempts[0].attempt_id = duplicateAttempt.slices[0].handoff_attempts[0].attempt_id
  assert.ok(invalidCodes(duplicateAttempt).includes('ATTEMPT_ID_DUPLICATE'))
  for (const [mutate, code] of [
    [(value) => { value.slices[0].handoff_attempts[0].events = [] }, 'ATTEMPT_EVENTS_REQUIRED'],
    [(value) => { value.slices[0].handoff_attempts[0].state = 'rejected' }, 'ATTEMPT_REPLAY_STATE_MISMATCH'],
    [(value) => { value.slices[0].handoff_attempts[0].receiver_phase = 'Prototype' }, 'ATTEMPT_BOUNDARY_INVALID'],
    [(value) => { value.slices[0].strata.phase = 'Prototype' }, 'ATTEMPT_STRATUM_PHASE_MISMATCH'],
  ]) {
    const malformed = validInput()
    mutate(malformed)
    assert.ok(invalidCodes(malformed).includes(code), code)
  }

  const beforeAssignment = validInput()
  beforeAssignment.slices[0].handoff_attempts[0].events[0].at = '2026-07-01T23:59:59.999Z'
  assert.ok(invalidCodes(beforeAssignment).includes('EVENT_BEFORE_ASSIGNMENT'))
  const afterAnalysis = validInput()
  afterAnalysis.slices[0].handoff_attempts[0].events[1].at = '2026-07-23T00:00:00.001Z'
  assert.ok(invalidCodes(afterAnalysis).includes('EVENT_AFTER_ANALYSIS'))
})

test('validator is total over non-array event and pre-registration shapes and returns structured diagnostics', () => {
  const invalidEvents = validInput()
  invalidEvents.slices[0].handoff_attempts[0].events = {}
  assertStructuredValidation(invalidEvents, 'ATTEMPT_EVENTS_REQUIRED')

  const invalidStrata = validInput()
  invalidStrata.preregistration.strata = { phase: true }
  assertStructuredValidation(invalidStrata, 'STRATA_REQUIRED')

  const invalidActorRegistry = validInput()
  invalidActorRegistry.actors.senders = {}
  assertStructuredValidation(invalidActorRegistry, 'ACTOR_ROLE_REQUIRED')
})

test('one actor cannot propose and then accept or reject the same recorded attempt', () => {
  for (const state of ['accepted', 'rejected']) {
    const input = validInput()
    input.actors.phase_leads.QA = ['sender-a']
    input.slices[0].handoff_attempts[0].state = state
    input.slices[0].handoff_attempts[0].events[1] = {
      type: state === 'accepted' ? 'accept' : 'reject',
      actor_id: 'sender-a',
      at: '2026-07-11T00:00:00.000Z',
    }
    assert.ok(invalidCodes(input).includes('ACTOR_SELF_REVIEW_INVALID'), state)
  }
})

test('analysis_as_of, follow-up maturity, and censoring are deterministic while all assigned slices remain ITT', () => {
  const input = validInput()
  input.slices[0].assigned_at = '2026-07-22T00:00:00.000Z' // less than the declared 7-day follow-up at analysis_as_of
  input.slices[0].outcome.status = 'mature'
  input.slices[1].outcome.status = 'mature'
  input.slices[0].handoff_attempts[0].events[0].at = '2026-07-22T01:00:00.000Z'
  input.slices[0].handoff_attempts[0].events[1].at = '2026-07-22T02:00:00.000Z'
  const report = analyzeExperiment(input)
  assert.equal(report.measurement_readiness, 'INCONCLUSIVE', 'maturity must be derived against fixed analysis_as_of')

  const withIncomplete = validInput()
  withIncomplete.slices.push(
    { ...rekeySlice(withIncomplete.slices[0], 'cancelled-control'), outcome: { status: 'cancelled' } },
    { ...rekeySlice(withIncomplete.slices[1], 'abandoned-treatment'), outcome: { status: 'abandoned' } },
    { ...rekeySlice(withIncomplete.slices[1], 'pending-treatment'), outcome: { status: 'pending' } },
  )
  const itt = analyzeExperiment(withIncomplete).intention_to_treat
  assert.deepEqual(itt.assigned_by_arm, { pm_routed: 2, receiver_owned: 3 })
  assert.deepEqual(itt.non_mature_by_arm, { pm_routed: 1, receiver_owned: 2 })

  for (const field of ['time_to_usable_outcome_minutes', 'value_proxy']) {
    const missingMetric = validInput()
    delete missingMetric.slices[0].outcome[field]
    const incomplete = analyzeExperiment(missingMetric)
    assert.equal(incomplete.measurement_readiness, 'INCONCLUSIVE')
    assert.equal(incomplete.metrics.outcome_complete, false)
  }

  const baseline = analyzeExperiment(validInput())
  const duplicated = validInput()
  duplicated.slices.push(rekeySlice(duplicated.slices[1], 'normalized-treatment-copy'))
  const normalized = analyzeExperiment(duplicated)
  assert.equal(normalized.metrics.total_coordination_minutes_by_arm.receiver_owned,
    baseline.metrics.total_coordination_minutes_by_arm.receiver_owned * 2)
  assert.equal(normalized.metrics.total_coordination_minutes_per_slice_mean_by_arm.receiver_owned,
    baseline.metrics.total_coordination_minutes_per_slice_mean_by_arm.receiver_owned)
  assert.equal(normalized.metrics.total_coordination_reduction_percent, baseline.metrics.total_coordination_reduction_percent)
  assert.equal(normalized.metrics.incremental_loaded_cost_reduction_percent, baseline.metrics.incremental_loaded_cost_reduction_percent)
  assert.equal(normalized.scenario_signal, baseline.scenario_signal)
})

test('every declared cost category is explicit: missing, null, and invalid numeric values are not zero', () => {
  assert.deepEqual(COST_CATEGORIES, [
    'pm_routing_minutes', 'pm_exception_minutes', 'pm_evidence_minutes', 'receiver_review_minutes',
    'governance_minutes', 'instrumentation_minutes', 'queue_wait_minutes', 'rework_minutes', 'rejected_work_minutes',
    'abandoned_work_minutes', 'cancelled_work_minutes', 'sender_coordination_minutes',
  ])
  for (const mutation of [
    (costs) => { delete costs.pm_evidence_minutes },
    (costs) => { costs.pm_evidence_minutes = -1 },
    (costs) => { costs.pm_evidence_minutes = Number.NaN },
    (costs) => { costs.pm_evidence_minutes = '0' },
  ]) {
    const input = validInput()
    mutation(input.slices[0].costs)
    assert.ok(invalidCodes(input).includes('COST_VALUE_INVALID'), 'all required cost values need explicit finite non-negative numbers')
  }
  const unknown = validInput()
  unknown.slices[0].costs.pm_evidence_minutes = null
  assert.equal(validateExperiment(unknown).valid, true, 'null explicitly records an unknown cost')
  const report = analyzeExperiment(unknown)
  assert.equal(report.measurement_readiness, 'INCONCLUSIVE')
  assert.equal(report.metrics.cost_complete, false)
  assert.equal(report.metrics.total_coordination_minutes_by_arm.pm_routed, null)
  assert.deepEqual(report.bottlenecks.by_arm.pm_routed, {
    basis: 'descriptive_only', status: 'INCONCLUSIVE', reason: 'unknown_cost_category',
    highest_coordination_phase: null, largest_cost_category: null,
  })
  const zero = validInput()
  for (const category of COST_CATEGORIES) zero.slices[0].costs[category] = 0
  const measuredZero = analyzeExperiment(zero)
  assert.equal(measuredZero.metrics.total_coordination_minutes_by_arm.pm_routed, 0)
  assert.equal(measuredZero.metrics.cost_complete, true)
})

test('finite input costs and rates that overflow derived arithmetic are rejected without a report', () => {
  const aggregateOverflow = validInput()
  for (const slice of aggregateOverflow.slices) {
    for (const category of COST_CATEGORIES) slice.costs[category] = 0
    slice.costs.pm_routing_minutes = Number.MAX_VALUE
    slice.costs.receiver_review_minutes = Number.MAX_VALUE
  }
  assertStructuredValidation(aggregateOverflow, 'COST_AGGREGATE_NON_FINITE', 'slices')

  const explicitUnknown = clone(aggregateOverflow)
  for (const slice of explicitUnknown.slices) slice.costs.sender_coordination_minutes = null
  assert.equal(validateExperiment(explicitUnknown).valid, true, 'explicit unknown cost remains valid rather than being treated as overflow')
  assert.equal(analyzeExperiment(explicitUnknown).measurement_readiness, 'INCONCLUSIVE')

  const loadedCostOverflow = validInput()
  loadedCostOverflow.cost_model.loaded_cost_per_minute = Number.MAX_VALUE
  for (const slice of loadedCostOverflow.slices) {
    for (const category of COST_CATEGORIES) slice.costs[category] = 0
    slice.costs.pm_routing_minutes = 2
  }
  assertStructuredValidation(loadedCostOverflow, 'LOADED_COST_NON_FINITE', 'cost_model.loaded_cost_per_minute')

  const comparisonOverflow = validInput()
  comparisonOverflow.cost_model.loaded_cost_per_minute = 1
  for (const slice of comparisonOverflow.slices) {
    for (const category of COST_CATEGORIES) slice.costs[category] = 0
    slice.costs.pm_routing_minutes = slice.arm === 'pm_routed' ? Number.MIN_VALUE : Number.MAX_VALUE
  }
  assertStructuredValidation(comparisonOverflow, 'COST_COMPARISON_NON_FINITE', 'slices')
})

test('certifier separation is enforced and a digest-bound claim stays advisory and external-only', () => {
  const input = fixture('delivery-loop-poc-certification-claimed.json')
  const claim = input.evidence.certification_claim
  for (const field of ['claim_id', 'evidence_ref', 'method', 'certifier_id', 'claimed_at', 'expires_at', 'scope', 'manifest_digest', 'dataset_digest']) {
    assert.ok(typeof claim[field] === 'string' && claim[field].length > 0, field)
  }
  assert.equal(claim.manifest_digest, deriveManifestIdentity(input).manifest_digest)
  assert.equal(claim.dataset_digest, canonicalDigest({ experiment_id: input.experiment_id, analysis_as_of: input.analysis_as_of, slices: input.slices }))
  const eligible = analyzeExperiment(input)
  assert.equal(eligible.evidence_eligibility, 'ELIGIBLE_FOR_EXTERNAL_REVIEW')
  assert.equal(eligible.trust_level, 'advisory_same_uid')
  assert.equal(eligible.business_decision, 'EXTERNAL_REQUIRED')

  const overlap = clone(input)
  overlap.actors.senders.push('external-certifier')
  refreshClaimDigests(overlap)
  assert.ok(invalidCodes(overlap).includes('CERTIFIER_ROLE_OVERLAP'), 'certifier cannot also be sender/receiver/PM/experiment/metric owner')

  for (const [mutate, code] of [
    [(value) => { delete value.evidence.certification_claim.method }, 'CERTIFICATION_CLAIM_FIELD_REQUIRED'],
    [(value) => { value.evidence.certification_claim.expires_at = '2026-07-22T12:00:00.000Z' }, 'CERTIFICATION_CLAIM_EXPIRED'],
    [(value) => { value.evidence.certification_claim.scope = 'other-experiment' }, 'CERTIFICATION_SCOPE_MISMATCH'],
    [(value) => { value.evidence.certification_claim.dataset_digest = `sha256:${'0'.repeat(64)}` }, 'CERTIFICATION_DIGEST_MISMATCH'],
  ]) {
    const malformed = clone(input)
    mutate(malformed)
    assert.ok(invalidCodes(malformed).includes(code), code)
    assert.throws(() => analyzeExperiment(malformed), ContractValidationError)
  }
})

test('guardrail precedence retains the breach and hold even when the scenario is favorable; no business verdict leaks recursively', () => {
  const input = fixture('delivery-loop-poc-adverse-synthetic.json')
  const report = analyzeExperiment(input)
  assert.equal(report.measurement_readiness, 'READY')
  assert.equal(report.scenario_signal, 'FAVORABLE')
  assert.equal(report.guardrail_status, 'BREACH')
  assert.equal(report.safety_hold_recommended, true)
  assert.equal(report.decision_packet.decision, 'EXTERNAL_REQUIRED')
  walk(report, (value, path) => {
    if (typeof value === 'string') assert.doesNotMatch(value, /^(?:GO|ITERATE|NO_GO)$/i, `forbidden verdict at ${path}`)
  })
  const unknown = validInput()
  unknown.slices[0].guardrails.security = 'UNKNOWN'
  const unknownReport = analyzeExperiment(unknown)
  assert.equal(unknownReport.measurement_readiness, 'INCONCLUSIVE')
  assert.equal(unknownReport.guardrail_status, 'UNKNOWN')
  assert.equal(unknownReport.safety_hold_recommended, false)
  assert.deepEqual(unknownReport.guardrail_unknowns, [{ slice_id: 'control-001', name: 'security' }])
  const breachAndUnknown = validInput()
  breachAndUnknown.slices[0].guardrails.security = 'BREACH'
  breachAndUnknown.slices[0].guardrails.performance = 'UNKNOWN'
  const combinedReport = analyzeExperiment(breachAndUnknown)
  assert.equal(combinedReport.measurement_readiness, 'INCONCLUSIVE')
  assert.equal(combinedReport.scenario_signal, 'INCONCLUSIVE')
  assert.equal(combinedReport.guardrail_status, 'BREACH')
  assert.equal(combinedReport.safety_hold_recommended, true)
  assert.deepEqual(combinedReport.guardrail_breaches, [{ slice_id: 'control-001', name: 'security' }])
  assert.deepEqual(combinedReport.guardrail_unknowns, [{ slice_id: 'control-001', name: 'performance' }])
  for (const name of GUARDRAIL_NAMES) {
    const missing = validInput()
    delete missing.slices[0].guardrails[name]
    assert.ok(invalidCodes(missing).includes('GUARDRAIL_VALUE_INVALID'), name)
  }
})

test('per-arm bottlenecks are descriptive-only and use stable alphabetical tie-breaks without changing the external decision', () => {
  const input = validInput()
  const control = rekeySlice(input.slices[0], 'control-requirement-tie', 'Requirement')
  control.costs = {
    pm_routing_minutes: 0, pm_exception_minutes: 15, pm_evidence_minutes: 15,
    receiver_review_minutes: 25, governance_minutes: 15, instrumentation_minutes: 15,
    queue_wait_minutes: 5, rework_minutes: 15, rejected_work_minutes: 0,
    abandoned_work_minutes: 0, cancelled_work_minutes: 0, sender_coordination_minutes: 5,
  } // total 110: Development and Requirement tie; pm_routing and receiver_review tie at 40.
  const treatment = rekeySlice(input.slices[1], 'treatment-requirement-tie', 'Requirement')
  treatment.costs = {
    pm_routing_minutes: 10, pm_exception_minutes: 0, pm_evidence_minutes: 10,
    receiver_review_minutes: 0, governance_minutes: 10, instrumentation_minutes: 10,
    queue_wait_minutes: 10, rework_minutes: 10, rejected_work_minutes: 0, abandoned_work_minutes: 0,
    cancelled_work_minutes: 0, sender_coordination_minutes: 0,
  } // total 60: Development and Requirement tie; eight categories tie at 15.
  input.slices.push(control, treatment)

  const report = analyzeExperiment(input)
  assert.equal(report.bottlenecks.basis, 'descriptive_only')
  assert.deepEqual(report.bottlenecks.by_arm, {
    pm_routed: {
      basis: 'descriptive_only', status: 'AVAILABLE',
      highest_coordination_phase: { phase: 'Development', total_coordination_minutes: 110 },
      largest_cost_category: { category: 'pm_routing_minutes', minutes: 40 },
    },
    receiver_owned: {
      basis: 'descriptive_only', status: 'AVAILABLE',
      highest_coordination_phase: { phase: 'Development', total_coordination_minutes: 60 },
      largest_cost_category: { category: 'governance_minutes', minutes: 15 },
    },
  })
  assert.equal(report.business_decision, 'EXTERNAL_REQUIRED')
  assert.equal(report.decision_packet.decision, 'EXTERNAL_REQUIRED')

  const reordered = clone(input)
  reordered.slices.reverse()
  assert.deepEqual(analyzeExperiment(reordered).bottlenecks, report.bottlenecks, 'slice order cannot change deterministic bottlenecks')
})

test('all four fixtures have exact, deterministic outcomes and byte-deterministic CLI JSON', () => {
  const expected = {
    'delivery-loop-poc-favorable-synthetic.json': ['READY', 'FAVORABLE', 'CLEAR', 'SYNTHETIC_ONLY', false],
    'delivery-loop-poc-adverse-synthetic.json': ['READY', 'FAVORABLE', 'BREACH', 'SYNTHETIC_ONLY', true],
    'delivery-loop-poc-observed-unverified.json': ['READY', 'FAVORABLE', 'CLEAR', 'OBSERVED_UNVERIFIED', false],
    'delivery-loop-poc-certification-claimed.json': ['READY', 'FAVORABLE', 'CLEAR', 'ELIGIBLE_FOR_EXTERNAL_REVIEW', false],
  }
  for (const [name, expectedFields] of Object.entries(expected)) {
    const path = join(FIXTURES, name)
    const a = runCli(['analyze', path]), b = runCli(['analyze', path])
    assert.equal(a.status, 0, a.stderr)
    assert.equal(b.status, 0, b.stderr)
    assert.equal(a.stdout, b.stdout, `${name} output must be byte deterministic`)
    assert.equal(a.stderr, '')
    assert.equal((a.stdout.match(/\n/g) ?? []).length, 1, 'stdout contains one JSON document')
    const report = JSON.parse(a.stdout)
    assert.deepEqual([report.measurement_readiness, report.scenario_signal, report.guardrail_status, report.evidence_eligibility, report.safety_hold_recommended], expectedFields, name)
    assert.equal(report.business_decision, 'EXTERNAL_REQUIRED')
    walk(report, (value, valuePath) => {
      if (typeof value === 'string') assert.doesNotMatch(value, /^(?:GO|ITERATE|NO_GO)$/i, `forbidden verdict at ${name}:${valuePath}`)
    })
  }
})

test('CLI keeps usage, malformed-input, and validation failures as JSON diagnostics on stderr only', () => {
  const usage = runCli([])
  assert.equal(usage.status, 2)
  assert.equal(usage.stdout, '')
  assert.deepEqual(JSON.parse(usage.stderr), { error: 'USAGE', message: 'Usage: node delivery-loop-poc.mjs analyze <json-file>', diagnostics: [] })

  const directory = mkdtempSync(join(tmpdir(), 'delivery-loop-cli-'))
  const broken = join(directory, 'broken.json')
  writeFileSync(broken, '{not json')
  const malformed = runCli(['analyze', broken])
  assert.equal(malformed.status, 1)
  assert.equal(malformed.stdout, '')
  assert.equal(JSON.parse(malformed.stderr).error, 'INPUT_READ_FAILED')

  const invalid = join(directory, 'invalid.json')
  writeFileSync(invalid, JSON.stringify({ schema_version: 'wrong' }))
  const validation = runCli(['analyze', invalid])
  assert.equal(validation.status, 1)
  assert.equal(validation.stdout, '')
  const diagnostic = JSON.parse(validation.stderr)
  assert.equal(diagnostic.error, 'DELIVERY_LOOP_VALIDATION_FAILED')
  assert.ok(diagnostic.diagnostics.length > 0)
  for (const result of [usage, malformed, validation]) {
    assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[/, 'no ANSI output')
  }
})

test('core is pure and isolated; CLI reads only its named input and writes no files', () => {
  const coreSource = readFileSync(CORE, 'utf8')
  assert.match(coreSource, /^import \{ createHash \} from 'node:crypto';/m)
  assert.doesNotMatch(coreSource, /node:(?:fs|child_process|http|https|net|dgram)|\b(?:tmux|ACP|KMS|Pulse)\b/i)
  const sandbox = mkdtempSync(join(tmpdir(), 'delivery-loop-isolation-'))
  const before = readdirSync(sandbox)
  const result = runCli(['analyze', join(FIXTURES, 'delivery-loop-poc-favorable-synthetic.json')], { cwd: sandbox })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readdirSync(sandbox), before, 'CLI must not write outside its stdout/stderr contract')
})

test('canonical JSON digest is stable across object-key order', () => {
  const a = { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } }
  const b = { a: { c: 3, d: 4 }, z: [{ a: 1, b: 2 }] }
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.equal(canonicalDigest(a), canonicalDigest(b))
  assert.equal(canonicalJson({ 2: 2, 10: 10 }), '{"10":10,"2":2}',
    'numeric-looking keys still use code-point order')
  const nestedNumericA = { outer: { 2: { b: 2, a: 1 }, 10: { d: 4, c: 3 } } }
  const nestedNumericB = { outer: { 10: { c: 3, d: 4 }, 2: { a: 1, b: 2 } } }
  assert.equal(canonicalJson(nestedNumericA), '{"outer":{"10":{"c":3,"d":4},"2":{"a":1,"b":2}}}')
  assert.equal(canonicalJson(nestedNumericA), canonicalJson(nestedNumericB))
  assert.equal(canonicalDigest(nestedNumericA), canonicalDigest(nestedNumericB),
    'nested digest is stable across insertion order')
  assert.equal(canonicalJson({ '\u{1F600}': 'smile', '\uE000': 'private-use' }),
    '{"\uE000":"private-use","\u{1F600}":"smile"}',
    'canonicalJson sorts U+E000 before U+1F600 by Unicode code point')

  const registered = validInput()
  const baseline = deriveManifestIdentity(registered).manifest_digest
  const mutations = [
    (input) => { input.cost_model.loaded_cost_per_minute += 1 },
    (input) => { input.preregistration.primary_kpis.push('diagnostic_kpi') },
    (input) => { input.preregistration.guardrails.reverse() },
    (input) => { input.actors.metric_producers.push('metric-producer-2') },
    (input) => { input.thresholds.value_noninferiority_margin += 1 },
  ]
  for (const mutate of mutations) {
    const changed = clone(registered)
    mutate(changed)
    assert.notEqual(deriveManifestIdentity(changed).manifest_digest, baseline, 'all registration inputs bind the manifest digest')
  }

  for (const [mutate, code] of [
    [(input) => { delete input.preregistration.hypothesis }, 'HYPOTHESIS_REQUIRED'],
    [(input) => { input.preregistration.primary_kpis = [] }, 'PRIMARY_KPIS_REQUIRED'],
    [(input) => { input.preregistration.guardrails = [] }, 'GUARDRAIL_REGISTRATION_INVALID'],
    [(input) => { input.preregistration.estimand = 'totals' }, 'ESTIMAND_INVALID'],
    [(input) => { delete input.cost_model.currency }, 'COST_CURRENCY_REQUIRED'],
    [(input) => { input.cost_model.unit = 'hour' }, 'COST_UNIT_INVALID'],
    [(input) => { delete input.cost_model.allocation_basis }, 'COST_ALLOCATION_REQUIRED'],
  ]) {
    const invalid = validInput()
    mutate(invalid)
    assert.ok(invalidCodes(invalid).includes(code), code)
  }
})
