import { createHash } from 'node:crypto'
import { declaredPrimaryFamilies, getReviewProfile, normalizePrimaryFamily } from './review-profiles.mjs'

const ROUTES = Object.freeze({
  openai: Object.freeze({ reviewers: Object.freeze(['agy', 'kimi', 'zai']), reserve: 'claude' }),
  claude: Object.freeze({ reviewers: Object.freeze(['agy', 'codex', 'kimi']), reserve: 'zai' }),
  kimi: Object.freeze({ reviewers: Object.freeze(['agy', 'codex', 'zai']), reserve: 'claude' }),
  zai: Object.freeze({ reviewers: Object.freeze(['agy', 'codex', 'kimi']), reserve: 'claude' }),
})

// Master has declared the direct Claude provider unavailable.  `claude-zai`
// is an availability alias, not a new model: it launches the existing pinned
// Zai GLM-5.2 ACP profile.  The final-panel validation below decides whether
// that alias is eligible for a particular failed lane.
const UNAVAILABLE_RESERVE_SUBSTITUTES = Object.freeze({ claude: 'zai' })

const MAX_FINDINGS = 32
const MAX_RESIDUAL_RISKS = 16
const findingCategories = new Set(['correctness', 'security', 'tests', 'docs', 'operations'])
const stringLimits = Object.freeze({ criterion_id: 96, category: 64, location: 256, summary: 1000, evidence: 2000 })
const findingKeys = Object.freeze(['criterion_id', 'category', 'location', 'summary', 'evidence', 'blocking'])
const reviewKeys = Object.freeze(['schema_version', 'verdict', 'assessment', 'findings', 'residual_risks'])

function ownPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function sameKeys(value, keys) {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}
function validString(value, limit, minimum = 1) {
  return typeof value === 'string' && value.length >= minimum && value.length <= limit && value.trim() === value
}
function invalid(reason) { return { ok: false, reason } }

/** Closed, bounded model-output schema.  Reviewer identity is supplied by the caller, never the model. */
export function validateReviewOutput(value) {
  if (!ownPlainObject(value)) return invalid('review must be a plain object')
  if (!sameKeys(value, reviewKeys)) return invalid('review has unknown or missing fields')
  if (value.schema_version !== 1) return invalid('unsupported schema_version')
  if (!['PASS', 'OBJECTIONS', 'BLOCKED'].includes(value.verdict)) return invalid('invalid verdict')
  if (!validString(value.assessment, 4000, 20)) return invalid('assessment must be substantive')
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) return invalid('findings must be a bounded array')
  if (!Array.isArray(value.residual_risks) || value.residual_risks.length > MAX_RESIDUAL_RISKS) return invalid('residual_risks must be a bounded array')
  if (!value.residual_risks.every(risk => validString(risk, 500))) return invalid('invalid residual risk')
  if (value.verdict === 'PASS' && value.findings.length !== 0) return invalid('PASS cannot contain findings')
  if (value.verdict === 'OBJECTIONS' && value.findings.length === 0) return invalid('OBJECTIONS requires findings')
  if (value.verdict === 'BLOCKED' && value.findings.length !== 0) return invalid('BLOCKED cannot contain findings')
  const findings = []
  for (const finding of value.findings) {
    if (!ownPlainObject(finding) || !sameKeys(finding, findingKeys)) return invalid('finding has unknown or missing fields')
    for (const [key, limit] of Object.entries(stringLimits)) {
      if (!validString(finding[key], limit)) return invalid(`invalid finding ${key}`)
    }
    if (!validString(finding.summary, stringLimits.summary, 8)) return invalid('finding summary must be substantive')
    if (!validString(finding.evidence, stringLimits.evidence, 12)) return invalid('finding evidence must be substantive')
    if (!findingCategories.has(finding.category)) return invalid('invalid finding category')
    if (typeof finding.blocking !== 'boolean') return invalid('finding blocking must be boolean')
    findings.push(Object.freeze({
      criterion_id: finding.criterion_id, category: finding.category, location: finding.location,
      summary: finding.summary, evidence: finding.evidence, blocking: finding.blocking,
    }))
  }
  return Object.freeze({ ok: true, value: Object.freeze({
    schema_version: 1,
    verdict: value.verdict,
    assessment: value.assessment,
    findings: Object.freeze(findings),
    residual_risks: Object.freeze([...value.residual_risks]),
  }) })
}

export function findingFingerprint(finding) {
  return createHash('sha256').update(JSON.stringify([
    finding.criterion_id.toLowerCase(),
    finding.category.toLowerCase(),
    finding.location.replaceAll('\\', '/').toLowerCase(),
  ])).digest('hex')
}

function withAgyFinal(ids) {
  return Object.freeze([...ids.filter(id => id !== 'agy'), 'agy'])
}
function validReviewerSet(primaryFamily, ids) {
  if (!Array.isArray(ids) || ids.length !== 3 || ids[2] !== 'agy' || new Set(ids).size !== 3) return false
  const profiles = ids.map(getReviewProfile)
  const families = profiles.map(profile => profile.family)
  const models = profiles.map(profile => profile.model)
  return new Set(families).size === 3 && new Set(models).size === 3 &&
    families.every(family => family !== primaryFamily)
}

