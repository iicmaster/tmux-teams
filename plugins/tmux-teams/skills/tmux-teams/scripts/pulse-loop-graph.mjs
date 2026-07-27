// Pure operational agent-flow projection for Pulse.
//
// This module accepts only the serialized Pulse snapshot. Configuration is
// normalized into agent instances, runtime evidence enriches those instances,
// and stale evidence is kept in an audit list instead of the primary flow.

import { renderTopologyGraph } from './pulse-loop-graph-topology.mjs'
import { isAcpAgentId, validateTeamGraph } from './team-graph-contract.mjs'
import { isProjectedTeamRuntime, validateTeamRuntime } from './team-runtime.mjs'

const LIVE_RUN_STATES = new Set(['running', 'starting', 'orphan_running'])
const RECENT_RUN_STATES = new Set([...LIVE_RUN_STATES, 'died', 'unrecorded', 'unknown'])
const LIVENESS_STATES = new Set([
  'starting', 'awaiting_agent', 'active', 'tool_running', 'suspected_stalled',
  'cancelling', 'cancelled', 'stalled', 'failed', 'completed',
])

const STATUS_LABELS = Object.freeze({
  working: 'working',
  waiting: 'waiting',
  blocked: 'blocked',
  stalled: 'stalled',
  done: 'done',
  not_started: 'not started',
  unknown: 'unknown',
})

const ROLE_LABELS = Object.freeze({
  outer_controller: 'Project Control',
  dispatcher: 'Dispatcher',
  worker: 'Worker',
  evaluator: 'Integrator / evaluator',
  unassigned: 'Observed agent',
})

const safeText = (value, fallback = '') => {
  const text = String(value ?? '').trim()
  return text.length > 256 ? text.slice(0, 256) : text || fallback
}

const explicitAgentId = (value) => isAcpAgentId(value)
const graphAgentId = (value) => explicitAgentId(value) ? value : null

const validObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const parseTime = (value) => {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : -Infinity
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

function graphInput(snapshotOrGraph) {
  if (!validObject(snapshotOrGraph)) return null
  const candidate = Object.hasOwn(snapshotOrGraph, 'team_graph')
    ? snapshotOrGraph.team_graph
    : Object.hasOwn(snapshotOrGraph, 'graph')
      ? snapshotOrGraph.graph
      : snapshotOrGraph
  if (!validObject(candidate)) return null
  return validObject(candidate.graph) ? candidate.graph : candidate
}

/**
 * Normalize either a graph object or the Stage 2 `{ graph: ... }` wrapper.
 * Only fields needed by the flow are retained; arbitrary fixture metadata is
 * deliberately not allowed to become rendered UI.
 */
export function normalizeTeamGraph(snapshotOrGraph) {
  const input = graphInput(snapshotOrGraph)
  const checked = validateTeamGraph(input)
  return checked.ok ? checked.value : null
}

function livenessState(run) {
  const candidate = safeText(run?.liveness_evidence?.liveness_state)
  if (LIVENESS_STATES.has(candidate)) return candidate
  if (run?.signals?.liveness === 'alive') return 'active'
  if (run?.state === 'awaiting-verdict') return 'waiting'
  if (run?.state === 'running') return 'active'
  return 'unknown'
}

function evidenceKeys(evidence) {
  const agentId = explicitAgentId(evidence?.agent_id) ? evidence.agent_id : ''
  return agentId ? [agentId] : []
}

function evidenceIdentity(evidence, index = 0) {
  const dispatchId = safeText(evidence?.dispatch_id)
  if (dispatchId) return `dispatch:${dispatchId}`
  const taskId = safeText(evidence?.task_id)
  const startedAt = safeText(evidence?.started_at)
  if (taskId) return `attempt:${taskId}:${startedAt || 'unknown-start'}`
  return `row:${index}`
}

function isCurrentRun(run) {
  if (!validObject(run)) return false
  const evidenceState = run.liveness_evidence?.liveness_state
  if (['completed', 'cancelled', 'failed'].includes(evidenceState)) return false
  if (['done', 'blocked', 'failed'].includes(run.signals?.terminal)) return false
  if (['pass', 'reject', 'unresolved'].includes(run.signals?.pm_verdict)) return false
  if (['awaiting-verdict', 'unrecorded', 'died'].includes(run.state)) return false
  if (run.signals?.liveness === 'alive' || LIVE_RUN_STATES.has(run.state)) return true
  return run.state === 'unknown' || run.signals?.liveness === 'unknown'
}

function isObservedLive(run) {
  return validObject(run) && run.transport === 'acp' && (
    run.signals?.liveness === 'alive' || run.state === 'orphan_running'
  )
}

function candidateScore(evidence) {
  const state = livenessState(evidence)
  const statePriority = {
    tool_running: 8,
    active: 7,
    suspected_stalled: 6,
    stalled: 5,
    awaiting_agent: 4,
    starting: 4,
    cancelling: 3,
    cancelled: 2,
    failed: 2,
    completed: 2,
  }[state] || 0
  const livePriority = evidence.signals?.liveness === 'alive' ? 1 : 0
  return [
    statePriority,
    livePriority,
    parseTime(evidence.started_at),
    parseTime(evidence.liveness_evidence?.last_meaningful_progress_at),
  ]
}

function compareEvidence(left, right) {
  const leftScore = candidateScore(left)
  const rightScore = candidateScore(right)
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return rightScore[index] - leftScore[index]
  }
  return evidenceIdentity(left).localeCompare(evidenceIdentity(right), 'en')
}

