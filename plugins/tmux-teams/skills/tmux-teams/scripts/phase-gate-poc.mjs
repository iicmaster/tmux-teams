#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendPhaseGateCommand,
  dispatchPhaseGateCompanion,
  initializePhaseGateController,
  phaseGateStatus,
  reservePhaseGateDispatch,
} from './phase-gate-controller.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PULSE = join(HERE, 'pulse.mjs')
const KMS = join(HERE, 'kms.mjs')
const PHASES = Object.freeze(['Requirement', 'Prototype', 'Development', 'QA'])
const RECEIVER_PHASE = Object.freeze({
  Requirement: 'Prototype',
  Prototype: 'Development',
  Development: 'QA',
  QA: 'ProjectDelivery',
})
const ARTIFACT_TYPE = Object.freeze({
  Requirement: 'requirements_baseline',
  Prototype: 'prototype_evaluation',
  Development: 'development_delivery',
  QA: 'qa_release_evidence',
})
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
const shaBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const actor = (actor_id, role) => ({ actor_id, role, trust: 'advisory_same_uid' })

function ensureFreshOutput(outDir) {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw Object.assign(new Error(`POC output directory is not empty: ${outDir}`), {
      code: 'POC_OUTPUT_NOT_EMPTY',
    })
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
}

function nextOccurredAt(repoRoot) {
  const events = phaseGateStatus(repoRoot).aggregate.events
  const prior = Date.parse(events.at(-1)?.occurred_at ?? 0)
  return new Date(Math.max(Date.now(), prior + 1)).toISOString()
}

function append(repoRoot, command, options) {
  return appendPhaseGateCommand(repoRoot, {
    ...command,
    occurred_at: command.occurred_at ?? nextOccurredAt(repoRoot),
  }, options)
}

function artifactDescriptor(artifactsDir, phase, revision, predecessorId = null) {
  const artifact_id = `${phase.toLowerCase()}-artifact-r${revision}`
  const body = Buffer.from(`${JSON.stringify({
    artifact_id,
    phase,
    revision,
    expected_outcome: {
      Requirement: 'Validated business function baseline',
      Prototype: 'Clickable prototype accepted by Development',
      Development: 'Working software accepted by QA',
      QA: 'E2E and UAT evidence accepted for delivery',
    }[phase],
  }, null, 2)}\n`)
  const artifact_file = join(artifactsDir, `${artifact_id}.json`)
  writeFileSync(artifact_file, body, { mode: 0o600 })
  const artifact = {
    type: ARTIFACT_TYPE[phase],
    artifact_id,
    version: String(revision),
    digest: shaBytes(body),
    predecessor_trace: predecessorId === null ? [] : [predecessorId],
    validation_evidence: [`poc-evidence:${artifact_id}`],
    expectations: {
      security: 'validated',
      performance: 'validated',
      integration: 'validated',
      uat: 'validated',
    },
  }
  if (phase === 'Requirement') {
    artifact.business_functions = ['four-phase delivery loop']
    artifact.validation_exceptions = []
  }
  if (phase === 'Prototype') artifact.clickable_prototype_ref = 'poc://prototype/clickable'
  if (phase === 'Development') artifact.working_software_ref = 'poc://software/working'
  if (phase === 'QA') artifact.e2e_uat_report_ref = 'poc://qa/e2e-uat-report'
  return { artifact, artifact_file }
}

function submitAndPropose(repoRoot, phase, revision, artifactRow) {
  const attempt_id = `poc-attempt-${phase.toLowerCase()}-r${revision}`
  const handoff_id = `poc-gate-${phase.toLowerCase()}-r${revision}`
  const boundary = { sender_phase: phase, receiver_phase: RECEIVER_PHASE[phase] }
  const sender = ACTORS.phase_leads[phase][0]
  const submitted = append(repoRoot, {
    attempt_id,
    handoff_id,
    revision,
    boundary,
    artifact: artifactRow.artifact,
    actor: actor(sender, 'sender'),
    command_id: `poc:submit:${phase}:r${revision}`,
    idempotency_key: `poc:submit:${phase}:r${revision}`,
    event_type: 'artifact_submission',
    payload: {},
  }, { artifact_file: artifactRow.artifact_file })
  append(repoRoot, {
    attempt_id,
    handoff_id,
    revision,
    boundary,
    artifact: artifactRow.artifact,
    artifact_event_id: submitted.event.event_id,
    actor: actor(sender, 'sender'),
    command_id: `poc:propose:${phase}:r${revision}`,
    idempotency_key: `poc:propose:${phase}:r${revision}`,
    event_type: 'handoff_propose',
    payload: {},
  })
  return {
    ...artifactRow,
    attempt_id,
    handoff_id,
    revision,
    boundary,
    artifact_event_id: submitted.event.event_id,
  }
}

