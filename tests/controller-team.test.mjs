// controller-team.test.mjs — the POC question, asked of the real runner.
//
// `references/controller-as-team.md` claims that making the controller an
// ordinary team is enough: work enters through it, and the FIRST delivery leg
// becomes an ordinary pull with a real sender, with no change to the pull system
// at all. This file asks the runtime whether that is true, through the same seam
// `loop-replay` uses — the real `tick()`, with only the ACP fork replaced.
//
// If these hold, the rest of that design has a foundation. If they do not, we
// found out for the price of one file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readWorkItems, teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { readWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import { admitWorkItem } from '../plugins/tmux-teams/skills/tmux-teams/scripts/admit.mjs'

const MODEL = 'inherit-account-default'
const team = (id, workers) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: workers,
  evaluator_id: `${id}_e`,
  models: { dispatcher: MODEL, worker: MODEL, evaluator: MODEL },
})

// The controller as an ordinary team: its one worker IS `outer_controller_id`,
// which is what turns the new rules on (§3 of the design).
const GRAPH = {
  project_id: 'poc',
  outer_controller_id: 'pm',
  outer_controller_model: MODEL,
  teams: [team('control', ['pm']), team('build', ['build_w1']), team('qa', ['qa_w1'])],
  workflows: [{ workflow_id: 'default', name: 'Default', route: ['control', 'build', 'qa'] }],
}

const dirs = []
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'controller-team-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'team-briefs'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'), JSON.stringify(GRAPH, null, 2))
  for (const entry of GRAPH.teams) {
    writeFileSync(join(dir, '.tmux-teams', 'team-briefs', `${entry.team_id}.md`), `# ${entry.name}\n\nDo the work.\n`)
  }
  return dir
}