function terminalStatus(evidence) {
  const liveState = evidence?.liveness_evidence?.liveness_state
  if (liveState === 'completed') return 'done'
  if (evidence?.pm_verdict === 'pass' || evidence?.signals?.pm_verdict === 'pass') return 'done'
  if (evidence?.pm_verdict === 'reject' || evidence?.signals?.pm_verdict === 'reject') return 'blocked'
  if (evidence?.signals?.terminal === 'blocked' || evidence?.signals?.terminal === 'failed') return 'blocked'
  if (['suspected_stalled', 'stalled', 'cancelled', 'failed'].includes(liveState)) return 'stalled'
  if (['active', 'tool_running'].includes(liveState)) return 'working'
  if (['starting', 'awaiting_agent', 'cancelling'].includes(liveState)) return 'waiting'
  if (evidence?.state === 'awaiting-verdict' || evidence?.pm_verdict === 'unresolved') return 'waiting'
  if (evidence?.state === 'unknown' || evidence?.state === 'unrecorded' || evidence?.signals?.liveness === 'unknown') return 'unknown'
  if (['running', 'starting'].includes(evidence?.state) || evidence?.signals?.liveness === 'alive') return 'working'
  if (evidence?.state === 'died') return 'stalled'
  return 'waiting'
}

function compactLivenessEvidence(evidence) {
  const raw = evidence?.liveness_evidence
  if (!validObject(raw)) return null
  const compactTool = (tool) => {
    if (!validObject(tool)) return null
    const result = {}
    for (const key of [
      'tool_call_id', 'title', 'kind', 'status', 'content_digest',
      'output_digest', 'locations_digest', 'updated_at', 'update_count',
    ]) {
      if (Object.hasOwn(tool, key) &&
          (typeof tool[key] === 'string' || tool[key] === null ||
            Number.isSafeInteger(tool[key]))) result[key] = tool[key]
    }
    return result.tool_call_id && result.title && result.kind && result.status
      ? result : null
  }
  const compactHistory = (entry) => {
    if (!validObject(entry)) return null
    const result = {}
    for (const key of [
      'state', 'observed_at', 'evidence', 'reason',
      'last_protocol_activity_at', 'last_meaningful_progress_at',
    ]) {
      if (Object.hasOwn(entry, key) && typeof entry[key] === 'string') result[key] = entry[key]
    }
    if (Array.isArray(entry.active_tools)) {
      result.active_tools = entry.active_tools.map(compactTool).filter(Boolean)
    }
    return result.state && result.observed_at && result.evidence ? result : null
  }
  const tools = validObject(raw.tools)
    ? Object.fromEntries(Object.entries(raw.tools).map(([toolId, tool]) => [toolId, compactTool(tool)]))
    : {}
  return {
    schema_version: safeText(raw.schema_version),
    task_id: safeText(raw.task_id),
    dispatch_id: safeText(raw.dispatch_id),
    agent_id: explicitAgentId(raw.agent_id) ? raw.agent_id : null,
    observed_at: safeText(raw.observed_at),
    liveness_state: safeText(raw.liveness_state, 'unknown'),
    last_protocol_activity_at: safeText(raw.last_protocol_activity_at),
    last_meaningful_progress_at: safeText(raw.last_meaningful_progress_at),
    termination_reason: raw.termination_reason == null ? null : safeText(raw.termination_reason),
    active_tools: Array.isArray(raw.active_tools) ? raw.active_tools.map(compactTool).filter(Boolean) : [],
    tools,
    stall_history: Array.isArray(raw.stall_history) ? raw.stall_history.map(compactHistory).filter(Boolean) : [],
  }
}

