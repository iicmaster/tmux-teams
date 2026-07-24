// Pure full-screen ACP delivery-loop projection for Pulse.
//
// The renderer receives only the exact serialized Pulse snapshot. It does not
// inspect processes, dispatch files, outboxes, or KMS records on its own.
// Phase placement therefore requires explicit phase attribution in that
// snapshot. Runs without it remain visibly unassigned; task names and model
// names are never used to invent a phase or a handoff.

import { renderTopologyGraph } from './pulse-loop-graph-topology.mjs'

const STATE_META = Object.freeze({
  starting: {
    runtime_group: 'starting',
    label: 'กำลังเริ่ม',
    tone: 'pending',
    meaning: 'มี dispatch แต่ยังไม่พบ process และยังอยู่ในช่วงเริ่มต้น',
  },
  running: {
    runtime_group: 'running',
    label: 'กำลังทำงาน',
    tone: 'ok',
    meaning: 'พบ ACP companion process ที่ cwd ตรงกับโปรเจกต์',
  },
  'awaiting-verdict': {
    runtime_group: 'waiting',
    label: 'รอตรวจผล',
    tone: 'warn',
    meaning: 'พบ terminal marker จาก worker แต่ยังไม่มีคำตัดสินที่บันทึก',
  },
  unrecorded: {
    runtime_group: 'waiting',
    label: 'ขาดบันทึกคำตัดสิน',
    tone: 'bad',
    meaning: 'terminal marker ค้างเกินกำหนดและยังไม่มี verdict record',
  },
  died: {
    runtime_group: 'exception',
    label: 'หยุดโดยไม่มีผลลัพธ์',
    tone: 'bad',
    meaning: 'มี dispatch แต่ไม่พบ process, terminal marker หรือ verdict หลังช่วงเริ่มต้น',
  },
  unknown: {
    runtime_group: 'exception',
    label: 'ตรวจสถานะไม่ได้',
    tone: 'unknown',
    meaning: 'แหล่งข้อมูลที่จำเป็นต่อการตรวจ liveness ใช้งานไม่ได้',
  },
  orphan_running: {
    runtime_group: 'exception',
    label: 'พบ process แต่ไม่มี dispatch',
    tone: 'warn',
    meaning: 'พบ ACP process ในโปรเจกต์ แต่ไม่พบ dispatch footprint',
  },
})

const RECORDED_META = Object.freeze({
  pass: {
    label: 'บันทึกว่า “ผ่าน”',
    tone: 'ok',
    meaning: 'มี pm_verdict: pass ที่บันทึกไว้; ไม่ใช่ business approval หรือ UAT acceptance',
  },
  reject: {
    label: 'บันทึกว่า “ให้แก้ไข”',
    tone: 'bad',
    meaning: 'มี pm_verdict: reject ที่บันทึกไว้',
  },
  unresolved: {
    label: 'บันทึกว่า “ยังไม่สรุป”',
    tone: 'warn',
    meaning: 'มี pm_verdict: unresolved ที่บันทึกไว้',
  },
})

export const DELIVERY_PHASES = Object.freeze([
  {
    id: 'requirement',
    source_name: 'Requirement',
    step: '01',
    title: 'Requirement',
    thai: 'ข้อกำหนด',
    exit_artifact: 'requirements_baseline',
    deliverable: 'Business function · validation · exception · security · performance · integration',
  },
  {
    id: 'prototype',
    source_name: 'Prototype',
    step: '02',
    title: 'Prototype',
    thai: 'ต้นแบบ',
    exit_artifact: 'prototype_evaluation',
    deliverable: 'Clickable prototype',
  },
  {
    id: 'development',
    source_name: 'Development',
    step: '03',
    title: 'Development',
    thai: 'พัฒนา',
    exit_artifact: 'development_delivery',
    deliverable: 'Working software',
  },
  {
    id: 'qa',
    source_name: 'QA',
    step: '04',
    title: 'QA',
    thai: 'ทดสอบ',
    exit_artifact: 'qa_release_evidence',
    deliverable: 'E2E test report · UAT report',
  },
])

const PHASE_BY_SOURCE = new Map(DELIVERY_PHASES.flatMap((phase) => [
  [phase.source_name.toLowerCase(), phase.id],
  [phase.id, phase.id],
]))
const BOUND_PHASE_SOURCES = new Set(['dispatch', 'event', 'dispatch_join'])
const UNBOUND_PHASE_SOURCES = new Set(['unassigned', 'conflict'])

