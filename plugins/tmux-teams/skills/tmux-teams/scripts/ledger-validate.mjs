// ledger-validate.mjs — read a custody ledger and say whether it can be believed.
//
// `.tmux-teams/work-items/<token>.jsonl` is the evidence layer of the loop
// (contract §2). Everything downstream — occupancy, the pull decision, the
// board, the outer controller's audit — is derived from it, so a ledger that
// describes an impossible history poisons every one of those answers at once.
//
// Structure alone is not enough. A line can carry every field the contract
// names and still be a lie: a `delivered` from an agent that was never
// assigned, a `reviewed` for work that was never delivered, an event appended
// after the token was already closed. Those are sequence defects, and they are
// exactly the kind a hand-typed `>>` append produces. This module checks both.
//
// It reports EVERY problem it finds. Stopping at the first one turns a repair
// into a game of whack-a-mole against a file nobody is allowed to rewrite.
// The verdict vocabularies live with the briefs that ask for them, so the words
// an agent is told to say and the words a ledger will accept cannot drift into
// two lists. role-briefs imports only node builtins, so this direction is safe.
import { AUDIT_VERDICTS, REVIEW_VERDICTS, TARGET_VERDICTS } from './role-briefs.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

// Contract §4.5: at most 1 MiB per token, 5000 files per directory. The same
// bounds dispatch-facts.mjs reads under, so the validator's verdict covers
// exactly the bytes the rest of the loop will actually see.
export const MAX_LEDGER_BYTES = 1 << 20
export const MAX_FILES = 5000

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
// ISO 8601, UTC only. A local-offset stamp compares wrong against a UTC one and
// would make "time went backwards" unanswerable.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
// `agent:` or `human:` — the whole point of recording an actor is that a
// hand-written event stays visibly distinct from a runner-written one forever,
// which only works if the kind is a closed vocabulary.
export const ACTOR_RE = /^(?:agent|human):[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/

export const COMMON_FIELDS = ['at', 'event', 'work_item', 'workflow']

// Contract §4, one row per event. `required` is what the table's "Also carries"
// column names; `forbidden` is the field the table names as deliberately absent.
// Only the event NAME is a closed vocabulary — extra fields are allowed, because
// real lines legitimately carry `reason` on a `pulled`, or `dispatch_id` on a
// `delivered` or a `reviewed` — dispatch-facts.mjs:currentEntry reads the latter
// to tell a stale review from the leg still running it — and rejecting those
// would fight the writers this file exists to protect.
export const EVENT_SPEC = {
  // §4.6: work entering the graph for the first time. `pulled` cannot say this
  // — a pull is a team TAKING work from another team, and the first team on a
  // route has nobody to take it from. The alternative considered and rejected
  // was making `from_team` optional on `pulled`: that would stop the validator
  // catching a pull that genuinely forgot its sender, forever, to accommodate
  // one event at the head of each route. A new word costs nothing and leaves
  // `pulled` exactly as strict as it was.
  // ADR 0002: `opened` is a person's decision, not a machine's, so it carries
  // the same actor-kind rule §5.1 already put on `answered` — `actor` must be
  // `human:<id>`. An agent that types the words on someone's behalf keeps its
  // own identity in `relayed_by` (see `answered`'s comment below) rather than
  // borrowing the person's. Machine-decided admission is out of scope for this
  // event; a future autonomous opener needs its own word, not this actor
  // forged into looking human.
  opened: { required: ['agent_id', 'to_team', 'reason'], forbidden: ['from_team'], actor_kind: 'human' },
  pulled: { required: ['agent_id', 'from_team', 'to_team'] },
  // `verdicts` closes the value, not just the field. Until it existed the
  // validator checked that `verdict` was a non-empty string and no more, so
  // `intake { verdict: "reject" }` passed the sanctioned writer and then meant
  // three different things: the runner dispatched a worker as though it were an
  // accept, the graph counted it accepted, and the board called it "verdict
  // unstated". It was stated, and it was not an accept. An open value inside a
  // closed event is the same family defect one level down.
  // `accept` only — narrower than `INTAKE_VERDICTS`, and deliberately so.
  // Those two words are what a dispatcher may SAY in its outbox; this event
  // records only what an acceptance IS. The single writer of `intake`
  // (loop-runner.mjs:357) always stamps `accept`, because a refusal becomes
  // `returned` or `escalated` instead — so an `intake` carrying anything else
  // is a line the system cannot produce.
  //
  // It could still be written, and then the three readers disagreed at once:
  // the runner dispatched a worker without consulting the verdict at all
  // (loop-runner.mjs:552), the graph counted it accepted (graph.mjs:279), and
  // the board called a stated rejection "verdict unstated" (kanban.mjs:69).
  // Closing the value here makes that divergence unreachable rather than
  // teaching three readers the same lesson separately — the two that ignore the
  // verdict are now correct by construction instead of by luck.
  intake: { required: ['agent_id', 'verdict', 'reason'], verdicts: new Set(['accept']) },
  // §4.1: the token is held by the team it went back to, not by the dispatcher
  // that refused it, so an `agent_id` here would place the work with the wrong
  // team.
  returned: { required: ['to_team', 'refused_by', 'reason'], forbidden: ['agent_id'] },
  assigned: { required: ['agent_id', 'task_id', 'dispatch_id'] },
  delivered: { required: ['agent_id', 'task_id', 'terminal', 'timed_out', 'evidence_present'] },
  reviewed: { required: ['agent_id', 'verdict', 'reviewed_task', 'reason'], verdicts: REVIEW_VERDICTS },
  lost: { required: ['agent_id', 'task_id', 'reason'] },
  // §4.2: the controller is not a team member, so without `to_team` the token
  // cannot be placed at all.
  escalated: { required: ['agent_id', 'to_team', 'task_id', 'reason'] },
  resumed: { required: ['agent_id', 'to_team', 'grant', 'reason'] },
  completed: { required: ['from_team'] },
  audit_requested: { required: ['agent_id', 'task_id', 'reason'] },
  audited: { required: ['agent_id', 'verdict', 'reason'], verdicts: AUDIT_VERDICTS },
  abandoned: { required: ['reason'] },
  // The grill asked and nobody has answered yet. This is the first state in
  // this system that waits on a PERSON rather than on an agent or on the loop,
  // and it needs a word of its own for one concrete reason: without it the
  // runner sees a token sitting at a dispatcher and re-dispatches that
  // dispatcher every tick, paying again and again to ask a question of someone
  // who has not replied. It does not release the team (§6): the token is still
  // held, still counted, still occupying WIP.
  // `question_id` names THIS question, not the token — a token can be asked
  // more than once in its life, and without an id of its own a stale answer
  // and a fresh one are indistinguishable once both are on disk. `resume_role`
  // is optional and names where the answer goes back to (`dispatcher`,
  // `audit`, `outer`, or the worker/evaluator role the leg was on) — the seat
  // that asked is the seat that reads the reply, and only the writer that
  // asked it knows which seat that was.
  questioned: { required: ['agent_id', 'questions', 'reason', 'question_id'] },
  // The answer, and the only event whose ACTOR KIND is part of its validity.
  // §5.1's second evidence is that a person decided; `human:` is the closed
  // vocabulary that records it. An operator agent may relay the words — see
  // `references/controller-as-team.md` §6.4.1 — and then names itself in
  // `relayed_by`, because the actor says who DECIDED and the person decided.
  // `to_team` is not decoration. Occupancy places a token by its last event's
  // `agent_id` or `to_team` (§6), and a person is neither an agent nor a team —
  // so an `answered` carrying only a reason would make the token an orphan the
  // moment somebody replied to it. It answers TO the team that asked.
  answered: { required: ['to_team', 'reason'], actor_kind: 'human' },
}

export const LEDGER_EVENTS = Object.freeze(Object.keys(EVENT_SPEC))

// Contract §5: the three rows with no successor. `completed` is only half
// closed — the outer controller still has to read the delivery as a whole
// (§9), and that audit pair is the sole legal continuation.
// Exported because the writer needs the same three words to decide whether a
// ledger that predates a rule may still be CLOSED; two copies of this set is
// how one of them silently stops matching the other.
export const TERMINAL_EVENTS = new Set(['completed', 'audited', 'abandoned'])
// Master, 2026-08-03: a dispatcher may refuse the same token at its door three
// times. The fourth is not a refusal, it is a loop — two seats disagreeing
// about the same work with nobody deciding — so it has to go to the controller
// instead. §1's door exception is what makes the retry legal at all; this is
// the ceiling on it.
export const MAX_DOOR_REFUSALS = 3
// §5: `completed` is only HALF closed — the controller still has to read the
// delivery. `questioned` joins this set because the audit can fail to answer:
// every other gate escalates upward when it cannot decide, and the controller
// is the top, so its only remaining reader is a person. Without it a route that
// finished and then hit an unusable audit had nowhere legal to go, and the
// runner refused its own repair every tick — visible, but permanently stuck.
// `answered` follows the question and puts the token back in front of the
// audit, which is where it was. `abandoned` joins the set for the same reason
// `questioned` did: a person can fail to answer post-completion exactly as
// one can fail to answer at the front door, and the clock's withdrawal has to
// have somewhere legal to land — `loop-runner.mjs` writes it as `abandoned`
// either way (§9), so the ledger must accept the one word it actually uses.
const AFTER_COMPLETED = new Set(['audit_requested', 'audited', 'questioned', 'answered', 'abandoned'])
// `audited` and `abandoned` are not "closed until `completed` says otherwise"
// the way the rest of `AFTER_COMPLETED` is — they are §5's OTHER two rows with
// no successor. Tracking them separately from `closedAt` is what makes
// `completed -> audit_requested -> audited -> audit_requested` illegal: the
// first `closedAt` a route sees is always `completed` (it is always written
// before either of these), so a single "first terminal wins" flag can never
// notice that the SECOND terminal — the one that actually ends the audit —
// already happened.
// Exported (round 5, codex BLOCKER 9, 2026-08-04): `ledger-writer.mjs`'s
// closing-tolerance gate used to test membership in `TERMINAL_EVENTS`, which
// still contains `completed` — but `completed` is only HALF closed (the
// comment on `TERMINAL_EVENTS` above says so in the same breath it defines
// the set). Letting `completed` land on a duplicate-tainted ledger does not
// close it: the very next line the runner needs to write, `audit_requested`,
// is not terminal at all, so `continuable` refuses it and the token is
// STUCK — parked with `completed` on top, read as Done by the board, its
// blocker invisible (`kanban.mjs`'s `blockedReason` is only carried for a
// token `inTeam`, and a `completed`/`RELEASING_EVENTS` token is not). Only a
// row with NO legal successor actually closes a broken history; `HARD_TERMINAL_EVENTS`
// is that set, and it is what the writer's closing gate must test instead.
export const HARD_TERMINAL_EVENTS = new Set(['audited', 'abandoned'])

// `null` is absence, not a value. loop-runner.mjs writes `workflow: … || null`
// and `to_team: … || null`, so a presence check that only tested `in` would let
// exactly the fields the contract calls mandatory through as blanks.
const present = (value) => {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

export function validateLedger(lines) {
  const rows = Array.isArray(lines)
    ? lines
    : String(lines ?? '').split('\n')
  const problems = []
  // `meta` carries structured facts about the violation — today just `event`
  // and/or `field` — beyond the prose in `detail`. `isLegacyTolerated` below
  // needs to match a problem's exact (code, event, field) shape without
  // parsing English out of `detail`, which would break the moment the wording
  // changes.
  const add = (line, code, detail, meta = {}) => { problems.push({ line, code, detail, ...meta }) }

  let token = ''
  let prevMs = null
  // Facts accumulated in FILE order. Sorting by `at` the way readers do would
  // destroy the only thing that makes "never goes backwards" checkable.
  const assignedAgents = new Set()
  // What `assigned` actually bound a dispatch_id to. dispatch-facts.mjs's
  // currentEntry trusts a dispatch_id match on a `delivered`/`lost`/`reviewed`
  // line as PROOF it belongs to the leg that ID names — that trust is only as
  // good as the ID being bound to one (agent_id, task_id) pair for its whole
  // life. Without this, the sanctioned writer would accept a `delivered` that
  // reuses another leg's live dispatch_id while naming a different agent and
  // task: the ID matches, currentEntry believes it, and a report that never
  // happened is read as the current leg's own outcome.
  const dispatchOwner = new Map()
  // Every `task_id` and `dispatch_id` an `assigned` line has already claimed
  // (retro-release-review, 2026-08-04, B2). Neither `dispatchOwner` above nor
  // dispatch-facts.mjs's `assignedIndexByTask` enforce that an id opens only
  // ONE leg: `dispatchOwner` silently keeps the first owner and says nothing
  // about a later line reusing the id, and `assignedIndexByTask` is last-wins,
  // so a repeated id quietly hands an OLDER leg's outcome to whichever
  // `assigned` line happens to be newest. `task_id` is minted at millisecond
  // resolution (loop-runner.mjs), so two dispatches of the same
  // (token, team, role) inside one millisecond collide with nothing to stop
  // it, and a hand-written or replayed ledger has no clock at all. Reporting
  // the reuse here — rather than only in the first-owner bookkeeping the two
  // readers already keep — is what makes it a validation failure instead of a
  // silent one.
  const assignedTaskIds = new Set()
  const assignedDispatchIds = new Set()
  // Every team this token has actually been INSIDE. §1's one-way rule is a
  // statement about this set and nothing else. A team is added when its
  // dispatcher ADMITS the token, not when the token arrives at its door —
  // `pulled` is written before `intake` runs, so counting the arrival would
  // make a refused token count as held and turn a legal retry into a
  // violation. `loop-replay.test.mjs` seed 1 proved that with a real route.
  const heldTeams = new Set()
  // The team the token has arrived at and that has not ruled on it yet.
  let atTheDoor = ''
  // Whether the team currently holding the token let it IN. Distinct from
  // `atTheDoor` being empty, which is also true of a ledger that never recorded
  // an arrival at all — every fixture that starts mid-story is in that state,
  // and reading those as admitted flagged seven of them.
  let admittedHere = false
  // How many times each dispatcher has turned this token away at its door.
  const doorRefusals = new Map()
  // Counted, not flagged: `opened` earns its strictness only if a second one
  // later in the file is as illegal as one appended after a `pulled`.
  let eventsSeen = 0
  let deliveredSeen = false
  let auditRequested = false
  let questionAsked = false
  // The id of the question currently outstanding, or null once it has been
  // consumed by an `answered`/expiry — or if the `questioned` that raised it
  // named none, on a history written before this field existed. Kept apart
  // from `questionAsked`: that flag says WHETHER an answer is legal, this
  // says which one it has to be about.
  let openQuestionId = null
  let closedAt = null // { line, event } of the first terminal event
  let hardClosedAt = null // { line, event } of the first §5 no-successor event

  for (let index = 0; index < rows.length; index += 1) {
    const lineNo = index + 1
    const raw = rows[index]
    if (typeof raw !== 'string' || raw.trim() === '') continue

    let entry
    try {
      entry = JSON.parse(raw)
    } catch (error) {
      add(lineNo, 'unparsable', `line is not JSON: ${error.message}`)
      continue
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      add(lineNo, 'not_an_object', 'every ledger line must be one JSON object')
      continue
    }

    for (const field of COMMON_FIELDS) {
      if (!present(entry[field])) add(lineNo, 'missing_common_field', `${field} is required on every event`)
    }

    const name = typeof entry.event === 'string' ? entry.event : ''
    const spec = EVENT_SPEC[name]
    if (name && !spec) {
      add(lineNo, 'unknown_event', `${name} is not an event in contract §4`)
    }

    if (present(entry.at)) {
      const at = String(entry.at)
      if (!ISO_UTC_RE.test(at) || !Number.isFinite(Date.parse(at))) {
        add(lineNo, 'bad_timestamp', `at must be ISO 8601 UTC, got ${at}`)
      } else {
        const ms = Date.parse(at)
        // §4.4: equal timestamps keep append order and are legal. Only a stamp
        // strictly earlier than the line above it describes an impossible past.
        if (prevMs !== null && ms < prevMs) {
          add(lineNo, 'time_went_backwards', `at ${at} is earlier than the previous line`)
        }
        prevMs = prevMs === null ? ms : Math.max(prevMs, ms)
      }
    }

    if (present(entry.work_item)) {
      const workItem = String(entry.work_item)
      if (!ID_RE.test(workItem)) {
        add(lineNo, 'bad_work_item', `work_item ${workItem} is not a valid id`)
      } else if (!token) {
        token = workItem
      } else if (workItem !== token) {
        // One token, one file (§4). Two tokens in one ledger means two
        // histories interleaved and neither can be trusted.
        add(lineNo, 'work_item_mismatch', `work_item ${workItem} does not match ${token}`)
      }
    }

    // The writer stamps `actor`; history predating it has none. Demanding it
    // here would condemn every legitimately runner-written line ever appended,
    // so it is shape-checked only when it is there.
    if (entry.actor !== undefined && !ACTOR_RE.test(String(entry.actor ?? ''))) {
      add(lineNo, 'bad_actor', `actor must be agent:<id> or human:<id>, got ${JSON.stringify(entry.actor)}`)
    }
    // ADR 0002: the relay's own identity, distinct from the decision `actor`
    // records. Only ever an agent — a human does not relay another human's
    // decision through this field, they simply are the `actor`.
    if (present(entry.relayed_by) && !/^agent:[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(String(entry.relayed_by))) {
      add(lineNo, 'bad_relayed_by', `relayed_by must be agent:<id>, got ${JSON.stringify(entry.relayed_by)}`)
    }

    if (!spec) continue

    for (const field of spec.required) {
      if (!present(entry[field])) {
        add(lineNo, 'missing_field', `${name} requires ${field}`, { event: name, field })
      }
    }
    for (const field of spec.forbidden ?? []) {
      if (present(entry[field])) add(lineNo, 'forbidden_field', `${name} must not carry ${field}`)
    }
    // A word outside the event's own vocabulary. Every reader downstream
    // branches on this value and each one falls back differently when it does
    // not recognise it, so an unknown verdict does not fail — it means several
    // contradictory things at once, quietly.
    if (spec.verdicts && present(entry.verdict) && !spec.verdicts.has(String(entry.verdict))) {
      add(lineNo, 'bad_verdict',
        `${name} verdict ${JSON.stringify(entry.verdict)} is not one of ${[...spec.verdicts].sort().join(', ')}`)
    }
    // GitHub #31 stage 2: a `reviewed` from a `produces: 'verdict'` team's
    // evaluator may additionally confirm what its worker found — a SEPARATE,
    // narrower vocabulary from `verdict` above (which judges whether the
    // review itself was done correctly, not what it found). The check above is
    // hardcoded to `entry.verdict` via `spec.verdicts`, so this is a small new
    // block rather than a generalisation of it. Both fields are optional:
    // absent on every `reviewed` line written before this field existed, and
    // absent whenever an evaluator's own `readTargetVerdict` found nothing
    // stated (role-briefs.mjs) — "a declaration that says nothing must be
    // refused" does not apply here because the field is never written to say
    // nothing; it is simply not written.
    if (name === 'reviewed' && present(entry.target_verdict)) {
      if (!TARGET_VERDICTS.has(String(entry.target_verdict))) {
        add(lineNo, 'bad_target_verdict',
          `reviewed target_verdict ${JSON.stringify(entry.target_verdict)} is not one of ${[...TARGET_VERDICTS].sort().join(', ')}`)
      }
      if (!present(entry.target_reason)) {
        add(lineNo, 'missing_field', 'reviewed declares target_verdict without target_reason')
      }
    }

    // ---- sequence ----------------------------------------------------------
    // A hard terminal (`audited` or `abandoned`) ends the ledger outright —
    // checked before the softer `completed` rule so a line that follows BOTH
    // is reported against the one that actually forbids it.
    if (hardClosedAt) {
      add(lineNo, 'event_after_terminal',
        `${name} follows ${hardClosedAt.event} on line ${hardClosedAt.line}; the token was already closed`)
    } else if (closedAt) {
      const stillLegal = closedAt.event === 'completed' && AFTER_COMPLETED.has(name)
      if (!stillLegal) {
        add(lineNo, 'event_after_terminal',
          `${name} follows ${closedAt.event} on line ${closedAt.line}; the token was already closed`)
      }
    }

    if (name === 'delivered') {
      const agent = present(entry.agent_id) ? String(entry.agent_id) : ''
      if (agent && !assignedAgents.has(agent)) {
        add(lineNo, 'delivered_without_assigned', `${agent} delivered without a preceding assigned`)
      }
    }
    // A dispatch_id that means something contradictory to what it was
    // assigned to. `reviewed`'s OWN review target is `reviewed_task` (a
    // different leg entirely — the worker's delivery) and that field is
    // deliberately not checked here. But `reviewed` can also carry a plain
    // `task_id` naming the leg it was written FROM, and production stamps
    // that `task_id` from the very same leg as `dispatch_id` (both read off
    // one `last` — loop-runner.mjs's harvest). A `reviewed` was exempted from
    // this check entirely on the mistaken belief that `task_id` never means
    // that for `reviewed`; in fact a line could borrow a live dispatch_id
    // while still naming an old task_id, and validation waved it through —
    // currentEntry's dispatch_id fast path then trusted it as the live leg's
    // own outcome (Shape 2, retro-release-review round 2, 2026-08-04, F1).
    if ((name === 'delivered' || name === 'lost' || name === 'reviewed') && present(entry.dispatch_id)) {
      const owner = dispatchOwner.get(String(entry.dispatch_id))
      if (owner) {
        if (present(entry.agent_id) && String(entry.agent_id) !== owner.agent_id) {
          add(lineNo, 'dispatch_id_agent_mismatch',
            `${name} carries dispatch_id ${entry.dispatch_id}, assigned to ${owner.agent_id}, not ${entry.agent_id}`)
        }
        if (present(entry.task_id) && String(entry.task_id) !== owner.task_id) {
          add(lineNo, 'dispatch_id_task_mismatch',
            `${name} carries dispatch_id ${entry.dispatch_id}, assigned to task ${owner.task_id}, not ${entry.task_id}`)
        }
      }
    }
    if (name === 'reviewed' && !deliveredSeen) {
      add(lineNo, 'reviewed_without_delivered', 'reviewed with nothing delivered to review')
    }
    if (name === 'audited' && !auditRequested) {
      add(lineNo, 'audited_without_request', 'audited with no preceding audit_requested')
    }
    // An answer to nothing. The pair only means anything together: a lone
    // `answered` would release a token nobody had parked. Checked before the
    // event is consumed below, so a SECOND `answered` with no new `questioned`
    // between them is caught the same way — `questionAsked` is reset the
    // moment the open question is consumed, so a stale answer to an already-
    // closed question reads as exactly what it is: an answer to nothing.
    if (name === 'answered' && !questionAsked) {
      add(lineNo, 'answered_without_question', 'answered with no preceding questioned')
    } else if (name === 'answered' && present(entry.question_id) && openQuestionId
      && String(entry.question_id) !== openQuestionId) {
      // Both sides bothered to name a question — so a mismatch is not a
      // missing field, it is two different questions. The open one is still
      // open; only the id above closes it, so a stray line naming an unrelated
      // id must not consume it out from under the real answer.
      add(lineNo, 'question_id_mismatch',
        `answered names question ${JSON.stringify(entry.question_id)} but the token is waiting on ${JSON.stringify(openQuestionId)}`)
    }
    // The kind of writer, not merely its shape. A model relaying a person's
    // words signs `human:` and names itself in `relayed_by`; a model signing as
    // itself has recorded its own opinion as a person's decision.
    if (spec.actor_kind === 'human') {
      const actor = String(entry.actor ?? '')
      if (!actor.startsWith('human:')) {
        add(lineNo, 'not_a_human_answer',
          `${name} must be written by a human actor, got ${JSON.stringify(entry.actor ?? null)}`,
          { event: name })
      }
    }
    // A token enters the graph once. A second `opened` would describe work
    // arriving somewhere it already is, and an `opened` after any other event
    // would claim the history above it happened before the work existed.
    if (name === 'opened' && eventsSeen > 0) {
      add(lineNo, 'opened_not_first', 'opened is how a token enters the graph and can only be its first event')
    }
    // §1: flow is one way. A team that has already ADMITTED this token cannot
    // take it again — rework is a NEW token on a fresh route, never the same
    // one moving upstream. `pulled` is the only event that can break the rule,
    // because it is the only one that moves a token BETWEEN teams:
    //   - `returned` hands the work back to the team that still had it. The
    //     dispatcher that refused it checked the token at the DOOR and never
    //     admitted it, so it never held it and may pull it again later — which
    //     is why admission, not arrival, is what fills `heldTeams`.
    //   - `escalated`, `resumed` and `answered` all name the team the token is
    //     already sitting at (`loop-runner.mjs:529` resumes at `last.to_team`),
    //     so none of them is a move at all.
    // Enforced through the sanctioned writer, which validates before AND after
    // every append — so this refuses the line rather than reporting it later.
    if (name === 'pulled' && present(entry.to_team) && heldTeams.has(String(entry.to_team))) {
      add(lineNo, 'route_went_backwards',
        `${entry.to_team} already held this token; flow is one way, and rework is a new token on a fresh route`)
    }

    if ((name === 'opened' || name === 'pulled') && present(entry.to_team)) {
      atTheDoor = String(entry.to_team)
      admittedHere = false
    }
    // Admitted. `intake` is the dispatcher accepting, and its only legal
    // verdict is `accept` — a refusal is written as `returned` or `escalated`
    // instead, and neither of those admits anything.
    if (name === 'intake') {
      admittedHere = true
      if (atTheDoor) { heldTeams.add(atTheDoor); atTheDoor = '' }
    }
    // Master, 2026-08-03, confirming §1 after a live token bounced: a team that
    // has ADMITTED the work does not send it back. It brings the work to a
    // state it can pass and forwards it — a reviewer that finds a problem fixes
    // it through. `returned` is the door saying no BEFORE admission; once
    // `intake` has run, the same word is the loop running backwards.
    // Nothing refused this until now, which is exactly how a hand-written
    // `returned` came to sit at line 30 of a real `story-1-10` ledger: the
    // operator used the only move the system left open.
    if (name === 'returned' && admittedHere && present(entry.to_team)) {
      add(lineNo, 'sent_back_after_admission',
        `this team admitted the token, so it cannot send it back to ${entry.to_team};`
        + ' bring the work to a state it can pass and forward it')
    }
    if (name === 'returned') {
      atTheDoor = ''
      admittedHere = false
      // The door may say no three times. A fourth refusal by the same seat is
      // not a check, it is two seats disagreeing with nobody deciding, and the
      // token would bounce for as long as both keep their opinion. The runner
      // escalates instead (`loop-runner.mjs`); this refuses the line if it
      // somehow gets written anyway.
      const refuser = present(entry.refused_by) ? String(entry.refused_by) : ''
      if (refuser) {
        const already = doorRefusals.get(refuser) ?? 0
        if (already >= MAX_DOOR_REFUSALS) {
          add(lineNo, 'door_refusals_exhausted',
            `${refuser} has already refused this token ${already} times at the door;`
            + ' the next one has to go to the controller')
        }
        doorRefusals.set(refuser, already + 1)
      }
    }
    if (name === 'assigned' && present(entry.agent_id)) assignedAgents.add(String(entry.agent_id))
    // Each id opens exactly one leg (B2). Reported before the first-owner
    // bookkeeping below runs, so the SAME line that reuses an id is both the
    // one that gets refused here and the one `dispatchOwner`/`assignedIndexByTask`
    // would otherwise have silently let win.
    if (name === 'assigned' && present(entry.task_id)) {
      const taskId = String(entry.task_id)
      if (assignedTaskIds.has(taskId)) {
        add(lineNo, 'duplicate_task_id',
          `assigned reuses task_id ${taskId}; each leg's task_id must be unique within this ledger`)
      }
      assignedTaskIds.add(taskId)
    }
    if (name === 'assigned' && present(entry.dispatch_id)) {
      const dispatchId = String(entry.dispatch_id)
      if (assignedDispatchIds.has(dispatchId)) {
        add(lineNo, 'duplicate_dispatch_id',
          `assigned reuses dispatch_id ${dispatchId}; each leg's dispatch_id must be unique within this ledger`)
      }
      assignedDispatchIds.add(dispatchId)
    }
    // First assignment of an ID wins. A dispatch_id is meant to be minted
    // once per leg; if a later `assigned` line reuses one, that reuse is
    // itself the kind of impossible history this file exists to catch
    // elsewhere, not a reason to let the ID's meaning drift underneath it.
    if (name === 'assigned' && present(entry.dispatch_id) && !dispatchOwner.has(String(entry.dispatch_id))) {
      dispatchOwner.set(String(entry.dispatch_id), {
        agent_id: present(entry.agent_id) ? String(entry.agent_id) : '',
        task_id: present(entry.task_id) ? String(entry.task_id) : '',
      })
    }
    if (name === 'delivered') deliveredSeen = true
    if (name === 'audit_requested') auditRequested = true
    if (name === 'questioned') {
      questionAsked = true
      openQuestionId = present(entry.question_id) ? String(entry.question_id) : null
    }
    // Consumed on the answer, and on the one other event that closes a live
    // question without one: the clock's withdrawal (`abandoned`, written by
    // the runner — §9 — when nobody replied in time). A `questionAsked` left
    // true after either would let a stray later `answered` bind to a question
    // that was already resolved.
    if (name === 'answered' || (name === 'abandoned' && questionAsked)) {
      questionAsked = false
      openQuestionId = null
    }
    if (!closedAt && TERMINAL_EVENTS.has(name)) closedAt = { line: lineNo, event: name }
    if (!hardClosedAt && HARD_TERMINAL_EVENTS.has(name)) hardClosedAt = { line: lineNo, event: name }
    eventsSeen += 1
  }

  return { ok: problems.length === 0, problems }
}

// B5 (2026-08-04): three independent reviews (qwen, agy, codex) each rebuilt a
// hand-crafted ledger that validated clean under the 88bd851 rules and showed
// it permanently frozen by two rules this amendment added — `question_id` on
// `questioned` and `actor_kind: 'human'` on `opened`. The prior fix for the
// SAME shape of problem (a rule tightened under a system already running —
// §1's `route_went_backwards`/`sent_back_after_admission`, see
// `ledger-writer.mjs`) tolerated by RAW CODE alone. That is too blunt for
// these two: `missing_field` fires for every required field on every event —
// tolerating it by code alone would silently wave through a brand-new
// `delivered` missing `agent_id` — and `not_a_human_answer` fires for
// `answered` too, whose human-actor rule is NOT new and was never legal to
// violate, even at 88bd851.
//
// So tolerance here is SCOPED: (code, event[, field]), matched against the
// metadata `validateLedger` now attaches to the two problems that need it.
// Only a ledger-format marker was the other shape offered, and it was
// rejected: this system's ledgers are meant to be readable by grep and never
// rewritten (§4, §13); a marker would mean every reader either understands
// versioning or treats "no marker" as "assume legacy", which is the same
// scoped-by-shape reasoning below with an extra field to keep in sync
// forever. A half-migrated ledger — an old `questioned` with no
// `question_id` followed, after this fix ships, by a fresh one that DOES
// carry one — needs no special case: each violation is judged at its own
// line, so the old line is excused and the new one is held to the rule that
// was in force when it was written.
//
// Exported so every consumer that must decide "can this existing history be
// believed" — the writer deciding whether an append may proceed, the pull
// controller deciding whether a token may move to the next team — reads the
// same list. Two independent copies of this judgment already drifted once:
// codex's B5 finding is that `ledger-writer.mjs`'s tolerance was writer-only,
// so a token that regained the ability to be APPENDED to still could not be
// PULLED forward, because `pull-controller.mjs` called `validateLedger`
// straight and required `ok` with no tolerance concept at all.
// qwen #2, retro-release-review 2026-08-04: B2's `duplicate_task_id` /
// `duplicate_dispatch_id` are the same shape of trouble as every entry above —
// a rule that only started existing under a system already running. The FIRST
// attempt at fixing this joined them to this very list, bare, and that was
// wrong in a way three more reviews (qwen F-1, codex BLOCKER 3) needed a
// second round to name precisely.
//
// Every rule above this comment is matched by `isLegacyTolerated`, which
// `validateLedgerTolerant`/`validateLedgerFileTolerant` use — the judgment
// `pull-controller.mjs`, `kanban.mjs`, and `loop-runner.mjs`'s tick all share
// for "can this ledger be TRUSTED", including for moving a token FORWARD.
// `route_went_backwards`, `sent_back_after_admission`, an old `questioned`
// missing `question_id`, an old agent-authored `opened` — none of those four
// change what a `dispatch_id` or `task_id` MEANS. A reader that trusts the
// rest of the ledger around one of them is trusting a fact that is still
// true. A duplicate id is different in kind, not degree: `currentEntry`
// (dispatch-facts.mjs) and `dispatchOwner` (above) both depend on an id
// resolving to exactly ONE leg for its whole life, and a ledger that reuses
// one has broken that for every line after the reuse, forever — trusting it
// enough to move the token is trusting a coin flip about which leg a stale
// reviewed/delivered line actually belongs to. Tolerating the CODE, with no
// event or field to narrow it, tolerated every ledger that will ever carry
// that code — one written before this fix existed and one a concurrent
// writer race, a replay, or a hand edit produces tomorrow look identical to
// `isLegacyTolerated`, which has no notion of "when" at all. That is
// precisely qwen F-1's reproduction: a fresh duplicate dispatch_id let a dead
// leg's late review read as the live leg's own outcome, through the exact
// tolerance meant only to let an OLD collision be closed. So
// `duplicate_task_id` and `duplicate_dispatch_id` — and the
// `dispatch_id_agent_mismatch`/`dispatch_id_task_mismatch` a reused
// dispatch_id produces on every later line naming it, since `dispatchOwner`
// keeps only the first owner — are never in this list. No reader that decides
// whether a token may move, be dispatched onto, or be read as on-track ever
// treats a duplicated id as anything but blocking, no matter how old it is.
export const LEGACY_TOLERATED_PROBLEMS = [
  { code: 'route_went_backwards' },
  { code: 'sent_back_after_admission' },
  { code: 'missing_field', event: 'questioned', field: 'question_id' },
  { code: 'not_a_human_answer', event: 'opened' },
]

export function isLegacyTolerated(problem) {
  return LEGACY_TOLERATED_PROBLEMS.some((rule) => rule.code === problem.code
    && (rule.event === undefined || rule.event === problem.event)
    && (rule.field === undefined || rule.field === problem.field))
}

// codex BLOCKER 3 (retro-release-review round 4, 2026-08-04) is the other
// half of the same finding: a ledger whose ONLY defect is a genuinely
// pre-existing duplicate id must still be CLOSEABLE, or the fix trades one
// bug (a rule that traps every duplicate forever, B2's original complaint)
// for a worse one — a rule that can trap a token with no legal terminal at
// all. A token must always be able to reach `abandoned`.
//
// This is a SEPARATE, wider list from `LEGACY_TOLERATED_PROBLEMS` above, and
// it has exactly one caller: `appendEvent`'s `continuable` check in
// ledger-writer.mjs, and there only when the line being appended is itself a
// TERMINAL event (contract §5) — never for a `pulled`, an `assigned`, or any
// other continuation, and never for `isLegacyTolerated`,
// `validateLedgerTolerant`, or `validateLedgerFileTolerant`. Closing a
// ledger records that the token is done being trusted; it is not the same
// claim as trusting it enough to move.
export const CLOSING_TOLERATED_PROBLEMS = [
  ...LEGACY_TOLERATED_PROBLEMS,
  { code: 'duplicate_task_id' },
  { code: 'duplicate_dispatch_id' },
  { code: 'dispatch_id_agent_mismatch' },
  { code: 'dispatch_id_task_mismatch' },
]

export function isClosingTolerated(problem) {
  return CLOSING_TOLERATED_PROBLEMS.some((rule) => rule.code === problem.code
    && (rule.event === undefined || rule.event === problem.event)
    && (rule.field === undefined || rule.field === problem.field))
}

// A ledger's-worth of `validateLedger` output, re-scored with the legacy
// tolerance above applied. `problems` is still EVERY problem the ledger has —
// nothing here hides history from a reader who wants to see it all — but
// `ok`/`blocking` answer "does anything here actually stop this ledger from
// being trusted", which is the question both `appendEvent` and `planPulls`
// are really asking.
export function validateLedgerTolerant(lines) {
  const result = validateLedger(lines)
  const blocking = result.problems.filter((problem) => !isLegacyTolerated(problem))
  return { ok: blocking.length === 0, problems: result.problems, blocking }
}

// Reads one ledger file under the contract's byte ceiling. A file larger than
// the ceiling is validated on the bytes the loop would actually read, because a
// verdict about bytes nobody parses is not a verdict about this system.
export function validateLedgerFile(path) {
  let text
  try {
    text = readFileSync(path).subarray(0, MAX_LEDGER_BYTES).toString('utf8')
  } catch (error) {
    return { ok: false, problems: [{ line: 0, code: 'unreadable', detail: error.message }] }
  }
  return validateLedger(text.split('\n'))
}

// The file-reading twin of `validateLedgerTolerant`, for the one other place
// (`loop-runner.mjs`'s tick) that decides "can this on-disk history be
// believed" straight from a path rather than from lines already in memory.
// Before B5 that place called `validateLedgerFile` and required raw `ok`,
// which meant a token whose only problems were legacy-tolerated could be
// appended to and pulled forward but never dispatched onto again — stuck a
// third way after the first two were fixed.
export function validateLedgerFileTolerant(path) {
  const result = validateLedgerFile(path)
  const blocking = result.problems.filter((problem) => !isLegacyTolerated(problem))
  return { ok: blocking.length === 0, problems: result.problems, blocking }
}

export function validateWorkItems(repo) {
  const dir = join(repo, '.tmux-teams', 'work-items')
  let names
  try {
    names = readdirSync(dir).slice(0, MAX_FILES)
  } catch (error) {
    return { ok: false, files: [], problems: [{ line: 0, code: 'unreadable', detail: error.message }] }
  }
  const files = []
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    files.push({ path, ...validateLedgerFile(path) })
  }
  return { ok: files.every((file) => file.ok), files, problems: [] }
}

const USAGE = `usage:
  ledger-validate.mjs <ledger.jsonl> [more.jsonl ...]
  ledger-validate.mjs --repo <repo>        validate every token under .tmux-teams/work-items

Exits non-zero when any ledger has a problem.`

function main(argv) {
  const args = argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return args.length ? 0 : 2
  }

  let results = []
  const repoFlag = args.indexOf('--repo')
  if (repoFlag !== -1) {
    const repo = args[repoFlag + 1]
    if (!repo) {
      process.stderr.write('--repo needs a directory\n')
      return 2
    }
    const scan = validateWorkItems(resolve(repo))
    if (scan.problems.length) {
      process.stderr.write(`cannot read ${repo}: ${scan.problems[0].detail}\n`)
      return 2
    }
    results = scan.files
  } else {
    results = args.map((path) => ({ path: resolve(path), ...validateLedgerFile(resolve(path)) }))
  }

  if (!results.length) {
    process.stdout.write('no ledgers found\n')
    return 0
  }

  let failed = 0
  for (const result of results) {
    if (result.ok) {
      process.stdout.write(`PASS  ${result.path}\n`)
      continue
    }
    failed += 1
    process.stdout.write(`FAIL  ${result.path}  (${result.problems.length} problem(s))\n`)
    for (const problem of result.problems) {
      process.stdout.write(`  line ${problem.line}  ${problem.code}  ${problem.detail}\n`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
