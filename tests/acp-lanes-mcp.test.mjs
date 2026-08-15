import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { handle, callTool, laneFacts, laneStatus, classify, fixesFor,
  TOOLS, TOOL_DESCRIPTORS, DIAGNOSTICS, PROTOCOL_VERSION, UNCHECKED_LANES }
  from '../plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs'
import { REVIEW_PROFILES }
  from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins', 'tmux-teams')
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'))
const SERVER = MANIFEST.mcpServers['tmux-teams-acp-lanes']

const call = (name, args, env) => JSON.parse(handle({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
}, env).result.content[0].text)

const expand = (value) => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN)

test('the declaration names a command AND a script that both exist', () => {
  // The shape that has bitten this repository before: the deepseek reserve lane
  // was declared for months and no test ever reached it. A `.mcp.json` naming a
  // script that is not there fails that way — and so does one naming a command
  // that is not there, which the first version of this test could not see:
  // changing `node` to `node-does-not-exist` left it green.
  assert.equal(SERVER.type, 'stdio')
  assert.ok(SERVER.command, 'the declaration names no command')
  assert.equal(SERVER.cwd, '${CLAUDE_PLUGIN_ROOT}', 'cwd must be the plugin root, not a machine path')
  const target = (SERVER.args ?? []).find(a => a.includes('.mjs'))
  assert.ok(target, 'the server declaration names no script at all')
  assert.ok(target.startsWith('${CLAUDE_PLUGIN_ROOT}/'),
    'the path must be plugin-root relative — an absolute path is one machine\'s answer')
  assert.ok(!isAbsolute(target))
  assert.ok(existsSync(expand(target)), `.mcp.json points at a file that is not shipped: ${target}`)
})

test('every declared lane is listed, and the list is pinned rather than derived from itself', () => {
  const out = callTool('acp_lanes', {}, {})
  const listed = out.lanes.map(l => l.lane).sort()
  // Pinned literally. A test that only compared this against Object.keys of the
  // same object would keep passing while a lane quietly disappeared.
  assert.deepEqual(listed, ['agy', 'claude', 'codex', 'deepseek', 'kimi', 'qwen', 'zai'])
  assert.deepEqual(listed, Object.keys(REVIEW_PROFILES).sort(),
    'the tool and the profile registry disagree about which lanes exist')
  assert.equal(out.lanes.find(l => l.lane === 'zai').routing, 'pinned:api.z.ai/api/anthropic')
  assert.equal(out.lanes.find(l => l.lane === 'agy').routing, 'unrouted')
  assert.equal(out.lanes.find(l => l.lane === 'agy').model, 'gemini-3.7-flash-high')
})

test('declared facts need nothing from this machine', () => {
  const out = callTool('acp_lanes', {}, { HOME: '/nonexistent' })
  assert.equal(out.lanes.length, 7)
  assert.ok(out.lanes.every(l => l.adapter), 'a lane with no adapter package is not a usable answer')
})

test('a lane with no parent-side check says UNCHECKED, and never that it is fine', () => {
  // The defect a Codex advisor reproduced in one command against the first
  // version: with no HOME, no PATH and no credentials, `claude` and `codex`
  // both answered `ready: true`. Nothing validates those two, so a green
  // answer meant only "no check ran" — a diagnostic that says READY and then
  // watches the real gate refuse is worse than no diagnostic at all.
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  for (const lane of ['claude', 'codex']) {
    const [got] = call('acp_lane_status', { lane }, bare).lanes
    assert.equal(got.configuration, 'unchecked', `${lane} claimed a state nothing verified`)
    assert.match(got.note, /no parent-side configuration check/)
    assert.ok(!('ready' in got), 'the boolean that overclaimed is gone, not renamed alongside itself')
  }
  assert.deepEqual([...UNCHECKED_LANES].sort(), ['claude', 'codex'])
})

test('every status answer states what it did NOT prove', () => {
  const out = call('acp_lane_status', undefined, { HOME: '/definitely/nonexistent' })
  assert.equal(out.lanes.length, 7)
  for (const lane of out.lanes) {
    assert.ok(Array.isArray(lane.notProven) && lane.notProven.length >= 4,
      `${lane.lane} claims a state with no boundary stated beside it`)
    assert.ok(lane.notProven.some(x => /endpoint can be reached/.test(x)))
    assert.ok(['valid', 'invalid', 'unchecked'].includes(lane.configuration))
  }
})

