import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'

import { handle, callTool, laneFacts, laneStatus, classify, fixesFor,
  TOOLS, TOOL_DESCRIPTORS, DIAGNOSTICS, PROTOCOL_VERSION, UNCHECKED_LANES,
  RPC_INVALID_REQUEST, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR,
  classifyProbe, PROBE_TIMEOUT_MS, PROBE_BRIEF, realProbeTransport }
  from '../plugins/tmux-teams/skills/party-mode/scripts/acp-lanes-mcp.mjs'
import { REVIEW_PROFILES, ROUTED_PROFILES, provenFamilyCollision, normalizePrimaryFamily, PROVIDER_SECRET_KEYS, acceptedCredentialNames, unresolvedInterpreterFor, acceptedRoutedKeys, buildAcpLaunch, buildProfileEnv }
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
    'executable_missing', 'environment_unspawnable', 'environment_over_budget',
    'unclassified',
    // Added for `acp_lane_probe` — the outcomes a LIVE attempt can learn that
    // config-time checking structurally cannot: quota/timeout are two
    // providers can trigger, and `executable_unusable` is EACCES/EPERM told
    // apart from ENOENT, which the parent-side check never spawns anything to
    // observe.
    'quota_exhausted', 'probe_timeout', 'executable_unusable']
  assert.deepEqual(Object.keys(DIAGNOSTICS).sort(), [...codes].sort())
  // and the classifier maps real messages onto them rather than onto `unclassified`
  assert.equal(classify('zai review requires ANTHROPIC_BASE_URL'), 'endpoint_missing')
  assert.equal(classify('zai review endpoint must be https://api.z.ai/api/anthropic'), 'endpoint_mismatch')
  assert.equal(classify('zai review endpoint requires an explicit provider credential'), 'credential_missing')
  assert.equal(classify('trusted agy executable not found'), 'executable_missing')
  // Its own bucket, not a credential one: the offending value may be a header,
  // a model config or an oversized total, and three of those four repairs have
  // nothing to do with a credential.
  assert.equal(classify('zai review environment cannot start a process: ZAI_API_KEY contains a NUL byte'),
    'environment_unspawnable')
  // A DIFFERENT code from the NUL case, and the reason is the sentence: this
  // machine spawns an environment three times the ceiling, so calling the size
  // refusal "cannot start a process" was measurably false.
  assert.equal(classify('zai review environment is over budget: it is 2097262 bytes and the ceiling is 262144'),
    'environment_over_budget')
  assert.equal(classify('zai review environment is over budget: ZAI_API_KEY is 204802 bytes and the per-value ceiling is 65536'),
    'environment_over_budget')
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
  assert.deepEqual(TOOLS.map(t => t.name), ['acp_lanes', 'acp_lane_status', 'acp_lane_probe'])
  assert.deepEqual(TOOL_DESCRIPTORS.map(d => d.name), TOOLS.map(t => t.name))
  assert.ok(TOOL_DESCRIPTORS.every(d => typeof d.handler === 'function'))
  assert.ok(TOOLS.every(t => !('handler' in t)), 'the handler must not be advertised to a client')
  const refused = callTool('launch_lane', {}, {})
  assert.match(refused.error, /no such tool/)
  assert.deepEqual(refused.known, ['acp_lanes', 'acp_lane_status', 'acp_lane_probe'],
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
  // `protocolVersion` is in the loop because a round-nine lane found the
  // surrounding text saying all THREE initialize fields are required while the
  // loop removed two — so a regression on the third would have stayed green.
  for (const missing of ['capabilities', 'clientInfo', 'protocolVersion']) {
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
  // `tools/call` is in the list because a round-nine lane found it MISSING: a
  // mutation that replied only to an id-less `tools/call` survived, since every
  // method here reached the no-id check through a path that did not run a
  // handler. The one method that does is the one that was left out.
  for (const method of ['notifications/initialized', 'ping', 'tools/list', 'initialize', 'tools/call']) {
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

test('an id the spec calls legal is answered as itself, and a fractional one never loses correlation', () => {
  // Strings and integers are not in dispute.
  for (const id of [1, -1, 0, 2500, 'a-string-id', '', '0']) {
    const reply = handle({ jsonrpc: '2.0', id, method: 'ping' }, {})
    assert.deepEqual(reply, { jsonrpc: '2.0', id, result: {} },
      `a legal request id was not answered as itself: ${JSON.stringify(id)}`)
  }

  // FRACTIONAL IDS ARE DISPUTED AND THIS TEST NO LONGER PICKS A SIDE.
  // A Codex advisor round read MCP's `RequestId` as `string | number` and
  // called `Number.isInteger` a local MUST NOT invented from JSON-RPC's
  // SHOULD NOT. A round-eight panel lane read the 2025-06-18 versioned schema
  // as `string | integer` and called the TypeScript alias too broad to make
  // fractional ids legal. No copy of the schema is readable from this machine,
  // so neither reading can be settled here.
  //
  // What the previous version of this test did was pin ONE of them, which
  // forced a conforming fix red — the lane's actual complaint. So it asserts
  // the property both readings agree on: whichever way `1.5` is answered, the
  // answer must carry the id back. Refusing under `id: null` is the one
  // outcome that is wrong under either reading, because it loses the
  // correlation the caller needs to match the reply to the request.
  for (const id of [1.5, 2.5e3 + 0.5]) {
    const reply = handle({ jsonrpc: '2.0', id, method: 'ping' }, {})
    assert.equal(reply.id, id,
      `a fractional id was answered under a different id (${JSON.stringify(reply.id)}), `
      + 'which loses the correlation whether or not it is legal')
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
      // The anti-sweep guard, over the REAL spawned subprocess rather than
      // in-process only. This is free and deterministic even here: a refusal
      // never reaches the transport, so no lane is ever spawned by this call.
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'acp_lane_probe', arguments: {} } })
      send({ jsonrpc: '2.0', id: 5, method: 'ping' })
      const code = await new Promise((done) => {
        setTimeout(() => child.stdin.end(), 600)
        child.on('close', done)
      })
      assert.equal(code, 0, 'the server exited nonzero')
      assert.ok(out.trim(), 'the launched server answered nothing at all — serve() never ran')
      const replies = out.trim().split('\n').map(line => JSON.parse(line))
      // Membership, not wire ORDER: `acp_lane_probe` is the one handler that
      // is genuinely async (its own anti-sweep refusal still returns through
      // an async function, so it resolves a microtask or more later than a
      // purely synchronous reply like ping's). JSON-RPC 2.0 does not promise
      // response order for concurrent requests — a client correlates by `id`
      // — so asserting a fixed position here would pin an accident of timing
      // rather than the contract.
      assert.deepEqual([...replies.map(r => r.id)].sort((a, b) => a - b), [1, 2, 3, 4, 5],
        'the notification was answered, or a request was not, or one arrived under the wrong id')
      const byId = new Map(replies.map(r => [r.id, r]))
      assert.equal(byId.get(1).result.protocolVersion, PROTOCOL_VERSION)
      assert.deepEqual(byId.get(2).result.tools.map(t => t.name),
        ['acp_lanes', 'acp_lane_status', 'acp_lane_probe'])
      assert.equal(JSON.parse(byId.get(3).result.content[0].text).lanes.length, 7)
      const probeRefusal = JSON.parse(byId.get(4).result.content[0].text)
      assert.equal(byId.get(4).result.isError, true, 'a probe call with no lanes must be reported as refused')
      assert.match(probeRefusal.error, /non-empty array of lane ids/)
      assert.deepEqual(byId.get(5).result, {}, 'ping was not answered with an empty result')
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

    // A BARE NAME RESOLVES AGAINST THE SUPPLIED PATH. The first version refused
    // to — "this function does not own the PATH" — and that refusal was a hole
    // wearing the words of a principle: the function is GIVEN the PATH, and the
    // case two families named in three consecutive rounds,
    // `#!/usr/bin/env <missing>`, is the one the motivating comment used.
    writeFileSync(bin, '#!/usr/bin/env definitelynotinstalled\n')
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home, PATH: '/usr/bin:/bin' } }),
      'definitelynotinstalled',
      'the exact case the comment names went unchecked')

    // THE `env` BINARY ITSELF. `#!/definitely/not/here/env sh` finds `sh` on
    // PATH, and the kernel still fails on the missing `env` — the previous
    // version treated any path ending `/env` as a working one.
    writeFileSync(bin, '#!/definitely/not/here/env sh\n')
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home, PATH: '/usr/bin:/bin' } }),
      '/definitely/not/here/env',
      'a missing env binary was accepted because the token after it resolves')

    // and a bare name that IS on the PATH is not maligned
    writeFileSync(bin, '#!/usr/bin/env sh\n')
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home, PATH: '/usr/bin:/bin' } }), null)

    // Resolution uses the PATH THE CHILD RECEIVES, which is
    // `executablePath(env)` — the caller's PATH with `$HOME/.local/bin`,
    // `$HOME/.kimi-code/bin` and `$HOME/.bun/bin` prepended. A lane reproduced
    // both errors from resolving against the caller's raw PATH instead: a false
    // `valid` when the interpreter is only on the prepended path, and a false
    // `unchecked` when it is only on the caller's.
    //
    // So with no caller PATH there is still something to resolve against, and
    // this assertion used to say the opposite because it encoded the older
    // design rather than the child's environment.
    writeFileSync(bin, '#!/usr/bin/env definitelynotinstalled\n')
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home } }),
      'definitelynotinstalled',
      'with no caller PATH the child still gets one, so the answer is knowable')

    // and an interpreter that exists ONLY on the prepended path resolves, which
    // resolving against the caller's PATH would have called missing
    const prepended = join(home, '.local', 'bin')
    writeFileSync(join(prepended, 'privatetool'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(prepended, 'privatetool'), 0o755)
    writeFileSync(bin, '#!/usr/bin/env privatetool\n')
    chmodSync(bin, 0o755)
    assert.equal(unresolvedInterpreterFor('agy', { env: { HOME: home, PATH: '/nonexistent' } }), null,
      'an interpreter on the prepended path was reported missing')

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

test('the sentence about which names that file is read for names all of them', () => {
  // "any other name in it is ignored" listed `acceptedCredentialNames` — the
  // credential subset — while the loader honours `acceptedRoutedKeys`, which
  // adds the routed settings names. An operator who put ANTHROPIC_BASE_URL in
  // that file was told it would be ignored while the loader read it.
  //
  // A lane raised this in round six; I deferred it as single-family; the same
  // lane raised it again in round seven after reading that deferral, which is
  // the reversal condition the roadmap states.
  const honoured = [...acceptedRoutedKeys(REVIEW_PROFILES.zai)]
  const sentence = fixesFor('zai', REVIEW_PROFILES.zai, 'credential_missing').join(' ')
  const named = sentence.match(/that file is read for ([^—]+)—/)?.[1] ?? ''
  for (const key of honoured) {
    assert.ok(named.includes(key),
      `the loader honours ${key} and the sentence tells the operator it is ignored`)
  }
  // and it does not promise names the loader drops
  for (const key of named.split(',').map((k) => k.trim()).filter(Boolean)) {
    assert.ok(honoured.includes(key), `the sentence advertises ${key}, which the loader ignores`)
  }
})

test('initialize types the members MCP 2025-06-18 types, and still admits an unknown capability', () => {
  // A lane reproduced both frames returning SUCCESS from a validator whose
  // comment claims to match this protocol version: `clientInfo.title: 42` and
  // `capabilities: { roots: { listChanged: "yes" } }`.
  const base = { protocolVersion: '2025-06-18', capabilities: {} }
  const ok = { name: 'probe', version: '1' }
  const init = (params) => handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params }, {})

  assert.equal(init({ ...base, clientInfo: { ...ok, title: 42 } }).error?.code, -32602)
  assert.ok(init({ ...base, clientInfo: { ...ok, title: 'A Probe' } }).result,
    'an optional title of the right type was refused')

  assert.equal(init({ protocolVersion: '2025-06-18', clientInfo: ok,
    capabilities: { roots: { listChanged: 'yes' } } }).error?.code, -32602)
  // `sampling` and `elicitation` are OPEN objects in this version — only
  // `roots` types `listChanged`. A lane reproduced a conforming
  // `sampling: { listChanged: "vendor-extension" }` being refused by the
  // previous narrowing, which had gone from every capability to three.
  for (const open of ['sampling', 'elicitation']) {
    assert.ok(init({ protocolVersion: '2025-06-18', clientInfo: ok,
      capabilities: { [open]: { listChanged: 'vendor-extension' } } }).result,
      `a conforming ${open} capability was refused`)
    assert.ok(init({ protocolVersion: '2025-06-18', clientInfo: ok,
      capabilities: { [open]: { anything: { nested: true } } } }).result)
  }
  assert.ok(init({ protocolVersion: '2025-06-18', clientInfo: ok,
    capabilities: { roots: { listChanged: true } } }).result)
  assert.equal(init({ protocolVersion: '2025-06-18', clientInfo: ok,
    capabilities: { roots: 'yes' } }).error?.code, -32602)

  // An UNKNOWN capability is a client extension and stays legal. The first
  // version of this assertion used an extension with NO `listChanged` key, so
  // it passed while the real hole stood: the check demanded a boolean
  // `listChanged` from EVERY capability name, and a lane reproduced a legal
  // `experimental` map being refused for it. A fixture that cannot fail the
  // rule it is written for proves nothing.
  //
  // One fixture MOVED, and the move is the point. This list used to carry
  // `{ experimental: { listChanged: 'a string, and legal here' } }` as an
  // example of a legal extension. It is not one: `experimental` is a member MCP
  // NAMES, declared `{ [key: string]: object }`, so a string value inside it is
  // invalid however unknown the key is. The lesson the fixture was written for
  // — `listChanged` is not boolean-typed outside `roots` — is true at an
  // UNKNOWN top-level name, which is where it now lives. The version below it,
  // with an object value, stays exactly where it was and still carries the same
  // proof inside `experimental`.
  //
  // Two things were being called "extension": a capability name MCP has never
  // heard of, and a key inside a map MCP defines. Only the first is untyped.
  for (const extension of [
    { somethingNobodyHasShippedYet: { whatever: 1 } },
    { someVendorNamespace: { listChanged: 'a string, and legal here' } },
    { experimental: { listChanged: { nested: true } } },
    { vendorThing: null },
  ]) {
    assert.ok(init({ protocolVersion: '2025-06-18', clientInfo: ok, capabilities: extension }).result,
      `a client extension was refused (${JSON.stringify(extension)}), `
      + 'which turns a validator into a ceiling on the protocol')
  }

  // and NO caller text reaches the reply — the constant-sentence invariant this
  // module states about itself, which the capability loop broke while enforcing
  // a different one.
  // Note what this can and cannot prove. Once the loop reads only the three
  // typed names, `name` is a constant and interpolating it is harmless — a
  // mutation that restores `${name}` correctly does NOT turn this red. The
  // assertion that guards the echo is the one above: iterating the CALLER's
  // keys fails, and that is the only way caller text can reach the sentence.
  const marker = 'SECRETSHAPEDCALLERVALUE'
  const echoed = JSON.stringify(init({ protocolVersion: '2025-06-18', clientInfo: ok,
    capabilities: { [marker]: null } }))
  assert.ok(!echoed.includes(marker), `the caller's capability name was echoed: ${echoed}`)
})

