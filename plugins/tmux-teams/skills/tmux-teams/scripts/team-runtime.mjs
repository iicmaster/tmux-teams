// Dependency-free validator and projector for the optional team_runtime.v1
// controller evidence. Nothing in this module reads files or probes runtime;
// callers pass the serialized Team graph and Pulse snapshot explicitly.

import {
  graphAgentIds,
  isAcpAgentId,
  isTeamGraphDigest,
  isTeamGraphId,
  validateTeamGraph,
} from './team-graph-contract.mjs'

export const TEAM_RUNTIME_SCHEMA = 'tmux-teams.team-runtime'
export const TEAM_RUNTIME_SCHEMA_VERSION = 1
export const TEAM_RUNTIME_LIMITS = Object.freeze({
  agent_runs: 128,
  routing_decisions: 64,
  attempts: 256,
  evaluations: 256,
  handoffs: 32,
})

const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const ISO_RE = /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\.(?<fraction>[0-9]+))?(?<zone>Z|[+-][0-9]{2}:[0-9]{2})$/
const ROLES = new Set(['outer_controller', 'dispatcher', 'worker', 'evaluator'])
const RUN_STATES = new Set(['queued', 'active', 'completed', 'failed', 'cancelled'])
const ATTEMPT_STATES = new Set(['queued', 'active', 'completed', 'failed'])
const ROUTING_ROLES = new Set(['outer_controller', 'dispatcher'])
const ROUTING_SCOPES = new Set(['team_internal', 'outer'])
const ROUTING_KINDS = new Set(['start_team', 'enqueue', 'assign', 'requeue', 'accept_handoff', 'complete'])
const EVALUATION_VERDICTS = new Set(['accepted', 'rejected'])
const HANDOFF_STATES = new Set(['produced', 'consumed', 'completed'])
const CHECKPOINT_STATES = new Set(['fanout', 'evaluation', 'rework', 'handoff', 'completion'])
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled'])
const FUTURE_SKEW_MS = 120_000
const FORBIDDEN_KEYS = new Set([
  'prompt', 'prompt_text', 'outbox', 'outbox_text', 'pid', 'process_id', 'secret',
  'password', 'token', 'stdout', 'stderr', 'raw', 'content', 'output', 'locations',
  'absolute_path', 'file_path', 'filesystem_path',
])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isRuntimeId = (value) => typeof value === 'string' && RUNTIME_ID_RE.test(value)
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value)
const isDigest = (value) => typeof value === 'string' && DIGEST_RE.test(value)
const isNullable = (value, predicate) => value === null || predicate(value)
const finiteDuration = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

function result(reason, code = 'TEAM_RUNTIME_INPUT_INVALID') {
  return { ok: false, value: null, code, reason }
}

function exactKeys(value, required, optional = []) {
  if (!isObject(value)) return false
  const allowed = new Set([...required, ...optional])
  return Object.keys(value).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
}

function semanticIso(value) {
  if (typeof value !== 'string') return null
  const match = value.match(ISO_RE)
  if (!match) return null
  const year = Number(match.groups.year)
  const month = Number(match.groups.month)
  const day = Number(match.groups.day)
  const hour = Number(match.groups.hour)
  const minute = Number(match.groups.minute)
  const second = Number(match.groups.second)
  const zoneHour = match.groups.zone === 'Z' ? 0 : Number(match.groups.zone.slice(1, 3))
  const zoneMinute = match.groups.zone === 'Z' ? 0 : Number(match.groups.zone.slice(4, 6))
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 ||
      zoneHour > 23 || zoneMinute > 59) return null
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day > daysInMonth) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function noForbiddenMaterial(value, key = '') {
  if (key && FORBIDDEN_KEYS.has(key.toLowerCase())) return false
  if (typeof value === 'string') return !/^(?:\/|[A-Za-z]:[\\/])/.test(value)
  if (Array.isArray(value)) return value.every((item) => noForbiddenMaterial(item))
  if (!isObject(value)) return true
  return Object.entries(value).every(([childKey, child]) => noForbiddenMaterial(child, childKey))
}

