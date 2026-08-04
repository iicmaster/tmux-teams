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
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireLock, appendEvent, ledgerPath, releaseLock, stealStaleLock } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { validateLedger, validateLedgerFile, validateLedgerTolerant } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'

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
// `duplicate_dispatch_id` shipped without joining any tolerance list, so a
// ledger that already carried a collision when B2 landed — reachable with no
// hand editing, since `task_id` is minted at millisecond resolution — froze
// solid: `continuable` in `ledger-writer.mjs` requires EVERY existing problem
// to be tolerated, and this one was not, so `appendEvent` refused even a
// terminal `abandoned`.
//
// qwen F-1 / codex BLOCKER 3, retro-release-review ROUND 4, 2026-08-04: the
// first fix for that (joining `duplicate_task_id`/`duplicate_dispatch_id` to
// `LEGACY_TOLERATED_PROBLEMS`, bare, no event/field) was wrong in the other
// direction — `isLegacyTolerated` has no notion of WHEN a problem was
// written, so it tolerated a duplicate minted TODAY exactly as readily as one
// from before B2 existed, for every reader (`pull-controller.mjs`,
// `kanban.mjs`, `loop-runner.mjs`'s tick), not just the writer's closing
// check. `currentEntry` (dispatch-facts.mjs) depends on an id resolving to
// ONE leg for its whole life; a duplicate is a claim that promise is broken,
// and no reader may believe otherwise regardless of the collision's age.
// `isLegacyTolerated`/`validateLedgerTolerant`/`validateLedgerFileTolerant`
// now never tolerate a duplicate id or the `dispatch_id_agent_mismatch`/
// `dispatch_id_task_mismatch` it produces; a wider, writer-only
// `isClosingTolerated` exists so the ledger can still be CLOSED.
const dupTaskLegacy = jsonl(
  { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', dispatch_id: 'd-1' },
  { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', terminal: 'done', timed_out: false, evidence_present: true },
  // The defect under test: a SECOND `assigned` reusing the same task_id.
  { at: '2026-07-27T10:00:02.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', dispatch_id: 'd-2' },
  { at: '2026-07-27T10:00:03.000Z', event: 'lost', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't-dup', reason: 'timed out' },
)

test('a pre-existing duplicate task_id can still be closed, but nothing else may land on it (qwen #2, tightened round 4)', (t) => {
  const repo = scratch(t)
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${dupTaskLegacy.join('\n')}\n`)

  // Sanity: confirm the shape under test is exactly the one B2 named.
  const raw = validateLedger(dupTaskLegacy)
  assert.equal(raw.ok, false)
  assert.deepEqual(codes(raw), ['duplicate_task_id'])

  // Round 4: no reader — not the pull controller, not the board, not the
  // runner's tick — trusts this ledger enough to move the token, no matter
  // how old the collision is. It is blocking, not legacy-tolerated.
  const tolerant = validateLedgerTolerant(dupTaskLegacy)
  assert.equal(tolerant.ok, false,
    'a duplicate task_id was blanket-tolerated for reading, letting a reader trust an ambiguous id')
  assert.deepEqual(tolerant.blocking.map((problem) => problem.code), ['duplicate_task_id'])

  // It can still be CLOSED — a token must always be able to reach abandoned.
  const abandoned = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok', workflow: 'feature',
    reason: 'this token predates B2 and will not be replayed',
  }, { actor: 'human:master' })
  assert.equal(abandoned.ok, true,
    `a pre-existing duplicate task_id permanently froze the ledger: ${abandoned.code} ${abandoned.detail}`)

  // Round 4 tightening: a duplicate-tainted ledger may receive a TERMINAL
  // event and nothing else — not even a brand-new `assigned` naming ids the
  // ledger has never seen before, which the pre-round-4 code accepted
  // (codex BLOCKER 3's "comment/code disagreement": the comment always said
  // "nothing else may", the code only checked whether the appended line
  // introduced its own fresh problem). `ledger_already_invalid` fires before
  // the candidate line is even considered.
  writeFileSync(ledgerPath(repo, 'tok2'), `${dupTaskLegacy.map((line) => line.replace(/"tok"/g, '"tok2"')).join('\n')}\n`)
  const freshAssign = appendEvent(repo, {
    event: 'assigned', work_item: 'tok2', workflow: 'feature',
    agent_id: 'w2', task_id: 't-brand-new', dispatch_id: 'd-brand-new',
  }, { actor: 'agent:runner' })
  assert.equal(freshAssign.ok, false,
    'a duplicate-tainted ledger accepted a non-terminal continuation instead of demanding repair or closure')
  assert.equal(freshAssign.code, 'ledger_already_invalid')

  // And a NEW assigned that reuses the SAME id is refused for the same
  // reason (never reaches the fresh/inherited check at all any more).
  const freshDupe = appendEvent(repo, {
    event: 'assigned', work_item: 'tok2', workflow: 'feature',
    agent_id: 'w2', task_id: 't-dup', dispatch_id: 'd-3',
  }, { actor: 'agent:runner' })
  assert.equal(freshDupe.ok, false, 'a legacy ledger let a NEW assigned reuse a task_id too')
  assert.equal(freshDupe.code, 'ledger_already_invalid')

  // The terminal path is still open on tok2 as well.
  const abandonedToo = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok2', workflow: 'feature', reason: 'closing this one too',
  }, { actor: 'human:master' })
  assert.equal(abandonedToo.ok, true,
    `tok2's duplicate task_id blocked even its own terminal close: ${abandonedToo.code} ${abandonedToo.detail}`)
})

// codex BLOCKER 9, retro-release-review round 5, 2026-08-04: `completed` is a
// member of `TERMINAL_EVENTS` but §5 calls it only HALF closed — its sole
// legal continuation is `audit_requested` -> `audited`, neither of which is
// terminal. The pre-fix `continuableToClose` tested `TERMINAL_EVENTS`, so a
// duplicate-tainted ledger accepted `completed` (it needs only `from_team`)
// and then refused the very `audit_requested` the runner writes next with
// `ledger_already_invalid` — the token lands in loop-runner.mjs's STUCK path,
// while kanban.mjs has already filed the card under Done with no
// `blockedReason` because `completed` is a `RELEASING_EVENTS` member. Only
// `HARD_TERMINAL_EVENTS` (`audited`, `abandoned` — the rows with no
// successor at all) may close a ledger this gate is tolerating.
test('completed cannot close a duplicate-tainted ledger — only a truly terminal event may (codex BLOCKER 9)', (t) => {
  const repo = scratch(t)
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${dupTaskLegacy.join('\n')}\n`)

  const raw = validateLedger(dupTaskLegacy)
  assert.equal(raw.ok, false)
  assert.deepEqual(codes(raw), ['duplicate_task_id'])

  // The half-closed event is refused outright — it would strand the token
  // worse than leaving the tainted ledger alone, not close it.
  const completed = appendEvent(repo, {
    event: 'completed', work_item: 'tok', workflow: 'feature', from_team: 'build',
  }, { actor: 'agent:build_dispatcher' })
  assert.equal(completed.ok, false,
    'a duplicate-tainted ledger accepted completed, which needs an audit pair it can never legally receive')
  assert.equal(completed.code, 'ledger_already_invalid')

  // The genuinely terminal events are still open, exactly as before.
  const abandoned = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok', workflow: 'feature',
    reason: 'closing by hand instead of the half-closed completed',
  }, { actor: 'human:master' })
  assert.equal(abandoned.ok, true,
    `abandoned should still close a duplicate-tainted ledger: ${abandoned.code} ${abandoned.detail}`)
})

// codex BLOCKER 3, retro-release-review round 4, 2026-08-04: the OTHER
// direction of the same finding. A realistic pre-existing dispatch_id
// collision — two different legs minted the same dispatch_id, each with its
// own agent_id/task_id — produces THREE problems on the second leg's lines,
// not one: `duplicate_dispatch_id` on the second `assigned`, plus
// `dispatch_id_agent_mismatch` and `dispatch_id_task_mismatch` on its
// `delivered`, because `dispatchOwner` (ledger-validate.mjs) keeps only the
// FIRST leg as the id's owner. Tolerating only `duplicate_dispatch_id` for
// closing — and not the mismatch fallout it causes on every later line
// naming the id — left this exact, realistic shape with no legal terminal:
// `abandoned` was refused with `ledger_already_invalid` because two of its
// three problems were untolerated. `isClosingTolerated` now covers all four
// codes together.
const dupDispatchCollision = jsonl(
  { at: '2026-07-27T10:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't1', dispatch_id: 'd-dup' },
  { at: '2026-07-27T10:00:01.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'w1', task_id: 't1', dispatch_id: 'd-dup', terminal: 'done', timed_out: false, evidence_present: true },
  { at: '2026-07-27T10:00:02.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'w2', task_id: 't2', dispatch_id: 'd-dup' },
  { at: '2026-07-27T10:00:03.000Z', event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'w2', task_id: 't2', dispatch_id: 'd-dup', terminal: 'done', timed_out: false, evidence_present: true },
)

test('a pre-existing dispatch_id collision followed by its normal second-leg delivery can still be closed (codex BLOCKER 3)', (t) => {
  const repo = scratch(t)
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(ledgerPath(repo, 'tok'), `${dupDispatchCollision.join('\n')}\n`)

  const raw = validateLedger(dupDispatchCollision)
  assert.equal(raw.ok, false)
  assert.deepEqual(codes(raw).sort(),
    ['dispatch_id_agent_mismatch', 'dispatch_id_task_mismatch', 'duplicate_dispatch_id'].sort())

  // Round 4: still not trusted for reading — pull-controller/kanban/the
  // runner's tick refuse to move this token, exactly as they refuse the
  // single-code case above.
  const tolerant = validateLedgerTolerant(dupDispatchCollision)
  assert.equal(tolerant.ok, false,
    'a genuine second-leg dispatch_id collision was blanket-tolerated for reading')
  assert.deepEqual(tolerant.blocking.map((problem) => problem.code).sort(),
    ['dispatch_id_agent_mismatch', 'dispatch_id_task_mismatch', 'duplicate_dispatch_id'].sort())

  // But it must still be CLOSEABLE — this is the realistic collision-then-
  // normal-outcome shape codex found trapped with no legal terminal.
  const abandoned = appendEvent(repo, {
    event: 'abandoned', work_item: 'tok', workflow: 'feature',
    reason: 'both legs delivered under the same collided dispatch_id; closing by hand',
  }, { actor: 'human:master' })
  assert.equal(abandoned.ok, true,
    `a collision followed by its own second leg's normal delivery had no legal terminal: ${abandoned.code} ${abandoned.detail}`)
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

// ---------------------------------------------------------------------------
// codex BLOCKER 8 (retro-release-review round 5, 2026-08-04): appendEvent is
// read-validate-append with no atomicity across those three steps by itself.
// `appendFileSync` makes ONE line's bytes atomic; it says nothing about
// whether that line was still the right thing to write given what another
// writer just committed. codex's probe ran 24 synchronized writers against a
// clean ledger: 8 returned ok and wrote 8 identical rows, and the validator
// then reported duplicate_task_id / duplicate_dispatch_id on the next read.
//
// This spawns REAL, separate OS processes through the sanctioned CLI
// (`ledger-writer.mjs`, the same binary any hand-run dispatch would call) —
// not async callbacks racing inside one event loop — because the defect is
// specifically about MULTIPLE PROCESSES sharing one filesystem, and a
// same-process simulation cannot prove a cross-process lock does anything.
// ---------------------------------------------------------------------------

// A plain `Promise.all` over `spawn` calls issued back-to-back is NOT enough
// to reproduce the race codex found: real Node process startup (module load,
// `ledger-validate.mjs` parsing, etc.) takes single-digit-to-tens of
// milliseconds and dwarfs the actual read-validate-append critical section,
// so N freshly-spawned processes rarely land in that section at the same
// instant — they naturally stagger themselves apart. Proven empirically
// against the unlocked (pre-fix) code: a bare `Promise.all(spawn(...))`
// race, run repeatedly, produced exactly 1 winner every time — a FALSE
// negative that would have shipped this test believing it caught blocker 8
// when it was actually just measuring process-startup jitter.
//
// This gates every worker on a `go` file: all N are spawned first, so every
// one of them pays its startup cost and reaches a tight `existsSync` spin
// BEFORE anything can proceed, then the file is written once, releasing
// them together. That is what makes the overlap in the critical section
// real instead of accidental.
function raceWorkerSource() {
  return [
    `import { appendEvent } from ${JSON.stringify(WRITER)}`,
    "import { existsSync } from 'node:fs'",
    'const [, , repo, gate, eventJson, actor] = process.argv',
    'const deadline = Date.now() + 5000',
    'while (!existsSync(gate)) {',
    '  if (Date.now() > deadline) { process.stderr.write("gate timeout"); process.exit(3) }',
    '}',
    'const result = appendEvent(repo, JSON.parse(eventJson), { actor })',
    'process.stdout.write(JSON.stringify(result))',
    'process.exit(result.ok ? 0 : 1)',
    '',
  ].join('\n')
}

test('BLOCKER 8: N release-gated (genuinely simultaneous) processes appending the identical assigned event to a clean ledger produce exactly one committed line, never duplicate rows', async (t) => {
  const dir = scratch(t)
  const N = 24
  const gate = join(dir, 'go')
  const workerPath = join(dir, 'race-worker.mjs')
  writeFileSync(workerPath, raceWorkerSource())
  const event = JSON.stringify({
    event: 'assigned', work_item: 'race-tok', workflow: 'feature',
    agent_id: 'runner', task_id: 'race-task', dispatch_id: 'race-dispatch',
  })

  const pending = Array.from({ length: N }, () => {
    const child = spawn(process.execPath, [workerPath, dir, gate, event, 'agent:runner'])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    return new Promise((resolvePromise) => {
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }))
    })
  })
  // Every worker must have finished Node startup and reached its spin loop
  // before the gate opens, or "simultaneous" is not actually being tested.
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 400) })
  writeFileSync(gate, '')

  const results = await Promise.all(pending)
  const timedOut = results.filter((r) => r.code === 3)
  assert.equal(timedOut.length, 0, `${timedOut.length} worker(s) never saw the gate open — the 400ms warm-up was not enough: ${JSON.stringify(timedOut)}`)

  const succeeded = results.filter((r) => r.code === 0)
  const refused = results.filter((r) => r.code === 1)
  assert.equal(succeeded.length, 1,
    `expected exactly 1 of ${N} simultaneous identical writers to win the append, got ${succeeded.length}: ${JSON.stringify(results)}`)
  assert.equal(refused.length, N - 1)
  for (const r of refused) {
    const parsed = JSON.parse(r.stdout)
    const namesDuplicate = (parsed.problems || []).some(
      (problem) => problem.code === 'duplicate_task_id' || problem.code === 'duplicate_dispatch_id')
    assert.ok(namesDuplicate,
      `a refused writer's result should name the duplicate it lost to, got: ${JSON.stringify(parsed)}`)
  }

  const path = ledgerPath(dir, 'race-tok')
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1,
    `the ledger must hold exactly one line after ${N} simultaneous identical appends — holds ${lines.length}`)
  const verdict = validateLedger(lines)
  assert.equal(verdict.ok, true, `the resulting ledger must validate clean: ${JSON.stringify(verdict.problems)}`)

  // No lock file left behind to be mistaken for a ledger by a directory
  // listing (both readers in this codebase filter on the `.jsonl` suffix,
  // but a leaked `.lock` file is still a leaked file).
  assert.equal(existsSync(`${path}.lock`), false, 'a stale .lock file was left behind after every writer finished')
})