function reject(repoRoot, attempt, reason_code) {
  const receiver = ACTORS.phase_leads[attempt.boundary.receiver_phase][0]
  return append(repoRoot, {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: attempt.revision,
    boundary: attempt.boundary,
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor(receiver, 'receiver_phase_lead'),
    command_id: `poc:reject:${attempt.attempt_id}`,
    idempotency_key: `poc:reject:${attempt.attempt_id}`,
    event_type: 'handoff_reject',
    payload: { reason_code },
  })
}

function accept(repoRoot, attempt) {
  const phase = attempt.boundary.sender_phase
  const receiver = ACTORS.phase_leads[attempt.boundary.receiver_phase][0]
  return append(repoRoot, {
    attempt_id: attempt.attempt_id,
    handoff_id: attempt.handoff_id,
    revision: attempt.revision,
    boundary: attempt.boundary,
    artifact: attempt.artifact,
    artifact_event_id: attempt.artifact_event_id,
    actor: actor(receiver, 'receiver_phase_lead'),
    command_id: `poc:accept:${attempt.attempt_id}`,
    idempotency_key: `poc:accept:${attempt.attempt_id}`,
    event_type: phase === 'QA' ? 'project_delivery_accept' : 'handoff_accept',
    payload: {
      artifact_event_id: attempt.artifact_event_id,
      artifact_digest: attempt.artifact.digest,
      sender_phase: phase,
      receiver_phase: attempt.boundary.receiver_phase,
      sender_actor_id: ACTORS.phase_leads[phase][0],
      receiver_actor_id: receiver,
    },
  })
}

function waitForChild(child, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) return resolvePromise()
      rejectPromise(Object.assign(
        new Error(`${label} ACP companion exited with code ${code} signal ${signal ?? 'none'}`),
        { code: 'POC_ACP_DISPATCH_FAILED' },
      ))
    })
  })
}

function recordPhaseTeamVerdict(repoRoot, launched, phase, aggregate) {
  const reservation = aggregate.events.find((event) =>
    event.event_type === 'dispatch_reservation' &&
    event.dispatch_uuid === launched.dispatch_uuid)
  const body = [
    `dispatch_id: ${launched.dispatch_uuid}`,
    `task_id: poc-${phase.toLowerCase()}`,
    'worker: poc-agent',
    'transport: acp',
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    'verifier_role: phase_team',
    `phase: ${phase}`,
    `started_at: ${reservation?.occurred_at ?? new Date().toISOString()}`,
    'wait_sec: 0',
    `timeout_sec: ${launched.timeout_sec}`,
    'evidence: phase team checked the worker result before producing its exit artifact',
    '',
  ].join('\n')
  const recorded = spawnSync(process.execPath, [KMS, 'append', repoRoot, '-'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: body,
  })
  if (recorded.status !== 0) {
    throw Object.assign(new Error(`Could not record ${phase} team verdict: ${recorded.stderr}`), {
      code: 'POC_TEAM_VERDICT_FAILED',
    })
  }
}

async function dispatch(repoRoot, briefsDir, phase, acceptance_event_id = null, timeoutSec = 30) {
  const brief_file = join(briefsDir, `${phase.toLowerCase()}.md`)
  writeFileSync(
    brief_file,
    `# ${phase} phase POC\n\nDeliver the ${ARTIFACT_TYPE[phase]} evidence and write the exact mailbox terminal marker.\n`,
    { mode: 0o600 },
  )
  const task_id = `poc-${phase.toLowerCase()}`
  const input = {
    task_id,
    agent_id: 'poc-agent',
    brief_file,
    timeout_sec: timeoutSec,
  }
  if (phase === 'Requirement') {
    input.bootstrap = true
    input.actor_id = ACTORS.phase_leads.Requirement[0]
  } else {
    input.acceptance_event_id = acceptance_event_id
  }
  const launched = dispatchPhaseGateCompanion(repoRoot, input)
  await waitForChild(launched.child, phase)
  const aggregate = phaseGateStatus(repoRoot).aggregate
  const final = aggregate.dispatches[launched.dispatch_uuid]
  const terminal = aggregate.events.find((event) =>
    event.event_type === 'dispatch_terminal' && event.dispatch_uuid === launched.dispatch_uuid)
  if (final?.state !== 'terminal' || terminal?.payload?.outcome !== 'success') {
    throw Object.assign(new Error(`${phase} dispatch did not reach a successful governed terminal`), {
      code: 'POC_DISPATCH_NOT_TERMINAL',
    })
  }
  recordPhaseTeamVerdict(repoRoot, launched, phase, aggregate)
  return launched
}

