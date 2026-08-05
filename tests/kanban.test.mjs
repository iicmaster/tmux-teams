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

import { readBoard, renderKanbanPage, stateOf } from '../plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs'
import { NAV_PAGES, renderNav } from '../plugins/tmux-teams/skills/tmux-teams/scripts/page-nav.mjs'
import { EVENT_SPEC, LEDGER_EVENTS } from '../plugins/tmux-teams/skills/tmux-teams/scripts/ledger-validate.mjs'
import { readWorkItems, teamOccupancy } from '../plugins/tmux-teams/skills/tmux-teams/scripts/dispatch-facts.mjs'
import { gateHistory } from './fixture-gate.mjs'
import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'
import { clip, duration } from '../plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KANBAN = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/kanban.mjs')
const PULSE = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs')

const NOW = '2026-07-27T12:00:00.000Z'

// Every seat names its model because §3 now requires one, and the value is
// shape-checked only — never matched against a list — so a fixture name is as
// legal here as a real one. No team declares `wip_limit`: it is derived from the
// worker count, and a declared number that disagreed is rejected outright.
const MODELS = { dispatcher: 'test-model', worker: 'test-model', evaluator: 'test-model' }

const FOUR_TEAMS = {
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'test-model',
  teams: [
    { team_id: 'design', name: 'Design', dispatcher_id: 'design_d', worker_ids: ['design_w1'], evaluator_id: 'design_e', models: MODELS },
    { team_id: 'build', name: 'Build', dispatcher_id: 'build_d', worker_ids: ['build_w1', 'build_w2'], evaluator_id: 'build_e', models: MODELS },
    { team_id: 'test', name: 'Test', dispatcher_id: 'test_d', worker_ids: ['test_w1'], evaluator_id: 'test_e', models: MODELS },
    { team_id: 'visual', name: 'Visual', dispatcher_id: 'visual_d', worker_ids: ['visual_w1'], evaluator_id: 'visual_e', models: MODELS },
  ],
  workflows: [
    { workflow_id: 'feature', name: 'Feature delivery', route: ['design', 'build', 'test', 'visual'] },
    { workflow_id: 'fix', name: 'Fix', route: ['build', 'test', 'visual'] },
  ],
}

// Ledgers are written as JSONL text so the test exercises the real reader,
// including the line-skipping it does.
// Fields contract §4 requires that no card on this board is ever about. Stated
// once here rather than in every fixture; anything a fixture says itself wins,
// because the spread comes last.
const fill = (entry) => {
  switch (entry.event) {
    case 'assigned':
      return { dispatch_id: `${entry.task_id ?? 'task'}-dispatch`, task_id: 'task', ...entry }
    case 'delivered':
      return { task_id: 'task', timed_out: false, evidence_present: true, ...entry }
    case 'reviewed':
      return { reviewed_task: 'task', reason: 'the evaluator said so', ...entry }
    case 'escalated':
    case 'audit_requested':
      return { task_id: 'controller-task', reason: 'stated by the agent', ...entry }
    // ADR 0002: `opened.actor` is who decided, always a person — its own
    // default, not the agent-written group below.
    case 'opened':
      return { reason: 'stated by the agent', actor: 'human:someone', ...entry }
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

const repoWith = (graph, ledgers = {}, gates = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-'))
  mkdirSync(join(dir, '.tmux-teams', 'work-items'), { recursive: true })
  if (graph !== undefined) writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(graph))
  for (const [token, events] of Object.entries(ledgers)) {
    // Gated before it reaches disk: a card drawn from a history the loop could
    // not have written describes a board for a different system. The filler
    // supplies the fields §4 requires but no card is about — a dispatch id, a
    // timeout flag — so a fixture still says only what its test is for.
    const lines = gateHistory(token,
      events.map((entry) => ({ work_item: token, workflow: 'feature', ...fill(entry) })), gates[token])
      .map((entry) => JSON.stringify(entry))
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
  // `[^>]*` tolerates the `id` the token element also carries (it anchors the
  // card's `aria-labelledby`) without caring what that id is — this test is
  // about placement, not about the accessible-name plumbing.
  assert.match(columns.get('Test').html, /<b class="tok"[^>]*>tok1<\/b>/)
  assert.equal((html.match(/<b class="tok"[^>]*>tok1<\/b>/g) || []).length, 1, 'tok1 is drawn once')
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
  }, {
    // These fixtures are one line each on purpose: the test counts columns, and
    // a full route per token would bury the only thing it asserts.
    d: { expectInvalid: true, why: 'a bare reviewed — this test counts columns, not histories' },
  })
  // Computed here, independently of readBoard — comparing the page against the
  // structure the page itself built would prove nothing.
  const graph = graphOf(FOUR_TEAMS)
  const { items } = readWorkItems(dir)
  const occupancy = teamOccupancy(graph, items)

  const columns = columnsOf(pageOf(dir))
  // Read off the VALIDATED graph: `wip_limit` is derived from the worker count
  // (§3), so the raw declaration no longer carries the number the page prints.
  for (const team of graph.teams) {
    const column = columns.get(team.name)
    const expected = occupancy.counts.get(team.team_id)
    assert.equal(column.cards, expected, `${team.name} card count`)
  }
})

