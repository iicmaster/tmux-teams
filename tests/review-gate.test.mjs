import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcpReview, prepareReviewPacket, ReviewTransportError, interpreterRoots,
  trustedExecutableRoots, resolveExecutable,
} from '../plugins/tmux-teams/skills/party-mode/scripts/acp-review-client.mjs'
import { runReviewGate, runReviewGateCli, LANE_TIMEOUT_DEFAULT_MS, laneTimeoutMs, LANE_FAILURES,
} from '../plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs'
import { REVIEW_PROFILES } from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'

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
  // `id` in the argv on purpose, same reason `gateProfile` below does it: the
  // execution layer runs `command` as a STRING with `args` beside it, and since
  // r6-qwen the diversity gate reads that shape too. Every lane sharing
  // `[node, MOCK]` made these fixtures exec-identical — the r5-qwen attack
  // shape — so a panel built from them is one the gate is right to refuse.
  args: [MOCK, id],
  model: `${id}-review-model`,
  reviewMode: 'plan',
  config: { model: `${id}-review-model`, mode: 'plan' },
  // Distinct per id by default -- real profiles always declare one, and
  // provenFamilyCollision (review-profiles.mjs) now treats two lanes that
  // both omit it as an unresolved, refused collision rather than "no
  // evidence, therefore fine" (issue #38 follow-up, bypass 2). Tests that
  // deliberately want two synthetic lanes to collide pass a matching
  // `adapterPackage` through `extra`, same as before.
  adapterPackage: `mock-adapter-${id}`,
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
    targetRepositoryHidden: false,
    targetRepositoryCanonical: undefined,
    hostRootBaseReadOnly: false,
    hostDataRootsMasked: false,
    hostProcessNamespaceIsolated: false,
    mcpServers: 0,
    builtInToolsRequested: false,
    toolCallsObserved: 0,
    reasoningUpdatesObserved: 0,
    safeRuntimeReadsObserved: 0,
    safeWorkspaceReadsObserved: 0,
    temporaryModelSettings: Boolean(p.sessionSettings),
    hostProviderHomeVisible: true,
    ephemeralProviderStateWritable: false,
    hostProviderStatePersistent: true,
    providerMayPersistRemoteState: true,
    networkSharedWithHost: true,
    acpPermissionRequests: 'deny',
  },
  review,
  inputHash: prepareReviewPacket(staticPacket).inputHash,
  provenance: `review-runner:test-${p.id}`,
  packetBytes: 100,
})
const keyedProfiles = entries => Object.fromEntries(entries.map(entry => [entry.id, entry]))
const gateProfile = (id, family) => profile(id, {
  // `id` is in the argv on purpose. Two lanes that exec byte-identical bytes are
  // one lane — that is the rule these fixtures exist to exercise — so a double
  // claiming to be a distinct reviewer has to launch distinctly, exactly as the
  // shipped profiles do (they differ by `claudeExecutable`: claude-qwen vs
  // claude-zai vs claude-kimi over one adapter package). A shared
  // `[node, MOCK]` made every double indistinguishable and would have made the
  // guard look like a false-positive machine when it was reading them correctly.
  command: [process.execPath, MOCK, id],
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
  // The reviewer must be TOLD the runner redacted the packet. Without this, all
  // three lanes on 2026-08-13 were shown `const credentials = [REDACTED]` where
  // the source reads `loadRoutedCredentialFile(profile, source)` — the
  // identifier matches `sensitiveName` and the assignment pattern replaces to
  // end of line — and one of them reported a syntax error in code that has
  // none. A true finding about the pipeline, a false one about the repository.
  assert.equal(out.review.sawRedactionNotice, true,
    'the reviewer was not told that [REDACTED] markers are the runner\'s')
  assert.equal(out.review.toolsDisabled, true)
  assert.deepEqual(out.acknowledgements.model, { value: 'oc-review-model', source: 'session_config' })
  assert.deepEqual(out.acknowledgements.mode, { value: 'plan', source: 'session_config' })
  assert.equal(out.isolation.builtInToolsRequested, false)
  assert.equal(out.isolation.toolCallsObserved, 0)
  assert.notEqual(out.review.cwd, process.cwd(), 'agent receives a neutral temp cwd, never the target repo')
  assert.equal(existsSync(out.review.cwd), false, 'neutral cwd is removed after the turn')
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged', 'review transport does not mutate a target repository')
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


test('a valid verdict wrapped in prose is extracted, and prose alone is still refused', async () => {
  // Measured 2026-08-13: through the gate the zai lane returned one strict JSON
  // document on 1 of 4 runs while qwen and agy returned 4 of 4 — same machine,
  // same minutes, same packets. Three complete reviews were being discarded over
  // formatting, and a panel cannot be built on a lane that answers one time in
  // four.
  //
  // Both halves matter. Prose AROUND a valid verdict object is accepted and the
  // caller is told extraction happened. Prose INSTEAD of one is still refused —
  // without that second assertion this test would license waffling into a PASS,
  // which is exactly what the strict parse was there to prevent.
  const wrapped = await invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'prose-wrapped-review' })
  assert.equal(wrapped.review.verdict, 'PASS', 'a verdict wrapped in prose was lost')
  assert.equal(wrapped.reviewExtracted, true, 'the caller was not told the document needed extraction')

  await assert.rejects(
    invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'prose-only-review' }),
    (e) => e.code === 'review',
    'prose with no verdict object was accepted as a review',
  )
})

test('a review that parses strictly is not reported as extracted', () =>
  invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'schema-only' }).then((out) => {
    assert.equal(out.reviewExtracted, false, 'a clean document was reported as extracted')
  }))


test('a clean review is not reported as redacted', () =>
  invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'schema-only' }).then((out) => {
    // The other half. Without this, a change that marked EVERY review redacted
    // would satisfy the test above and tell the operator nothing.
    assert.equal(out.reviewRedacted, false, 'a review with no credential-shaped text was reported as redacted')
  }))

test('malformed JSON-RPC, malformed review, and timeout never become accepted reviews', async () => {
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'malformed' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'bad-review' }), e => e.code === 'review')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'response-then-invalid' }), e => e.code === 'protocol')
  await assert.rejects(invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'response-then-exit-7' }), e => e.code === 'closed')
  await assert.rejects(runAcpReview({ profile: profile('oc'), lane: 'oc', packet: packet(), timeoutMs: 25, env: { MOCK_REVIEW_BEHAVIOUR: 'late' } }), e => e.code === 'timeout')
})