const TERMINAL_COPY = Object.freeze({
  done: 'TEAM_DONE',
  blocked: 'TEAM_BLOCKED',
  failed: 'TEAM_FAILED',
  invalid: 'marker ไม่ถูกต้อง',
  absent: 'ยังไม่มี',
})

const VERDICT_COPY = Object.freeze({
  pass: 'ผ่าน',
  reject: 'ให้แก้ไข',
  unresolved: 'ยังไม่สรุป',
  absent: 'ยังไม่มี',
})

const LIVENESS_COPY = Object.freeze({
  alive: 'พบ process',
  dead: 'ไม่พบ process',
  unknown: 'ตรวจไม่ได้',
})

const ACTION_COPY = Object.freeze({
  monitor: 'ติดตามต่อ',
  wait: 'รอช่วงเริ่มต้น',
  verify_result: 'ตรวจผลลัพธ์',
  record_verdict: 'บันทึกคำตัดสิน',
  inspect_worker: 'ตรวจ worker',
  restore_observability: 'กู้การสังเกตการณ์',
  inspect_ownership: 'ตรวจเจ้าของ process',
})

function phaseAssignment(item) {
  const rawPhase = String(item?.phase ?? '').trim()
  const phaseId = PHASE_BY_SOURCE.get(rawPhase.toLowerCase()) || null
  const phaseSource = String(item?.phase_source ?? '').trim()
  if (phaseId && BOUND_PHASE_SOURCES.has(phaseSource)) {
    return {
      phase_id: phaseId,
      phase_source: phaseSource,
    }
  }
  if (!phaseId && UNBOUND_PHASE_SOURCES.has(phaseSource)) {
    return {
      phase_id: 'unassigned',
      phase_source: phaseSource,
    }
  }
  return {
    phase_id: 'unassigned',
    phase_source: 'unassigned',
    phase_binding_invalid: Boolean(rawPhase || phaseSource),
  }
}

function nodeIdentity(item, source, index) {
  const dispatchId = String(item.dispatch_id || '').trim()
  if (dispatchId) {
    return { dispatchId, key: `dispatch:${dispatchId}`, source: 'dispatch_id' }
  }
  const startedMs = Date.parse(String(item.started_at || ''))
  if (Number.isFinite(startedMs)) {
    const startedAt = new Date(startedMs).toISOString()
    return {
      dispatchId: null,
      key: `legacy:${JSON.stringify([String(item.task_id || ''), startedAt])}`,
      source: 'legacy_task_time',
    }
  }
  return {
    dispatchId: null,
    key: `uncorrelatable:${source}:${index}:${String(item.task_id || '')}`,
    source: 'uncorrelatable',
  }
}

function activeNode(run, identity) {
  const meta = STATE_META[run.state]
  return {
    node_id: identity.key,
    dispatch_id: identity.dispatchId,
    identity_source: identity.source,
    task_id: run.task_id,
    agent: run.worker || 'ไม่ทราบชื่อ agent',
    ...phaseAssignment(run),
    runtime_group: meta.runtime_group,
    state: run.state,
    label: meta.label,
    tone: meta.tone,
    meaning: meta.meaning,
    historical: false,
    elapsed_sec: run.elapsed_sec,
    silence_sec: run.silence_sec,
    started_at: run.started_at,
    signals: {
      dispatch: run.signals.dispatch === 'present' ? 'มี' : 'ไม่มี',
      liveness: LIVENESS_COPY[run.signals.liveness] || 'ตรวจไม่ได้',
      terminal: TERMINAL_COPY[run.signals.terminal] || 'ไม่ทราบ',
      verdict: VERDICT_COPY[run.signals.pm_verdict] || 'ไม่ทราบ',
    },
    next_action: ACTION_COPY[run.advisory.action_code] || 'ตรวจรายละเอียด',
    attention: run.advisory.attention,
  }
}

