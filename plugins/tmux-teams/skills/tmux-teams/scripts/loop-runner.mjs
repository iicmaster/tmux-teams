// loop-runner.mjs — the part that makes the loop a loop.
//
// Everything before this was a plan: the graph declared who exists, the ledger
// recorded what happened, the pull controller decided what COULD move. Nothing
// moved it. A loop that needs a human to run each leg is not a loop; it is a
// person with extra steps.
//
// The graph declares four roles. For a long time this file dispatched exactly
// one of them — workers — so a whole route could run with every quality gate
// structurally absent: no team ever accepted a handoff, no team ever passed its
// own work, and nothing could ever be rejected, which is why the reject edges on
// the page could never harden. Every declared role now has a dispatch path.
//
// One token's journey through one team:
//
//   pulled    -> the receiving DISPATCHER checks the handoff (intake)
//   intake    -> a WORKER of that team does the work
//   delivered -> that team's EVALUATOR judges it (inner quality loop)
//   reviewed  -> pass releases it to the pull controller; reject goes back to a
//                worker of the same team
//
// An intake rejection appends `returned`, which sends the token to the team that
// sent it — the only legal backwards move. Anything the runner cannot decide
// (an unresolved review, a retry budget spent, a token nobody can place) goes to
// the outer controller, the one role that sees the whole board.
//
// The runner dispatches and records; it never judges. Every verdict in the
// ledger was stated by the agent whose job it was to state it.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currentEntry, readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { isClosingTolerated, MAX_DOOR_REFUSALS, validateLedgerFileTolerant } from './ledger-validate.mjs'
import { appendEvent as appendLedgerEvent, ledgerPath } from './ledger-writer.mjs'
import { planPulls, applyPulls } from './pull-controller.mjs'
import {
  AUDIT_VERDICTS, INTAKE_VERDICTS, OUTER_VERDICTS, REVIEW_VERDICTS,
  readCategories, readTargetVerdict, readVerdict, readWorkerHint, roleBrief,
} from './role-briefs.mjs'
import { readWorkflowGraph } from './graph.mjs'
import { intakeStats, intakeStatsBrief } from './intake-stats.mjs'
import { DEFAULT_ADAPTER, teamRoleOf } from './workflow-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, 'acp-companion.mjs')
const KMS = join(HERE, 'kms.mjs')
const WORKING = new Set(['running', 'starting', 'orphan_running'])

const MAX_ATTEMPTS = 3   // three failures by one role in one team is a problem to escalate, not retry
// One counter for the whole token. Per-role caps each look reasonable and
// together still let an intake rejection and a review rejection bounce a token
// between two teams indefinitely — the ceiling has to be on the journey.
const MAX_LEGS = 15
// A transport-killed audit leg used to be retried here, up to
// `MAX_AUDIT_TRANSPORT_RETRIES = 3`, then abandoned anyway. The retry is gone
// (2026-08-07, D1): a leg that died before the model took a turn is a problem
// the system should STOP on, not spend three more legs guessing about. It now
// asks a person and holds — which is only an exit because `answer.mjs` exists;
// before it, a question was a place tokens went to die and the retry was the
// least-bad option available. `audit_lost` is still READ everywhere it was
// (`awaitingAudit` below, `kanban.mjs`, `ledger-validate.mjs` and
// `dispatch-facts.mjs`'s RELEASING_EVENTS); nothing writes
// it any more. Removing the word would make every ledger that already carries
// one permanently unclosable — `unknown_event` is not tolerated.
const ZOMBIE_SEC = 180   // an assignment with no live process and nothing delivered
const PM_COOLDOWN_SEC = 900
// Every dispatch is a full agent. Team WIP limits bound each column; nothing
// bounded the board, so a wide graph could fan out without a ceiling.
const MAX_IN_FLIGHT = 4
// Pulse is the only evidence that an agent is still running. If the watcher
// that writes it has died, that evidence is frozen — and acting on frozen
// evidence means either stalling forever or re-dispatching an agent that never
// stopped. Refusing to dispatch is the only safe reading of a stale snapshot.
const PULSE_STALE_SEC = 120
// What the outer controller hands back when it says `resume`: enough attempts
// to get past a transient cause, not an open cheque. Each grant costs one PM
// dispatch, so the ceiling can only rise deliberately.
const RESUME_GRANT = 3
// A board holding work that has not moved in this long is not calm, it is stuck.
const STALL_SEC = 1800
// How long a person has to answer the intake grill before the request is
// withdrawn and the queue is freed. Ten minutes, and Master's reason is part of
// the value: needing longer to answer questions about your own request means the
// request was not thought through. It is an OPTION rather than a constant so a
// test can set it to seconds — the alternative was injecting a clock everywhere,
// and shrinking the threshold proves the same rule for a fraction of the work.
const ANSWER_DEADLINE_SEC = 600
// Retries that succeed are the loop working. Retries that succeed SILENTLY are
// the loop hiding how hard it had to work — one route recovered from four failed
// legs and nobody heard a thing.
const RETRY_NOISE = 3

// ── the runner's own pulse (DECISION 2, writer half) ─────────────────────────
//
// Every other artifact this loop writes describes the AGENTS. None of them
// describes the RUNNER. A runner that has stopped leaves a board that looks
// calm — no agent running, nothing overdue — and a reader concludes there is
// simply no work to do.
//
// The rule that makes this worth writing at all: it is stamped on EVERY tick,
// including the ticks that refuse to dispatch. A heartbeat that only appears on
// healthy ticks says "alive and dispatching" or says nothing, and "nothing" is
// the same silence a dead process leaves. The refusing ticks are precisely the
// ones a reader has to hear about, so `dispatching: false` carries the reason
// in the runner's own words.
export const RUNNER_HEARTBEAT_FILE = 'runner-heartbeat.json'
const HEARTBEAT_SCHEMA = 'tmux-teams.runner-heartbeat'
// The reader judges silence against the runner's OWN interval rather than a
// hard-coded one, so this has to be a real number on every stamp: without it
// the page cannot tell a slow loop from a dead one and says so.
const DEFAULT_TICK_SEC = 30

function writeHeartbeat(repo, { tickSec, dispatching, reason = '', started = 0, held = null }) {
  const record = {
    schema: HEARTBEAT_SCHEMA,
    at: new Date().toISOString(),
    tick_sec: tickSec,
    dispatching,
    // Enforced here rather than trusted from the caller: a stale reason left on
    // a healthy tick would have the runner explaining a hold it is not doing.
    reason: dispatching ? '' : String(reason || ''),
    started,
    held,
  }
  try {
    const dir = join(repo, '.tmux-teams')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, RUNNER_HEARTBEAT_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    // Failing to stamp must never take the tick down with it: the loop moving
    // work matters more than the loop describing itself.
    log(`WARN   could not write ${RUNNER_HEARTBEAT_FILE}: ${error.message}`)
  }
  return record
}

// ── why a token was passed over (C1, contract §11.3) ─────────────────────────
//
// Every refusal the tick decides below is said once, to `log()`, and nowhere
// else — a token nobody looked at and a token refused for cause become the
// same thing the moment the tick ends, because neither survives the process
// that decided it. This file is the fix: it is overwritten whole every tick,
// never appended, so it can answer "why is this not moving right now" and
// deliberately cannot answer "how long has it been stuck" (§11.3).
export const DECISIONS_DIR = 'decisions'
export const DECISIONS_FILE = 'latest.json'

