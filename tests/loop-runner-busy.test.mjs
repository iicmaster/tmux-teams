// loop-runner-busy.test.mjs — who counts as busy, and on whose word.
//
// GitHub #29: a review worker running the three-model gate for twenty-odd
// minutes was declared lost and replaced, twice on one token. It was never
// silent. The companion's own heartbeat said `tool_running` the whole time and
// pulse republished it on the row; the runner read only `state`, pulse's
// OS-level probe, which needs to miss for exactly one tick to lose a leg.
//
// So these tests are about a second witness, and about not believing it too
// long: a heartbeat older than the zombie window, or one that already said the
// leg ended, must not hold a token open forever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { busyAgents, planDispatches, recordDispatchClaim, releaseClaimsSettledInLedger }
  from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'

const NOW = Date.parse('2026-08-03T12:00:00.000Z')
const ZOMBIE_SEC = 180

const dirs = []
// One row, one agent, and the two things that disagree about it: `state` is
// what the process scan saw, `liveness_evidence` is what the companion said.
function repoWith({ state, livenessState, observedSecAgo }) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-busy-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams'), { recursive: true })
  const evidence = livenessState === null ? null : {
    schema_version: 'acp-liveness.v1',
    task_id: 't-1',
    dispatch_id: 'd-1',
    agent_id: 'review_w1',
    observed_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    liveness_state: livenessState,
    last_protocol_activity_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    last_meaningful_progress_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    termination_reason: null,
    active_tools: [],
    tools: {},
    stall_history: [],
  }
  writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
    generated_at: new Date(NOW - 5000).toISOString(),
    runs: [{
      agent_id: 'review_w1',
      task_id: 't-1',
      dispatch_id: 'd-1',
      started_at: new Date(NOW - 1500 * 1000).toISOString(),
      state,
      liveness_evidence: evidence,
    }],
  }))
  return dir
}

test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

test('a companion the process scan missed is still busy while its own heartbeat is fresh', () => {
  // The incident: `died` is what one ps sweep concluded about a worker that was
  // sitting inside a twenty-minute tool call. The heartbeat two seconds old is
  // the worker itself saying otherwise, and it is the one that was there.
  const dir = repoWith({ state: 'died', livenessState: 'tool_running', observedSecAgo: 2 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), true,
    'a live worker was free to be replaced')
})

test('a heartbeat older than the zombie window does not hold the leg open', () => {
  // Pulse keeps a liveness file readable for hours, which is right for a page
  // and far too long here. A companion that died without saying so must still
  // time out, or the token waits on a process that is gone.
  const dir = repoWith({ state: 'died', livenessState: 'tool_running', observedSecAgo: ZOMBIE_SEC + 1 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), false,
    'a stale heartbeat kept a dead leg busy')
})

test('a heartbeat that already said the leg ended does not hold it open', () => {
  // `completed` is the companion's last word. Counting it as busy would wedge a
  // token whose `delivered` never landed — held forever by evidence of finishing.
  const dir = repoWith({ state: 'died', livenessState: 'completed', observedSecAgo: 1 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), false,
    'a finished leg was counted as still working')
})

test('a WORKING pulse row whose own liveness says terminal does not hold the seat', () => {
  // The publisher ages a dead leg out only after GRACE_SEC; until then the
  // row can read 'starting'/'running' while the leg's own liveness file has
  // already said failed. busyAgents must trust the row's own evidence over
  // the row's not-yet-aged state (eventbox 2026-08-12: ~300s dispatcher
  // stalls after every failed agy leg).
  for (const state of ['starting', 'running', 'orphan_running']) {
    const dir = repoWith({ state, livenessState: 'failed', observedSecAgo: 1 })
    assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), false,
      `state '${state}' overrode its own terminal liveness and held the seat`)
  }
})

test('a WORKING pulse row with live liveness evidence still holds the seat', () => {
  const dir = repoWith({ state: 'running', livenessState: 'tool_running', observedSecAgo: 1 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), true,
    'a genuinely running leg was freed by the terminal guard')
})