test('null timeout disables elapsed cancellation and emits correlated ACP progress', async () => {
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
  // 16 MiB since 2026-08-09, raised from 2 with the measurement written into
  // ACP_REVIEW_LIMITS. This ceiling counts TRANSPORT bytes: an ACP adapter
  // emits one JSON-RPC envelope per streamed token, so 8,531 envelopes carrying
  // roughly 20 KB of thinking measured 2,097,253 bytes on the zai lane and blew
  // the old ceiling on an ordinary answer. Pinned here on purpose — this number
  // is a boundary, and moving it must be a decision someone makes rather than a
  // quiet edit. `messageBytesLimit` below is the guard that actually bounds a
  // hostile agent, and it has not moved.
  assert.equal(out.isolation.stdoutBytesLimit, 16 * 1024 * 1024)
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
    gateProfile('qwen', 'qwen'), gateProfile('zai', 'zai'), gateProfile('agy', 'gemini'), gateProfile('claude', 'claude'),
  ])
  await assert.rejects(runReviewGate(packet(), {
    profiles,
    runAcpReview: async ({ profile: selected }) => {
      calls.push(selected.id)
      if (selected.id === 'qwen') throw new Error('down')
      return runnerResult(selected, packet())
    },
    buildProfileEnv: () => ({}),
    validateReview: () => ({ ok: true }),
  }), e => e.code === 'transport' && /accepted 2/.test(e.message))
  assert.deepEqual(calls.sort(), ['agy', 'qwen', 'zai'])
})

test('provider-limited Claude lane falls back to claude-zai before any direct Claude launch', async () => {
  const calls = []
  const profiles = keyedProfiles([
    gateProfile('claude', 'claude'), gateProfile('qwen', 'qwen'),
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
      reviewers: ['claude', 'qwen', 'agy'],
      reserve: 'zai',
    }),
    validateReview: () => ({ ok: true }),
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  })
  assert.deepEqual(calls.sort(), ['agy', 'qwen', 'zai'])
  assert.deepEqual(out.route, ['zai', 'qwen', 'agy'])
  assert.deepEqual(out.attempts.map(item => [item.profile, item.status]), [
    ['claude', 'failed'], ['qwen', 'accepted'], ['agy', 'accepted'], ['zai', 'accepted'],
  ])
})

