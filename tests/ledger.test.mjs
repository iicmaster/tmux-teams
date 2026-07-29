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
  agent_id: 'design_dispatcher', to_team: 'design', reason: 'opened from the quick-spec', ...extra,
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
