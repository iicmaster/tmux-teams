// pull-controller.mjs — the WIP limit and the pull system, enforced.
//
// Until now the board drew a WIP limit and a pull arrow; nothing stopped work
// being pushed past either. This is the mechanism: it never hands work to a
// team, it only lets a team TAKE work it has room for.
//
// One pass over the token ledgers:
//   a token whose last event is `reviewed` with verdict `pass` has cleared its
//   own team's evaluator and is sitting in that team's done queue
//   → check that the token's own history can be believed at all
//   → find the next team on its workflow route
//   → if that team is under its WIP limit, append `pulled` (it took the work)
//   → if it is at the limit, leave the token where it is and report it blocked
//   → if there is no next team, the route is finished: append `completed`
//
// Nothing is ever appended on behalf of a team that has no room. A blocked
// token stays visibly blocked, because a queue backing up is the signal the
// whole board exists to show — hiding it by pushing anyway is the failure this
// file prevents.
//
// The ledger check is the same idea one layer down. A handoff carries no
// artifact of its own: what the receiving team actually inherits is the token's
// recorded history, and every later reader — intake, the board, the outer
// controller's audit — answers from it. Handing on a history that describes
// something impossible is the same class of mistake as handing on a delivery
// that never happened, which the failed-leg check below already refuses.
import { validateLedgerTolerant } from './ledger-validate.mjs'
import { appendEvent } from './ledger-writer.mjs'
import { currentEntry, readWorkItems, teamOccupancy } from './dispatch-facts.mjs'
import { readWorkflowGraph } from './graph.mjs'

// Every line this file puts in a ledger names the same writer. The pull
// controller is the thing that decided and recorded it; the receiving
// dispatcher named in `agent_id` is who the pull was made FOR. Signing the line
// as the dispatcher would claim a write that agent never performed, and the
// whole point of an actor is that it stays true forever.
const PULL_ACTOR = 'agent:pull-controller'

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
    // The same entry `teamOccupancy` places by. This loop can append `pulled`,
    // so reading a superseded leg here does not merely draw the token in the
    // wrong column — it writes a handoff naming a team that is not holding it.
    const last = currentEntry(item.custody)
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
    // Two ways a team releases work, and they are different events because they
    // are different claims.
    //
    // A delivery team releases on `reviewed` `pass`: its evaluator checked the
    // artifact. The controller team releases on `intake` `accept`: there is no
    // artifact yet — admission is the claim that the request is workable, and
    // that is exactly what its dispatcher's gate decides. Requiring a review
    // there would mean reviewing work nobody has done.
    const admitted = last.event === 'intake' && last.verdict === 'accept'
      && team.team_id === graph.controller_team
    if (!admitted && (last.event !== 'reviewed' || last.verdict !== 'pass')) continue

    // GitHub #31 stage 2: a `produces: verdict` team's evaluator can pass its
    // OWN verdict (the worker judged the target correctly) while stating
    // `target_verdict: reject` (the target itself is not done). role-
    // briefs.mjs tells that seat the rejection "must not hand onward" — pulling
    // it forward exactly like an ordinary `reviewed pass` would make that
    // instruction a declaration that says nothing, which house rule forbids.
    // It stays visibly held, the same way an invalid ledger stays visibly
    // blocked instead of being handed on quietly (retro-release-review,
    // 2026-08-04, H3).
    if (!admitted && last.target_verdict === 'reject') {
      decisions.push({
        work_item: item.work_item, action: 'target_rejected', from_team: team.team_id,
        reason: last.target_reason || 'the evaluator confirmed the work under review is not done',
      })
      continue
    }

    // The whole verdict, not a chosen subset of it. `ledger-writer.appendEvent`
    // refuses outright to append to a ledger that does not validate, so a
    // planner working from a laxer rule would keep emitting a pull the writer
    // can never record — the loop would print the same handoff every tick while
    // nothing moved, which is indistinguishable from a runner that has quietly
    // given up. Plan and apply have to answer to the same predicate.
    //
    // `custody` is what the rest of the loop can actually see: already parsed,
    // already sorted by `at`, with unparsable lines dropped by readWorkItems.
    // Judging those bytes is the point — a verdict about lines no reader parses
    // is not a verdict about this system. The raw file is checked again by the
    // writer at append time, so a defect only the file shows still stops the
    // write; it surfaces as a refusal rather than as a plan.
    //
    // Tolerant, not raw: B5 (2026-08-04) found that a ledger which
    // `ledger-writer.mjs` had regained the ability to APPEND to — because its
    // only problems were the two the amendment made legacy-tolerated — still
    // could not be PULLED here, because this file called `validateLedger`
    // straight and required `ok` with no concept of tolerance at all. A token
    // could be answered or abandoned but never handed to the next team.
    // `validateLedgerTolerant` is the one place that judgment is made, shared
    // with the writer, so the two can no longer drift apart on the same
    // question the way they just did.
    const verdict = validateLedgerTolerant(item.custody.map((entry) => JSON.stringify(entry)))
    if (!verdict.ok) {
      const [first] = verdict.blocking
      decisions.push({
        work_item: item.work_item, action: 'invalid', from_team: team.team_id,
        reason: `its ledger has ${verdict.blocking.length} problem(s) and cannot be handed on — line ${first.line} ${first.code}: ${first.detail}`,
        // Every BLOCKING problem travels with the decision — legacy-tolerated
        // ones are excluded because they are not what an operator needs to
        // repair. The validator reports them all on purpose, and a repair
        // against one line at a time is a game of whack-a-mole against a file
        // nobody is allowed to rewrite.
        problems: verdict.blocking,
      })
      continue
    }
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

