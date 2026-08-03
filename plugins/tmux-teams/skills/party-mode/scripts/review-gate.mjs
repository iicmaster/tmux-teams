// Review gate coordinator. It is intentionally transport-only: no repository
// cwd, mailbox, KMS, session persistence, or worker state is used here.
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ACP_REVIEW_LIMITS, prepareReviewPacket, runAcpReview, ReviewTransportError } from './acp-review-client.mjs'
import { REVIEW_PROFILES, buildProfileEnv } from './review-profiles.mjs'
import {
  UNAVAILABLE_RESERVE_SUBSTITUTES,
  planReviewPanel,
  planFallback,
  validateReview,
  synthesizeReviews,
} from './review-policy.mjs'

export const REVIEW_GATE_EXIT = Object.freeze({ ok: 0, input: 2, transport: 3, review: 4, policy: 5 })
const asList = profiles => Array.isArray(profiles) ? profiles : Object.values(profiles ?? {})
const laneOf = p => String(p.lane ?? p.id ?? '').toLowerCase()
const isAgy = p => /(^|[-_])agy($|[-_])|antigravity/.test(laneOf(p))
// A lane's stage is the transport's own error code, clamped to a closed set so
// an injected runner cannot write arbitrary bytes into an operator report.
// `acknowledge` and `schema` are the two gate-local stages after transport.
const LANE_STAGES = new Set(['input', 'config', 'spawn', 'closed', 'protocol', 'timeout', 'review', 'policy', 'transport'])
const laneStage = code => LANE_STAGES.has(code) ? code : 'transport'
const boundedReason = value => typeof value === 'string' && value.length <= 200 ? value : null
const hexDigest = value => /^[a-f0-9]{64}$/.test(value ?? '') ? value : null
const attemptRecord = attempt => Object.freeze({
  profile: attempt.profile.id,
  status: attempt.valid ? 'accepted' : 'failed',
  fallback: attempt.fallback,
  ...(attempt.replaces ? { replaces: attempt.replaces } : {}),
  ...(!attempt.valid ? {
    failureKind: attempt.failureKind,
    stage: attempt.stage,
    failure: attempt.failure,
    stderrDigest: attempt.stderrDigest,
    stderrBytes: attempt.stderrBytes,
  } : {}),
})

function choosePanel(profiles, packet, planner = planReviewPanel) {
  if (Array.isArray(profiles)) {
    throw new ReviewTransportError('input', 'review profiles must be a policy-keyed object, not an arbitrary array')
  }
  const all = asList(profiles)
  if (typeof planner !== 'function') throw new ReviewTransportError('policy', 'review panel planner is required')
  const primaryInput = {
    primary: packet?.primary,
    primaryProfile: packet?.primaryProfile,
    primary_model: packet?.primary_model,
  }
  const plan = planner(primaryInput)
  if (plan?.blocked) throw new ReviewTransportError('policy', plan.reason ?? 'review panel is blocked')
  const primary = (plan?.reviewers ?? []).map(id => profiles[id]).filter(Boolean)
  if (primary.length !== 3 || new Set(primary.map(profile => profile.id)).size !== 3) {
    throw new ReviewTransportError('policy', 'policy did not resolve three distinct review profiles')
  }
  if (primary.filter(profile => profile.id === 'agy').length !== 1) {
    throw new ReviewTransportError('policy', 'policy panel must contain exactly one mandatory AGY reviewer')
  }
  const primaryFamilies = primary.map(profile => profile.family)
  if (new Set(primaryFamilies).size !== 3 || primaryFamilies.includes(plan.primaryFamily)) {
    throw new ReviewTransportError('policy', 'policy panel violates reviewer-family diversity')
  }
  if (new Set(primary.map(profile => profile.model)).size !== 3) {
    throw new ReviewTransportError('policy', 'policy panel violates reviewer-model diversity')
  }
  return { primary, all, plan }
}

function reserveFor(original, all) {
  const key = original.id ?? original.lane
  return all.find(p => p.reserve && (p.reserveFor === key || p.for === key || p.lane === original.reserveLane))
}

