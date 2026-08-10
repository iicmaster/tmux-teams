// loop-replay.test.mjs — drive the real runner over random-but-legal agent
// behaviour and assert the one thing the loop promises: a token either moves or
// is named.
//
// Every other test in this suite states an expected answer and checks the code
// agrees. That catches a wrong answer; it cannot catch a MISSING one. The
// defects this loop has actually shipped were all missing answers — a `continue`
// on a branch nobody wrote a case for, a token whose last event no reader had a
// rule for, an escalation nothing ever came back to. Each one leaves a board
// that looks calm, and calm is indistinguishable from finished.
//
// So this test asserts no specific outcome at all. It plays out whole routes
// with the outcomes an agent may legally produce chosen at random, and fails on
// one condition: a token that gained no ledger line for several consecutive
// ticks while the runner never named it. That is the shape of every wedge above,
// and it is checkable without knowing which answer was right.
//
// What is simulated and what is not, precisely:
//   - The test plays the AGENTS. It writes the outbox an agent would write and,
//     standing in for acp-companion, the `assigned` and `delivered` events that
//     transport records — through the same sanctioned writer, so an illegal
//     history is refused here exactly as it would be in production.
//   - Everything else is the real runtime: `tick` composes harvest, pulls, WIP,
//     dispatch and escalation itself. The only seam is `spawnLeg`, which
//     replaces forking an ACP process with running the fake agent inline.
//
// Ceiling, stated rather than worked around: `tick` reads the wall clock
// directly, so ZOMBIE_SEC (180s), PM_COOLDOWN_SEC (900s) and STALL_SEC (1800s)
// are unreachable in a test that finishes in seconds. Consequence: the fake
// agent must deliver in the tick it was assigned (a leg left in flight would
// stay in flight forever), and the controller's cooldown is stepped past by
// backdating its own note — simulating time passing, never a decision.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { spawnSync } from 'node:child_process'
import { busyAgents, tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { answerQuestion, openQuestions } from '../plugins/tmux-teams/skills/tmux-teams/scripts/answer.mjs'

// Seeded so a failure is replayable. `Math.random` would report a different
// wedge every run and none of them twice.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// `workers` overridable so the control team D6 requires can name the outer
// controller as its one seat.
const team = (id, workers = null) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: workers ?? [`${id}_w1`],
  evaluator_id: `${id}_e`,
  models: { dispatcher: 'inherit-account-default', worker: 'inherit-account-default', evaluator: 'inherit-account-default' },
})

const GRAPH = {
  project_id: 'replay',
  outer_controller_id: 'pm',
  outer_controller_model: 'inherit-account-default',
  // D6 (2026-08-08): every graph declares a control team, entered by every route.
  teams: [team('build'), team('test'), team('control', ['pm'])],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'test'] }],
}

const dirs = []
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

// `graph` defaults to the module-level replay GRAPH so every existing caller
// is untouched; the AC1 reproduction below passes its own, because it needs a
// two-worker team and the replay GRAPH's `build` team declares one on purpose
// (see that test for why one worker cannot show the defect at all).
function makeRepo(graph = GRAPH) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-replay-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'team-briefs'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'), JSON.stringify(graph, null, 2))
  for (const entry of graph.teams) {
    writeFileSync(join(dir, '.tmux-teams', 'team-briefs', `${entry.team_id}.md`), `# ${entry.name}\n\nDo the work.\n`)
  }
  // No pulse.json on purpose. A snapshot with a fixed stamp goes stale within
  // two minutes of test time and `tick` then refuses to dispatch at all — every
  // tick a no-op, the invariant trivially satisfied, the test worthless. Absent
  // means "nothing has ever run here", which is true, and the runner proceeds.
  return dir
}

