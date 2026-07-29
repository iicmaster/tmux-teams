// loop-smoke.test.mjs — one real ACP route through the delivery loop.
//
// The replay test deliberately replaces transport so it can explore many legal
// choices quickly. This test has the opposite job: leave runner dispatch real,
// let it fork the real companion, and point that companion at the deterministic
// ACP fixture. The assertions are on custody and projections, not page markup.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readWorkItems } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { activityByAgent, readWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'
import { stateOf, readBoard } from '../plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs'
import { validateWorkItems } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'
import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'
import { projectLivenessEvidence } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const team = (id) => ({
  team_id: id,
  name: id === 'build' ? 'Build' : 'Verify',
  dispatcher_id: `${id}_dispatcher`,
  worker_ids: [`${id}_worker`],
  evaluator_id: `${id}_evaluator`,
  models: {
    dispatcher: 'inherit-account-default',
    worker: 'inherit-account-default',
    evaluator: 'inherit-account-default',
  },
})

const GRAPH = {
  project_id: 'loop-smoke',
  outer_controller_id: 'smoke_pm',
  outer_controller_model: 'inherit-account-default',
  teams: [team('build'), team('verify')],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['build', 'verify'] }],
}

const LOOP_VERDICTS = JSON.stringify({
  build_dispatcher: 'accept',
  build_evaluator: 'pass',
  verify_dispatcher: 'accept',
  verify_evaluator: 'pass',
  smoke_pm: 'accept',
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'tmux-teams-loop-smoke-'))
  dirs.push(repo)
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(repo, '.tmux-teams', 'team-briefs'), { recursive: true })
  mkdirSync(join(repo, '.mailbox-out'), { recursive: true })
  writeFileSync(join(repo, '.tmux-teams', 'graph.json'), `${JSON.stringify(GRAPH, null, 2)}\n`)
  for (const entry of GRAPH.teams) {
    writeFileSync(join(repo, '.tmux-teams', 'team-briefs', `${entry.team_id}.md`),
      `# ${entry.name}\n\nComplete the smoke route.\n`)
  }
  writeFileSync(join(repo, '.tmux-teams', 'work-items', 'route.jsonl'), '')
  writeFileSync(join(repo, '.tmux-teams', 'work-items', 'route.md'), 'Carry this deterministic smoke request through both teams.\n')
  const opened = appendEvent(repo, {
    at: new Date().toISOString(),
    event: 'opened',
    work_item: 'route',
    workflow: 'feature',
    agent_id: 'build_dispatcher',
    to_team: 'build',
    reason: 'smoke route admission',
  }, { actor: 'human:loop-smoke' })
  assert.ok(opened.ok, `could not seed the opened event: ${opened.code} ${opened.detail}`)
  return repo
}

function ledger(repo) {
  const path = join(repo, '.tmux-teams', 'work-items', 'route.jsonl')
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function outboxIsTerminal(repo, taskId) {
  const path = join(repo, '.mailbox-out', taskId)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const last = readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
    return last === `TEAM_DONE ${taskId}`
  } catch {
    return false
  }
}

function livenessIsCompleted(repo, taskId) {
  try {
    return JSON.parse(readFileSync(join(repo, '.tmux-teams', 'liveness', `${taskId}.json`), 'utf8')).liveness_state === 'completed'
  } catch {
    return false
  }
}

async function waitFor(condition, description, repo) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(15)
  }
  const events = ledger(repo).map((entry) => entry.event).join(' -> ')
  throw new Error(`${description} did not settle within 5s (ledger: ${events || 'empty'})`)
}

async function settleStarted(repo, started) {
  for (const leg of started) {
    await waitFor(() => outboxIsTerminal(repo, leg.task_id), `outbox for ${leg.task_id}`, repo)
    await waitFor(() => livenessIsCompleted(repo, leg.task_id),
      `terminal liveness snapshot for ${leg.task_id}`, repo)
    if (leg.work_item) {
      await waitFor(() => ledger(repo).some((entry) =>
        entry.event === 'delivered' && entry.task_id === leg.task_id),
      `delivered custody for ${leg.task_id}`, repo)
    }
  }
}

function livenessProjection(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return projectLivenessEvidence({
    schema_version: raw.schema_version,
    task_id: raw.task_id,
    dispatch_id: raw.dispatch_id,
    agent_id: raw.agent_id,
    observed_at: raw.observed_at,
    liveness_state: raw.liveness_state,
    last_protocol_activity_at: raw.last_protocol_activity_at,
    last_meaningful_progress_at: raw.last_meaningful_progress_at,
    termination_reason: raw.termination_reason,
    active_tools: raw.active_tools,
    tools: raw.tools,
    stall_history: raw.stall_history,
  })
}

function activityTotal(row) {
  return Object.values(row ?? {}).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
}