async function defaultLaneRunner(profile, packet, deps) {
  if (UNAVAILABLE_RESERVE_SUBSTITUTES[profile.id]) {
    throw new ReviewTransportError('policy', 'direct Claude provider is unavailable; only policy-eligible claude-zai may be used')
  }
  const env = typeof deps.buildProfileEnv === 'function' ? deps.buildProfileEnv(profile.id ?? profile) : {}
  const argv = Array.isArray(profile.command) ? profile.command : [profile.command]
  // Review ACP is always a plan/read-only lane; a provider-specific profile
  // cannot silently downgrade this safety mode.
  const configured = { ...profile, reviewMode: 'plan' }
  return deps.runAcpReview({
    lane: profile.lane ?? profile.id,
    profile: configured,
    command: argv[0],
    args: argv.slice(1),
    packet,
    env,
    timeoutMs: deps.timeoutMs,
    targetRepository: deps.targetRepository,
  })
}

function runnerEvidenceError(profile, value, expectedInputHash) {
  if (!value || typeof value !== 'object') return 'missing runner result'
  if (value.profile !== profile.id) return 'runner/profile identity mismatch'
  if (value.provider !== profile.provider) return 'runner/provider identity mismatch'
  if (value.model !== profile.model) return 'runner/model identity mismatch'
  if (value.displayModel !== (profile.displayModel ?? `${profile.provider}/${profile.model}`)) return 'runner/display-model identity mismatch'
  if (value.mode !== 'plan') return 'runner did not enforce plan mode'
  if (value.inputHash !== expectedInputHash) return 'static packet hash mismatch'
  if (typeof value.provenance !== 'string' || !value.provenance.startsWith('review-runner:')) return 'invalid runner provenance'
  for (const [configId, wanted] of Object.entries(profile.config ?? {})) {
    if (value.acknowledgements?.[configId]?.value !== wanted) return `${configId} was not acknowledged`
  }
  const isolation = value.isolation
  if (isolation?.workspace !== 'temporary' || isolation?.targetRepositoryCwd !== false ||
      isolation?.targetRepositoryHidden !== (profile.osSandbox === 'bwrap') ||
      (profile.osSandbox === 'bwrap' && (!isAbsolute(isolation?.targetRepositoryCanonical) ||
        isolation?.hostRootBaseReadOnly !== true ||
        isolation?.hostDataRootsMasked !== true ||
        isolation?.hostProcessNamespaceIsolated !== true)) ||
      isolation?.mcpServers !== 0 || isolation?.builtInToolsRequested !== false ||
      isolation?.toolCallsObserved !== 0 ||
      !Number.isInteger(isolation?.reasoningUpdatesObserved) ||
      isolation.reasoningUpdatesObserved < 0 ||
      (!isAgy(profile) && isolation.reasoningUpdatesObserved !== 0) ||
      !Number.isInteger(isolation?.safeRuntimeReadsObserved) ||
      isolation.safeRuntimeReadsObserved < 0 ||
      (!isAgy(profile) && isolation.safeRuntimeReadsObserved !== 0) ||
      !Number.isInteger(isolation?.safeWorkspaceReadsObserved) ||
      isolation.safeWorkspaceReadsObserved < 0 ||
      (!isAgy(profile) && isolation.safeWorkspaceReadsObserved !== 0) ||
      isolation?.temporaryModelSettings !== Boolean(profile.sessionSettings) ||
      isolation?.hostProviderHomeVisible !== (profile.osSandbox !== 'bwrap') ||
      isolation?.ephemeralProviderStateWritable !== (profile.osSandbox === 'bwrap') ||
      isolation?.hostProviderStatePersistent !== (profile.osSandbox !== 'bwrap') ||
      isolation?.providerMayPersistRemoteState !== true ||
      isolation?.networkSharedWithHost !== (profile.osSandbox === 'bwrap') ||
      isolation?.acpPermissionRequests !== 'deny') {
    return 'review isolation contract was not acknowledged'
  }
  return null
}

