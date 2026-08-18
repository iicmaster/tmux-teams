import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { handle, callTool, laneFacts, laneStatus, classify, fixesFor,
  TOOLS, TOOL_DESCRIPTORS, DIAGNOSTICS, PROTOCOL_VERSION, UNCHECKED_LANES,
  RPC_INVALID_REQUEST, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR }
  from '../plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs'
import { REVIEW_PROFILES, normalizePrimaryFamily, PROVIDER_SECRET_KEYS, acceptedCredentialNames, unresolvedInterpreterFor, buildProfileEnv }
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

  // EVERY declared field the tool's own description promises, for every lane.
  // A review round identified this gap and could not run it before its turn
  // ended; running it confirmed the miss — `provider: null` for all seven lanes
  // kept this file 27/27 green, because the assertions above pin names, routing
  // and adapter presence and never touched `provider` or `family`. The tool
  // advertises "family, provider, model, adapter package"; the guard now pins
  // all four, per lane, literally.
  const declared = Object.fromEntries(out.lanes.map((l) => [l.lane, l]))
  for (const [lane, family, provider, model] of [
    ['agy', 'gemini', 'google-antigravity', 'gemini-3.7-flash-high'],
    ['claude', 'claude', 'anthropic', 'claude-opus-4-8'],
    ['codex', 'openai', 'openai', 'gpt-5.6-sol'],
    ['deepseek', 'deepseek', 'qwen', 'deepseek-v4-flash-0731'],
    ['kimi', 'kimi', 'kimi', 'opus'],
    ['qwen', 'qwen', 'qwen', 'qwen3.8-max-preview'],
    ['zai', 'zai', 'zai', 'glm-5.2'],
  ]) {
    assert.equal(declared[lane].family, family, `${lane} family`)
    assert.equal(declared[lane].provider, provider, `${lane} provider`)
    assert.equal(declared[lane].model, model, `${lane} model`)
    assert.ok(declared[lane].adapter, `${lane} adapter`)
  }
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
  const agy = fixesFor('agy', REVIEW_PROFILES.agy, 'executable_missing')
  assert.ok(agy.some(f => /trusted, EXECUTABLE `agy`/.test(f) && /\$HOME\/\.local\/bin\/agy/.test(f)),
    `agy is not told about the binary the parent actually looked for: ${agy.join(' | ')}`)
  // The UNRESOLVED form, and this is a security assertion rather than a style
  // one: interpolating the resolved candidate put whatever HOME contained on
  // the wire, and an advisor walked a credential out through it while every
  // credential FIELD stayed clean.
  assert.ok(agy.every(f => !/\/h\//.test(f)),
    `a resolved HOME reached a fix sentence: ${agy.join(' | ')}`)

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

test('the credential fix, APPLIED, turns the lane it was given to from invalid to valid', () => {
  // A prose assertion that a sentence mentions the right variable is not a test
  // of the repair. A Codex advisor showed why: `loadRoutedCredentialFile`
  // filtered through an allowlist that excluded `ZAI_API_KEY` while
  // `validateRoutedEndpoint` accepted the identical key from the ambient
  // environment — so the fix named the right file and the lane refused exactly
  // as before. This applies the returned remediation and demands the state
  // change, and the ambient path is measured beside it because "same key, two
  // answers" is the defect.
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-repair-'))
  try {
    const settings = join(dir, 'zai.json')
    const envFile = join(dir, 'zai.env')
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }))
    writeFileSync(envFile, 'ZAI_API_KEY=fixture-secret-never-print\n')
    const base = {
      HOME: '/definitely/nonexistent', PATH: process.env.PATH,
      TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings,
    }

    const before = laneStatus('zai', REVIEW_PROFILES.zai, base)
    assert.equal(before.configuration, 'invalid')
    assert.equal(before.problem.code, 'credential_missing')
    assert.match(before.fixes.join(' '), /TMUX_TEAMS_REVIEW_ZAI_ENV_FILE/)
    // The fix has to name the vocabulary too, or an operator writes the wrong
    // key into the right file and gets the same silence.
    assert.match(before.fixes.join(' '), /ZAI_API_KEY/)

    const repaired = laneStatus('zai', REVIEW_PROFILES.zai,
      { ...base, TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: envFile })
    assert.equal(repaired.configuration, 'valid',
      'the remediation this tool prints does not repair the refusal it prints it for')

    const ambient = laneStatus('zai', REVIEW_PROFILES.zai,
      { ...base, ZAI_API_KEY: 'fixture-secret-never-print' })
    assert.equal(ambient.configuration, repaired.configuration,
      'the same key is accepted from one source and rejected from the other')

    // The widening is per lane, not global: a lane gains only the secret names
    // it declares, so a stray file still cannot smuggle another lane's key.
    const foreign = join(dir, 'foreign.env')
    writeFileSync(foreign, 'OPENAI_API_KEY=nope\nKIMI_API_KEY=nope\n')
    assert.equal(laneStatus('zai', REVIEW_PROFILES.zai,
      { ...base, TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: foreign }).configuration, 'invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the agy lane checks that its binary is EXECUTABLE, not merely that a name exists', () => {
  // Reproduced by a Codex advisor against the previous bytes: a mode-0644 file
  // at the trusted candidate path produced `valid`, `problem: null` and no
  // fixes, while executing it failed EACCES. AGY is not in UNCHECKED_LANES —
  // executable discovery is the ONE parent-side fact it claims to establish, so
  // a green there is false about its own boundary rather than about the
  // provider. This also kills the mutation that returned `valid` for agy
  // unconditionally: `fixesFor` tested in isolation says nothing about the call
  // site, and deleting the call site left all 18 tests green.
  const cases = [
    ['a regular file with no execute bit', (path, fs) => { fs.writeFileSync(path, ''); fs.chmodSync(path, 0o644) }, 'invalid'],
    ['a directory with the right name', (path, fs) => fs.mkdirSync(path), 'invalid'],
    ['a real executable', (path, fs) => { fs.writeFileSync(path, '#!/bin/sh\nexit 0\n'); fs.chmodSync(path, 0o755) }, 'valid'],
  ]
  for (const [label, make, expected] of cases) {
    const home = mkdtempSync(join(tmpdir(), 'acp-lanes-agy-'))
    try {
      const bin = join(home, '.local', 'bin')
      mkdirSync(bin, { recursive: true })
      make(join(bin, 'agy'), { writeFileSync, chmodSync, mkdirSync })
      const got = laneStatus('agy', REVIEW_PROFILES.agy, { HOME: home, PATH: '/definitely/nonexistent' })
      assert.equal(got.configuration, expected, `${label} was answered ${got.configuration}`)
      if (expected === 'invalid') {
        assert.equal(got.problem.code, 'executable_missing')
        assert.ok(got.fixes.some(f => /EXECUTABLE/.test(f)), `${label} got no executable-shaped fix`)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // And with nothing at any candidate path at all, which is the state the
  // deleted call site would have reported as valid.
  const bare = laneStatus('agy', REVIEW_PROFILES.agy,
    { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' })
  assert.equal(bare.configuration, 'invalid')
  assert.equal(bare.problem.code, 'executable_missing')
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
    'settings_unreadable', 'credential_unreadable', 'profile_incomplete',
    'executable_missing', 'unclassified']
  assert.deepEqual(Object.keys(DIAGNOSTICS).sort(), [...codes].sort())
  // and the classifier maps real messages onto them rather than onto `unclassified`
  assert.equal(classify('zai review requires ANTHROPIC_BASE_URL'), 'endpoint_missing')
  assert.equal(classify('zai review endpoint must be https://api.z.ai/api/anthropic'), 'endpoint_mismatch')
  assert.equal(classify('zai review endpoint requires an explicit provider credential'), 'credential_missing')
  assert.equal(classify('trusted agy executable not found'), 'executable_missing')
  // WHICH FILE failed decides the repair. Aiming every filesystem error at the
  // settings file sent the operator to edit a file that was fine — a panel lane
  // caught it one commit after it was introduced.
  // WHICH file failed is not knowable from the message. The previous version
  // searched the raw text — INCLUDING THE PATH — so a caller who controls a
  // filename chose the diagnosis, against this module's own invariant.
  // Identity comes from the caller that opened the file, or not at all.
  for (const path of ['/home/u/credential.json', '/home/u/.env', '/tmp/settings.json',
    '/tmp/auth/api-key/settings.json']) {
    assert.equal(classify(`EACCES: permission denied, open '${path}'`), 'settings_unreadable',
      `the filename ${path} chose the diagnosis`)
  }
  assert.equal(classify('EACCES: permission denied', { fileKind: 'credential' }), 'credential_unreadable')
  assert.equal(classify('EACCES: permission denied', { fileKind: 'settings' }), 'settings_unreadable')
  // ponytail: the repair sentence is reached through the switch, which the
  // closed-set assertion above already covers; exporting a helper only so a
  // test can call it would be the test shaping the module.
  assert.equal(classify('something nobody has seen before'), 'unclassified')
  // A release panel called the old mapping a false diagnosis with non-repairing
  // instructions, and it was: a lane that routes and declares no endpoint has a
  // PROFILE defect, and telling the operator to fix their settings JSON sends
  // them to a file with nothing wrong with it.
  assert.equal(classify('zai review routes its provider but pins no endpoint'), 'profile_incomplete')
  assert.equal(classify('zai review settings must be a JSON object'), 'settings_unreadable')
  assert.match(fixesFor('zai', REVIEW_PROFILES.zai, 'profile_incomplete')[0],
    /defect in the shipped profile, not in your configuration/)
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
      // NOT asserted: that the field NAME stays off the wire. It does not, and
      // it is not meant to — see the credential-vocabulary test below. This
      // line demanded the opposite until 2026-08-17 and passed only because
      // every fixture here fails at `endpoint_missing`, where no credential
      // sentence is produced. A guard that holds by never reaching the branch
      // it guards is the shape a Codex advisor found in round four.
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

test('no provider secret this plugin knows about reaches the wire, from any lane', () => {
  // The test above seeds ONE key, and a Codex advisor mutated `laneStatus` to
  // serialise `env.GOOGLE_API_KEY` directly: all 18 tests stayed green while a
  // credential went out under a test named "a credential never reaches the
  // wire". The inventory below is written out LITERALLY on purpose — a test
  // that iterated `PROVIDER_SECRET_KEYS` would stop testing any key deleted
  // from it and report that as a pass, which is a shape this repository has a
  // rule about.
  const INVENTORY = [
    'AGY_API_KEY', 'ANTIGRAVITY_API_KEY', 'GOOGLE_API_KEY',
    'KIMI_API_KEY', 'MOONSHOT_API_KEY',
    'ZAI_API_KEY',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ]
  const declared = [...new Set(Object.values(PROVIDER_SECRET_KEYS).flat())].sort()
  assert.deepEqual([...INVENTORY].sort(), declared,
    'a provider secret was added or removed and this matrix was not told')

  // OWNERSHIP, not just membership. The set above pins WHICH names exist and a
  // Codex advisor showed in round four what that misses: moving
  // `MOONSHOT_API_KEY` from `kimi` to `qwen` leaves the union unchanged, keeps
  // both suites green, and forwards a foreign key into the Qwen child. So the
  // map is written out per lane, literally, and an empty list is a statement
  // rather than a gap — `qwen` and `deepseek` reach their provider through a
  // routed wrapper's own settings and forward nothing from this process.
  assert.deepEqual(PROVIDER_SECRET_KEYS, {
    agy: ['AGY_API_KEY', 'ANTIGRAVITY_API_KEY', 'GOOGLE_API_KEY'],
    kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    qwen: [],
    deepseek: [],
    zai: ['ZAI_API_KEY'],
    claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    codex: ['OPENAI_API_KEY'],
  }, 'a provider secret changed which LANE owns it')

  // And behaviourally, because a constant can be edited to match a test: a key
  // one lane declares must not reach another lane's child.
  const foreign = 'PLANTEDFOREIGN-' + 'w'.repeat(20)
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-foreign-'))
  try {
    const settings = join(dir, 'qwen.json')
    writeFileSync(settings, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `https://${REVIEW_PROFILES.qwen.endpoint.host}${REVIEW_PROFILES.qwen.endpoint.path}`,
        ANTHROPIC_AUTH_TOKEN: 'fixture',
      },
    }))
    const child = buildProfileEnv('qwen', {
      HOME: '/definitely/nonexistent', PATH: process.env.PATH,
      TMUX_TEAMS_REVIEW_QWEN_SETTINGS: settings,
      MOONSHOT_API_KEY: foreign, KIMI_API_KEY: foreign, ZAI_API_KEY: foreign,
    })
    assert.ok(!Object.values(child).includes(foreign),
      'a key another lane declares was forwarded into the qwen child')
    assert.ok(!('MOONSHOT_API_KEY' in child))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  for (const key of INVENTORY) {
    const value = `sk-matrix-${key.toLowerCase()}-` + 'q'.repeat(20)
    // Every lane, in one call, so a leak from any handler branch is covered.
    const wire = JSON.stringify(handle({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'acp_lane_status', arguments: {} },
    }, { HOME: '/definitely/nonexistent', PATH: process.env.PATH, [key]: value }))
    assert.ok(!wire.includes(value), `${key} reached the wire`)
    // Values only. The names are diagnostic vocabulary and go out on purpose.
  }
})

test('the credential_missing branch names the vocabulary and still carries no value', () => {
  // The branch the secret matrix never reached, which is why a contradiction
  // between the contract and the bytes survived three rounds: every fixture in
  // that test fails at `endpoint_missing`, where no credential sentence exists.
  // Here the endpoint is RIGHT and the credential absent, so the fix sentences
  // are produced — and what they must contain is the accepted key names, while
  // what must never appear is a value.
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-vocab-'))
  try {
    const settings = join(dir, 'kimi.json')
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' } }))
    const planted = 'PLANTEDVALUE-' + 'q'.repeat(20)
    const reply = handle({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'acp_lane_status', arguments: { lane: 'kimi' } },
    }, {
      HOME: `/definitely/nonexistent/${planted}`, PATH: process.env.PATH,
      TMUX_TEAMS_REVIEW_KIMI_SETTINGS: settings,
    })
    const wire = JSON.stringify(reply)
    const [lane] = JSON.parse(reply.result.content[0].text).lanes
    assert.equal(lane.problem.code, 'credential_missing',
      'this fixture must reach the credential branch or it tests nothing')
    // Names: present, deliberately, and the SAME ones the validator accepts.
    const fixes = lane.fixes.join(' ')
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']) {
      assert.ok(fixes.includes(key), `the repair does not name ${key}, which the endpoint check accepts`)
    }
    // Value: absent, including one planted where a path diagnostic could carry it.
    assert.ok(!wire.includes(planted), 'a value reached the wire')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the advertised credential names ARE the accepted ones, by construction', () => {
  // Round three built the advertised list by hand next to a check that named
  // three keys literally, and they drifted apart within one release: the fix
  // for a missing Kimi credential named keys the endpoint validator refused, so
  // the repair could not repair. Same function on both sides now — this asserts
  // the behaviour rather than the wiring, by applying each advertised name.
  for (const id of ['zai', 'kimi', 'qwen', 'deepseek']) {
    const profile = REVIEW_PROFILES[id]
    const advertised = acceptedCredentialNames(profile)
    assert.deepEqual(advertised.slice(0, 2), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])
    const dir = mkdtempSync(join(tmpdir(), `acp-lanes-accept-${id}-`))
    try {
      const settings = join(dir, 'lane.json')
      const base = `https://${profile.endpoint.host}${profile.endpoint.path}`
      writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }))
      const env = {
        HOME: '/definitely/nonexistent', PATH: process.env.PATH,
        [`TMUX_TEAMS_REVIEW_${id.toUpperCase()}_SETTINGS`]: settings,
      }
      assert.equal(laneStatus(id, profile, env).problem.code, 'credential_missing',
        `${id} must start from the credential branch`)
      // Through the FILE, which is what the fix sentence prescribes: "point
      // <ENV_FILE> at the file holding it — that file is read for <names>".
      const envFile = join(dir, 'lane.env')
      for (const key of advertised) {
        writeFileSync(envFile, `${key}=fixture\n`)
        assert.equal(
          laneStatus(id, profile, { ...env, [`TMUX_TEAMS_REVIEW_${id.toUpperCase()}_ENV_FILE`]: envFile }).configuration,
          'valid', `${id} advertises ${key} and then refuses it from the file it names`)
      }
      // Ambient works only for the lane's OWN declared secrets, and that
      // asymmetry is deliberate: `ANTHROPIC_AUTH_TOKEN` sitting in an
      // operator's shell must not silently authenticate a routed lane, so it
      // is honoured from this lane's files and nowhere else. The test states
      // it rather than discovering it — it discovered it once already, by
      // asserting ambient for every name and going red on zai.
      for (const key of PROVIDER_SECRET_KEYS[id]) {
        assert.equal(laneStatus(id, profile, { ...env, [key]: 'fixture' }).configuration, 'valid',
          `${id} declares ${key} as its own secret and then refuses it from the environment`)
      }
      for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
        assert.equal(laneStatus(id, profile, { ...env, [key]: 'fixture' }).problem?.code, 'credential_missing',
          `${id} accepted an ambient ${key}, which no routed lane forwards`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a secret hidden in HOME does not walk out through a path diagnostic', () => {
  // Aliasing, and the reason a denylist over credential FIELDS is not the
  // guard. The fix sentence for agy used to interpolate the resolved candidate
  // path, so with a credential value also present in HOME the whole reply
  // carried the credential — through the path, never through a credential
  // field. The route does not change what the bytes are.
  // A synthetic marker rather than a credential-shaped literal: the repository's
  // own pre-commit secret scanner reads `const secret = 'sk-...'` as the thing
  // it exists to stop, and it is right to. What this test needs is one string
  // that appears in BOTH `HOME` and a provider-secret variable.
  const marker = 'HOMEALIAS-' + 'z'.repeat(24)
  const wire = JSON.stringify(handle({
    jsonrpc: '2.0', id: 91, method: 'tools/call',
    params: { name: 'acp_lane_status', arguments: { lane: 'agy' } },
  }, { HOME: `/private/tmp/${marker}`, PATH: '/definitely/nonexistent', GOOGLE_API_KEY: marker }))
  assert.ok(!wire.includes(marker), 'a HOME-derived path carried a credential value onto the wire')
  assert.match(wire, /\$HOME/, 'the unresolved form is what makes this safe; it is gone')
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
  const legal = {
    protocolVersion: 'not-a-protocol-version',
    capabilities: {},
    clientInfo: { name: 'a-client', version: '1' },
  }
  const asked = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: legal }).result
  // Reversed on 2026-08-17 after a release panel raised independently what an
  // advisor round had accepted as a documented tolerance: this server
  // advertises 2025-06-18 on every initialize, and that version requires all
  // three. Two distinct reviewers is this project's must-fix bar.
  for (const missing of ['capabilities', 'clientInfo']) {
    const without = { ...legal }
    delete without[missing]
    assert.equal(
      handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: without }).error.code, -32602,
      `initialize accepted a client that omitted ${missing} while advertising 2025-06-18`)
  }
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

