// Review gate coordinator. It is intentionally transport-only: no repository
// cwd, mailbox, KMS, session persistence, or worker state is used here.
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ACP_REVIEW_LIMITS, prepareReviewPacket, runAcpReview, ReviewTransportError } from './acp-review-client.mjs'
// GitHub #43: this file used to need five separate collision-evidence
// imports (provenFamilyKeysCollide, provenLaunchSignature,
// launchDeclaredButUnreadable, routingDeclaration, alongside
// provenFamilyKey) kept in sync by hand across two files. `laneIdentity` is
// the one lookup that replaces the three that were review-gate-only
// (routingProvenDeclaration and launchUnreadable below now read straight off
// it); `provenFamilyKey` stays a direct import because the receipt still
// names a family by it, and `provenFamilyCollision` still does the actual
// collision decision on raw profiles.
import { REVIEW_PROFILES, buildProfileEnv, provenFamilyKey, provenFamilyCollision, laneIdentity, launchArgv } from './review-profiles.mjs'
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
// `input`/`config`/`policy` are the transport's own codes for a deterministic
// misconfiguration — a bad executable, an unacknowledged setting, an
// unavailable substitute route. None of those repair themselves on a second
// attempt, so they earn a distinct reason from `lane_failed`'s "re-run and
// compare the digest" advice below, which only fits a transient stage.
const DETERMINISTIC_LANE_STAGES = new Set(['input', 'config', 'policy'])
// Printable ASCII only — no newline, no carriage return, no ANSI/C0 control
// bytes. `validate` is a public injection seam (`runReviewGate({
// validateReview })`); a custom validator's `reason` is untrusted text, not
// the closed vocabulary the default validator returns, so this is what stops
// it from forging a report line or a terminal escape sequence once it rides
// in as a subject below, rather than the vocabulary being closed by
// construction.
const SAFE_SUBJECT = /^[\x20-\x7e]*$/
const boundedReason = value => typeof value === 'string' && value.length <= 200 && SAFE_SUBJECT.test(value) ? value : null
const hexDigest = value => /^[a-f0-9]{64}$/.test(value ?? '') ? value : null

// A lane failure is read by whoever has to unblock the gate, and until now it
// read like a note the gate wrote to itself: "runner/model identity mismatch"
// states what was NOTICED and never what to do about it, so every operator
// re-derived the same next step from the same eleven sentences.
//
// Reasons are a closed set with one fixed action each, and closed does two jobs.
// An operator can learn the whole list, which is what makes printing an action
// worth anything — an action attached to an open-ended sentence is a guess. And
// no bytes authored by a provider can reach an operator report through this
// field: the same rule that keeps raw stderr out of it, applied to the sentence
// rather than to the tail.
//
// `text` says what happened. `action` says what to do, and several of them say
// DO NOT RETRY, which is the fact a free-form sentence never carried — a
// mislabelled lane and a slow provider both used to read as "something failed,
// try again", and only one of those is worth the tokens.
// Freezing the outer object is not enough: each `{text, action}` value is its
// own object and Object.freeze is shallow, which let same-process code
// overwrite `.action` after import — the table read as closed but wasn't.
// Freezing every entry too is what makes "closed set with one fixed action
// each" true rather than merely written down.
function closedLaneFailureTable(table) {
  for (const entry of Object.values(table)) Object.freeze(entry)
  return Object.freeze(table)
}

