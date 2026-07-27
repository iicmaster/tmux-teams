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
