import { PHASE_EXIT_ARTIFACTS } from './delivery-loop-core.mjs'
import { stablePhaseRunId } from './phase-gate-core.mjs'

const PHASES = ['Requirement', 'Prototype', 'Development', 'QA']
const KIND_RANK = { dispatch_reconcile: 5, exception: 4, rework: 3, handoff_review: 2, work: 1 }
const time = (event) => event?.occurred_at ?? null
const age = (now, since) => since === null ? null : Math.max(0, (Date.parse(now) - Date.parse(since)) / 1000)

export { stablePhaseRunId }

function gateState(attempt, consumption) {
  if (consumption) return 'consumed'
  return ['proposed', 'accepted', 'rejected', 'escalated'].includes(attempt.state) ? attempt.state : 'proposed'
}

export function buildPhaseGateRuntimeProjection(aggregate, {
  now = new Date().toISOString(),
  ttl_sec = 120,
  limit = 100,
} = {}) {
  const events = aggregate.events ?? []
  const attempts = Object.entries(aggregate.attempts ?? {}).map(([attempt_id, attempt]) => {
    const consumption = attempt.acceptance_event_id ? aggregate.consumptions?.[attempt.acceptance_event_id] : null
    const dispatch = consumption ? aggregate.dispatches?.[consumption.dispatch_uuid] : null
    const proposed = events.find((event) => event.event_id === attempt.proposal_event_id)
    const acceptance = attempt.acceptance_event_id
      ? events.find((event) => event.event_id === attempt.acceptance_event_id) : null
    const stateTransition = attempt.state === 'rejected'
      ? [...events].reverse().find((event) => event.attempt_id === attempt_id && event.event_type === 'handoff_reject')
      : attempt.state === 'escalated'
        ? [...events].reverse().find((event) => event.attempt_id === attempt_id && event.event_type === 'handoff_escalate')
        : acceptance
    return {
      gate_id: attempt.handoff_id,
      slice_id: aggregate.slice_id,
      attempt_id,
      boundary: `${attempt.boundary.sender_phase.toLowerCase()}_to_${attempt.boundary.receiver_phase.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`,
      sender_phase: attempt.boundary.sender_phase,
      receiver_phase: attempt.boundary.receiver_phase,
      artifact_type: PHASE_EXIT_ARTIFACTS[attempt.boundary.sender_phase],
      artifact_digest: attempt.artifact.digest,
      state: gateState(attempt, consumption),
      proposed_at: time(proposed) ?? time(events.find((event) => event.artifact_event_id === attempt.artifact_event_id)),
      transition_at: attempt.state === 'proposed' ? null : time(stateTransition),
      acceptance_event_id: attempt.acceptance_event_id ?? null,
      accepted_digest: attempt.acceptance_event_id ? attempt.artifact.digest : null,
      receiver_dispatch_id: consumption?.dispatch_uuid ?? null,
      consumed_digest: consumption ? attempt.artifact.digest : null,
      consumed_at: consumption ? time(events.find((event) => event.event_id === consumption.event_id)) : null,
    }
  }).sort((left, right) => {
    const order = ['requirement_to_prototype', 'prototype_to_development', 'development_to_qa', 'qa_to_project_delivery']
    return order.indexOf(left.boundary) - order.indexOf(right.boundary)
      || Date.parse(left.proposed_at) - Date.parse(right.proposed_at)
      || left.gate_id.localeCompare(right.gate_id)
  })
  const phaseRuns = PHASES.map((phase) => {
    const phaseEvents = events.filter((event) => event.phase_run_id === stablePhaseRunId(aggregate.slice_id, phase))
    const phaseAttempts = Object.values(aggregate.attempts ?? {}).filter((attempt) => attempt.boundary.sender_phase === phase)
    const started = phase === 'Requirement'
      ? events.find((event) => event.event_type === 'dispatch_terminal' && event.boundary?.receiver_phase === 'Requirement' && event.payload?.outcome === 'success')
      : events.find((event) => event.event_type === 'dispatch_consumption' && event.boundary?.receiver_phase === phase)
    const completed = phase === 'QA'
      ? events.find((event) => event.event_type === 'project_delivery_accept')
      : events.find((event) => event.event_type === 'dispatch_consumption' && event.boundary?.sender_phase === phase)
    const active = phaseAttempts.find((attempt) => ['proposed', 'accepted', 'escalated'].includes(attempt.state))
    const rejected = phaseAttempts.some((attempt) => attempt.state === 'rejected')
    const state = completed ? 'completed' : active ? (active.state === 'escalated' ? 'blocked' : 'handoff_pending') : started ? 'working' : 'pending'
    const transition = completed ?? [...phaseEvents].reverse()[0] ?? started
    return {
      phase,
      phase_run_id: stablePhaseRunId(aggregate.slice_id, phase),
      state,
      started_at: time(started),
      transition_at: time(completed),
      owner_role: state === 'handoff_pending' ? 'receiver_phase_lead' : phase === 'QA' && state === 'completed' ? 'project_delivery' : 'phase_team',
      work_age_sec: started && !completed ? age(now, time(started)) : null,
      wait_age_sec: !completed && active ? age(now, time(events.find((event) => event.event_id === active.proposal_event_id))) : null,
      handoff_count: phaseAttempts.length,
      revision_count: rejected ? phaseAttempts.filter((attempt) => attempt.state === 'rejected').length : 0,
    }
  })
  const candidates = []
  for (const [dispatch_uuid, dispatch] of Object.entries(aggregate.dispatches ?? {})) {
    if (dispatch.state === 'indeterminate') {
      const event = events.find((row) => row.event_id === dispatch.indeterminate_event_id)
      candidates.push({ phase: dispatch.boundary.receiver_phase, kind: 'dispatch_reconcile', since: time(event), owner_role: 'pm_exception_owner', attempt_id: dispatch.attempt_id ?? null, gate_id: dispatch.handoff_id ?? null, dispatch_uuid })
    }
  }
  const currentAttempts = Object.entries(aggregate.attempts ?? {}).filter(([attempt_id, attempt], _index, entries) =>
    !entries.some(([otherId, other]) => otherId !== attempt_id
      && other.boundary.sender_phase === attempt.boundary.sender_phase
      && other.boundary.receiver_phase === attempt.boundary.receiver_phase
      && other.revision > attempt.revision))
  for (const [attempt_id, attempt] of currentAttempts) {
    const event = [...events].reverse().find((row) => row.attempt_id === attempt_id)
    const consumption = attempt.acceptance_event_id
      ? aggregate.consumptions?.[attempt.acceptance_event_id]
      : null
    if (attempt.state === 'escalated') candidates.push({ phase: attempt.boundary.sender_phase, kind: 'exception', since: time(event), owner_role: 'pm_exception_owner', attempt_id, gate_id: attempt.handoff_id })
    else if (attempt.state === 'rejected') candidates.push({ phase: attempt.boundary.sender_phase, kind: 'rework', since: time(event), owner_role: 'phase_team', attempt_id, gate_id: attempt.handoff_id })
    else if (attempt.state === 'proposed') candidates.push({ phase: attempt.boundary.sender_phase, kind: 'handoff_review', since: time(event), owner_role: attempt.boundary.receiver_phase === 'ProjectDelivery' ? 'project_delivery' : 'receiver_phase_lead', attempt_id, gate_id: attempt.handoff_id })
    else if (attempt.state === 'accepted' && !consumption
      && attempt.boundary.receiver_phase !== 'ProjectDelivery') {
      const acceptance = events.find((row) => row.event_id === attempt.acceptance_event_id)
      candidates.push({
        phase: attempt.boundary.sender_phase,
        kind: 'handoff_review',
        since: time(acceptance),
        owner_role: 'receiver_phase_lead',
        attempt_id,
        gate_id: attempt.handoff_id,
      })
    }
  }
  const working = phaseRuns.find((run) => run.state === 'working')
  if (working) candidates.push({ phase: working.phase, kind: 'work', since: working.started_at, owner_role: 'phase_team', attempt_id: null, gate_id: null })
  candidates.sort((left, right) => KIND_RANK[right.kind] - KIND_RANK[left.kind] || Date.parse(left.since) - Date.parse(right.since) || left.phase.localeCompare(right.phase))
  const selected = candidates[0]
  const bottleneck = selected ? {
    phase: selected.phase,
    kind: selected.kind,
    age_sec: age(now, selected.since),
    since: selected.since,
    owner_role: selected.owner_role,
    phase_run_id: stablePhaseRunId(aggregate.slice_id, selected.phase),
    attempt_id: selected.attempt_id,
    gate_id: selected.gate_id,
  } : null
  let shown = attempts.slice(0, limit)
  if (selected?.gate_id && !shown.some((gate) => gate.gate_id === selected.gate_id)) {
    const selectedGate = attempts.find((gate) => gate.gate_id === selected.gate_id)
    if (selectedGate && limit > 0) shown = [...shown.slice(0, limit - 1), selectedGate].sort((left, right) => attempts.indexOf(left) - attempts.indexOf(right))
  }
  return {
    schema: 'tmux-teams.delivery-runtime-projection', schema_version: 1,
    generated_at: now, expires_at: new Date(Date.parse(now) + ttl_sec * 1000).toISOString(),
    trust_level: 'advisory_same_uid', mode: 'observe_only', actuation: { enabled: false, auto_execute: false },
    source_health: { phase_gates: 'ok', receiver_dispatches: 'ok' },
    summary: {
      proposed: attempts.length,
      accepted: attempts.filter((gate) => ['accepted', 'consumed'].includes(gate.state)).length,
      rejected: attempts.filter((gate) => gate.state === 'rejected').length,
      escalated: attempts.filter((gate) => gate.state === 'escalated').length,
      consumed: attempts.filter((gate) => gate.state === 'consumed').length,
      shown: shown.length, truncated: Math.max(0, attempts.length - shown.length),
    },
    replay: { sequence: aggregate.head.sequence, head_event_id: aggregate.head.event_id },
    phase_runs: phaseRuns, bottleneck, phase_gates: shown,
  }
}

export const projectPhaseGateRuntime = buildPhaseGateRuntimeProjection
