// ledger.test.mjs — the custody ledger is evidence, so these tests are about
// what may NOT get into it.
//
// Contract §4 says what each event carries and §5 says what may follow what.
// Both were previously enforced by nothing at all: the ledger is a JSONL file
// and `>>` is a shell builtin. Two `abandoned` events in this repo were typed by
// hand for exactly that reason, and nothing in either line says so.
//
// Every writer test runs against a throwaway repo under `mkdtemp`. The real
// `.tmux-teams/work-items/` is read-only here — appending to it would be the
// very thing this change exists to stop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendEvent, ledgerPath } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { validateLedger, validateLedgerFile } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRITER = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs')
const VALIDATOR = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs')

const jsonl = (...events) => events.map((event) => JSON.stringify(event))
const codes = (result) => result.problems.map((problem) => problem.code)

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A whole route the way the runner actually records one: intake at the door,
// a worker leg, the team's own evaluator, a handoff pull, then the close and
// the outer controller's read of the delivery.
const FULL_ROUTE = jsonl(
  { at: '2026-07-27T10:00:00.000Z', event: 'pulled', work_item: 'tok', workflow: 'feature', agent_id: 'design_dispatcher', from_team: 'intake', to_team: 'design' },
  { at: '2026-07-27T10:00:01.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_dispatcher', task_id: 't1', dispatch_id: 'd1' },
  { at: '2026-07-27T10:05:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'design_dispatcher', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-07-27T10:05:01.000Z', event: 'intake', work_item: 'tok', workflow: 'feature', agent_id: 'design_dispatcher', verdict: 'accept', reason: 'brief matches the request' },
  { at: '2026-07-27T10:05:02.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_w1', task_id: 't2', dispatch_id: 'd2' },
  { at: '2026-07-27T10:20:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'design_w1', task_id: 't2', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-07-27T10:20:01.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 't3', dispatch_id: 'd3' },
  { at: '2026-07-27T10:30:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 't3', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-07-27T10:30:01.000Z', event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', verdict: 'pass', reviewed_task: 't2', reason: 'claims check out against the files' },
  { at: '2026-07-27T10:30:02.000Z', event: 'pulled', work_item: 'tok', workflow: 'feature', agent_id: 'build_dispatcher', from_team: 'design', to_team: 'build' },
  { at: '2026-07-27T10:30:03.000Z', event: 'completed', work_item: 'tok', workflow: 'feature', from_team: 'build' },
  { at: '2026-07-27T11:00:00.000Z', event: 'audit_requested', work_item: 'tok', workflow: 'feature', agent_id: 'pm', task_id: 'a1', reason: 'route finished' },
  { at: '2026-07-27T11:10:00.000Z', event: 'audited', work_item: 'tok', workflow: 'feature', agent_id: 'pm', verdict: 'accept', reason: 'the delivery answers the request' },
)

// ---------------------------------------------------------------------------
// validateLedger — structure
// ---------------------------------------------------------------------------

test('a real-shaped route validates clean', () => {
  const result = validateLedger(FULL_ROUTE)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
})

test('a trailing newline is not a problem and line numbers stay 1-based', () => {
  const text = `${FULL_ROUTE.join('\n')}\n`
  assert.equal(validateLedger(text.split('\n')).ok, true)

  const broken = validateLedger([...FULL_ROUTE, '{not json}', ''])
  assert.equal(broken.problems.length, 1)
  assert.equal(broken.problems[0].line, FULL_ROUTE.length + 1)
  assert.equal(broken.problems[0].code, 'unparsable')
})

test('a line that is not one JSON object is reported', () => {
  const result = validateLedger(['[1,2]', '"a string"', '17'])
  assert.deepEqual(codes(result), ['not_an_object', 'not_an_object', 'not_an_object'])
})

test('an unknown event name is rejected rather than accepted as evidence', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'yolo', work_item: 'tok', workflow: 'feature' },
  ))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('unknown_event'))
})

test('every common field is required on every event', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'abandoned', reason: 'no' },
  ))
  const missing = result.problems.filter((problem) => problem.code === 'missing_common_field')
  assert.deepEqual(missing.map((problem) => problem.detail).sort(), [
    'work_item is required on every event',
    'workflow is required on every event',
  ])
})

test('at must be ISO 8601 UTC', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27 10:00:00', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'r' },
    { at: '2026-07-27T10:00:00+07:00', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'r' },
  ))
  assert.deepEqual(codes(result).filter((code) => code === 'bad_timestamp').length, 2)
})

test('a timestamp that goes backwards is caught, and equal timestamps are legal', () => {
  const backwards = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', dispatch_id: 'd1' },
    { at: '2026-07-27T09:59:59.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: false },
  ))
  assert.deepEqual(codes(backwards), ['time_went_backwards'])
  assert.equal(backwards.problems[0].line, 2)

  // §4.4: equal timestamps keep append order — the runner writes several
  // events inside one tick and none of them is a defect.
  const equal = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', dispatch_id: 'd1' },
    { at: '2026-07-27T10:00:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: false },
  ))
  assert.equal(equal.ok, true)
})

test('two tokens in one file is a mismatch, and a path-shaped work_item is not an id', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'r' },
    { at: '2026-07-27T10:00:01.000Z', event: 'abandoned', work_item: '../escape', workflow: 'f', reason: 'r' },
    { at: '2026-07-27T10:00:02.000Z', event: 'abandoned', work_item: 'other', workflow: 'f', reason: 'r' },
  ))
  assert.ok(codes(result).includes('bad_work_item'))
  assert.ok(codes(result).includes('work_item_mismatch'))
})

// ---------------------------------------------------------------------------
// validateLedger — per-event required fields
// ---------------------------------------------------------------------------

test('a required field is missing when it is absent AND when it is null', () => {
  // loop-runner.mjs writes `to_team: last.to_team || null`, so a presence check
  // that only tested for the key would let a blank through as a real value.
  const absent = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'escalated', work_item: 'tok', workflow: 'f', agent_id: 'pm', task_id: 't1', reason: 'stuck' },
  ))
  assert.deepEqual(codes(absent), ['missing_field'])
  assert.match(absent.problems[0].detail, /escalated requires to_team/)

  const nulled = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'escalated', work_item: 'tok', workflow: 'f', agent_id: 'pm', to_team: null, task_id: 't1', reason: 'stuck' },
  ))
  assert.deepEqual(codes(nulled), ['missing_field'])
})

test('delivered must carry the fields the harvester reads', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', dispatch_id: 'd1' },
    { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1' },
  ))
  const details = result.problems.map((problem) => problem.detail)
  assert.ok(details.includes('delivered requires terminal'))
  assert.ok(details.includes('delivered requires timed_out'))
  assert.ok(details.includes('delivered requires evidence_present'))
  // `false` is a measurement, not an absence.
  const withFalse = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', dispatch_id: 'd1' },
    { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: false },
  ))
  assert.equal(withFalse.ok, true)
})

test('returned must carry to_team and must not carry agent_id', () => {
  const bare = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'returned', work_item: 'tok', workflow: 'f', refused_by: 'build_dispatcher', reason: 'brief does not match' },
  ))
  assert.deepEqual(codes(bare), ['missing_field'])
  assert.match(bare.problems[0].detail, /returned requires to_team/)

  // §4.1: the token is held by the team it went back to. An agent_id here
  // places the work with the dispatcher that refused it — the wrong team.
  const withAgent = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'returned', work_item: 'tok', workflow: 'f', to_team: 'design', refused_by: 'build_dispatcher', agent_id: 'build_dispatcher', reason: 'brief does not match' },
  ))
  assert.deepEqual(codes(withAgent), ['forbidden_field'])
  assert.match(withAgent.problems[0].detail, /returned must not carry agent_id/)

  // A null agent_id is not "carrying" one.
  const nulledAgent = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'returned', work_item: 'tok', workflow: 'f', to_team: 'design', refused_by: 'build_dispatcher', agent_id: null, reason: 'brief does not match' },
  ))
  assert.equal(nulledAgent.ok, true)
})