test('a row with no liveness evidence still answers from the process scan alone', () => {
  // The ordinary case, and the one that must not regress: nothing the companion
  // wrote, so `state` is the whole answer — both ways.
  const running = repoWith({ state: 'running', livenessState: null, observedSecAgo: 0 })
  assert.equal(busyAgents(running, NOW).busy.has('review_w1'), true)
  const died = repoWith({ state: 'died', livenessState: null, observedSecAgo: 0 })
  assert.equal(busyAgents(died, NOW).busy.has('review_w1'), false)
})

// ---------------------------------------------------------------------------
// ADR 0004 — the third and second witnesses. Everything above answers from a
// pulse row; a repo with no publisher has none, and until 2026-08-09 that meant
// every in-flight leg read as dead and the same seat was dispatched again.

// A repo with NOTHING published — the shape the defect was measured in.
function bareRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'loop-claim-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true })
  return dir
}

const livenessFile = (dir, { taskId, agentId, state, observedSecAgo }) =>
  writeFileSync(join(dir, '.tmux-teams', 'liveness', `${taskId}.json`), JSON.stringify({
    schema_version: 'acp-liveness.v1',
    task_id: taskId,
    agent_id: agentId,
    observed_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    liveness_state: state,
  }))

test('a seat this process just dispatched is busy before any file exists', () => {
  // The whole window the claim exists for. No pulse.json, no liveness file yet
  // — the companion has not had time to write one. Without this the next tick,
  // a quarter second later, hands the same seat out again.
  const repo = bareRepo()
  const before = busyAgents(repo, NOW)
  assert.equal(before.busy.has('build_w1'), false, 'nothing dispatched yet')

  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'task-1', pid: null })
  const after = busyAgents(repo, NOW)
  assert.equal(after.busy.has('build_w1'), true)
  assert.equal(after.busyTasks.has('task-1'), true)
  // `missing` describes the snapshot, not what we know. Conflating the two
  // makes the log line that reports it false.
  assert.equal(after.missing, true)
})

test('the liveness file answers when there is no pulse.json at all', () => {
  // The witness that was always on disk and unread. This is what covers the
  // whole leg, not just the spawn window — and being a file it survives the
  // process boundary a cron-driven tick crosses.
  const repo = bareRepo()
  livenessFile(repo, { taskId: 'task-2', agentId: 'verify_w1', state: 'running', observedSecAgo: 2 })
  const seen = busyAgents(repo, NOW)
  assert.equal(seen.busy.has('verify_w1'), true)
  assert.equal(seen.busyTasks.has('task-2'), true)
})

test('a liveness file that is terminal or stale holds nothing open', () => {
  const ended = bareRepo()
  livenessFile(ended, { taskId: 'task-3', agentId: 'verify_w1', state: 'completed', observedSecAgo: 2 })
  assert.equal(busyAgents(ended, NOW).busy.has('verify_w1'), false, 'a finished leg is not busy')

  const old = bareRepo()
  livenessFile(old, { taskId: 'task-4', agentId: 'verify_w1', state: 'running', observedSecAgo: ZOMBIE_SEC + 5 })
  assert.equal(busyAgents(old, NOW).busy.has('verify_w1'), false, 'an observation past the zombie window is not evidence')
})

