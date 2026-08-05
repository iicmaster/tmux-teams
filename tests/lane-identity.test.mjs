// GitHub #43: `laneIdentity` is the single lookup that replaced nine
// functions answering "would these two lanes run the same thing?"
// (provenFamilyKey, provenLaunchSignature, launchArgv, resolvedExecutable,
// routingDeclaration, routesApart, launchDeclaredButUnreadable,
// provenFamilyKeysCollide, provenFamilyCollision). This file pins the
// three-state contract directly, independent of `review-policy.test.mjs`
// and `review-gate.test.mjs` (the harness this item was forbidden from
// touching) so the shape itself has a dedicated, readable home.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REVIEW_PROFILES, laneIdentity, provenFamilyKey, provenFamilyCollision, provenLaunchSignature,
} from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'

test('a profile that names no launch at all is undeclared, never null', () => {
  for (const profile of [undefined, null, { id: 'x' }, { id: 'y', adapterPackage: 'pkg-y' }]) {
    const identity = laneIdentity(profile)
    assert.deepEqual(identity, { undeclared: true }, JSON.stringify(profile))
    assert.equal('unreadable' in identity, false)
    assert.equal('signature' in identity, false)
  }
})

test('a profile that names a launch nobody can read is unreadable, not undeclared', () => {
  // node coerces the non-string arg at spawn time -- the launch would still
  // run, it just cannot be described here, which is exactly why this state
  // has to refuse outright rather than take the "one unknown is fine" latitude
  // `undeclared` gets (r7-codex).
  const malformed = { id: 'lane-c', command: ['node', '/tmp/mock.mjs', 123], adapterPackage: 'pkg-c' }
  const identity = laneIdentity(malformed)
  assert.equal(identity.unreadable, true)
  assert.equal(typeof identity.reason, 'string')
  assert.ok(identity.reason.length > 0)
  assert.equal('signature' in identity, false)
  assert.equal('undeclared' in identity, false)

  // Same for the string-command/args shape the execution layer actually uses.
  const malformedPair = { id: 'lane-e', command: 'node', args: ['/tmp/mock.mjs', 123], adapterPackage: 'pkg-e' }
  assert.equal(laneIdentity(malformedPair).unreadable, true)
})

test('a readable launch is identified with signature, family, and routing', () => {
  // Every shipped profile must classify as identified -- none of them are
  // synthetic fixtures, so if one fails to read as a real launch here the
  // shipped table itself is broken, not just the test.
  for (const [id, profile] of Object.entries(REVIEW_PROFILES)) {
    const identity = laneIdentity(profile)
    assert.equal(identity.undeclared, undefined, `${id} must not be undeclared`)
    assert.equal(identity.unreadable, undefined, `${id} must not be unreadable`)
    assert.equal(typeof identity.signature, 'string', `${id} signature`)
    // `signature` is exactly what `provenLaunchSignature` already returned --
    // laneIdentity did not change what that computation IS, only where it lives.
    assert.equal(identity.signature, provenLaunchSignature(profile), `${id} signature must match provenLaunchSignature`)
    // `family` is exactly `provenFamilyKey` -- kept, not reinvented, and still
    // what the receipt names a reader recognises.
    assert.equal(identity.family, provenFamilyKey(profile), `${id} family must match provenFamilyKey`)
  }
  // Routed lanes carry a non-null routing fact; unrouted ones (bare claude,
  // codex, agy) carry null.
  assert.match(laneIdentity(REVIEW_PROFILES.qwen).routing, /token-plan\.ap-southeast-1\.maas\.aliyuncs\.com/)
  assert.match(laneIdentity(REVIEW_PROFILES.zai).routing, /api\.z\.ai/)
  assert.match(laneIdentity(REVIEW_PROFILES.kimi).routing, /api\.kimi\.com/)
  assert.equal(laneIdentity(REVIEW_PROFILES.claude).routing, null)
  assert.equal(laneIdentity(REVIEW_PROFILES.codex).routing, null)
  assert.equal(laneIdentity(REVIEW_PROFILES.agy).routing, null)
})

test('the returned identity is frozen in every branch', () => {
  assert.ok(Object.isFrozen(laneIdentity(undefined)))
  assert.ok(Object.isFrozen(laneIdentity({ id: 'x', command: ['node', 1] })))
  assert.ok(Object.isFrozen(laneIdentity(REVIEW_PROFILES.qwen)))
})

test('MUTATION PIN (r7-codex): an unreadable declaration must refuse outright, not fall back to the undeclared latitude', () => {
  // This is the assertion the task's mutation check targets: collapse the
  // `unreadable` branch in `laneIdentity` into `undeclared` (i.e. return
  // `{ undeclared: true }` when `launchArgv` fails instead of
  // `{ unreadable: true, reason }`) and this specific assertion goes RED,
  // because `single` would then read as the one-unknown-is-fine case instead
  // of the override-everything case.
  const single = { id: 'lane-c', family: 'gamma', command: ['node', '/tmp/mock.mjs', 123], adapterPackage: 'pkg-c' }
  assert.equal(
    provenFamilyCollision([single, REVIEW_PROFILES.qwen, REVIEW_PROFILES.agy]),
    true,
    'one lane whose declared launch cannot be read must refuse the whole panel',
  )
  // The control: a lane that declares NO launch at all (genuinely undeclared,
  // not merely malformed) is the single unknown AGY asked be allowed, and
  // must still pass beside two distinct, identified lanes. If the mutation
  // above also broke THIS assertion the two states would already be
  // indistinguishable and the mutation would be pointless to pin.
  const silent = { id: 'lane-d', family: 'delta', adapterPackage: 'pkg-d' }
  assert.equal(
    provenFamilyCollision([silent, REVIEW_PROFILES.qwen, REVIEW_PROFILES.agy]),
    false,
    'a lane that declares no launch at all keeps the single-unknown latitude',
  )
})

test('every shipped panel clears provenFamilyCollision (verify the real table, not a fixture)', () => {
  for (const panel of [
    [REVIEW_PROFILES.codex, REVIEW_PROFILES.agy, REVIEW_PROFILES.qwen],
    [REVIEW_PROFILES.codex, REVIEW_PROFILES.agy, REVIEW_PROFILES.kimi],
    [REVIEW_PROFILES.codex, REVIEW_PROFILES.agy, REVIEW_PROFILES.zai],
    [REVIEW_PROFILES.qwen, REVIEW_PROFILES.zai, REVIEW_PROFILES.agy],
    [REVIEW_PROFILES.kimi, REVIEW_PROFILES.claude, REVIEW_PROFILES.agy],
    [REVIEW_PROFILES.zai, REVIEW_PROFILES.codex, REVIEW_PROFILES.qwen],
  ]) {
    assert.equal(provenFamilyCollision(panel), false,
      `shipped panel refused: ${panel.map(p => p.id).join('+')}`)
  }
})

test('the collapse reduced the module surface: the internal helpers #43 folded away are no longer exported', async () => {
  const mod = await import('../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs')
  for (const dropped of ['routingDeclaration', 'launchDeclaredButUnreadable', 'provenFamilyKeysCollide']) {
    assert.equal(dropped in mod, false, `${dropped} should have been folded into laneIdentity/provenFamilyCollision`)
  }
  // What must still be there: the receipt-facing name, the collision decider,
  // the raw launch signature (compared directly in review-policy.test.mjs),
  // and the new collapsed lookup itself.
  for (const kept of ['provenFamilyKey', 'provenFamilyCollision', 'provenLaunchSignature', 'laneIdentity']) {
    assert.equal(typeof mod[kept], 'function', `${kept} must still be exported`)
  }
})
