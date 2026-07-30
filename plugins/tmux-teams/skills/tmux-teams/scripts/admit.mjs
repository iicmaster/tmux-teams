// admit.mjs — the only door into the graph.
//
// `opened` is the one arrival with no team behind it: every other one is a pull,
// and `planPulls` refuses a pull into a team already at its WIP limit. Admission
// had no such gate, so the rule Master stated on 2026-07-31 — *"งานใหม่จะยังไม่ถูกดึงมา
// ทำถ้า wip ยังเต็ม"* — held everywhere except at the front door. The POC proved it
// by admitting two tokens onto a WIP-1 controller team and watching occupancy
// read 2.
//
// This is the operator's tool. Under `references/controller-as-team.md` the
// operator is an agent relaying for a person, so the check belongs where that
// agent acts — not inside `ledger-writer`, which judges one event against one
// ledger and has no business reading the graph.
import { readWorkflowGraph } from './graph.mjs'
import { readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { appendEvent } from './ledger-writer.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const fail = (code, detail) => ({ ok: false, code, detail })

/**
 * Admit one request through the controller team.
 *
 * @param {string} repo
 * @param {{work_item: string, workflow: string, reason: string}} request
 * @param {{actor: string}} options — `human:<name>` even when an agent relays
 *        it: the actor names who DECIDED, and the person decided (§6.4.1).
 */
export function admitWorkItem(repo, request, options = {}) {
  const graph = readWorkflowGraph(repo)
  if (!graph.ok) return fail('graph_invalid', `the declaration cannot be read: ${graph.reason}`)

  const controlId = graph.value.controller_team
  if (!controlId) {
    return fail('no_controller_team',
      'this graph does not route work through a controller team — every route must start at the team whose only worker is the outer controller')
  }
  const control = graph.value.teams.find((entry) => entry.team_id === controlId)

  const workflow = graph.value.workflows.find((entry) => entry.workflow_id === request.workflow)
  if (!workflow) {
    return fail('unknown_workflow',
      `${String(request.workflow)} is not a declared workflow (${graph.value.workflows.map((entry) => entry.workflow_id).join(', ')})`)
  }

  // Counted through the one function that owns the placement rule, never
  // recounted here: two readers computing "who is holding this" separately is
  // how a board and a controller came to disagree about the same team.
  const { counts } = teamOccupancy(graph.value, readWorkItems(repo).items)
  const held = counts.get(controlId) ?? 0
  if (held >= control.wip_limit) {
    return fail('controller_full',
      `${controlId} is holding ${held} of ${control.wip_limit} — a new request is not admitted while the front door is full.`
      + ' The person may send it again once the queue moves.')
  }

  return appendEvent(repo, {
    event: 'opened',
    work_item: request.work_item,
    workflow: workflow.workflow_id,
    // §4.6: `opened` names the receiving dispatcher, which is now always the
    // controller's intake gate.
    agent_id: control.dispatcher_id,
    to_team: controlId,
    reason: request.reason,
  }, { actor: options.actor })
}

const USAGE = `usage:
  admit.mjs --repo <repo> --work-item <token> --workflow <id> --actor human:<name> --reason <text>

Admits one request through the controller team. Refused while that team is at its
WIP limit — the front door obeys the same rule every other handoff obeys.`

const flag = (args, name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function main(argv) {
  const args = argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return args.length ? 0 : 2
  }
  const result = admitWorkItem(flag(args, '--repo') ?? process.cwd(), {
    work_item: flag(args, '--work-item') ?? '',
    workflow: flag(args, '--workflow') ?? '',
    reason: flag(args, '--reason') ?? '',
  }, { actor: flag(args, '--actor') })

  if (!result.ok) {
    process.stderr.write(`REFUSED  ${result.code}: ${result.detail}\n`)
    return 1
  }
  process.stdout.write(`${result.path}:${result.line}  ${JSON.stringify(result.record)}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