test('escalated must carry to_team so the parked token can still be placed', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'escalated', work_item: 'tok', workflow: 'f', agent_id: 'pm', to_team: 'design', task_id: 't1', reason: 'retry budget spent' },
  ))
  assert.equal(result.ok, true)
})

test('actor is shape-checked when present and never required of history that predates it', () => {
  const legacy = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'r' },
  ))
  assert.equal(legacy.ok, true)

  const bad = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'r', actor: 'build_dispatcher' },
  ))
  assert.deepEqual(codes(bad), ['bad_actor'])

  const good = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'r', actor: 'human:ada' },
  ))
  assert.equal(good.ok, true)
})

// ---------------------------------------------------------------------------
// validateLedger — sequence
// ---------------------------------------------------------------------------

test('delivered with no preceding assigned by that agent is an impossible history', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', dispatch_id: 'd1' },
    { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w2', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: false },
  ))
  assert.deepEqual(codes(result), ['delivered_without_assigned'])
  assert.equal(result.problems[0].line, 2)
})

test('reviewed with nothing delivered is an impossible history', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'pulled', work_item: 'tok', workflow: 'f', agent_id: 'd1', from_team: 'a', to_team: 'b' },
    { at: '2026-07-27T10:00:01.000Z', event: 'reviewed', work_item: 'tok', workflow: 'f', agent_id: 'ev', verdict: 'pass', reviewed_task: 't1', reason: 'looks fine' },
  ))
  assert.deepEqual(codes(result), ['reviewed_without_delivered'])
})

// GitHub #31 stage 2: target_verdict/target_reason are optional and, unlike
// `verdict`, checked in a small dedicated block rather than the generic
// `spec.verdicts` mechanism (that mechanism is hardcoded to `entry.verdict`).
const reviewedWith = (extra) => jsonl(
  { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', dispatch_id: 'd1' },
  { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'f', agent_id: 'w1', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-07-27T10:00:02.000Z', event: 'reviewed', work_item: 'tok', workflow: 'f', agent_id: 'ev', verdict: 'pass', reviewed_task: 't1', reason: 'the rejection was correctly reasoned', ...extra },
)

test('a reviewed line may confirm a target_verdict with its own reason', () => {
  const result = validateLedger(reviewedWith({ target_verdict: 'reject', target_reason: 'the auth check is missing' }))
  assert.deepEqual(result.problems, [])
})

test('a target_verdict outside accept/reject is refused', () => {
  const result = validateLedger(reviewedWith({ target_verdict: 'unresolved', target_reason: 'not sure' }))
  assert.deepEqual(codes(result), ['bad_target_verdict'])
})

test('a target_verdict with no target_reason is refused, same as a verdict with no reason', () => {
  const result = validateLedger(reviewedWith({ target_verdict: 'reject' }))
  assert.deepEqual(codes(result), ['missing_field'])
})

test('a reviewed line with no target_verdict at all stays legal — silence is not a reopen signal', () => {
  const result = validateLedger(reviewedWith({}))
  assert.deepEqual(result.problems, [])
})

test('audited requires the request that opened the audit', () => {
  const orphanAudit = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'completed', work_item: 'tok', workflow: 'f', from_team: 'build' },
    { at: '2026-07-27T10:00:01.000Z', event: 'audited', work_item: 'tok', workflow: 'f', agent_id: 'pm', verdict: 'accept', reason: 'fine' },
  ))
  assert.deepEqual(codes(orphanAudit), ['audited_without_request'])
})

test('nothing but the audit pair may follow completed', () => {
  const audited = validateLedger(FULL_ROUTE)
  assert.equal(audited.ok, true)

  const reopened = validateLedger([...FULL_ROUTE, JSON.stringify(
    { at: '2026-07-27T12:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_w1', task_id: 't9', dispatch_id: 'd9' },
  )])
  assert.deepEqual(codes(reopened), ['event_after_terminal'])
  assert.match(reopened.problems[0].detail, /already closed/)
})

test('nothing at all may follow abandoned', () => {
  const result = validateLedger(jsonl(
    { at: '2026-07-27T10:00:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'f', reason: 'nobody will finish this' },
    { at: '2026-07-27T10:00:01.000Z', event: 'audit_requested', work_item: 'tok', workflow: 'f', agent_id: 'pm', task_id: 'a1', reason: 'read it' },
  ))
  assert.deepEqual(codes(result), ['event_after_terminal'])
})

// ---------------------------------------------------------------------------
// F4 — a post-completion human question, bound and consumed
// ---------------------------------------------------------------------------

// The route from FULL_ROUTE up to `completed`, plus one audit request — the
// point every case below asks a question from.
const POST_COMPLETION = jsonl(
  { at: '2026-07-27T10:30:03.000Z', event: 'completed', work_item: 'tok', workflow: 'feature', from_team: 'build' },
  { at: '2026-07-27T11:00:00.000Z', event: 'audit_requested', work_item: 'tok', workflow: 'feature', agent_id: 'pm', task_id: 'a1', reason: 'route finished' },
)

test('an expired post-completion question closes as abandoned, not as an impossible history', () => {
  // The exact fixture the review found `appendEvent` refusing: the runner's
  // OWN withdrawal notice for an unread audit question could not be written.
  const result = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:05:00.000Z', event: 'questioned', work_item: 'tok', workflow: 'feature', agent_id: 'pm', questions: 'accept or concern?', reason: 'the audit stated no verdict this seat can use', question_id: 'q-tok-1' }),
    JSON.stringify({ at: '2026-07-27T11:20:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'feature', reason: 'no answer in 15 minutes' }),
  ])
  assert.deepEqual(result.problems, [], JSON.stringify(result.problems))
  assert.equal(result.ok, true)
})

test('audited and abandoned are genuinely final — nothing reopens the audit after either', () => {
  const reaudited = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:10:00.000Z', event: 'audited', work_item: 'tok', workflow: 'feature', agent_id: 'pm', verdict: 'accept', reason: 'fine' }),
    JSON.stringify({ at: '2026-07-27T11:20:00.000Z', event: 'audit_requested', work_item: 'tok', workflow: 'feature', agent_id: 'pm', task_id: 'a2', reason: 'read it again' }),
  ])
  assert.deepEqual(codes(reaudited), ['event_after_terminal'])

  const reabandoned = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:10:00.000Z', event: 'abandoned', work_item: 'tok', workflow: 'feature', reason: 'give up' }),
    JSON.stringify({ at: '2026-07-27T11:20:00.000Z', event: 'audit_requested', work_item: 'tok', workflow: 'feature', agent_id: 'pm', task_id: 'a2', reason: 'read it again' }),
  ])
  assert.deepEqual(codes(reabandoned), ['event_after_terminal'])
})

test('a questioned event names the question it is; an answer must not be silently unbound', () => {
  const missingId = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:05:00.000Z', event: 'questioned', work_item: 'tok', workflow: 'feature', agent_id: 'pm', questions: 'accept or concern?', reason: 'unstated verdict' }),
  ])
  assert.deepEqual(codes(missingId), ['missing_field'])
})