test('a routing that could not pass validation cannot exempt a launch collision', () => {
  // `routingDeclaration()` took a non-empty host and serialized a missing path
  // as `null`, while `validateRoutedEndpoint()` beside it demands both as
  // strings — so two byte-identical launches could be certified DISTINCT by
  // metadata the validator would reject. A pin that cannot pass validation is
  // not a pin, and exempting a collision on one is the bypass that check exists
  // to close.
  //
  // Driven through `provenFamilyCollision`, the exported consumer, because
  // `routingDeclaration` is internal ON PURPOSE — issue #43 folded those
  // helpers away and `tests/lane-identity.test.mjs` pins that they stay folded.
  // The first version of this guard exported it and turned that test red; the
  // second asserted the shipped profiles carry string paths, which is today's
  // DATA and stayed green when the requirement was deleted.
  // Two REAL routed lanes of different families that share an adapter command —
  // the exact shape `routesApart` exists for, taken from the shipped table
  // rather than invented, because an invented family normalises to `unknown`
  // and collides for a reason that has nothing to do with routing.
  // qwen and deepseek, because they REALLY share a launch signature — both run
  // the same adapter through `/Users/ngs/bin/claude-qwen`. Measured, not
  // chosen: kimi and zai have distinct wrappers, so a fixture built from them
  // never reaches the routing comparison at all and the guard proves nothing.
  // This is the pair the reviewer named.
  const a = REVIEW_PROFILES.qwen
  const shipped = REVIEW_PROFILES.deepseek
  // Measured: the two SHIPPED lanes share a wrapper AND an endpoint, so they
  // collide — correctly, and this test is not about that. Give the second a
  // genuinely different host and the collision must lift.
  assert.equal(provenFamilyCollision([a, shipped]), true,
    'two lanes sharing a wrapper AND an endpoint stopped colliding')
  const b = { ...shipped, endpoint: { host: 'deepseek.example', path: '/v1' } }
  assert.equal(provenFamilyCollision([a, b]), false,
    'two exec-identical lanes pinned to DIFFERENT endpoints were treated as a collision')

  // the same pair where one pin has no path: it cannot validate, so it must not
  // buy an exemption
  // NOT the empty string: `validateRoutedEndpoint` accepts `''` because
  // `https://host` has pathname `/` and its trailing-slash strip makes that
  // `''`, so a host-root endpoint is a real pin. The first version of this test
  // called `''` unvalidatable and required a collision — holding route identity
  // and launch validation to contradictory definitions, which a panel lane
  // named and which can falsely block a genuinely distinct routed family.
  for (const badPath of [undefined, 42, null, {}]) {
    const crippled = { ...b, endpoint: { ...b.endpoint, path: badPath } }
    assert.equal(provenFamilyCollision([a, crippled]), true,
      `a routing with path ${JSON.stringify(badPath)} bought an exemption the validator would refuse`)
  }

  // and a HOST-ROOT pin is a real pin, so it must lift the collision the same
  // way a path-bearing one does — the direction the old rule got wrong.
  const hostRoot = { ...shipped, endpoint: { host: 'deepseek.example', path: '' } }
  assert.equal(provenFamilyCollision([a, hostRoot]), false,
    'a legitimate host-root endpoint was treated as an unvalidatable pin')
})

