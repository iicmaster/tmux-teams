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
import { AUDIT_VERDICTS, REVIEW_VERDICTS } from './role-briefs.mjs'
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
// real lines legitimately carry `reason` on a `pulled` or `dispatch_id` on a
// `delivered` and rejecting those would fight the writers this file exists to
// protect.
export const EVENT_SPEC = {
  // §4.6: work entering the graph for the first time. `pulled` cannot say this
  // — a pull is a team TAKING work from another team, and the first team on a
  // route has nobody to take it from. The alternative considered and rejected
  // was making `from_team` optional on `pulled`: that would stop the validator
  // catching a pull that genuinely forgot its sender, forever, to accommodate
  // one event at the head of each route. A new word costs nothing and leaves
  // `pulled` exactly as strict as it was.
  opened: { required: ['agent_id', 'to_team', 'reason'], forbidden: ['from_team'] },
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
  questioned: { required: ['agent_id', 'questions', 'reason'] },
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
const TERMINAL_EVENTS = new Set(['completed', 'audited', 'abandoned'])
const AFTER_COMPLETED = new Set(['audit_requested', 'audited'])

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
  const add = (line, code, detail) => { problems.push({ line, code, detail }) }

  let token = ''
  let prevMs = null
  // Facts accumulated in FILE order. Sorting by `at` the way readers do would
  // destroy the only thing that makes "never goes backwards" checkable.
  const assignedAgents = new Set()
  // Counted, not flagged: `opened` earns its strictness only if a second one
  // later in the file is as illegal as one appended after a `pulled`.
  let eventsSeen = 0
  let deliveredSeen = false
  let auditRequested = false
  let questionAsked = false
  let closedAt = null // { line, event } of the first terminal event

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

    if (!spec) continue

    for (const field of spec.required) {
      if (!present(entry[field])) add(lineNo, 'missing_field', `${name} requires ${field}`)
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

    // ---- sequence ----------------------------------------------------------
    if (closedAt) {
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
    if (name === 'reviewed' && !deliveredSeen) {
      add(lineNo, 'reviewed_without_delivered', 'reviewed with nothing delivered to review')
    }
    if (name === 'audited' && !auditRequested) {
      add(lineNo, 'audited_without_request', 'audited with no preceding audit_requested')
    }
    // An answer to nothing. The pair only means anything together: a lone
    // `answered` would release a token nobody had parked.
    if (name === 'answered' && !questionAsked) {
      add(lineNo, 'answered_without_question', 'answered with no preceding questioned')
    }
    // The kind of writer, not merely its shape. A model relaying a person's
    // words signs `human:` and names itself in `relayed_by`; a model signing as
    // itself has recorded its own opinion as a person's decision.
    if (spec.actor_kind === 'human') {
      const actor = String(entry.actor ?? '')
      if (!actor.startsWith('human:')) {
        add(lineNo, 'not_a_human_answer',
          `${name} must be written by a human actor, got ${JSON.stringify(entry.actor ?? null)}`)
      }
    }
    // A token enters the graph once. A second `opened` would describe work
    // arriving somewhere it already is, and an `opened` after any other event
    // would claim the history above it happened before the work existed.
    if (name === 'opened' && eventsSeen > 0) {
      add(lineNo, 'opened_not_first', 'opened is how a token enters the graph and can only be its first event')
    }

    if (name === 'assigned' && present(entry.agent_id)) assignedAgents.add(String(entry.agent_id))
    if (name === 'delivered') deliveredSeen = true
    if (name === 'audit_requested') auditRequested = true
    if (name === 'questioned') questionAsked = true
    if (!closedAt && TERMINAL_EVENTS.has(name)) closedAt = { line: lineNo, event: name }
    eventsSeen += 1
  }

  return { ok: problems.length === 0, problems }
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
