// dispatch-facts.mjs — the routing facts Pulse deliberately does not carry.
//
// pulse.json is a frozen contract about *process* liveness: state, timing,
// transport, verified model. Which workflow a dispatch runs, and which work
// item token it is carrying, are facts about *work*, and they live where they
// were written — the dispatch record and the token's custody ledger. Reading
// them here keeps the Pulse schema untouched and keeps each fact sourced from
// the file that actually recorded it.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const MAX_FILES = 5000
const MAX_LEDGER_BYTES = 1 << 20

const field = (text, key) => {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return match ? match[1].trim() : ''
}

const listing = (dir) => {
  try { return readdirSync(dir).slice(0, MAX_FILES) } catch { return [] }
}

// Keyed by task id: that is what both the dispatch record and Pulse's run rows
// agree on, so a caller can join the two without guessing.
export function readDispatchFacts(repo) {
  const dir = join(repo, '.tmux-teams', 'dispatch')
  const byTask = new Map()
  for (const name of listing(dir)) {
    if (!name.endsWith('.md')) continue
    let text
    try { text = readFileSync(join(dir, name), 'utf8') } catch { continue }
    const taskId = field(text, 'task_id')
    if (!taskId) continue
    const workflow = field(text, 'workflow')
    const workItem = field(text, 'work_item')
    const agentId = field(text, 'agent_id')
    byTask.set(taskId, {
      task_id: taskId,
      dispatch_id: field(text, 'dispatch_id'),
      agent_id: ID_RE.test(agentId) ? agentId : '',
      workflow: ID_RE.test(workflow) ? workflow : '',
      work_item: ID_RE.test(workItem) ? workItem : '',
      // Which model this dispatch ASKED for, and what actually answered. Pulse
      // reports a model only once it has verified one, so without these the page
      // cannot tell "we pinned a model and it was confirmed" apart from "nobody
      // ever named one, so the account default answered" — two very different
      // facts that both used to print as `unverified`.
      requested_model: field(text, 'requested_model'),
      effective_identity: field(text, 'effective_identity'),
      identity_status: field(text, 'identity_status'),
    })
  }
  return byTask
}

// One token, one append-only ledger. A malformed line is skipped rather than
// discarding the token's whole history — the ledger is evidence, and partial
// evidence still beats none as long as it is never invented.
export function readWorkItems(repo) {
  const dir = join(repo, '.tmux-teams', 'work-items')
  const items = new Map()
  let skippedLines = 0
  for (const name of listing(dir)) {
    if (!name.endsWith('.jsonl')) continue
    let text
    try {
      text = readFileSync(join(dir, name)).subarray(0, MAX_LEDGER_BYTES).toString('utf8')
    } catch { continue }
    const custody = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry
      try { entry = JSON.parse(line) } catch { skippedLines += 1; continue }
      if (!entry || typeof entry !== 'object' || !ID_RE.test(String(entry.work_item ?? ''))) {
        skippedLines += 1
        continue
      }
      custody.push(entry)
    }
    if (!custody.length) continue
    custody.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    const first = custody[0]
    const last = custody[custody.length - 1]
    const startedMs = Date.parse(first.at || '')
    const lastMs = Date.parse(last.at || '')
    items.set(first.work_item, {
      work_item: first.work_item,
      workflow: last.workflow || first.workflow || '',
      custody,
      current_agent: last.agent_id || '',
      current_event: last.event || '',
      terminal: last.terminal || '',
      first_at: first.at || '',
      last_at: last.at || '',
      // Lead time is the token's whole journey, which is the number a board
      // exists to show — per-dispatch elapsed can never add up to it.
      lead_sec: Number.isFinite(startedMs) && Number.isFinite(lastMs)
        ? Math.max(0, Math.round((lastMs - startedMs) / 1000))
        : null,
      legs: custody.filter((entry) => entry.event === 'assigned').length,
    })
  }
  return { items, skippedLines }
}

// Where the work actually is. A token occupies a team from the moment that team
// pulls it until it is handed on, so occupancy counts WORK, not processes: a
// worker exiting does not empty the queue it was working from.
//
// This rule lives here, once, because two readers computing it separately is
// how a board and a controller end up disagreeing about the same team.
// Listing which events occupy a team was a bug factory: every event added to
// the protocol had to be remembered here, and the one that got forgotten
// silently emptied a team that was still holding the work. The rule is
// inverted instead — a team holds a token from the moment it pulls it until
// the route closes, so an event nobody taught this function about leaves the
// work where it is rather than making it disappear.
// `abandoned` is the honest close: a token nobody will finish — a diagnostic
// probe, or work belonging to a graph that no longer exists. Without it the only
// ways out are to lie (`completed`) or to leave the token occupying a team it
// will never leave, which on a WIP-1 team deadlocks that team forever.
// A finished route stays finished while the outer controller reads it. An audit
// observes a delivery; it never takes custody of one, so it must not put a
// closed token back into a team's WIP.
export const RELEASING_EVENTS = new Set(['completed', 'abandoned', 'audit_requested', 'audited'])

