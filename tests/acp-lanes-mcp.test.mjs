import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handle, callTool, laneFacts, laneStatus }
  from '../plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs'
import { REVIEW_PROFILES }
  from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins', 'tmux-teams')

const call = (name, args, env) => JSON.parse(handle({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
}, env).result.content[0].text)

test('the declaration reaches a real file, which is the way this fails silently', () => {
  // The shape that has bitten this repository before: the deepseek reserve lane
  // was declared for months and no test ever reached it, so two defects sat in
  // a path nothing executed. A `.mcp.json` naming a script that is not there
  // fails exactly that way — the plugin installs, the server never starts, and
  // nothing says why.
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'))
  const server = manifest.mcpServers['tmux-teams-acp-lanes']
  assert.equal(server.type, 'stdio')
  const args = server.args ?? []
  const target = args.find(a => a.includes('.mjs'))
  assert.ok(target, 'the server declaration names no script at all')
  assert.ok(target.startsWith('${CLAUDE_PLUGIN_ROOT}/'),
    'the path must be plugin-root relative — an absolute path is one machine\'s answer')
  const onDisk = join(PLUGIN, target.replace('${CLAUDE_PLUGIN_ROOT}/', ''))
  assert.ok(existsSync(onDisk), `.mcp.json points at a file that is not shipped: ${onDisk}`)
  assert.ok(!isAbsolute(target), 'the declared path must not be absolute')
})

test('every declared lane is listed, and the list is pinned rather than derived from itself', () => {
  const out = callTool('acp_lanes', {}, {})
  const listed = out.lanes.map(l => l.lane).sort()
  // Pinned literally. A test that only compared this against Object.keys of the
  // same object would keep passing while a lane quietly disappeared -- the
  // iterate-the-constant shape this repository already has a rule about.
  assert.deepEqual(listed, ['agy', 'claude', 'codex', 'deepseek', 'kimi', 'qwen', 'zai'])
  assert.deepEqual(listed, Object.keys(REVIEW_PROFILES).sort(),
    'the tool and the profile registry disagree about which lanes exist')
  const zai = out.lanes.find(l => l.lane === 'zai')
  assert.equal(zai.routing, 'pinned:api.z.ai/api/anthropic')
  const agy = out.lanes.find(l => l.lane === 'agy')
  assert.equal(agy.routing, 'unrouted', 'agy declares no endpoint pin and must not claim one')
  assert.equal(agy.model, 'gemini-3.7-flash-high')
})

test('declared facts need nothing from this machine', () => {
  // The whole point of splitting facts from status: an operator on a fresh
  // machine with no profiles at all can still ask what lanes exist.
  const out = callTool('acp_lanes', {}, { HOME: '/nonexistent' })
  assert.equal(out.lanes.length, 7)
  assert.ok(out.lanes.every(l => l.adapter), 'a lane with no adapter package is not a usable answer')
})

test('a lane that cannot run says what is missing and which variable points at it', () => {
  const out = call('acp_lane_status', { lane: 'zai' }, { HOME: '/nonexistent-layout', PATH: process.env.PATH })
  const [lane] = out.lanes
  assert.equal(lane.ready, false)
  assert.match(lane.problem, /ANTHROPIC_BASE_URL/)
  // Both overrides, because a machine can differ in either direction: the
  // settings file somewhere else, or the credential deliberately kept out of it
  // (measured on the Ubuntu review host, 2026-08-13).
  const fixes = lane.fixes.join(' ')
  assert.match(fixes, /TMUX_TEAMS_REVIEW_ZAI_SETTINGS/)
  assert.match(fixes, /TMUX_TEAMS_REVIEW_ZAI_ENV_FILE/)
})

test('a lane that CAN run says so, through the same function a real run uses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-'))
  try {
    const settings = join(dir, 'zai.json')
    writeFileSync(settings, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-token-that-must-never-be-echoed',
      },
    }))
    const out = call('acp_lane_status', { lane: 'zai' }, {
      HOME: '/nonexistent-layout',
      PATH: process.env.PATH,
      TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings,
    })
    assert.equal(out.lanes[0].ready, true)
    assert.equal(out.lanes[0].problem, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a credential never appears in an answer, not even when the lane is ready', () => {
  // The strongest guard here, and the reason readiness is decided by handing the
  // work to buildAcpLaunch rather than by inspecting anything: the env it builds
  // CONTAINS the token, and this server must never carry it outward. Asserting
  // over the serialised reply catches a future field that leaks it by accident.
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-secret-'))
  try {
    const secret = 'sk-do-not-echo-' + 'z'.repeat(24)
    const settings = join(dir, 'zai.json')
    writeFileSync(settings, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: secret },
    }))
    const env = { HOME: '/nonexistent-layout', PATH: process.env.PATH, TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings }
    const reply = handle({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'acp_lane_status', arguments: { lane: 'zai' } },
    }, env)
    const wire = JSON.stringify(reply)
    assert.equal(JSON.parse(reply.result.content[0].text).lanes[0].ready, true,
      'the fixture must actually make the lane ready, or this proves nothing')
    assert.ok(!wire.includes(secret), 'the credential reached the wire')
    assert.ok(!wire.includes('ANTHROPIC_AUTH_TOKEN'), 'the credential field name reached the wire')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown lane is answered, not crashed on', () => {
  const out = callTool('acp_lane_status', { lane: 'no-such-lane' }, {})
  assert.match(out.error, /no such lane/)
  assert.ok(out.known.includes('zai'), 'refusing without saying what does exist is half an answer')
})

test('the two tools are advertised, and nothing that could start a lane is', () => {
  const tools = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools
  assert.deepEqual(tools.map(t => t.name), ['acp_lanes', 'acp_lane_status'])
  // Read-only is a property of the SURFACE, not a promise in a comment: if a
  // tool that dispatches is ever added, this is what refuses it. ADR 0003 keeps
  // its own guarantee separately -- a dispatched agent still receives no MCP
  // server at all, which is a different mechanism from this list.
  const names = tools.map(t => t.name).join(' ')
  for (const verb of ['dispatch', 'run', 'start', 'spawn', 'review_now']) {
    assert.ok(!names.includes(verb), `an action verb appeared in the tool surface: ${verb}`)
  }
})

test('a notification gets no reply and an unknown method gets an error', () => {
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const bad = handle({ jsonrpc: '2.0', id: 9, method: 'tools/nope' })
  assert.equal(bad.error.code, -32601)
})

test('initialize reports the shipped plugin version rather than a literal of its own', () => {
  const declared = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const info = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).result.serverInfo
  assert.equal(info.version, declared,
    'the server carries its own version literal — that is an eighth place to bump')
  assert.equal(info.name, 'tmux-teams-acp-lanes')
})

test('laneStatus and laneFacts agree about a lane, so the two answers cannot drift', () => {
  const facts = laneFacts('qwen', REVIEW_PROFILES.qwen)
  const status = laneStatus('qwen', REVIEW_PROFILES.qwen, { HOME: '/nonexistent-layout' })
  for (const key of Object.keys(facts)) {
    assert.deepEqual(status[key], facts[key], `status disagrees with facts about ${key}`)
  }
})
