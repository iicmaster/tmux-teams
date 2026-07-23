import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { KANIT_FONT_CSS } from '../plugins/tmux-teams/skills/tmux-teams/assets/kanit/kanit-embedded.mjs'
import { buildPulseProjection } from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs'
import { sanitizeDeliveryLoopProjection } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SKILL = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams')
const PULSE = join(SKILL, 'scripts', 'pulse.mjs')
const V1_SCHEMA = join(SKILL, 'references', 'pulse-v1.schema.json')
const V2_SCHEMA = join(SKILL, 'references', 'pulse-v2.schema.json')
const HAS_PYTHON_JSONSCHEMA = spawnSync('python3', ['-c', 'import jsonschema'], {
  encoding: 'utf8',
}).status === 0
const FONT_CSS_NAME = `pulse-fonts-${createHash('sha256').update(KANIT_FONT_CSS).digest('hex')}.css`

const digest = (char) => `sha256:${char.repeat(64)}`
const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

function projection() {
  return {
    schema: 'tmux-teams.delivery-loop-projection',
    schema_version: 1,
    generated_at: nowIso(-1_000),
    expires_at: nowIso(60_000),
    trust_level: 'advisory_same_uid',
    mode: 'stage1_observe_only',
    status: 'active',
    actuation: { enabled: false, auto_execute: false },
    experiment: {
      experiment_id: 'pilot-1',
      manifest_id: 'manifest-1',
      manifest_digest: digest('a'),
      dataset_digest: digest('b'),
      boundary: 'development_to_qa',
      assignment_window: {
        start: '2026-07-23T00:00:00.000Z',
        end: '2026-08-23T00:00:00.000Z',
      },
      analysis_as_of: '2026-07-23T01:00:00.000Z',
    },
    source_health: {
      manifest: 'ok',
      assignment: 'ok',
      events: 'ok',
      costs: 'ok',
      outcomes: 'ok',
      guardrails: 'ok',
      export: 'ok',
    },
    summary: {
      assigned: 4,
      in_progress: 2,
      terminal: 2,
      exceptions: 0,
      contaminated: 0,
      operator_action_total: 1,
      operator_action_shown: 1,
      operator_action_truncated: 0,
    },
    phase_cards: [
      {
        phase: 'Requirement',
        state: 'complete',
        active_slices: 0,
        oldest_open_age_sec: null,
        reason_codes: ['OBSERVATION_CURRENT'],
        advisory: {
          attention: false,
          owner_role: 'experiment_owner',
          action_code: 'monitor',
          auto_execute: false,
        },
      },
      {
        phase: 'Development',
        state: 'waiting_receiver',
        active_slices: 1,
        oldest_open_age_sec: 120,
        reason_codes: ['HANDOFF_AWAITING_RECEIVER'],
        advisory: {
          attention: true,
          owner_role: 'receiver_phase_lead',
          action_code: 'review_handoff',
          auto_execute: false,
        },
      },
    ],
    bottleneck: {
      status: 'available',
      basis: 'oldest_open_handoff_age',
      boundary: 'development_to_qa',
      age_sec: 120,
      reason_codes: ['BOTTLENECK_AVAILABLE'],
    },
    attention: [
      {
        attention_id: 'qa-review',
        severity: 'warning',
        scope: 'slice',
        slice_id: 'slice-1',
        phase: 'Development',
        owner_role: 'receiver_phase_lead',
        reason_codes: ['HANDOFF_AWAITING_RECEIVER'],
        action_code: 'review_handoff',
        auto_execute: false,
      },
    ],
    next_action: {
      scope: 'slice',
      slice_id: 'slice-1',
      phase: 'Development',
      owner_role: 'receiver_phase_lead',
      reason_codes: ['HANDOFF_AWAITING_RECEIVER'],
      action_code: 'review_handoff',
      auto_execute: false,
    },
    evidence: {
      measurement_readiness: 'INCONCLUSIVE',
      scenario_signal: 'INCONCLUSIVE',
      guardrail_status: 'CLEAR',
      evidence_eligibility: 'OBSERVED_UNVERIFIED',
      safety_hold_recommended: false,
      business_decision: 'EXTERNAL_REQUIRED',
    },
  }
}

function exportedProjection(states = ['accepted', 'proposed']) {
  const generatedAt = nowIso(-1_000)
  return buildPulseProjection({
    manifest: {
      experiment_id: 'pulse-export-integration',
      manifest_id: 'pulse-export-manifest',
      manifest_digest: digest('c'),
      boundary: { sender_phase: 'QA', receiver_phase: 'ProjectDelivery' },
      assignment: {
        assignment_window: {
          start: '2026-07-01T00:00:00.000Z',
          end: '2026-08-31T00:00:00.000Z',
        },
      },
    },
    bundle: {
      analysis: {
        measurement_readiness: 'INCONCLUSIVE',
        scenario_signal: 'INCONCLUSIVE',
        guardrail_status: 'CLEAR',
        safety_hold_recommended: false,
        metrics: { cost_complete: false, outcome_complete: false },
      },
      replay: {
        slices: states.map((state, index) => ({
          handoff_attempts: [{ state }],
          contamination: index === 1,
        })),
      },
      dataset_digest: digest('d'),
      as_of: '2026-07-23T03:30:00.000Z',
    },
    generatedAt,
  })
}

function repo() {
  return mkdtempSync(join(tmpdir(), 'pulse-v2-'))
}

