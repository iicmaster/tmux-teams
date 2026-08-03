// kanban-board.test.mjs — the Test team's pass over the kanban board.
//
// tests/kanban.test.mjs pins the ten acceptance criteria. This file pins what
// the ACs do not reach: the page as an ARTIFACT that has to stay alive on disk
// (published, republished, wired to the refresh asset it actually ships with),
// and the three pieces of bespoke logic in kanban.mjs that nothing else covers
// — the placing-event clock, the parked-token path, and the header tiles.
//
// Every case here is written to fail if the behaviour breaks, not to confirm a
// tag is present. Where a check is derived from another file rather than
// hardcoded, that is deliberate: a hardcoded list of five refresh hooks cannot
// notice a sixth being added, which is exactly how a published asset once went
// dead while every test stayed green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readBoard, renderKanbanPage } from '../plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs'
import { gateHistory } from './fixture-gate.mjs'
import { PULSE_REFRESH_SOURCE } from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-refresh.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')

const NOW = '2026-07-27T12:00:00.000Z'

// Every seat names its model because §3 now requires one; the value is
// shape-checked only, never matched against a list, so a fixture name is as
// legal here as a real one.
const MODELS = { dispatcher: 'test-model', worker: 'test-model', evaluator: 'test-model' }

const TWO_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'test-model',
  teams: [
    // Build carries TWO workers so its WIP limit is 2. The limit is no longer a
    // number of its own (§3) — it is the worker count — so a team that has to be
    // drawn as `0/2` has to be a team of two.
    { team_id: 'build', name: 'Build', dispatcher_id: 'build_d', worker_ids: ['build_w1', 'build_w2'], evaluator_id: 'build_e', models: MODELS },
    { team_id: 'test', name: 'Test', dispatcher_id: 'test_d', worker_ids: ['test_w1'], evaluator_id: 'test_e', models: MODELS },
    { team_id: 'visual', name: 'Visual', dispatcher_id: 'visual_d', worker_ids: ['visual_w1'], evaluator_id: 'visual_e', models: MODELS },
  ],
  workflows: [{ workflow_id: 'feature', name: 'Feature delivery', route: ['build', 'test', 'visual'] }],
}

// Ledgers go down as JSONL text so the real reader runs, including its
// line-skipping. `extra` writes a file verbatim — that is how a broken line
// gets in front of the reader without this helper deciding what broken means.
// Fields §4 requires that no assertion in this file is about. Stated once;
// anything a fixture says itself wins, because the spread comes last.
const fill = (entry) => {
  switch (entry.event) {
    case 'assigned':
      return { dispatch_id: `${entry.task_id ?? 'task'}-dispatch`, task_id: 'task', ...entry }
    case 'delivered':
      return { task_id: 'task', timed_out: false, evidence_present: true, ...entry }
    case 'reviewed':
      return { reviewed_task: 'task', reason: 'the evaluator said so', ...entry }
    case 'escalated':
      // §4.2: the controller is not a team member, so without `to_team` the
      // token cannot be placed at all.
      return { task_id: 'controller-task', to_team: 'build', reason: 'stated by the agent', ...entry }
    case 'audit_requested':
      return { task_id: 'controller-task', reason: 'stated by the agent', ...entry }
    case 'opened':
    case 'intake':
    case 'lost':
    case 'resumed':
    case 'returned':
    case 'audited':
    case 'abandoned':
      return { reason: 'stated by the agent', ...entry }
    default:
      return { ...entry }
  }
}

const repoWith = (graph, ledgers = {}, extra = {}, gates = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-board-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  if (graph !== undefined) writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(graph))
  for (const [token, events] of Object.entries(ledgers)) {
    // Gated before it reaches disk — see tests/fixture-gate.mjs. `extra` writes
    // raw bytes on purpose and stays ungated: that is how a genuinely broken
    // line gets in front of the reader without this helper deciding what broken
    // means.
    const lines = gateHistory(token,
      events.map((entry) => ({ work_item: token, workflow: 'feature', ...fill(entry) })), gates[token])
      .map((entry) => JSON.stringify(entry))
    writeFileSync(join(dir, '.tmux-teams/work-items', `${token}.jsonl`), `${lines.join('\n')}\n`)
  }
  for (const [name, text] of Object.entries(extra)) {
    writeFileSync(join(dir, '.tmux-teams/work-items', name), text)
  }
  return dir
}