test('an answer bound to the wrong question_id does not close the one actually open', () => {
  const mismatched = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:05:00.000Z', event: 'questioned', work_item: 'tok', workflow: 'feature', agent_id: 'pm', questions: 'accept or concern?', reason: 'unstated verdict', question_id: 'q-tok-1' }),
    JSON.stringify({ at: '2026-07-27T11:10:00.000Z', event: 'answered', work_item: 'tok', workflow: 'feature', to_team: 'control', reason: 'concern — AC7 missing', question_id: 'q-tok-0', actor: 'human:ada' }),
  ])
  assert.deepEqual(codes(mismatched), ['question_id_mismatch'])

  // The matching id is legal, or the check is a wall rather than a binding.
  const matched = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:05:00.000Z', event: 'questioned', work_item: 'tok', workflow: 'feature', agent_id: 'pm', questions: 'accept or concern?', reason: 'unstated verdict', question_id: 'q-tok-1' }),
    JSON.stringify({ at: '2026-07-27T11:10:00.000Z', event: 'answered', work_item: 'tok', workflow: 'feature', to_team: 'control', reason: 'concern — AC7 missing', question_id: 'q-tok-1', actor: 'human:ada' }),
  ])
  assert.deepEqual(matched.problems, [], JSON.stringify(matched.problems))
})

test('answered consumes the question — a second one with nothing new asked is answering nothing', () => {
  const doubled = validateLedger([...POST_COMPLETION,
    JSON.stringify({ at: '2026-07-27T11:05:00.000Z', event: 'questioned', work_item: 'tok', workflow: 'feature', agent_id: 'pm', questions: 'accept or concern?', reason: 'unstated verdict', question_id: 'q-tok-1' }),
    JSON.stringify({ at: '2026-07-27T11:10:00.000Z', event: 'answered', work_item: 'tok', workflow: 'feature', to_team: 'control', reason: 'concern', question_id: 'q-tok-1', actor: 'human:ada' }),
    JSON.stringify({ at: '2026-07-27T11:15:00.000Z', event: 'answered', work_item: 'tok', workflow: 'feature', to_team: 'control', reason: 'still concern', question_id: 'q-tok-1', actor: 'human:ada' }),
  ])
  assert.deepEqual(codes(doubled), ['answered_without_question'])
})

test('every problem is reported, not just the first', () => {
  const result = validateLedger(jsonl(
    { at: 'yesterday', event: 'returned', work_item: 'tok', agent_id: 'bd', refused_by: 'bd' },
    { at: '2026-07-27T10:00:00.000Z', event: 'reviewed', work_item: 'tok', workflow: 'f', agent_id: 'ev' },
    { at: '2026-07-26T10:00:00.000Z', event: 'nonsense', work_item: 'tok', workflow: 'f' },
  ))
  const found = new Set(codes(result))
  for (const expected of [
    'missing_common_field', 'bad_timestamp', 'missing_field', 'forbidden_field',
    'reviewed_without_delivered', 'unknown_event', 'time_went_backwards',
  ]) {
    assert.ok(found.has(expected), `expected ${expected} among ${[...found].join(', ')}`)
  }
  assert.ok(result.problems.length >= 7, `expected several problems, got ${result.problems.length}`)
})

// ---------------------------------------------------------------------------
// appendEvent — the single sanctioned writer
// ---------------------------------------------------------------------------

const GOOD_EVENT = {
  event: 'abandoned', work_item: 'tok', workflow: 'feature',
  reason: 'diagnostic probe, nobody will finish it',
}

test('an actor is required and its shape is enforced', (t) => {
  const repo = scratch(t)
  assert.equal(appendEvent(repo, GOOD_EVENT).code, 'missing_actor')
  assert.equal(appendEvent(repo, GOOD_EVENT, {}).code, 'missing_actor')
  assert.equal(appendEvent(repo, GOOD_EVENT, { actor: '  ' }).code, 'missing_actor')
  assert.equal(appendEvent(repo, GOOD_EVENT, { actor: 'ada' }).code, 'bad_actor')
  assert.equal(appendEvent(repo, GOOD_EVENT, { actor: 'robot:ada' }).code, 'bad_actor')
  // Refusing must leave no trace behind.
  assert.equal(existsSync(ledgerPath(repo, 'tok')), false)

  assert.equal(appendEvent(repo, GOOD_EVENT, { actor: 'human:ada' }).ok, true)
  assert.equal(appendEvent(repo, { ...GOOD_EVENT, work_item: 'tok2' }, { actor: 'agent:build_dispatcher' }).ok, true)
})

test('a write records the actor and stamps at, and the event body cannot spoof the actor', (t) => {
  const repo = scratch(t)
  const before = Date.now()
  const result = appendEvent(repo, { ...GOOD_EVENT, actor: 'agent:pretending_to_be_the_runner' }, { actor: 'human:ada' })
  assert.equal(result.ok, true, JSON.stringify(result))

  const [line] = readFileSync(result.path, 'utf8').trim().split('\n')
  const record = JSON.parse(line)
  assert.equal(record.actor, 'human:ada')
  assert.ok(Date.parse(record.at) >= before)
  assert.equal(Object.keys(record)[0], 'at')
  assert.equal(validateLedger([line]).ok, true)
})

test('the directory is 0700 and the file is 0600', (t) => {
  const repo = scratch(t)
  const result = appendEvent(repo, GOOD_EVENT, { actor: 'agent:runner' })
  assert.equal(result.ok, true)
  assert.equal(statSync(dirname(result.path)).mode & 0o777, 0o700)
  assert.equal(statSync(result.path).mode & 0o777, 0o600)
})

test('writes append and never rewrite', (t) => {
  const repo = scratch(t)
  const actor = 'agent:runner'
  const first = appendEvent(repo, {
    at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f',
    agent_id: 'w1', task_id: 't1', dispatch_id: 'd1',
  }, { actor })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.line, 1)

  const second = appendEvent(repo, {
    at: '2026-07-27T10:05:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f',
    agent_id: 'w1', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: true,
  }, { actor })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.line, 2)

  const lines = readFileSync(first.path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).event, 'assigned')
  assert.equal(validateLedgerFile(first.path).ok, true)
})

