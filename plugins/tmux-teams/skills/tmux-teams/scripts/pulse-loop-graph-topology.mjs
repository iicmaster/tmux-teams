// Static, document-flow renderer for the operational agent flow.
//
// The graph model is prepared by pulse-loop-graph.mjs. This module only turns
// that model into offline HTML; it never probes a process or reads a file.

import { createHash } from 'node:crypto'
import { PULSE_REFRESH_SOURCE } from './pulse-refresh.mjs'

const DEFAULT_REFRESH_SCRIPT_NAME = `pulse-refresh-${createHash('sha256').update(PULSE_REFRESH_SOURCE).digest('hex')}.js`

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

const numberText = (value, missing = 'unknown') =>
  Number.isFinite(value) ? String(value) : missing

const durationText = (value) => {
  if (!Number.isFinite(value)) return 'unknown'
  if (value < 60) return `${Math.round(value)}s`
  if (value < 3600) return `${Math.floor(value / 60)}m`
  return `${Math.floor(value / 3600)}h`
}

function displayTime(value, timeZone) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'unknown'
  try {
    return new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(new Date(value)).replace(',', '')
  } catch {
    return 'unknown'
  }
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function freshState(snapshot) {
  const expiry = Date.parse(String(snapshot?.observation?.expires_at || ''))
  if (!Number.isFinite(expiry)) return 'unknown'
  return Date.now() >= expiry ? 'stale' : 'fresh'
}

function nodeForRole(nodes, role) {
  return nodes.find((node) => node.role === role) || null
}

function workerY(index) {
  return 72 + index * 92
}

function connectorPath(edge, lane) {
  const dispatcher = nodeForRole(lane.nodes, 'dispatcher')
  const evaluator = nodeForRole(lane.nodes, 'evaluator')
  const workerIndex = lane.nodes
    .filter((node) => node.role === 'worker')
    .findIndex((node) => node.agent_id === edge.to)
  if (edge.kind === 'dispatch') {
    return `M 220 92 H 286 V ${workerY(Math.max(0, workerIndex))} H 320`
  }
  if (edge.kind === 'collection') {
    const index = lane.nodes.filter((node) => node.role === 'worker')
      .findIndex((node) => node.agent_id === edge.from)
    return `M 600 ${workerY(Math.max(0, index))} H 660 V 92 H 700`
  }
  if (edge.kind === 'reject-loop') {
    return 'M 790 110 C 760 22, 360 22, 320 72'
  }
  if (edge.kind === 'pass-handoff') {
    return 'M 860 92 H 930'
  }
  return 'M 0 0'
}

function connectorSvg(lane) {
  if (!lane.configured) return ''
  return `<svg class="connector-layer" viewBox="0 0 960 ${Math.max(180, 112 + lane.nodes.filter((node) => node.role === 'worker').length * 92)}" aria-hidden="true" focusable="false">
    ${lane.edges.map((edge) => `<path class="connector connector-${esc(edge.kind)}" d="${connectorPath(edge, lane)}"></path>`).join('')}
  </svg>`
}

