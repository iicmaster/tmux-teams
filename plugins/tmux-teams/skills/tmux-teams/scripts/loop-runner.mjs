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
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { planPulls, applyPulls } from './pull-controller.mjs'
import { INTAKE_VERDICTS, REVIEW_VERDICTS, readVerdict, roleBrief } from './role-briefs.mjs'
import { readWorkflowGraph } from './team-flow.mjs'
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
function busyAgents(repo) {
  const snapshot = readJson(join(repo, '.tmux-teams', 'pulse.json'), null)
  const rows = [...(snapshot?.runs || []), ...(snapshot?.history?.runs || [])]
  const newest = new Map()
  for (const row of rows) {
    if (!row.agent_id) continue
    const seen = newest.get(row.agent_id)
    if (!seen || String(row.started_at || '') > String(seen.started_at || '')) newest.set(row.agent_id, row)
  }
  return new Set([...newest.values()].filter((row) => WORKING.has(row.state)).map((row) => row.agent_id))
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

function appendEvent(repo, event) {
  const dir = join(repo, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  appendFileSync(join(dir, `${event.work_item}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 })
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

// ── briefs ───────────────────────────────────────────────────────────────────

function composeBrief(repo, graph, plan, item, scratchDir) {
  const { team, role } = plan
  const parts = []

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
    const pulled = lastOf(item, (entry) => entry.event === 'pulled')
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

export function planHarvest(graph, items) {
  const jobs = []
  for (const item of items.values()) {
    const last = item.custody[item.custody.length - 1]
    if (!last || last.event !== 'delivered' || last.terminal !== 'done') continue
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
      return { ...base, event: 'intake', agent_id: last.agent_id, verdict: 'accept', reason }
    }
    const pulled = lastOf(item, (entry) => entry.event === 'pulled')
    if (!pulled?.from_team) {
      return {
        ...base, event: 'escalated', agent_id: last.agent_id,
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
    appendEvent(repo, event)
    if (event.event === 'reviewed') recordVerdict(repo, graph, job.item, event)
    applied.push(event)
  }
  return applied
}

// ── dispatch planning ────────────────────────────────────────────────────────

const attemptsBy = (item, agentIds) =>
  item.custody.filter((entry) => entry.event === 'assigned' && agentIds.includes(entry.agent_id)).length

function nextStep(graph, team, item, { busy, nowMs, zombieSec }) {
  const last = item.custody[item.custody.length - 1]
  const legs = item.custody.filter((entry) => entry.event === 'assigned').length
  if (legs >= MAX_LEGS) {
    return { action: 'escalate', reason: `${legs} legs on one token — it is bouncing, not progressing` }
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

  if (last.event === 'escalated') return { action: 'held', reason: 'waiting on the outer controller' }

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
    const failed = last.event === 'lost' || (last.terminal && last.terminal !== 'done')
    if (failed) return want(role)
    if (role === 'worker') return want('evaluator')
    return { action: 'harvest-pending', reason: `the ${role} leg is waiting to be harvested` }
  }

  if (last.event === 'pulled') return want('dispatcher')
  if (last.event === 'intake' || last.event === 'returned') return want('worker')
  return { action: 'skip', reason: `nothing follows ${last.event}` }
}

export function planDispatches(graph, items, busy, { now = Date.now(), zombieSec = ZOMBIE_SEC } = {}) {
  const { held } = teamOccupancy(graph, items)
  const teamById = new Map(graph.teams.map((team) => [team.team_id, team]))
  const plans = []
  for (const [teamId, tokens] of held) {
    const team = teamById.get(teamId)
    // The WIP limit is the promise the board makes to a reader, and the runner
    // is the only thing that can keep it. Dispatching per free agent instead of
    // per unit of allowed work is how a team limited to one ran two.
    let slots = team.wip_limit
    for (const workItem of tokens) {
      const item = items.get(workItem)
      const step = nextStep(graph, team, item, { busy, nowMs: now, zombieSec })
      if (step.action === 'in-flight') { slots -= 1; continue }
      if (step.action === 'dispatch') {
        if (slots <= 0) {
          plans.push({
            action: 'wait', work_item: workItem, team: teamId,
            reason: `${team.name} is at its WIP limit (${team.wip_limit})`,
          })
          continue
        }
        slots -= 1
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
export function planEscalation(repo, graph, items, plans, occupancy, { now = Date.now(), cooldownSec = PM_COOLDOWN_SEC } = {}) {
  const triggers = plans.filter((plan) => plan.action === 'escalate')
    .map((plan) => `- \`${plan.work_item}\` in ${plan.team}: ${plan.reason}`)
  for (const orphan of occupancy.orphans) {
    triggers.push(`- \`${orphan.work_item}\` cannot be placed: last actor \`${orphan.agent_id || 'none'}\`, workflow \`${orphan.workflow || 'none'}\``)
  }
  if (!triggers.length) return null

  const notesDir = join(repo, '.tmux-teams', 'pm-notes')
  try {
    const newest = statSync(join(notesDir, 'latest.md')).mtimeMs
    if ((now - newest) / 1000 < cooldownSec) {
      return { action: 'cooldown', reason: `outer controller ran ${Math.round((now - newest) / 1000)}s ago`, triggers }
    }
  } catch { /* never run before */ }

  return {
    action: 'escalate',
    agent_id: graph.outer_controller_id,
    triggers,
    brief: roleBrief(repo, 'pm', null, {
      projectId: graph.project_id || 'unnamed',
      trigger: triggers.join('\n'),
      board: boardSummary(graph, items, occupancy),
    }),
  }
}

// ── spawning ─────────────────────────────────────────────────────────────────

function dispatch(repo, { workItem, team, role, agentId, workflow }, briefPath, stallSec) {
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
      ...(workflow ? { TMUX_TEAMS_WORKFLOW: workflow } : {}),
      ...(workItem ? { TMUX_TEAMS_WORK_ITEM: workItem } : {}),
      ECC_GATEGUARD: 'off',
    },
  })
  child.unref()
  return taskId
}

