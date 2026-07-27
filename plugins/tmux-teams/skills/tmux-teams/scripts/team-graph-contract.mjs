// Shared Team graph contract.
//
// The ACP adapter accepts agent IDs from this narrow domain. Keeping the
// grammar here prevents a renderer-only graph from advertising identities that
// a real dispatch cannot carry.

import { createHash } from 'node:crypto'

export const ACP_AGENT_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
export const TEAM_GRAPH_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
export const TEAM_GRAPH_DIGEST_RE = /^sha256:[0-9a-f]{64}$/
export const TEAM_GRAPH_NAME_RE = /^[^\u0000-\u001f\u007f]{1,160}$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export const isAcpAgentId = (value) =>
  typeof value === 'string' && ACP_AGENT_ID_RE.test(value)

export const isTeamGraphId = (value) =>
  typeof value === 'string' && TEAM_GRAPH_ID_RE.test(value)

export const isTeamGraphDigest = (value) =>
  typeof value === 'string' && TEAM_GRAPH_DIGEST_RE.test(value)

function canonicalTopology(graph) {
  return {
    project_id: graph.project_id,
    outer_controller_id: graph.outer_controller_id,
    teams: graph.teams.map((team) => ({
      team_id: team.team_id,
      name: team.name,
      dispatcher_id: team.dispatcher_id,
      worker_ids: [...team.worker_ids],
      evaluator_id: team.evaluator_id,
      downstream_team_id: team.downstream_team_id,
    })),
  }
}

/** Return the stable digest for a validated topology when no source claim exists. */
export function deriveTeamGraphDigest(graph) {
  if (!graph || !Array.isArray(graph.teams)) return null
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalTopology(graph))).digest('hex')}`
}

function graphInput(value) {
  if (!isObject(value)) return null
  const candidate = isObject(value.graph) ? value.graph : value
  return isObject(candidate.graph) ? candidate.graph : candidate
}

function invalid(reason) {
  return { ok: false, value: null, reason }
}

/**
 * Validate and normalize either a graph object or the Stage 2 `{ graph: ... }`
 * wrapper. This intentionally returns only the topology fields Pulse is
 * allowed to publish.
 */
export function validateTeamGraph(value, { sourceDigest = null } = {}) {
  const input = graphInput(value)
  if (!input || !Array.isArray(input.teams) || input.teams.length < 1 || input.teams.length > 100) {
    return invalid('Team graph must contain one to one hundred teams')
  }
  const projectId = input.project_id == null ? null : input.project_id
  if (projectId !== null && !isTeamGraphId(projectId)) return invalid('project_id is invalid')
  const outerControllerId = input.outer_controller_id == null ? null : input.outer_controller_id
  if (outerControllerId !== null && !isAcpAgentId(outerControllerId)) {
    return invalid('outer_controller_id is not an ACP agent id')
  }
  const seenTeams = new Set()
  const seenAgents = new Set()
  const teams = []
  for (const rawTeam of input.teams) {
    if (!isObject(rawTeam)) return invalid('Team entry is not an object')
    const teamId = rawTeam.team_id
    const dispatcherId = rawTeam.dispatcher_id
    const evaluatorId = rawTeam.evaluator_id
    const workerIds = rawTeam.worker_ids
    const name = rawTeam.name ?? rawTeam.team_name ?? rawTeam.label ?? teamId
    const downstream = rawTeam.downstream_team_id == null ? null : rawTeam.downstream_team_id
    if (!isTeamGraphId(teamId) || seenTeams.has(teamId) ||
        typeof name !== 'string' || !TEAM_GRAPH_NAME_RE.test(name) ||
        !isAcpAgentId(dispatcherId) || !isAcpAgentId(evaluatorId) ||
        !Array.isArray(workerIds) || workerIds.length < 1 || workerIds.length > 100 ||
        workerIds.some((agentId) => !isAcpAgentId(agentId)) ||
        new Set(workerIds).size !== workerIds.length ||
        (downstream !== null && (!isTeamGraphId(downstream) || downstream === teamId))) {
      return invalid(`Team ${String(teamId)} has invalid membership or topology`)
    }
    const roleAgents = [dispatcherId, ...workerIds, evaluatorId]
    const duplicateWithinTeam = roleAgents.find((agentId, index) => roleAgents.indexOf(agentId) !== index)
    if (duplicateWithinTeam || roleAgents.some((agentId) => seenAgents.has(agentId))) {
      return invalid(`agent_id ${duplicateWithinTeam || roleAgents.find((agentId) => seenAgents.has(agentId))} is assigned more than once`)
    }
    if (outerControllerId !== null && roleAgents.includes(outerControllerId)) {
      return invalid('outer_controller_id is also a Team agent')
    }
    seenTeams.add(teamId)
    roleAgents.forEach((agentId) => seenAgents.add(agentId))
    teams.push({
      team_id: teamId,
      name: name.trim(),
      dispatcher_id: dispatcherId,
      worker_ids: [...workerIds],
      evaluator_id: evaluatorId,
      downstream_team_id: downstream,
      agents: [
        { agent_id: dispatcherId, role: 'dispatcher' },
        ...workerIds.map((agentId) => ({ agent_id: agentId, role: 'worker' })),
        { agent_id: evaluatorId, role: 'evaluator' },
      ],
    })
  }
  const teamIds = new Set(teams.map((team) => team.team_id))
  if (teams.some((team) => team.downstream_team_id !== null &&
      !teamIds.has(team.downstream_team_id))) {
    return invalid('downstream_team_id does not resolve')
  }
  const sinks = teams.filter((team) => team.downstream_team_id === null)
  if (sinks.length !== 1) return invalid('Team graph must have exactly one sink')
  const teamById = new Map(teams.map((team) => [team.team_id, team]))
  for (const team of teams) {
    const visited = new Set()
    let cursor = team
    while (cursor.downstream_team_id !== null) {
      if (visited.has(cursor.team_id)) return invalid('Team graph contains a downstream cycle')
      visited.add(cursor.team_id)
      cursor = teamById.get(cursor.downstream_team_id)
      if (!cursor) return invalid('Team graph downstream chain is incomplete')
    }
    if (cursor.team_id !== sinks[0].team_id) return invalid('Team graph has more than one completion chain')
  }
  const normalized = {
    project_id: projectId,
    source_digest: null,
    outer_controller_id: outerControllerId,
    teams,
  }
  const digest = sourceDigest || input.source_digest || deriveTeamGraphDigest(normalized)
  if (digest !== null && !isTeamGraphDigest(digest)) return invalid('source_digest is invalid')
  return {
    ok: true,
    value: {
      project_id: projectId,
      source_digest: digest,
      outer_controller_id: outerControllerId,
      teams,
    },
    reason: null,
  }
}

export function graphAgentIds(graph) {
  if (!graph || !Array.isArray(graph.teams)) return new Set()
  return new Set([
    ...(graph.outer_controller_id ? [graph.outer_controller_id] : []),
    ...graph.teams.flatMap((team) => team.agents?.map((agent) => agent.agent_id) || [
      team.dispatcher_id, ...(team.worker_ids || []), team.evaluator_id,
    ]),
  ])
}
