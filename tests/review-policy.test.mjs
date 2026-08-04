import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REVIEW_PROFILES, ROUTED_PROFILES, assertAdapterPackageBoundToCommand, assertPermittedModel, buildAcpLaunch,
  buildProfileEnv, loadProfileSettings, normalizePrimaryFamily, provenFamilyCollision, provenFamilyKey,
  validateRoutedEndpoint,
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

// The negative control for the rule, not a restatement of the pin. Asserting
// that `agy.model` equals the right string is what the suite already did while
// the string was the forbidden one — a value test cannot tell a pin from a
// violation. These cases fail if the guard stops rejecting Gemini 3.1.
test('a Gemini 3.1 reviewer model is refused rather than run', () => {
  for (const name of [
    'gemini-3.1-pro-high', 'gemini-3.1-pro', 'Gemini 3.1', 'agy/gemini_3.1-flash',
  ]) {
    assert.throws(() => assertPermittedModel(name, 'probe'), /Gemini 3\.1 is prohibited/, name)
  }
  for (const name of ['gemini-3.6-flash-high', 'gemini-3.10-pro', 'gpt-5.6-sol', null]) {
    assert.equal(assertPermittedModel(name, 'probe'), name)
  }
  for (const profile of Object.values(REVIEW_PROFILES)) {
    assert.doesNotThrow(() => assertPermittedModel(profile.config?.model, profile.id))
  }
})

