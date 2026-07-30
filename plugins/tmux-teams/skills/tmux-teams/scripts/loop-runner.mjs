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
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { validateLedgerFile } from './ledger-validate.mjs'
import { appendEvent as appendLedgerEvent, ledgerPath } from './ledger-writer.mjs'
import { planPulls, applyPulls } from './pull-controller.mjs'
import { AUDIT_VERDICTS, INTAKE_VERDICTS, OUTER_VERDICTS, REVIEW_VERDICTS, readVerdict, roleBrief } from './role-briefs.mjs'
import { readWorkflowGraph } from './graph.mjs'
import { teamRoleOf } from './workflow-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, 'acp-companion.mjs')
const KMS = join(HERE, 'kms.mjs')
const WORKING = new Set(['running', 'starting', 'orphan_running'])

const MAX_ATTEMPTS = 3   // three failures by one role in one team is a problem to escalate, not retry
// One counter for the whole token. Per-role caps each look reasonable and
// together still let an intake rejection and a review rejection bounce a token
// between two teams indefinitely — the ceiling has to be on the journey.
const MAX_LEGS = 15
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

// The safety rule this whole branch exists for. acp-companion treats a REQUESTED
// model as a promise it must keep: setting ACP_EXPECT_MODEL starts
// `identity_status` at `missing`, and the session receipt is rejected outright
// unless the adapter answers with exactly that name. So the sentinel — and an
// empty name — must set NOTHING, leaving the account default in place. Only a
// real declared name is ever passed through, because only a real declared name
// is something the adapter can be held to.
export function modelEnv(model) {
  const name = typeof model === 'string' ? model.trim() : ''
  return name && name !== INHERIT_ACCOUNT_DEFAULT ? { ACP_EXPECT_MODEL: name } : {}
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
function busyAgents(repo, nowMs = Date.now()) {
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
  const busy = new Set([...newest.values()].filter((row) => WORKING.has(row.state)).map((row) => row.agent_id))
  // No snapshot at all is a repo where nothing has ever run — there is no agent
  // to collide with, so the first dispatch is safe. A snapshot that EXISTS but
  // has stopped moving is the dangerous one: it can still be asserting that
  // agents are running, and it is no longer able to say when they stop.
  const missing = snapshot === null
  return {
    busy, ageSec, missing,
    stale: !missing && (ageSec === null || ageSec > PULSE_STALE_SEC),
  }
}

const outboxText = (repo, taskId) => {
  if (!taskId) return ''
  try { return readFileSync(join(repo, '.mailbox-out', taskId), 'utf8') } catch { return '' }
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

function record(repo, event, actor = RUNNER_ACTOR) {
  const result = appendLedgerEvent(repo, event, { actor })
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
function lastWorkerDelivery(graph, item) {
  for (let index = item.custody.length - 1; index >= 0; index -= 1) {
    const entry = item.custody[index]
    if (entry.event !== 'delivered' || entry.terminal !== 'done' || !entry.task_id) continue
    if (teamRoleOf(graph, entry.agent_id)?.role === 'worker') return entry
  }
  return null
}

const lastOf = (item, predicate) => [...item.custody].reverse().find(predicate) || null

const failedLegs = (item) => item.custody.filter((entry) =>
  entry.event === 'lost' || (entry.event === 'delivered' && entry.terminal && entry.terminal !== 'done')).length

// A route that closed and has not been read as a whole. Every evaluator checked
// its own leg; nobody checked whether what came out of the end is what was
// asked for.
const awaitingAudit = (item) => {
  const events = item.custody.map((entry) => entry.event)
  const closed = events.lastIndexOf('completed')
  return closed !== -1 && !events.slice(closed).some((event) => event === 'audit_requested' || event === 'audited')
}

// ── briefs ───────────────────────────────────────────────────────────────────

function composeBrief(repo, graph, plan, item, scratchDir) {
  const { team, role } = plan
  const parts = []

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
  } else if (role === 'dispatcher') {
    const workflow = graph.workflows.find((entry) => entry.workflow_id === item.workflow)
    // Either arrival carries the context the dispatcher is judging: a `pulled`
    // names the team that sent it, an `opened` names why the work exists at all.
    const pulled = lastOf(item, (entry) => entry.event === 'pulled' || entry.event === 'opened')
    parts.push(roleBrief(repo, 'dispatcher', team.team_id, {
      teamName: team.name,
      workItem: item.work_item,
      fromTeam: pulled?.from_team || '',
      route: workflow ? workflow.route.join(' -> ') : 'unknown',
    }))
  } else if (role === 'evaluator') {
    const delivery = lastWorkerDelivery(graph, item)
    parts.push(roleBrief(repo, 'evaluator', team.team_id, {
      teamName: team.name,
      workItem: item.work_item,
      workerId: delivery?.agent_id || 'a worker of this team',
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
    const text = outboxText(repo, previous.task_id)
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
    const last = item.custody[item.custody.length - 1]
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

function harvestEvent(repo, graph, { item, last, role }, now) {
  const text = outboxText(repo, last.task_id)
  const base = { at: now, work_item: item.work_item, workflow: item.workflow || null, task_id: last.task_id || null }

  if (role === 'dispatcher') {
    const { verdict, stated, reason } = readVerdict(text, INTAKE_VERDICTS)
    if (verdict === 'accept') {
      // §4 requires a reason on `intake`. An accept with nothing said is
      // common and legal, so the absence is stated rather than left blank —
      // a blank field is refused by the writer and would stall the token.
      return { ...base, event: 'intake', agent_id: last.agent_id, verdict: 'accept', reason: reason || 'no reason stated' }
    }
    // Not workable yet, and not refused. The token stays exactly where it is —
    // still held, still counted against WIP — and only a person can move it.
    if (verdict === 'question') {
      return {
        ...base, event: 'questioned', agent_id: last.agent_id,
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
    // No agent_id on purpose: the token is now held by the team it went back to,
    // not by the dispatcher that refused it.
    return {
      ...base, event: 'returned', to_team: pulled.from_team, refused_by: last.agent_id,
      reason: stated ? (reason || 'no reason stated') : 'the dispatcher stated no verdict',
    }
  }

  if (role === 'audit') {
    const { verdict, stated, reason } = readVerdict(text, AUDIT_VERDICTS)
    // Same rule as every other gate: an unread answer changes nothing, and the
    // token stays flagged so the next tick asks again rather than closing it.
    if (!stated) return null
    return { ...base, event: 'audited', agent_id: last.agent_id, verdict, reason: reason || 'no reason stated' }
  }

  if (role === 'outer') {
    const { verdict, stated, reason } = readVerdict(text, OUTER_VERDICTS)
    // Silence is not permission to close someone's work. An unreadable answer
    // leaves the token parked exactly where the controller found it.
    if (!stated) return null
    if (verdict === 'abandon') {
      return { ...base, event: 'abandoned', agent_id: last.agent_id, reason: reason || 'no reason stated' }
    }
    return {
      ...base, event: 'resumed', agent_id: last.agent_id, to_team: last.to_team || null,
      grant: RESUME_GRANT, reason: reason || 'no reason stated',
    }
  }

  const { verdict, stated, reason } = readVerdict(text, REVIEW_VERDICTS)
  return {
    ...base, event: 'reviewed', agent_id: last.agent_id, verdict,
    reviewed_task: lastWorkerDelivery(graph, item)?.task_id || null,
    reason: stated ? (reason || 'no reason stated') : 'the evaluator stated no verdict',
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

export function applyHarvest(repo, graph, jobs, now = new Date().toISOString()) {
  const applied = []
  for (const job of jobs) {
    const event = harvestEvent(repo, graph, job, now)
    // A controller that answered nothing changes nothing; appending a no-op
    // would only make the loop re-read the same outbox every tick.
    if (!event) continue
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

const attemptsBy = (item, agentIds) =>
  sinceResume(item).filter((entry) => entry.event === 'assigned' && agentIds.includes(entry.agent_id)).length

// The absolute ceiling on one token's spend. It moves only when the controller
// deliberately grants more, and each grant cost a PM dispatch to obtain. The
// clamp is there because this reads a file that is meant to be appended to.
const legCeiling = (item) => MAX_LEGS + item.custody
  .filter((entry) => entry.event === 'resumed')
  .reduce((sum, entry) => sum + (Number.isInteger(entry.grant) ? Math.min(Math.max(entry.grant, 0), RESUME_GRANT) : 0), 0)

function nextStep(graph, team, item, { busy, nowMs, zombieSec, answerDeadlineSec }) {
  const last = item.custody[item.custody.length - 1]
  const legs = item.custody.filter((entry) => entry.event === 'assigned').length
  const ceiling = legCeiling(item)
  if (legs >= ceiling) {
    return { action: 'escalate', reason: `${legs} legs on one token against a ceiling of ${ceiling} — it is bouncing, not progressing` }
  }

  const want = (role) => {
    const pool = role === 'worker' ? team.worker_ids
      : role === 'dispatcher' ? [team.dispatcher_id] : [team.evaluator_id]
    const attempts = attemptsBy(item, pool)
    if (attempts >= MAX_ATTEMPTS) {
      return { action: 'escalate', reason: `${attempts} ${role} attempts in ${team.team_id} all failed` }
    }
    const free = pool.find((agentId) => !busy.has(agentId))
    if (!free) return { action: 'wait', role, reason: `every ${role} on this team is busy` }
    return { action: 'dispatch', role, agent_id: free }
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
      return { action: 'held', reason: 'waiting on the outer controller' }
    }
    return { action: 'escalate', reason: last.reason || `escalated by ${last.agent_id} and the controller has not been asked yet` }
  }

  if (last.event === 'assigned') {
    if (busy.has(last.agent_id)) return { action: 'in-flight' }
    const ageSec = (nowMs - Date.parse(last.at || '')) / 1000
    if (!Number.isFinite(ageSec) || ageSec < zombieSec) return { action: 'in-flight' }
    // No process, no delivery, and long past the point where one could still be
    // starting: the leg is gone. Recording that is not the same as inventing a
    // delivery, and without it the token sits in the team's WIP forever.
    return {
      action: 'lost', agent_id: last.agent_id, task_id: last.task_id || '',
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
        action: 'expired', agent_id: last.agent_id,
        reason: `no answer in ${Math.round(answerDeadlineSec / 60)} minute(s) — the request is withdrawn and the queue is freed.`
          + ` Unanswered: ${last.questions}`,
      }
    }
    return { action: 'waiting', reason: `waiting on a person to answer: ${last.questions}` }
  }

  // The person replied, so the gate that asked runs again on what it now has.
  // Not a worker: nothing has been built yet, and the question was the
  // dispatcher's.
  if (last.event === 'answered') return want('dispatcher')
  if (last.event === 'intake' && team.team_id === graph.controller_team) return { action: 'ready' }
  if (last.event === 'intake' || last.event === 'returned' || last.event === 'resumed') return want('worker')
  return { action: 'skip', reason: `nothing follows ${last.event}` }
}

export function planDispatches(graph, items, busy, {
  now = Date.now(), zombieSec = ZOMBIE_SEC, maxInFlight = MAX_IN_FLIGHT,
  answerDeadlineSec = ANSWER_DEADLINE_SEC,
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
      const step = nextStep(graph, team, item, { busy, nowMs: now, zombieSec, answerDeadlineSec })
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
        })
        continue
      }
      plans.push({ ...step, work_item: workItem, team: teamId })
    }
  }
  return plans
}

// ── the outer controller ─────────────────────────────────────────────────────

const boardSummary = (graph, items, occupancy) => graph.teams.map((team) => {
  const held = occupancy.held.get(team.team_id) || []
  const detail = held.map((workItem) => {
    const last = items.get(workItem).custody[items.get(workItem).custody.length - 1]
    const extra = [last.verdict, last.terminal && last.terminal !== 'done' ? last.terminal : '']
      .filter(Boolean).join(' ')
    return `${workItem} (${last.event}${extra ? ` ${extra}` : ''})`
  })
  return `- **${team.name}** — WIP ${held.length}/${team.wip_limit}: ${detail.length ? detail.join(', ') : 'nothing held'}`
}).join('\n')

// Anomaly-triggered, never on a heartbeat: a timer that dispatches a full agent
// every interval bills for looking at a board that has not changed.
export function planEscalation(repo, graph, items, plans, occupancy, { now = Date.now(), cooldownSec = PM_COOLDOWN_SEC, stallSec = STALL_SEC } = {}) {
  const triggers = plans.filter((plan) => plan.action === 'escalate')
    .map((plan) => `- \`${plan.work_item}\` in ${plan.team}: ${plan.reason}`)
  for (const orphan of occupancy.orphans) {
    triggers.push(`- \`${orphan.work_item}\` cannot be placed: last actor \`${orphan.agent_id || 'none'}\`, workflow \`${orphan.workflow || 'none'}\``)
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
    triggers.push(`- \`${item.work_item}\` finished ${item.workflow || 'its route'} — nobody has read the delivery as a whole`
      + (failed ? ` (it recovered from ${failed} failed leg(s) on the way)` : ''))
  }

  const held = [...occupancy.held.values()].flat()
  for (const workItem of held) {
    const item = items.get(workItem)
    const failed = failedLegs(item)
    if (failed >= RETRY_NOISE) {
      triggers.push(`- \`${workItem}\` has survived ${failed} failed legs and is still going — retries are hiding them`)
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
      triggers.push(`- the board has held ${held.length} token(s) with nothing recorded for ${Math.round(idleSec / 60)} minutes`)
    }
  }

  if (!triggers.length) return null

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
      return { action: 'cooldown', reason: `outer controller ran ${Math.round((now - newest) / 1000)}s ago`, triggers }
    }
    // A time cooldown alone is no brake on a permanent condition. A token the
    // loop can never place stays in `triggers` on every tick, so an unchanged
    // trigger set means the controller would be dispatched again to read the
    // same board — every cooldown, forever.
    const seen = text.split('\n').slice(1).filter(Boolean).join('\n')
    if (seen === triggers.join('\n')) {
      return { action: 'unchanged', reason: `the same ${triggers.length} problem(s) the controller already read`, triggers }
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
  // The brief already said "the trigger above tells you which one this is". With
  // both kinds of trigger listed that was not true, and an agent that guessed
  // wrong answered in the wrong vocabulary — indistinguishable from silence.
  const ask = auditSubject
    ? `**The token to answer for is \`${auditSubject.work_item}\`.** It finished its route: this is the audit`
      + ' job below, so end with `accept` or `concern`.'
    : parkedSubject
      ? `**The token to answer for is \`${parkedSubject.work_item}\`.** It is parked: this is the unstick job`
        + ' below, so end with `resume` or `abandon`.'
      : '**No single token is waiting on your verdict this time.** Report what you see on the board;'
        + ' the verdict line will not move anything.'

  return {
    action: 'escalate',
    agent_id: graph.outer_controller_id,
    triggers,
    audits: auditSubject ? [auditSubject.work_item] : [],
    parked: parkedSubject ? parkedSubject.work_item : null,
    brief: roleBrief(repo, 'pm', null, {
      projectId: graph.project_id || 'unnamed',
      trigger: `${ask}\n\n${triggers.join('\n')}`,
      board: boardSummary(graph, items, occupancy),
    }),
  }
}

// ── spawning ─────────────────────────────────────────────────────────────────

function dispatch(repo, { workItem, team, role, agentId, workflow, model }, briefPath, stallSec) {
  const taskId = `${workItem || 'board'}-${team || 'loop'}-${role}-${Date.now().toString(36)}`
    .replace(/[^A-Za-z0-9_-]/g, '-')
  // Keep every dispatch log. Discarding the adapter stderr is how a runner ends
  // up unable to explain its own failures — which is exactly what happened the
  // first time this ran.
  const logDir = join(repo, '.tmux-teams', 'runner-logs')
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(join(logDir, `${taskId}.log`), 'a', 0o600)
  const child = spawn(process.execPath, [COMPANION, 'claude', repo, taskId, briefPath, String(stallSec)], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ACP_AGENT_ID: agentId,
      // DECISION 3: the dispatch declares the model this seat was assigned, so
      // the page can finally print a real name instead of "default — none
      // pinned". `modelEnv` is what keeps the sentinel from becoming a request
      // the adapter would refuse — see its comment for why that matters.
      ...modelEnv(model),
      ...(workflow ? { TMUX_TEAMS_WORKFLOW: workflow } : {}),
      ...(workItem ? { TMUX_TEAMS_WORK_ITEM: workItem } : {}),
      ECC_GATEGUARD: 'off',
    },
  })
  child.unref()
  return taskId
}

const heldCount = (occupancy) => [...occupancy.held.values()].flat().length

// `spawnLeg` is the only seam in this function, and it exists for one reason:
// every decision below — harvest, pull, WIP, escalation, and the order they run
// in — is reachable in a test only if starting an agent can be something other
// than forking a real ACP process. A replay that re-composes the planners by
// hand tests the composer's memory of this order rather than this order itself.
// The default is the real spawn, so production has no branch.
export function tick(repoArg, {
  apply = true, stallSec = 1800, scratchDir, tickSec = DEFAULT_TICK_SEC,
  spawnLeg = dispatch, answerDeadlineSec = ANSWER_DEADLINE_SEC,
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
  const briefDir = scratchDir || join(repo, '.tmux-teams', 'runner-briefs')

  // Harvest first. A judging leg that has finished but not been read leaves the
  // pull controller looking at a stale event — and pulling before the review
  // lands is exactly how the evaluator became decorative.
  const harvested = []
  const jobs = planHarvest(graph.value, readWorkItems(repo).items,
    (taskId) => existsSync(join(repo, '.mailbox-out', taskId)))
  if (jobs.length && apply) harvested.push(...applyHarvest(repo, graph.value, jobs))
  for (const event of harvested) {
    log(`${event.event.padEnd(6)} ${event.work_item}: ${event.verdict || event.to_team || ''} — ${event.reason || ''}`)
  }

  const before = readWorkItems(repo)
  const pulls = planPulls(graph.value, before.items)
  if (apply && pulls.some((entry) => entry.event)) applyPulls(repo, pulls)
  // Say every decision out loud. A runner that logs only the happy path looks
  // identical to one that has silently given up — which is what this one did
  // for 65 ticks before anyone noticed.
  for (const entry of pulls) {
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
  const plans = planDispatches(graph.value, items, busy, { answerDeadlineSec })
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
          agent_id: plan.agent_id, task_id: plan.task_id || null, reason: plan.reason,
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
      if (plan.reason) log(`${level} ${plan.work_item}: ${plan.reason}`)
      continue
    }
    // DECISION 4, read half. Occupancy, the pull decision, the board and the
    // audit are all derived from this one file, so dispatching a fresh leg onto
    // a history that cannot be believed writes good evidence on top of bad and
    // buries the break instead of surfacing it. Refuse, and name the defect —
    // a silent skip here would look exactly like a team with nothing to do.
    const ledger = validateLedgerFile(ledgerPath(repo, plan.work_item))
    if (!ledger.ok) {
      log(`LEDGER ${plan.work_item}: ${ledger.problems.length} problem(s) — refusing to dispatch onto a history that cannot be believed`)
      for (const problem of ledger.problems.slice(0, 5)) {
        log(`       line ${problem.line}  ${problem.code}  ${problem.detail}`)
      }
      continue
    }
    const item = items.get(plan.work_item)
    const team = graph.value.teams.find((entry) => entry.team_id === plan.team)
    const brief = composeBrief(repo, graph.value, { team, role: plan.role }, item, briefDir)
    if (!brief.path) { log(`skip   ${plan.work_item}: ${brief.reason}`); continue }
    const model = declaredModel(graph.value, plan.team, plan.agent_id)
    // Two different facts, said differently: a name the dispatch will hold the
    // adapter to, or the account default nobody pinned.
    const says = modelEnv(model).ACP_EXPECT_MODEL || 'account default (none requested)'
    if (!apply) { log(`would dispatch ${plan.agent_id} (${plan.role}) for ${plan.work_item} model=${says}`); continue }
    const taskId = spawnLeg(repo, {
      workItem: plan.work_item, team: plan.team, role: plan.role,
      agentId: plan.agent_id, workflow: plan.workflow, model,
    }, brief.path, stallSec)
    log(`start  ${plan.agent_id} (${plan.role}) <- ${plan.work_item} task=${taskId} model=${says}`)
    started.push({ ...plan, task_id: taskId, model })
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
    if (!apply) {
      log(`would dispatch ${escalation.agent_id} (pm) about ${escalation.triggers.length} problem(s) model=${pmSays}`)
    } else if (busy.has(escalation.agent_id)) {
      log(`pm     already running on ${escalation.triggers.length} problem(s)`)
    } else {
      const notesDir = join(repo, '.tmux-teams', 'pm-notes')
      mkdirSync(notesDir, { recursive: true })
      writeFileSync(join(notesDir, 'latest.md'), `${new Date().toISOString()}\n${escalation.triggers.join('\n')}\n`)
      const taskId = spawnLeg(repo,
        { workItem: '', team: '', role: 'pm', agentId: escalation.agent_id, workflow: '', model: pmModel },
        briefPath, stallSec)
      log(`start  ${escalation.agent_id} (pm) <- board task=${taskId} model=${pmSays}`)
      started.push({ action: 'dispatch', role: 'pm', agent_id: escalation.agent_id, task_id: taskId, model: pmModel })
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
      const wedged = (workItem, kind) => log(`STUCK  ${workItem}: the controller was dispatched but the ${kind}`
        + ' mark was refused — the token is parked with nothing recorded and the loop will not retry it. Repair its ledger.')

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
    }
  }

  // The healthy stamp, last, so `started` includes the controller's own leg.
  beat({ dispatching: true, started: started.length, held: heldCount(occupancy) })
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
    setInterval(once, intervalSec * 1000)
  }
}
