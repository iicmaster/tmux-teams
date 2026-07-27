import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildAgentGraphModel,
  buildLoopGraphNodes,
  normalizeTeamGraph,
  renderPulseLoopGraph,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-loop-graph.mjs'
import { validateTeamRuntime } from '../plugins/tmux-teams/skills/tmux-teams/scripts/team-runtime.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GRAPH_SOURCE = readFileSync(
  join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse-loop-graph.mjs'),
  'utf8',
)
const TOPOLOGY_SOURCE = readFileSync(
  join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse-loop-graph-topology.mjs'),
  'utf8',
)
const FIXED = '2026-07-25T11:00:00.000Z'
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`

function snapshot(overrides = {}) {
  return {
    schema: 'tmux-teams.pulse',
    schema_version: 4,
    stream_id: '11111111-1111-4111-8111-111111111111',
    sequence: 7,
    snapshot_id: '11111111-1111-4111-8111-111111111111:7',
    generated_at: FIXED,
    complete: true,
    scope: { repo_name: 'flow-fixture' },
    observation: {
      refresh_interval_sec: 20,
      expires_at: '2099-07-25T11:00:00.000Z',
    },
    source_health: {
      liveness: 'ok', tmux: 'ok', dispatch: 'ok', outbox: 'ok', events: 'ok',
    },
    summary: { active: 0, attention: 0, by_state: {}, truncated: 0 },
    runs: [],
    recent_verdicts: [],
    ...overrides,
  }
}

function graph({ teams = [], project_id = 'flow-fixture' } = {}) {
  return { project_id, teams }
}

function runtimeGraph() {
  return {
    project_id: 'runtime-flow',
    source_digest: RUNTIME_DIGEST,
    outer_controller_id: 'outer-control',
    teams: [
      team({
        team_id: 'intake', name: 'Intake', dispatcher_id: 'intake-dispatcher',
        worker_ids: ['intake-worker-a', 'intake-worker-b'], evaluator_id: 'intake-evaluator',
        downstream_team_id: 'release',
      }),
      team({
        team_id: 'release', name: 'Release', dispatcher_id: 'release-dispatcher',
        worker_ids: ['release-worker'], evaluator_id: 'release-evaluator',
      }),
    ],
  }
}

function team({
  team_id,
  name = team_id,
  dispatcher_id,
  worker_ids,
  evaluator_id,
  downstream_team_id = null,
}) {
  return {
    team_id,
    name,
    dispatcher_id,
    worker_ids,
    evaluator_id,
    downstream_team_id,
  }
}

function run({
  task_id,
  worker,
  agent_id = null,
  state = 'running',
  liveness = 'alive',
  dispatch_id = '22222222-2222-4222-8222-222222222222',
  model = null,
  silence_sec = 3,
  pm_verdict = 'absent',
  terminal = 'absent',
  liveness_evidence = null,
  phase = null,
  phase_source = 'unassigned',
} = {}) {
  return {
    dispatch_id,
    task_id,
    identity_source: dispatch_id ? 'dispatch_id' : 'process_only',
    state,
    worker,
    agent_id,
    model,
    transport: 'acp',
    started_at: FIXED,
    elapsed_sec: 42,
    silence_sec,
    timeout_sec: 600,
    signals: {
      dispatch: 'present',
      liveness,
      pane: 'not_recorded',
      terminal,
      pm_verdict,
      correlation: dispatch_id ? 'dispatch_id' : 'process_only',
    },
    reason_codes: ['PROCESS_ALIVE'],
    advisory: { attention: state !== 'running', action_code: 'monitor', auto_execute: false },
    phase,
    phase_source,
    liveness_evidence,
  }
}

function verdict({ task_id, worker, agent_id = null, dispatch_id, pm_verdict = 'pass' }) {
  return {
    dispatch_id,
    task_id,
    worker,
    agent_id,
    transport: 'acp',
    terminal: pm_verdict === 'pass' ? 'done' : 'blocked',
    pm_verdict,
    started_at: FIXED,
    wait_sec: 42,
    timeout_sec: 600,
    phase: null,
    phase_source: 'unassigned',
  }
}

function runtimeEvidence() {
  const at = (offset) => new Date(Date.parse(FIXED) + offset).toISOString()
  const descriptors = [
    ['outer-control', 'outer_controller', null, 'outer-task', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['intake-dispatcher', 'dispatcher', 'intake', 'intake-dispatch', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ['intake-worker-a', 'worker', 'intake', 'intake-worker-a-task', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ['intake-worker-b', 'worker', 'intake', 'intake-worker-b-task', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    ['intake-evaluator', 'evaluator', 'intake', 'intake-evaluate', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    ['release-dispatcher', 'dispatcher', 'release', 'release-dispatch', '11111111-1111-4111-8111-111111111111'],
    ['release-worker', 'worker', 'release', 'release-worker-task', '22222222-2222-4222-8222-222222222222'],
    ['release-evaluator', 'evaluator', 'release', 'release-evaluate', '33333333-3333-4333-8333-333333333333'],
  ]
  const runs = descriptors.map(([agentId, role, teamId, taskId, dispatchId], index) => ({
    agent_run_id: `runtime-run-${index + 1}`,
    agent_id: agentId,
    agent_role: role,
    team_id: teamId,
    task_id: taskId,
    dispatch_id: dispatchId,
    session_operation: 'new',
    requested_session_id: null,
    acp_session_id: `runtime-session-${index + 1}`,
    state: role === 'evaluator' ? 'completed' : 'active',
    queued_at: at(-10_000),
    started_at: at(-9_000),
    completed_at: role === 'evaluator' ? at(-1_000) : null,
    queue_wait_ms: 1_000,
    service_ms: role === 'evaluator' ? 8_000 : null,
    result_digest: role === 'evaluator' ? RUNTIME_DIGEST : null,
    receipt_digest: `sha256:${String(index + 1).repeat(64)}`,
  }))
  const workerA = runs[2]
  const workerB = runs[3]
  const dispatcher = runs[1]
  const evaluator = runs[4]
  const releaseDispatcher = runs[5]
  const attemptA = {
    attempt_id: 'attempt-rework', parent_attempt_id: null, team_id: 'intake',
    work_item_id: 'work-a', agent_id: workerA.agent_id, agent_run_id: workerA.agent_run_id,
    task_id: workerA.task_id, dispatch_id: workerA.dispatch_id, acp_session_id: workerA.acp_session_id,
    resumed_session_id: null, state: 'active', queued_at: at(-10_000), started_at: at(-9_000),
    completed_at: null, input_artifact_digest: null, output_artifact_digest: null, result_digest: null,
  }
  const attemptB = {
    attempt_id: 'attempt-pass', parent_attempt_id: null, team_id: 'intake',
    work_item_id: 'work-b', agent_id: workerB.agent_id, agent_run_id: workerB.agent_run_id,
    task_id: workerB.task_id, dispatch_id: workerB.dispatch_id, acp_session_id: workerB.acp_session_id,
    resumed_session_id: null, state: 'active', queued_at: at(-10_000), started_at: at(-9_000),
    completed_at: null, input_artifact_digest: null, output_artifact_digest: null, result_digest: null,
  }
  return {
    schema: 'tmux-teams.team-runtime', schema_version: 1, trust_level: 'advisory_same_uid',
    comparison_id: 'runtime-comparison', run_id: 'runtime-run', mode: 'team_loop',
    generated_at: at(-1_000), expires_at: at(300_000), graph_source_digest: RUNTIME_DIGEST,
    workload_digest: `sha256:${'1'.repeat(64)}`, oracle_digest: `sha256:${'2'.repeat(64)}`,
    event_log_digest: `sha256:${'3'.repeat(64)}`, execution_profile_digest: `sha256:${'4'.repeat(64)}`,
    controller: { agent_id: 'outer-control', agent_run_id: runs[0].agent_run_id }, checkpoint: {},
    agent_runs: runs,
    routing_decisions: [
      {
        decision_id: 'assign-a', agent_run_id: dispatcher.agent_run_id, actor_id: dispatcher.agent_id,
        actor_role: 'dispatcher', scope: 'team_internal', team_id: 'intake', work_item_id: 'work-a',
        attempt_id: attemptA.attempt_id, decision_kind: 'assign', target_agent_id: workerA.agent_id,
        source_task_id: dispatcher.task_id, source_dispatch_id: dispatcher.dispatch_id,
        source_result_digest: null, observed_at: at(-8_000),
      },
      {
        decision_id: 'requeue-a', agent_run_id: dispatcher.agent_run_id, actor_id: dispatcher.agent_id,
        actor_role: 'dispatcher', scope: 'team_internal', team_id: 'intake', work_item_id: 'work-a',
        attempt_id: attemptA.attempt_id, decision_kind: 'requeue', target_agent_id: dispatcher.agent_id,
        source_task_id: dispatcher.task_id, source_dispatch_id: dispatcher.dispatch_id,
        source_result_digest: null, observed_at: at(-7_000),
      },
      {
        decision_id: 'accept-intake', agent_run_id: dispatcher.agent_run_id, actor_id: dispatcher.agent_id,
        actor_role: 'dispatcher', scope: 'team_internal', team_id: 'intake', work_item_id: null,
        attempt_id: null, decision_kind: 'accept_handoff', target_agent_id: null,
        source_task_id: dispatcher.task_id, source_dispatch_id: dispatcher.dispatch_id,
        source_result_digest: null, observed_at: at(-6_000),
      },
    ],
    attempts: [attemptA, attemptB],
    evaluations: [
      {
        evaluation_id: 'evaluation-reject', agent_run_id: evaluator.agent_run_id, team_id: 'intake',
        evaluator_agent_id: evaluator.agent_id, evaluator_task_id: evaluator.task_id,
        evaluator_dispatch_id: evaluator.dispatch_id, round: 1, work_item_id: 'work-a',
        attempt_id: attemptA.attempt_id, verdict: 'rejected', criterion_results: [], defects: [],
        return_dispatcher_agent_id: dispatcher.agent_id, source_result_digest: RUNTIME_DIGEST,
        observed_at: at(-5_000),
      },
      {
        evaluation_id: 'evaluation-pass', agent_run_id: evaluator.agent_run_id, team_id: 'intake',
        evaluator_agent_id: evaluator.agent_id, evaluator_task_id: evaluator.task_id,
        evaluator_dispatch_id: evaluator.dispatch_id, round: 1, work_item_id: 'work-b',
        attempt_id: attemptB.attempt_id, verdict: 'accepted', criterion_results: [], defects: [],
        return_dispatcher_agent_id: null, source_result_digest: RUNTIME_DIGEST,
        observed_at: at(-4_000),
      },
    ],
    handoffs: [{
      handoff_id: 'handoff-intake-release', producer_agent_run_id: evaluator.agent_run_id,
      consumer_agent_run_id: releaseDispatcher.agent_run_id, upstream_team_id: 'intake',
      upstream_evaluator_agent_id: evaluator.agent_id, upstream_evaluator_task_id: evaluator.task_id,
      downstream_team_id: 'release', downstream_dispatcher_agent_id: releaseDispatcher.agent_id,
      artifact_digest: RUNTIME_DIGEST, consumed_artifact_digest: RUNTIME_DIGEST,
      produced_at: at(-3_000), consumed_at: at(-2_000), state: 'consumed',
    }],
    bottleneck: null,
    metrics: {
      pm_routing_touches: 0, cycle_time_ms: null, gross_cycle_time_ms: null,
      measurement_hold_ms: 0, fanout_makespan_ms: null, summed_worker_service_ms: 0,
      rework_items_rerun: 0, total_items: 2, unaffected_item_attempt_delta: 0,
      bottleneck_detection_ms: null, incorrect_stall_count: 0,
    },
  }
}

function dataAgentIds(html) {
  return [...html.matchAll(/<article\b[^>]*class="agent-node[^"]*"[^>]*data-agent-id="([^"]+)"/g)]
    .map((match) => match[1])
}

function idsIn(html) {
  return [...html.matchAll(/(?<![-\w])id="([^"]+)"/g)].map((match) => match[1])
}

const fourAgentGraph = () => graph({
  teams: [team({
    team_id: 'alpha',
    name: 'Alpha Team',
    dispatcher_id: 'dispatcher-a',
    worker_ids: ['worker-a', 'worker-b'],
    evaluator_id: 'evaluator-a',
  })],
})

test('Stage 2 graph wrapper normalizes one team into exactly four agent instances', () => {
  const wrapped = { graph: fourAgentGraph() }
  const normalized = normalizeTeamGraph(snapshot({ graph: wrapped }))
  assert.equal(normalized.project_id, 'flow-fixture')
  assert.deepEqual(normalized.teams[0].worker_ids, ['worker-a', 'worker-b'])

  const model = buildAgentGraphModel(snapshot({ team_graph: wrapped }))
  assert.equal(model.nodes.length, 4)
  assert.deepEqual(
    model.nodes.map((node) => [node.agent_id, node.role]),
    [
      ['dispatcher-a', 'dispatcher'],
      ['worker-a', 'worker'],
      ['worker-b', 'worker'],
      ['evaluator-a', 'evaluator'],
    ],
  )
  assert.equal(new Set(model.nodes.map((node) => node.agent_id)).size, 4)
})

test('dispatcher, workers, evaluator, reject loop, and pass handoff are separate graph edges', () => {
  const teamGraph = fourAgentGraph()
  const model = buildAgentGraphModel(snapshot({
    team_graph: teamGraph,
    runs: [
      run({ task_id: 'worker-a-task', worker: 'codex', agent_id: 'worker-a' }),
      run({ task_id: 'worker-b-task', worker: 'codex', agent_id: 'worker-b', dispatch_id: '33333333-3333-4333-8333-333333333333', model: 'gpt-5.6-luna[ultra]' }),
    ],
  }))

  assert.deepEqual(
    model.edges.filter((edge) => edge.kind === 'dispatch').map((edge) => edge.to),
    ['worker-a', 'worker-b'],
  )
  assert.deepEqual(
    model.edges.filter((edge) => edge.kind === 'collection').map((edge) => edge.from),
    ['worker-a', 'worker-b'],
  )
  assert.equal(model.edges.filter((edge) => edge.kind === 'reject-loop').length, 1)
  assert.equal(model.edges.find((edge) => edge.kind === 'reject-loop').from, 'evaluator-a')
  assert.equal(model.edges.find((edge) => edge.kind === 'reject-loop').to, 'dispatcher-a')
  assert.equal(model.edges.filter((edge) => edge.kind === 'pass-handoff').length, 1)
  assert.equal(model.edges.find((edge) => edge.kind === 'pass-handoff').to, 'project-complete')
  assert.ok(model.project_completion_endpoint)

  const html = renderPulseLoopGraph(snapshot({
    team_graph: teamGraph,
    runs: [
      run({ task_id: 'worker-a-task', worker: 'codex', agent_id: 'worker-a' }),
      run({ task_id: 'worker-b-task', worker: 'codex', agent_id: 'worker-b', dispatch_id: '33333333-3333-4333-8333-333333333333', model: 'gpt-5.6-luna[ultra]' }),
    ],
  }), { timeZone: 'Asia/Bangkok', timeZoneLabel: 'เวลาไทย (UTC+7)' })
  assert.equal(dataAgentIds(html).length, 4)
  assert.equal(new Set(dataAgentIds(html)).size, 4)
  assert.equal((html.match(/data-edge-kind="dispatch"/g) || []).length, 2)
  assert.equal((html.match(/data-edge-kind="collection"/g) || []).length, 2)
  assert.equal((html.match(/data-edge-kind="reject-loop"/g) || []).length, 1)
  assert.match(html, /data-flow-edge="true" data-edge-kind="reject-loop" data-from-agent-id="evaluator-a" data-to-agent-id="dispatcher-a"/)
  assert.equal((html.match(/data-edge-kind="pass-handoff"/g) || []).length, 1)
  assert.match(html, /reject[^<]*re-dispatch/i)
  assert.match(html, /pass[^<]*project complete/i)
  assert.match(html, /gpt-5\.6-luna\[ultra\]/)
  assert.equal((html.match(/data-agent-id="worker-a"/g) || []).length, 1)
})

test('configurable team names and downstream handoff do not depend on legacy phase names', () => {
  const teamGraph = graph({ teams: [
    team({
      team_id: 'intake',
      name: 'Signal Intake',
      dispatcher_id: 'intake-dispatcher',
      worker_ids: ['intake-worker'],
      evaluator_id: 'intake-evaluator',
      downstream_team_id: 'release',
    }),
    team({
      team_id: 'release',
      name: 'Release Gate',
      dispatcher_id: 'release-dispatcher',
      worker_ids: ['release-worker'],
      evaluator_id: 'release-evaluator',
    }),
  ] })
  const html = renderPulseLoopGraph(snapshot({ team_graph: teamGraph }))
  assert.match(html, /Signal Intake/)
  assert.match(html, /Release Gate/)
  assert.match(html, /pass[^<]*Release Gate[^<]*dispatcher/i)
  assert.doesNotMatch(html, /Requirement|Prototype|Development|QA/)
  assert.equal((html.match(/data-edge-kind="pass-handoff"/g) || []).length, 2)
})

test('configured idle agents are real not_started nodes and do not count as working', () => {
  const model = buildAgentGraphModel(snapshot({ team_graph: fourAgentGraph() }))
  assert.equal(model.counts.total, 4)
  assert.equal(model.counts.working, 0)
  assert.equal(model.counts.not_started, 4)
  assert.equal(model.nodes.filter((node) => node.status === 'not_started').length, 4)
  assert.ok(model.nodes.every((node) => node.observed === false))
})

test('configured/runtime merge renders one node for a matching observed agent', () => {
  const teamGraph = fourAgentGraph()
  const model = buildAgentGraphModel(snapshot({
    team_graph: teamGraph,
    runs: [
      run({ task_id: 'worker-a', worker: 'codex', agent_id: 'worker-a' }),
      run({ task_id: 'worker-a-repeated-evidence', worker: 'codex', agent_id: 'worker-a', dispatch_id: '33333333-3333-4333-8333-333333333333' }),
    ],
    recent_verdicts: [verdict({
      task_id: 'worker-a-finished',
      worker: 'codex',
      agent_id: 'worker-a',
      dispatch_id: '44444444-4444-4444-8444-444444444444',
    })],
  }))
  assert.equal(model.nodes.length, 4)
  assert.equal(model.nodes.filter((node) => node.agent_id === 'worker-a').length, 1)
  assert.equal(model.nodes.find((node) => node.agent_id === 'worker-a').observed, true)
})

test('liveness v1 evidence maps active, tool_running, stalled, and completed truthfully', () => {
  const teamGraph = fourAgentGraph()
  const cases = [
    ['active', 'working'],
    ['tool_running', 'working'],
    ['suspected_stalled', 'stalled'],
    ['completed', 'not_started'],
  ]
  for (const [evidenceState, expectedStatus] of cases) {
    const model = buildAgentGraphModel(snapshot({
      team_graph: teamGraph,
      runs: [run({
        task_id: 'worker-a',
        worker: 'codex',
        agent_id: 'worker-a',
        liveness_evidence: {
          schema_version: 'acp-liveness.v1',
          task_id: 'worker-a',
          dispatch_id: '22222222-2222-4222-8222-222222222222',
          agent_id: 'worker-a',
          liveness_state: evidenceState,
          last_protocol_activity_at: FIXED,
          last_meaningful_progress_at: FIXED,
          active_tools: evidenceState === 'tool_running' ? [{
            tool_call_id: 'tool-1', title: 'terminal.exec', kind: 'terminal', status: 'running',
            output: { command: 'git status' },
          }] : [],
          termination_reason: evidenceState === 'completed' ? 'completed' : null,
          stall_history: evidenceState === 'suspected_stalled' ? [{
            state: 'suspected_stalled', observed_at: FIXED, evidence: 'no meaningful progress',
            last_protocol_activity_at: FIXED, last_meaningful_progress_at: FIXED, active_tools: [],
          }] : [],
        },
      })],
    }))
    const node = model.nodes.find((candidate) => candidate.agent_id === 'worker-a')
    assert.equal(node.status, expectedStatus, evidenceState)
    assert.equal(node.liveness_state, evidenceState === 'completed' ? 'unknown' : evidenceState)
    assert.equal(node.progress_evidence.last_meaningful_progress_at,
      evidenceState === 'completed' ? null : FIXED)
    if (evidenceState === 'completed') {
      assert.equal(model.audit.filter((item) => item.task_id === 'worker-a').length, 1)
    }
  }
})

test('an unmatched live ACP agent appears once in Control / Unassigned', () => {
  const teamGraph = fourAgentGraph()
  const model = buildAgentGraphModel(snapshot({
    team_graph: teamGraph,
    runs: [run({
      task_id: 'free-live-agent',
      worker: null,
      dispatch_id: null,
      liveness: 'alive',
      state: 'orphan_running',
    })],
  }))
  assert.equal(model.nodes.filter((node) => node.agent_id === 'observed_unassigned_1').length, 1)
  assert.equal(model.nodes.find((node) => node.agent_id === 'observed_unassigned_1').team_id, 'unassigned')
  assert.equal(model.lanes.find((lane) => lane.team_id === 'unassigned').name, 'Control / Unassigned')
})

test('stale unresolved history is secondary audit evidence, not a working agent', () => {
  const model = buildAgentGraphModel(snapshot({
    runs: [run({
      task_id: 'stale-unresolved',
      worker: 'legacy-worker',
      state: 'died',
      liveness: 'dead',
      silence_sec: 86_400,
    })],
  }))
  assert.equal(model.counts.working, 0)
  assert.equal(model.nodes.length, 0)
  assert.equal(model.audit.length, 1)
  assert.match(model.audit[0].task_id, /stale-unresolved/)
})

test('unknown operational evidence stays unknown and recent verdicts stay history', () => {
  const model = buildAgentGraphModel(snapshot({
    runs: [run({ task_id: 'unknown-live', state: 'unknown', liveness: 'unknown', silence_sec: 86400 })],
    recent_verdicts: [verdict({
      task_id: 'finished-attempt', worker: 'codex', dispatch_id: '77777777-7777-4777-8777-777777777777',
    })],
  }))
  assert.equal(model.nodes.length, 1)
  assert.equal(model.nodes[0].status, 'unknown')
  assert.equal(model.nodes[0].state_group, 'unknown')
  assert.equal(model.counts.blocked_stalled, 0)
  assert.equal(model.audit.filter((item) => item.task_id === 'finished-attempt').length, 1)
})

test('conflicting explicit identity never enriches a configured node', () => {
  const model = buildAgentGraphModel(snapshot({
    team_graph: fourAgentGraph(),
    runs: [
      run({ task_id: 'conflict-a', agent_id: 'worker-a', dispatch_id: '88888888-8888-4888-8888-888888888888' }),
      run({ task_id: 'conflict-b', agent_id: 'worker-b', dispatch_id: '88888888-8888-4888-8888-888888888888' }),
    ],
  }))
  assert.equal(model.nodes.find((node) => node.agent_id === 'worker-a').observed, false)
  const unassigned = model.nodes.filter((node) => node.team_id === 'unassigned')
  assert.equal(unassigned.length, 1)
  assert.equal(unassigned[0].status, 'unknown')
  assert.ok(model.diagnostics.some((item) => item.code === 'AGENT_ID_CONFLICT'))
})

test('simple flowchart has no legacy force/camera topology contract and remains responsive', () => {
  assert.doesNotMatch(`${GRAPH_SOURCE}\n${TOPOLOGY_SOURCE}`, /forceSimulation|d3\.zoom|zoomIdentity|#topology-canvas|graph-camera/)
  assert.doesNotMatch(`${GRAPH_SOURCE}\n${TOPOLOGY_SOURCE}`, /phase-card|phase team|five-phase/i)
  assert.match(TOPOLOGY_SOURCE, /overflow-x:auto/)
  assert.match(TOPOLOGY_SOURCE, /@media\s*\(max-width:\s*760px\)/)

  const html = renderPulseLoopGraph(snapshot({ team_graph: fourAgentGraph() }), {
    timeZone: 'Asia/Bangkok',
    timeZoneLabel: 'เวลาไทย (UTC+7)',
  })
  const ids = idsIn(html)
  assert.equal(new Set(ids).size, ids.length, 'rendered HTML must not duplicate ids')
  assert.equal((html.match(/id="loop-timezone-label"/g) || []).length, 1)
  for (const section of ['header', 'summary', 'team-flow', 'history', 'legend']) {
    assert.match(html, new RegExp(`data-screen-section="${section}"`))
  }
  assert.match(html, /id="team-flow-semantic-summary"/)
  assert.match(html, /data-count-state="working" data-count="0"/)
  assert.match(html, /data-role="dispatcher"/)
  assert.match(html, /data-role="worker"/)
  assert.match(html, /data-state-group="not_started"/)
  assert.match(html, /class="skip-link" href="#team-flow"/)
  assert.match(html, /class="graph-viewport"/)
  assert.doesNotMatch(html, /width:\s*1400px|height:\s*831px|touch-action:\s*none/)
  assert.match(html, /data-count-working="0"/)
  assert.match(html, /data-count-not-started="4"/)
  assert.match(html, /data-project-completion-endpoint="true"/)
})

test('buildLoopGraphNodes exposes one normalized node per operational agent', () => {
  const nodes = buildLoopGraphNodes(snapshot({
    team_graph: fourAgentGraph(),
    runs: [run({ task_id: 'worker-a', worker: 'codex', agent_id: 'worker-a' })],
  }))
  assert.equal(nodes.length, 4)
  assert.ok(nodes.every((node) => typeof node.agent_id === 'string'))
  assert.ok(nodes.some((node) => node.agent_id === 'worker-a' && node.status === 'working'))
})

test('provider labels never merge concurrent dispatches without explicit identity', () => {
  const model = buildAgentGraphModel(snapshot({
    runs: [
      run({ task_id: 'codex-one', worker: 'codex', dispatch_id: '55555555-5555-4555-8555-555555555555' }),
      run({ task_id: 'codex-two', worker: 'codex', dispatch_id: '66666666-6666-4666-8666-666666666666' }),
    ],
  }))
  assert.equal(model.nodes.length, 2)
  assert.equal(new Set(model.nodes.map((node) => node.agent_id)).size, 2)
  assert.deepEqual(model.nodes.map((node) => node.provider), ['codex', 'codex'])
})

test('sequential attempts with one explicit agent id have one primary node and history', () => {
  const model = buildAgentGraphModel(snapshot({
    runs: [run({ task_id: 'current-attempt', worker: 'codex', agent_id: 'worker-a' })],
    recent_verdicts: [verdict({
      task_id: 'previous-attempt', worker: 'codex', agent_id: 'worker-a',
      dispatch_id: '77777777-7777-4777-8777-777777777777',
    })],
  }))
  assert.equal(model.nodes.filter((node) => node.agent_id === 'worker-a').length, 1)
  assert.equal(model.audit.filter((item) => item.task_id === 'previous-attempt').length, 1)
})

test('invalid duplicate Team agent identity fails closed instead of dropping a role', () => {
  const invalid = graph({ teams: [team({
    team_id: 'alpha', dispatcher_id: 'same-agent', worker_ids: ['same-agent'], evaluator_id: 'eval-a',
  })] })
  assert.equal(normalizeTeamGraph(invalid), null)
  const model = buildAgentGraphModel(snapshot({ team_graph: invalid }))
  assert.equal(model.configured, false)
  assert.equal(model.configuration_error, 'invalid Team graph; membership is not inferred')
  assert.ok(model.diagnostics.some((item) => item.code === 'TEAM_GRAPH_INPUT_INVALID'))
})

test('topology fails closed for cycles and duplicate project-completion sinks', () => {
  const cyclic = graph({ teams: [
    team({ team_id: 'alpha', dispatcher_id: 'alpha-d', worker_ids: ['alpha-w'], evaluator_id: 'alpha-e', downstream_team_id: 'beta' }),
    team({ team_id: 'beta', dispatcher_id: 'beta-d', worker_ids: ['beta-w'], evaluator_id: 'beta-e', downstream_team_id: 'alpha' }),
  ] })
  assert.equal(normalizeTeamGraph(cyclic), null)
  const duplicateSinks = graph({ teams: [
    team({ team_id: 'alpha', dispatcher_id: 'alpha-d', worker_ids: ['alpha-w'], evaluator_id: 'alpha-e' }),
    team({ team_id: 'beta', dispatcher_id: 'beta-d', worker_ids: ['beta-w'], evaluator_id: 'beta-e' }),
  ] })
  assert.equal(normalizeTeamGraph(duplicateSinks), null)
})

test('configured flow has one shared completion endpoint and every edge resolves', () => {
  const model = buildAgentGraphModel(snapshot({ team_graph: graph({ teams: [
    team({ team_id: 'alpha', dispatcher_id: 'alpha-d', worker_ids: ['alpha-w'], evaluator_id: 'alpha-e', downstream_team_id: 'beta' }),
    team({ team_id: 'beta', dispatcher_id: 'beta-d', worker_ids: ['beta-w'], evaluator_id: 'beta-e' }),
  ] }) }))
  const agentIds = new Set(model.nodes.map((node) => node.agent_id))
  assert.equal(model.edges.filter((edge) => edge.to === 'project-complete').length, 1)
  assert.equal(model.project_completion_endpoint.endpoint_id, 'project-complete')
  for (const edge of model.edges) {
    assert.ok(agentIds.has(edge.from), `missing edge source ${edge.from}`)
    assert.ok(edge.to === 'project-complete' || agentIds.has(edge.to), `missing edge target ${edge.to}`)
  }
  const html = renderPulseLoopGraph(snapshot({ team_graph: graph({ teams: [
    team({ team_id: 'alpha', dispatcher_id: 'alpha-d', worker_ids: ['alpha-w'], evaluator_id: 'alpha-e', downstream_team_id: 'beta' }),
    team({ team_id: 'beta', dispatcher_id: 'beta-d', worker_ids: ['beta-w'], evaluator_id: 'beta-e' }),
  ] }) }))
  assert.equal((html.match(/data-project-completion-endpoint="true"/g) || []).length, 1)
})

test('validated team runtime decorates configured nodes and only its controller edges', () => {
  const teamGraph = runtimeGraph()
  const runtime = runtimeEvidence()
  const model = buildAgentGraphModel(snapshot({
    team_graph: teamGraph,
    team_runtime: runtime,
    runs: [run({
      task_id: 'intake-worker-a-task', worker: 'codex', agent_id: 'intake-worker-a',
      dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })],
  }))
  assert.equal(model.runtime?.run_id, 'runtime-run')
  assert.equal(model.lanes.find((lane) => lane.project_control)?.nodes[0].agent_id, 'outer-control')
  const worker = model.nodes.find((node) => node.agent_id === 'intake-worker-a')
  assert.equal(worker.runtime.agent_run_id, 'runtime-run-3')
  assert.equal(worker.runtime.queue_wait_ms, 1_000)
  assert.equal(worker.runtime.service_ms, null)
  const reject = model.edges.find((edge) => edge.kind === 'reject-loop' && edge.team_id === 'intake')
  assert.deepEqual(reject.runtime, {
    runtime_state: 'rejected', decision_id: 'requeue-a', attempt_id: 'attempt-rework',
    handoff_id: null, evaluation_id: 'evaluation-reject',
  })
  const pass = model.edges.find((edge) => edge.kind === 'pass-handoff' && edge.team_id === 'intake')
  assert.deepEqual(pass.runtime, {
    runtime_state: 'consumed', decision_id: 'accept-intake',
    attempt_id: 'attempt-pass', handoff_id: 'handoff-intake-release',
  })
  const html = renderPulseLoopGraph(snapshot({
    team_graph: teamGraph,
    team_runtime: runtime,
    runs: [run({
      task_id: 'intake-worker-a-task', worker: 'codex', agent_id: 'intake-worker-a',
      dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })],
  }))
  assert.match(html, /data-agent-id="outer-control"[^>]*data-role="outer_controller"/)
  assert.match(html, /data-agent-id="intake-worker-a"[^>]*data-agent-run-id="runtime-run-3"[^>]*data-queue-wait-ms="1000"[^>]*data-service-ms=""/)
  assert.match(html, /data-edge-kind="reject-loop"[^>]*data-runtime-state="rejected"[^>]*data-decision-id="requeue-a"[^>]*data-attempt-id="attempt-rework"/)
  assert.match(html, /data-edge-kind="pass-handoff"[^>]*data-runtime-state="consumed"[^>]*data-handoff-id="handoff-intake-release"/)
  assert.equal((html.match(/data-agent-id="outer-control"/g) || []).length, 1)
  assert.equal((html.match(/data-project-completion-endpoint="true"/g) || []).length, 1)
})

test('bottleneck correlation resolves attempt to task and dispatch before current Pulse evidence', () => {
  const teamGraph = runtimeGraph()
  const runtime = runtimeEvidence()
  const at = (offset) => new Date(Date.parse(FIXED) + offset).toISOString()
  runtime.bottleneck = {
    agent_id: 'intake-worker-a', team_id: 'intake', work_item_id: 'work-a',
    attempt_id: 'attempt-rework', kind: 'active_tool_service', detected_at: at(-500),
    queue_wait_ms: 1_000, service_ms: 3_000,
    source_dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    basis: 'active_tool_then_longest_service', incorrect_stall: false,
  }
  const currentRun = run({
    task_id: 'intake-worker-a-task', worker: 'codex', agent_id: 'intake-worker-a',
    dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    liveness_evidence: {
      schema_version: 'acp-liveness.v1', task_id: 'intake-worker-a-task',
      dispatch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', agent_id: 'intake-worker-a',
      liveness_state: 'tool_running', observed_at: FIXED,
      last_protocol_activity_at: FIXED, last_meaningful_progress_at: FIXED,
      termination_reason: null,
      active_tools: [{ tool_call_id: 'tool-1', title: 'terminal', kind: 'terminal', status: 'running' }],
      tools: [], stall_history: [],
    },
  })
  const checked = validateTeamRuntime(runtime, {
    teamGraph, snapshot: snapshot({ runs: [currentRun] }), nowMs: Date.parse(FIXED),
  })
  assert.equal(checked.ok, true, checked.reason)
  const model = buildAgentGraphModel(snapshot({ team_graph: teamGraph, team_runtime: runtime, runs: [currentRun] }))
  assert.equal(model.nodes.find((node) => node.agent_id === 'intake-worker-a').bottleneck, true)
  assert.match(renderPulseLoopGraph(snapshot({
    team_graph: teamGraph, team_runtime: runtime, runs: [currentRun],
  })), /data-agent-id="intake-worker-a"[^>]*data-bottleneck="true"/)

  const swapped = structuredClone(runtime)
  swapped.bottleneck.source_dispatch_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  assert.equal(validateTeamRuntime(swapped, {
    teamGraph, snapshot: snapshot({ runs: [currentRun] }), nowMs: Date.parse(FIXED),
  }).ok, false, 'swapped task/dispatch must fail')
})

test('hostile graph and liveness text stays escaped, local, and readable', () => {
  const html = renderPulseLoopGraph(snapshot({
    team_graph: graph({ teams: [team({
      team_id: 'secure-team',
      name: '<img src=x onerror=alert(1)>',
      dispatcher_id: 'dispatcher-secure',
      worker_ids: ['worker-secure'],
      evaluator_id: 'evaluator-secure',
    })] }),
    runs: [run({
      task_id: 'task-secure', worker: 'codex', agent_id: 'worker-secure',
      liveness_evidence: {
        schema_version: 'acp-liveness.v1', task_id: 'task-secure',
        dispatch_id: '22222222-2222-4222-8222-222222222222', agent_id: 'worker-secure',
        liveness_state: 'tool_running', last_protocol_activity_at: FIXED,
        last_meaningful_progress_at: FIXED, termination_reason: null,
        active_tools: [{
          tool_call_id: 'tool-secure', title: '<b>terminal</b>', kind: 'terminal', status: 'running',
          output: { nested: { secret: '<script>alert(1)</script>' } },
        }], stall_history: [],
      },
    })],
  }))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/)
  assert.doesNotMatch(html, /\[object Object\]/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'/)
  assert.doesNotMatch(html, /script-src[^";]*unsafe-inline/)
  assert.match(html, /<script src="pulse-refresh-[a-f0-9]{64}\.js" defer><\/script>/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('desktop and narrow flow layout keep overflow inside the flow viewport', () => {
  const html = renderPulseLoopGraph(snapshot({ team_graph: fourAgentGraph() }))
  assert.match(html, /body\{[^}]*overflow-x:hidden/)
  assert.match(html, /\.graph-viewport\{[^}]*overflow-x:auto/)
  assert.match(html, /@media\(max-width:760px\)/)
  assert.match(html, /\.team-flow\{width:100%;display:grid\}/)
  assert.match(html, /min-height:44px/)
  assert.match(html, /prefers-reduced-motion:reduce/)
  assert.match(html, /forced-colors:active/)
})