test('immutable ACP profiles pin providers, models, argv, and AGY plan mode', () => {
  assert.ok(Object.isFrozen(REVIEW_PROFILES))
  assert.deepEqual(REVIEW_PROFILES.agy.command, ['bunx', 'antigravity-acp@1.0.0'])
  assert.deepEqual(REVIEW_PROFILES.kimi.command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'])
  assert.deepEqual(REVIEW_PROFILES.zai.command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'])
  assert.deepEqual(REVIEW_PROFILES.qwen.command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'])
  assert.deepEqual(REVIEW_PROFILES.claude.command, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'])
  assert.deepEqual(REVIEW_PROFILES.codex.command, ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.7'])
  assert.deepEqual(REVIEW_PROFILES.agy.config, { model: 'gemini-3.6-flash-high', mode: 'plan' })
  assert.deepEqual(REVIEW_PROFILES.kimi.config, { model: 'opus', mode: 'plan' })
  assert.equal(REVIEW_PROFILES.kimi.displayModel, 'kimi/opus')
  assert.deepEqual(REVIEW_PROFILES.qwen.config, { model: 'qwen3.8-max-preview', mode: 'plan' })
  assert.equal(REVIEW_PROFILES.qwen.displayModel, 'qwen/qwen3.8-max-preview')
  // A routed lane's family label is backed by a parent-verified endpoint pin.
  assert.equal(REVIEW_PROFILES.zai.endpoint.host, 'api.z.ai')
  assert.equal(REVIEW_PROFILES.qwen.endpoint.host, 'token-plan.ap-southeast-1.maas.aliyuncs.com')
  assert.equal(REVIEW_PROFILES.zai.claudeExecutable, 'claude-zai')
  assert.equal(REVIEW_PROFILES.qwen.claudeExecutable, 'claude-qwen')
  assert.equal(REVIEW_PROFILES.claude.claudeExecutable, undefined)
  assert.deepEqual(REVIEW_PROFILES.zai.config, { model: 'glm-5.2', mode: 'default' })
  assert.equal(REVIEW_PROFILES.zai.thinkingBudgetTokens, 4096)
  assert.deepEqual(REVIEW_PROFILES.codex.config, {
    model: 'gpt-5.6-sol',
    reasoning_effort: 'ultra',
    mode: 'read-only',
    collaboration_mode: 'plan',
  })
  // Plan mode everywhere EXCEPT one named lane. glm-5.2 cannot hold plan mode
  // and the JSON-only protocol at once, so zai declares `default` — and that
  // exception is written here, by name, because a blanket `every()` would have
  // gone green the day a second lane quietly downgraded itself. What kept plan
  // mode safe is enforced separately and still applies to zai: no MCP servers,
  // every permission request denied, a run that observed a tool call refused.
  for (const [id, profile] of Object.entries(REVIEW_PROFILES)) {
    assert.equal(profile.reviewMode, id === 'zai' ? 'default' : 'plan', `${id} review mode`)
  }
})

test('primary normalization is robust and blocks Gemini/unknown primaries', () => {
  const cases = [
    [' GPT-5.6-sol ', 'openai'], [{ provider: 'Anthropic', model: 'x' }, 'claude'],
    ['kimi-k3', 'kimi'], ['claude-kimi', 'kimi'], ['claude-qwen', 'qwen'], ['claude-zai', 'zai'],
    ['qwen3.8-max-preview', 'qwen'],
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
  assert.equal(normalizePrimaryFamily('claude-qwen acp'), 'qwen')
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
  assert.match(planFallback(openai, 'qwen').reason, /duplicate/)
  assert.match(planFallback(openai, 'zai').reason, /retry/)

  const kimi = createReviewPlan('kimi')
  assert.match(planFallback(kimi, 'codex').reason, /duplicate/)
  assert.match(planFallback(kimi, 'zai').reason, /retry/)

  const zai = createReviewPlan('zai')
  assert.match(planFallback(zai, 'codex').reason, /diversity/)
  assert.match(planFallback(zai, 'qwen').reason, /diversity/)

  const claude = createReviewPlan('claude')
  for (const failed of ['codex', 'qwen']) {
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
  assert.equal(synthesizeReviews(plan, { agy: pass, qwen: pass }).verdict, 'BLOCKED')
  const results = synthesizeReviews(plan, { agy: pass, qwen: pass, zai: { ...pass, reviewer: 'forged' } })
  assert.equal(results.verdict, 'BLOCKED')
})

test('two matching fingerprints are must-fix; unique objections remain residual', () => {
  const plan = createReviewPlan('openai')
  const shared = finding()
  assert.equal(findingFingerprint(shared), findingFingerprint({ ...shared, summary: 'different prose' }))
  const result = synthesizeReviews(plan, {
    agy: { ...pass, verdict: 'OBJECTIONS', findings: [shared] },
    qwen: { ...pass, verdict: 'OBJECTIONS', findings: [{ ...shared, evidence: 'Independent trace confirms it.' }, finding({ criterion_id: 'AC-2', location: 'b:1' })] },
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
    agy: { ...pass, verdict: 'OBJECTIONS', findings: [finding()] }, codex: pass, qwen: pass,
  })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.residualObjections.length, 1)
  assert.equal(synthesizeReviews(plan, { agy: pass, codex: blocked, qwen: pass }).verdict, 'BLOCKED')
})

test('two unrelated objections remain residual PM judgments rather than becoming consensus blockers', () => {
  const plan = createReviewPlan('openai')
  const result = synthesizeReviews(plan, {
    agy: {
      ...pass,
      verdict: 'OBJECTIONS',
      findings: [finding({ criterion_id: 'AC-A', location: 'packet:a' })],
    },
    qwen: {
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
    qwen: pass,
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
  // A lane that does not route: its whole env is the allowlist plus its own
  // provider secret. Qwen and Zai route through settings files, which is a
  // different contract — see the routing tests below.
  const env = buildProfileEnv('codex', source)
  assert.deepEqual(env, {
    PATH: '/bin',
    LANG: 'C',
    OPENAI_API_KEY: 'openai',
  })
  const launch = buildAcpLaunch('agy', {
    env: { ...source, AGY_BIN: '/evil/agy' },
    settingsLoader: () => ({ mode: 'unsafe', transport: 'acp' }),
    agyBinaryResolver: () => '/trusted/agy',
  })
  assert.deepEqual(launch.command, ['bunx', 'antigravity-acp@1.0.0'])
  assert.deepEqual(launch.settings, { mode: 'plan', transport: 'acp', model: 'gemini-3.6-flash-high' })
  assert.equal(launch.env.AGY_BIN, '/trusted/agy')
  assert.equal(launch.env.AGY_SKIP_DOWNLOAD, '1')
  assert.throws(() => loadProfileSettings('agy', () => 'bad'), /must return an object/)
})

test('Zai routing loads only allowlisted endpoint credentials from its explicit settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'review-profile-'))
  const settingsDir = join(home, '.config', 'claude-profiles', 'zai')
  mkdirSync(settingsDir, { recursive: true })
  const file = join(settingsDir, 'settings.json')
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
  ]) assert.throws(invalidEndpoint(endpoint), /zai review endpoint/)
})

test('Qwen routing uses Claude ACP with its local profile settings and pinned endpoint', () => {
  const home = mkdtempSync(join(tmpdir(), 'review-profile-qwen-'))
  const settingsDir = join(home, '.config', 'claude-profiles', 'qwen')
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, 'settings.json'), '{}')
  const env = buildProfileEnv('qwen', { HOME: home, PATH: '/bin' }, {
    settingsLoader: () => ({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'qwen-token',
        ANTHROPIC_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
        UNRELATED_SECRET: 'must-not-pass',
      },
    }),
  })
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'qwen-token')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic')
  assert.equal(env.UNRELATED_SECRET, undefined)
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, 'claude-qwen')
  assert.equal(env.CLAUDE_MODEL_CONFIG, '{"availableModels":["qwen3.8-max-preview"]}')
  for (const endpoint of [
    'http://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    'https://example.invalid/apps/anthropic',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic?redirect=other',
  ]) {
    assert.throws(
      () => buildProfileEnv('qwen', { HOME: home, PATH: '/bin' }, {
        settingsLoader: () => ({ env: {
          ANTHROPIC_AUTH_TOKEN: 'qwen-token', ANTHROPIC_BASE_URL: endpoint,
        } }),
      }),
      /qwen review endpoint/,
    )
  }
})

test('CLAUDE_CODE_EXECUTABLE is gate-owned, but that alone does not prove the family (issue #38)', () => {
  // This test used to claim (in its own title) that pinning the env VAR NAME
  // stops kimi from becoming the same seat as claude. It never actually
  // checked that -- it only checked the name survives a caller override,
  // which is real but proves nothing about what `claude-kimi` resolves to on
  // PATH or what that binary does once exec'd. Nothing in review-profiles.mjs
  // or acp-review-client.mjs reads its realpath, hashes it, or observes the
  // endpoint it reaches. The corrected claim is below: provenFamilyKey
  // honestly buckets kimi with bare claude rather than asserting a
  // distinction this layer cannot back up.
  // kimi is a routed lane now, so its env comes from the machine-local settings
  // file — the source needs a HOME for that to resolve at all.
  const source = { PATH: '/bin', HOME: process.env.HOME, KIMI_API_KEY: 'kimi', CLAUDE_CODE_EXECUTABLE: '/tmp/evil-claude' }
  const env = buildProfileEnv('kimi', source)
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, 'claude-kimi', 'the caller re-pointed the lane')
  assert.equal(env.CLAUDE_MODEL_CONFIG, '{"availableModels":["opus"]}')
  assert.equal(buildProfileEnv('claude', { PATH: '/bin' }).CLAUDE_CODE_EXECUTABLE, undefined)
})

