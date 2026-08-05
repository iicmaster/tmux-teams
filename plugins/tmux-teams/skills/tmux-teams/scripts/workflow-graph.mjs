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

// GitHub #31 stage 1: what a team's WORKER hands onward. Almost every team
// hands its own artifact to the next team on the route — that is `artifact`,
// the default, and every graph written before this field existed keeps
// meaning exactly what it meant. A review team's worker instead renders a
// VERDICT on someone ELSE's work; declaring that is what lets the evaluator
// brief and a later reopen mechanism tell the two kinds of team apart without
// guessing from a team's name. Inert on its own: nothing downstream reads it
// yet outside the evaluator brief and the optional target_verdict this ADDs to
// a `reviewed` event, never removes from one.
export const TEAM_PRODUCES = new Set(['artifact', 'verdict'])

// GitHub #32: `acp-companion.mjs` already honours `ACP_REASONING_EFFORT` and
// verifies it via `ACP_EXPECT_REASONING_EFFORT` — the same request/expectation
// pair §3.2 already built for `model` — but nothing between the graph and the
// companion carried a value for it. Unlike model, effort has no per-ROLE
// block and no required declaration: a team's two workers are meant to be able
// to run the SAME model at DIFFERENT efforts (Master's two-tier dev pool), so
// binding it to `models`/`adapters` would force a role-wide default nobody
// asked for. It exists only as a `seats` override, same bound as a model name
// (companion's own `MAX_REASONING_EFFORT` is 64; this repeats that here rather
// than importing acp-companion.mjs, which owns process argv parsing and must
// not be imported for a constant).
const EFFORT_MAX = 64
const isEffortName = (value) =>
  typeof value === 'string' && value.length >= 1 && value.length <= EFFORT_MAX && !hasControlChar(value)

// GitHub #47 phase 1 (contract §3.5): a seat's model, singular, may become an
// ORDERED PALETTE — candidate seat specs for that ONE seat, not a second
// worker seat. Declaring four candidates must not cost four seats of WIP, so
// this lives on `seats[agentId]`, not on a role: it names candidates for one
// seat, and every other seat on the same role keeps its own single model or
// its own independent palette. Eight is a generous ceiling for how many real
// candidates an operator would ever queue behind one seat — an unbounded
// array is still a footgun wearing a declaration's clothes.
const PALETTE_MAX = 8

// Rate limits are per model-family within a provider, not per provider — codex
// counts gpt separately from codex-spark, agy counts gemini separately from
// non-gemini, claude counts fable separately from opus/sonnet/haiku. A bucket
// names that family. It is shape-checked only, exactly like a model name
// (§3.2): this layer never learns what a bucket MEANS, only whether two are
// equal, so it reuses the model check rather than inventing a second one.
const isBucketName = isModelName

const MAX_TEAMS = 100
// Five, and a real ceiling rather than advice: a graph that declares a sixth
// worker is refused here, not warned about somewhere a reader may not look.
//
// The worker count IS the team's WIP limit, so this also caps how much work one
// dispatcher admits and one evaluator judges — past a handful the evaluator is
// the queue, and the team is a bottleneck by construction rather than by load.
// The board agrees: a team is drawn `workers × 198px` wide, and five is the
// last count that stays readable without zooming out past the seat names.
// Measured 2026-08-02 with ten workers — every adjacent pair overlapped by
// 120px at the 0.708 fit scale.
const MAX_WORKERS = 5
const MAX_WORKFLOWS = 50
const TEAM_MODEL_ROLES = ['dispatcher', 'worker', 'evaluator']

// The lanes `acp-companion.mjs` can spawn. A closed list here and an open one
// for models is not an inconsistency: the adapter is the only authority on what
// a model name may say, but the companion itself is the authority on which
// adapters exist, and it exits 2 on a fourth name. `claude` is the default so
// that graphs written before a seat could name its lane keep their meaning.
export const DEFAULT_ADAPTER = 'claude'
export const ADAPTERS = new Set(['claude', 'codex', 'agy'])

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

