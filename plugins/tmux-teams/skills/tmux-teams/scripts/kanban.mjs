// kanban.mjs — the kanban board: where every work item actually is.
//
// graph.html answers "who exists and how is the team wired". This page
// answers the other question, and only that one: which team is holding what,
// what is blocked, and how long it has been sitting. Merging the two has been
// rejected once already; they are different questions.
//
// Two inputs, both already owned by somebody else:
//   DECLARATION  the team graph — columns, names and WIP limits.
//   EVIDENCE     the custody ledgers — one append-only file per token.
//
// Three rules this file does not get to reinterpret:
//   * WHERE a token is comes from `teamOccupancy`. This page reads its `held`
//     map; it never maps agent -> team a second time. Two readers computing
//     that separately is how a board and a controller came to disagree.
//   * WHO IS BLOCKING comes from `planPulls`. Same reason.
//   * WHAT TIME IT IS comes from the caller. Nothing here calls Date.now(),
//     so `check`, `init` and pulse all read one clock: snapshot.generated_at.
//
// A number that cannot be computed from a recorded event prints `unknown`.
// Never `0` — "not measured" and "zero" are different facts.
//
// No <svg> on this page: every inline SVG needs xmlns="http://www.w3.org/2000/
// svg", and this page must not reference an http URL at all. A board is
// columns and cards; flexbox already draws that.
//
// Copy is English: these pages get shared outside the team.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KANIT_FONT_CSS } from '../assets/kanit/kanit-embedded.mjs'
import { RELEASING_EVENTS, readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { projectToken } from './token-projection.mjs'
import { planPulls } from './pull-controller.mjs'
import { validateLedgerFileTolerant } from './ledger-validate.mjs'
import { ledgerPath } from './ledger-writer.mjs'
import { clip, duration, esc, readWorkflowGraph } from './graph.mjs'
import { NAV_CSS, renderNav } from './page-nav.mjs'
import { WORKFLOW_GRAPH_FILE, teamRoleOf } from './workflow-graph.mjs'

const FONT_CSS_NAME = `pulse-fonts-${createHash('sha256').update(KANIT_FONT_CSS).digest('hex')}.css`

// Only these three decisions describe something already recorded. `pull` and
// `complete` are what the runner *will* do next tick — printing them would put
// a future on a card that only ever states the past.
// `invalid` belongs here for the same reason as the other three and was the one
// the board did not know (§14.2 item 2): the pull controller refuses to move a
// token whose own history cannot be believed, and until this line the board drew
// it as an ordinary card. A token the loop will not touch, rendered as one it is
// working on, is the exact disagreement between board and loop this file exists
// to prevent.
// `target_rejected` joins the set for the same reason (retro-release-review,
// 2026-08-04, H3): pull-controller.mjs now holds a `reviewed pass` whose
// TARGET_VERDICT says the target is not done instead of pulling it, and the
// board must draw that hold rather than an ordinary "waiting to be pulled".
const BLOCKING_ACTIONS = new Set(['blocked', 'failed', 'skip', 'invalid', 'target_rejected'])

const slug = (value) => String(value ?? '').replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40) || 'none'