function livenessDetails(node) {
  const evidence = node.liveness_evidence
  if (!evidence) return ''
  const progress = node.progress_evidence || {}
  const toolLabel = (tool) => {
    if (!tool || typeof tool !== 'object') return null
    const name = [tool.title, tool.kind, tool.status].filter(Boolean).join(' · ')
    const id = tool.tool_call_id ? ` (${tool.tool_call_id})` : ''
    const digests = ['content_digest', 'output_digest', 'locations_digest']
      .filter((key) => typeof tool[key] === 'string')
      .map((key) => key.replace(/_digest$/, ''))
    return `${name || 'tool'}${id}${digests.length ? ` · ${digests.join(', ')}` : ''}`
  }
  const tools = Array.isArray(evidence.active_tools) && evidence.active_tools.length
    ? evidence.active_tools.map(toolLabel).filter(Boolean).map((tool) => `<code>${esc(tool)}</code>`).join(', ')
    : 'none reported'
  const stallHistory = Array.isArray(evidence.stall_history) ? evidence.stall_history : []
  const stallText = stallHistory.length
    ? stallHistory.map((entry) => `${esc(entry.state)} · ${esc(entry.evidence || 'evidence recorded')}${entry.reason ? ` · reason ${esc(entry.reason)}` : ''}`).join('; ')
    : 'not detected'
  return `<details class="agent-evidence"><summary>Evidence details</summary><dl>
    <div><dt>liveness state</dt><dd data-liveness-detail="state">${esc(evidence.liveness_state)}</dd></div>
    <div><dt>observed at</dt><dd>${esc(evidence.observed_at || 'unknown')}</dd></div>
    <div><dt>last protocol activity</dt><dd>${esc(evidence.last_protocol_activity_at || 'unknown')}</dd></div>
    <div><dt>last meaningful progress</dt><dd>${esc(evidence.last_meaningful_progress_at || 'unknown')}</dd></div>
    <div><dt>active tools</dt><dd>${tools}</dd></div>
    <div><dt>termination reason</dt><dd>${esc(evidence.termination_reason || 'none reported')}</dd></div>
    <div><dt>stall history</dt><dd>${stallText}</dd></div>
    <div><dt>elapsed / silence</dt><dd>${durationText(progress.elapsed_sec)} / ${durationText(progress.silence_sec)}</dd></div>
  </dl></details>`
}

function nodeHtml(node) {
  const phaseId = node.phase ? node.phase.toLowerCase() : 'unassigned'
  const phaseSource = node.phase_source || 'unassigned'
  const runtime = node.runtime
  const runtimeAttrs = `data-agent-run-id="${esc(runtime?.agent_run_id || '')}" data-attempt-id="${esc(runtime?.attempt_id || '')}" data-queue-wait-ms="${runtime?.queue_wait_ms ?? ''}" data-service-ms="${runtime?.service_ms ?? ''}" data-bottleneck="${node.bottleneck ? 'true' : 'false'}"`
  const runtimeFacts = runtime
    ? `<div><dt>queue wait</dt><dd>${numberText(runtime.queue_wait_ms)} ms</dd></div><div><dt>service</dt><dd>${numberText(runtime.service_ms)} ms</dd></div><div><dt>attempt</dt><dd><code>${esc(runtime.attempt_id || 'none')}</code></dd></div>${runtime.bottleneck ? '<div><dt>bottleneck</dt><dd>active tool service</dd></div>' : ''}`
    : ''
  return `<article class="agent-node role-${esc(node.role)} status-${esc(node.status)}" data-agent-id="${esc(node.agent_id)}" data-agent-node="true" data-identity-conflict="${node.identity_conflict ? 'true' : 'false'}" data-phase-id="${esc(phaseId)}" data-phase-source="${esc(phaseSource)}" data-task-id="${esc(node.task_id || '')}" data-state="${esc(node.state)}" data-status="${esc(node.status)}" data-state-group="${esc(node.state_group || 'unknown')}" data-liveness-state="${esc(node.liveness_state)}" data-team-id="${esc(node.team_id)}" data-role="${esc(node.role)}" data-model="${esc(node.model || '')}" ${runtimeAttrs} tabindex="0" role="group" aria-label="${esc(`${node.role_label}: ${node.agent_id}`)}">
    <div class="node-heading"><span class="status-dot" aria-hidden="true"></span><code class="agent-id">${esc(node.agent_id)}</code></div>
    <p class="node-role">${esc(node.role_label)}</p>
    <dl class="node-facts">
      <div><dt>task</dt><dd>${esc(node.current_task)}</dd></div>
      <div><dt>status</dt><dd class="status-value">${esc(node.status_label)}</dd></div>
      ${node.provider ? `<div><dt>provider</dt><dd><code>${esc(node.provider)}</code></dd></div>` : ''}
      ${node.model ? `<div><dt>model</dt><dd><code>${esc(node.model)}</code></dd></div>` : ''}
      ${runtimeFacts}
      <div><dt>evidence</dt><dd>${esc(node.status_evidence)}</dd></div>
    </dl>
    ${node.phase_conflict ? '<p class="node-warning">phase binding ขัดแย้ง · ไม่เลือกเฟสแบบ first-source-wins</p>' : ''}
    ${livenessDetails(node)}
  </article>`
}

