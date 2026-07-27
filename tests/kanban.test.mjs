// kanban.test.mjs — the board can fail in exactly two ways that matter:
// putting a token somewhere the controller would not, and printing a number
// nothing recorded. Every case here pins one of those two lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

import { readBoard, renderKanbanPage } from '../plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs'
import { readWorkItems, teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { duration } from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph-loop.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KANBAN = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')

const NOW = '2026-07-27T12:00:00.000Z'

const FOUR_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  teams: [
    { team_id: 'design', name: 'Design', dispatcher_id: 'design_d', worker_ids: ['design_w1'], evaluator_id: 'design_e', wip_limit: 1 },
    { team_id: 'build', name: 'Build', dispatcher_id: 'build_d', worker_ids: ['build_w1', 'build_w2'], evaluator_id: 'build_e', wip_limit: 2 },
    { team_id: 'test', name: 'Test', dispatcher_id: 'test_d', worker_ids: ['test_w1'], evaluator_id: 'test_e', wip_limit: 1 },
    { team_id: 'visual', name: 'Visual', dispatcher_id: 'visual_d', worker_ids: ['visual_w1'], evaluator_id: 'visual_e', wip_limit: 1 },
  ],
  workflows: [
    { workflow_id: 'feature', name: 'Feature delivery', route: ['design', 'build', 'test', 'visual'] },
    { workflow_id: 'fix', name: 'Fix', route: ['build', 'test', 'visual'] },
  ],
}

// Ledgers are written as JSONL text so the test exercises the real reader,
// including the line-skipping it does.
const repoWith = (graph, ledgers = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  if (graph !== undefined) writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(graph))
  for (const [token, events] of Object.entries(ledgers)) {
    const lines = events.map((entry) =>
      JSON.stringify({ work_item: token, workflow: 'feature', ...entry }))
    writeFileSync(join(dir, '.tmux-teams/work-items', `${token}.jsonl`), `${lines.join('\n')}\n`)
  }
  return dir
}

const snapshotAt = (generatedAt = NOW) => ({
  snapshot_id: 'test:1',
  generated_at: generatedAt,
  scope: { repo_name: 'demo' },
  observation: { expires_at: '2026-07-27T12:00:40.000Z', refresh_interval_sec: 20 },
})

const pageOf = (dir, generatedAt) => renderKanbanPage(dir, snapshotAt(generatedAt))

// Sections are siblings, never nested, so splitting on the opening tag is a
// faithful read of what actually landed in the column.
const columnsOf = (html) => {
  const columns = new Map()
  for (const chunk of html.split('<section class="col').slice(1)) {
    const name = chunk.match(/<h2>([^<]*)<\/h2>/)[1]
    columns.set(name, { cards: (chunk.match(/<article class="card/g) || []).length, html: chunk })
  }
  return columns
}

const graphOf = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? '')
  return result.value
}

// ── AC1 — a token appears in the team that is holding it ─────────────────────

test('AC1 a token pulled into a team is a card in that column and nowhere else', () => {
  const dir = repoWith(FOUR_TEAMS, {
    tok1: [{ at: '2026-07-27T10:00:00.000Z', event: 'pulled', agent_id: 'test_d', from_team: 'build', to_team: 'test' }],
  })
  const html = pageOf(dir)
  const columns = columnsOf(html)
  assert.equal(columns.get('Test').cards, 1)
  assert.match(columns.get('Test').html, /<b class="tok">tok1<\/b>/)
  assert.equal((html.match(/<b class="tok">tok1<\/b>/g) || []).length, 1, 'tok1 is drawn once')
  for (const name of ['Design', 'Build', 'Visual', 'Done']) assert.equal(columns.get(name).cards, 0, name)
})

// ── AC2 — the board and the controller never disagree ───────────────────────

test('AC2 every column count equals teamOccupancy, and WIP prints that same n', () => {
  const dir = repoWith(FOUR_TEAMS, {
    a: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'design_w1', task_id: 't-a' }],
    b: [{ at: '2026-07-27T09:10:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-b' }],
    c: [{ at: '2026-07-27T09:20:00.000Z', event: 'pulled', agent_id: 'build_d', from_team: 'design', to_team: 'build' }],
    d: [{ at: '2026-07-27T09:30:00.000Z', event: 'reviewed', agent_id: 'test_e', verdict: 'reject', reason: 'thin' }],
    done1: [{ at: '2026-07-27T09:40:00.000Z', event: 'completed', from_team: 'visual' }],
  })
  // Computed here, independently of readBoard — comparing the page against the
  // structure the page itself built would prove nothing.
  const graph = graphOf(FOUR_TEAMS)
  const { items } = readWorkItems(dir)
  const occupancy = teamOccupancy(graph, items)

  const columns = columnsOf(pageOf(dir))
  for (const team of FOUR_TEAMS.teams) {
    const column = columns.get(team.name)
    const expected = occupancy.counts.get(team.team_id)
    assert.equal(column.cards, expected, `${team.name} card count`)
    assert.match(column.html, new RegExp(`WIP ${expected}/${team.wip_limit}`), `${team.name} WIP text`)
  }
})