// ── the card's state, in the runner's own vocabulary ─────────────────────────
// One line per event the runner can append. An event nobody taught this
// function about is printed raw rather than silently rendered as blank.
// Exported so its vocabulary can be checked by calling it, rather than by
// rendering a page and grepping the markup for `Unknown event`. The question
// was always "does this function have a case for every word" — routing it
// through HTML made a behaviour test look like a presentation test, and tied
// it to copy that is allowed to change.
export function stateOf(graph, last) {
  const role = teamRoleOf(graph, last.agent_id || '')?.role ?? null
  const reason = last.reason || null
  switch (last.event) {
    // Both arrivals leave the work in the same place — with a dispatcher who
    // has not judged it yet — so the card answers the reader's one question the
    // same way. Where it came from is the ledger's business, not the card's.
    case 'opened':
    case 'pulled':
      return { state: 'Waiting for intake', detail: reason }
    case 'intake':
      return last.verdict === 'accept'
        ? { state: 'Accepted — waiting for a worker', detail: reason }
        : { state: 'Intake verdict unstated', detail: reason }
    case 'assigned':
      return { state: 'Being worked', detail: last.task_id ? `task ${last.task_id}` : null }
    case 'delivered':
      // A leg that ended without an artifact is stuck, not finished. The
      // terminal is named on the card because that word is what a rerun needs.
      if (last.terminal && last.terminal !== 'done') {
        return { state: `Failed leg — needs a rerun (${last.terminal})`, detail: reason }
      }
      return role === 'dispatcher' || role === 'evaluator'
        ? { state: 'Leg finished — waiting to be harvested', detail: reason }
        : { state: 'Delivered — waiting for review', detail: reason }
    case 'reviewed':
      if (last.verdict === 'pass') {
        // GitHub #31 stage 2: the evaluator's own VERDICT passed (the worker
        // judged the target correctly) but TARGET_VERDICT: reject says the
        // target itself is not done. pull-controller.mjs holds it rather than
        // pulling it onward (retro-release-review, 2026-08-04, H3) — the card
        // must say so, not read the same as an ordinary pass.
        if (last.target_verdict === 'reject') {
          return { state: 'Target rejected — held, not handed onward', detail: last.target_reason || reason }
        }
        return { state: 'Passed review — waiting to be pulled onward', detail: reason }
      }
      if (last.verdict === 'reject') return { state: 'Rejected — rework in this team', detail: reason }
      return { state: 'Review verdict unstated', detail: reason }
    case 'returned':
      return {
        state: 'Returned by the next team',
        detail: `refused by ${last.refused_by || 'unknown'} — ${reason || 'no reason stated'}`,
      }
    case 'lost':
      return { state: 'Leg lost — no process, nothing delivered', detail: reason }
    case 'escalated':
      return { state: 'Escalated to the outer controller', detail: reason }
    case 'resumed':
      return { state: 'Resumed by the outer controller', detail: reason }
    case 'completed':
      // Half closed, not finished (§5): the outer controller still has to read
      // the delivery as a whole, and until it has, "Completed" is the route's
      // own word for itself rather than a verdict anyone checked.
      return {
        state: 'Completed — not yet audited',
        detail: last.from_team ? `finished at ${last.from_team}` : null,
      }
    case 'audit_requested':
      return { state: 'Waiting for the outer controller to read it', detail: reason }
    case 'audited':
      // The audit is the last word on a route and it was going nowhere: with no
      // case here it fell through to `Unknown event: audited`, so a route the PM
      // had read and raised concerns about was unreadable on the board that
      // exists to report exactly that. `concern` is not a failure — it is work
      // for a human — so it says so instead of borrowing a failure's vocabulary.
      return last.verdict === 'accept'
        ? { state: 'Audited — accepted', detail: reason }
        : { state: `Audited — ${last.verdict || 'no verdict'}: needs a human`, detail: reason }
    case 'abandoned':
      return { state: 'Abandoned', detail: reason }
    // The two states whose next move belongs to a PERSON. Everything else on
    // this board is waiting on an agent or on the loop, and a reader who cannot
    // tell those apart does not know whether to go and do something.
    case 'questioned':
      return {
        state: 'Waiting on a person to answer',
        detail: last.questions ? `asked: ${last.questions}` : reason,
      }
    case 'answered':
      return { state: 'Answered — back through the intake gate', detail: reason }
    default:
      return { state: `Unknown event: ${last.event || 'none'}`, detail: reason }
  }
}

// "How long has it been sitting HERE" needs the event that put it here. A token
// that started in the first team of its route was never pulled into it, so the
// fallback to the first recorded event is a real case, not a theoretical one.
// D2: that fold now lives once, in token-projection.mjs's `placed_at` — this
// file only decides whether it applies (a token not currently IN a team has
// no "here" to measure, so it reads its own current entry instead).
function cardOf(graph, item, { nowMs, inTeam, blockedReason }) {
  // Same entry the placement answers by: a card that reads its own state off a
  // superseded leg's late `delivered` shows a token working somewhere it left.
  const projected = projectToken(item)
  const last = projected.current
  const placed = inTeam ? projected.placed_at : last
  const placedMs = Date.parse(placed.at || '')
  const { state, detail } = stateOf(graph, last)
  return {
    work_item: item.work_item,
    workflow: item.workflow || '',
    event: last.event || '',
    // The judgement, separate from the sentence written about it. `s-audited`
    // cannot tell an accepted route from one a human still has to settle, and
    // reading that difference out of the visible text makes every reader — a
    // test, a script, a future page — depend on the exact words we chose today.
    verdict: last.verdict || '',
    state,
    detail: detail === null ? null : clip(detail, 120),
    agent_id: last.agent_id || '',
    role: teamRoleOf(graph, last.agent_id || '')?.role ?? null,
    column_sec: Number.isFinite(nowMs) && Number.isFinite(placedMs)
      ? Math.max(0, Math.round((nowMs - placedMs) / 1000))
      : null,
    lead_sec: item.lead_sec,
    legs: item.legs,
    blocked_reason: blockedReason ?? null,
    at: last.at || '',
    placed_at: placed.at || '',
  }
}

