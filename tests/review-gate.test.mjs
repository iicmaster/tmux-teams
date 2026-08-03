import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcpReview, prepareReviewPacket, ReviewTransportError } from '../plugins/tmux-teams/skills/party-mode/scripts/acp-review-client.mjs'
import { runReviewGate, runReviewGateCli, LANE_TIMEOUT_DEFAULT_MS, laneTimeoutMs,
} from '../plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK = join(HERE, 'fixtures', 'mock-review-acp-agent.mjs')
const packet = () => ({
  primary: 'openai',
  objective: 'review static artifacts',
  secretToken: 'never-forward',
  note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
  artifact: { title: 'x' },
})
const validReview = {
  schema_version: 1,
  verdict: 'PASS',
  assessment: 'The supplied static evidence satisfies the stated criteria.',
  findings: [],
  residual_risks: [],
}
const profile = (id = 'oc', extra = {}) => ({
  id,
  lane: id,
  provider: id,
  family: id === 'agy' ? 'gemini' : id,
  command: process.execPath,
  args: [MOCK],
  model: `${id}-review-model`,
  reviewMode: 'plan',
  config: { model: `${id}-review-model`, mode: 'plan' },
  ...extra,
})
const invoke = (p = profile(), extra = {}) => runAcpReview({
  profile: p,
  lane: p.lane,
  packet: packet(),
  timeoutMs: 3_000,
  env: { MOCK_REVIEW_BEHAVIOUR: 'ok', MOCK_REVIEW_MODEL: p.model, ...extra },
})
const runnerResult = (p, staticPacket, review = validReview) => ({
  profile: p.id,
  provider: p.provider,
  model: p.model,
  displayModel: p.displayModel ?? `${p.provider}/${p.model}`,
  mode: 'plan',
  acknowledgements: Object.fromEntries(Object.entries(p.config ?? {}).map(([id, value]) => [
    id,
    { value, source: 'session_config' },
  ])),
  isolation: {
    workspace: 'temporary',
    targetRepositoryCwd: false,
    targetRepositoryHidden: p.osSandbox === 'bwrap',
    targetRepositoryCanonical: p.osSandbox === 'bwrap' ? '/tmp/test-target' : undefined,
    hostRootBaseReadOnly: p.osSandbox === 'bwrap',
    hostDataRootsMasked: p.osSandbox === 'bwrap',
    hostProcessNamespaceIsolated: p.osSandbox === 'bwrap',
    mcpServers: 0,
    builtInToolsRequested: false,
    toolCallsObserved: 0,
    reasoningUpdatesObserved: 0,
    safeRuntimeReadsObserved: 0,
    safeWorkspaceReadsObserved: 0,
    temporaryModelSettings: Boolean(p.sessionSettings),
    hostProviderHomeVisible: p.osSandbox !== 'bwrap',
    ephemeralProviderStateWritable: p.osSandbox === 'bwrap',
    hostProviderStatePersistent: p.osSandbox !== 'bwrap',
    providerMayPersistRemoteState: true,
    networkSharedWithHost: p.osSandbox === 'bwrap',
    acpPermissionRequests: 'deny',
  },
  review,
  inputHash: prepareReviewPacket(staticPacket).inputHash,
  provenance: `review-runner:test-${p.id}`,
  packetBytes: 100,
})
const keyedProfiles = entries => Object.fromEntries(entries.map(entry => [entry.id, entry]))
const gateProfile = (id, family) => profile(id, {
  command: [process.execPath, MOCK],
  args: undefined,
  provider: `${id}-provider`,
  family,
  displayModel: `${id}/${id}-review-model`,
})
const testPlan = (reviewers, reserve = null) => ({
  blocked: false,
  reviewers,
  reserve,
  primaryFamily: 'test',
})

test('isolated ACP runner returns strict JSON with runner provenance and redacts packet secrets', async () => {
  const targetRepo = mkdtempSync(join(tmpdir(), 'review-target-'))
  const marker = join(targetRepo, 'marker.txt')
  writeFileSync(marker, 'unchanged')
  const out = await invoke()
  assert.equal(out.review.verdict, 'PASS')
  assert.match(out.inputHash, /^[a-f0-9]{64}$/)
  assert.match(out.provenance, /^review-runner:/)
  assert.equal(out.review.leaked, null)
  assert.equal(out.review.sawRawSecret, false)
  assert.equal(out.review.sawBearerSecret, false)
  assert.equal(out.review.toolsDisabled, true)
  assert.deepEqual(out.acknowledgements.model, { value: 'oc-review-model', source: 'session_config' })
  assert.deepEqual(out.acknowledgements.mode, { value: 'plan', source: 'session_config' })
  assert.equal(out.isolation.builtInToolsRequested, false)
  assert.equal(out.isolation.toolCallsObserved, 0)
  assert.notEqual(out.review.cwd, process.cwd(), 'agent receives a neutral temp cwd, never the target repo')
  assert.equal(existsSync(out.review.cwd), false, 'neutral cwd is removed after the turn')
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged', 'review transport does not mutate a target repository')
})