test('every routed lane accepts its OWN provider key, not just the Anthropic pair', () => {
  // A round-seven lane reported that `acceptedCredentialNames` does not exist
  // and that `validateRoutedEndpoint` still checks three hardcoded keys, so
  // KIMI_API_KEY is read and never accepted. Measured against the shipped code,
  // that is FALSE — and this test is the record of the disproof, so the next
  // reader does not have to take my word for it.
  //
  // Two of my own probes were wrong before this one was right: ANTHROPIC_BASE_URL
  // passed in ambient env is NOT read, because `buildProfileEnv` copies only the
  // runtime keys and the routed settings come from the file. A claim about this
  // code has to be tested the way the loader loads.
  for (const id of ROUTED_PROFILES) {
    const profile = REVIEW_PROFILES[id]
    // EVERY name the lane advertises, not "at least one of its own" — that was
    // an invented requirement and `deepseek` and `qwen` failed it honestly:
    // both route through a gateway that authenticates with the Anthropic pair
    // and declare no key of their own. The defect being disproved is narrower
    // and is the half-fix shape: a name that is READ and then not ACCEPTED.
    const own = acceptedCredentialNames(profile)
    assert.ok(own.length > 0, `${id} accepts no credential name at all`)

    const dir = mkdtempSync(join(tmpdir(), `lane-cred-${id}-`))
    try {
      const url = `https://${profile.endpoint.host}${profile.endpoint.path}`
      for (const key of own) {
        writeFileSync(join(dir, 'creds.env'), `ANTHROPIC_BASE_URL=${url}\n${key}=value\n`)
        const env = { HOME: '/tmp', PATH: '/usr/bin',
          [`TMUX_TEAMS_REVIEW_${id.toUpperCase()}_ENV_FILE`]: join(dir, 'creds.env') }
        assert.doesNotThrow(() => buildAcpLaunch(id, { env }),
          `${id} reads ${key} and then refuses it — the half-fix shape`)
      }
      // and a key belonging to ANOTHER lane is still refused
      writeFileSync(join(dir, 'creds.env'), `ANTHROPIC_BASE_URL=${url}\nSOMEONE_ELSES_API_KEY=value\n`)
      assert.throws(() => buildAcpLaunch(id, {
        env: { HOME: '/tmp', PATH: '/usr/bin',
          [`TMUX_TEAMS_REVIEW_${id.toUpperCase()}_ENV_FILE`]: join(dir, 'creds.env') },
      }), `${id} accepted a credential name that belongs to no lane`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a lane report calls its adapter DECLARED, because a caller can change which bytes run', () => {
  // A round-seven lane: every shipped adapter command begins with a bare `npx`
  // or `bunx`, `buildProfileEnv` preserves the caller's PATH, and
  // `executablePath` PREPENDS caller-owned home directories. So the operator
  // controls which binary resolves, and this tool reports the package the
  // profile names rather than the bytes that ran.
  //
  // The prepending stays — on a version-manager machine the toolchain lives
  // under $HOME and a launch that cannot find it is a shipped outage. What must
  // hold is that the REPORT does not overclaim.
  const facts = JSON.stringify(callTool('acp_lanes', {}, { HOME: '/tmp', PATH: '/usr/bin' }))
  assert.ok(!/verified adapter|adapter verified|adapter identity confirmed/i.test(facts),
    'a lane report claims the adapter bytes were verified')
  assert.match(facts, /"adapter"/, 'the report stopped naming the adapter at all')

  // and every shipped adapter command really does start with a bare resolver,
  // which is WHY the report can only declare the package, never confirm the
  // bytes that ran.
  for (const [id, profile] of Object.entries(REVIEW_PROFILES)) {
    const argv = profile.command ?? profile.argv ?? []
    if (!argv.length) continue
    assert.ok(['npx', 'bunx'].includes(argv[0]) || argv[0].includes('/'),
      `${id} launches ${argv[0]}, which is neither a bare resolver nor an absolute path`)
  }
})

test('a credential Node cannot spawn with is not a valid configuration', () => {
  // A lane reproduced it end to end: `acceptedCredential` tested only
  // truthiness, so a NUL-bearing `ZAI_API_KEY` gave `configuration: "valid"`
  // while passing the resulting `buildAcpLaunch().env` to process creation
  // throws ERR_INVALID_ARG_VALUE. The status of a configuration that cannot
  // start a process is not "valid".
  const NUL = String.fromCharCode(0)
  const dir = mkdtempSync(join(tmpdir(), 'lane-nul-'))
  try {
    const profile = REVIEW_PROFILES.zai
    const url = `https://${profile.endpoint.host}${profile.endpoint.path}`
    writeFileSync(join(dir, 'creds.env'), `ANTHROPIC_BASE_URL=${url}\nZAI_API_KEY=x${NUL}y\n`)
    const env = { HOME: '/tmp', PATH: '/usr/bin',
      TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: join(dir, 'creds.env') }
    const lane = callTool('acp_lane_status', { lane: 'zai' }, env).lanes[0]
    assert.notEqual(lane.configuration, 'valid',
      'a NUL-bearing credential was reported as a valid configuration')

    // and the environment a good credential builds is one Node will accept
    const good = join(dir, 'good.env')
    writeFileSync(good, `ANTHROPIC_BASE_URL=${url}\nZAI_API_KEY=ordinary\n`)
    const built = buildAcpLaunch('zai', {
      env: { HOME: '/tmp', PATH: '/usr/bin', TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: good },
    })
    for (const [k, v] of Object.entries(built.env ?? {})) {
      assert.ok(!String(v).includes(NUL), `${k} carries a NUL into the child environment`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lane is told the model its gateway answers to, not the one the panel records', () => {
  // A round-nine lane reproduced the mismatch: `deepseek` pins
  // `requestModel: 'sonnet'` because that is the alias its gateway takes, while
  // `profile.model` is the vendor id `deepseek-v4-flash-0731`.
  // `CLAUDE_MODEL_CONFIG.availableModels` was built from `model`, so the
  // adapter advertised a model the gateway does not accept — in the one place
  // it reads to decide what to ask for.
  //
  // Two questions that had shared one answer: `model` is the identity the panel
  // RECORDS, `requestModel` is what the wire is ASKED for.
  // Routed lanes refuse to build an env without their pinned endpoint and a
  // credential, so the fixture supplies both through the file the loader reads
  // — measured the hard way twice already: ambient env is not read.
  const dir = mkdtempSync(join(tmpdir(), 'lane-reqmodel-'))
  try {
  for (const [id, profile] of Object.entries(REVIEW_PROFILES)) {
    if (!profile.requestModel) continue
    const source = { HOME: '/tmp', PATH: '/usr/bin' }
    if (profile.endpoint) {
      const file = join(dir, `${id}.env`)
      writeFileSync(file, `ANTHROPIC_BASE_URL=https://${profile.endpoint.host}${profile.endpoint.path}\n`
        + 'ANTHROPIC_AUTH_TOKEN=ordinary\n')
      source[`TMUX_TEAMS_REVIEW_${id.toUpperCase()}_ENV_FILE`] = file
    }
    const env = buildProfileEnv(id, source)
    if (!env.CLAUDE_MODEL_CONFIG) continue
    const advertised = JSON.parse(env.CLAUDE_MODEL_CONFIG).availableModels
    assert.deepEqual(advertised, [profile.requestModel],
      `${id} advertises ${JSON.stringify(advertised)} to a gateway that takes ${profile.requestModel}`)
  }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the vendor-neutral registration BOOTS, and a live client that never closes gets answers', async () => {
  // Two round-nine findings, both about this file proving less than it says.
  //
  // First: `mcp.json` had only ever been compared as STRINGS against
  // `.mcp.json`. A lane reported it in round six, I closed that with a
  // string-comparison test, and the lane repeated in round nine that comparing
  // strings is not booting. So this SPAWNS the vendor-neutral registration's
  // own argv, with `${PLUGIN_ROOT}` expanded the way its contract says.
  //
  // Second: both stdio checks fed input that ENDS (`Readable.from` closes), so
  // a server that never answers a live client passed them. This client stays
  // open until it has its reply, which is what a real host does.
  const neutral = JSON.parse(readFileSync(join(PLUGIN, 'mcp.json'), 'utf8'))
    .mcpServers['tmux-teams-acp-lanes']
  const argv = neutral.args.map((a) => a.replace('${PLUGIN_ROOT}', PLUGIN))
  // `process.execPath` where the manifest says bare `node`: on a
  // version-manager machine there is no `node` on a minimal PATH, which this
  // repository has already paid for once. The manifest's own `command` is
  // asserted separately below — running it here would test this machine's PATH,
  // not the registration.
  assert.equal(neutral.command, 'node')
  const child = spawn(process.execPath, argv, {
    cwd: neutral.cwd.replace('${PLUGIN_ROOT}', PLUGIN),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: '/tmp' },
  })
  try {
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    // stdin stays OPEN — the frames go in and nothing closes the stream
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'live-client', version: '1' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && out.split('\n').filter(Boolean).length < 2) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(replies.length, 2,
      `the vendor-neutral server answered ${replies.length} of 2 frames from a client that stayed open`)
    assert.equal(replies[0].id, 1)
    assert.ok(replies[0].result?.protocolVersion, 'initialize returned no protocolVersion')
    assert.equal(replies[1].id, 2)
    assert.ok(Array.isArray(replies[1].result?.tools), 'tools/list returned no tools')
  } finally {
    child.kill('SIGKILL')
  }
})

test('the endpoint pin is checked against a written-down value, not against itself', () => {
  // A round-nine lane: the wire fixtures covered a correct URL, a different
  // host and no endpoint — never the pinned PATH being wrong — and the oracle
  // was derived from `REVIEW_PROFILES[id].endpoint`, the same value it was
  // meant to establish. Change the profile and the test agrees with the change.
  //
  // These literals are the pins as reviewed. A profile edit that moves an
  // endpoint now has to move a written-down value too, which is the point.
  const PINNED = {
    zai: 'https://api.z.ai/api/anthropic',
    kimi: 'https://api.kimi.com/coding',
    qwen: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    deepseek: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
  }
  for (const [id, url] of Object.entries(PINNED)) {
    const e = REVIEW_PROFILES[id].endpoint
    assert.equal(`https://${e.host}${e.path}`, url, `${id}'s pinned endpoint moved`)
  }

  // and a WRONG PATH on the right host is refused, which no fixture covered
  const dir = mkdtempSync(join(tmpdir(), 'lane-pinpath-'))
  try {
    const e = REVIEW_PROFILES.zai.endpoint
    for (const wrong of [`https://${e.host}/wrong`, `https://${e.host}`, `https://${e.host}${e.path}/extra`]) {
      writeFileSync(join(dir, 'creds.env'),
        `ANTHROPIC_BASE_URL=${wrong}\nZAI_API_KEY=ordinary\n`)
      assert.throws(() => buildAcpLaunch('zai', {
        env: { HOME: '/tmp', PATH: '/usr/bin', TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: join(dir, 'creds.env') },
      }), `${wrong} was accepted for a lane pinned to ${e.path}`)
    }
    // the right one still works
    writeFileSync(join(dir, 'creds.env'),
      `ANTHROPIC_BASE_URL=https://${e.host}${e.path}\nZAI_API_KEY=ordinary\n`)
    assert.doesNotThrow(() => buildAcpLaunch('zai', {
      env: { HOME: '/tmp', PATH: '/usr/bin', TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: join(dir, 'creds.env') },
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Found by a codex-advisor lane against the running stdio server, then pinned
// here. The check above types `roots` and stops, so `sampling: true`,
// `elicitation: null` and `experimental: null` were all ACCEPTED while MCP
// 2025-06-18 types every one of them as an object.
//
// Note WHY the previous test did not catch it, because the shape repeats: it
// sent well-formed objects carrying odd VALUES and never sent a member that was
// not an object at all. Two separate axes were being validated by one list, and
// narrowing the list to fix the `listChanged` axis silently narrowed the
// object-shape axis with it. They are separate lists now.
test('every capability member MCP types as an object must be one', () => {
  const ok = { name: 'probe', version: '1' }
  const init = (capabilities) => handle({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: ok, capabilities } }, {})

  for (const name of ['roots', 'sampling', 'elicitation', 'experimental']) {
    for (const bad of [true, null, 42, 'yes', ['a']]) {
      const answer = init({ [name]: bad })
      assert.equal(answer.error?.code, -32602,
        `capabilities.${name} = ${JSON.stringify(bad)} was accepted`)
      assert.equal(answer.error?.message, 'initialize capabilities members must be objects',
        `capabilities.${name} = ${JSON.stringify(bad)} was refused with the wrong sentence`)
    }
    assert.ok(init({ [name]: {} }).result, `an empty ${name} object was refused`)
  }

  // The two axes stay separate: only `roots` types `listChanged`, and an
  // unknown name is a client extension whatever it holds. Both are re-asserted
  // HERE rather than trusted from the test above, because the fix that added
  // the object list is exactly the change that could swing them back.
  assert.equal(init({ roots: { listChanged: 'yes' } }).error?.code, -32602)
  assert.ok(init({ sampling: { listChanged: 'vendor-extension' } }).result,
    'a conforming open-object sampling capability was refused')
  assert.ok(init({ someVendorExtension: null }).result,
    'an unknown capability was typed as though MCP named it')
})

// `experimental` carries a SECOND rule inside it, and the first fix stopped at
// the door. MCP 2025-06-18 declares `experimental?: { [key: string]: object }`,
// so every value in that map is object-typed as well. A lane sent
// `{"experimental":{"vendor":true}}` to the running server and got a successful
// initialize back — after the outer-shape list had been corrected and looked
// complete, because the four names in it ARE the right four.
//
// The shape to remember: a fix that satisfies the sentence in the report is not
// the same as a fix that satisfies the schema. Nothing in "sampling:true is
// accepted" hints that a map has typed values.
test('experimental carries typed values, not just a typed container', () => {
  const ok = { name: 'probe', version: '1' }
  const init = (capabilities) => handle({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: ok, capabilities } }, {})

  for (const bad of [true, null, 42, 'x', ['a']]) {
    const answer = init({ experimental: { vendor: bad } })
    assert.equal(answer.error?.code, -32602,
      `experimental.vendor = ${JSON.stringify(bad)} was accepted`)
    assert.equal(answer.error?.message, 'initialize capabilities experimental values must be objects',
      `experimental.vendor = ${JSON.stringify(bad)} was refused with the wrong sentence`)
  }
  assert.ok(init({ experimental: { vendor: {} } }).result,
    'an empty experimental value object was refused')
  assert.ok(init({ experimental: { vendor: { nested: 'anything' } }, }).result,
    'a populated experimental value object was refused')
  assert.ok(init({ experimental: {} }).result, 'an empty experimental map was refused')

  // The OUTER rule still applies and is a different sentence, so a regression
  // that collapses the two is visible rather than merely still-refusing.
  assert.equal(init({ experimental: null }).error?.message,
    'initialize capabilities members must be objects')
})

// FOUR rounds of narrower fixes, each correct about the case it was shown and
// none about the property. `spawnableValue` first decided whether at least one
// accepted credential existed; then it was applied to the forwarded secrets and
// a lane put the same NUL in the routed SETTINGS, assigned earlier; then a
// 2 MiB credential passed every per-value check and the kernel answered E2BIG;
// then the sweep that fixed all three ran AFTER the endpoint check, so a lane
// whose only credential carried a NUL still answered `credential_missing` — the
// "you already added it" outcome the sweep exists to prevent, produced by the
// sweep that prevents it.
//
// The property is about the FINISHED environment, so it is asserted there, and
// this table is the rule rather than four examples of breaking it.
//
// The test this replaces claimed to prove the launch could start a process and
// proved nothing: `assert.doesNotThrow(() => spawnSync(...))` — spawnSync
// RETURNS `result.error`. A lane short-circuited that line and all 1103 tests
// stayed green.
test('an environment that cannot start a process is never reported valid', () => {
  const NUL = String.fromCharCode(0)
  const NUL_FIX = 'contains a NUL byte and cannot be passed to a process'
  const BUDGET_FIX = 'is larger than this gate passes to a lane — it has to be'
  const endpoint = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
  const withToken = { ...endpoint, ANTHROPIC_AUTH_TOKEN: 'valid-token' }
  const cases = [
    { name: 'a clean lane', settings: withToken, ambient: {}, code: null },
    // The ORDER case: no second credential to fall back on, so a sweep running
    // after the endpoint check answers `credential_missing` here.
    { name: 'the only credential carries a NUL', settings: endpoint,
      ambient: { ZAI_API_KEY: `bad${NUL}value` }, code: 'environment_unspawnable',
      expectedFix: `ZAI_API_KEY ${NUL_FIX}` },
    { name: 'a NUL beside a good credential', settings: withToken,
      ambient: { ZAI_API_KEY: `bad${NUL}value` }, code: 'environment_unspawnable',
      expectedFix: `ZAI_API_KEY ${NUL_FIX}` },
    { name: 'a NUL in the routed settings', settings: { ...withToken, ZAI_API_KEY: `bad${NUL}value` },
      ambient: {}, code: 'environment_unspawnable', expectedFix: `ZAI_API_KEY ${NUL_FIX}` },
    { name: 'a credential over the total budget', settings: withToken,
      ambient: { ZAI_API_KEY: 'x'.repeat(2 * 1024 * 1024) },
      code: 'environment_over_budget', expectedFix: `ZAI_API_KEY ${BUDGET_FIX}` },
    // Under the TOTAL and over the per-string cap Linux enforces at 131072.
    // This host spawns it; the CI host would not.
    // BOTH SIDES of the per-value boundary. A single 200 KiB case proved only
    // that SOME bound existed: raising the ceiling from 64 KiB to 192 KiB left
    // the whole suite green, so a value between the Linux MAX_ARG_STRLEN of
    // 131072 and our ceiling could be admitted while the test named for that
    // cap stayed green. The pair pins the number.
    { name: 'a value just under the per-value ceiling', settings: withToken,
      ambient: { ZAI_API_KEY: 'x'.repeat(63 * 1024) }, code: null },
    { name: 'a value just over the per-value ceiling', settings: withToken,
      ambient: { ZAI_API_KEY: 'x'.repeat(70 * 1024) },
      code: 'environment_over_budget', expectedFix: `ZAI_API_KEY ${BUDGET_FIX}` },
    // Comfortably under the total and OVER the Linux per-string cap. Refusing
    // it is the whole point of having a per-value rule at all, and this host
    // spawns it happily, so nothing but the rule can catch it here.
    { name: 'one value over the Linux per-string cap', settings: withToken,
      ambient: { ZAI_API_KEY: 'x'.repeat(200 * 1024) },
      code: 'environment_over_budget', expectedFix: `ZAI_API_KEY ${BUDGET_FIX}` },
    // MANY values, each comfortably under the per-string cap, summing past the
    // total. Without this the total ceiling had no guard of its own: widening
    // it from 256 KiB to 1 MiB left every case above still refused by the
    // per-string rule, so the number could move and nothing noticed.
    { name: 'many values summing over the total budget',
      settings: { ...withToken,
        ANTHROPIC_CUSTOM_HEADERS: 'h'.repeat(60 * 1024),
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'o'.repeat(60 * 1024),
        ANTHROPIC_DEFAULT_SONNET_MODEL: 's'.repeat(60 * 1024),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h'.repeat(60 * 1024),
        ANTHROPIC_API_KEY: 'k'.repeat(60 * 1024) },
      ambient: {}, code: 'environment_over_budget',
      expectedFix: 'the values this lane forwards exceed the total' },
  ]
  for (const { name, settings, ambient, code, expectedFix } of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'))
    try {
      const file = join(dir, 'zai.json')
      writeFileSync(file, JSON.stringify({ env: settings }))
      const env = { HOME: dir, PATH: process.env.PATH,
        TMUX_TEAMS_REVIEW_ZAI_SETTINGS: file, ...ambient }
      const status = laneStatus('zai', REVIEW_PROFILES.zai, env)

      if (code) {
        assert.equal(status.configuration, 'invalid', `${name} was reported valid`)
        assert.equal(status.problem?.code, code,
          `${name} was refused as ${status.problem?.code}`)
        // The REPAIR names the value. It used to say "the refusal names which"
        // while this boundary drops the raw exception, so it named nothing, and
        // then pointed at a settings file that does not hold an ambient key.
        // The SENTENCE, not merely the key appearing somewhere. Renaming the
        // remediation case out of the switch left this green when it only
        // checked for the key, because the fallback repair names the settings
        // file and the settings file path contains it. A guard that a wrong
        // answer satisfies is not a guard.
        assert.ok(status.fixes.some((fix) => fix.includes(expectedFix)),
          `${name} produced a repair that never says "${expectedFix}": ${JSON.stringify(status.fixes)}`)
        // A deterministic stage for review-gate: a plain TypeError has no code,
        // lands in `transport`, and the operator is told to re-run a refusal
        // that is identical on every attempt.
        assert.throws(() => buildAcpLaunch('zai', { env }), (error) => error.code === 'config',
          `${name} threw without a deterministic stage code`)
        continue
      }

      assert.equal(status.configuration, 'valid', `${name} was refused`)
      const launch = buildAcpLaunch('zai', { env })
      // `result.error`, not doesNotThrow — spawnSync returns its failure.
      const result = spawnSync(process.execPath, ['-e', ''], { env: launch.env })
      assert.equal(result.error, undefined,
        `${name} built an environment the OS refused: ${result.error?.code}`)
      assert.equal(result.status, 0, `${name} built an environment that exited ${result.status}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// A separate assertion on the SIZE claim, because the sentence is the finding.
// The first version refused at 256 KiB saying "cannot start a process", and a
// lane measured this machine starting one at 921,600 bytes. The refusal is a
// policy of ours; it has to read like one.
test('the size refusal claims a budget and never claims the platform refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-budget-'))
  try {
    const file = join(dir, 'zai.json')
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'valid-token' } }))
    const env = { HOME: dir, PATH: process.env.PATH, TMUX_TEAMS_REVIEW_ZAI_SETTINGS: file,
      ZAI_API_KEY: 'x'.repeat(2 * 1024 * 1024) }
    assert.throws(() => buildAcpLaunch('zai', { env }), (error) => {
      assert.match(error.message, /over budget/)
      assert.doesNotMatch(error.message, /cannot start a process/,
        'the size refusal asserts the platform refused, which was measured false')
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The repair, APPLIED. A lane found the over-budget advice said "point the lane
// at a credential file instead of an inline value" and measured the identical
// refusal after doing exactly that: `loadRoutedCredentialFile` reads the file
// and puts the same bytes into the child environment, where the same ceiling
// refuses them.
//
// This repository's diagnostic contract is that applying a fix changes the
// state, and a prose assertion that a sentence mentions the right thing is not
// a test of the repair — the file already says so about a different fix, and
// the same gap reopened one commit later in a sentence I wrote.
test('the over-budget repair does not send an operator somewhere that repeats the refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-budget-move-'))
  try {
    const settings = join(dir, 'zai.json')
    const credentials = join(dir, 'zai.env')
    const big = 'x'.repeat(70 * 1024)
    writeFileSync(settings, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }))
    const base = { HOME: dir, PATH: process.env.PATH, TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings }

    const inline = laneStatus('zai', REVIEW_PROFILES.zai, { ...base, ZAI_API_KEY: big })
    assert.equal(inline.problem?.code, 'environment_over_budget')

    writeFileSync(credentials, `ZAI_API_KEY=${big}\n`)
    const moved = laneStatus('zai', REVIEW_PROFILES.zai,
      { ...base, TMUX_TEAMS_REVIEW_ZAI_ENV_FILE: credentials })
    assert.equal(moved.problem?.code, 'environment_over_budget',
      'moving the value to a file changed the refusal, so the old advice was right after all')

    // Since it does NOT repair, the advice must not offer it. Asserting the
    // absence is what keeps the sentence honest when somebody re-adds the
    // helpful-sounding half.
    const said = inline.fixes.join(' ')
    assert.doesNotMatch(said, /credential file instead of an inline value/,
      `the repair still offers a move that reproduces the refusal: ${said}`)
    assert.match(said, /has to be SHORTER/, `the repair does not say what would work: ${said}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ## `acp_lane_probe` — the third tool, and the only one that contacts anything
//
// Every test below injects `deps.probeTransport` — never a real subprocess.
// That is deliberate, not a shortcut: the roadmap item this ships names its
// own cost ("a real probe costs minutes and real quota"), so this suite must
// stay free and deterministic. The one exception is the anti-sweep refusal
// inside the boot test above, which is free even over a real spawned server
// because a refusal never reaches the transport.

const callProbe = async (args, env, transport) => {
  const reply = await handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acp_lane_probe', arguments: args },
  }, env, { probeTransport: transport })
  return { reply, payload: JSON.parse(reply.result.content[0].text) }
}

test('acp_lane_probe is advertised, and the advertised descriptor is the dispatcher\'s own', () => {
  const advertised = TOOLS.find(t => t.name === 'acp_lane_probe')
  assert.ok(advertised, 'the third tool was not advertised in tools/list')
  assert.deepEqual(advertised.inputSchema.required, ['lanes'],
    'the schema does not even ADVERTISE that lanes is required')
  assert.equal(advertised.inputSchema.properties.lanes.type, 'array')
  assert.equal(advertised.inputSchema.additionalProperties, false)
  const descriptor = TOOL_DESCRIPTORS.find(d => d.name === 'acp_lane_probe')
  assert.equal(typeof descriptor.handler, 'function')
  assert.equal(descriptor.description, advertised.description,
    'the advertised description and the dispatcher\'s own descriptor drifted apart')
  assert.match(descriptor.description, /spends real minutes and real provider quota/,
    'the cost is not stated honestly, which is part of the anti-sweep posture')
})

test('classifyProbe maps a closed SIGNAL shape onto a closed code, never onto text', () => {
  assert.equal(classifyProbe({ settled: 'response' }), null, 'a real reply is success, not a problem code')
  assert.equal(classifyProbe({ settled: 'timeout' }), 'probe_timeout')
  assert.equal(classifyProbe({ settled: 'spawn_error', errnoCode: 'ENOENT' }), 'executable_missing')
  // EACCES and EPERM are BOTH "found, not permitted" — not just the one this
  // machine's own EACCES repro happens to produce. Asserting only EACCES left
  // the EPERM half of the `||` unreached by any test.
  assert.equal(classifyProbe({ settled: 'spawn_error', errnoCode: 'EACCES' }), 'executable_unusable')
  assert.equal(classifyProbe({ settled: 'spawn_error', errnoCode: 'EPERM' }), 'executable_unusable')
  assert.equal(classifyProbe({ settled: 'exit', code: 1, quotaSignal: true }), 'quota_exhausted')
  assert.equal(classifyProbe({ settled: 'exit', code: 1, quotaSignal: false }), 'unclassified')
  assert.equal(classifyProbe({ settled: 'exit', code: 0, quotaSignal: false }), 'unclassified')
  // The three shapes only a JSON-RPC-level refusal or a malformed handshake
  // produces — none of them settle 'exit', so they had no coverage above.
  assert.equal(classifyProbe({ settled: 'refused', quotaSignal: true }), 'quota_exhausted')
  assert.equal(classifyProbe({ settled: 'refused', quotaSignal: false }), 'unclassified')
  assert.equal(classifyProbe({ settled: 'refused' }), 'unclassified')
  assert.equal(classifyProbe({ settled: 'invalid_handshake' }), 'unclassified')
  assert.equal(classifyProbe({ settled: 'cancelled' }), 'unclassified')
  // A misbehaving or future transport gets the honest catch-all, never a crash
  // and never a guess dressed as a specific answer.
  assert.equal(classifyProbe(null), 'unclassified')
  assert.equal(classifyProbe(undefined), 'unclassified')
  assert.equal(classifyProbe('a bare string a future transport might return'), 'unclassified')
  assert.equal(classifyProbe({ settled: 'a kind this file has never seen' }), 'unclassified')
  // Every non-null code this function can produce has to already be a key of
  // the closed set — a code `classifyProbe` can return that `DIAGNOSTICS` does
  // not know is a detail sentence nobody wrote.
  for (const shape of [{ settled: 'timeout' }, { settled: 'spawn_error' },
    { settled: 'spawn_error', errnoCode: 'ENOENT' }, { settled: 'spawn_error', errnoCode: 'EACCES' },
    { settled: 'spawn_error', errnoCode: 'EPERM' },
    { settled: 'exit', quotaSignal: true }, { settled: 'exit' },
    { settled: 'refused', quotaSignal: true }, { settled: 'refused' },
    { settled: 'invalid_handshake' }, { settled: 'cancelled' }, {}]) {
    const code = classifyProbe(shape)
    assert.ok(code === null || Object.hasOwn(DIAGNOSTICS, code),
      `classifyProbe(${JSON.stringify(shape)}) returned ${code}, which DIAGNOSTICS does not define`)
  }
  assert.ok(Object.hasOwn(DIAGNOSTICS, 'quota_exhausted') && Object.hasOwn(DIAGNOSTICS, 'probe_timeout'))
})

test('acp_lane_probe refuses every shape that is not an explicit non-empty array of ids, and spawns nothing', async () => {
  const spy = []
  const transport = async (call) => { spy.push(call); return { settled: 'response' } }
  const cases = [
    [{}, /non-empty array of lane ids/],
    [{ lanes: [] }, /non-empty array of lane ids/],
    [{ lanes: 'zai' }, /non-empty array of lane ids/],
    [{ lanes: [1, 2] }, /every entry in lanes must be a string/],
    [{ lanes: ['no-such-lane'] }, /no such lane/],
    [{ lanes: ['zai', 'no-such-lane'] }, /no such lane/],
  ]
  for (const [args, expected] of cases) {
    const { reply, payload } = await callProbe(args, {}, transport)
    assert.equal(reply.result.isError, true, `${JSON.stringify(args)} was not reported as refused`)
    assert.match(payload.error, expected, `${JSON.stringify(args)} produced: ${payload.error}`)
    assert.ok(payload.known.includes('zai'), 'a refusal that does not say what does exist is half an answer')
  }
  assert.equal(spy.length, 0,
    'a call this server should have refused reached the transport — the anti-sweep guard is not structural')
})

test('a repeated lane id is probed once, not once per repetition', async () => {
  let calls = 0
  const transport = async () => { calls += 1; return { settled: 'response' } }
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  const { payload } = await callProbe({ lanes: ['claude', 'claude', 'claude'] }, bare, transport)
  assert.equal(payload.lanes.length, 1, 'a deduped id must appear once in the answer, not three times')
  assert.equal(calls, 1, 'the same lane id was probed more than once for one call')
})

test('a lane that is already invalid is reported from that diagnosis, and never contacted', async () => {
  const transport = async () => { throw new Error('an already-invalid lane must never be contacted') }
  const { payload } = await callProbe({ lanes: ['zai'] },
    { HOME: '/nonexistent-layout', PATH: '/definitely/nonexistent' }, transport)
  const [lane] = payload.lanes
  assert.equal(lane.probe, 'not_attempted')
  assert.equal(lane.configuration, 'invalid')
  assert.equal(lane.problem.code, 'endpoint_missing', 'reused the wrong config-time diagnostic')
  assert.equal(lane.problem.detail, DIAGNOSTICS.endpoint_missing)
})

test('an UNCHECKED lane is genuinely contacted — a live probe is the only signal that exists for it', async () => {
  const spy = []
  const transport = async (call) => { spy.push(call); return { settled: 'response' } }
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  const { payload } = await callProbe({ lanes: ['claude'] }, bare, transport)
  assert.equal(spy.length, 1, 'the one lane with no parent-side check was never actually contacted')
  assert.equal(spy[0].id, 'claude')
  assert.ok(Array.isArray(spy[0].command) && spy[0].command.length, 'the transport got no command to spawn')
  assert.ok(spy[0].env && typeof spy[0].env === 'object', 'the transport got no environment to spawn with')
  assert.equal(spy[0].timeoutMs, PROBE_TIMEOUT_MS, 'the bounded timeout did not reach the transport')
  const [lane] = payload.lanes
  assert.equal(lane.probe, 'reachable')
  assert.equal(lane.configuration, 'unchecked')
  assert.equal(lane.problem, null)
  assert.ok(Array.isArray(lane.notProven) && lane.notProven.length >= 4,
    'a live reachable answer with no stated boundary is the same overclaim ready:true was')
})

test('every unreachable outcome the transport can report lands on a classified code, and nothing extra rides along', async () => {
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  const outcomes = [
    [{ settled: 'timeout' }, 'probe_timeout'],
    [{ settled: 'spawn_error', errnoCode: 'ENOENT', rawStderr: 'CANARY-SHOULD-NEVER-SURFACE' }, 'executable_missing'],
    [{ settled: 'exit', code: 1, quotaSignal: true, rawText: 'CANARY-QUOTA-TEXT' }, 'quota_exhausted'],
    [{ settled: 'exit', code: 1, quotaSignal: false }, 'unclassified'],
    [{ settled: 'a kind this file has never seen' }, 'unclassified'],
  ]
  for (const [outcome, code] of outcomes) {
    const { payload } = await callProbe({ lanes: ['claude'] }, bare, async () => outcome)
    const [lane] = payload.lanes
    assert.equal(lane.probe, 'unreachable', JSON.stringify(outcome))
    assert.equal(lane.problem.code, code, JSON.stringify(outcome))
    assert.equal(lane.problem.detail, DIAGNOSTICS[code], 'the detail is not the constant sentence for its own code')
    const wire = JSON.stringify(payload)
    assert.ok(!wire.includes('CANARY'),
      `a field the transport contract does not declare still reached the wire: ${wire}`)
  }
})

test('a credential inside an unreadable settings file still never reaches a probe reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-probe-secret-'))
  try {
    const settings = join(dir, 'zai.json')
    // A synthetic marker, not a credential-shaped literal: this repository's
    // own pre-commit secret scanner reads `const secret = '...'` as the thing
    // it exists to stop, and it is right to — build the value instead of
    // writing it as one string.
    const marker = 'PROBE-MARKER-NEVER-ON-THE-WIRE-' + 'q'.repeat(20)
    writeFileSync(settings, `{ "token": "${marker}", this is not valid json`)
    const transport = async () => { throw new Error('an invalid lane must never be contacted') }
    const { payload } = await callProbe({ lanes: ['zai'] },
      { HOME: '/nonexistent-layout', PATH: '/definitely/nonexistent', TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings },
      transport)
    assert.equal(payload.lanes[0].probe, 'not_attempted')
    assert.equal(payload.lanes[0].problem.code, 'settings_unreadable')
    assert.ok(!JSON.stringify(payload).includes(marker),
      'a credential sitting inside an unreadable settings file reached a probe reply')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live credential reaches the transport to spawn with, and never reaches the reply back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lanes-probe-live-secret-'))
  try {
    const settings = join(dir, 'zai.json')
    const marker = 'LIVE-PROBE-MARKER-' + '9f3a'.repeat(5)
    writeFileSync(settings, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: marker },
    }))
    const env = { HOME: dir, PATH: process.env.PATH, TMUX_TEAMS_REVIEW_ZAI_SETTINGS: settings }
    let sawMarkerInLaunchEnv = false
    const transport = async (call) => {
      sawMarkerInLaunchEnv = Object.values(call.env ?? {}).includes(marker)
      return { settled: 'exit', code: 1, quotaSignal: true }
    }
    const { payload } = await callProbe({ lanes: ['zai'] }, env, transport)
    assert.ok(sawMarkerInLaunchEnv,
      'the transport never received the credential it would need to actually probe with — the test proves nothing')
    assert.equal(payload.lanes[0].probe, 'unreachable')
    assert.equal(payload.lanes[0].problem.code, 'quota_exhausted')
    assert.ok(!JSON.stringify(payload).includes(marker),
      'a credential that reached the transport also reached the reply')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lanes are probed sequentially, never concurrently — a live probe spends real quota per lane', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const order = []
  const transport = async (call) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    order.push(`start:${call.id}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push(`end:${call.id}`)
    inFlight -= 1
    return { settled: 'response' }
  }
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  const { payload } = await callProbe({ lanes: ['claude', 'codex'] }, bare, transport)
  assert.equal(maxInFlight, 1,
    'two lanes were in flight at once — that is Promise.all, and this tool must never spend two budgets for one call')
  assert.deepEqual(order, ['start:claude', 'end:claude', 'start:codex', 'end:codex'])
  assert.equal(payload.lanes.length, 2)
})

test('a transport that REJECTS is classified per lane, never leaks its message, and never scraps the batch', async () => {
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  const transport = async (call) => {
    if (call.id === 'claude') throw new Error('PROVIDER-REJECT-MARKER: 401 invalid token for account 9f3a')
    return { settled: 'response' }
  }
  const { reply, payload } = await callProbe({ lanes: ['claude', 'codex'] }, bare, transport)
  // The whole tool call still answers — one lane's transport throwing must not
  // reject `handle`'s own promise and take the reply down with it.
  assert.equal(reply.result.isError, false, 'a per-lane failure is not a tool-call-level error')
  assert.equal(payload.lanes.length, 2, 'the lane probed AFTER the rejecting one was dropped from the batch')
  const [claude, codex] = payload.lanes
  assert.equal(claude.lane, 'claude')
  assert.equal(claude.probe, 'unreachable')
  assert.equal(claude.problem.code, 'unclassified',
    'a rejecting transport has to land in the same honest bucket a malformed signal does')
  assert.equal(codex.lane, 'codex')
  assert.equal(codex.probe, 'reachable', 'the lane probed after the rejecting one must still be attempted')
  const wire = JSON.stringify(payload)
  assert.ok(!wire.includes('PROVIDER-REJECT-MARKER') && !wire.includes('401') && !wire.includes('9f3a'),
    `the rejecting transport's own message reached the wire: ${wire}`)
})

// `realProbeTransport` was the one piece of the probe nothing ran: every other
// test injects a fake through `deps.probeTransport`, which exercises the
// CLASSIFIER and says nothing about the code that spawns an adapter, writes
// JSON-RPC frames and reads them back. The quota pattern is the sharpest case —
// if it misses a provider's real wording, an exhausted lane reports
// `unclassified`, and no fake transport can ever tell you that.
//
// A stub ACP agent costs nothing and contacts nobody.
test('the real probe transport speaks to an agent and reads what comes back', async () => {
  const stub = join(ROOT, 'tests', 'fixtures', 'probe-stub-agent.mjs')
  const run = (mode, timeoutMs = 8000) => realProbeTransport({
    command: [process.execPath, stub],
    env: { ...process.env, STUB_MODE: mode },
    timeoutMs,
  })

  assert.deepEqual(await run('ok'), { settled: 'response' },
    'a stub that answers all three methods was not read as reachable')

  // An exhausted lane answers the handshake and refuses the PROMPT — that is
  // the shape, not a 429 arriving out of nowhere.
  //
  // And the split is the point: the TRANSPORT reports a fact it observed
  // (`exit`, plus a boolean it decided from the stream) and the CLASSIFIER
  // turns that into the code an operator reads. Asserting both halves in one
  // place is what proves they meet — a fake transport can satisfy the
  // classifier forever while the real one never produces the shape it wants.
  const quota = await run('quota')
  assert.equal(quota.settled, 'exit', `an exhausted lane settled as ${quota.settled}`)
  assert.equal(quota.quotaSignal, true, 'the transport did not notice the 429 on stderr')
  assert.equal(classifyProbe(quota), 'quota_exhausted',
    'the classifier did not turn a real exhausted lane into its own code')

  // And the other direction, which is the one a keyword match gets wrong:
  // quota-shaped words on stderr from a lane that ANSWERED are not a refusal.
  // A lane that answered is reachable, whatever it printed on the way.
  assert.deepEqual(await run('noisy'), { settled: 'response' },
    'a lane that answered was called exhausted because of a warning it printed')

  // A stub that never answers must TIME OUT rather than hang the caller, and
  // the timeout has to be the transport's own — a test that waits for the
  // production default measures the default, not the transport.
  const started = Date.now()
  const silent = await run('silent', 1200)
  assert.equal(silent.settled, 'timeout', `a silent agent settled as ${silent.settled}`)
  assert.ok(Date.now() - started < 6000,
    'the transport ignored the timeout it was given')

  // A command that does not exist is a spawn error carrying an errno CODE and
  // never a message — this is the path that reaches an operator.
  const missing = await realProbeTransport({
    command: [join(ROOT, 'tests', 'fixtures', 'no-such-binary-here'), '--x'],
    env: { ...process.env }, timeoutMs: 4000,
  })
  assert.equal(missing.settled, 'spawn_error')
  assert.equal(missing.errnoCode, 'ENOENT', `spawn failure reported ${missing.errnoCode}`)
  assert.equal(missing.message, undefined, 'the transport leaked a message onto its result')
})

// ## Eight findings against the live probe, each reproduced for real
//
// A unit test of a helper proves nothing about a STREAM. Every test below that
// claims to guard an async 'error' event spawns a real, separate OS process —
// the real server for the output.write() case, a harness subprocess for the
// child.stdin case — so an unguarded crash kills only that child, never this
// test run, and the assertion is "did the child survive", not "was a guard
// function called".

test('serve() survives output.write() EPIPE — a host that disconnects mid-call does not take the whole server down', async () => {
  const script = join(PLUGIN, 'skills', 'party-mode', 'scripts', 'acp-lanes-mcp.mjs')
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    let out = ''
    let stderr = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
    const upDeadline = Date.now() + 5000
    while (Date.now() < upDeadline && out.split('\n').filter(Boolean).length < 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(out.split('\n').filter(Boolean).length, 1,
      'the server never answered an ordinary request before the pipe was broken')
    // NOW break the pipe — the moral equivalent of piping the server through
    // `head -c 10`, which is exactly how the finding measured this. Several
    // writes follow so at least one lands after the close actually takes.
    child.stdout.destroy()
    for (let i = 0; i < 5; i += 1) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'ping' })}\n`)
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(child.exitCode, null, `the server crashed on a write to a closed pipe: ${stderr}`)
    assert.equal(child.signalCode, null, `the server was killed rather than surviving: ${stderr}`)
    assert.ok(!/Unhandled ['"]error['"] event|write EPIPE/.test(stderr),
      `an unhandled stream error reached the process: ${stderr}`)
  } finally {
    child.kill('SIGKILL')
  }
})

test('realProbeTransport survives child.stdin.write() EPIPE — a child that closes stdin while staying alive does not crash the caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-stdin-epipe-'))
  try {
    const targetUrl = pathToFileURL(
      join(PLUGIN, 'skills', 'party-mode', 'scripts', 'acp-lanes-mcp.mjs')).href
    const stub = join(dir, 'close-after-initialize.cjs')
    // Answers `initialize`, THEN closes its own fd 0 and stays alive. The
    // close happens causally AFTER the parent's first write already landed —
    // it rides on the reply the parent must first receive and act on — so the
    // parent's NEXT write (session/new) is guaranteed to hit a closed pipe,
    // rather than racing an unconditional close against process startup.
    writeFileSync(stub, [
      "const fs = require('fs')",
      "const readline = require('readline')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  let message',
      '  try { message = JSON.parse(line) } catch { return }',
      "  if (message.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,",
      "      result: { protocolVersion: 1 } }) + '\\n')",
      '    fs.closeSync(0)',
      '  }',
      '})',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const harness = join(dir, 'harness.mjs')
    // Runs realProbeTransport in ITS OWN process: if the fix is missing, the
    // unhandled 'error' event crashes THIS harness, not the test runner —
    // exactly the isolation an in-process call could not give us.
    writeFileSync(harness, [
      `import { realProbeTransport } from ${JSON.stringify(targetUrl)}`,
      'const result = await realProbeTransport({',
      `  command: [process.execPath, ${JSON.stringify(stub)}],`,
      '  env: process.env,',
      '  timeoutMs: 1500,',
      '})',
      "process.stdout.write('RESULT:' + JSON.stringify(result) + '\\n')",
    ].join('\n'))
    const out = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 8000 })
    assert.equal(out.status, 0,
      `the harness crashed instead of the promise settling: ${out.stderr}`)
    assert.ok(!/Unhandled ['"]error['"] event|write EPIPE/.test(out.stderr ?? ''),
      `an unhandled EPIPE reached the process: ${out.stderr}`)
    const line = (out.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'))
    assert.ok(line, `realProbeTransport never settled — stdout=${out.stdout} stderr=${out.stderr}`)
    const result = JSON.parse(line.slice('RESULT:'.length))
    assert.equal(result.settled, 'timeout',
      'a child that answered once and then closed its stdin should time out, not crash first')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a quota signal split across two stderr chunks is still detected, not defeated by chunk boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-quota-split-'))
  try {
    const script = join(dir, 'split-quota.cjs')
    // Two ordinary, separate writes with a real gap between them — the shape
    // the finding measured splitting across 'data' events at a high rate.
    // Neither half alone ('resource_' / 'exhausted') matches QUOTA_SIGNAL.
    writeFileSync(script, [
      "process.stderr.write('resource_')",
      "setTimeout(() => { process.stderr.write('exhausted'); process.exit(1) }, 50)",
    ].join('\n'))
    const result = await realProbeTransport({
      command: [process.execPath, script], env: process.env, timeoutMs: 4000,
    })
    assert.equal(result.settled, 'exit')
    assert.equal(result.quotaSignal, true,
      'a quota signal split across two writes was missed by testing each chunk in isolation')
    assert.equal(classifyProbe(result), 'quota_exhausted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a JSON-RPC error on session/prompt while quota is already signalled settles immediately, not after the full probe timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-refused-quota-'))
  try {
    const script = join(dir, 'refuse-and-stay-alive.cjs')
    // Answers the handshake, prints a quota-shaped line, then answers
    // session/prompt with a JSON-RPC ERROR and never exits — an adapter
    // idling for more input, not one that died mid-turn.
    writeFileSync(script, [
      "const readline = require('readline')",
      "process.stderr.write('429 rate limited, please retry later\\n')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  let message',
      '  try { message = JSON.parse(line) } catch { return }',
      '  const reply = (result) => process.stdout.write(',
      "    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
      "  if (message.method === 'initialize') reply({ protocolVersion: 1 })",
      "  else if (message.method === 'session/new') reply({ sessionId: 'stub' })",
      "  else if (message.method === 'session/prompt') {",
      '    process.stdout.write(JSON.stringify({',
      "      jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'refused' } }) + '\\n')",
      '  }',
      '})',
    ].join('\n'))
    const started = Date.now()
    const result = await realProbeTransport({
      command: [process.execPath, script], env: process.env, timeoutMs: 6000,
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000,
      `settling an already-signalled refusal took ${elapsed}ms — it must not wait for the full timeout`)
    assert.equal(result.settled, 'refused')
    assert.equal(result.quotaSignal, true)
    assert.equal(classifyProbe(result), 'quota_exhausted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finish() does not settle until a killed child has actually exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-finish-waits-'))
  const pidFile = join(dir, 'pid')
  try {
    const script = join(dir, 'ignore-term.cjs')
    // Ignores SIGTERM on purpose, forcing the kill ladder all the way to
    // SIGKILL — a `finish()` that settles as soon as it SENDS a signal, rather
    // than once the child's own 'exit' event confirms it, resolves while this
    // process is still alive.
    writeFileSync(script, [
      "const fs = require('fs')",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const result = await realProbeTransport({
      command: [process.execPath, script], env: process.env, timeoutMs: 300,
    })
    assert.equal(result.settled, 'timeout')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    assert.equal(alive, false,
      'realProbeTransport resolved while the killed child was still alive — probeLanes\' next lane could start spawning over it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session/prompt that completes with stopReason cancelled is not reported reachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-cancelled-'))
  try {
    const script = join(dir, 'cancelled-turn.cjs')
    writeFileSync(script, [
      "const readline = require('readline')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  let message',
      '  try { message = JSON.parse(line) } catch { return }',
      '  const reply = (result) => process.stdout.write(',
      "    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
      "  if (message.method === 'initialize') reply({ protocolVersion: 1 })",
      "  else if (message.method === 'session/new') reply({ sessionId: 'stub' })",
      "  else if (message.method === 'session/prompt') reply({ stopReason: 'cancelled' })",
      '})',
    ].join('\n'))
    const result = await realProbeTransport({
      command: [process.execPath, script], env: process.env, timeoutMs: 4000,
    })
    assert.equal(result.settled, 'cancelled',
      'a completed round trip carrying stopReason cancelled was reported the same as a real answer')
    assert.notEqual(classifyProbe(result), null, 'a cancelled turn was classified reachable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a spawn failure from a non-executable file is EACCES, told apart from ENOENT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-eacces-'))
  try {
    const notExecutable = join(dir, 'not-executable')
    writeFileSync(notExecutable, '#!/bin/sh\necho hi\n')
    chmodSync(notExecutable, 0o644) // exists, but no execute bit for anybody
    const result = await realProbeTransport({
      command: [notExecutable], env: process.env, timeoutMs: 4000,
    })
    assert.equal(result.settled, 'spawn_error')
    assert.equal(result.errnoCode, 'EACCES', `spawn failure reported ${result.errnoCode}`)
    assert.equal(classifyProbe(result), 'executable_unusable',
      'a permission problem was classified the same as a missing file')
    assert.notEqual(classifyProbe(result), 'executable_missing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an EACCES spawn failure reaches the operator with its own sentence and its own fixes, not the missing-file one', async () => {
  const bare = { HOME: '/definitely/nonexistent', PATH: '/definitely/nonexistent' }
  const transport = async () => ({ settled: 'spawn_error', errnoCode: 'EACCES' })
  const { payload } = await callProbe({ lanes: ['claude'] }, bare, transport)
  const [lane] = payload.lanes
  assert.equal(lane.problem.code, 'executable_unusable')
  assert.equal(lane.problem.detail, DIAGNOSTICS.executable_unusable)
  assert.notEqual(lane.problem.detail, DIAGNOSTICS.executable_missing,
    'an EACCES failure was told with the "not found" sentence, which is false for a file that exists')
  assert.ok(lane.fixes.length > 0, 'an EACCES failure produced no fix at all')
})

test('a session/new success with no sessionId settles immediately as an invalid handshake, not after the full probe timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-probe-no-sessionid-'))
  try {
    const script = join(dir, 'no-session-id.cjs')
    writeFileSync(script, [
      "const readline = require('readline')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  let message',
      '  try { message = JSON.parse(line) } catch { return }',
      '  const reply = (result) => process.stdout.write(',
      "    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
      "  if (message.method === 'initialize') reply({ protocolVersion: 1 })",
      "  else if (message.method === 'session/new') reply({})",
      '  // Never answers session/prompt, never exits.',
      '})',
    ].join('\n'))
    const started = Date.now()
    const result = await realProbeTransport({
      command: [process.execPath, script], env: process.env, timeoutMs: 6000,
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000,
      `settling an invalid handshake took ${elapsed}ms — it must not wait for the full probe timeout`)
    assert.equal(result.settled, 'invalid_handshake')
    assert.equal(classifyProbe(result), 'unclassified')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