test('a lane that cannot run says which closed diagnostic applies, never a raw message', () => {
  const [lane] = call('acp_lane_status', { lane: 'zai' },
    { HOME: '/nonexistent-layout', PATH: process.env.PATH }).lanes
  assert.equal(lane.configuration, 'invalid')
  assert.equal(lane.problem.code, 'endpoint_missing')
  assert.equal(lane.problem.detail, DIAGNOSTICS.endpoint_missing,
    'the detail must be a constant of the module, not text that came from a file')
  // The endpoint is what is missing, so the answer is about where the base URL
  // comes from — not the credential file, which is a different cause with a
  // different code. The previous version demanded both here, which is exactly
  // the every-sentence-available answer the second advisor round rejected.
  const fixes = lane.fixes.join(' ')
  assert.match(fixes, /TMUX_TEAMS_REVIEW_ZAI_SETTINGS/)
  assert.ok(!/TMUX_TEAMS_REVIEW_ZAI_ENV_FILE/.test(fixes),
    'a missing endpoint was answered with credential advice')
})

test('a fix names the thing that actually refused, not every setup step available', () => {
  // The second advisor round called the first version of this symptom repair:
  // `fixesFor` ignored the cause entirely, so `agy` — which fails because a
  // trusted `agy` binary is absent — was told to repair the ADAPTER PACKAGE.
  // Non-empty was never the property worth asserting.
  const agy = fixesFor('agy', REVIEW_PROFILES.agy, 'executable_missing', { HOME: '/h' })
  assert.ok(agy.some(f => /trusted `agy` binary/.test(f) && /\/h\/\.local\/bin\/agy/.test(f)),
    `agy is not told about the binary the parent actually looked for: ${agy.join(' | ')}`)

  // A missing endpoint is not answered with executable advice, and a missing
  // executable is not answered with settings advice.
  const endpoint = fixesFor('zai', REVIEW_PROFILES.zai, 'endpoint_missing', {})
  assert.ok(endpoint.every(f => !/must resolve|wrapper/.test(f)),
    `an endpoint problem was answered with executable advice: ${endpoint.join(' | ')}`)
  assert.ok(endpoint.some(f => /TMUX_TEAMS_REVIEW_ZAI_SETTINGS/.test(f)))

  const credential = fixesFor('zai', REVIEW_PROFILES.zai, 'credential_missing', {})
  assert.match(credential[0], /TMUX_TEAMS_REVIEW_ZAI_ENV_FILE/,
    'a missing credential must lead with the file that carries one')

  const unreadable = fixesFor('zai', REVIEW_PROFILES.zai, 'settings_unreadable', {})
  assert.match(unreadable[0], /must parse/)

  for (const [id, profile] of Object.entries(REVIEW_PROFILES)) {
    assert.ok(fixesFor(id, profile, 'unclassified', {}).length > 0, `${id} is answered with no fixes`)
  }
})

