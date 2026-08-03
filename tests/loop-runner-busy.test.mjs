// loop-runner-busy.test.mjs — who counts as busy, and on whose word.
//
// GitHub #29: a review worker running the three-model gate for twenty-odd
// minutes was declared lost and replaced, twice on one token. It was never
// silent. The companion's own heartbeat said `tool_running` the whole time and
// pulse republished it on the row; the runner read only `state`, pulse's
// OS-level probe, which needs to miss for exactly one tick to lose a leg.
//
// So these tests are about a second witness, and about not believing it too
// long: a heartbeat older than the zombie window, or one that already said the
// leg ended, must not hold a token open forever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { busyAgents } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'

const NOW = Date.parse('2026-08-03T12:00:00.000Z')
const ZOMBIE_SEC = 180

const dirs = []
// One row, one agent, and the two things that disagree about it: `state` is
// what the process scan saw, `liveness_evidence` is what the companion said.
function repoWith({ state, livenessState, observedSecAgo }) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-busy-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams'), { recursive: true })
  const evidence = livenessState === null ? null : {
    schema_version: 'acp-liveness.v1',
    task_id: 't-1',
    dispatch_id: 'd-1',
    agent_id: 'review_w1',
    observed_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    liveness_state: livenessState,
    last_protocol_activity_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    last_meaningful_progress_at: new Date(NOW - observedSecAgo * 1000).toISOString(),
    termination_reason: null,
    active_tools: [],
    tools: {},
    stall_history: [],
  }
  writeFileSync(join(dir, '.tmux-teams', 'pulse.json'), JSON.stringify({
    generated_at: new Date(NOW - 5000).toISOString(),
    runs: [{
      agent_id: 'review_w1',
      task_id: 't-1',
      dispatch_id: 'd-1',
      started_at: new Date(NOW - 1500 * 1000).toISOString(),
      state,
      liveness_evidence: evidence,
    }],
  }))
  return dir
}

test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

test('a companion the process scan missed is still busy while its own heartbeat is fresh', () => {
  // The incident: `died` is what one ps sweep concluded about a worker that was
  // sitting inside a twenty-minute tool call. The heartbeat two seconds old is
  // the worker itself saying otherwise, and it is the one that was there.
  const dir = repoWith({ state: 'died', livenessState: 'tool_running', observedSecAgo: 2 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), true,
    'a live worker was free to be replaced')
})

test('a heartbeat older than the zombie window does not hold the leg open', () => {
  // Pulse keeps a liveness file readable for hours, which is right for a page
  // and far too long here. A companion that died without saying so must still
  // time out, or the token waits on a process that is gone.
  const dir = repoWith({ state: 'died', livenessState: 'tool_running', observedSecAgo: ZOMBIE_SEC + 1 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), false,
    'a stale heartbeat kept a dead leg busy')
})

test('a heartbeat that already said the leg ended does not hold it open', () => {
  // `completed` is the companion's last word. Counting it as busy would wedge a
  // token whose `delivered` never landed — held forever by evidence of finishing.
  const dir = repoWith({ state: 'died', livenessState: 'completed', observedSecAgo: 1 })
  assert.equal(busyAgents(dir, NOW).busy.has('review_w1'), false,
    'a finished leg was counted as still working')
})

test('a row with no liveness evidence still answers from the process scan alone', () => {
  // The ordinary case, and the one that must not regress: nothing the companion
  // wrote, so `state` is the whole answer — both ways.
  const running = repoWith({ state: 'running', livenessState: null, observedSecAgo: 0 })
  assert.equal(busyAgents(running, NOW).busy.has('review_w1'), true)
  const died = repoWith({ state: 'died', livenessState: null, observedSecAgo: 0 })
  assert.equal(busyAgents(died, NOW).busy.has('review_w1'), false)
})