test('an unknown event name is refused rather than written', (t) => {
  const repo = scratch(t)
  const result = appendEvent(repo, { ...GOOD_EVENT, event: 'yolo' }, { actor: 'agent:runner' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unknown_event')
  assert.equal(existsSync(ledgerPath(repo, 'tok')), false)
})

test('a missing required field is refused rather than written', (t) => {
  const repo = scratch(t)
  const result = appendEvent(repo, {
    event: 'escalated', work_item: 'tok', workflow: 'f', agent_id: 'pm', task_id: 't1', reason: 'stuck',
  }, { actor: 'agent:runner' })
  assert.equal(result.code, 'invalid_event')
  assert.ok(result.problems.some((problem) => /escalated requires to_team/.test(problem.detail)))
  assert.equal(existsSync(ledgerPath(repo, 'tok')), false)
})

test('an event that would make the history impossible is refused', (t) => {
  const repo = scratch(t)
  const actor = 'agent:runner'
  assert.equal(appendEvent(repo, {
    at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f',
    agent_id: 'w1', task_id: 't1', dispatch_id: 'd1',
  }, { actor }).ok, true)

  const stranger = appendEvent(repo, {
    at: '2026-07-27T10:01:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f',
    agent_id: 'w2', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: false,
  }, { actor })
  assert.equal(stranger.code, 'invalid_event')
  assert.deepEqual(codes(stranger), ['delivered_without_assigned'])
  assert.equal(readFileSync(ledgerPath(repo, 'tok'), 'utf8').trim().split('\n').length, 1)
})

test('a token that is already closed cannot be appended to', (t) => {
  const repo = scratch(t)
  const actor = 'agent:runner'
  assert.equal(appendEvent(repo, {
    at: '2026-07-27T10:00:00.000Z', ...GOOD_EVENT,
  }, { actor }).ok, true)

  const after = appendEvent(repo, {
    at: '2026-07-27T10:01:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature',
    agent_id: 'w1', task_id: 't1', dispatch_id: 'd1',
  }, { actor })
  assert.equal(after.code, 'invalid_event')
  assert.deepEqual(codes(after), ['event_after_terminal'])
})

test('a timestamp earlier than the last line is refused with its own code', (t) => {
  const repo = scratch(t)
  const actor = 'agent:runner'
  assert.equal(appendEvent(repo, {
    at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'f',
    agent_id: 'w1', task_id: 't1', dispatch_id: 'd1',
  }, { actor }).ok, true)

  const backwards = appendEvent(repo, {
    at: '2026-07-27T09:00:00.000Z', event: 'delivered', work_item: 'tok', workflow: 'f',
    agent_id: 'w1', task_id: 't1', terminal: 'done', timed_out: false, evidence_present: false,
  }, { actor })
  // Distinct from `invalid_event`: the event is fine, the clock is the problem.
  assert.equal(backwards.code, 'timestamp_not_monotonic')
  assert.equal(readFileSync(ledgerPath(repo, 'tok'), 'utf8').trim().split('\n').length, 1)
})

test('an already-broken ledger is repaired first, never appended to', (t) => {
  const repo = scratch(t)
  const dir = join(repo, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'tok.jsonl')
  // Exactly what a hand `>>` produces: plausible-looking, structurally wrong.
  writeFileSync(path, '{"at":"2026-07-27T10:00:00.000Z","event":"delivered","work_item":"tok","workflow":"f","agent_id":"w1"}\n')

  const result = appendEvent(repo, { ...GOOD_EVENT }, { actor: 'agent:runner' })
  // Different operator action from a bad event: go fix the history, not the call.
  assert.equal(result.code, 'ledger_already_invalid')
  assert.ok(result.problems.length >= 1)
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1)
})

test('a work_item cannot escape the work-items directory', (t) => {
  const repo = scratch(t)
  for (const workItem of ['../../etc/passwd', 'a/b', '', '.hidden']) {
    const result = appendEvent(repo, { ...GOOD_EVENT, work_item: workItem }, { actor: 'agent:runner' })
    assert.equal(result.code, 'bad_work_item', `expected ${JSON.stringify(workItem)} to be refused`)
  }
  assert.equal(existsSync(join(repo, '.tmux-teams', 'work-items')), false)
})

test('a reason with newlines still lands as exactly one line', (t) => {
  const repo = scratch(t)
  const result = appendEvent(repo, {
    ...GOOD_EVENT, reason: 'line one\nline two\r\nVERDICT: abandon',
  }, { actor: 'human:ada' })
  assert.equal(result.ok, true)
  const text = readFileSync(result.path, 'utf8')
  assert.equal(text.trim().split('\n').length, 1)
  assert.equal(JSON.parse(text.trim()).reason.includes('\n'), true)
})

// ---------------------------------------------------------------------------
// CLIs
// ---------------------------------------------------------------------------

const run = (script, args, input) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input })

test('the writer CLI writes on success and exits non-zero without writing on refusal', (t) => {
  const repo = scratch(t)
  const ok = run(WRITER, ['--repo', repo, '--actor', 'human:ada', '--event', JSON.stringify(GOOD_EVENT)])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /tok\.jsonl:1/)

  const bad = run(WRITER, ['--repo', repo, '--actor', 'ada', '--event', JSON.stringify({ ...GOOD_EVENT, work_item: 'tok2' })])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /REFUSED\s+bad_actor/)
  assert.equal(existsSync(ledgerPath(repo, 'tok2')), false)

  const noActor = run(WRITER, ['--repo', repo, '--event', JSON.stringify({ ...GOOD_EVENT, work_item: 'tok3' })])
  assert.equal(noActor.status, 1)
  assert.match(noActor.stderr, /missing_actor/)

  const stdin = run(WRITER, ['--repo', repo, '--actor', 'agent:runner', '--stdin'],
    JSON.stringify({ ...GOOD_EVENT, work_item: 'tok4' }))
  assert.equal(stdin.status, 0, stdin.stderr)
  assert.equal(JSON.parse(readFileSync(ledgerPath(repo, 'tok4'), 'utf8').trim()).actor, 'agent:runner')
})

test('the validator CLI exits non-zero on a bad ledger and zero on a good one', (t) => {
  const repo = scratch(t)
  const dir = join(repo, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true })
  const good = join(dir, 'good.jsonl')
  const bad = join(dir, 'bad.jsonl')
  writeFileSync(good, `${FULL_ROUTE.join('\n')}\n`)
  writeFileSync(bad, '{"at":"2026-07-27T10:00:00.000Z","event":"yolo","work_item":"bad","workflow":"f"}\n')

  const onlyGood = run(VALIDATOR, [good])
  assert.equal(onlyGood.status, 0, onlyGood.stdout)
  assert.match(onlyGood.stdout, /^PASS/m)

  const onlyBad = run(VALIDATOR, [bad])
  assert.equal(onlyBad.status, 1)
  assert.match(onlyBad.stdout, /unknown_event/)

  const scan = run(VALIDATOR, ['--repo', repo])
  assert.equal(scan.status, 1)
  assert.match(scan.stdout, /FAIL/)
  assert.match(scan.stdout, /PASS/)
})

// ---------------------------------------------------------------------------
// The two hand-written `abandoned` events that live in this repo
// ---------------------------------------------------------------------------

// Copied verbatim from `.tmux-teams/work-items/{login-fix,probe-repro}.jsonl`,
// which are gitignored, so the recorded fact survives a clean checkout.
const HAND_WRITTEN_ABANDONS = {
  'login-fix': [
    '{"at":"2026-07-26T15:45:47.519Z","event":"assigned","work_item":"login-fix","workflow":"full","agent_id":"build_worker_1","task_id":"wi-build-1","dispatch_id":"62a8de3e-a563-4e37-8a03-73ff9c93c63d"}',
    '{"at":"2026-07-26T15:45:47.546Z","event":"assigned","work_item":"login-fix","workflow":"full","agent_id":"verify_worker_1","task_id":"wi-verify-1","dispatch_id":"231cab47-0a8a-496b-a93a-1cac0a00f00b"}',
    '{"at":"2026-07-26T15:47:15.383Z","event":"delivered","work_item":"login-fix","workflow":"full","agent_id":"build_worker_1","task_id":"wi-build-1","dispatch_id":"62a8de3e-a563-4e37-8a03-73ff9c93c63d","terminal":"done","timed_out":false,"evidence_present":false}',
    '{"at":"2026-07-26T15:47:20.573Z","event":"delivered","work_item":"login-fix","workflow":"full","agent_id":"verify_worker_1","task_id":"wi-verify-1","dispatch_id":"231cab47-0a8a-496b-a93a-1cac0a00f00b","terminal":"done","timed_out":false,"evidence_present":false}',
    '{"at":"2026-07-27T10:20:50.395Z","event":"abandoned","work_item":"login-fix","workflow":"full","reason":"belongs to an earlier graph (build_worker_1/verify_worker_1 are not declared teams here) — unplaceable by construction, not stuck"}',
  ],
  'probe-repro': [
    '{"at":"2026-07-27T06:41:10.570Z","event":"assigned","work_item":"probe-repro","workflow":"feature","agent_id":"build_w2","task_id":"probe-repro-1","dispatch_id":"933db39c-3ba2-4622-9035-deff5d8bfb39"}',
    '{"at":"2026-07-27T10:20:50.395Z","event":"abandoned","work_item":"probe-repro","workflow":"feature","reason":"diagnostic probe dispatched by hand to reproduce a protocol error; it was never real work and nobody will finish it"}',
  ],
}

test('the two hand-written abandoned events are structurally and sequentially legal', () => {
  // This is the finding, not a bug: under contract §4 as it stands, a line an
  // assistant typed by hand is indistinguishable from one the runner wrote.
  // The validator cannot and must not catch it — only a recorded `actor` can,
  // which is exactly why the writer demands one.
  for (const [token, lines] of Object.entries(HAND_WRITTEN_ABANDONS)) {
    const result = validateLedger(lines)
    assert.deepEqual(result.problems, [], `${token} was expected to validate clean`)
    const last = JSON.parse(lines[lines.length - 1])
    assert.equal(last.event, 'abandoned')
    assert.equal(last.actor, undefined, `${token} names no writer, which is the defect actor closes`)
  }
})

