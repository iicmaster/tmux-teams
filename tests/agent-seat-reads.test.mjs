// agent-seat-reads.test.mjs — the D1 read facade (loop-system-contract.md
// §16): three questions an agent seat can ask without ever being handed a
// filesystem path, proven against a real synthetic ledger plus the wall test
// the task itself demands — no return value, from any function, in any
// shape (found, not-found, or fed a hostile argument), may contain
// `.jsonl`, `.tmux-teams`, or an absolute path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fetchDelivery, legOutcomes, listDeliveries,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/agent-seat-reads.mjs'
import { checkLedgerReaderRatchet } from '../scripts/ledger-reader-ratchet.mjs'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-seat-reads-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeLedger(repo, workItem, lines) {
  const dir = join(repo, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true })
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  writeFileSync(join(dir, `${workItem}.jsonl`), text)
}

function writeOutbox(repo, taskId, content) {
  const dir = join(repo, '.mailbox-out')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, taskId), content)
}

// A route with three rejections before a pass — the exact shape the module's
// own doc comment names ("an evaluator that has rejected the same thing
// three times should know that") — plus one leg that never delivered
// (`lost`), so every member of §4's `LEG_OUTCOME_EVENTS` is exercised.
const TOK1 = [
  { at: '2026-08-05T09:00:00.000Z', event: 'opened', work_item: 'tok1', workflow: 'feature', agent_id: 'build_dispatcher', to_team: 'build', reason: 'entered', actor: 'human:master' },
  { at: '2026-08-05T09:00:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't1', dispatch_id: 'd1' },
  { at: '2026-08-05T09:05:00.000Z', event: 'delivered', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't1', terminal: 'done', evidence_present: true, work_observed: true },
  { at: '2026-08-05T09:05:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', task_id: 't2', dispatch_id: 'd2' },
  { at: '2026-08-05T09:06:00.000Z', event: 'reviewed', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', verdict: 'reject', reviewed_task: 't1', reason: 'missing tests' },
  { at: '2026-08-05T09:06:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't3', dispatch_id: 'd3' },
  { at: '2026-08-05T09:10:00.000Z', event: 'delivered', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't3', terminal: 'done', evidence_present: true, work_observed: true },
  { at: '2026-08-05T09:10:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', task_id: 't4', dispatch_id: 'd4' },
  { at: '2026-08-05T09:11:00.000Z', event: 'reviewed', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', verdict: 'reject', reviewed_task: 't3', reason: 'still missing tests' },
  { at: '2026-08-05T09:11:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't5', dispatch_id: 'd5' },
  { at: '2026-08-05T09:15:00.000Z', event: 'delivered', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't5', terminal: 'done', evidence_present: true, work_observed: true },
  { at: '2026-08-05T09:15:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', task_id: 't6', dispatch_id: 'd6' },
  { at: '2026-08-05T09:16:00.000Z', event: 'reviewed', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', verdict: 'reject', reviewed_task: 't5', reason: 'tests present, still failing' },
  { at: '2026-08-05T09:16:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't7', dispatch_id: 'd7' },
  { at: '2026-08-05T09:20:00.000Z', event: 'delivered', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w1', task_id: 't7', terminal: 'done', evidence_present: true, work_observed: true },
  { at: '2026-08-05T09:20:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', task_id: 't8', dispatch_id: 'd8' },
  { at: '2026-08-05T09:21:00.000Z', event: 'reviewed', work_item: 'tok1', workflow: 'feature', agent_id: 'build_evaluator', verdict: 'pass', reviewed_task: 't7', reason: 'tests pass now' },
  { at: '2026-08-05T09:21:01.000Z', event: 'assigned', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w2', task_id: 't9', dispatch_id: 'd9' },
  { at: '2026-08-05T09:25:00.000Z', event: 'lost', work_item: 'tok1', workflow: 'feature', agent_id: 'build_w2', task_id: 't9', reason: 'process vanished' },
]

// A second, unrelated token whose own delivery id happens to collide with
// nothing on tok1 — proves a delivery id is scoped to the token it was
// listed for, not fetchable globally.
const TOK2 = [
  { at: '2026-08-05T09:00:00.000Z', event: 'opened', work_item: 'tok2', workflow: 'feature', agent_id: 'build_dispatcher', to_team: 'build', reason: 'entered', actor: 'human:master' },
  { at: '2026-08-05T09:00:01.000Z', event: 'assigned', work_item: 'tok2', workflow: 'feature', agent_id: 'build_w1', task_id: 'tok2-t1', dispatch_id: 'e1' },
  { at: '2026-08-05T09:05:00.000Z', event: 'delivered', work_item: 'tok2', workflow: 'feature', agent_id: 'build_w1', task_id: 'tok2-t1', terminal: 'done', evidence_present: true, work_observed: true },
]

function seedRepo(t) {
  const repo = scratch(t)
  writeLedger(repo, 'tok1', TOK1)
  writeLedger(repo, 'tok2', TOK2)
  writeOutbox(repo, 't1', '# Delivery t1\n\nThe first attempt, no tests.\n')
  // t3 deliberately has NO outbox file: the ledger says the leg delivered,
  // but the bytes are gone — `content_available: false`, not a thrown error.
  writeOutbox(repo, 't5', '# Delivery t5\n\nTests added, still failing.\n')
  writeOutbox(repo, 't7', `# Delivery t7\n\n${'x'.repeat(300 * 1024)}\n`)
  writeOutbox(repo, 'tok2-t1', '# tok2 delivery\n\nUnrelated token.\n')
  return repo
}

// ---------------------------------------------------------------------------
// 1. listDeliveries
// ---------------------------------------------------------------------------

test('listDeliveries lists every delivered leg, oldest first, with no content', (t) => {
  const repo = seedRepo(t)
  const result = listDeliveries(repo, 'tok1')
  assert.equal(result.work_item, 'tok1')
  assert.deepEqual(result.deliveries.map((d) => d.id), ['t1', 't3', 't5', 't7'])
  const first = result.deliveries[0]
  assert.equal(first.agent_id, 'build_w1')
  assert.equal(first.at, '2026-08-05T09:05:00.000Z')
  assert.equal(first.terminal, 'done')
  assert.equal(first.work_observed, true)
  assert.equal(first.evidence_present, true)
  assert.equal('content' in first, false, 'listing must never inline content')
})

test('listDeliveries returns null for a work item with no ledger', (t) => {
  const repo = seedRepo(t)
  assert.equal(listDeliveries(repo, 'no-such-token'), null)
})

// ---------------------------------------------------------------------------
// 2. fetchDelivery
// ---------------------------------------------------------------------------

test('fetchDelivery returns the exact outbox content for a listed id', (t) => {
  const repo = seedRepo(t)
  const piece = fetchDelivery(repo, 'tok1', 't1')
  assert.equal(piece.id, 't1')
  assert.equal(piece.agent_id, 'build_w1')
  assert.equal(piece.content, '# Delivery t1\n\nThe first attempt, no tests.\n')
  assert.equal(piece.content_available, true)
  assert.equal(piece.truncated, false)
})

test('fetchDelivery reports a missing outbox as unavailable, not as not-found', (t) => {
  const repo = seedRepo(t)
  const piece = fetchDelivery(repo, 'tok1', 't3')
  assert.notEqual(piece, null, 'the ledger DID record this delivery')
  assert.equal(piece.content, '')
  assert.equal(piece.content_available, false)
})

test('fetchDelivery truncates an oversized piece and says so', (t) => {
  const repo = seedRepo(t)
  const piece = fetchDelivery(repo, 'tok1', 't7')
  assert.equal(piece.truncated, true)
  assert.equal(piece.content.length, 256 * 1024)
})

test('fetchDelivery returns null for an id this token never delivered', (t) => {
  const repo = seedRepo(t)
  assert.equal(fetchDelivery(repo, 'tok1', 'not-a-real-id'), null)
  // t2 is a real task_id in this ledger, but it belongs to a `reviewed` leg,
  // never a `delivered` one — not something listDeliveries would ever name.
  assert.equal(fetchDelivery(repo, 'tok1', 't2'), null)
})

test('fetchDelivery scopes a delivery id to the token it was listed for', (t) => {
  const repo = seedRepo(t)
  // tok2's own delivery id is real, but not tok1's — fetching it through
  // tok1 must fail exactly like an id that never existed.
  assert.equal(fetchDelivery(repo, 'tok1', 'tok2-t1'), null)
  // And it works when asked through its own token.
  const piece = fetchDelivery(repo, 'tok2', 'tok2-t1')
  assert.equal(piece.content, '# tok2 delivery\n\nUnrelated token.\n')
})

test('fetchDelivery returns null for an unknown work item', (t) => {
  const repo = seedRepo(t)
  assert.equal(fetchDelivery(repo, 'no-such-token', 't1'), null)
})

test('fetchDelivery refuses a path-shaped id before ever touching the filesystem', (t) => {
  const repo = seedRepo(t)
  for (const hostile of ['../../etc/passwd', '/etc/passwd', 'a/b', '..', '']) {
    assert.equal(fetchDelivery(repo, 'tok1', hostile), null, `expected null for ${JSON.stringify(hostile)}`)
  }
})

// ---------------------------------------------------------------------------
// 3. legOutcomes
// ---------------------------------------------------------------------------

test('legOutcomes lists every closed leg and counts the rejections', (t) => {
  const repo = seedRepo(t)
  const result = legOutcomes(repo, 'tok1')
  assert.equal(result.work_item, 'tok1')
  assert.equal(result.reject_count, 3)
  assert.deepEqual(result.legs.map((leg) => leg.event),
    ['delivered', 'reviewed', 'delivered', 'reviewed', 'delivered', 'reviewed', 'delivered', 'reviewed', 'lost'])
  const verdicts = result.legs.filter((leg) => leg.event === 'reviewed').map((leg) => leg.verdict)
  assert.deepEqual(verdicts, ['reject', 'reject', 'reject', 'pass'])
  const lost = result.legs.find((leg) => leg.event === 'lost')
  assert.equal(lost.agent_id, 'build_w2')
  assert.equal(lost.reason, 'process vanished')
})

test('legOutcomes returns null for an unknown work item', (t) => {
  const repo = seedRepo(t)
  assert.equal(legOutcomes(repo, 'no-such-token'), null)
})

// ---------------------------------------------------------------------------
// THE WALL — no return value may contain a filesystem path, and no argument
// may be one. Every call above and below is replayed here so the wall is
// checked over the SAME calls the behavioural tests already made, not a
// hand-picked subset.
// ---------------------------------------------------------------------------

const PATH_SIGNS = ['.jsonl', '.tmux-teams', '.mailbox-out']
// A POSIX absolute path, or a Windows drive path — checked separately from
// the literal signs above because it is a shape, not a fixed substring.
const ABS_PATH_RE = /(^|[^A-Za-z0-9_.:-])\/[^\s"']*|[A-Za-z]:\\[^\s"']*/

function assertNoPathLeak(t, label, value) {
  const text = JSON.stringify(value)
  for (const sign of PATH_SIGNS) {
    assert.equal(text.includes(sign), false, `${label}: return value contains "${sign}": ${text}`)
  }
  assert.equal(ABS_PATH_RE.test(text), false, `${label}: return value looks like an absolute path: ${text}`)
}

test('the wall: no function return leaks a path, across every case above', (t) => {
  const repo = seedRepo(t)
  // `repo` itself is an absolute tmp-dir path — the strongest concrete check
  // available: no return value may echo the very argument that IS a path.
  const calls = [
    ['listDeliveries(tok1)', () => listDeliveries(repo, 'tok1')],
    ['listDeliveries(no-such-token)', () => listDeliveries(repo, 'no-such-token')],
    ['listDeliveries(path-shaped)', () => listDeliveries(repo, '../../etc/passwd')],
    ['fetchDelivery(tok1, t1)', () => fetchDelivery(repo, 'tok1', 't1')],
    ['fetchDelivery(tok1, t3 missing outbox)', () => fetchDelivery(repo, 'tok1', 't3')],
    ['fetchDelivery(tok1, t7 truncated)', () => fetchDelivery(repo, 'tok1', 't7')],
    ['fetchDelivery(tok1, not-a-real-id)', () => fetchDelivery(repo, 'tok1', 'not-a-real-id')],
    ['fetchDelivery(tok1, ../../etc/passwd)', () => fetchDelivery(repo, 'tok1', '../../etc/passwd')],
    ['fetchDelivery(tok1, /etc/passwd)', () => fetchDelivery(repo, 'tok1', '/etc/passwd')],
    ['fetchDelivery(no-such-token, t1)', () => fetchDelivery(repo, 'no-such-token', 't1')],
    ['legOutcomes(tok1)', () => legOutcomes(repo, 'tok1')],
    ['legOutcomes(no-such-token)', () => legOutcomes(repo, 'no-such-token')],
  ]
  for (const [label, run] of calls) {
    let value
    let thrown = null
    try {
      value = run()
    } catch (error) {
      thrown = error
    }
    assert.equal(thrown, null, `${label}: must not throw (a caught fs error must never become a raw throw)`)
    assertNoPathLeak(t, label, value)
    const text = JSON.stringify(value)
    assert.equal(text?.includes(repo) ?? false, false, `${label}: return value echoes the repo root itself: ${text}`)
  }
})

// ---------------------------------------------------------------------------
// The ratchet — proves this file goes through the sanctioned aggregate
// reader rather than reading a ledger by its own hand, and stays that way.
// ---------------------------------------------------------------------------

test('the ledger-reader ratchet stays green with this module in the tree', () => {
  const result = checkLedgerReaderRatchet()
  assert.equal(result.ok, true, `ratchet must stay green: extra readers = ${JSON.stringify(result.extra)}`)
  assert.equal(
    result.extra.some((r) => r.file === 'agent-seat-reads.mjs'),
    false,
    'agent-seat-reads.mjs must go through the sanctioned aggregate reader, not read a ledger by its own hand',
  )
})
