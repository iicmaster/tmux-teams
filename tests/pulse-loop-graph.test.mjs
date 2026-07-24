import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildOperationalEdges,
  buildLoopGraphNodes,
  layoutLoopGraph,
  renderPulseLoopGraph,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-loop-graph.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')
const ACP_COMPANION = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs')
const MOCK_ACP = join(ROOT, 'tests/fixtures/mock-acp-agent.mjs')
const LOOP_GRAPH_MODEL = join(
  ROOT,
  'plugins/tmux-teams/skills/tmux-teams/scripts/pulse-loop-graph.mjs',
)
const LOOP_GRAPH_TOPOLOGY = join(
  ROOT,
  'plugins/tmux-teams/skills/tmux-teams/scripts/pulse-loop-graph-topology.mjs',
)
const FIXED = '2026-07-24T09:00:00.000Z'

test('loop graph keeps the full overview and gives narrow viewports a readable internal pan canvas', () => {
  const topology = readFileSync(LOOP_GRAPH_TOPOLOGY, 'utf8')
  assert.doesNotMatch(topology, /matchMedia\('\(max-width:[^']+'\)[\s\S]*zoomIdentity\.translate/,
    'mobile must not start with a camera transform that crops phases or ProjectDelivery')
  assert.match(topology,
    /@media\(max-width:560px\)\{[\s\S]*?\.graph-viewport\{overflow:auto;[^}]*\}#topology-canvas\{width:1400px;height:831px;min-height:831px;max-width:none;touch-action:pan-x pan-y\}/,
    'mobile must preserve readable graph scale inside its own two-axis pan surface')
})

function baseSnapshot() {
  return {
    schema: 'tmux-teams.pulse',
    schema_version: 3,
    stream_id: '11111111-1111-4111-8111-111111111111',
    sequence: 7,
    snapshot_id: '11111111-1111-4111-8111-111111111111:7',
    generated_at: FIXED,
    complete: true,
    scope: { repo_name: 'loop-fixture' },
    observation: {
      refresh_interval_sec: 20,
      expires_at: '2099-07-24T09:00:00.000Z',
    },
    source_health: {
      liveness: 'ok',
      tmux: 'ok',
      dispatch: 'ok',
      outbox: 'ok',
      events: 'ok',
    },
    summary: { truncated: 0 },
    runs: [],
    recent_verdicts: [],
  }
}

function active({
  task = 'acp-running',
  dispatch = '22222222-2222-4222-8222-222222222222',
  worker = 'kimi',
  transport = 'acp',
  state = 'running',
  liveness = 'alive',
  terminal = 'absent',
  verdict = 'absent',
  action = 'monitor',
  startedAt = FIXED,
  phase = null,
  phaseSource = phase ? 'dispatch' : 'unassigned',
} = {}) {
  return {
    dispatch_id: dispatch,
    task_id: task,
    identity_source: dispatch ? 'dispatch_id' : 'legacy_task_time',
    state,
    worker,
    transport,
    started_at: startedAt,
    elapsed_sec: 42,
    silence_sec: 3,
    timeout_sec: 600,
    signals: {
      dispatch: 'present',
      liveness,
      pane: 'not_recorded',
      terminal,
      pm_verdict: verdict,
      correlation: dispatch ? 'dispatch_id' : 'mtime_heuristic',
    },
    reason_codes: ['PROCESS_ALIVE'],
    advisory: { attention: state !== 'running', action_code: action, auto_execute: false },
    phase,
    phase_source: phaseSource,
  }
}

function recorded({
  task = 'acp-recorded',
  dispatch = '33333333-3333-4333-8333-333333333333',
  worker = 'agy',
  transport = 'acp',
  terminal = 'done',
  verdict = 'pass',
  startedAt = FIXED,
  phase = null,
  phaseSource = phase ? 'event' : 'unassigned',
} = {}) {
  return {
    dispatch_id: dispatch,
    task_id: task,
    worker,
    transport,
    terminal,
    pm_verdict: verdict,
    started_at: startedAt,
    wait_sec: 58,
    timeout_sec: 600,
    phase,
    phase_source: phaseSource,
  }
}

