// The adapter: the store the system already has, replayed into the subscribers.
//
// Nothing new is persisted. `work-items/*.jsonl` is the log, `appendEvent` is
// the single door onto it, and this walks what is already there in the order it
// was already written. That is the whole reason the carrier question ended where
// it did: the record the system had to write anyway IS the event stream, so the
// projection needs no queue, no schema and no cleanup.
//
// ORDERING is the one thing this has to get right. Each work item's custody is
// already in append order; across items the honest order is by `at`, with the
// item's own sequence as the tie-break so two lines stamped in the same
// millisecond can never swap. A projection that reordered a token's own history
// would answer differently on a replay than it did live, and then the durable
// log would stop being the truth.

import { createProjection } from './domain-bus.mjs'
import { teamDomain } from './domain-team.mjs'
import { tokenDomain } from './domain-token.mjs'
import { workflowDomain } from './domain-workflow.mjs'
import { displayDomain } from './domain-display.mjs'

/** Every event across every item, in one deterministic order. */
export function mergeCustody(items) {
  const merged = []
  for (const item of items.values()) {
    const workItem = item.work_item
    const workflow = item.workflow ?? null
    item.custody.forEach((entry, sequence) => {
      merged.push({ ...entry, work_item: entry.work_item ?? workItem, workflow: entry.workflow ?? workflow, sequence })
    })
  }
  merged.sort((a, b) => {
    if (a.at !== b.at) return String(a.at ?? '') < String(b.at ?? '') ? -1 : 1
    if (a.work_item !== b.work_item) return a.work_item < b.work_item ? -1 : 1
    return a.sequence - b.sequence
  })
  return merged
}

/** Routes declared by the graph, as the workflow domain wants them. */
export function routesOf(graph) {
  const routes = new Map()
  for (const workflow of graph?.workflows ?? []) {
    routes.set(workflow.workflow_id ?? workflow.name, [...(workflow.route ?? [])])
  }
  return routes
}

/**
 * Build the four projections from the durable log.
 * @returns the projection, so a caller can ask a domain rather than compute.
 */
// One replay per (graph, items) pair, not per caller. `teamOccupancy` calls this,
// `planDispatches` calls it again for the token state, and `planEscalation` a
// third time for the workflow state — three full replays of the same durable log
// in one tick, on a Map that has not changed between them. Keyed on the items
// Map's identity, so a new read of the ledger is a new projection and nothing
// stale can survive a tick boundary. WeakMap, so it holds nothing alive.
const replayed = new WeakMap()

export function projectWorkItems(graph, items) {
  const perGraph = replayed.get(items)
  const cached = perGraph?.get(graph)
  if (cached) return cached
  const built = buildProjection(graph, items)
  if (items && typeof items === 'object') {
    const bucket = perGraph ?? new WeakMap()
    if (!perGraph) replayed.set(items, bucket)
    if (graph && typeof graph === 'object') bucket.set(graph, built)
  }
  return built
}

function buildProjection(graph, items) {
  const projection = createProjection({
    token: tokenDomain(),
    team: teamDomain({ graph }),
    workflow: workflowDomain({ routes: routesOf(graph) }),
    display: displayDomain(),
  })
  return projection.replay(mergeCustody(items))
}
