import { createHash } from 'node:crypto'
import { declaredPrimaryFamilies, getReviewProfile, normalizePrimaryFamily, provenFamilyCollision, REVIEW_PROFILES } from './review-profiles.mjs'

// 2026-11-02, operator decision: the Zai and Qwen routes are gone for good, and
// so is `deepseek` — it only ever reached the market through the Qwen gateway
// that was removed with them. Every seat is now AGY, a local adapter, or one of
// the free `opencode` lanes. The reserve is an opencode lane of a family the
// panel is not already seating, so a substitution cannot manufacture
// distinctness it does not have: `planFallback` re-runs `validReviewerSet`
// after every swap and refuses a panel that would seat one family twice.
// Every panel seats three DISTINCT families, none of them the primary's, with
// AGY last. The reserve is a seat the panel is NOT already holding — that is
// the whole rule, and it is why the openai route's reserve is `ninerouter` and
// not `codex`: codex IS the openai family, so seating it would fail the very
// `families.every(family => family !== primaryFamily)` check `planFallback`
// re-runs after every swap. A reserve is still worth declaring when it can only
// cover ONE lane: `planFallback` removes the failed reviewer first, so
// `ninerouter` legitimately covers a failed `opencode` even though the two
// share the deepseek family, and is refused with a diversity reason for any
// other lane. That asymmetry is checked in the tests, not assumed here.
// Master 2026-11-17: kimi is retired permanently — no route seats it. Each
// reviewer lane runs a bmad-party-mode round-table via its advisor skill
// (`agy-advisor hydrogen`, `codex-advisor luna`, `oc-advisor` free seats), but
// the gate keeps its own transport, acknowledgement and schema checks: the
// round-table happens INSIDE the lane before it returns the closed-schema JSON.
// Distinctness is now by ACKNOWLEDGED MODEL, not declared family, so the ten
// opencode free seats are one roster with distinct members: any of them can
// sit together when quota forces it — each still verified as a different
// model before synthesis. The preferred panel still uses three families where
// quota allows.
const ROUTES = Object.freeze({
  // openai primary: codex (luna) is the same family, so it is excluded; the
  // preferred panel is AGY + claude opus + opencode deepseek (the default free
  // seat since minimax was retired upstream, 2026-11-18). If a lane is
  // unavailable the gate walks the ladder to the next free seat, which stays
  // distinct by acknowledged model.
  openai: Object.freeze({ reviewers: Object.freeze(['agy', 'claude', 'opencode']), reserve: 'opencode' }),
  // claude primary: three other families — gemini, openai, deepseek.
  claude: Object.freeze({ reviewers: Object.freeze(['agy', 'codex', 'opencode']), reserve: 'opencode' }),
  // deepseek primary: opencode seats share its family, so use gemini/openai/claude
  // and reserve opencodeInkling so fallback never seats deepseek-v4.1-flash-free.
  deepseek: Object.freeze({ reviewers: Object.freeze(['agy', 'codex', 'claude']), reserve: 'opencodeInkling' }),
})

export const REVIEW_POLICY_MODES = Object.freeze(['strict', 'opencode-free'])
// Verified present in @opencode/cli@2.3.2 on 2026-11-19 (`glm-5.3-flash-free` absent in v2.3.2).
export const OPENCODE_FREE_DEFAULT_SEATS = Object.freeze(['opencode', 'opencodeInkling', 'opencodeMimo'])
const OPENCODE_FREE_POOL = Object.freeze([
  'opencode',
  'opencodeInkling',
  'opencodeMimo',
  'opencodeHy',
  'opencodeLongcat',
  'opencodeFlint',
  'opencodeBeam',
  'opencodeNemotronSuperVl',
  'opencodeNemotronLightning',
  'opencodeGlm',
])