function checkTimestamp(value, nullable = false) {
  return nullable ? value === null || semanticIso(value) !== null : semanticIso(value) !== null
}

function checkNullableDigest(value) { return value === null || isDigest(value) }
function checkNullableId(value) { return value === null || isRuntimeId(value) }
function checkNullableAgent(value) { return value === null || isAcpAgentId(value) }
function checkNullableTeam(value) { return value === null || isTeamGraphId(value) }
function checkNullableUuid(value) { return value === null || isUuid(value) }

function checkArray(value, limit, checker) {
  return Array.isArray(value) && value.length <= limit && value.every(checker)
}

function checkController(value) {
  return exactKeys(value, ['agent_id', 'agent_run_id']) &&
    isAcpAgentId(value.agent_id) && isRuntimeId(value.agent_run_id)
}

function checkCheckpoint(value) {
  if (!exactKeys(value, [], [
    'checkpoint_id', 'state', 'observed_at', 'active_agent_ids', 'project_complete',
    'bottleneck_agent_id',
  ])) return false
  if (Object.hasOwn(value, 'checkpoint_id') && !isRuntimeId(value.checkpoint_id)) return false
  if (Object.hasOwn(value, 'state') && !CHECKPOINT_STATES.has(value.state)) return false
  if (Object.hasOwn(value, 'observed_at') && !checkTimestamp(value.observed_at)) return false
  if (Object.hasOwn(value, 'active_agent_ids') &&
      !checkArray(value.active_agent_ids, 128, isAcpAgentId)) return false
  if (Object.hasOwn(value, 'project_complete') && typeof value.project_complete !== 'boolean') return false
  if (Object.hasOwn(value, 'bottleneck_agent_id') && !checkNullableAgent(value.bottleneck_agent_id)) return false
  return true
}

function checkAgentRun(value) {
  if (!exactKeys(value, [
    'agent_run_id', 'agent_id', 'agent_role', 'team_id', 'task_id', 'dispatch_id',
    'session_operation', 'requested_session_id', 'acp_session_id', 'state', 'queued_at',
    'started_at', 'completed_at', 'queue_wait_ms', 'service_ms', 'result_digest',
    'receipt_digest',
  ])) return false
  return isRuntimeId(value.agent_run_id) && isAcpAgentId(value.agent_id) && ROLES.has(value.agent_role) &&
    checkNullableTeam(value.team_id) && isRuntimeId(value.task_id) && isUuid(value.dispatch_id) &&
    ['new', 'load'].includes(value.session_operation) && checkNullableId(value.requested_session_id) &&
    isRuntimeId(value.acp_session_id) && RUN_STATES.has(value.state) && checkTimestamp(value.queued_at) &&
    checkTimestamp(value.started_at, true) && checkTimestamp(value.completed_at, true) &&
    (value.queue_wait_ms === null || finiteDuration(value.queue_wait_ms)) &&
    (value.service_ms === null || finiteDuration(value.service_ms)) &&
    checkNullableDigest(value.result_digest) && isDigest(value.receipt_digest)
}

function checkRoutingDecision(value) {
  if (!exactKeys(value, [
    'decision_id', 'agent_run_id', 'actor_id', 'actor_role', 'scope', 'team_id', 'work_item_id',
    'attempt_id', 'decision_kind', 'target_agent_id', 'source_task_id', 'source_dispatch_id',
    'source_result_digest', 'observed_at',
  ])) return false
  return isRuntimeId(value.decision_id) && isRuntimeId(value.agent_run_id) &&
    isAcpAgentId(value.actor_id) && ROUTING_ROLES.has(value.actor_role) &&
    ROUTING_SCOPES.has(value.scope) && checkNullableTeam(value.team_id) &&
    checkNullableId(value.work_item_id) && checkNullableId(value.attempt_id) &&
    ROUTING_KINDS.has(value.decision_kind) && checkNullableAgent(value.target_agent_id) &&
    isRuntimeId(value.source_task_id) && isUuid(value.source_dispatch_id) &&
    checkNullableDigest(value.source_result_digest) && checkTimestamp(value.observed_at)
}

