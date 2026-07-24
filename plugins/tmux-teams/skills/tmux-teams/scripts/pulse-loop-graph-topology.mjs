// Standalone D3-assisted phase flowchart for Pulse ACP evidence.
//
// The phase backbone and inner loops are a normative operating model. Solid
// spokes only place a dispatch at an explicitly observed phase, or at the
// honest unassigned pool. No agent-to-agent or observed handoff is rendered.

const STALE_NODE_COPY = 'snapshot หมดอายุ · สถานะนี้เป็นหลักฐานล่าสุด ไม่ใช่สถานะปัจจุบัน'
const UNKNOWN_NODE_COPY = 'ตรวจ freshness ไม่ได้ · สถานะนี้เป็นหลักฐานล่าสุด ไม่ใช่สถานะปัจจุบัน'

const esc = (value) => String(value ?? '').replace(
  /[&<>"]/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
)

const duration = (seconds) => seconds == null
  ? 'ยังไม่วัด'
  : seconds < 60
    ? `${Math.round(seconds)} วิ`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} นาที`
      : `${Math.floor(seconds / 3600)} ชม. ${Math.floor((seconds % 3600) / 60)} นาที`

const shortIdentity = (value, max = 22) => {
  const text = String(value ?? '')
  if (text.length <= max) return text
  const side = Math.floor((max - 1) / 2)
  return `${text.slice(0, side)}…${text.slice(-side)}`
}

function dateTimeFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

function semanticTime(value, timeZone, formatter) {
  const milliseconds = Date.parse(String(value || ''))
  if (!Number.isFinite(milliseconds)) return '<span class="time-unavailable">ยังไม่วัด</span>'
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(milliseconds))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  const label = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  return `<time datetime="${esc(new Date(milliseconds).toISOString())}" title="${esc(timeZone)}" aria-describedby="loop-timezone-label">${esc(label)}</time>`
}

const freshnessCopy = (freshness) => freshness === 'stale'
  ? STALE_NODE_COPY
  : freshness === 'unknown' ? UNKNOWN_NODE_COPY : ''

function phaseForNode(topology, node) {
  if (node.placement_id === 'unassigned') {
    return {
      title: 'ยังไม่ผูกเฟส',
      thai: 'ไม่มี phase binding ที่ใช้ได้',
      deliverable: 'phase อาจไม่ได้ระบุหรือมีหลักฐานขัดแย้ง จึงยังระบุ outcome ไม่ได้',
      exit_artifact: 'unassigned',
    }
  }
  return topology.phases.find((phase) => phase.id === node.placement_id) || {
    title: node.placement_id,
    thai: '',
    deliverable: 'ไม่ทราบ outcome',
    exit_artifact: 'unknown',
  }
}

function nodeAria(topology, node, freshness) {
  const phase = phaseForNode(topology, node)
  const base = `${node.agent}, งาน ${node.task_id}, เฟส ${phase.title}, ${node.label}. ` +
    `dispatch ${node.signals.dispatch}, process ${node.signals.liveness}, ` +
    `terminal ${node.signals.terminal}, verdict ${node.signals.verdict}`
  const qualifier = freshnessCopy(freshness)
  return { base, full: qualifier ? `${qualifier}. ${base}` : base }
}

function agentNodeSvg(topology, node, {
  selectedNodeId,
  initialFreshness,
}) {
  const aria = nodeAria(topology, node, initialFreshness)
  const weakIdentity = node.identity_source !== 'dispatch_id'
  const classes = [
    'agent-node',
    `tone-${node.tone}`,
    node.historical ? 'is-historical' : 'is-live',
    node.attention ? 'needs-attention' : '',
    weakIdentity ? 'weak-identity' : '',
  ].filter(Boolean).join(' ')
  const selected = node.node_id === selectedNodeId
  return `<g class="${classes}" transform="translate(${node.x} ${node.y})"
    data-agent-node="true" data-node-id="${esc(node.node_id)}"
    data-phase-id="${esc(node.placement_id)}" data-phase-source="${esc(node.phase_source)}"
    data-state="${esc(node.state)}"
    data-dispatch-id="${esc(node.dispatch_id || '')}" data-task-id="${esc(node.task_id)}"
    data-node-freshness="${esc(initialFreshness)}"
    data-evidence="${node.historical ? 'recorded-event' : 'live-projection'}"
    data-base-aria-label="${esc(aria.base)}" role="button"
    aria-label="${esc(aria.full)}" aria-controls="graph-inspector"
    aria-expanded="false" aria-pressed="${selected ? 'true' : 'false'}"
    tabindex="${selected ? '0' : '-1'}">
    <title>${esc(aria.full)}</title>
    <circle class="node-attention-ring" r="${node.radius + 8}" aria-hidden="true"/>
    <circle class="node-focus-ring" r="${node.radius + 5}" aria-hidden="true"/>
    <circle class="node-core" r="${node.radius}" aria-hidden="true"/>
    ${node.historical
      ? `<circle class="node-history-ring" r="${Math.max(4, node.radius - 5)}" aria-hidden="true"/>`
      : ''}
    <text class="node-agent-label" y="4" text-anchor="middle" aria-hidden="true">${esc(shortIdentity(node.agent, 9))}</text>
  </g>`
}

const PHASE_OUTCOME_LINES = Object.freeze({
  requirement: ['Business function · validation · exception', 'security · performance · integration'],
  prototype: ['Clickable prototype', 'ยืนยัน flow ที่ใช้งานได้'],
  development: ['Working software', 'พร้อมส่งให้ QA ตรวจ'],
  qa: ['E2E test report · UAT report', 'หลักฐานสำหรับผู้รับปลายทาง'],
})

function phaseCardSvg(phase) {
  const outcomeLines = PHASE_OUTCOME_LINES[phase.id] || [phase.deliverable]
  const stateCopy = phase.state === 'not_observed' ? 'ยังไม่มี phase telemetry' : phase.state
  const activeCopy = phase.owner_role
    ? `owner: ${phase.owner_role} · work ${duration(phase.work_age_sec)} · wait ${duration(phase.wait_age_sec)}`
    : phase.active_slices === null ? 'active slices: ไม่ทราบ' : `active slices: ${phase.active_slices}`
  const bottleneckCopy = phase.bottleneck
    ? `BOTTLENECK ${phase.bottleneck.kind} · ${duration(phase.bottleneck.age_sec)} · ${phase.bottleneck.owner_role}`
    : ''
  const planY = phase.plan_y
  const agentRegion = phase.agent_region
  const agentBottom = agentRegion.y + agentRegion.height
  const reviewY = phase.review_y
  const artifactY = phase.artifact_y
  return `<g class="phase-team${phase.attention ? ' phase-attention' : ''}"
    data-phase-team="true" data-phase-id="${esc(phase.id)}"
    data-phase-state="${esc(phase.state)}" data-phase-source="${esc(phase.assignment_source)}"
    data-phase-run-id="${esc(phase.phase_run_id || '')}"
    data-bottleneck="${phase.bottleneck ? 'true' : 'false'}"
    transform="translate(${phase.x} ${phase.y})">
    <rect class="phase-boundary" width="${phase.width}" height="${phase.height}" rx="22"/>
    <circle class="phase-step" cx="30" cy="32" r="17"/>
    <text class="phase-step-copy" x="30" y="36" text-anchor="middle">${esc(phase.step)}</text>
    <text class="phase-title" x="58" y="29">${esc(phase.title)}</text>
    <text class="phase-thai" x="58" y="49">${esc(phase.thai)}</text>
    <text class="phase-state" x="${phase.width - 16}" y="28" text-anchor="end">${esc(stateCopy)}</text>
    <text class="phase-state" x="${phase.width - 16}" y="47" text-anchor="end">${esc(activeCopy)}</text>
    <text class="phase-bottleneck" x="${phase.width - 16}" y="64" text-anchor="end">${esc(bottleneckCopy)}</text>
    <text class="phase-outcome-label" x="20" y="76">EXPECTED OUTCOME / EXIT</text>
    <text class="phase-outcome" x="20" y="96">${esc(outcomeLines[0])}</text>
    <text class="phase-outcome" x="20" y="114">${esc(outcomeLines[1] || '')}</text>
    <g class="inner-model" aria-hidden="true">
      <rect class="flow-action" x="18" y="${planY}" width="112" height="34" rx="17"/>
      <text class="flow-action-copy" x="74" y="${planY + 21}" text-anchor="middle">1 · วางแผน slice</text>
      <path class="inner-edge" data-edge-kind="model-inner-loop" d="M 130 ${planY + 17} H 135 V ${agentRegion.y - 7}" marker-end="url(#model-arrow)"/>
      <path class="inner-edge" data-edge-kind="model-inner-loop" d="M 135 ${agentBottom + 6} V ${reviewY} H 166" marker-end="url(#model-arrow)"/>
      <polygon class="review-decision" points="212,${reviewY - 30} 252,${reviewY} 212,${reviewY + 30} 172,${reviewY}"/>
      <text class="review-title" x="212" y="${reviewY - 4}" text-anchor="middle">3 · ทีมตรวจ</text>
      <text class="review-copy" x="212" y="${reviewY + 12}" text-anchor="middle">accept / reject</text>
      <path class="inner-edge pass-edge" data-edge-kind="model-inner-loop" d="M 212 ${reviewY + 30} V ${artifactY - 6}" marker-end="url(#model-arrow)"/>
      <path class="inner-edge rework-edge" data-edge-kind="model-inner-loop" d="M 172 ${reviewY} H 10 V ${planY + 17} H 14" marker-end="url(#model-arrow)"/>
      <text class="rework-copy" x="24" y="${reviewY - 15}">reject → rework → วางแผนใหม่</text>
    </g>
    <g class="artifact-node" aria-hidden="true">
      <path d="M 22 ${artifactY} H 246 V ${artifactY + 40} H 22 Z M 218 ${artifactY} V ${artifactY + 16} H 246"/>
      <text class="artifact-label" x="34" y="${artifactY + 17}">4 · EXIT ARTIFACT</text>
      <text class="artifact-name" x="34" y="${artifactY + 33}">${esc(phase.exit_artifact)}</text>
    </g>
    <text class="agent-count" x="135" y="${phase.agent_count_y}" text-anchor="middle">2 · ${phase.agent_count} ACP agents ที่ผูกเฟส</text>
  </g>`
}

function signal(label, value, tone = '') {
  return `<div class="signal${tone ? ` ${tone}` : ''}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
}