function recordedNode(record, identity) {
  const meta = RECORDED_META[record.pm_verdict]
  const conflictingPass = record.pm_verdict === 'pass' && record.terminal !== 'done'
  return {
    node_id: identity.key,
    dispatch_id: identity.dispatchId,
    identity_source: identity.source,
    task_id: record.task_id,
    agent: record.worker || 'ไม่ทราบชื่อ agent',
    ...phaseAssignment(record),
    runtime_group: 'recorded',
    state: conflictingPass ? 'recorded-pass-conflict' : `recorded-${record.pm_verdict}`,
    label: conflictingPass ? 'หลักฐานขัดแย้ง · บันทึกว่า “ผ่าน”' : meta.label,
    tone: conflictingPass ? 'bad' : meta.tone,
    meaning: conflictingPass
      ? `pm_verdict: pass ขัดกับ terminal ${TERMINAL_COPY[record.terminal] || 'ไม่ทราบ'}; ต้องตรวจหลักฐานและไม่ถือเป็น business approval หรือ UAT acceptance`
      : meta.meaning,
    historical: true,
    elapsed_sec: record.wait_sec,
    silence_sec: null,
    started_at: record.started_at,
    signals: {
      dispatch: identity.dispatchId ? 'มี identity' : 'identity แบบเก่า',
      liveness: 'ไม่ใช่ process สด',
      terminal: TERMINAL_COPY[record.terminal] || 'ไม่ทราบ',
      verdict: VERDICT_COPY[record.pm_verdict] || 'ไม่ทราบ',
    },
    next_action: conflictingPass
      ? 'ตรวจ terminal marker และ verdict record'
      : record.pm_verdict === 'reject'
        ? 'สร้าง dispatch ใหม่เมื่อผู้รับผิดชอบสั่งแก้'
        : record.pm_verdict === 'unresolved'
          ? 'ตรวจหลักฐานและสรุปผล'
          : 'เก็บเป็นประวัติ',
    attention: conflictingPass || record.pm_verdict !== 'pass',
    verdict_conflict: conflictingPass,
  }
}

const nodeOrder = (left, right) =>
  String(left.task_id).localeCompare(String(right.task_id), 'en') ||
  String(left.agent).localeCompare(String(right.agent), 'en') ||
  String(left.state).localeCompare(String(right.state), 'en')

function sharedPhaseAssignment(candidates) {
  const pairs = new Set(candidates.map((node) =>
    `${node.phase_id}\u0000${node.phase_source}`))
  if (pairs.size === 1) {
    return {
      phase_id: candidates[0].phase_id,
      phase_source: candidates[0].phase_source,
    }
  }
  return {
    phase_id: 'unassigned',
    phase_source: 'conflict',
  }
}

function identityConflict(candidates, evidenceKind = 'active') {
  const sorted = [...candidates].sort(nodeOrder)
  const first = sorted[0]
  const historical = evidenceKind === 'history'
  const phase = sharedPhaseAssignment(sorted)
  return {
    ...first,
    ...phase,
    agent: new Set(sorted.map((node) => node.agent)).size === 1
      ? first.agent
      : 'หลาย agent · identity ชนกัน',
    state: historical ? 'recorded-identity-conflict' : 'identity-conflict',
    label: historical ? 'หลักฐานประวัติ identity ขัดแย้ง' : 'dispatch identity ขัดแย้ง',
    tone: 'bad',
    meaning: `พบหลักฐาน ${historical ? 'history' : 'active'} ${sorted.length} แถวใช้ dispatch identity เดียวกัน จึงไม่เลือกสถานะใดสถานะหนึ่ง`,
    signals: {
      dispatch: 'identity ชนกัน',
      liveness: [...new Set(sorted.map((node) => node.signals.liveness))].join(' / '),
      terminal: [...new Set(sorted.map((node) => node.signals.terminal))].join(' / '),
      verdict: [...new Set(sorted.map((node) => node.signals.verdict))].join(' / '),
    },
    next_action: 'ตรวจ dispatch identity และหลักฐานที่ขัดแย้ง',
    attention: true,
    identity_conflict: true,
    evidence_conflict: evidenceKind,
  }
}

/**
 * Build one node per ACP dispatch identity. Duplicate active rows with the same
 * strong identity become one explicit conflict node; duplicate history does
 * the same. Neither evidence stream silently uses first-row-wins. Active
 * evidence wins over recent history for the same run.
 */
