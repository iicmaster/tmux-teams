import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REVIEW_PROFILES, buildAcpLaunch, buildProfileEnv, loadProfileSettings, normalizePrimaryFamily,
} from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'
import {
  ROUTES, UNAVAILABLE_RESERVE_SUBSTITUTES, createReviewPlan, findingFingerprint, planFallback, synthesizeReviews, validateReviewOutput,
} from '../plugins/tmux-teams/skills/party-mode/scripts/review-policy.mjs'

const finding = (overrides = {}) => ({
  criterion_id: 'AC-1', category: 'correctness', location: 'src/a.mjs:7',
  summary: 'Missing guard', evidence: 'The branch reaches the mutation without validation.', blocking: true,
  ...overrides,
})
const pass = {
  schema_version: 1,
  verdict: 'PASS',
  assessment: 'All supplied acceptance criteria and evidence were checked.',
  findings: [],
  residual_risks: [],
}
const blocked = {
  schema_version: 1,
  verdict: 'BLOCKED',
  assessment: 'The static packet lacks the evidence required for a review.',
  findings: [],
  residual_risks: ['No live-service behavior was included in the packet.'],
}
const object = (entries) => Object.fromEntries(entries)

test('immutable ACP profiles pin providers, models, argv, and AGY plan mode', () => {
  assert.ok(Object.isFrozen(REVIEW_PROFILES))
  assert.deepEqual(REVIEW_PROFILES.agy.command, ['bunx', 'antigravity-acp@1.0.0'])
  assert.deepEqual(REVIEW_PROFILES.kimi.command, ['kimi', 'acp'])
  assert.deepEqual(REVIEW_PROFILES.zai.command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'])
  assert.deepEqual(REVIEW_PROFILES.claude.command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'])
  assert.deepEqual(REVIEW_PROFILES.codex.command, ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.7'])
  assert.deepEqual(REVIEW_PROFILES.agy.config, { model: 'gemini-3.1-pro-high', mode: 'plan' })
  assert.deepEqual(REVIEW_PROFILES.kimi.config, { model: 'kimi-code/k3', mode: 'plan' })
  assert.equal(REVIEW_PROFILES.kimi.displayModel, 'kimi/k3')
  assert.deepEqual(REVIEW_PROFILES.zai.config, { model: 'glm-5.2', mode: 'plan' })
  assert.equal(REVIEW_PROFILES.zai.thinkingBudgetTokens, 4096)
  assert.deepEqual(REVIEW_PROFILES.codex.config, {
    model: 'gpt-5.6-sol',
    reasoning_effort: 'ultra',
    mode: 'read-only',
    collaboration_mode: 'plan',
  })
  assert.ok(Object.values(REVIEW_PROFILES).every(profile => profile.reviewMode === 'plan'))
})

test('primary normalization is robust and blocks Gemini/unknown primaries', () => {
  const cases = [
    [' GPT-5.6-sol ', 'openai'], [{ provider: 'Anthropic', model: 'x' }, 'claude'],
    ['kimi-k3', 'kimi'], ['claude-kimi', 'kimi'], ['claude-zai', 'zai'],
    ['GLM-5.2', 'zai'], ['google-antigravity', 'gemini'], ['?', 'unknown'],
  ]
  for (const [input, expected] of cases) assert.equal(normalizePrimaryFamily(input), expected)
  for (const input of ['gemini', 'agy', 'mystery']) assert.equal(createReviewPlan(input).blocked, true)
  const conflicting = createReviewPlan({ family: 'openai', model: 'gemini-3.1-pro' })
  assert.equal(conflicting.blocked, true)
  assert.match(conflicting.reason, /conflicting primary families/)
})

test('mixed-family text in one primary field fails closed instead of selecting the first match', () => {
  for (const primary of [
    'gpt-5.6 claude-opus-4-8',
    'codex+claude',
    'kimi-code/k3 + glm-5.2',
  ]) {
    assert.equal(normalizePrimaryFamily(primary), 'unknown')
    assert.equal(createReviewPlan({ primary }).blocked, true)
  }
  assert.equal(normalizePrimaryFamily('claude-kimi acp'), 'kimi')
  assert.equal(normalizePrimaryFamily('claude-zai-acp'), 'zai')
})

test('each deterministic route yields exactly three distinct non-primary families with AGY final', () => {
  for (const [primary, route] of Object.entries(ROUTES)) {
    const plan = createReviewPlan(primary)
    assert.equal(plan.blocked, false)
    assert.equal(plan.reviewers.length, 3)
    assert.equal(plan.reviewers.at(-1), 'agy')
    assert.deepEqual(new Set(plan.reviewers), new Set(route.reviewers))
    const families = plan.reviewers.map(id => REVIEW_PROFILES[id].family)
    assert.equal(new Set(families).size, 3)
    assert.ok(families.every(family => family !== primary))
  }
})

test('fallback routes unavailable direct Claude through claude-zai only when all panel invariants hold', () => {
  assert.deepEqual(UNAVAILABLE_RESERVE_SUBSTITUTES, { claude: 'zai' })
  const openai = createReviewPlan('openai')
  assert.match(planFallback(openai, 'kimi').reason, /duplicate/)
  assert.match(planFallback(openai, 'zai').reason, /retry/)

  const kimi = createReviewPlan('kimi')
  assert.match(planFallback(kimi, 'codex').reason, /duplicate/)
  assert.match(planFallback(kimi, 'zai').reason, /retry/)

  const zai = createReviewPlan('zai')
  assert.match(planFallback(zai, 'codex').reason, /diversity/)
  assert.match(planFallback(zai, 'kimi').reason, /diversity/)

  const claude = createReviewPlan('claude')
  for (const failed of ['codex', 'kimi']) {
    const redirected = planFallback(claude, failed)
    assert.equal(redirected.blocked, false)
    assert.deepEqual(redirected.reviewers, claude.reviewers.map(id => id === failed ? 'zai' : id))
    assert.deepEqual(redirected.replaced, { failed, replacement: 'zai' })
    assert.equal(redirected.reviewers.includes('claude'), false)
  }
  assert.equal(planFallback(openai, 'agy').blocked, true)
  assert.equal(planFallback(openai, 'nope').blocked, true)
})

test('closed bounded schema rejects metadata, malformed findings, and invalid verdict combinations', () => {
  assert.equal(validateReviewOutput(pass).ok, true)
  const cases = [
    { ...pass, findings: [finding()] }, { ...pass, verdict: 'OBJECTIONS' },
    { ...blocked, findings: [finding()] }, { ...pass, verdict: 'OBJECTIONS', findings: [finding({ extra: 'no' })] },
    { ...pass, verdict: 'OBJECTIONS', findings: [finding({ evidence: ' x' })] },
    { ...pass, verdict: 'OBJECTIONS', findings: Array.from({ length: 33 }, () => finding()) },
    { verdict: 'PASS', findings: [], reviewer: 'forged' },
    { ...pass, assessment: 'too short' },
    { ...pass, schema_version: 2 },
    { ...pass, verdict: 'OBJECTIONS', findings: [finding({ category: 'banana' })] },
  ]
  for (const candidate of cases) assert.equal(validateReviewOutput(candidate).ok, false)
})

test('synthesis requires exactly three planned reviews and ignores model-returned metadata', () => {
  const plan = createReviewPlan('openai')
  assert.equal(synthesizeReviews(plan, { agy: pass, kimi: pass }).verdict, 'BLOCKED')
  const results = synthesizeReviews(plan, { agy: pass, kimi: pass, zai: { ...pass, reviewer: 'forged' } })
  assert.equal(results.verdict, 'BLOCKED')
})

test('two matching fingerprints are must-fix; unique objections remain residual', () => {
  const plan = createReviewPlan('openai')
  const shared = finding()
  assert.equal(findingFingerprint(shared), findingFingerprint({ ...shared, summary: 'different prose' }))
  const result = synthesizeReviews(plan, {
    agy: { ...pass, verdict: 'OBJECTIONS', findings: [shared] },
    kimi: { ...pass, verdict: 'OBJECTIONS', findings: [{ ...shared, evidence: 'Independent trace confirms it.' }, finding({ criterion_id: 'AC-2', location: 'b:1' })] },
    zai: pass,
  })
  assert.equal(result.verdict, 'OBJECTIONS')
  assert.equal(result.mustFix.length, 1)
  assert.equal(result.mustFix[0].reviewers.length, 2)
  assert.equal(result.residualObjections.length, 1)
})

test('two PASS reviews can pass with a unique objection, while a BLOCKED lane blocks the panel', () => {
  const plan = createReviewPlan('claude')
  const result = synthesizeReviews(plan, {
    agy: { ...pass, verdict: 'OBJECTIONS', findings: [finding()] }, codex: pass, kimi: pass,
  })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.residualObjections.length, 1)
  assert.equal(synthesizeReviews(plan, { agy: pass, codex: blocked, kimi: pass }).verdict, 'BLOCKED')
})

test('two unrelated objections remain residual PM judgments rather than becoming consensus blockers', () => {
  const plan = createReviewPlan('openai')
  const result = synthesizeReviews(plan, {
    agy: {
      ...pass,
      verdict: 'OBJECTIONS',
      findings: [finding({ criterion_id: 'AC-A', location: 'packet:a' })],
    },
    kimi: {
      ...pass,
      verdict: 'OBJECTIONS',
      findings: [finding({ criterion_id: 'AC-B', location: 'packet:b' })],
    },
    zai: pass,
  })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.passCount, 1)
  assert.equal(result.mustFix.length, 0)
  assert.equal(result.residualObjections.length, 2)
  assert.equal(result.requiresPmJudgment, true)
})

test('duplicate copies of one reviewer finding never count as two independent votes', () => {
  const plan = createReviewPlan('openai')
  const duplicate = finding()
  const result = synthesizeReviews(plan, {
    agy: { ...pass, verdict: 'OBJECTIONS', findings: [duplicate, { ...duplicate }] },
    kimi: pass,
    zai: pass,
  })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.mustFix.length, 0)
  assert.deepEqual(result.residualObjections[0].reviewers, ['agy'])
})

