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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'

// Seeded so a failure is replayable. `Math.random` would report a different
// wedge every run and none of them twice.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const team = (id) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: [`${id}_w1`],
  evaluator_id: `${id}_e`,
  models: { dispatcher: 'inherit-account-default', worker: 'inherit-account-default', evaluator: 'inherit-account-default' },
})

const GRAPH = {
  project_id: 'replay',
  outer_controller_id: 'pm',
  outer_controller_model: 'inherit-account-default',
  teams: [team('build'), team('test')],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['build', 'test'] }],
}

const dirs = []
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'loop-replay-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'team-briefs'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'), JSON.stringify(GRAPH, null, 2))
  for (const entry of GRAPH.teams) {
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