test('a real ACP route reaches audit and leaves coherent ledger, snapshot, and projection evidence', async () => {
  const repo = makeRepo()
  const inherited = Object.fromEntries([
    'ACP_AGENT_ID', 'ACP_CMD', 'ACP_EXPECT_MODEL', 'ACP_EXPECT_REASONING_EFFORT',
    'ACP_CANCEL_GRACE_MS', 'ACP_HARD_TIMEOUT_SEC', 'ACP_KMS_AUTO', 'ACP_PROCESS_KILL_GRACE_MS', 'ACP_RESUME', 'ACP_SESSION_OPERATION',
    'ACP_SESSION_RECEIPT_REQUIRED', 'ACP_STALL_POLICY', 'ECC_GATEGUARD', 'INITIAL_AGENT_MODE',
    'MOCK_EVIDENCE', 'MOCK_LOOP_VERDICTS', 'MOCK_SCENARIO', 'MOCK_TERMINAL', 'TMUX_TEAMS_PHASE',
  ].map((key) => [key, process.env[key]]))

  try {
    for (const key of Object.keys(inherited)) delete process.env[key]
    Object.assign(process.env, {
      ACP_CMD: `${process.execPath} ${MOCK}`,
      ACP_CANCEL_GRACE_MS: '100',
      ACP_HARD_TIMEOUT_SEC: '2',
      ACP_PROCESS_KILL_GRACE_MS: '100',
      ACP_STALL_POLICY: 'cancel',
      ECC_GATEGUARD: 'off',
      MOCK_EVIDENCE: '1',
      MOCK_LOOP_VERDICTS: LOOP_VERDICTS,
    })

    const started = []
    for (let attempt = 0; attempt < 12 && ledger(repo).at(-1)?.event !== 'audited'; attempt += 1) {
      // No spawnLeg override: this calls loop-runner's real detached dispatcher,
      // which forks acp-companion.mjs. ACP_CMD is the only test seam.
      const result = tick(repo, { apply: true, tickSec: 1, scratchDir: join(repo, 'runner-briefs') })
      assert.ok(result.ok, `tick ${attempt + 1} refused: ${result.reason}`)
      started.push(...result.started)
      await settleStarted(repo, result.started)
    }

    const history = ledger(repo)
    assert.equal(history.at(-1)?.event, 'audited',
      `the healthy two-team route did not reach its terminal audit: ${history.map((entry) => entry.event).join(' -> ')}`)
    assert.equal(history.some((entry) => entry.event === 'escalated'), false,
      'a passing route unexpectedly entered the outer-controller unstick path')
    assert.deepEqual(history.filter((entry) => entry.event === 'intake').map((entry) => entry.agent_id),
      ['build_dispatcher', 'verify_dispatcher'])
    assert.deepEqual(history.filter((entry) => entry.event === 'reviewed').map((entry) => entry.verdict), ['pass', 'pass'])
    assert.equal(history.filter((entry) => entry.event === 'assigned').length, 6,
      'both teams should dispatch intake, worker, and evaluator legs')
    assert.equal(history.filter((entry) => entry.event === 'delivered').length, 6,
      'every assigned team leg should be closed by acp-companion')
    assert.equal(history.filter((entry) => entry.event === 'audit_requested').length, 1)
    assert.equal(history.filter((entry) => entry.event === 'audited').at(-1)?.verdict, 'accept')

    const validation = validateWorkItems(repo)
    assert.ok(validation.ok, JSON.stringify(validation.files.map(({ path, problems }) => ({ path, problems }))))

    assert.equal(started.length, 7, 'the route should use six team legs and one audit leg')
    for (const leg of started) {
      assert.ok(outboxIsTerminal(repo, leg.task_id), `${leg.task_id} did not preserve a flat terminal outbox`)
      const liveness = livenessProjection(join(repo, '.tmux-teams', 'liveness', `${leg.task_id}.json`))
      assert.equal(liveness.liveness_state, 'completed', `${leg.task_id} snapshot did not report completion`)
    }

    const published = spawnSync(process.execPath, [PULSE, 'json', repo], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ECC_GATEGUARD: 'off' },
    })
    assert.equal(published.status, 0, `pulse json failed:\n${published.stderr}`)
    const snapshot = JSON.parse(readFileSync(join(repo, '.tmux-teams', 'pulse.json'), 'utf8'))
    assert.deepEqual(JSON.parse(published.stdout), snapshot, 'pulse json must publish the snapshot it reports')
    for (const name of ['pulse.html', 'graph.html', 'kanban.html', 'pulse-current.json']) {
      assert.ok(existsSync(join(repo, '.tmux-teams', name)), `pulse did not render ${name}`)
    }

    const snapshotRuns = [...(snapshot.runs ?? []), ...(snapshot.history?.runs ?? [])]
    for (const leg of started) {
      assert.ok(snapshotRuns.some((run) => run.task_id === leg.task_id),
        `pulse snapshot did not report ACP task ${leg.task_id}`)
    }

    const graph = readWorkflowGraph(repo)
    assert.ok(graph.ok, graph.reason)
    const { items } = readWorkItems(repo)
    for (const entry of history) {
      assert.doesNotMatch(stateOf(graph.value, entry).state, /^Unknown event:/,
        `kanban has no state for ${entry.event}`)
    }
    const board = readBoard(repo, new Date().toISOString())
    assert.ok(board.ok, board.reason)
    assert.equal(board.counts.done, 1, 'the terminal route should occupy the done projection once')

    const activity = activityByAgent(items)
    const activeAgents = new Set(snapshotRuns.map((run) => run.agent_id).filter(Boolean))
    for (const agentId of [
      'build_dispatcher', 'build_worker', 'build_evaluator',
      'verify_dispatcher', 'verify_worker', 'verify_evaluator', 'smoke_pm',
    ]) {
      assert.ok(activeAgents.has(agentId), `pulse did not expose active node ${agentId}`)
      assert.ok(activityTotal(activity.get(agentId)) > 0,
        `${agentId} has snapshot evidence but its graph activity counters are all zero`)
    }
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
