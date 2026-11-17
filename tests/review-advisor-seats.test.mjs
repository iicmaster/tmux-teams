// Self-check for the 2026-11-17 seat change: the three review lanes run their
// bmad-party-mode round-table through an advisor skill, and are distinct by
// ACKNOWLEDGED MODEL (so opencode's free ladder can seat three real models).
import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_PROFILES, provenFamilyCollision } from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'
import { ROUTES, UNAVAILABLE_RESERVE_SUBSTITUTES, createReviewPlan, planFallback } from '../plugins/tmux-teams/skills/party-mode/scripts/review-policy.mjs'

test('the three preferred reviewer seats map to advisor skills with locked identities', () => {
  assert.equal(REVIEW_PROFILES.agy.model, 'gemini-4-hydrogen-high', 'agy-advisor hydrogen')
  assert.equal(REVIEW_PROFILES.codex.model, 'gpt-6-luna', 'codex-advisor luna')
  assert.equal(REVIEW_PROFILES.codex.config.reasoning_effort, 'max', 'luna locks max, not ultra')
  assert.equal(REVIEW_PROFILES.opencode.model, 'minimax-m3.1-flash-free', 'oc-advisor default free seat')
})

test('the opencode free ladder is ranked minimax -> deepseek -> hy -> glm', () => {
  assert.deepEqual(UNAVAILABLE_RESERVE_SUBSTITUTES, {
    claude: 'opencode',
    opencode: 'opencodeDeepseek',
    opencodeDeepseek: 'opencodeHy',
    opencodeHy: 'opencodeGlm',
  })
  assert.equal(REVIEW_PROFILES.opencodeDeepseek.model, 'deepseek-v4.1-flash-free')
  assert.equal(REVIEW_PROFILES.opencodeHy.model, 'hy4-flash-free')
  assert.equal(REVIEW_PROFILES.opencodeGlm.model, 'glm-5.3-flash-free')
})

test('kimi is retired: no route seats it', () => {
  for (const [primary, route] of Object.entries(ROUTES)) {
    assert.equal(route.reviewers.includes('kimi'), false, `${primary} route seats kimi`)
    assert.equal(planFallback(createReviewPlan(primary), route.reviewers[0]).replaced?.replacement === 'kimi', false)
  }
})

test('two opencode free seats stand apart only because their acknowledged models differ', () => {
  const pair = [REVIEW_PROFILES.opencode, REVIEW_PROFILES.opencodeDeepseek, REVIEW_PROFILES.agy]
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
  assert.deepEqual(afterClaude.reviewers, ['opencodeDeepseek', 'opencode', 'agy'])
  assert.equal(afterClaude.replaced.replacement, 'opencodeDeepseek')
  // A failed opencode takes its own next rung, not one already seated.
  const afterOc = planFallback(plan, 'opencode')
  assert.deepEqual(afterOc.reviewers, ['claude', 'opencodeDeepseek', 'agy'])
})

test('every route reserve is usable under that route own diversity rule', () => {
  for (const primary of ['openai', 'claude', 'deepseek']) {
    const plan = createReviewPlan(primary)
    const reserveProfile = REVIEW_PROFILES[plan.reserve]
    assert.ok(reserveProfile, `${primary} reserve ${plan.reserve} must exist`)
    const primaryModel = ({ openai: 'gpt-6-luna', claude: 'claude-opus-5-5', deepseek: 'deepseek-v4-flash-free' })[primary]
    assert.notEqual(reserveProfile.model, primaryModel, `${primary} reserve is the primary model`)
    // For each non-AGY reviewer, some fallback must produce a valid panel.
    for (const reviewer of plan.reviewers.filter(id => id !== 'agy')) {
      const result = planFallback(plan, reviewer)
      assert.equal(result.blocked, false, `${primary}/${reviewer} fallback blocked: ${result.reason}`)
      assert.equal(new Set(result.reviewers.map(id => REVIEW_PROFILES[id].model)).size, 3)
    }
  }
})