test('a malformed frame is refused with the code the spec names for it', () => {
  // There were NO negative protocol tests, and a Codex advisor drove the real
  // stdio server to find out what that cost: `"jsonrpc":"1.0"` got a successful
  // tool list; `arguments: []` got successful content against an object-only
  // schema; an unknown tool came back as a SUCCESSFUL result carrying isError,
  // so middleware could not tell protocol misuse from tool failure; a numeric
  // method was method-not-found instead of invalid-request; and an empty array
  // and an `id: null` request were both dropped in silence as though each were
  // a notification. Codes are written as literals here — comparing them only
  // against the module's own constants is the shape that lets both move
  // together.
  const cases = [
    ['jsonrpc 1.0', { jsonrpc: '1.0', id: 11, method: 'tools/list' }, -32600, null],
    ['no jsonrpc member', { id: 11, method: 'tools/list' }, -32600, null],
    ['numeric method', { jsonrpc: '2.0', id: 14, method: 9 }, -32600, null],
    ['a batch', [], -32600, null],
    ['id null', { jsonrpc: '2.0', id: null, method: 'ping' }, -32600, null],
    ['a bare string', 'ping', -32600, null],
    ['array arguments', { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'acp_lanes', arguments: [] } }, -32602, 12],
    ['unknown tool', { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }, -32602, 13],
    ['no params at all', { jsonrpc: '2.0', id: 15, method: 'tools/call' }, -32602, 15],
    ['non-string tool name', { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 7 } }, -32602, 16],
    ['undeclared argument', { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'acp_lanes', arguments: { lane: 'zai' } } }, -32602, 17],
    ['wrongly typed argument', { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'acp_lane_status', arguments: { lane: 7 } } }, -32602, 18],
    ['unknown method', { jsonrpc: '2.0', id: 19, method: 'tools/nope' }, -32601, 19],
    // Method-not-found outranks bad params: complaining about arguments to a
    // method that does not exist sends the reader to the wrong problem.
    ['unknown method with bad params', { jsonrpc: '2.0', id: 30, method: 'tools/nope', params: [] }, -32601, 30],
    // Per-method params, all reproduced answering SUCCESS in round four.
    ['initialize with no params', { jsonrpc: '2.0', id: 31, method: 'initialize' }, -32602, 31],
    ['initialize with array params', { jsonrpc: '2.0', id: 32, method: 'initialize', params: [] }, -32602, 32],
    ['initialize with a non-string protocolVersion', { jsonrpc: '2.0', id: 33, method: 'initialize', params: { protocolVersion: 7 } }, -32602, 33],
    ['initialize with array capabilities', { jsonrpc: '2.0', id: 34, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: [] } }, -32602, 34],
    ['tools/list with array params', { jsonrpc: '2.0', id: 35, method: 'tools/list', params: [] }, -32602, 35],
    ['tools/list with a numeric cursor', { jsonrpc: '2.0', id: 36, method: 'tools/list', params: { cursor: 7 } }, -32602, 36],
    ['ping with array params', { jsonrpc: '2.0', id: 37, method: 'ping', params: [] }, -32602, 37],
  ]
  for (const [label, frame, code, id] of cases) {
    const reply = handle(frame, {})
    assert.ok(reply, `${label} was dropped in silence — a request is not a notification`)
    assert.equal(reply.error?.code, code, `${label} answered ${JSON.stringify(reply)}`)
    assert.equal(reply.id, id, `${label} answered under the wrong id`)
    assert.equal(reply.jsonrpc, '2.0')
    assert.equal(reply.result, undefined, `${label} carried a result beside an error`)
  }
  // The constants agree with the literals above, which is the only thing this
  // second assertion is for.
  assert.equal(RPC_INVALID_REQUEST, -32600)
  assert.equal(RPC_INVALID_PARAMS, -32602)
  assert.equal(RPC_METHOD_NOT_FOUND, -32601)
  assert.equal(RPC_PARSE_ERROR, -32700)
  // The SENTENCE has to match what the code accepts. Round five caught it still
  // saying "an integer" after `Number.isInteger` became `Number.isFinite` — a
  // contract-wording defect, which is the same class as the credential-name
  // claim that survived three rounds, just cheaper.
  const badId = handle({ jsonrpc: '2.0', id: {}, method: 'ping' }, {})
  assert.match(badId.error.message, /string or a finite number/)
  assert.doesNotMatch(badId.error.message, /integer/)
  // Nothing a caller sent is echoed back: every refusal sentence is a constant
  // of the module.
  const echo = handle({ jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'no_such_tool-SECRETMARKER', arguments: {} } }, {})
  assert.ok(!JSON.stringify(echo).includes('SECRETMARKER'),
    'the caller\'s own string was reflected into a diagnostic')
})

