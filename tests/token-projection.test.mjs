// token-projection.test.mjs — pins the shape of the ONE per-token projection
// (D2), and proves each field is a real fold of custody, not a guess:
//   * `current`/`releasing` delegate to the same placement rule contract §6
//     already centralised (dispatch-facts.mjs's currentEntry/RELEASING_EVENTS)
//     — never a second implementation of "which leg is current".
//   * `placed_at`/`pulled_from` are the questions kanban.mjs and graph.mjs
//     folded inline before this module existed.
//   * `requester`/`questions`/`withdrawn_by_runner` are the questions
//     intake-stats.mjs folds, expressed per token instead of pre-aggregated.
// No fixture here touches disk: `projectToken` takes an already-read item,
// so a plain in-memory custody array is a faithful, fast input.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectToken } from '../plugins/tmux-teams/skills/tmux-teams/scripts/token-projection.mjs'
import { currentEntry, RELEASING_EVENTS } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'

const itemOf = (custody, extra = {}) => ({
  work_item: 'tok-1', workflow: 'feature', custody, lead_sec: 120, legs: 1, ...extra,
})

test('current delegates to currentEntry — never a second "which leg is current"', () => {
  const custody = [
    { at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d' },
    { at: '2026-08-01T09:05:00.000Z', event: 'pulled', work_item: 'tok-1', agent_id: 'build_d', from_team: 'pm', to_team: 'build' },
    { at: '2026-08-01T09:10:00.000Z', event: 'assigned', work_item: 'tok-1', agent_id: 'build_w1', task_id: 't-1', dispatch_id: 't-1-dispatch' },
  ]
  const projected = projectToken(itemOf(custody))
  assert.deepEqual(projected.current, currentEntry(custody),
    'the projection must hand back exactly what the sanctioned placement read returns, byte for byte')
  assert.equal(projected.current.event, 'assigned')
})

test('releasing is true exactly on the contract §6 RELEASING_EVENTS set, false otherwise', () => {
  for (const event of RELEASING_EVENTS) {
    const custody = [{ at: '2026-08-01T09:00:00.000Z', event, work_item: 'tok-1', agent_id: 'a' }]
    assert.equal(projectToken(itemOf(custody)).releasing, true, `${event} must read as releasing`)
  }
  const held = [{ at: '2026-08-01T09:00:00.000Z', event: 'assigned', work_item: 'tok-1', agent_id: 'a', task_id: 't' }]
  assert.equal(projectToken(itemOf(held)).releasing, false)
})

test('placed_at is the newest opened/pulled/returned line, not the current entry', () => {
  const custody = [
    { at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d' },
    { at: '2026-08-01T09:05:00.000Z', event: 'pulled', work_item: 'tok-1', agent_id: 'build_d', from_team: 'pm', to_team: 'build' },
    { at: '2026-08-01T09:10:00.000Z', event: 'assigned', work_item: 'tok-1', agent_id: 'build_w1', task_id: 't-1' },
    { at: '2026-08-01T09:20:00.000Z', event: 'delivered', work_item: 'tok-1', agent_id: 'build_w1', task_id: 't-1', terminal: 'done' },
  ]
  const projected = projectToken(itemOf(custody))
  assert.equal(projected.placed_at.event, 'pulled')
  assert.equal(projected.placed_at.at, '2026-08-01T09:05:00.000Z')
})

test('placed_at falls back to the first custody line when the token was never pulled or returned', () => {
  const custody = [
    { at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d' },
    { at: '2026-08-01T09:10:00.000Z', event: 'intake', work_item: 'tok-1', agent_id: 'pm_d', verdict: 'accept' },
  ]
  const projected = projectToken(itemOf(custody))
  assert.equal(projected.placed_at.event, 'opened')
})

test('pulled_from resolves the newest pulled line\'s origin, and is null when the token was only opened', () => {
  const pulledTwice = [
    { at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d' },
    { at: '2026-08-01T09:05:00.000Z', event: 'pulled', work_item: 'tok-1', agent_id: 'build_d', from_team: 'pm', to_team: 'build' },
    { at: '2026-08-01T09:30:00.000Z', event: 'pulled', work_item: 'tok-1', agent_id: 'test_d', from_team: 'build', to_team: 'test' },
  ]
  assert.equal(projectToken(itemOf(pulledTwice)).pulled_from, 'build')

  const openedOnly = [{ at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d' }]
  assert.equal(projectToken(itemOf(openedOnly)).pulled_from, null)
})

test('requester reads opened.actor, and is null when the token has no opened line', () => {
  const withOpen = [{ at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d', actor: 'human:master' }]
  assert.equal(projectToken(itemOf(withOpen)).requester, 'human:master')

  const withoutOpen = [{ at: '2026-08-01T09:00:00.000Z', event: 'assigned', work_item: 'tok-1', agent_id: 'a', task_id: 't' }]
  assert.equal(projectToken(itemOf(withoutOpen)).requester, null)
})

test('questions pairs each questioned with its answered, per asking — not collapsed by category', () => {
  const custody = [
    { at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d', actor: 'human:master' },
    { at: '2026-08-01T09:01:00.000Z', event: 'questioned', work_item: 'tok-1', agent_id: 'pm_d', categories: ['security'] },
    { at: '2026-08-01T09:06:00.000Z', event: 'answered', work_item: 'tok-1', agent_id: 'pm_d' },
    { at: '2026-08-01T09:06:30.000Z', event: 'questioned', work_item: 'tok-1', agent_id: 'pm_d', categories: ['security', 'scope'] },
    { at: '2026-08-01T09:10:30.000Z', event: 'answered', work_item: 'tok-1', agent_id: 'pm_d' },
  ]
  const { questions } = projectToken(itemOf(custody))
  assert.equal(questions.length, 2)
  assert.equal(questions[0].answered_seconds, 300)
  assert.deepEqual(questions[0].categories, ['security'])
  assert.equal(questions[1].answered_seconds, 240)
  assert.deepEqual(questions[1].categories, ['security', 'scope'])
})

test('an unanswered question leaves answered_seconds null rather than 0 — unmeasured is not zero', () => {
  const custody = [
    { at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d', actor: 'human:master' },
    { at: '2026-08-01T09:01:00.000Z', event: 'questioned', work_item: 'tok-1', agent_id: 'pm_d', categories: ['security'] },
  ]
  const { questions } = projectToken(itemOf(custody))
  assert.equal(questions.length, 1)
  assert.equal(questions[0].answered_seconds, null)
})

test('a backwards (invalid) answered gap is not folded in as a real duration', () => {
  const custody = [
    { at: '2026-08-01T09:10:00.000Z', event: 'questioned', work_item: 'tok-1', agent_id: 'pm_d', categories: ['security'] },
    { at: '2026-08-01T09:00:00.000Z', event: 'answered', work_item: 'tok-1', agent_id: 'pm_d' },
  ]
  const { questions } = projectToken(itemOf(custody))
  assert.equal(questions[0].answered_seconds, null)
})

test('withdrawn_by_runner is true only for the runner\'s own abandoned, not the controller\'s abandon verdict', () => {
  const runnerWithdrew = [
    { at: '2026-08-01T09:00:00.000Z', event: 'questioned', work_item: 'tok-1', agent_id: 'pm_d', categories: ['security'] },
    { at: '2026-08-01T09:20:00.000Z', event: 'abandoned', work_item: 'tok-1', agent_id: 'pm_d', actor: 'agent:runner' },
  ]
  assert.equal(projectToken(itemOf(runnerWithdrew)).withdrawn_by_runner, true)

  const controllerAbandoned = [
    { at: '2026-08-01T09:00:00.000Z', event: 'escalated', work_item: 'tok-1', agent_id: 'pm_w', task_id: 'ct-1' },
    { at: '2026-08-01T09:20:00.000Z', event: 'abandoned', work_item: 'tok-1', agent_id: 'pm_w', actor: 'agent:pm_w' },
  ]
  assert.equal(projectToken(itemOf(controllerAbandoned)).withdrawn_by_runner, false)
})

test('lead_sec and legs pass through the item unchanged — this module never recomputes them', () => {
  const projected = projectToken(itemOf(
    [{ at: '2026-08-01T09:00:00.000Z', event: 'opened', work_item: 'tok-1', agent_id: 'pm_d' }],
    { lead_sec: 4321, legs: 3 },
  ))
  assert.equal(projected.lead_sec, 4321)
  assert.equal(projected.legs, 3)
})

test('an item with no custody at all projects to empty/null facts rather than throwing', () => {
  const projected = projectToken({ work_item: 'tok-1', workflow: '', custody: [], lead_sec: null, legs: 0 })
  assert.equal(projected.current, undefined)
  assert.equal(projected.releasing, false)
  assert.equal(projected.placed_at, null)
  assert.equal(projected.pulled_from, null)
  assert.equal(projected.requester, null)
  assert.deepEqual(projected.questions, [])
  assert.equal(projected.withdrawn_by_runner, false)
})

test('work_item and workflow pass through, defaulting sanely when absent', () => {
  const projected = projectToken({ custody: [] })
  assert.equal(projected.work_item, '')
  assert.equal(projected.workflow, '')
})
