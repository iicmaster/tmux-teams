// dispatch-identity-join.test.mjs — contract §3.5.1 / AC136: what a leg ASKED
// for and what ANSWERED it are joined, and can now contradict each other.
//
// §14.1 stated the gap in its own words: "`assigned` records the request (phase
// 2b), and `identity_status: matched` on the receipt verifies the answer, but
// nothing joins the two — a leg dispatched on entry 2 and answered by some other
// model would be visible in two places and contradicted in neither".
//
// The fixtures below are not invented. Every field combination is one that was
// MEASURED reaching disk on 2026-08-09 by driving the real companion through the
// mock agent across four scenarios (unpinned · pinned-and-matched ·
// pinned-and-refused · adapter with no identity). The single most important
// result of that run is asserted end to end at the bottom of this file: the
// ledger's `assigned` line is written EVEN ON A REFUSAL, which is precisely how
// a contradiction comes to sit on disk with nothing naming it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { joinDispatchIdentity, readDispatchFacts } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts')
const COMPANION = join(SCRIPTS, 'acp-companion.mjs')
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const WORK_ITEM = 'palette-token'

// Every ACP_* key the companion reads, deleted before this file builds a child
// env. Copied from `mcp-servers-closed.test.mjs`, which had it right in this
// same release while these three end-to-end tests spread `...process.env` and
// kept whatever the shell was carrying.
//
// It is not hypothetical and it is not new: the machine that runs the ACP
// review lanes always has `ACP_MODEL` set, and with it set these tests read
// 14 pass / 3 fail while `env -u ACP_MODEL` reads 17 / 0 — measured, both ways.
// The companion takes `ACP_MODEL` as a REQUESTED model, enters
// `applyRequestedSessionConfig`, demands the mock advertise a `model` config
// option it was never told to advertise, and exits before any of the
// identity-join logic under test runs. Overriding `ACP_EXPECT_MODEL` does not
// help: it is the fallback, and `ACP_MODEL` is what triggers the request path.
// CLAUDE.md already names this class from the last time it shipped. Found by
// the release panel (zai lane, 2026-08-10, round 5).
const HERMETIC_ENV_KEYS = [
  'ACP_CMD', 'ACP_MODEL', 'ACP_REASONING_EFFORT', 'ACP_EXPECT_MODEL',
  'ACP_EXPECT_REASONING_EFFORT', 'ACP_RESUME', 'ACP_AGENT_ID', 'ACP_STALL_POLICY',
  'ACP_HARD_TIMEOUT_SEC', 'ACP_EXECUTION_PROFILE', 'ACP_SESSION_RECEIPT_REQUIRED',
  'ACP_SESSION_OPERATION', 'ACP_PRIOR_DISPATCH_ID', 'ACP_PRIOR_RECEIPT_DIGEST',
  'ACP_CONTROL_LOG', 'INITIAL_AGENT_MODE', 'TMUX_TEAMS_PHASE',
]
const hermeticEnv = () => {
  const env = { ...process.env }
  for (const key of HERMETIC_ENV_KEYS) delete env[key]
  return env
}

const assigned = (requestedModel) => ({ event: 'assigned', task_id: 't1', requested_model: requestedModel })
const receipt = (requested, effective, status) => ({
  task_id: 't1', requested_model: requested, effective_identity: effective, identity_status: status,
})

// ---------------------------------------------------------------------------
// The four shapes measured off disk

test('pinned and acknowledged is alias_agreed — and says an alias is not a family', () => {
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-2-model', 'entry-2-model', 'matched'))
  assert.equal(join_.verdict, 'alias_agreed')
  assert.equal(join_.asked, 'entry-2-model')
  assert.equal(join_.answered, 'entry-2-model')
  // The reason has a job: `opus` reaches three vendors across three gateways in
  // this project's own routing table, so a verdict that read as "model verified"
  // would be a sentence broader than what string equality proves.
  assert.match(join_.reason, /ALIAS is not a family/)
})

test('a refused identity is refused, and both names survive in the verdict', () => {
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-2-model', 'somebody-else', 'mismatched'))
  assert.equal(join_.verdict, 'refused')
  assert.equal(join_.asked, 'entry-2-model')
  assert.equal(join_.answered, 'somebody-else')
  assert.match(join_.reason, /identity_status: mismatched/)
})