function checkAttempt(value) {
  if (!exactKeys(value, [
    'attempt_id', 'parent_attempt_id', 'team_id', 'work_item_id', 'agent_id', 'agent_run_id',
    'task_id', 'dispatch_id', 'acp_session_id', 'resumed_session_id', 'state', 'queued_at',
    'started_at', 'completed_at', 'input_artifact_digest', 'output_artifact_digest', 'result_digest',
  ])) return false
  return isRuntimeId(value.attempt_id) && checkNullableId(value.parent_attempt_id) &&
    isTeamGraphId(value.team_id) && isRuntimeId(value.work_item_id) && isAcpAgentId(value.agent_id) &&
    isRuntimeId(value.agent_run_id) && isRuntimeId(value.task_id) && isUuid(value.dispatch_id) &&
    checkNullableId(value.acp_session_id) && checkNullableId(value.resumed_session_id) &&
    ATTEMPT_STATES.has(value.state) && checkTimestamp(value.queued_at) &&
    checkTimestamp(value.started_at, true) && checkTimestamp(value.completed_at, true) &&
    checkNullableDigest(value.input_artifact_digest) && checkNullableDigest(value.output_artifact_digest) &&
    checkNullableDigest(value.result_digest)
}

function checkCriterion(value) {
  return exactKeys(value, ['criterion_id', 'outcome', 'evidence_digest']) &&
    isRuntimeId(value.criterion_id) && ['pass', 'fail', 'unknown'].includes(value.outcome) &&
    checkNullableDigest(value.evidence_digest)
}

function checkDefect(value) {
  return exactKeys(value, ['defect_id', 'severity', 'evidence_digest']) &&
    isRuntimeId(value.defect_id) && ['info', 'warning', 'error'].includes(value.severity) &&
    checkNullableDigest(value.evidence_digest)
}

function checkEvaluation(value) {
  if (!exactKeys(value, [
    'evaluation_id', 'agent_run_id', 'team_id', 'evaluator_agent_id', 'evaluator_task_id',
    'evaluator_dispatch_id', 'round', 'work_item_id', 'attempt_id', 'verdict', 'criterion_results',
    'defects', 'return_dispatcher_agent_id', 'source_result_digest', 'observed_at',
  ])) return false
  return isRuntimeId(value.evaluation_id) && isRuntimeId(value.agent_run_id) &&
    isTeamGraphId(value.team_id) && isAcpAgentId(value.evaluator_agent_id) &&
    isRuntimeId(value.evaluator_task_id) && isUuid(value.evaluator_dispatch_id) &&
    Number.isSafeInteger(value.round) && value.round >= 1 && isRuntimeId(value.work_item_id) &&
    isRuntimeId(value.attempt_id) && EVALUATION_VERDICTS.has(value.verdict) &&
    checkArray(value.criterion_results, 64, checkCriterion) && checkArray(value.defects, 64, checkDefect) &&
    checkNullableAgent(value.return_dispatcher_agent_id) && isDigest(value.source_result_digest) &&
    checkTimestamp(value.observed_at)
}

function checkHandoff(value) {
  if (!exactKeys(value, [
    'handoff_id', 'producer_agent_run_id', 'consumer_agent_run_id', 'upstream_team_id',
    'upstream_evaluator_agent_id', 'upstream_evaluator_task_id', 'downstream_team_id',
    'downstream_dispatcher_agent_id', 'artifact_digest', 'consumed_artifact_digest',
    'produced_at', 'consumed_at', 'state',
  ])) return false
  return isRuntimeId(value.handoff_id) && isRuntimeId(value.producer_agent_run_id) &&
    checkNullableId(value.consumer_agent_run_id) && isTeamGraphId(value.upstream_team_id) &&
    isAcpAgentId(value.upstream_evaluator_agent_id) && isRuntimeId(value.upstream_evaluator_task_id) &&
    checkNullableTeam(value.downstream_team_id) && checkNullableAgent(value.downstream_dispatcher_agent_id) &&
    isDigest(value.artifact_digest) && checkNullableDigest(value.consumed_artifact_digest) &&
    checkTimestamp(value.produced_at) && checkTimestamp(value.consumed_at, true) &&
    HANDOFF_STATES.has(value.state)
}