test('every id shape the spec calls legal is ACCEPTED, including the ugly one', () => {
  // The refusals have a table of their own; this is the other half, and it was
  // missing. Round three demanded `Number.isInteger`, turning JSON-RPC's
  // "fractional ids SHOULD NOT be used" into a local MUST NOT — so `id: 1.5`
  // was refused, and refused in the one way that loses the correlation, under
  // `id: null`. MCP 2025-06-18 types `RequestId` as `string | number`.
  for (const id of [1, -1, 0, 1.5, 2.5e3, 'a-string-id', '', '0']) {
    const reply = handle({ jsonrpc: '2.0', id, method: 'ping' }, {})
    assert.deepEqual(reply, { jsonrpc: '2.0', id, result: {} },
      `a legal request id was not answered as itself: ${JSON.stringify(id)}`)
  }
})

test('a parse failure over stdio is a -32700 with a null id, and the server stays up', async () => {
  const { serve } = await import('../plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs')
  const { Readable, Writable } = await import('node:stream')
  const written = []
  const input = Readable.from(['{ not json\n', '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'])
  const output = new Writable({ write(chunk, _enc, done) { written.push(String(chunk)); done() } })
  const lines = serve({ input, output, env: {} })
  await new Promise((done) => lines.on('close', done))
  const replies = written.join('').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(replies[0].error.code, -32700)
  assert.equal(replies[0].id, null)
  assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 2, result: {} },
    'one bad line took the server down with it')
})