function edgeHtml(edge) {
  const direction = edge.kind === 'reject-loop' ? '↺' : '→'
  const runtime = edge.runtime
  return `<div class="flow-edge edge-${esc(edge.kind)}" data-flow-edge="true" data-edge-kind="${esc(edge.kind)}" data-from-agent-id="${esc(edge.from)}" data-to-agent-id="${esc(edge.to)}" data-team-id="${esc(edge.team_id)}" data-runtime-state="${esc(runtime?.runtime_state || '')}" data-decision-id="${esc(runtime?.decision_id || '')}" data-attempt-id="${esc(runtime?.attempt_id || '')}" data-handoff-id="${esc(runtime?.handoff_id || '')}" aria-label="${esc(edge.label)}"><span class="edge-symbol" aria-hidden="true">${direction}</span><span>${esc(edge.label)}</span>${runtime?.runtime_state ? ` <small>${esc(runtime.runtime_state)}</small>` : ''}</div>`
}

function teamLaneHtml(lane) {
  const dispatcher = lane.nodes.filter((node) => node.role === 'dispatcher')
  const workers = lane.nodes.filter((node) => node.role === 'worker')
  const evaluator = lane.nodes.filter((node) => node.role === 'evaluator')
  const other = lane.nodes.filter((node) => ['unassigned', 'outer_controller'].includes(node.role))
  const hasProjectCompletion = lane.edges.some((edge) => edge.to === 'project-complete')
  const stage = lane.project_control
    ? `<div class="unassigned-grid">${other.map(nodeHtml).join('')}</div>`
    : lane.configured
    ? `<div class="lane-stage">
        ${connectorSvg(lane)}
        <div class="lane-columns">
          <div class="agent-column dispatcher-column"><span class="column-label">Dispatch</span>${dispatcher.map(nodeHtml).join('')}</div>
          <div class="agent-column worker-column"><span class="column-label">Workers · fan-out</span><div class="worker-grid">${workers.map(nodeHtml).join('')}</div></div>
          <div class="agent-column evaluator-column"><span class="column-label">Evaluate</span>${evaluator.map(nodeHtml).join('')}${hasProjectCompletion ? '<div class="project-completion-endpoint" data-project-completion-endpoint="true" data-endpoint-id="project-complete" role="status"><strong>Project complete</strong><span>pass handoff endpoint</span></div>' : ''}</div>
        </div>
      </div>`
    : `<div class="unassigned-grid">${other.map(nodeHtml).join('') || '<p class="empty-lane">No observed ACP agents.</p>'}</div>`
  return `<section class="team-lane${lane.configured ? '' : ' unassigned-lane'}" data-team-lane="true" data-team-id="${esc(lane.team_id)}" data-team-name="${esc(lane.name)}"${lane.configured || lane.project_control ? '' : ' data-control-unassigned="true"'}${lane.project_control ? ' data-project-control="true"' : ''}>
    <header class="lane-header"><div><span class="lane-kicker">Team lane</span><h2>${esc(lane.name)}</h2></div><span class="lane-agent-count">${lane.nodes.length} agent${lane.nodes.length === 1 ? '' : 's'}</span></header>
    ${stage}
    ${lane.edges.length ? `<div class="flow-edge-list" aria-label="Flow edges">${lane.edges.map(edgeHtml).join('')}</div>` : ''}
  </section>`
}

function summaryHtml(counts) {
  const items = [
    ['working', 'Working', counts.working],
    ['waiting', 'Waiting', counts.waiting],
    ['blocked-stalled', 'Blocked / stalled', counts.blocked_stalled],
    ['done', 'Done', counts.done],
    ['not-started', 'Not started', counts.not_started],
    ['unknown', 'Unknown', counts.unknown],
  ]
  return `<section data-screen-section="summary" class="summary-strip" aria-label="Operational agent counts" data-operational-node-count="${counts.total}">
    ${items.map(([key, label, count]) => `<div class="summary-card status-${key}" data-count-state="${esc(key === 'blocked-stalled' ? 'blocked' : key.replace('-', '_'))}" data-count="${count}" data-count-${key}="${count}" data-status="${key}"><span>${label}</span><strong>${count}</strong></div>`).join('')}
  </section>`
}

