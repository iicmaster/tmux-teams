import { createHash, createHmac } from 'node:crypto'

import {
  COST_CATEGORIES,
  GUARDRAIL_NAMES,
  PHASE_BOUNDARIES,
  PHASE_EXIT_ARTIFACTS,
  ContractValidationError,
  analyzeExperiment,
  canonicalDigest,
  canonicalJson,
  reduceHandoffAttempt,
  validateExperiment,
} from './delivery-loop-core.mjs'

export const PILOT_MANIFEST_VERSION = 1
export const EVENT_SCHEMA_VERSION = 1
export const EVIDENCE_PACK_VERSION = 1
export const ASSIGNMENT_ALGORITHM = 'hmac_sha256_stratified_v1'

const EVENT_SCHEMA = ['t', 'mux-teams.delivery-loop-event'].join('')
const MANIFEST_SCHEMA = ['t', 'mux-teams.delivery-loop-pilot-manifest'].join('')
const EVIDENCE_SCHEMA = ['t', 'mux-teams.delivery-loop-evidence-pack'].join('')
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const TERMINAL_STATES = new Set(['accepted', 'rejected', 'cancelled', 'abandoned'])
const EVENT_TYPES = new Set([
  'preregistration_frozen',
  'slice_eligible',
  'slice_assigned',
  'artifact_observed',
  'attempt_transition_observed',
  'cost_observed',
  'outcome_observed',
  'guardrail_observed',
  'contamination_observed',
  'observation_superseded',
  'analysis_window_closed',
  'source_observed',
])
const SUPERSEDEABLE_EVENT_TYPES = new Set([
  'cost_observed',
  'outcome_observed',
  'guardrail_observed',
  'contamination_observed',
  'source_observed',
])
const SUPERSESSION_REASON_CODES = new Set([
  'SOURCE_CORRECTION',
  'DUPLICATE_OBSERVATION',
  'MEASUREMENT_CORRECTION',
  'REDACTION_REFERENCE_REPLACED',
])
const SOURCE_KINDS = new Set([
  'pilot_runner',
  'pilot_manifest',
  'assignment_engine',
  'manual_observation',
  'synthetic_rehearsal',
  'mailbox_dispatch',
  'mailbox_outbox',
  'kms_event',
  'instrumentation',
  'qa_report',
  'external_anchor',
])
const ROLE_FIELDS = Object.freeze([
  'senders',
  'pms',
  'certifiers',
  'experiment_owners',
  'metric_producers',
  'business_owners',
])
const INPUT_MANIFEST_KEYS = Object.freeze([
  'schema_version',
  'experiment_id',
  'boundary',
  'preregistration',
  'maturity',
  'thresholds',
  'actors',
  'cost_model',
  'assignment_seed',
  'assignment_seed_commitment',
  'sample_plan',
  'cost_capture_methods',
  'max_contamination_percent',
  'material_guardrails_resolved',
  'automatic_routing',
])
const FROZEN_MANIFEST_KEYS = Object.freeze([
  ...INPUT_MANIFEST_KEYS.filter((key) => key !== 'assignment_seed'),
  'assignment_algorithm',
  'frozen_at',
  'manifest_digest',
])
const EVENT_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'event_id',
  'experiment_id',
  'manifest_digest',
  'aggregate',
  'event_type',
  'occurred_at',
  'claimed_actor',
  'source',
  'payload',
])
const AGGREGATE_KEYS = Object.freeze(['type', 'id', 'sequence', 'previous_event_id'])
const ACTOR_KEYS = Object.freeze(['actor_id', 'role'])
const SOURCE_KEYS = Object.freeze(['kind', 'source_ref', 'source_digest', 'trust_level'])
const THRESHOLD_KEYS = Object.freeze([
  'min_mature_per_arm',
  'coordination_reduction_percent',
  'incremental_cost_reduction_percent',
  'time_to_usable_noninferiority_minutes',
  'value_noninferiority_margin',
])
const SAMPLE_PLAN_KEYS = Object.freeze([
  'method',
  'min_slices_per_arm',
  'alpha',
  'power',
  'stopping_rule',
])
const RICH_DRAFT_KEYS = Object.freeze([
  'schema_version',
  'manifest_id',
  'experiment_id',
  'automatic_routing',
  'boundary',
  'hypothesis',
  'primary_kpis',
  'guardrails',
  'eligibility',
  'assignment',
  'assignment_seed',
  'sample_plan',
  'maturity',
  'stopping_rule',
  'thresholds',
  'actors',
  'cost_model',
  'cost_instrumentation',
  'outcome_instrumentation',
  'guardrail_instrumentation',
  'missing_data',
  'contamination',
  'roles',
  'role_separation',
  'external_anchor',
  'analysis_plan',
])
const RICH_FROZEN_KEYS = Object.freeze([
  'schema',
  ...RICH_DRAFT_KEYS.filter((key) => key !== 'assignment_seed'),
  'manifest_digest',
  'frozen_at',
])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const finiteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const clone = (value) => structuredClone(value)
const issue = (errors, code, path, message) => errors.push({ code, path, message })
const digestText = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`

function strictMillis(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match) return null
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) return null
  const calendar = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (calendar.getUTCFullYear() !== Number(match[1])
    || calendar.getUTCMonth() !== Number(match[2]) - 1
    || calendar.getUTCDate() !== Number(match[3])) return null
  return millis
}

function unknownKeys(errors, value, allowed, path, code) {
  if (!isObject(value)) return
  const allow = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) issue(errors, code, path ? `${path}.${key}` : key, `Unknown field: ${key}`)
  }
}

function requireExactKeys(errors, value, allowed, path, objectCode, unknownCode, missingCode) {
  if (!isObject(value)) {
    issue(errors, objectCode, path, `${path || 'value'} must be an object.`)
    return false
  }
  unknownKeys(errors, value, allowed, path, unknownCode)
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) issue(errors, missingCode, path ? `${path}.${key}` : key, `Required field is missing: ${key}`)
  }
  return true
}

function requireStringArray(errors, value, path, code) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length) {
    issue(errors, code, path, `${path} must be a non-empty array of unique strings.`)
  }
}

function actorIds(manifest, role, phase) {
  if (role === 'receiver_phase_lead') return manifest.actors?.phase_leads?.[phase] ?? []
  const field = {
    sender: 'senders',
    pm: 'pms',
    certifier: 'certifiers',
    experiment_owner: 'experiment_owners',
    metric_producer: 'metric_producers',
    business_owner: 'business_owners',
  }[role]
  if (field) return manifest.actors?.[field] ?? []
  const richField = {
    assignment_custodian: 'assignment_custodian_ids',
    guardrail_producer: 'guardrail_producer_ids',
    external_reviewer: 'external_reviewer_ids',
    observer: 'metric_producer_ids',
  }[role]
  return richField ? manifest.roles?.[richField] ?? [] : []
}

const assignmentWindow = (manifest) => manifest.assignment?.assignment_window
  ?? manifest.preregistration?.assignment_window
const registeredStrata = (manifest) => manifest.eligibility?.strata
  ?? manifest.preregistration?.strata
const seedCommitmentOf = (manifest) => manifest.assignment?.seed_commitment
  ?? manifest.assignment_seed_commitment
const assignmentMethodOf = (manifest) => manifest.assignment?.method
  ?? manifest.assignment_algorithm
  ?? manifest.preregistration?.assignment_method
const costMethodOf = (manifest, category) => manifest.cost_instrumentation?.[category]?.method_id
  ?? manifest.cost_capture_methods?.[category]
const stageZeroPreregistration = (manifest) => manifest.preregistration
  ? clone(manifest.preregistration)
  : {
      manifest_id: manifest.manifest_id,
      hypothesis: manifest.hypothesis,
      primary_kpis: manifest.primary_kpis.map((name) => ({
        total_coordination_minutes: 'total_coordination_minutes_per_slice_mean',
        incremental_loaded_cost: 'incremental_loaded_cost_per_slice_mean',
      }[name] ?? name)),
      guardrails: clone(manifest.guardrails),
      estimand: manifest.analysis_plan.estimand,
      assignment_window: {
        start: manifest.assignment.assignment_window.start,
        end: manifest.assignment.assignment_window.end,
      },
      assignment_method: manifest.assignment.method,
      strata: clone(manifest.eligibility.strata),
    }

function validateRoleRegistry(errors, actors) {
  if (!isObject(actors)) {
    issue(errors, 'ACTORS_REQUIRED', 'actors', 'Actor registry is required.')
    return
  }
  unknownKeys(errors, actors, [...ROLE_FIELDS, 'phase_leads'], 'actors', 'MANIFEST_UNKNOWN_FIELD')
  for (const field of ROLE_FIELDS) requireStringArray(errors, actors[field], `actors.${field}`, 'ACTOR_ROLE_REQUIRED')
  if (!isObject(actors.phase_leads)) {
    issue(errors, 'PHASE_LEADS_REQUIRED', 'actors.phase_leads', 'Phase-lead registry is required.')
  } else {
    unknownKeys(
      errors,
      actors.phase_leads,
      [...Object.keys(PHASE_EXIT_ARTIFACTS), 'ProjectDelivery'],
      'actors.phase_leads',
      'MANIFEST_UNKNOWN_FIELD',
    )
    for (const phase of [...Object.keys(PHASE_EXIT_ARTIFACTS), 'ProjectDelivery']) {
      requireStringArray(errors, actors.phase_leads[phase], `actors.phase_leads.${phase}`, 'PHASE_LEADS_REQUIRED')
    }
  }

  const certifiers = new Set(actors.certifiers ?? [])
  const prohibitedCertifier = [
    ...(actors.senders ?? []),
    ...(actors.pms ?? []),
    ...Object.values(actors.phase_leads ?? {}).flat(),
    ...(actors.experiment_owners ?? []),
    ...(actors.metric_producers ?? []),
    ...(actors.business_owners ?? []),
  ]
  if (prohibitedCertifier.some((id) => certifiers.has(id))) {
    issue(errors, 'ROLE_SEPARATION_INVALID', 'actors.certifiers', 'External certifiers cannot overlap operational, measurement, experiment, or business roles.')
  }
  const businessOwners = new Set(actors.business_owners ?? [])
  if ([...(actors.metric_producers ?? []), ...(actors.certifiers ?? [])].some((id) => businessOwners.has(id))) {
    issue(errors, 'ROLE_SEPARATION_INVALID', 'actors.business_owners', 'Business owners cannot overlap metric producers or certifiers.')
  }
}

function validateInstrumentationMap(errors, map, names, path, missingCode, expectedOwnerIds) {
  if (!isObject(map)) {
    issue(errors, missingCode, path, `${path} is required.`)
    return
  }
  unknownKeys(errors, map, names, path, 'MANIFEST_UNKNOWN_FIELD')
  for (const name of names) {
    const method = map[name]
    if (!isObject(method)) {
      issue(errors, missingCode, `${path}.${name}`, `${name} instrumentation is required.`)
      continue
    }
    if (typeof method.method_id !== 'string' || !ID_RE.test(method.method_id)
      || typeof method.method !== 'string' || method.method.length === 0
      || typeof method.owner_actor_id !== 'string'
      || !expectedOwnerIds.includes(method.owner_actor_id)) {
      issue(errors, missingCode, `${path}.${name}`, `${name} instrumentation must bind a declared owner and method.`)
    }
  }
}

function validateRichManifest(input, { frozen = false } = {}) {
  const errors = []
  if (!isObject(input)) {
    issue(errors, 'MANIFEST_OBJECT_REQUIRED', '', 'Manifest must be an object.')
    return errors
  }
  requireExactKeys(
    errors,
    input,
    frozen ? RICH_FROZEN_KEYS : RICH_DRAFT_KEYS,
    '',
    'MANIFEST_OBJECT_REQUIRED',
    'MANIFEST_UNKNOWN_FIELD',
    'MANIFEST_FIELD_REQUIRED',
  )
  if (input.schema_version !== PILOT_MANIFEST_VERSION) {
    issue(errors, 'MANIFEST_VERSION_INVALID', 'schema_version', `Expected schema version ${PILOT_MANIFEST_VERSION}.`)
  }
  if (frozen && input.schema !== MANIFEST_SCHEMA) {
    issue(errors, 'MANIFEST_VERSION_INVALID', 'schema', 'Frozen manifest schema is invalid.')
  }
  for (const [field, code] of [['manifest_id', 'MANIFEST_ID_INVALID'], ['experiment_id', 'EXPERIMENT_ID_INVALID']]) {
    if (typeof input[field] !== 'string' || !ID_RE.test(input[field])) issue(errors, code, field, `${field} must be a stable ID.`)
  }
  if (input.automatic_routing !== false) {
    issue(errors, 'AUTOMATIC_ROUTING_FORBIDDEN', 'automatic_routing', 'Stage 1 cannot enable automatic routing.')
  }

  const boundary = input.boundary
  if (!isObject(boundary)) {
    issue(errors, 'BOUNDARY_REQUIRED', 'boundary', 'One adjacent pilot boundary is required.')
  } else {
    requireExactKeys(
      errors,
      boundary,
      ['sender_phase', 'receiver_phase', 'artifact_type'],
      'boundary',
      'BOUNDARY_REQUIRED',
      'MANIFEST_UNKNOWN_FIELD',
      'BOUNDARY_REQUIRED',
    )
    if (!Object.hasOwn(PHASE_BOUNDARIES, boundary.sender_phase)
      || PHASE_BOUNDARIES[boundary.sender_phase] !== boundary.receiver_phase
      || PHASE_EXIT_ARTIFACTS[boundary.sender_phase] !== boundary.artifact_type) {
      issue(errors, 'BOUNDARY_INVALID', 'boundary', 'Boundary and artifact type must be an exact delivery transition.')
    }
  }
  if (typeof input.hypothesis !== 'string' || input.hypothesis.length < 20) {
    issue(errors, 'HYPOTHESIS_REQUIRED', 'hypothesis', 'A prospective hypothesis is required.')
  }
  requireStringArray(errors, input.primary_kpis, 'primary_kpis', 'PRIMARY_KPIS_REQUIRED')
  if (!Array.isArray(input.guardrails)
    || input.guardrails.length !== GUARDRAIL_NAMES.length
    || GUARDRAIL_NAMES.some((name) => !input.guardrails.includes(name))) {
    issue(errors, 'GUARDRAIL_REGISTRATION_INVALID', 'guardrails', 'All guardrails must be registered exactly once.')
  }

  if (!isObject(input.eligibility)
    || !Array.isArray(input.eligibility.strata)
    || input.eligibility.strata.length === 0
    || input.eligibility.strata.some((name) => typeof name !== 'string' || !ID_RE.test(name))
    || typeof input.eligibility.eligibility_owner_actor_id !== 'string') {
    issue(errors, 'ELIGIBILITY_INVALID', 'eligibility', 'Prospective eligibility and strata are required.')
  }

  const assignment = input.assignment
  if (!isObject(assignment)) {
    issue(errors, 'ASSIGNMENT_PLAN_REQUIRED', 'assignment', 'Assignment plan is required.')
  } else {
    if (assignment.method !== ASSIGNMENT_ALGORITHM
      || assignment.method_version !== 1
      || canonicalJson(assignment.arms) !== canonicalJson(['pm_routed', 'receiver_owned'])
      || assignment.control_arm !== 'pm_routed'
      || assignment.treatment_arm !== 'receiver_owned'
      || assignment.arm_override_allowed !== false
      || assignment.retain_assigned_arm !== true) {
      issue(errors, 'ASSIGNMENT_ALGORITHM_INVALID', 'assignment', 'Assignment must bind the closed HMAC method with no arm override.')
    }
    const start = strictMillis(assignment.assignment_window?.start)
    const end = strictMillis(assignment.assignment_window?.end)
    if (start === null || end === null || start >= end
      || assignment.assignment_window?.interval !== 'half_open_start_inclusive_end_exclusive') {
      issue(errors, 'ASSIGNMENT_WINDOW_INVALID', 'assignment.assignment_window', 'Assignment window must be strict half-open RFC3339.')
    }
    if (frozen && !DIGEST_RE.test(assignment.seed_commitment ?? '')) {
      issue(errors, 'ASSIGNMENT_SEED_COMMITMENT_INVALID', 'assignment.seed_commitment', 'Frozen assignment requires a seed commitment.')
    }
    if (!frozen && Object.hasOwn(assignment, 'seed_commitment')) {
      issue(errors, 'MANIFEST_UNKNOWN_FIELD', 'assignment.seed_commitment', 'Draft assignment must not contain the generated seed commitment.')
    }
  }
  if (!frozen && (typeof input.assignment_seed !== 'string' || input.assignment_seed.length < 16)) {
    issue(errors, 'ASSIGNMENT_SEED_INVALID', 'assignment_seed', 'Private assignment seed must contain at least 16 characters.')
  }

  const sample = input.sample_plan
  if (!isObject(sample)
    || !Number.isSafeInteger(sample.min_assigned_per_arm)
    || sample.min_assigned_per_arm < 1
    || !Number.isSafeInteger(sample.min_mature_per_arm)
    || sample.min_mature_per_arm < 1
    || !Number.isSafeInteger(sample.target_assigned_total)
    || sample.target_assigned_total < sample.min_assigned_per_arm * 2
    || typeof sample.power_method !== 'string'
    || typeof sample.power_reference !== 'string'
    || typeof sample.rationale !== 'string'
    || sample.rationale.length < 20) {
    issue(errors, 'SAMPLE_PLAN_INVALID', 'sample_plan', 'Sample plan must bind size, power method, reference, and rationale.')
  }
  if (!isObject(input.maturity) || !finiteNonNegative(input.maturity.min_follow_up_days)) {
    issue(errors, 'MATURITY_RULE_INVALID', 'maturity', 'Maturity plan is required.')
  }
  if (!isObject(input.stopping_rule)
    || input.stopping_rule.post_outcome_rule_changes_allowed !== false
    || input.stopping_rule.automatic_safety_actuation !== false
    || strictMillis(input.stopping_rule.window_end) === null) {
    issue(errors, 'STOPPING_RULE_INVALID', 'stopping_rule', 'Stopping rule must be fixed and manual.')
  }
  if (!isObject(input.thresholds)) {
    issue(errors, 'THRESHOLDS_REQUIRED', 'thresholds', 'Thresholds are required.')
  } else {
    unknownKeys(errors, input.thresholds, THRESHOLD_KEYS, 'thresholds', 'MANIFEST_UNKNOWN_FIELD')
    for (const name of THRESHOLD_KEYS) {
      if (!finiteNonNegative(input.thresholds[name])) issue(errors, 'THRESHOLD_INVALID', `thresholds.${name}`, 'Threshold must be finite and non-negative.')
    }
  }
  validateRoleRegistry(errors, input.actors)

  if (!isObject(input.cost_model)
    || !finiteNonNegative(input.cost_model.loaded_cost_per_minute)
    || input.cost_model.unit !== 'minute'
    || typeof input.cost_model.currency !== 'string'
    || typeof input.cost_model.allocation_basis !== 'string') {
    issue(errors, 'COST_MODEL_REQUIRED', 'cost_model', 'A complete minute-based cost model is required.')
  }
  validateInstrumentationMap(
    errors,
    input.cost_instrumentation,
    COST_CATEGORIES,
    'cost_instrumentation',
    'COST_INSTRUMENTATION_REQUIRED',
    input.actors?.metric_producers ?? [],
  )
  validateInstrumentationMap(
    errors,
    input.guardrail_instrumentation,
    GUARDRAIL_NAMES,
    'guardrail_instrumentation',
    'GUARDRAIL_INSTRUMENTATION_REQUIRED',
    input.roles?.guardrail_producer_ids ?? [],
  )
  if (!isObject(input.outcome_instrumentation)
    || !['time_to_usable_outcome_minutes', 'value_proxy', 'maturity_status']
      .every((name) => isObject(input.outcome_instrumentation[name])
        && typeof input.outcome_instrumentation[name].method_id === 'string'
        && (input.actors?.metric_producers ?? []).includes(input.outcome_instrumentation[name].owner_actor_id))) {
    issue(errors, 'OUTCOME_INSTRUMENTATION_REQUIRED', 'outcome_instrumentation', 'Outcome instrumentation is incomplete.')
  }
  if (!isObject(input.missing_data)
    || input.missing_data.retain_all_assigned_slices !== true
    || !finiteNonNegative(input.missing_data.maximum_unknown_cost_fraction)
    || input.missing_data.maximum_unknown_cost_fraction > 1
    || !finiteNonNegative(input.missing_data.maximum_missing_mature_outcome_fraction)
    || input.missing_data.maximum_missing_mature_outcome_fraction > 1) {
    issue(errors, 'MISSING_DATA_PLAN_INVALID', 'missing_data', 'Missing-data plan must retain every assigned slice.')
  }
  if (!isObject(input.contamination)
    || !finiteNonNegative(input.contamination.maximum_contaminated_fraction)
    || input.contamination.maximum_contaminated_fraction > 1
    || input.contamination.retain_assigned_arm !== true
    || typeof input.contamination.detection_method_id !== 'string') {
    issue(errors, 'CONTAMINATION_THRESHOLD_INVALID', 'contamination', 'Contamination plan must use a [0,1] tolerance and retain assigned arms.')
  }

  const roles = input.roles
  const roleNames = [
    'business_owner_ids', 'pm_ids', 'sender_ids', 'receiver_phase_lead_ids',
    'experiment_owner_ids', 'assignment_custodian_ids', 'metric_producer_ids',
    'guardrail_producer_ids', 'external_reviewer_ids',
  ]
  if (!isObject(roles)) {
    issue(errors, 'ROLES_REQUIRED', 'roles', 'Role map is required.')
  } else {
    for (const name of roleNames) requireStringArray(errors, roles[name], `roles.${name}`, 'ACTOR_ROLE_REQUIRED')
    const reviewers = new Set(roles.external_reviewer_ids ?? [])
    const operational = roleNames.filter((name) => name !== 'external_reviewer_ids')
      .flatMap((name) => roles[name] ?? [])
    const businessOwners = new Set(roles.business_owner_ids ?? [])
    if (operational.some((id) => reviewers.has(id))
      || (roles.metric_producer_ids ?? []).some((id) => businessOwners.has(id))
      || (roles.assignment_custodian_ids ?? []).some((id) => (roles.metric_producer_ids ?? []).includes(id))) {
      issue(errors, 'ROLE_SEPARATION_INVALID', 'roles', 'External, business, assignment, and measurement roles must be separated.')
    }
    if (!roles.experiment_owner_ids?.includes(input.eligibility?.eligibility_owner_actor_id)
      || !input.actors?.experiment_owners?.includes(input.eligibility?.eligibility_owner_actor_id)
      || !roles.assignment_custodian_ids?.includes(input.assignment?.assignment_custodian_actor_id)
      || !roles.external_reviewer_ids?.includes(input.external_anchor?.custodian_actor_id)) {
      issue(errors, 'ROLE_BINDING_INVALID', 'roles', 'Eligibility, assignment, and external-anchor owners must bind declared roles.')
    }
  }
  if (!isObject(input.role_separation)
    || Object.values(input.role_separation).some((value) => value !== true)) {
    issue(errors, 'ROLE_SEPARATION_INVALID', 'role_separation', 'All declared separation controls must be true.')
  }
  if (!isObject(input.external_anchor)
    || input.external_anchor.required !== true
    || input.external_anchor.outside_worker_writable_repository !== true
    || !DIGEST_RE.test(input.external_anchor.anchor_digest ?? '')
    || strictMillis(input.external_anchor.anchored_at) === null) {
    issue(errors, 'EXTERNAL_ANCHOR_INVALID', 'external_anchor', 'A pre-assignment external custody anchor is required.')
  }
  if (!isObject(input.analysis_plan)
    || input.analysis_plan.estimand !== 'per_slice_mean_by_arm'
    || input.analysis_plan.business_decision_authority !== 'EXTERNAL_REQUIRED'
    || input.analysis_plan.actuation !== 'NONE'
    || strictMillis(input.analysis_plan.analysis_as_of) === null) {
    issue(errors, 'ANALYSIS_PLAN_INVALID', 'analysis_plan', 'Analysis must retain external decision authority and no actuation.')
  }

  if (frozen) {
    const frozenAt = strictMillis(input.frozen_at)
    const start = strictMillis(input.assignment?.assignment_window?.start)
    if (frozenAt === null || (start !== null && frozenAt > start)) {
      issue(errors, 'FREEZE_TIME_INVALID', 'frozen_at', 'Manifest must be frozen no later than assignment-window start.')
    }
    if (!DIGEST_RE.test(input.manifest_digest ?? '')) {
      issue(errors, 'MANIFEST_DIGEST_INVALID', 'manifest_digest', 'Manifest digest must be SHA-256.')
    } else {
      const unsigned = clone(input)
      delete unsigned.manifest_digest
      if (canonicalDigest(unsigned) !== input.manifest_digest) {
        issue(errors, 'MANIFEST_DIGEST_MISMATCH', 'manifest_digest', 'Manifest changed after freeze.')
      }
    }
  }
  return errors
}

function validateManifestBody(input, { frozen = false } = {}) {
  const errors = []
  if (!isObject(input)) {
    issue(errors, 'MANIFEST_OBJECT_REQUIRED', '', 'Manifest must be an object.')
    return errors
  }
  requireExactKeys(
    errors,
    input,
    frozen ? FROZEN_MANIFEST_KEYS : INPUT_MANIFEST_KEYS,
    '',
    'MANIFEST_OBJECT_REQUIRED',
    'MANIFEST_UNKNOWN_FIELD',
    'MANIFEST_FIELD_REQUIRED',
  )
  if (input.schema_version !== PILOT_MANIFEST_VERSION) {
    issue(errors, 'MANIFEST_VERSION_INVALID', 'schema_version', `Expected ${PILOT_MANIFEST_VERSION}.`)
  }
  if (typeof input.experiment_id !== 'string' || !ID_RE.test(input.experiment_id)) {
    issue(errors, 'EXPERIMENT_ID_INVALID', 'experiment_id', 'experiment_id must be a stable ID.')
  }

  if (!isObject(input.boundary)) {
    issue(errors, 'BOUNDARY_REQUIRED', 'boundary', 'One pilot boundary is required.')
  } else {
    requireExactKeys(
      errors,
      input.boundary,
      ['sender_phase', 'receiver_phase'],
      'boundary',
      'BOUNDARY_REQUIRED',
      'MANIFEST_UNKNOWN_FIELD',
      'BOUNDARY_REQUIRED',
    )
    const sender = input.boundary.sender_phase
    if (!Object.hasOwn(PHASE_BOUNDARIES, sender)
      || PHASE_BOUNDARIES[sender] !== input.boundary.receiver_phase) {
      issue(errors, 'BOUNDARY_INVALID', 'boundary', 'Boundary must be one exact adjacent delivery phase.')
    }
  }

  const prereg = input.preregistration
  if (!isObject(prereg)) {
    issue(errors, 'PREREGISTRATION_REQUIRED', 'preregistration', 'Preregistration is required.')
  } else {
    requireExactKeys(
      errors,
      prereg,
      ['manifest_id', 'hypothesis', 'primary_kpis', 'guardrails', 'estimand', 'assignment_window', 'assignment_method', 'strata'],
      'preregistration',
      'PREREGISTRATION_REQUIRED',
      'MANIFEST_UNKNOWN_FIELD',
      'PREREGISTRATION_FIELD_REQUIRED',
    )
    for (const field of ['manifest_id', 'hypothesis']) {
      if (typeof prereg[field] !== 'string' || prereg[field].length === 0) {
        issue(errors, 'PREREGISTRATION_FIELD_REQUIRED', `preregistration.${field}`, `${field} is required.`)
      }
    }
    requireStringArray(errors, prereg.primary_kpis, 'preregistration.primary_kpis', 'PRIMARY_KPIS_REQUIRED')
    requireStringArray(errors, prereg.strata, 'preregistration.strata', 'STRATA_REQUIRED')
    if (!Array.isArray(prereg.guardrails)
      || prereg.guardrails.length !== GUARDRAIL_NAMES.length
      || GUARDRAIL_NAMES.some((name) => !prereg.guardrails.includes(name))) {
      issue(errors, 'GUARDRAIL_REGISTRATION_INVALID', 'preregistration.guardrails', 'All closed guardrails must be registered exactly once.')
    }
    if (prereg.estimand !== 'per_slice_mean_by_arm') {
      issue(errors, 'ESTIMAND_INVALID', 'preregistration.estimand', 'Estimand must be per_slice_mean_by_arm.')
    }
    if (prereg.assignment_method !== ASSIGNMENT_ALGORITHM) {
      issue(errors, 'ASSIGNMENT_ALGORITHM_INVALID', 'preregistration.assignment_method', `Expected ${ASSIGNMENT_ALGORITHM}.`)
    }
    if (!isObject(prereg.assignment_window)) {
      issue(errors, 'ASSIGNMENT_WINDOW_INVALID', 'preregistration.assignment_window', 'Assignment window is required.')
    } else {
      unknownKeys(errors, prereg.assignment_window, ['start', 'end'], 'preregistration.assignment_window', 'MANIFEST_UNKNOWN_FIELD')
      const start = strictMillis(prereg.assignment_window.start)
      const end = strictMillis(prereg.assignment_window.end)
      if (start === null || end === null || start >= end) {
        issue(errors, 'ASSIGNMENT_WINDOW_INVALID', 'preregistration.assignment_window', 'Assignment window must be a strict half-open RFC3339 interval.')
      }
    }
  }

  if (!isObject(input.maturity)
    || Object.keys(input.maturity).length !== 1
    || !finiteNonNegative(input.maturity.min_follow_up_days)) {
    issue(errors, 'MATURITY_RULE_INVALID', 'maturity', 'A finite non-negative min_follow_up_days is required.')
  }
  if (!isObject(input.thresholds)) {
    issue(errors, 'THRESHOLDS_REQUIRED', 'thresholds', 'Thresholds are required.')
  } else {
    unknownKeys(errors, input.thresholds, THRESHOLD_KEYS, 'thresholds', 'MANIFEST_UNKNOWN_FIELD')
    for (const name of THRESHOLD_KEYS) {
      if (!finiteNonNegative(input.thresholds[name])) issue(errors, 'THRESHOLD_INVALID', `thresholds.${name}`, 'Threshold must be finite and non-negative.')
    }
  }
  validateRoleRegistry(errors, input.actors)

  if (!isObject(input.cost_model)) {
    issue(errors, 'COST_MODEL_REQUIRED', 'cost_model', 'Cost model is required.')
  } else {
    requireExactKeys(
      errors,
      input.cost_model,
      ['loaded_cost_per_minute', 'currency', 'unit', 'allocation_basis'],
      'cost_model',
      'COST_MODEL_REQUIRED',
      'MANIFEST_UNKNOWN_FIELD',
      'COST_MODEL_FIELD_REQUIRED',
    )
    if (!finiteNonNegative(input.cost_model.loaded_cost_per_minute)) issue(errors, 'LOADED_RATE_INVALID', 'cost_model.loaded_cost_per_minute', 'Loaded rate must be finite and non-negative.')
    if (typeof input.cost_model.currency !== 'string' || input.cost_model.currency.length === 0) issue(errors, 'COST_CURRENCY_REQUIRED', 'cost_model.currency', 'Currency is required.')
    if (input.cost_model.unit !== 'minute') issue(errors, 'COST_UNIT_INVALID', 'cost_model.unit', 'Cost unit must be minute.')
    if (typeof input.cost_model.allocation_basis !== 'string' || input.cost_model.allocation_basis.length === 0) issue(errors, 'COST_ALLOCATION_REQUIRED', 'cost_model.allocation_basis', 'Allocation basis is required.')
  }

  if (!isObject(input.sample_plan)) {
    issue(errors, 'SAMPLE_PLAN_INVALID', 'sample_plan', 'A pre-registered sample plan is required.')
  } else {
    const keys = Object.keys(input.sample_plan)
    if (keys.some((key) => !SAMPLE_PLAN_KEYS.includes(key))
      || SAMPLE_PLAN_KEYS.some((key) => !Object.hasOwn(input.sample_plan, key))
      || typeof input.sample_plan.method !== 'string'
      || input.sample_plan.method.length === 0
      || !Number.isSafeInteger(input.sample_plan.min_slices_per_arm)
      || input.sample_plan.min_slices_per_arm < 1
      || typeof input.sample_plan.alpha !== 'number'
      || input.sample_plan.alpha <= 0
      || input.sample_plan.alpha >= 1
      || typeof input.sample_plan.power !== 'number'
      || input.sample_plan.power <= 0
      || input.sample_plan.power >= 1
      || typeof input.sample_plan.stopping_rule !== 'string'
      || input.sample_plan.stopping_rule.length === 0) {
      issue(errors, 'SAMPLE_PLAN_INVALID', 'sample_plan', 'Sample plan must bind method, size, alpha, power, and stopping rule.')
    }
  }

  if (!isObject(input.cost_capture_methods)) {
    issue(errors, 'COST_CAPTURE_METHOD_REQUIRED', 'cost_capture_methods', 'All cost capture methods are required.')
  } else {
    unknownKeys(errors, input.cost_capture_methods, COST_CATEGORIES, 'cost_capture_methods', 'MANIFEST_UNKNOWN_FIELD')
    for (const category of COST_CATEGORIES) {
      if (typeof input.cost_capture_methods[category] !== 'string'
        || input.cost_capture_methods[category].length === 0) {
        issue(errors, 'COST_CAPTURE_METHOD_REQUIRED', `cost_capture_methods.${category}`, 'Every cost category needs a capture method.')
      }
    }
  }
  if (!finiteNonNegative(input.max_contamination_percent)
    || input.max_contamination_percent > 100) {
    issue(errors, 'CONTAMINATION_THRESHOLD_INVALID', 'max_contamination_percent', 'Contamination tolerance must be between 0 and 100.')
  }
  if (input.material_guardrails_resolved !== true) {
    issue(errors, 'MATERIAL_GUARDRAILS_UNRESOLVED', 'material_guardrails_resolved', 'Material guardrails must be resolved before freeze.')
  }
  if (input.automatic_routing !== false) {
    issue(errors, 'AUTOMATIC_ROUTING_FORBIDDEN', 'automatic_routing', 'Stage 1 is observe-only and cannot enable automatic routing.')
  }

  if (frozen) {
    if (input.assignment_algorithm !== ASSIGNMENT_ALGORITHM) {
      issue(errors, 'ASSIGNMENT_ALGORITHM_INVALID', 'assignment_algorithm', `Expected ${ASSIGNMENT_ALGORITHM}.`)
    }
    if (!DIGEST_RE.test(input.assignment_seed_commitment ?? '')) {
      issue(errors, 'ASSIGNMENT_SEED_COMMITMENT_INVALID', 'assignment_seed_commitment', 'A SHA-256 seed commitment is required.')
    }
    const frozenAt = strictMillis(input.frozen_at)
    const windowStart = strictMillis(input.preregistration?.assignment_window?.start)
    if (frozenAt === null || (windowStart !== null && frozenAt > windowStart)) {
      issue(errors, 'FREEZE_TIME_INVALID', 'frozen_at', 'Manifest must be frozen no later than assignment-window start.')
    }
    if (!DIGEST_RE.test(input.manifest_digest ?? '')) {
      issue(errors, 'MANIFEST_DIGEST_INVALID', 'manifest_digest', 'Manifest digest must be SHA-256.')
    } else {
      const unsigned = clone(input)
      delete unsigned.manifest_digest
      if (canonicalDigest(unsigned) !== input.manifest_digest) {
        issue(errors, 'MANIFEST_DIGEST_MISMATCH', 'manifest_digest', 'Manifest changed after freeze.')
      }
    }
  } else {
    if (typeof input.assignment_seed !== 'string' || input.assignment_seed.length < 16) {
      issue(errors, 'ASSIGNMENT_SEED_INVALID', 'assignment_seed', 'Assignment seed must contain at least 16 characters.')
    }
    if (Object.hasOwn(input, 'assignment_seed_commitment')
      && input.assignment_seed_commitment !== null
      && !DIGEST_RE.test(input.assignment_seed_commitment)) {
      issue(errors, 'ASSIGNMENT_SEED_COMMITMENT_INVALID', 'assignment_seed_commitment', 'Seed commitment must be SHA-256 when supplied.')
    }
  }
  return errors
}

export class PilotValidationError extends Error {
  constructor(errors, code = errors?.[0]?.code ?? 'PILOT_VALIDATION_FAILED') {
    super(errors?.[0]?.message ?? 'Stage 1 pilot validation failed')
    this.name = 'PilotValidationError'
    this.code = code
    this.errors = errors ?? []
  }
}

function fail(code, path, message) {
  throw new PilotValidationError([{ code, path, message }], code)
}

export function validatePilotManifest(input) {
  const frozen = isObject(input) && Object.hasOwn(input, 'manifest_digest')
  const rich = isObject(input) && (Object.hasOwn(input, 'assignment') || input.schema === MANIFEST_SCHEMA)
  const errors = rich
    ? validateRichManifest(input, { frozen })
    : validateManifestBody(input, { frozen })
  return { valid: errors.length === 0, errors }
}

export function validateFrozenManifest(manifest) {
  const rich = isObject(manifest) && (Object.hasOwn(manifest, 'assignment') || manifest.schema === MANIFEST_SCHEMA)
  const errors = rich
    ? validateRichManifest(manifest, { frozen: true })
    : validateManifestBody(manifest, { frozen: true })
  return { valid: errors.length === 0, errors }
}

export function freezePilotManifest(input, { frozenAt, seedCommitment } = {}) {
  if (isObject(input) && Object.hasOwn(input, 'assignment')) {
    const candidate = clone(input)
    const errors = validateRichManifest(candidate, { frozen: false })
    if (errors.length) throw new PilotValidationError(errors)
    const commitment = seedCommitment ?? digestText(candidate.assignment_seed)
    if (!DIGEST_RE.test(commitment)) {
      fail('ASSIGNMENT_SEED_COMMITMENT_INVALID', 'assignment.seed_commitment', 'Seed commitment must be SHA-256.')
    }
    delete candidate.assignment_seed
    candidate.schema = MANIFEST_SCHEMA
    candidate.assignment = { ...candidate.assignment, seed_commitment: commitment }
    candidate.frozen_at = frozenAt
    const frozenMillis = strictMillis(candidate.frozen_at)
    const windowStart = strictMillis(candidate.assignment.assignment_window.start)
    if (frozenMillis === null || frozenMillis > windowStart) {
      fail('FREEZE_TIME_INVALID', 'frozen_at', 'Manifest must be frozen no later than assignment-window start.')
    }
    candidate.manifest_digest = canonicalDigest(candidate)
    const validation = validateFrozenManifest(candidate)
    if (!validation.valid) throw new PilotValidationError(validation.errors)
    return candidate
  }
  const candidate = clone(input)
  if (!Object.hasOwn(candidate, 'assignment_seed_commitment')) candidate.assignment_seed_commitment = null
  const errors = validateManifestBody(candidate, { frozen: false })
  if (errors.length) throw new PilotValidationError(errors)
  const secret = candidate.assignment_seed
  const commitment = seedCommitment ?? digestText(secret)
  if (!DIGEST_RE.test(commitment)) fail('ASSIGNMENT_SEED_COMMITMENT_INVALID', 'assignment_seed_commitment', 'Seed commitment must be SHA-256.')
  if (candidate.assignment_seed_commitment !== null
    && candidate.assignment_seed_commitment !== commitment) {
    fail('ASSIGNMENT_SEED_COMMITMENT_MISMATCH', 'assignment_seed_commitment', 'Provided seed does not match the precommitted digest.')
  }
  delete candidate.assignment_seed
  candidate.assignment_seed_commitment = commitment
  candidate.assignment_algorithm = ASSIGNMENT_ALGORITHM
  candidate.frozen_at = frozenAt
  const frozenMillis = strictMillis(candidate.frozen_at)
  const windowStart = strictMillis(candidate.preregistration.assignment_window.start)
  if (frozenMillis === null || frozenMillis > windowStart) {
    fail('FREEZE_TIME_INVALID', 'frozen_at', 'Manifest must be frozen no later than assignment-window start.')
  }
  candidate.manifest_digest = canonicalDigest(candidate)
  const validation = validateFrozenManifest(candidate)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  return candidate
}

function unsignedEvent(event) {
  const unsigned = clone(event)
  delete unsigned.event_id
  return unsigned
}

function validateSource(errors, source) {
  if (!requireExactKeys(
    errors,
    source,
    SOURCE_KEYS,
    'source',
    'SOURCE_INVALID',
    'EVENT_UNKNOWN_FIELD',
    'SOURCE_FIELD_REQUIRED',
  )) return
  if (!SOURCE_KINDS.has(source.kind)) issue(errors, 'SOURCE_KIND_INVALID', 'source.kind', 'Source kind is closed.')
  if (typeof source.source_ref !== 'string' || source.source_ref.length === 0 || source.source_ref.length > 512) {
    issue(errors, 'SOURCE_REF_INVALID', 'source.source_ref', 'Source reference must be a bounded non-empty string.')
  }
  if (!DIGEST_RE.test(source.source_digest ?? '')) issue(errors, 'SOURCE_DIGEST_INVALID', 'source.source_digest', 'Source digest must be SHA-256.')
  if (source.trust_level !== 'advisory_same_uid') issue(errors, 'SOURCE_TRUST_INVALID', 'source.trust_level', 'Local sources remain advisory_same_uid.')
}

function validateActorClaim(errors, claim, manifest, event) {
  if (!requireExactKeys(
    errors,
    claim,
    ACTOR_KEYS,
    'claimed_actor',
    'ACTOR_CLAIM_INVALID',
    'EVENT_UNKNOWN_FIELD',
    'ACTOR_CLAIM_FIELD_REQUIRED',
  )) return
  if (typeof claim.actor_id !== 'string' || !ID_RE.test(claim.actor_id)) {
    issue(errors, 'ACTOR_ID_INVALID', 'claimed_actor.actor_id', 'Actor ID is invalid.')
  }
  const phase = event.payload?.receiver_phase ?? manifest.boundary.receiver_phase
  if (!actorIds(manifest, claim.role, phase).includes(claim.actor_id)) {
    issue(errors, 'ACTOR_UNAUTHORIZED', 'claimed_actor', 'Claimed actor is not registered for this role and phase.')
  }
}

function requirePayloadKeys(errors, payload, required, optional = []) {
  if (!isObject(payload)) {
    issue(errors, 'EVENT_PAYLOAD_INVALID', 'payload', 'Event payload must be an object.')
    return false
  }
  unknownKeys(errors, payload, [...required, ...optional], 'payload', 'EVENT_UNKNOWN_FIELD')
  for (const key of required) {
    if (!Object.hasOwn(payload, key)) issue(errors, 'EVENT_PAYLOAD_FIELD_REQUIRED', `payload.${key}`, `Required payload field is missing: ${key}`)
  }
  return true
}

function validateArtifactPayload(errors, payload, manifest, occurredAt) {
  if (isObject(payload) && Object.hasOwn(payload, 'artifact_id') && !Object.hasOwn(payload, 'artifact')) {
    if (!requirePayloadKeys(
      errors,
      payload,
      [
        'slice_id', 'attempt_id', 'artifact_id', 'artifact_type',
        'artifact_version', 'artifact_digest', 'boundary', 'predecessor_trace',
        'validation_evidence_digests', 'observed_at',
      ],
    )) return
    if (payload.boundary?.sender_phase !== manifest.boundary.sender_phase
      || payload.boundary?.receiver_phase !== manifest.boundary.receiver_phase
      || payload.artifact_type !== manifest.boundary.artifact_type
      || !DIGEST_RE.test(payload.artifact_digest ?? '')
      || strictMillis(payload.observed_at) === null
      || payload.observed_at !== occurredAt
      || !Array.isArray(payload.predecessor_trace)
      || payload.predecessor_trace.some((digest) => !DIGEST_RE.test(digest))
      || !Array.isArray(payload.validation_evidence_digests)
      || payload.validation_evidence_digests.length === 0
      || payload.validation_evidence_digests.some((digest) => !DIGEST_RE.test(digest))) {
      issue(errors, 'ARTIFACT_INVALID', 'payload', 'Artifact observation does not match the frozen boundary.')
    }
    return
  }
  if (!requirePayloadKeys(
    errors,
    payload,
    ['slice_id', 'attempt_id', 'sender_phase', 'receiver_phase', 'artifact'],
    ['revision_of_attempt_id'],
  )) return
  if (payload.sender_phase !== manifest.boundary.sender_phase
    || payload.receiver_phase !== manifest.boundary.receiver_phase) {
    issue(errors, 'EVENT_BOUNDARY_MISMATCH', 'payload', 'Attempt must use the frozen boundary.')
  }
  const artifact = payload.artifact
  if (!isObject(artifact)
    || artifact.type !== PHASE_EXIT_ARTIFACTS[manifest.boundary.sender_phase]
    || typeof artifact.artifact_id !== 'string'
    || typeof artifact.version !== 'string'
    || !DIGEST_RE.test(artifact.digest ?? '')
    || !Array.isArray(artifact.predecessor_trace)
    || !Array.isArray(artifact.validation_evidence)
    || !isObject(artifact.expectations)) {
    issue(errors, 'ARTIFACT_INVALID', 'payload.artifact', 'Artifact does not satisfy the frozen phase-exit contract.')
  }
}

function validateEventPayload(errors, event, manifest) {
  const payload = event.payload
  switch (event.event_type) {
    case 'slice_assigned': {
      const rich = Object.hasOwn(payload ?? {}, 'algorithm')
      const required = rich
        ? [
            'slice_id', 'arm', 'assigned_at', 'algorithm', 'algorithm_version',
            'assignment_score', 'seed_commitment', 'assignment_digest', 'strata',
            'arm_override',
          ]
        : ['slice_id', 'arm', 'strata', 'assigned_at', 'assignment_algorithm', 'manual_policy']
      if (!requirePayloadKeys(errors, payload, required)) break
      if (payload.slice_id !== event.aggregate?.id
        || !['pm_routed', 'receiver_owned'].includes(payload.arm)
        || !isObject(payload.strata)
        || (rich
          ? payload.algorithm !== ASSIGNMENT_ALGORITHM
            || payload.algorithm_version !== 1
            || !/^[0-9a-f]{64}$/.test(payload.assignment_score ?? '')
            || payload.seed_commitment !== seedCommitmentOf(manifest)
            || !DIGEST_RE.test(payload.assignment_digest ?? '')
            || payload.arm_override !== false
          : payload.assignment_algorithm !== ASSIGNMENT_ALGORITHM)) {
        issue(errors, 'ASSIGNMENT_PAYLOAD_INVALID', 'payload', 'Assignment payload is invalid.')
      }
      if (strictMillis(payload.assigned_at) === null || payload.assigned_at !== event.occurred_at) {
        issue(errors, 'ASSIGNMENT_TIME_INVALID', 'payload.assigned_at', 'Assignment time must equal event occurrence time.')
      }
      if (!rich && (!isObject(payload.manual_policy)
        || payload.manual_policy.auto_execute !== false
        || payload.manual_policy.routing_owner !== (payload.arm === 'pm_routed' ? 'pm' : 'receiver'))) {
        issue(errors, 'ASSIGNMENT_POLICY_INVALID', 'payload.manual_policy', 'Assignment policy must remain manual and arm-consistent.')
      }
      break
    }
    case 'artifact_observed':
      validateArtifactPayload(errors, payload, manifest, event.occurred_at)
      break
    case 'attempt_transition_observed': {
      const rich = Object.hasOwn(payload ?? {}, 'action')
      if (rich) {
        if (!requirePayloadKeys(
          errors,
          payload,
          [
            'slice_id', 'attempt_id', 'boundary', 'action', 'from_state', 'to_state',
            'sender_actor_id', 'receiver_actor_id', 'artifact_event_id',
            'revision_of_attempt_id', 'transition_at',
          ],
        )) break
        const expected = {
          propose: ['draft', 'proposed'],
          accept: ['proposed', 'accepted'],
          reject: ['proposed', 'rejected'],
          cancel: ['proposed', 'cancelled'],
          abandon: ['proposed', 'abandoned'],
          escalate: ['proposed', 'escalated'],
          resolve_exception: ['escalated', 'proposed'],
        }[payload.action]
        if (!expected
          || payload.from_state !== expected[0]
          || payload.to_state !== expected[1]
          || payload.boundary?.sender_phase !== manifest.boundary.sender_phase
          || payload.boundary?.receiver_phase !== manifest.boundary.receiver_phase
          || payload.transition_at !== event.occurred_at
          || !DIGEST_RE.test(payload.artifact_event_id ?? '')) {
          issue(errors, 'TRANSITION_INVALID', 'payload', 'Transition observation does not match the closed lifecycle.')
        }
      } else {
        if (!requirePayloadKeys(
          errors,
          payload,
          ['slice_id', 'attempt_id', 'sender_phase', 'receiver_phase', 'transition'],
          ['revision_of_attempt_id', 'sunk_cost_minutes'],
        )) break
        if (payload.sender_phase !== manifest.boundary.sender_phase
          || payload.receiver_phase !== manifest.boundary.receiver_phase) {
          issue(errors, 'EVENT_BOUNDARY_MISMATCH', 'payload', 'Attempt must use the frozen boundary.')
        }
        if (!['propose', 'accept', 'reject', 'cancel', 'abandon', 'escalate', 'resolve_exception'].includes(payload.transition)) {
          issue(errors, 'TRANSITION_INVALID', 'payload.transition', 'Transition is not in the closed lifecycle.')
        }
      }
      break
    }
    case 'cost_observed': {
      const rich = Object.hasOwn(payload ?? {}, 'measurement_status')
      if (rich) {
        if (!requirePayloadKeys(
          errors,
          payload,
          ['slice_id', 'category', 'measurement_status', 'minutes', 'method_id', 'owner_actor_id', 'measured_at'],
        )) break
        const method = manifest.cost_instrumentation?.[payload.category]
        if (!COST_CATEGORIES.includes(payload.category)
          || !['measured', 'unknown'].includes(payload.measurement_status)
          || (payload.measurement_status === 'measured' ? !finiteNonNegative(payload.minutes) : payload.minutes !== null)
          || payload.method_id !== method?.method_id
          || payload.owner_actor_id !== method?.owner_actor_id
          || payload.measured_at !== event.occurred_at) {
          issue(errors, 'COST_OBSERVATION_INVALID', 'payload', 'Cost observation must match frozen instrumentation.')
        }
      } else {
        if (!requirePayloadKeys(
          errors,
          payload,
          ['slice_id', 'category', 'minutes', 'capture_method', 'source_event_ids'],
          ['supersedes_event_id'],
        )) break
        if (!COST_CATEGORIES.includes(payload.category)
          || !finiteNonNegative(payload.minutes)
          || payload.capture_method !== costMethodOf(manifest, payload.category)
          || !Array.isArray(payload.source_event_ids)
          || payload.source_event_ids.length === 0
          || payload.source_event_ids.some((id) => !DIGEST_RE.test(id))) {
          issue(errors, 'COST_OBSERVATION_INVALID', 'payload', 'Cost observation must be complete, non-negative, and traceable.')
        }
      }
      break
    }
    case 'outcome_observed': {
      const rich = Object.hasOwn(payload ?? {}, 'method_id')
      if (!requirePayloadKeys(
        errors,
        payload,
        rich
          ? ['slice_id', 'status', 'time_to_usable_outcome_minutes', 'value_proxy', 'method_id', 'owner_actor_id', 'measured_at']
          : ['slice_id', 'status'],
        rich ? [] : ['time_to_usable_outcome_minutes', 'value_proxy', 'supersedes_event_id'],
      )) break
      if (!['mature', 'immature', 'censored', 'pending', 'cancelled', 'abandoned'].includes(payload.status)) {
        issue(errors, 'OUTCOME_OBSERVATION_INVALID', 'payload.status', 'Outcome status is closed.')
      }
      if (Object.hasOwn(payload, 'time_to_usable_outcome_minutes')
        && !finiteNonNegative(payload.time_to_usable_outcome_minutes)) {
        issue(errors, 'OUTCOME_OBSERVATION_INVALID', 'payload.time_to_usable_outcome_minutes', 'Outcome time must be non-negative.')
      }
      if (Object.hasOwn(payload, 'value_proxy')
        && payload.value_proxy !== null
        && (typeof payload.value_proxy !== 'number' || !Number.isFinite(payload.value_proxy))) {
        issue(errors, 'OUTCOME_OBSERVATION_INVALID', 'payload.value_proxy', 'Value proxy must be finite.')
      }
      if (rich) {
        const methods = Object.values(manifest.outcome_instrumentation ?? {})
        if (!methods.some((method) => method.method_id === payload.method_id
          && method.owner_actor_id === payload.owner_actor_id)
          || payload.measured_at !== event.occurred_at) {
          issue(errors, 'OUTCOME_OBSERVATION_INVALID', 'payload.method_id', 'Outcome observation must match frozen instrumentation.')
        }
      }
      break
    }
    case 'guardrail_observed': {
      const rich = Object.hasOwn(payload ?? {}, 'guardrail')
      if (!requirePayloadKeys(
        errors,
        payload,
        rich
          ? ['slice_id', 'guardrail', 'status', 'evidence_ref', 'evidence_digest', 'method_id', 'owner_actor_id', 'measured_at']
          : ['slice_id', 'name', 'status'],
        rich ? [] : ['supersedes_event_id'],
      )) break
      const name = rich ? payload.guardrail : payload.name
      if (!GUARDRAIL_NAMES.includes(name) || !['PASS', 'BREACH', 'UNKNOWN'].includes(payload.status)) {
        issue(errors, 'GUARDRAIL_OBSERVATION_INVALID', 'payload', 'Guardrail observation is invalid.')
      }
      if (rich) {
        const method = manifest.guardrail_instrumentation?.[name]
        if (payload.method_id !== method?.method_id
          || payload.owner_actor_id !== method?.owner_actor_id
          || payload.measured_at !== event.occurred_at
          || !DIGEST_RE.test(payload.evidence_digest ?? '')) {
          issue(errors, 'GUARDRAIL_OBSERVATION_INVALID', 'payload', 'Guardrail observation must match frozen instrumentation.')
        }
      }
      break
    }
    case 'contamination_observed': {
      const rich = Object.hasOwn(payload ?? {}, 'reason_code')
      if (rich) {
        if (!requirePayloadKeys(
          errors,
          payload,
          ['slice_id', 'contaminated', 'reason_code', 'method_id', 'owner_actor_id', 'observed_at'],
        )) break
        const allowedReasons = [
          'NO_CONTAMINATION_OBSERVED', 'ARM_INSTRUCTION_CROSSED',
          'PM_ROUTING_ADDED_TO_TREATMENT', 'RECEIVER_ROUTING_ADDED_TO_CONTROL',
          'MANUAL_ARM_OVERRIDE_ATTEMPTED', 'OTHER_DECLARED',
        ]
        if (typeof payload.contaminated !== 'boolean'
          || !allowedReasons.includes(payload.reason_code)
          || (!payload.contaminated && payload.reason_code !== 'NO_CONTAMINATION_OBSERVED')
          || (payload.contaminated && payload.reason_code === 'NO_CONTAMINATION_OBSERVED')
          || payload.method_id !== manifest.contamination?.detection_method_id
          || payload.owner_actor_id !== manifest.contamination?.owner_actor_id
          || payload.observed_at !== event.occurred_at) {
          issue(errors, 'CONTAMINATION_OBSERVATION_INVALID', 'payload', 'Contamination observation must match the frozen method.')
        }
      } else {
        if (!requirePayloadKeys(
          errors,
          payload,
          ['slice_id', 'contaminated', 'assigned_arm', 'observed_policy', 'reason'],
          ['supersedes_event_id'],
        )) break
        if (typeof payload.contaminated !== 'boolean'
          || !['pm_routed', 'receiver_owned'].includes(payload.assigned_arm)
          || !['pm_routed', 'receiver_owned'].includes(payload.observed_policy)
          || (!payload.contaminated && payload.reason !== null)
          || (payload.contaminated && (typeof payload.reason !== 'string' || payload.reason.length === 0))) {
          issue(errors, 'CONTAMINATION_OBSERVATION_INVALID', 'payload', 'Contamination must be explicit and arm-bound.')
        }
      }
      break
    }
    case 'preregistration_frozen': {
      const rich = Object.hasOwn(payload ?? {}, 'manifest_id')
      if (rich) {
        if (requirePayloadKeys(
          errors,
          payload,
          [
            'manifest_id', 'manifest_digest', 'frozen_at', 'seed_commitment',
            'external_anchor_ref', 'external_anchor_digest', 'automatic_routing',
          ],
        )) {
          if (payload.manifest_id !== manifest.manifest_id
            || payload.manifest_digest !== manifest.manifest_digest
            || payload.frozen_at !== manifest.frozen_at
            || payload.seed_commitment !== seedCommitmentOf(manifest)
            || payload.external_anchor_ref !== manifest.external_anchor?.anchor_ref
            || payload.external_anchor_digest !== manifest.external_anchor?.anchor_digest
            || payload.automatic_routing !== false) {
            issue(errors, 'FREEZE_EVENT_INVALID', 'payload', 'Freeze event must exactly bind the frozen manifest and anchor.')
          }
        }
      } else {
        requirePayloadKeys(errors, payload, ['manifest_digest', 'seed_commitment', 'external_anchor_ref'])
      }
      break
    }
    case 'slice_eligible': {
      const rich = Object.hasOwn(payload ?? {}, 'eligible_at')
      if (rich) {
        if (requirePayloadKeys(
          errors,
          payload,
          ['slice_id', 'eligible_at', 'stable_source_digest', 'boundary', 'strata'],
        )) {
          if (payload.eligible_at !== event.occurred_at
            || !DIGEST_RE.test(payload.stable_source_digest ?? '')
            || payload.boundary?.sender_phase !== manifest.boundary.sender_phase
            || payload.boundary?.receiver_phase !== manifest.boundary.receiver_phase
            || canonicalJson(Object.keys(payload.strata).sort())
              !== canonicalJson([...registeredStrata(manifest)].sort())) {
            issue(errors, 'ELIGIBILITY_INVALID', 'payload', 'Eligibility event does not match the frozen boundary and strata.')
          }
        }
      } else {
        requirePayloadKeys(errors, payload, ['slice_id', 'strata', 'eligibility_ref'])
      }
      break
    }
    case 'observation_superseded':
      if (requirePayloadKeys(
        errors,
        payload,
        ['target_event_id', 'replacement_event_id', 'reason_code', 'superseded_at'],
      )) {
        if (!DIGEST_RE.test(payload.target_event_id ?? '')
          || !DIGEST_RE.test(payload.replacement_event_id ?? '')
          || payload.target_event_id === payload.replacement_event_id
          || !SUPERSESSION_REASON_CODES.has(payload.reason_code)
          || payload.superseded_at !== event.occurred_at) {
          issue(
            errors,
            'SUPERSESSION_PAYLOAD_INVALID',
            'payload',
            'Supersession must name distinct digest-bound observations, an allowlisted reason, and its event time.',
          )
        }
      }
      break
    case 'analysis_window_closed':
      requirePayloadKeys(errors, payload, ['analysis_as_of'])
      break
    case 'source_observed':
      if (requirePayloadKeys(errors, payload, ['slice_id', 'signal', 'correlation_id'])) {
        const signals = new Set([
          'DISPATCH_RECORDED',
          'WORKER_TERMINAL_DONE',
          'WORKER_TERMINAL_BLOCKED',
          'WORKER_TERMINAL_FAILED',
          'PM_VERDICT_PASS',
          'PM_VERDICT_REJECT',
          'PM_VERDICT_UNRESOLVED',
        ])
        if (!signals.has(payload.signal)
          || typeof payload.correlation_id !== 'string'
          || !ID_RE.test(payload.correlation_id)) {
          issue(errors, 'SOURCE_SIGNAL_INVALID', 'payload', 'Named-source signal is not allowlisted or correlated.')
        }
      }
      break
    default:
      break
  }
}

function requiredRoleForEvent(event) {
  if (event.event_type === 'slice_assigned') return ['assignment_custodian', 'experiment_owner']
  if (event.event_type === 'artifact_observed') return ['sender']
  if (event.event_type === 'cost_observed'
    || event.event_type === 'outcome_observed'
    || event.event_type === 'contamination_observed') return ['metric_producer']
  if (event.event_type === 'guardrail_observed') return ['guardrail_producer', 'metric_producer']
  if (event.event_type === 'attempt_transition_observed') {
    return {
      propose: ['sender'],
      accept: ['receiver_phase_lead'],
      reject: ['receiver_phase_lead'],
      cancel: ['sender', 'pm'],
      abandon: ['pm'],
      escalate: ['sender', 'receiver_phase_lead', 'pm'],
      resolve_exception: ['pm'],
    }[event.payload?.action ?? event.payload?.transition] ?? []
  }
  if (event.event_type === 'preregistration_frozen'
    || event.event_type === 'slice_eligible'
    || event.event_type === 'analysis_window_closed') return ['experiment_owner']
  if (event.event_type === 'source_observed') return ['metric_producer', 'pm']
  if (event.event_type === 'observation_superseded') return ['metric_producer']
  return []
}

export function validatePilotEvent(event, context = {}) {
  const manifest = context.manifest ?? context
  const errors = []
  if (!isObject(event)) {
    issue(errors, 'EVENT_OBJECT_REQUIRED', '', 'Event must be an object.')
    return { valid: false, errors }
  }
  requireExactKeys(
    errors,
    event,
    EVENT_KEYS,
    '',
    'EVENT_OBJECT_REQUIRED',
    'EVENT_UNKNOWN_FIELD',
    'EVENT_FIELD_REQUIRED',
  )
  if (event.schema !== EVENT_SCHEMA || event.schema_version !== EVENT_SCHEMA_VERSION) {
    issue(errors, 'EVENT_VERSION_INVALID', 'schema_version', 'Event schema/version is invalid.')
  }
  if (!EVENT_TYPES.has(event.event_type)) issue(errors, 'EVENT_TYPE_INVALID', 'event_type', 'Event type is closed.')
  if (strictMillis(event.occurred_at) === null) issue(errors, 'EVENT_TIME_INVALID', 'occurred_at', 'Event time must be strict RFC3339.')
  if (!DIGEST_RE.test(event.event_id ?? '') || canonicalDigest(unsignedEvent(event)) !== event.event_id) {
    issue(errors, 'EVENT_DIGEST_MISMATCH', 'event_id', 'event_id must bind the canonical event body.')
  }
  if (isObject(manifest)) {
    if (event.experiment_id !== manifest.experiment_id) issue(errors, 'EVENT_EXPERIMENT_MISMATCH', 'experiment_id', 'Event experiment does not match manifest.')
    if (event.manifest_digest !== manifest.manifest_digest) issue(errors, 'EVENT_MANIFEST_MISMATCH', 'manifest_digest', 'Event manifest digest does not match frozen manifest.')
  }
  if (requireExactKeys(
    errors,
    event.aggregate,
    AGGREGATE_KEYS,
    'aggregate',
    'AGGREGATE_INVALID',
    'EVENT_UNKNOWN_FIELD',
    'AGGREGATE_FIELD_REQUIRED',
  )) {
    if (typeof event.aggregate.type !== 'string' || !ID_RE.test(event.aggregate.type)
      || typeof event.aggregate.id !== 'string' || !ID_RE.test(event.aggregate.id)
      || !Number.isSafeInteger(event.aggregate.sequence)
      || event.aggregate.sequence < 1
      || (event.aggregate.previous_event_id !== null && !DIGEST_RE.test(event.aggregate.previous_event_id))) {
      issue(errors, 'AGGREGATE_INVALID', 'aggregate', 'Aggregate chain fields are invalid.')
    }
  }
  validateSource(errors, event.source)
  if (isObject(manifest)) {
    validateActorClaim(errors, event.claimed_actor, manifest, event)
    const allowedRoles = requiredRoleForEvent(event)
    if (!allowedRoles.includes(event.claimed_actor?.role)) {
      issue(errors, 'ACTOR_UNAUTHORIZED', 'claimed_actor.role', 'Actor role cannot record this event.')
    }
    validateEventPayload(errors, event, manifest)
  }
  return { valid: errors.length === 0, errors }
}

function eventsArray(ledger) {
  if (Array.isArray(ledger)) return ledger
  if (Array.isArray(ledger?.events)) return ledger.events
  if (Array.isArray(ledger?.ledger)) return ledger.ledger
  fail('LEDGER_INVALID', 'ledger', 'Ledger must be an array or contain an events/ledger array.')
}

function aggregateEvents(events, type, id) {
  return events.filter((event) => event.aggregate?.type === type && event.aggregate?.id === id)
    .sort((left, right) => left.aggregate.sequence - right.aggregate.sequence)
}

function assignmentFor(events, sliceId) {
  return events.find((event) => event.event_type === 'slice_assigned' && event.payload?.slice_id === sliceId)
}

function sliceIdForEvent(event) {
  return event.payload?.slice_id
    ?? (event.event_type === 'slice_assigned' ? event.aggregate?.id : null)
}

function supersessionIdentity(event) {
  const sliceId = event.payload?.slice_id
  switch (event.event_type) {
    case 'cost_observed':
      return canonicalJson([event.event_type, sliceId, event.payload?.category])
    case 'guardrail_observed':
      return canonicalJson([
        event.event_type,
        sliceId,
        event.payload?.guardrail ?? event.payload?.name,
      ])
    case 'source_observed':
      return canonicalJson([event.event_type, sliceId, event.payload?.correlation_id])
    case 'outcome_observed':
    case 'contamination_observed':
      return canonicalJson([event.event_type, sliceId])
    default:
      return null
  }
}

function validateSupersessionLedger(events) {
  const errors = []
  const byId = new Map(events.map((event) => [event.event_id, event]))
  const targeted = new Set()
  for (const correction of sortEvents(
    events.filter((event) => event.event_type === 'observation_superseded'),
  )) {
    const targetId = correction.payload?.target_event_id
    const replacementId = correction.payload?.replacement_event_id
    const target = byId.get(targetId)
    const replacement = byId.get(replacementId)
    if (!target || !replacement) {
      issue(
        errors,
        'SUPERSESSION_REFERENCE_MISSING',
        'payload',
        'Supersession target and replacement must already exist in the event ledger.',
      )
      continue
    }
    if (targeted.has(targetId)) {
      issue(
        errors,
        'SUPERSESSION_TARGET_CONFLICT',
        'payload.target_event_id',
        'An observation can be superseded only once.',
      )
    }
    targeted.add(targetId)
    if (target.event_type !== replacement.event_type
      || !SUPERSEDEABLE_EVENT_TYPES.has(target.event_type)
      || supersessionIdentity(target) !== supersessionIdentity(replacement)) {
      issue(
        errors,
        'SUPERSESSION_SCOPE_MISMATCH',
        'payload',
        'Replacement must be a later observation of the same allowlisted kind, slice, and measurement dimension.',
      )
    }
    const targetTime = strictMillis(target.occurred_at)
    const replacementTime = strictMillis(replacement.occurred_at)
    const correctionTime = strictMillis(correction.occurred_at)
    if (targetTime === null
      || replacementTime === null
      || correctionTime === null
      || replacementTime <= targetTime
      || correctionTime < replacementTime) {
      issue(
        errors,
        'SUPERSESSION_ORDER_INVALID',
        'occurred_at',
        'Replacement must occur strictly after its target and no later than the supersession record.',
      )
    }
  }
  return errors
}

function effectiveEvents(events) {
  const superseded = new Set(events
    .filter((event) => event.event_type === 'observation_superseded')
    .map((event) => event.payload.target_event_id))
  return events.filter((event) => !superseded.has(event.event_id))
}

function assertAggregateAppend(events, event) {
  const chain = aggregateEvents(events, event.aggregate.type, event.aggregate.id)
  const prior = chain.at(-1)
  const expectedSequence = prior ? prior.aggregate.sequence + 1 : 1
  const expectedPrevious = prior?.event_id ?? null
  if (event.aggregate.sequence !== expectedSequence) {
    fail('AGGREGATE_SEQUENCE_GAP', 'aggregate.sequence', 'Aggregate sequence must be contiguous.')
  }
  if (event.aggregate.previous_event_id !== expectedPrevious) {
    fail('AGGREGATE_CHAIN_CONFLICT', 'aggregate.previous_event_id', 'Aggregate previous-event link is invalid.')
  }
  if (prior && strictMillis(event.occurred_at) < strictMillis(prior.occurred_at)) {
    fail('EVENT_BACKDATED', 'occurred_at', 'Aggregate events cannot move backward in time.')
  }
}

function assertAttemptTransition(manifest, events, event) {
  if (event.event_type !== 'attempt_transition_observed') return
  const payload = event.payload
  const chain = aggregateEvents(events, 'attempt', payload.attempt_id)
  const transitions = chain.filter((item) => item.event_type === 'attempt_transition_observed')
  let state = {
    state: 'draft',
    receiver_phase: payload.receiver_phase ?? payload.boundary?.receiver_phase,
    actors: manifest.actors,
    events: [],
  }
  for (const item of transitions) {
    try {
      state = reduceHandoffAttempt(state, {
        type: item.payload.action ?? item.payload.transition,
        actor_id: item.claimed_actor.actor_id,
        at: item.occurred_at,
      })
    } catch (error) {
      if (error instanceof ContractValidationError) throw new PilotValidationError(error.errors)
      throw error
    }
  }
  try {
    reduceHandoffAttempt(state, {
      type: payload.action ?? payload.transition,
      actor_id: event.claimed_actor.actor_id,
      at: event.occurred_at,
    })
  } catch (error) {
    if (error instanceof ContractValidationError) {
      const terminal = error.errors.some(({ code }) => code === 'TERMINAL_ATTEMPT_IMMUTABLE')
      if (terminal) fail('TERMINAL_ATTEMPT_IMMUTABLE', 'payload.transition', 'Terminal attempts cannot be changed.')
      throw new PilotValidationError(error.errors)
    }
    throw error
  }
  if ((payload.action ?? payload.transition) === 'propose' && payload.revision_of_attempt_id) {
    const parent = aggregateEvents(events, 'attempt', payload.revision_of_attempt_id)
      .filter((item) => item.event_type === 'attempt_transition_observed')
      .at(-1)
    if (!parent || (parent.payload.action ?? parent.payload.transition) !== 'reject'
      || strictMillis(event.occurred_at) <= strictMillis(parent.occurred_at)) {
      fail('REVISION_TIME_INVALID', 'occurred_at', 'Revision proposal must strictly follow its rejected parent.')
    }
  }
}

export function appendPilotEvent(manifest, ledger, event) {
  const manifestValidation = validateFrozenManifest(manifest)
  if (!manifestValidation.valid) throw new PilotValidationError(manifestValidation.errors)
  const current = eventsArray(ledger)
  const validation = validatePilotEvent(event, { manifest })
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  const existing = current.find((item) => item.event_id === event.event_id)
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(event)) return clone(current)
    fail('EVENT_ID_CONFLICT', 'event_id', 'An event ID cannot bind different content.')
  }
  const sameAggregateSequence = current.find((item) => item.aggregate?.type === event.aggregate.type
    && item.aggregate?.id === event.aggregate.id
    && item.aggregate?.sequence === event.aggregate.sequence)
  if (sameAggregateSequence) fail('AGGREGATE_FORK', 'aggregate.sequence', 'Aggregate sequence is already occupied.')
  const sliceId = sliceIdForEvent(event)
  if (event.event_type === 'slice_eligible') {
    const start = strictMillis(assignmentWindow(manifest)?.start)
    if (strictMillis(event.occurred_at) < strictMillis(manifest.frozen_at)
      || (start !== null && strictMillis(event.occurred_at) > start)) {
      fail('ELIGIBILITY_TIME_INVALID', 'occurred_at', 'Eligibility must be recorded after freeze and no later than assignment-window start.')
    }
  } else if (event.event_type === 'slice_assigned') {
    const priorAssignment = assignmentFor(current, sliceId)
    if (priorAssignment) fail('ASSIGNMENT_CONFLICT', 'payload.slice_id', 'A slice cannot be reassigned.')
    const assignedAt = strictMillis(event.occurred_at)
    const window = assignmentWindow(manifest)
    const start = strictMillis(window?.start)
    const end = strictMillis(window?.end)
    if (assignedAt < start || assignedAt >= end) fail('ASSIGNMENT_OUTSIDE_WINDOW', 'occurred_at', 'Assignment must be inside [start,end).')
  } else if (sliceId) {
    const assignment = assignmentFor(current, sliceId)
    if (!assignment) fail('SLICE_NOT_ASSIGNED', 'payload.slice_id', 'Observations require a prior assignment.')
    if (strictMillis(event.occurred_at) < strictMillis(assignment.occurred_at)) {
      fail('EVENT_BEFORE_ASSIGNMENT', 'occurred_at', 'Observation cannot predate assignment.')
    }
  }
  if (event.event_type === 'observation_superseded') {
    const supersessionErrors = validateSupersessionLedger([...current, event])
    if (supersessionErrors.length) throw new PilotValidationError(supersessionErrors)
  }
  assertAggregateAppend(current, event)
  assertAttemptTransition(manifest, current, event)
  return [...clone(current), clone(event)]
}

export function deriveAssignment({ manifest, eligibility, seed }) {
  const validation = validateFrozenManifest(manifest)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  if (!isObject(eligibility)
    || typeof eligibility.slice_id !== 'string'
    || !ID_RE.test(eligibility.slice_id)
    || !isObject(eligibility.strata)
    || eligibility.eligible !== true) {
    fail('ELIGIBILITY_INVALID', 'eligibility', 'Eligible slice ID and strata are required.')
  }
  if (Object.hasOwn(eligibility, 'arm')) fail('ARM_OVERRIDE_FORBIDDEN', 'eligibility.arm', 'Assignment arm cannot be supplied by the caller.')
  const strataKeys = Object.keys(eligibility.strata)
  const registered = registeredStrata(manifest)
  if (strataKeys.length !== registered.length
    || registered.some((key) => !Object.hasOwn(eligibility.strata, key)
      || eligibility.strata[key] === null
      || eligibility.strata[key] === '')) {
    fail('ELIGIBILITY_STRATA_INVALID', 'eligibility.strata', 'Eligibility must provide every frozen stratum exactly once.')
  }
  if (digestText(seed) !== seedCommitmentOf(manifest)) {
    fail('ASSIGNMENT_SEED_MISMATCH', 'seed', 'Assignment seed does not match the frozen commitment.')
  }
  const message = [
    assignmentMethodOf(manifest),
    manifest.manifest_digest,
    canonicalJson(eligibility.strata),
    eligibility.slice_id,
  ].join('\0')
  const digest = createHmac('sha256', seed).update(message).digest('hex')
  const arm = BigInt(`0x${digest}`) % 2n === 0n ? 'pm_routed' : 'receiver_owned'
  return {
    slice_id: eligibility.slice_id,
    strata: clone(eligibility.strata),
    arm,
    assignment_score_digest: `sha256:${digest}`,
    assignment_algorithm: ASSIGNMENT_ALGORITHM,
  }
}

export function createFreezeEvent(manifest, { actorId } = {}) {
  const validation = validateFrozenManifest(manifest)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  if (!actorIds(manifest, 'experiment_owner').includes(actorId)) {
    fail('ACTOR_UNAUTHORIZED', 'actorId', 'Only a registered experiment owner may record the freeze.')
  }
  const payload = {
    manifest_id: manifest.manifest_id,
    manifest_digest: manifest.manifest_digest,
    frozen_at: manifest.frozen_at,
    seed_commitment: seedCommitmentOf(manifest),
    external_anchor_ref: manifest.external_anchor.anchor_ref,
    external_anchor_digest: manifest.external_anchor.anchor_digest,
    automatic_routing: false,
  }
  const unsigned = {
    schema: EVENT_SCHEMA,
    schema_version: EVENT_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    aggregate: {
      type: 'experiment',
      id: manifest.experiment_id,
      sequence: 1,
      previous_event_id: null,
    },
    event_type: 'preregistration_frozen',
    occurred_at: manifest.frozen_at,
    claimed_actor: { actor_id: actorId, role: 'experiment_owner' },
    source: {
      kind: 'pilot_manifest',
      source_ref: manifest.external_anchor.anchor_ref,
      source_digest: manifest.external_anchor.anchor_digest,
      trust_level: 'advisory_same_uid',
    },
    payload,
  }
  return { ...unsigned, event_id: canonicalDigest(unsigned) }
}

export function createEligibilityEvent(manifest, candidate, {
  eligibleAt,
  actorId,
} = {}) {
  const validation = validateFrozenManifest(manifest)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  if (!isObject(candidate)
    || Object.keys(candidate).some((key) => !['slice_id', 'strata', 'eligible'].includes(key))
    || typeof candidate.slice_id !== 'string'
    || !ID_RE.test(candidate.slice_id)
    || candidate.eligible !== true
    || !isObject(candidate.strata)) {
    fail('ELIGIBILITY_INVALID', 'candidate', 'Candidate must contain only a stable eligible slice ID and frozen strata.')
  }
  if (!actorIds(manifest, 'experiment_owner').includes(actorId)) {
    fail('ACTOR_UNAUTHORIZED', 'actorId', 'Only a registered experiment owner may record eligibility.')
  }
  const registered = [...registeredStrata(manifest)].sort()
  if (canonicalJson(Object.keys(candidate.strata).sort()) !== canonicalJson(registered)) {
    fail('ELIGIBILITY_STRATA_INVALID', 'candidate.strata', 'Candidate must provide every frozen stratum exactly once.')
  }
  const boundary = {
    sender_phase: manifest.boundary.sender_phase,
    receiver_phase: manifest.boundary.receiver_phase,
  }
  const payload = {
    slice_id: candidate.slice_id,
    eligible_at: eligibleAt,
    stable_source_digest: canonicalDigest({
      slice_id: candidate.slice_id,
      strata: candidate.strata,
      eligibility_source_digest: manifest.eligibility?.eligible_source_digest ?? null,
    }),
    boundary,
    strata: clone(candidate.strata),
  }
  const unsigned = {
    schema: EVENT_SCHEMA,
    schema_version: EVENT_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    aggregate: {
      type: 'observation',
      id: `elig-${canonicalDigest(candidate).slice(-40)}`,
      sequence: 1,
      previous_event_id: null,
    },
    event_type: 'slice_eligible',
    occurred_at: eligibleAt,
    claimed_actor: { actor_id: actorId, role: 'experiment_owner' },
    source: {
      kind: 'pilot_manifest',
      source_ref: manifest.eligibility?.eligible_source_ref ?? `eligibility:${candidate.slice_id}`,
      source_digest: manifest.eligibility?.eligible_source_digest ?? payload.stable_source_digest,
      trust_level: 'advisory_same_uid',
    },
    payload,
  }
  return { ...unsigned, event_id: canonicalDigest(unsigned) }
}

export function createAssignmentEvent(manifest, ledger, candidate, options = {}) {
  const current = eventsArray(ledger)
  if (Object.hasOwn(candidate ?? {}, 'arm')) fail('ARM_OVERRIDE_FORBIDDEN', 'candidate.arm', 'Assignment arm cannot be supplied.')
  const existing = assignmentFor(current, candidate?.slice_id)
  if (existing) {
    if (canonicalJson(existing.payload.strata) !== canonicalJson(candidate?.strata)) {
      fail('ASSIGNMENT_CONFLICT', 'candidate.strata', 'Existing slice assignment binds different strata.')
    }
    const derived = deriveAssignment({
      manifest,
      eligibility: candidate,
      seed: options.assignmentSeed,
    })
    if (existing.payload.arm !== derived.arm) fail('ASSIGNMENT_CONFLICT', 'payload.arm', 'Existing assignment does not match committed seed.')
    return clone(existing)
  }
  const assignedAt = options.assignedAt
  const assignedMillis = strictMillis(assignedAt)
  const window = assignmentWindow(manifest)
  const start = strictMillis(window?.start)
  const end = strictMillis(window?.end)
  if (assignedMillis === null || start === null || end === null || assignedMillis < start || assignedMillis >= end) {
    fail('ASSIGNMENT_OUTSIDE_WINDOW', 'assignedAt', 'Assignment must be inside the frozen half-open window.')
  }
  const assignmentRole = Object.hasOwn(manifest, 'assignment')
    ? 'assignment_custodian'
    : 'experiment_owner'
  if (!actorIds(manifest, assignmentRole).includes(options.actorId)) {
    fail('ACTOR_UNAUTHORIZED', 'actorId', 'Only the registered assignment custodian may record assignment.')
  }
  const derived = deriveAssignment({
    manifest,
    eligibility: candidate,
    seed: options.assignmentSeed,
  })
  const rich = Object.hasOwn(manifest, 'assignment')
  const payload = rich
    ? {
        slice_id: derived.slice_id,
        arm: derived.arm,
        assigned_at: assignedAt,
        algorithm: ASSIGNMENT_ALGORITHM,
        algorithm_version: 1,
        assignment_score: derived.assignment_score_digest.slice('sha256:'.length),
        seed_commitment: seedCommitmentOf(manifest),
        assignment_digest: canonicalDigest({
          experiment_id: manifest.experiment_id,
          manifest_digest: manifest.manifest_digest,
          slice_id: derived.slice_id,
          arm: derived.arm,
          assigned_at: assignedAt,
          strata: derived.strata,
          assignment_score: derived.assignment_score_digest,
        }),
        strata: derived.strata,
        arm_override: false,
      }
    : {
        slice_id: derived.slice_id,
        arm: derived.arm,
        strata: derived.strata,
        assigned_at: assignedAt,
        assignment_algorithm: ASSIGNMENT_ALGORITHM,
        manual_policy: {
          routing_owner: derived.arm === 'pm_routed' ? 'pm' : 'receiver',
          auto_execute: false,
        },
      }
  const unsigned = {
    schema: EVENT_SCHEMA,
    schema_version: EVENT_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    aggregate: {
      type: 'slice',
      id: derived.slice_id,
      sequence: 1,
      previous_event_id: null,
    },
    event_type: 'slice_assigned',
    occurred_at: assignedAt,
    claimed_actor: {
      actor_id: options.actorId,
      role: rich ? 'assignment_custodian' : 'experiment_owner',
    },
    source: {
      kind: rich ? 'assignment_engine' : 'pilot_runner',
      source_ref: `assignment:${derived.slice_id}`,
      source_digest: canonicalDigest({
        candidate: { slice_id: derived.slice_id, strata: derived.strata, eligible: true },
        assignment_score_digest: derived.assignment_score_digest,
        recorded_at: options.recordedAt ?? assignedAt,
      }),
      trust_level: 'advisory_same_uid',
    },
    payload,
  }
  return { ...unsigned, event_id: canonicalDigest(unsigned) }
}

function sortEvents(events) {
  return [...events].sort((left, right) => {
    const time = strictMillis(left.occurred_at) - strictMillis(right.occurred_at)
    if (time) return time
    const aggregate = `${left.aggregate.type}\0${left.aggregate.id}`.localeCompare(`${right.aggregate.type}\0${right.aggregate.id}`)
    if (aggregate) return aggregate
    return left.aggregate.sequence - right.aggregate.sequence
  })
}

function validateReplayLedger(manifest, events, asOf) {
  const errors = []
  const byAggregate = new Map()
  const eventIds = new Set()
  for (const event of events) {
    const validation = validatePilotEvent(event, { manifest })
    errors.push(...validation.errors)
    if (eventIds.has(event.event_id)) continue
    eventIds.add(event.event_id)
    const key = `${event.aggregate?.type}\0${event.aggregate?.id}`
    const rows = byAggregate.get(key) ?? []
    rows.push(event)
    byAggregate.set(key, rows)
    if (strictMillis(event.occurred_at) > asOf) {
      issue(errors, 'EVENT_AFTER_ANALYSIS', 'occurred_at', 'Event occurs after analysis_as_of.')
    }
  }
  for (const rows of byAggregate.values()) {
    rows.sort((left, right) => left.aggregate.sequence - right.aggregate.sequence)
    let previous = null
    rows.forEach((event, index) => {
      if (event.aggregate.sequence !== index + 1) issue(errors, 'AGGREGATE_SEQUENCE_GAP', 'aggregate.sequence', 'Aggregate sequence is not contiguous.')
      if (event.aggregate.previous_event_id !== previous) issue(errors, 'AGGREGATE_CHAIN_CONFLICT', 'aggregate.previous_event_id', 'Aggregate chain is broken.')
      previous = event.event_id
    })
  }
  errors.push(...validateSupersessionLedger(events))
  return errors
}

function latestObservation(events, eventType, sliceId, selector = () => true) {
  return sortEvents(events.filter((event) => event.event_type === eventType
    && event.payload?.slice_id === sliceId
    && selector(event))).at(-1)
}

function materializedArtifact(payload, phase) {
  if (payload?.artifact) return clone(payload.artifact)
  if (!payload?.artifact_id) return null
  const artifact = {
    type: payload.artifact_type,
    artifact_id: payload.artifact_id,
    version: payload.artifact_version,
    digest: payload.artifact_digest,
    predecessor_trace: clone(payload.predecessor_trace),
    validation_evidence: clone(payload.validation_evidence_digests),
    expectations: {
      security: 'observed_requirement',
      performance: 'observed_requirement',
      integration: 'observed_requirement',
      uat: 'observed_requirement',
    },
  }
  if (phase === 'Requirement') {
    artifact.business_functions = [`artifact-digest:${payload.artifact_digest}`]
    artifact.validation_exceptions = []
  }
  const field = {
    Prototype: 'clickable_prototype_ref',
    Development: 'working_software_ref',
    QA: 'e2e_uat_report_ref',
  }[phase]
  if (field) artifact[field] = `artifact-digest:${payload.artifact_digest}`
  return artifact
}

function materializeAttempt(manifest, events, attemptId) {
  const chain = aggregateEvents(events, 'attempt', attemptId)
  const artifactEvent = chain.find((event) => event.event_type === 'artifact_observed')
  const transitions = chain.filter((event) => event.event_type === 'attempt_transition_observed')
  if (!transitions.length) return null
  let live = {
    state: 'draft',
    receiver_phase: manifest.boundary.receiver_phase,
    actors: manifest.actors,
    events: [],
  }
  for (const event of transitions) {
    try {
      live = reduceHandoffAttempt(live, {
        type: event.payload.action ?? event.payload.transition,
        actor_id: event.claimed_actor.actor_id,
        at: event.occurred_at,
      })
    } catch (error) {
      if (error instanceof ContractValidationError) throw new PilotValidationError(error.errors)
      throw error
    }
  }
  if (!TERMINAL_STATES.has(live.state)) return {
    attempt_id: attemptId,
    sender_phase: manifest.boundary.sender_phase,
    receiver_phase: manifest.boundary.receiver_phase,
    state: live.state,
    exit_artifact: materializedArtifact(artifactEvent?.payload, manifest.boundary.sender_phase),
    events: live.events,
    complete: false,
  }
  const propose = transitions.find((event) => (event.payload.action ?? event.payload.transition) === 'propose')
  const terminal = transitions.at(-1)
  return {
    attempt_id: attemptId,
    ...(propose?.payload?.revision_of_attempt_id
      ? { revision_of_attempt_id: propose.payload.revision_of_attempt_id }
      : {}),
    sender_phase: manifest.boundary.sender_phase,
    receiver_phase: manifest.boundary.receiver_phase,
    state: live.state,
    sunk_cost_minutes: terminal.payload.sunk_cost_minutes ?? 0,
    exit_artifact: materializedArtifact(artifactEvent?.payload, manifest.boundary.sender_phase),
    events: live.events,
    complete: artifactEvent !== undefined,
  }
}

export function replayPilot({ manifest, events, asOf }) {
  const manifestValidation = validateFrozenManifest(manifest)
  if (!manifestValidation.valid) throw new PilotValidationError(manifestValidation.errors)
  const analysisMillis = strictMillis(asOf)
  if (analysisMillis === null) fail('ANALYSIS_AS_OF_INVALID', 'asOf', 'asOf must be strict RFC3339.')
  const ledger = eventsArray(events)
  const errors = validateReplayLedger(manifest, ledger, analysisMillis)
  if (errors.length) throw new PilotValidationError(errors)
  const sorted = sortEvents(ledger)
  const materialized = effectiveEvents(sorted)
  const assignments = materialized.filter((event) => event.event_type === 'slice_assigned')
  const duplicateSlices = assignments.filter((event, index) => assignments
    .findIndex((other) => other.payload.slice_id === event.payload.slice_id) !== index)
  if (duplicateSlices.length) fail('ASSIGNMENT_CONFLICT', 'events', 'A slice has more than one assignment.')

  const slices = assignments.map((assignment) => {
    const sliceId = assignment.payload.slice_id
    const attemptIds = [...new Set(materialized
      .filter((event) => event.aggregate.type === 'attempt' && event.payload?.slice_id === sliceId)
      .map((event) => event.aggregate.id))]
    const attempts = attemptIds.map((attemptId) => materializeAttempt(manifest, materialized, attemptId)).filter(Boolean)
    const costEvents = Object.fromEntries(COST_CATEGORIES.map((category) => [
      category,
      latestObservation(
        materialized,
        'cost_observed',
        sliceId,
        (item) => item.payload.category === category,
      ) ?? null,
    ]))
    const costs = Object.fromEntries(COST_CATEGORIES.map((category) => [
      category,
      costEvents[category]?.payload?.minutes ?? null,
    ]))
    const outcomeEvent = latestObservation(materialized, 'outcome_observed', sliceId)
    const guardrailEvents = Object.fromEntries(GUARDRAIL_NAMES.map((name) => [
      name,
      latestObservation(
        materialized,
        'guardrail_observed',
        sliceId,
        (item) => (item.payload.guardrail ?? item.payload.name) === name,
      ) ?? null,
    ]))
    const guardrails = Object.fromEntries(GUARDRAIL_NAMES.map((name) => [
      name,
      guardrailEvents[name]?.payload?.status ?? 'UNKNOWN',
    ]))
    const contaminationEvent = latestObservation(materialized, 'contamination_observed', sliceId)
    const openAttempts = attempts.filter((attempt) => !attempt.complete || !TERMINAL_STATES.has(attempt.state))
    const observationCoverage = {
      costs: Object.fromEntries(COST_CATEGORIES.map((category) => [
        category,
        costEvents[category] === null ? 'missing' : 'observed',
      ])),
      outcome: outcomeEvent === undefined ? 'missing' : 'observed',
      guardrails: Object.fromEntries(GUARDRAIL_NAMES.map((name) => [
        name,
        guardrailEvents[name] === null ? 'missing' : 'observed',
      ])),
      contamination: contaminationEvent === undefined ? 'missing' : 'observed',
    }
    return {
      slice_id: sliceId,
      arm: assignment.payload.arm,
      assigned_at: assignment.payload.assigned_at,
      strata: clone(assignment.payload.strata),
      contamination: contaminationEvent?.payload?.contaminated ?? null,
      costs,
      guardrails,
      outcome: outcomeEvent
        ? {
            status: outcomeEvent.payload.status,
            ...(outcomeEvent.payload.time_to_usable_outcome_minutes !== undefined
              ? { time_to_usable_outcome_minutes: outcomeEvent.payload.time_to_usable_outcome_minutes }
              : {}),
            ...(outcomeEvent.payload.value_proxy !== undefined
              ? { value_proxy: outcomeEvent.payload.value_proxy }
              : {}),
          }
        : null,
      handoff_attempts: attempts,
      observation_coverage: observationCoverage,
      live: {
        complete: openAttempts.length === 0
          && attempts.length > 0
          && observationCoverage.contamination === 'observed'
          && observationCoverage.outcome === 'observed'
          && Object.values(observationCoverage.costs).every((status) => status === 'observed')
          && Object.values(observationCoverage.guardrails).every((status) => status === 'observed'),
        open_attempts: openAttempts.length,
      },
    }
  })
  return {
    replay_version: 'delivery-loop-pilot-replay/v1',
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    as_of: asOf,
    trust_level: 'advisory_same_uid',
    automatic_routing: false,
    assignments: assignments.map((event) => ({
      event_id: event.event_id,
      slice_id: event.payload.slice_id,
      arm: event.payload.arm,
      assigned_at: event.payload.assigned_at,
      strata: clone(event.payload.strata),
    })),
    slices,
    diagnostics: [],
  }
}

export function materializeAnalysisInput(replay, manifest) {
  const sourceManifest = manifest ?? replay.manifest
  if (!sourceManifest) fail('MANIFEST_REQUIRED', 'manifest', 'Frozen manifest is required for materialization.')
  const missing = []
  for (const slice of replay.slices ?? []) {
    const coverage = slice.observation_coverage ?? {}
    if (coverage.contamination !== 'observed') {
      missing.push({ code: 'CONTAMINATION_INCOMPLETE', slice_id: slice.slice_id })
    }
    if (coverage.outcome !== 'observed') {
      missing.push({ code: 'OUTCOME_INCOMPLETE', slice_id: slice.slice_id })
    }
    for (const category of COST_CATEGORIES) {
      if (coverage.costs?.[category] !== 'observed') {
        missing.push({ code: 'COST_INCOMPLETE', slice_id: slice.slice_id, category })
      }
    }
    for (const name of GUARDRAIL_NAMES) {
      if (coverage.guardrails?.[name] !== 'observed') {
        missing.push({ code: 'GUARDRAIL_INCOMPLETE', slice_id: slice.slice_id, name })
      }
    }
    if (!slice.handoff_attempts?.length
      || slice.handoff_attempts.some((attempt) => !attempt.complete || !TERMINAL_STATES.has(attempt.state))) {
      missing.push({ code: 'ATTEMPT_INCOMPLETE', slice_id: slice.slice_id })
    }
  }
  if (missing.length) throw new PilotValidationError(missing, missing[0].code)
  const experiment = {
    schema_version: 'delivery-loop-poc/v1',
    experiment_id: sourceManifest.experiment_id,
    analysis_as_of: replay.as_of,
    preregistration: stageZeroPreregistration(sourceManifest),
    maturity: { min_follow_up_days: sourceManifest.maturity.min_follow_up_days },
    thresholds: clone(sourceManifest.thresholds),
    actors: clone(sourceManifest.actors),
    cost_model: clone(sourceManifest.cost_model),
    evidence: { provenance: 'observed_unverified' },
    slices: replay.slices.map((slice) => ({
      slice_id: slice.slice_id,
      arm: slice.arm,
      assigned_at: slice.assigned_at,
      strata: clone(slice.strata),
      contamination: slice.contamination,
      costs: clone(slice.costs),
      guardrails: clone(slice.guardrails),
      outcome: clone(slice.outcome),
      handoff_attempts: slice.handoff_attempts.map(({ complete, ...attempt }) => clone(attempt)),
    })),
  }
  const validation = validateExperiment(experiment)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  return experiment
}

export function compileExperiment(manifest, ledger, { analysisAsOf } = {}) {
  const replay = replayPilot({ manifest, events: ledger, asOf: analysisAsOf })
  const experiment = materializeAnalysisInput(replay, manifest)
  return { experiment, replay }
}

function traceIndex(events) {
  return sortEvents(events).map((event) => ({
    event_id: event.event_id,
    aggregate_type: event.aggregate.type,
    aggregate_id: event.aggregate.id,
    sequence: event.aggregate.sequence,
    event_type: event.event_type,
    source_digest: event.source.source_digest,
  }))
}

export function buildEvidenceIndex({ manifest, events, replay, files = [] }) {
  return {
    index_version: 'delivery-loop-evidence-index/v1',
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    replay_digest: canonicalDigest(replay),
    event_count: eventsArray(events).length,
    trace_index: traceIndex(eventsArray(events)),
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
    trust_level: 'advisory_same_uid',
    identity_authenticated: false,
    certification_status: 'NOT_CERTIFIED',
    business_decision: 'EXTERNAL_REQUIRED',
    actuation: 'NONE',
  }
}

export function buildEvidencePack(manifest, ledger, { analysisAsOf } = {}) {
  const events = sortEvents(eventsArray(ledger))
  const { experiment, replay } = compileExperiment(manifest, events, { analysisAsOf })
  const analysis = analyzeExperiment(experiment)
  const pack = {
    schema: EVIDENCE_SCHEMA,
    schema_version: EVIDENCE_PACK_VERSION,
    experiment_id: manifest.experiment_id,
    as_of: analysisAsOf,
    trust_level: 'advisory_same_uid',
    identity_authenticated: false,
    certification_status: 'NOT_CERTIFIED',
    business_decision: 'EXTERNAL_REQUIRED',
    actuation: 'NONE',
    automatic_routing: false,
    manifest_digest: manifest.manifest_digest,
    ledger_digest: canonicalDigest(events),
    dataset_digest: canonicalDigest(experiment),
    analysis_digest: canonicalDigest(analysis),
    manifest: clone(manifest),
    ledger: clone(events),
    dataset: experiment,
    analysis,
    replay,
    trace_index: traceIndex(events),
  }
  return { ...pack, pack_digest: canonicalDigest(pack) }
}

export function verifyEvidencePack(pack) {
  const errors = []
  if (!isObject(pack)) return { valid: false, verified: false, errors: [{ code: 'PACK_OBJECT_REQUIRED', path: '', message: 'Pack must be an object.' }] }
  const unsigned = clone(pack)
  delete unsigned.pack_digest
  if (!DIGEST_RE.test(pack.pack_digest ?? '') || canonicalDigest(unsigned) !== pack.pack_digest) {
    issue(errors, 'PACK_DIGEST_MISMATCH', 'pack_digest', 'Pack digest does not match content.')
  }
  if (pack.schema !== EVIDENCE_SCHEMA || pack.schema_version !== EVIDENCE_PACK_VERSION) issue(errors, 'PACK_VERSION_INVALID', 'schema_version', 'Evidence pack version is invalid.')
  if (pack.trust_level !== 'advisory_same_uid'
    || pack.identity_authenticated !== false
    || pack.certification_status !== 'NOT_CERTIFIED'
    || pack.business_decision !== 'EXTERNAL_REQUIRED'
    || pack.actuation !== 'NONE'
    || pack.automatic_routing !== false) {
    issue(errors, 'PACK_TRUST_INVALID', 'trust_level', 'Local evidence pack cannot claim certification, decision, or actuation.')
  }
  const manifestValidation = validateFrozenManifest(pack.manifest)
  if (!manifestValidation.valid) errors.push(...manifestValidation.errors)
  if (pack.manifest_digest !== pack.manifest?.manifest_digest) issue(errors, 'MANIFEST_DIGEST_MISMATCH', 'manifest_digest', 'Pack manifest digest is inconsistent.')
  if (canonicalDigest(pack.ledger) !== pack.ledger_digest) issue(errors, 'LEDGER_DIGEST_MISMATCH', 'ledger_digest', 'Ledger digest is inconsistent.')
  if (canonicalDigest(pack.dataset) !== pack.dataset_digest) issue(errors, 'DATASET_DIGEST_MISMATCH', 'dataset_digest', 'Dataset digest is inconsistent.')
  if (canonicalDigest(pack.analysis) !== pack.analysis_digest) issue(errors, 'ANALYSIS_DIGEST_MISMATCH', 'analysis_digest', 'Analysis digest is inconsistent.')
  try {
    const rebuilt = buildEvidencePack(pack.manifest, pack.ledger, { analysisAsOf: pack.as_of })
    if (rebuilt.pack_digest !== pack.pack_digest) issue(errors, 'PACK_REPLAY_MISMATCH', 'pack_digest', 'Independent replay does not reproduce the pack.')
  } catch (error) {
    issue(errors, 'PACK_REPLAY_FAILED', '', error.message)
  }
  return { valid: errors.length === 0, verified: errors.length === 0, errors }
}

export function reducePilotEvent(state, event) {
  const manifest = state?.manifest
  const events = state?.events ?? []
  const nextEvents = appendPilotEvent(manifest, events, event)
  return { manifest, events: nextEvents }
}