function writeDecisions(repo, decisions) {
  const record = { tick_at: new Date().toISOString(), decisions }
  const dir = join(repo, '.tmux-teams', DECISIONS_DIR)
  const path = join(dir, DECISIONS_FILE)
  const temp = join(dir, `.${DECISIONS_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    // Temp file plus rename, same reason `acp-companion.mjs`'s outbox writes
    // are: a reader polling this path can otherwise open it between create and
    // write, mid-JSON.
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    // Same rule as the heartbeat: failing to describe a tick must never take
    // the tick down. Moving work matters more than explaining why some of it
    // did not move.
    log(`WARN   could not write ${DECISIONS_DIR}/${DECISIONS_FILE}: ${error.message}`)
  }
  return record
}

// ── the declared model (DECISION 3, dispatch half) ───────────────────────────
//
// The bundled default graph has to be a valid graph, so it names a model on
// every seat — and naming a real one would silently run every fresh install on
// somebody else's model choice. It names this instead, and this is the one
// value that means "do not ask for anything".
//
// It is duplicated from workflow-graph.mjs, which defines the same literal but
// does not export it. Someone should export it there and import it here; until
// then the two must be changed together.
export const INHERIT_ACCOUNT_DEFAULT = 'inherit-account-default'

// Read off the agent's own seat rather than re-derived from the team's `models`
// block, so an agent and a model can never be paired from two different rows.
// The outer controller belongs to no team and carries its own.
export function declaredModel(graph, teamId, agentId) {
  if (agentId && agentId === graph.outer_controller_id) return graph.outer_controller_model || ''
  const team = graph.teams.find((entry) => entry.team_id === teamId)
  return team?.agents.find((agent) => agent.agent_id === agentId)?.model || ''
}

// Which lane the seat runs on. Every dispatch used to spawn the literal string
// `claude` regardless of what the graph said, so a seat could declare a model
// only its own lane would ever answer to and still be handed to Claude — the
// declaration and the dispatch disagreeing with nothing able to notice. The
// graph defaults every unnamed seat to `claude`, so this changes no existing
// board; it lets a new one mean what it says.
export function declaredAdapter(graph, teamId, agentId) {
  if (agentId && agentId === graph.outer_controller_id) return graph.outer_controller_adapter || DEFAULT_ADAPTER
  const team = graph.teams.find((entry) => entry.team_id === teamId)
  return team?.agents.find((agent) => agent.agent_id === agentId)?.adapter || DEFAULT_ADAPTER
}

// The safety rule this whole branch exists for. acp-companion treats a REQUESTED
// model as a promise it must keep: setting ACP_EXPECT_MODEL starts
// `identity_status` at `missing`, and the session receipt is rejected outright
// unless the adapter answers with exactly that name. So the sentinel — and an
// empty name — must set NOTHING, leaving the account default in place. Only a
// real declared name is ever passed through, because only a real declared name
// is something the adapter can be held to.
// ACP_EXPECT_MODEL is an EXPECTATION: it starts `identity_status` at `missing`
// and fails the dispatch unless the adapter already answers with that name.
// ACP_MODEL is the REQUEST — the session/set_config_option that makes the
// adapter become it. Sending only the expectation meant the loop demanded a
// model it never asked for: every seat ran on the account default and any seat
// declaring anything else failed instead of being honored. The declared name in
// `graph.json` was decoration. Both are sent now, so the request is made and
// then verified, which is the pair the companion was built for.
export function modelEnv(model) {
  const name = typeof model === 'string' ? model.trim() : ''
  return name && name !== INHERIT_ACCOUNT_DEFAULT ? { ACP_MODEL: name, ACP_EXPECT_MODEL: name } : {}
}

// GitHub #32: a seat's declared reasoning effort, read the same way as its
// model — off the agent's own resolved seat, never re-paired from a role
// block, and the outer controller off its own top-level field. Unlike model
// there is no `INHERIT_ACCOUNT_DEFAULT` sentinel to filter: effort has no
// required declaration at all, so an unset seat already reads as `''` and
// `effortEnv` below already treats that as "ask for nothing".
export function declaredEffort(graph, teamId, agentId) {
  if (agentId && agentId === graph.outer_controller_id) return graph.outer_controller_effort || ''
  const team = graph.teams.find((entry) => entry.team_id === teamId)
  return team?.agents.find((agent) => agent.agent_id === agentId)?.effort || ''
}

// GitHub #47 phase 2 (§3.5): a seat's declared palette, read the same way as
// its model/adapter/effort above — off the agent's own resolved seat, never
// re-paired from a role block. `null` for a seat that declared none, or the
// fully-resolved array workflow-graph.mjs already computed (every entry's
// adapter/effort/display_model/bucket default already applied — nothing here
// re-derives a default). The outer controller can never declare one (§3.2.1,
// AC103 refuses it at load) so it reads null here unconditionally rather than
// reaching for a field that does not exist on it.
export function declaredPalette(graph, teamId, agentId) {
  if (agentId && agentId === graph.outer_controller_id) return null
  const team = graph.teams.find((entry) => entry.team_id === teamId)
  return team?.agents.find((agent) => agent.agent_id === agentId)?.palette ?? null
}

// The same request/expectation pair `modelEnv` sends, for the other half of
// identity `acp-companion.mjs` already verifies: `ACP_REASONING_EFFORT` is the
// request, `ACP_EXPECT_REASONING_EFFORT` is what holds the receipt to it. This
// was the gap #32 opened with — the companion supported both env vars and
// nothing upstream of it ever set them, so a graph declaring an effort per
// seat had no way to reach the process it was declared for.
export function effortEnv(effort) {
  const name = typeof effort === 'string' ? effort.trim() : ''
  return name ? { ACP_REASONING_EFFORT: name, ACP_EXPECT_REASONING_EFFORT: name } : {}
}

const readJson = (path, fallback = null) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

const log = (line) => console.log(`[loop] ${line}`)

const field = (text, key) => {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return match ? match[1].trim() : ''
}

// An agent is free when nothing of its own is currently running. Pulse is the
// authority on that: guessing from file mtimes is how a second dispatch lands
// on an agent that never stopped.
//
// `state` is pulse's OS-level probe, and it can read a live companion as gone
// for a single tick — a ps or lsof scan that misses once. `nextStep` has no
// debounce, so one such tick after ZOMBIE_SEC is the whole story: a review
// running the three-model gate for twenty minutes was declared lost and
// replaced twice on one token, burning legs against a ceiling.
//
// The worker was never silent. `acp-companion` writes its own heartbeat under
// `.tmux-teams/liveness/` faster than once a second and says `tool_running`
// while a tool is in flight; pulse validates its provenance and republishes it
// on the row as `liveness_evidence`. Nothing read it. A second, independent
// witness that the leg is alive was being published and thrown away.
//
// Freshness is re-checked here rather than trusting that the row carries it:
// pulse accepts a liveness file for hours, which is the right window for a page
// and far too long for a zombie check. A companion that died without writing a
// terminal state must still time out.
const LIVENESS_TERMINAL = new Set(['completed', 'cancelled', 'failed'])
const liveEvidence = (row, nowMs) => {
  const evidence = row.liveness_evidence
  if (!evidence || LIVENESS_TERMINAL.has(evidence.liveness_state)) return false
  const observedMs = Date.parse(evidence.observed_at || '')
  return Number.isFinite(observedMs) && (nowMs - observedMs) / 1000 < ZOMBIE_SEC
}

export function busyAgents(repo, nowMs = Date.now()) {
  const snapshot = readJson(join(repo, '.tmux-teams', 'pulse.json'), null)
  const generatedMs = Date.parse(snapshot?.generated_at || '')
  const ageSec = Number.isFinite(generatedMs) ? Math.round((nowMs - generatedMs) / 1000) : null
  const rows = [...(snapshot?.runs || []), ...(snapshot?.history?.runs || [])]
  const newest = new Map()
  for (const row of rows) {
    if (!row.agent_id) continue
    const seen = newest.get(row.agent_id)
    if (!seen || String(row.started_at || '') > String(seen.started_at || '')) newest.set(row.agent_id, row)
  }
  const liveRows = [...newest.values()].filter((row) => WORKING.has(row.state) || liveEvidence(row, nowMs))
  const busy = new Set(liveRows.map((row) => row.agent_id))
  // WHICH leg is live, not merely which agent. r7-codex: an expiry guard that
  // asks `busy.has(agentId)` suppresses a withdrawal for as long as that agent
  // is running ANYTHING — and the outer controller is always running something,
  // so a token parked on a controller leg that died could be held open forever
  // by unrelated work. The pulse row carries the task, so the question can be
  // asked about the leg the token is actually parked on.
  const busyTasks = new Set(liveRows.map((row) => row.task_id).filter(Boolean))
  // No snapshot at all is a repo where nothing has ever run — there is no agent
  // to collide with, so the first dispatch is safe. A snapshot that EXISTS but
  // has stopped moving is the dangerous one: it can still be asserting that
  // agents are running, and it is no longer able to say when they stop.
  const missing = snapshot === null
  return {
    busy, busyTasks, ageSec, missing,
    stale: !missing && (ageSec === null || ageSec > PULSE_STALE_SEC),
  }
}

// Read the bytes once and say what they hashed to. The companion records the
// digest of the outbox it classified on the `delivered` event; this reads the
// same path a tick or more later. Two independent reads of one mutable path are
// two facts, and only the digest can tell whether they are the same one.
const readOutbox = (repo, taskId) => {
  if (!taskId) return { text: '', digest: null }
  try {
    const bytes = readFileSync(join(repo, '.mailbox-out', taskId))
    return { text: bytes.toString('utf8'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
  } catch { return { text: '', digest: null } }
}

const dispatchRecord = (repo, taskId) => {
  if (!taskId) return {}
  try {
    const text = readFileSync(join(repo, '.tmux-teams', 'dispatch', `${taskId}.md`), 'utf8')
    return {
      worker: field(text, 'worker'), dispatch_id: field(text, 'dispatch_id'),
      transport: field(text, 'transport'), started_at: field(text, 'started_at'),
    }
  } catch { return {} }
}

// DECISION 4, write half. Every line this runner adds to a custody ledger goes
// through the one sanctioned writer, which stamps an accountable actor and
// checks the line both against contract §4 and against the ledger it is
// joining. Writing straight to the file — which is what this used to do — is
// exactly the hand-append the writer exists to make impossible to imitate.
//
// A refused write returns false and is NOT counted as having happened. A runner
// that logs an event it failed to record is telling the same lie the ledger is
// supposed to prevent.
const RUNNER_ACTOR = 'agent:runner'

// The last resort for a token whose history stopped being believable while a
// worker still held it.
//
// AGY raised the shape in round six and it survives narrowed: on a ledger whose
// only defects are closing-tolerated (a genuinely pre-existing duplicate id),
// the writer accepts `audited` and `abandoned` and nothing else. Every event an
// automated writer would otherwise reach for — `delivered`, `completed`,
// `escalated`, and `lost` itself — is refused, so the token can never arrive at
// the `expired` branch below that writes the runner's automatic `abandoned`.
// Reproduced: five events offered to such a ledger, four refused, `abandoned`
// accepted. The escape hatch `CLOSING_TOLERATED_PROBLEMS` promises ("a token
// must always be able to reach `abandoned`") existed with no automated caller
// able to walk through it.
//
// This is deliberately narrow. It fires only after a `lost` was already
// refused, only when EVERY blocking problem is closing-tolerated, and it writes
// the one event that closes the token rather than any event that continues it.
// A ledger broken in any other way is still left alone for a human, which is
// the whole point of refusing to write onto bytes nobody can believe.
function closeUnbelievableHistory(repo, plan, items) {
  const ledger = validateLedgerFileTolerant(ledgerPath(repo, plan.work_item))
  if (ledger.ok || ledger.blocking.length === 0) return false
  if (!ledger.blocking.every((problem) => isClosingTolerated(problem))) return false
  const codes = [...new Set(ledger.blocking.map((problem) => problem.code))].join(', ')
  log(`CLOSE  ${plan.work_item}: history cannot be believed (${codes}) and `
    + 'no continuation may be written onto it — abandoning rather than wedging the token')
  return record(repo, {
    at: new Date().toISOString(), event: 'abandoned', work_item: plan.work_item,
    workflow: items.get(plan.work_item)?.workflow || null,
    agent_id: plan.agent_id,
    reason: `${plan.reason} — and the ledger cannot be continued (${codes}); closed by the runner so the token is not stranded`,
  })
}

// `locked` is the ONE refusal that says nothing about the event: the companion
// held the ledger's lock, and the next attempt may write. Every other code is a
// verdict on the bytes, and retrying a verdict is how a runner argues with its
// own validator. Retried here rather than at the five call sites below, because
// the sites that DO handle a refusal (`wedged`, `closeUnbelievableHistory`) all
// treat it as a statement about the history — which contention is not.
const LOCKED_RECORD_RETRIES = 2

function record(repo, event, actor = RUNNER_ACTOR) {
  let result
  for (let attempt = 0; ; attempt += 1) {
    result = appendLedgerEvent(repo, event, { actor })
    if (result.ok || result.code !== 'locked' || attempt >= LOCKED_RECORD_RETRIES) break
    log(`busy   ${event.work_item}: ledger locked, retrying ${event.event} (${attempt + 1}/${LOCKED_RECORD_RETRIES})`)
  }
  if (result.ok) return true
  log(`REFUSED ${event.work_item}: ${event.event} was not recorded — ${result.code}: ${result.detail}`)
  for (const problem of (result.problems || []).slice(0, 5)) {
    log(`        line ${problem.line}  ${problem.code}  ${problem.detail}`)
  }
  return false
}

// The artifact a route carries forward is the last thing a WORKER actually
// delivered. Taking the newest `delivered` of any kind hands the next team a
// review memo — or, as happened here, tells it there is no evidence while the
// design spec it needed sat unread in `.mailbox-out/`.
//
// BLOCKER 2 (retro-release-review round 5, 2026-08-04): "newest" used to mean
// newest by ARRIVAL — the position in `custody`, which is sorted by `at`
// (readWorkItems, dispatch-facts.mjs). A late report from a leg already
// declared `lost` is stamped with an `at` from whenever it finally landed, not
// from when its leg was live, so it can sort AFTER a newer leg's own
// `assigned`/`delivered` pair and still read as "the newest delivered" by a
// raw backwards scan. Scenario: w1 assigned, w1 lost, w2 assigned (retry), w2
// delivers (the artifact actually in play), the evaluator is assigned and
// starts working — and only THEN does w1's late, superseded success arrive.
// Custody order is now [...w1 assigned, w1 lost, w2 assigned, w2 delivered,
// evaluator assigned, w1 delivered], and the old scan returned w1's stale
// delivery: the evaluator's brief and outbox, and the `reviewed_task`/verdict
// storage that key off this function, all pointed at the wrong leg's bytes.
//
// The fix ranks by when the delivering leg was OPENED (its own `assigned`
// entry's position in the ledger, which is authored in dispatch order and
// never arrives late — §4 requires every `assigned` to carry the `task_id`
// the delivery's `task_id` is matched back to it by), not by when the
// delivery HAPPENED TO ARRIVE. The newest-opened leg with a genuine worker
// delivery wins, however late its own report shows up. A `delivered` whose
// `task_id` does not resolve to any `assigned` in this ledger cannot be
// placed in that order at all — house rule: a branch that cannot answer says
// UNKNOWN, never "newest" — so it is not considered.
function lastWorkerDelivery(graph, item) {
  const assignedIndexByTask = new Map()
  item.custody.forEach((entry, index) => {
    if (entry.event === 'assigned' && entry.task_id !== undefined && entry.task_id !== null) {
      assignedIndexByTask.set(String(entry.task_id), index)
    }
  })
  let best = null
  let bestAssignedIndex = -1
  for (const entry of item.custody) {
    if (entry.event !== 'delivered' || entry.terminal !== 'done' || !entry.task_id) continue
    if (teamRoleOf(graph, entry.agent_id)?.role !== 'worker') continue
    const assignedIndex = assignedIndexByTask.get(String(entry.task_id))
    if (assignedIndex === undefined || assignedIndex <= bestAssignedIndex) continue
    bestAssignedIndex = assignedIndex
    best = entry
  }
  return best
}

const lastOf = (item, predicate) => [...item.custody].reverse().find(predicate) || null

const failedLegs = (item) => item.custody.filter((entry) =>
  entry.event === 'lost' || (entry.event === 'delivered' && entry.terminal && entry.terminal !== 'done')).length

// A route that closed and has not been read as a whole. Every evaluator checked
// its own leg; nobody checked whether what came out of the end is what was
// asked for.
// F4: this used to ask "has ANY audit_requested/audited appeared since the
// route closed" — a tripwire that, once it saw the FIRST `audit_requested`,
// never fired again for that route, even after a `questioned`/`answered`
// round trip left the delivery genuinely unread. `completed -> audit_requested
// -> questioned -> answered` contains `audit_requested`, so the old check
// called that route audited and it was never re-escalated: the person's reply
// had nowhere to go. Read off the CURRENT state instead: due exactly when
// nothing has asked yet (`completed`) or when a person just replied
// (`answered`) — not when a request is already in flight (`audit_requested`,
// being watched by `planHarvest`) or already parked on a person (`questioned`,
// not this function's job) or already closed (`audited`/`abandoned`, §5).
// M3 (retro-release-review, 2026-08-04): this used to read the raw last
// event name instead of `currentEntry`. A mixed-version or manually accepted
// ledger can carry `completed -> audit_requested -> questioned -> answered`
// followed by a superseded late outcome from a dead leg; `currentEntry` skips
// that stale trailing entry and exposes `answered` as current, but the raw
// tail read it as whatever the stale entry's event was and silently
// suppressed the re-escalation this function exists to guarantee.
const awaitingAudit = (item) => {
  if (!item.custody.some((entry) => entry.event === 'completed')) return false
  const current = currentEntry(item.custody).event
  // `audit_lost` re-arms exactly the way `answered` does: the controller owes
  // this token a verdict and has not given one. It is NOT a terminal, and this
  // was the whole re-dispatch mechanism for GitHub #52 — no new spawn path was
  // added, only membership in the set this function already decides.
  // Nothing WRITES `audit_lost` since 2026-08-07 (the transport-death path asks
  // a person instead), and it stays in this set for the ledgers written while it
  // did: dropping it would leave those tokens re-arming for nobody. `answered`
  // is what carries the new path — a person replies, the audit fires again.
  return current === 'completed' || current === 'answered' || current === 'audit_lost'
}

// ── briefs ───────────────────────────────────────────────────────────────────

function composeBrief(repo, graph, plan, item, scratchDir, answerDeadlineSec = ANSWER_DEADLINE_SEC) {
  const { team, role } = plan
  const parts = []

  // r4-codex (retro-release-review, 2026-08-04): a dispatch that exists
  // BECAUSE a person just answered a question carried that exchange nowhere
  // on this page. Every branch below reads the standing brief and the
  // previous delivery; neither says what was asked or what the person said.
  // The reproduction was literal: a front-door dispatcher re-run with the
  // original ambiguous request and no memory of the human's reply — free to
  // ask the same question again. `currentEntry` is the authority on whether
  // THIS dispatch is the answered-triggered one (nextStep only reaches
  // `want()` for an `answered` last entry); `lastOf` finds the question it
  // closed the same way `nextStep`'s own resume_role read does.
  const current = currentEntry(item.custody)
  if (current?.event === 'answered') {
    const askedBy = lastOf(item, (entry) => entry.event === 'questioned')
    parts.push(`# A person just answered a question about this token\n\n`
      + `**Asked:** ${askedBy?.questions || 'no question text recorded'}\n\n`
      + `**Answered:** ${current.reason || 'no reason stated'}\n\n---\n\n`)
  }

  // The route carries artifacts forward, but the original ask had nowhere to
  // live: the first team on a route got a standing brief describing what that
  // team does and nothing saying what this token is FOR. The token owns its own
  // request, so every role on every leg reads the same one.
  const request = join(repo, '.tmux-teams', 'work-items', `${item.work_item}.md`)
  if (existsSync(request)) {
    parts.push(`# The request this token carries (\`${item.work_item}\`)\n\n${readFileSync(request, 'utf8')}\n\n---\n\n`)
  }

  if (role === 'worker') {
    const standing = join(repo, '.tmux-teams', 'team-briefs', `${team.team_id}.md`)
    if (!existsSync(standing)) {
      return { path: null, reason: `no standing brief at .tmux-teams/team-briefs/${team.team_id}.md` }
    }
    parts.push(readFileSync(standing, 'utf8'))
    // Rework is not a fresh start. A worker told only "do the work" repeats the
    // work that was already refused.
    const refusal = lastOf(item, (entry) => ['reviewed', 'returned'].includes(entry.event))
    if (refusal && refusal.verdict !== 'pass') {
      parts.push('\n\n---\n\n# This came back — rework, not a fresh start\n\n'
        + `${refusal.event === 'returned' ? 'The receiving team refused the handoff' : 'Your team evaluator rejected it'}: `
        + `${refusal.reason || 'no reason was stated'}\n`)
    }
  } else if (role === 'dispatcher' && team.team_id === graph.controller_team) {
    // The system's front door, not a team's. It judges a REQUEST rather than a
    // handoff, it may ask instead of only taking or refusing, and it is the one
    // brief in this system addressed at a person on the other side of an agent.
    // H2 (retro-release-review, 2026-08-04): this used to list EVERY declared
    // workflow, worded as a menu the grill picks from — but `intake`'s accept
    // event (below) has no field for a route decision and nothing downstream
    // ever reads one out of the grill's reply. The route was fixed at
    // admission (item.workflow); naming only that one route matches the brief
    // text above, which now says the same thing honestly. Falls back to the
    // full list only if the admitted workflow is not declared — an orphaned
    // token still deserves to see what routes exist at all.
    const admittedWorkflow = graph.workflows.find((entry) => entry.workflow_id === item.workflow)
    parts.push(roleBrief(repo, 'grill', team.team_id, {
      workItem: item.work_item,
      route: admittedWorkflow
        ? `${admittedWorkflow.workflow_id} (${admittedWorkflow.route.join(' → ')})`
        : graph.workflows.map((entry) => `${entry.workflow_id} (${entry.route.join(' → ')})`).join(', '),
      // An absolute time, not "you have ten minutes": it needs no page to
      // render it and cannot drift the way a duration read late does. The
      // operator relaying this renders it in the reader's own zone (§6.4).
      deadlineText: new Date(Date.now() + answerDeadlineSec * 1000).toISOString().slice(11, 16) + ' UTC',
    }))
  } else if (role === 'dispatcher') {
    const workflow = graph.workflows.find((entry) => entry.workflow_id === item.workflow)
    // Either arrival carries the context the dispatcher is judging: a `pulled`
    // names the team that sent it, an `opened` names why the work exists at all.
    const pulled = lastOf(item, (entry) => entry.event === 'pulled' || entry.event === 'opened')
    // What the dispatcher can pick FROM, so a hint names a real seat rather
    // than being guessed at. Declared order, matching `nextStep`'s own default.
    const workers = team.agents
      .filter((agent) => agent.role === 'worker')
      .map((agent) => `${agent.agent_id} (model=${agent.model}${agent.effort ? `, effort=${agent.effort}` : ''})`)
    parts.push(roleBrief(repo, 'dispatcher', team.team_id, {
      teamName: team.name,
      workItem: item.work_item,
      fromTeam: pulled?.from_team || '',
      route: workflow ? workflow.route.join(' -> ') : 'unknown',
      workers,
    }))
  } else if (role === 'evaluator') {
    const delivery = lastWorkerDelivery(graph, item)
    parts.push(roleBrief(repo, 'evaluator', team.team_id, {
      teamName: team.name,
      workItem: item.work_item,
      workerId: delivery?.agent_id || 'a worker of this team',
      // GitHub #31 stage 2: only a `produces: 'verdict'` team's evaluator gets
      // the TARGET_VERDICT instruction — see workflow-graph.mjs TEAM_PRODUCES.
      // `team.produces` is undefined for any graph normalized before that
      // field existed, and undefined !== 'verdict' is false, so an older
      // graph gets back the exact brief it always got.
      producesVerdict: team.produces === 'verdict',
    }))
    const standing = join(repo, '.tmux-teams', 'team-briefs', `${team.team_id}.md`)
    if (existsSync(standing)) {
      parts.push(`\n\n---\n\n# The standing brief this team works from\n\n${readFileSync(standing, 'utf8')}`)
    }
  }

  // Every role reads what the previous worker actually produced: the worker
  // builds on it, the dispatcher decides whether it is enough to start on, the
  // evaluator judges it.
  const previous = lastWorkerDelivery(graph, item)
  if (previous) {
    const { text } = readOutbox(repo, previous.task_id)
    parts.push(text
      ? `\n\n---\n\n# Delivered by \`${previous.agent_id}\` (task \`${previous.task_id}\`)\n\n${text}`
      : `\n\n---\n\n# Note\n\nTask \`${previous.task_id}\` left no outbox on disk. Work from the brief above and`
        + ' record in your own outbox that the previous leg produced no evidence.\n')
  }

  mkdirSync(scratchDir, { recursive: true })
  const path = join(scratchDir, `brief-${item.work_item}-${team.team_id}-${role}.md`)
  writeFileSync(path, parts.join(''))
  return { path, reason: null }
}

// ── harvest: turn a finished judging leg into a custody event ────────────────

export function planHarvest(graph, items, hasOutbox = () => false) {
  const jobs = []
  for (const item of items.values()) {
    const last = currentEntry(item.custody)
    if (!last) continue
    // The controller's leg carries no work item, so its answer cannot arrive as
    // a `delivered` event on this token. The escalation names the task; the
    // answer is read from that task's outbox once it exists.
    if (last.event === 'escalated') {
      // Two different events share this name and only one of them is a question
      // put to the controller. `tick` writes an escalation that NAMES the
      // controller and carries the controller's own task; `harvestEvent` writes
      // one that names the dispatcher whose intake refusal had nowhere to
      // return to, carrying that dispatcher's task — and that task's outbox
      // already exists. Harvesting it read a dispatcher's refusal with the
      // controller's vocabulary: `accept`/`reject` are not `resume`/`abandon`,
      // so nothing was stated, `harvestEvent` returned null, and the token sat
      // at `escalated` forever while every tick re-read the same file. The
      // worse half was silent: a refusal whose prose happened to contain
      // "resume" or "abandon" would have unparked or CLOSED the token on the
      // dispatcher's words, recorded as the controller's decision.
      if (last.agent_id !== graph.outer_controller_id) continue
      if (last.task_id && hasOutbox(last.task_id)) jobs.push({ item, last, role: 'outer' })
      continue
    }
    // A person, not an outbox. Nothing to harvest and nothing to wait for here —
    // `nextStep` parks it and the deadline ends it.
    if (last.event === 'questioned') continue
    if (last.event === 'audit_requested') {
      if (last.task_id && hasOutbox(last.task_id)) jobs.push({ item, last, role: 'audit' })
      continue
    }
    if (last.event !== 'delivered' || last.terminal !== 'done') continue
    const role = teamRoleOf(graph, last.agent_id)?.role
    if (role === 'dispatcher' || role === 'evaluator') jobs.push({ item, last, role })
  }
  return jobs
}

// The id a fresh `questioned` names itself with (contract §4, ledger-validate
// EVENT_SPEC.questioned). Counted off the token's OWN history rather than a
// random value, so a question's id is reproducible from the ledger alone —
// two tokens can both be on their first question and that is not a
// collision, because §4 keys every ledger by `work_item` already.
const nextQuestionId = (item) => `q-${item.work_item}-${item.custody.filter((entry) => entry.event === 'questioned').length + 1}`

function harvestEvent(repo, graph, { item, last, role }, now) {
  const { text, digest } = readOutbox(repo, last.task_id)
  const base = { at: now, work_item: item.work_item, workflow: item.workflow || null, task_id: last.task_id || null }
  // Every `questioned` this function writes carries both: the id an `answered`
  // binds to (so a stale reply cannot close a fresh question, and vice
  // versa), and the seat that asked — the only one that can read the reply.
  const asked = { question_id: nextQuestionId(item), resume_role: role }

  // The bytes the companion classified are the only bytes a verdict may be read
  // from. When they no longer hash to what `delivered` recorded, the honest move
  // is neither to trust them nor to loop on them silently: park the token on a
  // person and say exactly what disagrees. Older histories carry no digest, so
  // an absent one is not a mismatch — it is a history from before this check.
  if (last.outbox_digest && digest !== last.outbox_digest) {
    return {
      ...base,
      ...asked,
      event: 'questioned',
      agent_id: last.agent_id,
      questions: `the outbox for task ${last.task_id} changed after the worker finished.`
        + ` It was recorded as ${last.outbox_digest} and now reads ${digest ?? 'nothing on disk'}.`
        + ' Restore the recorded bytes, or withdraw the work and dispatch it again.',
      reason: 'the outbox no longer matches the bytes recorded on delivery',
    }
  }

  if (role === 'dispatcher') {
    const { verdict, stated, reason } = readVerdict(text, INTAKE_VERDICTS)
    if (verdict === 'accept') {
      // §4 requires a reason on `intake`. An accept with nothing said is
      // common and legal, so the absence is stated rather than left blank —
      // a blank field is refused by the writer and would stall the token.
      //
      // GitHub #32: `worker_hint` is optional and carries whatever the
      // dispatcher named — `nextStep`'s `want()` is what judges whether it is
      // a real, free seat; this line just records what was said. `null` when
      // nothing was said, an EVENT_SPEC-permitted extra field either way (§4:
      // only the event NAME is a closed vocabulary).
      return {
        ...base, event: 'intake', agent_id: last.agent_id, verdict: 'accept',
        reason: reason || 'no reason stated', worker_hint: readWorkerHint(text),
      }
    }
    // At the front door a refusal is ADVICE, not a veto (controller-as-team.md
    // §5.3): the gate may believe a request should not be built, and the person
    // may confirm anyway — warned, confirmed, done. So it parks on the human
    // exactly like a question does, carrying the objection as the thing to
    // answer. Anywhere else `reject` still returns the token to its sender.
    // ponytail: one branch, because "should not be built" and "not workable
    // yet" need the same machinery — a person, and a record of what they were
    // told before they decided.
    if (verdict === 'reject' && teamRoleOf(graph, last.agent_id)?.team_id === graph.controller_team) {
      return {
        ...base, ...asked, event: 'questioned', agent_id: last.agent_id,
        categories: readCategories(text),
        questions: `the gate advises against building this: ${reason || 'no reason stated'}.`
          + ' Confirm to proceed anyway, or withdraw.',
        reason: 'the intake gate objected — the decision is the requester\'s',
      }
    }
    // Not workable yet, and not refused. The token stays exactly where it is —
    // still held, still counted against WIP — and only a person can move it.
    if (verdict === 'question') {
      return {
        ...base, ...asked, event: 'questioned', agent_id: last.agent_id,
        // Which of the six it could not resolve, so the same question can be
        // asked of a month of requests rather than of one.
        categories: readCategories(text),
        questions: reason || 'the grill asked for more and stated nothing',
        reason: 'the request is not workable yet — waiting on the person who asked for it',
      }
    }
    const pulled = lastOf(item, (entry) => entry.event === 'pulled')
    if (!pulled?.from_team) {
      return {
        ...base, event: 'escalated', agent_id: last.agent_id,
        // §4.2: `escalated` must name the team still holding the token. There is
        // no sending team to return to, so the work stays with the team whose
        // dispatcher refused it — without this the board draws parked work as
        // unplaceable and frees a WIP slot nobody released.
        to_team: teamRoleOf(graph, last.agent_id)?.team_id || null,
        reason: stated
          ? `intake refused and there is no sending team to return to: ${reason || 'no reason stated'}`
          : 'the dispatcher stated no verdict and there is no sending team to return to',
      }
    }
    // Three refusals is a check; a fourth is two seats disagreeing about the
    // same work with nobody deciding, and the token would bounce between them
    // for as long as both keep their opinion. Master set the ceiling at three
    // and said the next one goes to the controller — so this seat stops
    // refusing and asks, rather than refusing more emphatically.
    const refusedBefore = item.custody
      .filter((entry) => entry.event === 'returned' && entry.refused_by === last.agent_id).length
    if (refusedBefore >= MAX_DOOR_REFUSALS) {
      return {
        ...base, event: 'escalated', agent_id: last.agent_id,
        // Same placement as the no-sending-team case above: the token is at the
        // door of the team that refused it, so that team still holds it.
        to_team: teamRoleOf(graph, last.agent_id)?.team_id || null,
        reason: `this door has refused the token ${refusedBefore} times`
          + ` and ${MAX_DOOR_REFUSALS} is the ceiling — the controller decides:`
          + ` ${stated ? (reason || 'no reason stated') : 'the dispatcher stated no verdict'}`,
      }
    }
    // No agent_id on purpose: the token is now held by the team it went back to,
    // not by the dispatcher that refused it.
    return {
      ...base, event: 'returned', to_team: pulled.from_team, refused_by: last.agent_id,
      reason: stated ? (reason || 'no reason stated') : 'the dispatcher stated no verdict',
    }
  }

  if (role === 'audit') {
    const { verdict, stated, reason } = readVerdict(text, AUDIT_VERDICTS)
    // Silence is never approval — but it cannot be a dead end either. Every
    // other gate escalates upward when it cannot answer; the controller IS the
    // top, so its only remaining reader is a person. Park it on one, with the
    // deadline the front door already runs, instead of leaving a token flagged
    // for ever while every tick re-reads the same unusable outbox.
    if (!stated) {
      return {
        ...base, ...asked, event: 'questioned', agent_id: last.agent_id,
        questions: `the audit answered with something this seat cannot use.`
          + ` It reads: ${[...AUDIT_VERDICTS].join(' or ')}. Say which, or withdraw the work.`,
        reason: 'the audit stated no verdict this seat can use',
      }
    }
    return { ...base, event: 'audited', agent_id: last.agent_id, verdict, reason: reason || 'no reason stated' }
  }

  if (role === 'outer') {
    const { verdict, stated, reason } = readVerdict(text, OUTER_VERDICTS)
    // Silence is not permission to close someone's work — and parking it back
    // where it was is what made an escalation a place tokens went to die. Ask
    // the person instead: the controller has already failed to answer once.
    if (!stated) {
      return {
        ...base, ...asked, event: 'questioned', agent_id: last.agent_id,
        questions: `the controller answered with something this seat cannot use.`
          + ` It reads: ${[...OUTER_VERDICTS].join(' or ')}. Say which, or withdraw the work.`,
        reason: 'the controller stated no verdict this seat can use',
      }
    }
    if (verdict === 'abandon') {
      return { ...base, event: 'abandoned', agent_id: last.agent_id, reason: reason || 'no reason stated' }
    }
    return {
      ...base, event: 'resumed', agent_id: last.agent_id, to_team: last.to_team || null,
      grant: RESUME_GRANT, reason: reason || 'no reason stated',
    }
  }

  const { verdict, stated, reason } = readVerdict(text, REVIEW_VERDICTS)
  // GitHub #31 stage 2: only a `produces: 'verdict'` team's evaluator was ever
  // told to write a TARGET_VERDICT line (composeBrief above), so only that
  // team's `reviewed` event may carry one. `team?.produces` is undefined for
  // any graph normalized before that field existed, matching nothing here.
  const team = graph.teams.find((entry) => entry.team_id === teamRoleOf(graph, last.agent_id)?.team_id)
  const target = team?.produces === 'verdict' ? readTargetVerdict(text) : { stated: false }
  // Attached ONLY when stated — a confirmed three-design panel found that
  // falling back to a literal 'unresolved' here (the shape readVerdict uses)
  // would hand ledger-validate a value TARGET_VERDICTS does not contain,
  // rejecting the whole `reviewed` write outright. Absence means "no reopen
  // signal", never a jammed write.
  const targetFields = target.stated
    ? { target_verdict: target.verdict, target_reason: target.reason || 'no reason stated' }
    : {}
  return {
    // `last` here is the evaluator's OWN `delivered` — this leg's own record —
    // so its dispatch_id is this review's real identity. Naming it is what lets
    // dispatch-facts.mjs tell an ordinary review apart from one a killed and
    // retried evaluator leg writes on its way out (dispatch-facts.mjs:129).
    ...base, event: 'reviewed', agent_id: last.agent_id, verdict, dispatch_id: last.dispatch_id,
    reviewed_task: lastWorkerDelivery(graph, item)?.task_id || null,
    reason: stated ? (reason || 'no reason stated') : 'the evaluator stated no verdict',
    ...targetFields,
  }
}

// A verdict the page can count. `recent_verdicts` is keyed on the reviewed
// worker, so this is written against the leg that was judged, not the leg that
// did the judging — otherwise every worker node stays at `passed 0 · rejected 0`
// no matter how much reviewing happened.
function recordVerdict(repo, graph, item, event) {
  if (event.event !== 'reviewed') return false
  const reviewed = lastWorkerDelivery(graph, item)
  if (!reviewed) return false
  const record = dispatchRecord(repo, reviewed.task_id)
  const lines = [
    'event_kind: pm-verdict',
    `task_id: ${reviewed.task_id}`,
    `worker: ${record.worker || 'claude'}`,
    `agent_id: ${reviewed.agent_id}`,
    ...(record.dispatch_id ? [`dispatch_id: ${record.dispatch_id}`] : []),
    `transport: ${record.transport || 'acp'}`,
    'terminal: done',
    `pm_verdict: ${event.verdict}`,
    ...(record.started_at ? [`started_at: ${record.started_at}`] : []),
    `verdict_by: ${event.agent_id}`,
    `reason: ${event.reason || 'none'}`,
    '',
  ].join('\n')
  // Through kms so the same redaction every other event gets applies here: the
  // reason line is agent-authored text and this store outlives the repo.
  const result = spawnSync(process.execPath, [KMS, 'append', repo, '-'], { input: lines, encoding: 'utf8' })
  return result.status === 0
}

// The vocabulary each seat is allowed to answer in. Naming it here is what
// lets a refusal say WHICH word it was looking for instead of going quiet.
const VERDICTS_FOR = {
  dispatcher: INTAKE_VERDICTS, evaluator: REVIEW_VERDICTS,
  audit: AUDIT_VERDICTS, outer: OUTER_VERDICTS,
}

export function applyHarvest(repo, graph, jobs, now = new Date().toISOString(), report = () => {}) {
  const applied = []
  for (const job of jobs) {
    const event = harvestEvent(repo, graph, job, now)
    // A controller that answered nothing changes nothing; appending a no-op
    // would only make the loop re-read the same outbox every tick.
    //
    // But it must SAY so. This returned null and continued in silence, so a
    // token whose gate answered in the wrong vocabulary — `pass` where an
    // audit takes `accept` — sat here for ever while the runner printed
    // "nothing to move" every tick, which is the same line it prints when
    // there is genuinely nothing to do. One message covering both is how a
    // wedged loop looks exactly like an idle one.
    if (!event) {
      const allowed = VERDICTS_FOR[job.role]
      report({
        work_item: job.item.work_item, role: job.role, task_id: job.last.task_id || null,
        reason: allowed
          ? `${job.role} outbox states no verdict this seat can use — expected one of: ${[...allowed].join(', ')}`
          : `${job.role} outbox could not be read as an answer`,
      })
      continue
    }
    // The accountable writer is the agent whose outbox stated the verdict this
    // event carries — the dispatcher that refused, the evaluator that judged,
    // the controller that answered. It is read from the harvested leg rather
    // than from the event, because `returned` deliberately carries no
    // `agent_id` (§4.1) and would otherwise land with no actor at all.
    if (!record(repo, event, `agent:${job.last.agent_id}`)) continue
    // A verdict that never reaches the snapshot leaves the page reading
    // `0 pass 0 reject` — indistinguishable from no reviewing at all. Say so
    // rather than letting a broken chain look like an idle one.
    if (event.event === 'reviewed' && !recordVerdict(repo, graph, job.item, event)) {
      log(`WARN   ${event.work_item}: verdict ${event.verdict} recorded in the ledger but not in kms — the page will not count it`)
    }
    applied.push(event)
  }
  return applied
}

// ── dispatch planning ────────────────────────────────────────────────────────

// A resumed token starts its attempt budget over. Counting attempts made
// before the controller looked at it would re-escalate on the very next tick,
// which turns `resume` into an expensive no-op.
const sinceResume = (item) => {
  const index = item.custody.map((entry) => entry.event).lastIndexOf('resumed')
  return index === -1 ? item.custody : item.custody.slice(index + 1)
}

// GitHub #45 part 2: a leg that died at the transport — the adapter refused to
// start, the declared model was rejected, the provider was rate-limited before
// a single prompt round-tripped — used to count exactly like a leg the worker
// actually ran and failed, because this filter consulted nothing but the
// presence of `assigned`. A seat whose provider is down could burn all of
// MAX_ATTEMPTS on legs that never began, and `attemptsBy` would still say the
// pool was spent.
//
// The fix does NOT stop writing `assigned` for a leg that never started (§4.10
// decision 1): it stays a leg — it occupies the team, it still counts against
// `legCeiling` a few lines below, and a reader can still see it happened — it
// is simply excluded from the ATTEMPT count specifically. Deferring the
// `assigned` write until the transport proves itself was the other option on
// the table and was rejected: `acp-companion.mjs` writes it before spawning
// the adapter on purpose (its own comment: "create the initial immutable-ish
// footprint before spawn"), and losing that footprint would resurrect the
// exact unbounded-respawn shape `attemptsBy`'s own history comment records
// (BLOCKER 4, 2026-08-04) for a token whose task id could never be assigned.
//
// `legOutcome` reads the fact from the LEDGER, not from absence. `lost` is
// deliberately never treated as "never started": §4 defines it as "an
// assignment whose process is gone and which recorded nothing" — that is as
// true of a leg killed after real, meaningful work as it is of one that never
// began, and the ledger alone cannot tell those two apart (a killed process
// looks exactly like a process that was never given a turn). Only
// `acp-companion.mjs`, the sole writer of `delivered`, is present at the
// moment a leg fails and can say which one happened — so only an explicit
// `work_observed: false` on `delivered` excludes a leg, never the absence of
// a line. A `delivered` with `work_observed` missing (every line written
// before this fix existed) or `true` counts exactly as before: the exclusion
// only ever narrows what counts when the evidence explicitly says so, which
// is what keeps a genuine worker failure — three quality rejections, three
// legs a review gate killed after real evidence, three legs the runner itself
// declared `lost` — spending its attempt exactly as before.
const legOutcome = (item, taskId) =>
  item.custody.find((entry) => entry.event === 'delivered' && String(entry.task_id) === String(taskId)) ?? null

const legNeverStarted = (item, taskId) => legOutcome(item, taskId)?.work_observed === false

const attemptsBy = (item, agentIds) =>
  sinceResume(item).filter((entry) => entry.event === 'assigned' && agentIds.includes(entry.agent_id)
    && !legNeverStarted(item, entry.task_id)).length

// GitHub #47 phase 2 (§3.5): how many legs on ONE seat, since the last resume,
// never reached the model — the same `work_observed: false` fact §4.10
// already defined, summed instead of excluded. Scoped to a single `agentId`,
// not a role's whole pool, because a palette is declared PER SEAT (§3.5), not
// per role — cycling through it is a fact about the seat a token is parked
// on, not about every seat sharing its role. This is what `dispatchOn` (below)
// keys a palette's next candidate, and its exhaustion, on: the runner cannot
// tell a rate limit from any other transport failure, so it keys on the one
// fact the ledger actually carries, exactly as `attemptsBy`'s own exclusion
// does — never on a terminal string, never on "any failure".
const missesBy = (item, agentId) =>
  sinceResume(item).filter((entry) => entry.event === 'assigned' && entry.agent_id === agentId
    && legNeverStarted(item, entry.task_id)).length

// What the budget was actually spent ON. `all failed` was printed whatever
// happened: three quality rejections — every leg `done`, the team's own loop
// running exactly as §1 allows — and three legs killed by a gate that was down
// produced the same sentence. That sentence is the whole of the evidence the
// outer controller has when it chooses `resume` over `abandon`, and it is
// copied verbatim into the brief, into `pm-notes/latest.md`, and into the
// `escalated` line on the ledger. The runner does not interpret it — it lists
// the terminals the legs ended on and lets the controller read them.
//
// `returned` carries no `agent_id` (§4.2 forbids it), so it can never match a
// pool and needs no guard here.
const outcomesBy = (item, agentIds) => [...new Set(sinceResume(item)
  .filter((entry) => agentIds.includes(entry.agent_id))
  .map((entry) => (entry.event === 'lost' ? 'lost'
    : entry.event === 'delivered' ? String(entry.terminal || 'unstated') : null))
  .filter(Boolean))]

// The absolute ceiling on one token's spend. It moves only when the controller
// deliberately grants more, and each grant cost a PM dispatch to obtain. The
// clamp is there because this reads a file that is meant to be appended to.
const legCeiling = (item) => MAX_LEGS + item.custody
  .filter((entry) => entry.event === 'resumed')
  .reduce((sum, entry) => sum + (Number.isInteger(entry.grant) ? Math.min(Math.max(entry.grant, 0), RESUME_GRANT) : 0), 0)

// Is the leg this token is parked on actually running?
//
// `busy` answers about an AGENT. That is the right question when the runner is
// choosing a free seat, and the wrong one when it is deciding whether a
// specific parked leg is still alive: the outer controller is busy almost
// always, so an expiry guard built on it never fires. `busyTasks` answers about
// the leg. A row with no task to name falls back to the agent — the older,
// wider answer, which errs toward waiting rather than toward withdrawing.
function legIsLive(entry, busy, busyTasks) {
  const task = entry?.task_id ? String(entry.task_id) : ''
  if (task && busyTasks instanceof Set) return busyTasks.has(task)
  return busy.has(entry?.agent_id)
}

function nextStep(graph, team, item, { busy, busyTasks, nowMs, zombieSec, answerDeadlineSec }) {
  // A superseded leg reporting in late must not decide the next step: it would
  // read `delivered` on a token a newer `assigned` already moved, and dispatch
  // against a team that is not holding it.
  const last = currentEntry(item.custody)
  const legs = item.custody.filter((entry) => entry.event === 'assigned').length
  const ceiling = legCeiling(item)
  if (legs >= ceiling) {
    return { action: 'escalate', reason: `${legs} legs on one token against a ceiling of ${ceiling} — it is bouncing, not progressing` }
  }

  // `hint` is GitHub #32's dispatcher choice, honoured for `role === 'worker'`
  // only, and only by the one caller that reads it off a fresh `intake`
  // (below). A hint is never an instruction the loop bends other rules for:
  // naming a seat that does not exist on this team's pool for this role is
  // escalated rather than silently falling back to the next free seat — a
  // fallback here would make a stated choice indistinguishable from no choice
  // at all. Naming a real seat that is currently busy WAITS on that seat
  // specifically, exactly like the no-hint "every worker busy" wait already
  // does — it is not a new way to stall forever, because the same zombie
  // detection that frees any busy seat frees this one too.
  // GitHub #47 phase 2 (§3.5): once a seat is chosen — by hint or by the free
  // pick below, exactly as today — a seat that declared a palette resolves
  // WHICH entry from its OWN ledger history rather than always the first.
  // `dispatch()`'s `declaredModel`/`declaredAdapter`/`declaredEffort` already
  // fall back to a palette's first entry (workflow-graph.mjs's `paletteFirst`)
  // for a seat that has never run, so this is only ever consulted for a
  // SECOND or later leg on that seat — "the starting point" (§3.5) already
  // covers the first one via the resolved graph itself, with no ledger read
  // needed.
  //
  // A seat with no palette returns the exact `{ action: 'dispatch', role,
  // agent_id }` shape `want` always returned — no `candidate` key at all —
  // which is what keeps a no-palette seat's dispatch byte-for-byte unchanged
  // (§3.5 AC3): the tick loop below only reaches for `plan.candidate` when it
  // is present.
  const dispatchOn = (role, agentId) => {
    const palette = declaredPalette(graph, team.team_id, agentId)
    if (!palette) return { action: 'dispatch', role, agent_id: agentId }
    const misses = missesBy(item, agentId)
    // As many misses as the palette has entries. NOT "every entry was tried
    // and none reached the model" — this comment said that until 2026-08-05
    // and the sentence six lines down already explained why it is false: a
    // genuine failure retries the SAME entry without advancing, so an entry can
    // reach the model between two misses. The runtime reason was corrected in
    // the same commit that left this paragraph behind, which is how a source
    // file ends up arguing with itself. Escalating
    // HERE, instead of dispatching entry 0 a second time, is what stops a
    // palette walk from being able to spend legs forever on candidates that
    // all refuse the same way; it is a tighter, palette-scoped bound that
    // fires long before `legCeiling` (checked above, unconditionally, on
    // every `assigned` this seat's legs still add to) ever could.
    if (misses >= palette.length) {
      return {
        action: 'escalate',
        // Says what the counter actually counted. The first wording claimed
        // "no candidate ever reaching the model", which the ledger can
        // contradict: a genuine failure retries the same entry and does not
        // advance, so an entry CAN reach the model between two misses and this
        // still fires. The release review proved that sequence — an
        // operator-facing sentence must not assert what the evidence denies.
        reason: `${agentId}'s ${palette.length}-entry palette has taken ${misses} transport failure(s)`
          + ' since the last resume, as many as it has candidates — a human must fix the declaration or'
          + ' the outage, not spend another leg guessing',
      }
    }
    // Declared order, wrapping past the end back to the first (§3.5). Entry 0
    // is "the starting point"; each `work_observed: false` since is read as
    // the fact the ordering semantics call a rate-limited or refused attempt
    // — never a genuine worker failure, which retries this same candidate
    // exactly as a no-palette seat already does, via `attemptsBy`/MAX_ATTEMPTS
    // above.
    return { action: 'dispatch', role, agent_id: agentId, candidate: palette[misses % palette.length] }
  }

  const want = (role, hint = null) => {
    const pool = role === 'worker' ? team.worker_ids
      : role === 'dispatcher' ? [team.dispatcher_id] : [team.evaluator_id]
    const attempts = attemptsBy(item, pool)
    if (attempts >= MAX_ATTEMPTS) {
      // `legs` is in the message because planEscalation's unchanged-trigger
      // brake compares trigger lines byte-for-byte. Without something that grew,
      // a budget spent a second time after a `resume` reads exactly like the
      // first, the brake answers "the same problem(s) the controller already
      // read" about a problem it has never been shown, and the token is held
      // until STALL_SEC reports it as a stall rather than as a spent budget.
      const ends = outcomesBy(item, pool)
      return {
        action: 'escalate',
        reason: `${attempts} ${role} attempts in ${team.team_id} spent over ${legs} legs on this token`
          + ` — those legs ended: ${ends.length ? ends.join(', ') : 'nothing recorded'}`,
      }
    }
    if (hint) {
      if (!pool.includes(hint)) {
        return {
          action: 'escalate',
          reason: `the dispatcher named ${hint} as the worker for this token, but ${hint} is not a`
            + ` ${role} on ${team.team_id} (${pool.join(', ') || 'no seats declared'}) — the hint cannot be honored`,
        }
      }
      if (busy.has(hint)) {
        return {
          action: 'wait', role,
          reason: `the dispatcher named ${hint} for this token and it is busy — waiting for that seat`
            + ' rather than picking a different free one',
        }
      }
      return dispatchOn(role, hint)
    }
    const free = pool.find((agentId) => !busy.has(agentId))
    if (!free) return { action: 'wait', role, reason: `every ${role} on this team is busy` }
    return dispatchOn(role, free)
  }

  if (last.event === 'escalated') {
    // Held means a question is outstanding, and a question is only outstanding
    // if somebody was actually asked. An escalation the controller wrote names
    // the controller and carries its task; one written by `harvestEvent` for an
    // intake refusal at the head of a route names the dispatcher and no
    // controller has seen it. Reporting that as `held` was a wedge with no exit:
    // `held` is not in `planEscalation`'s trigger set, so the token waited on a
    // controller nothing would ever dispatch, and the only rule that mentioned
    // it at all was the 30-minute board stall.
    if (last.agent_id === graph.outer_controller_id) {
      // BLOCKER 3 (retro-release-review round 5, 2026-08-04): the outer
      // controller's own leg is spawned with `workItem: ''` (tick, below), so
      // the companion's `appendWorkItemEvent` is a deliberate no-op for it —
      // there is no work-item ledger for the controller's OWN dispatch to
      // write a `lost` into. If that leg dies without ever writing
      // `.mailbox-out/<taskId>`, `planHarvest` can never see an outbox for
      // `last.task_id` (loop-runner.mjs `planHarvest`'s `escalated` branch),
      // so nothing downstream of THIS token ever changes again — `held` was a
      // wedge with no exit of its own, same shape as the wedge the comment
      // above already fixed one level up, one layer deeper. `questioned`
      // already answers to exactly this deadline for exactly this reason: a
      // party that has not answered by the deadline is treated as having not
      // answered, not as still thinking forever. Reusing it here closes the
      // one remaining custody state a runner can write that had no path to a
      // terminal at all.
      // r6-codex/John, 2026-08-04: the deadline alone used to decide this, and
      // `busy` was taken as a parameter and never read here. A controller that
      // is alive and working past `answerDeadlineSec` — a shorter clock than
      // the 1800s controller stall budget — had its token hard-`abandoned`
      // underneath it, and `abandoned` is a HARD terminal, so its answer could
      // no longer be harvested when it arrived. `assigned` has consulted
      // `busy` for exactly this reason since the branch below it was written;
      // this state is a leg like any other. Elapsed time is not proof that a
      // process is dead — this repo's own dispatch rule says so.
      // The LEG, not the agent (r7-codex). `busy.has(agentId)` is true for as
      // long as that agent runs anything at all, and the outer controller
      // always runs something — so asking it here suppressed the withdrawal
      // forever on work that had nothing to do with this token. A leg with no
      // task_id to ask about falls back to the agent, which is the old, wider
      // answer rather than no answer.
      if (legIsLive(last, busy, busyTasks)) return { action: 'in-flight' }
      const heldSec = (nowMs - Date.parse(last.at || '')) / 1000
      if (Number.isFinite(heldSec) && heldSec >= answerDeadlineSec) {
        return {
          action: 'expired', agent_id: last.agent_id,
          reason: `no outer-controller answer in ${Math.round(answerDeadlineSec / 60)} minute(s)`
            + ` for the token parked on ${last.agent_id} (task ${last.task_id || 'unknown'}) —`
            + ' withdrawing rather than holding it forever',
        }
      }
      return { action: 'held', reason: 'waiting on the outer controller' }
    }
    return { action: 'escalate', reason: last.reason || `escalated by ${last.agent_id} and the controller has not been asked yet` }
  }

  // `audit_requested` is handled OUTSIDE this function entirely — see the note
  // in `planDispatches` below. `audit_requested` is a RELEASING_EVENT
  // (`teamOccupancy`, dispatch-facts.mjs): a finished route audits without
  // occupying a team's WIP, so it is never a member of `held` and `nextStep`
  // is never invoked for it by `planDispatches`'s own loop. A deadline branch
  // written here would be correct-looking, dead code — the fixture that would
  // exercise it can never reach this function.

  if (last.event === 'assigned') {
    if (busy.has(last.agent_id)) return { action: 'in-flight' }
    const ageSec = (nowMs - Date.parse(last.at || '')) / 1000
    if (!Number.isFinite(ageSec) || ageSec < zombieSec) return { action: 'in-flight' }
    // No process, no delivery, and long past the point where one could still be
    // starting: the leg is gone. Recording that is not the same as inventing a
    // delivery, and without it the token sits in the team's WIP forever.
    return {
      // The dead leg's own identity, carried out with the verdict about it.
      // `last` is the `assigned` that started it and §4 requires a dispatch_id
      // there, so this is always available — it was simply never picked up, and
      // a `lost` that cannot name its leg is the one outcome line dispatch-facts
      // still has to fall back to agent_id for (dispatch-facts.mjs:129).
      action: 'lost', agent_id: last.agent_id, task_id: last.task_id || '',
      dispatch_id: last.dispatch_id || null,
      reason: `${last.agent_id} has no live process and recorded nothing in ${Math.round(ageSec)}s`,
    }
  }

  if (last.event === 'reviewed') {
    if (last.verdict === 'pass') return { action: 'ready' }
    if (last.verdict === 'reject') return want('worker')
    return { action: 'escalate', reason: `review came back ${last.verdict || 'unstated'}` }
  }

  if (last.event === 'delivered' || last.event === 'lost') {
    const role = teamRoleOf(graph, last.agent_id)?.role || 'worker'
    // A declared model the adapter will not acknowledge fails identically every
    // time: the companion refuses the dispatch before any work happens. Retrying
    // it three times cannot succeed, it just buys three identical failures, and
    // the escalation that follows carries the same unacknowledged model — so the
    // controller fails too, writes no outbox, and the token is held for good
    // while the board still reads as dispatching. Stop on the first one.
    const identityRefused = typeof last.terminal === 'string' && last.terminal.startsWith('identity-')
    if (identityRefused) {
      return {
        action: 'escalate',
        reason: `${last.agent_id} was refused for its declared model (${last.terminal}) — a rerun cannot change that, a human must fix the declaration`,
      }
    }
    const failed = last.event === 'lost' || (last.terminal && last.terminal !== 'done')
    if (failed) return want(role)
    if (role === 'worker') return want('evaluator')
    return { action: 'harvest-pending', reason: `the ${role} leg is waiting to be harvested` }
  }

  // `opened` and `pulled` mean the same thing to the state machine: work is
  // sitting with a team whose dispatcher has not judged it yet. They differ
  // only in whether a team sent it (§4.6). Leaving `opened` out here would let
  // a token enter the graph and never be dispatched — the board would draw it
  // waiting for intake forever while the runner reported nothing to do.
  if (last.event === 'pulled' || last.event === 'opened') return want('dispatcher')
  // Admission is finished when the controller's own gate accepts. Its worker
  // exists for the OTHER job — unsticking what the loop cannot decide (§9) — so
  // handing every admitted token to it would pay for a full leg to do nothing,
  // and would hold the controller's single WIP slot while doing it. `ready`
  // means the pull controller may move it on, which is what admission is for.
  // Only a person can move this one. Dispatching anything here would pay to ask
  // a question of someone who has not answered, once per tick, forever — which
  // is what a state of its own exists to prevent. `waiting` is not `wait`: a
  // WIP wait clears itself when a slot frees, and this one never does.
  if (last.event === 'questioned') {
    const waitedSec = (nowMs - Date.parse(last.at || '')) / 1000
    if (Number.isFinite(waitedSec) && waitedSec >= answerDeadlineSec) {
      return {
        action: 'expired', agent_id: last.agent_id, questions: last.questions,
        reason: `no answer in ${Math.round(answerDeadlineSec / 60)} minute(s) — the request is withdrawn and the queue is freed.`
          + ` Unanswered: ${last.questions}`,
      }
    }
    return { action: 'waiting', reason: `waiting on a person to answer: ${last.questions}` }
  }

  // The person replied, so the gate that asked runs again on what it now has.
  // H1 (retro-release-review, 2026-08-04): this used to hardcode
  // `want('dispatcher')` on the (false) assumption that only a dispatcher
  // ever asks — `harvestEvent`'s `asked.resume_role` names the seat that
  // actually asked (dispatcher, evaluator, audit, or outer; loop-runner.mjs
  // `nextQuestionId`/`harvestEvent` above), and only that seat can read the
  // reply. Read it off the `questioned` line this answers, not off `last`
  // itself — `answered` does not carry it.
  if (last.event === 'answered') {
    const askedBy = lastOf(item, (entry) => entry.event === 'questioned')
    const resumeRole = askedBy?.resume_role || null
    if (resumeRole === 'evaluator') return want('evaluator')
    if (resumeRole === 'worker') return want('worker')
    // 'dispatcher' (including unset, for legacy questions written before
    // resume_role existed) keeps the original behavior exactly. 'audit' and
    // 'outer' are the outer controller's own seats, not this team's —
    // dispatching this team's own dispatcher for a reply it never asked for
    // pays for a leg with nothing to act on, and risks two seats
    // independently reading the same reply.
    if (resumeRole === 'audit') {
      // Rescued elsewhere, not stuck: `planEscalation`'s `awaitingAudit`
      // (above) keys off `completed` being in the ledger, not off this plan
      // action — and `audit_requested` is only ever written for an item
      // `awaitingAudit` already found true (`tick`'s `escalation.audits`
      // loop), so a `completed` this item already carries guarantees a fresh
      // `audit_requested` next tick regardless of what is returned here.
      return { action: 'held', reason: 'waiting on the outer controller to read a reply asked as audit' }
    }
    if (resumeRole === 'outer') {
      // qwen r3 #3 (retro-release-review, 2026-08-04): NOT rescued the way
      // `audit` is. A pre-`completed` `escalated` (MAX_ATTEMPTS exhausted,
      // or the door-refusal ceiling in `harvestEvent`'s dispatcher branch)
      // can reach the outer controller before any leg has ever completed, so
      // `awaitingAudit` — which requires `completed` — never fires for it.
      // `held` here had no exit: it is not in `planEscalation`'s trigger set
      // (`plans.filter(action === 'escalate')`) and nothing else re-reads it,
      // wedging the token for ever — the exact class of bug the comment on
      // `escalated` above already explains. Re-escalating instead reuses that
      // same, already-proven path: the token becomes `escalation.parked`
      // again, the outer controller is asked again, and this time the
      // person's reply is on the ledger for it to read.
      return { action: 'escalate', reason: 'a person answered a question the outer controller asked — asking the outer controller to read the reply' }
    }
    return want('dispatcher')
  }
  if (last.event === 'intake' && team.team_id === graph.controller_team) return { action: 'ready' }
  // Only a FRESH `intake` carries a hint — `returned` and `resumed` are the
  // rework paths (a refused handoff coming back, a controller-granted retry)
  // and neither event has a `worker_hint` field (§4), so `last.worker_hint` is
  // simply undefined for them and this falls through to the default seat.
  if (last.event === 'intake' || last.event === 'returned' || last.event === 'resumed') {
    return want('worker', last.event === 'intake' ? (last.worker_hint || null) : null)
  }
  return { action: 'skip', reason: `nothing follows ${last.event}` }
}

// ── waking up ────────────────────────────────────────────────────────────────
//
// A tick re-derives everything from the ledger, so polling can never LOSE work
// — the cost is that three full ledger reads happen every interval whether or
// not anything moved, and a finished worker waits up to that interval to be
// noticed. Measured: `tick` calls `readWorkItems(repo)` three times, and the
// only thing that actually changes between quiet ticks is whether an outbox
// file appeared.
//
// There are exactly three ways work arrives, and two of them are a file
// changing under one of two directories: a worker writing `.mailbox-out/<task>`
// and a person running one of the three operator doors, which appends to
// `work-items/`. The third is a clock — the deadlines in §10 — and no watcher
// can see that one, which is the reason the interval STAYS.
//
// So this is additive and cannot regress: the interval still sweeps, a missed
// event costs latency rather than correctness, and a directory that cannot be
// watched (it does not exist yet, or the platform refuses) logs a note and
// leaves the sweep to do the work alone. No decision logic is touched — what
// changed is what wakes the loop, never who decides.
export function watchForWork(repo, { onChange, debounceMs = 250, watch = fsWatch, log: say = () => {} } = {}) {
  const dirs = [join(repo, '.mailbox-out'), join(repo, '.tmux-teams', 'work-items')]
  const watchers = []
  let timer = null
  // Debounced: a worker writing its outbox, the companion recording liveness
  // and a ledger append can land within milliseconds of each other, and three
  // ticks would re-derive the same board three times.
  const bump = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; onChange() }, debounceMs)
  }
  for (const dir of dirs) {
    try {
      // Created, not merely watched. `.mailbox-out` does not exist until the
      // FIRST worker writes an outbox — and this runner is what dispatches that
      // worker, so on every fresh repo the attach would fail with ENOENT and
      // never be retried, for the whole life of the process. The one event
      // source this exists for would have been dead exactly where it was needed
      // most, while the note made it look handled. Both directories belong to
      // the runner, so creating them is not a side effect, it is setup.
      mkdirSync(dir, { recursive: true })
      // `persistent: false` on purpose: the interval is what holds the process
      // open. A watcher that kept it alive on its own would turn a finished
      // one-shot run into a process that never exits.
      const watcher = watch(dir, { persistent: false }, bump)
      // An FSWatcher is an EventEmitter, and an `error` event with no listener
      // THROWS — killing the process and taking the interval backstop with it.
      // That would make a watcher failure worse than no watcher at all, which
      // is the opposite of every claim made for this function. The try/catch
      // above only covers the synchronous attach; this covers the rest of the
      // run (a watched directory deleted underneath us, EMFILE, a platform
      // watcher giving up).
      watcher.on('error', (error) => {
        say(`note   stopped watching ${dir} (${error.code || error.message}) — the interval still sweeps`)
        try { watcher.close() } catch { /* already gone */ }
      })
      watchers.push(watcher)
    } catch (error) {
      say(`note   not watching ${dir} (${error.code || error.message}) — the interval still sweeps`)
    }
  }
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    for (const watcher of watchers) { try { watcher.close() } catch { /* already gone */ } }
  }
}