test('an unpinned leg is unverified, never a conflict — the AGY shape', () => {
  // AGY is permanently unverified by documented exemption: its adapter rejects
  // every model config value and runs only its own default. A join that called
  // this a conflict would alarm on every AGY leg and be ignored within a week.
  const join_ = joinDispatchIdentity(assigned(null), receipt('none', 'gpt-mock', 'unverified'))
  assert.equal(join_.verdict, 'unverified')
  assert.equal(join_.asked, null)
  assert.equal(join_.answered, 'gpt-mock')
  assert.match(join_.reason, /nothing to contradict/)
})

test('none and missing are receipt WORDS, not model names', () => {
  // Measured: an adapter advertising no identity writes the literal string
  // `missing`. Reporting a leg as having run on a model called "missing" is the
  // failure this normalisation exists to prevent.
  const join_ = joinDispatchIdentity(assigned(null), receipt('none', 'missing', 'unverified'))
  assert.equal(join_.verdict, 'unverified')
  assert.equal(join_.answered, null)
  assert.equal(join_.reason, 'nothing was asked and nothing answered')
})

test('identity_status: missing is a REFUSAL, not a shrug', () => {
  // The twin of the case above, and the bug it hid. `missing` is a receipt WORD
  // in a model field and a real STATUS in the status field, and the same
  // normaliser was applied to both — so a pinned dispatch whose adapter
  // advertised no identity was reported `unverified` and the `missing` refusal
  // branch was unreachable code. Found by the release panel (codex lane,
  // 2026-08-10).
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-2-model', 'none', 'missing'))
  assert.equal(join_.verdict, 'refused', 'a pinned leg whose adapter named no identity was REFUSED, not merely unverified')
  assert.match(join_.reason, /identity_status: missing/)
})

test('identity_status: mismatched is a refusal too — the branch missing never reached', () => {
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-2-model', 'some-other-model', 'mismatched'))
  assert.equal(join_.verdict, 'refused')
  assert.match(join_.reason, /identity_status: mismatched/)
})

test('a matched receipt carrying its requested reasoning effort agrees, it does not contradict', () => {
  // The companion writes `${model}[${effort}]` as the effective identity when an
  // effort was requested (acp-companion.mjs) and still calls it `matched`,
  // because both halves matched. Byte-comparing that against the ledger's
  // model-only `requested_model` reported every successful pinned leg with an
  // effort as a contradiction — a false alarm on the HAPPY path, which is how a
  // new signal gets ignored. Found by the release panel (codex lane, 2026-08-10).
  const withEffort = {
    ...receipt('gpt-5.6-terra', 'gpt-5.6-terra[max]', 'matched'),
    requested_reasoning_effort: 'max',
  }
  const join_ = joinDispatchIdentity(assigned('gpt-5.6-terra'), withEffort)
  assert.equal(join_.verdict, 'alias_agreed')
  assert.equal(join_.answered, 'gpt-5.6-terra[max]')
})

test('the READER carries the effort through to the join, not just the fixture', () => {
  // The trap this repo names and I walked into anyway: the tests above hand
  // `joinDispatchIdentity` a receipt object built by hand, so they prove the
  // join's arithmetic and NOTHING about whether the field ever arrives.
  // `readDispatchFacts` did not emit `requested_reasoning_effort`, so in the
  // real pipeline `askedEffort` was always null and the false contradiction the
  // branch above removes was still being written on every tick. Found by the
  // release panel (codex lane, 2026-08-10, round 2). This test starts at the
  // receipt on disk, which is where the fact starts.
  const repo = mkdtempSync(join(tmpdir(), 'dispatch-facts-'))
  mkdirSync(join(repo, '.tmux-teams', 'dispatch'), { recursive: true })
  writeFileSync(join(repo, '.tmux-teams', 'dispatch', 't1.md'), [
    'task_id: t1',
    'dispatch_id: d1',
    'agent_id: build_w1',
    'workflow: feature',
    'work_item: tok',
    'requested_model: gpt-5.6-terra',
    'requested_reasoning_effort: max',
    'effective_identity: gpt-5.6-terra[max]',
    'identity_status: matched',
    '',
  ].join('\n'))

  // A stray file naming this task must not become its receipt — same rule the
  // liveness reader gained two rounds earlier, raised for this one by the
  // release panel (zai lane, 2026-08-10, round 7).
  writeFileSync(join(repo, '.tmux-teams', 'dispatch', 'zz-stray.md'),
    'task_id: t1\nrequested_model: someone-elses-model\neffective_identity: someone-else\nidentity_status: matched\n')

  const fact = readDispatchFacts(repo).get('t1')
  assert.ok(fact, 'the receipt on disk was not read at all')
  assert.equal(fact.requested_model, 'gpt-5.6-terra',
    'a mis-named file overwrote the real receipt for this task')
  assert.equal(fact.requested_reasoning_effort, 'max',
    'the reader dropped the effort, so the join below can only ever see null')
  assert.equal(joinDispatchIdentity(assigned('gpt-5.6-terra'), fact).verdict, 'alias_agreed',
    'a clean effort-pinned leg read off its own receipt is still reported as a contradiction')
})