export function buildLoopGraphNodes(snapshot) {
  const activeGroups = new Map()
  for (const [index, run] of (snapshot?.runs || []).entries()) {
    if (run.transport !== 'acp' || !STATE_META[run.state]) continue
    const identity = nodeIdentity(run, 'active', index)
    const group = activeGroups.get(identity.key) || []
    group.push(activeNode(run, identity))
    activeGroups.set(identity.key, group)
  }
  const active = [...activeGroups.values()].map((group) =>
    group.length === 1 ? group[0] : identityConflict(group))
  const activeIds = new Set(active.map((node) => node.node_id))

  const historyGroups = new Map()
  for (const [index, record] of (snapshot?.recent_verdicts || []).entries()) {
    if (record.transport !== 'acp' || !RECORDED_META[record.pm_verdict]) continue
    const identity = nodeIdentity(record, 'history', index)
    if (activeIds.has(identity.key)) continue
    const group = historyGroups.get(identity.key) || []
    group.push(recordedNode(record, identity))
    historyGroups.set(identity.key, group)
  }
  const history = [...historyGroups.values()].map((group) =>
    group.length === 1 ? group[0] : identityConflict(group, 'history'))
  return [...active.sort(nodeOrder), ...history.sort(nodeOrder)]
}

const PHASE_POSITIONS = Object.freeze({
  requirement: { x: 60, y: 130, width: 270 },
  prototype: { x: 390, y: 130, width: 270 },
  development: { x: 720, y: 130, width: 270 },
  qa: { x: 1050, y: 130, width: 270 },
})

const PHASE_HANDOFFS = Object.freeze([
  ['requirement', 'prototype'],
  ['prototype', 'development'],
  ['development', 'qa'],
  ['qa', 'project-delivery'],
])

const OPERATIONAL_BOUNDARIES = Object.freeze({
  requirement_to_prototype: Object.freeze({
    from: 'requirement',
    to: 'prototype',
    sender_phase: 'Requirement',
    receiver_phase: 'Prototype',
    artifact_type: 'requirements_baseline',
  }),
  prototype_to_development: Object.freeze({
    from: 'prototype',
    to: 'development',
    sender_phase: 'Prototype',
    receiver_phase: 'Development',
    artifact_type: 'prototype_evaluation',
  }),
  development_to_qa: Object.freeze({
    from: 'development',
    to: 'qa',
    sender_phase: 'Development',
    receiver_phase: 'QA',
    artifact_type: 'development_delivery',
  }),
  qa_to_project_delivery: Object.freeze({
    from: 'qa',
    to: 'project-delivery',
    sender_phase: 'QA',
    receiver_phase: 'ProjectDelivery',
    artifact_type: 'qa_release_evidence',
  }),
})
const OPERATIONAL_BOUNDARY_ORDER = new Map(
  Object.keys(OPERATIONAL_BOUNDARIES).map((boundary, index) => [boundary, index]),
)

