// The `token` subscriber — the work, and who holds it.
//
// It reacts to every one of the seventeen words because it owns the history;
// that is the whole reason its column in the subscription table has no gaps. It
// decides nothing about slots or routes: a team's WIP is the team's business and
// a route's position is the workflow's, and the tangle this rebuild exists to
// undo is exactly what happens when one place knows all three.
//
// The bold cell here is `delivered` -> the leg's outcome. A leg is one
// `assigned` and everything that follows it until the next one, so the outcome
// belongs to the leg that was open when the word arrived, not to the token as a
// whole — a token can lose a leg and still finish.

export const TOKEN_EVENTS = [
  'opened', 'pulled', 'intake', 'returned', 'assigned', 'delivered', 'reviewed',
  'lost', 'escalated', 'resumed', 'completed', 'audit_requested', 'audit_lost',
  'audited', 'abandoned', 'questioned', 'answered',
]

const TERMINAL = new Set(['audited', 'abandoned'])

const blank = (item, event) => ({
  work_item: item,
  workflow: event.workflow ?? null,
  legs: [],
  history: 0,
  terminal: null,
})

export function tokenDomain() {
  return {
    events: TOKEN_EVENTS,
    init: () => ({ items: new Map() }),
    on(state, event) {
      const item = event.work_item
      if (!item) return state
      if (!state.items.has(item)) state.items.set(item, blank(item, event))
      const token = state.items.get(item)
      token.history += 1
      if (event.workflow && !token.workflow) token.workflow = event.workflow

      if (event.event === 'assigned') {
        token.legs.push({
          agent_id: event.agent_id ?? null,
          dispatch_id: event.dispatch_id ?? null,
          outcome: null,
        })
      } else if (event.event === 'delivered' || event.event === 'lost') {
        // The outcome belongs to the leg this word reports on. A dead leg writes
        // its last word on the way out, sometimes after the token has already
        // moved, so match on the leg's own identity when both sides recorded one
        // and fall back to the open leg only when they did not.
        const leg = findLeg(token.legs, event)
        if (leg) leg.outcome = event.event === 'lost' ? 'lost' : (event.outcome ?? 'delivered')
      } else if (TERMINAL.has(event.event)) {
        token.terminal = event.event
      }
      return state
    },
  }
}

function findLeg(legs, event) {
  const id = event.dispatch_id ?? null
  if (id !== null) {
    const exact = [...legs].reverse().find((leg) => leg.dispatch_id === id)
    if (exact) return exact
  }
  const agent = event.agent_id ?? null
  if (agent !== null) {
    const byAgent = [...legs].reverse().find((leg) => leg.agent_id === agent && leg.outcome === null)
    if (byAgent) return byAgent
  }
  return [...legs].reverse().find((leg) => leg.outcome === null) ?? null
}

/** The outcome of the newest leg that has one — the bold cell, as a question. */
export function lastLegOutcome(state, item) {
  const token = state.items.get(item)
  if (!token) return null
  for (let i = token.legs.length - 1; i >= 0; i -= 1) {
    if (token.legs[i].outcome !== null) return token.legs[i].outcome
  }
  return null
}

export function openLegCount(state, item) {
  return (state.items.get(item)?.legs ?? []).filter((leg) => leg.outcome === null).length
}
