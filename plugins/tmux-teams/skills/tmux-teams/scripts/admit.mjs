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
import { resolve, join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const fail = (code, detail) => ({ ok: false, code, detail })

/**
 * Admit one request through the controller team.
 *
 * @param {string} repo
 * @param {{work_item: string, workflow: string, reason: string}} request
 * @param {{actor: string, relayed_by?: string}} options — `actor` must be
 *        `human:<name>` even when an agent relays it: the actor names who
 *        DECIDED, and the person decided (ข้อ 6.4.1, ADR 0002). Enforced by
 *        `ledger-validate.mjs`'s `opened.actor_kind`, not merely documented
 *        here — a non-human actor is refused by `appendEvent` below. An agent
 *        relaying the words names itself in `relayed_by` instead of the
 *        person, so the relay's own identity is on record without it being
 *        mistaken for the decision.
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

  // Counted through the one place that owns the rule, never recounted here: two
  // readers computing "who is holding this" separately is how a board and a
  // controller came to disagree about the same team.
  //
  // That place is now the `team` subscriber rather than a derivation over
  // custody, and the difference is the whole point. A derivation cannot HOLD
  // anything, so a finished-but-unaudited delivery and an escalation both
  // occupied nobody, control's single slot sat empty while work was stuck, and
  // the front door stayed open — which is why eight timers and counters grew in
  // loop-runner.mjs where the stop mechanism should be. With the accounting,
  // control holds what it owes a verdict on, and a full front door is the alarm
  // the owner described: the system stops instead of admitting more work to get
  // stuck later, somewhere else.
  const { counts } = teamOccupancy(graph.value, readWorkItems(repo).items)
  const held = counts.get(controlId) ?? 0
  if (held >= control.wip_limit) {
    return fail('controller_full',
      `${controlId} is holding ${held} of ${control.wip_limit} — a new request is not admitted while the front door is full.`
      + ' The person may send it again once the queue moves.')
  }

  const result = appendEvent(repo, {
    event: 'opened',
    work_item: request.work_item,
    workflow: workflow.workflow_id,
    // ข้อ 4.6: `opened` names the receiving dispatcher, which is now always the
    // controller's intake gate.
    agent_id: control.dispatcher_id,
    to_team: controlId,
    reason: request.reason,
    // Present only when an agent is relaying, so a person typing this
    // themselves leaves no relay identity to be mistaken for a second actor.
    ...(options.relayed_by ? { relayed_by: options.relayed_by } : {}),
  }, { actor: options.actor })

  // H2 (retro-release-review, 2026-08-04): `composeBrief` (loop-runner.mjs)
  // reads the token's request from `.tmux-teams/work-items/<token>.md` — "the
  // token's own request" per the contract — but nothing ever created that
  // file. Admission stored `request.reason` in the ledger and stopped there,
  // so following the documented admit path alone sent every later seat a
  // token with no request to judge, unless someone independently authored the
  // same file by hand. Write it here, from the one thing every successful
  // admission already has, only after the ledger accepted the token — a
  // refused admission must not leave an orphaned request file behind. Only
  // when the file is not already there: an operator who authored a richer
  // request by hand before calling this keeps it — this is a floor, not an
  // override.
  if (result.ok) {
    const requestPath = join(repo, '.tmux-teams', 'work-items', `${request.work_item}.md`)
    if (!existsSync(requestPath)) {
      mkdirSync(dirname(requestPath), { recursive: true })
      writeFileSync(requestPath, `${request.reason || ''}\n`)
    }
  }
  return result
}

const USAGE = `usage:
  admit.mjs --repo <repo> --work-item <token> --workflow <id> --actor human:<name> --reason <text>
    [--relayed-by agent:<name>]

Admits one request through the controller team. Refused while that team is at its
WIP limit — the front door obeys the same rule every other handoff obeys.
--actor must be human:<name> (ADR 0002) — an agent relaying the person's words
names itself with --relayed-by instead of borrowing the person's identity.`

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
  }, { actor: flag(args, '--actor'), relayed_by: flag(args, '--relayed-by') })

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