function checkBottleneck(value) {
  if (!exactKeys(value, [
    'agent_id', 'team_id', 'work_item_id', 'attempt_id', 'kind', 'detected_at', 'queue_wait_ms',
    'service_ms', 'source_dispatch_id', 'basis', 'incorrect_stall',
  ])) return false
  return isAcpAgentId(value.agent_id) && isTeamGraphId(value.team_id) && isRuntimeId(value.work_item_id) &&
    isRuntimeId(value.attempt_id) && value.kind === 'active_tool_service' && checkTimestamp(value.detected_at) &&
    finiteDuration(value.queue_wait_ms) && finiteDuration(value.service_ms) && isUuid(value.source_dispatch_id) &&
    value.basis === 'active_tool_then_longest_service' && value.incorrect_stall === false
}

function checkMetrics(value) {
  if (!exactKeys(value, [
    'pm_routing_touches', 'cycle_time_ms', 'gross_cycle_time_ms', 'measurement_hold_ms',
    'fanout_makespan_ms', 'summed_worker_service_ms', 'rework_items_rerun', 'total_items',
    'unaffected_item_attempt_delta', 'bottleneck_detection_ms', 'incorrect_stall_count',
  ])) return false
  return Number.isSafeInteger(value.pm_routing_touches) && value.pm_routing_touches >= 0 &&
    (value.cycle_time_ms === null || finiteDuration(value.cycle_time_ms)) &&
    (value.gross_cycle_time_ms === null || finiteDuration(value.gross_cycle_time_ms)) &&
    finiteDuration(value.measurement_hold_ms) &&
    (value.fanout_makespan_ms === null || finiteDuration(value.fanout_makespan_ms)) &&
    finiteDuration(value.summed_worker_service_ms) && Number.isSafeInteger(value.rework_items_rerun) &&
    value.rework_items_rerun >= 0 && Number.isSafeInteger(value.total_items) && value.total_items >= 0 &&
    Number.isSafeInteger(value.unaffected_item_attempt_delta) && value.unaffected_item_attempt_delta >= 0 &&
    (value.bottleneck_detection_ms === null || finiteDuration(value.bottleneck_detection_ms)) &&
    Number.isSafeInteger(value.incorrect_stall_count) && value.incorrect_stall_count >= 0
}

function roleMap(graph) {
  const map = new Map()
  for (const team of graph.teams) {
    for (const agent of team.agents) map.set(agent.agent_id, { role: agent.role, team_id: team.team_id })
  }
  if (graph.outer_controller_id) map.set(graph.outer_controller_id, { role: 'outer_controller', team_id: null })
  return map
}

function validateRunTimes(run) {
  const queued = semanticIso(run.queued_at)
  const started = run.started_at === null ? null : semanticIso(run.started_at)
  const completed = run.completed_at === null ? null : semanticIso(run.completed_at)
  if (queued === null || run.started_at !== null && started === null ||
      run.completed_at !== null && completed === null) return false
  if (started !== null && started < queued) return false
  if (completed !== null && (started === null || completed < started)) return false
  if (run.state === 'queued' && (started !== null || completed !== null || run.queue_wait_ms !== null || run.service_ms !== null)) return false
  if (run.state === 'active' && (started === null || completed !== null || run.queue_wait_ms === null || run.service_ms !== null)) return false
  if (TERMINAL_RUN_STATES.has(run.state) &&
      (started === null || completed === null || run.queue_wait_ms === null || run.service_ms === null)) return false
  if (run.session_operation === 'new' && run.requested_session_id !== null) return false
  if (run.session_operation === 'load' && run.requested_session_id === null) return false
  if (run.queue_wait_ms !== null && started !== null &&
      Math.abs(run.queue_wait_ms - (started - queued)) > 1) return false
  if (run.service_ms !== null && completed !== null &&
      Math.abs(run.service_ms - (completed - started)) > 1) return false
  if (TERMINAL_RUN_STATES.has(run.state) && !isDigest(run.result_digest)) return false
  if (!TERMINAL_RUN_STATES.has(run.state) && run.result_digest !== null) return false
  return true
}