// The control team is not a fifth delivery team. Its one worker IS the outer
// controller — the seat `outer_controller_id` already names — so its WIP is 1
// and the front door holds exactly one request at a time. Its dispatcher and
// evaluator are separate seats on purpose, because the controller cannot be its
// own gate: the dispatcher grills an incoming request until nothing has to be
// guessed, and the evaluator reads the finished delivery as a whole.
// The three seat names come from `references/controller-as-team.md` §4 and are
// not free to drift: `pm_intake` grills, `pm_outer_loop` unsticks, `pm_audit`
// reads the finished delivery. An ordinary team's dispatcher admits work to
// that TEAM; this one admits work to the SYSTEM.
const controlTeam = (controllerId) => ({
  team_id: 'control',
  name: 'Control',
  dispatcher_id: 'pm_intake',
  worker_ids: [controllerId],
  evaluator_id: 'pm_audit',
  models: { dispatcher: TEMPLATE_MODEL, worker: TEMPLATE_MODEL, evaluator: TEMPLATE_MODEL },
})

// Shipped so a fresh install has a real shape to edit rather than a blank file.
//
// Two routes, not one. A single route cannot show the thing the board exists to
// teach — that teams are a POOL and a workflow only decides the order through
// it. `hotfix` reuses development and qa and never touches requirement or
// prototype; those teams still exist, this route just does not use them.
//
// Both routes start at `control` because every request enters through the front
// door. That is not a convention the template is free to break: the validator
// refuses any route whose head is not the controller team.
export const DEFAULT_WORKFLOW_GRAPH = Object.freeze({
  project_id: 'default_four_team_loop',
  outer_controller_id: 'pm_outer_loop',
  outer_controller_model: TEMPLATE_MODEL,
  teams: [controlTeam('pm_outer_loop'), team('requirement', 'Requirement'),
    team('prototype', 'Prototype'), team('development', 'Development'), team('qa', 'QA')],
  workflows: [{
    workflow_id: 'default',
    name: 'Full delivery',
    route: ['control', 'requirement', 'prototype', 'development', 'qa'],
  }, {
    // Stops at prototype on purpose: some work is answered by a thing you can
    // look at, and shipping it through development and qa would be answering a
    // question nobody asked yet. A route is allowed to be short.
    workflow_id: 'prototype',
    name: 'Prototype only',
    route: ['control', 'requirement', 'prototype'],
  }, {
    workflow_id: 'hotfix',
    name: 'Hotfix',
    route: ['control', 'development', 'qa'],
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
  const controllerAdapter = controller === null ? null
    : (value.outer_controller_adapter == null || value.outer_controller_adapter === '' ? DEFAULT_ADAPTER : value.outer_controller_adapter)
  if (controller !== null && !ADAPTERS.has(controllerAdapter)) {
    return invalid(`the outer controller has an unknown adapter — one of ${[...ADAPTERS].join(', ')}`)
  }
  // Optional, unlike model and adapter: a controller with no declared effort
  // requests nothing, exactly like a graph written before this field existed.
  // There is no sentinel to omit-by-writing here, because omitting the key
  // already means "ask for nothing" — the same meaning a sentinel would add.
  const controllerEffort = controller === null ? null
    : (value.outer_controller_effort == null || value.outer_controller_effort === '' ? null : value.outer_controller_effort)
  if (controller !== null && controllerEffort !== null && !isEffortName(controllerEffort)) {
    return invalid(`the outer controller has an invalid reasoning effort — an effort is 1 to ${EFFORT_MAX} characters with no control characters`)
  }

  // Derived, never declared — the same rule §3.1 applies to `wip_limit`. A
  // graph that states it in a field would be stating one fact twice, and two
  // statements of one fact eventually disagree.
  if (isObject(value) && 'controller_team' in value) {
    return invalid('controller_team is derived from the head of every route, not declared — remove the field')
  }
  let controllerTeamId = null

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
    // The lane a seat runs on. Unlike a model name — where the adapter is the
    // only authority and no list lives here — the lanes are a closed set,
    // because `acp-companion.mjs` knows exactly three and exits on a fourth.
    // Optional and defaulting to `claude`, so every graph written before seats
    // could name a lane keeps meaning what it meant.
    const adapters = raw.adapters == null ? {} : raw.adapters
    if (!isObject(adapters)) {
      return invalid(`team ${teamId} declares adapters that are not an object — omit the key to run every seat on ${DEFAULT_ADAPTER}`)
    }
    const laneOf = (role) => {
      const declared = adapters[role]
      return declared == null || declared === '' ? DEFAULT_ADAPTER : declared
    }
    for (const role of TEAM_MODEL_ROLES) {
      if (!ADAPTERS.has(laneOf(role))) {
        return invalid(`team ${teamId} has an unknown adapter for its ${role} — one of ${[...ADAPTERS].join(', ')}`)
      }
    }
    // A seat that differs from its role. `models` and `adapters` above bind per
    // ROLE, so every worker on a team ran one model on one lane and a team of
    // two different models could not be declared at all. `seats` is the
    // exception list: it names an agent this team already holds and overrides
    // that one seat's model, its lane, or both. Omitted — or omitted for a
    // given seat — the role block stands, so every graph written before this
    // keeps meaning exactly what it meant.
    //
    // It is an override, never a second place to state the same fact, and every
    // way of saying nothing is refused rather than ignored. A key naming no seat
    // on this team, an empty object, a misspelt `modle` — each would resolve to
    // the role default while a reader believed the seat had been moved, which is
    // the quiet wrong answer this declaration exists to stop.
    const seats = raw.seats == null ? {} : raw.seats
    if (!isObject(seats)) {
      return invalid(`team ${teamId} declares seats that are not an object — omit the key to run every seat on its role's model and lane`)
    }
    // A Map, not the object: an agent id may legally be `__proto__`, and a
    // property read would answer from the prototype chain for a key nobody wrote.
    const seatOverride = new Map(Object.entries(seats))
    const seatIds = new Set([dispatcher, ...workers, evaluator])
    // Which of the three roles a seat fills — needed to resolve a palette
    // entry's default lane and default bucket (§3.5) the same way an
    // unoverridden seat already resolves its role's default lane.
    const roleOf = (agentId) => (agentId === dispatcher ? 'dispatcher' : agentId === evaluator ? 'evaluator' : 'worker')
    for (const [agentId, override] of seatOverride) {
      if (!seatIds.has(agentId)) {
        return invalid(`team ${teamId} declares a seat for ${agentId}, which is not a seat on this team`)
      }
      // The controller names its model and lane in `outer_controller_model` and
      // `outer_controller_adapter`, and `declaredModel` / `declaredAdapter` read
      // those FIRST. A seat entry here would validate, move `source_digest` and
      // draw on the page, then lose silently at dispatch — a declaration that
      // renders and does nothing.
      if (agentId === controller) {
        return invalid(`team ${teamId} declares a seat for the outer controller ${agentId} — it names its model in outer_controller_model and its lane in outer_controller_adapter, and the dispatch reads those, not this`)
      }
      if (!isObject(override)) {
        return invalid(`team ${teamId} declares a seat for ${agentId} that is not an object`)
      }
      const keys = Object.keys(override)
      const unknown = keys.find((key) => key !== 'model' && key !== 'adapter' && key !== 'effort' && key !== 'display_model' && key !== 'palette')
      if (unknown !== undefined) {
        return invalid(`team ${teamId} declares an unknown key ${show(unknown)} on the seat ${agentId} — a seat overrides model, adapter, effort, display_model, palette, or any combination`)
      }
      if (keys.length === 0) {
        return invalid(`team ${teamId} declares an empty seat for ${agentId} — name a model, an adapter, an effort, a palette, or remove it`)
      }
      // GitHub #47 phase 1 (§3.5): `palette` REPLACES the single-value fields
      // for this seat, it does not sit alongside them. A `model`/`adapter`/
      // `effort`/`display_model` next to a `palette` would read as a default
      // the palette falls back to and would in fact be silently ignored — the
      // same "declaration that changes nothing" shape §3.2.1 already refuses.
      if ('palette' in override && keys.length > 1) {
        return invalid(`team ${teamId} declares a palette on the seat ${agentId} alongside ${keys.filter((key) => key !== 'palette').join(', ')} — a palette entry already carries model, adapter, effort and display_model, so those keys next to it would be silently ignored`)
      }
      if ('palette' in override) {
        const palette = override.palette
        if (!Array.isArray(palette) || palette.length < 1 || palette.length > PALETTE_MAX) {
          return invalid(`team ${teamId} declares an invalid palette on the seat ${agentId} — a palette is an array of 1 to ${PALETTE_MAX} model entries`)
        }
        const role = roleOf(agentId)
        let previousBucket = null
        for (let index = 0; index < palette.length; index += 1) {
          const entry = palette[index]
          if (!isObject(entry)) {
            return invalid(`team ${teamId} has an invalid palette entry at index ${index} on the seat ${agentId} — each entry is an object naming a model`)
          }
          const entryKeys = Object.keys(entry)
          const unknownEntryKey = entryKeys.find((key) => key !== 'model' && key !== 'adapter' && key !== 'effort' && key !== 'display_model' && key !== 'bucket')
          if (unknownEntryKey !== undefined) {
            return invalid(`team ${teamId} declares an unknown key ${show(unknownEntryKey)} on palette entry ${index} of the seat ${agentId} — a palette entry names model, adapter, effort, display_model, bucket, or any combination`)
          }
          // A palette entry is a whole seat spec, and `model` has no role
          // default to fall back to the way a plain seat override's `model`
          // does — an entry naming no model names nothing at all.
          if (!isModelName(entry.model)) {
            return invalid(`team ${teamId} has a missing or invalid model on palette entry ${index} of the seat ${agentId} — a model is 1 to ${MODEL_MAX} characters with no control characters`)
          }
          if ('display_model' in entry && !isModelName(entry.display_model)) {
            return invalid(`team ${teamId} has an invalid display_model on palette entry ${index} of the seat ${agentId} — a model is 1 to ${MODEL_MAX} characters with no control characters`)
          }
          if ('adapter' in entry && !ADAPTERS.has(entry.adapter)) {
            return invalid(`team ${teamId} has an unknown adapter on palette entry ${index} of the seat ${agentId} — one of ${[...ADAPTERS].join(', ')}`)
          }
          if ('effort' in entry && !isEffortName(entry.effort)) {
            return invalid(`team ${teamId} has an invalid reasoning effort on palette entry ${index} of the seat ${agentId} — an effort is 1 to ${EFFORT_MAX} characters with no control characters`)
          }
          // Shape only (§3.2, §3.5) — never checked against a list of known
          // buckets. Present-but-empty is refused, exactly like an empty
          // model; ABSENT defaults to this entry's own resolved lane below.
          if ('bucket' in entry && !isBucketName(entry.bucket)) {
            return invalid(`team ${teamId} has an invalid bucket on palette entry ${index} of the seat ${agentId} — a bucket is 1 to ${MODEL_MAX} characters with no control characters`)
          }
          const entryAdapter = entry.adapter == null || entry.adapter === '' ? laneOf(role) : entry.adapter
          const entryBucket = 'bucket' in entry ? entry.bucket : entryAdapter
          // The rule the whole design turns on (§3.5): two CONSECUTIVE entries
          // in one bucket draw on the same rate limit, so trying the second
          // right after the first spends a leg to learn nothing. Refused, not
          // warned — this validator has no "accepted with a warning" channel
          // anywhere else in this file, and building one for a single rule
          // would be new machinery, not a shape check.
          if (previousBucket !== null && entryBucket === previousBucket) {
            return invalid(`team ${teamId} declares two consecutive palette entries in bucket ${show(entryBucket)} on the seat ${agentId} — entries ${index - 1} and ${index} draw on the same rate limit, so falling back from one to the other spends a leg to learn nothing`)
          }
          previousBucket = entryBucket
        }
      } else {
        if ('model' in override && !isModelName(override.model)) {
          return invalid(`team ${teamId} has an invalid model on the seat ${agentId} — a model is 1 to ${MODEL_MAX} characters with no control characters`)
        }
        // Display layer: the model a reader should SEE for this seat, distinct
        // from `model` (which the dispatch layer sends, and may be an alias the
        // adapter accepts). The board renders this when present; the dispatch
        // never reads it, so an alias can stay in `model` while the real model
        // name shows on the page.
        if ('display_model' in override && !isModelName(override.display_model)) {
          return invalid(`team ${teamId} has an invalid display_model on the seat ${agentId} — a model is 1 to ${MODEL_MAX} characters with no control characters`)
        }
        if ('adapter' in override && !ADAPTERS.has(override.adapter)) {
          return invalid(`team ${teamId} has an unknown adapter on the seat ${agentId} — one of ${[...ADAPTERS].join(', ')}`)
        }
        // §32: no role-level default to restate, so — unlike model/adapter — there
        // is no way to declare an effort that "resolves to the role default" and
        // say nothing; every declared effort is a real request.
        if ('effort' in override && !isEffortName(override.effort)) {
          return invalid(`team ${teamId} has an invalid reasoning effort on the seat ${agentId} — an effort is 1 to ${EFFORT_MAX} characters with no control characters`)
        }
      }
    }
    // GitHub #31 stage 1: declared, optional, defaulting to 'artifact' — see
    // the constant's own comment above. Checked here, next to `wip_limit` and
    // `models`, because this is where every other per-team declaration is
    // validated once and normalized once.
    const produces = raw.produces == null ? 'artifact' : raw.produces
    if (!TEAM_PRODUCES.has(produces)) {
      return invalid(`team ${teamId} declares produces ${show(produces)} — one of ${[...TEAM_PRODUCES].join(', ')}`)
    }
    // GitHub #47 phase 1 (§3.5): a resolved palette entry, in the same shape
    // `agents[]` has always reported for an unoverridden seat — adapter falls
    // back to the seat's own role, bucket falls back to the resolved adapter,
    // effort and display_model fall back to "nothing requested".
    const resolvePaletteEntry = (entry, role) => {
      const adapter = entry.adapter == null || entry.adapter === '' ? laneOf(role) : entry.adapter
      return {
        model: entry.model,
        adapter,
        effort: entry.effort == null || entry.effort === '' ? null : entry.effort,
        display_model: entry.display_model == null || entry.display_model === '' ? null : entry.display_model,
        bucket: 'bucket' in entry ? entry.bucket : adapter,
      }
    }
    // The full resolved palette for a seat, or `null` for a seat that declared
    // none — this is the only thing a reader outside this file may consume
    // (§3.5); nothing here makes anything USE it yet.
    const seatPalette = (agentId) => {
      const raw = seatOverride.get(agentId)?.palette
      return raw ? raw.map((entry) => resolvePaletteEntry(entry, roleOf(agentId))) : null
    }
    // A palette's FIRST entry is what an unmodified reader sees today for the
    // single-value fields below — "the dispatcher's choice is the starting
    // point" (§3.5) is exactly this fallback in a system with no choice
    // mechanism built yet; phase 2 is what makes the choice real.
    const paletteFirst = (agentId) => seatPalette(agentId)?.[0] ?? null
    const seatModel = (agentId, role) => paletteFirst(agentId)?.model ?? seatOverride.get(agentId)?.model ?? models[role]
    const seatLane = (agentId, role) => paletteFirst(agentId)?.adapter ?? seatOverride.get(agentId)?.adapter ?? laneOf(role)
    // No role default to fall back to (see EFFORT_MAX comment above) — an
    // unoverridden seat carries `null`, meaning "request nothing", not "carry
    // the team's effort" the way an unoverridden model or lane does.
    const seatEffort = (agentId) => paletteFirst(agentId)?.effort ?? seatOverride.get(agentId)?.effort ?? null
    // Display layer only — the dispatch never reads this. Falls back to the
    // declared `model` downstream (the renderer shows display_model ?? model).
    const seatDisplayModel = (agentId) => paletteFirst(agentId)?.display_model ?? seatOverride.get(agentId)?.display_model ?? null
    // One agent, one seat. A shared id would make two nodes light up from one
    // dispatch, which is exactly the false positive the page must never show.
    //
    // The controller is the single exception, and only as a WORKER. Under
    // `references/controller-as-team.md` the controller stops being outside the
    // board and becomes an ordinary team whose one worker is the seat
    // `outer_controller_id` already names — the same seat named twice, not two
    // seats. As a dispatcher or an evaluator it would be a second seat, so those
    // stay refused.
    const members = [dispatcher, ...workers, evaluator]
    for (const agentId of members) {
      const isControllerAsWorker = agentId === controller && workers.includes(agentId)
        && agentId !== dispatcher && agentId !== evaluator
      if (isControllerAsWorker) {
        if (controllerTeamId !== null) {
          return invalid(`outer_controller_id ${agentId} is a worker on both ${controllerTeamId} and ${teamId} — it is one seat`)
        }
        controllerTeamId = teamId
        continue
      }
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
      produces,
      models: { dispatcher: models.dispatcher, worker: models.worker, evaluator: models.evaluator },
      adapters: { dispatcher: laneOf('dispatcher'), worker: laneOf('worker'), evaluator: laneOf('evaluator') },
      // The RESOLVED model travels with each agent so a reader never has to
      // pair a role back to the team's models block by hand — and since `seats`
      // exists, that pairing would be WRONG for an overridden seat. `models` and
      // `adapters` above are the team's DEFAULTS; this array is the answer, and
      // it is the only thing `declaredModel` and `declaredAdapter` read. It
      // stays a DECLARATION: the model a node reports as running is verified
      // evidence and is a different fact from this one.
      agents: [
        { agent_id: dispatcher, role: 'dispatcher', model: seatModel(dispatcher, 'dispatcher'), adapter: seatLane(dispatcher, 'dispatcher'), effort: seatEffort(dispatcher), display_model: seatDisplayModel(dispatcher), palette: seatPalette(dispatcher) },
        ...workers.map((agentId) => ({ agent_id: agentId, role: 'worker', model: seatModel(agentId, 'worker'), adapter: seatLane(agentId, 'worker'), effort: seatEffort(agentId), display_model: seatDisplayModel(agentId), palette: seatPalette(agentId) })),
        { agent_id: evaluator, role: 'evaluator', model: seatModel(evaluator, 'evaluator'), adapter: seatLane(evaluator, 'evaluator'), effort: seatEffort(evaluator), display_model: seatDisplayModel(evaluator), palette: seatPalette(evaluator) },
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

  // ── the controller as a team (references/controller-as-team.md) ────────────
  //
  // Opt-in by construction: a graph where the controller sits in no team is
  // exactly the graph this system has always accepted, and validates unchanged.
  // Naming the controller as a team's worker is what turns these rules on, and
  // then all of them apply — a half-adopted version would be a board that draws
  // an entry point the runner does not use.
  if (controllerTeamId !== null) {
    const controlTeam = teams.find((entry) => entry.team_id === controllerTeamId)
    if (controlTeam.worker_ids.length !== 1) {
      return invalid(`the controller team ${controllerTeamId} has ${controlTeam.worker_ids.length} workers — it holds one seat, so WIP 1`)
    }
    for (const workflow of workflows) {
      if (workflow.route[0] !== controllerTeamId) {
        return invalid(`workflow ${workflow.workflow_id} starts at ${workflow.route[0]} — every route enters through the controller team ${controllerTeamId}`)
      }
      // §1 already refuses a repeated team, so a controller appearing later in
      // a route is caught above. This is the case §1 cannot see: a route that
      // starts somewhere else while another route starts at the controller,
      // which would mean the board has two front doors.
    }
  }

  const normalized = {
    project_id: projectId,
    outer_controller_id: controller,
    outer_controller_model: controllerModel ?? null,
    outer_controller_adapter: controllerAdapter ?? null,
    outer_controller_effort: controllerEffort,
    controller_team: controllerTeamId,
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