test('the ledger releases a claim on delivered or lost, and never on assigned', () => {
  // `assigned` lands seconds after dispatch and is written by the companion.
  // Releasing on it would hand the seat back while the leg is still running —
  // the same defect moved from 250ms to ZOMBIE_SEC, which is how the first
  // draft of ADR 0004 was written and why it was corrected.
  const repo = bareRepo()
  const ledger = (event, taskId) => new Map([['w', { custody: [{ event, task_id: taskId }] }]])

  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'task-5', pid: null })
  releaseClaimsSettledInLedger(repo, ledger('assigned', 'task-5'))
  assert.equal(busyAgents(repo, NOW).busy.has('build_w1'), true, 'assigned must NOT release the claim')

  releaseClaimsSettledInLedger(repo, ledger('delivered', 'task-5'))
  assert.equal(busyAgents(repo, NOW).busy.has('build_w1'), false, 'delivered releases it')

  // `lost` too: a leg correctly declared lost is legitimately reassigned, and a
  // claim outliving it would block the reassignment it exists to make safe.
  const second = bareRepo()
  recordDispatchClaim(second, { agentId: 'build_w1', taskId: 'task-6', pid: null })
  releaseClaimsSettledInLedger(second, ledger('lost', 'task-6'))
  assert.equal(busyAgents(second, NOW).busy.has('build_w1'), false, 'lost releases it')
})

test('a claim with no evidence of any kind does not outlive the grace window', () => {
  // Not elapsed time used as proof of death — a claim is not evidence a leg is
  // alive, it is this process's memory that it spawned one. A companion that
  // died before its first heartbeat would otherwise hold its seat, and through
  // the board-wide in-flight cap every other team's seats, for ever.
  const repo = bareRepo()
  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'task-7', pid: null })
  assert.equal(busyAgents(repo, Date.now()).busy.has('build_w1'), true, 'held while fresh')
  assert.equal(busyAgents(repo, Date.now() + 31_000).busy.has('build_w1'), false, 'released after the grace window')
})

test('the claim store is keyed by repo, not shared across them', () => {
  // One process calls busyAgents for more than one repository; a global store
  // would report the second repo busy because the first one dispatched.
  const a = bareRepo()
  const b = bareRepo()
  recordDispatchClaim(a, { agentId: 'build_w1', taskId: 'task-8', pid: null })
  assert.equal(busyAgents(a, NOW).busy.has('build_w1'), true)
  assert.equal(busyAgents(b, NOW).busy.has('build_w1'), false)
})

test('busyAgents hands back a fresh mutable Set every call', () => {
  // planDispatches adds to this Set in place and tick reads that mutation back
  // when it decides whether the outer controller is already running. A cached
  // or frozen Set would either break that read or let an in-tick decision write
  // itself into the claim store as if it had been confirmed.
  const repo = bareRepo()
  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'task-9', pid: null })
  const first = busyAgents(repo, NOW)
  first.busy.add('scratch_seat')
  const second = busyAgents(repo, NOW)
  assert.equal(second.busy.has('scratch_seat'), false, 'the mutation must not survive into the next call')
  assert.equal(second.busy.has('build_w1'), true, 'the claim itself still does')
})

// ---------------------------------------------------------------------------
// ADR 0004, the SECOND defect — inside one tick, not across two.
//
// `planDispatches` is called with `busy` as a parameter, so this drives it with
// an EMPTY set: no pulse row, no liveness file, no claim. That is not a
// contrived state — it is a runner process that has just started on a repo a
// previous process was dispatching in, which is exactly cron mode, and it is
// the only state where the in-tick marking is load-bearing. Every other path
// has already put the seat in `busy` before this function is reached, which is
// why a mutation removing this fix stayed GREEN until this test existed.

const twoWorkerGraph = {
  project_id: 'in-tick',
  outer_controller_id: 'pm',
  teams: [
    {
      team_id: 'build', name: 'Build', dispatcher_id: 'build_d', evaluator_id: 'build_e',
      worker_ids: ['build_w1', 'build_w2'], wip_limit: 2,
      agents: [
        { agent_id: 'build_d', role: 'dispatcher' }, { agent_id: 'build_w1', role: 'worker' },
        { agent_id: 'build_w2', role: 'worker' }, { agent_id: 'build_e', role: 'evaluator' },
      ],
    },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['build'] }],
}

