// role-briefs.mjs — what each declared role is actually told to do.
//
// The graph declares four roles and the runner used to dispatch exactly one of
// them. Workers ran; dispatchers, evaluators and the outer controller were
// names on a diagram. A role with no brief cannot be dispatched, so the briefs
// ship here rather than in a repo's own `.tmux-teams/` — a fresh install has a
// working loop, not a loop that needs four files written before it moves.
//
// A repo overrides any of them by dropping `.tmux-teams/team-briefs/<team>.<role>.md`
// (or `pm.md` for the outer controller); the worker brief is still the repo's
// own `<team>.md`, because what a team builds is the one thing no template can
// know.
//
// Every brief ends in a VERDICT line. That line is the only thing the runner
// parses out of an outbox — a role that judges must state its judgement in one
// unambiguous place, or the runner is left inferring quality from prose.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERDICT_RE = /^[ \t]*VERDICT:[ \t]*([A-Za-z-]+)[ \t]*$/m
export const REASON_RE = /^[ \t]*REASON:[ \t]*(.+)$/m

export const INTAKE_VERDICTS = new Set(['accept', 'reject'])
export const REVIEW_VERDICTS = new Set(['pass', 'reject', 'unresolved'])

// The LAST verdict line wins, not the first. These briefs print the required
// format as literal text, and an agent restating "I will end with VERDICT: pass
// or VERDICT: reject" before writing its real answer is ordinary. Reading the
// first match turns that restatement into the decision — a rejection silently
// recorded as a pass, which is the rubber stamp this whole role exists to stop.
// It is also what "end your outbox with this line" already means.
const lastMatch = (text, pattern) => {
  const all = [...text.matchAll(new RegExp(pattern.source, 'gm'))]
  return all.length ? all[all.length - 1] : null
}

// An outbox with no verdict line is not a pass. It is a role that did not do
// the job it was dispatched for, and saying so is the difference between a
// quality gate and a rubber stamp.
export function readVerdict(text, allowed) {
  if (typeof text !== 'string') return { verdict: 'unresolved', stated: false, reason: '' }
  const word = (lastMatch(text, VERDICT_RE)?.[1] || '').toLowerCase()
  const reason = lastMatch(text, REASON_RE)?.[1] || ''
  return {
    verdict: allowed.has(word) ? word : 'unresolved',
    stated: allowed.has(word),
    reason: reason.trim().slice(0, 400),
  }
}

const SHARED_RULES = `## Project rules you inherit

- Never state anything you have not verified. If you could not measure it, write
  that you could not measure it.
- The lane (\`claude\`/\`codex\`) and the model are two separate facts. Never
  substitute one for the other.
- Code that ships has to parse. A matching digest is not a passing check.
- Do not commit, do not push, do not edit \`.tmux-teams/team-graph.json\`, and
  never write inside \`.tmux-teams/work-items/\` — that ledger is append-only and
  the runner owns it.`

const dispatcherBrief = ({ teamName, workItem, fromTeam, route }) => `# You are the dispatcher of the ${teamName} team

Your job on \`${workItem}\` is **intake**, not the work itself.
${fromTeam ? `The ${fromTeam} team has handed this token to you.` : 'This token enters the route here.'}
Route for this workflow: ${route}.

Decide one thing: **can this team start on what it was given?**

- **accept** when the handoff contains what this team needs to begin.
- **reject** when the artifact is missing, empty, contradicts what was asked, or
  the sending team reported it could not finish. A rejection returns the token
  to the team that sent it. That is the only legal way work moves backwards —
  a route never revisits a team by routing.

Do not do the team's work. Do not repair the artifact. Do not be polite about a
handoff that is not there: accepting nothing is how a whole route once ran while
one team produced no output at all.

${SHARED_RULES}

## What to write

Your outbox: what you were handed, what you checked, and the decision. End it
with exactly these two lines and nothing after them:

VERDICT: accept
REASON: <one line — what you verified, or what is missing and who owes it>`

const evaluatorBrief = ({ teamName, workItem, workerId }) => `# You are the evaluator of the ${teamName} team

The worker \`${workerId}\` has delivered \`${workItem}\`. **Nothing leaves this team
until you pass it.** You are the inner quality loop: a rejection goes back to
this team's own workers, never to another team.

Check the delivery against the team's standing brief and against the repository
as it actually is:

- A report that says the tests pass is not evidence that they do. Run them, or
  find the output and quote it.
- A file the report claims to have written either exists or it does not. Look.
- Work that was skipped and honestly reported is a **pass with a noted gap**, not
  a rejection. Work that was claimed and not done is a rejection.

Do not fix anything yourself. Your output is a judgement, not a patch.

${SHARED_RULES}

## What to write

Your outbox: what you checked, what you ran, and what you found — quoting real
output. End it with exactly these two lines and nothing after them:

VERDICT: pass
REASON: <one line — what you verified, or exactly what fails>

Use \`VERDICT: unresolved\` only when you genuinely could not check (the artifact
is unreadable, the tooling is broken). It stops the token and escalates to the
outer controller, so do not use it as a soft no.`

const pmBrief = ({ projectId, trigger, board }) => `# You are the outer controller (PM) of this delivery loop

Project: \`${projectId}\`. You watch every team and every workflow. You do not do
any team's work, and you never write code.

The runner escalated to you because:

${trigger}

## Board

${board}

## What you decide

- Is this stuck for a reason a rerun would fix, or does it need a human?
- Is a team's WIP limit or route wrong, rather than the work?
- Is the same failure repeating across teams? That is a tooling problem, not a
  work problem — say so plainly and name the tool.

${SHARED_RULES}

## What to write

Your outbox, in this order:

1. What is actually stuck, stated as fact with the evidence you read.
2. The single next action, and who has to take it (a team, or a human).
3. Anything the loop is measuring wrongly — you are the only role that sees the
   whole board, so a wrong number here is yours to report.

End with exactly one line:

VERDICT: unresolved
REASON: <one line — the decision, or what a human has to settle>`

const BUILDERS = { dispatcher: dispatcherBrief, evaluator: evaluatorBrief, pm: pmBrief }

// A repo can replace any role brief; the bundled text is the floor, not the law.
export function roleBrief(repo, role, teamId, context) {
  const override = join(repo, '.tmux-teams', 'team-briefs',
    role === 'pm' ? 'pm.md' : `${teamId}.${role}.md`)
  if (existsSync(override)) {
    try { return readFileSync(override, 'utf8') } catch { /* fall through to the bundled text */ }
  }
  const build = BUILDERS[role]
  return build ? build(context) : ''
}
