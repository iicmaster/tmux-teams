import { createHash } from 'node:crypto';

export const PHASE_EXIT_ARTIFACTS = Object.freeze({
  Requirement: 'requirements_baseline',
  Prototype: 'prototype_evaluation',
  Development: 'development_delivery',
  QA: 'qa_release_evidence',
});

export const PHASE_BOUNDARIES = Object.freeze({
  Requirement: 'Prototype',
  Prototype: 'Development',
  Development: 'QA',
  QA: 'ProjectDelivery',
});

export const HANDOFF_TERMINAL_STATES = Object.freeze([
  'accepted', 'rejected', 'cancelled', 'abandoned',
]);

export const GUARDRAIL_NAMES = Object.freeze([
  'security', 'performance', 'integration', 'uat', 'escaped_defects',
]);

export const COST_CATEGORIES = Object.freeze([
  'pm_routing_minutes',
  'pm_exception_minutes',
  'pm_evidence_minutes',
  'receiver_review_minutes',
  'governance_minutes',
  'instrumentation_minutes',
  'queue_wait_minutes',
  'rework_minutes',
  'rejected_work_minutes',
  'abandoned_work_minutes',
  'cancelled_work_minutes',
  'sender_coordination_minutes',
]);

const ARMS = Object.freeze(['pm_routed', 'receiver_owned']);
const ARM_SET = new Set(ARMS);
const PROVENANCE = new Set([
  'synthetic', 'observed_unverified', 'observed_certification_claimed',
]);
const OUTCOME_STATES = new Set([
  'mature', 'immature', 'censored', 'pending', 'cancelled', 'abandoned',
]);
const GUARDRAIL_VALUES = new Set(['PASS', 'BREACH', 'UNKNOWN']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const EVENT_RULES = Object.freeze({
  propose: { from: ['draft'], roles: ['sender'], to: 'proposed' },
  accept: { from: ['proposed'], roles: ['receiver_phase_lead'], to: 'accepted' },
  reject: { from: ['proposed'], roles: ['receiver_phase_lead'], to: 'rejected' },
  cancel: { from: ['proposed'], roles: ['sender', 'pm'], to: 'cancelled' },
  abandon: { from: ['proposed'], roles: ['pm'], to: 'abandoned' },
  escalate: { from: ['proposed'], roles: ['sender', 'receiver_phase_lead', 'pm'], to: 'escalated' },
  resolve_exception: { from: ['escalated'], roles: ['pm'], to: 'proposed' },
});
const SUNK_CATEGORY_BY_STATE = Object.freeze({
  rejected: 'rejected_work_minutes',
  cancelled: 'cancelled_work_minutes',
  abandoned: 'abandoned_work_minutes',
});

export class ContractValidationError extends Error {
  constructor(errors) {
    super('Delivery-loop contract validation failed');
    this.name = 'ContractValidationError';
    this.code = 'DELIVERY_LOOP_VALIDATION_FAILED';
    this.errors = errors;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const arrayOrEmpty = (value) => Array.isArray(value) ? value : [];
const issue = (errors, code, path, message) => errors.push({ code, path, message });
function codePointCompare(left, right) {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();
    if (leftStep.done || rightStep.done) {
      if (leftStep.done && rightStep.done) return 0;
      return leftStep.done ? -1 : 1;
    }
    const leftScalar = leftStep.value.codePointAt(0);
    const rightScalar = rightStep.value.codePointAt(0);
    if (leftScalar !== rightScalar) return leftScalar < rightScalar ? -1 : 1;
  }
}

function rfc3339Millis(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function serializeCanonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item) ?? 'null').join(',')}]`;
  }
  if (isObject(value)) {
    const members = [];
    for (const key of Object.keys(value).sort(codePointCompare)) {
      const serialized = serializeCanonical(value[key]);
      if (serialized !== undefined) members.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${members.join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value);
  return undefined;
}

export function canonicalJson(value) {
  return serializeCanonical(value);
}

export function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function deriveManifestIdentity(input) {
  const preregistration = input?.preregistration ?? null;
  return {
    manifest_id: preregistration?.manifest_id ?? null,
    manifest_digest: canonicalDigest({
      schema_version: input?.schema_version ?? null,
      experiment_id: input?.experiment_id ?? null,
      preregistration,
      maturity: input?.maturity ?? null,
      thresholds: input?.thresholds ?? null,
      cost_model: input?.cost_model ?? null,
      actors: input?.actors ?? null,
    }),
  };
}

function roleIds(actors, role, phase) {
  if (!isObject(actors)) return [];
  const ids = role === 'receiver_phase_lead'
    ? actors.phase_leads?.[phase]
    : actors[`${role}s`] ?? actors[role];
  return arrayOrEmpty(ids);
}

/**
 * Pure reducer for one live HandoffAttempt. Recorded experiment attempts are
 * separately required to replay to a terminal state.
 */
export function reduceHandoffAttempt(attempt, event) {
  const errors = [];
  if (!isObject(attempt)) issue(errors, 'ATTEMPT_OBJECT_REQUIRED', 'attempt', 'Attempt must be an object.');
  if (!isObject(event)) issue(errors, 'EVENT_OBJECT_REQUIRED', 'event', 'Event must be an object.');
  if (errors.length) throw new ContractValidationError(errors);

  const state = attempt.state ?? 'draft';
  const rule = EVENT_RULES[event.type];
  if (!rule) issue(errors, 'EVENT_TYPE_INVALID', 'event.type', 'Event type is not in the closed reducer.');
  if (HANDOFF_TERMINAL_STATES.includes(state)) issue(errors, 'TERMINAL_ATTEMPT_IMMUTABLE', 'attempt.state', 'Terminal attempts cannot be mutated.');
  if (rule && !rule.from.includes(state)) issue(errors, 'TRANSITION_INVALID', 'attempt.state', `Cannot ${event.type} from ${state}.`);
  if (rule && !rule.roles.some((role) => roleIds(attempt.actors, role, attempt.receiver_phase).includes(event.actor_id))) {
    issue(errors, 'ACTOR_UNAUTHORIZED', 'event.actor_id', `Actor is not authorized for ${event.type}.`);
  }
  const proposingActor = arrayOrEmpty(attempt.events)
    .find((recordedEvent) => isObject(recordedEvent) && recordedEvent.type === 'propose')?.actor_id;
  if ((event.type === 'accept' || event.type === 'reject')
    && typeof proposingActor === 'string'
    && event.actor_id === proposingActor) {
    issue(errors, 'ACTOR_SELF_REVIEW_INVALID', 'event.actor_id', 'The proposing actor cannot accept or reject the same attempt.');
  }
  if (errors.length) throw new ContractValidationError(errors);

  return {
    ...attempt,
    state: rule.to,
    events: [
      ...(Array.isArray(attempt.events) ? attempt.events : []),
      { type: event.type, actor_id: event.actor_id, at: event.at ?? null },
    ],
  };
}

function validateNonEmptyStrings(errors, value, path, code) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    issue(errors, code, path, 'Must be a non-empty array of non-empty strings.');
  }
}

function validateArtifact(errors, artifact, phase, path) {
  if (!isObject(artifact)) {
    issue(errors, 'ARTIFACT_REQUIRED', path, 'A phase exit artifact is required.');
    return;
  }
  if (artifact.type !== PHASE_EXIT_ARTIFACTS[phase]) {
    issue(errors, 'ARTIFACT_TYPE_INVALID', `${path}.type`, `Expected ${PHASE_EXIT_ARTIFACTS[phase]}.`);
  }
  for (const field of ['artifact_id', 'version']) {
    if (typeof artifact[field] !== 'string' || artifact[field].length === 0) {
      issue(errors, 'ARTIFACT_FIELD_REQUIRED', `${path}.${field}`, `${field} is required.`);
    }
  }
  if (!SHA256_PATTERN.test(artifact.digest ?? '')) {
    issue(errors, 'ARTIFACT_DIGEST_INVALID', `${path}.digest`, 'Artifact digest must use sha256:<64 lowercase hex>.');
  }
  if (!Array.isArray(artifact.predecessor_trace)
    || artifact.predecessor_trace.some((reference) => typeof reference !== 'string' || reference.length === 0)
    || (phase !== 'Requirement' && artifact.predecessor_trace.length === 0)) {
    issue(errors, 'ARTIFACT_TRACE_REQUIRED', `${path}.predecessor_trace`, 'Predecessor trace must contain non-empty string references; only Requirement may use an empty array.');
  }
  if (!Array.isArray(artifact.validation_evidence)
    || artifact.validation_evidence.length === 0
    || artifact.validation_evidence.some((reference) => typeof reference !== 'string' || reference.length === 0)) {
    issue(errors, 'ARTIFACT_VALIDATION_REQUIRED', `${path}.validation_evidence`, 'Validation evidence must contain non-empty string references.');
  }
  if (!isObject(artifact.expectations)) {
    issue(errors, 'ARTIFACT_EXPECTATIONS_REQUIRED', `${path}.expectations`, 'Expectations are required.');
  } else {
    for (const name of ['security', 'performance', 'integration', 'uat']) {
      if (typeof artifact.expectations[name] !== 'string' || artifact.expectations[name].length === 0) {
        issue(errors, 'ARTIFACT_EXPECTATION_REQUIRED', `${path}.expectations.${name}`, `${name} expectation is required.`);
      }
    }
  }
  if (phase === 'Requirement') {
    validateNonEmptyStrings(errors, artifact.business_functions, `${path}.business_functions`, 'REQUIREMENT_BUSINESS_FUNCTIONS_REQUIRED');
    if (!Array.isArray(artifact.validation_exceptions)) {
      issue(errors, 'REQUIREMENT_VALIDATION_EXCEPTIONS_REQUIRED', `${path}.validation_exceptions`, 'validation_exceptions must be an array.');
    }
  }
  const referenceField = {
    Prototype: 'clickable_prototype_ref',
    Development: 'working_software_ref',
    QA: 'e2e_uat_report_ref',
  }[phase];
  if (referenceField && (typeof artifact[referenceField] !== 'string' || artifact[referenceField].length === 0)) {
    issue(errors, 'ARTIFACT_PHASE_REFERENCE_REQUIRED', `${path}.${referenceField}`, `${referenceField} is required.`);
  }
}

/**
 * Stable, small public boundary for callers that need phase-exit validation
 * without depending on the delivery-loop aggregate validator.  The private
 * accumulator remains the single source of the artifact rules.
 */
export function validatePhaseExitArtifact(phase, artifact) {
  const errors = [];
  if (!Object.hasOwn(PHASE_EXIT_ARTIFACTS, phase)) {
    issue(errors, 'PHASE_INVALID', 'phase', 'Phase must have a defined phase-exit artifact.');
  } else {
    validateArtifact(errors, artifact, phase, 'artifact');
  }
  return { valid: errors.length === 0, errors };
}

function replayAttempt(errors, attempt, actors, path, assignedAt, analysisAsOf) {
  if (!Array.isArray(attempt.events) || attempt.events.length === 0) {
    issue(errors, 'ATTEMPT_EVENTS_REQUIRED', `${path}.events`, 'Recorded attempt events must be non-empty.');
    return;
  }
  let replay = {
    state: 'draft',
    receiver_phase: attempt.receiver_phase,
    actors,
    events: [],
  };
  let previousAt = null;
  let replayFailed = false;
  attempt.events.forEach((event, eventIndex) => {
    const eventPath = `${path}.events[${eventIndex}]`;
    if (!isObject(event)) {
      issue(errors, 'EVENT_OBJECT_REQUIRED', eventPath, 'Event must be an object.');
      replayFailed = true;
      return;
    }
    const eventAt = rfc3339Millis(event.at);
    if (eventAt === null) issue(errors, 'EVENT_TIME_INVALID', `${eventPath}.at`, 'Event time must be RFC3339.');
    else if (previousAt !== null && eventAt < previousAt) issue(errors, 'EVENT_TIME_ORDER_INVALID', `${eventPath}.at`, 'Event times must be non-decreasing.');
    if (eventAt !== null && assignedAt !== null && eventAt < assignedAt) {
      issue(errors, 'EVENT_BEFORE_ASSIGNMENT', `${eventPath}.at`, 'Handoff events cannot predate slice assignment.');
    }
    if (eventAt !== null && analysisAsOf !== null && eventAt > analysisAsOf) {
      issue(errors, 'EVENT_AFTER_ANALYSIS', `${eventPath}.at`, 'Handoff events cannot postdate analysis_as_of.');
    }
    if (eventAt !== null) previousAt = eventAt;
    if (replayFailed) return;
    try {
      replay = reduceHandoffAttempt(replay, event);
    } catch (cause) {
      if (cause instanceof ContractValidationError) {
        for (const detail of cause.errors) issue(errors, detail.code, `${eventPath}.${detail.path}`, detail.message);
      } else {
        issue(errors, 'ATTEMPT_REPLAY_FAILED', eventPath, 'Attempt replay failed.');
      }
      replayFailed = true;
    }
  });
  if (!replayFailed && replay.state !== attempt.state) {
    issue(errors, 'ATTEMPT_REPLAY_STATE_MISMATCH', `${path}.state`, `Event replay ended in ${replay.state}, not ${attempt.state}.`);
  }
}

function validateAttempts(errors, slice, sliceIndex, actors, globalAttempts, globalIds, analysisAsOf) {
  const path = `slices[${sliceIndex}].handoff_attempts`;
  const attempts = slice.handoff_attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) {
    issue(errors, 'HANDOFF_ATTEMPTS_REQUIRED', path, 'Every slice needs at least one recorded handoff attempt.');
    return;
  }

  attempts.forEach((attempt, attemptIndex) => {
    const attemptPath = `${path}[${attemptIndex}]`;
    if (!isObject(attempt)) {
      issue(errors, 'ATTEMPT_OBJECT_REQUIRED', attemptPath, 'Attempt must be an object.');
      return;
    }
    const recordedEvents = arrayOrEmpty(attempt.events);
    const firstProposalAt = rfc3339Millis(recordedEvents.find((event) => event?.type === 'propose')?.at);
    const terminalAt = rfc3339Millis(recordedEvents.at(-1)?.at);
    const record = {
      attempt, slice, sliceIndex, attemptIndex, order: globalAttempts.length,
      path: attemptPath, firstProposalAt, terminalAt,
    };
    globalAttempts.push(record);
    if (typeof attempt.attempt_id !== 'string' || attempt.attempt_id.length === 0) {
      issue(errors, 'ATTEMPT_ID_REQUIRED', `${attemptPath}.attempt_id`, 'Attempt ID is required.');
    } else if (globalIds.has(attempt.attempt_id)) {
      issue(errors, 'ATTEMPT_ID_DUPLICATE', `${attemptPath}.attempt_id`, 'Attempt IDs are globally unique.');
    } else {
      globalIds.set(attempt.attempt_id, record);
    }
    if (!Object.hasOwn(PHASE_BOUNDARIES, attempt.sender_phase)) {
      issue(errors, 'ATTEMPT_PHASE_INVALID', `${attemptPath}.sender_phase`, 'Sender phase must have a defined receiver boundary.');
    } else if (attempt.receiver_phase !== PHASE_BOUNDARIES[attempt.sender_phase]) {
      issue(errors, 'ATTEMPT_BOUNDARY_INVALID', `${attemptPath}.receiver_phase`, `Expected receiver ${PHASE_BOUNDARIES[attempt.sender_phase]}.`);
    }
    if (slice.strata?.phase !== attempt.sender_phase) {
      issue(errors, 'ATTEMPT_STRATUM_PHASE_MISMATCH', `${attemptPath}.sender_phase`, 'Attempt sender phase must match slice.strata.phase.');
    }
    if (Object.hasOwn(PHASE_EXIT_ARTIFACTS, attempt.sender_phase)) {
      validateArtifact(errors, attempt.exit_artifact, attempt.sender_phase, `${attemptPath}.exit_artifact`);
    }
    if (!HANDOFF_TERMINAL_STATES.includes(attempt.state)) {
      issue(errors, 'ATTEMPT_NOT_TERMINAL', `${attemptPath}.state`, 'Recorded attempts must be terminal.');
    }
    if (!isNonNegative(attempt.sunk_cost_minutes)) {
      issue(errors, 'ATTEMPT_SUNK_COST_INVALID', `${attemptPath}.sunk_cost_minutes`, 'sunk_cost_minutes must be finite and non-negative.');
    }
    if (attempt.state === 'accepted' && attempt.sunk_cost_minutes !== 0) {
      issue(errors, 'ACCEPTED_SUNK_COST_INVALID', `${attemptPath}.sunk_cost_minutes`, 'Accepted attempts have zero terminal sunk-work cost.');
    }
    replayAttempt(
      errors, attempt, actors, attemptPath,
      rfc3339Millis(slice.assigned_at), analysisAsOf,
    );
  });

  for (const [state, category] of Object.entries(SUNK_CATEGORY_BY_STATE)) {
    const terminalAttempts = attempts.filter((attempt) => isObject(attempt) && attempt.state === state && isNonNegative(attempt.sunk_cost_minutes));
    const expected = terminalAttempts.reduce((sum, attempt) => sum + attempt.sunk_cost_minutes, 0);
    const actual = slice.costs?.[category];
    if ((terminalAttempts.length > 0 && !isNonNegative(actual))
      || (isNonNegative(actual) && actual !== expected)) {
      issue(errors, 'SUNK_COST_MISMATCH', `slices[${sliceIndex}].costs.${category}`, `${category} must equal ${state} attempt sunk costs.`);
    }
  }
}

function validateRevisionLineage(errors, globalAttempts, globalIds) {
  for (const record of globalAttempts) {
    const { attempt, sliceIndex, path, firstProposalAt } = record;
    const priorRejectedSameBoundary = globalAttempts.some((candidate) => candidate !== record
      && candidate.sliceIndex === sliceIndex
      && candidate.attempt.state === 'rejected'
      && candidate.attempt.sender_phase === attempt.sender_phase
      && candidate.attempt.receiver_phase === attempt.receiver_phase
      && candidate.terminalAt !== null
      && firstProposalAt !== null
      && candidate.terminalAt < firstProposalAt);
    if (priorRejectedSameBoundary && (typeof attempt.revision_of_attempt_id !== 'string' || attempt.revision_of_attempt_id.length === 0)) {
      issue(errors, 'REVISION_LINEAGE_REQUIRED', `${path}.revision_of_attempt_id`, 'Correction after rejection must retain predecessor lineage.');
    }
    if (attempt.revision_of_attempt_id === undefined) continue;
    const parent = globalIds.get(attempt.revision_of_attempt_id);
    if (!parent
      || parent === record
      || parent.sliceIndex !== sliceIndex
      || parent.attempt.state !== 'rejected'
      || parent.attempt.sender_phase !== attempt.sender_phase
      || parent.attempt.receiver_phase !== attempt.receiver_phase) {
      issue(errors, 'REVISION_REQUIRES_REJECTION', `${path}.revision_of_attempt_id`, 'Revision parent must be a distinct prior rejected attempt for the same slice boundary.');
    } else if (parent.terminalAt === null || firstProposalAt === null || parent.terminalAt >= firstProposalAt) {
      issue(errors, 'REVISION_TIME_INVALID', `${path}.revision_of_attempt_id`, 'Rejected parent must terminate strictly before the revision proposal.');
    }
  }
}

function validateActors(errors, actors) {
  if (!isObject(actors)) {
    issue(errors, 'ACTORS_REQUIRED', 'actors', 'Actor registry is required.');
    return;
  }
  for (const role of ['senders', 'pms', 'certifiers', 'experiment_owners', 'metric_producers']) {
    validateNonEmptyStrings(errors, actors[role], `actors.${role}`, 'ACTOR_ROLE_REQUIRED');
  }
  if (!isObject(actors.phase_leads)) {
    issue(errors, 'PHASE_LEADS_REQUIRED', 'actors.phase_leads', 'Phase-lead registry is required.');
  } else {
    for (const phase of [...Object.keys(PHASE_EXIT_ARTIFACTS), 'ProjectDelivery']) {
      validateNonEmptyStrings(errors, actors.phase_leads[phase], `actors.phase_leads.${phase}`, 'PHASE_LEADS_REQUIRED');
    }
  }
}

function validatePreregistration(errors, preregistration) {
  if (!isObject(preregistration)) {
    issue(errors, 'PREREGISTRATION_REQUIRED', 'preregistration', 'Pre-registration is required.');
    return;
  }
  if (typeof preregistration.manifest_id !== 'string' || preregistration.manifest_id.length === 0) issue(errors, 'MANIFEST_ID_REQUIRED', 'preregistration.manifest_id', 'Manifest ID is required.');
  if (typeof preregistration.hypothesis !== 'string' || preregistration.hypothesis.length === 0) issue(errors, 'HYPOTHESIS_REQUIRED', 'preregistration.hypothesis', 'Hypothesis is required.');
  validateNonEmptyStrings(errors, preregistration.primary_kpis, 'preregistration.primary_kpis', 'PRIMARY_KPIS_REQUIRED');
  if (preregistration.estimand !== 'per_slice_mean_by_arm') issue(errors, 'ESTIMAND_INVALID', 'preregistration.estimand', 'Estimand must be per_slice_mean_by_arm.');
  if (typeof preregistration.assignment_method !== 'string' || preregistration.assignment_method.length === 0) issue(errors, 'ASSIGNMENT_METHOD_REQUIRED', 'preregistration.assignment_method', 'Assignment method is required.');
  validateNonEmptyStrings(errors, preregistration.strata, 'preregistration.strata', 'STRATA_REQUIRED');
  if (Array.isArray(preregistration.strata) && !preregistration.strata.includes('phase')) {
    issue(errors, 'PHASE_STRATUM_REQUIRED', 'preregistration.strata', 'phase must be a pre-registered stratum.');
  }
  const registeredGuardrails = preregistration.guardrails;
  if (!Array.isArray(registeredGuardrails)
    || registeredGuardrails.length !== GUARDRAIL_NAMES.length
    || GUARDRAIL_NAMES.some((name) => !registeredGuardrails.includes(name))) {
    issue(errors, 'GUARDRAIL_REGISTRATION_INVALID', 'preregistration.guardrails', 'All closed guardrails must be pre-registered exactly once.');
  }
  const window = preregistration.assignment_window;
  const start = rfc3339Millis(window?.start);
  const end = rfc3339Millis(window?.end);
  if (!isObject(window) || start === null || end === null || start >= end) {
    issue(errors, 'ASSIGNMENT_WINDOW_INVALID', 'preregistration.assignment_window', 'Assignment window must be a strict RFC3339 half-open [start, end) interval.');
  }
}

function validateCostModel(errors, costModel) {
  if (!isObject(costModel)) {
    issue(errors, 'COST_MODEL_REQUIRED', 'cost_model', 'Cost model is required.');
    return;
  }
  if (!isNonNegative(costModel.loaded_cost_per_minute)) issue(errors, 'LOADED_RATE_INVALID', 'cost_model.loaded_cost_per_minute', 'Loaded rate must be finite and non-negative.');
  if (typeof costModel.currency !== 'string' || costModel.currency.length === 0) issue(errors, 'COST_CURRENCY_REQUIRED', 'cost_model.currency', 'Currency is required.');
  if (costModel.unit !== 'minute') issue(errors, 'COST_UNIT_INVALID', 'cost_model.unit', 'Cost unit must be minute.');
  if (typeof costModel.allocation_basis !== 'string' || costModel.allocation_basis.length === 0) issue(errors, 'COST_ALLOCATION_REQUIRED', 'cost_model.allocation_basis', 'Allocation basis is required.');
}

function validateClaimRoles(errors, input) {
  if (input.evidence?.provenance !== 'observed_certification_claimed' || !isObject(input.evidence.certification_claim)) return;
  const certifier = input.evidence.certification_claim.certifier_id;
  const phaseLeads = isObject(input.actors?.phase_leads)
    ? Object.values(input.actors.phase_leads).flatMap(arrayOrEmpty)
    : [];
  const prohibited = [
    ...arrayOrEmpty(input.actors?.senders),
    ...arrayOrEmpty(input.actors?.pms),
    ...phaseLeads,
    ...arrayOrEmpty(input.actors?.experiment_owners),
    ...arrayOrEmpty(input.actors?.metric_producers),
  ];
  if (typeof certifier !== 'string' || !arrayOrEmpty(input.actors?.certifiers).includes(certifier)) {
    issue(errors, 'CERTIFIER_NOT_DECLARED', 'evidence.certification_claim.certifier_id', 'Claimed certifier must be declared.');
  }
  if (typeof certifier === 'string' && prohibited.includes(certifier)) {
    issue(errors, 'CERTIFIER_ROLE_OVERLAP', 'evidence.certification_claim.certifier_id', 'Certifier cannot overlap operational or measurement roles.');
  }
}

function validateCertificationClaim(errors, input) {
  if (input.evidence?.provenance !== 'observed_certification_claimed' || !isObject(input.evidence.certification_claim)) return;
  const claim = input.evidence.certification_claim;
  for (const field of ['claim_id', 'evidence_ref', 'method', 'certifier_id']) {
    if (typeof claim[field] !== 'string' || claim[field].length === 0) {
      issue(errors, 'CERTIFICATION_CLAIM_FIELD_REQUIRED', `evidence.certification_claim.${field}`, `${field} is required.`);
    }
  }
  const claimedAt = rfc3339Millis(claim.claimed_at);
  const expiresAt = rfc3339Millis(claim.expires_at);
  const analysisAsOf = rfc3339Millis(input.analysis_as_of);
  if (claimedAt === null) issue(errors, 'CERTIFICATION_CLAIM_TIME_INVALID', 'evidence.certification_claim.claimed_at', 'claimed_at must be RFC3339.');
  if (expiresAt === null) issue(errors, 'CERTIFICATION_CLAIM_TIME_INVALID', 'evidence.certification_claim.expires_at', 'expires_at must be RFC3339.');
  if (claimedAt !== null && expiresAt !== null && expiresAt <= claimedAt) issue(errors, 'CERTIFICATION_CLAIM_TIME_INVALID', 'evidence.certification_claim.expires_at', 'Claim expiry must follow claim time.');
  if (claimedAt !== null && analysisAsOf !== null && claimedAt > analysisAsOf) issue(errors, 'CERTIFICATION_CLAIM_TIME_INVALID', 'evidence.certification_claim.claimed_at', 'Claim cannot postdate analysis_as_of.');
  if (expiresAt !== null && analysisAsOf !== null && expiresAt < analysisAsOf) issue(errors, 'CERTIFICATION_CLAIM_EXPIRED', 'evidence.certification_claim.expires_at', 'Claim is expired at analysis_as_of.');
  if (claim.scope !== input.experiment_id) issue(errors, 'CERTIFICATION_SCOPE_MISMATCH', 'evidence.certification_claim.scope', 'Claim scope must equal experiment_id.');
  const manifestDigest = deriveManifestIdentity(input).manifest_digest;
  const datasetDigest = canonicalDigest({ experiment_id: input.experiment_id, analysis_as_of: input.analysis_as_of, slices: input.slices });
  if (!SHA256_PATTERN.test(claim.manifest_digest ?? '') || claim.manifest_digest !== manifestDigest) {
    issue(errors, 'CERTIFICATION_DIGEST_MISMATCH', 'evidence.certification_claim.manifest_digest', 'Claim manifest digest must exactly bind the current registration.');
  }
  if (!SHA256_PATTERN.test(claim.dataset_digest ?? '') || claim.dataset_digest !== datasetDigest) {
    issue(errors, 'CERTIFICATION_DIGEST_MISMATCH', 'evidence.certification_claim.dataset_digest', 'Claim dataset digest must exactly bind the current dataset.');
  }
}

function validateDerivedCosts(errors, input) {
  const slices = input.slices;
  const rate = input.cost_model?.loaded_cost_per_minute;
  if (!Array.isArray(slices) || !isNonNegative(rate)) return;
  const coordinationMeans = {};
  const loadedCostMeans = {};

  for (const arm of ARMS) {
    const armSlices = slices.filter((slice) => isObject(slice) && slice.arm === arm);
    if (armSlices.length === 0) continue;
    const categoryTotals = {};
    let complete = true;
    let overflowCategory = null;
    for (const category of COST_CATEGORIES) {
      let categoryComplete = true;
      let total = 0;
      for (const slice of armSlices) {
        const value = slice.costs?.[category];
        if (!isNonNegative(value)) {
          categoryComplete = false;
          complete = false;
          break;
        }
        total += value;
        if (!Number.isFinite(total)) {
          overflowCategory = category;
          break;
        }
      }
      if (overflowCategory !== null) break;
      categoryTotals[category] = categoryComplete ? total : null;
    }
    if (overflowCategory !== null) {
      issue(errors, 'COST_AGGREGATE_NON_FINITE', 'slices', `Derived ${overflowCategory} aggregation is non-finite for ${arm}.`);
      continue;
    }
    if (!complete) continue;

    const totalCoordinationMinutes = Object.values(categoryTotals)
      .reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(totalCoordinationMinutes)) {
      issue(errors, 'COST_AGGREGATE_NON_FINITE', 'slices', `Derived total coordination minutes are non-finite for ${arm}.`);
      continue;
    }
    const loadedCost = totalCoordinationMinutes * rate;
    if (!Number.isFinite(loadedCost)) {
      issue(errors, 'LOADED_COST_NON_FINITE', 'cost_model.loaded_cost_per_minute', `Derived loaded cost is non-finite for ${arm}.`);
      continue;
    }
    coordinationMeans[arm] = totalCoordinationMinutes / armSlices.length;
    loadedCostMeans[arm] = loadedCost / armSlices.length;
  }

  const coordinationReduction = ((coordinationMeans.pm_routed - coordinationMeans.receiver_owned)
    / coordinationMeans.pm_routed) * 100;
  if (isNonNegative(coordinationMeans.pm_routed)
    && isNonNegative(coordinationMeans.receiver_owned)
    && coordinationMeans.pm_routed > 0
    && !Number.isFinite(coordinationReduction)) {
    issue(errors, 'COST_COMPARISON_NON_FINITE', 'slices', 'Derived coordination-cost reduction is non-finite.');
  }
  const loadedCostReduction = ((loadedCostMeans.pm_routed - loadedCostMeans.receiver_owned)
    / loadedCostMeans.pm_routed) * 100;
  if (isNonNegative(loadedCostMeans.pm_routed)
    && isNonNegative(loadedCostMeans.receiver_owned)
    && loadedCostMeans.pm_routed > 0
    && !Number.isFinite(loadedCostReduction)) {
    issue(errors, 'LOADED_COST_COMPARISON_NON_FINITE', 'cost_model.loaded_cost_per_minute', 'Derived loaded-cost reduction is non-finite.');
  }
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function validateDerivedOutcomes(errors, input) {
  const slices = input.slices;
  const analysisAsOf = rfc3339Millis(input.analysis_as_of);
  const minFollowUpDays = input.maturity?.min_follow_up_days;
  if (!Array.isArray(slices) || analysisAsOf === null || !isNonNegative(minFollowUpDays)) return;

  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, { times: [], values: [] }]));
  for (const slice of slices) {
    if (!isObject(slice) || !ARM_SET.has(slice.arm) || !isObject(slice.outcome)) continue;
    const assignedAt = rfc3339Millis(slice.assigned_at);
    if (assignedAt === null
      || assignedAt + minFollowUpDays * 86_400_000 > analysisAsOf
      || slice.outcome.status !== 'mature') continue;
    if (isNonNegative(slice.outcome.time_to_usable_outcome_minutes)) {
      byArm[slice.arm].times.push(slice.outcome.time_to_usable_outcome_minutes);
    }
    if (isFiniteNumber(slice.outcome.value_proxy)) {
      byArm[slice.arm].values.push(slice.outcome.value_proxy);
    }
  }

  const timeMeans = {};
  const valueMeans = {};
  for (const arm of ARMS) {
    const timeMean = mean(byArm[arm].times);
    if (byArm[arm].times.length > 0 && !Number.isFinite(timeMean)) {
      issue(errors, 'OUTCOME_TIME_MEAN_NON_FINITE', 'slices', `Derived time-to-usable mean is non-finite for ${arm}.`);
    } else {
      timeMeans[arm] = timeMean;
    }
    const valueMean = mean(byArm[arm].values);
    if (byArm[arm].values.length > 0 && !Number.isFinite(valueMean)) {
      issue(errors, 'OUTCOME_VALUE_MEAN_NON_FINITE', 'slices', `Derived value-proxy mean is non-finite for ${arm}.`);
    } else {
      valueMeans[arm] = valueMean;
    }
  }

  const timeMargin = input.thresholds?.time_to_usable_noninferiority_minutes;
  if (isNonNegative(timeMeans.pm_routed)
    && isNonNegative(timeMeans.receiver_owned)
    && isNonNegative(timeMargin)
    && !Number.isFinite(timeMeans.pm_routed + timeMargin)) {
    issue(errors, 'OUTCOME_TIME_COMPARISON_NON_FINITE', 'thresholds.time_to_usable_noninferiority_minutes', 'Derived time-to-usable non-inferiority boundary is non-finite.');
  }
  const valueMargin = input.thresholds?.value_noninferiority_margin;
  if (isFiniteNumber(valueMeans.pm_routed)
    && isFiniteNumber(valueMeans.receiver_owned)
    && isNonNegative(valueMargin)
    && !Number.isFinite(valueMeans.pm_routed - valueMargin)) {
    issue(errors, 'OUTCOME_VALUE_COMPARISON_NON_FINITE', 'thresholds.value_noninferiority_margin', 'Derived value-proxy non-inferiority boundary is non-finite.');
  }
}

export function validateExperiment(input) {
  const errors = [];
  if (!isObject(input)) return { valid: false, errors: [{ code: 'INPUT_OBJECT_REQUIRED', path: '', message: 'Input must be an object.' }] };
  if (input.schema_version !== 'delivery-loop-poc/v1') issue(errors, 'SCHEMA_VERSION_INVALID', 'schema_version', 'Expected delivery-loop-poc/v1.');
  if (typeof input.experiment_id !== 'string' || input.experiment_id.length === 0) issue(errors, 'EXPERIMENT_ID_REQUIRED', 'experiment_id', 'Experiment ID is required.');
  const analysisAsOf = rfc3339Millis(input.analysis_as_of);
  if (analysisAsOf === null) issue(errors, 'ANALYSIS_AS_OF_INVALID', 'analysis_as_of', 'analysis_as_of must be strict RFC3339.');
  validatePreregistration(errors, input.preregistration);
  if (!isObject(input.maturity) || !isNonNegative(input.maturity.min_follow_up_days)) issue(errors, 'MATURITY_RULE_INVALID', 'maturity.min_follow_up_days', 'Follow-up days must be finite and non-negative.');
  const thresholdNames = [
    'min_mature_per_arm', 'coordination_reduction_percent',
    'incremental_cost_reduction_percent', 'time_to_usable_noninferiority_minutes',
    'value_noninferiority_margin',
  ];
  if (!isObject(input.thresholds)) issue(errors, 'THRESHOLDS_REQUIRED', 'thresholds', 'Thresholds are required.');
  else for (const name of thresholdNames) if (!isNonNegative(input.thresholds[name])) issue(errors, 'THRESHOLD_INVALID', `thresholds.${name}`, 'Threshold must be finite and non-negative.');
  validateActors(errors, input.actors);
  validateCostModel(errors, input.cost_model);
  if (!isObject(input.evidence) || !PROVENANCE.has(input.evidence.provenance)) issue(errors, 'PROVENANCE_INVALID', 'evidence.provenance', 'Evidence provenance is closed.');
  if (input.evidence?.provenance === 'observed_certification_claimed' && !isObject(input.evidence.certification_claim)) issue(errors, 'CERTIFICATION_CLAIM_REQUIRED', 'evidence.certification_claim', 'Certification claim must be structured.');
  validateClaimRoles(errors, input);

  const slices = input.slices;
  const registeredStrata = arrayOrEmpty(input.preregistration?.strata);
  const globalAttempts = [];
  const globalAttemptIds = new Map();
  if (!Array.isArray(slices) || slices.length === 0) {
    issue(errors, 'SLICES_REQUIRED', 'slices', 'At least one assigned slice is required.');
  } else {
    const sliceIds = new Set();
    const presentArms = new Set();
    slices.forEach((slice, sliceIndex) => {
      const path = `slices[${sliceIndex}]`;
      if (!isObject(slice)) {
        issue(errors, 'SLICE_OBJECT_REQUIRED', path, 'Slice must be an object.');
        return;
      }
      if (typeof slice.slice_id !== 'string' || slice.slice_id.length === 0) issue(errors, 'SLICE_ID_REQUIRED', `${path}.slice_id`, 'Slice ID is required.');
      else if (sliceIds.has(slice.slice_id)) issue(errors, 'SLICE_ID_DUPLICATE', `${path}.slice_id`, 'Slice IDs are globally unique.');
      else sliceIds.add(slice.slice_id);
      if (!ARM_SET.has(slice.arm)) issue(errors, 'ARM_INVALID', `${path}.arm`, 'Arm must be pm_routed or receiver_owned.');
      else presentArms.add(slice.arm);
      if (!isObject(slice.strata)) {
        issue(errors, 'SLICE_STRATA_REQUIRED', `${path}.strata`, 'Slice strata are required.');
      } else {
        for (const key of registeredStrata) {
          if (!Object.hasOwn(slice.strata, key) || slice.strata[key] === null || slice.strata[key] === '') {
            issue(errors, 'SLICE_STRATUM_REQUIRED', `${path}.strata.${key}`, 'Every pre-registered stratum key needs an explicit value.');
          }
        }
      }
      if (typeof slice.contamination !== 'boolean') issue(errors, 'CONTAMINATION_REQUIRED', `${path}.contamination`, 'Contamination must be explicitly true or false.');
      const assignedAt = rfc3339Millis(slice.assigned_at);
      const windowStart = rfc3339Millis(input.preregistration?.assignment_window?.start);
      const windowEnd = rfc3339Millis(input.preregistration?.assignment_window?.end);
      if (assignedAt === null || windowStart === null || windowEnd === null || assignedAt < windowStart || assignedAt >= windowEnd) {
        issue(errors, 'ASSIGNMENT_OUTSIDE_WINDOW', `${path}.assigned_at`, 'Assignment must be RFC3339 and inside [start, end).');
      }
      if (!isObject(slice.outcome) || !OUTCOME_STATES.has(slice.outcome.status)) issue(errors, 'OUTCOME_INVALID', `${path}.outcome`, 'Outcome status is required and closed.');
      if (!isObject(slice.costs)) {
        issue(errors, 'COSTS_REQUIRED', `${path}.costs`, 'Explicit cost categories are required.');
      } else {
        for (const category of COST_CATEGORIES) {
          if (!Object.hasOwn(slice.costs, category)) issue(errors, 'COST_VALUE_INVALID', `${path}.costs.${category}`, 'Cost key is required; use null for unknown.');
          else if (slice.costs[category] !== null && !isNonNegative(slice.costs[category])) issue(errors, 'COST_VALUE_INVALID', `${path}.costs.${category}`, 'Cost must be null or a finite non-negative number.');
        }
      }
      if (!isObject(slice.guardrails)) {
        issue(errors, 'GUARDRAILS_REQUIRED', `${path}.guardrails`, 'Every slice must report all guardrails.');
      } else {
        for (const name of GUARDRAIL_NAMES) {
          if (!GUARDRAIL_VALUES.has(slice.guardrails[name])) issue(errors, 'GUARDRAIL_VALUE_INVALID', `${path}.guardrails.${name}`, 'Guardrail must be PASS, BREACH, or UNKNOWN.');
        }
      }
      validateAttempts(
        errors, slice, sliceIndex, input.actors,
        globalAttempts, globalAttemptIds, analysisAsOf,
      );
    });
    if (presentArms.size !== ARMS.length) issue(errors, 'INDEPENDENT_ARMS_REQUIRED', 'slices', 'Both independent arms need assigned slices.');
    validateRevisionLineage(errors, globalAttempts, globalAttemptIds);
  }
  validateDerivedCosts(errors, input);
  validateDerivedOutcomes(errors, input);
  validateCertificationClaim(errors, input);
  return { valid: errors.length === 0, errors };
}

function aggregateArm(slices, rate, analysisAsOf, minFollowUpDays) {
  const categoryTotals = Object.fromEntries(COST_CATEGORIES.map((category) => [category, 0]));
  const result = {
    assigned: slices.length,
    mature: 0,
    non_mature: 0,
    outcome_complete: true,
    cost_complete: true,
    category_totals: categoryTotals,
    total_coordination_minutes: 0,
    total_coordination_minutes_per_slice_mean: null,
    incremental_loaded_cost: 0,
    incremental_loaded_cost_per_slice_mean: null,
    outcome_minutes: [],
    values: [],
  };
  for (const slice of slices) {
    const timeMature = rfc3339Millis(slice.assigned_at) + minFollowUpDays * 86_400_000 <= analysisAsOf;
    const mature = timeMature && slice.outcome.status === 'mature';
    if (mature) result.mature += 1;
    else result.non_mature += 1;
    if (mature) {
      if (isNonNegative(slice.outcome.time_to_usable_outcome_minutes)) result.outcome_minutes.push(slice.outcome.time_to_usable_outcome_minutes);
      else result.outcome_complete = false;
      if (isFiniteNumber(slice.outcome.value_proxy)) result.values.push(slice.outcome.value_proxy);
      else result.outcome_complete = false;
    }
    for (const category of COST_CATEGORIES) {
      const value = slice.costs[category];
      if (value === null) {
        result.cost_complete = false;
        categoryTotals[category] = null;
      } else if (categoryTotals[category] !== null) {
        categoryTotals[category] += value;
      }
    }
  }
  if (result.cost_complete) {
    result.total_coordination_minutes = Object.values(categoryTotals).reduce((sum, value) => sum + value, 0);
    result.total_coordination_minutes_per_slice_mean = result.total_coordination_minutes / result.assigned;
    result.incremental_loaded_cost = result.total_coordination_minutes * rate;
    result.incremental_loaded_cost_per_slice_mean = result.incremental_loaded_cost / result.assigned;
  } else {
    result.total_coordination_minutes = null;
    result.incremental_loaded_cost = null;
  }
  return result;
}

const percentReduction = (control, treatment) => isNonNegative(control) && isNonNegative(treatment) && control > 0
  ? ((control - treatment) / control) * 100
  : null;

function topEntry(entries) {
  return [...entries].sort(([leftName, leftMinutes], [rightName, rightMinutes]) => rightMinutes - leftMinutes || codePointCompare(leftName, rightName))[0];
}

function describeBottleneck(slices) {
  if (slices.some((slice) => COST_CATEGORIES.some((category) => slice.costs[category] === null))) {
    return {
      basis: 'descriptive_only',
      status: 'INCONCLUSIVE',
      reason: 'unknown_cost_category',
      highest_coordination_phase: null,
      largest_cost_category: null,
    };
  }
  const phases = new Map();
  const categories = new Map(COST_CATEGORIES.map((category) => [category, 0]));
  for (const slice of slices) {
    let sliceTotal = 0;
    for (const category of COST_CATEGORIES) {
      sliceTotal += slice.costs[category];
      categories.set(category, categories.get(category) + slice.costs[category]);
    }
    const phase = String(slice.strata.phase);
    phases.set(phase, (phases.get(phase) ?? 0) + sliceTotal);
  }
  const [phase, phaseMinutes] = topEntry(phases.entries());
  const [category, categoryMinutes] = topEntry(categories.entries());
  return {
    basis: 'descriptive_only',
    status: 'AVAILABLE',
    highest_coordination_phase: { phase, total_coordination_minutes: phaseMinutes },
    largest_cost_category: { category, minutes: categoryMinutes },
  };
}

function aggregateGuardrails(slices) {
  const breaches = [];
  const unknowns = [];
  for (const slice of slices) {
    for (const name of GUARDRAIL_NAMES) {
      if (slice.guardrails[name] === 'BREACH') breaches.push({ slice_id: slice.slice_id, name });
      else if (slice.guardrails[name] === 'UNKNOWN') unknowns.push({ slice_id: slice.slice_id, name });
    }
  }
  return {
    status: breaches.length ? 'BREACH' : unknowns.length ? 'UNKNOWN' : 'CLEAR',
    breaches,
    unknowns,
  };
}

function certificationClaimMatches(claim, input, manifestDigest, datasetDigest) {
  if (!isObject(claim)) return false;
  const claimedAt = rfc3339Millis(claim.claimed_at);
  const expiresAt = rfc3339Millis(claim.expires_at);
  const analysisAsOf = rfc3339Millis(input.analysis_as_of);
  return typeof claim.claim_id === 'string' && claim.claim_id.length > 0
    && claimedAt !== null
    && expiresAt !== null
    && claimedAt <= analysisAsOf
    && expiresAt > claimedAt
    && analysisAsOf <= expiresAt
    && claim.scope === input.experiment_id
    && typeof claim.evidence_ref === 'string' && claim.evidence_ref.length > 0
    && typeof claim.method === 'string' && claim.method.length > 0
    && typeof claim.certifier_id === 'string' && claim.certifier_id.length > 0
    && claim.manifest_digest === manifestDigest
    && claim.dataset_digest === datasetDigest;
}

export function analyzeExperiment(input) {
  const validation = validateExperiment(input);
  if (!validation.valid) throw new ContractValidationError(validation.errors);

  const analysisAsOf = rfc3339Millis(input.analysis_as_of);
  const slicesByArm = Object.fromEntries(ARMS.map((arm) => [arm, input.slices.filter((slice) => slice.arm === arm)]));
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, aggregateArm(
    slicesByArm[arm], input.cost_model.loaded_cost_per_minute,
    analysisAsOf, input.maturity.min_follow_up_days,
  )]));
  const control = byArm.pm_routed;
  const treatment = byArm.receiver_owned;
  const guardrails = aggregateGuardrails(input.slices);
  const contaminated = input.slices.some((slice) => slice.contamination);
  const enoughMature = control.mature >= input.thresholds.min_mature_per_arm
    && treatment.mature >= input.thresholds.min_mature_per_arm;
  const anyNonMature = control.non_mature > 0 || treatment.non_mature > 0;
  const allCostComplete = control.cost_complete && treatment.cost_complete;
  const allOutcomeComplete = control.outcome_complete && treatment.outcome_complete;
  const measurement_readiness = enoughMature
    && !anyNonMature
    && !contaminated
    && allCostComplete
    && allOutcomeComplete
    && guardrails.unknowns.length === 0
    ? 'READY'
    : 'INCONCLUSIVE';

  const coordinationReduction = percentReduction(
    control.total_coordination_minutes_per_slice_mean,
    treatment.total_coordination_minutes_per_slice_mean,
  );
  const loadedCostReduction = percentReduction(
    control.incremental_loaded_cost_per_slice_mean,
    treatment.incremental_loaded_cost_per_slice_mean,
  );
  const controlTime = mean(control.outcome_minutes);
  const treatmentTime = mean(treatment.outcome_minutes);
  const controlValue = mean(control.values);
  const treatmentValue = mean(treatment.values);
  const comparableOutcomes = controlTime !== null && treatmentTime !== null
    && controlValue !== null && treatmentValue !== null;
  const favorable = coordinationReduction !== null
    && loadedCostReduction !== null
    && comparableOutcomes
    && coordinationReduction >= input.thresholds.coordination_reduction_percent
    && loadedCostReduction >= input.thresholds.incremental_cost_reduction_percent
    && treatmentTime <= controlTime + input.thresholds.time_to_usable_noninferiority_minutes
    && treatmentValue >= controlValue - input.thresholds.value_noninferiority_margin;
  const scenario_signal = measurement_readiness !== 'READY'
    ? 'INCONCLUSIVE'
    : favorable ? 'FAVORABLE' : 'UNFAVORABLE';

  const manifest = deriveManifestIdentity(input);
  const dataset_digest = canonicalDigest({
    experiment_id: input.experiment_id,
    analysis_as_of: input.analysis_as_of,
    slices: input.slices,
  });
  const evidence_eligibility = input.evidence.provenance === 'observed_certification_claimed'
    ? certificationClaimMatches(input.evidence.certification_claim, input, manifest.manifest_digest, dataset_digest)
      ? 'ELIGIBLE_FOR_EXTERNAL_REVIEW'
      : 'CLAIM_MALFORMED'
    : input.evidence.provenance === 'synthetic'
      ? 'SYNTHETIC_ONLY'
      : 'OBSERVED_UNVERIFIED';

  return {
    contract_version: 'delivery-loop-poc/v1',
    manifest,
    dataset_digest,
    analysis_as_of: input.analysis_as_of,
    measurement_readiness,
    scenario_signal,
    guardrail_status: guardrails.status,
    guardrail_breaches: guardrails.breaches,
    guardrail_unknowns: guardrails.unknowns,
    evidence_eligibility,
    trust_level: 'advisory_same_uid',
    safety_hold_recommended: guardrails.status === 'BREACH',
    business_decision: 'EXTERNAL_REQUIRED',
    decision_packet: {
      decision: 'EXTERNAL_REQUIRED',
      reason: 'Stage 0 analyzer is advisory and cannot issue a business verdict.',
    },
    intention_to_treat: {
      assigned_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].assigned])),
      mature_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].mature])),
      non_mature_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].non_mature])),
      contamination_detected: contaminated,
    },
    metrics: {
      estimand: 'per_slice_mean_by_arm',
      total_coordination_minutes_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].total_coordination_minutes])),
      total_coordination_minutes_per_slice_mean_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].total_coordination_minutes_per_slice_mean])),
      incremental_loaded_cost_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].incremental_loaded_cost])),
      incremental_loaded_cost_per_slice_mean_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].incremental_loaded_cost_per_slice_mean])),
      pm_routing_minutes_by_arm: Object.fromEntries(ARMS.map((arm) => [arm, byArm[arm].category_totals.pm_routing_minutes])),
      total_coordination_reduction_percent: coordinationReduction,
      incremental_loaded_cost_reduction_percent: loadedCostReduction,
      time_to_usable_outcome_mean_by_arm: { pm_routed: controlTime, receiver_owned: treatmentTime },
      mature_value_mean_by_arm: { pm_routed: controlValue, receiver_owned: treatmentValue },
      cost_complete: allCostComplete,
      outcome_complete: allOutcomeComplete,
    },
    bottlenecks: {
      basis: 'descriptive_only',
      by_arm: Object.fromEntries(ARMS.map((arm) => [arm, describeBottleneck(slicesByArm[arm])])),
    },
  };
}