test('the manifest command boots the server and answers a real client handshake, from a path with a space',
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
      // A schema-valid initialize: MCP 2025-06-18 requires client capabilities
      // and client implementation info, and the previous version sent only
      // `protocolVersion` while the test called itself a legal lifecycle. It
      // proved boot and line framing, which is what it is named for now.
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'tmux-teams-test-client', version: '1' },
        },
      })
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

test('the things three panel families found in one sitting', () => {
  // A prototype name is not a declared argument. `properties` is a plain object
  // literal, so `properties['constructor']` resolves up the chain and returns a
  // function — which a truthiness test reads as "declared". That made
  // `additionalProperties: false` bypassable by naming anything on
  // Object.prototype.
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const reply = handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'acp_lane_status', arguments: { [name]: 'x' } },
    }, {})
    assert.equal(reply.error?.code, -32602, `an argument named ${name} was accepted`)
  }

  // `clientInfo` is an Implementation and requires name and version. Requiring
  // the object and not its contents is half a rule, and the file claimed the
  // check "matches the version this server claims to speak".
  const base = { protocolVersion: '2025-06-18', capabilities: {} }
  for (const clientInfo of [{}, { name: 'a' }, { version: '1' }, { name: 1, version: '1' }]) {
    assert.equal(
      handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { ...base, clientInfo } }, {}).error?.code,
      -32602, `initialize accepted clientInfo ${JSON.stringify(clientInfo)}`)
  }
  assert.ok(handle({ jsonrpc: '2.0', id: 3, method: 'initialize',
    params: { ...base, clientInfo: { name: 'a', version: '1' } } }, {}).result)

  // This assertion was itself a defect and is kept as a record of one. Round
  // four found `ping` validating nothing and this test demanded that unknown
  // keys be REFUSED — but MCP 2025-06-18 types PingRequest.params as an open
  // object, so the test pinned a violation of the spec and a later panel lane
  // reproduced conforming traffic being rejected. A test can hold a bug in
  // place; the fix is the specification, not the previous reviewer's wording.
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 4, method: 'ping', params: { extra: 1 } }, {}),
    { jsonrpc: '2.0', id: 4, result: {} })
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 5, method: 'ping', params: {} }, {}),
    { jsonrpc: '2.0', id: 5, result: {} })
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 6, method: 'ping' }, {}),
    { jsonrpc: '2.0', id: 6, result: {} })

  // Nothing the caller sent comes back. Two lanes raised this independently
  // against the file's own claim that every sentence it emits is a constant —
  // the `known` lists already carry the vocabulary, so the echo added nothing.
  const marker = 'CALLERMARKER'
  const lane = JSON.stringify(callTool('acp_lane_status', { lane: marker }, {}))
  assert.ok(!lane.includes(marker), `the lane name was echoed: ${lane}`)
  const tool = JSON.stringify(callTool(`${marker}_tool`, {}, {}))
  assert.ok(!tool.includes(marker), `the tool name was echoed: ${tool}`)
})

