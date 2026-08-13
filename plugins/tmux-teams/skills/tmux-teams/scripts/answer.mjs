// answer.mjs — the way back in for a person the system stopped to ask.
//
// The loop has always been able to ASK. `questioned` is produced in five places
// (`loop-runner.mjs`), the board renders "Waiting on a person to answer"
// (`kanban.mjs`), the validator accepts the word, and `nextStep` knows how to
// resume from an answer. Every half of the exchange existed except the half
// where a person speaks: **nothing in this system wrote `answered`.** A token
// parked on a question was parked for good, unless somebody edited the ledger by
// hand — which ข้อ 4 forbids, since every line must come through the sanctioned
// writer.
//
// That absence is why the deadline exists. `ANSWER_DEADLINE_SEC` closes an
// unanswered question with `abandoned`, and it reads like a guard against slow
// humans; it was standing in for humans who could not reply at all. This file is
// the missing half, and it is deliberately the smallest thing that closes the
// loop: no new event word, no state-machine change, no contract amendment —
// `answered` already means exactly this.
//
// Shaped after `admit.mjs`, the only other door a person walks through, so the
// two read the same and are refused the same way.
import { readWorkflowGraph } from './graph.mjs'
import { readWorkItems, currentEntry } from './dispatch-facts.mjs'
import { appendEvent } from './ledger-writer.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const fail = (code, detail) => ({ ok: false, code, detail })

/** The last entry of a given event word, or null. */
const lastOf = (custody, event) => {
  for (let i = custody.length - 1; i >= 0; i -= 1) if (custody[i].event === event) return custody[i]
  return null
}

/**
 * Answer the open question on one token.
 *
 * @param {string} repo
 * @param {{work_item: string, reason: string}} reply — `reason` is what the
 *        person actually said; it reaches the next seat's brief verbatim
 *        (`loop-runner.mjs`'s "A person just answered a question about this
 *        token").
 * @param {{actor: string, relayed_by?: string}} options — `actor` must be
 *        `human:<name>`. The validator enforces it (`answered.actor_kind`), not
 *        just this comment: a model signing as itself would be recording its own
 *        opinion as a person's decision. A model relaying words a person said
 *        signs `human:` and names ITSELF in `relayed_by`.
 */
export function answerQuestion(repo, reply, options = {}) {
  const graph = readWorkflowGraph(repo)
  if (!graph.ok) return fail('graph_invalid', `the declaration cannot be read: ${graph.reason}`)

  const { items } = readWorkItems(repo)
  const item = items.get(reply.work_item)
  if (!item) return fail('unknown_token', `${String(reply.work_item)} has no ledger in this repo`)

  // `currentEntry` rather than the raw tail: a stale outcome from a dead leg can
  // sit after the question, and the raw tail would read that instead and refuse
  // an answer the token is genuinely waiting for.
  const current = currentEntry(item.custody)
  if (!current || current.event !== 'questioned') {
    return fail('not_waiting',
      `${reply.work_item} is at ${current?.event ?? 'nothing'}, not questioned — there is no open question to answer.`
      + ' A question that was already answered, withdrawn or abandoned cannot be answered again.')
  }

  // Both fields the answer needs are already on the question. Asking a person to
  // supply them by hand would be asking them to restate what the system knows,
  // and a wrong `question_id` is refused by the validator anyway — so deriving
  // is not a convenience, it is the only way this cannot be got wrong.
  if (!reply.reason) {
    return fail('no_reason',
      'an answer with no words is not an answer — this text reaches the seat that asked,'
      + ' verbatim, as the whole of what the person said')
  }

  const questionId = current.question_id
  if (!questionId) {
    return fail('question_has_no_id',
      'the open question carries no question_id, so an answer cannot be bound to it')
  }

  // Where the work goes back to. The asking seat's team is the answer, and it is
  // resolved through the declaration rather than guessed from the ledger: an
  // agent that is not a declared team member (the outer controller on a graph
  // without a control team) has no team to resume into, and that must be a
  // refusal rather than a blank field the validator would reject later with a
  // less useful message.
  const teamOf = new Map()
  for (const team of graph.value.teams) for (const agent of team.agents) teamOf.set(agent.agent_id, team.team_id)
  const toTeam = teamOf.get(current.agent_id) ?? lastOf(item.custody, 'pulled')?.to_team ?? null
  if (!toTeam) {
    return fail('no_team_to_resume',
      `the question was asked by ${current.agent_id ?? 'an unnamed seat'}, which belongs to no declared team,`
      + ' and this token has never been pulled — so there is nowhere to send the answer back to')
  }

  return appendEvent(repo, {
    event: 'answered',
    work_item: reply.work_item,
    workflow: item.workflow || null,
    to_team: toTeam,
    question_id: questionId,
    reason: reply.reason,
    ...(options.relayed_by ? { relayed_by: options.relayed_by } : {}),
  }, { actor: options.actor })
}

const USAGE = `usage:
  answer.mjs --repo <repo> --work-item <token> --actor human:<name> --reason <text>
    [--relayed-by agent:<name>]
  answer.mjs --repo <repo> --list

Answers the open question on one token. The question id and the team to resume
into are read off the question itself — a person only supplies the answer.
--actor must be human:<name>: a model relaying what a person said names itself
with --relayed-by instead of borrowing the person's identity.`

const flag = (args, name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/** Every token currently waiting on a person, so the operator can see what is owed. */
export function openQuestions(repo) {
  const { items } = readWorkItems(repo)
  const waiting = []
  for (const [workItem, item] of items) {
    const current = currentEntry(item.custody)
    if (current?.event === 'questioned') {
      waiting.push({ work_item: workItem, asked_by: current.agent_id, at: current.at, questions: current.questions })
    }
  }
  return waiting
}

function main(argv) {
  const args = argv.slice(2)
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return args.length ? 0 : 2
  }
  const repo = flag(args, '--repo') ?? process.cwd()

  if (args.includes('--list')) {
    const waiting = openQuestions(repo)
    if (!waiting.length) { process.stdout.write('no token is waiting on a person\n'); return 0 }
    for (const w of waiting) {
      process.stdout.write(`${w.work_item}\t${w.at}\tasked by ${w.asked_by}\n  ${w.questions}\n`)
    }
    return 0
  }

  const result = answerQuestion(repo, {
    work_item: flag(args, '--work-item') ?? '',
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
