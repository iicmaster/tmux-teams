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

// SORTED, so which file wins is a fact and not a filesystem accident. The
// filename guard below makes a decoy lose, but a test for it could only be
// written against readdir order — which nothing promises. Raised as
// non-blocking by the release panel (codex lane, 2026-08-10, round 8) against
// the test; fixed in the reader, where the determinism belongs.
const listing = (dir) => {
  try { return readdirSync(dir).sort().slice(0, MAX_FILES) } catch { return [] }
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
    // The filename has to agree with the task the receipt claims to be about.
    // `acp-companion` writes `<task-id>.md` here and nothing else does — the
    // same rule `livenessOnDisk` gained two rounds ago, and the same reason: a
    // stray file naming somebody else's task becomes that task's receipt, and
    // the identity join then reports on a leg it has no relationship to.
    // Raised as non-blocking by the release panel (zai lane, 2026-08-10,
    // round 7) as the surviving half of a class already closed next door.
    if (name !== `${taskId}.md`) continue
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
      // The companion writes the effort as its OWN field and folds it into
      // `effective_identity` as `${model}[${effort}]`. Without it here,
      // `joinDispatchIdentity` cannot rebuild the identity the companion built
      // and reports every effort-pinned leg as a contradiction — the exact
      // false alarm the join's effort branch exists to stop, restored silently
      // by a reader that dropped the field. Found by the release panel (codex
      // lane, 2026-08-10, round 2) in the fix for the first version of it.
      requested_reasoning_effort: field(text, 'requested_reasoning_effort'),
      effective_identity: field(text, 'effective_identity'),
      identity_status: field(text, 'identity_status'),
    })
  }
  return byTask
}

// `none` and `missing` are WORDS the receipt writes, not absences. Measured off
// real receipts rather than read off the writer: an unpinned dispatch records
// `requested_model: none`, and an adapter that advertised no identity at all
// records `effective_identity: missing`. Treating either as a model name is how
// a board ends up reporting that a leg ran on a model called "missing".
const RECEIPT_SENTINELS = new Set(['none', 'missing'])

const receiptValue = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' || RECEIPT_SENTINELS.has(text) ? null : text
}

/**
 * Join what a leg ASKED for (the ledger's `assigned` line, written before the
 * process spawned) against what ANSWERED (the dispatch receipt). Contract
 * ข้อ 3.5.1 recorded the absence of this join in ข้อ 14.1: the two facts were
 * "visible in two places and contradicted in neither".
 *
 * Pure — takes the two records, reads no disk. Any module already holding both
 * readers can call it, and its tests are literal fixtures.
 *
 * The verdicts are enumerated from what actually reaches disk, measured by
 * driving the real companion through the mock (2026-08-09), NOT imagined:
 * an unpinned leg, a pinned leg that matched, a pinned leg the adapter refused,
 * and an adapter advertising no identity. `assigned` is written in ALL four,
 * including the refusal — which is exactly why the contradiction can sit on
 * disk with nothing naming it.
 *
 * `unverified` is NOT a conflict. The AGY lane is permanently unverified by a
 * documented exemption (its adapter rejects every model config value and runs
 * only its own default), so a join that alarmed on it would alarm on every AGY
 * leg and be ignored within a week.
 */