export function planDispatches(graph, items, busy, {
  now = Date.now(), zombieSec = ZOMBIE_SEC, maxInFlight = MAX_IN_FLIGHT,
  answerDeadlineSec = ANSWER_DEADLINE_SEC,
  // Optional and back-compatible: a caller that knows only which AGENTS are
  // busy still gets the old, wider answer out of `legIsLive`.
  busyTasks = null,
  // `(taskId) -> parsed liveness snapshot | null`. Optional and back-compatible
  // for the same reason `busyTasks` is: a caller that supplies nothing gets
  // exactly today's answer, which is `abandoned`. Injected rather than read
  // here so this stays a pure function of its inputs, and lazy rather than a
  // prebuilt map so only the legs actually dead-and-late cost a file read.
  livenessFor = null,
} = {}) {
  const { held } = teamOccupancy(graph, items)
  const teamById = new Map(graph.teams.map((team) => [team.team_id, team]))
  const declared = new Set(graph.teams.flatMap((team) => team.agents.map((agent) => agent.agent_id)))
  // Team WIP limits bound each column. This bounds the board: without it a wide
  // graph fans out to as many concurrent agents as it has teams.
  let inFlight = [...busy].filter((agentId) => declared.has(agentId)).length
  const plans = []
  for (const [teamId, tokens] of held) {
    const team = teamById.get(teamId)
    // The WIP limit is the promise the board makes to a reader, and the runner
    // is the only thing that can keep it. Dispatching per free agent instead of
    // per unit of allowed work is how a team limited to one ran two.
    let slots = team.wip_limit
    for (const workItem of tokens) {
      const item = items.get(workItem)
      const step = nextStep(graph, team, item, { busy, busyTasks, nowMs: now, zombieSec, answerDeadlineSec })
      if (step.action === 'in-flight') { slots -= 1; continue }
      if (step.action === 'dispatch') {
        if (inFlight >= maxInFlight) {
          plans.push({
            action: 'wait', work_item: workItem, team: teamId,
            reason: `${inFlight} agents already in flight across the board (max ${maxInFlight})`,
          })
          continue
        }
        if (slots <= 0) {
          plans.push({
            action: 'wait', work_item: workItem, team: teamId,
            reason: `${team.name} is at its WIP limit (${team.wip_limit})`,
          })
          continue
        }
        slots -= 1
        inFlight += 1
        busy.add(step.agent_id)
        plans.push({
          action: 'dispatch', work_item: workItem, team: teamId, role: step.role,
          agent_id: step.agent_id, workflow: item.workflow,
          // GitHub #47 phase 2 (§3.5): the palette entry `dispatchOn` chose for
          // THIS leg, carried through so the tick loop below can dispatch it
          // instead of the seat's declared default. Absent for a no-palette
          // seat's plan (`step.candidate` is undefined there), so the spread
          // adds nothing and this object is byte-for-byte what it always was.
          ...(step.candidate ? { candidate: step.candidate } : {}),
        })
        continue
      }
      plans.push({ ...step, work_item: workItem, team: teamId })
    }
  }

  // BLOCKER 3 (retro-release-review round 5, 2026-08-04): `audit_requested`
  // is a RELEASING_EVENT (dispatch-facts.mjs `teamOccupancy`) — a finished
  // route audits without occupying a team's WIP — so it is never a member of
  // `held` and the loop above never visits it. That is correct for
  // PLACEMENT; it left the token with no reader at all once its controller
  // leg died before ever writing an outbox: `planHarvest` needs one to
  // harvest anything (loop-runner.mjs `planHarvest`'s `audit_requested`
  // branch) and nothing else revisits a token in this state. Scanned
  // directly here, because `held` will never carry it, on the same deadline
  // `questioned` and a dead-`escalated` controller leg (`nextStep`, above)
  // already answer to: a controller that has not answered by the deadline is
  // treated as having not answered, not as still thinking forever.
  for (const [workItem, item] of items) {
    const last = currentEntry(item.custody)
    if (!last || last.event !== 'audit_requested' || last.agent_id !== graph.outer_controller_id) continue
    // Same rule as the `escalated` branch in `nextStep`: a controller still
    // running THIS leg is not a controller that failed to answer.
    if (legIsLive(last, busy, busyTasks)) continue
    const heldSec = (now - Date.parse(last.at || '')) / 1000
    if (!Number.isFinite(heldSec) || heldSec < answerDeadlineSec) continue
    // GitHub #52: a leg killed by a provider's rate limit before the model ever
    // ran is not a controller that chose silence, and writing the same hard
    // terminal for both destroyed finished tokens while recording a reason that
    // was false. The ceiling is checked FIRST and unconditionally, so a leg
    // that reports `work_observed: false` on every single retry still ends.
    // The whole custody, because a token is `completed` exactly once: §5 has no
    // successor that reopens a closed route, and `ledger-validate` refuses a
    // second `completed` outright. Anyone adding a reopen event has to scope
    // this count to the newest delivery, or a reworked token is born with its
    // predecessor's retries already spent.
    const snapshot = livenessFor && last.task_id ? livenessFor(last.task_id) : null
    // Positive evidence only. A missing, unreadable or work-bearing snapshot
    // falls through to exactly today's write — this narrows when `abandoned`
    // fires, it never widens it.
    // A question needs somewhere to sit, and since D6 (2026-08-08) it always
    // has one: `validateWorkflowGraph` refuses a graph whose outer controller
    // is a worker on no team, so `teamOf(controller)` always resolves. This
    // carried an explicit guard for two commits, written when such a graph was
    // still loadable and a question would have placed nowhere — orphaned,
    // holding nobody's WIP, stopping nothing. D6 deleted the case rather than
    // the symptom, which is why the guard is gone rather than kept "to be
    // safe": there is exactly one load path and it validates.
    if (snapshot && snapshot.work_observed === false) {
      const how = `${snapshot.liveness_state || 'state unknown'}/${snapshot.termination_reason || 'reason unrecorded'}`
      plans.push({
        action: 'audit-question', work_item: workItem, agent_id: last.agent_id, task_id: last.task_id,
        question_id: nextQuestionId(item),
        // On the plan rather than hardcoded at the write, so the plan states
        // what it will record and a test can read it without driving a tick.
        // 'audit' is the only value that holds instead of dispatching a team
        // seat for a reply that seat never asked for (`nextStep`).
        resume_role: 'audit',
        questions: `The outer-controller leg that was to read this finished delivery died at the`
          + ` transport before the model ever took a turn (${how}). Nothing was retried and nothing`
          + ` was withdrawn: the delivery is intact and still waiting for a verdict.`
          + ` Say whether to read it again now, or why not.`,
        reason: `outer-controller leg for task ${last.task_id} died without the model taking a turn`
          + ` (${how}) — asking a person rather than withdrawing finished work on a false reason`,
      })
      continue
    }
    const cause = snapshot
      ? ` — leg status ${snapshot.liveness_state || 'unknown'}/${snapshot.termination_reason || 'unrecorded'}`
      : ''
    plans.push({
      action: 'expired', work_item: workItem, agent_id: last.agent_id,
      reason: `no outer-controller audit answer in ${Math.round(answerDeadlineSec / 60)} minute(s)`
        + ` for task ${last.task_id || 'unknown'}${cause}`
        + ` — withdrawing rather than holding the audit open forever`,
    })
  }
  return plans
}