test('_meta is legal on any request, and a filename cannot choose the diagnosis', () => {
  // Two commits after a panel told me the tolerant `initialize` was wrong, a
  // panel told me the strict `ping` was — and both were right, because the line
  // is the spec and not a preference in either direction. `_meta` is legal on
  // ANY request in MCP 2025-06-18, so "ping takes no params" refused conforming
  // traffic.
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { a: 1 } } }, {}),
    { jsonrpc: '2.0', id: 1, result: {} })
  // `PingRequest.params` is an OPEN object in MCP 2025-06-18 — `_meta` plus
  // arbitrary keys — so refusing unknown keys refused conforming traffic. This
  // line was wrong in BOTH directions across three commits, and the answer was
  // the specification every time.
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 2, method: 'ping', params: { traceContext: {} } }, {}),
    { jsonrpc: '2.0', id: 2, result: {} })
  // `_meta` is legal AND typed as an object. Accepting it as ANY value was the
  // overcorrection — one commit stopped refusing legal traffic and started
  // accepting illegal traffic. Found by mutation: removing the type check left
  // every test green, which is the "guard that guards nothing" shape.
  for (const bad of ['a string', 42, [], null, true]) {
    for (const method of ['ping', 'tools/list']) {
      assert.equal(handle({ jsonrpc: '2.0', id: 9, method, params: { _meta: bad } }, {}).error?.code,
        -32602, `${method} accepted _meta as ${JSON.stringify(bad)}`)
    }
  }

  // A caller who controls a settings PATH controlled the classification: the
  // regexes ran over the whole exception text, and a filename carrying
  // "pins no endpoint" or "must be a JSON object" selected that diagnosis.
  assert.equal(classify('ENOENT: no such file or directory, open ' +
    "'/home/u/pins no endpoint/settings.json'"), 'settings_unreadable')
  assert.equal(classify("Cannot read '/tmp/must be a JSON object/x' — EACCES"), 'settings_unreadable')
  // And the shapes this system really throws still land where they belong.
  assert.equal(classify('zai review routes its provider but pins no endpoint'), 'profile_incomplete')
  assert.equal(classify('zai review requires ANTHROPIC_BASE_URL'), 'endpoint_missing')
  assert.equal(classify('zai review endpoint requires an explicit provider credential'), 'credential_missing')
})