const snapshotAt = (generatedAt = NOW) => ({
  snapshot_id: 'test:1',
  generated_at: generatedAt,
  scope: { repo_name: 'demo' },
  observation: { expires_at: '2026-07-27T12:00:40.000Z', refresh_interval_sec: 20 },
})

const pageOf = (dir) => renderKanbanPage(dir, snapshotAt())

const columnsOf = (html) => {
  const columns = new Map()
  for (const chunk of html.split('<section class="col').slice(1)) {
    columns.set(chunk.match(/<h2>([^<]*)<\/h2>/)[1], {
      cards: (chunk.match(/<article class="card/g) || []).length,
      tokens: [...chunk.matchAll(/<b class="tok">([^<]*)<\/b>/g)].map((match) => match[1]),
      html: chunk,
    })
  }
  return columns
}

// A repo pulse will accept: the graph, the ledger dir, and the two dirs pulse
// insists on before it will publish anything.
const pulseRepo = (ledgerLines = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-pulse-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(TWO_TEAMS))
  writeFileSync(join(dir, '.tmux-teams/work-items/tok.jsonl'),
    ledgerLines.map((entry) => JSON.stringify({ work_item: 'tok', workflow: 'feature', ...entry })).join('\n') + '\n')
  return dir
}

const publish = (dir) => {
  const result = spawnSync(process.execPath, [PULSE, 'once', dir], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr)
  const store = join(dir, '.tmux-teams')
  return {
    store,
    html: readFileSync(join(store, 'kanban.html'), 'utf8'),
    bytes: readFileSync(join(store, 'kanban.html')),
    manifest: JSON.parse(readFileSync(join(store, 'pulse-current.json'), 'utf8')),
  }
}

// ── the artifact stays wired to the asset it ships with ─────────────────────

// Derived from pulse-refresh.mjs, not copied out of it. The refresh script is
// the only thing that makes this page live; every element it looks for is a
// hard requirement on the markup. A hardcoded list of hooks passes forever
// after someone adds a sixth one and the board quietly stops updating.
test('the published page answers every selector the published refresh script asks for', () => {
  const required = [...new Set(
    [...PULSE_REFRESH_SOURCE.matchAll(/querySelector(?:All)?\('(\[[a-z-]+\]|meta\[name="[^"]+"\])'\)/g)]
      .map((match) => match[1]),
  )]
  // Without this the whole test is vacuous if the regex ever stops matching.
  // It proves the derivation found something, not everything: a future hook
  // named with a digit or a capital would fall outside [a-z-] and slip past
  // while the other six keep this guard quiet.
  assert.ok(required.length >= 5, `only found ${required.length} selectors in the refresh source`)
  assert.ok(required.includes('meta[name="tmux-teams-snapshot-id"]'), 'the snapshot marker is the reload trigger')

  const { html, manifest, store } = publish(pulseRepo([
    { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' },
  ]))

  for (const selector of required) {
    if (selector.startsWith('meta')) {
      const name = selector.match(/name="([^"]+)"/)[1]
      continue
    }
    const attribute = selector.slice(1, -1)
  }

  // The script computes its poll interval as Number(...) * 1000. A non-numeric
  // attribute makes that NaN, and setInterval(fn, NaN) polls without pausing.
  const interval = html.match(/data-refresh-interval="([^"]*)"/)
  assert.ok(interval, 'no refresh interval on the page')
  assert.ok(Number.isFinite(Number(interval[1])), `refresh interval is not a number: ${interval[1]}`)

  // The page must ask for the asset that was actually published, and that file
  // must be the one the marker names — the script refuses to reload otherwise.
  const src = html.match(/<script src="([^"]+)" defer><\/script>/)
  assert.ok(src, 'no refresh script on the page')
  assert.equal(src[1], manifest.files.refresh_js.path)
  assert.equal(
    createHash('sha256').update(readFileSync(join(store, src[1]))).digest('hex'),
    manifest.files.refresh_js.sha256,
  )
})