test('BLOCKER 8: a lock left by a process that died mid-hold is recovered after it goes stale, not held forever', (t) => {
  const dir = scratch(t)
  const path = ledgerPath(dir, 'stuck-tok')
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
  // Simulate a writer that was SIGKILLed while holding the lock: the file
  // exists, but backdated well past the staleness window so the next
  // acquirer does not have to wait out the real 30s in a test that must run
  // in well under a second.
  writeFileSync(lockPath, '99999')
  const past = new Date(Date.now() - 60_000)
  utimesSync(lockPath, past, past)

  const result = appendEvent(dir, { event: 'abandoned', work_item: 'stuck-tok', workflow: 'feature', reason: 'recovered after a dead holder' }, { actor: 'agent:runner' })
  assert.equal(result.ok, true, `a stale lock from a dead holder should be recovered, not wedge the token forever: ${JSON.stringify(result)}`)
  assert.equal(existsSync(lockPath), false, 'the recovered lock should be released again after the write that stole it')
})

// ---------------------------------------------------------------------------
// A stolen lock must not be released by the holder it was stolen FROM.
//
// The steal itself is a bounded, documented race: A stalls past LOCK_STALE_MS,
// B takes the lock, and for as long as A is still inside its critical section
// the two overlap. What is NOT bounded is what an unconditional
// `unlinkSync(lockPath)` does next — A finishes, deletes the lock file B is
// holding, and C then acquires cleanly while B is still writing. One stolen
// lock becomes an open critical section that outlives the steal by however
// long B still needs, and nothing on disk records that it happened.
// ---------------------------------------------------------------------------
test('a holder whose lock was stolen releases nothing, so the stealer keeps the critical section', (t) => {
  const dir = scratch(t)
  const lockPath = join(dir, 'w.jsonl.lock')

  const aToken = acquireLock(lockPath)
  assert.equal(readFileSync(lockPath, 'utf8'), aToken, 'the lock file records the acquisition that holds it')

  // B steals exactly as `acquireLock` does once the lock reads stale.
  rmSync(lockPath)
  const bToken = acquireLock(lockPath)
  assert.notEqual(bToken, aToken, 'two acquisitions in one process must still be distinguishable')

  // A wakes up and releases. Its lock is gone; B's must survive untouched.
  releaseLock(lockPath, aToken)
  assert.equal(existsSync(lockPath), true,
    "A released B's lock: the next writer walks into the section B is still inside")
  assert.equal(readFileSync(lockPath, 'utf8'), bToken, "the surviving lock is still B's")

  // And B's own release still works.
  releaseLock(lockPath, bToken)
  assert.equal(existsSync(lockPath), false, 'the true holder can always release')
})