const byPlacedThenId = (a, b) =>
  String(a.placed_at).localeCompare(String(b.placed_at)) || a.work_item.localeCompare(b.work_item)

export function readBoard(repo, now) {
  const graph = readWorkflowGraph(repo)
  if (!graph.ok) {
    return {
      ok: false, reason: graph.reason, graph_source: graph.source, now: null,
      columns: [], unplaceable: [], skippedLines: 0,
      counts: { in_flight: 0, done: 0, unplaceable: 0 },
    }
  }
  const value = graph.value
  const { items, skippedLines } = readWorkItems(repo)
  const occupancy = teamOccupancy(value, items)
  const nowMs = Date.parse(now || '')

  const blocked = new Map()
  for (const decision of planPulls(value, items, now || '')) {
    if (BLOCKING_ACTIONS.has(decision.action)) blocked.set(decision.work_item, decision.reason)
  }
  // H5 (retro-release-review, 2026-08-04): `planPulls` only validates a
  // token's ledger once that token reaches its own "is this ready to move"
  // check — an `opened` token sitting on an invalid line (a missing required
  // field, say) never reaches that check, so it never got an `invalid`
  // decision and the board drew it as ordinary "Waiting for intake" while
  // `loop-runner.mjs` would refuse to dispatch it forever. Every item's ledger
  // is checked here too, independently of what state it is in, so an invalid
  // ledger is visibly blocked the moment it exists rather than only once it
  // happens to reach the pull gate.
  //
  // qwen #4, retro-release-review 2026-08-04: this used to call `validateLedger`
  // straight, so a ledger the writer, the pull controller and the runner all
  // accept — because its only problems are legacy-tolerated (B5,
  // `LEGACY_TOLERATED_PROBLEMS`) — still drew a "needs repair" blocker here.
  // An `opened` signed `agent:` from before ADR 0002 disagreed with the loop
  // in exactly the way this file exists to prevent (`kanban.mjs:49-52`
  // above). `validateLedgerFileTolerant` is the same shared judgment
  // `loop-runner.mjs`'s tick reads (see its comment), so this board can no
  // longer flag as broken a ledger the rest of the system has agreed to
  // trust. `blocking`, not `problems`, is what actually stops the ledger from
  // being believed — `problems` still carries every legacy-tolerated defect,
  // which is not what an operator needs to repair.
  //
  // codex, retro-release-review round 4 (HIGH 6): this used to validate
  // `item.custody` — the object `readWorkItems` already parsed AND SANITIZED,
  // silently dropping any unparsable line into the global `skippedLines`
  // counter before this loop ever ran. Re-serializing those SURVIVORS and
  // validating that reconstruction answers "are the lines that parsed OK
  // consistent with each other", never "is this ledger file OK" — a token
  // whose only problem is one garbage line answered clean here while
  // `loop-runner.mjs`'s tick, which validates the FILE `validateLedgerFile`
  // reads, refused to dispatch it. Reading the same path `ledger-writer.mjs`
  // wrote and every other blocking-judgment reader validates is what makes
  // this board judge the same bytes the loop does, rather than a cleaned-up
  // copy of them.
  for (const item of items.values()) {
    if (blocked.has(item.work_item)) continue
    const verdict = validateLedgerFileTolerant(ledgerPath(repo, item.work_item))
    if (!verdict.ok) {
      const [first] = verdict.blocking
      blocked.set(item.work_item,
        `its ledger has ${verdict.blocking.length} problem(s) and needs repair — line ${first.line} ${first.code}: ${first.detail}`)
    }
  }

  const columns = value.teams.map((team) => {
    const wip = occupancy.counts.get(team.team_id) ?? 0
    return {
      kind: 'team', team_id: team.team_id, name: team.name,
      wip, wip_limit: team.wip_limit, at_limit: wip >= team.wip_limit, cards: [],
    }
  })
  const byTeam = new Map(columns.map((column) => [column.team_id, column]))
  const done = { kind: 'done', team_id: null, name: 'Done', wip: null, wip_limit: null, at_limit: false, cards: [] }
  const unplaceable = []

  // `held` IS the placement rule's answer. Reading it, rather than re-deriving
  // the team from agent_id, is what makes AC2 true by construction.
  const placedIn = new Map()
  for (const [teamId, tokens] of occupancy.held) {
    for (const token of tokens) placedIn.set(token, teamId)
  }

  for (const item of items.values()) {
    // M3 (retro-release-review, 2026-08-04): this used to read the raw last
    // line (`item.custody[item.custody.length - 1]`) while `teamOccupancy`
    // (which built `placedIn` above) and `cardOf` below both read
    // `currentEntry`. A stale leg outcome trailing a genuinely current
    // `completed`/`answered`/etc. made this loop's own Done/unplaceable
    // classification disagree with the card describing the very same token —
    // "Completed" on a card filed under Unplaceable. §6 exists precisely so a
    // superseded leg's late outcome does not get read as current; reading it
    // here defeated that everywhere it mattered for this loop.
    const last = projectToken(item).current
    const teamId = placedIn.get(item.work_item) ?? null
    const inTeam = !RELEASING_EVENTS.has(last.event) && teamId !== null
    const card = cardOf(graph.value, item, {
      nowMs, inTeam, blockedReason: inTeam ? blocked.get(item.work_item) ?? null : null,
    })
    // Exactly one home per token: the route is closed, or a team is holding it,
    // or nothing in the declared graph can place it. Never two, never none.
    if (RELEASING_EVENTS.has(last.event)) done.cards.push(card)
    else if (inTeam) byTeam.get(teamId).cards.push(card)
    else unplaceable.push(card)
  }

  // Longest wait on top. `held` arrives in readdir order, which is not stable
  // between runs — unsorted, the board would reshuffle itself every refresh.
  for (const column of [...columns, done]) column.cards.sort(byPlacedThenId)
  unplaceable.sort(byPlacedThenId)

  return {
    ok: true, reason: null, graph_source: graph.source,
    now: Number.isFinite(nowMs) ? now : null,
    columns: [...columns, done],
    unplaceable,
    skippedLines,
    counts: {
      in_flight: [...occupancy.counts.values()].reduce((sum, n) => sum + n, 0),
      done: done.cards.length,
      unplaceable: occupancy.orphans.length,
    },
  }
}