test('bubblewrap hides the runner-owned canonical target even when the packet names a decoy', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'),
}, async () => {
  const targetRepo = mkdtempSync(join(tmpdir(), 'review-target-'))
  const marker = join(targetRepo, 'marker.txt')
  writeFileSync(marker, 'host-secret-marker')
  const sandboxed = profile('sandboxed', {
    args: ['--input-type=module', '-e', readFileSync(MOCK, 'utf8')],
    osSandbox: 'bwrap',
  })
  const out = await runAcpReview({
    profile: sandboxed,
    lane: sandboxed.lane,
    packet: { ...packet(), target_repo: '/tmp/decoy-controlled-by-packet' },
    targetRepository: targetRepo,
    timeoutMs: 3_000,
    env: {
      MOCK_REVIEW_BEHAVIOUR: 'sandbox-probe',
      MOCK_REVIEW_MODEL: sandboxed.model,
      MOCK_TARGET_MARKER: marker,
    },
  })
  assert.equal(out.review.targetMarkerVisible, false)
  assert.equal(out.review.targetWriteSucceeded, false)
  assert.equal(out.isolation.targetRepositoryHidden, true)
  assert.equal(out.isolation.hostRootBaseReadOnly, true)
  assert.equal(out.isolation.hostDataRootsMasked, true)
  assert.equal(out.isolation.hostProcessNamespaceIsolated, true)
  assert.equal(out.isolation.targetRepositoryCanonical, targetRepo)
  assert.equal(readFileSync(marker, 'utf8'), 'host-secret-marker')
})

test('oversize static packets are blocked before any ACP agent can be launched', () => {
  assert.throws(() => prepareReviewPacket({ artifact: 'x'.repeat(256) }, { maxBytes: 32 }), e => e.code === 'input')
})

test('malformed assessment coverage is rejected before an ACP process starts', async () => {
  let spawned = false
  await assert.rejects(runAcpReview({
    profile: profile('oc'),
    lane: 'oc',
    packet: {
      ...packet(),
      acceptance_criteria: [{ id: 'AC-ONE', text: 'first' }],
      review_gate: {
        assessment_coverage: {
          schema: 'tmux-teams.review-assessment-coverage.v1',
          required_for_each_accepted_review: true,
          ordered_criterion_ids: ['AC-TWO'],
          exact_line_count: 1,
          min_analysis_chars: 20,
          max_analysis_chars: 240,
        },
      },
    },
    timeoutMs: null,
    spawn: () => {
      spawned = true
      throw new Error('must not spawn')
    },
  }), error => error.code === 'input')
  assert.equal(spawned, false)
  await assert.rejects(runAcpReview({
    profile: profile('oc'),
    lane: 'oc',
    packet: {
      ...packet(),
      review_gate: {
        review_scope: {
          schema: 'tmux-teams.pre-dispatch-plan-review.v1',
          stage: 'after_worker_dispatch',
        },
      },
    },
    timeoutMs: null,
    spawn: () => {
      spawned = true
      throw new Error('must not spawn')
    },
  }), error => error.code === 'input')
  assert.equal(spawned, false)
})

test('plain assignments, headers, and query credentials are redacted without crossing lines', () => {
  const prepared = prepareReviewPacket({
    diff: [
      'context before',
      '+ DB_PASSWORD=hunter2',
      '+ SERVICE_TOKEN = "plain-token-value"',
      '+ Authorization: Basic dXNlcjpwYXNz',
      '+ X-API-Key: plainsecretvalue',
      '+ DATABASE_URL=postgresql://app:databasepass@db/prod',
      '+ REDIS_URL=redis://default:redispass@cache/0',
      '+ NPM_AUTH=dXNlcjpwYXNz',
      '+ endpoint=https://example.test/path?mode=review&access_token=querysecret&keep=yes',
      '+ author=ordinary-context',
      'context after',
    ].join('\n'),
  })
  assert.doesNotMatch(prepared.json, /hunter2|plain-token-value|dXNlcjpwYXNz|plainsecretvalue|databasepass|redispass|querysecret/)
  assert.match(prepared.packet.diff, /DB_PASSWORD=\[REDACTED\]/)
  assert.match(prepared.packet.diff, /Authorization: \[REDACTED\]/)
  assert.match(prepared.packet.diff, /DATABASE_URL=\[REDACTED\]db\/prod/)
  assert.match(prepared.packet.diff, /NPM_AUTH=\[REDACTED\]/)
  assert.match(prepared.packet.diff, /access_token=\[REDACTED\]&keep=yes/)
  assert.match(prepared.packet.diff, /author=ordinary-context/)
  assert.match(prepared.packet.diff, /context after/)
})

test('permission requests are always denied and a missing model acknowledgement fails closed', async () => {
  const permitted = await invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'permission' })
  assert.equal(permitted.review.verdict, 'PASS')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'ack-mismatch' }), e => e instanceof ReviewTransportError && e.code === 'config')
})

test('malformed JSON-RPC, malformed review, and timeout never become accepted reviews', async () => {
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'malformed' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'bad-review' }), e => e.code === 'review')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'escaped-secret-review' }), e => e.code === 'review')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'plain-secret-review' }), e => e.code === 'review')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'url-secret-review' }), e => e.code === 'review')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'response-then-invalid' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'response-then-exit-7' }), e => e.code === 'closed')
  await assert.rejects(runAcpReview({ profile: profile('oc'), lane: 'oc', packet: packet(), timeoutMs: 25, env: { MOCK_REVIEW_BEHAVIOUR: 'late' } }), e => e.code === 'timeout' && /lane silent for/.test(e.message))
})

test('lane timeout is an inactivity lease: chatty lanes survive, silent lanes are killed as silent', async () => {
  // (a) The chatty lane drips ~45 chunks at 30ms intervals — roughly 1.4s of
  // wall clock, comfortably past the 1000ms lease — yet every chunk arrives
  // far inside the lease, so a busy lane must never be killed. The margins
  // survive heavy parallel test load where child timers stretch.
  const out = await runAcpReview({
    profile: profile('oc'),
    lane: 'oc',
    packet: packet(),
    timeoutMs: 1_000,
    env: { MOCK_REVIEW_BEHAVIOUR: 'chatty', MOCK_REVIEW_MODEL: 'oc-review-model' },
  })
  assert.equal(out.review.verdict, 'PASS')
  // (b) A lane that goes silent past the lease is cancelled, and the failure
  // is reported as silence rather than an absolute elapsed-time timeout.
  await assert.rejects(
    runAcpReview({ profile: profile('oc'), lane: 'oc', packet: packet(), timeoutMs: 100, env: { MOCK_REVIEW_BEHAVIOUR: 'hang' } }),
    e => e.code === 'timeout' && /lane silent for/.test(e.message),
  )
})