test('widening for effort does not blind the join to a genuinely different model', () => {
  // The guard on the guard: accepting `model[effort]` must not accept
  // `something-else[effort]`.
  const wrongModel = {
    ...receipt('gpt-5.6-terra', 'glm-5.2[max]', 'matched'),
    requested_reasoning_effort: 'max',
  }
  assert.equal(joinDispatchIdentity(assigned('gpt-5.6-terra'), wrongModel).verdict, 'contradicted')

  // ...nor `model[some-other-effort]`.
  const wrongEffort = {
    ...receipt('gpt-5.6-terra', 'gpt-5.6-terra[low]', 'matched'),
    requested_reasoning_effort: 'max',
  }
  assert.equal(joinDispatchIdentity(assigned('gpt-5.6-terra'), wrongEffort).verdict, 'contradicted')

  // ...nor a bare model when an effort WAS requested.
  const noSuffix = {
    ...receipt('gpt-5.6-terra', 'gpt-5.6-terra', 'matched'),
    requested_reasoning_effort: 'max',
  }
  assert.equal(joinDispatchIdentity(assigned('gpt-5.6-terra'), noSuffix).verdict, 'contradicted')
})

// ---------------------------------------------------------------------------
// The contradictions — the whole reason this function exists

test('the ledger and its own receipt disagreeing about the REQUEST is a contradiction', () => {
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-7-model', 'entry-7-model', 'matched'))
  assert.equal(join_.verdict, 'contradicted')
  assert.match(join_.reason, /ledger says this leg asked for "entry-2-model".*receipt says "entry-7-model"/)
})

test('a receipt claiming matched while naming a different model is a contradiction', () => {
  // `matched` is a claim the receipt makes about itself. This is the one place
  // that claim is checked against the two names it sits beside.
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-2-model', 'somebody-else', 'matched'))
  assert.equal(join_.verdict, 'contradicted')
  assert.match(join_.reason, /claims matched while naming "somebody-else"/)
})

test('a receipt claiming matched for a leg that asked nothing is a contradiction', () => {
  const join_ = joinDispatchIdentity(assigned(null), receipt('none', 'gpt-mock', 'matched'))
  assert.equal(join_.verdict, 'contradicted')
  assert.match(join_.reason, /match against nothing is not a match/)
})

test('a pinned leg whose receipt is silent is unverified and SAYS it is not agreement', () => {
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), receipt('entry-2-model', 'entry-2-model', 'unverified'))
  assert.equal(join_.verdict, 'unverified')
  assert.match(join_.reason, /unverified is not the same fact as agreed/)
})

test('an assignment with no receipt at all is named, not skipped', () => {
  const join_ = joinDispatchIdentity(assigned('entry-2-model'), undefined)
  assert.equal(join_.verdict, 'no_receipt')
  assert.equal(join_.answered, null)
})

// ---------------------------------------------------------------------------
// End to end: the measured fact the whole join rests on