const custody = (dir, token) => {
  const path = join(dir, '.tmux-teams', 'work-items', `${token}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// The operator: an agent writing on a person's behalf (§6.4 of the design).
// It goes through `admit.mjs` rather than straight at the writer, because the
// front door has a WIP rule of its own and the writer cannot see the graph.
const admit = (dir, token) => admitWorkItem(dir, {
  work_item: token, workflow: 'default', reason: 'a person asked for this',
}, { actor: 'human:someone' })

function driver() {
  let legs = 0
  return (repo, { workItem, role, agentId }) => {
    const taskId = `${workItem || 'board'}-${role}-${legs += 1}`
    const say = (event, extra) => {
      const result = appendEvent(repo, {
        event, work_item: workItem, workflow: 'default', agent_id: agentId, task_id: taskId, ...extra,
      }, { actor: `agent:${agentId}` })
      assert.ok(result.ok, `${event} refused for ${workItem}: ${result.code} ${result.detail}`)
    }
    const verdict = role === 'dispatcher' ? 'accept'
      : role === 'evaluator' ? 'pass'
        : role === 'pm' ? 'accept' : ''
    if (workItem) say('assigned', { dispatch_id: `d-${legs}` })
    writeFileSync(join(repo, '.mailbox-out', taskId),
      verdict ? `Did it.\n\nVERDICT: ${verdict}\nREASON: poc\n` : 'Did it.\n\nartifact\n')
    if (workItem) say('delivered', { terminal: 'done', timed_out: false, evidence_present: true })
    return taskId
  }
}

const quietTick = (dir, spawnLeg, extra = {}) => {
  const real = console.log
  console.log = () => {}
  try {
    return tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnLeg, ...extra })
  } finally { console.log = real }
}

// The controller's cooldown is 900 real seconds and this test runs in one, so
// its own note is backdated between ticks. Only the clock is moved.
function stepPastCooldown(dir) {
  const notes = join(dir, '.tmux-teams', 'pm-notes', 'latest.md')
  if (!existsSync(notes)) return
  const text = readFileSync(notes, 'utf8').split('\n')
  text[0] = new Date(Date.now() - 3600_000).toISOString()
  writeFileSync(notes, text.join('\n'))
}

test('the graph derives its controller team from the head of every route', () => {
  const dir = makeRepo()
  const graph = readWorkflowGraph(dir)
  assert.ok(graph.ok, graph.reason)
  assert.equal(graph.value.controller_team, 'control')
  assert.equal(graph.value.teams.find((entry) => entry.team_id === 'control').wip_limit, 1)
})

test('work enters through the controller and leaves it as an ordinary pull', () => {
  const dir = makeRepo()
  const spawnLeg = driver()
  assert.ok(admit(dir, 'token-1').ok)

  for (let round = 0; round < 30 && custody(dir, 'token-1').at(-1)?.event !== 'audited'; round += 1) {
    const result = quietTick(dir, spawnLeg)
    assert.ok(result.ok, result.reason)
    stepPastCooldown(dir)
  }

  const history = custody(dir, 'token-1')
  const events = history.map((entry) => entry.event)

  // The claim under test: admission is dispatcher work, and the handoff out of
  // the controller is a pull with a real sender — which the head of a route
  // could never have before.
  assert.deepEqual(events.slice(0, 5), ['opened', 'assigned', 'delivered', 'intake', 'pulled'],
    `admission did not take the designed shape: ${events.join(' -> ')}`)
  assert.equal(history[4].from_team, 'control')
  assert.equal(history[4].to_team, 'build')

  // The controller's worker is for unsticking, not for admitting. If it ran
  // here, every admitted token would pay for a leg that does nothing.
  assert.equal(history.some((entry) => entry.agent_id === 'pm' && entry.event === 'assigned'), false,
    'the controller worker was dispatched during a healthy admission')

  assert.equal(events.at(-1), 'audited', `the route did not finish: ${events.join(' -> ')}`)
})

test('the front door obeys the WIP limit, like every other handoff', () => {
  const dir = makeRepo()
  assert.ok(admit(dir, 'token-1').ok)

  // Master's rule, 2026-07-31: WIP counts the tokens a TEAM holds, whatever
  // role holds them, until they are pulled out. The controller holds one seat,
  // so the second request is refused at the door rather than queued behind it.
  const second = admit(dir, 'token-2')
  assert.equal(second.ok, false, 'a second request was admitted onto a full controller team')
  assert.equal(second.code, 'controller_full')
  assert.match(second.detail, /holding 1 of 1/)

  const graph = readWorkflowGraph(dir)
  const { counts } = teamOccupancy(graph.value, readWorkItems(dir).items)
  assert.equal(counts.get('control'), 1, 'the refused request left no token behind')

  // …and the door opens again once the token has moved on. Nothing about the
  // refusal is permanent: it is a queue, not a rejection.
  const spawnLeg = driver()
  for (let round = 0; round < 6 && counts.get('control') !== 0; round += 1) {
    quietTick(dir, spawnLeg)
    stepPastCooldown(dir)
    const now = teamOccupancy(readWorkflowGraph(dir).value, readWorkItems(dir).items)
    counts.set('control', now.counts.get('control'))
  }
  assert.equal(counts.get('control'), 0, 'the controller never released its token')
  const again = admit(dir, 'token-2')
  assert.ok(again.ok, `the door stayed shut after the queue moved: ${again.code} ${again.detail}`)
})

test('a graph with no controller team is refused at the door, not silently admitted', () => {
  const dir = makeRepo()
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'), JSON.stringify({
    ...GRAPH,
    teams: [team('build', ['build_w1']), team('qa', ['qa_w1'])],
    workflows: [{ workflow_id: 'default', name: 'Default', route: ['build', 'qa'] }],
  }, null, 2))
  const result = admitWorkItem(dir, { work_item: 'x', workflow: 'default', reason: 'r' }, { actor: 'human:someone' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_controller_team')
})

// ── the grill: a token blocked on a person ───────────────────────────────────

// The same driver, except the controller's gate asks instead of accepting the
// first time it sees this token. Everything else is the real runtime.
function grillingDriver(askOnce = new Set(['token-1'])) {
  const asked = new Set()
  let legs = 0
  return (repo, { workItem, role, agentId }) => {
    const taskId = `${workItem || 'board'}-${role}-${legs += 1}`
    const say = (event, extra) => {
      const result = appendEvent(repo, {
        event, work_item: workItem, workflow: 'default', agent_id: agentId, task_id: taskId, ...extra,
      }, { actor: `agent:${agentId}` })
      assert.ok(result.ok, `${event} refused for ${workItem}: ${result.code} ${result.detail}`)
    }
    let verdict = role === 'dispatcher' ? 'accept' : role === 'evaluator' ? 'pass' : role === 'pm' ? 'accept' : ''
    let reason = 'poc'
    if (role === 'dispatcher' && agentId === 'control_d' && askOnce.has(workItem) && !asked.has(workItem)) {
      asked.add(workItem)
      verdict = 'question'
      reason = 'who is the target customer, and what happens on timeout?'
    }
    if (workItem) say('assigned', { dispatch_id: `d-${legs}` })
    writeFileSync(join(repo, '.mailbox-out', taskId),
      verdict ? `Did it.\n\nVERDICT: ${verdict}\nREASON: ${reason}\n` : 'Did it.\n\nartifact\n')
    if (workItem) say('delivered', { terminal: 'done', timed_out: false, evidence_present: true })
    return taskId
  }
}

const answer = (dir, token, text) => appendEvent(dir, {
  event: 'answered', work_item: token, workflow: 'default',
  to_team: 'control', reason: text,
}, { actor: 'human:someone' })

test('a grilled token waits on a person, and the runner will not dispatch it', () => {
  const dir = makeRepo()
  const spawnLeg = grillingDriver()
  assert.ok(admit(dir, 'token-1').ok)

  quietTick(dir, spawnLeg)              // dispatches the grill
  const afterGrill = quietTick(dir, spawnLeg)  // harvests its question
  assert.equal(custody(dir, 'token-1').at(-1).event, 'questioned')

  // Parked, not skipped: the runner says who has to act, and dispatches nothing.
  const parked = quietTick(dir, spawnLeg)
  assert.equal(parked.started.length, 0, 'the runner paid for a leg while waiting on a person')
  const plan = parked.plans.find((entry) => entry.work_item === 'token-1')
  assert.equal(plan.action, 'waiting')
  assert.match(plan.reason, /target customer/)

  // …and it is still the controller's problem: WIP is held, not freed.
  const { counts } = teamOccupancy(readWorkflowGraph(dir).value, readWorkItems(dir).items)
  assert.equal(counts.get('control'), 1)
  assert.equal(admit(dir, 'token-2').code, 'controller_full')
  assert.ok(afterGrill.ok)
})

test('only a person can answer, and answering re-runs the grill', () => {
  const dir = makeRepo()
  const spawnLeg = grillingDriver()
  assert.ok(admit(dir, 'token-1').ok)
  quietTick(dir, spawnLeg)
  quietTick(dir, spawnLeg)
  assert.equal(custody(dir, 'token-1').at(-1).event, 'questioned')

  // A model cannot unblock itself. The actor vocabulary is closed and the
  // writer stamps it, so this is refused before it reaches the file.
  const forged = appendEvent(dir, {
    event: 'answered', work_item: 'token-1', workflow: 'default',
    to_team: 'control', reason: 'I decided it is clear enough',
  }, { actor: 'agent:control_d' })
  assert.equal(forged.ok, false)
  assert.match(forged.detail, /human actor/)

  assert.ok(answer(dir, 'token-1', 'small businesses; retry twice then fail').ok)
  for (let round = 0; round < 20 && custody(dir, 'token-1').at(-1)?.event !== 'audited'; round += 1) {
    quietTick(dir, spawnLeg)
    stepPastCooldown(dir)
  }
  const events = custody(dir, 'token-1').map((entry) => entry.event)
  assert.deepEqual(events.slice(0, 8),
    ['opened', 'assigned', 'delivered', 'questioned', 'answered', 'assigned', 'delivered', 'intake'],
    `the answer did not put the token back through the gate: ${events.join(' -> ')}`)
  assert.equal(events.at(-1), 'audited')
})

test('silence expires the request and frees the queue', () => {
  const dir = makeRepo()
  const spawnLeg = grillingDriver()
  assert.ok(admit(dir, 'token-1').ok)
  quietTick(dir, spawnLeg)
  quietTick(dir, spawnLeg)
  assert.equal(custody(dir, 'token-1').at(-1).event, 'questioned')

  // Ten minutes in production; seconds here. The threshold is config precisely
  // so this rule can be proved without faking a clock — and a test at 0 seconds
  // proves the RULE fires, never that production ships ten minutes.
  const expired = quietTick(dir, spawnLeg, { answerDeadlineSec: 0 })
  assert.equal(custody(dir, 'token-1').at(-1).event, 'abandoned')
  assert.match(custody(dir, 'token-1').at(-1).reason, /Unanswered: who is the target customer/)
  assert.equal(expired.started.length, 0)

  // The door is open again, which is the whole point of freeing it.
  const { counts } = teamOccupancy(readWorkflowGraph(dir).value, readWorkItems(dir).items)
  assert.equal(counts.get('control'), 0)
  assert.ok(admit(dir, 'token-2').ok)
})
