// Self-check for the 2026-11-17 seat change: the three review lanes run their
// bmad-party-mode round-table through an advisor skill, and are distinct by
// ACKNOWLEDGED MODEL (so opencode's free ladder can seat three real models).
// Master 2026-11-18: the ladder is TEN free seats deep and the reserve walk
// hops rung by rung, accumulating `failedSeats` — minimax was retired
// upstream and the old `opencodeDeepseek` profile is absorbed into `opencode`.
// Upgraded 2026-11-19 to @opencode/cli@2.3.2 and opt-in `opencode-free`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPENCODE_PACKAGE_SPEC as PROFILE_OPENCODE_SPEC, REVIEW_PROFILES, provenFamilyCollision } from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'
import { OPENCODE_PACKAGE_SPEC as PRODUCER_OPENCODE_SPEC } from '../plugins/tmux-teams/skills/tmux-teams/scripts/opencode-execution-profile.mjs'
import { OPENCODE_FREE_DEFAULT_SEATS, ROUTES, UNAVAILABLE_RESERVE_SUBSTITUTES, createReviewPlan, planFallback } from '../plugins/tmux-teams/skills/party-mode/scripts/review-policy.mjs'

const LADDER = ['opencode', 'opencodeInkling', 'opencodeGlm', 'opencodeMimo', 'opencodeHy', 'opencodeLongcat', 'opencodeFlint', 'opencodeBeam', 'opencodeNemotronSuperVl', 'opencodeNemotronLightning']
const LADDER_MODELS = ['deepseek-v4.1-flash-free', 'inkling-2-small-free', 'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'hy4-flash-free', 'longcat-2.5-free', 'flint-40b-free', 'beam-free', 'nemotron-3.5-super-vl-free', 'nemotron-3.5-lightning-free']

test('review-profiles OPENCODE_PACKAGE_SPEC matches opencode-execution-profile SSOT', () => {
  assert.equal(PROFILE_OPENCODE_SPEC, PRODUCER_OPENCODE_SPEC)
})

test('the three preferred reviewer seats map to advisor skills with locked identities', () => {
  assert.equal(REVIEW_PROFILES.agy.model, 'gemini-4-hydrogen-high', 'agy-advisor hydrogen')
  assert.equal(REVIEW_PROFILES.codex.model, 'gpt-6-luna', 'codex-advisor luna')
  assert.equal(REVIEW_PROFILES.codex.config.reasoning_effort, 'max', 'luna locks max, not ultra')
  assert.equal(REVIEW_PROFILES.opencode.model, 'deepseek-v4.1-flash-free', 'oc-advisor default free seat')
})

test('the opencode free ladder is ranked deepseek -> inkling -> glm -> mimo -> hy4 -> longcat -> flint -> beam -> nemotron-super-vl -> nemotron-lightning', () => {
  assert.deepEqual(UNAVAILABLE_RESERVE_SUBSTITUTES, {
    claude: 'opencode',
    opencode: 'opencodeInkling',
    opencodeInkling: 'opencodeGlm',
    opencodeGlm: 'opencodeMimo',
    opencodeMimo: 'opencodeHy',
    opencodeHy: 'opencodeLongcat',
    opencodeLongcat: 'opencodeFlint',
    opencodeFlint: 'opencodeBeam',
    opencodeBeam: 'opencodeNemotronSuperVl',
    opencodeNemotronSuperVl: 'opencodeNemotronLightning',
  })
  assert.equal('opencodeNemotronLightning' in UNAVAILABLE_RESERVE_SUBSTITUTES, false, 'the terminal rung must have no outbound rung')
  assert.equal(REVIEW_PROFILES.opencodeDeepseek, undefined, 'opencodeDeepseek is absorbed into opencode')
  assert.deepEqual(Object.keys(REVIEW_PROFILES).filter(id => REVIEW_PROFILES[id].provider === 'opencode'), LADDER)
  for (const [index, id] of LADDER.entries()) {
    const profile = REVIEW_PROFILES[id]
    assert.equal(profile.model, LADDER_MODELS[index], `${id} rung ${index + 1} model`)
    assert.equal(profile.displayModel, `opencode/${LADDER_MODELS[index]}`, `${id} displayModel`)
    assert.equal(profile.config?.model, `opencode/${LADDER_MODELS[index]}`, `${id} config model`)
    assert.equal(profile.requestModel, `opencode/${LADDER_MODELS[index]}`, `${id} requestModel`)
    assert.equal(profile.provider, 'opencode')
    assert.equal(profile.family, 'deepseek')
    assert.equal(profile.reviewMode, 'plan')
    assert.deepEqual(profile.command, ['npx', '-y', '@opencode/cli@2.3.2', 'acp'])
    assert.equal(profile.adapterPackage, '@opencode/cli@2.3.2')
  }
})

test('kimi is retired: no route seats it', () => {
  for (const [primary, route] of Object.entries(ROUTES)) {
    assert.equal(route.reviewers.includes('kimi'), false, `${primary} route seats kimi`)
    assert.equal(planFallback(createReviewPlan(primary), route.reviewers[0]).replaced?.replacement === 'kimi', false)
  }
})

test('two opencode free seats stand apart only because their acknowledged models differ', () => {
  const pair = [REVIEW_PROFILES.opencode, REVIEW_PROFILES.opencodeInkling, REVIEW_PROFILES.agy]
  assert.equal(provenFamilyCollision(pair), false, 'three distinct models may sit together')
  // Same opencode model twice is still a collision, even with AGY present.
  assert.equal(provenFamilyCollision([REVIEW_PROFILES.opencode, REVIEW_PROFILES.opencode, REVIEW_PROFILES.agy]), true)
})

test('preferred panels keep AGY final and use three distinct models', () => {
  for (const primary of ['openai', 'claude', 'deepseek']) {
    const plan = createReviewPlan(primary)
    assert.equal(plan.blocked, false)
    assert.equal(plan.reviewers.at(-1), 'agy')
    assert.equal(new Set(plan.reviewers.map(id => REVIEW_PROFILES[id].model)).size, 3)
  }
})

test('openai route: a failed claude lane walks past the seated opencode to its ladder rung', () => {
  const plan = createReviewPlan('openai')
  assert.deepEqual(plan.reviewers, ['claude', 'opencode', 'agy'])
  const afterClaude = planFallback(plan, 'claude')
  assert.equal(afterClaude.blocked, false, 'must not pick the already-seated opencode')
  assert.deepEqual(afterClaude.reviewers, ['opencodeInkling', 'opencode', 'agy'])
  assert.equal(afterClaude.replaced.replacement, 'opencodeInkling')
  // A failed opencode takes its own next rung, not one already seated.
  const afterOc = planFallback(plan, 'opencode')
  assert.deepEqual(afterOc.reviewers, ['claude', 'opencodeInkling', 'agy'])
  assert.equal(afterOc.replaced.replacement, 'opencodeInkling')
})

test('the ladder walks rung by rung, accumulates failedSeats, and blocks when exhausted', () => {
  const plan = createReviewPlan('claude')
  assert.deepEqual(plan.reviewers, ['codex', 'opencode', 'agy'])
  const afterOc = planFallback(plan, 'opencode')
  assert.equal(afterOc.blocked, false)
  assert.deepEqual(afterOc.replaced, { failed: 'opencode', replacement: 'opencodeInkling' })
  assert.deepEqual(afterOc.failedSeats, ['opencode'])
  const afterInkling = planFallback(afterOc, 'opencodeInkling')
  assert.equal(afterInkling.blocked, false)
  assert.deepEqual(afterInkling.replaced, { failed: 'opencodeInkling', replacement: 'opencodeGlm' })
  assert.deepEqual(afterInkling.failedSeats, ['opencode', 'opencodeInkling'])
  const afterGlm = planFallback(afterInkling, 'opencodeGlm')
  assert.equal(afterGlm.blocked, false)
  assert.deepEqual(afterGlm.replaced, { failed: 'opencodeGlm', replacement: 'opencodeMimo' })
  assert.deepEqual(afterGlm.failedSeats, ['opencode', 'opencodeInkling', 'opencodeGlm'])
  for (const step of [afterOc, afterInkling, afterGlm]) {
    assert.equal(new Set(step.reviewers.map(id => REVIEW_PROFILES[id].model)).size, 3, 'panel stayed model-distinct')
    assert.equal(provenFamilyCollision(step.reviewers.map(id => REVIEW_PROFILES[id])), false, 'panel stayed proven-distinct')
  }
  const skipFailed = planFallback({ ...plan, failedSeats: ['opencodeInkling'] }, 'opencode')
  assert.equal(skipFailed.blocked, false)
  assert.deepEqual(skipFailed.replaced, { failed: 'opencode', replacement: 'opencodeGlm' })
  const exhausted = planFallback({ ...plan, failedSeats: LADDER }, 'opencode')
  assert.equal(exhausted.blocked, true)
  assert.equal(exhausted.reason, 'no available reserve')
})

test('opencode-free opt-in mode seats three verified v2.3.2 free models and excludes matching primary model', () => {
  const plan = createReviewPlan('gpt-6.2-sol', { policyMode: 'opencode-free' })
  assert.equal(plan.blocked, false)
  assert.equal(plan.policyMode, 'opencode-free')
  assert.equal(plan.requireAgy, false)
  assert.equal(plan.singleProviderQuorum, true)
  assert.deepEqual(plan.reviewers, OPENCODE_FREE_DEFAULT_SEATS)
  assert.equal(new Set(plan.reviewers.map(id => REVIEW_PROFILES[id].model)).size, 3)

  const deepseekPrimary = createReviewPlan('opencode/deepseek-v4.1-flash-free', { policyMode: 'opencode-free' })
  assert.equal(deepseekPrimary.blocked, false)
  assert.equal(deepseekPrimary.reviewers.includes('opencode'), false)
  assert.deepEqual(deepseekPrimary.reviewers, ['opencodeInkling', 'opencodeMimo', 'opencodeHy'])
  const fb = planFallback(deepseekPrimary, 'opencodeInkling')
  assert.equal(fb.blocked, false)
  assert.equal(fb.reviewers.includes('opencode'), false, 'excluded primary seat must never re-enter on fallback')
})

test('every route reserve is usable under that route own diversity rule', () => {
  for (const primary of ['openai', 'claude', 'deepseek']) {
    const plan = createReviewPlan(primary)
    const reserveProfile = REVIEW_PROFILES[plan.reserve]
    assert.ok(reserveProfile, `${primary} reserve ${plan.reserve} must exist`)
    const primaryModel = ({ openai: 'gpt-6-luna', claude: 'claude-opus-5-5', deepseek: 'deepseek-v4.1-flash-free' })[primary]
    assert.notEqual(reserveProfile.model, primaryModel, `${primary} reserve is the primary model`)
    // For each non-AGY reviewer, some fallback must produce a valid panel.
    for (const reviewer of plan.reviewers.filter(id => id !== 'agy')) {
      const result = planFallback(plan, reviewer)
      assert.equal(result.blocked, false, `${primary}/${reviewer} fallback blocked: ${result.reason}`)
      assert.equal(new Set(result.reviewers.map(id => REVIEW_PROFILES[id].model)).size, 3)
    }
  }
})

test('canonical opencode alias exclusion works in opencode-free and strict deepseek never seats opencode on fallback', () => {
  const inklingFree = createReviewPlan('inkling', { policyMode: 'opencode-free' })
  assert.equal(inklingFree.blocked, false)
  assert.ok(inklingFree.excludedSeats.includes('opencodeInkling'))
  assert.equal(inklingFree.reviewers.includes('opencodeInkling'), false)

  for (const primary of ['deepseek', 'deepseek-v4.1-flash-free', 'opencode/deepseek-v4.1-flash-free']) {
    const strictPlan = createReviewPlan(primary)
    assert.equal(strictPlan.blocked, false)
    assert.equal(strictPlan.reserve, 'opencodeInkling')
    assert.ok(strictPlan.excludedSeats.includes('opencode'))
    for (const lane of ['codex', 'claude']) {
      const fb = planFallback(strictPlan, lane)
      assert.equal(fb.blocked, false, `${primary}/${lane} fallback blocked: ${fb.reason}`)
      assert.equal(fb.reviewers.includes('opencode'), false, `${primary}/${lane} fallback must never seat opencode`)
      assert.equal(fb.replaced.replacement, 'opencodeInkling')
    }
  }
})