test('a steal removes only the marker it judged, never the one that replaced it', (t) => {
  // r6-codex: `wx` guards the CREATE, not the decision in front of it. Two
  // racers judge the same stale marker; the first steals it and takes the lock;
  // the second, still acting on what it read, unlinks the FRESH lock and
  // creates its own beside a holder still inside its critical section. `wx`
  // never saw a conflict because by then there was nothing to conflict with.
  //
  // Reproduced at the seam because `acquireLock` re-reads the marker on every
  // retry, so a single call cannot be made to act on a stale observation — the
  // interleaving needs two processes, and the guard is what makes the second
  // one harmless.
  const dir = scratch(t)
  const lockPath = join(dir, 'w.jsonl.lock')

  // B holds. Its own section has run long enough that the marker reads stale —
  // stealing it is legitimate, but only for a racer that judged THIS marker.
  writeFileSync(lockPath, 'B-token')
  const old = new Date(Date.now() - 120_000)
  utimesSync(lockPath, old, old)

  // C judged A's marker, which B already replaced.
  assert.equal(stealStaleLock(lockPath, 'A-token'), false,
    'C stole a marker it never judged')
  assert.equal(readFileSync(lockPath, 'utf8'), 'B-token',
    "C removed B's lock: two writers are now inside one critical section")

  // A racer that judged the marker actually there may still steal it — the
  // guard narrows the rule to "what you judged", it does not repeal it.
  assert.equal(stealStaleLock(lockPath, 'B-token'), true)
  assert.equal(existsSync(lockPath), false)
})

