// The `team` subscriber — slot accounting, driven by the ledger's own words.
//
// Occupancy USED to be derived: a walk over every token's whole custody asking
// "where is this now". That worked, and it is why the eight brakes in
// `loop-runner.mjs` exist — a derivation cannot hold a slot, so nothing could
// stop the line and timers were put in the gap instead. The walk is still in
// the tree as `deriveTeamOccupancy`, frozen against the event set it was
// written for, because it is what this has to agree with for a token IN FLIGHT
// — not everywhere. Where this change altered a word's meaning the two differ
// on purpose, and the equivalence test states each difference rather than
// asserting agreement.
//
// Since 2026-08-14 `teamOccupancy` delegates HERE, so this module is the
// occupancy rule — the only one, per contract ข้อ 13. It ACCOUNTS instead, and
// the difference that matters is not the data structure: an accounting can hold
// something a derivation cannot.
//
// TEN words move a slot — `opened`, `pulled`, `returned`, `escalated`,
// `resumed`, `completed` and the two audit words take or move one, and
// `audited`/`abandoned` release every one. `assigned`, `delivered` and `lost`
// move a SEAT and no slot. `intake`, `reviewed`, `questioned` and `answered`
// move neither and are listened for anyway, so the table in
// `references/event-subscriptions.md` reads straight off the code. The SIX the
// design marks in bold are named below and are a different count entirely; an
// earlier version of this paragraph confused the two, and two review lanes read
// it against the switch and said so.
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

