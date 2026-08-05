// undeclared-graph.test.mjs — GitHub #48.
//
// A repository with no `.tmux-teams/graph.json` used to dispatch NORMALLY,
// against a bundled four-team template whose every seat asks for the
// placeholder model `inherit-account-default`. `readWorkflowGraph` says so in
// `source`, and nothing read that field — so the refusal `graph-setup/SKILL.md`
// promised for its whole life never existed, and the failures arrived one at a
// time at the adapter instead of once, in the operator's face.
//
// The template still LOADS: the pages need something to draw while they explain
// what is missing. What changed is that it is a shape to read, never a loop to
// run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { readWorkflowGraph, renderGraphPage } from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import { renderKanbanPage } from '../plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs'

// A repo with `.tmux-teams/` and a fresh pulse, but deliberately NO graph.json.
const undeclaredRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), 'undeclared-graph-'))
  mkdirSync(join(repo, '.tmux-teams'), { recursive: true })
  writeFileSync(join(repo, '.tmux-teams', 'pulse.json'), JSON.stringify({
    snapshot_id: 'test:1',
    generated_at: new Date().toISOString(),
    scope: { repo_name: 'undeclared' },
    observation: { expires_at: '2099-01-01T00:00:00.000Z', refresh_interval_sec: 20 },
    runs: [],
  }))
  assert.equal(existsSync(join(repo, '.tmux-teams', 'graph.json')), false, 'the fixture must have no declaration')
  return repo
}

test('the bundled template still LOADS — the pages need something to draw', () => {
  const graph = readWorkflowGraph(undeclaredRepo())
  assert.equal(graph.ok, true, 'a missing declaration is not a parse failure')
  assert.equal(graph.source, 'default', 'and it says which shape answered')
})

test('a repository that declared no loop does not get to run one', () => {
  const repo = undeclaredRepo()
  const result = tick(repo, { apply: true, scratchDir: join(repo, 'scratch') })

  assert.equal(result.ok, false, 'the runner must refuse, not dispatch against teams nobody declared')
  assert.match(result.reason, /no team graph declared/)

  // Said where an operator actually looks. `graph-setup`'s own checklist tells
  // them to read this file; before #48 it never mentioned this case at all.
  const beat = JSON.parse(readFileSync(join(repo, '.tmux-teams', 'runner-heartbeat.json'), 'utf8'))
  assert.equal(beat.dispatching, false)
  assert.match(beat.reason, /graph\.json is missing/)
  assert.match(beat.reason, /graph-setup/, 'a refusal names what would change it')
})

test('both pages warn, and not as a label among facts', () => {
  const repo = undeclaredRepo()
  const snapshot = JSON.parse(readFileSync(join(repo, '.tmux-teams', 'pulse.json'), 'utf8'))

  for (const [name, page] of [
    ['graph', renderGraphPage(repo, snapshot)],
    ['kanban', renderKanbanPage(repo, snapshot)],
  ]) {
    assert.match(page, /data-graph-undeclared="1"/, `${name} must carry the undeclared marker`)
    assert.match(page, /has not declared its own loop/, `${name} must say it in words`)
    assert.match(page, /graph-setup/, `${name} must name what fixes it`)
  }
})