// One token already holding `build_w1` with an open, RECENT `assigned` — young
// enough that `nextStep` answers `in-flight` from its age check rather than
// from `busy`, which is the branch that used to spend the WIP slot and forget
// the seat.
const heldAndWaiting = (now) => new Map([
  ['alpha', { work_item: 'alpha', workflow: 'feature', custody: [
    { at: new Date(now - 60_000).toISOString(), event: 'opened', work_item: 'alpha', workflow: 'feature', agent_id: 'build_d', to_team: 'build' },
    { at: new Date(now - 50_000).toISOString(), event: 'intake', work_item: 'alpha', workflow: 'feature', agent_id: 'build_d', team_id: 'build' },
    { at: new Date(now - 10_000).toISOString(), event: 'assigned', work_item: 'alpha', workflow: 'feature', agent_id: 'build_w1', task_id: 'alpha-w-1', dispatch_id: 'd-a1', team_id: 'build' },
  ] }],
  ['beta', { work_item: 'beta', workflow: 'feature', custody: [
    { at: new Date(now - 40_000).toISOString(), event: 'opened', work_item: 'beta', workflow: 'feature', agent_id: 'build_d', to_team: 'build' },
    { at: new Date(now - 30_000).toISOString(), event: 'intake', work_item: 'beta', workflow: 'feature', agent_id: 'build_d', team_id: 'build' },
  ] }],
])

test('a seat held in-flight is not handed to another token later in the SAME tick', () => {
  const now = Date.now()
  const busy = new Set()
  const plans = planDispatches(twoWorkerGraph, heldAndWaiting(now), busy, { now, busyTasks: new Set() })

  // `planDispatches` pushes no plan for an in-flight leg — it spends the slot
  // and continues — so alpha is deliberately absent from `plans`. What it does
  // leave behind is the mark on `busy`, asserted at the bottom, and that mark
  // is only possible because the verdict now names its seat: before ADR 0004
  // `nextStep` returned a bare `{ action: 'in-flight' }` and the caller had no
  // agent_id to add.
  assert.equal(plans.some((plan) => plan.work_item === 'alpha' && plan.action === 'dispatch'), false,
    `alpha is holding an open leg and must not be dispatched again: ${JSON.stringify(plans)}`)

  const beta = plans.find((plan) => plan.work_item === 'beta' && plan.action === 'dispatch')
  assert.ok(beta, `beta was never dispatched, so this test proved nothing: ${JSON.stringify(plans)}`)
  assert.notEqual(beta.agent_id, 'build_w1',
    'build_w1 is already holding alpha — handing it to beta in the same tick is the duplicate dispatch this closes')
  assert.equal(beta.agent_id, 'build_w2', 'the free seat is the one it should get')

  // And the caller's own Set carries the mark onward, which is what the rest of
  // the tick reads when it asks whether the outer controller is already running.
  assert.equal(busy.has('build_w1'), true, 'the held seat must be marked busy for the rest of the tick')
})

test('a seat held in-flight counts against the BOARD-WIDE cap, not just its team slot', () => {
  // The half the test above does not cover, and the panel said so in those
  // words. `inFlight` is seeded from `busy` before the loop, so a seat that
  // reaches the in-flight branch WITHOUT being in `busy` — which is the whole
  // reason that branch exists, a leg recognised by age — was never in the
  // number. It spent the team's WIP slot and left the board's cap untouched, so
  // `maxInFlight` could be exceeded by however many such seats one tick walks
  // past. Found by the release panel (codex lane, 2026-08-10, round 2).
  const now = Date.now()
  const busy = new Set()
  const plans = planDispatches(twoWorkerGraph, heldAndWaiting(now), busy, {
    now, busyTasks: new Set(), maxInFlight: 1,
  })

  const dispatched = plans.filter((plan) => plan.action === 'dispatch')
  assert.deepEqual(dispatched, [],
    'alpha already holds one leg and the board cap is 1 — beta must wait, not be paid for: '
    + JSON.stringify(plans))
  const waiting = plans.find((plan) => plan.work_item === 'beta' && plan.action === 'wait')
  assert.ok(waiting, `beta was neither dispatched nor named as waiting: ${JSON.stringify(plans)}`)
  assert.match(waiting.reason, /in flight across the board/,
    `beta waited for the wrong reason — the board cap is the one being tested: ${waiting.reason}`)

  // The control, and what it is worth: with room on the board the same fixture
  // DOES dispatch beta, so the assertion above is not passing on a build where
  // nothing is ever dispatched.
  const roomy = planDispatches(twoWorkerGraph, heldAndWaiting(now), new Set(), {
    now, busyTasks: new Set(), maxInFlight: 4,
  })
  assert.ok(roomy.some((plan) => plan.work_item === 'beta' && plan.action === 'dispatch'),
    'beta is not dispatchable even with a roomy cap, so the cap assertion above proves nothing')
})