test('environment is allowlisted, provider-scoped, and launch settings are injectable but cannot unpin', () => {
  const source = {
    PATH: '/bin', LANG: 'C', ACP_CMD: 'evil', AGY_EXTRA_ARGS: '--evil', NODE_OPTIONS: '--require evil',
    LD_PRELOAD: 'evil.so', OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'claude', KIMI_API_KEY: 'kimi', ZAI_API_KEY: 'zai',
  }
  const env = buildProfileEnv('kimi', source)
  assert.deepEqual(env, {
    PATH: '/bin',
    LANG: 'C',
    KIMI_API_KEY: 'kimi',
  })
  const launch = buildAcpLaunch('agy', {
    env: { ...source, AGY_BIN: '/evil/agy' },
    settingsLoader: () => ({ mode: 'unsafe', transport: 'acp' }),
    agyBinaryResolver: () => '/trusted/agy',
  })
  assert.deepEqual(launch.command, ['bunx', 'antigravity-acp@1.0.0'])
  assert.deepEqual(launch.settings, { mode: 'plan', transport: 'acp', model: 'gemini-3.1-pro-high' })
  assert.equal(launch.env.AGY_BIN, '/trusted/agy')
  assert.equal(launch.env.AGY_SKIP_DOWNLOAD, '1')
  assert.throws(() => loadProfileSettings('agy', () => 'bad'), /must return an object/)
})

