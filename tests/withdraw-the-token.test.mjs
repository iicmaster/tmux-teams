// withdraw-the-token.test.mjs — the operator could open and answer, never close.
//
// `abandoned` was written by the runner's clock and by the outer controller, and
// by nobody else. A person watching a token go nowhere had no command for it:
// ข้อ 4 forbids hand-editing a ledger, so the documented workaround was invoking
// `ledger-writer.mjs` with a JSON literal and the validator's field spec open in
// another window. Somebody really did that.
//
// It is also the sanctioned exit for a token bouncing between two teams. A route
// override — a `resumed` naming any team — was the other candidate and was
// rejected: flow through a route is one way, and `route_went_backwards` enforces
// that for `pulled` while nothing enforces it for `resumed`, so an override
// would have quietly reopened every team the token had already passed through.
// The validator states the alternative in its own words: rework is a new token
// on a fresh route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withdrawWorkItem } from '../plugins/tmux-teams/skills/tmux-teams/scripts/withdraw.mjs'
import { validateLedger } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'
import { gateHistory } from './fixture-gate.mjs'

const MODELS = { dispatcher: 'test-model', worker: 'test-model', evaluator: 'test-model' }
const GRAPH = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'test-model',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1'], evaluator_id: 'b_e', models: MODELS },
    { team_id: 'test', name: 'Test', dispatcher_id: 't_d', worker_ids: ['t_w1'], evaluator_id: 't_e', models: MODELS },
    { team_id: 'control', name: 'Control', dispatcher_id: 'pm_intake', worker_ids: ['pm'], evaluator_id: 'pm_audit', models: MODELS },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'test'] }],
}

// Safely in the PAST: the writer refuses a line stamped earlier than the one
// above it, and it stamps with the real clock — a fixture dated today can sit in
// the future and refuse the very append the test is about.
const AT = Date.parse('2026-08-06T09:00:00.000Z')