// A leg is one `assigned` and everything that follows it until the next one.
// The token's position is the newest event EXCEPT when that event is a leg
// reporting in after it stopped holding the work: a companion killed mid-review
// still writes its `delivered` on the way out, and `at` is stamped when the
// line is written, so a dead leg's last word genuinely arrives after the token
// moved on. Sorting cannot separate those — there is no recorded field for
// "when the work finished" as opposed to "when this was written".
//
// So placement asks who holds the token now — the agent named on the newest
// `assigned` — and skips a trailing `delivered`/`lost`/`reviewed` that belongs
// to an older leg. It is still evidence about that leg; it is not where the
// token IS. Everything else stays last-wins, unchanged.
//
// "Belongs to an older leg" is decided by `dispatch_id` whenever both the
// trailing entry and the holder's `assigned` recorded one. That is the leg's
// real identity, and it is the only thing that can tell two legs run by the
// SAME agent apart — agent_id reads identical for both, which is why that case
// stood open here as a known limit until now.
//
// `reviewed` was tried in this set once by agent_id and broke four tests that
// encode the pull flow, for a reason worth keeping: an evaluator does not
// always have an `assigned` of its own when its review lands, so its agent_id
// is never expected to equal the holder's, and that mismatch is the review
// protocol rather than staleness. `delivered`/`lost` keep the agent_id
// fallback, because a report from an agent that plainly is not the holder is
// still real evidence for those two.
//
// That agent_id check was never enough on its own, and `dispatch_id` cannot
// always fill the gap either: a same-agent retry (the SAME evaluator run
// twice, a killed worker leg redispatched to the identical worker) reads
// identical by agent_id on both legs, and if the OUTCOME line was written
// before dispatch_id existed on it — or by the generic writer without one —
// there is nothing left to compare against the holder's dispatch_id at all.
// Fail-open there let a dead leg's late, unlabeled `reviewed pass` clear
// pull-controller's gate while the live retry was still running
// (retro-release-review, 2026-08-04, F1).
//
// `task_id` closes that gap `dispatch_id` cannot. `assigned` is required to
// carry one (§4), and every outcome this matters for — `delivered`, `lost`,
// and a harvester-written `reviewed` — carries the SAME task_id its own leg
// was opened under (loop-runner.mjs:443 stamps `task_id: last.task_id` on
// every harvested event, `reviewed` included). So an outcome that names a
// task_id can be traced back to the exact `assigned` line that started its
// leg, and compared against the `assigned` line that made the CURRENT holder
// the holder — same leg, trust it; a different one, a newer leg has started
// since and this outcome is not evidence about where the token is now. That
// is the same judgment `dispatch_id` makes, reached from a signal that was
// already required to exist.
//
// A `reviewed` with no task_id either (the shorthand this system still
// writes when a review rides straight on a worker's delivery, with no
// `assigned` of the evaluator's own to look up) has no identity signal left
// at all — house rule: a branch that cannot answer says UNKNOWN, not "stale".
// It is trusted exactly as before, unconditionally. `delivered`/`lost`
// without a resolvable task_id fall back to the plain agent-identity check
// they always used.
const LEG_OUTCOMES = new Set(['delivered', 'lost', 'reviewed'])

export function currentEntry(custody) {
  let holder = null
  let holderDispatchId = null
  let holderAssignedIndex = -1
  for (let i = custody.length - 1; i >= 0; i -= 1) {
    if (custody[i].event === 'assigned' && custody[i].agent_id) {
      holder = String(custody[i].agent_id)
      holderDispatchId = custody[i].dispatch_id || null
      holderAssignedIndex = i
      break
    }
  }
  if (holder === null) return custody[custody.length - 1]

  // Every leg's own starting line, keyed by the task_id it was opened under.
  // Built once so a long ledger does not re-scan itself for every trailing
  // outcome that needs to look one up.
  const assignedIndexByTask = new Map()
  custody.forEach((entry, index) => {
    if (entry.event === 'assigned' && entry.task_id !== undefined && entry.task_id !== null) {
      assignedIndexByTask.set(String(entry.task_id), index)
    }
  })

  for (let i = custody.length - 1; i >= 0; i -= 1) {
    const entry = custody[i]
    if (!LEG_OUTCOMES.has(entry.event)) return entry
    if (entry.dispatch_id && holderDispatchId) {
      if (String(entry.dispatch_id) === String(holderDispatchId)) return entry
      continue
    }
    const ownIndex = entry.task_id !== undefined && entry.task_id !== null
      && assignedIndexByTask.has(String(entry.task_id))
      ? assignedIndexByTask.get(String(entry.task_id))
      : null
    if (ownIndex !== null) {
      if (ownIndex === holderAssignedIndex) return entry
      continue
    }
    const supersededLeg = entry.event !== 'reviewed'
      && entry.agent_id && String(entry.agent_id) !== holder
    if (!supersededLeg) return entry
  }
  return custody[custody.length - 1]
}

export function teamOccupancy(graph, items) {
  const teamOf = new Map()
  for (const team of graph.teams) {
    for (const agent of team.agents) teamOf.set(agent.agent_id, team.team_id)
  }
  const counts = new Map(graph.teams.map((team) => [team.team_id, 0]))
  const held = new Map(graph.teams.map((team) => [team.team_id, []]))
  const orphans = []
  for (const item of items.values()) {
    const last = currentEntry(item.custody)
    if (!last) continue
    // The route is closed, so nobody is holding it. Counting a finished token
    // as unplaceable is how the page ended up accusing its own completed work
    // of being an error.
    if (RELEASING_EVENTS.has(last.event)) continue
    const teamId = teamOf.get(last.agent_id) ?? last.to_team ?? null
    if (teamId === null || !counts.has(teamId)) {
      // A token whose agent or workflow no longer exists in the declared graph
      // is unplaceable. It is surfaced, never silently dropped.
      orphans.push({ work_item: item.work_item, event: last.event, agent_id: last.agent_id || '', workflow: item.workflow || '' })
      continue
    }
    counts.set(teamId, counts.get(teamId) + 1)
    held.get(teamId).push(item.work_item)
  }
  return { counts, held, orphans }
}
