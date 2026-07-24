#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

import {
  PilotValidationError,
  buildEvidencePack as buildCoreBundle,
} from './delivery-loop-pilot-core.mjs'
import {
  readJsonFile,
  readStore,
  requireAbsoluteDir,
} from './delivery-loop-store.mjs'
import {
  COST_CATEGORIES,
  GUARDRAIL_NAMES,
  canonicalDigest,
  canonicalJson,
} from './delivery-loop-core.mjs'

const PACK_SCHEMA = ['t', 'mux-teams.delivery-loop-evidence-pack'].join('')
const PROJECTION_SCHEMA = ['t', 'mux-teams.delivery-loop-projection'].join('')
const EXPORTER_VERSION = '0.9.0'
const SOURCE_REVISION_RE = /^[0-9a-f]{40}$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

function exportError(code, message, path = '') {
  return new PilotValidationError([{ code, path, message }], code)
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function ndjsonBytes(values) {
  return Buffer.from(values.map((value) => canonicalJson(value)).join('\n') + '\n')
}

function fileEntry(path, bytes, mediaType) {
  return {
    path,
    digest: sha256Bytes(bytes),
    bytes: bytes.length,
    media_type: mediaType,
  }
}

function boundaryCode(boundary) {
  return {
    'Requirement:Prototype': 'requirement_to_prototype',
    'Prototype:Development': 'prototype_to_development',
    'Development:QA': 'development_to_qa',
    'QA:ProjectDelivery': 'qa_to_project_delivery',
  }[`${boundary.sender_phase}:${boundary.receiver_phase}`]
}

export function buildPulseProjection({ manifest, bundle, generatedAt }) {
  const analysis = bundle.analysis
  const guardrailBreach = analysis.guardrail_status === 'BREACH'
  const ready = analysis.measurement_readiness === 'READY'
  const action = guardrailBreach
    ? {
        attention_id: 'guardrail-hold',
        severity: 'hold',
        owner_role: 'qa',
        reason_codes: ['GUARDRAIL_BREACH'],
        action_code: 'verify_and_recommend_manual_hold',
      }
    : ready
      ? {
          attention_id: 'external-review-ready',
          severity: 'info',
          owner_role: 'external_reviewer',
          reason_codes: ['EXTERNAL_REVIEW_READY'],
          action_code: 'request_external_review',
        }
      : {
          attention_id: 'measurement-incomplete',
          severity: 'warning',
          owner_role: 'metric_producer',
          reason_codes: ['MEASUREMENT_INCOMPLETE'],
          action_code: 'complete_measurement',
        }
  const expiresAt = new Date(Date.parse(generatedAt) + 5 * 60_000).toISOString()
  const boundary = boundaryCode(manifest.boundary)
  const assigned = bundle.replay.slices.length
  const terminal = bundle.replay.slices.filter((slice) => slice.handoff_attempts
    .some((attempt) => ['accepted', 'rejected', 'cancelled', 'abandoned'].includes(attempt.state))).length
  const exceptions = bundle.replay.slices.reduce(
    (sum, slice) => sum + slice.handoff_attempts.filter((attempt) => attempt.state === 'escalated').length,
    0,
  )
  const attention = [{
    ...action,
    scope: 'experiment',
    slice_id: null,
    phase: manifest.boundary.sender_phase,
    auto_execute: false,
  }]
  return {
    schema: PROJECTION_SCHEMA,
    schema_version: 1,
    generated_at: generatedAt,
    expires_at: expiresAt,
    trust_level: 'advisory_same_uid',
    mode: 'stage1_observe_only',
    status: guardrailBreach ? 'paused' : ready ? 'complete' : 'active',
    actuation: { enabled: false, auto_execute: false },
    experiment: {
      experiment_id: manifest.experiment_id,
      manifest_id: manifest.manifest_id,
      manifest_digest: manifest.manifest_digest,
      dataset_digest: bundle.dataset_digest,
      boundary,
      assignment_window: {
        start: manifest.assignment.assignment_window.start,
        end: manifest.assignment.assignment_window.end,
      },
      analysis_as_of: bundle.as_of,
    },
    source_health: {
      manifest: 'ok',
      assignment: 'ok',
      events: 'ok',
      costs: bundle.analysis.metrics.cost_complete ? 'ok' : 'degraded',
      outcomes: bundle.analysis.metrics.outcome_complete ? 'ok' : 'degraded',
      guardrails: analysis.guardrail_status === 'UNKNOWN' ? 'degraded' : 'ok',
      export: 'ok',
    },
    summary: {
      assigned,
      in_progress: Math.max(0, assigned - terminal),
      terminal,
      exceptions,
      contaminated: bundle.replay.slices.filter((slice) => slice.contamination).length,
      operator_action_total: attention.length,
      operator_action_shown: attention.length,
      operator_action_truncated: 0,
    },
    phase_cards: [{
      phase: manifest.boundary.sender_phase,
      state: guardrailBreach ? 'exception' : ready ? 'complete' : 'active',
      active_slices: Math.max(0, assigned - terminal),
      oldest_open_age_sec: null,
      reason_codes: ['OBSERVATION_CURRENT'],
      advisory: {
        attention: false,
        owner_role: 'operator',
        action_code: 'monitor',
        auto_execute: false,
      },
    }],
    bottleneck: {
      status: terminal === assigned ? 'none' : 'inconclusive',
      basis: 'oldest_open_handoff_age',
      boundary: terminal === assigned ? null : boundary,
      age_sec: null,
      reason_codes: [terminal === assigned ? 'NO_ACTIVE_SLICES' : 'BOTTLENECK_INCONCLUSIVE'],
    },
    attention,
    next_action: {
      scope: 'experiment',
      slice_id: null,
      phase: manifest.boundary.sender_phase,
      owner_role: action.owner_role,
      reason_codes: action.reason_codes,
      action_code: action.action_code,
      auto_execute: false,
    },
    evidence: {
      measurement_readiness: analysis.measurement_readiness,
      scenario_signal: analysis.scenario_signal,
      guardrail_status: analysis.guardrail_status,
      evidence_eligibility: 'OBSERVED_UNVERIFIED',
      safety_hold_recommended: analysis.safety_hold_recommended,
      business_decision: 'EXTERNAL_REQUIRED',
    },
  }
}

const REVIEW_INSTRUCTIONS = `# External review instructions

This pack is an integrity-bound, same-UID advisory export. It is not certified.

The external reviewer must independently:

1. authenticate the frozen-manifest anchor and reviewer identity;
2. rederive every file digest, the event chains, the ITT dataset, and analysis;
3. verify role separation, contamination, missing data, guardrails, and maturity;
4. issue any recommendation outside this toolkit; and
5. send that recommendation to a separately identified business owner for ratification.

The toolkit never issues GO, ITERATE, NO_GO, approval, certification, or actuation.
`

function writeExclusive(path, bytes) {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
}

function safePackId(experimentId, digest) {
  const candidate = `pack-${experimentId}`
  return candidate.length <= 64 ? candidate : `pack-${digest.slice(-40)}`
}

export function summarizeCompleteness(bundle, assignments = bundle.replay.assignments) {
  const slices = bundle.dataset.slices
  const costCellCount = slices.length * COST_CATEGORIES.length
  const unknownCostCount = slices.reduce(
    (count, slice) => count + COST_CATEGORIES
      .filter((category) => slice.costs[category] === null).length,
    0,
  )
  const nonMatureCount = Object.values(
    bundle.analysis.intention_to_treat.non_mature_by_arm,
  ).reduce((sum, value) => sum + value, 0)
  return {
    assignment_complete: assignments.length === slices.length,
    cost_categories_present: [...COST_CATEGORIES],
    unknown_cost_fraction: costCellCount === 0 ? 0 : unknownCostCount / costCellCount,
    outcome_observation_complete: bundle.replay.slices
      .every((slice) => slice.observation_coverage?.outcome === 'observed'),
    missing_mature_outcome_fraction: slices.length === 0 ? 0 : nonMatureCount / slices.length,
    guardrails_present: [...GUARDRAIL_NAMES],
    contaminated_slice_count: slices.filter((slice) => slice.contamination).length,
  }
}

export function exportEvidencePack({
  storeDir,
  outputDir,
  analysisAsOf,
  sourceRevision,
}) {
  if (!SOURCE_REVISION_RE.test(sourceRevision ?? '')) {
    throw exportError('SOURCE_REVISION_INVALID', 'sourceRevision must be a 40-character Git SHA.', 'sourceRevision')
  }
  const store = requireAbsoluteDir(storeDir, 'store')
  const output = requireAbsoluteDir(outputDir, 'output')
  const relation = relative(store, output)
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))) {
    throw exportError('OUTPUT_INSIDE_STORE', 'Evidence output must not be inside the mutable pilot store.', output)
  }
  if (existsSync(output)) throw exportError('OUTPUT_EXISTS', 'Evidence output directory must not already exist.', output)
  if (!existsSync(dirname(output))) throw exportError('OUTPUT_PARENT_MISSING', 'Evidence output parent must already exist.', dirname(output))

  const { manifest, events } = readStore(store)
  const bundle = buildCoreBundle(manifest, events, { analysisAsOf })
  const projection = buildPulseProjection({ manifest, bundle, generatedAt: analysisAsOf })
  const traceIndex = bundle.trace_index
  const assignments = bundle.replay.assignments
  const files = {
    manifest: ['manifest.json', jsonBytes(manifest), 'application/json'],
    assignments: ['assignments.json', jsonBytes(assignments), 'application/json'],
    event_log: ['events.jsonl', ndjsonBytes(bundle.ledger), 'application/x-ndjson'],
    dataset: ['dataset.json', jsonBytes(bundle.dataset), 'application/json'],
    replay_report: ['replay.json', jsonBytes(bundle.replay), 'application/json'],
    analysis_report: ['analysis.json', jsonBytes(bundle.analysis), 'application/json'],
    trace_index: ['trace-index.json', jsonBytes(traceIndex), 'application/json'],
    review_instructions: ['external-review.md', Buffer.from(REVIEW_INSTRUCTIONS), 'text/markdown'],
    pulse_projection: ['pulse-projection.json', jsonBytes(projection), 'application/json'],
  }
  const contents = Object.fromEntries(Object.entries(files).map(([key, [path, bytes, mediaType]]) => [
    key,
    fileEntry(path, bytes, mediaType),
  ]))
  const aggregateCount = new Set(bundle.ledger.map((event) => `${event.aggregate.type}\0${event.aggregate.id}`)).size
  const completeness = summarizeCompleteness(bundle, assignments)
  const pack = {
    schema: PACK_SCHEMA,
    schema_version: 1,
    pack_id: safePackId(manifest.experiment_id, bundle.dataset_digest),
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    event_log_digest: bundle.ledger_digest,
    dataset_digest: bundle.dataset_digest,
    analysis_as_of: analysisAsOf,
    created_at: analysisAsOf,
    trust_level: 'advisory_same_uid',
    provenance: 'observed_unverified',
    identity_authenticated: false,
    certification_status: 'NOT_CERTIFIED',
    business_decision: 'EXTERNAL_REQUIRED',
    actuation: 'NONE',
    source_custody: {
      local_principal: 'same_uid_local_toolkit',
      same_uid_worker_writable: true,
      local_digest_verification: 'INTEGRITY_CHECK_ONLY',
      external_anchor: {
        anchor_type: manifest.external_anchor.anchor_type,
        anchor_ref: manifest.external_anchor.anchor_ref,
        anchor_digest: manifest.external_anchor.anchor_digest,
        anchored_at: manifest.external_anchor.anchored_at,
        custodian_actor_id: manifest.external_anchor.custodian_actor_id,
        outside_worker_writable_repository: true,
        authenticated_by_toolkit: false,
      },
    },
    contents,
    replay: {
      status: 'VALID',
      event_count: bundle.ledger.length,
      aggregate_count: aggregateCount,
      sequence_gap_count: 0,
      chain_conflict_count: 0,
      superseded_event_count: bundle.ledger.filter((event) => event.event_type === 'observation_superseded').length,
      assigned_slice_count: assignments.length,
      retained_itt_slice_count: bundle.dataset.slices.length,
    },
    completeness,
    analysis_summary: {
      measurement_readiness: bundle.analysis.measurement_readiness,
      scenario_signal: bundle.analysis.scenario_signal,
      guardrail_status: bundle.analysis.guardrail_status,
      evidence_eligibility: 'OBSERVED_UNVERIFIED',
      safety_hold_recommended: bundle.analysis.safety_hold_recommended,
    },
    external_review: {
      required: true,
      review_status: 'PENDING_EXTERNAL',
      reviewer_actor_ids: manifest.roles.external_reviewer_ids,
      custody_check_required: true,
      independent_digest_recalculation_required: true,
      role_identity_authentication_required: true,
      review_location: 'outside_toolkit',
      business_owner_ratification_location: 'outside_toolkit',
    },
    tooling: {
      exporter_version: EXPORTER_VERSION,
      event_schema_version: 1,
      manifest_schema_version: 1,
      evidence_pack_schema_version: 1,
      source_revision: sourceRevision,
      canonicalization: 'unicode_code_point_order_v1',
    },
    diagnostics: [
      { code: 'ROLE_SEPARATION_UNVERIFIED', severity: 'warning', source: 'custody', count: 1 },
      { code: 'EXTERNAL_CUSTODY_UNVERIFIED', severity: 'warning', source: 'custody', count: 1 },
    ],
  }
  pack.pack_digest = canonicalDigest(pack)
  mkdirSync(output, { mode: 0o700 })
  for (const [path, bytes] of Object.values(files)) writeExclusive(join(output, path), bytes)
  writeExclusive(join(output, 'pack-index.json'), jsonBytes(pack))
  return { output_dir: output, pack }
}

function safeContainedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/')
    || relativePath.split('/').includes('..')) {
    throw exportError('PACK_PATH_INVALID', 'Pack contains an unsafe relative path.', relativePath)
  }
  const target = resolve(root, relativePath)
  const relation = relative(root, target)
  if (relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw exportError('PACK_PATH_INVALID', 'Pack path escapes root.', relativePath)
  return target
}

export function verifyExportedEvidencePack(packDir) {
  const root = requireAbsoluteDir(packDir, 'pack')
  const index = readJsonFile(join(root, 'pack-index.json'))
  const errors = []
  const unsigned = structuredClone(index)
  delete unsigned.pack_digest
  if (!DIGEST_RE.test(index.pack_digest ?? '') || canonicalDigest(unsigned) !== index.pack_digest) {
    errors.push({ code: 'PACK_DIGEST_MISMATCH', path: 'pack_digest' })
  }
  if (index.schema !== PACK_SCHEMA
    || index.schema_version !== 1
    || index.trust_level !== 'advisory_same_uid'
    || index.identity_authenticated !== false
    || index.certification_status !== 'NOT_CERTIFIED'
    || index.business_decision !== 'EXTERNAL_REQUIRED'
    || index.actuation !== 'NONE') {
    errors.push({ code: 'PACK_TRUST_INVALID', path: '' })
  }
  const expectedFiles = new Set([
    'pack-index.json',
    ...Object.values(index.contents ?? {}).map((entry) => entry.path),
  ])
  for (const name of readdirSync(root)) {
    if (!expectedFiles.has(name)) errors.push({ code: 'PACK_EXTRA_FILE', path: name })
  }
  for (const name of expectedFiles) {
    try {
      if (!existsSync(safeContainedPath(root, name))) errors.push({ code: 'PACK_FILE_MISSING', path: name })
    } catch {
      errors.push({ code: 'PACK_PATH_INVALID', path: name })
    }
  }
  for (const entry of Object.values(index.contents ?? {})) {
    try {
      const path = safeContainedPath(root, entry.path)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw exportError('PACK_FILE_INVALID', 'Pack entry is not a regular file.', entry.path)
      const bytes = readFileSync(path)
      if (bytes.length !== entry.bytes || sha256Bytes(bytes) !== entry.digest) {
        errors.push({ code: 'PACK_FILE_DIGEST_MISMATCH', path: entry.path })
      }
    } catch {
      errors.push({ code: 'PACK_FILE_MISSING', path: entry.path })
    }
  }
  try {
    const manifest = readJsonFile(join(root, index.contents.manifest.path))
    const events = readFileSync(join(root, index.contents.event_log.path), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    const rebuilt = buildCoreBundle(manifest, events, { analysisAsOf: index.analysis_as_of })
    if (rebuilt.ledger_digest !== index.event_log_digest) errors.push({ code: 'EVENT_LOG_DIGEST_MISMATCH', path: 'event_log_digest' })
    if (rebuilt.dataset_digest !== index.dataset_digest) errors.push({ code: 'DATASET_DIGEST_MISMATCH', path: 'dataset_digest' })
    if (rebuilt.manifest_digest !== index.manifest_digest) errors.push({ code: 'MANIFEST_DIGEST_MISMATCH', path: 'manifest_digest' })
  } catch (error) {
    errors.push({ code: 'PACK_REPLAY_FAILED', path: '', message: error.message })
  }
  return { valid: errors.length === 0, verified: errors.length === 0, errors }
}

function flag(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function usage() {
  return 'usage: delivery-loop-export.mjs export --store <absolute-dir> --out <new-absolute-dir> --as-of <RFC3339> --source-revision <40-hex> | delivery-loop-export.mjs verify-pack <absolute-dir>'
}

async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const [command, ...args] = argv
  if (command === 'export') {
    const result = exportEvidencePack({
      storeDir: flag(args, '--store'),
      outputDir: flag(args, '--out'),
      analysisAsOf: flag(args, '--as-of'),
      sourceRevision: flag(args, '--source-revision'),
    })
    process.stdout.write(`${JSON.stringify({ output_dir: result.output_dir, pack_digest: result.pack.pack_digest })}\n`)
    return
  }
  if (command === 'verify-pack' && args.length === 1) {
    const result = verifyExportedEvidencePack(args[0])
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  throw exportError('USAGE', usage())
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    if (error?.code === 'USAGE') {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`${JSON.stringify({
      error: error.code ?? 'EXPORT_FAILED',
      message: error.message,
      diagnostics: error.errors ?? [],
    })}\n`)
    process.exitCode = 1
  })
}