// ── the outer controller ─────────────────────────────────────────────────────

const boardSummary = (graph, items, occupancy) => graph.teams.map((team) => {
  const held = occupancy.held.get(team.team_id) || []
  const detail = held.map((workItem) => {
    const item = items.get(workItem)
    const last = currentEntry(item.custody)
    // r4-codex (retro-release-review, 2026-08-04): the board used to say only
    // `(answered)` — the reader could see a person had replied and not what
    // they said, on the one page whose whole job is deciding what to do next.
    const asked = last.event === 'answered'
      ? [...item.custody].reverse().find((entry) => entry.event === 'questioned')
      : null
    const extra = [
      last.verdict,
      last.terminal && last.terminal !== 'done' ? last.terminal : '',
      asked ? `asked: ${asked.questions} — reply: ${last.reason || 'no reason stated'}` : '',
    ].filter(Boolean).join(' ')
    return `${workItem} (${last.event}${extra ? ` ${extra}` : ''})`
  })
  return `- **${team.name}** — WIP ${held.length}/${team.wip_limit}: ${detail.length ? detail.join(', ') : 'nothing held'}`
}).join('\n')

// Anomaly-triggered, never on a heartbeat: a timer that dispatches a full agent
// every interval bills for looking at a board that has not changed.
// The one place a withdrawal's trigger line is written. `tick` has to subtract
// exactly these lines from the identity it stores when a receipt write fails,
// and a second copy of the sentence would drift into a subtraction that removes
// nothing — which is precisely the failure it is there to prevent.
const withdrawalTriggerId = (workItem) =>
  `- \`${workItem}\` was withdrawn at the door: nobody answered the intake questions in time`

