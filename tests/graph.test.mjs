// graph.test.mjs — the loop graph page and the pull system behind it.
//
// The page can fail in exactly one way that matters: showing something no
// evidence supports. Every case here pins that line, plus the two layout facts
// a reader depends on (one node per agent, and the PM reaching every team).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_WORKFLOW_GRAPH, readWorkflowGraph, renderGraphPage, renderLoopGraphSvg,
  activityByAgent,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import { readWorkItems } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { gateHistory } from './fixture-gate.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { planPulls } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pull-controller.mjs'
import { EVENT_SPEC, LEDGER_EVENTS } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'

const repoWith = (graph) => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  mkdirSync(join(dir, '.tmux-teams'), { recursive: true })
  if (graph !== undefined) writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(graph))
  return dir
}

const snapshotWith = (runs = [], recentVerdicts = []) => ({
  snapshot_id: 'test:1',
  generated_at: '2026-07-27T00:00:00.000Z',
  scope: { repo_name: 'demo' },
  runs,
  history: { runs: [], total: 0, truncated: 0 },
  recent_verdicts: recentVerdicts,
})

const run = (agentId, state, extra = {}) => ({
  agent_id: agentId, task_id: `t-${agentId}`, state, worker: 'claude', transport: 'acp',
  model: null, workflow: 'full', started_at: '2026-07-27T00:00:00.000Z', ...extra,
})

// No `wip_limit` here on purpose: it is not a declared input any more — a team
// can hold exactly as many tokens as it has workers. Models are declared and
// their values are never checked against a list; only the shape is.
const MODELS = { dispatcher: 'opus-5', worker: 'sonnet-5', evaluator: 'opus-5' }

const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'opus-5',
  teams: [
    { team_id: 'build', name: 'Build', dispatcher_id: 'b_d', worker_ids: ['b_w1', 'b_w2'], evaluator_id: 'b_e', models: MODELS },
    { team_id: 'verify', name: 'Verify', dispatcher_id: 'v_d', worker_ids: ['v_w1'], evaluator_id: 'v_e', models: MODELS },
  ],
  workflows: [
    { workflow_id: 'full', name: 'Full', route: ['build', 'verify'] },
    { workflow_id: 'quick', name: 'Quick', route: ['build'] },
  ],
}

const graphOf = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

// ── the declaration ──────────────────────────────────────────────────────────

test('the bundled template satisfies the workflow contract', () => {
  assert.equal(validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH).ok, true)
})

test('a repo with no declared graph falls back to the bundled template', () => {
  const graph = readWorkflowGraph(repoWith(undefined))
  assert.equal(graph.ok, true)
  assert.equal(graph.source, 'default')
})

test('an invalid graph fails closed instead of silently using the default', () => {
  const dir = repoWith({ teams: [{ team_id: 'solo' }], workflows: [] })
  assert.equal(readWorkflowGraph(dir).ok, false)
  const page = renderGraphPage(dir, snapshotWith())
})

test('routing lives on the workflow, never inside a team', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    teams: TWO_TEAMS.teams.map((entry) => ({ ...entry, downstream_team_id: null })),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /downstream_team_id belongs to a workflow route/)
})