const fontCssPath = (dir) => join(dir, '.tmux-teams', FONT_CSS_NAME)

function writeProjection(dir, value = projection()) {
  const path = join(dir, 'delivery-loop-projection.json')
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

function run(args) {
  return spawnSync(process.execPath, [PULSE, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  })
}

const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

async function stopWatcher(pid, pidfile) {
  try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
  for (let index = 0; index < 40 && alive(pid); index++) await delay(25)
  assert.equal(alive(pid), false, `watcher ${pid} did not stop`)
  for (let index = 0; index < 20 && existsSync(pidfile); index++) await delay(25)
  assert.equal(existsSync(pidfile), false, 'watcher did not clean its pidfile')
}

function runJson(dir, projectionPath = null) {
  const args = ['json', dir]
  if (projectionPath) args.push('--delivery-loop', projectionPath)
  const result = run(args)
  assert.equal(result.status, 0, result.stderr)
  return { result, snapshot: JSON.parse(result.stdout) }
}

/** Stable structural extractors: test relationships, not an SVG pixel snapshot. */
function svgById(html, id) {
  const match = html.match(new RegExp(`<svg\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</svg>`))
  assert.ok(match, `missing SVG ${id}`)
  return match[0]
}

function sectionByLabel(html, labelledBy) {
  const marker = `aria-labelledby="${labelledBy}"`
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, `missing section ${labelledBy}`)
  const sectionStart = html.lastIndexOf('<section', start)
  return html.slice(sectionStart, html.indexOf('</section>', start) + '</section>'.length)
}

const thaiTime = (iso) => `${new Date(Date.parse(iso) + 7 * 60 * 60 * 1000)
  .toISOString().replace('T', ' ').slice(0, 19)} เวลาไทย (UTC+7)`

function assertSvgA11y(svg, titleId, descId) {
  assert.match(svg, /role="img"/)
  assert.match(svg, new RegExp(`aria-labelledby="${titleId} ${descId}"`))
  assert.match(svg, new RegExp(`<title id="${titleId}">[^<]+</title>`))
  assert.match(svg, new RegExp(`<desc id="${descId}">[^<]+</desc>`))
}

