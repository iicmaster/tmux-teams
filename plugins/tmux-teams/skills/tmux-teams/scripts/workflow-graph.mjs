// workflow-graph.mjs — the Team pool and the Workflows routed over it.
//
// Teams are a resource: a dispatcher that owns a queue, one or more workers,
// and the team's own evaluator. A Workflow is a route through those teams, and
// the same team can appear in as many Workflows as you like. Routing therefore
// lives on the Workflow, never inside the Team — that separation is the whole
// point: new Workflows are composed from teams that already exist.
//
// Quality is checked twice. Inside a team the evaluator rejects back into its
// own dispatcher. Between teams the receiving dispatcher can refuse the handoff,
// which returns the work to the sending team. Both are edges the page draws only
// once a verdict records them.
//
// A route never revisits a team it has already passed. Work goes back only by
// being rejected, never by being routed backwards.
//
// Two rules decided 2026-07-28 and enforced here:
//
//  - `wip_limit` is not declarable. It always equals the worker count. A worker
//    may spawn its own sub-agents, so parallelism happens inside a worker; a
//    second number allowed to disagree with the first is a defect waiting to
//    happen. A graph that still declares the matching number keeps loading; one
//    that declares a different number is rejected rather than quietly overruled.
//  - Every role of every team names its model, and so does the outer
//    controller. Only the SHAPE of that name is checked. This project has been
//    burned by hardcoded model assumptions: the adapter is the only authority
//    on what a model name may say, so no list of known models lives here.
import { createHash } from 'node:crypto'

export const AGENT_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
export const GRAPH_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const NAME_RE = /^[^\u0000-\u001F\u007F]{1,160}$/

const MODEL_MAX = 128

const hasControlChar = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// Shape only, and deliberately nothing more: non-empty, at most 128 characters,
// no control characters. A control character would smuggle terminal escapes
// into a brief and into the page; the length is a sanity bound. The VALUE is
// never checked against a list of known models — the adapter owns that.
const isModelName = (value) =>
  typeof value === 'string' && value.length >= 1 && value.length <= MODEL_MAX && !hasControlChar(value)

const MAX_TEAMS = 100
const MAX_WORKERS = 100
const MAX_WORKFLOWS = 50
const TEAM_MODEL_ROLES = ['dispatcher', 'worker', 'evaluator']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (reason) => ({ ok: false, value: null, reason })
// Quoted when it is a string, so a declared "2" is visibly not the number 2.
// String() rather than interpolation: interpolating a symbol throws.
const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

// The bundled template has to be a valid graph, so it names a model everywhere
// one is required. Naming a real model here would silently run every fresh
// install on somebody else's model choice, so it names none: a real install
// replaces each of these through the setup skill.
const TEMPLATE_MODEL = 'inherit-account-default'

const team = (id, name) => ({
  team_id: id,
  name,
  dispatcher_id: `${id}_dispatcher`,
  worker_ids: [`${id}_worker_1`, `${id}_worker_2`],
  evaluator_id: `${id}_evaluator`,
  models: { dispatcher: TEMPLATE_MODEL, worker: TEMPLATE_MODEL, evaluator: TEMPLATE_MODEL },
})

// Shipped so a fresh install has a real shape to edit rather than a blank file.
// Four teams, one straight route — the shape most repos start from.
export const DEFAULT_WORKFLOW_GRAPH = Object.freeze({
  project_id: 'default_four_team_loop',
  outer_controller_id: 'pm_outer_loop',
  outer_controller_model: TEMPLATE_MODEL,
  teams: [team('requirement', 'Requirement'), team('prototype', 'Prototype'),
    team('development', 'Development'), team('qa', 'QA')],
  workflows: [{
    workflow_id: 'default',
    name: 'Default delivery',
    route: ['requirement', 'prototype', 'development', 'qa'],
  }],
})