const seedLedger = (cwd) => {
  const dir = join(cwd, '.tmux-teams', 'work-items')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${WORK_ITEM}.jsonl`)
  // Stamped in the past on purpose: the writer refuses a non-monotonic append,
  // so a seed stamped "today at 09:00" fails every run before 09:00 UTC.
  writeFileSync(path, `${JSON.stringify({
    at: '2026-01-01T09:00:00.000Z', event: 'opened', work_item: WORK_ITEM, workflow: 'feature',
    agent_id: 'build_dispatcher', to_team: 'build', reason: 'entered', actor: 'human:master',
  })}\n`)
  return path
}

const receiptField = (text, key) => {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return match ? match[1].trim() : ''
}

test('a real refused dispatch leaves an assigned line and a contradicting receipt on disk', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'identity-join-'))
  const ledger = seedLedger(cwd)
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')

  const env = {
    ...hermeticEnv(),
    ACP_CMD: `${process.execPath} ${MOCK}`,
    ACP_STALL_POLICY: 'cancel', ACP_HARD_TIMEOUT_SEC: '0', ACP_CANCEL_GRACE_MS: '100', ACP_RESUME: '',
    TMUX_TEAMS_WORK_ITEM: WORK_ITEM, TMUX_TEAMS_WORKFLOW: 'feature', ACP_AGENT_ID: 'build_w1',
    ACP_EXPECT_MODEL: 'entry-2-model', MOCK_MODEL: 'somebody-else',
  }
  const run = spawnSync('node', [COMPANION, 'mock', cwd, 'task-refused', brief, '30'], { cwd, encoding: 'utf8', env })

  // The companion refuses — that half already worked and is not what is new.
  assert.notEqual(run.status, 0, `a mismatched identity must fail the dispatch; stdout:\n${run.stdout}`)

  // What IS new: both records exist afterwards, so the contradiction is on disk.
  const events = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const assignedLine = events.find((entry) => entry.event === 'assigned')
  assert.ok(assignedLine, `no assigned line was written, so this test proved nothing: ${events.map((e) => e.event).join(' -> ')}`)

  const dispatchDir = join(cwd, '.tmux-teams', 'dispatch')
  const names = existsSync(dispatchDir) ? readdirSync(dispatchDir).filter((n) => n.endsWith('.md')) : []
  assert.equal(names.length, 1, `expected exactly one dispatch receipt, saw ${names.length}`)
  const text = readFileSync(join(dispatchDir, names[0]), 'utf8')
  const fact = {
    requested_model: receiptField(text, 'requested_model'),
    effective_identity: receiptField(text, 'effective_identity'),
    identity_status: receiptField(text, 'identity_status'),
  }

  const verdict = joinDispatchIdentity(assignedLine, fact)
  assert.equal(verdict.verdict, 'refused', JSON.stringify({ assignedLine, fact, verdict }))
  assert.equal(verdict.asked, 'entry-2-model')
  assert.equal(verdict.answered, 'somebody-else')
})

test('a real clean dispatch joins to alias_agreed off the same two files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'identity-join-ok-'))
  const ledger = seedLedger(cwd)
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')

  const env = {
    ...hermeticEnv(),
    ACP_CMD: `${process.execPath} ${MOCK}`,
    ACP_STALL_POLICY: 'cancel', ACP_HARD_TIMEOUT_SEC: '0', ACP_CANCEL_GRACE_MS: '100', ACP_RESUME: '',
    TMUX_TEAMS_WORK_ITEM: WORK_ITEM, TMUX_TEAMS_WORKFLOW: 'feature', ACP_AGENT_ID: 'build_w1',
    ACP_EXPECT_MODEL: 'entry-2-model', MOCK_MODEL: 'entry-2-model',
  }
  const run = spawnSync('node', [COMPANION, 'mock', cwd, 'task-ok', brief, '30'], { cwd, encoding: 'utf8', env })
  assert.equal(run.status, 0, `expected a clean dispatch; stderr:\n${run.stderr}`)

  const events = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const assignedLine = events.find((entry) => entry.event === 'assigned')
  const dispatchDir = join(cwd, '.tmux-teams', 'dispatch')
  const names = readdirSync(dispatchDir).filter((n) => n.endsWith('.md'))
  const text = readFileSync(join(dispatchDir, names[0]), 'utf8')

  const verdict = joinDispatchIdentity(assignedLine, {
    requested_model: receiptField(text, 'requested_model'),
    effective_identity: receiptField(text, 'effective_identity'),
    identity_status: receiptField(text, 'identity_status'),
  })
  assert.equal(verdict.verdict, 'alias_agreed', JSON.stringify(verdict))
})

// ---------------------------------------------------------------------------
// The WIRING. Everything above proves the function; none of it proves the tick
// calls it. A consumer nobody exercises is the same class as the unreachable
// carve-out closed the day before this was written — code that reads as alive
// and never runs.

const GRAPH = {
  project_id: 'identity-join',
  outer_controller_id: 'join_pm',
  outer_controller_model: 'inherit-account-default',
  teams: ['control', 'build', 'verify'].map((id) => ({
    team_id: id,
    name: id,
    dispatcher_id: `${id}_dispatcher`,
    worker_ids: id === 'control' ? ['join_pm'] : [`${id}_w1`],
    evaluator_id: `${id}_evaluator`,
    models: { dispatcher: 'inherit-account-default', worker: 'inherit-account-default', evaluator: 'inherit-account-default' },
  })),
  workflows: [{ workflow_id: 'feature', name: 'Feature', route: ['control', 'build', 'verify'] }],
}

test('the tick RECORDS a contradiction it finds, in the decisions file a human opens', async () => {
  const { tick } = await import('../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs')

  const repo = mkdtempSync(join(tmpdir(), 'identity-join-tick-'))
  mkdirSync(join(repo, '.tmux-teams', 'team-briefs'), { recursive: true })
  mkdirSync(join(repo, '.mailbox-out'), { recursive: true })
  writeFileSync(join(repo, '.tmux-teams', 'graph.json'), `${JSON.stringify(GRAPH, null, 2)}\n`)
  for (const entry of GRAPH.teams) {
    writeFileSync(join(repo, '.tmux-teams', 'team-briefs', `${entry.team_id}.md`), `# ${entry.name}\n\nwork.\n`)
  }
  const ledgerPath = join(repo, '.tmux-teams', 'work-items', `${WORK_ITEM}.jsonl`)
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(ledgerPath, `${JSON.stringify({
    at: '2026-01-01T09:00:00.000Z', event: 'opened', work_item: WORK_ITEM, workflow: 'feature',
    agent_id: 'build_dispatcher', to_team: 'build', reason: 'entered', actor: 'human:master',
  })}\n`)
  writeFileSync(join(repo, '.tmux-teams', 'work-items', `${WORK_ITEM}.md`), 'carry this.\n')
  writeFileSync(join(repo, 'brief.md'), 'do the thing\n')

  // A REAL leg, so the assigned line and the receipt are both written by the
  // code that owns them rather than hand-forged into agreement.
  const run = spawnSync('node', [COMPANION, 'mock', repo, 'task-drift', join(repo, 'brief.md'), '30'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...hermeticEnv(),
      ACP_CMD: `${process.execPath} ${MOCK}`,
      ACP_STALL_POLICY: 'cancel', ACP_HARD_TIMEOUT_SEC: '0', ACP_CANCEL_GRACE_MS: '100', ACP_RESUME: '',
      TMUX_TEAMS_WORK_ITEM: WORK_ITEM, TMUX_TEAMS_WORKFLOW: 'feature', ACP_AGENT_ID: 'build_w1',
      ACP_EXPECT_MODEL: 'entry-2-model', MOCK_MODEL: 'entry-2-model',
    },
  })
  assert.equal(run.status, 0, `seed leg failed; stderr:\n${run.stderr}`)

  // Now make the two files disagree, which is the whole scenario: the receipt
  // says this dispatch asked for something the token's ledger never recorded.
  const dispatchDir = join(repo, '.tmux-teams', 'dispatch')
  const receiptName = readdirSync(dispatchDir).find((n) => n.endsWith('.md'))
  const receiptPath = join(dispatchDir, receiptName)
  const before = readFileSync(receiptPath, 'utf8')
  assert.ok(before.includes('requested_model: entry-2-model'), `the seed receipt is not the shape this test tampers:\n${before}`)
  writeFileSync(receiptPath, before.replace('requested_model: entry-2-model', 'requested_model: somebody-elses-entry'))

  const inherited = Object.fromEntries(['ACP_CMD', 'ACP_EXPECT_MODEL', 'MOCK_MODEL', 'TMUX_TEAMS_ACP_CMD',
    'TMUX_TEAMS_WORK_ITEM', 'TMUX_TEAMS_WORKFLOW', 'ACP_AGENT_ID', 'ACP_STALL_POLICY', 'ECC_GATEGUARD',
  ].map((key) => [key, process.env[key]]))
  try {
    for (const key of Object.keys(inherited)) delete process.env[key]
    Object.assign(process.env, {
      TMUX_TEAMS_ACP_CMD: `${process.execPath} ${MOCK}`,
      ACP_STALL_POLICY: 'cancel', ECC_GATEGUARD: 'off',
    })
    const result = tick(repo, { apply: true, tickSec: 1, scratchDir: join(repo, 'runner-briefs') })
    assert.ok(result.ok, `tick refused: ${result.reason}`)
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const decisionsPath = join(repo, '.tmux-teams', 'decisions', 'latest.json')
  assert.ok(existsSync(decisionsPath), 'the tick wrote no decisions file at all')
  const record = JSON.parse(readFileSync(decisionsPath, 'utf8'))
  const flagged = record.decisions.filter((entry) => entry.action === 'identity-contradicted')
  assert.equal(flagged.length, 1, `expected exactly one recorded contradiction, saw: ${JSON.stringify(record.decisions)}`)
  assert.equal(flagged[0].work_item, WORK_ITEM)
  assert.match(flagged[0].reason, /somebody-elses-entry/)
})