test('null timeout disables the inactivity lease and emits correlated ACP progress', async () => {
  const progress = []
  const out = await runAcpReview({
    profile: profile('oc'),
    lane: 'oc',
    packet: packet(),
    timeoutMs: null,
    env: {
      MOCK_REVIEW_BEHAVIOUR: 'late',
      MOCK_REVIEW_MODEL: 'oc-review-model',
    },
    onProgress: event => progress.push(event),
  })
  assert.equal(out.review.verdict, 'PASS')
  assert.equal(out.isolation.stdoutBytesLimit, 2 * 1024 * 1024)
  assert.equal(out.isolation.messageBytesLimit, 64 * 1024)
  assert.ok(out.isolation.stdoutBytesObserved > 0)
  assert.ok(
    out.isolation.stdoutBytesObserved <= out.isolation.stdoutBytesLimit,
  )
  assert.ok(
    out.isolation.messageBytesObserved <= out.isolation.messageBytesLimit,
  )
  assert.equal(
    progress.some(event =>
      event.kind === 'response' && event.method === 'session/prompt'),
    true,
  )
  assert.equal(
    progress.some(event =>
      event.kind === 'notification' && event.method === 'session/update'),
    true,
  )
  assert.equal(
    progress.every(event =>
      typeof event.at === 'string' &&
      ['process', 'request', 'response', 'notification'].includes(event.kind)),
    true,
  )
})

test('SIGTERM is accepted only after an acknowledged terminal response', {
  skip: process.platform === 'win32',
}, async () => {
  const out = await invoke(
    profile('oc'),
    { MOCK_REVIEW_BEHAVIOUR: 'response-then-sigterm' },
  )
  assert.equal(out.review.verdict, 'PASS')
})

test('replayed and wrong-session chunks are rejected rather than mixed into a review', async () => {
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'replay' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'wrong-session' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'tool-call' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'pre-prompt-tool-call' }), e => e.code === 'protocol')
})

test('only the exact AGY non-side-effect think update is ignored', async () => {
  const agy = profile('agy')
  const out = await invoke(agy, { MOCK_REVIEW_BEHAVIOUR: 'think-update' })
  assert.equal(out.review.verdict, 'PASS')
  assert.equal(out.isolation.toolCallsObserved, 0)
  assert.equal(out.isolation.reasoningUpdatesObserved, 1)
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'think-update' }), e => e.code === 'protocol')
})

test('AGY may read only copied provider runtime docs, never the target or arbitrary paths', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'),
}, async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'review-agy-home-'))
  const guide = join(fakeHome, '.gemini', 'antigravity-cli', 'builtin', 'guide.md')
  mkdirSync(dirname(guide), { recursive: true })
  writeFileSync(guide, 'provider runtime documentation')
  const targetRepo = mkdtempSync(join(tmpdir(), 'review-agy-target-'))
  const targetFile = join(targetRepo, 'private.txt')
  writeFileSync(targetFile, 'target data')
  const agy = profile('agy', {
    args: ['--input-type=module', '-e', readFileSync(MOCK, 'utf8')],
    osSandbox: 'bwrap',
  })
  const common = {
    profile: agy,
    lane: agy.lane,
    packet: packet(),
    targetRepository: targetRepo,
    timeoutMs: 3_000,
  }
  const out = await runAcpReview({
    ...common,
    env: {
      HOME: fakeHome,
      PATH: process.env.PATH,
      MOCK_REVIEW_BEHAVIOUR: 'safe-runtime-read',
      MOCK_REVIEW_MODEL: agy.model,
      MOCK_SAFE_RUNTIME_PATH: guide,
    },
  })
  assert.equal(out.review.verdict, 'PASS')
  assert.equal(out.isolation.safeRuntimeReadsObserved, 1)
  assert.equal(out.isolation.safeWorkspaceReadsObserved, 0)
  assert.equal(out.isolation.toolCallsObserved, 0)
  await assert.rejects(runAcpReview({
    ...common,
    env: {
      HOME: fakeHome,
      PATH: process.env.PATH,
      MOCK_REVIEW_BEHAVIOUR: 'safe-runtime-read',
      MOCK_REVIEW_MODEL: agy.model,
      MOCK_SAFE_RUNTIME_PATH: targetFile,
    },
  }), e => e.code === 'protocol')
})