function legendHtml() {
  return `<section data-screen-section="legend" aria-labelledby="legend-title"><h2 id="legend-title" class="sr-only">Status legend</h2><ul class="legend" aria-label="Status legend">
    <li><span class="legend-dot working" aria-hidden="true"></span>working</li>
    <li><span class="legend-dot waiting" aria-hidden="true"></span>waiting</li>
    <li><span class="legend-dot blocked-stalled" aria-hidden="true"></span>stalled / blocked</li>
    <li><span class="legend-dot done" aria-hidden="true"></span>done</li>
    <li><span class="legend-dot not-started" aria-hidden="true"></span>not started</li>
    <li><span class="legend-dot unknown" aria-hidden="true"></span>unknown</li>
  </ul></section>`
}

function auditHtml(audit, auditTotal = audit.length) {
  const displayed = audit.length
  const total = Math.max(displayed, Number.isSafeInteger(auditTotal) ? auditTotal : displayed)
  return `<section data-screen-section="history" aria-labelledby="history-title"><h2 id="history-title" class="sr-only">Historical audit</h2><details class="audit" id="graph-audit" data-history-total="${total}" data-history-displayed="${displayed}"><summary>Historical audit evidence <span>${total}</span></summary>
    ${audit.length ? `<ul>${audit.map((item) => `<li data-history-run="true" data-audit-task-id="${esc(item.task_id)}"><code>${esc(item.task_id)}</code><span data-history-state="${esc(item.state)}">${esc(item.state)}</span><small>${esc(item.reason)} · agent ${esc(item.agent_id)}${item.termination_reason ? ` · termination ${esc(item.termination_reason)}` : ''}${item.stall_history?.length ? ` · ${item.stall_history.map((entry) => `${entry.state}${entry.reason ? ` (${entry.reason})` : ''}`).join(', ')}` : ''}</small></li>`).join('')}</ul>` : '<p>No historical evidence in this snapshot.</p>'}
  </details></section>`
}

function evidenceNoticeHtml(snapshot, topology) {
  const diagnostics = Array.isArray(topology?.diagnostics) ? topology.diagnostics : []
  if (!diagnostics.length && !topology?.configuration_error) return ''
  const labels = diagnostics.slice(0, 8).map((item) => `${item.code || 'unknown'} (${item.source || 'unknown'})`)
  return `<section data-screen-section="evidence-notice" class="evidence-notice" aria-labelledby="evidence-notice-title"><h2 id="evidence-notice-title">Evidence notice</h2><p>Some inputs are unknown or unassigned; the flow does not infer missing Team, role, task, or progress.</p><ul>${labels.map((label) => `<li>${esc(label)}</li>`).join('')}</ul></section>`
}

function handoffHtml(handoffs) {
  if (!Array.isArray(handoffs) || !handoffs.length) return ''
  return `<section class="observed-handoffs" aria-labelledby="observed-handoffs-title"><span class="lane-kicker">Serialized handoff evidence</span><h2 id="observed-handoffs-title">Passed artifact recipients</h2><ul>${handoffs.map((handoff) => `<li><span class="handoff-arrow" aria-hidden="true">→</span><strong>${esc(handoff.downstream_dispatcher_agent_id || 'Project complete')}</strong><span>${esc(handoff.state)}</span><code>${esc(handoff.handoff_id)}</code></li>`).join('')}</ul></section>`
}