test('canonical availability matrix never launches or prepares direct Claude', async () => {
  const makeProfiles = () => keyedProfiles([
    gateProfile('agy', 'gemini'),
    gateProfile('kimi', 'kimi'),
    gateProfile('qwen', 'qwen'),
    gateProfile('zai', 'zai'),
    gateProfile('codex', 'openai'),
    gateProfile('claude', 'claude'),
    gateProfile('deepseek', 'deepseek'),
  ])
  const blockedCases = [
    ['openai', 'qwen'], ['openai', 'zai'],
    ['kimi', 'codex'], ['kimi', 'zai'],
    ['zai', 'codex'], ['zai', 'qwen'],
    ['qwen', 'codex'], ['qwen', 'zai'],
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

  // The claude route seats [agy, zai, qwen] and reserves `deepseek` (2026-08-08).
  // Only the qwen seat is coverable: `deepseek` shares one gateway and one
  // adapter with `qwen`, so a panel seating both counts one proven family as
  // two, and a zai replacement has nowhere to come from — whichever of that pair
  // is not already seated collides with the one that is. That limit is asserted
  // in `review-policy.test.mjs`; what this proves is that the covered case still
  // never reaches direct Claude.
  for (const failed of ['qwen']) {
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

  for (const primary of ['openai', 'claude', 'kimi', 'zai', 'qwen']) {
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

test('a refused lane names a closed reason and the action reaches stderr, not only the JSON', async () => {
  // Every entry earns its place: a reason nobody can act on is a sentence with
  // a code bolted to it, which is what this replaced.
  for (const [reason, entry] of Object.entries(LANE_FAILURES)) {
    assert.match(reason, /^[a-z][a-z_]*$/, `${reason} is not a stable code`)
    assert.ok(entry.text.length > 10 && entry.action.length > 20, `${reason} states no usable action`)
    assert.notEqual(entry.text, entry.action, `${reason} repeats itself instead of saying what to do`)
    // F6: the outer table was frozen, but each {text, action} value is its own
    // object and Object.freeze is shallow — same-process code could overwrite
    // `.action` after import. Every entry must resist that too.
    assert.ok(Object.isFrozen(entry), `${reason} is not frozen: LANE_FAILURES is a shallow freeze`)
    assert.throws(() => { entry.action = 'mutated' }, `${reason}.action accepted a same-process overwrite`)
  }
  // A code can be deleted from the table with every other assertion in this
  // file still green, because nothing elsewhere in the suite names every key
  // at once. This is the one place that would catch it.
  assert.deepEqual(Object.keys(LANE_FAILURES).sort(), [
    'config_unacknowledged', 'display_model_identity', 'isolation_unacknowledged',
    'lane_failed', 'lane_rejected', 'mode_not_enforced', 'model_identity',
    'packet_hash', 'profile_identity', 'provenance_invalid', 'provider_identity',
    'runner_missing', 'schema_invalid', 'validator_threw',
  ].sort(), 'LANE_FAILURES gained or lost a code with no test change')

  const scratch = mkdtempSync(join(tmpdir(), 'review-cli-action-'))
  const packetFile = join(scratch, 'packet.json')
  writeFileSync(packetFile, JSON.stringify(packet()))
  const error = new ReviewTransportError('transport', 'review gate accepted 2; exactly three are required')
  error.report = {
    ok: false,
    blocked: true,
    attempts: [
      { profile: 'zai', status: 'accepted' },
      {
        profile: 'kimi', status: 'failed', stage: 'timeout', reason: 'lane_failed',
        action: LANE_FAILURES.lane_failed.action, failure: LANE_FAILURES.lane_failed.text,
      },
      // A failed lane whose reason is not in the table has no action, and a line
      // that trails off into `— undefined` is worse than no line: it reads as an
      // instruction the operator failed to understand.
      { profile: 'codex', status: 'failed', stage: 'transport', reason: 'not_in_table', action: null },
    ],
  }
  let stdout = ''
  let stderr = ''
  const code = await runReviewGateCli([packetFile, '/tmp'], {
    gate: async () => { throw error },
    stdout: { write: value => { stdout += value } },
    stderr: { write: value => { stderr += value } },
  })
  assert.equal(code, 3)
  assert.deepEqual(JSON.parse(stdout), error.report)
  assert.match(stderr, /kimi timeout\/lane_failed — Re-run this lane alone/)
  // An accepted lane has nothing to act on and must not print a line saying so.
  assert.doesNotMatch(stderr, /zai/)
  assert.doesNotMatch(stderr, /codex/, 'a lane with no action printed an empty instruction')
  assert.doesNotMatch(stderr, /undefined|null/)
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
    assert.equal(laneOf(error, 'kimi').reason, 'lane_failed')
    // Hardcoded, not `LANE_FAILURES.lane_failed.action`: comparing the report
    // against the very table the gate read it from is a tautology that stays
    // green even if every code were made to share one action. This literal is
    // the independent witness.
    assert.equal(laneOf(error, 'kimi').action, 'Re-run this lane alone and compare stderrDigest against the provider log. Nothing about the panel changes until it answers.')
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
  assert.equal(laneOf(badSchema, 'kimi').reason, 'schema_invalid')
  // The validator's own reason is kept — it is the half that says WHICH rule
  // broke — but it is now a subject inside a gate-authored sentence.
  assert.equal(laneOf(badSchema, 'kimi').failure, `${LANE_FAILURES.schema_invalid.text} (invalid verdict)`)
  // Hardcoded for the same reason as above — an independent witness, not the
  // table checking itself.
  assert.equal(laneOf(badSchema, 'kimi').action, 'Re-run this lane once. If it repeats, this model cannot hold the JSON review protocol and the route needs changing.')
  const badEvidence = await blockedGate({
    runAcpReview: async ({ profile: selected }) =>
      runnerResult(selected, selected.id === 'kimi' ? { ...packet(), objective: 'other' } : packet()),
  })
  assert.equal(laneOf(badEvidence, 'kimi').stage, 'acknowledge')
  assert.equal(laneOf(badEvidence, 'kimi').reason, 'packet_hash')
  // Hardcoded for the same reason as above — an independent witness, not the
  // table checking itself.
  assert.equal(laneOf(badEvidence, 'kimi').action, 'Discard this review outright and rebuild the packet. A review of unknown bytes is never accepted, however good it reads.')

  // `mode_not_enforced` had no assertion anywhere in this file: it could be
  // deleted from LANE_FAILURES and the whole suite stayed green. Drive it
  // through the real runnerEvidenceFault branch — a runner reporting a mode
  // other than the one its profile declared.
  const badMode = await blockedGate({
    runAcpReview: async ({ profile: selected }) => {
      const result = runnerResult(selected, packet())
      return selected.id === 'kimi' ? { ...result, mode: 'default' } : result
    },
  })
  assert.equal(laneOf(badMode, 'kimi').stage, 'acknowledge')
  assert.equal(laneOf(badMode, 'kimi').reason, 'mode_not_enforced')
  assert.equal(laneOf(badMode, 'kimi').failure, LANE_FAILURES.mode_not_enforced.text)
  assert.equal(laneOf(badMode, 'kimi').action, 'Do not retry the same profile: reconcile reviewMode in review-profiles.mjs with the mode this model will actually hold.')

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

test('a lane gets minutes, not a ping budget, and the ceiling is raised deliberately', () => {
  // The client default was 240s, sized for a ping. A real completion packet —
  // fifteen files — took the kimi lane past it, and a lane killed for being
  // slow is indistinguishable in the report from a lane that is broken. The
  // ceiling stays a ceiling: one number, bounded, raised on purpose.
  assert.equal(laneTimeoutMs({}), LANE_TIMEOUT_DEFAULT_MS)
  assert.equal(LANE_TIMEOUT_DEFAULT_MS, 900_000)
  assert.equal(laneTimeoutMs({ REVIEW_GATE_LANE_TIMEOUT_SEC: '1800' }), 1_800_000)

  // Anything that is not a positive whole number of seconds falls back to the
  // default rather than becoming one: `0` would mean no time at all, and NaN
  // would reach the client as an invalid timeout and fail the whole gate for a
  // typo in an environment variable.
  for (const bad of ['0', '-5', 'abc', '1.5', '', undefined]) {
    assert.equal(laneTimeoutMs({ REVIEW_GATE_LANE_TIMEOUT_SEC: bad }), LANE_TIMEOUT_DEFAULT_MS, `bad value ${bad}`)
  }
})

test('the gate refuses a panel whose lanes share one unproven adapter identity (issue #38)', async () => {
  // Real, shipped REVIEW_PROFILES -- not synthetic doubles. The attack in issue
  // #38 was kimi beside claude: different declared families, satisfying the old
  // exact-three rule, over one adapter package with nothing telling them apart.
  //
  // Kimi is endpoint-pinned as of 2026-08-04, so THAT pair is now genuinely
  // distinct and refusing it would be the opposite failure. The attack itself
  // has not gone anywhere: bare `claude` is still unrouted, so any second
  // unrouted lane on the same package reproduces it exactly. `claudeUnpinnedTwin`
  // is that lane, built from the shipped claude profile so it cannot drift away
  // from what the gate really sees.
  const claudeUnpinnedTwin = { ...REVIEW_PROFILES.claude, id: 'claude-twin', family: 'twin-family', model: 'twin-model', displayModel: 'twin/model' }
  const profilesWithTwin = { ...REVIEW_PROFILES, 'claude-twin': claudeUnpinnedTwin }
  const forcedPlan = { blocked: false, primaryFamily: 'test-primary-outside-panel', reviewers: ['claude-twin', 'claude', 'agy'], reserve: null }
  const runner = async ({ profile: selected }) => ({ ...runnerResult(selected, packet()), mode: selected.reviewMode })
  await assert.rejects(runReviewGate(packet(), {
    profiles: profilesWithTwin,
    runAcpReview: runner,
    buildProfileEnv: () => ({}),
    planReviewPanel: () => forcedPlan,
    validateReview: () => ({ ok: true }),
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }), e => e.code === 'policy' && /proven-identity diversity/.test(e.message))

  // Today's real, legitimate `openai` route -- qwen seated alongside zai, not
  // claude -- is unaffected: both routed profiles have different parent-
  // verified endpoint pins.
  const legitimatePlan = { blocked: false, primaryFamily: 'openai', reviewers: ['qwen', 'zai', 'agy'], reserve: 'claude' }
  const out = await runReviewGate(packet(), {
    profiles: REVIEW_PROFILES,
    runAcpReview: runner,
    buildProfileEnv: () => ({}),
    planReviewPanel: () => legitimatePlan,
    validateReview: () => ({ ok: true }),
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  })
  assert.equal(out.ok, true)
  assert.deepEqual(out.route, ['qwen', 'zai', 'agy'])
  assert.equal(out.reviews.find(item => item.profile === 'qwen').familyProvenKey,
    '@agentclientprotocol/claude-agent-acp@0.61.0::pinned:token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic')
  assert.equal(out.reviews.find(item => item.profile === 'zai').familyProvenKey,
    '@agentclientprotocol/claude-agent-acp@0.61.0::pinned:api.z.ai/api/anthropic')
})

test('a fallback substitution that reintroduces a proven-identity collision is caught after the original panel already cleared preflight', async () => {
  // choosePanel's preflight only sees the ORIGINAL primary panel. A fallback
  // substitution runs later and can reintroduce exactly the collision
  // preflight was built to catch -- this is what the final-panel check
  // (mirroring the existing declared-family final check) exists for. Real
  // `claude` cannot be used here: defaultLaneRunner refuses it unconditionally
  // regardless of policy, so this uses two synthetic profiles that share one
  // declared `adapterPackage`, the same way the collision is expressed for
  // real kimi/claude.
  const collideA = profile('collide-a', { family: 'family-a', adapterPackage: 'shared-adapter@1.0.0' })
  const collideB = profile('collide-b', { family: 'family-b', adapterPackage: 'shared-adapter@1.0.0' })
  const profiles = keyedProfiles([collideA, profile('second'), profile('agy'), collideB])
  const plan = { blocked: false, primaryFamily: 'test-primary', reviewers: ['collide-a', 'second', 'agy'], reserve: 'collide-b' }
  await assert.rejects(runReviewGate(packet(), {
    profiles,
    runAcpReview: async ({ profile: selected }) => {
      if (selected.id === 'second') throw new Error('down')
      return runnerResult(selected, packet())
    },
    buildProfileEnv: () => ({}),
    planReviewPanel: () => plan,
    planFallback: () => ({ ...plan, reviewers: ['collide-b', 'collide-a', 'agy'], replaced: { failed: 'second', replacement: 'collide-b' }, usedReserve: true }),
    validateReview: () => ({ ok: true }),
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }), e => e.code === 'policy' && /final review proven identities are not distinct/.test(e.message))
})

test('a fallback substitution that reintroduces TWO unresolved (null-key) proven identities is caught (BLOCKER5/BLOCKER7, r4-codex)', async () => {
  // r3-codex's original probe was [null-reserve, null-a, agy] reaching
  // ok:true, because the final-panel check kept its own
  // `.filter(key => key !== null)` copy instead of calling the shared, fixed
  // rule. The existing regression test above (:1118) only exercises TWO
  // EQUAL, NON-null known keys -- reverting the shared call and restoring the
  // filter-based copy leaves THAT test green, because two matching known keys
  // still collide under `.filter().Set` too. Two profiles that resolve to
  // null (no `adapterPackage` declared at all) is the one shape that
  // actually tells the fixed rule apart from the reverted one: the old copy
  // filtered nulls out before comparing, so [null, null, agy] read as
  // [agy] -- no duplicates, ok:true.
  const nullA = profile('null-a', { family: 'family-a', adapterPackage: undefined })
  const nullB = profile('null-b', { family: 'family-b', adapterPackage: undefined })
  const profiles = keyedProfiles([nullA, profile('second'), profile('agy'), nullB])
  const plan = { blocked: false, primaryFamily: 'test-primary', reviewers: ['null-a', 'second', 'agy'], reserve: 'null-b' }
  await assert.rejects(runReviewGate(packet(), {
    profiles,
    runAcpReview: async ({ profile: selected }) => {
      if (selected.id === 'second') throw new Error('down')
      return runnerResult(selected, packet())
    },
    buildProfileEnv: () => ({}),
    planReviewPanel: () => plan,
    planFallback: () => ({ ...plan, reviewers: ['null-b', 'null-a', 'agy'], replaced: { failed: 'second', replacement: 'null-b' }, usedReserve: true }),
    validateReview: () => ({ ok: true }),
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }), e => e.code === 'policy' && /final review proven identities are not distinct/.test(e.message))
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

test('F5: a custom validator cannot forge a report line or a terminal escape through the closed reason', async () => {
  // The comment above the schema_invalid branch used to claim the validator's
  // vocabulary was closed by construction. It is only closed for the DEFAULT
  // validator; `validateReview` is a public injection seam, and this is what
  // reproduces the advisor's probe: a custom validator answers with a forged
  // line and control bytes, and the boundary must refuse them rather than
  // carry them into an operator-facing sentence verbatim.
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  const forged = 'BAD\nreview-gate: forged PROVIDER-CONTROLLED-ASSESSMENT-SECRET\x1b[31mANSI\x1b[0m'
  const error = await runReviewGate(packet(), {
    profiles,
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    buildProfileEnv: () => ({}),
    runAcpReview: async ({ profile: p }) => runnerResult(p, packet()),
    validateReview: (_review, ctx) => ctx.profile === 'oc' ? { ok: false, reason: forged } : true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }).then(() => null, e => e)
  assert.ok(error, 'a rejected validation must still block the gate')
  const attempt = error.report.attempts.find(a => a.profile === 'oc')
  assert.equal(attempt.reason, 'schema_invalid')
  // No newline, no ANSI escape, and not the forged sentence: an unsafe subject
  // is dropped entirely rather than laundered, so the sentence falls back to
  // the table's own closed text with no subject appended.
  assert.equal(attempt.failure, LANE_FAILURES.schema_invalid.text)
  assert.doesNotMatch(attempt.failure, /\n|\x1b|forged|PROVIDER-CONTROLLED/)
  const serialized = JSON.stringify(error.report)
  assert.doesNotMatch(serialized, /forged PROVIDER-CONTROLLED-ASSESSMENT-SECRET/)
})

test('F5: a clean, bounded validator subject still rides through unmodified', async () => {
  // The fix must not turn boundedReason into a blanket refusal — an ordinary
  // schema complaint from the default validator is exactly the useful half
  // this field exists to carry.
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  const error = await runReviewGate(packet(), {
    profiles,
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    buildProfileEnv: () => ({}),
    runAcpReview: async ({ profile: p }) => runnerResult(p, packet()),
    validateReview: (_review, ctx) => ctx.profile === 'oc' ? { ok: false, reason: 'invalid verdict' } : true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }).then(() => null, e => e)
  const attempt = error.report.attempts.find(a => a.profile === 'oc')
  assert.equal(attempt.failure, `${LANE_FAILURES.schema_invalid.text} (invalid verdict)`)
})

test('F7: a deterministic config/policy rejection is not told to re-run and diff a digest', async () => {
  // Every rejected stage used to collapse to `lane_failed`, whose action tells
  // the operator to re-run and compare stderrDigest. A deterministic
  // misconfiguration (the transport's own 'config' or 'policy' code) will
  // fail identically on every attempt, digest or not — this is a different,
  // more useful, reason.
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  for (const code of ['config', 'policy']) {
    const error = await runReviewGate(packet(), {
      profiles,
      planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
      buildProfileEnv: () => ({}),
      planFallback: () => ({ blocked: true, reason: 'no reserve for this probe' }),
      runAcpReview: async ({ profile: p }) => {
        if (p.id === 'oc') throw new ReviewTransportError(code, `${code} rejection`)
        return runnerResult(p, packet())
      },
      validateReview: () => true,
      synthesizeReviews: () => ({ verdict: 'PASS' }),
    }).then(() => null, e => e)
    const attempt = error.report.attempts.find(a => a.profile === 'oc')
    assert.equal(attempt.stage, code)
    assert.equal(attempt.reason, 'lane_rejected', `${code} still reads as a transient lane_failed`)
    assert.doesNotMatch(attempt.action, /re-run|compare stderrDigest/i, `${code} still tells the operator to retry`)
    // GitHub #51: the thrown error's own sentence is the ONLY field that names
    // the cause, and it was computed and then dropped by the report whitelist.
    // Measured against the real failure: three lanes returned
    // `stage: config, reason: lane_rejected, stderrBytes: 0` — the digest of the
    // empty string, because the failure happened before the child ever spoke —
    // while `bubblewrap is required for the ACP review sandbox` was thrown and
    // discarded. An hour went into rediscovering it from source.
    assert.equal(attempt.detail, `${code} rejection`, `${code} dropped the cause and kept only the category`)
  }
  // A message that could forge a report line or carry a terminal escape must not
  // ride in as `detail`. It is attacker-adjacent text like any other subject
  // here, and the sanitiser that guards the rest guards this too.
  const hostile = await runReviewGate(packet(), {
    profiles,
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    buildProfileEnv: () => ({}),
    planFallback: () => ({ blocked: true, reason: 'no reserve for this probe' }),
    runAcpReview: async ({ profile: p }) => {
      if (p.id === 'oc') throw new ReviewTransportError('config', `bad\u001b[31m\nreview-gate: forged line`)
      return runnerResult(p, packet())
    },
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }).then(() => null, e => e)
  const dropped = hostile.report.attempts.find(a => a.profile === 'oc')
  assert.equal(dropped.detail, undefined, 'a message with an escape or a newline was printed verbatim')
  assert.equal(dropped.reason, 'lane_rejected', 'dropping the detail must not change the verdict')

  // A transient stage — a slow or crashed provider — keeps the original advice.
  const transient = await runReviewGate(packet(), {
    profiles,
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    buildProfileEnv: () => ({}),
    planFallback: () => ({ blocked: true, reason: 'no reserve for this probe' }),
    runAcpReview: async ({ profile: p }) => {
      if (p.id === 'oc') throw new ReviewTransportError('timeout', 'timeout rejection')
      return runnerResult(p, packet())
    },
    validateReview: () => true,
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }).then(() => null, e => e)
  assert.equal(transient.report.attempts.find(a => a.profile === 'oc').reason, 'lane_failed')
})



test('F7: a throwing fallback planner or synthesizer still leaves a structured report, not empty stdout', async () => {
  // These are the two exported dependency-injection seams the advisor found
  // reaching the CLI with no `error.report` when they throw instead of
  // returning — a zero-byte report is exactly what this whole boundary exists
  // to prevent.
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  const plan = testPlan(['oc', 'codex', 'agy'])
  const base = {
    profiles,
    planReviewPanel: () => plan,
    buildProfileEnv: () => ({}),
    runAcpReview: async ({ profile: p }) => {
      if (p.id === 'oc') throw new ReviewTransportError('timeout', 'oc timeout')
      return runnerResult(p, packet())
    },
    validateReview: () => true,
  }
  const plannerThrew = await runReviewGate(packet(), {
    ...base,
    planFallback: () => { throw new Error('fallback planner exploded') },
    synthesizeReviews: () => ({ verdict: 'PASS' }),
  }).then(() => null, e => e)
  assert.ok(plannerThrew?.report, 'a throwing fallback planner left no report')
  assert.match(plannerThrew.message, /fallback planner threw/)
  assert.match(plannerThrew.message, /fallback planner exploded/)

  const synthesizerThrew = await runReviewGate(packet(), {
    ...base,
    runAcpReview: async ({ profile: p }) => runnerResult(p, packet()),
    synthesizeReviews: () => { throw new Error('synthesizer exploded') },
  }).then(() => null, e => e)
  assert.ok(synthesizerThrew?.report, 'a throwing synthesizer left no report')
  assert.match(synthesizerThrew.message, /review synthesizer threw/)
  assert.match(synthesizerThrew.message, /synthesizer exploded/)
})

// ---------------------------------------------------------------------------
// v0.15.0 release review (gpt-5.6-luna, anti-consensus club), CONFIRMED under
// adversarial re-verification. `provenLaunchSignature` reads `profile.args`;
// `defaultLaneRunner` used to rebuild the argv itself and never read it. Two
// lanes declaring one `command` and different `args` therefore had different
// SIGNATURES and identical LAUNCHES — the panel gate's whole job, inverted.
//
// The pre-existing lane-identity tests could not catch this: they assert
// `identity.signature === provenLaunchSignature(profile)`, which is true by
// construction because both come from one call. This one asserts what the
// runner was actually handed.
test('what a lane LAUNCHES includes its declared args, not just what its signature claims', async () => {
  const launched = []
  const withArgs = (id, family) => profile(id, {
    command: [process.execPath, MOCK],
    args: [`--profile=${id}`],
    provider: `${id}-provider`,
    family,
    displayModel: `${id}/${id}-review-model`,
  })
  const profiles = keyedProfiles([withArgs('oc', 'oc-family'), withArgs('codex', 'codex-family'), withArgs('agy', 'gemini')])
  const runner = async (call) => {
    launched.push({ lane: call.lane, command: call.command, args: call.args })
    return runnerResult(call.profile, { ...packet(), primary: 'test' })
  }
  const out = await runReviewGate({ ...packet(), primary: 'test' }, {
    profiles, runAcpReview: runner, buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    validateReview: () => ({ ok: true }), synthesizeReviews: () => ({ verdict: 'PASS' }),
  })
  assert.equal(out.ok, true, 'the fixture must pass the gate, or it proves nothing about a passing panel')
  assert.equal(launched.length, 3)
  // The point: three DISTINCT launches, matching the three distinct claims.
  // With the argv rebuilt without `args`, all three collapse to the same
  // {command, args} while the gate still returns ok:true.
  for (const call of launched) {
    assert.ok(call.args.includes(`--profile=${call.lane}`),
      `lane ${call.lane} launched without its declared args: ${JSON.stringify(call.args)}`)
  }
  assert.equal(new Set(launched.map((call) => JSON.stringify([call.command, call.args]))).size, 3,
    'three lanes certified distinct must not execute byte-identical commands')
})

// ---------------------------------------------------------------------------
// The staging DECISION, which until 2026-08-09 could only be wrong on a machine
// nobody had. These run everywhere, including the macOS host where the sandbox
// itself cannot start — which is the point. This file's own comment said "a
// guard that cannot go red is not a guard", and then left the decision itself
// behind exactly such a gate.








// ---------------------------------------------------------------------------
// Which runtimes a lane is allowed to launch. Measured on Ubuntu 26.04 on the
// first Linux run of the gate: the hand-written root list knew ~/.nvm and not
// mise, so the zai lane refused while AGY passed — and AGY passed only because
// mise happens to put bun in ~/.bun/bin, which WAS on the list. A security
// boundary where one lane works by coincidence and its neighbour does not is
// worse than one that refuses both.

test('the interpreter running this process contributes its own roots', () => {
  // Two levels, and the second is not decoration: a shim resolves through the
  // manager's version-ALIAS directory (.../installs/node/24/bin/npx) while the
  // binary itself lives under the exact version (.../installs/node/24.19.0).
  // Only the family root covers both, and dropping it is what left zai refused.
  const home = '/home/someone'
  const execPath = `${home}/.local/share/mise/installs/node/24.19.0/bin/node`
  assert.deepEqual(rootsFor(execPath, home), [
    `${home}/.local/share/mise/installs/node/24.19.0`,
    `${home}/.local/share/mise/installs/node`,
  ])
})

test('a system interpreter contributes nothing, and never the filesystem root', () => {
  // /usr/bin/node would otherwise offer up `/usr` (already trusted, harmless)
  // and `/` (which would trust the entire machine). Both must be dropped by
  // being outside $HOME, not by luck.
  assert.deepEqual(rootsFor('/usr/bin/node', '/home/someone'), [])
  assert.deepEqual(rootsFor('/usr/local/bin/node', '/home/someone'), [])
})

test('$HOME itself is never a trusted root, so a bare ~/bin interpreter adds nothing', () => {
  // An interpreter sitting directly at ~/bin/node has $HOME as its own prefix,
  // and trusting that would trust every file the user owns. It contributes
  // NOTHING rather than contributing ~/bin — which is already on the static
  // list anyway, so nothing is lost by the stricter answer.
  //
  // This assertion was written the other way round first and went red. The
  // expectation was wrong and the code was right; it is kept because the wrong
  // version is the one a reader would naturally assume.
  assert.deepEqual(rootsFor('/home/someone/bin/node', '/home/someone'), [])
})

// interpreterRoots reads process.execPath, so the cases above are expressed by
// swapping it for the duration of one call. Restored in a finally: a leaked
// execPath would corrupt every later test in this file rather than fail here.
function rootsFor(execPath, home) {
  const original = process.execPath
  try {
    Object.defineProperty(process, 'execPath', { value: execPath, configurable: true })
    return interpreterRoots(home)
  } finally {
    Object.defineProperty(process, 'execPath', { value: original, configurable: true })
  }
}

test('the derived roots reach the list the launcher actually consults', async () => {
  // Testing interpreterRoots alone proves a function, not a wiring. Deleting
  // its spread from trustedExecutableRoots was injected as a mutation and went
  // GREEN until this test existed — the same miss, twice in one day.
  //
  // The real $HOME is used because trustedExecutableRoots stats it; the
  // interpreter path is a fiction placed inside that home, which is the only
  // way to observe the wiring on a machine whose node lives in /opt.
  const home = process.env.HOME
  assert.ok(home, 'this test needs a HOME to exist')
  const fakeExec = join(home, '.local', 'share', 'mise', 'installs', 'node', '24.19.0', 'bin', 'node')
  const original = process.execPath
  let list
  try {
    Object.defineProperty(process, 'execPath', { value: fakeExec, configurable: true })
    // AWAITED INSIDE the try. trustedExecutableRoots awaits realpath() before it
    // ever reads process.execPath, so restoring in a finally that runs at the
    // first await hands the function back the real interpreter — which is how
    // this test failed on a clean tree before it was written this way.
    list = await trustedExecutableRoots({ HOME: home })
  } finally {
    Object.defineProperty(process, 'execPath', { value: original, configurable: true })
  }
  assert.ok(list.includes(join(home, '.local', 'share', 'mise', 'installs', 'node', '24.19.0')),
    `the version prefix never reached the trusted list: ${JSON.stringify(list)}`)
  assert.ok(list.includes(join(home, '.local', 'share', 'mise', 'installs', 'node')),
    `the family root never reached the trusted list: ${JSON.stringify(list)}`)
  assert.ok(list.includes('/usr'), 'the static roots must survive alongside the derived ones')
})

// ---------------------------------------------------------------------------
// Layer 3/4/5, applied 2026-08-09 on top of the two commits directly above
// this line (layer 1/2: interpreterRoots, and SANDBOX_MASKED_ROOTS plus the
// $HOME-vs-masked-root fix to needsSandboxStaging). Measured on the same
// Ubuntu 26.04 host, each fix uncovering the next: with layer 1/2 alone the
// zai lane still refused with "outside trusted runtime roots", because the
// trust check demanded BOTH the launcher path and its real file be trusted --
// and a version manager's whole point is a trusted path pointing outside its
// own directory (layer 3, below). Staged past that, the lane died with
// "Cannot find module '../lib/cli.js'", because staging copies one file and
// npx's relative require needs its neighbours (layer 4, below). And a
// present-but-refused optional CLI died at exit 127 with nothing said about
// why, because every staging failure for an optional entry was swallowed, not
// only absence (layer 5, below). None of the three has been read by a full
// three-family panel yet -- see CLAUDE.md's Release flow step 2, which calls
// this path "stronger in design, unproven in practice."
//
// `resolveExecutable` and `swallowsStagingFailure` are exported, past tense
// were not, for the same reason `sandboxStagedExecutables` already was and
// says so at its own definition: every call site below the `platform ===
// 'linux' && /usr/bin/bwrap' gate in runAcpReview is unreachable on this
// machine, and a guard that cannot go red is not a guard.

test('resolveExecutable accepts EITHER a trusted launcher path or a trusted real file, not only both', async () => {
  // The measured failure, in both directions on one machine: `npx` resolved
  // from an untrusted shim directory to a trusted real file, and `claude`
  // resolves from a trusted `~/.local/bin` to an untrusted versioned install.
  // The OLD check ORed two negations together (`!trusted(requested) ||
  // !trusted(source)`), which is AND overall -- both had to be trusted -- and
  // refused each lane by the half the other satisfied.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'review-trust-home-')))
  // `.local/bin` is one of trustedExecutableRoots' static per-HOME roots.
  const trustedDir = join(home, '.local', 'bin')
  // An ordinary $HOME subdirectory that is on no trusted-roots list at all.
  const untrustedDir = join(home, 'untrusted-shim')
  mkdirSync(trustedDir, { recursive: true })
  mkdirSync(untrustedDir, { recursive: true })

  // Case A: trusted LAUNCHER PATH, untrusted REAL FILE.
  const untrustedReal = join(untrustedDir, 'npx-real')
  writeFileSync(untrustedReal, '#!/bin/sh\necho untrusted-real\n', { mode: 0o755 })
  symlinkSync(untrustedReal, join(trustedDir, 'npx'))
  const resolvedA = await resolveExecutable('npx', { HOME: home, PATH: trustedDir })
  assert.equal(resolvedA, realpathSync(untrustedReal),
    'a trusted launcher pointing at an untrusted real file must resolve, not refuse')

  // Case B: untrusted LAUNCHER PATH, trusted REAL FILE.
  const trustedReal = join(trustedDir, 'npx-actual')
  writeFileSync(trustedReal, '#!/bin/sh\necho trusted-real\n', { mode: 0o755 })
  symlinkSync(trustedReal, join(untrustedDir, 'npx'))
  const resolvedB = await resolveExecutable('npx', { HOME: home, PATH: untrustedDir })
  assert.equal(resolvedB, realpathSync(trustedReal),
    'an untrusted launcher pointing at a trusted real file must resolve, not refuse')
})

test('resolveExecutable still refuses when NEITHER the launcher nor its real file is trusted', async () => {
  // The boundary the EITHER/OR change must not erase: accepting either half
  // is not the same as accepting everything. Kept next to the pass cases
  // above because a change that always resolves would pass those alone.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'review-trust-home-')))
  const untrustedDir = join(home, 'untrusted-shim')
  mkdirSync(untrustedDir, { recursive: true })
  const untrustedReal = join(untrustedDir, 'npx-real')
  writeFileSync(untrustedReal, '#!/bin/sh\necho untrusted\n', { mode: 0o755 })
  symlinkSync(untrustedReal, join(untrustedDir, 'npx'))
  await assert.rejects(
    resolveExecutable('npx', { HOME: home, PATH: untrustedDir }),
    error => error.code === 'config' && /outside trusted runtime roots/.test(error.message),
  )
})

// A prefix that LOOKS like a toolchain install, built on disk because
// sandboxRebindRoots now checks for `bin/` and `lib/` rather than trusting the
// shape of the string. `mkdtemp` puts it under a masked root on both platforms
// (/var on macOS, /tmp on Linux), which is the case that matters.
const installPrefix = (...extra) => {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-'))
  const prefix = join(root, 'installs', 'node', '24.19.0')
  for (const part of ['bin', 'lib', ...extra]) mkdirSync(join(prefix, part), { recursive: true })
  return prefix
}

const withExecPath = (value, body) => {
  const original = process.execPath
  try {
    Object.defineProperty(process, 'execPath', { value, configurable: true })
    return body()
  } finally {
    Object.defineProperty(process, 'execPath', { value: original, configurable: true })
  }
}













// NOT a behavioural test of `stageHomeExecutable`, and the reason is worth more
// than the test would have been. The scenario the round-7 review described — an
// executable staged from inside the target repository — cannot be reached
// through it: `resolveExecutable` throws "ACP review executable resolves inside
// the target repository" one layer earlier, measured while writing this. So the
// two-callers-disagree defect is REAL and its exploit path is closed by a
// different guard, which makes the fix correct and this consumer unreachable to
// drive. The forwarding in `stageHomeExecutable` is therefore held by the
// direct predicate test above plus that earlier refusal, and by nothing else —
// said plainly rather than covered by a test that passes for the wrong reason.

test('the advertised model is recorded as a claim, and a runner-seeded list is labelled as one', async () => {
  const unseeded = await invoke()
  assert.deepEqual(unseeded.claimedIdentity, {
    advertisedModel: 'oc-review-model',
    runnerSeeded: false,
  }, 'an adapter told nothing advertises its own value, and the receipt may say so plainly')

  // `runnerSeeded` is read off the ACT -- the env this runner was handed and
  // the settings file it wrote -- never off a restated rule, so the label
  // cannot drift from what actually happened. Both seeding routes are pinned
  // here because either one alone makes the advertisement our own words.
  const viaEnv = await invoke(profile(), {
    CLAUDE_MODEL_CONFIG: JSON.stringify({ availableModels: ['oc-review-model'] }),
  })
  assert.equal(viaEnv.claimedIdentity.runnerSeeded, true,
    'CLAUDE_MODEL_CONFIG hands the lane its model list; the receipt must not present it as the adapter\'s')

  const viaSettings = await invoke(profile('oc', {
    sessionSettings: { availableModels: ['oc-review-model'] },
  }))
  assert.equal(viaSettings.claimedIdentity.runnerSeeded, true,
    'a profile declaring sessionSettings gets .claude/settings.local.json written for it')
})

test('the identity claim reaches the panel record and decides nothing', async () => {
  const profiles = keyedProfiles([profile('oc'), profile('codex'), profile('agy')])
  const gate = runner => runReviewGate(packet(), {
    profiles,
    runAcpReview: runner,
    buildProfileEnv: () => ({}),
    planReviewPanel: () => testPlan(['oc', 'codex', 'agy']),
    validateReview: () => true,
    synthesizeReviews: (_plan, reviews) => ({ verdict: 'PASS', count: Object.keys(reviews).length }),
  })

  // THREE lanes claiming ONE identity. If the claim were counted anywhere this
  // panel would refuse itself; it passes, which is the property being pinned.
  const recorded = await gate(async ({ profile: p }) => ({
    ...runnerResult(p, packet()),
    claimedIdentity: { advertisedModel: 'one-model-for-all', runnerSeeded: true },
  }))
  assert.equal(recorded.count, 3)
  assert.deepEqual(recorded.reviews.map(item => item.claimedIdentity.advertisedModel),
    ['one-model-for-all', 'one-model-for-all', 'one-model-for-all'])
  assert.deepEqual(recorded.reviews.map(item => item.claimedIdentity.runnerSeeded),
    [true, true, true])

  // A lane that offers no claim is recorded as having none, not dropped: a
  // missing field and a field reading `null` are different receipts.
  const silent = await gate(async ({ profile: p }) => runnerResult(p, packet()))
  assert.deepEqual(silent.reviews.map(item => item.claimedIdentity), [null, null, null])
})

test('a remote protocol error says what the remote said, redacted and on one line', async () => {
  // Added 2026-08-13. The zai lane's `session/new` failure had been
  // undiagnosable for five days — "ACP session/new failed with a remote protocol
  // error", `stderrBytes: 0`, and an empty `error.cause`. Measured (2026-08) on the then-sandboxed
  // host that day: the adapter WAS answering. The reject threw `msg.error` away,
  // so an operator following the issue's own advice and running the lane alone
  // learned nothing the panel had not already told them.
  //
  // Provider bytes are untrusted, so this asserts both halves at once: the
  // detail arrives, AND it cannot be used to smuggle a secret or a second line.
  await assert.rejects(
    invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: 'session-new-remote-error' }),
    (error) => {
      assert.equal(error.code, 'protocol')
      assert.match(error.message, /remote code -32603/)
      assert.match(error.message, /upstream refused/)
      assert.match(error.message, /Invalid value for config option model/,
        'data.details carries the only useful sentence some adapters send')
      assert.equal(error.message.includes('AKIA'), false,
        'only named string fields may be read out of the remote error object')
      assert.equal(error.message.includes('hunter2'), false, 'the remote error leaked a credential')
      assert.equal(/[\r\n]/.test(error.message), false, 'the remote error spanned more than one line')
      assert.ok(error.message.length < 400, `remote detail was not bounded (${error.message.length} chars)`)
      return true
    },
  )
})

test('a review carrying credential-shaped text is redacted and kept, not discarded', async () => {
  // These three used to be `assert.rejects(..., code === 'review')`. They were
  // changed on 2026-08-13 after a real run on the then-sandboxed host threw away a COMPLETE
  // AGY review of a diff about an environment-variable allowlist: `sensitiveName`
  // matches any identifier containing token/auth/secret, one pattern fires on
  // `NAME:`, and a reviewer writing `CLAUDE_CODE_MAX_OUTPUT_TOKENS: raise this`
  // lost its whole document. The inbound packet was always redacted rather than
  // refused; the outbound review now matches.
  //
  // The security property is what these assertions are for, and it is unchanged:
  // the secret must be GONE. The change is only that the review survives beside
  // it, and that the caller is told the document was touched.
  for (const [behaviour, secret] of [
    ['escaped-secret-review', 'abcdefghijklmnopqrstuvwxyz123456'],
    ['plain-secret-review', 'hunter2'],
    ['url-secret-review', 'supersecret'],
  ]) {
    const out = await invoke(profile('oc'), { MOCK_REVIEW_BEHAVIOUR: behaviour })
    assert.equal(out.reviewRedacted, true, `${behaviour}: the caller was not told the review was redacted`)
    const serialized = JSON.stringify(out.review)
    assert.equal(serialized.includes(secret), false, `${behaviour}: the secret survived into the accepted review`)
    assert.match(serialized, /\[REDACTED\]/, `${behaviour}: nothing was marked as redacted`)
    assert.equal(out.review.verdict, 'PASS', `${behaviour}: the review itself was lost`)
  }
})

test('lanes that stop at one stage for different reasons are not announced as one shared precondition', async () => {
  // Round 8, codex. #51 taught the gate to say "one missing thing" when every
  // lane died at the same deterministic stage — and it said it whether or not
  // the lanes agreed. A missing review executable, an unreachable endpoint and an
  // unacknowledged ACP setting all stop at `config`; the operator was told to
  // look for one precondition behind three unrelated faults.
  //
  // `detail` is what discriminates, not `reason`: `reason` is derived from the
  // stage, so every deterministic-stage failure is `lane_rejected` and it can
  // never disagree when the stage agrees. A guard written on `reason` here
  // could not have gone red.
  // A REAL packet file, because the CLI opens it before it ever calls `gate` —
  // the first version of this test passed a bare name, died at ENOENT, and
  // asserted against a sentence the code under test never produced.
  const packetPath = join(mkdtempSync(join(tmpdir(), 'gate-cause-')), 'packet.json')
  writeFileSync(packetPath, JSON.stringify({ objective: 'x', acceptance: ['y'], brief: 'z' }))
  const stderrFor = async (attempts) => {
    const lines = []
    await runReviewGateCli([packetPath, '/abs/target'], {
      gate: async () => { throw Object.assign(new Error('blocked'), { report: { attempts } }) },
      stdout: { write: () => {} },
      stderr: { write: (line) => lines.push(line) },
    })
    return lines.join('')
  }
  const lane = (profile, detail) => ({ status: 'failed', profile, stage: 'config', reason: 'lane_rejected', detail })

  const differing = await stderrFor([
    lane('kimi', 'no review executable on PATH'),
    lane('zai', 'review executable not found'),
    lane('agy', 'the configured model was never acknowledged'),
  ])
  assert.match(differing, /3 different reasons/, `three unrelated faults were not called out as such:\n${differing}`)
  assert.doesNotMatch(differing, /one shared precondition, not one fault/,
    `the gate still claimed one shared precondition over three causes:\n${differing}`)
  // The per-lane sentences are what the operator acts on, so they must survive.
  for (const cause of ['no review executable on PATH', 'review executable not found', 'never acknowledged']) {
    assert.ok(differing.includes(cause), `${cause} never reached the operator:\n${differing}`)
  }

  const shared = await stderrFor([
    lane('kimi', 'review executable not found'),
    lane('zai', 'review executable not found'),
    lane('agy', 'review executable not found'),
  ])
  assert.match(shared, /one shared precondition, not one fault per profile/,
    `the #51 sentence stopped being said when it was true:\n${shared}`)
})