export function planEscalation(repo, graph, items, plans, occupancy, { now = Date.now(), cooldownSec = PM_COOLDOWN_SEC, stallSec = STALL_SEC } = {}) {
  // `text` is what the controller READS; `id` is what the unchanged-trigger
  // brake COMPARES. They are the same string for every trigger but one. A
  // trigger may render elapsed time — "for 47 minutes" is what an agent can act
  // on — but elapsed time is measured against `now`, so it is a different
  // string on every tick, and a brake comparing it can never match twice. An
  // identity must therefore be a function of what is RECORDED and of nothing
  // else. See the stall below, which is where this went wrong.
  const trigger = (text, id = text) => ({ id, text })
  // r4-codex (retro-release-review, 2026-08-04): a person answering a
  // pre-`completed` question asked as `resume_role: 'outer'` re-escalates the
  // token with a FIXED reason string ("a person answered a question the outer
  // controller asked ..."), identical on every occurrence for the same
  // work_item. A second questioned(outer) -> answered cycle on the same token
  // therefore rendered the exact identity already stored in `pm-notes/latest.md`
  // and the brake below read it as `unchanged` — a reply that genuinely moved
  // the ledger forward, permanently unread. `plan.reason` is text an agent
  // reads; it does not have to be, and here must not be, a function only of
  // the token's identity — the anchor below is the last thing RECORDED for
  // this item, which is different every time a new event (like this very
  // `answered`) lands, and identical when nothing has.
  const triggers = plans.filter((plan) => plan.action === 'escalate')
    .map((plan) => {
      const recorded = items.get(plan.work_item)?.custody.slice(-1)[0]?.at
      const text = `- \`${plan.work_item}\` in ${plan.team}: ${plan.reason}`
      return trigger(text, recorded ? `${text}\n  (recorded ${recorded})` : text)
    })
  for (const orphan of occupancy.orphans) {
    triggers.push(trigger(`- \`${orphan.work_item}\` cannot be placed: last actor \`${orphan.agent_id || 'none'}\`, workflow \`${orphan.workflow || 'none'}\``))
  }

  // Master asked for a controller that checks every team and every workflow is
  // still working correctly. Built as an exception handler alone it never ran
  // once: a whole route completed, recovered from four failed legs on the way,
  // and nobody looked at the delivery or heard about the failures. These are
  // events, not a timer — the objection to a heartbeat was that it bills for
  // reading a board that has not changed, and none of these fire unless it has.
  const audits = [...items.values()].filter(awaitingAudit)
  for (const item of audits) {
    const failed = failedLegs(item)
    // Same wedge as above, one seat over: `awaitingAudit` re-surfaces an item
    // whose state is `answered` (a post-`completed` audit question just got a
    // reply — §5), and its rendered text depends only on work_item/workflow/
    // failed-leg-count, none of which changes across a completed->answered
    // cycle. Without the anchor a second audit-question reply on the same
    // item collided with the identity already stored from the first
    // `completed` trigger and was suppressed forever.
    const recorded = item.custody.slice(-1)[0]?.at
    const text = `- \`${item.work_item}\` finished ${item.workflow || 'its route'} — nobody has read the delivery as a whole`
      + (failed ? ` (it recovered from ${failed} failed leg(s) on the way)` : '')
    triggers.push(trigger(text, recorded ? `${text}\n  (recorded ${recorded})` : text))
  }

  // A request the clock withdrew. Master's rule for reading the intake
  // statistics: every time one is thrown away, not on a schedule — which keeps
  // §9's promise that this role is event-triggered and never on a timer. The
  // unchanged-trigger brake then stops it being re-read while nothing new has
  // been thrown away.
  // GitHub #50: these were never retired. The audit and the parked escalation
  // each record a mark on the token when the controller is dispatched, which
  // changes its last event and drops it out of the trigger set. A withdrawal
  // CANNOT do that: `abandoned` is a hard terminal (§5) and nothing may follow
  // it, ever. So the trigger stood for good — `pm-notes/latest.md` listed dead
  // tokens as standing problems, `pm holding:` printed every 60s indefinitely,
  // and every later dispatch re-read them. Observed on one board nine hours and
  // twenty-seven repetitions after the fact.
  //
  // The mark therefore goes where the durable artifact already is: the notice
  // written for the requester when the clock withdrew their work. A withdrawal
  // is news once; the notice records that it has been delivered.
  const withdrawals = [...items.values()].filter((item) => {
    const last = item.custody[item.custody.length - 1]
    if (last?.event !== 'abandoned' || String(last.actor || '') !== RUNNER_ACTOR) return false
    return !noticeWasRead(repo, item.work_item)
  })
  for (const item of withdrawals) {
    triggers.push(trigger(withdrawalTriggerId(item.work_item)))
  }

  const held = [...occupancy.held.values()].flat()
  for (const workItem of held) {
    const item = items.get(workItem)
    const failed = failedLegs(item)
    if (failed >= RETRY_NOISE) {
      triggers.push(trigger(`- \`${workItem}\` has survived ${failed} failed legs and is still going — retries are hiding them`))
    }
  }

  // Nothing moving while work is held is a stall, not calm.
  if (held.length) {
    const newest = held.reduce((latest, workItem) => {
      const at = Date.parse(items.get(workItem).custody[items.get(workItem).custody.length - 1]?.at || '')
      return Number.isFinite(at) && at > latest ? at : latest
    }, 0)
    const idleSec = newest ? Math.round((now - newest) / 1000) : 0
    if (newest && idleSec > stallSec) {
      triggers.push(trigger(
        `- the board has held ${held.length} token(s) with nothing recorded for ${Math.round(idleSec / 60)} minutes`,
        // The identity of a stall is the last thing that WAS recorded, not how
        // long ago it was. The minute count above increments on every tick
        // while a board sits still, so compared as text it was never twice the
        // same: the brake could never match and the controller was
        // re-dispatched every PM_COOLDOWN_SEC for as long as the board stayed
        // still (issue #22). Anchored here, the same stall is the same problem,
        // and a stall that returns after something is recorded is a new one.
        `- the board has held ${held.length} token(s) with nothing recorded since ${new Date(newest).toISOString()}`,
      ))
    }
  }

  if (!triggers.length) return null
  const lines = triggers.map((entry) => entry.text)
  const identity = triggers.map((entry) => entry.id).join('\n')

  const notesDir = join(repo, '.tmux-teams', 'pm-notes')
  const latest = join(notesDir, 'latest.md')
  try {
    const text = readFileSync(latest, 'utf8')
    // Line 1 is the ISO stamp this function's own writer puts there. Reading
    // the filesystem's mtime instead mixed two clocks in one subtraction: the
    // caller's `now` and whatever the filesystem believed. When they disagree
    // by more than the cooldown in the wrong direction the difference goes
    // negative, every comparison says "ran moments ago", and the outer
    // controller is never dispatched again — a permanent silence produced by a
    // clock, not by a board with nothing on it. Falling back to mtime keeps
    // files written before the stamp existed readable.
    const stamped = Date.parse(text.split('\n', 1)[0] ?? '')
    const newest = Number.isFinite(stamped) ? stamped : statSync(latest).mtimeMs
    if ((now - newest) / 1000 < cooldownSec) {
      return { action: 'cooldown', reason: `outer controller ran ${Math.round((now - newest) / 1000)}s ago`, triggers: lines }
    }
    // A time cooldown alone is no brake on a permanent condition. A token the
    // loop can never place stays in `triggers` on every tick, so an unchanged
    // trigger set means the controller would be dispatched again to read the
    // same board — every cooldown, forever.
    const seen = text.split('\n').slice(1).filter(Boolean).join('\n')
    if (seen === identity) {
      return { action: 'unchanged', reason: `the same ${triggers.length} problem(s) the controller already read`, triggers: lines }
    }
  } catch { /* never run before */ }

  // ONE question per dispatch, and the audit goes first.
  //
  // The controller's outbox ends in a single VERDICT line — that is what
  // `readVerdict` reads and what the brief asks for. A leg carrying two
  // questions therefore cannot answer both: `accept`/`concern` for an audit and
  // `resume`/`abandon` for a parked token are disjoint vocabularies, so
  // whichever word it says, the other question reads as nothing stated. That
  // token then parks with no event recorded, and the unchanged-trigger brake
  // stops the loop from ever asking again — a permanent silence produced by one
  // outbox being asked two things.
  //
  // Every trigger still goes into the brief: the controller decides with the
  // whole board in view and answers about one token at a time. Answering one is
  // what changes the trigger set — the token's own last event moves — so the
  // rest are asked on later ticks instead of being brake-held forever.
  const auditSubject = audits[0] || null
  const parkedSubject = auditSubject ? null : plans.find((plan) => plan.action === 'escalate') || null
  // r4-codex (retro-release-review, 2026-08-04): "the PM brief ... omits the
  // question and answer" — the controller was dispatched to READ a reply with
  // no reply on the page. `awaitingAudit` re-surfaces this item once its state
  // is `answered`, and `nextStep`'s outer branch re-escalates it for the same
  // reason; either way the exchange lives on the item's own custody.
  const exchangeText = (item) => {
    const last = item && currentEntry(item.custody)
    if (!last || last.event !== 'answered') return ''
    const askedBy = lastOf(item, (entry) => entry.event === 'questioned')
    return `\n\nA person already answered a question about it.`
      + ` Asked: ${askedBy?.questions || 'no question text recorded'}`
      + ` — replied: ${last.reason || 'no reason stated'}.`
  }
  // The brief already said "the trigger above tells you which one this is". With
  // both kinds of trigger listed that was not true, and an agent that guessed
  // wrong answered in the wrong vocabulary — indistinguishable from silence.
  const ask = auditSubject
    ? `**The token to answer for is \`${auditSubject.work_item}\`.** It finished its route: this is the audit`
      + ' job below, so end with `accept` or `concern`.' + exchangeText(auditSubject)
    : parkedSubject
      ? `**The token to answer for is \`${parkedSubject.work_item}\`.** It is parked: this is the unstick job`
        + ' below, so end with `resume` or `abandon`.' + exchangeText(items.get(parkedSubject.work_item))
      : '**No single token is waiting on your verdict this time.** Report what you see on the board;'
        + ' the verdict line will not move anything.'

  return {
    action: 'escalate',
    agent_id: graph.outer_controller_id,
    triggers: lines,
    // What the runner writes to `pm-notes/latest.md` and what the brake reads
    // back off it next tick. Never the brief's own text — see `trigger` above.
    identity,
    audits: auditSubject ? [auditSubject.work_item] : [],
    parked: parkedSubject ? parkedSubject.work_item : null,
    // Carried so the dispatch site can mark them delivered — the one thing that
    // retires this trigger, since the ledger cannot.
    withdrawals: withdrawals.map((item) => item.work_item),
    brief: roleBrief(repo, 'pm', null, {
      projectId: graph.project_id || 'unnamed',
      trigger: `${ask}\n\n${lines.join('\n')}`,
      // Read by the role that owns the door, on the event that proves the door
      // turned somebody away. It is a RECOMMENDATION surface, not a control
      // one: §2 says a declaration is assigned by a human and never observed,
      // so the controller says what the brief or the deadline should become and
      // a person changes it.
      board: `${boardSummary(graph, items, occupancy)}\n\n${
        withdrawals.length ? intakeStatsBrief(intakeStats(repo), ANSWER_DEADLINE_SEC) : ''}`,
    }),
  }
}

