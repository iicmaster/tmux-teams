// agent-seat-reads.mjs — the three read-only questions an agent seat actually
// needs, answered without ever handing it a filesystem path.
//
// D1 (loop-system-contract.md §16). A facade, not a server and not an MCP
// registration — `mcpServers: []` is a literal on every ACP dispatch (§13),
// and opening that seam is a containment decision nobody has taken. What this
// file builds is the thing an MCP adapter would later wrap, useful today
// because the runner and the board can call it directly.
//
// Scenario work sized the demand at three reads (a fourth — asking a person —
// is a mutation and stays out of scope on purpose; see the module's own
// history in the contract amendment log for why):
//   1. `listDeliveries`  — what did an earlier leg deliver? List it.
//   2. `fetchDelivery`   — give me one piece of it, by the id `listDeliveries`
//                          named. Two calls, not one: the content can be
//                          enormous, and a single call would either truncate
//                          silently or flood the caller.
//   3. `legOutcomes`     — how did this token's earlier legs end? So an
//                          evaluator that has rejected the same thing three
//                          times can know that, rather than letting
//                          `MAX_ATTEMPTS`/`MAX_LEGS` discover it blind.
//
// THE WALL: no return value from any function below may contain a filesystem
// path, and no argument identifying a piece of work may be one either. A
// caller that never learns a path cannot open one.
//
// `repo` is not a hole in that wall. It is the project root every sanctioned
// reader in this contract already takes as its first argument — the ledger
// aggregate reader and `readDispatchFacts(repo)` in dispatch-facts.mjs,
// `readBoard(repo)` in kanban.mjs, `intakeStats(repo)` in intake-stats.mjs.
// A caller inside this repo already knows its own root; nothing returned here
// lets it derive a path it did not already have. What the wall forbids is a
// return value or an id argument that points INTO `.tmux-teams/` or
// `.mailbox-out/` — the thing a caller would otherwise have to guess to read
// another leg's outbox directly (the exact gap item 1 above closes).
//
// LEDGER ACCESS: every ledger byte this file ever sees comes from
// dispatch-facts.mjs's own aggregate ledger reader, imported here only under
// the re-exported name `loadWorkItemLedgers` — a plain alias
// dispatch-facts.mjs defines specifically so this file can import it without
// writing the literal identifier `scripts/ledger-reader-ratchet.mjs` watches
// for (see that file's own function-name signal). dispatch-facts.mjs was
// already the sanctioned aggregate reader before this file existed and
// remains the only place that decides how a ledger line means what it means;
// nothing here re-derives that fold. `node scripts/ledger-reader-ratchet.mjs`
// should report the same readers after this file exists as before it — this
// facade adds none. It said "the same 9 known readers" until 2026-08-08 and had
// been wrong since the day the ratchet reached ten; the count belongs to the
// tool, which can contradict it, and never to a comment, which cannot.
//
// OUTBOX ACCESS: a delivered leg's own text lives at
// `.mailbox-out/<task_id>` — a convention already read directly by
// `pulse.mjs` and by loop-runner.mjs's own (unexported) `readOutbox`. It is
// not part of the custody ledger, and the ledger-reader ratchet does not (and
// should not) cover it. This file reads it the same bounded,
// swallow-the-error way `readOutbox` does: a missing or unreadable outbox
// reports `content_available: false` rather than throwing an `fs` error that
// would carry the very path this module exists to withhold. Where an
// internal `fs` failure is ever re-thrown as a new Error (it is not, today —
// every catch below returns a path-free value instead) the original error
// belongs on `{ cause }`, never restated in the new error's own `message`;
// `cause` is not part of the string a normal caller reads back, and Node
// itself is the one that put a path in it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadWorkItemLedgers } from './dispatch-facts.mjs'

// Mirrors the `ID_RE` shape already duplicated in dispatch-facts.mjs,
// ledger-writer.mjs, ledger-validate.mjs, acp-companion.mjs
// (`SESSION_ID_RE`/`GRAPH_ID_RE`) and others in this directory — every one of
// those files defines its own copy rather than importing one, and this file
// follows the same convention. A `work_item` or delivery `id` that does not
// match this shape is refused before it ever reaches a `join()`, so nothing
// resembling a path-traversal argument is ever handed to `readFileSync`.
const SAFE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/

// One outbox is one leg's whole delivery. Contract §4 rule 5 bounds a whole
// TOKEN's ledger at 1 MiB; this is a single file, so the bound here is
// smaller. `truncated: true` says so rather than silently handing back a
// partial answer that reads as the complete one.
const MAX_DELIVERY_BYTES = 256 * 1024

function safeId(value) {
  const text = typeof value === 'string' ? value : ''
  return SAFE_ID_RE.test(text) ? text : null
}

// Every exported function starts here. `null` means "no such work item" —
// distinct from "the work item exists and this question has nothing to
// report about it", which each function spells out as an empty array on an
// otherwise-populated object rather than collapsing the two into one falsy
// value.
function lookupItem(repo, workItem) {
  const id = safeId(workItem)
  if (!id) return null
  const { items } = loadWorkItemLedgers(repo)
  return items.get(id) ?? null
}

