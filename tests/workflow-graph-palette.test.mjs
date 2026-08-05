// workflow-graph-palette.test.mjs — GitHub #47 phase 1: the shape a graph may
// declare for ONE seat's candidate models, and nothing past that.
//
// This phase does not touch dispatch: it makes a graph ABLE to declare a
// palette on a seat, makes an invalid one refused, and proves `wip_limit`
// stays derived from the worker count regardless of how long a palette grows
// (§3.1, §3.5). `loop-runner.mjs` is untouched and out of scope here.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateWorkflowGraph } from '../plugins/tmux-teams/skills/tmux-teams/scripts/workflow-graph.mjs'

const ESC = String.fromCharCode(0x1b)

const MODELS = { dispatcher: 'model-d', worker: 'model-w', evaluator: 'model-e' }

const teamOf = (id, workers, extra = {}) => ({
  team_id: id,
  name: id.toUpperCase(),
  dispatcher_id: `${id}_d`,
  worker_ids: workers,
  evaluator_id: `${id}_e`,
  models: { ...MODELS },
  ...extra,
})

const graphWith = (overrides = {}) => ({
  project_id: 'p',
  outer_controller_id: 'pm',
  outer_controller_model: 'model-pm',
  teams: [teamOf('build', ['b_w1', 'b_w2']), teamOf('verify', ['v_w1'])],
  workflows: [{ workflow_id: 'full', name: 'Full', route: ['build', 'verify'] }],
  ...overrides,
})

const accepted = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, true, result.reason ?? 'expected an accepted graph')
  return result.value
}

const rejected = (value) => {
  const result = validateWorkflowGraph(value)
  assert.equal(result.ok, false, 'expected a rejected graph')
  assert.equal(result.value, null, 'a rejected graph carries no value')
  assert.equal(typeof result.reason, 'string')
  assert.ok(result.reason.length > 0, 'a rejection states a reason')
  return result.reason
}

const paletteEntry = (model, extra = {}) => ({ model, ...extra })

// ── a palette declares and validates, every existing graph unaffected ───────

test('a graph with no palette anywhere is exactly the graph it already was', () => {
  const withoutSeats = accepted(graphWith())
  const withEmptySeats = accepted(graphWith({
    teams: [teamOf('build', ['b_w1', 'b_w2'], { seats: {} }), teamOf('verify', ['v_w1'])],
  }))
  assert.equal(withEmptySeats.source_digest, withoutSeats.source_digest)
  for (const team of withoutSeats.teams) {
    for (const agent of team.agents) assert.equal(agent.palette, null)
  }
})

test('a seat with a valid two-entry palette loads and validates', () => {
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1', 'b_w2'], {
        seats: {
          b_w2: {
            palette: [
              paletteEntry('qwen3.8-max', { adapter: 'claude', bucket: 'opus' }),
              paletteEntry('k3', { adapter: 'claude', bucket: 'fable' }),
            ],
          },
        },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const build = value.teams.find((team) => team.team_id === 'build')
  const seat = build.agents.find((agent) => agent.agent_id === 'b_w2')
  assert.deepEqual(seat.palette, [
    { model: 'qwen3.8-max', adapter: 'claude', effort: null, display_model: null, bucket: 'opus' },
    { model: 'k3', adapter: 'claude', effort: null, display_model: null, bucket: 'fable' },
  ])
  // A palette's first entry is the starting point (§3.5): the single-value
  // fields resolve to it so an unmodified reader sees a sane seat spec.
  assert.equal(seat.model, 'qwen3.8-max')
  assert.equal(seat.adapter, 'claude')
  // Its neighbour on the same role, with no palette, is untouched.
  const sibling = build.agents.find((agent) => agent.agent_id === 'b_w1')
  assert.equal(sibling.palette, null)
  assert.equal(sibling.model, build.models.worker)
})

test('a bucket left unstated defaults to the entry\'s own resolved lane', () => {
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1'], {
        seats: {
          b_w1: {
            palette: [
              paletteEntry('cheap-model', { adapter: 'codex' }),
              paletteEntry('strong-model', { adapter: 'agy' }),
            ],
          },
        },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const seat = value.teams[0].agents.find((agent) => agent.agent_id === 'b_w1')
  assert.equal(seat.palette[0].bucket, 'codex')
  assert.equal(seat.palette[1].bucket, 'agy')
})

// ── wip_limit is unaffected — the whole point of the item (§3.1) ───────────

test('wip_limit does not change when a palette grows to eight entries', () => {
  const bigPalette = Array.from({ length: 8 }, (_, index) =>
    paletteEntry(`model-${index}`, { bucket: `bucket-${index}` }))
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1'], { seats: { b_w1: { palette: bigPalette } } }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const build = value.teams.find((team) => team.team_id === 'build')
  assert.equal(build.worker_ids.length, 1)
  assert.equal(build.wip_limit, 1, 'four, or eight, candidate models is still one seat of WIP')
})

// ── every way of declaring an invalid entry, naming the team, the seat and the field ──

test('a palette that is not an array, empty, or too long is rejected, naming the team and the seat', () => {
  for (const bad of ['not-an-array', [], Array.from({ length: 9 }, (_, i) => paletteEntry(`m${i}`))]) {
    const reason = rejected(graphWith({
      teams: [teamOf('build', ['b_w1'], { seats: { b_w1: { palette: bad } } }), teamOf('verify', ['v_w1'])],
    }))
    assert.match(reason, /build/)
    assert.match(reason, /b_w1/)
    assert.match(reason, /palette/)
  }
})

