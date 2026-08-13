// withdraw.mjs — the way OUT for a person, and the exit for a token that bounces.
//
// A person could open a token (`admit.mjs`) and, since 2026-08-07, answer a
// question about one (`answer.mjs`). They could not CLOSE one: `abandoned` was
// written by the runner's clock and by the outer controller, and by nobody
// else. So the one thing an operator watching a token go nowhere could not do
// was stop it — ข้อ 4 forbids hand-editing the ledger, which left `ledger-writer`
// invoked by hand with a JSON literal and the validator's field spec open in
// another window. That is a real thing a real person did.
//
// It is also the sanctioned exit for a token bouncing between two teams (the
// resume-routing defect: a `resumed` can only name the team the escalation came
// from, so a token whose fix lives elsewhere buys +3 legs against the same
// bounce until it hits the ceiling). The other candidate was a route override —
// a `resumed` naming any team — and it was REJECTED: flow through a route is one
// way, and the validator says what to do instead in its own words, "rework is a
// new token on a fresh route". A route override would have made every previously
// held team reachable again, which is the rule `route_went_backwards` exists to
// enforce for `pulled` and which nothing enforces for `resumed`.
//
// So the exit is two honest steps rather than one dishonest one: withdraw the
// token, admit a replacement. This prints the second command with everything it
// already knows filled in, because an exit a person has to reconstruct is not an
// exit.
import { readWorkflowGraph } from './graph.mjs'
import { readWorkItems, currentEntry } from './dispatch-facts.mjs'
import { HARD_TERMINAL_EVENTS } from './ledger-validate.mjs'
import { appendEvent } from './ledger-writer.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const fail = (code, detail) => ({ ok: false, code, detail })

/**
 * Withdraw one token on a person's authority.
 *
 * @param {string} repo
 * @param {{work_item: string, reason: string}} request — `reason` goes on the
 *        record as why a human stopped this, and it is the only field they
 *        supply. It reaches anyone reading the ledger afterwards.
 * @param {{actor: string, relayed_by?: string}} options — `actor` must be
 *        `human:<name>`. Unlike `answered`, the validator does not enforce that
 *        for `abandoned`: the RUNNER writes this event too, and its `actor` is
 *        the runner. This door checks it instead, so a model cannot close
 *        somebody's work while signing as the clock.
 */
export function withdrawWorkItem(repo, request, options = {}) {
  const actor = String(options.actor || '')
  // The name after the colon is checked too: a bare `human:` passes
  // `startsWith` while naming nobody, and "a person decided this" with no
  // person attached is the same unattributed close this door replaced.
  if (!/^human:\S/.test(actor)) {
    return fail('not_a_human',
      `--actor must be human:<name>, not ${actor || 'unset'} — closing work is a person's decision,`
      + ' and the record has to say whose.'
      + ' A model relaying what a person said signs human:<that person> and names itself with --relayed-by.')
  }

  const graph = readWorkflowGraph(repo)
  if (!graph.ok) return fail('graph_invalid', `the declaration cannot be read: ${graph.reason}`)

  const { items } = readWorkItems(repo)
  const item = items.get(request.work_item)
  if (!item) return fail('unknown_token', `${String(request.work_item)} has no ledger in this repo`)

  // `currentEntry`, not the raw tail: a stale outcome from a dead leg can sit
  // after the event that actually holds the token, and reading it would refuse
  // a withdrawal the token genuinely needs.
  const current = currentEntry(item.custody)
  if (current && HARD_TERMINAL_EVENTS.has(current.event)) {
    return fail('already_closed',
      `${request.work_item} is at ${current.event}, which is a hard terminal — nothing may follow it.`
      + ' There is nothing left to withdraw.')
  }
  if (!request.reason) {
    return fail('no_reason',
      'a withdrawal with no reason is the thing this door exists to replace —'
      + ' say what went wrong, because the next person reading the ledger cannot ask')
  }

  const result = appendEvent(repo, {
    event: 'abandoned',
    work_item: request.work_item,
    workflow: item.workflow || null,
    reason: request.reason,
    ...(options.relayed_by ? { relayed_by: options.relayed_by } : {}),
  }, { actor })

  // The second half of the exit. `admit.mjs` needs a token id it cannot guess
  // and a workflow it can: this one's own, which is right for a rework and wrong
  // only when the route itself was the problem — so it is printed as a
  // suggestion to edit, not run for them.
  return result.ok ? { ...result, readmit: readmitCommand(item, repo) } : result
}

const readmitCommand = (item, repo) => `admit.mjs --repo ${repo}`
  + ` --work-item ${item.work_item}-2`
  + ` --workflow ${item.workflow || '<workflow>'}`
  + ' --actor human:<name> --reason "<what the rework has to do differently>"'

const USAGE = `usage:
  withdraw.mjs --repo <repo> --work-item <token> --actor human:<name> --reason <text>
    [--relayed-by agent:<name>]

Closes one token on a person's authority — the half of the operator's job that
had no command. Prints the admit.mjs line for a replacement, because flow
through a route is one way: rework is a new token on a fresh route, never a
resume aimed at a team the token already passed through.`

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

  const result = withdrawWorkItem(flag(args, '--repo') ?? process.cwd(), {
    work_item: flag(args, '--work-item') ?? '',
    reason: flag(args, '--reason') ?? '',
  }, { actor: flag(args, '--actor'), relayed_by: flag(args, '--relayed-by') })

  if (!result.ok) {
    process.stderr.write(`REFUSED  ${result.code}: ${result.detail}\n`)
    return 1
  }
  process.stdout.write(`${result.path}:${result.line}  ${JSON.stringify(result.record)}\n`)
  process.stdout.write(`\nto rework it, admit a replacement:\n  ${result.readmit}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv)
}