// ── spawning ─────────────────────────────────────────────────────────────────

// `acp-companion` prefers an ambient ACP_CMD over the adapter its lane names,
// so any ACP_CMD left in a shell — or set globally by a test in this very
// process — silently replaced the adapter every seat in the loop ran on, and
// nothing in the receipt could say which one had answered. Production dispatch
// therefore refuses to pass it on. A test that needs the seam names it
// deliberately through TMUX_TEAMS_ACP_CMD, which is an explicit dependency
// rather than whatever the environment happened to be carrying.
export function childEnv(source = process.env) {
  const { ACP_CMD: _ambient, TMUX_TEAMS_ACP_CMD: injected, ...rest } = source
  return injected ? { ...rest, ACP_CMD: injected } : rest
}

// codex BLOCKER 4 (retro-release-review round 5, 2026-08-04): a work item the
// sanctioned ledger writer accepts (`ledger-writer.mjs`'s own ID_RE allows up
// to 128 chars, plus `.` and `:`) could make the OLD naive concatenation
// overflow acp-companion's 64-char task-id cap (`acp-companion.mjs:44-49`).
// The child then exits on its own ID_RE check BEFORE writing `assigned` —
// and the retry budget below (`attemptsBy`) counts only `assigned` lines, so
// the runner respawned the same doomed id forever, paying for a new process
// every tick. Separately, the old char-substitution sanitize was not
// injective: '.' and ':' both became '-', so two DIFFERENT work items
// (`a.b`, `a:b`) dispatched in the same millisecond produced the identical
// task id and would have shared every task-keyed file (log, dispatch
// record, liveness, outbox).
//
// The fix gives every input a fixed-length, content-derived suffix instead
// of trusting the timestamp to disambiguate: a 16-hex-char slice of a
// sha256 digest over the RAW (pre-sanitize) workItem/team/role/timestamp
// tuple, joined by plain spaces — safe as a delimiter because the ledger
// writer's own ID_RE (`[A-Za-z0-9_][A-Za-z0-9_.:-]*`) forbids a space in
// workItem or team, and `role` is always one of this file's own literal
// role names, so no legal input can forge a delimiter collision. The
// human-readable prefix is truncated to 47 chars so
// `47 + 1 (dash) + 16 (digest) = 64` can never exceed acp-companion's cap,
// no matter how long a sanctioned work item is. Both
// workItem and team are guaranteed (by the SAME ledger-writer ID_RE) to
// start with an alnum/`_` character, and the literal fallbacks ('board',
// 'loop') and every `role` this file passes in do too, so the prefix always
// starts with a character acp-companion's ID_RE accepts.
//
// What this is NOT (r6-codex, round 6): collision-free. 16 hex is 64 bits, and
// the tuple's only varying field between two dispatches of the same
// work item, team and role is the millisecond — so the identical tuple in the
// identical millisecond still yields the identical id. What it removes is the
// SANITIZER collision above, where two genuinely different work items mapped
// to one string; the digest is taken over the raw tuple, before truncation and
// before sanitizing, so those two now differ. Bounded collision-resistance,
// not uniqueness.
export function buildTaskId(workItem, team, role, nowMs = Date.now()) {
  const w = workItem || 'board'
  const t = team || 'loop'
  const digest = createHash('sha256').update(`${w} ${t} ${role} ${nowMs}`).digest('hex').slice(0, 16)
  const prefix = `${w}-${t}-${role}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 47)
  return `${prefix}-${digest}`
}

function dispatch(repo, { workItem, team, role, agentId, workflow, model, adapter = DEFAULT_ADAPTER, effort }, briefPath, stallSec, { spawnFn = spawn } = {}) {
  const taskId = buildTaskId(workItem, team, role)
  // Keep every dispatch log. Discarding the adapter stderr is how a runner ends
  // up unable to explain its own failures — which is exactly what happened the
  // first time this ran.
  const logDir = join(repo, '.tmux-teams', 'runner-logs')
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(join(logDir, `${taskId}.log`), 'a', 0o600)
  // `spawnFn` is the narrower seam (below `spawnLeg`): it replaces only the OS
  // process creation, so a test can exercise this function's REAL env-building
  // — including the effortEnv/modelEnv spread the #32 regression lived in —
  // without forking a real ACP process. Production supplies no spawnFn, so it
  // has no branch: `spawn` from node:child_process runs exactly as before.
  const child = spawnFn(process.execPath, [COMPANION, adapter, repo, taskId, briefPath, String(stallSec)], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...childEnv(),
      ACP_AGENT_ID: agentId,
      // DECISION 3: the dispatch declares the model this seat was assigned, so
      // the page can finally print a real name instead of "default — none
      // pinned". `modelEnv` is what keeps the sentinel from becoming a request
      // the adapter would refuse — see its comment for why that matters.
      ...modelEnv(model),
      ...effortEnv(effort),
      ...(workflow ? { TMUX_TEAMS_WORKFLOW: workflow } : {}),
      ...(workItem ? { TMUX_TEAMS_WORK_ITEM: workItem } : {}),
      ECC_GATEGUARD: 'off',
    },
  })
  child.unref()
  return taskId
}

// A message for the person, not for the loop. Three things, because "timed out"
// alone satisfies the rule and teaches them nothing: what happened, WHICH
// questions went unanswered so they know what to prepare, and that the door is
// open again whenever they are.
export const NOTICE_DIR = 'notices'

// A withdrawal needs a read receipt the token's ledger cannot carry —
// `abandoned` is a hard terminal (§5). It is written when the controller has
// actually been dispatched with the withdrawal in its brief, not when the
// notice is written, so a withdrawal nobody was told about stays on the board
// (GitHub #50).
//
// A SIDECAR, not a marker inside the notice. The first version appended an HTML
// comment to `notices/<token>.md` and searched for that substring — and the
// notice renders the intake QUESTIONS verbatim, which is text a worker wrote.
// A question quoting that comment (an HTML snippet, a doc about this very
// mechanism) retired its own withdrawal before any controller saw it: the exact
// bug being fixed, reintroduced through the fix. A release reviewer measured it
// — `withdrawals: ["tok"]` before the text, `null` after.
//
// What this does and does not promise, because the first version of this
// comment claimed more than a filesystem can give. It said "nothing a worker or
// a person types can reach it". A worker runs IN the target repository with
// write access to it, so a worker that decides to create this file can. A
// release reviewer said so plainly and was right.
//
// The real property is narrower and is the one that was broken: the receipt is
// no longer a substring of a file whose CONTENTS are worker-authored, so a
// worker quoting the mechanism — in a question, in documentation about this
// very paragraph — cannot retire a withdrawal by ACCIDENT. Nothing here defends
// against a deliberate one, and nothing else in `.tmux-teams/` does either: the
// ledger, the notices and the outboxes are all writable by the same process.
// The trust boundary in this system is the process we launched, not the
// directory it works in. Claiming otherwise in a comment does not create it,
// and would leave the next reader believing in a guard that is not there.
//
// The shape checks below stop the accidents a bare `existsSync` did not: a
// directory or a symlink at the path, a truncated write, a stray `touch`. They
// are hygiene, not a boundary.
const RECEIPTS_DIR = 'notice-receipts'

const receiptPath = (repo, workItem) => join(repo, '.tmux-teams', RECEIPTS_DIR, `${workItem}.json`)

function noticeWasRead(repo, workItem) {
  const path = receiptPath(repo, workItem)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return false
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    return receipt?.work_item === workItem && receipt?.by === RUNNER_ACTOR
  } catch { return false }
}

// O_NOFOLLOW, because `noticeWasRead` above refuses a symlink with `lstatSync`
// and this used to follow one. The write succeeded through the link, the mark
// returned true, the receipt was never readable, and the unchanged-trigger
// brake suppressed that withdrawal FOR EVER — the exact permanent-loss path
// AC124 says is fixed. A writer and a reader disagreeing about what counts as
// a file is the whole bug. An `lstat` before the write would leave the race
// open between the two calls; the kernel refusing the open does not.
function markNoticeRead(repo, workItem) {
  let fd = null
  try {
    mkdirSync(join(repo, '.tmux-teams', RECEIPTS_DIR), { recursive: true })
    fd = openSync(receiptPath(repo, workItem),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd,
      `${JSON.stringify({ work_item: workItem, read_at: new Date().toISOString(), by: RUNNER_ACTOR })}\n`)
    return true
  } catch { return false } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* the receipt is already written or already failed */ } }
  }
}
function writeNotice(repo, workItem, questions, reason) {
  try {
    const dir = join(repo, '.tmux-teams', NOTICE_DIR)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${workItem}.md`), [
      `# Your request \`${workItem}\` was withdrawn`,
      '',
      reason,
      '',
      '## What went unanswered',
      '',
      questions || 'the intake gate recorded no questions, which is itself a defect worth reporting',
      '',
      '## Sending it again',
      '',
      'Nothing here is a rejection. The queue is free again — send the request whenever you have',
      'those answers ready, and it will go straight back through the same gate.',
      '',
    ].join('\n'), { mode: 0o600 })
  } catch (error) {
    // Failing to write the notice must not stop the token being closed: the
    // ledger line is what frees the queue, and a queue held open by a failed
    // file write would be a worse outcome than an unsent message.
    log(`WARN   could not write the withdrawal notice for ${workItem}: ${error.message}`)
  }
}