test('a liveness file whose name does not match the task it claims is ignored', () => {
  // `livenessOnDisk` took `task_id` from any parseable `.json` in the liveness
  // directory without looking at the filename, so a stray or foreign file could
  // name a task it had no relationship to. That id reached `seen`,
  // `releaseSettledClaims` deleted the real claim, and the seat was dispatchable
  // again before its companion had produced any evidence at all. Found by the
  // release panel (codex lane, 2026-08-10, round 3).
  //
  // Not a trust boundary — this repo is explicit that a worker can write here —
  // but the difference between a stray file being ignored and it silently
  // freeing somebody else's seat.
  const repo = mkdtempSync(join(tmpdir(), 'loop-liveness-'))
  dirs.push(repo)
  mkdirSync(join(repo, '.tmux-teams', 'liveness'), { recursive: true })
  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'real-task', pid: process.pid })

  const row = (taskId) => JSON.stringify({
    schema_version: 'acp-liveness.v1',
    task_id: taskId,
    agent_id: 'build_w1',
    observed_at: new Date().toISOString(),
    liveness_state: 'completed',
  })

  // A file named after something else, claiming the real task.
  writeFileSync(join(repo, '.tmux-teams', 'liveness', 'foreign.json'), row('real-task'))
  assert.equal(busyAgents(repo).busy.has('build_w1'), true,
    'a mis-named liveness file released a live claim — the seat is now dispatchable with no evidence behind it')

  // The control: the companion writes `<task-id>.json`, and THAT one is read.
  writeFileSync(join(repo, '.tmux-teams', 'liveness', 'real-task.json'), row('real-task'))
  assert.equal(busyAgents(repo).busy.has('build_w1'), false,
    'a correctly named liveness file must still release the claim, or the check refuses everything')
})

test('a running liveness file refreshes a claim rather than deleting it', () => {
  // A liveness row says a leg is alive; it carries no work item. Deleting the
  // claim on it therefore threw away the TOKEN reservation while keeping the
  // seat busy — so the same token could be dispatched onto another free worker
  // the moment the companion's first heartbeat landed, which is a second or so
  // after the dispatch. Reproduced by the release panel (codex lane,
  // 2026-08-10, round 5).
  const repo = bareRepo()
  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'live-1', pid: process.pid, workItem: 'alpha' })
  livenessFile(repo, { taskId: 'live-1', agentId: 'build_w1', state: 'running', observedSecAgo: 1 })

  const running = busyAgents(repo, NOW)
  assert.equal(running.busy.has('build_w1'), true, 'the seat is busy either way — that was never the gap')
  assert.equal(running.busyItems.has('alpha'), true,
    'the token lost its reservation the moment its own heartbeat arrived')

  // And a FINISHED leg still releases both: `completed` is the companion's last
  // word and the claim must not outlive it.
  const done = bareRepo()
  recordDispatchClaim(done, { agentId: 'build_w1', taskId: 'done-1', pid: process.pid, workItem: 'beta' })
  livenessFile(done, { taskId: 'done-1', agentId: 'build_w1', state: 'completed', observedSecAgo: 1 })
  const settled = busyAgents(done, NOW)
  assert.equal(settled.busy.has('build_w1'), false, 'a finished leg holds no seat')
  assert.equal(settled.busyItems.has('beta'), false, 'a finished leg holds no token')
})