const custody = (dir, token) => {
  const path = join(dir, '.tmux-teams', 'work-items', `${token}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// The agent half of a leg: what it said. Verdict words come from the same
// vocabularies the briefs print, because an agent that invents a word is a
// different test — `readVerdict` already has it.
function agentOutbox(role, rand, brief = '') {
  if (role === 'dispatcher') return `Checked the handoff.\n\nVERDICT: ${rand() < 0.75 ? 'accept' : 'reject'}\nREASON: replay\n`
  if (role === 'evaluator') {
    const roll = rand()
    const verdict = roll < 0.6 ? 'pass' : roll < 0.9 ? 'reject' : 'unresolved'
    return `Reviewed it.\n\nVERDICT: ${verdict}\nREASON: replay\n`
  }
  if (role === 'pm') {
    // The controller answers the job its brief gave it — the same way a real one
    // does, by reading the brief. A fake that always answered in one vocabulary
    // would report every audit as a wedge; a fake that read no brief at all
    // could not tell the two jobs apart, which is precisely the ambiguity this
    // brief has to remove.
    // Matched on the line that names THIS leg's job, not on the two job
    // descriptions the bundled brief always prints — both of those quote both
    // vocabularies, so matching them would make the fake unable to tell either.
    // If this ever fails, the brief was reworded and the fake would otherwise
    // answer in the wrong vocabulary — which surfaces as a token wedged at
    // `audit_requested`, the exact symptom this fix removed. Fail on the cause.
    assert.match(brief, /this is the (audit|unstick) job|No single token is waiting/,
      'the pm brief no longer names which job this leg was given — update this fake; the loop may be fine')
    const audit = /this is the audit job/.test(brief)
    const roll = rand()
    const verdict = audit ? (roll < 0.8 ? 'accept' : 'concern') : (roll < 0.7 ? 'resume' : 'abandon')
    return `Read the board.\n\nVERDICT: ${verdict}\nREASON: replay\n`
  }
  return 'Did the work.\n\nThe artifact is here.\n'
}

test('a route replays to a decision, or the runner says which token it could not move', () => {
  const TICKS = 60
  // Consecutive silent ticks tolerated before a token counts as wedged. One is
  // ordinary (a WIP limit, an agent busy); three in a row with nothing recorded
  // and nothing said is the loop having quietly stopped.
  const PATIENCE = 3
  const TERMINAL = new Set(['audited', 'abandoned'])
  const seen = []

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rand = mulberry32(seed)
    const dir = makeRepo()
    let legs = 0

    const spawnLeg = (repo, { workItem, role, agentId }, briefPath) => {
      const taskId = `${workItem || 'board'}-${role}-${legs += 1}`
      // Read, not ignored: a brief nothing reads cannot be wrong, and this loop
      // has already shipped one that told an agent "the trigger above tells you
      // which job this is" when it did not.
      const brief = briefPath && existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : ''
      const say = (event, extra) => {
        const result = appendEvent(repo, {
          event, work_item: workItem, workflow: 'feature', agent_id: agentId, task_id: taskId, ...extra,
        }, { actor: `agent:${agentId}` })
        // The transport refusing to record its own leg is a defect in its own
        // right, and swallowing it here would leave the token looking wedged for
        // the wrong reason.
        assert.ok(result.ok, `seed ${seed}: the writer refused ${event} for ${workItem}: ${result.code} ${result.detail}`)
      }
      if (workItem) say('assigned', { dispatch_id: `d-${legs}` })
      writeFileSync(join(repo, ".mailbox-out", taskId), agentOutbox(role, rand, brief))
      if (!workItem) {
        // The outer controller's board leg, and the ONE thing this fake used to
        // leave out. The companion writes `.tmux-teams/liveness/<task>.json` for
        // every leg it runs — no role condition — and for this leg that file is
        // the only witness there will ever be: its ledger append is a deliberate
        // no-op, so no `assigned` or `delivered` ever carries this task id. A
        // fake that skipped it left the runner's dispatch claim with nothing
        // that could release it, and the loop wedged on a seat that in
        // production frees itself within a second. Written `completed` because
        // this fake answers in the same tick it is spawned: the file is SEEN
        // (which releases the claim) and is not LIVE (which is true — it is
        // done). Shape copied from the liveness fixture in
        // loop-runner-busy.test.mjs rather than invented here.
        mkdirSync(join(repo, '.tmux-teams', 'liveness'), { recursive: true })
        writeFileSync(join(repo, '.tmux-teams', 'liveness', `${taskId}.json`), JSON.stringify({
          schema_version: 'acp-liveness.v1',
          task_id: taskId,
          dispatch_id: `d-${legs}`,
          agent_id: agentId,
          observed_at: new Date().toISOString(),
          liveness_state: 'completed',
          last_protocol_activity_at: new Date().toISOString(),
          last_meaningful_progress_at: new Date().toISOString(),
          termination_reason: 'done',
          active_tools: [],
          tools: {},
          stall_history: [],
        }))
      }
      if (workItem) {
        // A worker that fails is legal and common; the runner is supposed to
        // retry it. Judging roles are dispatched to state a verdict, and a
        // verdict that never lands is `unresolved`, not a failed transport.
        const failed = role === 'worker' && rand() < 0.2
        say('delivered', {
          terminal: failed ? 'timeout' : 'done', timed_out: failed, evidence_present: !failed,
        })
      }
      return taskId
    }

    const tokens = ['alpha', 'beta']
    for (const token of tokens) {
      const seeded = appendEvent(dir, {
        event: 'opened', work_item: token, workflow: 'feature',
        agent_id: 'pm', to_team: 'build', reason: 'replay seed',
      }, { actor: 'human:replay' })
      assert.ok(seeded.ok, `seed ${seed}: could not open ${token}: ${seeded.detail}`)
    }

    const silent = new Map(tokens.map((token) => [token, 0]))
    const done = () => tokens.every((token) => TERMINAL.has(custody(dir, token).at(-1)?.event))

    for (let round = 0; round < TICKS && !done(); round += 1) {
      const before = new Map(tokens.map((token) => [token, custody(dir, token).length]))
      const said = []
      const real = console.log
      console.log = (line) => { said.push(String(line)) }
      let result
      try {
        result = tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnLeg })
      } finally { console.log = real }
      assert.ok(result.ok, `seed ${seed}: tick refused to run — ${result.reason}`)

      // The person. This replay had none, and did not need one until the front
      // door existed: the intake gate can OBJECT, and an objection parks the
      // token on a question that only a human can close. Without somebody to
      // answer, the loop stops — correctly, that is the whole stop mechanism —
      // and the wedge check below reads a working stop as a wedge. So the
      // simulation grew the half it was missing rather than the check growing
      // an exception. It also means every seed now exercises the real
      // `answer.mjs` path end to end: ask, hold, answer, resume.
      for (const owed of openQuestions(dir)) {
        const answered = answerQuestion(dir, {
          work_item: owed.work_item,
          reason: rand() < 0.8 ? 'go ahead' : 'proceed, and note the objection',
        }, { actor: 'human:replay' })
        assert.ok(answered.ok, `seed ${seed}: a question nobody could answer — ${answered.code}: ${answered.detail}`)
      }

      // A token queued behind a WIP limit is not wedged — the limit is the whole
      // point, and the token ahead of it is moving. Only a board where NOTHING
      // was recorded and NOTHING was started can wedge a token, so the tick's
      // own liveness is the gate on the per-token check below.
      const boardMoved = result.started.length > 0
        || tokens.some((token) => custody(dir, token).length > before.get(token))

      for (const token of tokens) {
        const history = custody(dir, token)
        const last = history.at(-1)
        if (TERMINAL.has(last?.event)) { silent.set(token, 0); continue }
        const moved = boardMoved || history.length > before.get(token)
        // "Named" means the runner told an operator this token is its problem —
        // an escalation it is acting on, or a leg it declared lost. `wait` and
        // `skip` are not naming: they are what a stopped loop prints forever.
        const named = result.plans.some((plan) => plan.work_item === token
          && (plan.action === 'escalate' || plan.action === 'lost'))
        silent.set(token, moved || named ? 0 : silent.get(token) + 1)
        assert.ok(silent.get(token) < PATIENCE,
          `seed ${seed}: ${token} recorded nothing and was never named for ${PATIENCE} ticks.\n`
          + `  last event: ${JSON.stringify(last)}\n`
          + `  plans this tick: ${JSON.stringify(result.plans)}\n`
          + `  the runner said:\n${said.map((line) => `    ${line}`).join('\n')}`)
      }

      // Step past the controller's cooldown. It is 900 real seconds and this
      // test runs in two, so without this every escalation after the first is
      // answered with `holding: ran 0s ago` and the replay measures the cooldown
      // rather than the loop. Only the clock is moved; the note's content — what
      // the controller was told — is left exactly as the runner wrote it.
      const notes = join(dir, '.tmux-teams', 'pm-notes', 'latest.md')
      if (existsSync(notes)) {
        const text = readFileSync(notes, 'utf8').split('\n')
        text[0] = new Date(Date.now() - 3600_000).toISOString()
        writeFileSync(notes, text.join('\n'))
      }
    }

    assert.ok(done(), `seed ${seed}: ${TICKS} ticks and these tokens never reached a decision: `
      + tokens.filter((token) => !TERMINAL.has(custody(dir, token).at(-1)?.event))
        .map((token) => `${token} at ${custody(dir, token).at(-1)?.event}`).join(', '))

    // Coverage, asserted rather than assumed. The invariant above is satisfied
    // just as well by a board where nothing ever happens, so a runtime that
    // starts refusing to dispatch — a stale-pulse rule that changes, a graph
    // reader that fails closed — would turn this whole test green and silent.
    // Naming the floor is what keeps that from reading as a pass.
    for (const token of tokens) seen.push(...custody(dir, token).map((entry) => entry.event))
    assert.ok(legs >= 4, `seed ${seed}: only ${legs} legs ran — the replay dispatched almost nothing`)
  }

  // Across the eight seeds the loop has to have exercised every gate at least
  // once: a team accepting a handoff, a worker delivering, an evaluator judging,
  // a route closing, and the controller answering. A vocabulary missing here is
  // a path this test never reached and therefore never checked.
  // Thirteen of the fourteen §4 events. `lost` is the one absentee and it is
  // absent by construction, not by luck: it needs an assignment older than
  // ZOMBIE_SEC and this test cannot reach 180 seconds — see the clock ceiling
  // at the top of the file. Anything else dropping out of this list means a
  // path the replay stopped covering.
  for (const event of ['opened', 'pulled', 'intake', 'returned', 'assigned', 'delivered', 'reviewed',
    'escalated', 'resumed', 'completed', 'audit_requested', 'audited', 'abandoned']) {
    assert.ok(seen.includes(event), `no replay ever produced a ${event} event — that path went unexercised (reached: ${[...new Set(seen)].sort().join(', ')})`)
  }
})

// ADR 0004 AC1 — "loop-replay carries a permanent invariant: for every
// agent_id, a new `assigned` never lands while that seat's previous task has
// no `delivered`. Checkable from the ledger alone." This is that test, and it
// states the invariant positively so the SAME assertion is the permanent
// guard once the fix lands: red today because the defect is real, green once
// a claim survives across ticks.
//
// Why the real runner can be made to reproduce this without a watcher, without
// real elapsed time, and without touching `loop-runner.mjs`:
//
// `busyAgents` (loop-runner.mjs ~299) reads occupancy from `pulse.json` alone,
// and `makeRepo` above never publishes one on purpose — so `busy`/`busyTasks`
// are an empty Set on every single tick, forever, in this harness. `nextStep`
// still protects a token's OWN parked leg from being re-dispatched, but it
// does that with an AGE check (`ageSec < zombieSec`), not with `busy` — and
// `planDispatches` only folds a seat into the shared `busy` it hands to LATER
// items in the same tick when it actually CHOOSES to dispatch
// (`busy.add(step.agent_id)`, ~1466). A token `nextStep` recognises as
// `in-flight` via the age check never reaches that line. So the seat's claim
// is real to the token that holds it and invisible to every other token —
// which is exactly the shape measured on 2026-08-09: a second token reaching
// the same team, one tick later, reads the seat as free.
//
// Two workers, not one, is what lets the real runner show this rather than
// hiding it behind a correct WIP block: `wip_limit` is derived from worker
// count (workflow-graph.mjs), so a one-worker team holds only one token at a
// time and the second token would wait on ITS OWN team's WIP long before the
// seat question is ever asked — proving nothing about seat reuse. With two
// workers both tokens are legally held by the team at once, and `want`'s
// `pool.find(agentId => !busy.has(agentId))` still hands BOTH of them
// `build_w1` — the first name in `worker_ids` — because nothing about the
// pick is randomised and `busy` never remembers who is holding it.
// The AC137 walk, lifted out of the driver below so the `lost` arm can be
// driven directly. A seat's leg is open from its `assigned` until that SAME
// task closes, and two events close it: `delivered` and `lost`. The runner
// releases the claim on either (`releaseClaimsSettledInLedger`), so a leg that
// ended `lost` is legitimately reassigned — asserting on `delivered` alone
// builds a false positive into the guard. The driver below cannot reach that
// arm: its fake agent always delivers in the tick it was assigned, so nothing
// there ever emits `lost`. That is why the arm gets its own test rather than
// a wider condition and a hope.
// TWO keys, and the second one took four review rounds to arrive. Keyed only by
// `agent_id` this proves AC1 as written — no SEAT receives a second `assigned`
// while holding one — and says nothing about the harm AC1 exists to prevent:
// with two free workers the same TOKEN was dispatched twice, on two different
// seats, because until its companion writes `assigned` nothing else records
// that it already has a leg. Re-keying this walk by `work_item` and re-running
// the replay below produced `alpha-worker-4` then `alpha-worker-6`, both for
// `alpha`, with no delivery between. Found by the release panel (codex lane,
// 2026-08-10, round 4), which named the probe as well as the defect.
const firstDoubleAssigned = (events, keyOf) => {
  const openLeg = new Map()
  for (const event of events) {
    const key = keyOf(event)
    if (!key) continue
    if (event.event === 'assigned') {
      const holding = openLeg.get(key)
      if (holding) return { violated: true, agent_id: event.agent_id, first: holding, second: event }
      openLeg.set(key, event)
    } else if ((event.event === 'delivered' || event.event === 'lost')
      && openLeg.get(key)?.task_id === event.task_id) {
      openLeg.delete(key)
    }
  }
  return { violated: false }
}

function firstDoubleAssignedSeat(events) {
  const bySeat = firstDoubleAssigned(events, (event) => event.agent_id)
  if (bySeat.violated) return { ...bySeat, keyed: 'seat' }
  const byToken = firstDoubleAssigned(events, (event) => event.work_item)
  if (byToken.violated) return { ...byToken, keyed: 'token' }
  return { violated: false }
}

test('ADR 0004 AC137: a leg that ended lost is legitimately reassigned, and the guard says so', () => {
  const seat = 'build_w1'

  // The arm the driver below cannot reach. `lost` closes the leg, so the
  // second `assigned` is a legal reassignment and not a double-dispatch.
  assert.equal(firstDoubleAssignedSeat([
    { event: 'assigned', agent_id: seat, task_id: 't1' },
    { event: 'lost', agent_id: seat, task_id: 't1' },
    { event: 'assigned', agent_id: seat, task_id: 't2' },
  ]).violated, false,
  'a seat reassigned after its own leg was declared lost is not a double-dispatch — '
  + 'asserting on `delivered` alone builds a false positive into the guard (ADR 0004, contract AC137)')

  // Without this half the case above also passes on a guard that answers
  // `violated: false` unconditionally.
  assert.equal(firstDoubleAssignedSeat([
    { event: 'assigned', agent_id: seat, task_id: 't1' },
    { event: 'assigned', agent_id: seat, task_id: 't2' },
  ]).violated, true, 'two `assigned` with nothing closing the first IS the violation AC137 names')

  // And widening the close must not widen it past the task: a close for some
  // other task leaves this seat's own leg open.
  assert.equal(firstDoubleAssignedSeat([
    { event: 'assigned', agent_id: seat, task_id: 't1' },
    { event: 'lost', agent_id: seat, task_id: 'a-different-task' },
    { event: 'assigned', agent_id: seat, task_id: 't2' },
  ]).violated, true, '`lost` for a different task does not free this seat')

  assert.equal(firstDoubleAssignedSeat([
    { event: 'assigned', agent_id: seat, task_id: 't1' },
    { event: 'delivered', agent_id: seat, task_id: 't1' },
    { event: 'assigned', agent_id: seat, task_id: 't2' },
  ]).violated, false, '`delivered` still closes a leg — the arm that already worked')

  // The TOKEN key. Two different seats, one token, no delivery between: every
  // seat-keyed assertion above passes on this history and it is still two paid
  // legs for one piece of work. Found by the release panel (codex lane,
  // 2026-08-10, round 4).
  const doubleToken = firstDoubleAssignedSeat([
    { event: 'assigned', agent_id: 'build_w1', work_item: 'alpha', task_id: 'a1' },
    { event: 'assigned', agent_id: 'build_w2', work_item: 'alpha', task_id: 'a2' },
  ])
  assert.equal(doubleToken.violated, true, 'one token, two seats, two open legs — that is a double dispatch')
  assert.equal(doubleToken.keyed, 'token', 'it must be reported as the token-keyed violation it is')

  // ...and the same token on a second seat AFTER its first leg closed is legal.
  assert.equal(firstDoubleAssignedSeat([
    { event: 'assigned', agent_id: 'build_w1', work_item: 'alpha', task_id: 'a1' },
    { event: 'delivered', agent_id: 'build_w1', work_item: 'alpha', task_id: 'a1' },
    { event: 'assigned', agent_id: 'build_w2', work_item: 'alpha', task_id: 'a2' },
  ]).violated, false, 'a token moving to the next seat after delivery is the normal route')
})

test('the outer controller board leg claims its seat, so busyAgents stops calling it idle', () => {
  // ADR 0004 says of this leg "only a pulse row, a liveness file or pid-death
  // can release it", and contract AC137 says "claims and liveness files cover
  // it". Both sentences presuppose a claim, and the controller branch recorded
  // none — so the instant after dispatching the outer controller, `busyAgents`
  // reported its seat as FREE. Found by the release panel (AGY lane,
  // 2026-08-10), round 2, inside the fix for the worker-side version.
  //
  // Three separate claims, kept apart on purpose, because two of the three
  // review lanes stated the third as fact and it is not:
  //
  //   1. The seat reads idle while its own leg runs. MEASURED — `busy` was
  //      empty the instant after the board leg was dispatched. This is what
  //      the assertion below covers.
  //   2. A SECOND BOARD leg on top of the first. Did NOT reproduce, and cannot:
  //      `PM_COOLDOWN_SEC` (900 s) answers `pm holding: outer controller ran 0s
  //      ago` on the next tick. Both the AGY and zai lanes read the missing
  //      claim as this, and neither accounted for the cooldown.
  //   3. A TEAM leg landing on the same seat inside the pre-liveness window —
  //      `pm` is a member of `control`, the cooldown does not guard that path,
  //      and a watcher tick at +0.27 s beats the companion's first liveness
  //      write. Structurally open and closed by this claim; NOT reproduced
  //      here, because a token has to clear intake before it can reach a worker
  //      seat and every probe written for it stalled at the dispatcher first.
  //
  // Only 1 is asserted. 3 is why the fix is worth having anyway, and it is
  // written as an open question rather than as a result.
  const graph = {
    project_id: 'board-claim',
    outer_controller_id: 'pm',
    outer_controller_model: 'inherit-account-default',
    teams: [team('build', ['build_w1']), team('control', ['pm'])],
    workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build'] }],
  }
  const dir = makeRepo(graph)

  const opened = appendEvent(dir, {
    event: 'opened', work_item: 'stuck', workflow: 'feature',
    agent_id: 'pm', to_team: 'control', reason: 'board claim',
  }, { actor: 'human:replay' })
  assert.ok(opened.ok, `could not open the token: ${opened.detail}`)
  // An `escalated` event is what makes `nextStep` answer `escalate`, which is
  // what puts a trigger on the board and dispatches the outer controller.
  const escalated = appendEvent(dir, {
    event: 'escalated', work_item: 'stuck', workflow: 'feature',
    agent_id: 'control_d', task_id: 'seed-task', to_team: 'control',
    reason: 'the team cannot proceed',
  }, { actor: 'agent:control_d' })
  assert.ok(escalated.ok, `could not escalate: ${escalated.detail}`)

  const result = tick(dir, {
    apply: true, scratchDir: join(dir, 'scratch'),
    spawnFn: () => ({ pid: process.pid, unref() {} }),
  })
  const board = (result?.started ?? []).filter((entry) => entry.role === 'pm')
  assert.equal(board.length, 1,
    `no outer-controller board leg was dispatched, so the assertion below would pass vacuously: ${JSON.stringify(result?.started)}`)

  // Nothing publishes a pulse row and the companion never ran, so no liveness
  // file exists either. The claim is the only thing that can answer this.
  assert.ok(busyAgents(dir).busy.has('pm'),
    'the outer controller was dispatched and its own seat reads as idle — ADR 0004 and contract '
    + 'AC137 both describe a claim covering this leg, and there was none')
})