test('the same lines are refused once a token is closed, and accepted with an actor', (t) => {
  const repo = scratch(t)
  const actor = 'human:master'
  for (const line of HAND_WRITTEN_ABANDONS['probe-repro']) {
    const result = appendEvent(repo, JSON.parse(line), { actor })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  const written = readFileSync(ledgerPath(repo, 'probe-repro'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  // Same history, now with a name on every line.
  assert.deepEqual(written.map((record) => record.actor), [actor, actor])

  const again = appendEvent(repo, JSON.parse(HAND_WRITTEN_ABANDONS['probe-repro'][1]), { actor })
  assert.equal(again.code, 'invalid_event')
  assert.deepEqual(codes(again), ['event_after_terminal'])
})

// The real ledgers are gitignored working state. Reading them is a fact; the
// hermetic copies above are what keeps this suite meaningful without them.
test('this repo\'s real ledgers still get a verdict when they are present', () => {
  const dir = join(ROOT, '.tmux-teams', 'work-items')
  if (!existsSync(dir)) return
  const verdicts = {}
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue
    const result = validateLedgerFile(join(dir, name))
    verdicts[name] = result.ok ? [] : result.problems.map((problem) => `${problem.line}:${problem.code}`)
  }
  // The two tokens carrying a hand-written `abandoned` must be clean, or the
  // recorded fact in the hermetic test above has drifted from reality. Nothing
  // else here is asserted: the rest of this directory is gitignored working
  // state, so a verdict on it is a canary, not coverage.
  for (const name of ['login-fix.jsonl', 'probe-repro.jsonl']) {
    if (verdicts[name]) assert.deepEqual(verdicts[name], [], `${name}: ${JSON.stringify(verdicts[name])}`)
  }
})

// ── a verdict is a closed vocabulary, not just a non-empty string ───────────
//
// The validator used to check that `verdict` was present and stop there, so
// `intake { verdict: "reject" }` passed the sanctioned writer and then meant
// three different things at once: the runner dispatched a worker as though it
// were an accept, the graph counted it accepted, and the board called it
// "verdict unstated". It was stated, and it was not an accept. Found by an
// outside review that reached the divergence through the writer, not by hand.

test('each verdict-bearing event refuses a word outside its own vocabulary', () => {
  const line = (extra) => jsonl({
    at: '2026-07-27T10:00:00.000Z', work_item: 'tok', workflow: 'feature', reason: 'a stated reason', ...extra,
  })
  // Only the verdict rule is asserted here. A one-line ledger also trips the
  // sequence rules (an `audited` with no `audit_requested` above it), and
  // folding those into the expectation would make this test fail for reasons
  // that have nothing to do with what it is named for.
  const verdictCodes = (result) => codes(result).filter((code) => code === 'bad_verdict')

  // `reject` is a real word a dispatcher may say, and `intake` still cannot
  // carry it: a refusal is recorded as `returned` or `escalated`, so this event
  // records only what an acceptance is. Refusing it here is what makes the two
  // readers that never consult the verdict correct rather than lucky.
  assert.deepEqual(verdictCodes(validateLedger(line({
    event: 'intake', agent_id: 'design_dispatcher', verdict: 'reject',
  }))), ['bad_verdict'])
  // `pass` belongs to review, not to the outer audit.
  assert.deepEqual(verdictCodes(validateLedger(line({
    event: 'audited', agent_id: 'pm', verdict: 'pass',
  }))), ['bad_verdict'])

  // The legal words still pass, or the rule is a wall rather than a vocabulary.
  for (const [event, agent, verdict] of [
    ['intake', 'design_dispatcher', 'accept'],
    ['audited', 'pm', 'concern'],
    ['audited', 'pm', 'accept'],
  ]) {
    const problems = validateLedger(line({ event, agent_id: agent, verdict }))
      .problems.filter((problem) => problem.code === 'bad_verdict')
    assert.deepEqual(problems, [], `${event}/${verdict} is legal and must not be refused`)
  }
})

// ── §4.6 `opened` — how work enters the graph ───────────────────────────────
//
// Before this event existed, intake had to be written either as a `pulled` with
// no sender, which the validator refuses, or as a `pulled` naming a team that
// does not exist, which it cannot catch. Both forms were on disk:
// `kanban-board.jsonl` line 1 is the first and FULL_ROUTE above is the second.

const opened = (extra = {}) => ({
  at: '2026-07-27T10:00:00.000Z', event: 'opened', work_item: 'tok', workflow: 'feature',
  agent_id: 'design_dispatcher', to_team: 'design', reason: 'opened from the quick-spec',
  // ADR 0002: a person decided, so the default fixture states one. Tests
  // about the actor rule itself override this explicitly.
  actor: 'human:someone', ...extra,
})
const assignedAt = (at) => ({
  at, event: 'assigned', work_item: 'tok', workflow: 'feature',
  agent_id: 'design_w1', task_id: 't1', dispatch_id: 'd1',
})

test('a route that opens with `opened` validates clean', () => {
  const result = validateLedger(jsonl(opened(), assignedAt('2026-07-27T10:00:01.000Z')))
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
})

test('`opened` names where work arrived and why, and must not name a sender', () => {
  assert.deepEqual(codes(validateLedger(jsonl(opened({ to_team: undefined })))), ['missing_field'])
  assert.deepEqual(codes(validateLedger(jsonl(opened({ reason: '' })))), ['missing_field'])
  // The entire reason this event exists is that there is no sending team. One
  // that names a sender is a `pulled` wearing the wrong word.
  assert.deepEqual(codes(validateLedger(jsonl(opened({ from_team: 'design' })))), ['forbidden_field'])
})

// ── ADR 0002 — `opened.actor` is who DECIDED, and that is always a person ──

test('opened must be written by a human actor, even when the caller is an agent', () => {
  const agentActor = validateLedger(jsonl(opened({ actor: 'agent:reopen-controller' })))
  assert.deepEqual(codes(agentActor), ['not_a_human_answer'])

  const noActor = validateLedger(jsonl(opened({ actor: undefined })))
  assert.deepEqual(codes(noActor), ['not_a_human_answer'])

  // The legal shape still passes, or the rule is a wall rather than a check.
  const humanActor = validateLedger(jsonl(opened({ actor: 'human:ada' })))
  assert.deepEqual(codes(humanActor), [])
})

test('opened records the relay separately from the decision, and only an agent may relay', () => {
  const relayed = validateLedger(jsonl(
    opened({ actor: 'human:ada', relayed_by: 'agent:operator' })))
  assert.deepEqual(codes(relayed), [], 'a human decision relayed by a named agent is legal')

  const forgedRelay = validateLedger(jsonl(
    opened({ actor: 'human:ada', relayed_by: 'human:someone-else' })))
  assert.deepEqual(codes(forgedRelay), ['bad_relayed_by'], 'relayed_by is always an agent, never a second human')
})

test('a token enters the graph once, and only at the top of its history', () => {
  const late = validateLedger(jsonl(
    assignedAt('2026-07-27T10:00:00.000Z'), opened({ at: '2026-07-27T10:00:01.000Z' })))
  assert.deepEqual(codes(late), ['opened_not_first'])
  const twice = validateLedger(jsonl(opened(), opened({ at: '2026-07-27T10:00:01.000Z' })))
  assert.deepEqual(codes(twice), ['opened_not_first'])
})

test('adding `opened` did not soften what `pulled` still has to say', () => {
  // The alternative to a new event was making `from_team` optional on `pulled`.
  // This is the guarantee that choice would have cost, pinned here so a later
  // convenience cannot quietly spend it.
  const senderless = {
    at: '2026-07-27T10:00:00.000Z', event: 'pulled', work_item: 'tok', workflow: 'feature',
    agent_id: 'design_dispatcher', to_team: 'design',
  }
  assert.deepEqual(codes(validateLedger(jsonl(senderless))), ['missing_field'])
})

// ---------------------------------------------------------------------------
// validateLedger — §1, flow is one way
// ---------------------------------------------------------------------------

// A leg of a route, the way the runner records one: the receiving team pulls,
// its dispatcher admits, a worker delivers, the team's evaluator passes.
// `at` is folded into task_id/dispatch_id (not just `to`) because §1 tests
// deliberately route the SAME team twice in one ledger (a token that bounces
// back to `design`, say) — every call here is already at a distinct `at`, so
// this is the id space that is actually unique, and reusing `to` alone would
// silently mint the same task_id twice on those fixtures (retro-release-
// review, 2026-08-04, B2: reused ids are what let a stale leg's outcome be
// read as the current leg's).
const leg = (from, to, at) => jsonl(
  { at: `2026-07-27T${at}:00.000Z`, event: 'pulled', work_item: 'tok', workflow: 'feature', agent_id: `${to}_dispatcher`, from_team: from, to_team: to },
  { at: `2026-07-27T${at}:01.000Z`, event: 'intake', work_item: 'tok', workflow: 'feature', agent_id: `${to}_dispatcher`, verdict: 'accept', reason: 'the request is buildable here' },
  { at: `2026-07-27T${at}:02.000Z`, event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: `${to}_w1`, task_id: `t-${to}-${at}`, dispatch_id: `d-${to}-${at}` },
  { at: `2026-07-27T${at}:03.000Z`, event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: `${to}_w1`, task_id: `t-${to}-${at}`, terminal: 'done', timed_out: false, evidence_present: true },
  { at: `2026-07-27T${at}:04.000Z`, event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: `${to}_evaluator`, verdict: 'pass', reviewed_task: `t-${to}-${at}`, reason: 'the claims check out' },
)

test('a token cannot be pulled back into a team that already admitted it', () => {
  const backwards = [
    ...leg('intake', 'design', '10:00'),
    ...leg('design', 'build', '10:10'),
    // QA found a problem and sent the work back to Design. §1 forbids exactly
    // this: the fix is a NEW token on a fresh route, not this one upstream.
    ...leg('build', 'design', '10:20'),
  ]
  const result = validateLedger(backwards)
  assert.equal(result.ok, false, 'a route ran backwards across teams and validated clean')
  const backwardsProblems = result.problems.filter((problem) => problem.code === 'route_went_backwards')
  assert.equal(backwardsProblems.length, 1, JSON.stringify(result.problems))
  assert.match(backwardsProblems[0].detail, /design already held this token/)
})

test('a dispatcher refusing at the door leaves that team free to pull the work later', () => {
  // The door check is not the loop running backwards: Build inspected the token
  // and never admitted it, so nothing came back out of Build. Design fixes what
  // was wrong and Build pulls it again — which has to stay legal, or every
  // refusal at the door would end the route.
  const refusedThenAdmitted = [
    ...leg('intake', 'design', '10:00'),
    { at: '2026-07-27T10:10:00.000Z', event: 'pulled', work_item: 'tok', workflow: 'feature', agent_id: 'build_dispatcher', from_team: 'design', to_team: 'build' },
    { at: '2026-07-27T10:10:01.000Z', event: 'returned', work_item: 'tok', workflow: 'feature', to_team: 'design', refused_by: 'build_dispatcher', reason: 'the acceptance criteria name no interface to build against' },
    ...leg('design', 'build', '10:20'),
  ].map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
  const result = validateLedger(refusedThenAdmitted)
  assert.equal(result.ok, true, JSON.stringify(result.problems))
})

test('the sanctioned writer refuses the backwards line rather than reporting it afterwards', (t) => {
  const repo = scratch(t)
  const write = (event, actor = `agent:${event.agent_id ?? 'build_dispatcher'}`) =>
    appendEvent(repo, { work_item: 'tok', workflow: 'feature', ...event }, { actor })

  // ADR 0002: `opened` is a person's decision even though every other line in
  // this fixture is agent-written — the default actor above is for the
  // agent-written events that follow it.
  assert.equal(write({ event: 'opened', agent_id: 'design_dispatcher', to_team: 'design', reason: 'new request' }, 'human:someone').ok, true)
  assert.equal(write({ event: 'intake', agent_id: 'design_dispatcher', verdict: 'accept', reason: 'buildable' }).ok, true)
  assert.equal(write({ event: 'pulled', agent_id: 'build_dispatcher', from_team: 'design', to_team: 'build' }).ok, true)
  assert.equal(write({ event: 'intake', agent_id: 'build_dispatcher', verdict: 'accept', reason: 'clear enough' }).ok, true)

  const refused = write({ event: 'pulled', agent_id: 'design_dispatcher', from_team: 'build', to_team: 'design' })
  assert.equal(refused.ok, false, 'the writer accepted a token moving upstream')
  assert.equal(refused.code, 'invalid_event')
  assert.match(refused.detail, /design already held this token/)
  // Refusing must leave the ledger exactly as it was: five lines, not six.
  assert.equal(readFileSync(ledgerPath(repo, 'tok'), 'utf8').trim().split('\n').length, 4)
})

test('the door may refuse three times; the fourth has to go to the controller', () => {
  const refusal = (n) => ({
    at: `2026-07-27T1${n}:00:00.000Z`, event: 'returned', work_item: 'tok', workflow: 'feature',
    to_team: 'design', refused_by: 'build_dispatcher', reason: 'the criteria name no interface',
  })
  const three = jsonl(refusal(0), refusal(1), refusal(2))
  assert.equal(validateLedger(three).ok, true, JSON.stringify(validateLedger(three).problems))

  const four = jsonl(refusal(0), refusal(1), refusal(2), refusal(3))
  const result = validateLedger(four)
  assert.equal(result.ok, false, 'a door refused the same token four times and it validated clean')
  assert.deepEqual(codes(result), ['door_refusals_exhausted'])
  assert.equal(result.problems[0].line, 4)

  // Counted per DOOR, not per token: a different team refusing the same work is
  // a different check, and its first refusal is still its first.
  const twoDoors = jsonl(refusal(0), refusal(1), refusal(2),
    { ...refusal(3), refused_by: 'qa_dispatcher' })
  assert.equal(validateLedger(twoDoors).ok, true, JSON.stringify(validateLedger(twoDoors).problems))
})

test('a ledger that predates the one-way rule carries on; only a NEW backwards move is refused', (t) => {
  const repo = scratch(t)
  // Written before §1 was enforceable: Design admitted it, Build admitted it,
  // and then it went back to Design.
  const legacy = [
    ...leg('intake', 'design', '10:00'),
    ...leg('design', 'build', '10:10'),
    ...leg('build', 'design', '10:20'),
  ]
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${legacy.join('\n')}\n`)

  // The first version of this test asserted the opposite: closable and nothing
  // else. That met a real ledger the same day — 46 lines, one violation at 36,
  // a worker mid-leg at 46 — and froze it. A rule written to keep work moving
  // must not be the thing that stops it, so the rule is enforced on the LINE
  // BEING WRITTEN and history is not re-punished. Master confirmed §1 stands.
  const carriedOn = appendEvent(repo, {
    event: 'pulled', work_item: 'tok', workflow: 'feature',
    agent_id: 'qa_dispatcher', from_team: 'design', to_team: 'qa',
  }, { actor: 'agent:qa_dispatcher' })
  assert.equal(carriedOn.ok, true, `a legacy ledger could not move forward: ${carriedOn.code} ${carriedOn.detail}`)

  // And a NEW backwards move is refused on exactly the same file, which is what
  // makes the sentence above a narrowing rather than an amnesty.
  const backwards = appendEvent(repo, {
    event: 'pulled', work_item: 'tok', workflow: 'feature',
    agent_id: 'build_dispatcher', from_team: 'qa', to_team: 'build',
  }, { actor: 'agent:build_dispatcher' })
  assert.equal(backwards.ok, false, 'a legacy ledger accepted a fresh backwards pull')
  assert.equal(backwards.code, 'invalid_event')
  assert.match(backwards.detail, /build already held this token/)

  // Closing it still works, which was the whole point of the first version.
  const closed = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok', workflow: 'feature',
    reason: 'this token predates the one-way rule and will not be replayed',
  }, { actor: 'human:master' })
  assert.equal(closed.ok, true, `${closed.code}: ${closed.detail}`)

  // And it is scoped to THIS defect: a ledger invalid for any other reason
  // still refuses everything, including a terminal event.
  writeFileSync(ledgerPath(repo, 'tok2'),
    `${JSON.stringify({ at: '2026-07-27T10:00:00.000Z', event: 'reviewed', work_item: 'tok2', workflow: 'feature', agent_id: 'design_evaluator', verdict: 'pass', reviewed_task: 't1', reason: 'nothing was delivered' })}\n`)
  const otherDefect = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok2', workflow: 'feature', reason: 'give up',
  }, { actor: 'human:master' })
  assert.equal(otherDefect.ok, false, 'a ledger broken some other way was closed anyway')
  assert.equal(otherDefect.code, 'ledger_already_invalid')
})

// B5, 2026-08-04: three independent reviews each rebuilt a hand-crafted
// ledger that validated clean at 88bd851 and showed it permanently frozen by
// two rules this amendment added. These are those exact two shapes, built the
// same way the §1 legacy test above is — direct `writeFileSync`, because
// `appendEvent` (and the fixture gate other tests route through) both judge
// by the CURRENT rules, and the whole point here is a history that predates
// them.
// Parameterized by work_item, not string-substituted after the fact: this
// repo's own rule is that a scripted rewrite of already-built text must be
// verified, and a `.replace` on a JSON blob has no unique anchor once two
// fixtures share every field but one.
const questionedLegacy = (workItem) => jsonl(
  { at: '2026-07-27T10:00:00.000Z', event: 'opened', work_item: workItem, workflow: 'feature', agent_id: 'build_dispatcher', to_team: 'build', reason: 'requested before question_id existed', actor: 'human:ada' },
  { at: '2026-07-27T10:00:01.000Z', event: 'intake', work_item: workItem, workflow: 'feature', agent_id: 'build_dispatcher', verdict: 'accept', reason: 'buildable here' },
  { at: '2026-07-27T10:00:02.000Z', event: 'assigned', work_item: workItem, workflow: 'feature', agent_id: 'build_w1', task_id: 't-build', dispatch_id: 'd-build' },
  { at: '2026-07-27T10:00:03.000Z', event: 'delivered', work_item: workItem, workflow: 'feature', agent_id: 'build_w1', task_id: 't-build', terminal: 'done', timed_out: false, evidence_present: true },
  // The defect under test: no `question_id`, exactly as every producer wrote
  // this event before it was required.
  { at: '2026-07-27T10:00:04.000Z', event: 'questioned', work_item: workItem, workflow: 'feature', agent_id: 'build_dispatcher', questions: ['is this scope right?'], reason: 'ambiguous request' },
)

test('a pre-amendment questioned without question_id can still be answered and abandoned (B5)', (t) => {
  const repo = scratch(t)
  const legacy = questionedLegacy('tok')
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${legacy.join('\n')}\n`)

  // Sanity: confirm the shape under test is exactly the one B5 named, not
  // some other defect riding along by accident.
  const raw = validateLedger(legacy)
  assert.equal(raw.ok, false)
  assert.deepEqual(codes(raw), ['missing_field'])
  assert.equal(raw.problems[0].event, 'questioned')
  assert.equal(raw.problems[0].field, 'question_id')

  const answered = appendEvent(repo, {
    event: 'answered', work_item: 'tok', workflow: 'feature',
    to_team: 'build', reason: 'yes, scope is right',
  }, { actor: 'human:ada' })
  assert.equal(answered.ok, true,
    `a legacy questioned line permanently froze the ledger: ${answered.code} ${answered.detail}`)

  // Scoped, not a blanket amnesty for `missing_field`: a FRESH questioned on
  // the very same (now-appendable) ledger still needs its own question_id.
  // Only HISTORY is excused.
  const freshQuestion = appendEvent(repo, {
    event: 'questioned', work_item: 'tok', workflow: 'feature',
    agent_id: 'build_dispatcher', questions: ['anything else?'], reason: 'still unclear',
  }, { actor: 'agent:build_dispatcher' })
  assert.equal(freshQuestion.ok, false, 'a legacy ledger let a NEW questioned skip question_id too')
  assert.equal(freshQuestion.code, 'invalid_event')
  assert.match(freshQuestion.detail, /question_id/)

  // The other withdrawal path — the clock's, not a person's — also still
  // works: build a second, otherwise-identical ledger and abandon it instead.
  writeFileSync(ledgerPath(repo, 'tok2'), `${questionedLegacy('tok2').join('\n')}\n`)
  const abandoned = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok2', workflow: 'feature',
    reason: 'nobody answered before the deadline',
  }, { actor: 'agent:loop-runner' })
  assert.equal(abandoned.ok, true,
    `a legacy questioned line stopped the clock's own withdrawal: ${abandoned.code} ${abandoned.detail}`)
})