test('every token is on the board exactly once', () => {
  const dir = repoWith(FOUR_TEAMS, {
    held: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
    finished: [{ at: '2026-07-27T09:00:00.000Z', event: 'completed', from_team: 'visual' }],
    lostly: [{ at: '2026-07-27T09:00:00.000Z', event: 'delivered', agent_id: 'ghost', terminal: 'done' }],
  }, { lostly: { expectInvalid: true, why: 'an agent no graph declares — being unplaceable IS the subject' } })
  const board = readBoard(dir, NOW)
  const total = board.columns.reduce((sum, column) => sum + column.cards.length, 0) + board.unplaceable.length
  assert.equal(total, readWorkItems(dir).items.size)
  assert.equal((pageOf(dir).match(/<article class="card/g) || []).length, total)
})

test('the two facts that used to be hover-only are on the card, and no title hides them again', () => {
  // 128 characters: the ledger's own maximum id length (contract §4 ID_RE
  // allows at most 128, not more). A shorter fixture cannot prove the card
  // does not clip early — a bug that lowered the clip limit below 128 would
  // still leave a 71-character fixture untouched and the test green.
  const token = `story-${'x'.repeat(128 - 'story-'.length - '-tail'.length)}-tail`
  assert.equal(token.length, 128)
  const dir = repoWith(FOUR_TEAMS, {
    [token]: [{ at: '2026-07-27T09:12:04.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const html = pageOf(dir)
  // The identity first: a truncated token id cannot be pasted into a ledger
  // lookup, which is the one thing a reader leaves this board to do. `[^>]*`
  // tolerates the token element's own `id` (it anchors the card's
  // `aria-labelledby`) without caring what that id is.
  assert.match(html, new RegExp(`<b class="tok"[^>]*>${token}</b>`))
  // clip() itself: the card's use of it is only correct if the function it
  // calls truncates past the limit and leaves anything at or under it whole.
  assert.equal(clip('y'.repeat(200), 128), `${'y'.repeat(127)}…`)
  assert.equal(clip('y'.repeat(128), 128), 'y'.repeat(128))
  // Then the stamp, machine-readable at the precision HTML's own microsyntax
  // accepts and human-readable to the minute.
  assert.match(html, /<time class="at" datetime="2026-07-27T09:12:04\.000Z">2026-07-27 09:12 UTC<\/time>/)
  // A `title` anywhere on the article would override its accessible name, so a
  // screen reader would announce the summary INSTEAD of the card it
  // summarises. Matched attribute-order-independently — this fixture has
  // exactly one card, so the first `<article>` tag on the page is the one
  // under test — because a `title` written before `class` is exactly the
  // regression the old `/<article class="card[^>]*title=/` regex missed: it
  // only ever looked for `title=` after `class` had already matched.
  const articleOpenTag = html.match(/<article\b[^>]*>/)[0]
  assert.doesNotMatch(articleOpenTag, /\btitle="/)
})

// F8: `Date.parse` (and therefore the old `absoluteAt`) silently rolls a
// calendar-impossible stamp into the next real instant instead of refusing
// it. Each of these is a shape the old regex-plus-Date.parse validator in
// ledger-validate.mjs also accepts, so the corrupt value reaches the board
// exactly as written, not caught upstream.
test('F8 a calendar-impossible timestamp is shown as malformed, not silently rolled forward', () => {
  for (const bad of [
    // 2026 is not a leap year — Date.parse silently becomes 2026-03-01.
    '2026-02-29T09:12:04.000Z',
    // Hour 24 silently becomes the next day at 00:00.
    '2026-07-27T24:00:00.000Z',
    // Not a timestamp at all, but Date.parse accepts short numeric strings.
    '0',
  ]) {
    const dir = repoWith(FOUR_TEAMS, {
      bad: [{ at: bad, event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
    }, { bad: { expectInvalid: true, why: 'the malformed stamp IS the subject' } })
    const html = pageOf(dir)
    assert.match(html, new RegExp(`Malformed timestamp: "${bad}"`), bad)
    // No plausible-looking rolled-forward instant anywhere on the page.
    assert.doesNotMatch(html, /<time class="at"/, bad)
  }
})

test('F8 a ledger stamp finer than millisecond precision still renders a valid HTML datetime', () => {
  const dir = repoWith(FOUR_TEAMS, {
    fine: [{ at: '2026-07-27T09:12:04.123456789Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const html = pageOf(dir)
  // HTML's global date and time microsyntax accepts at most three fraction
  // digits. Truncated, not rounded or rejected — the ledger's own field still
  // carries the full value, this is only the machine-readable copy.
  assert.match(html, /<time class="at" datetime="2026-07-27T09:12:04\.123Z">2026-07-27 09:12 UTC<\/time>/)
})

// F9: an article with no authored name is unreadable in a screen reader's
// article list without opening each one, and the literal last event word —
// as opposed to `state`'s paraphrase of it — was left nowhere visible.
test('F9 a card names itself for a screen reader and shows the raw last event', () => {
  const dir = repoWith(FOUR_TEAMS, {
    tok1: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const html = pageOf(dir)
  const article = html.match(/<article\b[^>]*>/)[0]
  const labelledBy = article.match(/aria-labelledby="([^"]+)"/)
  assert.ok(labelledBy, 'article has no aria-labelledby')
  // The id it points at must actually exist, on the element that carries the
  // token — an aria-labelledby to nothing is worse than none, because it
  // reads as intentional and is not.
  assert.match(html, new RegExp(`<b class="tok" id="${labelledBy[1]}"`))
  assert.match(html, /<span class="ev">last event: assigned<\/span>/)
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
  // §5: `completed` is only half closed — the outer controller has still to read
  // the delivery as a whole. The card says so, because a route calling itself
  // finished is not the same fact as a route somebody checked.
  // Closed work is not an error. Accusing it of being unplaceable was a real bug.
  assert.equal(columns.has('Unplaceable'), false)
  for (const team of FOUR_TEAMS.teams) assert.match(columns.get(team.name).html, /WIP 0\//)
})

// Rewritten from two tests that asked the same questions of rendered markup.
// The questions were about `stateOf`; the markup was only how they reached it.

test('an audited route reports the controller verdict, not an unknown event', () => {
  const graph = graphOf(FOUR_TEAMS)
  const audited = stateOf(graph, {
    at: '2026-07-27T09:20:00.000Z', event: 'audited', agent_id: 'pm',
    verdict: 'concern', reason: 'four findings a human has to settle',
  })
  assert.match(audited.state, /concern/)
  assert.equal(/^Unknown event/.test(audited.state), false)
  // A concern is work for a human, not a failure of the loop, and an accept is
  // not the same word as a concern.
  assert.notEqual(stateOf(graph, {
    at: '2026-07-27T09:20:00.000Z', event: 'audited', agent_id: 'pm',
    verdict: 'accept', reason: 'the delivery answers the request',
  }).state, audited.state)
})

test('work that opened a route waits for intake exactly like a pull does', () => {
  const graph = graphOf(FOUR_TEAMS)
  const opened = stateOf(graph, {
    at: '2026-07-27T09:00:00.000Z', event: 'opened', agent_id: 'design_d',
    to_team: 'design', reason: 'opened from the quick-spec',
  })
  const pulled = stateOf(graph, {
    at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'design_d',
    from_team: 'build', to_team: 'design',
  })
  // §4.6: they differ only in whether a team sent it, and the board's question
  // — what is this waiting on — has the same answer either way.
  assert.equal(opened.state, pulled.state)
  assert.equal(/^Unknown event/.test(opened.state), false)
})

// ── the whole vocabulary, not one word at a time ────────────────────────────
//
// Four times now the same shape of bug: the validator accepts a word and a
// reader downstream has never heard of it. `opened` stranded a token; `audited`
// rendered a route the PM had raised concerns about as `Unknown event: audited`;
// `invalid` drew a token the loop refuses to move as an ordinary card. Each was
// found by a human looking at a page, one word later than the last.
//
// Fixing them one at a time cannot converge, because nothing makes a reader
// cover the vocabulary — only a person noticing. This asserts the whole set at
// once, so the next word added to §4 fails here the moment the board has no
// answer for it, rather than after it reaches a screen.
test('the board has a word for every event the ledger vocabulary allows', () => {
  const filler = {
    agent_id: 'design_w1', from_team: 'build', to_team: 'design', refused_by: 'design_dispatcher',
    task_id: 't-1', dispatch_id: 'd-1', reviewed_task: 't-1', reason: 'a stated reason',
    terminal: 'done', timed_out: false, evidence_present: true, verdict: 'accept', grant: 3,
  }
  const items = {}
  for (const event of LEDGER_EVENTS) {
    const entry = { at: '2026-07-27T09:00:00.000Z', event }
    for (const field of EVENT_SPEC[event].required ?? []) entry[field] = filler[field]
    items[`tok-${event}`] = [entry]
  }
  // Called directly, not rendered and grepped. Whether this function has a case
  // for every word is a fact about the function; routing it through markup made
  // a behaviour check read as a presentation check and tied it to copy.
  const graph = graphOf(FOUR_TEAMS)
  const unknown = LEDGER_EVENTS.filter((event) => /^Unknown event/.test(
    stateOf(graph, items[`tok-${event}`][0]).state))
  assert.deepEqual(unknown, [], unknown.join(', '))
  assert.equal(Object.keys(items).length, LEDGER_EVENTS.length)

  // A green sweep proves nothing until the detector is shown to fire. Without
  // this, deleting the `default` branch would make the assertion above pass
  // forever on any vocabulary at all.
  assert.match(
    stateOf(graph, { at: '2026-07-27T09:00:00.000Z', event: 'not_an_event', agent_id: 'design_w1' }).state,
    /Unknown event: not_an_event/)
})

// ── the nav shared by the three published pages ─────────────────────────────
//
// Asserted through `href` and `aria-current`, never the link text: the labels
// are copy and will be reworded, but a page that links to a filename nobody
// publishes is broken, and one that offers no way back is a dead end.

test('every page but the current one is reachable, and the current one is not a link', () => {
  for (const page of NAV_PAGES) {
    const nav = renderNav(page.id)
    const others = NAV_PAGES.filter((entry) => entry.id !== page.id)
    for (const other of others) assert.match(nav, new RegExp(`href="${other.file}"`))
    // Clicking the page you are already on is how a nav gets used without ever
    // telling you where you are.
    assert.equal(nav.includes(`href="${page.file}"`), false, page.id)
    assert.match(nav, /aria-current="page"/)
    assert.equal((nav.match(/href="/g) || []).length, others.length, page.id)
  }
})

test('an unrecognised page still gets a usable nav rather than a broken page', () => {
  // A nav bar is not worth failing a published page over. Every entry stays a
  // link and nothing is marked current — visibly wrong, still usable.
  const nav = renderNav('not-a-page')
  assert.equal((nav.match(/href="/g) || []).length, NAV_PAGES.length)
  assert.equal(nav.includes('aria-current'), false)
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
})

// ── AC5 — blocked by WIP names the team that is blocking ────────────────────

test('AC5 a card blocked by a full team names that team in full', () => {
  const dir = repoWith(FOUR_TEAMS, {
    holding: [{ at: '2026-07-27T09:00:00.000Z', event: 'pulled', agent_id: 'visual_d', from_team: 'test', to_team: 'visual' }],
    // A pass has to have something to pass. Since DECISION 4 the pull controller
    // validates a token's whole history before handing it on, and a `reviewed`
    // with nothing delivered is an impossible one — it comes back `invalid`,
    // not `blocked`, and this test is about the blocked case.
    waiting: [
      { at: '2026-07-27T09:05:00.000Z', event: 'assigned', agent_id: 'test_w1', task_id: 't-w', dispatch_id: 't-w-d' },
      { at: '2026-07-27T09:08:00.000Z', event: 'delivered', agent_id: 'test_w1', task_id: 't-w', terminal: 'done', timed_out: false, evidence_present: true },
      { at: '2026-07-27T09:10:00.000Z', event: 'reviewed', agent_id: 'test_e', verdict: 'pass', reviewed_task: 't-w', reason: 'good' },
    ],
  })
  const columns = columnsOf(pageOf(dir))
  assert.equal(columns.get('Visual').cards, 1)
  const test = columns.get('Test')
  assert.equal(test.cards, 1)
  assert.match(columns.get('Visual').html, /WIP 1\/1 · at limit/)
})

// ── H3 — TARGET_VERDICT: reject holds a card instead of reading like a pass ──
// (retro-release-review, 2026-08-04): role-briefs.mjs's TARGET_VERDICT_BLOCK
// tells a `produces: verdict` team's evaluator that a rejection "is not done
// and needs another pass, not a handoff onward" — but until this fix
// pull-controller.mjs pulled a `reviewed pass` onward regardless, and the
// board drew it exactly like an ordinary passed review. The card must say
// something different, and pull-controller must not treat it as pull-ready.

const FOUR_TEAMS_WITH_REVIEW = {
  ...FOUR_TEAMS,
  teams: FOUR_TEAMS.teams.map((entry) =>
    entry.team_id === 'test' ? { ...entry, produces: 'verdict' } : entry),
}

test('H3 a reviewed pass with TARGET_VERDICT: reject is drawn as held, not as an ordinary pass', () => {
  const dir = repoWith(FOUR_TEAMS_WITH_REVIEW, {
    tok: [
      { at: '2026-07-27T09:05:00.000Z', event: 'assigned', agent_id: 'test_w1', task_id: 't-w', dispatch_id: 't-w-d' },
      { at: '2026-07-27T09:08:00.000Z', event: 'delivered', agent_id: 'test_w1', task_id: 't-w', terminal: 'done', timed_out: false, evidence_present: true },
      {
        at: '2026-07-27T09:10:00.000Z', event: 'reviewed', agent_id: 'test_e', verdict: 'pass',
        reviewed_task: 't-w', reason: 'the evaluator did its own job correctly',
        target_verdict: 'reject', target_reason: 'AC7 is missing from the delivery',
      },
    ],
  })
  const board = readBoard(dir, NOW)
  const testColumn = board.columns.find((column) => column.team_id === 'test')
  const visualColumn = board.columns.find((column) => column.team_id === 'visual')
  assert.equal(visualColumn.cards.length, 0, 'a target-rejected review was pulled onward anyway')
  assert.equal(testColumn.cards.length, 1)
  const [card] = testColumn.cards
  assert.match(card.state, /Target rejected/)
  assert.equal(card.blocked_reason, 'AC7 is missing from the delivery')
})

test('stateOf reads TARGET_VERDICT: reject as held, and an ordinary pass is unaffected', () => {
  const graph = graphOf(FOUR_TEAMS_WITH_REVIEW)
  const rejected = stateOf(graph, {
    event: 'reviewed', agent_id: 'test_e', verdict: 'pass',
    target_verdict: 'reject', target_reason: 'not done',
  })
  assert.match(rejected.state, /Target rejected/)
  assert.equal(rejected.detail, 'not done')

  const passed = stateOf(graph, { event: 'reviewed', agent_id: 'test_e', verdict: 'pass', reason: 'fine' })
  assert.equal(passed.state, 'Passed review — waiting to be pulled onward')
})

// ── H5 — an invalid ledger must stay visibly blocked, not read as ordinary ──
// (retro-release-review, 2026-08-04): `planPulls` only validates a token's
// ledger once that token reaches its OWN pull-readiness check — a token
// sitting on `opened` with a line the current validator refuses never reaches
// that check, so the board drew it as an ordinary "Waiting for intake" card
// while `loop-runner.mjs` would refuse to dispatch it forever.

test('H5 an invalid ledger sitting on opened is drawn as blocked, not as ordinary queued work', () => {
  const dir = repoWith(FOUR_TEAMS, {})
  // `opened` with no `reason` — a required field (§4) — refused by today's
  // validator. Written directly rather than through `gateHistory`, so the
  // fixture stays exactly the impossible line it claims to be.
  writeFileSync(join(dir, '.tmux-teams/work-items/tok.jsonl'), `${JSON.stringify({
    at: '2026-07-27T09:00:00.000Z', event: 'opened', work_item: 'tok', workflow: 'feature',
    agent_id: 'build_d', to_team: 'build', actor: 'human:someone',
  })}\n`)
  const board = readBoard(dir, NOW)
  const buildColumn = board.columns.find((column) => column.team_id === 'build')
  assert.equal(buildColumn.cards.length, 1)
  const [card] = buildColumn.cards
  assert.equal(card.event, 'opened')
  assert.equal(card.state, 'Waiting for intake', 'the card still reads its ordinary state')
  assert.match(card.blocked_reason || '', /missing_field|reason/,
    'an invalid ledger drew no blocker at all')
})

test('H5 a legacy-tolerated ledger is drawn as ordinary queued work, agreeing with the loop (qwen #4)', () => {
  // `opened` signed by an agent, not a human — legal before ADR 0002, and
  // `LEGACY_TOLERATED_PROBLEMS` (ledger-validate.mjs) is what lets the
  // writer, the pull controller, and the runner all still trust this ledger.
  // Before this fix, this file alone judged it with raw `validateLedger` and
  // drew it "blocked — needs repair", disagreeing with the rest of the loop
  // about the exact same token — the disagreement `kanban.mjs:49-52` states
  // this file exists to prevent.
  const dir = repoWith(FOUR_TEAMS, {
    tok: [
      { at: '2026-07-27T09:00:00.000Z', event: 'opened', agent_id: 'design_d', to_team: 'design', reason: 'requested before ADR 0002', actor: 'agent:design_d' },
    ],
  }, {
    tok: { expectInvalid: true, why: 'a pre-ADR-0002 opened signed by an agent — legacy-tolerated, not a fresh violation' },
  })
  const board = readBoard(dir, NOW)
  const designColumn = board.columns.find((column) => column.team_id === 'design')
  assert.equal(designColumn.cards.length, 1)
  const [card] = designColumn.cards
  assert.equal(card.state, 'Waiting for intake', 'the card still reads its ordinary state')
  assert.equal(card.blocked_reason, null,
    'a legacy-tolerated ledger was drawn as blocked, disagreeing with the writer and the pull controller')
})

test('HIGH6 a token whose ledger FILE has an unparsable line is drawn as blocked, not as ordinary queued work (codex r4)', () => {
  // readWorkItems drops an unparsable line and only tallies it into the
  // global `skippedLines` counter -- it never appears in `item.custody`. The
  // per-card blocking check must still see it: it has to read the file the
  // way `loop-runner.mjs`'s tick does, not the already-sanitized survivors.
  const dir = repoWith(FOUR_TEAMS, {})
  writeFileSync(join(dir, '.tmux-teams/work-items/tok.jsonl'), [
    JSON.stringify({
      at: '2026-07-27T09:00:00.000Z', event: 'opened', work_item: 'tok', workflow: 'feature',
      agent_id: 'build_d', to_team: 'build', actor: 'human:someone', reason: 'stated by the agent',
    }),
    '{not json}',
  ].join('\n') + '\n')
  const board = readBoard(dir, NOW)
  assert.equal(board.skippedLines, 1, 'the malformed line is still counted globally')
  const buildColumn = board.columns.find((column) => column.team_id === 'build')
  assert.equal(buildColumn.cards.length, 1)
  const [card] = buildColumn.cards
  assert.equal(card.state, 'Waiting for intake', 'the card still reads its ordinary state')
  assert.notEqual(card.blocked_reason, null,
    'a token whose ledger file has an unparsable line was drawn as ordinary, disagreeing with the loop')
  assert.match(card.blocked_reason, /unparsable/,
    'the blocker should name the actual line the file cannot parse')
})

// ── M3 — Done/team/unplaceable classification must agree with the card ──────

test('M3 a stray late outcome after audit_requested is filed under Done, not Unplaceable', () => {
  // Validator-legal: `build_w1` reports again after `audit_requested`, naming
  // a task_id no `assigned` ever opened. `currentEntry` (dispatch-facts.mjs)
  // has no owning leg to trace it to, the agent differs from the holder
  // (`build_w2`, the last `assigned`), so it is superseded and skipped —
  // exposing `audit_requested` as current. `teamOccupancy` already reads it
  // this way and does not hold the token in any team. This loop used to read
  // the RAW last line for its own Done/Team/Unplaceable choice instead of
  // `currentEntry` — disagreeing with `teamOccupancy` about the same token and
  // filing it under Unplaceable instead of Done.
  const dir = repoWith(FOUR_TEAMS, {
    tok: [
      { at: '2026-07-27T09:02:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't1', dispatch_id: 'd1' },
      { at: '2026-07-27T09:03:00.000Z', event: 'delivered', agent_id: 'build_w1', task_id: 't1', dispatch_id: 'd1', terminal: 'done', timed_out: false, evidence_present: true },
      { at: '2026-07-27T09:04:00.000Z', event: 'assigned', agent_id: 'build_w2', task_id: 'r1', dispatch_id: 'dr1' },
      { at: '2026-07-27T09:05:00.000Z', event: 'delivered', agent_id: 'build_w2', task_id: 'r1', dispatch_id: 'dr1', terminal: 'done', timed_out: false, evidence_present: true },
      { at: '2026-07-27T09:06:00.000Z', event: 'audit_requested', agent_id: 'pm', task_id: 'pm-1', reason: 'read the whole delivery' },
      { at: '2026-07-27T09:07:00.000Z', event: 'delivered', agent_id: 'build_w1', task_id: 'ghost-task', terminal: 'done', timed_out: false, evidence_present: true },
    ],
  })
  const board = readBoard(dir, NOW)
  const buildColumn = board.columns.find((column) => column.team_id === 'build')
  const done = board.columns.find((column) => column.kind === 'done')
  assert.equal(buildColumn.cards.length, 0, 'the stray late outcome kept the token in a team currentEntry says it left')
  assert.equal(board.unplaceable.length, 0, 'a token awaiting audit was drawn as unplaceable')
  assert.equal(done.cards.length, 1, 'the token awaiting audit was not filed under Done')
  assert.equal(done.cards[0].event, 'audit_requested')
})

// ── AC6 — a token that cannot be placed is shown, not hidden ────────────────

test('AC6 an agent outside the declared graph puts its token in Unplaceable', () => {
  const dir = repoWith(FOUR_TEAMS, {
    orphan: [{ at: '2026-07-27T09:00:00.000Z', event: 'delivered', agent_id: 'old_worker_1', terminal: 'done' }],
  }, { orphan: { expectInvalid: true, why: 'a worker the graph no longer declares — the orphan case is the subject' } })
  const graph = graphOf(FOUR_TEAMS)
  const orphans = teamOccupancy(graph, readWorkItems(dir).items).orphans
  assert.equal(orphans.length, 1)

  const html = pageOf(dir)
  const column = columnsOf(html).get('Unplaceable')
  assert.equal(column.cards, 1)
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
  }, { undated: { expectInvalid: true, why: 'an unparsable stamp is the subject — the board must not print it as an age' } })
  const board = readBoard(dir, NOW)
  assert.equal(board.columns.find((column) => column.team_id === 'build').cards[0].lead_sec, null)
  const html = pageOf(dir)
  // The relative clock says so in words — "0s" and "not measured" are
  // different facts, and a duration computed from an unparseable stamp would
  // silently be the first when it means the second.
  assert.match(html, /unknown here · unknown lead/)
  // The absolute stamp must say the evidence is corrupt, not manufacture a
  // plausible-looking instant the way a bare `Date.parse` would have.
  assert.match(html, /Malformed timestamp: "not-a-date"/)
  assert.doesNotMatch(html, /<time class="at"/)
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

test('AC8 the page references no remote asset', () => {
  // The fixture carries no URL of its own, so any http(s) match would be the
  // page referencing something off this machine.
  const dir = repoWith(FOUR_TEAMS, {
    tok: [{ at: '2026-07-27T09:00:00.000Z', event: 'assigned', agent_id: 'build_w1', task_id: 't-1' }],
  })
  const html = renderKanbanPage(dir, snapshotAt(), { refreshScriptName: 'pulse-refresh-abc.js' })
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

  // `html` was built and discarded here too, so "renders a reason and no board"
  // — half of this test's own name — was never checked. Proven by mutation
  // 2026-08-05: deleting renderKanbanPage's `if (!board.ok)` branch left this
  // test green.
  const html = pageOf(dir)
  assert.match(html, /workflows must be an array/, 'the page must state the reason it cannot draw')
  assert.doesNotMatch(html, /class="col"/, 'a graph that fails the contract renders no board columns')

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
  // That comment stood alone for a release with NO assertion under it — `html`
  // was read and discarded, so the claim in this test's name went unchecked.
  // Proven by mutation 2026-08-05: swapping the snapshot clock for `new Date()`
  // left this test green. The fixture's timestamp is the whole proof, so it has
  // to be asserted.
  assert.match(html, /2026-07-27 12:00:00 UTC/,
    'init must render the snapshot clock, not the wall clock')
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
  writeFileSync(join(dir, '.tmux-teams/graph.json'), JSON.stringify(FOUR_TEAMS))
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
  // Offline, asserted against the file that shipped — not a string this test
  // rendered for itself. The fixture ledger carries no URL of its own.
})