function currentPulseRun(snapshot, attempt) {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : []
  return runs.find((run) => run && run.agent_id === attempt.agent_id &&
    run.task_id === attempt.task_id && run.dispatch_id === attempt.dispatch_id &&
    run.liveness_evidence?.liveness_state === 'tool_running' &&
    Array.isArray(run.liveness_evidence.active_tools) && run.liveness_evidence.active_tools.length > 0) || null
}

function validateRelationships(value, graph, snapshot, nowMs) {
  const roles = roleMap(graph)
  const runs = new Map()
  const attempts = new Map()
  const dispatches = new Set()
  for (const run of value.agent_runs) {
    if (runs.has(run.agent_run_id) || dispatches.has(run.dispatch_id)) {
      return 'duplicate agent run or dispatch identity'
    }
    const ownership = roles.get(run.agent_id)
    if (!ownership || ownership.role !== run.agent_role || ownership.team_id !== run.team_id) {
      return 'agent run role/team does not match the Team graph'
    }
    if (!validateRunTimes(run)) return 'agent run timestamps or session lineage are invalid'
    runs.set(run.agent_run_id, run)
    dispatches.add(run.dispatch_id)
  }
  const controllerRun = runs.get(value.controller.agent_run_id)
  if (!controllerRun || controllerRun.agent_id !== value.controller.agent_id ||
      controllerRun.agent_role !== 'outer_controller') return 'controller run is not the configured outer controller'
  const expectedAgents = graph.teams.flatMap((team) => team.agents
    .filter((agent) => value.mode === 'team_loop' || agent.role !== 'dispatcher')
    .map((agent) => agent.agent_id))
  expectedAgents.push(graph.outer_controller_id)
  const expectedAgentSet = new Set(expectedAgents)
  const observedAgentSet = new Set([...runs.values()].map((run) => run.agent_id))
  if (expectedAgentSet.size !== observedAgentSet.size ||
      [...expectedAgentSet].some((agentId) => !observedAgentSet.has(agentId)) ||
      [...observedAgentSet].some((agentId) => !expectedAgentSet.has(agentId))) {
    return 'runtime agent coverage does not exactly match the configured dispatch set'
  }

  for (const attempt of value.attempts) {
    if (attempts.has(attempt.attempt_id)) return 'duplicate attempt id'
    const run = runs.get(attempt.agent_run_id)
    if (!run || run.agent_id !== attempt.agent_id || run.team_id !== attempt.team_id ||
        run.task_id !== attempt.task_id || run.dispatch_id !== attempt.dispatch_id ||
        (attempt.acp_session_id !== null && attempt.acp_session_id !== run.acp_session_id)) {
      return 'attempt does not bind to its agent run'
    }
    const queued = semanticIso(attempt.queued_at)
    const started = attempt.started_at === null ? null : semanticIso(attempt.started_at)
    const completed = attempt.completed_at === null ? null : semanticIso(attempt.completed_at)
    if (started !== null && started < queued || completed !== null && (started === null || completed < started)) {
      return 'attempt timestamps are not ordered'
    }
    attempts.set(attempt.attempt_id, attempt)
  }
  for (const attempt of value.attempts) {
    if (attempt.parent_attempt_id !== null) {
      const parent = attempts.get(attempt.parent_attempt_id)
      const parentRun = parent ? runs.get(parent.agent_run_id) : null
      const childRun = runs.get(attempt.agent_run_id)
      if (!parent || !parentRun || !childRun || parent.agent_id !== attempt.agent_id ||
          parent.team_id !== attempt.team_id || parent.work_item_id !== attempt.work_item_id ||
          parent.state === 'active' || attempt.resumed_session_id === null ||
          attempt.resumed_session_id !== parent.acp_session_id ||
          attempt.acp_session_id !== parent.acp_session_id ||
          childRun.acp_session_id !== parent.acp_session_id ||
          childRun.requested_session_id !== parent.acp_session_id ||
          parentRun.acp_session_id !== parent.acp_session_id) {
        return 'attempt resume lineage is invalid'
      }
    } else if (attempt.resumed_session_id !== null) return 'initial attempt cannot resume a session'
  }
  const uniqueRecordIds = (rows, field, label) => {
    const ids = rows.map((row) => row[field])
    return new Set(ids).size === ids.length ? null : `duplicate ${label} id`
  }
  for (const [rows, field, label] of [
    [value.routing_decisions, 'decision_id', 'routing decision'],
    [value.evaluations, 'evaluation_id', 'evaluation'],
    [value.handoffs, 'handoff_id', 'handoff'],
  ]) {
    const duplicate = uniqueRecordIds(rows, field, label)
    if (duplicate) return duplicate
  }
  for (const decision of value.routing_decisions) {
    const actorRun = runs.get(decision.agent_run_id)
    const ownership = roles.get(decision.actor_id)
    if (!actorRun || actorRun.agent_id !== decision.actor_id || actorRun.task_id !== decision.source_task_id ||
        actorRun.dispatch_id !== decision.source_dispatch_id || !ownership ||
        ownership.role !== decision.actor_role || !ROUTING_ROLES.has(decision.actor_role)) {
      return 'routing actor is not provenance-bound'
    }
    if (decision.scope === 'outer') {
      if (decision.actor_role !== 'outer_controller' || decision.team_id !== null) return 'outer routing scope is invalid'
    } else if (decision.team_id === null || decision.actor_role === 'dispatcher' && ownership.team_id !== decision.team_id ||
        decision.actor_role === 'outer_controller' && !graph.teams.some((team) => team.team_id === decision.team_id)) {
      return 'Team-internal routing scope is invalid'
    }
    if (decision.target_agent_id !== null && (!isAcpAgentId(decision.target_agent_id) ||
        !graph.teams.some((team) => team.team_id === decision.team_id &&
          team.agents.some((agent) => agent.agent_id === decision.target_agent_id)))) {
      return 'routing target is outside its Team'
    }
    if (decision.attempt_id !== null && !attempts.has(decision.attempt_id)) return 'routing attempt is unknown'
    if (decision.source_result_digest !== null && decision.source_result_digest !== actorRun.result_digest) {
      return 'routing result digest does not match actor run'
    }
    if (decision.decision_kind === 'complete' && decision.target_agent_id !== null) return 'complete routing has a target'
  }
  const pmRoutingTouches = value.routing_decisions.filter((decision) =>
    decision.actor_role === 'outer_controller' && decision.scope === 'team_internal').length
  if (value.mode === 'legacy' && pmRoutingTouches < 1) return 'legacy runtime lacks an outer-controller Team routing touch'
  if (value.mode === 'team_loop' && pmRoutingTouches !== 0) return 'team_loop runtime contains an outer-controller Team routing touch'
  if (value.metrics.pm_routing_touches !== pmRoutingTouches) return 'pm_routing_touches is not derived from routing decisions'
  for (const evaluation of value.evaluations) {
    const run = runs.get(evaluation.agent_run_id)
    const ownership = roles.get(evaluation.evaluator_agent_id)
    const attempt = attempts.get(evaluation.attempt_id)
    if (!run || run.agent_id !== evaluation.evaluator_agent_id || run.agent_role !== 'evaluator' ||
        run.team_id !== evaluation.team_id || run.task_id !== evaluation.evaluator_task_id ||
        run.dispatch_id !== evaluation.evaluator_dispatch_id || !ownership || ownership.role !== 'evaluator' ||
        !attempt || attempt.team_id !== evaluation.team_id || attempt.work_item_id !== evaluation.work_item_id) {
      return 'evaluation does not bind to its evaluator and attempt'
    }
    if (evaluation.source_result_digest !== run.result_digest) return 'evaluation result digest is not exact'
    const team = graph.teams.find((candidate) => candidate.team_id === evaluation.team_id)
    if (!team) return 'evaluation Team is unknown'
    if (evaluation.verdict === 'rejected' && evaluation.return_dispatcher_agent_id !== team.dispatcher_id) {
      return 'rejection must return to the same Team dispatcher'
    }
    if (evaluation.verdict === 'accepted' && evaluation.return_dispatcher_agent_id !== null) {
      return 'accepted evaluation cannot return to a dispatcher'
    }
  }
  for (const handoff of value.handoffs) {
    const producer = runs.get(handoff.producer_agent_run_id)
    const upstream = graph.teams.find((team) => team.team_id === handoff.upstream_team_id)
    if (!producer || producer.agent_id !== handoff.upstream_evaluator_agent_id ||
        producer.agent_role !== 'evaluator' || producer.team_id !== handoff.upstream_team_id ||
        producer.task_id !== handoff.upstream_evaluator_task_id || !upstream ||
        upstream.evaluator_id !== handoff.upstream_evaluator_agent_id) return 'handoff producer is not the Team evaluator'
    const downstream = handoff.downstream_team_id === null
      ? null : graph.teams.find((team) => team.team_id === handoff.downstream_team_id)
    if (handoff.downstream_team_id !== null && (!downstream ||
        handoff.downstream_dispatcher_agent_id !== downstream.dispatcher_id)) return 'handoff downstream endpoint is invalid'
    if (handoff.downstream_team_id === null && handoff.downstream_dispatcher_agent_id !== null) return 'completion handoff has a dispatcher'
    if (handoff.consumer_agent_run_id !== null) {
      const consumer = runs.get(handoff.consumer_agent_run_id)
      if (!consumer || consumer.agent_id !== handoff.downstream_dispatcher_agent_id ||
          consumer.team_id !== handoff.downstream_team_id || consumer.agent_role !== 'dispatcher') {
        return 'handoff consumer is not the downstream dispatcher'
      }
    }
    if (handoff.state === 'produced' && (handoff.downstream_team_id === null ||
        handoff.consumer_agent_run_id !== null || handoff.consumed_artifact_digest !== null ||
        handoff.consumed_at !== null)) {
      return 'produced handoff has consumer evidence'
    }
    if (handoff.state === 'consumed' && (handoff.downstream_team_id === null ||
        handoff.consumer_agent_run_id === null || handoff.consumed_at === null ||
        handoff.consumed_artifact_digest !== handoff.artifact_digest)) {
      return 'consumed handoff lacks exact downstream evidence'
    }
    if (handoff.state === 'completed' && (handoff.downstream_team_id !== null ||
        handoff.downstream_dispatcher_agent_id !== null || handoff.consumer_agent_run_id !== null ||
        handoff.consumed_artifact_digest !== null || handoff.consumed_at !== null)) {
      return 'completed handoff must terminate at Project Completion'
    }
  }
  if (value.bottleneck !== null) {
    const attempt = attempts.get(value.bottleneck.attempt_id)
    const agentRun = attempt ? runs.get(attempt.agent_run_id) : null
    if (!attempt || !agentRun || attempt.agent_id !== value.bottleneck.agent_id ||
        attempt.team_id !== value.bottleneck.team_id ||
        attempt.work_item_id !== value.bottleneck.work_item_id ||
        attempt.dispatch_id !== value.bottleneck.source_dispatch_id ||
        agentRun.agent_id !== attempt.agent_id || agentRun.task_id !== attempt.task_id ||
        agentRun.dispatch_id !== attempt.dispatch_id ||
        !currentPulseRun(snapshot, attempt)) return 'bottleneck lacks current tool_running Pulse evidence'
  }
  const generated = semanticIso(value.generated_at)
  const expires = semanticIso(value.expires_at)
  if (Number.isFinite(nowMs) && generated > nowMs + FUTURE_SKEW_MS) return 'runtime evidence is too far in the future'
  if (expires <= generated) return 'runtime expires_at is not after generated_at'
  if (Number.isFinite(nowMs) && expires <= nowMs) return 'runtime evidence is stale'
  return null
}