test('every token is on the board exactly once', () => {
  const dir = repoWith(FOUR_TEAMS, {
    held: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
    finished: [{ at: '2026-07-27T09:00:00.000Z', event: 'completed', from_team: 'visual' }],
    lostly: [{ at: '2026-07-27T09:00:00.000Z', event: 'delivered', agent_id: 'ghost', terminal: 'done' }],
  })
  const board = readBoard(dir, NOW)
  const total = board.columns.reduce((sum, column) => sum + column.cards.length, 0) + board.unplaceable.length
  assert.equal(total, readWorkItems(dir).items.size)
  assert.equal((pageOf(dir).match(/<article class="card/g) || []).length, total)
})

// ── AC3 — finished work leaves the flow ─────────────────────────────────────

test('AC3 completed and abandoned both land in Done, told apart', () => {
  const dir = repoWith(FOUR_TEAMS, {
    fin: [{ at: '2026-07-27T09:00:00.000Z', event: 'completed', from_team: 'visual' }],
    gone: [{ at: '2026-07-27T09:00:00.000Z', event: 'abandoned', agent_id: 'pm', reason: 'nobody will finish it' }],
  })
  const columns = columnsOf(pageOf(dir))
  const done = columns.get('Done')
  assert.equal(done.cards, 2)
  assert.match(done.html, /class="card s-completed"[^>]*>[\s\S]*?<b class="tok">fin<\/b>/)
  assert.match(done.html, /class="card s-abandoned"[^>]*>[\s\S]*?<b class="tok">gone<\/b>/)
  assert.match(done.html, /<span class="st">Completed<\/span>/)
  assert.match(done.html, /<span class="st">Abandoned<\/span>/)
  // Closed work is not an error. Accusing it of being unplaceable was a real bug.
  assert.equal(columns.has('Unplaceable'), false)
  for (const team of FOUR_TEAMS.teams) assert.match(columns.get(team.name).html, /WIP 0\//)
})

// ── AC4 — a failed leg is visibly stuck ─────────────────────────────────────

test('AC4 a leg that ended in a protocol error stays put and says so', () => {
  const dir = repoWith(FOUR_TEAMS, {
    stuck: [
      { at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'build_d', from_team: 'design', to_team: 'build' },
      { at: '2026-07-27T09:05:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' },
      { at: '2026-07-27T09:20:00.000Z', event: 'delivered', agent_id: 'build_w1', task_id: 't-1', terminal: 'protocol-error' },
    ],
  })
  const column = columnsOf(pageOf(dir)).get('Build')
  assert.equal(column.cards, 1)
  assert.match(column.html, /Failed leg — needs a rerun/)
  assert.match(column.html, /protocol-error/)
  assert.match(column.html, /1 legs/)
})

// ── AC5 — blocked by WIP names the team that is blocking ────────────────────

test('AC5 a card blocked by a full team names that team in full', () => {
  const dir = repoWith(FOUR_TEAMS, {
    holding: [{ at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'visual_d', from_team: 'test', to_team: 'visual' }],
    waiting: [{ at: '2026-07-27T09:10:00.000Z', event: 'reviewed', agent_id: 'test_e', verdict: 'pass', reason: 'good' }],
  })
  const columns = columnsOf(pageOf(dir))
  assert.equal(columns.get('Visual').cards, 1)
  const test = columns.get('Test')
  assert.equal(test.cards, 1)
  assert.match(test.html, /class="card s-reviewed is-blocked"/)
  assert.match(test.html, /Visual is at its WIP limit \(1\/1\)/)
  assert.match(columns.get('Visual').html, /WIP 1\/1 · at limit/)
})

// ── AC6 — a token that cannot be placed is shown, not hidden ────────────────

test('AC6 an agent outside the declared graph puts its token in Unplaceable', () => {
  const dir = repoWith(FOUR_TEAMS, {
    orphan: [{ at: '2026-07-27T09:00:00.000Z', event: 'delivered', agent_id: 'old_worker_1', terminal: 'done' }],
  })
  const graph = graphOf(FOUR_TEAMS)
  const orphans = teamOccupancy(graph, readWorkItems(dir).items).orphans
  assert.equal(orphans.length, 1)

  const html = pageOf(dir)
  const column = columnsOf(html).get('Unplaceable')
  assert.equal(column.cards, 1)
  assert.match(column.html, /<b class="tok">orphan<\/b>/)
  assert.match(column.html, /Last event delivered · agent old_worker_1/)
  assert.match(html, new RegExp(`<span class="tile-v">${orphans.length}</span><span class="tile-l">tokens that cannot be placed`))
})

// ── AC7 — times come from the ledger, and unknown stays unknown ─────────────

test('AC7 lead time is the ledger figure, rendered by the one formatter', () => {
  const dir = repoWith(FOUR_TEAMS, {
    slow: [
      { at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'build_d', from_team: 'design', to_team: 'build' },
      { at: '2026-07-27T11:05:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' },
    ],
  })
  const item = readWorkItems(dir).items.get('slow')
  assert.equal(item.lead_sec, 7500)
  assert.equal(duration(item.lead_sec), '2h 05m')
  assert.match(pageOf(dir), /3h 00m here · 2h 05m lead · 1 legs/)
})

test('AC7 an unparseable timestamp prints unknown, never zero', () => {
  const dir = repoWith(FOUR_TEAMS, {
    undated: [{ at: 'not-a-date', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const board = readBoard(dir, NOW)
  assert.equal(board.columns.find((column) => column.team_id === 'build').cards[0].lead_sec, null)
  const html = pageOf(dir)
  assert.match(html, /unknown here · unknown lead/)
  assert.doesNotMatch(html, /\b0s\b|0h 00m/)
})

test('AC7 a snapshot with no usable clock leaves every column time unknown', () => {
  const dir = repoWith(FOUR_TEAMS, {
    tok: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const board = readBoard(dir, 'not-a-date')
  assert.equal(board.now, null)
  assert.equal(board.columns.find((column) => column.team_id === 'build').cards[0].column_sec, null)
  assert.match(pageOf(dir, 'not-a-date'), /unknown here/)
})

// ── AC8 — the page is safe and offline ──────────────────────────────────────

test('AC8 agent-authored text is escaped, and the page declares its charset', () => {
  // The dangerous payload goes in `reason`: `work_item` is filtered by ID_RE in
  // dispatch-facts.mjs, so a script tag there would be skipped as a bad line
  // and never reach the page — proving nothing about escaping.
  const dir = repoWith(FOUR_TEAMS, {
    xss: [{
      at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'build_d',
      from_team: 'design', to_team: 'build', reason: '<script>alert(1)</script>',
    }],
  })
  const html = pageOf(dir)
  assert.equal(html.split('\n')[0], '<meta charset="utf-8">')
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('AC8 the page references no remote asset', () => {
  // The fixture carries no URL of its own, so any http(s) match would be the
  // page referencing something off this machine.
  const dir = repoWith(FOUR_TEAMS, {
    tok: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const html = renderKanbanPage(dir, snapshotAt(), { refreshScriptName: 'pulse-refresh-abc.js' })
  assert.doesNotMatch(html, /https?:\/\//)
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    assert.doesNotMatch(url, /^[a-z]+:|^\/\//, `remote asset: ${url}`)
  }
})

// ── AC9 — an invalid graph fails closed ─────────────────────────────────────

test('AC9 a graph that violates the contract renders a reason and no board', () => {
  // Parseable JSON that breaks the contract. Unparseable JSON would fall back
  // to the bundled template and pass, which is the opposite of this test.
  const dir = repoWith({ teams: [{ team_id: 'solo' }], workflows: [] })
  const board = readBoard(dir, NOW)
  assert.equal(board.ok, false)
  assert.match(board.reason, /workflows must be an array/)

  const html = pageOf(dir)
  assert.match(html, /failed the contract/)
  assert.match(html, new RegExp(board.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(html, /class="board"/)

  const result = spawnSync(process.execPath, [KANBAN, 'check', dir], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid team graph/)
})

test('the CLI writes the page, and takes its clock from the snapshot', () => {
  const dir = repoWith(FOUR_TEAMS, {
    tok: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  writeFileSync(join(dir, '.tmux-teams/pulse.json'), JSON.stringify(snapshotAt()))
  const result = spawnSync(process.execPath, [KANBAN, 'init', dir], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)

  const html = readFileSync(join(dir, '.tmux-teams/kanban.html'), 'utf8')
  assert.match(html, /<b class="tok">tok<\/b>/)
  // The only proof that `init` read pulse.json rather than the wall clock: this
  // number is fixed by the fixture and would drift with every run otherwise.
  assert.match(html, /3h 00m here/)
})

test('the CLI refuses to invent a clock when there is no snapshot', () => {
  const dir = repoWith(FOUR_TEAMS, {})
  const result = spawnSync(process.execPath, [KANBAN, 'check', dir], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /run: node pulse\.mjs once/)
})

// ── AC10 — it is actually published ─────────────────────────────────────────

test('AC10 pulse publishes kanban.html, and the file on disk is the one recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-pulse-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  writeFileSync(join(dir, '.tmux-teams/team-graph.json'), JSON.stringify(FOUR_TEAMS))
  writeFileSync(join(dir, '.tmux-teams/work-items/tok.jsonl'),
    `${JSON.stringify({ at: '2026-07-27T09:00:00.000Z', event: 'assigned', work_item: 'tok', workflow: 'feature', agent_id: 'build_w1', task_id: 't-1' })}\n`)

  const result = spawnSync(process.execPath, [PULSE, 'once', dir], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)

  const store = join(dir, '.tmux-teams')
  const page = join(store, 'kanban.html')
  assert.equal(existsSync(page), true, 'kanban.html was not published')
  const html = readFileSync(page, 'utf8')

  const manifest = JSON.parse(readFileSync(join(store, 'pulse-current.json'), 'utf8'))
  assert.equal(manifest.files.kanban.path, 'kanban.html')
  assert.equal(createHash('sha256').update(readFileSync(page)).digest('hex'), manifest.files.kanban.sha256)

  // The published refresh script must be the one this page asks for, and it
  // must actually parse — a bundle hash agreeing with itself once hid a broken
  // asset for a whole day while every test stayed green.
  const src = html.match(/<script src="([^"]+)" defer><\/script>/)
  assert.ok(src, 'no refresh script on the page')
  assert.equal(src[1], manifest.files.refresh_js.path)
  const script = readFileSync(join(store, src[1]), 'utf8')
  assert.doesNotThrow(() => new Script(script), 'the published refresh asset does not parse')

  for (const hook of [
    /<meta name="tmux-teams-snapshot-id" content="[^"]+">/,
    /data-observation-expires-at="/,
    /data-refresh-toggle/,
    /data-refresh-status/,
    /data-refresh-scroll-key="board"/,
  ]) assert.match(html, hook)
  assert.match(html, /<b class="tok">tok<\/b>/)
  // Offline, asserted against the file that shipped — not a string this test
  // rendered for itself. The fixture ledger carries no URL of its own.
  assert.doesNotMatch(html, /https?:\/\//)
})