const CSS = `
:root{color-scheme:light;--ink:#172126;--muted:#647177;--line:#d8e0e2;--surface:#fff;--surface-2:#f5f8f8;--bg:#eef3f2;--working:#15805d;--waiting:#b7791f;--blocked:#b84444;--done:#2767a6;--not-started:#7c878b;--focus:#315fba;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.45;overflow-x:hidden}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.graph-shell{max-width:1680px;margin:0 auto;padding:20px 24px 36px}.graph-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}.eyebrow,.lane-kicker{color:var(--muted);font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.graph-header h1{margin:3px 0 4px;font-size:clamp(1.45rem,2vw,2.15rem);line-height:1.1}.graph-header p{margin:0;color:var(--muted)}.graph-time{flex:none;text-align:right;color:var(--muted);font-size:.78rem}.graph-time .time-zone-label,.graph-time time{display:block}.graph-time .time-zone-label{color:var(--ink);font-weight:700}.graph-time time{margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:var(--ink)}.skip-link{position:absolute;left:12px;top:8px;z-index:5;transform:translateY(-160%);padding:8px 12px;border-radius:8px;background:var(--ink);color:var(--surface)}.skip-link:focus{transform:none}
.graph-time button{min-height:44px;margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);font:600 .75rem ui-sans-serif,system-ui,sans-serif;cursor:pointer}.graph-time button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.summary-strip{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:10px;margin:0 0 12px}.summary-card{display:grid;gap:2px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.summary-card span{color:var(--muted);font-size:.72rem}.summary-card strong{font-size:1.35rem;font-variant-numeric:tabular-nums}.summary-card.status-working strong{color:var(--working)}.summary-card.status-waiting strong{color:var(--waiting)}.summary-card.status-blocked-stalled strong{color:var(--blocked)}.summary-card.status-done strong{color:var(--done)}.summary-card.status-not-started strong{color:var(--not-started)}.summary-card.status-unknown strong{color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:7px 16px;margin:0 0 15px;padding:0;list-style:none;color:var(--muted);font-size:.78rem}.legend li{display:flex;align-items:center;gap:6px}.legend-dot,.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--not-started);flex:none}.legend-dot.working,.status-working .status-dot{background:var(--working)}.legend-dot.waiting,.status-waiting .status-dot{background:var(--waiting)}.legend-dot.blocked-stalled,.status-blocked .status-dot,.status-stalled .status-dot{background:var(--blocked)}.legend-dot.done,.status-done .status-dot{background:var(--done)}.legend-dot.unknown,.status-unknown .status-dot{background:var(--muted)}
.graph-viewport{max-width:100%;overflow-x:auto;overflow-y:visible;padding:2px 2px 12px}.team-flow{display:flex;align-items:stretch;gap:16px;min-width:100%;width:max-content}.team-lane{flex:0 1 760px;min-width:min(760px,calc(100vw - 56px));padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:0 2px 10px rgb(23 33 38 / 5%)}.team-lane.unassigned-lane{flex-basis:100%;min-width:min(760px,calc(100vw - 56px))}.lane-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--line)}.lane-header h2{margin:2px 0 0;font-size:1.1rem}.lane-agent-count{color:var(--muted);font-size:.78rem;white-space:nowrap}.lane-stage{position:relative;min-height:205px;margin-top:12px}.lane-columns{position:relative;z-index:1;display:grid;grid-template-columns:minmax(150px,1fr) minmax(190px,1.25fr) minmax(170px,1fr);gap:28px;align-items:start}.agent-column{display:grid;align-content:start;gap:7px;min-width:0}.column-label{color:var(--muted);font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.worker-grid{display:grid;gap:9px}.connector-layer{position:absolute;inset:0;width:100%;height:100%;z-index:0;overflow:visible}.connector{fill:none;stroke:#9aabad;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.connector-reject-loop{stroke:var(--blocked);stroke-dasharray:6 5}.connector-pass-handoff{stroke:var(--done)}
.agent-node{min-width:0;min-height:44px;padding:10px;border:1px solid var(--line);border-left:4px solid var(--not-started);border-radius:10px;background:var(--surface-2);box-shadow:0 1px 4px rgb(23 33 38 / 5%)}.agent-node:focus-visible,.graph-viewport:focus-visible,.agent-evidence summary:focus-visible,.audit summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}.agent-node.status-working{border-left-color:var(--working)}.agent-node.status-waiting{border-left-color:var(--waiting)}.agent-node.status-blocked,.agent-node.status-stalled{border-left-color:var(--blocked)}.agent-node.status-done{border-left-color:var(--done)}.agent-node.status-unknown{border-left-color:var(--muted)}.node-heading{display:flex;align-items:center;gap:7px;min-width:0}.agent-id{font-size:.8rem;font-weight:700;color:var(--ink)}.node-role{margin:4px 0 7px;color:var(--muted);font-size:.72rem}.node-facts{display:grid;gap:4px;margin:0;font-size:.73rem}.node-facts div{display:grid;grid-template-columns:58px minmax(0,1fr);gap:7px}.node-facts dt{color:var(--muted)}.node-facts dd{margin:0;overflow-wrap:anywhere}.status-value{font-weight:700}.node-warning{margin:8px 0 0;color:var(--blocked);font-size:.7rem}.agent-evidence{margin-top:8px;border-top:1px solid var(--line);padding-top:6px}.agent-evidence summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--muted);font-size:.7rem}.agent-evidence dl{display:grid;gap:4px;margin:7px 0 0;font-size:.68rem}.agent-evidence dl div{display:grid;grid-template-columns:100px minmax(0,1fr);gap:7px}.agent-evidence dt{color:var(--muted)}.agent-evidence dd{margin:0;overflow-wrap:anywhere}.unassigned-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}.empty-lane{margin:4px 0;color:var(--muted);font-size:.82rem}.flow-edge-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}.flow-edge{display:inline-flex;align-items:center;min-height:44px;gap:6px;padding:5px 8px;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:.7rem}.edge-reject-loop{border-color:color-mix(in srgb,var(--blocked) 45%,var(--line));color:var(--blocked)}.edge-pass-handoff{border-color:color-mix(in srgb,var(--done) 45%,var(--line));color:var(--done)}.edge-symbol{font-size:1rem;font-weight:700}.project-completion-endpoint{display:grid;gap:2px;min-height:44px;margin-top:9px;padding:9px 10px;border:2px solid var(--done);border-radius:10px;background:color-mix(in srgb,var(--done) 8%,var(--surface));color:var(--done);font-size:.72rem}.project-completion-endpoint span{color:var(--muted);font-size:.68rem}.audit{margin-top:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.audit summary{min-height:44px;display:flex;align-items:center;padding:10px 12px;cursor:pointer;color:var(--muted);font-size:.8rem}.audit ul{display:grid;gap:7px;margin:0;padding:10px 12px 12px 30px;border-top:1px solid var(--line)}.audit li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:.72rem}.audit li small{grid-column:1/-1;color:var(--muted)}.graph-footer{margin-top:14px;color:var(--muted);font-size:.7rem}.graph-footer code{color:var(--ink)}
.observed-handoffs{margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.observed-handoffs h2{margin:2px 0 8px;font-size:.95rem}.observed-handoffs ul{display:flex;flex-wrap:wrap;gap:7px 14px;margin:0;padding:0;list-style:none;color:var(--muted);font-size:.75rem}.observed-handoffs li{display:inline-flex;align-items:center;gap:6px}.observed-handoffs strong{color:var(--ink)}.handoff-arrow{color:var(--done);font-size:1rem}
.evidence-notice{margin:0 0 14px;padding:12px;border:1px solid color-mix(in srgb,var(--waiting) 55%,var(--line));border-radius:10px;background:var(--surface)}.evidence-notice h2{margin:0 0 4px;font-size:.95rem}.evidence-notice p{margin:0;color:var(--muted);font-size:.78rem}.evidence-notice ul{display:flex;flex-wrap:wrap;gap:6px 14px;margin:7px 0 0;padding-left:18px;color:var(--muted);font-size:.72rem}
@media(max-width:760px){.graph-shell{padding:14px 12px 26px}.graph-header{display:grid;gap:10px}.graph-time{text-align:left}.summary-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-card:last-child{grid-column:1/-1}.team-flow{width:100%;display:grid}.team-lane,.team-lane.unassigned-lane{width:100%;min-width:0}.lane-columns{grid-template-columns:1fr;gap:12px}.lane-stage{min-height:0}.connector-layer{display:none}.agent-column{gap:7px}.worker-grid{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.flow-edge-list{display:grid}.flow-edge{border-radius:8px}.audit li{grid-template-columns:1fr}}
@media(forced-colors:active){.summary-card,.team-lane,.agent-node,.audit,.flow-edge{border-color:CanvasText}.connector{stroke:CanvasText}.legend-dot{forced-color-adjust:none;background:Highlight}.graph-time .time-zone-label,.status-value{color:CanvasText}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
`

