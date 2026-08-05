// token-projection.mjs — the one shape every reader of a token's own custody
// should consume, instead of folding the same events its own way.
//
// D2: nine modules under this directory each read a token's ledger, and past
// "who holds it now" — the one placement question §6 of the contract already
// centralised into dispatch-facts.mjs's current-leg and per-team occupancy
// functions — every reader that needed anything more (when a token entered
// its PRESENT placement, where that placement was pulled from, what its own
// intake history says) re-derived it inline, in whichever file happened to
// need it first.
//
// This module is that missing shape. It takes ONE token's already-read item
// — the object the shared work-item reader in dispatch-facts.mjs hands back
// — and returns facts derivable from that token's OWN custody array alone:
// no graph declaration, no wall clock, no other token's state. Anything that
// needs those (a human-readable state sentence, "how long has it been
// sitting here" against now, whether a team is at its WIP limit) stays
// exactly where it already lived — in the reader that has the graph and the
// clock, not here. A projection that tried to answer those too would be
// answering a question no single token's ledger can answer by itself.
//
// Deliberately excluded, and why:
//   * per-team occupancy (dispatch-facts.mjs's cross-token aggregate) — this
//     file answers about ONE token; a team's occupancy is built by folding
//     MANY tokens' projections together, which is a second, later step this
//     item does not take (moving every reader onto that step at once is
//     exactly the "rewrite with no way to tell which move broke what" this
//     item was scoped to avoid).
//   * `.tmux-teams/decisions/latest.json` (contract §11.3) — a different
//     file, on a different write cadence (the whole file is overwritten once
//     per tick, never appended), answering why the RUNNER passed over a
//     token on ONE tick. No reader of a custody ledger asks that question,
//     and it is not evidence a token carries about itself — it is evidence
//     about a tick that read the token and moved on.
//   * ledger structural validity — a byte-level judgment over raw lines,
//     already owned by ledger-validate.mjs's own gate, not a fact about a
//     believed-valid token's history.
import { currentEntry, RELEASING_EVENTS } from './dispatch-facts.mjs'

const RUNNER_ACTOR = 'agent:runner'
const PLACING_EVENTS = new Set(['opened', 'pulled', 'returned'])

/**
 * One token's own custody, in the shape every reader that only needs THIS
 * token's evidence — never the graph, never the clock, never another
 * token — should read from.
 *
 * @param {{work_item?: string, workflow?: string, custody: object[],
 *          lead_sec?: number|null, legs?: number}} item — the entry
 *        dispatch-facts.mjs's shared work-item reader already produced for
 *        one token; this function adds nothing to disk I/O, it only folds
 *        what that item already carries.
 * @returns {{
 *   work_item: string, workflow: string,
 *   current: object|undefined, releasing: boolean,
 *   placed_at: object|null, pulled_from: string|null,
 *   lead_sec: number|null, legs: number,
 *   requester: string|null,
 *   questions: {at: string, categories: string[], answered_seconds: number|null}[],
 *   withdrawn_by_runner: boolean,
 * }}
 */
export function projectToken(item) {
  const custody = item.custody || []

  // Who holds it now, and is the route still open. The ONLY permitted
  // placement read (contract §6) — reused, never re-derived.
  const current = currentEntry(custody)
  const releasing = Boolean(current) && RELEASING_EVENTS.has(current.event)

  // When the token entered its PRESENT placement: the newest opened/pulled/
  // returned line, else the first line ever recorded. A token still in its
  // very first placement was never pulled into it, so that fallback is a
  // real case, not a theoretical one (kanban.mjs's own fold, unchanged).
  let placedAt = custody.length ? custody[0] : null
  for (let i = custody.length - 1; i >= 0; i -= 1) {
    if (PLACING_EVENTS.has(custody[i].event)) { placedAt = custody[i]; break }
  }

  // Where the token's current placement was pulled FROM, if it was pulled
  // at all (an admitted token's first placement has no such origin).
  let pulledFrom = null
  for (let i = custody.length - 1; i >= 0; i -= 1) {
    if (custody[i].event === 'pulled') { pulledFrom = custody[i].from_team || null; break }
  }

  // The token's own intake history: who asked for it, and every time it was
  // sent back for detail — which categories, and how long the person took to
  // answer, when they did. Counted per ASKING, not per token: two askings
  // about the same category are two data points, not one.
  const opened = custody.find((entry) => entry.event === 'opened') || null
  const questions = []
  let withdrawnByRunner = false
  let asked = null
  for (const entry of custody) {
    if (entry.event === 'questioned') {
      asked = { at: entry.at || '', categories: entry.categories || [], answered_seconds: null }
      questions.push(asked)
    }
    if (entry.event === 'answered' && asked) {
      const seconds = (Date.parse(entry.at || '') - Date.parse(asked.at || '')) / 1000
      // Only a real, forward-moving gap. A backwards one means a ledger that
      // failed contract §4.4, and folding it in would quietly poison the
      // number this projection exists to hand a caller honestly.
      if (Number.isFinite(seconds) && seconds >= 0) asked.answered_seconds = Math.round(seconds)
      asked = null
    }
    // The runner's own close — a lapsed deadline. The controller's `abandon`
    // verdict writes the same event word; `actor` is what tells them apart
    // (contract §9), and counting the controller's decision as a lapsed
    // request would misreport what actually happened.
    if (entry.event === 'abandoned' && String(entry.actor || '') === RUNNER_ACTOR) withdrawnByRunner = true
  }

  return {
    work_item: item.work_item ?? '',
    workflow: item.workflow || '',
    current,
    releasing,
    placed_at: placedAt,
    pulled_from: pulledFrom,
    lead_sec: item.lead_sec ?? null,
    legs: item.legs ?? 0,
    requester: opened ? String(opened.actor || 'unknown') : null,
    questions,
    withdrawn_by_runner: withdrawnByRunner,
  }
}