// In opencode-free mode (targeting @opencode/cli@2.3.2), walk the 9 v2.3.2-present
// seats in OPENCODE_FREE_POOL first before falling back to opencodeGlm (absent in
// v2.3.2 catalog, retained at the tail for catalog compatibility).
const OPENCODE_FREE_FALLBACK_LADDER = Object.freeze(
  Object.fromEntries(OPENCODE_FREE_POOL.slice(0, -1).map((seat, i) => [seat, OPENCODE_FREE_POOL[i + 1]])),
)

// Master 2026-11-18: kimi is gone permanently and the direct Claude provider
// is unavailable as an availability stand-in. The opencode free seats form the
// substitution ladder, strength-ranked per the Master contract of 2026-11-18
// (benchmark research + Artificial Analysis v5.0.1):
// deepseek -> inkling -> glm -> mimo -> hy4 -> longcat -> flint -> beam ->
// nemotron-super-vl -> nemotron-lightning. Each entry names the NEXT seat when
// the value hits quota; `planFallback` re-validates diversity after every hop,
// so a seat already on the panel is refused rather than duplicated.
//
// SEMANTICS CHANGE, same date: the old rule performed at most ONE swap per run
// and then blocked. The gate now WALKS this ladder — each failed seat is
// replaced by its next rung, repeatedly, until a rung answers or the ladder is
// exhausted; only then the run blocks and reports, and Master is asked (no
// paid seats). `planFallback` accumulates `failedSeats` on the plan so a seat
// that already answered invalid is never re-seated, and every seat used is
// labelled in the report/receipt. The walk's iteration cap lives in the gate
// (`LADDER_GUARD` in review-gate.mjs), not here.
const UNAVAILABLE_RESERVE_SUBSTITUTES = Object.freeze({
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
  // opencodeNemotronLightning: no outbound rung — ladder terminates, gate blocks
})

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
function validReviewerSet(primaryFamily, ids, { requireAgy = true, excludedSeats = [] } = {}) {
  if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3) return false
  if (requireAgy && ids[2] !== 'agy') return false
  if (Array.isArray(excludedSeats) && excludedSeats.some(id => ids.includes(id))) return false
  const profiles = ids.map(getReviewProfile)
  const models = profiles.map(profile => profile.model)
  // Master 2026-11-18: distinctness is decided by the ACKNOWLEDGED MODEL, not
  // the declared family. The ten opencode free seats legitimately share a
  // family and adapter but are different models, each verified at the gate's
  // `model_identity` stage. `provenFamilyCollision` still guards the
  // independent launch-identity axis (scoped to opencode for the model
  // discriminator). The PRIMARY's family is not excluded: a different model
  // from a same-family seat is a distinct reviewer.
  return new Set(models).size === 3 && !provenFamilyCollision(profiles)
}

const OPENCODE_SEAT_ALIASES = Object.freeze({
  opencode: 'opencode',
  deepseek: 'opencode',
  free: 'opencode',
  inkling: 'opencodeInkling',
  glm: 'opencodeGlm',
  mimo: 'opencodeMimo',
  hy: 'opencodeHy',
  hy4: 'opencodeHy',
  longcat: 'opencodeLongcat',
  flint: 'opencodeFlint',
  beam: 'opencodeBeam',
  'nemotron-super-vl': 'opencodeNemotronSuperVl',
  'nemotron-lightning': 'opencodeNemotronLightning',
})

function primaryRawTokens(primary) {
  if (primary === null || primary === undefined) return []
  const values = typeof primary === 'object'
    ? [primary.family, primary.provider, primary.profile, primary.model, primary.id, primary.name, primary.primary, primary.primaryProfile, primary.primary_model]
    : [primary]
  return values
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
}

