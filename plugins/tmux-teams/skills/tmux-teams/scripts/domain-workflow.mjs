// The `workflow` subscriber — how a token flows between teams.
//
// This is the domain the reading found did not exist at all: a workflow is three
// fields, `route` is a list of team ids, and the function that decides the next
// step reads neither. Measured 2026-08-06 and again 2026-08-14, `nextStep` reads
// `route` or `workflow` in code ZERO times; the three matches inside it are
// comments. So a token has never actually flowed along a declared route — it has
// been moved by one policy that happens to produce the right answer while every
// route has the same shape.
//
// Five words are about position. The bold cell is `completed` -> route finished,
// which is the one place a route can say it is done rather than having somebody
// infer it.

export const WORKFLOW_EVENTS = ['opened', 'pulled', 'intake', 'returned', 'reviewed', 'delivered', 'completed']

const blank = () => ({ workflow: null, route: [], hop: -1, finished: false })

export function workflowDomain({ routes = new Map() } = {}) {
  const routeFor = (name) => (routes instanceof Map ? routes.get(name) : routes?.[name]) ?? []

  return {
    events: WORKFLOW_EVENTS,
    init: () => ({ items: new Map() }),
    on(state, event) {
      const item = event.work_item
      if (!item) return state
      if (!state.items.has(item)) state.items.set(item, blank())
      const position = state.items.get(item)

      switch (event.event) {
        case 'opened':
          // The route is picked once, here, and never re-picked. A token that
          // changed route mid-flight would make "no revisit" unprovable.
          position.workflow = event.workflow ?? null
          position.route = [...routeFor(position.workflow)]
          position.hop = position.route.length > 0 ? 0 : -1
          break

        case 'pulled': {
          // Advance to the hop that matches where it actually landed, so the
          // position is read off the route rather than assumed to be "one more".
          const at = position.route.indexOf(event.to_team)
          position.hop = at >= 0 ? at : position.hop + 1
          break
        }

        case 'returned':
          // The hop is undone: a refusal at the door never counted as arrival.
          if (position.hop > 0) position.hop -= 1
          break

        case 'completed':
          position.finished = true
          break

        default:
          // `intake`, `reviewed` and `delivered` are read for "is this step
          // done?"; none of them moves the position by itself.
          break
      }
      return state
    },
  }
}

/** The team the route says comes next, or null at the end of it. */
export function nextHop(state, item) {
  const position = state.items.get(item)
  if (!position || position.finished) return null
  const at = position.hop
  if (at < 0 || at + 1 >= position.route.length) return null
  return position.route[at + 1]
}

export function routeFinished(state, item) {
  return Boolean(state.items.get(item)?.finished)
}

export function positionOf(state, item) {
  const position = state.items.get(item)
  return position ? { ...position, route: [...position.route] } : null
}