const OPERATIONAL_STATE = Object.freeze({
  proposed: Object.freeze({
    kind: 'observed-gate-proposed',
    offset: -18,
  }),
  accepted: Object.freeze({
    kind: 'observed-gate-accepted',
    offset: -9,
  }),
  rejected: Object.freeze({
    kind: 'observed-gate-rejected',
    offset: 9,
  }),
  escalated: Object.freeze({
    kind: 'observed-gate-escalated',
    offset: 18,
  }),
  consumed: Object.freeze({
    kind: 'observed-gate-consumed',
    offset: 0,
  }),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const OPERATIONAL_GATE_KEYS = Object.freeze([
  'gate_id',
  'slice_id',
  'attempt_id',
  'boundary',
  'sender_phase',
  'receiver_phase',
  'artifact_type',
  'artifact_digest',
  'state',
  'proposed_at',
  'transition_at',
  'acceptance_event_id',
  'accepted_digest',
  'receiver_dispatch_id',
  'consumed_digest',
  'consumed_at',
])

const PHASE_AGENT_REGION = Object.freeze({
  x: 18,
  y: 205,
  width: 234,
  minimum_height: 145,
})

const stableNodeOrder = (left, right) => {
  const leftTime = Date.parse(String(left.started_at || ''))
  const rightTime = Date.parse(String(right.started_at || ''))
  const leftValid = Number.isFinite(leftTime)
  const rightValid = Number.isFinite(rightTime)
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  if (leftValid && leftTime !== rightTime) return leftTime - rightTime
  return String(left.node_id).localeCompare(String(right.node_id), 'en')
}

function preferredNodeRadius(count, context = 'phase') {
  if (context === 'unassigned') {
    if (count <= 40) return 15
    if (count <= 80) return 13
    return 10
  }
  if (count <= 12) return 17
  if (count <= 40) return 12
  if (count <= 80) return 9
  return 7
}

function gridMetrics(count, width, radius) {
  if (!count) return { radius, pitch: radius * 2 + 8, columns: 1, rows: 0, used_height: 0 }
  const pitch = radius * 2 + 8
  const columns = Math.max(1, Math.floor(width / pitch))
  const rows = Math.ceil(count / columns)
  return {
    radius,
    pitch,
    columns,
    rows,
    used_height: rows * pitch,
  }
}

function gridPlacement(nodes, region, preferredRadius) {
  if (!nodes.length) return []
  const { radius, pitch, columns, rows, used_height: usedHeight } =
    gridMetrics(nodes.length, region.width, preferredRadius)
  const usedWidth = Math.min(columns, nodes.length) * pitch
  const startX = region.x + (region.width - usedWidth) / 2 + pitch / 2
  const startY = region.y + (region.height - usedHeight) / 2 + pitch / 2
  return nodes.map((node, index) => ({
    ...node,
    radius,
    x: Math.round((startX + (index % columns) * pitch) * 100) / 100,
    y: Math.round((startY + Math.floor(index / columns) * pitch) * 100) / 100,
    layout_index: index,
  }))
}

function phaseStateMap(deliveryLoop) {
  const cards = Array.isArray(deliveryLoop?.phase_cards) ? deliveryLoop.phase_cards : []
  return new Map(cards.map((card) => [
    PHASE_BY_SOURCE.get(String(card.phase || '').toLowerCase()),
    card,
  ]).filter(([phaseId]) => phaseId))
}

function operationalRuntimeAvailable(deliveryRuntime) {
  return deliveryRuntime?.mode === 'observe_only' &&
    deliveryRuntime?.trust_level === 'advisory_same_uid' &&
    deliveryRuntime?.actuation?.enabled === false &&
    deliveryRuntime?.actuation?.auto_execute === false &&
    deliveryRuntime?.source_health?.phase_gates === 'ok' &&
    deliveryRuntime?.source_health?.receiver_dispatches === 'ok' &&
    Array.isArray(deliveryRuntime.phase_gates)
}

function operationalPhaseStateMap(deliveryRuntime) {
  if (!operationalRuntimeAvailable(deliveryRuntime) ||
      !Array.isArray(deliveryRuntime.phase_runs) ||
      deliveryRuntime.phase_runs.length !== DELIVERY_PHASES.length) return new Map()
  const rows = new Map()
  for (const row of deliveryRuntime.phase_runs) {
    const phaseId = PHASE_BY_SOURCE.get(String(row?.phase || '').toLowerCase())
    if (!phaseId || rows.has(phaseId) ||
        typeof row.phase_run_id !== 'string' || !row.phase_run_id ||
        typeof row.state !== 'string' || !row.state ||
        typeof row.owner_role !== 'string' || !row.owner_role) return new Map()
    rows.set(phaseId, row)
  }
  return rows.size === DELIVERY_PHASES.length ? rows : new Map()
}

function operationalBottleneck(deliveryRuntime, phaseStates) {
  if (!phaseStates.size || !deliveryRuntime?.bottleneck ||
      typeof deliveryRuntime.bottleneck !== 'object') return null
  const phaseId = PHASE_BY_SOURCE.get(
    String(deliveryRuntime.bottleneck.phase || '').toLowerCase(),
  )
  if (!phaseId || !phaseStates.has(phaseId) ||
      typeof deliveryRuntime.bottleneck.kind !== 'string' ||
      !deliveryRuntime.bottleneck.kind ||
      typeof deliveryRuntime.bottleneck.owner_role !== 'string' ||
      !deliveryRuntime.bottleneck.owner_role ||
      !Number.isFinite(deliveryRuntime.bottleneck.age_sec)) return null
  return { ...deliveryRuntime.bottleneck, phase_id: phaseId }
}

function operationalGateShape(gate) {
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return null
  const keys = Object.keys(gate)
  if (keys.length !== OPERATIONAL_GATE_KEYS.length ||
      !OPERATIONAL_GATE_KEYS.every((key) => Object.hasOwn(gate, key))) return null
  const boundary = OPERATIONAL_BOUNDARIES[gate.boundary]
  const state = OPERATIONAL_STATE[gate.state]
  if (!boundary || !state) return null
  if (gate.sender_phase !== boundary.sender_phase ||
      gate.receiver_phase !== boundary.receiver_phase ||
      gate.artifact_type !== boundary.artifact_type) return null
  if (![gate.gate_id, gate.slice_id, gate.attempt_id]
    .every((value) => typeof value === 'string' && value.length > 0)) return null
  const transitionObserved = Number.isFinite(Date.parse(gate.transition_at))
  if (!SHA256.test(gate.artifact_digest) ||
      !Number.isFinite(Date.parse(gate.proposed_at)) ||
      gate.state === 'proposed' && gate.transition_at !== null ||
      gate.state !== 'proposed' && !transitionObserved) return null
  return { boundary, state }
}

function operationalEdgePath(modelEdge, offset) {
  const x1 = modelEdge.x1
  const y1 = modelEdge.y1 + offset
  const x2 = modelEdge.x2
  const y2 = modelEdge.y2 + offset
  const control = Math.max(30, (x2 - x1) / 2)
  return {
    x1,
    y1,
    x2,
    y2,
    path: `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`,
  }
}

/**
 * Project advisory operational handoff evidence onto the fixed four-phase
 * model. The projection consumes only Pulse's sanitized delivery_runtime rows.
 * It never derives a gate from task text, agent placement, TEAM_DONE, PM
 * verdicts, delivery-loop cards, or digest similarity.
 */
export function buildOperationalEdges(deliveryRuntime, modelEdges) {
  if (!operationalRuntimeAvailable(deliveryRuntime)) return []
  const modelByBoundary = new Map(modelEdges.map((edge) => [
    `${edge.from}\u0000${edge.to}`,
    edge,
  ]))
  const edges = []
  for (const gate of deliveryRuntime.phase_gates) {
    const shape = operationalGateShape(gate)
    if (!shape) continue
    const { boundary, state } = shape
    const modelEdge = modelByBoundary.get(`${boundary.from}\u0000${boundary.to}`)
    if (!modelEdge) continue
    const finalBoundary = gate.boundary === 'qa_to_project_delivery'
    if (finalBoundary && gate.state === 'consumed') continue

    const accepted = SHA256.test(gate.acceptance_event_id ?? '') &&
      gate.accepted_digest === gate.artifact_digest
    const receiverDispatch = typeof gate.receiver_dispatch_id === 'string' &&
      UUID.test(gate.receiver_dispatch_id)
    const consumed = accepted &&
      receiverDispatch &&
      typeof gate.consumed_at === 'string' &&
      gate.consumed_at.length > 0 &&
      gate.consumed_digest === gate.artifact_digest

    if (gate.state === 'accepted' && !accepted) continue
    let completed = false
    let completionBasis = null
    if (finalBoundary && gate.state === 'accepted') {
      completed = true
      completionBasis = 'final_receiver_acceptance'
    } else if (!finalBoundary && gate.state === 'consumed' && consumed) {
      completed = true
      completionBasis = 'accepted_digest_consumed_by_receiver_dispatch'
    }

    edges.push({
      kind: state.kind,
      state: gate.state,
      gate_id: gate.gate_id,
      slice_id: gate.slice_id,
      attempt_id: gate.attempt_id,
      boundary: gate.boundary,
      from: boundary.from,
      to: boundary.to,
      artifact_type: boundary.artifact_type,
      artifact_digest: gate.artifact_digest,
      acceptance_event_id: accepted ? gate.acceptance_event_id : null,
      receiver_dispatch_id: receiverDispatch ? gate.receiver_dispatch_id : null,
      completed,
      completion_basis: completionBasis,
      advisory: true,
      ...operationalEdgePath(modelEdge, state.offset),
    })
  }
  return edges.sort((left, right) =>
    OPERATIONAL_BOUNDARY_ORDER.get(left.boundary) -
      OPERATIONAL_BOUNDARY_ORDER.get(right.boundary) ||
    left.gate_id.localeCompare(right.gate_id, 'en') ||
    left.attempt_id.localeCompare(right.attempt_id, 'en'))
}

/**
 * Build the agreed PM outer loop and four Phase Team inner loops.
 *
 * Model edges describe the normative Requirement → Prototype → Development →
 * QA → ProjectDelivery flow. Solid placement edges only bind a run to an
 * explicit phase assignment (or to the unassigned evidence pool). Only the
 * closed delivery_runtime contract can create an operational handoff edge;
 * run/task/card fields cannot.
 */
export function layoutLoopGraph(nodes, deliveryLoop = null, deliveryRuntime = null) {
  const phaseStates = phaseStateMap(deliveryLoop)
  const operationalPhaseStates = operationalPhaseStateMap(deliveryRuntime)
  const bottleneck = operationalBottleneck(deliveryRuntime, operationalPhaseStates)
  const phaseNodesById = new Map(DELIVERY_PHASES.map((phase) => [
    phase.id,
    nodes
      .filter((node) =>
        node.phase_id === phase.id && BOUND_PHASE_SOURCES.has(node.phase_source))
      .sort(stableNodeOrder),
  ]))
  const phaseGridMetrics = new Map(DELIVERY_PHASES.map((phase) => {
    const count = phaseNodesById.get(phase.id).length
    const radius = preferredNodeRadius(count)
    return [phase.id, gridMetrics(count, PHASE_AGENT_REGION.width, radius)]
  }))
  const phaseAgentRegionHeight = Math.max(
    PHASE_AGENT_REGION.minimum_height,
    ...[...phaseGridMetrics.values()].map((metrics) => metrics.used_height + 16),
  )
  const reviewY = PHASE_AGENT_REGION.y + phaseAgentRegionHeight + 52
  const artifactY = reviewY + 48
  const phaseHeight = artifactY + 56

  const phases = DELIVERY_PHASES.map((phase) => {
    const position = PHASE_POSITIONS[phase.id]
    const card = phaseStates.get(phase.id) || null
    const runtime = operationalPhaseStates.get(phase.id) || null
    const phaseBottleneck = bottleneck?.phase_id === phase.id ? bottleneck : null
    const agentRegion = {
      x: PHASE_AGENT_REGION.x,
      y: PHASE_AGENT_REGION.y,
      width: PHASE_AGENT_REGION.width,
      height: phaseAgentRegionHeight,
    }
    return {
      ...phase,
      ...position,
      height: phaseHeight,
      plan_y: 137,
      agent_count_y: 190,
      agent_region: agentRegion,
      review_y: reviewY,
      artifact_y: artifactY,
      handoff_y: artifactY + 20,
      state: runtime?.state || card?.state || 'not_observed',
      active_slices: Number.isFinite(card?.active_slices) ? card.active_slices : null,
      phase_run_id: runtime?.phase_run_id || null,
      owner_role: runtime?.owner_role || null,
      work_age_sec: Number.isFinite(runtime?.work_age_sec) ? runtime.work_age_sec : null,
      wait_age_sec: Number.isFinite(runtime?.wait_age_sec) ? runtime.wait_age_sec : null,
      bottleneck: phaseBottleneck
        ? {
            kind: phaseBottleneck.kind,
            age_sec: phaseBottleneck.age_sec,
            owner_role: phaseBottleneck.owner_role,
          }
        : null,
      attention: Boolean(phaseBottleneck || card?.advisory?.attention),
      assignment_source: runtime
        ? 'delivery_runtime_phase_run'
        : card ? 'delivery_loop_projection' : 'not_configured',
      anchor_x: position.x + position.width / 2,
      anchor_y: position.y + agentRegion.y + agentRegion.height / 2,
      agent_count: phaseNodesById.get(phase.id).length,
    }
  })
  const handoffY = phases[0].y + phases[0].handoff_y
  const endpoint = {
    id: 'project-delivery',
    title: 'Project Delivery',
    thai: 'ส่งมอบโครงการ',
    x: 1400,
    y: handoffY - 95,
    width: 230,
    height: 190,
    anchor_x: 1515,
    anchor_y: handoffY,
  }
  const unassignedNodes = nodes
    .filter((node) =>
      !DELIVERY_PHASES.some((phase) =>
        phase.id === node.phase_id && BOUND_PHASE_SOURCES.has(node.phase_source)))
    .sort(stableNodeOrder)
  const unassignedRadius = preferredNodeRadius(unassignedNodes.length, 'unassigned')
  const unassignedMetrics = gridMetrics(unassignedNodes.length, 1270, unassignedRadius)
  const unassignedRegionHeight = Math.max(175, unassignedMetrics.used_height + 16)
  const unassignedY = phases[0].y + phaseHeight + 120
  const unassigned = {
    id: 'unassigned',
    title: 'ACP agents ที่ยังไม่ผูกเฟส',
    x: 60,
    y: unassignedY,
    width: 1570,
    height: Math.max(270, 62 + unassignedRegionHeight + 33),
    anchor_x: 845,
    anchor_y: unassignedY + 62 + unassignedRegionHeight / 2,
    agent_region: {
      x: 305,
      y: unassignedY + 62,
      width: 1270,
      height: unassignedRegionHeight,
    },
  }

  const placedNodes = []
  for (const phase of phases) {
    const phaseNodes = phaseNodesById.get(phase.id)
    const placed = gridPlacement(phaseNodes, {
      x: phase.x + phase.agent_region.x,
      y: phase.y + phase.agent_region.y,
      width: phase.agent_region.width,
      height: phase.agent_region.height,
    }, phaseGridMetrics.get(phase.id).radius)
    placedNodes.push(...placed.map((node) => ({
      ...node,
      placement_id: phase.id,
      placement_x: phase.anchor_x,
      placement_y: phase.anchor_y,
    })))
  }
  const placedUnassigned = gridPlacement(
    unassignedNodes,
    unassigned.agent_region,
    unassignedRadius,
  )
  placedNodes.push(...placedUnassigned.map((node) => ({
    ...node,
    phase_id: 'unassigned',
    phase_source: UNBOUND_PHASE_SOURCES.has(node.phase_source)
      ? node.phase_source
      : 'unassigned',
    placement_id: 'unassigned',
    placement_x: unassigned.anchor_x,
    placement_y: unassigned.anchor_y,
  })))
  unassigned.agent_count = placedUnassigned.length

  const placementById = new Map([
    ...phases.map((phase) => [phase.id, phase]),
    ['unassigned', unassigned],
  ])
  const observedEdges = placedNodes.map((node) => ({
    kind: node.placement_id === 'unassigned'
      ? 'observed-unassigned-placement'
      : 'observed-phase-placement',
    agent_id: node.node_id,
    placement_id: node.placement_id,
    x1: node.placement_x,
    y1: node.placement_y,
    x2: node.x,
    y2: node.y,
  }))
  const phaseById = new Map(phases.map((phase) => [phase.id, phase]))
  phaseById.set(endpoint.id, endpoint)
  const modelEdges = PHASE_HANDOFFS.map(([from, to]) => {
    const source = phaseById.get(from)
    const target = phaseById.get(to)
    const x1 = source.x + source.width
    const y1 = source.y + source.handoff_y
    const x2 = target.x
    const y2 = to === endpoint.id ? target.anchor_y : target.y + target.handoff_y
    const control = Math.max(30, (x2 - x1) / 2)
    return {
      kind: 'model-phase-handoff',
      from,
      to,
      artifact: DELIVERY_PHASES.find((phase) => phase.id === from)?.exit_artifact || '',
      x1,
      y1,
      x2,
      y2,
      path: `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`,
    }
  })
  const operationalEdges = buildOperationalEdges(deliveryRuntime, modelEdges)

  return {
    view_box: {
      x: 0,
      y: 0,
      width: 1690,
      height: unassigned.y + unassigned.height + 60,
    },
    pm_boundary: {
      x: 25,
      y: 55,
      width: 1635,
      height: phases[0].y + phaseHeight + 8,
    },
    phases,
    endpoint,
    unassigned,
    nodes: placedNodes,
    observed_edges: observedEdges,
    model_edges: modelEdges,
    operational_edges: operationalEdges,
    placements: Object.fromEntries([...placementById].map(([id, value]) => [id, value])),
    assignment: {
      explicit: placedNodes.filter((node) => node.placement_id !== 'unassigned').length,
      unassigned: placedUnassigned.length,
      coverage: placedNodes.length
        ? placedNodes.filter((node) => node.placement_id !== 'unassigned').length / placedNodes.length
        : 1,
    },
    delivery_context: {
      source: deliveryLoop ? 'pulse_delivery_loop' : 'not_configured',
      status: deliveryLoop?.status || 'not_configured',
      bottleneck: bottleneck || deliveryLoop?.bottleneck || null,
      operational_source: operationalPhaseStates.size
        ? 'pulse_delivery_runtime'
        : 'not_available',
    },
  }
}

export function renderPulseLoopGraph(snapshot, options = {}) {
  const nodes = buildLoopGraphNodes(snapshot)
  return renderTopologyGraph(
    snapshot,
    layoutLoopGraph(nodes, snapshot?.delivery_loop, snapshot?.delivery_runtime),
    options,
  )
}