function excludedOpencodeSeats(primary) {
  const tokens = primaryRawTokens(primary)
  const stripped = tokens.map(token => token.replace(/^opencode\//, ''))
  const primaryFamily = normalizePrimaryFamily(primary)
  const excluded = []
  for (const id of OPENCODE_FREE_POOL) {
    const profile = REVIEW_PROFILES[id]
    if (!profile) continue
    const idLower = id.toLowerCase()
    const modelLower = profile.model.toLowerCase()
    const displayLower = String(profile.displayModel ?? '').toLowerCase()
    const matchesToken = stripped.some(token =>
      token === idLower ||
      token === modelLower ||
      token === displayLower ||
      OPENCODE_SEAT_ALIASES[token] === id)
    if (matchesToken || (id === 'opencode' && primaryFamily === 'deepseek')) {
      excluded.push(id)
    }
  }
  return Object.freeze(excluded)
}

export function createReviewPlan(primary, options = {}) {
  const policyMode = options?.policyMode ?? 'strict'
  if (!REVIEW_POLICY_MODES.includes(policyMode)) {
    return Object.freeze({
      blocked: true,
      reason: 'unsupported review policy mode',
      primaryFamily: 'unknown',
      policyMode: 'invalid',
      reviewers: Object.freeze([]),
      reserve: null,
    })
  }
  const declaredFamilies = declaredPrimaryFamilies(primary)
  if (declaredFamilies.length > 1) {
    return Object.freeze({
      blocked: true,
      reason: `conflicting primary families: ${declaredFamilies.join(', ')}`,
      primaryFamily: 'unknown',
      policyMode,
      reviewers: Object.freeze([]),
      reserve: null,
    })
  }
  const primaryFamily = normalizePrimaryFamily(primary)
  if (policyMode === 'opencode-free') {
    if (primaryRawTokens(primary).length === 0) {
      return Object.freeze({
        blocked: true,
        reason: 'missing primary identity',
        primaryFamily,
        policyMode,
        reviewers: Object.freeze([]),
        reserve: null,
      })
    }
    const excludedSeats = excludedOpencodeSeats(primary)
    const eligible = OPENCODE_FREE_POOL.filter(id => !excludedSeats.includes(id))
    const reviewers = Object.freeze(eligible.slice(0, 3))
    if (!validReviewerSet(primaryFamily, reviewers, { requireAgy: false, excludedSeats })) {
      return Object.freeze({
        blocked: true,
        reason: 'unable to seat three distinct opencode free reviewers',
        primaryFamily,
        policyMode,
        reviewers: Object.freeze([]),
        reserve: null,
      })
    }
    return Object.freeze({
      blocked: false,
      primaryFamily,
      policyMode: 'opencode-free',
      requireAgy: false,
      singleProviderQuorum: true,
      excludedSeats,
      reviewers,
      reserve: eligible[3] ?? null,
    })
  }
  const route = ROUTES[primaryFamily]
  if (!route) return Object.freeze({ blocked: true, reason: `unsupported primary family: ${primaryFamily}`, primaryFamily, policyMode, reviewers: Object.freeze([]), reserve: null })
  const excludedSeats = excludedOpencodeSeats(primary)
  const reviewers = withAgyFinal(route.reviewers)
  if (!validReviewerSet(primaryFamily, reviewers, { requireAgy: true, excludedSeats })) throw new Error('invalid immutable review route')
  return Object.freeze({
    blocked: false,
    primaryFamily,
    policyMode: 'strict',
    requireAgy: true,
    singleProviderQuorum: false,
    excludedSeats,
    reviewers,
    reserve: route.reserve,
  })
}

// Stable integration names used by the ACP runner.  Keep the more descriptive
// names above for direct policy tests, but expose this small surface as well.
export const planReviewPanel = createReviewPlan
export const validateReview = validateReviewOutput

/** Replace one failed non-AGY lane with the next free-seat rung on the ladder. */
export function planFallback(plan, failedReviewer) {
  if (!plan || plan.blocked) return Object.freeze({ blocked: true, reason: 'review plan is blocked' })
  if (!plan.reviewers.includes(failedReviewer)) return Object.freeze({ blocked: true, reason: 'failed reviewer is not planned' })
  const requireAgy = plan.policyMode === 'opencode-free' ? Boolean(plan.requireAgy) : plan.requireAgy !== false
  if (requireAgy && failedReviewer === 'agy') return Object.freeze({ blocked: true, reason: 'AGY is mandatory and cannot be replaced' })
  // Master 2026-11-18: walk the ladder from the FAILED seat and take the first
  // rung that is neither seated, nor already visited on this walk, nor already
  // FAILED this run (`failedSeats` — the gate feeds the accumulated plan back
  // in on every hop, so a rung that answered invalid is never re-seated). The
  // openai route seats `claude` and `opencode` together, so when claude fails
  // the naive `claude -> opencode` map would retry a seated lane and block;
  // skipping it to the next rung is the whole point of the ladder. A seat with
  // no ladder entry starts from the route's declared reserve (injected-plan
  // compatibility).
  const ladder = plan.policyMode === 'opencode-free'
    ? OPENCODE_FREE_FALLBACK_LADDER
    : UNAVAILABLE_RESERVE_SUBSTITUTES
  const unavailable = candidate =>
    plan.reviewers.includes(candidate) ||
    seenLadder.has(candidate) ||
    plan.failedSeats?.includes(candidate) ||
    plan.excludedSeats?.includes(candidate)
  let candidate = ladder[failedReviewer] ?? plan.reserve
  const seenLadder = new Set([failedReviewer])
  while (candidate && ladder[candidate] && unavailable(candidate)) {
    seenLadder.add(candidate)
    candidate = ladder[candidate]
  }
  const replacementId = candidate
  if (!replacementId) return Object.freeze({ blocked: true, reason: 'no available reserve' })
  // A failed or excluded last rung must not be re-seated: exhaustion lands here
  // with the terminal rung in hand.
  if (plan.failedSeats?.includes(replacementId) || plan.excludedSeats?.includes(replacementId)) {
    return Object.freeze({ blocked: true, reason: 'no available reserve' })
  }
  if (replacementId === failedReviewer) {
    return Object.freeze({ blocked: true, reason: 'availability fallback would retry the failed reviewer' })
  }
  if (plan.reviewers.some(id => id !== failedReviewer && id === replacementId)) {
    return Object.freeze({ blocked: true, reason: 'availability fallback would duplicate an accepted reviewer' })
  }
  const mapped = plan.reviewers.map(id => id === failedReviewer ? replacementId : id)
  const reviewers = requireAgy ? withAgyFinal(mapped) : Object.freeze(mapped)
  if (!validReviewerSet(plan.primaryFamily, reviewers, { requireAgy, excludedSeats: plan.excludedSeats })) return Object.freeze({ blocked: true, reason: 'fallback would violate reviewer diversity' })
  return Object.freeze({
    ...plan,
    reserve: replacementId,
    reviewers,
    // Record only — nothing reads this for blocking anymore (the ladder walk
    // replaced the one-swap rule; the mocks in tests still set it).
    usedReserve: true,
    // The failed seat travels with the plan so the next hop (and this
    // function's own walk) refuses it.
    failedSeats: Object.freeze([...(plan.failedSeats ?? []), failedReviewer]),
    // The row records that this seat came from the unavailable-provider swap.
    // Naming the substitute by what it actually resolved to (`claude-zai` was
    // the old label, and that lane is gone) keeps the receipt honest.
    ...(plan.reserve === 'claude' ? { availabilityFallback: replacementId } : {}),
    replaced: Object.freeze({ failed: failedReviewer, replacement: replacementId }),
  })
}

function expectedReviewers(plan) {
  if (!plan || plan.blocked) return null
  const requireAgy = plan.policyMode === 'opencode-free' ? Boolean(plan.requireAgy) : plan.requireAgy !== false
  if (!validReviewerSet(plan.primaryFamily, plan.reviewers, { requireAgy, excludedSeats: plan.excludedSeats })) return null
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
