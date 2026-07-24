import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COST_CATEGORIES,
  GUARDRAIL_NAMES,
  canonicalDigest,
  canonicalJson,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-core.mjs'
import {
  ASSIGNMENT_ALGORITHM,
  EVENT_SCHEMA_VERSION,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot-core.mjs'
import {
  appendEventAtomic,
  readBoundedFile,
  readStore,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-store.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_MANIFEST = join(ROOT, 'plugins', 'tmux-teams', '.claude-plugin', 'plugin.json')
const SKILL = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams')
const SCRIPTS = join(SKILL, 'scripts')
const REFERENCES = join(SKILL, 'references')
const PILOT = join(SCRIPTS, 'delivery-loop-pilot.mjs')
const CAPTURE = join(SCRIPTS, 'delivery-loop-capture.mjs')
const EXPORT = join(SCRIPTS, 'delivery-loop-export.mjs')
const STORE = join(SCRIPTS, 'delivery-loop-store.mjs')
const MANIFEST_SCHEMA = join(REFERENCES, 'delivery-loop-pilot-manifest-v1.schema.json')
const EVENT_SCHEMA = join(REFERENCES, 'delivery-loop-event-v1.schema.json')
const PACK_SCHEMA = join(REFERENCES, 'delivery-loop-evidence-pack-v1.schema.json')
const PULSE_SCHEMA = join(REFERENCES, 'pulse-v3.schema.json')

const SEED = 'stage1-side-effect-boundary-secret-2026'
const FROZEN_AT = '2026-07-01T00:00:00.000Z'
const ASSIGNED_AT = '2026-07-03T00:00:00.000Z'
const ANALYSIS_AS_OF = '2026-07-23T00:00:00.000Z'
const SOURCE_REVISION = 'a'.repeat(40)
const ACTORS = {
  assignment: 'experiment-owner',
  sender: 'sender-a',
  receiver: 'qa-lead',
  pm: 'pm-a',
  metric: 'metric-producer',
  guardrail: 'guardrail-producer',
}
const HAS_PYTHON_JSONSCHEMA = spawnSync('python3', ['-c', 'import jsonschema'], {
  encoding: 'utf8',
}).status === 0

const clone = (value) => structuredClone(value)

function richDraft() {
  const costInstrumentation = Object.fromEntries(COST_CATEGORIES.map((category, index) => [
    category,
    {
      method_id: `cost-method-${index + 1}`,
      method: `Directly observe ${category} for the assigned slice.`,
      owner_actor_id: ACTORS.metric,
      source_kind: 'manual_observation',
      unit: 'minute',
      unknown_value_policy: 'record_explicit_null',
    },
  ]))
  const guardrailInstrumentation = Object.fromEntries(GUARDRAIL_NAMES.map((guardrail, index) => [
    guardrail,
    {
      method_id: `guardrail-method-${index + 1}`,
      method: `Review named ${guardrail} evidence for the assigned slice.`,
      owner_actor_id: ACTORS.guardrail,
      evidence_requirement: 'named_reference_and_sha256_digest',
    },
  ]))
  return {
    schema_version: 1,
    manifest_id: 'stage1-cli-manifest',
    experiment_id: 'stage1-cli-pilot',
    automatic_routing: false,
    boundary: {
      sender_phase: 'Development',
      receiver_phase: 'QA',
      artifact_type: 'development_delivery',
    },
    hypothesis: 'Receiver-owned handoffs reduce coordination cost without harming mature outcomes.',
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
    sample_plan: {
      min_assigned_per_arm: 1,
      min_mature_per_arm: 1,
      target_assigned_total: 2,
      power_method: 'feasibility_bound',
      power_reference: 'fixture://stage1/power-plan',
      rationale: 'Two slices provide a deterministic both-arm Stage 1 rehearsal.',
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
      experiment_owners: [ACTORS.assignment],
      metric_producers: [ACTORS.metric],
      business_owners: ['business-owner'],
    },
    roles: {
      business_owner_ids: ['business-owner'],
      pm_ids: [ACTORS.pm],
      sender_ids: [ACTORS.sender],
      receiver_phase_lead_ids: [ACTORS.receiver],
      experiment_owner_ids: [ACTORS.assignment],
      assignment_custodian_ids: [ACTORS.assignment],
      metric_producer_ids: [ACTORS.metric],
      guardrail_producer_ids: [ACTORS.guardrail],
      external_reviewer_ids: ['external-reviewer'],
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
      anchor_digest: canonicalDigest({ anchor: 'stage1-cli-manifest' }),
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function fixture(t, prefix = 'delivery-loop-stage1-cli-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeHome = join(root, 'runtime-home')
  for (const path of [
    '.tmux-teams/mailbox/dispatch',
    '.tmux-teams/mailbox/outbox',
    '.tmux-teams/events',
    '.tmux-teams/kms',
  ]) mkdirSync(join(runtimeHome, path), { recursive: true })
  for (const [path, text] of [
    ['.tmux-teams/mailbox/dispatch/sentinel', 'dispatch-sentinel\n'],
    ['.tmux-teams/mailbox/outbox/sentinel', 'outbox-sentinel\n'],
    ['.tmux-teams/events/sentinel', 'event-sentinel\n'],
    ['.tmux-teams/kms/sentinel', 'kms-sentinel\n'],
    ['.tmux-teams/pulse.json', '{"sentinel":true}\n'],
  ]) writeFileSync(join(runtimeHome, path), text)
  const draftPath = join(root, 'draft.json')
  const seedPath = join(root, 'assignment.seed')
  const storeDir = join(root, 'external-observation-store')
  writeJson(draftPath, richDraft())
  writeFileSync(seedPath, `${SEED}\n`, { mode: 0o600 })
  return {
    root,
    runtimeHome,
    draftPath,
    seedPath,
    storeDir,
    env: { ...process.env, HOME: runtimeHome },
  }
}

function run(script, args, context = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: context.runtimeHome ?? ROOT,
    env: context.env ?? process.env,
    encoding: 'utf8',
    timeout: 20_000,
  })
}

function oneJsonLine(text, label) {
  const lines = text.trim().split(/\r?\n/)
  assert.equal(lines.length, 1, `${label} must emit exactly one JSON line: ${text}`)
  return JSON.parse(lines[0])
}

function runJson(script, args, context, label = args[0]) {
  const result = run(script, args, context)
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`)
  assert.equal(result.stderr, '', `${label} wrote stderr on success`)
  return { result, value: oneJsonLine(result.stdout, label) }
}

function errorJson(result, expectedStatus, label) {
  assert.equal(result.status, expectedStatus, `${label}: ${result.stderr || result.stdout}`)
  assert.equal(result.stdout, '', `${label} wrote stdout on failure`)
  return oneJsonLine(result.stderr, label)
}

function snapshotTree(root) {
  const rows = []
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      const path = prefix ? `${prefix}/${name}` : name
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        rows.push({ path: `${path}/`, mode: stat.mode & 0o777 })
        visit(absolute, path)
      } else {
        rows.push({
          path,
          mode: stat.mode & 0o777,
          digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        })
      }
    }
  }
  visit(root)
  return rows
}

function independentArm(manifest, candidate) {
  const message = [
    ASSIGNMENT_ALGORITHM,
    manifest.manifest_digest,
    canonicalJson(candidate.strata),
    candidate.slice_id,
  ].join('\0')
  const digest = createHmac('sha256', SEED).update(message).digest('hex')
  return BigInt(`0x${digest}`) % 2n === 0n ? 'pm_routed' : 'receiver_owned'
}

function candidatesForBothArms(manifest) {
  const selected = new Map()
  for (let index = 1; index <= 256 && selected.size < 2; index++) {
    const candidate = {
      slice_id: `cli-slice-${String(index).padStart(3, '0')}`,
      strata: {
        phase: 'Development',
        complexity: index % 2 ? 'M' : 'S',
      },
      eligible: true,
    }
    const arm = independentArm(manifest, candidate)
    if (!selected.has(arm)) selected.set(arm, candidate)
  }
  assert.deepEqual([...selected.keys()].sort(), ['pm_routed', 'receiver_owned'])
  return selected
}

function eventBoundary(manifest) {
  return {
    sender_phase: manifest.boundary.sender_phase,
    receiver_phase: manifest.boundary.receiver_phase,
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
}) {
  const prior = ledger
    .filter((event) => event.aggregate?.type === aggregateType && event.aggregate?.id === aggregateId)
    .sort((left, right) => left.aggregate.sequence - right.aggregate.sequence)
    .at(-1)
  const sourceRef = `fixture://stage1-cli/${aggregateId}/${eventType}`
  const unsigned = {
    schema: 'tmux-teams.delivery-loop-event',
    schema_version: EVENT_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    aggregate: {
      type: aggregateType,
      id: aggregateId,
      sequence: prior ? prior.aggregate.sequence + 1 : 1,
      previous_event_id: prior?.event_id ?? null,
    },
    event_type: eventType,
    occurred_at: occurredAt,
    claimed_actor: { actor_id: actorId, role: actorRole },
    source: {
      kind: 'manual_observation',
      source_ref: sourceRef,
      source_digest: canonicalDigest({ source_ref: sourceRef, payload }),
      trust_level: 'advisory_same_uid',
    },
    payload,
  }
  return { ...unsigned, event_id: canonicalDigest(unsigned) }
}

function appendObservation(storeDir, manifest, options) {
  const { events } = readStore(storeDir)
  const event = makeEnvelope(manifest, events, options)
  const result = appendEventAtomic(storeDir, event)
  assert.equal(result.appended, true, `${options.eventType} must append`)
  return event
}

function transitionPayload(manifest, {
  sliceId,
  attemptId,
  action,
  artifactEventId,
  transitionAt,
}) {
  const states = {
    propose: ['draft', 'proposed'],
    accept: ['proposed', 'accepted'],
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
    revision_of_attempt_id: null,
    transition_at: transitionAt,
  }
}

function appendCompleteSlice(storeDir, manifest, assignment, { unknownCost } = {}) {
  const sliceId = assignment.payload.slice_id
  const arm = assignment.payload.arm
  const attemptId = `${sliceId}-attempt`
  const artifactAt = '2026-07-04T00:00:00.000Z'
  const artifact = appendObservation(storeDir, manifest, {
    aggregateType: 'attempt',
    aggregateId: attemptId,
    eventType: 'artifact_observed',
    occurredAt: artifactAt,
    actorId: ACTORS.sender,
    actorRole: 'sender',
    payload: {
      slice_id: sliceId,
      attempt_id: attemptId,
      artifact_id: `artifact-${sliceId}`,
      artifact_type: manifest.boundary.artifact_type,
      artifact_version: '1',
      artifact_digest: canonicalDigest({ artifact: sliceId }),
      boundary: eventBoundary(manifest),
      predecessor_trace: [canonicalDigest({ predecessor: sliceId })],
      validation_evidence_digests: [canonicalDigest({ validation: sliceId })],
      observed_at: artifactAt,
    },
  })
  for (const [action, occurredAt, actorId, actorRole] of [
    ['propose', '2026-07-05T00:00:00.000Z', ACTORS.sender, 'sender'],
    ['accept', '2026-07-06T00:00:00.000Z', ACTORS.receiver, 'receiver_phase_lead'],
  ]) {
    appendObservation(storeDir, manifest, {
      aggregateType: 'attempt',
      aggregateId: attemptId,
      eventType: 'attempt_transition_observed',
      occurredAt,
      actorId,
      actorRole,
      payload: transitionPayload(manifest, {
        sliceId,
        attemptId,
        action,
        artifactEventId: artifact.event_id,
        transitionAt: occurredAt,
      }),
    })
  }

  let recapture
  for (const [index, category] of COST_CATEGORIES.entries()) {
    const occurredAt = '2026-07-07T00:00:00.000Z'
    const method = manifest.cost_instrumentation[category]
    const unknown = category === unknownCost
    const event = appendObservation(storeDir, manifest, {
      aggregateType: 'observation',
      aggregateId: `${sliceId}-cost-${index}`,
      eventType: 'cost_observed',
      occurredAt,
      actorId: ACTORS.metric,
      actorRole: 'metric_producer',
      payload: {
        slice_id: sliceId,
        category,
        measurement_status: unknown ? 'unknown' : 'measured',
        minutes: unknown
          ? null
          : category.includes('work_minutes')
            ? 0
            : (arm === 'pm_routed' ? 12 : 4) + index,
        method_id: method.method_id,
        owner_actor_id: method.owner_actor_id,
        measured_at: occurredAt,
      },
    })
    recapture ??= event
  }

  const outcomeAt = '2026-07-15T00:00:00.000Z'
  const outcomeMethod = manifest.outcome_instrumentation.time_to_usable_outcome_minutes
  appendObservation(storeDir, manifest, {
    aggregateType: 'observation',
    aggregateId: `${sliceId}-outcome`,
    eventType: 'outcome_observed',
    occurredAt: outcomeAt,
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      slice_id: sliceId,
      status: 'mature',
      time_to_usable_outcome_minutes: arm === 'pm_routed' ? 100 : 95,
      value_proxy: arm === 'pm_routed' ? 50 : 51,
      method_id: outcomeMethod.method_id,
      owner_actor_id: outcomeMethod.owner_actor_id,
      measured_at: outcomeAt,
    },
  })

  for (const [index, guardrail] of GUARDRAIL_NAMES.entries()) {
    const occurredAt = '2026-07-16T00:00:00.000Z'
    const method = manifest.guardrail_instrumentation[guardrail]
    appendObservation(storeDir, manifest, {
      aggregateType: 'observation',
      aggregateId: `${sliceId}-guard-${index}`,
      eventType: 'guardrail_observed',
      occurredAt,
      actorId: ACTORS.guardrail,
      actorRole: 'guardrail_producer',
      payload: {
        slice_id: sliceId,
        guardrail,
        status: 'PASS',
        evidence_ref: `fixture://stage1-cli/${sliceId}/${guardrail}`,
        evidence_digest: canonicalDigest({ slice_id: sliceId, guardrail, status: 'PASS' }),
        method_id: method.method_id,
        owner_actor_id: method.owner_actor_id,
        measured_at: occurredAt,
      },
    })
  }

  const contaminationAt = '2026-07-16T00:00:01.000Z'
  appendObservation(storeDir, manifest, {
    aggregateType: 'observation',
    aggregateId: `${sliceId}-contamination`,
    eventType: 'contamination_observed',
    occurredAt: contaminationAt,
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: {
      slice_id: sliceId,
      contaminated: false,
      reason_code: 'NO_CONTAMINATION_OBSERVED',
      method_id: manifest.contamination.detection_method_id,
      owner_actor_id: manifest.contamination.owner_actor_id,
      observed_at: contaminationAt,
    },
  })
  return recapture
}

function validateWithJsonSchema(schemaPath, instancePaths, definition = null) {
  const program = [
    'import json, jsonschema, sys',
    'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
    'definition = sys.argv[2]',
    'schema = {"$schema": schema.get("$schema"), "$defs": schema["$defs"], "$ref": f"#/$defs/{definition}"} if definition != "-" else schema',
    'jsonschema.Draft202012Validator.check_schema(schema)',
    'validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())',
    '[validator.validate(json.load(open(path, encoding="utf-8"))) for path in sys.argv[3:]]',
  ].join('; ')
  return spawnSync('python3', ['-c', program, schemaPath, definition ?? '-', ...instancePaths], {
    encoding: 'utf8',
    timeout: 20_000,
  })
}

test('Stage 1 CLIs keep stdout machine-readable and usage errors distinct from runtime failures', () => {
  for (const [script, name] of [
    [PILOT, 'pilot'],
    [CAPTURE, 'capture'],
    [EXPORT, 'export'],
  ]) {
    for (const helpFlag of ['--help', '-h']) {
      const help = run(script, [helpFlag])
      assert.equal(help.status, 0, `${name} ${helpFlag}: ${help.stderr}`)
      assert.match(help.stdout, /^usage:/, `${name} ${helpFlag} must print usage`)
      assert.equal(help.stderr, '', `${name} ${helpFlag} must not write stderr`)
    }
    const result = run(script, [])
    assert.equal(result.status, 2, `${name}: ${result.stderr}`)
    assert.equal(result.stdout, '', `${name} usage must not write stdout`)
    assert.match(result.stderr, /^usage:/, `${name} usage must be human-readable`)
  }
})

test('Stage 1 store and CLIs reject relative, symlinked, oversized, and nested output paths', (t) => {
  const context = fixture(t, 'delivery-loop-stage1-safety-')
  const relativeStore = run(PILOT, [
    'freeze', context.draftPath,
    '--store', 'relative-store',
    '--seed-file', context.seedPath,
    '--frozen-at', FROZEN_AT,
  ], context)
  assert.equal(errorJson(relativeStore, 1, 'relative store').error, 'ABSOLUTE_PATH_REQUIRED')

  const linkedDraft = join(context.root, 'linked-draft.json')
  symlinkSync(context.draftPath, linkedDraft)
  assert.throws(
    () => readBoundedFile(linkedDraft),
    (error) => error?.code === 'REGULAR_FILE_REQUIRED',
  )
  const linkedFreeze = run(PILOT, [
    'freeze', linkedDraft,
    '--store', join(context.root, 'linked-store'),
    '--seed-file', context.seedPath,
    '--frozen-at', FROZEN_AT,
  ], context)
  assert.equal(errorJson(linkedFreeze, 1, 'symlinked draft').error, 'REGULAR_FILE_REQUIRED')

  const frozen = runJson(PILOT, [
    'freeze', context.draftPath,
    '--store', context.storeDir,
    '--seed-file', context.seedPath,
    '--frozen-at', FROZEN_AT,
  ], context, 'freeze for safety')
  assert.equal(frozen.value.created, true)

  const oversized = join(context.root, 'oversized-source')
  writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61))
  const oversizedCapture = run(CAPTURE, [
    'capture', 'mailbox-dispatch', oversized,
    '--store', context.storeDir,
    '--slice', 'cli-slice-oversized',
    '--actor', ACTORS.pm,
    '--at', ASSIGNED_AT,
  ], context)
  assert.equal(errorJson(oversizedCapture, 1, 'oversized capture').error, 'SOURCE_TOO_LARGE')

  const nestedOutput = run(EXPORT, [
    'export',
    '--store', context.storeDir,
    '--out', join(context.storeDir, 'pack'),
    '--as-of', ANALYSIS_AS_OF,
    '--source-revision', SOURCE_REVISION,
  ], context)
  assert.equal(errorJson(nestedOutput, 1, 'nested output').error, 'OUTPUT_INSIDE_STORE')

  const relativePack = run(EXPORT, ['verify-pack', 'relative-pack'], context)
  assert.equal(errorJson(relativePack, 1, 'relative pack').error, 'ABSOLUTE_PATH_REQUIRED')
})