// Every word in the `team` column of the subscription table, INCLUDING `opened`,
// which the table marks "—".
//
// The table is wrong about that one and a real test caught it: `opened` requires
// `to_team` (contract ข้อ 4.6) and the front door writes it naming control, so a
// request occupies control's slot from the moment it is admitted. That is what
// the front-door WIP check has always counted. Read "—" as "nothing beyond the
// placement", which is true of the domain's other quiet words and is not true
// here.
export const TEAM_EVENTS = [
  'opened',
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

// `seen` is what lets this answer the question the derivation answered with a
// null team id: a token the system knows about that is held by nobody. Surfaced,
// never silently dropped — a token that vanishes from every count is a token
// nobody will ever come looking for.
// `decider` is deliberately NOT derivable from `slots`. A token under
// escalation is held by two teams at once — that double hold IS the stop
// mechanism — but exactly one of them gets to act on it, and that is the PM.
// Without this the planning loop reaches the same token twice and publishes two
// moves for it.
const emptyState = () => ({ slots: new Map(), seats: new Map(), seen: new Map(), decider: new Map() })

const take = (state, teamId, item, { decides = true } = {}) => {
  if (!item) return
  if (!teamId) return // recorded by `seen`; surfaced as an orphan, not dropped
  if (!state.slots.has(teamId)) state.slots.set(teamId, new Set())
  state.slots.get(teamId).add(item)
  if (decides) state.decider.set(item, teamId)
}

const release = (state, teamId, item) => {
  state.slots.get(teamId)?.delete(item)
}

const releaseEverywhere = (state, item) => {
  for (const held of state.slots.values()) held.delete(item)
}

const freeSeatsOf = (state, item) => {
  for (const [agent, seat] of state.seats) if (seat.item === item) state.seats.delete(agent)
}

// A token whose route is over and whose verdict is in. It is held by nobody and
// that is correct, so it is not an orphan.
export const CLOSED = new Set(['audited', 'abandoned'])

/**
 * Occupancy in the shape the rest of the system already reads:
 * `{ counts, held, orphans }`, with the same meaning `teamOccupancy` gives them.
 */
const heldAnywhere = (state, item) => {
  for (const items of state.slots.values()) if (items.has(item)) return true
  return false
}

const rosterOf = (graph) => {
  const teamOf = new Map()
  for (const team of graph?.teams ?? []) {
    for (const agent of team.agents ?? []) teamOf.set(agent.agent_id, team.team_id)
  }
  return teamOf
}

/**
 * @param {{controlTeamId?: string, graph?: object}} options — `graph` supplies
 *   the seat roster. Without it the domain still accounts correctly for every
 *   token that entered through a door, and cannot place one that only ever
 *   appears as somebody acting on it.
 */
export function teamDomain({ controlTeamId, graph = null } = {}) {
  const teamOf = rosterOf(graph)
  const declared = new Set((graph?.teams ?? []).map((team) => team.team_id))
  // The graph names its own controller team — it is derived from the head of
  // every route — so a constant is only the floor. And when the graph declares
  // no such team at all, control's queue has nowhere to live: fall back to the
  // team of whoever signed the event.
  //
  // Do NOT read that as "what the derivation did anyway" — an earlier comment
  // said so and a review lane checked it. The frozen derivation does the
  // opposite for exactly these words: they were RELEASING there, so it placed
  // them nowhere at all. This fallback is a choice about a graph that declares
  // no controller, not a restoration of old behaviour.
  const controlId = controlTeamId ?? graph?.controller_team ?? CONTROL_TEAM_ID
  const controlOr = (agentId) => (declared.has(controlId) ? controlId : (teamOf.get(agentId) ?? controlId))
  return {
    events: TEAM_EVENTS,
    init: emptyState,
    on(state, event) {
      const item = event.work_item
      if (!item) return state
      const agent = event.agent_id || ''
      state.seen.set(item, { event: event.event, agent_id: agent, workflow: event.workflow ?? '' })

      switch (event.event) {
        case 'opened':
          // Admitted. The request is in the controller's queue from here, which
          // is the count the front door has always enforced.
          take(state, event.to_team, item)
          break

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
          // Refused at the door. The refusing team's slot frees and the SENDER
          // takes one back — the token is held by the team it went back to, not
          // by the dispatcher that refused it, which is why contract ข้อ 4.1
          // forbids an `agent_id` here and requires `to_team`. Reading this as a
          // plain release would let a refusal quietly drop work out of the
          // system, and the design's own summary of it ("the slot frees") is
          // true only of the team that said no.
          releaseEverywhere(state, item)
          freeSeatsOf(state, item)
          take(state, event.to_team, item)
          break

        case 'assigned':
          // Keyed by seat, but REMEMBERING the leg. Two legs run by the same
          // agent read identically on `agent_id` alone, and the newer one
          // overwrites the older here, which is correct: the seat is running the
          // newer one.
          if (agent) state.seats.set(agent, { item, dispatch_id: event.dispatch_id ?? null })
          break

        case 'delivered':
        case 'lost': {
          // The SEAT is free. The slot is not — the team still holds the token
          // until it is judged and pulled onward.
          //
          // But only if this word belongs to the leg the seat is actually
          // running. A leg killed mid-review still writes its last word on the
          // way out, and `at` is stamped when the line is written, so a dead
          // leg's report genuinely arrives after a NEW leg took the same seat.
          // Freeing on `agent_id` alone hands that seat away while work is
          // still running on it — the same trap `currentEntry` exists to avoid
          // on the placement side, and the reason a trailing word is matched by
          // `dispatch_id` whenever both sides recorded one.
          if (!agent) { freeSeatsOf(state, item); break }
          const seat = state.seats.get(agent)
          if (!seat) break
          const id = event.dispatch_id ?? null
          const stale = id !== null && seat.dispatch_id !== null && seat.dispatch_id !== id
          if (!stale) state.seats.delete(agent)
          break
        }

        case 'reviewed':
          // A verdict changes who may act next, never who holds the slot.
          break

        case 'escalated':
          // The heart. The delivery team keeps its slot because the work is
          // still stuck there, AND control takes one because the PM is now
          // working. Nothing here releases.
          //
          // But an escalation signed by a seat the graph does not declare, on a
          // token no team is holding, places nothing — the derivation never
          // assumed control either, and a line naming a ghost has to surface as
          // unplaceable rather than be absorbed into the controller's queue,
          // where it would sit forever looking like ordinary work.
          if (heldAnywhere(state, item) || teamOf.has(agent)) take(state, controlOr(agent), item)
          break

        case 'resumed':
          // The PM finished; the work goes back to a delivery team, and control
          // lets go. This is the ORDINARY end of an escalation's control hold;
          // `audited` and `abandoned` also free it, by freeing everything. An
          // earlier comment said "here and only here", and two review lanes read
          // that against the code and found it false.
          release(state, controlOr(agent), item)
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
          take(state, controlOr(agent), item)
          break

        case 'audit_requested':
        case 'audit_lost':
          // Control is reading a finished delivery, or owes another attempt at
          // one. Either way the PM is working, so the slot is held. Both of these
          // USED to release every slot, which is why an unresolved audit never
          // closed the front door — the comment said "today both of these
          // RELEASE" inside the very code that stopped it, and a lane caught the
          // tense.
          take(state, controlOr(agent), item)
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

      // Placed by WHO ACTED, when nothing else has placed it. The derivation
      // this replaces had no other rule: it read the token's newest event and
      // asked which team its `agent_id` belongs to. That is not a fixture
      // artefact — a token whose history begins mid-flight, or whose entering
      // event predates a graph change, is genuinely located by the seat working
      // on it and by nothing else.
      //
      // Only when it is held NOWHERE, so this can never overrule an explicit
      // placement and can never undo the escalation double-hold, where the
      // signer is a delivery dispatcher and control must keep its slot.
      if (agent && !CLOSED.has(event.event) && !heldAnywhere(state, item)) {
        take(state, teamOf.get(agent), item)
      }
      if (CLOSED.has(event.event)) state.decider.delete(item)
      return state
    },
  }
}

/** Which single team gets to act on this token now. */
export function decidingTeam(state, item) {
  return state.decider.get(item) ?? null
}

export function occupancyOf(state, graph) {
  const declared = new Set((graph?.teams ?? []).map((team) => team.team_id))
  const counts = new Map([...declared].map((teamId) => [teamId, 0]))
  const held = new Map([...declared].map((teamId) => [teamId, []]))
  const orphans = []
  const placed = new Set()

  for (const [teamId, items] of state.slots) {
    for (const item of items) placed.add(item)
    if (!declared.has(teamId)) {
      // Held by a team the graph no longer declares. The derivation reported
      // this the same way: surfaced, never silently dropped.
      for (const item of [...items].sort()) {
        orphans.push({ work_item: item, event: state.seen.get(item)?.event ?? '', agent_id: state.seen.get(item)?.agent_id ?? '', workflow: state.seen.get(item)?.workflow ?? '' })
      }
      continue
    }
    // counts is WIP — every hold, including the escalation double-hold.
    // held is who ACTS — the planning loop iterates it, and a token planned for
    // twice in one tick is two moves for one piece of work.
    counts.set(teamId, items.size)
    held.set(teamId, [...items].filter((item) => (state.decider.get(item) ?? teamId) === teamId).sort())
  }

  for (const [item, last] of state.seen) {
    if (placed.has(item) || CLOSED.has(last.event)) continue
    orphans.push({ work_item: item, event: last.event, agent_id: last.agent_id, workflow: last.workflow })
  }
  orphans.sort((a, b) => (a.work_item < b.work_item ? -1 : a.work_item > b.work_item ? 1 : 0))
  return { counts, held, orphans }
}

/** Which teams hold this token right now. Two during an escalation, by design. */
export function teamsHolding(state, item) {
  const teams = []
  for (const [teamId, items] of state.slots) if (items.has(item)) teams.push(teamId)
  return teams.sort()
}