test('AGY safe reads require lexical and canonical scope; parents, aliases, escapes, and mixed scopes fail', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'),
}, async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'review-agy-workspace-home-'))
  const guide = join(fakeHome, '.gemini', 'antigravity-cli', 'builtin', 'guide.md')
  mkdirSync(dirname(guide), { recursive: true })
  writeFileSync(guide, 'provider runtime documentation')
  const runtimeAlias = join(fakeHome, '.gemini', 'antigravity-cli', 'runtime-guide-alias')
  symlinkSync(guide, runtimeAlias)
  const targetRepo = mkdtempSync(join(tmpdir(), 'review-agy-workspace-target-'))
  const agy = profile('agy', {
    args: ['--input-type=module', '-e', readFileSync(MOCK, 'utf8')],
    osSandbox: 'bwrap',
  })
  const common = {
    profile: agy,
    lane: agy.lane,
    packet: packet(),
    targetRepository: targetRepo,
    timeoutMs: 3_000,
  }
  const testEnv = extra => ({
    HOME: fakeHome,
    PATH: process.env.PATH,
    MOCK_REVIEW_BEHAVIOUR: 'safe-workspace-read',
    MOCK_REVIEW_MODEL: agy.model,
    ...extra,
  })
  const out = await runAcpReview({
    ...common,
    env: testEnv(),
  })
  assert.equal(out.review.verdict, 'PASS')
  assert.deepEqual(out.review.workspaceEntries, ['REVIEW_STATIC_PACKET_ONLY.md'])
  assert.equal(out.isolation.safeRuntimeReadsObserved, 0)
  assert.equal(out.isolation.safeWorkspaceReadsObserved, 1)
  assert.equal(out.isolation.toolCallsObserved, 0)
  const guideOut = await runAcpReview({
    ...common,
    env: {
      ...testEnv(),
      MOCK_REVIEW_BEHAVIOUR: 'safe-workspace-sentinel-read',
    },
  })
  assert.equal(guideOut.review.verdict, 'PASS')
  assert.equal(guideOut.isolation.safeWorkspaceReadsObserved, 1)
  for (const variant of [
    'relative-escape', 'child', 'symlink', 'symlink-parent', 'symlink-root',
    'symlink-guide', 'runtime-inward', 'parent-location', 'nested',
  ]) {
    await assert.rejects(runAcpReview({
      ...common,
      env: testEnv({
        MOCK_SAFE_WORKSPACE_VARIANT: variant,
        MOCK_SAFE_RUNTIME_ALIAS: runtimeAlias,
      }),
    }), error => error.code === 'protocol', `${variant} must fail closed`)
  }
  await assert.rejects(runAcpReview({
    ...common,
    env: {
      ...testEnv({ MOCK_SAFE_WORKSPACE_VARIANT: 'mixed' }),
      MOCK_SAFE_RUNTIME_PATH: guide,
    },
  }), error => error.code === 'protocol')
  await assert.rejects(runAcpReview({
    ...common,
    env: testEnv({ MOCK_SAFE_WORKSPACE_LOCATION: targetRepo }),
  }), error => error.code === 'protocol')
})