test('every shipped profile declares a family the normalizer can name', () => {
  // `deepseek` ships as a profile and was recognized by NOTHING — not the alias
  // map, not any regex — so normalizePrimaryFamily('deepseek') answered
  // 'unknown', and its lane reaches its seat through a gateway that also serves
  // qwen, which is the nearest wrong answer. A panel lane found it.
  //
  // The panel's whole premise is three DISTINCT families, so a shipped family
  // the normalizer cannot name is a hole in the one property it exists to
  // check. Iterating the profiles is the point here: a profile added later
  // without a family gets caught by this, which a pinned list would not do.
  for (const [id, profile] of Object.entries(REVIEW_PROFILES)) {
    assert.equal(normalizePrimaryFamily(profile.family), profile.family,
      `profile ${id} declares family "${profile.family}" that the normalizer answers `
      + `"${normalizePrimaryFamily(profile.family)}" for`)
  }
  // and the shapes that reach the normalizer from a wrapper name and a model id
  assert.equal(normalizePrimaryFamily('claude-deepseek'), 'deepseek')
  assert.equal(normalizePrimaryFamily('deepseek-v4-flash-0731'), 'deepseek')
  assert.notEqual(normalizePrimaryFamily('deepseek'), 'qwen')
})

test('each MCP registration satisfies the contract it names', () => {
  // One file declared the Agent Plugins 1.0 schema and then spoke Claude Code:
  // that schema discovers `mcp.json` and its `cwd` rule accepts only `./…`,
  // `${PLUGIN_ROOT}…` or `${PLUGIN_DATA}…`, while the file supplied
  // `${CLAUDE_PLUGIN_ROOT}`. A panel lane read the two against each other. Both
  // hosts are real, so both files ship — what is not allowed is one file
  // claiming a contract it violates.
  const claude = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'))
  const neutral = JSON.parse(readFileSync(join(PLUGIN, 'mcp.json'), 'utf8'))

  assert.equal(claude.$schema, undefined,
    '.mcp.json is the Claude Code registration and must not claim the vendor-neutral schema')
  const c = claude.mcpServers['tmux-teams-acp-lanes']
  assert.match(c.cwd, /^\$\{CLAUDE_PLUGIN_ROOT\}/)
  assert.match(c.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}/)

  assert.equal(neutral.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  const n = neutral.mcpServers['tmux-teams-acp-lanes']
  assert.match(n.cwd, /^(\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})/,
    'the vendor-neutral cwd must satisfy the schema it declares')
  assert.match(n.args[0], /^(\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})/)
  assert.ok(!JSON.stringify(neutral).includes('CLAUDE_PLUGIN_ROOT'),
    'the vendor-neutral registration leaks a Claude Code variable')

  // both point at the same shipped file
  for (const [file, entry] of [['.mcp.json', c], ['mcp.json', n]]) {
    const target = entry.args[0].replace(/^\$\{(CLAUDE_)?PLUGIN_ROOT\}/, PLUGIN)
    assert.ok(existsSync(target), `${file} points at a file that is not shipped: ${target}`)
  }
})

