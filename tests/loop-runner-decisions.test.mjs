// loop-runner-decisions.test.mjs — the tick's own refusals, readable after
// the log has scrolled past.
//
// C1: every reason the runner passed over a token used to go to `log()` and
// nowhere else — a token nobody looked at this tick and a token the runner
// considered and declined were, the instant the tick ended, indistinguishable.
// `.tmux-teams/decisions/latest.json` is the fix (contract ข้อ 11.3):
// overwritten whole every tick, so it answers "why is it not moving right
// now" and nothing longer-lived than that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DECISIONS_DIR, DECISIONS_FILE, INHERIT_ACCOUNT_DEFAULT, tick,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'

// `workers` overridable so the control team D6 (2026-08-08) requires can name
// the outer controller as its one seat.
const team = (id, model, workers = null) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: workers ?? [`${id}_w1`],
  evaluator_id: `${id}_e`,
  models: { dispatcher: model, worker: model, evaluator: model },
})

const graphDecl = () => ({
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: INHERIT_ACCOUNT_DEFAULT,
  teams: [team('build', INHERIT_ACCOUNT_DEFAULT), team('control', INHERIT_ACCOUNT_DEFAULT, ['pm'])],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build'] }],
})

const at = (index) => `2026-07-27T0${index}:00:00.000Z`

// A token that ran its whole route and was already read as a whole: `build`
// released it at `completed`, and `audited` closed the audit flag too — no
// team holds it, so `planDispatches` never looks at it. This is the "nobody
// considered it" case.
const CLOSED = [
  { at: at(0), event: 'pulled', work_item: 'shipped', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
  { at: at(1), event: 'assigned', work_item: 'shipped', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-1', dispatch_id: 'd-1' },
  { at: at(2), event: 'delivered', work_item: 'shipped', workflow: 'feature', agent_id: 'build_w1', task_id: 'b-1', terminal: 'done', timed_out: false, evidence_present: true },
  { at: at(3), event: 'completed', work_item: 'shipped', workflow: 'feature', from_team: 'build' },
  { at: at(4), event: 'audit_requested', work_item: 'shipped', workflow: 'feature', agent_id: 'pm', task_id: 'pm-1', reason: 'read it' },
  { at: at(5), event: 'audited', work_item: 'shipped', workflow: 'feature', agent_id: 'pm', verdict: 'accept', reason: 'fine' },
]

// A token `build` accepted, with nobody free to hand it to: its only worker
// is busy on something else. `nextStep` returns `{ action: 'wait', reason:
// 'every worker on this team is busy' }` for it.
const HELD = [
  { at: at(0), event: 'pulled', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', from_team: 'build', to_team: 'build' },
  { at: at(1), event: 'assigned', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', dispatch_id: 'd-i' },
  { at: at(2), event: 'delivered', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', task_id: 'b-i', terminal: 'done', timed_out: false, evidence_present: true },
  { at: at(3), event: 'intake', work_item: 'wip', workflow: 'feature', agent_id: 'build_d', verdict: 'accept', reason: 'looks complete' },
]

const dirs = []
function repoWith({ ledgers = {}, busyAgentIds = [], pulseAgeSec = 5 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-decisions-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'team-briefs'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'), JSON.stringify(graphDecl(), null, 2))
  writeFileSync(join(dir, '.tmux-teams', 'team-briefs', 'build.md'), '# build\n\nDo the work.\n')
  writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
    generated_at: new Date(Date.now() - pulseAgeSec * 1000).toISOString(),
    runs: busyAgentIds.map((agentId) => ({
      agent_id: agentId, task_id: `${agentId}-busy`, dispatch_id: `${agentId}-busy-d`,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      state: 'running', liveness_evidence: null,
    })),
  }))
  for (const [workItem, lines] of Object.entries(ledgers)) {
    writeFileSync(join(dir, '.tmux-teams', 'work-items', `${workItem}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  }
  return dir
}

test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const decisionsPath = (dir) => join(dir, '.tmux-teams', DECISIONS_DIR, DECISIONS_FILE)
const readDecisions = (dir) => JSON.parse(readFileSync(decisionsPath(dir), 'utf8'))

// The runner's log is its report to an operator; a decision not said out loud
// is a decision nobody can audit. Captured, never left to print during a test.
function saying(run) {
  const said = []
  const real = console.log
  console.log = (line) => { said.push(String(line)) }
  try { return { result: run(), said } } finally { console.log = real }
}

test('a refused token is recorded with its reason, and a token nobody considered is absent — both in the same test', () => {
  const dir = repoWith({ ledgers: { shipped: CLOSED, wip: HELD }, busyAgentIds: ['build_w1'] })
  saying(() => tick(dir, { tickSec: 20 }))

  const doc = readDecisions(dir)
  assert.match(doc.tick_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const held = doc.decisions.find((entry) => entry.work_item === 'wip')
  assert.ok(held, `no decision recorded for the held token: ${JSON.stringify(doc.decisions)}`)
  assert.equal(held.action, 'wait')
  assert.match(held.reason, /every worker on this team is busy/)

  // `shipped` finished its route and released every team's hold on it —
  // `planDispatches` never visits it, so it must never appear here either.
  assert.equal(doc.decisions.some((entry) => entry.work_item === 'shipped'), false,
    'a closed token nobody evaluated this tick was recorded as a decision')
})

test('a dry run does not write the decisions file, so a simulation cannot impersonate a live tick', () => {
  const dir = repoWith({ ledgers: { wip: HELD }, busyAgentIds: ['build_w1'] })
  saying(() => tick(dir, { apply: false, tickSec: 20 }))
  assert.throws(() => readFileSync(decisionsPath(dir)), /ENOENT/)
})

test('a tick that returns before evaluating any token leaves an existing decisions file untouched', () => {
  const dir = repoWith({ ledgers: { wip: HELD }, busyAgentIds: ['build_w1'] })
  saying(() => tick(dir, { tickSec: 20 }))
  const before = readFileSync(decisionsPath(dir), 'utf8')
  assert.match(before, /"wip"/, 'the setup tick did not actually record anything to compare against')

  // A pulse older than PULSE_STALE_SEC (120s) makes the tick refuse before it
  // ever reaches `planDispatches` — the early-return path ข้อ 11.3 says must not
  // overwrite what the last full tick left.
  writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
    generated_at: new Date(Date.now() - 600 * 1000).toISOString(),
    runs: [],
  }))
  const { result } = saying(() => tick(dir, { tickSec: 20 }))
  assert.equal(result.stale, true)

  const after = readFileSync(decisionsPath(dir), 'utf8')
  assert.equal(after, before, 'a tick that never evaluated the board overwrote the last real answer')
})