test('tick is a synchronous function — ADR 0004 argues claims need no lock BECAUSE of it', () => {
  // The ADR states this as a dated observation ("verified 2026-08-09") with
  // nothing holding it: add one `await` to `tick` and its whole
  // no-lock-required argument silently becomes false while every test stays
  // green, because a single-threaded test never interleaves two ticks anyway.
  // Found by the release panel (zai lane, 2026-08-10) — a claim with no guard.
  assert.equal(tick.constructor.name, 'Function',
    'tick became async. ADR 0004: "ticks in one process are strictly serialised and a claim needs '
    + 'no lock to be correct" — that holds only while tick cannot yield. Either restore it, or '
    + 'amend the ADR and give DISPATCH_CLAIMS a lock.')

  // The line above is a SYNTACTIC proxy: it catches `async function tick`, and
  // not a plain function that returns a promise from an async helper. Raised as
  // non-blocking by the release panel (zai lane, 2026-08-10, round 2). Closing
  // it costs one real call, so it is closed rather than noted.
  const dir = makeRepo()
  const returned = tick(dir, { apply: false, scratchDir: join(dir, 'scratch') })
  assert.equal(typeof returned?.then, 'undefined',
    'tick returned a thenable. It is still declared synchronous, so the guard above passed while '
    + "ADR 0004's serialisation argument became false.")
})

