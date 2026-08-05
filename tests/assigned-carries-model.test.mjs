// assigned-carries-model.test.mjs — GitHub #47 phase 2b (contract §3.5.1, §4).
//
// Until a seat could declare a palette, "what model ran leg X" was answered by
// inference: one seat, one model, look it up in the graph. A palette destroys
// that inference for exactly the legs where the answer matters, so `assigned`
// has to say it. This runs the REAL `acp-companion.mjs` against the stub ACP
// agent, because it is the only component that writes `assigned` (§13) — a
// runner-side test using `spawnFn` proves the env was built, never that the
// ledger recorded it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
const COMPANION = join(SCRIPTS, 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')

const WORK_ITEM = 'palette-token'

// One valid `opened` line, so the companion appends onto a history the writer
// will accept rather than being refused for appending to a broken one.
const seedLedger = (cwd) => {
  const dir = join(cwd, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true })
  // Deliberately in the PAST. The writer refuses a non-monotonic append, so a
  // seed stamped "today at 09:00" fails every run before 09:00 UTC — a test
  // that passes by time of day is worse than no test.
  writeFileSync(join(dir, `${WORK_ITEM}.jsonl`), JSON.stringify({
    at: '2026-01-01T09:00:00.000Z', event: 'opened', work_item: WORK_ITEM, workflow: 'feature',
    agent_id: 'build_dispatcher', to_team: 'build', reason: 'entered', actor: 'human:master',
  }) + '\n')
  return join(dir, `${WORK_ITEM}.jsonl`)
}

const readEvents = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

const runCompanion = (agentName, extraEnv) => {
  const cwd = mkdtempSync(join(tmpdir(), 'assigned-model-'))
  const ledger = seedLedger(cwd)
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  // §4 requires `agent_id` and `workflow` on `assigned`; the runner supplies
  // both through the env, and without them the writer refuses the line — which
  // is the correct behaviour and would make this test silently vacuous.
  const env = { ...process.env, ACP_CMD: `${process.execPath} ${MOCK}`, ACP_STALL_POLICY: 'cancel',
    ACP_HARD_TIMEOUT_SEC: '0', ACP_CANCEL_GRACE_MS: '100', ACP_RESUME: '',
    TMUX_TEAMS_WORK_ITEM: WORK_ITEM, TMUX_TEAMS_WORKFLOW: 'feature', ACP_AGENT_ID: 'build_w1',
    ...extraEnv }
  for (const [key, value] of Object.entries(extraEnv)) if (value === null) delete env[key]
  spawnSync('node', [COMPANION, agentName, cwd, 'task-' + agentName, brief, '30'], { cwd, encoding: 'utf8', env })
  return readEvents(ledger).find((entry) => entry.event === 'assigned') ?? null
}

test('assigned records the model this leg was dispatched on, and the lane it went to', () => {
  // `ACP_EXPECT_MODEL`, not `ACP_MODEL`: the latter is a config OVERRIDE the
  // companion demands the adapter advertise, and the stub advertises nothing.
  // Both feed the same `requestedModel` (`acp-companion.mjs:1397-1399`).
  const assigned = runCompanion('mock', { ACP_EXPECT_MODEL: 'entry-2-model' })
  assert.ok(assigned, 'the companion wrote an assigned line')
  // Both halves. A palette may hold one model on two lanes (different buckets,
  // so legal even adjacent), and an alias names different vendors on different
  // lanes — neither field identifies a leg by itself.
  assert.equal(assigned.requested_model, 'entry-2-model')
  assert.equal(assigned.adapter, 'mock')
  // Still a well-formed leg: 2b adds fields, it does not move any.
  assert.equal(assigned.work_item, WORK_ITEM)
  assert.equal(typeof assigned.task_id, 'string')
  assert.equal(typeof assigned.dispatch_id, 'string')
})

test('a seat that pinned no model records null, never a guess', () => {
  // `requested_model` is the REQUEST, written before spawn. A seat riding the
  // account default asked for nothing, and the ledger says nothing — rather
  // than naming whatever the adapter happened to answer with, which at this
  // point in the process has not answered at all.
  const assigned = runCompanion('mock', { ACP_MODEL: null, ACP_EXPECT_MODEL: null })
  assert.ok(assigned, 'the companion wrote an assigned line')
  assert.equal(assigned.requested_model, null)
  assert.equal(assigned.adapter, 'mock')
})