test('a routed lane names the WRAPPER among the things it did not prove', () => {
  // Measured by an advisor against the previous version: pointing PATH at a
  // path that does not exist left a routed lane answering `valid`, while
  // `notProven` named only the adapter package. The profile models the adapter
  // and the wrapper as separate fields, so a caveat about one does not cover
  // the other.
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-wrapper-'))
  try {
    const settings = join(dir, 'zai.json')
    writeFileSync(settings, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'x' },
    }))
    const [lane] = call('acp_lane_status', { lane: 'zai' }, {
      HOME: '/nonexistent-layout', PATH: '/definitely/nonexistent',
      TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings,
    }).lanes
    assert.equal(lane.configuration, 'valid')
    assert.ok(lane.notProven.some(x => /wrapper `claude-zai`/.test(x)),
      `a valid answer with no wrapper on PATH did not name it: ${lane.notProven.join(' | ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed settings are diagnosed as unreadable, not shrugged at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-bad-json-'))
  try {
    const settings = join(dir, 'zai.json')
    writeFileSync(settings, '{ this is not json')
    const [lane] = call('acp_lane_status', { lane: 'zai' }, {
      HOME: '/nonexistent-layout', PATH: process.env.PATH,
      TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings,
    }).lanes
    assert.equal(lane.configuration, 'invalid')
    assert.equal(lane.problem.code, 'settings_unreadable',
      'a JSON.parse failure carries V8 wording that mentions nothing of ours, and used to fall through')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every diagnostic code the classifier can return has a constant sentence', () => {
  const codes = ['endpoint_missing', 'endpoint_mismatch', 'credential_missing',
    'settings_unreadable', 'executable_missing', 'unclassified']
  assert.deepEqual(Object.keys(DIAGNOSTICS).sort(), [...codes].sort())
  // and the classifier maps real messages onto them rather than onto `unclassified`
  assert.equal(classify('zai review requires ANTHROPIC_BASE_URL'), 'endpoint_missing')
  assert.equal(classify('zai review endpoint must be https://api.z.ai/api/anthropic'), 'endpoint_mismatch')
  assert.equal(classify('zai review endpoint requires an explicit provider credential'), 'credential_missing')
  assert.equal(classify('trusted agy executable not found'), 'executable_missing')
  assert.equal(classify('something nobody has seen before'), 'unclassified')
})

test('a lane whose configuration IS valid says so, and says only that', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-'))
  try {
    const settings = join(dir, 'zai.json')
    writeFileSync(settings, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-token-that-must-never-be-echoed',
      },
    }))
    const [lane] = call('acp_lane_status', { lane: 'zai' }, {
      HOME: '/nonexistent-layout', PATH: process.env.PATH,
      TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings,
    }).lanes
    assert.equal(lane.configuration, 'valid')
    assert.equal(lane.problem, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a credential never reaches the wire — on the success path OR any failure path', () => {
  // The strongest guard here. The earlier version tested only the success path,
  // and its failure path exported `String(error.message)` verbatim: a future
  // diagnostic downstream that interpolated a token would have shipped it with
  // nothing red. Each case below puts a unique secret somewhere real and then
  // asserts over the whole serialised reply.
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-secret-'))
  try {
    const secret = (tag) => `sk-do-not-echo-${tag}-` + 'z'.repeat(20)
    const cases = [
      ['ready', { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }, 'valid'],
      ['wrong-endpoint', { ANTHROPIC_BASE_URL: 'https://attacker.example/anthropic' }, 'invalid'],
      ['no-endpoint', {}, 'invalid'],
    ]
    for (const [tag, extra, expected] of cases) {
      const token = secret(tag)
      const settings = join(dir, `${tag}.json`)
      writeFileSync(settings, JSON.stringify({ env: { ...extra, ANTHROPIC_AUTH_TOKEN: token } }))
      const env = {
        HOME: '/nonexistent-layout', PATH: process.env.PATH,
        TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings,
      }
      const reply = handle({
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'acp_lane_status', arguments: { lane: 'zai' } },
      }, env)
      const wire = JSON.stringify(reply)
      const [lane] = JSON.parse(reply.result.content[0].text).lanes
      assert.equal(lane.configuration, expected,
        `the ${tag} fixture did not reach the state it exists to exercise`)
      assert.ok(!wire.includes(token), `${tag}: the credential reached the wire`)
      assert.ok(!wire.includes('ANTHROPIC_AUTH_TOKEN'), `${tag}: the credential field name reached the wire`)
    }
    // A credential supplied through the AMBIENT environment rather than a file.
    const ambient = secret('ambient')
    const wire = JSON.stringify(handle({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'acp_lane_status', arguments: {} },
    }, { HOME: '/nonexistent-layout', PATH: process.env.PATH, ANTHROPIC_AUTH_TOKEN: ambient }))
    assert.ok(!wire.includes(ambient), 'an ambient credential reached the wire')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown lane is answered, not crashed on', () => {
  const out = callTool('acp_lane_status', { lane: 'no-such-lane' }, {})
  assert.match(out.error, /no such lane/)
  assert.ok(out.known.includes('zai'), 'refusing without saying what does exist is half an answer')
})

test('a handler that is not advertised cannot exist, because both come from one list', () => {
  // The earlier test scanned advertised NAMES for action verbs, which a hidden
  // branch in the dispatcher walks straight past. The dispatcher is now built
  // from the same descriptor list the advertisement is, so the property is
  // structural: this asserts the structure rather than the vocabulary.
  assert.deepEqual(TOOLS.map(t => t.name), ['acp_lanes', 'acp_lane_status'])
  assert.deepEqual(TOOL_DESCRIPTORS.map(d => d.name), TOOLS.map(t => t.name))
  assert.ok(TOOL_DESCRIPTORS.every(d => typeof d.handler === 'function'))
  assert.ok(TOOLS.every(t => !('handler' in t)), 'the handler must not be advertised to a client')
  const refused = callTool('launch_lane', {}, {})
  assert.match(refused.error, /no such tool/)
  assert.deepEqual(refused.known, ['acp_lanes', 'acp_lane_status'],
    'the dispatcher knows a name the advertisement does not')
})

test('initialize answers with the version this server speaks, never the caller\'s', () => {
  const asked = handle({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 'not-a-protocol-version' },
  }).result
  // Pinned as a literal as well as against the constant: comparing a constant
  // only against itself is the shape this repository has a rule about, and
  // mutating PROTOCOL_VERSION to garbage passed the previous version of this.
  assert.equal(asked.protocolVersion, '2025-06-18')
  assert.equal(asked.protocolVersion, PROTOCOL_VERSION,
    'echoing the request tells a client naming an unimplemented version that it got it')
  const declared = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version
  assert.equal(asked.serverInfo.version, declared,
    'the server carries its own version literal — that is an eighth place to bump')
  assert.equal(asked.serverInfo.name, 'tmux-teams-acp-lanes')
})

test('ping is answered with an empty result, which the spec makes a MUST', () => {
  // A host health check that pings and receives -32601 reads this server as
  // dead and drops it: the silent-disconnection twin of the boot bug below.
  const pong = handle({ jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.deepEqual(pong, { jsonrpc: '2.0', id: 3, result: {} })
})

test('NO notification is answered, whatever method it names', () => {
  // The no-id check used to sit at the bottom, where only an unknown method
  // reached it, so `ping` sent as a notification produced a reply carrying no
  // id — answering a message nobody asked a question with.
  for (const method of ['notifications/initialized', 'ping', 'tools/list', 'initialize']) {
    assert.equal(handle({ jsonrpc: '2.0', method }), null, `${method} as a notification was answered`)
  }
  assert.equal(handle({ jsonrpc: '2.0', id: 9, method: 'tools/nope' }).error.code, -32601)
})

test('the manifest command boots the server through a legal MCP lifecycle, from a path with a space',
  async () => {
    // Three defects in one test, all of them found by review rather than by the
    // suite. (1) Every other test imports the module, so the boot path was
    // executed by nothing — and it was broken, twice over: a percent-encoded URL
    // compared against a raw argv path, and then a /var -> /private/var symlink
    // the first fix still missed. (2) The manifest's COMMAND was never checked,
    // so `node-does-not-exist` stayed green. (3) The first boot test sent
    // tools/call first, which is not a lifecycle any host performs.
    const base = mkdtempSync(join(tmpdir(), 'acp-lanes-boot-'))
    const dir = join(base, 'a path with spaces')
    try {
      mkdirSync(dir, { recursive: true })
      const scripts = join(PLUGIN, 'skills', 'party-mode', 'scripts')
      for (const name of ['acp-lanes-mcp.mjs', 'review-profiles.mjs']) {
        writeFileSync(join(dir, name), readFileSync(join(scripts, name), 'utf8'))
      }
      // The manifest's OWN argv, expanded, with only the script path rebased into
      // the copied tree. Rebuilding argv by hand left a fatal extra manifest
      // argument passing, which an advisor caught.
      const args = (SERVER.args ?? []).map(a => a.includes('.mjs')
        ? join(dir, expand(a).split('/').pop())
        : expand(a))
      const child = spawn(expand(SERVER.command), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: '/nonexistent-layout' },
      })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acp_lanes' } })
      send({ jsonrpc: '2.0', id: 4, method: 'ping' })
      const code = await new Promise((done) => {
        setTimeout(() => child.stdin.end(), 600)
        child.on('close', done)
      })
      assert.equal(code, 0, 'the server exited nonzero')
      assert.ok(out.trim(), 'the launched server answered nothing at all — serve() never ran')
      const replies = out.trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(replies.map(r => r.id), [1, 2, 3, 4],
        'the notification was answered, or a request was not')
      assert.equal(replies[0].result.protocolVersion, PROTOCOL_VERSION)
      assert.deepEqual(replies[1].result.tools.map(t => t.name), ['acp_lanes', 'acp_lane_status'])
      assert.equal(JSON.parse(replies[2].result.content[0].text).lanes.length, 7)
      assert.deepEqual(replies[3].result, {}, 'ping was not answered with an empty result')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