// ── the page ────────────────────────────────────────────────────────────────
const STYLE = `
:root{color-scheme:light dark;
--bg:oklch(97% .008 165);--surface:oklch(99% .004 165);--surface-2:oklch(95% .012 165);
--line:oklch(87% .014 165);--ink:oklch(24% .018 165);--dim:oklch(50% .022 165);
--ok:oklch(50% .12 165);--warn:oklch(53% .13 72);--bad:oklch(52% .16 28);--focus:oklch(52% .13 235);
--busy:oklch(52% .13 235);--wait:oklch(48% .14 300);
--sans:"Kanit","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--s2:8px;--s3:12px;--s4:16px;--s5:24px;--r:14px}
@media (prefers-color-scheme:dark){:root{
--bg:oklch(17% .012 165);--surface:oklch(21% .014 165);--surface-2:oklch(24% .015 165);
--line:oklch(34% .014 165);--ink:oklch(93% .012 165);--dim:oklch(71% .018 165);
--ok:oklch(74% .13 165);--warn:oklch(78% .13 78);--bad:oklch(72% .16 28);--focus:oklch(78% .12 235);
--busy:oklch(78% .12 235);--wait:oklch(74% .14 300)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.6 var(--sans);overflow-x:hidden}
${NAV_CSS}
.topbar{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;
 gap:var(--s3);padding:var(--s3) var(--s5);border-bottom:1px solid var(--line);background:var(--surface)}
.topbar h1{margin:0;font:600 1.1rem/1.3 var(--sans)}
.topbar h1 .repo{color:var(--dim);font-weight:400}
.meta{margin:0;color:var(--dim);font-size:.8rem}
.meta code{font-family:var(--mono);font-size:.76rem}
.refresh{display:flex;align-items:center;gap:var(--s3);margin:0;color:var(--dim);font-size:.78rem}
.refresh .pause{padding:2px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);
 color:var(--ink);font:500 .74rem var(--sans);cursor:pointer}
.refresh .pause:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.orphans{margin:0;padding:var(--s3) var(--s5);background:var(--surface-2);
 border-bottom:1px solid var(--bad);color:var(--bad);font-size:.8rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s3);padding:var(--s4) var(--s5) 0}
.tile{display:grid;gap:2px;padding:var(--s4);background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.tile-v{font:600 1.5rem/1 var(--sans);font-variant-numeric:tabular-nums}
.tile-l{color:var(--dim);font-size:.8rem}
.t-ok .tile-v{color:var(--ok)}.t-warn .tile-v{color:var(--warn)}.t-bad .tile-v{color:var(--bad)}
.board{display:flex;gap:16px;overflow-x:auto;padding:var(--s4) var(--s5);scrollbar-width:thin;align-items:flex-start}
.col{flex:0 0 300px;display:flex;flex-direction:column;gap:var(--s2);
 padding:var(--s3);background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r)}
.col-full{border-color:var(--warn)}
.col-none .colhead h2{color:var(--bad)}
.colhead{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s2)}
.colhead h2{margin:0;font:600 .95rem var(--sans)}
.wip{color:var(--dim);font:500 .74rem var(--mono);font-variant-numeric:tabular-nums}
.col-full .wip{color:var(--warn)}
.empty{color:var(--dim);font-size:.78rem;padding:var(--s2) 0}
.card{display:grid;gap:2px;padding:10px 12px;background:var(--surface);
 border:1px solid var(--line);border-left:4px solid var(--dim);border-radius:10px}
.card .tok{font:600 .78rem var(--mono);word-break:break-all}
.card .wf{color:var(--dim);font:400 .68rem var(--mono)}
.card .st{font:500 .78rem var(--sans)}
.card .ev{color:var(--dim);font:400 .68rem var(--mono)}
.card .who{color:var(--dim);font:400 .68rem var(--mono);word-break:break-all}
.card .clock{color:var(--dim);font:400 .68rem var(--mono);font-variant-numeric:tabular-nums}
.card .at{color:var(--dim);font:400 .68rem var(--mono);font-variant-numeric:tabular-nums}
.card .at-bad{color:var(--bad);font:400 .68rem var(--mono);word-break:break-all}
.card .detail{color:var(--dim);font-size:.72rem}
.card .blocked{color:var(--warn);font:500 .72rem var(--sans)}
.s-assigned{border-left-color:var(--busy)}
.s-pulled,.s-intake,.s-reviewed{border-left-color:var(--wait)}
.s-delivered{border-left-color:var(--ok)}
.s-returned,.s-lost,.s-escalated{border-left-color:var(--bad)}
.s-completed{border-left-color:var(--ok)}
.s-abandoned{border-left-color:var(--dim);opacity:.75}
.is-blocked{border-left-color:var(--warn)}
.legend{display:grid;gap:6px;margin:0 var(--s5) var(--s5);padding:var(--s4);background:var(--surface-2);
 border:1px solid var(--line);border-radius:var(--r);font-size:.8rem}
.legend b{font-weight:600}
.warnbox{margin:var(--s5);padding:var(--s4);border:1px solid var(--bad);border-radius:var(--r);font-size:.9rem}
footer{margin:0 var(--s5) var(--s5);color:var(--dim);font-size:.78rem}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

// Every state is stated in words on the card as well as in the border colour.
// Colour alone fails greyscale printing and fails colour-blind readers.
const LEGEND = [
  'Waiting for intake — a team pulled it; its dispatcher has not answered yet.',
  'Accepted — waiting for a worker — the dispatcher took it into this team.',
  'Being worked — an agent is assigned and has not reported back.',
  "Delivered — waiting for review — the worker finished; this team's evaluator has not judged it.",
  'Leg finished — waiting to be harvested — a dispatcher or evaluator leg ended; the runner has not turned it into a verdict yet.',
  'Failed leg — needs a rerun — the leg ended without an artifact; nothing moves forward until it is rerun.',
  'Passed review — waiting to be pulled onward — this team is done; the next team takes it when it has room.',
  'Rejected — rework in this team — the evaluator sent it back to a worker here.',
  'Returned by the next team — the receiving dispatcher refused the handoff.',
  'Leg lost — no process, nothing delivered — the runner found no live process and no result.',
  'Escalated to the outer controller — the loop ran out of moves and handed it to the PM; the team still holds the token.',
  'Resumed by the outer controller — the PM sent it back into the team it was parked in.',
  'Completed — the route finished. Abandoned — nobody will finish it; closed honestly rather than left holding a team.',
]

const clock = (card) =>
  `${duration(card.column_sec) ?? 'unknown'} here · ${duration(card.lead_sec) ?? 'unknown'} lead · ${card.legs} legs`

// The board's own clock is relative — "4m here" — which is what a board is read
// for. The absolute stamp is the one fact a reader needs the moment they leave
// the board and go looking in a ledger, and it lived only in a `title`: on a
// touch screen, or for anyone driving this by keyboard, it did not exist at all.
//
// `Date.parse` is not a validator: it silently normalises a calendar-impossible
// stamp (`2026-02-29` in a year that has no leap day, an hour of `24`) into the
// next real instant, and it accepts bytes — `"0"`, a bare year — that are not a
// ledger timestamp at all. A board built on that would turn corrupt evidence
// into a precise-looking fact with nothing to say it did. This regex fixes the
// shape the ledger contract requires (ISO 8601, UTC, `Z`), and the component
// round-trip below refuses anything the shape check would otherwise launder.
const ISO_UTC_STRICT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/

// Returns null for anything that is not a real UTC instant — never a
// best-effort guess. `ms` is the parsed instant for the relative clock;
// `htmlDatetime` is a separate value because HTML's `datetime` microsyntax
// caps at millisecond precision while the ledger may carry up to nanoseconds,
// and truncating the ledger's own field would be the same laundering this
// exists to stop.
const parseUtc = (raw) => {
  const match = ISO_UTC_STRICT_RE.exec(raw)
  if (!match) return null
  const [, y, mo, d, h, mi, s, frac = ''] = match
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (!Number.isFinite(ms)) return null
  const rolled = new Date(ms)
  // `Date.UTC` performs the same silent rollover `Date.parse` does — this reads
  // the components back off the instant it produced and requires them to match
  // what was typed. A mismatch means the input described a day that does not
  // exist, which is exactly the case a shape-only regex cannot catch.
  if (
    rolled.getUTCFullYear() !== Number(y) || rolled.getUTCMonth() !== Number(mo) - 1 ||
    rolled.getUTCDate() !== Number(d) || rolled.getUTCHours() !== Number(h) ||
    rolled.getUTCMinutes() !== Number(mi) || rolled.getUTCSeconds() !== Number(s)
  ) return null
  const millis = frac.padEnd(3, '0').slice(0, 3)
  return { ms, htmlDatetime: `${y}-${mo}-${d}T${h}:${mi}:${s}.${millis}Z` }
}

// datetime keeps the precision HTML's microsyntax actually accepts; the text
// keeps the minute a person reads. A stamp that fails validation is reported,
// not hidden — the ledger said something happened at a time that cannot exist,
// and a blank card would erase that a lie was told at all.
const absoluteAt = (raw) => {
  if (!raw) return null
  const parsed = parseUtc(raw)
  if (!parsed) return { ok: false, raw }
  const [, y, mo, d, h, mi] = ISO_UTC_STRICT_RE.exec(raw)
  return { ok: true, htmlDatetime: parsed.htmlDatetime, text: `${y}-${mo}-${d} ${h}:${mi} UTC` }
}

const renderCard = (card, unplaceableNote) => {
  const stamp = absoluteAt(card.at)
  // No `title`. A tooltip that repeats the text beside it is not a second copy
  // for redundancy — it overrides the accessible name, so a screen reader
  // announces the summary INSTEAD of the card. The full token id and the
  // stamp are printed on the card itself instead; the token's own `id` gives
  // the article an accessible name, because an article with no authored name
  // is unreadable in a screen reader's article list without opening each one.
  const tokId = `tok-${esc(card.work_item)}`
  return `
    <article class="card s-${slug(card.event)}${card.blocked_reason ? ' is-blocked' : ''}" data-event="${esc(card.event || 'none')}"${card.verdict ? ` data-verdict="${esc(card.verdict)}"` : ''} aria-labelledby="${tokId}">
      <b class="tok" id="${tokId}">${esc(clip(card.work_item, 128))}</b>
      <span class="wf">${esc(card.workflow ? clip(card.workflow, 40) : 'no workflow declared')}</span>
      <span class="st">${esc(card.state)}</span>
      <span class="ev">last event: ${esc(card.event || 'none')}</span>
      <span class="who">${esc(card.agent_id ? clip(card.agent_id, 40) : 'no agent recorded')} · ${esc(card.role || 'role not declared')}</span>
      <span class="clock">${esc(clock(card))}</span>${stamp?.ok ? `
      <time class="at" datetime="${esc(stamp.htmlDatetime)}">${esc(stamp.text)}</time>` : ''}${stamp && !stamp.ok ? `
      <span class="at-bad">Malformed timestamp: "${esc(clip(stamp.raw, 80))}"</span>` : ''}${card.detail ? `
      <span class="detail">${esc(card.detail)}</span>` : ''}${unplaceableNote ? `
      <span class="blocked">${esc(unplaceableNote)}</span>` : ''}${card.blocked_reason ? `
      <span class="blocked">Blocked — ${esc(clip(card.blocked_reason, 120))}</span>` : ''}
    </article>`
}

const unplaceableNote = (card) =>
  `Last event ${card.event || 'none'} · agent ${card.agent_id || 'unknown'} is not placeable in the declared graph`

const renderColumn = (column) => {
  const head = column.kind === 'team'
    ? `<span class="wip">WIP ${column.wip}/${column.wip_limit}${column.at_limit ? ' · at limit' : ''}</span>`
    : `<span class="wip">${column.cards.length} finished</span>`
  return `
  <section class="col${column.at_limit ? ' col-full' : ''}">
    <div class="colhead"><h2>${esc(column.name)}</h2>${head}</div>${
  column.cards.length ? column.cards.map((card) => renderCard(card, null)).join('') : '\n    <p class="empty">nothing here</p>'}
  </section>`
}

export function renderKanbanPage(repo, snapshot, { fontCssName = FONT_CSS_NAME, refreshScriptName = '' } = {}) {
  const repoName = snapshot.scope?.repo_name || ''
  // Without an explicit charset a plain file server hands this to the browser
  // as windows-1252 and every non-ASCII label turns to mojibake.
  const head = `<meta charset="utf-8">