test('sandbox rejects a PATH-shadowed ACP executable inside the target before launch', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'),
}, async () => {
  const targetRepo = mkdtempSync(join(tmpdir(), 'review-shadow-target-'))
  const fakeBin = join(targetRepo, 'bin')
  const fakeNpx = join(fakeBin, 'npx')
  const fakeHome = mkdtempSync(join(tmpdir(), 'review-shadow-home-'))
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(fakeNpx, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  let launches = 0
  await assert.rejects(runAcpReview({
    profile: profile('zai', {
      command: 'npx',
      args: [],
      osSandbox: 'bwrap',
    }),
    lane: 'zai',
    packet: packet(),
    targetRepository: targetRepo,
    timeoutMs: 3_000,
    env: {
      HOME: fakeHome,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    spawn: () => {
      launches++
      throw new Error('must not launch')
    },
  }), error => error.code === 'config' && /target repository/.test(error.message))
  assert.equal(launches, 0)
})

test('gate starts three primaries in parallel and reports exactly three accepted reviews', async () => {
  const starts = []
  const runner = async ({ profile }) => {
    starts.push(profile.id)
    await new Promise(resolve => setTimeout(resolve, 25))
    return runnerResult(profile, packet())
  }
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  const out = await runReviewGate(packet(), {
    profiles,
    runAcpReview: runner,
    buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    validateReview: () => true,
    synthesizeReviews: (_plan, reviews) => ({ verdict: 'PASS', count: Object.keys(reviews).length }),
  })
  assert.deepEqual(starts.sort(), ['agy', 'codex', 'oc'])
  assert.equal(out.count, 3)
  assert.equal(out.synthesis.count, 3)
})

test('real gate, transport, schema validator, and synthesis accept exactly three mock ACP reviews', async () => {
  const profiles = keyedProfiles([
    gateProfile('kimi', 'kimi'),
    gateProfile('zai', 'zai'),
    gateProfile('agy', 'gemini'),
  ])
  const out = await runReviewGate(packet(), {
    profiles,
    buildProfileEnv: id => ({
      MOCK_REVIEW_BEHAVIOUR: 'schema-only',
      MOCK_REVIEW_MODEL: profiles[id].model,
    }),
    planReviewPanel: () => testPlan(['kimi', 'zai', 'agy']),
  })
  assert.equal(out.ok, true)
  assert.equal(out.count, 3)
  assert.deepEqual(out.route, ['kimi', 'zai', 'agy'])
  assert.deepEqual(out.reviews.map(item => item.displayModel), [
    'kimi/kimi-review-model',
    'zai/zai-review-model',
    'agy/agy-review-model',
  ])
  assert.equal(out.synthesis.verdict, 'PASS')
})

test('panel preflight rejects duplicate or primary-matching runtime families', async () => {
  const cases = [
    {
      profiles: [
        gateProfile('first', 'kimi'), gateProfile('second', 'kimi'), gateProfile('agy', 'gemini'),
      ],
      primaryFamily: 'openai',
      message: /reviewer-family diversity/,
    },
    {
      profiles: [
        gateProfile('first', 'openai'), gateProfile('second', 'kimi'), gateProfile('agy', 'gemini'),
      ],
      primaryFamily: 'openai',
      message: /reviewer-family diversity/,
    },
  ]
  for (const item of cases) {
    const profiles = keyedProfiles(item.profiles)
    await assert.rejects(runReviewGate(packet(), {
      profiles,
      runAcpReview: async ({ profile: selected }) => runnerResult(selected, packet()),
      buildProfileEnv: () => ({}),
      planReviewPanel: () => ({
        blocked: false,
        reviewers: item.profiles.map(selected => selected.id),
        reserve: null,
        primaryFamily: item.primaryFamily,
      }),
      validateReview: () => ({ ok: true }),
      synthesizeReviews: () => ({ verdict: 'PASS' }),
    }), item.message)
  }
})

test('final gate rejects a fallback that introduces duplicate or primary-matching runtime families', async () => {
  const cases = [
    { reserveFamily: 'kimi', message: /families are not distinct/ },
    { reserveFamily: 'openai', message: /matches the primary family/ },
  ]
  for (const item of cases) {
    const profiles = keyedProfiles([
      gateProfile('failed', 'claude'), gateProfile('second', 'kimi'),
      gateProfile('agy', 'gemini'), gateProfile('reserve', item.reserveFamily),
    ])
    const plan = {
      blocked: false,
      reviewers: ['failed', 'second', 'agy'],
      reserve: 'reserve',
      primaryFamily: 'openai',
    }
    await assert.rejects(runReviewGate(packet(), {
      profiles,
      runAcpReview: async ({ profile: selected }) => {
        if (selected.id === 'failed') throw new Error('down')
        return runnerResult(selected, packet())
      },
      buildProfileEnv: () => ({}),
      planReviewPanel: () => plan,
      planFallback: () => ({
        ...plan,
        reviewers: ['reserve', 'second', 'agy'],
        replaced: { failed: 'failed', replacement: 'reserve' },
        usedReserve: true,
      }),
      validateReview: () => ({ ok: true }),
      synthesizeReviews: () => ({ verdict: 'PASS' }),
    }), item.message)
  }
})

test('real transport/schema failure uses one non-Claude reserve and still synthesizes an exact-three panel', async () => {
  const profiles = keyedProfiles([
    gateProfile('kimi', 'kimi'),
    gateProfile('zai', 'zai'),
    gateProfile('agy', 'gemini'),
    gateProfile('codex', 'openai'),
  ])
  const plan = testPlan(['kimi', 'zai', 'agy'], 'codex')
  const out = await runReviewGate(packet(), {
    profiles,
    buildProfileEnv: id => ({
      MOCK_REVIEW_BEHAVIOUR: id === 'kimi' ? 'bad-review' : 'schema-only',
      MOCK_REVIEW_MODEL: profiles[id].model,
    }),
    planReviewPanel: () => plan,
    planFallback: () => ({
      ...plan,
      reviewers: ['codex', 'zai', 'agy'],
      replaced: { failed: 'kimi', replacement: 'codex' },
      usedReserve: true,
    }),
  })
  assert.deepEqual(out.route, ['codex', 'zai', 'agy'])
  assert.equal(out.reviews.filter(item => item.fallback).length, 1)
  assert.deepEqual(out.attempts.map(item => item.status), ['failed', 'accepted', 'accepted', 'accepted'])
  assert.equal(out.synthesis.verdict, 'PASS')
})

test('a non-AGY failure gets one reserve only after originals settle; AGY failure blocks', async () => {
  const calls = []
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy'), profile('oc-reserve')])
  const runner = async ({ profile }) => {
    calls.push(profile.id)
    if (profile.id === 'oc') throw new Error('down')
    return runnerResult(profile, packet())
  }
  const out = await runReviewGate(packet(), {
    profiles,
    runAcpReview: runner,
    buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy'], 'oc-reserve'),
    planFallback: plan => ({ ...plan, reviewers: ['oc-reserve', 'codex', 'agy'], replaced: { failed: 'oc', replacement: 'oc-reserve' }, usedReserve: true }),
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  })
  assert.equal(out.count, 3)
  assert.deepEqual(calls, ['oc', 'codex', 'agy', 'oc-reserve'])
  await assert.rejects(runReviewGate(packet(), {
    profiles: keyedProfiles([profile('oc'), profile('codex'), profile('agy')]),
    runAcpReview: async ({ profile }) => { if (profile.id === 'agy') throw new Error('down'); return runnerResult(profile, packet()) },
    buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }), /AGY review lane failed/)
})

test('provider-limited direct Claude is never launched when claude-zai would violate the final panel', async () => {
  const calls = []
  const profiles = keyedProfiles([
    gateProfile('kimi', 'kimi'), gateProfile('zai', 'zai'), gateProfile('agy', 'gemini'), gateProfile('claude', 'claude'),
  ])
  await assert.rejects(runReviewGate(packet(), {
    profiles,
    runAcpReview: async ({ profile: selected }) => {
      calls.push(selected.id)
      if (selected.id === 'kimi') throw new Error('down')
      return runnerResult(selected, packet())
    },
    buildProfileEnv: () => ({}),
    validateReview: () => ({ ok: true }),
  }), e => e.code === 'transport' && /accepted 2/.test(e.message))
  assert.deepEqual(calls.sort(), ['agy', 'kimi', 'zai'])
})

test('provider-limited Claude lane falls back to claude-zai before any direct Claude launch', async () => {
  const calls = []
  const profiles = keyedProfiles([
    gateProfile('claude', 'claude'), gateProfile('kimi', 'kimi'),
    gateProfile('agy', 'gemini'), gateProfile('zai', 'zai'),
  ])
  const out = await runReviewGate(packet(), {
    profiles,
    runAcpReview: async ({ profile: selected }) => {
      calls.push(selected.id)
      return runnerResult(selected, packet())
    },
    buildProfileEnv: () => ({}),
    planReviewPanel: () => ({
      blocked: false,
      primaryFamily: 'openai',
      reviewers: ['claude', 'kimi', 'agy'],
      reserve: 'zai',
    }),
    validateReview: () => ({ ok: true }),
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  })
  assert.deepEqual(calls.sort(), ['agy', 'kimi', 'zai'])
  assert.deepEqual(out.route, ['zai', 'kimi', 'agy'])
  assert.deepEqual(out.attempts.map(item => [item.profile, item.status]), [
    ['claude', 'failed'], ['kimi', 'accepted'], ['agy', 'accepted'], ['zai', 'accepted'],
  ])
})

test('canonical availability matrix never launches or prepares direct Claude', async () => {
  const makeProfiles = () => keyedProfiles([
    gateProfile('agy', 'gemini'),
    gateProfile('kimi', 'kimi'),
    gateProfile('zai', 'zai'),
    gateProfile('codex', 'openai'),
    gateProfile('claude', 'claude'),
  ])
  const blockedCases = [
    ['openai', 'kimi'], ['openai', 'zai'],
    ['kimi', 'codex'], ['kimi', 'zai'],
    ['zai', 'codex'], ['zai', 'kimi'],
  ]
  for (const [primary, failed] of blockedCases) {
    const calls = []
    const envCalls = []
    const profiles = makeProfiles()
    await assert.rejects(runReviewGate({ ...packet(), primary }, {
      profiles,
      runAcpReview: async ({ profile: selected }) => {
        calls.push(selected.id)
        if (selected.id === failed) throw new Error('down')
        return runnerResult(selected, { ...packet(), primary })
      },
      buildProfileEnv: id => { envCalls.push(id); return {} },
    }), /exactly three are required/)
    assert.equal(calls.includes('claude'), false, `${primary}/${failed} launched direct Claude`)
    assert.equal(envCalls.includes('claude'), false, `${primary}/${failed} prepared direct Claude env`)
  }

  for (const failed of ['codex', 'kimi']) {
    const calls = []
    const envCalls = []
    const profiles = makeProfiles()
    const primaryPacket = { ...packet(), primary: 'claude' }
    const out = await runReviewGate(primaryPacket, {
      profiles,
      runAcpReview: async ({ profile: selected }) => {
        calls.push(selected.id)
        if (selected.id === failed) throw new Error('down')
        return runnerResult(selected, primaryPacket)
      },
      buildProfileEnv: id => { envCalls.push(id); return {} },
    })
    assert.equal(calls.includes('claude'), false)
    assert.equal(envCalls.includes('claude'), false)
    assert.equal(out.route.includes('zai'), true)
    assert.equal(out.route.includes('agy'), true)
    assert.equal(new Set(out.reviews.map(review => review.profile)).size, 3)
    assert.equal(new Set(out.reviews.map(review => review.family)).size, 3)
    assert.equal(new Set(out.reviews.map(review => review.model)).size, 3)
  }

  for (const primary of ['openai', 'claude', 'kimi', 'zai']) {
    const calls = []
    const envCalls = []
    const profiles = makeProfiles()
    const primaryPacket = { ...packet(), primary }
    await assert.rejects(runReviewGate(primaryPacket, {
      profiles,
      runAcpReview: async ({ profile: selected }) => {
        calls.push(selected.id)
        if (selected.id === 'agy') throw new Error('down')
        return runnerResult(selected, primaryPacket)
      },
      buildProfileEnv: id => { envCalls.push(id); return {} },
    }), /AGY review lane failed/)
    assert.equal(calls.includes('claude'), false)
    assert.equal(envCalls.includes('claude'), false)
  }
})

test('fallback synthesis receives the replacement plan and non-PASS verdicts block the gate', async () => {
  const profiles = { oc: profile('oc'), codex: profile('codex'), agy: profile('agy'), reserve: profile('reserve') }
  const plans = []
  const runner = async ({ profile }) => {
    if (profile.id === 'oc') throw new Error('down')
    return runnerResult(profile, { ...packet(), primary: 'test' })
  }
  const planner = () => ({ reviewers: ['oc', 'codex', 'agy'], reserve: 'reserve', primaryFamily: 'test' })
  const fallback = () => ({ reviewers: ['reserve', 'codex', 'agy'], reserve: 'reserve', replaced: { failed: 'oc', replacement: 'reserve' }, primaryFamily: 'test', usedReserve: true })
  const out = await runReviewGate({ ...packet(), primary: 'test' }, { profiles, runAcpReview: runner, buildProfileEnv: () => ({}), planReviewPanel: planner, planFallback: fallback, validateReview: () => ({ ok: true }), synthesizeReviews: (plan) => { plans.push(plan); return { verdict: 'PASS' } } })
  assert.equal(plans[0].reviewers[0], 'reserve')
  assert.equal(out.ok, true)
  await assert.rejects(runReviewGate(packet(), {
    profiles: keyedProfiles([profile('oc'), profile('codex'), profile('agy')]),
    runAcpReview: async ({ profile }) => runnerResult(profile, packet()),
    buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'OBJECTIONS' }),
  }), e => e.code === 'policy' && e.report?.ok === false && e.report?.synthesis?.verdict === 'OBJECTIONS')
})

