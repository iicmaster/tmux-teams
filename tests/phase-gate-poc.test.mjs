import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runPhaseGatePoc } from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-poc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')

test('POC runs the actual governed ACP path through four phases and publishes Pulse evidence', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'phase-gate-poc-test-')), 'run')
  const output = await runPhaseGatePoc({
    out_dir: out,
    acp_cmd: `${process.execPath} ${MOCK}`,
    time_zone: 'Asia/Bangkok',
    timeout_sec: 15,
  })

  assert.equal(output.result.measurement.status, 'scenario_signal')
  assert.equal(output.result.measurement.measurement_ready, true)
  assert.equal(output.result.measurement.runtime_attention_count, 0)
  assert.equal(output.result.measurement.phase_count, 4)
  assert.equal(output.result.measurement.completed_phase_count, 4)
  assert.equal(output.result.measurement.pm_routine_acceptance_count, 0)
  assert.equal(output.result.measurement.pm_exception_touch_count, 0)
  assert.equal(output.result.measurement.phase_team_worker_verdict_count, 4)
  assert.equal(output.result.measurement.receiver_owned_acceptance_count, 4)
  assert.equal(output.result.measurement.receiver_dispatch_count, 3)
  assert.equal(output.result.measurement.duplicate_dispatch_count, 0)
  assert.equal(output.result.measurement.invalid_qa_dispatch_blocked, true)
  assert.equal(output.result.roi.status, 'ROI_NOT_ESTABLISHED')

  assert.deepEqual(
    output.projection.phase_runs.map(({ phase, state }) => ({ phase, state })),
    [
      { phase: 'Requirement', state: 'completed' },
      { phase: 'Prototype', state: 'completed' },
      { phase: 'Development', state: 'completed' },
      { phase: 'QA', state: 'completed' },
    ],
  )
  assert.equal(output.projection.phase_runs[0].handoff_count, 2)
  assert.equal(output.projection.phase_runs[0].revision_count, 1)
  assert.deepEqual(
    output.projection.phase_gates.map(({ boundary, state }) => ({ boundary, state })),
    [
      { boundary: 'requirement_to_prototype', state: 'rejected' },
      { boundary: 'requirement_to_prototype', state: 'consumed' },
      { boundary: 'prototype_to_development', state: 'consumed' },
      { boundary: 'development_to_qa', state: 'consumed' },
      { boundary: 'qa_to_project_delivery', state: 'accepted' },
    ],
  )
  const qa = output.projection.phase_gates.at(-1)
  assert.equal(qa.receiver_phase, 'ProjectDelivery')
  assert.equal(qa.receiver_dispatch_id, null)
  assert.equal(qa.consumed_at, null)

  const pulse = JSON.parse(readFileSync(output.pulse_json_path, 'utf8'))
  assert.equal(pulse.schema_version, 4)
  assert.deepEqual(pulse.delivery_runtime, output.projection)
  assert.equal(pulse.delivery_runtime.mode, 'observe_only')
  assert.equal(pulse.summary.attention, 0)
  assert.equal(pulse.summary.active, 0)
  assert.equal(pulse.recent_verdicts.length, 4)
  assert.ok(pulse.recent_verdicts.every((row) => row.pm_verdict === 'pass'))
  assert.deepEqual(pulse.unclaimed_control, [])
  const pulseHtml = readFileSync(output.pulse_html_path, 'utf8')
  assert.equal(pulseHtml.includes('เวลาไทย (UTC+7)'), true)
  assert.match(pulseHtml, /<section class="delivery-runtime" aria-labelledby="delivery-runtime-title">/)
  assert.match(pulseHtml, /data-runtime-attention-count="0"/)
  for (const phase of ['Requirement', 'Prototype', 'Development', 'QA']) {
    assert.match(pulseHtml, new RegExp(`data-phase="${phase}" data-state="completed"`))
  }
  assert.match(pulseHtml, /data-boundary="requirement_to_prototype" data-gate-state="rejected" data-attempt-id="poc-attempt-requirement-r1"/)
  assert.match(pulseHtml, /data-boundary="qa_to_project_delivery" data-gate-state="accepted" data-attempt-id="poc-attempt-qa-r1"/)
  assert.match(pulseHtml, /ProjectDelivery เป็นผู้รับปลายทาง/)
  assert.equal(readFileSync(output.loop_graph_path, 'utf8').includes('ProjectDelivery'), true)

  const published = [
    readFileSync(output.pulse_json_path, 'utf8'),
    readFileSync(output.pulse_html_path, 'utf8'),
    readFileSync(output.loop_graph_path, 'utf8'),
  ].join('\n')
  assert.equal(published.includes(output.store_dir), false)
  assert.equal(published.includes(output.repo_root), false)
  assert.equal(published.includes('missing_exception_validation'), false)
})