test('a palette entry with a missing or invalid model is rejected, naming the team, the seat and the field', () => {
  for (const bad of [{}, { model: '' }, { model: `x${ESC}[31m` }, { model: 'm'.repeat(129) }]) {
    const reason = rejected(graphWith({
      teams: [teamOf('build', ['b_w1'], { seats: { b_w1: { palette: [bad] } } }), teamOf('verify', ['v_w1'])],
    }))
    assert.match(reason, /build/)
    assert.match(reason, /b_w1/)
    assert.match(reason, /model/)
  }
})

test('a palette entry with an invalid display_model, adapter, effort or bucket is rejected, naming the field', () => {
  const cases = [
    [{ model: 'm', display_model: '' }, /display_model/],
    [{ model: 'm', adapter: 'kimi' }, /adapter/],
    [{ model: 'm', effort: '' }, /reasoning effort/],
    [{ model: 'm', bucket: '' }, /bucket/],
    [{ model: 'm', bucket: `x${ESC}` }, /bucket/],
  ]
  for (const [entry, needle] of cases) {
    const reason = rejected(graphWith({
      teams: [teamOf('build', ['b_w1'], { seats: { b_w1: { palette: [entry] } } }), teamOf('verify', ['v_w1'])],
    }))
    assert.match(reason, /build/)
    assert.match(reason, /b_w1/)
    assert.match(reason, needle)
  }
})

test('an unknown key on a palette entry is rejected, naming the team and the seat', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { seats: { b_w1: { palette: [{ model: 'm', modle: 'typo' }] } } }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /b_w1/)
  assert.match(reason, /unknown key/)
})

test('a palette entry that is not an object is rejected, naming the team and the seat', () => {
  const reason = rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { seats: { b_w1: { palette: ['claude-opus'] } } }), teamOf('verify', ['v_w1'])],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /b_w1/)
})

// ── palette replaces the single-value fields, it does not sit beside them ──

test('a palette alongside model, adapter, effort or display_model on the same seat is rejected', () => {
  for (const override of [
    { model: 'm', palette: [paletteEntry('a'), paletteEntry('b', { bucket: 'x' })] },
    { adapter: 'codex', palette: [paletteEntry('a'), paletteEntry('b', { bucket: 'x' })] },
    { effort: 'high', palette: [paletteEntry('a'), paletteEntry('b', { bucket: 'x' })] },
    { display_model: 'm', palette: [paletteEntry('a'), paletteEntry('b', { bucket: 'x' })] },
  ]) {
    const reason = rejected(graphWith({
      teams: [teamOf('build', ['b_w1'], { seats: { b_w1: override } }), teamOf('verify', ['v_w1'])],
    }))
    assert.match(reason, /build/)
    assert.match(reason, /b_w1/)
    assert.match(reason, /palette/)
  }
})

// ── the rule the whole design turns on: consecutive same-bucket entries ────

test('two consecutive palette entries in the same bucket are refused', () => {
  const reason = rejected(graphWith({
    teams: [
      teamOf('build', ['b_w1'], {
        seats: {
          b_w1: {
            palette: [
              paletteEntry('qwen3.8-max', { bucket: 'opus' }),
              paletteEntry('k3', { bucket: 'opus' }),
            ],
          },
        },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /b_w1/)
  assert.match(reason, /opus/)
})

test('two consecutive entries on the same lane with no declared bucket are refused, because the bucket defaults to the lane', () => {
  const reason = rejected(graphWith({
    teams: [
      teamOf('build', ['b_w1'], {
        seats: { b_w1: { palette: [paletteEntry('model-a', { adapter: 'claude' }), paletteEntry('model-b', { adapter: 'claude' })] } },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  assert.match(reason, /build/)
  assert.match(reason, /b_w1/)
})

test('a bucket repeated but NOT consecutive is accepted — only adjacency is refused', () => {
  const value = accepted(graphWith({
    teams: [
      teamOf('build', ['b_w1'], {
        seats: {
          b_w1: {
            palette: [
              paletteEntry('model-a', { bucket: 'opus' }),
              paletteEntry('model-b', { bucket: 'fable' }),
              paletteEntry('model-c', { bucket: 'opus' }),
            ],
          },
        },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  const seat = value.teams[0].agents.find((agent) => agent.agent_id === 'b_w1')
  assert.deepEqual(seat.palette.map((entry) => entry.bucket), ['opus', 'fable', 'opus'])
})

// ── mutation check target: the DECISION, not the wording ───────────────────
//
// Removing the consecutive-bucket check must turn this from a rejection into
// an acceptance. Asserted on `result.ok`, not on any particular message text.
test('mutation check: a same-bucket adjacent pair is rejected outright, not merely warned about', () => {
  const result = validateWorkflowGraph(graphWith({
    teams: [
      teamOf('build', ['b_w1'], {
        seats: { b_w1: { palette: [paletteEntry('model-a', { bucket: 'x' }), paletteEntry('model-b', { bucket: 'x' })] } },
      }),
      teamOf('verify', ['v_w1']),
    ],
  }))
  assert.equal(result.ok, false)
  assert.equal(result.value, null)
})

// ── existing seat-override refusals still fire the same way for a palette ──

test('a palette for a seat not on the team, or for the outer controller, is still refused', () => {
  assert.match(rejected(graphWith({
    teams: [teamOf('build', ['b_w1'], { seats: { ghost: { palette: [paletteEntry('m')] } } }), teamOf('verify', ['v_w1'])],
  })), /not a seat on this team/)

  assert.match(rejected(graphWith({
    outer_controller_id: 'pm',
    teams: [
      teamOf('control', ['pm'], { seats: { pm: { palette: [paletteEntry('m')] } } }),
      teamOf('build', ['b_w1']),
    ],
    workflows: [{ workflow_id: 'full', name: 'Full', route: ['control', 'build'] }],
  })), /outer controller/)
})
