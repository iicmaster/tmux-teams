// pull-controller.mjs — the WIP limit and the pull system, enforced.
//
// Until now the board drew a WIP limit and a pull arrow; nothing stopped work
// being pushed past either. This is the mechanism: it never hands work to a
// team, it only lets a team TAKE work it has room for.
//
// One pass over the token ledgers:
//   a token whose last event is `delivered` is sitting in its team's done queue
//   → find the next team on its workflow route
//   → if that team is under its WIP limit, append `pulled` (it took the work)
//   → if it is at the limit, leave the token where it is and report it blocked
//   → if there is no next team, the route is finished: append `completed`
//
// Nothing is ever appended on behalf of a team that has no room. A blocked
// token stays visibly blocked, because a queue backing up is the signal the
// whole board exists to show — hiding it by pushing anyway is the failure this
// file prevents.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { readWorkflowGraph } from './graph-loop.mjs'

export function planPulls(graph, items, now = new Date().toISOString()) {
  const teamOf = new Map()
  for (const team of graph.teams) {
    for (const agent of team.agents) teamOf.set(agent.agent_id, team)
  }
  const workflowById = new Map(graph.workflows.map((entry) => [entry.workflow_id, entry]))

  // Occupancy is read from the one function that owns the rule, not counted a
  // second time here. Two readers computing "who is holding this" separately is
  // exactly how the board came to draw a limit the controller was not enforcing.
  const occupancy = new Map(teamOccupancy(graph, items).counts)
  const pending = []
  const decisions = []
  for (const item of items.values()) {
    const last = item.custody[item.custody.length - 1]
    const team = teamOf.get(last.agent_id) ||
      graph.teams.find((entry) => entry.team_id === last.to_team) || null
    if (!team) continue
    // A leg that ended in a protocol error or a timeout produced no artifact.
    // Pulling it forward would hand the next team a delivery that never was.
    if (last.event === 'delivered' && last.terminal && last.terminal !== 'done') {
      decisions.push({
        work_item: item.work_item, action: 'failed', from_team: team.team_id,
        reason: `last leg ended ${last.terminal} — needs a rerun, not a handoff`,
      })
      continue
    }
    // Only an accepted review releases work. A worker finishing is not the team
    // finishing: until that team's own evaluator has passed it the artifact has
    // been typed, not checked. Gating here is what makes the evaluator real
    // rather than a box on a diagram — pulling on `delivered` moved every token
    // onward before its evaluator ever ran.
    if (last.event !== 'reviewed' || last.verdict !== 'pass') continue
    pending.push({ item, last, team })
  }

  // Oldest delivery first: a pull system that served the newest arrival would
  // starve whatever has been waiting longest, which is the opposite of flow.
  pending.sort((a, b) => String(a.last.at || '').localeCompare(String(b.last.at || '')))

  for (const { item, last, team } of pending) {
    const workflow = workflowById.get(item.workflow || last.workflow)
    if (!workflow) {
      decisions.push({ work_item: item.work_item, action: 'skip', reason: 'no declared workflow' })
      continue
    }
    const index = workflow.route.indexOf(team.team_id)
    if (index === -1) {
      decisions.push({
        work_item: item.work_item, action: 'skip',
        reason: `${team.team_id} is not on route ${workflow.workflow_id}`,
      })
      continue
    }
    const nextId = workflow.route[index + 1]
    if (!nextId) {
      decisions.push({
        work_item: item.work_item, action: 'complete', workflow: workflow.workflow_id,
        from_team: team.team_id,
        event: {
          at: now, event: 'completed', work_item: item.work_item,
          workflow: workflow.workflow_id, from_team: team.team_id,
        },
      })
      continue
    }
    const next = graph.teams.find((entry) => entry.team_id === nextId)
    const used = occupancy.get(nextId) || 0
    if (used >= next.wip_limit) {
      decisions.push({
        work_item: item.work_item, action: 'blocked', workflow: workflow.workflow_id,
        from_team: team.team_id, to_team: nextId,
        reason: `${next.name} is at its WIP limit (${used}/${next.wip_limit})`,
      })
      continue
    }
    occupancy.set(nextId, used + 1)
    decisions.push({
      work_item: item.work_item, action: 'pull', workflow: workflow.workflow_id,
      from_team: team.team_id, to_team: nextId,
      // The receiving dispatcher is the one taking it: a pull is an act by the
      // team that has room, never a push by the team that finished.
      event: {
        at: now, event: 'pulled', work_item: item.work_item, workflow: workflow.workflow_id,
        agent_id: next.dispatcher_id, from_team: team.team_id, to_team: nextId,
      },
    })
  }
  return decisions
}

export function applyPulls(repo, decisions) {
  const dir = join(repo, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let written = 0
  for (const decision of decisions) {
    if (!decision.event) continue
    appendFileSync(join(dir, `${decision.work_item}.jsonl`), `${JSON.stringify(decision.event)}\n`, { mode: 0o600 })
    written += 1
  }
  return written
}

const describe = (decision) => decision.action === 'pull'
  ? `pull   ${decision.work_item}: ${decision.from_team} -> ${decision.to_team} (${decision.workflow})`
  : decision.action === 'complete'
    ? `done   ${decision.work_item}: finished ${decision.workflow} at ${decision.from_team}`
    : decision.action === 'blocked'
      ? `BLOCK  ${decision.work_item}: ${decision.from_team} -> ${decision.to_team} — ${decision.reason}`
      : decision.action === 'failed'
        ? `FAILED ${decision.work_item}: ${decision.reason}`
        : `skip   ${decision.work_item}: ${decision.reason}`

if (process.argv[1]?.endsWith('pull-controller.mjs')) {
  const args = process.argv.slice(2)
  const repo = args.find((value) => !value.startsWith('--')) || '.'
  const graph = readWorkflowGraph(repo)
  if (!graph.ok) {
    console.error(`[pull] team graph invalid (${graph.source}): ${graph.reason}`)
    process.exit(1)
  }
  const { items } = readWorkItems(repo)
  const decisions = planPulls(graph.value, items)
  if (!decisions.length) {
    console.log('[pull] nothing waiting in a done queue')
    process.exit(0)
  }
  for (const decision of decisions) console.log(`[pull] ${describe(decision)}`)
  if (args.includes('--apply')) {
    console.log(`[pull] appended ${applyPulls(repo, decisions)} custody events`)
  } else {
    console.log('[pull] dry run — pass --apply to record these pulls')
  }
}