const heldCount = (occupancy) => [...occupancy.held.values()].flat().length

// `spawnLeg` is the outer seam in this function, and it exists for one reason:
// every decision below — harvest, pull, WIP, escalation, and the order they run
// in — is reachable in a test only if starting an agent can be something other
// than forking a real ACP process. A replay that re-composes the planners by
// hand tests the composer's memory of this order rather than this order itself.
// The default is the real `dispatch`, so production has no branch.
//
// `spawnFn`, threaded through to `dispatch` below, is the inner seam: it lets
// a test keep the default `spawnLeg = dispatch` — so `dispatch`'s own env
// construction genuinely runs — while still replacing only the OS-level
// process creation inside it. A test that stubs `spawnLeg` instead never runs
// `dispatch` at all, which is how the #32 pattern (effort declared, validated,
// dropped at dispatch) shipped a regression test that could not have caught it.
export function tick(repoArg, {
  apply = true, stallSec = 1800, scratchDir, tickSec = DEFAULT_TICK_SEC,
  spawnLeg = dispatch, spawnFn, answerDeadlineSec = ANSWER_DEADLINE_SEC,
} = {}) {
  // The ACP adapter rejects a relative cwd outright, and the runner is the last
  // place a relative path can still be sitting — resolve once, here.
  const repo = resolve(repoArg)
  // Stamped on every exit below, healthy or not. A dry run deliberately does
  // NOT stamp: it is a simulation, and letting one overwrite a live runner's
  // heartbeat in the same repo would report a loop that is not running.
  const beat = (state) => { if (apply) writeHeartbeat(repo, { tickSec, ...state }) }

  const graph = readWorkflowGraph(repo)
  if (!graph.ok) {
    const reason = `team graph invalid (${graph.source}): ${graph.reason}`
    // `held` is genuinely unmeasurable without a graph — occupancy is a fact
    // about declared teams, and there are none. A zero here would read as a
    // board that is empty rather than one that was never counted.
    beat({ dispatching: false, reason, started: 0, held: null })
    return { ok: false, reason }
  }
  // GitHub #48. A repository that has not declared its own loop does not get to
  // run one. `readWorkflowGraph` answers with the bundled template when no
  // declaration exists — deliberately, so the pages can still render something
  // and explain what is missing — and it says so in `source`. Nothing read that
  // field, so the runner dispatched agents against four teams the owner never
  // chose, every seat asking for the placeholder model
  // `inherit-account-default`, and the failures arrived one at a time at the
  // adapter rather than once, here, in the operator's face.
  //
  // `workflow-graph.mjs`'s own comment had already named this the dangerous
  // shape — "a reader cannot tell those two states apart" — and
  // `graph-setup/SKILL.md` promised for its whole life that it was refused.
  // Nothing enforced the promise until now.
  if (graph.source === 'default') {
    const reason = 'no team graph declared — .tmux-teams/graph.json is missing, and the bundled template is a shape to read, not a loop to run: declare one with the graph-setup skill'
    beat({ dispatching: false, reason, started: 0, held: null })
    return { ok: false, reason }
  }
  const briefDir = scratchDir || join(repo, '.tmux-teams', 'runner-briefs')
  // C1: every token this tick passes over, with the reason it had at the
  // time. Written once, atomically, at the end of a tick that actually
  // reaches this point — see `writeDecisions` and contract §11.3.
  const decisions = []

  // Harvest first. A judging leg that has finished but not been read leaves the
  // pull controller looking at a stale event — and pulling before the review
  // lands is exactly how the evaluator became decorative.
  const harvested = []
  const jobs = planHarvest(graph.value, readWorkItems(repo).items,
    (taskId) => existsSync(join(repo, '.mailbox-out', taskId)))
  const refused = []
  if (jobs.length && apply) harvested.push(...applyHarvest(repo, graph.value, jobs, undefined, (skip) => refused.push(skip)))
  for (const skip of refused) {
    log(`WEDGED ${skip.work_item}: ${skip.reason}`)
  }
  for (const event of harvested) {
    log(`${event.event.padEnd(6)} ${event.work_item}: ${event.verdict || event.to_team || ''} — ${event.reason || ''}`)
  }

  const before = readWorkItems(repo)
  const pulls = planPulls(graph.value, before.items)
  // Through this loop's own voice, not stderr. Everything else the tick decides
  // is said on stdout with a `[loop]` prefix, and a refusal reported on a
  // different stream is one an operator reading the loop's log never sees.
  if (apply && pulls.some((entry) => entry.event)) {
    applyPulls(repo, pulls, (decision, result) =>
      log(`REFUSED ${decision.work_item}: ${result.code} — ${result.detail}`))
  }
  // Say every decision out loud. A runner that logs only the happy path looks
  // identical to one that has silently given up — which is what this one did
  // for 65 ticks before anyone noticed.
  for (const entry of pulls) {
    // The write was refused, and the REFUSED line above already said so. Saying
    // `pull` here as well would be this runner reporting a handoff the ledger
    // never took — §4.2 — and the planner is right to plan it again next tick.
    if (entry.write_result && !entry.write_result.ok) continue
    if (entry.action === 'blocked') log(`BLOCK  ${entry.work_item}: ${entry.reason}`)
    else if (entry.action === 'pull') log(`pull   ${entry.work_item}: ${entry.from_team} -> ${entry.to_team}`)
    else if (entry.action === 'complete') log(`done   ${entry.work_item}: finished ${entry.workflow}`)
    else if (entry.action === 'failed') log(`FAILED ${entry.work_item}: ${entry.reason}`)
    // A token the pull controller refuses to move because its own history
    // cannot be believed. It arrived here as a word this loop had never heard
    // and came out as `skip` — the mildest line the runner has, for the one
    // state that needs a human. Same family gap the board had until today, one
    // reader further down: `planPulls` grew the word and this consumer never
    // did. Every problem is printed, because repairing one line at a time is
    // whack-a-mole against a file nobody is allowed to rewrite.
    else if (entry.action === 'invalid') {
      log(`INVALID ${entry.work_item}: ${entry.reason}`)
      for (const problem of entry.problems ?? []) {
        log(`        line ${problem.line}  ${problem.code}  ${problem.detail}`)
      }
    } else log(`skip   ${entry.work_item}: ${entry.reason ?? entry.action}`)
  }

  // Re-read: the pulls just written are what makes a token dispatchable now.
  const { items } = readWorkItems(repo)
  const pulse = busyAgents(repo)
  const busy = pulse.busy
  // Frozen evidence is worse than none: it either stalls the loop forever on an
  // agent that already exited, or — once the zombie window passes — declares a
  // still-running agent lost and pays to run it again.
  if (pulse.stale) {
    const reason = `pulse.json is ${pulse.ageSec === null ? 'undated' : `${pulse.ageSec}s old`} — refusing to dispatch. Is \`pulse.mjs watch\` running?`
    log(`STALE  ${reason}`)
    // The tick that refuses is the one a reader most needs to see. The graph
    // and the ledgers are both readable here, so `held` is a real measurement
    // even though nothing was started.
    beat({ dispatching: false, reason, started: 0, held: heldCount(teamOccupancy(graph.value, items)) })
    return { ok: true, harvested, pulls, plans: [], started: [], stale: true }
  }
  if (pulse.missing) log('note   no pulse.json yet — dispatching without liveness evidence')
  const plans = planDispatches(graph.value, items, busy, {
    answerDeadlineSec, busyTasks: pulse.busyTasks,
    // The companion names this file after the task id and nothing else
    // (`acp-companion.mjs`'s `livenessPath`), so a dead leg's own record is
    // addressable from the custody entry that dispatched it.
    livenessFor: (taskId) => readJson(join(repo, '.tmux-teams', 'liveness', `${taskId}.json`)),
  })
  const started = []
  for (const plan of plans) {
    if (plan.action === 'lost') {
      log(`LOST   ${plan.work_item}: ${plan.reason}`)
      if (apply) {
        // The runner decided this one on its own: no agent stated it, so the
        // runner signs it.
        record(repo, {
          at: new Date().toISOString(), event: 'lost', work_item: plan.work_item,
          workflow: items.get(plan.work_item).workflow || null,
          agent_id: plan.agent_id, task_id: plan.task_id || null,
          dispatch_id: plan.dispatch_id || null, reason: plan.reason,
        }) || closeUnbelievableHistory(repo, plan, items)
      }
      continue
    }
    // The transport took the leg before the model ever ran. Same "runner
    // decided, so the runner signs it" pattern as `lost` above — and the same
    // shape too: non-terminal, the token is owed another controller.
    // The audit leg died at the transport, so nobody has read a delivery that is
    // sitting there finished. This asked three more times and then withdrew the
    // work anyway; it now asks a PERSON and holds. `resume_role: 'audit'` is what
    // makes holding safe rather than a wedge: `nextStep` returns `held` for it,
    // and the re-arm comes from `awaitingAudit` the moment an `answered` lands —
    // no new dispatch path, and the notice is written for the same reason
    // `expired` writes one, since a conversation that ends in silence is
    // unreadable from the other side.
    if (plan.action === 'audit-question') {
      log(`PERSON ${plan.work_item}: ${plan.reason}`)
      if (apply) {
        writeNotice(repo, plan.work_item, plan.questions, plan.reason)
        record(repo, {
          at: new Date().toISOString(), event: 'questioned', work_item: plan.work_item,
          workflow: items.get(plan.work_item).workflow || null,
          agent_id: plan.agent_id, task_id: plan.task_id || null,
          questions: plan.questions, reason: plan.reason,
          question_id: plan.question_id, resume_role: plan.resume_role,
        })
      }
      continue
    }
    // The clock withdrew a request nobody answered. The RUNNER writes this one:
    // §9 names the controller as the only mechanised writer of `abandoned`, and
    // this is the second — recorded rather than hidden, because `actor` already
    // tells the two apart and a reader looking for how a token ended wants one
    // word to search for, not two.
    if (plan.action === 'expired') {
      log(`EXPIRED ${plan.work_item}: ${plan.reason}`)
      if (apply) {
        // The controller always says the last word (§6.3). A conversation that
        // ends in silence is unreadable from the other side: the person cannot
        // tell whether their request lapsed or the gate is still thinking. The
        // ledger line is the durable half; this is the half addressed AT them,
        // for the operator to relay into the chat they are actually reading.
        writeNotice(repo, plan.work_item, plan.questions, plan.reason)
        record(repo, {
          at: new Date().toISOString(), event: 'abandoned', work_item: plan.work_item,
          workflow: items.get(plan.work_item).workflow || null,
          agent_id: plan.agent_id, reason: plan.reason,
        })
      }
      continue
    }
    if (plan.action !== 'dispatch') {
      const level = plan.action === 'escalate' ? 'STUCK '
        : plan.action === 'wait' ? 'wait  '
          : plan.action === 'waiting' ? 'PERSON'
            : 'skip  '
      if (plan.reason) {
        log(`${level} ${plan.work_item}: ${plan.reason}`)
        // `plan.action` is already one of `nextStep`'s own small set
        // ('escalate' | 'wait' | 'waiting' | 'skip') — reused verbatim, not
        // re-derived from the log line's own wording.
        decisions.push({ work_item: plan.work_item, action: plan.action, reason: plan.reason })
      }
      continue
    }
    // DECISION 4, read half. Occupancy, the pull decision, the board and the
    // audit are all derived from this one file, so dispatching a fresh leg onto
    // a history that cannot be believed writes good evidence on top of bad and
    // buries the break instead of surfacing it. Refuse, and name the defect —
    // a silent skip here would look exactly like a team with nothing to do.
    //
    // Tolerant: B5 (2026-08-04) found this was the third place, after the
    // writer and the pull controller, that judged an on-disk ledger by raw
    // `ok` — so a token whose only problems were legacy-tolerated ones could
    // be appended to and pulled forward but never dispatched onto again.
    const ledger = validateLedgerFileTolerant(ledgerPath(repo, plan.work_item))
    if (!ledger.ok) {
      log(`LEDGER ${plan.work_item}: ${ledger.blocking.length} problem(s) — refusing to dispatch onto a history that cannot be believed`)
      for (const problem of ledger.blocking.slice(0, 5)) {
        log(`       line ${problem.line}  ${problem.code}  ${problem.detail}`)
      }
      // `ledger.blocking` is the exact array `validateLedgerFileTolerant`
      // already computed — not sliced to 5 here, unlike the printed lines
      // above, because this is the object the tick holds, not a rendering of it.
      decisions.push({
        work_item: plan.work_item, action: 'unreliable-history',
        reason: `${ledger.blocking.length} problem(s) — refusing to dispatch onto a history that cannot be believed`,
        problems: ledger.blocking,
      })
      continue
    }
    const item = items.get(plan.work_item)
    const team = graph.value.teams.find((entry) => entry.team_id === plan.team)
    const brief = composeBrief(repo, graph.value, { team, role: plan.role }, item, briefDir, answerDeadlineSec)
    if (!brief.path) {
      log(`skip   ${plan.work_item}: ${brief.reason}`)
      decisions.push({ work_item: plan.work_item, action: 'no-brief', reason: brief.reason })
      continue
    }
    // GitHub #47 phase 2 (§3.5): `plan.candidate` is the entry `dispatchOn`
    // (loop-runner.mjs, `nextStep`) chose for THIS leg of a palette seat — set
    // only from a second or later leg on that seat, and already the fully
    // resolved shape workflow-graph.mjs produces (`model`/`adapter`/`effort`
    // with every default applied), so it needs no further resolution here. A
    // seat with no palette, or a palette seat's very first leg, carries no
    // `candidate` and resolves exactly as it always has.
    const model = plan.candidate ? plan.candidate.model : declaredModel(graph.value, plan.team, plan.agent_id)
    // Two different facts, said differently: a name the dispatch will hold the
    // adapter to, or the account default nobody pinned.
    const says = modelEnv(model).ACP_EXPECT_MODEL || 'account default (none requested)'
    const adapter = plan.candidate ? plan.candidate.adapter : declaredAdapter(graph.value, plan.team, plan.agent_id)
    const effort = plan.candidate ? plan.candidate.effort : declaredEffort(graph.value, plan.team, plan.agent_id)
    const effortSays = effortEnv(effort).ACP_EXPECT_REASONING_EFFORT || 'unset (adapter default)'
    const paletteSays = plan.candidate ? ` bucket=${plan.candidate.bucket}` : ''
    if (!apply) { log(`would dispatch ${plan.agent_id} (${plan.role}) for ${plan.work_item} lane=${adapter} model=${says} effort=${effortSays}${paletteSays}`); continue }
    const taskId = spawnLeg(repo, {
      workItem: plan.work_item, team: plan.team, role: plan.role,
      agentId: plan.agent_id, workflow: plan.workflow, model, adapter, effort,
    }, brief.path, stallSec, { spawnFn })
    log(`start  ${plan.agent_id} (${plan.role}) <- ${plan.work_item} task=${taskId} lane=${adapter} model=${says} effort=${effortSays}${paletteSays}`)
    started.push({ ...plan, task_id: taskId, model, effort })
  }

  // The outer controller runs last, on what the rest of the tick could not
  // resolve. It is the only role dispatched about the board rather than about a
  // token.
  const occupancy = teamOccupancy(graph.value, items)
  const escalation = planEscalation(repo, graph.value, items, plans, occupancy)
  if (escalation?.action === 'cooldown' || escalation?.action === 'unchanged') {
    log(`pm     holding: ${escalation.reason}`)
  }
  if (escalation?.action === 'escalate') {
    mkdirSync(briefDir, { recursive: true })
    const briefPath = join(briefDir, 'brief-board-pm.md')
    writeFileSync(briefPath, escalation.brief)
    // The controller is not a member of any team, so its model comes off the
    // graph's own seat for it rather than out of any team's `models` block.
    const pmModel = declaredModel(graph.value, null, escalation.agent_id)
    const pmSays = modelEnv(pmModel).ACP_EXPECT_MODEL || 'account default (none requested)'
    // The lane the delivery legs above already carry. Omitting it here let
    // `dispatch`'s `adapter = DEFAULT_ADAPTER` default win, so a graph
    // declaring `outer_controller_adapter: "codex"` validated, normalized and
    // drew on the page — and spawned `claude`. The dispatch log said `model=`
    // and not `lane=`, so nothing in the record could contradict it either.
    const pmAdapter = declaredAdapter(graph.value, null, escalation.agent_id)
    const pmEffort = declaredEffort(graph.value, null, escalation.agent_id)
    const pmEffortSays = effortEnv(pmEffort).ACP_EXPECT_REASONING_EFFORT || 'unset (adapter default)'
    if (!apply) {
      log(`would dispatch ${escalation.agent_id} (pm) about ${escalation.triggers.length} problem(s) lane=${pmAdapter} model=${pmSays} effort=${pmEffortSays}`)
    } else if (busy.has(escalation.agent_id)) {
      log(`pm     already running on ${escalation.triggers.length} problem(s)`)
    } else {
      const taskId = spawnLeg(repo,
        { workItem: '', team: '', role: 'pm', agentId: escalation.agent_id, workflow: '', model: pmModel, adapter: pmAdapter, effort: pmEffort },
        briefPath, stallSec, { spawnFn })
      log(`start  ${escalation.agent_id} (pm) <- board task=${taskId} lane=${pmAdapter} model=${pmSays} effort=${pmEffortSays}`)
      started.push({ action: 'dispatch', role: 'pm', agent_id: escalation.agent_id, task_id: taskId, model: pmModel, effort: pmEffort })
      // Each escalated token is marked so the loop stops re-triggering on it
      // while the controller is thinking.
      // A finished route is flagged, not parked: `audit_requested` releases the
      // token exactly like `completed` does, so reading a delivery never puts it
      // back into a team's WIP.
      // A refused mark here is worse than a refused mark anywhere else, and it
      // has to be said in those terms. The controller has ALREADY been paid for
      // and `pm-notes/latest.md` has already been written, so the token's last
      // event does not change: the same trigger recurs next tick and the
      // unchanged-trigger brake then holds it forever. `REFUSED` alone reads as
      // a bookkeeping complaint; this is a token that is now stuck.
      const wedged = (workItem, kind) => {
        const reason = `the controller was dispatched but the ${kind} mark was refused — the token is parked`
          + ' with nothing recorded and the loop will not retry it. Repair its ledger.'
        log(`STUCK  ${workItem}: ${reason}`)
        decisions.push({ work_item: workItem, action: 'wedged', reason })
      }

      // The withdrawal's read receipt. Written only HERE — inside the branch that
      // actually spawned the controller, past the `apply` gate and the busy
      // check — so a withdrawal nobody was told about stays on the board, and
      // one that was told stops being a standing problem (GitHub #50).
      //
      // "Dispatched" is not "read": the controller's leg could die before it
      // opens the brief, and then the receipt outlives a delivery that never
      // happened. That is true, it was raised in review, and it is left alone
      // ON PURPOSE — the audit and parked marks a few lines below have exactly
      // the same exposure, and one trigger inventing its own stronger rule
      // would be a worse thing to reason about than three that behave alike. No ledger write: `abandoned` is
      // a hard terminal and this is the one trigger that cannot mark its own
      // token.
      // A failed mark used to leave a promise the code could not keep. The log
      // said the withdrawal "will be reported again"; it would not be. The
      // receipt stays absent, so the SAME trigger set is computed next tick,
      // and `pm-notes/latest.md` had already been written with that exact
      // identity — so the unchanged-trigger brake answered `unchanged` and the
      // token was suppressed for good, by the brake, silently. Found by a
      // release reviewer reading the two sites together.
      //
      // The identity written below therefore leaves OUT every withdrawal whose
      // receipt could not be written. Next tick computes a different identity,
      // the brake does not fire, and the sentence in the log becomes true. The
      // cooldown still bounds how often that happens — deleting the notes file
      // instead would have disabled BOTH brakes and re-dispatched a real ACP
      // session every tick under a disk-full condition, which is the worst
      // moment to start paying for one.
      const unmarked = new Set()
      for (const workItem of escalation.withdrawals || []) {
        if (!markNoticeRead(repo, workItem)) {
          unmarked.add(withdrawalTriggerId(workItem))
          log(`note   ${workItem}: the withdrawal notice could not be marked read — it will be reported again`)
        }
      }

      for (const workItem of escalation.audits || []) {
        // The runner raised the flag; the controller has not answered yet, so
        // the runner is the one accountable for this line.
        if (!record(repo, {
          at: new Date().toISOString(), event: 'audit_requested', work_item: workItem,
          workflow: items.get(workItem)?.workflow || null,
          agent_id: escalation.agent_id, task_id: taskId,
          reason: 'route finished — read the delivery as a whole',
        })) wedged(workItem, 'audit_requested')
      }
      // Only the token the brief actually asked about. Marking any other token
      // `escalated` parks it against an answer this outbox cannot give — see
      // planEscalation's note on the single verdict line.
      for (const plan of plans.filter((entry) => entry.action === 'escalate' && entry.work_item === escalation.parked)) {
        if (!record(repo, {
          at: new Date().toISOString(), event: 'escalated', work_item: plan.work_item,
          workflow: items.get(plan.work_item)?.workflow || null,
          // The controller is not a team, so without naming the team that is
          // still holding this the board cannot place it — it would draw parked
          // work as unplaceable and free a WIP slot nobody actually released.
          agent_id: escalation.agent_id, to_team: plan.team, task_id: taskId, reason: plan.reason,
        })) wedged(plan.work_item, 'escalated')
      }

      // Written LAST, and only for what was actually recorded. It is the input
      // to the unchanged-trigger brake, so a line here is a promise that the
      // corresponding problem has been dealt with; a line for a receipt that
      // failed to write is a promise nothing kept.
      //
      // Written after the dispatch, not before, on purpose: if this process
      // dies in between, the file is missing and the controller is dispatched
      // again next tick. Re-reading a board costs a session; suppressing a
      // token costs the token.
      const notesDir = join(repo, '.tmux-teams', 'pm-notes')
      mkdirSync(notesDir, { recursive: true })
      const recorded = escalation.identity.split('\n').filter((id) => !unmarked.has(id)).join('\n')
      writeFileSync(join(notesDir, 'latest.md'), `${new Date().toISOString()}\n${recorded}\n`)
    }
  }

  // The healthy stamp, last, so `started` includes the controller's own leg.
  beat({ dispatching: true, started: started.length, held: heldCount(occupancy) })
  // C1: the tick's own refusals, in one file a human can still open after the
  // log has scrolled past. A dry run does not stamp this any more than it
  // stamps the heartbeat above — a simulation must never impersonate what a
  // live tick actually decided (§11.3).
  if (apply) writeDecisions(repo, decisions)
  return { ok: true, harvested, pulls, plans, started }
}