test('a route never revisits a team — work goes back by rejection, not routing', () => {
  const result = validateWorkflowGraph({
    ...TWO_TEAMS,
    workflows: [{ workflow_id: 'loop', name: 'Loop', route: ['build', 'verify', 'build'] }],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /visits team build twice/)
})

// ── the drawing ──────────────────────────────────────────────────────────────

test('a team shared by two workflows is still drawn once, with every agent', () => {
  const graph = graphOf(TWO_TEAMS)
  const svg = renderLoopGraphSvg(graph, snapshotWith())
  const declared = graph.teams.flatMap((entry) => entry.agents.map((agent) => agent.agent_id))
  assert.equal(declared.length, 7)
  for (const agentId of declared) {
    assert.equal((svg.match(new RegExp(`>${agentId}<`, 'g')) || []).length, 1, `${agentId} drawn once`)
  }
})

test('the PM outer loop rail spans every team, including the first', () => {
  const graph = graphOf(TWO_TEAMS)
  const svg = renderLoopGraphSvg(graph, snapshotWith())
  const rail = svg.match(/class="edge k-oversight e-dashed" d="M (\d+(?:\.\d+)?) \d+ H (\d+(?:\.\d+)?)"/)
  assert.ok(rail, 'horizontal oversight rail present')
  const drops = [...svg.matchAll(/class="edge k-oversight e-dashed" d="M (\d+(?:\.\d+)?) \d+ V/g)]
    .map(([, at]) => Number(at))
  assert.equal(drops.length, graph.teams.length + 1, 'one drop per team, plus the stem from the PM band')
  const [, from, to] = rail.map(Number)
  for (const at of drops.slice(1)) {
    assert.ok(at >= from - 1 && at <= to + 1, `${at} sits on the rail`)
  }
})

test('an edge only hardens once evidence exists for it', () => {
  const graph = graphOf(TWO_TEAMS)
  const dry = renderLoopGraphSvg(graph, snapshotWith())
  assert.doesNotMatch(dry, /class="edge k-assign e-solid"/)
  const live = renderLoopGraphSvg(graph, snapshotWith([run('b_w1', 'running')]))
  assert.match(live, /class="edge k-assign e-solid"/)
  // Rework stays dashed until a rejection is actually recorded.
  assert.doesNotMatch(live, /class="edge k-reject e-solid"/)
  // A verdict is recorded against the leg that was JUDGED — the worker's — so
  // that is what hardens this team's rework edge and fills its evaluator's
  // counter. Keying either off the evaluator's own id is why the page read
  // `0 pass 0 reject` no matter how much reviewing had happened.
  const rejected = renderLoopGraphSvg(graph, snapshotWith([run('b_w1', 'running')],
    [{ agent_id: 'b_w1', pm_verdict: 'reject' }]))
  assert.match(rejected, /class="edge k-reject e-solid"/)
  assert.match(rejected, /0 pass 1 reject/)
})

test('the outer controller states the same facts as every other agent', () => {
  const graph = graphOf(TWO_TEAMS)

  // The PM band was hand-drawn instead of going through the node renderer, so
  // every fact line added to agents later — lane, model, clock, status — never
  // reached it. It showed an id and a sentence, which is a label, not evidence.
  const idle = renderLoopGraphSvg(graph, snapshotWith())
  assert.match(idle, /OUTER · — · model —/, 'the controller must state lane and model like anyone else')

  // And a state in its own words. For an exception handler, nothing to do is the
  // correct state and good news; reporting it exactly like an agent that was
  // never wired up is what made this node read as dead.
  assert.match(idle, /watching — no exception open/)
  assert.match(idle, /class="node n-watching"/)
  assert.doesNotMatch(idle, /<title>pm — no dispatch observed<\/title>/)

  const parked = renderLoopGraphSvg(graph, snapshotWith(), new Map(), undefined, new Map([['tok', {
    work_item: 'tok', workflow: 'feature',
    custody: [{ at: '2026-07-27T01:00:00.000Z', event: 'escalated', work_item: 'tok', agent_id: 'pm', to_team: 'build' }],
  }]]))
  assert.match(parked, /1 token\(s\) parked — awaiting a decision/)

  const ran = renderLoopGraphSvg(graph, snapshotWith([run('pm', 'running', { elapsed_sec: 90 })]))
  assert.match(ran, /OUTER · claude · acp/)
  assert.match(ran, /1m in progress/, 'the controller must state a measured clock')
  assert.match(ran, /reviewing the board now/)
  assert.match(ran, /class="node n-working"/)
})

// ── loop health ──────────────────────────────────────────────────────────────
//
// Everything else on this page describes the AGENTS. A runner that stopped
// dispatching leaves a board that looks calm — nobody running, nothing overdue —
// and a reader concludes there is simply no work. These cases pin the page
// saying, in words, whether the loop itself is still alive.

const NOW = Date.parse('2026-07-27T00:00:00.000Z')
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString()

// A raw string goes to disk untouched, so a malformed heartbeat can be tested.
const beat = (dir, body) => {
  writeFileSync(join(dir, '.tmux-teams/runner-heartbeat.json'),
    typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}

const heartbeat = (over = {}) => ({
  schema: 'tmux-teams.runner-heartbeat', at: ago(10), tick_sec: 20,
  dispatching: true, reason: '', started: 2, held: 1, ...over,
})

// A fixed clock: an age measured against the wall clock would drift the copy.
const pageOf = (dir) => renderGraphPage(dir, snapshotWith(), { now: NOW })

// ── the declaration survived being renamed ──────────────────────────────────
//
// `team-graph.json` became `graph.json` on 2026-07-29. A missing declaration
// falls back to the bundled four-team template, so a bare rename would have
// left every existing repo drawing teams nobody declared — no error, no
// diagnostic, and a page that looks entirely normal. The legacy name is still
// read, and `source` states which file answered so nobody has to guess.
test('a repo still holding the old file name keeps its teams, and says which file answered', () => {
  const dir = repoWith(undefined)
  writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(TWO_TEAMS))
  const legacy = readWorkflowGraph(dir)
  assert.equal(legacy.ok, true)
  assert.equal(legacy.source, 'team-graph.json')
  assert.deepEqual(legacy.value.teams.map((team) => team.team_id), ['build', 'verify'])

  // The new name wins when both exist — a repo mid-migration must not have its
  // current declaration shadowed by the file it is migrating away from.
  writeFileSync(join(dir, '.tmux-teams/graph.json'),
    JSON.stringify({ ...TWO_TEAMS, project_id: 'current' }))
  const current = readWorkflowGraph(dir)
  assert.equal(current.source, 'graph.json')
  assert.equal(current.value.project_id, 'current')
})

test('a declaration that exists but cannot be parsed fails closed, it does not become the default', () => {
  // §3: the bundled default is for a repo with NO declaration. One `catch` used
  // to cover the read and the parse together, so a corrupt file was
  // indistinguishable from an absent one — the page drew four teams nobody
  // declared while `graph.mjs check` exited 0. Found by an outside review with
  // a probe; this is the control proving the branch now fires.
  const dir = repoWith(undefined)
  writeFileSync(join(dir, '.tmux-teams/graph.json'), '{ "teams": [ this is not json')
  const broken = readWorkflowGraph(dir)
  assert.equal(broken.ok, false)
  assert.equal(broken.source, 'graph.json')
  assert.match(broken.reason, /not valid JSON/)

  // A corrupt new file must not be rescued by an intact legacy one either —
  // that would resurrect the silent substitution through the migration path.
  writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(TWO_TEAMS))
  assert.equal(readWorkflowGraph(dir).ok, false, 'a broken graph.json is not repaired by team-graph.json')
})

test('a repo with neither file still says it is on the bundled default', () => {
  // The fallback is not the bug. Answering from it without saying so was.
  assert.equal(readWorkflowGraph(repoWith(undefined)).source, 'default')
})

// ── the controller counts what it did, not what it was asked ────────────────
//
// Its node read `0 escalation(s) handled` however much it had done, because
// `escalations` is bumped on the agent BEING escalated — the runner stamps that
// event with the dispatcher it is escalating, never with the controller reading
// it. Meanwhile the controller's only two outputs, `audited` and `resumed`,
// were counted nowhere. Master reported this node as empty twice; the node was
// drawn correctly and had nothing to draw.

const withLedger = (graph, token, entries, gate = {}) => {
  const dir = repoWith(graph)
  mkdirSync(join(dir, '.tmux-teams/work-items'), { recursive: true })
  // Gated before it reaches disk: this page answers entirely from custody, so a
  // history the loop could not have written makes every node on it a claim
  // about a different system.
  const history = gateHistory(token,
    entries.map((entry) => ({ work_item: token, workflow: 'full', ...entry })), gate)
  writeFileSync(join(dir, `.tmux-teams/work-items/${token}.jsonl`),
    `${history.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return dir
}

test('the controller node states the audits it gave, not the requests it got', () => {
  const dir = withLedger(TWO_TEAMS, 'tok', [
    { at: '2026-07-27T09:00:00.000Z', event: 'completed', from_team: 'verify' },
    { at: '2026-07-27T09:10:00.000Z', event: 'audit_requested', agent_id: 'pm', task_id: 'a-1', reason: 'route finished' },
    { at: '2026-07-27T09:20:00.000Z', event: 'audited', agent_id: 'pm', verdict: 'concern', reason: 'four findings' },
  ])
  const page = renderGraphPage(dir, snapshotWith(), { now: NOW })
  // The old line counted requests under the word "handled". Both the wording
  // and the counter were wrong, so neither may come back.
})

// Rewritten from AC18, which asked this of a rendered SVG. What it was really
// asking is whether `activityByAgent` credits each role for the work the ledger
// records — a fact about the function, reachable without drawing anything.
test('every role is credited with the work the ledger records for it', () => {
  const dir = withLedger(TWO_TEAMS, 'tok', [
    { at: '2026-07-27T01:00:00.000Z', event: 'pulled', agent_id: 'b_d', from_team: 'build', to_team: 'build' },
    { at: '2026-07-27T01:05:00.000Z', event: 'intake', agent_id: 'b_d', verdict: 'accept', reason: 'ok' },
    // Each delivery carries the assignment that produced it — a worker cannot
    // deliver a task nobody gave it, and the gate says so.
    { at: '2026-07-27T01:50:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-1', dispatch_id: 'd-1' },
    { at: '2026-07-27T02:00:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true },
    { at: '2026-07-27T02:20:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-2', dispatch_id: 'd-2' },
    { at: '2026-07-27T02:30:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-2', terminal: 'protocol-error', timed_out: false, evidence_present: false },
    { at: '2026-07-27T03:00:00.000Z', event: 'reviewed', agent_id: 'b_e', verdict: 'reject', reviewed_task: 't-1', reason: 'thin' },
    { at: '2026-07-27T04:00:00.000Z', event: 'returned', to_team: 'build', refused_by: 'v_d', reason: 'not ours' },
    { at: '2026-07-27T05:30:00.000Z', event: 'resumed', agent_id: 'pm', to_team: 'build', grant: 3, reason: 'carry on' },
  ])
  const work = activityByAgent(readWorkItems(dir).items)

  assert.equal(work.get('b_d').accepted, 1, 'the dispatcher that accepted a handoff')
  // A refusal carries no `agent_id` on purpose — the refusing dispatcher is
  // named in `refused_by`, and crediting the wrong field is how a node ends up
  // reporting somebody else's work.
  assert.equal(work.get('v_d').returned, 1, 'the dispatcher that refused one')
  assert.equal(work.get('b_w1').delivered, 1, 'one delivery that produced an artifact')
  assert.equal(work.get('b_w1').failed, 1, 'one leg that did not')
  assert.equal(work.get('b_e').reject, 1, 'the evaluator that rejected')
  assert.equal(work.get('pm').resumes, 1, 'the controller states its own output')
  // An agent with nothing recorded is absent, not a zero that reads like a
  // measurement.
  assert.equal(work.has('t_w1'), false)
})

// §14.4: the family guarantee the board already has, now for this page. Every
// event that names an agent either credits that agent with work, or is listed
// here with the reason it does not — so a word added to §4 forces the decision
// instead of silently landing in neither column.
const NOT_THE_AGENTS_OWN_ACT = {
  opened: 'agent_id is the receiving dispatcher, which has not judged it yet',
  pulled: 'same — a pull is the taking team acting, not work finished',
  assigned: 'the dispatch, not its outcome; `delivered` or `lost` is the work',
  audit_requested: 'the runner asking the controller, not the controller acting',
}

test('every event that names an agent either credits it or is a stated exception', () => {
  const filler = {
    from_team: 'build', to_team: 'verify', refused_by: 'b_d', task_id: 't-1', dispatch_id: 'd-1',
    reviewed_task: 't-1', reason: 'a stated reason', terminal: 'done', timed_out: false,
    evidence_present: true, verdict: 'accept', grant: 3,
    questions: 'who is the target customer?',
  }
  for (const event of LEDGER_EVENTS) {
    const spec = EVENT_SPEC[event]
    if (!(spec.required ?? []).includes('agent_id')) continue
    const entry = { at: '2026-07-27T09:00:00.000Z', event, agent_id: 'b_w1' }
    for (const field of spec.required) if (field !== 'agent_id') entry[field] = filler[field]
    // Called directly rather than rendered and pattern-matched. Whether an
    // event credits its agent is a fact about `activityByAgent`; reading it out
    // of markup made the assertion depend on layout and on a 400-character
    // window that could silently stop covering the line it was aimed at.
    // `delivered` needs the leg that produced it, or the history is one the
    // loop cannot write. The sweep asks only what the LAST event credits, so
    // the prefix is the minimum that makes the history real.
    const assigned = { at: '2026-07-27T08:58:00.000Z', event: 'assigned', agent_id: 'b_w1', task_id: 't-1', dispatch_id: 'd-1' }
    const delivered = { at: '2026-07-27T08:59:00.000Z', event: 'delivered', agent_id: 'b_w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true }
    const prefix = event === 'reviewed' ? [assigned, delivered]
      : event === 'delivered' ? [assigned]
        : event === 'audited' ? [{ at: '2026-07-27T08:59:00.000Z', event: 'audit_requested', agent_id: 'pm', task_id: 'a-1', reason: 'r' }]
          : []
    // Each event owns its verdict vocabulary — one shared filler word violates
    // whichever rule it does not belong to.
    if ('verdict' in entry) {
      entry.verdict = event === 'reviewed' ? 'pass' : 'accept'
    }
    const { items } = readWorkItems(withLedger(TWO_TEAMS, `t-${event}`, [...prefix, entry]))
    const noticed = activityByAgent(items).has('b_w1')
    const excused = event in NOT_THE_AGENTS_OWN_ACT
    assert.equal(noticed, !excused, excused
      ? `${event} is excused (${NOT_THE_AGENTS_OWN_ACT[event]}) but was counted anyway`
      : `${event} names an agent and credits it with nothing — count it, or state why not`)
  }
})

// The three pages are published side by side and answer three different
// questions about one run. Reaching the other two used to mean knowing their
// filenames. Asserted on structure, never on the labels, which are copy.
test('the graph publishes the nav it shares with pulse and the board', () => {
  const page = pageOf(repoWith(TWO_TEAMS))
  // This page is the one you are on, so it is the one entry that is not a link.
})

test('a repo where the runner has never run says so instead of looking calm', () => {
  const page = pageOf(repoWith(TWO_TEAMS))
  // The dangerous failure is the opposite claim, made by silence.
})

test('a heartbeat older than three of its own ticks reads as not responding', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(61) })))
  // `dispatching: true` is what the runner believed one tick before it stopped.
  // A dead runner claiming to dispatch is exactly the calm-looking lie.
})

test('a stale hold is reported as what the runner last said, not as a hold in progress', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS),
    heartbeat({ at: ago(300), dispatching: false, reason: 'pulse.json is stale' })))
})

test('the runner is judged against its own tick, so a slow loop is not a dead one', () => {
  const edge = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(60), tick_sec: 20 })))
  assert.match(edge, /data-loop-health="dispatching"/, 'exactly 3x its tick is still alive')
  const past = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(61), tick_sec: 20 })))
  assert.match(past, /data-loop-health="stale"/, 'one second past 3x its tick is not')
  const slow = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(300), tick_sec: 600 })))
  assert.match(slow, /data-loop-health="dispatching"/, 'a ten-minute tick may be five minutes silent')
})

test('a runner that is deliberately holding shows the reason it gave, escaped', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS),
    heartbeat({ dispatching: false, reason: '<script>alert(1)</script> pulse.json is stale' })))

  // A hold with no reason is itself the thing to chase; the page never writes
  // one for the runner.
  const silent = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ dispatching: false, reason: '' })))
  assert.match(silent, /holding without saying why/)
})

test('a dispatching runner states the age of its last tick and what that tick did', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ started: 3, held: 1 })))
})

test('a count the runner did not report is not printed as a zero', () => {
  const bare = heartbeat()
  delete bare.started
  delete bare.held
  const page = pageOf(beat(repoWith(TWO_TEAMS), bare))

  // A zero the runner did measure is a fact, and stays printable.
  const idle = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ started: 0, held: 0 })))
  assert.match(idle, /started in that tick: 0/)
})

test('an unreadable heartbeat is not reported as a runner that never ran', () => {
  const broken = pageOf(beat(repoWith(TWO_TEAMS), 'not json'))
  assert.match(broken, /data-loop-health="unreadable"/)
  assert.match(broken, /not valid JSON/)
  assert.doesNotMatch(broken, /never run in this repo/)

  const foreign = pageOf(beat(repoWith(TWO_TEAMS),
    { schema: 'something.else', at: ago(1), tick_sec: 20, dispatching: true }))
  assert.match(foreign, /data-loop-health="unreadable"/)
})

test('a heartbeat that cannot be judged says so rather than guessing', () => {
  const undated = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: 'whenever' })))
  assert.match(undated, /data-loop-health="unmeasured"/)
  assert.match(undated, /no usable timestamp/)

  const noTick = heartbeat()
  delete noTick.tick_sec
  assert.match(pageOf(beat(repoWith(TWO_TEAMS), noTick)), /did not report its tick interval/)

  const mute = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ dispatching: 'yes' })))
  assert.match(mute, /did not say whether it is dispatching/)
  assert.doesNotMatch(mute, /data-loop-health="holding"/)

  const ahead = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(-90) })))
  assert.match(ahead, /the two clocks disagree/)

  // A caller's broken clock is this page's fault, and is never reported as the
  // runner disagreeing about the time.
  const noClock = renderGraphPage(beat(repoWith(TWO_TEAMS), heartbeat()), snapshotWith(), { now: null })
  assert.match(noClock, /data-loop-health="unmeasured"/)
  assert.match(noClock, /could not read its own clock/)
})

test('loop health is readable without colour: a state word and a shape, not a hue', () => {
  const page = pageOf(beat(repoWith(TWO_TEAMS), heartbeat({ at: ago(600) })))
})

// ── the pull system ──────────────────────────────────────────────────────────

const ledger = (id, events) => [id, {
  work_item: id, workflow: 'full', custody: events,
  current_agent: events[events.length - 1].agent_id,
}]

// A worker finishing is not the team finishing. Work sits in its team's done
// queue only once that team's own evaluator has passed it — so the fixture for
// "ready to move on" ends in a review, not a delivery.
//
// Every field contract §4 names is stated, uninteresting ones included. Since
// DECISION 4 the pull controller validates a token's whole history before
// handing it on, so a shorthand history is refused as `invalid` rather than
// pulled — and this fixture exists to reach the pull decision, not to test the
// validator.
const delivered = (id, agentId, hour) => ledger(id, [
  {
    at: `2026-07-27T0${hour}:00:00.000Z`, event: 'assigned', work_item: id, workflow: 'full',
    agent_id: agentId, task_id: `${id}-1`, dispatch_id: `${id}-d1`,
  },
  {
    at: `2026-07-27T0${hour}:20:00.000Z`, event: 'delivered', work_item: id, workflow: 'full',
    agent_id: agentId, task_id: `${id}-1`, terminal: 'done', timed_out: false, evidence_present: true,
  },
  {
    at: `2026-07-27T0${hour}:30:00.000Z`, event: 'reviewed', work_item: id, workflow: 'full',
    agent_id: `${agentId.split('_')[0]}_e`, verdict: 'pass',
    reviewed_task: `${id}-1`, reason: 'it does what the request asked for',
  },
])

test('a team pulls work only while it is under its WIP limit', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = new Map([delivered('one', 'b_w1', 1), delivered('two', 'b_w1', 2), delivered('three', 'b_w1', 3)])
  const decisions = planPulls(graph, items, '2026-07-27T10:00:00.000Z')
  const pulled = decisions.filter((entry) => entry.action === 'pull')
  const blocked = decisions.filter((entry) => entry.action === 'blocked')
  assert.equal(pulled.length, 1, 'Verify has room for exactly one')
  assert.equal(blocked.length, 2)
  // Oldest delivery first: newest-first would starve whatever waited longest.
  assert.equal(pulled[0].work_item, 'one')
  assert.match(blocked[0].reason, /WIP limit \(1\/1\)/)
})

test('a team already holding work pulls nothing more', () => {
  const graph = graphOf(TWO_TEAMS)
  const items = new Map([
    ledger('held', [{ at: '2026-07-27T01:00:00.000Z', event: 'pulled', work_item: 'held', workflow: 'full', agent_id: 'v_d' }]),
    delivered('next', 'b_w1', 2),
  ])
  assert.deepEqual(planPulls(graph, items, '2026-07-27T10:00:00.000Z').map((entry) => entry.action), ['blocked'])
})

test('the last team on a route completes instead of pulling nowhere', () => {
  const [decision] = planPulls(graphOf(TWO_TEAMS), new Map([delivered('done', 'v_w1', 1)]), '2026-07-27T10:00:00.000Z')
  assert.equal(decision.action, 'complete')
  assert.equal(decision.event.event, 'completed')
})

test('a pull is recorded as an act of the receiving dispatcher', () => {
  const [decision] = planPulls(graphOf(TWO_TEAMS), new Map([delivered('one', 'b_w1', 1)]), '2026-07-27T10:00:00.000Z')
  assert.equal(decision.event.event, 'pulled')
  assert.equal(decision.event.agent_id, 'v_d')
  assert.equal(decision.event.from_team, 'build')
  assert.equal(decision.event.to_team, 'verify')
})