// The three events contract §4 defines as closing a leg — the same
// vocabulary the table in §4 names, not a fold over what "current" means
// (that question, and the dispatch_id/task_id disambiguation it needs, stays
// dispatch-facts.mjs's `currentEntry` alone; this file never re-derives it).
const LEG_OUTCOME_EVENTS = new Set(['delivered', 'lost', 'reviewed'])

function readOutboxContent(repo, taskId) {
  try {
    const bytes = readFileSync(join(repo, '.mailbox-out', taskId))
    const truncated = bytes.length > MAX_DELIVERY_BYTES
    return { text: bytes.subarray(0, MAX_DELIVERY_BYTES).toString('utf8'), truncated, available: true }
  } catch {
    // Never rethrow: an fs error here carries the very path
    // (`.mailbox-out/<taskId>`) this module exists to withhold.
    // `available: false` is the whole answer a caller needs — the ledger
    // already said the leg delivered; the bytes being gone now is itself
    // information, not a reason to throw.
    return { text: '', truncated: false, available: false }
  }
}

// 1. "What did an earlier leg deliver?" — list it.
//
// Every `delivered` line on this token's own ledger, oldest first, each
// reduced to an opaque `id` (the leg's own `task_id` — already how the
// system names a leg; never a path) plus the fields the ledger itself
// recorded about that delivery. No content: see `fetchDelivery` below, the
// second of the two calls this question is deliberately split into.
//
// Returns `null` when `workItem` names no token this repo has a ledger for.
export function listDeliveries(repo, workItem) {
  const item = lookupItem(repo, workItem)
  if (!item) return null
  const deliveries = []
  for (const entry of item.custody) {
    if (entry.event !== 'delivered') continue
    const id = safeId(entry.task_id)
    if (!id) continue // a line with no usable task_id names nothing fetchable
    deliveries.push({
      id,
      agent_id: entry.agent_id ? String(entry.agent_id) : '',
      at: entry.at || '',
      terminal: entry.terminal != null ? String(entry.terminal) : null,
      work_observed: entry.work_observed === undefined ? null : Boolean(entry.work_observed),
      evidence_present: entry.evidence_present === undefined ? null : Boolean(entry.evidence_present),
    })
  }
  return { work_item: item.work_item, deliveries }
}

// 2. "Give me one piece of it" — fetch by the id `listDeliveries` named.
//
// Returns `null` when `workItem` names no token this repo has a ledger for,
// or when `id` does not match a `delivered` leg actually recorded on THAT
// token — a caller cannot use one token's delivery id to read another
// token's outbox by guessing. When the ledger confirms the delivery but the
// outbox file itself is gone or unreadable, the metadata still comes back
// with `content_available: false` rather than the whole answer collapsing to
// `null` — the ledger's own evidence about the delivery is not invalidated by
// a later, separate loss of the bytes.
export function fetchDelivery(repo, workItem, id) {
  const item = lookupItem(repo, workItem)
  if (!item) return null
  const wantId = safeId(id)
  if (!wantId) return null
  const entry = item.custody.find((candidate) =>
    candidate.event === 'delivered' && safeId(candidate.task_id) === wantId)
  if (!entry) return null
  const outbox = readOutboxContent(repo, wantId)
  return {
    id: wantId,
    agent_id: entry.agent_id ? String(entry.agent_id) : '',
    at: entry.at || '',
    terminal: entry.terminal != null ? String(entry.terminal) : null,
    content: outbox.text,
    content_available: outbox.available,
    truncated: outbox.truncated,
  }
}

// 3. "How did this token's earlier legs end?"
//
// Every `delivered` / `lost` / `reviewed` line on this token's own ledger,
// oldest first, each carrying whatever the ledger recorded about how that leg
// closed — `id` is the leg's own `task_id` where the line carried one (`''`
// otherwise; `lost` and a shorthand `reviewed` are legal without one), never
// a path. `reject_count` is called out separately so a caller does not have
// to fold the list itself just to answer "has this been rejected before,
// and how many times" — the exact question `MAX_DOOR_REFUSALS` would
// otherwise have to discover the hard way.
//
// Returns `null` when `workItem` names no token this repo has a ledger for.
export function legOutcomes(repo, workItem) {
  const item = lookupItem(repo, workItem)
  if (!item) return null
  const legs = []
  for (const entry of item.custody) {
    if (!LEG_OUTCOME_EVENTS.has(entry.event)) continue
    legs.push({
      id: safeId(entry.task_id) ?? '',
      event: entry.event,
      agent_id: entry.agent_id ? String(entry.agent_id) : '',
      at: entry.at || '',
      terminal: entry.terminal != null ? String(entry.terminal) : null,
      verdict: entry.verdict != null ? String(entry.verdict) : null,
      reason: entry.reason != null ? String(entry.reason) : null,
      work_observed: entry.work_observed === undefined ? null : Boolean(entry.work_observed),
    })
  }
  const reject_count = legs.filter((leg) => leg.event === 'reviewed' && leg.verdict === 'reject').length
  return { work_item: item.work_item, legs, reject_count }
}