export function renderTopologyGraph(snapshot, topology, {
  fontCssName = 'pulse-fonts.css',
  timeZone = 'Asia/Bangkok',
  timeZoneLabel = 'เวลาไทย (UTC+7)',
  refreshScriptName = DEFAULT_REFRESH_SCRIPT_NAME,
} = {}) {
  const counts = topology?.counts || {
    total: 0, working: 0, waiting: 0, blocked_stalled: 0, done: 0, not_started: 0, unknown: 0,
  }
  const freshness = freshState(snapshot)
  const snapshotId = safeText(snapshot?.snapshot_id, 'unknown')
  const generatedAt = snapshot?.generated_at || ''
  const repoName = snapshot?.scope?.repo_name || 'unknown'
  const graphPayload = {
    project_id: topology?.project_id || null,
    configured: Boolean(topology?.configured),
    source_digest: topology?.source_digest || null,
    counts,
    lanes: topology?.lanes || [],
    edges: topology?.edges || [],
    project_completion_endpoint: topology?.project_completion_endpoint || null,
    handoffs: topology?.handoffs || [],
    audit: topology?.audit || [],
    audit_total: Number.isSafeInteger(topology?.audit_total)
      ? topology.audit_total : (topology?.audit || []).length,
    diagnostics: topology?.diagnostics || [],
    team_runtime: topology?.runtime || null,
  }
  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="tmux-teams-snapshot-id" content="${esc(snapshotId)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">
<title>Pulse agent flow · ${esc(repoName)}</title>
<link rel="stylesheet" href="${esc(fontCssName)}"><style>${CSS}</style></head>
<body data-observation-freshness="${freshness}" data-observation-expires-at="${esc(snapshot?.observation?.expires_at || '')}" data-refresh-interval="${Number(snapshot?.observation?.refresh_interval_sec) || 20}"><a class="skip-link" href="#team-flow">Skip to team flow</a><div class="graph-shell">
<header data-screen-section="header" class="graph-header"><div><span class="eyebrow">tmux teams · operational flow</span><h1>Agent flow · ${esc(repoName)}</h1><p>One visible node equals one configured or observed agent instance.</p></div>
<div class="graph-time"><span id="loop-timezone-label" class="time-zone-label">${esc(timeZoneLabel)}</span><span>observed at</span><time datetime="${esc(generatedAt)}" title="${esc(timeZone)}" aria-describedby="loop-timezone-label">${esc(displayTime(generatedAt, timeZone))}</time><span id="graph-freshness-status" data-refresh-status>${freshness === 'stale' ? 'Snapshot expired' : freshness === 'fresh' ? 'Snapshot fresh' : 'Freshness unknown'}</span><button type="button" data-refresh-toggle data-refresh-focus-key="refresh-toggle" aria-pressed="false">Pause updates</button><small id="graph-refresh-note" data-refresh-note>Polling the local snapshot marker</small></div></header>
<main id="loop-graph" class="graph-page" data-agent-node-count="${counts.total}" data-count-working="${counts.working}" data-count-waiting="${counts.waiting}" data-count-blocked-stalled="${counts.blocked_stalled}" data-count-done="${counts.done}" data-count-not-started="${counts.not_started}" data-count-unknown="${counts.unknown}" data-base-aria-label="Operational agent flow">
${summaryHtml(counts)}${evidenceNoticeHtml(snapshot, topology)}${legendHtml()}
<section data-screen-section="team-flow" id="team-flow" aria-labelledby="team-flow-title"><h2 id="team-flow-title" class="sr-only">Team flow</h2><p id="team-flow-semantic-summary" class="sr-only">${esc(`Operational flow with ${counts.total} visible agent nodes: dispatchers fan out work to workers, workers collect into evaluators, evaluators reject back to their dispatcher or pass to the next Team.`)}</p><div class="graph-viewport" data-refresh-scroll-key="team-flow" tabindex="0" role="region" aria-label="Team agent flowchart" aria-describedby="team-flow-semantic-summary">${(topology?.lanes || []).map(teamLaneHtml).join('')}</div></section>
${handoffHtml(topology?.handoffs || [])}
${auditHtml(topology?.audit || [], topology?.audit_total)}
<p class="graph-footer">Source snapshot <code>${esc(snapshotId)}</code> · status and progress are evidence labels; no role or team is inferred from names.</p>
</main>
<script type="application/json" id="loop-graph-data">${safeJson(graphPayload)}</script>
<script src="${esc(refreshScriptName)}" defer></script>
</div></body></html>`
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}