async function assessAttempt(attempt, validate, expectedInputHash) {
  const settled = attempt.result.status === 'rejected' ? attempt.result.reason : attempt.result.value
  const stderrEvidence = {
    stderrDigest: hexDigest(settled?.stderrDigest),
    stderrBytes: Number.isInteger(settled?.stderrBytes) ? settled.stderrBytes : null,
  }
  if (attempt.result.status === 'rejected') {
    const stage = laneStage(attempt.result.reason?.code)
    const failureKind = stage === 'review' ? 'review' : stage === 'policy' ? 'policy' : 'transport'
    return { ...attempt, valid: false, failureKind, stage, ...stderrEvidence, failure: `ACP lane failed (${stage})` }
  }
  const value = attempt.result.value
  const evidenceError = runnerEvidenceError(attempt.profile, value, expectedInputHash)
  if (evidenceError) return { ...attempt, valid: false, failureKind: 'review', stage: 'acknowledge', ...stderrEvidence, failure: evidenceError }
  let checked
  try { checked = await validate(value.review, { profile: attempt.profile.id, value }) } catch {
    return { ...attempt, valid: false, failureKind: 'review', stage: 'schema', ...stderrEvidence, failure: 'review validator threw' }
  }
  if (checked === false || checked?.valid === false || checked?.ok === false) {
    return { ...attempt, valid: false, failureKind: 'review', stage: 'schema', ...stderrEvidence, failure: boundedReason(checked?.reason) ?? 'review schema is invalid' }
  }
  return {
    ...attempt,
    valid: true,
    item: Object.freeze({
      lane: attempt.profile.lane ?? attempt.profile.id,
      profile: attempt.profile.id,
      provider: value.provider,
      family: attempt.profile.family,
      model: value.model,
      displayModel: value.displayModel,
      mode: value.mode,
      acknowledgements: value.acknowledgements,
      isolation: value.isolation,
      review: value.review,
      inputHash: value.inputHash,
      provenance: value.provenance,
      packetBytes: value.packetBytes,
      fallback: attempt.fallback,
      ...(attempt.replaces ? { replaces: attempt.replaces } : {}),
    }),
  }
}

export async function runReviewGate(packet, {
  profiles = REVIEW_PROFILES,
  runAcpReview: laneRunner = runAcpReview,
  buildProfileEnv: profileEnv = buildProfileEnv,
  validateReview: validate = validateReview,
  synthesizeReviews: synthesize = synthesizeReviews,
  planReviewPanel: planner = planReviewPanel,
  planFallback: fallbackPlanner = planFallback,
  timeoutMs,
  targetRepository,
} = {}) {
  const { primary, all, plan } = choosePanel(profiles, packet, planner)
  let activePlan = plan
  const expectedInputHash = prepareReviewPacket(packet).inputHash
  const deps = { runAcpReview: laneRunner, buildProfileEnv: profileEnv, timeoutMs, targetRepository }
  const settled = await Promise.allSettled(primary.map(profile => defaultLaneRunner(profile, packet, deps)))
  const attempts = await Promise.all(primary.map((profile, index) => assessAttempt(
    { profile, result: settled[index], fallback: false },
    validate,
    expectedInputHash,
  )))
  const substitution = { used: false, replaced: null, replacement: null, remaining: 1, reason: null }
  // Every blocker after the lanes launch carries the per-lane record with it.
  // The reasons were always computed; `report` was built downstream of all ten
  // throw sites, so it was serialized only on the path where nothing went
  // wrong — a quota failure and an expired token reached the operator as the
  // same sentence and a zero-byte file.
  const fail = (code, message) => {
    const error = new ReviewTransportError(code, message)
    error.report = Object.freeze({
      ok: false,
      blocked: true,
      code,
      inputHash: expectedInputHash,
      primaryFamily: activePlan?.primaryFamily ?? null,
      substitution: Object.freeze({ ...substitution }),
      attempts: Object.freeze(attempts.map(attemptRecord)),
    })
    return error
  }
  const agy = attempts.find(a => isAgy(a.profile))
  if (!agy || !agy.valid) {
    const kind = agy?.failureKind === 'review' ? 'review' : 'transport'
    substitution.remaining = 0
    substitution.reason = 'AGY is mandatory and cannot be replaced'
    throw fail(kind, `AGY review lane failed (${agy?.failure ?? 'missing'}); external review is blocked`)
  }
  // Reserves are deliberately sequential and only begin after all primaries
  // settle, which prevents duplicated concurrent reviews of the same packet.
  const originalFailures = attempts.filter(a => !a.valid && !isAgy(a.profile))
  if (originalFailures.length > 1) {
    substitution.remaining = 0
    substitution.reason = 'one reserve cannot restore an exact-three panel'
    throw fail('transport', 'more than one non-AGY review lane failed; one reserve cannot restore an exact-three panel')
  }
  const originalFailure = originalFailures[0]
  if (originalFailure) {
    substitution.replaced = originalFailure.profile.id ?? originalFailure.profile.lane
    substitution.remaining = 0
    let reserve
    if (plan && typeof fallbackPlanner === 'function') {
      const replacement = fallbackPlanner(plan, originalFailure.profile.id)
      if (!replacement?.blocked) {
        activePlan = replacement
        reserve = profiles[replacement.replaced?.replacement ?? replacement.reserve]
      } else substitution.reason = boundedReason(replacement.reason)
    } else reserve = reserveFor(originalFailure.profile, all)
    if (reserve) {
      substitution.used = true
      substitution.replacement = reserve.id ?? reserve.lane
      const [result] = await Promise.allSettled([defaultLaneRunner(reserve, packet, deps)])
      attempts.push(await assessAttempt({
        profile: reserve,
        result,
        fallback: true,
        replaces: substitution.replaced,
      }, validate, expectedInputHash))
    } else substitution.reason ??= 'no eligible reserve for this route'
  }
  const accepted = attempts.filter(a => a.valid)
  if (accepted.length !== 3) throw fail('transport', `review gate accepted ${accepted.length}; exactly three are required`)
  const acceptedByProfile = new Map(accepted.map(attempt => [attempt.profile.id, attempt.item]))
  const reviewOrder = activePlan?.reviewers ?? accepted.map(attempt => attempt.profile.id)
  const reviews = reviewOrder.map(id => acceptedByProfile.get(id)).filter(Boolean)
  if (reviews.length !== 3 || new Set(reviews.map(item => item.profile)).size !== 3) {
    throw fail('policy', 'final review profiles are not exactly three distinct identities')
  }
  if (reviews.filter(item => item.profile === 'agy').length !== 1) {
    throw fail('policy', 'final review panel must contain exactly one AGY identity')
  }
  const finalFamilies = reviews.map(item => item.family)
  if (new Set(finalFamilies).size !== 3) {
    throw fail('policy', 'final review families are not distinct')
  }
  if (activePlan?.primaryFamily && finalFamilies.includes(activePlan.primaryFamily)) {
    throw fail('policy', 'final review family matches the primary family')
  }
  if (new Set(reviews.map(item => item.model)).size !== 3) {
    throw fail('policy', 'final review models are not distinct')
  }
  if (new Set(reviews.map(item => item.provenance)).size !== 3) {
    throw fail('review', 'review provenance collision detected')
  }
  const synthesis = activePlan
    ? await synthesize(activePlan, Object.fromEntries(reviews.map(item => [item.profile, item.review])))
    : await synthesize(reviews)
  const report = Object.freeze({
    ok: synthesis?.verdict === 'PASS',
    count: reviews.length,
    primaryFamily: activePlan?.primaryFamily ?? null,
    route: Object.freeze(reviews.map(item => item.profile)),
    inputHash: expectedInputHash,
    substitution: Object.freeze({ ...substitution }),
    attempts: Object.freeze(attempts.map(attemptRecord)),
    reviews: Object.freeze(reviews),
    synthesis,
  })
  if (!report.ok) {
    const error = new ReviewTransportError('policy', `review synthesis is not PASS (${synthesis?.verdict ?? 'missing'})`)
    error.report = report
    throw error
  }
  return report
}