<title>Kanban board · ${esc(repoName)}</title>
<meta name="tmux-teams-snapshot-id" content="${esc(snapshot.snapshot_id || '')}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${esc(fontCssName)}">
<style>${STYLE}</style>${refreshScriptName ? `\n<script src="${esc(refreshScriptName)}" defer></script>` : ''}`

  const board = readBoard(repo, snapshot.generated_at)
  if (!board.ok) {
    return `${head}
<h1>Team graph could not be read</h1>
<p class="warnbox"><code>.tmux-teams/${WORKFLOW_GRAPH_FILE}</code> failed the contract: ${esc(board.reason)}</p>
<p class="meta">Fix the file and regenerate Pulse, or delete it to fall back to the bundled four-team template.</p>`
  }

  const at = new Date(snapshot.generated_at)
  const observed = Number.isNaN(at.getTime()) ? 'unknown' : `${at.toISOString().replace('T', ' ').slice(0, 19)} UTC`
  const tile = (v, l, tone = '') =>
    `<div class="tile${tone ? ` t-${tone}` : ''}"><span class="tile-v">${esc(v)}</span><span class="tile-l">${esc(l)}</span></div>`

  const columns = board.columns.map(renderColumn).join('')
  const unplaceableColumn = board.unplaceable.length ? `
  <section class="col col-none">
    <div class="colhead"><h2>Unplaceable</h2><span class="wip">${board.unplaceable.length} tokens</span></div>${
  board.unplaceable.map((card) => renderCard(card, unplaceableNote(card))).join('')}
  </section>` : ''

  return `${head}