test('CLI preserves a structured objection report on stdout while returning policy exit 5', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'review-cli-'))
  const packetFile = join(scratch, 'packet.json')
  writeFileSync(packetFile, JSON.stringify(packet()))
  const report = {
    ok: false,
    count: 3,
    synthesis: {
      verdict: 'OBJECTIONS',
      mustFix: [{ criterion_id: 'AC-1', reviewers: ['agy', 'kimi'] }],
    },
  }
  const error = new ReviewTransportError('policy', 'review synthesis is not PASS (OBJECTIONS)')
  error.report = report
  let stdout = ''
  let stderr = ''
  const code = await runReviewGateCli([packetFile, '/tmp'], {
    gate: async () => { throw error },
    stdout: { write: value => { stdout += value } },
    stderr: { write: value => { stderr += value } },
  })
  assert.equal(code, 5)
  assert.deepEqual(JSON.parse(stdout), report)
  assert.match(stderr, /review synthesis is not PASS/)
})

test('arbitrary profile arrays cannot bypass deterministic policy routing', async () => {
  await assert.rejects(runReviewGate(packet(), {
    profiles: [profile('one'), profile('two'), profile('three')],
  }), e => e.code === 'input')
})

test('conflicting primary declarations fail closed before any lane starts', async () => {
  let starts = 0
  await assert.rejects(runReviewGate({
    ...packet(),
    primary: 'openai',
    primary_model: 'gemini-3.1-pro',
  }, {
    runAcpReview: async () => { starts++; throw new Error('must not start') },
  }), error => error.code === 'policy' && /conflicting primary families/.test(error.message))
  assert.equal(starts, 0)
})