test('a pre-amendment opened written by an agent actor can still be appended to (B5)', (t) => {
  const repo = scratch(t)
  const legacy = jsonl(
    // The defect under test: `opened` signed by an agent, legal before ADR
    // 0002 made `opened` a human decision the way `answered` already was.
    { at: '2026-07-27T10:00:00.000Z', event: 'opened', work_item: 'tok', workflow: 'feature', agent_id: 'build_dispatcher', to_team: 'build', reason: 'requested before ADR 0002', actor: 'agent:build_dispatcher' },
  )
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${legacy.join('\n')}\n`)

  const raw = validateLedger(legacy)
  assert.equal(raw.ok, false)
  assert.deepEqual(codes(raw), ['not_a_human_answer'])
  assert.equal(raw.problems[0].event, 'opened')

  const intake = appendEvent(repo, {
    event: 'intake', work_item: 'tok', workflow: 'feature',
    agent_id: 'build_dispatcher', verdict: 'accept', reason: 'buildable here',
  }, { actor: 'agent:build_dispatcher' })
  assert.equal(intake.ok, true,
    `a legacy agent-authored opened permanently froze the ledger: ${intake.code} ${intake.detail}`)

  // Scoped, not a blanket amnesty: a FRESH opened by an agent — a different
  // token entering the graph for the first time, since `opened` can only ever
  // be line one — is still refused after ADR 0002.
  const freshOpened = appendEvent(repo, {
    event: 'opened', work_item: 'tok2', workflow: 'feature',
    agent_id: 'build_dispatcher', to_team: 'build', reason: 'a fresh request',
  }, { actor: 'agent:build_dispatcher' })
  assert.equal(freshOpened.ok, false, 'a fresh agent-authored opened was accepted after ADR 0002')
  assert.equal(freshOpened.code, 'invalid_event')
  assert.match(freshOpened.detail, /human actor/)
})

// qwen #2, retro-release-review 2026-08-04: B2's `duplicate_task_id` /
// `duplicate_dispatch_id` shipped without joining `LEGACY_TOLERATED_PROBLEMS`,
// so a ledger that already carried a collision when B2 landed — reachable
// with no hand editing, since `task_id` is minted at millisecond resolution —
// froze solid: `continuable` in `ledger-writer.mjs` requires EVERY existing
// problem to be tolerated, and this one was not, so `appendEvent` refused
// even a terminal `abandoned`. Same shape as the two B5 tests above; same
// fix.
const dupTaskLegacy = jsonl(
  { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', dispatch_id: 'd-1' },
  { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', terminal: 'done', timed_out: false, evidence_present: true },
  // The defect under test: a SECOND `assigned` reusing the same task_id.
  { at: '2026-07-27T10:00:02.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', dispatch_id: 'd-2' },
  { at: '2026-07-27T10:00:03.000Z', event: 'lost', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', reason: 'timed out' },
)

test('a pre-existing duplicate task_id can still be closed, but a fresh reuse is still refused (qwen #2)', (t) => {
  const repo = scratch(t)
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${dupTaskLegacy.join('\n')}\n`)

  // Sanity: confirm the shape under test is exactly the one B2 named.
  const raw = validateLedger(dupTaskLegacy)
  assert.equal(raw.ok, false)
  assert.deepEqual(codes(raw), ['duplicate_task_id'])

  const abandoned = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok', workflow: 'feature',
    reason: 'this token predates B2 and will not be replayed',
  }, { actor: 'human:master' })
  assert.equal(abandoned.ok, true,
    `a pre-existing duplicate task_id permanently froze the ledger: ${abandoned.code} ${abandoned.detail}`)

  // Scoped, not a blanket amnesty: a FRESH duplicate on a second, otherwise-
  // identical ledger is still refused — the new `assigned` reuses an id the
  // ledger already claimed, and that reuse is reported at the NEW line, which
  // is never in `inherited`.
  writeFileSync(ledgerPath(repo, 'tok2'), `${dupTaskLegacy.map((line) => line.replace(/"tok"/g, '"tok2"')).join('\n')}\n`)
  const freshDupe = appendEvent(repo, {
    event: 'assigned', work_item: 'tok2', workflow: 'feature',
    agent_id: 'w2', task_id: 't-dup', dispatch_id: 'd-3',
  }, { actor: 'agent:runner' })
  assert.equal(freshDupe.ok, false, 'a legacy ledger let a NEW assigned reuse a task_id too')
  assert.equal(freshDupe.code, 'invalid_event')
  assert.match(freshDupe.detail, /task_id/)
})

