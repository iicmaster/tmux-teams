// answer-the-question.test.mjs — the half of the exchange that was missing.
//
// The loop could ask and never hear back. `questioned` is written in five places,
// the board renders "Waiting on a person to answer", the validator accepts the
// word and `nextStep` knows how to resume from an answer — but **no code in this
// system ever wrote `answered`**, and ข้อ 4 forbids editing a ledger by hand. Every
// token parked on a question was parked permanently, and the answer deadline that
// closes such a token with `abandoned` was standing in for people who could not
// reply at all rather than for people who were slow.
//
// These tests run against a real ledger on disk and go through the sanctioned
// writer, because that is the only path ข้อ 4 allows and the only one that proves
// the line this produces is one the system would accept from anyone else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answerQuestion, openQuestions } from '../plugins/tmux-teams/skills/tmux-teams/scripts/answer.mjs'
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
    // D6 (2026-08-08): every graph declares one. `answer.mjs` resolves the team
    // to resume into from the asking seat, so a controller's own question
    // depends on this team existing — before D6 it fell through to the last
    // `pulled`, which is a guess.
    { team_id: 'control', name: 'Control', dispatcher_id: 'pm_intake', worker_ids: ['pm'], evaluator_id: 'pm_audit', models: MODELS },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'test'] }],
}

const AT = Date.parse('2026-08-07T09:00:00.000Z')

// A repo with a declaration and one token whose history is judged by the
// runtime's own validator before any test sees it.
const repoWith = (events) => {
  const repo = mkdtempSync(join(tmpdir(), 'answer-'))
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

// A worker leg that asked a question mid-route: the shape the runner actually
// produces when it cannot proceed without a person.
const PARKED = [
  { event: 'pulled', agent_id: 'b_d', from_team: 'intake', to_team: 'build' },
  { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
  { event: 'questioned', agent_id: 'b_w1', questions: 'which API key should this use?',
    reason: 'the brief names no credential', question_id: 'q-1', resume_role: 'worker' },
]

test('a person can answer, and the line is one the ledger accepts', () => {
  const repo = repoWith(PARKED)
  const result = answerQuestion(repo, { work_item: 'tok', reason: 'use the staging key' },
    { actor: 'human:ada' })

  assert.equal(result.ok, true, result.detail ?? '')
  const last = ledgerOf(repo).at(-1)
  assert.equal(last.event, 'answered')
  assert.equal(last.actor, 'human:ada')
  assert.equal(last.reason, 'use the staging key')

  // The whole file, not just the new line: an answer that validates alone but
  // breaks the history is not an answer this system could have written.
  assert.equal(validateLedger(ledgerOf(repo)).ok, true)
})

test('the question id and the team to resume into are read off the question', () => {
  const repo = repoWith(PARKED)
  answerQuestion(repo, { work_item: 'tok', reason: 'staging' }, { actor: 'human:ada' })
  const last = ledgerOf(repo).at(-1)

  // Neither was supplied by the caller. Asking a person to restate what the
  // system already knows is how a `question_id_mismatch` gets written by hand.
  assert.equal(last.question_id, 'q-1', 'bound to the open question')
  assert.equal(last.to_team, 'build', "the asking seat's team")
})

test('a token that is not waiting cannot be answered', () => {
  const repo = repoWith([
    { event: 'pulled', agent_id: 'b_d', from_team: 'intake', to_team: 'build' },
    { event: 'assigned', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1' },
  ])
  const result = answerQuestion(repo, { work_item: 'tok', reason: 'anything' }, { actor: 'human:ada' })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_waiting')
  assert.match(result.detail, /assigned/, 'the refusal says what the token is actually at')
})

test('the same question cannot be answered twice', () => {
  const repo = repoWith(PARKED)
  assert.equal(answerQuestion(repo, { work_item: 'tok', reason: 'first' }, { actor: 'human:ada' }).ok, true)
  const second = answerQuestion(repo, { work_item: 'tok', reason: 'again' }, { actor: 'human:ada' })

  // The validator would call a second answer `answered_without_question`; this
  // refuses before writing rather than producing a line the ledger then rejects.
  assert.equal(second.ok, false)
  assert.equal(second.code, 'not_waiting')
})

test('a model may relay, and may not sign as the person', () => {
  const repo = repoWith(PARKED)
  const relayed = answerQuestion(repo, { work_item: 'tok', reason: 'ada says staging' },
    { actor: 'human:ada', relayed_by: 'agent:pm' })
  assert.equal(relayed.ok, true, relayed.detail ?? '')
  assert.equal(ledgerOf(repo).at(-1).relayed_by, 'agent:pm')

  // The one rule the actor field exists for: a model signing as itself would put
  // its own opinion on the record as a person's decision.
  const forged = answerQuestion(repoWith(PARKED), { work_item: 'tok', reason: 'I decided' },
    { actor: 'agent:pm' })
  assert.equal(forged.ok, false, 'a model may not answer as itself')
})

test('an answer with no words is refused, because that text IS the answer', () => {
  // `reason` is not metadata here: `composeBrief` puts it in front of the seat
  // that asked, verbatim, as the whole of what the person said. An empty one
  // resumes the leg with a blank where the decision should be — which is how a
  // dispatcher gets to ask the same question again on the next tick.
  // `withdraw.mjs` refused an empty reason from its first commit; this door did
  // not, and an outside reviewer named the asymmetry.
  const result = answerQuestion(repoWith(PARKED), { work_item: 'tok', reason: '' },
    { actor: 'human:ada' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_reason')
})

test('an unknown token is refused rather than created', () => {
  const result = answerQuestion(repoWith(PARKED), { work_item: 'no-such-token', reason: 'x' },
    { actor: 'human:ada' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unknown_token')
})

test('an operator can see what is owed before answering it', () => {
  const repo = repoWith(PARKED)
  const waiting = openQuestions(repo)

  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].work_item, 'tok')
  assert.equal(waiting[0].asked_by, 'b_w1')
  assert.match(waiting[0].questions, /API key/, 'the question text, not a placeholder')

  answerQuestion(repo, { work_item: 'tok', reason: 'staging' }, { actor: 'human:ada' })
  assert.equal(openQuestions(repo).length, 0, 'an answered question is no longer owed')
})