test('AGY malformed-review failures retain review classification for exit-code mapping', async () => {
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  await assert.rejects(runReviewGate(packet(), {
    profiles,
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    buildProfileEnv: () => ({}),
    runAcpReview: async ({ profile }) => {
      if (profile.id === 'agy') throw new ReviewTransportError('review', 'malformed review')
      return runnerResult(profile, packet())
    },
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }), error => error.code === 'review')
})

test('profile environment is explicit, not inherited into the review agent', async () => {
  const previous = process.env.SUPER_SECRET
  process.env.SUPER_SECRET = 'should-not-leak'
  const scratch = mkdtempSync(join(tmpdir(), 'review-env-'))
  const logFile = join(scratch, 'log')
  const out = await runAcpReview({ profile: profile('oc'), lane: 'oc', packet: packet(), timeoutMs: 3_000, env: { MOCK_REVIEW_BEHAVIOUR: 'ok', LEAK_ME: undefined, MOCK_REVIEW_LOG: logFile } })
  assert.equal(out.review.verdict, 'PASS')
  assert.equal(out.review.leaked, null)
  // The fixture only logs protocol events; its environment receives no packet
  // or caller-provided arbitrary variables, while controlled test config works.
  assert.equal(existsSync(logFile), false, 'fixture does not gain arbitrary filesystem authority')
  if (previous === undefined) delete process.env.SUPER_SECRET
  else process.env.SUPER_SECRET = previous
})

test('a blocked gate emits a distinguishable per-lane diagnostic, never a zero-byte report', async () => {
  const profiles = keyedProfiles([
    gateProfile('kimi', 'kimi'), gateProfile('zai', 'zai'),
    gateProfile('agy', 'gemini'), gateProfile('codex', 'openai'),
  ])
  const plan = testPlan(['kimi', 'zai', 'agy'], 'codex')
  const blockedGate = options => runReviewGate(packet(), {
    profiles,
    buildProfileEnv: () => ({}),
    planReviewPanel: () => plan,
    planFallback: () => ({ blocked: true, reason: 'reserve already used' }),
    runAcpReview: async ({ profile: selected }) => runnerResult(selected, packet()),
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
    ...options,
  }).then(() => null, error => error)
  const laneThrows = (lane, code, digest) => ({
    runAcpReview: async ({ profile: selected }) => {
      if (selected.id !== lane) return runnerResult(selected, packet())
      const error = new ReviewTransportError(code, `${lane} ${code}`)
      error.stderrDigest = digest
      error.stderrBytes = 128
      throw error
    },
  })
  const laneOf = (error, id) => error.report.attempts.find(item => item.profile === id)

  // The operator symptom, reproduced: four structurally different kimi failures
  // reached stderr as one sentence and left a zero-byte report file.
  const serialized = []
  for (const [code, digest] of [
    ['closed', 'a'.repeat(64)], ['closed', 'b'.repeat(64)],
    ['timeout', 'c'.repeat(64)], ['spawn', 'd'.repeat(64)],
  ]) {
    const error = await blockedGate(laneThrows('kimi', code, digest))
    assert.match(error.message, /accepted 2/)
    assert.ok(error.report, `${code} blocked the gate with no report`)
    assert.equal(laneOf(error, 'kimi').status, 'failed')
    assert.equal(laneOf(error, 'kimi').stage, code)
    assert.equal(laneOf(error, 'kimi').stderrDigest, digest)
    assert.deepEqual(error.report.substitution, {
      used: false, replaced: 'kimi', replacement: null, remaining: 0, reason: 'reserve already used',
    })
    serialized.push(JSON.stringify(error.report))
  }
  assert.equal(new Set(serialized).size, 4, 'structurally different lane failures must not serialize identically')

  // The two gate-local stages downstream of transport.
  const badSchema = await blockedGate({
    validateReview: (_review, context) => context.profile !== 'kimi' || { ok: false, reason: 'invalid verdict' },
  })
  assert.equal(laneOf(badSchema, 'kimi').stage, 'schema')
  assert.equal(laneOf(badSchema, 'kimi').failure, 'invalid verdict')
  const badEvidence = await blockedGate({
    runAcpReview: async ({ profile: selected }) =>
      runnerResult(selected, selected.id === 'kimi' ? { ...packet(), objective: 'other' } : packet()),
  })
  assert.equal(laneOf(badEvidence, 'kimi').stage, 'acknowledge')

  // AGY has no reserve, so no substitution is possible on that blocker.
  const agyBlocked = await blockedGate(laneThrows('agy', 'timeout', 'e'.repeat(64)))
  assert.match(agyBlocked.message, /AGY review lane failed/)
  assert.ok(agyBlocked.report, 'the AGY blocker emitted no report')
  assert.equal(laneOf(agyBlocked, 'agy').stage, 'timeout')
  assert.deepEqual(agyBlocked.report.substitution, {
    used: false, replaced: null, replacement: null, remaining: 0, reason: 'AGY is mandatory and cannot be replaced',
  })

  // A reserve that launched and also failed: four lanes, two stages, none left.
  const bothFailed = await blockedGate({
    planFallback: () => ({ ...plan, reviewers: ['codex', 'zai', 'agy'], replaced: { failed: 'kimi', replacement: 'codex' }, usedReserve: true }),
    runAcpReview: async ({ profile: selected }) => {
      if (selected.id === 'kimi') throw new ReviewTransportError('timeout', 'kimi timeout')
      if (selected.id === 'codex') throw new ReviewTransportError('spawn', 'codex spawn')
      return runnerResult(selected, packet())
    },
  })
  assert.deepEqual(bothFailed.report.attempts.map(item => [item.profile, item.status, item.stage]), [
    ['kimi', 'failed', 'timeout'], ['zai', 'accepted', undefined],
    ['agy', 'accepted', undefined], ['codex', 'failed', 'spawn'],
  ])
  assert.equal(laneOf(bothFailed, 'codex').replaces, 'kimi')
  assert.deepEqual(bothFailed.report.substitution, {
    used: true, replaced: 'kimi', replacement: 'codex', remaining: 0, reason: null,
  })

  // Nothing a runner or planner supplies reaches the report unbounded. This is
  // the boundary SKILL.md states: the digest and the byte count cross it, the
  // provider's own bytes never do.
  const injected = await blockedGate({
    planFallback: () => ({ blocked: true, reason: 'q'.repeat(4096) }),
    runAcpReview: async ({ profile: selected }) => {
      if (selected.id !== 'kimi') return runnerResult(selected, packet())
      const error = new Error('down')
      error.code = 'Z'.repeat(4096)
      error.stderrDigest = 'provider said: sk-live-not-a-digest'
      throw error
    },
  })
  const text = JSON.stringify(injected.report)
  assert.equal(text.includes('Z'.repeat(64)), false, 'an injected error code reached the report verbatim')
  assert.equal(text.includes('q'.repeat(64)), false, 'an injected fallback reason reached the report verbatim')
  assert.equal(text.includes('sk-live'), false, 'unbounded provider text reached the report')
  assert.equal(laneOf(injected, 'kimi').stage, 'transport')
})