function chooseEvidence(agentId, runs, recent, excludedIdentities = new Set()) {
  const candidates = [
    ...runs.filter((run) => isCurrentRun(run) && !excludedIdentities.has(evidenceIdentity(run)) && evidenceKeys(run).includes(agentId)),
    ...recent.filter((record) => recentEvidence(record) && !excludedIdentities.has(evidenceIdentity(record)) && evidenceKeys(record).includes(agentId)),
  ].sort(compareEvidence)
  return candidates[0] || null
}

function runtimeForEvidence(evidence, runtime) {
  if (!runtime || !evidence || !evidence.agent_id || !evidence.task_id || !evidence.dispatch_id) return null
  const agentRun = runtime.agent_runs.find((candidate) =>
    candidate.agent_id === evidence.agent_id && candidate.task_id === evidence.task_id &&
    candidate.dispatch_id === evidence.dispatch_id)
  if (!agentRun) return null
  const attempt = runtime.attempts.find((candidate) => candidate.agent_run_id === agentRun.agent_run_id) || null
  const bottleneck = runtime.bottleneck && runtime.bottleneck.attempt_id === attempt?.attempt_id
  return {
    agent_run_id: agentRun.agent_run_id,
    state: agentRun.state,
    queue_wait_ms: agentRun.queue_wait_ms,
    service_ms: agentRun.service_ms,
    attempt_id: attempt?.attempt_id || null,
    bottleneck: Boolean(bottleneck),
  }
}