test('provenFamilyKey honestly buckets kimi with bare claude, and the gate refuses that panel (issue #38)', () => {
  // Real, shipped production profiles -- not synthetic test doubles -- so this
  // is not a tautology against a table invented to match the code under test.
  // Master, 2026-08-04: `claude-kimi` reaches K3 and bare `claude` reaches opus,
  // so they ARE different families — the defect was that nothing proved it. Kimi
  // is pinned now (api.kimi.com/coding, verified by the parent before spawn), so
  // the honest answer changed from "indistinguishable" to "distinct, and here is
  // why". Bare claude stays unrouted because nothing pins IT.
  assert.notEqual(provenFamilyKey(REVIEW_PROFILES.claude), provenFamilyKey(REVIEW_PROFILES.kimi),
    'kimi is endpoint-pinned; bare claude is not, so they no longer share one key')
  assert.match(provenFamilyKey(REVIEW_PROFILES.kimi), /::pinned:api\.kimi\.com\/coding$/)
  assert.notEqual(provenFamilyKey(REVIEW_PROFILES.zai), provenFamilyKey(REVIEW_PROFILES.kimi),
    'two pinned lanes on one adapter are told apart by their endpoints')
  assert.notEqual(provenFamilyKey(REVIEW_PROFILES.agy), provenFamilyKey(REVIEW_PROFILES.kimi),
    'agy runs a wholly different adapter package')
  assert.equal(provenFamilyKey({ id: 'no-adapter-declared' }), null,
    'a profile that declares nothing is reported unknown, never proven')

  // The literal attack from issue #38: a panel that would seat both kimi and
  // claude, satisfying declared-family diversity while sharing one unproven
  // identity, is refused as a collision rather than accepted as three voices.
  // Was `true` while kimi was unpinned. Now they are provably different lanes,
  // so refusing this panel would be the OTHER failure — a gate that blocks a
  // genuinely diverse panel (AGY raised exactly that risk).
  assert.equal(provenFamilyCollision([REVIEW_PROFILES.kimi, REVIEW_PROFILES.claude, REVIEW_PROFILES.agy]), false)
  // Today's real, legitimate `openai` route (qwen + zai + agy) is NOT flagged:
  // both routed profiles have different parent-verified endpoint pins.
  assert.equal(provenFamilyCollision([REVIEW_PROFILES.qwen, REVIEW_PROFILES.zai, REVIEW_PROFILES.agy]), false)
  // Two profiles that BOTH resolve to no key at all (no `adapterPackage`)
  // are no longer given a free pass. The pre-fix code filtered every unresolved
  // key out before checking uniqueness, so "declares nothing" and "declares
  // nothing" read as two pieces of *distinct* evidence rather than none at
  // all — the second bypass from issue #38's follow-up review (omit or
  // misspell the identifying field on two lanes and the panel passed with no
  // identity evidence whatsoever). Nothing can prove two unidentifiable lanes
  // are different upstreams, so this is now a collision, not a shrug.
  assert.equal(provenFamilyCollision([{ id: 'x' }, { id: 'y' }, REVIEW_PROFILES.agy]), true)
  // A single unresolved profile beside two DISTINCT, resolved ones is still
  // fine: one unknown has nothing else unknown to compare itself against.
  assert.equal(provenFamilyCollision([{ id: 'x' }, REVIEW_PROFILES.kimi, REVIEW_PROFILES.zai]), false)

  // Every real ROUTES panel used today must still clear the new check -- this
  // is the regression guard: the fix must not have narrowed today's actual,
  // legitimate routing.
  for (const primary of Object.keys(ROUTES)) {
    const plan = createReviewPlan(primary)
    assert.equal(plan.blocked, false, `${primary} route was blocked by the new check`)
  }
})