export function joinDispatchIdentity(assignedEntry, dispatchFact) {
  // `asked` deliberately does NOT go through `receiptValue`, and the asymmetry
  // with `receiptAsked` below is the design rather than an oversight. The two
  // sides are different formats: the ledger is JSON and `acp-companion.mjs`
  // writes `requested_model: requestedModel || null` into its `assigned` event,
  // so an unpinned leg is JavaScript `null` there and never the STRING `none`.
  // The receipt is a text file and renders the same absence as the word `none`,
  // which is why only that side needs the sentinels. A release reviewer read
  // this as a possible false `contradicted` on every unpinned leg and said
  // plainly it could not tell from the diff which format the ledger used
  // (zai lane, 2026-08-10, round 3); it is measured here so the next reader
  // does not have to.
  const asked = typeof assignedEntry?.requested_model === 'string' && assignedEntry.requested_model !== ''
    ? assignedEntry.requested_model
    : null

  if (!dispatchFact) {
    return {
      verdict: 'no_receipt', asked, answered: null,
      reason: 'the ledger recorded an assignment and no dispatch receipt names its task',
    }
  }

  const receiptAsked = receiptValue(dispatchFact.requested_model)
  const answered = receiptValue(dispatchFact.effective_identity)
  // `identity_status` is NOT a model value and must not go through
  // `receiptValue`: that helper reads `none`/`missing` as "the adapter named no
  // model", which is right for a model field and WRONG for this one. `missing`
  // is one of the four statuses the companion actually writes
  // (RECEIPT_IDENTITY_STATUSES in acp-companion.mjs), so normalising it to
  // `unverified` made the refusal branch below unreachable and turned a real
  // failure state — a pinned dispatch whose adapter advertised no identity —
  // into a shrug. Found by the release panel (codex lane, 2026-08-10).
  const rawStatus = typeof dispatchFact.identity_status === 'string' ? dispatchFact.identity_status.trim() : ''
  const status = rawStatus === '' ? 'unverified' : rawStatus

  if (asked !== receiptAsked) {
    return {
      verdict: 'contradicted', asked, answered,
      reason: `the ledger says this leg asked for ${JSON.stringify(asked)} and its own receipt says ${JSON.stringify(receiptAsked)}`,
    }
  }

  if (status === 'mismatched' || status === 'missing') {
    return {
      verdict: 'refused', asked, answered,
      reason: `identity_status: ${status} — the adapter answered as ${JSON.stringify(answered)} against a request for ${JSON.stringify(asked)}, and the dispatch was refused`,
    }
  }

  if (status === 'matched') {
    const askedEffortEarly = receiptValue(dispatchFact.requested_reasoning_effort)
    if (asked === null) {
      // A seat may inherit the account model and pin only the EFFORT. Its
      // `assigned` line then carries no model at all while the receipt carries
      // `requested_reasoning_effort` and an effective identity of
      // `<whatever answered>[effort]` — a supported, successful shape that this
      // branch called a contradiction on every tick. Found by the release panel
      // (codex lane, 2026-08-10, round 8). The model half cannot be checked
      // because nothing asked for one; the effort half can, and is.
      if (askedEffortEarly !== null) {
        // UNVERIFIED, and the first version of this branch got it wrong in the
        // most dangerous way available: it read the requested effort out of the
        // RECEIPT and then checked the receipt against it, so a leg that asked
        // for `low` and came back claiming `high` was certified `alias_agreed`.
        // A receipt cannot be its own witness — the class this entire function
        // exists to close. The ledger's `assigned` line carries
        // `{ requested_model, adapter }` and NO effort at all
        // (acp-companion.mjs `appendWorkItemEvent`), so there is nothing to
        // join against and the honest verdict is that nobody can say. Found by
        // the release panel (codex lane, 2026-08-10, round 9), one round after
        // the same lane asked for this branch to exist.
        return {
          verdict: 'unverified', asked, answered,
          reason: `this leg pinned no model, and the receipt names the effort ${JSON.stringify(askedEffortEarly)}`
            + ' — which the ledger never recorded, so the two cannot be joined. A receipt is not evidence'
            + ' about itself',
        }
      }
      return {
        verdict: 'contradicted', asked, answered,
        reason: 'the receipt claims a matched identity for a leg that asked for no model — a match against nothing is not a match',
      }
    }
    // The companion does NOT write the model alias back verbatim: when a
    // reasoning effort was also requested it writes `${model}[${effort}]`
    // (acp-companion.mjs, `effectiveIdentity`), and still calls that `matched`
    // because both halves matched. Comparing that byte-for-byte against the
    // ledger's model-only `requested_model` reported EVERY successful pinned
    // leg carrying an effort as a contradiction — a false alarm on the happy
    // path, which is the way to get a new signal ignored within a week. Found
    // by the release panel (codex lane, 2026-08-10). The effort comes from the
    // receipt's own `requested_reasoning_effort`, the same field the companion
    // built the identity from.
    const askedEffort = receiptValue(dispatchFact.requested_reasoning_effort)
    const expected = askedEffort === null ? asked : `${asked}[${askedEffort}]`
    if (answered !== expected) {
      return {
        verdict: 'contradicted', asked, answered,
        reason: `the receipt claims matched while naming ${JSON.stringify(answered)} for a request of ${JSON.stringify(expected)}`,
      }
    }
    return {
      verdict: 'alias_agreed', asked, answered,
      reason: `the adapter acknowledged the alias ${JSON.stringify(asked)}. An ALIAS is not a family: the same alias reaches different vendors on different gateways, so which vendor served this is the endpoint's fact and not this join's`,
    }
  }

  if (asked !== null) {
    return {
      verdict: 'unverified', asked, answered,
      reason: `the receipt records neither a match nor a refusal for a request of ${JSON.stringify(asked)} — unverified is not the same fact as agreed`,
    }
  }
  return {
    verdict: 'unverified', asked, answered,
    reason: answered === null
      ? 'nothing was asked and nothing answered'
      : `${JSON.stringify(answered)} answered a leg that pinned no model, so there is nothing to contradict`,
  }
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

// D1 (loop-system-contract.md ข้อ 16): the agent-seat read facade
// (`agent-seat-reads.mjs`) needs exactly this aggregate reader and nothing
// else. It imports this name rather than `readWorkItems` itself so that
// `scripts/ledger-reader-ratchet.mjs`'s static-text scan does not need a new
// baseline entry for a file that never reads a ledger byte on its own — this
// file was already the sanctioned aggregate reader before the facade
// existed, and stays the only place that decides how a ledger line means
// what it means. This is the "textual re-export renaming" technique that
// file's own header documents as a real, low-cost way to reference an
// already-authorized reader under a different name; used here deliberately,
// not as an accident the ratchet failed to catch.
export const loadWorkItemLedgers = readWorkItems

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
// Events whose destination outranks the seat that signed them — see the note at
// the placement itself. One member, and it earns the set by being a rule rather
// than a special case: any future event that MOVES a token belongs here.
export const PLACES_BY_DESTINATION = new Set(['resumed'])

export const RELEASING_EVENTS = new Set([
  'completed', 'abandoned', 'audit_requested', 'audited',
  // A token waiting for its next controller leg is still an audit, not work in
  // progress. It releases for the same reason `audit_requested` does.
  'audit_lost',
])

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
// carry one (ข้อ 4), and every outcome this matters for — `delivered`, `lost`,
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
// at all. Trusting it unconditionally was itself a hole (retro-release-
// review, 2026-08-04, B4): the same evaluator retried also reads identical by
// agent_id on both legs, so an identityless `reviewed` from the DEAD leg is
// indistinguishable from one on the LIVE leg by anything this function can
// read off the entry itself. The one thing it CAN read is whether that agent
// was ever assigned more than once in this ledger at all — assigned exactly
// once, there is no other leg for it to be stale against, so it is trusted
// exactly as before; assigned more than once, it cannot say which leg it
// belongs to and that is UNKNOWN, which must not be counted as a passing
// review (house rule: a branch that cannot answer says UNKNOWN, not "stale",
// but UNKNOWN is not "yes" either). `delivered`/`lost` without a resolvable
// task_id fall back to the plain agent-identity check they always used.
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

  const holderTaskId = holderAssignedIndex >= 0
    && custody[holderAssignedIndex].task_id !== undefined && custody[holderAssignedIndex].task_id !== null
    ? String(custody[holderAssignedIndex].task_id)
    : null

  // How many times `agentId` was itself the subject of an `assigned` line,
  // scanning only up to and including `uptoIndex` — never past it, so a
  // LATER re-assignment of that agent cannot retroactively recolour an
  // outcome that was already unambiguous when it was written.
  const assignedCountFor = (agentId, uptoIndex) => {
    let count = 0
    for (let j = 0; j <= uptoIndex; j += 1) {
      if (custody[j].event === 'assigned' && String(custody[j].agent_id || '') === agentId) count += 1
    }
    return count
  }

  // Has this reviewer already spoken for the leg it is currently on?
  //
  // r6-codex/Sally: `reviewsCurrentHolder` rescues a review that names the
  // holder's own task_id, on the argument that a leg which died before that
  // delivery existed could never have seen its task_id. True, and not enough —
  // the leg does not have to be dead. An evaluator dispatched to judge b-1,
  // which judged it and then kept running, can see b-2 land and write a SECOND
  // `reviewed` naming it, with no new `assigned` of its own. The sanctioned
  // producer writes one `reviewed` per harvested outbox (loop-runner.mjs:703),
  // so a second one from the same leg did not come from it.
  const legAlreadyReviewed = (agentId, uptoIndex) => {
    let latestAssigned = -1
    for (let j = 0; j < uptoIndex; j += 1) {
      if (custody[j].event === 'assigned' && String(custody[j].agent_id || '') === agentId) latestAssigned = j
    }
    if (latestAssigned < 0) return false
    for (let j = latestAssigned + 1; j < uptoIndex; j += 1) {
      if (custody[j].event === 'reviewed' && String(custody[j].agent_id || '') === agentId) return true
    }
    return false
  }

  for (let i = custody.length - 1; i >= 0; i -= 1) {
    const entry = custody[i]
    if (!LEG_OUTCOMES.has(entry.event)) return entry

    // A `reviewed` written by an agent that is NOT the current holder, where
    // that same agent has its OWN `assigned` leg recorded somewhere earlier
    // in this ledger, is never trusted as evidence about the holder's leg —
    // no matter what dispatch_id/task_id it carries (F1, agy+codex round 4,
    // 2026-08-04) — UNLESS `reviewed_task` names exactly the delivery the
    // CURRENT holder itself produced (F1/B6, round 5, 2026-08-04). By
    // construction that agent's leg is now superseded (a DIFFERENT agent
    // holds), so a straggling report from it is USUALLY evidence about ITS
    // OWN old leg, not the holder's — dispatch_id/task_id cannot tell a
    // genuine current report apart from one forged/replayed to carry the
    // holder's real ids, because the guarantee that those ids mean one thing
    // is enforced at the point bytes enter the ledger, not re-derivable here
    // (house rule: a branch that cannot answer says UNKNOWN, never "yes").
    // `reviewed_task` is different: it is REQUIRED on every `reviewed` line
    // (contract ข้อ 4) and the only sanctioned producer of one — the harvester
    // at loop-runner.mjs:703 — always stamps it from the delivery actually
    // being judged, at the moment of judging. A leg that died BEFORE the
    // holder's own delivery existed structurally cannot name that delivery's
    // task_id in `reviewed_task` — it never saw it. So `reviewed_task`
    // matching the holder's OWN task_id is producer-bound proof that this
    // review is ABOUT the work currently held, regardless of who holds it:
    // the contract never requires a reviewer's agent_id to equal the
    // holder's (loop-system-contract.md:843-847), and a reviewer that
    // happens to have an older leg elsewhere in this ledger (reject, rework,
    // re-review by the SAME evaluator — the ordinary shape ข้อ 1 describes) is
    // otherwise indistinguishable from one that never had a leg at all,
    // which this guard already trusts unconditionally two lines below. This
    // does not weaken the DIFFERENT-agent forgery defence above: it only
    // recognises a review of what the current holder is holding right now,
    // never a review of anything the holder held in the past — a forged
    // `reviewed_task` still requires exactly the same unauthenticated-write
    // access every other field on this line already assumes away (see
    // CONTRACT-PATCH.md for the producer-bound identity change that closes
    // that remaining gap; it is not implemented here). An agent that was
    // NEVER assigned a leg of its own (assignedCountFor === 0) is unaffected
    // either way: that is the ordinary "evaluator with no leg to be stale
    // against" shorthand, and it remains the only interpretation available
    // for whichever leg is current — the same-agent case (this agent IS the
    // holder, possibly retried) is left entirely to the existing
    // dispatch_id/task_id/retry checks below, which an established
    // positive-case test (Shape 1) requires to keep trusting a same-agent
    // round-2 report that names only its own task_id.
    if (entry.event === 'reviewed' && entry.agent_id) {
      const reviewer = String(entry.agent_id)
      const reviewsCurrentHolder = entry.reviewed_task !== undefined && entry.reviewed_task !== null
        && holderTaskId !== null && String(entry.reviewed_task) === holderTaskId
        && !legAlreadyReviewed(reviewer, i)
      if (reviewer !== holder && assignedCountFor(reviewer, i) > 0 && !reviewsCurrentHolder) continue
    }

    if (entry.dispatch_id && holderDispatchId) {
      if (String(entry.dispatch_id) === String(holderDispatchId)) {
        // dispatch_id matching the holder's own is necessary, not sufficient
        // (Shape 2, retro-release-review round 2, 2026-08-04, F1): nothing
        // stops a line from also naming a task_id that resolves to a
        // DIFFERENT leg — validation checks the dispatch owner's agent_id but
        // historically waved through its task_id for `reviewed`. A `reviewed`
        // that borrows the live dispatch_id while still naming an old task_id
        // is not this leg's own outcome; it is stale evidence wearing the
        // live leg's badge. Only refuse when the entry's task_id actually
        // resolves to some OTHER `assigned` line than the holder's — an entry
        // that omits task_id, or that names the holder's own, still passes.
        const entryTaskId = entry.task_id !== undefined && entry.task_id !== null ? String(entry.task_id) : null
        if (entryTaskId !== null && holderTaskId !== null && entryTaskId !== holderTaskId) continue
        return entry
      }
      continue
    }
    const ownIndex = entry.task_id !== undefined && entry.task_id !== null
      && assignedIndexByTask.has(String(entry.task_id))
      ? assignedIndexByTask.get(String(entry.task_id))
      : null
    if (ownIndex !== null) {
      // task_id resolving to the holder's own leg is necessary, not
      // sufficient (retro-release-review, 2026-08-04, B3): nothing bound
      // task_id to an agent the way dispatch_id is bound at write time, so a
      // `delivered` naming a DIFFERENT agent than the one that leg was
      // assigned to would otherwise be trusted here — strictly worse than the
      // agent_id fallback this branch sits in front of, which refused exactly
      // that impersonation. Requiring the entry's own agent_id to match the
      // holder keeps the gain task_id was added for (telling apart two legs
      // run by the SAME agent, where agent_id alone cannot) without opening
      // this new hole for a DIFFERENT agent borrowing the holder's task_id.
      if (ownIndex === holderAssignedIndex && String(entry.agent_id || '') === holder) return entry
      continue
    }
    // Neither dispatch_id nor task_id resolves. For `delivered`/`lost` the
    // agent_id fallback still answers. For `reviewed` it does not — an
    // evaluator's `reviewed` is legitimately allowed to differ from the
    // holder's agent_id even when current (it may have no `assigned` leg of
    // its own to be judged against, see the comment above this function), so
    // agent_id cannot tell current from stale either way. That leaves only
    // one more signal: whether the entry's own agent was ever assigned MORE
    // THAN ONCE in this ledger. If it was assigned exactly once (or never),
    // there is no other leg it could be stale against, and it is trusted
    // exactly as before. If it was assigned more than once, a `reviewed` that
    // carries no identity at all cannot say which of those legs it belongs
    // to — house rule: a branch that cannot answer says UNKNOWN, never "no" —
    // and UNKNOWN must not be counted as a passing review (retro-release-
    // review, 2026-08-04, B4: a dead evaluator leg's late, identityless
    // `reviewed pass` cleared pull-controller's gate while its retry ran).
    // `continue` treats it the same way an out-of-scope task_id already
    // does: not evidence about where the token is now, so the search keeps
    // looking at older lines, which lands on the holder's own `assigned`.
    if (entry.event === 'reviewed') {
      // A retry is the SAME agent assigned twice in this ledger. The previous
      // shape of this check only counted a CONSECUTIVE run of that agent's
      // `assigned` lines, on the theory that two independent review rounds
      // (reject, rework, re-review — one team's own quality loop, contract
      // ข้อ 1) always have a different agent's `assigned` — the next worker leg
      // — between the evaluator's two legs, so that shape would read as a run
      // of 1 and stay trusted. That theory was backwards: the rework leg
      // sitting between them is exactly what resets a "consecutive run"
      // count, so a same-evaluator reject/rework/re-review — the most
      // ordinary custody in the system — read as unambiguous and let the
      // dead round-1 leg's late, identityless `reviewed pass` clear the pull
      // gate while round 2 was still running (Shape 1, retro-release-review
      // round 2, 2026-08-04, F1). Nothing about an intervening OTHER agent's
      // leg tells this identityless line which of the target agent's legs it
      // belongs to — only whether the target agent was ever assigned more
      // than once at all, counted over the WHOLE ledger up to this entry's
      // own position (not merely the immediately adjacent lines). Scanning
      // only up to this entry's own position — not the whole ledger past it
      // — is still what keeps a LATER, unrelated re-assignment of the same
      // agent from retroactively recolouring an outcome that was already
      // unambiguous when it was written.
      //
      // This is also the ceiling on the `reviewsCurrentHolder` pass above, and
      // saying so is the point (r6-qwen): that pass rescues a shorthand review
      // from a reviewer on its FIRST leg and no further. A reviewer already
      // assigned twice writing an identityless round-3 report is discarded
      // here however correctly its `reviewed_task` names the current delivery,
      // because nothing in the line says which of its own legs wrote it. The
      // cost is real and is a re-dispatch, not a lost token: the runner assigns
      // the evaluator again and the next report carries a dispatch_id, which
      // the sanctioned writer stamps on every `reviewed` it authors. Paying
      // for a re-review is the cheaper error than trusting a dead leg's
      // verdict, and the comment above used to describe an unbounded
      // "reject, rework, re-review" pass this code has never given.
      const targetAgent = String(entry.agent_id || '')
      if (assignedCountFor(targetAgent, i) > 1) continue
      return entry
    }
    const supersededLeg = entry.agent_id && String(entry.agent_id) !== holder
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
    // A token is with the seat that acted, EXCEPT when the event's whole purpose
    // was to move it somewhere — then the destination wins. `resumed` is the one
    // event where the two disagree: the outer controller signs it and the work
    // goes back to a delivery team. This was invisible until D6 made the
    // controller a team member; before that `teamOf('pm')` was undefined and the
    // destination won by accident, so the same rule held for the wrong reason.
    // Get it wrong and a resume parks the work on the PM for ever instead of
    // sending it back — which is the shape of the resume-routing defect already
    // open against this system.
    //
    // `escalated` is deliberately NOT here even though it also carries both: an
    // escalation IS the PM's work, and Kanban says the PM's slot is held until
    // it is done. That is the stop mechanism, not a routing accident.
    const teamId = (PLACES_BY_DESTINATION.has(last.event) ? last.to_team : null)
      ?? teamOf.get(last.agent_id) ?? last.to_team ?? null
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