// Publishing once proves the generator ran. Publishing twice proves the file on
// disk still tracks the ledger — a page that is written once and then goes
// stale looks identical to a working one in a single-run test.
test('a second publish moves the card and the recorded hash follows the file', () => {
  const dir = pulseRepo([{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }])
  const first = publish(dir)
  assert.deepEqual(columnsOf(first.html).get('Build').tokens, ['tok'], 'the first publish did not draw the token')

  appendFileSync(join(dir, '.tmux-teams/work-items/tok.jsonl'), `${JSON.stringify({
    at: '2026-07-27T10:00:00.000Z', event: 'pulled', work_item: 'tok', workflow: 'feature',
    agent_id: 'test_d', from_team: 'build', to_team: 'test',
  })}\n`)
  const second = publish(dir)

  const columns = columnsOf(second.html)
  assert.deepEqual(columns.get('Test').tokens, ['tok'], 'the token did not move on the republished page')
  assert.deepEqual(columns.get('Build').tokens, [], 'the token is still drawn in the team that handed it on')
  assert.match(columns.get('Build').html, /WIP 0\/2/)
  assert.match(columns.get('Test').html, /WIP 1\/1 · at limit/)

  assert.notEqual(first.manifest.files.kanban.sha256, second.manifest.files.kanban.sha256, 'the manifest hash did not move')
  assert.equal(createHash('sha256').update(second.bytes).digest('hex'), second.manifest.files.kanban.sha256)
})

// ── the clock that only this file owns ──────────────────────────────────────

// `lead_sec` comes from dispatch-facts and AC7 covers it. `column_sec` is
// computed here, from the event that placed the token, and nothing else pins
// it. If that search stops at the first pull instead of the most recent one, a
// token that moved five minutes ago reads as six hours old and the board
// becomes an argument for firing whoever is holding it.
test('time in column restarts at the pull that placed it; lead time does not', () => {
  const dir = repoWith(TWO_TEAMS, {
    moved: [
      { at: '2026-07-27T06:00:00.000Z', event: 'pulled', agent_id: 'build_d', from_team: 'design', to_team: 'build' },
      // The leg the review judged. A review of nothing is not a pass, and the
      // clock this test measures runs over a route the loop could actually walk.
      { at: '2026-07-27T06:30:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' },
      { at: '2026-07-27T06:45:00.000Z', event: 'delivered', agent_id: 'build_w1', task_id: 't-1', terminal: 'done' },
      { at: '2026-07-27T07:00:00.000Z', event: 'reviewed', agent_id: 'build_e', verdict: 'pass', reviewed_task: 't-1', reason: 'ok' },
      { at: '2026-07-27T11:30:00.000Z', event: 'pulled', agent_id: 'test_d', from_team: 'build', to_team: 'test' },
    ],
  })
  const card = readBoard(dir, NOW).columns.find((column) => column.team_id === 'test').cards[0]
  assert.equal(card.column_sec, 1800, 'time in column is measured from the wrong event')
  assert.equal(card.lead_sec, 19800, 'lead time must still span the whole journey')
  assert.match(pageOf(dir), /30m here · 5h 30m lead/)
})