/** Validate the complete closed controller object and all graph joins. */
export function validateTeamRuntime(value, { teamGraph, snapshot = null, nowMs = Date.now() } = {}) {
  if (!isObject(value) || !exactKeys(value, [
    'schema', 'schema_version', 'trust_level', 'comparison_id', 'run_id', 'mode', 'generated_at',
    'expires_at', 'graph_source_digest', 'workload_digest', 'oracle_digest', 'event_log_digest',
    'execution_profile_digest', 'controller', 'checkpoint', 'agent_runs', 'routing_decisions',
    'attempts', 'evaluations', 'handoffs', 'bottleneck', 'metrics',
  ]) || value.schema !== TEAM_RUNTIME_SCHEMA || value.schema_version !== TEAM_RUNTIME_SCHEMA_VERSION ||
      value.trust_level !== 'advisory_same_uid' || !isRuntimeId(value.comparison_id) ||
      !isRuntimeId(value.run_id) || !['legacy', 'team_loop'].includes(value.mode) ||
      !checkTimestamp(value.generated_at) || !checkTimestamp(value.expires_at) ||
      !isTeamGraphDigest(value.graph_source_digest) || !isDigest(value.workload_digest) ||
      !isDigest(value.oracle_digest) || !isDigest(value.event_log_digest) ||
      !isDigest(value.execution_profile_digest) || !checkController(value.controller) ||
      !checkCheckpoint(value.checkpoint) || !checkArray(value.agent_runs, TEAM_RUNTIME_LIMITS.agent_runs, checkAgentRun) ||
      !checkArray(value.routing_decisions, TEAM_RUNTIME_LIMITS.routing_decisions, checkRoutingDecision) ||
      !checkArray(value.attempts, TEAM_RUNTIME_LIMITS.attempts, checkAttempt) ||
      !checkArray(value.evaluations, TEAM_RUNTIME_LIMITS.evaluations, checkEvaluation) ||
      !checkArray(value.handoffs, TEAM_RUNTIME_LIMITS.handoffs, checkHandoff) ||
      !(value.bottleneck === null || checkBottleneck(value.bottleneck)) || !checkMetrics(value.metrics) ||
      !noForbiddenMaterial(value)) {
    return result('runtime object is not a closed bounded team_runtime.v1 value')
  }
  const graphResult = validateTeamGraph(teamGraph)
  if (!graphResult.ok || !graphResult.value.outer_controller_id) {
    return result('team_runtime requires a valid graph with one outer_controller_id')
  }
  if (value.graph_source_digest !== graphResult.value.source_digest) {
    return result('runtime graph_source_digest does not match the configured Team graph')
  }
  if (value.controller.agent_id !== graphResult.value.outer_controller_id) {
    return result('controller.agent_id is not the configured outer controller')
  }
  const relationshipError = validateRelationships(value, graphResult.value, snapshot, nowMs)
  if (relationshipError === 'runtime evidence is stale') return result(relationshipError, 'TEAM_RUNTIME_STALE')
  if (relationshipError === 'runtime evidence is too far in the future') {
    return result(relationshipError, 'TEAM_RUNTIME_FUTURE')
  }
  if (relationshipError) return result(relationshipError)
  return { ok: true, value: structuredClone(value), code: null, reason: null }
}

export function projectTeamRuntime(input, options = {}) {
  if (input == null) return { projection: null, diagnostic: null }
  const checked = validateTeamRuntime(input, options)
  if (!checked.ok) {
    return {
      projection: null,
      diagnostic: {
        code: checked.code,
        severity: checked.code === 'TEAM_RUNTIME_STALE' ? 'warning' : 'error',
        source: 'team_runtime',
        count: 1,
      },
    }
  }
  return { projection: checked.value, diagnostic: null }
}

export function isProjectedTeamRuntime(value) {
  return isObject(value) && value.schema === TEAM_RUNTIME_SCHEMA && value.schema_version === 1
}