test('the lane timeout is an inactivity lease, sized deliberately and overridable', () => {
  // The lease is not a wall-clock cap: any ACP session traffic from the lane
  // restarts it (see acp-review-client.mjs), so it bounds how long a SILENT
  // lane may linger, never how long a working review may take. The old 240s
  // elapsed default was sized for a ping and timed out real fifteen-file
  // packets; the lease is sized like the worker stall-lease instead. One
  // number, bounded, raised on purpose.
  assert.equal(laneTimeoutMs({}), LANE_TIMEOUT_DEFAULT_MS)
  assert.equal(LANE_TIMEOUT_DEFAULT_MS, 1_800_000)
  assert.equal(laneTimeoutMs({ REVIEW_GATE_LANE_TIMEOUT_SEC: '2400' }), 2_400_000)

  // Anything that is not a positive whole number of seconds falls back to the
  // default rather than becoming one: `0` would mean no time at all, and NaN
  // would reach the client as an invalid timeout and fail the whole gate for a
  // typo in an environment variable.
  for (const bad of ['0', '-5', 'abc', '1.5', '', undefined]) {
    assert.equal(laneTimeoutMs({ REVIEW_GATE_LANE_TIMEOUT_SEC: bad }), LANE_TIMEOUT_DEFAULT_MS, `bad value ${bad}`)
  }
})

test('a lane runs the mode it declares, and a runner that ran another one is refused', async () => {
  // The gate used to overwrite every profile with reviewMode 'plan' before
  // launch, so a lane declaring anything else got plan mode anyway — which is
  // how the zai lane kept answering prose to a JSON-only protocol it could not
  // hold. Two halves, and both must hold: the declared mode reaches the runner,
  // and the acknowledgement is checked against what THIS lane asked for rather
  // than against the word 'plan'.
  const seen = []
  const gateWith = (declared, reported) => runReviewGate(packet(), {
    profiles: keyedProfiles([
      profile('oc', { reviewMode: declared, config: { model: 'oc-review-model', mode: declared } }),
      profile('codex'), profile('agy'),
    ]),
    runAcpReview: async ({ profile: selected }) => {
      seen.push(`${selected.id}:${selected.reviewMode}`)
      const result = runnerResult(selected, packet())
      return selected.id === 'oc' ? { ...result, mode: reported } : result
    },
    buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    validateReview: () => true,
    synthesizeReviews: (_plan, reviews) => ({ verdict: 'PASS', count: Object.keys(reviews).length }),
  })

  const out = await gateWith('default', 'default')
  assert.ok(seen.includes('oc:default'), `the gate overwrote the declared mode: ${seen.join(', ')}`)
  assert.equal(out.count, 3)

  // Declared one mode, ran another: that is the isolation claim failing, and it
  // must block rather than be counted as a review.
  await assert.rejects(gateWith('default', 'plan'), /accepted 2; exactly three are required/)
})

test('the review mode vocabulary is two words, and a third is refused before launch', async () => {
  // `default` was added for one model that cannot hold plan mode. That is an
  // exception, not an opening: a lane declaring anything else must fail at the
  // door rather than reach a provider and be judged by what it happens to
  // answer. Without this the set is decoration and the next profile can invent
  // its own mode silently.
  for (const mode of ['plan', 'default']) {
    const out = await invoke(profile('oc', { reviewMode: mode, config: { model: 'oc-review-model', mode } }))
    assert.equal(out.mode, mode)
  }
  for (const mode of ['yolo', 'read-only', '', 'PLAN', undefined]) {
    await assert.rejects(
      invoke(profile('oc', { reviewMode: mode })),
      /must declare reviewMode 'plan' or 'default'/,
      `accepted reviewMode ${JSON.stringify(mode)}`,
    )
  }
})