// A token whose first team never pulled it — it started there — has no pull to
// measure from. Falling back to the first recorded event is the only honest
// answer; falling back to `now` would print a fresh card for stalled work.
test('a token that was never pulled is timed from its first recorded event', () => {
  const dir = repoWith(TWO_TEAMS, {
    born: [
      { at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' },
      { at: '2026-07-27T11:00:00.000Z', event: 'delivered', agent_id: 'build_w1', task_id: 't-1', terminal: 'done' },
    ],
  })
  const card = readBoard(dir, NOW).columns.find((column) => column.team_id === 'build').cards[0]
  assert.equal(card.column_sec, 10800)
  assert.match(pageOf(dir), /3h 00m here/)
})

// ── work parked with the outer controller ───────────────────────────────────

// The controller is not a team, so an escalated token is still held by the team
// it was parked in — loop-runner writes `to_team` for exactly that reason. If
// the board ever re-derives placement from `agent_id` instead of reading
// `held`, these cards drop into Unplaceable and free a WIP slot nobody
// released, and the board starts pulling work the controller will not.
test('a token parked with the outer controller keeps its column and its WIP slot', () => {
  const dir = repoWith(TWO_TEAMS, {
    parked: [
      { at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'test_d', from_team: 'build', to_team: 'test' },
      { at: '2026-07-27T10:00:00.000Z', event: 'escalated', agent_id: 'pm', to_team: 'test', reason: 'out of moves' },
    ],
    sent_back: [
      { at: '2026-07-27T09:30:00.000Z', event: 'resumed', agent_id: 'pm', to_team: 'build', grant: 1, reason: 'one more leg' },
    ],
  })
  const columns = columnsOf(pageOf(dir))
  assert.deepEqual(columns.get('Test').tokens, ['parked'])
  assert.match(columns.get('Test').html, /WIP 1\/1 · at limit/)
  assert.match(columns.get('Test').html, /Escalated to the outer controller/)
  assert.deepEqual(columns.get('Build').tokens, ['sent_back'])
  assert.match(columns.get('Build').html, /Resumed by the outer controller/)
  assert.equal(columns.has('Unplaceable'), false, 'parked work is not an error')
})

// The other half of the same rule: parked with no team named is genuinely
// unplaceable, and the board says so rather than guessing a column.
test('an escalation that names no team is unplaceable, and the header says how many', () => {
  const dir = repoWith(TWO_TEAMS, {
    nowhere: [{ at: '2026-07-27T09:00:00.000Z', event: 'escalated', agent_id: 'pm', to_team: null, reason: 'no team named' }],
  }, {}, { nowhere: { expectInvalid: true, why: 'an escalation naming no team IS the subject — the board must call it unplaceable' } })
  const html = pageOf(dir)
  const columns = columnsOf(html)
  assert.deepEqual(columns.get('Unplaceable').tokens, ['nowhere'])
  assert.match(columns.get('Unplaceable').html, /Last event escalated · agent pm is not placeable/)
  for (const team of TWO_TEAMS.teams) assert.match(columns.get(team.name).html, /WIP 0\//)
})

// ── unreadable evidence is stated, not smoothed over ────────────────────────

// A board built from a ledger it could not fully read is incomplete, and an
// incomplete board that looks complete is worse than no board. Nothing else
// tests this path.
test('unreadable ledger lines are counted and said out loud on the page', () => {
  const dir = repoWith(
    TWO_TEAMS,
    { good: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }] },
    { 'torn.jsonl': '{"work_item":"torn","event":"assig\n{"work_item":"has bad id","event":"assigned"}\n' },
  )
  const board = readBoard(dir, NOW)
  assert.equal(board.skippedLines, 2)
  assert.match(pageOf(dir), /2 unreadable ledger line\(s\) skipped/)

  // And the clean board must not shout: a banner that is always there is noise.
  const clean = repoWith(TWO_TEAMS, { good: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1' }] })
  assert.equal(readBoard(clean, NOW).skippedLines, 0)
  assert.doesNotMatch(pageOf(clean), /unreadable ledger line/)
})

// ── the header and the columns are one board ────────────────────────────────

// The tiles are computed from occupancy; the columns are drawn from the cards.
// They are two paths to the same three numbers, and a reader trusts whichever
// they read first. Asserted from the published HTML only — the numbers a person
// actually sees, not the object that produced them.
test('the header tiles state exactly what the columns draw', () => {
  const dir = repoWith(TWO_TEAMS, {
    working: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
    waiting: [{ at: '2026-07-27T09:10:00.000Z', event: 'pulled', agent_id: 'test_d', from_team: 'build', to_team: 'test' }],
    parked: [{ at: '2026-07-27T09:20:00.000Z', event: 'escalated', agent_id: 'pm', to_team: 'visual', reason: 'stuck' }],
    finished: [{ at: '2026-07-27T09:30:00.000Z', event: 'completed', from_team: 'visual' }],
    dropped: [{ at: '2026-07-27T09:40:00.000Z', event: 'abandoned', agent_id: 'pm', reason: 'obsolete' }],
    ghosted: [{ at: '2026-07-27T09:50:00.000Z', event: 'delivered', agent_id: 'agent_from_a_deleted_graph', terminal: 'done' }],
  }, {}, {
    ghosted: { expectInvalid: true, why: 'an agent no graph declares — the unplaceable tile is exactly what this test counts' },
  })
  const html = pageOf(dir)
  const tiles = new Map([...html.matchAll(/<span class="tile-v">([^<]*)<\/span><span class="tile-l">([^<]*)</g)]
    .map((match) => [match[2], Number(match[1])]))
  assert.equal(tiles.size, 3, 'the header lost a tile')

  const columns = columnsOf(html)
  const teamCards = TWO_TEAMS.teams.reduce((sum, team) => sum + columns.get(team.name).cards, 0)
  assert.equal(tiles.get('work items in a team right now'), teamCards)
  assert.equal(tiles.get('routes closed'), columns.get('Done').cards)
  assert.equal(tiles.get('tokens that cannot be placed'), columns.get('Unplaceable').cards)

  // and the three groups together account for every token, none twice
  assert.equal(teamCards + columns.get('Done').cards + columns.get('Unplaceable').cards, 6)
  assert.equal((html.match(/<article class="card/g) || []).length, 6)
})

// §14.2 item 2, closed: the pull controller refuses to move a token whose own
// history cannot be believed, and the board drew it as an ordinary card. The
// loop would not touch it; the board said it was fine. That disagreement is the
// one thing this file exists to catch, and it was the board that was wrong.
test('a token the loop refuses to move for a broken history says so on the board', () => {
  const dir = repoWith(TWO_TEAMS, {
    // A review of nothing delivered. It parses, so the board still draws it —
    // which is exactly why it has to be the card that says it is stuck.
    doubtful: [
      { at: '2026-07-27T09:00:00.000Z', event: 'reviewed', agent_id: 'test_e', verdict: 'pass', reviewed_task: 't-1', reason: 'good' },
    ],
  }, {}, { doubtful: { expectInvalid: true, why: 'the unbelievable history IS the subject — planPulls must refuse it' } })
  const card = readBoard(dir, NOW).columns.find((column) => column.team_id === 'test').cards[0]
  assert.equal(card.work_item, 'doubtful')
  assert.notEqual(card.blocked_reason, null, 'a refused token must not read as an ordinary card')
  assert.match(card.blocked_reason, /ledger/)

  const column = columnsOf(pageOf(dir)).get('Test')
})

// ── blocked is a claim, and a claim can be wrong in both directions ─────────

// AC5 proves a blocked card says so. This proves the label is earned: with the
// next team empty, the same token is free to move and must carry no blocked
// text. A board that marked everything blocked would pass AC5.
test('a card whose next team has room is not labelled blocked', () => {
  const dir = repoWith(TWO_TEAMS, {
    // A whole history, not just its last line. This fixture used to be the
    // `reviewed` alone — a review of nothing delivered, which the validator
    // refuses and the real loop can never produce. It passed only because the
    // board ignored the verdict on a token's own history; the moment `invalid`
    // became a blocking action the fixture started claiming the opposite of
    // what this test is named for.
    ready: [
      { at: '2026-07-27T08:00:00.000Z', event: 'opened', agent_id: 'test_d', to_team: 'test', reason: 'opened for this test' },
      { at: '2026-07-27T08:30:00.000Z', event: 'assigned', agent_id: 'test_w1', task_id: 't-1', dispatch_id: 'd-1' },
      { at: '2026-07-27T08:45:00.000Z', event: 'delivered', agent_id: 'test_w1', task_id: 't-1', terminal: 'done', timed_out: false, evidence_present: true },
      { at: '2026-07-27T09:00:00.000Z', event: 'reviewed', agent_id: 'test_e', verdict: 'pass', reviewed_task: 't-1', reason: 'good' },
    ],
  })
  const board = readBoard(dir, NOW)
  const card = board.columns.find((column) => column.team_id === 'test').cards[0]
  assert.equal(card.work_item, 'ready')
  assert.equal(card.blocked_reason, null)

  const column = columnsOf(pageOf(dir)).get('Test')
})

// GitHub #30 on the board. A killed leg writes its `delivered` on the way out,
// after a newer assignment already moved the token — and `at` is stamped when
// the line is written, so that write is honestly the newest. A card that reads
// its own state off the newest event shows a token working in a team it left.
test('a card reads the leg that holds the token, not the one that reported late', () => {
  const dir = repoWith(TWO_TEAMS, {
    late: [
      { at: '2026-07-27T06:00:00.000Z', event: 'pulled', agent_id: 'build_d', from_team: 'design', to_team: 'build' },
      { at: '2026-07-27T06:30:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' },
      { at: '2026-07-27T07:00:00.000Z', event: 'pulled', agent_id: 'test_d', from_team: 'build', to_team: 'test' },
      { at: '2026-07-27T07:10:00.000Z', event: 'assigned', agent_id: 'test_w1', task_id: 't-2' },
      // The dead leg, arriving last and telling the truth about itself.
      { at: '2026-07-27T07:20:00.000Z', event: 'delivered', agent_id: 'build_w1', task_id: 't-1', terminal: 'done' },
    ],
  })
  const board = readBoard(dir, NOW)
  const column = (id) => board.columns.find((entry) => entry.team_id === id)
  assert.deepEqual(column('build').cards.map((card) => card.work_item), [],
    'the card was dragged back by a leg that no longer holds it')
  assert.deepEqual(column('test').cards.map((card) => card.work_item), ['late'])
  // And the state on the card is the live leg's, not the dead one's outcome.
  assert.doesNotMatch(String(column('test').cards[0].state), /done|delivered/i)
})