test('a team that admitted the work cannot send it back — it fixes it and forwards', () => {
  // Master, 2026-08-03, confirming §1 against a live token: "ยืนยันกฏไม่ส่งกลับ
  // รีวิวเวอร์ที่เจอปัญหาก็ต้องแก้ต่อเองให้จบเลย". Nothing refused this before,
  // which is how a hand-written `returned` came to sit in a production ledger —
  // the operator used the only move the system left open.
  const sentBack = [
    ...leg('intake', 'design', '10:00'),
    ...leg('design', 'review', '10:10'),
    { at: '2026-07-27T10:20:00.000Z', event: 'returned', work_item: 'tok', workflow: 'feature', to_team: 'design', refused_by: 'review_dispatcher', reason: 'the tests do not run' },
  ].map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
  const result = validateLedger(sentBack)
  assert.equal(result.ok, false, 'a team that admitted the token sent it back and it validated clean')
  const sendBacks = result.problems.filter((problem) => problem.code === 'sent_back_after_admission')
  assert.equal(sendBacks.length, 1, JSON.stringify(result.problems))
  assert.match(sendBacks[0].detail, /cannot send it back to design/)

  // The door check is untouched: a refusal BEFORE admission is not a send-back,
  // and this is the line that keeps the new rule from swallowing it.
  const atTheDoor = [
    ...leg('intake', 'design', '10:00'),
    { at: '2026-07-27T10:10:00.000Z', event: 'pulled', work_item: 'tok', workflow: 'feature', agent_id: 'review_dispatcher', from_team: 'design', to_team: 'review' },
    { at: '2026-07-27T10:10:01.000Z', event: 'returned', work_item: 'tok', workflow: 'feature', to_team: 'design', refused_by: 'review_dispatcher', reason: 'no interface named' },
  ].map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
  assert.equal(validateLedger(atTheDoor).ok, true, JSON.stringify(validateLedger(atTheDoor).problems))
})