if (process.argv[1]?.endsWith('loop-runner.mjs')) {
  const args = process.argv.slice(2)
  const repo = args.find((value) => !value.startsWith('--')) || '.'
  const dry = args.includes('--dry-run')
  const watchArg = args.find((value) => value.startsWith('--watch'))
  const intervalSec = watchArg ? Number(watchArg.split('=')[1] || 30) : 0
  // The page judges the runner's silence against the runner's OWN interval, so
  // a runner driven one tick at a time by cron has to be able to state what
  // that interval is; without it every cron-driven loop would read as dead
  // between runs.
  const tickArg = args.find((value) => value.startsWith('--tick-sec'))
  const declared = tickArg ? Number(tickArg.split('=')[1]) : Number.NaN
  const tickSec = Number.isFinite(declared) && declared > 0 ? declared
    : intervalSec > 0 ? intervalSec : DEFAULT_TICK_SEC

  const once = () => {
    const result = tick(repo, { apply: !dry, tickSec })
    if (!result.ok) {
      console.error(`[loop] ${result.reason}`)
      return false
    }
    if (!result.harvested.length && !result.pulls.length && !result.plans.length) log('nothing to move')
    return true
  }

  if (!once()) process.exit(1)
  if (intervalSec > 0) {
    log(`watching ${repo} every ${intervalSec}s — ctrl-c to stop`)
    // The interval is the backstop and the clock-driven deadlines' only reader;
    // the watcher is what removes the wait between a worker finishing and the
    // board noticing. Restarting the timer after a woken tick keeps the sweep
    // measured from the last RUN rather than from process start — otherwise a
    // busy repo would still sweep on the old cadence, doing the work twice.
    let timer = setInterval(once, intervalSec * 1000)
    watchForWork(repo, {
      log,
      onChange: () => {
        clearInterval(timer)
        // `finally`, because the claim made for this whole function is that a
        // watcher can only cost LATENCY. Without it a throw inside `once()`
        // leaves the interval cleared and never re-armed — the backstop
        // destroyed by the thing that was supposed to be additive. Today that
        // throw would also kill the process, so the window is narrow; a release
        // reviewer pointed out it stops being narrow the moment anyone adds
        // exception handling, and a guarantee that depends on nobody improving
        // the code is not a guarantee.
        try { once() } finally { timer = setInterval(once, intervalSec * 1000) }
      },
    })
  }
}