const terminalTone = (node) => node.signals.terminal === 'TEAM_DONE'
  ? 'neutral'
  : node.signals.terminal === 'ยังไม่มี' ? '' : 'warn'

const verdictTone = (node) => node.verdict_conflict
  ? 'bad'
  : node.signals.verdict === 'ผ่าน'
    ? 'ok'
    : node.signals.verdict === 'ให้แก้ไข'
      ? 'bad'
      : node.signals.verdict === 'ยังไม่สรุป' ? 'warn' : ''

function identityNote(node) {
  if (node.evidence_conflict === 'history') {
    return 'หลักฐาน history ใช้ dispatch identity ซ้ำ · รวมเป็น conflict node และไม่เลือกแถวแรก'
  }
  if (node.identity_conflict) return 'dispatch identity ขัดแย้ง · ไม่เลือกสถานะหรือ phase แบบ first-row-wins'
  if (node.phase_source === 'conflict') {
    return 'phase binding ขัดแย้ง · ไม่เลือกเฟสแบบ first-source-wins'
  }
  if (node.phase_binding_invalid) {
    return 'phase binding ไม่ผ่าน contract · จัดไว้ใน unassigned'
  }
  if (node.identity_source === 'legacy_task_time') return 'identity สำรอง · จับคู่ด้วย task + เวลาเริ่ม'
  if (node.identity_source === 'uncorrelatable') {
    return 'เชื่อม attempt ไม่ได้ · ไม่มี dispatch UUID และเวลาเริ่มที่ใช้ได้'
  }
  return ''
}

function inspectorHtml(topology, node, initialFreshness) {
  const qualifier = freshnessCopy(initialFreshness)
  if (!node) {
    return `<aside id="graph-inspector" class="graph-inspector" aria-label="รายละเอียด ACP agent" hidden>
      <p>ไม่มี ACP agent run ใน snapshot นี้</p>
    </aside>`
  }
  const phase = phaseForNode(topology, node)
  const elapsedLabel = node.historical
    ? 'ใช้เวลา'
    : node.state === 'died' || node.state === 'unrecorded' ? 'เงียบมา' : 'ผ่านไป'
  const elapsedValue = duration(node.historical
    ? node.elapsed_sec
    : node.state === 'died' || node.state === 'unrecorded'
      ? node.silence_sec
      : node.elapsed_sec)
  const note = identityNote(node)
  return `<aside id="graph-inspector" class="graph-inspector" aria-labelledby="inspector-agent" hidden>
    <header class="inspector-head">
      <div><span id="inspector-evidence" class="inspector-kicker">${node.historical ? 'ACP RUN ที่บันทึกแล้ว' : 'ACP RUN ที่กำลังติดตาม'}</span>
        <h2 id="inspector-agent">${esc(node.agent)}</h2></div>
      <button id="graph-inspector-close" type="button" aria-label="ปิดรายละเอียด">×</button>
    </header>
    <section class="outcome-risk">
      <span>OUTCOME ที่เกี่ยวข้อง</span>
      <strong id="inspector-phase">${esc(phase.title)}${phase.thai ? ` · ${esc(phase.thai)}` : ''}</strong>
      <p id="inspector-outcome">${esc(phase.deliverable)}</p>
      <code id="inspector-artifact">${esc(phase.exit_artifact)}</code>
    </section>
    <code id="inspector-task" class="inspector-task" title="${esc(node.task_id)}">${esc(node.task_id)}</code>
    <span id="inspector-state" class="inspector-state tone-${esc(node.tone)}">${esc(node.label)}</span>
    <p id="inspector-freshness" class="freshness-qualifier"${qualifier ? '' : ' hidden'}>${esc(qualifier || STALE_NODE_COPY)}</p>
    <dl class="inspector-meta priority">
      <div><dt>ถัดไป</dt><dd id="inspector-action">${esc(node.next_action)}</dd></div>
      <div><dt id="inspector-elapsed-label">${esc(elapsedLabel)}</dt><dd id="inspector-elapsed">${esc(elapsedValue)}</dd></div>
    </dl>
    <dl class="inspector-signals">
      ${signal('dispatch', node.signals.dispatch)}
      ${signal('process', node.signals.liveness, node.signals.liveness === 'พบ process' ? 'ok' : '')}
      ${signal('terminal', node.signals.terminal, terminalTone(node))}
      ${signal('verdict', node.signals.verdict, verdictTone(node))}
    </dl>
    <p id="inspector-meaning" class="inspector-meaning">${esc(node.meaning)}</p>
    <p id="inspector-identity" class="identity-note"${note ? '' : ' hidden'}>${esc(note)}</p>
  </aside>`
}