// ── retro-release-review round 2, 2026-08-04: F1 Shape 2 — a `reviewed` that
// borrows a live dispatch_id while naming an older task_id ─────────────────
//
// `dispatch_id_task_mismatch` used to exempt `reviewed` entirely, on the
// belief that `reviewed`'s only task-shaped field is `reviewed_task` (the
// WORKER's delivery, a different leg entirely — correctly still unchecked).
// But `reviewed` can also carry a plain `task_id` naming the leg it was
// itself written from, and production stamps that from the SAME leg as its
// `dispatch_id` (loop-runner.mjs harvests both off one `last`). A line that
// names a live dispatch_id but an OLD task_id is not a shape the sanctioned
// writer can produce — validating it clean is what let dispatch-facts.mjs's
// `currentEntry` trust it as the live leg's own outcome.
test('a reviewed borrowing a live dispatch_id while naming an older task_id is refused (F1 Shape 2)', () => {
  // `reviewed` requires a preceding `delivered` to review at all (§4.6) — the
  // worker's leg, unrelated to the evaluator legs this test is about.
  const workerDelivered = [
    { at: '2026-07-27T09:59:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_w1', task_id: 't-1', dispatch_id: 'wd-1' },
    { at: '2026-07-27T09:59:30.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'design_w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true },
  ]
  const borrowed = jsonl(
    ...workerDelivered,
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 'r-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T10:01:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 'r-2', dispatch_id: 'd-2' },
    // Names the LIVE dispatch_id (d-2, round 2's own) but the OLDER task_id
    // (r-1, round 1's).
    { at: '2026-07-27T10:02:00.000Z', event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', verdict: 'pass', task_id: 'r-1', dispatch_id: 'd-2', reviewed_task: 't-1', reason: 'borrowed identity' },
  )
  const result = validateLedger(borrowed)
  assert.equal(result.ok, false, 'a reviewed naming a live dispatch_id but an older task_id validated clean')
  assert.ok(codes(result).includes('dispatch_id_task_mismatch'),
    `expected dispatch_id_task_mismatch, got ${JSON.stringify(result.problems)}`)

  // The two fields naming the SAME leg still validates — the check is about a
  // contradiction, not about a reviewed carrying task_id at all.
  const consistent = jsonl(
    ...workerDelivered,
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 'r-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T10:01:00.000Z', event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', verdict: 'pass', task_id: 'r-1', dispatch_id: 'd-1', reviewed_task: 't-1', reason: 'its own leg' },
  )
  assert.equal(validateLedger(consistent).ok, true, JSON.stringify(validateLedger(consistent).problems))

  // reviewed_task is still never checked against the dispatch owner's task —
  // it names the WORKER's delivery, a different leg on purpose.
  const reviewedTaskUnrelated = jsonl(
    ...workerDelivered,
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 'r-1', dispatch_id: 'd-1' },
    {
      at: '2026-07-27T10:01:00.000Z', event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator',
      verdict: 'pass', task_id: 'r-1', dispatch_id: 'd-1', reviewed_task: 'a-completely-different-worker-task', reason: 'unrelated on purpose',
    },
  )
  assert.equal(validateLedger(reviewedTaskUnrelated).ok, true, JSON.stringify(validateLedger(reviewedTaskUnrelated).problems))

  // Omitting task_id altogether (the ordinary shorthand) is still legal —
  // this only refuses a task_id that resolves to a DIFFERENT leg.
  const noTaskId = jsonl(
    ...workerDelivered,
    { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', task_id: 'r-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T10:01:00.000Z', event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: 'design_evaluator', verdict: 'pass', dispatch_id: 'd-1', reviewed_task: 't-1', reason: 'shorthand' },
  )
  assert.equal(validateLedger(noTaskId).ok, true, JSON.stringify(validateLedger(noTaskId).problems))
})