const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}`
const ACCEPTANCE_DIGEST = `sha256:${'b'.repeat(64)}`
const RECEIVER_DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function operationalGate({
  gateId = 'gate-requirement-prototype',
  sliceId = 'slice-1',
  attemptId = 'attempt-1',
  boundary = 'requirement_to_prototype',
  senderPhase = 'Requirement',
  receiverPhase = 'Prototype',
  artifactType = 'requirements_baseline',
  artifactDigest = ARTIFACT_DIGEST,
  state = 'proposed',
  transitionAt = state === 'proposed' ? null : FIXED,
  acceptanceEventId = null,
  acceptedDigest = null,
  receiverDispatchId = null,
  consumedDigest = null,
  consumedAt = null,
} = {}) {
  return {
    gate_id: gateId,
    slice_id: sliceId,
    attempt_id: attemptId,
    boundary,
    sender_phase: senderPhase,
    receiver_phase: receiverPhase,
    artifact_type: artifactType,
    artifact_digest: artifactDigest,
    state,
    proposed_at: FIXED,
    transition_at: transitionAt,
    acceptance_event_id: acceptanceEventId,
    accepted_digest: acceptedDigest,
    receiver_dispatch_id: receiverDispatchId,
    consumed_digest: consumedDigest,
    consumed_at: consumedAt,
  }
}

function deliveryRuntime(phaseGates, {
  phaseGatesHealth = 'ok',
  receiverDispatchesHealth = 'ok',
} = {}) {
  return {
    schema: 'tmux-teams.delivery-runtime-projection',
    schema_version: 1,
    mode: 'observe_only',
    trust_level: 'advisory_same_uid',
    actuation: { enabled: false, auto_execute: false },
    source_health: {
      phase_gates: phaseGatesHealth,
      receiver_dispatches: receiverDispatchesHealth,
    },
    phase_gates: phaseGates,
  }
}

test('one graph node represents one ACP dispatch instance and active evidence wins deduplication', () => {
  const snapshot = baseSnapshot()
  snapshot.runs = [
    active(),
    active({
      task: 'acp-second',
      dispatch: '44444444-4444-4444-8444-444444444444',
      worker: 'kimi',
      state: 'awaiting-verdict',
      liveness: 'dead',
      terminal: 'done',
      action: 'verify_result',
      phase: 'Development',
    }),
    active({
      task: 'tmux-hidden',
      dispatch: '55555555-5555-4555-8555-555555555555',
      transport: 'tmux',
    }),
  ]
  snapshot.recent_verdicts = [
    recorded({
      task: 'same-active-dispatch',
      dispatch: '22222222-2222-4222-8222-222222222222',
    }),
    recorded({ phase: 'QA' }),
    recorded({
      task: 'tmux-history-hidden',
      dispatch: '66666666-6666-4666-8666-666666666666',
      transport: 'tmux',
    }),
  ]

  const nodes = buildLoopGraphNodes(snapshot)
  assert.equal(nodes.length, 3)
  assert.deepEqual(nodes.map((node) => node.task_id), [
    'acp-running',
    'acp-second',
    'acp-recorded',
  ])
  assert.equal(nodes.filter((node) => node.agent === 'kimi').length, 2,
    'two simultaneous dispatches using the same provider remain two agent instances')
  assert.deepEqual(nodes.map((node) => node.runtime_group), ['running', 'waiting', 'recorded'])
  assert.deepEqual(nodes.map((node) => node.phase_id), ['unassigned', 'development', 'qa'])
  assert.equal(nodes[1].label, 'รอตรวจผล')
  assert.equal(nodes[1].signals.verdict, 'ยังไม่มี',
    'TEAM_DONE without a recorded verdict must not become verified success')
})

test('runtime state remains node metadata and never becomes the phase topology', () => {
  const snapshot = baseSnapshot()
  const states = [
    ['starting', 'starting', 'pending', 'wait'],
    ['running', 'running', 'ok', 'monitor'],
    ['awaiting-verdict', 'waiting', 'warn', 'verify_result'],
    ['unrecorded', 'waiting', 'bad', 'record_verdict'],
    ['died', 'exception', 'bad', 'inspect_worker'],
    ['unknown', 'exception', 'unknown', 'restore_observability'],
    ['orphan_running', 'exception', 'warn', 'inspect_ownership'],
  ]
  snapshot.runs = states.map(([state, , , action], index) => active({
    task: `state-${index}`,
    dispatch: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    state,
    liveness: state === 'running' || state === 'orphan_running' ? 'alive'
      : state === 'unknown' ? 'unknown' : 'dead',
    terminal: state === 'awaiting-verdict' || state === 'unrecorded' ? 'done' : 'absent',
    action,
  }))

  const nodes = buildLoopGraphNodes(snapshot)
  assert.deepEqual(nodes.map((node) => [node.state, node.runtime_group, node.tone]),
    states.map(([state, lane, tone]) => [state, lane, tone]))
  assert.ok(nodes.every((node) => node.phase_id === 'unassigned'))
  assert.ok(nodes.every((node) => node.meaning.length > 20))
})

test('phase flow is fixed, artifact-complete, deterministic, and evidence-only', () => {
  const snapshot = baseSnapshot()
  const states = ['starting', 'running', 'awaiting-verdict', 'died']
  const phases = ['Requirement', 'Prototype', 'Development', 'QA']
  snapshot.runs = Array.from({ length: 48 }, (_, index) => {
    const state = states[index % states.length]
    return active({
      task: `dense-active-${index}`,
      dispatch: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      worker: ['agy', 'kimi', 'claude-zai'][index % 3],
      state,
      liveness: state === 'running' ? 'alive' : 'dead',
      terminal: state === 'awaiting-verdict' ? 'done' : 'absent',
      action: state === 'starting' ? 'wait'
        : state === 'running' ? 'monitor'
          : state === 'awaiting-verdict' ? 'verify_result' : 'inspect_worker',
      phase: phases[index % phases.length],
    })
  })
  snapshot.recent_verdicts = Array.from({ length: 12 }, (_, index) => recorded({
    task: `dense-recorded-${index}`,
    dispatch: `${String(index + 101).padStart(8, '0')}-2222-4222-8222-222222222222`,
    worker: ['agy', 'kimi', 'claude-zai'][index % 3],
    phase: phases[index % phases.length],
  }))

  const topology = layoutLoopGraph(buildLoopGraphNodes(snapshot))
  const shuffled = layoutLoopGraph([...buildLoopGraphNodes(snapshot)].reverse())
  assert.deepEqual(topology.phases.map((phase) => phase.source_name),
    ['Requirement', 'Prototype', 'Development', 'QA'])
  assert.deepEqual(topology.phases.map((phase) => phase.exit_artifact), [
    'requirements_baseline',
    'prototype_evaluation',
    'development_delivery',
    'qa_release_evidence',
  ])
  assert.equal(topology.endpoint.id, 'project-delivery')
  assert.ok(!topology.phases.some((phase) => phase.id === topology.endpoint.id),
    'ProjectDelivery is a receiver, not a fifth phase team')
  assert.equal(topology.nodes.length, 60)
  assert.equal(new Set(topology.nodes.map((node) => `${node.x},${node.y}`)).size, 60)
  assert.deepEqual(
    Object.fromEntries(topology.nodes.map((node) => [node.node_id, [node.x, node.y]])),
    Object.fromEntries(shuffled.nodes.map((node) => [node.node_id, [node.x, node.y]])),
    'input ordering must not jitter the topology',
  )
  assert.equal(topology.observed_edges.length, topology.nodes.length)
  assert.ok(topology.observed_edges.every((edge) =>
    edge.kind === 'observed-phase-placement' &&
    topology.nodes.some((node) => node.node_id === edge.agent_id) &&
    topology.phases.some((phase) => phase.id === edge.placement_id)))
  assert.equal(new Set(topology.observed_edges.map((edge) => edge.agent_id)).size, 60)
  assert.ok(topology.model_edges.every((edge) =>
    edge.kind === 'model-phase-handoff'))
  assert.deepEqual(topology.model_edges.map((edge) => [edge.from, edge.to]), [
    ['requirement', 'prototype'],
    ['prototype', 'development'],
    ['development', 'qa'],
    ['qa', 'project-delivery'],
  ])
  for (const edge of topology.observed_edges) {
    const node = topology.nodes.find((candidate) => candidate.node_id === edge.agent_id)
    assert.deepEqual([edge.x2, edge.y2], [node.x, node.y])
  }
  assert.deepEqual(topology.assignment, { explicit: 60, unassigned: 0, coverage: 1 })
  assert.ok(topology.nodes.every((node) =>
    node.x >= topology.view_box.x && node.y >= topology.view_box.y &&
    node.x <= topology.view_box.x + topology.view_box.width &&
    node.y <= topology.view_box.y + topology.view_box.height))
  for (let left = 0; left < topology.nodes.length; left += 1) {
    for (let right = left + 1; right < topology.nodes.length; right += 1) {
      const a = topology.nodes[left]
      const b = topology.nodes[right]
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius,
        `node ${left} overlaps node ${right}`)
    }
  }
})

test('operational gate edges remain a separate advisory family with stable state semantics', () => {
  const accepted = {
    acceptanceEventId: ACCEPTANCE_DIGEST,
    acceptedDigest: ARTIFACT_DIGEST,
  }
  const runtime = deliveryRuntime([
    operationalGate({ gateId: 'gate-proposed', state: 'proposed' }),
    operationalGate({ gateId: 'gate-accepted', state: 'accepted', ...accepted }),
    operationalGate({ gateId: 'gate-rejected', state: 'rejected' }),
    operationalGate({ gateId: 'gate-escalated', state: 'escalated' }),
    operationalGate({
      gateId: 'gate-consumed',
      state: 'consumed',
      ...accepted,
      receiverDispatchId: RECEIVER_DISPATCH,
      consumedDigest: ARTIFACT_DIGEST,
      consumedAt: FIXED,
    }),
  ])
  const topology = layoutLoopGraph([], null, runtime)

  assert.deepEqual(topology.operational_edges.map((edge) => edge.kind).sort(), [
    'observed-gate-accepted',
    'observed-gate-consumed',
    'observed-gate-escalated',
    'observed-gate-proposed',
    'observed-gate-rejected',
  ])
  assert.ok(topology.operational_edges.every((edge) =>
    edge.advisory === true &&
    edge.boundary === 'requirement_to_prototype' &&
    edge.from === 'requirement' &&
    edge.to === 'prototype' &&
    edge.artifact_type === 'requirements_baseline'))
  assert.equal(
    topology.operational_edges.find((edge) => edge.state === 'accepted')?.completed,
    false,
    'accepting an intermediate handoff does not complete the boundary',
  )
  assert.deepEqual(
    topology.operational_edges
      .filter((edge) => edge.completed)
      .map((edge) => edge.completion_basis),
    ['accepted_digest_consumed_by_receiver_dispatch'],
  )
  assert.equal(topology.model_edges.length, 4)
  assert.equal(topology.observed_edges.length, 0)
  assert.equal(topology.operational_edges.length, 5)
  assert.ok(topology.model_edges.every((edge) => edge.kind === 'model-phase-handoff'))
  assert.ok(topology.operational_edges.every((edge) => edge.kind.startsWith('observed-gate-')))
})

test('intermediate completion requires exact accepted and consumed digests plus receiver dispatch UUID', () => {
  const nearDigest = `${ARTIFACT_DIGEST.slice(0, -1)}b`
  const runtime = deliveryRuntime([
    operationalGate({
      gateId: 'gate-near-digest',
      state: 'consumed',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
      receiverDispatchId: RECEIVER_DISPATCH,
      consumedDigest: nearDigest,
      consumedAt: FIXED,
    }),
    operationalGate({
      gateId: 'gate-missing-dispatch',
      state: 'consumed',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
      consumedDigest: ARTIFACT_DIGEST,
      consumedAt: FIXED,
    }),
  ])
  const edges = buildOperationalEdges(
    runtime,
    layoutLoopGraph([]).model_edges,
  )

  assert.equal(edges.length, 2)
  assert.ok(edges.every((edge) => edge.completed === false))
  assert.ok(edges.every((edge) => edge.completion_basis === null))
})

test('operational edges retain canonical four-boundary order independent of input order', () => {
  const accepted = {
    state: 'consumed',
    acceptanceEventId: ACCEPTANCE_DIGEST,
    acceptedDigest: ARTIFACT_DIGEST,
    receiverDispatchId: RECEIVER_DISPATCH,
    consumedDigest: ARTIFACT_DIGEST,
    consumedAt: FIXED,
  }
  const runtime = deliveryRuntime([
    operationalGate({
      gateId: 'gate-qa',
      attemptId: 'attempt-qa',
      boundary: 'qa_to_project_delivery',
      senderPhase: 'QA',
      receiverPhase: 'ProjectDelivery',
      artifactType: 'qa_release_evidence',
      state: 'accepted',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
    }),
    operationalGate({
      gateId: 'gate-development',
      attemptId: 'attempt-development',
      boundary: 'development_to_qa',
      senderPhase: 'Development',
      receiverPhase: 'QA',
      artifactType: 'development_delivery',
      ...accepted,
    }),
    operationalGate({
      gateId: 'gate-prototype',
      attemptId: 'attempt-prototype',
      boundary: 'prototype_to_development',
      senderPhase: 'Prototype',
      receiverPhase: 'Development',
      artifactType: 'prototype_evaluation',
      ...accepted,
    }),
    operationalGate({
      gateId: 'gate-requirement',
      attemptId: 'attempt-requirement',
      ...accepted,
    }),
  ])

  assert.deepEqual(
    layoutLoopGraph([], null, runtime).operational_edges.map((edge) => edge.boundary),
    [
      'requirement_to_prototype',
      'prototype_to_development',
      'development_to_qa',
      'qa_to_project_delivery',
    ],
  )
})

test('operational completion uses the canonical lowercase UUID v1-v8 contract', () => {
  const modelEdges = layoutLoopGraph([]).model_edges
  for (const version of ['1', '4', '7', '8']) {
    const runtime = deliveryRuntime([
      operationalGate({
        gateId: `gate-uuid-v${version}`,
        state: 'consumed',
        acceptanceEventId: ACCEPTANCE_DIGEST,
        acceptedDigest: ARTIFACT_DIGEST,
        receiverDispatchId: `aaaaaaaa-aaaa-${version}aaa-8aaa-aaaaaaaaaaaa`,
        consumedDigest: ARTIFACT_DIGEST,
        consumedAt: FIXED,
      }),
    ])
    assert.equal(buildOperationalEdges(runtime, modelEdges)[0].completed, true)
  }

  const uppercase = deliveryRuntime([
    operationalGate({
      gateId: 'gate-uppercase-uuid',
      state: 'consumed',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
      receiverDispatchId: 'AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAAAA',
      consumedDigest: ARTIFACT_DIGEST,
      consumedAt: FIXED,
    }),
  ])
  assert.equal(buildOperationalEdges(uppercase, modelEdges)[0].completed, false)
})

test('QA acceptance completes ProjectDelivery without creating a fifth phase or consumed edge', () => {
  const runtime = deliveryRuntime([
    operationalGate({
      gateId: 'gate-qa-accepted',
      boundary: 'qa_to_project_delivery',
      senderPhase: 'QA',
      receiverPhase: 'ProjectDelivery',
      artifactType: 'qa_release_evidence',
      state: 'accepted',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
    }),
    operationalGate({
      gateId: 'gate-qa-consumed-invalid',
      boundary: 'qa_to_project_delivery',
      senderPhase: 'QA',
      receiverPhase: 'ProjectDelivery',
      artifactType: 'qa_release_evidence',
      state: 'consumed',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
      receiverDispatchId: RECEIVER_DISPATCH,
      consumedDigest: ARTIFACT_DIGEST,
      consumedAt: FIXED,
    }),
  ])
  const topology = layoutLoopGraph([], null, runtime)

  assert.deepEqual(topology.phases.map((phase) => phase.id), [
    'requirement',
    'prototype',
    'development',
    'qa',
  ])
  assert.equal(topology.endpoint.id, 'project-delivery')
  assert.equal(topology.operational_edges.length, 1)
  assert.deepEqual(
    topology.operational_edges.map((edge) => [
      edge.kind,
      edge.from,
      edge.to,
      edge.completed,
      edge.completion_basis,
    ]),
    [[
      'observed-gate-accepted',
      'qa',
      'project-delivery',
      true,
      'final_receiver_acceptance',
    ]],
  )
  assert.ok(!topology.phases.some((phase) => phase.id === 'project-delivery'))
  assert.ok(!topology.operational_edges.some((edge) => edge.kind === 'observed-gate-consumed'))
})

test('operational edges fail closed for degraded sources or non-canonical gate mappings', () => {
  const canonical = operationalGate()
  const modelEdges = layoutLoopGraph([]).model_edges
  assert.deepEqual(buildOperationalEdges(null, modelEdges), [])
  assert.deepEqual(buildOperationalEdges(
    deliveryRuntime([canonical], { phaseGatesHealth: 'degraded' }),
    modelEdges,
  ), [])
  assert.deepEqual(buildOperationalEdges(
    deliveryRuntime([canonical], { receiverDispatchesHealth: 'unavailable' }),
    modelEdges,
  ), [])
  assert.deepEqual(buildOperationalEdges(
    deliveryRuntime([operationalGate({ senderPhase: 'QA' })]),
    modelEdges,
  ), [])
  assert.deepEqual(buildOperationalEdges(
    deliveryRuntime([operationalGate({ artifactType: 'qa_release_evidence' })]),
    modelEdges,
  ), [])
})

test('healthy phase runs annotate the four phase teams and bottleneck without completing handoffs', () => {
  const runtime = deliveryRuntime([])
  runtime.phase_runs = [
    ['Requirement', 'working', 'phase_team'],
    ['Prototype', 'handoff_pending', 'receiver_phase_lead'],
    ['Development', 'working', 'phase_team'],
    ['QA', 'pending', 'phase_team'],
  ].map(([phase, state, ownerRole], index) => ({
    phase,
    phase_run_id: `phase-run-${index + 1}`,
    state,
    started_at: FIXED,
    transition_at: FIXED,
    owner_role: ownerRole,
    work_age_sec: 60 + index,
    wait_age_sec: 120 + index,
    handoff_count: index,
    revision_count: 0,
  }))
  runtime.bottleneck = {
    phase: 'Prototype',
    kind: 'handoff_review',
    age_sec: 321,
    since: FIXED,
    owner_role: 'receiver_phase_lead',
    phase_run_id: 'phase-run-2',
    attempt_id: 'attempt-bottleneck',
    gate_id: 'gate-bottleneck',
  }
  const topology = layoutLoopGraph([], null, runtime)
  const prototype = topology.phases.find((phase) => phase.id === 'prototype')

  assert.equal(topology.phases.length, 4)
  assert.ok(topology.phases.every((phase) =>
    phase.assignment_source === 'delivery_runtime_phase_run'))
  assert.equal(prototype.state, 'handoff_pending')
  assert.equal(prototype.owner_role, 'receiver_phase_lead')
  assert.equal(prototype.wait_age_sec, 121)
  assert.deepEqual(prototype.bottleneck, {
    kind: 'handoff_review',
    age_sec: 321,
    owner_role: 'receiver_phase_lead',
  })
  assert.equal(prototype.attention, true)
  assert.deepEqual(topology.operational_edges, [],
    'phase age and bottleneck telemetry cannot manufacture handoff completion')

  const snapshot = baseSnapshot()
  snapshot.delivery_runtime = runtime
  const html = renderPulseLoopGraph(snapshot, { fontCssName: 'pulse-fonts-test.css' })
  assert.match(html, /data-phase-id="prototype"[\s\S]*?data-phase-state="handoff_pending"/)
  assert.match(html, /data-phase-run-id="phase-run-2"/)
  assert.match(html, /data-bottleneck="true"/)
  assert.match(html, /BOTTLENECK handoff_review · 5 นาที · receiver_phase_lead/)
})

test('rendered graph has a dedicated operational SVG layer and advisory semantic copy', () => {
  const snapshot = baseSnapshot()
  snapshot.delivery_runtime = deliveryRuntime([
    operationalGate({
      state: 'consumed',
      acceptanceEventId: ACCEPTANCE_DIGEST,
      acceptedDigest: ARTIFACT_DIGEST,
      receiverDispatchId: RECEIVER_DISPATCH,
      consumedDigest: ARTIFACT_DIGEST,
      consumedAt: FIXED,
    }),
  ])
  const html = renderPulseLoopGraph(snapshot, {
    fontCssName: 'pulse-fonts-test.css',
  })

  assert.match(html, /class="edge-layer operational-edge-layer"/)
  assert.match(html, /data-edge-family="operational"/)
  assert.match(html, /data-edge-kind="observed-gate-consumed"/)
  assert.match(html, /data-boundary="requirement_to_prototype"/)
  assert.match(html, /data-from="requirement" data-to="prototype"/)
  assert.match(html, /data-artifact-type="requirements_baseline"/)
  assert.match(html, /data-completed="true"/)
  assert.match(html, /data-completion-basis="accepted_digest_consumed_by_receiver_dispatch"/)
  assert.match(html, /same-UID observations are advisory/)
  assert.match(html, /Pulse never accepts\/rejects\/consumes\/dispatches\/gates/)
  assert.equal((html.match(/data-phase-team="true"/g) || []).length, 4)
  assert.equal((html.match(/data-edge-kind="model-phase-handoff"/g) || []).length, 4)
  assert.equal((html.match(/data-edge-kind="observed-gate-consumed"/g) || []).length, 1)
})

test('a schema-maximum 112-agent phase remains deterministic and collision-free', () => {
  const snapshot = baseSnapshot()
  snapshot.runs = Array.from({ length: 100 }, (_, index) => active({
    task: `development-live-${index}`,
    dispatch: `${String(index + 1).padStart(8, '0')}-3333-4333-8333-333333333333`,
    state: 'died',
    liveness: 'dead',
    action: 'inspect_worker',
    phase: 'Development',
  }))
  snapshot.recent_verdicts = Array.from({ length: 12 }, (_, index) => recorded({
    task: `development-history-${index}`,
    dispatch: `${String(index + 201).padStart(8, '0')}-3333-4333-8333-333333333333`,
    phase: 'Development',
  }))

  const forward = layoutLoopGraph(buildLoopGraphNodes(snapshot))
  const reverse = layoutLoopGraph([...buildLoopGraphNodes(snapshot)].reverse())
  const development = forward.phases.find((phase) => phase.id === 'development')
  assert.equal(forward.nodes.length, 112)
  assert.ok(forward.nodes.every((node) => node.placement_id === 'development'))
  assert.deepEqual(
    Object.fromEntries(forward.nodes.map((node) => [node.node_id, [node.x, node.y]])),
    Object.fromEntries(reverse.nodes.map((node) => [node.node_id, [node.x, node.y]])),
  )
  assert.equal(forward.observed_edges.length, 112)
  assert.equal(forward.model_edges.length, 4)
  assert.ok(forward.observed_edges.every((edge) => edge.placement_id === 'development'))
  assert.ok(forward.observed_edges.every((edge) => edge.kind !== 'observed-handoff'))
  assert.ok(forward.nodes.every((node) =>
    node.x - node.radius >= development.x &&
    node.x + node.radius <= development.x + development.width &&
    node.y - node.radius >= development.y &&
    node.y + node.radius <= development.y + development.height))
  for (let left = 0; left < forward.nodes.length; left += 1) {
    for (let right = left + 1; right < forward.nodes.length; right += 1) {
      const a = forward.nodes[left]
      const b = forward.nodes[right]
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius)
    }
  }
})

test('phase cards and task names never manufacture an agent phase', () => {
  const snapshot = baseSnapshot()
  snapshot.delivery_loop = {
    status: 'active',
    phase_cards: [{ phase: 'QA', state: 'active', active_slices: 1 }],
  }
  snapshot.runs = [
    active({ task: 'qa-e2e-report', phase: null }),
    active({
      task: 'clickable-prototype',
      dispatch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      phase: null,
    }),
  ]
  const topology = layoutLoopGraph(buildLoopGraphNodes(snapshot), snapshot.delivery_loop)
  assert.ok(topology.nodes.every((node) => node.placement_id === 'unassigned'))
  assert.equal(topology.assignment.explicit, 0)
  assert.equal(topology.assignment.unassigned, 2)
  assert.ok(topology.observed_edges.every((edge) =>
    edge.kind === 'observed-unassigned-placement'))
})

test('legacy attempts correlate by task plus start time without collapsing reused task ids', () => {
  const snapshot = baseSnapshot()
  const older = '2026-07-24T08:00:00.000Z'
  const newer = '2026-07-24T08:30:00.000Z'
  snapshot.runs = [
    active({ task: 'reused-task', dispatch: null, startedAt: newer }),
  ]
  snapshot.recent_verdicts = [
    recorded({ task: 'reused-task', dispatch: null, startedAt: older }),
    recorded({ task: 'reused-task', dispatch: null, startedAt: newer }),
  ]

  const nodes = buildLoopGraphNodes(snapshot)
  assert.equal(nodes.length, 2,
    'the older recorded attempt remains visible while the same active attempt is deduplicated')
  assert.deepEqual(nodes.map((node) => node.started_at), [newer, older])
  assert.ok(nodes.every((node) => node.identity_source === 'legacy_task_time'))

  snapshot.runs = [
    active({ task: 'uncorrelatable', dispatch: null, startedAt: null }),
    active({ task: 'uncorrelatable', dispatch: null, startedAt: null }),
  ]
  snapshot.recent_verdicts = []
  const uncorrelatable = buildLoopGraphNodes(snapshot)
  assert.equal(uncorrelatable.length, 2,
    'rows without UUID or usable start time must not be silently treated as one attempt')
  assert.ok(uncorrelatable.every((node) => node.identity_source === 'uncorrelatable'))
})

test('a recorded pass that conflicts with terminal evidence stays factual and requires attention', () => {
  const snapshot = baseSnapshot()
  snapshot.recent_verdicts = [
    recorded({ task: 'contradictory-pass', terminal: 'failed', verdict: 'pass' }),
  ]

  const [node] = buildLoopGraphNodes(snapshot)
  assert.equal(node.state, 'recorded-pass-conflict')
  assert.equal(node.tone, 'bad')
  assert.equal(node.attention, true)
  assert.equal(node.signals.terminal, 'TEAM_FAILED')
  assert.equal(node.signals.verdict, 'ผ่าน')
  assert.match(node.meaning, /ขัดกับ terminal TEAM_FAILED/)
})

test('duplicate recorded identity becomes one explicit conflict node', () => {
  const snapshot = baseSnapshot()
  snapshot.recent_verdicts = [
    recorded({ task: 'history-a', phase: 'Development', verdict: 'pass' }),
    recorded({ task: 'history-b', phase: 'QA', verdict: 'reject' }),
  ]

  const [node] = buildLoopGraphNodes(snapshot)
  assert.equal(node.state, 'recorded-identity-conflict')
  assert.equal(node.identity_conflict, true)
  assert.equal(node.phase_id, 'unassigned')
  assert.equal(node.phase_source, 'conflict')
  assert.equal(node.attention, true)
  assert.match(node.meaning, /ไม่เลือกสถานะใดสถานะหนึ่ง/)
})

test('standalone HTML is full-screen, offline, semantic, stale-aware, and escapes dynamic text', () => {
  const snapshot = baseSnapshot()
  snapshot.complete = false
  snapshot.summary.truncated = 4
  snapshot.observation.expires_at = '2020-01-01T00:00:00.000Z'
  snapshot.source_health.liveness = 'unavailable'
  const scriptBreaker = '</script><script id=loop-xss>globalThis.loopPwned=true</script>'
  snapshot.stream_id = scriptBreaker
  snapshot.runs = [
    active({
      task: `<agent-task>${scriptBreaker}`,
      worker: '<img src=x onerror=alert(1)>',
      dispatch: null,
      state: 'unknown',
      liveness: 'unknown',
      action: 'restore_observability',
    }),
  ]

  const html = renderPulseLoopGraph(snapshot, {
    fontCssName: 'pulse-fonts-test.css',
    d3JsName: 'pulse-d3-7.9.0-test.min.js',
    timeZone: 'Asia/Bangkok',
    timeZoneLabel: 'เวลาไทย (UTC+7)',
  })

  assert.match(html, /<body data-observation-freshness="stale"/)
  assert.match(html, /data-agent-node-count="1"/)
  assert.equal((html.match(/data-agent-node="true"/g) || []).length, 1)
  assert.equal((html.match(/id="loop-timezone-label"/g) || []).length, 1)
  assert.equal((html.match(/เวลาไทย \(UTC\+7\)/g) || []).length, 1)
  assert.match(html, /snapshot ตัด active run 4 รายการ/)
  assert.match(html, /liveness:unavailable/)
  assert.match(html, /identity สำรอง/)
  assert.match(html, /snapshot หมดอายุ · สถานะนี้เป็นหลักฐานล่าสุด ไม่ใช่สถานะปัจจุบัน/)
  assert.match(html, /data-base-aria-label=/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src=x onerror=/)
  assert.doesNotMatch(html, /<script id=loop-xss>/)
  assert.match(html, /\\u003c\/script>\\u003cscript id=loop-xss>/)
  assert.equal((html.match(/<script(?:\s|>)/g) || []).length, 3,
    'the graph contains one data block, one local D3 asset, and one bootstrap')
  assert.match(html, /height:100%/)
  assert.match(html, /1 node = 1 ACP dispatch/)
  assert.match(html, /Requirement → Prototype → Development → QA → ProjectDelivery/)
  assert.match(html, /<svg[^>]+id="topology-canvas"/)
  assert.equal((html.match(/data-edge-kind="observed-unassigned-placement"/g) || []).length, 1)
  assert.equal((html.match(/data-edge-kind="model-phase-handoff"/g) || []).length, 4)
  assert.equal((html.match(/data-edge-kind="model-inner-loop"/g) || []).length, 16)
  assert.doesNotMatch(html, /data-edge-kind="observed-handoff"/)
  assert.equal((html.match(/data-phase-team="true"/g) || []).length, 4)
  assert.equal((html.match(/data-state-hub="true"/g) || []).length, 0)
  assert.match(html, /ไม่ใช่ phase team ที่ห้า/)
  assert.doesNotMatch(html, /class="lane(?:\s|")|class="graph-board"|<article class="agent-node"/)
  assert.match(html, /id="graph-zoom-in"/)
  assert.match(html, /id="graph-zoom-out"/)
  assert.match(html, /id="graph-fit"/)
  assert.match(html, /id="graph-inspector"/)
  assert.match(html, /id="graph-inspector"[^>]*hidden/)
  assert.match(html, /observed placement/)
  assert.match(html, /TEAM_DONE ≠ ทีมตรวจรับแล้ว/)
  assert.match(html, /phase acceptance ≠ business approval/)
  assert.match(html, /id="loop-auto-refresh"/)
  assert.match(html, />พักการรีเฟรชอัตโนมัติ<\/button>/)
  assert.match(html, /location\.reload\(\)/)
  assert.doesNotMatch(html, /http-equiv="refresh"/)
  assert.equal((html.match(/data-agent-node="true"[^>]*tabindex="0"/g) || []).length, 1,
    'SVG agent nodes use one roving tab stop')
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/)
  assert.match(html, /@media\(forced-colors:active\)/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /\bfetch\s*\(/)
  assert.equal((html.match(/<script src="pulse-d3-7\.9\.0-test\.min\.js"><\/script>/g) || []).length, 1)
  assert.match(html, /globalThis\.d3\?\.version === '7\.9\.0'/)
  assert.match(html, /d3\.zoom\(\)/)
  assert.doesNotMatch(html, /forceSimulation/)
  assert.match(
    html,
    /<svg id="topology-canvas"[\s\S]*?<g class="agent-node[^"]*"[^>]*data-agent-node="true"[\s\S]*?<circle class="node-core"/,
  )
})

test('the canonical renderer source contains no dormant Kanban implementation', () => {
  const source = [
    readFileSync(LOOP_GRAPH_MODEL, 'utf8'),
    readFileSync(LOOP_GRAPH_TOPOLOGY, 'utf8'),
  ].join('\n')
  assert.doesNotMatch(source, /renderPulseLoopGraphLegacy|graph-board|grid-template-columns:repeat\(5/)
  assert.doesNotMatch(source, /<article class="agent-node"|class="lane(?:\s|")|class="lane-nodes"/)
})

test('an invalid expiry is unknown freshness, not a false expired claim', () => {
  const snapshot = baseSnapshot()
  snapshot.observation.expires_at = 'not-a-timestamp'
  snapshot.runs = [active()]

  const html = renderPulseLoopGraph(snapshot, {
    fontCssName: 'pulse-fonts-test.css',
    timeZone: 'Asia/Bangkok',
    timeZoneLabel: 'เวลาไทย (UTC+7)',
  })

  assert.match(html, /<body data-observation-freshness="unknown"/)
  assert.match(html, /class="freshness unknown"[^>]*>ตรวจ freshness ไม่ได้<\/span>/)
  assert.match(html, /aria-label="ตรวจ freshness ไม่ได้ · สถานะนี้เป็นหลักฐานล่าสุด ไม่ใช่สถานะปัจจุบัน\./)
  assert.match(html, /data-node-freshness="unknown"/)
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-loop-'))
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

function dispatchFile(dir, {
  task,
  dispatch,
  worker,
  transport = 'acp',
  phase = null,
}) {
  writeFileSync(join(dir, '.tmux-teams', 'dispatch', `${task}.md`), [
    `dispatch_id: ${dispatch}`,
    `task_id: ${task}`,
    `worker: ${worker}`,
    `transport: ${transport}`,
    ...(phase ? [`phase: ${phase}`] : []),
    `started_at: ${new Date().toISOString()}`,
    'timeout_sec: 600',
    '',
  ].join('\n'))
}

test('pulse publishes loop-graph.html from the same serialized snapshot and keeps once stdout compatible', () => {
  const dir = repo()
  dispatchFile(dir, {
    task: 'acp-awaiting',
    dispatch: '77777777-7777-4777-8777-777777777777',
    worker: 'kimi',
    phase: 'Development',
  })
  writeFileSync(join(dir, '.mailbox-out', 'acp-awaiting'),
    'ASKED: test\nDID: returned evidence\nTEAM_DONE acp-awaiting\n')
  dispatchFile(dir, {
    task: 'tmux-hidden',
    dispatch: '88888888-8888-4888-8888-888888888888',
    worker: 'codex',
    transport: 'tmux',
  })
  writeFileSync(join(dir, '.tmux-teams', 'kms', 'events', '20260724-0900_acp-recorded_agy.md'), [
    'dispatch_id: 99999999-9999-4999-8999-999999999999',
    'task_id: acp-recorded',
    'worker: agy',
    'transport: acp',
    'phase: QA',
    'terminal: TEAM_DONE',
    'pm_verdict: pass',
    `started_at: ${FIXED}`,
    'wait_sec: 58',
    '',
  ].join('\n'))

  const result = spawnSync('node', [PULSE, 'once', dir], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', PULSE_TIME_ZONE: 'Asia/Bangkok' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), join(dir, '.tmux-teams', 'pulse.html'),
    'once stdout remains the primary Pulse path for compatibility')

  const json = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  const pulse = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const graphPath = join(dir, '.tmux-teams', 'loop-graph.html')
  assert.equal(existsSync(graphPath), true)
  const graph = readFileSync(graphPath, 'utf8')
  const manifest = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse-current.json'), 'utf8'))

  for (const html of [pulse, graph]) {
    assert.match(html, new RegExp(`content="${json.snapshot_id}"`))
  }
  assert.equal(manifest.schema, 'tmux-teams.pulse-bundle')
  assert.equal(manifest.schema_version, 2)
  assert.deepEqual(Object.keys(manifest.files).sort(),
    ['d3_js', 'd3_license', 'dashboard', 'data', 'font_css', 'loop_graph'])
  assert.equal(manifest.snapshot_id, json.snapshot_id)
  for (const entry of Object.values(manifest.files)) {
    const content = readFileSync(join(dir, '.tmux-teams', entry.path))
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256)
  }
  assert.match(pulse, /href="loop-graph\.html">เปิด ACP Loop Graph เต็มจอ/)
  assert.equal(json.schema_version, 4)
  assert.equal(json.runs.find((run) => run.task_id === 'acp-awaiting')?.phase, 'Development')
  assert.equal(json.runs.find((run) => run.task_id === 'acp-awaiting')?.phase_source, 'dispatch')
  assert.equal(json.recent_verdicts.find((run) => run.task_id === 'acp-recorded')?.phase, 'QA')
  assert.equal(json.recent_verdicts.find((run) => run.task_id === 'acp-recorded')?.phase_source, 'event')
  assert.equal((graph.match(/data-agent-node="true"/g) || []).length, 2)
  assert.match(graph, /data-task-id="acp-awaiting"/)
  assert.match(graph, /data-task-id="acp-recorded"/)
  assert.doesNotMatch(graph, /data-task-id="tmux-hidden"/)
  assert.match(graph, /data-state="awaiting-verdict"/)
  assert.match(graph, /data-state="recorded-pass"/)
  assert.match(graph, /data-phase-id="development"[^>]*data-task-id="acp-awaiting"/)
  assert.match(graph, /data-phase-id="qa"[^>]*data-task-id="acp-recorded"/)
  assert.match(graph, new RegExp(`<script src="${manifest.files.d3_js.path.replaceAll('.', '\\.')}"></script>`))
  assert.match(graph, /TEAM_DONE/)
  assert.match(graph, /verdict<\/dt><dd>ยังไม่มี/,
    'worker terminal marker remains distinct from recorded verdict')
})

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}

test('a real live ACP companion process appears as one running graph node', { timeout: 15_000 }, async () => {
  const dir = repo()
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, 'Keep the mock ACP session open for the Pulse liveness probe.\n')
  const child = spawn(process.execPath, [
    ACP_COMPANION,
    'kimi',
    dir,
    'live-acp-poc',
    brief,
    '3',
  ], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ACP_CMD: `${process.execPath} ${MOCK_ACP}`,
      ACP_KMS_AUTO: '0',
      MOCK_HANG: '1',
      TMUX_TEAMS_PHASE: 'Development',
    },
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.resume()

  await waitFor(() => existsSync(join(dir, '.tmux-teams', 'dispatch', 'live-acp-poc.md')))
  const pulse = spawnSync(process.execPath, [PULSE, 'once', dir], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', PULSE_TIME_ZONE: 'Asia/Bangkok' },
  })
  assert.equal(pulse.status, 0, pulse.stderr)

  const graph = readFileSync(join(dir, '.tmux-teams', 'loop-graph.html'), 'utf8')
  const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  assert.equal((graph.match(/data-agent-node="true"/g) || []).length, 1)
  assert.match(graph, /data-task-id="live-acp-poc"/)
  assert.match(graph, /data-state="running"/)
  assert.match(graph, /data-phase-id="development"[^>]*data-task-id="live-acp-poc"/)
  assert.equal(snapshot.runs[0].phase, 'Development')
  assert.equal(snapshot.runs[0].phase_source, 'dispatch')
  assert.match(graph, /process<\/dt><dd>พบ process/,
    'running is backed by an observed companion process, not a status file')

  const exit = await new Promise((resolve) => child.once('close', resolve))
  assert.equal(exit, 1, stderr)
  assert.match(stderr, /\[timeout 3s\]/)
})