// Every history is judged by the runtime's own validator before a test sees it.
const repoWith = (events) => {
  const repo = mkdtempSync(join(tmpdir(), 'withdraw-'))
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(join(repo, '.tmux-teams', 'graph.json'), JSON.stringify(GRAPH))
  const custody = gateHistory('tok', events.map((event, index) => ({
    at: new Date(AT - (events.length - 1 - index) * 60_000).toISOString(),
    work_item: 'tok', workflow: 'feature', ...event,
  })))
  writeFileSync(join(repo, '.tmux-teams', 'work-items', 'tok.jsonl'),
    `${custody.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return repo
}

const ledgerOf = (repo) => readFileSync(join(repo, '.tmux-teams', 'work-items', 'tok.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))

// The shape the resume-routing defect produces: escalated to the controller,
// which can only ever resume it back to the team it came from.
const BOUNCING = [
  { event: 'pulled', agent_id: 'b_d', from_team: 'intake', to_team: 'build' },
  { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
  { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  { event: 'escalated', agent_id: 'pm', to_team: 'build', task_id: 'pm-1', reason: 'this keeps coming back' },
]

test('a person can close a token, and the line is one the ledger accepts', () => {
  const repo = repoWith(BOUNCING)
  const result = withdrawWorkItem(repo, { work_item: 'tok', reason: 'the fix belongs to another team' },
    { actor: 'human:ada' })

  assert.equal(result.ok, true, result.detail ?? '')
  const last = ledgerOf(repo).at(-1)
  assert.equal(last.event, 'abandoned')
  assert.equal(last.actor, 'human:ada')
  assert.equal(last.reason, 'the fix belongs to another team')

  // The whole file, not just the new line: a close that validates alone but
  // breaks the history is not one this system could have written.
  assert.equal(validateLedger(ledgerOf(repo)).ok, true)
})

test('closing prints the command that reopens the work, because half an exit is not one', () => {
  const repo = repoWith(BOUNCING)
  const result = withdrawWorkItem(repo, { work_item: 'tok', reason: 'wrong team' }, { actor: 'human:ada' })

  // The entire reason this design was chosen over a route override: the person
  // is not left holding a closed token and a blank prompt. The workflow comes
  // off the token, which is what makes it a suggestion worth reading.
  assert.match(result.readmit, /admit\.mjs/)
  assert.match(result.readmit, /--workflow feature/)
  assert.match(result.readmit, /--actor human:/)
})

test('a model may relay a person, and may not close work as itself', () => {
  const relayed = withdrawWorkItem(repoWith(BOUNCING), { work_item: 'tok', reason: 'ada says stop' },
    { actor: 'human:ada', relayed_by: 'agent:pm' })
  assert.equal(relayed.ok, true, relayed.detail ?? '')

  // `abandoned` carries no `actor_kind` in the validator, because the RUNNER
  // writes it too and signs as itself. So this door checks — otherwise a model
  // could close somebody's work while wearing the clock's identity.
  const forged = withdrawWorkItem(repoWith(BOUNCING), { work_item: 'tok', reason: 'I decided' },
    { actor: 'agent:pm' })
  assert.equal(forged.ok, false)
  assert.equal(forged.code, 'not_a_human')
})

test('a token that is already closed cannot be closed again', () => {
  const repo = repoWith([...BOUNCING,
    { event: 'abandoned', reason: 'already withdrawn', actor: 'human:ada' }])
  const result = withdrawWorkItem(repo, { work_item: 'tok', reason: 'again' }, { actor: 'human:ada' })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'already_closed')
  assert.match(result.detail, /hard terminal/)
})

test('a human actor has to name a human', () => {
  // `human:` with nothing after it passes `startsWith` and names nobody. The
  // record then says a person decided this, with no person attached — the same
  // unattributed close the hand-written-JSON workaround produced, which is what
  // this door exists to replace. Found by an outside reviewer reading the diff.
  for (const actor of ['human:', 'human: ']) {
    const result = withdrawWorkItem(repoWith(BOUNCING), { work_item: 'tok', reason: 'stop' }, { actor })
    assert.equal(result.ok, false, `${JSON.stringify(actor)} named nobody and was accepted`)
    assert.equal(result.code, 'not_a_human')
  }
  // And the refusal has to say what is missing, not just that something is.
  const refused = withdrawWorkItem(repoWith(BOUNCING), { work_item: 'tok', reason: 'stop' },
    { actor: 'human:' })
  assert.match(refused.detail, /whose/)
})

test('the replacement command names the repo it was run against', () => {
  // It printed the literal placeholder `--repo <repo>` while the repo was the
  // door's own first argument — an exit the operator still had to finish
  // assembling. It also carries the token id, which the earlier assertions did
  // not pin at all, so a regression there would have shipped silently.
  const repo = repoWith(BOUNCING)
  const result = withdrawWorkItem(repo, { work_item: 'tok', reason: 'wrong team' }, { actor: 'human:ada' })
  assert.equal(result.readmit.includes('<repo>'), false, 'the door knows the repo; it must not ask for it')
  assert.ok(result.readmit.includes(`--repo ${repo}`), result.readmit)
  assert.ok(result.readmit.includes('--work-item tok-2'), result.readmit)
})

test('a withdrawal with no reason is refused, because nobody can ask later', () => {
  const result = withdrawWorkItem(repoWith(BOUNCING), { work_item: 'tok', reason: '' }, { actor: 'human:ada' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_reason')
})

test('an unknown token is refused rather than created', () => {
  const result = withdrawWorkItem(repoWith(BOUNCING), { work_item: 'no-such-token', reason: 'x' },
    { actor: 'human:ada' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unknown_token')
})

test('a finished token waiting on its audit can still be withdrawn', () => {
  // `completed` is not a hard terminal — the audit path deliberately allows
  // events after it — and this is the state the answer deadline used to destroy
  // tokens in. A person must be able to close one deliberately, on the record,
  // rather than waiting for a clock to do it with a reason of its own choosing.
  const repo = repoWith([
    { event: 'pulled', agent_id: 'b_d', from_team: 'intake', to_team: 'build' },
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
    { event: 'delivered', agent_id: 'b_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
    { event: 'completed', from_team: 'build' },
    { event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1', reason: 'read the finished route' },
  ])
  const result = withdrawWorkItem(repo, { work_item: 'tok', reason: 'the requester withdrew it' },
    { actor: 'human:ada' })

  assert.equal(result.ok, true, result.detail ?? '')
  assert.equal(validateLedger(ledgerOf(repo)).ok, true)
})