function nodeFromEvidence({ descriptor, evidence, configured, teamId, teamName, index, forceUnknown = false, runtime = null }) {
  const evidenceIsRun = Object.hasOwn(evidence || {}, 'signals')
  const status = evidence ? forceUnknown ? 'unknown' : terminalStatus(evidence) : 'not_started'
  const liveness = evidence ? forceUnknown ? 'unknown' : livenessState(evidence) : 'unknown'
  const livenessEvidence = compactLivenessEvidence(evidence)
  const stateGroup = status === 'stalled' ? 'blocked' : status
  const phase = evidence?.phase == null ? null : safeText(evidence.phase)
  const phaseSource = safeText(evidence?.phase_source, phase ? 'unknown' : 'unassigned')
  const runtimeFacts = runtimeForEvidence(evidence, runtime)
  return {
    agent_id: descriptor.agent_id,
    role: descriptor.role,
    role_label: ROLE_LABELS[descriptor.role] || ROLE_LABELS.unassigned,
    team_id: teamId,
    team_name: teamName,
    configured,
    observed: Boolean(evidence),
    source: evidenceIsRun ? 'runtime' : evidence ? 'recent_verdict' : 'configured',
    provider: safeText(evidence?.worker) || null,
    task_id: safeText(evidence?.task_id) || null,
    current_task: safeText(evidence?.task_id, 'not_started'),
    dispatch_id: safeText(evidence?.dispatch_id) || null,
    model: safeText(evidence?.model) || null,
    identity_conflict: Boolean(evidence?.identity_conflict),
    state: forceUnknown ? 'unknown' : safeText(evidence?.state, evidence ? status : 'not_started'),
    status,
    status_label: STATUS_LABELS[status],
    liveness_state: liveness,
    progress_evidence: {
      elapsed_sec: Number.isFinite(evidence?.elapsed_sec) ? evidence.elapsed_sec : null,
      silence_sec: Number.isFinite(evidence?.silence_sec) ? evidence.silence_sec : null,
      observed_at: livenessEvidence?.observed_at || null,
      last_protocol_activity_at: livenessEvidence?.last_protocol_activity_at || null,
      last_meaningful_progress_at: livenessEvidence?.last_meaningful_progress_at || null,
      active_tools: livenessEvidence?.active_tools || [],
    },
    liveness_evidence: livenessEvidence,
    phase,
    phase_source: phaseSource,
    phase_conflict: phaseSource === 'conflict',
    state_group: stateGroup || 'unknown',
    runtime: runtimeFacts,
    bottleneck: runtimeFacts?.bottleneck === true,
    queue_wait_ms: runtimeFacts?.queue_wait_ms ?? null,
    service_ms: runtimeFacts?.service_ms ?? null,
    attempt_id: runtimeFacts?.attempt_id || null,
    status_evidence: evidence
      ? evidenceIsRun
        ? `${forceUnknown ? 'identity=conflict · ' : ''}state=${safeText(evidence.state, 'unknown')} · liveness=${safeText(evidence.signals?.liveness, 'unknown')} · provider=${safeText(evidence.worker, 'unknown')}`
        : `recorded verdict=${safeText(evidence.pm_verdict, 'unknown')}`
      : 'no dispatch or liveness evidence',
    order: index,
  }
}

function buildEdgesForTeam(team, teamsById) {
  const edges = []
  if (team.dispatcher_id) {
    for (const workerId of team.worker_ids) {
      edges.push({
        kind: 'dispatch', from: team.dispatcher_id, to: workerId, label: 'dispatch', team_id: team.team_id,
      })
    }
  }
  if (team.evaluator_id) {
    for (const workerId of team.worker_ids) {
      edges.push({
        kind: 'collection', from: workerId, to: team.evaluator_id, label: 'collect', team_id: team.team_id,
      })
    }
    edges.push({
      kind: 'reject-loop', from: team.evaluator_id,
      to: team.dispatcher_id || `rework:${team.team_id}`,
      target: 'dispatcher', label: 'reject → re-dispatch', team_id: team.team_id,
    })
    const downstream = team.downstream_team_id && teamsById.get(team.downstream_team_id)
    edges.push({
      kind: 'pass-handoff',
      from: team.evaluator_id,
      to: downstream?.dispatcher_id || 'project-complete',
      target: downstream ? downstream.team_id : 'project-complete',
      label: downstream ? `pass → ${downstream.name} dispatcher` : 'pass → project complete',
      team_id: team.team_id,
    })
  }
  return edges
}

