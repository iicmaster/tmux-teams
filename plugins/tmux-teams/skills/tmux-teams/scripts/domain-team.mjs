// The `team` subscriber — slot accounting, driven by the ledger's own words.
//
// Today occupancy is DERIVED: `teamOccupancy` walks every token's whole custody
// and asks "where is this now". That works, and it is why the eight brakes in
// `loop-runner.mjs` exist — a derivation cannot hold a slot, so nothing could
// stop the line and timers were put in the gap instead.
//
// This subscriber ACCOUNTS instead. Six words take or free a slot; the rest are
// recorded because they move a seat, and one word does neither and is here only
// so the table in `references/event-subscriptions.md` can be read straight off
// the code. The difference that matters is not the data structure — it is that
// an accounting can hold something a derivation cannot.
//
// The owner's rule, which this exists to implement:
//
//   A team stuck = the token is in the team = its WIP stays held. Escalating to
//   the PM means THE PM IS WORKING, so the PM's WIP is held until that work is
//   done, whatever the work is. A held front door is the alarm.
//
// So a token under escalation occupies TWO slots — its delivery team's, because
// it is still stuck there, and control's, because the PM is working on it. That
// double hold is not an accident to be tidied away; it is the stop mechanism.

export const CONTROL_TEAM_ID = 'control'

// Every word in the `team` column of the subscription table. Only `opened` is
// absent, because a token that has not entered a team occupies nothing.
export const TEAM_EVENTS = [
  'pulled', 'intake', 'returned', 'assigned', 'delivered', 'reviewed', 'lost',
  'escalated', 'resumed', 'completed', 'audit_requested', 'audit_lost',
  'audited', 'abandoned', 'questioned', 'answered',
]

// The six the design marks in bold: where a subscription replaces a decision
// `nextStep` makes today. Named so a test can hold this module to the table
// rather than to a comment.
export const SLOT_DECIDING_EVENTS = [
  'pulled', 'intake', 'returned', 'delivered', 'completed', 'audit_requested',
]

const emptyState = () => ({ slots: new Map(), seats: new Map() })

const take = (state, teamId, item) => {
  if (!teamId || !item) return
  if (!state.slots.has(teamId)) state.slots.set(teamId, new Set())
  state.slots.get(teamId).add(item)
}

const release = (state, teamId, item) => {
  state.slots.get(teamId)?.delete(item)
}

const releaseEverywhere = (state, item) => {
  for (const held of state.slots.values()) held.delete(item)
}

const freeSeatsOf = (state, item) => {
  for (const [agent, held] of state.seats) if (held === item) state.seats.delete(agent)
}

/**
 * @param {{controlTeamId?: string}} options
 */
export function teamDomain({ controlTeamId = CONTROL_TEAM_ID } = {}) {
  return {
    events: TEAM_EVENTS,
    init: emptyState,
    on(state, event) {
      const item = event.work_item
      if (!item) return state
      const agent = event.agent_id || ''

      switch (event.event) {
        case 'pulled':
          // A hop. The token leaves wherever it was and the destination takes a
          // slot — one move, not a free followed by an unrelated take, because
          // between those two a WIP check would see a slot that nobody holds.
          releaseEverywhere(state, item)
          take(state, event.to_team, item)
          break

        case 'intake':
          // Accepted. The slot the pull took stays exactly where it is.
          break

        case 'returned':
          // Refused back to the sender: the slot frees.
          releaseEverywhere(state, item)
          freeSeatsOf(state, item)
          break

        case 'assigned':
          if (agent) state.seats.set(agent, item)
          break

        case 'delivered':
        case 'lost':
          // The SEAT is free. The slot is not — the team still holds the token
          // until it is judged and pulled onward.
          if (agent) state.seats.delete(agent)
          else freeSeatsOf(state, item)
          break

        case 'reviewed':
          // A verdict changes who may act next, never who holds the slot.
          break

        case 'escalated':
          // The heart. The delivery team keeps its slot because the work is
          // still stuck there, AND control takes one because the PM is now
          // working. Nothing here releases.
          take(state, controlTeamId, item)
          break

        case 'resumed':
          // The PM finished; the work goes back to a delivery team. Control's
          // slot frees here and only here for an escalation.
          release(state, controlTeamId, item)
          releaseEverywhere(state, item)
          take(state, event.to_team, item)
          break

        case 'completed':
          // The route closed, and the token is NOT done: it is a
          // control-team-held queue item until it has been audited. Filing it as
          // finished here is what let a delivery finish with nobody owing it a
          // verdict.
          releaseEverywhere(state, item)
          freeSeatsOf(state, item)
          take(state, controlTeamId, item)
          break

        case 'audit_requested':
        case 'audit_lost':
          // Control is reading a finished delivery, or owes another attempt at
          // one. Either way the PM is working, so the slot is held — today both
          // of these RELEASE, which is why an unresolved audit never closes the
          // front door.
          take(state, controlTeamId, item)
          break

        case 'audited':
        case 'abandoned':
          releaseEverywhere(state, item)
          freeSeatsOf(state, item)
          break

        case 'questioned':
        case 'answered':
          // Waiting on a person is work in progress. The slot is held.
          break

        default:
          break
      }
      return state
    },
  }
}

/** Occupancy in the shape the rest of the system already reads. */
export function occupancyOf(state, graph) {
  const counts = new Map((graph?.teams ?? []).map((team) => [team.team_id, 0]))
  const held = new Map((graph?.teams ?? []).map((team) => [team.team_id, []]))
  for (const [teamId, items] of state.slots) {
    if (!counts.has(teamId)) { counts.set(teamId, 0); held.set(teamId, []) }
    counts.set(teamId, items.size)
    held.set(teamId, [...items].sort())
  }
  return { counts, held }
}

/** Which teams hold this token right now. Two during an escalation, by design. */
export function teamsHolding(state, item) {
  const teams = []
  for (const [teamId, items] of state.slots) if (items.has(item)) teams.push(teamId)
  return teams.sort()
}