test('an unreadable credential file reaches the operator AS a credential problem', () => {
  // The end-to-end guard that was missing. `credential_unreadable` and the
  // `fileKind` argument that carries it were added together, the test called
  // `classify` DIRECTLY, and no caller ever passed one — so two panel families
  // reported the code unreachable from any reply this server can produce, and
  // an unreadable credential file kept prescribing the settings-file repair.
  //
  // This goes through the TOOL, so deleting the argument at the call site turns
  // it red. Asserting the pure function proves nothing about its consumer.
  const dir = mkdtempSync(join(tmpdir(), 'lane-credfail-'))
  const credential = join(dir, 'creds.env')
  writeFileSync(credential, 'ANTHROPIC_AUTH_TOKEN=shhh\n')
  chmodSync(credential, 0o000)          // present, and not readable
  try {
    const reply = callTool('acp_lane_status', { lane: 'zai' }, {
      TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: credential,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })
    const text = JSON.stringify(reply)
    assert.ok(!text.includes('shhh'), 'the credential value reached the wire')
    if (process.getuid?.() === 0) return   // root reads anything; the branch cannot be reached
    assert.match(text, /credential_unreadable/,
      `an unreadable credential file was not diagnosed as one: ${text}`)
    assert.ok(!text.includes('settings_unreadable'),
      'the operator was sent to the settings file, which is fine')
  } finally {
    chmodSync(credential, 0o600)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a candidate whose interpreter is missing answers unchecked, not valid', () => {
  // Two panel families, two rounds. The defence recorded on the roadmap —
  // "proving otherwise means EXECUTING the candidate, which turns a read-only
  // tool into an acting one" — rested on a choice that does not exist. The
  // alternative was never `valid` versus running the file: `unchecked` is
  // already in the result vocabulary and describes this state exactly. Reading
  // 256 bytes is not executing.
  //
  // The candidate list is `$HOME/.local/bin/agy` and two absolute paths — not
  // an env var, which is what the first version of this test assumed. Measured
  // from `agyBinaryCandidates` rather than remembered.
  const home = mkdtempSync(join(tmpdir(), 'lane-shebang-'))
  const binDir = join(home, '.local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'agy')
  try {
    writeFileSync(bin, '#!/definitely/not/here/python3\nprint("hi")\n')
    chmodSync(bin, 0o755)                       // executable, and cannot start
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home } }),
      '/definitely/not/here/python3',
      'a 0755 file whose shebang names a missing interpreter was read as startable')

    // a file that CAN start is not maligned
    writeFileSync(bin, `#!${process.execPath}\nprocess.exit(0)\n`)
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home } }), null)

    // a bare-name shebang resolves through PATH, which this check does not own:
    // it says nothing rather than guessing, because a wrong specific answer
    // sends the reader to the wrong file.
    writeFileSync(bin, '#!python3\n')
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home } }), null)

    // and lanes that resolve no binary parent-side are not second-guessed
    assert.equal(unresolvedInterpreterFor('zai', { env: { HOME: home } }), null)

    // THROUGH THE TOOL, not just the helper. The first version of this test
    // asserted the helper alone, and deleting the CALL SITE left it green —
    // which is the exact defect round six raised about `credential_unreadable`,
    // committed again in the test written to close it. Mutate the call site.
    writeFileSync(bin, '#!/definitely/not/here/python3\n')
    chmodSync(bin, 0o755)
    const lane = callTool('acp_lane_status', { lane: 'agy' }, { HOME: home }).lanes[0]
    assert.equal(lane.configuration, 'unchecked',
      `a lane that cannot start reported ${lane.configuration}`)
    assert.match(JSON.stringify(lane.fixes), /interpreter/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the exported surface is frozen through its records, and LC_ is a set not a prefix', () => {
  // `Object.freeze` on an array freezes the ARRAY, not the records inside it,
  // so both exports stayed writable by an in-process importer while ADR 0007
  // called the one-descriptor-list invariant not representable as drift. A
  // panel lane read the claim against the two calls.
  for (const [name, arr] of [['TOOLS', TOOLS], ['TOOL_DESCRIPTORS', TOOL_DESCRIPTORS]]) {
    assert.ok(Object.isFrozen(arr), `${name} itself is not frozen`)
    const before = arr[0].name
    try { arr[0].name = 'hijacked' } catch { /* strict mode throws, which is fine */ }
    assert.equal(arr[0].name, before, `${name}'s records are writable by any importer`)
    assert.ok(Object.isFrozen(arr[0]), `${name}'s records are not frozen`)
  }

  // The child-environment allowlist copied every name beginning `LC_`, so a
  // source entry a caller invented rode into every profile — in a file that
  // promises a profile-scoped environment with no ambient credential bag.
  // `codex`, because it needs no routed endpoint or resolved binary to build an
  // environment — measured across the four lanes rather than assumed, after
  // `zai` refused for a reason that had nothing to do with what this checks.
  const env = buildProfileEnv('codex', {
    HOME: '/tmp', PATH: '/usr/bin',
    LC_ALL: 'C',                       // a real locale variable: allowed
    LC_PRIVATE_TOKEN: 'SECRETVALUE',   // a name somebody chose: not
    LC_HAX: 'nope',
  })
  assert.equal(env.LC_ALL, 'C', 'a POSIX locale variable was dropped')
  assert.equal(env.LC_PRIVATE_TOKEN, undefined, 'an invented LC_ name reached the child')
  assert.equal(env.LC_HAX, undefined)
  assert.ok(!JSON.stringify(env).includes('SECRETVALUE'))
})