test('a dead pid ends a claim even while its last heartbeat still looks fresh', () => {
  // The refresh added last round ran BEFORE the pid check, so a companion that
  // wrote one heartbeat and then died held its seat and its token until that
  // heartbeat aged out — and a row stamped in the future never ages out, so the
  // claim renewed itself for ever and both advertised recoveries were
  // unreachable. Found by the release panel (codex lane, 2026-08-10, round 6).
  const reaped = spawnSync(process.execPath, ['-e', ''])
  const repo = bareRepo()
  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'gone-1', pid: reaped.pid, workItem: 'alpha' })
  livenessFile(repo, { taskId: 'gone-1', agentId: 'build_w1', state: 'running', observedSecAgo: 1 })

  const seen = busyAgents(repo, NOW)
  assert.equal(seen.busyItems.has('alpha'), false,
    'a fresh heartbeat from a process that is gone kept the token reserved')
})

test('a liveness observation dated in the future is no evidence — it neither refreshes nor releases', () => {
  // The first version of this test asserted the seat was NOT busy, and passed
  // for the wrong reason: the unreadable row had already been added to `seen`,
  // so the release path DELETED a claim whose child was still running. That is
  // worse than the "renews for ever" bug it replaced. A row the runner cannot
  // read is not evidence in EITHER direction — the claim must simply stand on
  // its own until pid death or grace. Found by the release panel (codex lane,
  // 2026-08-10, round 7).
  const repo = bareRepo()
  recordDispatchClaim(repo, { agentId: 'build_w1', taskId: 'future-1', pid: process.pid, workItem: 'alpha' })
  // An hour ahead: clock skew or a malformed write, never a fact.
  livenessFile(repo, { taskId: 'future-1', agentId: 'build_w1', state: 'running', observedSecAgo: -3600 })

  const seen = busyAgents(repo, NOW)
  assert.equal(seen.busy.has('build_w1'), true,
    'the claim was dropped on the strength of a row the runner refused to read — the leg is still running')
  assert.equal(seen.busyItems.has('alpha'), true, 'and the token went with it')

  // ...and it did not RENEW the claim either: with the pid gone, the claim ends.
  const reaped = spawnSync(process.execPath, ['-e', ''])
  const dead = bareRepo()
  recordDispatchClaim(dead, { agentId: 'build_w1', taskId: 'future-2', pid: reaped.pid, workItem: 'alpha' })
  livenessFile(dead, { taskId: 'future-2', agentId: 'build_w1', state: 'running', observedSecAgo: -3600 })
  assert.equal(busyAgents(dead, NOW).busy.has('build_w1'), false,
    'a future-dated row must not keep a dead leg alive')
})

test('a token dispatched by a PRIOR process is still held after this process restarts', () => {
  // Deliberately no `recordDispatchClaim`: that is what a cron-mode restart
  // looks like from inside the new process. `busy`/`busyTasks` already crossed
  // the boundary on the liveness row; `busyItems` came only from the in-memory
  // claim store, so the seat read busy and the token read free and the same
  // token went to a second seat. Reproduced by the release panel (codex lane,
  // 2026-08-10, round 9). The work item is read from the dispatch record the
  // companion writes beside the liveness file — no new file, no schema change.
  const repo = bareRepo()
  livenessFile(repo, { taskId: 'restart-1', agentId: 'build_w1', state: 'running', observedSecAgo: 2 })
  mkdirSync(join(repo, '.tmux-teams', 'dispatch'), { recursive: true })
  writeFileSync(join(repo, '.tmux-teams', 'dispatch', 'restart-1.md'),
    'task_id: restart-1\nagent_id: build_w1\nwork_item: gamma\n')

  const after = busyAgents(repo, NOW)
  assert.equal(after.busy.has('build_w1'), true, 'the seat already crossed the boundary — the control')
  assert.equal(after.busyItems.has('gamma'), true,
    'the token did not, so a restarted runner would pay for this work item twice')
})
