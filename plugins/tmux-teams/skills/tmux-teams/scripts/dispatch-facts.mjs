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
export const RELEASING_EVENTS = new Set(['completed'])

export function teamOccupancy(graph, items) {
  const teamOf = new Map()
  for (const team of graph.teams) {
    for (const agent of team.agents) teamOf.set(agent.agent_id, team.team_id)
  }
  const counts = new Map(graph.teams.map((team) => [team.team_id, 0]))
  const held = new Map(graph.teams.map((team) => [team.team_id, []]))
  const orphans = []
  for (const item of items.values()) {
    const last = item.custody[item.custody.length - 1]
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