test('provenFamilyKey never reports pinned for endpoint-shaped metadata that was never registered or validated (issue #38 follow-up)', () => {
  // r2-codex2's bypass 4: the pre-fix key read `profile.endpoint`'s shape
  // alone, so a profile could claim "pinned" without ever having been
  // through `validateRoutedEndpoint` -- either because it declares
  // endpoint-shaped metadata while never being registered in
  // `ROUTED_PROFILES`, or because `ROUTED_PROFILES` was mutated after import
  // to drop a lane that WAS registered (it is an ordinary Set, and
  // `Object.freeze` does not stop `.add`/`.delete` on one).
  const unregisteredButEndpointShaped = {
    id: 'shadow-zai', adapterPackage: REVIEW_PROFILES.zai.adapterPackage,
    endpoint: REVIEW_PROFILES.zai.endpoint,
  }
  assert.notEqual(provenFamilyKey(unregisteredButEndpointShaped), null,
    'a profile with a declared adapterPackage still resolves to *a* key')
  assert.doesNotMatch(provenFamilyKey(unregisteredButEndpointShaped), /pinned:/,
    'declaring endpoint shape alone, without ROUTED_PROFILES registration, must not read as verified')

  // The other half: mutating the real `ROUTED_PROFILES` after import to drop
  // a registered lane, exercised against the live Set `provenFamilyKey`
  // actually reads, then restored immediately so no other test in this file
  // observes the mutation.
  assert.equal(ROUTED_PROFILES.has('zai'), true, 'zai starts registered')
  assert.match(provenFamilyKey(REVIEW_PROFILES.zai), /pinned:/, 'and its key reads pinned while it is')
  ROUTED_PROFILES.delete('zai')
  try {
    assert.doesNotMatch(provenFamilyKey(REVIEW_PROFILES.zai), /pinned:/,
      'deregistering the lane must drop the pinned claim too, not just skip the env-building side')
  } finally {
    ROUTED_PROFILES.add('zai')
  }
})

test('adapterPackage is bound to command for every shipped profile, and the binder catches drift (issue #38 follow-up, bypass 3)', () => {
  // r2-qwen's LOW finding 10 and r2-codex2's bypass 3, same root cause:
  // `adapterPackage` is a separate, hand-maintained copy of what `command`
  // actually launches, and nothing bound the two together. Every shipped
  // profile must satisfy the binder today...
  for (const p of Object.values(REVIEW_PROFILES)) {
    assert.doesNotThrow(() => assertAdapterPackageBoundToCommand(p), `${p.id} adapterPackage must appear in its own command`)
  }
  // ...and the binder is not a tautology: it actually rejects a profile
  // whose `adapterPackage` no longer appears in its `command` (the "bump the
  // pinned version, forget the label" and "declare a different label over
  // the same command" drift both reviews described).
  assert.throws(
    () => assertAdapterPackageBoundToCommand({ id: 'drifted', command: [...REVIEW_PROFILES.kimi.command], adapterPackage: 'not-the-real-package-name' }),
    /adapterPackage "not-the-real-package-name" is not the command's final argument/,
  )
  assert.throws(
    () => assertAdapterPackageBoundToCommand({ id: 'stale-bump', command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.62.0'], adapterPackage: REVIEW_PROFILES.kimi.adapterPackage }),
    /is not the command's final argument/,
  )
})

test('a routed lane that pins no endpoint is refused rather than trusted', () => {
  // The failure mode this closes is a future one: someone adds a third routed
  // lane, copies the settings-file plumbing, forgets the pin, and the panel
  // starts counting a family nobody verified. Refusing beats defaulting.
  const unpinned = { ...REVIEW_PROFILES.zai }
  delete unpinned.endpoint
  assert.throws(
    () => validateRoutedEndpoint(unpinned, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }),
    /zai review routes its provider but pins no endpoint/,
  )
})