function semanticSummary(topology, initialFreshness) {
  return `<section class="sr-only" aria-labelledby="semantic-graph-title">
    <h2 id="semantic-graph-title">สรุป phase flowchart และ ACP agents แบบข้อความ</h2>
    <p>Outer flow: Requirement → Prototype → Development → QA → ProjectDelivery. Requirement ส่ง requirements baseline ให้ Prototype; Prototype ส่ง prototype evaluation ให้ Development; Development ส่ง working software ให้ QA; QA ส่ง E2E และ UAT evidence ให้ Project Delivery. เส้นทางนี้เป็นโมเดล ไม่ใช่หลักฐาน handoff สด.</p>
    <p>Inner loop ของทุก phase คือ วางแผน slice → มอบงานให้ ACP agent → ทีมเฟสตรวจผล → ถ้า reject ให้ rework และวนกลับไปวางแผน → เมื่อ accept จึงออก exit artifact เพื่อ handoff ไปเฟสถัดไป.</p>
    <p>Operational handoff edges เป็นเพียงการสังเกตแบบ advisory ภายใต้ same-UID trust. Pulse ไม่ accept, reject, consume, dispatch หรือ gate งาน.</p>
    <ul>${topology.operational_edges.map((edge) =>
      `<li>Gate ${esc(edge.gate_id)}: ${esc(edge.from)} ไป ${esc(edge.to)}, ${esc(edge.artifact_type)}, สถานะ ${esc(edge.state)}, completed ${edge.completed ? 'true' : 'false'}, basis ${esc(edge.completion_basis ?? 'none')}.</li>`).join('')}</ul>
    <ol>${topology.phases.map((phase) =>
      `<li>${esc(phase.title)}: ${esc(phase.deliverable)}; exit ${esc(phase.exit_artifact)}; ${phase.agent_count} agents ที่ผูกเฟส; state ${esc(phase.state)}${phase.owner_role ? `; owner ${esc(phase.owner_role)}; work age ${esc(duration(phase.work_age_sec))}; wait age ${esc(duration(phase.wait_age_sec))}` : ''}${phase.bottleneck ? `; bottleneck ${esc(phase.bottleneck.kind)} age ${esc(duration(phase.bottleneck.age_sec))} owner ${esc(phase.bottleneck.owner_role)}` : ''}</li>`).join('')}</ol>
    <p>${topology.unassigned.agent_count} agents ยังไม่มี phase binding ที่ใช้ได้ หรือมีหลักฐาน phase ขัดแย้ง.</p>
    <ul>${topology.nodes.map((node) =>
      `<li>${esc(nodeAria(topology, node, initialFreshness).full)}</li>`).join('')}</ul>
  </section>`
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function graphData(topology) {
  const payload = {
    viewBox: topology.view_box,
    phases: topology.phases,
    endpoint: topology.endpoint,
    unassigned: topology.unassigned,
    assignment: topology.assignment,
    delivery_context: topology.delivery_context,
    operational_edges: topology.operational_edges,
    observed_edges: topology.observed_edges,
    nodes: topology.nodes.map((node) => {
      const phase = phaseForNode(topology, node)
      return {
        node_id: node.node_id,
        agent: node.agent,
        task_id: node.task_id,
        state: node.state,
        label: node.label,
        tone: node.tone,
        meaning: node.meaning,
        historical: node.historical,
        attention: node.attention,
        dispatch_id: node.dispatch_id,
        identity_source: node.identity_source,
        identity_note: identityNote(node),
        phase_id: node.placement_id,
        phase_source: node.phase_source,
        phase_title: phase.title,
        phase_thai: phase.thai,
        phase_outcome: phase.deliverable,
        exit_artifact: phase.exit_artifact,
        elapsed_label: node.historical
          ? 'ใช้เวลา'
          : node.state === 'died' || node.state === 'unrecorded' ? 'เงียบมา' : 'ผ่านไป',
        elapsed_value: duration(node.historical
          ? node.elapsed_sec
          : node.state === 'died' || node.state === 'unrecorded'
            ? node.silence_sec
            : node.elapsed_sec),
        signals: node.signals,
        next_action: node.next_action,
        verdict_conflict: Boolean(node.verdict_conflict),
        x: node.x,
        y: node.y,
        radius: node.radius,
        base_aria: nodeAria(topology, node, 'fresh').base,
      }
    }),
  }
  return scriptJson(payload)
}

export function renderTopologyGraph(snapshot, topology, {
  fontCssName,
  d3JsName = 'pulse-d3-test.min.js',
  timeZone = 'Asia/Bangkok',
  timeZoneLabel = 'เวลาไทย (UTC+7)',
  mainPageName = 'pulse.html',
} = {}) {
  const nodes = topology.nodes
  const activeNodes = nodes.filter((node) => !node.historical)
  const historyNodes = nodes.filter((node) => node.historical)
  const attention = nodes.filter((node) => node.attention).length
  const selectedNode = nodes.find((node) => node.attention) || nodes[0] || null
  const selectedNodeId = selectedNode?.node_id || ''
  const repoName = snapshot.scope?.repo_name || 'unknown'
  const refreshRaw = Number(snapshot.observation?.refresh_interval_sec)
  const refreshInterval = Number.isFinite(refreshRaw) && refreshRaw > 0 ? Math.ceil(refreshRaw) : 20
  const expiresAt = snapshot.observation?.expires_at || ''
  const expiresMs = Date.parse(expiresAt)
  const initialFreshness = !Number.isFinite(expiresMs)
    ? 'unknown'
    : Date.now() >= expiresMs ? 'stale' : 'fresh'
  const initialQualifier = freshnessCopy(initialFreshness)
  const initialFreshnessLabel = initialFreshness === 'stale' ? 'ข้อมูลหมดอายุ'
    : initialFreshness === 'unknown' ? 'ตรวจ freshness ไม่ได้' : 'ข้อมูลสด'
  const initialFreshnessNote = initialFreshness === 'stale'
    ? 'ตัวสังเกตการณ์ไม่อัปเดตตามรอบ'
    : initialFreshness === 'unknown' ? 'ตรวจเวลาหมดอายุไม่ได้' : 'snapshot ยังอยู่ในช่วงสังเกตการณ์'
  const quality = snapshot.complete ? 'complete' : 'degraded'
  const formatter = dateTimeFormatter(timeZone)
  const truncatedRaw = Number(snapshot.summary?.truncated)
  const truncated = Number.isSafeInteger(truncatedRaw) && truncatedRaw > 0 ? truncatedRaw : 0
  const degradedSources = Object.entries(snapshot.source_health || {})
    .filter(([, state]) => state !== 'ok')
    .map(([source, state]) => `${source}:${state}`)
  const viewBox = topology.view_box
  const pmBoundary = topology.pm_boundary || { x: 25, y: 55, width: 1635, height: 560 }
  const assigned = topology.assignment.explicit
  const unassigned = topology.assignment.unassigned

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>ACP Phase Flow — ${esc(repoName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="tmux-teams-snapshot-id" content="${esc(snapshot.snapshot_id)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231f6f5f'/%3E%3Cpath d='M11 32h42M39 18l14 14-14 14' fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='15' cy='32' r='6' fill='%23fff'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${esc(fontCssName)}">
<style>
:root{color-scheme:dark;--bg:oklch(15% .014 165);--surface:oklch(20% .015 165);--surface-2:oklch(24% .018 165);--line:oklch(35% .018 165);--ink:oklch(94% .012 165);--dim:oklch(70% .02 165);--ok:oklch(74% .13 165);--warn:oklch(79% .13 78);--bad:oklch(72% .17 28);--pending:oklch(73% .10 235);--unknown:oklch(68% .025 165);--focus:oklch(80% .13 235);--phase:oklch(72% .10 205);--sans:"Kanit","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:oklch(97% .008 165);--surface:oklch(99% .004 165);--surface-2:oklch(94% .012 165);--line:oklch(82% .02 165);--ink:oklch(23% .02 165);--dim:oklch(47% .025 165);--ok:oklch(47% .12 165);--warn:oklch(52% .13 72);--bad:oklch(52% .17 28);--pending:oklch(48% .12 235);--unknown:oklch(48% .025 165);--focus:oklch(48% .14 235);--phase:oklch(48% .12 205)}}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{width:100%;min-width:0;height:100%;margin:0}body{display:flex;flex-direction:column;overflow:hidden;background:var(--bg);color:var(--ink);font:400 1rem/1.5 var(--sans);text-rendering:optimizeLegibility}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:radial-gradient(circle at 1px 1px,color-mix(in oklch,var(--line) 52%,transparent) 1px,transparent 0);background-size:22px 22px;opacity:.22}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.skip-link{position:fixed;z-index:60;top:8px;left:8px;transform:translateY(-150%);padding:8px 12px;border-radius:8px;background:var(--ink);color:var(--bg)}.skip-link:focus{transform:none}
.hud{position:relative;z-index:20;display:flex;flex:none;align-items:flex-start;justify-content:space-between;gap:22px;padding:12px 18px 10px;border-bottom:1px solid var(--line);background:color-mix(in oklch,var(--bg) 94%,transparent);backdrop-filter:blur(10px)}.hud-main{display:flex;min-width:0;align-items:center;gap:16px}.brand{min-width:0}.eyebrow{display:block;color:var(--dim);font-size:.68rem;font-weight:500;letter-spacing:.1em}.brand h1{display:flex;min-width:0;align-items:baseline;gap:9px;margin:0;font-size:1.28rem;line-height:1.2}.brand h1 span{min-width:0;color:var(--dim);font:500 .78rem var(--mono);overflow-wrap:anywhere}.brand p{margin:3px 0 0;color:var(--dim);font-size:.74rem}.summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.summary-chip,.freshness{display:inline-flex;align-items:center;gap:6px;min-height:29px;padding:4px 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:.7rem;white-space:nowrap}.summary-chip strong{font-variant-numeric:tabular-nums}.summary-chip.warn{border-color:color-mix(in oklch,var(--warn) 55%,var(--line));color:var(--warn)}.freshness::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.freshness.fresh{color:var(--ok)}.freshness.stale{color:var(--warn)}.freshness.unknown{color:var(--unknown)}
.hud-time{flex:none;text-align:right;color:var(--dim);font-size:.7rem}.hud-time span,.hud-time time{display:block}.hud-time time{color:var(--ink);font-family:var(--mono);font-variant-numeric:tabular-nums}.time-zone-label{color:var(--ink);font-weight:500}.back-link{color:var(--dim);text-decoration:none;border-bottom:1px solid var(--line)}.back-link:hover{color:var(--ink)}.refresh-control{margin:4px 0 2px;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--dim);font:500 .65rem var(--sans);cursor:pointer}.refresh-control:hover,.refresh-control:focus-visible{border-color:var(--focus);color:var(--ink);outline:none}.refresh-control[aria-pressed="true"]{border-color:var(--warn);color:var(--warn)}.refresh-state{font-size:.62rem}
.notice{position:relative;z-index:19;display:flex;flex:none;gap:14px;align-items:center;padding:6px 18px;border-bottom:1px solid color-mix(in oklch,var(--warn) 42%,var(--line));background:color-mix(in oklch,var(--warn) 9%,var(--bg));color:var(--warn);font-size:.73rem}.notice code{font-family:var(--mono)}
.graph-viewport{position:relative;z-index:1;flex:1;min-width:0;min-height:0;overflow:hidden;outline:none;background:radial-gradient(circle at 50% 42%,color-mix(in oklch,var(--surface-2) 42%,transparent),transparent 62%)}.graph-viewport:focus-visible{box-shadow:inset 0 0 0 3px var(--focus)}#topology-canvas{display:block;width:100%;height:100%;min-height:0;cursor:grab;touch-action:none;user-select:none}#topology-canvas.is-panning{cursor:grabbing}
.pm-boundary{fill:color-mix(in oklch,var(--surface) 30%,transparent);stroke:var(--line);stroke-width:2;stroke-dasharray:10 9;vector-effect:non-scaling-stroke}.pm-title{fill:var(--ink);font:600 17px var(--sans)}.pm-copy{fill:var(--dim);font:11px var(--sans)}.pm-node{fill:color-mix(in oklch,var(--warn) 10%,var(--surface));stroke:var(--warn);stroke-width:1.5;vector-effect:non-scaling-stroke}.pm-node-title{fill:var(--warn);font:600 12px var(--sans)}.pm-node-copy{fill:var(--dim);font:10px var(--sans)}
.phase-boundary{fill:color-mix(in oklch,var(--surface) 88%,transparent);stroke:var(--phase);stroke-width:1.5;stroke-dasharray:7 5;vector-effect:non-scaling-stroke}.phase-attention .phase-boundary{stroke:var(--warn);stroke-width:2.5}.phase-step{fill:var(--surface-2);stroke:var(--phase);stroke-width:1.5;vector-effect:non-scaling-stroke}.phase-step-copy{fill:var(--phase);font:600 10px var(--mono)}.phase-title{fill:var(--ink);font:600 17px var(--sans)}.phase-thai{fill:var(--dim);font:11px var(--sans)}.phase-state{fill:var(--dim);font:8.5px var(--sans)}.phase-bottleneck{fill:var(--warn);font:600 7.5px var(--mono)}.phase-outcome-label{fill:var(--phase);font:600 8px var(--mono);letter-spacing:.08em}.phase-outcome{fill:var(--ink);font:500 10px var(--sans)}.agent-count{fill:var(--dim);font:9px var(--sans)}
.flow-action{fill:var(--surface-2);stroke:var(--line);stroke-width:1.2;vector-effect:non-scaling-stroke}.flow-action-copy{fill:var(--ink);font:9px var(--sans)}.inner-edge{fill:none;stroke:var(--dim);stroke-width:1.2;stroke-dasharray:4 4;opacity:.7;vector-effect:non-scaling-stroke}.pass-edge{stroke:var(--ok)}.rework-edge{stroke:var(--warn)}.review-decision{fill:var(--surface-2);stroke:var(--warn);stroke-width:1.4;vector-effect:non-scaling-stroke}.review-title{fill:var(--ink);font:600 9px var(--sans)}.review-copy,.rework-copy{fill:var(--dim);font:7.5px var(--sans)}.artifact-node path{fill:color-mix(in oklch,var(--ok) 8%,var(--surface));stroke:var(--ok);stroke-width:1.4;vector-effect:non-scaling-stroke}.artifact-label{fill:var(--dim);font:7px var(--mono)}.artifact-name{fill:var(--ok);font:600 9px var(--mono)}
.model-phase-edge{fill:none;stroke:var(--phase);stroke-width:2;stroke-dasharray:10 8;opacity:.8;vector-effect:non-scaling-stroke}.handoff-label{fill:var(--phase);font:600 8.5px var(--mono)}.observed-edge{stroke:color-mix(in oklch,var(--ink) 30%,transparent);stroke-width:1.1;opacity:.45;vector-effect:non-scaling-stroke}.observed-edge.unassigned{stroke:var(--warn);opacity:.24}.operational-edge{fill:none;stroke-width:3;opacity:.95;vector-effect:non-scaling-stroke}.operational-edge.state-proposed{stroke:var(--pending);stroke-dasharray:3 5}.operational-edge.state-accepted{stroke:var(--phase);stroke-dasharray:8 4}.operational-edge.state-rejected{stroke:var(--bad);stroke-dasharray:4 3}.operational-edge.state-escalated{stroke:var(--warn);stroke-dasharray:2 3}.operational-edge.state-consumed{stroke:var(--unknown);stroke-width:3.5}.operational-edge.state-consumed.completed{stroke:var(--ok);stroke-width:4.5}.operational-edge-label{fill:var(--dim);font:600 7.5px var(--mono)}.operational-edge-label.completed{fill:var(--ok)}.edge-layer{pointer-events:none}
.project-endpoint{fill:color-mix(in oklch,var(--ok) 10%,var(--surface));stroke:var(--ok);stroke-width:2;vector-effect:non-scaling-stroke}.endpoint-title{fill:var(--ink);font:600 17px var(--sans)}.endpoint-copy{fill:var(--dim);font:10px var(--sans)}.endpoint-warning{fill:var(--warn);font:9px var(--sans)}.unassigned-boundary{fill:color-mix(in oklch,var(--warn) 5%,var(--surface));stroke:var(--warn);stroke-width:1.5;stroke-dasharray:8 6;vector-effect:non-scaling-stroke}.unassigned-title{fill:var(--warn);font:600 16px var(--sans)}.unassigned-copy{fill:var(--dim);font:10px var(--sans)}.unassigned-count{fill:var(--warn);font:600 28px var(--mono)}
.agent-node{--tone:var(--unknown);cursor:pointer;outline:none}.agent-node.tone-ok{--tone:var(--ok)}.agent-node.tone-warn{--tone:var(--warn)}.agent-node.tone-bad{--tone:var(--bad)}.agent-node.tone-pending{--tone:var(--pending)}.agent-node.tone-unknown{--tone:var(--unknown)}.node-core{fill:var(--tone);stroke:color-mix(in oklch,var(--tone) 36%,var(--ink));stroke-width:1.5;vector-effect:non-scaling-stroke}.is-historical .node-core{fill:var(--bg);stroke:var(--tone);stroke-width:2.5}.node-history-ring{fill:none;stroke:var(--tone);stroke-width:1;opacity:.65;vector-effect:non-scaling-stroke}.weak-identity .node-core{stroke-dasharray:4 3}.node-focus-ring{fill:none;stroke:transparent;stroke-width:3;vector-effect:non-scaling-stroke}.node-attention-ring{fill:none;stroke:transparent;stroke-width:2.5;vector-effect:non-scaling-stroke}.needs-attention .node-attention-ring{stroke:var(--bad);stroke-dasharray:4 4}.agent-node:hover .node-focus-ring,.agent-node:focus .node-focus-ring,.agent-node[aria-pressed="true"] .node-focus-ring{stroke:var(--focus)}.node-agent-label{fill:var(--bg);font:600 7px var(--sans);opacity:0;pointer-events:none}.is-historical .node-agent-label{fill:var(--ink)}#topology-canvas.detail-zoom .node-agent-label{opacity:1}
.graph-tools{position:absolute;z-index:12;top:10px;left:10px;display:flex;gap:6px;padding:5px;border:1px solid var(--line);border-radius:12px;background:color-mix(in oklch,var(--surface) 92%,transparent);box-shadow:0 8px 30px color-mix(in oklch,var(--bg) 54%,transparent);backdrop-filter:blur(10px)}.graph-tools button{display:grid;place-items:center;min-width:44px;height:44px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ink);font:600 .75rem var(--sans);cursor:pointer}.graph-tools button:hover,.graph-tools button:focus-visible{border-color:var(--focus);background:var(--surface-2);outline:none}.graph-tools .tool-symbol{font:600 1.15rem var(--mono)}.model-label{position:absolute;z-index:8;left:50%;top:10px;transform:translateX(-50%);max-width:min(720px,calc(100% - 300px));padding:5px 10px;border:1px dashed var(--line);border-radius:999px;background:color-mix(in oklch,var(--bg) 88%,transparent);color:var(--dim);font-size:.65rem;text-align:center;pointer-events:none}.model-label strong{color:var(--ink)}.d3-warning{position:absolute;z-index:13;left:50%;top:52px;transform:translateX(-50%);padding:7px 11px;border:1px solid var(--bad);border-radius:9px;background:var(--surface);color:var(--bad);font-size:.7rem}
.graph-inspector{position:absolute;z-index:14;right:14px;bottom:14px;width:min(370px,calc(100% - 28px));max-height:calc(100% - 28px);overflow:auto;padding:14px;border:1px solid var(--line);border-top:3px solid var(--focus);border-radius:14px;background:color-mix(in oklch,var(--surface) 96%,transparent);box-shadow:0 18px 54px color-mix(in oklch,var(--bg) 72%,transparent);backdrop-filter:blur(14px)}.inspector-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.inspector-kicker{display:block;color:var(--dim);font-size:.58rem;font-weight:500;letter-spacing:.08em}.inspector-head h2{margin:1px 0 0;font-size:1.08rem;line-height:1.2;overflow-wrap:anywhere}.inspector-head button{display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px 0 0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dim);font:400 1.4rem var(--sans);cursor:pointer}.inspector-head button:hover,.inspector-head button:focus-visible{border-color:var(--focus);color:var(--ink);outline:none}.outcome-risk{margin:10px 0 0;padding:9px;border-left:3px solid var(--phase);background:color-mix(in oklch,var(--phase) 8%,var(--surface-2))}.outcome-risk span{display:block;color:var(--phase);font:.57rem var(--mono);letter-spacing:.08em}.outcome-risk strong{display:block;margin-top:2px;font-size:.85rem}.outcome-risk p{margin:3px 0;color:var(--dim);font-size:.67rem}.outcome-risk code{color:var(--ok);font:.63rem var(--mono)}.inspector-task{display:block;margin:9px 0 7px;color:var(--ink);font:.68rem/1.35 var(--mono);overflow-wrap:anywhere}.inspector-state{display:inline-flex;padding:3px 8px;border-radius:999px;background:color-mix(in oklch,var(--tone) 14%,var(--surface-2));color:var(--tone);font-size:.64rem;font-weight:500}.inspector-state.tone-ok{--tone:var(--ok)}.inspector-state.tone-warn{--tone:var(--warn)}.inspector-state.tone-bad{--tone:var(--bad)}.inspector-state.tone-pending{--tone:var(--pending)}.inspector-state.tone-unknown{--tone:var(--unknown)}.freshness-qualifier{margin:8px 0 0;padding:6px 7px;border-left:3px solid var(--warn);background:color-mix(in oklch,var(--warn) 9%,var(--surface));color:var(--warn);font-size:.62rem;line-height:1.4}.inspector-signals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin:10px 0 0;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--line)}.signal{min-width:0;padding:6px 7px;background:var(--surface-2)}.signal dt{color:var(--dim);font-size:.56rem}.signal dd{margin:0;font-size:.67rem;font-weight:500;overflow-wrap:anywhere}.signal.ok dd{color:var(--ok)}.signal.warn dd{color:var(--warn)}.signal.bad dd{color:var(--bad)}.inspector-meaning{margin:9px 0 0;color:var(--dim);font-size:.68rem;line-height:1.45}.inspector-meta{display:grid;gap:5px;margin:9px 0 0;padding-top:8px;border-top:1px solid var(--line);font-size:.63rem}.inspector-meta div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px}.inspector-meta dt{color:var(--dim)}.inspector-meta dd{margin:0;color:var(--ink)}.inspector-meta.priority{border-top:0;padding:8px;background:var(--surface-2)}.identity-note{margin:8px 0 0;color:var(--warn);font-size:.61rem}
.legend{position:relative;z-index:20;display:flex;flex:none;align-items:center;gap:15px;min-height:42px;padding:8px 18px;border-top:1px solid var(--line);background:var(--bg);color:var(--dim);font-size:.66rem;overflow-x:auto}.legend strong{color:var(--ink);white-space:nowrap}.legend-item{display:flex;align-items:center;gap:6px;white-space:nowrap}.legend-dot{width:9px;height:9px;border-radius:50%;background:var(--legend-tone)}.legend-solid{width:28px;border-top:1.5px solid var(--dim)}.legend-dashed{width:28px;border-top:1.5px dashed var(--phase)}.legend-operational{width:28px;border-top:3px solid var(--legend-tone)}.legend-operational.proposed{border-top-style:dotted}.legend-operational.accepted{border-top-style:dashed}.legend .truth{margin-left:auto;white-space:nowrap}.legend .truth b{color:var(--ink)}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
@media(max-width:820px){.hud{display:grid;gap:8px;padding:9px 13px}.hud-main{align-items:flex-start;justify-content:space-between}.summary{gap:5px}.hud-time{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 9px;text-align:left}.hud-time span,.hud-time time{display:inline}.hud-time>.time-zone-label,.hud-time>span:nth-of-type(2){grid-column:1/-1}.refresh-control{justify-self:start}.notice{padding:6px 13px}.model-label{left:auto;right:10px;transform:none;max-width:calc(100% - 205px)}.legend{padding:8px 13px}.legend .truth{margin-left:0}}
@media(max-width:560px){.brand h1{font-size:1.1rem}.brand p{font-size:.67rem}.summary-chip.history{display:none}.summary-chip{min-height:27px;padding:3px 7px}.model-label{display:none}.graph-viewport{overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}#topology-canvas{width:1400px;height:831px;min-height:831px;max-width:none;touch-action:pan-x pan-y}.graph-tools{position:sticky;top:7px;left:7px;width:max-content;margin-bottom:-60px}.graph-tools button{min-width:44px;padding:0 7px}.graph-inspector{position:sticky;right:0;bottom:0;width:100%;max-width:none;max-height:min(58%,450px);margin-left:auto;border-right:0;border-bottom:0;border-left:0;border-radius:16px 16px 0 0}.legend .truth{display:none}}
@media(max-height:600px){.hud{padding:5px 11px;gap:7px}.brand p,.summary-chip.history,#loop-freshness-note,#loop-refresh-state,.hud-time>span:nth-of-type(2){display:none}.brand h1{font-size:1.02rem}.summary-chip{min-height:24px;padding:2px 7px}.hud-time{font-size:.63rem}.refresh-control{margin:1px 0}.model-label{display:none}.legend{min-height:34px;padding:4px 11px}.graph-inspector{max-height:78%}}
@media(forced-colors:active){.summary-chip,.freshness,.graph-tools,.graph-inspector,.inspector-signals{border-color:CanvasText}.node-core,.phase-boundary,.pm-boundary,.unassigned-boundary,.project-endpoint,.model-phase-edge,.observed-edge,.operational-edge{stroke:CanvasText}.node-core{fill:Canvas}.agent-node:focus .node-focus-ring,.agent-node[aria-pressed="true"] .node-focus-ring{stroke:Highlight}.legend-dot,.freshness::before{forced-color-adjust:none;background:Highlight}.graph-viewport:focus-visible{outline:3px solid Highlight;box-shadow:none}}
</style></head>
<body data-observation-freshness="${initialFreshness}" data-snapshot-quality="${esc(quality)}">
<a id="loop-skip-link" class="skip-link" href="#loop-graph">ข้ามไปยัง Phase Flow Graph</a>
<header class="hud" data-observation-expires-at="${esc(expiresAt)}" data-refresh-interval="${refreshInterval}">
  <div class="hud-main">
    <div class="brand"><span class="eyebrow">TMUX TEAMS · TWO-LEVEL DELIVERY FLOW</span>
      <h1>ACP Phase Flow <span>${esc(repoName)}</span></h1>
      <p>PM คุม outer loop · 4 phase teams คุม inner loop · 1 node = 1 ACP dispatch</p>
    </div>
    <div class="summary" aria-label="สรุป phase binding และ ACP nodes">
      <span class="summary-chip"><strong>${assigned}</strong> ผูกเฟสแล้ว</span>
      <span class="summary-chip${unassigned ? ' warn' : ''}"><strong>${unassigned}</strong> ยังไม่ผูกเฟส</span>
      <span class="summary-chip history"><strong>${historyNodes.length}</strong> บันทึกแล้ว</span>
      <span class="summary-chip"><strong>${attention}</strong> ต้องตรวจ</span>
      <span id="loop-freshness-status" class="freshness ${initialFreshness}" role="status" aria-live="polite">${initialFreshnessLabel}</span>
    </div>
  </div>
  <div class="hud-time">
    <span id="loop-timezone-label" class="time-zone-label">${esc(timeZoneLabel)}</span>
    <span>สังเกต ณ ${semanticTime(snapshot.generated_at, timeZone, formatter)}</span>
    <span id="loop-freshness-note">${initialFreshnessNote}</span>
    <button id="loop-auto-refresh" class="refresh-control" type="button"
      aria-pressed="false" aria-describedby="loop-refresh-state">พักการรีเฟรชอัตโนมัติ</button>
    <span id="loop-refresh-state" class="refresh-state" role="status" aria-live="polite">รีเฟรชอัตโนมัติเปิดอยู่ · ทุก ${refreshInterval} วิ</span>
    <a id="loop-back-link" class="back-link" href="${esc(mainPageName)}">กลับไป Pulse</a>
  </div>
</header>
${truncated || degradedSources.length || unassigned ? `<aside class="notice" role="status">
  <strong>ขอบเขตหลักฐาน</strong>
  <span>${unassigned ? `ACP ${unassigned} nodes ไม่มี phase binding ที่ใช้ได้หรือมีหลักฐานขัดแย้ง จึงไม่ถูกเดาเข้า Requirement/Prototype/Development/QA. ` : ''}
  ${truncated ? `snapshot ตัด active run ${truncated} รายการ. ` : ''}
  ${degradedSources.length ? `แหล่งข้อมูลผิดปกติ: <code>${esc(degradedSources.join(' · '))}</code>` : ''}</span>
</aside>` : ''}
<main id="loop-graph" class="graph-viewport" tabindex="-1"
  data-base-aria-label="D3 phase flowchart แบบเลื่อนและซูมได้"
  aria-label="${initialQualifier ? `${esc(initialQualifier)}. ` : ''}D3 phase flowchart แบบเลื่อนและซูมได้"
  data-agent-node-count="${nodes.length}">
  <div class="graph-tools" role="group" aria-label="เครื่องมือมุมมองกราฟ">
    <button id="graph-zoom-in" type="button" title="ขยายกราฟ"><span class="tool-symbol" aria-hidden="true">+</span><span class="sr-only">ขยายกราฟ</span></button>
    <button id="graph-zoom-out" type="button" title="ย่อกราฟ"><span class="tool-symbol" aria-hidden="true">−</span><span class="sr-only">ย่อกราฟ</span></button>
    <button id="graph-fit" type="button">พอดีจอ</button>
  </div>
  <p class="model-label"><strong>เส้นประบาง</strong> = model · <strong>เส้นทึบบาง</strong> = phase placement · <strong>เส้นสีหนา</strong> = advisory operational handoff</p>
  <p id="d3-warning" class="d3-warning" role="alert" hidden>โหลด D3 7.9.0 ไม่สำเร็จ · แสดง fallback flowchart แบบคงที่</p>
  <svg id="topology-canvas" viewBox="${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}"
    role="group" aria-labelledby="topology-title topology-desc" preserveAspectRatio="xMidYMid meet">
    <title id="topology-title">Requirement ถึง QA phase flowchart พร้อม ACP agent nodes</title>
    <desc id="topology-desc">สี่ phase teams เรียง Requirement, Prototype, Development และ QA ภายใน PM outer loop; Project Delivery เป็นปลายทางไม่ใช่ทีมที่ห้า. แต่ละ phase มีแผนงาน, ACP agents, การตรวจของทีม และ exit artifact. Agent ที่ไม่มี phase binding อยู่ในกลุ่ม unassigned.</desc>
    <defs>
      <marker id="model-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>
      <marker id="operational-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>
    </defs>
    <g id="graph-camera">
      <g class="outer-model" aria-hidden="true">
        <rect class="pm-boundary" x="${pmBoundary.x}" y="${pmBoundary.y}" width="${pmBoundary.width}" height="${pmBoundary.height}" rx="26"/>
        <text class="pm-title" x="58" y="87">PM OUTER LOOP</text>
        <text class="pm-copy" x="58" y="107">ติด phase · handoff · bottleneck · exception — ไม่รับตรวจ worker แทนทีมเฟส</text>
        <rect class="pm-node" x="1385" y="75" width="240" height="58" rx="29"/>
        <text class="pm-node-title" x="1505" y="99" text-anchor="middle">PM exception boundary</text>
        <text class="pm-node-copy" x="1505" y="117" text-anchor="middle">deadlock · policy conflict · bottleneck</text>
      </g>
      <g class="edge-layer phase-edge-layer" aria-hidden="true">
        ${topology.model_edges.map((edge) =>
          `<path class="model-phase-edge" data-edge-kind="model-phase-handoff" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" d="${esc(edge.path)}" marker-end="url(#model-arrow)"/>
          <text class="handoff-label" x="${(edge.x1 + edge.x2) / 2}" y="${Math.min(edge.y1, edge.y2) - 8}" text-anchor="middle">${esc(edge.artifact)}</text>`).join('')}
      </g>
      <g class="edge-layer operational-edge-layer" aria-hidden="true">
        ${topology.operational_edges.map((edge) =>
          `<path class="operational-edge state-${esc(edge.state)}${edge.completed ? ' completed' : ''}" data-edge-family="operational" data-edge-kind="${esc(edge.kind)}" data-gate-id="${esc(edge.gate_id)}" data-boundary="${esc(edge.boundary)}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" data-artifact-type="${esc(edge.artifact_type)}" data-completed="${edge.completed}" data-completion-basis="${esc(edge.completion_basis ?? '')}" d="${esc(edge.path)}" marker-end="url(#operational-arrow)"/>
          <text class="operational-edge-label${edge.completed ? ' completed' : ''}" x="${(edge.x1 + edge.x2) / 2}" y="${(edge.y1 + edge.y2) / 2 - 5}" text-anchor="middle">${esc(edge.state)}${edge.completed ? ' · completed' : ''}</text>`).join('')}
      </g>
      <g class="edge-layer observed-edge-layer" aria-hidden="true">
        ${topology.observed_edges.map((edge) =>
          `<line class="observed-edge${edge.kind === 'observed-unassigned-placement' ? ' unassigned' : ''}" data-edge-kind="${esc(edge.kind)}" data-agent-id="${esc(edge.agent_id)}" data-placement-id="${esc(edge.placement_id)}" x1="${edge.x1}" y1="${edge.y1}" x2="${edge.x2}" y2="${edge.y2}"/>`).join('')}
      </g>
      <g class="phase-layer">
        ${topology.phases.map(phaseCardSvg).join('')}
      </g>
      <g class="endpoint-layer" aria-hidden="true">
        <g transform="translate(${topology.endpoint.x} ${topology.endpoint.y})">
          <rect class="project-endpoint" width="${topology.endpoint.width}" height="${topology.endpoint.height}" rx="28"/>
          <text class="endpoint-title" x="115" y="48" text-anchor="middle">Project Delivery</text>
          <text class="endpoint-copy" x="115" y="73" text-anchor="middle">ผู้รับปลายทางจาก QA</text>
          <text class="endpoint-copy" x="115" y="98" text-anchor="middle">รับ qa_release_evidence</text>
          <text class="endpoint-warning" x="115" y="127" text-anchor="middle">ไม่ใช่ phase team ที่ห้า</text>
          <text class="endpoint-warning" x="115" y="149" text-anchor="middle">accept ≠ business approval</text>
        </g>
      </g>
      <g class="unassigned-layer">
        <rect class="unassigned-boundary" x="${topology.unassigned.x}" y="${topology.unassigned.y}" width="${topology.unassigned.width}" height="${topology.unassigned.height}" rx="22"/>
        <text class="unassigned-title" x="${topology.unassigned.x + 28}" y="${topology.unassigned.y + 40}">ยังไม่ผูกเฟส · Unassigned ACP evidence</text>
        <text class="unassigned-copy" x="${topology.unassigned.x + 28}" y="${topology.unassigned.y + 64}">ไม่มี phase attr ที่ใช้ได้หรือหลักฐานขัดแย้ง จึงห้ามอนุมานจาก task name, worker หรือ model</text>
        <text class="unassigned-count" x="${topology.unassigned.x + 110}" y="${topology.unassigned.y + 137}" text-anchor="middle">${topology.unassigned.agent_count}</text>
        <text class="unassigned-copy" x="${topology.unassigned.x + 110}" y="${topology.unassigned.y + 160}" text-anchor="middle">ACP agents</text>
      </g>
      <g class="agent-layer">
        ${nodes.map((node) => agentNodeSvg(topology, node, { selectedNodeId, initialFreshness })).join('')}
      </g>
    </g>
  </svg>
  ${inspectorHtml(topology, selectedNode, initialFreshness)}
  ${semanticSummary(topology, initialFreshness)}
</main>
<footer class="legend" aria-label="คำอธิบาย phase flow graph">
  <strong>Flow truth</strong>
  <span class="legend-item"><i class="legend-dashed" aria-hidden="true"></i>phase/inner-loop model</span>
  <span class="legend-item"><i class="legend-solid" aria-hidden="true"></i>observed placement</span>
  <span class="legend-item"><i class="legend-operational proposed" style="--legend-tone:var(--pending)" aria-hidden="true"></i>gate proposed</span>
  <span class="legend-item"><i class="legend-operational accepted" style="--legend-tone:var(--phase)" aria-hidden="true"></i>accepted</span>
  <span class="legend-item"><i class="legend-operational" style="--legend-tone:var(--bad)" aria-hidden="true"></i>rejected</span>
  <span class="legend-item"><i class="legend-operational" style="--legend-tone:var(--warn)" aria-hidden="true"></i>escalated</span>
  <span class="legend-item"><i class="legend-operational" style="--legend-tone:var(--ok)" aria-hidden="true"></i>consumed</span>
  <span class="legend-item"><i class="legend-dot" style="--legend-tone:var(--ok)" aria-hidden="true"></i>runtime state ของ agent</span>
  <span class="truth"><b>TEAM_DONE ≠ ทีมตรวจรับแล้ว</b> · phase acceptance ≠ business approval · same-UID observations are advisory · Pulse never accepts/rejects/consumes/dispatches/gates</span>
</footer>
<script type="application/json" id="loop-graph-data">${graphData(topology)}</script>
<script src="${esc(d3JsName)}"></script>
<script>
(() => {
  const header = document.querySelector('[data-observation-expires-at]')
  const status = document.querySelector('#loop-freshness-status')
  const note = document.querySelector('#loop-freshness-note')
  const graph = document.querySelector('#loop-graph')
  const svg = document.querySelector('#topology-canvas')
  const refreshControl = document.querySelector('#loop-auto-refresh')
  const refreshState = document.querySelector('#loop-refresh-state')
  const inspector = document.querySelector('#graph-inspector')
  const closeInspector = document.querySelector('#graph-inspector-close')
  const d3Warning = document.querySelector('#d3-warning')
  const graphPayload = JSON.parse(document.querySelector('#loop-graph-data').textContent)
  const nodeById = new Map(graphPayload.nodes.map((node) => [node.node_id, node]))
  const staleCopy = ${scriptJson(STALE_NODE_COPY)}
  const unknownCopy = ${scriptJson(UNKNOWN_NODE_COPY)}
  const pauseKey = ${scriptJson(`tmux-teams-phase-graph-paused-v1:${snapshot.stream_id || 'unknown'}`)}
  const restoreKey = 'tmuxTeamsPhaseGraphRestoreV1'
  const initialSelectedId = ${scriptJson(selectedNodeId)}
  let selectedId = initialSelectedId
  let autoRefreshPaused = false
  let freshnessTimer = 0
  let reloadTimer = 0
  let currentTransform = { x: 0, y: 0, k: 1 }
  const d3Ready = globalThis.d3?.version === '7.9.0'
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  const snapshotFreshness = document.body.dataset.observationFreshness || 'unknown'
  const snapshotQualifier = snapshotFreshness === 'stale'
    ? staleCopy
    : snapshotFreshness === 'unknown' ? unknownCopy : ''
  const nodeAriaLabel = (node) =>
    snapshotQualifier ? snapshotQualifier + '. ' + node.base_aria : node.base_aria
  if (!d3Ready && d3Warning) d3Warning.hidden = false

  let agentElements = Array.from(document.querySelectorAll('[data-agent-node]'))
  let zoomBehavior = null
  let svgSelection = null
  if (d3Ready && svg) {
    svgSelection = d3.select(svg)
    const edgeLayer = d3.select('.observed-edge-layer')
    edgeLayer.selectAll('line.observed-edge')
      .data(graphPayload.observed_edges, function(edge) {
        return edge?.agent_id || this.dataset.agentId
      })
      .join('line')
      .attr('class', (edge) => 'observed-edge' +
        (edge.kind === 'observed-unassigned-placement' ? ' unassigned' : ''))
      .attr('data-edge-kind', (edge) => edge.kind)
      .attr('data-agent-id', (edge) => edge.agent_id)
      .attr('data-placement-id', (edge) => edge.placement_id)
      .attr('x1', (edge) => edge.x1)
      .attr('y1', (edge) => edge.y1)
      .attr('x2', (edge) => edge.x2)
      .attr('y2', (edge) => edge.y2)

    const joined = d3.select('.agent-layer').selectAll('g.agent-node')
      .data(graphPayload.nodes, function(node) {
        return node?.node_id || this.dataset.nodeId
      })
      .join(
        (enter) => {
          const group = enter.append('g').attr('class', 'agent-node')
          group.append('title')
          group.append('circle').attr('class', 'node-attention-ring')
          group.append('circle').attr('class', 'node-focus-ring')
          group.append('circle').attr('class', 'node-core')
          group.append('text').attr('class', 'node-agent-label')
            .attr('text-anchor', 'middle').attr('y', 4).attr('aria-hidden', 'true')
          return group
        },
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('class', (node) => [
        'agent-node',
        'tone-' + node.tone,
        node.historical ? 'is-historical' : 'is-live',
        node.attention ? 'needs-attention' : '',
        node.identity_source !== 'dispatch_id' ? 'weak-identity' : '',
      ].filter(Boolean).join(' '))
      .attr('transform', (node) => 'translate(' + node.x + ' ' + node.y + ')')
      .attr('data-agent-node', 'true')
      .attr('data-node-id', (node) => node.node_id)
      .attr('data-phase-id', (node) => node.phase_id)
      .attr('data-phase-source', (node) => node.phase_source)
      .attr('data-state', (node) => node.state)
      .attr('data-dispatch-id', (node) => node.dispatch_id || '')
      .attr('data-task-id', (node) => node.task_id)
      .attr('data-node-freshness', snapshotFreshness)
      .attr('data-evidence', (node) => node.historical ? 'recorded-event' : 'live-projection')
      .attr('data-base-aria-label', (node) => node.base_aria)
      .attr('role', 'button')
      .attr('aria-controls', 'graph-inspector')
      .attr('aria-expanded', 'false')
      .attr('aria-label', nodeAriaLabel)
      .attr('aria-pressed', (node) => node.node_id === initialSelectedId ? 'true' : 'false')
      .attr('tabindex', (node) => node.node_id === initialSelectedId ? '0' : '-1')
    joined.each(function(node) {
      const group = d3.select(this)
      group.select('title').text(nodeAriaLabel(node))
      group.select('.node-core').attr('r', node.radius)
      group.select('.node-focus-ring').attr('r', node.radius + 5)
      group.select('.node-attention-ring').attr('r', node.radius + 8)
      group.selectAll('circle.node-history-ring')
        .data(node.historical ? [node] : [])
        .join(
          (enter) => enter.insert('circle', 'text.node-agent-label')
            .attr('class', 'node-history-ring')
            .attr('aria-hidden', 'true'),
          (update) => update,
          (exit) => exit.remove(),
        )
        .attr('r', Math.max(4, node.radius - 5))
      group.select('.node-agent-label').text(node.agent.length > 9
        ? node.agent.slice(0, 4) + '…' + node.agent.slice(-4)
        : node.agent)
    })
    agentElements = Array.from(document.querySelectorAll('[data-agent-node]'))
    zoomBehavior = d3.zoom()
      .scaleExtent([.55, 4.2])
      .duration(reduceMotion ? 0 : 250)
      .filter((event) => !event.target?.closest?.('[data-agent-node]') &&
        (!event.ctrlKey || event.type === 'wheel'))
      .on('start', () => svg.classList.add('is-panning'))
      .on('zoom', (event) => {
        currentTransform = { x: event.transform.x, y: event.transform.y, k: event.transform.k }
        d3.select('#graph-camera').attr('transform', event.transform)
        svg.classList.toggle('detail-zoom', event.transform.k >= 1.5)
      })
      .on('end', () => svg.classList.remove('is-panning'))
    svgSelection.call(zoomBehavior)
  }

  const readPaused = () => {
    try { return sessionStorage.getItem(pauseKey) === '1' }
    catch { return false }
  }
  const writePaused = () => {
    try { sessionStorage.setItem(pauseKey, autoRefreshPaused ? '1' : '0') }
    catch { /* storage may be unavailable for local files */ }
  }
  const currentFreshnessQualifier = () => {
    const freshness = document.body.dataset.observationFreshness
    return freshness === 'stale' ? staleCopy : freshness === 'unknown' ? unknownCopy : ''
  }
  const storeReloadRestore = () => {
    const active = document.activeElement
    try {
      const next = history.state && typeof history.state === 'object' ? { ...history.state } : {}
      next[restoreKey] = {
        transform: currentTransform,
        selectedId,
        focusNodeId: active?.matches?.('[data-agent-node]') ? active.dataset.nodeId : '',
        focusId: active?.id || '',
        inspectorOpen: Boolean(inspector && !inspector.hidden),
        savedAt: Date.now(),
      }
      history.replaceState(next, '')
    } catch { /* history state may be unavailable for local files */ }
  }
  const consumeReloadRestore = () => {
    try {
      const state = history.state
      const saved = state && typeof state === 'object' ? state[restoreKey] : null
      if (!saved) return null
      const next = { ...state }
      delete next[restoreKey]
      history.replaceState(next, '')
      return Number.isFinite(saved.savedAt) && Date.now() - saved.savedAt < 300000 ? saved : null
    } catch { return null }
  }
  const setText = (selector, value) => {
    const element = document.querySelector(selector)
    if (element) element.textContent = value
  }
  const toneForSignal = (kind, value, node) => {
    if (kind === 'process' && value === 'พบ process') return 'ok'
    if (kind === 'terminal' && value !== 'ยังไม่มี' && value !== 'TEAM_DONE') return 'warn'
    if (kind === 'verdict') {
      if (node.verdict_conflict || value === 'ให้แก้ไข') return 'bad'
      if (value === 'ผ่าน') return 'ok'
      if (value === 'ยังไม่สรุป') return 'warn'
    }
    return ''
  }
  const updateInspector = (node) => {
    if (!node || !inspector) return
    setText('#inspector-evidence', node.historical ? 'ACP RUN ที่บันทึกแล้ว' : 'ACP RUN ที่กำลังติดตาม')
    setText('#inspector-agent', node.agent)
    setText('#inspector-phase', node.phase_title + (node.phase_thai ? ' · ' + node.phase_thai : ''))
    setText('#inspector-outcome', node.phase_outcome)
    setText('#inspector-artifact', node.exit_artifact)
    setText('#inspector-task', node.task_id)
    const task = document.querySelector('#inspector-task')
    if (task) task.title = node.task_id
    const state = document.querySelector('#inspector-state')
    if (state) {
      state.textContent = node.label
      state.className = 'inspector-state tone-' + node.tone
    }
    for (const [kind, value] of Object.entries(node.signals)) {
      const visibleKind = kind === 'liveness' ? 'process' : kind
      const term = Array.from(document.querySelectorAll('.inspector-signals dt'))
        .find((item) => item.textContent === visibleKind)
      const row = term?.parentElement
      const output = row?.querySelector('dd')
      if (output) output.textContent = value
      if (row) row.className = 'signal ' + toneForSignal(visibleKind, value, node)
    }
    setText('#inspector-meaning', node.meaning)
    setText('#inspector-elapsed-label', node.elapsed_label)
    setText('#inspector-elapsed', node.elapsed_value)
    setText('#inspector-action', node.next_action)
    const identity = document.querySelector('#inspector-identity')
    if (identity) {
      identity.textContent = node.identity_note || ''
      identity.hidden = !node.identity_note
    }
    const qualifier = document.querySelector('#inspector-freshness')
    const qualifierCopy = currentFreshnessQualifier()
    if (qualifier) {
      qualifier.textContent = qualifierCopy || staleCopy
      qualifier.hidden = !qualifierCopy
    }
  }
  const selectNode = (nodeId, { focus = false, open = true } = {}) => {
    const node = nodeById.get(nodeId)
    if (!node) return
    selectedId = nodeId
    for (const element of agentElements) {
      const selected = element.dataset.nodeId === nodeId
      element.setAttribute('aria-pressed', String(selected))
      element.setAttribute('aria-expanded', String(selected && open))
      element.tabIndex = selected ? 0 : -1
    }
    updateInspector(node)
    if (inspector) inspector.hidden = !open
    if (focus) {
      const target = agentElements.find((element) => element.dataset.nodeId === nodeId)
      try { target?.focus({ preventScroll: true }) } catch { target?.focus() }
    }
  }
  const closeDetails = () => {
    if (inspector) inspector.hidden = true
    for (const element of agentElements) element.setAttribute('aria-expanded', 'false')
    const target = agentElements.find((element) => element.dataset.nodeId === selectedId)
    try { target?.focus({ preventScroll: true }) } catch { target?.focus() }
  }
  const updateRefreshControl = () => {
    if (!refreshControl) return
    refreshControl.setAttribute('aria-pressed', String(autoRefreshPaused))
    if (refreshState) {
      refreshState.textContent = autoRefreshPaused
        ? 'พักการรีเฟรชอัตโนมัติแล้ว'
        : 'รีเฟรชอัตโนมัติเปิดอยู่ · ทุก ' + (header?.dataset.refreshInterval || '?') + ' วิ'
    }
  }
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    if (autoRefreshPaused) return
    const seconds = Number(header?.dataset.refreshInterval)
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 20000
    reloadTimer = setTimeout(() => {
      storeReloadRestore()
      location.reload()
    }, delay)
  }
  const updateFreshness = () => {
    if (!header || !status || !note) return
    if (freshnessTimer) clearTimeout(freshnessTimer)
    const expiry = Date.parse(header.dataset.observationExpiresAt || '')
    const valid = Number.isFinite(expiry)
    const freshness = !valid ? 'unknown' : Date.now() >= expiry ? 'stale' : 'fresh'
    const qualifierCopy = freshness === 'stale' ? staleCopy : freshness === 'unknown' ? unknownCopy : ''
    document.body.dataset.observationFreshness = freshness
    for (const name of ['fresh', 'stale', 'unknown']) status.classList.toggle(name, freshness === name)
    status.textContent = freshness === 'stale' ? 'ข้อมูลหมดอายุ'
      : freshness === 'unknown' ? 'ตรวจ freshness ไม่ได้' : 'ข้อมูลสด'
    note.textContent = freshness === 'stale' ? 'ตัวสังเกตการณ์ไม่อัปเดตตามรอบ'
      : freshness === 'unknown' ? 'ตรวจเวลาหมดอายุไม่ได้' : 'snapshot ยังอยู่ในช่วงสังเกตการณ์'
    if (graph) {
      const base = graph.dataset.baseAriaLabel || 'D3 phase flowchart'
      graph.setAttribute('aria-label', qualifierCopy ? qualifierCopy + '. ' + base : base)
    }
    for (const element of agentElements) {
      element.dataset.nodeFreshness = freshness
      const base = element.dataset.baseAriaLabel || nodeById.get(element.dataset.nodeId)?.base_aria || ''
      element.dataset.baseAriaLabel = base
      element.setAttribute('aria-label', qualifierCopy ? qualifierCopy + '. ' + base : base)
      const title = element.querySelector('title')
      if (title) title.textContent = qualifierCopy ? qualifierCopy + '. ' + base : base
    }
    if (selectedId) updateInspector(nodeById.get(selectedId))
    if (freshness === 'fresh') {
      const delay = Math.min(Math.max(expiry - Date.now() + 25, 25), 2147000000)
      freshnessTimer = setTimeout(updateFreshness, delay)
    }
  }

  const savedRestore = consumeReloadRestore()
  autoRefreshPaused = readPaused()
  if (d3Ready && zoomBehavior && savedRestore?.transform &&
      Object.values(savedRestore.transform).every(Number.isFinite)) {
    const restored = d3.zoomIdentity
      .translate(savedRestore.transform.x, savedRestore.transform.y)
      .scale(savedRestore.transform.k)
    svgSelection.call(zoomBehavior.transform, restored)
  }
  const restoredSelection = nodeById.has(savedRestore?.selectedId) ? savedRestore.selectedId : initialSelectedId
  if (restoredSelection) selectNode(restoredSelection, {
    open: savedRestore ? savedRestore.inspectorOpen !== false : false,
  })
  updateRefreshControl()
  updateFreshness()
  requestAnimationFrame(() => {
    if (savedRestore?.focusNodeId && nodeById.has(savedRestore.focusNodeId)) {
      selectNode(savedRestore.focusNodeId, { focus: true, open: savedRestore.inspectorOpen !== false })
    } else if (savedRestore?.focusId) {
      const target = document.getElementById(savedRestore.focusId)
      try { target?.focus({ preventScroll: true }) } catch { target?.focus() }
    }
  })

  const bindAgentEvents = () => {
    for (const [index, element] of agentElements.entries()) {
      element.addEventListener('click', () => selectNode(element.dataset.nodeId, { focus: true }))
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          selectNode(element.dataset.nodeId, { focus: true })
          return
        }
        let nextIndex = index
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % agentElements.length
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + agentElements.length) % agentElements.length
        else if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = agentElements.length - 1
        else return
        event.preventDefault()
        selectNode(agentElements[nextIndex].dataset.nodeId, { focus: true })
      })
    }
  }
  bindAgentEvents()
  closeInspector?.addEventListener('click', closeDetails)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && inspector && !inspector.hidden) {
      event.preventDefault()
      closeDetails()
    }
  })
  document.querySelector('#graph-zoom-in')?.addEventListener('click', () => {
    if (d3Ready && zoomBehavior) svgSelection.call(zoomBehavior.scaleBy, 1.25)
  })
  document.querySelector('#graph-zoom-out')?.addEventListener('click', () => {
    if (d3Ready && zoomBehavior) svgSelection.call(zoomBehavior.scaleBy, .8)
  })
  document.querySelector('#graph-fit')?.addEventListener('click', () => {
    if (d3Ready && zoomBehavior) svgSelection.call(zoomBehavior.transform, d3.zoomIdentity)
  })
  refreshControl?.addEventListener('click', () => {
    autoRefreshPaused = !autoRefreshPaused
    writePaused()
    updateRefreshControl()
    scheduleReload()
  })
  scheduleReload()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateFreshness()
  })
})()
</script></body></html>`
}
