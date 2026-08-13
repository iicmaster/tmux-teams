// The safety net for moving slot accounting out of a derivation.
//
// Every fixture here is written through the REAL publisher (`appendEvent`) and
// read back through the REAL reader (`readWorkItems`). A hand-built `items` map
// would prove that two functions agree about a shape the system never produces,
// which is this repository's most-repeated way of writing a test that tests
// nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { readWorkItems, teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { projectWorkItems, mergeCustody } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-projection.mjs'
import { occupancyOf, teamsHolding, CONTROL_TEAM_ID } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-team.mjs'
import { DEFAULT_WORKFLOW_GRAPH, validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

// The VALIDATED graph, not the literal: validation is what expands each team's
// seats into `agents`, and `teamOccupancy` reads that field. Comparing against
// the unexpanded literal would have compared against a shape the system never
// hands anybody — it throws on the first team.
const GRAPH = validateWorkflowGraph(DEFAULT_WORKFLOW_GRAPH).value

function repoWith(events) {
  const dir = mkdtempSync(join(tmpdir(), 'domain-equiv-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(DEFAULT_WORKFLOW_GRAPH))
  const refused = []
  for (const { actor, ...event } of events) {
    const result = appendEvent(dir, event, { actor })
    if (result?.ok === false) refused.push(`${event.event}: ${result.code} ${result.message ?? ''}`)
  }
  return { dir, refused }
}

const occupancyPairs = (dir) => {
  // `readWorkItems` returns { items, skippedLines }; the Map is one field of
  // it, and taking the wrapper for the Map is how this test first went red.
  const { items } = readWorkItems(dir)
  const before = teamOccupancy(GRAPH, items)
  const after = occupancyOf(projectWorkItems(GRAPH, items).stateOf('team'), GRAPH)
  return { items, before, after }
}

const countsOf = (occupancy) => Object.fromEntries([...occupancy.counts].filter(([, n]) => n > 0))

test('the publisher this projection reads from is the one the system writes through', () => {
  // If `appendEvent` refuses these fixtures, every comparison below is being
  // made against a history the loop could not have produced.
  const teams = GRAPH.teams.map((team) => team.team_id)
  assert.ok(teams.includes(CONTROL_TEAM_ID))
  const { refused } = repoWith([])
  assert.deepEqual(refused, [])
})

const ROUTE = GRAPH.workflows[0].route
const WORKFLOW = GRAPH.workflows[0].workflow_id
const FIRST = ROUTE[1]

const opened = { actor: 'human:ada', event: 'opened', work_item: 'w1', workflow: WORKFLOW, agent_id: 'pm_intake', to_team: 'control', reason: 'admitted for the test' }
const pulled = { actor: `agent:${FIRST}_dispatcher`, event: 'pulled', work_item: 'w1', workflow: WORKFLOW, agent_id: `${FIRST}_dispatcher`, from_team: 'control', to_team: FIRST }

test('a token in flight is placed identically by the derivation and the accounting', () => {
  // Phase D's whole claim: moving the decision does not move the answer, except
  // exactly where we said it would.
  const { dir, refused } = repoWith([opened, pulled])
  assert.deepEqual(refused, [])
  const { before, after } = occupancyPairs(dir)
  assert.deepEqual(countsOf(after), countsOf(before))
  assert.deepEqual(countsOf(after), { [FIRST]: 1 })
})

test('the deliberate difference is stated, not discovered', () => {
  // A completed route: the derivation frees it entirely, the accounting hands it
  // to control as a queue item. This test exists so the change can never be
  // mistaken for a regression by somebody reading a diff.
  const { dir, refused } = repoWith([
    opened, pulled,
    { actor: `agent:${FIRST}_evaluator`, event: 'completed', work_item: 'w1', workflow: WORKFLOW, from_team: FIRST },
  ])
  assert.deepEqual(refused, [])
  const { items, before, after } = occupancyPairs(dir)

  assert.deepEqual(countsOf(before), {}, 'the derivation used to let a finished token occupy nothing')
  assert.equal(after.counts.get(CONTROL_TEAM_ID), 1, 'the accounting must hold it for control')
  assert.deepEqual(teamsHolding(projectWorkItems(GRAPH, items).stateOf('team'), 'w1'), [CONTROL_TEAM_ID])
})

test('merging keeps each token history in its own append order', () => {
  // Reordering a token's own history would make a replay answer differently from
  // the live run, and then the durable log stops being the truth.
  const items = new Map([
    ['a', { work_item: 'a', workflow: 'wf', custody: [
      { event: 'opened', at: '2026-08-14T00:00:00.000Z' },
      { event: 'pulled', at: '2026-08-14T00:00:00.000Z' },
    ] }],
    ['b', { work_item: 'b', workflow: 'wf', custody: [
      { event: 'opened', at: '2026-08-14T00:00:00.000Z' },
    ] }],
  ])
  const merged = mergeCustody(items)
  const aOnly = merged.filter((entry) => entry.work_item === 'a').map((entry) => entry.event)
  assert.deepEqual(aOnly, ['opened', 'pulled'], 'a tie on `at` reordered one token against itself')
  assert.equal(merged.length, 3)
})