${renderNav('kanban')}
<header class="topbar" data-observation-expires-at="${esc(snapshot.observation?.expires_at || '')}" data-refresh-interval="${Number(snapshot.observation?.refresh_interval_sec) || 20}">
  <h1>Kanban board <span class="repo">${esc(repoName)}</span></h1>
  <p class="meta">graph: <code>${board.graph_source === 'default' ? 'bundled four-team template' : `.tmux-teams/${WORKFLOW_GRAPH_FILE}`}</code>
   · ${board.columns.length - 1} teams
   · evidence: <code>.tmux-teams/work-items/</code> · observed ${esc(observed)}</p>
  <p class="refresh"><span data-refresh-status role="status" aria-live="polite">Snapshot fresh</span>
   <button type="button" class="pause" data-refresh-toggle data-refresh-focus-key="refresh-toggle" aria-pressed="false">Pause updates</button>
   <span class="note" data-refresh-note>Polling the local snapshot marker</span></p>
</header>${board.graph_source === 'default' ? `
<p class="orphans" data-graph-undeclared="1"><strong>This repository has not declared its own loop.</strong> There is no <code>.tmux-teams/${WORKFLOW_GRAPH_FILE}</code>, so these columns are the bundled template, not this project's teams. The runner will not dispatch until a declaration exists (GitHub #48). Run the <code>graph-setup</code> skill to write one.</p>` : ''}${board.skippedLines ? `
<p class="orphans">${board.skippedLines} unreadable ledger line(s) skipped — this board is incomplete.</p>` : ''}
<section class="tiles">
  ${tile(board.counts.in_flight, 'work items in a team right now', board.counts.in_flight ? 'ok' : '')}
  ${tile(board.counts.done, 'routes closed')}
  ${tile(board.counts.unplaceable, 'tokens that cannot be placed', board.counts.unplaceable ? 'bad' : '')}