test("a second stealer acting on what it saw does not unlink the fresh lock the first one just took", (t) => {
  // r6-codex: `wx` guards the CREATE, not the decision in front of it. B and C
  // both read the same stale marker; B steals and enters; C, still acting on
  // what it read, unlinks B's FRESH lock and creates its own beside a holder
  // that is still inside. `wx` never saw a conflict because by then there was
  // nothing to conflict with.
  const dir = scratch(t)
  const lockPath = join(dir, 'w.jsonl.lock')

  // A holds, and its lock has gone stale.
  writeFileSync(lockPath, 'A-token')
  const old = new Date(Date.now() - 120_000)
  utimesSync(lockPath, old, old)
  const observedByBoth = readFileSync(lockPath, 'utf8')

  // B gets there first and takes it. `acquireLock` steals, then creates.
  const bToken = acquireLock(lockPath)
  assert.equal(readFileSync(lockPath, 'utf8'), bToken, 'B holds after the steal')

  // C now acts on the token it read BEFORE B moved. Its own acquire must not
  // remove B's lock; with a 5s wait bound it can only time out.
  assert.throws(() => acquireLock(lockPath), /timed out waiting/,
    'C stole a lock that was no longer the one it had judged stale')
  assert.equal(readFileSync(lockPath, 'utf8'), bToken,
    "C removed B's fresh lock: two writers are now inside one critical section")
  assert.equal(observedByBoth, 'A-token', 'both racers judged the same marker')

  releaseLock(lockPath, bToken)
})