function exitCodeFor(error) {
  return error?.code === 'input' ? REVIEW_GATE_EXIT.input
    : error?.code === 'review' ? REVIEW_GATE_EXIT.review
      : error?.code === 'policy' ? REVIEW_GATE_EXIT.policy : REVIEW_GATE_EXIT.transport
}

export async function runReviewGateCli([packetPath, targetRepository] = [], {
  gate = runReviewGate,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    if (!packetPath || !targetRepository) {
      throw new ReviewTransportError('input', 'usage: review-gate.mjs <static-packet.json> <absolute-target-repository>')
    }
    let packet
    let handle
    try {
      handle = await open(packetPath, 'r')
      const raw = Buffer.alloc(ACP_REVIEW_LIMITS.rawPacketBytes + 1)
      const { bytesRead } = await handle.read(raw, 0, raw.length, 0)
      if (bytesRead > ACP_REVIEW_LIMITS.rawPacketBytes) throw new ReviewTransportError('input', 'raw review packet file exceeds limit')
      packet = JSON.parse(raw.subarray(0, bytesRead).toString('utf8'))
    } catch (e) {
      if (e instanceof ReviewTransportError) throw e
      throw new ReviewTransportError('input', `could not read packet: ${e.message}`, e)
    } finally {
      await handle?.close()
    }
    const result = await gate(packet, { targetRepository })
    stdout.write(JSON.stringify(result) + '\n')
    return REVIEW_GATE_EXIT.ok
  } catch (error) {
    if (error?.report) stdout.write(JSON.stringify(error.report) + '\n')
    stderr.write(`review-gate: ${error.message}\n`)
    return exitCodeFor(error)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReviewGateCli(process.argv.slice(2))
}