export const LANE_FAILURES = closedLaneFailureTable({
  lane_failed: {
    text: 'the lane produced no review',
    action: 'Re-run this lane alone and compare stderrDigest against the provider log. Nothing about the panel changes until it answers.',
  },
  runner_missing: {
    text: 'the runner returned nothing at all',
    action: 'A wiring fault, not a provider one: check the command this profile declares in review-profiles.mjs before retrying.',
  },
  profile_identity: {
    text: 'the answer came back under a different profile than the lane was launched as',
    action: 'Do not retry — a retry cannot fix a mislabelled lane. Reconcile the profile in review-profiles.mjs with what the runner reports.',
  },
  provider_identity: {
    text: 'the answer came back from a different provider than the profile declares',
    action: 'Do not retry — a retry cannot fix a mislabelled lane. Reconcile the profile in review-profiles.mjs with what the runner reports.',
  },
  model_identity: {
    text: 'the answer came back from a different model than the profile declares',
    action: 'Do not retry — a retry cannot fix a mislabelled lane. Reconcile the profile in review-profiles.mjs with what the runner reports.',
  },
  display_model_identity: {
    text: 'the runner named a display model the profile does not declare',
    action: 'Do not retry — a retry cannot fix a mislabelled lane. Reconcile the profile in review-profiles.mjs with what the runner reports.',
  },
  mode_not_enforced: {
    text: 'the lane did not run the review mode its profile declares',
    action: 'Do not retry the same profile: reconcile reviewMode in review-profiles.mjs with the mode this model will actually hold.',
  },
  packet_hash: {
    text: 'the lane reviewed different bytes than the gate hashed',
    action: 'Discard this review outright and rebuild the packet. A review of unknown bytes is never accepted, however good it reads.',
  },
  provenance_invalid: {
    text: 'the result did not come from a review runner',
    action: 'Discard it and re-run the lane. If it repeats, something other than the runner is answering on this lane.',
  },
  config_unacknowledged: {
    text: 'the provider did not acknowledge a setting the gate requires',
    action: 'Do not retry the same profile: either this model cannot hold that setting, or the route in review-profiles.mjs is wrong.',
  },
  isolation_unacknowledged: {
    text: 'the lane did not confirm the review isolation contract',
    action: 'Do not retry until the sandbox for this profile is fixed. A review that read the target repository is not an external review.',
  },
  validator_threw: {
    text: 'the review validator threw on what this lane returned',
    action: 'A gate bug, not a lane one: capture the packet and report it. Retrying will produce the same throw.',
  },
  schema_invalid: {
    text: 'the model answered outside the review schema',
    action: 'Re-run this lane once. If it repeats, this model cannot hold the JSON review protocol and the route needs changing.',
  },
  lane_rejected: {
    text: 'the lane refused deterministically before it produced a review',
    action: 'Do not retry: fix the configuration or policy this profile declares in review-profiles.mjs first. This stage rejects on every attempt, digest or not.',
  },
})

// The sentence is assembled from the table, never from the lane. `subject` is
// the only variable part, and every caller passes either a key of our own frozen
// profile config or the validator's own closed vocabulary, so the whole string
// stays gate-authored.
const laneFailure = (reason, subject = null) =>
  `${LANE_FAILURES[reason]?.text ?? 'unclassified lane failure'}${subject ? ` (${subject})` : ''}`