function runtimeEdgeFacts(edge, runtime) {
  if (!runtime) return null
  const decisions = runtime.routing_decisions || []
  const attempts = runtime.attempts || []
  const evaluations = runtime.evaluations || []
  const handoffs = runtime.handoffs || []
  if (edge.kind === 'dispatch') {
    const decision = decisions.find((item) => item.target_agent_id === edge.to &&
      item.actor_id === edge.from && ['enqueue', 'assign', 'requeue'].includes(item.decision_kind))
    return decision ? {
      runtime_state: decision.decision_kind,
      decision_id: decision.decision_id,
      attempt_id: decision.attempt_id,
      handoff_id: null,
    } : null
  }
  if (edge.kind === 'collection') {
    const evaluation = evaluations.find((item) => item.evaluator_agent_id === edge.to &&
      attempts.find((attempt) => attempt.attempt_id === item.attempt_id)?.agent_id === edge.from)
    return evaluation ? {
      runtime_state: evaluation.verdict,
      decision_id: null,
      attempt_id: evaluation.attempt_id,
      handoff_id: null,
      evaluation_id: evaluation.evaluation_id,
    } : null
  }
  if (edge.kind === 'reject-loop') {
    const evaluation = evaluations.find((item) => item.team_id === edge.team_id &&
      item.evaluator_agent_id === edge.from && item.verdict === 'rejected' &&
      item.return_dispatcher_agent_id === edge.to)
    if (!evaluation) return null
    const decision = decisions.find((item) => item.decision_kind === 'requeue' &&
      item.team_id === edge.team_id && item.attempt_id === evaluation.attempt_id &&
      item.target_agent_id === edge.to)
    return {
      runtime_state: 'rejected', decision_id: decision?.decision_id || null,
      attempt_id: evaluation.attempt_id, handoff_id: null, evaluation_id: evaluation.evaluation_id,
    }
  }
  if (edge.kind === 'pass-handoff') {
    const handoff = handoffs.find((item) => item.upstream_team_id === edge.team_id &&
      item.upstream_evaluator_agent_id === edge.from &&
      (item.downstream_dispatcher_agent_id || 'project-complete') === edge.to)
    if (!handoff) return null
    const evaluation = evaluations.find((item) => item.team_id === edge.team_id &&
      item.evaluator_agent_id === edge.from && item.verdict === 'accepted')
    const decision = decisions.find((item) => item.decision_kind === 'accept_handoff' &&
      item.team_id === edge.team_id)
    return {
      runtime_state: handoff.state, decision_id: decision?.decision_id || null,
      attempt_id: evaluation?.attempt_id || null, handoff_id: handoff.handoff_id,
    }
  }
  return null
}

function decorateEdges(edges, runtime) {
  return edges.map((edge) => ({ ...edge, runtime: runtimeEdgeFacts(edge, runtime) }))
}

function counts(nodes) {
  const result = {
    total: nodes.length,
    working: 0,
    waiting: 0,
    blocked: 0,
    stalled: 0,
    blocked_stalled: 0,
    done: 0,
    not_started: 0,
    unknown: 0,
  }
  for (const node of nodes) {
    if (Object.hasOwn(result, node.status)) result[node.status] += 1
    if (node.status === 'blocked' || node.status === 'stalled') result.blocked_stalled += 1
  }
  return result
}

function auditEntry(evidence, reason) {
  const livenessEvidence = compactLivenessEvidence(evidence)
  return {
    task_id: safeText(evidence?.task_id, 'unknown-task'),
    agent_id: safeText(evidence?.agent_id, evidenceIdentity(evidence)),
    dispatch_id: safeText(evidence?.dispatch_id) || null,
    state: safeText(livenessEvidence?.liveness_state,
      safeText(evidence?.state, safeText(evidence?.pm_verdict, 'unknown'))),
    termination_reason: livenessEvidence?.termination_reason || null,
    observed_at: livenessEvidence?.observed_at || null,
    stall_history: livenessEvidence?.stall_history || [],
    reason,
  }
}

function observedAgentId(evidence, index = 0, conflictingDispatches = new Set()) {
  const identity = evidenceIdentity(evidence, index)
  const dispatch = safeText(evidence?.dispatch_id)
  if (conflictingDispatches.has(identity)) {
    return dispatch ? `conflict_${dispatch}` : `conflict_unassigned_${index + 1}`
  }
  const explicit = safeText(evidence?.agent_id)
  if (explicit && explicitAgentId(explicit)) return explicit
  if (dispatch) return `observed_${dispatch}`
  return `observed_unassigned_${index + 1}`
}