test('external-store E2E preserves source semantics, replays deterministically, and exports a tamper-evident pack', (t) => {
  const context = fixture(t)
  const sentinelBefore = snapshotTree(context.runtimeHome)
  assert.equal(isAbsolute(context.storeDir), true)
  const relationToRepo = relative(resolve(ROOT), resolve(context.storeDir))
  assert.ok(relationToRepo === '..' || relationToRepo.startsWith('../') || isAbsolute(relationToRepo),
    `store must be outside the repository: ${context.storeDir}`)

  const firstFreeze = runJson(PILOT, [
    'freeze', context.draftPath,
    '--store', context.storeDir,
    '--seed-file', context.seedPath,
    '--frozen-at', FROZEN_AT,
  ], context, 'freeze')
  assert.equal(firstFreeze.value.created, true)
  assert.equal(firstFreeze.value.automatic_routing, false)
  assert.match(firstFreeze.value.freeze_event_id, /^sha256:[0-9a-f]{64}$/)
  assert.doesNotMatch(firstFreeze.result.stdout, new RegExp(SEED))
  const secondFreeze = runJson(PILOT, [
    'freeze', context.draftPath,
    '--store', context.storeDir,
    '--seed-file', context.seedPath,
    '--frozen-at', FROZEN_AT,
  ], context, 'freeze recapture')
  assert.equal(secondFreeze.value.created, false)
  assert.equal(secondFreeze.value.manifest_digest, firstFreeze.value.manifest_digest)

  const verifyManifest = runJson(PILOT, [
    'verify-manifest', '--store', context.storeDir,
  ], context, 'verify manifest')
  assert.equal(verifyManifest.value.valid, true)
  const manifestPath = join(context.storeDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(Object.hasOwn(manifest, 'assignment_seed'), false)
  assert.doesNotMatch(readFileSync(manifestPath, 'utf8'), new RegExp(SEED))
  assert.equal(readStore(context.storeDir).events
    .filter((event) => event.event_type === 'preregistration_frozen').length, 1)

  const assignments = []
  for (const [expectedArm, candidate] of candidatesForBothArms(manifest)) {
    const candidatePath = join(context.root, `${candidate.slice_id}.json`)
    writeJson(candidatePath, candidate)
    const assigned = runJson(PILOT, [
      'assign', candidatePath,
      '--store', context.storeDir,
      '--seed-file', context.seedPath,
      '--assigned-at', ASSIGNED_AT,
      '--actor', ACTORS.assignment,
    ], context, `assign ${candidate.slice_id}`)
    assert.equal(assigned.value.appended, true)
    assert.equal(assigned.value.eligibility_appended, true)
    assert.equal(assigned.value.eligibility_event.event_type, 'slice_eligible')
    assert.equal(assigned.value.event.payload.arm, expectedArm)
    assert.equal(assigned.value.event.payload.arm, independentArm(manifest, candidate))
    assert.equal(assigned.value.automatic_routing, false)
    assert.doesNotMatch(assigned.result.stdout, new RegExp(SEED))

    const recaptured = runJson(PILOT, [
      'assign', candidatePath,
      '--store', context.storeDir,
      '--seed-file', context.seedPath,
      '--assigned-at', ASSIGNED_AT,
      '--actor', ACTORS.assignment,
    ], context, `recapture ${candidate.slice_id}`)
    assert.equal(recaptured.value.appended, false)
    assert.equal(recaptured.value.eligibility_appended, false)
    assert.equal(recaptured.value.eligibility_event.event_id,
      assigned.value.eligibility_event.event_id)
    assert.equal(recaptured.value.event.event_id, assigned.value.event.event_id)
    assignments.push(assigned.value.event)
  }
  assert.deepEqual(new Set(assignments.map((event) => event.payload.arm)),
    new Set(['pm_routed', 'receiver_owned']))

  const capturedSlice = assignments[0].payload.slice_id
  const dispatchPath = join(context.root, 'dispatch.record')
  const outboxPath = join(context.root, 'outbox.record')
  const kmsPath = join(context.root, 'kms.record')
  writeFileSync(dispatchPath, [
    'task_id: source-task',
    'worker: worker-a',
    'started_at: 2026-07-03T00:01:00.000Z',
    'dispatch_id: dispatch-001',
    '',
  ].join('\n'))
  writeFileSync(outboxPath, 'worker evidence claim only\nTEAM_DONE source-task\n')
  writeFileSync(kmsPath, 'dispatch_id: dispatch-001\npm_verdict: pass\n')
  const sourceBytes = new Map([dispatchPath, outboxPath, kmsPath]
    .map((path) => [path, readFileSync(path)]))

  const captureCases = [
    ['mailbox-dispatch', dispatchPath, '2026-07-03T00:01:00.000Z', []],
    ['mailbox-outbox', outboxPath, '2026-07-03T00:02:00.000Z', ['--correlation', 'dispatch-001']],
    ['kms-event', kmsPath, '2026-07-03T00:03:00.000Z', []],
  ]
  let dispatchCapture
  for (const [kind, sourcePath, occurredAt, extra] of captureCases) {
    const captured = runJson(CAPTURE, [
      'capture', kind, sourcePath,
      '--store', context.storeDir,
      '--slice', capturedSlice,
      '--actor', ACTORS.pm,
      '--role', 'pm',
      '--at', occurredAt,
      ...extra,
    ], context, `capture ${kind}`)
    assert.equal(captured.value.appended, true)
    assert.equal(captured.value.event.event_type, 'source_observed')
    assert.equal(captured.value.event.payload.slice_id, capturedSlice)
    assert.equal(captured.value.event.payload.correlation_id, 'dispatch-001')
    dispatchCapture ??= captured.value
  }
  const eventCountBeforeRecapture = readStore(context.storeDir).events.length
  const recapturedSource = runJson(CAPTURE, [
    'capture', 'mailbox-dispatch', dispatchPath,
    '--store', context.storeDir,
    '--slice', capturedSlice,
    '--actor', ACTORS.pm,
    '--role', 'pm',
    '--at', '2026-07-03T00:01:00.000Z',
  ], context, 'recapture named source')
  assert.equal(recapturedSource.value.appended, false)
  assert.equal(recapturedSource.value.event.event_id, dispatchCapture.event.event_id)
  assert.equal(readStore(context.storeDir).events.length, eventCountBeforeRecapture)
  for (const [path, bytes] of sourceBytes) assert.deepEqual(readFileSync(path), bytes, path)

  const explicitPayload = {
    slice_id: capturedSlice,
    signal: 'PM_VERDICT_UNRESOLVED',
    correlation_id: 'dispatch-explicit',
  }
  const explicitEvent = makeEnvelope(manifest, readStore(context.storeDir).events, {
    aggregateType: 'observation',
    aggregateId: 'explicit-source-observation',
    eventType: 'source_observed',
    occurredAt: '2026-07-03T00:04:00.000Z',
    actorId: ACTORS.metric,
    actorRole: 'metric_producer',
    payload: explicitPayload,
  })
  const explicitEventPath = join(context.root, 'explicit-observation.json')
  writeJson(explicitEventPath, explicitEvent)
  const explicitCapture = runJson(CAPTURE, [
    'observation', explicitEventPath,
    '--store', context.storeDir,
  ], context, 'explicit observation')
  assert.equal(explicitCapture.value.appended, true)
  assert.equal(explicitCapture.value.event.event_id, explicitEvent.event_id)
  const explicitRecapture = runJson(CAPTURE, [
    'observation', explicitEventPath,
    '--store', context.storeDir,
  ], context, 'explicit observation recapture')
  assert.equal(explicitRecapture.value.appended, false)
  assert.equal(explicitRecapture.value.event.event_id, explicitEvent.event_id)

  const sourceOnlyReplay = runJson(PILOT, [
    'replay',
    '--store', context.storeDir,
    '--as-of', ANALYSIS_AS_OF,
  ], context, 'source-only replay').value
  const capturedReplaySlice = sourceOnlyReplay.slices
    .find((slice) => slice.slice_id === capturedSlice)
  assert.deepEqual(capturedReplaySlice.handoff_attempts, [])
  assert.equal(capturedReplaySlice.outcome, null)
  assert.ok(Object.values(capturedReplaySlice.guardrails).every((status) => status === 'UNKNOWN'))
  const sourceOnlyEvents = readStore(context.storeDir).events
  assert.equal(sourceOnlyEvents.filter((event) => event.event_type === 'source_observed').length, 4)
  assert.equal(sourceOnlyEvents.filter((event) => event.event_type === 'source_observed'
    && ['mailbox_dispatch', 'mailbox_outbox', 'kms_event'].includes(event.source.kind)).length, 3)
  assert.equal(sourceOnlyEvents.some((event) => [
    'attempt_transition_observed', 'outcome_observed', 'guardrail_observed',
  ].includes(event.event_type)), false)

  let exactObservation
  for (const [index, assignment] of assignments.entries()) {
    const observation = appendCompleteSlice(context.storeDir, manifest, assignment, {
      unknownCost: index === 0 ? 'queue_wait_minutes' : undefined,
    })
    exactObservation ??= observation
  }
  const beforeObservationRecapture = readStore(context.storeDir).events.length
  const observationRecapture = appendEventAtomic(context.storeDir, exactObservation)
  assert.equal(observationRecapture.appended, false)
  assert.equal(readStore(context.storeDir).events.length, beforeObservationRecapture)

  const replay = runJson(PILOT, [
    'replay',
    '--store', context.storeDir,
    '--as-of', ANALYSIS_AS_OF,
  ], context, 'complete replay').value
  assert.equal(replay.slices.length, 2)
  assert.ok(replay.slices.every((slice) => slice.live.complete),
    JSON.stringify(replay.slices, null, 2))
  assert.deepEqual(new Set(replay.slices.map((slice) => slice.arm)),
    new Set(['pm_routed', 'receiver_owned']))

  const rehearsal = runJson(PILOT, [
    'rehearse',
    '--store', context.storeDir,
    '--as-of', ANALYSIS_AS_OF,
    '--runs', '3',
  ], context, 'rehearse').value
  assert.deepEqual(rehearsal, {
    runs: 3,
    deterministic: true,
    evidence_bundle_digest: rehearsal.evidence_bundle_digest,
    both_arms_present: true,
    automatic_routing: false,
  })
  assert.match(rehearsal.evidence_bundle_digest, /^sha256:[0-9a-f]{64}$/)

  const outputDir = join(context.root, 'evidence-pack')
  const exported = runJson(EXPORT, [
    'export',
    '--store', context.storeDir,
    '--out', outputDir,
    '--as-of', ANALYSIS_AS_OF,
    '--source-revision', SOURCE_REVISION,
  ], context, 'export').value
  assert.equal(exported.output_dir, outputDir)
  assert.match(exported.pack_digest, /^sha256:[0-9a-f]{64}$/)
  const verified = runJson(EXPORT, ['verify-pack', outputDir], context, 'verify pack').value
  assert.deepEqual(verified, { valid: true, verified: true, errors: [] })

  const packPath = join(outputDir, 'pack-index.json')
  const projectionPath = join(outputDir, 'pulse-projection.json')
  const pack = JSON.parse(readFileSync(packPath, 'utf8'))
  const pluginManifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
  const projection = JSON.parse(readFileSync(projectionPath, 'utf8'))
  assert.equal(pack.tooling.exporter_version, pluginManifest.version)
  assert.equal(pack.business_decision, 'EXTERNAL_REQUIRED')
  assert.equal(pack.actuation, 'NONE')
  assert.equal(pack.completeness.unknown_cost_fraction, 1 / (2 * COST_CATEGORIES.length))
  assert.equal(pack.analysis_summary.measurement_readiness, 'INCONCLUSIVE')
  assert.deepEqual(projection.actuation, { enabled: false, auto_execute: false })
  assert.equal(projection.evidence.business_decision, 'EXTERNAL_REQUIRED')

  if (HAS_PYTHON_JSONSCHEMA) {
    const eventPaths = readdirSync(join(context.storeDir, 'events'))
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .map((name) => join(context.storeDir, 'events', name))
    for (const [schema, instances, definition, label] of [
      [MANIFEST_SCHEMA, [manifestPath], null, 'manifest schema'],
      [EVENT_SCHEMA, eventPaths, null, 'event schema'],
      [PACK_SCHEMA, [packPath], null, 'pack schema'],
      [PULSE_SCHEMA, [projectionPath], 'delivery_loop', 'pulse projection schema'],
    ]) {
      const validation = validateWithJsonSchema(schema, instances, definition)
      assert.equal(validation.status, 0, `${label}: ${validation.stderr || validation.stdout}`)
    }
  }

  const allStoreAndPackText = [
    readFileSync(manifestPath, 'utf8'),
    ...readdirSync(join(context.storeDir, 'events'))
      .map((name) => readFileSync(join(context.storeDir, 'events', name), 'utf8')),
    ...readdirSync(outputDir)
      .filter((name) => statSync(join(outputDir, name)).isFile())
      .map((name) => readFileSync(join(outputDir, name), 'utf8')),
  ].join('\n')
  assert.doesNotMatch(allStoreAndPackText, new RegExp(SEED), 'private seed leaked')

  const datasetPath = join(outputDir, pack.contents.dataset.path)
  const datasetBytes = readFileSync(datasetPath)
  const symlinkTarget = join(context.root, 'same-bytes-dataset.json')
  writeFileSync(symlinkTarget, datasetBytes)
  rmSync(datasetPath)
  symlinkSync(symlinkTarget, datasetPath)
  const symlinkedVerify = run(EXPORT, ['verify-pack', outputDir], context)
  const symlinkedResult = oneJsonLine(symlinkedVerify.stdout, 'symlinked pack')
  assert.equal(symlinkedVerify.status, 1)
  assert.equal(symlinkedResult.valid, false)
  assert.ok(symlinkedResult.errors.some(({ code }) => code === 'PACK_FILE_MISSING'))

  rmSync(datasetPath)
  writeFileSync(datasetPath, datasetBytes)
  const tampered = Buffer.from(datasetBytes)
  tampered[0] ^= 1
  writeFileSync(datasetPath, tampered)
  const tamperedVerify = run(EXPORT, ['verify-pack', outputDir], context)
  const tamperedResult = oneJsonLine(tamperedVerify.stdout, 'tampered pack')
  assert.equal(tamperedVerify.status, 1)
  assert.equal(tamperedResult.valid, false)
  assert.ok(tamperedResult.errors.some(({ code }) => code === 'PACK_FILE_DIGEST_MISMATCH'))

  writeFileSync(datasetPath, datasetBytes)
  writeFileSync(join(outputDir, 'smuggled.txt'), 'unindexed evidence must be rejected\n')
  const smuggledVerify = run(EXPORT, ['verify-pack', outputDir], context)
  const smuggledResult = oneJsonLine(smuggledVerify.stdout, 'pack with extra file')
  assert.equal(smuggledVerify.status, 1)
  assert.equal(smuggledResult.valid, false)
  assert.ok(smuggledResult.errors.some(({ code, path }) => (
    code === 'PACK_EXTRA_FILE' && path === 'smuggled.txt'
  )))

  assert.deepEqual(snapshotTree(context.runtimeHome), sentinelBefore,
    'pilot commands must not mutate runtime mailbox/KMS/Pulse directories')
})

test('Stage 1 side-effect modules contain no process-spawn or network surface', () => {
  for (const path of [STORE, CAPTURE, EXPORT, PILOT]) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source,
      /node:(?:child_process|http|https|net|tls|dgram|dns)|\b(?:fetch|WebSocket)\s*\(/,
      `${path} must remain offline and unable to spawn processes`)
  }
})