// A WIRING test, and it has to be: `pidAlive` was correct, the release branch
// that calls it was correct, the contract and the ADR both advertised release
// "on a dead pid" — and the single production call site passed `pid: null`, so
// nothing ever reached any of it. Unit-testing `pidAlive` proves nothing about
// that; only driving `tick` and asking `busyAgents` does. Found by the release
// panel (zai and codex lanes, 2026-08-10).
test('ADR 0004: a dispatched leg carries its child pid, and a dead one frees the seat', () => {
  const graph = {
    project_id: 'claim-pid-wiring',
    outer_controller_id: 'pm',
    outer_controller_model: 'inherit-account-default',
    teams: [team('build', ['build_w1']), team('control', ['pm'])],
    workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build'] }],
  }

  // A pid that is certainly gone: a process this test started and reaped.
  const reaped = spawnSync(process.execPath, ['-e', ''])
  assert.ok(Number.isInteger(reaped.pid), 'could not obtain a reaped pid to test with')

  const drive = (pid) => {
    const dir = makeRepo(graph)
    const seeded = appendEvent(dir, {
      event: 'opened', work_item: 'tok', workflow: 'feature',
      agent_id: 'pm', to_team: 'control', reason: 'claim pid wiring',
    }, { actor: 'human:replay' })
    assert.ok(seeded.ok, `could not open the token: ${seeded.detail}`)

    // `spawnFn`, not `spawnLeg`: the inner seam, so the REAL `dispatch` runs and
    // is the thing that reads `child.pid`. Stubbing `spawnLeg` would skip the
    // code under test entirely — which is how this defect survived in the first
    // place.
    let spawns = 0
    const spawnFn = () => { spawns += 1; return { pid, unref() {} } }
    for (let i = 0; i < 3; i += 1) {
      tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnFn })
    }
    assert.ok(spawns > 0, 'no leg was dispatched at all — the assertion below would pass vacuously')
    // Nothing publishes a pulse row or a liveness file here, so the claim is
    // the only thing that can make a seat busy. That is the point.
    return busyAgents(dir).busy
  }

  assert.equal(drive(reaped.pid).size, 0,
    'a claim whose child pid is already gone must be released — the contract and ADR 0004 both '
    + 'advertise release on a dead pid, and it held the seat for the full CLAIM_GRACE_SEC instead')
  assert.ok(drive(process.pid).size > 0,
    'a claim whose child is alive must hold its seat — if this is empty the release is firing on '
    + 'everything and the dead-pid case above proves nothing')
})

