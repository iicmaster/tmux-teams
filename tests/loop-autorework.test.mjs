// loop-autorework.test.mjs — an audit that flags concern admits a rework token.
//
// An audited concern used to close the route and leave the correction to a
// person. The loop now admits a rework token carrying the audit's findings, so
// the delivery gets corrected without a human touching it. These lock that:
// the rework token lands with the findings, and it is admitted at most once.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendEvent } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-writer.mjs'
import { tick } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const MODELS = { dispatcher: 'inherit-account-default', worker: 'inherit-account-default', evaluator: 'inherit-account-default' }

const team = (id) => ({
  team_id: id,
  name: id[0].toUpperCase() + id.slice(1),
  dispatcher_id: `${id}_dispatcher`,
  worker_ids: [`${id}_worker`],
  evaluator_id: `${id}_evaluator`,
  models: { ...MODELS },
})

// The controller sits on the control team as its one worker (the front-door
// pattern), which is what makes controller_team resolve — and what the
// auto-rework needs to know where to admit the rework token.
const CONTROL = {
  team_id: 'control',
  name: 'Control',
  dispatcher_id: 'intake',
  worker_ids: ['rework_pm'],
  evaluator_id: 'audit',
  models: { ...MODELS },
}

const GRAPH = {
  project_id: 'loop-autorework',
  outer_controller_id: 'rework_pm',
  outer_controller_model: 'inherit-account-default',
  teams: [CONTROL, team('build'), team('verify')],
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'verify'] }],
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'loop-autorework-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'team-briefs'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams', 'graph.json'), JSON.stringify(GRAPH, null, 2))
  for (const entry of GRAPH.teams) {
    writeFileSync(join(dir, '.tmux-teams', 'team-briefs', `${entry.team_id}.md`), `# ${entry.name}\n\nDo the work.\n`)
  }
  return dir
}

const custody = (dir, token) => {
  const path = join(dir, '.tmux-teams', 'work-items', `${token}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('an audit concern admits a rework token carrying the findings, at most once', () => {
  const dir = makeRepo()
  let legs = 0

  // The audit is forced to flag concern; every other leg accepts/passes so the
  // route reaches the audit cleanly.
  const spawnLeg = (repo, { workItem, role, agentId }, briefPath) => {
    const taskId = `${workItem || 'board'}-${role}-${legs += 1}`
    const brief = briefPath && existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : ''
    const say = (event, extra) => {
      const result = appendEvent(repo, {
        event, work_item: workItem, workflow: 'feature', agent_id: agentId, task_id: taskId, ...extra,
      }, { actor: `agent:${agentId}` })
      assert.ok(result.ok, `writer refused ${event} for ${workItem}: ${result.code} ${result.detail}`)
    }
    if (workItem) say('assigned', { dispatch_id: `d-${legs}` })
    const isAudit = role === 'pm' && /this is the audit job/.test(brief)
    const outbox = isAudit
      ? `Read the board.\n\nVERDICT: concern\nREASON: the delivery is missing its proof\n`
      : role === 'dispatcher' ? `Checked.\n\nVERDICT: accept\nREASON: ok\n`
      : role === 'evaluator' ? `Reviewed.\n\nVERDICT: pass\nREASON: ok\n`
      : role === 'pm' ? `Read the board.\n\nVERDICT: resume\nREASON: ok\n`
      : 'Did the work.\n'
    writeFileSync(join(repo, '.mailbox-out', taskId), outbox)
    if (workItem) say('delivered', { terminal: 'done', timed_out: false, evidence_present: true })
    return taskId
  }

  const seeded = appendEvent(dir, {
    event: 'opened', work_item: 'gamma', workflow: 'feature',
    agent_id: 'intake', to_team: 'control', reason: 'autorework seed',
  }, { actor: 'human:replay' })
  assert.ok(seeded.ok, `could not open gamma: ${seeded.detail}`)

  const runTick = () => {
    const real = console.log
    console.log = () => {}
    try {
      const result = tick(dir, { apply: true, scratchDir: join(dir, 'scratch'), spawnLeg })
      assert.ok(result.ok, `tick refused: ${result.reason}`)
    } finally { console.log = real }
  }

  for (let round = 0; round < 60; round += 1) {
    if (custody(dir, 'gamma').at(-1)?.event === 'audited') break
    runTick()
  }

  const audited = custody(dir, 'gamma').find((e) => e.event === 'audited')
  assert.ok(audited, 'the route reached the audit')
  assert.equal(audited.verdict, 'concern')

  // The rework token was admitted carrying the audit's findings.
  const opened = custody(dir, 'gamma-fix').find((e) => e.event === 'opened')
  assert.ok(opened, 'the rework token gamma-fix was admitted')
  assert.match(opened.reason, /the delivery is missing its proof/)
  const requestPath = join(dir, '.tmux-teams', 'work-items', 'gamma-fix.md')
  assert.ok(existsSync(requestPath), 'the rework request file exists')
  assert.match(readFileSync(requestPath, 'utf8'), /the delivery is missing its proof/)

  // Idempotent: further ticks do not admit gamma a second time.
  runTick()
  runTick()
  const gammaFixOpens = custody(dir, 'gamma-fix').filter((e) => e.event === 'opened').length
  assert.equal(gammaFixOpens, 1, 'gamma-fix admitted exactly once')
})