export function tick(repoArg, { apply = true, stallSec = 1800, scratchDir } = {}) {
  // The ACP adapter rejects a relative cwd outright, and the runner is the last
  // place a relative path can still be sitting — resolve once, here.
  const repo = resolve(repoArg)
  const graph = readWorkflowGraph(repo)
  if (!graph.ok) return { ok: false, reason: `team graph invalid (${graph.source}): ${graph.reason}` }
  const briefDir = scratchDir || join(repo, '.tmux-teams', 'runner-briefs')

  // Harvest first. A judging leg that has finished but not been read leaves the
  // pull controller looking at a stale event — and pulling before the review
  // lands is exactly how the evaluator became decorative.
  const harvested = []
  const jobs = planHarvest(graph.value, readWorkItems(repo).items)
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
    else log(`skip   ${entry.work_item}: ${entry.reason ?? entry.action}`)
  }

  // Re-read: the pulls just written are what makes a token dispatchable now.
  const { items } = readWorkItems(repo)
  const busy = busyAgents(repo)
  const plans = planDispatches(graph.value, items, busy)
  const started = []
  for (const plan of plans) {
    if (plan.action === 'lost') {
      log(`LOST   ${plan.work_item}: ${plan.reason}`)
      if (apply) {
        appendEvent(repo, {
          at: new Date().toISOString(), event: 'lost', work_item: plan.work_item,
          workflow: items.get(plan.work_item).workflow || null,
          agent_id: plan.agent_id, task_id: plan.task_id || null, reason: plan.reason,
        })
      }
      continue
    }
    if (plan.action !== 'dispatch') {
      const level = plan.action === 'escalate' ? 'STUCK ' : plan.action === 'wait' ? 'wait  ' : 'skip  '
      if (plan.reason) log(`${level} ${plan.work_item}: ${plan.reason}`)
      continue
    }
    const item = items.get(plan.work_item)
    const team = graph.value.teams.find((entry) => entry.team_id === plan.team)
    const brief = composeBrief(repo, graph.value, { team, role: plan.role }, item, briefDir)
    if (!brief.path) { log(`skip   ${plan.work_item}: ${brief.reason}`); continue }
    if (!apply) { log(`would dispatch ${plan.agent_id} (${plan.role}) for ${plan.work_item}`); continue }
    const taskId = dispatch(repo, {
      workItem: plan.work_item, team: plan.team, role: plan.role,
      agentId: plan.agent_id, workflow: plan.workflow,
    }, brief.path, stallSec)
    log(`start  ${plan.agent_id} (${plan.role}) <- ${plan.work_item} task=${taskId}`)
    started.push({ ...plan, task_id: taskId })
  }

  // The outer controller runs last, on what the rest of the tick could not
  // resolve. It is the only role dispatched about the board rather than about a
  // token.
  const occupancy = teamOccupancy(graph.value, items)
  const escalation = planEscalation(repo, graph.value, items, plans, occupancy)
  if (escalation?.action === 'cooldown') log(`pm     holding: ${escalation.reason}`)
  if (escalation?.action === 'escalate') {
    mkdirSync(briefDir, { recursive: true })
    const briefPath = join(briefDir, 'brief-board-pm.md')
    writeFileSync(briefPath, escalation.brief)
    if (!apply) {
      log(`would dispatch ${escalation.agent_id} (pm) about ${escalation.triggers.length} problem(s)`)
    } else if (busy.has(escalation.agent_id)) {
      log(`pm     already running on ${escalation.triggers.length} problem(s)`)
    } else {
      const notesDir = join(repo, '.tmux-teams', 'pm-notes')
      mkdirSync(notesDir, { recursive: true })
      writeFileSync(join(notesDir, 'latest.md'), `${new Date().toISOString()}\n${escalation.triggers.join('\n')}\n`)
      const taskId = dispatch(repo, { workItem: '', team: '', role: 'pm', agentId: escalation.agent_id, workflow: '' },
        briefPath, stallSec)
      log(`start  ${escalation.agent_id} (pm) <- board task=${taskId}`)
      started.push({ action: 'dispatch', role: 'pm', agent_id: escalation.agent_id, task_id: taskId })
      // Each escalated token is marked so the loop stops re-triggering on it
      // while the controller is thinking.
      for (const plan of plans.filter((entry) => entry.action === 'escalate')) {
        appendEvent(repo, {
          at: new Date().toISOString(), event: 'escalated', work_item: plan.work_item,
          workflow: items.get(plan.work_item)?.workflow || null,
          agent_id: escalation.agent_id, task_id: taskId, reason: plan.reason,
        })
      }
    }
  }

  return { ok: true, harvested, pulls, plans, started }
}

if (process.argv[1]?.endsWith('loop-runner.mjs')) {
  const args = process.argv.slice(2)
  const repo = args.find((value) => !value.startsWith('--')) || '.'
  const dry = args.includes('--dry-run')
  const watchArg = args.find((value) => value.startsWith('--watch'))
  const intervalSec = watchArg ? Number(watchArg.split('=')[1] || 30) : 0

  const once = () => {
    const result = tick(repo, { apply: !dry })
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