// A refusal is the operator's cue to go and repair a ledger, and this is the
// only place that cue exists — loop-runner calls applyPulls without looking at
// what came back, so a refusal swallowed here is a token that stops moving with
// nobody told why.
const reportRefusal = (decision, result) => {
  process.stderr.write(`[pull] REFUSED ${decision.work_item}: ${result.code} — ${result.detail}\n`)
}

export function applyPulls(repo, decisions, onRefusal = reportRefusal) {
  let written = 0
  for (const decision of decisions) {
    if (!decision.event) continue
    // Through the writer, never straight to the file: it stamps the actor,
    // checks the event against contract §4, and refuses to append to a history
    // that is already broken — which is the same gate planPulls applied, now
    // re-run against the bytes on disk rather than the parsed projection.
    const result = appendEvent(repo, decision.event, { actor: PULL_ACTOR })
    if (!result.ok) {
      // The outcome rides home on the decision itself. A count cannot say WHICH
      // handoff was refused, and the caller narrates this same array one loop
      // later — so without this the runner reports a refused pull in the words
      // it uses for a written one, which §4.2 forbids outright.
      decision.write_result = result
      onRefusal(decision, result)
      continue
    }
    written += 1
  }
  return written
}

const describe = (decision) => {
  switch (decision.action) {
    case 'pull':
      return `pull    ${decision.work_item}: ${decision.from_team} -> ${decision.to_team} (${decision.workflow})`
    case 'complete':
      return `done    ${decision.work_item}: finished ${decision.workflow} at ${decision.from_team}`
    case 'blocked':
      return `BLOCK   ${decision.work_item}: ${decision.from_team} -> ${decision.to_team} — ${decision.reason}`
    case 'failed':
      return `FAILED  ${decision.work_item}: ${decision.reason}`
    case 'invalid':
      return `INVALID ${decision.work_item}: ${decision.reason}`
    default:
      return `skip    ${decision.work_item}: ${decision.reason}`
  }
}

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
  for (const decision of decisions) {
    console.log(`[pull] ${describe(decision)}`)
    // The headline names one problem so the line stays readable; a repair needs
    // the whole list, so the whole list is printed under it.
    for (const problem of decision.problems ?? []) {
      console.log(`[pull]         line ${problem.line}  ${problem.code}  ${problem.detail}`)
    }
  }
  if (args.includes('--apply')) {
    // r6-codex: this printed "appended 0 custody events" and exited 0 when
    // every pull was refused — a `locked` ledger, a history that cannot be
    // believed, any of it — so a script driving this could not tell a quiet
    // success from a total failure. A count is not a status.
    // Per decision, not per count. r7-codex: comparing `planned` against
    // `applyPulls`'s total compared two different things — that total counts
    // EVERY decision carrying an event, so one unrelated write landing while
    // the only planned pull was refused made the numbers agree and the exit
    // code lie. `applyPulls` stamps `write_result` on the decision it refused,
    // so ask each planned pull whether IT was recorded.
    const plannedPulls = decisions.filter((decision) => decision.action === 'pull')
    console.log(`[pull] appended ${applyPulls(repo, decisions)} custody events`)
    const unrecorded = plannedPulls.filter((decision) =>
      !decision.event || (decision.write_result && !decision.write_result.ok))
    if (unrecorded.length > 0) {
      console.error(`[pull] ${unrecorded.length} of ${plannedPulls.length} planned pull(s) were REFUSED and not recorded`)
      for (const decision of unrecorded) {
        console.error(`[pull]         ${decision.work_item}: ${decision.write_result?.code ?? 'no event to write'}`)
      }
      process.exit(1)
    }
  } else {
    console.log('[pull] dry run — pass --apply to record these pulls')
  }
}