function secondsBetween(left, right) {
  if (!left || !right) return null
  return Math.max(0, (Date.parse(right) - Date.parse(left)) / 1000)
}

function buildResult(status, invalidQaDispatchBlocked, repoRoot) {
  const { aggregate, projection } = status
  const events = aggregate.events
  const phase_metrics = projection.phase_runs.map((run) => ({
    phase: run.phase,
    state: run.state,
    cycle_time_sec: secondsBetween(run.started_at, run.transition_at),
    handoff_count: run.handoff_count,
    revision_count: run.revision_count,
  }))
  const acceptanceEvents = events.filter((event) =>
    ['handoff_accept', 'project_delivery_accept'].includes(event.event_type))
  const pmExceptionEvents = events.filter((event) =>
    ['handoff_escalate', 'handoff_resolve', 'dispatch_resolution'].includes(event.event_type)
    && event.actor.role === 'pm')
  const acceptanceDispatches = new Map()
  for (const dispatch of Object.values(aggregate.dispatches)) {
    if (!dispatch.acceptance_event_id) continue
    acceptanceDispatches.set(
      dispatch.acceptance_event_id,
      (acceptanceDispatches.get(dispatch.acceptance_event_id) ?? 0) + 1,
    )
  }
  const duplicate_dispatch_count = [...acceptanceDispatches.values()]
    .filter((count) => count > 1)
    .reduce((total, count) => total + count - 1, 0)
  let phaseTeamVerdictCount = 0
  try {
    phaseTeamVerdictCount = readdirSync(join(repoRoot, '.tmux-teams', 'kms', 'events'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => readFileSync(join(repoRoot, '.tmux-teams', 'kms', 'events', name), 'utf8'))
      .filter((body) => /^verifier_role:[ \t]*phase_team$/m.test(body)).length
  } catch {
    phaseTeamVerdictCount = 0
  }
  const measurement_ready = aggregate.terminal === true
    && projection.phase_runs.length === 4
    && projection.phase_runs.every((run) => run.state === 'completed')
    && projection.bottleneck === null
    && duplicate_dispatch_count === 0
    && phaseTeamVerdictCount === 4
    && invalidQaDispatchBlocked
  return {
    schema: 'tmux-teams.phase-gate-poc-result',
    schema_version: 1,
    scenario: 'full_loop_with_requirement_rejection_and_revision',
    expected_outcome: 'Four receiver-owned phases deliver one business slice without PM routine routing.',
    measurement: {
      status: measurement_ready ? 'scenario_signal' : 'failed',
      measurement_ready,
      project_delivery_reached: aggregate.terminal === true,
      phase_count: projection.phase_runs.length,
      completed_phase_count: projection.phase_runs.filter((run) => run.state === 'completed').length,
      phase_metrics,
      gate_summary: projection.summary,
      runtime_attention_count: projection.bottleneck === null ? 0 : 1,
      receiver_owned_acceptance_count: acceptanceEvents
        .filter((event) => event.actor.role === 'receiver_phase_lead').length,
      pm_routine_acceptance_count: acceptanceEvents
        .filter((event) => event.actor.role === 'pm').length,
      pm_exception_touch_count: pmExceptionEvents.length,
      phase_team_worker_verdict_count: phaseTeamVerdictCount,
      legacy_pm_verdict_field_note: 'The field name is retained for compatibility; verifier_role is phase_team in this POC.',
      receiver_dispatch_count: Object.values(aggregate.dispatches)
        .filter((row) => row.acceptance_event_id !== null).length,
      duplicate_dispatch_count,
      invalid_qa_dispatch_blocked: invalidQaDispatchBlocked,
    },
    business_value_signal: {
      routine_handoffs_owned_by_receivers: true,
      pm_reserved_for_exceptions: true,
      bottleneck_location_observable: true,
      rework_visible_at_requirement_gate: true,
    },
    roi: {
      status: 'ROI_NOT_ESTABLISHED',
      reason: 'A deterministic single-run POC has neither a production baseline nor a counterfactual.',
      next_evidence: 'Run matched production slices and compare PM routing time, queue wait, rework, and escaped defects.',
    },
  }
}

function assertExpected(result, projection) {
  const states = Object.fromEntries(projection.phase_gates.map((gate) => [gate.gate_id, gate.state]))
  const expectedStates = {
    'poc-gate-requirement-r1': 'rejected',
    'poc-gate-requirement-r2': 'consumed',
    'poc-gate-prototype-r1': 'consumed',
    'poc-gate-development-r1': 'consumed',
    'poc-gate-qa-r1': 'accepted',
  }
  if (!result.measurement.measurement_ready
    || JSON.stringify(states) !== JSON.stringify(expectedStates)
    || projection.summary.proposed !== 5
    || projection.summary.accepted !== 4
    || projection.summary.rejected !== 1
    || projection.summary.consumed !== 3) {
    throw Object.assign(new Error('Full-loop POC failed its expected outcome contract'), {
      code: 'POC_EXPECTATION_FAILED',
    })
  }
}

export async function runPhaseGatePoc({
  out_dir,
  acp_cmd = process.env.ACP_CMD,
  time_zone = 'Asia/Bangkok',
  timeout_sec = 30,
} = {}) {
  if (!out_dir) throw Object.assign(new Error('out_dir is required'), { code: 'POC_OUTPUT_REQUIRED' })
  if (typeof acp_cmd !== 'string' || acp_cmd.trim().length === 0) {
    throw Object.assign(new Error('acp_cmd or ACP_CMD is required'), { code: 'POC_ACP_CMD_REQUIRED' })
  }
  const outDir = resolve(out_dir)
  ensureFreshOutput(outDir)
  const repoRoot = join(outDir, 'repo')
  const storeDir = join(outDir, 'store')
  const artifactsDir = join(outDir, 'artifacts')
  const briefsDir = join(outDir, 'briefs')
  const isolatedHomeDir = join(outDir, 'home')
  for (const path of [repoRoot, artifactsDir, briefsDir, isolatedHomeDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }

  const oldAcpCmd = process.env.ACP_CMD
  const oldMockEvidence = process.env.MOCK_EVIDENCE
  process.env.ACP_CMD = acp_cmd
  process.env.MOCK_EVIDENCE = '1'
  try {
    initializePhaseGateController(repoRoot, {
      project_run_id: 'poc-full-loop',
      slice_id: 'poc-business-slice',
      store_dir: storeDir,
      actors: ACTORS,
      trust_level: 'advisory_same_uid',
      pm_actor_id: ACTORS.pm[0],
      occurred_at: new Date().toISOString(),
    })

    await dispatch(repoRoot, briefsDir, 'Requirement', null, timeout_sec)
    const requirementR1 = submitAndPropose(
      repoRoot,
      'Requirement',
      1,
      artifactDescriptor(artifactsDir, 'Requirement', 1),
    )
    reject(repoRoot, requirementR1, 'missing_exception_validation')
    const requirementR2 = submitAndPropose(
      repoRoot,
      'Requirement',
      2,
      artifactDescriptor(artifactsDir, 'Requirement', 2),
    )
    let acceptance = accept(repoRoot, requirementR2)

    await dispatch(repoRoot, briefsDir, 'Prototype', acceptance.event.event_id, timeout_sec)
    const prototype = submitAndPropose(
      repoRoot,
      'Prototype',
      1,
      artifactDescriptor(artifactsDir, 'Prototype', 1, requirementR2.artifact.artifact_id),
    )
    acceptance = accept(repoRoot, prototype)

    await dispatch(repoRoot, briefsDir, 'Development', acceptance.event.event_id, timeout_sec)
    const development = submitAndPropose(
      repoRoot,
      'Development',
      1,
      artifactDescriptor(artifactsDir, 'Development', 1, prototype.artifact.artifact_id),
    )
    acceptance = accept(repoRoot, development)

    await dispatch(repoRoot, briefsDir, 'QA', acceptance.event.event_id, timeout_sec)
    const qa = submitAndPropose(
      repoRoot,
      'QA',
      1,
      artifactDescriptor(artifactsDir, 'QA', 1, development.artifact.artifact_id),
    )
    const qaAcceptance = accept(repoRoot, qa)

    let invalidQaDispatchBlocked = false
    try {
      reservePhaseGateDispatch(repoRoot, {
        acceptance_event_id: qaAcceptance.event.event_id,
        task_id: 'poc-illegal-phase-five',
        agent_id: 'poc-agent',
        brief_file: join(briefsDir, 'qa.md'),
        timeout_sec,
      })
    } catch (cause) {
      invalidQaDispatchBlocked = cause.code === 'PROJECT_DELIVERY_NO_DISPATCH'
      if (!invalidQaDispatchBlocked) throw cause
    }

    const projectionNow = new Date(Date.now() + 2_000).toISOString()
    const status = phaseGateStatus(repoRoot, { now: projectionNow, ttl_sec: 3600, limit: 100 })
    const result = buildResult(status, invalidQaDispatchBlocked, repoRoot)
    assertExpected(result, status.projection)

    const runtimePath = join(outDir, 'delivery-runtime.json')
    const resultPath = join(outDir, 'poc-result.json')
    const expectedPath = join(outDir, 'expected.json')
    writeFileSync(runtimePath, `${JSON.stringify(status.projection, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(expectedPath, `${JSON.stringify({
      phases: PHASES,
      phase_states: ['completed', 'completed', 'completed', 'completed'],
      gate_states: ['rejected', 'consumed', 'consumed', 'consumed', 'accepted'],
      summary: { proposed: 5, accepted: 4, rejected: 1, escalated: 0, consumed: 3 },
      runtime_attention_count: 0,
      project_delivery_has_dispatch: false,
    }, null, 2)}\n`, { mode: 0o600 })

    const pulse = spawnSync(process.execPath, [
      PULSE,
      'once',
      repoRoot,
      '--delivery-runtime',
      runtimePath,
      '--time-zone',
      time_zone,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: isolatedHomeDir },
    })
    if (pulse.status !== 0) {
      throw Object.assign(new Error(`Pulse POC publication failed: ${pulse.stderr || pulse.stdout}`), {
        code: 'POC_PULSE_FAILED',
      })
    }

    return {
      out_dir: outDir,
      repo_root: repoRoot,
      store_dir: storeDir,
      runtime_path: runtimePath,
      result_path: resultPath,
      expected_path: expectedPath,
      pulse_json_path: join(repoRoot, '.tmux-teams', 'pulse.json'),
      pulse_html_path: join(repoRoot, '.tmux-teams', 'pulse.html'),
      loop_graph_path: join(repoRoot, '.tmux-teams', 'loop-graph.html'),
      result,
      projection: status.projection,
    }
  } finally {
    if (oldAcpCmd === undefined) delete process.env.ACP_CMD
    else process.env.ACP_CMD = oldAcpCmd
    if (oldMockEvidence === undefined) delete process.env.MOCK_EVIDENCE
    else process.env.MOCK_EVIDENCE = oldMockEvidence
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--out', '--acp-cmd', '--time-zone', '--timeout'].includes(key) || value === undefined) {
      throw Object.assign(new Error('usage: phase-gate-poc.mjs --out DIR --acp-cmd COMMAND [--time-zone ZONE] [--timeout SEC]'), {
        code: 'POC_USAGE',
      })
    }
    if (key === '--out') options.out_dir = value
    if (key === '--acp-cmd') options.acp_cmd = value
    if (key === '--time-zone') options.time_zone = value
    if (key === '--timeout') options.timeout_sec = Number(value)
    index += 1
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhaseGatePoc(parseArgs(process.argv.slice(2)))
    .then((output) => process.stdout.write(`${JSON.stringify({
      status: output.result.measurement.status,
      measurement_ready: output.result.measurement.measurement_ready,
      runtime_attention_count: output.result.measurement.runtime_attention_count,
      pulse_html_path: output.pulse_html_path,
      loop_graph_path: output.loop_graph_path,
      result_path: output.result_path,
    })}\n`))
    .catch((cause) => {
      process.stderr.write(`${JSON.stringify({
        error: cause.code ?? 'PHASE_GATE_POC_FAILED',
        message: cause.message,
      })}\n`)
      process.exitCode = 1
    })
}