function validate(schemaPath, instancePath, definition = null) {
  const program = [
    'import json, jsonschema, sys',
    'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
    'instance = json.load(open(sys.argv[2], encoding="utf-8"))',
    'definition = sys.argv[3]',
    'schema = {"$schema": schema.get("$schema"), "$defs": schema["$defs"], "$ref": f"#/$defs/{definition}"} if definition != "-" else schema',
    'jsonschema.Draft202012Validator.check_schema(schema)',
    'jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(instance)',
  ].join('; ')
  return spawnSync('python3', ['-c', program, schemaPath, instancePath, definition ?? '-'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

test('Pulse remains v1 by default and v2 is an explicit delivery-loop opt-in', () => {
  const dir = repo()
  const defaultRun = runJson(dir)
  assert.equal(defaultRun.snapshot.schema_version, 1)
  assert.ok(!Object.hasOwn(defaultRun.snapshot, 'delivery_loop'))

  const projectionPath = writeProjection(dir)
  const optedIn = runJson(dir, projectionPath)
  assert.equal(optedIn.snapshot.schema_version, 2)
  assert.equal(optedIn.snapshot.delivery_loop.schema, 'tmux-teams.delivery-loop-projection')
  assert.equal(optedIn.snapshot.delivery_loop.mode, 'stage1_observe_only')
  assert.deepEqual(optedIn.snapshot.delivery_loop.actuation, { enabled: false, auto_execute: false })
  assert.equal(optedIn.snapshot.delivery_loop.evidence.business_decision, 'EXTERNAL_REQUIRED')

  const persistedPath = join(dir, '.tmux-teams', 'pulse.json')
  assert.deepEqual(JSON.parse(readFileSync(persistedPath, 'utf8')), optedIn.snapshot)
  assert.equal(existsSync(join(dir, '.tmux-teams', 'pulse-v2.json')), false)
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  assert.match(html, new RegExp(`content="${optedIn.snapshot.snapshot_id}"`))
  assert.match(html, /วงรอบส่งมอบ/)
  assert.match(html, /Development/)
  assert.match(html, /ตรวจรับงานส่งมอบ/)
  assert.match(html, new RegExp(`<link rel="stylesheet" href="${FONT_CSS_NAME}">`))
  assert.doesNotMatch(html, /data:font\/woff2;base64,|fonts\.(?:googleapis|gstatic)\.com/)
  assert.equal(readFileSync(fontCssPath(dir), 'utf8'), KANIT_FONT_CSS)
  assert.match(html, /title="Asia\/Bangkok"/)
  assert.match(html, /เวลาไทย \(UTC\+7\)/)
  assert.match(optedIn.snapshot.generated_at, /Z$/,
    'the v2 machine contract must retain RFC3339 UTC timestamps')

  if (HAS_PYTHON_JSONSCHEMA) {
    const validation = validate(V2_SCHEMA, persistedPath)
    assert.equal(validation.status, 0, validation.stderr || validation.stdout)
  }
})

test('an in-progress production exporter projection survives sanitizer, persistence, and rendering', () => {
  const value = exportedProjection()
  assert.deepEqual(value.summary, {
    assigned: 2,
    in_progress: 1,
    terminal: 1,
    exceptions: 0,
    contaminated: 1,
    operator_action_total: 1,
    operator_action_shown: 1,
    operator_action_truncated: 0,
  })
  assert.deepEqual(value.bottleneck, {
    status: 'inconclusive',
    basis: 'oldest_open_handoff_age',
    boundary: 'qa_to_project_delivery',
    age_sec: null,
    reason_codes: ['BOTTLENECK_INCONCLUSIVE'],
  })

  const before = structuredClone(value)
  const sanitized = sanitizeDeliveryLoopProjection(
    value,
    Date.parse(value.generated_at) + 1_000,
  )
  assert.equal(sanitized.diagnostic, null)
  assert.deepEqual(sanitized.projection, value)
  assert.deepEqual(value, before, 'sanitization must not mutate the producer projection')

  const dir = repo()
  const projectionPath = writeProjection(dir, value)
  const { result, snapshot } = runJson(dir, projectionPath)
  const persistedPath = join(dir, '.tmux-teams', 'pulse.json')
  const persistedText = readFileSync(persistedPath, 'utf8')
  assert.equal(result.stdout, persistedText, 'stdout and the Pulse SSOT must be byte-identical')
  assert.deepEqual(snapshot.delivery_loop, value)
  assert.equal(snapshot.delivery_loop.status, 'active')
  assert.ok(!snapshot.diagnostics.some(item => item.source === 'delivery_loop'))

  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const topology = svgById(html, 'delivery-topology-svg')
  const selected = [...topology.matchAll(
    /data-boundary="([^"]+)" data-selected="true" data-observed="true"/g,
  )].map(([, boundary]) => boundary)
  assert.match(topology, /data-selected-boundary="qa_to_project_delivery"/)
  assert.deepEqual(selected, ['qa_to_project_delivery'])
  assert.doesNotMatch(html, /ยังไม่ได้เลือกขอบเขต pilot ที่ยืนยันได้/)

  const completed = exportedProjection(['accepted', 'rejected'])
  assert.deepEqual(completed.bottleneck, {
    status: 'none',
    basis: 'oldest_open_handoff_age',
    boundary: null,
    age_sec: null,
    reason_codes: ['NO_ACTIVE_SLICES'],
  })
  const completedSanitized = sanitizeDeliveryLoopProjection(
    completed,
    Date.parse(completed.generated_at) + 1_000,
  )
  assert.equal(completedSanitized.diagnostic, null)
  assert.deepEqual(completedSanitized.projection, completed)

  if (HAS_PYTHON_JSONSCHEMA) {
    const projectionValidation = validate(V2_SCHEMA, projectionPath, 'delivery_loop')
    assert.equal(projectionValidation.status, 0,
      projectionValidation.stderr || projectionValidation.stdout)
    const snapshotValidation = validate(V2_SCHEMA, persistedPath)
    assert.equal(snapshotValidation.status, 0,
      snapshotValidation.stderr || snapshotValidation.stdout)
  }
})

test('bottleneck status matrix stays aligned across sanitizer and normative schema', () => {
  const knownBoundaries = [
    'requirement_to_prototype',
    'prototype_to_development',
    'development_to_qa',
    'qa_to_project_delivery',
  ]
  const reasonFor = {
    available: 'BOTTLENECK_AVAILABLE',
    none: 'NO_ACTIVE_SLICES',
    inconclusive: 'BOTTLENECK_INCONCLUSIVE',
  }
  const withBottleneck = (status, boundary, ageSec) => {
    const value = exportedProjection()
    value.bottleneck = {
      status,
      basis: 'oldest_open_handoff_age',
      boundary,
      age_sec: ageSec,
      reason_codes: [reasonFor[status]],
    }
    if (boundary !== null && knownBoundaries.includes(boundary)) {
      value.experiment.boundary = boundary
    }
    return value
  }
  const positiveCases = [
    ['available accepts a measured zero age', withBottleneck('available', 'qa_to_project_delivery', 0)],
    ['none requires no boundary or age', withBottleneck('none', null, null)],
    ['inconclusive accepts an unknown boundary', withBottleneck('inconclusive', null, null)],
    ...knownBoundaries.map(boundary => [
      `inconclusive preserves ${boundary}`,
      withBottleneck('inconclusive', boundary, null),
    ]),
  ]

  for (const [name, value] of positiveCases) {
    const before = structuredClone(value)
    const sanitized = sanitizeDeliveryLoopProjection(
      value,
      Date.parse(value.generated_at) + 1_000,
    )
    assert.equal(sanitized.diagnostic, null, name)
    assert.deepEqual(sanitized.projection.bottleneck, value.bottleneck, name)
    assert.deepEqual(value, before, `${name}: sanitizer mutated its input`)
    if (HAS_PYTHON_JSONSCHEMA) {
      const dir = repo()
      const validation = validate(V2_SCHEMA, writeProjection(dir, value), 'delivery_loop')
      assert.equal(validation.status, 0,
        `${name}: ${validation.stderr || validation.stdout}`)
    }
  }

  const rawSentinel = 'PULSE_V2_RAW_DO_NOT_LEAK'
  const negativeCases = [
    ['available without boundary', withBottleneck('available', null, 0), true],
    ['available without age', withBottleneck('available', 'qa_to_project_delivery', null), true],
    ['available without boundary or age', withBottleneck('available', null, null), true],
    ['none with boundary', withBottleneck('none', 'qa_to_project_delivery', null), true],
    ['none with age', withBottleneck('none', null, 0), true],
    ['none with boundary and age', withBottleneck('none', 'qa_to_project_delivery', 0), true],
    ['inconclusive with age', withBottleneck('inconclusive', null, 0), true],
    ['inconclusive with known boundary and age',
      withBottleneck('inconclusive', 'qa_to_project_delivery', 0), true],
    ['unknown boundary', withBottleneck('inconclusive', rawSentinel, null), true],
    ['negative age', withBottleneck('available', 'qa_to_project_delivery', -1), true],
    ['string age', withBottleneck('available', 'qa_to_project_delivery', '1'), true],
    ['NaN age', withBottleneck('available', 'qa_to_project_delivery', Number.NaN), false],
    ['infinite age', withBottleneck('available', 'qa_to_project_delivery', Infinity), false],
    ['missing age key', (() => {
      const value = withBottleneck('available', 'qa_to_project_delivery', 0)
      delete value.bottleneck.age_sec
      return value
    })(), true],
    ['extra bottleneck key', (() => {
      const value = withBottleneck('inconclusive', 'qa_to_project_delivery', null)
      value.bottleneck.raw_boundary = rawSentinel
      return value
    })(), true],
  ]
  const invalidDiagnostic = {
    code: 'DELIVERY_LOOP_INPUT_INVALID',
    severity: 'error',
    source: 'delivery_loop',
    count: 1,
  }

  for (const [name, value, schemaSerializable] of negativeCases) {
    const before = structuredClone(value)
    const sanitized = sanitizeDeliveryLoopProjection(
      value,
      Date.parse(value.generated_at) + 1_000,
    )
    assert.deepEqual(sanitized.diagnostic, invalidDiagnostic, name)
    assert.equal(sanitized.projection.status, 'degraded', name)
    assert.deepEqual(sanitized.projection.bottleneck, {
      status: 'inconclusive',
      basis: 'oldest_open_handoff_age',
      boundary: null,
      age_sec: null,
      reason_codes: ['SOURCE_DEGRADED'],
    }, name)
    assert.equal(sanitized.projection.next_action.action_code, 'restore_observability', name)
    assert.deepEqual(sanitized.projection.actuation, {
      enabled: false,
      auto_execute: false,
    }, name)
    assert.ok(!JSON.stringify(sanitized).includes(rawSentinel), `${name}: raw value leaked`)
    assert.deepEqual(value, before, `${name}: sanitizer mutated its input`)
    if (HAS_PYTHON_JSONSCHEMA && schemaSerializable) {
      const dir = repo()
      const validation = validate(V2_SCHEMA, writeProjection(dir, value), 'delivery_loop')
      assert.notEqual(validation.status, 0, `${name}: normative schema accepted invalid input`)
    }
  }
})

test('delivery topology keeps every normative handoff and marks only the observed pilot boundary', () => {
  const cases = [
    ['requirement_to_prototype', 'requirements_baseline', 'Requirement', 'Prototype', 'ฐานข้อกำหนด'],
    ['prototype_to_development', 'prototype_evaluation', 'Prototype', 'Development', 'ผลประเมินต้นแบบที่คลิกได้'],
    ['development_to_qa', 'development_delivery', 'Development', 'QA', 'ซอฟต์แวร์ที่ใช้งานได้'],
    ['qa_to_project_delivery', 'qa_release_evidence', 'QA', 'ProjectDelivery', 'รายงาน E2E / UAT'],
  ]

  for (const [boundary, artifact, sender, receiver, thaiArtifact] of cases) {
    const dir = repo()
    const value = projection()
    value.experiment.boundary = boundary
    const { snapshot } = runJson(dir, writeProjection(dir, value))
    const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
    const topology = svgById(html, 'delivery-topology-svg')
    const topologyText = topology.replace(/<[^>]+>/g, '')
    const selectedEdges = [...topology.matchAll(/<g class="df-edge[^\"]*" data-boundary="([^"]+)" data-selected="true" data-observed="true">/g)]

    assert.equal(snapshot.delivery_loop.experiment.boundary, boundary)
    assert.match(topology, new RegExp(`data-selected-boundary="${boundary}"`))
    assert.deepEqual(selectedEdges.map(([, selected]) => selected), [boundary])
    for (const [mappedBoundary, mappedArtifact, mappedSender, mappedReceiver, mappedThaiArtifact] of cases) {
      assert.match(topology, new RegExp(`data-boundary="${mappedBoundary}"`))
      assert.match(topology, new RegExp(`data-boundary="${mappedBoundary}" data-selected="(?:true|false)" data-observed="(?:true|false)"`))
      assert.match(topology, new RegExp(mappedArtifact.split('_').join('[\\s\\S]*?')),
        `missing ordered artifact ${mappedArtifact}`)
      assert.ok(topologyText.includes(mappedThaiArtifact), `missing Thai artifact ${mappedThaiArtifact}`)
    }
    assert.match(topology, new RegExp(`★ pilot ที่สังเกต: ${boundary}`), 'the observed edge must be explicit')
    assert.match(topology, new RegExp(artifact.split('_').join('[\\s\\S]*?')))
    assert.ok(topologyText.includes(thaiArtifact))
    assert.ok(boundary.includes(sender.toLowerCase().replace('projectdelivery', 'project_delivery'))
      || boundary.endsWith(receiver.toLowerCase().replace('projectdelivery', 'project_delivery')),
    'the table binds the selected artifact to its named contract phases')
  }
})

test('an unconfirmed pilot boundary keeps the topology visible without selecting an edge', () => {
  const dir = repo()
  const value = projection()
  value.experiment.boundary = null
  const { snapshot } = runJson(dir, writeProjection(dir, value))
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const topology = svgById(html, 'delivery-topology-svg')

  assert.equal(snapshot.delivery_loop.experiment.boundary, null)
  assert.match(topology, /data-selected-boundary=""/)
  assert.equal((topology.match(/data-selected="true"/g) || []).length, 0)
  assert.equal((topology.match(/data-selected="false"/g) || []).length, 4)
  assert.match(html, /ยังไม่ได้เลือกขอบเขต pilot ที่ยืนยันได้ จึงไม่เน้นเส้นใด/)
})

test('delivery diagrams state receiver ownership, PM exception-only scope, and handoff terminality', () => {
  const dir = repo()
  const html = (() => {
    runJson(dir, writeProjection(dir))
    return readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  })()
  const topology = svgById(html, 'delivery-topology-svg')
  const sequence = svgById(html, 'handoff-sequence-svg')
  const topologyEquivalent = sectionByLabel(html, 'delivery-flow-equivalent-title')
  const sequenceEquivalent = sectionByLabel(html, 'delivery-sequence-equivalent-title')

  assertSvgA11y(topology, 'delivery-flow-title', 'delivery-flow-desc')
  assertSvgA11y(sequence, 'delivery-sequence-title', 'delivery-sequence-desc')
  assert.match(html, /<div class="diagram-scroll" tabindex="0" role="region"/)
  assert.ok((html.match(/<div class="diagram-scroll" tabindex="0" role="region"/g) || []).length >= 2)
  assert.ok(html.includes(`<div class="diagram-scroll" tabindex="0" role="region" aria-label="แผนภาพโมเดลการส่งมอบแบบเลื่อนแนวนอนได้">${topology}`))
  assert.ok(html.includes(`<div class="diagram-scroll" tabindex="0" role="region" aria-label="แผนภาพลำดับการส่งมอบแบบเลื่อนแนวนอนได้">${sequence}`))
  assert.match(topology, /PM outer loop: ประสาน ติด bottleneck และแก้ข้อยกเว้นเท่านั้น — ไม่ตรวจรับแทนทีมผู้รับ/)
  assert.match(topology, /Requirement/)
  assert.match(topology, /Prototype/)
  assert.match(topology, /Development/)
  assert.match(topology, /QA/)
  const edgePosition = (boundary) => topology.indexOf(`data-boundary="${boundary}"`)
  assert.ok(edgePosition('requirement_to_prototype') < edgePosition('prototype_to_development')
    && edgePosition('prototype_to_development') < edgePosition('development_to_qa')
    && edgePosition('development_to_qa') < edgePosition('qa_to_project_delivery'))
  assert.match(topologyEquivalent, /ProjectDelivery เป็นผู้รับปลายทาง ไม่ใช่ทีมลูปที่ห้า/)
  assert.match(topologyEquivalent, /ผู้รับเป็นเจ้าของการตรวจรับและการรับ\/ปฏิเสธ/)
  assert.match(topologyEquivalent, /การรับไม่ใช่การรับรองหรืออนุมัติธุรกิจ/)
  for (const artifact of ['requirements_baseline', 'prototype_evaluation', 'development_delivery', 'qa_release_evidence']) {
    assert.match(topologyEquivalent, new RegExp(artifact))
  }

  assert.match(sequence, /immutable artifact \/ attempt/)
  assert.match(sequence, /ผู้รับเลือก accept หรือ reject/)
  assert.match(sequence, /reject = attempt เดิมสิ้นสุด/)
  assert.match(sequence, /NEW attempt \+ revision_of_attempt_id/)
  assert.match(sequence, /PM resolve_exception → proposed; ผู้รับยังตัดสินผล/)
  assert.match(sequenceEquivalent, /ผู้รับตรวจและเป็นเจ้าของการยอมรับหรือปฏิเสธตามปกติ/)
  assert.match(sequenceEquivalent, /การปฏิเสธสิ้นสุด attempt เดิม/)
  assert.match(sequenceEquivalent, /revision_of_attempt_id/)
  assert.match(sequenceEquivalent, /กลับสู่ proposed; ผู้รับยังเป็นผู้ตัดสินผล/)
})

test('delivery times are semantic Thai time elements while the persisted contract retains UTC', () => {
  const dir = repo()
  const value = projection()
  const expectedTimes = [
    value.generated_at,
    value.experiment.analysis_as_of,
    value.experiment.assignment_window.start,
    value.experiment.assignment_window.end,
  ]
  const { snapshot } = runJson(dir, writeProjection(dir, value))
  const persisted = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const delivery = sectionByLabel(html, 'delivery-loop-title')

  assert.deepEqual([
    snapshot.delivery_loop.generated_at,
    snapshot.delivery_loop.experiment.analysis_as_of,
    snapshot.delivery_loop.experiment.assignment_window.start,
    snapshot.delivery_loop.experiment.assignment_window.end,
  ], expectedTimes)
  assert.deepEqual(persisted.delivery_loop, snapshot.delivery_loop)
  for (const time of expectedTimes) {
    assert.ok(delivery.includes(`<time datetime="${time}" title="Asia/Bangkok">${thaiTime(time)}</time>`),
      `missing Thai semantic time for ${time}`)
  }
  assert.equal((delivery.match(/<time datetime="[^"]+" title="Asia\/Bangkok">[^<]+ เวลาไทย \(UTC\+7\)<\/time>/g) || []).length, 4)
})

test('v1 HTML omits opt-in delivery diagrams and artifacts but retains the dispatch lifecycle', () => {
  const dir = repo()
  const { snapshot } = runJson(dir)
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  assert.equal(snapshot.schema_version, 1)
  assert.ok(!Object.hasOwn(snapshot, 'delivery_loop'))
  assert.doesNotMatch(html, /delivery-topology-svg|handoff-sequence-svg|requirements_baseline|qa_release_evidence/)
  assertSvgA11y(svgById(html, 'dispatch-lifecycle-svg'), 'worker-lifecycle-title', 'worker-lifecycle-desc')
})

test('delivery rendering has no external runtime or chart dependency and keeps its local content-addressed font', () => {
  const dir = repo()
  runJson(dir, writeProjection(dir))
  const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
  const source = readFileSync(PULSE, 'utf8')

  assert.doesNotMatch(html, /https?:\/\/|<script\b[^>]+src=|(?:d3|chart)\.js/i)
  assert.doesNotMatch(source, /https?:\/\/|\b(?:fetch|XMLHttpRequest)\s*\(/)
  assert.match(html, new RegExp(`<link rel="stylesheet" href="${FONT_CSS_NAME}">`))
  assert.equal(readFileSync(fontCssPath(dir), 'utf8'), KANIT_FONT_CSS)
})

test('Pulse v2 schema is closed, bounded, advisory-only, and externally decided', () => {
  const schema = JSON.parse(readFileSync(V2_SCHEMA, 'utf8'))
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.schema_version.const, 2)
  assert.equal(schema.properties.trust_level.const, 'advisory_same_uid')
  for (const [name, definition] of [['pulse', schema], ...Object.entries(schema.$defs)]) {
    if (definition.type !== 'object') continue
    assert.equal(definition.additionalProperties, false, `${name} must be closed`)
    assert.deepEqual([...definition.required].sort(), Object.keys(definition.properties).sort(),
      `${name} must require every declared property`)
  }
  assert.equal(schema.$defs.delivery_actuation.properties.enabled.const, false)
  assert.equal(schema.$defs.delivery_actuation.properties.auto_execute.const, false)
  assert.equal(schema.$defs.delivery_evidence.properties.business_decision.const, 'EXTERNAL_REQUIRED')
  assert.equal(schema.$defs.delivery_loop.properties.attention.maxItems, 50)
})

test('closed projection input and bounds fail closed without leaking raw values', () => {
  for (const mutate of [
    (value) => { value.raw_worker_message = 'PULSE_V2_RAW_DO_NOT_LEAK' },
    (value) => { value.actuation.command = 'PULSE_V2_RAW_DO_NOT_LEAK' },
    (value) => {
      value.bottleneck.status = 'inconclusive'
      value.bottleneck.boundary = 'PULSE_V2_RAW_DO_NOT_LEAK'
      value.bottleneck.age_sec = null
      value.bottleneck.reason_codes = ['BOTTLENECK_INCONCLUSIVE']
    },
    (value) => { value.next_action.action_code = 'monitor' },
    (value) => { value.generated_at = '2026-02-30T00:00:00.000Z' },
    (value) => { value.evidence.scenario_signal = 'FAVORABLE' },
    (value) => {
      value.evidence.guardrail_status = 'BREACH'
      value.evidence.safety_hold_recommended = false
    },
    (value) => { value.experiment.experiment_id = null },
    (value) => { value.experiment.manifest_digest = null },
    (value) => {
      value.status = 'complete'
      value.experiment.dataset_digest = null
    },
    (value) => {
      value.attention = Array.from({ length: 51 }, (_, index) => ({
        ...value.attention[0],
        attention_id: `attention-${index}`,
      }))
      value.summary.operator_action_total = 51
      value.summary.operator_action_shown = 51
    },
  ]) {
    const dir = repo()
    const value = projection()
    mutate(value)
    const { snapshot, result } = runJson(dir, writeProjection(dir, value))
    assert.equal(snapshot.schema_version, 2)
    assert.equal(snapshot.complete, false)
    assert.equal(snapshot.delivery_loop.status, 'degraded')
    assert.equal(snapshot.delivery_loop.next_action.action_code, 'restore_observability')
    assert.equal(snapshot.delivery_loop.next_action.auto_execute, false)
    assert.equal(snapshot.delivery_loop.evidence.business_decision, 'EXTERNAL_REQUIRED')
    assert.ok(snapshot.diagnostics.some(item => item.code === 'DELIVERY_LOOP_INPUT_INVALID'))
    assert.ok(!result.stdout.includes('PULSE_V2_RAW_DO_NOT_LEAK'))
    const html = readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8')
    assert.ok(!html.includes('PULSE_V2_RAW_DO_NOT_LEAK'))
  }
})

test('Pulse v2 schema rejects contradictory evidence and unidentified active experiments', () => {
  if (!HAS_PYTHON_JSONSCHEMA) return
  const dir = repo()
  const valid = runJson(dir, writeProjection(dir)).snapshot
  for (const mutate of [
    (value) => { value.delivery_loop.evidence.scenario_signal = 'FAVORABLE' },
    (value) => {
      value.delivery_loop.evidence.guardrail_status = 'BREACH'
      value.delivery_loop.evidence.safety_hold_recommended = false
    },
    (value) => { value.delivery_loop.experiment.manifest_digest = null },
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    const invalidPath = join(dir, `invalid-${crypto.randomUUID()}.json`)
    writeFileSync(invalidPath, `${JSON.stringify(invalid, null, 2)}\n`)
    const validation = validate(V2_SCHEMA, invalidPath)
    assert.notEqual(validation.status, 0, 'schema accepted a cross-field contradiction')
  }
})

test('an unreadable or stale delivery-loop projection degrades to restore-observability advice', () => {
  const unreadableDir = repo()
  const unreadable = runJson(unreadableDir, join(unreadableDir, 'missing.json')).snapshot
  assert.equal(unreadable.delivery_loop.status, 'degraded')
  assert.equal(unreadable.delivery_loop.next_action.action_code, 'restore_observability')
  assert.ok(unreadable.diagnostics.some(item => item.code === 'DELIVERY_LOOP_INPUT_UNREADABLE'))

  const staleDir = repo()
  const staleValue = projection()
  staleValue.generated_at = '2026-07-20T00:00:00.000Z'
  staleValue.expires_at = '2026-07-20T00:01:00.000Z'
  const stale = runJson(staleDir, writeProjection(staleDir, staleValue)).snapshot
  assert.equal(stale.delivery_loop.status, 'degraded')
  assert.equal(stale.delivery_loop.next_action.action_code, 'restore_observability')
  assert.deepEqual(stale.delivery_loop.next_action.reason_codes, ['OBSERVATION_STALE'])
  assert.equal(stale.delivery_loop.next_action.auto_execute, false)
  assert.equal(stale.delivery_loop.evidence.business_decision, 'EXTERNAL_REQUIRED')
  assert.ok(stale.diagnostics.some(item => item.code === 'DELIVERY_LOOP_STALE'))
})

test('v1 to v2 upgrade preserves stream identity and advances sequence with a diagnostic', () => {
  const dir = repo()
  const v1 = runJson(dir).snapshot
  const v2 = runJson(dir, writeProjection(dir)).snapshot
  assert.equal(v1.schema_version, 1)
  assert.equal(v2.schema_version, 2)
  assert.equal(v2.stream_id, v1.stream_id)
  assert.equal(v2.sequence, v1.sequence + 1)
  assert.ok(v2.diagnostics.some(item => item.code === 'SCHEMA_UPGRADED'))

  const next = runJson(dir, join(dir, 'delivery-loop-projection.json')).snapshot
  assert.equal(next.stream_id, v2.stream_id)
  assert.equal(next.sequence, v2.sequence + 1)
  assert.ok(!next.diagnostics.some(item => item.code === 'SCHEMA_UPGRADED'))
})

test('v2 to v1 keeps one stream while removing the opt-in projection', () => {
  const dir = repo()
  const v2 = runJson(dir, writeProjection(dir)).snapshot
  const v1 = runJson(dir).snapshot

  assert.equal(v2.schema_version, 2)
  assert.equal(v1.schema_version, 1)
  assert.equal(v1.stream_id, v2.stream_id)
  assert.equal(v1.sequence, v2.sequence + 1)
  assert.equal(Object.hasOwn(v1, 'delivery_loop'), false)
})

test('publish fencing is checked inside each atomic rename boundary', () => {
  const source = readFileSync(PULSE, 'utf8')
  const atomicWrite = source.slice(
    source.indexOf('function atomicWrite('),
    source.indexOf('\nfunction atomicWriteIfChanged('),
  )
  assert.match(atomicWrite,
    /if \(publishToken !== null\) assertPublishLock\(publishToken\)\s+renameSync\(temp, path\)/,
    'a reclaimed publisher must be fenced out immediately before rename')
  for (const call of [
    'atomicWriteIfChanged(FONT_CSS_OUT, KANIT_FONT_CSS, token)',
    'atomicWrite(JSON_OUT, jsonText, token)',
    'atomicWrite(OUT, html, token)',
  ]) {
    assert.ok(source.includes(call), `publisher is missing the lock token: ${call}`)
  }
})

test('a corrupted content-addressed font stylesheet is repaired by a v2 publish', () => {
  const dir = repo()
  const projectionPath = writeProjection(dir)
  runJson(dir, projectionPath)
  writeFileSync(fontCssPath(dir), 'corrupt\n')

  const repaired = runJson(dir, projectionPath).snapshot
  assert.equal(repaired.schema_version, 2)
  assert.equal(readFileSync(fontCssPath(dir), 'utf8'), KANIT_FONT_CSS)
})

test('compat-v1 is a stdout-only downprojection and leaves the sole SSOT untouched', () => {
  const dir = repo()
  runJson(dir)
  const v2 = runJson(dir, writeProjection(dir)).snapshot
  assert.equal(v2.schema_version, 2)
  assert.ok(v2.diagnostics.some(item => item.code === 'SCHEMA_UPGRADED'))

  const jsonPath = join(dir, '.tmux-teams', 'pulse.json')
  const htmlPath = join(dir, '.tmux-teams', 'pulse.html')
  const beforeJson = readFileSync(jsonPath, 'utf8')
  const beforeHtml = readFileSync(htmlPath, 'utf8')
  const result = run(['compat-v1', dir])
  assert.equal(result.status, 0, result.stderr)
  const compat = JSON.parse(result.stdout)
  assert.equal(compat.schema_version, 1)
  assert.ok(!Object.hasOwn(compat, 'delivery_loop'))
  assert.equal(compat.stream_id, v2.stream_id)
  assert.equal(compat.sequence, v2.sequence)
  assert.ok(!compat.diagnostics.some(item => item.code === 'SCHEMA_UPGRADED'))
  assert.equal(readFileSync(jsonPath, 'utf8'), beforeJson)
  assert.equal(readFileSync(htmlPath, 'utf8'), beforeHtml)
  assert.equal(existsSync(join(dir, '.tmux-teams', 'pulse-v1.json')), false)

  const compatPath = join(dir, 'compat-v1.json')
  writeFileSync(compatPath, `${JSON.stringify(compat, null, 2)}\n`)
  if (HAS_PYTHON_JSONSCHEMA) {
    const validation = validate(V1_SCHEMA, compatPath)
    assert.equal(validation.status, 0, validation.stderr || validation.stdout)
  }
})

test('compat-v1 fails closed on corrupt or unallowlisted persisted v1 fields', () => {
  const dir = repo()
  runJson(dir)
  const base = runJson(dir, writeProjection(dir)).snapshot
  const jsonPath = join(dir, '.tmux-teams', 'pulse.json')
  for (const mutate of [
    (value) => { value.stream_id = 'PULSE_V2_RAW_DO_NOT_LEAK' },
    (value) => { value.sequence = 0 },
    (value) => { value.trust_level = 'PULSE_V2_RAW_DO_NOT_LEAK' },
    (value) => { value.scope.repo_name = '../../PULSE_V2_RAW_DO_NOT_LEAK' },
    (value) => { value.runs = [{ raw: 'PULSE_V2_RAW_DO_NOT_LEAK' }] },
  ]) {
    const corrupt = structuredClone(base)
    mutate(corrupt)
    writeFileSync(jsonPath, `${JSON.stringify(corrupt, null, 2)}\n`)
    const result = run(['compat-v1', dir])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.ok(!result.stderr.includes('PULSE_V2_RAW_DO_NOT_LEAK'))
    assert.match(result.stderr, /no compatible persisted Pulse snapshot/)
  }
})

test('ensure forwards the delivery-loop opt-in to its detached watcher', async () => {
  const dir = repo()
  const projectionPath = writeProjection(dir)
  const pidfile = join(dir, '.tmux-teams', 'pulse-watch.pid')
  let pid = null
  try {
    const result = run([
      'ensure', dir, '--interval', '1', '--delivery-loop', projectionPath,
    ])
    assert.equal(result.status, 0, result.stderr)
    pid = Number(readFileSync(pidfile, 'utf8').trim())
    assert.ok(alive(pid), `watcher ${pid} is not alive`)
    await delay(1_300)
    const snapshot = JSON.parse(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'))
    assert.equal(snapshot.schema_version, 2)
    assert.equal(snapshot.delivery_loop.experiment.experiment_id, 'pilot-1')
  } finally {
    if (pid) await stopWatcher(pid, pidfile)
  }
})

test('ensure rejects watcher mode or delivery-loop path mismatches before publishing', async () => {
  const v1Dir = repo()
  const v1Pidfile = join(v1Dir, '.tmux-teams', 'pulse-watch.pid')
  let v1Pid = null
  try {
    const started = run(['ensure', v1Dir, '--interval', '60'])
    assert.equal(started.status, 0, started.stderr)
    v1Pid = Number(readFileSync(v1Pidfile, 'utf8').trim())
    const before = readFileSync(join(v1Dir, '.tmux-teams', 'pulse.json'), 'utf8')
    const cssBefore = readFileSync(fontCssPath(v1Dir), 'utf8')
    const mismatch = run([
      'ensure', v1Dir, '--interval', '60', '--delivery-loop', writeProjection(v1Dir),
    ])
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /watcher mode\/input mismatch/)
    assert.equal(readFileSync(join(v1Dir, '.tmux-teams', 'pulse.json'), 'utf8'), before)
    assert.equal(readFileSync(fontCssPath(v1Dir), 'utf8'), cssBefore)
  } finally {
    if (v1Pid) await stopWatcher(v1Pid, v1Pidfile)
  }

  const v2Dir = repo()
  const v2Pidfile = join(v2Dir, '.tmux-teams', 'pulse-watch.pid')
  let v2Pid = null
  try {
    const firstPath = writeProjection(v2Dir)
    const started = run([
      'ensure', v2Dir, '--interval', '60', '--delivery-loop', firstPath,
    ])
    assert.equal(started.status, 0, started.stderr)
    v2Pid = Number(readFileSync(v2Pidfile, 'utf8').trim())
    const before = readFileSync(join(v2Dir, '.tmux-teams', 'pulse.json'), 'utf8')
    const cssBefore = readFileSync(fontCssPath(v2Dir), 'utf8')
    const secondProjection = projection()
    secondProjection.experiment.experiment_id = 'pilot-2'
    const secondPath = join(v2Dir, 'other-projection.json')
    writeFileSync(secondPath, `${JSON.stringify(secondProjection, null, 2)}\n`)
    const mismatch = run([
      'ensure', v2Dir, '--interval', '60', '--delivery-loop', secondPath,
    ])
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /watcher mode\/input mismatch/)
    assert.equal(readFileSync(join(v2Dir, '.tmux-teams', 'pulse.json'), 'utf8'), before)
    assert.equal(readFileSync(fontCssPath(v2Dir), 'utf8'), cssBefore)
  } finally {
    if (v2Pid) await stopWatcher(v2Pid, v2Pidfile)
  }
})