export function createReviewPlan(primary) {
  const declaredFamilies = declaredPrimaryFamilies(primary)
  if (declaredFamilies.length > 1) {
    return Object.freeze({
      blocked: true,
      reason: `conflicting primary families: ${declaredFamilies.join(', ')}`,
      primaryFamily: 'unknown',
      reviewers: Object.freeze([]),
      reserve: null,
    })
  }
  const primaryFamily = normalizePrimaryFamily(primary)
  const route = ROUTES[primaryFamily]
  if (!route) return Object.freeze({ blocked: true, reason: `unsupported primary family: ${primaryFamily}`, primaryFamily, reviewers: Object.freeze([]), reserve: null })
  const reviewers = withAgyFinal(route.reviewers)
  if (!validReviewerSet(primaryFamily, reviewers)) throw new Error('invalid immutable review route')
  return Object.freeze({ blocked: false, primaryFamily, reviewers, reserve: route.reserve })
}

// Stable integration names used by the ACP runner.  Keep the more descriptive
// names above for direct policy tests, but expose this small surface as well.
export const planReviewPanel = createReviewPlan
export const validateReview = validateReviewOutput

/** Replace exactly one failed non-AGY lane with the route's one eligible reserve. */
export function planFallback(plan, failedReviewer) {
  if (!plan || plan.blocked) return Object.freeze({ blocked: true, reason: 'review plan is blocked' })
  if (!plan.reviewers.includes(failedReviewer)) return Object.freeze({ blocked: true, reason: 'failed reviewer is not planned' })
  if (failedReviewer === 'agy') return Object.freeze({ blocked: true, reason: 'AGY is mandatory and cannot be replaced' })
  if (plan.usedReserve) return Object.freeze({ blocked: true, reason: 'reserve already used' })
  const replacementId = UNAVAILABLE_RESERVE_SUBSTITUTES[plan.reserve] ?? plan.reserve
  if (!replacementId) return Object.freeze({ blocked: true, reason: 'no available reserve' })
  if (replacementId === failedReviewer) {
    return Object.freeze({ blocked: true, reason: 'availability fallback would retry the failed reviewer' })
  }
  if (plan.reviewers.some(id => id !== failedReviewer && id === replacementId)) {
    return Object.freeze({ blocked: true, reason: 'availability fallback would duplicate an accepted reviewer' })
  }
  const reviewers = withAgyFinal(plan.reviewers.map(id => id === failedReviewer ? replacementId : id))
  if (!validReviewerSet(plan.primaryFamily, reviewers)) return Object.freeze({ blocked: true, reason: 'fallback would violate reviewer diversity' })
  return Object.freeze({
    ...plan,
    reserve: replacementId,
    reviewers,
    usedReserve: true,
    ...(plan.reserve === 'claude' ? { availabilityFallback: 'claude-zai' } : {}),
    replaced: Object.freeze({ failed: failedReviewer, replacement: replacementId }),
  })
}

function expectedReviewers(plan) {
  if (!plan || plan.blocked || !validReviewerSet(plan.primaryFamily, plan.reviewers)) return null
  return plan.reviewers
}

/**
 * Synthesize only a complete, policy-owned panel.  Inputs are keyed by profile
 * id; any model-supplied identity/provider metadata is discarded.
 */
export function synthesizeReviews(plan, responses) {
  const reviewers = expectedReviewers(plan)
  if (!reviewers) return Object.freeze({ verdict: 'BLOCKED', reason: 'invalid or blocked review plan' })
  if (!ownPlainObject(responses) || !sameKeys(responses, reviewers)) return Object.freeze({ verdict: 'BLOCKED', reason: 'need exactly three planned reviewer responses' })

  const accepted = []
  for (const reviewer of reviewers) {
    const checked = validateReviewOutput(responses[reviewer])
    if (!checked.ok) return Object.freeze({ verdict: 'BLOCKED', reason: `invalid review from ${reviewer}: ${checked.reason}` })
    accepted.push(Object.freeze({ reviewer, ...checked.value }))
  }
  const blocked = accepted.find(review => review.verdict === 'BLOCKED')
  if (blocked) return Object.freeze({ verdict: 'BLOCKED', reason: `reviewer blocked: ${blocked.reviewer}`, reviews: Object.freeze(accepted) })

  const buckets = new Map()
  for (const review of accepted) for (const finding of review.findings) {
    const fingerprint = findingFingerprint(finding)
    const bucket = buckets.get(fingerprint) ?? { fingerprint, finding, reviewers: new Set() }
    bucket.reviewers.add(review.reviewer)
    buckets.set(fingerprint, bucket)
  }
  const objections = [...buckets.values()].map(bucket => Object.freeze({
    fingerprint: bucket.fingerprint, ...bucket.finding, reviewers: Object.freeze([...bucket.reviewers]),
  }))
  const mustFix = objections.filter(item => item.reviewers.length >= 2)
  const residual = objections.filter(item => item.reviewers.length < 2)
  const passCount = accepted.filter(review => review.verdict === 'PASS').length
  const verdict = mustFix.length ? 'OBJECTIONS' : 'PASS'
  const residualRisks = accepted.flatMap(review => review.residual_risks.map(risk => Object.freeze({ reviewer: review.reviewer, risk })))
  return Object.freeze({
    verdict,
    passCount,
    requiresPmJudgment: residual.length > 0,
    mustFix: Object.freeze(mustFix),
    residualObjections: Object.freeze(residual),
    residualRisks: Object.freeze(residualRisks),
    reviews: Object.freeze(accepted),
  })
}

export { ROUTES, UNAVAILABLE_RESERVE_SUBSTITUTES }