export const WORKFLOW_GRAPH_FILE = 'graph.json'
// The name this file carried until 2026-07-29. It is still read, and that is
// not politeness: a missing declaration falls back to the bundled template, so
// a bare rename would leave every existing repo drawing a four-team default
// that looks entirely normal while its real teams silently vanished. A reader
// cannot tell those two states apart, which is what makes the quiet path the
// dangerous one. `readWorkflowGraph` reports the legacy name in `source` so the
// page can say out loud which file it answered from.
export const LEGACY_WORKFLOW_GRAPH_FILE = 'team-graph.json'

export function deriveWorkflowGraphDigest(graph) {
  return `sha256:${createHash('sha256').update(JSON.stringify(graph)).digest('hex')}`
}

export function validateWorkflowGraph(value) {
  if (!isObject(value)) return invalid('graph must be an object')
  if (Array.isArray(value.teams) && value.teams.some((entry) => isObject(entry) && 'downstream_team_id' in entry)) {
    return invalid('downstream_team_id belongs to a workflow route, not to a team — move routing into workflows[]')
  }
  if (!Array.isArray(value.teams) || value.teams.length < 1 || value.teams.length > MAX_TEAMS) {
    return invalid(`teams must be an array of 1 to ${MAX_TEAMS} entries`)
  }
  if (!Array.isArray(value.workflows) || value.workflows.length < 1 || value.workflows.length > MAX_WORKFLOWS) {
    return invalid(`workflows must be an array of 1 to ${MAX_WORKFLOWS} entries`)
  }

  const projectId = value.project_id == null ? null : value.project_id
  if (projectId !== null && !GRAPH_ID_RE.test(String(projectId))) return invalid('project_id is invalid')
  const controller = value.outer_controller_id == null ? null : value.outer_controller_id
  if (controller !== null && !AGENT_ID_RE.test(String(controller))) {
    return invalid('outer_controller_id is not an agent id')
  }
  // The controller runs on a model like everyone else, so it declares one. A
  // graph that names no controller has no seat for a model to belong to, so
  // nothing is required and nothing is carried forward.
  const controllerModel = controller === null ? null : value.outer_controller_model
  if (controller !== null && (controllerModel == null || controllerModel === '')) {
    return invalid('the outer controller is missing a model — outer_controller_model is required')
  }
  if (controller !== null && !isModelName(controllerModel)) {
    return invalid(`the outer controller has an invalid model — a model is 1 to ${MODEL_MAX} characters with no control characters`)
  }

  const seenTeams = new Set()
  const seenAgents = new Set(controller === null ? [] : [controller])
  const teams = []
  for (const raw of value.teams) {
    if (!isObject(raw)) return invalid('team entry is not an object')
    const { team_id: teamId, dispatcher_id: dispatcher, evaluator_id: evaluator, worker_ids: workers } = raw
    const name = raw.name ?? teamId
    if (typeof teamId !== 'string' || !GRAPH_ID_RE.test(teamId) || seenTeams.has(teamId)) {
      return invalid(`team_id ${String(teamId)} is invalid or duplicated`)
    }
    if (typeof name !== 'string' || !NAME_RE.test(name)) return invalid(`team ${teamId} has an invalid name`)
    if (typeof dispatcher !== 'string' || !AGENT_ID_RE.test(dispatcher)) return invalid(`team ${teamId} has no valid dispatcher_id`)
    if (typeof evaluator !== 'string' || !AGENT_ID_RE.test(evaluator)) return invalid(`team ${teamId} has no valid evaluator_id`)
    if (!Array.isArray(workers) || workers.length < 1 || workers.length > MAX_WORKERS ||
        workers.some((agentId) => typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId))) {
      return invalid(`team ${teamId} needs 1 to ${MAX_WORKERS} valid worker_ids`)
    }
    // A team pulls work only while it is under its WIP limit; without a ceiling
    // there is no pull signal and no way to see a queue backing up. That
    // ceiling IS the worker count — it is derived here, never declared. An
    // older graph that still states the same number keeps loading; one that
    // states a different number is refused, because silently overruling it
    // would make the board enforce a limit nobody wrote down.
    const wipLimit = workers.length
    if (raw.wip_limit != null && raw.wip_limit !== wipLimit) {
      return invalid(`team ${teamId} declares wip_limit ${show(raw.wip_limit)} but has ${wipLimit} worker(s) — wip_limit is no longer declared, it always equals the worker count`)
    }
    // Every seat names the model it runs on. Missing is fatal: a dispatch with
    // no model named is a dispatch onto whatever the account happens to default
    // to, which is the guess this graph exists to stop.
    const models = raw.models
    if (!isObject(models)) {
      return invalid(`team ${teamId} declares no models — its dispatcher, worker and evaluator each name their own model`)
    }
    for (const role of TEAM_MODEL_ROLES) {
      const model = models[role]
      if (model == null || model === '') return invalid(`team ${teamId} is missing a model for its ${role}`)
      if (!isModelName(model)) {
        return invalid(`team ${teamId} has an invalid model for its ${role} — a model is 1 to ${MODEL_MAX} characters with no control characters`)
      }
    }
    // One agent, one seat. A shared id would make two nodes light up from one
    // dispatch, which is exactly the false positive the page must never show.
    const members = [dispatcher, ...workers, evaluator]
    for (const agentId of members) {
      if (seenAgents.has(agentId)) return invalid(`agent_id ${agentId} is assigned more than once`)
      seenAgents.add(agentId)
    }
    seenTeams.add(teamId)
    teams.push({
      team_id: teamId,
      name: name.trim(),
      dispatcher_id: dispatcher,
      worker_ids: [...workers],
      evaluator_id: evaluator,
      wip_limit: wipLimit,
      models: { dispatcher: models.dispatcher, worker: models.worker, evaluator: models.evaluator },
      // The declared model travels with each agent so a reader never has to
      // pair a role back to the team's models block by hand. It stays a
      // DECLARATION: the model a node reports as running is verified evidence
      // and is a different fact from this one.
      agents: [
        { agent_id: dispatcher, role: 'dispatcher', model: models.dispatcher },
        ...workers.map((agentId) => ({ agent_id: agentId, role: 'worker', model: models.worker })),
        { agent_id: evaluator, role: 'evaluator', model: models.evaluator },
      ],
    })
  }

  const seenWorkflows = new Set()
  const workflows = []
  for (const raw of value.workflows) {
    if (!isObject(raw)) return invalid('workflow entry is not an object')
    const { workflow_id: workflowId, route } = raw
    const name = raw.name ?? workflowId
    if (typeof workflowId !== 'string' || !GRAPH_ID_RE.test(workflowId) || seenWorkflows.has(workflowId)) {
      return invalid(`workflow_id ${String(workflowId)} is invalid or duplicated`)
    }
    if (typeof name !== 'string' || !NAME_RE.test(name)) return invalid(`workflow ${workflowId} has an invalid name`)
    if (!Array.isArray(route) || route.length < 1 || route.length > MAX_TEAMS) {
      return invalid(`workflow ${workflowId} needs a route of 1 to ${MAX_TEAMS} teams`)
    }
    const visited = new Set()
    for (const teamId of route) {
      if (!seenTeams.has(teamId)) return invalid(`workflow ${workflowId} routes through unknown team ${String(teamId)}`)
      // Rejection is how work goes back. A route that lists a team twice would
      // draw a second lane for the same team and destroy that distinction.
      if (visited.has(teamId)) {
        return invalid(`workflow ${workflowId} visits team ${teamId} twice — work returns by rejection, not by routing`)
      }
      visited.add(teamId)
    }
    seenWorkflows.add(workflowId)
    workflows.push({ workflow_id: workflowId, name: name.trim(), route: [...route] })
  }

  const normalized = {
    project_id: projectId,
    outer_controller_id: controller,
    outer_controller_model: controllerModel ?? null,
    teams,
    workflows,
  }
  return { ok: true, value: { ...normalized, source_digest: deriveWorkflowGraphDigest(normalized) }, reason: null }
}

export const workflowAgentIds = (graph) =>
  graph.teams.flatMap((entry) => entry.agents.map((agent) => agent.agent_id))

export function teamRoleOf(graph, agentId) {
  for (const entry of graph.teams) {
    const match = entry.agents.find((agent) => agent.agent_id === agentId)
    if (match) return { team_id: entry.team_id, team_name: entry.name, role: match.role }
  }
  return null
}