// Quinn's mutant, round 6: narrow the tolerant close to accept only
// `abandoned` and every duplicate-close test stayed green — the set has two
// members and only one was ever exercised. `audited` is the ordinary end of a
// route that finished and was read as a whole; a tolerant gate that silently
// dropped it would wedge an audited token at its last step, which is the exact
// failure the closing tolerance exists to prevent.
test('audited closes a duplicate-tainted ledger, and it is not abandoned (r6-codex/Quinn)', (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  const tok = 'aud-tok'
  const at = (n) => new Date(Date.UTC(2026, 7, 4, 10, n)).toISOString()
  const custody = [
    { at: at(0), event: 'opened', work_item: tok, workflow: 'feature', agent_id: 'ctl', to_team: 'control', reason: 'r', actor: 'human:ngs' },
    { at: at(1), event: 'pulled', work_item: tok, workflow: 'feature', agent_id: 'runner', from_team: 'control', to_team: 'dev', actor: 'agent:runner' },
    { at: at(2), event: 'assigned', work_item: tok, workflow: 'feature', agent_id: 'w1', task_id: 'dup', dispatch_id: 'd1', actor: 'agent:runner' },
    { at: at(3), event: 'lost', work_item: tok, workflow: 'feature', agent_id: 'w1', task_id: 'dup', dispatch_id: 'd1', reason: 'first leg died', actor: 'agent:runner' },
    // The pre-existing duplicate: closing-tolerated, and nothing else is wrong.
    { at: at(4), event: 'assigned', work_item: tok, workflow: 'feature', agent_id: 'w1', task_id: 'dup', dispatch_id: 'd2', actor: 'agent:runner' },
    { at: at(5), event: 'delivered', work_item: tok, workflow: 'feature', agent_id: 'w1', task_id: 'dup', dispatch_id: 'd2', terminal: 'done', timed_out: false, evidence_present: true, actor: 'agent:w1' },
    { at: at(6), event: 'completed', work_item: tok, workflow: 'feature', agent_id: 'w1', from_team: 'dev', actor: 'agent:runner' },
    { at: at(7), event: 'audit_requested', work_item: tok, workflow: 'feature', agent_id: 'ctl', task_id: 'ctl-1', reason: 'read it whole', actor: 'agent:runner' },
  ]
  writeFileSync(ledgerPath(dir, tok), `${custody.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

  const audited = appendEvent(dir, {
    at: at(8), event: 'audited', work_item: tok, workflow: 'feature',
    agent_id: 'ctl', verdict: 'accept', reason: 'read whole, accepted',
  }, { actor: 'agent:controller' })
  assert.equal(audited.ok, true,
    `a route that finished could not be audited closed on a tolerated ledger: ${audited.code} ${audited.detail}`)

  const tolerant = validateLedgerTolerant(readFileSync(ledgerPath(dir, tok), 'utf8').trim().split('\n'))
  assert.deepEqual(tolerant.blocking.map((problem) => problem.code), ['duplicate_task_id'],
    'closing the ledger must not have added a problem of its own')
})

// A count is not a status. `pull-controller.mjs --apply` printed "appended 0
// custody events" and exited 0 when every planned pull was refused, so a script
// driving it could not tell a quiet success from a total failure (r6-codex).
// The disagreement is real and expected: §14.5 says `planPulls` judges the
// parsed projection, which has already dropped unparsable lines, while the
// writer judges the bytes — so a token broken only by an unparsable line is
// planned as a pull and then refused.
test('pull --apply exits non-zero when the pulls it planned were refused', (t) => {
  const dir = scratch(t)
  const store = join(dir, '.tmux-teams')
  mkdirSync(join(store, 'work-items'), { recursive: true })
  writeFileSync(join(store, 'graph.json'), JSON.stringify({
    project_id: 'p', outer_controller_id: 'pm', outer_controller_model: 'test-model',
    teams: [
      { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1'], evaluator_id: 'b_e', models: { dispatcher: 'm', worker: 'm', evaluator: 'm' } },
      { team_id: 'test', name: 'Test', dispatcher_id: 't_d', worker_ids: ['t_w1'], evaluator_id: 't_e', models: { dispatcher: 'm', worker: 'm', evaluator: 'm' } },
    ],
    workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['build', 'test'] }],
  }))
  const at = (n) => new Date(Date.UTC(2026, 7, 4, 10, n)).toISOString()
  const custody = [
    { at: at(0), event: 'opened', work_item: 'tok', workflow: 'feature', agent_id: 'pm', to_team: 'control', reason: 'r', actor: 'human:ngs' },
    { at: at(1), event: 'pulled', work_item: 'tok', workflow: 'feature', agent_id: 'b_d', from_team: 'control', to_team: 'build', actor: 'agent:runner' },
    { at: at(2), event: 'intake', work_item: 'tok', workflow: 'feature', agent_id: 'b_d', verdict: 'accept', reason: 'fits the team', actor: 'agent:b_d' },
    { at: at(3), event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1', actor: 'agent:runner' },
    { at: at(4), event: 'delivered', work_item: 'tok', workflow: 'feature', agent_id: 'b_w1', task_id: 'b-1', dispatch_id: 'd-1', terminal: 'done', timed_out: false, evidence_present: true, actor: 'agent:b_w1' },
    { at: at(5), event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'b_e', task_id: 'r-1', dispatch_id: 'e-1', actor: 'agent:runner' },
    { at: at(6), event: 'reviewed', work_item: 'tok', workflow: 'feature', agent_id: 'b_e', verdict: 'pass', reviewed_task: 'b-1', dispatch_id: 'e-1', reason: 'does what was asked', actor: 'agent:b_e' },
  ]
  writeFileSync(join(store, 'work-items', 'tok.jsonl'),
    `${custody.map((entry) => JSON.stringify(entry)).join('\n')}\nthis line is not json at all\n`)

  const cli = join(dirname(fileURLToPath(import.meta.url)), '..',
    'plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs')
  const r = spawnSync(process.execPath, [cli, dir, '--apply'], { encoding: 'utf8' })
  assert.match(r.stdout, /pull\s+tok/, 'the fixture must actually plan a pull, or this proves nothing')
  assert.match(r.stdout, /appended 0 custody events/)
  assert.equal(r.status, 1, `a run that recorded none of its planned pulls exited ${r.status}`)
  assert.match(r.stderr, /1 of 1 planned pull\(s\) were REFUSED/)
})