function conflictingDispatches(evidence) {
  const byDispatch = new Map()
  const explicitConflicts = new Set()
  for (const item of evidence) {
    const dispatch = safeText(item?.dispatch_id)
    if (!dispatch) continue
    const values = byDispatch.get(dispatch) || new Set()
    const agentId = safeText(item?.agent_id)
    if (agentId) values.add(agentId)
    if (item?.identity_conflict === true) explicitConflicts.add(`dispatch:${dispatch}`)
    byDispatch.set(dispatch, values)
  }
  return new Set([...explicitConflicts, ...[...byDispatch.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([dispatch]) => `dispatch:${dispatch}`)])
}

function uniqueNodeAgentId(baseId, nodes, index = 0) {
  const base = explicitAgentId(baseId) ? baseId : `observed_unassigned_${index + 1}`
  if (!nodes.some((node) => node.agent_id === base)) return base
  let suffix = 2
  while (nodes.some((node) => node.agent_id === `${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

function recentEvidence(evidence) {
  return validObject(evidence)
}

function runtimeHandoffEvidence(runtime) {
  if (!runtime) return []
  return runtime.handoffs.map((handoff) => ({
    handoff_id: handoff.handoff_id,
    downstream_team_id: handoff.downstream_team_id,
    downstream_dispatcher_agent_id: handoff.downstream_dispatcher_agent_id,
    state: handoff.state,
    artifact_digest: handoff.artifact_digest,
  }))
}

/** Build the complete normalized model used by the static flowchart. */
export function buildAgentGraphModel(snapshot = {}) {
  const configured = normalizeTeamGraph(snapshot)
  const graphCandidate = graphInput(snapshot)
  const graphWasRequested = validObject(graphCandidate) && Array.isArray(graphCandidate.teams)
  const configurationError = graphWasRequested && !configured
    ? 'invalid Team graph; membership is not inferred' : null
  const serializedRuntime = isProjectedTeamRuntime(snapshot?.team_runtime) && configured
    ? validateTeamRuntime(snapshot.team_runtime, {
        teamGraph: configured,
        snapshot,
        nowMs: parseTime(snapshot?.generated_at),
      })
    : { ok: false, value: null, reason: null }
  const runtime = serializedRuntime.ok ? serializedRuntime.value : null
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : []
  const recent = Array.isArray(snapshot?.recent_verdicts) ? snapshot.recent_verdicts : []
  const historicalRuns = Array.isArray(snapshot?.history?.runs) ? snapshot.history.runs : []
  const nodes = []
  const lanes = []
  const audit = []
  const auditKeys = new Set()
  const recordAudit = (evidence, reason, index = 0) => {
    const key = evidenceIdentity(evidence, index)
    if (auditKeys.has(key)) return
    auditKeys.add(key)
    audit.push(auditEntry(evidence, reason))
  }
  const matchedEvidence = new Set()
  const currentRuns = runs.filter(isCurrentRun)
  const currentEvidence = [...currentRuns]
  const identityConflicts = conflictingDispatches(currentEvidence)

  if (configured) {
    const teamsById = new Map(configured.teams.map((team) => [team.team_id, team]))
    if (configured.outer_controller_id) {
      const descriptor = { agent_id: configured.outer_controller_id, role: 'outer_controller' }
      const matching = currentEvidence.filter((evidence) =>
        !identityConflicts.has(evidenceIdentity(evidence)) && evidenceKeys(evidence).includes(descriptor.agent_id))
      const evidence = chooseEvidence(descriptor.agent_id, currentRuns, [], identityConflicts)
      for (const matched of matching) matchedEvidence.add(evidenceIdentity(matched))
      for (const superseded of matching) {
        if (evidenceIdentity(superseded) !== evidenceIdentity(evidence)) {
          recordAudit(superseded, `superseded evidence for configured agent ${descriptor.agent_id}`)
        }
      }
      const node = nodeFromEvidence({
        descriptor, evidence, configured: true, teamId: 'project-control', teamName: 'Project Control',
        index: 0, runtime,
      })
      nodes.push(node)
      lanes.push({
        team_id: 'project-control', name: 'Project Control', configured: false,
        project_control: true, downstream_team_id: null, nodes: [node], edges: [],
      })
    }
    for (const [teamIndex, team] of configured.teams.entries()) {
      const teamNodes = []
      for (const [agentIndex, descriptor] of team.agents.entries()) {
        const matching = currentEvidence.filter((evidence) =>
          !identityConflicts.has(evidenceIdentity(evidence)) &&
          evidenceKeys(evidence).includes(descriptor.agent_id))
        const evidence = chooseEvidence(descriptor.agent_id, currentRuns, [], identityConflicts)
        for (const matched of matching) matchedEvidence.add(evidenceIdentity(matched))
        for (const superseded of matching) {
          if (evidenceIdentity(superseded) !== evidenceIdentity(evidence)) {
            recordAudit(superseded, `superseded evidence for configured agent ${descriptor.agent_id}`)
          }
        }
        const node = nodeFromEvidence({
          descriptor, evidence, configured: true,
          teamId: team.team_id, teamName: team.name,
          index: teamIndex * 100 + agentIndex + (configured.outer_controller_id ? 1 : 0),
          runtime,
        })
        teamNodes.push(node)
        nodes.push(node)
      }
      lanes.push({
        team_id: team.team_id,
        name: team.name,
        configured: true,
        downstream_team_id: team.downstream_team_id,
        nodes: teamNodes,
        edges: decorateEdges(buildEdgesForTeam(team, teamsById), runtime),
      })
    }

    const unmatchedLive = currentRuns.filter((run) => !matchedEvidence.has(evidenceIdentity(run)))
    const unmatchedByAgent = new Map()
    for (const [index, evidence] of unmatchedLive.entries()) {
      const agentId = observedAgentId(evidence, index, identityConflicts)
      const group = unmatchedByAgent.get(agentId) || { agent_id: agentId, evidence: null, all: [] }
      group.all.push(evidence)
      if (!group.evidence || compareEvidence(evidence, group.evidence) < 0) group.evidence = evidence
      unmatchedByAgent.set(agentId, group)
      matchedEvidence.add(evidenceIdentity(evidence))
    }
    const unmatchedNodes = []
    for (const [index, group] of [...unmatchedByAgent.values()].entries()) {
      const nodeAgentId = uniqueNodeAgentId(group.agent_id, nodes, index)
      const identityConflict = identityConflicts.has(evidenceIdentity(group.evidence))
      const node = nodeFromEvidence({
        descriptor: { agent_id: nodeAgentId, role: 'unassigned' },
        evidence: group.evidence,
        configured: false,
        teamId: 'unassigned',
        teamName: 'Control / Unassigned',
        index: configured.teams.length * 100 + index,
        forceUnknown: identityConflict,
        runtime,
      })
      unmatchedNodes.push(node)
      nodes.push(node)
      for (const evidence of group.all) {
        if (evidenceIdentity(evidence) !== evidenceIdentity(group.evidence)) {
          recordAudit(evidence, `additional evidence for observed dispatch ${group.agent_id}`)
        }
      }
    }
    if (unmatchedNodes.length) {
      lanes.push({
        team_id: 'unassigned', name: 'Control / Unassigned', configured: false,
        downstream_team_id: null, nodes: unmatchedNodes, edges: [],
      })
    }
    for (const evidence of [...runs.filter((run) => !isCurrentRun(run)), ...historicalRuns, ...recent]) {
      if (matchedEvidence.has(evidenceIdentity(evidence))) continue
      recordAudit(evidence, 'historical evidence')
    }
  } else {
    const candidates = []
    for (const [index, evidence] of runs.entries()) {
      if (evidence.transport !== 'acp' || !isCurrentRun(evidence)) {
        if (!isCurrentRun(evidence)) recordAudit(evidence, 'historical evidence', index)
        continue
      }
      candidates.push({ evidence, index })
    }
    const byAgent = new Map()
    const seenEvidence = new Set()
    for (const candidate of candidates) {
      const identity = evidenceIdentity(candidate.evidence, candidate.index)
      if (seenEvidence.has(identity)) continue
      seenEvidence.add(identity)
      const agentId = observedAgentId(candidate.evidence, candidate.index, identityConflicts)
      const group = byAgent.get(agentId) || { agent_id: agentId, evidence: null, all: [] }
      group.all.push(candidate.evidence)
      if (!group.evidence || compareEvidence(candidate.evidence, group.evidence) < 0) {
        group.evidence = candidate.evidence
      }
      byAgent.set(agentId, group)
    }
    const controlNodes = []
    for (const [index, group] of [...byAgent.values()].entries()) {
      const identityConflict = identityConflicts.has(evidenceIdentity(group.evidence))
      const node = nodeFromEvidence({
        descriptor: { agent_id: group.agent_id, role: 'unassigned' }, evidence: group.evidence,
        configured: false, teamId: 'unassigned', teamName: 'Control / Unassigned', index,
        forceUnknown: identityConflict,
        runtime,
      })
      controlNodes.push(node)
      nodes.push(node)
      for (const evidence of group.all) {
        if (evidenceIdentity(evidence) !== evidenceIdentity(group.evidence)) {
          recordAudit(evidence, `additional evidence for observed agent ${group.agent_id}`)
        }
      }
    }
    lanes.push({
      team_id: 'unassigned', name: 'Control / Unassigned', configured: false,
      downstream_team_id: null, nodes: controlNodes, edges: [],
    })
    for (const evidence of [...historicalRuns, ...recent]) recordAudit(evidence, 'historical evidence')
  }

  const model = {
    project_id: configured?.project_id || snapshot?.scope?.repo_name || null,
    configured: Boolean(configured),
    configuration_error: configurationError,
    source_digest: configured?.source_digest || null,
    handoffs: runtimeHandoffEvidence(runtime),
    runtime,
    lanes,
    nodes,
    edges: lanes.flatMap((lane) => lane.edges),
    project_completion_endpoint: {
      endpoint_id: 'project-complete', type: 'project-completion', label: 'Project complete',
    },
    counts: counts(nodes),
    audit: audit.slice(0, 100),
    audit_total: Math.max(
      audit.length,
      Number.isSafeInteger(snapshot?.history?.total) ? snapshot.history.total : audit.length,
    ),
    diagnostics: [
      ...(Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : []),
      ...(configurationError ? [{
        code: 'TEAM_GRAPH_INPUT_INVALID', severity: 'error', source: 'publisher', count: 1,
      }] : []),
      ...(identityConflicts.size ? [{
        code: 'AGENT_ID_CONFLICT', severity: 'error', source: 'publisher', count: identityConflicts.size,
      }] : []),
    ],
  }
  return model
}

/** Backwards-compatible name for callers that only need the rendered nodes. */
export function buildLoopGraphNodes(snapshot) {
  return buildAgentGraphModel(snapshot).nodes
}

/** The new layout is normal document flow; retain this helper as a model alias. */
export function layoutLoopGraph(snapshot) {
  if (Array.isArray(snapshot)) {
    const nodes = snapshot
    return { nodes, lanes: [], edges: [], counts: counts(nodes), audit: [], handoffs: [] }
  }
  return buildAgentGraphModel(snapshot)
}

/** Runtime gate data is not part of the agent-instance flow contract. */
export function buildOperationalEdges() {
  return []
}

export function renderPulseLoopGraph(snapshot, options = {}) {
  const model = buildAgentGraphModel(snapshot)
  return renderTopologyGraph(snapshot, model, options)
}

export { STATUS_LABELS, esc }
