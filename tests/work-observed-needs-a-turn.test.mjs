// work-observed-needs-a-turn.test.mjs — GitHub #45 part 2 / #47, found by the
// v0.15.0 release review (gpt-5.6-luna, anti-consensus club) and reproduced
// before it was believed.
//
// `work_observed` answers ONE question: did this leg ever reach the model? The
// runner keys two separate decisions on it — whether the leg spends a worker
// attempt (`attemptsBy`) and whether a palette seat rotates to its next
// candidate (`missesBy`). `receipt_commit` was counted as work and fires during
// session SETUP, before `session/prompt` is ever sent, so a leg that hung or was
// rate-limited without a byte coming back reported `work_observed: true` and
// defeated both.
//
// Every existing `work_observed` test builds a ledger fixture by hand. This one
// runs the real companion against a mock that never answers the prompt, and
// reads what actually landed on disk — the only way to catch a producer that
// sets the flag at the wrong moment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')

const WORK_ITEM = 'stalled-leg'

const runHangingLeg = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'work-observed-'))
  const dir = join(cwd, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true })
  const ledger = join(dir, `${WORK_ITEM}.jsonl`)
  // Past-dated: the writer refuses a non-monotonic append, and a seed stamped
  // "today" would make this pass or fail by time of day.
  writeFileSync(ledger, JSON.stringify({
    at: '2026-01-01T09:00:00.000Z', event: 'opened', work_item: WORK_ITEM, workflow: 'feature',
    agent_id: 'build_dispatcher', to_team: 'build', reason: 'entered', actor: 'human:master',
  }) + '\n')
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')

  spawnSync('node', [COMPANION, 'mock', cwd, 'task-hang', brief, '3'], {
    cwd, encoding: 'utf8', timeout: 90_000,
    env: {
      // Ambient ACP_* is stripped rather than spread: a caller who had just run
      // a dispatch by hand carries ACP_SPAWN_NONCE and friends, and they reach
      // the producer snapshot this test reads back.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ACP_'))),
      ACP_CMD: `${process.execPath} ${MOCK}`,
      // The adapter completes initialize and session/new — so the receipt IS
      // committed — and then never answers session/prompt.
      MOCK_HANG: '1',
      ACP_STALL_POLICY: 'cancel',
      ACP_HARD_TIMEOUT_SEC: '0',
      ACP_CANCEL_GRACE_MS: '100',
      ACP_RESUME: '',
      TMUX_TEAMS_WORK_ITEM: WORK_ITEM,
      TMUX_TEAMS_WORKFLOW: 'feature',
      ACP_AGENT_ID: 'build_w1',
    },
  })

  return readFileSync(ledger, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'delivered') ?? null
}

test('a leg whose prompt never round-tripped reports work_observed false, however durable its receipt', () => {
  const delivered = runHangingLeg()
  assert.ok(delivered, 'the companion wrote a delivered line')
  // The assertion, before any words about it: a committed receipt is setup
  // evidence and must not stand in for a model that never answered.
  assert.equal(delivered.work_observed, false)
  // Guard the guard: if the leg somehow succeeded, `work_observed: false` would
  // be true for the wrong reason and this test would certify nothing.
  assert.notEqual(delivered.terminal, 'done', 'the fixture must actually stall, or it proves nothing')
})