test('ADR 0004 AC1: a seat holding an undelivered task never receives a second assigned', () => {
  // A minimal graph, not the replay GRAPH above: this needs `build` to have
  // two workers (see the comment above), and reusing the shared GRAPH would
  // have meant carrying that change into the randomised replay test too,
  // which does not need it and should not have its shape altered by this one.
  const graph = {
    project_id: 'ac1-seat-claim',
    outer_controller_id: 'pm',
    outer_controller_model: 'inherit-account-default',
    teams: [team('build', ['build_w1', 'build_w2']), team('control', ['pm'])],
    workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build'] }],
  }
  const dir = makeRepo(graph)

  // `to_team: 'control'`, not `'build'`: `agent_id: 'pm'` is a member of the
  // control team (it is the outer controller's own seat, D6), and
  // `teamOccupancy`/`planPulls` place a token by `teamOf(agent_id)` first —
  // `to_team` is only the fallback for an agent that belongs to no team.
  // Naming `'build'` here while `pm` resolves to `control` desynchronises
  // `ledger-validate.mjs`'s `atTheDoor`/`heldTeams` tracking (it stamps
  // whatever `to_team` said on `opened`, not the team that actually
  // admitted), and `planPulls` then reads `build` as already held and skips
  // straight to `completed` without ever reaching a worker — caught by
  // running this repro and watching `build_w1` never get dispatched at all.
  // `control` is where the token actually lands, so this is the correct
  // value, not a workaround.
  for (const token of ['alpha', 'beta']) {
    const seeded = appendEvent(dir, {
      event: 'opened', work_item: token, workflow: 'feature',
      agent_id: 'pm', to_team: 'control', reason: 'AC1 reproduction',
    }, { actor: 'human:replay' })
    assert.ok(seeded.ok, `could not open ${token}: ${seeded.detail}`)
  }

  let legs = 0
  // The FIRST worker leg this drives is left holding the seat on purpose —
  // no outbox, no `delivered` — which is the real shape of an agent still
  // running, not a shortcut around it: `planHarvest` only harvests a leg once
  // `.mailbox-out/<task>` exists, so a leg with no outbox is correctly left
  // alone by every tick that follows, exactly as a live one would be.
  let seatHeldOpen = false
  // NOTHING the companion does happens before `spawnLeg` returns, and that is
  // the whole point of this test. This fake used to write `assigned` inline and
  // return — closing, inside the dispatching tick, the exact window the claim
  // exists to cover. The cost was not theoretical: deleting
  // `recordDispatchClaim` from the worker branch — the central fix of ADR 0004,
  // the reason this release exists — left this test and the entire occupancy
  // suite GREEN. Found by the release panel (codex lane, 2026-08-10, round 3),
  // by reading the ORDERING rather than by running anything.
  //
  // So the fake now queues every write a real companion makes — `assigned`,
  // the outbox, `delivered` — and the queue is flushed at the START of the next
  // tick. Between the dispatch and that flush the claim is the only record that
  // the seat is taken, which is exactly the state production is in for the
  // second or so before the companion's first write lands.
  // TWO ticks of delay, not one, and the number comes off the measurements in
  // this repo rather than out of the air: the watcher fires ~0.27 s after a
  // change and a companion's first ledger write lands one to three seconds
  // after it is spawned, so several ticks pass with the claim as the only
  // record. A single tick of delay is NOT enough to make this test meaningful —
  // measured: with one tick, deleting `recordDispatchClaim` still left it
  // green, because the flush landed exactly in time for `nextStep`'s age check
  // to cover the seat instead.
  const pending = []
  let inFlightWrites = []
  const flushCompanionWrites = () => {
    const landing = inFlightWrites
    inFlightWrites = pending.splice(0, pending.length)
    for (const write of landing) write()
  }
  const drainCompanionWrites = () => { flushCompanionWrites(); flushCompanionWrites() }
  const spawnLeg = (repo, { workItem, role, agentId }) => {
    const taskId = `${workItem || 'board'}-${role}-${legs += 1}`
    const say = (event, extra) => {
      const result = appendEvent(repo, {
        event, work_item: workItem, workflow: 'feature', agent_id: agentId, task_id: taskId, ...extra,
      }, { actor: `agent:${agentId}` })
      assert.ok(result.ok, `the writer refused ${event} for ${workItem}: ${result.code} ${result.detail}`)
    }
    // Guarded on `workItem` the same way the replay harness's `spawnLeg` is:
    // the outer controller's own leg is dispatched with `workItem: ''`
    // (tick, `escalation.action === 'escalate'` branch) and has no work-item
    // ledger of its own to write into.
    if (workItem) pending.push(() => say('assigned', { dispatch_id: `d-${taskId}` }))
    if (role === 'worker' && !seatHeldOpen) {
      seatHeldOpen = true
      return taskId
    }
    pending.push(() => {
      writeFileSync(join(repo, '.mailbox-out', taskId), role === 'dispatcher'
        ? 'Checked the handoff.\n\nVERDICT: accept\nREASON: AC1 reproduction\n'
        : 'Did the work.\n\nThe artifact is here.\n')
      if (workItem) say('delivered', { terminal: 'done', timed_out: false, evidence_present: true })
    })
    return taskId
  }

  // Walks every work-item ledger in the repo — not just `alpha`/`beta`'s own
  // files read in isolation — because the defect this catches is cross-file:
  // a single item's own ledger can never carry two consecutive `assigned`
  // lines with no `delivered` between them (`nextStep` never re-dispatches a
  // token onto its own still-`assigned` leg), so the only place this
  // invariant can be violated is one AGENT's history spread across two
  // different tokens' ledgers.
  const assignedWithoutDelivered = () => {
    const itemsDir = join(dir, '.tmux-teams', 'work-items')
    const files = existsSync(itemsDir) ? readdirSync(itemsDir).filter((name) => name.endsWith('.jsonl')) : []
    // Prove the list is non-empty before trusting a clean walk over it — an
    // invariant checked against nothing has been satisfied by nothing.
    assert.ok(files.length > 0, 'no work-item ledger exists yet — the invariant below would pass vacuously; the driver above must open at least one token before this runs')
    const events = []
    for (const file of files) {
      const workItem = file.slice(0, -'.jsonl'.length)
      const lines = readFileSync(join(itemsDir, file), 'utf8').split('\n').filter(Boolean)
      lines.forEach((line, index) => events.push({ ...JSON.parse(line), work_item: workItem, line: index + 1 }))
    }
    // Chronological across files by `at`. Two ticks in this driver can land
    // in the same millisecond; `work_item` then `line` is a stable tiebreak
    // so a tie never reorders relative to the order this test itself wrote
    // it in (`alpha` was opened before `beta`, so it sorts first on a tie).
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1
      : a.work_item < b.work_item ? -1 : a.work_item > b.work_item ? 1 : a.line - b.line))
    // Same discipline: a runtime that stopped dispatching entirely — a
    // stale-pulse rule, a graph reader failing closed — would leave this
    // invariant trivially true for the wrong reason. Fail loudly instead of
    // reading silence as safety.
    //
    // Asserted AFTER the loop rather than inside it, because a companion's
    // writes now land on the tick after its dispatch: the first tick legally
    // ends with zero `assigned` on disk, which is the state the claim exists to
    // cover and not an absence of dispatching.
    return { ...firstDoubleAssignedSeat(events), assignedCount: events.filter((event) => event.event === 'assigned').length }
  }

  // Eight ticks is generous headroom, not a measured requirement — running
  // this measured exactly four: each token needs its OWN dispatcher accepted
  // twice, once at `control`'s door and once at `build`'s (every team gates
  // on its own dispatcher, this graph has two teams on the route), before
  // either can reach a worker at all, and only then does `alpha`'s open
  // `build_w1` leg get handed to `beta` too. The exact count is not the point
  // of this test, catching the violation is, so the loop keeps ticking until
  // it finds one or gives the ceiling a chance to say plainly that it never
  // reproduced.
  let outcome = { violated: false }
  let ticks = 0
  for (; ticks < 8 && !outcome.violated; ticks += 1) {
    // The previous tick's companions land now, not when they were spawned.
    flushCompanionWrites()
    const result = tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnLeg })
    assert.ok(result.ok, `tick refused to run — ${result.reason}`)
    outcome = assignedWithoutDelivered()
  }
  // Everything still queued lands, so the count below sees the whole run.
  drainCompanionWrites()
  const settled = assignedWithoutDelivered()

  // The DRAINED state, not just the state mid-loop. `settled` was computed and
  // then only `outcome` was asserted, so a duplicate landing in the final flush
  // was invisible. And counting `assigned` events was not enough either: a
  // mutation that made `nextStep` wait instead of dispatching workers left the
  // dispatcher assignments in place, `assignedCount > 0`, and this test —
  // whose entire subject is the pre-liveness WORKER window — green. Found by
  // the release panel (codex lane, 2026-08-10, round 6).
  assert.ok(seatHeldOpen,
    'no WORKER leg was ever dispatched, so the pre-liveness window this test is about never opened')
  assert.ok(settled.assignedCount > 0,
    `no assigned event was ever recorded after ${ticks} tick(s) — the invariant would pass `
    + 'vacuously; the driver above must actually dispatch a worker')
  assert.ok(!settled.violated,
    `ADR 0004 AC1 violated once every queued companion write had landed: ${settled.keyed} key, `
    + `${settled.agent_id} — ${JSON.stringify(settled.second)}`)
  assert.ok(!outcome.violated,
    `ADR 0004 AC1 violated after ${ticks} tick(s): ${outcome.agent_id} received a new assigned `
    + `(task ${outcome.second?.task_id} for ${outcome.second?.work_item}, at ${outcome.second?.at}) `
    + `while its previous task (${outcome.first?.task_id} for ${outcome.first?.work_item}, `
    + `assigned at ${outcome.first?.at}) still had no delivered. Measured on Ubuntu 26.04, `
    + '2026-08-09: `busy`/`busyTasks` come only from `pulse.json` (loop-runner.mjs `busyAgents`), '
    + 'nothing publishes one here on purpose, and a seat `nextStep` itself is holding via the age '
    + 'check is never folded into the `busy` Set other tokens in the same tick read — so a second '
    + 'token reaching this team reads the seat as free.')
})