test('Zai routing loads only allowlisted endpoint credentials from its explicit settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'review-profile-'))
  const settingsDir = join(home, '.claude')
  mkdirSync(settingsDir)
  const file = join(settingsDir, 'settings-zai.json')
  writeFileSync(file, '{}')
  const env = buildProfileEnv('zai', { HOME: home, PATH: '/bin' }, {
    settingsLoader: () => ({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'zai-token',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        UNRELATED_SECRET: 'must-not-pass',
      },
      permissions: { allow: ['*'] },
    }),
  })
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'zai-token')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(env.UNRELATED_SECRET, undefined)
  assert.equal(env.CLAUDE_MODEL_CONFIG, '{"availableModels":["glm-5.2"]}')
  assert.equal(env.MAX_THINKING_TOKENS, '4096')
  const invalidEndpoint = ANTHROPIC_BASE_URL => () => buildProfileEnv('zai', { HOME: home, PATH: '/bin' }, {
    settingsLoader: () => ({
      env: { ANTHROPIC_AUTH_TOKEN: 'zai-token', ANTHROPIC_BASE_URL },
    }),
  })
  for (const endpoint of [
    'http://api.z.ai/api/anthropic',
    'https://example.invalid/api/anthropic',
    'https://user:password@api.z.ai/api/anthropic',
    'https://api.z.ai/api/anthropic?redirect=other',
  ]) assert.throws(invalidEndpoint(endpoint), /Zai review endpoint/)
})