</section>
<div class="board" data-refresh-scroll-key="board">${columns}${unplaceableColumn}
</div>
<div class="legend"><b>What each state means</b>
${LEGEND.map((line) => `<span>${esc(line)}</span>`).join('\n')}</div>
<footer>Placement, WIP and blocked reasons come from the same functions the controller runs. Times come from ledger timestamps only; a time that cannot be computed says unknown. This board never dispatches, pulls or edits anything.</footer>`
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Both commands read the clock from `.tmux-teams/pulse.json`. There is
// deliberately no fallback: a second way to obtain "now" is a second clock, and
// this file exists partly to prove it only has one.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, repoArg] = process.argv.slice(2)
  const repo = repoArg || '.'

  if (command !== 'check' && command !== 'init') {
    console.error('usage: node kanban.mjs <check|init> [repo]')
    process.exit(2)
  }

  // The graph is checked before the snapshot: an invalid graph is this
  // command's own failure to report, not a missing-input problem.
  const graph = readWorkflowGraph(repo)
  if (!graph.ok) {
    console.error(`[kanban] invalid team graph (${graph.source}): ${graph.reason}`)
    process.exit(1)
  }

  const snapshotPath = join(repo, '.tmux-teams', 'pulse.json')
  let snapshot
  try { snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) } catch {
    console.error(`[kanban] no readable ${snapshotPath} — run: node pulse.mjs once ${repo} first`)
    process.exit(2)
  }

  if (command === 'check') {
    const board = readBoard(repo, snapshot.generated_at)
    console.log(`[kanban] ok (${board.graph_source}) — ${board.columns.length - 1} teams, ` +
      `${board.counts.in_flight} in flight, ${board.counts.done} done, ${board.counts.unplaceable} unplaceable`)
    for (const column of board.columns) {
      const cards = column.cards.map((card) => `${card.work_item} (${card.state})`).join(', ') || '—'
      const head = column.kind === 'team'
        ? `${column.name.padEnd(12)} WIP ${column.wip}/${column.wip_limit}${column.at_limit ? ' · at limit' : ''}`
        : column.name
      console.log(`[kanban]   ${head}: ${cards}`)
    }
    if (board.unplaceable.length) {
      console.log(`[kanban]   Unplaceable: ${board.unplaceable.map((card) => `${card.work_item} (${card.event || 'none'}, agent ${card.agent_id || 'unknown'})`).join(', ')}`)
    }
    if (board.skippedLines) console.log(`[kanban]   ${board.skippedLines} unreadable ledger line(s) skipped`)
  } else {
    // Regenerated output, not a config file a human edits — overwriting is the
    // point, so unlike graph.mjs init there is nothing to guard here.
    const target = join(repo, '.tmux-teams', 'kanban.html')
    writeFileSync(target, renderKanbanPage(repo, snapshot))
    console.log(`[kanban] wrote ${target}`)
  }
}