const attemptRecord = attempt => Object.freeze({
  profile: attempt.profile.id,
  status: attempt.valid ? 'accepted' : 'failed',
  fallback: attempt.fallback,
  ...(attempt.replaces ? { replaces: attempt.replaces } : {}),
  ...(!attempt.valid ? {
    failureKind: attempt.failureKind,
    stage: attempt.stage,
    // The code is what a reader greps for and what a future gate may branch on;
    // the action is derived from it here so the two can never disagree.
    reason: attempt.reason ?? null,
    action: LANE_FAILURES[attempt.reason]?.action ?? null,
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
  // Declared family diversity (checked above) is necessary but not sufficient
  // (issue #38): two profiles can name different families while resolving to
  // the identical, unpinned adapter identity — see provenFamilyKey in
  // review-profiles.mjs. A planner that ignores this (the default one does
  // not; an injected one might) is caught here before any lane spawns.
  if (provenFamilyCollision(primary)) {
    throw new ReviewTransportError('policy', 'policy panel violates reviewer proven-identity diversity: two reviewer lanes resolve to the same unpinned adapter identity even though their declared families differ')
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
  // ONE computation of "what does this profile actually run", shared with the
  // collision check. This line used to spell it out again — and differently:
  // it never read `profile.args`, while `provenLaunchSignature` (the only
  // thing standing between a panel and `ok: true`) does. Two lanes declaring
  // one `command` and different `args` therefore had DIFFERENT signatures and
  // IDENTICAL launches: a panel of one process wearing three names, certified
  // distinct. Found by the v0.15.0 release review and reproduced end-to-end
  // through the exported `runReviewGate` seam before this changed. Inert
  // against the ten frozen profiles (none declares `args`) — live for any
  // caller that injects one, which the module's own comment invites.
  const argv = launchArgv(profile)
  // A lane runs the mode its profile declares. `plan` is the default and what
  // every lane used until glm-5.2, which cannot hold plan mode and the
  // JSON-only review protocol at once and answers prose instead — so that lane
  // declares `default` and the gate stops overwriting it. What made plan mode
  // safe is not the word: it is the zero-tool isolation the runner enforces
  // either way, and the acknowledgement check below now verifies the mode the
  // profile ASKED for rather than a constant, so a lane cannot drift silently.
  const configured = { ...profile }
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

// Returns a fault from the closed table above, or null. `subject` names the one
// thing worth naming — which setting went unacknowledged — and it is a key of
// our own profile config, so it can never carry provider bytes.
function runnerEvidenceFault(profile, value, expectedInputHash) {
  if (!value || typeof value !== 'object') return { reason: 'runner_missing' }
  if (value.profile !== profile.id) return { reason: 'profile_identity' }
  if (value.provider !== profile.provider) return { reason: 'provider_identity' }
  if (value.model !== profile.model) return { reason: 'model_identity' }
  if (value.displayModel !== (profile.displayModel ?? `${profile.provider}/${profile.model}`)) return { reason: 'display_model_identity' }
  if (value.mode !== profile.reviewMode) return { reason: 'mode_not_enforced' }
  if (value.inputHash !== expectedInputHash) return { reason: 'packet_hash' }
  if (typeof value.provenance !== 'string' || !value.provenance.startsWith('review-runner:')) return { reason: 'provenance_invalid' }
  for (const [configId, wanted] of Object.entries(profile.config ?? {})) {
    if (value.acknowledgements?.[configId]?.value !== wanted) return { reason: 'config_unacknowledged', subject: configId }
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
    return { reason: 'isolation_unacknowledged' }
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
    // `stage` already says where the transport stopped, so the sentence does not
    // repeat it — it says what the operator is left holding: no review. A
    // deterministic stage (config/policy/input) gets its own reason: collapsing
    // it into `lane_failed` told the operator to re-run and diff a digest that
    // may not even exist, when the actual fix is the profile, not another try.
    const reason = DETERMINISTIC_LANE_STAGES.has(stage) ? 'lane_rejected' : 'lane_failed'
    return { ...attempt, valid: false, failureKind, stage, ...stderrEvidence, reason, failure: laneFailure(reason) }
  }
  const value = attempt.result.value
  const fault = runnerEvidenceFault(attempt.profile, value, expectedInputHash)
  if (fault) {
    return {
      ...attempt, valid: false, failureKind: 'review', stage: 'acknowledge', ...stderrEvidence,
      reason: fault.reason, failure: laneFailure(fault.reason, fault.subject),
    }
  }
  let checked
  try { checked = await validate(value.review, { profile: attempt.profile.id, value }) } catch {
    return { ...attempt, valid: false, failureKind: 'review', stage: 'schema', ...stderrEvidence, reason: 'validator_threw', failure: laneFailure('validator_threw') }
  }
  if (checked === false || checked?.valid === false || checked?.ok === false) {
    // The validator's own reason is the useful half — WHICH schema rule broke.
    // For the DEFAULT validator that vocabulary is a closed set of literals
    // this repo writes (review-policy.mjs validateReviewOutput), never
    // provider text. But `validate` is a public injection seam — a caller can
    // pass any function via `runReviewGate({ validateReview })` — so a custom
    // validator's reason is untrusted text, not a closed vocabulary by itself.
    // It rides in as the subject rather than as the whole sentence, and
    // boundedReason above is what refuses it if it carries a control byte or
    // exceeds length; the vocabulary is closed by that filter, not by trust.
    return {
      ...attempt, valid: false, failureKind: 'review', stage: 'schema', ...stderrEvidence,
      reason: 'schema_invalid', failure: laneFailure('schema_invalid', boundedReason(checked?.reason)),
    }
  }
  // One lookup instead of three (#43): `commandProvenSignature`,
  // `routingProvenDeclaration` and `launchUnreadable` below all used to be
  // separate imported functions called on `attempt.profile`; they are now
  // three views of this one `laneIdentity` result.
  const identity = laneIdentity(attempt.profile)
  return {
    ...attempt,
    valid: true,
    item: Object.freeze({
      lane: attempt.profile.lane ?? attempt.profile.id,
      profile: attempt.profile.id,
      provider: value.provider,
      family: attempt.profile.family,
      // `declared` is always attempt.profile.family above. `provenKey` is
      // null unless this profile pins something an operator's env cannot
      // override (adapter package + a parent-verified endpoint) — see
      // provenFamilyKey in review-profiles.mjs. It is not a stronger claim
      // than that; in particular it never asserts an observed network
      // endpoint, because the ACP surface this runner speaks does not expose
      // one.
      familyProvenKey: provenFamilyKey(attempt.profile),
      // Carried alongside `familyProvenKey` so the final-panel recheck below
      // can catch BLOCKER 5 (round four, r4-codex): a lane whose key is null
      // (no `adapterPackage`) but whose actual launch command is
      // byte-identical to another accepted lane's. `familyProvenKey` alone
      // cannot see that — it is a declared-identity fact, and this is a
      // what-will-actually-exec fact, computed from the same profile object
      // but never from the caller-overridable claim.
      commandProvenSignature: identity.signature ?? null,
      routingProvenDeclaration: identity.routing ?? null,
      launchUnreadable: identity.unreadable === true,
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
      let replacement
      try {
        replacement = fallbackPlanner(plan, originalFailure.profile.id)
      } catch (error) {
        // A throwing planner is a bug in the injected dependency, not a lane
        // fault — but it must still leave the operator a report to read
        // instead of empty stdout and a bare stack line on stderr.
        throw fail('transport', `review fallback planner threw: ${error?.message ?? 'unknown error'}`)
      }
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
  // Keeps the whole attempt, not just `.item`: the final collision recheck
  // below needs the raw profile back (#43), not only the scalar fields
  // already copied onto the receipt.
  const acceptedByProfile = new Map(accepted.map(attempt => [attempt.profile.id, attempt]))
  const reviewOrder = activePlan?.reviewers ?? accepted.map(attempt => attempt.profile.id)
  const reviewAttempts = reviewOrder.map(id => acceptedByProfile.get(id)).filter(Boolean)
  const reviews = reviewAttempts.map(attempt => attempt.item)
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
  // Same defense as choosePanel's preflight, run again on the FINAL panel: a
  // fallback substitution runs after preflight and could reintroduce a
  // proven-identity collision that preflight never saw (issue #38). This used
  // to be its own copy of the preflight rule, reading three arrays pulled off
  // the already-computed receipt fields -- and a stale copy is how a panel of
  // two unresolved lanes once slipped through to ok:true (r3-codex). #43
  // deletes the second copy: this calls the exact SAME `provenFamilyCollision`
  // choosePanel used above, on the raw profiles the final substitution
  // actually seated, so there is one rule instead of two that can drift.
  // A lane that declared a launch nobody could read is still called out with
  // its own message before the general one, purely so an operator reads which
  // failure they are holding (r7-codex).
  if (reviews.some(item => item.launchUnreadable)) {
    throw fail('policy', 'a final review lane declared a launch that cannot be read')
  }
  if (provenFamilyCollision(reviewAttempts.map(attempt => attempt.profile))) {
    throw fail('policy', 'final review proven identities are not distinct')
  }
  if (new Set(reviews.map(item => item.provenance)).size !== 3) {
    throw fail('review', 'review provenance collision detected')
  }
  let synthesis
  try {
    synthesis = activePlan
      ? await synthesize(activePlan, Object.fromEntries(reviews.map(item => [item.profile, item.review])))
      : await synthesize(reviews)
  } catch (error) {
    // Same boundary as the fallback planner above: a throwing synthesizer must
    // not turn a structured report into a raw uncaught message with nothing
    // for the CLI to print to stdout.
    throw fail('policy', `review synthesizer threw: ${error?.message ?? 'unknown error'}`)
  }
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

// A ping fits in four minutes; a real completion packet does not. The client's
// 240s default timed out substantive reviews — a fifteen-file packet took the
// qwen lane past it — and a lane killed for being slow is indistinguishable in
// the report from a lane that is broken. The ceiling is still a ceiling: it is
// bounded, it is one number, and an operator with a slower provider raises it
// deliberately rather than discovering it.
export const LANE_TIMEOUT_DEFAULT_MS = 900_000
export function laneTimeoutMs(source = process.env) {
  const sec = Number(source.REVIEW_GATE_LANE_TIMEOUT_SEC)
  return Number.isSafeInteger(sec) && sec > 0 ? sec * 1000 : LANE_TIMEOUT_DEFAULT_MS
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
    const result = await gate(packet, { targetRepository, timeoutMs: laneTimeoutMs() })
    stdout.write(JSON.stringify(result) + '\n')
    return REVIEW_GATE_EXIT.ok
  } catch (error) {
    if (error?.report) stdout.write(JSON.stringify(error.report) + '\n')
    stderr.write(`review-gate: ${error.message}\n`)
    // stdout is the machine's copy and gets redirected; stderr is what a person
    // is actually looking at when the gate refuses. An action that only ever
    // reaches a JSON field nobody opens is not an action.
    for (const record of error?.report?.attempts ?? []) {
      if (record.status !== 'failed' || !record.action) continue
      stderr.write(`review-gate: ${record.profile} ${record.stage}/${record.reason} — ${record.action}\n`)
    }
    return exitCodeFor(error)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReviewGateCli(process.argv.slice(2))
}
